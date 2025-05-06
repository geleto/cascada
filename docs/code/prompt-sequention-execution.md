**Sequential Execution using `!` marker in Cascada Templating Engine**

**1. Introduction & Goal:**

Cascada (a Nunjucks fork) provides automatic parallelization for async operations, but sometimes operations with side effects need guaranteed sequential execution. The `!` marker allows developers to enforce this order explicitly for specific method calls and context property access.

These are the modifications performed to the Cascada compiler (`compiler.js`) and runtime (`runtime.js`) to correctly implement the `!` feature according to the detailed plan below, ensuring it integrates seamlessly with the existing asynchronous execution and variable synchronization mechanisms.

**2. Background & Motivation:**

*   **Cascada's Parallelism:** Cascada aims to execute independent parts of a template concurrently, especially beneficial when dealing with asynchronous operations like API calls (`fetch`) or database queries.
*   **The Side Effect Problem:** Default parallelism can break logic when operations modify shared state and depend on order. For example, `account.deposit(100)` *must* complete before `account.withdraw(50)` can safely execute. Cascada's standard data-flow dependency tracking doesn't handle this state-based ordering.
*   **The `!` Solution:** The `!` marker provides explicit control.
    *   `object.path!.method()`: Sequences all calls marked with `!` on the specific `object.path`.
    *   `object.path.method!()`: Sequences only calls to `method` marked with `!` on that path. (Note: Requires parser support to set `.sequenced` flag on the `FunCall` node).
*   **Key Constraint:** This feature relies heavily on **static path analysis** during compilation. Therefore, the `!` marker will **only work on paths starting directly from a context variable** (passed into the template render function) **and consisting of static segments** (e.g., `contextVar.prop1.prop2!.method()`). It **cannot** be used with intermediate template variables (`{% set x = contextVar %}{{ x.prop1!.method() %}}`) or dynamic lookups (`data[index]!.action()`). The compiler must enforce this constraint. This limitation must be clearly documented.

**3. Core Implementation Strategy:**

We will leverage Cascada's existing complex asynchronous variable synchronization system (`writeCounters`, `reads`, `_promisifyParentVariables`, `frame.set`, `_countdownAndResolveAsyncWrites`) to manage sequence locks with minimal new infrastructure.

*   **Sequence Keys as Lock Variables:** Each unique static path marked for sequencing (e.g., `!contextVar!prop1`, `!contextVar!prop2!method`) will be treated as an implicit "lock variable".
*   **Compiler Analysis & Registration:**
    *   The compiler uses `_getSequenceKey` to identify valid static context keys derrived from paths marked with `!`.
    *   For `!` operations, it derives the *specific* lock key (`sequenceLockKey`) derrived from the path to that `!` using `_getSequenceKey`. It registers "write intent" (`_updateFrameWrites(frame, sequenceLockKey)`) for the specific key *during compilation*, signaling the runtime to create a lock promise via `_promisifyParentVariables`.
    *   For *any* operation (lookup or call) on a static context path, it derives potential parent lock keys and checks them against declared locks (`declaredVars`). It passes only the relevant, declared parent keys (`lockKeys`) to the runtime.
*   **Runtime Waiting (Implicit via Helpers):**
    *   New runtime helpers (`awaitSequenceLocks`, `sequencedMemberLookupAsync`) are introduced.
    *   These helpers use `awaitSequenceLocks` to check the relevant lock keys (passed by the compiler) via `lookup`. They `await` any active lock promises found before proceeding with the actual lookup or call.
*   **Runtime Signaling & Error Handling:**
    *   When a `!` call completes (successfully or with an error), the compiler emits code that calls `frame.set("sequenceLockKey", true, true)` within a `finally` block of an async IIFE.
    *   This `frame.set` triggers the existing variable resolution mechanism (`_countdownAndResolveAsyncWrites`), which resolves the lock promise, allowing the next operation in that sequence to proceed. The `finally` block guarantees lock release, preventing deadlocks.

**4. Provided Files:**

You will use the following files:

*   `README.md`: Describes the feature from a user perspective (including syntax and constraints).
*   `async-implamentation.md`: Explains Cascada's internal async/sync mechanisms and variable synchronization (crucial background reading).
*   `runtime.js`: Contains the `AsyncFrame` class and runtime helpers (you will modify/add to this).
*   `compiler.js`: Contains the `Compiler` class (you will modify/add to this).

**5. Detailed Implementation Steps:**

**Step 1: Implement Compiler Path and Sequence Key Analysis and Write Intent**

*   **Title:** Analyze Path for Static Origin, Sequence Marker, and Extract Path Array.
*   **Summary:**
    *   Implemented helper `_isDeclared(frame, variableName)` to check if a variable is defined within template scope (using `frame.declaredVars`).
    *   Implemented `_getSequenceKey(node, frame)` which:
        *   Traverses the AST (`LookupVal` chain) from `node`.
        *   Checks for the `.sequenced` flag (representing `!`).
        *   Validates that path segments up to and including the `!` are static (`Symbol` or string `Literal`).
        *   Validates that the path root is *not* a scope variable using `_isDeclared`.
        *   Handles errors for double `!` and dynamic paths combined with `!`.
        *   Returns the key for for that path, prepending `!` and using `!` to separate the path segments, e.g. !a!b!c or `null` if no `.sequenced` flag was found
     *   Register Sequence Synchronization Intent: Update compileFunCall to analyze the function call's path using _getSequenceKey. If it identifies that the call is part of a sequence (returning a valid sequenceLockKey), then register this key using _updateFrameWrites. This compile-time registration flags the sequence key for runtime write-counting, ensuring the runtime creates a lock promise for it. 
     This lock will only be released in Step 8 at runtime after the sequenced function call finishes execution - fram.set will be called for the key variable, which will release the lock (any unfinished writes keep a variable locked for further reading and modification).
*   **Verification:**
    *   Breakpoint Debugging: Verify `_getSequenceKey` returns correct path/key for various cases.

**Step 2: Correct Sequence Key Propagation and Runtime Frame Handling**

*   **Title:** Correct Sequence Key Propagation and Runtime Frame Handling.
*   **Goal:** Fix the bug where `writeCounters` for sequence keys (`!key`) are not correctly propagated during compilation, preventing runtime lock creation. Ensure related runtime frame methods handle these keys appropriately.
*   **Explanation:** The standard variable scoping logic incorrectly treats sequence keys as locally declared, stopping `writeCounts` propagation prematurely. This fix ensures propagation reaches the necessary frames by conceptually declaring `!` keys at the root and adjusts runtime methods (`resolve`, `_promisifyParentVariables`) for compatibility.
*   **Implementation:**
    1.  **Modify `compiler.js -> Compiler._updateFrameWrites`:**
        *   Add a check at the start of the scope-finding logic: If `name.startsWith('!')`, bypass the upward search and set the scope frame `vf = frame.rootFrame`.
    2.  **Modify `runtime.js -> AsyncFrame.resolve`:**
        *   Add a check at the start: If `name.startsWith('!')`, return `this.rootFrame`. Otherwise, continue standard logic.
    3.  **Implement `runtime.js -> AsyncFrame.lookupAndLocate`:**
        *   Create a new method `lookupAndLocate(name)` which traverses the frame hierarchy (starting from `this`) to find the specified `name`.
        *   It should correctly handle keys that exist but have an `undefined` value (fixing a bug in the original `lookup`).
        *   It returns both the `value` found and the specific `frame` object where it was located (or indicates if not found).
    4.  **Modify `runtime.js -> AsyncFrame.prototype._promisifyParentVariables`:**
        *   Utilize the new `lookupAndLocate` method to find the correct `scopeFrame` for the variable or sequence key (`!key`).
        *   Handle cases where `!key` is not initially found by establishing its state at the `rootFrame`.
        *   Use the `lookupAndLocate` result to promisify the variable.
*   **Verification:**
    *   Confirm the previously failing test case (`it.only('should enforce sequence based on object path...')`) now passes.
    *   Inspect compiled code for `{% do object!.method() %}` to verify `pushAsyncBlock` arguments now include the correct `writeCounters` (e.g., `{"!object": 1}`).
    *   Run other sequence-related tests to check for regressions.

