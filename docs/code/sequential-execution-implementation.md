
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

**3. Core Implementation:**

The Implementation leverages Cascada's existing complex asynchronous variable synchronization system (`writeCounters`, `reads`, `_promisifyParentVariables`, `frame.set`, `_countdownAndResolveAsyncWrites`) to manage sequence locks with minimal new infrastructure.

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

**4. Detailed Implementation Steps:**

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
        *   Checks if this key is a declared sequence lock (in the root frame declaredVars`).
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

**Step 8: Expression-Level Sequence Analysis and Async Block Wrapping**
The detailed mechanics of this expression-level analysis, contention marking, and wrapper optimization are intricate and are further documented in `sequentail-expressions-handling.md`.

*   **Title:** Analyze Expressions for Sequence Conflicts and Assign Async Wrappers.
*   **Goal:** Before compiling an expression, recursively analyze its entire AST. Identify all sequence path keys (from `Symbol`/`LookupVal` nodes) and sequence lock keys (from `FunCall` nodes). Determine where conflicts (contention) over these keys occur within the expression. Based on this contention analysis, mark specific AST nodes with `wrapInAsyncBlock = true` to signal that their compilation should be enclosed in an async IIFE. This ensures that operations contending for the same sequence lock within an expression are executed sequentially with respect to that lock.
*   **Explanation:**
    *   This complex analysis involves decorating AST nodes with information about the sequence keys they interact with (`sequenceLockKey`, `sequencePathKey`).
    *   A `sequenceOperations` map is built on each expression node, aggregating key usage from its children and identifying `CONTENDED` keys (where multiple parts of the subtree try to operate on the same lock concurrently).
    *   If a key is `CONTENDED` at a certain node, the analysis then descends into the child branches involved with that key. It marks the highest-level node in each conflicting branch (where the key is no longer contended) with `wrapInAsyncBlock = true`.
    *   An optimization pass may then refine the placement of these `wrapInAsyncBlock` flags to be as close as possible to the actual sequenced operation.
    *   During final code generation, nodes marked `wrapInAsyncBlock = true` will have their compiled output wrapped in an async IIFE (`_emitAsyncBlockValue`), which manages the lock for that specific part of the expression.