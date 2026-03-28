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
- async var assignments no longer use `forceWrap`; they now store the raw expression value, and marker-backed arrays survive command-argument normalization without losing `RESOLVE_MARKER`
- pure value-only async cases still stay on the lighter `.then(...)` path for now

---

## Remaining Work

1. Remove legacy async expression wrapping from non-control-flow expression paths.
   - The remaining target is the generic `forceWrap` / `emit.asyncBlockValue(...)` path in recursive expression compilation.
   - Command-emitting expressions should not rely on that path.
   - A direct removal probe showed that `forceWrap` is currently masking more than one underlying problem, so this must now be split into smaller fixes rather than deleted in one step.

2. Remove remaining deferred macro/caller dispatch from non-control-flow expression paths.
   - Do not route command-emitting macro/caller dispatch through `.then(... callWrapAsync(...))`.
   - Macro arguments must remain raw on that path.

3. Audit `_compileExpression(..., forceWrap)` call sites.
   - Remove forced wrapping where the enclosing statement or boundary already provides the required structure.
   - Current live call sites are concentrated in:
     - `compileReturn(...)`
     - `_compileGetTemplateOrScript(...)` for import / from-import / extends lookup
   - `compileAsyncVarSet(...)` is no longer on the generic wrapped-expression path.
   - `compileDo` itself is no longer special; the direct removal probe did not point back to it.
   - The raw removal probe produced three distinct regression classes:
     - stale lifecycle expectation tests
       - template render no longer waits for unused async variable assignments
       - this is now treated as the correct Cascada behavior, because root/template completion should wait only for the final observed value, not unrelated top-level work
       - those tests should be updated rather than reintroducing generic lifecycle tracking
       - async var assignments themselves are now off the wrapped-expression path
     - returned-value materialization regressions
       - script return can observe sequence-guard state before commit / rollback completes
       - this is a real bug because the returned value itself is being observed too early
       - current concrete repro: `guard a, b ... return events`
       - fixed by restoring the distinction between storage/timing commands and true value-consuming commands:
         - `__return__` and timing-only waits keep staged deferred values
         - real consumer commands still resolve their top-level arguments at apply time
     - aggregate materialization regressions
       - arrays / dictionaries with async elements leak raw promises into direct output, filters, and function arguments
       - the concrete root cause found for the async-var-assignment slice was loss of `RESOLVE_MARKER` inside `normalizeCommandArgsForDeferredHandling(...)`, which recursively cloned array values before apply-time resolution
       - preserving marker-backed arrays there removed the need for any producer-side `Promise.resolve(...)` workaround
       - `resolveSingle(...)` / `resolveSingleArr(...)` still expose branded trivial sync-thenables for compatibility with older `.then(...)` call sites; these are now collapsed immediately when they re-enter `resolveXXX(...)` or command-argument normalization
       - longer-term cleanup should eliminate those synthetic thenables at the call sites instead of teaching more runtime code about them
     - caller-body completion regressions
       - current concrete repro: call-block assignment where a macro does `out.push(caller(item))` in a loop and then `return out`
       - fixed by stopping command-argument resolution from descending into arrays returned by top-level promise/marker consumption
       - command-argument resolution now consumes only the top-level deferred value; nested arrays/objects remain raw until their true consumer observes them
     - raw command-argument promise staging regressions
       - removing `normalizeCommandArgsForDeferredHandling(...)` also reintroduced `PromiseRejectionHandledWarning`
       - fixed for the current paths by keeping staging only for the storage/timing commands that really need it, rather than resolving every command argument eagerly
     - structural include / import lookup still un-audited
       - this path still uses `forceWrap`, but the direct-removal probe was stopped before changing its behavior because the first two regression classes already proved the work needs decomposition
   - These classes should now be fixed one by one rather than reintroducing a generic wrapped-expression helper.

4. Keep using existing analysis.
   - Use `node._analysis.usedChannels` to decide which parent channels a child expression boundary must link into.
   - Do not add ad hoc expression-only runtime linking rules if analysis already provides the needed facts.

5. Audit consumption sites to prefer resolve helpers over raw `await`.
   - Use `resolveSingle(...)`, `resolveDuo(...)`, and `resolveAll(...)` for ordinary Cascada value consumption.
   - Keep macro invocation as the exception: macro arguments stay raw.

6. Remove obsolete legacy helpers once the new paths are in place.
   - Remove remaining `asyncBlockValue(...)` call sites that only exist to support the old expression-ordering workaround.
   - If a value-only helper remains, it must not defer command emission past the owning boundary.
   - The current forced-wrapper call sites are no longer treated as one problem. The plan is:
     1. remove `forceWrap` from async var assignments and update stale tests that assumed root/template completion waits for unrelated unused work
     2. fix returned-value materialization for `compileReturn(...)` without adding generic root lifecycle tracking
     3. replace aggregate materialization uses with explicit `RESOLVE_MARKER` consumption at true value boundaries
     4. then re-check whether import/include lookup still needs any dedicated wrapping or can move to an explicit structural boundary

7. Fix returned-value materialization currently hidden by `forceWrap`.
   - Async `return` expressions currently rely on `asyncBlockValue(...)` so script/template finalization does not observe the returned value before its own dependencies finish.
   - The fix should be value-oriented: materialize the returned result itself, not unrelated top-level work.
   - In particular, sequence-guard commit / rollback must be visible before `return events` observes the final value.
   - The current evidence suggests `return` must observe the value after the owning boundary's structural completion, rather than capturing an early promise/snapshot and only resolving that later.

8. Fix the discovered aggregate materialization dependency currently hidden by `forceWrap`.
   - Async array / object literals currently pass through `runtime.createArray(...)` / `runtime.createObject(...)` and carry `RESOLVE_MARKER`.
   - The raw removal probe showed that some root value positions still depend on the wrapper turning the expression into a promise that later consumption resolves through `resolveSingle(...)`.
   - The fix should make the true consumers responsible for resolving marker-backed values, rather than depending on an outer expression wrapper.
   - Regression probes:
     - direct output of arrays / objects with async elements
     - filters such as `join`, `sort`, `sum`
     - ordinary function arguments receiving arrays / objects with async elements

9. Fix value-dependent plain expression side effects that are currently observed too early.
   - Repro shape: `out.push(caller(item))` in a macro, followed by `return out`.
   - The returned value depends on those `push(...)` effects, so this is not fire-and-forget work.
   - The fix should not add a generic waiter channel. Instead, the expression/call path must make the returned value structurally depend on completion of the side effect that contributes to that value.

10. Remove command-argument staging only after the real producer paths are cleaned up.
   - `normalizeCommandArgsForDeferredHandling(...)` is not semantically desirable long-term.
   - The current runtime split is:
     - true consumer commands resolve only their top-level deferred arguments at apply time
     - storage/timing commands stage deferred values without consuming them
   - Before deleting the remaining staging, audit which storage/timing commands still receive raw promise/thenable args and why.

11. Verify with both ordering and boundary-timing regressions.
   - ternary / `and` / `or` with command-emitting operands
   - `caller()` inside expression output paths
   - nested caller / call-block dispatch through imported-callable async boundaries
   - any case where a deferred expression could add commands after an enclosing buffer finishes
   - updated unused-async-var tests that now observe only returned/final values
   - async `return` observing sequence-guard commit / rollback completion
   - array / object literals with async elements flowing through direct output, filters, and function arguments
