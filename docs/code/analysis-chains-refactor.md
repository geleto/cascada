# Analysis Chains Refactor

## Purpose

This note tracks the compiler-analysis side of chain cleanup. It is separate
from [command-buffer-refactor.md](C:\Projects\cascada\docs\code\command-buffer-refactor.md),
which focuses on runtime state, local addressability, and command-buffer
invariants.

The problem to solve here is that the analysis pass already computes a filtered
upward aggregate, but the stored per-node `usedChains` and `mutatedChains`
values are saved before that filtering.

Today `_finalizeOutputUsage(...)` starts from direct node facts:

- `analysis.uses`
- `analysis.mutates`

It merges child aggregates into a local aggregate. Before returning that
aggregate to the parent, it already applies two important rules:

- chains declared at the current analysis node are removed from the set
  returned upward
- scope boundaries return an empty set upward

That means upward propagation mostly already follows the rule that child-owned
chains should not leak to ancestors.

The awkward part is that `analysis.usedChains` / `analysis.mutatedChains`
are assigned before the parent-facing filtering. Consumers that read
`node._analysis.usedChains` or `node._analysis.mutatedChains` therefore see
broader subtree sets, which can include names owned by nested child boundaries.

This makes `usedChains` appear to answer more than one question:

- "Which chains are touched by this node/body?"
- "Which chains should a boundary link from its immediate parent?"

The same issue applies to `mutatedChains`. A node/body should not claim usage
or mutation of chains owned by nested child boundaries, such as nested
set-block capture text outputs. Those chains belong to the child boundary's
own analysis facts and must not become parent-link requests for the outer
boundary.

## Target Model

### Chain Set Contracts

Keep the stored `usedChains` as a current-owner analysis fact:

- chains touched by this node/body
- including locally declared chains when that is useful for lane setup or
  diagnostics
- excluding chains owned by nested child boundaries

Keep `mutatedChains` aligned with the same ownership rule:

- chains mutated by this node/body
- excluding chains owned by nested child boundaries
- mutations also count as usage for link purposes, because a parent-owned
  chain that is mutated by a boundary must still be linked from the immediate
  parent

Add a derived boundary-link fact, computed by analysis:

- chains this boundary uses or mutates but does not own locally
- chains that must be imported/linked from the immediate parent
- no nested child-boundary-owned chains
- stored only on boundary nodes that need runtime parent linking

Analysis should mark those nodes explicitly with a child-buffer/linking fact
such as `createsLinkedChildBuffer`. Do not infer this from node type names, and
do not reuse `createScope` or `scopeBoundary`:

- `createScope` is lexical compiler scope, not command-buffer creation.
- `scopeBoundary` controls analysis propagation/visibility, not linking.
- emitter-local arguments such as `createScopeRootBuffer` describe a specific
  codegen helper, not the general boundary-link analysis contract.

The boundary-link set is not "chains not found in the parent." Compile-time
analysis does not inspect a runtime parent buffer. It means "chains not
declared by this boundary"; the runtime still validates that the immediate
parent can provide every requested link.

For this purpose, declaration ownership metadata is the ownership model. Any
compiler-generated chain that belongs to a boundary, such as capture text
output, must be represented as an internal declaration in `declaredChains`.
Parent-owned declarations introduced from a child construct must not be treated
as local declarations of the child boundary.

Compiler boundary emitters should consume that derived link set directly. They
should not derive parent links by hand with node-specific subtraction rules.

## Current Smell

Historically `compileCaptureBoundary(...)` had to subtract nested capture text
outputs from `node._analysis.usedChains` before creating `linkedChainsArg`.
Stage 1 removed that specific workaround by making generated capture text
outputs internal declarations and by keeping child-owned chains out of stored
usage facts.

The remaining smell is that emitters still derive links from stored facts
instead of serializing the Stage 2 `linkedChains` metadata directly. That
migration belongs to Stage 3.

## Desired Outcome

- stored `usedChains` means "chains touched by this node/body, excluding
  chains owned by nested child boundaries."
- stored `mutatedChains` means "chains mutated by this node/body, excluding
  chains owned by nested child boundaries."
- the filtered upward aggregate and the stored per-node analysis facts do not
  disagree about child-owned chains.
