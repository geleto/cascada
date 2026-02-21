# Output Scoping And Buffer Access Plan

## Architectural Primer: Ordering Before Local Fixes
Cascada runs many operations concurrently, but output-visible effects must remain equivalent to a correct sequential run. That is enforced by the command-tree structure:
- async regions emit ordered command segments,
- nested regions attach as child segments,
- execution applies commands deterministically in source order, waiting for unfinished slots.

This is the core temporal sequential equivalence contract. Any fix that bypasses this contract can create regressions that look unrelated (timeouts, missing snapshots, duplicate text, wrong poison propagation).

Because of that, do not “patch around” a single failure by circumventing buffer ownership, stream linking, or finalize timing. Fixes must preserve:
1. correct command insertion point,
2. correct parent/child buffer hierarchy,
3. correct link/finalize lifecycle.

## Purpose
Fix output scoping and async buffer access bugs introduced by `var -> value` conversion, without mixing concerns across compiler/runtime layers.

This document is intentionally strict and explicit. Missing small details in this area can cause deadlocks/timeouts and hard-to-trace cross-scope contamination.

## Scope
This plan targets script-mode output-backed variables and output commands.
Template text capture (`{% set %}...{% endset %}`) must remain behaviorally unchanged and is a hard regression gate.

## Current Problem Profile
- Remaining script/call/capture timeout regressions still exist, but branch-local `if` minimal repro is fixed under the `currentBuffer` model.
- Root cause class: producer/observer commands for the same logical output can land on different command streams/buffers.
- Secondary issue class: same-name output declarations in sibling/nested scopes can collide in one async block stream.

## Non-Negotiable Invariants
1. Frames and buffers
- Not every frame owns a `CommandBuffer`.
- Many nested lexical frames can execute in one async block and use one effective command stream.
- The active stream is the compiler/runtime `currentBuffer` binding threaded through async closures.
- Output declaration must target the same active `currentBuffer` used for command emission/observation in that region.

2. Buffer creation sites
- New `CommandBuffer` roots are allowed at:
  - root render entry,
  - async block roots that actually use output commands (`usesOutputs`).
- Nested non-async scope frames (`if/for/switch` lexical pushes) must not implicitly create detached buffers.
- Buffer linking/execution must not depend on compiler `usedExternalOutputs`; command arrays are slot-reserved lazily at runtime.

3. Observations
- `snapshot()`, `isError()`, `getError()` are observation commands.
- Observation commands must not contribute to poison/mutation candidate sets.

4. Scope ownership
- Output lexical scoping is compiler-owned.
- Runtime executes already-resolved handler keys; runtime must not infer lexical ownership rules.

5. Declaration inference source
- Script declarations are explicit (`var`/`value`).
- Template declaration-vs-assignment (`set`/`setval`) is compiler-resolved policy.
- Transformer may consume resolved declaration metadata, but must not re-invent async-block ownership.

## Output Sets We Need
Two different sets are required. Do not merge them.

### `potentiallyPoisonedParentOutputs`
- Scope: `guard` only.
- Meaning: parent-scope outputs that can be poisoned by non-observation commands executed inside guard-controlled flows.
- Used for guard poison/revert behavior.

### `writesParentOutputCandidates`
- Scope: conditional/iterator control nodes (`if`, `switch`, `for`, `while`; include others only if they have equivalent poison-on-control-failure semantics).
- Meaning: parent-scope outputs that any branch/iteration could write via non-observation commands.
- Used when condition/iterator is poisoned or fails, to conservatively poison all potentially affected outputs.

## Where Each Concern Lives

### Transformer
Belongs here:
- Alias/renaming pass for declaration collision avoidance (last phase, after buffer/scoping fixes).
- Guard/conditional output candidate set collection from AST shape:
  - `potentiallyPoisonedParentOutputs` (guard nodes),
  - `writesParentOutputCandidates` (conditional/loop nodes).
- Exclude observation commands from both sets.
- Keep metadata attach-only; no runtime-specific buffer wiring in transformer.

Must not depend on async block emission ownership details.
Must produce deterministic output for a given AST.

### Compiler
Belongs here:
- Async block ownership and `usesOutputs` decisions (compiler knows which nodes emit async blocks).
- Passing transformed metadata through emitted code paths.
- Mapping diagnostics from alias keys back to user names.

### Runtime
Belongs here:
- Pure command stream execution/ordering.
- No lexical-scoping decisions.
- No declaration-vs-assignment policy.

