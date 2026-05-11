# Inheritance Technical Design 2

## Purpose

This document defines the target async inheritance implementation.

Implementation starts from an empty `src/runtime/inheritance` runtime folder
except for this document. Runtime code is written directly from this design.

The most important rule is that inheritance is a lifecycle, not a collection of
feature slices. The implementation should make the intended lifecycle hard to
violate:

1. load the selected inheritance chain metadata
2. finalize metadata into execution tables
3. execute selected constructors
4. complete buffered output / script result
5. keep component lifetime explicit and independent from render-root lifetime

Correctness is protected by focused tests for phase boundaries and observable
behavior.

The sync compiler uses the Nunjucks inheritance path and is out of scope.

## Non-Negotiable Lifecycle

Each phase has a single owner and a bounded contract.

### Phase 1: Load

Input:

- entry compiled template/script root
- render context
- environment/runtime helpers

Output:

- `LoadedInheritanceChain` in child-to-parent order

Allowed:

- compile selected roots
- evaluate local `extends` selections
- evaluate `extends ... with ...` payloads when a parent is selected
- register raw `inheritanceSpec` objects
- track source paths for cycle detection
- fork contexts for selected parent payloads

Forbidden:

- execute constructors
- call callable methods/blocks
- render text
- create command buffers
- finalize metadata
- set or read startup promises
- discover new runtime methods beyond compiler-emitted metadata

### Phase 2: Finalize

Input:

- `LoadedInheritanceChain`
- render context for diagnostics

Output:

- `InheritanceRuntimeState`
- finalized methods
- finalized shared schema
- pruned execution method entries

Allowed:

- validate duplicate callable declarations
- validate shared/method collisions
- validate missing invoked method refs
- validate `super()` parent availability
- validate signature compatibility
- wire owner-relative `super` links
- compute merged channel footprints
- collect independent recoverable finalization errors

Forbidden:

- call compiled user functions
- evaluate template/script expressions
- render text
- create or finish command buffers
- fork contexts
- discover parent roots

### Phase 2.5: Prepare Instance

This is an orchestration boundary, not a metadata phase. A single helper may
combine load + finalize + buffer ownership setup into a ready-to-execute
inheritance instance.

Input:

- entry compiled template/script root
- render context
- environment/runtime helpers
- output/root buffer owner
- options describing direct render vs component instance ownership

Output:

```js
type PreparedInheritanceInstance = {
  runtimeState: InheritanceRuntimeState,
  rootBuffer: CommandBuffer,
  sharedRootBuffer: CommandBuffer,
  context: Context
}
```

Allowed:

- create the root output buffer for the instance
- create or attach the shared root buffer for the instance
- call the load phase
- call the finalize phase
- return the runtime state, buffers, and entry context needed to execute the
  constructor method

Forbidden:

- execute constructors
- initialize shared defaults
- call inherited methods
- perform component method/observation operations

The prepared instance is the only object constructor execution needs. It is
also the natural unit for component lifetime: component instances keep this
prepared root/shared buffer pair open until explicit close or owner binding
completion.

### Phase 3: Execute Constructor Method

Input:

- `InheritanceRuntimeState`
- root output/shared buffers
- entry render context

Output:

- commands enqueued by the constructor method call
- script return candidate, if the entry script owns one

Allowed:

- invoke the selected entry constructor through the same callable invocation
  machinery used for ordinary inherited methods
- link exactly the channels needed by the constructor callable
- declare and initialize shared channels as constructor code requires
- call `super()` through finalized owner-relative links

The constructor is just the `__constructor__` method. The runtime starts by
invoking the selected entry constructor once. It does not manually iterate the
parent chain to execute constructors. Parent constructor execution happens only
when the constructor body calls `super()`, exactly like any other inherited
method.

Template constructors have an implicit trailing `super()` when they have a
parent. That implicit call is compiled as a normal `super()` call, not
implemented as a separate runtime traversal. Therefore the template constructor
chain still executes child-to-parent, but the traversal belongs to ordinary
callable dispatch.

Forbidden:

- load parent metadata
- mutate loaded-chain metadata
- finalize or re-finalize metadata
- use per-block parent-decision promises
- use root-render mode flags such as `compositionMode`, `componentMode`, or
  `parentBuffer`

### Phase 4: Complete Output / Result

Templates:

- No additional template user code runs in this phase.
- Template structure was already produced by executing constructors in Phase 3.
- This phase finishes the output buffer and materializes the final text result.

Scripts:

- No additional script user code runs in this phase.
- The entry script result was selected during Phase 3 according to the script
  return rules.
- This phase completes the relevant buffers/snapshots and returns that result.

Forbidden:

- rerun constructors
- place inline blocks
- reload parents
- re-finalize
- discover method entries

### Phase 5: Component Lifetime

Component instances use the same load/finalize/constructor lifecycle. Their
root buffer remains open for the component binding lifetime and closes when the
owner binding completes or the instance is explicitly closed.

Forbidden:

- depend on linking new child buffers into already-finished parent buffers
- keep component-specific root-render modes
- use parent render execution as component metadata loading

## Forbidden Actions Matrix

| Phase | May Not |
| --- | --- |
| Load | execute user code, create command buffers, finalize, render |
| Finalize | call user functions, render text, fork contexts, create buffers |
| Prepare instance | execute constructors, initialize shared defaults, place blocks |
| Execute constructor method | discover parents, mutate metadata, finalize |
| Invoke | discover new callables, mutate shared schema, load parents |
| Complete output/result | run user code, rerun constructors, re-finalize, reload parents |
| Component lifetime | require finished-parent late linking |

## Compiled Root Shape

The compiled output shape is the lifecycle contract made concrete. Every async
compiled template/script root exposes stable properties:

```js
{
  root,                     // public render entry
  inheritanceSpec,          // raw compiler metadata; no executable side effects
  resolveInheritanceParent, // local immediate-parent resolver
  executeConstructor        // compiled constructor executor
}
```

`root` is the public render entry and a thin orchestrator over the lifecycle.
It must not accept `compositionMode`, `componentMode`, or `parentBuffer`.

There is no compatibility requirement for old precompiled inheritance
artifacts. The clean implementation defines one compiled ABI, and all generated
inheritance code must use that ABI.

ABI rules:

- use one compiled root object shape for scripts and templates
- expose executable phase functions by name; do not hide phase work inside
  metadata fields
- keep metadata data-only
- avoid mode booleans that change a function from render, to parent loader, to
  component startup, to composition execution
- pass explicit phase inputs; do not pass catch-all state objects just because
  an older helper needed them
- prefer object-shaped runtime helper arguments at public phase boundaries when
  that makes the contract clearer
- generated internal functions may use positional parameters only when the
  ordering is stable and the meaning is documented here
- every generated function must have one lifecycle role
- compiler-private helper names must describe the lifecycle role they serve

`inheritanceSpec` contains only metadata needed by loading/finalization:

```js
type CompiledInheritanceSpec = {
  methodEntries: Record<string, CompiledMethodEntry>,
  sharedSchema: Record<string, SharedSchemaInput>,
  invokedMethodRefs: Record<string, InvokedMethodRef>,
  hasExtends: boolean
}
```

Constructor execution owns all executable file body work; `inheritanceSpec`
contains metadata only. The constructor function is registered as
`__constructor__` in `methodEntries` and is invoked through the same
`RuntimeMethodEntry` path as any other callable.

Compiler/runtime ABI helpers are internal. They may be exported through the
runtime bundle because generated code must call them, but they are not public
user API. Name and document them as compiler-private helpers, and do not let
helper exports define lifecycle phase boundaries.

### Local Parent Resolver

Each compiled root has one local resolver:

```js
async function resolveInheritanceParent(env, context, runtime, origin)
```

It evaluates only the current root's immediate `extends` selection and returns:

```js
{
  parentRoot: Template | Script | null,
  compositionPayload: object | null,
  origin: SourceOrigin | null
}
```

It must not:

- register metadata
- recurse
- mutate runtime state
- finalize
- run constructor code

Dynamic `extends` targets and `extends ... with ...` payload values are
evaluated before constructor execution. Therefore they may read:

- render-context values
- composition-payload values already present in the current context
- globals

They may not read:

- variables created by top-level `{% set %}` / script `var` in the same root
- inferred shared vars from `this.<name>` usage in the current template
- shared channels declared or created by the current script constructor
- command-buffer state
- any source-ordered value that would require constructor execution

The compiler enforces this during analysis. Unsupported expressions fail
clearly instead of falling back to parent-render loading.

Payload values are evaluated only after the parent target resolves to a real
parent. If dynamic `extends` resolves to `none`/`null`, payload expressions are
not evaluated.

Resolver ABI notes:

- the resolver returns data only; it does not mutate runtime state
- the resolver does not receive `InheritanceRuntimeState`
- any expression that would require finalized runtime state is outside the
  resolver's allowed phase contract and must be rejected by analysis
