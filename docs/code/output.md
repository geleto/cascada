# Output Architecture

This document describes the current output runtime in `src/runtime/*` and compiler integration points in `src/compiler/*`.

## Scope

- Output declaration and lookup
- CommandBuffer write and finish lifecycle
- Iterator-driven command execution
- Snapshot semantics (`addSnapshot` vs `finalSnapshot`)
- Output types (`text`, `data`, `value`, `sink`, `sequence`)
- Command classes and deferred sequence results
- Guard integration for outputs
- `safe-output` snapshot/materialization behavior

## Core Flow

1. Compiler emits `Command` objects into the current `CommandBuffer` (directly or via `addAsyncArgsCommand`).
2. Every declared output has a `BufferIterator` bound to the active root `CommandBuffer`.
3. `BufferIterator` traverses that output's handler stream depth-first (including nested child buffers) in source order.
4. For each command, iterator calls `output._applyCommand(cmd)`, which mutates output state or records errors.
5. Snapshot reads are either:
   - point-in-stream via `CommandBuffer.addSnapshot(outputName, pos)`
   - terminal via `output.finalSnapshot()`
6. Completion resolves when iterator finishes the root buffer for that output.

## Runtime Objects

## `CommandBuffer` (`src/runtime/command-buffer.js`)

Important fields:

- `arrays[outputName]`: per-output stream entries (commands or child `CommandBuffer`s)
- temporary `null` slot placeholders preserve source order for async producers
- `parent`: parent command buffer
- `finished`, `_finishRequested`, `_pendingReservedSlots`
- `_outputs`: shared `Map<outputName, Output>`
- `_visitingIterators`: currently visiting iterators
- `_pauseRefCount`, `_pausedHandlers`: guard pause state

Important APIs:

- `add(value, outputName)`
- `addText(value, pos, outputName)`
- `addAsyncArgsCommand(outputName, producer, runtime, context, lineno, colno, errorContextString, cb)`
- `addBuffer(childBuffer, outputName)`
- `addSequenceGet(...)`, `addSequenceCall(...)`
- `addSnapshot(outputName, pos)`
- `markFinishedAndPatchLinks()`
- `pauseHandlers(handlerNames)`, `resumeHandlers(handlerNames)`
- `patchLinksAfterClear(handlerNames)` (guard rollback/reset)
- `getPosonedBufferErrors(allowedHandlers)` (recursive poison collection)

Finish semantics:

- `markFinishedAndPatchLinks()` marks finish requested.
- Buffer becomes `finished=true` only when no reserved slots remain.
- Iterators are notified on slot fill, finish, and resume.
- `clearBuffer()` resets finished state (`finished=false`, `_finishRequested=false`, pending slots cleared) so writes can continue after guard recovery.

## `BufferIterator` (`src/runtime/buffer-iterator.js`)

Per-output iterator, depth-first traversal:

- Processes entries in per-output order.
- Enters child buffers and resumes parent when child is done.
- Awaits async command application before continuing.
- Stops on gaps, paused handlers, or unfinished buffers; resumes via notifications.
- Calls `output._onIteratorFinished()` when its root traversal is complete.
- Uses reentrancy guards (`_isAdvancing`, `_needsAdvance`) to coalesce repeated wake-ups.

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

Factory/lookup and scoping:

- `declareOutput(frame, name, type, context, initializer)`
- `getOutput(frame, name)`
- `findOutputBuffer(frame)`
- Outputs are lexical: `getOutput` walks `frame.parent` chain only.
- `findOutputBuffer` stops when it hits `frame.outputScope`.
- `declareOutput` throws if no active `CommandBuffer` exists (no implicit buffer creation).

## Snapshot Semantics

There are two distinct snapshot mechanisms:

1. `CommandBuffer.addSnapshot(outputName, pos)`
- Enqueues a `SnapshotCommand` when buffer is not finished.
- Promise resolves/rejects when that command executes (point-in-stream semantics).
- If buffer is already finished, snapshot is applied immediately, or deferred until output completion if iterator is still finalizing.

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

`ValueOutput` does not deep-clone target values and defaults to `null` for declaration-only outputs.

## Output Facades and Commands

`createOutput(...)` returns facades:

- `text` and `value` outputs are callable facades (`output(...)`).
- `data` output is a dynamic command facade (`output.set(...)`, `output.push(...)`, etc.).
- Facades proxy runtime internals (`_target`, `_iterator`, `finalSnapshot`, etc.) to the underlying `Output`.
- Facades intentionally hide `then` to avoid thenable behavior.

Command classes live in `src/runtime/commands.js`:

- `TextCommand`, `ValueCommand`, `DataCommand`, `SinkCommand`
- `SequenceCallCommand`, `SequenceGetCommand`
- `SnapshotCommand`, `SetTargetCommand`, `ErrorCommand`

Sequence deferred results:

- `CommandBuffer.addSequenceCall(...)` and `.addSequenceGet(...)` return command-local promises.
- These resolve/reject when the iterator actually executes those commands.

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
- Sequence transactions begin at guard entry and are settled in reverse order on commit/rollback.

Important restriction:

- `sink.snapshot()` inside guard is disallowed at compile time:
  - `"sink snapshot() is not allowed inside guard blocks"`

## `safe-output` Integration (`src/runtime/safe-output.js`)

Template suppression/materialization uses:

- `CommandBuffer` -> `buffer.addSnapshot("text", pos)`
- value with `finalSnapshot()` -> call it
- value with `snapshot()` -> call it
- otherwise normal scalar suppression

`safe-output` also normalizes call-block/filter envelopes (`{ text: [...] }`, `{ output: [...] }`) before suppression.

## Removed Legacy Behavior

- No legacy `flattenBuffer` chain execution in active runtime.
- Output execution is iterator-driven and incremental.
