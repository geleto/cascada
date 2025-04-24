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

You will use the following files (previously attached):

*   `README.md`: Describes the feature from a user perspective (including syntax and constraints).
*   `async-implamentation.md`: Explains Cascada's internal async/sync mechanisms and variable synchronization (crucial background reading).
*   `runtime.js`: Contains the `AsyncFrame` class and runtime helpers (you will modify/add to this).
*   `compiler.js`: Contains the `Compiler` class (you will modify/add to this).

**5. Detailed Implementation Steps (Revised):**

Please implement these steps sequentially, verifying each one thoroughly.

**Step 1: Implement Helper `_extractStaticPathParts`**

*   **Goal:** Create a helper function to extract static path segments from an AST node representing a potential path.
*   **Explanation:** This helper is needed by both lookups and function calls to understand the static structure of the path they operate on, primarily for determining potential parent locks to wait for later. It does not handle `!` or context validation itself.
*   **Implementation:**
    *   Add the helper function `_extractStaticPathParts(node)` to `Compiler.prototype`.
    *   It traverses upwards from `node` (`LookupVal`, `Symbol`).
    *   It collects `Symbol` values or string `Literal` values into an array.
    *   If any segment is dynamic (not `Symbol` or string `Literal`), it returns `null`.
    *   Returns the `string[]` path array or `null`.
*   **Verification:**
    *   Unit tests for `_extractStaticPathParts` with various static, dynamic, and mixed paths.

**Step 2: Implement Helper `_getSequencedPath` - *Validation Focused*)**

*   **Goal:** Create a helper function specifically for validating the use of the `!` sequence marker and extracting the path *only* when `!` is used correctly.
*   **Explanation:** This helper centralizes all validation logic related to the `!` marker itself. It will be used exclusively by `compileFunCall` to determine if a call *initiates* a sequence step.
*   **Implementation:**
    *   Add the helper function `_getSequencedPath(node, frame)` to `Compiler.prototype`.
    *   It traverses the AST upwards from `node` (`LookupVal`, `Symbol`).
    *   It looks for `node.sequenced === true` flags.
    *   It performs **all** `!`-related validation:
        *   Checks that `!` is present.
        *   Checks that path segments up to and including the `!` are static.
        *   Checks that the path root originates from a context variable (using `_isScopeVariable`).
        *   Checks that there are no double `!` markers.
    *   If all validations pass, it returns the static path array ending just *before* the segment with `!`. (e.g., for `a.b!.c()`, where `node` represents `a.b`, it returns `['a', 'b']`).
    *   If no `!` is found or any validation fails, it returns `null` and **must throw a `TemplateError`** explaining the specific validation failure (e.g., "Sequence marker '!' cannot be used on dynamic paths", "Sequence marker '!' must originate from a context variable", "Double sequence marker '!' is not allowed").
*   **Verification:**
    *   Unit tests for `_getSequencedPath` covering all success and failure cases (dynamic paths, scope variables, no `!`, double `!`, valid paths). Ensure appropriate `TemplateError`s are thrown.

**Step 3: Modify `Compiler.prototype.compile` Signature and Callers - *New Step*)**

*   **Goal:** Introduce the `parentPathNode` argument to the main compile function to pass context down during recursive compilation.
*   **Explanation:** This argument allows `compileLookupVal` to know the immediate context in which it was called (specifically, whether it was called directly by another `LookupVal` or a `FunCall`), enabling `!` placement validation.
*   **Implementation:**
    *   Modify the signature: `compile(node, frame, parentPathNode = null)`.
    *   In `compileLookupVal(node, frame, parentPathNode)`: Update the recursive call for the target: `this.compile(node.target, frame, node)`.
    *   In `compileFunCall(node, frame, parentPathNode)`: Update the call for the function name: `this.compile(node.name, frame, node)`.
    *   Verify that no other callers of `this.compile` within the compiler need to pass this argument; they should use the `null` default.
*   **Verification:**
    *   Review all usages of `this.compile` within `compiler.js` to ensure the argument is passed correctly where needed and omitted elsewhere.
    *   Use breakpoint debugging during compilation of simple templates to confirm `parentPathNode` has the expected value (or `null`) inside `compileLookupVal` and `compileFunCall`.

**Step 4: Integrate Helpers and Validation into `compileLookupVal`**

