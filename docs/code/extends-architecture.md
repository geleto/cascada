# `extends` Architecture

This document is the high-level architecture for the current `extends` redesign.
It incorporates the blocking metadata model from
`extends-metadata-architecture.md` through Step 9.

Older notes in `extends-architecture-raw.md` and early revisions of this file
describe the previous runtime-pending metadata model. Those notes are now
historical for metadata/finalization behavior.

This architecture is intentionally high level.

It assumes a more radical reorganization than `extends-implementation-2.md`.

Open questions, missing pieces, and compatibility constraints will be added in
later revisions instead of being front-loaded here.

Evaluation baseline:

- all review and implementation evaluation for `extends-next` should compare
  against commit `016801d694a82068a3c8102231ae0636a68a6c42`
- this is the exact branch point that `extends-next` restarted from
- newer `master` changes are not the comparison target for this work and are
  not architecture that this branch is trying to preserve

## Overview

The design assumes a single explicit parent-selection site in source. Parent
selection happens only at `extends`, not through later constructor-time control
flow. The selected parent may still come from a dynamic expression at that
site.

Per-template state is the compiled JS shape. Inheritance-specific compiled
state lives under `inheritanceSpec` instead of being spread across top-level
template properties. Per-instance state is that same compiled JS running for one
render after a blocking inheritance bootstrap has loaded the full chain and
built direct method/shared metadata.

The shared metadata object has the final shape:

- `methods`
- `sharedRootBuffer`
- `sharedSchema`
- `compositionPayload`

Parent invocation is normalized into one object-shaped argument containing at
least those four fields.

Shared-root ownership is single-origin:

- the most-derived direct-render entry creates the hierarchy shared root once
- component instantiation creates the component shared root once
- parent files do not create replacement shared roots
- inheritance/composition entry calls reuse the already-created shared root

## Compiler Model

The compiler should have an easy way to detect block/method
scripts/templates.

Blocks/methods move to a separate AST node in the transformer.

That node compiles into a key-value object (`methods`) at the start of the JS
file. The keys are the method/block names. The values contain both metadata
(like used/mutated channels), the function, as well as the `super` object. The
constructor is part of this too, named `__constructor__` or similar.

Blocks and methods should share the same runtime model and syntax. The main
difference is only in what the compiled function does:

- script entries may return
- template entries write to the text channel

Blocks do not have their own `withContext` mode. They follow the enclosing
template/script `withContext`.

Blocks should move toward the same callable model as methods: identifier plus
explicit arguments in `()`, rather than a separate `with`-style calling
convention. This is intentionally clearer than traditional Nunjucks block
invocation.

Templates follow the same model:

- template body compiles to internal `__constructor__`
- blocks are the method form
- code before `extends` is pre-extends code
- code after `extends` is post-extends code
- parent selection happens at the `extends` site itself:
  - a dynamic parent filename/expression is allowed
  - imperative control flow that conditionally executes `extends` is not part
    of this architecture
  - if a template/script needs a "no parent" branch, it should use
    `extends none` / `extends null` in the parent-selection expression
  - `extends none` / `extends null` means the current file becomes the root
    constructor/root render entry for that render
  - this avoids fake fallback templates while still keeping parent selection
    inside the single `extends` site
  - do not move `extends` into `if`, `switch`, loops, or other
    constructor-time control flow

Because only `shared` declarations are allowed before `extends`, there is no
template-local-capture mechanism in this architecture for arbitrary
pre-`extends` variables.

## Shared Metadata Objects

### Method Entries

Method metadata is structural. The inheritance chain is loaded and finalized
before constructor/root execution starts, so normal execution reads direct
method metadata rather than promise-shaped pending entries.

The minimum compiled method-entry shape should stay small and should be emitted
directly from the local method/block AST:

- `fn`
- `signature`
- `ownUsedChannels`
- `ownMutatedChannels`
- `super`
- `superOrigin`
- `ownerKey`
- `invokedMethods`

Compiled `super` is `true` when the callable contains `super()` and `false` or
`null` otherwise. During bootstrap, `super: true` is rewritten to the direct
owner-relative parent metadata object, or to `null` when the no-op root
constructor rule applies. A non-constructor `super()` without a parent
implementation is reported as a structural metadata error.

