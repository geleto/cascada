# Direct Storage Plan

Direct declarations are source-visible names that compile to generated JavaScript variables instead of command-buffer chains.

They are not compiler temporaries. They still participate in Cascada scope lookup, shadowing checks, assignment checks, and export rules. The difference is storage: once analysis resolves a source name to direct storage, codegen emits its `jsVar` directly.

Scope: this plan targets the async compiler. The analysis pass everything here builds on runs only in async mode (`compiler.analysis.run` is gated on `asyncMode`), so sync compilation — frame-backed and Nunjucks-compatible — has no `observes`/`mutates` facts and is untouched by these analysis changes. The only sync contact point is a shared helper or constants file.

## Core Idea

Today many source-visible values are represented as `var` chains because that is the existing universal named-value mechanism. That is correct for mutable or lane-observed values, but too heavy for immutable read-only values.

The target split is:

- `isCompilerInternal`: generated JS names that are not source-visible and bypass source lookup.
- declarations with `storage: DECLARATION_STORAGE.DIRECT`: source-visible names that follow the same lexical scope rules as chains, but are read directly from a generated JS variable.
- declarations with `storage: DECLARATION_STORAGE.CHAIN`: source-visible command-buffer lanes that can be observed, mutated, snapshotted, linked, or exported through buffer state.

Minimal shape:

```js
{
  name: "greet",
  storage: DECLARATION_STORAGE.DIRECT,
  jsVar: "macro_12",
  isMacro: true   // existing flag; macro/import flags carry the category — no new `kind` field
}
```

Once a symbol resolves to this declaration:

```js
compileSymbol(greet) -> emit("macro_12")
```

This has the same codegen shape as `isCompilerInternal`, but keeps source-level rules intact.

There are two independent axes:

- **`storage`** — chain vs direct, set by flag for intrinsics and derived from `mutatedChains` for var-likes (see [Eligibility Derivation](#the-storage-predicate)). Everything downstream — reads, export, the chain-usage purge — keys off `storage`, never the use case.
- **jsVar source** — where a direct declaration's value lives in JS, fixed at the declaration site: a macro funcId, an import's resolved-exports variable, a materialized `const`, or a function/loop parameter. A chain-storage declaration has no `jsVar` at all.

These are orthogonal: `storage` says direct-or-chain; for a direct declaration the site that creates it fixes the `jsVar`. The category (`isMacro` / `imported` / plain var) stays on the existing declaration flags.

## When To Use Direct Storage

Use direct storage when a declaration is value-like and does not need lane behavior: source-visible by name, value available as a JS expression, never reassigned or path-assigned, and not used as a lane (producer/consumer ordering, linked-chain visibility, deferred-export). The single fact-based form of this rule is the predicate in [Eligibility Derivation](#the-storage-predicate); the rest of this section is the *why* behind each conjunct.

Value reads and error inspection do not force chain storage. A direct declaration's symbol read emits the JS value directly, and `value is error` / `value#` pass that value to the runtime value-level helpers (`runtime.isError` / `runtime.peekError`). This matters for macro/function arguments, which can themselves be error values. `.snapshot()` is not a source-level operation on plain `var`s: reject it at compile time on any declared Cascada `var` (chain- or direct-backed) so both have the same surface. This does not affect `obj.snapshot()` where `obj` is an ambient/context value rather than a Cascada declaration. See [Codegen Architecture](#codegen-architecture) for how these lower.

This rule should be derived from finalized universal facts wherever possible: declarations, reads, observations, mutations, chain-command facts, path-assignment facts, and boundary-link facts. Avoid one-off per-node exceptions.

Important distinction: ordinary value reads are not the same thing as lane observations. Today, many declared-symbol reads are recorded as `observes` because the current storage model is chain-backed. The storage decision *is* this distinction: once a name resolves to direct storage, its reads are value reads, and the chain-usage pass removes it from the existing `observes`/`mutates`/`used` facts — there is no separate read-vs-observe fact taxonomy. Without that purge, every read-only var would look chain-observed merely because the old implementation used chains to read it.

## Initial Use Cases

Direct declarations fall into two categories, implemented in this order:

- **Intrinsic** — names that are immutable references by construction; no usage derivation is needed to know they never need a chain, because the value is fixed at the declaration site. Macros, functions, and import namespaces / from-import aliases.
- **Derived** — ordinary variables and callable arguments *proven* read-only from finalized usage. A callable argument is just a variable whose initial value comes from the call site, so it reuses the variable mechanism.

### 1. Macros And Functions (intrinsic)

Best first target. A macro/function declaration creates an immutable callable value.

Current async shape:

```js
runtime.declareBufferChain(currentBuffer, "greet", "var", context, null);
currentBuffer.addCommand(new runtime.VarCommand({ chainName: "greet", args: [macro_12] }), "greet");
```

Target shape:

```js
const macro_12 = runtime.makeMacro(...);
```

The source name `greet` resolves to:

```js
{
  name: "greet",
  storage: DECLARATION_STORAGE.DIRECT,
  jsVar: "macro_12",
  isMacro: true
}
```

The backing `jsVar` is the existing `compiledMacroFuncId`. Direct calls (`greet(...)`) already bind to that funcId through [`_compileDirectMacroCall`](../../src/compiler/call.js) and never read the chain. The `var` chain is read only when the macro is referenced *as a value* — assigned, passed as an argument, or otherwise used as a bare symbol — via `compileSymbol` → `_compileDeclaredSymbolLookup`. That value read is exactly what the `compileSymbol` direct fast path lowers to `macro_12`, so once the name is direct both calls and value references use the funcId and the `declareBufferChain` / `VarCommand` pair is removed entirely.

Root/importable macros export the resolved callable value directly:

```js
context.addResolvedExport("greet", macro_12);
```

This direct export must be used in template mode too. Current template-mode macro export uses `context.addDeferredExport(name, chainName, buffer)`, which requires a backing chain and will fail once macro names stop allocating `var` chains.

Macro/function recursion and sibling calls use the static callable visibility fact, not a body-local source declaration. The source-visible declaration still appears in the surrounding scope at the declaration point for ordinary value visibility, while `visibleCallableDeclarations` makes the callable available across clean callable scopes and throughout the declaring scope.

### 2. Import Namespaces And From-Imports (intrinsic)

`import "x" as ns` and `from "x" import a, b` (all from-import aliases, not only callables) bind immutable references, so they are intrinsic direct declarations in kind. They use the same chain shape as macros today — [`_emitValueImportBinding`](../../src/compiler/composition.js) emits `declareBufferChain` + `VarCommand` seeded with the resolved exports — and the `jsVar` would be that existing resolved-exports variable.

These are immutable (`imported` flag): reassigning `ns` or a from-import alias becomes a compile error through the central validator. That is a behavior change — today they are var-like declarations that could be reassigned — so add tests for the rejection.

Promise and poison are *not* a reason to keep them chain-backed. Like any Cascada value, the import is a JS expression at declaration time — `exportedId` is assigned synchronously (already `.catch`-wrapped) and merely resolves later — and any error surfaces at the consumption point, which resolves the value the same way whether it came from a `jsVar` or a chain snapshot. Two small things to preserve: (1) root-scope export just exports the jsValue directly with `addResolvedExport(name, exportedId)` (as script-mode macros already do) — `exportedId` resolves to the same exports object the chain's `finalSnapshot` would, so no chain is needed; (2) because `exportedId` is already `.catch`-wrapped it resolves (to poison) rather than rejecting, so an unconsumed import should not leak an unhandled rejection — worth a test. Implement after macros with dedicated export tests; see [Exports And Imports](#exports-and-imports).

### 3. Ordinary Read-Only `var` Declarations (derived)

```cascada
var user = fetchUser()
return user.name
```

If `user` is never reassigned and never used as a chain lane, it may be a direct declaration. Promise and poison behavior must remain identical: consumers still receive the same promise/poison value, with errors reported from the same origin.

**Initialization is not a mutation.** `var user = fetchUser()` writes the value once; that write is the chain's *initialization* (emitted as `declareBufferChain` + `VarCommand`, conceptually before the lane exists), not a lane mutation. Only a later reassignment (`user = ...`) or path assignment counts. Today the initializer is recorded as a mutation — [`assignment.js`](../../src/compiler/assignment.js) pushes the name into `mutates` whenever the declaration assigns a value — so every initialized var looks mutated. Deriving read-only storage requires fixing that so initialization does not enter `mutates`. This is the core refactor behind the entire derived category.

### 4. Macro / Function Arguments (derived)

An argument is a variable whose initial value comes from the call site, so it follows the same rule: read-only → direct, reassigned → chain.

```njk
{% macro bump(x) %}{% set x = x + 1 %}{{ x }}{% endmacro %}   {# x reassigned → chain #}
{% macro show(x) %}{{ x }}{% endmacro %}                      {# x read-only → direct #}
```

Arguments use JS-local names `l_<name>` (the real source name with an `l_` prefix), not opaque tmpids — see [`_parseMacroSignature`](../../src/compiler/macro.js). The bare `<name>` is only ever the chain's string key (`runtime.chainLookup("name", …)`), never a JS variable, so a direct argument keeps the `l_` prefix: its `jsVar` is `l_<name>` and `compileSymbol` emits that. A direct read is therefore *more* direct than a chain-backed one — it reads `l_<name>` and skips the chain that value would otherwise seed.

How `l_<name>` is produced differs by argument kind, but the name and the no-chain result are the same:

- **positional** arguments already have an `l_<name>` function parameter — the direct `jsVar` is that parameter, no new variable.
- **keyword** arguments have no parameter; their value is `Object.prototype.hasOwnProperty.call(kwargs, "name") ? kwargs["name"] : <default>`. A direct keyword argument materializes that **once** into a local `const l_<name> = …` (still no chain), exactly the value the chain seed would have used — not inlined per read, so a default with side effects evaluates once.

A chain-backed (mutated) argument keeps feeding `l_<name>` into the chain binding as today; only the storage of the source name differs.

Like a `var` initializer, the argument's initial binding (`l_<name>` → chain seed) is initialization, not a mutation. Today [`_getSetupFacts`](../../src/compiler/macro.js) adds every argument to `mutates`; that must change for the same reason as the `var` initializer above.

**Caller / call-block parameters are arguments too** and follow the same rule: read-only → direct, reassigned or lane-used → chain. Their value source still needs deciding (`_emitCallerBindingValue`), and the caller scheduling lane `__caller__` always stays a chain.

### 5. Loop Variables

This is the `for X in …` target — `item`, or `key`/`value` — the per-iteration binding the loop itself introduces. A `var` declared *inside* the loop body is **not** this: it is an ordinary var (use case 3) with no loop-specific handling — each iteration is a fresh function call, so a body `var` is naturally per-iteration. The `loop` metadata object is also not here; it is already a plain JS `const` (`createLoopBindings`), not a chain.

Loop variables are mutable and handled exactly like an ordinary `var`: direct when the body neither reassigns (`set item = …`) nor path-assigns (`item.x = …`) the target, chain-backed when it does. Both writes contribute to `mutates`; no other chain reason applies (always `var`-typed, never shared/exported, `.snapshot()` rejected, `is error`/`#` value-level, and — see below — no boundary reason). Today the per-iteration seed is recorded as a mutation in [`_collectLoopDeclarationFacts`](../../src/compiler/compiler-async.js); the init-is-not-a-mutation fix applies here too, so an unmutated loop variable derives to direct.

The only loop-specific detail is the value source: a loop variable *is* the per-iteration function parameter (the loop body compiles to a separate function with the loop var as a parameter — [loop.js](../../src/compiler/loop.js)), and the per-iteration `VarCommand` seed (`_emitLoopValueAssignment`) is the initialization a direct variable drops. Closure capture across child buffers is *not* a concern: each iteration is a separate function activation, so a child boundary naturally captures that iteration's value, even under concurrency.

### 6. Internal Setup Values

Most internal declarations — return/wait/caller timing chains, output lanes — are real scheduling lanes and must stay chains (the full list is under [What Not To Convert](#what-not-to-convert)). Convert an internal name to a direct declaration only when it is a simple JS value that never participates in scheduling.

## Scoping And Shadowing

A direct declaration follows the same source visibility rules as a chain declaration — they differ only in storage.

- A scope has one declaration namespace. Two source-visible names with the same name in the same scope are forbidden regardless of kind or storage: var, data/text/sequence chain, macro/function, import namespace, from-import alias, component binding, internal source-visible binding, etc.
- A binding is visible only in the scope that owns it and child scopes that can see that scope.
- Sibling scopes may declare the same name.
- A scope with `scopeBoundary: false` may not shadow a visible binding.
- A clean scope with `scopeBoundary: true` hides parent declarations where the language explicitly allows it, such as macro argument names.
- A direct-storage declaration conflicts with a chain-storage declaration of the same visible name.

Valid sibling macro declarations:

```njk
{% if condition %}
  {% macro greet() %}A{% endmacro %}
  {{ greet() }}
{% else %}
  {% macro greet() %}B{% endmacro %}
  {{ greet() }}
{% endif %}
```

Invalid shadowing:

```njk
{% macro greet() %}root{% endmacro %}

{% if condition %}
  {% macro greet() %}child{% endmacro %}
{% endif %}
```

Invalid leakage:

```njk
{% if condition %}
  {% macro greet() %}A{% endmacro %}
{% endif %}

{{ greet() }}
```

## Analysis Architecture

Use the existing declaration maps. Do not add parallel `directDeclarations` / `sourceVisibleDirectDeclarations` maps.

Add a storage discriminator to declaration objects:

```js
{
  name,
  storage: DECLARATION_STORAGE.CHAIN | DECLARATION_STORAGE.DIRECT,
  type,     // chain declarations only
  jsVar,    // direct declarations only
  // category stays on the existing flags: `isMacro` (macros/functions — `function`
  // is transpiler sugar for `macro`), `imported` (namespaces / from-imports). No new
  // `kind` field; immutability is `isImmutable(decl) = decl.isMacro || decl.imported`.
}
```

The existing declaration flow should continue to own visibility:

- first pass records source-visible declarations for validation and lookup
- finalization installs finalized declarations on scope owners
- symbol compile reads the node's `visibleDeclarations` snapshot directly
- missing-name validation checks declarations before falling back to ambient/context lookup

For explicit direct declarations such as macro/function names, the static callable analysis fact carries the declaration for direct calls.

For derived direct declarations (read-only vars), storage is decided after the first walk because eligibility depends on finalized usage. Prefer keeping one declaration object and setting its `storage` after derivation, so existing `visibleDeclarations`, `visibleCallableDeclarations`, and `declaredChains` entries see the final choice where the name appears in more than one map.

Conflict validation is reused from the existing declaration map:

- direct-storage declaration vs direct-storage declaration
- direct-storage declaration vs chain-storage declaration
- chain-storage declaration vs direct-storage declaration
- all declaration kinds share one same-scope uniqueness rule; do not add a macro-only, import-only, or chain-only namespace

Existing chain-only helpers can remain when the caller truly needs a chain. New source-name checks should inspect `declaration.storage` so direct declarations are not accidentally reported as unknown names.

Eventually rename fields such as `declaredChains` to `declarations` if the mixed storage makes the old name misleading. The rename is cleanup, not a prerequisite for the first macro/function-name implementation.

Do not replace ordinary chain declarations with derived direct storage during the first walk. Eligibility depends on finalized usage facts.

Before derived storage exists, raw chain-use folding must only skip intrinsic
direct declarations (`isMacro` / `imported`). At that point the fold is still
building the mutation facts that derived storage needs, so `isStoredDirectly`
is not a valid general predicate for ordinary vars yet. Phase 3 derives storage
from completed `mutatedChains`, then purges/updates the aggregate
observed/used facts with the final storage predicate.

## Eligibility Derivation

The simplest safe implementation is staged, following the two categories above:

1. Intrinsic: explicit direct storage for macro/function names, then import namespaces / from-imports.
2. Derived: read-only ordinary `var`s, after the initialization-is-not-a-mutation refactor lands and finalized usage proves no lane behavior is needed.
3. Derived: callable arguments, caller arguments, and loop variables, reusing the variable mechanism.

### The storage predicate

Storage is set two ways, depending on whether a declaration is direct *by construction* or *by usage*:

- **Intrinsic — direct by flag.** Macros/functions (`isMacro`) and import namespaces / from-import aliases (`imported`) are direct references by construction. Set `storage = DIRECT` at declaration creation; no usage analysis is involved, and they carry no chain `type` (their value lives in `jsVar`). The assignment validator forbids reassigning them, so they never enter `mutatedChains`.
- **Derived — direct by `mutatedChains`.** A plain var-like declaration — an ordinary `var`, argument, or loop variable: `type === 'var'`, not `shared`, not `internal`, not intrinsic — is direct iff it is never reassigned:

```js
// for a var-typed, non-shared, non-internal, non-intrinsic declaration:
declaration.storage = mutatedChains.has(name)
  ? DECLARATION_STORAGE.CHAIN
  : DECLARATION_STORAGE.DIRECT;
```

`mutatedChains` is the owning scope's accumulated mutations — after the init fix below it holds real source reassignments/path-assignments, anywhere in the scope including nested branches and loops. [What Not To Convert](#what-not-to-convert) is the negation: a non-`var` chain type, shared, internal, or mutated. So `var`s, arguments, and loop variables share one derived test, while macros and namespaces never reach it (they are direct by flag).

Nothing else forces a chain:

- **reads never do** — an ordinary `observes` read, or a boundary-linked read of an immutable value, is satisfied by the JS value and closure capture (see [Codegen Architecture](#codegen-architecture)), not a chain observation;
- **chain operations don't apply** — `.snapshot()` is rejected on declared vars, and `is error` / `#` are value-level;
- **initialization is not a mutation** (next);
- **root export does not force a chain** — a direct root declaration exports its `jsVar` directly (see [Exports And Imports](#exports-and-imports)).

### Initialization is not a mutation

`mutatedChains` must hold only real reassignments — never a declaration's initial value. One principle applies to *every* declaration: **a declaration's initial value is a declaration property, not a lane mutation.** Today five sites violate it by recording the initial write as a mutation. Derived var-likes:

- `var x = value`: [`assignment.js`](../../src/compiler/assignment.js) does `mutates.push(name)` whenever the declaration assigns a value.
- macro/function arguments: [`_getSetupFacts`](../../src/compiler/macro.js) runs `mutated.add(decl.name)` for every argument and caller declaration.
- loop variables: [`_collectLoopDeclarationFacts`](../../src/compiler/compiler-async.js) records the per-iteration seed via `addCommandFacts(body, { mutated: loopVars })`.

Intrinsics:

- macros/functions: [`analyzeMacro`](../../src/compiler/macro.js) returns `mutates: [name]` for the macro name.
- imports / from-imports: [`analyzeImport` / `analyzeFromImport`](../../src/compiler/compiler-async.js) return `mutates: [name]` for each bound name.

Fix all five under the one principle — initialization does not enter `mutates`. For derived var-likes that is what makes `mutatedChains` mean "really reassigned." For intrinsics it is also a correctness requirement: the central immutability validator rejects any reassignment of an `isMacro`/`imported` declaration, so if a macro/import's *own* initial binding were still in `mutates`, the validator would reject the declaration itself — this is why "an immutable declaration is never in `mutates`" must actually hold. The intrinsic removals land in the Phase 1 conversion (the same change that sets `storage = DIRECT`); the derived ones in Phase 2/3. Do not add a `hasPostSetupUserMutation` predicate; just stop conflating init with mutation at each site. Initialization is then emitted as command facts only for declarations that stay chain-backed.

The analysis change and the codegen change are coupled and must land together. `mutates` is AST-derived, so the analysis fix does not depend on codegen — but the reverse does. Once a read-only chain-backed `var` has no mutation fact, its command-buffer lane is specialized observe-only ([`_createLaneEntryWithFacts`](../../src/runtime/command-buffer.js) → [`buffer-lane-entry.js`](../../src/runtime/buffer-lane-entry.js): `observes && !mutates` exposes only `observe`). A `VarCommand` is a mutation command, so emitting the initial value as a `VarCommand` into that lane throws `expected an observable entry`. The initial value must therefore be emitted as a **non-command initializer**, not a `VarCommand`, in the same change that removes initialization from `mutates`:

- Today: `declareBufferChain(..., null)` + a `VarCommand` (mutation command) carrying the initial value.
- Required: `declareBufferChain(buffer, name, "var", context, initialValue)` → `applyChainInitializer` → `setInitialValue`. The value is part of the declaration; no mutation command, so an observe-only lane stays valid.

Mind the initializer argument's semantics: [`declareBufferChain`](../../src/runtime/chains/index.js) applies *any* initializer that is not `undefined`, so today's `null` already seeds the chain with `null` before the `VarCommand` overwrites it — `null` is not "no initializer." The required form passes the real value as the initializer and drops the `VarCommand`; a declaration with no initial value omits the argument (or passes `undefined`) so nothing is seeded. Other `null`-seeded call sites that are not var initial values (internal setup chains, etc.) keep their current behavior.

This reuses initializer plumbing that already exists: `var`'s `applyInitializer` → `setInitialValue` is wired today (used for sentinels like `RETURN_UNSET`). The only new code is factoring `VarCommand`'s value normalization into a shared helper so the initializer behaves like a set. It is also an optimization — read-only chain-backed declarations drop one command each. Do not build a cross-type initializer system now — see [Unified Initialization](#unified-initialization).

### Deciding storage and purging — folded into `_finalizeChainUsage`, no new pass

Use the existing `mutatedChains` fact (post-init-fix); do not build a new source-mutation accumulation, and do not key the decision off `observedChains`/`usedChains` (those count reads). Fold both the storage decision and the purge into [`_finalizeChainUsage`](../../src/compiler/analysis.js), which already walks per scope, children-first. Per scope, in order:

1. assemble the scope's full mutation set — local `mutates` + children's + any post-analysis facts (e.g. `_getSetupFacts`); this *is* `mutatedChains` once complete;
2. decide storage for the scope's derived declarations from that set — a flat iteration over the scope's declarations, no per-node recursion — and set `declaration.storage`;
3. build the scope's observe/use and boundary-linked facts, filtering out direct names so a direct declaration never reaches a chain-lane fact. (A direct name has no chain; a lingering observe/use fact would provision a lane for a chain that is never declared.)

Storage must be decided **after** step 1 (the mutation set isn't complete until local, child, and post-analysis mutations are folded in) and **before** step 3 (so the filter sees final storage).

Purge at the **aggregation**, not on raw `observes`. The filter goes where per-node `observes`/uses fold into `observedChains`/`usedChains` (`_addChainObservation` / `_addBroadChainUse`). The raw per-node `observes` array stays untouched: its only other consumer is `_validateObservations`, which just checks the read name is *declared* — a direct var is, so it passes — and it runs during the walk before storage is decided, so raw `observes` couldn't be purged there anyway. So no `observesStrictly` fact is needed: the existing raw-`observes` (= "this name is read", for validation) vs aggregated-`observedChains` (= "this chain lane is observed", consumed by [`chain.js`](../../src/compiler/chain.js) `getCommandBufferFacts` for child-buffer/lane creation) split already separates the two meanings — only the aggregate is filtered. `mutates` needs no purge (a direct var is never mutated, so it is never in `mutatedChains`).

Do not retain the dropped names in a parallel `observedDirect`/`usedDirect` set either — nothing consumes scope-level "this direct var is read." Closure capture across a child boundary is automatic in generated JS (the child references the `jsVar` and the engine captures it, given the binding is emitted in an enclosing JS scope — a codegen invariant, not a queried fact), and validation already uses raw `observes`. A parallel set would have no reader; just don't add the name to the aggregate.

A direct var's reads are thus absent from the chain facts — codegen emits its `jsVar` instead. No new pass, no new tree recursion, no new accumulation, no new fact: the decision reads `mutatedChains`, and removal is a filter on the sweep that already runs.

### Shared vs per-kind

`var`s, arguments, and loop variables share one mechanism with different value sources. Most of it is shared and must not be forked per kind:

- **Shared:** the storage predicate (keyed on the owning scope's `mutatedChains`, folded into `_finalizeChainUsage`), the read lowering (`compileSymbol` → `jsVar` or snapshot), the chain initializer for survivors, and the central immutability check.
- **Per kind — only the value source and direct `jsVar`:** a `var` body declaration binds an initializer expression to a fresh-tmpid `const`; a positional argument *is* the `l_<name>` parameter; a keyword argument materializes `kwargs[...] ? … : default` into `l_<name>`; a loop variable *is* the per-iteration function parameter — the loop body compiles to a separate function with the loop var as a parameter ([loop.js](../../src/compiler/loop.js)), and the per-iteration seed currently emitted as a `VarCommand` (`_emitLoopValueAssignment`) is the initialization a direct loop variable drops (use case 5).

So implement one binding emitter parameterized by `(declaration, valueExpr, positionNode)` that branches on `declaration.storage` — chain → the unified initializer, direct → reuse the parameter or emit `const jsVar = valueExpr` — and call it from the var, argument, and loop-variable sites. The three "initialization is not a mutation" edits ([`assignment.js`](../../src/compiler/assignment.js), [`_getSetupFacts`](../../src/compiler/macro.js), [`_collectLoopDeclarationFacts`](../../src/compiler/compiler-async.js)) are the same fix at the three value sources.

## Unified Initialization

One shared initialization mechanism is the end goal, but only `var` needs it now, because the types differ in how they hold a value:

| type | initial target | async value | ship-now plan |
|---|---|---|---|
| `var` | may hold a promise | resolved lazily at read | non-command initializer (this work) |
| `data` / `text` | must be fully settled — [`inspectSettledTargetForErrors`](../../src/runtime/chains/data-chain.js) throws on a promise | resolved before seeding | keep current init; TODO to converge |
| `sequence` | promise-tolerant | own lazy `_ensureSequencedObjectResolved` | already deferred; unchanged |
| `sequential_path` | — | — | — |

**`var` — required now.** Removing initialization from `mutates` makes a read-only chain-backed var's lane observe-only, which rejects a `VarCommand`, so the initial value must be a non-command initializer. `var` is promise-friendly: the value goes straight into `_target` and resolves lazily at read, exactly like today's `VarCommand` value, just without the command — so there is no resolve-before-seed and no race. The initializer must apply the same value handling a set does: factor `VarCommand`'s `unwrapResolvedValue` + sync-poison handling + `errorContext` into a shared helper used by both the command `apply` and `setInitialValue`, so a declared initial value behaves exactly like an immediate set. Confirm nothing relies on `VarCommand`'s `initializeIfNotSet`.

**`data` / `text` — defer, with a TODO.** Their `_target` cannot hold a promise yet, so a unified initializer would have to resolve the value before seeding — and resolving eagerly during initialization risks races against the buffer's source-ordered command application. There is no elegant settle-before-seed before `data` `_target` supports promises. So keep the current `data` / `text` initialization for now and leave a TODO in the data chain to move it onto the shared non-command initializer once `_target` holds promises. This is safe because `data` / `text` are never direct and their init classification is unchanged, so their lanes stay mutation-capable and no observe-only-lane conflict arises.

**`sequence` — unchanged.** It already resolves its sequenced object lazily via `_ensureSequencedObjectResolved`.

So the analysis change "initialization is not a mutation" is applied to `var` (and var-backed arguments/locals) now; `data` / `text` / `sequence` keep their current behavior. The only shared code built now is `var`'s value-normalization helper — one path for `VarCommand.apply` and the `var` initializer, so init behaves identically to a set. The cross-type dispatch — a `deferredTarget` policy and wiring `applyInitializer` for every type — is *not* built now; it lands when `data` converges (the TODO), so no universal machinery is written speculatively. Direct declarations need none of this — they are plain JS values with no chain.

## Codegen Architecture

Keep codegen small:

```js
compileSymbol(node) {
  if (node.isCompilerInternal) {
    emit(node.value);
    return;
  }

  const declaration = node._analysis.visibleDeclarations.get(node.value);
  if (declaration && declaration.storage === DECLARATION_STORAGE.DIRECT) {
    emit(declaration.jsVar);
    return;
  }

  // existing chain / ambient lookup
}
```

Generated backing variables can be emitted as ordinary JS variables:

```js
const macro_12 = runtime.makeMacro(...);
```

If an AST node is synthesized to refer directly to `macro_12`, that synthesized symbol may use `isCompilerInternal`. Parsed source symbols such as `greet` must use direct lookup.

Reads, error inspection, and `.snapshot()` all lower through existing chokepoints once `declaration.storage` is final — no new per-node branches:

- Reads: `compileSymbol` (above) emits `declaration.jsVar` for direct storage, or the snapshot/read path for chain-backed `var`.
- `value is error` / `value#`: make `_getObservedChainName` / `_getErrorObservationFacts` return `null` for a direct declaration. `compileIs` / `compilePeekError` already fall back to `runtime.isError(value)` / `runtime.peekError(value)` when there is no observed chain, so neither method needs its own storage check.
- `.snapshot()`: rejected at compile time on declared `var`s. The chokepoint is the chain-operation classification in [`chain.js`](../../src/compiler/chain.js) (`compileChainOperationFunCall` / its `chainOperationCall` analysis): today, when the static root resolves to a `var`, `.snapshot()` returns `false` and falls through to an ordinary method call — instead, fail there. It stays a chain operation only for non-var lanes.

The generated JS declaration kind must match the generated scope. Use `const` for immutable bindings when the binding is emitted exactly once in the owning JS scope. Use `let` if branch/loop codegen needs a declaration shape that is assigned conditionally. Do not widen a binding's JS scope beyond the analyzed Cascada scope merely to make codegen convenient.

### Naming and collision-safety

A `jsVar` must be unique within its JS scope and disjoint from internal/fixed names. The namespaces are already separated: user source names compile to `l_<name>`, generated temporaries to `t_<n>`, macros to `macro_t_<n>` ([`_tmpid`](../../src/compiler/compiler-common.js)). Internal names (`__return__`, `__waited__`, `__caller__`, chain types, `context`, …) are blocked from user declarations by [`isReservedDeclaration`](../../src/compiler/reserved.js) and are chain string-keys, not JS identifiers, so they never clash with a `jsVar`.

No new collision analysis is needed as long as each `jsVar` comes from an already-unique source:

- **macros / functions**: the existing `macro_t_<n>`.
- **arguments and loop variables**: the `jsVar` is the `l_<name>` parameter for a positional argument or loop variable (reused directly), or a freshly materialized `const l_<name>` for a keyword argument. Both are safe because argument names are unique within one signature, and each loop iteration is its own function scope, so nested loops with the same name do not collide.
- **body declarations that can repeat across scopes** (direct `var`s): allocate a fresh `_tmpid()` as `declaration.jsVar`. Do **not** mint a source-derived `l_<name>` for these — sibling or flattened Cascada scopes can put two `var x` in one JS scope, and a body `l_x` could also collide with an argument `l_x`. The source name lives only in `declaration.jsVar` metadata, so the emitted identifier need not be readable.

This keeps names collision-free regardless of how JS blocks map to Cascada scopes; scope still governs closure capture and lifetime (above), just not uniqueness.

A child async boundary reads a direct declaration by JS closure capture, which always yields the correct value: a direct declaration is immutable and its `jsVar` is assigned at the declaration point, before any child boundary that reads it (source order). So there is no extra "must be observed through command-buffer ordering" case for direct declarations — for a var-like, only mutation (the predicate) forces a chain, and a mutated one is already chain-backed. (Forward references / TDZ are handled separately under recursion.)

Recursion and mutual recursion need explicit codegen support:

- self-recursion works when the generated macro function closes over its own `jsVar` and the function is not invoked during initialization
- self-recursion also requires a body-local direct declaration pointing at the same `jsVar`, because macro/function bodies are clean scopes
- mutual recursion is only supported where the current language visibility rules already make both names visible; do not add hoisting as part of this refactor
- forward references are not hoisted by Cascada; preserve current language behavior, but avoid turning an intended compile/unknown-name error into an accidental JS temporal-dead-zone `ReferenceError`

## Assignment Semantics

All write-rejection rules must collapse into the existing single mutation validator, not scatter new checks across `assignment.js`, `loop.js`, `macro.js`, etc. [`_validateMutations`](../../src/compiler/analysis.js) already iterates each name in the `mutates` fact, resolves its declaration, and rejects illegal writes through [`_validateReadOnlyMutation`](../../src/compiler/analysis.js). Extend that one point with an immutability check keyed on the declaration, so these rules share a code path:

- macro/function direct declarations cannot be reassigned
- the existing read-only-scope (call block) and read-only-chain rejections
- shared declarations keep their existing `this.<name>` rule

Derive immutability with a helper over the existing flags — `isImmutable(decl) = decl.isMacro || decl.imported` (macros/functions and import namespaces/aliases are immutable; plain vars are not) — rather than storing a new flag or doing per-feature `role`/storage checks at each call site. No new `kind` field is needed; the flags already carry the category, and the error message is chosen from them.

This composes with the initialization-is-not-a-mutation fix: once initialization is out of `mutates`, every name in `mutates` is a genuine reassignment, so the *same* fact drives both derived-storage derivation and immutability enforcement. An immutable declaration (macro/import) is direct **by flag**, and the validator rejects any reassignment of it — so it can never legally appear in `mutates`, and the derived predicate and immutability never disagree.

Invalid (the error should mention that macro/function declarations cannot be reassigned):

```cascada
function greet()
  return "hi"
endfunction

greet = 123
```

If a name has both a direct-storage declaration and a chain-storage declaration visible, that is an analysis bug unless the language explicitly created a clean scope that hides one of them.

## Exports And Imports

Exporting a root declaration is one rule, keyed on `storage` — not three kind-specific paths:

```js
storage === DIRECT
  ? context.addResolvedExport(name, jsVar)        // value available directly: macro, namespace, read-only var
  : context.addDeferredExport(name, name, buffer) // chain-backed: final value depends on buffer execution
```

So macros, namespaces, and read-only root `var`s all export via `addResolvedExport(name, jsVar)`; only chain-backed values still defer. For a root `var` this replaces the current `addDeferredExport(name, name, buffer)` ([`assignment.js`](../../src/compiler/assignment.js)), which has no chain to resolve once the var is direct. The `jsVar` holds the value (possibly a promise), which resolves the same as the chain's `finalSnapshot` would; if that value can reject and the export may go unconsumed, keep it handled (`markPromiseHandled`), as the deferred path does. A read-only root var that is imported / re-exported needs a test.

Imports continue to work through the existing import/from-import runtime objects. The bound value is already a JS expression at declaration time (`exportedId` is assigned synchronously even though it resolves later), so an import namespace can be a direct declaration whose `jsVar` is that value. Promise and poison are not blockers — they resolve at the consumption point regardless of storage.

Imports are Phase 1 intrinsic direct declarations (implemented after macros, since the load boundary needs its own tests — not deferred to a later phase). The real work is async-load bookkeeping:

- root-scope export: replace `addDeferredExport` (chain `finalSnapshot`) with `addResolvedExport(name, exportedId)` — the jsValue resolves to the same exports object, so no chain is needed.
- `exportedId` is already `.catch`-wrapped, so it resolves (to poison) rather than rejecting; confirm an unconsumed import leaks no unhandled rejection (the chain path used `markPromiseHandled`).

## What Not To Convert

This is just the negation of [the storage predicate](#the-storage-predicate) — a declaration stays a chain when any conjunct fails:

- **non-`var` type** — data/text/sequence chains, and output lanes
- **shared** — shared chains
- **internal** — `__return__`, `__waited__`, `__caller__`, and other scheduling lanes
- **mutated** — reassigned or path-assigned by source

Reads, value-level error checks (`is error` / `#`), and a direct root export do *not* keep a declaration chain-backed (see the predicate's notes). `.snapshot()` is a chain operation only on the non-`var` lanes above; it is rejected on declared `var`s.

## Migration Plan

Three phases, lowest-risk first.

### Phase 1 — Intrinsic (always direct): macros/functions and namespaces

1. Add `DECLARATION_STORAGE` (`CHAIN`, `DIRECT`) constants in `src/compiler/declarations.js`, plus an `isImmutable(decl)` helper over the existing flags (`decl.isMacro || decl.imported`). No new `kind` field.
2. Add `storage` and `jsVar` to declaration objects without changing the existing declaration maps.
3. Add the `compileSymbol` direct-storage fast path after `isCompilerInternal`, before `loop` magic and chain/shared lookup handling.
4. Add the shared chain-usage purge: after storage is finalized, [`_finalizeChainUsage`](../../src/compiler/analysis.js) removes every direct-storage name from the existing `observes`/`used` aggregates, so no lane is provisioned for a chain that doesn't exist. (`mutates`/`mutatedChains` needs no purge — a direct declaration is never reassigned, so it is never there.) This updates the existing facts — *not* a separate read-vs-observe fact taxonomy — and every later phase reuses it. Verify the during-walk validations (`_validateObservations` / `_validateMutations`) tolerate direct names, since they run before this purge.
5. Convert macro/function names to direct-storage declarations in one atomic change:
   - set `storage = DIRECT` and `jsVar = compiledMacroFuncId` on the declaration (the `isMacro` flag already marks the category)
   - remove the macro-name chain declaration and its `mutates: [name]`
   - remove the `declareBufferChain` / `VarCommand` emission
   - keep/add a body-local self direct declaration for recursion (the step-4 purge removes the now-direct name from the chain-usage facts)
6. Export root macro/function direct declarations with `addResolvedExport` in both script and template mode.
7. Reject assignment to macro/function and namespace direct declarations through the central `_validateMutations` check (`isImmutable(decl)`), not a new per-feature check.
8. Convert import namespaces / from-import aliases to direct declarations — export the jsValue directly with `addResolvedExport` (replacing the chain `finalSnapshot` deferred export), and confirm an unconsumed import leaks no unhandled rejection.
9. Remove macro-name parent-owned chain mutation propagation if it becomes dead.
10. Tests: scope, shadowing, recursion, macro/namespace export/import/re-export, and reassignment rejection (macro and namespace).

### Phase 2 — Make `var` initialization non-mutating

Scope this phase to `var` declarations only. Arguments and loop variables are handled in Phase 3: touching their init facts here would make a read-only one an observe-only chain still seeded by a `VarCommand` (which throws), because they aren't converted to direct storage yet. A `var` is safe because Phase 2 converts its seed to an initializer in the same change.

11. Atomic `var` change — initialization stops being a mutation and the initial value stops being a command, together (a now-observe-only lane rejects a `VarCommand`):
    - remove `var x = value` initialization from `mutates` ([`assignment.js`](../../src/compiler/assignment.js))
    - emit the `var` initial value as a non-command initializer that shares `VarCommand`'s value normalization (`setInitialValue` + a shared helper)
    - leave `data` / `text` / `sequence` initialization unchanged; add a TODO in the data chain to converge once `data` `_target` supports promises
12. Tests: observe-only-lane initializer does not throw; initializer normalization parity with a set; no eager promise resolution.

### Phase 3 — Derived (non-mutating var-likes become direct)

13. Fold the storage decision into `_finalizeChainUsage`: apply the predicate per scope using the existing `mutatedChains` (post-Phase-2, init excluded) — a flat iteration over the scope's declarations, no new pass and no new accumulation. The step-4 purge then drops the now-direct names from the chain-usage facts.
14. Convert `var`, arguments, and loop variables **together** (one shared decision + binding emitter — do not split by kind, and do not convert a kind to direct storage whose value-source emitter isn't wired). Each kind's init-is-not-a-mutation fix lands here, atomic with its conversion to direct, so no read-only one is ever an observe-only chain with a command seed:
    - `var`: already non-mutating from Phase 2
    - arguments: remove the per-argument init from [`_getSetupFacts`](../../src/compiler/macro.js); read-only → direct (`jsVar` is the `l_<name>` parameter, or a materialized keyword local), mutated → chain
    - loop variables: remove the per-iteration seed from [`_collectLoopDeclarationFacts`](../../src/compiler/compiler-async.js) (`addCommandFacts(body, { mutated })`); read-only → direct (the iteration parameter), mutated → chain
    - caller arguments follow the argument rule, but decide their value source (`_emitCallerBindingValue` / `__caller__`) when reached
15. Export a root direct `var` with `addResolvedExport(name, jsVar)` instead of the deferred chain export (the one storage-keyed export rule).
16. Rename finalized owner maps such as `declaredChains` to `declarations` once ordinary vars/args/loop vars can also be direct. Do this after every consumer is storage-aware; before Phase 3 the old name is still tolerable, but after mixed storage it is misleading.
17. Tests: derived storage; a nested-branch mutation forces chain; root-var re-export; read-only argument / loop variable; promise/poison parity.

## Tests

### Intrinsic: macros and functions

- root macro declaration and call
- root macro export/import/from-import
- macro declared inside `if` branch visible inside that branch
- macro declared inside `if` branch not visible after the branch
- same macro name allowed in sibling `if` / `else` scopes
- macro name shadowing visible outer declaration rejected
- reassignment of macro name rejected
- macro argument reassignment still allowed
- macro argument may reuse outer names
- caller-capable macros still work
- recursive macro works
- mutually recursive macros work or fail with the same language-level behavior as today
- forward macro reference preserves current behavior and does not become an accidental JS TDZ failure
- nested macro can reference an outer macro when the scope rules allow it
- macro can be passed as a first-class value
- macro passed as a value into an async child boundary (loop body, branch) resolves via JS closure capture
- template-mode macro export works without a backing chain
- macro can be both exported and called locally in the same scope

### Intrinsic: import namespaces and from-imports

- `import "x" as ns` binds `ns` directly with no var chain; `ns.macro()` and `ns.value` still resolve
- `from "x" import a, b` binds `a`/`b` directly; calling an imported macro works
- reassigning an import namespace (`ns = …`) or a from-import alias is a compile error
- an imported name that fails to load still poisons consumers with the original load-failure context
- root-scope imported name still re-exports correctly via `addResolvedExport`
- an unconsumed failed import leaks no unhandled rejection

### Derived: read-only variables and arguments

- read-only `var x = value` compiles to a direct declaration with no `var` chain or `VarCommand`
- `var x = value` then `x = other` stays chain-backed
- read-only positional argument compiles without a var-chain setup command; its `jsVar` is the `l_<name>` parameter
- read-only keyword argument with a default materializes `l_<name>` once (no chain); the default with a side effect evaluates exactly once
- mutated macro argument remains chain-backed
- ordinary value reads do not force a read-only declaration to stay chain-backed
- implicit var reads do not require chain-backed storage
- value-level error checks (`is error`, `#`) on read-only vars/arguments do not force chain storage
- a var used with path assignment remains chain-backed
- two `var x` in sibling scopes (and a loop var reused across nested loops) compile to distinct `jsVar`s with no JS redeclaration
- a direct body `var x` does not collide with a macro argument `x` in the same callable
- read-only ordinary var preserves promise and poison behavior identical to the chain-backed version
- a var reassigned only inside a nested `if`/`for` branch still derives to chain-backed (mutation is accumulated over the owning scope, not read per node)
- a read-only root `var` is direct and still imports / re-exports correctly via `addResolvedExport`
- explicit `snapshot()` is rejected on declared Cascada vars (chain- or direct-backed)
- `var x = obj; x.snapshot()` is rejected even when `obj.snapshot` exists
- ambient/context `obj.snapshot()` remains an ordinary method call when `obj` is not a Cascada declaration
- explicit `snapshot()` on non-var lanes keeps those lanes chain-backed

### Initialization is not a mutation

- a declaration initializer alone leaves the name out of `mutates`, so it derives to direct storage
- a later reassignment adds the name to `mutates` and forces chain storage
- the macro argument initial binding does not appear in the body's `mutates`
- `data` / `text` / `sequence` initialization classification is unchanged in this phase

### Unified initialization

- a read-only chain-backed `var` (kept as a chain for a lane reason) initializes via the initializer and its observe-only lane does not throw `expected an observable entry`
- a chain-backed `var` seeded via the initializer resolves promises and poison identically to the `VarCommand` path, including resolved-value unwrapping and error context
- a `var` initializer holding a promise stores it without eager resolution (no race)
- the same normalization helper is exercised by both a set command and the `var` initializer (one code path)
- `data` initialization is unchanged; no eager promise resolution is introduced for `data` in this phase

### Central immutability enforcement

- reassigning a macro/function name fails through the single mutation validator with a kind-appropriate message
- read-only-scope (call block) and read-only-chain rejections still fire from the same validator
- no per-feature reassignment check exists outside `_validateMutations`

### Derived: loop variables

- read-only loop variable is direct and closure-captured correctly across an async child boundary (including concurrent iterations)
- reassigned loop variable stays chain-backed
- path-assigned loop variable (`item.x = …`) stays chain-backed

## Success Criteria

- Source-visible JS-backed names are represented by declarations with direct storage, not chain storage.
- `isCompilerInternal` remains the raw generated-JS-name escape hatch.
- Macro/function names no longer allocate `var` chains or `VarCommand` entries.
- Macro/function names cannot be reassigned.
- Macro arguments and other variables remain chain-backed whenever they need lane behavior.
- For `var`, initialization is never recorded as a mutation and the initial value is emitted as a non-command initializer, so read-only chain-backed vars carry no initial-value command.
- `data` / `text` / `sequence` initialization is unchanged this phase; a TODO in the data chain tracks converging on the shared non-command initializer once `data` `_target` supports promises.
- The implementation uses universal facts to derive eligibility instead of macro-specific or node-specific exceptions.
