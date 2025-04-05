# Cascada Internals: Implicit Concurrency and Asynchronous Handling

Cascada's core value proposition lies in its ability to handle asynchronous operations (like database queries, API calls, or computationally intensive tasks represented by Promises, async functions, or async iterators) within templates and scripts *without* requiring explicit `async` or `await` keywords from the template author. It achieves this through a sophisticated compilation strategy and runtime system designed for **enabling automatic concurrency** and **state synchronization**, ensuring that results are identical to sequential execution while maximizing performance where possible.

This document dives into the internal mechanisms that make this seamless experience possible.

## The Core Challenge: Concurrency with Sequential Equivalence

Modern applications frequently involve asynchronous operations. Integrating these into a templating engine traditionally requires careful manual management. Simply allowing `await` within templates can lead to complex, hard-to-reason-about code, potential deadlocks if dependencies aren't meticulously tracked by the author, and significant performance bottlenecks if independent operations inadvertently block each other. Cascada aims to eliminate this burden.

The challenge is twofold:

1.  **Enable Concurrency:** Allow potentially asynchronous operations to start execution without blocking the main template flow, enabling parallelism where operations don't have direct dependencies.
2.  **Guarantee Correctness:** Ensure that despite potential parallel execution, the final output and the state of variables are exactly the same as if all operations had been executed strictly one after another (sequential equivalence). This involves correctly handling dependencies and synchronizing access to shared variables modified by concurrent operations.

Cascada addresses this through a combination of compile-time analysis and a specialized runtime environment, based on a few core principles.

## Cascada's Core Principles

To achieve implicit concurrency with correctness, Cascada relies on these fundamental strategies:

1.  **Transparent Asynchronicity:** Treat Promises and other async constructs as first-class values throughout the engine without special syntax.
2.  **Non-Blocking Execution:** Wrap potentially asynchronous operations in structures (`async` IIFEs) that allow them to start without blocking the main execution thread.
3.  **Deferred Resolution:** Avoid resolving Promises until their concrete value is absolutely necessary for an operation or output, maximizing the window for other tasks to run concurrently.
4.  **State Synchronization:** Implement mechanisms (variable snapshots and a promise-based counting system) to ensure that variable reads and writes behave as if they occurred sequentially, even when executed concurrently.
5.  **Ordered Output Buffering:** Use a hierarchical buffer to ensure final output (text, and planned for data) reflects the template's logical structure, not the unpredictable completion order of async tasks.

## Mechanism 1: Universal & Deferred Asynchronicity

The foundation of Cascada's async support is its ability to treat Promises and other asynchronous constructs as first-class citizens throughout the engine, without special syntax, and resolving them as late as possible.

*   **Input Flexibility:** Context variables passed to the template, functions called from the template, filters, and extensions can all return Promises or be `async` functions. Loops can operate directly on async iterators (`Symbol.asyncIterator`).
*   **Internal Operations:** All internal engine operations, from variable lookups (`runtime.memberLookupAsync`) and function calls (`runtime.callWrap` with async targets) to comparisons and arithmetic operations, are designed to implicitly handle potential Promise inputs. They use runtime helpers like `runtime.resolveAll`, `runtime.resolveDuo`, `runtime.resolveSingle` to wait for values only when strictly necessary *for the specific operation itself*.
*   **Deferred Resolution:** The engine aims to avoid resolving Promises prematurely. A Promise might be assigned to a variable or passed through several operations before its actual value is required (e.g., for outputting to the template or as a resolved operand in a calculation). This lazy resolution is key to allowing other operations to proceed concurrently. (See Limitations section regarding current array/object literal handling).

```javascript
{% set userPromise = fetchUser(1) %} // userPromise holds a Promise
{% set postsPromise = fetchPosts(userPromise) %} // postsPromise holds Promise, fetchPosts likely awaits userPromise internally
{{ postsPromise[0].title }} // postsPromise (and implicitly userPromise) resolved only here when title needed
```

## Mechanism 2: Enabling Concurrency via Async Blocks

Cascada enables concurrency by compiling potentially asynchronous sections of the template (identified by the compiler) into self-contained units called "Async Blocks." It doesn't explicitly *identify* independent operations beforehand, but rather structures the code so that independence can lead to parallelism.

*   **IIFE Closures:** At the core, each async block in the generated JavaScript code is typically wrapped in an Immediately Invoked Function Expression (IIFE), specifically an `async` IIFE:
    ```javascript
    // Simplified conceptual representation
    (async (astate, frame) => { // The async IIFE
      try {
        // ... compiled template code for the block ...
        // This code might contain internal 'await's for its own operations
        // or for dependency synchronization managed by the runtime.
      } catch (e) {
        runtime.handleError(e, lineno, colno); // Report errors
        // Error might be propagated via callback or rejected promise chain
      } finally {
        // Signal completion to the runtime state tracker
        astate.leaveAsyncBlock();
      }
    // Pass runtime state tracker and potentially a new frame
    })(astate.enterAsyncBlock(), frame.pushAsyncBlock(...));
    ```
