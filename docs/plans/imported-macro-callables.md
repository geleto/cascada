# Macro Callable Semantics And Imported Macro Callables Plan

Imported values may be used as Cascada macros from clean scopes: ordinary macro bodies, methods, blocks, constructors, and inheritance-compiled root macros. The implementation should keep this close to real macro handling while preserving source-order visibility and keeping ordinary imported values out of clean scopes.

This plan covers async-template macro call-only validation, imported macro call classification/validation, and clean-scope transport for imported macro calls. CascadaScript macro/function handle value-use policy is documented as a deferrable follow-up because it is separable from imported macro support.

## Current Baseline

This is not a from-scratch feature. Imported macro calls already work in code compiled **inside the root JS function**, where the import `jsVar` is in scope:

- root-body and ordinary macro-body calls already render;
- bare reads (`{{ button }}`) and pass-as-value uses (`apply(button)`) also work today by leaking the macro function.

There are two gaps. Ordinary macro-body calls work today but rely on fallback/ambient behavior, so the imported macro analysis phase must make them source-visibility correct. Inheritance callables and inheritance-compiled root macros also run outside the root JS function; there the import `jsVar` is undefined, so calls fail as poison (`Unable to call button, which is undefined`). This plan fixes both and intentionally turns loose non-call macro uses into compile errors in async template mode.

## Goals

- Make imported macro calls source-visibility correct in ordinary macro bodies and executable from inheritance clean scopes.
- Use analysis to identify imported exports that are called as macros, then validate those required macro exports at runtime; non-macro exports are fatal runtime errors, not poison.
- Make template macros call-only. Existing bare-read / pass-as-value behavior is removed deliberately for local and imported macros in async template mode.
- Reuse direct macro binding transport for clean scopes.
- Keep namespace imports path-specific: `ui.button(...)` is macro-only, but `ui` and `ui.version` remain ordinary namespace reads.

## Non-Goals

- Do not make arbitrary imported values visible inside clean scopes.
- Do not support calling plain exported JavaScript functions through the imported macro-call path. A value used with imported macro-call syntax must be a Cascada macro.
- Do not classify dynamic imported macro paths such as `ui[name](...)` as macro calls. In async templates they may remain ordinary dynamic calls only for non-macro values; if they resolve to a Cascada macro, that is a runtime error. Script mode may keep dynamic macro calls.
- Do not change sync compiler behavior in this phase.
- Do not apply async-template call-only validation to CascadaScript. Script macro/function handle value-use policy is covered below, but escape hardening is deferrable.

## Template vs Script Semantics

Async Cascada templates require macro calls to be statically analyzable. Passing a macro as a value and calling it through `x()` can render correctly today through conservative dynamic/value-boundary behavior, but the compiler cannot specialize that call site or thread the callee body's exact facts through the opaque value. The facts that matter are sequence locks (`!`), named-chain source-order observation, and linked child-buffer facts. Template call-only validation keeps those facts explicit instead of introducing macro-value dataflow analysis.

In async template mode, the only valid macro use is a statically classified macro call:

```njk
{{ button("Save") }}
{{ ui.button("Save") }}
```

These are compile errors in async template mode for local and imported macros:

```njk
{{ button }}
{% set x = button %}
{{ helper(button) }}
{% set x = button %}{{ x("Save") }}
```

### CascadaScript Macro/Function Handle Policy

CascadaScript is different. A script call produces a value and does not write template text channels, so script mode may keep Cascada macro/function handles as long as they stay inside Cascada-controlled values and calls:

```cascada
var x = ourFunction
return x()
```

Macro/function handles may be stored in local values, including object/array aggregate declarations, and passed to Cascada functions/macros:

```cascada
var tools = { format: ourFunction }
var list = [ourFunction]

function apply(fn, value)
  return fn(value)
endfunction

return apply(tools.format, value)
```

Functions may return macro/function handles to other Cascada code:

```cascada
function chooseFormatter()
  return ourFunction
endfunction

var formatter = chooseFormatter()
return formatter(value)
```

Deferrable script hardening: direct macro/function handle references should not escape to the host as ordinary values:

```cascada
return ourFunction               // root return: compile/runtime error
return { fn: ourFunction }       // direct macro/function handle reference inside root return: compile/runtime error
return nativeApply(ourFunction)  // native/global call: compile/runtime error
return "fn=" + ourFunction       // ordinary scalar/data use: compile/runtime error
```