Compiled `superOrigin` carries source-origin metadata for the `super()` call
site when present. Finalization uses it for diagnostics and does not retain it
in execution method metadata.

Compiled `invokedMethods` records ordinary inherited method calls such as
`this.render()`. It is an object map keyed by method name. During bootstrap,
each value is replaced with the final override-resolved method metadata for
that name. `super()` is not represented here because it is owner-relative and
uses the separate `super` field.

The compiler should emit only the channels directly touched by the local method
body. Channels reached through `super()` and ordinary inherited calls are
computed during metadata finalization.

Finalization work metadata temporarily includes the graph edges needed to
compute the transitive callable footprint:

- `fn`
- `signature`
- `ownerKey`
- `super`
- `invokedMethods`
- `mergedUsedChannels`
- `mergedMutatedChannels`

After finalization, normal execution uses the pruned execution method metadata
shape:

- `fn`
- `signature`
- `ownerKey`
- `super`
- `mergedUsedChannels`
- `mergedMutatedChannels`

`mergedUsedChannels` and `mergedMutatedChannels` are the full transitive
callable footprint: the callable's own channels, its reachable `super()` chain,
and all ordinary inherited methods it may invoke.

Compiled `ownUsedChannels`, `ownMutatedChannels`, `superOrigin`, and
callable-local `invokedMethods` are bootstrap/finalization inputs. They are not
part of the long-lived execution method data once the footprint has been
computed.

Compiled files expose an `inheritanceSpec` descriptor containing `setup`,
`methods`, `sharedSchema`, `invokedMethods`, and `hasExtends`. The file-level
`invokedMethods` catalog contains every ordinary inherited method name
referenced anywhere in the file. Bootstrap resolves that catalog once against
the final method table, then gives each callable its filtered direct map.

### Shared-Channel Entries

Also collect all shared channels. The key is the channel name. The value is
the shared-channel type.

The shared channel schema should stay explicit and type-only:
`sharedSchema[name] = "var" | "text" | "data" | "sequence" | ...`. Local
default expressions stay in the compiled startup code rather than the metadata
schema. This is still enough for each script/template to add channels that are
not yet present in the shared command buffer while keeping default evaluation in
source order.

Shared channel metadata follows the same structural timing as method metadata:
blocking bootstrap produces a final direct shared schema before execution.
Normal execution does not depend on pending shared-schema entries.

The resolved shared-channel metadata shape should stay small: channel type is
enough to choose the side-channel command shape and detect conflicting
declarations across scripts/templates. Child-first shared defaults are enforced
by the shared-buffer startup path, not by storing default values in
`sharedSchema`.

## Shared State

`shared` means hierarchy-owned instance state. Composition payloads are the
caller-input mechanism for ordinary composition paths such as plain `import`,
`from import`, and `include`.

Shared declarations belong to constructor/root scope only. They are not
allowed inside methods/blocks.

That restriction is also the visibility boundary for inherited execution:

- methods/blocks may read shared channels
- methods/blocks may read their explicit call payload / arguments
- methods/blocks may read any explicitly-enabled render/context payload that
  the language feature allows
- methods/blocks do not read ambient constructor-local or parent-scope locals

In particular, the constructor/root body is not a special outer scope that
other methods can inspect later. It is just the `__constructor__` method.
Constructor-local values therefore do not become ambient inherited state unless
they are written into shared channels or forwarded explicitly in payload.

### Script shared-state access surface

Inside a script, shared state is accessed exclusively through `this.<name>`.
Bare names — even names that are declared as `shared` in the same file — follow
ordinary ambient lookup only. The compiler maps `this.<name>` to the correct
shared-channel operation based on the current file's `shared` declaration for
that name:

- `this.sharedVar` — shared `var` read (implicit snapshot)
- `this.sharedVar = value` — shared `var` write
- `this.sharedVar.nested.prop` — shared `var` read followed by ordinary
  property lookup on the snapshot value
- `this.sharedText("msg")` — shared `text` channel append
- `this.sharedData.path = value` — shared `data` channel `set` command
- `this.sharedData.command(args)` — shared `data` channel command call
- `this.sharedChannel.snapshot()` — explicit snapshot of any channel type
- `this.sharedChannel is error` — error check on any channel type
- `this.sharedChannel#` — peek error message on any channel type
- `this.sharedSequence.method(args)` — shared `sequence` channel call
  (ordered by the channel mechanism; the `!` operator is not used here)

