# Analysis Audit — Round 2: Specific Issues

Follow-on to [`analysis-audit.md`](analysis-audit.md). That audit named fact
lifecycles and split ambiguous facts; all seven items are implemented. This
round is a line-level review of the analysis pass (`src/compiler/analysis.js`)
and its direct fact consumers, looking for concrete bugs, simplifications, and
cleanups. Every item below points at specific code; findings were verified
against the current green suite (`chains-explicit`, `script`, `loader`,
`macros` all passing).

Ordered by severity, then by shared substrate.

---

## 1. Fixed: declaration conflicts follow scope visibility

**Class:** mixed. The `Import`/`FromImport`/`Component`/`CallAssign` gap is a
proxy-dispatch bug: conflict validation keys off node typename / ad-hoc
explicitness instead of the scope visibility model that carries the meaning.
Extending the same visibility rule to loop/each/catch binders is a deliberate
language-design tightening and a user-visible Nunjucks/Jinja compatibility
break.

**Status:** implemented. `src/compiler/analysis.js` now validates declaration
conflicts through scope visibility, `src/compiler/macro.js` validates
macro/caller parameter producer lists, `src/compiler/inheritance.js` no longer
pairs clean block scopes with `parentReadOnly`, and the language docs document
strict visible-scope shadowing.

### Original Problem

