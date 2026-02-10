# Output Architecture

This document describes the output pipeline as implemented in the current runtime/compiler code.

## Scope

Covers:

- Output declaration and lookup
- CommandBuffer write model
- Incremental command-chain construction
- Chain-walk flatten execution
- Output-type result shaping (`text`, `data`, `value`, `sink`)
- Async lifecycle hooks that finalize buffers

Does not cover historical transitions or deprecated behavior.

## End-to-End Flow

1. Compiler emits writes into `CommandBuffer` instances.
2. Writes are grouped by handler/output name in `buffer.arrays[outputName]`.
3. `CommandBuffer` incrementally links commands into a per-output singly linked chain (`next` pointers).
4. `Output.snapshot()` (or template/capture/call-block flatten paths) calls `flattenBuffer(output)`.
5. `flattenBuffer` walks only `output._firstChainedCommand -> next`, applies commands, aggregates errors, returns `output.getCurrentResult()`.

## Core Runtime Objects

## `CommandBuffer` (`src/runtime/buffer.js`)

Primary fields:

- `arrays`: sparse per-handler arrays of entries (`Command` or child `CommandBuffer`)
- `_outputIndexes`: next slot index per handler (`reserveSlot`)
- `parent`: parent `CommandBuffer` when attached as child
- `positions`: map of child position in parent per handler
- `finished`: marks this buffer's write lifecycle completion
- `_outputs`: shared `Map<handlerName, Output>` registry across a buffer tree
- `_lastChainedIndex`: per handler chain progress cursor
- `_lastIndexIsChained`: per handler readiness at cursor
- `_firstLocalChainedCommand` / `_lastLocalChainedCommand`: local segment endpoints for this buffer

Entry writes:

- `add(value, outputName)`
- `fillSlot(slot, value, outputName)`
- `addText(...)` convenience for `TextCommand`
- `addPoison(...)` convenience for `ErrorCommand`

Both `add` and `fillSlot` call `_tryAdvanceChain(outputName, position)` after storing the entry.

Child attach behavior (`value instanceof CommandBuffer`):

- child `parent` is set
- child parent position is stored with `_setParentPosition(outputName, slot)`
- child `_outputs` is replaced with parent's shared `_outputs`
- child `_advanceChainFrom(outputName, 0)` is invoked to pick up pre-attachment writes

## Output objects (`src/runtime/output.js`)

Base fields:

- `_outputName`, `_outputType`
- `_frame`, `_context`
- `_buffer` (source `CommandBuffer`)
- `_firstChainedCommand`, `_lastChainedCommand` (global chain endpoints used by flatten)

Concrete output types:

- `TextOutput`: `_target` array; joins fragments in `getCurrentResult()`
- `DataOutput`: `_base` is `DataHandler`; `getCurrentResult()` returns handler return value
- `ValueOutput`: `_target` scalar-like last value
- `SinkOutputHandler`: executes sink commands against `_sink`; snapshot protocol uses `snapshot()` -> `getReturnValue()` -> `finalize()` fallback order

Output registration:

- Output constructor registers itself in `buffer._outputs`
- For root buffers, constructor also binds already-built local chain endpoints to output endpoints (late binding support)
- `declareOutput(...)` also registers in `buffer._outputs`

## Output facade/proxy model

`createOutputFacade(...)` wraps outputs to preserve script/template API shape:

- text/value are callable facades
- data is dynamic-command facade (`output.someMethod(...)` -> command enqueue)
- reads/writes for internal runtime fields are forwarded via `OUTPUT_API_PROPS`

## Command model (`src/runtime/commands.js`)

Flatten depends on polymorphic command behavior:

- `cmd.apply(output)` performs runtime mutation and may throw
- `ErrorCommand.apply(...)` throws stored errors
- output commands (text/data/value/sink) mutate the output-specific accumulator state

## Incremental Chain Construction

## Progress model

Per handler, each buffer tracks:

- `_lastChainedIndex` (default `-1`)
- `_lastIndexIsChained` (default `true`)

Interpretation:

- if `_lastIndexIsChained === true`, next writable position to advance is `lastIdx + 1`
- if `_lastIndexIsChained === false`, buffer is waiting for the current blocked position `lastIdx`

`_tryAdvanceChain(handler, position)` enforces this expected-position rule.

## `_advanceChainFrom(handler, fromIndex)`

Algorithm:

1. Ignore redundant full re-advances when already contiguous (`fromIndex <= lastIdx` and last is chained).
2. Iterate forward through `arrays[handler]`.
3. On `null` gap:
- record blocked state (`lastIdx = gapIndex`, `lastIndexIsChained = false`)
- stop
4. On `Command`:
- chain via `_chainCommand` (actually `_chainRange(cmd, cmd, prev, handler)`)
- continue
5. On child `CommandBuffer`:
- if child is not fully chained for handler, record blocked state at this index and stop
- if child is fully chained, splice child's `[firstCommand, lastCommand]` into parent chain and continue
6. If end reached:
- mark contiguous complete (`lastIdx = end`, `lastIndexIsChained = true`)
- call `_checkFullyChained(handler)`

## Parent/child completion signaling

- Child calls `_notifyParentChained(handler)` when fully chained
- Parent receives `_childBufferChained(handler, position)` and attempts to resume from that position if it matches expected progression

## Buffer completion

`markFinishedAndPatchLinks()`:

- sets `finished = true`
- runs `_checkFullyChained(handler)` for each handler known in `_outputs`
- does not recursively finish children
- does not perform legacy cross-boundary pointer patching

`_checkFullyChained(handler)`:

- if handler array does not exist:
- fully chained only when `finished === true`, then notify parent
- if array exists:
- fully chained when `finished` and `lastIdx === arr.length - 1` and `lastIndexIsChained === true`, then notify parent

`_isFullyChained(handler)` uses the same condition for child readiness checks.

## Flatten Execution

## `flattenBuffer(output, errorContext?)` (`src/runtime/flatten-buffer.js`)

Validation:

- output must be object/function
- output must carry `_buffer`
- `_buffer` must be `CommandBuffer`

Execution:

- starts at `output._firstChainedCommand`
- follows `.next` pointers only
- calls `cmd.apply(output)` for each command
- aggregates all thrown errors
- unwraps `PoisonError` into constituent errors
- detects linked-list cycles via `visited` set and records `RuntimeFatalError`

Result:

- throws `PoisonError` if any errors were collected
- otherwise returns `output.getCurrentResult()`

There is no tree-walk command extraction in flatten path.

## Compiler Interaction

## Root and nested buffers

- Async function roots initialize `new runtime.CommandBuffer(context, null)`
- `initOutputHandlers(...)` declares default text output
- Async function end calls `currentBuffer.markFinishedAndPatchLinks()` before returning buffer

## Async writes

`compile-buffer.js` emits `reserveSlot` before async blocks and uses `fillSlot` in both success and catch paths. This preserves positional ordering and guarantees each reserved slot is eventually materialized with either a command or an `ErrorCommand`.

## Nested async buffer nodes

Nested async blocks create detached child buffers (`new CommandBuffer(context, null)`), then parent attaches them with `parent.add(child, outputName)` once used outputs are known. Attachment is where parent/position/output-registry linkage is established.

## Async Lifecycle Finalization

`AsyncState.asyncBlock(...)` (`src/runtime/async-state.js`) finalizes block buffers in `.finally(...)`:

- `childFrame._outputBuffer.markFinishedAndPatchLinks()` executes on both success and failure
- this allows parent chain progression through child-buffer slots even on error paths

## Output Declaration and Lookup

- `declareOutput(frame, outputName, outputType, context, initializer)`:
- finds nearest output buffer (`findOutputBuffer`)
- creates one if needed
- creates output object/facade
- registers in lexical `frame._outputs`
- registers in buffer `_outputs` map
- stores sink handlers in `_outputHandlers` for sink-specific lifecycle

- `getOutputHandler(frame, name)` is lexical lookup over `frame._outputs` chain.

## Guard/Clear Behavior

`clearBuffer(...)`:

- clears handler arrays and resets indexes
- resets per-handler chain progress and local endpoints
- invokes `patchLinksAfterClear(buffer)` to repair links around cleared segments

## Invariants

- Buffer entries are commands or child command buffers; poison payloads are represented as `ErrorCommand` entries.
- Chain endpoints consumed by flatten are owned by `Output` (`_firstChainedCommand`, `_lastChainedCommand`).
- Chain construction occurs at write/attach/finish time, not during flatten.
- Child buffers are finalized by their own async lifecycle.
- Flatten is chain-walk only and applies commands against output accumulators.
- Error handling during flatten is aggregate: all reachable commands are attempted, all errors are collected.