## Naming Decisions
- Keep `usesOutputs` as the primary compiler/runtime metadata flag.
- `needsBuffer` is derived/internal only (if used at all).
- For aliasing, prefer readable suffix style (e.g. `someVar#2`) over `~`.
- Alias is internal for execution; diagnostics should present source names (optionally include alias in debug detail).
- Buffer binding naming:
  - Canonical execution handle: `currentBuffer`.
  - Runtime declaration API takes explicit buffer argument (`declareOutput(frame, currentBuffer, ...)`).

## Critical Constraints
1. Guard collection rules
- Collect only parent outputs touched by non-observation commands.
- For nested guards:
  - do not accidentally include inner-guard main flow when outer guard semantics should not claim it,
  - include nested recover paths where poison/recovery effects can propagate.

2. Conditional/loop collection rules
- Conservatively include writes from all branches/iterations.
- This set is for poison-on-control-failure semantics, not guard rollback semantics.

3. Buffer stream integrity
- Within one async block, all relevant commands for the same logical output must be visible to the same linked command stream.
- Detached child streams must be linked correctly if used; otherwise they can stall snapshots.
- Do not globally reuse parent text buffers to fix script deadlocks; this can break template set-block text capture.

4. Dynamic target policy
- For output commands where the target cannot be statically resolved to a symbol, fail compilation in strict script mode.
- If a relaxed mode is later added, it must conservatively include unresolved targets in poisoning candidate sets and be explicitly tested.

## Implementation Plan (Testable, Ordered)

## Phase 0: Lock Repro Cases
Goal: freeze minimal failing behavior before fixes.

Tests (short timeout, 1-3s):
1. Minimal timeout repro in `tests/pasync/script.js` (branch-local scoped value assigned into outer result path).
2. Keep branch/switch scope tests in `tests/pasync/script.js` enabled, except alias-dependent same-name declaration collision cases.
3. Temporarily `.skip()` alias-dependent same-name branch/collision tests in `tests/pasync/script.js`; re-enable in Phase 4 (renaming/aliasing).
4. Keep out-of-scope access/failure tests enabled in `tests/pasync/script.js` (must still fail deterministically).
5. Set-block sanity checks in `tests/pasync/setblock.js` (prevent regressions while fixing buffers).

Acceptance:
- Repros fail consistently before fix.
- Temporary skips are limited to alias-dependent tests only.
- Non-target tests remain unchanged.

## Phase 0.5: Mechanical Buffer Binding Cleanup (No Behavior Change)
Goal: improve clarity before behavior fixes by removing stale frame-buffer assumptions.

Work:
1. Make `currentBuffer` the canonical active buffer handle in emitted async closures.
2. Ensure `declareOutput` and output command emission use the same explicit buffer variable in each region.
3. Remove/avoid fallback logic that infers active buffer from frame-chain lookup.
4. Do not change buffer ownership/linking/snapshot behavior in this phase.

Acceptance:
1. Focused suites remain behaviorally identical:
   - `tests/pasync/script.js`
   - `tests/pasync/setblock.js`
   - `tests/pasync/calls.js`
2. No new timeouts or ordering regressions introduced by rename-only changes.

## Phase 1: Fix CommandBuffer Access From Child Frames (FIRST)
Goal: ensure child lexical frames inside one async block always have valid effective buffer access and stream visibility.

Work:
1. Audit runtime/emit paths where async child frames get/lose effective command buffer reference.
2. Ensure nested lexical frames and nested async closures use the inherited `currentBuffer` unless a new child buffer is intentionally created.
3. Ensure detached async child buffer paths are linked only when intended, and linked early enough for observations.
4. Do not alter renaming/declaration aliasing in this phase.
5. Keep runtime lexical output lookup behavior (`frame._outputs` + parent chain) unchanged in this phase.

Acceptance tests:
1. Minimal timeout repro passes (no timeout).
2. Branch/switch scope timeout tests pass (with alias-dependent tests still skipped).
3. Set-block tests still pass (no duplication/no text capture regressions).
4. Existing caller/call tests still pass.

## Phase 2: Add Transformer Output Candidate Sets
Goal: precompute poison-related parent-output sets in transformer.

Work:
1. Add `potentiallyPoisonedParentOutputs` to guard nodes.
2. Add `writesParentOutputCandidates` to conditional/loop nodes.
3. Exclude observation commands from both.
4. Keep this conservative and parent-scope-only.
5. Do not include template-only text-capture internals in these sets.

