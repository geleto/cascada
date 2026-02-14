# Snapshot Semantics

This document describes the current snapshot model.

## Two Snapshot APIs

## 1) Positional Snapshot (`CommandBuffer.addSnapshot`)

API:

- `buffer.addSnapshot(outputName, { lineno, colno })`

Behavior:

- If buffer is open, enqueues `SnapshotCommand` into that output stream.
- Returned promise resolves/rejects when iterator reaches that command.
- Snapshot observes exactly the output/error state up to that command position.
- Later commands do not affect that already-resolved snapshot promise.

Finished-buffer behavior:

- If target buffer is already finished, `addSnapshot` applies immediately.
- If output completion is still pending, it waits for completion and then applies.

Used by:

- Compiled `outputVar.snapshot()` calls (declared outputs)
- `safe-output` text materialization for `CommandBuffer` values

## 2) Final Snapshot (`output.finalSnapshot()`)

API:

- `output.finalSnapshot()`

Behavior:

- Waits for output completion (iterator finished root traversal).
- Returns final result or throws `PoisonError` from accumulated output errors.
- If already completed, resolves synchronously via resolved promise path.

Used by:

- Root/final return handling
- Direct final output materialization paths

## SnapshotCommand (`src/runtime/commands.js`)

- Created with deferred promise.
- `apply(dispatchCtx)` calls `dispatchCtx._resolveSnapshotCommandResult()`.
- Resolves value or rejects with contextualized error.
- If output reports accumulated errors, rejection is `PoisonError`.

## Output-Type Snapshot Results

- `TextOutput`: joined text string
- `DataOutput`: current data tree
  - copy-on-write preserves previous snapshot stability after later mutations
- `ValueOutput`: current assigned value (no deep-copy semantics)
- `SinkOutput` / `SequenceOutput`:
  - `snapshot()`, else `getReturnValue()`, else `finalize()`, else sink object

## Error Semantics

- Command application errors are accumulated per output.
- Snapshot rejects when accumulated errors exist at observation point.
- Dedup behavior follows runtime error collection rules (`PoisonError` payload handling).

## Guard Interaction

- Non-sequence guarded outputs may be paused by handler during guard execution.
- Sequence outputs use transaction hooks instead of handler pause.
- `sink.snapshot()` inside guard is compile-time rejected.

## Compiler Mapping

- Declared output symbol read: `runtime.getOutput(frame, "name")`
- `name.snapshot()` compiles to `currentBuffer.addSnapshot("name", pos)`
- Final root materialization uses `finalSnapshot()`

## Notes

- Snapshot semantics are buffer-position based for `addSnapshot`.
- `finalSnapshot` is completion-based.
- Both coexist intentionally and serve different use cases.
