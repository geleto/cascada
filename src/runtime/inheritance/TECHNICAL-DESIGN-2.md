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
3. invoke inherited methods
4. complete buffered output / script result
5. keep component lifetime explicit and independent from render-root lifetime

Correctness is protected by focused tests for phase boundaries and observable
behavior.

The sync compiler uses the Nunjucks inheritance path and is out of scope.

## Clean-Spec Rule

All steps implement the latest public inheritance specification as if the
legacy async inheritance implementation never existed.

Do not add or keep legacy-compatibility code paths, migration shims, stale ABI
fallbacks, or bespoke diagnostics whose only purpose is to recognize removed
syntax or historical runtime shapes. Unsupported old forms should fail
naturally from the current grammar, analysis, ABI, or runtime contracts.

When replacing old behavior, delete or bypass it in favor of the clean target
shape described here. If the current codebase makes that impossible without a
compatibility bridge, stop and resolve the design gap before implementing.

Existing inheritance-related compiler/runtime code is not authoritative merely
because it is active in the current branch. When a step touches old inheritance
code whose shape does not match this design, prefer rewriting that slice to the
target contract over adapting or layering onto the old implementation.

Compiler code should use the compile mode contract directly. If behavior differs
between Cascada Script and Cascada Template, branch on `compiler.scriptMode`
rather than rediscovering the mode from AST node shapes such as method versus
block nodes. Use node-shape checks for syntax recognition and traversal
boundaries, not as a substitute for the known compile mode.

Focused rebuild tests live in `tests/pasync/inheritance.js`. Keep new focused
inheritance tests in that file unless a later integration gate intentionally
splits them by public subsystem.

## Non-Negotiable Lifecycle

Each phase has a single owner and a bounded contract.

### Phase 1: Load

Input:

- entry compiled template/script
- instance context
- environment/runtime helpers

Output:

- `LoadedInheritanceChain` in child-to-parent order

Allowed:

- compile selected roots
- evaluate local `extends` selections
- register raw `inheritanceSpec` objects
- track source paths for cycle detection

Forbidden:

- invoke methods
- call callable methods/blocks
- render text
- create command buffers
- finalize metadata
- set or read startup promises
- discover new runtime methods beyond compiler-emitted metadata

### Phase 2: Finalize

Input:

- `LoadedInheritanceChain`
- source-origin context for diagnostics

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
- validate override argument-name compatibility
- wire owner-relative `super` links
- compute merged chain footprints
- collect independent recoverable finalization errors

`RuntimeMethodEntry.super` is wired to the nearest parent implementation for
the same callable name. Finalization must not skip intermediate overrides, and
execution must not dynamically search the chain to resolve `super()`.

Merged linked/mutated footprints are computed transitively across the full
`super` chain, including overridden parent entries. Invocation links exactly the
chains that any implementation reachable through that callable chain may
observe or mutate.

Forbidden:

- call compiled user functions
- evaluate template/script expressions
- render text
- create or finish command buffers
- fork contexts
- discover parent roots

### Phase 2.5: Create Instance

This is an orchestration boundary, not a metadata phase.
`InheritanceInstance.create(...)` combines load + finalize + buffer ownership
setup into a ready-to-invoke inheritance instance.

Input:

- entry compiled template/script
- render context
- environment/runtime helpers
- output/root buffer owner
- owner/lifetime handle for the root and shared buffers

Output:

```js
class InheritanceInstance {
  static async create(options)
  invoke(methodName, args, origin)
  finishRender(entryResult)
  close()
}
```

`InheritanceInstance.create(...)` returns a fully loaded, finalized, ready to
invoke instance. No half-initialized instance is exposed.

Instance state includes:

```js
type InheritanceInstanceState = {
  entryTemplateOrScript: Template | Script,
  runtimeState: InheritanceRuntimeState,
  env: Environment,
  runtime: object,
  cb: Function,
  rootBuffer: CommandBuffer,
  sharedRootBuffer: CommandBuffer,
  context: Context,
  failure: Error | null,
  closed: boolean
}
```

`context` is the instance execution context. For direct rendering and include
it is based on the render context (for include, the `with` payload variables
are merged in). For components it is built from the explicit component payload,
with caller context included only when component `with context` is used. Every
file in the selected inheritance chain uses this same instance context.

Allowed:

- create the root output buffer for the instance
- create or attach the shared root buffer for the instance
- call the load phase
- call the finalize phase
- return a ready-to-invoke `InheritanceInstance`

Forbidden:

- invoke methods
- initialize shared defaults
- call inherited methods
- perform component method/observation operations

The instance is the unit all later method invocations need. It is also the
natural unit for component lifetime: component instances keep this root/shared
buffer pair open until explicit close or owner binding completion.

### Phase 3: Execute Method

Input:

- `InheritanceInstance`
- method name
- invocation arguments
- source origin

Output:

- commands enqueued by the method call
- callable return value

Allowed:

- invoke a finalized inherited callable through the normal invocation machinery
- link exactly the chains needed by the callable
- declare and initialize shared chains as method code requires
- call `super()` through finalized owner-relative links

The constructor is just the `__constructor__` method. Direct rendering,
include, and component creation all start by invoking that method once. The runtime does not
manually iterate the parent chain to execute constructors.

`runtimeState.methods.__constructor__` is the most-derived available concrete
constructor entry. If the selected child has no constructor body, dispatch
naturally starts at the nearest ancestor constructor. If the selected child has
a concrete constructor body, parent constructor execution happens only when
that body calls `super()`, exactly like any other inherited method.

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
- use lifecycle mode flags to change this phase's behavior

### Phase 4: Direct Render or Include Completion

Input:

- `InheritanceInstance`
- result returned by `instance.invoke("__constructor__", ...)`

Output:

- final template text or direct script result

Templates:

- No additional template user code runs in this phase.
- Template structure was already produced by executing constructors in Phase 3.
- This phase uses the same completion rule as ordinary async template roots:
  finish the root output buffer and materialize the root text chain's final
  snapshot.

Scripts:

- No additional script user code runs in this phase.
- This phase finishes the root output buffer.
- Direct script render returns the `entryResult` produced by invoking
  `runtimeState.methods.__constructor__`.
- Do not invent an inheritance-specific return path.
- For templates, `finishRender(entryResult)` completes the root/shared buffer
  and returns the constructor result, which is the finalized template text for
  the selected structural constructor chain.

Generated participant roots must be thin orchestration only. The root function
is invoked as the compiled template/script object's `rootRenderFunc`, so it can
use `this` as the entry template/script object. The generated root delegates
the lifecycle to `runtime.renderInheritanceParticipantRoot(...)` instead of
inlining load/finalize/constructor/finish logic:

```js
function root(env, context, runtime, reportError) {
  runtime.renderInheritanceParticipantRoot({
    entryTemplateOrScript: this,
    env,
    context,
    runtime,
    reportError,
    rootBuffer: output,
    errorContext: rootErrorContext
  }).catch((err) => reportError(err));
}
```

The actual generated code must keep this ownership shape:

1. pass the compiled entry object, runtime render inputs, root buffer, and
   source origin to the runtime lifecycle helper
2. let the runtime helper create one `InheritanceInstance`
3. let the runtime helper invoke `__constructor__`, finish, and normalize the
   direct-render result

It must not duplicate load/finalize/shared-buffer setup inside `root`, and it
must not use `props.root`, `props.rootFunction`, or any fallback between the two
compiled-root property names.
If a later environment call path stops binding `this` to the compiled
template/script object, the environment must pass the owner object explicitly;
the generated root still must receive one entry object, not rediscover itself
through alternate property names.

Forbidden:

- rerun constructors
- place inline blocks
- reload parents
- re-finalize
- discover method entries
- close component-owned buffers as a render result

### Phase 5: Component Lifetime

Input:

- component-owned `InheritanceInstance`
- owner side-chain / binding lifetime

Output:

- initialized component instance exposed to the owner binding
- finished component root/shared buffers after close or side-chain completion

Component instances use the same load/finalize/constructor lifecycle. Their
root buffer remains open for the component binding lifetime and closes when the
owner binding completes or the instance is explicitly closed.

Components are not a different compiled template/script mode. A direct render,
an include, and a component instance all initialize the same inheritance instance
shape and invoke the same `__constructor__` method through the same runtime
dispatch path. The difference is ownership of buffer completion:

- direct render and include finish the instance root/shared buffers after
  constructor execution and result materialization via `finishRender(entryResult)`
- component creation binds the instance to the caller's component
  side-chain, treats constructor completion as initialization, and finishes
  the instance root/shared buffers via `close()` only when that side-chain's
  final snapshot settles or the component is explicitly closed

Component creation is a composition boundary. By default a component receives
only the explicit component payload and does not inherit the caller render
context. `with context` is a component opt-in that builds the instance context
from the caller context plus explicit payload. The selected inheritance chain
inside that component then uses that one instance context for every owner.

Forbidden:

- depend on linking new child buffers into already-finished parent buffers
- keep component-specific lifecycle modes
- use parent render execution as component metadata loading

## Compiled Template/Script Shape

