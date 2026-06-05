# Error Handling Implementation Plan

Ordered, dependency-aware plan for the work tracked in
[`error-handling-analysis.md`](error-handling-analysis.md) §11. The analysis
document is the **spec** (what/why, decided resolutions, the model); this document
is the **sequence** (order, dependencies, files, fixtures, test gates). Do not
duplicate rationale here — link to the analysis section instead.

Guiding objective (analysis §11 "Simplification priorities"): centralize first,
then mechanical removals/dedups, then behavioral fixes, then features; keep the
"leave alone" list intact. Each phase is independently shippable and must leave the
suite green before the next.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done.

## Dependencies at a glance

- §11.15 (dedup `createObject`/`createArray` bodies) requires §11.1 first (removes
  their dead inner catches). §11.1 lands in Phase 0, §11.15 in Phase 1.
- §11.17 (load-failure policy, Phase 4) depends on the `kind` field (Phase 3) so
  load failures are created with `LoadFailed` from the first implementation, with no
  follow-up retrofit.
- §11.9 (NaN, Phase 5) requires the `kind` field (Phase 3).
- Poison aggregation (the kind-summary cap header) uses `kind`, so it lands **in**
  Phase 3 alongside the kind field — producer + first consumer together.
- `resolve.js` is touched by §11.1 (Phase 0), §11.12 + §11.15 (Phase 1); do the
  Phase 1 ones together.
- Phase 12 introduces `NotIterable`; Phase 13's `in`→poison may reuse it, so do 12
  before 13 (or give the `in` case its own kind).
- Phase 14 (`text.set` multi-arg) **removes** Phase 10's `text.set` arity validation
  entirely (the compile-time `_failInvalidTextSetArity` in `buffer.js`/`chain.js` and the
  runtime fatal); value rules fall back to the normal `InvalidTextValue` text-output check.
- Phases that change **emitted** code regenerate precompiled/browser fixtures:
  Phase 1 (§11.14 emit helper), Phase 3 (`kind` in emitted composition),
  Phase 4 (load-failure — emitted composition sites), Phase 5 (NaN emitters),
  Phase 6 (discard observer), Phase 10 (`ExpressionThrew`/`text.set` compile-time),
  Phase 13 (typed-operand emitters).
  Fixture regen is an automated build step, so the objective order (cleanup → fixes →
  features) is preferred over batching it.
- Phase order follows the objective: **Phase 0** stability/safe foundation ·
  **Phase 1** centralize & dedup · **Phase 2** behavioral fixes + early-exit +
  audits · **Phase 3** `kind` foundation · **Phase 4** load-failure policy ·
  **Phase 5** NaN→poison · **Phase 6** discarded-expression observer ·
  **Phase 7** efficiency · **Phase 8** docs sweep · **Phase 9** `!` side-effect
  completion semantics (resolved: docs only) ·
  **Phase 10** poison `kind` taxonomy refinement.
- Post-Phase-10 follow-ups (surfaced during review): **Phase 11** retired
  `SequentialPathThrew` · **Phase 12** lookup/iteration strictness
  (`ScalarLookup`/`NotIterable`, `NotAnArray`→`NotDestructurable`) · **Phase 13**
  script-language operator strictness (`in`→poison, strict `==`, typed operands) ·
  **Phase 14** text-chain multi-arg · **Phase 15** documentation closeout & consistency (final).
- **Docs are dual-tracked:** Phase 8 documented the core model (through Phase 6); each later phase
  (10–14) carries its own "Docs:" step; **Phase 15** is the final cross-surface consistency pass.

---

## Phase 0 — Foundation: safe wins, the crash, the rejection sweep

Goal: clear the trivially-correct items, the confirmed crash, and the bug class it
belongs to. No dependencies, no fixtures.

- [x] §11.2 — `markPromiseHandled(...)` on the component cleanup promise
  (`inheritance/component.js` ≈168).
- [x] §11.7 — delete the stale `iterateArrayLimited.worker` `@todo` (`loop.js` ≈562).
- [x] §11.1 — remove the dead inner per-property `try/catch` in `resolve.js`
  `createObject`/`createArray`; await the values directly.
- [x] §11.16 — fix duplicate fatal delivery (the confirmed process-crashing
  unhandled rejection). Locate the loop boundary/completion promise that re-throws
  an already-reported fatal and `markPromiseHandled` it (or have the completion
  consumer swallow the already-reported rejection). Then **un-skip** the guard in
  `tests/poison/fatal-delivery.js` and confirm it passes. Verify breadth across all
  loop forms (analysis §11.16 "Breadth").
- [x] **Unobserved-rejection sweep** (same bug class as §11.16) — audit every
  fire-and-forget promise (`loop.js` workers, guard setup/detection) for a rejection
  with no handler; `markPromiseHandled` or route as appropriate.

Verify: `npm run mocha -- tests/poison/fatal-delivery.js tests/pasync/loops.js` ·
`npm run build`.

---

## Phase 1 — Centralize & dedup (clarity, behavior-preserving)

Goal: the §2 invariant in one named place, plus the mechanical dedups (analysis
§11.12–15, §9 dedup). All behavior-preserving.

- [x] §11.12 — add three named helpers to `errors.js`: `poisonOrReport(err, ec)`,
  `rethrowPoisonOrReport(err, ec)`, `poisonOrRethrow(err)` (signatures in §11.12; no
  `isRuntimeError` guard — it collapses). Replace the hand-rolled copies in
  `resolve.js` (~6 catches), `lookup.js`, `safe-output.js` (`rethrowPoisonOrFatal`),
  `commands/arguments.js` (`classifyCommandArgumentFailure`).
