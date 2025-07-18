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
4.  **State Synchronization:** Implement mechanisms (variable snapshots and a promise-based two-level counting system) to ensure that variable reads and writes behave as if they occurred sequentially, even when executed concurrently.
5.  **Ordered Output Buffering:** Use a hierarchical buffer to ensure final output (text, and planned for data) reflects the template's logical structure, not the unpredictable completion order of async tasks.

## Mechanism 1: Universal & Deferred Asynchronicity

The foundation of Cascada's async support is its ability to treat Promises and other asynchronous constructs as first-class citizens throughout the engine, without special syntax, and resolving them as late as possible.

*   **Input Flexibility:** Context variables passed to the template, functions called from the template, filters, and extensions can all return Promises or be `async` functions. Loops can operate directly on async iterators (`Symbol.asyncIterator`).
*   **Internal Operations:** All internal engine operations, from variable lookups (`runtime.memberLookupAsync`) and function calls (`runtime.callWrap` with async targets) to comparisons and arithmetic operations, are designed to implicitly handle potential Promise inputs. They use runtime helpers like `runtime.resolveAll`, `runtime.resolveDuo`, `runtime.resolveSingle` to wait for values only when strictly necessary *for the specific operation itself*.
*   **Deferred Resolution:** Cascada delays resolving Promise-based variables until their concrete value is absolutely essential. This "just-in-time" resolution occurs immediately before an operation requires the actual value, such as:
    1.  **Passing arguments to a function/macro/filter:** All arguments must be resolved before the function logic can execute.
    2.  **Evaluating operands in an expression:** Both sides of `a + b` or `x > y` need concrete values before the operation can be performed.
    3.  **Outputting a value:** The value must be resolved to a primitive (or `SafeString`) before it can be added to the output buffer.
    4.  **Accessing properties/indices:** The target object/array (`obj` in `obj.prop`) must be resolved before lookup.

Runtime helpers like `runtime.resolveAll`, `runtime.resolveDuo`, `runtime.resolveSingle`, and `runtime.memberLookupAsync` orchestrate this resolution, often concurrently fetching multiple needed values.

Crucially, even after resolving its *inputs*, the operation itself (like a function call, expression evaluation, or member lookup) might still return a *new Promise*, allowing the asynchronous flow to continue seamlessly without premature blocking. The system avoids `await`ing values until the precise moment they are needed for the next step. (See Limitations section regarding current array/object literal handling).

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
*   **Runtime State Tracking (`astate`):** A runtime state object (conceptually `astate`) tracks the overall progress of concurrent operations.
    *   `enterAsyncBlock()`: Increments a counter of active async blocks when an IIFE starts.
    *   `leaveAsyncBlock()`: Decrements the counter when an IIFE finishes (in the `finally` block, ensuring it runs even on error).
    *   `waitAllClosures()`: Returns a Promise that resolves only when the active block counter reaches zero (or a specified target count). The main rendering process awaits this promise before finalizing the output, ensuring all concurrent work is done.
*   **Internal Synchronization with `waitAllClosures`:** Beyond the final wait at the root level, `astate.waitAllClosures()` is also crucial *within* the execution flow for local synchronization.
    *   **Mechanism:** When an async block needs to wait for its own spawned children (other async blocks it directly initiated), it typically uses `await astate.waitAllClosures(1)`. The `1` signifies waiting until the active closure count drops back to one, meaning only the waiting block itself remains active in its branch of execution.
    *   **Purpose:** This internal waiting ensures sequential correctness and proper data handling in scenarios like:
        *   **Data Aggregation:** `{% capture %}` or `{% macro %}` must wait for their async bodies to complete before finalizing their result.
        *   **Sequential Loops:** `{% for %}` loops modifying shared variables might run iterations sequentially, using an internal wait to ensure one iteration's async work finishes before the next starts.
        *   **Dependent Content:** Custom tags receiving async content may need to wait for that content to render fully before processing it.