*   **Non-Blocking Execution:** The `async` IIFE is *called* immediately. Because it's `async`, the call *returns* a Promise almost instantly, *before* the asynchronous operations *within* the IIFE have completed. This allows the main template execution flow to continue processing subsequent code that doesn't depend on this block's result, effectively enabling concurrency whenever multiple such blocks are initiated without intermediate `await`s.
*   **Runtime State Tracking (`astate`):** A runtime state object (conceptually `astate`) tracks the overall progress.
    *   `enterAsyncBlock()`: Increments a counter of active async blocks when an IIFE starts.
    *   `leaveAsyncBlock()`: Decrements the counter when an IIFE finishes (in the `finally` block, ensuring it runs even on error).
    *   `waitAllClosures()`: Returns a Promise that resolves only when the active block counter reaches zero. The main rendering process awaits this promise before finalizing the output, ensuring all concurrent work is done.
*   **Concurrent Resolution Points:** Parallelism emerges naturally when multiple `async` IIFEs are initiated without awaiting each other. Explicit concurrent resolution occurs when multiple potentially async inputs are needed for a single operation, using runtime helpers:
    *   **Function/Macro/Filter/Tag Arguments:** Arguments are often evaluated concurrently using `runtime.resolveAll`. The operation itself waits for all arguments to resolve.
    *   **Expression Operands:** Operands in expressions (e.g., `a + b`, `x > y`) can resolve concurrently using `runtime.resolveDuo` or `runtime.resolveAll`. The operation using them waits for resolution.
    *   **Literals (Current Limitation):** *Currently*, elements within Array literals (`[...]`) and values within Object literals (`{...}`) are resolved concurrently using `runtime.resolveAll` or `runtime.resolveObjectProperties` *before* the structure is finalized. (See Limitations).
    *   **Template Composition:** Includes (`include`), Imports (`import`), and Parent Templates (`extends`) involve asynchronously loading the template definition (`env.getTemplate` is async). The rendering of the loaded template then typically occurs within its own async block, allowing it to run concurrently with other independent logic in the caller.

## Mechanism 3: Ensuring Sequential Equivalence - Output Order

Executing operations concurrently requires a mechanism to ensure the final output matches the order defined in the template, not the random order of completion.

*   **Tree-Structured Output Buffer:** Instead of appending output strings to a single linear buffer (prone to race conditions), Cascada uses a hierarchical buffer.
    *   **Hierarchical Arrays:** The buffer is implemented as nested JavaScript arrays.
    *   **Dedicated Branches:** Each async block that produces output (often using `_emitAsyncBlockBufferNodeBegin`) writes to its *own* sub-array within this tree. Independent blocks write to different branches concurrently without conflict.
    *   **Preserving Order:** The *position* where a sub-buffer array is inserted into its parent array is determined by the *start* time of the async block in the template's logical flow. This preserves the correct sequential order relative to sibling blocks and surrounding static content.
    *   **Final Flattening:** After `astate.waitAllClosures()` resolves (all blocks done), the entire buffer tree is recursively flattened (`runtime.flattentBuffer`) into the final output string, respecting the structure established during parallel execution.
*   **(Future/Scripting) Data Assembly Ordering:** This same principle of ordered insertion into a structure based on initiation sequence (not completion) is planned for Cascada Script's Data Assembly Commands (`put`, `merge`, `push`). They will operate on a parallel data structure (instead of the text buffer) to ensure data modifications appear in the final result object in the same order they were specified in the script, providing predictable data construction despite concurrency. (This is not yet implemented in the core engine).

## Mechanism 4: Ensuring Sequential Equivalence - Variable State

This is the most complex part, ensuring variable reads/writes are consistent despite concurrency. It involves two related techniques:

### 4a. Frame State Preservation (Snapshots)

Async blocks execute potentially *after* the surrounding code has moved on. A block needs to see variable values *as they were when it was initiated*.

*   **`pushAsyncBlock` Initiation:** When an async block starts (`frame.pushAsyncBlock`), the compiler provides info on variables it might *read* (`reads`) and *write* (`writeCounters`).
*   **`_snapshotVariables`:** For variables only *read* within the block (or read before being written), their current values are copied from the parent frame into the new async block frame's `asyncVars` dictionary. This captures the state at launch time.
*   **Isolation:** Code inside the async block primarily interacts with its own `AsyncFrame` and its `asyncVars` snapshot, protecting it from later modifications in parent scopes that might occur *while* the async block is running.

### 4b. Variable Synchronization (Promisification & Counting)

