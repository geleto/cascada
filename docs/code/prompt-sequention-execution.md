**Implement Sequential Execution Feature (`!`) in Cascada Templating Engine**

**1. Introduction & Goal:**

This task involves implementing a new feature in the Cascada templating engine: **sequential execution control using the `!` marker**. Cascada (a Nunjucks fork) provides automatic parallelization for async operations, but sometimes operations with side effects need guaranteed sequential execution. The `!` marker allows developers to enforce this order explicitly for specific method calls or property lookups on objects.

Your goal is to modify the Cascada compiler (`compiler.js`) and runtime (`runtime.js`) to correctly implement the `!` feature according to the detailed plan below, ensuring it integrates seamlessly with the existing asynchronous execution and variable synchronization mechanisms.

**2. Background & Motivation:**

*   **Cascada's Parallelism:** Cascada aims to execute independent parts of a template concurrently, especially beneficial when dealing with asynchronous operations like API calls (`fetch`) or database queries.
*   **The Side Effect Problem:** Default parallelism can break logic when operations modify shared state and depend on order. For example, `account.deposit(100)` *must* complete before `account.withdraw(50)` can safely execute. Cascada's standard data-flow dependency tracking doesn't handle this state-based ordering.
*   **The `!` Solution:** The `!` marker provides explicit control.
    *   `object.path!.method()`: Sequences all calls marked with `!` on the specific `object.path`.
    *   `object.path.method!()`: Sequences only calls to `method` marked with `!` on that path. (Note: Requires parser/transformer support to set `.sequenced` flag on the `FunCall` node).
*   **Key Constraint:** This feature relies heavily on **static path analysis** during compilation. Therefore, the `!` marker will **only work reliably on paths starting directly from a context variable** (passed into the template render function) **and consisting of static segments** (e.g., `contextVar.prop1.prop2!.method()`). It **cannot** be reliably used with intermediate template variables (`{% set x = contextVar %}{{ x.prop1!.method() %}}`) or dynamic lookups (`data[index]!.action()`). The compiler must enforce this constraint. This limitation must be clearly documented.

**3. Core Implementation Strategy:**

We will leverage Cascada's existing complex asynchronous variable synchronization system (`writeCounters`, `reads`, `_promisifyParentVariables`, `frame.set`, `_countdownAndResolveAsyncWrites`) to manage sequence locks with minimal new infrastructure.

*   **Sequence Keys as Lock Variables:** Each unique static path marked for sequencing (e.g., `!contextVar!prop1`, `!contextVar!prop2!method`) will be treated as an implicit "lock variable".
*   **Global Coordination (`rootFrame`):** All sequence lock variables are managed globally within the template execution's top-level frame (`rootFrame`). Runtime functions (`lookup`, `resolve`, `set`) will be modified to target `rootFrame` for these keys.
*   **Compiler Analysis & Registration:**
    *   The compiler uses `_getSequencedPath` to identify valid static context paths marked with `!`.
    *   For `!` operations, it derives the *specific* lock key (`sequenceLockKey`) and *potential* parent keys (`potentialParentLockKeys`) from the path returned by `_getSequencedPath`. It registers "write intent" (`_updateFrameWrites(frame.rootFrame, sequenceLockKey)`) for the specific key *during compilation*, signaling the runtime to create a lock promise via `_promisifyParentVariables`.
    *   For *any* operation (lookup or call) on a static context path, it derives potential parent lock keys and checks them against declared locks (`rootFrame.declaredVars`). It passes only the relevant, declared parent keys (`lockKeys`) to the runtime.
*   **Runtime Waiting (Implicit via Helpers):**
    *   New runtime helpers (`awaitSequenceLocks`, `sequencedMemberLookup`, `sequencedCallWrap`) are introduced.
    *   These helpers use `awaitSequenceLocks` to check the relevant lock keys (passed by the compiler) via the modified `lookup`. They `await` any active lock promises found before proceeding with the actual lookup or call.