Any bare name in a script follows ordinary name resolution — context, globals,
and composition payload — regardless of whether that name is also declared as
`shared` in the same file. Bare assignments to a declared shared name produce a
migration error at compile time.

For async/script mode, name resolution stays split into two explicit classes:

- declared names: ordinary declared vars, declared shared vars/channels, args,
  loop vars, and composition payload bindings
- ambient names: undeclared bare names, plus bare names where `this.<name>` is
  the shared access surface, resolved through context/global/render-context

The `this.` prefix is the gating mechanism:

- `this.<name>` routes through shared/inheritance semantics only when the
  current file has a matching `shared` declaration for that name
- bare `<name>` always follows ambient lookup, even when a `shared` declaration
  exists for that name in the same file
- component/component-property observation from the caller remains a separate
  read-only surface; it is not in-file `this.` access

Every file must explicitly declare every shared name it wants to access via
`this.<name>`. Parent-chain visibility alone does not authorize shared-state
access in a child file.

### Template shared-state access surface

Async inherited templates use the same `this.<name>` surface for shared vars,
but with a different compilation model: the compiler infers shared `var` entries
from static `this.<root>` paths found anywhere in the template AST, without
requiring explicit `shared` declarations in template source.

Template shared access is var-only. The compiler does not infer shared `text`,
`data`, or `sequence` channels for templates; those typed channels are a
script-only concept at this surface.

Template inference applies only when the template uses inheritance nodes
(`extends` or `block`). A plain async template that does not participate in
inheritance continues to treat `this` as an ordinary render-context object.

Within an inheritance template, `this` is reserved as the inheritance-instance
surface and a render-context variable named `this` does not intercept
`this.<name>` shared-var lookup.

All shared channels should be declared before any `extends` and before any
`super()`-driven inherited work that depends on them.

Shared defaults follow the inheritance contract:

- `shared x = default` means initialize-if-not-set
- a more-derived shared default wins over an ancestor default
- a later plain assignment overwrites the current value

Shared default handling should stay simple:

- a shared declaration without an initializer only declares participation; it
  does not claim the channel default
- the first assigned default in child-to-parent startup order claims the shared
  channel default
- if a later ancestor also has an assigned default for that shared channel, its
  default expression is ignored
- `with ...` / `compositionPayload` does not override shared defaults, even
  though shared defaults may read values from that payload

Per-channel-type shared rules stay explicit:

- `shared var x = value` is allowed
- `shared text x = value` is allowed
- `shared data x = value` is allowed
- `shared sequence db = sinkExpr` initializes the shared sequence
- `shared sequence db` declares participation without an initializer

Shared channel declaration should only do work when the channel does not yet
exist. Re-declaring an already existing shared channel with the same type is
effectively a no-op.

Re-declaring an existing shared channel with a different type is a
`RuntimeFatalError` as soon as it is detected, then normal fatal handling
applies.

## Bootstrap and Finalization

Inheritance metadata is built in a blocking bootstrap before constructor/root
execution starts.

Bootstrap order should stay deterministic:

1. Resolve the parent selection at the `extends` site.
2. Load and compile the full parent chain.
3. Detect inheritance-chain cycles.
4. Register shared schema and method metadata for the chain.
5. Build the final override-resolved method table.
6. Resolve owner-relative `super()` metadata.
7. Resolve file-level and per-callable `invokedMethods`.
8. Compute final `mergedUsedChannels` and `mergedMutatedChannels`.
9. Finalize shared-root ownership.

Parent methods are registered before child methods, then child overrides replace
the effective method entry for a name. Ordinary `this.method()` dispatch uses
the final override-resolved method table. `super()` remains owner-relative and
walks from the current owner to the next parent implementation.

Merged-channel calculation is part of finalization, not runtime lazy
resolution. The fixed-point pass includes:

- each callable's own channels
- reachable owner-relative `super()` channels
- transitive channels from ordinary inherited calls in `invokedMethods`

Invoked-method cycles are valid call-graph metadata and are handled by the
fixed-point merge. Parent-chain cycles are fatal structural bootstrap errors.

