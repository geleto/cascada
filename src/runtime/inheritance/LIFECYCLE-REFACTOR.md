# Inheritance Lifecycle Refactor Plan

> Historical planning note: this document records the lifecycle problems and
> refactor analysis that led to `TECHNICAL-DESIGN-2.md`. For a clean
> implementation, treat `TECHNICAL-DESIGN-2.md` as authoritative. Do not follow
> this file as an instruction to preserve or adapt the existing inheritance
> runtime.

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

## Refactor Vs Restart Decision Gate

The default path is to refactor from the current inheritance branch. This keeps
the working feature coverage, regression tests, compiler analysis, metadata
shape, shared-state work, `super()` behavior, and component coverage that were
already built during the staged implementation.

Proceed with the refactor while all of these remain true:

- each step deletes or isolates more old lifecycle code than it preserves
- parent metadata loading no longer calls parent `rootRenderFunc(...)`
- new helpers express the target lifecycle directly rather than wrapping the
  old lifecycle behind new names
- root function modes (`compositionMode`, `componentMode`, `parentBuffer`) are
  shrinking toward deletion, not spreading to new call sites
- `startupPromise` is shrinking toward local execution plumbing or deletion,
  not becoming the primary lifecycle coordinator again
- tests are rewritten to assert target behavior, not old generated-source
  scaffolding
- component support follows the same load/finalize/root-program path rather
  than requiring special root-render modes

Stop the refactor and restart from `master` with this document as the TDD if
any of these become true after Step 1 or Step 2:

- old `rootRenderFunc(..., compositionMode, parentBuffer, inheritanceState,
  componentMode)` remains necessary for normal parent loading or component
  startup
- parent root execution is still the mechanism that discovers parent metadata
- `extendsState`, `parentReady`, or equivalent per-block parent-decision
  promises survive as normal block-placement control flow
- `runCompiledRootStartup(...)` / `startupPromise` remains the cross-phase
  coordination mechanism between load, finalize, constructor, and structure
  rendering
- generated setup/root code still mixes metadata loading, shared declarations,
  root program execution, and structural template rendering in one helper
- finished-buffer late linking or broad setup-time shared linking is still
  required for correctness
- compatibility adapters for the old root modes survive beyond an intermediate
  green commit
- the implementation becomes harder to explain than the target lifecycle shown
  in this document

If the restart gate trips, do not attempt a smaller patch. Create a new branch
from `master`, copy this document in as the implementation TDD, and port only
the useful tests and isolated helper code that conform to the target lifecycle.

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
- Parent loading should propagate real source origins from the `extends` node;
  the former `createStubSourceOrigin(...)` temporary should not return.

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
  resolveInheritanceParent, // local extends resolver
  executeRootProgram    // constructor/body/root template code
}
```

Names can differ, but the ownership must be this clear.
The compiled functions must be assigned to stable properties on the compiled
root object so runtime helpers can call them without depending on generated
local variable names.

`rootRenderFunc(...)` should no longer take `compositionMode`,
`parentBuffer`, or `componentMode`. Parent template execution should call the
compiled `executeRootProgram(...)` for the selected root directly.

`inheritanceSpec.setup` is removed by this split. Root-program execution owns
what `setup` used to mix together; metadata registration should read
`inheritanceSpec` only.

### Runtime State Additions

Add a nested render-plan object to `InheritanceState`:

```js
{
  renderPlan: {
    chain: RenderPlanEntry[],
    structuralEntry: RenderPlanEntry | null,
    hasParent: boolean
  }
}