Acceptance tests:
1. Guard poison/recover suites pass.
2. Conditional/loop poison suites pass.
3. No behavior drift in non-poison output tests.

## Phase 3: Compiler Wiring For Sets + `usesOutputs`
Goal: consume transformer metadata in compiler emission and maintain clean runtime inputs.

Work:
1. Keep `usesOutputs` at compiler async-block ownership points.
2. Use transformer-provided sets for guard/conditional poisoning decisions.
3. Avoid re-deriving these sets ad hoc during emission.

Acceptance tests:
1. Guard output poisoning/recovery tests pass.
2. Conditional/loop poison tests pass.
3. No new timeouts in script/template async suites.

## Phase 4: Variable/Output Renaming (LAST)
Goal: eliminate same-name declaration collisions across child scopes sharing command streams.

Work:
1. Transformer pass assigns deterministic declaration aliases (e.g. `name#2`) on duplicate declarations by scope occurrence.
2. Rewrite references to aliases in AST where appropriate.
3. Keep source-name mapping for diagnostics.
4. Ensure reserved-name and declaration/assignment rules still apply pre/post aliasing.

Acceptance tests:
1. Same-name sibling/branch declaration tests pass.
2. No collisions in branch/switch/capture/call cases.
3. Error messages remain user-friendly (source names), with optional alias debug detail.

## Phase 5: Cleanup and Hardening
Goal: remove temporary probes and validate stability.

Work:
1. Remove temporary instrumentation and one-off debug tests.
2. Keep one minimal non-regression test for the original timeout scenario.
3. Run focused suites with short timeouts first, then broader quick suite.

Acceptance:
- Original timeout class fixed.
- No reintroduced setblock regressions.
- No guard/conditional poison regressions.

## Suggested Focused Test Matrix
Use short timeouts (1-3s for isolated tests, 3-5s for grouped files).

1. `tests/pasync/script.js`
- branch/switch scope tests (including minimal timeout repro).

2. `tests/pasync/setblock.js`
- basic, multiple, nested async set-block tests.

3. `tests/pasync/calls.js`
- caller scope read/write + observation behaviors.

4. Guard/poison files (focused grep)
- guard poisoning/recovering on outputs and condition failure paths.

## Node-Level Collection Rules (Normative)

### A) `potentiallyPoisonedParentOutputs` (Guard Only)

| Node/Region | Include writes? | Include observations? | Notes |
|---|---:|---:|---|
| Guard main body | Yes (parent outputs only) | No | Non-observation commands only |
| Guard recover body | Yes (parent outputs only) | No | Recover can affect poison outcome |
| Nested guard main body | No (for outer guard set) | No | Nested guard owns its own set |
| Nested guard recover body | Yes (if semantically in outer guard effect path) | No | Conservative include to avoid missed poisoning |
| Pure expression/read nodes | No | No | Reads never enter poison-write set |
| `snapshot/isError/getError` calls | No | No | Explicitly excluded |

Parent-scope-only rule:
- Include output only if declaration frame is outside the current guard lexical declaration scope.
- Locals declared inside guard are excluded.

### B) `writesParentOutputCandidates` (Conditionals / Loops)

| Control Node | Include from | Exclude | Notes |
|---|---|---|---|
| `if` | all branches (`if` + `else/elif`) | observations | Conservative union |
| `switch` | all `case` + `default` | observations | Conservative union |
| `for`/`while`/iterators | loop body | observations | Used when iterator/condition is poisoned/fails |
| Nested control inside these | recursively include | observations | Conservative propagation |
| Guard nodes encountered | include normal branch writes, keep guard set separate | observations | Guard has dedicated recover/revert semantics |

Parent-scope-only rule:
- Same as guard set: only outputs declared outside current control node's local declaration scope.

### C) Observation Classification
Observation commands are exactly:
- `snapshot()`
- `isError()`
- `getError()`

Everything else targeting an output handler is treated as write-capable for poisoning analysis.

## Traversal Algorithm (Deterministic)
Use deterministic pre-order AST walk with scoped declaration stacks.

State per traversal:
1. `declaredOutputStack`: lexical scopes with declared output names.
2. `currentControlOwner`: active node being annotated (`Guard`, `If`, `Switch`, loop).
3. `nestedGuardDepth`: enforces nested-guard include/exclude rules.

Algorithm sketch:
1. Enter node:
- push declaration scope when node introduces lexical scope.
- register declarations immediately in top scope.
2. On output command node:
- classify observation vs non-observation.
- resolve declaration owner (nearest scope where output was declared).
- if non-observation and owner is outside current owner-local scope:
  - add to owner set (`potentiallyPoisonedParentOutputs` or `writesParentOutputCandidates`).
