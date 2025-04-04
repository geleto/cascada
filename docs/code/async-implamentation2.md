# Cascada Internals: Implicit Concurrency and Asynchronous Handling

Cascada's core value proposition lies in its ability to handle asynchronous operations (like database queries, API calls, or computationally intensive tasks represented by Promises, async functions, or async iterators) within templates and scripts *without* requiring explicit `async` or `await` keywords from the template author. It achieves this through a sophisticated compilation strategy and runtime system designed for **automatic parallelization** and **state synchronization**, ensuring that results are identical to sequential execution while maximizing concurrent performance.

This document dives into the internal mechanisms that make this seamless experience possible.

## The Core Challenge: Parallelism with Sequential Equivalence

Modern applications frequently involve asynchronous operations. Integrating these into a templating engine traditionally requires careful manual management using `async/await` or callbacks, adding complexity to template logic. Cascada aims to eliminate this burden.

The challenge is twofold:

1.  **Maximize Parallelism:** Identify and execute independent asynchronous operations concurrently whenever possible to improve performance.
2.  **Guarantee Correctness:** Ensure that despite parallel execution, the final output and the state of variables are exactly the same as if all operations had been executed strictly one after another (sequential equivalence). This involves correctly handling dependencies and synchronizing access to shared variables modified by concurrent operations.

Cascada addresses this through a combination of compile-time analysis and a specialized runtime environment.

## Pillar 1: Transparent Asynchronicity via Universal Promise Handling

The foundation of Cascada's async support is its ability to treat Promises and other asynchronous constructs as first-class citizens throughout the engine, without special syntax.

*   **Input Flexibility:** Context variables passed to the template, functions called from the template, filters, and extensions can all return Promises or be `async` functions. Loops can operate directly on async iterators (`Symbol.asyncIterator`).
*   **Internal Operations:** All internal engine operations, from variable lookups (`runtime.memberLookupAsync`) and function calls (`runtime.callWrap` with async targets) to comparisons and arithmetic operations, are designed to implicitly handle potential Promise inputs. They use runtime helpers like `runtime.resolveAll`, `runtime.resolveDuo`, `runtime.resolveSingle` to wait for values only when necessary.
*   **Deferred Resolution:** The engine avoids resolving Promises prematurely. A Promise might be assigned to a variable or passed through several operations before its actual value is required (e.g., for outputting to the template or as a resolved operand in a calculation). This lazy resolution is key to allowing other operations to proceed concurrently.

## Pillar 2: The Parallel Execution Engine - Async Blocks

Cascada achieves parallelism by compiling potentially asynchronous sections of the template into self-contained units called "Async Blocks."

*   **IIFE Closures:** At the core, each async block in the generated JavaScript code is typically wrapped in an Immediately Invoked Function Expression (IIFE), specifically an `async` IIFE:
    ```javascript
    // Simplified conceptual representation
    (async (astate, frame) => {
      try {
        // ... compiled template code for the block ...
        // This code might contain internal 'await's for operations
      } catch (e) {
        // Handle errors, usually reporting back via a callback or context
      } finally {
        // Signal completion to the runtime state tracker
        astate.leaveAsyncBlock();
      }
    })(astate.enterAsyncBlock(), frame.pushAsyncBlock(...));
    ```
*   **Non-Blocking Execution:** The `async` IIFE is *called* immediately, but because it's `async`, the call *returns* a Promise almost instantly, before the asynchronous operations *within* the IIFE have completed. This allows the main template execution flow to continue processing subsequent independent code without waiting.
*   **Runtime State Tracking (`astate`):** A runtime state object (represented conceptually as `astate`) tracks the number of active, pending async blocks using `enterAsyncBlock` and `leaveAsyncBlock`. The final rendering process waits until all initiated blocks have signaled completion (`astate.waitAllClosures`).
*   **Concurrent Resolution Points:** Parallelism is explicitly introduced at various points:
    *   **Arguments:** Arguments to functions, macros, filters, and tags are often evaluated concurrently using helpers like `runtime.resolveAll`.
    *   **Binary Operations:** Both sides of comparisons (`>`, `==`, etc.) and binary arithmetic/logical operations (`+`, `&&`, etc.) can resolve concurrently using `runtime.resolveDuo`.
    *   **Literals:** Elements within Array literals (`[...]`) and values within Object literals (`{...}`) are resolved concurrently before the structure is finalized (`runtime.resolveAll`, `runtime.resolveObjectProperties`).
    *   **Template Composition:** Includes, Imports, and Parent Templates in `extends` are loaded and processed asynchronously, often running in parallel with other template logic.

