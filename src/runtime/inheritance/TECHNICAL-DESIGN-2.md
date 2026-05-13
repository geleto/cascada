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

## Non-Negotiable Lifecycle

Each phase has a single owner and a bounded contract.

### Phase 1: Load

Input:

- entry compiled template/script
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

`context` is the entry execution context with the entry composition payload
already applied. Payloads for parent/owner entries remain on finalized method
owner metadata and are applied when invoking that owner's callable.

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
- link exactly the channels needed by the callable
- declare and initialize shared channels as method code requires
- call `super()` through finalized owner-relative links

The constructor is just the `__constructor__` method. Direct rendering and
component creation start by invoking that method once. The runtime does not
manually iterate the parent chain to execute constructors. Parent constructor
execution happens only when the constructor body calls `super()`, exactly like
any other inherited method.

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

### Phase 4: Direct Render Completion

Input:

- `InheritanceInstance`
- result returned by `instance.invoke("__constructor__", ...)`

Output:

- final template text or direct script result

Templates:

- No additional template user code runs in this phase.
- Template structure was already produced by executing constructors in Phase 3.
- This phase uses the same completion rule as ordinary async template roots:
  finish the root output buffer and materialize the root text channel's final
  snapshot.

Scripts:

- No additional script user code runs in this phase.
- This phase finishes the root output buffer.
- Direct script render returns the `entryResult` produced by invoking
  `runtimeState.methods.__constructor__`.
- Do not invent an inheritance-specific return path.
- For templates, `finishRender(entryResult)` ignores `entryResult` for output
  purposes and returns the text-channel snapshot.

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
- owner side-channel / binding lifetime

Output:

- initialized component instance exposed to the owner binding
- finished component root/shared buffers after close or side-channel completion

Component instances use the same load/finalize/constructor lifecycle. Their
root buffer remains open for the component binding lifetime and closes when the
owner binding completes or the instance is explicitly closed.

Components are not a different compiled template/script mode. A direct render and a
component instance both initialize the same inheritance instance shape and invoke
the same `__constructor__` method through the same runtime dispatch path. The
only difference is ownership of buffer completion:

- direct render finishes the instance root/shared buffers after constructor
  execution and result materialization via `finishRender(entryResult)`