Script-mode macro/function handle validation, when implemented, should be syntactic and direct. It should allow direct macro/function handle references in assignments, object/array aggregate declarations, non-root function returns, and arguments to statically known Cascada functions/macros. It should reject direct macro/function handle references in root returns, native/global/dynamic unknown call arguments, and ordinary scalar/data operations. Do not chase aliases or track handle taint through variables, conditionals, loops, object fields, or mutation:

```cascada
var x = ourFunction
return x                 // not caught by compile-time direct validation
nativeApply(x)           // not caught by compile-time direct validation
```

This applies to local and imported Cascada macro/function handles. Hard runtime escape boundaries may still reject macro/function handle values if they receive one. This hardening is separate from imported macro support; the required rule for this plan is that template call-only validation must not be applied to script macro/function handles.

In async template mode, compile-time validation should reject statically known macro values in non-call positions. After imported macro call classification lands, runtime should also reject Cascada macros that reach generic async-template value, ordinary-call argument, or dynamic call-target paths instead of a recognized macro call. Statically recognized macro calls use the dedicated macro-call path instead.

## Core Semantics

An imported value becomes a required macro export only when analysis sees it used as an imported macro call.

From-import:

```njk
{% from "ui.njk" import button as b %}
{{ b("Save") }}
```

Records local path `b`; runtime validation checks exported name `button`.

Namespace import:

```njk
{% import "ui.njk" as ui %}
{{ ui.button("Save") }}
```

Records path `ui.button`; `ui` remains an ordinary namespace value.

Classified imported macro paths are call-only in async templates:

```njk
{% from "ui.njk" import button %}
{{ button("Save") }}
{{ button }}          {# compile error #}

{% import "ui.njk" as ui %}
{{ ui.button("Save") }}
{% set x = ui.button %} {# compile error #}
```

An imported namespace itself is not callable:

```njk
{% import "ui.njk" as ui %}
{{ ui("Save") }}      {# compile error #}
```

Deeper namespace paths are not imported macro declarations. `ui.button.icon()` is ordinary only when `ui.button` is not a classified imported macro and `ui` is source-visible; otherwise it is rejected as a non-call use of `ui.button`. In async templates, if an ordinary dynamic call later resolves to a Cascada macro, runtime rejects it because the macro body was not analyzed for that call site.

```njk
{% import "ui.njk" as ui %}
{{ ui.button.icon() }} {# ordinary dynamic call only where ui is source-visible #}
```

## Source Visibility

Imported macro callability follows source-point visibility. A clean callable may use only imports visible where that callable is declared.

```njk
{% from "ui.njk" import button %}

{% macro render() %}
  {{ button("Save") }} {# allowed #}
{% endmacro %}
```

Shadowing still wins:

```njk
{% from "ui.njk" import button %}

{% macro render(button) %}
  {{ button("Save") }} {# calls the argument, not the import #}
{% endmacro %}
```

Name conflicts stay declaration-based, not storage-based. A `var` declaration or implicit template variable declaration must not share a source-visible name with an import, macro/function, or other declaration in the same visible scope; current declaration conflict validation should keep catching declaration conflicts before runtime. A later `set` assignment to an existing import or macro/function is not a redeclaration; it remains an immutable-mutation error. Clean callable scopes may still shadow outer imports with parameters or local declarations, and that shadowing prevents imported macro classification.

Analysis may keep an import catalog for convenience, but not as semantic truth. `_collectImportedCallableUsage` currently falls back to `compiler.importedBindings.has(importedRoot)` when no visible declaration is found; the imported macro analysis phase must remove or gate that fallback because it bypasses shadowing and source-point visibility.

## Analysis Facts

Use one shared macro callable registration path for local and imported macro calls. Imported macro support should extend the same analysis/compile concept used by normal macros, not add a parallel imported-callable pipeline.

Local macro registration shape:

```js
{
  kind: "local",
  localPath: "button",
  declaration,
  callNodes: [...]
}
```

From-import registration shape:

```js
{
  kind: "imported-from",
  localPath: "button",          // source path used by this file
  localName: "button",
  exportedName: "button",
  declaration,
  importNode,
  callNodes: [...]
}
```

Imported declarations need enough metadata for the call classifier:

```js
{
  imported: true,
  importKind: "from",        // or "namespace"
  importNode,
  exportedName: "button"     // from-import only; alias declarations keep the canonical export
}
```

Namespace import registration shape:

```js
{
  kind: "imported-namespace",
  localPath: "ui.button",
  namespaceName: "ui",
  exportedName: "button",
  declaration,
  importNode,
  callNodes: [...]
}
```

The registration should answer the same call-site question for every macro form:

```js
const macroCall = analysisPass.recordMacroCallableCall(node)
```

or equivalent. The result distinguishes local, from-import, and namespace-import emission, but the call site should not have separate `directMacroCall` and `importedCallable` concepts once this feature lands.

For imported registrations:

- the import node records the canonical exported names that must be validated as macros during import codegen;
- the owning analysis scope records local path facts for call classification, non-call validation, and clean-scope transport.

Do not set every imported declaration to `isMacro` up front. Imports become required macro exports only after a visible static macro-call use classifies them. For from-import aliases a derived declaration flag such as `requiredMacro` may be useful after classification; namespace members should remain path registrations because `ui.button` is not a declaration.

Use the same static-path machinery for call classification and non-call validation. `Symbol` is enough for from-imports and local macros, but namespace calls require lookup-path analysis. Namespace members are path registrations, not declarations, so source-point visibility and shadowing must still win.

## Call Classification

Imported macro calls in async templates have one of these static forms:

- `fromImportAlias(...)`
- `namespaceName.exportName(...)`

The classifier should extract the static call path from `FunCall.name`, then look up only the call-path head in that call target's source-point `visibleDeclarations`. Do not scan all visible imports. Shadowed call-path heads are not imported calls because the visible declaration for that name is different.

For example:

```njk
{{ button() }}      {# path ["button"] #}
{{ ui.button() }}   {# path ["ui", "button"] #}
```

Direct/from-import macro:

- path length is 1;
- visible declaration for `button`/alias `b` is `imported` with `importKind: "from"`;
- register the canonical `exportedName` from the declaration and the local path used at the call site.

Namespace macro:

- path length is 2;
- visible declaration for `ui` is `imported` with `importKind: "namespace"`;
- register the second path segment as the required exported macro name and the full local path, such as `ui.button`.

Invalid namespace call:

- path length is 1;
- visible declaration is an imported namespace;
- report a compile error because the namespace object is not callable.

Dynamic paths, deeper paths, and expressions without a source-visible imported call-path head are not imported macro calls. When classified:

- mark the call target expression as a macro call target;
- record the local macro path, and for imports record the required exported macro;
- compile the call through the shared macro-call path, not the generic dynamic call path;
- keep the current value-boundary behavior, because imported exports may still be promises.

Use these helper boundaries:

- `findImportedMacroDeclarationForCall(node)` finds the imported declaration for the call-path head. It first checks the call target's own `visibleDeclarations`; if that has no declaration and the call is inside a clean callable, it walks enclosing clean callable declaration points from inner to outer and checks the `visibleDeclarations` captured there. This fallback is only for imported macro call classification, not ordinary symbol lookup.
- `classifyImportedMacroCall(node)` uses that declaration plus the static call path to return the imported macro registration, or reports namespace-call / unsupported-path errors.

This clean-scope fallback is needed because a macro, method, or block begins a clean scope: its normal body `visibleDeclarations` intentionally does not include ordinary outer imports. Imports visible at the callable declaration point may still be used as macro calls from that callable.

## Non-Call Validation

After macro paths are known in async template mode, any source use of that path outside its classified call target is a compile error. This applies to local macro declarations and to imported macro paths.

This includes:

- bare reads of a local macro name or from-import macro alias;
- passing the macro value as an argument;
- assigning it to another variable;
- reading a namespace macro member as a value;
- using it as the base of a deeper lookup.

Layer onto existing immutable-assignment checks. `failImmutableMutation` already rejects assignment to immutable/import bindings where applicable; that message should keep winning for assignments. The new validation adds read cases (bare read, argument, deeper lookup) and should live in `analysis-validation.js`.

Use one mode-aware macro value validator, not separate local/imported checks. The validator runs after call classification has marked valid macro call targets. In async templates, any direct macro/callable reference that is not the classified call target is a compile error. In script mode, the validator checks only direct macro/callable reference nodes and their syntactic position; it must not become callable-handle dataflow or taint analysis. The pitfall is over-rejecting script handles, under-rejecting direct template/runtime macro values that bypass channel-fact analysis, or trying to prove alias-derived uses.

The validator should use parent/position checks, not recursive analysis. Valid call targets are explicitly marked by call classification. Assignment targets, macro/function parameters, import targets, and other symbol-target positions are not value reads and must stay out of this validation path.

