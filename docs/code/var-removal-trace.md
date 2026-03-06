# Var Removal Trace (Dead-Code Cut)

Assumptions for this plan:
- Legacy async var implementation is dead in real paths.
- We do not need incremental flag-by-flag migration.
- We do not need test rewrites to preserve removed internals.

Goal:
- Remove legacy async var machinery in one broad pass.
- Keep only value-output async model.
- Keep parser/script `var` syntax support as surface syntax (until final rename phase).

## Keep vs Remove

Keep:
- `LOOKUP_DYNAMIC_OUTPUT_LINKING` flag (optional dynamic mode toggle).
- Frame lexical scope basics (`push/pop/new`, `isolateWrites`, `createScope`) for locals/macro internals.
- Sync compatibility paths unless intentionally removed later.

Remove:
- All other migration flags and their branches:
  - `CONVERT_TEMPLATE_VAR_TO_VALUE`
  - `CONVERT_SCRIPT_VAR_TO_VALUE`
  - `LOOP_VARS_USE_VALUE`
  - `SEQUNTIAL_PATHS_USE_VALUE`
  - `VALUE_IMPORT_BINDINGS`
  - `INCLUDE_PRELINK_OUTPUTS`
  - `INHERITANCE_CONTEXT_ONLY_LOOKUP`

## One-Pass Removal Scope

### 1) Compiler var-sync analysis

Remove var-sync metadata flow:
- `src/compiler/compile-async.js`
  - `updateFrameWrites`, `updateFrameReads`, `capWriteCounts`, `combineWriteCounts`
- `src/compiler/compile-emit.js`
  - async-block args for `readVars`/`writeCounts`
- `src/compiler/validation.js`
  - checks coupling `varsNeedingResolveUp`/`readVars`/`writeCounts`

### 2) Runtime var-sync core

Remove legacy async write-count/promisification model:
- `src/runtime/frame.js`
  - `writeCounters`, `promiseResolves`, var-sync `asyncVars` usage
  - `_promisifyParentVariables`, `_promisifyParentVar`
  - `_countdownAndResolveAsyncWrites`
  - `skipBranchWrites`, counter-driven branch poison handling
  - sequential-loop counter commit helpers
- `src/runtime/async-state.js`
  - `pushAsyncBlock(readVars, writeCounts, ...)` contract
- `src/runtime/checks.js`
  - pending write-counter checks

### 3) Legacy frame-lookup fallbacks in async value mode

Remove async fallback usage of frame var lookup:
- compiler emissions of `runtime.contextOrFrameLookup(...)` for async template value paths
- `__parentTemplate` async frame fallback paths
- dead compatibility helper in runtime:
  - `runtime.contextOrFrameOrValueLookup(...)`

### 4) Non-value sequential lock model

Remove frame-lock sequencing branch entirely:
- `src/runtime/sequential.js`
  - `createLockPromise`, `updateReadLock`, `withSequenceLocks`
  - non-value branches in sequential wrappers
- compiler branches that emit read/write lock-key mode

Keep only:
- value-path sequencing via command-buffer sequential path commands.

### 5) Legacy context publication branches

Remove async value-mode legacy publication/fallback code:
- `context.setVariable(...)` emission branches used as compatibility fallback
- dual export storage split tied to `VALUE_IMPORT_BINDINGS`

## Coverage-Backed Dead Candidates (From `npm test`)

These are strong delete-first signals:
- `src/runtime/sequential.js`: legacy frame-lock functions are zero-hit.
- `src/runtime/lookup.js`: zero-hit compatibility helpers:
  - `contextOrFrameOrValueLookup`
  - `contextOrFrameLookupScript`
  - `contextOrFrameLookupScriptAsync`
- `src/compiler/compile-async.js`: unhit write-count utility (`combineWriteCounts`).
- `src/compiler/compiler.js`: uncovered legacy branches:
  - `context.setVariable(...)` fallback
  - `contextOrFrameLookup(... "__parentTemplate")` fallback
  - `frame.skipBranchWrites(...)` write-count path

## Execution Strategy (Single Cut)

1. Delete all non-`LOOKUP_DYNAMIC_OUTPUT_LINKING` flags and inline value behavior.
2. Remove compiler var-sync metadata and old sequential branch emissions.
3. Remove runtime var-sync/counter/promisification code.
4. Remove compatibility lookup/publishing branches no longer reachable.
5. Fix compile/runtime build breaks directly (no compatibility patching for dead paths).
6. Run `npm run test`.

## Appendix A: Guard-to-File Mapping

### `CONVERT_TEMPLATE_VAR_TO_VALUE`
- `src/parser.js`
- `src/transformer.js`
- `src/environment/template.js`
- `src/compiler/compiler.js`
- `src/compiler/compiler-base.js`
- `src/compiler/compile-inheritance.js`

