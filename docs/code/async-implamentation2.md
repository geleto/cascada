# Cascada Internals: Implicit Concurrency and Asynchronous Handling

Cascada's core value proposition lies in its ability to handle asynchronous operations (like database queries, API calls, or computationally intensive tasks represented by Promises, async functions, or async iterators) within templates and scripts *without* requiring explicit `async` or `await` keywords from the template author. It achieves this through a sophisticated compilation strategy and runtime system designed for **enabling automatic concurrency** and **state synchronization**, ensuring that results are identical to sequential execution while maximizing performance where possible.

This document dives into the internal mechanisms that make this seamless experience possible.

## The Core Challenge: Concurrency with Sequential Equivalence

Modern applications frequently involve asynchronous operations. Integrating these into a templating engine traditionally requires careful manual management using `async/await` or callbacks, adding complexity to template logic. Cascada aims to eliminate this burden.

The challenge is twofold:

1.  **Enable Concurrency:** Allow potentially asynchronous operations to start execution without blocking the main template flow, enabling parallelism where operations don't have direct dependencies.
2.  **Guarantee Correctness:** Ensure that despite potential parallel execution, the final output and the state of variables are exactly the same as if all operations had been executed strictly one after another (sequential equivalence). This involves correctly handling dependencies and synchronizing access to shared variables modified by concurrent operations.

Cascada addresses this through a combination of compile-time analysis and a specialized runtime environment.

## Pillar 1: Transparent Asynchronicity via Universal Promise Handling

The foundation of Cascada's async support is its ability to treat Promises and other asynchronous constructs as first-class citizens throughout the engine, without special syntax.

*   **Input Flexibility:** Context variables passed to the template, functions called from the template, filters, and extensions can all return Promises or be `async` functions. Loops can operate directly on async iterators (`Symbol.asyncIterator`).
*   **Internal Operations:** All internal engine operations, from variable lookups (`runtime.memberLookupAsync`) and function calls (`runtime.callWrap` with async targets) to comparisons and arithmetic operations, are designed to implicitly handle potential Promise inputs. They use runtime helpers like `runtime.resolveAll`, `runtime.resolveDuo`, `runtime.resolveSingle` to wait for values only when strictly necessary for the operation itself.
*   **Deferred Resolution:** The engine aims to avoid resolving Promises prematurely. A Promise might be assigned to a variable or passed through several operations before its actual value is required (e.g., for outputting to the template or as a resolved operand in a calculation). This lazy resolution is key to allowing other operations to proceed concurrently. (See Limitations section regarding current array/object literal handling).

## Pillar 2: The Parallel Execution Engine - Async Blocks

Cascada enables concurrency by compiling potentially asynchronous sections of the template into self-contained units called "Async Blocks." It doesn't explicitly *identify* independent operations beforehand, but rather structures the code so that independence can lead to parallelism.

*   **IIFE Closures:** At the core, each async block in the generated JavaScript code is typically wrapped in an Immediately Invoked Function Expression (IIFE), specifically an `async` IIFE:
    ```javascript
    // Simplified conceptual representation
    (async (astate, frame) => {
      try {
        // ... compiled template code for the block ...
        // This code might contain internal 'await's for its own operations
        // or for dependency synchronization managed by the runtime.
      } catch (e) {
        // Handle errors, usually reporting back via a callback or context
      } finally {
        // Signal completion to the runtime state tracker
        astate.leaveAsyncBlock();
      }
    })(astate.enterAsyncBlock(), frame.pushAsyncBlock(...));
    ```