*   **Concurrent Resolution Points:** Parallelism emerges naturally when multiple `async` IIFEs are initiated without awaiting each other. Explicit concurrent resolution occurs when multiple potentially async inputs are needed for a single operation, using runtime helpers:
    *   **Function/Macro/Filter/Tag Arguments:** Arguments are often evaluated concurrently using `runtime.resolveAll`. The operation itself waits for all arguments to resolve.
    *   **Expression Operands:** Operands in expressions (e.g., `a + b`, `x > y`) can resolve concurrently using `runtime.resolveDuo` or `runtime.resolveAll`. The operation using them waits for resolution.
    *   **Literals (Current Limitation):** *Currently*, elements within Array literals (`[...]`) and values within Object literals (`{...}`) are resolved concurrently using `runtime.resolveAll` or `runtime.resolveObjectProperties` *before* the structure is finalized. (See Limitations).
    *   **Template Composition:** Includes (`include`), Imports (`import`), and Parent Templates (`extends`) involve asynchronously loading the template definition (`env.getTemplate` is async). The rendering of the loaded template then typically occurs within its own async block, allowing it to run concurrently with other independent logic in the caller.

**Async Iterator Loop Body Parallelism:**
When iterating over asynchronous iterators (`Symbol.asyncIterator`) or standard collections within an async context, Cascada fundamentally attempts to process **each loop iteration concurrently**. As soon as the next value becomes available from the iterator (or the collection element is accessed), the engine initiates the processing for that iteration's body, potentially overlapping with previous iterations that haven't finished yet. This allows iterations to run in parallel, maximizing throughput for independent iteration bodies. However, as detailed under *Loop Variable Synchronization*, if the loop body modifies variables outside its immediate scope, the engine may enforce sequential execution for that specific loop to guarantee data consistency.

**Granularity of Async Blocks:**
Cascada achieves non-blocking execution by wrapping potentially asynchronous *operations* within async IIFEs in the compiled code. This wrapping isn't necessarily done per-tag, but rather around the specific function calls, filter applications, expression evaluations, or rendering tasks (like includes) that might be asynchronous. The fundamental effect is that initiating such an operation returns a Promise quickly, allowing subsequent independent operations in the template to begin execution without waiting for the first one to complete. The compiler determines the necessary boundaries for these blocks based on the template structure and the potential async nature of the operations involved.

## Mechanism 3: Ensuring Sequential Equivalence - Output Order

Executing operations concurrently requires a mechanism to ensure the final output matches the order defined in the template, not the random order of completion.

*   **Tree-Structured Output Buffer:** Instead of appending output strings to a single linear buffer (prone to race conditions), Cascada uses a hierarchical buffer.
    *   **Hierarchical Arrays:** The buffer is implemented as nested JavaScript arrays.
    *   **Dedicated Branches:** Each async block that produces output (often using `_emitAsyncBlockBufferNodeBegin`) writes to its *own* sub-array within this tree. Independent blocks write to different branches concurrently without conflict.
    *   **Preserving Order:** The *position* where a sub-buffer array is inserted into its parent array is determined by the *start* time of the async block in the template's logical flow. This preserves the correct sequential order relative to sibling blocks and surrounding static content.
    *   **Final Flattening:** After `astate.waitAllClosures()` resolves (all blocks done), the entire buffer tree is recursively flattened (`runtime.flattenBuffer`) into the final output string, respecting the structure established during parallel execution.
*   **(Future/Scripting) Data Assembly Ordering:** This same principle of ordered insertion into a structure based on initiation sequence (not completion) is planned for Cascada Script's Data Assembly Commands (`put`, `merge`, `push`). They will operate on a parallel data structure (instead of the text buffer) to ensure data modifications appear in the final result object in the same order they were specified in the script, providing predictable data construction despite concurrency. (This is not yet implemented in the core engine).

### SafeString Interaction in Async Contexts

Cascada ensures that Nunjucks' `SafeString` mechanism for controlling auto-escaping works correctly even when the underlying value is generated asynchronously, while still preserving the correct output order. It achieves this by **deferring the final processing**, including `SafeString` wrapping, until the very last stage of output generation.

Here's the fundamental approach:

1.  **Placeholders in the Buffer:** When an operation results in a value that needs special handling like being marked safe (or suppressed/escaped), especially if that value is asynchronous (a Promise), Cascada doesn't immediately resolve the Promise or wrap the value. Instead, it often places a **placeholder** into the hierarchical output buffer. This placeholder is frequently a **function**.
2.  **Deferred Processing Function:** This function encapsulates the logic for the final processing step (e.g., wrapping the resolved value in `SafeString`). Runtime helpers like `runtime.newSafeStringAsync` (when operating on array-like buffers), `runtime.suppressValueAsync`, and `runtime.ensureDefinedAsync` utilize this pattern by adding such processing functions to the buffer array.
3.  **Final Assembly by `flattenBuffer`:** During the final output generation phase, `runtime.flattenBuffer` traverses the hierarchical buffer. When it encounters:
    *   **Promises:** It awaits their resolution to get the concrete string value.
    *   **Processing Functions:** *After* processing the preceding items in its current buffer segment (which might involve resolving Promises and concatenating strings), it calls the processing function, passing the accumulated string segment (`acc`) to it. The function then performs its designated action (like wrapping `acc` in `SafeString`) and returns the final, processed string (or the `SafeString` object whose value is then used).