Before this fix, `_validateSourceDeclarationConflict` routed
explicit-declaration conflict validation by typename
([analysis.js:388-397](../../src/compiler/analysis.js#L388)):

```js
if (decl.explicit !== false && (nodeType === 'Set' || nodeType === 'ChainDeclaration')) {
  this._validateExplicitDeclarationConflict(...);
}
```

`Import`, `FromImport`, and script `Component` all create declaration facts
that are explicit by default (`decl.explicit !== false`)
([compiler-async.js:544-576](../../src/compiler/compiler-async.js#L544),
[component.js:10-21](../../src/compiler/component.js#L10)), but none of those
producer typenames is routed through `_validateExplicitDeclarationConflict`.
Duplicate bindings escape compile-time validation entirely: generated code
tries to declare the same runtime lane twice and fails later with a
root/constructor `RuntimeError` such as
`Chain 'lib' was registered more than once on the same CommandBuffer`.

The same typename-dispatch weakness affects `CallAssign`, whose
`analyzeCallAssign` delegates to `assignment.analyzeSet`
([compiler-async.js:152-153](../../src/compiler/compiler-async.js#L152)).
For `varType === 'declaration'`, that analyzer produces `declares` entries
with `explicit: true` ([assignment.js:62](../../src/compiler/assignment.js#L62)).
Set and CallAssign are treated as twins elsewhere:
`_validateMissingDeclaration` matches both typenames
([analysis.js:580](../../src/compiler/analysis.js#L580)). The conflict
dispatch is the outlier. A duplicate explicit declaration introduced through
`CallAssign` is silently skipped: the second install is dropped (first-wins)
and codegen treats the second statement as a reassignment.

### Runtime Duplicate Failures

This gap needs no internal tag and no template-only workaround — it is
reachable from plain script (and template) source exactly as users would
write it. The transpiler's lexical duplicate check
(`ScriptTranspiler.declareChain`,
[script-transpiler.js:251](../../src/language/script-transpiler.js#L251)) only
fires for `var`/chain-declaration tags
([script-transpiler.js:950-996](../../src/language/script-transpiler.js#L950)).
`import`, `from`, and `component` are plain line tags
([script-transpiler.js:98](../../src/language/script-transpiler.js#L98)) that
the transpiler hands straight to the parser with no name registration at all.
These repros compile cleanly and fail only at render time:

```
import "lib.casc" as lib
import "lib.casc" as lib
return lib.greet()
```

and

```
var lib = 1
import "lib.casc" as lib
return lib.greet()
```

both throw `RuntimeError: Chain 'lib' was registered more than once on the
same CommandBuffer` at `[Line 1, Column 0] Root` — no compile error, and the
runtime error carries no line/column for either declaration. `Component`
behaves the same way:

```
var ns = 1
component "Component.script" as ns
return ns.build("Ada")
```

and a duplicate `component "Component.script" as ns` / `component ... as ns`
both throw the same `RuntimeError`, this time at `[Line 1, Column 4]
MethodDefinition` — the constructor entry point, not the duplicate
declaration.

The codegen side is unconditional on both paths: `compileAsyncImport` /
`compileAsyncFromImport` (via `_emitValueImportBinding`,
[composition.js:9-17](../../src/compiler/composition.js#L9)) and
`compileComponent`
([component.js:38](../../src/compiler/component.js#L38)) each emit
`runtime.declareBufferChain(...)` with no duplicate check; the collision is
only caught at runtime by `CommandBuffer._createLane`
([command-buffer.js:52-65](../../src/runtime/command-buffer.js#L52)), which is
the source of the quoted `RuntimeError`.

For `Import`/`FromImport`/`Component`, the missed analysis degrades a
compile-time-diagnosable "already declared" error with source positions into a
positionless or misattributed runtime failure that ordinary script/template
authors can trigger without using any internal syntax.

### CallAssign Duplicate Repro

`CallAssign`'s silent first-wins path is normally masked in script mode.
`call_assign` is a script-only internal tag emitted by the transpiler
([parser.js:322](../../src/language/parser.js#L322)), and the transpiler runs
its own lexical duplicate check first
(`ScriptTranspiler.declareChain`,
[script-transpiler.js:262](../../src/language/script-transpiler.js#L262)), so
`var user = call f() endcall` after `var user = ...` fails in script mode with
the right error. The parser, however, accepts the tag in template mode, where
no transpiler runs:

```
{%- macro greet() -%}hi{%- endmacro -%}
{%- call_assign var user = greet() -%}{%- endcall_assign -%}
{%- call_assign var user = greet() -%}{%- endcall_assign -%}
{{ user }}
```

renders `"hi"` with no error; the equivalent duplicate via `set`/`var` fails
with `Identifier 'user' has already been declared.`

### Implemented Behavior

Source declaration conflict validation now follows scope visibility. The
compiler scope model is:

- `createScope` means the node owns declarations.
- `scopeBoundary` means a clean lexical scope: parent source declarations are
  not visible through ordinary lookup or declaration-conflict checks. This is
  a lexical-source rule, not a promise that root/context exports can never be
  read through the runtime context surface.
- `parentReadOnly` is only meaningful for non-clean closure-like scopes
  (`scopeBoundary: false`) that may read parent declarations but must not
  mutate them. The valid main case is caller/call-block bodies.

The rules are:

1. In a non-clean scope, user-written declarations and binders reject reuse of
   any declaration visible in the current owner or any non-boundary ancestor.
2. In a clean scope (`scopeBoundary: true`), parent declarations are ignored.
   Mechanically, if the declaring owner is a `scopeBoundary`, ancestor
   conflict scanning short-circuits entirely. This is why macro parameters may
   reuse outer names: not because macros get a special exception, but because
   the parent scope is not visible.
3. When scanning ancestors from a non-clean owner, check a boundary ancestor's
   own declarations before stopping. For example, declarations inside a loop
   nested in a macro should still conflict with that macro's parameters, but
   not with declarations outside the macro.
4. No shadowing is allowed inside the visible lexical chain. Explicit
   declarations and binders such as `var`, `call_assign var`, `import`,
   `from import`, `component ... as`, `for`/`each` targets, and `catch`
   bindings reject reuse of visible names. Template `{% set %}` does not need
   a new conflict path: its analyzer already resolves visible names as
   mutations and only creates an implicit declaration when no declaration is
   visible through the same scope-boundary rules. Those implicit declarations
   should still be installed normally so later nested non-clean binders can
   conflict with them. A visible `{% set %}` should only fail through the
   existing mutation validation when it crosses a `parentReadOnly` boundary.
5. Duplicate names introduced by one producer list, such as macro/caller
   parameters or block arguments, are validated by that producer's analyzer.
   Block arguments already did this in `inheritance.js`; macro/caller
   parameters now do the same in `macro.js`.
6. Compiler-internal lanes are not source declarations and are excluded
   from user shadowing checks in both directions: they should not be checked as
   user declarations, and they should not become conflict sources that block a
   later user binder. This covers fixed engine names such as `__return__`,
   `CALLER_SCHED_CHAIN_NAME`, and `__waited__`; the compiler-owned
   `caller` binding is internal so call bodies do not falsely collide with
   their enclosing callable scope. This is only a conflict-check
   exemption: internal declarations must still be installed into
   `sourceVisibleDeclarations` and `declaredChains`, because lookup and
   parent-link derivation rely on those local declarations. In particular, a
   non-clean `Caller` scope declares its own local `__return__`; finalization
   must subtract that local name from parent usage so the caller return lane is
   not linked to the enclosing callable's `__return__`.
7. Redundant `parentReadOnly: true` is removed from analyzers that also set
   `scopeBoundary: true`; keep `parentReadOnly` only on non-clean closure-like
   scopes such as caller/call-block bodies.
8. The language docs are updated with the final scoping rule:
   `docs/cascada/script.md`, `docs/cascada/template.md`, and
   `docs/cascada/cascada-agent.md` document strict visible-scope shadowing and
   clean-scope boundaries.

Under this rule, loop/each targets are not special-cased as allowed shadowing.
Loop bodies are new scopes, but they are not clean scopes, so reusing an outer
visible name should be rejected:

```
var item = "outer"
for item in items
  ...
endfor
```

Macro parameters can reuse an outer name because macros are clean scopes:

```
var item = "outer"
macro render(item)
  ...
endmacro
```

Regressions added in `tests/pasync/declaration-conflicts.js` cover duplicate
template/script call assignments, duplicate import/from-import/component
bindings, non-clean nested reuse, loop-target shadowing rejection,
macro-parameter clean-scope reuse, duplicate caller parameters, caller return
isolation, and the no `scopeBoundary: true` plus `parentReadOnly: true`
invariant. Existing loop tests were updated where they relied on now-invalid
same-name loop shadowing.

**Severity:** medium. `CallAssign`'s gap is internal and masked in script mode
(template-mode-only reachability via the unguarded `call_assign` tag), but
`Import`/`FromImport`/`Component` are reachable from completely ordinary
script and template code — see above — and turn a compile-time-diagnosable
"already declared" error into a positionless or misattributed runtime
`RuntimeError`. The loop/each/catch part is also a breaking scoping change
from idiomatic Nunjucks/Jinja behavior, so it must ship with docs and
regressions that make the divergence explicit.

---

## 2. Invariant-hiding guards that should be deleted

These all contradict the "trust compiler-owned structure / don't hide
invariant violations" rules and survive only as noise.

- **Dead `.size > 0` after normalization.** `_shouldCreateLinkedChildBuffer`
  checks `analysis.linkedMutatedChains !== null && analysis.linkedMutatedChains.size > 0`
  ([analysis.js:880](../../src/compiler/analysis.js#L880)), but by
  construction both `_deriveBoundaryLinkedChains`
  ([analysis.js:777](../../src/compiler/analysis.js#L777)) and
  `_normalizeChainSet` ([analysis.js:798](../../src/compiler/analysis.js#L798))
  return `null` instead of an empty set, and normalization runs before
  `_finalizeBufferCreation`
  ([analysis.js:703-705](../../src/compiler/analysis.js#L703)). `!== null` is
  the whole condition. The same redundant pattern exists at the consumers
  [compiler-base-async.js:188-189](../../src/compiler/compiler-base-async.js#L188)
  and [compiler-base-async.js:550-551](../../src/compiler/compiler-base-async.js#L550)
  (`linkedMutatedChains && linkedMutatedChains.size > 0`). The non-empty-or-null
  invariant is enforced where linked-chain facts are derived or normalized;
  checking size again at each consumer re-blurs it.

- **Defensive existence checks on the compiler.** `this.compiler` is set in
  the constructor and `isReservedDeclarationName` lives on the
  `CompilerCommon` prototype, yet:
  - `_analyzeNode`: `this.compiler && this.compiler[analyzerName]`
    ([analysis.js:126](../../src/compiler/analysis.js#L126));
  - `_postAnalyzeNode`: same ([analysis.js:137](../../src/compiler/analysis.js#L137));
  - `_validateReservedDeclarationName`:
    `!this.compiler || !this.compiler.isReservedDeclarationName || ...`
    ([analysis.js:467](../../src/compiler/analysis.js#L467)).

  All three reduce to a single direct access.

- **Dead root-owner fallbacks.** `analyzeRoot` always sets
  `createScope: true`
  ([compiler-async.js:667](../../src/compiler/compiler-async.js#L667)), so:
  - `getRootScopeOwner`'s `this._getScopeOwner(current || analysis)`
    ([analysis.js:243](../../src/compiler/analysis.js#L243)) — after the walk
    `current` is the root analysis whenever `analysis` is non-null, and both
    are null otherwise; the `|| analysis` is unreachable as a meaningful
    fallback.
  - `_getScopeOwner`'s trailing `return current || analysis`
    ([analysis.js:275](../../src/compiler/analysis.js#L275)) — the walk can
    only exhaust parents if no ancestor up to the root has `createScope`,
    which the root analyzer makes impossible. Returning the input analysis in
    that case silently hands callers a non-scope-owner. Let it return
    `current` and fail loudly if the invariant ever breaks.

- **Redundant falsy-name filters downstream of set construction.**
  `usedChains`/`mutatedChains` filter falsy names once where raw `uses` /
  `mutates` arrays enter ([analysis.js:667-679](../../src/compiler/analysis.js#L667));
  after that, the values are non-empty strings by construction. The re-filters
  in `_deriveChainsFromParent`'s declared-name subtraction
  ([analysis.js:721](../../src/compiler/analysis.js#L721) — install already
  rejects nameless declarations) and `_deriveBoundaryLinkedChains`
  ([analysis.js:772-775](../../src/compiler/analysis.js#L772)) are dead.
  Note: the filters in `_getPropagatedChainUsage`
  ([analysis.js:747-757](../../src/compiler/analysis.js#L747)) are **not**
  dead — they read the raw `localUses`/`localMutates` arrays, which may
  contain falsy entries. Keep those.

- **`markLookupDeclaration`'s `declaration || null`**
  ([analysis.js:193](../../src/compiler/analysis.js#L193)) — `findDeclaration`
  already returns `null`, never `undefined`/falsy-other.

---

## 3. Simplification: `_validateMutations` walks the scope chain twice

([analysis.js:522-523](../../src/compiler/analysis.js#L522))

```js
const declarationOwner = this.findDeclarationOwner(analysis, name);
const declaration = this.findDeclaration(analysis, name);
```

`findDeclaration` internally calls `findDeclarationOwner` again, so every
validated mutation performs the ancestor walk twice, and the combined guard
`!declarationOwner || !declaration` checks two facts that are null together
(an owner is only returned when its map has the name). One walk suffices:

```js
const declarationOwner = this.findDeclarationOwner(analysis, name);
const declaration = declarationOwner
  ? this._getDeclarationMap(declarationOwner).get(name)
  : null;
if (!declaration) { ... }
```

While here: `_validateUses` and `_validateMutations` duplicate the same skip
prologue (falsy name, `!`-prefixed sequence key, current text chain;
[analysis.js:513-521](../../src/compiler/analysis.js#L513) vs
[analysis.js:546-554](../../src/compiler/analysis.js#L546)). A tiny shared
predicate would keep the two loops honest together. Both loops also
re-validate repeated names per occurrence; harmless compile-time cost, noted
only.

---

## 4. Cleanup: triplicated tree-traversal boilerplate

Three methods re-implement the same array/`instanceof nodes.Node` guards and
`node.fields.forEach` recursion:

- `_walk` ([analysis.js:42-66](../../src/compiler/analysis.js#L42));
- `_collectNodes` ([analysis.js:484-501](../../src/compiler/analysis.js#L484));
- `_finalizeChainUsage` ([analysis.js:620-655](../../src/compiler/analysis.js#L620)).

`_collectNodes` exists only to feed `_finalizeDeclarations`
([analysis.js:314-315](../../src/compiler/analysis.js#L314)) and materializes
the entire tree into an array even though the loop body is per-node with no
cross-node lookahead — a direct recursive visit (or one shared
`forEachNode(node, fn)` helper used by both passes) deletes the duplicate
guards and the throwaway array. `_finalizeChainUsage` legitimately differs
(it threads aggregates back up), but its three identical
`{ usedChains: new Set(), mutatedChains: new Set() }` empty-aggregate literals
([analysis.js:622-624](../../src/compiler/analysis.js#L622),
[628-630](../../src/compiler/analysis.js#L628),
[640-643](../../src/compiler/analysis.js#L640)) can share one small factory.

---

## 5. Cleanup: single-use helpers and dead parameters

- **`_cloneDeclaration` double spread.** The only call site is
  `this._cloneDeclaration({ ...decl, declarationOrigin })`
  ([analysis.js:224](../../src/compiler/analysis.js#L224)) — it spreads `decl`
  into a fresh object and then `_cloneDeclaration`
  ([analysis.js:503-505](../../src/compiler/analysis.js#L503)) spreads that
  fresh object again. One spread does the job; the helper no longer names a
  concept the call site doesn't already state.

- **Never-exercised default parameters.** `_normalizeChainSet(value, field =
  'chain set', analysis = null)`
  ([analysis.js:780](../../src/compiler/analysis.js#L780)) and the two throw
  helpers ([analysis.js:824](../../src/compiler/analysis.js#L824),
  [830](../../src/compiler/analysis.js#L830)) declare defaults that no caller
  uses — all call sites pass all arguments.

- **`run()` returns `null` twice**
  ([analysis.js:29-40](../../src/compiler/analysis.js#L29)). Nothing consumes
  the value; make it a plain early `return` / implicit return.

- **Nested ternary in `_ensureAnalysis`.** The
  `inheritedSequenceFunCallLockKey` derivation
  ([analysis.js:71-79](../../src/compiler/analysis.js#L71)) is a
  conditional-inside-conditional expression; an `if`/`else` or a named helper
  (`_inheritSequenceLockKey(parentNode, parentField, parentAnalysis)`) reads
  better and gives the FunCall-callee-path rule a name.

---

## 6. Contract sharp edges to document (no code change)

- **Custom linked facts must be returned, not `addAnalysis`-ed.**
  `_finalizeChainUsage` detects post-analyzer-owned linked facts via
  `hasOwnProperty` on the **returned** facts object
  ([analysis.js:687-694](../../src/compiler/analysis.js#L687)). A
  post-analyzer that writes `node.addAnalysis({ linkedChains })` and returns
  nothing gets its facts silently overwritten by derivation (or nulled by
  `_finalizeBufferCreation`). The one current producer
  ([inheritance.js:110-113](../../src/compiler/inheritance.js#L110)) uses the
  supported return path; the comment in `_postAnalyzeNode` should state the
  return-only rule explicitly so the next producer doesn't learn it from a
  debugging session.

- **`parentReadOnly` is only observed on scope owners.**
  `_passesReadOnlyBoundary` hops scope owner to scope owner
  ([analysis.js:291-300](../../src/compiler/analysis.js#L291)), so the flag is
  invisible on any analysis without `createScope`. Both current setters pair
  it correctly ([macro.js:77](../../src/compiler/macro.js#L77),
  [inheritance.js:484](../../src/compiler/inheritance.js#L484)); the pairing
  requirement deserves one comment at the field declaration.

- **`_normalizeChainSet` misreads `Map` inputs.** The `typeof value.forEach`
  branch ([analysis.js:789](../../src/compiler/analysis.js#L789)) matches
  `Map`, whose `forEach` passes *values* first — a post-analyzer accidentally
  returning a declaration map would have its declaration objects validated as
  chain names, producing a confusing "invalid chain name (object)" error
  rather than "must be a Set, array, or iterable of chain names". Cheap to
  special-case `Map` into the invalid-shape error; at minimum, note it.

- **`run()` is single-shot per tree.** `_ensureAnalysis` spreads the previous
  `_analysis` over fresh defaults
  ([analysis.js:117](../../src/compiler/analysis.js#L117)), so re-running the
  pass over an already-analyzed tree carries stale scope-owner declaration
  maps into the new walk and would fail spuriously on "already declared".
  Current compile flow never re-runs; one comment on `run()` is enough.

---

## Checked and found sound

For completeness, suspicious-looking spots that turned out correct:

- **Shared declarations are installed twice** (walk-time
  `sourceVisibleDeclarations` + finalized `declaredChains`), so
  `registerRootSharedDeclaration` is called twice per declaration — but it is
  idempotent by object identity
  ([inheritance.js:100-105](../../src/compiler/inheritance.js#L100)) and
  shared declarations are deliberately stored un-cloned, so both calls see the
  same reference. No double registration.
- **Same-origin duplicate declarations** (`var x, x = 100`, duplicate macro
  params `function f(a, a)`) are both rejected — the former by the transpiler,
  the latter by `_validateMacroDeclarationConflict`'s same-origin branch.
- **Walk-time vs finalized declaration clones** are distinct objects, but
  `declarationOrigin` always carries the *analysis object* (never cloned), so
  assignment target ownership checks hold across the table rebuild.
- **`_deriveChainsFromParent` subtracting finalized `declaredChains`** cannot
  strip a legitimately-outer chain: explicit shadowing is rejected by
  `_validateAncestorDeclarationConflicts`, so a name cannot be both an outer
  reference and a later local declaration in the same scope.