While snapshots handle reading the correct initial state, ensuring consistency when multiple concurrent async blocks might *write* to the same outer-scope variable requires a more sophisticated synchronization mechanism. Cascada addresses this using a promise-based reference counting system.

**Purpose:** To prevent reads of potentially incorrect or intermediate values during concurrent execution. When an async block *might* modify a shared variable `x`, this mechanism replaces `x` in the outer scope with a Promise. This Promise acts as a lock, delaying any reads until it resolves. Crucially, it only resolves to the final, correct value *after all potential concurrent writes* to `x` are guaranteed to be finished or accounted for. To achieve this, the compiler calculates the maximum potential writes across *all conditional branches* (e.g., both the `if` and `else` paths and all `switch` paths), and the runtime meticulously decrements this count for both executed writes *and* writes skipped in branches not taken. This ensures the Promise resolves only when the variable's state is stable according to sequential logic, regardless of the actual runtime execution path and concurrency.

1.  **Compile-Time Analysis (Predicting Writes):**
    *   **Tracking Usage:** Compiler tracks declarations (`declaredVars`), reads (`readVars`), and potential writes across scopes.
    *   **Calculating `writeCounts`:** For each async scope, determines which outer variables might be modified within it or its children. Calculates a `writeCounts` map `{ varName: count }`, estimating the *maximum potential number* of writes. **Critically, includes writes in all conditional branches (e.g., `if` AND `else`)**, anticipating paths not taken at runtime.
    *   **Embedding Information:** `writeCounts` map (and `readVars`) passed to `frame.pushAsyncBlock(reads, writeCounters)`.

2.  **Runtime: Entering an Async Block (`pushAsyncBlock`):**
    *   **Frame Creation:** New `AsyncFrame`.
    *   **Snapshotting Reads (`_snapshotVariables`):** As above.
    *   **Promisification (`_promisifyParentVariables`):** For variables listed in `writeCounters`:
        *   Store `writeCounters` on the new frame.
        *   Snapshot current value into `asyncVars` (for use *within* this block).
        *   Create a **new Promise** for the variable. Store its `resolve` function in `promiseResolves`.
        *   **Crucially:** Replace the variable's entry in the *parent frame* (`variables` or `asyncVars`) **with this new Promise**.
        *   **Effect:** Outer scope reads now get the Promise, blocking access to the value until resolved.

