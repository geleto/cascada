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

## Implementation Status: Completed

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