**Step 3: Implement `isCallPath` Context and Static Path Extraction Helper**

*   **Title:** Add `isCallPath` Compilation Context and Path Extraction Helper.
*   **Goal:** Modify the compiler's core `compile` function and relevant compiler methods (`compileLookupVal`, `compileFunCall`) to pass down a `isCallPath` argument. It is passed as `true` from compileFunCall for it's node.name. Implement the `_extractStaticPathKey` helper to retrieve the static path. Add calls to this helper within `compileLookupVal` and `compileFunCall`.
*   **Explanation:** This step establishes the infrastructure needed for later sequence handling. The `isCallPath` argument provides context about the overall expression being compiled. The `_extractStaticPathKey` helper gathers structural path information, which will be used in subsequent steps for both validation and determining necessary waits. This step focuses only on adding the argument passing mechanism and the basic path extraction, without implementing sequence logic itself.
*   **Implementation:**
    *   Modify `Compiler.prototype.compile` signature to accept `isCallPath = false` and pass it down.
    *   Modify `compileLookupVal` and `compileSymbol` to accept `isCallPath`.
    *   Update recursive `this.compile` calls within `compileLookupVal` (for `node.target`) to correctly determine and pass the `isCallPath` value down the chain.
    *   Implement `_extractStaticPathKey` helper function to traverse upwards from a `LookupVal` or `Symbol` and return the static path, or `null` if the path is dynamic/invalid.
    *   Add calls to `this._extractStaticPathKey` at the beginning of `compileLookupVal` (using `node`) and `compileFunCall` (using `node.name`) to calculate the static path.
*   **Verification:**
    *   Use `console.log` or debugger to verify `isCallPath` is passed correctly during recursive compilation.
    *   Verify `_extractStaticPathKey` returns correct path or `null` for various test cases (static paths, dynamic paths) when called from `compileLookupVal` and `compileFunCall`.

**Step 4: Compiler Sequence Analysis - Identify Potential Keys**

*   **Title:** Identify Static Path Keys for Sequencing.
*   **Goal:** Within the compiler, determine the specific static path key (e.g., `!a!b!c`) associated with any symbol or property lookup being compiled.
*   **Explanation:** This preparatory step uses the `_extractStaticPathKey` helper to derive the key string representing the full static path being accessed. This key is essential for later checks and runtime operations related to sequencing, but this step *doesn't* yet decide if sequencing applies.
*   **Implementation:**
    *   Utilize `_extractStaticPathKey` within `compileSymbol` and `compileLookupVal` to extract the relevant `nodeStaticPathKey`.

**Step 5: Implement Runtime Waiting Logic (`awaitSequenceLock`)**

*   **Title:** Create Runtime Sequence Lock Waiting Mechanism.
*   **Goal:** Implement the core runtime function (`awaitSequenceLock`) responsible for pausing execution if a sequence lock (represented by a promise) is active for a given key.
*   **Explanation:** This function centralizes the waiting logic. It uses the standard `frame.lookup` to check the state of the lock key. If it finds a promise, it handles waiting for the entire promise chain to resolve before allowing execution to continue. It avoids `async` overhead when no waiting is needed.
*   **Implementation:**
    *   Implement `runtime.awaitSequenceLock` to check the lock key state via `frame.lookup` and manage promise chain resolution if a lock promise is found.

**Step 6: Implement Sequenced Lookup with Lock Key Declaration Check (Runtime & Compiler)**

*   **Title:** Conditionally Apply Sequence Locks to Lookups.
*   **Goal:** Ensure that symbol and property lookups only wait for sequence locks if a lock for their specific static path key has actually been declared (via a `!` marker elsewhere).
*   **Explanation:** This involves both compiler and runtime changes. The compiler adds a check (`_isDeclared`) to see if the `nodeStaticPathKey` identified in Step 4 corresponds to a declared lock. If so, it emits code calling new runtime helpers (`sequencedContextLookup`, `sequencedMemberLookupAsync`). These runtime helpers use `awaitSequenceLock` (from Step 5) before performing the actual lookup. If no lock was declared for the path, the compiler emits standard lookup code.
*   **Implementation:**
    *   Implement runtime helpers `sequencedContextLookup` and `sequencedMemberLookupAsync` which internally call `awaitSequenceLock` before performing standard lookup logic.
    *  Modify `compileSymbol` and `compileLookupVal`: check if the `nodeStaticPathKey` is declared using `_isDeclared`. If it is, register read intent using _updateFrameReads(frame, nodeStaticPathKey) and conditionally emit calls to the new sequenced...Lookup helpers instead of the standard lookup functions.

