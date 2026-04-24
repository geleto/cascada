# Blocking `extends` Metadata Architecture

This document describes a stricter inheritance model for Cascada `extends`.

It replaces the current runtime-pending method-metadata resolution model with a
blocking inheritance-chain bootstrap:

- the inheritance chain is fully loaded before constructor/root execution starts
- method metadata is accessed directly, not through pending promise structs
- `super()` remains special and owner-relative
- `mergedUsedChannels` / `mergedMutatedChannels` include all invoked inherited
  methods, not only the `super()` chain

The central new metadata is `invokedMethods`. It is represented at two levels:

- file-level `invokedMethods` records every ordinary inherited method
  referenced by the file
- per-callable `invokedMethods` records the resolved inherited methods that
  a specific constructor, method, or block may call

Compiled metadata will initially store invoked method names. The bootstrap helper
loads the full inheritance chain, resolves those names to the final overridden
method metadata, and replaces the names with the resolved data before execution
starts. The final channel footprint for a method is computed from its own
channels, its `super()` chain, and its per-callable invoked metadata.

Terms:

- file-level `invokedMethods`
  - compiled root metadata for all ordinary inherited method names referenced by
    the file
- inheritance-state `invokedMethods`
  - bootstrap-resolved name -> final overridden method metadata map for the
    whole inheritance instance
- per-callable `invokedMethods`
  - filtered name -> final overridden method metadata map for one constructor,
    method, or block

The goal is to remove the current class of under-linked unresolved inherited
admissions while keeping the overall callable/runtime shapes close to the
current implementation.

## Why Change

The current model allows execution to begin while parts of the inheritance
metadata are still unresolved.

That creates a structural hole:

- a method call may be admitted before its full linked-channel footprint is
  known
- later work may begin based on a narrower partial footprint
- once the method metadata resolves, we may discover that the earlier call
  should have blocked later work on additional channels

This is especially problematic when:

- one inherited method mutates a shared channel
- another inherited or local method reads that channel
- the mutating method was admitted before its full metadata footprint was known

This is not just a plain-root problem. It can also appear in:

- method inside method
- component method inside method
- component constructor followed by later method operations

The current `super()`-chain merge is also too narrow:

- it only describes the current method and its owner-relative `super()` chain
- it does not describe ordinary `this.otherMethod()` dependencies
- so caller-side admission/linking is incomplete even when the chain itself is
  already loaded

## Core Decision

The inheritance chain should be treated as structural metadata, not as
late-arriving business data.

So the new model is:

1. load the full inheritance chain first
2. register all methods and shared schema for the chain
3. build final direct method metadata references
4. only then start constructor/root execution

After that point:

- no method metadata promise structs are used in normal execution
- method metadata is read directly from `inheritanceState.methods[name]`
- `super()` still has special handling, but it also resolves against already
  built direct metadata

## High-Level Runtime Model

The runtime has two phases:

### 1. Blocking Inheritance Bootstrap

This phase happens before constructor/root execution.

Responsibilities:

- resolve the parent selection at the `extends` site
- load the entire parent chain
- compile all files in the chain
- detect inheritance-chain cycles
- register:
  - methods
  - shared schema
  - composition payload
- finalize the resolved method graph
- finalize shared-root ownership
- after the chain is loaded, collect all structural metadata errors discovered
  during graph finalization before throwing, so no method/super/invoked-method
  error is lost

At the end of this phase, the instance inheritance state contains direct,
non-promise metadata objects.

Dynamic `extends` participates in the same blocking bootstrap. The dynamic
parent expression is resolved first; then the full chain for that resolved
parent is loaded and finalized before constructor/root execution starts.

### 2. Execution

Only after bootstrap completes:

- constructors run
- blocks/methods run
- component instances become available

Execution is allowed to assume:

- `inheritanceState.methods[name]` is either a direct resolved method metadata
  object or missing
- `methodMeta.super` is either a direct resolved metadata object or `null`
- `methodMeta.invokedMethods` is a direct map of method name to resolved method
  metadata

No normal inherited dispatch path should need to `await` metadata resolution.
Constructor startup is also delayed until the full inheritance chain has loaded
and the final metadata graph is built.

## Method Metadata Shape