The compiled output shape is the lifecycle contract made concrete. Plain
templates/scripts that do not participate in inheritance keep the ordinary
compiled template/script shape. The compiler emits inheritance ABI only when
analysis marks the file as an inheritance participant.

Inheritance participants expose stable properties:

```js
{
  root,                     // public render entry
  inheritanceSpec,          // raw compiler metadata; no executable side effects
  resolveInheritanceParent  // local immediate-parent resolver
}
```

`root` is the public render entry and a thin orchestrator over the
lifecycle. It must not accept lifecycle mode flags.

Precompiled artifacts must be regenerated for this ABI. The implementation
defines one compiled inheritance ABI, and all generated inheritance code must
use that ABI.

ABI rules:

- use one inheritance compiled template/script object shape for participating
  scripts and templates
- do not emit `inheritanceSpec` or `resolveInheritanceParent` for plain
  templates/scripts that analysis proves do not participate in inheritance
- expose only lifecycle boundary functions by name; callable bodies live in
  metadata as method entries
- keep metadata data-only
- avoid mode booleans that change a function from render, to parent loader, to
  component lifecycle, to composition execution
- pass explicit phase inputs; do not pass catch-all state objects just because
  multiple phases need different data
- prefer object-shaped runtime helper arguments at public phase boundaries when
  that makes the contract clearer
- generated internal functions may use positional parameters only when the
  ordering is stable and the meaning is documented here
- every generated function must have one lifecycle role
- compiler-private helper names must describe the lifecycle role they serve

## Compile-Time Shape Vs Runtime Values

Compile-time decides shape. Runtime decides values.

Compile-time decides:

- whether the file participates in inheritance
- whether to emit inheritance ABI
- whether `resolveInheritanceParent` is trivial, static, or dynamic
- whether a template is structural or non-structural
- callable signatures and argument-frame binding shape
- callable metadata: `super`, invoked refs, owner, origins, and footprints
- shared schema inputs, including explicit script shared declarations and
  inferred template shared declarations
- which syntax is legal

Runtime decides:

- actual dynamic parent value for participant files with `extends`
- actual method/block argument values
- actual shared state values
- actual command ordering, snapshots, poison/error outcomes
- actual component close timing

Use analysis facts to emit small direct code:

- plain template/script: no inheritance ABI
- inheritance participant with no `extends`: trivial null-parent resolver
- static `extends`: direct/static resolver, no dynamic-expression branch
- dynamic `extends`: dynamic target evaluation and metadata-only validation
- template with `extends`: no inline placement code
- template without `extends`: inline placement code may be emitted
- no shared names: empty shared schema metadata and no shared declaration work
- callable with no `super()`: no generated `super()` call path in that callable

Do not let this optimization fragment the participant ABI. Every inheritance
participant still exposes the same `{ root, inheritanceSpec,
resolveInheritanceParent }` shape.

The plain-file decision must be rock-solid. A template/script that does not use
inheritance syntax or component inheritance syntax must compile exactly like an
ordinary non-inheritance file: no `inheritanceSpec`, no
`resolveInheritanceParent`, no `__constructor__` method entry, and no
inheritance runtime helper calls. This decision belongs to analysis, not to
late code-generation heuristics.

`inheritanceSpec` contains only metadata needed by loading/finalization:

```js
type CompiledInheritanceSpec = {
  methodEntries: Record<string, CompiledMethodEntry>,
  sharedSchema: Record<string, CompiledSharedSchemaEntry>,
  hasExtends: boolean
}

type CompiledSharedSchemaEntry = {
  type: string,
  origin: SourceOrigin | null,
  hasDefault: boolean
}
```

Constructor execution owns all executable file body work; `inheritanceSpec`
contains metadata only. The constructor function is registered as the
`__constructor__` method entry and is invoked through the same
`RuntimeMethodEntry` path as any other callable.

Compiler/runtime ABI helpers are internal. They may be exported through the
runtime bundle because generated code must call them, but they are not public
user API. Name and document them as compiler-private helpers, and do not let
helper exports define lifecycle phase boundaries.

### Local Parent Resolver

Each inheritance participant has one local resolver:

```js
async function resolveInheritanceParent(env, context, runtime, errorContext, reportError)
```

It evaluates only the current template/script's immediate `extends` selection
and returns:

```js
{
  parentTemplateOrScript: Template | Script | null,
  origin: SourceOrigin | null
}
```

`parentTemplateOrScript` is the selected parent compiled template/script
object. The loader reads its `inheritanceSpec` and
`resolveInheritanceParent`; it must not execute its public `root`
during loading.

It must not:

- register metadata
- recurse
- mutate runtime state
- finalize
- run constructor code

Dynamic `extends` targets are evaluated before constructor execution.
Therefore they may read:

- values already present in the current instance context, including component
  payload values when the instance is a component
- globals

They may not read:

- variables created by top-level `{% set %}` / script `var` in the same
  template/script
- inferred shared vars from `this.<name>` usage in the current template
- shared chains declared or created by the current script constructor
- command-buffer state
- any source-ordered value that would require constructor execution

The compiler enforces this during analysis. Unsupported expressions fail
clearly instead of falling back to parent-render loading.

`extends ... with ...` is not supported. Inheritance is not a composition
boundary; it selects parent metadata inside one inheritance instance. For
scripts, if dynamic `extends` resolves to `none`/`null`, no parent is selected.
For templates, resolving to no parent is a load error.

Resolver ABI notes:

- the resolver returns data only; it does not mutate runtime state
- the resolver does not receive `InheritanceRuntimeState`
- any expression that would require finalized runtime state is outside the
  resolver's allowed phase contract and must be rejected by analysis
- the resolver must be testable without a `CommandBuffer`

### Constructor Method Entry

The constructor is an ordinary inherited callable named `__constructor__`.
When a file has constructor body code, that compiled file-body code is stored
in that owner's `__constructor__` method entry's `fn`.

For templates, all root-level template code is constructor code. That includes
text, loops, conditions, includes, shared writes, and inline block declarations.
Whether a block node also places callable output is decided at compile time:
only structural templates place inline blocks.

For scripts, the constructor method is the script body and owns the script
return path.

Constructor ABI notes:

- constructor execution does not discover parents and does not finalize
- constructor execution does not use lifecycle mode flags
- constructor execution starts by invoking `__constructor__` through the
  finalized inherited callable table
- the invoked entry is `runtimeState.methods.__constructor__`, the
  most-derived available constructor entry; execution does not assume the entry
  template/script owns a concrete constructor body
- owner metadata comes from the finalized `RuntimeMethodEntry`
- template structural role is compile-time; it is not recomputed from dynamic
  parent selection
- component behavior is outside constructor code; component orchestration
  decides when to invoke the same `__constructor__` method and when to close
  buffers

## Callable Surface

Template blocks and script methods share the inherited callable model. The
surface is intentionally small.

Removed callable surface:

- no template block `with` or `with context`
- no script method `with context`
- no callable signature mode that compares context access

Rules:

- inherited methods and template blocks read instance-context names by default
- callable signatures are only ordered argument names
- template block placement may pass local values positionally:
  `{% block name(user) %}`
- template block placement may pass local values by explicit name:
  `{% block name(user = localUser) %}`
- explicit `this.method(...)`, `this.blockName(...)`, and `super(...)` calls use
  the normal script/function invocation argument rules
- implicit inline block placement is generated only for structural templates
  and evaluates placement arguments only when that inline block is actually
  placed
- named placement bindings affect placement arguments only; the callable
  signature remains the ordered list of declared block argument names
- positional and named placement bindings may be mixed, following the regular
  function/macro argument model; named placement bindings are normalized to the
  same ordered argument frame before invocation
- overrides may add or omit trailing arguments, but the shared positional prefix
  must keep the same argument names so keyword arguments remain stable

The compiler must reject unsupported syntax early. The runtime must not carry
`withContext`, context-mode, or implicit-placement named-binding metadata.

### `this.<name>` Disambiguation

`this` is the inheritance-instance surface inside scripts/templates that
participate in inheritance.

For scripts, the compiler can classify `this.<name>` from local declarations:

- declared shared chain only: shared access
- local method only:
  - `this.name(...)` is an inherited callable call
  - bare `this.name` is a structural error; inherited callables must be called
- both shared chain and callable: structural ambiguity error
- neither shared chain nor callable: structural missing-name error

For templates, static `this.<name>` property access infers shared `var`
participation, while `this.name(...)` is an inherited callable call. If the
same name is both shared and callable in the finalized chain, finalization
reports the ambiguity.

Bare names do not probe the inheritance shared schema. Bare names follow the
ordinary ambient lookup path: locals, arguments, instance context, and globals.

Shared storage uses compiler-internal chain names such as `$theme`.
The compiled/runtime schema key is that name. Generated code maps
`this.theme` and `component.theme` to `$theme`. This keeps shared storage
separate from an ordinary local `var theme` and lets callable footprints filter
ordinary `usedChains` / `mutatedChains` by shared names. Diagnostics may
strip the `$` or render it as `this.theme` whenever the storage key itself is
not the user-visible subject of the test or error.