*   **Non-Blocking Execution:** The `async` IIFE is *called* immediately. Because it's `async`, the call *returns* a Promise almost instantly, *before* the asynchronous operations *within* the IIFE have completed. This allows the main template execution flow to continue processing subsequent code that doesn't depend on this block's result, effectively enabling concurrency.
*   **Runtime State Tracking (`astate`):** A runtime state object (represented conceptually as `astate`) tracks the number of active, pending async blocks using `enterAsyncBlock` and `leaveAsyncBlock`. The final rendering process waits until all initiated blocks have signaled completion (`astate.waitAllClosures`).
*   **Concurrent Resolution Points:** Parallelism emerges naturally when multiple `async` IIFEs are initiated without awaiting each other. Explicit concurrent resolution occurs when multiple inputs are needed for a single operation:
    *   **Function/Macro/Filter/Tag Arguments:** Arguments are often evaluated concurrently using helpers like `runtime.resolveAll`. The operation itself (the function call, filter application, etc.) proceeds only after all required arguments have resolved.
    *   **Expression Operands:** Operands in expressions (binary ops like `+`, `&&`, comparisons like `==`, `>`) can resolve concurrently using `runtime.resolveDuo` or `runtime.resolveAll` for multiple operands. The operation using these operands waits for them to resolve.
    *   **Literals (Current Limitation):** *Currently*, elements within Array literals (`[...]`) and values within Object literals (`{...}`) are resolved concurrently using `runtime.resolveAll` or `runtime.resolveObjectProperties` *before* the structure is finalized. This ensures the structure contains resolved values but is inefficient as it prevents deferred resolution of individual elements (See Limitations section).
    *   **Template Composition:**
        *   Loading: Includes (`include`), Imports (`import`), and Parent Templates (`extends`) involve asynchronously loading the template definition (`_compileGetTemplate` often returns a Promise).
        *   Rendering: The actual *rendering* of the loaded template typically occurs within its own async block (`_emitAsyncBlockAddToBuffer`, `_emitAsyncBlockValue`). This allows the rendering of the included/parent/imported template to proceed concurrently with other independent logic in the calling template. For example, `{% include "header.njk" %}` might start loading and rendering `header.njk` while the code following the include tag continues to execute if it doesn't depend on the header's output.

## Pillar 3: Maintaining Sequential Equivalence - State and Output

Executing operations concurrently introduces challenges in maintaining the correct output order and variable state. Cascada employs several key mechanisms:

### 1. Promise-Based Data Flow

As mentioned, variables can hold Promises directly. Resolution is deferred until the value is truly needed, typically for output or as an input to an operation that requires a concrete value.

```javascript
{% set potentiallyAsyncValue = someAsyncFunction() %} // 'potentiallyAsyncValue' holds a Promise immediately
{{ potentiallyAsyncValue }} // Promise is resolved (awaited internally) only here when output needed
```

This applies universally: macro arguments, import results, loop variables – they can all be Promises flowing through the system until resolution is required.

### 2. Tree-Structured Output Buffer

Instead of appending output strings to a single linear buffer (which would be prone to race conditions in parallel scenarios), Cascada uses a hierarchical buffer to preserve output order.

*   **Hierarchical Arrays:** The buffer is conceptually a tree structure, implemented using nested JavaScript arrays.
*   **Dedicated Branches:** Each async block (especially those generated by `_emitAsyncBlockBufferNodeBegin`) typically writes its output to its *own* array branch within this tree. Independent blocks write to different branches concurrently without conflict.
*   **Preserving Order:** The *position* of a sub-buffer array within its parent array preserves the correct sequential order relative to sibling blocks and surrounding static content. The order is determined by when the async block *started* execution in the template flow, not when it *finished*.
*   **Final Flattening:** After all async blocks have completed (`astate.waitAllClosures`), the entire buffer tree is recursively flattened (`runtime.flattentBuffer`) into the final output string, respecting the structure established during parallel execution.
*   **(Future/Scripting) Data Assembly Ordering:** This same mechanism ensures sequential ordering for `print` statements. While not currently implemented in the core templating engine for data manipulation, the *plan* for Cascada Script's Data Assembly Commands (`put`, `merge`, `push`) is to leverage a similar structured approach (likely operating on a parallel data structure) to ensure that data modifications appear in the final result object in the same order they were specified in the script, irrespective of underlying async operation completion times.

### 3. Frame State Preservation (Snapshots)

Async blocks execute potentially *after* the surrounding code has moved on. To ensure that code within an async block sees the correct variable values *as they were when the block was initiated*, a snapshot mechanism is used.

*   **`pushAsyncBlock` Initiation:** When an async block begins execution at runtime (`frame.pushAsyncBlock`), it receives information from the compiler about which variables it might *read* (`reads`) and which outer-scope variables it might *write* (`writeCounters`).
*   **`_snapshotVariables`:** For variables that are only *read* within the block (or read before being written), their current values are copied from the parent frame into the new async block frame's `asyncVars` dictionary. This captures the state at the moment the async operation was launched.
*   **Isolation:** Code inside the async block primarily interacts with its own `AsyncFrame` and its `asyncVars` snapshot, ensuring it's unaffected by later modifications in parent scopes that might occur *while* the async block is running.

