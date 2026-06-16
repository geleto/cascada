# Chain Facts Refactor

## Goal

Separate scheduler facts from broad chain-footprint facts.

Today `usedChains` is overloaded. It includes non-mutating lane participation, mutations, declaration/addressability bookkeeping, and current implementation shortcuts such as `_addChainMutation(...)` also adding the same name to `usedChains`. The command-buffer scheduler needs sharper facts:

- `observedChains`: lanes this node/buffer may participate in without mutating that lane
- `mutatedChains`: lanes this node/buffer may mutate
- `declaredChains`: lanes this node/scope declares
- `usedChains`: broad compatibility footprint equivalent to observed + mutated + declared names

`usedChains` remains important, but it should stop being the authored scheduler input.

## Current State

`src/compiler/analysis.js` currently initializes:

```js
declares: [],
declaresInParent: [],
observes: [],
mutates: [],
declaredChains: null,
observedChains: null,
usedChains: null,
mutatedChains: null,
observedChainsFromParent: null,
usedChainsFromParent: null,
mutatedChainsFromParent: null,
boundaryLinkedChains: null,
boundaryLinkedMutatedChains: null
```

The old overloads were:

- AST analyzers pushed broad facts into `uses`.
- Mutating facts are pushed into `mutates`.
- `_addChainMutation(...)` adds to both `usedChains` and `mutatedChains`.
- `analyzeChainDeclaration(...)` returned `uses: [name]`, even though declaration is not a runtime observation.

The implementation no longer has a `uses` authoring path. Producers classify
their local facts directly as `observes`, `mutates`, or `declares`; broad
`usedChains` is derived during finalization.

`declares`, `declaresInParent`, and finalized `declaredChains` already exist. `declaresInParent` is declaration-placement plumbing, not scheduler capability metadata, and should stay out of the command-buffer scheduler plan.

## Target Facts

AST node analyzers should author:

```text
observes
mutates
declares
```

Finalized analysis should expose:

```text
observedChains
mutatedChains
declaredChains
usedChains
observedChainsFromParent
mutatedChainsFromParent
usedChainsFromParent
boundaryLinkedChains
```

`usedChains` is maintained as broad compatibility metadata during finalization, with this semantic meaning:

```text
usedChains = observedChains union mutatedChains union declared chain names
```

`usedChainsFromParent` is the same broad footprint after locally declared names are removed. This is load-bearing today: inheritance, guard recovery, loop poison handling, validation, and macro caller detection consume it. The derived replacement must be semantically identical to the old footprint before those consumers move.

## Parent Facts

Use three distinct layers:

```text
owned classification: observedChains / mutatedChains
parent classification: observedChainsFromParent / mutatedChainsFromParent
parent placement: boundaryLinkedChains
```

`observedChainsFromParent` and `mutatedChainsFromParent` are the shadowing-safe facts a parent scheduler should use when deciding whether a child buffer lane is observable, mutable, or mixed. They are the owned facts minus locally declared chain names:

```text
observedChainsFromParent = observedChains minus locally declared chains
mutatedChainsFromParent  = mutatedChains minus locally declared chains
usedChainsFromParent     = usedChains minus locally declared chains
```

This matters because a child can declare local `x` while the parent also has a lane named `x`. Raw `child.observedChains.has("x")` would then be a false positive for the parent lane. Either use these `*FromParent` facts or move to true resolved chain identities everywhere; do not use raw name membership across a parent/child boundary.

`boundaryLinkedChains` decides whether the child buffer is inserted into a parent lane. It is derived from `usedChainsFromParent` for linkable child buffers:

```text
boundaryLinkedChains = parent-visible projection of usedChainsFromParent
```

Do not add `linkedObservedChains` as a scheduler input. Parent phase classification uses `observedChainsFromParent` / `mutatedChainsFromParent`; parent placement uses `boundaryLinkedChains`. If existing code still needs `boundaryLinkedMutatedChains` during migration, keep it as a temporary compatibility field derived from `mutatedChainsFromParent`, then remove or rename it when the command-buffer scheduler consumes the new facts directly.

The current implementation carries placement to runtime through `boundaryLinkedChains`
and the temporary `boundaryLinkedMutatedChains` compatibility bridge. It does not emit a
runtime `linkedObservedChains`; scheduler work that needs read-only
classification should consume `observedChainsFromParent` from analysis, with
`boundaryLinkedChains` remaining only the placement set.

## Producer Classification

The risky migration was every old `{ uses, mutates }` producer. Do not
mechanically classify broad participation as `observes`; classify by emitted
runtime behavior:

| Current producer | Target facts |
| --- | --- |
| chain declarations in `chain.js` | `declares`; derived `usedChains` includes the declared name, but this is not `observes` |
| chain `snapshot`, `isError`, `getError`, and sequence get/status reads | `observes` |
| ordinary chain mutation commands | `mutates`; add `observes` only if the command also schedules non-mutating source-order work on that lane |
| template output, include output, call-extension text output | `mutates` for the text lane |
| return statements | `mutates` for the return lane |
| `isReturnUnset()` | `observes` for the return lane |
| variable/bare-name lookups that read a declared chain | `observes` |
| assignments, including shared set paths | `mutates` for the assigned lane |
| declarations with initializers, such as `var x = 5` | `declares` plus `mutates`; a value command is emitted for the initialized variable |
| imported callable and caller scheduling lanes | classify each touched lane by the boundary/command it actually schedules: non-mutating source-order participation is `observes`, writes are `mutates` |
| sequence lock lookups | setup metadata stays in `sequenceLocks`; status/get-like checks are `observes`; sequential calls or repairs are `mutates` |

The table is intentionally behavior-based. If a site exists only to keep a boundary attached to a lane without changing it, that is an observation in scheduler terms even if it is not a data read. If a site exists only for declaration placement or validation, keep it out of scheduler facts and preserve it through derived broad footprint data if needed.

Compound chain/component call paths use `operationOwnedPath` on the AST nodes
that make up the already-classified static target. This suppresses ordinary
per-segment lookup observations so the root is not double-counted. Dynamic
lookup keys must not be marked this way because they are real expression
inputs.

## Finalization

The aggregate should track observation and mutation independently:

```js
{
  observedChains: new Set(),
  usedChains: new Set(),
  mutatedChains: new Set()
}
```

Mutation must not imply observation:

```js
function addChainMutation(usage, name) {
  if (name) {
    usage.mutatedChains.add(name);
    usage.usedChains.add(name);
  }
}
```

Broad use is the compatibility footprint. It is updated by observation and
mutation helpers, and finalized declarations add their names directly to
`usedChains`. This keeps current source-order behavior without reintroducing
declarations as scheduler observations.

`usedChains` is derived from observations, mutations, and finalized
declarations. New producer sites should not author broad-use facts directly.

## Validation

Validation should use the narrow facts that match the question:

- missing read/source-order participation: `observes`
- invalid write/read-only boundary checks: `mutates`
- declaration conflicts: `declares` / `declaredChains`
- compatibility consumers that need broad footprint: derived `usedChains` / `usedChainsFromParent`

Do not use broad `usedChains` for scheduler phase classification.

## Migration Plan

1. Add `observes: []`, finalized `observedChains`, and finalized `observedChainsFromParent` alongside mutation facts.
2. Add helper accessors for `observedChainsFromParent` and `mutatedChainsFromParent`.
3. Migrate producer sites in the classification table by emitted runtime behavior.
4. Keep `declares`, `declaresInParent`, and finalized `declaredChains` unchanged.
5. Preserve `usedChains` / `usedChainsFromParent` as broad compatibility footprints with semantics equivalent to observed + mutated + declared names.
6. Derive `boundaryLinkedChains` from `usedChainsFromParent`.
7. Keep `boundaryLinkedMutatedChains` only as a compatibility bridge if current emit/runtime paths still need it; do not introduce `linkedObservedChains`.
8. Future scheduler work should consume placement via `boundaryLinkedChains` and phase classification from `observedChainsFromParent` / `mutatedChainsFromParent` (or owned `observedChains` / `mutatedChains` for local starts). The current runtime construction keeps only `boundaryLinkedChains` and temporary `boundaryLinkedMutatedChains` metadata.

## Focused Tests

- declarations appear in `declaredChains` and derived `usedChains`, but not `observedChains`
- mutating commands appear in `mutatedChains` without being forced into `observedChains`
- snapshot/error/sequence-read commands appear in `observedChains` without `mutatedChains`
- lanes that both observe and mutate appear in both sets
- local declarations are removed from `observedChainsFromParent`, `mutatedChainsFromParent`, and `usedChainsFromParent`
- parent scheduling classifies child lanes from `observedChainsFromParent` / `mutatedChainsFromParent`, not raw child facts
- local-name shadowing does not make a child-local lane visible as a parent lane
- `boundaryLinkedChains` controls placement only and is derived from `usedChainsFromParent`
- owned `start(chainName)` classification sees local observed/mutated facts even when the chain is not parent-visible
- derived `usedChains` equals the old `usedChains` footprint on a representative script/template corpus
- derived `usedChainsFromParent` equals the old `usedChainsFromParent` footprint on the same corpus