## Load And Runtime Shapes

```js
type LoadedInheritanceChain = {
  entries: LoadedInheritanceEntry[] // child -> parent
}

type LoadedInheritanceEntry = {
  templateOrScript: Template | Script,
  spec: CompiledInheritanceSpec,
  path: string | null,
  origin: SourceOrigin | null
}

type InheritanceRuntimeState = {
  methods: Record<string, RuntimeMethodEntry>,
  sharedSchema: Record<string, RuntimeSharedSchemaEntry>
}

type RuntimeSharedSchemaEntry = {
  type: string,
  origin: SourceOrigin | null,
  defaultOrigin: SourceOrigin | null,
  hasDefault: boolean
}

type RuntimeOwnerEntry = {
  templateOrScript: Template | Script,
  path: string | null,
  origin: SourceOrigin | null,
  isStructuralTemplate: boolean
}
```

`InheritanceRuntimeState.methods` is the finalized dispatch table. Each key maps
directly to the most-derived executable entry for that callable name.
Finalization owns all override selection and parent-link wiring; execution never
recomputes "most-derived" by scanning the loaded chain.

For an inheritance participant with no `extends`, the resolver is the trivial
null-parent resolver. Plain non-participating templates/scripts do not have
this resolver.

`LoadedInheritanceChain` is temporary. Finalization consumes it and produces
`InheritanceRuntimeState`. Runtime invocation receives the `InheritanceInstance`,
which owns the finalized runtime state plus buffers and context.

The metadata loader entrypoint is object-shaped:

```js
await loadInheritanceChain({
  templateOrScript,
  env,
  context,
  runtime,
  origin: null
})
```

It returns a frozen `LoadedInheritanceChain` whose frozen `entries` array is in
child-to-parent order. Loading compiles metadata as needed, calls only
`resolveInheritanceParent`, and never executes `root` or creates command
buffers.

## Inheritance Instance API

The public render path, component creation path, and tests should share the same
class-owned lifecycle:

1. `InheritanceInstance.create(...)`
2. `instance.invoke(methodName, args, origin)`
3. `instance.finishRender(entryResult)` for direct render, or
   `instance.close()` for component lifetime cleanup

Creation owns load + finalize + buffer setup:

```js
const instance = await InheritanceInstance.create({
  entryTemplateOrScript, // direct render passes the compiled template/script object
  env,
  context,
  runtime,
  rootBuffer
})
```

The exact option names may change, but `create(...)` must:

1. use the render root buffer when direct rendering, otherwise create one
2. create the shared root buffer for this inheritance instance
3. load the selected chain metadata from `entryTemplateOrScript`
4. finalize metadata into `InheritanceRuntimeState`
5. return a ready-to-invoke `InheritanceInstance`

`create(...)` must not invoke methods. Constructor invocation is just a normal
method invocation:

```js
const entryResult = await instance.invoke("__constructor__", [], origin)
return instance.finishRender(entryResult)
```

Direct template/script rendering and template include both create an instance,
invoke `__constructor__`, then call `finishRender(entryResult)`. Component
creation creates an instance, schedules the same `__constructor__` method call
in component command order, and calls `close()` only when the component
lifetime ends.

Direct render, include, and component creation share the same instance
primitive, but they do not share ownership timing:

- direct render and include create the instance, invoke `__constructor__`
  immediately, and finish it in the same call
- component creation creates the instance and invokes `__constructor__` in
  owner command order; Step 6 owns component close timing and caller-side
  operation scheduling

The loaded chain is the source of truth during loading/finalization. Do not
store derived aliases for the entry template/script, parent-exists boolean, or
template structure owner. Finalization must copy the execution facts a callable
needs onto its `RuntimeMethodEntry` and `ownerEntry`; execution must not inspect
the loaded chain to recover them.

- entry template/script: `loadedChain.entries[0].templateOrScript`
- selected parent exists: `loadedChain.entries.length > 1`
- template structure owner, for template chains: the topmost selected template,
  `loadedChain.entries[loadedChain.entries.length - 1]`

## Composition Payload, Argument Frames, And Shared Chains

Composition payload is the explicit caller-input mechanism for components,
imports, includes, and related composition boundaries. It is not inheritance
metadata and it is not shared state.

Rules:

- payload is plain context-like key/value data
- arbitrary payload keys are allowed; there is no payload schema
- `extends ... with ...` is not supported
- every file in an inheritance chain sees the same instance context
- component/include/import boundaries decide whether and how payload/context is
  supplied
- payload values do not write to shared chains automatically
- shared defaults or constructor code may read payload values by bare name
- normal bare-name lookup consults the instance context and globals

This keeps payload transport separate from hierarchy-owned `this.<shared>`
state. A payload key and a shared name may be the same string without becoming
the same storage location.

Invocation arguments are a different mechanism. A call such as
`this.card(user, "lg")` or `super(user)` creates an argument frame for one
callable invocation. Argument frames are per-call local bindings, not
composition payload, not inherited shared chains, and not entries in the
shared schema.

```js
type InvocationArgs = {
  positional?: any[],
  named?: Record<string, any>
}

type ArgumentFrame = Record<string, any>
```

Invocation maps `InvocationArgs` through the target signature's ordered
`argNames` to produce an `ArgumentFrame`. Callable bodies read those names as
local arguments. The invocation buffer exists because the callable body may
enqueue commands and argument values may be async or poisoned; it does not make
arguments hierarchy chains.

Template named placement bindings are a separate surface from script keyword
arguments. They map placement locals to block argument names before ordinary
invocation begins.

Async macros are the precedent: macro parameters are local `var` chains in
the macro invocation buffer, initialized from call arguments. Inherited
callables should use the same model. Argument names become local `var` bindings
inside the invocation buffer. Reassigning an argument mutates only that local
call frame; it does not mutate the caller's variable, composition payload, or
shared state.

Argument chains are local to each invocation. `super()` passes no arguments;
use explicit arguments such as `super(user, fallbackUser)` to pass values to the
parent callable.

Step 4 reuse boundary:

- inherited invocation mirrors async macro/function positional, keyword, and
  default behavior and reuses the macro keyword-argument detection helper
- compiler-side signature parsing and local `var` chain binding shape are
  shared with async macro/function code; inherited callables should continue to
  move toward those existing argument semantics rather than inventing a parallel
  argument model
- use the inherited-callable mapper for every inheritance callable surface:
  `instance.invoke(...)`, compiled `this.method(...)`, compiled
  `this.blockName(...)`, compiled `super(...)`, and structural inline block
  placement arguments
- keep macro wrappers, `caller()` support, macro text-return behavior, imports,
  and context-isolation rules out of inherited invocation
- keep inherited invocation in `invoke.js`; it consumes finalized dispatch
  entries, owner-relative `super` links, owner metadata, linked footprints, and
  invocation buffers, then builds an inherited callable argument frame rather
  than using `runtime.makeMacro` or macro-specific compiler wrappers

Step 8 deduplicates keyword-argument detection with macros. Full frame
construction remains inheritance-owned because macros invoke compiled functions
with positional parameters while inherited callables pass one local argument
frame object into a command-buffer-backed callable body.

## Method Entry Shapes

Bootstrap/finalization metadata and execution metadata are distinct.

```js
type CompiledMethodEntry = {
  name: string,
  fn: Function,
  signature: { argNames: string[] },
  origin: SourceOrigin | null,
  isConstructor: boolean,
  super: boolean,
  superOrigin: SourceOrigin | null,
  inheritedMethodDependencies: Record<string, InheritedMethodDependency>,
  ownLinkedChains: string[],
  ownMutatedChains: string[]
}
```

`inheritedMethodDependencies` is a deduplicated map of inherited methods that
the compiled callable may call through `this.name(...)`. Each entry keeps the
method name and the first compiler-known call-site origin for finalization
errors. It is dependency metadata, not an exhaustive list of call sites.

After finalization, runtime invocation should see a pruned execution entry:

```js
type RuntimeMethodEntry = {
  name: string,
  fn: Function,
  signature: { argNames: string[] },
  origin: SourceOrigin | null,
  isConstructor: boolean,
  ownerEntry: RuntimeOwnerEntry,
  super: RuntimeMethodEntry | null,
  mergedLinkedChains: string[],
  mergedMutatedChains: string[]
}
```

Finalization-only fields such as `callsSuper`, `inheritedMethodDependencies`,
`superOrigin`, `ownLinkedChains`, and `ownMutatedChains` must not survive on
the long-lived execution entry. If a field survives, it must be justified as an
execution-time requirement.

`ownerEntry` is required for every runtime method entry. It tells invocation
which loaded owner entry owns the body. Execution uses that owner metadata
without scanning unrelated state at execution time.
`ownerEntry.isStructuralTemplate` is true only for a non-extending template
owner that places document structure.

Compiled method entries do not carry owner string keys. Finalization already
processes loaded template/script entries as objects in the selected chain, so
it must attach ownership by object reference to the loaded owner entry. String
keys are diagnostic labels only and must not be used for local dispatch,
override resolution, or `super` wiring.

## Invocation And Linking

