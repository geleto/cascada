# Error Handling Analysis

Reference for Cascada's async error-handling architecture. It gives a site-by-site
inventory (§9) of the `catch` blocks in the async runtime and compiler-emitted code
— what each does, why, and whether it is correct, redundant, or a known gap. The
`catch` inventory is exhaustive; fire-and-forget promise-rejection coverage is
current best-known and still being swept (§11), not final proof. Parts of §3 marked
**Planned** (the `kind` taxonomy, NaN handling) and all of §11 are target design,
not current implementation.

**Scope:** the async compiler/runtime only. The frozen synchronous
Nunjucks-compatible path (`handleError(error, lineno, colno, label, path)`,
`cb(err)` callbacks, sync-mode block catches such as `emit.js`'s post-`asyncMode`
catch) is a separate pipeline and is out of scope.

**Status:** the **core model** — the source/consumer/owner contract, the catch
taxonomy, compact contexts, fatal delivery — is implemented across the value path
(`resolve.js`, `call.js`, `lookup.js`, `safe-output.js`, `loop.js`, `commands/*`,
`chains/*`), the structural owners (`async-boundaries.js`, `render-state.js`,
`guard.js`, `buffer-iterator.js`, `inheritance/*`), and compiler-emitted catches.
Sections 1–10 are the reference for that implemented model.
[§11](#11-remaining-work-and-gaps) is the design + plan for what is **not** yet
implemented: the `kind` field (§3), NaN→poison, fatal early-exit, the cleanups and
dedups, and a confirmed process-crashing bug (§11.16). The ordered plan lives in
[`error-handling-implementation.md`](error-handling-implementation.md).

---

## Table of Contents

1. [Primary Goal](#1-primary-goal)
2. [Core Invariants](#2-core-invariants)
3. [Error Types and Roles](#3-error-types-and-roles)
4. [Compact Error Context Ownership](#4-compact-error-context-ownership)
5. [Execution Flow Structure](#5-execution-flow-structure)
6. [Async Execution Patterns](#6-async-execution-patterns)
7. [Sources and Consumers](#7-sources-and-consumers)
8. [Catch Taxonomy](#8-catch-taxonomy)
9. [Site-by-Site Catch Inventory](#9-site-by-site-catch-inventory)
10. [Fire-and-Forget Work](#10-fire-and-forget-work)
11. [Remaining Work and Gaps](#11-remaining-work-and-gaps)
12. [Known Exclusions](#12-known-exclusions)
13. [Verification Targets](#13-verification-targets)

---

## 1. Primary Goal

The runtime delivers fatal errors consistently and keeps value failures separate
from engine failures.

Cascada must never silently turn engine bugs, runtime-contract violations, or
unexpected raw promise rejections into poison. Those failures are observed by a
structural owner and reported as fatal `RuntimeError`s. Poison is reserved for
user/value failures created at a source operation with source-origin context.

Three roles:

- **sources** — places where a user/value failure can originate and become a
  `PoisonError`.
- **consumers** — places that consume already-produced values and therefore only
  preserve incoming poison or report raw failures as fatal.
- **structural owners** — render state, async boundaries, command buffers, and
  chains that catch/report fatal failures and carry diagnostic stack context.

The governing rule:

> Source operations create poison. Consumers assert poison-or-fatal. Structural
> owners report fatal.

---

## 2. Core Invariants

At a value-consumption point, a failing Cascada value has exactly two valid soft
forms:

- **`PoisonedValue`** — synchronous thenable container, detected with
  `isPoison(value)` *before* any `await`; propagated or merged.
- **`PoisonError` / `PoisonErrorGroup`** — observed from a rejected promise value
  after `await`.

Any other error observed while consuming an already-produced value is fatal:
reported as a `RuntimeError`, never wrapped as new poison.

Fatal-vs-poison is mechanically visible:

- `isPoison(value)` — synchronous poisoned-value check before `await`.
- `isPoisonError(error)` — matches `PoisonError` and `PoisonErrorGroup`.
- `isRuntimeError(error)` — matches fatal `RuntimeError`.

`RuntimeError` is always fatal and is never converted to poison.
`PoisonError.wrap(error, ec)` enforces this from the source side: it calls
`throwIfRuntimeError(error)` first, so wrapping a `RuntimeError` re-throws it
instead of degrading it to poison.

`collectErrors(...)` is the one intentional exception to early-exit consumption:
it awaits every entry so no poison error is missed, but still rethrows raw
non-poison failures (`collectThrownError` in `errors.js`).

### What counts as value consumption

1. **Command application** — the buffer iterator drives a command's `apply` and
   resolves command arguments.
2. **Async boundary body** — the body awaits a value to decide command shape or
   control flow (condition, iterable, loaded template, composition target).
3. **Value-transformation helpers** — `memberLookupAsync`, `callWrapAsync`,
   `resolveSingle`/`resolveAll`, safe-output helpers, and similar.

### What is not value consumption

Structural failures outside value consumption — invariant violations, missing
chain declarations, closed-buffer writes, broken control-flow contracts — are
fatal `RuntimeError`s and must not be converted to poison.

---

## 3. Error Types and Roles

Defined in [`src/runtime/errors.js`](../../src/runtime/errors.js).

### `CompileError`

Compile-time / source-position failure. Outside the async runtime poison model.

### `RuntimeError`

Fatal runtime or contract failure; always fatal. Construct/report with
`RuntimeError.create(messageOrError, errorContext, stackBuffer?)`,
`RuntimeError.report(...)`, `RuntimeError.reportAndThrow(...)`. It normally
carries compact origin context, with one last-resort contextless fatal path
(`CONTEXTLESS_FATAL_RUNTIME_CONTEXT`) for internal contract failures with no
context. `RuntimeError.report(existing, context)` is intentionally asymmetric: an
existing `RuntimeError` keeps its own origin, and `context` is used only to locate
the active `RenderState` to report into. `RuntimeError.create(existing, context)`
rejects a second context for an already-built `RuntimeError`.

### `PoisonError`

One non-fatal source-origin value failure; requires compact origin context.
**Current:** `PoisonError.create(message, errorContext)` for engine-created value
failures; `PoisonError.wrap(error, errorContext)` for a user/JS error caught at the
source (existing poison is returned unchanged; a `RuntimeError` is re-thrown).
*(Planned, §11.8: a trailing `kind` argument — see
[Poison `kind`](#poison-kind-failure-category).)*

### `PoisonErrorGroup`

Aggregate of existing poison errors; never invents a new consumption origin.
Build only through `PoisonError.group(poisonErrors)`, which returns the single
normalized `PoisonError` for one-error input and a `PoisonErrorGroup` for
multi-error input. `PoisonErrorGroup extends PoisonError`, so `isPoisonError(...)`
matches both; never branch on `instanceof PoisonErrorGroup`. A group has no single
`kind`; each leaf in `.errors[]` keeps its own `kind`.

### Poison `kind` (failure category)

**Planned (§11.8).** This whole subsection is **target design, not yet
implemented** — no
`PoisonError.create`/`wrap` call passes a `kind` today. `kind` is **internal
diagnostic metadata**: readable on a caught error for inspection/grouping, but not a
stable public API contract — the set of kinds may change, so do not treat it as a
compatibility surface.

Every leaf `PoisonError` will carry a `kind`: a stable string code naming **what
went wrong**. It is **independent of `label`** (tuple slot 2), which names **where
/ which operation frame** the failure occurred in. The two axes form a grid, not a
line:

- The same `label` yields different `kind`s — a function-call frame produces
  `NotAFunction`, `NotCallable`, or `UserCallThrew`.
- The same `kind` appears under many `label`s — a `NullLookup` happens at any
  number of positions.

`kind` is set at the source: `PoisonError.create(message, errorContext, kind)` and
`PoisonError.wrap(error, errorContext, kind)`. `RuntimePromise` carries the `kind`
too (`new RuntimePromise(promise, errorContext, kind)`) so a delayed async
rejection keeps source attribution rather than collapsing to the generic fallback.

This table is the **complete** poison-source enumeration, cross-checked against
every `PoisonError.create` / `PoisonError.wrap` call site in `src/`. Each existing
source is assigned its target `kind`; the two **new** sources being added
(`DestructureMismatch`, `NaNResult`) and the one **planned** kind
(`ImportBindingMissing`) are marked.

| `kind` | Source site | Factory | Status |
|---|---|---|---|
| `NotAFunction` | `call.js` — call target is not a function | `create` | existing |
| `NotCallable` | `call.js` — call target is `undefined`/`null`/falsey | `create` | existing |
| `UserCallThrew` | `call.js` — a user/global/env function threw (`obj.apply`/`fn.apply`) | `wrap` | existing |
| `UnknownVariable` | `environment/context.js` `lookupScript` — bare symbol names an unknown variable/function (script mode) | `create` | existing |
| `NullLookup` | `lookup.js` — script-mode property access on `null`/`undefined` | `create` | existing |
| `LookupThrew` | `lookup.js` — a property getter threw during the read | `wrap` | existing |
| `DataMethodThrew` | `chains/base.js` `_recordError` — a mutating command / data method threw on apply | `wrap` | existing |
| `SequentialPathThrew` | `commands/sequential-path.js` — a `!` path operation threw | `wrap` | existing |
| `IteratorThrew` | `loop.js` — async iterator `.next()`/`for await` threw, or a generator yielded an `Error` | `wrap` | existing |
| `InvalidConcurrentLimit` | `loop.js` — `concurrentLimit` is not a positive number | `create` | existing |
| `ConditionThrew` | emitted `if`/`switch`/`while` boundary — condition/branch/body evaluation threw (`compiler-async.js`, `compiler/loop.js`) | `wrap` | existing |
| `ExpressionThrew` | emitted value boundary — async expression threw (`compiler/boundaries.js`) | `wrap` | existing |
| `ValueRejected` | `RuntimePromise._wrapRejection` and `commands/errors.js` `contextualizeChainError` fallback — a source-origin async value rejected / a raw chain error was contextualized with no more specific `kind` | `wrap` | existing |
| `DestructureMismatch` | `loop.js` — loop value is not an array for multi-variable destructuring | `create` | **new** (§9 / §11.4) |
| `NaNResult` | value-production points (arithmetic / call / lookup / data-method / loop results) — value is `NaN` (see [NaN handling](#nan-handling)) | `create` | **new** (§11) |
| `ImportBindingMissing` | `composition.js` — `from import` names an export the module does not have | `create` | **planned** — today the raw throw flows through `RuntimePromise` as `ValueRejected`; set this `kind` when wrapping the missing-binding throw |

Notes:

- The `kind` field itself is a planned addition — no `PoisonError.create`/`wrap`
  call passes a `kind` today. Implementing it means threading `kind` through the
  two factories and `RuntimePromise`, then passing it at each source above.
- `ErrorCommand` / `TargetPoisonCommand` and `resolve.js`'s `createPoison(group)`
  only **aggregate** existing poison; they are not sources and get no `kind`.
- There is no `DivideByZero` kind: `/` and `%` by zero produce `Infinity`/`NaN`,
  not an exception. The `NaN` outcome is covered by `NaNResult`; `Infinity` stays
  a value (see [NaN handling](#nan-handling) and §12). Add a new `kind` only when a
  real source operation can fail.

### NaN handling

**Planned — target behavior, not yet implemented (§11.9).** Cascada is not JS: a
`NaN` number is a value failure, not a silently propagating
value. It is poisoned **at its production source** — the same discipline as every
other poison source (§7). This keeps the §2/§7 source/consumer split clean: NaN
poison is *created at sources*, never at consumption boundaries. Consumers (output,
call arguments) stay pure consumers and simply receive poison if the value was NaN;
checking NaN at a consumer would turn it into a source (an invariant violation) and
is also incomplete (it misses data-chain and loop-value carriers, verified).
`Infinity`/`-Infinity` stay ordinary values (the check is `Number.isNaN`, never
`!isFinite`), so `1/0 → Infinity` flows normally.

One helper, applied at each value-production point with that source's
`errorContext`:

```javascript
function poisonIfNaN(value, errorContext) {
  if (typeof value === 'number' && Number.isNaN(value)) {
    return createPoison(PoisonError.create('value is NaN', errorContext, 'NaNResult'));
  }
  return value;
}
```

| Production point | Site |
|---|---|
| Arithmetic result | the three operator emitters in `compiler-base-async.js` (`_emitAsyncBinOp`/`_emitAsyncBinFunc`/`_emitAsyncUnaryOp`) |
| Function / filter / env-call result | `callWrapAsync` / `envCallWrapAsync` (the returned value) |
| Property / bare-symbol / context read result | `memberLookupAsync` / `memberLookupScript` / `context.lookupScript` |
| Data-method / mutating-command result | the command-apply result that lands on a chain |
| Loop value | `loop.js`, where each iteration value is bound (array elements are not produced by a lookup/call) |
| Async tail of any of the above | `RuntimePromise` fulfillment (carries the source `errorContext`/`kind`) |

Because every value is poisoned at production, it is already poison by the time it
reaches a consumer — so **functions never receive a `NaN` argument** and **`NaN`
never reaches output or a returned `snapshot()`**, with no check at those
consumption points. The `typeof === 'number'` guard leaves string concat (`"a"+1`),
comparisons, and `in` (booleans) untouched — no per-operator special-casing.

If a `NaN` ever reaches output, a production point was missed — that is an engine
bug, not a data error; an optional dev-only assertion at output can catch it, but it
is **not** a source. `Infinity` stays a value; sync mode is unaffected (poison is
async-only).

### `PoisonedValue`

Synchronous thenable container. Detect with `isPoison(value)` before `await`;
awaiting throws a poison error. Built with `createPoison(typedPoisonError)`, whose
argument must already be a `PoisonError` from `create`/`wrap`/`group` — raw
`Error`s, strings, and arrays are rejected via `reportRuntimeContractError`.

### `RuntimePromise`

Internal wrapper for source-origin async values. **Current:** carries the source
compact error context and, the first time it is observed rejecting, converts the raw
rejection through `PoisonError.wrap(error, errorContext)` (`_wrapRejection`).
*(Planned, §11.8: also carry the source `kind` and pass it to `wrap`.)*
`PoisonError`/`RuntimeError` pass through unchanged; a stray
rejected `PoisonedValue` is normalized through `PoisonError.group(...)`. Each
chaining method returns a new `RuntimePromise`, and the wrapped promise is marked
handled so delayed consumption does not raise process-level rejection warnings.

### Value-shape vocabulary

Cascada values flow wrapped in one of a small set of shapes. Reading
`resolve.js`/`call.js`/`lookup.js` is much easier once you know which one you are
holding and how to discharge it. None of these is removable cruft — each carries a
distinct meaning — but the vocabulary is wide, so this is the map.

| Shape | Detect with | Means | You hold one when |
|---|---|---|---|
| `PoisonedValue` | `isPoison(v)` | synchronous failure container (`.errors[]`); awaiting it throws a poison error | a sync source failed, or poison was merged/propagated |
| `RuntimePromise` | internal (thenable; `Symbol.toStringTag` = `Promise`) | a source-origin **async** value carrying its `errorContext` (+ `kind`); converts a raw rejection to poison on first observation | a `call`/`lookup`/composition result was a promise |
| `RESOLVE_MARKER` | `v[RESOLVE_MARKER]` | an object/array that is itself a normal sync value but has **unresolved async children**; the marker is a hidden promise that resolves/mutates it in place | a structure built by `deepAssign`/`createObject`/`createArray` |
| `RESOLVED_VALUE_MARKER` | `isResolvedValue(v)` | a branded "already resolved at its top-level boundary — do not re-resolve" wrapper; `unwrapResolvedValue(v)` extracts the plain value | the **sync fast path** of `resolveSingle`/`resolveAll` (`makeResolvedValue`) |

Consumption discipline: check `isPoison(v)` **before** any `await`; unwrap
`RESOLVED_VALUE_MARKER` (`unwrapResolvedValue`) before using a value; await/finalize
a `RESOLVE_MARKER` to materialize a lazy structure; never re-wrap a value that is
already one of these shapes.

---

## 4. Compact Error Context Ownership

Compact error contexts are six-element tuples
(`src/runtime/error-context.js`):

```js
[lineno, colno, label, path, addedContext, renderState]
```

- `lineno`, `colno`, `path` — source position.
- `label` (slot 2) — diagnostic-stack identity (`If.Then`, `Switch.Case`,
  `Iteration`, or a source-operation label); the only place a label lives.
- `addedContext` (slot 4) — `null`, or extra printable diagnostic fields (`loop`,
  `macroName`, `callSignature`, `includeName`, `loadName`, `entryName`,
  `methodName`, `componentName`, …). It must not carry `lineno`, `colno`,
  `label`, `path`, or `renderState` (`validateAddedContext`).
- `renderState` (slot 5) — runtime coordination state, not diagnostic metadata.

There is no `{ ec, ...metadata }` wrapper; the tuple is itself the error context.

### Three ownership modes

1. **Static context** — shared prepared `__ec[index]` tuple. Read-only.
2. **Initialized owned context** — clone created at the origin when added metadata
   is already known (e.g. a loop iteration), via `cloneWithAddedContext(...)`.
3. **Dynamic owned context** — clone created at the origin before metadata is
   known (e.g. an async `if`/`switch` boundary), via `emitClonedErrorContext`,
   then mutated with `runtime.mergeAddedContext(...)` / `runtime.setContextLabel(...)`.

The origin AST node is the only place that creates/chooses a context and passes
that same context to every command, helper, and buffer for that origin. Compiler
state may carry inherited added metadata (e.g. `{ loop }`) but never a
region-wide "current context".

### Emission and helpers

- Static origins: `emitErrorContext(...)`, may share prepared contexts.
- Dynamic origins needing later mutation: `emitClonedErrorContext(...)`, then
  `mergeAddedContext`/`setContextLabel`.

ABI helpers (`error-context.js`): `prepareErrorContexts`, `getRenderState`,
`getAddedContext`, `cloneContext`, `cloneWithAddedContext`, `mergeAddedContext`,
`setContextLabel`, `isCompactErrorContext`, `validateAddedContext`. These are
runtime/compiler ABI, not public API.

Context is expanded into a diagnostic object only inside the error classes
(`RuntimeContextError`, `RuntimeError`, `PoisonError`, `PoisonErrorGroup`), and
only when building a message, `getInfo(...)`, or `formatInfo(...)`. Buffers,
helpers, and chains carry compact contexts opaquely. Diagnostic stacks are arrays
of compact contexts, normalized only at formatting time.

---

## 5. Execution Flow Structure

### Synchronous root

The compiled async root is a plain synchronous function. It enqueues commands,
starts async boundaries, and returns a value/promise for the runtime pipeline; it
is never awaited inside the root itself.

- Helpers called from the root do not throw for detectable value failures: sync
  failures return `PoisonedValue`; async failures flow as `RuntimePromise` or
  through a boundary, resolved later by the command iterator.
- A genuine synchronous engine throw escaping the root propagates to the
  environment render function (`renderScriptString`, `renderTemplateString`) — the
  final catch outside the buffer system.
- The async root return value is wrapped in `RuntimePromise` before leaving the
  root (`compiler-async.js`), so a rejected root result carries source context.
- `RenderState.raceRootResult(...)` races the returned root promise against the
  render-state fatal promise; a non-poison/non-runtime rejection there is reported
  fatal before rethrowing.

### Control-flow, waited, and render boundaries

`async-boundaries.js` owns the structural async catches. Each creates a child
`CommandBuffer`, requires a `bufferStackErrorContext` it stores on the child for
stack diagnostics, and checks `renderState.throwIfFatalErrorReported()` before
entering and after the body settles:

- `runControlFlowBoundary(...)` — `if`/`switch`/`include`/loop bodies. Catch:
  `isPoisonError(err)` rethrows; otherwise
  `renderState.reportAndThrowFatalError(err, childStackErrorContext, childBuffer)`.
  Body is intentionally void.
- `runWaitedControlFlowBoundary(...)` — loop completion gated on a child-owned
  waited chain. Same catch. In `finally`, it drains the waited chain only when no
  fatal error has been reported, so cleanup cannot hang on never-settling waited
  commands.
- `runRenderBoundary(...)` — isolated render child not linked into the parent
  tree. Same catch.
- `runValueBoundary(...)` — expression-level chain visibility that preserves
  rejection semantics: it has no catch of its own; the emitted body wraps with
  `PoisonError.wrap(...)` and rethrows to the awaiting expression consumer. The
  returned promise is `markPromiseHandled`.

### Command application

The buffer iterator (`buffer-iterator.js`) is a driver, not a catch site. It
checks `renderState.isFatalErrorReported()` at the top of each advance and calls
`_stopAfterFatalReport()` to finish buffers and unblock pending snapshots without
applying further commands. The apply itself, and its catch, live in the chain
(`chains/base.js` `_applyObservableCommand` / `_applyMutatingCommand`). The
iterator only `markPromiseHandled`s the apply-result cleanup chain.

### Render state and fatal delivery

A single `RenderState` (`render-state.js`) owns fatal delivery for a render call
and all composition participants. It exposes `reportFatalError`,
`reportAndThrowFatalError`, `isFatalErrorReported`, `throwIfFatalErrorReported`,
and the root/fatal race (`raceRootResult`). Reporting preserves an existing
`RuntimeError`'s origin; only the first fatal error is recorded. In a compact
context it lives in tuple slot 5 and is read with `getRenderState(errorContext)`.

### Fatal-state early exit

Once a fatal `RuntimeError` is reported, the render result is already doomed.
Every additional unit of scheduled work — a command applied, a boundary body
entered, a user function invoked, a loop iteration fanned out — is wasted and may
be actively harmful (extra side effects, longer time-to-failure). The runtime
therefore queries `RenderState` at **centralized synchronous choke points** and
stops as early as possible.

Rules:

- Checks are **synchronous**. Never `await` an extra promise only to test fatal
  state; if a boundary returns a value/promise consumed later, let its error
  surface at consumption.
- **Centralize.** Prefer a few high-traffic choke points (command application,
  boundary entry, the call boundary, loop scheduling) over sprinkling checks. One
  check at a funnel covers everything flowing through it.
- Command-buffer early exit must still **finish buffers/chains and unblock pending
  snapshots** so cleanup cannot deadlock — `_stopAfterFatalReport()` does exactly
  this (leaves buffers, releases lanes, resolves iterator completion).
- Root-flow helpers (e.g. `callWrapAsync`) are sync-first and **must not throw**
  on the check; they return without invoking. Boundary bodies use
  `throwIfFatalErrorReported()`, whose throw the boundary catch routes to fatal.

Coverage (centralized choke points):

| Choke point | Site | Mechanism | Status |
|---|---|---|---|
| Command application — the central runtime loop | `buffer-iterator.js` `_advanceLoop` ≈83 | `isFatalErrorReported()` → `_stopAfterFatalReport()` | guarded |
| Control-flow / waited / render boundary entry | `async-boundaries.js` 35/60/90 | `throwIfFatalErrorReported()` before body | guarded |
| Boundary exit, after awaited body settles | `async-boundaries.js` 42/67/97 | `throwIfFatalErrorReported()` after `await` | guarded |
| Waited-chain drain | `async-boundaries.js` 78 | skip drain when fatal | guarded |
| Root result | `render-state.js` `raceRootResult`, `template-runtime.js` 214/224 | race root vs fatal promise | guarded |
| Inheritance invoke / participant root / chain-load loop | `inheritance/instance.js` 95/202, `load.js` 68 | `throwIfFatalErrorReported()` | guarded |
| Component creation | `inheritance/component.js` 145 | `throwIfFatalErrorReported()` before buffers | guarded |
| Composition roots (include/import/from-import) | emitted `composition.js` 81/100/147/166/272 | `throwIfFatalErrorReported()` before child root | guarded |
| Direct `getExported(...)` | `template-runtime.js` 324 | `throwIfFatalErrorReported()` | guarded |
| **User function invocation** | `call.js` `callWrapAsync` / `_callWrapAsyncComplex` | — | **gap** (§11) |
| **Loop iteration scheduling** | `loop.js` `iterate` and the iterate helpers | — | **gap** (§11) |

The two gaps are the most leveraged remaining additions. `callWrapAsync` invokes
the user function **during root/boundary execution, before** the result-command is
applied, so the buffer-iterator gate does not stop it — the call boundary is where
expensive side-effecting work (DB/HTTP/model calls) actually fires after fatal.
Loop scheduling fans out `loopBody` per element; a check before/within the
iteration loop stops the fan-out. Both already have `errorContext` in scope, so
they reach `RenderState` via `getRenderState(errorContext)` with no new threading.

**Not gated, by design.** Expression roots (`compileExpression`) and value
boundaries (`runValueBoundary`) are deliberately *not* fatal-gated. Most
expression roots run in the synchronous root pass, which — single-threaded —
cannot be interrupted by an asynchronous fatal report (the fatal callback runs
only after the sync pass yields), so a check there would essentially never fire.
Where an expression root *is* async it compiles to a value boundary, which is
exempt because its value is consumed later and the error surfaces at consumption
(§6 Pattern 3). The leveraged async re-entry points — command application,
boundary entry, the call boundary, loop scheduling — are the correct places.

### Standalone inheritance root

When a template/script's top-level construct is `extends`,
`renderInheritanceParticipantRoot(...)` (`inheritance/instance.js`) owns its
root/shared buffers. `InheritanceInstance.create(...)` runs chain loading before
any output buffer exists, so a failure there is fatal — there is nothing to
poison. Load failures route through `inheritance/load.js`
(`reportInheritanceLoadError`, cycle detection) and `inheritance/callable.js`
(`resolveInheritanceParent` → `RuntimeError.reportAndThrow`).

---

## 6. Async Execution Patterns

Five patterns appear in compiled and runtime code.

> **Governing rule:** if the async body calls `currentBuffer.addCommand(...)`,
> declares chains, or observes chains in the **caller's** buffer, use a boundary
> (Pattern 2 or 3). If it is pure value loading/transformation producing **no
> commands in the caller's buffer**, use a `RuntimePromise` (Pattern 4).

1. **Synchronous root execution flow.** Plain `function root(...)`; helpers return
   `PoisonedValue`/`RuntimePromise`; commands enqueue synchronously.
2. **`runControlFlowBoundary` / `runWaitedControlFlowBoundary`.** Child buffer; one
   structural catch routes non-poison to render-state fatal; void body. Used by
   `if`, `for`, `each`, `while`, `include`, loop iterations.
3. **`runValueBoundary`.** Child buffer; preserves rejection semantics; non-void
   body returns the resolved expression value. Used by async expressions needing
   chain observation.
4. **`RuntimePromise` (no buffer).** Result stored directly as a command argument;
   rejection converts to `PoisonError` at consumption. Used by `import` loading,
   `from import` binding extraction, import target resolution.
5. **Standalone inheritance root.** `renderInheritanceParticipantRoot` owns its
   buffers; `InheritanceInstance.create` failures are fatal.

An operation that creates its own internal `CommandBuffer`s (e.g.
`InheritanceInstance.create`) still counts as Pattern 4 from the caller's view.

---

## 7. Sources and Consumers

### Source contract

- **Synchronous failure** — return `PoisonedValue` via a conditional check.
- **Async failure** — return `RuntimePromise`, or run inside a structural boundary.
- **Irreducible user/protocol failure** — catch at the operation source and
  create/report the correct error there.

### Synchronous poison sources

| Condition | Location | Mechanism |
|---|---|---|
| Existing `PoisonedValue` input | all helpers/commands | `isPoison(...)` → propagate/merge |
| Template lookup on `null`/`undefined` | `lookup.js` `memberLookupImpl` | returns `undefined` |
| Script lookup on `null`/`undefined` | `lookup.js` `memberLookupScript` | `PoisonError.create(...)` |
| Unknown bare variable/function (script mode) | `environment/context.js` `lookupScript` | `PoisonError.create(...)` |
| Call `null`/`undefined`/non-function | `call.js` `callWrapAsync` | `PoisonError.create(...)` |
| Poisoned call target/args | `call.js`, commands | collect + `PoisonError.group(...)` |
| Poisoned lookup inputs | `lookup.js` | merge `obj`/`val` errors |
| Invalid `concurrentLimit` | `loop.js` `iterate` | `PoisonError.create(...)` → `poisonLoopEffects` |

### Async promise sources (produce `RuntimePromise`)

| Source | Location |
|---|---|
| User/env call promise result | `call.js` `callWrapAsync`, `envCallWrapAsync` |
| Promise-valued property lookup | `lookup.js` `memberLookupAsync`/`memberLookupScript` |
| Import target resolution | `compiler/composition.js` |
| `import` export loading | `compiler/composition.js` |
| `from import` binding extraction | `compiler/composition.js` (per binding) |
| Async root return value | `compiler/compiler-async.js` |
| Component instance creation | `inheritance/component.js` (chain-tracked, marked handled) |

### Permanently irreducible sources

These catch arbitrary user/protocol errors and remain source catches:

- user function invocation — `call.js` (`obj.apply`)
- user getter / property / script-mode lookup — `lookup.js` (`memberLookup*Raw`)
- async iterator `.next()` / `for await` — `loop.js`
- command `apply(...)` — `chains/base.js`, `chains/sequence-chain.js`
- yielded `Error` values from iterators — `loop.js` (`value instanceof Error`)
- standalone inheritance entry/root — `inheritance/instance.js`, `load.js`

**Filters and tests** are not a separate source: they compile to function calls,
so a filter/test throw or promise rejection flows through `call.js` exactly like
any other call (`UserCallThrew` / wrapped via `RuntimePromise`). No filter-specific
error path exists.

---

## 8. Catch Taxonomy

Every catch reduces to **one binary rule**: a *source* creates poison; a
*consumer* asserts poison-or-fatal; a *structural owner* reports fatal. The four
types below are descriptive sub-cases of that rule, not separate rules — keep the
one rule in mind and the types fall out of it.

- **Type A — structural fatal catch.** Owns a runtime structure; reports
  non-poison failures fatal via `renderState.reportAndThrowFatalError(...)`,
  `reportFatalError(...)`, or `RuntimeError.report(...)`. Poison is rethrown
  unchanged.
- **Type B — consumption assertion.** Consuming an already-produced value:
  preserve poison (`isPoisonError(err) → createPoison(err)` or collect), treat raw
  failures as fatal (`RuntimeError.reportAndThrow(err, errorContext)`); never
  create new poison from a raw error.
- **Type C — irreducible source catch.** Surrounds user/protocol code that can
  throw anything; may create new poison (`PoisonError.wrap(err, errorContext)`).
- **Type D — intentional aggregator.** `collectErrors(...)` awaits all entries,
  collects every poison error, rethrows raw failures.
- **Router.** A catch that does not classify but forwards both poison and raw to a
  single outer classifier (loop workers → `iterate()` outer catch).

---

## 9. Site-by-Site Catch Inventory

Line numbers are current at the time of writing; treat the function name as the
stable anchor. Verdict legend: **KEEP** (correct as-is), **REMOVE** (redundant /
dead), **FIX** (behavior gap), **ADD** (missing).

### `runtime/errors.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `PoisonedValue.then` ≈68 | rejection handler call | `isPoisonError→createPoison`, else rethrow | thenable protocol | KEEP |
| `PoisonedValue.finally` ≈84 | `onFinally()` | swallow, return poison | boilerplate | KEEP |
| `RuntimePromise.then/catch` ≈478/486 | wrapped rejection | `_wrapRejection` → `PoisonError.wrap` | source normalization | KEEP |
| `collectErrors` ≈590/594/602 | per-entry await | `collectThrownError`: poison→collect, raw→rethrow | D | KEEP |

### `runtime/resolve.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `resolveValueAndMarkerAsync` ≈199/209 | await promise/marker | `isPoisonError→createPoison`, else `throw err` | B (no local ec; bare rethrow to owner) | KEEP |
| `resolveObjectPropertiesAsync` ≈235 | await marker | same | B | KEEP |
| `resolveSingleAsync` ≈285/301 | await promise/marker | same | B | KEEP |
| `_resolveSingleArrAsync` ≈331 | await `resolveSingle` | same | B | KEEP |
| `resolveArguments` ≈348 | sync `fn.apply` | `Promise.reject(err)` | public API helper | KEEP |
| `createObject` resolver ≈405/415 | re-await settled child | `if (isPoisonError(e)) throw e; throw e;` | dead — both branches identical | **REMOVE** |
| `createArray` resolver ≈477/483 | re-await settled child | same dead pattern | dead | **REMOVE** |

The `createObject`/`createArray` inner per-property try/catch run **after**
`collectErrors(promises)` has already guaranteed no rejection, and both catch
branches do the same `throw e`. They are no-ops; remove the inner `try/catch` and
await directly.

### `runtime/call.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `callWrapAsync` ≈98 | sync `obj.apply` | `createPoison(PoisonError.wrap)` | C source | KEEP |
| `_callWrapAsyncComplex` ≈113 | `await obj` | poison→collect, raw→`reportAndThrow` | B | KEEP |
| `_callWrapAsyncComplex` ≈139 | `collectErrors`/`resolveAll(args)` | poison→collect, raw→`reportAndThrow` | B | KEEP |
| `_callWrapAsyncComplex` ≈180 | `obj.apply` | `createPoison(PoisonError.wrap)` | C source | KEEP |
| `envCallWrapAsync` ≈195 | `fn.apply` | `createPoison(PoisonError.wrap)` | C source | KEEP |

Macro calls short-circuit before these paths (`obj.isMacro` → `obj._invoke`) and
stay promise/poison-transparent — a thrown macro error propagates as fatal rather
than being normalized into FunCall poison.

### `runtime/lookup.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `_memberLookupAsyncComplex` ≈99 | `collectErrors([obj,val])` | raw→`reportAndThrow` | B | KEEP |
| `_memberLookupAsyncComplex` ≈113 | `resolveDuo` | poison→`createPoison`, raw→`reportAndThrow` | B | KEEP |
| `_memberLookupAsyncComplex` ≈130 | `memberLookup` read | `createPoison(PoisonError.wrap)` | C source | KEEP |
| `_memberLookupScriptComplex` ≈185/199/218 | same three | same | B,B,C | KEEP |

The split try/catch (resolve inputs, then read) is intentional: input resolution
is consumption; the property/getter read is the source.

### `runtime/safe-output.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `rethrowPoisonOrFatal` helper | — | `isPoisonError→throw`, else `reportAndThrow` | B helper | KEEP |
| `_suppressValueAsyncComplex` ≈168/179 | await value / `collectErrors` | `rethrowPoisonOrFatal` / `reportAndThrow` | B | KEEP |
| `_ensureDefinedAsyncComplex` ≈233/251 | `collectErrors` / await | `reportAndThrow` / `rethrowPoisonOrFatal` | B | KEEP |
| `_suppressValueScriptComplex` ≈305 | await value | `rethrowPoisonOrFatal` | B | KEEP |
| `_suppressValueScriptComplex` array ≈309 | `resolveAll(val)` | resolves directly, no pre-`collectErrors` | parity gap | **FIX** (optional) |

The script array path resolves with `resolveAll(...)` without first collecting all
errors, unlike the template path (`_suppressValueAsyncComplex`). For full "never
miss any error" parity, collect all poison before resolution.

### `runtime/loop.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `iterateAsyncSequential` ≈186 | `for await` body | `PoisonError.wrap`+`didIterate`, throw | C source | KEEP |
| `iterateAsyncParallel` IIFE ≈270 | `iterator.next()` / body | `PoisonError.wrap`, reject | C source | KEEP |
| `iterateAsyncLimited.getNext` ≈347 | `iterator.next()` | `PoisonError.wrap`, route via `rejectAllScheduled` | C source | KEEP |
| `iterateAsyncLimited.worker` ≈397 | body `runIteration` | route raw/poison to `rejectAllScheduled` | router | KEEP |
| `iterateArrayLimited.worker` ≈561 | body `runIteration` | route to `rejectAllScheduled` (`@todo`) | router | KEEP (clear the `@todo`) |
| `iterate` ≈694 | `await arr` (loop input) | raw→`reportAndThrow`, poison→`poisonLoopEffects` | B | KEEP |
| `iterate` ≈751 | `await maxConcurrency` | same | B | KEEP |
| `iterate` outer ≈827 | whole iteration | `isRuntimeError→throw`, raw→`reportAndThrow`, poison→`poisonLoopEffects` | A classifier | KEEP |

**Asymmetry (FIX).** The destructuring guard `throw new Error('Expected an array
for destructuring')` is **poison** when it fires inside the async-sequential /
async-parallel iterator catches (≈167, ≈254 → the Type-C catch wraps it), but
**fatal** in the three sync/limited paths (`callLoopBodyLimited` ≈448,
`iterateArraySequential` ≈471, `iterateArrayParallel` ≈507), because those throws
reach the `iterate()` outer catch and hit the raw→`reportAndThrow` branch.

**Resolution (decided): poison, per-iteration.** A destructuring shape mismatch is
a runtime value-shape failure (it cannot be a compile error, and it is a sibling
of `lookup.js`/`call.js` `PoisonError.create(...)` data errors), so it belongs on
the poison path. At each `if (!Array.isArray(value))` site, replace the raw throw
with the same poison-fill the existing `isPoison(value)` branch uses:

```javascript
const itemPoison = createPoison(PoisonError.create('Expected an array for destructuring', errorContext));
const args = Array(loopVars.length).fill(itemPoison);
loopBody(...args, /* index, len, isLast, */ errorContext);
```

This poisons only the failing iteration's body effects (parallel-friendly,
deterministic) and removes every raw throw before it reaches the outer catch, so
all five paths behave identically.

Note: `'Expected two variables for key/value iteration'` (≈591, ≈724) is a
separate, loop-level usage error (wrong variable count for an object iterable) and
is currently **consistently fatal** — line ≈724 is thrown before the `try`, so it
escapes `iterate()` entirely. It is not part of this asymmetry; leave it fatal
unless a separate decision makes all loop-shape mismatches poison.

### `runtime/commands/arguments.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `runWithResolvedArguments` ≈52/62 | marker/promise resolution | `classifyCommandArgumentFailure` | B | KEEP |
| `runWithResolvedArgumentsAsync` ≈84/96/102 | await marker/promise | `classifyCommandArgumentFailure` | B | KEEP |

`classifyCommandArgumentFailure`: `isRuntimeError→throw`, `isPoisonError→createPoison`,
else `RuntimeError.reportAndThrow(err, cmd.errorContext)`.

### `runtime/commands/base.js`

`settleResultFrom` ≈62 catches a synchronous `fn()` throw, rejects the command
result, and rethrows — structural boilerplate. KEEP. (`requireCommandErrorContext`
is a constructor invariant, not a catch.)

### `runtime/chains/base.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `_applyObservableCommand` ≈166 (sync + async `.catch`) | `cmd.apply` | `cmd.rejectResult(RuntimeError.report(err, cmd.errorContext))` | A (observable apply is structural) | KEEP |
| `_applyMutatingCommand` ≈181 (sync + async `.catch`) | `cmd.apply` | `_recordError`: runtime→fatal, poison→apply, raw→`PoisonError.wrap` | C source | KEEP |
| `inspectTargetForErrors` ≈368/384 | await value/marker | poison→collect, raw→`throw` | B/D diagnostic | KEEP |
| `finalSnapshot` ≈264 | sync throw | `Promise.reject(err)` | boilerplate | KEEP |

`_recordError` is the chain-mutation source boundary: a raw throw from a mutating
command (e.g. a data method) becomes poison on the chain target;
`isRuntimeError` stays fatal via `_setFatalError`.

### `runtime/chains/sequence-chain.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `_applyCommand` observable ≈59/79 | `cmd.apply` | `cmd.rejectResult(err)` (raw) | A | **FIX** (align) |
| `_applyCommand` mutating ≈72/83 | `cmd.apply` | `_recordError(err, cmd)` | C source | KEEP |

The observable branch rejects with the **raw** error, whereas
`chains/base.js` `_applyObservableCommand` wraps with `RuntimeError.report(...)`.

**Resolution (decided): align with `chains/base.js`.** An observable command apply
that throws is a fatal structural failure, so the propagated rejection value must
be a `RuntimeError`, not a raw error. Convert at the catch site (≈59 async, ≈79
sync) via `cmd.rejectResult(RuntimeError.report(err, cmd.errorContext))`. This is
correct on both counts: `RuntimeError.report/create` takes the raw `err` as the
`cause` (preserving its message, stack, and own properties — the "proper cause"),
and the value stored/propagated is a `RuntimeError`. Converting at the catch is
the earliest point the error is observed, so no raw error ever escapes into chain
state or an awaiting consumer. (The mutating branch already routes through
`_recordError`, which converts/records correctly.)

### `runtime/commands/sequential-path.js`

| Site | Surrounds | Behavior | Class | Verdict |
|---|---|---|---|---|
| `runSequentialPathOperation` ≈83 | `cmd.operation()` | `PoisonError.wrap` → `rejectPoison` | C source | KEEP |
| `runSequentialPathOperation` ≈89 (async rejection) | awaited result | poison→`rejectPoison`, raw→`reportAndThrow` | B | KEEP |

### `runtime/async-boundaries.js`

`runControlFlowBoundary` ≈44, `runWaitedControlFlowBoundary` ≈69,
`runRenderBoundary` ≈99: `isPoisonError→throw`, else
`reportAndThrowFatalError(err, childStackErrorContext, childBuffer)` — **A**, KEEP.
`runWaitedControlFlowBoundary` `finally` skips the waited drain when fatal —
KEEP. `runValueBoundary` has no catch and `markPromiseHandled`s its promise — KEEP.

### `runtime/render-state.js`

`raceRootResult` ≈64: non-poison/non-runtime → `reportFatalError`, then rethrow —
**A**, KEEP.

### `runtime/guard.js`

All structural. `restoreChains`/`repairSequenceChains` command `.catch` ≈97/112/219/227
→ `reportAndThrowFatalError`; `initChainSnapshots` `beginTransaction` ≈56/59 →
push to `sequenceErrors` (collected as guard errors); `settleSequenceTransactions`
setup-rejection ≈242 → `reportAndThrowFatalError`, tx loop ≈272 → collect errors.
KEEP.

### `runtime/buffer-iterator.js`

No catch. Driver only: fatal-state check + `_stopAfterFatalReport`, and
`markPromiseHandled` on apply-cleanup. KEEP.

### `runtime/inheritance/*`

| Site | Behavior | Class | Verdict |
|---|---|---|---|
| `instance.js` `invoke` ≈160 | finish buffer, rethrow (cleanup + fatal) | A | KEEP |
| `instance.js` `renderInheritanceParticipantRoot` ≈216 | `close(error)`, rethrow | A | KEEP |
| `component.js` `createComponentInstance` await target ≈127 | `reportAndThrow` | B→fatal | KEEP |
| `component.js` `invokeConstructor` ≈160 | `close`, `reportAndThrowFatalError` | A | KEEP |
| `component.js` `startComponentInstance` `.catch` ≈201 | poison→skip, raw→`reportFatalError`; `markPromiseHandled` | A | KEEP |
| `component.js` cleanup `.then(()=>instance.close())` ≈168 | bare fire-and-forget | unmarked | **ADD** `markPromiseHandled` |
| `load.js` `resolveLoadedParent`/`loadEntry` ≈37/63 | `reportInheritanceLoadError` | A load | KEEP |
| `callable.js` `resolveInheritanceParent` ≈11/28 | `reportAndThrow` | A/B | KEEP |

### Compiler-emitted catches

| Site | Emitted shape | Class | Verdict |
|---|---|---|---|
| `compiler-async.js` callback-extension ≈132 | `if (!isPoisonError(e) && !isRuntimeError(e)) reportAndThrow(e, ec); throw e;` then wrap return `RuntimePromise` | B | KEEP |
| `compiler-async.js` async `if` ≈423 / `switch` ≈320 | `PoisonError.wrap(e, ec)` → `ErrorCommand` on branch poison chains (no rethrow) | source boundary (wrap re-throws `RuntimeError`) | KEEP |
| `boundaries.js` `compileValueBoundary` ≈66 | `throw runtime.PoisonError.wrap(e, ec)` | source / Pattern 3 | KEEP |
| `emit.js` block catch ≈155 | sync-mode `handleError` + `cb(err)` (guarded by `asyncMode` return above) | frozen sync | KEEP (out of scope) |

The async emitted `if`/`switch` catch converts only raw branch-evaluation failures
to poison on the affected chains; `PoisonError.wrap` re-throws any `RuntimeError`,
so fatal contract failures still propagate.

### Catch redundancy and simplification

This inventory **is** the per-site redundancy analysis. Its conclusion is the
opposite of the common impression: very few catches are redundant — most are
load-bearing. The "many similar try/catch" feeling is **duplication, not
redundancy**, and the fix is **DRY, not deletion** — each catch is the assertion
that enforces the core invariant (§2), so deleting it reintroduces silent
bug-masking.

- **Genuinely redundant (REMOVE):** exactly one — the dead inner per-property
  `try/catch` in `resolve.js` `createObject`/`createArray`, where both branches
  `throw e` and the body runs after `collectErrors(...)` already settled the
  inputs (§9 `resolve.js`, §11.1).

**Dedup candidates.** Behavior-preserving — collapse identical copies behind one
helper. As with the early-exit checks (§5), the question is not only *what* to
dedup but *where the shared helper centrally belongs*; each candidate names its
home rather than defaulting to a per-file copy.

- **Consumer-assertion family → `errors.js`** [§11.12] — the most valuable dedup,
  because it *is* the §2 invariant. The same "caught error at a consumption point"
  logic is hand-rolled in `resolve.js`, `lookup.js`, `safe-output.js`
  (`rethrowPoisonOrFatal`), and `commands/arguments.js`
  (`classifyCommandArgumentFailure`). It reduces to two disposition axes — poison:
  `return createPoison(err)` vs `throw err`; raw fatal:
  `RuntimeError.reportAndThrow(err, ec)` vs context-free bare `throw err` — i.e. a
  small **named** family (≈3 functions), not one flag-parameterized mega-helper.
  Its central home is `errors.js`, which already owns the error model and the
  predicates, so the invariant becomes canonical and cannot drift or be silently
  weakened per file. **Evaluation: recommended** — the variation is bounded, the
  consistency win is real, and distinct named variants keep each call site
  readable.
- **Boundary catch → `async-boundaries.js`** [§11.13] — `runControlFlowBoundary`,
  `runWaitedControlFlowBoundary`, `runRenderBoundary` share the identical
  `isPoisonError(err) ? throw : reportAndThrowFatalError(err, stack, buffer)` catch
  → one shared handler in that file (the `finally` bodies stay per-helper). Local
  to the boundary module — it is structural, not the consumer-assertion concept.
- **Emitted branch-poison catch → compiler emit layer** [§11.14] —
  `compiler-async.js` (if/switch) and `compiler/loop.js` (while) emit the same
  `PoisonError.wrap(e, ec)` + `ErrorCommand`-per-chain → one emit helper.
- **Lazy resolver → `resolve.js`** [§11.15] — `createObject`/`createArray` share a
  near-identical resolver body → one structural helper (after §11.1 removes their
  dead inner catches).

**Evaluate, likely not a clean merge.** `chains/base.js` vs `sequence-chain.js`
`_applyCommand` overlap, but sequence-chain adds target resolution; a merge would
need conditional branching that may obscure more than it saves. Decide at
implementation time.

Criteria for future judgment:

- **Remove** only a *dead* catch — both branches identical, or the try body
  provably cannot throw.
- **Dedup** identical poison-or-fatal catches behind one helper.
- **Do not** strip the non-poison/fatal branch of a catch whose raw branch merely
  *looks* unreachable under the now-complete source contract. Those branches are
  rare in practice but are the safety net that keeps a genuine engine bug fatal
  instead of poison — keep them as assertions.

---

## 10. Fire-and-Forget Work

### Discarded expressions whose result is dropped

`Do` nodes evaluate **expressions** for side effects and discard the result
(`compiler-async.js` `compileDo` calls `compileExpression` then `;`). The child is
any expression — a call, a member read, anything that may return a promise — not
only a call. A discarded thenable is not tracked by a command or awaiting consumer,
so its async rejection can escape command-buffer observation.

The fix is narrow: route any compiler-known discarded async value through the
current command buffer (a sink command), preserve sync-first behavior for discarded
synchronous values, and avoid a generic ambient promise tracker. Keep it
expression-general — not a call-only `callWrapAsyncSink`. See
[Remaining Work](#11-remaining-work-and-gaps).

### Deliberate cleanup promises

`inheritance/component.js` ≈168 defers cleanup:

```javascript
ownerBuffer.getChain(resolvedSideChainName).getFinishedPromise()
  .then(() => instance.close());
```

This is the only bare fire-and-forget promise left; every other internal deferred
promise (including `startComponentInstance`'s `componentInstancePromise`, ≈207)
already uses `markPromiseHandled(...)`. Wrap this one too.

---

## 11. Remaining Work and Gaps

Concrete, scoped items. Everything else in the inventory is **KEEP**. The ordered,
dependency-aware sequencing of these items (phases, fixture/test gates) lives in
[`error-handling-implementation.md`](error-handling-implementation.md); this section
is the spec, that document is the plan.

1. **REMOVE** the dead inner per-property `try/catch` in `resolve.js`
   `createObject` (≈405/415) and `createArray` (≈477/483). Both catch branches
   do `throw e`, and they run after `collectErrors(...)` already settled the
   children. Await the values directly.
2. **ADD** `markPromiseHandled(...)` around the component cleanup promise in
   `inheritance/component.js` ≈168 (§10).
3. **ADD** a discarded-**expression** sink for `Do` nodes so a rejected thenable
   from any discarded child expression (call, member read, …) is observed by the
   current command buffer rather than escaping — expression-general, not call-only
   (§10).
4. **FIX** the loop destructuring-error asymmetry in `loop.js` (§9). Decided
   resolution: make `Expected an array for destructuring` **poison, per-iteration**
   at all five sites (≈167, ≈254, ≈448, ≈471, ≈507) by replacing the raw throw
   with the existing `isPoison(value)` poison-fill pattern. Leave
   `Expected two variables…` (≈591, ≈724) fatal — it is a consistent loop-level
   usage error, not part of the asymmetry.
5. **FIX** (optional) the `_suppressValueScriptComplex` array path in
   `safe-output.js` ≈309 to collect all poison before `resolveAll(...)`, matching
   the template path's "never miss any error" behavior.
6. **FIX** the `sequence-chain.js` observable `_applyCommand` rejection (≈59/79).
   Decided resolution: convert at the catch via
   `cmd.rejectResult(RuntimeError.report(err, cmd.errorContext))`, matching
   `chains/base.js`. The raw `err` becomes the `cause` (proper underlying
   error/stack preserved) and the propagated value is a `RuntimeError`, so no raw
   error escapes into chain state. Convert at the catch — the earliest observation
   point — not later.
7. Clear the `iterateArrayLimited.worker` `@todo` (≈562): the routing is correct
   (raw → `iterate()` outer catch → fatal); the comment is stale.
8. **ADD** the `kind` discriminant (§3): thread `kind` through `PoisonError.create`,
   `PoisonError.wrap`, and `RuntimePromise`, then pass the target `kind` at every
   source in the kind table (including the planned `ImportBindingMissing` at the
   `from import` missing-binding throw).
9. **ADD** NaN→poison ([NaN handling](#nan-handling)): the `poisonIfNaN(value, ec)`
   helper + `NaNResult` kind, applied at the **value-production points** so `NaN` is
   source-created poison (never created at a consumer, preserving §2/§7): the three
   arithmetic emitters (`_emitAsyncBinOp`/`_emitAsyncBinFunc`/`_emitAsyncUnaryOp`),
   the call/lookup/context-read/data-method **results**, the loop-value binding in
   `loop.js`, and `RuntimePromise` fulfillment for the async tail. Consumers (output,
   call args) are **not** checked — the value is already poison by the time it reaches
   them. Regenerate precompiled fixtures. Tests: math→poison, context-`NaN`
   output→poison (not `"NaN"`), `NaN` arg→call poisoned, `NaN` loop element→poison,
   `Infinity` survives, `"NaN"` string survives, poison input still propagates.
10. **ADD** a fatal-state early-exit check to the **call boundary**
    ([Fatal-state early exit](#fatal-state-early-exit)): in `callWrapAsync` /
    `_callWrapAsyncComplex`, before invoking the user function, test
    `getRenderState(errorContext).isFatalErrorReported()` and return without
    invoking (sync-first; do not throw). Highest-value gap — it stops expensive
    side-effecting calls after a render has already failed.
11. **ADD** a fatal-state early-exit check to **loop scheduling** in `loop.js`
    `iterate(...)`: before/within the iteration loop, stop fanning out `loopBody`
    once `isFatalErrorReported()`. Must still finish the loop's buffers/chains so
    cleanup cannot deadlock.
12. **DEDUP** the consumer-assertion family into `errors.js` (§9 dedup) — the §2
    invariant, currently hand-rolled in four places. Provide three small **named**
    helpers (not one flag-parameterized helper), each `isPoisonError(err) ?
    <poison> : <fatal>`:
    - `poisonOrReport(err, ec)` → `createPoison(err)` / `RuntimeError.reportAndThrow(err, ec)`
      — for sync-first consumers that return a value (`lookup.js`,
      `commands/arguments.js`'s `classifyCommandArgumentFailure`).
    - `rethrowPoisonOrReport(err, ec)` → `throw err` / `RuntimeError.reportAndThrow(err, ec)`
      — for async consumers that reject (`safe-output.js`'s `rethrowPoisonOrFatal`).
    - `poisonOrRethrow(err)` → `createPoison(err)` / bare `throw err` — context-free,
      for `resolve.js`'s ~6 catches (`resolveValueAndMarkerAsync`,
      `resolveObjectPropertiesAsync`, `resolveSingleAsync`, `_resolveSingleArrAsync`).

    No separate `isRuntimeError` guard is needed: `isPoisonError(runtimeError)` is
    `false`, so a `RuntimeError` takes the fatal branch, and
    `RuntimeError.reportAndThrow`/`report` already preserves an existing
    `RuntimeError`'s origin (and the render-state report dedups), so
    `classifyCommandArgumentFailure`'s explicit guard collapses away.
    Behavior-preserving.
13. **DEDUP** the identical boundary catch
    (`isPoisonError(err) ? throw : reportAndThrowFatalError(err, stack, buffer)`)
    shared by `async-boundaries.js` `runControlFlowBoundary`,
    `runWaitedControlFlowBoundary`, and `runRenderBoundary` into one shared
    handler. Behavior-preserving; the `finally` bodies stay per-helper.
14. **DEDUP** the emitted branch-poison catch (`PoisonError.wrap(e, ec)` +
    `ErrorCommand` per poison chain) shared by `compiler-async.js` (async
    `if`/`switch`) and `compiler/loop.js` (`while`) into one emit helper.
15. **DEDUP** the near-identical `createObject`/`createArray` lazy-resolver bodies
    in `resolve.js` into one shared lazy-container helper. Do **after** §11.1
    removes their dead inner `try/catch`.
16. **FIX (confirmed bug)** — duplicate fatal delivery causes an **unhandled
    promise rejection**. A fatal `RuntimeError` thrown from an async boundary is
    delivered twice: once to the render (handled, via the render-state fatal
    promise / `raceRootResult`) and once as the **boundary promise's own
    rejection**, which is unobserved and crashes the process under Node's default.
    Minimal repro: `{% for x in obj %}{{ x }}{% endfor %}` with `obj = {a:1,b:2}`
    (the `Expected two variables` throw at `loop.js:724`, outside `iterate`'s
    `try`); the render rejects correctly but the boundary copy leaks. Root cause:
    `reportAndThrowFatalError` both reports (→ delivery guaranteed via the fatal
    promise) and re-throws (→ boundary promise rejects). Fix: once the error is
    reported to `RenderState`, the boundary/loop-completion promise that re-throws
    it must be `markPromiseHandled` (or the completion consumer must swallow the
    already-reported rejection).
    **Breadth (measured):** the leak is **one per loop (waited control-flow)
    boundary** that surfaces a fatal — top-level, inside `if`, and inside a macro
    each leak 1; a loop nested in a valid outer `for` over a 2-element array leaks
    3 (outer + 2 inner), so it scales per failing loop instance. `if`/`switch`/macro
    containers add none, so the fix targets the **loop boundary/completion promise**
    specifically. (A fatal originating *directly* in an `if`/`switch` boundary
    could not be tested — no easy user-reachable fatal originates there, and
    `throwOnUndefined` did not raise one in this build.)
    A guard test is in place but skipped: `tests/poison/fatal-delivery.js`
    (`it.skip('a boundary fatal does not also surface as an unhandled rejection')`)
    — un-skip it when this is fixed.

### Re-audit checklist when adding an async source

- new sources create/wrap poison at the origin (`PoisonError.create`/`wrap`, or
  `RuntimePromise`);
- new consumers assert poison-or-fatal (`isPoisonError(err) → createPoison`, else
  `RuntimeError.reportAndThrow`);
- new structural owners report fatal through render state or the `RuntimeError`
  APIs and attach the child-buffer diagnostic stack.

### Open evaluation areas (stable, deterministic, efficient)

§9–§11 settle *which* failures are poison vs fatal. These cover the three quality
axes. Status tags: **DECIDED** (resolved here), **REQUIRED** (a must-do
audit/task, no judgment left), **VERIFIED**/**RESOLVED** (already settled, no work).

**Deterministic** — same input must yield the same error output regardless of
async timing.

- **Parallel-loop multi-failure (VERIFIED OK for value errors).** Tested:
  unbounded **and** limited (`of N`) loops with four failing iterations collect
  **all four** errors, **identically across 8 runs**. Value/poison errors
  accumulate on the body chain (source-ordered → complete and deterministic), not
  through `rejectAllScheduled`. The `rejectAllScheduled` first-wins path only
  carries *structural* body-completion failures (fatal-class, where surfacing one
  is acceptable). No change needed; covered by
  `tests/poison/fatal-delivery.js` (unbounded + limited, asserted identical across
  runs).
- **First-fatal-wins (DECIDED — accept).** Fatal errors need not be deterministic;
  the first reported wins. The priority is to close everything as fast as possible
  and not crash — see the fatal early-exit checks (§11.10–11) and the §11.16 crash
  fix. Do not buffer or compare racing fatals.
- **Aggregate order (DECIDED — completeness required, order best-effort).**
  Run-to-run order determinism under concurrency is not required (too hard). The
  hard requirement is **completeness — never miss an error**. For readable,
  stable-ish output, sort the aggregated errors by source position (`path`,
  `lineno`, `colno`) with deterministic tiebreakers before building the group.
  Tracked as an action (poison-aggregation work).
- **Dedup stability (RESOLVED — non-issue).** Iteration order does not affect
  dedup: an error's origin context is fixed at creation and `PoisonError.wrap`
  preserves it, so every instance sharing a cause carries the same context whatever
  the order. The only order-sensitive case — the same raw `Error` wrapped at two
  different sources — is a contract anomaly the source model prevents. No work.

**Stable** — no hangs, no unobserved rejections, no unbounded growth.

- **Duplicate fatal delivery → unhandled rejection (CONFIRMED BUG, see §11.16).**
  A fatal thrown from an async boundary is delivered twice — once to the render
  (handled) and once as the boundary promise's own unobserved rejection — crashing
  the process under Node's default. Verified with a minimal repro. The render
  early-exit itself is sound: `raceRootResult` settled the render in ~1 ms without
  waiting for pending async work.
- **Unbounded aggregation (DECIDED — cap with kind summary).** Cap the
  `PoisonErrorGroup` message. When the cap is reached, the header summarizes the
  full set before the capped list: e.g. `N errors (showing <cap>) of K kinds
  (kind1, kind2, kind3)`. Counts and kinds come from the fully-collected set (all
  entries are already awaited), so completeness is preserved; also cap the retained
  `.errors[]` to bound memory for pathological failures. Uses the `kind` field — so
  this depends on the kind work (§11.8). Tracked as an action.
- **Unobserved-rejection sweep (REQUIRED).** Beyond the §11.2/§11.3 gaps and the
  confirmed §11.16 bug, sweep every fire-and-forget promise — `loop.js` worker
  promises, guard setup/detection promises — for a rejection with no handler. The
  §11.16 finding shows there may be more.
- **Internal pending-promise leak (REQUIRED).** The render does not hang
  (`raceRootResult` verified), but audit whether `_stopAfterFatalReport` leaves any
  pending observable command result promise (snapshot, `getError`, sequential-path
  read, guard capture/restore) unsettled, and settle it if so.
- **Single-classification (REQUIRED).** Audit that a thrown error cannot be both
  poisoned and fatal-reported, or wrapped as poison twice with different context.

**Efficient** — low priority. Speed is not a major concern, but avoid pathological
slowness.

- **Lazy diagnostic formatting (worth doing — clarity, not just speed).**
  `RuntimeContextError`'s constructor eagerly builds *both* `compactMessage` and
  `fullMessage` (two `formatDiagnosticMessage` calls) and normalizes the diagnostic
  stack on every construction, even though most poison is propagated/grouped/
  discarded and never displayed. Build them lazily (on `getInfo`/`formatInfo`/
  `.message` access). This also simplifies the constructor, so it earns its place on
  clarity grounds regardless of the speed win.
- **Sanity checks only (no surprises expected).** The NaN check cost
  (`typeof`+`Number.isNaN` at call-arg/output/arithmetic sites), the `inspectTargetForErrors`
  `_errorStateCache` (repeat reads should be O(1)), poison allocation
  (`PoisonedValue` + `PoisonError` + dedup `Map`), and per-command
  `cloneWithAddedContext` clones (Phase N kept eager). Act only if something
  profiles as pathologically slow.

### Simplification priorities

A goal of the implementation is to *simplify*: clear rules, minimal high-impact
places, and removal of cruft — code that is easy to reason about. The model
already trends this way (one rule; a `kind` string instead of a subclass zoo;
centralized fatal checks). Sequence the items above by leverage:

1. **Centralize first — one place, clarity everywhere.** §11.12 (consumer-assertion
   family → `errors.js`) is the single highest-impact change: it turns every
   hand-rolled "poison or fatal?" catch into one named call, so a reader *sees* the
   §2 invariant applied rather than re-deriving it. §11.16 (fatal delivery) and lazy
   diagnostic formatting likewise put one concern in one place.
2. **Then the mechanical removals/dedups** (§11.1 REMOVE, §11.13–15 DEDUP) — shrink
   surface without changing behavior.
3. **Then behavioral fixes and features** (§11.4, §11.6, §11.8–11).

Additional clarity wins (not yet tracked as actions):

- **A value-shape vocabulary map.** The runtime carries several value wrappers —
  `PoisonedValue`, `RuntimePromise`, `RESOLVE_MARKER` (lazy container), and
  `RESOLVED_VALUE_MARKER` / `makeResolvedValue` (sync fast-path). Each is justified,
  but the vocabulary is wide; a one-paragraph map of "what each wrapper means and
  when you hold one" would cut the cost of reading `resolve.js`/`call.js`.
  Document, do not remove.
- **Lead the catch rules with the single binary rule.** §8's A/B/C/D taxonomy is
  accurate but descriptive; the *rule* is binary (source → poison; consumer →
  assert poison-or-fatal; owner → report). Keeping A/B/C/D as sub-cases under that
  one rule keeps the mental model small.

Leave alone — essential complexity, not cruft (over-simplifying here moves
complexity rather than removing it):

- the six-slot compact context and its three ownership modes — necessary for
  dynamic boundaries; Phase N already evaluated and kept it;
- the frozen sync-mode error path — backwards-compat, out of scope;
- the context-free bare-`throw` variant in `resolve.js` consumers — threading an
  `errorContext` in only to unify the fatal disposition would spread plumbing into
  every resolve call site;
- the four boundary helpers — §11.13 dedups their shared catch; fully merging them
  into one parameterized helper would obscure their real differences (waited drain,
  rejection semantics).

---

## 12. Known Exclusions

- **Binary operator *throws*.** Operator *results* are handled: arithmetic that
  yields `NaN` becomes poison (`NaNResult`, see [NaN handling](#nan-handling)), and
  `Infinity` (`1/0`) stays a value. What remains out of scope is an operator that
  *throws* — `in` on a non-object, BigInt/number mixing, a throwing
  `valueOf`/`Symbol.toPrimitive`. Those compile to bare expressions inside the
  `resolveDuo(...).then(([left,right]) => left OP right)` form, so a throw rejects
  that plain promise; inside a boundary the boundary catch receives it, at root it
  reaches the environment layer. Converting operator throws to poison uniformly
  would require wrapping each operator application in try/catch (a single
  `OperatorThrew` kind), which is a separate change from the `NaN`-result work.
- **Sync compilation mode.** `cb(err)`, `handleError(...)`, and sync-mode block
  catches are a frozen pipeline; do not rewrite them here.
- **Component boundary redesign.** Component creation owns isolated component
  buffers today. Letting component calls fill the caller's boundary buffer
  directly, plus a resilient-loading option (composition load failures emit
  `ErrorCommand`s instead of reporting fatally), is a separate architecture
  change, not required for the current fatal-error model.

---

## 13. Verification Targets

For focused changes:

- `npm run mocha -- tests/pasync/error-context.js tests/poison/unit.js`
- `npm run mocha -- tests/poison/fatal-delivery.js` — loop error completeness +
  the §11.16 unhandled-rejection guard (the latter is `it.skip` until §11.16 is
  fixed)
- the relevant feature files for the changed area (e.g. `tests/pasync/component.js`,
  `tests/pasync/loops.js`)
- new discarded-call tests when `compileDo(...)` gains a sink
- `npm run build`

For broad error-handling changes:

- `npm test`
