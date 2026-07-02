# Var Resolve / Poison Markers

## Goal

A Cascada-owned object or array must let explicit observation and consumption see the
Cascada leaves it contains, without making ordinary `var` reads pay for it. Two
independent facts about an aggregate need to be observable:

- **pending async work** — a nested promise / thenable or a nested aggregate that is
  still being resolved. The aggregate's *shape* can still change; consumers must wait.
- **known error** — a nested poison leaf (or a nested aggregate that already contains
  one). The error is synchronously knowable, the shape is stable, and the leaf is
  repairable by a later path assignment.

These are orthogonal, so they get **two separate markers**, not one marker with two
states:

- `RESOLVE_MARKER` — "await before the shape is stable." Unchanged from today.
- `POISON_MARKER` — "contains a synchronously-known poison leaf." New.

Ordinary `var` reads stay raw. Marker scans are **shallow**: an external JS object stored
inside a Cascada-owned aggregate is a leaf unless it is itself a promise, poison, or a
marker-backed Cascada aggregate.

A Cascada-owned aggregate is an object/array produced by compiler-emitted `createObject()`
/ `createArray()` or by `deepAssign()` copy-on-write. Those are the only sites that attach
markers.

## Motivation

Today the same nested-error value reports differently depending on how a `var` is stored,
which is a real inconsistency introduced by direct storage:

- A **chain-backed** `var` runs `VarChain._isError` → base `inspectTargetForErrors`
  ([base.js:311](../../src/runtime/chains/base.js#L311)), which **recursively scans** plain
  objects/arrays and finds a nested poison.
- A **direct-storage** `var` routes `is error` / `#` to `runtime.isError` /
  `runtime.peekError` ([compiler-base-async.js:709](../../src/compiler/compiler-base-async.js#L709)),
  which are **marker-only** ([errors.js:756](../../src/runtime/errors.js#L756),
  [errors.js:835](../../src/runtime/errors.js#L835)) and never recurse.

So `var x = { bad: fail() }; x is error` can answer `true` when `x` is chain-backed and
`false` when it is direct — for the identical literal. Direct vs chain storage is supposed
to be an invisible optimization (see [direct-storage.md](direct-storage.md)).

The root cause is that **synchronous poison never attaches a marker**. `getResolvePromise`
excludes poison ([resolve.js:338](../../src/runtime/resolve.js#L338)) and deep-assign's
`needsResolution` excludes it too ([deep-assign.js:43](../../src/runtime/deep-assign.js#L43)),
so `createObject({ bad: <PoisonedValue> })` attaches nothing. A nested poison is therefore
invisible to the marker-only path. (A nested *promise* already attaches `RESOLVE_MARKER`,
so the promise case already works.)

The fix is to give synchronous poison its own marker and make every error-observation and
consumption path follow the two markers — so direct and chain storage agree, and neither
recursively scans arbitrary external objects.

## Two Markers

Both markers are non-enumerable symbol properties on a Cascada-owned aggregate. They are
independent; an aggregate may carry neither, one, or both.

### `RESOLVE_MARKER` — pending async (unchanged)

`Symbol.for('cascada.resolve')`. Its value is the eager resolver promise built by
`attachResolveMarker` ([resolve.js:370](../../src/runtime/resolve.js#L370)): it awaits all
pending child promises/markers, mutates the aggregate in place on success, deletes itself,
and rejects with `PoisonError.group(...)` if a dependency fails. **This behavior does not
change.** Every existing `await value[RESOLVE_MARKER]` / `.then` site stays correct.

### `POISON_MARKER` — known sync poison (new)

`Symbol.for('cascada.poisonMarker')`, exported from
[markers.js](../../src/runtime/markers.js). Its value is the grouped `PoisonError` for the
aggregate's currently-known poison leaves, so error inspection is O(1) and needs no
re-scan. It is purely synchronous: **no promise, no resolver, no `markPromiseHandled`.**

It must be a distinct symbol from `POISON_KEY` (`Symbol.for('cascada.poison')`). `POISON_KEY`
brands a `PoisonedValue` itself; `isPoison()` tests `value[POISON_KEY] === true`. An
aggregate that *contains* a poison leaf is a healthy-shaped object with a bad leaf — it must
**not** become `isPoison() === true`, or whole objects would start propagating as poison and
break everything.

## The Two Layers

The whole design rests on consulting the two markers at two different layers. This is what
removes the old draft's "two states on one marker" machinery.

| layer | question | keys on | consumers |
|---|---|---|---|
| **await** | "must I wait?" | thenable + `RESOLVE_MARKER` only — **`POISON_MARKER` is invisible** | `resolveSingle`/`resolveAll` fast-path gate, `needsResolution`, deep-assign `isObjAsync` / `isRootAsync` / `isHeadAsync` |
| **surface** | "is there an error?" | `POISON_MARKER` (sync) **plus** the awaited `RESOLVE_MARKER` outcome | `inspectCascadaValueForError`, consumption-boundary poison surfacing, final normalization |

Because path access only consults the await layer, a poison-only aggregate is simply *not
async*: `x.bad = 2` stays on the synchronous `deepAssign` path with no special helper. The
poison marker never forces a wait — exactly because poison is already known.

## Value Boundaries

Raw boundaries return the value as-is and ignore both markers:

- direct-storage var reads
- chain-backed `var` snapshot/read
- internal return-value production before public normalization (function/macro/component
  intermediate returns passed to other Cascada code)
- copy-on-write transfer into another aggregate

Observation boundaries inspect error state via the surface layer:

- `value is error`
- `value#`
- chain `.isError()` / `.getError()`

Consumption boundaries resolve top-level promises and `RESOLVE_MARKER`-backed aggregates,
and surface `POISON_MARKER`:

- command execution
- control-flow conditions
- pure function calls
- text output / materialization
- explicit `resolveSingle()` / `resolveAll()`
- final public result normalization

Final public normalization follows both markers: a `RESOLVE_MARKER`-backed aggregate is
awaited/finalized; a `POISON_MARKER` (or a leaf that settled to poison) becomes a public
promise rejection. Unmarked external JS objects are returned as-is and are never recursively
scanned.

## Marker Creation

`createObject()` / `createArray()` do **two independent shallow scans** over the children
and attach each marker independently.

Replace the old draft's `getResolveDependency` (which pulled poison into the await world)
with two helpers. The await-dependency helper is today's `getResolvePromise`, unchanged —
it still excludes poison:

```js
// await layer: a child that the RESOLVE_MARKER resolver must wait on
function getResolvePromise(value) {
  if (!value) return null;
  if (typeof value.then === 'function' && !isPoison(value)) return value; // real pending promise
  if (value[RESOLVE_MARKER]) return value[RESOLVE_MARKER];
  return null;
}

// surface layer: known poison a child contributes synchronously
function getPoisonContribution(value) {
  if (isPoison(value)) return value.errors;                 // a poison leaf
  if (value && value[POISON_MARKER]) return value[POISON_MARKER].errors; // child aggregate's known poison
  return null;
}
```

`createObject` / `createArray` collect both, then:

- if there are pending dependencies → attach `RESOLVE_MARKER` via the existing
  `attachResolveMarker` (unchanged);
- if there are poison contributions → attach `POISON_MARKER` holding
  `PoisonError.group(contributions)`:

```js
function attachPoisonMarker(container, poisonErrors) {
  if (poisonErrors.length === 0) return container;
  Object.defineProperty(container, POISON_MARKER, {
    value: PoisonError.group(poisonErrors),
    configurable: true, writable: true, enumerable: false
  });
  return container;
}
```

Note the symmetry: a child contributes to `RESOLVE_MARKER` when it is a promise **or** has
`RESOLVE_MARKER`; it contributes to `POISON_MARKER` when it is poison **or** has
`POISON_MARKER`. Each marker propagates its own kind up the tree, shallowly.

## Path Assignment and Copy-on-Write

Two changes in [deep-assign.js](../../src/runtime/deep-assign.js), both small:

1. **Async gating is unchanged.** `isObjAsync` / `isRootAsync` / `isHeadAsync` stay keyed on
   thenable + `RESOLVE_MARKER`. `POISON_MARKER` deliberately does **not** appear here, so a
   poison-only aggregate stays on the synchronous path and can be repaired. This is the
   payoff of the split — no `mustResolveBeforePathAccess` helper is needed.

2. **Copy-on-write must recompute both markers from the new shallow children.** Today
   `_assignAtKeySync` re-marks only `if (needsResolution(value))`
   ([deep-assign.js:87](../../src/runtime/deep-assign.js#L87)) — i.e. it inspects only the
   *assigned value*. That is insufficient once poison-only aggregates skip resolution,
   because a **sibling** poison (or pending) child is dropped by the spread and would lose
   its marker:

   ```js
   deepAssign({ a: fail(), bad: fail() }, ['bad'], 2)
   // → { a: <poison>, bad: 2 };  needsResolution(2) is false
   // → without a recompute, a's poison becomes unobservable
   ```

   Fix: after building `newObj`, recompute over its shallow children by running it through
   `createObject` / `createArray` (which now attach both markers). The non-enumerable
   markers are not copied by the spread, so the recompute re-adds each marker only when its
   condition still holds. Because copy-on-write already walks the children, rebuilding the
   poison group is cheap.

Path-error vs value-error stays distinct:

- a poisoned root or path segment poisons the assignment (await layer / sync-error checks,
  unchanged);
- a poisoned assigned value is stored as a repairable leaf and attaches `POISON_MARKER`;
- assigning a healthy value over the only poison leaf yields an aggregate with no
  `POISON_MARKER`; over the only promise yields one with no `RESOLVE_MARKER`.

These all carry markers correctly:

```js
deepAssign({}, ['bad'], poison)            // → POISON_MARKER
deepAssign({ a: {} }, ['a', 'bad'], poison) // → child + parent POISON_MARKER
deepAssign([], [0], poison)                 // → POISON_MARKER
```

## Repairability Rule

Make this design decision explicit, because the marker split surfaces it:

> A leaf whose error is **synchronously known** (a `POISON_MARKER` leaf) is repairable by a
> later path assignment. A leaf that is still **pending** must settle first; a pending leaf
> that settles to poison was under `RESOLVE_MARKER`, so the aggregate stays
> `RESOLVE_MARKER`-backed and consumption/repair surfaces the poison — it is **not**
> repairable.

This keeps `RESOLVE_MARKER` byte-for-byte unchanged: it is never rewritten into a poison
state, and there is **no transition logic** in the resolver. `POISON_MARKER` is set only by
the synchronous shallow scan at creation / copy-on-write.

Worked cases:

- `var x = { bad: syncFail() }` → `POISON_MARKER` only. `x.bad = 2` stays sync, recomputes
  to a healthy aggregate. **Repairable.**
- `var x = { bad: asyncFail() }` → `RESOLVE_MARKER` only. `x.bad = 2` goes async, awaits the
  marker which rejects, assignment becomes poison. **Not repairable** — identical to today.
- `var x = { a: asyncWork(), bad: syncFail() }` → both markers. `x is error` is `true`
  immediately from `POISON_MARKER`; repair of `bad` must wait on `a` (there is real pending
  work) and surfaces the known poison. **Not repairable while pending** — acceptable.

This matches the previous behavior for async leaves and only *adds* repairability for the
sync-poison case the engine could not even observe before.

## Error Inspection

One value-level helper backs every explicit error observation:

```js
function inspectCascadaValueForError(value) {
  value = unwrapResolvedValue(value);
  if (isPoison(value)) return PoisonError.group(value.errors);   // top-level poison
  if (!value || typeof value !== 'object') return null;

  const syncPoison = value[POISON_MARKER] || null;               // surface: known poison

  if (typeof value.then === 'function' || value[RESOLVE_MARKER]) { // surface: pending may reject
    return collectErrors([value]).then((errors) => {
      const all = syncPoison ? [...syncPoison.errors, ...errors] : errors;
      return all.length ? PoisonError.group(all) : null;
    });
  }

  return syncPoison; // sync poison only, or null
}
```

This is the current `peekError` logic plus a synchronous `POISON_MARKER` short-circuit. It
does **not** recurse into plain object properties, so:

- `inspectCascadaValueForError({ bad: poison })` for an **unmarked external** object is
  `null` — Cascada-owned aggregates with that shape carry `POISON_MARKER`, and the marker is
  what makes the error observable.

It backs:

- `runtime.isError(value)` — truthiness of the helper (await if it returns a promise)
- `runtime.peekError(value)` — the helper directly
- direct-storage `is error` / `#`
- `VarChain._isError()` / `_getErrors()` — replacing the base recursive
  `inspectTargetForErrors` for vars

Scope note: `VarChain` switches to the marker-based helper, which means a **chain-backed**
var also stops recursively scanning external objects — this is the intended narrowing, and
it is what makes direct and chain storage agree. The base `inspectTargetForErrors` stays in
place for `TextChain` / `SequentialPathChain`, and `DataChain` keeps its own settled
inspector ([data-chain.js:147](../../src/runtime/chains/data-chain.js#L147)); those chains
build their targets differently and are out of scope.

## Consumption and Final Normalization

`resolveSingle` surfaces `POISON_MARKER` at the consumption boundary. Sync fast path:

```js
function resolveSingle(value) {
  value = unwrapResolvedValue(value);
  if (isPoison(value)) return value;
  // sync poison-only aggregate: consumption fails without awaiting
  if (value && value[POISON_MARKER] && !(typeof value.then === 'function' || value[RESOLVE_MARKER])) {
    return createPoison(value[POISON_MARKER]);
  }
  if (!value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return makeResolvedValue(value);
  }
  return resolveSingleAsync(value);
}
```

And after awaiting in `resolveSingleAsync`, a `POISON_MARKER` that survives finalization
(e.g. a healthy promise alongside a sync-poison sibling) is surfaced:

```js
async function resolveSingleAsync(value) {
  try {
    let resolved = value;
    if (resolved && typeof resolved.then === 'function') resolved = await resolved;
    if (resolved && resolved[RESOLVE_MARKER]) await resolved[RESOLVE_MARKER];
    if (resolved && resolved[POISON_MARKER]) return createPoison(resolved[POISON_MARKER]);
    return resolved;
  } catch (err) {
    return poisonOrRethrow(err);
  }
}
```

Because deep-assign only enters its async path on `RESOLVE_MARKER`, a poison-only aggregate
never reaches `resolveAll` during repair, so surfacing poison in `resolveSingle` does not
break copy-on-write.

`normalizeFinalPromise` ([resolve.js:75](../../src/runtime/resolve.js#L75)) already routes
through `resolveSingle`, so once `resolveSingle` surfaces `POISON_MARKER`, final public
normalization rejects on a marker-backed aggregate with no extra code.

## Non-Goals

- Do not add whole-value observation wrappers to ordinary direct reads.
- Do not recursively normalize or inspect unmarked external JS objects.
- Do not redesign `data` / `text` / `sequence` chains; they keep their current inspectors.
- Do not add transition logic to the `RESOLVE_MARKER` resolver. `POISON_MARKER` is set only
  by the synchronous shallow scan.
- Do not reuse `POISON_KEY` or let an aggregate become `isPoison()`.

## Tests

Marker creation:

- `createObject({ bad: poison })` attaches `POISON_MARKER` and **not** `RESOLVE_MARKER`.
- `createArray([poison])` attaches `POISON_MARKER`.
- `createObject({ a: promise })` attaches `RESOLVE_MARKER` and **not** `POISON_MARKER`.
- `createObject({ a: promise, bad: poison })` attaches **both** markers.
- a nested child `POISON_MARKER` propagates `POISON_MARKER` to the parent.
- a nested child `RESOLVE_MARKER` propagates `RESOLVE_MARKER` to the parent.

Await-layer isolation:

- a `POISON_MARKER`-only aggregate is not treated as async: `resolveSingle` returns poison
  synchronously (no microtask), and `needsResolution` is false for it.
- deep-assign on a `POISON_MARKER`-only aggregate stays on the synchronous path.

Path assignment / repair:

- assigning poison into an object/array attaches or propagates `POISON_MARKER`.
- repairing the only poison leaf removes `POISON_MARKER` without awaiting.
- repairing one of several poison leaves keeps `POISON_MARKER` with the remaining error.
- a sibling poison child is **not** dropped by copy-on-write (`deepAssign({ a: fail(), bad:
  fail() }, ['bad'], 2)` still reports `a`'s poison).
- replacing the only promise property with a healthy value removes `RESOLVE_MARKER`.
- assigning into a `RESOLVE_MARKER` root still waits when required.
- poisoned root/path segment poisons the assignment; a poisoned assigned value is stored as
  a repairable leaf.

Repairability rule:

- a sync-poison leaf is repairable (`{ bad: syncFail() }` then `x.bad = 1` → healthy).
- an async-failed leaf is not repairable (`{ bad: asyncFail() }` then `x.bad = 1` →
  consumption poison), matching today.
- a mixed pending+poison aggregate reports `is error` immediately and surfaces poison on
  consumption.

Explicit error inspection:

- `var x = { bad: fail() }; x is error` returns `true`.
- `var x = { bad: fail() }; x#` returns the poison error.
- after `x.bad = 1`, `x is error` returns `false`.
- `runtime.isError({ bad: poison })` returns `false` for an unmarked external object.
- **direct vs chain parity**: the same nested-poison literal yields the same `is error` /
  `#` whether the var is direct-storage or chain-backed.

Raw reads:

- direct-storage and chain-backed `var` reads return raw values (markers intact, not
  collapsed).
- returning an object with an unconsumed poisoned property does not make the whole object
  `isPoison()` inside Cascada.

Consumption:

- passing a `POISON_MARKER` object to a pure function surfaces poison.
- text output of a marker-backed object/array surfaces poison.
- final public normalization rejects on a marker-backed aggregate (sync poison or settled
  promise rejection).

External objects:

- external objects with nested promises/poison are not recursively normalized on raw
  return.
- wrapping an external object in a Cascada-created aggregate applies marker rules only to
  the Cascada-owned wrapper.

## Success Criteria

- Cascada-created aggregates carry `RESOLVE_MARKER` for nested pending async and
  `POISON_MARKER` for nested known poison, independently.
- `RESOLVE_MARKER` semantics and every site that awaits it are unchanged.
- `POISON_MARKER` is synchronous, never forces a wait, and never makes an aggregate
  `isPoison()`.
- Normal `var` reads remain raw.
- Direct-storage and chain-backed vars report identical `is error` / `#` for the same value.
- Final public values follow both markers; consumption surfaces poison and final
  normalization rejects.
- Copy-on-write can repair a synchronously-known poisoned branch before consumption, and
  recomputes both markers from the new shallow children.

## Relationship to the Previous Draft

Carried over: the value-boundary taxonomy, the single `inspectCascadaValueForError`
consolidation, the "external objects are leaves / not recursively scanned" rule, the
copy-on-write-recompute requirement, and the test/criteria intent.

Discarded: the single `RESOLVE_MARKER` carrying two states; the "pending vs poison-only"
marker lifecycle and the mixed-state "downgrade"; the `mustResolveBeforePathAccess` helper;
and `getResolveDependency` (which incorrectly treated poison as an await dependency). The
two-marker split replaces all of it — `RESOLVE_MARKER` stays exactly as today, and a
synchronous `POISON_MARKER` carries known errors, consulted at the surface layer only.
