# Include Linking And Inheritance Scope Plan

## Goals

- Make value-output reads deterministic without relying on ad-hoc late linkage.
- Keep `include` fully context-capable.
- Reduce cross-scope surprises in `extends`/`super` for async mode.
- Document and stage the behavior change with flags.
- Remove symbol-path linking once root causes are fixed (no permanent workaround in symbol lookup).

## Current Architecture (Relevant Parts)

### Command buffers and handler lanes

- Each render path writes into a `CommandBuffer`.
- A single buffer can carry multiple handler lanes (for example `__text__`, `m`, `loop#3`).
- Iteration is per-handler, not global: an output iterator for lane `X` only walks entries reachable on lane `X`.

### Linking behavior

- Proactive linking:
  - Async blocks/scoped buffers are linked via compile-time `usedOutputs`.
  - This is done by emitting `parentBuffer.addBuffer(childBuffer, handler)`.
- On-demand linking:
  - `lookup.ensureReadOutputLink(...)` links current read buffer into the handler lane when a value snapshot is requested and lane reachability is missing.

### Snapshot semantics

- `addSnapshot(handler)` enqueues a `SnapshotCommand` in the current buffer on `handler` lane.
- The snapshot promise resolves only when the handler iterator reaches that command.
- If the buffer is not reachable in that handler traversal tree, snapshot may never resolve.

## Why include-time linking is desirable

`include` boundaries are explicit (`_renderForComposition`), so we can link handler lanes immediately instead of discovering missing links during symbol reads.

Benefits:

- Fewer on-demand links at runtime.
- More predictable traversal topology.
- Easier reasoning about deadlock/hang conditions.

## Proposed Behavior Changes

### 1) Include: immediate handler-lane linking

At async include boundary:

1. Render included template into `composed` buffer.
2. Compute/link relevant non-text handlers immediately from parent to `composed`.
   - Use runtime intersection:
     - parent candidate handlers (canonical runtime names)
       - source: parent frame `usedOutputs` (canonicalized)
       - plus parent declared value outputs projected into include vars
     - included available handlers from `Array.from(composed._outputs.keys())`
   - Link canonical runtime handler names.
   - Respect boundary alias projection (`_setBoundaryAliases`) so lanes like `someVar#4` are correctly targeted.
3. Keep existing text snapshot behavior for include result.

Important: `addBuffer` links the same `CommandBuffer` object per handler lane; it does not create a new buffer instance.

### 2) Extends/Super: remove parent frame-scope fallback (async mode)

- Keep shared `context` access.
- Restrict/remove parent frame fallback across inheritance block execution.
- This is a deliberate async-mode semantic difference from legacy behavior.

Rationale:

- Frame fallback across inheritance boundaries is the main source of implicit cross-scope coupling.
- It complicates output-lane ownership and ordering guarantees.

### 3) Keep on-demand linking as optional dynamic mode

Even after include prelinking, keep `ensureReadOutputLink` behind a dedicated flag (`LOOKUP_DYNAMIC_OUTPUT_LINKING`) for:

- cross-template dynamic cases not prelinked,
- experiments with more dynamic composition behavior,
- fallback mode while diagnosing usedOutputs coverage gaps.

Default behavior remains structural prelinking (flag off).

### 4) Non-ancestry read rule

- If a symbol/output read targets an output whose owning buffer is not in the current buffer ancestry, do not enqueue a local snapshot.
- Use `output.finalSnapshot()` instead.
- This applies to finished-buffer/cross-tree paths as well.

### 5) Symbol-linking removal invariant

- End state requirement:
  - symbol lookup must not perform handler-linking as a workaround.
- Temporary symbol-level linking is allowed only during migration.
- If removal causes regressions, identify root cause (missing boundary prelink, wrong handler projection, scope bug) and design a structural fix before re-adding any symbol linking.

## Step-By-Step Plan

1. Add/confirm flags
- `INCLUDE_PRELINK_OUTPUTS` (new): include boundary immediate lane linking.
- `INHERITANCE_CONTEXT_ONLY_LOOKUP` (new): async `extends/super` disallow parent frame fallback.

2. Implement include prelinking
- In async include compilation path, after `composed` is available:
  - gather parent candidate handlers (as defined above),
  - intersect with `Array.from(composed._outputs.keys())`,
  - prelink via `currentBuffer.addBuffer(composed, handler)` for each non-text handler.
  - preserve alias/canonical mapping.

3. Implement inheritance lookup restriction
- In async inheritance/block symbol resolution:
  - prefer context and declared output lookups,
  - no parent frame fallback when flag is on.

4. Preserve optional dynamic fallback + non-ancestry behavior
- Keep `ensureReadOutputLink` available behind `LOOKUP_DYNAMIC_OUTPUT_LINKING` (default off).
- Enforce non-ancestry reads to use `finalSnapshot()`.

5. Update tests
- Add targeted tests:
  - include with imported value outputs and macros (no lazy-link dependency),
  - extends/super templates that previously relied on parent frame fallback now fail or require explicit context plumbing.
  - cross-tree/finalized symbol reads resolve via `finalSnapshot()` (no hang).
- Rewrite/remove async tests that depend on removed inheritance frame behavior.

6. Document user-visible behavior
- Update `docs/cascada/template.md`:
  - async mode inheritance scope differences,
  - include still shares context,
  - recommended migration patterns.

7. Rollout
- Enable flags in CI in stages:
  - stage A: include prelink on, inheritance restriction off,
  - stage B: both on for async suites,
  - stage C: remove symbol-path linking and any deprecated fallback paths after stable period.

## Compatibility Notes

- This plan intentionally prioritizes async concurrency guarantees over strict Nunjucks parity.
- `include` remains context-oriented and should keep expected usability.
- `extends/super` will become stricter in async mode; templates relying on implicit parent frame variables must be rewritten.

## Verification Checklist

- `tests/pasync/loader.js`
- `tests/pasync/composition.js`
- `tests/pasync/template-command-buffer.js`
- `tests/pasync/error-reporting.js`
- Any dedicated inheritance/super regression suites

All must pass with:

1. only include prelink enabled
2. both include prelink and inheritance restriction enabled
3. symbol-linking removed from symbol lookup path