**Outcome:** This strategy cleverly delays the final wrapping/processing until the underlying asynchronous value has been resolved *and* its position relative to other output fragments is finalized within the buffer structure. It allows the engine to maintain deferred resolution for performance while guaranteeing that `SafeString` semantics are correctly applied in the final, sequentially assembled output string. The buffer acts not just as a storage for strings and Promises, but also as a queue for deferred final processing steps.

## Mechanism 4: Ensuring Sequential Equivalence - Variable State

This is the most complex part, ensuring variable reads/writes are consistent despite concurrency. It involves two related techniques:

### 4a. Frame State Preservation (Snapshots)

Async blocks execute potentially *after* the surrounding code has moved on. A block needs to see variable values *as they were when it was initiated*.

*   **`pushAsyncBlock` Initiation:** When an async block starts (`frame.pushAsyncBlock`), the compiler provides info on variables it might *read* (`reads`) and *write* (`writeCounters`).
*   **`_snapshotVariables`:** For variables only *read* within the block (or read before being written), their current values are copied from the parent frame into the new async block frame's `asyncVars` dictionary. This captures the state at launch time.
*   **Isolation:** Code inside the async block primarily interacts with its own `AsyncFrame` and its `asyncVars` snapshot, protecting it from later modifications in parent scopes that might occur *while* the async block is running.

### 4b. Variable Synchronization: Ensuring Order with a Two-Level Tracking System

While snapshots handle reading the correct initial state, ensuring consistency when multiple concurrent async blocks might *write* to the same outer-scope variable requires a more sophisticated synchronization mechanism. Cascada addresses this using a **two-level tracking system** based on **Promises as locks** and meticulous **reference counting**.

**Purpose:** To prevent reads of potentially incorrect or intermediate values during concurrent execution and guarantee that the final state of variables matches sequential execution logic. When an async block *might* modify a shared variable `x`, this mechanism temporarily replaces `x` in the outer scope with a Promise. This Promise acts as a lock, delaying any reads until it resolves. Crucially, it only resolves to the final, correct value *after all potential concurrent writes* to `x` are guaranteed to be finished or accounted for across all relevant async blocks.

**Core Strategy:**

1.  **Locking with Promises:** Variables potentially modified concurrently are "locked" in their outer scope by replacing their value with a Promise. Reads must wait for this Promise to resolve.
2.  **Two-Level Counting:**
    *   **Child Block Internal Tracking:** Each async block independently tracks its *own* progress towards completing writes to a specific outer variable.
    *   **Parent Block Aggregate Tracking:** The parent block tracks the overall completion status for a variable based on signals received from its children and its own direct writes.
3.  **Signaling Completion:** When a child block finishes all its potential modifications to a variable, it resolves the parent's Promise (unlocking reads) and sends a single "I'm done" signal upwards.

**Mechanism Details:**

1.  **Compile-Time Analysis (Predicting Writes):**
    *   **Tracking Usage:** The compiler analyzes the Abstract Syntax Tree (AST) to track variable declarations (`declaredVars`), reads (`readVars`), and potential writes across scopes.
    *   **Calculating `writeCounts`:** For each scope that could become an async block, the compiler determines which outer-scope variables might be modified within it or any of its descendant blocks. It calculates a `writeCounts` map `{ varName: count }`. **Critically, this `count` represents the *maximum potential number* of writes, summing counts across *all* conditional branches (e.g., both `if` AND `else`, all `switch` cases)**. This anticipates paths not taken at runtime, ensuring correctness regardless of the execution flow.
    *   **Embedding Information:** The calculated `readVars` set and `writeCounts` map are embedded in the compiled code and passed to the runtime frame setup function (`frame.pushAsyncBlock(reads, writeCounters)`).