The shape should stay the same as the current resolved metadata shape wherever
possible, but direct and fully built.

Resolved method metadata should have at least:

- `fn`
- `signature`
- `ownerKey`
- `ownUsedChannels`
- `ownMutatedChannels`
- `super`
- `invokedMethods`
- `mergedUsedChannels`
- `mergedMutatedChannels`

Where:

- `super`
  - compiled value is `true` when the callable contains `super()`
  - compiled value is `false` or `null` when the callable does not contain
    `super()`
  - after bootstrap, the value is a direct resolved owner-relative `super()`
    target or `null`
  - never a promise or pending entry
- `ownerKey`
  - identifies the implementation owner in the loaded inheritance chain
  - bootstrap uses it to resolve owner-relative `super()` targets
  - ordinary `this.foo()` dispatch ignores `ownerKey` and resolves to the final
    overridden method
- `invokedMethods`
  - object map
  - key = method name
  - initial compiled value is the method name
  - after bootstrap, each value is the direct resolved method metadata object
  - ordinary calls resolve to the final overridden method, not an owner-relative
    parent entry
  - excludes `super()` because `super()` is already represented by `super`

Compiled callable metadata shape:

```js
{
  fn,
  signature: { argNames: ["name"], withContext: false },
  ownerKey: "C.script",
  ownUsedChannels: ["trace"],
  ownMutatedChannels: ["theme"],
  super: true,
  invokedMethods: {
    readTheme: "readTheme",
    applyTheme: "applyTheme"
  }
}
```

Bootstrap rewrites that to resolved method metadata before execution:

```js
{
  fn,
  signature: { argNames: ["name"], withContext: false },
  ownerKey: "C.script",
  ownUsedChannels: ["trace"],
  ownMutatedChannels: ["theme"],
  super: parentBuildMeta,
  invokedMethods: {
    readTheme: resolvedReadThemeMeta,
    applyTheme: resolvedApplyThemeMeta
  },
  mergedUsedChannels: [...],
  mergedMutatedChannels: [...]
}
```

## Script-Level Invoked Method Catalog

The callable-local `invokedMethods` map cannot be built in isolation.

We also need a file-level catalog during bootstrap.

Each compiled file should expose, in addition to `methods` and `sharedSchema`,
an inheritance-call catalog for the whole file:

- `invokedMethods`
  - file-level object map of ordinary inherited method names referenced
    anywhere in that file's constructor/methods/blocks
  - initial compiled values are the method names
  - after bootstrap, values are direct resolved method metadata objects
  - the resolved value is the final overridden method metadata for that name

This is needed because bootstrap order is:

1. load chain
2. register method table
3. resolve file-level `invokedMethods` keys against the final method table
4. populate each callable's `invokedMethods` map from that resolved catalog

The file-level catalog should use the same key/value shape as callable-local
`invokedMethods` so there is only one metadata concept.

Compiled file-level shape:

```js
{
  methods: { ... },
  sharedSchema: { ... },
  invokedMethods: {
    build: "build",
    readTheme: "readTheme",
    applyTheme: "applyTheme"
  }
}
```

Then bootstrap replaces it with:

```js
inheritanceState.invokedMethods = {
  build: resolvedBuildMeta,
  readTheme: resolvedReadThemeMeta,
  applyTheme: resolvedApplyThemeMeta
}
```

And finally each method can receive:

```js
methodMeta.invokedMethods = {
  readTheme: inheritanceState.invokedMethods.readTheme,
  applyTheme: inheritanceState.invokedMethods.applyTheme
}
```

This preserves the user-preferred shape:

- key = method name
- value = method metadata

The per-callable map is exactly the subset of file-level `invokedMethods` that
the compiler found in that callable body. If a callable directly invokes
`this.readTheme()` and `this.applyTheme()`, only those names are copied into
that callable's `invokedMethods` map.

If a name listed in compiled `invokedMethods` does not exist in the final method
table, bootstrap records a fatal metadata error. It should be reported during
graph finalization before execution starts, alongside unresolved `super()`
metadata errors.

## `super()` Stays Special

`super()` should not be normalized into ordinary invoked-method lookup.

Reasons:

- it is owner-relative
- it does not dispatch through overrides the same way `this.foo()` does
- it walks from the current owner to the next parent implementation