- the resolver must be testable without a `CommandBuffer`

### Constructor Executor

`executeConstructor` is the compiled constructor executor. The name is an ABI
name; semantically, it executes this file's constructor code. It is not a
metadata loader.

```js
executeConstructor(env, context, runtime, cb, output, runtimeState, ownerEntry, options)
```

`options` contains at least:

```js
{
  isStructuralTemplate: boolean
}
```

Component distinctions belong to component lifecycle orchestration, not to
generated constructor modes.

For templates, all root-level template code is constructor code. That includes
text, loops, conditions, includes, shared writes, and inline block declarations.
Whether a block node also places callable output is decided at compile time:
only structural templates place inline blocks.

For scripts, `executeConstructor` is the constructor/body and owns the script
return path.

Constructor ABI notes:

- `executeConstructor` does not discover parents and does not finalize
- `executeConstructor` does not receive root-render mode flags
- `executeConstructor` receives the loaded-chain entry that owns this
  constructor body
- template structural role is compile-time; it is not recomputed from dynamic
  parent selection
- component behavior is outside this function; component orchestration decides
  when and how to call the same constructor executor

## Callable Surface

Template blocks and script methods share the inherited callable model. The
surface is intentionally small.

Removed callable surface:

- no template block `with` or `with context`
- no script method `with context`
- no callable signature mode that compares context access

Rules:

- inherited methods and template blocks read render-context names by default
- callable signatures are only ordered argument names
- template block placement may pass local values positionally:
  `{% block name(user) %}`
- template block placement may pass local values by explicit name:
  `{% block name(user = localUser) %}`
- explicit `this.method(...)`, `this.blockName(...)`, and `super(...)` calls use
  the normal invocation argument rules
- implicit inline block placement is generated only for structural templates
  and evaluates placement arguments only when that inline block is actually
  placed
- named placement bindings affect placement arguments only; the callable
  signature remains the ordered list of declared block argument names
- positional and named placement bindings cannot be mixed in one block

The compiler must reject unsupported syntax early. The runtime must not carry
`withContext`, context-mode, or implicit-placement named-binding metadata.

### `this.<name>` Disambiguation

`this` is the inheritance-instance surface inside scripts/templates that
participate in inheritance.

For scripts, the compiler can classify `this.<name>` from local declarations:

- declared shared channel only: shared access
- local method only:
  - `this.name(...)` is inherited callable dispatch
  - bare `this.name` is a structural error; inherited callables must be called
- both shared channel and callable: structural ambiguity error
- neither shared channel nor callable: structural missing-name error

For templates, static `this.<name>` property access infers shared `var`
participation, while `this.name(...)` is inherited callable dispatch. If the
same name is both shared and callable in the finalized chain, finalization
reports the ambiguity.

Bare names do not probe the inheritance shared schema. Bare names follow the
ordinary ambient lookup path: locals, arguments, composition payload, render
context, and globals.

## Load And Runtime Shapes

```js
type LoadedInheritanceChain = {
  entries: LoadedInheritanceEntry[] // child -> parent
}

type LoadedInheritanceEntry = {
  root: Template | Script,
  spec: CompiledInheritanceSpec,
  path: string | null,
  compositionPayload: object | null,
  origin: SourceOrigin | null
}

type InheritanceRuntimeState = {
  methods: Record<string, RuntimeMethodEntry>,
  sharedSchema: Record<string, string>,
  sharedRootBuffer: CommandBuffer,
  failure: Error | null
}
```

`LoadedInheritanceChain` is temporary. Finalization consumes it and produces
`InheritanceRuntimeState`. Runtime invocation receives only the finalized
runtime state.

## Prepared Instance Helper

The public render path, component creation path, and tests should share one
preparation helper:

```js
prepareInheritanceInstance({
  entryRoot,
  env,
  context,
  runtime,
  output,
  ownerBuffer,
  componentOwner
})
```

The exact option names may change, but the helper's contract must not:

1. create or select the root output buffer
2. create the shared root buffer for this inheritance instance
3. load the selected chain metadata from `entryRoot`
4. finalize metadata into `InheritanceRuntimeState`
5. return a `PreparedInheritanceInstance`

It must not execute constructors. Constructor execution is a separate helper
that consumes the prepared instance:

```js
executeInheritanceConstructor(preparedInstance)
```

Direct template/script rendering calls both helpers, then completes the final
output/result. `executeInheritanceConstructor(...)` invokes the selected entry
`__constructor__` method once through normal inherited callable dispatch.
Component creation calls the preparation helper, schedules that constructor
method call in component command order, and keeps the prepared buffers open for
the component lifetime.