- `usedChains` / `mutatedChains` may still include locally declared
  chains when the current node/body actually touches them. `linkedChains`
  is the derived boundary subset that removes chains declared by that
  boundary.
- only boundary nodes store `linkedChains`.
- boundary `linkedChains` means "chains used or mutated by this boundary
  that are not declared by this boundary and must therefore be provided by the
  immediate parent."
- analysis produces a separate parent-link set for each boundary node that
  creates a runtime child buffer.
- boundary compilers pass the derived parent-link set to runtime.
- boundary emitters do not calculate linked chains in multiple places; the
  analysis pass is the single source of truth.
- manual filtering of `usedChains` in boundary emitters is evaluated for
  removal. Some filters may turn out to encode valid boundary-specific
  semantics, but the default expectation is that linked-chain filtering
  belongs in analysis metadata.
- if a boundary emitter has to remove text chains, declarations, capture
  outputs, synthetic chains, or any other implementation detail from
  `usedChains`, audit whether that is a valid local semantic rule or an
  analysis bug/missing analysis metadata.
- runtime continues to enforce that every requested linked chain exists in
  the immediate parent.
- workarounds introduced because `usedChains` or `mutatedChains` were
  broader than the boundary link contract are identified and removed or
  justified. Filtering is one visible workaround, but the audit should also
  look for special-case linking, silent skips, synthetic-name checks, defensive
  missing-chain handling, and duplicated chain-set calculations.
- any place where the analysis-derived `linkedChains` set is not the final
  linked set emitted or used at runtime must be treated as suspicious. There
  may be valid local semantic additions/removals, but the default assumption is
  that a mismatch indicates an analysis bug, missing metadata, or a lingering
  workaround.

## Implementation Direction

1. Fix stored per-node `usedChains` / `mutatedChains` so they obey the same
   child-ownership filtering as the aggregate returned upward.
2. Add boundary-only `linkedChains` metadata during analysis finalization.
3. Define boundary `linkedChains` from the already-filtered current node
   usage:
   - start from chains used or mutated by the boundary body
   - remove chains declared by the boundary itself
   - do not include child-boundary-owned chains, because they should already
     be absent from the boundary's stored `usedChains` / `mutatedChains`
4. Update compiler boundary emitters to consume `node._analysis.linkedChains`
   instead of recomputing links from `usedChains`.
5. Delete duplicated linked-chain calculations from compiler helpers once the
   analysis-provided `linkedChains` set is available.
6. Audit boundary-local `usedChains` filters. Remove filters that are only
   compensating for missing analysis metadata; keep only filters that represent
   a real local semantic distinction.
7. Search for broader `usedChains` workarounds outside obvious filters:
   - synthetic chain name checks
   - `findChain(...)` / missing-chain guards before linking
   - duplicated `usedChains - declaredChains` calculations
   - caller/capture/import-specific chain-set patches
   - tests that had to manually register chains only because metadata claimed
     a link without a provider
   Remove the workaround when the new analysis metadata makes it unnecessary,
   or document why it remains a real semantic rule.
8. Compare analysis-provided `linkedChains` with final emitted/runtime link
   sets. If a compiler path adds or removes chains after analysis, investigate
   it first as a likely bug or missing analysis fact. Keep the adjustment only
   when it represents a documented local semantic rule that analysis should not
   own.

## Proposed Stages

### Stage 1. Normalize Stored Chain Facts

Goal:

- make stored per-node `usedChains` and `mutatedChains` obey the same
  ownership boundaries as the aggregate returned upward

Work:

- adjust `_finalizeOutputUsage(...)` so stored facts do not include chains
  owned by nested child boundaries
- keep direct node facts (`uses`, `mutates`, `declares`) intact
- represent compiler-generated boundary-local chains as internal
  declarations instead of a separate owned-chain mechanism
- verify nested capture text outputs stay on the nested capture's analysis, not
  the outer capture's stored chain facts
- audit `declaredChains`, `declares`, `declaresInParent`, and `textOutput`
  while changing ownership behavior; `textOutput` should identify the current
  text output but declaration ownership should still come from
  `declaredChains`

Validation:

- nested set-block captures
- loops/includes inside captures
- parent-owned chain reads and mutations inside child boundaries