## Pillar 3: Maintaining Sequential Equivalence

Executing operations in parallel introduces challenges in maintaining the correct output order and variable state. Cascada employs several key mechanisms:

### 1. Promise-Based Data Flow

As mentioned, variables can hold Promises directly. Resolution is deferred until the value is truly needed, typically for output or as an input to an operation that requires a concrete value.

```javascript
{% set potentiallyAsyncValue = someAsyncFunction() %} // 'potentiallyAsyncValue' holds a Promise immediately
{{ potentiallyAsyncValue }} // Promise is resolved (awaited internally) only here when output needed
```

This applies universally: macro arguments, import results, loop variables – they can all be Promises flowing through the system until resolution is required.

### 2. Tree-Structured Output Buffer

Instead of appending output strings to a single linear buffer (which would be prone to race conditions in parallel scenarios), Cascada uses a hierarchical buffer.

*   **Hierarchical Arrays:** The buffer is conceptually a tree structure, implemented using nested JavaScript arrays.
*   **Dedicated Branches:** Each async block (especially those generated by `_emitAsyncBlockBufferNodeBegin`) typically writes its output to its *own* array branch within this tree. Independent blocks write to different branches concurrently without conflict.
*   **Preserving Order:** The *position* of a sub-buffer array within its parent array preserves the correct sequential order relative to sibling blocks and surrounding static content.
*   **Final Flattening:** After all async blocks have completed (`astate.waitAllClosures`), the entire buffer tree is recursively flattened (`runtime.flattentBuffer`) into the final output string, respecting the structure established during parallel execution.

### 3. Frame State Preservation (Snapshots)

Async blocks execute potentially *after* the surrounding code has moved on. To ensure that code within an async block sees the correct variable values *as they were when the block was initiated*, a snapshot mechanism is used.

*   **`pushAsyncBlock` Initiation:** When an async block begins execution at runtime (`frame.pushAsyncBlock`), it receives information from the compiler about which variables it might *read* (`reads`) and which outer-scope variables it might *write* (`writeCounters`).
*   **`_snapshotVariables`:** For variables that are only *read* within the block (or read before being written), their values are copied from the parent frame into the new async block frame's `asyncVars` dictionary. This captures the state at the moment the async operation was launched.
*   **Isolation:** Code inside the async block primarily interacts with its own `AsyncFrame` and its `asyncVars` snapshot, ensuring it's unaffected by later modifications in parent scopes that might occur *while* the async block is running.

### 4. Variable Synchronization and Resolution: The Counting Mechanism

This is the most critical mechanism for ensuring correct variable state when multiple concurrent operations modify the same variable. It combines compile-time prediction with runtime reference counting.

1.  **Compile-Time Analysis (Predicting Writes):**
    *   **Tracking Usage:** The compiler analyzes the template, tracking variable declarations (`declaredVars`), reads (`readVars`), and potential writes within each scope (especially across async boundaries).
    *   **Calculating `writeCounts`:** For each scope that could execute asynchronously (loops, conditionals, includes, etc.), the compiler determines which variables declared in *outer* scopes might be modified within that scope or its children. It calculates a `writeCounts` map `{ varName: count }`, estimating the *maximum potential number* of times each outer variable could be written to by that async block and its descendants. This includes writes within conditional branches that might not be taken at runtime.
    *   **Embedding Information:** This `writeCounts` map (along with the `readVars` set) is embedded into the generated code, typically passed as arguments when an async block's runtime frame is created (`frame.pushAsyncBlock(reads, writeCounters)`).

