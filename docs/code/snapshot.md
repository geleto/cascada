# Snapshot and Chain Construction Architecture

This document defines the runtime architecture for output snapshots based on incremental command-chain construction.

## Purpose

`snapshot()` materializes an output by replaying a prebuilt command chain.

The architecture is designed around:

- incremental chaining during execution
- deterministic ordering through reserved slots
- parent/child buffer coordination
- chain-only flatten traversal

## Core Concepts

## Output-specific command chain

Each output handler (for example `text`, `data`, `value`, custom sink names) has an independent logical chain of commands linked via `Command.next`.

Flatten starts at the output head:

- `output._firstChainedCommand`

and traverses:

- `cmd = cmd.next`

until null.

## Buffer tree vs command chain

- Buffer tree (`CommandBuffer` nesting) is the execution-time storage graph.
- Command chain is the flatten-time replay graph.

Buffers are structural containers. Flatten does not recurse buffers; it walks the already-linked chain.

## Data Structures

## `CommandBuffer` state

Per buffer:

- `arrays[handler]`: sparse ordered entries (`Command` or child `CommandBuffer`)
- `_outputIndexes[handler]`: next slot index for `reserveSlot`
- `finished`: buffer lifecycle completion marker
- `parent`: parent buffer if attached
- `positions`: parent slot index mapping by handler

Shared registry across buffer hierarchy:

- `_outputs: Map<handler, Output>`

Per-handler chain progress state:

- `_lastChainedIndex: Map<handler, number>`
- `_lastIndexIsChained: Map<handler, boolean>`
- `_firstLocalChainedCommand: Map<handler, Command>`
- `_lastLocalChainedCommand: Map<handler, Command>`

## `Output` chain endpoints

Per output:

- `_firstChainedCommand`
- `_lastChainedCommand`

For root buffers, local endpoints are mirrored to these global endpoints while chaining.

## Incremental Chain Algorithm

## Write path entry points

- `add(value, outputName)`
- `fillSlot(slot, value, outputName)`

Both:

1. Store entry into `arrays[outputName]`
2. Attach child linkage when value is `CommandBuffer`
3. Call `_tryAdvanceChain(outputName, position)`

## Position gating (`_tryAdvanceChain`)

Given:

- `lastIdx = _lastChainedIndex.get(handler) ?? -1`
- `lastReady = _lastIndexIsChained.get(handler) ?? true`

Expected position:

- `lastReady ? lastIdx + 1 : lastIdx`

Advancement starts only when the newly written position matches expected.

This prevents out-of-order chain mutation and enables gap resume.

## Forward advancement (`_advanceChainFrom`)

For `arrays[handler]` starting at `fromIndex`:

1. Redundant full re-advances are ignored if buffer is already contiguous through `lastIdx`.
2. Iterate entries until stop condition.

Entry handling:

- `null`/gap:
- mark blocked at current index
- `lastIndexIsChained = false`
- stop

- `Command`:
- link into chain using `_chainCommand`/`_chainRange`
- continue

- child `CommandBuffer`:
- if child not fully chained for handler, mark blocked here and stop
- if fully chained, splice child command segment `[firstCommand, lastCommand]` into parent chain and continue

After reaching array end:

- mark contiguous complete at last index
- set `lastIndexIsChained = true`
- call `_checkFullyChained(handler)`

## Link primitive (`_chainRange`)

`_chainRange(firstCmd, lastCmd, prev, handler)`:

- if `prev` exists: `prev.next = firstCmd`
- else: set local first endpoint for handler
- update local last endpoint
- if this is root buffer (`!parent`), mirror to `Output` endpoints

Returns `lastCmd` as new `prev`.

## Child buffer coordination

## Attachment

When a child buffer is inserted into parent slot:

- `child.parent = parent`
- `child._setParentPosition(handler, slot)`
- `child._outputs = parent._outputs` (shared registry)
- `child._advanceChainFrom(handler, 0)` to process pre-attachment writes

## Completion signaling

- child calls `_notifyParentChained(handler)` when fully chained
- parent receives `_childBufferChained(handler, position)`
- parent resumes advancement only if notification matches expected position

## Fully chained semantics

`_isFullyChained(handler)` is true when:

- `finished === true`
- and either:
- no array exists for handler
- or array exists and `lastIdx` is final index and `lastIndexIsChained === true`

`_checkFullyChained(handler)` enforces same logic and notifies parent.

## Buffer lifecycle finalization

`markFinishedAndPatchLinks()`:

- sets `finished = true`
- checks all handlers known in `_outputs` with `_checkFullyChained`
- does not recursively finish child buffers

Async lifecycle integration:

- `AsyncState.asyncBlock(...)` calls `childFrame._outputBuffer.markFinishedAndPatchLinks()` in `.finally(...)`
- this runs on both success and failure and is the primary completion trigger for child buffers

## Flatten contract

`flattenBuffer(output, errorContext?)`:

1. validates output object and `CommandBuffer`
2. walks chain from `output._firstChainedCommand`
3. applies every command, aggregating all errors
4. detects and reports chain cycles
5. returns `output.getCurrentResult()` or throws aggregated `PoisonError`

Important: flatten does not build or rebuild chains from buffer arrays.

## Snapshot contract

`Output.snapshot()` delegates to `flattenBuffer(this)` when `_buffer` exists.

Per output type:

- text: returns joined string from `_target`
- value: returns `_target`
- data: returns `DataHandler.getReturnValue()` (or base object)
- sink: flattens sink commands, then returns sink-derived value (`snapshot`/`getReturnValue`/`finalize`)

## Ordering guarantees

Ordering is driven by slot reservation plus chain gating:

- async producers reserve exact output positions (`reserveSlot`)
- completion fills reserved slots (`fillSlot`)
- chain advances only when next expected position is ready

This preserves deterministic replay order even when async tasks resolve out of order.

## Error model in snapshot/flatten

- Command execution errors are collected, not fail-fast
- `PoisonError` is unwrapped to individual errors and merged
- non-poison errors are included as-is
- after traversal, if any errors exist, flatten throws `PoisonError(errors)`

## Operational invariants

- Every filled command slot is either linked into chain or blocks chain progression until ready conditions are met.
- Parent buffers advance through child-buffer slots only after child is fully chained.
- Root output endpoints always represent the visible replay chain for that handler.
- Snapshot materialization depends on chain correctness, not tree recursion.
- Buffer completion and chain completion are separate states; both are required for full-chained status.

## Debug helpers and non-flatten utilities

Runtime includes helper methods useful for diagnostics and compatibility paths:

- `firstCommand(handler)` / `lastCommand(handler)`
- `debugChain(handler)`
- `traverseChain(handler, fn)`

These do not change the flatten contract: snapshot flatten traversal is chain-only.