*   **Runtime Signaling & Error Handling:**
    *   When a `!` call completes (successfully or with an error), the compiler emits code that calls `frame.set("sequenceLockKey", true, true)` within a `finally` block of an async IIFE.
    *   This `frame.set` (modified to target `rootFrame`) triggers the existing variable resolution mechanism (`_countdownAndResolveAsyncWrites`), which resolves the lock promise in `rootFrame`, allowing the next operation in that sequence to proceed. The `finally` block guarantees lock release, preventing deadlocks.

**4. Provided Files:**

You will use the following files:

*   `README.md`: Describes the feature from a user perspective (including syntax and constraints).
*   `async-implamentation.md`: Explains Cascada's internal async/sync mechanisms and variable synchronization (crucial background reading).
*   `runtime.js`: Contains the `AsyncFrame` class and runtime helpers (you will modify/add to this).
*   `compiler.js`: Contains the `Compiler` class (you will modify/add to this).

**5. Detailed Implementation Steps:**

Please implement these steps sequentially, verifying each one thoroughly.

**Step 1: Implement Compiler Path and Sequence Key Analysis - Implemented**

*   **Title:** Analyze Path for Static Origin, Sequence Marker, and Extract Path Array.
*   **Summary:**
    *   Implemented helper `_isScopeVariable(frame, variableName)` to check if a variable is defined within template scope (using `frame.declaredVars`).
    *   Implemented `_getSequencedPath(node, frame)` which:
        *   Traverses the AST (`LookupVal` chain) from `node`.
        *   Checks for the `.sequenced` flag (representing `!`).
        *   Validates that path segments up to and including the `!` are static (`Symbol` or string `Literal`).
        *   Validates that the path root is *not* a scope variable using `_isScopeVariable`.
        *   Handles errors for double `!` and dynamic paths combined with `!`.
        *   Returns the array of static path segments (e.g., `['a', 'b', 'c']`) if a valid sequence marker `!` is found on a path originating from context, otherwise returns `null`.
*   **Verification:**
    *   Breakpoint Debugging: Verify `_getSequencedPath` returns correct path arrays for various cases.

**Step 2: Implement `fullPathNode` Context and Static Path Extraction Helper**

*   **Title:** Add `fullPathNode` Compilation Context and Path Extraction Helper.
*   **Goal:** Modify the compiler's core `compile` function and relevant compiler methods (`compileLookupVal`, `compileFunCall`, `compileSymbol`) to pass down a `fullPathNode` argument. Implement the `_extractStaticPathKey` helper to retrieve the static path. Add calls to this helper within `compileLookupVal` and `compileFunCall`.
*   **Explanation:** This step establishes the infrastructure needed for later sequence handling. The `fullPathNode` argument provides context about the overall expression being compiled. The `_extractStaticPathKey` helper gathers structural path information, which will be used in subsequent steps for both validation and determining necessary waits. This step focuses only on adding the argument passing mechanism and the basic path extraction, without implementing sequence logic itself.
*   **Implementation:**
    *   Modify `Compiler.prototype.compile` signature to accept `fullPathNode = null` and pass it down.
    *   Modify `compileLookupVal`, `compileFunCall`, and `compileSymbol` to accept `fullPathNode`.
    *   Update recursive `this.compile` calls within `compileLookupVal` (for `node.target`) and `compileFunCall` (for `node.name`) to correctly determine and pass the `fullPathNode` value down the chain.
    *   Implement `_extractStaticPathKey` helper function to traverse upwards from a `LookupVal` or `Symbol` and return the static path, or `null` if the path is dynamic/invalid.
    *   Add calls to `this._extractStaticPathKey` at the beginning of `compileLookupVal` (using `node`) and `compileFunCall` (using `node.name`) to calculate the static path.
*   **Verification:**
    *   Use `console.log` or debugger to verify `fullPathNode` is passed correctly during recursive compilation.
    *   Verify `_extractStaticPathKey` returns correct path or `null` for various test cases (static paths, dynamic paths) when called from `compileLookupVal` and `compileFunCall`.

**Step 3: Compiler Sequence Analysis and Key Preparation**