### Stage 2. Derive Boundary `linkedChains`

Goal:

- make analysis the single source of truth for parent-link chain sets
- Stage 2 implementation owns the analysis metadata. Remaining compiler/runtime
  migration work belongs to Stage 3 or Stage 4, not another Stage 2 pass.

Work:

- add boundary-only `linkedChains` metadata for nodes that create runtime
  child buffers
- add an explicit analysis flag, such as `createsLinkedChildBuffer`, for nodes
  that create a child command buffer whose chains may need parent links
- do not maintain a central node-type allowlist for link derivation; the node
  analyzer that knows it emits a linked child buffer should set the flag
- cover every child-buffer surface explicitly:
  - control-flow and value boundaries
  - conditional expression boundaries, including inline-if and short-circuit
    `and` / `or` boundaries that create buffers only when command effects are
    present
  - capture boundaries
  - render/custom-extension body fragments for ownership/declared-lane
    analysis; these use isolated render buffers today, so any linked-chain
    semantics must be documented during the Stage 3 emitter migration
  - loops
  - macro caller buffers, with caller invocation lane metadata derived from
    analysis-owned boundary links rather than local caller-specific subtraction
  - inheritance/component/callable invocation metadata
- derive it from filtered `usedChains` / `mutatedChains` minus chains
  owned by that boundary
- include external mutations as links, because writes to parent-owned chains
  must land in the parent lane in source order
- keep runtime strict: every requested link must exist in the immediate parent

Validation:

- capture, loop, include/import/from-import, macro caller, component, and
  inheritance boundary cases
- inline-if and short-circuit expression boundaries with parent-owned chain
  effects
- missing parent link still fails fatally at runtime

### Stage 3. Move Emitters To Analysis Links

Goal:

- remove duplicated linked-chain calculations from compiler emitters

Work:

- update boundary emitters to consume `node._analysis.linkedChains`
- resolve template output granularity before consuming links: `compileOutput(...)`
  emits per-child text boundaries, but each emitted text boundary represents
  the `Output` node's source-order slot and must link the output-level chain
  facts, including text output and sequence-lock lanes touched by the emitted
  expression.
- document render/custom-extension boundaries as isolated render buffers unless
  a real parent-link semantic is identified; migrate their declared-lane
  serialization separately from ordinary linked-chain boundaries.
- keep template-extends startup and inherited block text boundaries text-only
  until Stage 5 resolves whether that is a temporary workaround or a true
  text-scheduling semantic.
- evaluate and remove local `usedChains` filters and synthetic-name checks
  that only compensated for broad stored chain facts
- keep only emitter-side chain adjustments that represent documented local
  semantics
- compare final emitted/runtime link sets against analysis `linkedChains`
  during the transition

Validation:

- focused boundary suites plus compile-source tests that assert emitted
  `linkedChainsArg` no longer contains child-owned implementation chains

### Stage 4. Audit And Delete Workarounds

Goal:

- remove cleanup debt left by broad `usedChains` / `mutatedChains`
- make runtime linking/buffer decisions consume analysis/callable link metadata
  instead of rediscovering link shape from buffer state
- make inheritance, component, macro/caller, and callable-body paths use the
  same standard `usedChains`, `mutatedChains`, and `linkedChains` model
  wherever they create a normal child buffer

Work:

- run the audit checklist below across compiler and runtime
- delete obsolete maybe-link guards, capture/caller/import patches, duplicated
  chain-set builders, and synthetic-name heuristics
- treat every inheritance/component/callable deviation from analysis-owned
  linking as a suspected bug first. Do not preserve text-only, shared-schema,
  ancestry-probe, or runtime-maybe-link behavior just because existing tests
  depended on it.
- audit every runtime "do we link this now?" decision:
  - identify the analysis/callable metadata that should have requested the link
  - replace runtime availability/path probing with installation or assertion
    against that metadata where possible
  - keep runtime checks only for hard invariant validation, such as "requested
    linked chain is missing from the immediate parent"
- audit every compile-time child-buffer creation site and ensure it is either:
  - represented by analysis metadata via `createsLinkedChildBuffer` and
    `linkedChains`
  - documented as a root/scope-root/runtime-only buffer that does not belong to
    boundary-link analysis