*   **Goal:** Use `_extractStaticPathParts` to get path info and use the new `parentPathNode` argument to validate `!` placement within `compileLookupVal`.
*   **Explanation:** `compileLookupVal` needs the static path for later wait determination. It also enforces the rule that `!` cannot appear on a lookup unless that lookup is the direct `name` child of a `FunCall`.
*   **Implementation:**
    *   Modify `Compiler.compileLookupVal(node, frame, parentPathNode)`:
        1.  Call `const staticPathParts = this._extractStaticPathParts(node);`. Store this locally (e.g., `node._staticPathParts = staticPathParts;` if attaching to node, or just keep in a local variable) for use in Step 7.
        2.  **Validation:** If `node.sequenced === true`:
            *   Check the received `parentPathNode`. If `!(parentPathNode instanceof nodes.FunCall)`, **throw a `TemplateError`** stating that `!` can only be used immediately before a function/method call.
    3.  Proceed with generating the standard `runtime.memberLookup` or `runtime.memberLookupAsync` code. This step does *not* yet introduce waiting logic.
*   **Verification:**
    *   Compile templates with invalid `!` usage like `{{ a.b! }}` or `{% set x = a.b! %}` or `{{ a.b! + 1 }}`. Verify the `TemplateError` is thrown correctly from `compileLookupVal`.
    *   Compile templates with valid `!` usage like `{{ a.b!.c() }}`. Verify *no* error is thrown at this stage.
    *   Use debugging/logging to confirm `staticPathParts` is calculated.

**Step 5: Integrate Helpers into `compileFunCall` for Sequence Logic**

*   **Goal:** Use both helpers in `compileFunCall` to detect if the call is sequenced, perform `!` validation, register the specific lock, and determine all necessary locks to wait for.
*   **Explanation:** `compileFunCall` is the control center for sequenced calls. It uses `_getSequencedPath` for `!`-specific logic and `_extractStaticPathParts` for general path structure needed for determining waits.
*   **Implementation:**
    *   Modify `Compiler.compileFunCall(node, frame, parentPathNode)`:
        1.  Call `const staticPathParts = this._extractStaticPathParts(node.name);`. Store this locally. (Needed for Step 8 to determine general parent waits).
        2.  Call `const sequencedPathArray = this._getSequencedPath(node.name, frame);`. (This performs all `!` validation via errors and returns path *only* if `node.name` represents a valid sequence initiator like `a.b!`).
        3.  Set `const isSequencedCall = (sequencedPathArray !== null);`.
        4.  Declare `let sequenceLockKey = null;` and `let parentLockKeysForSequence = [];`.
        5.  **If `isSequencedCall`:**
            *   Derive `sequenceLockKey = '!' + sequencedPathArray.join('!');`.
            *   Register the lock: `this._updateFrameWrites(frame.rootFrame, sequenceLockKey);`.
            *   Define a helper `filter_parents(pathArray, declaredVars)` (or inline logic) to generate lock keys for parent paths (e.g., `!a` from `['a','b']`) and return only those present in `declaredVars`.
            *   Calculate `parentLockKeysForSequence = filter_parents(sequencedPathArray, frame.rootFrame.declaredVars)`.
        6.  **(Potentially needed later for Step 8):** Calculate `parentLockKeysToWait = filter_parents(staticPathParts, frame.rootFrame.declaredVars);`. (This finds locks set by *other* operations).
        7.  **(Potentially needed later for Step 8):** Construct `totalLocksToWait = [...new Set([...parentLockKeysToWait, ...(isSequencedCall ? [sequenceLockKey, ...parentLockKeysForSequence] : [])])];`. Using a Set ensures uniqueness.
        8.  Store `isSequencedCall`, `sequenceLockKey`, and `totalLocksToWait` locally (or attach to `node`) for use in Steps 8, 9, 10.
    *   Proceed with generating the initial part of the function call code (e.g., `(lineno = ..., colno = ..., `). The actual call (`callWrap` vs `sequencedCallWrap`) is generated in Step 8.
*   **Verification:**
    *   Debug `compileFunCall` for sequenced (`a.b!.c()`) and non-sequenced (`a.b.c()`, `a.b.c() where a! exists`) calls.
    *   Verify `isSequencedCall` is correct.
    *   Verify `_updateFrameWrites` is called only for `isSequencedCall === true` with the correct `sequenceLockKey`.
    *   Verify `parentLockKeysForSequence` and `parentLockKeysToWait` (and thus `totalLocksToWait`) are calculated correctly based on `frame.rootFrame.declaredVars` (which should reflect prior registrations).
    *   Ensure `_getSequencedPath` throws errors for invalid `!` usage before this step proceeds too far.

**Step 6: Implement Runtime Waiting Logic (`awaitSequenceLocks`, `lookup`/`resolve` modification) - *Unchanged from original plan*)**

