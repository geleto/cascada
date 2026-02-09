# Output Architecture

Status: current as of `output-refactor-2` branch.

This document describes the current output pipeline in Cascada, with focus on async command-buffer execution and where text materialization happens.

## Big Picture

Async output handling is command-based:

1. Compiler emits `CommandBuffer` writes.
2. Runtime stores entries per output name (`buffer.arrays[name]`).
3. `snapshot()` (or root/capture/call-block finalization) triggers flatten for a target output context.
4. Flatten replays commands via `apply(...)` and mutates output state (`_target`, `_base`).
5. Final value is shaped by output type (`text`, `data`, `value`, `sink`).

Key distinction:

- Output name: declared identifier (`data`, `text`, `auditSink`, etc.)
- Output type: runtime behavior (`data`, `text`, `value`, `sink`)

## Sync vs Async Models

### Sync template mode

- Root output is a string buffer (`let output = ""`).
- Compiler emits direct string concatenation (`output += ...`).
- `runtime.suppressValue(...)` runs on expression results before append.

### Async template mode

- Root output is `new runtime.CommandBuffer(context, null)`.
- Compiler emits command-buffer writes (typically `TextCommand` for text output).
- Root resolves with `runtime.flattenBuffer(output_textOutput, context)` after `astate.waitAllClosures()`.

### Script mode (async scripts)

- Uses command-buffer outputs declared by `runtime.declareOutput(...)`.
- Return values are explicit (`return data.snapshot()`, `return text.snapshot()`, etc.).
- Text output uses script-specific suppression (`suppressValueScript` / `normalizeScriptTextArgs`).

## Runtime Output Objects

File: `src/runtime/output.js`

### Output base

Fields:

- `_outputName`
- `_outputType`
- `_context`
- `_frame`
- `_buffer`

Behavior:

- `_enqueueCommand(...)` creates concrete command type by output type and appends to buffer.
- `snapshot()` calls `flattenBuffer(this)` when `_buffer` exists.

### TextOutput

- `_target` is an array of text fragments.
- `invoke(...args)` normalizes args with `normalizeScriptTextArgs(...)` and enqueues `TextCommand`.
- `getCurrentResult()` joins fragments and compacts to one element.

### ValueOutput

- `_target` stores last value command result (initialized to `undefined`).
- `_base` initialized to `null`.
- `getCurrentResult()` returns `_target`.

### DataOutput

- `_target` initialized to `{}`.
- `_base` is a `DataHandler` instantiated eagerly in the constructor (with context variables and env).
- Data commands call methods on `_base` directly (e.g., `_base.set(...)`, `_base.push(...)`).
- `getCurrentResult()` returns `_base.getReturnValue()` if available, otherwise `_base`.

### SinkOutputHandler

- Holds `_sink` and sink lifecycle flags (`_sinkFinalized`).
- `_resolveSink()` returns the sink (may be a promise from the initializer).
- `_snapshotFromSink(sink)` defines the finalization protocol: tries `sink.snapshot()` → `sink.getReturnValue()` → `sink.finalize()` → identity.
- `snapshot()` resolves sink (sync/async), flattens sink commands, marks finalized, then returns sink-shaped result via `_snapshotFromSink`.
- `getCurrentResult()` delegates to `_snapshotFromSink`.

### Output Facade (Proxy)

Outputs are not exposed directly to user code. `createOutputFacade(output, options)` wraps each Output instance in a `Proxy`:

- **Callable outputs** (text, value): proxy target is a function that calls `output.invoke(...)`. User code invokes the output directly, e.g., `text("hello")`.
- **Dynamic-command outputs** (data): proxy intercepts property access and returns `(...args) => output._enqueueCommand(prop, args)`. User code calls methods like `data.set(...)`, `data.push(...)`.

`OUTPUT_API_PROPS` whitelist (`_outputName`, `_outputType`, `_frame`, `_context`, `_target`, `_base`, `_buffer`) ensures get/set on these properties read/write through to the underlying Output instance — critical for flattener writes to be visible to `snapshot()`.

The proxy also intercepts `then` (returns `undefined` to prevent promise detection) and `snapshot`/`getCurrentResult` (bound to the Output instance).

### Factory functions

- `createOutput(frame, outputName, context, outputType)` — creates TextOutput, ValueOutput, or DataOutput wrapped in a facade proxy.
- `createSinkOutput(frame, outputName, context, sink)` — creates SinkOutputHandler (not proxied).

## Output declaration and lookup

- `findOutputBuffer(frame)` walks the frame parent chain looking for an existing `_outputBuffer`, stopping at `outputScope` boundaries.
- `declareOutput(frame, name, type, context, initializer)`:
  - ensures `frame._outputs`
  - finds/creates output buffer via `findOutputBuffer`
  - sets `buffer._outputTypes[name] = type`
  - stores output in `frame._outputs`
  - mirrors output into `buffer._outputs` when needed
  - for sinks also stores `buffer._outputHandlers[name]`