- component creation binds the instance to the caller's component
  side-channel, treats constructor completion as initialization, and finishes
  the instance root/shared buffers via `close()` only when that side-channel's
  final snapshot settles or the component is explicitly closed

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
  rootFunction,             // public render entry
  inheritanceSpec,          // raw compiler metadata; no executable side effects
  resolveInheritanceParent  // local immediate-parent resolver
}
```

`rootFunction` is the public render entry and a thin orchestrator over the
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
- shared schema inputs and inferred template shared names
- which syntax is legal

Runtime decides:

- actual dynamic parent value for participant files with `extends`
- actual `extends ... with ...` payload values
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
participant still exposes the same `{ rootFunction, inheritanceSpec,
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
  sharedSchema: Record<string, SharedSchemaInput>,
  hasExtends: boolean
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
async function resolveInheritanceParent(env, context, runtime, origin)
```

It evaluates only the current template/script's immediate `extends` selection
and returns:

```js
{
  parentTemplateOrScript: Template | Script | null,
  compositionPayload: object | null,
  origin: SourceOrigin | null
}
```

`parentTemplateOrScript` is the selected parent compiled template/script
object. The loader reads its `inheritanceSpec` and
`resolveInheritanceParent`; it must not execute its public `rootFunction`
during loading.

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

- variables created by top-level `{% set %}` / script `var` in the same
  template/script
- inferred shared vars from `this.<name>` usage in the current template
- shared channels declared or created by the current script constructor
- command-buffer state
- any source-ordered value that would require constructor execution

The compiler enforces this during analysis. Unsupported expressions fail
clearly instead of falling back to parent-render loading.

Payload values are evaluated only after the parent target resolves to a real
parent. For scripts, if dynamic `extends` resolves to `none`/`null`, payload
expressions are not evaluated. For templates, resolving to no parent is a load
error.

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
- owner context comes from the finalized `RuntimeMethodEntry`
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
  templateOrScript: Template | Script,
  spec: CompiledInheritanceSpec,
  path: string | null,
  compositionPayload: object | null,
  origin: SourceOrigin | null
}

type InheritanceRuntimeState = {
  methods: Record<string, RuntimeMethodEntry>,
  sharedSchema: Record<string, string>
}

type RuntimeOwnerEntry = {
  templateOrScript: Template | Script,
  path: string | null,
  compositionPayload: object | null,
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
  entryTemplateOrScript,
  env,
  context,
  runtime,
  output,
  ownerBuffer
})
```

The exact option names may change, but `create(...)` must:

1. create or select the root output buffer
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

Direct template/script rendering creates an instance, invokes `__constructor__`,
then calls `finishRender(entryResult)`. Component creation creates an instance,
schedules the same `__constructor__` method call in component command order,
and calls `close()` only when the component lifetime ends.

The loaded chain is the source of truth during loading/finalization. Do not
store derived aliases for the entry template/script, parent-exists boolean, or
template structure owner. Finalization must copy the execution facts a callable
needs onto its `RuntimeMethodEntry` and `ownerEntry`; execution must not inspect
the loaded chain to recover them.

- entry template/script: `loadedChain.entries[0].templateOrScript`
- selected parent exists: `loadedChain.entries.length > 1`
- template structure owner, for template chains: the topmost selected template,
  `loadedChain.entries[loadedChain.entries.length - 1]`

`compositionPayload` on `LoadedInheritanceEntry` is the payload selected by the
child hop that leads to that entry. Store payload data, not pre-forked contexts.
Execution forks a context for each entry when that entry runs.

## Composition Payload, Argument Frames, And Shared Channels

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

Invocation arguments are a different mechanism. A call such as
`this.card(user, size = "lg")` or `super(user)` creates an argument frame for
one callable invocation. Argument frames are per-call local bindings, not
composition payload, not inherited shared channels, and not entries in the
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
arguments hierarchy channels.

Async macros are the precedent: macro parameters are local `var` channels in
the macro invocation buffer, initialized from call arguments. Inherited
callables should use the same model. Argument names become local `var` bindings
inside the invocation buffer. Reassigning an argument mutates only that local
call frame; it does not mutate the caller's variable, composition payload, or
shared state.

Keep the original argument frame separate from mutable local argument channels.
No-argument `super()` forwards the original frame exactly as received by the
current callable. Explicit `super(user)` or `super(name = value)` evaluates the
current local values and builds a fresh argument frame for the parent callable.

Reuse boundary:

- share low-level argument-frame mapping and local-argument-channel binding
  primitives with async macro/function compilation
- use that shared primitive for every callable argument surface:
  `instance.invoke(...)`, compiled `this.method(...)`, compiled
  `this.blockName(...)`, compiled `super(...)`, and structural inline block
  placement arguments
- keep macro wrappers, `caller()` support, macro text-return behavior, imports,
  and context-isolation rules out of inheritance dispatch
- keep inherited invocation in `invoke.js`; it consumes finalized dispatch
  entries, owner-relative `super` links, owner context, linked footprints, and
  invocation buffers, then calls the shared argument primitive rather than
  `runtime.makeMacro` or macro-specific compiler wrappers

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
  ownerEntry: RuntimeOwnerEntry,
  super: RuntimeMethodEntry | null,
  mergedLinkedChannels: string[],
  mergedMutatedChannels: string[]
}
```

Finalization-only fields such as `callsSuper`, `invokedMethodRefs`,
`superOrigin`, `ownLinkedChannels`, and `ownMutatedChannels` must not survive on
the long-lived execution entry. If a field survives, it must be justified as an
execution-time requirement.

`ownerEntry` is required for every runtime method entry. It tells invocation
which loaded owner entry owns the body, so context forking and composition
payload visibility are owner-relative without scanning unrelated state at
execution time. `ownerEntry.isStructuralTemplate` is true only for a
non-extending template owner that places document structure.

## Invocation And Linking

Inherited callable invocation starts from finalized direct metadata.

Rules:

- ordinary `this.name(...)` dispatch performs one direct table read:
  `runtimeState.methods[name]`
- `super()` reads `methodData.super` from the executing callable's runtime
  entry
- constructor execution is ordinary inherited dispatch to `__constructor__`
- invocation creates an invocation child buffer at the call site
- the invocation child buffer links exactly the target's
  `mergedLinkedChannels` and `mergedMutatedChannels`
- callable entry prologue may validate `methodData`, but it must not resolve
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

### Call Paths

`instance.invoke(methodName, args, origin)` is the external method execution
surface. It performs a direct lookup in the already-finalized dispatch table:
`instance.runtimeState.methods[methodName]`. That entry is already the
most-derived implementation. Invocation then builds the argument frame from
positional or named arguments, creates an invocation buffer under
`instance.rootBuffer`, links the target's exact merged footprints, and calls the
target `fn` with the instance environment, owner context, runtime/callback,
invocation buffer, argument frame, and method data.

Compiled `this.name(...)` calls use the same path as `instance.invoke(...)`
except their call-site buffer is the currently executing invocation buffer. They
always dispatch through the same finalized table entry:

```js
runtime.invokeInheritedCallable(currentInstance, "name", args, origin)
```

Compiled `super(...)` calls do not resolve by name. They receive the executing
method's `methodData`, read `methodData.super`, and invoke that exact parent
entry:

```js
runtime.invokeSuperCallable(currentInstance, methodData, args, origin)
```

Argument rules:

- positional calls map by the target signature's ordered `argNames`
- named calls map by argument name and reject unknown names
- mixed positional/named calls fail before invocation
- `super()` forwards the original argument frame when called with no
  arguments
- `super(args...)` or `super(name = value)` builds a fresh argument frame
  against the parent target's signature

Owner context rules:

- every runtime method entry uses its finalized `ownerEntry` to fork the owner
  context with that entry's composition payload
- parent constructors or methods reached through `super()` therefore run with
  the parent owner's context and composition payload, without a runtime chain
  scan

## File Ownership

The runtime should be rebuilt around these lifecycle ownership boundaries.
Filenames may match prior names, but each file should be created because it owns
one clear phase or primitive in this design, not because an earlier runtime file
existed.

- `load.js`: selected-chain discovery, cycle detection, raw spec registration,
  selected-chain construction
- `instance.js`: `InheritanceInstance` lifecycle owner: `create(...)`,
  `invoke(...)`, `finishRender(...)`, `close()`, closed-state checks, buffer
  ownership, and direct render completion
- `finalize.js`: metadata validation, method-table construction, super wiring,
  shared-schema finalization, footprint merging, runtime-entry pruning
- `invoke.js`: inherited callable invocation, `super()`, argument frames,
  invocation-buffer admission
- shared argument helper module or existing macro helper extraction:
  argument-frame mapping and local `var` channel initialization reused by macros
  and inheritance callables
- `shared.js`: shared schema/runtime operations and shared-root buffer access
- `component.js`: component instance lifecycle, command-based operations,
  explicit shared observation, and owner side-channel lifetime wiring around
  `InheritanceInstance`
- `index.js`: explicit compiler-private runtime exports

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
await runtime.invokeInheritedCallable(
  instance.runtimeState,
  "__constructor__",
  [],
  instance.context,
  env,
  runtime,
  cb,
  instance.rootBuffer,
  constructorOrigin
);
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
parent constructor with the parent owner's entry context.

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
- ancestor script constructors run only when reached through explicit
  `super()` calls

Script/template constructor signatures may differ only when required by real
script/template semantics.

## Returns

Return semantics stay explicit:

- `extends` is not a value-producing expression
- `return` is supported in script constructors and inherited script methods
- method returns use the normal `__return__` channel / unset-sentinel machinery
- `this.method(...)` receives the called method's return value
- `super()` receives the parent method or parent constructor return value
- direct-render scripts return the result of the entry `__constructor__`
  invocation
- ancestor constructor returns are ignored as direct-render results except as
  values observed by an explicit `super()` call and then explicitly returned by
  the entry constructor
- template rendering returns the final text output
- template block output is text-channel output; script-style `return` is not
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
- templates may not use `extends none`, and dynamic template `extends` must not
  resolve to `null`/`undefined`; a template with `extends` must select a parent
  template.
- payload expressions are skipped only for script no-parent selection.
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

Block placement does not wait on a per-block parent-decision promise. Parent
selection is completed during loading before any constructor runs.

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

Components wrap an `InheritanceInstance` with caller-side command ordering and
side-channel lifetime ownership. Component creation publishes the initialized
instance through the owner binding; component close calls `instance.close()`.

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
  hasDynamicExtends: boolean,
  localExtendsNode: ExtendsNode | null,
  methodEntries: CompiledMethodEntryInput[],
  sharedSchemaInputs: SharedSchemaInput[],
  inferredTemplateSharedNames: InferredSharedName[],
  componentOperations: ComponentOperationSite[],
  componentSharedObservations: ComponentSharedObservationSite[]
}
```