2.  **Runtime: Entering an Async Block (`pushAsyncBlock`):**
    *   **Frame Creation:** A new `AsyncFrame` is created for the async block.
    *   **Snapshotting Reads (`_snapshotVariables`):** Variables identified only for *reading* (`reads`) have their current values captured from the parent scope and stored in the new frame's `asyncVars`. This ensures consistent reads *within* the block, using the value present when the block started.
    *   **Promisification (`_promisifyParentVariables`):** This is the core synchronization step for variables that might be *written* to:
        *   The `writeCounters` map passed from the compiled code is stored on the new frame.
        *   For each variable listed in `writeCounters`:
            *   Its current value is also snapshotted into the new frame's `asyncVars`.
            *   A **new Promise** is created for this variable.
            *   The `resolve` function for this promise is stored in the frame's `promiseResolves` map.
            *   **Crucially:** The variable's entry in the *parent frame's* `variables` (or `asyncVars` if the parent is also an async block) is **replaced with this new Promise**.
        *   **Effect:** Any code *outside* this async block attempting to read the variable now receives the Promise. The actual value is temporarily held within the async block's frame.

3.  **Runtime: Performing a Write (`frame.set(name, val, true)`):**
    *   **Scope Identification:** The `set` operation first identifies the frame (`scopeFrame`) where the variable `name` was originally declared.
    *   **Local Update:** The new `val` is stored in the *current* async block's `asyncVars[name]`. It does *not* immediately update the parent's Promise or the variable in the `scopeFrame`.
    *   **Decrementing the Count (`_countdownAsyncWrites`):**
        *   The `writeCounters[name]` on the *current* frame is decremented.
        *   **Propagation:** This decrement action propagates *upwards* through the parent `AsyncFrame` chain towards the `scopeFrame`.
        *   **Completion Check:** If a frame's counter for `name` reaches zero after decrementing, it signifies that *this specific async block* has completed all its expected writes to `name`. It then:
            *   Calls `_resolveAsyncVar(name)` to resolve the promise associated with this block's modification of the variable.
            *   Continues propagating a single "completed write" count upwards.
        *   **Stopping Condition:** Propagation stops if a frame's counter does *not* reach zero, indicating other pending writes are still expected within that ancestor's scope.

4.  **Runtime: Handling Skipped Branches (`skipBranchWrites`):**
    *   When conditional logic (`if`, `switch`) results in a branch *not* being executed, `skipBranchWrites` is called with the pre-calculated `writeCounts` of the skipped branch.
    *   It effectively calls `_countdownAsyncWrites` for these "missed" writes. This ensures that the counters are correctly decremented even for writes that didn't happen, preventing the system from waiting indefinitely.

5.  **Runtime: Resolving the Variable (`_resolveAsyncVar`):**
    *   **Trigger:** Called by `_countdownAsyncWrites` when a variable's count reaches zero for the current `AsyncFrame`.
    *   **Get Final Value:** Retrieves the variable's final value from the *current frame's* `asyncVars`. This is the value determined by the last write within this block.
    *   **Resolve Promise:** Uses the `resolve` function stored in `promiseResolves` to fulfill the Promise that was placed in the parent scope, passing the final value. If the final value is itself a promise (due to nested async operations), it chains the resolution.
    *   **Unlocking Reads:** Fulfilling the Promise makes the final, correct value available to any external code that was `await`ing it or using `.then`.

**Outcome of Synchronization:** This counting and promisification mechanism guarantees that a variable modified concurrently resolves only after *all* contributing async blocks have finished their potential writes, making the final value consistent with sequential execution order.

## Compiler Implementation Details

The compiler plays a crucial role in setting up the structure for asynchronous execution.

*   **AST Transformation (`propagateIsAsync`):** Before compilation, the Abstract Syntax Tree (AST) is traversed. Each node is marked with an `isAsync = true` flag if it *or any of its children* represent potentially asynchronous operations (like calling an async function, using an async filter, including a template, or operating on a variable that might be a Promise). This flag determines whether the compiler generates synchronous or asynchronous code paths.
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
    *   `writeCounters`: Tracks remaining expected writes for variables being modified.
    *   `promiseResolves`: Stores the `resolve` functions for Promises created during promisification.
    The methods `pushAsyncBlock`, `_snapshotVariables`, `_promisifyParentVariables`, `_countdownAsyncWrites`, `skipBranchWrites`, and `_resolveAsyncVar` implement the state management and synchronization logic described above.
