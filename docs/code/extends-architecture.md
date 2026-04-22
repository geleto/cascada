# `extends` Architecture

This document is a structured rewrite of `extends-architecture-raw.md`.

It preserves the same semantics and does not intentionally add or remove
information. The raw document remains the source of truth if anything appears
ambiguous after restructuring.

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

Per-template state is the compiled JS shape. Per-instance state is that same
compiled JS running for one render, resolving method entries, `super`, and
parent arrival through the shared runtime objects passed up the inheritance
chain.

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

Additionally, collect all parent methods: methods that are either not yet
defined, or used through `super()`. These are compiled into the block/methods
object as promises, with `resolve` and `reject` methods, so 3 properties:
`promise`, `resolve`, `reject`.

Once a promise is resolved by the parent, it will be replaced with the value
object (metadata and function). The `super` properties are also a promise in
the same way. If there is no definition for a called method, it is added to
the methods object, not as `super`.

Unresolved vs resolved entries should keep the smallest possible stable shape:

- unresolved entry: promise structure, with `promise`, `resolve`, `reject`
- resolved entry: actual method object; the promise structure is replaced
- rejected entry: promise rejects; no extra `state` field is required

Pending method entries and pending shared-channel entries should use the same
promise-structure shape.

The minimum raw compiled method-entry shape should stay small and should be
emitted directly from the local method/block AST:

- `fn`
- `signature`
- `ownUsedChannels`
- `ownMutatedChannels`
- `super`
- `ownerKey`

`super` is optional. If the local method does not use `super()`, the field may
be omitted or set to `null`. If the local method uses `super()`, the field is a
pending-entry promise structure until startup registration wires it to the
local parent method metadata or rejects it at the topmost parent.

The compiler should emit only the channels directly touched by the local method
body. Channels coming from the `super` chain are not stored in the raw compiled
entry and are merged later by the resolver helper.

Keep `ownUsedChannels` and `ownMutatedChannels` separate in the raw stored
entry, then merge conservatively when needed.

### Shared-Channel Entries

Also collect all shared channels. The key is the channel name. The value is
shared-channel metadata including at least the channel type and the local
default value.

Unknown shared channels use the same promise structure and are replaced in
place once resolved.

The shared channel schema should stay explicit: key is identifier, value is
shared-channel metadata containing at least the channel type and local default
value. This is still needed so each script/template can add channels that are
not yet present in the shared command buffer.

Shared channel metadata should follow the same model as method metadata. The
shared schema is a key-value object where the key is the channel name. A known
channel is stored as its resolved metadata, including at least the channel type
and the local default value. A not-yet-known channel is stored as a promise
structure with `promise`, `resolve`, and `reject`, and is replaced with the
resolved metadata once a parent defines it.

The resolved shared-channel metadata shape should stay small, but it now needs
more than just the type:

- channel type
- local default value

That is enough to choose the side-channel command shape, detect conflicting
declarations across scripts/templates, and preserve child-first shared
defaults.

## Shared State

`shared` means hierarchy-owned instance state. `extern` remains the caller-input
mechanism for ordinary composition paths such as plain `import`, `from import`,
and `include`.

Shared declarations belong to constructor/root scope only. They are not
allowed inside methods/blocks.

That restriction is also the visibility boundary for inherited execution:

- methods/blocks may read shared channels
- methods/blocks may read their explicit call payload / arguments
- methods/blocks may read any explicitly-enabled render/external context that
  the language feature allows
- methods/blocks do not read ambient constructor-local or parent-scope locals

In particular, the constructor/root body is not a special outer scope that
other methods can inspect later. It is just the `__constructor__` method.
Constructor-local values therefore do not become ambient inherited state unless
they are written into shared channels or forwarded explicitly in payload.

All shared channels should be declared before any `extends` and before any
`super()`-driven inherited work that depends on them.

Shared defaults follow the inheritance contract:

- `shared x = default` means initialize-if-not-set
- a more-derived shared default wins over an ancestor default
- a later plain assignment overwrites the current value

Shared default handling should stay simple:

- when a shared channel is declared for the first time, its default value is
  set
- if that shared channel was already declared earlier in the chain, the new
  default value is ignored
- `with ...` / `compositionPayload` does not override shared defaults, even
  though shared defaults may read values from that payload

Per-channel-type shared rules stay explicit:

- `shared var x = value` is allowed
- `shared text x = value` is allowed
- `shared data x = value` is allowed
- `shared sequence db = sinkExpr` initializes the shared sequence
- `shared sequence db` declares participation without an initializer

Shared channel metadata should be described with the same lifecycle as method
metadata:

- compiled child access to an unknown shared channel creates a pending entry
- each parent resolves the entries it can define and replaces them with the
  actual metadata
- unresolved entries at the topmost parent are rejected and become fatal on
  await

Shared channel declaration should only do work when the channel does not yet
exist. Re-declaring an already existing shared channel with the same type is
effectively a no-op.

Re-declaring an existing shared channel with a different type is a
`RuntimeFatalError` as soon as it is detected, then normal fatal handling
applies.

## Startup and Registration