Inherited callable invocation starts from finalized direct metadata.

Rules:

- ordinary `this.name(...)` calls perform one direct table read:
  `runtimeState.methods[name]`
- `super()` reads `methodData.super` from the executing callable's runtime
  entry
- constructor execution is an ordinary inherited call to `__constructor__`
- invocation creates an invocation child buffer at the call site
- external/public entrypoints create invocation buffers linked directly to the
  instance shared/root buffer; this includes standalone direct-render
  constructors, component constructors, and `component.someMethod(...)` calls
- internal inherited calls create invocation buffers linked to the current
  invocation buffer; this includes `this.someMethod(...)` and `super(...)`
  from inside constructors, methods, and blocks
- the invocation child buffer links exactly the target's
  `mergedLinkedChains` and `mergedMutatedChains`
- callable entry prologue may validate `methodData`, but it must not resolve
  metadata asynchronously or widen the footprint
- shared-chain observation enqueues on the current buffer and uses the
  finalized shared schema to route the exact observation to the shared root
- missing finalized metadata at an execution boundary is a fatal structural
  error, not an ambient lookup fallback

Do not link all shared-schema chains as a convenience. Exact linking is part
of the concurrency contract.

The shared/root buffer is the storage owner for inheritance shared chains. It
is not a catch-all ambient scope. Public entrypoints start from it to prevent
component/direct method calls from seeing a caller's local scope accidentally.
Internal calls link through the currently executing invocation buffer so they
preserve ordered effects created by the current callable, while still being
rooted in the same instance shared/root buffer.

Final invocation code must choose the exact buffer at the call site. Do not
keep or reintroduce a runtime helper that guesses between `currentBuffer` and
`sharedRootBuffer`.

The invocation path must not branch on naming conventions such as
`methodName === "__constructor__"` when metadata can carry the invariant
directly. Constructor-specific behavior should be represented by
`RuntimeMethodEntry.isConstructor`.

### Call Paths

`InheritanceInstance` owns method lookup, invocation-buffer parent selection,
and super dispatch. `instance.invoke(methodName, args, origin)` is the
external method execution surface. It performs a direct lookup in the
already-finalized dispatch table: `instance.runtimeState.methods[methodName]`.
That entry is already the most-derived implementation. Invocation then builds
the argument frame from positional arguments, creates an invocation buffer
linked to the instance shared/root buffer, links the target's exact merged
footprints, and calls the target `fn` with the instance environment, instance
context, runtime/callback, invocation buffer, argument frame, and method data.

Compiled `this.name(...)` calls always invoke through the same finalized table
entry as `instance.invoke(...)`, but their invocation buffer is linked to the
currently executing invocation buffer:

```js
currentInstance.invokeFromCurrentBuffer("name", args, context, currentBuffer, origin)
```

Generated code calls the current instance directly; there is no separate
runtime wrapper for method lookup or buffer construction.

Compiled `super(...)` calls do not resolve by name. They receive the executing
method's `methodData`, read `methodData.super`, and invoke that exact parent
entry:

```js
currentInstance.invokeSuper(
  methodData,
  args,
  context,
  currentBuffer,
  origin
)
```

Super target validation and invocation-buffer construction belong to the
instance.

Argument rules:

- positional calls map by the target signature's ordered `argNames`
- script keyword arguments follow the regular function-call rules
- template named placement bindings are placement-only; they are not a separate
  callable signature mode
- `super()` passes no arguments
- `super(args...)` builds an argument frame against the parent target's
  signature from the explicit arguments

Owner metadata rules:

- every runtime method entry carries its finalized `ownerEntry`
- all owners in one inheritance chain run with the same instance context
- parent constructors or methods reached through `super()` use the parent
  `ownerEntry` metadata without a runtime chain scan

## File Ownership

The runtime should be rebuilt around these lifecycle ownership boundaries.
Filenames may match prior names, but each file should be created because it owns
one clear phase or primitive in this design, not because an earlier runtime file
existed.

- `load.js`: selected-chain discovery, cycle detection, raw spec registration,
  selected-chain construction
- `instance.js`: `InheritanceInstance` lifecycle and invocation owner:
  `create(...)`, `invoke(...)`, internal-current-buffer invocation, super
  invocation, `finishRender(...)`, `close()`, closed-state checks, buffer
  ownership, and direct render completion
- `finalize-metadata.js`: metadata validation, method-table construction, super
  wiring, shared-schema finalization, footprint merging, runtime-entry pruning
- `bind-instance-metadata.js`: per-instance binding of finalized metadata to the
  render's prepared error-context tables and reportError callback
- `invoke.js`: inherited-callable invocation helpers, including argument-frame
  construction and linking finalized callable footprint chains into an
  invocation buffer. It may reuse macro keyword-argument helpers, but it must
  not own lookup, buffer choice, or `super` dispatch; those belong to compiled
  metadata and `InheritanceInstance`.
- `callable.js`: compiler-private inheritance callable helpers, including
  parent selection and callable context setup
- `shared.js`: shared schema/runtime operations and shared-root buffer access
- `component.js`: component instance lifecycle, command-based operations,
  explicit shared observation, and owner side-chain lifetime wiring around
  `InheritanceInstance`
- `index.js`: explicit compiler-private runtime exports

Compiler-side inheritance code should stay owned by `CompileInheritance`.
If emission grows enough to need a split, create an `InheritanceEmit` helper
under `CompileInheritance` (for example `compiler.inheritance.emitter`), not as
a top-level compiler service. That helper may own only inheritance-specific
generated source: participant roots, parent resolver, shared declarations,
callable bodies, and method-entry literals. Analysis, registration, signature
decisions, and validation support stay with `CompileInheritance`.

Do not make one file compensate for another phase. For example, `invoke.js`
must not discover missing methods, and `load.js` must not create buffers to
evaluate constructor state.

Do not create `startup.js` or `execute.js` unless an implementation step
reveals a narrow helper that does not belong on `InheritanceInstance`.

## Template Lifecycle

All root-level template code is constructor code. A selected template may have a
concrete constructor body; templates without such code still participate in the
finalized `__constructor__` chain through ordinary method-table wiring.

For `child -> mid -> root`:

1. load registers specs in `[child, mid, root]`
2. finalize wires methods/super/shared state once
3. execution invokes the finalized
   `runtimeState.methods.__constructor__` entry once
4. concrete template constructors reach their parents through compiled implicit
   trailing `super()` calls
5. only a non-extending concrete template constructor places inline blocks

Inline block placement is a compile-time structural role. A template that
syntactically has `extends` is non-structural: its block bodies define callable
overrides but do not place output at their source location. A template without
`extends` is structural and may place inline blocks. Therefore a template that
declares blocks and has no `extends` is the structural root/base template for an
inheritance chain.

```js
await instance.invoke("__constructor__", [], constructorOrigin);
```

Templates do not support `extends none` or dynamic-null parent selection. A
template with `extends` must select a parent template. The script language may
support "no parent" selection, but templates use the absence of `extends` to
mean structural root/base template.

The constructor must not decide whether a parent exists by waiting on per-block
promises.

Each constructor invocation receives its finalized `ownerEntry`. This owner
metadata is part of finalized constructor method data, not a runtime lookup by
source file name or loaded-chain position.
When a constructor calls `super()`, the ordinary super invocation runs the
parent constructor with the parent owner's metadata and the same instance
context.

## Script Lifecycle

Script inheritance uses the same load/finalize/constructor phases, but scripts
do not have structural template placement.

Constructors are script bodies. Ancestor constructors run only through explicit
`super()` in the finalized constructor method chain. A topmost `super()` target
uses the no-op constructor entry.

Script return behavior:

- direct render returns the result of invoking
  `runtimeState.methods.__constructor__`
- ancestor constructor returns do not pollute the entry result
- constructor `super()` continues to use isolated return handling
- a script with no concrete constructor body dispatches to the nearest ancestor
  constructor
- once a concrete script constructor body is executing, ancestor script
  constructors run only when reached through explicit `super()` calls

Script/template constructor signatures may differ only when required by real
script/template semantics.

## Returns

Return semantics stay explicit:

- `extends` is not a value-producing expression
- `return` is supported in script constructors and inherited script methods
- method returns use the normal `__return__` chain / unset-sentinel machinery
- `this.method(...)` receives the called method's return value
- `super()` receives the parent method or parent constructor return value
- direct-render scripts return the result of the entry `__constructor__`
  invocation
- ancestor constructor returns are ignored as direct-render results except as
  values observed by an explicit `super()` call and then explicitly returned by
  the entry constructor
- template rendering returns the final text output
- template block output is text-chain output; script-style `return` is not
  part of template block rendering
- component construction returns the component instance to the owner binding,
  not the constructor's user return value
- component method calls return the called method's result

The script transpiler/compiler must support `return` in inherited methods using
the same return machinery used by ordinary script functions. Inheritance must
not introduce a second return implementation.

## Dynamic Extends

Dynamic extends is resolved during loading exactly once per render.

Rules:

- scripts may use `extends none` or dynamic `null` to mean no parent is
  selected.
