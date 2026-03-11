# Guard Lowering Plan (Template-Level, Helper-Free)

## Summary
Port `guard`/`recover`/`revert` from runtime-orchestrated JS helper flow to compiler-lowered template/script constructs:
- object-composed guard snapshots
- merged error assignment
- unconditional sequence repairs (`!!`)
- conditional restore block
- normal recover body gating

This maximizes command-buffer/dataflow concurrency and removes most `runtime.guard` orchestration complexity.
Implementation order:
1. Port `guard`/`recover` lowering first and make all tests pass.
2. Only then implement the parser-existing `revert` statement with the same lowering primitives.

## Design Goals
1. Compile guard logic into lowered language constructs, not runtime orchestration helpers.
2. Preserve/strengthen concurrency by avoiding helper-level `await` orchestration.
3. Reuse the same lowered mechanism for both end-of-guard recovery and `revert`.
4. Keep implementation migration-friendly for future transformer ownership of `usedOutputs`/`mutatedOutputs`.
5. Remove the compile-time restriction that forbids `sink.snapshot()` inside guard blocks.

## Lowered Form

### Snapshot capture (object composition)
Use object literal composition at guard entry:

```cascada
var __guard_snap_7849 = {
  var1: var1,
  channel1: channel1.snapshot(),
  channel2: channel2.snapshot()
}
```

Rules:
- `var`: capture via direct value read.
- `data/text/sink`: capture via `.snapshot()`.
- sequence path targets are not included in snapshot object.

### Error aggregation
Compile merged error assignment:

```cascada
var __guard_err_17 = _mergeErrors(
  var1#,
  channel1#,
  channel2#,
  path1.subpath1!#,
  path2!#
)
```

`none` means healthy guard state.

### Unconditional sequence repair
Emit sequence repairs after error assignment and before condition:

```cascada
path1.subpath1!!
path2!!
```

This is always emitted (not gated).

### Conditional restore
Restore only if merged error exists:

```cascada
if __guard_err_17 != none
  var1 = __guard_snap_7849.var1
  command channel1.__restore_guard_state(__guard_snap_7849.channel1)
  command channel2.__restore_guard_state(__guard_snap_7849.channel2)
endif
```

Restore mapping:
- `var`: assignment
- `data/text/sink`: internal restore command call
- sequence paths: repaired by `!!`, not snapshot-restored

## `revert` Lowering
`revert` inside guard is unconditional restore and lowers to:
1. unconditional sequence repairs (`!!`)
2. unconditional restore block (no `_mergeErrors`, no condition)

Execution continues after this block.

## End-of-Guard `recover` Lowering
At guard end compile:
1. merged error assignment
2. unconditional sequence repairs
3. conditional restore + recovery body

With `recover err`, bind `err` to merged error object (`__guard_err_*`).

## Compiler Implementation Map

### Parser / AST (no syntax redesign)
- `Revert` node already exists.
- No parser syntax change required.

### Compiler (`src/compiler/compiler.js`)
- Implement `compileRevert(node, frame)` using synthetic lowered node generation.
- Refactor `compileGuard` to produce lowered blocks instead of helper-driven `runtime.guard.finalizeGuard(...)`.
- Add synthetic-node builders:
  - guard snapshot object declaration
  - merged error assignment
  - unconditional sequence repair statements
  - conditional restore `if` block
  - optional recover err binding

Recommended internal methods:
- `_buildGuardSnapshotInitNode(...)`
- `_buildGuardMergedErrorNode(...)`
- `_buildGuardSequenceRepairNodes(...)`
- `_buildGuardConditionalRestoreNode(...)`
- `_buildGuardRecoverLoweredNodes(...)`

Target-list derivation must reuse a helper that resolves guard selectors against tracked mutations/usage.
The same helper should generate concrete target lists for:
- snapshot capture
- merged error expression inputs
- unconditional sequence repairs
- restore block targets

### Buffer/command emission (`src/compiler/compile-buffer.js`)
- Reuse existing command emissions where possible (`emitAddSnapshot`, restore command emission path).
- Prefer synthetic `command` AST lowering over new emission APIs where possible.
- Ensure internal restore command emission is available to lowered guard/revert blocks.

