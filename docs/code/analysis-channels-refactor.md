# Analysis Channels Refactor

## Purpose

This note tracks the compiler-analysis side of channel cleanup. It is separate
from [command-buffer-refactor.md](C:\Projects\cascada\docs\code\command-buffer-refactor.md),
which focuses on runtime state, local addressability, and command-buffer
invariants.

The problem to solve here is that the analysis pass already computes a filtered
upward aggregate, but the stored per-node `usedChannels` and `mutatedChannels`
values are saved before that filtering.

Today `_finalizeOutputUsage(...)` starts from direct node facts:

- `analysis.uses`
- `analysis.mutates`

It merges child aggregates into a local aggregate. Before returning that
aggregate to the parent, it already applies two important rules:

- channels declared at the current analysis node are removed from the set
  returned upward
- scope boundaries return an empty set upward

That means upward propagation mostly already follows the rule that child-owned
channels should not leak to ancestors.

The awkward part is that `analysis.usedChannels` / `analysis.mutatedChannels`
are assigned before the parent-facing filtering. Consumers that read
`node._analysis.usedChannels` or `node._analysis.mutatedChannels` therefore see
broader subtree sets, which can include names owned by nested child boundaries.

This makes `usedChannels` appear to answer more than one question:

- "Which channels are touched by this node/body?"
- "Which channels should a boundary link from its immediate parent?"

The same issue applies to `mutatedChannels`. A node/body should not claim usage
or mutation of channels owned by nested child boundaries, such as nested
set-block capture text outputs. Those channels belong to the child boundary's
own analysis facts and must not become parent-link requests for the outer
boundary.

## Target Model

### Channel Set Contracts

Keep the stored `usedChannels` as a current-owner analysis fact:

- channels touched by this node/body
- including locally declared channels when that is useful for lane setup or
  diagnostics
- excluding channels owned by nested child boundaries

Keep `mutatedChannels` aligned with the same ownership rule:

- channels mutated by this node/body
- excluding channels owned by nested child boundaries
- mutations also count as usage for link purposes, because a parent-owned
  channel that is mutated by a boundary must still be linked from the immediate
  parent

Add a derived boundary-link fact, computed by analysis:

- channels this boundary uses or mutates but does not own locally
- channels that must be imported/linked from the immediate parent
- no nested child-boundary-owned channels
- stored only on boundary nodes that need runtime parent linking

Analysis should mark those nodes explicitly with a child-buffer/linking fact
such as `createsLinkedChildBuffer`. Do not infer this from node type names, and
do not reuse `createScope` or `scopeBoundary`:

- `createScope` is lexical compiler scope, not command-buffer creation.
- `scopeBoundary` controls analysis propagation/visibility, not linking.
- emitter-local arguments such as `createScopeRootBuffer` describe a specific
  codegen helper, not the general boundary-link analysis contract.

The boundary-link set is not "channels not found in the parent." Compile-time
analysis does not inspect a runtime parent buffer. It means "channels not
declared by this boundary"; the runtime still validates that the immediate
parent can provide every requested link.

For this purpose, declaration ownership metadata is the ownership model. Any
compiler-generated channel that belongs to a boundary, such as capture text
output, must be represented as an internal declaration in `declaredChannels`.
Parent-owned declarations introduced from a child construct must not be treated
as local declarations of the child boundary.

Compiler boundary emitters should consume that derived link set directly. They
should not derive parent links by hand with node-specific subtraction rules.

## Current Smell

`compileCaptureBoundary(...)` currently has to subtract capture text outputs
from `node._analysis.usedChannels` before creating `linkedChannelsArg`.

That subtraction is correct behavior, but it is in the wrong layer. Capture text
outputs are local internal declarations of their capture boundary. The analysis
pass already keeps declared names out of the aggregate returned to the outer
parent; the stored per-node `usedChannels` and `mutatedChannels` should reflect
the same declaration boundary, or the analysis pass should expose a separate
derived boundary-link set for compiler emitters.

## Desired Outcome