The loaded chain is the source of truth during loading/finalization. Do not
store derived aliases for the entry root, parent-exists boolean, or template
structure owner. If execution needs one of those facts, finalization must
compile it into the relevant runtime method entry.

- entry root: `loadedChain.entries[0].root`
- selected parent exists: `loadedChain.entries.length > 1`
- template structure owner, for template chains: the topmost selected template,
  `loadedChain.entries[loadedChain.entries.length - 1]`

`compositionPayload` on `LoadedInheritanceEntry` is the payload selected by the
child hop that leads to that entry. Store payload data, not pre-forked contexts.
Execution forks a context for each entry when that entry runs.

## Composition Payload

Composition payload is the explicit caller-input mechanism for inheritance,
components, imports, includes, and related composition boundaries. It is not
shared state.

Rules:

- payload is plain context-like key/value data
- arbitrary payload keys are allowed; there is no payload schema
- `extends ... with ...` captures payload at the parent-selection site
- payload values do not write to shared channels automatically
- shared defaults or constructor code may read payload values by bare name
- normal bare-name lookup may consult composition payload alongside render
  context and globals
- for multi-level inheritance, each selected hop stores the payload chosen for
  that parent entry
- execution forks a fresh context for each entry using that entry's payload

This keeps payload transport separate from hierarchy-owned `this.<shared>`
state. A payload key and a shared name may be the same string without becoming
the same storage location.

## Method Entry Shapes

Bootstrap/finalization metadata and execution metadata are distinct.

```js
type CompiledMethodEntry = {
  name: string,
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string,
  origin: SourceOrigin | null,
  isConstructor: boolean,
  super: boolean,
  superOrigin: SourceOrigin | null,
  invokedMethodRefs: Record<string, InvokedMethodRef>,
  ownLinkedChannels: string[],
  ownMutatedChannels: string[]
}
```

After finalization, runtime invocation should see a pruned execution entry:

```js
type RuntimeMethodEntry = {
  name: string,
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string,
  origin: SourceOrigin | null,
  isConstructor: boolean,
  ownerEntry: LoadedInheritanceEntry | null,
  isStructuralTemplateConstructor: boolean,
  super: RuntimeMethodEntry | null,
  mergedLinkedChannels: string[],
  mergedMutatedChannels: string[]
}
```

Finalization-only fields such as `callsSuper`, `invokedMethodRefs`,
`superOrigin`, `ownLinkedChannels`, and `ownMutatedChannels` must not survive on
the long-lived execution entry. If a field survives, it must be justified as an
execution-time requirement.

`ownerEntry` is required for constructor entries and null for ordinary
methods/blocks. It tells the constructor invocation which loaded chain entry
owns the body, so context forking is owner-relative without scanning unrelated
state at execution time. `isStructuralTemplateConstructor` is true only for a
non-extending template constructor that owns document structure.

## Invocation And Linking

Inherited callable invocation starts from finalized direct metadata.

Rules:

- ordinary `this.name(...)` dispatch reads the most-derived
  `runtimeState.methods[name]`
- `super()` reads `methodData.super` from the executing callable's runtime
  entry
- constructor execution is ordinary inherited dispatch to `__constructor__`
- invocation creates an invocation child buffer at the call site
- the invocation child buffer links exactly the target's
  `mergedLinkedChannels` and `mergedMutatedChannels`
- callable entry startup may validate `methodData`, but it must not resolve
  metadata asynchronously or widen the footprint
- shared-channel observation enqueues on the current buffer and uses the
  finalized shared schema to route the exact observation to the shared root
- missing finalized metadata at an execution boundary is a fatal structural
  error, not an ambient lookup fallback

Do not link all shared-schema channels as a convenience. Exact linking is part
of the concurrency contract.

The invocation path must not branch on naming conventions such as
`methodName === "__constructor__"` when metadata can carry the invariant
directly. Constructor-specific behavior should be represented by
`RuntimeMethodEntry.isConstructor`.

## File Ownership

The runtime should be rebuilt around these lifecycle ownership boundaries.
Filenames may match prior names, but each file should be created because it owns
one clear phase or primitive in this design, not because an earlier runtime file
existed.

- `load.js`: selected-chain discovery, cycle detection, raw spec registration,
  selected-chain construction
- `instance.js`: prepare inheritance instances by creating state/buffers, then
  running load + finalize without executing constructors