- `getOutputHandler(frame, name)` performs lexical parent lookup through `frame._outputs`. Also used by compiler-generated code in `compile-buffer.js` for output command routing.
- `finalizeUnobservedSinks(frame, context)` calls `snapshot()` on all non-finalized sink outputs, ignoring errors by design.

## CommandBuffer Semantics

File: `src/runtime/buffer.js`

- `arrays[name]` stores entries for a named output.
- Entries are `Command` instances, nested `CommandBuffer`s, or `ErrorCommand`s. No raw `PoisonedValue` objects in buffers.
- `addText(value, pos, outputName)` creates `TextCommand` explicitly.
- `reserveSlot` / `fillSlot` support async ordering.
- Nested buffers keep parent/position linkage for chain patching.

### Command chain (`buffer-snapshot.js`)

Commands are linked into a singly-linked list via the `next` field for snapshot/streaming traversal:

- `Command` base has `next`, `resolved`, `promise`, `resolve` fields.
- `linkToPrevious(prev, current, handlerName)` / `linkToNext(current, next, handlerName)` — called during `add`/`fillSlot` to maintain the chain.
- `markFinishedAndPatchLinks()` — called when a nested buffer completes; links its commands into the parent chain.
- `patchLinksAfterClear(buffer)` — updates chain links when a buffer is cleared (guard recovery).
- `firstCommand(handlerName)` / `lastCommand(handlerName)` — traverse buffer arrays (recursing into nested buffers) to find chain endpoints.
- `traverseChain(handlerName, fn)` — walks the linked list from first command.

### Buffer utilities

- `clearBuffer(buffer, handlerNames)` — clears buffer contents for guard error recovery. Resets arrays and output indexes, patches chain links.
- `getPosonedBufferErrors(buffer, allowedHandlers)` — pre-flatten error scan. Walks buffer arrays recursively, calling `getError()` on each command to collect errors without executing.

## Command Classes

File: `src/runtime/commands.js`

- `Command` base
- `OutputCommand` base
- `TextCommand`
- `ValueCommand`
- `DataCommand`
- `SinkCommand`
- `ErrorCommand`

### Error handling: `getError()` and `apply()`

Every command has two error-related methods:

- `getError()` — returns a `PoisonError` if the command carries poison, or `null`. Used for pre-flatten error detection (guards, buffer walkers) without executing the command.
- `apply(ctx)` — executes the command, throwing on any error (poison or runtime).

Contracts per class:

- `Command.getError()` → `null`. `Command.apply()` → throws "must be overridden".
- `OutputCommand.getError()` → scans `this.arguments` for poison via `isPoison()`, combines all `.errors` into one `PoisonError`, or returns `null`.
- `OutputCommand.apply(ctx)` → calls `this.getError()`, throws if non-null. Subclasses call `super.apply(ctx)` first, then their own logic (which may also throw for non-poison reasons).
- `ErrorCommand(errors)` → constructor accepts an error or array of errors directly (no `PoisonedValue` wrapper). `getError()` always returns `PoisonError`. `apply()` always throws.

### `TextCommand` contract

`TextCommand.apply(ctx)` is strict (after the `super.apply()` poison check):

- accepts text-like scalar arguments (`string`, `number`, `boolean`, `bigint`)
- accepts objects only when they provide custom `toString`
- rejects arrays/plain objects/unsupported types with position-aware error

This is the authoritative text-command validation path.

## Flatten Pipeline

File: `src/runtime/flatten-buffer.js`

Entrypoint:

- `flattenBuffer(output, errorContext?)`

Flow:

1. Validate output and `_buffer` (`CommandBuffer` required).
2. Flatten the target output's array (`buffer.arrays[output._outputName]`) via `flattenCommandBuffer(...)`.
3. For each entry (`flattenCommand`):
   - if `Command`: call `entry.apply(output)` inside `try/catch`. Errors (including `PoisonError` from poison args or `ErrorCommand`) are collected. `PoisonError` is unwrapped into individual errors.
   - if `CommandBuffer`: recurse via `flattenCommandBuffer`.
4. If any errors collected: throw `PoisonError(errors)`.
5. Return `output.getCurrentResult()`.

The flattener is type-agnostic — it does not inspect command types or pre-scan arguments. All error detection is delegated to `apply()` (which internally uses `getError()` for poison checks).

## Safe Output and Text Materialization

File: `src/runtime/safe-output.js`

### Core suppressors

- `suppressValue(val, autoescape)` (sync)
- `suppressValueAsync(val, autoescape, errorContext)` (async template expression path)
- `suppressValueScript(...)` and async variant (script text behavior)

### Defined-value validators

- `ensureDefined(val, lineno, colno, context)` (sync) — throws if val is null/undefined.
- `ensureDefinedAsync(val, lineno, colno, context, errorContext)` (async) — poison-aware, delegates complex cases to `_ensureDefinedAsyncComplex`.