`participates` is the only codegen gate for emitting inheritance ABI. It must
be computed during analysis and must be exact. It is true when the file uses an
inheritance surface: `extends`, inherited method/block declarations, inherited
calls, `super()`, script shared declarations, template shared `this.<name>`
inference, or component-specific inheritance constructs. It is false for every
ordinary template/script, including ordinary templates that contain no blocks,
no `extends`, no `this.<name>` shared access, and no inherited calls.

`hasExtends`, `hasDynamicExtends`, and `localExtendsNode` are required for
resolver generation and validation. `methodEntries` carry callable signatures,
source origins, callable-local `super` references, callable-local ordinary
inherited call references, and callable-local linked/mutated channel footprints.
`sharedSchemaInputs` and `inferredTemplateSharedNames` feed shared-schema
finalization. Component operation collections feed component code generation.

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

Goal:

- remove template block `with ...`, `with context`, and `without context`
  syntax
- remove script method `with context` syntax
- remove template `extends none`
- keep script `extends none` and dynamic-null no-parent selection script-only
- support script `return` in inherited constructors and methods through the
  normal script return machinery
- copy the latest `docs/cascada/script.md` and `docs/cascada/template.md`
  language-surface documentation into the clean branch

Tests:

- parser rejects block `with`, `with context`, and `without context`
- script transpiler/parser rejects `method ... with context`
- template `extends none` fails
- script `extends none` is accepted only in script mode
- inherited script method with `return` returns a value to `this.method(...)`
- inherited script method without `return` follows ordinary unset/null return
  behavior
