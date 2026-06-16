# Analysis Fact Audit

Follow-on to the **parent-visible use/mutation** work (`usedChainsFromParent` /
`mutatedChainsFromParent` + `getChainsUsedFromParent` /
`getChainsMutatedFromParent`).

The bug class that work fixed was: **one analysis fact carried several meanings,
and call sites silently picked the one they wanted.** Guard read `usedChains`
when it meant "chains mutated inside the guard", so a `lock! is error` status
check was miscounted as a modification.

This document is ordered by suggested execution order. Items are grouped where
the same refactor substrate or invariant should be handled together.

## Cleanup Rules

1. **Require a second consumer before splitting a fact.** A fact with two
   meanings is only worth splitting when a real present-day call site wants the
   other meaning.
2. **Pick the canonical form, expose one helper, audit each consumer's actual
   requirement, then delete the duplication.**
3. **Name the lifecycle of each fact.** First-pass analyzers, post-analyzers,
   finalized analysis facts, and codegen do not all have access to the same
   information.

---

## 1. Fix Poison Target Sets: Use Mutations, Not Reads

**Status: implemented.** Branch/loop poison targets now derive from
`getChainsMutatedFromParent` (`If`/`Switch`/`While` via
`_getSkippedRegionPoisonChains`; loops split `bodyObservationChains` (used,
return-advance) from `bodyPoisonChains`/`elsePoisonChains` (mutated, poison)).
Runtime poison loops consolidated into `addPoisonCommands`. Focused poison,
conditional, and loop suites are green.

**Why first:** correctness risk, isolated surface, and the same ambiguity class
as the guard bug.

### Problem

Before this item was implemented, branch and loop poison target sets were
derived from read+write facts:

- `postAnalyzeIf` used `getChainsUsedFromParent(node.body)` plus else branch
  ([compiler-async.js](../../src/compiler/compiler-async.js#L385)).
- `postAnalyzeSwitch` unioned `getChainsUsedFromParent(case.body)` / default
  ([compiler-async.js](../../src/compiler/compiler-async.js#L278)).
- `postAnalyzeWhile` used `getChainsUsedFromParent(node.body)`
  ([compiler-async.js](../../src/compiler/compiler-async.js#L215)).
- `loop.js` passed `bodyChains` / `elseChains`, also from
  `getChainsUsedFromParent(...)`, into `runtime.iterate(...)`
  ([loop.js](../../src/compiler/loop.js#L76)). Runtime helpers then poison those
  chains on iterator/destructuring/body-scheduling failures
  ([runtime/loop.js](../../src/runtime/loop.js#L144),
  [runtime/loop.js](../../src/runtime/loop.js#L709)).

If a selector or iterator fails, the skipped body never runs. Chains the skipped
region would have **written** must be poisoned so downstream waiters do not hang.
Chains it only **read** produce nothing downstream; poisoning them marks a
read-only dependency as failed even though the skipped region never wrote it.

Current `CommandBuffer` creates lanes for all linked chains, so this is not a
known lane-availability bug today. It is still over-poisoning and it blurs the
meaning of the target set.

Evidence: the emitted branch catch path iterates the provided target set
directly (`emitBranchPoisonCatch` loops over `poisonChains` and emits one
`ErrorCommand` per chain in
[async-boundaries.js](../../src/compiler/async-boundaries.js#L168)). There is no
later reinterpretation of those names, so the analysis fact must already mean
"chains the skipped region could have written."

### Action

Switch branch poison target derivation to `getChainsMutatedFromParent` for
`If`, `Switch`, and `While`.

For `For` / `AsyncEach` / `AsyncAll`, split the overloaded `bodyChains` /
`elseChains` option into:

- mutation-only poison targets;
- any separate observation set still needed for return-advance checks or loop
  control.

Preserve the current `RETURN_CHAIN_NAME` loop-advance behavior while splitting
the loop options: `return.js` currently checks `bodyChains.includes(...)`, so the
rename/split must keep that observation purpose explicit instead of silently
changing it to mutation-only.

The correct poison set has mutation-only semantics like `linkedMutatedChains`,
but must be derived from the **skipped body/branch/else region**, not blindly
from the outer boundary's own `linkedMutatedChains` (which may also include
condition or selector effects).

### Tests

Add regressions for:

- an `if` whose branch only reads an outer chain, with a failing condition;
  assert that read-only chain is not poisoned downstream while a written chain
  is;
- `switch` and `while` skipped regions that only read an outer chain;
- loop body and loop-else regions that only read an outer chain, with a failing
  iterator or destructuring value; assert that the read-only chain is not
  poisoned.

**Risk:** low-medium. Pure narrowing of an over-broad set; if a needed chain is
not poisoned, the likely failure is a loud hang or rejection. Treat this as a
likely correctness fix until the regressions above prove the behavior end to
end.

### Follow-ups (optional, non-blocking)

- **Per-construct "written -> still poisoned" regressions.** Existing suite
  coverage already exercises preserved write poisoning for branch/loop effects,
  so this is optional unless future churn touches this surface again.
- **Resolved during later cleanup:** branch and loop compile paths now compute
  skipped-region poison targets directly from `mutatedChainsFromParent`; there
  is no stored `postAnalyze*` poison-target fact to keep in sync.

---

## 2. Lock Down Analysis Fact Invariants

**Status: implemented.** Finalized chain-set facts are asserted as `Set | null`
with string chain names after chain-usage finalization. Custom linked-chain
facts returned by post-analyzers are normalized through `_normalizeChainSet`;
invalid shapes fail during analysis instead of leaking to codegen.

**Why second:** cheap guardrails before broader refactors. This combines the
chain-set typing issue and lifecycle rules.

### Problem

Finalized analysis chain-set fields should have one internal shape:
`Set | null`. Emit/helper boundaries can convert to arrays, and post-analyzers
may return narrow custom iterables, but finalized facts must be normalized before
codegen consumes them.

Current relevant fields include:

- `usedChains`
- `mutatedChains`
- `usedChainsFromParent`
- `mutatedChainsFromParent`
- `linkedChains`
- `linkedMutatedChains`

`_normalizeChainSet` now coerces custom post-analysis linked-chain iterables back
to a `Set` ([analysis.js](../../src/compiler/analysis.js)). This is a useful
normalization boundary, not merely a temporary shim, as long as the invariant is
documented and tested.

There is also an implicit lifecycle contract:

- `getChainsUsedFromParent(...)` / `getChainsMutatedFromParent(...)` are valid
  for already-finalized children in post-analyzers and during codegen after
  analysis has run.
- First-pass analyzers should not call those helpers.
- Post-analyzers should not introduce ordinary `uses` / `mutates` without also
  owning validation for those facts. Current sequence post-analysis is okay
  because it validates declared roots locally and root sequence existence later.

### Action

Adopt and enforce:

- finalized analysis chain-set facts are `Set | null`;
- arrays are allowed only at emit/helper boundaries or as pre-normalized
  post-analysis iterables;
- `_normalizeChainSet` remains the single normalization boundary unless the
  codebase later chooses a stricter "producers must return Sets" rule.

Document the lifecycle contract in code: a comment near
`CompileAnalysis._postAnalyzeNode` for post-analyzer/normalization ordering, and
a comment on `getChainsUsedFromParent` / `getChainsMutatedFromParent` noting they
read finalized facts (valid from post-analyzers and codegen, null in first-pass
analyzers).

For the invariant, keep `_normalizeChainSet` as the boundary for untrusted
custom post-analysis linked facts. Compiler-owned usage aggregates are built as
sets directly, so a second finalized-field shape assertion would only repeat the
same invariant before codegen observes it.

**Risk:** low. The suite already pins `linkedChains instanceof Set`.

---

## 3. Consolidate Static-Path Extraction, Then Revisit Sequence Facts

**Status: implemented.** `CompileSequential.extractStaticPath(...)` is now the
canonical pure lookup-path walker. Segment/root/key projections derive from it,
generic callers use the public projection helpers, and `_getSequentialPath`
remains the `!`-aware validation layer. No new sequence read/observed facts were
introduced; a code comment documents that bare lock lookups currently share the
existing `uses` fact for both value reads and status observations.

Two sequence error messages were intentionally changed: the two-marker case now
uses the same `'Cannot use more than one sequence marker (!)'` text as the
sibling check (previously a divergent `'Using two sequence markers'`), and a
dynamic inner segment (e.g. `a[i].b!`) now reports the user-facing
"prefix must be static" error instead of a mislabeled "Internal Compiler Error".
No test asserted the old strings.

**Why third:** concrete duplication, good test coverage, and it cleans the
substrate for any future sequence fact split.

### Problem

Before this item, `sequential.js` had several walkers over `Symbol` /
`LookupVal` chains:

- `_extractStaticPath(node)` -> segment array.
- `_extractStaticPathRoot(node, expectedLength?)` -> root symbol, optional length.
- `_extractStaticPathKey(node)` -> `!a!b` key string.
- `_getSequenceKey` -> `_getSequentialPath` -> the `!`-aware variant with
  validation.
- `_getBareSequenceLockLookup` and `_hasSequentialRepair` perform adjacent
  lookup-chain walks for sequence-specific decisions.

Generic static-path consumers included `buffer.js`, `call.js`, `chain.js`,
`compiler-base-async.js`, `component.js`, and `lookup.js`. The cleanup keeps
those consumers on projection helpers while centralizing the actual lookup-chain
walk in `CompileSequential.extractStaticPath(...)`.

The pure extractors differ mostly in projection over the same walk. The
`!`-aware path is different because it raises compile errors (two `!` in a path,
dynamic key under `!`, `!` inside a macro). That validation must stay separate.

Sequence lock concepts are currently spread across `uses` / `mutates` plus side
records:

- defined -> root `sequenceLocks`;
- read-as-value and observed-via-`is error` -> both land in `uses`;
- mutated / repaired (`!!`) -> `mutates`;
- inherited through a call path -> `inheritedSequenceFunCallLockKey`.

The guard read-vs-mutate bug is fixed by routing guard through
`getChainsMutatedFromParent`. The residual ambiguity is observed (`is error`) vs
read-as-value, and no current consumer needs that split.

`validateSequenceLockUsages` already validates observed lock names at root
post-analysis time against the final defined-lock set, so observed-vs-read has
not yet created a concrete correctness need for another fact.

### Action

Introduce one canonical pure walker, for example:

```js
extractStaticPath(node) -> { segments, root, isStatic }
```

Derive key/root/length projections from it. Keep `_getSequentialPath` as a thin
`!`-aware layer that preserves existing error behavior.

Do **not** speculatively mint `sequenceLocksRead` /
`sequenceLocksObserved` / `sequenceLocksMutated` /
`sequenceLocksRepaired`. After the extractor cleanup, revisit whether an
explicit `sequenceLocksObserved` fact is justified by an actual consumer. Until
then, a comment documenting that `uses` conflates read-as-value and status
observation is enough.

**Risk:** medium. Wide call surface, but mostly pure refactor with strong
sequential test coverage.

---

## 4. Split Source-Order Declarations From Finalized Declarations

**Status: implemented.** First-pass lookup validation now writes
`sourceVisibleDeclarations`, while `_finalizeDeclarations` rebuilds
`declaredChains` as the finalized scope ownership table. Declaration lookup uses
the source-order table during the walk and the finalized table after declaration
finalization. The old `declaredChains` reset loop at the top of
`_finalizeDeclarations` (dead once the walk stopped writing `declaredChains`) was
removed.

**Why fourth:** it names a real architectural split without touching the deeper
flag model yet.

### Problem

Before this item, `_registerDeclarations` built `declaredChains` during the
walk, then `_finalizeDeclarations` nulled every `declaredChains` and rebuilt it
from scratch.

The walk-time build exists because in-walk `_validateUses` /
`_validateMutations` call `findDeclaration`, which needs source-order
declarations.
That source-order table is intentional: earlier same-scope uses must stay
ambient before a later local declaration. Tests in `chains-explicit.js` cover
this behavior for function calls, sequence paths, and chain initializers.

The issue was not that the walk-time map was useless. The issue was that the
source-order map and the finalized all-declarations map reused the same field
name and shape.

### Action

The walk-time source-order declaration index was kept, but it is now named
separately from the finalized ownership table:

- `sourceVisibleDeclarations` is used for first-pass source-order lookup
  validation;
- `declaredChains` is rebuilt during declaration finalization and used as the
  finalized scope ownership table.

This keeps source-order semantics while making finalization easier to reason
about.

**Risk:** medium-high. Must preserve source-order ambient lookup behavior and
current error positions/messages.

---

## 5. Unify Buffer-Creation Policy And Callable Footprints

**Status: implemented.** Analyzer-owned boundary intent now uses
`wantsLinkedChildBuffer`, while `_finalizeBufferCreation` computes the finalized
`createsLinkedChildBuffer` outcome. Callable footprint calculation now names
shared reads/writes as `sharedDependencies` and `mutationDependencies` before
adapting them to analysis link facts or emitted method-entry ABI fields.

**Why fifth:** these are adjacent concepts: boundary intent, linked-chain
metadata, callable metadata, and runtime inheritance patching.

### Problem

Before this item, three flags drove child-buffer creation:

- `createsLinkedChildBuffer` (set to literal `true` by many node analyzers);
- `createsScopeBuffer` (guard recovery only);
- `expressionControlFlowBoundary` (inline-if / `and` / `or`).

`createsLinkedChildBuffer` carried two meanings:

- analyzer intent;
- actual derived outcome.

The `expressionControlFlowBoundary` tail block re-derived it to `false` when
there were no linked mutations.

Callable footprints were part of the same surface. Blocks, methods, macros,
callers, imports, inherited methods, and components each compute a
boundary/callable footprint.

There was also transitional-looking runtime scaffolding:
`CommandBuffer._markLinkedMutatedChain(...)` patched inheritance callable
footprints at runtime and carried an explicit TODO.

### Action

Intent and outcome are now separate:

- analyzers set `wantsLinkedChildBuffer`;
- analysis computes `createsLinkedChildBuffer`.

Buffer creation policy is centralized in `_finalizeBufferCreation` /
`_shouldCreateLinkedChildBuffer`. Callable footprint shape is named around:

- own linked chains;
- shared dependencies;
- mutation dependencies.

`createsLinkedChildBuffer` now means the node creates a child `CommandBuffer`.
It can be true even when `linkedChains` and `linkedMutatedChains` are empty.

`_markLinkedMutatedChain(...)` was audited and kept. Inherited callable
invocation buffers are already constructed when finalized callable footprint
links are attached, so the runtime still needs a narrow late-link mutation
marker.

**Risk:** medium. Touches every boundary node's analyzer and inheritance/callable
surfaces.

---

## 6. Audit Internal/Special Chain Visibility

**Status: implemented.** Internal lanes are not blanket-filtered from generic
facts. Instead, the load-bearing special cases are named at their owning
compiler feature: return-state guard capture/loop observation lives in
`return.js`, and caller scheduling detection lives in `macro.js`. `__waited__*`
remains timing-only codegen state.

**Why sixth:** it is cross-cutting and should happen after the major boundary
and callable shapes are clearer.

### Problem

`__text__*`, `__return__`, `__caller__`, and `__waited__*` are internal lanes
that sometimes travel through generic `usedChains` / `mutatedChains`.

Some of this is load-bearing:

- `hasCallerSupport` detection relies on `__caller__` surfacing in the body's
  used-from-parent set; `CompileMacro.bodyUsesCallerScheduling(...)` owns that
  internal-lane check.
- Sequential loop return checks rely on `__return__` being present in body chain
  facts; `CompileReturn.hasReturnStateObservation(...)` owns that check.
- `__waited__*` is a timing lane; the dedicated `currentWaitedChainName` /
  `withOwnWaitedChain` binding in `buffer.js`
  ([buffer.js](../../src/compiler/buffer.js#L88)) treats it as a flat timing lane
  rather than ordinary nested child-buffer state.
- Nested-capture `__text__` outputs must not leak into an outer boundary's
  linked set.

### Action

For each internal lane, decide:

- must be visible to generic consumers;
- should be hidden behind a helper;
- should participate in linking but not poisoning;
- should participate in timing but not mutation.

Document the result. Do not make a blanket "hide internal chains" change.

### Result

| Lane | Generic analysis visibility | Policy |
| --- | --- | --- |
| `__text__*` | Yes. It is template output state and participates in generic use/mutation facts. | Treat as ordinary output-chain state for linking and poisoning. Nested captures use their own current text chain so capture-local output does not leak into outer boundary links. |
| `__return__` | Yes. `return` mutates it and `__return_is_unset__()` reads it. | Keep visible for branch/loop poison and sequential-loop return advance. Hide the guard-capture exception behind `CompileReturn.shouldCaptureInGuardState(...)`; guard recovery must not restore old return state. |
| `__caller__` | Yes. Direct `caller()` both uses and mutates it. | Keep visible so nested caller boundaries link the scheduling lane, macro return can wait for caller invocations, and skipped/failing macro-body regions can poison pending caller scheduling work. Hide macro support detection behind `CompileMacro.bodyUsesCallerScheduling(...)`. |
| `__waited__*` | No generic analysis visibility. | Timing-only lane owned by `currentWaitedChainName` / `withOwnWaitedChain` and emitted `WaitResolveCommand`s. It must not be linked as child-buffer state, treated as mutation, or added to poison targets. |

**Risk:** medium. Semantics are subtle and per-chain.

---

## 7. Audit Declaration Flag Model

**Status: implemented.** No declaration-model rewrite is recommended in this
phase. The current declaration object does carry several axes, but the existing
flags are load-bearing and mostly feature tags rather than dead transitional
scaffolding. The useful cleanup was to name the placement/conflict policies in
`analysis.js`, not to replace the shape wholesale.

**Why seventh:** high ceiling, high risk. Do after source-order/finalized maps are
split and after boundary/callable shape is clearer.

### Problem

`declares` / `declaresInParent` / `parentOwned` / `shared` / `macroParam` /
`imported` / `internal` / `declarationOrigin` encode several orthogonal
questions in one bag:

- where declared;
- where visible;
- who owns writes;
- whether exported/imported/shared/internal behavior applies.

The Macro/Set special-casing in `_registerDeclarations` and
`_installDeclaration` is dense and easy to misuse.

### Action

Audit, do not rewrite immediately. Map each flag to an axis and see whether an
explicit model such as `{ declaredAt, visibleAt, writeOwner }` removes special
cases.

### Result

The current model has four separate axes sharing one declaration object:

| Axis | Current representation | Meaning |
| --- | --- | --- |
| Placement and lifecycle | `declares`, `declaresInParent`, `sourceVisibleDeclarations`, `declaredChains` | Where a declaration is first registered during the source-order walk, and where it is finally owned after declaration finalization. |
| Conflict policy | `explicit`, `parentOwned`, producer node type (`Macro`, `Set`, `ChainDeclaration`) | Whether the declaration should conflict with same-scope or ancestor declarations during first-pass validation. |
| Storage/access behavior | `type`, `shared`, `imported`, `componentBinding`, `isMacro`, `macroParam`, `internal`, `implicitTemplateShared` | How later compiler features interpret a visible declaration: chain type, shared-state access, imported callable boundary, component binding, direct macro call, macro argument, reserved-name bypass, or inferred template shared state. |
| Origin and codegen context | `declarationOrigin`, `initializer` | Which analysis node introduced the declaration and which source node/context should be used by later codegen or diagnostics. |

This means `{ declaredAt, visibleAt, writeOwner }` would not be expressive
enough by itself. It would clarify placement, but it would still need separate
feature tags for shared/imported/component/macro/internal behavior and a
conflict-policy axis.

### Flag Map

| Fact | Current role | Keep? |
| --- | --- | --- |
| `declares` | Local declaration requests produced by the node analyzer. During the walk they populate `sourceVisibleDeclarations`; during finalization they rebuild `declaredChains`. | Keep. This is the producer list, not a finalized ownership table. |
| `declaresInParent` | Declaration requests installed into the parent scope owner, currently used for macro-name hoisting. | Keep. It names a real placement difference. |
| `parentOwned` | Marks a `declaresInParent` entry as parent-owned for macro conflict checks and root-export detection. | Keep for now, but this is the best future simplification target. A placement record could replace the separate flag. |
| `declarationOrigin` | Points to the analysis node that introduced the declaration. Direct macro calls, set target facts, shared initializer diagnostics, and shared method metadata rely on it. | Keep. Not redundant with ownership. |
| `shared` | Marks hierarchy-owned shared storage. It affects declaration installation, root shared-schema registration, bare shared assignment validation, lookup/use validation, and shared-chain codegen. | Keep. It is broad but intentionally central; split only as part of a shared-schema/access-surface refactor. |
| `implicitTemplateShared` | Distinguishes inferred template `this.<name>` shared vars from explicit script shared declarations for extends-target validation. | Keep. Narrow feature tag. |
| `imported` | Marks import/from-import bindings so member calls can create imported callable boundaries and link the imported namespace/text output correctly. | Keep. Narrow feature tag. |
| `componentBinding` | Marks script component bindings so `component.x` accesses route through component shared-state/method dispatch. | Keep. Narrow feature tag. |
| `isMacro` | Marks macro declarations so direct macro calls can bind to the compiled macro function. | Keep. Narrow feature tag. |
| `macroParam` | Marks macro parameters so sequence-marker misuse inside macros can produce the macro-specific error. | Keep. Narrow feature tag. |
| `internal` | Allows compiler-owned declarations such as `__return__`, `__caller__`, and private text lanes to bypass reserved-name validation. | Keep. Narrow feature tag. |
| `explicit` | Distinguishes explicit declarations from implicit template `set` declarations for conflict validation. | Keep. It belongs to conflict policy; future cleanup should name that policy directly. |

### Architectural Conclusion

The current pain was not that all flags were wrong; it was that placement,
conflict policy, and feature behavior were encoded in the same flat object and
interpreted inline in `_registerDeclarations`.

The cleanup keeps the declaration shape but names the source-order registration
steps in `CompileAnalysis`:

- `_registerSourceDeclarations(...)`: source-order declaration list install;
- `_validateSourceDeclarationConflict(...)`: policy dispatch;
- `_validateMacroDeclarationConflict(...)`: macro local/parent-owned conflicts;
- `_validateExplicitDeclarationConflict(...)`: explicit set/chain conflicts;
- `_validateAncestorDeclarationConflicts(...)`: ancestor visible-declaration scan.

Future refactors should stay incremental:

- extract placement helpers only when another parent-owned declaration form
  appears;
- keep source-order table installation and finalized-table installation
  separate;
- add feature predicates such as `isSharedDeclaration`,
  `isImportedDeclaration`, and `isComponentBindingDeclaration` only if a second
  consumer appears.

Do not attempt a broad `{ declaredAt, visibleAt, writeOwner }` rewrite without
also modeling conflict policy and feature tags. The current `parentOwned` flag
looks redundant with `declaresInParent`, but removing it is only safe after
placement and conflict policy are represented together.

**Risk:** high. Load-bearing for scoping correctness, macro hoisting via
`declaresInParent`, and shared inheritance defaults.

---

## 8. Clarify Data-Path vs Ordinary-Lookup Ownership

**Status: implemented.** No deeper data-path rewrite was needed. The cleanup
keeps the existing marker-based model but moves data-command path marker
propagation and lookup-segment composition into `CompileChain`, so `lookup.js`
no longer owns data-path construction details.

**Why last:** recently churned twice and currently lower value than the items
above.

`isDataCommandPath` / `dataPathSegments` and lookup post-analysis were just
reworked (postAnalyze migration plus the `isDataCommandPath` gating). The
remaining blend of ordinary expression lookup vs compile-time path-literal
extraction was minor, so the implementation stayed limited to the concrete
ownership confusion below.

### Result

The remaining concrete confusion was small: `LookupVal` analysis had to know how
to propagate `isDataCommandPath` to its target and how to append lookup segments
to `dataPathSegments`. Those are data-command path construction details, not
ordinary lookup semantics.

The cleanup keeps ordinary lookup and data-path extraction separate by ownership:

- `CompileLookup` still owns ordinary lookup facts: sequence locks, `this`
  shared access, component bindings, inherited method lookup, and sequence-chain
  lookups.
- `CompileChain` owns data-command path extraction:
  `markDataCommandPath(...)`, `analyzeDataPathLookup(...)`,
  `postAnalyzeDataPathSegment(...)`, `postAnalyzeDataPathArray(...)`, and
  `postAnalyzeDataPathLookup(...)`.

Do not add a broader data-path analysis model unless another concrete consumer
needs the distinction. The current marker is narrow and local to data-command
argument normalization.
