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

### When to apply it (and when not)

Apply sync-first to hot paths and public helpers where a meaningful share of
calls receive already-resolved values. The pattern has a real cost: it splits
one logical operation across a sync entry plus an async helper, so use judgment.

Skip it — just write a plain `async` function — when:

- the path is cold (setup, error formatting, rarely-hit branches);
- the operation is async on essentially every call (for example an
  async-iterator driver), so the sync branch would never run;
- splitting would duplicate non-trivial logic across the sync and async paths
  with no measurable win.

Readability counts: a clear `async` function beats a contrived hybrid that saves
a microtask on a path nobody hits.

## Runtime Helper Shape

Pick the resolver by what the input *might be*, not by convenience:

- **`resolveThen(value, onValue, onError)`** — the value may be *raw or
  unresolved*: a real promise, a lazy `RESOLVE_MARKER`, or an unknown shape. It
  runs `resolveSingle` first, so it finalizes lazy markers and converts promise
  rejection to poison. On a concrete sync value it still allocates a
  resolved-value wrapper, so it is slightly heavier.
- **`thenValue(value, onValue, onError)`** — the value is *already a
  Cascada-resolved* value-or-thenable, typically the return of another resolve
  helper. It preserves poison on the sync path and unwraps resolved-value
  wrappers, but does **not** finalize a lazy `RESOLVE_MARKER`. Passing a raw lazy
  value here silently skips finalization, so only use it on already-resolved
  results. It allocates nothing on the concrete path.

Preferred shape for one raw consumed value:

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

Write a dedicated `async` helper only for the same reasons a generated callback
stays async (see [Compiler-Generated Callback Shape](#compiler-generated-callback-shape)).

### Consuming multiple values

The shapes above consume one value. For several independent values, do not
short-circuit on the first poison — that drops later errors. Use `resolveAll`
(or `resolveDuo` for exactly two), which await all inputs in parallel and group
every collected error into a single poison. This is the "Never Miss Any Error"
rule from AGENTS.md.

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

The same rule governs runtime helpers and generated callbacks: use `async` only
when the function itself must perform multiple ordered awaits before it can
return a semantic result.

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
- Non-poison rejection at a value-consumption point: pick by what should happen
  next, not by habit:
  - `poisonOrReport(err, ec)` — return poison and keep going; reports a real
    error as fatal but lets value failures flow as poison. Default when this
    point owns a value it can poison.
  - `poisonOrRethrow(err, ec)` — rethrow poison to an awaiting caller and
    escalate a real error to fatal. Use when the caller, not this point, owns
    recovery.
  - `RuntimeError.reportAndThrow(err, ec)` — always fatal. Use only for genuine
    contract/invariant violations that must never become poison.
- Runtime contract failures: keep fatal; do not convert them to poison.

Do not catch broad errors just to keep going. Only value-consumption failures
belong in poison flow.

## Boundary Helpers

Use these runtime helpers instead of hand-writing generated promise plumbing:

- `resolveThen(value, onValue, onError)`: consume one possibly-raw Cascada value
  (finalizes lazy markers; see [Runtime Helper Shape](#runtime-helper-shape)).
- `thenValue(value, onValue, onError)`: chain an already-resolved Cascada
  value-or-thenable (no marker finalization).
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