3. Guard special handling:
- outer guard collector ignores nested guard main body writes.
- outer guard collector can include nested guard recover writes conservatively.
4. Exit node:
- pop declaration scope when leaving lexical scope.

## Scope and Ownership Resolution Rules
1. Declaration owner:
- nearest lexical declaration in scope stack wins.
2. Parent output determination:
- declaration owner scope depth < current owner-local scope base depth.
3. Unknown output target:
- in script mode: fail compilation (preferred, deterministic, safer).
- use conservative inclusion only where unresolved static targets are explicitly supported.

4. Template declaration inference:
- `set`/`setval` ownership is determined by compiler declaration analysis.
- Transformer set-collection and aliasing passes consume that resolved ownership, not raw token shape.

## Compiler Consumption Contract
Transformer emits:
1. `node.potentiallyPoisonedParentOutputs` on `Guard` nodes.
2. `node.writesParentOutputCandidates` on conditional/loop nodes.
3. Stable declaration aliases when renaming phase is enabled.

Compiler guarantees:
1. Uses these sets directly for poisoning decisions.
2. Does not re-derive conflicting sets ad hoc.
3. Keeps `usesOutputs` as async-block metadata (separate concern).
4. Preserves existing template set-block behavior (no duplicated text fragments).

## Edge Cases Checklist
Before merging, validate each explicitly:
1. Parent output written in `if` true branch only.
2. Parent output written in `else` only.
3. Parent output written in both branches with different declaration aliases.
4. Local output written in branch; same name exists in parent.
5. Observation-only calls in branches (must not enter sets).
6. Nested guard in `if` branch with recover writing parent output.
7. Guard with only local outputs (set should be empty).
8. Loop with poisoned iterator before first iteration.
9. While condition poisoned before body.
10. Switch expression poisoned before any case.
11. Template `{% set %}...{% endset %}` async capture remains exactly-once and ordered.
12. Script branch-local timeout repro no longer hangs at 1-3s timeout.

## Risks To Watch
1. Fixing branch timeouts can break setblock capture text ordering.
2. Broad buffer sharing can duplicate or reorder text outputs.
3. Alias pass can accidentally rename symbols in contexts that are not output handlers.
4. Guard set over-collection can poison outputs that should remain local/non-revertable.

## Summary
- First priority is command buffer accessibility/stream integrity for child frames in async blocks.
- Keep poison candidate sets explicit and separate:
  - `potentiallyPoisonedParentOutputs` (guard),
  - `writesParentOutputCandidates` (conditionals/loops).
- Keep async-block ownership (`usesOutputs`) in compiler.
- Do renaming last, in transformer, with deterministic aliases and source-name diagnostics.

## Appendix: Do/Don't Scenarios

### Scenario 1: Guard Nesting
Input shape:
- Outer `guard` contains:
  - normal body write to parent output `result`
  - nested `guard` with main-body write to `result`
  - nested `guard recover` write to `result`

Do:
- Outer `potentiallyPoisonedParentOutputs` includes:
  - outer guard body write(s),
  - nested guard `recover` write(s) conservatively.
- Inner guard computes its own independent `potentiallyPoisonedParentOutputs`.

Don't:
- Do not blindly merge nested guard main-body writes into outer guard set.

### Scenario 2: Branch Union For Poison-On-Control-Failure
Input shape:
- `if cond`:
  - true branch writes parent output `a`
  - false branch writes parent output `b`

Do:
- `writesParentOutputCandidates = {a, b}` for the `if` node.
- If `cond` is poisoned/fails, poison both candidates conservatively.

Don't:
- Do not include observation-only calls (`a.snapshot()`, `b.isError()`) in candidates.

### Scenario 3: Alias Collision Across Sibling Scopes
Input shape:
- branch 1: `var scopedValue = ...`
- branch 2: `var scopedValue = ...`
- both mapped to output-backed declarations in the same async command stream.

Do:
- Assign deterministic aliases in transformer, e.g.:
  - branch 1 declaration: `scopedValue#1`
  - branch 2 declaration: `scopedValue#2`
- Rewrite all references in each branch to the matching alias.
- Keep diagnostics user-facing by source name (`scopedValue`), with optional alias debug detail.

Don't:
- Do not emit both declarations as the same handler key.
- Do not defer collision handling to runtime; resolve in transformer/compiler pipeline.
