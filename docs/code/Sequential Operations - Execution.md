
# Sequential Operations - Architecture & Execution

**Sequential Execution using `!` marker in Cascada Templating Engine**

## 1. Introduction
Cascada automatically executes independent operations in parallel to maximize performance. However, operations with side effects (like database writes) require a guaranteed order of execution. The `!` marker allows developers to enforce this order explicitly for specific method calls and context property paths.

## 2. Core Concept: Sequence Keys as Locks
The system uses **implicit locks** based on static object paths to coordinate execution.
*   **Sequence Key**: A unique string derived from the static path (e.g., `!db!users`).
*   **Lock Mechanism**: Each key corresponds to a Promise chain in the runtime. Operations on the same key are queued; operation B waits for operation A's promise to resolve (or settle) before starting.

## 3. Architecture Overview

### A. The Compiler: Static Analysis & Intention Registration
The compiler performs a static analysis pass before generating code. It does not rely on runtime values to decide *what* to sequence, only *when*.

1.  **Path Identification**: The compiler scans for paths marked with `!` (e.g., `ctx.obj!.method()`). It verifies these paths are **static** (no dynamic array indices) and originate from the **context** (not local variables).
2.  **Lock Declaration**: Valid sequence keys are declared as "write intents" in the root scope. This is the same mechanism used for standard asynchronous variables, effectively treating `!db` as a variable that must be "written to" (updated with a new Promise) after each use.
3.  **Contention Analysis**:
    *   If an expression contains multiple sequential operations (e.g., `obj!.a() + obj!.b()`), the compiler detects "contention" for the same lock.
    *   It automatically wraps conflicting segments in **Async Blocks** (IIFEs). This ensures `a()` completes and releases the lock before `b()` attempts to acquire it, preventing deadlocks and race conditions.

### B. The Runtime: The "Pass the Baton" System
The runtime manages execution using a centralized helper `withSequenceLock` that orchestrates a Promise chain.

1.  **Check & Queue**:
    *   **Call Paths** (`obj!.method()`): The sequence is managed at the *method call* level. The runtime queues the call behind the current lock promise.
    *   **Lookup Paths** (`obj!.prop`): The sequence is managed at the *property access* level. The runtime queues the lookup itself. Crucially, **all** sequential operations (whether calls or lookups) both *wait for* the lock and *update* (write to) the lock with a new completion promise. This ensures strictly ordered access.
2.  **Execution**: Once the lock is acquired, the operation executes.
3.  **Release**: Immediately after execution (success or failure), the runtime updates the lock variable with a new/resolved Promise. This signals the next waiting operation to proceed.

## 4. Specific Behaviors

### Object Path Sequencing (`obj!.method()`)
This enforces sequencing on the **Object** itself.
*   **Scope**: Any operation using `obj!.` shares the same lock.
*   **Behavior**: `obj!.methodA()` and `obj!.methodB()` will run strictly sequentially.
*   **Mechanism**: The **Object Lookup** (`obj`) is optimized to happen in parallel if possible, but the *execution* of the method is paused until the `!obj` lock is free.

### Method-Specific Sequencing (`obj.method!()`)
This enforces sequencing **only** for calls to a specific method.
*   **Scope**: The lock key is specific to the method path (e.g., `!obj!method`).
*   **Behavior**: `obj.method!()` calls are sequenced with each other. However, `obj.otherMethod()` (unmarked) or `obj.otherMethod!()` (different method) run in parallel.

### Sequential Lookups (`obj!.prop`)
Used when the property access itself has side effects or needs to be ordered.
*   The system waits for the `!obj` lock before reading.
*   The lock is updated immediately after reading, ensuring subsequent operations wait for this lookup to finish.

### Error Handling & Repair (`!!`)
In Cascada, errors "poison" data flows. If a sequential operation fails, the lock becomes "poisoned," preventing subsequent operations on that path from running (to protect data integrity).

*   **The Problem**: A failed `db!.connect()` poisons the `!db` lock.
*   **The Solution (`!!`)**: The double-bang marker acts as a **Repair** instruction.
    *   `db!!.retry()` tells the runtime: "Chain this operation to the `!db` lock, but **execute it regardless** of whether the previous operation succeeded or failed."
    *   If `retry()` succeeds, it returns a valid value, effectively "repairing" the lock chain.

### Standalone Repair (`some.path!!`)
Repair can also be applied to a lookup without a method call:
*   **Usage**: `var x = obj!!.status`
*   **Behavior**: Waits for the `!obj` lock (ignoring poison), reads the property, and if successful, clears the poison from the lock. This is useful for inspection or state reset logic that doesn't involve a method call.

### Cross-Scope Coordination
Locks are stored in the **Root Scope** of the render.
*   **Global Access**: Operations share locks across different logical scopes (e.g., loops, conditions, guard blocks, etc...).
*   **Concurrency**: This leverages standard **concurrent resolution** (snapshots and promisification), allowing safe async interactions. However, locks are internal state and must **not** be directly modified.


## 5. Implementation Nuances

### Lock De-duplication for Calls
For `obj!.method()`, technically two nodes could be "sequential": the lookup of `obj` and the call to `method`. The compiler optimizes this:
*   It detects that the `FunCall` node covers the sequencing.
*   It **suppresses** the lock check on the `obj` lookup to avoid double-locking (which would be redundant and slower).
*   The lock is acquired only once, around the `sequentialCallWrap`.

### Repair Propogation
For `obj!!.method()`, the `!!` marker is logically on the `obj` lookup node.
*   The compiler propagates this `sequentialRepair` flag up to the `FunCall` node.
*   This ensures the `sequentialCallWrap` is generated with `repair=true`, allowing the function call to clear the poisoned lock managed by `obj`.


## 6. Constraints & Validations
To ensure deterministic behavior, the system enforces strict rules:
*   **Context Only**: You can only sequence paths originating from the global Context (e.g., `db!.save()`). Local variables (like loop iterators, macro arguments, or `set` variables) cannot be sequenced because their identity is ephemeral and hard to track statically.
*   **Static Paths Only**: Paths must be compile-time constants. `arr[0]!.do()` is valid; `arr[i]!.do()` is invalid because `i` changes at runtime.
*   **Single Marker per Path**: You cannot combine markers in a single path, e.g., `obj!.child!.method()` or `obj!.method!()`. This is to prevent complex deadlock scenarios and keep the locking model predictable.

