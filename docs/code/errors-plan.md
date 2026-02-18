# Output Error Model Refactor Plan

This plan tracks the error refactor for typed outputs (`data`, `text`, `value`, `sink`, `sequence`) and is synchronized with the current implementation.

## Goals

- Error state should come from current output state (`_target`) at observation time.
- Repaired outputs should become healthy when poison is overwritten/recovered.
- Output observation (`snapshot/isError/getError`) must execute in command order.
- Remove legacy command-history error collection from guard and output health checks.
- Keep behavior deterministic and test suite green after each step.

## Current Implementation Status

## Done

- Output state/version/cache plumbing exists:
  - `_getTarget()`, `_setTarget()`, `_markStateChanged()`
  - `_inspectionCache = { version, hasError, poisonError }`
  - recursive `inspectTargetForErrors(target)` in `src/runtime/output.js`
- Output observation commands exist and are wired:
  - `SnapshotCommand`, `IsErrorCommand`, `GetErrorCommand`, `SinkRepairCommand`
  - `CommandBuffer.addSnapshot/addIsError/addGetError/addSinkRepair`
  - compiler emits these for output observation calls
- Command poison semantics mostly moved into typed commands:
  - `TextCommand`, `DataCommand`, `ValueCommand`, `SinkCommand` encode poison into output state instead of early throw-gating in base class
- Pre-`apply` argument resolution is centralized:
  - `resolveCommandArgumentsForApply()` in `Output._applyCommand()`
  - commands are created with unresolved args and resolved once before `apply()`
- Queue-fill error contextualization was removed from `addAsyncArgsCommand()`:
  - `TargetPoisonCommand` now contextualizes errors during `apply()` against output context/position.
- `addAsyncArgsCommand()` contract was simplified:
  - runtime/context/position plumbing was removed from queue-fill API.
  - compiler callsites now pass only `(outputName, valueOrPromise, cb)`.
- Compile-time output text normalization path was removed from construction flow and moved to command/runtime (`TextCommand.normalizeArgs` path).
- `Context` now carries `scriptMode` and it propagates through `Template` context creation/fork.
- `compileOutput` now has explicit split:
  - async mode: command-buffer path
  - non-async mode: direct string concatenation path (no command-buffer commands)
- Buffer clearing/pause-driven output rollback was removed from active guard flow.

## Partially Done / Still Transitional

- Guard output error collection is observation-based:
  - `guard.collectOutputErrors()` uses observation commands (`addGetError`) scoped to handlers used in the current guard block.
- `TextCommand` still performs normalization inside `apply()` (acceptable now, but resolver boundary can still be simplified later).
- `addAsyncArgsCommand()` still awaits promise payloads and converts failures into `TargetPoisonCommand` at queue-fill time.
- Some compiled async text paths still keep a temporary timing await (`runtime.resolveSingle(...)`) to preserve current write-count/locking behavior.

## Explicit Non-Goals (for now)

- No broad scheduler rewrite.
- No change to sequence transaction semantics unless required by guard migration.
- No speculative command coalescing/merging until output health model is fully stabilized.

## Target End State

- Output health checks are based on `_target` only.
- `snapshot/isError/getError` observe the stream through commands and do not depend on buffer history scanning.
- Guard uses output observation commands/APIs for output errors (not command history walks).
- `_errors` side channel is removed from output health semantics.
- Command construction stays simple (`new XxxCommand(...)` with unresolved args).
- Argument resolution and error contextualization happen once, immediately before or during apply flow, with no marker-property hacks.

## Step Plan (Updated)

## Step 1: Guard Output Errors via Output Observation

Scope:

- Replace `guard.collectOutputErrors()` primary implementation:
  - collect errors from actual output handlers (via `buffer._outputs`)
  - use observation commands (`addGetError`) on the active/current buffer for ordering
- Ensure guard passes only relevant handlers for observation (handlers used in that guard block), avoiding observation waits on unrelated future/root-buffer streams.
- Ensure collection respects `allowedHandlers` filtering.
- Preserve sequence transaction handling (`begin/commit/rollback`) as-is.
- Keep variable/sequence-lock error checks unchanged in this step.

Required changes:

- `src/runtime/guard.js`
- likely small wiring in `src/runtime/command-buffer.js` for handler iteration helpers
- tests under `tests/poison/guard.js` and related poison/guard integration suites

Status:

- Completed.

Acceptance:

- Guard output error collection is observation-first.
- Guard still captures all output errors expected by current tests.
- `npm run test:quick` green.

## Step 2: Remove Legacy Buffer Error Walkers

Scope:

- Remove:
  - `CommandBuffer.getPosonedBufferErrors`
  - `CommandBuffer.getPosonedBufferErrorsAsync`
  - exported wrapper helpers for those methods
  - unresolved-arg probing logic used only by those paths
- Patch any remaining callsites to observation-command-based collection.
- Prerequisite for safe removal:
  - verify no remaining runtime path depends on command-history scans for guard output error detection.

Required changes:

- `src/runtime/command-buffer.js`
- `src/runtime/guard.js`
- any tests importing/using legacy helpers

Status:

- Completed.

Acceptance:

- No runtime path depends on command-history poison scanning for output health.
- `npm run test:quick` green.

## Step 3: Remove `_errors` from Output Health Semantics

Scope:

- Stop merging `_errors` into observation result:
  - `_getErrorNow()` should reflect current `_target` inspection state.
- Replace `_recordError` side-channel behavior with state poisoning behavior:
  - command application failures should poison `_target` (target-level, output-type-specific where needed), not append to `_errors`.
- Update guard snapshot/restore state to stop relying on `_errors.length` bookkeeping.

Required changes:

- `src/runtime/output.js`
- possibly targeted adjustments in `src/runtime/commands.js` for consistent poison encoding on apply failures
- guard state capture/restore helpers

Status:

- Completed.

Acceptance:

- Output can recover by overwriting poisoned target state without sticky side-channel errors.
- Health probes match current target state at observation point.
- `npm run test:quick` green.

## Step 4: Finalize Pre-Apply Resolution Boundary

Scope:

- Keep command construction unresolved and simple everywhere (`new XxxCommand(...)`).
- Ensure all command args are resolved once before apply, then written back to command.
- Eliminate remaining compile-time command error plumbing for output commands.
- Keep text normalization strategy explicit:
  - either leave in `TextCommand.apply()` by design, or move to resolver hook; document final boundary clearly.

Notes:

- Temporary timing await in async compile paths is currently intentional for write-count/lock stability.
- Do not reintroduce marker properties on Error objects.

Required changes:

- `src/compiler/compiler.js`
- `src/compiler/compile-buffer.js`
- `src/runtime/output.js`
- `src/runtime/commands.js`

Acceptance:

- Output command args are unresolved at construction, resolved once before apply.
- No duplicate resolution phases.
- `npm run test:quick` green.

Status:

- Completed.

## Step 5: Async Command Fill Simplification

Scope:

- Simplify `addAsyncArgsCommand` contract where possible:
  - keep deterministic slot ordering
  - avoid ad-hoc producer semantics in normal flow
  - keep fatal error boundary behavior explicit and minimal
- Ensure non-fatal failures become poison in target path, not hidden side channels.

Required changes:

- `src/runtime/command-buffer.js`
- compiler callsites emitting async add paths

Acceptance:

- Queue-fill path is simpler and easier to reason about.
- No behavior regression in async ordering/error propagation.

Status:

- Completed.

## Step 6: Compiler Cleanup for Output Observation/Error Paths

Scope:

- Confirm all output `is error` and `#` paths use output observation commands consistently.
- Keep non-async template path free of command-buffer output-command code.
- Remove stale comments/branches reflecting old behavior.

Required changes:

- `src/compiler/compiler-base.js`
- `src/compiler/compiler.js`
- any affected compile helpers

Acceptance:

- Observation/error compile output matches runtime model and tests.

## Step 7: Test Consolidation

Scope:

- Merge staged output-error refactor test files into:
  - `tests/pasync/output-errors.js`
- Migrate and deduplicate coverage from:
  - `tests/output-error-inspection.js`
  - `tests/output-step2-command-poison.js`
  - `tests/output-step3-observation-commands.js`
- Remove superseded split files.

Acceptance:

- Single consolidated output-errors suite with equivalent coverage.
- `npm run test:quick` green.

## Step 8: Documentation Cleanup

Scope:

- Update docs that still describe removed behavior (pause/clear/legacy history collection):
  - `docs/code/output.md`
  - this plan file (final status flip)
- Ensure docs match current command/observation flow.

Acceptance:

- Docs are consistent with runtime/compiler behavior.

## Known Risks

- Guard migration may miss errors previously captured by history walking if observation point ordering is wrong.
- Removing `_errors` too early can hide apply-time faults if not converted to target poison consistently.
- Async command fill simplification can regress ordering if slot semantics are altered.

Mitigation:

- keep steps small
- add focused tests per step
- run targeted suites plus `npm run test:quick` each step

## Change Control

If implementation reveals a cleaner approach that materially changes this plan:

1. stop at decision point,
2. document divergence and tradeoff,
3. align before continuing.