*   **`AsyncState` (Conceptual):** Manages the overall async execution state, primarily tracking the count of active async blocks (`enterAsyncBlock`, `leaveAsyncBlock`) and providing a mechanism to wait for all to complete (`waitAllClosures`).
*   **Buffer Management (`flattentBuffer`):** Recursively traverses the nested array buffer structure and concatenates the contents (resolving any embedded functions or Promises) into the final string output.
*   **Async Helpers:** Functions like `resolveAll`, `resolveDuo`, `resolveSingle`, `memberLookupAsync`, `iterate` (for async loops), `promisify`, etc., provide the building blocks for handling Promises implicitly within expressions and operations.

## Handling Specific Template Constructs

The core mechanisms are applied consistently across different template features:

*   **Control Flow (`if`, `for`, `switch`):**
    *   Conditionals (`if`, `switch`) use `_emitAsyncBlock` or `_emitAsyncBlockBufferNodeBegin/End` for their branches. Crucially, the compiler calculates `writeCounts` for *both* taken and untaken branches, and `frame.skipBranchWrites` is used at runtime to decrement counts for the paths not executed, ensuring correct synchronization.
    *   Loops (`for`) handle async iterators via `runtime.iterate`. Each iteration potentially runs within its own async context (often managed by the loop body's async block structure), ensuring correct variable scoping (`loop.index`, item variables) and synchronization per iteration. The loop structure itself might be wrapped in an `_emitAsyncBlockBufferNode` to manage its collective output and state.
*   **Template Composition (`include`, `extends`, `import`, `block`):**
    *   These tags inherently involve asynchronous operations (loading template files).
    *   `compileInclude`, `compileExtends`, `compileImport` use `_compileGetTemplate` (which can operate asynchronously) and wrap their rendering/integration logic within appropriate async blocks (`_emitAsyncBlockAddToBuffer`, `_emitAsyncBlockValue`).
    *   Context and frame information are carefully propagated to maintain variable visibility and state consistency across template boundaries. `super()` calls within blocks (`compileSuper`) also handle async resolution correctly.
*   **Macros, Functions, Filters, Extensions:**
    *   Macros (`compileMacro`) can be async if their body contains async operations. The generated macro function handles its own async state and buffer internally, potentially using `astate.waitAllClosures` before returning the final (potentially Promise-wrapped) `SafeString`.
    *   Function calls (`compileFunCall`) use `runtime.callWrap` and `runtime.resolveAll` to handle async functions and resolve arguments concurrently.
    *   Filters (`compileFilter`, `compileFilterAsync`) can be async. Regular async filters resolve arguments and the filter function concurrently. `filterasync` (legacy) uses a callback pattern internally bridged to the promise system.
    *   Extensions (`compileCallExtension`, `compileCallExtensionAsync`) handle async operations similarly, resolving arguments and potentially promisifying the extension method call.

## Error Handling

Robust error handling is integrated into the async block structure:

*   **`try...catch...finally`:** The generated code for async blocks includes `try...catch` to capture errors occurring within the block's asynchronous operations.
*   **`runtime.handleError`:** Catches wrap errors using `runtime.handleError` to attach line number and context information.
*   **Propagation:** Errors are typically propagated back to the main execution context via the callback (`cb`) passed through the function chain or by rejecting the Promises returned by async blocks/operations.
*   **Cleanup (`finally`):** The `finally` block ensures crucial cleanup like decrementing the async block counter (`astate.leaveAsyncBlock`) happens even if errors occur.

## Conclusion

Cascada's implicit concurrency model is a complex interplay between compile-time analysis and a specialized runtime. By automatically wrapping asynchronous operations in non-blocking blocks, using a hierarchical buffer for output, and implementing a sophisticated variable snapshotting and reference counting system (promisification with `writeCounters`), it achieves high levels of parallelism while rigorously maintaining sequential equivalence. This allows template authors to leverage asynchronous operations naturally without the boilerplate of manual async/await management, leading to cleaner templates and potentially significant performance gains.
