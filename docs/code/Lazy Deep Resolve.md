#The Initial Task:

Cascada can initialize variables with objects and arrays:
var x = { a: [1,2,3], b:7, c:’hello’ };

Some of these properties can be initialised with Promise values:
var x = { a: slowOperation };

So when a variable is needed in its final form (e.g. passed to a call as an argument or it goes to an output handler) - we need to resolve its Promise properties.

This is currently done in resolveAll  with deepResolveObject / deepResolveArray which replaces promises with resolved values.
This is not the best solution - parts of the object may come from the context object and we do not want to modify these, also deep-checking each object is not optimal.

resolveAll is mostly used in compileAggregate which compiles [], {}, () constructs.
() is used in call  arguments - it requires the variable to be completely resolved before we pass it to the functions, it is also used in @output arguments, which also require the value to be completely resolved. Cascada tries to defer the resolve to the last possible moment.

{} is used for objects - { a:1 } and [] is used for arrays. This is data initialization - we do not want to resolve anything too early so we store the promises in the data properties (if we don’t - that would be a bug, check this out, _compileAggregate has a resolveItems property).

So how can we make this more optimal?
1. When composing objects and arrays with compileAggregate we shall make sure that when the promises are resolved - the object properties or the array elements that hold these promises are resolved to the final value.
2. We must have a way to know if any object or array has unresolved properties inside (or deep inside) it. And must have a promise that will resolve when these properties are resolved. So given 1 and that when the promise resolves, the object will no longer hold any promises - awaiting for this promise can replace the deep resolve.
3. This can happen by using a marker promsie that is used to signal that the object is being resolved and this marker has to propagate to the parent object or array. We can use Symbol for that marker to avoid collisions. When propagating to parent object/array, if it already has a marker, we wrap it in a promsie.all.
4. Error handling - if the property/element resolution fails - it becomes a PoisonedValue. Be careful to stick to the principle that no error shall be lost - we await all promises to collect all errors even if an error has already been detected.

We shall replace the current deepResolve using this method.
This "Lazy Deep Resolution" is a feature exclusive to Cascada-defined data structures and will not be done on any context objects with nested promises.
You may also have a look at the runtime setPath function which in the future will integrate with this mechanism, but not now.

Evaluate this and let us decide how the parent relationship can be maintained, I gues this can happen when compileAggregate is called recursively?

# The Overview - Lazy Deep Resolution

Cascada implements a powerful optimization strategy called **Lazy Deep Resolution** for handling asynchronous data structures. This mechanism ensures that complex objects and arrays containing Promises are resolved only when absolutely necessary (e.g., when passed to a function or rendered), rather than during initialization.

## Context & Problem

In standard asynchronous execution, initializing variables with Promise properties can lead to performance bottlenecks if those promises are awaited immediately or if the runtime blindly recursively scans every object for promises.

```javascript
// A heavy object with pending data
var x = {
  data: [1, 2, 3],
  details: slowDbCall() // Promise
};
```

Previous iterations of the engine used recursive deep-scanning (`resolveAll` -> `deepResolveObject`), which had significant downsides:
1.  **Performance**: Scanning large objects (especially external context objects) is expensive.
2.  **Safety**: Deeply scanning host-provided objects is risky and can lead to unintended side-effects.
3.  **Immutability**: Mutating external objects is forbidden, but creating deep copies is slow.

## The Solution: Marker-Based Lazy Resolution

Cascada solves this using a **Marker-Based System**. Instead of scanning objects, the runtime *marks* objects that it creates (`createObject`, `createArray`) if they are known to contain promises.

1.  **Marking**: When Cascada creates an object literal `{ ... }` or array `[ ... ]` that contains a Promise or another marked object, it attaches a hidden `RESOLVE_MARKER`.
2.  **Deferral**: The object remains synchronous. The Promises inside are *not* awaited yet.
3.  **Resolution**: When the object is finally used (e.g., passed as an argument `func(x)`), the runtime checks for the inner `RESOLVE_MARKER`. If present, it awaits the marker's internal promise.
4.  **Optimization**: The marker's resolution logic waits for all internal promises, then mutates the object *in-place* to replace promises with final values, and removes the marker. Subsequent accesses are instant.

## Key Benefits

*   **Zero Overhead for Sync Data**: Objects without promises are never marked and never scanned.
*   **Context Safety**: External objects (from the host app) are never marked or scanned, preserving their integrity.
*   **Correctness**: Ensures data is fully consistent before it reaches user functions, while allowing "fire-and-forget" assignment patterns in scripts.

## The Implementation:

The Lazy Deep Resolution mechanism has been fully implemented and integrated.

### 1. Runtime Helpers (`src/runtime/resolve.js`)
- **`RESOLVE_MARKER`**: A private Symbol (`Symbol('cascada.resolve')`) is used to attach a hidden "resolver promise" to objects and arrays that contain pending operations.
- **`createObject(obj)` / `createArray(arr)`**: New factory functions that scan shallow properties. If they find a Promise or a child with a `RESOLVE_MARKER`, they create a master resolver promise for the new object.
  - This resolver uses `collectErrors` to await all dependencies.
  - Upon success, it **mutates the object in-place**, replacing promises/markers with their final values.
  - Upon failure, it throws a `PoisonError` containing all collected errors.
