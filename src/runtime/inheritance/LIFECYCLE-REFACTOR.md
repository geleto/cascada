# Inheritance Lifecycle Refactor Plan

## Purpose

The inheritance runtime is intended to follow a clean lifecycle:

1. resolve and load the full inheritance chain
2. finalize metadata once
3. execute the entry root program

For scripts, the entry root program is the finalized script constructor/body and
it owns the script return value. For templates, root-level template code is the
template constructor/program. It may contain text, blocks, loops, conditionals,
includes, shared-channel operations, and any other root-level template code.
Every template in the selected chain can have a constructor/program. Template
constructors behave as if they call the parent constructor at the end. Only the
topmost structural root performs callable inline block placement for document
structure.

The current implementation still mixes these phases. Parent roots are executed
in composition mode while the chain is being loaded, and compiled setup code
contains both startup work and template structure rendering. That coupling led
to residual workarounds around buffer lifetime and parent/child linking.

This refactor applies to async mode. The sync compiler has its own classic
Nunjucks inheritance path and is out of scope.

This refactor should make the async implementation look as if the intended
lifecycle had been implemented from the start. Do not preserve old staging
helpers, finished-parent linking behavior, or parent-render-as-loader concepts.

## Current Departures From The TDD

### Parent Root Execution Loads Metadata

Current behavior:

- `compileAsyncExtends(...)` emits a call to `renderInheritanceParentRoot(...)`
  or `bootstrapInheritanceParentScript(...)`.
- Those helpers compile the parent and call `parentRoot.rootRenderFunc(...)`.
- The parent root function then bootstraps its metadata as a side effect.

Why this is wrong:

- Loading metadata depends on executing generated root code.
- Parent startup/render concerns leak into the loading phase.
- Buffer lifetime becomes ambiguous because a "parent render" may be only a
  metadata discovery step.

Target behavior:

- Loading a parent should compile the parent and register
  `parent.inheritanceSpec` directly.
- No parent `rootRenderFunc(...)` should run during metadata loading.
- Parent loading should propagate real source origins from the `extends` node,
  replacing the current `createStubSourceOrigin(...)` temporary.

### `b___setup__` Mixes Startup And Structure

Current behavior:

- `b___setup__` declares shared channels and also compiles ordinary root
  children.
- For templates, this means the generated function is doing root program
  execution while still being treated as a setup helper.
- For extending templates, compiler checks suppress some output depending on
  static/dynamic parent state.

Why this is wrong:

- Metadata loading cannot run setup cleanly because setup is actually root
  program execution.
- Dynamic `extends` needs `parentReady` guards around local placement because
  root program execution may happen before the parent decision is complete.
- Suppression rules become scattered through output compilation.

Target behavior:

- Generate separate functions for:
  - metadata loading
  - root program execution
- For templates, root program execution is the constructor. It includes ordinary
  root-level template code, not only text between blocks.
- For scripts, root program execution is the constructor/body and owns the
  return value.
- `_isExtendingTemplateStartupOutput(...)` is a known residual workaround in
  `compiler-async.js`; the split should delete it rather than move it.

### Parent Decision State Drives Local Rendering

Current behavior:

- Dynamic templates create `extendsState.parentReady` and
  `extendsState.hasParent`.
- Top-level blocks and startup output wait on that promise to decide whether to
  render locally.

Why this is wrong:

- The render phase is compensating for a parent decision that should already be
  known before rendering begins.
- Block placement carries lifecycle control logic that belongs at the root.

Target behavior:

- Resolve the dynamic parent during metadata loading.
- Store a simple finalized render plan:
  - selected template constructor chain
  - selected structural root for inline block placement
  - selected context/composition payload
  - whether the entry template has no parent and should execute local fallback
- Root program execution should read that plan directly, not wait for a promise
  at every block site.
