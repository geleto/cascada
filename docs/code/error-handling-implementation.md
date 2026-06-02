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
- §11.9 (NaN, Phase 4) requires the `kind` field (Phase 3).
- Poison aggregation (the kind-summary cap header) uses `kind`, so it lands **in**
  Phase 3 alongside the kind field — producer + first consumer together.
- `resolve.js` is touched by §11.1 (Phase 0), §11.12 + §11.15 (Phase 1); do the
  Phase 1 ones together.
- Phases that change **emitted** code regenerate precompiled/browser fixtures:
  Phase 1 (§11.14 emit helper), Phase 3 (`kind` in emitted composition), Phase 4
  (NaN emitters), Phase 5 (Do-sink). Fixture regen is an automated build step, so
  the objective order (cleanup → fixes → features) is preferred over batching it.
- Phase order follows the objective: **Phase 0** stability/safe foundation ·
  **Phase 1** centralize & dedup · **Phase 2** behavioral fixes + early-exit +
  audits · **Phase 3–5** features · **Phase 6** efficiency.

---

## Phase 0 — Foundation: safe wins, the crash, the rejection sweep

Goal: clear the trivially-correct items, the confirmed crash, and the bug class it
belongs to. No dependencies, no fixtures.

- [ ] §11.2 — `markPromiseHandled(...)` on the component cleanup promise
  (`inheritance/component.js` ≈168).
- [ ] §11.7 — delete the stale `iterateArrayLimited.worker` `@todo` (`loop.js` ≈562).
- [ ] §11.1 — remove the dead inner per-property `try/catch` in `resolve.js`
  `createObject`/`createArray`; await the values directly.
- [ ] §11.16 — fix duplicate fatal delivery (the confirmed process-crashing
  unhandled rejection). Locate the loop boundary/completion promise that re-throws
  an already-reported fatal and `markPromiseHandled` it (or have the completion
  consumer swallow the already-reported rejection). Then **un-skip** the guard in
  `tests/poison/fatal-delivery.js` and confirm it passes. Verify breadth across all
  loop forms (analysis §11.16 "Breadth").
- [ ] **Unobserved-rejection sweep** (same bug class as §11.16) — audit every
  fire-and-forget promise (`loop.js` workers, guard setup/detection) for a rejection
  with no handler; `markPromiseHandled` or route as appropriate.

Verify: `npm run mocha -- tests/poison/fatal-delivery.js tests/pasync/loops.js` ·
`npm run build`.

---

## Phase 1 — Centralize & dedup (clarity, behavior-preserving)

Goal: the §2 invariant in one named place, plus the mechanical dedups (analysis
§11.12–15, §9 dedup). All behavior-preserving.

- [ ] §11.12 — add three named helpers to `errors.js`: `poisonOrReport(err, ec)`,
  `rethrowPoisonOrReport(err, ec)`, `poisonOrRethrow(err)` (signatures in §11.12; no
  `isRuntimeError` guard — it collapses). Replace the hand-rolled copies in
  `resolve.js` (~6 catches), `lookup.js`, `safe-output.js` (`rethrowPoisonOrFatal`),
  `commands/arguments.js` (`classifyCommandArgumentFailure`).
- [ ] §11.15 — dedup `createObject`/`createArray` resolver bodies into one shared
  lazy-container helper (in `resolve.js`; do in the **same phase** as §11.12, which
  also edits `resolve.js`, to avoid re-churn — the §11.12 helpers themselves live in
  `errors.js`).
- [ ] §11.13 — one shared boundary catch handler in `async-boundaries.js` for
  `runControlFlowBoundary`/`runWaitedControlFlowBoundary`/`runRenderBoundary`
  (`finally` bodies stay per-helper).
- [ ] §11.14 — one emit helper for the branch-poison catch shared by
  `compiler-async.js` (if/switch) and `compiler/loop.js` (while). Touches emitted
  code → regenerate fixtures.

Verify: `npm run mocha -- tests/poison/ tests/pasync/error-context.js
tests/pasync/conditional.js` · regenerate fixtures (§11.14) · `npm run build`.

---

## Phase 2 — Behavioral fixes, early-exit, and stability audits