- audit inheritance/component invocation linking separately from ordinary
  control-flow boundaries, because callable metadata currently merges
  transitive linked/mutated footprints at runtime
- investigate the inherited block text-boundary and template-extends startup
  text-only paths. A Stage 5 audit proved these are narrow text-scheduling
  semantics: the shared work is linked later by callable admission, while these
  boundaries preserve parent-render text placement.
- replace or remove lane-list normalization helpers, such as linked/declared
  deduplication and merging, once analysis-owned metadata is authoritative
- document any remaining divergence from analysis-provided links as an explicit
  semantic rule only after the standard-linking path has been tried and the
  reason it is wrong is understood

Validation:

- run the broader async suite after focused boundary coverage is green
- add focused tests for invocation/shared-root links where runtime used to skip
  or add links based on `hasChain(...)`, `hasLinkedBuffer(...)`, or ancestry
  probing
- add regression tests for any remaining special inheritance/component/callable
  link rule, showing both why standard links are insufficient and what invariant
  the special rule preserves

Stage 4 implementation notes:

- callable metadata now publishes `ownLinkedChains` and runtime-resolved
  method data carries `mergedLinkedChains`, so invocation admission consumes an
  explicit linked-chain footprint instead of recomputing one at each call site
- async boundary runtime parameters are named as linked-chain metadata
- command-buffer lane metadata now validates duplicate, invalid, and
  linked-plus-declared conflicts instead of silently deduping them
- inherited block text boundaries were tried with ordinary analysis-owned
  links; that exposed shared-buffer deadlocks/stale reads and led to the Stage 5
  text-scheduling semantic.

### Stage 5. Resolve Inheritance Text Scheduling Semantics

Goal:

- resolve the inherited block/template-extends standard-link failure found in
  Stage 4
- name the true text-scheduling semantic for boundaries that only carry parent
  render text placement
- keep shared reads/writes owned by the admitted callable invocation buffers
  where the observations actually happen

Work:

- reproduce the shared-buffer timing bug found when inherited block text
  boundaries use ordinary `linkedChains`
- identify why linking shared lanes on the inherited block text placement boundary moves
  observations from method-invocation time to parent-render scheduling time
- document the text-only text-placement semantic in
  `src/compiler/async-boundaries.js#compileBlockTextBoundary(...)`
- document the same scheduling semantic in
  `src/compiler/inheritance.js#_emitTemplateExtendsBoundaryFromSelection(...)`
- keep inherited block text placement boundaries structural and text-only: the
  boundary itself creates parent text placement, while non-text links from the
  block's analysis-owned callable footprint remain owned by callable admission.
- keep shared links on callable admission and callable body buffers, where the
  shared observations/mutations are enqueued

Validation:

- focused regression for the failing standard-link inherited block cases:
  parent/child async-template shared vars, template method dispatch with shared
  reads, top-level constructor state plus block bodies, and post-extends shared
  mutations observed in overriding blocks
- full quick suite after the inheritance/shared-routing changes

Stage 5 implementation notes:

- inherited block text boundaries are intentionally text-only. They are created
  at parent-render scheduling time, but their shared work is performed by the
  admitted inherited method invocation. Linking shared lanes on the text
  placement boundary creates an early shared-lane barrier before child
  constructor/post-extends mutations are enqueued. The boundary uses the
  compiler's current text lane because that is the structural lane it fills.
  Non-text callable links
  from analysis-owned metadata are installed by the invocation buffer, whose
  execution point is the actual observation point.
- template extends startup follows the same rule: it preserves parent-render
  text placement, while shared observations are linked by the eventual callable
  admission path.

### Stage 6. Remove Runtime Link Path Probing

Goal:

- replace runtime path probing with explicit shared-root/caller link
  installation or a documented true runtime semantic
- finish converting inherited callable footprint/link decisions to
  analysis-owned metadata

Work:

- `hasLinkedBuffer(...)` and `hasLinkedChainPath(...)` were removed from
  runtime link decisions. Invocation admission now installs requested inherited
  method links explicitly from the caller buffer and, for shared chains, from
  the shared root buffer. If both paths already address the same shared chain
  object, the shared-root installation is skipped to avoid enqueueing the same
  invocation buffer twice in one lane.
