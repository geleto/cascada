# Inheritance Technical Design

## Goal

`src/runtime/inheritance/` is the final runtime implementation of async
inheritance, components, and shared state.

The current `src/runtime/inheritance-legacy/` implementation was experimental.
It proved the model by trying several concepts incrementally, but it is not the
shape to preserve.

We are willing to break the current inheritance runtime while building this.
Correctness will be protected by focused unit and integration tests instead of
compatibility with temporary implementation details.

The runtime should be small enough that each part has one job:

- collect compiled inheritance specs while loading the chain
- finalize the chain once
- invoke finalized methods
- manage shared channels
- wrap component lifecycle

No compatibility scaffolding is kept inside the core.

## Compiler ABI

The root compiler output contains `inheritanceSpec`.
Loading stores this object unchanged.

```js
{
  root,
  externSpec,
  inheritanceSpec: {
    setup,
    methodEntries,
    sharedSchema,
    invokedMethodRefs,
    hasExtends
  }
}
```

## Blocks And Methods

Template blocks and script methods share the runtime callable model.

Both compile into `CompiledMethodEntry` values under
`inheritanceSpec.methodEntries`, so
the runtime behavior is common:

- method entry finalization
- `super()` resolution
- `this.method(...)` calls from both blocks and methods
- invoked-method footprint merging
- admission and invocation-buffer creation
- argument arity checks
- inherited signatures
- shared-channel linking from finalized footprints

Only these differences should remain:

- script method bodies return through `__return__`
- template block bodies write template text and return the local `__text__`
  snapshot
- in root/no-extends templates, inline block syntax is both a declaration and
  an implicit placement call site
- extending-template blocks are override-only declarations
- dynamic `extends none` controls whether local fallback block placement runs
- block placement enqueues the returned block text on the current template text
  channel
- template blocks can read render-context names by default, but do not capture
  parent/placement local scope; placement-scope values must be passed as
  explicit block arguments

Do not add block-specific runtime metadata, block-specific dispatch,
block-specific text boundaries, or block-specific channel linking. Keep the
differences in the compiler/body adapter that lowers block syntax into normal
inherited method calls.

## Step 0 Surface Cleanup

This is already part of the branch surface before the new runtime work starts.

### Remove

- template block `with` / `with context` syntax
- block `withContext` metadata emission
- script method `with context` syntax
- method `withContext` metadata emission
- signature checks that compare context mode
- block tests and docs that expect opt-in render-context access
- method tests and docs that expect opt-in render-context access

### Modify

- inherited method and template block entries must read render context by
  default
- inherited callable signatures compare only argument names
- placement-local values still cross into blocks only through explicit block
  arguments

## Data Types

```js
// Compiler-generated method entry.
type CompiledMethodEntry = {
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string, // file/template that defined this method
  origin: SourceOrigin | null, // callable declaration site for diagnostics
  ownLinkedChannels: string[], // local body reads/observations
  ownMutatedChannels: string[], // local body mutations
  super: boolean, // true when the body calls super()
  superOrigin: SourceOrigin | null, // super() call site
  invokedMethodRefs: Record<string, InvokedMethodRef> // method name -> first call site, for error output when missing
}

// Compiler-generated reference to an inherited method call.
type InvokedMethodRef = {
  name: string,
  origin: SourceOrigin | null
}

// Runtime-created finalized method table entry.
type RuntimeMethodEntry = {
  name: string,
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string, // file/template that defined this method
  origin: SourceOrigin | null, // callable declaration site for diagnostics
  isConstructor: boolean, // true for the synthetic script constructor method
  super: RuntimeMethodEntry | null, // owner-relative parent method
  callsSuper: boolean, // true when the body calls super()
  invokedMethodRefs: Record<string, InvokedMethodRef>, // method name -> first call site
  mergedLinkedChannels: string[], // transitive reads/observations
  mergedMutatedChannels: string[] // transitive mutations
}

// Compiler-generated inheritance descriptor.
type CompiledInheritanceSpec = {
  setup: Function,
  methodEntries: Record<string, CompiledMethodEntry>, // method name -> compiled method
  sharedSchema: Record<string, string>, // channel name -> channel type
  invokedMethodRefs: Record<string, InvokedMethodRef>, // method name -> first call site
  hasExtends: boolean
}

// Runtime-created temporary child-to-parent chain loading state.
type LoadingState = {
  files: LoadedInheritanceFile[], // child, parent, grandparent, ...
  chainPaths: string[] // loaded file path stack for cycle detection
}

// Runtime-created loading entry that points to the unchanged compiler spec.
type LoadedInheritanceFile = {
  spec: CompiledInheritanceSpec,
  context: SourceOrigin | null
}

// Compiler-generated source location for diagnostics.
type SourceOrigin = {
  lineno: number,
  colno: number,
  errorContextString: string,
  path: string | null
}
```