- stored `usedChannels` means "channels touched by this node/body, excluding
  channels owned by nested child boundaries."
- stored `mutatedChannels` means "channels mutated by this node/body, excluding
  channels owned by nested child boundaries."
- the filtered upward aggregate and the stored per-node analysis facts do not
  disagree about child-owned channels.
- `usedChannels` / `mutatedChannels` may still include locally declared
  channels when the current node/body actually touches them. `linkedChannels`
  is the derived boundary subset that removes channels declared by that
  boundary.
- only boundary nodes store `linkedChannels`.
- boundary `linkedChannels` means "channels used or mutated by this boundary
  that are not declared by this boundary and must therefore be provided by the
  immediate parent."
- analysis produces a separate parent-link set for each boundary node that
  creates a runtime child buffer.
- boundary compilers pass the derived parent-link set to runtime.
- boundary emitters do not calculate linked channels in multiple places; the
  analysis pass is the single source of truth.
- manual filtering of `usedChannels` in boundary emitters is evaluated for
  removal. Some filters may turn out to encode valid boundary-specific
  semantics, but the default expectation is that linked-channel filtering
  belongs in analysis metadata.
- if a boundary emitter has to remove text channels, declarations, capture
  outputs, synthetic channels, or any other implementation detail from
  `usedChannels`, audit whether that is a valid local semantic rule or an
  analysis bug/missing analysis metadata.
- runtime continues to enforce that every requested linked channel exists in
  the immediate parent.
- workarounds introduced because `usedChannels` or `mutatedChannels` were
  broader than the boundary link contract are identified and removed or
  justified. Filtering is one visible workaround, but the audit should also
  look for special-case linking, silent skips, synthetic-name checks, defensive
  missing-channel handling, and duplicated channel-set calculations.
- any place where the analysis-derived `linkedChannels` set is not the final
  linked set emitted or used at runtime must be treated as suspicious. There
  may be valid local semantic additions/removals, but the default assumption is
  that a mismatch indicates an analysis bug, missing metadata, or a lingering
  workaround.

## Implementation Direction

1. Fix stored per-node `usedChannels` / `mutatedChannels` so they obey the same
   child-ownership filtering as the aggregate returned upward.
2. Add boundary-only `linkedChannels` metadata during analysis finalization.
3. Define boundary `linkedChannels` from the already-filtered current node
   usage:
   - start from channels used or mutated by the boundary body
   - remove channels declared by the boundary itself
   - do not include child-boundary-owned channels, because they should already
     be absent from the boundary's stored `usedChannels` / `mutatedChannels`
4. Update compiler boundary emitters to consume `node._analysis.linkedChannels`
   instead of recomputing links from `usedChannels`.
5. Delete duplicated linked-channel calculations from compiler helpers once the
   analysis-provided `linkedChannels` set is available.
6. Audit boundary-local `usedChannels` filters such as the capture-boundary
   text-output filter. Remove filters that are only compensating for missing
   analysis metadata; keep only filters that represent a real local semantic
   distinction.
7. Search for broader `usedChannels` workarounds outside obvious filters:
   - synthetic channel name checks
   - `findChannel(...)` / missing-channel guards before linking
   - duplicated `usedChannels - declaredChannels` calculations
   - caller/capture/import-specific channel-set patches
   - tests that had to manually register channels only because metadata claimed
     a link without a provider
   Remove the workaround when the new analysis metadata makes it unnecessary,
   or document why it remains a real semantic rule.
8. Compare analysis-provided `linkedChannels` with final emitted/runtime link
   sets. If a compiler path adds or removes channels after analysis, investigate
   it first as a likely bug or missing analysis fact. Keep the adjustment only
   when it represents a documented local semantic rule that analysis should not
   own.

## Proposed Stages

### Stage 1. Normalize Stored Channel Facts

Goal:

- make stored per-node `usedChannels` and `mutatedChannels` obey the same
  ownership boundaries as the aggregate returned upward

Work:

- adjust `_finalizeOutputUsage(...)` so stored facts do not include channels
  owned by nested child boundaries
