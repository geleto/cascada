# Lexical Binding Plan

Lexical bindings are source-visible names that compile to generated JavaScript variables instead of command-buffer chains.

They are not compiler temporaries. They still participate in Cascada scope lookup, shadowing checks, assignment checks, and export rules. The difference is storage: once analysis resolves a source name to a lexical binding, codegen emits the binding's `jsVar` directly.

Scope: this plan targets the async compiler. Sync mode already uses frame-backed JavaScript variables for local values and should only need naming/validation alignment if shared helpers are touched.

## Core Idea

Today many source-visible values are represented as `var` chains because that is the existing universal named-value mechanism. That is correct for mutable or lane-observed values, but too heavy for immutable read-only values.

The target split is:

- `isCompilerInternal`: generated JS names that are not source-visible and bypass source lookup.
- declarations with `storage: DECLARATION_STORAGE.LEXICAL`: source-visible names with lexical scope rules, backed by a generated JS variable.
- declarations with `storage: DECLARATION_STORAGE.CHAIN`: source-visible command-buffer lanes that can be observed, mutated, snapshotted, linked, or exported through buffer state.

Minimal shape:

```js
{
  name: "greet",
  storage: DECLARATION_STORAGE.LEXICAL,
  jsVar: "macro_12",
  kind: DECLARATION_KIND.MACRO
}
```

Once a symbol resolves to this binding:

```js
compileSymbol(greet) -> emit("macro_12")
```

This has the same codegen shape as `isCompilerInternal`, but keeps source-level rules intact.

## When To Use A Lexical Binding

Use a lexical binding when a declaration is value-like and does not need lane behavior.

A declaration is eligible for `storage: DECLARATION_STORAGE.LEXICAL` when:

- it is source-visible by name
- its value is available as a JS expression or generated JS variable
- it is not reassigned after initialization
- it is not used through chain operations such as `snapshot`, `is error`, or `getError`
- it is not path-assigned or otherwise mutated indirectly
- it does not need command-buffer producer/consumer ordering as a lane
- it does not need parent/child linked-chain visibility
- it is not exported through deferred chain state

Keep `storage: DECLARATION_STORAGE.CHAIN` when any of those conditions fail.

This rule should be derived from finalized universal facts wherever possible: declarations, reads, observations, mutations, chain-command facts, path-assignment facts, and boundary-link facts. Avoid one-off per-node exceptions.

Important distinction: ordinary value reads are not the same thing as lane observations. Today, many declared-symbol reads are recorded as `observes` because the current storage model is chain-backed. If a future phase derives lexical bindings for ordinary read-only vars, analysis must first distinguish "this source name is read as a value" from "this chain lane must be observed." Otherwise every read-only var would look chain-observed merely because the old implementation used chains to read it.

## Initial Use Cases