So:

- ordinary inherited calls use `invokedMethods`
- `super()` uses `super`
- calling `super()` when no parent implementation exists throws a runtime fatal
  error

This keeps the current conceptual distinction and avoids forcing one mechanism
to represent two different dispatch rules.

If multiple `super()`/method metadata errors are discovered after the chain is
loaded, they should be reported together through the runtime fatal-error path
rather than failing on the first error and hiding the rest.

Implementation should collect these graph-finalization errors into an array and
throw once after the pass finishes. This mirrors the "no error shall be lost"
principle for structural metadata: once the chain is available, missing
`super()` targets, missing `invokedMethods` targets, and invalid metadata shapes
should all be surfaced together when possible.

## Meaning of `mergedUsedChannels` / `mergedMutatedChannels`

These fields should change meaning slightly.

Today they effectively describe:

- current method
- plus its `super()` chain

That is not enough.

In the new model they should describe the full callable footprint:

- current method's own channels
- plus all owner-relative `super()` dependencies
- plus all ordinary inherited methods invoked by this method

So:

- `mergedUsedChannels`
  - full transitive used-channel footprint of the callable
- `mergedMutatedChannels`
  - full transitive mutated-channel footprint of the callable

This is what caller-side invocation admission actually needs.

## Bootstrap Merge Passes

Merged-channel calculation happens after the full inheritance chain is loaded
and all method metadata is resolved.

It should be implemented as deterministic bootstrap passes, not as runtime
recursive metadata resolution:

1. Register parent methods before child methods.
2. Compute each implementation's inherited/super footprint parent-to-child:
   - start with the method's own used/mutated channels
   - if the method has a parent/super implementation, merge the parent's
     already-computed merged channels
   - deduplicate channels
3. Resolve `invokedMethods` names to final overridden method metadata:
   - each `this.foo()` dependency becomes `invokedMethods.foo = methods.foo`
   - this is ordinary override dispatch, not owner-relative `super()` dispatch
4. Compute the final callable footprint by adding invoked-method footprints.

Step 4 should not use runtime promises or lazy resolution. If invoked methods
can form cycles, use an iterative fixed-point pass until no method's merged
channel set changes. This avoids recursive call-stack traversal while still
supporting cycles.

This is distinct from `extends` parent-chain cycles. Parent-chain cycles are
fatal structural bootstrap errors. Invoked-method cycles are valid call-graph
metadata and are handled by the fixed-point channel merge.

Cycle examples:

- `build()` invokes `render()`
- `render()` invokes `build()`

The fixed-point pass treats the method graph as a directed graph and computes a
stable union of channels. A method's final merged channels are:

- its own channels
- its inherited/super footprint
- the final merged channels of every resolved `invokedMethods` target

The pass ends when another full scan produces no new channel names.

## Caller-Side Admission / Linking

Caller-side invocation admission should use the direct metadata object.

That means:

- no metadata await
- no pending resolution helper
- no partial unresolved linked-channel hint path

The current caller-side logic that only uses the `super()` chain must be
replaced.

Caller-side linking should use:

- current method meta
- full `mergedUsedChannels`
- full `mergedMutatedChannels`

That automatically includes:

- `super()` chain effects
- `this.otherMethod()` dependencies
- nested inherited-call dependencies

This is the main correctness improvement.

## Method Entry Startup

At the top of a compiled constructor/method/block entry, the runtime should not
need to resolve metadata asynchronously.

Instead:

- `methodData` is already direct and final
- `methodData.invokedMethods` is already direct and final

So entry startup can:

- link parent/invocation buffers with the final merged channels
- use `methodData.invokedMethods` immediately where additional dynamic channel
  lists are needed

No separate `resolveMethods(...)` helper is needed in the final execution path
if the bootstrap phase already built the final direct graph.

The normal execution path should pass direct metadata objects around instead of
calling a metadata-resolution helper. A small synchronous guard such as
`requireMethodData(...)` may still be useful for diagnostics at public runtime
boundaries, but it should only validate/read direct metadata and throw a runtime
fatal error for missing or invalid entries.

## Per-Method Compiled Channel-List Helpers

Each compiled constructor/method/block entry should incorporate the channel
footprints of the inherited methods it calls.

Instead of emitting only static arrays such as:

```js
["channel1", "channel2"]
```

the compiler should emit helper calls inside the compiled method entry that
append the relevant invoked-method footprints:

```js
runtime.mergeUniqueChannelNames(
  ["channel1", "channel2"],
  methodData.invokedMethods.build.mergedUsedChannels,
  methodData.invokedMethods.render.mergedUsedChannels
)
```

The same pattern applies to mutated-channel lists inside that method:

```js
runtime.mergeUniqueChannelNames(
  ["channel1"],
  methodData.invokedMethods.build.mergedMutatedChannels
)
```

This helper should be sync-only and cheap:

- it concatenates channel-name arrays
- it removes duplicates
- it ignores missing/empty arrays
- it does not resolve metadata or await anything

The important rule is that each callable's compiled channel handling should read
from that callable's already-resolved `methodData.invokedMethods`. It should not
rediscover invoked methods, call a metadata-resolution helper, or fall back to
pending entries.

Missing invoked-method metadata is not an "empty array" case. If compiled code
references `methodData.invokedMethods.build`, bootstrap must have resolved that
entry. If it is absent at execution time, that is a runtime fatal metadata error.

## Shared Schema

The same principle applies to shared schema:

- blocking bootstrap should produce final direct shared schema
- normal execution should not depend on pending shared-schema entries
- all shared channels used by a constructor, method, or block must be declared
  as `shared` in that file
- bare constructor/body channels that are not declared as `shared` are local to
  that body and are not visible to methods

This keeps method and shared metadata consistent:

- both are structural
- both are fully known before execution begins

There should be no ambiguous shared-name probing in the final model. A name is
shared because the current file declares it as shared. It is not shared merely
because an ancestor declares a channel with the same name.

## Components

Components should follow the same inheritance-bootstrap rule.

Before a component constructor can run:

1. load and compile the full inheritance chain for the component script
2. build final method/shared metadata
3. only then start constructor execution through the component startup path

This keeps component method calls and component shared observations on the same
fully built metadata model as ordinary script/template inheritance.

Component constructor startup still belongs to the caller-side ordered component
startup path. The metadata bootstrap must complete before that startup command
runs, but constructor ordering relative to later component operations is still
preserved by the component operation scheduling model.

Component creation should mirror import-style deferred availability: the
component binding is available immediately as a promise-like value, and that
value resolves to the complete component instance once blocking metadata
bootstrap and ordered constructor startup have finished.

Metadata/loading caches are intentionally out of scope for the first
implementation. Each component instance may build its own inheritance metadata
graph. Read-only chain or compiled-template caching can be added later as an
optimization without changing this model.

## Templates

Templates should use the same metadata principle:

- constructor/block metadata is fully built before execution
- block invocation linking uses final direct metadata
- top-level template parent loading blocks before execution starts

Text-output ownership still differs from scripts, but metadata resolution
should not.

This architecture applies to async templates and scripts only. The synchronous
Nunjucks-compatible template path should remain unchanged.

## What Goes Away

This design should let us remove the current runtime-pending metadata model
from normal execution:

- no pending method promise structs during execution
- no pending shared promise structs during execution
- no metadata-await helper in the hot path
- no partial unresolved linked-channel hints as a correctness mechanism

Any remaining async work is only:

- loading/compiling the parent chain up front
- ordinary business-data async values during execution

## Compatibility Goal

The target is:

- no intentional language-semantic change
- same source behavior
- simpler and more correct compiled/runtime metadata model

The big internal change is:

- metadata becomes blocking structural bootstrap
- not deferred hot-path resolution

## Implementation Plan

### Step 1 - Remove Pending `super()` Metadata Resolution, No Functional Change

Convert the current `super()` metadata path to direct metadata while preserving
current user-visible constructor/output ordering.

Work:

- remove pending promise structs from compiled `super()` metadata
- compile callable `super` as:
  - `true` when the callable body contains `super()`
  - `false` when it does not
- detect `extends` parent-chain cycles as fatal bootstrap errors
- register methods/shared schema as each chain member loads
- rewrite compiled `super: true` references to direct parent metadata
- rewrite root-constructor `super: true` to the root-only empty constructor when
  no parent constructor exists
