# Var To Value Transition: Remaining Work

This document tracks only what is still pending for the final model:

- value outputs + command buffers are the temporal consistency mechanism,
- old var-style async write synchronization is not used for value dataflow paths.

`var` syntax support remains for compatibility. Frame-local control variables remain allowed (macro args, loop metadata, internal temps).

## Current Baseline

With flags enabled in [`src/feature-flags.js`](../../src/feature-flags.js):

- `CONVERT_TEMPLATE_VAR_TO_VALUE`
- `CONVERT_SCRIPT_VAR_TO_VALUE`
- `LOOP_VARS_USE_VALUE`
- `SEQUNTIAL_PATHS_USE_VALUE`
- `VALUE_IMPORT_BINDINGS`
- `INCLUDE_PRELINK_OUTPUTS`
- `INHERITANCE_CONTEXT_ONLY_LOOKUP`
- `LOOKUP_DYNAMIC_OUTPUT_LINKING` (default `false`, optional dynamic fallback)

already-completed conversion areas are considered stable unless regressions appear.

### Audit Findings

Old var-sync is still actively used in these subsystems:

- Compiler metadata producers:
  - `updateFrameWrites` / `updateFrameReads` in [`src/compiler/compile-async.js`](../../src/compiler/compile-async.js)
  - control-flow write accounting (`if`/`switch`/`guard`/loop) in [`src/compiler/compiler.js`](../../src/compiler/compiler.js), [`src/compiler/compiler-base.js`](../../src/compiler/compiler-base.js), [`src/compiler/compile-loop.js`](../../src/compiler/compile-loop.js)
  - async block arg emission (`readArgs`/`writeArgs`) in [`src/compiler/compile-emit.js`](../../src/compiler/compile-emit.js)
- Runtime consumers:
  - async frame synchronization (`pushAsyncBlock`, parent promisification/countdown) in [`src/runtime/frame.js`](../../src/runtime/frame.js)
  - async block orchestration contract in [`src/runtime/async-state.js`](../../src/runtime/async-state.js)
  - branch skip/poison propagation in [`src/runtime/frame.js`](../../src/runtime/frame.js), [`src/runtime/loop.js`](../../src/runtime/loop.js)

This usage is currently tied to frame-local/control behavior (and sequence lock flows), not to value-output command-chain ordering.

### Remaining Tasks

1. Split remaining var-sync usage into explicit buckets:
- Keep bucket: frame-local/control semantics + sequence lock semantics.
- Remove bucket: any remaining dataflow path that should be value-output ordered instead.

2. Shrink compiler metadata surface:
- For each producer of `writeCounts`/`readVars`, confirm it belongs to keep bucket.
- Remove producers that are no longer needed after value-output migration is complete.

3. Shrink runtime var-sync surface:
- After compiler-side pruning, remove corresponding runtime pieces that become unused (`pushAsyncBlock` write sync branches, parent promisification/countdown paths not needed by keep bucket).

4. Prepare final consolidation cut:
- Once the above pruning is done and stable, proceed with old-var removal and value->var consolidation steps below.
- Keep behavior guarded and staged until full suite parity is stable.

## Explicit Non-Goals

- Removing parser/runtime compatibility for `var` syntax.
- Removing all frame lookups globally (frame locals remain for control/runtime internals).
- Enabling lookup-time dynamic linking by default.

## Completion Criteria

1. With flags enabled, value-output dataflow does not require legacy var-sync machinery.
2. `LOOKUP_DYNAMIC_OUTPUT_LINKING=false` passes `npm run test:quick` without hangs/regressions.
3. No value-output symbol path depends on lookup-time dynamic linking for correctness.
4. Flag-off compatibility paths continue to work as designed.

## Final Consolidation Phase (Post-Transition)

After the remaining tasks above are complete and stable, perform the final cleanup:

### A) Remove old var implementation

- Remove legacy var runtime/compiler synchronization paths that are no longer required.
- Keep only frame-local control variables (runtime internals), not legacy var dataflow semantics.

### B) Rename value implementation to become canonical var implementation

- Promote current value dataflow model to the canonical internal implementation for variable semantics.
- Rename internals/APIs as needed so the system no longer has dual "var vs value" implementation language.

### C) Remove translation layers

- Remove transpiler/compiler/transformer translation logic that maps:
  - `var -> value`
  - `set -> setval`
- Delete migration-only branches and compatibility wiring that exists only for dual-path support.

### D) Remove transition flags that are no longer meaningful

- Remove conversion flags once there is only one implementation path.
- Keep only long-term behavioral flags that are intentionally supported (for example optional dynamic output linking, if still desired).

### E) Final verification

- Re-run full test suite with single-path implementation.
- Ensure generated code no longer contains migration-era translation artifacts.
