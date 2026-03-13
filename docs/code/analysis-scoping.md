# Analysis-Owned Scoping Plan

## Purpose
Move lexical scoping and declaration semantics out of compiler frame state and into analysis.

The compiler should stop asking frames semantic questions like:
- is this name declared here?
- is this declaration visible here?
- is this assignment allowed here?
- does this declaration shadow another declaration?

Those are static questions. They should be answered once in analysis, then consumed by:
- the rename pass,
- code generation,
- validation/error reporting.

## Core Principle
Static analysis owns lexical truth.

That means:
- source AST nodes always have `_analysis`,
- semantic declaration lookup is analysis-only,
- compiler frame state is not a source of truth for lexical scoping,
- runtime executes already-resolved names and buffers; it does not decide scope rules.

Initial-step rule:
- semantic lookup helpers belong to analysis, not compiler modules.

That means helpers like:
- `_getOutputDeclaration`
- compiler `_isDeclared`
- `_nodeDeclaresOutput`
- `_isOutputDeclaredInCurrentScope`
- `compile-async._getDeclaredOutput`
- compiler-side guard declaration/category helpers that answer "what kind of name is this here?"

are transitional only and should be removed.

The target shape is:
- `analysis.getDeclaration(node, name)`
- `analysis.isDeclared(node, name)`

and compiler code should call those directly.

More concretely, the compiler should stop owning source-node semantic wrappers like:
- `_nodeDeclaresOutput(node, name)`
- `_getOutputDeclaration(node, frame, name, excludeLocalDeclarations = false)`
- `_isOutputDeclaredInCurrentScope(node, frame, name)`
- `_isDeclared(frame, name, node = null)`
- `compile-async._getDeclaredOutput(frame, name)` when used for source declarations

Those helpers currently mix:
- analysis-backed lexical meaning,
- frame-backed declaration state,
- and some local compile-time fallback logic.

The target shape is:
- analysis answers declaration ownership and visibility for source nodes,
- compiler only uses analysis for source-node semantic questions,
- frame helpers remain only for synthetic runtime-only declarations during transition.

## Why Rename Still Exists
Analysis replaces most scoping logic, but it does not remove the need for renaming.

Rename is still needed because not every lexical scope gets its own command buffer.
Multiple declarations from different lexical scopes can still end up writing into the same runtime handler namespace.

So there are two separate problems:

### 1. Semantic conflicts
These are real language errors and belong in analysis:
- duplicate declarations in the same lexical scope,
- illegal shadowing,
- undeclared assignment in script mode,
- reserved-name usage,
- output/variable name conflicts.

### 2. Runtime handler collisions
These are not semantic errors.
They happen because different scopes may share one effective command buffer / handler namespace.

That is why rename is still needed:
- it disambiguates declarations from different scopes that would collide at runtime,
- it rewrites both AST names and analysis-owned names,
- it runs after analysis because it depends on declaration ownership and visibility.

Comment:
Rename is not a substitute for scoping.
Rename solves runtime name collisions after analysis has already decided the lexical meaning of each declaration and use.

## Architectural Target

### Analysis owns
- declaration ownership,
- declaration visibility at a node,
- missing declaration errors,
- same-scope duplicate declaration errors,
- shadowing errors,
- output/variable conflict errors,
- read-only outer mutation validation,
- declaration metadata used by rename,
- `usedOutputs` / `mutatedOutputs`,
- current text output for a node,
- sequence semantic metadata.

### Rename owns
- disambiguating declarations from different scopes when they share runtime handler space,
- rewriting AST names,
- rewriting analysis names,
- preserving source-name mapping for diagnostics.

### Compiler owns
- code emission only,
- consuming analysis facts,
- consuming rename results,
- creating runtime buffers and commands,
- synthetic runtime-only declarations if they truly do not correspond to source declarations.

### Runtime owns
- executing commands,
- ordering,
- snapshots,
- flattening,
- poison behavior,
- no lexical scoping decisions.

## Static Checks That Should Move Into Analysis
This is the full target list for declaration/scoping checks.

### Declaration validity
- same-scope duplicate declaration of variable
- same-scope duplicate declaration of output
- same-scope duplicate declaration across variable/output namespaces when forbidden
- reserved-name declaration
- illegal declaration kind for the node/mode

### Visibility and missing declarations
- assignment to undeclared variable in script mode
- assignment to undeclared output
- guard selector variable must be declared
- sequence root must not resolve to a local variable/output when only context paths are allowed
- symbol resolution category at a node:
  - local variable
  - visible output
  - context/global
  - unresolved

### Shadowing
- declaration shadows parent variable when forbidden
- declaration shadows parent output when forbidden
- declaration shadows sequence root when forbidden
- declaration shadows special runtime-owned names when forbidden

### Cross-namespace conflicts
- variable declaration conflicts with visible output
- output declaration conflicts with visible variable
- macro parameter conflicts with output
- macro parameter conflicts with reserved name
- macro parameter duplicates

### Mutation legality
- mutation of read-only outer binding
- mutation of outer binding from detached scope when forbidden
- set target legality based on declaration visibility at the node
- guard/write validation against actual visible declaration kind

### Scope export/publication
- declaration stays local to declaring scope by default
- declaration published to parent only when analysis says so
- macro names become visible in parent scope
- recovery error variable belongs to recovery scope

## What Analysis Must Provide
Analysis needs stricter APIs than it has now.

These APIs should operate on analysis-owned data only.
They should not fall back to frame state.

Recommended shape:
- `analysis.getDeclaration(node, name)`
- `analysis.isDeclared(node, name)`
- `analysis.getDeclarationOwner(node, name)`
- `analysis.getCurrentScope(node)`
- `analysis.getCurrentTextOutput(node)`

