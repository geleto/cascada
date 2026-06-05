# Cascada Error Handling Guide

This guide describes the current error model. Older migration notes may still
show transitional names such as `TemplateError`, `RuntimeFatalError`, or
aggregate-style `new PoisonError(errors)` examples; those are historical.

## Runtime Families

Cascada has three public error families plus the `PoisonedValue` transport:

- **`CompileError`**: compile/load-time failure with source position fields.
- **`RuntimeError`**: fatal runtime/engine failure. Runtime errors are not
  collected into poison and must not be converted to non-fatal dataflow errors.
- **`PoisonError`**: individual non-fatal value/dataflow failure with compact
  source-origin context. Its `cause` is the original JavaScript error when one
  exists.
- **`PoisonErrorGroup`**: aggregate of individual `PoisonError`s. This is what
  a `PoisonedValue` rejects with when awaited. Construct it only from individual
  poison errors; use `PoisonError.group(...)` to normalize an existing group.

`PoisonedValue` is not an `Error`. It is a thenable container carrying
`.errors[]` so runtime code can detect poison synchronously with
`isPoison(value)` before `await`.

## Source-Origin Rule

Error context belongs to the source operation that created the error, not to a
later consumer. Consumption paths must preserve an incoming error's context.

- Create a new engine-authored non-fatal value error at its origin with
  `PoisonError.create(message, errorContext)`.
- Wrap a caught user/source failure at its origin with
  `PoisonError.wrap(error, errorContext)`.
- Aggregate already-originated poison errors with `PoisonError.group(errors)`.
- Internal runtime code creates synchronous poisoned values only from existing
  typed poison errors
  with `createPoison(PoisonError.wrap(error, errorContext))`,
  `createPoison(PoisonError.create(message, errorContext))`, or
  `createPoison(PoisonError.group(errors))`. `createPoison(...)` is not part of
  the public package export surface.
- Create fatal runtime errors with `RuntimeError.create(error, errorContext)`;
  report them to the active render with `RuntimeError.report(...)` or
  `RuntimeError.reportAndThrow(...)`.
- Do not attach a local consumption `errorContext` to an incoming
  `PoisonError`, `PoisonErrorGroup`, or `PoisonedValue`.

The same rule applies to command-buffer diagnostic stacks: stack entries come
from the buffer/boundary where the async branch was created, not from arbitrary
later value consumption.

## Sync Path

The frozen Nunjucks-compatible synchronous compiler path still uses positional
`createSyncRuntimeError(error, lineno, colno, label, path)`. Do not rewrite those call
sites as part of async error cleanup.

Async code should use compact prepared error contexts and the runtime error
classes/helpers listed above.

## Poison Handling Rules

- Check `isPoison(value)` before `await`.
- In `catch`, use `isPoisonError(err)`; it matches both `PoisonError` and
  `PoisonErrorGroup`.
- Non-`async` and sync-first hybrid functions may return `PoisonedValue`
  directly.
- `async` functions must throw poison errors instead of returning
  `PoisonedValue`; use `PoisonError.group(value.errors)` for existing poison.
- Always collect all independent value errors before returning/throwing:
  Cascada's poison system follows the "Never Miss Any Error" principle.

## Fatal vs Non-Fatal

Only value-consumption failures become poison. Broken runtime contracts,
unexpected engine invariants, and structural execution failures are
`RuntimeError`s and are fatal for the render. Compiler and loader validation
failures are `CompileError`s.