- in scripts, `extends` must appear before constructor statements. Root-scope
  `shared` declarations may appear before it. Method declarations after
  `extends` are metadata, not constructor statements.
- templates may not use `extends none`, and dynamic template `extends` must not
  resolve to `null`/`undefined`; a template with `extends` must select a parent
  template.
- `extends ... with ...` is not supported for scripts or templates.
- every template may have a dynamic `extends`, but it must be a top-level
  declaration in the root template body, not nested inside `if`, `for`,
  blocks, macros, includes, or any other runtime control flow.
- no template code may appear before `extends` except whitespace/comments.
  Templates use `{% set %}` for ordinary locals and infer shared vars from
  `this.<name>` usage, but `{% set this.name = ... %}` is constructor code and
  is not allowed before `extends`.
- the `extends` target expression cannot read inferred shared vars, because
  shared chains are initialized by constructor execution after loading.
- dynamic selection cycles fail during loading.
- dynamic selection reads only context/payload/global inputs available before
  constructor execution. Bare symbols in the expression compile as ambient
  lookups, so names introduced later by constructor code are ignored by parent
  selection. Shared declarations are metadata/default declarations and are not
  readable by parent selection.

Block placement does not wait on a per-block parent-decision promise. Parent
selection is completed during loading before any constructor runs.

## Shared State

Shared schema is finalized before constructors run.

Scripts:

- use explicit `shared` declarations
- every file using `this.<name>` must declare shared participation locally
- shared declarations are root-scope only; they are not allowed inside methods
  or blocks
- shared declarations may appear before `extends`
- shared defaults are claims, not ordinary constructor writes. Shared
  declarations are considered in child-to-parent chain order; the first
  selected declaration with an initializer wins the default slot. A declaration
  with `= none` has `hasDefault: true`; a declaration without an initializer
  has `hasDefault: false` and does not block parent defaults.
- bare names never mean shared access in scripts, even when the same file
  declares a shared chain with that name

Templates:

- infer static `this.<name>` roots as shared `var`
- reject all template `shared` declarations, including `shared var`
- reject non-shared chain declarations in templates
- reserve `this.__text__` as the inherited template text-chain exception
- `{% set this.name = ... %}` is a runtime write, not a default claim. In an
  extending template it runs before the implicit trailing constructor
  `super()`, so parent constructor writes may overwrite child constructor
  writes.
- `extends` target expressions cannot read template shared vars, even when
  those vars are inferred elsewhere in the template

Shared access forms:

- `this.varName`: shared `var` snapshot
- `this.varName = value`: shared `var` write
- `this.varName.path`: shared `var` snapshot followed by ordinary property
  lookup
- `this.varName.path = value`: shared `var` nested update when object-path
  assignment is otherwise supported
- `this.textName(value)`: shared `text` append/call in scripts
- `this.dataName.path = value`: shared `data` chain update in scripts
- `this.dataName.command(args)`: shared `data` command in scripts
- `this.sequenceName.method(args)`: shared `sequence` call in scripts
- `this.chain.snapshot()`: explicit snapshot of any declared shared chain
- `this.chain is error` and `this.chain#`: shared-chain error
  observation

Template `this.<name>` access is var-only except for the reserved inherited
text chain `this.__text__`. Templates do not access script typed shared
chains implicitly.

Shared chains are linked by exact finalized footprints. Broad setup-time
whole-schema linking is not part of the target architecture.

The runtime must keep chain type behavior centralized. Declaration and shared
re-declaration initializer handling both go through chain type metadata; they
must not scatter direct sequence/var setter branches through inheritance code.

## Components

Components wrap an `InheritanceInstance` with caller-side command ordering and
side-chain lifetime ownership. Component creation publishes the initialized
instance through the owner binding; component close calls `instance.close()`.

Command-based component operations preserve source order by enqueueing on the
owner buffer. Direct instance calls use the component root/shared buffers.

Explicit shared observation remains separate from ordinary inherited method
calls because it observes another instance's shared root.

Component creation accepts explicit payload. By default the component is
isolated from the caller render context. `with context` opts into using the
caller context as the base for the component instance context, with explicit
payload overlaid according to the component language rules. `extends` inside
the component target does not create another payload boundary; all inherited
owners in the component use the same component instance context.

Component `with` syntax uses the same composition-input grammar as import and
include: shorthand names, an object payload, `with context`, and
`with context, ...` combinations. Object-style inputs must be last in the
clause, and duplicate named inputs are structural errors.

Caller-side component observation:

- `componentName.sharedVar` observes a component shared `var` snapshot
- `componentName.sharedVar.path` observes the shared `var` then applies normal
  property lookup
- non-`var` shared chains require explicit observation such as
  `.snapshot()`, `is error`, or `#`
- implicit nested reads are not allowed for `text`, `data`, or `sequence`
  shared chains
- caller-side observation is read-only; component state mutation goes through
  component methods or the component's own constructor
- shared names that start with `_` are private to the component. Component
  implementation code can access them through `this._name`; callers cannot
  observe them through the component binding.

Component unit tests should fake the compiled template/script shape defined in
this document when a synthetic target is needed.

## Compiler Analysis Requirements

The compiler must emit enough static metadata for the runtime to load and
finalize without executing user code.

Required analysis contract:

```js
type InheritanceAnalysisFacts = {
  participates: boolean,
  hasExtends: boolean,
  localExtendsNode: ExtendsNode | null
}
```

`participates` is the only codegen gate for emitting inheritance ABI. It must
be computed during analysis and must be exact. It is true when the file uses an
inheritance surface: `extends`, inherited method/block declarations, inherited
calls, `super()`, script shared declarations, template shared `this.<name>`
inference, or component-specific inheritance constructs. It is false for every
ordinary template/script, including ordinary templates that contain no blocks,
no `extends`, no `this.<name>` shared access, and no inherited calls.

`hasExtends` and `localExtendsNode` are required for resolver generation,
template constructor chaining, and validation. Callable definitions, shared
schema declarations, component operations, and extends nodes remain
analysis-owned root fields with inheritance-prefixed names, but they are not
duplicated inside `InheritanceAnalysisFacts`:
`inheritanceCallableDefinitions`, `inheritanceSharedDeclarations`,
`inheritanceComponentOperations`, and `inheritanceExtendsNodes`.

Analysis may track individual participation reasons for diagnostics or
assertions, but those reason flags are not contracted fields unless listed
above.

Analysis is the only participation gate. Code generation must not rediscover
inheritance participation by rescanning the AST, except for assertions that the
analysis facts and node shapes agree.

Generated-source tests must cover both sides of this gate: ordinary
templates/scripts emit no inheritance ABI at all, while every participation
reason above emits the single participant ABI.

Static analysis must reject language surfaces that would require execution to
discover structure: nested dynamic template `extends`, dynamic template
`this[...]` shared access, and unsupported callable `with` syntax. Script
dynamic `extends` is evaluated before local declarations run. This step assumes
the source-order declaration lookup described in
`docs/code/source-order-declarations.md`: later script-local declarations do
not shadow context/payload/global values in parent-selection expressions.

Generated-source and precompiled-fixture tests must assert the target ABI shape.
Browser/precompiled fixtures should be regenerated from the clean compiler
output and must not contain forbidden lifecycle helpers.

## Finalization Errors

Finalization should collect independent recoverable structural metadata errors
before throwing when collection is cheap and clear.

Collectable:

- duplicate callable declarations in one file
- renamed override arguments in the shared positional prefix
- `super()` with no parent implementation
- missing `this.method(...)` references
- shared/method name collisions
- shared schema type conflicts

Immediate fatal:

- missing or malformed compiled function where the compiler ABI requires one
- invalid inheritance state
- corrupted method entry shapes that prevent safe finalization

Shared-schema inputs should retain declaration origins during finalization so
cross-file conflicts can point at the relevant declaration sites. Runtime shared
schema remains structural metadata only: type, declaration origin, selected
default origin, and whether a default exists. Default expressions are not
evaluated during finalization.
Do not keep a runtime `claimInheritanceSharedDefault` side chain in the final
lifecycle. The current `claimedSharedDefaults` WeakSet is transitional
scaffolding for constructor-emitted default expressions: it lets the first
selected declaration with an initializer run once while keeping unselected
parent defaults unevaluated. A later cleanup should replace it with a selected
default-initialization path driven directly by finalized schema metadata.

Compiler ABI metadata is an invariant after compilation. Finalization may copy,
deduplicate, and freeze/normalize arrays for stable runtime use, but it must
not silently fabricate missing signatures, invoked refs, chain names, or
method shapes. Malformed ABI metadata is a fatal implementation error.

Do not add complex aggregation machinery if it obscures finalization. But the
target behavior should avoid stopping at the first independent metadata error
when the rest can be collected by the same validation pass.

Normal Cascada error and poison semantics do not change. Metadata and lifecycle
contract failures are fatal structural errors. Value-consumption failures inside
ordinary constructor/callable execution follow the existing poison/error
rules for the operation that consumed the value.

## Implementation Plan