Initial-step guarantee:
- the analysis pass must attach `_analysis` to every source AST node before any compile-time semantic lookup is allowed.

That means:
- source-node semantic helpers must not accept missing `_analysis` as normal,
- `!node` / `!node._analysis` defensive fallback is not part of the target design,
- if a source node reaches semantic lookup without `_analysis`, that is a compiler bug.

Comment:
These APIs must mean "visible at this exact node", not merely "declared somewhere in the final scope".

That distinction matters because declaration order still exists in the source language.
If a declaration appears later in the same scope, it must not be treated as already visible earlier.

## Position-Aware Declaration Visibility
Analysis cannot just build final scope maps and call it done.

It must also answer:
- is this declaration visible at this node position?

Without that, the compiler keeps needing frame-based fallback for cases like:
- template auto-declare vs assignment,
- early reads before declaration,
- set target validation,
- same-scope declaration ordering.

So analysis needs program-point visibility, not just scope ownership.

Possible implementation directions:
- declaration index/order attached during analysis walk,
- per-node visible declaration map,
- or a declaration chain lookup that respects source order.

The exact representation is flexible.
The important part is semantic meaning:
- `analysis.isDeclared(node, name)` must be correct for this node position.

## Migration Plan

### Phase 1: Strict analysis APIs
Goal:
- stop mixing frame and analysis lookup helpers.

Work:
- require `_analysis` on all source AST nodes before codegen,
- make analysis lookup helpers strict,
- move semantic declaration helpers into analysis,
- stop adding new compiler-side semantic helpers,
- treat compiler helpers like `_getOutputDeclaration` and compiler `_isDeclared` as temporary bridges to be removed,
- treat related compiler semantic wrappers like `_nodeDeclaresOutput`, `_isOutputDeclaredInCurrentScope`, and source-level uses of `compile-async._getDeclaredOutput` as temporary bridges too,
- remove defensive `!node` / `!node._analysis` handling in semantic APIs,
- define node-position-aware declaration lookup semantics.

Acceptance:
- source-node semantic lookup never falls back to frames,
- missing `_analysis` is treated as compiler bug,
- semantic lookup APIs live in analysis,
- compiler modules do not define parallel semantic lookup wrappers.

### Phase 2: Move declaration errors into analysis
Goal:
- analysis reports semantic declaration/scoping errors directly.

Work:
- move duplicate declaration checks into analysis,
- move shadowing checks into analysis,
- move missing declaration checks into analysis,
- move output/variable conflict checks into analysis,
- move read-only outer mutation checks into analysis.

Acceptance:
- compiler no longer performs these semantic checks for source nodes,
- tests fail from analysis stage with same or clearer errors.

### Phase 3: Reduce compiler declaration helpers
Goal:
- remove compiler semantic wrappers like `_getOutputDeclaration` and `_isDeclared`.

Work:
- replace compiler semantic call sites with direct analysis APIs,
- keep only runtime-emission helpers in compiler,
- remove frame-backed semantic fallbacks,
- remove compiler-owned semantic declaration wrappers entirely.

Acceptance:
- compiler declaration logic reads analysis only,
- `_getOutputDeclaration` and compiler `_isDeclared` are gone for source-node semantics.

### Phase 4: Rename pass consumes analysis
Goal:
- make rename the only runtime-name disambiguation phase.

Work:
- analysis marks declaration ownership and rename candidates,
- rename rewrites AST + analysis names,
- compiler consumes already-renamed names,
- only include aliases remain as boundary translation.

Acceptance:
- no compiler/runtime rename logic outside include boundary aliases,
- duplicate same-scope declarations are analysis errors,
- different-scope shared-buffer collisions are solved by rename.

### Phase 5: Remove frame semantic declarations
Goal:
- frames stop being used for semantic declaration lookup.

Work:
- keep frame declaration state only if needed as:
  - analysis mirror during transition, or
  - synthetic runtime-only declaration bookkeeping,
- remove semantic reads of `frame.declaredOutputs`,
- isolate include as the last exception if still deferred.

Acceptance:
- compiler does not ask frame semantic declaration questions for source nodes,
- frame state is runtime/emission-oriented only.

## Comments For Future Code
These comments should exist near the relevant implementation once this plan is executed.

### Comment near analysis declaration lookup
```js
// Declaration visibility is analysis-owned.
// This lookup answers whether a name is visible at this exact node position,
// not whether it exists somewhere in the final scope map.
```

### Comment near rename pass
```js
// Rename is still required after analysis because multiple lexical scopes can
// share one runtime command buffer/handler namespace. Analysis decides lexical
// meaning first; rename only disambiguates runtime names for non-conflicting
// declarations from different scopes.
```

### Comment near compiler codegen
```js
// The compiler does not infer scoping rules here.
// It consumes analysis/rename results and emits runtime commands only.
```

## Non-Goals
- This plan does not require cross-file include analysis.
- This plan does not move runtime ordering logic into analysis.
- This plan does not remove include boundary aliases.

## Definition of Done
This migration is done when:
- source-node declaration/scoping semantics are analysis-owned,
- rename is the only non-include runtime-name disambiguation phase,
- compiler no longer mixes frame and analysis semantic lookup,
- semantic lookup helpers live in analysis rather than compiler modules,
- `_analysis` is guaranteed on source AST nodes before semantic lookup,
- frame declaration state is no longer a semantic source of truth,
- duplicate same-scope declarations are analysis errors,
- different-scope shared-buffer collisions are handled by rename,
- existing scoping/output/sequence tests pass without frame-based semantic fallback.
