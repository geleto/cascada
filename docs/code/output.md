# Output Architecture

This document reflects the current runtime/compiler output pipeline.

## Scope

Covers:

- Output declaration and lookup
- `CommandBuffer` write lifecycle
- Iterator-based command chain construction
- `flattenBuffer` execution
- Output result shaping (`text`, `data`, `value`, `sink`)
- Async lifecycle hooks that finalize buffers

Does not cover historical implementations.

## End-to-End Flow

1. Compiler emits writes into `CommandBuffer` instances.
2. Writes are grouped by handler in `buffer.arrays[outputName]`.
3. Per-output `BufferIterator` builds a linked command chain (`next`) as slots are filled/finished.
4. `snapshot()` paths call `flattenBuffer(output)`.
5. `flattenBuffer` walks `output._firstChainedCommand -> next`, applies commands, aggregates errors, returns `output.getCurrentResult()`.

## Core Runtime Objects

## `CommandBuffer` (`src/runtime/command-buffer.js`)

Primary fields:

- `arrays`: per-handler arrays of entries (`Command`, child `CommandBuffer`, or `null` reserved slots)
- `parent`: parent `CommandBuffer` when attached as child
- `finished`: true when finish is requested and no reserved slots remain
- `_outputs`: shared `Map<handlerName, Output>` across a buffer tree
- `_visitingIterators`: active iterators keyed by output name
- `_pendingReservedSlots`: reserved-but-not-filled slot count
- `_finishRequested`: finish requested, completion deferred until pending slots are filled

Write APIs:

- `add(value, outputName)`: reserve slot + store value + notify iterator
- `_fillSlot(slot, value, outputName)`: fill an existing reserved slot + notify iterator
- `addAsyncArgsCommand(...)`: reserves a slot, awaits producer, fills with command or `ErrorCommand`
- `addText(...)`, `addPoison(...)`, `addBuffer(...)`

Child attach behavior (`value instanceof CommandBuffer`):

- child `parent` is set
- child `_outputs` is replaced with parent shared map
- no child-chained signaling; iterator traversal handles parent/child sequencing

Finish behavior:

- `markFinishedAndPatchLinks()` only requests finish
- actual `finished = true` occurs when `_pendingReservedSlots === 0`
- when finished, iterators currently visiting this buffer are notified via `onBufferFinished`

## Output objects (`src/runtime/output.js`)

Base fields:

- `_outputName`, `_outputType`
- `_frame`, `_context`
- `_buffer`
- `_firstChainedCommand`, `_lastChainedCommand`
- `_iterator` (`BufferIterator`)

Output registration:

- output constructors register with buffer (`_registerOutput`) when possible
- `declareOutput(...)` also registers and stores in lexical `frame._outputs`

Concrete output types:

- `TextOutput`: accumulates into `_target[]`; snapshot returns joined string
- `DataOutput`: uses `DataHandler` in `_base`; snapshot returns `getReturnValue()`
- `ValueOutput`: keeps last assigned value in `_target`
- `SinkOutputHandler`: applies `SinkCommand`s to `_sink`; snapshot uses `snapshot()`/`getReturnValue()`/`finalize()` fallback

## Output facade/proxy model

`createOutputFacade(...)` preserves script/template API shape:

- `text`/`value` are callable facades
- `data` is dynamic-command facade (`output.someMethod(...)`)
- internal runtime fields are forwarded through `OUTPUT_API_PROPS`

## Iterator-Based Chain Construction

## `BufferIterator` (`src/runtime/buffer-iterator.js`)

Each output owns one iterator. Iterator state:

- `output`
- `stack`: traversal stack of `{ buffer, index }`
- `_enteredBuffer`: current buffer used for enter/leave notifications

Traversal rules:

- advance only when `arr[nextIndex] != null`
- if slot is a command: link via `prev.next = cmd`, update output chain endpoints
- if slot is child buffer: push child and traverse it first
- when current buffer is finished and stack depth > 1: pop to parent and continue
- if no progress is possible: wait for `onSlotFilled` or `onBufferFinished`

No per-buffer chain progress fields are used anymore.

## Flatten Execution

## `flattenBuffer(output, errorContext?)` (`src/runtime/flatten-buffer.js`)

Validation:

- output must be object/function
- output must have `_buffer`
- `_buffer` must be a `CommandBuffer`

Execution:

- starts from `output._firstChainedCommand`
- walks `.next`
- calls `cmd.apply(output)`
- aggregates all errors
- unwraps `PoisonError` into underlying errors
- detects chain cycles with a `visited` set and records `RuntimeFatalError`

Result:

- throws `PoisonError` if any errors collected
- otherwise returns `output.getCurrentResult()`

Flatten does not tree-walk buffers.

## Compiler Interaction

## Buffer creation contract

`CommandBuffer` creation points:

- root function setup (`funcBegin` -> `createScopeRootBuffer(...)`)
- managed non-async scope-root blocks (`beginManagedBlock(..., createScopeRootBuffer=true)`)
- runtime async blocks (`AsyncState.asyncBlock(...)` when `usedOutputs` is non-empty)

Constraints:

- `pushBuffer/popBuffer` are compiler-side identifier stack operations only
- `declareOutput(...)` requires an active output buffer and throws if missing

## Async writes and slot reservation

Compiler async output writes call `addAsyncArgsCommand(...)`, which:

- reserves a slot before async producer execution
- fills the same slot on success
- fills the same slot with `ErrorCommand` on handled errors

This preserves deterministic slot order while allowing out-of-order promise completion.

## Nested async buffers

- compiler async blocks bind writes to `frame._outputBuffer`
- parent-child linking is emitted with `parent.addBuffer(child, outputName)` once used outputs are known
- `asyncBlockRender` async path also uses `frame._outputBuffer` (no extra scope-root buffer creation)

## Async lifecycle finalization

`AsyncState.asyncBlock(...)` finalizes owned block buffers in `.finally(...)`:

- if `childFrame._ownsOutputBuffer`, call `childFrame._outputBuffer.markFinishedAndPatchLinks()`
- runs on both success and failure
- enables iterator progression through child-buffer slots on error paths

`finalizeUnobservedSinks(frame, context)` (used by compiled return paths):

- scans lexical `frame._outputs` for sink outputs not yet finalized
- calls `out.snapshot()` in a best-effort `try/catch`
- intentionally ignores errors from unused sinks
- currently does not await promise-returning sink snapshots

## Output Declaration and Lookup

- `declareOutput(frame, outputName, outputType, context, initializer)`:
- finds nearest output buffer (`findOutputBuffer`)
- throws if no active output buffer exists
- creates output instance/facade
- stores in lexical `frame._outputs`
- registers in buffer `_outputs`
- stores sink handlers in `buffer._outputHandlers`

- `getOutputHandler(frame, name)` walks lexical `frame._outputs` chain.

## Guard/Clear Behavior

`clearBuffer(...)` calls `patchLinksAfterClear(...)` for `CommandBuffer`:

- clears selected handler arrays
- resets writable lifecycle state (`finished`, `_finishRequested`, `_pendingReservedSlots`)
- clears existing command `next` links for affected outputs
- resets output chain endpoints and rebinds iterators

## Invariants

- buffer entries are commands, child buffers, or reserved `null` slots
- chain endpoints consumed by flatten are owned by output objects
- chain construction is iterator-driven and event-driven (slot fill/finish), not performed by flatten
- child buffers are finalized by their own lifecycle hooks
- flatten is chain-walk only
- flatten error handling is aggregate (all reachable commands attempted, all errors collected)