3.  **Runtime: Performing a Write (`frame.set(name, val, true)`):**
    *   **Scope Identification:** Find declaring frame (`scopeFrame`).
    *   **Local Update:** Store `val` in the *current* async block's `asyncVars[name]`. Does *not* update parent Promise yet.
    *   **Decrementing the Count (`_countdownAsyncWrites`):**
        *   Decrement `writeCounters[name]` on the *current* frame.
        *   **Propagate Upwards:** Decrement propagates up the `AsyncFrame` chain towards `scopeFrame`.
        *   **Completion Check:** If a frame's counter for `name` hits zero:
            *   Call `_resolveAsyncVar(name)` (resolve the promise with the final value from *this frame's* `asyncVars`).
            *   Propagate a single "completed write" count upwards.
        *   **Stopping:** Propagation stops if an ancestor's counter > 0 (other pending writes exist).

4.  **Runtime: Handling Skipped Branches (`skipBranchWrites`):**
    *   Called when `if`/`switch` skips a branch, passing the pre-calculated `writeCounts` of the **skipped branch**.
    *   Calls `_countdownAsyncWrites` for these "missed" writes. Ensures counters decrement correctly even for writes that didn't happen, preventing indefinite waiting.

5.  **Runtime: Resolving the Variable (`_resolveAsyncVar`):**
    *   **Trigger:** Called by `_countdownAsyncWrites` when a frame's counter for a variable hits zero.
    *   **Get Final Value:** Retrieves final value from the *current frame's* `asyncVars`.
    *   **Resolve Promise:** Uses stored `resolve` function to fulfill the Promise in the parent scope with the final value (chaining if value is also a promise).
    *   **Unlocking Reads:** Promise fulfillment makes the correct value available to waiting reads in other blocks or subsequent code.

**Outcome:** This guarantees variables modified concurrently resolve only after *all* contributing async blocks (including skipped branches) finish potential writes, ensuring sequential consistency.

## The Compiler's Role

The compiler performs crucial static analysis to enable the runtime mechanisms.

*   **AST Transformation (`propagateIsAsync`):** Traverses the Abstract Syntax Tree (AST), marking each node `isAsync = true` if it or any child represents a potentially async operation. This flag dictates code generation paths.
*   **Async Block Generation (`_emitAsyncBlock`, etc.):** When compiling an `isAsync` node (typically a template tag or complex expression), wraps the generated code in the `async` IIFE structure using helpers. Manages:
    *   IIFE creation (`async (...) => { ... }`).
    *   `try...catch...finally` for errors and cleanup (`astate.leaveAsyncBlock`).
    *   Runtime frame setup (`frame.pushAsyncBlock(...)` passing `reads` and `writeCounters`).
    *   Hierarchical buffer management (`bufferStack`, `_pushBuffer`, `_popBuffer`).
    *   Tracking async closure depth (`asyncClosureDepth`).
*   **Variable Tracking Integration:** Frame analysis (`_updateFrameWrites`, `_updateFrameReads`) computes the `readVars` and `writeCounts` needed for runtime snapshotting and promisification.

## The Runtime's Role

The runtime (`runtime.js`) provides the classes and helpers that execute the compiled code and manage the async flow.

*   **`AsyncFrame`:** Extends `Frame` for async ops. Key properties: `asyncVars` (snapshots/intermediate values), `writeCounters`, `promiseResolves`. Key methods: `pushAsyncBlock`, `_snapshotVariables`, `_promisifyParentVariables`, `_countdownAsyncWrites`, `skipBranchWrites`, `_resolveAsyncVar`.
*   **`AsyncState` (Conceptual):** Manages overall async state: active block count (`enter/leaveAsyncBlock`), completion waiting (`waitAllClosures`).
*   **Buffer Management (`flattentBuffer`):** Recursively flattens the nested buffer array into the final output string.
*   **Async Helpers:** Functions (`resolveAll`, `resolveDuo`, `resolveSingle`, `memberLookupAsync`, `iterate`, `promisify`, etc.) provide building blocks for implicit Promise handling.

## How Specific Constructs are Handled

The core mechanisms are applied consistently:

*   **Control Flow (`if`, `for`, `switch`):** Branches are wrapped in async blocks if needed. Compiler generates `writeCounts` for *all* branches; runtime uses `skipBranchWrites` for untaken paths. `for` uses `runtime.iterate` for async iterators, potentially wrapping iterations in async contexts.
*   **Template Composition (`include`, `extends`, `import`, `block`):** Use `_compileGetTemplate` (async) for loading. Rendering/integration logic wrapped in async blocks. State synchronization works across boundaries (with planned `depends` tag for dynamic cases).
*   **Macros, Functions, Filters, Extensions:** Use `resolveAll`/`resolveDuo` etc. for concurrent argument resolution. Async functions/filters/extensions are handled seamlessly. Macros manage their internal async state.

## Error Handling

Error handling is built into the async block structure:

*   **`try...catch...finally`:** Generated code wraps async block logic.
*   **`runtime.handleError`:** Catches add context (line/col).
*   **Propagation:** Errors typically reject Promises or use the callback chain, ultimately causing `astate.waitAllClosures()` to reject.
*   **Cleanup (`finally`):** Ensures `astate.leaveAsyncBlock()` runs even on error, preventing deadlocks.

## Performance Considerations

Cascada's approach involves trade-offs:

*   **Overhead:** Creating `async` IIFEs, managing frames, snapshotting, promisifying, and counting variables introduces runtime overhead compared to purely synchronous execution or manual `await`.
*   **Gains:** For templates with I/O-bound operations (API calls, DB queries) or parallelizable CPU-bound tasks represented as Promises, the ability to execute these concurrently can lead to significant performance improvements, often outweighing the overhead.
*   **Granularity:** The effectiveness depends on the granularity and independence of async tasks within the template. Too many tiny, interdependent async blocks might not yield benefits.

## Known Limitations and Future Work

*   **Array/Object Literal Resolution:** Currently forces eager resolution of all async items within literals, preventing deferred resolution. Needs refinement.
*   **Data Assembly Commands:** Core engine lacks `put`/`merge`/`push`. Integrating these while preserving order is future work.
*   **Cross-Template Variable Dependencies:** Explicit `{% depends %}` declaration for dynamic includes/extends is planned but not fully implemented.
*   **New Tags:** `{% try %}`, `{% while %}`, `{% do %}` are planned.
*   **Debugging:** Implicit concurrency can make debugging challenging compared to explicit `await`. Tooling or specific logging strategies might be needed for complex cases.
*   **Further Optimizations:** Ongoing work to reduce runtime overhead and improve compiler analysis.

## Conclusion

Cascada's implicit concurrency model tackles the challenge of async operations in templates through a sophisticated blend of compile-time analysis and runtime orchestration. By using non-blocking async blocks, a hierarchical output buffer, state snapshotting, and a robust promise-based variable synchronization system, it enables potential parallelism while rigorously maintaining the determinism of sequential execution. This frees template authors from manual async management, resulting in cleaner code and unlocking performance benefits for asynchronous workflows, underpinning both Cascada's templating and scripting capabilities.