## Pillar 4: Variable Synchronization via Promisification and Counting

This is the most critical mechanism for ensuring correct variable state when multiple concurrent async blocks might modify the same variable declared in an outer scope. It combines compile-time prediction with runtime reference counting and Promises to delay reads until writes are complete.

**Purpose:** When an async block might modify a shared variable, we can't let other concurrent operations (or later sequential operations) read that variable's potentially stale value. This mechanism replaces the variable in outer scopes with a Promise that only resolves to the final, correct value *after* all relevant async blocks have finished contributing to it.

1.  **Compile-Time Analysis (Predicting Writes):**
    *   **Tracking Usage:** The compiler analyzes the template, tracking variable declarations (`declaredVars`), reads (`readVars`), and potential writes within each scope (especially across async boundaries).
    *   **Calculating `writeCounts`:** For each scope that could execute asynchronously (loops, conditionals, includes, etc.), the compiler determines which variables declared in *outer* scopes might be modified within that scope or its children. It calculates a `writeCounts` map `{ varName: count }`, estimating the *maximum potential number* of times each outer variable could be written to by that async block and its descendants. **Crucially, this includes writes within all conditional branches (e.g., both `if` and `else`)**, even those that might not be taken at runtime.
    *   **Embedding Information:** This `writeCounts` map (along with the `readVars` set) is embedded into the generated code, typically passed as arguments when an async block's runtime frame is created (`frame.pushAsyncBlock(reads, writeCounters)`).

2.  **Runtime: Entering an Async Block (`pushAsyncBlock`):**
    *   **Frame Creation:** A new `AsyncFrame` is created for the async block.
    *   **Snapshotting Reads (`_snapshotVariables`):** Variables identified only for *reading* (`reads`) have their current values captured (as described in Pillar 3).
    *   **Promisification (`_promisifyParentVariables`):** This is the core synchronization step for variables that might be *written* to:
        *   The `writeCounters` map passed from the compiled code is stored on the new frame.
        *   For each variable `varName` listed in `writeCounters`:
            *   Its current value is also snapshotted into the new frame's `asyncVars`. This captured value is used for operations *within* the block.
            *   A **new Promise** is created for this variable.
            *   The `resolve` function for this promise is stored in the frame's `promiseResolves` map.
            *   **Crucially:** The variable's entry in the *parent frame's* `variables` (or `asyncVars` if the parent is also an async block) is **replaced with this new Promise**.
        *   **Effect:** Any code *outside* this async block attempting to read `varName` now receives the Promise. It cannot access the actual value until the promise resolves. The intermediate value is held within the async block's `asyncVars`.

3.  **Runtime: Performing a Write (`frame.set(name, val, true)`):**
    *   **Scope Identification:** The `set` operation first identifies the frame (`scopeFrame`) where the variable `name` was originally declared.
    *   **Local Update:** The new `val` is stored in the *current* async block's `asyncVars[name]`. It does *not* immediately update the parent's Promise or the variable in the `scopeFrame`.
    *   **Decrementing the Count (`_countdownAsyncWrites`):**
        *   The `writeCounters[name]` on the *current* frame is decremented.
        *   **Propagation:** This decrement action propagates *upwards* through the parent `AsyncFrame` chain towards the `scopeFrame`.
        *   **Completion Check:** If a frame's counter for `name` reaches zero after decrementing, it signifies that *this specific async block* (and all its children contributing to this variable) has completed all its potential writes to `name`. It then:
            *   Calls `_resolveAsyncVar(name)` to resolve the promise associated with this block's modification of the variable (using the final value from its `asyncVars`).
            *   Continues propagating a single "completed write" count upwards to the next parent frame.
        *   **Stopping Condition:** Propagation stops if an ancestor frame's counter does *not* reach zero, indicating other pending writes are still expected within that ancestor's scope (e.g., from a sibling async block).

4.  **Runtime: Handling Skipped Branches (`skipBranchWrites`):**
    *   When conditional logic (`if`, `switch`) results in a branch *not* being executed at runtime, `skipBranchWrites` is called with the pre-calculated `writeCounts` of that **skipped branch**.
    *   It effectively calls `_countdownAsyncWrites` for each variable and its corresponding count from the skipped branch. This ensures that the counters are correctly decremented even for writes that *didn't happen*, preventing the system from waiting indefinitely for non-existent writes and allowing the Promises to resolve correctly.