- `finalize.js`: metadata validation, method-table construction, super wiring,
  shared-schema finalization, footprint merging, runtime-entry pruning
- `execute.js`: linear constructor execution through the selected chain. Prefer
  renaming away from `startup.js` if the file owns more than startup.
- `invoke.js`: inherited callable invocation, `super()`, argument payloads,
  invocation-buffer admission
- `shared.js`: shared schema/runtime operations and shared-root buffer access
- `component.js`: component instance lifecycle, command-based operations,
  explicit shared observation

Do not make one file compensate for another phase. For example, `invoke.js`
must not discover missing methods, and `load.js` must not create buffers to
evaluate constructor state.

## Template Lifecycle

All root-level template code is constructor code. Every template in the
selected chain may have a constructor.

For `child -> mid -> root`:

1. load registers specs in `[child, mid, root]`
2. finalize wires methods/super/shared state once
3. execution invokes `child.__constructor__` once
4. child and mid reach their parents through compiled implicit trailing
   `super()` calls
5. only a non-extending template constructor places inline blocks

Inline block placement is a compile-time structural role. A template that
syntactically has `extends` is non-structural: its block bodies define callable
overrides but do not place output at their source location. A template without
`extends` is structural and may place inline blocks.

```js
await runtime.invokeInheritedCallable(
  prepared.runtimeState,
  "__constructor__",
  [],
  prepared.context,
  env,
  runtime,
  cb,
  prepared.rootBuffer,
  constructorOrigin
);
```

`extends none` and dynamic-null templates still have the compile-time role of
an extending template. They have no selected parent at runtime, but they do not
become structural fallback templates.

The constructor must not decide whether a parent exists by waiting on per-block
promises.

Each constructor implementation receives enough owner metadata to determine its
own loaded-chain entry and forked context. This owner metadata is part of
finalized constructor method data, not a runtime lookup by source file name.
When a constructor calls `super()`, the ordinary super invocation runs the
parent constructor with the parent owner's entry context.

## Script Lifecycle

Script inheritance uses the same load/finalize/constructor phases, but scripts
do not have structural template placement.

Constructors are script bodies. Ancestor constructors run only through explicit
`super()` in the finalized constructor method chain. A topmost `super()` target
uses the no-op constructor entry.

Script return behavior:

- direct render uses the entry script's selected return path
- ancestor constructor returns do not pollute the entry result
- constructor `super()` continues to use isolated return handling
- ancestor script constructors run only when reached through explicit
  `super()` calls

Script/template constructor signatures may differ only when required by real
script/template semantics.

## Returns

Return semantics stay explicit:

- `extends` is not a value-producing expression
- direct-render scripts return only the entry script's selected result
- ancestor constructor returns are ignored except as values observed by an
  explicit `super()` call
- template rendering returns the final text output
- component construction returns the component instance to the owner binding,
  not the constructor's user return value
- component method calls return the called method's result

## Dynamic Extends

Dynamic extends is resolved during loading exactly once per render.

Rules:

- `extends none` and dynamic `null` mean no parent is selected.
- A template that syntactically has `extends` remains non-structural even when
  the runtime parent selection is `none`/`null`; it does not render a local
  fallback structure.
- payload expressions are skipped when no parent is selected.
- every template may have a dynamic `extends`, but it must be a top-level
  declaration in the root template body, not nested inside `if`, `for`,
  blocks, macros, includes, or any other runtime control flow.
- no template declarations may appear before `extends`; templates use `{% set %}`
  for ordinary locals and infer shared vars from `this.<name>` usage.
- the `extends` target expression and `extends ... with ...` payload
  expressions cannot read inferred shared vars, because shared channels are
  initialized by constructor execution after loading.
- dynamic selection cycles fail during loading.
- dynamic selection cannot depend on constructor locals/channels.

There is no `extendsState.parentSelection`, `extendsState.parentReady`, or
per-block `hasParent` promise in the target implementation.

## Shared State

Shared schema is finalized before constructors run.

Scripts:

- use explicit `shared` declarations
- every file using `this.<name>` must declare shared participation locally
- shared declarations are root-scope only; they are not allowed inside methods
  or blocks
- bare names never mean shared access in scripts, even when the same file
  declares a shared channel with that name

Templates:

- infer static `this.<name>` roots as shared `var`
- reject all template `shared` declarations, including `shared var`
- reject non-shared channel declarations in templates
- reserve `this.__text__` as the inherited template text-channel exception
- `{% set this.name = ... %}` is a runtime write, not a default claim
- `extends` target/payload expressions cannot read template shared vars, even
  when those vars are inferred elsewhere in the template