- `extendsState.parentSelection`, `extendsState.parentReady`,
  `extendsState.hasParent`, and the compiler property
  `topLevelDynamicExtends` are residual state from the mixed lifecycle and
  should be deleted.

### Dynamic Extends Evaluation Is The Hard Boundary

Dynamic `extends` expressions must still be evaluated at runtime. The clean
model needs an explicit rule for what those expressions are allowed to depend
on.

Target rule:

- Dynamic `extends` expressions are evaluated by the metadata loader before
  startup.
- They may read render-context/composition-payload values and globals.
- They must not depend on root-program-created channels or source-ordered command
  buffer state.

This matches the lifecycle: the parent chain must be known before root program
execution. If we want to support command-buffer/channel-dependent extends
expressions later, that is a separate feature requiring a dedicated
pre-root-program evaluation buffer. It should not be smuggled into normal
metadata loading.

### Buffer Linking Workarounds Appeared Around Finished Parents

Current behavior that must not return:

- Late-linking an active child buffer into an already-finished parent channel.
- Buffer APIs that silently switch between structural insertion and
  visibility-only linking.

Why this is wrong:

- A finished parent channel should not receive new structural children.
- If normal inheritance/component execution needs this, some owner buffer was
  closed too early or metadata loading was confused with rendering.

Target behavior:

- `CommandBuffer.addBuffer(...)` remains the structural linking primitive.
- Component root buffers stay open for the component binding lifetime.
- Render/root buffers stay open while root program and callable invocation can
  still add source-ordered work.
- No inheritance runtime path should depend on linking to a finished parent
  buffer.

## Target Architecture

### Compiler Output Shape

Each async script/template root should expose these compiled pieces:

```js
{
  root,                 // public render entry
  inheritanceSpec,      // raw compiler metadata
  loadInheritanceChain, // metadata-only chain loader
  executeRootProgram    // constructor/body/root template code
}
```

Names can differ, but the ownership must be this clear.

`rootRenderFunc(...)` should no longer take `compositionMode`,
`parentBuffer`, or `componentMode`. Parent template execution should call the
compiled `executeRootProgram(...)` for the selected root directly.

### Runtime State Additions

Add a nested render-plan object to `InheritanceState`:

```js
{
  renderPlan: {
    entryRoot: Template | Script,
    constructorRoots: Template[],
    structuralRoot: Template | null,
    selectedPayload: object | null,
    hasParent: boolean
  }
}
```

This plan is produced during chain loading. It is not execution metadata like
`methods`; it is the answer to "which root program should execute after
finalization?"

Do not merge this with the existing top-level `compositionPayload` state field.
That field belongs to component/extends input payload handling. The render plan
answers structural selection only.

For templates, `constructorRoots` is the selected child-to-parent constructor
chain. In `child -> mid -> root`, constructors run child, then mid, then root
because template constructors have implicit parent continuation at the end.

`structuralRoot` means the topmost selected template whose inline block
placements own document structure. In `child -> mid -> root`, `structuralRoot`
is `root`. If the entry has no selected parent (`extends none`, dynamic null,
or standalone), `structuralRoot` is `null` and the entry root program executes
both constructor code and local inline block placement.

Store payload data, not a pre-forked `Context`. The selected-root context
should be forked at execution time so it observes finalized state through normal
buffers/channels.

### Metadata Loading

Metadata loading should be a runtime helper with a narrow contract:

```js
await loadInheritanceChain({
  root,
  context,
  env,
  runtime,
  inheritanceState,
  origin
});
```

Responsibilities:

- compile each selected root
- register `root.inheritanceSpec`
- call each root's compiled `loadInheritanceChain(...)` function to resolve
  its own `extends` expression
- detect cycles
- store the selected constructor chain, structural root, and payload data
- stop on `extends none` / `null`

Non-responsibilities:

- no setup execution
- no constructor execution
- no template text rendering
- no command-buffer child insertion
- no method invocation

The helper is async and returns the finalized render-plan data, but it does not
finalize metadata. It must not silently reopen a finalized state.

