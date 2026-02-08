# Output Architecture

Status: current as of this branch state.

This document describes the current output pipeline in Cascada, with focus on async command-buffer execution and where text materialization happens.

## Big Picture

Async output handling is command-based:

1. Compiler emits `CommandBuffer` writes.
2. Runtime stores entries per output name (`buffer.arrays[name]`).
3. `snapshot()` (or root/capture/call-block finalization) triggers flatten for a target output context.
4. Flatten replays commands via `apply(...)` and mutates output state (`_target`, `_base`, `_sink`).
5. Final value is shaped by output type (`text`, `data`, `value`, `sink`).

Key distinction:

- Output name: declared identifier (`data`, `text`, `auditSink`, etc.)
- Output type: runtime behavior (`data`, `text`, `value`, `sink`)

## Sync vs Async Models

## Sync template mode

- Root output is a string buffer (`let output = ""`).
- Compiler emits direct string concatenation (`output += ...`).
- `runtime.suppressValue(...)` runs on expression results before append.

## Async template mode

- Root output is `new runtime.CommandBuffer(context, null)`.
- Compiler emits command-buffer writes (typically `TextCommand` for text output).
- Root resolves with `runtime.flattenBuffer(output_textOutput, context)` after `astate.waitAllClosures()`.

## Script mode (async scripts)

- Uses command-buffer outputs declared by `runtime.declareOutput(...)`.
- Return values are explicit (`return data.snapshot()`, `return text.snapshot()`, etc.).
- Text output uses script-specific suppression (`suppressValueScript` / `normalizeScriptTextArgs`).

## Runtime Output Objects

File: `src/runtime/output.js`

## Output base

Fields:

- `_outputName`
- `_outputType`
- `_context`
- `_frame`
- `_buffer`

Behavior:

- `_enqueueCommand(...)` creates concrete command type by output type and appends to buffer.
- `snapshot()` calls `flattenBuffer(this)` when `_buffer` exists.

## TextOutput

- `_target` is an array of text fragments.
- `invoke(...args)` normalizes args with `normalizeScriptTextArgs(...)` and enqueues `TextCommand`.
- `getCurrentResult()` joins fragments and compacts to one element.

## ValueOutput

- `_target` stores last value command result.

## DataOutput

- `_base` is `DataHandler`; data commands mutate `_base`.

## SinkOutputHandler

- Holds `_sink` and sink lifecycle flags.
- `snapshot()` resolves sink (sync/async), flattens sink commands, marks finalized, then returns sink-shaped result.

## Output declaration and lookup

- `declareOutput(frame, name, type, context, initializer)`:
  - ensures `frame._outputs`
  - finds/creates output buffer
  - sets `buffer._outputTypes[name] = type`
  - stores output in `frame._outputs`
  - mirrors output into `buffer._outputs` when needed
  - for sinks also stores `buffer._outputHandlers[name]`
- `getOutputHandler(frame, name)` performs lexical parent lookup.

## CommandBuffer Semantics

File: `src/runtime/buffer.js`

- `arrays[name]` stores entries for a named output.
- Entries can be command instances, nested `CommandBuffer`, poison markers, or reserved-slot fills.
- `addText(value, pos, outputName)` creates `TextCommand` explicitly.
- `reserveSlot` / `fillSlot` support async ordering.
- Nested buffers keep parent/position linkage for chain patching.

## Command Classes

File: `src/runtime/commands.js`

- `Command` base
- `OutputCommand` base
- `TextCommand`
- `ValueCommand`
- `DataCommand`
- `SinkCommand`
- `ErrorCommand`

### Current `TextCommand` contract

`TextCommand.apply(ctx)` is strict:

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
2. Flatten one output array at a time via `flattenCommandBuffer(...)`.
3. For each entry in sequence:
   - collect poison from `ErrorCommand` / poison markers
   - for `OutputCommand`, pre-scan args for poison before `apply(...)`
   - validate output handler target (builtin or current custom output)
   - call `command.apply(...)`
   - recurse nested `CommandBuffer`
4. If any errors collected: throw `PoisonError(errors)`.
5. Return `output.getCurrentResult()`.

Notes:

- Text commands are not special-cased in flattener anymore; they run through `TextCommand.apply(...)`.
- Data commands lazily instantiate `DataHandler` base when needed.

## Safe Output and Text Materialization

File: `src/runtime/safe-output.js`

### Core suppressors

- `suppressValue(val, autoescape)` (sync)
- `suppressValueAsync(val, autoescape, errorContext)` (async template expression path)
- `suppressValueScript(...)` and async variant (script text behavior)

Normalization detail used by template suppress/ensure/materialization helpers:

- `normalizeBufferValue(...)` unwraps envelope-like values:
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

- `src/compiler/compile-emit.js`
- `src/compiler/compile-buffer.js`
- `src/compiler/compiler.js`
- `src/compiler/compile-inheritance.js`

## Root setup

- Sync root: string buffer.
- Async root: command buffer + default `text` output declaration.

## Text output emission

- Template text expressions compile through `suppressValue`/`suppressValueAsync` and are emitted as `TextCommand` writes in async mode.
- Sync mode appends directly to string buffer.

## Return handling

- Async `compileReturn` waits closures, resolves return value, checks poison, finalizes unobserved sinks, then returns/callbacks.
- Sync `compileReturn` emits direct callback return.
- `finalizeUnobservedSinks(...)` intentionally ignores errors for sinks that were never observed.

## Capture/Call Blocks

- Async `compileCapture` creates a temporary command buffer/output scope, waits `astate.waitAllClosures(1)`, then flattens that temporary text output.
- `compile-emit.asyncBlockRender` uses the same pattern for template call-block rendering in async mode (`waitAllClosures(1)` + `flattenBuffer` on temporary text output).

## Inheritance-specific note (`super()`)

Async `compileSuper` path currently:

1. gets super block result via `context.getSuper(...)`
2. materializes command-buffer text via `runtime.materializeTemplateTextValue(...)`
3. applies `runtime.markSafe(...)`

This ensures composed super text is concrete before suppression/append.

## Error and Poison

- Poison markers are inserted via `addPoisonMarkersToBuffer(...)` as `ErrorCommand(PoisonedValue)` entries.
- Flatten collects all poison/command errors and throws one `PoisonError` with aggregated errors.
- Policy remains: never miss any error during flatten of observed outputs.

## Invariants

1. `_outputHandlers` is sink-focused runtime map.
2. `_outputs` is the lexical output registry used by lookup/finalization paths (not the direct flatten mutation target).
3. Output name and output type are distinct concepts.
4. Text command validity is enforced in `TextCommand.apply(...)`.
5. Flatten is replay/error-collection; final shaping is in output objects (`getCurrentResult` / sink snapshot semantics).
6. Sync template path remains string-based; async template path remains command-buffer based.

## Transitional Notes

- `suppressValueAsync` still has a compatibility fallback for direct `CommandBuffer` input; preferred long-term direction is boundary materialization (`materializeTemplateTextValue`) in compiler/runtime call boundaries.
- Some composition paths still rely on evolving boundary conventions; keep tests around inheritance/caller/capture paths as guardrails.