Finalization collects recoverable structural metadata errors from catalog
wiring, `super()` resolution, and footprint validation before throwing.
Immediate throws should remain for impossible invalid-metadata invariants.

## Constructors and `extends`

Constructor dispatch should not be a special runtime model. It is compiled as
an inherited call to `__constructor__`, and then admitted and linked exactly
like any other method call using finalized direct metadata.

Code after `extends` is the constructor body. If there is no executable body
after `extends`, there is no local constructor entry, so normal inherited
lookup finds an ancestor constructor if one exists. Parent-constructor
execution inside a real constructor body is not automatic; it happens only
through the constructor's own `super()` behavior. At the actual topmost root,
an otherwise-missing constructor resolves to a no-op constructor so
constructor `super()` from a child does not fail just because the root body is
empty.

Because the body is just the constructor method, it does not create a separate
"parent scope" that other methods can read from. Later methods/blocks follow
the same visibility rules as any other method call: shared channels plus
explicit payload/context only.

Constructor and inherited-method dispatch use the same runtime call model.

To keep the model simple, only `shared` declarations are allowed before
`extends`. Arbitrary executable pre-extends code is not part of this
architecture.

There is therefore no split "before-extends context" vs "after-extends
context" model. Constructor/body execution begins after the `extends`
boundary.

`extends` creates an async boundary. Metadata bootstrap completes before the
constructor/body execution for that boundary starts. Code after `extends`
executes in a later async boundary / command buffer, similar in spirit to how
other structural async boundaries split execution.

The initial entrypoint is the import-run script/template itself. It executes
exactly like a normal import-run wrapper, but it receives the shared metadata
object after bootstrap and uses it for method dispatch and shared-channel
access. It returns the shared metadata object.

Imported components should not have a meaningful return value of their own.
Component constructor return is ignored so one script can still serve both as a
component and as an extended script. In all cases, the runtime value that
matters is the shared metadata object.

## Method Dispatch and `super()`

Method calls reference direct finalized metadata from the inheritance state.

Inherited dispatch is explicit:

- `this.method(...)` participates in inheritance lookup
- bare `foo()` remains an ordinary local/context/global call
- `this.method` without a call is a compile-time error

Inherited methods operate on shared state, method arguments, and method
payload. They do not depend on ancestor-private constructor-local channels.

Sequential `!` paths inside inherited methods should work like normal Cascada
sequential paths, but this can be deferred in the implementation plan.

When a child defines the same method name as its parent, child overrides
parent for ordinary `this.method()` dispatch. If that child method uses
`super()`, bootstrap rewrites its `super` field to the owner-relative parent
implementation.

`super` should stay part of the resolved method metadata shape rather than
becoming a separate lookup table. A `super()` call uses that already-resolved
direct metadata object.

Each method call should still create its own child invocation buffer after the
target metadata is finalized. That child invocation buffer lives inside the
shared command-buffer tree. Linking uses the call target's final
`mergedUsedChannels` and `mergedMutatedChannels`.

## Direct Metadata and Linking

Normal execution should not use runtime-pending metadata helpers. Admission and
method entry startup receive direct method metadata that bootstrap has already
finalized.

Call sites should not read `ownUsedChannels` / `ownMutatedChannels` for
admission. They should use:

- `mergedUsedChannels`
- `mergedMutatedChannels`

Those merged fields are conservative for the full callable footprint, including
the reachable `super()` chain and ordinary inherited calls that were represented
by `invokedMethods` during finalization.

There are two kinds of side-channel commands:

- method-call commands
- shared-channel-lookup commands

Method-call side-channel commands use finalized direct method metadata. A small
synchronous guard such as `requireMethodData(...)` may still be useful at
runtime boundaries, but it should only validate direct metadata and throw a
fatal metadata error for missing or invalid entries.

`extends ... with ...` payloads should follow the same chain-through model in
both templates and scripts:

- the payload object is captured at the `extends` site
- it may pass unchanged through intermediate parents that do not declare those
  explicit inputs themselves
- validation should happen where an include/import-style isolated composition
  boundary actually consumes externs, not at each intermediate inheritance hop

Current-call linkage uses the call target's merged channel effect set:

- compiled `ownUsedChannels` / `ownMutatedChannels` describe the local body only
  during finalization