- `_registerInvocationChainLink(...)` was replaced by a narrow installer that
  validates the requested parent chain and inserts the invocation buffer
  without asking the buffer tree whether a path already exists.
- `linkCurrentBufferToParentChains(...)` is now a local installer for
  explicit shared/inheritance chains. It skips only when the current buffer
  already addresses the same chain object and fails if a different local
  chain is present.
- inherited method link/mutation filtering now derives from the ordinary
  `usedChains` and `mutatedChains` analysis facts, then narrows that set to
  shared inheritance declarations when emitting method metadata.
- compiler-emitted and runtime-resolved method metadata no longer carries
  `used` payloads: `ownLinkedChains` / `mergedLinkedChains` drive
  invocation admission, while `ownMutatedChains` / `mergedMutatedChains`
  remain as the transitive mutation footprint for inherited/component callable
  composition. The mutation footprint is reserved for finer read/write
  scheduling where a call that only reads a chain does not block subsequent
  reads of that chain. Both linked and mutated callable metadata are required
  on raw and resolved inherited method entries so stale compiled metadata cannot
  silently lose the mutation footprint.
- script inheritance startup was classified as a true runtime semantic:
  parent shared schemas can arrive dynamically, so the startup boundary links
  the runtime chain-level schema rather than a local analysis set.
- render boundary declaration serialization was classified as an isolated
  render-buffer semantic: the boundary owns its current text lane even when the
  source fragment has no explicit declaration.

Validation:

- tests that distinguish caller-local links from shared-root links when both
  are requested by callable metadata
- full quick suite after runtime link-path probing changes

### Stage 7. Collapse Remaining Managed Buffer Link Fallbacks

Goal:

- remove the last non-inheritance managed-buffer fallback that derives links
  from broad `usedChains`

Work:

- `src/compiler/emit.js#managedBlock(...)` no longer derives links from broad
  `usedChains`. Ordinary boundary nodes still use analysis-owned
  `linkedChains`; non-boundary managed buffers do not link parent chains
  implicitly.
- macro managed buffers declare their own parameter/return/caller/text lanes
  and do not require parent-buffer links.
- callback-style sync `asyncAll` loop bodies also use `managedBlock(...)`, but
  sync compilation does not run the async chain-analysis pass. That path keeps
  its existing sync/callback behavior and is not modeled as async analysis
  metadata.
- render boundaries remain isolated render-buffer semantics.
- `validateLaneNames(...)` / `combineLaneNames(...)` remain runtime API
  validation for the existing two-array `new CommandBuffer(...)` contract.
  They are no longer compensating for compiler-side link derivation.

Validation:

- macro caller, import/from-import, loop, and render-boundary compile-source
  tests continue to prove that unrelated locals are not linked
- full quick suite

Implementation notes:

- Stage 7 spans the managed-buffer cleanup and the callable metadata cleanup.
  `managedBlock(...)` no longer reconstructs links from broad `usedChains`;
  ordinary async child buffers must use analysis-owned link metadata, and
  non-boundary managed buffers do not link parent chains implicitly.
- inherited/component callable metadata no longer emits or resolves
  `ownUsedChains` / `mergedUsedChains`. Invocation admission uses
  `ownLinkedChains` / `mergedLinkedChains` only.
- `ownMutatedChains` / `mergedMutatedChains` remain required metadata,
  but are not used for admission yet. They preserve the hierarchy-wide mutation
  footprint for a future read/write scheduler where read-only calls do not block
  later reads of the same chain.
- raw and resolved method metadata now fail fast when required linked or mutated
  chain arrays are missing instead of silently defaulting malformed entries to
  empty footprints.

## Validation

Add or preserve tests for these behaviors:

- nested set-block captures do not leak inner capture text outputs into the
  outer capture's `linkedChains`
- capture bodies still link legitimate parent-visible reads such as loop
  metadata, ordinary variables, and explicit chain observations
- mutations of parent-owned chains inside boundaries are included in
  `linkedChains`
- macro caller boundaries keep caller-local bindings local while linking real
  parent-visible dependencies
- import/from-import/include boundaries do not link unrelated locals
- inheritance method metadata does not include constructor-local non-shared
  chains in later invocation links
- runtime still throws when a requested linked chain is missing from the
  immediate parent

