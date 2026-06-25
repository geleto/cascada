# Macro Callable Semantics And Imported Static Callables Plan

Imported values may be used through static calls from clean scopes: ordinary macro bodies, methods, blocks, constructors, and inheritance-compiled root macros. A static imported call may resolve to either a Cascada macro or an ordinary function. The implementation should keep this close to real macro handling where the value is a macro, while preserving source-order value visibility and keeping ordinary imported values out of clean scopes.

This plan covers async-template macro call-only validation, imported static-call classification, clean-scope transport for imported static calls, and the CascadaScript macro/function handle value-use policy.

## Current Baseline

This is not a from-scratch feature. Imported macro calls already work in code compiled **inside the root JS function**, where the import `jsVar` is in scope:

- root-body and ordinary macro-body calls already render;
- bare reads (`{{ button }}`) and pass-as-value uses (`apply(button)`) also work today by leaking the macro function.

There are two gaps. Ordinary macro-body calls work today but rely on fallback/ambient behavior, so the imported callable analysis phase must make them declaration-visibility correct. Inheritance callables and inheritance-compiled root macros also run outside the root JS function; there the import `jsVar` is undefined, so calls fail as poison (`Unable to call button, which is undefined`). This plan fixes both and intentionally turns loose non-call macro uses into compile errors in async template mode.

## Goals

- Make imported static calls declaration-visibility correct in ordinary macro bodies and executable from inheritance clean scopes.
- Let imported static calls target either Cascada macros or ordinary functions. Macros render to strings in expressions; functions return ordinary values.
- Make template macros call-only. Existing bare-read / pass-as-value behavior is removed deliberately for local and imported macros in async template mode.
- Put every statically knowable macro/callable-use validation in compiler analysis. Runtime validation is only for missing imports, non-callable call targets, and values that are genuinely dynamic at the point of use.
- Reuse direct callable binding transport for clean scopes.
- Keep namespace imports path-specific: `ui.button(...)` is call-only, but `ui` and `ui.version` remain ordinary namespace reads.

## Non-Goals

- Do not make arbitrary imported values visible inside clean scopes.
- Do not classify dynamic imported paths such as `ui[name](...)` as static imported calls. In async templates they may remain ordinary dynamic calls only for non-macro values; if they resolve to a Cascada macro, that is a runtime error. Script mode may keep dynamic macro calls.
- Do not change sync compiler behavior in this phase.
- Do not apply async-template call-only validation to CascadaScript. Script mode has its own direct macro/function handle policy.

## Template vs Script Semantics

Async Cascada templates require macro calls to be statically analyzable. Passing a macro as a value and calling it through `x()` can render correctly today through conservative dynamic/value-boundary behavior, but the compiler cannot specialize that call site or thread the callee body's exact facts through the opaque value. The facts that matter are sequence locks (`!`), named-chain source-order observation, and linked child-buffer facts. Template call-only validation keeps those facts explicit instead of introducing macro-value dataflow analysis.

In async template mode, the only valid local macro use is a statically classified macro call. The call returns the rendered macro text as a string, so it may appear inside a larger expression:

```njk
{{ button("Save") }}
{{ button("Save") ~ "!" }}
{{ ui.button("Save") }}
```

These are compile errors in async template mode for local macros and for imported paths that have been classified as static callables:

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

Script direct-handle validation rejects macro/function handles escaping to the host as ordinary values:

```cascada
return ourFunction               // root return: compile/runtime error
return { fn: ourFunction }       // direct macro/function handle reference inside root return: compile/runtime error
return nativeApply(ourFunction)  // native/global call: compile/runtime error
return "fn=" + ourFunction       // ordinary scalar/data use: compile/runtime error
```

Script-mode macro/function handle validation is syntactic and direct. It allows direct macro/function handle references in assignments, object/array aggregate declarations, non-root function returns, and arguments to statically known Cascada functions/macros. It rejects direct macro/function handle references in root returns, native/global/dynamic unknown call arguments, and ordinary scalar/data operations. Do not chase aliases or track handle taint through variables, conditionals, loops, object fields, or mutation:

```cascada
var x = ourFunction
return x                 // not caught by compile-time direct validation
nativeApply(x)           // not caught by compile-time direct validation
```

