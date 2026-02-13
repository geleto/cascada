# Output Architecture

This document reflects the current runtime output pipeline.

## Scope

Covers:

- Output declaration and lookup
- `CommandBuffer` write lifecycle
- Iterator-driven command application
- `snapshot()` command semantics
- Output result shaping (`text`, `data`, `value`, `sink`)
- Guard output snapshot/restore behavior
- `safe-output` text materialization behavior

## End-to-End Flow

1. Compiler/runtime enqueue commands into `CommandBuffer.arrays[outputName]`.
2. Each output has one `BufferIterator`.
3. Iterator walks buffer slots (including nested buffers) and calls `output._applyCommand(cmd)` as soon as entries are ready.
4. Commands mutate output state (`_target` / `_base`) and accumulate errors.
5. `snapshot()` enqueues a `SnapshotCommand` when buffer is still open. The returned promise resolves when that command is applied.
6. When iterator reaches finished root buffer, output completion is resolved via `output._onIteratorFinished()`.
7. `snapshot()` called after finish resolves from current output state/completion promise.

There is no active linked-command-chain traversal (`next`) in runtime flow.

## Core Runtime Objects

## `CommandBuffer` (`src/runtime/command-buffer.js`)

Primary fields:

- `arrays`: per-handler arrays of entries (`Command`, child `CommandBuffer`, or reserved `null`)
- `parent`: parent `CommandBuffer` when nested
- `finished`: set when finish requested and no reserved slots remain
- `_outputs`: shared `Map<handlerName, Output>` for a buffer tree
- `_visitingIterators`: iterators currently visiting this buffer
- `_pendingReservedSlots`: reserved-but-not-filled slot count
- `_finishRequested`: finish requested flag
- `_pauseRefCount`: pause counter used by guard gating

Write APIs:

- `add(value, outputName)`
- `_fillSlot(slot, value, outputName)`
- `addAsyncArgsCommand(...)`
- `addText(...)`, `addPoison(...)`, `addBuffer(...)`

Finish behavior:

- `markFinishedAndPatchLinks()` requests finish
- `_tryCompleteFinish()` sets `finished = true` only when `_pendingReservedSlots === 0`
- finished/resume notifications wake iterators

Pause/resume behavior:

- `pause()` / `resume()` adjust pause refcount on current buffer and ancestors
- when refcount drops to zero, iterators are notified via `onBufferResumed`

## `BufferIterator` (`src/runtime/buffer-iterator.js`)

Each output has one iterator.

Traversal rules:

- Processes ready non-null slots
- Enters child `CommandBuffer` depth-first
- Applies commands immediately through `output._applyCommand`
- If `apply` returns a promise, waits for it before continuing
- Stops when blocked on missing slot or unfinished buffer and resumes on notifications
- Marks finished at fully-consumed finished root buffer and notifies output

## Output Objects (`src/runtime/output.js`)

Base `Output` fields:

- `_outputName`, `_outputType`
- `_frame`, `_context`
- `_buffer`
- `_target`, `_base`
- `_iterator`
- `_errors`
- `_completionResolved`, `_completionPromise`

Subclasses:

- `TextOutput`: `_target = []`
- `ValueOutput`: `_target = undefined`
- `DataOutput`: `_base = DataHandler(...)`, `_target = _base.data`

Registration:

- Outputs register in buffer `_outputs` (`Map`) and bind iterator
- `declareOutput(...)` associates outputs with lexical frame and active output buffer

Apply/error behavior:

- `_applyCommand(cmd)` runs `cmd.apply(this)`
- promise-returning command applications are awaited by iterator
- errors are accumulated in `_errors` (including `PoisonError.errors[]`)

### `snapshot()` Semantics

`Output.snapshot()` has two paths:

- **Open buffer** (`_buffer && !_buffer.finished`):
  - enqueue `SnapshotCommand`
  - return command promise immediately
  - promise resolves/rejects as soon as command is applied (does not wait for whole buffer finish)
- **Finished/finishing path**:
  - resolve from `_resolveSnapshotCommandResult()` immediately if completion already resolved
  - otherwise wait for `_completionPromise`, then resolve/reject from output state

`SnapshotCommand` resolves via `dispatchCtx._resolveSnapshotCommandResult()`.

## Data Snapshot Copy-on-Write

`DataOutput` protects previously returned snapshot objects via lazy copy-on-write:

- On snapshot result, mark `_snapshotShared = true` for object results.
- Before next mutating command, clone current `_target` (`cloneSnapshotValue`) and rebind `_base.data`.
- This keeps earlier snapshots immutable for plain object/array data.

`cloneSnapshotValue` deep-clones:

- arrays
- plain objects (`Object.getPrototypeOf(value) === Object.prototype`)

Non-plain objects are returned by reference.

## Sink Output (`SinkOutputHandler`)

Behavior:

- sink initializer can be promise-valued (`_ensureSinkResolved`)
- sink commands run against resolved sink
- command errors accumulate in `_errors`

`snapshot()` return resolution order:

1. `sink.snapshot()`
2. `sink.getReturnValue()`
3. `sink.finalize()`
4. sink object itself

## Guard Output Snapshot/Restore

Guard runtime (`src/runtime/guard.js`) behavior for outputs:

- `initOutputSnapshots(frame, handlerNames)` captures state for non-sink outputs using `_captureGuardState()`
- sink handlers are tracked separately and cleared on revert (no target restore)
- `restoreOutputs(buffer, state)`:
  - clears affected handler arrays via `clearBuffer(...)`
  - restores non-sink targets by enqueueing `SetTargetCommand`

Compiler ordering note:

- sequence lock repair for guard is emitted before guard body scheduling so lock recovery is established before guarded operations run.

## Output Declaration and Lookup

- `declareOutput(frame, outputName, outputType, context, initializer)`:
  - requires active output buffer
  - creates output/sink handler
  - stores in lexical `frame._outputs`
  - registers in buffer `_outputs`
  - for sinks, records in `buffer._outputHandlers`

- `getOutputHandler(frame, name)` resolves through lexical `frame._outputs` chain.

## `safe-output` Materialization (`src/runtime/safe-output.js`)

Template text materialization is snapshot-first:

- if value is `CommandBuffer`: `getOutput('text').snapshot()`
- if value has `snapshot()`: call it
- otherwise return value as-is

`suppressValueAsync` and related helpers also route `CommandBuffer` and snapshot-capable values through `snapshot()`.

## Removed Legacy Runtime API

- `runtime.flattenBuffer` and `src/runtime/flatten-buffer.js` are removed from active runtime API.
- Output materialization and compatibility now rely on `snapshot()` directly.

## Invariants

- Buffer entries are commands, child buffers, or reserved `null` slots.
- Command application is iterator-driven and on-the-fly.
- Snapshot resolution is command-based while buffer is open.
- Earlier data snapshots remain immutable for plain object/array targets via lazy copy-on-write.
- Errors are accumulated per output and surfaced via `snapshot()`.