Standalone roots still use the same loader: register the entry spec, set
`hasParent = false`, leave `structuralRoot = null`, and use only the entry
constructor/root program.

### Finalization

`finalizeInheritanceMetadata(...)` remains the only metadata finalization point.

It should run after loading and before root program execution. Normal dispatch
should never trigger first-time finalization.

Allowed finalization work:

- merge shared schema
- build override chains
- wire owner-relative `super`
- validate signatures
- validate invoked references
- compute fixed-point channel footprints
- publish `state.methods` and `state.sharedSchema`

### Root Program Execution

Root program execution runs after finalization.

For scripts:

- shared declarations run first
- the finalized `__constructor__`/body is invoked when present
- `super()` is explicit
- if the entry has no local constructor body, dispatch naturally selects the
  nearest ancestor constructor
- the entry script body owns the return value; ancestor constructor return
  values are ignored

For templates:

- root-level template code is the constructor/program
- it may render text, run loops/conditions/includes, read or mutate shared
  channels, and place blocks
- blocks remain inherited callable methods
- every template in the selected chain can run constructor/program code
- constructor/program execution continues to the parent at the end
- only the topmost structural root performs callable inline block placement
- template constructor/program code does not support `super()`

`runCompiledRootStartup(...)` should disappear or be renamed, because the phase
is not just startup. Its current `options` object is residual coupling:

- `resolveExports` belongs to root orchestration after root program setup.
- `componentMode` and `compositionMode` should disappear with the old root
  signature.

If the helper remains as a root-program helper, its signature should not mention
component or composition modes.

### Template Constructor And Structure Execution

Template execution has two related parts:

- run constructor/program code for every template in the selected chain
- then run inline block placement only from the structural root

If the chain has a parent, local inline block placement in child templates is
suppressed. If `extends none`, dynamic parent resolves to null, or there is no
extends, the entry root program performs both constructor work and local inline
block placement.

Inline block placement rules:

- placement invokes `invokeInheritedCallable(...)`
- overrides are already finalized
- named binding validation has already happened
- no per-block `parentReady` promise is needed

The root program function should receive the render plan explicitly:

```js
executeRootProgram(env, context, runtime, cb, output, inheritanceState, renderPlan)
```

The entry root orchestrator chooses whether to call the selected
template constructor chain and then the structural root placement path, or the
entry root's local fallback path.

Named binding expressions in extending templates with a selected parent must
not be evaluated. With a precomputed render plan, this is achieved by never
executing child inline block placement when `hasParent` is true.

### Components

Components use the same lifecycle with a component-owned root buffer.

Rules:

- component root buffer opens at component creation
- metadata loads and finalizes before startup
- startup/constructor runs before method calls are available
- component root buffer stays open until the owner binding channel finalizes or
  `close()` is called
- component method calls use normal invocation admission against the finalized
  table

Components must not require linking into a finished root buffer. If they do,
the component lifetime is wrong.

Constructor `super()` behavior is unchanged by the lifecycle split:

- constructors are finalized entries named `__constructor__`
- owner-relative `super` links are wired by finalization
- the topmost missing constructor is represented by the existing no-op
  constructor entry
- repeated bare constructor `super()` calls still share the lifted result

## Audit Findings Folded Into This Refactor

This section records the current-code issues discovered during the audit that
belong to the lifecycle refactor. They are not separate cleanup chores; they
are symptoms of the same mixed load/finalize/execute lifecycle and should be
removed as part of the clean implementation.

### Generated Root Signature Is Overloaded

`src/compiler/emit.js` still emits root functions with:

```js
root(env, context, runtime, cb, compositionMode = false, parentBuffer = null, inheritanceState = null, componentMode = false)
```

That signature encodes the old idea that the same root function can be used as
a public render entry, a parent metadata loader, a composition renderer, and a
component startup entry. The refactor should remove those mode booleans from
compiled roots. Separate compiled entry points should express the real phase:

- load/resolve metadata
- execute constructor/root program
- execute selected template structure when needed

The constructor helper signatures show the same confusion at a smaller scale.
Template `b___constructor__` is currently compiled like a setup helper:

```js
(env, context, runtime, cb, output, inheritanceState, extendsState)
```

Script `b___constructor__` is compiled like an inherited callable entry:

```js
(env, context, runtime, cb, output, blockPayload, blockRenderCtx, inheritanceState, methodData)
```

That divergence exists only because template root code is still treated as
setup while script constructor code needs callable metadata for `super()`. Once
both scripts and templates use explicit root-program execution, constructors
should have one clear entry shape for the phase they actually run in.

### Script Body Parameter Threading Is A Constructor Workaround

`b___scriptBody__` now threads `blockPayload`, `blockRenderCtx`, and
`methodData` from the constructor into the script body. This was necessary in
the staged implementation so constructor `super()` could work while the
constructor and body were split across helper functions.

In the target lifecycle, the script root program should receive only the values
it truly needs from the root orchestrator. Constructor callable metadata should
not bleed through an unrelated script-body helper just to preserve `super()`
context.

### Startup Promise Is A Lifecycle Side Channel

`runCompiledRootStartup(...)`, `ROOT_STARTUP_PROMISE_VAR`, and
`setInheritanceStartupPromise(...)` currently coordinate work between parent
root execution, component creation, and final render completion. This is a side
channel created by the phase mixing.

The target orchestration should await the phases directly. If a promise is
needed, it should be a local implementation detail of root-program execution,
not an externally visible inheritance-state field used to detect whether a
parent root happened to schedule startup work.

The current implementation can set the field twice: `runCompiledRootStartup(...)`
stores the raw setup promise, then `_emitAsyncCompositionRootCompletion(...)`
can immediately replace it with a chained promise that also finishes the buffer.
That creates a short window where observers can see the wrong promise. The clean
model should remove the observable state rather than make the double-set safer.

### Shared Root Finishing Is Owned In Generated Code

`src/compiler/inheritance.js` emits direct shared-root finishing checks such as:

```js
if (inheritanceState && inheritanceState.sharedRootBuffer && inheritanceState.sharedRootBuffer !== output) {
  inheritanceState.sharedRootBuffer.finish();
  await inheritanceState.sharedRootBuffer.getFinishedPromise();
}
```

This is a buffer-lifetime workaround. Buffer lifetime should be owned by the
root/component lifecycle:

- direct render: the root buffer closes after root program and selected
  structure execution finish
- component: the component root buffer closes when the component binding
  lifetime ends or `close()` is called
- parent metadata loading: no command buffer should be created or finished

Generated template/script bodies should not contain ad hoc shared-root close
logic.

One especially fragile instance is `emitScriptRootLeafResult(...)`, where
shared-root finishing appears next to constructor invocation and final return
snapshot handling. This logic belongs in root orchestration; leaving it inside
leaf-result emission makes it too easy for script return semantics and shared
buffer lifetime to drift apart.

### Parent/Shared Linking Is Still Used As A Phase Bridge

`linkCurrentBufferToParentChannels(...)` and setup-time whole-schema
`linkCurrentBufferToSharedChannels(...)` exist because current execution can run
before the final call footprint is available at the real execution boundary.
The latter is emitted from script setup using `Object.keys(sharedSchema)` for
both linked and mutated channels.

The refactor should make this unnecessary:

- constructor/root programs run only after finalization
- callable invocation links exact `mergedLinkedChannels` and
  `mergedMutatedChannels`
- root-program shared access links from the finalized render plan/state at the
  actual current buffer
- no broad whole-schema setup link should remain unless a final root-program
  admission primitive explicitly owns it

### Dynamic Extends Tests Assert The Temporary Plumbing