## Audit Checklist

Guiding question for every chain-set adjustment:

```text
If analysis linkedChains were correct, would this code still need to alter the chain set?
```

If the answer is no, the code is likely cleanup debt. If the answer is yes,
document the semantic reason next to the code or move that semantic distinction
into analysis metadata.

Likely cruft families caused by broad `usedChains` / `mutatedChains` or
duplicated linked-chain calculation:

- synthetic-name heuristics, such as checks for `__text__t_`, `__return__`,
  `caller`, generated formal chain aliases, or `__waited__`
- boundary-specific link builders, including local
  `Array.from(usedChains).filter(...)`, `used - declared`, or hand-built
  `linkedChainsArg` logic in boundary/compiler helpers
- central node-type allowlists that try to infer which AST nodes need
  `linkedChains`; child-buffer/link behavior should be explicit analysis
  metadata set by the relevant analyzer
- runtime "maybe link" guards that check whether a parent has a chain and
  silently skip linking when it does not
- runtime structural-link probes, such as checking whether a buffer path is
  already linked before deciding to link it
- tests that manually declare/register chains only because metadata claims a
  link without a real provider
- duplicated declared-chain threading and repeated linked/declared merge logic
- render/custom-extension body-local lane patches, especially helpers that
  manually add current text or fragment-local declarations
- capture, caller, import/from-import, include, loop, component, and inheritance
  special cases that patch chain sets locally
- finished-buffer fallback logic that finds chains through a path other than
  the explicit local-addressability/link model
- error/poison observation paths that derive chain sets differently from the
  success path
- shared/inheritance method metadata inflation, especially merged chain sets
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
Can this parent currently provide this chain?
Should we link through the caller, the shared root, or both?
```

For each case, classify the decision:

- **Metadata-owned:** the analysis/callable `linkedChains` set should already
  specify the link. Runtime should install it or throw if the immediate parent
  cannot provide it.
- **Runtime invariant:** the runtime check remains valid only as an assertion
  that the metadata-requested link is possible.
- **True runtime semantic:** the runtime genuinely has information analysis
  cannot know. Keep the decision, but document why it is not an analysis fact.

Default assumption: "maybe link if present" and "skip if already linked" logic
is compatibility debt unless a true runtime semantic is documented.

### Marker Cleanup

The transitional source markers have been removed as of Stage 7. New
chain-linking cleanup should use ordinary code comments that describe the
current semantic rather than reintroducing phase markers.

## Adjacent Analysis Facts To Audit

The primary refactor targets are `usedChains`, `mutatedChains`, and the new
boundary-only `linkedChains`. While changing those, audit nearby analysis
facts that can affect chain ownership or linking:

- `createsLinkedChildBuffer`: should be the explicit marker that a node creates
  a child command buffer whose linked chains are analysis-owned. Keep it
  distinct from lexical scope facts.
- `declaredChains`: should remain owner-scoped. Check ambiguity between
  declared here, declared in parent, and declared in nested child boundaries.
- `declares` / `declaresInParent`: these feed `declaredChains`; ownership
  mistakes here will corrupt used/mutated/link derivation.
- `textOutput`: this identifies the current text-output chain, but should not
  be a separate ownership mechanism. Generated text outputs should also be
  internal declarations in `declaredChains`. Nested text outputs should belong
  to their own boundary facts, not leak into an outer boundary's linked set.
- `sequenceLocks`: audit if any boundary/runtime link behavior depends on lock
  metadata; broad root collection may be fine, but boundary-local semantics
  should be checked before reusing it as a chain-like fact.
- imported binding facts, direct macro-call facts, caller facts, component
  binding facts, and explicit-this dispatch facts: these are not chain sets,
  but they influence which compiler path emits links. Any path that patches
  chain sets based on one of these facts should be revisited.
- alias/canonical-name metadata: valid aliases should remain explicit and
  narrow. Do not let alias handling become a replacement for correct ownership
  and linked-chain analysis.

## Relationship To Command Buffer Refactor

This work should happen after the command-buffer local-addressability model is
stable enough to make missing links fatal.

The command-buffer refactor can keep temporary compiler-side filters while the
runtime invariant is being established. This analysis refactor removes those
filters by producing the right boundary-link metadata at the source.
