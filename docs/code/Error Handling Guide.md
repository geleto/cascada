# Cascada Error Handling Guide

Audience: AI agents and Cascada maintainers working in `src/runtime/` and `src/compiler/`. This is the authoritative, self-contained reference for the runtime error model — how errors are created, carried, consumed, and reported.

It intentionally restates the consumption helpers (`resolveThen`, `thenValue`, `finallyValue`, the `resolve*` family) and the `poisonOrReport` family so this document stands alone. [`sync-first.md`](sync-first.md) covers the *performance pattern* for using them; this guide covers the *error semantics*. When the two overlap, both must stay consistent with [`src/runtime/errors.js`](../../src/runtime/errors.js) and [`src/runtime/resolve.js`](../../src/runtime/resolve.js), which are the ground truth.

> Older migration notes may show transitional names such as `TemplateError`, `RuntimeFatalError`, aggregate-style `new PoisonError(errors)`, or kind-less factory calls. Those are historical. Current factories require a `kind`.

## Table of Contents

- [The Mental Model](#the-mental-model)
- [Five Invariants](#five-invariants)
- [Error Families](#error-families)
- [The `PoisonedValue` Transport](#the-poisonedvalue-transport)
- [Producing Errors at the Origin](#producing-errors-at-the-origin)
- [The `kind` Property](#the-kind-property)
- [Carrying & Consuming Poison](#carrying--consuming-poison)
- [Fatal vs Non-Fatal at the Consumption Point](#fatal-vs-non-fatal-at-the-consumption-point)
- [Generated Async-Boundary Shapes](#generated-async-boundary-shapes)
- [When a Fatal Error Occurs & Render Shutdown](#when-a-fatal-error-occurs--render-shutdown)
- [Adding Origin to Async Values](#adding-origin-to-async-values)
- [Source-Origin & Context Ownership](#source-origin--context-ownership)
- [The Frozen Sync Path](#the-frozen-sync-path)
- [Inspection & Aggregation](#inspection--aggregation)
- [Decision Cheat Sheet](#decision-cheat-sheet)

---

## The Mental Model

Cascada separates **value failures** (a function threw, a property was missing, a promise rejected) from **engine failures** (a broken invariant, an impossible control-flow state). They flow through the runtime in completely different ways.

A value failure becomes a **poison error** (`PoisonError`) the moment it is caught at its **origin** — the operation that actually failed. That poison error is wrapped in a **`PoisonedValue`**: an inspectable, thenable container that flows through the program *as a value*. Downstream operations that receive poison skip their work and propagate the same poison unchanged. The render only fails when poison reaches a boundary that must surface it (a `return`, an output write, the final render promise).

An engine failure becomes a **`RuntimeError`** and is *fatal* — it aborts the render. It is never converted into poison "to keep going".

```
                 origin operation
                  (catches a throw)
                        │
          value failure │ engine failure
        ┌───────────────┴────────────────┐
        ▼                                 ▼
  PoisonError.wrap/create          RuntimeError.report
        │                                 │
  createPoison(...)                 (fatal: aborts render)
        │
  PoisonedValue ── flows as a value ──► consumed via resolve*/thenValue
        │                                 │
   isPoison() detects it           non-poison throw here ⇒ fatal
        │
   reaches a boundary ──► awaiting throws PoisonError / PoisonErrorGroup
```

---

## Five Invariants

These are the load-bearing rules. Everything else is detail.

1. **Poison is created only at the origin, and only from a failed *value*.** The value-producing operation that fails wraps the raw error into a `PoisonError` with its own compact context and a `kind`. Poison is *never* manufactured from a sync throw of normal/engine flow, nor from a rejection of a non-value (orchestration) promise — those are fatal. Consumers never re-author context (see [Producing Errors](#poison-is-only-ever-derived-from-a-failed-value) and [Source-Origin](#source-origin--context-ownership)).
2. **From the origin onward, the failure travels inside a `PoisonedValue`.** It is a value, not a thrown error. It moves through assignments, arguments, and chains like any other value.
3. **Never `await` a `PoisonedValue` directly.** Use the resolve/then helpers (`resolveThen`, `thenValue`, `finallyValue`, `resolveSingle/All/Duo`). They detect poison synchronously and propagate it without a microtask. Blind `await poison` works (it rejects) but defeats the sync-first design and can hide errors when several values must all be observed.
4. **Poison must not escape synchronously from sync-first code.** Poison flows as a return value on sync paths, not as a synchronous throw. Note that `thenValue` (and `PoisonedValue.then`) may call an *error callback* synchronously for an existing `PoisonedValue`; that callback must **return** poison (via `poisonOrReport`) unless it is deliberately producing an async rejection for an awaiting caller. Throwing a poison error is reserved for `async` functions surfacing it to an awaiting caller.
5. **When resolving a value, anything thrown that is *not* poison is fatal.** A rejected promise carrying a `PoisonError` is normal dataflow. A rejection carrying anything else (or a `RuntimeError`) is an engine/contract failure and must propagate as fatal — never be silently turned into poison.

---

## Error Families

Defined in [`src/runtime/errors.js`](../../src/runtime/errors.js). All extend `RuntimeContextError`, which carries compact source context and renders compact vs full (`message` vs `fullMessage`) diagnostics.

| Class | Role | Fatal? | How it travels |
|---|---|---|---|
| `CompileError` | Compile/load-time failure with source position. | Yes (compile) | Thrown during compile. |
| `RuntimeError` | Fatal runtime/engine/contract failure. | **Yes** | Reported to render state, then thrown. |
| `PoisonError` | One non-fatal value/dataflow failure. Has `kind` + `cause`. | No | Inside a `PoisonedValue`; thrown only when awaited. |
| `PoisonErrorGroup` | Aggregate of `PoisonError`s. `extends PoisonError`. | No | What a `PoisonedValue` rejects with when awaited. |

Key relationships:

- `PoisonErrorGroup extends PoisonError`, so `isPoisonError(x)` (which is `x instanceof PoisonError`) is **true for both**. Use it in `catch` to match either shape.
- `RuntimeError` is a sibling, not poison. `isRuntimeError(x)` is its check.
- Every `PoisonError` has a `.cause` (the original JS `Error`) and a non-empty string `.kind`. The constructor throws if `kind` is missing — there is no such thing as a kind-less poison error.

---

## The `PoisonedValue` Transport

`PoisonedValue` (in [`errors.js`](../../src/runtime/errors.js)) is **not an `Error`**. It is a thenable container so that:

- runtime code can detect it **synchronously** with `isPoison(value)` before doing any async work, and
- code that does `await` it still gets a rejection (a `PoisonError` or `PoisonErrorGroup`).

It carries `.errors[]` (the individual `PoisonError`s) and a `POISON_KEY` brand. It is **deliberately not Promise/A+ compliant**:

- Its `then(onFulfilled, onRejected)` runs the rejection handler **synchronously**, not on the microtask queue.
- With no `onRejected`, `then` returns `this` (no new promise allocated) — poison propagates straight through `.then(onValue)` chains.
- If the rejection handler itself throws poison, that is re-wrapped via `createPoison`; a non-poison throw propagates as fatal.

```js
function isPoison(value) {
  return value != null && value[POISON_KEY] === true;
}
```

`isPoison` is a cheap synchronous brand check. It does **not** tell you whether a *promise* will reject — for that you must await/inspect (see [Inspection](#inspection--aggregation)).

---

## Producing Errors at the Origin

Only the failing operation creates poison. There are exactly three poison factories plus one wrapper into a `PoisonedValue`. **Every factory requires a `kind`.**

| Call | Use when |
|---|---|
| `PoisonError.create(message, errorContext, kind)` | The engine itself authored a new value failure (e.g. `'value is NaN'`, an unknown variable). |
| `PoisonError.wrap(error, errorContext, kind)` | A user/source `Error` was caught at this origin (a thrown filter, a rejected context promise). If `error` is already poison, it is returned **unchanged** (keeps its origin context). |
| `PoisonError.group(errors)` | Aggregate already-originated poison errors. Returns the single child if there is only one, else a `PoisonErrorGroup`. Normalizes/dedupes. |
| `createPoison(poisonError)` | Wrap a ready `PoisonError`/`PoisonErrorGroup` into a `PoisonedValue` to return as a value. **Not exported publicly.** |

### Poison is only ever derived from a failed *value*

This is the most-violated rule, so state it sharply: a **new** `PoisonError` (`wrap`/`create`) may be authored **only** because a *value* failed. A "value failure" is exactly one of:

- a **value-producing operation** threw synchronously while producing a value — a user function/filter/data method/sequence method, a property getter, a loop iterator/generator, an operator coercion; or
- a **value-carrying promise/thenable rejected** — a render-context promise, a function's returned promise, a `RESOLVE_MARKER` finalization.

You must **never** derive poison from:

- a **sync throw that is part of normal control flow or engine orchestration** (an invariant violation, a bad control-flow contract, an unexpected bug, a failed hard precondition) — that is a `RuntimeError`, fatal;
- a **rejection of a non-value promise** — internal boundary/resolver orchestration promises (`fatalPromise`, buffer resolvers, child-boundary promises) carry control flow, not a user value. Their rejections are fatal (or already-typed poison/runtime errors passed through), never *freshly wrapped* into poison.

In other words: catching a throw or a rejection is **not** sufficient grounds to make poison. You make poison only when the thing that failed *was a value you were producing or consuming*. Everything else propagates as a real error. This is why `PoisonError.wrap`/`create` are always called at the exact value origin with that origin's `kind`, and why the `poisonOrReport` family (see below) reports non-poison throws as fatal instead of wrapping them.

Rules:

- Pass `PoisonError` *objects* between runtime components. Touch `.errors[]` only for `PoisonedValue` storage or local collection before grouping.
- Never put a raw `Error`, string, or array into `createPoison(...)`, command poison payloads, or chain poison hooks — they expect typed poison errors.
- `PoisonError.wrap` on existing poison is the identity — it preserves the original context. This is how consumers safely "re-wrap" without stealing origin.

Typical origin (a user call that threw):

```js
try {
  result = userFn(...args);
} catch (err) {
  return createPoison(PoisonError.wrap(err, errorContext, 'UserCallThrew'));
}
```

Typical engine-authored origin:

```js
return createPoison(PoisonError.create('value is NaN', errorContext, 'NaNResult'));
```

Fatal runtime errors use a parallel factory set:

| Call | Effect |
|---|---|
| `RuntimeError.create(message, context, stackBuffer?)` | Build (or pass through) a fatal error. |
| `RuntimeError.report(message, context?)` | Report to the active render state's `reportFatalError`, return the error. |
| `RuntimeError.reportAndThrow(message, context?)` | `report` then `throw`. |
| `reportRuntimeContractError(message, ctx)` | Internal: report+throw for broken invariants. |

`RuntimeError.report` uses a supplied `context` only to *locate* the render state, never to re-contextualize an existing `RuntimeError`.

---

## The `kind` Property

`kind` is a stable string naming **what** failed, independent of `label` (which names **where**, e.g. `'FunCall'`). It is required on every `PoisonError` and is surfaced to scripts via `error.kind`. Treat it as diagnostic metadata, not a frozen API — the set may grow. The authoritative table lives in [`script.md`](../cascada/script.md#the-kind-property); reproduced here for contributors choosing a kind at a new origin:

| `kind` | Failure |
|---|---|
| `MissingFunction` | called name resolved to `undefined` |
| `NotAFunction` | call target is not a function |
| `UserCallThrew` | a called function/filter/data method/sequence method threw |
| `UnknownVariable` | bare variable read names a missing symbol |
| `NullLookup` | property read on `null`/`undefined` |
| `ScalarLookup` | script property read on a scalar primitive |
| `LookupThrew` | a property getter threw |
| `IteratorThrew` | a loop iterator/generator threw |
| `NotIterable` | loop source / `in` RHS is not a collection |
| `NotDestructurable` | loop element not array-like for multi-var destructuring |
| `InvalidConcurrentLimit` | `of` limit is not a positive number |
| `IncompatibleOperands` | operator operands have incompatible types |
| `DivideByZero` | BigInt division or modulo by zero |
| `LoadFailed` | a non-fatal `import`/`component`/`include` load failed |
| `ImportBindingMissing` | imported name is not exported by the module |
| `NaNResult` | a computation produced `NaN` (`Infinity` stays a value) |
| `InvalidTextValue` | a value that cannot be converted to text |
| `ContextValueRejected` | a render-context promise (or returned value) rejected |

When adding a new failure origin, reuse an existing kind if it fits; only add a new one when the failure is genuinely distinct, and document it in `script.md`.

For a `PoisonErrorGroup`, `kind` is the shared child kind if all agree, else `'Multiple'`; `kinds` is the sorted unique set. See [Inspection](#inspection--aggregation).

---

## Carrying & Consuming Poison

Once poison exists, it flows as a value. The hard rule is **invariant #3: never `await` it directly**. Use these helpers, all in [`resolve.js`](../../src/runtime/resolve.js) (generated code calls them with the `runtime.` prefix). They share a sync-first shape: handle concrete values and poison synchronously, delegate real promises to an async core.

### `resolveSingle(value)` — finalize one raw value

Consumes one top-level Cascada value that may be raw: a real promise, a lazy `RESOLVE_MARKER`-backed object/array, or a concrete value.

- Concrete value → returned in a branded `ResolvedValue` wrapper (fast path, no Promise).
- Poison → returned **synchronously**, unchanged.
- Promise / marker → awaited and finalized in place; rejection becomes poison via `poisonOrRethrow` (poison returned as value, non-poison rethrown fatal).

`resolveDuo(a, b)` and `resolveAll([...])` are the multi-value forms. They **await every input even after the first failure** and group all collected errors into one `PoisonedValue` — this is the **"Never Miss Any Error"** principle. Never short-circuit on the first poison when consuming several independent values.

```js
// 0 args → [], 1 → single, 2 → duo, n → many; always collects ALL errors.
const resolved = resolveAll([left, right, extra]);
```

`resolveSingleArr` is compatibility glue that preserves a historical one-element-array shape; prefer `resolveSingle` in new code.

### `resolveThen(value, onValue, onError?)` — raw value boundary

The preferred shape when a helper consumes **one raw value**. It runs `resolveSingle` first (so it finalizes lazy markers and converts rejection to poison), then chains `thenValue`.

```js
function helper(value, errorContext) {
  return resolveThen(value,
    (resolved) => handleSync(resolved, errorContext),
    (err) => poisonOrReport(err, errorContext));
}
```

### `thenValue(value, onValue, onError?)` — already-resolved boundary

Use when **another Cascada helper already resolved** the value (e.g. the return of `resolveSingle/All/Duo`). It:

- preserves poison synchronously (calls `onError` with `PoisonError.group(...)`, or returns the poison if no `onError`);
- unwraps `ResolvedValue` wrappers on the sync path (no allocation);
- chains real promises with `.then`.

It does **not** finalize a lazy `RESOLVE_MARKER` — passing a raw lazy value here silently skips finalization. Rule of thumb: **`resolveThen` for a raw boundary, `thenValue` for the step after a resolve helper already ran.**

```js
function helper(value, errorContext) {
  const result = existingHelper(value, errorContext);
  return thenValue(result, (resolved) => transformSync(resolved, errorContext));
}
```

### `finallyValue(value, onFinally)` — cleanup without assimilation

Runs `onFinally()` around an already-produced Cascada value without forcing it through `Promise.resolve` (which would assimilate poison/wrappers). Use for internal commit/rollback/cleanup. It runs `onFinally` on the sync path, on fulfillment, and on rejection (rethrowing). Final *public* exits use `normalizeFinalPromise` instead.

```js
return finallyValue(doWork(value), () => releaseLock());
```

### Manual fast-path (low-level helpers only)

When you need custom branching before resolution (collecting multiple sync poisons, special-casing arrays, choosing a dedicated async helper), check shapes by hand — but follow the same semantics:

```js
function helper(value, errorContext) {
  if (isPoison(value)) return value;                 // sync poison passthrough
  if (!value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return handleSync(value, errorContext);          // concrete value
  }
  return helperAsync(value, errorContext);           // real async
}

async function helperAsync(value, errorContext) {
  try {
    const resolved = await resolveSingle(value);
    return handleSync(resolved, errorContext);
  } catch (err) {
    return poisonOrReport(err, errorContext);        // see next section
  }
}
```

### The `async` return rule

- **Non-`async` / sync-first hybrid** functions may **return** a `PoisonedValue` directly (it is just a value).
- **`async`** functions must **not** return a `PoisonedValue`. They must **throw** a poison error instead — `PoisonError.group(value.errors)` for existing poison, or `PoisonError.wrap(err, ctx, kind)` for a freshly caught value failure. (Returning poison from an `async` fn wraps it in a resolved promise, breaking `isPoison` detection downstream.)
- **Never** check `isPoison()` *after* `await`. It is architecturally impossible for `await somePromise` to yield a `PoisonedValue` — poison surfaces as a rejection. Check `isPoison` before awaiting; catch with `isPoisonError` after.

---

## Fatal vs Non-Fatal at the Consumption Point

This is invariant #5 in code. When a consumption point catches a throw/rejection, it must decide: is this a value failure (→ poison, keep going) or an engine failure (→ fatal)? The `errors.js` helper family encodes the four common choices. Pick by *what should happen next*, not by habit.

| Helper | On poison | On non-poison throw | Use when |
|---|---|---|---|
| `poisonOrReport(err, ctx)` | returns `createPoison(err)` (a value) | `RuntimeError.reportAndThrow` (fatal) | **Sync/sync-first** point that owns a value it can poison. Default. |
| `rethrowPoisonOrReport(err, ctx)` | re-`throw`s the poison error | `RuntimeError.reportAndThrow` (fatal) | **`async`** point: keep poison as a rejection for an awaiting caller. |
| `poisonOrReportedFatal(err, ctx)` | returns the poison error | `RuntimeError.report` (fatal, returns) | Observable **command results**: preserve poison, report raw failures. |
| `poisonOrRethrow(err)` | returns `createPoison(err)` (a value) | bare `throw err` (no context) | **Context-free** consumers in `resolve.js`: the owning boundary reports it with proper context. |

**`poisonOrReport` is not a generic sync `catch` helper.** Use it only when the caught throw/rejection belongs to *value consumption*. A sync `catch` around orchestration or boundary setup should report fatal directly with `RuntimeError.reportAndThrow` — see the value-boundary `catch` in [Generated Async-Boundary Shapes](#generated-async-boundary-shapes).

Why context-free `poisonOrRethrow` bare-rethrows: context belongs to the **origin/owner**, not the consumer. The deep resolve helpers have no `errorContext`, so they must not invent one — they let the call/structural boundary (or `raceRootResult`) report the fatal error with the right context.

Hard don'ts:

- Don't catch broad errors "just to keep going". Only **value-consumption** failures become poison.
- Don't convert a `RuntimeError` into poison. The helpers above already let `RuntimeError`/non-poison throws stay fatal — don't defeat that.
- Don't attach a *consumption* `errorContext` to an incoming poison error.

`handleLoadFailure(error, ctx, kind, env)` is the dedicated policy point for `import`/`component`/`include`: existing poison/runtime errors propagate; a raw failure becomes fatal or `LoadFailed` poison per `env.opts.loadFailFatal`.

---

## Generated Async-Boundary Shapes

The compiler wraps async work in boundary helpers ([`src/runtime/async-boundaries.js`](../../src/runtime/async-boundaries.js), emitted from [`src/compiler/async-boundaries.js`](../../src/compiler/async-boundaries.js)). Each boundary kind has a *fixed* error contract — matching it is what keeps value failures as poison and engine failures fatal. There are three. Getting the wrong contract here is the most common source of "why did this throw instead of poison" (and vice-versa) confusion.

### Value boundaries (`runValueBoundary`)

Used for expressions that return a value to an awaiting expression consumer. The generated body returns value-or-thenable and is shaped:

```js
runtime.runValueBoundary(parentBuffer, boundaryLinkedChains, boundaryLinkedMutatedChains, (currentBuffer) => {
  try {
    let result = /* emitted expression */;
    return runtime.thenValue(result, (value) => value, (e) => {
      return runtime.poisonOrReport(e, errorContext);
    });
  } catch (e) {
    runtime.RuntimeError.reportAndThrow(e, errorContext);
  }
}, bufferStackErrorContext);
```

The two error paths are **not** interchangeable:

- The **`thenValue` error callback** handles the *resolved value* path — an existing `PoisonedValue` or an async rejection of the produced value. That is value consumption, so it returns poison via `poisonOrReport` (which still reports a genuine non-poison rejection as fatal).
- The **sync `catch`** handles failures while *building/dispatching* the boundary itself (setup, contract violations). That is not value consumption, so it reports fatal with `RuntimeError.reportAndThrow` — never `poisonOrReport`.

Unlike control-flow boundaries, value boundaries preserve normal expression rejection semantics: a real async rejection propagates to the awaiting caller. `runValueBoundary` itself rethrows a synchronous boundary-body throw (after finishing its child buffer via `finallyValue`).

### Control-flow boundaries (`runControlFlowBoundary` / `consumeControlFlowValue`)

Used for `if`/`switch`/loop bodies that consume a condition or iterable and emit into chains rather than returning a value. Condition/operand consumption goes through `consumeControlFlowValue(value, buffer, poisonTargetChains, ec, onValue)`, whose error path (`poisonControlFlowTargets`) is:

- a `RuntimeError` rethrows (fatal);
- any other non-poison rejection → `RuntimeError.reportAndThrow` (fatal);
- poison → an `ErrorCommand` is enqueued on each *poison target chain*, poisoning the writes/effects that depended on the skipped branch; the branch body is skipped and the render keeps going.

So a poisoned condition poisons its dependent target chains; a non-poison failure is fatal. There is no "return poison to a caller" here because a control-flow boundary has no value consumer.

### Render / structural boundaries (`runRenderBoundary`)

Used for isolated render/structural work (a render root, include/component body) that has **no** awaiting expression consumer. Errors are normalized by `normalizeStructuralBoundaryError`: existing poison is returned as-is, but any other error is reported through render state via `reportAndThrowFatalError`. Reporting fatal *through render state* is essential here precisely because there may be no normal expression consumer waiting to receive a rejection — `raceRootResult` and the fatal flag are how it surfaces.

---

## When a Fatal Error Occurs & Render Shutdown

A fatal error aborts the whole render. Poison is the opposite: it is local and the render keeps going. Use a `RuntimeError` (i.e. report fatal) **only** for:

- a broken engine invariant or control-flow contract (an "impossible" state);
- an unexpected runtime bug in normal flow (not a value consumption failure);
- an invalid *hard* precondition (e.g. `resolveSingle` called with the wrong argument count, a missing required `kind`/context);
- a value-consumption point catching a throw that is **not** poison (invariant #5) — the non-poison branch of the `poisonOrReport` family;
- a load failure that policy says is fatal (`handleLoadFailure` with `loadFailFatal`), and the always-fatal roots: the entry render and `extends`.

Everything else — a user function throwing, a missing variable, a rejected context promise — is poison, **not** fatal.

### The fatal flag lives on `RenderState`

[`render-state.js`](../../src/runtime/render-state.js) owns the "a fatal error has occurred, wind everything down" flag. There is one `RenderState` per render call (shared with its composition participants). It holds:

- **`this.error`** — the latched fatal error. **First write wins**: `reportFatalError` returns early if `this.error` is already set, so the first fatal error is the one surfaced and later ones are ignored.
- **`fatalPromise`** — a promise that **rejects** the moment `reportFatalError` runs (`_rejectFatal(error)`). This is the abort signal that lets in-flight async work be cut short instead of awaited to completion. It is marked handled so it never produces an unhandled-rejection warning.
- **`onError`** — optional callback invoked once on the first fatal error.

Reporting API (also reachable through `RuntimeError.report` / `reportAndThrow`, which find the render state via the error context):

| Method | Effect |
|---|---|
| `reportFatalError(error, ctx?, stackBuffer?)` | Latch + reject `fatalPromise` + call `onError`. Void. Idempotent (first wins). |
| `reportAndThrowFatalError(...)` | `reportFatalError` then `throw`. |
| `isFatalErrorReported()` | `!!this.error` — the flag. |
| `throwIfFatalErrorReported()` | Throw the latched error if set; otherwise no-op. |
| `raceRootResult(result)` | `Promise.race([result, fatalPromise])` — see below. |

`RuntimeError` is preserved as-is when reported (its origin context is kept); a raw error or string is wrapped into a `RuntimeError` at report time.

### How processing actually winds down

The flag is checked in three places so a fatal error stops new and pending work quickly, without leaving promises hanging:

1. **`raceRootResult(result)`** races the root render promise against `fatalPromise`. Whichever settles first wins, so the render rejects as soon as *any* concurrent branch reports fatal — it does not wait for the slow/normal result. (If `result` is already rejecting and the rejection isn't poison or a `RuntimeError`, it is reported as fatal here, so a stray throw still becomes the latched error.) Used at the render root and at composition/inheritance entry points.
2. **The buffer iterator** ([`buffer-iterator.js`](../../src/runtime/buffer-iterator.js)) checks `buffer.renderState.isFatalErrorReported()` at the top of each step and calls `_stopAfterFatalReport()` — abandoning the remaining commands. Pending observable command results are settled/rejected during fatal stop so cleanup never deadlocks; never-settling waited commands are deliberately **not** drained (see the note in [`async-boundaries.js`](../../src/runtime/async-boundaries.js)).
3. **Boundary entry points** (`runControlFlowBoundary`, `runWaitedControlFlowBoundary`, `runRenderBoundary`, inheritance/component/include/import setup, macro invocation) call `throwIfFatalErrorReported()` before starting new async work, and again after awaits where a sibling/root path may have reported fatal in the meantime. This prevents spawning new work after the render is already aborting.

### Checking the flag from compiled/runtime code

Runtime code that holds a `RenderState` calls its methods directly. Code that only has the compact `errorContext` tuple uses the ec-keyed adapters in [`error-context.js`](../../src/runtime/error-context.js), which read the render state from slot 5 (`getRenderState`):

- **`isFatalReported(errorContext)`** → `getRenderState(ec)?.isFatalErrorReported()`.
- **`throwReportedFatal(errorContext)`** → `getRenderState(ec)?.throwIfFatalErrorReported()`.

These exist because the call/loop runtime has the `errorContext` in scope but not the `RenderState` object. Generated code typically emits `renderState.throwIfFatalErrorReported()` at load/composition boundaries (see [`composition.js`](../../src/compiler/composition.js)).

**Rule of thumb:** never poll the flag inside tight value-level logic — that is what poison and `raceRootResult` are for. Check it only at **boundaries** (before spawning child work, after an await that could have raced a fatal) so an already-aborting render doesn't start new work.

---

## Adding Origin to Async Values

Some values leave a producer as a bare promise that may reject *later*, after the producing operation has returned. To attach origin to such a value, use the producer-side helpers rather than waiting on it yourself:

- **`valueWithOrigin(value, errorContext, kind)`** — wraps a possibly-promise value in a `RuntimePromise` carrying origin context + kind, so a later rejection becomes a properly-contextualized `PoisonError`. Passes through poison, existing `RuntimePromise`s, and non-thenables unchanged. Also poisons `NaN` results.
- **`RuntimePromise`** — a promise wrapper that converts raw rejections into typed `PoisonError`s (via `_wrapRejection`) and marks the underlying promise handled (`markPromiseHandled`) because commands/chains often consume it later, avoiding spurious `PromiseRejectionHandledWarning`.
- **`poisonIfNaN(value, errorContext)`** — turns a `NaN` number into `NaNResult` poison at its origin.

`markValuePromiseHandled(value)` recursively marks owned promises inside a value tree as handled — used where Cascada observes promises through a command/chain instead of by the promise object itself.

Other origin-adding paths: `PoisonError.create/wrap` (immediate throwable/poisonable failures), command `settleResult(..., mapError)` (command-owned async results), and `handleLoadFailure` (loads).

---

## Source-Origin & Context Ownership

Error context belongs to the **operation that created the error**, not to any later consumer. Consumption paths preserve incoming context untouched.

- Create at origin with `PoisonError.create` / `wrap`; aggregate with `group`.
- Do **not** attach a local consumption `errorContext` to an incoming `PoisonError`, `PoisonErrorGroup`, or `PoisonedValue`. Pass it through or group it.
- The same rule governs command-buffer **diagnostic stacks**: stack frames come from the buffer/boundary where the async branch was *created*, not from arbitrary later consumption.

Compact error contexts have three ownership modes (see `AGENTS.md` for the full treatment):

1. **Static** — shared prepared `__ec[index]` tuple. Never mutate.
2. **Initialized owned** — a clone made at the origin AST node when added metadata is already known (e.g. a loop iteration).
3. **Dynamic owned** — a clone made at the origin before metadata is known (e.g. an async if/switch boundary); mutate it later with `runtime.mergeAddedContext(...)` / `runtime.setContextLabel(...)`.

For all three, the **origin AST codegen** chooses the context and passes that same context to commands, helpers, and buffers for that origin. Context is normalized only inside error handling, at the point of consumption.

The compact context tuple layout (`RuntimeContextError._normalizeContext`): `[lineno, colno, label, path, addedContext, renderState]`. Owned contexts may update the `label` slot (index 2) for diagnostic identity; extra printable metadata lives in the added-context slot (index 4).

---

## The Frozen Sync Path

The Nunjucks-compatible **synchronous** compiler path is frozen. It still uses positional `createSyncRuntimeError(error, lineno, colno, label, path)` and idempotent `runtime.handleError(e, ...)`. Do **not**:

- rewrite those call sites as part of async error cleanup;
- construct legacy `TemplateError` directly in `catch` blocks;
- modify legacy top-level `lineno`/`colno` error handling.

All **new** async error handling uses the compact `errorContext` objects and the runtime classes/helpers in this guide (`RuntimeError`, `PoisonError`, `PoisonErrorGroup`, per-block `try/catch`).

---

## Inspection & Aggregation

For reading errors out of values (the script-facing `is error` / `#` peek and their runtime backing):

- **`isPoison(value)`** — sync brand check for an existing `PoisonedValue`. Does *not* await; not a test for whether a promise will reject.
- **`isPoisonError(err)`** — `instanceof PoisonError` (true for groups too). Use in `catch`.
- **`isRuntimeError(err)`** — fatal-error check.
- **`isError(value)`** *(async)* — awaits a promise/marker and reports whether it resolved to poison or rejected. Backs script `is error`.
- **`peekError(value)`** — returns the underlying `PoisonError`/`PoisonErrorGroup` (or `null`/a promise of it) for a value. Backs script `#` peek. Returns `null` for healthy values — always check `is error` before peeking.
- **`collectErrors(values)`** *(async)* — awaits **all** values (even after finding errors), extracts and **deduplicates** poison errors. The engine's "never miss any error" core; rethrows any non-poison throw as fatal.

Never use `instanceof` for poison detection in engine code — always the `is*` helpers.

`PoisonErrorGroup` aggregate fields (see [`script.md`](../cascada/script.md#anatomy-of-an-error-value)): `name` is `'PoisonErrorGroup'`; `errors[]` holds **all** children sorted by source location; `totalErrorCount` is the full count; `kind`/`kinds` summarize child kinds; `cause`/`context`/`lineno`/`colno`/`path`/`label` are inherited from the first child so single- and multi-error consumers share code. `message` is capped (`POISON_GROUP_ERROR_LIMIT = 10`); `errors` is not.

---

## Decision Cheat Sheet

**An operation just failed (caught a throw / rejection).** Did a *value* fail, or did normal/engine flow fail? Catching a throw is **not** enough to justify poison.
- A value-producing op threw, or a value-carrying promise rejected → poison: `createPoison(PoisonError.wrap(err, ctx, kind))` (or `.create`). Return it as a value (sync) or throw the poison error (async).
- A sync throw from normal/engine flow, or a non-value (orchestration) promise rejected → `RuntimeError.reportAndThrow(err, ctx)`. Fatal. Never wrap it as poison.

**I need to consume a value that might be a promise/poison/marker.**
- Raw, one value → `resolveThen(value, onValue, onError)`.
- Already resolved by a helper → `thenValue(result, onValue, onError)`.
- Several independent values → `resolveAll([...])` / `resolveDuo(a, b)` (collects all errors).
- Need cleanup around it → `finallyValue(value, onFinally)`.

**I caught a throw while consuming a value.** Pick by what owns recovery:
- Sync point owns the value → `poisonOrReport(err, ctx)`.
- Async point, caller awaits → `rethrowPoisonOrReport(err, ctx)`.
- Observable command result → `poisonOrReportedFatal(err, ctx)`.
- Context-free deep resolver → `poisonOrRethrow(err)`.

**I have a promise that may reject later.** Attach origin with `valueWithOrigin(value, ctx, kind)`.

**I'm at a boundary about to start new work.** Bail out if the render is already aborting: `renderState.throwIfFatalErrorReported()` (or `throwReportedFatal(ec)` when you only hold the context tuple). Report a fatal with `RuntimeError.reportAndThrow` / `renderState.reportFatalError`; the flag is latched first-wins and `raceRootResult` + the buffer iterator wind everything down.

**Don'ts to keep in muscle memory:** never derive poison from anything but a failed value (not a normal-flow sync throw, not a non-value promise rejection); never `await` poison directly; never throw poison synchronously; never `return` poison from an `async` fn (throw instead); never check `isPoison` after `await`; never convert a `RuntimeError` to poison; never short-circuit error collection; never re-contextualize incoming poison.