### Normalization

`normalizeBufferValue(...)` unwraps envelope-like values:

- `{ text: [...] }` -> `text` array
- `{ output: [...] }` -> `output` array
- `CommandBuffer` passthrough

### CommandBuffer-to-text conversion

Current utilities:

- `flattenTextCommandBuffer(buffer, errorContext)`:
  - builds temporary text output facade (`_target` array + `getCurrentResult`)
  - calls `flattenBuffer(...)` to get concrete text

- `materializeTemplateTextValue(val, context, astate, waitCount = 1)`:
  - boundary helper for template composition values
  - if value is `CommandBuffer`, optionally waits `astate.waitAllClosures(waitCount)`, then flattens to text
  - normalizes envelope-like values before CommandBuffer detection

Compiler currently uses this in async `super()` path before `markSafe`.

### Script text suppression behavior

`suppressValueScript` intentionally:

- suppresses plain objects to empty text by default
- supports envelope objects with `text` or `output` fields
- preserves custom `toString` objects

## Compiler Emission Overview

Files:

- `src/compiler/compile-emit.js` — async block helpers, root setup, scope management
- `src/compiler/compile-buffer.js` — output command compilation, `reserveSlot`/`fillSlot` patterns, async-to-buffer emission for output commands
- `src/compiler/compiler.js` — statement compilation (if, for, capture, return, output declarations)
- `src/compiler/compile-inheritance.js` — template inheritance (extends, super, include)

### Root setup

- Sync root: string buffer.
- Async root: command buffer + default `text` output declaration.

### Text output emission

- Template text expressions compile through `suppressValue`/`suppressValueAsync` and are emitted as `TextCommand` writes in async mode.
- Sync mode appends directly to string buffer.

### Return handling

- Async `compileReturn` waits closures, resolves return value (via `resolveSingle`), checks poison, finalizes unobserved sinks, then returns/callbacks.
- Sync `compileReturn` emits direct callback return.
- `finalizeUnobservedSinks(...)` intentionally ignores errors for sinks that were never observed.

### Capture/Call Blocks

- Async `compileCapture` creates a temporary command buffer/output scope, waits `astate.waitAllClosures(1)`, then flattens that temporary text output.
- `compile-emit.asyncBlockRender` uses the same pattern for template call-block rendering in async mode (`waitAllClosures(1)` + `flattenBuffer` on temporary text output).

### Output command compilation (`compile-buffer.js`)

- Sync output commands emit direct buffer writes.
- Async output commands use `reserveSlot`/`fillSlot` with error wrapping: catch blocks create `ErrorCommand(processedErrors)` and fill the slot, maintaining the buffer invariant.
- When the target output is declared on a different frame, compiler emits `runtime.getOutputHandler(frame, name)` to locate the output and its buffer at runtime.

### Inheritance-specific note (`super()`)

Async `compileSuper` path currently:

1. gets super block result via `context.getSuper(...)`
2. materializes command-buffer text via `runtime.materializeTemplateTextValue(...)`
3. applies `runtime.markSafe(...)`

This ensures composed super text is concrete before suppression/append.

## Error and Poison

- Poison markers are inserted via `addPoisonMarkersToBuffer(...)` as `ErrorCommand(errors)` entries (no `PoisonedValue` wrapper).
- Async `reserveSlot`/`fillSlot` catch blocks also wrap errors in `ErrorCommand` before filling the slot.
- Buffer invariant: no raw `PoisonedValue` ever sits in a buffer array.
- Flatten collects all errors via `apply()` + `try/catch` and throws one `PoisonError` with aggregated errors.
- Policy remains: never miss any error during flatten of observed outputs.

## Invariants

1. `_outputHandlers` is sink-focused runtime map.
2. `_outputs` is the lexical output registry used by lookup/finalization paths (not the direct flatten mutation target).
3. Output name and output type are distinct concepts.
4. Text command validity is enforced in `TextCommand.apply(...)`.
5. All buffer entries are `Command` instances or nested `CommandBuffer`s — no raw `PoisonedValue` in buffers.
6. Error detection is polymorphic via `getError()`; error execution is polymorphic via `apply()` throwing.
7. Flatten is replay/error-collection; final shaping is in output objects (`getCurrentResult` / sink snapshot semantics).
8. Sync template path remains string-based; async template path remains command-buffer based.
9. Output facades (proxies) ensure flattener mutations on `_target`/`_base` propagate to the Output instance visible to `snapshot()`.

## Transitional Notes

- `suppressValueAsync` still has a compatibility fallback for direct `CommandBuffer` input; preferred long-term direction is boundary materialization (`materializeTemplateTextValue`) in compiler/runtime call boundaries.
- Some composition paths still rely on evolving boundary conventions; keep tests around inheritance/caller/capture paths as guardrails.
- `src/script/value-handler.js` exists but is currently unused — `ValueOutput` handles values directly via `_target`. Candidate for removal.
