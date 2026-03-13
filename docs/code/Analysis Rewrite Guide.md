# Analysis Rewrite Guide

## Purpose

This document guides the implementation of the output-analysis migration starting from the pre-analysis baseline.

Use `src/analysis/*` as architectural reference material.

## Scope

The rewrite concerns:

- `src/compiler/compiler.js`
- `src/compiler/compiler-base.js`
- `src/compiler/compile-analysis.js`
- `src/compiler/compile-buffer.js`
- `src/compiler/compile-emit.js`
- `src/compiler/compile-loop.js`
- `src/compiler/compile-inheritance.js`
- `src/transformer.js`
- `src/nodes.js`

`src/analysis/*` is reference material only.

Do not ship the implementation by directly using the `src/analysis` files as runtime compiler files.

## Target Outcome

The rewrite is complete when:

1. `usedOutputs` and `mutatedOutputs` are computed in analysis, not on the fly while compiling, except for the existing include-specific visible-var composition path
2. live compiler code follows the cleaner `src/analysis` architectural style where appropriate
3. known semantic bugs in the `src/analysis` approach are explicitly patched
4. `src/analysis/*` remains in the repo as reference material unless separately removed
5. `npm run test:quick` passes

## Core Principle

Treat `src/analysis` as:

- the source of architectural approach
- not the source of final semantics

The correct final design is a merge of:

1. `src/analysis` phase structure
2. the known semantic fixes listed below

## Primary Rewrite Rule

Apply the rewrite in two layers:

1. copy all `analyzeXXX` and `finalizeAnalyzeXXX` methods from `src/analysis/compiler.js` and `src/analysis/compiler-base.js` verbatim
2. apply the required semantic bug fixes afterward as an explicit patch layer

This rule is the default unless a specific method is already known to require an immediate correction during copy.

Important:

- "verbatim" applies to the analyze/finalize methods themselves, including comments
- it does not require surrounding compile/runtime wiring to be copied verbatim
- deviations from the copied methods should be treated as explicit bug fixes, not silent cleanup

## What To Copy From `src/analysis`

These are the parts worth reproducing closely.

### 1. Analysis pass structure

Use the `src/analysis/compile-analysis.js` structure as the template for:

1. `_walk(...)`
2. `_ensureAnalysis(...)`
3. `_analyzeNode(...)`
4. `_finalizeNode(...)`
5. `_finalizeAggregates(...)`
6. `_finalizeNodeOutputAggregates(...)`
7. visible declaration lookup helpers

The live rewrite should preserve the same overall phase shape:

1. traverse
2. analyze
3. finalize node-specific derived facts
4. finalize recursive aggregates

### 2. Analyze methods in compiler/compiler-base

Copy the `analyzeXXX` and `finalizeAnalyzeXXX` methods from `src/analysis/compiler.js` and `src/analysis/compiler-base.js` verbatim.

Important:

- comments must be preserved
- do not paraphrase the copied analyze/finalize methods
- do not silently improve them during copy
- any required behavior change belongs in the semantic patch layer

Everything else can be adapted as needed.

### 3. Finalize-driven derived metadata

The strongest pattern in `src/analysis` is:

- compute complex derived node facts in `finalizeAnalyzeX(...)`
- make compile phase consume those facts

An important example in principle is:

- node-specific finalize-time derived metadata when codegen can consume it directly

This pattern should be the backbone of the rewrite.

### 4. Direct node-owned metadata consumption

Keep the design where compile-time code consumes `node._analysis` facts directly or through minimal shaping helpers.

Do not introduce:

- old compile-time output registration logic
- broad fallback-based frame inference

## What Not To Copy Blindly

These pieces from `src/analysis` are known to be semantically wrong unless patched.

### 1. `Block` as hard scope boundary

`src/analysis`:

- `analyzeBlock() -> { createScope: true, scopeBoundary: true }`

Do not keep this unchanged.

### 2. `Capture` as hard scope boundary

`src/analysis`:

- `analyzeCapture() -> { createScope: true, scopeBoundary: true }`

Do not keep this unchanged.

### 3. Include analysis without visible-var reads

Do not treat include as part of the current migration target.

For now, keep the existing include implementation that discovers visible declared `var` outputs at compile time via frame state.

This remains an intentional exception to the broader analysis-owned semantics direction until include is refactored separately.

### 4. Fake AST loop handling

Do not preserve any approach that fabricates fake AST nodes for `while` lowering.

### 5. Older hidden-child traversal assumptions

Do not preserve traversal assumptions that rely on:

- `Set.body`
- `CallAssign.body`
- `Set.path`

being outside `fields`.

Use the real-field approach.

## Semantic Bugs To Fix During Rewrite

These fixes are required.

### Bug 1: `Block` visibility boundary too strict

Required fix:

- `analyzeBlock()` must remain visibility-permeable for current semantics
- use `scopeBoundary: false`

### Bug 2: `Capture` visibility boundary too strict

Required fix:

- `analyzeCapture()` must remain visibility-permeable for current semantics
- use `scopeBoundary: false`

### Bug 3: Include analysis missing visible declared vars

Status:

- deferred for now

Current decision:

- keep include visible-var handling in compile-time include logic
- do not introduce `analyzeInclude()` as part of this migration
- do not block the analysis-owned `usedOutputs` / `mutatedOutputs` migration on include

### Bug 4: Macro name not published into parent visible scope

Required fix:

- macro name must become visible in the parent analysis scope
- this must happen during analysis, not by compile-time guesswork

### Bug 5: Recovery error variable not declared in analysis

Required fix:

- declare the recovery error binding in analysis for the recovery body scope

### Bug 6: Loop var shadowing in async nested loops

