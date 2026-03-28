# Expression Channels: Ordering and Child Buffer Requirements

## Overview

Expressions in async mode can emit commands to the current buffer, not just return promise-valued results. This happens for:

- `!` sequential path reads and writes (`db!.query()`, `obj!.prop`)
- `caller()` invocations (creates child buffer, adds `WaitResolveCommand` entries to `__caller__`)
- sequence-channel calls and reads (`data.push(...)`, `data.snapshot()`)

The key question is when those commands are emitted synchronously during JS argument evaluation, and when they are deferred too late.

---

## Fundamental Mechanism

`resolveDuo(leftExpr, rightExpr)` and `resolveAll([...exprs])` receive already-evaluated JS values. JavaScript evaluates function arguments left-to-right, synchronously, before calling the function. Any buffer side effects that happen during expression evaluation therefore happen in source order before `resolveDuo` / `resolveAll` runs.

That is why the following expression forms are safe when they emit commands:

- `!` sequential path calls and reads
- `caller()` direct dispatch
- sequence-channel calls and reads
- ordinary non-control-flow expressions whose command emission happens while the JS arguments are being built

The iterator, not `collectErrors`, owns real execution ordering. The important properties are:

1. emission order equals source order
2. mutable commands are serialized by the iterator

---

## Working Cases

### Sequential Paths

`runtime.sequentialCallWrapValue(...)` and `runtime.sequentialMemberLookupAsyncValue(...)` add their commands synchronously to the current buffer. The actual work happens later when the iterator applies the command. Since JS evaluates arguments left-to-right, these commands are added in source order.

### `caller()`

Direct `caller()` dispatch adds its `__caller__` tracking commands synchronously in the current boundary. That keeps caller scheduling ordered correctly with sibling command-emitting expressions.

This remains true only as long as the generated expression actually reaches the `caller()` invocation synchronously in the current boundary.

### Sequence Channels

Sequence-channel calls and reads (`data.push(...)`, `data.snapshot()`, and related forms) are emitted synchronously as commands on the current buffer. Promise-valued arguments are resolved later at apply time.

---

## Failing Cases

### Control-Flow Sub-Expressions

`InlineIf`, `or`, and `and` are different because they evaluate a branch or right-hand operand only after a condition resolves. That means sibling operands may already have emitted their commands into the parent buffer first.

Examples:

- `(asyncCond ? a!.method() : b!.method()) + c!.method()`
- `(a or db!.fallback()) + c!.operation()`

These cases need child-buffer structural lowering, not deferred branch evaluation in a `.then(...)`.

### Legacy Async Expression Wrapping

The old `wrapInAsyncBlock` flag and `_assignAsyncWrappersAndReleases` pass are gone. What remains today is the generic `forceWrap` / `emit.asyncBlockValue(...)` path in recursive expression compilation.

That path is still legacy debt:

- it can defer command emission past the owning boundary
- it is no longer needed for the old sequence-wrapper purpose
- it should be removed from the remaining call sites

This is not just overhead. For command-emitting expressions such as `caller()`, `asyncBlockValue(...)` can let command emission happen after the enclosing buffer has already finished.

### Deferred Dynamic Macro/Caller Dispatch

Any path that still reaches macro or caller dispatch only through a later `.then(... callWrapAsync(...))` has the same structural problem class:

- the enclosing boundary is already established
- the real command-emitting dispatch happens later
- buffer creation / command registration may happen too late

Direct `caller()` is already fixed. The remaining audit target is other command-emitting dynamic call paths.

---

## Required Fix

Command-emitting control-flow expressions need the same treatment as control-flow statements: a child `CommandBuffer` whose slot is reserved synchronously before sibling operands are evaluated.

That gives:

1. child buffer reserved synchronously
2. condition awaited inside the child boundary
3. branch commands emitted into the child buffer
4. iterator descends into the child before moving past it

This also handles poison the same way as statement-level control-flow boundaries.

---

## Current Status

- async `compileInlineIf` now uses a control-flow child buffer when the expression mutates channels
- async `_compileBinOpShortCircuit` (`and` / `or`) now does the same
- sequence-expression metadata now comes from analysis
- compiler-side `processExpression(...)` and `_assignAsyncWrappersAndReleases` are gone
- dead `wrapInAsyncBlock` checks in recursive expression compilation / ternary / short-circuit lowering are gone
- `compileDo` compiles expressions normally again; fire-and-forget `do` semantics are the baseline
- pure value-only async cases still stay on the lighter `.then(...)` path for now

---

## Remaining Work

1. Remove legacy async expression wrapping from non-control-flow expression paths.
   - The remaining target is the generic `forceWrap` / `emit.asyncBlockValue(...)` path in recursive expression compilation.
   - Command-emitting expressions should not rely on that path.

2. Remove remaining deferred macro/caller dispatch from non-control-flow expression paths.
   - Do not route command-emitting macro/caller dispatch through `.then(... callWrapAsync(...))`.
   - Macro arguments must remain raw on that path.

3. Audit `_compileExpression(..., forceWrap)` call sites.
   - Remove forced wrapping where the enclosing statement or boundary already provides the required structure.
   - Prioritize structural text output / capture / include-import call chains.
   - `compileDo` itself is no longer special; if removing `forceWrap` regresses it, that points to a deeper ownership bug elsewhere.

4. Keep using existing analysis.
   - Use `node._analysis.usedChannels` to decide which parent channels a child expression boundary must link into.
   - Do not add ad hoc expression-only runtime linking rules if analysis already provides the needed facts.

5. Audit consumption sites to prefer resolve helpers over raw `await`.
   - Use `resolveSingle(...)`, `resolveDuo(...)`, and `resolveAll(...)` for ordinary Cascada value consumption.
   - Keep macro invocation as the exception: macro arguments stay raw.

6. Remove obsolete legacy helpers once the new paths are in place.
   - Remove remaining `asyncBlockValue(...)` call sites that only exist to support the old expression-ordering workaround.
   - If a value-only helper remains, it must not defer command emission past the owning boundary.

7. Verify with both ordering and boundary-timing regressions.
   - ternary / `and` / `or` with command-emitting operands
   - `caller()` inside expression output paths
   - nested caller / call-block dispatch through imported-callable async boundaries
   - any case where a deferred expression could add commands after an enclosing buffer finishes
