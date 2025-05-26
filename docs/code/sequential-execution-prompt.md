
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
    *   A dedicated compiler pass identifies `FunCall` nodes with `!` in their path and declares their corresponding `sequenceLockKey` at the root level for sequence management.
    *   For operations involving a `!` (like sequenced function calls), the compiler registers a "write intent" for the specific key, signaling the runtime to create and manage a lock promise for it.
*   **Runtime Waiting (Implicit via Helpers):**
    *   New runtime helpers are introduced to manage sequenced operations.
    *   These helpers check for active lock promises associated with the relevant sequence keys and pause execution (`await`) until the lock is released before proceeding.
*   **Runtime Signaling & Error Handling:**
    *   When a sequenced call completes (successfully or with an error), the runtime signals the release of its lock by updating the lock variable's state.
    *   This triggers the existing variable resolution mechanism, resolving the lock promise and allowing the next operation in that sequence to proceed. This release is guaranteed even in case of errors to prevent deadlocks.

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
    *   Implemented a compiler helper to determine if a variable is defined within the template's scope.
    *   Implemented a core compiler helper (`_getSequenceKey`) to:
        *   Traverse the abstract syntax tree (AST) for property lookups.
        *   Identify the `!` sequence marker.
        *   Validate that the path segments leading up to and including the `!` are static (not dynamic expressions).
        *   Ensure the path originates from a context variable, not a template-defined variable.
        *   Handle and report errors for invalid `!` usage (e.g., multiple `!` in one path, `!` on dynamic segments).
        *   Return a unique key representing the sequenced path (e.g., `!a!b!c`) or `null` if no valid sequence is found.
     *   Register Sequence Synchronization Intent: The compiler, when processing function calls, uses the `_getSequenceKey` helper. If a call is identified as part of a sequence (a valid `sequenceLockKey` is returned), the compiler registers this key for write-counting. This compile-time action flags the `sequenceLockKey`, ensuring the runtime system creates and manages a lock promise for it. This lock is released only after the sequenced function call completes.

**Step 2: Correct Sequence Key Propagation and Runtime Frame Handling**

*   **Title:** Correct Sequence Key Propagation and Runtime Frame Handling.
*   **Goal:** Fix the bug where `writeCounters` for sequence keys (`!key`) are not correctly propagated during compilation, preventing runtime lock creation. Ensure related runtime frame methods handle these keys appropriately.
*   **Explanation:** The standard variable scoping logic incorrectly treats sequence keys as locally declared, stopping `writeCounts` propagation prematurely. This fix ensures propagation reaches the necessary frames by conceptually declaring `!` keys at the root and adjusts runtime methods (`resolve`, `_promisifyParentVariables`) for compatibility.
*   **Implementation:**
    1.  **Compiler `_updateFrameWrites`** For sequence keys (names starting with `!`), ensure write counts are associated with the root-level sequence management frame, bypassing standard upward scope search.
    2.  **Runtime `AsyncFrame.resolve`** For sequence keys, ensure resolution always points to the root-level sequence management frame.
    3.  **Runtime `AsyncFrame.lookupAndLocate` Implementation:** Created a new method to reliably find a variable's value and its defining frame, correctly handling cases of `undefined` values.
    4.  **Runtime `AsyncFrame._promisifyParentVariables`** Adapted this method to use `lookupAndLocate` for correctly finding and creating promise-based locks for sequence keys, associating them with the root sequence management frame if they don't exist.

**Step 3: Implement `pathFlags` Context and Static Path Extraction Helper**

