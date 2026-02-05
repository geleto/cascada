# Command Next - Refactor Plan

**Status:** Draft design prompt for refactor

## Big Picture

We are refactoring Cascada's script-mode output pipeline so that buffers contain only Command
objects and nested CommandBuffers, and flattening becomes a simple, deterministic pass that
applies commands to a target context. The goals are:
- Simplify flatten-commands by moving handler logic into command classes.
- Output objects (TextOutput, DataOutput, ValueOutput) become the ctx passed to apply().
  No separate resolver — the flattener finds Outputs on the frame.
- Preserve shared CommandBuffer context for telemetry/tracing.
- Keep template mode largely unchanged.
- Make error propagation explicit via a dedicated ErrorCommand.

This document is a prompt/spec for implementing the new command system.

---

## Current System (What Exists Today)

### Output collection
- Async execution contexts write to CommandBuffer instances.
- Each handler has its own array in CommandBuffer.arrays (text/data/value/output).
- Values are wrapped by _wrapCommand(), but arrays, nested buffers, and PoisonedValue can bypass wrapping.
- Output objects (TextOutput, DataOutput, ValueOutput) live on the frame. They enqueue commands
  to the buffer but do not own the output targets.

### Flattening (script mode)
- flatten-commands handles a wide mix of inputs:
  - command objects (handler/command/subpath/arguments)
  - CommandBuffer containers
  - arrays
  - plain objects with {text, data}
  - poison markers and PoisonedValue
- Handler lookup and invocation are performed inside the flattener.
- Text output accumulates in `state.textOutput[name]` — an array that is joined at the end.
- Handler instances accumulate in `state.handlerInstances[name]` — resolved lazily on first
  command for that handler.
- Both are discarded after the flatten pass completes.

### Poison handling
- PoisonedValue can be placed directly in buffers.
- Poison markers are inserted when skipped branches would have written to output.

### Problems with current system
- flatten-commands is complex and mixes many responsibilities.
- Command data is not first-class; execution logic is spread across flattener.
- Multiple data shapes in buffers complicate reasoning and future snapshot work.
- Output targets live transiently in flatten state. Output objects on the frame do not own them,
  so snapshot() must trigger a full flatten pass every time.

---

## Target System (What We Want)

### Buffer content rules
- Script-mode buffers contain only:
  - Command objects (new class-based commands)
  - CommandBuffer containers (nested buffers)
- No raw arrays or plain objects in script buffers.
- Template mode remains unchanged and may still flatten arrays/primitives.

### Command execution model
- Each command is a class with:
  - `apply(ctx)` method that mutates `ctx` in place.
  - `next` pointer for chain traversal.
- Commands do NOT hold ctx; ctx is passed in at apply time.
- ctx IS the Output object for the handler.

### Output objects as ctx

The existing Output classes (TextOutput, DataOutput, ValueOutput) become the ctx that commands
receive. No separate resolver is needed — the flattener looks up Output objects by handler name
via `frame._outputs` (the same path `getOutputHandler` already uses).

Each Output gains two properties:

- **_target** — the output accumulator. Starts at a type-appropriate default and is what
  `snapshot()` returns (or throws from, if it is a PoisonedValue set by ErrorCommand).
  - TextOutput: `[]`. Commands push escaped strings; snapshot joins to `''`.
  - ValueOutput: `undefined`. ValueCommand replaces it.
  - DataOutput: `{}`. The fallback when no commands have fired. Once commands fire, snapshot
    returns `_base.snapshot()` instead (see _base below).

- **_base** — present only on DataOutput and SinkOutput. The handler instance that commands
  dispatch to. Resolved lazily on the first `apply()` call. Stable across the lifetime of the
  Output — ErrorCommand does not touch it. TextOutput and ValueOutput do not have _base.

The `_target` / `_base` split matters only when errors occur mid-stream. In the happy path for
data/sink, commands dispatch to `_base` and snapshot reads from `_base.snapshot()`. When
ErrorCommand fires, it replaces `_target` with PoisonedValue. Subsequent commands are skipped.
`snapshot()` sees the PoisonedValue on `_target` and throws.

### Command classes (initial set)
- TextCommand: value — pushes to `ctx._target`
- ValueCommand: value — replaces `ctx._target`
- DataCommand: path, command, arguments — dispatches to `ctx._base`
- SinkCommand: command, arguments, subpath — dispatches to `ctx._base`
- ErrorCommand: value (PoisonedValue) — replaces `ctx._target`

DataCommand and SinkCommand should share a base class for handler invocation and subpath access.

