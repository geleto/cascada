# Output Architecture

This document describes the current output runtime (not legacy flatten/chain behavior).

## Scope

- Output declaration and lookup
- CommandBuffer write and finish lifecycle
- Iterator-driven command execution
- Snapshot semantics (`addSnapshot` vs `finalSnapshot`)
- Output types (`text`, `data`, `value`, `sink`, `sequence`)
- Guard integration for outputs
- `safe-output` materialization behavior

## Core Flow

1. Compiler emits commands into the current `CommandBuffer` (`buffer.add(...)` / helpers).
2. Each output has one `BufferIterator`.
3. Iterator traverses buffer tree in deterministic source order and calls `output._applyCommand(cmd)`.
4. Commands mutate output state and errors are accumulated on the output.
5. Snapshot can be:
   - point-in-stream via `CommandBuffer.addSnapshot(outputName, pos)`
   - final/terminal via `output.finalSnapshot()`
6. When iterator reaches the finished root buffer, output completion resolves.

## Runtime Objects

## `CommandBuffer` (`src/runtime/command-buffer.js`)

Important fields:

- `arrays[outputName]`: command/child-buffer entries (plus temporary `null` reserved slots)
- `parent`: parent command buffer
- `finished`, `_finishRequested`, `_pendingReservedSlots`
- `_outputs`: shared `Map<outputName, Output>`
- `_visitingIterators`: currently visiting iterators
- `_pauseRefCount`, `_pausedHandlers`: guard pause state

Important APIs:

- `add(value, outputName)`
- `addText(value, pos, outputName)`
- `addBuffer(childBuffer, outputName)`
- `addSequenceGet(...)`, `addSequenceCall(...)`
- `addSnapshot(outputName, pos)`
- `markFinishedAndPatchLinks()`
- `pauseHandlers(handlerNames)`, `resumeHandlers(handlerNames)`

Finish semantics:

- `markFinishedAndPatchLinks()` marks finish requested.
- Buffer becomes `finished=true` only when no reserved slots remain.
- Iterators are notified on slot fill, finish, and resume.

## `BufferIterator` (`src/runtime/buffer-iterator.js`)

Per-output iterator, depth-first traversal:

- Processes entries in per-output order.
- Enters child buffers and resumes parent when child is done.
- Awaits async command application before continuing.
- Stops on gaps/unfinished buffers; resumes via notifications.
- Calls `output._onIteratorFinished()` when its root traversal is complete.

## Output Types (`src/runtime/output.js`)

Base class: `Output`

- Tracks `_target`, `_errors`, `_completionPromise`, `_iterator`.
- `_applyCommand` executes command and records errors.
- `_resolveSnapshotCommandResult()` returns current result or throws `PoisonError`.
- `finalSnapshot()` waits for completion (unless already complete), then resolves result.

Concrete outputs:

- `TextOutput`
- `DataOutput`
- `ValueOutput`
- `SinkOutput`
- `SequenceOutput` (extends sink behavior + transaction hooks)

Factory/lookup:

- `declareOutput(frame, name, type, context, initializer)`
- `getOutput(frame, name)`
- `findOutputBuffer(frame)`

## Snapshot Semantics

There are two distinct snapshot mechanisms:

1. `CommandBuffer.addSnapshot(outputName, pos)`
- Enqueues a `SnapshotCommand` when buffer is not finished.
- Promise resolves/rejects when that command executes (point-in-stream semantics).
- If buffer is already finished, snapshot is applied immediately (or after output completion if needed).

2. `output.finalSnapshot()`
- Terminal snapshot for the output stream.
- Waits for iterator/root completion, then resolves/rejects from final output state.
- Used for root return/final materialization paths.

Compiler note:

- Script `x.snapshot()` is compiled to `currentBuffer.addSnapshot("x", pos)` for declared outputs.
- Sink `snapshot()` inside guard is compile-time rejected.

## Data Snapshot Copy Safety

`DataOutput` uses lazy copy-on-write:

- Snapshot marks current object graph as shared.
- First subsequent mutating data command clones current target.
- Earlier snapshot values stay stable.

`cloneSnapshotValue` deep-clones arrays and plain objects.
Non-plain objects are kept by reference.

`ValueOutput` does not deep-clone target values.

## Sink and Sequence Semantics

`SinkOutput`:

- Supports async sink initialization.
- Applies sink commands against resolved sink.
- `finalSnapshot` result resolution order:
  1. `sink.snapshot()`
  2. `sink.getReturnValue()`
  3. `sink.finalize()`
  4. sink object itself

`SequenceOutput`:

- Extends `SinkOutput`
- Adds `beginTransaction`, `commitTransaction`, `rollbackTransaction`
- Sequence call/get commands can return deferred results via promises

## Guard Integration

Guard output behavior:

- Compiler pauses non-sequence guarded handlers with `pauseHandlers(...)`.
- Guard runtime snapshots/restores output state (`initOutputSnapshots`, `restoreOutputs`).
- On rollback, buffer segments are cleared and restored targets are set via `SetTargetCommand`.
- Sequence outputs are transaction-based (not paused like non-sequence outputs).

Important restriction:

- `sink.snapshot()` inside guard is disallowed at compile time:
  - `"sink snapshot() is not allowed inside guard blocks"`

## `safe-output` Integration (`src/runtime/safe-output.js`)

Template suppression/materialization uses:

- `CommandBuffer` -> `buffer.addSnapshot("text", pos)`
- value with `finalSnapshot()` -> call it
- value with `snapshot()` -> call it
- otherwise normal scalar suppression

This preserves point-in-stream text snapshot behavior for command buffers.

## Removed Legacy Behavior

- No legacy `flattenBuffer` chain execution in active runtime.
- Output execution is iterator-driven and incremental.