*   **Title:** Analyze Paths for Sequential Waiting and Prepare Keys.
*   **Goal:** Perform compile-time analysis within `compiler.js` (`compileSymbol`, `compileLookupVal`) to identify if the current static path access requires waiting for a specific sequence lock, and prepare the relevant lock key for code generation.
*   **Implementation:**
    1. **Identify Static Path and Derive Level-Specific Lock Key:**
        *   **Action:** Inside `compileSymbol` and `compileLookupVal`:
            *   Call `_extractStaticPathKey(node, frame)` to get the `staticPathKey` (this also implicitly checks for static context origin).
            *   If `staticPathKey` is null, no sequence waiting applies to this node; skip the next sub-step.
        *   **Location:** `compiler.js` (`compileSymbol`, `compileLookupVal`).

    2. **Check if Specific Lock is Declared:**
        *   **Action:** If `staticPathKey` was derived in the previous sub-step:
            *   Check if `staticPathKey` exists in `frame.rootFrame.declaredVars` and if so - store the `staticPathKey` string in a local variable within the compiler method's scope (e.g., `let lockToAwait = staticPathKey;`).
        *   **Location:** `compiler.js` (`compileSymbol`, `compileLookupVal`).

**Step 4: Implement Runtime Waiting Logic (`awaitSequenceLock`, `lookup`/`resolve` modification)**

*   **Goal:** Create runtime mechanism to wait the lock (identified in Step 3) and ensure `lookup`/`resolve` target `rootFrame` for `!` keys.
*   **Explanation:** Centralizes waiting. Await promise-based locks looked up via modified `lookup`. Modifying `lookup`/`resolve` ensures correct lock state access within `rootFrame`.
*   **Implementation:**
    *   Implement `runtime.awaitSequenceLock(frame, lockKeyToAwait)`: Takes the lock key. Uses modified `frame.lookup` to get the promise, if any. Must gracefully handle `lookup` returning `null` or non-promises for keys passed.
    *   Modify `AsyncFrame.lookup`: Add `if (name.startsWith('!'))` check to look in `this.rootFrame`.
    *   Modify `AsyncFrame.resolve`: Add `if (name.startsWith('!'))` check to return `this.rootFrame`.
*   **Verification:**
    *   Breakpoint Debugging runtime.

**Step 5: Implement Sequenced Lookup with Implicit Waiting (Runtime & Compiler)**

