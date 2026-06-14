# Sync-First Runtime Pattern

Use this reference when adding new Cascada runtime helpers, compiler-generated
callbacks, or value-consuming operations.

## Core Rule

Do not make a function `async` just because one input might be a promise.
Prefer a sync-first hybrid:

1. handle poison and concrete values synchronously;
2. prefer existing Cascada helpers to detect promises and lazy markers;
3. delegate async cases through `resolveThen(...)`, `thenValue(...)`, or a
   narrow async helper;
4. return either the concrete result or the thenable.

An `async` function always returns a promise. That is useful for true async
orchestration, but wasteful on hot paths where most values are already resolved.

## Runtime Helper Shape

Preferred shape for one consumed value:

```js
function helper(value, errorContext) {
  return resolveThen(value, (resolved) => {
    return handleSync(resolved, errorContext);
  }, (err) => {
    return poisonOrReport(err, errorContext);
  });
}
```

Preferred shape when another Cascada helper already returned value-or-thenable:

```js
function helper(value, errorContext) {
  const result = existingHelper(value, errorContext);
  return thenValue(result, (resolved) => {
    return transformSync(resolved, errorContext);
  });
}
```

Use manual promise/marker checks only for low-level helpers that need custom
fast-path branching before resolution, such as collecting multiple sync poison
values, special-casing arrays, or choosing a dedicated async helper:

```js
function helper(value, errorContext) {
  if (isPoison(value)) {
    return value;
  }
  if (!value || (typeof value.then !== 'function' && !value[RESOLVE_MARKER])) {
    return handleSync(value, errorContext);
  }
  return helperAsync(value, errorContext);
}

async function helperAsync(value, errorContext) {
  try {
    const resolved = await resolveSingle(value);
    return handleSync(resolved, errorContext);
  } catch (err) {
    return poisonOrReport(err, errorContext);
  }
}
```

In generated code, use the `runtime.` prefix for these helpers.
`thenValue(...)` is Cascada-aware: it preserves poison on the sync path and
unwraps resolved-value wrappers.

## Compiler-Generated Callback Shape

Statement and expression boundary callbacks should usually be plain functions:

```js
(currentBuffer) => {
  return runtime.consumeControlFlowValue(cond, currentBuffer, chains, ec, (value) => {
    if (value) {
      // emit selected body
    }
  });
}
```

Use an `async` generated callback only when the callback itself must perform
multiple ordered awaits before it can return a semantic result.

Good reasons to keep `async`:

- consume several values in sequence and collect all errors;
- drive an async iterator;
- coordinate commit/rollback or cleanup in `try/finally`;
- preserve expression-boundary rejection semantics while awaiting an operation
  that cannot be represented as a single `thenValue(...)` continuation.

Bad reasons to use `async`:

- one condition might be a promise;
- one selected expression might return a promise;
- a final snapshot might be promise-shaped;
- a helper can already return value-or-thenable.

## Error Rules

Keep value consumption separate from fatal runtime failures.

- Existing `PoisonedValue`: handle synchronously with `isPoison(value)`.
- Promise rejection with `PoisonError`: preserve or group the poison error.
- Non-poison rejection at a value-consumption point: use the appropriate runtime
  helper, usually `poisonOrReport(...)`, `poisonOrRethrow(...)`, or
  `RuntimeError.reportAndThrow(...)` depending on ownership.
- Runtime contract failures: keep fatal; do not convert them to poison.

Do not catch broad errors just to keep going. Only value-consumption failures
belong in poison flow.

## Boundary Helpers

Use these runtime helpers instead of hand-writing generated promise plumbing:

- `resolveThen(value, onValue, onError)`: consume one Cascada value.
- `thenValue(value, onValue, onError)`: chain a Cascada helper result.
- `consumeControlFlowValue(...)`: statement control-flow selector consumption
  with skipped-chain poisoning.
- `finishBufferAndWait(...)`: finish a waited loop buffer and return the waited
  chain snapshot.
- `finishBufferAndContinue(...)`: finish a waited loop buffer and resolve clean
  completion to `true`.

## Test Checklist

When adding or converting sync-first code, cover:

- resolved concrete value path;
- promise path;
- existing poison path;
- rejected-promise poison path;
- non-poison fatal path where applicable;
- generated source shape when the goal is to avoid local `async` or `await`;
- no missed errors when multiple independent values are consumed.

## Future Chat Context

When asking an agent to add new async-aware runtime/compiler functionality, give
this instruction:

> Use the Cascada sync-first runtime pattern from `docs/code/sync-first.md`.
> Public helpers and generated callbacks should be non-async unless they truly
> need local awaits. Handle concrete values and poison synchronously, delegate
> actual promises to async helpers or `thenValue`/`resolveThen`, and preserve
> Cascada poison vs fatal error semantics.
