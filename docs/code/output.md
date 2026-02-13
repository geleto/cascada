# Output Architecture

This document reflects the current runtime output pipeline.

## Scope

Covers:

- Output declaration and lookup
- `CommandBuffer` write lifecycle
- Iterator-driven command application
- `snapshot()` and `flattenBuffer` behavior
- Output result shaping (`text`, `data`, `value`, `sink`)
- `safe-output` compatibility shim for text buffer flattening

## End-to-End Flow

1. Compiler/runtime write commands into `CommandBuffer.arrays[outputName]`.
2. Each output owns one `BufferIterator`.
3. Iterator walks buffer slots (including child buffers) and calls `output._applyCommand(cmd)` as soon as entries are ready.
4. Applied commands mutate output state (`_target`/`_base`) and accumulate errors.
5. When iterator reaches the finished root buffer, it marks `iterator.finished` and calls `output._onIteratorFinished()`, resolving output completion.
6. `snapshot()` returns current result (fast path while still running) or completion-backed result/error.

There is no linked command chain and no `.next` traversal in active runtime flow.

## Core Runtime Objects

## `CommandBuffer` (`src/runtime/command-buffer.js`)

Primary fields:

- `arrays`: per-handler arrays of entries (`Command`, child `CommandBuffer`, or reserved `null`)
- `parent`: parent `CommandBuffer` when nested
- `finished`: true when finish requested and no reserved slots remain
- `_outputs`: shared `Map<handlerName, Output>` for a buffer tree
- `_visitingIterators`: iterators currently visiting this buffer, keyed by output name
- `_pendingReservedSlots`: reserved-but-not-filled slot count
- `_finishRequested`: finish requested flag
- `_pauseRefCount`: pause counter used by guard-block gating

Write APIs:

- `add(value, outputName)`: reserve slot, set value, notify iterator
- `_fillSlot(slot, value, outputName)`: fill previously reserved slot, notify iterator
- `addAsyncArgsCommand(...)`: reserve first, then fill with command or `ErrorCommand`
- `addText(...)`, `addPoison(...)`, `addBuffer(...)`

Child buffer attach behavior:

- `value.parent = this`
- child `_outputs` map is shared with parent

Finish behavior:

- `markFinishedAndPatchLinks()` sets finish requested
- `_tryCompleteFinish()` sets `finished = true` only when `_pendingReservedSlots === 0`
- `onBufferFinished` notifications wake visiting iterators

Pause/resume behavior:

- `pause()` / `resume()` adjust pause refcount on this buffer and all parents
- when refcount drops to zero, iterators are notified via `onBufferResumed`

## `BufferIterator` (`src/runtime/buffer-iterator.js`)

Each output has one iterator. State:

- `stack`: traversal stack of `{ buffer, index }`
- `_enteredBuffer`: current buffer for enter/leave notifications
- `finished`
- `_isAdvancing`, `_needsAdvance`: re-entrancy/drive-control flags

Traversal rules:

- Process only non-null ready slots.
- Enter child `CommandBuffer` depth-first.
- Apply commands immediately through `output._applyCommand`.
- If `apply` returns a promise, wait for it before continuing.
- When blocked on missing slot or unfinished buffer, return and wait for notifications.
- When root buffer is finished and fully consumed, set `finished = true` and notify output.

## Output Objects (`src/runtime/output.js`)

Base `Output` fields:

- `_outputName`, `_outputType`
- `_frame`, `_context`
- `_buffer`
- `_target`, `_base`
- `_iterator`
- `_errors`
- `_completionResolved`, `_completionPromise`

`Output` constructor receives `target` and `base` from subclasses:

- `TextOutput`: `target = []`, `base = null`
- `ValueOutput`: `target = undefined`, `base = null`
- `DataOutput`: `target = {}`, `base = DataHandler(...)`

Output registration:

- Constructor registers with buffer via `_registerOutput` when available, otherwise direct map insert + bind.
- `declareOutput(...)` also rebinds after assigning the scoped output buffer.

Apply/error behavior:

- `_applyCommand(cmd)` executes `cmd.apply(this)`
- if it returns a promise, errors are captured via `.catch(...)`
- `PoisonError` is unwrapped into underlying `errors[]` in `_recordError`

Completion/snapshot behavior:

- `_onIteratorFinished()` resolves completion once.
- `snapshot()`:
- if iterator not finished: returns current result (or throws immediate `PoisonError` if errors exist)
- if finished: waits on completion promise, then returns result or throws `PoisonError`

## `SinkOutputHandler` (`src/runtime/output.js`)

Sink-specific behavior:

- Resolves sink lazily via `_ensureSinkResolved()` (supports promise-valued sink initializers).
- `_applyCommand` waits for sink readiness, then runs `cmd.apply(this)`.
- Promise-returning `cmd.apply(...)` is handled with the same async error capture path as other outputs.
- `snapshot()` resolves sink return value via:
- `sink.snapshot()` if present
- else `sink.getReturnValue()`
- else `sink.finalize()`
- else sink object itself

## Flatten Behavior

## `flattenBuffer(output, errorContext?)` (`src/runtime/flatten-buffer.js`)

Current role is compatibility validation + delegation:

- validates output shape and `_buffer` type
- requires `snapshot()` presence
- sync-first compatibility:
- if `output._completionResolved === true`, returns/throws synchronously from current output state
- otherwise returns `output.snapshot()`

`flattenBuffer` does not walk command chains or buffer trees.

## `safe-output` Text Flattening (`src/runtime/safe-output.js`)

`flattenTextCommandBuffer(buffer, errorContext)`:

- tries `buffer._outputs.get('text')`
- if missing, throws `RuntimeFatalError` (`flattenTextCommandBuffer requires a registered text output`)
- forwards to `flattenBuffer(output, errorContext)`

There is no fallback shim anymore. The invariant is enforced: a flattenable `CommandBuffer` must already have a registered `text` output.

## Output Declaration and Lookup

- `declareOutput(frame, outputName, outputType, context, initializer)`:
- finds nearest output buffer (`findOutputBuffer`)
- throws if missing
- creates output/sink handler
- stores in lexical `frame._outputs`
- registers in buffer `_outputs`
- stores sink handlers in `buffer._outputHandlers`

- `getOutputHandler(frame, name)` walks lexical `frame._outputs` chain.

## Guard/Clear Behavior

`clearBuffer(...)` calls `CommandBuffer.patchLinksAfterClear(...)`:

- clears selected handler arrays
- resets lifecycle flags (`finished`, `_finishRequested`, `_pendingReservedSlots`)
- keeps buffer writable after guard recovery

No command-chain link patching is performed.

## Sink Finalization Behavior

`finalizeUnobservedSinks(...)` in `src/runtime/output.js` is currently a no-op.

Sink commands run as soon as iterator can apply them. Unobserved sink errors remain non-fatal unless `snapshot()` is called.

## Invariants

- Buffer entries are commands, child buffers, or reserved `null` slots.
- Command application is iterator-driven and on-the-fly.
- No linked command chain (`next`) is required for active runtime flow.
- Parent/child buffer ordering is enforced by iterator traversal.
- Errors are accumulated per output and surfaced through `snapshot()`/`flattenBuffer` compatibility paths.
