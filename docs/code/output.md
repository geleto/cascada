# Output Runtime Architecture (Current)

## Architectural Primer: Why This Exists
Cascada is concurrent by default, but it must still produce the same observable result as a correct sequential execution. That guarantee comes from the command-tree model:
- each async region emits commands into an ordered stream segment,
- nested async regions become child segments in that tree,
- iterators apply commands in deterministic source order, waiting for reserved slots when needed.

This is the mechanism behind temporal sequential equivalence. Work can start/finish out of order in wall-clock time, but output effects are committed in the program order defined by the command tree.

Do not bypass these mechanisms to fix a local bug. Shortcuts such as writing to the wrong buffer, forcing direct state writes, skipping links, or finishing buffers early may unblock one test while breaking ordering, poisoning, snapshots, or set-block behavior elsewhere. If a fix does not preserve command insertion order + buffer hierarchy + finalize/link rules, it is not safe.

This document tracks the output pipeline as implemented in:
- runtime: `src/runtime/command-buffer.js`, `src/runtime/buffer-iterator.js`, `src/runtime/output.js`, `src/runtime/channels/*.js`, `src/runtime/guard.js`, `src/runtime/async-state.js`
- compiler wiring: `src/compiler/buffer.js`, `src/compiler/emit.js`, `src/compiler/compiler.js`, `src/compiler/validation.js`

## Scope
- Output types and facades: `text`, `value`, `data`, `sequence`
- Command buffering and iterator apply model
- Async block buffer ownership (`usedOutputs` -> buffer creation)
- Output observations (`snapshot`, `isError`, `getError`)
- Guard output snapshot/restore and sequence transaction handling

## End-To-End Flow
1. Compiler emits command objects into the current `CommandBuffer` stream keyed by handler name.
2. Compiler passes the active buffer into async closures as `currentBuffer` (`astate.asyncBlock(async (astate, frame, currentBuffer) => { ... })`).
3. Output declaration receives the explicit target buffer (`runtime.declareOutput(frame, currentBuffer, ...)`).
4. Each declared output owns a `BufferIterator` bound to its effective root buffer.
5. The iterator walks command slots (including nested child buffers) in stream order and calls `output._applyCommand(cmd)`.
6. Command args are resolved once at apply-time (`resolveCommandArgumentsForApply`), not at compile-time enqueue.
7. Output error state is derived from current `_target` via `_ensureInspection()` cache (`_stateVersion` keyed).
8. Observation commands resolve at the stream point where they are enqueued; post-finish observations apply directly to registered outputs.

## Buffer Ownership And Creation
- Root/managed scope-root creation sites:
  - compiler emits `runtime.createCommandBuffer(context, null, frame)` in managed root paths (`emit`/`buffer`).
- Async block creation site:
  - `AsyncState.asyncBlock(...)` creates a child buffer only when `usedOutputs` is a non-empty array.
  - the created buffer is passed into the async closure as `currentBuffer` and finalized in `finally` via `markFinishedAndPatchLinks()`.
- Non-owning child frames:
  - nested lexical frames execute against inherited `currentBuffer` binding.
  - no implicit buffer creation in `declareOutput`; missing active buffer is a hard error.

## CommandBuffer
File: `src/runtime/command-buffer.js`

Key state:
- `parent`: parent buffer link (for nested stream structure)
- `arrays[outputName]`: per-handler stream entries (commands or child buffers)
- `_outputs`: shared `Map<name, Output>` across the buffer hierarchy
- `_pendingReservedSlots`, `_finishRequested`, `finished`
- `_visitingIterators`: output iterator currently traversing a handler in this buffer

Key behavior:
- `_reserveSlot()` creates null placeholder slots; `_fillSlot()` completes them.
- `addAsyncArgsCommand(...)` reserves immediately, then fills:
  - success: fill with command/value
  - non-fatal failure: fill with `TargetPoisonCommand`
  - `RuntimeFatalError`: rethrow (+ optional `onFatal` callback)
- `markFinishedAndPatchLinks()` only marks finish state; iterator progression reacts to slot fill/finish notifications.
- Observation helpers:
  - `addSnapshot`, `addIsError`, `addGetError` enqueue commands while active.
  - if buffer is already finished, they apply directly against registered output (waiting for output completion if needed).

## BufferIterator
File: `src/runtime/buffer-iterator.js`

- Walks one handler stream depth-first across nested child buffers.
- Advances only when next slot is non-null; waits on gaps until notified by slot fill / buffer finish.
- Applies each command via `output._applyCommand(cmd)`.
- On full completion, calls `output._onIteratorFinished()`.