- child constructor `return super()` forwards the parent constructor result for
  direct script render
- parent constructor `return` alone does not override the child direct-render
  result
- ignored `super()` return does not affect the caller's return value

### Step 0b: Analysis And Validation

Goal:

- make render-context names visible by default inside inherited methods and
  template blocks
- make callable signatures consist only of ordered argument names
- support template block placement arguments, including named placement
  bindings such as `{% block item(user = selectedUser) %}`
- reject mixed positional/named block placement bindings
- reject all template channel declarations, including `shared var`
- allow each template to use a top-level dynamic `extends`
- reject dynamic template `extends` nested inside runtime control flow
- reject dynamic template `extends` resolving to no parent at runtime
- reject any template declaration before `extends`
- reject `extends` target/payload expressions that read inferred shared vars or
  other constructor-created locals/channels
- compute exact inheritance participation facts

Tests:

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
- `super()` receives the parent method return value
- each participation reason sets analysis `participates`: `extends`, template
  block declaration, script method declaration, `this.method(...)`, `super()`,
  script `shared`, template `this.sharedName`, and component operation or
  observation
- ordinary templates/scripts do not participate, including ordinary files with
  `{% set %}` / script locals, loops, includes, conditions, and local functions

### Step 1: Compiled Shape And ABI

Goal:

- freeze the final compiled inheritance ABI before runtime implementation
- analysis decides whether a file participates in inheritance
- plain non-participating templates/scripts do not emit inheritance ABI
- participating templates/scripts expose the final `{ rootFunction, inheritanceSpec,
  resolveInheritanceParent }` shape
- constructor code is exposed only as the `__constructor__` method entry inside
  `inheritanceSpec.methodEntries`
