# Changelog

All notable changes to `cascada-engine` are documented here.

This project follows SemVer. While Cascada is still in `0.x`, minor releases may include breaking language and runtime changes.

## [0.5.0] - 2026-04-29

### Highlights

- Reworked Cascada around explicit language-level channels and explicit `snapshot()` materialization.
- Replaced the previous concurrency implementation with hierarchical command buffers, preserving source-order output while allowing independent work to run concurrently.
- Added a much larger Script language surface for orchestration workflows: explicit `return`, functions, methods, imports, inheritance, components, shared state, `guard` / `recover`, `sequence`, and sequential `!` paths.
- Clarified Script and Template as two syntaxes over the same async execution model: Scripts return values, Templates render text.

### Added

- Explicit `data`, `text`, and `sequence` channel declarations.
- Explicit `snapshot()` reads for materializing channel state.
- Script `return` statements for scripts, functions, methods, and call blocks.
- Script functions with ordinary value returns.
- Script `method` declarations for inheritance override points.
- Script `extends` support with explicit `with` payloads.
- Script `component` instances for multiple isolated instances of a script hierarchy.
- Shared state for inheritance and components through `shared var`, `shared data`, `shared text`, and `shared sequence`.
- `this.<name>` access for inherited methods and shared state.
- Template inferred `this.<name>` shared var access in async inheritance templates.
- `sequence` channels for strictly ordered reads and calls on stateful external objects.
- Sequential side-effect paths with `!`, plus path repair with `!!`.
- `guard` / `recover` recovery semantics for channels, variables, sequence channels, and sequential paths.
- `is error` and `#` error observation for dataflow poisoning.
- Import and composition payload forms using explicit `with` inputs.
- Precompiled runtime entry point via `cascada-engine/precompiled`.
- Documentation example tests covering the examples most likely to drift from real syntax.

### Changed

- Runtime execution now uses hierarchical command buffers. Commands are recorded in source order, child buffers represent async boundaries, and snapshots observe the current buffer hierarchy instead of relying on global output handlers.
- Channel output is no longer implicit. Scripts now declare output channels directly and explicitly return snapshots or values.
- Script variables use `var` declarations and ordinary assignment semantics.
- Template async behavior is documented as distinct from Script behavior, especially around output, macros, blocks, and `caller()`.
- `guard` recovery now documents `recover err` as binding a `PoisonError`; use `err.message` for the combined message or inspect `err.errors` from host JavaScript.
- Async templates use `{% asyncEach %}` for the sequential template equivalent of Script `each`.
- The public docs have been refreshed around the current Script and Template syntax.

### Removed / Deprecated

- Removed the old `@data`, `@text`, and custom `@handler(...)` style from the Script model in favor of typed channels.
- Removed Script `capture`; use `data` / `text` channels plus `snapshot()` and `return`.
- Removed legacy implicit materialization patterns; use explicit `snapshot()`.
- Removed legacy module coupling concepts such as `extern`, `reads`, and `writes` from the current Script model.
- Removed old bare shared-state access from scripts in favor of `this.<sharedName>`.
- Deprecated older Nunjucks-style top-level aliases where Cascada-specific names exist; prefer `renderTemplateString`, `renderScriptString`, `precompileTemplate*`, and `precompileScript*`.

### Migration Notes

- Replace old output handler code:

  ```cascada
  @data.user.name = "Ada"
  @text("hello")
  ```

  with explicit channels:

  ```cascada
  data result
  text body

  result.user.name = "Ada"
  body("hello")

  return { result: result.snapshot(), body: body.snapshot() }
  ```

- Replace `capture` blocks with a local channel and `snapshot()`.
- Return values explicitly from scripts and functions. For channel output, return `channel.snapshot()`.
- Use `this.sharedName` inside script inheritance/component code instead of bare shared names.
- Use `recover err` with `err.message` for user-facing recovery messages.
- Use `sequence name = expr` when an external object should be ordered by default, and use `object!.method()` when only a context path needs explicit side-effect ordering.

### Internal

- Added hierarchical command-buffer runtime architecture for async boundaries, channel linking, ordered snapshots, and deterministic output assembly.
- Reworked compiler analysis around declared, used, and mutated channels plus sequence-lock metadata.
- Expanded tests for channels, poison/error propagation, guards, sequential paths, inheritance, components, templates, and documentation examples.