**   **Goal:** Create `sequencedMemberLookup` that waits on relevant lock (`lockKey` from Step 3) before lookup. Modify `compileLookupVal` to use it.
*   **Explanation:** Transparently adds waiting before property access on static context paths, using the `lockKey`.
*   **Implementation:**
    *   Implement `runtime.sequencedMemberLookup(frame, obj, val, lockKey)`: Resolves `obj`/`val`, calls `await awaitSequenceLock(frame, lockKey)`, performs `memberLookup`.
    *   Modify `Compiler.compileLookupVal`:
        1.  Perform analysis and actions described in **Step 3**.
        2.  If `pathArray` was not null (i.e., path is valid for sequencing):
            *   Emit call to `runtime.sequencedMemberLookup`, passing the `lockKey` determined in Step 3. (Note: `sequenceLockKey` is not relevant here as lookups don't acquire/release specific locks).
*   **Verification:**
    *   Integration tests (verify waiting works).
    *   Check Key: Verify via debugging/logging that only the *declared* key (`lockKey`) is passed to `sequencedMemberLookup`.

**Step 6: Implement Sequenced Call with Implicit Waiting (Runtime & Compiler)**

*   **Goal:** Create `sequencedCallWrap` helper that waits on relevant parent *and* specific locks before execution. Modify `compileFunCall` to use it.
*   **Explanation:** Handles waiting for the full lock hierarchy before calls on static context paths, using `lockKeys` (parent locks) and `sequenceLockKey` (specific lock).
*   **Implementation:**
    *   Implement `runtime.sequencedCallWrap(frame, funcOrMethod, funcName, context, args, lockKeysToAwait)`: Resolves inputs, calls `await awaitSequenceLocks(frame, lockKeysToAwait)`, performs `apply`.
    *   Modify `Compiler.compileFunCall`:
        1.  Perform analysis and actions described in **Step 3** for the object part of the call.
        2.  If `pathArray` was not null:
            *   Retrieve `lockKeys` and `sequenceLockKey` determined in Step 3.
            *   **Construct `lockKeysToAwait`:** `let lockKeysToAwait = [...lockKeys, sequenceLockKey].filter(Boolean);` (Filter ensures `null`/`undefined` `sequenceLockKey` is handled if `!` wasn't on the call itself, although Step 3 logic should guarantee `sequenceLockKey` exists if `pathArray` is not null).
            *   Emit **`await runtime.sequencedCallWrap(...)`**, passing the combined `lockKeysToAwait`. (Do NOT wrap in IIFE/try/finally yet).
*   **Verification:**
    *   Integration tests (parallel, sequential, mixed).
    *   Check Keys: Verify via debugging/logging correct combined keys (`lockKeysToAwait`) are passed.

**Step 7: Implement Lock Release/Signaling for `!` Calls (Compiler & Runtime Setup)**

*   **Goal:** Ensure the specific lock (`sequenceLockKey`) acquired by a `!` call is released *after* the call completes successfully, using `frame.set`.
*   **Explanation:** Connects successful completion back to the variable system to resolve the lock promise. Requires `frame.set` to correctly target `rootFrame`.
*   **Implementation:**
    *   **Compiler `compileFunCall`:** For cases where `pathArray` was not null in Step 3 (meaning a `sequenceLockKey` was derived): Emit `frame.set(${JSON.stringify(sequenceLockKey)}, true, true);` *immediately after* the `await runtime.sequencedCallWrap(...)` call.
    *   **Runtime `AsyncFrame.set` Modification (Crucial):** Modify `AsyncFrame.set` to handle targeting `rootFrame` for `!` keys, ensuring the value is set correctly in `rootFrame`'s `variables` or `asyncVars` and `_countdownAndResolveAsyncWrites` is triggered appropriately relative to the current frame's context, passing the `rootFrame` as the `scopeFrame` hint.
    *   **Runtime Setup:** Verify `_promisifyParentVariables`, `_countdown...`, `_resolve...` handle the modified `set` targeting `rootFrame` correctly.
*   **Verification:**
    *   Debugging `frame.set` and promise resolution in `rootFrame`.
    *   Sequential tests (for both `path!.method` and `method!()`).

**Step 8: Implement Robust Error Handling & Signaling for `!` Calls (Compiler)**

*   **Title:** Ensure Lock Release via `finally` for `!` Calls.
*   **Explanation:** Wrap `await sequencedCallWrap(...)` and subsequent logic *specifically for operations with a `sequenceLockKey`* within an async IIFE (`try...catch...finally`). The `finally` block guarantees `frame.set(sequenceLockKey, true, true)` executes, releasing the lock even on error.
*   **Implementation:**
    *   **Compiler `compileFunCall`:** Locate the block where `pathArray` was not null (Step 3). Wrap the code generated in Step 6 and Step 7 for this case inside the `(async (astate, frame) => { ... })(astate.enterAsyncBlock(), ...)` structure.
        *   `try` block should contain:
            *   `let callResult = await runtime.sequencedCallWrap(...)`
            *   `return callResult;` // Return the result if needed by the template context
        *   `catch` block should call `cb(runtime.handleError(e, ...))`.
        *   `finally` block *must* contain:
            *   `frame.set(${JSON.stringify(sequenceLockKey)}, true, true);` // Release lock using correct sequenceLockKey
            *   `astate.leaveAsyncBlock();` // Decrement counter
*   **Verification:**
    *   Error Test (verify no deadlock, error logged for both `path!.m` and `m!()`).
    *   Inspect Generated Code (verify structure only wraps `!` calls, `finally` content is correct).

**Step 9: Add Documentation**

*   **Goal:** Document feature, syntax, usage, **static context variable path limitation**, errors, performance.
*   **Details:** Explain `!`, `method!()`. Provide clear correct/incorrect examples.
*   **Verification:** Peer review.