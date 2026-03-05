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

## Remaining Tasks (In Execution Order)

### 1) Finish `#3`: macro publication fully value-aligned under flags

Goal: when conversion flags are on, macro publication should not depend on `context.setVariable(...)`.

Current location:
- [`src/compiler/compiler.js`](../../src/compiler/compiler.js) (`compileMacro`)

Work:
- Guard/remove remaining `context.setVariable(...)` macro publication branches under value-conversion conditions.
- Keep flag-off behavior unchanged.
- Verify top-level export visibility and macro call semantics remain correct.

### 2) Remove `__parentTemplate` read dependency on frame lookup in value mode

Goal: dynamic extends parent resolution in value mode should use value/context path, not frame fallback.

Current locations:
- [`src/compiler/compiler.js`](../../src/compiler/compiler.js) (`compileRoot` final parent resolution)
- [`src/compiler/compile-inheritance.js`](../../src/compiler/compile-inheritance.js) (`compileBlock` parent check)

Work:
- Under template value-conversion mode, avoid `contextOrFrameOrValueLookup(...)` / `contextOrFrameLookup(...)` for `__parentTemplate`.
- Use value-aware read path consistent with `setval` storage.
- Keep flag-off compatibility branch.

### 3) Complete boundary-driven linking coverage; keep lookup linking optional only

Goal: structural linking at boundaries should be sufficient; lookup-time dynamic linking remains an optional mode, not required for correctness.

Current locations:
- Include prelink: [`src/compiler/compile-inheritance.js`](../../src/compiler/compile-inheritance.js)
- Block prelink emission: [`src/compiler/compiler.js`](../../src/compiler/compiler.js)
- Optional runtime fallback: [`src/runtime/lookup.js`](../../src/runtime/lookup.js)

Work:
- Ensure all required handler lanes (including canonical aliases like `x#N`) are linked by boundary logic.
- Keep `LOOKUP_DYNAMIC_OUTPUT_LINKING=false` as default correctness path.
- Any failing cases with fallback off must be fixed structurally (usedOutputs/alias projection/boundary link), not by reintroducing mandatory lookup linking.

### 4) Identify and retire old var-style async sync for value dataflow paths

Goal: value dataflow should rely on command-chain ordering, not var write-count/promisification mechanics.

Primary old-mechanism locations:
- compiler-side write metadata propagation: [`src/compiler/compile-async.js`](../../src/compiler/compile-async.js)
- runtime async var locking/countdown: [`src/runtime/frame.js`](../../src/runtime/frame.js)
- async block orchestration contract: [`src/runtime/async-state.js`](../../src/runtime/async-state.js)

Work:
- Audit each remaining use of `writeCounts`, `pushAsyncBlock(...writeCounts...)`, and parent-var promisification.
- Separate frame-local control variable needs from value dataflow needs.
- Remove/guard old var-sync paths where they are no longer needed for value flows.

## Explicit Non-Goals

- Removing parser/runtime compatibility for `var` syntax.
- Removing all frame lookups globally (frame locals remain for control/runtime internals).
- Enabling lookup-time dynamic linking by default.

## Completion Criteria

1. With flags enabled, value dataflow no longer relies on var-style async write locking/countdown.
2. `LOOKUP_DYNAMIC_OUTPUT_LINKING=false` passes `npm run test:quick` without hangs/regressions.
3. Macro publication and dynamic extends parent resolution are value-aligned under flags.
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