Shared access forms:

- `this.varName`: shared `var` snapshot
- `this.varName = value`: shared `var` write
- `this.varName.path`: shared `var` snapshot followed by ordinary property
  lookup
- `this.varName.path = value`: shared `var` nested update when object-path
  assignment is otherwise supported
- `this.textName(value)`: shared `text` append/call in scripts
- `this.dataName.path = value`: shared `data` channel update in scripts
- `this.dataName.command(args)`: shared `data` command in scripts
- `this.sequenceName.method(args)`: shared `sequence` call in scripts
- `this.channel.snapshot()`: explicit snapshot of any declared shared channel
- `this.channel is error` and `this.channel#`: shared-channel error
  observation

Template `this.<name>` access is var-only except for the reserved inherited
text channel `this.__text__`. Templates do not access script typed shared
channels implicitly.

Shared channels are linked by exact finalized footprints. Broad setup-time
whole-schema linking is not part of the target architecture.

The inheritance runtime must use public channel/buffer APIs for channel type,
ownership/link checks, and sequence initialization. It must not depend on
private channel fields such as `_channelType`, `_buffer`, or
`_setSequenceTarget`.

## Components

Component instances run through the same lifecycle:

1. load component chain metadata
2. finalize component inheritance state
3. execute component constructor
4. keep component root/shared buffer open for the binding lifetime
5. close explicitly or when the owner binding completes

Command-based component operations preserve source order by enqueueing on the
owner buffer. Direct instance calls use the component root/shared buffers.

Explicit shared observation remains separate from ordinary inherited method
dispatch because it observes another instance's shared root.

Caller-side component observation:

- `componentName.sharedVar` observes a component shared `var` snapshot
- `componentName.sharedVar.path` observes the shared `var` then applies normal
  property lookup
- non-`var` shared channels require explicit observation such as
  `.snapshot()`, `is error`, or `#`
- implicit nested reads are not allowed for `text`, `data`, or `sequence`
  shared channels
- caller-side observation is read-only; component state mutation goes through
  component methods or the component's own constructor

No component path may require late linking into a finished parent buffer.

Component unit tests should fake the compiled root shape defined in this
document when a synthetic target is needed. They must not depend on overloaded
root-render fixtures.

## Compiler Analysis Requirements

The compiler must emit enough static metadata for the runtime to load and
finalize without executing user code.

Required metadata:

- local immediate-parent resolver for the root `extends` declaration
- raw callable entries for blocks, methods, and constructors
- callable signatures as ordered argument names
- source origins for callables, `super()`, and ordinary inherited calls
- callable-local `super` presence
- file-level and callable-local ordinary inherited call references
- callable-local own linked/mutated channel footprints
- script shared declarations and template inferred shared-var roots
- component operation sites and component shared observation sites

Static analysis must reject language surfaces that would require execution to
discover structure: nested dynamic template `extends`, constructor locals in
`extends` expressions, dynamic template `this[...]` shared access, and unsupported
callable `with` syntax.

Generated-source and precompiled-fixture tests must assert the target ABI shape.
Browser/precompiled fixtures should be regenerated from the clean compiler
output and must not contain forbidden lifecycle helpers.

## Finalization Errors

Finalization should collect independent recoverable structural metadata errors
before throwing when collection is cheap and clear.

Collectable:

- duplicate callable declarations in one file
- incompatible override signatures
- `super()` with no parent implementation
- missing `this.method(...)` references
- shared/method name collisions
- shared schema type conflicts

Immediate fatal:

- missing or malformed compiled function where the compiler ABI requires one
- invalid inheritance state
- corrupted method entry shapes that prevent safe finalization

Shared-schema inputs should retain declaration origins during finalization so
cross-file conflicts can point at the relevant declaration sites. Execution-time
shared schema remains type-only.

Compiler ABI metadata is an invariant after compilation. Finalization may copy,
deduplicate, and freeze/normalize arrays for stable runtime use, but it must
not silently fabricate missing signatures, invoked refs, channel names, or
method shapes. Malformed ABI metadata is a fatal implementation error.

Do not add complex aggregation machinery if it obscures finalization. But the
target behavior should avoid stopping at the first independent metadata error
when the rest can be discovered by the same pass.

Normal Cascada error and poison semantics do not change. Metadata and lifecycle
contract failures are fatal structural errors. Value-consumption failures inside
ordinary constructor/callable execution follow the existing poison/error
rules for the operation that consumed the value.

## Stable Semantics

