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
- Phases that change **emitted** code regenerate precompiled/browser fixtures:
  Phase 1 (§11.14 emit helper), Phase 3 (`kind` in emitted composition),
  Phase 4 (load-failure — emitted composition sites), Phase 5 (NaN emitters),
  Phase 6 (Do-sink).
  Fixture regen is an automated build step, so the objective order (cleanup → fixes →
  features) is preferred over batching it.
- Phase order follows the objective: **Phase 0** stability/safe foundation ·
  **Phase 1** centralize & dedup · **Phase 2** behavioral fixes + early-exit +
  audits · **Phase 3** `kind` foundation · **Phase 4** load-failure policy ·
  **Phase 5–6** remaining features ·
  **Phase 7** efficiency.

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

- [ ] Add `loadFailFatal` to `BaseEnvironment` (`base-environment.js` constructor,
  alongside `throwOnUndefined` in `this.opts`) — **not** an emitted constant or a
  template compile option. The runtime helper reads `env.opts.loadFailFatal` at
  **render** time, so precompiled artifacts honor the running env.
- [ ] **Validate + normalize at env init**: `loadFailFatal` must be `true`, `false`,
  or an array containing only `'import' | 'component' | 'include'`. Invalid value or
  array entry → **fatal config error thrown at construction** (do not silently ignore).
  Normalize to one canonical form (e.g. a `Set` of fatal kinds; `true`→all, `false`→
  none) for `isLoadFailureFatal` to read; duplicates collapse.
- [ ] **Array semantics**: a supplied array is a **fatal allowlist** — listed kinds
  are fatal, unlisted value-producing kinds are non-fatal. (`extends`/`root` are always
  fatal and never appear.)

### Runtime helpers (two helpers; in `errors.js`)

- [ ] `runtime.isLoadFailureFatal(env, kind)` → boolean from the normalized
  `env.opts.loadFailFatal`.
- [ ] `runtime.handleLoadFailure(error, errorContext, kind, env)` — **always throws,
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

- [ ] **import / from import** (`compileAsyncImport`, `compileAsyncFromImport`): append
  a `.catch(e => runtime.handleLoadFailure(e, ec, 'import', env))` to the existing
  `resolveSingle(id).then(t => { t.compile(); … getExported(…) })` continuation — one
  catch covers load reject, `compile()` throw, and `getExported` materialization. The
  throw rejects the continuation promise, so the bound namespace becomes poison (or the
  fatal is reported). Keep `throwIfFatalErrorReported()` inside the `then` — if it
  throws, step 1 of `handleLoadFailure` rethrows it as fatal. For `from import`, a
  failed **module** must poison **each requested binding directly** — when the
  namespace promise rejects/poisons, set every binding to that poison; do **not** fall
  through to the `hasOwnProperty` check (which would emit a secondary "cannot import").
  A module that loads but lacks one requested export stays the existing
  `composition.js:189` `ImportBindingMissing` path.
- [ ] **component** (`createComponentInstance`, `inheritance/component.js`): the runtime
  load site is the target `await` at ≈128. **One-line change**: replace the catch's
  `RuntimeError.reportAndThrow(error, errorContext)` (≈130) with
  `runtime.handleLoadFailure(error, errorContext, 'component', env)`. The existing
  rejection plumbing already publishes — `startComponentInstance`'s `.catch` (≈203)
  already suppresses fatal for `isPoisonError` and `chain.setInitialValue(componentInstancePromise)`
  makes the rejected promise the binding value, so a later `comp.method()` poisons. Add
  an `isPoison(componentScriptOrTemplate)` pre-check **before** the `await` so a poison
  target is published with its origin context instead of being awaited and re-wrapped.
  (No emit-site change — the compiled `startComponentInstance({…})` call cannot branch,
  since the target is a promise resolved later.)
- [ ] **include** (`compileAsyncInclude`): wrap `await resolveSingle(templateVar)` +
  `renderState.throwIfFatalErrorReported()` + `compile()` + `_renderIncludeText(…)` in a
  try/catch **inside** the boundary body (not the structural catch). The catch must
  **classify before applying policy**, mirroring `handleLoadFailure` — never blind-
  branch on policy, or a fatal/poison would be silenced:
  - `isRuntimeError(err)` → **rethrow** (a real fatal — including one from
    `throwIfFatalErrorReported()` or a fatal `compile()` — is never silenced; this is
    why the check can live *inside* the try).
  - `isPoisonError(err)` → **rethrow** (a poison **template-name** expression stays on
    the existing expression path, not silenced by include policy).
  - **raw** error only (actual load reject / `compile()` throw / not-found
    **`templateVar_resolved == null`** under `ignore missing`, for which there is **no
    null guard today**, `composition.js:271-274`) → branch on
    `isLoadFailureFatal(env, 'include')`: fatal → `RuntimeError.reportAndThrow`;
    non-fatal → **skip the `TextCommand`** (silent).

  **Either way still emit `emitLimitedLoopCompletion(...)`** with a settled value, so a
  silenced include inside a loop completes the iteration and cannot hang.
