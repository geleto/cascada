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

## 1. Bug: declaration-conflict dispatch skips `CallAssign`

**Class:** the same one the parent audit warned about — a call site keys off a
proxy (node typename) instead of the fact that carries the meaning
(`decl.explicit`).

### Problem

`_validateSourceDeclarationConflict` routes explicit-declaration conflict
validation by typename
([analysis.js:388-397](../../src/compiler/analysis.js#L388)):

```js
if (decl.explicit !== false && (nodeType === 'Set' || nodeType === 'ChainDeclaration')) {
  this._validateExplicitDeclarationConflict(...);
}
```

But `CallAssign` is a declaring form too: `analyzeCallAssign` delegates to the
same `assignment.analyzeSet`
([compiler-async.js:152-153](../../src/compiler/compiler-async.js#L152)),
which produces `declares` entries with `explicit: true` for
`varType === 'declaration'`
([assignment.js:62](../../src/compiler/assignment.js#L62)). The rest of the
pass already treats Set and CallAssign as twins —
`_validateMissingDeclaration` matches both typenames
([analysis.js:580](../../src/compiler/analysis.js#L580)) — but the conflict
dispatch does not. A duplicate explicit declaration introduced through
`CallAssign` is silently skipped: the second install is dropped (first-wins)
and codegen treats the second statement as a reassignment.

### Why it is mostly masked

`call_assign` is a script-only internal tag emitted by the transpiler
([parser.js:322](../../src/language/parser.js#L322)), and the transpiler runs
its own lexical duplicate check first
(`ScriptTranspiler.declareChain`,
[script-transpiler.js:262](../../src/language/script-transpiler.js#L262)), so
`var user = call f() endcall` after `var user = ...` fails in script mode with
the right error. The parser, however, accepts the tag in template mode, where
no transpiler runs. Verified repro:

```
{%- macro greet() -%}hi{%- endmacro -%}
{%- call_assign var user = greet() -%}{%- endcall_assign -%}
{%- call_assign var user = greet() -%}{%- endcall_assign -%}
{{ user }}
```

renders `"hi"` with no error; the equivalent duplicate via `set`/`var` fails
with `Identifier 'user' has already been declared.`

### Action

Dispatch on the declaration fact, not the producer typename: explicit
declarations (`decl.explicit !== false` on a `var`/chain declare) should go
through `_validateExplicitDeclarationConflict` regardless of whether the
producer is `Set`, `ChainDeclaration`, or `CallAssign`. The minimal fix is to
add `'CallAssign'` to the typename check; the better fix removes the typename
proxy so the next declaring form cannot reintroduce the gap (Macro keeps its
own dedicated policy).

Add a regression: template-mode duplicate `call_assign var` must fail with the
same message as the `Set` path, and a script-mode case stays as a guard in
case the transpiler check is ever relaxed.

**Severity:** low (internal tag, masked in script mode) — but it is a real
hole in the only validator that owns this policy.

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
  invariant is already enforced by `_assertFinalizedChainSetFields`; checking
  size again at each consumer re-blurs it.

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
  identity comparisons like `postAnalyzeSet`'s `isOwnDeclaration`
  ([assignment.js:92](../../src/compiler/assignment.js#L92)) hold across the
  table rebuild.
- **`_deriveChainsFromParent` subtracting finalized `declaredChains`** cannot
  strip a legitimately-outer chain: explicit shadowing is rejected by
  `_validateAncestorDeclarationConflicts`, so a name cannot be both an outer
  reference and a later local declaration in the same scope.
