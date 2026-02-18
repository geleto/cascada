# Output Runtime Architecture (Current)

This document describes the current output model in `src/runtime/*` and its compiler integration in `src/compiler/*`.

## Scope

- Typed outputs and facades (`data`, `text`, `value`, `sink`, `sequence`)
- CommandBuffer stream model
- Iterator-driven apply flow
- Observation commands (`snapshot`, `isError`, `getError`, `repair`)
- Guard integration (result-based error collection)
- Error model (`_target`-based health, no command-history walkers)

## High-Level Flow

1. Compiler emits command objects into the current `CommandBuffer` per output handler stream.
2. Each declared output owns a `BufferIterator` bound to the active buffer tree.
3. Iterator applies commands in source order (`output._applyCommand(cmd)`).
4. Command arguments are resolved once immediately before `cmd.apply(...)`.
5. Output health is derived from current `_target` (cached by state version).
6. Observation commands resolve at the exact stream point where they were enqueued.

## CommandBuffer

File: `src/runtime/command-buffer.js`

Important state:

- `arrays[outputName]`: per-output stream entries (commands or child buffers)
- `_outputs`: shared `Map<outputName, Output>` across parent/child buffers
- `_pendingReservedSlots`: count of async-reserved slots not yet filled
- `_finishRequested` + `finished`
- `_visitingIterators`: active iterator per output name

Important APIs:

- `add(value, outputName)`
- `addText(value, pos, outputName)`
- `addAsyncArgsCommand(outputName, valueOrPromise, onFatal = null)`
- `addSequenceCall(...)`, `addSequenceGet(...)`
- `addSnapshot(outputName, pos)`
- `addIsError(outputName, pos)`
- `addGetError(outputName, pos)`
- `addSinkRepair(outputName, pos)`
- `markFinishedAndPatchLinks()`

Notes:

- `addAsyncArgsCommand` reserves a slot synchronously, then fills it when `valueOrPromise` settles.
- Non-fatal producer failures are encoded as `TargetPoisonCommand` in that slot.
- `RuntimeFatalError` is rethrown and optionally reported through `onFatal`.
- Legacy history walkers (`getPosonedBufferErrors*`) are removed.
- Handler pause/clear rollback logic is not part of active guard flow anymore.

## BufferIterator

File: `src/runtime/buffer-iterator.js`

- Traverses one output stream depth-first across nested child buffers.
- Applies commands in source order.
- Waits at unfinished gaps and resumes when slots fill / buffers finish.
- Marks output completion via `output._onIteratorFinished()`.

## Output Base Model

File: `src/runtime/output.js`

Core fields:

- `_target`: current materialized state for this output
- `_stateVersion`: incremented on each state mutation
- `_inspectionCache = { version, hasError, poisonError }`
- `_completionPromise` / `_completionResolved`

Core behavior:

- `_applyCommand(cmd)`:
  - resolves command args once via `resolveCommandArgumentsForApply(cmd, output)`
  - executes `cmd.apply(output)`
  - converts apply/prep failures into poison on `_target`
- `_ensureInspection()` inspects `_target` for poison and caches by `_stateVersion`
- `_isErrorNow()` / `_getErrorNow()` read from `_target` inspection
- `_resolveSnapshotCommandResult()` returns current result or throws `PoisonError`

Important model decision:

- Output health is `_target`-based.
- No side-channel `_errors` list is used for health semantics.

## Typed Outputs

File: `src/runtime/output.js`

- `TextOutput`
- `DataOutput`
- `ValueOutput`
- `SinkOutput`
- `SequenceOutput` (transaction-capable sink variant)

`DataOutput` keeps copy-on-write snapshot safety for immutable prior snapshots.

## Observation Commands

File: `src/runtime/commands.js`

- `SnapshotCommand`
- `IsErrorCommand`
- `GetErrorCommand`
- `SinkRepairCommand`
- `TargetPoisonCommand` (queue-fill/apply-time poison encoding)

Observation semantics:

- If buffer is still active, observation commands are enqueued in stream order.
- If buffer is finished, command buffer applies observation against registered output state (or waits for output completion when needed).

## Compiler Integration

Files:

- `src/compiler/compile-buffer.js`
- `src/compiler/compiler-base.js`
- `src/compiler/compiler.js`

Current behavior:

- Output commands are constructed with unresolved args.
- `resolveOutputCommandArgs` pre-resolution path is removed from command construction flow.
- In async script/output mode:
  - output `x.snapshot()`, `x.isError()`, `x.getError()` compile to observation commands
  - `x is error` and `x#...` for declared outputs also route through observation commands
- Non-async template path remains direct string output (no command-buffer command path for simple sync rendering).

## Guard Integration

File: `src/runtime/guard.js`

- Guard output errors are collected via observation (`buffer.addGetError(...)`) on relevant handlers.
- Guard output revert uses output state snapshots + `SetTargetCommand` restoration.
- Sequence outputs use begin/commit/rollback transaction hooks.
- Guard completion remains result-based; no legacy buffer-history poison scan.

## Removed / Obsolete Behavior

- No active guard rollback via handler pause/resume + clear-buffer mutation.
- No `patchLinksAfterClear` / `clearBuffer`-based recovery model.
- No `getPosonedBufferErrors` / `getPosonedBufferErrorsAsync` traversal path.
- No output health side-channel based on `_errors`.

## Test Coverage

Consolidated output-error suite:

- `tests/pasync/output-errors.js`

It includes coverage from former split files:

- command poison encoding
- output observation commands
- target inspection cache behavior
- async slot fill / fatal propagation