### Flattening (script mode)
- New flatten-commands should:
  1) Look up the Output object for the target handler via `frame._outputs`.
  2) Traverse the command chain or buffer in order.
  3) Call `apply(output)` on each command.
- No handler-specific logic should remain in the flattener.

---

## Mapping from Old System to New System

This section clarifies how existing concepts map into the new command/ctx model.

- **state.handlerInstances[name] → Output._base**
  Handler instances that currently accumulate in flatten state move into DataOutput._base /
  SinkOutput._base. Resolution stays lazy: _base is resolved on first apply(), not at Output
  construction.

- **state.textOutput[name] → TextOutput._target**
  The per-name text accumulator array that currently lives in flatten state moves into
  TextOutput._target. Initialized at Output construction; populated during flatten.

- **Handler name → frame._outputs lookup**
  Handler names are still used to select the correct Output. No separate resolver object —
  the flattener finds Outputs via `frame._outputs` / `getOutputHandler`, which already exists.

- **Command objects → Command classes**
  Legacy command objects (handler/command/subpath/arguments) become command class instances
  (DataCommand/SinkCommand/TextCommand/ValueCommand).

- **Poison markers/PoisonedValue → ErrorCommand**
  Script-mode poison handling is represented as ErrorCommand, which replaces `Output._target`
  with a PoisonedValue. Template mode remains unchanged.

- **Flatten-commands handler logic → Command.apply(ctx)**
  Logic that currently lives in flatten-commands moves into the command classes.

- **Output.snapshot() applyDefault → removed**
  The `applyDefault` closure in snapshot() exists because flatten can return undefined when no
  commands fire. Once `_target` is initialized at construction with the type-appropriate default
  (`[]` for text, `{}` for data, `undefined` for value), the defaults are baked in.

---

## Migration Plan (Testable Steps)

### Step 1: Producer inventory and coverage
- Inventory all producers that put non-command values in script buffers.
- Ensure tests cover each producer.
- Tests: full suite.

### Step 2: Add _target and _base to Output classes
- TextOutput: `_target = []`.
- ValueOutput: `_target = undefined`.
- DataOutput: `_target = {}`, `_base = null` (lazy).
- Update `createOutputProxy` whitelist to include `_target` and `_base`.
- Remove `applyDefault` from snapshot(); use `_target` directly.
- Nothing reads `_target`/`_base` yet — no behavior change.
- Tests: full suite.

### Step 3: Introduce Command class interface (no behavior change)
- Add Command base class with `apply(ctx)`.
- TextCommand, ValueCommand, DataCommand, SinkCommand, ErrorCommand class stubs.
- Adapter to wrap existing plain command objects into Command instances during flatten.
- Tests: full suite.

### Step 4: Wire flatten to use Output as ctx
- Flattener looks up Output objects by handler name via `frame._outputs`.
- For each command, call `apply(output)` instead of inline dispatch.
- Start with text/value (no _base, no subpath resolution). Data/sink follow in the same step
  or immediately after.
- Tests: full suite.

### Step 5: Add ErrorCommand, replace poison markers
- Implement ErrorCommand.apply(): replaces `ctx._target` with PoisonedValue.
- Replace script-side poison markers with ErrorCommand in producers.
- snapshot() checks `_target` for PoisonedValue; throws PoisonError if so.
- Keep template behavior unchanged.
- Tests: full suite.

### Step 6: Remove result objects from script buffers
- Replace `{text, data}` result objects with explicit commands.
- Deprecate object handling in flatten-commands.
- Tests: full suite.

### Step 7: Enforce invariants and rewrite flatten-commands
- Runtime checks: script buffers contain only Command or CommandBuffer.
- Remove array handling, object handling, `state.textOutput`, and `state.handlerInstances`
  from flatten-commands. The flattener is now: look up Output, traverse commands, call apply().
- Tests: full suite.

---

## Notes
- `apply(ctx)` mutates ctx; the flattener should not rely on return values.
- Shared CommandBuffer context is preserved; child buffers inherit parent trace id.
- Template mode remains unchanged.
- Handler resolution for data/sink stays lazy: `_base` is resolved on first `apply()`, not at
  Output construction. Preserves the current timing — handlers are not instantiated unless they
  receive at least one command.
- The Proxy on DataOutput must whitelist `_target` and `_base` alongside existing internal
  properties (`snapshot`, `_outputName`, `_outputType`, `_frame`, `_context`).
- snapshot() logic for DataOutput after migration: if `_target` is PoisonedValue → throw.
  If `_base` is set → return `_base.snapshot()`. Otherwise → return `_target` (the `{}` default).
