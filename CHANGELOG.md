# Changelog

All notable changes to `cascada-engine` are documented here.

This project follows SemVer. While Cascada is still in `0.x`, minor releases may include breaking language and runtime changes.

## Unreleased

### Changed

- Require Node.js 24 or later. Browser targets require native ESM, top-level await, and `Error.isError`.
- Unify missing-resource errors as `NotFoundError` with `resourceName` and the message `Resource not found: name`, including synchronous template loading. Nested rendering failures retain this error as their cause.
- WebLoader source paths are canonical absolute URLs. Requests must stay within the configured base origin and directory; HTTP failures expose status, URL, and response text.
- Loaders cache hits and misses and share pending requests by default. Dynamic loaders can select `cachePolicy: 'reload'`; source-level `noCache` prevents completed-source retention. Filesystem watchers invalidate added and deleted sources as well as changes.
- Relative dependencies of compiled sources stay with their declaring race member. String parents resolve independently through race members, consistently across cache policies.
- Environment getter overrides receive an optional final `SourceOrigin` argument and must forward it to preserve relative dependency ownership; `parentName` remains a string.
- `raceLoaders([])` now returns a loader that finds nothing instead of throwing.
- Environment cache invalidation is local; standalone text caches use `clearStringCache` or loader update events.

### Fixed

- Compile empty template and script sources, and accept empty loaded text.
- Correct `PrecompiledLoader` constructor typing to a name-keyed object map, and distinguish precompiled script return values from template strings.
- Keep loader subscriptions bounded and allow unused environments, groups, and sources to be collected.
- Prevent pending loads from restoring invalidated caches and separate compiled template/script modes by acquisition.
- Preserve errors across JavaScript realms and string parent names in environment getter overrides.
- Resolve relative dependencies through nested races, inherited blocks, macros, and component methods.

## [0.5.1] - 2026-04-29

### Fixed

- Fixed the published package install hook. `scripts/dev-install.js` is now included in the npm package and exits immediately when installed as a dependency, while still installing Playwright for local source checkouts.

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