- keep direct node facts (`uses`, `mutates`, `declares`) intact
- represent compiler-generated boundary-local channels as internal
  declarations instead of a separate owned-channel mechanism
- verify nested capture text outputs stay on the nested capture's analysis, not
  the outer capture's stored channel facts
- audit `declaredChannels`, `declares`, `declaresInParent`, and `textOutput`
  while changing ownership behavior; `textOutput` should identify the current
  text output but declaration ownership should still come from
  `declaredChannels`

Validation:

- nested set-block captures
- loops/includes inside captures
- parent-owned channel reads and mutations inside child boundaries

### Stage 2. Derive Boundary `linkedChannels`

Goal:

- make analysis the single source of truth for parent-link channel sets
- Stage 2 implementation owns the analysis metadata. Remaining compiler/runtime
  migration work belongs to Stage 3 or Stage 4, not another Stage 2 pass.

Work:

- add boundary-only `linkedChannels` metadata for nodes that create runtime
  child buffers
- add an explicit analysis flag, such as `createsLinkedChildBuffer`, for nodes
  that create a child command buffer whose channels may need parent links
- do not maintain a central node-type allowlist for link derivation; the node
  analyzer that knows it emits a linked child buffer should set the flag
- cover every child-buffer surface explicitly:
  - control-flow and value boundaries
  - conditional expression boundaries, including inline-if and short-circuit
    `and` / `or` boundaries that create buffers only when command effects are
    present
  - capture boundaries
  - render/custom-extension body fragments
  - loops
  - macro caller buffers, with caller invocation lane metadata derived from
    analysis-owned boundary links rather than local caller-specific subtraction
  - inheritance/component/callable invocation metadata
- derive it from filtered `usedChannels` / `mutatedChannels` minus channels
  owned by that boundary
- include external mutations as links, because writes to parent-owned channels
  must land in the parent lane in source order
- keep runtime strict: every requested link must exist in the immediate parent

Validation:

- capture, loop, include/import/from-import, macro caller, component, and
  inheritance boundary cases
- inline-if and short-circuit expression boundaries with parent-owned channel
  effects
- missing parent link still fails fatally at runtime

### Stage 3. Move Emitters To Analysis Links

Goal:

- remove duplicated linked-channel calculations from compiler emitters

Work:

- update boundary emitters to consume `node._analysis.linkedChannels`
- evaluate and remove local `usedChannels` filters and synthetic-name checks
  that only compensated for broad stored channel facts
- keep only emitter-side channel adjustments that represent documented local
  semantics
- compare final emitted/runtime link sets against analysis `linkedChannels`
  during the transition

Validation:

- focused boundary suites plus compile-source tests that assert emitted
  `linkedChannelsArg` no longer contains child-owned implementation channels

### Stage 4. Audit And Delete Workarounds

Goal:

- remove cleanup debt left by broad `usedChannels` / `mutatedChannels`
- make runtime linking/buffer decisions consume analysis/callable link metadata
  instead of rediscovering link shape from buffer state

Work:

- run the audit checklist below across compiler and runtime
- delete obsolete maybe-link guards, capture/caller/import patches, duplicated
  channel-set builders, and synthetic-name heuristics
- audit every runtime "do we link this now?" decision:
  - identify the analysis/callable metadata that should have requested the link
  - replace runtime availability/path probing with installation or assertion
    against that metadata where possible
  - keep runtime checks only for hard invariant validation, such as "requested
    linked channel is missing from the immediate parent"
- audit every compile-time child-buffer creation site and ensure it is either:
  - represented by analysis metadata via `createsLinkedChildBuffer` and
    `linkedChannels`
  - documented as a root/scope-root/runtime-only buffer that does not belong to
    boundary-link analysis
- audit inheritance/component invocation linking separately from ordinary
  control-flow boundaries, because callable metadata currently merges
  transitive used/mutated footprints at runtime
- replace or remove lane-list normalization helpers, such as linked/declared
  deduplication and merging, once analysis-owned metadata is authoritative
- document any remaining divergence from analysis-provided links as an explicit
  semantic rule

