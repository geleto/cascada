# Composition Update

This document extracts the composition/import/export follow-up work that was previously mixed into [command-buffer-refactor.md](https://markdownlivepreview.com/command-buffer-refactor.md).

It now owns the material that was previously tracked there as Steps 9-10.

It covers only the composition-specific changes:

-   deferred exports resolving from explicit producer snapshots
    
-   explicit named composition inputs instead of ambient buffer visibility
    
-   removal of runtime-dynamic block/composition input declaration
    

Core command-buffer structure changes remain in [command-buffer-refactor.md](https://markdownlivepreview.com/command-buffer-refactor.md).

## Main Conclusions

The composition update should move toward these rules:

1.  Deferred exports should resolve from explicit producer snapshots, not ambient visibility.
    
2.  Composition should not use channel linking/lookup for data transport.
    
3.  `include`, `import`, `from import`, and `extends ... with ...` should continue to use explicit named inputs declared by `extern`.
    
4.  Inheritance should move to explicit signatures and explicit arguments: template `block name(args)` and script `method name(args)`.
    
5.  Every template or script must be compilable on its own, without requiring compile-time knowledge of the linking parent or child. Inheritance contracts must therefore be self-describing in the file that declares them.

6.  `super()` should forward the original invocation arguments by default, and `super(...)` should let a child override them explicitly.

7.  `extends ... with ...` should configure base-template or base-script root `extern` values without creating shared mutable parent state.

8.  Explicit arguments and `with context` render-context visibility must remain distinct semantics during the refactor.
    

Terminology note:

-   this document uses compositionSourceBuffer as shorthand for the per-template source-buffer entry currently stored inside compositionSourceBuffersByTemplate
    

## Deferred Exports

Current deferred exports in src/environment/context.js work by:

-   storing a promise placeholder in context.ctx
    
-   remembering the producing { channelName, buffer }
    
-   later resolving that export from channel.finalSnapshot()
    

So yes: deferred exports are ultimately resolved from final snapshots.

### Why are they linked to buffers today?

After auditing the current code, the justification looks weak.

addDeferredExport(...) stores both:

-   the resolver in exportResolveFunctions
    
-   the explicit producer record { channelName, buffer } in exportChannels
    

Then resolveExports(...) resolves from that explicit producer buffer directly.

### Target Direction

This should be simplified.

Deferred exports should not need general-purpose buffer linking if the producer { buffer, channelName } is already known.

The clean target is:

-   deferred exports resolve directly from their producer channel finalSnapshot()
    
-   they do not rely on ambient visibility or general buffer linking
    

resolveExports(...) in src/environment/context.js already mostly follows this model because it stores { buffer, channelName } pairs and resolves from the producer buffer directly.

That means linkDeferredExportsToBuffer(...) should be audited aggressively. It may already be redundant for export resolution itself.

## linkDeferredExportsToBuffer(...)

This is part of the current export/linkage mechanism, not extern passing.

After auditing current callers, it appears to be used only from async-root setup, and linkVisibleChannel(...) is only used by this export-linking path.

That should likely shrink or disappear as export handling is simplified around direct producer snapshots.

If that audit result holds, the cleanup is broader than just one call site:

-   linkVisibleChannel(...) becomes removable
    
-   the \_visibleChannels export-linking role becomes removable as well, if no other writers are introduced
    
-   any broader findChannel(...) traversal cleanup still belongs to the command-buffer/runtime migration, not to Step A alone
    

Also, resolveExports(...) still has a fallback arm that does:

-   currentBuffer.findChannel(name)
    

After auditing Context, this fallback appears defensive rather than essential:

-   addDeferredExport(...) always creates both a non-null resolver and an exportChannels\[name\] record
    
-   addResolvedExport(...) stores a resolved value and marks the resolver slot as null
    

So in normal deferred-export flow, a non-null resolver should already imply an explicit producer record. The fallback should therefore become an assertion during refactor, and then be removed once the invariant is validated by tests.

The sequencing matters:

-   first assert that a deferred export resolver never exists without a matching exportChannels\[name\] producer record
    
-   then run focused suites to prove the assertion never fires
    
-   only after that remove linkDeferredExportsToBuffer(...) and the currentBuffer.findChannel(name) fallback arm

-   if the assertion does fire, fix the missing explicit producer-record path rather than preserving the fallback as a permanent compatibility mechanism
    

## Composition Surface Model

The user-facing semantics are now settled enough that this implementation document should follow them directly.

Composition has **two explicit input paths** plus one distinct visibility mechanism:

1.  **Root composition inputs** via `extern`

    These are used by:

    -   template `include`, `import`, `from import`
        
    -   script `import`, `from import`
        
    -   template or script `extends ... with ...`
        

2.  **Override-call arguments** via explicit signatures

    These are used by:

    -   template `block name(args)`
        
    -   script `method name(args)`
        

3.  **Render-context visibility** via `with context`

    This is not an input payload by itself. It is a lookup rule that can satisfy `extern` resolution or make render-context names visible inside a block/method body when that body declares `with context`.

`without context` is the explicit opt-out from that render-context lookup rule. It should not be confused with the absence of explicit `extern` inputs or explicit block/method arguments.

The implementation should mirror that split. We should no longer treat composition as one generic ambient-scope mechanism and then reconstruct inputs at runtime from buffers.

## Composition And Explicit Inputs

Current composition still has some buffer-based machinery:

-   compositionSourceBuffer
    
-   findChannel(name)?.finalSnapshot()
    
-   inheritance-argument recovery from composition buffers or parent buffers
    

Architecturally, this should change.

The target is:

-   template `include`, `import`, and `from import` keep using explicit named inputs declared by `extern`

-   script `import` and `from import` keep using explicit named inputs declared by `extern`

-   `extends ... with ...` should use the same explicit `extern` mechanism to configure root-level values in the base template or base script

-   inheritance stops relying on ambient parent-scope recovery and instead uses explicit signatures plus explicit argument passing
    
-   composition should not rely on channel linking/visibility for value transport
    
-   composition should pass named snapshots/promises/macros as inputs

-   explicit arguments and `with context` render-context visibility should remain separate channels of information rather than being collapsed into one generic inherited-input mechanism

-   base-root `extern` configuration and per-call block/method arguments should remain separate mechanisms
    

So yes: composition should move away from buffer linking.

This is not just an adjacent cleanup. It is the main remaining source of runtime-dynamic channel names, so it needs to be solved if we want fully static composition entry and buffer lane sets.

Two consequences matter most:

-   the root-composition path (`extern` + `with`) should be uniform across import-like operations and `extends ... with ...`
    
-   the inheritance-call path (`block(...)` / `method(...)`) should be uniform across normal parent calls and `super(...)`

## Existing Mechanisms To Reuse

The implementation work should reuse as much of the existing explicit-composition machinery as possible instead of inventing a parallel system for inheritance.

### Reuse import/include-style extern passing for `extends ... with ...`

We already have a real explicit-input pipeline for composition boundaries in `src/compiler/inheritance.js`:

-   `_emitExplicitExternInputs(...)` collects the named `with` values into one explicit object

-   `_emitCompositionContextObject(...)` merges explicit values with optional `with context` render-context visibility

-   `runtime.validateExternInputs(...)` validates the callee's `externSpec`

-   `runtime.validateIsolatedExternSpec(...)` already enforces the isolated-composition case

That means `extends ... with ...` should not invent its own root-input transport model.

The target should be:

-   base-template or base-script root `extern` values use the same explicit input-object shape already used by import/include-style composition

-   `extends ... with ...` reuses the same validation rules and error surface as other `extern` boundaries

-   the only semantic addition is timing: those values are read when the `extends` operation executes, because child `var` declarations immediately above it are valid inputs

In short: **`extends ... with ...` is composition-boundary input passing, not inheritance-argument passing**.

`from import` should follow the same rule. The selected exported names are an export-surface concern, but `externSpec` remains the imported file's root composition contract, so validation should stay aligned with the normal import/include-style boundary rather than inventing a `from import`-specific subset rule unless the runtime semantics are intentionally changed.

### Reuse macro-style explicit parameters for block/method arguments

We also already have a real explicit-parameter model for callable bodies in `src/compiler/macro.js`:

-   macro parameters are declared up front in analysis (`macroParam: true`)

-   `_parseMacroSignature(...)` turns the declared parameter list into a concrete compiled call shape

-   the compiled macro function receives explicit arguments directly rather than discovering names from runtime context state

Blocks and methods are not macros, but their argument model is closer to macros than to include/import composition:

-   they have an explicit declared parameter list

-   they compile independently from the caller

-   their bodies read ordinary local bindings

-   invocation passes explicit arguments directly

So the inheritance implementation should treat blocks/methods as **override-capable explicit callables**, not as a special case of ambient scope reconstruction.

### Build one shared callable-parameter helper

The simplest implementation is to reuse the macro machinery more directly instead of creating one parameter pipeline for macros and a second one for blocks/methods.

The codebase already has the hard part of explicit callable parameters:

-   `_parseMacroSignature(...)` already turns declared parameters into a concrete compiled call shape

-   macro analysis already marks declared parameters as locals before the body is compiled

-   macro compilation already receives explicit arguments rather than recovering names from runtime context state

So Step B should introduce one shared callable-parameter helper used by:

-   macros

-   template blocks

-   script methods

That shared helper should own:

-   analyzing declared parameters

-   declaring those names as locals before the body is compiled

-   generating the explicit invocation payload shape

-   generating the explicit local-initialization shape at callable entry

Inheritance still adds its own layer on top:

-   override linking

-   `super()` / `super(...)`

-   inherited `with context`

But blocks/methods should not invent a second independent parameter system when the macro pipeline already solves most of the same problem.

### Where methods/blocks differ from macros

Methods and blocks still need machinery that macros do not:

-   override linking between parent and child implementations

-   `super()` forwarding with the original invocation arguments

-   `super(...)` replacing those arguments explicitly

-   inherited `with context` visibility from the base declaration

-   interaction with `extends ... with ...` base-root configuration

So the right implementation analogy is:

-   **root extern configuration** behaves like import/include-style composition

-   **block/method arguments** behave like macro-style explicit parameters

-   **inheritance linking and `super`** are the extra layer that only methods/blocks need

### Include/import vs. methods/blocks

This distinction should stay sharp in the implementation plan:

-   `include with`, `import with`, `from import with`, and `extends ... with ...` all cross a root composition boundary and therefore belong to the `extern` pipeline

-   `block(...)`, `method(...)`, `super()`, and `super(...)` are override-call operations and therefore belong to the explicit-argument pipeline

This matters because it tells us what code should converge:

-   `extends ... with ...` should converge with `_emitExplicitExternInputs(...)`, `_emitCompositionContextObject(...)`, and `validateExternInputs(...)`

-   block/method invocation should converge with macro-style explicit parameter declaration and call-shape generation

-   neither path should fall back to `findChannel(...)` or runtime name discovery

## Compiler And Runtime Responsibilities

The clean end state should divide responsibility like this:

### Compiler responsibilities

-   emit one explicit root-input object for each import/include/extends composition boundary

-   emit one explicit argument payload for each block/method invocation and each `super(...)` call

-   declare block/method locals from their signature at compile time

-   keep `with context` metadata separate from explicit payload data

-   stop emitting runtime loops that recover inheritance names from `Context`

### Runtime responsibilities

-   validate `extern` inputs against `externSpec`

-   initialize base-root extern values from the explicit composition payload

-   invoke parent or child block/method bodies with the explicit argument payload

-   preserve the original invocation arguments for bare `super()`

-   use replacement arguments for `super(...)`

-   keep render-context lookup separate from both root extern payloads and block/method argument payloads

That split should let us remove ambient buffer-based recovery without losing any of the current semantics we want to preserve.

### What buffer plumbing stays vs. goes

The composition cleanup should remove command-buffer usage for **input discovery**, not command-buffer usage in general.

What should go away:

-   linking parent/child buffers so a child can discover values through visible channels

-   `context.getCompositionSourceBuffer(...)` as an inheritance input source

-   `parentBuffer?.findChannel(name)?.finalSnapshot()` as an inheritance argument fallback

What should remain unless a separate output-ordering redesign replaces it:

-   passing the active command buffer through block and `super` calls where it is still needed for output ordering

-   using the current command-buffer tree to preserve ordered output application

-   keeping execution/output context separate from explicit input payloads

So the rule for implementation is:

-   **remove buffer lookup for data transport**

-   **keep buffer threading where it is still the execution/output-ordering mechanism**

### Validation should move earlier

The new model creates an opportunity to simplify validation instead of pushing more checks into runtime entry code.

The preferred split is:

-   compile time or analysis time: validate extern fallback order and indirect extern cycles

-   link time or load time: validate parent/child signature compatibility for blocks and methods

-   runtime: validate only the concrete provided root inputs against `externSpec`

This keeps runtime entry paths smaller and makes failures easier to understand.

For extern cycles, "indirect cycle" should be understood concretely. Examples include:

-   `extern a = b` and `extern b = a`

-   longer fallback chains such as `extern a = b`, `extern b = c`, `extern c = a`

These should be rejected by the explicit-input analysis rather than being left to fail later during runtime initialization.

## Inheritance Execution Model

This section states the intended user-visible model so the implementation work has a fixed semantic target.

### User-facing model

For inheritance, explicit arguments belong to the override point itself:

-   templates use `block name(arg1, arg2)`

-   scripts use `method name(arg1, arg2)`

-   every override declares the same signature explicitly, so each file remains self-describing and independently compilable

-   arguments behave like ordinary local bindings inside the block or method body

-   rebinding an argument locally does not write back to the caller

-   bare `super()` calls the parent implementation with the original arguments from the current invocation

-   `super(arg1, arg2)` calls the parent implementation with explicit arguments chosen by the child

-   `with context` remains separate from explicit arguments; it controls render-context visibility rather than positional or named arguments

-   method or block bodies compute and return/render values; they are not an implicit cross-file channel transport mechanism

This model is intentionally closer to ordinary method overriding than to inherited ambient scope.

For deeper inheritance chains, each override level should preserve its **own incoming invocation payload** separately. In an `A -> B -> C` chain:

-   when `C` is invoked, it preserves the arguments passed into `C`

-   bare `super()` inside `C` forwards those same incoming `C` arguments to `B`

-   if `B` then calls bare `super()`, it forwards the arguments passed into `B` for that call

So "original invocation arguments" always means the arguments originally received by the current override frame, not a single global root call payload shared across the whole chain.

### Why inheritance arguments are not `extern`

Although both are explicit inputs, they belong to different boundaries:

-   `extern` is a root composition contract for include/import-style composition

-   the same `extern` mechanism should also be used by `extends ... with ...` to configure the base template or base script before inherited execution begins

-   block/method arguments are an inheritance contract for a specific override point

-   `extern` values are initialized for a composed template or script root

-   block/method arguments are captured for one specific invocation and may vary from one invocation to the next

-   `super(...)` needs direct control over the parent call's arguments, which is method-like behavior rather than root-composition behavior

So inheritance should use its own explicit signature/argument model even though some of the underlying transport machinery may look similar to `extern` handling.

### `extends ... with ...` and base externs

The recommended inheritance model has two distinct explicit input paths:

-   `extends ... with ...` configures root-level `extern` values declared by the base template or base script

-   block or method signatures declare the per-invocation arguments for override points

These should not be collapsed into a single mechanism.

`extends ... with ...` is useful because it gives the child an explicit way to configure base-level values while still preserving standalone compilation and precompilation:

-   the base file declares its own root contract through `extern`

-   the child file decides which values to pass on the `extends` line

-   the values are copied at the composition boundary

-   `extends` may appear after child `var` declarations, so those values must be read when the `extends` operation executes, not when the variables are first declared

-   later child reassignment does not mutate the already-configured base value

-   if a passed value is still a pending promise when `extends` executes, that promise is what gets copied into the base root contract; `extends` should not eagerly await it just to perform the handoff

This is intentionally closer to explicit superclass configuration than to shared mutable class fields.

### `with context` is two distinct things

The composition update needs to preserve the fact that `with context` is used in two different but related places:

-   on a composition boundary, `with context` allows a child or base root `extern` to resolve from the render context

-   on a block or method declaration, `with context` makes render-context names visible inside that specific body

Those are both render-context lookup rules, but they are not the same payload as explicit `extern` inputs or explicit block/method arguments. The runtime/compiler representation should keep those concepts separate.

### `without context` remains the explicit opt-out

The explicit-input refactor should not change the meaning of `without context`.

-   when a composition boundary or callable body does not opt into `with context`, render-context lookup should remain unavailable there by default

-   if the language already allows an explicit `without context` form, that should continue to mean "do not inherit render-context visibility here" even after explicit extern payloads and explicit argument payloads are introduced

-   `without context` is therefore the negative form of the same visibility rule; it is not part of the explicit `extern` payload and not part of the explicit block/method argument payload

### Concrete examples

Template:

```njk
{# base.njk #}
{% extern theme = "light" %}
{% block content(user) with context %}
  Base {{ user }} / {{ siteName }} / {{ theme }}
{% endblock %}
```

```njk
{# child.njk #}
{% set theme = "dark" %}
{% extends "base.njk" with theme %}

{% block content(user) %}
  {% set user = "Grace" %}
  Child {{ user }} / {{ siteName }} / {{ super() }}
{% endblock %}
```

Rendered with:

```javascript
{ user: "Ada", siteName: "Docs" }
```

Expected result:

```text
Child Grace / Docs / Base Ada / Docs / dark
```

This fixes the target semantics:

-   `{% extends "base.njk" with theme %}` configures the base template's root externs

-   `with context` exposes `siteName` inside the block body but does not make it an explicit block argument

-   `super()` preserves the original block-call argument `user = "Ada"` even though the child block rebinds its local `user`

Script:

```cascada
// base.script
extern theme = "light"

method buildBody(title, user)
  return "[" + theme + "] " + user.name + ": " + title
endmethod

var body = buildBody(title, user)
return body
```

```cascada
// child.script
var theme = "dark"

extends "base.script" with theme

method buildBody(title, user)
  return "Child " + super(title, { name: "Guest" })
endmethod
```

Rendered with:

```javascript
{ title: "Q1 Report", user: { name: "Ada" } }
```

Expected result:

```text
Child [dark] Guest: Q1 Report
```

This fixes the target semantics:

-   `extends ... with ...` configures the base script once for the whole run

-   method arguments remain the per-call override interface

-   `super(...)` intentionally changes the parent method's arguments

## Runtime-Dynamic Composition Channel Names

This should be fixed as part of the composition update.

The target is:

-   no runtime-dynamic composition/block-input channel names
    
-   block/composition entry uses compile-time-known names
    

That means composition/inheritance argument handling must be redesigned so it does not loop over runtime names and call:

-   declareBufferChannel(currentBuffer, name, ...)
    

Instead:

-   composition should pass explicit named snapshot values
    
-   the receiving template/script should use explicit extern/input bindings
    
-   block entry should initialize from an explicit payload, not from context lookup
    

So the current composition/block-input runtime loop is not something to accommodate with a permanent lazy fallback. It is technical debt to remove.

However, that runtime-loop removal depends on a separate structural prerequisite:

-   block/composition inputs still need real local var channels/lane declarations before block bodies run

-   if the command-buffer refactor has not yet made local declared lanes constructor-time/static, this plan must keep a temporary declaration path until that prerequisite lands

## Tests And Invariants

The composition update should preserve and strengthen invariants such as:

-   deferred exports resolve from final snapshots
    
-   resolveExports(...) relies on explicit producer records rather than ambient buffer visibility
    
-   composition uses explicit named inputs, not channel visibility
    
-   no runtime-dynamic composition/block-input channel declaration remains

-   `extends ... with ...` uses the same explicit `extern` contract model as import-like composition

-   values passed through `extends ... with ...` are copied when the `extends` operation executes, not when the child variables are first declared

-   explicit inheritance arguments do not become conflated with `with context` render-context visibility

-   same-template and inherited block invocation snapshot values at invocation time rather than reading final channel state later

-   removing compositionSourceBuffer lookup also removes the parentBuffer?.findChannel(name)?.finalSnapshot() fallback, unless that fallback is deliberately justified and retained

-   extern/input validation rejects self-cycles and indirect initialization cycles as part of the same explicit-input contract model
    

## Migration Strategy

Because the current async composition code still tolerates some compatibility paths, the update should tighten invariants in stages:

1.  add debug/development assertions around unexpected export fallbacks and unexpected runtime-discovered composition inputs
    
2.  run focused composition and export suites to surface any remaining gaps
    
3.  remove the old fallback paths once the assertions stop firing
    

This is especially important for:

-   removal of deferred-export fallback lookup
    
-   composition/block-input staticization

-   distinguishing temporary command-buffer/runtime prerequisites from composition-specific cleanup
    

## Implementation Plan

### Step A. Simplify deferred exports around explicit producer records

Goal:

-   stop using buffer visibility for export resolution
    

Primary files:

-   src/environment/context.js
    
-   src/compiler/compiler-async.js
    

Changes:

-   make resolveExports(...) rely on the explicit { buffer, channelName } producer record
    
-   convert the currentBuffer.findChannel(name) fallback into an assertion first
    
-   remove linkDeferredExportsToBuffer(...) once tests confirm it is unnecessary
    
-   keep exportChannels / exportResolveFunctions as the explicit producer-record mechanism
    
-   remove the emitted context.linkDeferredExportsToBuffer(...) call from compiler output
    
-   remove linkVisibleChannel(...) as well, since export linking is its only current use
    
-   audit whether the \_visibleChannels slot still has any remaining purpose once export-linking no longer writes into it

-   if the writer audit still shows no non-export users, remove the \_visibleChannels storage only; any broader findChannel(...) traversal simplification remains a later/runtime concern
    

Ordering constraint:

-   do not remove linkDeferredExportsToBuffer(...) until the new assertion proves that every deferred resolver already has an explicit producer record
    

Tests for this step:

-   keep existing async import/from-import export tests green
    
-   keep loop-concurrent-limit async export tests green
    

Still-unimplemented tests to add here:

-   integration test: exported async value resolves correctly without parent visibility linking
    
-   integration test: resolveExports(...) fails/asserts if a deferred resolver exists without an explicit producer record
    

### Step B. Build the frontend and metadata foundation

Goal:

-   make the new composition and inheritance model representable in the frontend and validatable before runtime entry code is rewritten


Primary files:

-   src/nodes.js

-   src/parser.js

-   src/script/script-transpiler.js

-   src/compiler/compiler-async.js

-   src/compiler/macro.js

-   src/environment/template.js


Changes:

-   change `Block` nodes from legacy `withVars`-based inherited inputs to explicit signature args

-   add explicit argument storage to `Super` nodes so `super(...)` is first-class instead of a special runtime-only case

-   extend `Extends` nodes so they can carry `with context` and explicit named root inputs, just like other composition boundaries

-   update `parseBlock()` to reuse the signature parser instead of the old inherited-input parser

-   update `parseExtends()` to reuse the same composition-`with` parser shape already used by import/include-style operations

-   add script `method` / `endmethod` syntax in the script transpiler and parser path

-   keep compiled signature metadata on the compiled template or script, using `blockContracts` or a renamed equivalent

-   make that metadata shape explicit enough for precompiled/link-time validation, at minimum carrying:

    -   callable kind (`block` or `method`)

    -   callable name

    -   ordered parameter names and arity

    -   whether the callable declares `with context` or explicitly opts out

-   move inherited block/method signature conflict validation out of emitted runtime entry code and into analysis or link/load-time validation

-   extend extern validation work so indirect extern cycles are rejected by analysis/compile-time graph checks rather than being left adjacent to runtime entry

-   introduce one shared callable-parameter helper for macros, blocks, and methods so signature normalization and local declaration logic are not duplicated

-   preserve existing macro call semantics while sharing only the parameter-normalization and local-declaration machinery; any macro-specific calling behavior should remain intentionally unchanged unless documented separately


Ordering constraint:

-   do not rewrite inheritance entry/runtime payload flow until the frontend can express `block(...)`, `method(...)`, `super(...)`, and `extends ... with ...` directly

Internal sequencing inside this step:

-   B1. AST node changes plus parser/transpiler support for `block(...)`, `method(...)`, `super(...)`, and `extends ... with ...`

-   B2. shared callable-parameter helper plus compiled signature-metadata shape

-   B3. link/load-time signature validation plus analysis-time extern-cycle validation

B1 must land before B2 and B3. B2 and B3 can proceed independently once the AST and syntax surface are stable.


Tests for this step:

-   keep existing composition/import tests green

-   add or update parser/transpiler tests for:

    -   `block name(args)`

    -   `super(arg1, arg2)`

    -   `extends ... with ...`

    -   script `method` / `endmethod`

-   add validation tests for mismatched parent/child signatures and extern indirect cycles

-   add validation tests covering `without context` under the explicit-input model


Still-unimplemented tests to add here:

-   validation test: overriding template block must declare a matching explicit signature

-   validation test: standalone/precompiled child template compiles without compile-time knowledge of the parent template structure

-   validation test: mismatched parent/child block signatures are rejected during linking or loading

-   validation test: parent/child signature mismatch errors name the conflicting callable and signatures clearly

-   validation test: extern self-cycle is rejected

-   validation test: extern indirect cycle across multiple declarations is rejected

-   validation test: extern indirect-cycle errors name the cycle path clearly

-   validation test: `without context` still suppresses inherited render-context visibility under the new explicit model


### Step C. Reuse the existing extern pipeline for `extends ... with ...`

Goal:

-   implement base-root configuration for inheritance by reusing the same explicit extern-input machinery already used by import/include-style composition


Primary files:

-   src/compiler/inheritance.js

-   src/compiler/compiler-async.js

-   src/runtime/runtime.js


Changes:

-   treat `extends ... with ...` as root-level base configuration using the same explicit `extern` input model as import-like composition, rather than as inherited ambient scope

-   reuse `_emitExplicitExternInputs(...)` to collect named root inputs

-   reuse `_emitCompositionContextObject(...)` to merge explicit values with optional `with context`

-   if `_emitCompositionContextObject(...)` currently assumes an import/include-only caller shape, generalize that helper rather than cloning its logic for `extends`

-   reuse `runtime.validateExternInputs(...)` for concrete provided-name validation

-   ensure the `extends ... with ...` values are read when the `extends` operation executes, so child `var` declarations immediately above it can feed the base root contract

-   keep async-transparent handoff semantics: if one of those values is still a pending promise when `extends` executes, pass that promise through into the base root contract rather than awaiting it eagerly at the boundary

-   keep `with context` used on `extends ... with ...` scoped to root-extern resolution only, not to block/method argument transport

-   preserve one explicit root-input object shape for import/include/extends boundaries instead of creating an extends-only format


Ordering constraint:

-   do not mix base-root extern configuration with per-call block/method argument payloads

Dependency:

-   this step depends on Step B1 landing first so `Extends` nodes can carry explicit root inputs and `with context` metadata directly


Tests for this step:

-   keep current composition/import tests green

-   keep extern validation tests green


Still-unimplemented tests to add here:

-   integration test: `extends ... with ...` configures root externs in the base template or base script

-   integration test: child `var` declarations immediately before `extends ... with ...` are the values copied into the base root contract

-   integration test: `extends ... with context, name` resolves explicit names before render-context lookup for base externs

-   integration test: `extends ... with ...` passes through pending promises transparently rather than eagerly awaiting them at the boundary

-   integration test: `from import` continues to use the normal root `externSpec` validation model rather than a special subset-only validation rule


### Step D. Rewrite inheritance calls to explicit argument payloads

Goal:

-   make inheritance self-describing and standalone-compilable while removing runtime-discovered block/method input names


Primary files:

-   src/compiler/compiler-async.js

-   src/compiler/inheritance.js

-   src/environment/context.js


Changes:

-   redesign inheritance so template blocks and script methods use explicit declared signatures rather than inherited ambient input-name discovery

-   make each compiled block entry derive its declared locals from its own signature (`block name(args)`) rather than from `context.getBlockContract(...).inputNames`

-   implement the same machinery for script `method name(args)` with value returns

-   rewrite `_emitAsyncBlockInputInitialization(...)` around explicit signature locals and explicit argument payloads

-   remove the runtime declare-loop over dynamically discovered input names

-   stop using `_collectRootCompositionLocalChannelNames(...)` as a source for reconstructing inheritance inputs at runtime

-   remove compositionSourceBuffer-based channel lookup from inheritance argument initialization

-   remove the `parentBuffer?.findChannel(name)?.finalSnapshot()` fallback from inheritance argument initialization

-   keep argument transport snapshot-based and explicit

-   replace "base-only contract discovered later" semantics with "every override declares the signature explicitly"

-   make inheritance setup preserve two distinct payloads:

    -   base-root `extern` configuration from `extends ... with ...`

    -   per-call argument payloads for `block(...)`, `method(...)`, and `super(...)`

-   ensure `inheritance.js` and `compiler-async.js` agree on one explicit call shape for parent/child block invocation and for `super(...)`

-   preserve the original invocation-argument payload separately from the child's current local state so bare `super()` forwards original arguments correctly

-   support `super(arg1, arg2)` as an explicit parent-call override path

-   keep `with context` separate from explicit arguments: it remains inherited render-context visibility, not part of the argument payload

-   capture same-template locals intentionally visible at a template block invocation site at invocation time rather than recovering them later by channel lookup

-   update `Context.forkForComposition(...)` only as needed for the new explicit payload model; do not preserve buffer-based input lookup under a new name

-   keep buffer threading only where block/super execution still needs it for output ordering; remove buffer lookup for data transport

-   stop using `context.getBlockContract(...)` to decide what locals a block should declare at runtime


Dependency:

-   this step depends on Step B landing first so the AST, metadata, and validation model are stable

-   this step depends on the command-buffer/lane work needed to ensure declared argument locals have a valid static declared-channel/lane story after the runtime declaration loop is removed

-   if that prerequisite is not available yet, this step needs a temporary compatibility shim that declares the known argument locals through a fixed compile-time list rather than through runtime-discovered inherited names; the blocker is removal of dynamic-name discovery, not removal of local declaration itself


Tests for this step:

-   keep current async inheritance/super integration tests green once they are updated to the new explicit-signature syntax and semantics

-   update compile-shape tests in `tests/pasync/template-command-buffer.js` to assert that inheritance entry code uses declared signatures rather than runtime-discovered input-name loops


Still-unimplemented tests to add here:

-   integration test: bare `super()` preserves original invocation arguments even when the child rebinds locals

-   integration test: `super(arg1, arg2)` intentionally changes the parent block's inputs

-   integration test: three-level inheritance chain preserves per-frame original arguments correctly for bare `super()`

-   integration test: `with context` visibility remains separate from explicit block or method arguments

-   integration test: `without context` still opts out correctly under explicit argument payloads

-   compile-source test: generated block entry code no longer loops over runtime block-contract input names

-   compile-source test: generated block entry code no longer uses the output of `_collectRootCompositionLocalChannelNames(...)` to build a runtime recovery loop

-   compile-source/integration test: block entry no longer reads `context.getCompositionSourceBuffer(...)` for inheritance argument initialization

-   compile-source/integration test: block entry no longer reads `parentBuffer?.findChannel(name)?.finalSnapshot()` for inheritance argument initialization

-   integration test: no runtime-dynamic channel declaration is needed for inheritance arguments


### Step E. Delete remaining legacy composition and inheritance helpers

Goal:

-   finish cleanup once explicit producer records, explicit extern payloads, and explicit inheritance argument payloads are fully in place


Primary files:

-   src/environment/context.js

-   src/compiler/compiler-async.js

-   src/compiler/inheritance.js

-   src/parser.js

-   src/runtime/command-buffer.js


Changes:

-   delete any remaining export fallback lookup

-   remove the emitted `context.setCompositionSourceBuffer(...)` call from async root/inheritance setup once no readers remain

-   remove `compositionSourceBuffersByTemplate` and related helpers once Step D leaves them unused

-   remove `getBlockContract(...)` only after its runtime input-discovery role is gone and any remaining metadata role has been replaced or made metadata-only

-   simplify `Context.init(...)`, `forkForPath(...)`, and `forkForComposition(...)` once composition source-buffer state is gone

-   if Step A removed the last writer to `_visibleChannels` and no later step reintroduces one, delete any remaining dead `_visibleChannels` storage/read paths

-   delete the old parser/compiler/runtime helpers that only exist for legacy inherited-input recovery, including:

    -   `parseWithVars(...)`

    -   legacy block `withVars` parsing/compilation paths

    -   emitted block-entry loops over runtime-discovered inherited input names

    -   `context.getCompositionSourceBuffer(...)` / `setCompositionSourceBuffer(...)`

    -   `parentBuffer?.findChannel(name)?.finalSnapshot()` inheritance-input recovery

    -   `context.linkDeferredExportsToBuffer(...)`

    -   `CommandBuffer.linkVisibleChannel(...)`

-   keep `parentBuffer` or current-buffer threading only where block/super execution still needs it for output ordering; do not preserve any removed lookup behavior under the same parameter just for compatibility

-   if `blockContracts` remains under that name, make sure it is metadata-only by this point; if the name is misleading, rename it here to an explicit signature-metadata term

-   delete any temporary debug-only compatibility paths that only exist to support the old composition/export model


Done criteria for this step:

-   focused composition and inheritance suites pass with legacy lookup and recovery paths removed from compiled output

-   no compiled output still contains runtime-discovered inherited-input loops or composition-source-buffer recovery

-   the remaining uses of current-buffer or parent-buffer parameters are execution/output-ordering uses only, not data-transport lookups


Final verification for this step:

-   run focused suites for:

    -   `tests/pasync/composition.js`

    -   `tests/pasync/loop-concurrent-limit.js`

    -   `tests/pasync/loader.js`

    -   `tests/pasync/template-command-buffer.js`

-   then run the full relevant async composition/import/export suite

-   also run the extern validation suites because extern/input-cycle behavior is part of the same explicit-input contract surface

-   finally run the full test suite as the last cleanup gate, because removal of composition plumbing can still regress non-composition paths
    

## Final Recommendation

The composition update should proceed with these goals:

1.  Resolve deferred exports from explicit producer snapshots.
    
2.  Remove buffer-visibility-based export fallback lookup.
    
3.  Keep `extern`-based composition explicit for include/import-style composition and for `extends ... with ...`.
    
4.  Move inheritance calls to explicit signatures and explicit arguments.
    
5.  Keep base-root extern configuration separate from per-call block/method arguments.

6.  Delete composition/export compatibility helpers once the new path is proven.

7.  Preserve the semantic distinction between explicit arguments and `with context`.

8.  Support bare `super()` for original-argument forwarding and `super(...)` for explicit parent-call overrides.

9.  Preserve `without context` as the explicit opt-out from render-context visibility.

10.  Fold extern/input cycle validation into the same composition update instead of leaving it adjacent to the composition rewrite.
    

In short:

-   exports should resolve from snapshots
    
-   include/import/from-import and `extends ... with ...` should keep explicit `extern` inputs
    
-   inheritance should use explicit block/method signatures so each file compiles independently

-   base-root configuration and inheritance-call arguments should travel as two separate explicit payloads rather than one ambient-scope mechanism

-   inheritance entry should move to explicit argument payloads rather than runtime-discovered input-name recovery

-   `super()` should preserve original invocation arguments unless the child passes explicit replacement arguments

-   `with context` should remain distinct from explicit arguments

-   `without context` should remain the explicit opt-out from render-context visibility

-   extern/input cycle validation should be part of the same explicit-input cleanup