2.  **Runtime: Entering an Async Block (`pushAsyncBlock(reads, writeCounters)`):**
    *   **Frame Creation:** A new `AsyncFrame` is created for the block.
    *   **Snapshotting Reads (`_snapshotVariables`):** Variables listed in `reads` (and those in `writeCounters`) have their current values snapshotted from the parent frame into the new frame's `asyncVars` dictionary. This provides the correct initial state for reads *within* the block.
    *   **Promisification (`_promisifyParentVariables`):** For each variable listed in the incoming `writeCounters`:
        *   The `writeCounters` map is stored on the new `AsyncFrame` to track internal progress.
        *   A **new Promise** is created for the variable. Its `resolve` function is stored in the new frame's `promiseResolves` map.
        *   **Crucially:** The variable's entry in the *parent frame's* storage (`variables` or `asyncVars`) is **replaced with this new Promise**. This acts as the lock.
        *   **Effect:** Any attempt to read this variable from the outer scope (or sibling scopes) now receives the Promise, forcing them to wait until it resolves.

3.  **Runtime: Tracking Work Within the Child Block:**
    *   The async block's internal `writeCounters` (initialized in the previous step) holds the maximum potential writes calculated by the compiler.
    *   Every time the block actually performs a write (`frame.set(name, val, true)`) or skips a branch containing potential writes (`skipBranchWrites`), it triggers a countdown mechanism (`_countdownAndResolveAsyncWrites`).

4.  **Runtime: Performing a Write (`frame.set(name, val, true)`):**
    *   **Local Update:** The new value (`val`) is stored in the *current* async block's `asyncVars[name]`. It does *not* immediately update the parent's Promise.
    *   **Trigger Countdown:** Calls `_countdownAndResolveAsyncWrites(name, 1)` on the current frame to decrement its internal counter for `name`.

5.  **Runtime: Handling Skipped Branches (`skipBranchWrites(skippedCounts)`):**
    *   When an `if`/`switch` branch containing potential writes is *not* taken, this function is called with the pre-calculated `writeCounts` of the **skipped branch**.
    *   It calls `_countdownAndResolveAsyncWrites` for each variable in `skippedCounts`, decrementing the internal counters by the corresponding count. This ensures the counters correctly reflect that these "missed" writes will never occur, preventing indefinite waiting.

6.  **Runtime: Signaling Completion & Unlocking (Child to Parent via `_countdownAndResolveAsyncWrites` and `_resolveAsyncVar`):**
    *   When `_countdownAndResolveAsyncWrites` causes a variable's counter *on the current frame* to hit **zero**, it signifies *this specific block* has finished all its potential influence on that variable. Two things happen:
        *   **Resolve Parent Promise (`_resolveAsyncVar`):** The function retrieves the final value from the *current frame's* `asyncVars[name]` and uses the stored `resolve` function (from `promiseResolves`) to fulfill the Promise held by the *parent frame*. This **unlocks** reads for others waiting on that Promise.
        *   **Send Signal Upwards:** **Unless** the parent frame is where the variable was originally declared, `_countdownAndResolveAsyncWrites` propagates a **single "completed write" signal** (conceptually, a count of 1) up to the parent frame by calling `_countdownAndResolveAsyncWrites` on the parent.

7.  **Runtime: Tracking Overall Completion in the Parent (and propagating the signal):**
    *   The parent block's `writeCounters` for a variable is initialized (by the compiler via `pushAsyncBlock`) to reflect the total expected influences: **its own direct writes** *plus* **one count for each child async block** known to potentially modify that variable.
    *   When the parent receives the "I'm done" signal from a child (via the propagated `_countdownAndResolveAsyncWrites` call) or completes one of its own direct writes, it decrements *its own* counter for that variable.
    *   If the parent's counter hits zero:
        *   If *its* variable was locked by *its* parent, it resolves its own Promise via `_resolveAsyncVar`.
        *   Crucially, it **propagates the "I'm done" signal further up** to *its* parent (by calling `_countdownAndResolveAsyncWrites` again), **unless** this parent is the frame where the variable was declared.

8.  **Propagation Stop:** The upward propagation of the completion signal stops just below the frame where the variable was originally declared. Once all influences originating from below that point are accounted for, the variable's state is stable and correct relative to the sequential logic.

**Outcome:** This intricate system ensures that despite concurrent execution, variables modified by async blocks only become readable in their final state after *all* contributing blocks (including accounting for skipped branches) have completed their potential modifications. This rigorously guarantees sequential consistency, freeing the template author from manual synchronization. Key runtime components involved are `AsyncFrame`, `pushAsyncBlock`, `_snapshotVariables`, `_promisifyParentVariables`, `set`, `_countdownAndResolveAsyncWrites`, `skipBranchWrites`, and `_resolveAsyncVar`.