*   **Goal:** Create runtime mechanism to wait for active locks and ensure `lookup`/`resolve` target `rootFrame` for `!` keys.
*   **Explanation:** Centralizes waiting. `awaitSequenceLocks` waits for promise-based locks looked up via modified `lookup`. Modifying `lookup`/`resolve` ensures correct lock state access within `rootFrame`.
*   **Implementation:**
    *   Implement `runtime.awaitSequenceLocks(frame, lockKeysToAwait)`: Takes the list of lock keys. Uses modified `frame.lookup`, collects promises, `await Promise.all`. Must gracefully handle `lookup` returning `null` or non-promises for keys passed.
    *   Modify `AsyncFrame.lookup`: Add `if (name.startsWith('!'))` check to look in `this.rootFrame`.
    *   Modify `AsyncFrame.resolve`: Add `if (name.startsWith('!'))` check to return `this.rootFrame`.
*   **Verification:**
    *   Unit Tests for `awaitSequenceLocks`, `lookup`, `resolve`.
    *   Breakpoint Debugging runtime.

**Step 7: Implement Sequenced Lookup with Implicit Waiting (Runtime & Compiler)**

*   **Goal:** Create `sequencedMemberLookup` helper and modify `compileLookupVal` to use it when necessary to wait for parent locks.
*   **Explanation:** Adds waiting *before* property access if the static path overlaps with known sequences. Uses the `staticPathParts` gathered in Step 4.
*   **Implementation:**
    *   Implement `runtime.sequencedMemberLookup(frame, obj, val, locksToWait)`: Resolves `obj`/`val` (using `resolveDuo`), calls `await awaitSequenceLocks(frame, locksToWait)`, then performs `memberLookup(resolvedObj, resolvedVal)`.
    *   Modify `Compiler.compileLookupVal`:
        1.  Retrieve `staticPathParts` (calculated in Step 4).
        2.  If `staticPathParts` is not null:
            *   Define `filter_parents` helper or inline logic as in Step 5.
            *   Calculate `parentLockKeysToWait = filter_parents(staticPathParts, frame.rootFrame.declaredVars);`.
            *   If `parentLockKeysToWait.length > 0`:
                *   Emit code calling `runtime.sequencedMemberLookup`, passing `parentLockKeysToWait` as the last argument. Ensure the target and value compilation happens correctly as arguments *to* `sequencedMemberLookup`, potentially using `_compileAggregate` or similar if target/val are complex/async.
            *   Else (`parentLockKeysToWait` is empty): Emit the standard `runtime.memberLookup` / `memberLookupAsync` call as before.
        3.  Else (`staticPathParts` is null): Emit the standard `runtime.memberLookup` / `memberLookupAsync` call.
*   **Verification:**
    *   Integration tests: Create template where `a!` is set, then access `a.b`. Verify `a.b` lookup waits. Access `x.y` (unrelated) and verify it does *not* wait.
    *   Check generated code: Verify `sequencedMemberLookup` is used only when overlapping static paths and declared locks exist.

**Step 8: Implement Sequenced Call with Implicit Waiting (Runtime & Compiler)**

*   **Goal:** Create `sequencedCallWrap` helper and modify `compileFunCall` to use it, passing the combined list of locks to wait for.
*   **Explanation:** Handles waiting for the full lock hierarchy (specific and parent locks) before executing a function call. Uses `totalLocksToWait` determined in Step 5.
*   **Implementation:**
    *   Implement `runtime.sequencedCallWrap(frame, funcOrMethod, funcName, context, args, locksToWait)`: Resolves `funcOrMethod` and `args` (using `resolveAll`), calls `await awaitSequenceLocks(frame, locksToWait)`, then performs `funcOrMethod.apply(context, resolvedArgs)`.
    *   Modify `Compiler.compileFunCall`:
        1.  Retrieve `totalLocksToWait` (calculated in Step 5).
        2.  Retrieve the compilation results for the function (`node.name`) and arguments (`node.args`).
        3.  If `totalLocksToWait.length > 0`:
            *   Emit code calling `await runtime.sequencedCallWrap(...)`, passing the compiled function, name, context, compiled args, and `totalLocksToWait`. Use appropriate helpers (`_compileAggregate`) for compiling function/args if they are async.
        4.  Else (`totalLocksToWait` is empty):
            *   Emit code calling standard `runtime.callWrap(...)`, passing the compiled function, name, context, compiled args. Handle async resolution of function/args as usual.
    *   **Important:** This step generates the core `await ...Wrap(...)` call but does *not* yet wrap it in the `try...finally` for lock release.