Implementation files should document these shared data structures with compact
TypeScript-shaped comment blocks near the code that owns them. Copy the type
blocks from this document into the relevant implementation files as comments,
then keep them in sync when the data shape changes. Do this for runtime shapes,
not for every small function.

## Runtime Modules

```text
src/runtime/inheritance/
  TECHNICAL-DESIGN.md
  state.js
  load.js
  finalize.js
  invoke.js
  startup.js
  shared.js
  component.js
  index.js
```

### `state.js`

Owns per-render / per-component inheritance state.

```js
{
  methods: Record<string, RuntimeMethodEntry>, // method name -> finalized method
  sharedSchema: Record<string, string>, // shared channel name -> channel type
  sharedRootBuffer: CommandBuffer | null,
  compositionPayload: object | null,
  startupPromise: Promise<unknown> | null,
  finalized: boolean,
  failure: Error | null,
  loading: LoadingState | null
}
```

`finalized` is `true` after metadata finalization publishes execution method
data. `failure` is `null` unless finalization or startup has failed.
`loading` holds temporary chain-loading metadata and is cleared after
successful finalization.

Fields:

- `methods`: finalized execution method table. Empty until finalization.
- `sharedSchema`: finalized shared-channel schema. Empty until finalization.
- `sharedRootBuffer`: command buffer that owns hierarchy/component shared
  channels.
- `compositionPayload`: context-like payload from `extends ... with ...` or
  component construction.
- `startupPromise`: setup/constructor startup work for this instance, if any.
- `finalized`: whether metadata has been finalized successfully.
- `failure`: fatal metadata/startup failure for this instance.
- `loading`: temporary child-to-parent inheritance spec collection.

Avoid hidden symbol state unless a field must be non-enumerable for API
compatibility.

### `load.js`

Records compiler-emitted specs in child-first chain order.

Internal loading state:

```js
{
  files: [
    {
      spec, // compiler-emitted inheritanceSpec
      context
    }
  ],
  chainPaths
}
```

Loading collection is append-only. It must not wire `super`, mutate raw
entries, or create execution metadata.

Expected order is most-derived first, then parents in extends-chain order.

`load.js` owns append-only spec registration. Parent rendering updates
`chainPaths` while resolving the chain and uses it for cycle detection.

### `finalize.js`

Builds the final execution tables in one blocking pass.

Final execution method entry:

```js
{
  name, // method name
  fn, // compiled callable function
  signature, // finalized call signature
  ownerKey, // file/template identity
  origin, // callable declaration site for diagnostics
  isConstructor, // true for the synthetic script constructor method
  super, // parent execution method entry, or null
  callsSuper, // true when this body calls super()
  invokedMethodRefs, // ordinary inherited calls from this body
  mergedLinkedChannels, // full transitive channel reads/observations
  mergedMutatedChannels // full transitive channel mutations
}
```

Finalization steps:

1. Validate and merge shared schema.
2. Build method chains per name from collected files.
3. Resolve ordinary dispatch table to the most-derived method per name.
4. Resolve owner-relative `super` links.
5. Resolve ordinary inherited calls from per-method `invokedMethodRefs`.
6. Compute fixed-point merged channel footprints.
7. Publish `state.methods` and `state.sharedSchema`.
8. Drop loading data.
9. Set `state.finalized = true`.

Missing inherited methods, invalid `super()`, signature conflicts, shared name
conflicts, and shared/method name collisions are finalization errors.

Invoked-method cycles are allowed. Extends-chain cycles are not.

### `invoke.js`

Owns normal method execution.

Compiler-facing runtime ABI:

- `invokeInheritedCallable(...)`
- `invokeSuperCallable(...)`
- `getCallableLinkedChannels(...)`
- `getCallableMutatedChannels(...)`

Normal invocation assumes finalized direct method entries. If state is not
finalized, fail clearly at the boundary unless a specific startup path is
documented to wait.

One private admission primitive should handle:

- ordinary `this.method(...)`
- `super(...)`
- component method calls

Admission does:

1. resolve the direct execution method entry
2. validate arguments against signature
3. create the invocation buffer
4. link only `mergedLinkedChannels`
5. mark linked mutations from `mergedMutatedChannels`
6. enqueue one invocation command
7. return the command result promise

Method invocation must not inspect raw method fields.

### `startup.js`

Runs startup work after metadata is finalized.

Owned here:

- execute compiled setup/root startup functions
- render parent template roots after the chain decision is known
- attach child invocation buffers to parent buffers for linked channels
- store startup promises on the inheritance state

`startup.js` uses loaded/finalized inheritance state. It must not create runtime
method entries, merge shared schema, wire `super`, or mutate compiler-emitted
method metadata.

### `shared.js`

Owns shared channel schema and shared channel runtime operations.

Rules:

- shared declarations are explicit per file for scripts
- async templates may infer shared vars, plus `__text__` as shared text
- shared schema is type-only
- default initialization is source-ordered startup work, not schema metadata
- shared observation is always current-buffer based

Shared channel lookup must use finalized `state.sharedSchema`.

### `component.js`

Components are lifecycle wrappers around the same inheritance state.

Component state:

```js
{
  context,
  rootBuffer,
  inheritanceState,
  env,
  closed,
  startupError
}
```

Component method calls use the same invocation admission primitive as
`this.method(...)`.

Component shared observation remains a separate explicit operation because it
observes another instance's shared root.

## Runtime Lifecycle

Inheritance loading/finalization is blocking for metadata:

1. create state
2. register child spec
3. resolve and register parent specs
4. finalize metadata
5. run setup and constructor startup

Lifecycle:

1. Load the complete inheritance chain first. Dynamic parent expressions are
   resolved during this phase; `none` / `null` stops the chain.
2. Finalize metadata once after the full chain is known. This wires overrides,
   owner-relative `super`, invoked-callable references, shared schema, and
   merged footprints.
3. Run setup/constructor startup after finalization.
4. Render template block placement after the parent/no-parent decision is
   known. If the chain has a parent, inline child block placement is suppressed;
   if the chain has no parent, inline child block placement renders locally.

The finished implementation must keep these as separate compiler/runtime
phases. Parent root execution must not be the mechanism that discovers parent
metadata. The compiler output should expose three separate entry points:

- metadata loader: resolves `extends`, compiles parent roots, registers parent
  `inheritanceSpec` values, and records the selected structural root/context
- startup/constructor runner: executes shared declarations and local startup
  after finalization
- structure renderer: renders the selected root template structure after startup

The current implementation still has residual coupling here: `b___setup__`
contains both startup code and template structure rendering, and parent roots
are still executed in composition mode while the chain is being loaded. That
coupling must be removed before the runtime can fully match this lifecycle.
Do not add buffer-level late-link fallbacks to compensate for it.

Script constructor startup is not a special metadata model. It invokes the
finalized `__constructor__` method when present.

Script startup links the finalized shared schema into setup buffers because
setup can contain shared declarations, constructor loading, and parent-chain
startup before a per-constructor footprint exists. Normal callable invocation
still links from finalized callable footprints.

For scripts, executable body code after `extends` creates a local
`__constructor__`. That constructor must call `super()` explicitly if it wants
ancestor constructor startup to run. If a script has no executable body after
`extends`, it contributes no local constructor and inherited lookup runs the
nearest ancestor constructor directly.
Repeated bare `super()` statements in one constructor share the existing
lifted-super call result, so parent startup runs once.

Templates do not support startup/constructor `super()`. Code outside blocks is
local startup only. It runs after shared declarations and before parent
structure renders, so it can prepare shared channels used by inherited block
placement. Block `super()` remains the block-level parent call.

The topmost missing constructor is represented by a no-op constructor only for
constructor `super()` resolution.

Ancestor constructor return values are ignored. Direct render return semantics
remain owned by the most-derived entry, so ancestor constructors run with
isolated `__return__` state unless the entry file itself defines the invoked
constructor.

## Error Model

Structural metadata errors are fatal.

Collect multiple finalization errors when they are independent and cheap to
collect. Do not add complex aggregation machinery if it makes finalization
harder to understand.

Runtime invariant failures are fatal.

Poison semantics remain ordinary Cascada channel/value behavior and are not
special-cased by inheritance metadata code.

## Temporary Constructs

Temporary code is allowed only when an implementation slice needs a clear
runtime boundary before the final code exists. Mark each temporary code
construct with a `Temporary` comment and list the construct here.