## Output Model
File: `src/runtime/output.js`

Base `Output` state:
- `_target`: current materialized state
- `_buffer`: effective `CommandBuffer`
- `_iterator`: per-output stream iterator
- `_stateVersion` + `_inspectionCache` for error inspection caching
- `_completionPromise` / `_completionResolved` for final snapshot synchronization

Core behavior:
- `_applyCommand(cmd)`:
  - resolves args once (`cmd.resolved` guard)
  - applies command
  - records failures as poison on `_target` (contextualized)
- `_resolveSnapshotCommandResult()` returns current value or throws `PoisonError`
- `_isErrorNow()` / `_getErrorNow()` inspect `_target` via cached inspection

Important rule:
- Output health is `_target`-based only; no side-channel history/error list defines health.

## Output Types
- `TextOutput`: callable append model; compacts joined text on snapshot/get.
- `ValueOutput`: callable replace model; declaration default target is `null`.
- `DataOutput`: dynamic command model (`set/push/...`) through `DataHandler`; copy-on-write after shared snapshot.
- `SequenceOutput`: ordered command dispatch into an initialized object, with snapshot/read fallback methods and guard transaction hooks (`begin/commit/rollback`).

## Commands
File: `src/runtime/channels/*.js`

Mutating output commands:
- `TextCommand`, `ValueCommand`, `DataCommand`
- `SequenceCallCommand` (mutating call into sequence target)
- `TargetPoisonCommand` (encodes producer/apply poison into target)
- `SetTargetCommand` (guard restore path)

Non-mutating observation/read commands:
- `SnapshotCommand`
- `RawSnapshotCommand` (ordered raw target read; no nested poison inspection)
- `IsErrorCommand`
- `GetErrorCommand`
- `SequenceGetCommand` (read operation)

Notes:
- command args are resolved at apply-time and rejection/poison paths are normalized to `PoisonedValue`.
- because `PoisonedValue` is thenable, async arg resolution boxes/unboxes poison values to avoid promise assimilation.
- `PoisonError` values are treated as regular values unless explicitly consumed by observation/error paths.
- text normalization and safe output conversion are handled in command apply path.

## Compiler Integration

### Command construction
File: `src/compiler/buffer.js`
- Output commands are emitted with unresolved args.
- `snapshot()/isError()/getError()` are compiled to dedicated command classes.
- Scope/legality validation lives in `src/compiler/validation.js`:
  - `validateOutputCommandScope`
  - `validateOutputObservationCall`

### Output usage tracking
File: `src/compiler/buffer.js`
- `registerOutputUsage(frame, outputName)` records `usedOutputs` along lexical chain up to declaration frame.
- `usedOutputs` metadata is passed to runtime async-block API (`getAsyncBlockArgs` in `emit`).
- `collectBranchHandlers(...)` also includes `Set`/`CallAssign` writes targeting declared outputs (not only `OutputCommand`),
  so condition-poison paths can poison branch-local output writes correctly.

### Async-block wiring
Files: `src/compiler/emit.js`, `src/runtime/async-state.js`
- compiler passes `usedOutputs` into `astate.asyncBlock(...)`.
- runtime allocates child buffer only when `usedOutputs.length > 0`.
- runtime passes active buffer into closure as `currentBuffer`.
- child buffer finalization is guaranteed in async-block `finally`.

## Guard Integration
File: `src/runtime/guard.js`

- Output snapshots for guard are initialized via `initOutputSnapshots(frame, handlerNames)`.
- Non-sequence outputs capture `_captureGuardState()` and restore via `SetTargetCommand`.
- Sequence outputs use transaction lifecycle:
  - begin at guard start
  - commit on clean completion
  - rollback on guard error path
- Guard output error collection uses output observations:
  - `collectOutputErrors` -> `buffer.addGetError(handler)`

## Scoping And Lookup
- Output lookup is lexical (`getOutput(frame, name)` walks `frame.parent` chain).
- Buffer selection is explicit at compile time and passed to runtime calls (`declareOutput(frame, currentBuffer, ...)`).
- `declareOutput(...)` requires an active explicit buffer; it does not create one implicitly.

## Obsolete / Removed Models
- No legacy buffer-history poison scan path (`getPosonedBufferErrors*`).
- No pause/clear output-buffer rollback mechanism.
- No output health semantics based on separate `_errors` side channel.

## Key Tests
- `tests/pasync/channel-errors.js`
- `tests/pasync/script.js` (output scoping and timeout-sensitive script paths)
- `tests/pasync/setblock.js` (text-output buffer capture regression gate)