Each step must end with focused tests for the slice it implements. Full-suite
conformance is not required at every step while the inheritance runtime is being
rebuilt from a blank folder. Focused tests should verify phase boundaries,
compiled ABI shape, and observable behavior for the new path. Run broader
integration suites only at explicit integration gates.

The steps intentionally reference the contracts above instead of restating
them. When a step is ambiguous, the lifecycle contracts, ABI shapes, and runtime
type shapes in this document are authoritative.

Prefer integration tests once a behavior is reachable through the public render
APIs. Unit tests and synthetic compiled-object tests are allowed while a
lifecycle slice is not yet publicly reachable, but they are provisional unless
they assert an invariant integration tests cannot observe cleanly. At each
integration gate, migrate provisional unit tests to integration tests or delete
them.

Keep long-term unit/generated-source tests for ABI shape, phase-boundary
invariants, source/diagnostic quality, method-entry pruning, helper contracts,
and generated-code absence checks. Do not keep unit tests whose only remaining
purpose is to duplicate end-to-end render behavior.

### Step 0a: Parser And Transpiler Surface

Authoritative sections:

- Callable Surface
- Dynamic Extends
- Returns

Goal:

- remove template block `with ...`, `with context`, and `without context`
  syntax
- remove script method `with context` syntax
- document that inheritance `extends` has no `with` clause for scripts or
  templates
- remove template `extends none`
- keep script `extends none` and dynamic-null no-parent selection script-only
- support script `return` in inherited constructors and methods through the
  normal script return machinery
- copy the latest `docs/cascada/script.md` and `docs/cascada/template.md`
  language-surface documentation into the clean branch

Tests:

- parser rejects block `with`, `with context`, and `without context`
- script transpiler/parser rejects `method ... with context`
- parser keeps existing component/import/include composition forms, including
  `with context, name` and `with context, { key: expr }`
- template `extends none` fails
- script `extends none` is accepted only in script mode
- script `extends` after constructor statements fails
- script `return` in inherited method/constructor syntax transpiles to the
  intended internal return shape without executing inheritance runtime

### Step 0b: Analysis And Validation

Authoritative sections:

- Callable Surface
- Dynamic Extends
- Shared State
- `this.<name>` Disambiguation
- Compiler Analysis Requirements

Goal:

- make instance-context names visible by default inside inherited methods and
  template blocks
- make callable signatures consist only of ordered argument names
- support template block placement arguments, including named placement
  bindings such as `{% block item(user = selectedUser) %}`
- support mixed positional/named block placement bindings using the same
  argument-chain initialization path as functions/macros
- reject all template chain declarations, including `shared var`
- allow each template to use a top-level dynamic `extends`
- reject dynamic template `extends` nested inside runtime control flow
- reject dynamic template `extends` resolving to no parent at runtime
- reject any template declaration before `extends`
- reject `extends` target expressions that read inferred shared vars
- dynamic `extends` expressions rely on source-order declaration lookup, so
  later local declarations do not shadow ambient values
- fail dynamic `extends` naturally when the target is unavailable at parent
  selection time
- compute exact inheritance participation facts

Tests:

- inherited methods and template blocks read instance context by default
- block signatures compare only argument names
- named block placement bindings pass local values by declared argument name
- mixed positional/named block placement bindings compile to the ordered
  callable argument frame
- template `shared var`, `shared text`, `shared data`, and `shared sequence`
  declarations fail
- non-shared template chain declarations fail
- top-level dynamic template extends compiles
- dynamic template extends inside `if`/`for`/block fails
- declarations before template `extends` fail
- inferred template shared vars cannot be read by the `extends` expression
- each participation reason defined in Compiler Analysis Requirements sets
  analysis `participates`
- ordinary templates/scripts do not participate, including ordinary files with
  `{% set %}` / script locals, loops, includes, conditions, and local functions

### Step 1: Compiled Shape And ABI

Authoritative sections:

- Compiled Template/Script Shape
- Compile-Time Shape Vs Runtime Values
- Constructor Method Entry
- Method Entry Shapes
- Compiler Analysis Requirements

Goal:

- freeze the final compiled inheritance ABI before runtime implementation
- analysis decides whether a file participates in inheritance
- plain non-participating templates/scripts do not emit inheritance ABI
- participating templates/scripts expose the final `{ root, inheritanceSpec,
  resolveInheritanceParent }` shape
- constructor code is exposed only as the `__constructor__` method entry inside
  `inheritanceSpec.methodEntries`
- the async transformer owns root-constructor shaping: when it detects an
  inheritance surface, it moves constructor body code into an internal
  `constructorDefinition` method named `__constructor__`; the compiler must not
  re-filter root children to rediscover constructor code
- inheritance discovery facts are analysis-owned and inheritance-prefixed:
  `inheritanceCallableDefinitions`, `inheritanceExtendsNodes`,
  `inheritanceLocalExtendsNode`, and `inheritanceComponentOperations`; compiler
  emission reads these facts instead of recursively walking the AST
- `inheritanceSpec` is data-only and contains no executable setup function
- generated `root` functions contain no lifecycle mode flags
- generated inheritance code uses only the target lifecycle helpers
- remove old compiler setup/startup emission paths, including `b___setup__`,
  `runtime.runCompiledRootStartup(...)`, cross-phase root startup promises, and
  compiler-side inheritance bootstrap/finalize orchestration
- remove dynamic-template per-block parent-readiness wrappers; parent
  resolution belongs to `resolveInheritanceParent`
- re-evaluate composition payload capture in `extends` emission so it supports
  only the target parent-resolution payload model and not removed
  `extends ... with ...` behavior
- replace remaining root-level inheritance discovery scans with direct
  transform/analysis facts where this makes the compiled ABI simpler:
  template inheritance-surface participation, top-level block declarations, and
  local `extends` metadata should be recorded once and then read from the root
  analysis/metadata shape
- if `extends` metadata is centralized in Step 1, include enough placement
  facts for validation to reject nested template `extends` without a separate
  root tree scan

Tests:

- plain templates/scripts expose ordinary non-inheritance compiled shape
- participating templates/scripts expose exactly the target inheritance
  shape
- each participation reason has a generated-source test proving it emits the
  participant ABI
- ordinary templates/scripts have generated-source tests proving they emit no
  inheritance ABI or helper calls: no `inheritanceSpec`, no
  `resolveInheritanceParent`, no `__constructor__`, and no inheritance helper
  references
- compiled `inheritanceSpec` has metadata fields and no setup function
- generated source contains no lifecycle mode parameters or cross-phase startup
  promise state
- generated source contains no per-block parent-readiness wrapper
- `resolveInheritanceParent` for a no-extends inheritance participant returns
  data only
- `resolveInheritanceParent` has the final ABI
  `(env, context, runtime, origin)` and does not receive inheritance state
- `inheritanceSpec.methodEntries.__constructor__` exists only when the
  template/script has concrete constructor body code and has the ordinary
  callable entry shape
- emitted `inheritanceSpec` has no callable setup properties

### Step 2: Metadata Loader

Authoritative sections:

- Phase 1: Load
- Local Parent Resolver
- Load And Runtime Shapes
- Inheritance Instance API
- File Ownership

Goal:

- runtime `loadInheritanceChain(...)` loads metadata child-to-parent
- no user constructor executes during loading
- `LoadedInheritanceChain` is built
- loader treats `LoadedInheritanceChain` as an immutable value and does not
  mutate reusable state
- parent-selection helper code lives in the clean inheritance runtime module;
  compiled `resolveInheritanceParent` only evaluates any dynamic expression and
  delegates parent loading, null handling, and result shaping

Tests:

- static three-level template chain loads specs without executing constructor code
- static script chain loads specs without executing constructor code
- loader tests fail if a compiled `root` is called during loading
- loader does not require or create a `CommandBuffer`
- static inheritance cycles fail during loading with useful source context
- dynamic inheritance cycles fail during loading with useful source context
- parent load failures preserve source/error context
- dynamic parent selection resolves once
- script `extends none` and dynamic null produce no selected parent entry
- dynamic `extends` relies on source-order declaration lookup, so later local
  declarations do not shadow ambient values
- dynamic template `extends` resolving to null/undefined fails before
  constructor execution
- dynamic template null failure ordering is clear and does not execute
  constructor code
- entry and parent compile failures preserve useful source/error context
- loading can be unit-tested without `CommandBuffer`
- loading returns an immutable chain value rather than mutating reusable state

### Step 3: Finalization And Runtime Shape

Authoritative sections:

- Phase 2: Finalize
- Method Entry Shapes
- Load And Runtime Shapes
- Shared State
- `this.<name>` Disambiguation
- Finalization Errors
- File Ownership

Goal:

- runtime finalization consumes `LoadedInheritanceChain`
- finalization produces `InheritanceRuntimeState`
- `runtimeState.methods[name]` maps directly to the most-derived executable
  entry
- `RuntimeMethodEntry.super` is wired to the exact parent entry or `null`
- every runtime method entry has finalized `ownerEntry`
- shared schema is finalized before execution as structured runtime metadata
  with type, origin, default origin, and `hasDefault`