- rewrite unresolved non-constructor `super: true` to a fatal metadata error
- keep `super: false` callables compatible with the current parent metadata
  chain used for signature inheritance and the existing merged-channel behavior
- preserve the current callable metadata fields where possible:
  - `fn`
  - `signature`
  - `ownerKey`
  - own channel arrays
  - `super`
- build sync-first method metadata for already-resolved entries
- finalize/cache merged channel fields for direct entries during metadata
  finalization
- publish the inheritance startup promise before constructor execution so an
  early constructor-local inherited call that reaches unresolved `super: true`
  can wait for the active chain load and then retry against direct metadata
- keep pending inherited-method placeholders for unresolved `this.method()` calls
  as transitional scaffolding until invoked-method metadata replaces them

Goal:

- no promise-based `super()` metadata structs
- no promise-based metadata access for already-resolved direct method entries
- no intentional behavior change yet
- known transitional exception: unresolved `this.method()` placeholders and the
  constructor-time startup-promise retry remain until the invoked-method metadata
  and direct caller-side admission phases remove them

### Step 2 - Add Invoked-Method Metadata

Add invoked-method information to both the file-level metadata and each
callable metadata object.

Work:

- compiler collects file-level `invokedMethods`
- compiler collects per-callable `invokedMethods`
- compiled values are method-name strings
- bootstrap resolves the file-level catalog against the final method table
- bootstrap populates each callable's `invokedMethods` map using the resolved
  catalog
- keep the shape:
  - key = method name
  - value = method metadata

Think carefully about storage:

- file-level `invokedMethods` should be an object keyed by method name
- file-level values start as method names, then bootstrap should replace
  them with final override-resolved method metadata
- runtime/bootstrap-level `inheritanceState.invokedMethods` should become the
  resolved name -> method-meta map
- each callable's `invokedMethods` should be a filtered direct reference map into
  that resolved catalog

Goal:

- any method can inspect all its directly invoked inherited methods without any
  await or promise resolution

### Step 3 - Redefine `mergedUsedChannels` / `mergedMutatedChannels`

Change merged-channel semantics from:

- own method + `super()` chain

to:

- own method + `super()` chain + full invoked-method tree

Work:

- compute inherited/super footprints parent-to-child after metadata resolution
- compute invoked-method footprints with an iterative fixed-point pass
- deduplicate channels
- keep `super()` special and separate
- compute final merged channel sets during bootstrap
- report all method/super/invoked-method metadata errors discovered after chain
  loading through the runtime fatal-error path
- aggregate all structural metadata errors discovered by the Step 3 merge/fixed-
  point pass before throwing, so multiple missing `super()` or invoked-method
  targets are reported together instead of stopping at the first error
- replace the Step 2 immediate missing-invoked-method throw path with the same
  aggregated structural metadata error collection used by the merge pass

Goal:

- caller-side invocation admission gets the full callable footprint

### Step 4 - Add Metadata Readiness Barrier

Make inheritance metadata readiness explicit before caller-side admission starts.

Work:

- replace the Step 1 constructor-time startup-promise retry with a true
  metadata-ready barrier that does not wait for parent output application
- make pending-placeholder methods participate through direct metadata readiness
  instead of relying on the Step 1 transitional placeholder path
- remove the startup-window channel-hint gap where an unresolved `super: true`
  currently creates its invocation buffer before final method channels are known
- remove the transitional string-value fallback in invoked-method data resolution
  that exists only for constructor-time startup retry windows
- keep component constructor startup on the caller-side ordered component startup
  path, but ensure metadata bootstrap completes before the startup command runs
- keep template text-output ownership separate from metadata bootstrap

Goal:

- no inherited invocation starts from a partially resolved metadata graph
- no constructor-local call path needs a startup-promise retry to discover
  metadata

### Step 5 - Use Direct Metadata in Caller-Side Admission

After metadata readiness is explicit, replace current caller-side channel
collection with direct use of the new final metadata.

Work:

- stop using only the `super()` chain for caller-side linking
- use final direct `methodMeta.mergedUsedChannels`
- use final direct `methodMeta.mergedMutatedChannels`
- remove the partial unresolved-linked-channel correctness path
- remove provisional invocation-buffer creation for known direct entries; once
  readiness is explicit, caller-side admission should create/link buffers from
  final direct method metadata only