`tests/pasync/extends-foundation.js` still has active generated-source
assertions requiring `extendsState.parentReady` and `extendsState.hasParent`.
The skipped legacy section also references `extendsState.parentSelection`.

These tests should be rewritten around the target behavior:

- dynamic parent expression resolves once before root-program execution
- generated block placement contains no parent-decision promise wrapper
- named binding expressions in child placement are not evaluated when a parent
  is selected
- dynamic `extends none` selects the local fallback plan before execution

Generated-source tests should assert the loader/render-plan shape, not the
current `extendsState` plumbing.

### Precompiled Fixture Still Contains Old Generated Shape

`tests/browser/precompiled-templates.js` contains generated code with
`extendsState.parentSelection` and `renderInheritanceParentRoot(...)`. This
fixture is a likely stale precompiled artifact. The lifecycle refactor should
regenerate or remove fixtures that bake in the old root signature and parent
rendering helpers.

### Current Technical Design Still Describes Local Template Startup

`TECHNICAL-DESIGN.md` currently says template code outside blocks is local
startup only and that template constructor code does not support `super()`.
That wording does not fully capture the updated target model:

- every selected template has a constructor/root program
- template constructor/root programs continue to the parent implicitly at the
  end
- only the structural root performs callable inline block placement

When the refactor lands, update `TECHNICAL-DESIGN.md` to match this document so
future reviews do not validate against an older lifecycle.

### Component Creation Still Calls `rootRenderFunc(...)`

`createComponentInstance(...)` currently compiles the target and calls
`template.rootRenderFunc(...)` with `compositionMode = true` and
`componentMode = true`. This inherits the overloaded root signature and the
startup-promise side channel.

Components should call the same metadata loader/finalizer/root-program executor
as direct renders, but with a component-owned root buffer and lifetime policy.
No component path should need a special root-render mode.

### Invocation Admission Is Adjacent, Not Automatically Included

The direct `method.fn(...)` call in `invokeMethod(...)` is still listed as a
temporary. It is not required to land the lifecycle refactor, but the lifecycle
split will clarify buffer ownership enough that replacing it with invocation
commands may become straightforward. If it is not done in the lifecycle work,
keep it explicitly listed as the remaining temporary and add tests proving the
new lifecycle does not depend on direct-call timing.

### Callable Signature Recalculation Is Broader Than One Helper

The current compiler can recompute and revalidate a block signature several
times: analysis, callable-entry emission, argument initialization, metadata
collection, and placement compilation. This is not only the redundant
`emitAsyncCallableArgInitialization(...)` call listed below; the whole
signature path should move toward one analyzed/cached signature per callable.

The lifecycle split is the right moment to do this because placement, callable
entry generation, and metadata loading will have clearer phase boundaries.

## Implementation Plan

### 1. Introduce Metadata-Only Chain Loading

Add runtime helpers in `load.js` or a new `chain.js`:

- `loadInheritanceChain(...)`
- `loadParentInheritanceSpec(...)`
- cycle enter/leave helpers currently in `startup.js`

Move cycle tracking out of parent rendering and into metadata loading.

`loadInheritanceChain(...)` should compile parent roots and call
`bootstrapInheritanceMetadata(state, parent.inheritanceSpec, parentContext)`.

The compiled root's own loader should have a concrete signature:

```js
async function loadInheritanceChain(env, context, runtime, inheritanceState, origin)
```

It evaluates only the local `extends` expression and returns:

```js
{
  parentRoot: Template | Script | null,
  compositionPayload: object | null
}
```

The runtime helper owns recursion and render-plan construction. This keeps
multi-level structural-root selection in one place.

### 2. Split Compiler Root Entries

Refactor async compiler output so root compilation emits separate functions:

- metadata loader / extends resolver
- root program function

Do this as a sequence of green commits:

1. split templates first while scripts keep the current path
2. split scripts once template lifecycle is stable
3. remove shared orchestration helpers only after both paths use the new shape

