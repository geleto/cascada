# Inheritance2 Technical Design

## Goal

`inheritance2` is a clean runtime implementation of async inheritance,
components, and shared state.

The current `src/runtime/inheritance/` implementation was experimental. It
proved the model by trying several concepts incrementally, but it is not the
shape to preserve. `inheritance2` is the final implementation path.

We are willing to break the current inheritance runtime while building this.
Correctness will be protected by focused unit and integration tests instead of
compatibility with temporary implementation details.

`inheritance2` keeps the current compiler ABI.

The runtime should be small enough that each part has one job:

- collect compiled inheritance specs while loading the chain
- finalize the chain once
- invoke finalized methods
- manage shared channels
- wrap component lifecycle

No compatibility scaffolding is kept inside the core.

## Compiler ABI

The compiler emits:

```js
{
  root,
  externSpec,
  inheritanceSpec: {
    setup,
    methods,
    sharedSchema,
    invokedMethods,
    hasExtends
  }
}
```

Raw method entries have:

```js
{
  fn, // compiled callable function
  signature, // { argNames, withContext }
  ownerKey, // file/template identity
  ownLinkedChannels, // local callable channel reads/observations
  ownMutatedChannels, // local callable channel mutations
  super, // true when callable contains super(), false otherwise
  superCallOrigin, // source location for super(), or null
  invokedMethods // method name -> first call site, for missing-method errors
}
```

ABI rules:

- Keep `inheritanceSpec` as the single compiled inheritance descriptor.
- Keep `methods`, `sharedSchema`, and `invokedMethods` as object maps.
- Keep raw method entries with `fn`, `signature`, `ownerKey`,
  `ownLinkedChannels`, `ownMutatedChannels`, `super`, `superCallOrigin`, and
  `invokedMethods`.
- Keep raw `super` as `true` / `false`. Loading must not mutate it.
  Finalization resolves it into direct execution metadata.
- Keep file-level `invokedMethods`.
- Keep per-method `invokedMethods`.
- Keep `signature` as `{ argNames, withContext }`.
- Keep channel footprint arrays as emitted.
- Do not add adapter-only ABI fields for `inheritance2`.

## Data Types

```js
// Compiler-generated method table entry.
type RawMethodEntry = {
  fn: Function,
  signature: { argNames: string[], withContext: boolean },
  ownerKey: string, // file/template that defined this method
  ownLinkedChannels: string[], // local body reads/observations
  ownMutatedChannels: string[], // local body mutations
  super: boolean,
  superCallOrigin: SourceOrigin | null,
  invokedMethods: Record<string, InvokedMethodRef> // method name -> first call site, for error output when missing
}

// Compiler-generated reference to an inherited method call.
type InvokedMethodRef = {
  name: string,
  origin: SourceOrigin | null
}

// Runtime-created finalized method table entry.
type ExecutionMethodEntry = {
  fn: Function,
  signature: { argNames: string[], withContext: boolean },
  ownerKey: string, // file/template that defined this method
  super: ExecutionMethodEntry | null, // owner-relative parent method
  mergedLinkedChannels: string[], // transitive reads/observations
  mergedMutatedChannels: string[] // transitive mutations
}

// Compiler-generated inheritance descriptor.
type CompiledInheritanceSpec = {
  setup: Function,
  methods: Record<string, RawMethodEntry>, // method name -> raw method
  sharedSchema: Record<string, string>, // channel name -> channel type
  invokedMethods: Record<string, InvokedMethodRef>, // method name -> first call site
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
src/runtime/inheritance2/
  TECHNICAL-DESIGN.md
  state.js
  loading.js
  finalize.js
  invoke.js
  shared.js
  component.js
  index.js
```

### `state.js`

Owns per-render / per-component inheritance state.

```js
{
  methods: Record<string, ExecutionMethodEntry>, // method name -> finalized method
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

### `loading.js`

Collects raw compiled specs before finalization.

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

### `finalize.js`

Builds the final execution tables in one blocking pass.

Final execution method entry:

```js
{
  fn, // compiled callable function
  signature, // finalized call signature
  ownerKey, // file/template identity
  super, // parent execution method entry, or null
  mergedLinkedChannels, // full transitive channel reads/observations
  mergedMutatedChannels // full transitive channel mutations
}
```

Finalization steps:

1. Validate and merge shared schema.
2. Build method chains per name from collected files.
3. Resolve ordinary dispatch table to the most-derived method per name.
4. Resolve owner-relative `super` links.
5. Resolve ordinary inherited calls from per-method `invokedMethods`.
6. Compute fixed-point merged channel footprints.
7. Publish `state.methods` and `state.sharedSchema`.
8. Drop loading data.
9. Set `state.finalized = true`.

Missing inherited methods, invalid `super()`, signature conflicts, shared name
conflicts, and shared/method name collisions are finalization errors.

Invoked-method cycles are allowed. Extends-chain cycles are not.

### `invoke.js`

Owns normal method execution.

Public runtime ABI should initially match the compiler-facing names:

- `invokeInheritedMethod(...)`
- `invokeSuperMethod(...)`
- `getCallableBodyLinkedChannels(...)`
- `getCallableBodyMutatedChannels(...)`

Normal invocation assumes finalized direct method metadata. If state is not
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

## Startup Model

Inheritance bootstrap is blocking for metadata:

1. create state
2. register child spec
3. resolve and register parent specs
4. finalize metadata
5. run setup and constructor startup

Constructor startup is not a special metadata model. It invokes the finalized
`__constructor__` method when present.

The topmost missing constructor is represented by a no-op constructor only for
constructor `super()` resolution.

Ancestor constructor return values are ignored. Direct render return semantics
remain owned by the most-derived entry.

## Error Model

Structural metadata errors are fatal.

Collect multiple finalization errors when they are independent and cheap to
collect. Do not add complex aggregation machinery if it makes finalization
harder to understand.

Runtime invariant failures are fatal.

Poison semantics remain ordinary Cascada channel/value behavior and are not
special-cased by inheritance metadata code.

## Minimal Test Strategy

Tests should be added in layers. Each layer should pass before the next layer
is implemented.

1. loading unit tests
   - child-first collection
   - no raw mutation during loading
   - shared schema conflict
   - extends-chain cycle

2. finalization unit tests
   - override table
   - owner-relative `super`
   - missing `super`
   - missing ordinary inherited method
   - invoked-method cycle
   - merged linked/mutated footprints
   - loading state cleared after finalization

3. invocation integration tests
   - `this.method(...)`
   - `super(...)`
   - method calling another inherited method
   - shared channel read/write through invocation buffer
   - exact channel linking, no wildcard shared-schema linking

4. startup integration tests
   - direct extends chain
   - dynamic parent selection
   - `extends none`
   - constructor `super`
   - direct render return value

5. component integration tests
   - component startup
   - component method call
   - independent component instances
   - component shared observation
   - startup failure rethrown by later operations

Only after these focused tests pass should existing broad suites be switched
over:

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