type RenderPlanEntry = {
  root: Template | Script,
  path: string | null,
  compositionPayload: object | null,
  origin: SourceOrigin | null
}
```

This plan is produced during chain loading. It is not execution metadata like
`methods`; it is the answer to "which root program should execute after
finalization?"

There is no separate `entryRoot` field: the entry root is always
`renderPlan.chain[0].root`. Keeping only one representation avoids drift.

Do not merge this with the existing top-level `compositionPayload` state field.
That field belongs to component/extends input payload handling. The render plan
answers structural selection only.

For templates, `chain` is the selected child-to-parent execution chain. In
`child -> mid -> root`, `chain` is `[childEntry, midEntry, rootEntry]`.
Each entry stores the composition payload and source origin selected by the
`extends` hop that leads to that root. This per-hop payload is required because
every level can have its own `extends ... with ...` expression. The entry stores
payload data, not a pre-forked `Context`; execution forks the context for each
entry when that entry's root program runs.

`structuralEntry` means the topmost selected template whose inline block
placements own document structure. In `child -> mid -> root`, `structuralEntry`
is the `rootEntry` already present in `chain`. It must not be executed twice:
template execution runs each chain entry exactly once. Entries before
`structuralEntry` run with local inline block placement disabled; the
`structuralEntry` runs with inline block placement enabled.

If the entry has no selected parent (`extends none`, dynamic null, or
standalone), `structuralEntry` is `null` and the single entry root program
executes both constructor code and local inline block placement.

Scripts also use the render plan for selected-chain metadata and payload
recording, but script constructor continuation is explicit: `super()` follows
finalized owner-relative constructor links. The root orchestrator must not
blindly iterate script constructors the way template execution iterates template
root programs.

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
- register each selected root's `inheritanceSpec`
- call each root's compiled local parent resolver function to resolve
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
`hasParent = false`, leave `structuralEntry = null`, and use only the entry
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

After footprint merging, finalization should prune bootstrap-only fields from
long-lived execution entries. `callsSuper` and `invokedMethodRefs` are needed to
compute the fixed point, but they should not survive on the execution
`RuntimeMethodEntry` shape. The execution shape should retain only fields used
after finalization, such as:

- `name`
- `fn`
- `signature`
- `ownerKey`
- `origin`
- `isConstructor`
- `super`
- `mergedLinkedChannels`
- `mergedMutatedChannels`

Finalization should also move toward collecting independent recoverable
structural metadata errors before throwing. This applies to catalog wiring,
`super()` resolution, invoked-callable validation, signature compatibility, and
footprint validation. If full aggregation is not implemented in the lifecycle
slice, it must stay tracked as an explicit post-refactor audit item rather than
being forgotten.

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

Each template root program executes at most once per render. The inline block
placement mode is a parameter of that execution, not a reason to call the same
root program twice.

`runCompiledRootStartup(...)` should disappear or be renamed, because the phase
is not just startup. Its current `options` object is residual coupling:

- `resolveExports` belongs to root orchestration after root program setup.
- `componentMode` and `compositionMode` should disappear with the old root
  signature.

If the helper remains as a root-program helper, its signature should not mention
component or composition modes.

### Template Constructor And Structure Execution

Template execution has two related parts:

- run constructor/program code for every template in the selected chain exactly
  once
- enable inline block placement only for the structural entry

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

The template root-program helper should receive an execution-mode flag such as:

```js
executeRootProgram(env, context, runtime, cb, output, inheritanceState, renderPlan, {
  placeInlineBlocks: boolean
})
```

For `child -> mid -> root`, execution is:

1. execute child with `placeInlineBlocks: false`
2. execute mid with `placeInlineBlocks: false`
3. execute root with `placeInlineBlocks: true`

For standalone / `extends none` / dynamic null, execution is:

1. execute entry with `placeInlineBlocks: true`

Algorithmically:

```js
for (const entry of renderPlan.chain) {
  const placeInlineBlocks = renderPlan.structuralEntry === null
    ? entry === renderPlan.chain[0]
    : entry === renderPlan.structuralEntry;
  await entry.root.executeRootProgram(..., { placeInlineBlocks });
}
```

Each entry should execute with a context forked from the previous hop using that
entry's `compositionPayload`:

```js
const entryContext = entry.compositionPayload
  ? previousContext.forkForCompositionPayload(
    entry.path,
    entry.compositionPayload,
    previousContext.getRenderContextVariables()
  )
  : previousContext.forkForPath(entry.path);