### `CONVERT_SCRIPT_VAR_TO_VALUE`
- `src/script/script-transpiler.js`
- `src/compiler/compiler.js` (macro publication intersection)

### `LOOP_VARS_USE_VALUE`
- `src/transformer.js`
- `src/compiler/compile-loop.js`

### `SEQUNTIAL_PATHS_USE_VALUE`
- `src/compiler/compiler-base.js`
- `src/compiler/compile-sequential.js`
- `src/compiler/compiler.js`
- `src/runtime/sequential.js`

### `VALUE_IMPORT_BINDINGS`
- `src/environment/context.js`
- `src/compiler/compile-inheritance.js`
- `src/compiler/compiler.js`

### `INCLUDE_PRELINK_OUTPUTS`
- `src/compiler/compile-inheritance.js`

### `INHERITANCE_CONTEXT_ONLY_LOOKUP`
- `src/compiler/compiler-base.js`

### `LOOKUP_DYNAMIC_OUTPUT_LINKING` (keep)
- `src/runtime/lookup.js`

## Appendix B: Additional Unguarded Removal Targets

These are not just flag branches; they are core legacy mechanisms.

- `src/compiler/compile-async.js`
  - var write/read propagation model (`writeCounts`/`readVars` support).
- `src/compiler/compile-emit.js`
  - async-block arg emission tied to `readVars`/`writeCounts`.
- `src/compiler/validation.js`
  - read/write counter consistency checks specific to var-sync model.
- `src/runtime/frame.js`
  - parent var promisification/countdown lifecycle.
- `src/runtime/async-state.js`
  - runtime plumbing for `readVars`/`writeCounts`.
- `src/runtime/checks.js`
  - pending write-counter checks.
- `src/runtime/lookup.js`
  - compatibility mixed lookup helper: `contextOrFrameOrValueLookup`.

## Appendix C: Coverage Notes (Observed Dead/Cold Areas)

From Istanbul output:
- `src/runtime/sequential.js`: legacy frame-lock family is zero-hit.
- `src/runtime/lookup.js`: `contextOrFrameOrValueLookup`, `contextOrFrameLookupScript`, `contextOrFrameLookupScriptAsync` are zero-hit.
- `src/compiler/compile-async.js`: `_combineWriteCounts` is unhit.
- `src/compiler/compiler.js`: legacy fallback branches exist for `context.setVariable(...)`, `contextOrFrameLookup(... "__parentTemplate")`, `frame.skipBranchWrites(...)`.

## Appendix D: Affected Files Checklist

### Code
- `src/feature-flags.js`
- `src/parser.js`
- `src/transformer.js`
- `src/environment/template.js`
- `src/environment/context.js`
- `src/compiler/compile-async.js`
- `src/compiler/compile-emit.js`
- `src/compiler/compile-loop.js`
- `src/compiler/compile-sequential.js`
- `src/compiler/compile-inheritance.js`
- `src/compiler/compiler-base.js`
- `src/compiler/compiler.js`
- `src/compiler/validation.js`
- `src/runtime/async-state.js`
- `src/runtime/frame.js`
- `src/runtime/checks.js`
- `src/runtime/lookup.js`
- `src/runtime/sequential.js`

### Tests/docs to re-baseline (remove obsolete branch assumptions if present)
- `tests/script-transpiler.js`
- `tests/pasync/loops.js`
- `tests/poison/call-suppression.js`
- `tests/poison/lookup.js`
- `tests/compiler.js`
- `docs/code/var-transition.md`
- `docs/code/value-import-bindings.md`
- `docs/code/include-linking.md`
- `docs/code/loop-value-path-finish.md`
- `docs/code/guard-seq-path-repair.md`

## Appendix E: Expanded Practical Order

1. Remove all migration flags except `LOOKUP_DYNAMIC_OUTPUT_LINKING`.
2. Remove non-value sequence runtime/compiler branches.
3. Remove compiler `writeCounts`/`readVars` model and all emitted wiring.
4. Remove runtime frame countdown/promisification mechanisms.
5. Remove async template frame fallback emissions and compatibility mixed lookup helper.
6. Remove legacy async publication branches (`context.setVariable` compatibility paths).
7. Clean dead exports/imports/comments and run full test suite.

## Done Criteria

- No async code path uses write counters, readVars snapshots, or parent var promisification.
- `src/runtime/sequential.js` contains only value-path sequencing.
- Async template inheritance/symbol reads do not use frame fallback.
- Only `LOOKUP_DYNAMIC_OUTPUT_LINKING` remains from migration flags.
- Full test suite still passes.
