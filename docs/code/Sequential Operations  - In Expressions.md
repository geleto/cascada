# Expression-Level Sequence Lock Handling in Cascada

Cascada manages sequence locks within expressions to ensure that operations marked with the `!` sequence marker execute in the correct order, even in complex, concurrent scenarios. We need to decide exactly which specific parts of the expression (individual lookups or function calls) have to be wrapped in their own async block/IIFE to manage their sequence lock, preventing race conditions with other parts of the same expression. 
This process involves identifying sequence operations, analyzing potential conflicts, assigning async wrappers where necessary, optimizing their placement, and generating the appropriate code.

**1. Core Concepts and Components**

At the heart of Cascada's sequential execution feature are a few key components that work together:

*   **Sequence Keys:**
    When you use the `!` marker on a static path (e.g., `myObject.property!.doAction()`), the compiler generates a unique **Sequence Key** (like `!myObject!property!doAction` or `!myObject!property` depending on the `!` placement). This key acts as an identifier for a specific "lane" of sequential operations. All operations sharing the same sequence key will execute one after another, not concurrently.

*   **Specialized Runtime Helpers:**
    Cascada provides internal runtime functions (like `runtime.sequencedCallWrap`, `runtime.sequencedMemberLookupAsync`, `runtime.sequencedContextLookup` which have non-sequantial variants) specifically designed for `!` marked operations. Each of these helpers has a clear three-part responsibility:
    1.  **Acquire/Wait:** Before performing its main task, it waits for the relevant `sequenceKey` to be available (using `await runtime.awaitSequenceLock`).
    2.  **Operate:** It then executes the actual function call or property lookup.
    3.  **Release:** Finally, regardless of success or failure, it signals that its operation on the `sequenceKey` is complete. This allows the next operation waiting on the same key to proceed.

*   **Async IIFE Wrappers:**
    The compiler strategically wraps certain parts of an expression in asynchronous Immediately Invoked Function Expressions (async IIFEs). These wrappers serve two main purposes:
    1.  **Provide Async Context:** They create the necessary `async` JavaScript environment for the runtime helpers to use `await` when waiting for a sequence lock.
    2.  **Serialize Contending Operations:** If multiple parts of an expression try to operate on the *same* sequence key concurrently, these wrappers help serialize their execution.

*   **AsyncFrame's Promise-Based Locking:**
    Cascada's existing `AsyncFrame` system, which manages asynchronous variable state, underpins the sequence lock mechanism. When an operation involving a `sequenceKey` is initiated within an async IIFE wrapper, the `sequenceKey` in the `AsyncFrame` is associated with a Promise. This Promise acts as the actual lock. The `awaitSequenceLock` helper waits for this Promise to resolve, and the "Release" step in the runtime helpers resolves it.

*   **Compiler Analysis:**
    The Cascada compiler performs a sophisticated analysis of expressions. It identifies operations that need sequencing, determines their `sequenceKey`s, and decides which parts of the expression need to be wrapped in async IIFEs to ensure correct interaction with the runtime helpers and the locking mechanism. A crucial pre-analysis step (`_declareSequentialLocks`) informs the compiler which static paths are globally subject to sequencing based on `!` markers throughout the template.

**2. How Sequencing is Achieved Within an Expression**

The process of ensuring sequential execution within an expression involves both compile-time analysis and runtime orchestration:

*   **2.1. Identifying Sequenced Operations (Compile-Time)**
    The compiler first identifies which parts of an expression interact with sequence keys:
    *   **LOCK Operations:** A function call with a `!` in its path (e.g., `data.item!.update()`) is tagged as a "LOCK" operation. It will use a runtime helper that actively manages the acquire/operate/release cycle for its `sequenceKey`.
    *   **PATH Operations:** A property access (e.g., `data.item.value`) on a path that has been declared for sequencing (due to a `!` marker appearing elsewhere on that path, like in `data.item!.update()`) is tagged as a "PATH" operation. It will use a runtime helper that respects the sequence lock—waiting for it and then signaling its own completion for that key.