*   **Verification:**
    *   Integration tests: Test parallel calls (`a.foo()`, `b.bar()`), sequential calls (`a!.foo()`, `a!.bar()`), mixed calls (`a!.foo()`, `a.b()`, `a!.bar()`). Verify execution order and waiting.
    *   Check generated code: Verify `sequencedCallWrap` vs `callWrap` usage and the `totalLocksToWait` array passed.

**Step 9: Implement Lock Release/Signaling for `!` Calls (Compiler & Runtime Setup)**

*   **Goal:** Ensure the specific lock (`sequenceLockKey`) acquired by a `!` call is released *after* the call completes, using the modified `frame.set`.
*   **Explanation:** Connects successful completion (or failure handled by `finally`) back to the variable system to resolve the lock promise, allowing subsequent operations in the same sequence to proceed. Relies on `set` targeting `rootFrame`.
*   **Implementation:**
    *   **Compiler `compileFunCall`:** For cases where `isSequencedCall` is true (determined in Step 5): Emit `frame.set(${JSON.stringify(sequenceLockKey)}, true, true);` *immediately after* the `await runtime.sequencedCallWrap(...)` call generated in Step 8.
    *   **Runtime `AsyncFrame.set` Modification (Crucial):** Modify `AsyncFrame.set` as planned:
        *   Check if `name.startsWith('!')`.
        *   If yes:
            *   Find the `scopeFrame` which should be `this.rootFrame`. (`resolve(name, true)` should return `rootFrame`).
            *   Perform the set (`variables` or `asyncVars`) directly on `scopeFrame` (`rootFrame`).
            *   Trigger `_countdownAndResolveAsyncWrites(name, 1, scopeFrame)` starting from the *current* frame but ensuring propagation stops correctly relative to the `scopeFrame` (`rootFrame`).
        *   If no: Proceed with existing `set` logic.
*   **Verification:**
    *   Unit tests for the modified `AsyncFrame.set` focusing on `!` keys and `rootFrame` interaction.
    *   Debug `compileFunCall` output: Verify the `frame.set` call is generated *only* when `isSequencedCall` is true.
    *   Runtime debugging: Trace `frame.set` for a `!` key, verify it updates `rootFrame` and triggers `_countdownAndResolveAsyncWrites` correctly, leading to promise resolution in `rootFrame`.
    *   Integration test: `a!.foo(); a!.bar();` – verify `bar` executes after `foo` completes.

**Step 10: Implement Robust Error Handling & Signaling for `!` Calls (Compiler)**

*   **Title:** Ensure Lock Release via `finally` for Sequenced Calls.
*   **Explanation:** Wrap the `await sequencedCallWrap(...)` and the subsequent `frame.set(...)` logic *specifically for sequenced calls (`isSequencedCall === true`)* within an async IIFE (`try...catch...finally`). The `finally` block guarantees the `frame.set(sequenceLockKey, true, true)` executes, releasing the lock even if the `sequencedCallWrap` throws an error.
*   **Implementation:**
    *   **Compiler `compileFunCall`:** Locate the block where `isSequencedCall` is true (Step 5).
    *   Wrap the code generated in Step 8 (the `await sequencedCallWrap`) and Step 9 (the immediate `frame.set` call) inside the `(async (astate, frame) => { ... })(astate.enterAsyncBlock(), ...)` structure.
        *   `try` block should contain:
            *   `let callResult = await runtime.sequencedCallWrap(...)`
            *   `frame.set(${JSON.stringify(sequenceLockKey)}, true, true);` // Signal completion on success *before* finally
            *   `return callResult;` // Or handle result appropriately if needed
        *   `catch` block should likely re-throw or call `cb(runtime.handleError(e, ...))`.
        *   `finally` block *must* contain:
            *   `frame.set(${JSON.stringify(sequenceLockKey)}, true, true);` // Ensure release using correct sequenceLockKey
            *   `astate.leaveAsyncBlock();` // Decrement counter
    *   Modify Step 9: Remove the *immediate* `frame.set` call after `sequencedCallWrap`, as it's now handled within the `try` block of this step. The `finally` block provides the guarantee.
*   **Verification:**
    *   Error Test: Create a template like `{{ a!.throwsError() }}; {{ a!.nextOp() }}`. Verify `nextOp` still runs (or the template completes without deadlock) and the error from `throwsError` is reported correctly.
    *   Inspect Generated Code: Verify the `try...catch...finally` structure wraps *only* the sequenced calls and that `frame.set` is correctly placed in `try` (optional, for quicker signaling on success) *and* `finally` (mandatory for guarantee).

**Step 11: Add Documentation**

*   **Title:** Add Documentation.
*   **Summary:** Document feature, syntax (`!`), usage examples, the **critical static context variable path limitation**, error handling, performance implications.