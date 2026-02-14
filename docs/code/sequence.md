# Sequence Output: Implementation Plan

This document defines the plan for a new output declaration:

- `sequence <name> = <initializer>`

`sequence` is initialized at declaration time (like `sink`), executes commands in source order, and supports value-returning operations.

## Confirmed Semantics

## Declaration

```cascada
sequence db = makeDb()
```

Rules:

- Initializer is required.
- Same redeclaration/conflict rules as other outputs.
- Script-only in phase 1 (same mode family as sink usage).

## Supported Operations (Phase 1)

1. Method call (returns value)

```cascada
var user = db.getUser(1)
```

2. Property read (returns value)

```cascada
var status = db.connectionState
```

Not supported yet:

- Property writes through sequence output syntax.

```cascada
db.connectionState = "x"   // compile-time error in phase 1
```

Property-read details:

- Missing property returns `undefined`.
- Method receiver binding must preserve `this === sequence object`.

## Ordering Model

- Sequence operations are ordered like sink command execution.
- Access/call happens at command apply-time (not enqueue-time).
- No integration with `!` sequence lock keys.
- No use of `runtime/sequential.js` lock namespace for `sequence` output commands.

## Snapshot Model

- `sequence.snapshot()` uses sink-like result fallback:
  1. `snapshot()`
  2. `getReturnValue()`
  3. `finalize()`
  4. object itself
- No deep clone requirement in phase 1 (sink-like/reference semantics).

## Guard Model (Transactional Hooks)

Sequence recovery in guard uses transaction-like hooks on the sequence object.

Hook shape:

- `begin()`
- `commit(token?)`
- `rollback(token?)`

Behavior:

- Guard targeting for `sequence` is exactly the same as `sink`.
- Guard entry: call `begin()` and store returned token (if any).
- Guard success: call `commit(token?)`.
- Guard failure: call `rollback(token?)`.
- Runtime guarantees each `begin()` pairs with exactly one `commit` or `rollback`.

Token handling:

- Token is optional.
- If returned, runtime passes it back to `commit/rollback`.
- If not returned, implementation may use internal current transaction context.

Nesting:

- Nested guards create nested begin/commit/rollback scopes in LIFO order.
- Implementations that support nesting should map to savepoints/subtransactions.
- If implementation does not support nesting, it should fail clearly on nested `begin()`.

Hook async/error semantics:

- Hooks may return promises; promise-returning hooks are awaited.
- If `begin`, `commit`, or `rollback` throws/rejects, result is poisoned.
- On commit failure, result is poisoned (no automatic rollback retry in phase 1).
- If hooks are missing, sequence output is ignored by guard transactional recovery path.

## Implementation Plan

## Phase 1: Runtime Type + Declaration

Files:

- `src/runtime/output.js`
- `src/runtime/runtime.js`
- parser/compiler declaration handling

Steps:

1. Add output type `"sequence"` to declaration pipeline.
2. Implement `SequenceOutputHandler` (or extend sink-style handler) with:
   - initializer resolution (sync/async)
   - ordered command application
   - snapshot fallback chain
3. Register in output buffer maps like other outputs.

## Phase 2: Command Surface

Files:

- `src/runtime/commands.js`
- compiler output-command emission

Steps:

1. Add sequence command types:
   - `SequenceCallCommand`
   - `SequenceGetCommand`
2. Ensure `apply()` can return operation values to expression paths.
3. Preserve sink-like side-effect ordering while allowing return values.

## Phase 3: Compiler Semantics

Files:

- `src/compiler/compiler.js`
- `src/compiler/compiler-base.js`
- script transpiler pieces

Steps:

1. Parse/emit `sequence` declaration with required initializer.
2. For `sequenceName.foo(...)`, emit sequence call command path and return value.
3. For `sequenceName.foo`, emit sequence property-read command path and return value.
4. Reject property assignment on sequence outputs in phase 1.
5. Preserve method call receiver binding.

## Phase 4: Guard Integration

Files:

- `src/runtime/guard.js`
- compiler guard emission where output snapshots/recovery are wired

Steps:

1. On guard entry for targeted sequence outputs: call `begin()` and store token per output.
2. On guard success: call `commit(token?)`.
3. On guard failure: call `rollback(token?)`.
4. Ensure nested guards unwind in strict LIFO order.
5. Sequence targeting/selectors follow sink selector behavior.

## Phase 5: Tests

Add/extend:

- `tests/explicit-outputs.js`
- `tests/poison/guard.js`

Coverage:

1. Declaration
   - requires initializer
   - conflicts/redeclaration
2. Core operations
   - method calls return values
   - property reads return values
   - async return values
   - missing property returns `undefined`
   - method `this` binding is sequence object
3. Ordering
   - source-order execution with mixed fast/slow ops
   - apply-time (not enqueue-time) access behavior
4. Guard transactions
   - begin/commit on success
   - begin/rollback on failure
   - optional-token handling
   - nesting behavior
   - hook throw/reject poison behavior
   - commit failure poison behavior
   - missing-hook ignore behavior
   - selector behavior parity with sink (`guard @`, named handlers, wildcard)
5. Snapshot
   - snapshot fallback chain and command-time consistency

## Compatibility Notes

- Existing `!` sequential semantics remain unchanged.
- `sequence` uses separate codepaths from `runtime/sequential.js` lock mechanics.