- [ ] Leave `extends`/inheritance-parent and root load failures on their existing
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

Goal: `NaN` is a value failure, at the production points + call-args + output
(analysis §3 "NaN handling", §11.9). **Not** a resolver-only backstop.

- [ ] Add `runtime.poisonIfNaN(value, ec)` (uses the Phase 3 `NaNResult` kind).
- [ ] Wrap the result in the three arithmetic emitters in `compiler-base-async.js`
  (`_emitAsyncBinOp`, `_emitAsyncBinFunc`, `_emitAsyncUnaryOp`).
- [ ] Check **arguments** in `callWrapAsync`/`envCallWrapAsync` (no NaN args) and the
  value in the output helpers (`suppressValueAsync`/`suppressValueScript`/
  `ensureDefinedAsync`, no NaN at output); add the check to `RuntimePromise`
  fulfillment for the async tail. Verify the loop-value / data-chain-snapshot carriers
  (analysis "NaN handling") are covered.
- [ ] Regenerate precompiled/browser fixtures (emitted arithmetic shape changed).

Verify: §11.9 tests (math→poison, context-NaN output→poison not `"NaN"`, sync NaN
arg→call poisoned, `Infinity` survives, `"NaN"` string survives, poison input still
propagates) · `npm test` (broad — emitters + output + call paths changed).

---

## Phase 6 — Discarded-expression sink (feature; fixtures)

Goal: discarded `Do`-node async results are observed (analysis §10, §11.3).
`compileDo` evaluates arbitrary **expressions**, not just calls, so the sink must
handle any discarded thenable result — not only `callWrapAsync` results.

- [ ] Design and add a narrow **discarded-expression** sink that routes a
  compiler-known discarded async value (any thenable) through the current command
  buffer; preserve sync-first behavior for discarded sync values; no generic ambient
  tracker. (Avoid `callWrapAsync`-only framing — `Do` children may be lookups,
  member reads, or any expression returning a promise.)
- [ ] Emit it from `compileDo(...)` for each discarded expression child.

Verify: a discarded-async-call rejection is observed/reported, not unhandled · new
`compileDo` tests · regenerate fixtures · `npm run build`.

---

## Phase 7 — Efficiency (low priority)

Goal: speed is not a major concern; only avoid pathological slowness (analysis §11
"Open evaluation areas — Efficient").

- [ ] Lazy diagnostic formatting (worth doing — clarity, not just speed) — build
  `compactMessage`/`fullMessage`/stack on access (`getInfo`/`formatInfo`/`.message`),
  not in the `RuntimeContextError` constructor. Simplifies the constructor and removes
  per-poison formatting cost.
- [ ] Sanity checks only, no surprises expected: NaN check cost, error-state-walk
  cache O(1), poison allocation, inherited-context clones. Act only if something
  profiles as pathologically slow.

Verify: `npm run mocha -- tests/poison/ tests/pasync/error-context.js` ·
benchmark before/after for the lazy-formatting change.

---

## Resolved decisions

- **First-fatal-wins** — accepted as non-deterministic; first reported wins. Close as
  fast as possible and do not crash (Phase 2 early-exit + Phase 0 §11.16).
- **Aggregate order** — completeness required; deterministic order not (Phase 3).
- **Unbounded aggregation** — cap the message with a kind-summary header while
  retaining the full structured `.errors[]` (Phase 3).
- **Dedup stability** — non-issue; origin context is fixed at creation, so order does
  not change the kept context. No work.
- **Efficiency** — low priority; lazy formatting still worth doing for clarity.

## Doc upkeep

- Keep §11 items and this plan's checkboxes in sync as items land.
- When a phase touches emitted code, note the fixture regeneration in the PR.
- After all phases: re-run the §13 verification targets and update the analysis
  doc's status notes (e.g. mark §11.16 fixed, drop the `it.skip`).