### 1. Macro And Function Names

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
  storage: DECLARATION_STORAGE.LEXICAL,
  jsVar: "macro_12",
  kind: DECLARATION_KIND.MACRO
}
```

Root/importable macros export the resolved callable value directly:

```js
context.addResolvedExport("greet", macro_12);
```

This direct export must be used in template mode too. Current template-mode macro export uses `context.addDeferredExport(name, chainName, buffer)`, which requires a backing chain and will fail once macro names stop allocating `var` chains.

Macro/function bodies also need a body-local self binding for recursion. The source-visible binding in the surrounding scope makes later code able to call `greet(...)`; the body-local binding makes `greet(...)` inside the macro/function body resolve even though the body is a clean `scopeBoundary: true` scope. Both bindings point at the same `jsVar`.

### 2. Read-Only Macro Arguments

Macro arguments are currently local `var` chains because macro bodies may reassign them:

```njk
{% macro bump(x) %}
  {% set x = x + 1 %}
  {{ x }}
{% endmacro %}
```

When an argument is never mutated or used as a chain lane, it can become a lexical binding:

```njk
{% macro show(x) %}
  {{ x }}
{% endmacro %}
```

The argument setup assigns a generated JS variable, and symbol reads emit that `jsVar`. Mutated arguments stay chain-backed.

### 3. Read-Only Caller / Call-Block Arguments

Caller block parameters and generated caller values follow the same rule:

- read-only value-like parameters can be lexical bindings
- reassigned parameters or parameters used as chain lanes remain chains
- caller scheduling lanes such as `__caller__` remain chains

### 4. Read-Only Loop Locals

Loop item/index locals may be lexical bindings when they are read-only values and do not need lane observation.

This must be applied carefully because loop bodies often create child buffers. If a child buffer needs source-order access to a loop value, lexical capture is acceptable only when generated JS scope and closure lifetime exactly match the analyzed loop iteration scope.

### 5. Internal Setup Values

Internal declarations such as return/wait/caller timing chains should not automatically become lexical bindings. Some internal names are real scheduling lanes.

Use lexical bindings only for internal setup values that are simple JS values and never participate in scheduling. Keep these as chains:

- `__return__`
- `__waited__`
- `__caller__`
- text/data/sequence output lanes

### 6. Ordinary Read-Only `var` Declarations

Future target, not first implementation.

```cascada
var user = fetchUser()
return user.name
```

If `user` is never mutated and never used as a chain lane, it may be a lexical binding. Promise and poison behavior must remain identical: consumers still receive the same promise/poison value, with errors reported from the same origin.

This is likely a meaningful optimization, but it should come after macro/function names and read-only callable parameters prove the mechanism.

## Scoping And Shadowing

Lexical bindings follow the same source visibility rules as declarations because they are declarations with lexical storage.

- A scope has one declaration namespace. Two source-visible names with the same name in the same scope are forbidden regardless of kind or storage: var, data/text/sequence chain, macro/function, import namespace, from-import alias, component binding, internal source-visible binding, etc.
- A binding is visible only in the scope that owns it and child scopes that can see that scope.
- Sibling scopes may declare the same name.
- A scope with `scopeBoundary: false` may not shadow a visible binding.
- A clean scope with `scopeBoundary: true` hides parent declarations where the language explicitly allows it, such as macro argument names.
- A lexical-storage declaration conflicts with a chain-storage declaration of the same visible name.

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

Use the existing declaration maps. Do not add parallel `lexicalBindings` / `sourceVisibleLexicalBindings` maps.

Add a storage discriminator to declaration objects:

```js
{
  name,
  storage: DECLARATION_STORAGE.CHAIN | DECLARATION_STORAGE.LEXICAL,
  type,     // chain declarations only
  jsVar,    // lexical declarations only
  kind      // macro/function/value/etc.
}
```

The existing declaration flow should continue to own visibility:

- first pass records source-visible declarations for validation and lookup
- finalization installs finalized declarations on scope owners
- symbol analysis records `lookupDeclaration` as it does today
- missing-name validation checks declarations before falling back to ambient/context lookup

For explicit lexical declarations such as macro/function names, `lookupDeclaration.storage` can be `DECLARATION_STORAGE.LEXICAL` during the existing symbol analysis pass.

For derived lexical bindings such as read-only vars, storage cannot be decided during the first walk because eligibility depends on finalized usage. Use one of these simple shapes:

- keep one declaration object and set its finalized `storage` after usage derivation, so existing lookup pointers see the final storage choice
- or run a small post-finalization lookup resolution pass for names whose storage changed

Prefer the first option if it keeps the declaration object stable and avoids a second lookup pass.

Conflict validation is reused from the existing declaration map:

- lexical-storage declaration vs lexical-storage declaration
- lexical-storage declaration vs chain-storage declaration
- chain-storage declaration vs lexical-storage declaration
- all declaration kinds share one same-scope uniqueness rule; do not add a macro-only, import-only, or chain-only namespace

Existing chain-only helpers can remain when the caller truly needs a chain. New source-name checks should inspect `declaration.storage` so lexical declarations are not accidentally reported as unknown names.

Eventually rename fields such as `declaredChains` to `declarations` if the mixed storage makes the old name misleading. The rename is cleanup, not a prerequisite for the first macro/function-name implementation.

Do not replace ordinary chain declarations with derived lexical storage during the first walk. Eligibility depends on finalized usage facts.

## Eligibility Derivation

The simplest safe implementation is staged:

1. Explicit lexical storage for macro/function names.
2. Add derived read-only lexical storage after finalized usage proves no lane behavior is needed.

For derived bindings, a declaration requires a chain if any is true:

- it appears in `mutatedChains` after initial setup
- it appears in chain command facts
- it is a target of path assignment
- it appears in boundary linked observed/mutated facts
- it is shared
- it is exported through deferred chain state
- its chain type is not `var`
- it is one of the scheduling/internal lane names

Declaration initialization or setup writes do not by themselves require a chain. A chain is required only when later source behavior needs lane semantics. The implementation therefore needs to separate setup writes from subsequent mutations before deriving read-only lexical bindings.

Everything else can remain a chain until proven worth moving. The mechanism should improve correctness or reduce real command-buffer work, not add complexity for tiny wins.

## Codegen Architecture

Keep codegen small:

```js
compileSymbol(node) {
  if (node.isCompilerInternal) {
    emit(node.value);
    return;
  }

  const declaration = node._analysis.lookupDeclaration;
  if (declaration && declaration.storage === DECLARATION_STORAGE.LEXICAL) {
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

If an AST node is synthesized to refer directly to `macro_12`, that synthesized symbol may use `isCompilerInternal`. Parsed source symbols such as `greet` must use lexical lookup.

The generated JS declaration kind must match the generated scope. Use `const` for immutable bindings when the binding is emitted exactly once in the owning JS scope. Use `let` if branch/loop codegen needs a declaration shape that is assigned conditionally. Do not widen a binding's JS scope beyond the analyzed Cascada scope merely to make codegen convenient.

Child async boundaries may read a lexical binding only if generated JS closure capture gives the child the same source value that a chain observation would have produced. If the value must be observed later through command-buffer ordering, keep it chain-backed.

Recursion and mutual recursion need explicit codegen support:

- self-recursion works when the generated macro function closes over its own `jsVar` and the function is not invoked during initialization
- self-recursion also requires a body-local lexical declaration pointing at the same `jsVar`, because macro/function bodies are clean scopes
- mutual recursion is only supported where the current language visibility rules already make both names visible; do not add hoisting as part of this refactor
- forward references are not hoisted by Cascada; preserve current language behavior, but avoid turning an intended compile/unknown-name error into an accidental JS temporal-dead-zone `ReferenceError`

## Assignment Semantics

Assignment analysis must reject writes to lexical macro/function declarations.

Invalid:

```cascada
function greet()
  return "hi"
endfunction

greet = 123
```

The error should mention that macro/function bindings cannot be reassigned.

Mutable language-level variables should remain chain declarations unless and until the compiler can prove the name is read-only.

If a name has both a lexical-storage declaration and a chain-storage declaration visible, that is an analysis bug unless the language explicitly created a clean scope that hides one of them.

## Exports And Imports

Root lexical bindings export resolved JS values directly:

```js
context.addResolvedExport("greet", macro_12);
```

Deferred exports remain for chain-backed values whose final value depends on buffer execution.

Imports should continue to work through the existing import/from-import runtime objects. If an imported value is a macro callable and is bound to a source-visible name, it may become a lexical binding only if import timing makes the value available as a JS expression at declaration time. Async/deferred imports should stay chain-backed until proven safe.

Do not convert imports merely because the imported value eventually resolves to a macro. Import boundaries often carry load failure, poison, and deferred-export timing. Treat imported lexical bindings as a later optimization with dedicated tests.

## What Not To Convert

Do not use lexical bindings for:

- data/text/sequence chains
- shared chains
- `__return__`, `__waited__`, `__caller__`
- values that are reassigned
- values used with chain operations
- values that must be visible to child command buffers through linked lanes
- values whose export is currently deferred through chain finalization

## Migration Plan

1. Add `DECLARATION_STORAGE` and `DECLARATION_KIND` constants in `src/compiler/declarations.js`.
2. Add `storage`, `jsVar`, and `kind` support to declaration objects without changing the existing declaration maps.
3. Add the `compileSymbol` lexical-storage fast path after `isCompilerInternal`, before `loop` magic and chain/shared lookup handling.
4. Convert macro/function names from var chains to lexical-storage declarations in one atomic change:
   - remove the macro-name chain declaration
   - remove macro-name `mutates: [name]`
   - remove macro-name `declareBufferChain` / `VarCommand` emission
   - remove analysis reads that would add macro names to chain `observes`
   - keep/add a body-local self lexical declaration for recursion
5. Export root macro/function lexical declarations with `addResolvedExport` in both script and template mode.
6. Reject assignment to macro/function lexical declarations.
7. Remove macro-name parent-owned chain mutation propagation if it becomes dead.
8. Add tests for scope, shadowing, imports, exports, recursion, and reassignment.
9. Add separate read-vs-lane-observation facts before deriving lexical storage for ordinary read-only vars.
10. Add separate setup-write-vs-subsequent-mutation facts before deriving lexical storage for ordinary read-only vars.
11. Only then evaluate read-only arguments, loop locals, and ordinary vars.

## Tests

Start with macro/function names:

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
- template-mode macro export works without a backing chain
- macro can be both exported and called locally in the same scope

Then add derived read-only binding tests:

- read-only macro argument compiles without a var-chain setup command
- mutated macro argument remains chain-backed
- ordinary value reads do not force a read-only declaration to stay chain-backed
- explicit chain operations do force the declaration to stay chain-backed
- read-only loop local behaves correctly across async child boundaries
- read-only ordinary var preserves promise and poison behavior
- a var used with `snapshot` or path assignment remains chain-backed

## Success Criteria

- Source-visible JS-backed names are represented by declarations with lexical storage, not chain storage.
- `isCompilerInternal` remains the raw generated-JS-name escape hatch.
- Macro/function names no longer allocate `var` chains or `VarCommand` entries.
- Macro/function names cannot be reassigned.
- Macro arguments and other variables remain chain-backed whenever they need lane behavior.
- The implementation uses universal facts to derive eligibility instead of macro-specific or node-specific exceptions.