- `invoke.js`: direct `method.fn(...)` call in `invokeMethod(...)`.
  Replace when invocation commands own admission.

## Implementation Steps

Each step ends with runnable tests. Prefer focused integration tests that render
real scripts/templates. Add unit tests only for metadata shapes that are hard to
observe through rendering.

0. Final surface cleanup
   - completed before the new runtime implementation starts
   - legacy runtime lives at `src/runtime/inheritance-legacy/`
   - final runtime work owns `src/runtime/inheritance/`
   - inherited callable signatures contain only `argNames`
   - inherited callables read render context by default
   - composition `with context` remains for `extends`, `include`, `import`,
     `from import`, and `component`

1. Standalone template block
   - render a template with one inline block and no `extends`
   - support only zero-argument block placement
   - create the smallest state, method table, and invocation path needed for
     one compiled block entry

2. Block arguments
   - add positional block arguments
   - placement passes values by position from the block declaration expression
     list
   - test locals passed explicitly into a root/no-extends block

3. Named block argument bindings
   - support `block(arg = local)` for passing a local value into the block
     argument named `arg`
   - reject mixed positional/named block bindings
   - reject named bindings in static-extending templates, where blocks are
     declarations only and have no local placement
   - test named bindings, duplicate names, and non-identifier binding names

4. Template render context
   - completed with the standalone block test coverage
   - make block entries read render context by default
   - test render-context names inside a block and verify placement-local names
     still require explicit block arguments

5. Template inheritance
   - load child and parent specs child-first
   - finalize a simple override table
   - test child override rendering at the parent block position
   - validate parent placement argument names against the selected override's
     declared argument names
   - add missing-block, duplicate-block, and static extends-cycle errors as
     focused failure tests

6. `super()`
   - add owner-relative parent links
   - validate signature compatibility between overridden entries
   - test `super()` and `super(...)` in blocks
   - add missing/invalid `super()` failure tests

7. `this.callable(...)`
   - add ordinary inherited callable dispatch from blocks
   - merge invoked-callable footprints into caller footprints
   - test `this.blockName(...)`, missing callable errors, and
     invoked-callable cycles

8. Shared state
   - add shared schema finalization and shared root buffer
   - test `this.sharedName` reads/writes from constructors, methods, and
     blocks
   - test shared schema conflicts and exact channel linking without wildcard
     shared-schema linking

9. Script methods and constructors
   - wire script `method` entries through the same callable path
   - test direct render return value, constructor `super()`, and method
     render-context access by default

10. Dynamic startup
   - add dynamic parent selection and `extends none`
   - dynamic template `extends` must be a top-level declaration
   - compile literal `extends none` as no parent work
   - change generated dynamic-template output so parent selection is resolved
     once into an `extendsState` field such as `hasParent`
   - block placement should read that resolved boolean instead of resolving the
     parent-selection promise at every block site
   - decide named-binding behavior for dynamic maybe-parent blocks after the
     local-placement decision exists; if a parent is selected, local placement
     arguments must not be silently treated as active
   - test literal `extends none` renders local inline block placement
   - test dynamic parent selection renders either parent placement or local
     fallback
   - test dynamic extends-chain cycles fail clearly

11. Components
   - wrap component lifecycle around the same inheritance state and invocation
     primitive
   - test component startup, component method call, independent component
     instances, component shared observation, and startup failure rethrow

Only after these focused tests pass should the existing broad suites be
switched over:

- `tests/pasync/extends-foundation.js`
- `tests/pasync/extends.js`
- `tests/pasync/extends-template.js`
- `tests/pasync/template-command-buffer.js`
- `tests/pasync/component.js`

## Implementation Rules

- Keep raw compiled metadata and execution metadata as separate objects.
- Finalization may allocate temporary graph objects, but they must not survive.
- Normal dispatch reads only finalized `state.methods`.
- Loading collection must be append-only.
- Loading collection must not create execution metadata.
- Do not resolve metadata lazily during normal dispatch.
- Link only the finalized method footprint, not the whole shared schema.
- Ordinary visibility must come from the current buffer and its linked
  channels, not parent/root buffer fallback reads.
- Avoid hidden readiness barriers in hot invocation paths.
- Prefer one small adapter over compatibility branches throughout the core.
- Keep each module's public exports minimal.
- Add behavior tests before white-box tests when possible.
- Delete old inheritance runtime code only after the new runtime owns the full
  compiler-facing ABI.