- runtime method entries are pruned to execution-time fields
- recoverable metadata errors are collected where practical
- replace transitional shared-chain bootstrap helpers with clean `shared.js`
  runtime operations; compiler output must not call legacy shared-buffer helpers
  once finalization owns shared schema setup
- keep `claimedSharedDefaults` only as transitional scaffolding; it is not part
  of the clean finalized-schema default model

Tests:

- static child/mid/root chain finalizes into one dispatch table
- finalization does not call compiled constructor/method functions
- ordinary callable names point at most-derived runtime entries
- overridden parent entries remain reachable through `RuntimeMethodEntry.super`
- `super()` links point at exact parent runtime entries without name lookup
- `super()` links skip no unrelated entries and point only to the exact parent
  implementation for that callable name
- missing `super()` targets fail during finalization
- no-op topmost constructor entry is wired where constructor `super()` allows it
- renamed override arguments, missing invoked method refs, shared/method
  collisions, and shared schema conflicts are reported with useful origins
- at least two independent recoverable metadata errors are collected from one
  chain when practical
- shared/method collisions are reported across files as well as within one file
- merged chain footprints include all overridden entries in the super chain
- runtime method entries do not retain finalization-only fields
- owner entries carry template/script, origin, and structural-template facts
  needed by invocation
- concrete and no-op constructor runtime entries have `isConstructor: true`
- non-constructor runtime method entries have `isConstructor: false`
- finalized shared/method collision fails across a template chain

### Step 4: InheritanceInstance And Invoke

Authoritative sections:

- Phase 2.5: Create Instance
- Phase 3: Execute Method
- Inheritance Instance API
- Composition Payload, Argument Frames, And Shared Chains
- Invocation And Linking
- `this.<name>` Disambiguation
- File Ownership

Goal:

- implement inherited-callable argument-frame mapping with the same
  positional/keyword/default behavior as regular function and macro calls
- keep regular function/macro argument behavior unchanged; compiler-side
  argument binding shape may be shared now, while runtime keyword-argument
  detection is shared with macros
- implement `InheritanceInstance.create(...)`
- `create(...)` owns load + finalize + root/shared buffer setup
- `create(...)` returns a ready-to-invoke instance and does not invoke methods
- implement `instance.invoke(methodName, args, origin)`
- `InheritanceInstance` owns method lookup, invocation-buffer construction,
  external/internal buffer parent selection, and `super` dispatch
- constructor invocation is ordinary `instance.invoke("__constructor__", [],
  origin)`
- compiled `this.method(...)` and `this.blockName(...)` consume the finalized
  dispatch table
- compiled `super(...)` consumes `methodData.super`
- compiled `super(...)` must not pass owner path labels or owner string keys;
  object ownership comes from the finalized executing `methodData`
- invocation uses the inherited-callable argument-frame/local-argument binding
  primitive
- remove transitional buffer-selection helpers that guess between current and
  shared/root buffers; direct entrypoints and internal calls must pass the exact
  parent buffer described above
- generated callable code calls the current `InheritanceInstance` directly for
  inherited method calls and `super(...)`
- move callable entry prologue policy into clean invocation helpers:
  callable context creation, argument-frame
  mapping, and entry-local chain initialization should be runtime-owned
  helpers reused by scripts/templates
- keep compiler output limited to evaluating argument/default expressions,
  declaring entry-local chains, and calling runtime invocation/prologue
  helpers with compiled metadata

Tests:

- existing macro/function argument behavior is unchanged while inherited
  callables use their temporary Step 4 mapper
- instance creation loads/finalizes exactly once and executes no constructor
  code
- `InheritanceInstance.create(...)` does not invoke `__constructor__`
- `instance.invoke(...)` invokes through `runtimeState.methods[name]`
- standalone direct-render constructors, component constructors, and
  `component.someMethod(...)` link their invocation buffers directly to the
  instance shared/root buffer
- `this.method(...)` calls the same finalized entry as
  `instance.invoke(...)`
- internal `this.method(...)` calls link their invocation buffers to the
  current invocation buffer
- positional arguments bind by signature order
- script keyword arguments follow the same behavior as regular function calls
- template named placement bindings are converted to ordinary invocation
  arguments before invocation
- `super()` invokes the finalized parent entry and does not look up by name
- no-argument `super()` passes no arguments
- explicit `super(...)` builds an argument frame for the parent signature
- explicit `super(arg)` evaluates the current local argument value
- argument reassignment mutates only the local argument chain for that call
- `this.method(...)` inside another method uses the current invocation buffer
- `super()` uses the parent owner metadata and the same instance context
- inherited script method with `return` returns a value to `this.method(...)`
- inherited script method without `return` follows ordinary unset/null return
  behavior
- `super()` receives the parent method return value
- ignored `super()` return does not affect the caller's return value
- invocation links only finalized merged footprints
- missing method metadata at invocation is a fatal structural error
- script `this.name(...)` calls an inherited method when `name` is an inherited method
- script bare `this.name` for an inherited method fails clearly
- script shared name vs inherited method name ambiguity fails clearly
- unknown script `this.name` fails clearly
- template `this.name(...)` calls an inherited callable
- constructor-specific handling uses `RuntimeMethodEntry.isConstructor`, not a
  method-name string comparison

### Step 5: Direct Render And Template Lifecycle

Authoritative sections:

- Phase 4: Direct Render Completion
- Compile-Time Shape Vs Runtime Values
- Constructor Method Entry
- Template Lifecycle
- Script Lifecycle
- Returns
- Dynamic Extends
- Shared State
- Finalization Errors

Goal:

- public `root` becomes a thin lifecycle orchestrator
- generated participant `root` passes the compiled template/script object
  itself as `entryTemplateOrScript`
- direct render uses create instance -> invoke `__constructor__` -> finish
- direct render uses the same `InheritanceInstance.create(...)` path as
  components; Step 6 owns component-specific operation scheduling and close
  timing
- direct template render finishes the root buffer and returns the text snapshot
- direct script render returns the result of the entry `__constructor__`
  invocation
- no lifecycle mode flags are needed for direct rendering
- no `props.root`/`props.rootFunction` fallback is introduced
- template constructor chain executes through implicit trailing `super()`
- selected concrete template constructor bodies are ordinary `__constructor__`
  implementations
- no parent template/script executes during loading
- inline block placement is a compile-time structural-template behavior
- templates with `extends` define block overrides but do not place inline block
  output
- templates without `extends` may place inline block output
- static/dynamic runtime suppression branches are not used
- dynamic extends integration uses the `LoadedInheritanceChain` produced by the
  loader
- generated code uses no per-block parent-decision promises

Tests:

- generated participant root source calls `renderInheritanceParticipantRoot(...)`
  and does not duplicate load/finalize/shared-buffer/setup/constructor/finish
  lifecycle logic
- generated participant root passes the compiled template/script object as the
  entry object; it does not fall back between `root` and `rootFunction`
- standalone template output matches the public template contract
- standalone script return rules match the public script contract
- inherited direct template render matches non-inheritance text output behavior
- inherited direct script render returns explicit constructor return values
- `finishRender(...)` does not reload, re-finalize, or rerun constructors
- child constructor `return super()` forwards the parent constructor result
- parent constructor return alone does not override the child direct-render
  result
- thrown constructor errors follow ordinary render error behavior
- child/mid/root concrete constructor bodies run through the `super()` chain
- script with no concrete constructor body dispatches to the nearest ancestor
  constructor
- script with a concrete constructor body runs parent constructors only through
  explicit `super()`
- constructor writes are visible according to shared/chain rules
- inline block placement observes constructor writes from selected concrete
  constructor bodies
- structural template renders text before and after inline blocks
- structural template places inline blocks inside loops and conditionals
- non-extending template owns document text and places inline blocks
- extending template root-level text does not place output directly
- extending child/mid templates define block overrides without placing them
- templates have no `extends none`/dynamic-null fallback path
- extending template block override receives named placement arguments
- named binding expressions are emitted only for structural inline placements
- template `this.sharedName` reads and writes inherited shared vars from blocks
- parent/child template shared writes follow constructor order: child template
  constructor writes run before the implicit parent `super()`, and parent
  constructor writes may overwrite them
- template constructor `super()` analysis and metadata, including implicit
  trailing `super()`, is finalized with the template lifecycle implementation
- script explicit `shared var` reads and writes through `this.sharedName`
- script shared default slots are selected child-to-parent by the first
  declaration with an initializer, and an unselected parent default expression
  is not evaluated
- `this.__text__` remains the reserved inherited template text-chain
  exception
- shared-chain linking is exact-footprint based, with no whole-schema setup
  linking
- every selected parent constructor/block sees the same instance context as the
  entry
- value-consumption failures inside constructors/callables follow ordinary
  Cascada poison/error behavior
- lifecycle and metadata failures are fatal structural errors, not poison
- dynamic parent selection can choose between multiple parent templates/scripts
- dynamic parent selected at runtime runs the selected parent constructor chain
- dynamic parent load failure propagates through public render
- script dynamic null runs only the entry constructor
- template dynamic null fails through the public render API
- dynamic selection errors propagate through render