**Loop Variable Synchronization:**
Synchronizing variables modified *within* loop iterations presents a specific challenge for parallel execution. If the compiler detects that loop iterations might write to variables declared in an outer scope (`bodyWriteCounts`), Cascada prioritizes correctness. Often, it will force these loop iterations to execute **sequentially** (`sequential = true` flag passed to `runtime.iterate`) to prevent race conditions and ensure predictable variable states, even if the loop is iterating over an async source. During the loop's execution, write tracking is typically contained within the loop's scope (managed by `sequentialLoopBody = true` behavior, preventing immediate upward propagation). Once the *entire* loop finishes, a dedicated mechanism (`finalizeLoopWrites`) communicates the *net result* of these modifications upwards to the parent scope's synchronization system. This signals the loop's total impact on each affected variable using the standard `_countdownAndResolveAsyncWrites` process, integrating the loop's aggregate effect back into the overall async state management.

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

*   **`AsyncFrame`:** Extends `Frame` for async ops. Key properties: `asyncVars` (snapshots/intermediate values), `writeCounters`, `promiseResolves`. Key methods: `pushAsyncBlock`, `_snapshotVariables`, `_promisifyParentVariables`, `_countdownAndResolveAsyncWrites`, `skipBranchWrites`, `_resolveAsyncVar`, `finalizeLoopWrites`.
*   **`AsyncState` (Conceptual):** Manages overall async state: active block count (`enter/leaveAsyncBlock`), completion waiting (`waitAllClosures`).
*   **Buffer Management (`flattenBuffer`):** Recursively flattens the nested buffer array into the final output string.
*   **Async Helpers:** Functions (`resolveAll`, `resolveDuo`, `resolveSingle`, `memberLookupAsync`, `iterate`, `promisify`, etc.) provide building blocks for implicit Promise handling.

## How Specific Constructs are Handled

The core mechanisms are applied consistently:

*   **Control Flow (`if`, `for`, `switch`):** Branches are wrapped in async blocks if needed. Compiler generates `writeCounts` for *all* branches; runtime uses `skipBranchWrites` for untaken paths. `for` uses `runtime.iterate` for async iterators, potentially wrapping iterations in async contexts and potentially forcing sequential execution for state consistency.
*   **Template Composition (`include`, `extends`, `import`, `block`):** Use `_compileGetTemplateOrScript` (async) for loading. Rendering/integration logic wrapped in async blocks. State synchronization works across boundaries (with planned `depends` tag for dynamic cases).
*   **Macros, Functions, Filters, Extensions:** Use `resolveAll`/`resolveDuo` etc. for concurrent argument resolution. Async functions/filters/extensions are handled seamlessly. Macros manage their internal async state and use internal `waitAllClosures` before returning.
*   **Capture (`capture`):** Uses `_emitAsyncBlockValue` and waits for internal closures (`waitAllClosures(1)`) before finalizing the captured string.

## Error Handling

Error handling is built into the async block structure:

*   **`try...catch...finally`:** Generated code wraps async block logic.
*   **`runtime.handleError`:** Catches add context (line/col).
*   **Propagation:** Errors occurring within an async block are caught by the `try...catch` structure wrapped around it by the compiler. The `catch` block typically uses `runtime.handleError` to add template context (like line/column numbers) and then causes the Promise associated with that specific async block (the one returned by its IIFE) to be **rejected**. This rejection propagates naturally through the Promise chain. Since runtime operations involving async blocks often await these Promises (e.g., waiting for arguments, waiting for included template rendering), the rejection will bubble up. The main rendering process waits for all top-level async blocks to complete via `astate.waitAllClosures()`. This waiting mechanism detects the rejection (likely stopping on the first encountered fatal error) and ultimately rejects the final Promise returned by the top-level `renderAsync` call, signaling failure to the caller.
**Cleanup (`finally`):** Importantly, the `finally` block associated with each async IIFE ensures that `astate.leaveAsyncBlock()` is always called (even on error), decrementing the active block counter. This cleanup prevents the system from hanging indefinitely if an error occurs partway through execution.

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

Cascada's implicit concurrency model tackles the challenge of async operations in templates through a sophisticated blend of compile-time analysis and runtime orchestration. By using non-blocking async blocks, a hierarchical output buffer, state snapshotting, and a robust promise-based two-level variable synchronization system, it enables potential parallelism while rigorously maintaining the determinism of sequential execution. This frees template authors from manual async management, resulting in cleaner code and unlocking performance benefits for asynchronous workflows, underpinning both Cascada's templating and scripting capabilities.