Goal: runtime correctness, before features (analysis §11.4–6, §11.10–11, §11 "Open
evaluation areas — Stable" REQUIRED). Mostly runtime-only.

- [ ] §11.4 — make `Expected an array for destructuring` poison-per-iteration at all
  five `loop.js` sites (replace the raw throw with the existing `isPoison`
  poison-fill). Leave `Expected two variables…` fatal.
- [ ] §11.6 — `sequence-chain.js` observable `_applyCommand` rejection → convert at
  the catch via `cmd.rejectResult(RuntimeError.report(err, cmd.errorContext))`.
- [ ] §11.5 (optional) — `_suppressValueScriptComplex` array path collects all
  poison before `resolveAll(...)`.
- [ ] §11.10 — call-boundary early exit: in `callWrapAsync`/`_callWrapAsyncComplex`,
  when `getRenderState(errorContext).isFatalErrorReported()`, return **without
  invoking** (sync-first; do not throw). Return semantics: return `undefined` — the
  result flows into a command the buffer iterator will **not** apply (fatal-stop
  `_stopAfterFatalReport` gates command application), so the inert value causes no
  visible chain mutation. (Returning poison would be equally inert but adds a
  needless allocation on a doomed render.) Test: a side-effecting user call after a
  fatal is **not** invoked, and no chain mutation from it is observable.
- [ ] §11.11 — loop-scheduling early exit: stop fanning out `loopBody` once fatal,
  still finishing the loop's buffers/chains (no deadlock).
- [ ] **Internal pending-promise leak** (audit) — whether `_stopAfterFatalReport`
  leaves any pending observable command result promise (snapshot, `getError`,
  sequential-path read, guard capture/restore) unsettled; settle it if so. (No render
  hang — `raceRootResult` verified.)
- [ ] **Single-classification** (audit) — a thrown error cannot be both poisoned and
  fatal-reported, or wrapped as poison twice with different context.

Verify: `npm run mocha -- tests/pasync/loops.js tests/poison/
tests/pasync/sequential-expressions.js tests/poison/fatal-delivery.js` ·
`npm run build`.

---

## Phase 3 — `kind` field + poison aggregation (feature; fixtures)

Goal: one stable failure-category per leaf poison, and bounded/readable groups built
on it (analysis §3, §11.8, §11 "Open evaluation areas" — Aggregate order +
Unbounded aggregation). Producer + first consumer together.

- [ ] §11.8 — thread `kind` through `PoisonError.create`, `PoisonError.wrap`, and
  `RuntimePromise` (carry + apply on `_wrapRejection`); pass the target `kind` at
  every source in the analysis §3 kind table, including `ImportBindingMissing` at the
  `from import` missing-binding throw (replacing the `ValueRejected` fallback).
- [ ] Cap the `PoisonErrorGroup` message; when the cap is reached, the header
  summarizes the full set before the capped list: `N errors (showing <cap>) of K
  kinds (kind1, kind2, kind3)`. Counts/kinds from the fully-collected set (all already
  awaited) — completeness preserved; also cap retained `.errors[]`.
- [ ] Sort aggregated errors by source position (`path`, `lineno`, `colno`) with
  deterministic tiebreakers before building the group. Order determinism is **not**
  required; completeness (never miss an error) **is**.

Verify: `npm run mocha -- tests/poison/ tests/pasync/error-context.js
tests/pasync/composition.js` (kind, group cap/summary/order) · regenerate fixtures ·
`npm run build`.

---

## Phase 4 — NaN → poison (depends on Phase 3; fixtures)

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

## Phase 5 — Discarded-expression sink (feature; fixtures)

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

## Phase 6 — Efficiency (low priority)

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
- **Unbounded aggregation** — cap the message + retained errors, with a kind-summary
  header (Phase 3).
- **Dedup stability** — non-issue; origin context is fixed at creation, so order does
  not change the kept context. No work.
- **Efficiency** — low priority; lazy formatting still worth doing for clarity.

## Doc upkeep

- Keep §11 items and this plan's checkboxes in sync as items land.
- When a phase touches emitted code, note the fixture regeneration in the PR.
- After all phases: re-run the §13 verification targets and update the analysis
  doc's status notes (e.g. mark §11.16 fixed, drop the `it.skip`).