- remove temporary unresolved-super/provisional-buffer guards that exist only to
  bridge Step 4 readiness into the old caller-side admission code
- remove invocation-command metadata-readiness bridge fields
  (`waitForMetadataReady`, `deferUntilApplied`) once admission always starts
  from finalized direct method metadata
- add or update coverage for the script-mode metadata-pending invocation path
  after the direct admission refactor settles that control flow

Goal:

- correct invocation admission for:
  - method inside method
  - component method inside method
  - constructor followed by later inherited call

### Step 6 - Use Direct Metadata Inside Methods Where Needed

Only after Steps 1-5, incorporate the dynamic method-footprint handling inside
compiled constructor/method/block bodies.

Work:

- where callable bodies currently need channel lists, use direct
  `methodData.invokedMethods`
- use `runtime.mergeUniqueChannelNames(...)` or equivalent direct merged-channel
  helpers without await
- treat missing `methodData.invokedMethods.foo` as a fatal metadata error, not
  as an empty channel list
- keep entry-local code simple because bootstrap already did the hard work

Goal:

- method body/channel logic is consistent with caller-side admission
- no split between what caller-side thinks a method touches and what method
  startup later discovers

### Step 7 - Consolidate Metadata Finalization

After the direct metadata model is used by admission and method bodies, collapse
the transitional metadata construction/finalization paths into one direct model.

Work:

- replace the Step 2 `resolveAndWireInvokedMethodCatalog(...)` bridge that
  creates method metadata first and patches `invokedMethods` afterward with a
  single direct metadata construction path
- add source-origin metadata for compiled invoked-method and `super()` references,
  then use it for finalization-time metadata errors so they can report original
  call-site line/column instead of only the file path
- consolidate finalization error aggregation so recoverable structural errors
  from catalog wiring, cache prewarming, and footprint validation are collected
  together; immediate throws should remain only for impossible invariants
- keep impossible invalid-metadata invariant failures explicitly fail-fast, or
  document any cases that should be promoted into recoverable aggregation
- add stable structural error codes for invalid inheritance metadata shapes once
  those errors are part of the consolidated finalization model
- keep the super-chain footprint merge folded into the fixed-point pass as the
  intentional implementation model, and document that so later cleanup does not
  reintroduce a second parent-to-child merge phase
- remove the unused caller-supplied `errors` parameter from
  `finalizeMethodChannelFootprints(...)` if the consolidated finalization path
  no longer needs it
- remove the `includeInvokedMethods` boolean flag from method-data resolution
  helpers when direct metadata construction no longer needs a partial catalog
  construction mode
- decide whether direct-call admission should cache pre-merged invocation-link
  channels on resolved method metadata instead of recomputing them per call
- decide whether callable-body linking should cache pre-merged direct body-link
  channels on resolved method metadata instead of recomputing them per entry
- consolidate `invokeInheritedMethod(...)` and `invokeSuperMethod(...)` around
  one shared direct-admission helper if the remaining differences stay narrow
- inline or remove `_enqueueInvocationCommand(...)` if it remains only a thin
  enqueue/start wrapper after command lifecycle cleanup settles
- collapse the remaining thin `invocationInternals` wrapper if command
  invocation lifecycle no longer needs that extra namespace boundary
- decide whether `mergeUniqueChannelNames(...)` should remain a public runtime
  helper or collapse back into the consolidated inheritance-metadata helper
  layer once direct metadata construction is unified
- consolidate duplicated linked-channel path helpers in the bootstrap and
  invocation-linking modules into one runtime helper
- remove the legacy async-block `if (parent) return ""` guard if it remains
  dead after finalization moves fully onto the direct metadata path
- document or simplify the metadata-ready microtask-yield mechanism after the
  direct admission/body paths no longer depend on transitional startup timing

Goal:

- one direct metadata construction path
- one structural metadata finalization pass
- better finalization-time diagnostics without reintroducing lazy metadata
  resolution

### Step 8 - Require Explicit Per-File Shared Declarations

After metadata construction/finalization is consolidated, tighten the language
contract for shared state:

- every file in an inheritance chain must declare every shared var/channel it
  wants to read, write, snapshot, error-check, or otherwise use as shared state
