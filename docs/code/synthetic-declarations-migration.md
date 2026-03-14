# Synthetic Declarations Migration

This document tracks the remaining work needed to remove frame-backed synthetic declaration registration and lookup.

Current direction:
- source-visible declaration semantics are analysis-owned
- synthetic bindings should also be planned by analysis
- compile-time frame declaration maps should eventually disappear

The goal is:
- no frame-backed declaration registration
- no frame-backed declaration lookup
- analysis is the single declaration plan for both source and synthetic bindings

## Current State

Already moved to analysis:
- source declaration ownership and lookup
- source declaration conflicts
- undeclared use/mutation validation
- read-only-boundary mutation validation
- `set` declaration vs assignment semantics
- output declaration ownership
- macro name and macro parameter declarations
- import / from-import declaration ownership

Still frame-backed:
- synthetic declaration registration
- synthetic declaration lookup
- scope validation for synthetic frame registration

## Remaining Synthetic Families

### 1. Macro Invocation Bindings

Current sites:
- [src/compiler/compiler.js](/c:/Projects/cascada/src/compiler/compiler.js)
  - `_declareMacroBindingValueOutput(...)`

Current synthetic names:
- `caller`
- positional macro args
- keyword/default macro args

Why they still exist:
- async macro invocation lowers bindings as var outputs for ordering/readback behavior

Target state:
- analysis plans invocation-local synthetic declarations for macro bodies
- compiler emits runtime registration directly from analysis-owned synthetic declaration metadata
- remove:
  - `_declareMacroBindingValueOutput(...)`
  - `_findSyntheticOutputDeclarationInCurrentScope(...)` dependency from this path

Open design question:
- whether invocation bindings are represented as:
  - normal declarations with `synthetic: true`
  - or a dedicated `syntheticDeclares` list

Recommended analyze owner:
- `analyzeMacro(...)` for body-visible synthetic binding plan
- possibly finalized at call/caller lowering site if runtime names differ per invocation

### 2. Async `set` Declaration-Site Runtime Registration

Current site:
- [src/compiler/compiler.js](/c:/Projects/cascada/src/compiler/compiler.js)
  - `compileAsyncVarSet()`

Current behavior:
- analysis decides whether a `set` is a declaration
- compile still registers a synthetic var output via `_addDeclaredOutput(...)` when the declaration is owned by this node

Target state:
- analysis remains the source of truth for declaration-site ownership
- compiler emits runtime declare directly from analysis result
- no synthetic frame registration needed for the declared var

Needed work:
- remove `_addDeclaredOutput(...)` call from `compileAsyncVarSet()`
- ensure any later compile-time lookup still uses analysis only

Recommended analyze owner:
- already covered by `analyzeSet(...)`

### 3. Guard Synthetic Vars

Current site:
- [src/compiler/compiler.js](/c:/Projects/cascada/src/compiler/compiler.js)
  - guard/recover temp vars such as `node.errorVar`

Why they still exist:
- compiler creates internal variables/outputs to preserve async guard behavior and revert state

Target state:
- analysis marks guard-owned synthetic declarations
- compiler emits runtime declare/init directly from that metadata
- no frame registration for guard internals

Needed work:
- identify all guard-only synthetic names
- declare them from guard analysis/finalization
- replace `_addDeclaredOutput(...)` use with direct runtime emission based on analysis

Recommended analyze owner:
- `analyzeGuard(...)` or `finalizeAnalyzeGuard(...)`

### 4. Loop Synthetic Value Outputs

Current site:
- [src/compiler/compile-loop.js](/c:/Projects/cascada/src/compiler/compile-loop.js)
  - `_declareLoopValueOutput(...)`

Why they still exist:
- async loop lowering exposes loop vars/metadata as output-backed values during iteration

Target state:
- loop analysis owns the synthetic declarations required by lowered async loop bodies
- compile-loop emits runtime declarations directly from analysis
- no frame registration for loop iteration bindings

Needed work:
- identify loop-body-visible synthetic vars that are not already represented in source declarations
- attach them to loop/body analysis
- remove `_declareLoopValueOutput(...)` frame registration

Recommended analyze owner:
- `analyzeFor(...)`
- `analyzeAsyncEach(...)`
- `analyzeAsyncAll(...)`
- `analyzeWhile(...)`
- or loop finalization in [src/compiler/compile-loop.js](/c:/Projects/cascada/src/compiler/compile-loop.js)

### 5. Loop Waited Outputs

Current site:
- [src/compiler/compile-loop.js](/c:/Projects/cascada/src/compiler/compile-loop.js)
  - limited concurrency waited outputs like `__waited__...`

Why they still exist:
- bounded concurrency lowering uses synthetic outputs to coordinate awaited loop-body completion

Target state:
- analysis plans the waited output for bounded loops
- compiler emits it directly without frame declaration bookkeeping

Needed work:
- model waited-output declaration on loop analysis node
- thread runtime name through compile-loop lowering
- remove `_addDeclaredOutput(...)` from bounded loop path