### Step 6: Components On The New Lifecycle

Authoritative sections:

- Phase 5: Component Lifetime
- Components
- Inheritance Instance API
- Load And Runtime Shapes
- File Ownership

Goal:

- component creation uses create instance -> invoke `__constructor__`
- component root buffers close by component lifetime
- component code uses `InheritanceInstance` rather than a special render mode
- component default context is isolated from the caller render context
- component `with context` opts into caller-context visibility
- explicit component payload is visible to the whole selected inheritance chain

Tests:

- component constructor invocation before later method call
- component with inheritance
- component dynamic `extends` selects a parent from explicit component payload
- component with template target
- independent component instances do not share shared state
- component method call after constructor observes initialized shared state
- component payload key and inherited shared var with the same name remain
  separate storage
- component `with context, name` and `with context, { key: expr }` use the
  shared composition-input grammar
- component method calls and observations preserve owner-buffer source order
- observing an unknown component shared chain reports a clear error
- observing a private `_` shared name through the component binding fails
  clearly
- non-`var` component shared chain observation requires an explicit
  snapshot/error operation
- component shared observation remains separate from inherited method calls;
  observing shared state does not invoke component methods
- owner side-chain final snapshot closes component root/shared buffers
- explicit close rejects later operations
- explicit close is idempotent or errors by an explicitly documented rule
- constructor initialization failure records instance failure and closes buffer
- constructor initialization failure blocks later component operations
  predictably
- component operation sites are collected by component analysis rather than by
  a later root tree scan

### Step 7: Include Renders Inheritance Participants

Authoritative sections:

- Phase 4: Direct Render Lifecycle
- Composition Payload And Context
- Inheritance Instance API
- File Ownership

Goal:

- `include` remains the template surface for "render this template here"
- including a plain template keeps the existing include behavior
- including an inheritance participant loads/finalizes the selected chain,
  creates an `InheritanceInstance`, invokes `__constructor__`, finishes the
  instance render, and inserts the resulting text at the include position
- include is render composition, not component composition: it does not create
  a component binding, expose component methods, or expose component shared
  observation through a caller-side name
- include context and payload rules remain include-owned; `component` keeps its
  explicit stateful-instance semantics
- template `component ... as name` is not introduced as an include replacement

Tests:

- `{% include "plain.njk" %}` continues to render ordinary templates exactly
  as before
- `{% include "child.njk" %}` renders an extending template through the
  selected constructor chain and inserts the final text at the include site
- include of an extending template preserves source-order output around the
  include tag
- include of an extending template inside a limited-concurrency loop waits for
  include completion before the loop slot is released
- include of a dynamic-extending template resolves parent selection with the
  include context/payload rules
- include load/finalization failures preserve include-site source context
- include execution failures from the participant constructor/render path
  preserve include-site source context
- included inheritance participants do not expose component bindings, component
  method calls, or caller-side shared observation
- nested includes of inheritance participants do not share instance state unless
  ordinary include/context rules explicitly pass shared values

Deferred from Step 6:

- include remains the only planned way to render an inheritance participant
  template inside another template; `component` remains stateful script-facing
  binding semantics and does not become a drop-in include replacement.

### Step 8: Cleanup, Fixtures, And Test Migration

Authoritative sections:

- Implementation Plan testing policy
- File Ownership
- Compiled Template/Script Shape
- Acceptance Criteria

Goal:

- remove inheritance lifecycle mode flags from generated roots
- update generated-source tests and browser precompiled fixtures
- update docs to name this design as authoritative
- migrate or delete Step 8-focused provisional unit/synthetic tests that are
  now covered by integration tests
- deduplicate macro and inherited-callable argument-frame mapping once both
  paths have settled on the same keyword/positional behavior
- triage skipped inheritance tests as deleted, rewritten, or still required;
  legacy suites outside the Step 8 focused gate remain a separate full-suite
  reconciliation pass
- verify compiler-private runtime helpers do not look like public API
- map internal `$` shared-storage names back to user-facing `this.name` or
  `name` in diagnostics, snapshots, and docs where the storage key is not the
  thing being tested
- delete or move remaining sync inheritance compiler methods from the clean
  async inheritance module; the sync compiler continues to use the Nunjucks
  inheritance path and is outside this rebuild
- evaluate splitting inheritance-specific generated-source emission into an
  `InheritanceEmit` helper owned by `CompileInheritance`; do this only if the
  boundary is pure emission and reduces coupling
- document or type the `RuntimeFatalError` constructor overload that accepts an
  error-context object as its second argument, so the parameter name does not
  imply that only a raw line number is valid
- keep `applyWithResolvedComponentInstance` private to component commands; it
  resolves a promise-backed component side-chain target and caches the
  resolved instance
- replace the include participant callback-to-promise bridge with a cleaner
  promise-returning participant include/root API; the current bridge should
  only forward the participant result or rejection and should not re-contextualize
  participant errors as include-site errors
- replace constructor-emitted shared default claims with finalized-schema-driven
  default initialization if that can be done without changing source-order
  semantics
- keep the source-order declaration-log work in
  `docs/code/source-order-declarations.md` as a separate compiler correctness
  pass; Step 8 should only remove temporary inheritance assumptions that become
  unnecessary after that pass exists
- keep async exports as ordinary Cascada promise values: exported chain
  snapshots are bound when the export is declared, root completion must not
  await or "resolve" exports, and consumers remain responsible for awaiting at
  the point of use

Tests:

- generated-source tests proving inheritance participants use the target ABI
  and plain templates/scripts do not emit inheritance ABI
- no `startup.js` or old lifecycle-mode helper remains unless the file/helper
  is renamed and justified by this design
- tests do not depend on private command-buffer/chain fields
- generated browser/precompiled fixtures contain the `root` ABI when produced
  by `scripts/runprecompile.js`; the checked-in source of truth is the compiler
  output because `tests/browser/precompiled-templates.js` is ignored
- Step 8-focused provisional loader/finalization/invocation unit tests are
  either promoted to integration tests, retained with an invariant-specific
  reason, or deleted
- Step 8-focused tests that still construct removed legacy component objects
  are migrated to real `InheritanceInstance` component fixtures or deleted if
  they cover only obsolete APIs
- generated-source tests distinguish deliberate internal `$` storage-name
  assertions from user-facing diagnostics
- no skipped inheritance test group in the Step 8 focused suites remains
  without an explicit disposition
- `src/compiler/inheritance.js` contains only clean async inheritance compiler
  code, or any retained sync bridge has an explicit non-inheritance-module home
- focused inheritance suites pass
- focused inheritance/component/precompiled suites pass; full `npm run
  test:quick` remains the broader integration gate after stale sync, legacy
  inheritance, and macro-suite expectations are reconciled

## Acceptance Criteria

- Loading never executes user constructor code.
- Finalization never calls compiled user functions.
- Public execution is linear and explainable as create instance -> invoke
  `__constructor__` -> finish.
- Constructorless children dispatch to the nearest inherited concrete
  `__constructor__`; concrete script constructors call parent constructors only
  through explicit `super()`.
- Ordinary templates/scripts that do not participate in inheritance emit no
  inheritance ABI or runtime helper calls.
- Selected concrete template constructor bodies can run child-to-parent through
  the normal `super()` chain.
- Inline block placement is controlled only by compile-time structural template
  role.
- A template with block declarations and no `extends` is the structural
  root/base template.
- Template `extends` always selects a parent template; `extends none` and
  dynamic-null parent selection are script-only.
- `extends ... with ...` is not part of the inheritance surface.
- Dynamic extends resolves once before constructor execution.
- Dynamic extends target expressions read only inputs available before
  constructor execution; they cannot read shared declarations, and later local
  declarations do not shadow ambient names by the source-order declaration
  lookup rule.
- Dynamic template extends is allowed only as a top-level declaration, with no
  template code before it; `{% set this.name = ... %}` before `extends` is not
  a default and remains forbidden.
- Script `extends` appears before constructor statements; only root-scope
  shared declarations, whitespace, and comments may precede it.
- Script shared default slots are selected child-to-parent by the first
  declaration with an initializer; declarations without initializers do not
  block parent defaults.
- Template block and script method `with context` syntax is absent; component
  `with context` remains the explicit context opt-in for components.
- Inherited methods and template blocks read instance context by default.
- Named template block placement bindings work only as placement arguments, not
  as a separate signature mode.
- Components close through `InheritanceInstance.close()`.
- Component `with` uses the standard composition-input grammar, while
  `extends` has no `with` form.
- Component shared names starting with `_` are private to component
  implementation code and cannot be observed through the component binding.
- Compiled inheritance participants do not accept lifecycle mode flags.
- Runtime method entries are pruned to execution-time fields.
- Independent recoverable finalization errors are collected or explicitly
  documented as immediate fatal.
- Compiler ABI metadata violations fail loudly instead of being silently
  repaired.
- Shared-schema conflict diagnostics retain declaration-origin quality during
  finalization.
- Inheritance runtime code uses public chain/buffer APIs rather than private
  chain fields.
- Public feature behavior remains where it does not contradict the
  lifecycle contract.