Templates should go first because root program execution and metadata loading
are currently most entangled there.

Do not keep suppression conditionals inside general output compilation as the
long-term model. Once the root program has its own function, output belongs
there.

### 3. Root Entry Orchestration

Generated `root(...)` should become the orchestration layer:

1. create/reuse inheritance state
2. load metadata chain
3. finalize metadata
4. execute the selected constructor chain/root program
5. finish buffers

This orchestration should be visible and linear in generated source.

Target shape:

```js
async function root(env, context, runtime, cb) {
  const output = new runtime.CommandBuffer(context, null);
  let inheritanceState = runtime.createInheritanceState();
  await runtime.loadInheritanceChain({ root: self, context, env, runtime, inheritanceState, origin });
  runtime.finalizeInheritanceMetadata(inheritanceState, context);
  await runtime.executeTemplateRootProgram({
    entryProgram: executeRootProgram,
    renderPlan: inheritanceState.renderPlan,
    env,
    context,
    runtime,
    cb,
    output,
    inheritanceState
  });
  context.resolveExports();
  output.finish();
  cb(null, await output.getChannel("__text__").finalSnapshot());
}
```

`executeTemplateRootProgram(...)` owns the template-specific multi-level
program order. For an inherited chain it should iterate
`renderPlan.constructorRoots` child-to-parent and execute constructor/program
code without local inline block placement for child/mid templates, then execute
`renderPlan.structuralRoot` with structural inline block placement enabled. For
`extends none`, dynamic null, or standalone templates, `constructorRoots`
contains only the entry and `structuralRoot` is `null`, so the entry program
executes its local inline block placement itself.

The real generated code can preserve sync-first patterns where useful, but the
control flow should remain this linear.

### 4. Remove Parent-Render Loading Helpers

Delete or replace:

- `renderInheritanceParentRoot(...)`
- `bootstrapInheritanceParentScript(...)`
- `renderParentRoot(...)` as a loading helper

`renderParentRoot(...)` is already the consolidated implementation behind the
two thin wrappers. Keep that consolidation idea, but replace the helper with
`executeTemplateRootProgram(...)` as a pure execution helper. The new helper
may call compiled constructor/root-program functions; it must not call
`rootRenderFunc(...)` for metadata loading and must not register metadata as a
side effect.

If a helper remains for selected-chain execution, name it accordingly, for
example `executeTemplateRootProgram(...)`.

### 5. Remove Dynamic Parent Promise Plumbing

Delete:

- `extendsState.parentSelection`
- `extendsState.parentReady`
- `extendsState.hasParent`
- `_emitResolveDynamicParentReady(...)`
- `_emitRejectDynamicParentReady(...)`
- per-block `parentReady.then(...)` wrappers
- `topLevelDynamicExtends`

Replace with a render-plan value computed during metadata loading.

### 6. Remove Startup Output Suppression Workarounds

Delete or simplify:

- `_isExtendingTemplateStartupOutput(...)`
- dynamic startup-output wrapping in `compileOutput(...)`
- static-extending top-level block suppression in `compileAsyncBlock(...)`
- conditionals that suppress child wrapper text from setup
- root-program-time whole-schema `linkCurrentBufferToSharedChannels(...)` calls that only existed
  because root program execution could run before finalization

Text output should compile into the root program function.

### 7. Keep Component Lifetime Explicit

Keep and strengthen:

- `registerCloseOnOwnerComplete(...)`
- explicit `ComponentInstance.close()`
- operation rejection after close

Add tests proving method calls never need finished-root late linking:

- constructor writes shared value
- owner waits before method call
- method still writes/reads shared value while component root is open
- root closes only after owner binding finalizes

### 8. Tests To Add Or Rewrite

Add tests that directly lock the desired lifecycle:

- Parent metadata loads before any parent startup code runs.
- Finalization errors appear before root program side effects.
- Parent constructor does not run unless invoked by the finalized constructor
  chain.