### Validation (`src/compiler/validation.js`)
- Enforce: `revert` only valid inside guard scope.
- Keep existing guard selector validations.
- Remove the sink guard snapshot ban (`sink snapshot() is not allowed inside guard blocks`).

### Runtime impact
- Keep primitive command behavior and output-specific `_restoreGuardState`.
- Remove or drastically reduce runtime guard orchestration dependency (finalization helpers become optional/minimal).
- `_mergeErrors(...)` remains available as a global function used by lowered code.
- Assumption: unconditional sequence repair (`!!`) does not fail in normal operation.

## Type-Specific Semantics
- `var`: read snapshot at entry, assignment restore.
- `data`: snapshot at entry, restore via internal restore command.
- `text`: snapshot at entry, restore via internal restore command.
- `sink`: snapshot at entry, restore via internal restore command (delegates to sink recover behavior).
- sequence path locks: health repair via unconditional `!!`.
- `sequence` outputs: handled as other outputs (captured/restored through the same lowered snapshot/restore mechanism as applicable to output state).

### Sink Snapshot Policy in Guard
- Planned change: allow user `sink.snapshot()` inside guard blocks.
- Semantics: this is observational (tentative state read), not rollback-stable.
- Guard rollback/revert behavior remains unchanged: sink restoration still relies on sink `recover(snapshotAtGuardEntry)` when available.

## Mutation Tracking
When a guard contains revert/restore path, mark potential mutations as:

`guardedTargets ∩ mutatedOutputsInsideGuard`

Integrate with existing `mutatedOutputs` propagation to keep async wrapping/timing decisions correct.

## Tests to Add/Update

1. Guard success: no restore occurs.
2. Guard failure: restore vars/channels and execute recover.
3. Revert inside guard restores and continues execution.
4. Nested guards: inner revert/recover restores only nearest enclosing guard state (never outer guard state).
5. Unconditional sequence repairs are emitted and run regardless of guard condition.
6. `recover err` receives merged `_mergeErrors(...)` value.
7. Shadowing regression: injected tmpids never collide.
8. Mutation-tracking regression for `guarded ∩ mutated` behavior.

## Migration Notes
- Do this in compiler now (not transpiler), because guard lowering depends on compiler-time `usedOutputs`/`mutatedOutputs`.
- Add comments in lowering code that this logic is designed to move into transformer once analysis ownership is moved there.

## Simplifications and Dead Code Removal

### Compiler simplifications
- Remove guard runtime orchestration emission from `compileGuard` (`runtime.guard.init*`, `runtime.guard.finalizeGuard`, runtime guard repair plumbing).
- Lower `guard`/`recover`/`revert` entirely as synthetic nodes (snapshot object, merged error assignment for recover, unconditional sequence repairs, restore block).
- Replace ad-hoc guard target derivations with one selector-resolution helper reused by all lowered guard pieces.
- Simplify `recover err` binding to use lowered merged error tmpid directly.

### Runtime cleanup (after guard lowering is green)
- Remove most/all of `src/runtime/guard.js` once compiler no longer depends on it.
- If sequence-output transactions are no longer used in guard, remove legacy transaction-only guard paths accordingly.
- Remove sink snapshot guard ban validation path (`validateSinkSnapshotInGuard`) and related compile-time error plumbing.
- Remove dead capture/restore helpers that are no longer referenced by lowered guard flow.

### Important caveats before deletion
- Keep non-`var` restore capability (`data/text/sink`) available through internal restore command path.
- Sequence output behavior must be explicitly updated in tests/docs when switching from transaction-style guard handling to lowered restore handling.
- Do not remove mutation tracking; keep `guardedTargets ∩ mutatedOutputsInsideGuard` propagation.

## Implementation Readiness Checklist
- Guard target selector-resolution helper is defined and reused (snapshot/error/repair/restore targets).
- Lowered guard path compiles in both script and template modes.
- `recover err` payload uses lowered `_mergeErrors(...)` result.
- Sequence repairs are emitted unconditionally in lowered output.
- Sink snapshots in guard compile and run (no rejection).
- All guard/recover tests pass after guard lowering.
- Only then implement parser-existing `revert` lowering and make revert tests pass.