*   **2.2. Orchestrating Execution with Runtime Helpers and Wrappers**
    The compiler generates code that uses the runtime helpers and async IIFE wrappers to manage the execution flow:

    *   **Single Sequenced Call (e.g., `{{ config.settings!.save() }}`):**
        The compiler identifies `config.settings!.save()` as a LOCK operation. It generates code to:
        1.  Wrap the call in an async IIFE. This wrapper's setup ensures the `sequenceKey` (e.g., `!config!settings!save`) is "promisified" in the `AsyncFrame`, creating the lock Promise.
        2.  Inside the wrapper, call `runtime.sequencedCallWrap(..., sequenceKey)`.
        3.  `sequencedCallWrap` then waits for the lock, executes `save()`, and finally releases the lock.

    *   **Multiple Operations on the Same Sequence Key (e.g., `{{ user!.incrementLogin() + user!.updateLastSeen() }}`):**
        Both calls operate on the same conceptual lock for `user!`. The compiler's analysis will likely wrap each call (or the minimal conflicting segments of the expression) in separate async IIFEs.
        1.  Each IIFE's setup ensures the `sequenceKey` (e.g., `!user`) is promisified.
        2.  The `runtime.sequencedCallWrap` for `incrementLogin` will acquire, operate, and release the lock.
        3.  *Then*, the `runtime.sequencedCallWrap` for `updateLastSeen` will be able to acquire, operate, and release the same lock. The addition (`+`) waits for both results.

    *   **PATH Operations Respecting a Lock (e.g., `{{ data.list!.addItem("A") + data.list.length }}`):**
        1.  `data.list!.addItem("A")` (LOCK): Wrapped, uses `sequencedCallWrap`. Its `sequenceKey` (e.g., `!data!list!addItem`) is promisified.
        2.  `data.list.length` (PATH): If this access is part of a sub-expression that also gets wrapped (e.g., to resolve contention or because it's a group of PATHs), its wrapper also ensures the `sequenceKey` is promisified. The generated code will use a helper like `runtime.sequencedMemberLookupAsync(..., sequenceKey)`.
        The `sequencedMemberLookupAsync` for `.length` will wait for the lock established by `addItem` (if they share the same effective sequence key, e.g., if `addItem!` sequences the whole `data.list` path) before proceeding.

*   **2.3. Compiler Analysis for Wrapper Placement**
    The compiler performs a detailed analysis to decide where to place async IIFE wrappers. The primary goals are:
    *   To ensure any LOCK operation (a `FunCall` with `!`) always executes within an `async` context.
    *   To provide `async` context for PATH operations when necessary.
    *   To serialize parts of an expression that genuinely *contend* for the *same* sequence key by putting them into separate `async` IIFEs, effectively queuing them.
    *   To place these wrappers as close as possible to the actual sequenced operation to minimize overhead.

**3. Interaction with Cascada's Asynchronous Engine**

The `!` feature integrates seamlessly with Cascada's core asynchronous variable synchronization:
When an async IIFE wrapper is set up for a sequenced operation, the compiler ensures that the `AsyncFrame` is notified (via an internal mechanism equivalent to `_updateFrameWrites`) about the `sequenceKey` involved. This notification prompts `AsyncFrame.pushAsyncBlock` (the method that sets up the environment for an async block) to "promisify" the `sequenceKey`.

This "promisification" means creating or associating a Promise with that `sequenceKey` in the current `AsyncFrame`. This Promise is the actual lock that `runtime.awaitSequenceLock` waits on. When a runtime helper releases the lock (by calling `frame.set(sequenceKey, ...)`), it resolves this Promise, allowing the next operation in that sequence "lane" to proceed. This leverages Cascada's robust, existing infrastructure for managing asynchronous state.

**4. Summary**

Cascada's `!` marker provides explicit control over the execution order of side-effecting operations within expressions. It works through a combination of:
*   **Compiler Analysis:** Identifying sequenced operations and determining optimal placement for async IIFE wrappers.
*   **Runtime Helpers:** Encapsulating the logic for acquiring, executing, and releasing sequence locks.
*   **Async IIFE Wrappers:** Providing the necessary `async` context and serializing contending operations.
*   **AsyncFrame Integration:** Leveraging the engine's core promise-based locking mechanism for `sequenceKey`s.

This system allows developers to write expressive templates that look synchronous while benefiting from automatic parallelization for independent operations and guaranteed sequential execution for those that require it.