*   **Title:** Add `pathFlags` Compilation Context and Path Extraction Helper.
*   **Goal:** Enhance the compiler's core `compile` function and related methods to pass down a `pathFlags` argument (e.g., `PathFlags.CALL`). Implement the `_extractStaticPathKey` helper to retrieve the static path key.
*   **Explanation:** This step establishes infrastructure for sequence handling. The `pathFlags` argument provides context about the nature of the path being compiled (e.g., if it's part of a function call). The `_extractStaticPathKey` helper gathers structural path information (the static key like `!a!b`).
*   **Implementation:**
    *   The compiler's main `compile` function was modified to accept and propagate a `pathFlags` argument.
    *   Compiler methods for lookups and function calls were updated to accept and utilize these `pathFlags`.
    *   A helper function, `_extractStaticPathKey`, was implemented to traverse the AST upwards from a lookup or symbol node and construct its static path key.
    *   This helper is now called during the compilation of lookups, symbols, and function call names.

**Step 4: Compiler Sequence Lock Declaration - `_declareSequentialLocks` Pass**

*   **Title:** Declare All Sequence Lock Keys in a Dedicated Pass.
*   **Goal:** Before main compilation, traverse the AST to identify all `FunCall` nodes whose paths (derived via `_getSequenceKey`) contain a `!` marker. For each such valid sequenced call, declare its corresponding `sequenceLockKey` at the root level of sequence management.
*   **Explanation:** This new, explicit pass centralizes the *declaration* of all sequence lock keys. This ensures that later compilation steps know which static paths are subject to sequential locking.
*   **Implementation:**
    *   A new compiler method, `_declareSequentialLocks`, is called once before the main compilation of the root node.
    *   This method recursively traverses the AST. When it encounters a function call, it uses `_getSequenceKey` on the function's name.
    *   If a valid sequence key is returned, that key is registered (added to `declaredVars`) in the dedicated sequence lock frame.

**Step 5: Implement Runtime Waiting Logic (`awaitSequenceLock`)**

*   **Title:** Create Runtime Sequence Lock Waiting Mechanism.
*   **Goal:** Implement the core runtime function (`awaitSequenceLock`) responsible for pausing execution if a sequence lock (represented by a promise) is active for a given key.
*   **Explanation:** This function centralizes the waiting logic. It uses the standard `frame.lookup` to check the state of the lock key. If it finds a promise, it handles waiting for the entire promise chain to resolve before allowing execution to continue.
*   **Implementation:**
    *   Implemented `runtime.awaitSequenceLock` to check the lock key state via `frame.lookup` and manage promise chain resolution if a lock promise is found.

**Step 6: Implement Sequenced Lookup with Lock Key Declaration Check (Runtime & Compiler)**

*   **Title:** Conditionally Apply Sequence Locks to Lookups.
*   **Goal:** Ensure that symbol and property lookups only wait for sequence locks if a lock for their specific static path key has actually been declared (via a `!` marker elsewhere and registered in Step 4).
*   **Explanation:** The compiler determines the static path key for any lookup. It then checks if this key corresponds to a declared sequence lock. If so, it generates code to use new runtime helpers (`sequencedContextLookup`, `sequencedMemberLookupAsync`) and registers a "write intent" for that key. These runtime helpers first wait for the lock (using `awaitSequenceLock`) and then, after performing the lookup, signal completion for that key to release it for the next operation in the sequence.
*   **Implementation:**
    *   New runtime helpers (`sequencedContextLookup`, `sequencedMemberLookupAsync`) were created. These internally use `awaitSequenceLock`, then perform the lookup, and finally release the lock by updating its state via `frame.set`.
    *   The compiler (for `Symbol` and `LookupVal`) now:
        *   Extracts the `nodeStaticPathKey`.
        *   Checks if this key is a declared sequence lock (in `frame.sequenceLockFrame.declaredVars`).
        *   If it is, it registers a "write intent" for this key and generates code to call the new sequenced lookup helpers.
        *   Otherwise, it generates standard lookup code.

**Step 7: Implement Lock Release/Signaling for `!` Calls**

*   **Title:** Ensure Lock Release via Runtime Helper for Sequenced Calls.
*   **Goal:** Guarantee sequence locks are released after a sequenced function call attempt, preventing deadlocks.
*   **Explanation:** A dedicated runtime helper, `runtime.sequencedCallWrap`, is used for sequenced function calls. This helper performs the actual call and then, in a `finally` block, ensures the corresponding sequence lock is released by signaling its completion. The compiler identifies sequenced calls (based on their path having a `!` and thus a `sequenceLockKey` being declared in Step 4) and directs them to use this specialized helper. It also registers a "write intent" for the call's `sequenceLockKey`.
*   **Implementation:**
    *   The `runtime.sequencedCallWrap` helper was implemented to execute the function call and then reliably signal lock completion using `frame.set` within a `finally` clause.
    *   The compiler's function call logic (`compileFunCall`) now:
        *   Uses `_getSequenceKey` on the function's name to determine its `sequenceLockKey`.
        *   If a `sequenceLockKey` exists (meaning it was declared as a lock), it registers "write intent" for this key and generates code to use `runtime.sequencedCallWrap`.
        *   Otherwise, it uses the standard `runtime.callWrap`.

**Step 8: Analyze Expression Subtrees for Sequence Operations and Contention**

*   **Title:** Analyze Expression Subtrees for Sequence Operations and Contention.
*   **Goal:** Before compiling an expression, recursively analyze its structure to identify all sequence path keys (from `Symbol` and `LookupVal` nodes) and sequence lock keys (from `FunCall` nodes). Decorate each AST node with a `sequenceOperations` map detailing the type of sequence operations (`PATH`, `LOCK`) it and its children are involved in, marking keys as `CONTENDED` if conflicting operations are found within its subtree.

*   **Why this step is necessary:** 
    *   A single expression can contain multiple operations that might contend for the same sequence lock (e.g., data.item!.update() + data.item!.anotherUpdate()).
    *   To ensure correct sequential execution, we must identify these contentions. This step gathers the foundational data: which sequence keys are used by which parts of the expression, and how many times each key appears within the overall expression.
    *   This information is crucial for a subsequent step (Step 9) which will decide exactly which specific parts of the expression (individual lookups or function calls) need to be wrapped in their own async IIFE to manage their sequence lock, preventing race conditions with other parts of the same expression. Without this analysis, the compiler cannot make informed decisions about where to insert these protective async blocks.
*   **Explanation:**
    *   A new recursive compiler method, `_assignAsyncBlockWrappers`, analyzes an expression before its compilation.
    *   **Initial Decoration:** `FunCall` nodes with a `!` path are noted as having a `sequenceLockKey`. `Symbol`/`LookupVal` nodes on a declared `!` lock path are noted as having a `sequencePathKey`.
    *   **Recursive Analysis:**
        *   Each AST node gets a `node.sequenceOperations` map.
        *   Initially, this map is populated if the node itself has a `sequencePathKey` (type `PATH`) or `sequenceLockKey` (type `LOCK`).
        *   The method then recursively calls itself for all children.
        *   Children's `sequenceOperations` are merged into the current node's map. If a key is used in conflicting ways (e.g., a `LOCK` and a `PATH` for the same key, or multiple `LOCK`s), that key is marked as `CONTENDED` in the current node's `sequenceOperations` map.
    *   This step builds a detailed understanding of sequence key usage and potential conflicts throughout the expression.

**Step 9: Resolve Sequence Contention and Mark Nodes for Async Wrapping**

*   **Title:** Resolve Sequence Contention and Mark Nodes for Async Wrapping.
*   **Goal:** Using the `sequenceOperations` map (with `CONTENDED` markers) from Step 8, determine which specific parts of an expression must be wrapped in their own asynchronous IIFE to manage sequence locks. This is done by setting `wrapInAsyncBlock = true` on the appropriate AST nodes.
*   **Explanation:**
    *   This logic is also handled within the `_assignAsyncBlockWrappers` method, after information has been aggregated from children.
    *   **Contention Resolution:** If a node's `sequenceOperations` map contains a key marked `CONTENDED`, it means different parts of its subtree are conflicting over that sequence key.
    *   **Targeted Wrapping (`_asyncWrapKey`):** For each such contended key, a helper function `_asyncWrapKey` is called for each child involved with that key. `_asyncWrapKey` recursively descends into the child's branch. It sets `wrapInAsyncBlock = true` on the highest-level node within that branch where the key is *no longer* `CONTENDED` (i.e., the specific node representing one side of the original conflict). The `node.sequenceOperations` map is then typically cleared for the node where `_asyncWrapKey` was called from, as its purpose for that level is fulfilled.
    *   **Optimization Pass:** After `_assignAsyncBlockWrappers` completes, an additional optimization pass, `_pushAsyncWrapDownTree`, is performed. This pass may further refine the placement of `wrapInAsyncBlock = true` flags by attempting to move them closer to the actual sequenced operation if a wrapper at a higher level is not strictly necessary. This optimization is detailed in separate documentation.
    *   The `compileExpression` method in the compiler will call `_assignAsyncBlockWrappers` and then `_pushAsyncWrapDownTree` before proceeding to generate code. During code generation, if a node has `wrapInAsyncBlock = true`, its compilation will be enclosed in an async IIFE (`_emitAsyncBlockValue`).