# Promise Ownership And Unhandled Rejection Handling

Short implementation guide for where Cascada should attach rejection handlers, how that relates to `kind`/error context ownership, and how to avoid process-level `unhandledRejection` warnings without scattering `.catch(() => {})` everywhere.

---

## Problem

Cascada resolves values as late as possible. A promise may be created, stored in a command or lazy value, and consumed much later. Node tracks unhandled rejections per promise object, so a promise can warn before Cascada's eventual semantic consumer reaches it.

This is separate from Cascada's error model:

- `RuntimePromise`, `PoisonError`, and `kind` describe where an error originated and how it flows.
- `markPromiseHandled(...)` only tells the host runtime that Cascada owns delayed consumption of this promise.
- Cascada may ignore failures whose values never contribute to the final result, but host-level warning suppression still needs to be deterministic.

The rule is: **mark ownership at origin or deferred storage, not at late consumption.**

---

## Ownership Tiers

### 1. Scalar Origin Promises

These are promise-backed failures from user/context operations where Cascada assigns `errorContext` and `kind`.

Examples:

- `UserCallThrew`: user function or filter call result.
- `LookupThrew`: member lookup/getter result.
- `ContextValueRejected`: context/global lookup result.
- `IteratorThrew`: async iterator or loop item result.
- `LoadFailed`: import/include load wrappers. Component load failures are thrown inside a marked component-instance promise.

Rule:

```txt
Every promise-backed failure with a Cascada kind must live inside an already-owned promise.
Use RuntimePromise for scalar origin promises; use a marked runtime-owned promise for async paths that throw a typed PoisonError internally.
```

`RuntimePromise` is the central scalar funnel. Its constructor marks the internal promise handled and preserves `errorContext`/`kind` for later rejection normalization.

Do not rely on later `resolveSingle(...)`, `resolveAll(...)`, or `collectErrors(...)` to attach the first handler for these promises.

### 2. Runtime-Owned Promises

These are promises Cascada creates for runtime plumbing. They do not necessarily have a user-facing `kind`.

Examples:

- Command result promises from `Command._createResultPromise`.
- Async boundary promises in `src/runtime/async-boundaries.js`.
- Buffer iterator cleanup promises such as derived `.finally(...)` chains.
- Loop worker promises.
- Guard setup/detection promises.
- Component lifecycle side promises.
- Deferred export promises.
- Internal root invocation promises that may report fatal render state separately.
- Render-state fatal promises.

Rule:

```txt
If Cascada creates a deferred runtime promise, call markPromiseHandled at its birth site.
```

This includes derived promises. Handling the original promise does not handle a later `.then(...)` or `.finally(...)` result; host runtimes track each promise object independently.

If a `.then(...)`/`.catch(...)` handler exists for semantic reporting or cleanup and the returned promise is detached, mark the returned promise too. The semantic handler does not automatically own the derived promise.

### 3. Lazy Composite Values

`runtime.createObject(...)` and `runtime.createArray(...)` attach a `RESOLVE_MARKER` promise when an object/array contains async properties or children. That marker is an eager runtime-owned promise. It can reject independently with a grouped poison error even if every dependency promise is already handled.

Rule:

```txt
attachResolveMarker owns the lazy composite boundary.
It should mark every absorbed dependency and the resolver promise itself.
```

Why dependencies too: `collectErrors(values)` awaits sequentially. With dependencies like `[slow, fastReject]`, the fast rejection can warn before `collectErrors` reaches it unless dependencies are marked immediately at absorption.

### 4. Foreign Composite Values

These are plain user/foreign values that contain raw promises and did not pass through a Cascada scalar or lazy-composite funnel.

Rule:

```txt
Use markValuePromiseHandled only when foreign/composite values enter deferred Cascada storage.
```

This helper is a safety net for raw promise leaves in value containers. It should not be the primary mechanism for Cascada-created promises.

Good uses:

- Command argument staging, because commands may store arbitrary Cascada values for later.
- Any future API that stores foreign values inside Cascada-owned deferred state.

Avoid using it at ordinary consumption points. By then the warning window may already have passed.

Do not broadly mark every context object at environment entry. That would suppress user-owned promises that Cascada may never read. Mark when Cascada stores or absorbs the value for delayed engine-owned consumption.

---

## Helper Contracts

### `markPromiseHandled(promise)`

Use for one concrete promise object that Cascada owns.

Properties:

- Attaches a no-op rejection handler.
- Returns the same promise.
- Does not classify, report, transform, or consume the error semantically.
- Should be called at promise birth or at the moment Cascada accepts deferred ownership.