- Template root code outside blocks runs only for the selected root program.
- Dynamic `extends none` resolves before block placement without per-block
  promise checks in generated source.
- Component method calls after startup use an open component root buffer.
- `loadInheritanceChain(...)` can be tested without creating command buffers.
- All methods in the super chain, not just the most-derived entries, still have
  invoked refs validated and footprints merged.
- Component startup errors from constructor execution still set
  `startupError`, close the component buffer, and call `cb`.
- Named binding expressions in extending templates with a selected parent are
  not evaluated.

Remove tests that assert:

- finished-parent late linking
- `parentReady` generated-source plumbing
- parent-root execution as loading
- old inheritance-legacy readiness barriers

Specific suites to revisit:

- `tests/pasync/inheritance.js`: keep behavioral inheritance/component coverage;
  add lifecycle-order assertions.
- `tests/pasync/extends-template.js`: rewrite generated behavior expectations
  around constructor-chain execution and structural-root placement.
- `tests/pasync/extends-foundation.js`: remove remaining legacy readiness and
  helper-lifecycle pending groups once the new loader has direct tests.
- `tests/pasync/template-command-buffer.js`: update generated-source assertions
  from `compositionMode`/`parentReady` to loader/constructor/structural
  placement functions.
- `tests/pasync/snapshots.js`: keep structural buffer invariants; do not
  reintroduce finished-parent late-link expectations.

## Residual Code To Remove

Once the lifecycle split lands, remove:

- `renderInheritanceParentRoot(...)`
- `bootstrapInheritanceParentScript(...)`
- `renderParentRoot(...)`
- `extendsState` and all `parentReady`/`hasParent` generated code
- `extendsState.parentSelection` dead assignments
- `topLevelDynamicExtends`
- `_emitTemplateExtendsBoundaryFromSelection(...)` as currently structured
- startup-output suppression branches in `compileOutput(...)`
- `_isExtendingTemplateStartupOutput(...)`
- static-extending top-level block suppression in `compileAsyncBlock(...)`
- setup-time whole-schema shared linking
- repeated `getCallableSignature(...)` parsing/revalidation across analysis,
  callable-entry emission, argument initialization, metadata collection, and
  placement compilation
- `validateInvokedMethodRefs(...)` / `mergeMethodFootprints(...)` parameter
  names that call the all-method-entry array `methods`
- comments that describe parent rendering as chain loading
- skipped tests that target legacy metadata readiness and helper lifecycle

Keep:

- `bootstrapInheritanceMetadata(...)` as append-only spec registration
- `finalizeInheritanceMetadata(...)` as the single finalization point
- `runCompiledRootStartup(...)` only if it is renamed/reworked into a true
  constructor-chain/root-program execution helper
- component binding lifetime close behavior
- direct `invokeMethod(...)` only if invocation-command admission remains out of
  scope for this refactor

Invocation commands are related but not required for the lifecycle split. If
the refactor reaches invocation ownership naturally, replace the temporary
direct `method.fn(...)` call then. Otherwise keep it explicitly listed as a
remaining temporary.

## Acceptance Criteria

The refactor is complete when:

- no parent `rootRenderFunc(...)` is called during metadata loading
- metadata loading can be tested without creating command buffers
- `state.finalized` is true before any root program function runs
- dynamic extends resolves once before root program execution
- block placement contains no parent-decision promise wrapper
- component method calls do not require finished-root linking
- standalone roots use the same lifecycle with `renderPlan.hasParent = false`
- generated root signatures no longer use `compositionMode`, `parentBuffer`, or
  `componentMode`
- real source origins replace `createStubSourceOrigin(...)`
- constructor `super()` no-op behavior remains intact
- all-method-entry validation and footprint merging remain intact
- component startup error handling remains intact
- quick tests pass
- generated source is easier to read: load, finalize, execute root program, finish appear as
  separate, linear steps