For scripts/templates that define blocks or methods, the first thing the
script does at startup is wire its local method metadata into the shared method
object. That is where child-overrides-parent semantics are established.

Startup order should stay simple:

- shared-channel register / resolve / reject
- method register / resolve / reject
- `super` register / resolve / reject
- parent call if `extends` is present

Startup register / resolve / reject is synchronous. It only updates the shared
metadata object using already-available local metadata:

- declare if missing
- resolve if the current entry is a promise structure
- wire `super` if a child method uses `super()` and the local parent method
  matches
- replace the effective method entry for that method name with the child
  override so later lookup returns the topmost callable first

Each script/template tries to resolve pending methods, pending shared channels,
and pending method `super` entries using its own local definitions. When the
actual root script/template is reached, any still-pending entries are rejected
there. At that point there is no parent left that could legally satisfy them.

The parent script resolves all method object / `super` promises that it can and
replaces the target with the resolved local object. It adds its own methods to
that object for methods that are not already there and passes it to the parent
if `extends` is used. If no `extends` is used and there are still pending
method or `super` entries that have not been resolved, these are rejected as
fatal errors.

Each script/template adds shared channels to the shared schema when they do not
exist yet, resolves pending entries when it can, and rejects unresolved ones
when it is the root.

## Constructors and `extends`

Constructor dispatch should not be a special runtime model. It is compiled as
an imported call to `__constructor__`, and then resolved and linked exactly
like any other method call.

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

`extends` creates an async boundary. Code after `extends` executes in a later
async boundary / command buffer, similar in spirit to how other structural async
boundaries split execution.

The initial entrypoint is the import-run script/template itself. It executes
exactly like a normal import-run wrapper, but it receives the shared metadata
object and uses it for method dispatch and shared-channel access. It returns
the shared metadata object.

Imported components should not have a meaningful return value of their own.
Component constructor return is ignored so one script can still serve both as a
component and as an extended script. In all cases, the runtime value that
matters is the shared metadata object.

## Method Dispatch and `super()`

The method calls reference the method from the method object, which can be
either the promise structure or a resolved object.

Inherited dispatch is explicit:

- `this.method(...)` participates in inheritance lookup
- bare `foo()` remains an ordinary local/context/global call
- `this.method` without a call is a compile-time error

Inherited methods operate on shared state, method arguments, and method
payload. They do not depend on ancestor-private constructor-local channels.

Sequential `!` paths inside inherited methods should work like normal Cascada
sequential paths, but this can be deferred in the implementation plan.

When a child defines the same method name as its parent, child overrides
parent. If that child method uses `super()`, the child's local startup wiring
creates a pending `super` entry in the child's `super` property. The parent
resolves that pending entry during its own startup wiring, so the later helper
resolution lands on the parent's final resolved method object.

`super` should stay part of the resolved method metadata shape rather than
becoming a separate lookup table. A `super()` call should resolve that `super`
property through the same helper model, or through a dedicated helper that
behaves the same way.

Each method call should still create its own child invocation buffer after the
target metadata is current. That child invocation buffer lives inside the
shared command-buffer tree. Exact linking is done for that call buffer at that
point.

## Helper Model and Late Linking

Do not read raw `ownUsedChannels` / `ownMutatedChannels` directly from the
stored method metadata object. Instead, use one public helper that resolves and
returns the full callable data needed by side-channel apply. A good name for
this helper is `getMethodData(...)`.

`getMethodData(...)` should:

- resolves the method entry if it is still pending
- recursively resolves the complete reachable `super` chain for that callable
- computes merged channel information for each level from the resolved chain
- returns the callable data required for the actually executed call target
- memoize the fully resolved callable data on the resolved raw entry as an
  optimization

The promise returned by that helper is the actual barrier used by side-channel
apply. The barrier is not "get the metadata object", but "resolve the effective
method data needed for the current call".

There are two kinds of side-channel commands:

- method-call commands
- shared-channel-lookup commands

The helper described above is the exact-link-after-load mechanism. It is
awaited by `apply()` before linking, and it does not resolve until the
effective method entry is fully available.

`extends ... with ...` payloads should follow the same chain-through model in
both templates and scripts:

- the payload object is captured at the `extends` site
- it may pass unchanged through intermediate parents that do not declare those
  explicit inputs themselves
- validation should happen where an include/import-style isolated composition
  boundary actually consumes externs, not at each intermediate inheritance hop

Internally, the public helper may use one recursive helper that resolves a raw
entry to resolved callable data:

- if the raw entry has no `super`, the merged channels at that level are just
  the local `ownUsedChannels` / `ownMutatedChannels`
- if the raw entry has a pending `super`, await it and replace the raw `super`
  field with the resolved raw parent entry
- recurse into the parent entry so the whole `super` chain is resolved
- build the current level's `mergedUsedChannels` / `mergedMutatedChannels` from
  the current local channels plus the resolved parent level's merged channels

`super` should stay part of the resolved callable data shape as the next
same-shape callable-data level, or `null` when there is no parent level.

The resolved callable metadata shape should be explicit, for example:

- `fn`
- `signature`
- `ownUsedChannels`
- `ownMutatedChannels`
- `mergedUsedChannels`
- `mergedMutatedChannels`
- `super`

`super` in this resolved callable-data shape is not a pending promise
structure. It is either:

- the same resolved callable-data shape for the next level
- or `null`

Current-call linkage uses the current level's merged channel effect set:

- `ownUsedChannels` / `ownMutatedChannels` describe the local body only
- `mergedUsedChannels` / `mergedMutatedChannels` describe the current callable
  level plus the reachable `super` chain from there
- because the current callable may execute `super()`, its conservative effect
  set includes that reachable parent work

So `super()` execution remains lazy, but channel metadata is conservative:

- current-call side-channel apply links using the current level's merged effect
  set
- later `super()` execution reuses the already-resolved `super` metadata level
  rather than doing a second ancestry walk
- "exact" means exact to the resolved callable's full inherited effect set, not
  merely to the current level's local body text

This still must not turn into broad unrelated linkage:

- merged callable metadata may include the reachable `super` chain
- it must not widen into blanket `sharedSchema` / hierarchy-wide linking for
  channels the callable chain does not touch

This is important for correctness as well as performance: broad eager
resolution/linking can serialize later unrelated shared-channel work and
violate the architecture's intended concurrency model.

Entry replacement belongs to startup registration, not to the helper. The
helper may still memoize fully resolved callable data on a resolved raw entry
so repeated calls do not redo the same recursive merge work.

When apply requests metadata through the helper, it awaits the already-shared
entry reference. By the time that await resolves, startup replacement has
already happened. The helper only resolves pending parent links, computes the
resolved callable-data chain, and memoizes derived merged metadata such as the
effective channel sets.

Call sites should not read `ownUsedChannels` / `ownMutatedChannels` directly
from the raw stored entry. They should go through the helper, which resolves
the effective method target and computes callable data for the resolved
callable's inherited effect set. Execution of `super()` remains lazy, but the
linked/waited channel metadata is conservative for that callable level.

## Shared-Channel Access

Shared channel access should use a dedicated helper, analogous to the method
helper. It:

- resolves the channel entry if it is still pending
- returns the effective channel metadata required for command creation
- may memoize derived metadata on the resolved entry as an optimization

The promise returned by the shared-channel helper is the barrier for
caller-side shared-channel access. Side-channel apply must await it before
adding the command that reads from the shared channel.

Unresolved inherited method references that are discovered during analysis
should be compiled as pending method entries, not as `null` placeholders. Those
pending entries may carry a narrow structural hint of the locally declared
shared lanes for that file so the call site can still reserve source-order
position before the parent method body is known. This is only a local fallback
for unresolved inherited methods; it must not widen into runtime-wide
`Object.keys(sharedSchema)` linkage.

Shared channel lookup from the caller script/template mirrors method lookup. It
uses a dedicated helper that:

- waits until the shared schema contains the requested channel
- returns the effective shared-channel metadata once the channel is known
- throws if the topmost parent is reached and the channel still does not exist

That shared-channel helper uses the same pending/resolved/rejected model as
method entries. The helper result is the effective shared-channel metadata used
to choose and construct the side-channel command.

Allowed shared-channel operations should stay explicit:

- `snapshot()`
- `is error`
- `#`
- implicit `var` snapshot when no more specific operation is requested

Any other operation should fail dynamically with a good fatal error if the
channel does not support that access pattern. For non-`var` channels, method
calls should be used instead.

Method-call side-channel commands await helper-resolved used/mutated channel
metadata. Shared-channel-lookup side-channel commands await helper-resolved
shared-channel metadata.

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

Components use the same shared metadata object model. On the caller side,
`apply()` should:

- look up the method in the shared component metadata object
- create the promise structure if the method is not present yet
- resolve the effective method data and merged channel metadata through the
  helper
- await that helper result when needed
- perform linking only after that resolution step completes

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

- unresolved entries at the topmost parent are fatal and reject
- helper rejection during apply/link is fatal
- missing `__constructor__` is only non-fatal when no local constructor exists
  and normal inherited lookup can continue to an ancestor constructor; an
  unresolved pending `__constructor__` at the topmost parent is fatal

Topmost-parent rejection becomes observable when apply awaits the helper. If
that await rejects, apply should report the failure through `cb()` and throw
`RuntimeFatalError`.

Error and poison propagation follow ordinary Cascada rules. This redesign
changes where work is attached and where shared-root apply may stall; it does
not change poison semantics.

## Static Analysis

Static analysis requirements stay narrow:

- shared schema declared by each file
- upfront method metadata including internal `__constructor__`
- override metadata needed for runtime inheritance resolution
- no caller-side method read/write tracking for component scheduling
- no wildcard parent-lane linking for unresolved inherited calls

## Compatibility

Compatibility requirements should still be preserved:

- plain scripts and templates without `extends`
- plain `import`, `from import`, and `include`
- existing `extern` / `with` behavior for non-inheritance composition
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
literal path. It should work through the same composition model rather than a
separate architecture, and remains deferred until the static model is stable.
Dynamic `extends` waits for parent-name resolution and loading.