Required fix:

- use canonical runtime names for shadowed async loop vars, e.g. `name#N`
- include visibility logic must map canonical runtime names back to natural names correctly

### Bug 7: Hidden traversal for `Set`/`CallAssign` bodies and `Set.path`

Required fix:

- promote `body` / `path` to real AST fields on the relevant nodes
- then rely on generic traversal

Why this is required:

- `body` and `path` are real AST children semantically
- keeping them outside `fields` forces special-case traversal in analysis and transformer code
- that duplication is fragile and caused missed analysis/rewrites during the first integration
- making them real `fields` lets generic AST traversal work uniformly

Compatibility requirement:

- changing `fields` also changes constructor argument layout for these node classes
- preserve backward compatibility with custom `init()` handling on the affected nodes

### Bug 8: Fake `while` AST lowering

Required fix:

- remove fake AST loop rewriting
- keep `while` compilation using explicit loop options instead

## Architectural Rules

### Rule 1: Analysis owns semantics

Analysis computes:

- declarations
- uses
- mutations
- recursive `usedOutputs`
- recursive `mutatedOutputs`
- derived node metadata that depends only on analysis facts

### Rule 2: Compiler owns shaping only

Compiler/codegen may:

- normalize text handler runtime names
- seed frame metadata from canonical analysis facts

Compiler/codegen must not:

- recompute output semantics
- rediscover mutations/usages by inspecting codegen paths

### Rule 3: Finalize for complex derived facts

If a node needs:

- target expansion
- handler resolution
- sequence lock resolution
- snapshot target derivation

prefer `finalizeAnalyzeX(...)` over compile-time recomputation.

### Rule 4: No abstraction for its own sake

Do not add helper methods merely to replace obvious object literals.

Examples of bad abstraction:

- trivial "scope marker" helpers that are not actually used consistently
- wrappers around `return { createScope: true }`

Explicit raw analysis objects are acceptable and often clearer.

### Rule 5: Special subtree collectors only when justified

Use dedicated collectors such as `_collectGuardBodyFacts(...)` only when:

- generic per-node aggregates are not enough

Do not add extra traversals for convenience.

## Implementation Sequence

Follow this order.

### Phase 1: Reintroduce analysis architecture from `src/analysis`

1. add live `src/compiler/compile-analysis.js` (completed)
2. wire analysis run into compilation (completed)
3. copy all `analyzeXXX` / `finalizeAnalyzeXXX` methods from `src/analysis` into live compiler files verbatim, except obsolete guard-finalization code tied to the abandoned fake-AST guard-lowering path (completed)
4. remove legacy compile-time output registration logic

### Phase 2: Apply the semantic patch list

Apply, in this order:

1. AST field cleanup for `Set` / `CallAssign` (completed)
2. block/capture scope-boundary fixes (completed)
3. include visible-var analysis fix (deferred)
4. macro parent-visibility fix
5. guard recovery error-binding fix
6. canonical async loop shadow naming
7. no-fake-node `while` compilation (completed)

### Phase 3: Move complex remaining compile-time decisions into finalize

1. move remaining justified derived metadata into finalize where it simplifies codegen
2. reduce compile-time semantic decisions in `compileGuard()` only if a cleaner non-fake-node analysis shape emerges
3. audit include/prelink logic for analysis-owned derived facts when include is taken on as a separate rewrite

### Phase 4: Final cleanup

1. keep compiler-side helpers minimal and shaping-only
2. remove transitional comments
3. document scope-boundary rules
4. ensure no legacy compile-time usage/mutation tracking remains

## Test Plan

Run focused suites after each patch cluster, not only at the end.

### Baseline migration checks

1. `tests/explicit-outputs.js`
2. `tests/pasync/script-output.js`
3. `tests/script-transpiler.js`

### Scope and include checks

1. `tests/pasync/loops.js --grep "Loop shadowing include coverage"`
2. `tests/pasync/loader.js --grep "Async Block Tag Tests"`
3. `tests/pasync/composition.js --grep "extends in for loop"`

### Guard checks

1. `tests/poison/guard.js`
2. `tests/explicit-outputs.js --grep "Guard Operations"`

### Loop checks

1. `tests/pasync/loops.js --grep "While Loops"`
2. `tests/pasync/loop-concurrent-limit.js`
3. `tests/pasync/loop-phase1-two-pass.js`

### Poison/integration checks

1. `tests/poison/iterator-integration.js`
2. `tests/poison/sequential-expression.js`
3. `tests/pasync/error-reporting.js`

### Final verification

1. `npm run test:quick`

## Practical Red Flags

Stop and reevaluate if any of the following appear:

1. compile code starts deriving semantics from `frame.usedOutputs` that could have been node metadata, outside the current include exception
2. block/capture/include regressions reappear
3. nested loop shadowing starts relying on lexical names instead of canonical runtime names
4. `while` handling starts reintroducing fake nodes
5. traversal again depends on children not listed in `fields`
6. helper abstractions begin obscuring simple returned analysis objects

## Definition of Done

The rewrite is done when:

1. live compiler uses analysis-owned `usedOutputs` / `mutatedOutputs`
2. no legacy on-the-fly registration helpers remain
3. `src/analysis` architectural strengths are reflected in the live design
4. all required semantic bug fixes are applied, excluding the explicitly deferred include work
5. `npm run test:quick` passes

## Notes For The Implementer

When in doubt:

1. copy architecture from `src/analysis`
2. copy analyze/finalize methods verbatim first
3. apply the listed semantic fixes explicitly
4. treat every deviation as a named patch, not an implicit cleanup
5. prefer explicit code over invented abstraction
6. prefer finalize-time derivation over compile-time rediscovery