5.  **Runtime: Resolving the Variable (`_resolveAsyncVar`):**
    *   **Trigger:** Called by `_countdownAsyncWrites` when a variable's write counter reaches zero for the current `AsyncFrame`.
    *   **Get Final Value:** Retrieves the variable's final value from the *current frame's* `asyncVars`. This reflects the last write performed within this block or its children.
    *   **Resolve Promise:** Uses the `resolve` function stored in `promiseResolves` to fulfill the Promise that was placed in the parent scope, passing the final value. If the final value is itself a promise (due to nested async operations), it chains the resolution.
    *   **Unlocking Reads:** Fulfilling the Promise makes the final, correct value available to any external code (in other concurrent blocks or later sequential code) that was effectively `await`ing it (by operating on the Promise).

**Outcome of Synchronization:** This counting and promisification mechanism guarantees that a variable modified concurrently resolves only after *all* contributing async blocks (including those containing skipped branches) have finished their potential writes. This ensures the final value is consistent with sequential execution order, making the concurrent modifications safe.

## Compiler Implementation Details

The compiler plays a crucial role in setting up the structure for asynchronous execution.

*   **AST Transformation (`propagateIsAsync`):** Before compilation, the Abstract Syntax Tree (AST) is traversed. Each node is marked with an `isAsync = true` flag if it *or any of its children* represent potentially asynchronous operations. This flag determines whether the compiler generates synchronous or asynchronous code paths, including wrapping code in async blocks.
*   **Async Block Generation (`_emitAsyncBlock`, etc.):** When compiling a node marked `isAsync`, the compiler uses helper functions (`_emitAsyncBlock`, `_emitAsyncBlockBufferNodeBegin/End`, `_emitAsyncBlockValue`, `_emitAsyncBlockAddToBuffer`, `_emitAsyncBlockRender`) to wrap the generated code in the appropriate `async` IIFE structure. These helpers manage:
    *   Creating the `async` IIFE.
    *   Setting up `try...catch...finally` for error handling and cleanup (`astate.leaveAsyncBlock`).
    *   Initiating the runtime frame management (`frame.pushAsyncBlock(...)`) by passing the pre-calculated `reads` and `writeCounters`.
    *   Managing the hierarchical output buffer (`bufferStack`, `_pushBuffer`, `_popBuffer`).
    *   Tracking the nesting depth of async closures (`asyncClosureDepth`).
*   **Variable Tracking Integration:** The compiler's frame analysis (`_updateFrameWrites`, `_updateFrameReads`) computes the necessary `readVars` and `writeCounts` used at runtime for snapshotting and promisification.

## Runtime Implementation Details

The runtime (`runtime.js`) provides the classes and helper functions that execute the compiled code.

*   **`AsyncFrame`:** Extends the basic `Frame` to support async operations. Its key properties during runtime execution are:
    *   `asyncVars`: Stores snapshotted values and intermediate results during block execution.
    *   `writeCounters`: Tracks remaining expected writes (including from skipped branches) for variables being modified.
    *   `promiseResolves`: Stores the `resolve` functions for Promises created during promisification.
    The methods `pushAsyncBlock`, `_snapshotVariables`, `_promisifyParentVariables`, `_countdownAsyncWrites`, `skipBranchWrites`, and `_resolveAsyncVar` implement the state management and synchronization logic described above.
*   **`AsyncState` (Conceptual):** Manages the overall async execution state, primarily tracking the count of active async blocks (`enterAsyncBlock`, `leaveAsyncBlock`) and providing a mechanism to wait for all to complete (`waitAllClosures`).
*   **Buffer Management (`flattentBuffer`):** Recursively traverses the nested array buffer structure and concatenates the contents (resolving any embedded functions or Promises) into the final string output.
*   **Async Helpers:** Functions like `resolveAll`, `resolveDuo`, `resolveSingle`, `memberLookupAsync`, `iterate` (for async loops), `promisify`, etc., provide the building blocks for handling Promises implicitly within expressions and operations.

## Handling Specific Template Constructs

The core mechanisms are applied consistently across different template features:

*   **Control Flow (`if`, `for`, `switch`):**
    *   Conditionals (`if`, `switch`) use `_emitAsyncBlock` or `_emitAsyncBlockBufferNodeBegin/End` for their branches if they contain async operations. Crucially, the compiler calculates `writeCounts` for *all* potential branches. At runtime, `frame.skipBranchWrites` is used to decrement counts for the paths not executed, ensuring correct synchronization.
    *   Loops (`for`) handle async iterators via `runtime.iterate`. Each iteration can potentially run within its own async context, managed by the loop body's async block structure. This ensures correct variable scoping (`loop.index`, item variables) and synchronization per iteration. The loop structure itself might be wrapped in an `_emitAsyncBlockBufferNode` to manage its collective output and state.
*   **Template Composition (`include`, `extends`, `import`, `block`):**
    *   These tags inherently involve asynchronous operations (loading template files, rendering potentially async content).
    *   `compileInclude`, `compileExtends`, `compileImport` use `_compileGetTemplate` (which operates asynchronously) and wrap their rendering/integration logic within appropriate async blocks (`_emitAsyncBlockAddToBuffer`, `_emitAsyncBlockValue`).
    *   Context and frame information are carefully propagated. Variable synchronization via promisification/counting works across these boundaries when child/included templates modify parent variables (respecting scoping rules and requiring explicit dependency declarations where needed - see Limitations). `super()` calls within blocks (`compileSuper`) also handle async resolution correctly.
*   **Macros, Functions, Filters, Extensions:**
    *   Macros (`compileMacro`) can be async if their body contains async operations. The generated macro function handles its own async state and buffer internally, using `astate.waitAllClosures` before returning the final (potentially Promise-wrapped) `SafeString`.
    *   Function calls (`compileFunCall`) use `runtime.callWrap` and `runtime.resolveAll` (or `resolveDuo`/`resolveSingle`) to handle async functions and resolve arguments concurrently before the call.
    *   Filters (`compileFilter`, `compileFilterAsync`) can be async. `compileFilter` resolves the input value and any filter arguments concurrently before applying the filter function (which might itself be async). Legacy `filterasync` uses an internal callback-to-promise bridge.
    *   Extensions (`compileCallExtension`, `compileCallExtensionAsync`) handle async operations similarly, resolving arguments concurrently and potentially promisifying the extension method call if needed.

## Error Handling

Robust error handling is integrated into the async block structure:

*   **`try...catch...finally`:** The generated code for async blocks includes `try...catch` to capture errors occurring within the block's asynchronous operations.
*   **`runtime.handleError`:** Catches wrap errors using `runtime.handleError` to attach line number and context information.
*   **Propagation:** Errors are typically propagated back to the main execution context via the callback (`cb`) passed through the function chain or by rejecting the Promises returned by async blocks/operations. The top-level `astate.waitAllClosures()` will reject if any constituent block fails.
*   **Cleanup (`finally`):** The `finally` block ensures crucial cleanup like decrementing the async block counter (`astate.leaveAsyncBlock`) happens even if errors occur, preventing deadlocks.

## Known Limitations and Future Work

*   **Array/Object Literal Resolution:** Currently, all elements/values in template-defined array/object literals containing async operations are resolved concurrently *before* the structure is created. This prevents deferred resolution of individual items and can be inefficient, forcing unnecessary waits. Future work aims to allow Promises within these structures, resolving them only when accessed.
*   **Data Assembly Commands:** The core templating engine does not currently implement data assembly commands like `put`, `merge`, `push` found in Cascada Script. Integrating such features would require extending the output mechanism beyond the text-based tree buffer to manage structured data updates while maintaining sequential equivalence.
*   **Cross-Template Variable Dependencies:** Explicit declaration (`{% depends %}`) for mutable variables accessed across `include` or dynamic `extends` boundaries is planned but not yet fully implemented.
*   **New Tags:** Features like `{% try %}/{% resume %}/{% except %}`, `{% while %}`, and `{% do %}` are planned but not yet implemented.
*   **Performance Optimizations:** Further analysis and optimization of the compilation and runtime are ongoing to reduce overhead and improve parallel efficiency.

## Conclusion

Cascada's implicit concurrency model is a complex interplay between compile-time analysis (predicting async potential and write counts) and a specialized runtime (using async IIFEs, hierarchical buffers, frame snapshots, and promise-based variable synchronization). By automatically structuring code for non-blocking execution and meticulously managing state and output order, it achieves potential parallelism while rigorously maintaining sequential equivalence. This allows template authors to leverage asynchronous operations naturally without the boilerplate of manual async/await management, leading to cleaner templates and potentially significant performance gains in I/O-bound or computationally intensive scenarios.