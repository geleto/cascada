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

- `postAnalyzeIf` uses `getChainsUsedFromParent(node.body)` plus else branch
  ([compiler-async.js](../../src/compiler/compiler-async.js#L385)).
- `postAnalyzeSwitch` unions `getChainsUsedFromParent(case.body)` / default
  ([compiler-async.js](../../src/compiler/compiler-async.js#L278)).
- `postAnalyzeWhile` uses `getChainsUsedFromParent(node.body)`
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
- **(noted, no action)** For `while`, body mutated-from-parent is computed twice
  (`postAnalyzeWhile` and `loop.js`) and the runtime `bodyPoisonChains` likely
  rarely fires for `while`. Compile-time, once-per-node, harmless - left as-is.

---

## 2. Lock Down Analysis Fact Invariants

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
to a `Set` ([analysis.js](../../src/compiler/analysis.js#L736)). This is a useful
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

Add comments or lightweight assertions near `CompileAnalysis._postAnalyzeNode`
and finalization to document the lifecycle contract. Consider a dev-only
assertion after normalization that finalized chain-set fields are `Set | null`.

**Risk:** low. The suite already pins `linkedChains instanceof Set`.

---

## 3. Consolidate Static-Path Extraction, Then Revisit Sequence Facts

**Why third:** concrete duplication, good test coverage, and it cleans the
substrate for any future sequence fact split.

### Problem

`sequential.js` has several walkers over `Symbol` / `LookupVal` chains:

- `_extractStaticPath(node)` -> segment array
  ([sequential.js](../../src/compiler/sequential.js#L361)).
- `_extractStaticPathRoot(node, expectedLength?)` -> root symbol, optional length
  ([sequential.js](../../src/compiler/sequential.js#L404)).
- `_extractStaticPathKey(node)` -> `!a!b` key string
  ([sequential.js](../../src/compiler/sequential.js#L105)).
- `_getSequenceKey` -> `_getSequentialPath` -> the `!`-aware variant with
  validation ([sequential.js](../../src/compiler/sequential.js#L137)).
- `_getBareSequenceLockLookup` and `_hasSequentialRepair` perform adjacent
  lookup-chain walks for sequence-specific decisions.

At the current audit point, generic static-path consumers include `buffer.js`
(`128`, `371`), `call.js` (`152`, `221`, `305`), `chain.js` (`94`, `166`,
`345`), `compiler-base-async.js` (`728`), `component.js` (`106`), and
`lookup.js` (`143`). `sequential.js` also has local `@todo` markers around
making `_getSequenceKey` public/inline and moving the generic static-path
extractor out of the sequence module. Those notes point at the same
consolidation target.

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

**Why fourth:** it names a real architectural split without touching the deeper
flag model yet.

### Problem

`_registerDeclarations` builds `declaredChains` during the walk
([analysis.js](../../src/compiler/analysis.js#L322)), then
`_finalizeDeclarations` nulls every `declaredChains`
([analysis.js](../../src/compiler/analysis.js#L276)) and rebuilds from scratch.

The walk-time build exists because in-walk `_validateUses` /
`_validateMutations` call `findDeclaration`, which reads `declaredChains`.
That source-order table is intentional: earlier same-scope uses must stay
ambient before a later local declaration. Tests in `chains-explicit.js` cover
this behavior for function calls, sequence paths, and chain initializers.

The issue is not that the walk-time map is useless. The issue is that the
source-order map and the finalized all-declarations map reuse the same field
name and shape.

### Action

Do **not** delete the walk-time source-order declaration index.

Instead, consider splitting the concepts explicitly:

- `sourceVisibleDeclarations` for first-pass source-order lookup validation;
- `declaredChains` for finalized scope ownership.

This should keep source-order semantics while making finalization easier to
reason about.

**Risk:** medium-high. Must preserve source-order ambient lookup behavior and
current error positions/messages.

---

## 5. Unify Buffer-Creation Policy And Callable Footprints

**Why fifth:** these are adjacent concepts: boundary intent, linked-chain
metadata, callable metadata, and runtime inheritance patching.

### Problem

Three flags drive child-buffer creation:

- `createsLinkedChildBuffer` (set to literal `true` by many node analyzers);
- `createsScopeBuffer` (guard recovery only);
- `expressionControlFlowBoundary` (inline-if / `and` / `or`).

`_createsLinkableChildBuffer` is `createsLinkedChildBuffer || createsScopeBuffer`
([analysis.js](../../src/compiler/analysis.js#L749)).

`createsLinkedChildBuffer` carries two meanings:

- analyzer intent;
- actual derived outcome.

The `expressionControlFlowBoundary` tail block re-derives it to `false` when
there are no linked mutations ([analysis.js](../../src/compiler/analysis.js#L655)).

Callable footprints are part of the same surface. Blocks, methods, macros,
callers, imports, inherited methods, and components each compute a
boundary/callable footprint. The parent-visible work fixed one naming bug:
`_getCallableChainFootprint` now returns `linkedMutatedChains`, not
`mutatedChains`, and uses the from-parent helpers
([inheritance.js](../../src/compiler/inheritance.js#L906)).

There is also transitional runtime scaffolding:
`CommandBuffer._markLinkedMutatedChain(...)` patches inheritance callable
footprints at runtime and carries an explicit TODO.

### Action

Separate intent from outcome:

- analyzer-set `wantsLinkedChildBuffer`;
- analysis-computed `createsLinkedChildBuffer`.

Describe buffer-creation policy as one decision function rather than scattered
flags. In the same pass, standardize callable footprint shape/names around:

- own linked chains;
- shared dependencies;
- mutation dependencies.

Audit whether `_markLinkedMutatedChain(...)` can be removed once callable/link
metadata has one clear compile-time path.

**Risk:** medium. Touches every boundary node's analyzer and inheritance/callable
surfaces.

---

## 6. Audit Internal/Special Chain Visibility

**Why sixth:** it is cross-cutting and should happen after the major boundary
and callable shapes are clearer.

### Problem

`__text__*`, `__return__`, `__caller__`, and `__waited__*` are internal lanes
that sometimes travel through generic `usedChains` / `mutatedChains`.

Some of this is load-bearing:

- `hasCallerSupport` detection relies on `__caller__` surfacing in the body's
  used-from-parent set ([macro.js](../../src/compiler/macro.js#L151)).
- Sequential loop return checks rely on `__return__` being present in body chain
  facts.
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

**Risk:** medium. Semantics are subtle and per-chain.

---

## 7. Audit Declaration Flag Model

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

**Risk:** high. Load-bearing for scoping correctness, macro hoisting via
`declaresInParent`, and shared inheritance defaults.

---

## 8. Defer Data-Path vs Ordinary-Lookup Analysis

**Why last:** recently churned twice and currently lower value than the items
above.

`isDataCommandPath` / `dataPathSegments` and lookup post-analysis were just
reworked (postAnalyze migration plus the `isDataCommandPath` gating). The
remaining blend of ordinary expression lookup vs compile-time path-literal
extraction is minor. Re-touch only when a concrete consumer confusion appears.