- `mergedUsedChannels` / `mergedMutatedChannels` describe the current callable
  level plus the reachable inherited work from `super()` and `this.method()`

So inherited execution remains lazy, but channel metadata is conservative:

- current-call side-channel apply links using the current level's merged effect
  set
- later `super()` or `this.method()` execution reuses already-resolved metadata
- "exact" means exact to the resolved callable's full inherited effect set,
  not merely to the current level's local body text

This still must not turn into broad unrelated linkage:

- merged callable metadata may include reachable inherited calls
- it must not widen into blanket `sharedSchema` / hierarchy-wide linking for
  channels the callable chain does not touch

This is important for correctness as well as performance: broad eager
resolution/linking can serialize later unrelated shared-channel work and
violate the architecture's intended concurrency model.

Optional caches for pre-merged invocation-link channels or body-link channels
belong on finalized metadata. They should not reintroduce lazy metadata
resolution.

## Shared-Channel Access

Shared channel access uses finalized direct shared-schema metadata. Normal
execution should not wait for pending shared-schema entries.

Chain-level shared schema is used to validate and execute declared shared
channels. It does not rescue undeclared ordinary lookups.

The effective shared-channel metadata is used to choose and construct the
side-channel command. Missing or invalid shared metadata at an execution
boundary is a fatal metadata error.

Within a script or inherited template, shared channels are accessed through
`this.<name>` (see Script shared-state access surface and Template
shared-state access surface above). The `this.` prefix is what routes the
access through the shared-channel machinery; bare names always follow ambient
lookup.

Allowed `this.<name>` operations on a shared channel:

- `this.name` — implicit snapshot (var channels only)
- `this.name.path` — snapshot followed by ordinary property lookup
- `this.name.snapshot()` — explicit snapshot of any channel type
- `this.name is error` — error check
- `this.name#` — peek error message
- `this.name(...)` — channel operation call (text channels)
- `this.name.path = value` — channel set command (data and var channels)
- `this.name.command(args)` — channel command call (data channels)
- `this.name.method(args)` — sequential channel call (sequence channels)

Any operation that does not match the channel's type should fail with a clear
error at compile time where possible, or at the execution boundary otherwise.

Method-call side-channel commands use finalized method channel metadata.
Shared-channel-lookup side-channel commands use finalized shared-channel
metadata.

Shared-channel observation remains a current-buffer operation. The caller does
not receive a stored JS channel object. Instead:

- the caller/current buffer receives a side-channel observation command
- that side-channel command already knows the exact shared channel being read
- it carries the exact observational channel command to run
- in `apply()`, it enqueues that observational command on the hierarchy or
  component shared root buffer for the exact shared lane
- it returns the observational command's deferred result promise

For component access specifically, the side-channel observation command should
carry the exact observational command instance rather than hardcoding modes. In
the current model that means:

- the compiler uses the normal `is error` and `#` syntax paths, but
  special-cases component-bound properties to route them into component shared
  observation instead of ordinary lookup/peek handling
- `comp.someVar` uses a `SnapshotCommand` plus implicit-var-read validation
- `comp.someChannel.snapshot()` uses `SnapshotCommand`
- `comp.someChannel is error` uses `IsErrorCommand`
- `comp.someChannel#` uses `GetErrorCommand`

This keeps the side-channel command generic and future-friendly. New
observational commands can be supported later without changing the shared-root
enqueue model, as long as they remain safe observational commands rather than
mutations.

## Component Model

Each component instance gets its own shared metadata object. More generally,
each extends-linked chain, whether run directly or imported as a component,
gets its own shared metadata object.

Component use should have explicit syntax. Use a `component` keyword instead of
overloading `import`, so the compiler has a clear compile-time signal to emit
component-specific code such as instance creation, side-channel operations, and
lifecycle handling.

`component` is therefore an intentionally reserved keyword on this new path.

Regular import and component import remain distinct:

- `import ...` stays regular import
- `component ... as ...` creates a component instance binding

Component semantics apply only to the direct binding introduced by
`component ... as ns` in the first implementation. Aliasing, passing, or
returning that component value is out of scope.

Components follow the same blocking inheritance-bootstrap rule. Before a
component constructor can run, the component's full inheritance chain is loaded,
compiled, and finalized. Component constructor startup still belongs to the
caller-side ordered component startup path, but metadata bootstrap completes
before that startup command runs.