This deliberately makes async template macros call-only. Supporting macro values in templates would require macro-value dataflow facts so `x()` can contribute the callee body's exact observes/mutates/uses facts. That is out of scope here.

The check must be path-based and declaration-aware so shadowed local names are not rejected because an outer import path was classified as a macro.

Examples:

```njk
{{ button("Save") }}
{% set x = button %}      {# error #}
{{ helper(button) }}       {# error #}

{{ ui.button("Save") }}
{{ ui.button.label }}     {# error #}
```

A namespace value and unrelated namespace members remain valid ordinary reads. Classifying `ui.button` does not classify `ui` or `ui.version`:

```njk
{% import "ui.njk" as ui %}
{{ ui.version }}          {# valid ordinary namespace use #}
{{ ui.button("Save") }}   {# only ui.button is macro-only #}
```

## Runtime Validation

Runtime validation is required because the imported template may be dynamic. Import helpers receive required macro exports from analysis:

- namespace import: exported names used as macros, such as `["button", "card"]`;
- from-import: canonical exported names for aliases used as macros.

Validate each required export when exports resolve:

- if the export is missing, preserve the existing missing-import error behavior;
- if the export exists but is not a Cascada macro, report a fatal runtime error;
- if it is a macro, return it for the imported macro-call path.

Group required macro validation by import node, regardless of whether the source is from-import or namespace import. Validation must attach to the existing import resolution result, not start a second template load or second `getExported(...)` run.

For from-imports, reuse the existing binding-level missing-import path: the `hasOwnProperty` check that `_emitAsyncFromImportBindings` already emits per alias in `src/compiler/composition.js`. If that alias is required as a macro, validate macro-ness before returning the bound value.

For namespace imports, validate required namespace members from the same exported object promise that produces the namespace value. Today `compileImport` resolves the whole exported object without per-member checks, so the new validation point is a loop over the required export names inside the existing `resolveThen` callback after `getExported`. The namespace binding still returns the full exported object.

Preserve payload semantics by sharing the same export resolution result used for ordinary import bindings. Do not add a separate required-macro import resolution path.

Add a single runtime helper over the macro contract:

```js
runtime.isMacro(value)
```

The helper should use `_invoke` as the canonical runtime dispatch marker. `makeMacro` also sets `isMacro = true`, but import validation, generic template guards, and diagnostics should share this one helper.

Type mismatch is fatal, not poison: use `RuntimeError.reportAndThrow` or equivalent, never `PoisonError.create`. Existing import promise wrapping may keep using `handleLoadFailure`, which preserves `RuntimeError`.

After imported macro classification exists, generic async-template value, ordinary-call argument, and dynamic call-target paths must reject Cascada macros that were not reached through a recognized macro call. This is separate from import validation: import validation proves required exports are macros, while the generic-path guard prevents macro values from being rendered, passed through, or called without macro-call analysis. Script mode must not use this guard.

## Codegen Shape

Imported macro calls stay value-boundary calls because imports may resolve asynchronously. Inside the boundary:

```js
runtime.invokeMacro(requiredMacroValue, context, args, currentBuffer)
```

Use one macro call emission helper over macro callable registrations. Local macros can emit direct values; imported macros may need a value boundary because the import can be async. The helper must preserve `currentBuffer`, caller/call-block handling, and keyword/default argument adaptation through `runtime.invokeMacro`. Strictness comes from import-time validation for classified imports and from the generic async-template guard for unclassified macro values.

Once imported macro calls are classified, the generic async-template dynamic call path must not auto-dispatch Cascada macros. Statically classified macro calls use the dedicated macro-call path; if a generic template call target resolves to a macro after that phase, report a fatal runtime error. CascadaScript keeps the existing dynamic macro/function call behavior.

## Clean Scope Transport

Use the same owner-entry direct macro binding transport as root-local macros; do not add a separate inheritance import payload. Clean-scope transport should use one macro binding table for local root macros and required imported macros.

Target shape:

- local root macro: direct macro function;
- from-import required macro: from-import binding `jsVar`;
- namespace required macro: namespace `jsVar` plus exported property name, or a resolved required-macro value derived from that pair.

There are two clean-scope mechanics:

- ordinary macro bodies compiled inside the root JS function already work today without owner-entry transport, but the imported macro analysis phase must make their imported-macro classification source-visibility based rather than fallback-driven (see [Source Visibility](#source-visibility));
- inheritance callables run outside the root JS function, so methods, blocks, constructors, and inheritance-compiled root macros need owner-entry transport.

Crux of this phase: `createDirectMacroBindings` runs synchronously before the entry root executes, so root-local macros can be constructed there but import `jsVar`s do not exist yet.

Clean-scope transport supports only imports whose target and payload can be evaluated safely from the root-like direct macro binding factory context. If the required imported macro depends on source-local execution that the factory cannot reproduce, report a compile-time limitation instead of adding a second import transport path.

The factory kicks off the template load for supported required modules and stores the resulting **promise of the validated macro** in the binding table; the call site keeps its value boundary to await it. This avoids a second inheritance payload path and tolerates unresolved import timing.

Factory-created required macro promises must be shared with the normal entry-root import binding. Do not run `getExported(...)` twice for the same import. `env.getTemplate` caches the compiled template object, not export evaluation; re-running export evaluation can duplicate side effects and break payload semantics.

`with context` is supported when it can be recreated from the factory's `context` and render context. Explicit payload expressions (`with value`, named inputs, object inputs) are supported only when the same payload setup can be compiled in the root-like factory environment. Otherwise clean-scope use of that imported macro is a compile-time error.

The table can remain `directMacroBindings` while it carries only macros. Ordinary imported values must not be retrievable through it.

Clean callable compilation uses the same source construct for local and imported macro references:

```js
currentInstance.getDirectMacroBinding(methodData, key, errorContext)
```

where `key` may be a local macro name (`"label"`) or imported macro path (`"ui.button"`).

The table may contain macro values or promises for validated macro values. If a binding may be async, keep the value boundary at the call site; do not make `runtime.invokeMacro` promise-aware.

## Import Declarations

Imported declarations stay direct declarations. From-import aliases reuse their direct `jsVar`; namespace macro calls read the exported property from the namespace `jsVar`. Do not create parallel declarations for namespace members unless it clearly simplifies transport.

## Error Messages

Compile errors should name the path and the reason:

- `Macro 'button' cannot be used as a value in an async template. Call it directly.`
- `Imported macro 'button' cannot be used as a value.`
- `Imported macro 'ui.button' cannot be used as a value.`
- `Import namespace 'ui' is not callable; call a named export such as ui.name(...).`
- `Dynamic imported macro calls are not supported; use ui.name(...).`
- `Macro 'button' cannot be called through a dynamic value in an async template. Call it directly.`
- `Cascada function 'button' cannot be used directly in a native call or root return.`

Runtime fatal errors should name the import path and expected export:

- `Imported export 'button' is used as a macro but is not a Cascada macro.`
- `Imported export 'ui.button' is used as a macro but is not a Cascada macro.`
- `A Cascada macro cannot be used as a plain value in an async template. Call it directly.`

Use the call-site/import error context that gives the clearest source location. For type mismatch, prefer the call-site context when available; for missing export, keep the existing import-name context. Error construction can be centralized only if it preserves the source of truth: compile errors for statically invalid use, fatal runtime errors for dynamic macro contract violations, and existing missing-import contexts for absent exports.

## Tests

Add async tests for:

- from-import macro called from another macro (regression - already works);
- namespace macro called from another macro (regression - already works);
- from-import macro called from method/block/constructor;
- namespace macro called from method/block/constructor;
- a constructor body specifically (the riskiest case for the factory timing problem, since root imports may not run through the constructor);
- local macro bare read, pass-as-value, assignment, and alias call are compile errors in async templates;
- imported macro bare read, pass-as-value, assignment, and alias call are compile errors in async templates;
- CascadaScript allows macro/function handles in assignments, object/array aggregate declarations, non-root function returns, and Cascada function/macro arguments;
- optional script hardening rejects direct local/imported macro/function handle references in root returns, native/global call arguments, dynamic unknown call arguments, and ordinary scalar/data use;
- optional script hardening does not chase aliases when validating macro/function handle use;
- shadowing by macro arguments prevents imported classification;
- root-local import after a macro declaration is not visible inside that macro;
- non-call use of a required from-import macro is a compile error;
- non-call use of a required namespace macro member is a compile error;
- namespace object remains usable as an ordinary value/member source;
- namespace itself cannot be called;
- dynamic namespace macro calls are rejected in async templates; ordinary dynamic calls remain valid only for non-macro values where the namespace itself is source-visible;
- generic async-template dynamic calls reject macro values at runtime, while CascadaScript dynamic calls still allow them;
- `from "x" import button as b` validates exported name `button`, while source validation/error reporting identifies local alias `b` where appropriate;
- imports with `with context` work when their required macros are called from clean scopes;
- explicit payload / `with value` imports work only when their payload setup can be compiled in the root-like factory environment; otherwise clean-scope macro use is rejected with a compile-time limitation;
- missing required namespace export reports the import/member as missing;
- required export exists but is not a macro: fatal runtime error;
- required export resolves asynchronously to a non-macro: fatal runtime error;
- missing required export keeps missing-import behavior;
- inherited parent block uses its own imported macro, not the child's import;
- super block uses the owner entry's imported macro bindings.

## Implementation Phases

1. Template macro call-only migration
   - audit the existing tests, fixtures, and in-repo templates for macro-as-value usage before landing the behavior change;
   - add the mode-aware macro value validator for macro uses the compiler already recognizes today;
   - reject non-call use of local macro declarations in async templates;
   - keep existing direct macro-call behavior otherwise unchanged;
   - update `docs/cascada/template.md` for the landed local macro call-only behavior.

2. Imported macro calls
   - generalize normal macro call registration into shared macro callable registration for local and imported macro paths;
   - classify static imported macro call paths through that shared registration;
   - move valid-call-target marking into shared macro call classification so local and imported macro calls both skip value-use validation;
   - record required macro exports on import nodes and the owning analysis scope;
   - reject non-call use of classified imported macro paths in async templates;
   - preserve shadowing and source-point visibility;
   - add a small runtime macro predicate/validator;
   - add template-only generic-path guards for macro values that reach output, discarded expressions, ordinary call arguments, or dynamic call targets without recognized macro-call analysis;
   - pass required macro export lists to import codegen;
   - report fatal runtime errors for non-macro exports;
   - compile imported macro registrations through the shared macro-call emission, using `invokeMacro` after value-boundary resolution when the imported value may be async;
   - keep ordinary dynamic calls for non-classified non-macro imported values where they are source-visible;
   - update user-facing template/import documentation for imported macro calls, required macro exports, and non-macro export runtime errors.

3. Clean scope transport
   - extend direct macro bindings so macros/methods/blocks/constructors can use required imported macro paths visible at their declaration point;
   - keep ordinary imported values out of clean scopes;
   - update template inheritance/composition documentation for imported macros callable from clean scopes.

4. CascadaScript macro/function handle policy
   - validate direct local and imported script macro/function handle references by syntactic position only, without alias/dataflow tracking;
   - allow direct handle references in assignments, object/array aggregate declarations, non-root function returns, and arguments to statically known Cascada macro/function calls;
   - reject direct handle references at script root-return/native/global/dynamic-unknown escape points;
   - update CascadaScript documentation with the allowed handle positions and escape restrictions.

5. Naming cleanup
   - if direct macro bindings now carry local and imported macro bindings, keep the macro-specific name if it remains accurate;
   - defer broader declaration-table renames to the direct-storage cleanup phase.

6. User-facing documentation sweep
   - implemented for Phase 1: `docs/cascada/template.md` documents local template macro call-only behavior and notes that CascadaScript is not subject to this template-only rule;
   - after Phases 2-4, review template and script docs together so imported macro calls, clean-scope imported macros, and script callable-handle rules are described without compiler-internal terminology.

## Architectural Guardrails

- Source lookup uses `visibleDeclarations`; ownership/aggregation can use finalized declaration maps.
- Declaration conflicts are semantic, not storage-based. Do not treat every `storage: DIRECT` declaration as an immutable macro/import-like binding; direct storage can also be an optimization for ordinary variables.
- Local and imported macro calls use one macro callable registration and call-emission concept. Imports add required-export validation metadata; they should not keep a separate imported callable pipeline.
- Clean-scope imported macro access is a macro-only transport, not ordinary variable visibility.
- Runtime validation belongs to import resolution; invocation assumes validated macro values.
- Namespace support is one-level and path-specific.
- Script callable validation is intentionally syntactic: validate direct macro/callable reference nodes, but do not build alias/dataflow tracking.
- Do not over-unify inherited methods/blocks with macro callable values. `this.method(...)` and `super()` are callable surfaces with owner/override semantics, not first-class callable handles; `this.method` remains unreadable as a value.
- Avoid a second inheritance payload path for imports.
- Avoid global imported-binding fallbacks that ignore source order.
