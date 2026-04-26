# Composition Payload Review

Status: current review after extern removal and the switch to payload-backed
composition. `docs/code/extends-plan.md` is intentionally not used as authority
for this review.

Scope boundary:

- `extern` is removed as a language construct and runtime/compiler contract.
- `import`, `from ... import`, `include`, `extends`, and `component` use the
  same composition-payload model in the async/Cascada composition implementation.
- the sync compiler remains Nunjucks-compatible and is not part of the payload
  rollout.
- Payload is copied at the composition boundary and is not shared state.
- `with context` exposes render-context values only where the composition site
  opts into it.

## Resolved In Current Phase

These were inside the current phase's end state and have been addressed.

- `[COMPLETENESS/CORRECTNESS] component composition` -
  fixed `component` composition so render-context values are included only when
  the component site uses `with context`.

- `[TESTS] component payload isolation` -
  added a negative regression proving a component without `with context` cannot
  read a render-context-only name.

- `[DOCUMENTATION] composition update plan` -
  rewrote the old composition update plan around the current payload model.

## Resolved Cleanup Items

These were originally listed as future cleanup, then resolved as part of the
same extern-removal/payload-composition cleanup pass.

- `[TRANSITIONAL SCAFFOLDING] context execution state` -
  replaced the old structural-state helper functions with an explicit
  `ContextExecutionState` owner.

- `[TRANSITIONAL SCAFFOLDING] context forks` -
  simplified context forks so they share `executionState` directly instead of
  reattaching structural maps through a helper.

- `[NAMING/READABILITY] composition context fields` -
  renamed the internal fields to `compositionContextVars` and
  `compositionPayloadVars`.

- `[SIMPLIFICATION] composition payload shape` -
  added `runtime.createCompositionPayload(...)` and reused it for component and
  inheritance payload shape creation.

- `[SIMPLIFICATION] composition context emission` -
  replaced extern-era context emission with a narrow payload/context merge
  helper shared by import, from-import, include, extends, and component.

- `[DOCUMENTATION] composition architecture` -
  rewrote the document around payload, render-context opt-in, current-buffer
  ownership, shared-state separation, and sync compatibility.

- `[SYNC COMPATIBILITY] sync composition` -
  sync `import`/`from ... import`/`extends`/`include` keep the Nunjucks-compatible
  implementation. Explicit named/object payload inputs remain rejected in sync
  mode; do not retrofit payload transport into the sync compiler.

## Review Notes

- No source-level `extern` API remains: searches for `externSpec`,
  `ExternDeclaration`, `validateExtern`, `getExtern`, and `externLookup` return
  no live implementation references.
- Parser and AST coverage for `withVars`, `withValue`, and `withContext` is
  consistent across import-like composition, `extends`, `include`, and
  `component`.
- The async import/from/include/extends paths use payload objects rather than
  callee-side declarations, which conforms to the current payload architecture.
- Sync compiler behavior is intentionally unchanged for Nunjucks compatibility.
- Payload materialization through
  `runtime.declareCompositionPayloadChannels(...)` is intentionally local to the
  receiving execution context and does not create shared state.
