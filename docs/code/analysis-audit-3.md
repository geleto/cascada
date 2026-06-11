# Analysis Audit — Round 3: Uniform Scope Rules, No Shadowing

Follow-on to [`analysis-audit.md`](analysis-audit.md) and
[`analysis-audit-2.md`](analysis-audit-2.md). Round 2 found that
declaration-conflict validation dispatches on producer typenames and misses
producers (`CallAssign`, and — verified since — `Import`, `FromImport`,
`Component`). This round records the language decision that resolves the bug
class wholesale, the validation rework it implies, and a sweep of the analysis
surface for other complexity that exists only to permit selective behavior.

## Language Decision

**No shadowing.** Cascada keeps Nunjucks compatibility where it is free, but
the concurrency model and clean design win when they conflict. A name visible
in a scope may not be redeclared by anything in that scope or a non-clean
child scope — no special cases per producer, no carve-outs per construct.
Selective shadowing is the opinionated rule; uniform rejection is the simple
one, and it deletes implementation complexity rather than adding it.

Verified current behavior this decision changes (all pass today, all become
compile errors):

| Case | Today |
| --- | --- |
| `var item = "outer"` then `for item in items` (script) | allowed, outer restored after loop |
| `{% set item %}` then `{% for item in items %}` (template) | allowed — the Nunjucks idiom |
| Nested loops reusing a target name (`for x ... for x ...`) | allowed, both modes |
| Duplicate `import "..." as lib` / `from ... import hello` | escapes analysis; dies at render with `RuntimeError: Chain 'lib' was registered more than once on the same CommandBuffer` ([command-buffer.js:59](../../src/runtime/command-buffer.js#L59)) |
| `var lib = 1` then `import "..." as lib` (script) | escapes analysis **and** the transpiler; dies at render |
| Duplicate caller args `call (a, a) f()` | silently accepted, last-wins binding |
| Duplicate template-mode `call_assign var` | silently first-wins (round-2 item 1) |

What stays allowed, because clean scopes reset visibility (see model below):
macro parameters reusing an outer name (`var item` + `function render(item)`),
verified working in both modes today.

---

## 1. Rework Conflict Validation Around Visibility

Do not fix round-2 item 1 by expanding the producer-typename allowlist. The
compiler already has the right scope abstraction:

- `createScope` — the node owns declarations.
- `scopeBoundary` — a **clean scope**: parent declarations are not visible
  through declaration lookup or conflict checks. Macros are clean scopes
  ([macro.js:141-148](../../src/compiler/macro.js#L141)); this is why macro
  parameters may reuse outer names without any macro-specific shadowing
  exception.
- `parentReadOnly` — only meaningful for non-clean closure-like scopes
  (`scopeBoundary: false`) that may read parent declarations but must not
  mutate them. The valid main case is caller/call-block bodies
  ([macro.js:74-82](../../src/compiler/macro.js#L74)); the enforcement works
  today (`x = 2` in a call body fails with the read-only error).

### Rules

1. In a non-clean scope, every user-written declaration or binder rejects
   reuse of any declaration visible in the current owner or any non-boundary
   ancestor. This covers `Set`, `CallAssign`, `ChainDeclaration`, `Import`,
   `FromImport`, `Component`, and loop targets uniformly — no typename
   dispatch.
2. In a clean scope (`scopeBoundary: true`), parent declarations are ignored.
3. Duplicate names within one producer list (macro/caller parameters, block
   arguments) are validated by that producer's analyzer. Block arguments
   already do this (`seenBlockArgNames`,
   [inheritance.js:447-460](../../src/compiler/inheritance.js#L447)); macro
   parameters are caught today by the same-origin branch of
   `_validateMacroDeclarationConflict`; caller args are caught by nothing
   (verified: `call (a, a) f()` binds last-wins).
4. Compiler-internal lanes (`decl.internal`) are exempt from user shadowing
   checks, as they are today via the reserved-name bypass.
5. Remove the redundant `parentReadOnly: true` from `analyzeBlock`'s result
   ([inheritance.js:484](../../src/compiler/inheritance.js#L484)), which also
   sets `scopeBoundary: true`. With the boundary in place,
   `_passesReadOnlyBoundary` can only be reached for declarations found
   *inside* the boundary (shared declarations short-circuit earlier), so the
   flag is dead there. After this, `analyzeCaller` is the only
   `parentReadOnly` site, matching its meaning.

### Mechanism gap the rework must close

The clean-scope rule does **not** fall out of the current walk.
`_validateAncestorDeclarationConflicts`
([analysis.js:419-431](../../src/compiler/analysis.js#L419)) starts at
`owner.parent` and never consults the owner's *own* `scopeBoundary` flag —
that is exactly why macro parameters need a bespoke path today. The generic
check must:

- skip ancestor scanning entirely when the declaring scope owner is itself a
  clean scope;
- decide break-semantics when *crossing* a boundary ancestor: today the walk
  checks a boundary ancestor's own declaration map before stopping. Under the
  rework that decision becomes visible for cases like a macro's parameters
  versus an enclosing macro's parameters. Recommendation: a clean scope hides
  everything at and above it; the walk stops *before* reading a boundary
  ancestor's map.

### Caveat for the docs, not the code

Clean scopes are hermetic against lexical ancestors, not against the root
export surface: root-level `var x` is context-exported
(`addDeferredExport`,
[assignment.js:186-188](../../src/compiler/assignment.js#L186)), so a macro
body reads root vars at runtime (verified). A macro body referencing a
*non-root* outer var fails with "Can not look up unknown variable/function"
(verified). Conflict policy is compile-time only; wording in user docs should
not claim macros cannot see root state.

### Regressions

- Template-mode duplicate `call_assign var` fails during analysis; a
  script-mode duplicate stays covered as a guard against transpiler check
  relaxation.
- Duplicate `import` / `from import`, and duplicate or shadowing
  `component ... as ns`, fail during analysis — before runtime chain
  registration. (Component is verified by inspection only: its compile emits
  an unconditional `declareBufferChain`
  ([component.js:38](../../src/compiler/component.js#L38)); add a
  fixture-based repro.)
- `import` / `from import` / `component` nested inside a non-clean block
  rejects reuse of an outer visible name.
- `for` / `each` / `while` loop targets reject reuse of an outer visible
  name; nested loops reusing a target name are rejected.
- Duplicate caller args (`call (a, a) f()`) fail during analysis.
- Macro parameters may reuse an outer name (clean scope).
- Meta: no analyzer result combines `scopeBoundary: true` with
  `parentReadOnly: true`.

---

## 2. Simplification Sweep: Complexity That Only Served Selective Behavior

The same lens applied to the rest of the analysis surface. Items 2.2, 2.3,
2.5, and 2.6 are not breaking changes — they tolerate the selective-shadowing
world and become deletable once it is gone. Items 2.1, 2.4, and 2.7 each
break a Nunjucks idiom and need their own yes/no.

### 2.1 Temporal shadowing: source-order ambient lookup and the dual tables

**The largest item.** Current semantics, pinned by the "Source-order lookup
resolution" tests
([chains-explicit.js:88-150](../../../tests/pasync/chains-explicit.js#L88)):

```
var before = someVar      // resolves to context 'someVar' (ambient)
var someVar = "local"     // same name, same scope, new meaning
```

One name, one scope, two meanings — shadowing along the time axis. Its cost
is the entire dual-table mechanism audit item 4 built: `sourceVisibleDeclarations`
populated during the walk, `declaredChains` rebuilt in
`_finalizeDeclarations`, the `_declarationsFinalized` mode switch in
`_getDeclarationMap` ([analysis.js:232-236](../../src/compiler/analysis.js#L232)),
and the constraint that use/mutation validation must run during the walk.

Cleaner rule: a name declared in a scope has that one meaning for the whole
scope; use-before-declaration is a compile error. Deletes the second table,
the mode switch, and the rebuild, and lets validation move to the
finalization pass.

Open decision: function/macro names should hoist (usable above their
definition), consistent with single-meaning-per-scope. Today a call above the
definition silently dispatches to a same-named *context* function — the most
surprising of the pinned behaviors.

Affected tests: the five source-order tests flip from behavior-preserving to
error-expecting.

### 2.2 The transpiler's parallel scope model

[script-transpiler.js:215-287](../../src/language/script-transpiler.js#L215)
maintains a second implementation of scoping: a `chainScopes` stack whose
`parentAccess: 'inherit' | 'readonly' | 'none'` mirrors
`scopeBoundary`/`parentReadOnly`, same-scope conflict checks, an ancestor
no-shadowing scan, duplicate reserved-name enforcement
([script-transpiler.js:171](../../src/language/script-transpiler.js#L171)),
and verbatim copies of the analysis error messages — with the comment
*"Keep script-transpiler validation aligned with compiler behavior."*

Two owners of one rule is the masked-gap generator from round 2: CallAssign
duplicates were caught only by the transpiler; import duplicates by neither.

The chain-*type* lookup is load-bearing and stays: transpilation is
chain-type-directed (`result.x = v` rewrites differently per chain type,
[script-transpiler.js:1089](../../src/language/script-transpiler.js#L1089)).
The validation throws in `declareChain` and the transpiler-level
reserved-name check are pure duplication; delete them once analysis is the
single owner under the rework. Error positions must be checked when moving
ownership — transpiler errors carry line numbers from the raw script source.

### 2.3 The `explicit: false` flag is vacuous

One reader (`decl.explicit !== false`,
[analysis.js:394](../../src/compiler/analysis.js#L394)); one producer of
`false` (implicit template `set`,
[assignment.js:62](../../src/compiler/assignment.js#L62)). Implicit declares
are only created when no declaration is visible
(`shouldDeclareImplicitTemplateVar` requires `!declaration`), so the conflict
check the flag suppresses can never fire. Delete the flag and the condition;
validate all declares uniformly. Under no-shadowing this also makes "outer
`{% set item %}` blocks a later `for item`" intended rather than accidental.

### 2.4 The reserved-name template carve-out

[analysis.js:470](../../src/compiler/analysis.js#L470): template-mode `var`
declarations may use reserved names — except `context`, except script mode,
except non-var types. Three conditions so templates can write
`{% set data = ... %}`. Uniform rule: reserved is reserved in both modes; the
check becomes one line. Breaking for templates that `set` a reserved name.

### 2.5 The macro-specific conflict branch and `parentOwned`

Under the uniform visibility rule, `_validateMacroDeclarationConflict`
dissolves: parameter-list duplicates move to producer validation (rule 3
above), and macro-name-in-parent conflicts become the generic check.
`parentOwned` loses its conflict role, and `isParentOwnedDeclarationRootOwned`
([analysis.js:282-289](../../src/compiler/analysis.js#L282)) reduces to "is
the declaration owner the root" on the finalized table. Audit item 7 already
named `parentOwned` the best simplification target; the no-shadowing rule is
the precondition it was waiting for.

### 2.6 First-wins installs become assertions

The `if (!declarations.has(decl.name))` guards in
`_registerSourceDeclarations` and `_finalizeDeclarations` silently tolerate
duplicates that escaped validation. Once every producer validates, a
duplicate reaching install is an invariant violation — assert loudly instead
of skipping quietly.

### 2.7 (Separate decision) Implicit template shared declarations

`ensureImplicitTemplateSharedDeclaration` + the `implicitTemplateShared` flag
+ the mid-walk push into `rootOwner.declares` with a manual
`sourceVisibleDeclarations` install
([inheritance.js:75-93](../../src/compiler/inheritance.js#L75) — the sharp
edge round 2 flagged) exist so templates can use `this.x` without declaring
shared state. The uniform rule — explicit shared declarations in both modes —
deletes the whole inference path. This breaks more template-inheritance
surface than the other items; treat it as a language decision, not a cleanup.

---

## Explicitly Kept

- **Caller-body `parentReadOnly`** — a clean rule itself, not a carve-out;
  the one place closure-like scopes are genuinely wanted.
- **Implicit template `set` declaration** — templates need a declaration
  form; only the `explicit` flag around it is dead (2.3).
- **Block/MethodDefinition propagation exception** in
  `_getPropagatedChainUsage` — feature-driven (blocks execute in place and
  contribute output/shared footprints), not compat-driven.