Validation:

- run the broader async suite after focused boundary coverage is green
- add focused tests for invocation/shared-root links where runtime used to skip
  or add links based on `hasChannel(...)`, `hasLinkedBuffer(...)`, or ancestry
  probing

## Validation

Add or preserve tests for these behaviors:

- nested set-block captures do not leak inner capture text outputs into the
  outer capture's `linkedChannels`
- capture bodies still link legitimate parent-visible reads such as loop
  metadata, ordinary variables, and explicit channel observations
- mutations of parent-owned channels inside boundaries are included in
  `linkedChannels`
- macro caller boundaries keep caller-local bindings local while linking real
  parent-visible dependencies
- import/from-import/include boundaries do not link unrelated locals
- inheritance method metadata does not include constructor-local non-shared
  channels in later invocation links
- runtime still throws when a requested linked channel is missing from the
  immediate parent

## Audit Checklist

Guiding question for every channel-set adjustment:

```text
If analysis linkedChannels were correct, would this code still need to alter the channel set?
```

If the answer is no, the code is likely cleanup debt. If the answer is yes,
document the semantic reason next to the code or move that semantic distinction
into analysis metadata.

Likely cruft families caused by broad `usedChannels` / `mutatedChannels` or
duplicated linked-channel calculation:

- synthetic-name heuristics, such as checks for `__text__t_`, `__return__`,
  `caller`, `loop#`, or `__waited__`
- boundary-specific link builders, including local
  `Array.from(usedChannels).filter(...)`, `used - declared`, or hand-built
  `linkedChannelsArg` logic in boundary/compiler helpers
- central node-type allowlists that try to infer which AST nodes need
  `linkedChannels`; child-buffer/link behavior should be explicit analysis
  metadata set by the relevant analyzer
- runtime "maybe link" guards that check whether a parent has a channel and
  silently skip linking when it does not
- runtime structural-link probes, such as checking whether a buffer path is
  already linked before deciding to link it
- tests that manually declare/register channels only because metadata claims a
  link without a real provider
- duplicated declared-channel threading and repeated linked/declared merge logic
- render/custom-extension body-local lane patches, especially helpers that
  manually add current text or fragment-local declarations
- capture, caller, import/from-import, include, loop, component, and inheritance
  special cases that patch channel sets locally
- finished-buffer fallback logic that finds channels through a path other than
  the explicit local-addressability/link model
- error/poison observation paths that derive channel sets differently from the
  success path
- shared/inheritance method metadata inflation, especially merged channel sets
  that include names not visible at invocation time
- text-output overlinking beyond set capture, including template block text,
  macro text, caller text, component render text, and current-text aliases
- alias-related patches where analysis emits formal names but runtime needs
  canonical names; these may be valid but should stay explicit and narrow

### Runtime Link-Decision Audit

Runtime should validate and install requested links; it should not discover
which links are needed by inspecting the buffer tree.

Audit every helper that asks a question shaped like:

```text
Does this buffer already have this link?
Can this parent currently provide this channel?
Should we link through the caller, the shared root, or both?
```

For each case, classify the decision:

- **Metadata-owned:** the analysis/callable `linkedChannels` set should already
  specify the link. Runtime should install it or throw if the immediate parent
  cannot provide it.
- **Runtime invariant:** the runtime check remains valid only as an assertion
  that the metadata-requested link is possible.
- **True runtime semantic:** the runtime genuinely has information analysis
  cannot know. Keep the decision, but document why it is not an analysis fact.

Default assumption: "maybe link if present" and "skip if already linked" logic
is compatibility debt unless a true runtime semantic is documented.

### Known Marker

Code that is already suspected to be transitional for this refactor should use
this marker:

```text
ANALYSIS-CHANNELS-REFACTOR
```

Current examples to audit:

- `src/compiler/emit.js#getLinkedChannelsArg(...)`: currently calculates
  linked channels and applies local filters; should become a serializer for
  analysis-provided `linkedChannels` or disappear.