- `inheritanceSpec` is data-only and contains no executable setup function
- generated `rootFunction` functions contain no lifecycle mode flags
- generated inheritance code uses only the target lifecycle helpers

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
- `inheritanceSpec.methodEntries.__constructor__` exists for templates/scripts
  and has the ordinary callable entry shape
- emitted `inheritanceSpec` has no callable setup properties

### Step 2: Metadata Loader

Goal:

- runtime `loadInheritanceChain(...)` loads metadata child-to-parent
- no user constructor executes during loading
- `LoadedInheritanceChain` is built
- loader treats `LoadedInheritanceChain` as an immutable value and does not
  mutate reusable state

Tests:

- static three-level template chain loads specs without executing constructor code
- static script chain loads specs without executing constructor code
- static inheritance cycles fail during loading with useful source context
- dynamic inheritance cycles fail during loading with useful source context
- parent load failures preserve source/error context
- dynamic parent selection resolves once
- script `extends none` and dynamic null produce no selected parent entry
- script dynamic-null skips payload evaluation
- `extends ... with ...` payload is stored on the selected parent entry
- multi-level payloads are stored per hop and are not merged globally
- dynamic template `extends` resolving to null/undefined fails before
  constructor execution
- dynamic template null failure ordering is clear and does not execute
  constructor code
- constructor-local dynamic extends/payload expressions fail clearly
- loading can be unit-tested without `CommandBuffer`
- loading returns an immutable chain value rather than mutating reusable state

### Step 3: Finalization And Runtime Shape

Goal:

- runtime finalization consumes `LoadedInheritanceChain`
- finalization produces `InheritanceRuntimeState`
- `runtimeState.methods[name]` maps directly to the most-derived executable
  entry
- `RuntimeMethodEntry.super` is wired to the exact parent entry or `null`
- every runtime method entry has finalized `ownerEntry`
- shared schema is finalized before execution
- runtime method entries are pruned to execution-time fields
- recoverable metadata errors are collected where practical

Tests:

- static child/mid/root chain finalizes into one dispatch table
- ordinary callable names point at most-derived runtime entries
- overridden parent entries remain reachable through `RuntimeMethodEntry.super`
- `super()` links point at exact parent runtime entries without name lookup
- `super()` links skip no unrelated entries and point only to the exact parent
  implementation for that callable name
- missing `super()` targets fail during finalization
- no-op topmost constructor entry is wired where constructor `super()` allows it
- signature conflicts, missing invoked method refs, shared/method collisions,
  and shared schema conflicts are reported with useful origins
- at least two independent recoverable metadata errors are collected from one
  chain when practical
- shared/method collisions are reported across files as well as within one file
- merged channel footprints include all overridden entries in the super chain
- runtime method entries do not retain finalization-only fields
- owner entries carry template/script, payload, origin, and structural-template
  facts needed by invocation

### Step 4: InheritanceInstance And Invoke

Goal:

- extract argument-frame mapping and local `var` channel initialization from
  async macro/function invocation into a shared helper
- wire both macros/functions and inherited callables through that shared
  argument-binding helper
- implement `InheritanceInstance.create(...)`
- `create(...)` owns load + finalize + root/shared buffer setup
- `create(...)` returns a ready-to-invoke instance and does not invoke methods
- implement `instance.invoke(methodName, args, origin)`
- constructor invocation is ordinary `instance.invoke("__constructor__", [],
  origin)`
- compiled `this.method(...)` and `this.blockName(...)` consume the finalized
  dispatch table
- compiled `super(...)` consumes `methodData.super`
- invocation uses the shared argument-frame/local-argument binding primitive
- wire compiler-private inheritance runtime helpers onto the runtime object used
  by generated code

Tests:

- existing macro/function argument behavior is unchanged after helper extraction
- instance creation loads/finalizes exactly once and executes no constructor
  code
- `instance.invoke(...)` dispatches through `runtimeState.methods[name]`
- `this.method(...)` dispatches to the same finalized entry as
  `instance.invoke(...)`