Recommended analyze owner:
- loop analysis/finalization in [src/compiler/compile-loop.js](/c:/Projects/cascada/src/compiler/compile-loop.js)

### 6. Sequential Lock Declarations

Current site:
- [src/compiler/compile-sequential.js](/c:/Projects/cascada/src/compiler/compile-sequential.js)
  - `_addDeclaredOutput(..., 'sequential_path')`

Why they still exist:
- sequence lock keys are still declared through the synthetic frame path

Target state:
- analysis owns synthetic sequential lock declarations just like it already owns sequence usage/mutation metadata
- compile-sequential emits runtime lock declarations directly from analysis

Needed work:
- add synthetic declaration metadata for sequence locks
- keep sequence usage/mutation metadata aligned with the declared synthetic lock names
- remove frame registration for `sequential_path`

Recommended analyze owner:
- sequence metadata annotation/finalization in [src/compiler/compile-analysis.js](/c:/Projects/cascada/src/compiler/compile-analysis.js)
  and [src/compiler/compile-sequential.js](/c:/Projects/cascada/src/compiler/compile-sequential.js)

### 7. Synthetic Collision Reads

Current sites:
- [src/compiler/compiler.js](/c:/Projects/cascada/src/compiler/compiler.js)
  - `_addDeclaredVar(...)`
- [src/compiler/compiler-base.js](/c:/Projects/cascada/src/compiler/compiler-base.js)
  - `_findSyntheticOutputDeclaration(...)`
  - `_findSyntheticOutputDeclarationInCurrentScope(...)`
  - `_isOutputDeclaredInCurrentScope(...)`
- [src/runtime/frame.js](/c:/Projects/cascada/src/runtime/frame.js)
  - synthetic declaration storage/lookups

Why they still exist:
- compile-time synthetic families still read frame registration maps for collision checks

Target state:
- all such reads become analysis lookups over synthetic declaration metadata
- frame storage and lookup helpers are removed

Needed work:
- after each synthetic family is migrated, remove the corresponding lookup consumers
- once no callers remain:
  - delete synthetic declaration helpers from compiler-base
  - delete synthetic declaration storage/helpers from frame

## Recommended Order

1. Async `set` declaration-site runtime registration
- already analysis-driven semantically
- likely the easiest synthetic registration to remove cleanly

2. Guard synthetic vars
- compiler-internal and localized

3. Loop waited outputs
- isolated bounded-concurrency plumbing

4. Sequential lock declarations
- localized to sequence lowering

5. Loop synthetic value outputs
- broader surface area but still loop-local

6. Macro invocation bindings
- most semantically entangled synthetic family

7. Remove synthetic lookup helpers and frame storage
- only after no family still depends on them

## Required Cleanup After Migration

When all synthetic families are analysis-owned:
- remove `_addDeclaredOutput(...)`
- remove `_setSyntheticOutputDeclaration(...)`
- remove `_findSyntheticOutputDeclaration(...)`
- remove `_findSyntheticOutputDeclarationInCurrentScope(...)`
- remove `_isOutputDeclaredInCurrentScope(...)`
- remove synthetic declaration helpers from [src/runtime/frame.js](/c:/Projects/cascada/src/runtime/frame.js)
- remove `validateDeclarationScope(...)`

## Suggested Implementation Pattern

For each family:
1. Add synthetic declaration metadata in the appropriate `analyze...` method or analysis finalizer.
2. Make compile emit runtime declaration/init directly from that metadata.
3. Replace any synthetic lookup reads with analysis lookup on the synthetic metadata.
4. Run the narrow targeted suite for that family.
5. Remove the now-dead frame registration/read path.

## Suggested Targeted Test Matrix

Macro invocation bindings:
- [tests/pasync/macros.js](/c:/Projects/cascada/tests/pasync/macros.js)
- [tests/pasync/script-output.js](/c:/Projects/cascada/tests/pasync/script-output.js)

Async `set` declaration-site registration:
- [tests/pasync/expressions.js](/c:/Projects/cascada/tests/pasync/expressions.js)
- [tests/explicit-outputs.js](/c:/Projects/cascada/tests/explicit-outputs.js)

Guard synthetic vars:
- [tests/poison/guard.js](/c:/Projects/cascada/tests/poison/guard.js)

Loop waited outputs / loop synthetic vars:
- [tests/pasync/loops.js](/c:/Projects/cascada/tests/pasync/loops.js)
- [tests/pasync/loop-concurrent-limit.js](/c:/Projects/cascada/tests/pasync/loop-concurrent-limit.js)
- [tests/pasync/loop-phase1-two-pass.js](/c:/Projects/cascada/tests/pasync/loop-phase1-two-pass.js)

Sequential lock declarations:
- [tests/explicit-outputs.js](/c:/Projects/cascada/tests/explicit-outputs.js)
- [tests/poison/guard.js](/c:/Projects/cascada/tests/poison/guard.js)

Final verification:
- `npm run test:quick`