- `src/compiler/boundaries.js#_collectTextOutputNames(...)`: currently filters
  child-owned capture text outputs out of capture links; should disappear once
  stored channel facts and boundary `linkedChannels` respect child ownership.
- `src/compiler/boundaries.js#compileCaptureBoundary(...)`: currently derives
  linked and declared lanes locally from broad stored facts; should consume
  analysis-owned boundary metadata.
- `src/compiler/boundaries.js#_getRenderBoundaryDeclaredChannelsArg(...)`:
  currently patches render/custom-extension body-local declared lanes, including
  current text; analysis should provide complete declared metadata for these
  fragments.
- `src/compiler/inheritance.js#collectMethodChannelNames(...)`: currently
  filters callable-local implementation channels out of inheritance method
  footprints; should collapse to analysis-owned callable/boundary metadata.
- `src/compiler/macro.js#_getCallerParentVisibleUsedChannels(...)`: currently
  derives macro caller links by subtracting declared channels locally; should
  consume analysis-owned caller boundary links.
- `src/runtime/command-buffer.js#uniqueLaneNames(...)` and
  `src/runtime/command-buffer.js#mergeLaneNames(...)`: currently normalize and
  merge linked/declared lane arrays defensively; should become unnecessary or
  narrow assertions once analysis emits authoritative lane metadata.
- `src/runtime/command-buffer.js#hasLinkedBuffer(...)`: currently answers
  runtime structural-link questions; should be replaced by analysis-owned link
  specs or a narrower assertion/installer.
- `src/runtime/inheritance-call.js#hasLinkedChannelPath(...)`: currently probes
  runtime buffer ancestry before deciding whether to add a shared-root link.
- `src/runtime/inheritance-call.js#_registerInvocationChannelLink(...)` and
  `_createAdmittedInvocationBuffer(...)`: currently choose caller/shared-root
  link paths from runtime channel availability.
- `src/runtime/inheritance-bootstrap.js#linkCurrentBufferToParentChannels(...)`:
  currently performs shared/inheritance runtime link decisions that should be
  driven by final boundary/callable link metadata.

When implementing this refactor, grep for the marker first, then continue with
the broader audit checklist above. New code should not add more marker comments
unless it is deliberately documenting a temporary workaround that this refactor
is expected to remove.

## Adjacent Analysis Facts To Audit

The primary refactor targets are `usedChannels`, `mutatedChannels`, and the new
boundary-only `linkedChannels`. While changing those, audit nearby analysis
facts that can affect channel ownership or linking:

- `createsLinkedChildBuffer`: should be the explicit marker that a node creates
  a child command buffer whose linked channels are analysis-owned. Keep it
  distinct from lexical scope facts.
- `declaredChannels`: should remain owner-scoped. Check ambiguity between
  declared here, declared in parent, and declared in nested child boundaries.
- `declares` / `declaresInParent`: these feed `declaredChannels`; ownership
  mistakes here will corrupt used/mutated/link derivation.
- `textOutput`: this identifies the current text-output channel, but should not
  be a separate ownership mechanism. Generated text outputs should also be
  internal declarations in `declaredChannels`. Nested text outputs should belong
  to their own boundary facts, not leak into an outer boundary's linked set.
- `sequenceLocks`: audit if any boundary/runtime link behavior depends on lock
  metadata; broad root collection may be fine, but boundary-local semantics
  should be checked before reusing it as a channel-like fact.
- imported binding facts, direct macro-call facts, caller facts, component
  binding facts, and explicit-this dispatch facts: these are not channel sets,
  but they influence which compiler path emits links. Any path that patches
  channel sets based on one of these facts should be revisited.
- alias/canonical-name metadata: valid aliases should remain explicit and
  narrow. Do not let alias handling become a replacement for correct ownership
  and linked-channel analysis.

## Relationship To Command Buffer Refactor

This work should happen after the command-buffer local-addressability model is
stable enough to make missing links fatal.

The command-buffer refactor can keep temporary compiler-side filters while the
runtime invariant is being established. This analysis refactor removes those
filters by producing the right boundary-link metadata at the source.
