# Output Architecture

Status: current for this branch.

This document describes how outputs are represented and resolved in Cascada today, with emphasis on async mode and command-buffer flattening.

## Big Picture

Output handling in async mode is command-based:

1. Compiler emits `CommandBuffer` writes.
2. Runtime stores commands per output name.
3. `snapshot()` triggers flatten for that output context.
4. Flatten replays commands (`apply`) and populates output state.
5. `snapshot()` resolves final value.

Key distinction:

- Output names: user-declared identifiers (`myData`, `resultText`, `auditSink`).
- Output types: handler kinds (`data`, `text`, `value`, `sink`).

## Script vs Template Output Models

## Script mode

- Uses `CommandBuffer` as root output container.
- Outputs are declared explicitly and stored in `frame._outputs`.
- Commands are appended under named handler arrays (`buffer.arrays[name]`).
- Return values are explicit (`return data.snapshot()`, `return text.snapshot()`, etc.).

## Template mode

- Sync template path remains legacy string/flat-buffer based.
- Async template path uses `CommandBuffer` and emits command entries (mostly `TextCommand` currently).
- Compiler locals like `output`/`buf` are runtime buffer variables, not user output names.
- Root template rendering resolves to text.

## Runtime Output Objects

File: `src/runtime/output.js`

## `Output` base

Fields:

- `_outputName`
- `_outputType`
- `_context`
- `_frame`
- `_buffer`

Key behavior:

- `_enqueueCommand(command, args)` creates concrete command instances by output type (`TextCommand`, `ValueCommand`, `DataCommand`, `SinkCommand`) and appends to `_buffer`.
- `snapshot()` calls `flattenBuffer(this)` when `_buffer` exists, then resolves via `_resolveSnapshotValue(...)`.

## `TextOutput`

- `_target` is initialized as `[]`.
- `invoke(...args)` normalizes text args (`normalizeScriptTextArgs`) and enqueues a text command.
- Snapshot result is joined text when `_target` is array-backed.

## `ValueOutput`

- `_target` starts as `undefined`.
- `_base` starts as `null`.
- `invoke(value)` enqueues value command.

## `DataOutput`

- `_target` starts as `{}`.
- `_base` starts as `null`.
- Facade supports dynamic command calls (`myData.set(...)`, `myData.push(...)`, etc.) that enqueue `DataCommand`.

## `SinkOutputHandler`

- Standalone class for `sink` outputs.
- Holds `_sink`, `_buffer`, `_context`, `_sinkFinalized`.
- `snapshot()` resolves sink, flattens sink output buffer, marks finalized, then returns one of:
  - `sink.snapshot()`
  - `sink.getReturnValue()`
  - `sink.finalize()`
  - sink itself.

## Output Facades (Callable + Proxy)

File: `src/runtime/output.js`

`createOutputFacade(...)` wraps output instances so user-facing syntax maps to command enqueueing while preserving internal state access.

- Callable facade for `text` and `value`.
- Dynamic command facade for `data`.
- Internal properties (`_target`, `_base`, `_buffer`, etc.) are read/write-through to backing `Output`.
- `then` is forced to `undefined` to avoid accidental thenable behavior.

## Declaration, Scope, and Maps

File: `src/runtime/output.js`

`declareOutput(frame, name, type, context, initializer)`:

- ensures `frame._outputs`
- finds/creates output buffer (`findOutputBuffer` -> fallback `new CommandBuffer(...)`)
- sets `buffer._outputs` reference and `buffer._outputTypes[name]`
- creates output object and stores it in `frame._outputs[name]`
- for sinks: also stores in `buffer._outputHandlers[name]`

Scope lookup:

- `getOutputHandler(frame, name)` walks lexical parent chain (`frame.parent`).

Map roles:

- `buffer._outputs`: output contexts used for `_target`/`_base` mutation.
- `buffer._outputHandlers`: sink handler lookup (sink-only path).

## CommandBuffer Semantics

File: `src/runtime/buffer.js`

- `CommandBuffer.arrays[name]` stores entries for that output.
- `add(value, outputName)` wraps values and stores with chain linkage.
- Non-command primitives become `TextCommand` via `_wrapCommand`.
- Plain object pseudo-commands are rejected (`Plain command objects are not allowed; emit Command instances`).
- Nested `CommandBuffer` gets parent/position linkage.

Default output name behavior:

- Buffer storage defaults to `'output'` when no name is provided.
- Compiler/runtime paths generally pass explicit names for output handlers.

## Command Classes and `apply(...)`

File: `src/runtime/commands.js`

- `Command` (abstract)
- `OutputCommand` (base for output-targeted commands)
- `TextCommand.apply(ctx)` appends args into `ctx._target`
- `ValueCommand.apply(ctx)` sets `ctx._target` to last arg (or `undefined`)
- `DataCommand.apply(ctx)` invokes `ctx._base[command](...args)`
- `SinkCommand.apply(ctx)` invokes sink method on `ctx._sink`
- `ErrorCommand.apply(ctx)` sets `ctx._target` to poison payload