Component creation mirrors import-style deferred availability: the component
binding is available immediately as a promise-like value, and that value
resolves to the complete component instance once metadata bootstrap and ordered
constructor startup have finished.

Components use the same shared metadata object model. On the caller side,
`apply()` should:

- look up the method in the shared component metadata object
- read the finalized direct method metadata
- perform linking from the method's final `mergedUsedChannels` and
  `mergedMutatedChannels`

Multiple component instantiations are fully independent instances with separate
shared roots, shared state, side-channels, and method calls.

If a script/template receives the shared metadata object but defines no
blocks/methods, it should still be able to declare or override the constructor.
The compiled code for that case should stay minimal.

## Composition Payload

`compositionPayload` should stay simple for the first version. Treat it as a
plain context-like key/value payload unless a later redesign proves that it
must itself participate in shared-state semantics.

`compositionPayload` should not have schema validation. It behaves like a
context object: arbitrary keys are allowed.

Normal context lookup should also check `compositionPayload`.

Component `with` values feed `compositionPayload`, not shared channels.
Supported forms include:

- `component "X" as ns with context`
- `component "X" as ns with theme, id`
- `component "X" as ns with context, theme, id`
- `component "X" as ns with { theme: "dark", id: 0 }`
- `component "X" as ns with context, { theme: "dark", id: 0 }`

In all cases, the values are passed as context-like key/value payload and are
not written into shared state automatically.

The shorthand `with theme, id` means "capture the current caller-context values
of `theme` and `id`". This shorthand is limited to `var` values.

For multi-level inheritance, `compositionPayload` flows upward unchanged.

## Returns

Return semantics stay explicit:

- `extends` is not a value-producing expression
- for direct render, only the most-derived entry file's explicit `return`
  counts
- ancestor constructor returns are ignored
- for component instantiation, constructor return is ignored and the component
  object is produced
- component method return is separate and resolves from that method call
- standalone/direct-render scripts still use normal script return scaffolding

## Error Handling

The default error model should be strict:

- unresolved method, `super()`, invoked-method, or shared-schema metadata found
  during bootstrap is fatal
- fatal metadata errors discovered during graph finalization should be
  aggregated where possible before throwing
- missing or invalid finalized metadata at an execution boundary is fatal
- missing `__constructor__` is only non-fatal when no local constructor exists
  and normal inherited lookup can continue to an ancestor constructor; an
  otherwise-missing topmost constructor resolves to a no-op constructor only for
  the root-constructor `super()` case

Bootstrap/finalization failures should report through the runtime fatal-error
path with source-origin metadata when available. Compiled invoked-method and
`super()` references should carry enough origin data for finalization-time
errors to point at the original call site rather than only the file path.

Error and poison propagation follow ordinary Cascada rules. This redesign
changes where work is attached and where shared-root apply may stall; it does
not change poison semantics.

## Static Analysis

Static analysis requirements stay narrow:

- shared schema declared by each script file, or inferred from static
  `this.<name>` paths for async inherited templates (var-only)
- upfront method metadata including internal `__constructor__`
- file-level and per-callable `invokedMethods`
- source-origin metadata for inherited calls and `super()`
- override metadata needed for runtime inheritance resolution
- no caller-side method read/write tracking for component scheduling
- no wildcard parent-lane linking for inherited calls

## Compatibility

Compatibility requirements should still be preserved:

- plain scripts and templates without `extends`
- plain `import`, `from import`, and `include`
- existing `with` payload behavior for non-inheritance composition
- `caller()` in macros
- sequential `!` paths
- 100% Nunjucks compatibility for sync template inheritance

Sync templates do not use this architecture. They stay on the old
Nunjucks-compatible path.

The redesign should still enable:

- shared channels readable and writable across the hierarchy
- JS-style dynamic dispatch from ancestor constructors
- independent instances via explicit `component` instantiation
- `compositionPayload` values usable from shared defaults and constructors
- component method calls that return values without exposing internal buffers

Dynamic `extends` means the parent target is an expression rather than a
literal path. It works through the same blocking bootstrap model rather than a
separate architecture. Dynamic `extends` first waits for parent-name
resolution, then loads and finalizes the full resolved parent chain before
constructor/root execution starts.