- positional arguments bind by signature order
- named arguments bind by declared argument name
- mixed positional/named arguments are rejected
- unknown named arguments are rejected
- `super()` invokes the finalized parent entry and does not look up by name
- no-argument `super()` forwards the original argument frame
- explicit `super(...)` builds a fresh argument frame for the parent signature
- explicit `super(arg)` evaluates the current local argument value
- argument reassignment mutates only the local argument channel for that call
- `this.method(...)` inside another method uses the current invocation buffer
- `super()` uses the parent owner context and composition payload
- invocation links only finalized merged footprints
- missing method metadata at invocation is a fatal structural error

### Step 5: Direct Render And Template Lifecycle

Goal:

- public `rootFunction` becomes a thin lifecycle orchestrator
- direct render uses create instance -> invoke `__constructor__` -> finish
- direct render uses the same `InheritanceInstance.create(...)` path as
  components
- direct template render finishes the root buffer and returns the text snapshot
- direct script render returns the result of the entry `__constructor__`
  invocation
- no lifecycle mode flags are needed for direct rendering
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

- standalone template output matches the public template contract
- standalone script return rules match the public script contract
- inherited direct template render matches non-inheritance text output behavior
- inherited direct script render returns explicit constructor return values
- child constructor `return super()` forwards the parent constructor result
- parent constructor return alone does not override the child direct-render
  result
- thrown constructor errors follow ordinary render error behavior
- child/mid/root concrete constructor bodies run through the `super()` chain
- constructor writes are visible according to shared/channel rules
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
- dynamic parent selection can choose between multiple parent templates/scripts
- dynamic parent selected at runtime runs the selected parent constructor chain
- dynamic parent load failure propagates through public render
- script dynamic null runs only the entry constructor
- template dynamic null fails through the public render API
- dynamic selection errors propagate through render

### Step 6: Components On The New Lifecycle

Goal:

- component creation uses create instance -> invoke `__constructor__`
- component root buffers close by component lifetime
- component code uses `InheritanceInstance` rather than a special render mode

Tests:

- component constructor invocation before later method call
- component with inheritance
- component with template target
- independent component instances do not share shared state
- component method call after constructor observes initialized shared state
- observing an unknown component shared channel reports a clear error
- non-`var` component shared channel observation requires an explicit
  snapshot/error operation
- owner side-channel final snapshot closes component root/shared buffers
- explicit close rejects later operations
- explicit close is idempotent or errors by an explicitly documented rule
- constructor initialization failure records instance failure and closes buffer

### Step 7: Cleanup, Fixtures, And Test Migration

Goal:

- remove inheritance lifecycle mode flags from generated roots
- update generated-source tests and browser precompiled fixtures
- update docs to name this design as authoritative
- migrate or delete provisional unit/synthetic tests that are now covered by
  integration tests
- triage skipped inheritance tests as deleted, rewritten, or still required
- verify compiler-private runtime helpers do not look like public API

Tests:

- generated-source tests proving inheritance participants use the target ABI
  and plain templates/scripts do not emit inheritance ABI
- no `startup.js` or old lifecycle-mode helper remains unless the file/helper
  is renamed and justified by this design
- tests do not depend on private command-buffer/channel fields
- browser/precompiled fixtures contain the `rootFunction` ABI
- browser/precompiled fixtures regenerated from target compiler output
- provisional loader/finalization/invocation unit tests are either promoted to
  integration tests, retained with an invariant-specific reason, or deleted
- no skipped inheritance test group remains without an explicit disposition
- focused inheritance suites pass
- full `npm run test:quick` at the final integration gate

## Acceptance Criteria

- Loading never executes user constructor code.
- Finalization never calls compiled user functions.
- Public execution is linear and explainable as create instance -> invoke
  `__constructor__` -> finish.
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
- Dynamic extends resolves once before constructor execution.
- Dynamic extends/payload expressions cannot read constructor locals/channels.
- Dynamic template extends is allowed only as a top-level declaration, with no
  template declarations before it.
- Template block and script method `with context` syntax is absent.
- Inherited methods and template blocks read render context by default.
- Named template block placement bindings work only as placement arguments, not
  as a separate signature mode.
- Components close through `InheritanceInstance.close()`.
- Compiled inheritance roots do not accept lifecycle mode flags.
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