Use this helper instead of open-coded `.catch(() => {})` when the catch is only host-warning suppression. If a catch also reports or transforms an error, keep that semantic handler explicit and mark any detached derived promise it returns.

### `markValuePromiseHandled(value)`

Use for a value container that may contain raw foreign promises.

Properties:

- Walks arrays/objects with cycle protection.
- Skips poison and resolved-value wrappers.
- Marks raw native `Promise` leaves. It intentionally uses native-promise detection (`instanceof Promise`): host `unhandledRejection` tracking is for native promises, and arbitrary thenables should normally enter through an origin wrapper such as `RuntimePromise`.
- Is a safety net, not a substitute for origin wrapping.

Once `attachResolveMarker` marks lazy resolvers at birth, `markValuePromiseHandled` does not need to rediscover `RESOLVE_MARKER` promises. If that branch remains in code, treat it as compatibility backup rather than load-bearing design.

### `RuntimePromise`

Use when a promise's rejection should become a `PoisonError` with source context and `kind`.

Properties:

- Owns scalar origin promises.
- Marks its internal promise handled immediately.
- Wraps rejection only when consumed through `then`/`catch`/`await`.
- Preserves existing poison/runtime errors idempotently.

---

## Audit Checklist

When adding a promise-producing path, ask:

1. Is the promise awaited or handled immediately in the same synchronous turn?
   If yes, no ownership marking is usually needed. "Immediately" means a rejection handler is attached synchronously, not eventually after an `await`.

2. Is it returned to the public caller as the actual API result?
   Public caller owns rejection handling. Normalize final Cascada poison through the existing final-boundary helpers. Internal root/export promises are not public just because a public API will eventually await or inspect them.

3. Does this promise-backed failure get a Cascada `kind`?
   Ensure it lives inside an already-owned promise. Prefer `RuntimePromise(value, errorContext, kind)` at scalar origins; for runtime async paths, throw typed poison only inside a promise marked at birth.

4. Is this a runtime-created deferred promise?
   Call `markPromiseHandled(promise)` at the creation site.

5. Is this a derived promise from `.then(...)`, `.catch(...)`, `.finally(...)`, `Promise.all(...)`, or an async IIFE?
   Treat it as a new promise object. If Cascada owns delayed consumption, mark it too.

6. Is this an object/array lazy composite?
   Ensure `attachResolveMarker` marks absorbed dependencies and its `RESOLVE_MARKER` resolver.

7. Is this a foreign composite value being stored for later?
   Call `markValuePromiseHandled(value)` at the storage boundary.

---

## Implementation Map

| Promise/source | Primary owner | Helper |
|---|---|---|
| User call/filter result | `callWrapAsync` / `envCallWrapAsync` | `RuntimePromise(..., "UserCallThrew")` |
| Member lookup/getter result | `memberLookup*` | `RuntimePromise(..., "LookupThrew")` |
| Context/global lookup result | `Context.lookup*` / script call target lookup | `RuntimePromise(..., "ContextValueRejected")` |
| Iterator value | loop normalization | `RuntimePromise(..., "IteratorThrew")` |
| Import/include load wrapper | compiler composition emit | `RuntimePromise(..., "LoadFailed")` |
| Component instance load/render path | component runtime | `markPromiseHandled(componentInstancePromise)` plus `handleLoadFailure(...)` |
| Command result promise | `Command._createResultPromise` | `markPromiseHandled(...)` |
| Boundary promise | `async-boundaries.js` | `markPromiseHandled(...)` |
| Lazy object/array dependencies and resolver | `attachResolveMarker` | `markPromiseHandled(...)` |
| Deferred export promise | `Context.addDeferredExport` | `markPromiseHandled(...)` |
| Foreign composite stored in a command/value slot | storage boundary | `markValuePromiseHandled(...)` |

---

## Known Limits

- Cascada cannot prevent a warning for an already-rejected promise before that promise enters Cascada.
- `collectErrors(...)` is an error collection boundary, not a promise ownership boundary. It catches eventually, not synchronously for every entry.
- `RESOLVE_MARKER` is an internal marker written by `attachResolveMarker`. If external/synthetic marker-backed values become supported, revisit the `markValuePromiseHandled` contract.
- Unhandled-rejection suppression must not change error semantics. Raw fatal errors must still be reported as fatal, and poison must preserve its origin context.

---

## Short Rule

```txt
RuntimePromise owns scalar origin promises.
attachResolveMarker owns lazy composite promises.
markPromiseHandled owns concrete runtime-created deferred promises.
markValuePromiseHandled is only the foreign composite safety net.
```
