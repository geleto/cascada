# Sequence Chain

This document describes the current `sequence` chain implementation.

## Declaration

Syntax:

```cascada
sequence db = makeDb()
```

Rules:

- an initializer is required
- declaration conflicts follow normal explicit-chain rules
- this is script-mode behavior for initialized, ordered object chains

## What Sequence Supports

Method calls return values:

```cascada
var user = db.getUser(1)
```

Property reads return values:

```cascada
var state = db.connectionState
```

Static subpath routing is supported:

```cascada
var id = db.api.client.getId()
```

Property assignment through sequence chain syntax is rejected:

```cascada
db.connectionState = "x"   // compile error
```

## Runtime Model

`sequence` is an initialized chain over the command-buffer infrastructure.

Key behavior:

- the initializer may be sync or async
- method receiver binding is preserved
- missing properties return `undefined`
- snapshot fallback order is:
  1. `snapshot()`
  2. `getReturnValue()`
  3. `finalize()`
  4. the object itself

Relevant files:

- `src/runtime/chains/sequence.js`
- `src/runtime/command-buffer.js`

## Command Types

`sequence` uses two command classes:

- `SequenceCallCommand`
- `SequenceGetCommand`

The split keeps call and read semantics explicit. Calls may mutate the sequence
target. Reads are observation-like and return a deferred result.

## Compiler Integration

There are two paths:

1. Statement-style chain command path:
   - emitted through compiler buffer/chain helpers
   - enqueues a command on the active `currentBuffer`

2. Expression path:
   - emitted as runtime sequence helpers
   - returns the command's deferred result promise to the expression
   - does not intercept `snapshot` as a sequence property read

Relevant files:

- `src/compiler/chain.js`
- `src/compiler/buffer.js`
- `src/compiler/compiler-base-async.js`

## Ordering Semantics

- operations are command-buffer ordered
- calls/reads happen at apply time, not enqueue time
- sequence chain commands are separate from `!` sequential-path locks

Use `sequence` when the object itself provides the ordered side-effect surface.
Use `!` sequential paths for ordinary context paths.

## Guard Semantics

`sequence` guard handling is transaction-style.

Optional hook shape:

- `begin()`
- `commit(token?)`
- `rollback(token?)`

Behavior:

- on guard entry, targeted sequence chains call `begin()` if available
- on guard success, `commit(token?)` runs if available
- on guard failure, `rollback(token?)` runs if available
- nested transactions unwind in LIFO order
- missing hooks are tolerated
- hook errors become guard errors

Deadlock avoidance:

- normal flow enqueues a deferred command and returns the command promise
- paused-buffer or foreign-buffer flow may run the sequence command immediately
  and return its result/promise

Relevant files:

- `src/runtime/guard.js`
- `src/runtime/chains/sequence.js`
- `src/runtime/chains/sequential-path.js`

## Parser/Transpiler Notes

- `sequence` is recognized as an explicit chain declaration
- declarations require an initializer
- sequence property assignment is rejected in script transpilation/compilation

Relevant files:

- `src/language/parser.js`
- `src/language/script-transpiler.js`

## Current Test Coverage

Primary suites:

- `tests/pasync/chains-explicit.js`
- `tests/poison/guard.js`

Covered behavior includes:

- declaration validation
- return values from calls and reads
- async call return values
- method receiver binding
- missing-property `undefined`
- source-order execution
- static subpath method calls
- guard begin/commit and begin/rollback flows
