# Loop Value Path Finish (Template-Var-Only)

## Goal

Finish the remaining template-side migration from var/frame symbol reads to value-output reads, without changing script semantics.

This is specifically about the paths still relying on template var visibility across boundaries (loop/block/include/caller-like out-of-line execution).

## What Is Already Done

1. Parent buffer propagation for out-of-line block execution paths.
- Non-root async entry functions accept parent buffer and initialize managed buffer with it.
- Block/super async calls pass compiler `currentBuffer`.
- Context `getSuper` forwards parent buffer.

2. Template symbol routing can use value path when enabled.
- In async template mode with `CONVERT_TEMPLATE_VAR_TO_VALUE`, symbol reads can compile to `runtime.contextOrValueLookup(...)`.
- Guarded so known var-declared symbols keep frame lookup (macro args, caller, etc.).

3. Runtime value lookup fallback model is stabilized.
- Value lookup checks lexical output visibility and snapshots only when output-backed.
- Otherwise falls back to context lookup (no frame fallback in value-lookup helper itself).

## Important Constraints

1. Preserve command-tree ordering.
- No writes/reads to foreign or synthetic buffers.
- Snapshot/commands must be inserted on the correct active `currentBuffer`.

2. Do not reintroduce runtime hacks.
- No `finalSnapshot()` lookup workaround in symbol lookup path.
- No bypass of buffer linking/finalize lifecycle.

3. Keep script behavior unchanged.
- This plan is template-var-only.

## Remaining Work

## Exact Port Scope

The following template-side behaviors must be ported from var/frame visibility to value-output visibility:

1. Loop boundary symbol visibility
- Out-of-line reads of loop item vars/loop metadata inside block/caller/include-like paths must resolve as value snapshots, not frame var bridges.

2. Block boundary reads (beyond current parent-buffer fix)
- Any symbol currently relying on frame var visibility when it should be output-backed under `CONVERT_TEMPLATE_VAR_TO_VALUE` must be switched to value lookup.

3. Caller/call boundary reads
- `caller` itself remains var-based.
- Captured symbols from outer template scope that are output-backed must resolve via value snapshots in caller body.

4. Include/import boundary symbol reads
- Imported macro bodies and include-rendered bodies must read output-backed names via value path when enabled, not legacy frame-set bridges.

5. Super/extends boundary symbol reads
- Super/block override execution must use value-backed lookup for output-backed names across inheritance boundaries.

6. Legacy template loop var bridges removal
- Remove remaining template-only `frame.set(...)` compatibility writes that only exist to preserve legacy loop/item visibility, once equivalent value visibility is in place.

7. Symbol codegen final tightening
- Keep one rule in async template mode:
  - output-backed and not var-declared -> value lookup
  - otherwise -> frame/context lookup

8. Boundary-specific tests
- Ensure explicit coverage for value-path behavior in:
  - loop + block
  - loop + include
  - loop + caller
  - import/include + macro with async args
  - super/extends with output-backed symbol reads

## Step 1: Boundary Inventory (Template Only)

Identify every template boundary where symbol reads can happen out-of-line from declaration site:
- block invocation
- super invocation
- include/import macro calls
- caller/call blocks
- loop body nested block/caller paths

For each, determine whether symbols are currently read as:
- output snapshots (good), or
- frame/context vars (legacy compatibility path).

Acceptance:
- A short checked list of all remaining var-backed template boundary reads.

## Step 2: Loop Boundary Conversion

Focus on loop variables and loop metadata access across out-of-line template boundaries.

Target behavior:
- when `CONVERT_TEMPLATE_VAR_TO_VALUE` is true, loop-visible symbols used by out-of-line bodies should resolve via output snapshot path (not frame var bridge), except truly var-declared runtime locals.

Acceptance:
- loop-in-block/include/caller template cases read correct values without template var bridge reliance.
- no regressions in async loop ordering/poison semantics.

## Step 3: Remove Remaining Template Var Bridges (One by One)

For each remaining boundary from Step 1:
- switch from var visibility dependency to value visibility dependency,
- keep lexical correctness checks (declared var stays var),
- keep command insertion on compiler/current buffer.

Acceptance:
- targeted suite for that boundary passes,
- no new finished-buffer/deadlock regressions.

## Step 4: Tighten Compiler Symbol Rule

After boundaries are converted:
- keep template symbol rule strict:
  - if output-backed and not var-declared -> value lookup
  - else -> frame/context lookup

Re-evaluate whether any temporary compatibility condition can be removed.

Acceptance:
- no template path still requiring legacy var bridge for output-backed names.

## Step 5: Cleanup

- Remove dead compatibility code/comments introduced during transition.
- Keep tests that specifically lock boundary behavior (loop+block/include/caller).

## Test Strategy

Run after each step:
1. focused boundary suite(s) first
2. `npm run test:quick`

Regression classes to watch:
- timeout/hang (missing links / waiting on unfilled slots)
- finished buffer errors (late addBuffer/addCommand)
- empty substitutions where values should resolve
- caller/macro argument lookup regressions

## Current Status Marker

- Parent-buffer plumbing: done.
- Template value lookup routing: done with var guard.
- Remaining template boundary migration: pending.