- [x] §11.15 — dedup `createObject`/`createArray` resolver bodies into one shared
  lazy-container helper (in `resolve.js`; do in the **same phase** as §11.12, which
  also edits `resolve.js`, to avoid re-churn — the §11.12 helpers themselves live in
  `errors.js`).
- [x] §11.13 — one shared boundary catch handler in `async-boundaries.js` for
  `runControlFlowBoundary`/`runWaitedControlFlowBoundary`/`runRenderBoundary`
  (`finally` bodies stay per-helper).
- [x] §11.14 — one emit helper for the branch-poison catch shared by
  `compiler-async.js` (if/switch) and `compiler/loop.js` (while). Touches emitted
  code → regenerate fixtures.

Verify: `npm run mocha -- tests/poison/ tests/pasync/error-context.js
tests/pasync/conditional.js` · regenerate fixtures (§11.14) · `npm run build`.

---

## Phase 2 — Behavioral fixes, early-exit, and stability audits

Goal: runtime correctness, before features (analysis §11.4–6, §11.10–11, §11 "Open
evaluation areas — Stable" REQUIRED). Mostly runtime-only.

- [x] §11.4 — make `Expected an array for destructuring` poison-per-iteration at all
  five `loop.js` sites (replace the raw throw with the existing `isPoison`
  poison-fill). Leave `Expected two variables…` fatal.
- [x] §11.6 — `sequence-chain.js` observable `_applyCommand` rejection → report raw
  failures via `RuntimeError.report(...)` while preserving existing poison.
- [x] §11.5 (optional) — `_suppressValueScriptComplex` array path collects all
  poison before `resolveAll(...)`.
- [x] §11.10 — call-boundary early exit: in `callWrapAsync`/`_callWrapAsyncComplex`/
  `envCallWrapAsync`, when a fatal is already reported on the render state, rethrow
  that original fatal **without invoking** the user function, via
  `throwReportedFatal(errorContext)` from `error-context.js`. The enclosing boundary
  catch re-reports (dedup → first-fatal-wins, origin preserved) and cleans up. Do
  **not** replace loop `isFatalReported(...)` gates with this throw helper
  (fire-and-forget / local poison-wrapping catches — controlled stop, §11.11), and do
  not add this to lookups. Test: after a fatal, the call wrappers **throw
  `renderState.error`** (assert `thrown === renderState.error`) and do **not** invoke
  the target.
- [x] §11.11 — loop-scheduling early exit: stop fanning out `loopBody` once fatal,
  still finishing the loop's buffers/chains (no deadlock).
- [x] **Internal pending-promise leak** (audit) — whether `_stopAfterFatalReport`
  leaves any pending observable command result promise (snapshot, `getError`,
  sequential-path read, guard capture/restore) unsettled; settle it if so. (No render
  hang — `raceRootResult` verified.) Audit result: fatal-stop now rejects abandoned
  result commands before discarding their lanes.
- [x] **Single-classification** (audit) — a thrown error cannot be both poisoned and
  fatal-reported, or wrapped as poison twice with different context. Audit result:
  Phase 2 changes preserve the existing poison/fatal split and use idempotent
  `RuntimeError.report(...)`/`PoisonError.wrap(...)` paths.

Verify: `npm run mocha -- tests/pasync/loops.js tests/poison/
tests/pasync/sequential-expressions.js tests/poison/fatal-delivery.js` ·
`npm run build`.

---

## Phase 3 — `kind` field + poison aggregation (feature; fixtures)

Goal: one stable failure-category per leaf poison, and bounded/readable groups built
on it (analysis §3, §11.8, §11 "Open evaluation areas" — Aggregate order +
Unbounded aggregation). Producer + first consumer together.

- [x] §11.8 — thread `kind` through `PoisonError.create`, `PoisonError.wrap`, and
  `RuntimePromise` (carry + apply on `_wrapRejection`); pass the target `kind` at
  every source in the analysis §3 kind table, including `ImportBindingMissing` at the
  `from import` missing-binding throw. This intentionally changes async `from import`
  missing bindings from fatal `RuntimeError` to poison; sync-compiled mode keeps its
  legacy fatal path.
- [x] Cap the `PoisonErrorGroup` message; when the cap is reached, the header
  summarizes the full set before the capped list: `N errors (showing <cap>) of K
  kinds (kind1, kind2, kind3)`. Counts/kinds from the fully-collected set (all already
  awaited) — completeness preserved; retain the full structured `.errors[]` and cap
  only `message` / `fullMessage` presentation.
- [x] Sort aggregated errors by source position (`path`, `lineno`, `colno`) with
  deterministic tiebreakers before building the group. Order determinism is **not**
  required; completeness (never miss an error) **is**.
- [ ] *(Postponed, fixture-coupled — unrelated to `kind`/aggregation.)* Close the
  **sync-root cleanup caveat** (analysis §5 "Fatal-unwind cleanup ownership", R1): the
  async compiled root finishes its buffer on the success path only, so a call-wrapper
  rethrow from the synchronous root skips `output.finish()`. Wrap the emitted root
  body in `try/finally` so `output.finish()` runs on any exit. Folded here only
  because this phase already regenerates fixtures; do **not** pay a separate fixture
  regen for it. Leak (not hang), so it stays optional — skip if it complicates the
  emit and revisit with the next emit-touching phase.
- [ ] *(Postponed / optional cleanup.)* Simplify the redundant group-time
  `requirePoisonKind(...)` reads in `_collectKinds` / `_sortErrorsBySource` once this
  area is touched again. Construction already enforces the invariant; the duplicate
  guard is harmless on the error path.
- [ ] *(Postponed / loop fragility cleanup.)* Replace loop-else reads that depend on
  `err.errors[err.errors.length - 1]?.didIterate` with an explicit iterator-error
  marker before changing loop aggregation again. Group sorting means `.errors[]`
  order is source-order, not "last thrown"; current paths are single-leaf, but the
  pattern is brittle.

Verify: `npm run mocha -- tests/poison/ tests/pasync/error-context.js
tests/pasync/composition.js` (kind, group cap/summary/order) · regenerate fixtures ·
`npm run build`.

---

## Phase 4 — Load-failure policy (feature; fixtures)

Goal: value-producing loads can fail non-fatally instead of crashing the render
(analysis §11.17 / [Load-failure policy]). Structural loads (`root`/`extends`) stay
always-fatal. Depends on Phase 3 `kind` so non-fatal load failures are created with
`PoisonError.wrap(err, ec, 'LoadFailed')` from the first implementation.

**Scope: async-compiled mode only.** This applies to the async compiler/runtime path
(the one the error model governs). Sync-compiled templates keep their existing
nunjucks behavior (`ignore missing` already works there) — untouched.

### Decisions (locked)

- **Configuration** — one env option `loadFailFatal: true | false | LoadKind[]`
  (default `true`, nunjucks-compatible), where `LoadKind = 'import' | 'component' |
  'include'`. The `'import'` kind governs **both** `import` and `from import` (one
  module load). Per-kind granularity lives in the array; mode-independent (scripts and
  templates).
- **Non-fatal shape is fixed by what the load produces** — `import` / `from import` /
  `component` → **poison** (only coherent shape for a value/namespace); `include` →
  **silent/empty** (poison-`include` ≈ fatal, so omission is the useful behavior).
- **Structural loads always fatal** — `root` / `extends` are never in scope.
- The per-kind env array **replaces** the earlier sketched `soft`/`hard` per-site
  markers (dropped). The only per-site knob is the existing `ignore missing`
  (include-only silent override, works even when the global default is fatal).

### Failure span — what the policy covers (per kind)

The policy governs **the whole act of obtaining and materializing the dependency**,
*after a concrete target name has been resolved* — not just the `getTemplate`/
`getScript` rejection. Per kind, the non-fatal path covers:

- **import / from import** (`'import'`) — load (reject / not-found) **+**
  `resolvedTemplate.compile()` **+** `getExported(...)` namespace materialization.
- **component** (`'component'`) — load **+** compile **+** instance bootstrap.
- **include** (`'include'`) — load **+** compile **+** render-start.

Excluded everywhere, stays the **existing expression poison/fatal path** (NOT
`LoadFailed`): the **target-name expression itself**. `{% include getName() %}` where
`getName()` rejects is a failed value producing the name, not a loader failure — the
emitted `resolveSingle(<name expr>)` already handles it. The policy runs **only after**
a concrete name resolves. Also excluded: a successfully-loaded module's own **render**
errors (normal nested flow) and a **missing named export** in a loaded module (the
separate `ImportBindingMissing` / "cannot import" path at `composition.js:189`,
unchanged here).

### Configuration + validation

- [x] Add `loadFailFatal` to `BaseEnvironment` (`base-environment.js` constructor,
  alongside `throwOnUndefined` in `this.opts`) — **not** an emitted constant or a
  template compile option. The runtime helper reads `env.opts.loadFailFatal` at
  **render** time, so precompiled artifacts honor the running env.
- [x] **Validate + normalize at env init**: `loadFailFatal` must be `true`, `false`,
  or an array containing only `'import' | 'component' | 'include'`. Invalid value or
  array entry → **fatal config error thrown at construction** (do not silently ignore).
  Normalize to one canonical form (e.g. a `Set` of fatal kinds; `true`→all, `false`→
  none) for `isLoadFailureFatal` to read; duplicates collapse.
- [x] **Array semantics**: a supplied array is a **fatal allowlist** — listed kinds
  are fatal, unlisted value-producing kinds are non-fatal. (`extends`/`root` are always
  fatal and never appear.)

### Runtime helpers (two helpers; in `errors.js`)

- [x] `runtime.isLoadFailureFatal(env, kind)` → boolean from the normalized
  `env.opts.loadFailFatal`.
- [x] `runtime.handleLoadFailure(error, errorContext, kind, env)` — **always throws,
  never returns** (it is called from a catch and re-enters the rejection→poison
  plumbing; returning a `PoisonedValue` would violate "never return `PoisonedValue`
  from async"). Classification, in order:
  1. `isRuntimeError(error)` → rethrow unchanged (a fatal — e.g. from
     `throwIfFatalErrorReported()` — **never becomes poison**, regardless of policy).
  2. `isPoisonError(error)` → rethrow unchanged (preserve origin context — do not
     re-wrap).
  3. raw error → `isLoadFailureFatal(env, kind)` ? `RuntimeError.reportAndThrow(error,
     errorContext)` : `throw PoisonError.wrap(error, errorContext, 'LoadFailed')`.
     This is the Phase 1 consumer-assertion shape plus a policy branch for the raw
     case.
  `include` does **not** call this — its non-fatal outcome is *omission*, not a value,
  so it branches on `isLoadFailureFatal` directly (below).

  Note the **active-catch requirement**: a bare `getTemplate` rejection already becomes
  poison via `RuntimePromise._wrapRejection` (`errors.js:510`). So the **fatal default
  is not free** — each value-producing site must add a catch that calls
  `handleLoadFailure`, or `loadFailFatal:true` would wrongly soften to poison.

### Per-kind wiring

Classification lives in a **dedicated catch at the load site**, never in the structural
boundary catch (keep "do not reclassify at the consuming boundary").

- [x] **import / from import** (`compileAsyncImport`, `compileAsyncFromImport`): catch
  raw loader rejection in `compileAsyncResolveTargetFile(..., 'import')` after the
  target-name expression resolves, then catch `compile()` / `getExported(...)` on the
  namespace continuation with `runtime.handleLoadFailure(e, ec, 'import', env)`. This
  keeps target-name expression errors on the existing expression path while still
  making the fatal default active before `RuntimePromise` can soften raw load rejection
  to value poison. Keep `throwIfFatalErrorReported()` inside the `then` — if it throws,
  step 1 of `handleLoadFailure` rethrows it as fatal. For `from import`, a failed
  **module** poisons each requested binding through the shared namespace poison; it does
  not fall through to the `hasOwnProperty` check (which would emit a secondary
  "cannot import"). A module that loads but lacks one requested export stays the
  existing `ImportBindingMissing` path.
- [x] **component** (`createComponentInstance`, `inheritance/component.js`): classify the
  raw target load in `compileAsyncResolveTargetFile(..., 'component')`, and classify
  component compile / instance bootstrap through the target `await` catch in
  `createComponentInstance`. The existing rejection plumbing already publishes —
  `startComponentInstance`'s `.catch` suppresses fatal for `isPoisonError` and
  `chain.setInitialValue(componentInstancePromise)` makes the rejected promise the
  binding value, so a later `comp.method()` poisons. Existing poison targets are
  awaited into `PoisonError` rejections and passed through unchanged by
  `handleLoadFailure`, preserving their origin context.
- [x] **include** (`compileAsyncInclude`): resolve the target-name expression first, then
  wrap `env.getTemplate(...)` + `await resolveSingle(templateVar)` +
  `renderState.throwIfFatalErrorReported()` + `compile()` + `_renderIncludeText(…)` in a
  try/catch **inside** the boundary body (not the structural catch). The catch must
  **classify before applying policy**, mirroring `handleLoadFailure` — never blind-
  branch on policy, or a fatal/poison would be silenced:
  - `isRuntimeError(err)` → **rethrow** (a real fatal — including one from
    `throwIfFatalErrorReported()` or a fatal `compile()` — is never silenced; this is
    why the check can live *inside* the try).
  - `isPoisonError(err)` → write poison into the text chain (a poison
    **template-name** expression stays on the existing expression path, not silenced by
    include policy; the include region has no value binding to carry it).
  - **raw** error only (actual load reject / `compile()` throw / not-found
    **`templateVar_resolved == null`** under `ignore missing`, for which there is **no
    null guard today**, `composition.js:271-274`) → branch on
    `isLoadFailureFatal(env, 'include')`: fatal → `RuntimeError.reportAndThrow`;
    non-fatal → **skip the `TextCommand`** (silent).

  **Either way still emit `emitLimitedLoopCompletion(...)`** with a settled value, so a
  silenced include inside a loop completes the iteration and cannot hang.
- [x] Leave `extends`/inheritance-parent and root load failures on their existing
  fatal path (unchanged).

### Verify

Same flag, both script and template · `import`/`component` poison isolates in a script
(unrelated `result.push` succeeds) · `loadFailFatal:false` → missing `include` silent
(empty output), missing `import` poison, **compile-erroring** import also poison (not
just not-found) · `loadFailFatal:['import']` → import fatal, `component` non-fatal ·
`from import` of a missing module poisons **each** binding (no secondary "cannot
import"), while a loaded module missing one export still hits `ImportBindingMissing` ·
`{% include getName() %}` with `getName()` rejecting stays a normal expression failure,
not `LoadFailed` · component target poison publishes as the binding value (later
`comp.method()` poisons), not a fatal · a **fatal early-exit** (`throwIfFatalErrorReported`)
during an include is **not** silenced · a silenced include **inside a loop** completes
(no hang) · invalid `loadFailFatal` throws at env construction · sync-compiled include
with `ignore missing` behaves as today (untouched).

**Public root render stays fatal regardless of policy** (named root calls
`getTemplate`/`getScript` *before* compiled code runs, so the compiler-side helper
never sees it — make this explicit):
- `env.renderTemplate('missing.njk', {}, { loadFailFatal: false })` → still fatal.
- `env.renderScript('missing.casc', {}, { loadFailFatal: false })` → still fatal.

· `extends`/root failure stays fatal regardless of `loadFailFatal` · per-site
`ignore missing` silences one include under a fatal global · regenerate fixtures ·
`npm run build`.

---

## Phase 5 — NaN → poison (depends on Phase 3; fixtures)

Goal: `NaN` is a value failure created at value-production points (analysis §3
"NaN handling", §11.9). **Not** a resolver-only backstop, and not a consumer-side
output/call-argument check.

- [x] Add `runtime.poisonIfNaN(value, ec)` (uses the Phase 3 `NaNResult` kind).
- [x] Wrap the result in the three arithmetic emitters in `compiler-base-async.js`
  (`_emitAsyncBinOp`, `_emitAsyncBinFunc`, `_emitAsyncUnaryOp`).
- [x] Apply `poisonIfNaN` at source result sites: context reads, member lookups,
  call/filter/env-call results, data/var command writes, sequence call/read/snapshot
  results, loop-value binding (including destructuring), and `RuntimePromise`
  fulfillment for async tails.
- [ ] Postpone: promise-valued loop elements can still resolve to `NaN` after loop
  binding. Fix when loop value-binding next changes by carrying the loop source
  context through the promise element tail.
- [x] Keep consumers source-neutral: output helpers and call-argument handling only
  receive/propagate existing poison, so they do not create a new local NaN origin.
- [x] Regenerate precompiled/browser fixtures if needed. No committed fixture files
  changed; emitted code is generated by the normal build/test path.

Verify: §11.9 tests (math→poison, context-NaN output→poison not `"NaN"`, sync NaN
arg→call poisoned, `Infinity` survives, `"NaN"` string survives, poison input still
propagates, loop element/data-method/async-tail coverage) · `npm test` (broad —
emitters + output + call paths changed).

---

## Phase 6 — Discarded-expression observer (feature; fixtures)

Goal: discarded `Do`-node async results are observed (analysis §10, §11.3).
`compileDo` evaluates arbitrary **expressions**, not just calls, so the observer
must handle any discarded thenable result — not only `callWrapAsync` results.

- [x] Design and add a narrow **discarded-expression** observer for
  compiler-known discarded async values (any thenable). Preserve sync-first behavior
  for discarded sync values; no command-buffer/channel mutation and no generic
  ambient promise tracker. (Avoid `callWrapAsync`-only framing — `Do` children may
  be lookups, member reads, or any expression returning a promise.)
- [x] Observer behavior: fulfilled values are ignored; poison rejections are
  swallowed; raw/fatal rejections are marked handled and reported through the active
  render state when one exists, without delaying render completion for discarded
  work.
- [x] Emit it from `compileDo(...)` for each discarded expression child.

Verify: a discarded async poison rejection is swallowed and not unhandled; a
discarded raw/fatal rejection is handled/reported and not unhandled; fulfilled
discarded promises do not affect output · new `compileDo` tests · regenerate
fixtures · `npm run build`.

---

## Phase 7 — Efficiency (low priority)

Goal: speed is not a major concern; only avoid pathological slowness (analysis §11
"Open evaluation areas — Efficient").

- [x] Lazy diagnostic formatting evaluated and intentionally skipped. The attempted
  implementation made `RuntimeContextError` more complex and changed normal
  `Error.message` property behavior; the current eager formatting is simpler and
  correct. Revisit only if profiling shows diagnostic formatting is pathologically
  expensive.
- [x] Sanity checks only, no surprises expected: NaN check cost, error-state-walk
  cache O(1), poison allocation, inherited-context clones. Act only if something
  profiles as pathologically slow. No additional code changes were needed.

Verify: `npm run mocha -- tests/poison/ tests/pasync/error-context.js`.

---

## Phase 8 — Docs sweep (user-facing closeout)

Goal: document the stable user-facing error semantics introduced by this work. Keep
this out of the implementation phases so the docs describe the final behavior, not the
path we took to get there.

- [x] `loadFailFatal` option documented (`script.md` Configuration list +
  `cascada-agent.md` opts): accepted values (`true`/`false`/fatal allowlist), `import`
  covers `from import`, root render and `extends` always fatal, non-fatal shapes
  (`LoadFailed` poison vs empty `include`).
- [x] Poison `kind` documented in *Anatomy of an Error Value* (`script.md`): the `kind`
  field (diagnostic, not a frozen API) + a compact by-category kinds table covering
  every source kind (`LoadFailed`/`ImportBindingMissing`, lookup/call/loop/boundary
  kinds, `NaNResult`).
- [x] `PoisonErrorGroup` shape updated: added `kind` (derived; `'Multiple'` for mixed),
  `kinds`, `totalErrorCount`; clarified `errors[]` keeps **all** child errors (sorted by
  source) while `message` is capped with a kind-summary header.
- [x] `NaN` behavior noted (arithmetic → Error Value; `Infinity` stays a value) and
  discarded-expression behavior noted (bare call / `{% do %}` failure has no consumer
  and is dropped).
- [x] No stale implementation-era notes in the user docs (checked; the remaining
  "work in progress" notes are unrelated feature-status items).

Verify: examples still match documented behavior · markdown renders (tables/links).

---

## Phase 10 — Poison `kind` taxonomy refinement (reuse over grab-bag)

Goal: every poison names a real failure category, reusing the general kinds across calls,
`!` paths, `sequence`, data/text chains, and context values. Retire the old grab-bag kinds
instead of carrying compatibility aliases.

Done:
- [x] Calls split missing targets (`MissingFunction`) from present non-functions (`NotAFunction`),
  with user/env function throws classified as `UserCallThrew`.
- [x] Genuine external async context/return rejections use `ContextValueRejected`.
- [x] Composition and component value-producing load failures use `LoadFailed`.
- [x] Removed `contextualizeChainError` and its cache after reclassifying every caller.
- [x] Data method lookup uses `MissingFunction` / `NotAFunction`; data method throws use
  `UserCallThrew`.
- [x] Text unsupported operations use `MissingFunction`; invalid text values use
  `InvalidTextValue`.
- [x] `var` keeps the compiler-owned single-value command shape; `text.set(...)` invalid
  arity is a compile-time error, with the runtime guard left fatal for direct mis-construction.
- [x] Generic chain `_recordError` raw failures are fatal after local command sources classify
  their own user-reachable failures.
- [x] Value-boundary and branch raw throws are fatal; existing poison still preserves its origin
  and branch effect-chain poisoning.
- [x] `DestructureMismatch` renamed to `NotAnArray`.
- [x] Unknown bare-name reads stay `UnknownVariable`; unknown bare-name calls use
  `MissingFunction` through a call-target-only lookup variant.
- [x] `sequence` now matches normal Cascada classification: missing/non-function methods use
  `MissingFunction` / `NotAFunction`, method throws use `UserCallThrew`, and null path targets
  use `NullLookup`.
- [x] Tests and docs no longer use retired `ValueRejected`, `DataMethodThrew`,
  `ExpressionThrew`, `ConditionThrew`, or `DestructureMismatch` as active kinds.

End state: `ValueRejected`, `DataMethodThrew`, `ExpressionThrew`, `ConditionThrew`, and
`DestructureMismatch` are retired. The active taxonomy uses `MissingFunction`, `NotAFunction`,
`UserCallThrew`, `UnknownVariable`, `NullLookup`, `LookupThrew`, `IteratorThrew`,
`NotAnArray`, `InvalidConcurrentLimit`, `LoadFailed`, `ImportBindingMissing`, `NaNResult`,
`InvalidTextValue`, and `ContextValueRejected`.

Verify: per-path kind assertions (call / `!` / `sequence` missing method -> `MissingFunction`;
non-function -> `NotAFunction`; throw -> `UserCallThrew`; sequence null read -> `NullLookup`;
text invalid output -> `InvalidTextValue`; raw throw in an expression -> fatal), `tests/poison/`,
`tests/pasync/error-context.js`, emitted-code build checks, and
`npm run build`.
---

## Phase 11 — Retire `SequentialPathThrew` (post-Phase 10)

`SequentialPathThrew` is the last consumer-side grab-bag. A `!` call/lookup already produces
`UserCallThrew` / `MissingFunction` / `NullLookup` via `callWrapAsync` / `memberLookup`; the
only legitimate sync throw it catches is the `!` path **root not in the render context**
(`contextLookupOnly` raw-throws "…is not available in context"). And the async path already
sends raw rejections to fatal (`sequential-path.js:90-94`) — only the **sync** catch poisons,
so the two disagree.

- [x] `contextLookupOnly` (`sequential.js`): use `lookupScript` instead of `lookup` so a
  missing `!` root returns `UnknownVariable` poison (consistent with a bare-name read) instead
  of raw-throwing. (Verify no other legitimate poison case reaches the sync catch first.)
- [x] `runSequentialPathOperation` sync catch (`sequential-path.js:84`): replace
  `PoisonError.wrap(e, ec, 'SequentialPathThrew')` with raw → fatal (`rethrowPoisonOrReport`),
  matching the async path. Retires `SequentialPathThrew`.
- [x] Docs: remove the `SequentialPathThrew` row from the kind tables (analysis §3 +
  `script.md`).

Verify: `db!.save()` with `db` absent from context → `UnknownVariable` (not `SequentialPathThrew`);
a `!` method that throws → `UserCallThrew`; an unexpected raw sequential failure → fatal ·
`tests/poison/` · `tests/pasync/sequential-*.js` · `npm run build`.

---

## Phase 12 — Lookup / iteration strictness + loop-kind clarity (post-Phase 10)

Don't let **scalar misuse** silently produce `undefined` or a no-op — that hides real bugs.
Two new poisons + one rename. **Script mode** (templates stay lenient), matching the existing
`null`-target rule. The governing split: a **`null`/`undefined`** value is *absent* (lenient —
optional fields / `else`); a **scalar primitive** (`typeof` number/boolean/bigint/symbol) used
as a container or collection is a *type error* (poison).

- [ ] **`ScalarLookup`** (new) — `memberLookupScript`: after `obj[val]`, if the result is
  `undefined` **and** `obj` is a scalar primitive, poison instead of returning `undefined`.
  Built-in methods (`(5).toFixed`) resolve to functions, so they pass; objects/arrays/**strings**
  stay lenient (optional fields, indexing, chars); `null`/`undefined` stay `NullLookup`. The
  `typeof` check runs **only when the result is already `undefined`**, so the hot path is
  untouched.
- [ ] **`NotIterable`** (new) — `loop.js` `iterate`: a loop source that is a scalar primitive
  currently funnels into `iterateObject` → `Object.keys` empty → silent zero iterations. Poison
  it. `null`/`undefined` keep running the **`else`** branch (absent/optional collection); arrays,
  objects, iterables, async iterators, and strings are unchanged. (iterate() is shared across
  modes; gate on script mode to match scope, or apply to both — a scalar source is always a bug.)
- [ ] **Rename `NotAnArray` → `NotDestructurable`** (`loop.js` create site): it is the
  multi-variable destructuring **element** failure (`for a, b in pairs`), independent of the loop
  source. `NotIterable` (source) and `NotDestructurable` (element) are now distinct.
- [ ] Docs (all surfaces): add `ScalarLookup` + `NotIterable` rows and rename `NotAnArray` →
  `NotDestructurable` in the **kind tables** (analysis §3 + `script.md` *Anatomy*); note in the
  **`script.md`** lookup/loop sections that scalar property access and iterating a scalar poison;
  extend **`cascada-agent.md`** LANG-05 (property access on `none`/null → Error Value) to scalars;
  add the divergence to **`template.md`** "Template vs Script: Key Differences" (minimal style):
  scripts poison scalar property access and iterating a scalar; templates stay lenient
  (`undefined` / no-op).

Verify: `5[5]` / `5.foo` / `true.x` → `ScalarLookup`; `(5).toFixed(2)` works; `obj.missing` /
`arr[10]` / `"abc"[9]` stay `undefined` · `for x in 5` → `NotIterable`; `for x in null` → runs
`else`; `for x in {}` / `[]` / iterator / async iterator unchanged · `for a, b in [1, 2]`
(element not an array) → `NotDestructurable` · `tests/poison/` · `tests/pasync/loops.js` ·
`npm run build`.

---

## Phase 13 — Script-language strictness (operators)

CascadaScript inherits nunjucks templating leniencies that hide programming bugs. Tighten them
**in script mode** (templates stay nunjucks-compatible). Confirmed: the lexer has both `==` and
`===` (`lexer.js:168`).

- [ ] **`in` on a non-collection → poison** (also a Phase 10 regression fix). `runtime.inOperator`
  (`lib.js:251`) `throw new Error(...)` for a non-array/string/object RHS; post-Phase-10 that raw
  throw now becomes **fatal**, where before it was poison. A user type error should be recoverable
  poison, not fatal — make `inOperator` produce a `PoisonError` (kind: reuse `NotIterable`, or a
  dedicated `InvalidInOperand` — decide at implementation). Applies to **both** modes (it's a
  correctness fix, not just strictness).
- [ ] **Strict equality in script mode.** Compile `==` → `===` and `!=` → `!==` (the `compareOps`
  tables in `compiler-base-async.js` / `compiler-base-sync.js`), gated on `scriptMode`. Removes
  loose equality (`5 == "5"` → `false` in scripts). Templates keep loose `==` for nunjucks
  compatibility. **Breaking** for scripts that relied on loose `==` (accepted).
- [ ] **Typed operands in script mode** (supersedes the narrow "numeric `+`"). Result-checking
  (`poisonIfNaN`) is leaky: JS coerces `null`→0, `true`→1, `[]`→0, `[2]`→2, `"5"`→5, so
  `null - 1` → `-1`, `true + 1` → `2`, `"5" * 2` → `10` all slip through silently. Check **operands**,
  not the result. Replace the `poisonIfNaN(left op right)` emit with typed runtime helpers
  (gated on `scriptMode`):
  - **Arithmetic** `+` `-` `*` `/` `//` `%` `**` → both operands must be `number` (or `bigint`);
    anything else — **including numeric strings** (`"5"`), `null`, booleans, arrays, objects,
    `undefined` — poisons. Concatenation uses the existing `~` operator (`compileConcat`). The
    explicit numeric conversions are the `int` / `float` filters (`("5" | int) + 3`); they return a
    default, so they never poison.
  - **Ordering** `<` `>` `<=` `>=` → both `number` **or** both `string` (lexicographic); mixed or
    other types poison (no coercion).
  - **`~` (concat)** → scalars stringify; a plain object / function / symbol poisons (same rule as
    `InvalidTextValue`).
  This subsumes `NaNResult` for arithmetic — a bad operand poisons before a `NaN` can form. Kind:
  one new `IncompatibleOperands` (or reuse `NaNResult` for the arithmetic ones — decide at
  implementation). Templates keep raw JS operators + the result-only `NaNResult`.

- [ ] Docs (all surfaces, not just template.md):
  - **kind tables** (analysis §3 + `script.md` *Anatomy of an Error Value*): add the `in`→poison
    kind and the operand kind (`IncompatibleOperands`, or note the `NaNResult` reuse for arithmetic).
  - **`script.md` operator/expression section** (≈173, 457): scripts use strict `==`/`!=`;
    arithmetic needs numeric operands (concat is `~`; convert with `| int` / `| float`); ordering
    needs both number or both string; `in` on a non-collection poisons.
  - **`cascada-agent.md`**: update the operator rule (the "arithmetic/logical operators THROW on
    `none`/missing target" line ≈352) to the script-mode typed-operand behavior.
  - **`template.md`** "Template vs Script: Key Differences" (minimal style): scripts use strict
    `==` and numeric operators; templates keep loose `==` and JS coercion.

**Explicitly not doing:** macro/function arity (skipping arguments is a valid pattern — stays
silent); default `throwOnUndefined` in script mode (`undefined` stays `undefined`, JS-like).
Follow-up (separate): a filter-input audit — filters are the other big nunjucks surface that
coerces wrong-type input silently.

Verify: `x in 5` → poison (not fatal), recoverable with `is error` · `5 == "5"` → `false` in a
script, `true` in a template · arithmetic operand checks: `"5" + 3` / `null - 1` / `true + 1` /
`"5" * 2` / `[] * 5` → poison (not silent `-1`/`2`/`10`/`0`); `5 + 3` → `8`; `("5" | int) + 3` → `8`;
`"5" ~ 3` → `"53"` · ordering `5 < "abc"` → poison, `"a" < "b"` → `true` · macros with missing args
still run · `{{ x.missing }}` still `undefined` · the same expressions stay JS-lenient in templates
· `tests/pasync/expressions.js` · `tests/poison/` · `npm run build`.

---

## Phase 14 — Text-chain multi-argument output

Text chains should be documented and verified around the user-facing callable form:
`text body` then `body("num: ", 10)`. Multiple arguments are text pieces, normalized like normal
text output, then appended in order. Mixing strings and numbers is fine; only values with no
usable string form are rejected.

- [ ] **Callable text chains**: ensure `body("A", 1, "B", 2)` appends `"A1B2"` and
  `body()` is a no-op / empty append, matching current text-output semantics.
- [ ] **Remove the internal `set` arity validation**: drop the compile-time
  `_failInvalidTextSetArity` duplication (`buffer.js` + `chain.js`) and the runtime
  `args.length !== 1` fatal in `text.js`. `set` already resets the chain to `[]` and appends, so
  without the check `body.set("A", 1, "B", 2)` naturally stores `"A1B2"` and `body.set()` stores
  empty text.
- [ ] **Value rules come for free** from `appendTextValues`: scalars (string/number/boolean/
  bigint) and objects with a real `toString` concatenate; a plain object / function / symbol
  poisons as `InvalidTextValue` (Phase 10) — same as any other text output.
- [ ] **Poison passthrough**: a poison argument flows into the text chain exactly as normal text
  output does; do not relabel existing poison.
- [ ] Docs: mention multi-value callable text chains in `script.md` / agent docs near text-chain
  examples. Treat `text.set(...)` as an internal/method-style detail, not the main user-facing
  syntax.

Verify: `text body; body("Number of people: ", 5, " number of kids: ", 2)` →
`"Number of people: 5 number of kids: 2"` · `body()` is harmless · `body({})` →
`InvalidTextValue` poison · `body.set("A", 1, "B", 2)` stores `"A1B2"` · poison arguments
propagate · text-chain render tests / `tests/pasync/chain-errors.js` · `npm run build`.

---

## Phase 15 — Documentation closeout & consistency (final)

The true docs closeout — placed **after** all behavior-changing phases. Phase 8 documented the
*core* model (kinds, `loadFailFatal`, `NaN`, groups) as of Phase 6; Phases 10–14 then reshaped the
taxonomy and added strictness. Per-phase "Docs:" steps do the incremental writing; this phase
verifies the whole surface agrees.

- [ ] No **retired** kind (`ValueRejected`, `DataMethodThrew`, `ExpressionThrew`, `ConditionThrew`,
  `DestructureMismatch`, `SequentialPathThrew`) appears in any doc.
- [ ] Every **active** kind appears in **both** kind tables (`script.md` *Anatomy of an Error
  Value* + analysis §3) and they match.
- [ ] `cascada-agent.md` ERR-07 lists `kind` in the `#errors` shape (the Phase 8 catch-up), and
  its operator/lookup rules reflect script-mode strictness (typed operands, strict `==`, scalar
  lookup/iteration, `in`).
- [ ] `template.md` "Template vs Script: Key Differences" lists every script/template divergence
  (scalar lookup/iteration, strict `==`, numeric operators, `in`).
- [ ] Examples across all docs still render / match behavior; links resolve.

Verify: `npm run build` · grep the docs for retired kind names → none.

---

## Resolved decisions

- **First-fatal-wins** — accepted as non-deterministic; first reported wins. Close as
  fast as possible and do not crash (Phase 2 early-exit + Phase 0 §11.16).
- **Aggregate order** — completeness required; deterministic order not (Phase 3).
- **Unbounded aggregation** — cap the message with a kind-summary header while
  retaining the full structured `.errors[]` (Phase 3).
- **Dedup stability** — non-issue; origin context is fixed at creation, so order does
  not change the kept context. No work.
- **Efficiency** — low priority; lazy diagnostic formatting was evaluated and **intentionally
  skipped** in Phase 7 (it complicated `RuntimeContextError` and changed `Error.message`
  behavior; eager formatting is simpler and correct). Revisit only on a profiling surprise.

## Doc upkeep

- Keep §11 items and this plan's checkboxes in sync as items land.
- When a phase touches emitted code, note the fixture regeneration in the PR.
- **Documentation surfaces** — every kind/behavior change must reconcile *all* of: the two kind
  tables (`script.md` *Anatomy of an Error Value* + analysis §3), the relevant `script.md`
  behavioral section (lookup / loops / operators / channels), `template.md` "Template vs Script:
  Key Differences", and `cascada-agent.md` (ERR-07 error-value shape + the operator/lookup rules).
  A per-phase "Docs:" step should name each surface it touches.
- **Catch-up (Phase 8 gap):** `cascada-agent.md` ERR-07's `#errors` field list omits `kind`
  (added in Phase 3 and documented in `script.md`, but never mirrored to the agent doc) — add it.
- After all phases: re-run the §13 verification targets and update the analysis doc's status
  notes (e.g. mark §11.16 fixed, drop the `it.skip`). The **final docs-consistency pass is
  Phase 15** (placed after all behavior-changing work, not here).