This applies to local and imported Cascada macro/function handles. Hard runtime escape boundaries may still reject macro/function handle values if they receive one. This hardening is separate from imported macro support; the required rule for this plan is that template call-only validation must not be applied to script macro/function handles.

In async template mode, compile-time validation should reject statically known macro values in non-call positions. After imported callable classification lands, runtime should reject Cascada macros used as dynamic call targets instead of recognized static calls. Statically recognized local macro calls and imported callable calls use dedicated paths instead. Do not add runtime guards merely to reject source-visible macro values that the compiler can already reject; unknown runtime macro values may cross call/filter/test argument boundaries and ordinary text output uses normal text-value validation.

Do not add runtime guards for source shapes the compiler can validate. For example, async-template `{% do ... %}` is a side-effect statement and should be validated structurally in analysis: the discarded expression must contain at least one function call. `{% do button %}` and `{% do external %}` are compile errors, even if `external` might only be known from render context at runtime.

## Core Semantics

An imported value becomes a static imported callable path only when analysis sees it used as a static call. The runtime value may be a Cascada macro or an ordinary function.

From-import:

```njk
{% from "ui.njk" import button as b %}
{{ b("Save") }}
```

Records local path `b`; the binding still imports canonical exported name `button`.

Namespace import:

```njk
{% import "ui.njk" as ui %}
{{ ui.button("Save") }}
```

Records path `ui.button`; `ui` remains an ordinary namespace value.

Classified imported callable paths are call-only in async templates:

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

Deeper namespace paths are not imported callable declarations. `ui.button.icon()` is ordinary only when `ui.button` is not a classified imported callable and `ui` is source-visible; otherwise it is rejected as a non-call use of `ui.button`. In async templates, if an ordinary dynamic call later resolves to a Cascada macro, runtime rejects it because the macro body was not analyzed for that call site.

```njk
{% import "ui.njk" as ui %}
{{ ui.button.icon() }} {# ordinary dynamic call only where ui is source-visible #}
```

## Declaration Visibility

Ordinary value lookup uses `visibleDeclarations`, an immutable snapshot of declarations visible at the exact source point. This remains source-order based: `var x = x` reads from context, not from the declaration being created.

Static callable lookup uses `visibleCallableDeclarations`, a separate declaration snapshot for macro/function and imported callable roots. Local macro/function declarations are scope-visible and cross clean callable boundaries, so one macro may call a later sibling macro and methods/blocks may call root macros without making ordinary vars visible. Imported declarations enter this callable fact when their import binding is available to the current scope; root constructor imports moved by inheritance transformation are represented at the root so methods, blocks, constructors, and inheritance root macros can use them through the same static callable path.

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

Name conflicts stay declaration-based, not storage-based. A `var` declaration or implicit template variable declaration must not share a source-visible name with an import, macro/function, or other declaration in the same visible scope; current declaration conflict validation should keep catching declaration conflicts before runtime. A later `set` assignment to an existing import or macro/function is not a redeclaration; it remains an immutable-mutation error. Clean callable scopes may still shadow outer imports with parameters or local declarations, and that shadowing prevents imported callable classification.

Analysis may keep an import catalog for convenience, but not as semantic truth. Static callable classification must use the callable visibility fact plus source-visible shadowing; global import-name fallback bypasses shadowing and declaration visibility.

## Analysis Facts

Keep local macro calls and imported static calls as separate facts with a shared call-target marker. A local macro call is known to be a Cascada macro at compile time. An imported static call is only known to be an imported callable path; its runtime value may be a macro or a function.

Local macro registration shape:

```js
{
  kind: "local",
  localPath: "button",
  declaration,
  callNodes: [...]
}
```

From-import callable shape:

```js
{
  kind: "from",
  localPath: "button",          // source path used by this file
  localName: "button",
  exportedName: "button",
  declaration,
  callNodes: [...]
}
```

Imported declarations need enough metadata for the call classifier:

```js
{
  imported: true,
  importKind: "from",        // or "namespace"
  exportedName: "button"     // from-import only; alias declarations keep the canonical export
}
```

Namespace imported callable shape:

```js
{
  kind: "namespace",
  localPath: "ui.button",
  namespaceName: "ui",
  exportedName: "button",
  declaration,
  callNodes: [...]
}
```

The call analyzer should classify local macros and imported callables through one static-call path:

```js
const staticCallableCall = collectStaticCallableCallFacts(node)
```

The descriptor distinguishes local macro calls, from-import calls, and namespace-member calls. Every classified path marks the target node as a static callable call target so value-use validation can skip the legitimate call target read. Imported callable facts also record the local path on the visible import declaration for non-call validation and clean-scope transport.

Do not set imported declarations to `isMacro`. Imports become call-only paths only after a visible static call classifies them. For from-import aliases a derived declaration flag such as `requiredCallable` is enough after classification; namespace members should remain path registrations because `ui.button` is not a declaration.

Use the same static-path machinery for call classification and non-call validation. `Symbol` is enough for from-imports and local macros, but namespace calls require lookup-path analysis. Namespace members are path registrations, not declarations, so source-point visibility and shadowing must still win.

## Call Classification

Imported static calls in async templates have one of these static forms:

- `fromImportAlias(...)`
- `namespaceName.exportName(...)`

The classifier should extract the static call path from `FunCall.name`, then look up only the call-path head through `findCallableDeclaration(...)`. Do not scan all visible imports. Shadowed call-path heads are not imported calls because a source-visible ordinary declaration blocks the callable declaration.

For example:

```njk
{{ button() }}      {# path ["button"] #}
{{ ui.button() }}   {# path ["ui", "button"] #}
```

Direct/from-import callable:

- path length is 1;
- visible declaration for `button`/alias `b` is `imported` with `importKind: "from"`;
- register the canonical `exportedName` from the declaration and the local path used at the call site.

Namespace callable:

- path length is 2;
- visible declaration for `ui` is `imported` with `importKind: "namespace"`;
- register the second path segment as the exported callable name and the full local path, such as `ui.button`.

Invalid namespace call:

- path length is 1;
- visible declaration is an imported namespace;
- report a compile error because the namespace object is not callable.

Dynamic paths, deeper paths, and expressions without a visible static callable root are not static imported calls. When classified:

- mark the call target expression as a static callable call target;
- record the local callable path on the visible import declaration;
- compile the call through the imported static-call path, not the generic dynamic call path;
- keep the current value-boundary behavior, because imported exports may still be promises.

Use these helper boundaries:

- `visibleDeclarations` remains ordinary source-point value visibility.
- `visibleCallableDeclarations` carries static callable declarations across clean callable scopes without carrying ordinary vars.
- `findCallableDeclaration(node)` first checks source-visible shadowing, then reads the callable declaration snapshot.
- `collectStaticCallableCallFacts(node)` uses that declaration plus the static call path to return the local macro/from-import/namespace-call descriptor, or reports namespace-call / unsupported-path errors.

## Non-Call Validation

After macro/callable paths are known in async template mode, any source use of that path outside its classified call target is a compile error. This applies to local macro declarations and to imported callable paths.

This includes:

- bare reads of a local macro name or classified from-import callable alias;
- passing the macro/callable value as an argument;
- assigning it to another variable;
- reading a classified namespace callable member as a value;
- using it as the base of a deeper lookup.

Layer onto existing immutable-assignment checks. `failImmutableMutation` already rejects assignment to immutable/import bindings where applicable; that message should keep winning for assignments. The new validation adds read cases (bare read, argument, deeper lookup) and belongs with static call classification.

Use one mode-aware callable value validator, not separate local/imported checks. The validator runs after call classification has marked valid callable call targets. In async templates, any direct macro/callable reference that is not the classified call target is a compile error. In script mode, the validator checks only direct macro/callable reference nodes and their syntactic position; it must not become callable-handle dataflow or taint analysis. The pitfall is over-rejecting script handles, under-rejecting direct template/runtime macro values that bypass channel-fact analysis, or trying to prove alias-derived uses.

The validator should use parent/position checks, not recursive analysis. Valid call targets are explicitly marked by call classification. Assignment targets, macro/function parameters, import targets, and other symbol-target positions are not value reads and must stay out of this validation path.