## Flatten Pipeline

Files:

- `src/runtime/flatten-buffer.js`
- `src/runtime/flatten-commands.js`
- `src/runtime/flatten-text.js`

## Entrypoints

- `flattenBuffer(output, errorContext?)`
  - output-driven flatten; validates output + buffer.
- `flattenBufferText(arr, outputName?, sharedState?)`
  - template text flatten entry (thin wrapper over `doFlattenBuffer(...)`).

Dispatcher (`doFlattenBuffer`) routes by input kind:

- `CommandBuffer` -> `flattenCommandBuffer`
- no context -> `flattenText`
- array + context -> `flattenCommands`

## `flattenCommandBuffer`

Current behavior:

- builds/uses shared flatten state
- pulls state maps from buffer (`_outputHandlers`, `_outputs`)
- flattens one output array at a time
- collects errors and throws `PoisonError` when finalizing non-shared state
- resolves final value with `resolveOutputValue(...)`

Note:

- Current default target when `outputName` is omitted is `'text'` in `flatten-commands.js`.

## `flattenCommands`

Handles:

- `ErrorCommand`
- `OutputCommand` subclasses
- poison values
- nested `CommandBuffer`
- legacy raw array/object/primitive entries for compatibility non-`CommandBuffer` callers

Important policy points:

- target kind resolution uses declared output type (`text/value/data/sink`)
- data handler (`DataHandler`) can be lazily instantiated and bound to output `_base`
- sink dispatch requires resolved sink (`_sink` must not be promise at dispatch time)
- command dispatch failures are wrapped with `handleError(...)` and collected
- strict command-stream validation is source-based: arrays from `CommandBuffer` are treated as command streams and reject raw entries

## Error and Poison

Files:

- `src/runtime/buffer.js`
- `src/runtime/flatten-commands.js`

Poison markers:

- `addPoisonMarkersToBuffer(...)` inserts `ErrorCommand(new PoisonedValue(...))` into selected handler arrays.

Collection:

- flatten collects errors from `ErrorCommand`, poison entries, and handled dispatch errors.

Guard scanning:

- `getPosonedBufferErrors(...)` recursively inspects command-buffer structures for poisoned entries.

## snapshot() Resolution

File: `src/runtime/output.js`

For `Output`-based outputs (`text`, `data`, `value`):

1. flatten output buffer via `flattenBuffer(this)`
2. resolve with `_resolveSnapshotValue(result)`:
   - `text`: join `_target` when array-backed, else return flatten result
   - non-text: return `_base.getReturnValue()` when present, else `_base`, else `_target`, else flatten result

For sink outputs:

- `SinkOutputHandler.snapshot()` owns sink-specific finalization and return shaping.

## finalizeUnobservedSinks

File: `src/runtime/output.js`

`finalizeUnobservedSinks(frame, context)`:

- walks `frame._outputs`
- for each non-finalized sink output, calls `snapshot()`
- ignores thrown errors for unobserved sinks by design

Used by async return paths in compiler to finalize side-effect sinks before completing return.

## Compiler Emission Flow

Files:

- `src/compiler/compile-emit.js`
- `src/compiler/compile-buffer.js`
- `src/compiler/compiler.js`

Root setup (`funcBegin`, async):

- emits `let output = new runtime.CommandBuffer(context, null);`
- sets `frame._outputBuffer = output`
- declares default text output via `runtime.declareOutput(frame, "text", "text", context, null)`

Script output declarations:

- `compileOutputDeclaration` emits `runtime.declareOutput(...)`

Output commands:

- `compileOutputCommand` emits concrete command constructors (`DataCommand`, `SinkCommand`, `TextCommand`, `ValueCommand`)
- writes command into current buffer via `add` or slot (`reserveSlot` + `fillSlot`) in async blocks

Async template text emission:

- template output paths emit `TextCommand` for command-buffer writes

Return handling:

- async `compileReturn` waits closures, resolves return value, checks poison, finalizes unobserved sinks, then returns/callbacks

## Buffer Allocation Checklist

Create new `CommandBuffer` for:

- async root render function
- async nested buffer scopes (`asyncBufferNodeBegin`)
- async capture/call-render style isolated output scopes

Use current buffer writes (`add`/slot fill) for:

- single expression output writes
- emitted output commands
- async template text fragments

Keep sync template path unchanged.

## Invariants and Gotchas

1. `_outputHandlers` should be sink-only.
2. `_outputs` is the authoritative output context map for flatten-time `_target/_base` mutation.
3. Types (`data/text/value/sink`) are not output names.
4. Sink dispatch expects resolved `_sink` at apply time.
5. Output value shaping belongs in `snapshot()`; flatten should focus on replay + error collection.
6. `CommandBuffer` entries should be command instances (or nested command buffers), not ad hoc command objects.
7. Legacy non-command array/object handling still exists for compatibility paths; strict command-buffer streams reject raw entries.
8. Async template command-path migration is ongoing; sync templates remain legacy by design.