```

The exact helper can be adjusted to the existing `Context` API, but the
important invariant is that the context is forked at execution time, not stored
pre-forked in the render plan.

Block placement inside `executeRootProgram` should compile to one simple mode
check, not parent-selection logic:

```js
if (executionOptions.placeInlineBlocks) {
  const value = runtime.invokeInheritedCallable(
    inheritanceState,
    "content",
    runtime.createArray([...]),
    context,
    env,
    runtime,
    cb,
    output,
    errorContext
  );
  output.addCommand(new runtime.TextCommand(value), "__text__");
}
```

The exact emitted command form should follow the existing text-output emitter,
but the shape must remain a local `placeInlineBlocks` check. It must not call
parent loaders, inspect `extendsState`, or wait on parent-decision promises.

Named binding expressions in extending templates with a selected parent must
not be evaluated. With a precomputed render plan, this is achieved by never
executing child inline block placement when `placeInlineBlocks` is false.

Script root target shape:

```js
async function root(env, context, runtime, cb) {
  const output = new runtime.CommandBuffer(context, null);
  const inheritanceState = runtime.createInheritanceState();
  await runtime.loadInheritanceChain({ root: self, context, env, runtime, inheritanceState, origin });
  runtime.finalizeInheritanceMetadata(inheritanceState, context);
  const result = await runtime.executeScriptRootProgram({
    entry: inheritanceState.renderPlan.chain[0],
    env,
    context,
    runtime,
    cb,
    output,
    inheritanceState
  });
  output.finish();
  cb(null, runtime.normalizeFinalPromise(result));
}
```

Script root execution must not iterate constructors child-to-parent. It invokes
the finalized entry constructor/body and lets explicit `super()` drive ancestor
constructor execution.

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
- script components and template components both use the same
  load/finalize/root-program path; they differ only in how their selected root
  program executes after finalization

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

Do not confuse this with entry-local invocation-buffer wiring. Per-invocation
parent channel linking from a callable's local buffer to its immediate
invocation buffer remains valid unless/until invocation commands replace that
mechanism. What goes away is lifecycle-phase bridging and broad setup-time
shared linking.

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

When the clean implementation lands, update or supersede `TECHNICAL-DESIGN.md`
so future reviews do not validate against an older lifecycle.

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
- an internal selected-root loader
- cycle enter/leave helpers currently in `startup.js`

Move cycle tracking out of parent rendering and into metadata loading.

Runtime `loadInheritanceChain(...)` owns all spec registration. It compiles each
selected root and calls
`bootstrapInheritanceMetadata(state, selectedRoot.inheritanceSpec, origin)`.
Compiled roots do not mutate `state.loading.files` directly.

The compiled root's own local parent resolver should have a concrete signature:

```js
async function resolveInheritanceParent(env, context, runtime, inheritanceState, origin)
```

It evaluates only the local `extends` expression and returns:

```js
{
  parentRoot: Template | Script | null,
  compositionPayload: object | null,
  origin: SourceOrigin | null
}
```

The runtime helper owns recursion and render-plan construction. This keeps
multi-level structural-root selection in one place.

#### Step 1 Execution Contract

The first implementation slice should be metadata-only and should not preserve
old parent-render behavior behind a new helper name.

Compiled local parent-resolver signature:

```js
async function resolveInheritanceParent(env, context, runtime, inheritanceState, origin)
```

Local parent-resolver responsibilities:

- evaluate the current root's `extends` expression, if present
- return only the immediate parent selection:

```js
{
  parentRoot: Template | Script | null,
  compositionPayload: object | null,
  origin: SourceOrigin | null
}
```

Local parent-resolver non-responsibilities:

- no spec registration
- no render-plan mutation
- no recursion
- no finalization

Runtime chain-loader signature:

```js
await runtime.loadInheritanceChain({
  root,
  context,
  env,
  runtime,
  inheritanceState,
  origin
});
```

Runtime chain-loader responsibilities:

- register each selected root's `inheritanceSpec`
- call the compiled local parent resolver for each selected root
- compile parent roots before reading their loader/spec
- recurse until no parent is selected
- detect cycles using source paths before recursing into an already-seen root
- append loaded specs child-to-parent
- build `inheritanceState.renderPlan`
- leave `inheritanceState.finalized === false`
- not run setup, constructors, methods, blocks, script returns, or template text

`renderPlan` after Step 1 must contain enough information for later steps:

```js
{
  chain,             // child -> parent RenderPlanEntry values
  structuralEntry,   // topmost selected template entry, or null for local fallback
  hasParent
}
```

For `child -> mid -> root`, `chain` is `[childEntry, midEntry, rootEntry]` and
`structuralEntry` is `rootEntry`. For standalone roots, `extends none`, or
dynamic null, `chain` contains the entry root, `structuralEntry` is `null`, and
`hasParent` is `false`.

Forbidden in Step 1:

- calling any parent `rootRenderFunc(...)`
- calling `renderParentRoot(...)`
- calling `renderInheritanceParentRoot(...)`
- calling `bootstrapInheritanceParentScript(...)`
- calling `runCompiledRootStartup(...)`
- creating a `CommandBuffer`
- finishing a buffer
- linking parent/shared channels
- setting or reading `startupPromise`
- emitting or depending on `extendsState.parentReady`

Dynamic extends constraint for Step 1:

- dynamic parent expressions may read render context, composition payload, and
  globals available before root-program execution
- they must not depend on root-program-created channels or source-ordered
  command-buffer state
- the loader expression compiler must enforce this by rejecting channel reads,
  locally declared variables/channels, and other current-buffer-dependent
  expressions inside `extends` targets or `extends ... with ...` payloads
- unsupported channel-dependent dynamic extends should fail clearly rather than
  silently falling back to old root-render loading

Minimum Step 1 tests:

- loading a static three-level chain registers specs child-to-parent without
  running parent root code
- static cycle detection fails during loading
- `extends none` produces a local-fallback render plan
- dynamic null produces a local-fallback render plan
- dynamic parent selection is evaluated once during loading
- metadata loading can be unit-tested without constructing a `CommandBuffer`

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

No compatibility adapter for the old root function modes should survive this
refactor. Temporary bridges may exist only inside an intermediate green commit;
the final code must not retain `compositionMode`, `componentMode`,
`parentBuffer` root dispatch, parent-render-as-loader wrappers, or aliases that
preserve those modes under new names.

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
program order. For an inherited chain it should iterate `renderPlan.chain`
child-to-parent and execute each template root program exactly once. Entries
before `renderPlan.structuralEntry` execute with local inline block placement
disabled; `renderPlan.structuralEntry` executes with local inline block
placement enabled. For `extends none`, dynamic null, or standalone templates,
`renderPlan.chain` contains only the entry and `structuralEntry` is `null`, so
the entry program executes with local inline block placement enabled.

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
- `inheritanceSpec.setup`
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
- long-lived `RuntimeMethodEntry.callsSuper` and
  `RuntimeMethodEntry.invokedMethodRefs` after footprint merging

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
- real source origins are used during metadata loading
- template constructors from every selected chain entry run in child-to-parent
  order, with inline block placement enabled only for the structural entry
- constructor `super()` no-op behavior remains intact
- all-method-entry validation and footprint merging remain intact
- independent recoverable finalization errors are collected before throwing, or
  the deferral is explicitly tracked outside the lifecycle plan
- execution `RuntimeMethodEntry` objects no longer retain bootstrap-only
  `callsSuper` or `invokedMethodRefs`
- component startup error handling remains intact
- quick tests pass
- generated source is easier to read: load, finalize, execute root program, finish appear as
  separate, linear steps
