# Sequence Output

This document describes the current `sequence` output implementation.

## Declaration

Syntax:

```cascada
sequence db = makeDb()
```

Rules:

- Initializer is required.
- Declaration conflicts/redeclaration follow normal explicit-output rules.
- In phase 1, this is script-mode output behavior (same family as `sink`).

## What Sequence Supports

1. Method calls (value-returning):

```cascada
var user = db.getUser(1)
```

2. Property reads (value-returning):

```cascada
var state = db.connectionState
```

3. Static subpath routing (same static-path extraction model as `sink` output commands):

```cascada
var id = db.api.client.getId()
```

Current non-goals:

- Property assignment through sequence output syntax is rejected in phase 1.

```cascada
db.connectionState = "x"   // compile error
```

## Runtime Model

`sequence` is implemented as `SequenceOutputHandler` over sink-style infrastructure.

Key behavior:

- The sequence initializer may be sync or async.
- `snapshot()` fallback chain is sink-like:
  1. `snapshot()`
  2. `getReturnValue()`
  3. `finalize()`
  4. the object itself
- Method receiver binding is preserved (`method.apply(target, args)`).
- Missing properties return `undefined`.

Relevant files:

- `src/runtime/output.js`
- `src/runtime/commands.js`

## Command Types

`sequence` uses two explicit command classes:

- `SequenceCallCommand`
- `SequenceGetCommand`

Why split:

- Call and read semantics stay explicit.
- `SequenceGetCommand` is non-mutating (`mutatesOutput = false`).
- No shape-dependent branching in a single command implementation.

Deferred result model:

- Commands can be created with `withDeferredResult: true`.
- The command owns `promise/resolve/reject`.
- `apply()` resolves/rejects that promise with the call/read result.

## Compiler Integration

There are two emission paths.

1. Statement-style output command path (`command`):

- Emitted through `compile-buffer`.
- Uses `SequenceCallCommand` for calls, `SequenceGetCommand` for reads.
- Enqueue-only behavior.

2. Expression path:

- Emitted through `compiler-base` as:
  - `runtime.sequenceCall(...)`
  - `runtime.sequenceGet(...)`
- Returns value to expressions via deferred command promise behavior.
- `snapshot` member is intentionally not intercepted as a sequence read/call.

Relevant files:

- `src/compiler/compile-buffer.js`
- `src/compiler/compiler-base.js`

## Ordering Semantics

- Normal flow is command-buffer ordered (same ordering model as sink command execution).
- Access/call happens at apply-time (not at enqueue-time).
- `sequence` output commands are not wired to `!` lock-key sequencing (`runtime/sequential.js`).

## Guard Semantics

`sequence` guard handling is transaction-style and independent from sink pause semantics.

Hook shape on sequence objects:

- `begin()`
- `commit(token?)`
- `rollback(token?)`

Behavior:

- On guard entry for targeted sequence handlers: `begin()` is called and token captured.
- On guard success: `commit(token?)` is called.
- On guard failure: `rollback(token?)` is called.
- Nested transactions unwind in LIFO order.
- Missing hooks: sequence transaction path is skipped for that handler.
- Hook errors are collected as guard errors (poison path).

Buffer pause behavior:

- Sequence-only guarded output sets do not pause the command buffer.
- Guarded sets including non-sequence handlers still use pause/resume for snapshot/revert safety.

Deadlock-avoidance behavior for sequence expression calls/reads:

- Normal flow: enqueue deferred command, return command promise.
- Paused-buffer or foreign-buffer flow: run sequence command immediately and return its result/promise.

Relevant files:

- `src/runtime/guard.js`
- `src/compiler/compiler.js`
- `src/runtime/output.js`

## Parser/Transpiler Notes

- `sequence` is recognized as an explicit output declaration.
- Declarations require initializer.
- Sequence property assignment is rejected in script transpilation/compilation path.

Relevant files:

- `src/parser.js`
- `src/script/script-transpiler.js`

## Current Test Coverage

Primary suites:

- `tests/explicit-outputs.js`
- `tests/poison/guard.js`

Covered behavior includes:

- declaration validation
- return values from sequence calls/reads
- async call return values
- method receiver binding
- missing-property `undefined`
- source-order sequence execution
- sequence subpath method calls
- guard begin/commit and begin/rollback flows

