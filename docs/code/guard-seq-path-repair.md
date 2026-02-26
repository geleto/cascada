# Guard + Sequential Path Repair (`!path`) - Current Limitation

## Summary

In value-mode sequential paths (`SEQUNTIAL_PATHS_USE_VALUE=true`), guard blocks currently have a known ordering issue:

- unconditional sequence repair is enqueued and executed early,
- but post-guard `!path` calls can still execute only after the guard finishes waiting for child closures,
- so a slow non-sequence promise inside the guard can delay post-guard sequence calls.

This is tracked by the skipped test:

- `tests/poison/guard.js`
- `it.skip('sequence lock shall not wait on guarded var', ...)`

## Scenario

Example:

```cascada
var slowVar
guard lock!, slowVar
  lock!.op()
  slowVar = getSlow()   // slow promise
endguard
result.status = lock!.success()
```

Expected intent:

- `lock!.success()` should be able to continue after unconditional sequence repair, without waiting for `slowVar`.

Current behavior:

- `lock!.success()` runs after `getSlow()` resolves.

## Observed Timeline

High-level runtime order (instrumented):

1. `guard.repairSequenceOutputs(...)` called.
2. repair command (`RepairWriteCommand`) enqueued + executed.
3. `lock!.op()` command runs.
4. `getSlow()` starts.
5. guard executes `await astate.waitAllClosures(1)`.
6. guard resumes only after `getSlow()` resolves.
7. `finalizeGuard(...)` runs.
8. post-guard `lock!.success()` runs (now too late for this expectation).

## Why Legacy Did Not Show This

Legacy sequence locks use frame lock variables (`frame.set` + lock promises). Repair updates lock state directly in frame space, so later sequence operations are less coupled to command-buffer/iterator progression.

Value-mode sequential paths use `SequentialPathOutput` + command buffers. Ordering is controlled by command-tree execution, so guard-level closure waiting impacts when later `!path` commands are actually applied.

## Current Fix Attempt (Implemented)

The simple fix was implemented:

- use unconditional repair in `repairSequenceOutputs(...)` via `addSequentialPathWrite(..., repair=true)`,
- enqueue repair before guard error state is known.

This is correct but not sufficient to satisfy the skipped test because guard still waits for child closures before completion.

## Why This May Be Resolved Later

The engine is migrating away from legacy var/write-count/wait patterns. When old var-based flow is removed and guard synchronization no longer depends on `waitAllClosures` in this way, this specific coupling can disappear.

In that future architecture:

- sequence-path continuity should be governed entirely by sequential path commands/outputs,
- non-sequence slow closures should not unnecessarily gate unrelated post-guard `!path` progress.

## Important Constraint

Any eventual fix must preserve command-tree guarantees:

- commands must stay in correct source order,
- no writes/declarations to non-current buffers as a shortcut,
- no bypass of finalize/link semantics.

Do not introduce direct state writes that break buffer hierarchy or temporal sequential equivalence.
