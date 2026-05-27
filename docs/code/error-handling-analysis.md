# Poison System Simplification

Design reference for refactoring Cascada's async error-handling architecture.

**Scope:** Async compilation mode only. The legacy sync-mode pipeline (`handleError`,
`cb(err)` callbacks) is a separate architecture and is not addressed here.

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Core Invariant](#2-core-invariant)
3. [Execution Flow Structure](#3-execution-flow-structure)
4. [Poison Sources and the Source Contract](#4-poison-sources-and-the-source-contract)
5. [Async Execution Patterns](#5-async-execution-patterns)
6. [Render Fatal State and Early Exit](#6-render-fatal-state-and-early-exit)
7. [Composition and Loading](#7-composition-and-loading)
8. [Fire-and-Forget Calls](#8-fire-and-forget-calls)
9. [Consumption Points: From Conversion to Assertion](#9-consumption-points-from-conversion-to-assertion)
10. [Known Gaps and Exclusions](#10-known-gaps-and-exclusions)
11. [Migration Path](#11-migration-path)

---

## 1. Overview and Goals

### The problem

Error conversion is scattered across ~35 try/catch blocks in runtime helpers
(`resolve.js`, `call.js`, `loop.js`, `safe-output.js`, and others). Most of
them do the same thing:

```javascript
catch (err) {
  if (isPoisonError(err)) return createPoison(err.errors);
  return createPoison(err);   // ← the problem line
}
```

The last line treats every unexpected error as a data error. This means:

- Genuine engine bugs are silently swallowed and turned into poisoned output
  instead of surfacing as fatal errors.
- The same conversion logic is duplicated at every consumption site instead of
  living at the origin.
- There is no mechanical enforcement of which errors are legitimate data errors
  and which are bugs.

### The goal

Move error-to-`PoisonError` conversion to the **origin** — the point where a
user-controlled value enters the system as an async result. Every downstream
consumer then **asserts** rather than converts: a non-`PoisonError` at a
consumption point is a bug, not a data error.

This reduces the meaningful try/catch count from ~35 to ~11, eliminates silent
bug masking, and makes the error model mechanically enforceable.

---

## 2. Core Invariant

At every value-consumption point in the async runtime, exactly two outcomes
are valid for a failing value:

- **`PoisonedValue`** (synchronous) — detected via `isPoison()` before any
  `await`; propagated or merged into the consuming expression.
- **`PoisonError`** (async) — the only error type that a rejected user-value
  promise is permitted to carry when it reaches a consumer.

Any other error arriving at a consumption point is a **`RuntimeFatalError`** —
a bug in the engine, not a data error. A later taxonomy cleanup may fold that
signal into `RuntimeError` with an explicit fatal marker/property, but the
fatal-vs-poison distinction must remain mechanically visible at every
consumption point.

### What counts as value consumption

A value is consumed at three structural points:

1. **Command application** — the command iterator resolves command arguments
   and calls `cmd.apply(chain)`.
2. **Async boundary body** — the body awaits a value to decide command shape
   or control flow (a condition, an iterable, a loaded template, a composition
   target).
3. **Value transformation helpers** — pure functions that resolve inputs and
   return new values: `memberLookupAsync`, `callWrapAsync`, `resolveSingle`,
   `safe-output` helpers, `deepAssign`, and similar.

### What is not value consumption

Structural runtime failures that occur outside value consumption — invariant
violations, missing chain declarations, closed-buffer writes, engine bugs —
are `RuntimeFatalError`s and must not be converted to poison. A future taxonomy
cleanup may represent the same state as `RuntimeError` with a fatal marker.
Converting them to poison would mask the bug and produce incorrect output
silently.

---

## 3. Execution Flow Structure

### The synchronous root

The compiled root function is a **plain synchronous function**, not `async`:

```javascript
function root(env, context, runtime, renderState) {
  const reportError = renderState.reportError;
  // Synchronous: adds commands to buffer, calls helpers, fires boundaries
  t_1 = runtime.callWrapAsync(context.lookupScript("fetchUser", ...), ...);
  output.addCommand(new runtime.VarCommand({ args: [t_1] }), 'a');

  let t_3 = runtime.runControlFlowBoundary(output, ..., async (currentBuffer) => {
    // ... async body; fills child buffer as side effect
  }, ...);

  output.finish();
  return t_n;  // a promise; never awaited here
}
```

Consequences:

- Helpers called from the root flow must **not throw**. Detectable error
  conditions (null access, non-function calls, poisoned inputs) are handled
  via conditionals that return `PoisonedValue` directly. Async failures are
  returned as `RuntimePromise` so they flow into command arguments and are
  resolved later by the command iterator.
- Awaiting is allowed only at structural value-consumption points: command
  application, async boundary/control/load work, and value transformation
  helpers. Async boundary bodies already have one structural catch; throws from
  sync helpers inside a boundary body are automatically caught by that catch.
- Async boundary bodies in emitted code are **intentionally void** — their
  output is the side effect of filling a child buffer, not a return value as
  an expression. The boundary promise itself is tracked via
  `emitLimitedLoopCompletion` for loop-completion ordering, but no calling
  code consumes the body's return value as an expression result.

### The environment layer

When `root()` itself throws synchronously (a genuine engine error, not a data
error), the throw propagates to the environment's render function
(`renderScriptString`, `renderTemplateString`). This outer layer is the final
catch for structural failures that escape the buffer system. It is not part of
the poison model.

### Standalone inheritance root

When a template uses `extends` as its top-level construct, root delegates
entirely to `renderInheritanceParticipantRoot`, which is async and owns its
own buffer pipeline. Its entry-level `.catch()` is the equivalent of the
environment layer for that case.

---

## 4. Poison Sources and the Source Contract

Every value that can fail must satisfy the source contract:

- **(A) Synchronous failure** — return `PoisonedValue` via a conditional check.
  No try/catch needed or wanted.
- **(B) Async failure** — wrap the result as `RuntimePromise` before it enters
  the value graph. `RuntimePromise` converts any non-`PoisonError` rejection to
  `PoisonError` at the moment the promise is first consumed.

### Synchronous sources (already correct — use conditionals)

| Condition | Location | Mechanism |
|---|---|---|
| Input is already `PoisonedValue` | All helpers | `isPoison()` check → return/merge |
| Property access on `null`/`undefined` | `lookup.js` | `if (obj == null) return createPoison(...)` |
| Deep-assign into null path | `deep-assign.js` | Conditional null check |
| Calling a non-function | `call.js` | `typeof obj !== 'function'` check |
| Calling `null`/`undefined`/falsy | `call.js` | `!obj` check |
| Poisoned arguments passed to a call | `call.js` and all helpers | `isPoison()` per-arg check |
| Data method type errors / divide-by-zero | `data-methods.js` → `call.js` | Method throws synchronously; caught at call site |

These sources do not need try/catch blocks because the error condition is
detectable before any throwing code runs.

### Async sources and current wrapping state

`callWrapAsync` (`call.js:92,170`) and `memberLookupAsync` / `memberLookupScript`
(`lookup.js:89,110,164,187`) already return `new RuntimePromise(result, errorContext)`
for their async paths. These sources are **already wrapped**; they only need the
`RuntimePromise` conversion change described below.

Sources that currently return **plain Promises** and need `RuntimePromise` wrapping:

| Source | File | Async path |
|---|---|---|
| `import` / `from import` loading | emitted by `composition.js` | `.then()` chain — not yet `RuntimePromise` |
| Deep-assign internal async paths | `deep-assign.js` | Awaited as plain promise — audit needed |

`loop.js` and `safe-output.js` do not produce values themselves — they
receive values that originate at `callWrapAsync`, `memberLookupAsync`, or
composition load sites, all of which will be `RuntimePromise`-wrapped once
Phase 2 is complete. The catches in those files need their non-`PoisonError`
fallback branches **hardened**, not new wrapping added.

### Permanent irreducible async sources

User-supplied **async iterables** (plain objects implementing
`Symbol.asyncIterator`) are a third category of permanently irreducible
source alongside user function calls and user generator `.next()` calls. An
async iterable's `.next()` method can throw any error. It is not and cannot
be wrapped as `RuntimePromise` — the object's type is opaque to the compiler.
The three `loop.js` protocol catches that handle these throws are permanently
irreducible (see §9 irreducible inventory).

### The RuntimePromise change

`RuntimePromise` currently contextualizes errors (adds source position) when
`.then()` or `.catch()` is invoked, but does **not** convert them to `PoisonError`.

Required change to `RuntimePromise.then()` and `.catch()`:

```javascript
then(onFulfilled, onRejected) {
  const wrappedOnRejected = onRejected && (err => {
    const pe = isPoisonError(err)
      ? err
      : new PoisonError([contextualizeError(err, this.errorContext)]);
    return onRejected(pe);
  });
  const p = this.promise.then(onFulfilled, wrappedOnRejected);
  return new RuntimePromise(p, this.errorContext);
}
```

`catch()` receives the same treatment. This is a **single change to one class**.
All callers that already return `RuntimePromise` — `callWrapAsync`, `lookupAsync`
— inherit the conversion automatically and require no further changes.

Sources that currently return plain Promises must be changed to return
`new RuntimePromise(promise, errorContext)` instead.

---

## 5. Async Execution Patterns

Five patterns appear in compiled and runtime code. Using the wrong pattern
either creates unnecessary `CommandBuffer` instances or misses command ordering.

### The governing rule

> If the async body calls `currentBuffer.addCommand(...)`, declares chains, or
> observes chains in the **caller's** buffer — use a boundary (Patterns 2 or 3).
>
> If the async operation is purely loading or transforming a value and produces
> **no commands in the caller's buffer** — use a `.then()` chain (Pattern 4).

An operation that creates its own internal `CommandBuffer`s (for example,
`InheritanceInstance.create` creates `rootBuffer` and `sharedRootBuffer`)
still qualifies as Pattern 4 from the caller's perspective, because it does
not interact with the caller's buffer.

### Pattern 1 — Synchronous root execution flow

- Plain `function root(...)`, no `async`, no try/catch.
- Helpers return `PoisonedValue` or `RuntimePromise`; never throw.
- Commands added synchronously; promises flow as command arguments resolved
  later by the command iterator.
- **Used by:** all simple scripts and templates at root scope.

### Pattern 2 — `runControlFlowBoundary` / `runWaitedControlFlowBoundary`

- Creates a child `CommandBuffer`.
- One structural catch inside the runtime function; errors route to `reportError`.
- Async body is **intentionally void** — fills the child buffer as a side effect.
- **Used by:** `if`, `for`, `each`, `while`, `include`, individual loop iterations.

### Pattern 3 — `runValueBoundary`

- Creates a child `CommandBuffer`.
- **Preserves rejection semantics** — errors re-throw to the awaiting expression
  consumer rather than routing through `reportError`.
- Body typically has an inner try/catch to convert non-`PoisonError` to
  `PoisonError` before re-throwing; this inner catch becomes an assertion once
  the source contract is fully enforced.
- Async body is **non-void** — returns the resolved expression value.
- **Used by:** expressions requiring async resolution with chain observation
  (ternary conditions, function calls on async values, snapshot reads inside
  async expressions).

### Pattern 4 — `.then()` chain + `RuntimePromise` (no buffer)

- **No child buffer created.**
- Result is a `RuntimePromise` stored directly as a command argument in the
  parent buffer.
- `RuntimePromise` converts any rejection to `PoisonError`; the command
  iterator catches it when resolving the argument.
- **Used by:** `import` namespace loading, `from import` binding extraction —
  any pure loading or value-transformation operation that touches no chains.

### Pattern 5 — Standalone inheritance root

- `root()` delegates entirely to `renderInheritanceParticipantRoot(...)`.
- Creates and owns `rootBuffer` and `sharedRootBuffer`.
- Has a `.catch()` at the return site for structural errors.
- Errors during `InheritanceInstance.create` (the chain-loading init await)
  are **fatal** — no chain infrastructure exists yet to poison.
- **Used by:** templates and scripts whose top-level construct is `extends`.

---

## 6. Render Fatal State and Early Exit

Fatal delivery and early exit should be owned by a single render-scoped state
object created before the top-level async render enters compiled code. This
state is separate from poison: poison represents value-consumption failure,
while fatal state represents a render that can no longer produce valid output.

Target API:

```javascript
renderState.reportFatalError(error)
renderState.isFatalErrorReported()
renderState.throwIfFatalErrorReported()
```

The top-level render promise or callback should settle from this render-owned
state outside compiled code and outside generic runtime helpers. Compiled roots
and composition entry points can still receive the callable reporting function
where needed, but "already reported" state and early-exit behavior should live
in the render state object.

Use `throwIfFatalErrorReported()` only at coarse async interleaving points:

- before entering async boundary bodies;
- after awaited boundary work settles and before continuing;
- before invoking composition roots such as include/import/export roots;
- before command-buffer command application if command execution would
  otherwise continue after a fatal render error.

Do not force-await promise values that are intentionally returned for later
value consumption. Their errors should surface when those values are consumed.
Do not sprinkle fatal-state checks through ordinary synchronous expression code:
sync code should be stopped by the nearest coarse check. Review each call site
before adding it; a function that already returns a promise usually only needs
the check when it can skip meaningful work at the start or before applying
user-visible effects.

Do not add a promise-wait abstraction unless a concrete local-hang case proves
it is needed. Value-consumption failures continue to flow through poison, while
non-`PoisonError` exceptions observed at async boundaries, command execution,
and resolve/value-consumption points are fatal runtime errors.

Direct async `getExported(...)` execution is a compatibility case: the method
returns the exported object synchronously while individual exported values may
still be promises. In the final architecture, direct export execution should
create or receive render fatal state before entering the compiled root, rather
than creating ad hoc local `reportedError`/`reportError` closures.

Focused tests should cover:

- a fatal error in one concurrent branch prevents later async-boundary work
  from continuing;
- include/import/export composition roots stop when fatal state is already
  reported;
- command-buffer execution does not keep applying user-visible commands after
  the render is fatal, while required cleanup still runs.

---

## 7. Composition and Loading

### `include` — already correct (Pattern 2)

`compileAsyncInclude` uses `_compileAsyncControlFlowBoundary`. Template loading
(`env.getTemplate`, `resolveSingle`, `compile`) and `_renderIncludeText` all
happen inside the boundary body with no inner try/catch. The boundary's single
catch handles all failures. **No changes needed.**

### `import` (namespace) — Pattern 4, needs `RuntimePromise` wrapping

Already emits a plain `.then()` chain — the buffer-free shape is correct.
Gap: the chain is a plain `Promise`, not `RuntimePromise`.

Fix: wrap the loading chain:

```javascript
let t_exportedId = new runtime.RuntimePromise(
  runtime.resolveSingle(t_id).then((resolvedTemplate) => {
    resolvedTemplate.compile();
    return runtime.resolveSingle(resolvedTemplate.getExported(null, reportError));
  }),
  errorContext
);
output.addCommand(new runtime.VarCommand({ args: [t_exportedId] }), target);
```

### `from import` (named bindings) — restructure IIFE to Pattern 4

Currently emits one raw async IIFE per binding:

```javascript
let t_5 = (async () => { try {
  let exported = await t_exportedId;
  if (hasOwn(exported, "helperFunc")) return exported["helperFunc"];
  var err = runtime.contextualizeError(new Error("cannot import 'helperFunc'"), ...);
  throw err;
} catch(e) { var err = runtime.contextualizeError(e, ...); throw err; } })();
```

Replace with a `.then()` chain wrapped as `RuntimePromise`. Each binding
independently hangs off the shared `exportedId` promise — this preserves the
current behaviour where one missing binding does not prevent others from
resolving:

```javascript
let t_5 = new runtime.RuntimePromise(
  Promise.resolve(t_exportedId).then((exported) => {
    if (hasOwn(exported, "helperFunc")) return exported["helperFunc"];
    throw new Error("cannot import 'helperFunc'");  // RuntimePromise adds context
  }),
  __ec[5]
);
```

The per-binding IIFE and its try/catch disappear. One `RuntimePromise` per
binding, all independent of each other, all hanging off the same `exportedId`.

### Standalone `extends` — unchanged (Pattern 5)

Chain loading (`InheritanceInstance.create`) runs before any output buffer
exists. A failure here cannot be expressed as poison — there is nothing to
poison. This case is explicitly **excluded** from any resilient-loading flag.
Fatal behaviour is correct and permanent.

### Components (proposed design change)

**Current behaviour:** `createComponentInstance` creates its own isolated
`rootBuffer` (`new CommandBuffer(componentContext, null, ...)`) with no parent
link.

**Proposed:** when a component is called from inside a `runControlFlowBoundary`
body, the caller's `currentBuffer` becomes the component's `rootBuffer`. The
component rendering pipeline fills the caller's buffer directly. This requires
changes to `createComponentInstance` and the way `InheritanceInstance.create`
is invoked from composition call sites.

Benefits: no extra buffer per component; the caller's one boundary catch
handles all component errors.

**Resilient-loading flag:**

- Scope: a per-render option (`{ resilientLoading: true }`).
- Effect: when composition loading fails inside a `runControlFlowBoundary`, the
  boundary's error path emits `ErrorCommand`s to the affected chains rather than
  calling `reportError` fatally. The component's output chains are poisoned;
  the rest of the render continues.
- Does **not** apply to standalone `extends` (no chains exist on failure).
- Relationship to `ignoreMissing`: `ignoreMissing` treats a missing file as
  absent (returns empty/null, not an error). `resilientLoading` treats a
  loading *failure* (network error, parse error, missing file with
  `ignoreMissing: false`) as poison output. They are complementary and can be
  combined.

---

## 8. Fire-and-Forget Calls

Two structurally distinct sub-cases. Both result in promises whose rejections
go unobserved; each requires a different fix.

### Sub-case A — Standalone function call (result discarded by the compiler)

`log("hello")` compiles to:

```javascript
runtime.callWrapAsync(context.lookupScript("log", ...), "log", context, ..., output);
// ← return value discarded
```

- Sync errors: `callWrapAsync` catches them and returns `PoisonedValue` — which
  is then silently discarded.
- Async errors: the `RuntimePromise` returned by `callWrapAsync` is not tracked
  anywhere — unhandled rejection.

The problem exists at both root level and inside boundary bodies. Inside a
boundary, a sync throw from the call IS caught by the boundary's structural
catch — but a rejected promise from the call's async result still goes
untracked.

**Fix:** the compiler distinguishes `Do` nodes (standalone calls) from
assignments. For `Do` nodes, emit `runtime.callWrapAsyncSink(...)` instead of
`runtime.callWrapAsync(...)`.

`callWrapAsyncSink` adds a minimal tracking command to `currentBuffer` for the
returned promise. This routes both sync and async errors into the buffer's
error system without producing a chain value. No caller needs to consume the
result.

### Sub-case B — Cleanup fire-and-forget (deliberate, untracked)

`component.js:151`:

```javascript
ownerBuffer.getChain(resolvedSideChainName).getFinishedPromise()
  .then(() => instance.close());
```

This is deliberate deferred cleanup: when the side chain finishes, close the
component instance. `instance.close()` is synchronous and does not throw under
normal conditions. The promise is intentionally unobserved.

**Fix:** mark it as intentionally unobserved to suppress unhandled-rejection
warnings:

```javascript
markPromiseHandled(
  ownerBuffer.getChain(resolvedSideChainName).getFinishedPromise()
    .then(() => instance.close())
);
```

`markPromiseHandled` attaches a no-op rejection handler that prevents Node's
warning. No sink command is needed here — errors on this path indicate an
engine bug and do not belong in the chain error system.

---

## 9. Consumption Points: From Conversion to Assertion

### Catch-type taxonomy

Not all catch blocks are the same. There are four distinct types:

- **(A) Full assertion** — the catch block is replaced entirely by a bare
  `throw new RuntimeFatalError(err)`, because the `PoisonError` branch was
  also just forwarding and can be removed.
- **(B) Partial assertion** — the catch block stays; only the non-`PoisonError`
  fallback branch (`return createPoison(err)` or similar) is replaced by
  `throw new RuntimeFatalError(err)`. The `PoisonError` branch stays because
  it does real work (forwarding, collecting, routing).
- **(C) Irreducible** — the catch is needed forever; user code or protocol
  mechanics can throw anything here regardless of source wrapping.
- **(D) Intentional aggregator** — the catch is designed to collect ALL errors
  including non-`PoisonError`. These must **not** become assertions; they are
  the foundation of the error-collection system.

The prototype pattern for Type B is:

```javascript
// Before
catch (err) {
  if (isPoisonError(err)) return createPoison(err.errors);
  return createPoison(err);              // ← problem line
}

// After (Type B — catch block stays, fallback hardened)
catch (err) {
  if (isPoisonError(err)) return createPoison(err.errors);
  throw new RuntimeFatalError(err);      // ← non-PoisonError is a bug
}
```

### Per-file simplification

**`resolve.js`** (~10 catches → partial assertions)
Most catches follow the Type B pattern: `createPoison(err)` fallback branches
become `throw new RuntimeFatalError`. Note that some catches
(`resolveValueAndMarkerAsync`, `_resolveSingleArrAsync`) already `throw err`
for non-`PoisonError` — they are partially hardened already and only need
the `PoisonError` branch reviewed.

**`call.js`** (4 catches: 2 Type B + 2 Type C)
- Lines ~110 and ~133 in `_callWrapAsyncComplex` — await `obj` and
  `resolveAll(args)`. These catches push errors into a local `errors` array
  and **continue execution** (they do not re-throw). The catch blocks must
  stay. Only the non-`PoisonError` fallback branch is hardened (Type B).
- Lines ~95 and ~174 — the actual `obj.apply(ctx, resolvedArgs)` invocations
  → **Type C** (user functions throw; irreducible).

**`lookup.js`** (2 catches → Type B)
Both async path catches forward `PoisonError` and will only ever see
`PoisonError` once `RuntimePromise` conversion is active. Non-`PoisonError`
fallback becomes `RuntimeFatalError`.

**`loop.js`** (8 catches across 7 functions)

The outer catch in `iterate()` already has partial `RuntimeFatalError`
behavior (`if (!asyncOptions || isRuntimeFatalError(err)) { throw err; }`).

The 8 catches divide as:

| Location | Type | Action |
|---|---|---|
| `iterate()` arr-await catch | B | Keep `poisonLoopEffects`; harden non-`PoisonError` branch |
| `iterate()` maxConcurrency-await catch | B | Same |
| `iterate()` outer catch | B | Already has `isRuntimeFatalError` guard; harden remaining fallback |
| `iterateAsyncSequential` `for await..of` catch | C | Irreducible — `for await` drives `.next()` internally; any throw (generator or loop body) emerges here |
| `iterateAsyncParallel` IIFE catch | C | Irreducible — explicit `iterator.next()` may throw; also catches loop body errors |
| `iterateAsyncLimited` `getNext` catch | C | Irreducible — explicit `iterator.next()` |
| `iterateAsyncLimited` `worker` catch | B→A | Routes body errors; loop bodies fill buffers and should not throw; harden to `RuntimeFatalError` |
| `iterateArrayLimited` `worker` catch | B→A | Same; also has `@todo` comment acknowledging this |

The three async-iterator protocol catches (`iterateAsyncSequential`,
`iterateAsyncParallel`, `iterateAsyncLimited.getNext`) are irreducible
because user-supplied async iterables can throw from `.next()` regardless of
source wrapping. `iterateAsyncSequential` uses `for await..of` (the runtime
calls `.next()` internally); the other two use explicit `.next()` calls. All
three represent the same irreducible contract: the generator protocol allows
`.next()` to throw, and that throw is not a `PoisonError`.

**`safe-output.js`** (4 catches → Type B)
`_suppressValueAsyncComplex`, `_ensureDefinedAsyncComplex`, and
`_suppressValueScriptComplex` currently do `throw new PoisonError([contextualizeError(err, ...)])` 
in their non-`PoisonError` catch branches — a different pattern from the
`createPoison(err)` fallback seen elsewhere. Under the new model, upstream
values are `RuntimePromise`-wrapped, so these non-`PoisonError` branches
become unreachable and can be replaced by `throw new RuntimeFatalError(err)`.

**`deep-assign.js`** (2 catches → Type B)

**`commands/arguments.js`** (3 catches → Type B)

**`sequential-path.js`** (2 catches) and **`sequence-chain.js`** (1 catch)
These await results of previous sequential operations. Once sequential path
async results are confirmed to be `RuntimePromise`-wrapped, these become
Type B assertions. A full audit of the sequential path's async sources is
required.

**`chains/base.js`** (4 catches)
- `_applyCommand:159` — catches sync throws from `cmd.apply(this)` → **Type C**
  (command application; irreducible).
- `finalSnapshot:236` — converts a sync throw to a rejected promise → **Type C**
  (structural boilerplate).
- `inspectTargetForErrors:356,370` — inspects a value tree for errors →
  **Type B** once all inspected values are `RuntimePromise`.

### Command-application catch topology

`command-buffer.js:234` (buffer iterator applies `cmd.apply(chain)`) and
`chains/base.js:159` (Chain's `_applyCommand`) are **different code paths**,
not duplicates. The buffer iterator drives command execution; the chain handles
the apply internally. Both catches are needed.

### Irreducible and aggregator catch inventory

| File | Count | Type | Reason |
|---|---|---|---|
| `async-boundaries.js` | 3 | C | Structural catch for all boundary body throws |
| `command-buffer.js` | 1 | C | Buffer iterator — command application |
| `chains/base.js` `_applyCommand` | 1 | C | Chain-level command application |
| `call.js` user invocations | 2 | C | User function calls; user code throws |
| `loop.js` async-iterator protocol | 3 | C | `.next()` may throw regardless of source wrapping |
| `errors.js` `collectErrors` | 3 | D | Intentional error aggregator — must collect any error |
| `inheritance/instance.js` | 1 | C | Standalone inheritance entry point |
| **Total** | **14** | | vs current ~35 meaningful conversion sites |

---

## 10. Known Gaps and Exclusions

### Binary operator throws

Operators (`+`, `-`, `*`, `/`, `%`, `in`, `**`) compile to raw JS expressions
with no error handler. An object with a throwing getter, for example, produces
an uncaught throw. Inside a boundary, the boundary's structural catch receives
it. At root level, it propagates to the environment's render function.

The model makes no attempt to convert these to poison. Adding operator helpers
(analogous to `callWrapAsync`) would be needed to handle this uniformly. That
is out of scope for this refactor.

### `RESOLVE_MARKER` lazy container resolution

`createObject()` / `createArray()` start background resolution of async
properties immediately. `resolveObjectPropertiesAsync` walks these containers
and has its own catches.

The per-property catches inside `createObject`/`createArray` already use
`throw new PoisonError([e])` rather than `createPoison(err)`. Under the new
model, if all property values are `RuntimePromise`, then `e` at those catch
sites will always be `PoisonError`. `new PoisonError([PoisonError])` is handled
correctly by the `PoisonError` constructor, which flattens it. No structural
change is needed at these sites once upstream values are wrapped; they are
already producing `PoisonError`.

A full audit of all property-setting sites to confirm they produce
`RuntimePromise` (not plain Promise) has not been done.

### `peekError` / `collectErrors`

`collectErrors` in `errors.js` is a **Type D intentional aggregator** (see
§9 taxonomy). It is explicitly designed to collect any error — `PoisonError`
or otherwise — from any value, promise, or `RESOLVE_MARKER`-backed container.
Its catches must not become `RuntimeFatalError` assertions. They are the
foundation of the "never miss any error" principle.

`peekError` delegates to `collectErrors` and inherits this property.

These functions are correctly classified in the irreducible inventory in §9.
No changes to their catch logic are required.

### Sync compilation mode

The `cb(err)` callback pattern, `handleError`, and all sync-mode error
propagation are not addressed. They are a separate pipeline.

---

## 11. Migration Path

Each phase is independently testable — the full test suite must pass after
every phase before proceeding.

### Phase 1 — Extend `RuntimePromise` (conversion at source)

Change `RuntimePromise.then()` and `.catch()` to convert non-`PoisonError`
rejections to `PoisonError` as described in §4.

Add a **dev-mode assertion** in `resolve.js` catch blocks alongside the
existing `createPoison(err)` fallback:

```javascript
catch (err) {
  if (isPoisonError(err)) return createPoison(err.errors);
  // Dev-mode: log a warning — this means a source is not yet wrapped
  console.warn('Non-PoisonError at consumption point:', err);
  return createPoison(err);  // fallback stays for now
}
```

This tightens semantics without breaking anything. The warnings identify
unwrapped sources. Sources already using `RuntimePromise` (`callWrapAsync`,
`lookupAsync`) immediately begin converting errors to `PoisonError` with no
further changes.

### Phase 2 — Wrap remaining async sources

For sources still emitting plain Promises:

- `deep-assign.js` — wrap internal async paths as `RuntimePromise`.
- `composition.js` emitted code — restructure `import` and `from import` to
  Pattern 4 with `RuntimePromise` as described in §7.

`loop.js` and `safe-output.js` are consumers, not sources. Their values come
from `callWrapAsync`, `memberLookupAsync`, and composition load sites, which
will all be `RuntimePromise`-wrapped after this phase. No wrapping is needed
inside those files; their catch branches are hardened in Phase 3.

Dev-mode warnings from Phase 1 should go silent as each source is wrapped.

### Phase 3 — Harden consumers

Once Phase 2 warnings are gone for a given file, replace the `createPoison(err)`
fallback in its catch blocks with `throw new RuntimeFatalError(err)`. Do this
file by file, running the test suite after each.

Remove the dev-mode warning code once all files are hardened.

### Phase 4 — Compiler and fire-and-forget cleanup

- Add `callWrapAsyncSink` runtime function (§8, sub-case A).
- Update the compiler to emit `callWrapAsyncSink` for `Do` nodes.
- Apply `markPromiseHandled` to `component.js:151` (§8, sub-case B).
- Restructure `from import` IIFEs to `RuntimePromise` `.then()` chains.

### Phase 5 — Component boundary model (design change)

- Restructure `createComponentInstance` to accept an external `rootBuffer`
  (the caller's `currentBuffer`) instead of creating its own.
- Move component call sites from standalone invocation to inside
  `runControlFlowBoundary`.
- Implement the resilient-loading flag.

This phase requires careful integration testing of all composition scenarios
(component method calls, `super()`, shared chains) against the new buffer
topology.

### Verification at each phase

- Full `npm run test:node` after every change.
- Targeted tests in `tests/poison/` for any new assertion paths (confirm that
  `RuntimeFatalError` is thrown, not `PoisonError`, for engine-level errors).
- For Phase 5, integration tests covering all inheritance scenarios:
  `extends`, component calls, nested components, `super()`, shared chains.