- parent-chain visibility alone is no longer enough to authorize shared-state
  access in a child file
- an undeclared identifier is not shared-state use. It follows ordinary lookup
  rules: context object, globals, render/composition payload, and other normal
  ambient lookup surfaces

This step intentionally changes the contract. It is not only cleanup.

Why this step exists:

- today, template-block bare-name lookup can still be justified by the merged
  chain-level `sharedSchema`, even when the current file did not declare that
  shared name itself
- that makes shared visibility less local and less explicit than method
  dispatch, because `this.method()` already depends on explicit metadata while
  some shared reads can still be rescued by chain-level probing
- requiring declarations for every shared access makes the shared-state
  contract local and predictable, while preserving ordinary ambient lookup for
  undeclared identifiers

What this simplifies:

- the compiler/runtime no longer need a "maybe shared" rescue path for template
  blocks
- unresolved bare-name reads in blocks no longer need to be preserved as
  `sharedLookupCandidates` and filtered later against the final chain schema
- body-local linking logic no longer needs a special decision about whether to
  include chain-derived `sharedLookupChannels`; the file's own declarations
  become the only authority for what shared names may be linked from that file
- lookup semantics become clearer because an undeclared identifier is always
  ambient lookup and never a chain-shape-dependent shared fallback

What this changes:

- shared declarations become a per-file interface, not only a chain-level merge
  input
- if `child.njk` wants to read or write the shared channel `theme`,
  `child.njk` must declare `shared var theme` even if `base.njk` already
  declared it
- if `child.njk` uses undeclared `theme`, that remains normal ambient lookup
  rather than shared-channel access
- the final chain merge still validates compatibility and chooses the effective
  shared entry for execution, but that merged schema no longer retroactively
  authorizes undeclared identifiers as shared access in another file
- ordinary lookup and explicit shared observation remain separate mechanisms:
  declared shared access enqueues on the current buffer and uses inheritance
  metadata, while undeclared bare-name/block access follows ordinary ambient
  lookup rules

Work:

- make per-file shared declarations the required source of truth for all shared
  usage in constructors, methods, and template blocks
- ensure undeclared identifiers do not probe or link inherited shared state,
  even when the final merged chain-level `sharedSchema` contains the same name
- remove `sharedLookupCandidates` collection from compiled callable metadata
  once no execution path needs to preserve unresolved "maybe shared" names
- remove runtime filtering/probing paths such as
  `_filterSharedLookupChannels(...)` that only exist to rescue undeclared block
  reads from the chain-level schema
- make callable body-linking and caller-side linking rely only on explicit
  per-file shared declarations plus direct method metadata, never on chain-level
  shared-name discovery
- update tests so inherited shared access is covered through explicit repeated
  declarations in each participating file, and add coverage that undeclared
  same-named identifiers remain ordinary ambient lookup
- document the user-visible rule clearly: shared state is chain-visible at
  runtime, but each file must still declare the shared names it wants to use as
  shared state. Undeclared identifiers are not shared-state access

What this removes:

- ambient chain-level authorization for undeclared shared access
- the remaining semantic need for `sharedLookupCandidates`
- the Step 6/7 design question about whether body-local linking should include
  chain-derived `sharedLookupChannels`; under this rule, undeclared ambient
  lookup is never shared-name rescue

Goal:

- shared-state usage is explicit per file
- shared linking is driven by declarations, not by fallback probing
- undeclared identifiers stay on the ordinary ambient lookup path and never
  become shared access because of ancestor declarations

### Step 9 - Remove Now-Redundant Runtime Paths

After the direct metadata model is in place and per-file shared declarations are
enforced:

- remove pending-entry metadata resolution helpers from the hot path
- remove unresolved method-metadata admission logic
- remove temporary `bootstrapInheritanceMetadata(...)` argument-shape
  compatibility scaffolding once all internal callers and tests use the
  explicit invoked-method catalog parameter
- remove any remaining transitional boolean control-flow flags from internal
  method-data resolution after direct metadata construction is consolidated
- remove obsolete tests that only exist for promise-struct metadata behavior
- replace them with integration coverage around blocking bootstrap and full
  invoked-method merging

Goal:

- one inheritance metadata model
- one caller-side linking model
- no promise-shaped structural metadata in normal execution