- **Legacy Removal**: The inefficient, recursive `deepResolveObject` and `deepResolveArray` functions (and their helper `isPlainObject`) have been removed entirely. Resolution now relies strictly on the marker system.

### 2. Compiler Integration (`src/compiler/compiler-base.js`)
- **`_compileAggregate`**: Modified to wrap object (`{}`) and array (`[]`) literals with `runtime.createObject` and `runtime.createArray` respectively, but **only in async mode**.
- This ensures that any data structure created by Cascada script that *might* contain a promise is automatically equipped with the self-resolving marker.
- Synchronous code remains unaffected and optimal.

### 3. Resolution Logic
- **`resolveAll` / `resolveSingle`**: Updated to check for `RESOLVE_MARKER`. If found, they await it. This replaces the need to crawl the object tree.
- **Performance**: Objects passed from the external context (Host Application) are standard JavaScript objects without markers. The runtime skips them immediately, avoiding the expensive deep scans that plagued the previous implementation.

### 4. Safety & Error Handling
- **Context Safety**: Only objects composed by Cascada are marked. External context objects are never mutated or deeply scanned, preventing side-effects.
- **Poison Propagation**: If a nested dependency fails, the `createObject` resolver catches it, creating a `PoisonedValue` (or throwing a `PoisonError` if part of a chain). The error bubbes up the marker chain, ensuring the top-level resolution captures all failures.

### 5. Path Assignment Integration (`src/runtime/set-path.js`)

`setPath` is the runtime utility for variable modification (e.g., `obj.a.b = val`). It has been fully integrated with the Lazy Deep Resolution system to support asynchronous values, chaining, and error collection.

**Functional Principles:**

1.  **Lazy Polymorphism (Return Types)**:
    `setPath` dynamically adapts its return type based on the operation state:
    - **Synchronous Value**: If all inputs are sync and result is sync -> returns direct value (Object/Array).
    - **Lazy Object (Sync)**: If inputs are sync but value is async -> returns a synchronous *Lazy Wrapper* (Object/Array with `RESOLVE_MARKER`).
    - **Promise**: If inputs require async resolution (e.g. **Async Key**, **Async Index**, or resolving a parent Lazy Object) -> returns a Promise resolving to the final container.
    - **PoisonedValue**: If any input is a sync error -> returns Poison synchronously.

2.  **Key vs Value Asynchrony (The Consistency Rule)**:
    -   **Async Value** (`obj.x = asyncVal`): The container is known, only the content is pending.
        -   Result: **Lazy Object** (Synchronous). The object structure exists immediately, but access requires resolving.
    -   **Async Key** (`arr[asyncIdx] = val`): The target location is unknown. We cannot write until we know *where*.
        -   Result: **Promise**. The entire container becomes a Promise. You cannot access *any* property of `arr` until the assignment settles. This guarantees consistency (e.g. you can't read `arr[2]` while an async write to index `2` is pending).

3.  **Lazy Value Assignment (Lazy Objects)**:
    When assigning an asynchronous value (Promise or Lazy Object) to a property (e.g., `obj.x = fetchAsync()`), `setPath` does **not** await the value.
    - It assigns the promise directly to the property.
    - It wraps the container using `createObject` (or `createArray`).
    - **Result**: Immediate return of a Lazy Object.

4.  **Sequential Resolution on Mutation**:
    If `setPath` targets a container that is *already* a Lazy Object (marked), it treats the container as undetermined.
    - It triggers `_setPathAsync` to resolve the container *first*.
    - **Implication**: Chained assignments (`obj.a = async; obj.b = 1`) serialize operations. `obj.b` waits for `obj.a` to settle. This ensures structural integrity.

5.  **Deep Lazy Resolution**:
    If intermediate path segments are Promises (e.g. `obj[asyncKey] = val`) or require traversing a Promise (e.g. `lazyObj.child.prop = val`), `setPath` performs **Segment-by-Segment Resolution**.
    - It resolves the path up to the target container.
    - **Optimization**: It uses `resolveAll([root, head])` to resolve the current container and the next key *in parallel*.

6.  **Copy-On-Write (COW) via Path Copying**:
    Cascada structures obey Copy-On-Write semantics. `setPath` implements a **Deep Copy for the Path**:
    - updates never mutate the original object.
    - It creates a **shallow copy** of:
      - The `root` object (or array).
      - Every nested object/array *along the path*.
    - This effectively results in a deep copy *only* along the modified path, leaving unaffected branches shared (structural sharing).
    - **Arrays**: Setting `key='[]'` triggers an array append (copy + push).
    - **Lazy Preservation**: If a copied node was Lazy, the new copy is re-evaluated. If it still contains promises (from siblings), it gets a new `RESOLVE_MARKER`.

7.  **Poison Handling & Error Collection**:
    - **Synchronous Input**: `PoisonedValue` inputs trigger immediate synchronous return of Poison (bypassing async queue).
    - **Async Rejection**: Rejections during resolution return Poison found in the barrier.
    - **Resolution Barrier**: A failed Lazy Object cannot be modified. Accessing it triggers its cached failure (collected errors).
