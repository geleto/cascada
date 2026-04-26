# Composition Update

This note replaces the old extern-era composition update plan. The current
composition architecture is payload-based and is documented in
[composition.md](composition.md).

Current state:

- `extern` is removed from the language, compiler, and runtime composition
  contract.
- Async/Cascada composition uses explicit payload transport for `import`,
  `from ... import`, `include`, `extends`, and `component`.
- Payload is copied at the composition boundary and is separate from shared
  state.
- `with context` is an explicit render-context opt-in.
- The sync compiler remains Nunjucks-compatible and does not receive Cascada
  payload transport.

Historical extern-based details were removed from this document to avoid
confusing stale planning notes with the current implementation contract.