**Step 7: Implement Lock Release/Signaling for `!` Calls**

*   **Title:** Ensure Lock Release via Runtime Helper
*   **Goal:** Guarantee sequence locks are released after a sequenced function call attempt, preventing deadlocks.
*   **Explanation:** The dedicated runtime helper `runtime.sequencedCallWrap` handles sequenced function calls. This helper executes the call using `runtime.callWrap` internally and ensures the corresponding sequence lock is reliably released afterwards by signaling completion through the frame's variable system via `frame.set`, even if the call fails. The compiler (`compileFunCall`) identifies sequenced calls using `_getSequenceKey` and directs them to use this specialized helper.
*   **Implementation:**
    *   Implement the `runtime.sequencedCallWrap` helper function, which internally calls `runtime.callWrap` and then reliably signals lock completion using `frame.set(sequenceLockKey, true, true)`.
    *   Modify the compiler's `compileFunCall` logic to detect sequenced calls using `_getSequenceKey`.
    *   Generate code within `compileFunCall` to invoke `runtime.sequencedCallWrap` for sequenced calls (passing the `sequenceLockKey`), and `runtime.callWrap` otherwise.

**Step 8: Implement Expression-Level Key Analysis and Count Aggregation**

*   **Title:** Analyze Expression Subtrees for Sequence Keys and Aggregate Usage Counts.
*   **Goal:** Before compiling an expression(using compileExpression), recursively analyze its entire structure to identify all potential sequence path keys (from Symbol and LookupVal nodes) and sequence lock keys (from FunCall nodes). Decorate these individual nodes with their identified key. Aggregate the total count of each unique key found within the entire expression's subtree and store these counts on the expression's root node.
*   **Why this step is necessary:** 
    *   A single expression can contain multiple operations that might contend for the same sequence lock (e.g., data.item!.update() + data.item!.anotherUpdate()).
    *   To ensure correct sequential execution, we must identify these contentions. This step gathers the foundational data: which sequence keys are used by which parts of the expression, and how many times each key appears within the overall expression.
    *   This information is crucial for a subsequent step (Step 9) which will decide exactly which specific parts of the expression (individual lookups or function calls) need to be wrapped in their own async IIFE to manage their sequence lock, preventing race conditions with other parts of the same expression. Without this analysis, the compiler cannot make informed decisions about where to insert these protective async blocks.
*   **Explanation:**
    *   A new recursive compiler method, `_processExpressionSequenceKeysAndPaths`, analyzes an expression before its compilation.
    *   **Key Identification:** It inspects `Symbol`, `LookupVal`, and `FunCall` nodes within the expression. Using existing helpers (`_extractStaticPathKey`, `_getSequenceKey`), it determines if a node represents a valid sequence path or a call to a sequenced method. Validity includes ensuring paths are static and originate from context variables (not template-scoped ones).
    *   **Node Decoration:** If a valid key is found, it's stored as a property (e.g., `node.sequencePathKey` or `node.sequenceLockKey`) on that specific AST node.
    *   **Usage Counting & Aggregation:** The method counts every occurrence of each unique key throughout the entire expression. These counts are aggregated upwards, so that any expression node will store the total counts of keys found within its own subtree (as `node.sequencePathCounts` and `node.sequenceLockKeyCounts`), if any keys are present.
*   **Verification:**
    *   Debug to confirm that relevant AST nodes within an expression are decorated with their `sequencePathKey` or `sequenceLockKey`.
    *   Verify that expression nodes correctly store `sequencePathCounts` and `sequenceLockKeyCounts` reflecting total key usage in their subtrees.
    *   Ensure paths from template-scoped variables are correctly ignored.