This deliberately makes async template macros call-only. Supporting macro values in templates would require macro-value dataflow facts so `x()` can contribute the callee body's exact observes/mutates/uses facts. That is out of scope here.

The check must be path-based and declaration-aware so shadowed local names are not rejected because an outer import path was classified as a callable.

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
{{ ui.button("Save") }}   {# only ui.button is call-only #}
```

## Runtime Validation

Do not validate imported exports as macros at import time. Static imported calls may target either a Cascada macro or an ordinary function, so the call site owns runtime dispatch:

- if the export is missing, preserve the existing missing-import behavior;
- if the export exists but is neither a macro nor a function, use the normal call-target error path;
- if it is a macro, invoke it through the macro contract;
- if it is a function, invoke it through the normal async call wrapper.

For from-imports, reuse the existing binding-level missing-import path: the `hasOwnProperty` check that `_emitAsyncFromImportBindings` already emits per alias in `src/compiler/composition.js`.

For namespace static calls, read the static member through the import export helper at the call site, so a missing `ui.button` is still a missing import/member rather than an undefined dynamic member call.

Preserve payload semantics by sharing the same export resolution result used for ordinary import bindings. Do not add a separate required-callable import resolution path.

Add a single runtime helper over the macro contract:

```js
runtime.isMacro(value)
```

The helper should use `_invoke` as the canonical runtime dispatch marker. `makeMacro` also sets `isMacro = true`, but static call dispatch, generic template guards, and diagnostics should share this one helper.

After imported callable classification exists, dynamic call-target paths must reject Cascada macros that were not reached through a recognized static call. Script mode must not use this guard. Arguments do not need a broad runtime guard; source-visible macro arguments are compiler errors, while unknown runtime values may cross call/filter/test argument boundaries. Ordinary output uses normal text-value validation rather than a macro-specific runtime check. Do not include discarded `do` expressions in this runtime guard list; `do` shape validation belongs to compiler analysis.

## Codegen Shape

Imported static calls stay value-boundary calls because imports may resolve asynchronously. Inside the boundary:

```js
runtime.callWrapStaticCallableAsync(callableValue, name, context, args, errorContext, currentBuffer)
```

Local macros can emit direct `runtime.invokeMacro(...)` calls. Imported static calls may need a value boundary because the import can be async. The imported-call helper resolves the callable enough to decide macro vs function, preserves `currentBuffer`, and dispatches through `runtime.invokeMacro` for macros or `runtime.callWrapAsync` for functions.

Once imported static calls are classified, the generic async-template dynamic call path must not auto-dispatch Cascada macros. Statically classified local macro calls and imported callable calls use dedicated paths; if a generic template call target resolves to a macro after that phase, report a fatal runtime error. CascadaScript keeps the existing dynamic macro/function call behavior.

## Clean Scope Transport

Use the same owner-entry direct callable binding transport as root-local macros where the imported static call resolves to a Cascada macro; do not add a separate inheritance import payload. Clean-scope transport should carry only the static callable paths that were classified by analysis.

Target shape:

- local root macro: direct macro function;
- from-import imported callable: from-import binding `jsVar`;
- namespace imported callable: namespace `jsVar` plus exported property name, read through the same static-call helper.

There are two clean-scope mechanics:

- ordinary macro bodies compiled inside the root JS function already work today without owner-entry transport, but the imported callable analysis phase must make their classification declaration-visibility based rather than fallback-driven (see [Declaration Visibility](#declaration-visibility));
- inheritance callables run outside the root JS function, so methods, blocks, constructors, and inheritance-compiled root macros need owner-entry transport.

Crux of this phase: `createDirectCallableBindings` runs synchronously before the entry root executes, so root-local macros can be constructed there but import `jsVar`s do not exist yet.

Clean-scope transport supports imports with a static target and no explicit import inputs. `with context` is supported because the factory has the render context; dynamic import targets and explicit payload inputs are rejected for clean-scope callable use instead of adding a second payload/runtime path.

The factory starts the normal export evaluation for supported required modules and stores the export value or promise in the binding table under a compiler-owned import key. From-import aliases also get direct alias entries; namespace imports reuse the namespace export entry and still read the member at the call site. The call site keeps its value boundary to await unresolved imports.

Constructor import statements reuse the factory-created export value when clean-scope callable transport required it. Do not run `getExported(...)` twice for the same import. `env.getTemplate` caches the compiled template object, not export evaluation; re-running export evaluation can duplicate side effects and break payload semantics.

Explicit payload expressions (`with value`, named inputs, object inputs) are a compile-time error when that imported callable is used from a clean scope.

The table is named `directCallableBindings` because it carries root-local macros and classified imported callable paths. Ordinary imported values must not be retrievable through it.

Clean callable compilation uses the same source construct for local and imported macro references:

```js
currentInstance.getDirectCallableBinding(methodData, key, errorContext)
```

where `key` may be a local macro name (`"label"`), a from-import alias (`"button"`), a namespace binding (`"ui"`), or the compiler-owned import-export key used to share constructor and factory import evaluation.

The table may contain callable values, namespace export values, or promises for either. If a binding may be async, keep the value boundary at the call site; do not make `runtime.invokeMacro` promise-aware.

## Import Declarations

Imported declarations stay direct declarations. From-import aliases reuse their direct `jsVar`; namespace static calls read the exported property from the namespace `jsVar`. Do not create parallel declarations for namespace members unless it clearly simplifies transport.

## Error Messages

Compile errors should name the path and the reason:

- `Callable 'button' cannot be used as a value in an async template. Call it directly.`
- `Imported callable 'button' cannot be used as a value.`
- `Imported callable 'ui.button' cannot be used as a value.`
- `Import namespace 'ui' is not callable; call a named export such as ui.name(...).`
- `Macro 'button' cannot be called through a dynamic value in an async template. Call it directly.`
- `Cascada function 'button' cannot be used directly in a native call or root return.`

Use the call-site/import error context that gives the clearest source location. For non-callable imported values, prefer normal call-target diagnostics; for missing export, keep the existing import-name context. Error construction can be centralized only if it preserves the source of truth: compile errors for statically invalid use, fatal runtime errors for dynamic macro contract violations, and existing missing-import contexts for absent exports.

## Tests

Add async tests for:

- from-import macro called from another macro (regression - already works);
- namespace macro called from another macro (regression - already works);
- from-import macro called from method/block/constructor;
- namespace macro called from method/block/constructor;
- a constructor body specifically (the riskiest case for the factory timing problem, since root imports may not run through the constructor);
- local macro bare read, pass-as-value, assignment, and alias call are compile errors in async templates;
- async-template `do` expressions without any function call are compile errors;
- imported callable bare read, pass-as-value, assignment, and alias call are compile errors in async templates after that path has been statically called;
- CascadaScript allows macro/function handles in assignments, object/array aggregate declarations, non-root function returns, and Cascada function/macro arguments;
- optional script hardening rejects direct local/imported macro/function handle references in root returns, native/global call arguments, dynamic unknown call arguments, and ordinary scalar/data use;
- optional script hardening does not chase aliases when validating macro/function handle use;
- shadowing by macro arguments prevents imported classification;
- root-local import after a macro declaration is not visible inside that macro;
- non-call use of a classified from-import callable is a compile error;
- non-call use of a classified namespace callable member is a compile error;
- namespace object remains usable as an ordinary value/member source;
- namespace itself cannot be called;
- dynamic namespace macro calls are rejected in async templates; ordinary dynamic calls remain valid only for non-macro values where the namespace itself is source-visible;
- generic async-template dynamic calls reject macro values at runtime, while CascadaScript dynamic calls still allow them;
- `from "x" import button as b` validates exported name `button`, while source validation/error reporting identifies local alias `b` where appropriate;
- imports with `with context` work when their classified callables are called from clean scopes;
- explicit payload / `with value` imports work only when their payload setup can be compiled in the root-like factory environment; otherwise clean-scope macro use is rejected with a compile-time limitation;
- missing static namespace export reports the import/member as missing;
- classified export exists but is not callable: normal call-target error;
- classified export resolves asynchronously to a non-callable: normal call-target error;
- missing classified export keeps missing-import behavior;
- inherited parent block uses its own imported callable, not the child's import;
- super block uses the owner entry's imported callable bindings.

## Implementation Phases

1. Template macro call-only migration
   - audit the existing tests, fixtures, and in-repo templates for macro-as-value usage before landing the behavior change;
   - add the mode-aware callable value validator for macro uses the compiler already recognizes today;
   - reject non-call use of local macro declarations in async templates;
   - keep existing direct macro-call behavior otherwise unchanged;
   - update `docs/cascada/template.md` for the landed local macro call-only behavior.

2. Imported static calls
   - keep local macro calls in the macro path and classify static imported calls as imported callable facts;
   - mark local macro calls and imported callable calls with the shared valid-call-target fact so both skip value-use validation;
   - record classified imported callable paths on the visible import declaration for validation and future clean-scope transport;
   - reject non-call use of classified imported callable paths in async templates;
   - preserve source-visible shadowing and callable declaration visibility;
   - add a small runtime macro predicate;
   - add template-only generic-path guards for macro values that reach dynamic call targets without recognized macro-call analysis;
   - do not add runtime macro-value guards for template output or call/filter/test arguments; they were removed because the limited benefit was not worth the extra runtime code and complexity;
   - remove import-time macro export validation because static imported calls may resolve to ordinary functions;
   - compile imported callable registrations through value-boundary emission, using `callWrapStaticCallableAsync` after resolving the imported value enough to distinguish macro vs function;
   - keep ordinary dynamic calls for non-classified non-macro imported values where they are source-visible;
   - update user-facing template/import documentation for imported static calls and call-only imported paths.

3. Clean scope transport
   - extend direct callable bindings so macros/methods/blocks/constructors can use classified imported callable paths visible at their declaration point;
   - keep ordinary imported values out of clean scopes;
   - update template inheritance/composition documentation for imported static calls from clean scopes.

4. CascadaScript macro/function handle policy
   - validate direct local and imported script macro/function handle references by syntactic position only, without alias/dataflow tracking;
   - allow direct handle references in assignments, object/array aggregate declarations, non-root function returns, and arguments to statically known Cascada macro/function calls;
   - reject direct handle references at script root-return/native/global/dynamic-unknown escape points;
   - update CascadaScript documentation with the allowed handle positions and escape restrictions.

5. Naming cleanup
   - rename the clean-scope owner-entry transport from direct macro bindings to direct callable bindings because it carries root-local macros and classified imported callable paths;
   - defer broader declaration-table renames to the direct-storage cleanup phase.

6. User-facing documentation sweep
   - implemented for Phase 1: `docs/cascada/template.md` documents local template macro call-only behavior and notes that CascadaScript is not subject to this template-only rule;
   - after Phases 2-4, review template and script docs together so imported static calls, clean-scope imported callables, and script callable-handle rules are described without compiler-internal terminology.

## Architectural Guardrails

- Source lookup uses `visibleDeclarations`; static callable lookup uses `visibleCallableDeclarations`; ownership/aggregation can use finalized declaration maps.
- Declaration conflicts are semantic, not storage-based. Do not treat every `storage: DIRECT` declaration as an immutable macro/import-like binding; direct storage can also be an optimization for ordinary variables.
- Local macro calls and imported static calls stay as separate analysis facts but share the same static-call-target marker for validation.
- Clean-scope imported callable access is a classified callable transport, not ordinary variable visibility.
- Runtime callable type handling belongs at the call site: macros dispatch through `invokeMacro`, functions dispatch through the normal async call wrapper, and non-callables use normal call-target diagnostics.
- Prefer compile/analysis validation whenever source shape or visible declarations make an invalid macro use knowable. Do not add runtime checks to compiler paths such as `compileDo` merely to catch statically invalid syntax after evaluation.
- Namespace support is one-level and path-specific.
- Script callable validation is intentionally syntactic: validate direct macro/callable reference nodes, but do not build alias/dataflow tracking.
- Do not over-unify inherited methods/blocks with macro callable values. `this.method(...)` and `super()` are callable surfaces with owner/override semantics, not first-class callable handles; `this.method` remains unreadable as a value.
- Avoid a second inheritance payload path for imports.
- Avoid global imported-binding fallbacks that ignore source order.