This design starts the inheritance runtime from a blank implementation. The
items below are semantic requirements to reimplement, not runtime code to reuse.
Compiler code may reuse existing analysis and emission machinery where it
already produces the required final shapes.

- finalization builds a most-derived dispatch table from compiled method
  metadata
- `super()` follows owner-relative links rather than re-resolving by name
- invocation accepts the same named and positional argument forms
- shared declarations still reject schema conflicts
- merged channel footprints include every method entry in the super chain
- component operations still preserve source order through explicit commands
- `this.method(...)` and `super()` keep their user-visible invocation semantics

The lifecycle defines the rail. Runtime code that does not naturally follow it
should not be ported.

## Prohibited Implementation Patterns

- parent loading by calling parent `rootRenderFunc(...)`
- `renderInheritanceParentRoot(...)` / `bootstrapInheritanceParentScript(...)`
  as loading helpers
- root modes: `compositionMode`, `componentMode`, `parentBuffer`
- `extendsState.parentSelection`, `parentReady`, `hasParent`
- dynamic block-placement wrappers that wait for a parent decision
- `startupPromise` as cross-phase orchestration
- `inheritanceSpec.setup`
- `_isExtendingTemplateStartupOutput(...)`
- broad whole-schema setup linking
- finished-parent late linking
- duplicate script/template constructor signatures not required by semantics
- constructor/body parameter threading whose only purpose is context leakage
- private channel field access from inheritance runtime code
- synthetic tests that depend on forbidden root-render or lifecycle helper
  shapes
- silent normalization of malformed compiler ABI metadata
- generated/precompiled fixtures containing forbidden lifecycle helpers

## Implementation Plan

Each step must end with focused tests for the slice it implements. Full-suite
conformance is not required at every step while the inheritance runtime is being
rebuilt from a blank folder. Focused tests should verify phase boundaries,
compiled ABI shape, and observable behavior for the new path. Run broader
integration suites only at explicit integration gates, especially before
deleting old non-inheritance compatibility paths or declaring the clean
implementation complete.

### Step 0: Source-Language Surface

Goal:

- remove template block `with ...`, `with context`, and `without context`
  syntax
- remove script method `with context` syntax
- make render-context names visible by default inside inherited methods and
  template blocks
- make callable signatures consist only of ordered argument names
- support template block placement arguments, including named placement
  bindings such as `{% block item(user = selectedUser) %}`
- reject mixed positional/named block placement bindings
- reject all template channel declarations, including `shared var`
- allow each template to use a top-level dynamic `extends`
- reject dynamic template `extends` nested inside runtime control flow
- reject any template declaration before `extends`
- reject `extends` target/payload expressions that read inferred shared vars or
  other constructor-created locals/channels
- copy the latest `docs/cascada/script.md` and `docs/cascada/template.md`
  language-surface documentation into the clean branch

Tests:

- parser rejects block `with`, `with context`, and `without context`
- script transpiler/parser rejects `method ... with context`
- inherited methods and template blocks read render context by default
- block signatures compare only argument names
- named block placement bindings pass local values by declared argument name
- mixed positional/named block placement bindings fail
- template `shared var`, `shared text`, `shared data`, and `shared sequence`
  declarations fail
- non-shared template channel declarations fail
- top-level dynamic template extends compiles
- dynamic template extends inside `if`/`for`/block fails
- declarations before template `extends` fail
- inferred template shared vars cannot be read by the `extends` expression

### Step 1: Compiled Shape And ABI

Goal:

- freeze the final compiled inheritance ABI before runtime implementation
- compiled roots expose the final `{ root, inheritanceSpec,
  resolveInheritanceParent, executeConstructor }` shape
- `inheritanceSpec` is data-only and contains no executable setup function
- generated root functions contain no lifecycle mode flags
- generated inheritance code does not reference forbidden helpers or
  compatibility adapters

Tests:

- compiled template root exposes exactly the target inheritance shape
- compiled script root exposes exactly the target inheritance shape
- compiled `inheritanceSpec` has metadata fields and no setup function
- generated source contains no `compositionMode`, `componentMode`,
  `parentBuffer`, `extendsState`, or `startupPromise`
- `resolveInheritanceParent` for a no-extends root returns data only
- `executeConstructor` can be called as a constructor executor without loading
  parents

### Step 2: Metadata Loader

Goal:

- runtime `loadInheritanceChain(...)` loads metadata child-to-parent
- no user constructor executes during loading
- `LoadedInheritanceChain` is built

Tests:

- static three-level template chain loads specs without executing root code
- static script chain loads specs without executing root code
- dynamic parent selection resolves once
- `extends none` and dynamic null produce no selected parent entry
- dynamic-null skips payload evaluation
- constructor-local dynamic extends/payload expressions fail clearly
- loading can be unit-tested without `CommandBuffer`
- loading returns an immutable chain value rather than mutating reusable state

### Step 3: Linear Root Orchestration For Standalone Roots

Goal:

- public `root` becomes a thin lifecycle orchestrator
- standalone templates/scripts use prepare instance -> execute constructor ->
  complete result
- direct render uses the same prepared-instance helper as components
- no root-render mode flags are needed for standalone execution

Tests:

- standalone template output matches the public template contract
- standalone script return rules match the public script contract
- preparation finishes before any constructor user code
- loading/finalization happen exactly once inside preparation
- constructor execution can be tested from a prepared instance
- constructor execution enters through inherited dispatch to `__constructor__`

### Step 4: Template Constructor Super Chain

Goal:

- template constructor chain executes through implicit trailing `super()`
- every selected template body is a constructor implementation
- no parent root executes during loading

Tests:

- child/mid/root constructors all run through the `super()` chain
- constructor writes are visible according to shared/channel rules
- inline block placement observes constructor writes from every selected chain
  entry

### Step 5: Structural Template Block Placement

Goal:

- inline block placement is a compile-time structural-template behavior
- templates with `extends` define block overrides but do not place inline block
  output
- templates without `extends` may place inline block output
- static/dynamic runtime suppression branches are not used

Tests:

- non-extending template owns document text and places inline blocks
- extending child/mid templates define block overrides without placing them
- `extends none` and dynamic null do not turn an extending template into a
  structural fallback template
- named binding expressions are emitted only for structural inline placements

### Step 6: Dynamic Extends Through Loader Only

Goal:

- dynamic extends uses `LoadedInheritanceChain`, not `extendsState`
- no generated code uses per-block parent-decision promises
- dynamic cycles fail during loading

Tests:

- dynamic parent selected at runtime runs the selected parent constructor chain
- dynamic null runs only the entry constructor
- dynamic selection errors propagate through render
- no generated code references `extendsState.parentReady`

### Step 7: Components On The New Lifecycle

Goal:

- component creation uses load -> finalize -> execute
- component root buffers close by component lifetime
- no component root-render modes remain

Tests:

- component startup before method call
- component with inheritance
- explicit close rejects later operations
- startup constructor failure records startup error and closes buffer
- no finished-parent late linking is required

### Step 8: Cleanup, Pruning, And Test Migration

Goal:

- delete root/composition/component-mode paths
- prune runtime method entries after finalization
- update generated-source tests and browser precompiled fixtures
- update docs to name this design as authoritative
- triage skipped inheritance tests as deleted, rewritten, or still required
- verify compiler-private runtime helpers do not look like public API

Tests:

- source grep tests or generated-source tests proving forbidden helpers do not
  appear
- browser/precompiled fixtures regenerated from target compiler output
- no skipped inheritance test group remains without an explicit disposition
- focused inheritance suites pass
- full `npm run test:quick` at the final integration gate

## Acceptance Criteria

- Loading never executes user root code.
- Finalization never calls compiled user functions.
- Public execution is linear and explainable as load -> finalize -> constructor
  method execution -> output/result completion.
- Template constructors from every selected chain entry can run child-to-parent
  through the normal `super()` chain.
- Inline block placement is controlled only by compile-time structural template
  role.
- Extending templates do not become structural fallback templates when dynamic
  parent selection resolves to `none`/`null`.
- Dynamic extends resolves once before constructor execution.
- Dynamic extends/payload expressions cannot read constructor locals/channels.
- Dynamic template extends is allowed only as a top-level declaration, with no
  template declarations before it.
- Template block and script method `with context` syntax is absent.
- Inherited methods and template blocks read render context by default.
- Named template block placement bindings work only as placement arguments, not
  as a separate signature mode.
- Components do not need finished-parent late linking.
- Root mode flags and `extendsState` are absent.
- Runtime method entries are pruned to execution-time fields.
- Independent recoverable finalization errors are collected or explicitly
  documented as immediate fatal.
- Compiler ABI metadata violations fail loudly instead of being silently
  repaired.
- Shared-schema conflict diagnostics retain declaration-origin quality during
  finalization.
- Inheritance runtime code uses public channel/buffer APIs rather than private
  channel fields.
- Public feature behavior remains where it does not contradict the
  lifecycle contract.
