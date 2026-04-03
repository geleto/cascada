# Command Buffer Refactor

## Overview

This document records the current understanding of `CommandBuffer` and the target refactor direction.

The original trigger was the shared `_channels` registry in [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js):

```js
this._channels = parent ? parent._channels : new Map();
```

That line is too broad, but the correct fix is not just deleting it. The deeper issue is that the command-buffer runtime still allows too much ambient visibility and too much lazy structural creation.

The target architecture should be:

- static lane sets per buffer
- eager lane creation
- local-only channel lookup
- no runtime-dynamic channel names
- no command-buffer-level special treatment for "special" channels
- composition/import/export based on explicit named inputs and snapshots, not ambient buffer visibility

## Main Conclusions

The refactor should move toward these rules:

1. Channel/lane structure must be static for each buffer.
2. `add()` must never create missing lanes.
3. `findChannel()` must be local-only and O(1).
4. The command buffer should not understand lexical scoping beyond what compile-time analysis already encoded.
5. `usedChannels` is the real source of truth; runtime visibility is just its materialized form.
6. Composition should not use channel linking/lookup for data transport.
7. Deferred exports should ultimately resolve from producer snapshots, not ambient visibility.
8. Command-buffer parent/child structure must not be confused with lexical scope ownership.

## Current Problems

### 1. Ambient visibility

Current `findChannel(...)` in [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js) can discover channels through:

- local `_ownedChannels`
- local `_visibleChannels`
- linked child-owned channels
- ancestor `_ownedChannels`
- ancestor `_visibleChannels`
- ancestor-linked child-owned channels
- fallback `_channels`

That is much broader than the compiler's explicit linking model.

The compiler already computes:

- `usedChannels`
- `declaredChannels`
- linked parent-visible channels for each boundary

So the runtime should not rediscover channels beyond that contract.

### 2. Lazy structural creation

Current `add(...)` still does:

```js
if (!this.arrays[resolvedChannelName]) {
  this.arrays[resolvedChannelName] = [];
}
```

This is wrong for the target model.

It silently hides:

- missing declaration bugs
- missing link bugs
- mismatches between compiler analysis and runtime structure

In the new model, a missing lane in `add(...)` must be a hard internal error.

### 3. Shared/global registry

`_channels` is a hierarchy-wide registry of all channels. It bypasses explicit ownership and visibility and especially leaks into finished-snapshot paths.

The regular command path already does not need it. The most problematic use is the finished-snapshot fast path.

### 4. Runtime-dynamic channel names

There are still places where channel names are declared in runtime loops, especially in composition/block-local logic.

This should not remain.

The goal of this refactor is that every buffer has a statically known channel/lane set.

## Target Runtime Model

### Static lane set

Each `CommandBuffer` should be created with a fixed lane set.

That lane set should contain:

- all local declared channels for that buffer
- all parent-linked used channels for that buffer

From that moment on:

- `arrays[name]` exists for every lane
- no new lane names are introduced later

This static lane set is intentionally a structural superset. A declared local variable/channel may still need a lane even if it is never read later, because declarations and writes still need somewhere to land.

So:

- declared-but-unused local channels do not break the model
- they simply become unused eager lanes
- pruning such lanes is an optional later optimization, not a correctness requirement

### Three populations of lane names

For planning the refactor, it helps to separate the lane names into three populations:

1. parent-linked channels: `usedChannels - declaredChannels`
2. locally declared channels: `declaredChannels`
3. current composition/block-input runtime names

The first two populations are already compiler-known and should be eagerly materialized.

The third population is the current blocker to "everything is static", and it should be eliminated as part of this refactor rather than preserved as a special runtime escape hatch.

### Local addressability map

The runtime should maintain a local map of channels addressable from this buffer.

That map should include:

- local channels actually declared in this buffer
- parent-linked channels that static analysis says this buffer may read/write through

`findChannel(name)` should just look up the resolved/canonical name in that local map.

That means:

- no ancestor walk
- no descendant recursion
- no global fallback registry

Common-case lookup should be O(1).

### Scope ownership vs child buffers

Command-buffer child buffers are often just async ordering boundaries. They are not the same thing as child lexical scopes.

That means:

- a truly child-scope-owned declaration must not become visible to the parent just because it lives in a child buffer
- a parent-scope-owned declaration emitted inside a child buffer still needs an ordered runtime binding strategy

The second case is the real reason the current runtime sometimes reaches across buffer boundaries. The refactor should describe that case narrowly instead of speaking about "child-owned channels" flowing upward.

The target rule is:

- no lookup should rediscover channels by scanning child buffers
- if an outer-scope-owned declaration needs to be addressable across an async boundary, that must come from the normal `usedChannels` / parent-linked-lane wiring computed by analysis

This is important: the outer-scope-owned case does not require a new special runtime propagation mechanism. If analysis is correct, the child buffer sees that name as a parent-linked used channel and the parent already owns the lane.

### No runtime lookup recursion

The earlier transitional idea of:

- "channels owned by linked child buffers reachable through this buffer's lane structure"

should be dropped from ordinary `findChannel(...)`.

If visibility is explicit and complete, `findChannel(...)` should not need to scan child buffers at all.

`_findLinkedChildOwnedChannel(...)` should therefore not survive as a soft fallback. During migration it may temporarily become an assertion/debug trap to detect incomplete analysis, but the target state is full removal.

## Used Channels, Visible Channels, Owned Channels

### `usedChannels` is the real source of truth

The compiler's static analysis already determines which channels a buffer may access.

That is the important set.

Runtime visibility should be nothing more than the materialized form of compile-time `usedChannels`.

In other words:

- compile time computes names
- runtime installs concrete channel references for those names

This is why "visible channels" only make sense as explicit runtime materialization of static analysis, not as a discovery mechanism.

In the stricter model, the local addressability map is the runtime form of:

- parent-linked `usedChannels`
- plus local declarations that belong to this buffer's own lane set

### Do we need `_visibleChannels`?

As a runtime storage concept, yes, but only as a materialized addressability map.

It should not mean:

- "ambiently visible because something up the hierarchy had it"

It should mean:

- "this channel is explicitly available to this buffer because compile-time analysis said so"

### Do we need `_ownedChannels`?

For lookup, probably not.

The command buffer is not the right layer for lexical scoping. Compile-time analysis and variable renaming already solve that problem.

So the runtime does not need a deep concept of scoping ownership in order to resolve names.

However, `_ownedChannels` may still be useful as metadata for:

- assertions
- debugging
- a fast answer to "is this locally declared here?"
- separating local declaration semantics from externally supplied visibility

So the likely target is:

- one local addressability map used by `findChannel(...)`
- optional ownership metadata retained only if it still serves a clear purpose

The important point is: `_ownedChannels` should not drive cross-buffer lookup behavior.

## Eager Arrays

### Recommendation

Arrays should be eagerly created, not lazily created.

This should apply to:

- all locally declared channels
- all linked parent-provided channels

### Why eager is better

Eager creation:

- matches static analysis
- makes finish accounting deterministic
- exposes missing-link bugs immediately
- removes "first write defines structure" behavior
- simplifies iterator/finish reasoning

### What `add(...)` should do

After the refactor:

- `add(...)` should assume the lane already exists
- a missing `arrays[name]` should be an internal assertion/error
- the lazy fallback should be removed

## What Replaces `_collectKnownChannelNames()`

`_collectKnownChannelNames()` is not a global channel store. It is currently a helper for finish accounting.

It also exists because the current runtime has no single authoritative lane list. It has to reconstruct that list by merging several partial structures.

Its current job is to infer:

- which lanes this buffer should consider when closing
- which lanes must be marked finished before aggregate `buffer.finished` becomes true

In the target model, it should be replaced by the static lane set for the buffer.

Possible forms:

- `buffer._laneNames`
- `buffer._totalLaneCount`

Because arrays are eager, `Object.keys(arrays)` is already structurally that list.

For efficiency and clarity, we should store lane metadata explicitly at construction rather than recomputing it later.

The practical choice is:

- `buffer._laneNames` as the authoritative static lane list
- `buffer._totalLaneCount = buffer._laneNames.length`

Then `Object.keys(arrays)` becomes only a debugging sanity check, not the runtime source of truth.

### `_visitingIterators`

Today `_collectKnownChannelNames()` also includes `_visitingIterators.keys()`.

Under the target eager model, any lane an iterator can visit must already exist in `arrays`.

So `_visitingIterators` should become redundant as a source of lane names.

That means `_collectKnownChannelNames()` itself should disappear rather than surviving as a merged-name helper.

However, `_visitingIterators` itself should remain. It is still needed as the notification mechanism for:

- `_notifyCommandOrBufferAdded(...)`
- `_notifyChannelFinished(...)`

What goes away is only its role in lane enumeration.

## Finish Semantics

This is the most important structural point.

### What aggregate buffer finish means

`buffer.finished` should mean:

- all lanes of this buffer are closed
- no more entries will be appended to this buffer's arrays

It should **not** mean:

- all descendant child buffers have been fully traversed
- all child buffer iterators have completed

### What iterators care about

The iterator in [src/runtime/buffer-iterator.js](C:\Projects\cascada\src\runtime\buffer-iterator.js) shows the real semantics:

- it walks `buffer.arrays[channelName]`
- when it encounters a child buffer entry, it enters it
- it leaves that child only when `childBuffer.isFinished(channelName)` is true

So there are two separate concerns:

1. This buffer's own lane is closed.
2. Child buffer entries encountered in that lane may themselves need to close before traversal can continue.

Those child buffers do not need to be part of aggregate lane-name enumeration. They are already represented structurally as entries in the lane arrays.

### What we should track

At the command-buffer level, we should track:

- fixed lane set for this buffer
- per-lane finished flags for this buffer

We should not separately track:

- child buffers that were entered
- child buffers that were not entered yet

The iterator handles child buffers structurally when it encounters them.

### What may replace repeated lane scans

Once lane counts are truly static, finish can become counter-based:

- `_totalLaneCount`
- `_finishedLaneCount`

Then `_tryCompleteFinish()` no longer needs to rescan lane names every time.

This optimization is valid only once runtime-dynamic channel names are gone.

### Can the two-stage finish lifecycle collapse?

Probably yes, once static lane creation is complete.

Today `_finishRequestedChannels` and `_finishKnownChannelIfRequested(...)` exist because finish requests can arrive before a lane or channel has been materialized.

With eager lane creation, `requestChannelFinish(name)` should be able to:

1. resolve the canonical lane name
2. assert that the lane exists in the static lane set
3. mark the lane finished immediately
4. notify any visiting iterator
5. update aggregate finish state

So the likely target is:

- remove `_finishRequestedChannels`
- remove `_finishKnownChannelIfRequested(...)`
- keep per-lane finished state and aggregate completion logic

This simplification is valid only once lane existence is guaranteed statically.

## Linked Lanes

Linked lanes should be eagerly created.

The constructor or create-time setup should receive enough static information to know:

- which lanes are local
- which lanes are parent-provided

A good model is:

- all lane names for this buffer
- owned/local lane names

Then:

- lanes in `allLaneNames` are eagerly created in `arrays`
- lane names not locally owned are connected to parent-provided channel refs

This is much cleaner than today's lazy "buffer becomes linked when children are inserted" behavior.

The intended constructor-time split is:

- parent-linked channels: statically imported from the effective link target
- declared/local channels: statically reserved in the lane set and later bound to concrete channel objects by `declareBufferChannel(...)`

That keeps all structural information static while still allowing channel objects themselves to be attached at the normal declaration point.

## `createCommandBuffer(...)`

`createCommandBuffer(...)` should become the place where buffer structure is made complete.

It should conceptually receive:

- context
- static lane names for the new buffer
- locally declared/owned channel names (or specs)
- external used channels to import from the link target
- alias information if needed

Then it should:

1. create the buffer
2. resolve the effective link target
3. establish canonical-name/alias resolution
4. eagerly create all lane arrays
5. install the local addressability map
6. register locally declared channels
7. install external channel refs for statically used parent channels

No later structural discovery should be required.

### Compiler/API changes needed

Today `createCommandBuffer(...)` is called with linked channels only.

To make local lane creation eager, the compiler also needs to pass declared-channel information derived from `node._analysis.declaredChannels`.

That likely means:

- adding a compiler helper analogous to `getLinkedChannelsArg(...)` for declared channels
- updating async-boundary and macro call sites to pass both linked and declared channel metadata
- treating the lane spec, not ad hoc runtime declaration order, as the source of structural truth

## Channel Registration Cleanup

Current channel registration is messy because `Channel` construction registers once and `declareBufferChannel(...)` registers again.

The clean fix is:

- remove `_buffer._registerChannel(...)` from `Channel` construction
- make `declareBufferChannel(...)` the single canonical registration entry point

This applies to:

- text
- var
- data
- sink
- sequence
- sequential_path

`sink` / `sequence` may still keep extra registry state if it is genuinely needed, but that is separate from the main channel-registration path.

Related cleanup:

- `targetBuffer._channelTypes[channelName] = channelType` appears to be dead write-only state today
- if lane specs become constructor-time metadata, channel type should live there instead of in a parallel runtime map

## `_channels`

The shared `_channels` registry should be removed.

It currently leaks into finished-snapshot handling and bypasses explicit structure.

The most concentrated dependency is `_runFinishedSnapshotCommand(...)`, which currently does direct `_channels.get(channelName)` lookup for the finished-buffer snapshot fast path. That method should be converted to use the local addressability map just like the rest of the runtime.

Also, while it still exists during transition, the guard:

```js
if (!this._channels) {
  this._channels = new Map();
}
```

in `_registerChannel(...)` is dead code because `_channels` is always initialized in the constructor.

That guard should be deleted even in any intermediate stage.

## Channel Aliases

`_channelAliases` should remain as a separate concern.

They are not currently central to macro/caller behavior, but they should be kept for future implementation.

The important rule is:

- alias resolution is orthogonal to ownership/visibility
- channel maps should store canonical/resolved names
- visibility installation must use the same resolved names that lookups will later use

Canonical runtime names like `name#7` are already treated as resolved and should continue to be.

## Special Channels

There should be no command-buffer-level special treatment for:

- `__return__`
- text channels
- sequential path channels
- `__caller__`
- waited channels
- `__parentTemplate`

These are special at the **compiler/code generation** level, not at the command-buffer structural level.

The right place to keep any special handling is compiler-side filtering and lowering, such as:

- deciding declaration ownership
- deciding which buffer gets a lane at construction time
- deciding when generated code performs writes or snapshots

The runtime should stay name-agnostic.

Important constraint:

- even if the compiler treats some internal channels specially when assigning ownership or lane membership, runtime add/lookup/snapshot behavior must still stay uniform
- there must be no runtime shortcut that bypasses the normal command-buffer hierarchy for these channels

### `__return__` needs scope-unique ownership

`__return__` needs special care during implementation review.

The correct rule is:

- each real return-owning scope gets its own unique runtime return channel name
- all `return` writes inside that same scope target that same name
- nested callable/render scopes get a different return channel name

So a scope-unique runtime name such as `__return__#<scopeId>` is a good model.

What must not happen is:

- generating a fresh unique return channel name per individual `return` statement

That would incorrectly split one logical return lane into many lanes.

In practice this means:

- the unique return channel name should be assigned once when the return-owning scope is created
- declaration, writes, snapshots, and analysis/linking should all consistently use that same scope-stable runtime name

This keeps nested return scopes isolated while still allowing structural child buffers inside the same scope to target the correct owning return lane.

### Current analysis status for `__return__`

The current compiler/analysis already models return ownership partially, but not explicitly enough for the refactor target.

Today:

- script roots declare an internal `__return__` channel
- macros declare an internal `__return__` channel
- caller scopes declare an internal `__return__` channel
- `return` statements record mutation of `__return__`

So return-owning scopes already exist in the analysis indirectly through normal declaration machinery.

What is still missing is an explicit return-scope identity model:

- there is no dedicated `returnScopeId`
- there is no dedicated `returnChannelRuntimeName`
- there is no rename pass for `__return__` comparable to the current loop renaming

For the refactor, analysis should make return ownership explicit, for example with metadata such as:

- `ownsReturnScope: true`
- `returnScopeId`
- `returnChannelRuntimeName`

Then each `return` statement should resolve to the nearest owning return scope and use that scope-stable runtime return channel name consistently for:

- declaration
- writes
- snapshots
- `usedChannels` / `declaredChannels`
- parent-linked-lane filtering

From the command-buffer perspective:

- `__return__` is just a normal var channel
- sequential-path channels are just normal channels of their own type
- text channels are just channels

So the runtime rules should be uniform:

- no shortcut lookup
- no shortcut add
- no shortcut snapshot
- no bypass of hierarchical buffer behavior

If any such bypass still exists, it should be removed early.

## Deferred Exports

Current deferred exports in [src/environment/context.js](C:\Projects\cascada\src\environment\context.js) work by:

- storing a promise placeholder in `context.ctx`
- remembering the producing `{ channelName, buffer }`
- later resolving that export from `channel.finalSnapshot()`

So yes: deferred exports are ultimately resolved from final snapshots.

### Why are they linked to buffers today?

After auditing the current code, the justification looks weak.

`addDeferredExport(...)` stores both:

- the resolver in `exportResolveFunctions`
- the explicit producer record `{ channelName, buffer }` in `exportChannels`

Then `resolveExports(...)` resolves from that explicit producer buffer directly.

### Target direction

This should be simplified.

Deferred exports should not need general-purpose buffer linking if the producer `{ buffer, channelName }` is already known.

The clean target is:

- deferred exports resolve directly from their producer channel `finalSnapshot()`
- they do not rely on ambient visibility or general buffer linking

`resolveExports(...)` in [src/environment/context.js](C:\Projects\cascada\src\environment\context.js) already mostly follows this model because it stores `{ buffer, channelName }` pairs and resolves from the producer buffer directly.

That means `linkDeferredExportsToBuffer(...)` should be audited aggressively. It may already be redundant for export resolution itself.

## `linkDeferredExportsToBuffer(...)`

This is part of the current export/linkage mechanism, not extern passing.

After auditing current callers, it appears to be used only from async-root setup, and `linkVisibleChannel(...)` is only used by this export-linking path.

That should likely shrink or disappear as export handling is simplified around direct producer snapshots.

Also, `resolveExports(...)` still has a fallback arm that does:

- `currentBuffer.findChannel(name)`

After auditing `Context`, this fallback appears defensive rather than essential:

- `addDeferredExport(...)` always creates both a non-null resolver and an `exportChannels[name]` record
- `addResolvedExport(...)` stores a resolved value and marks the resolver slot as `null`

So in normal deferred-export flow, a non-null resolver should already imply an explicit producer record. The fallback should therefore become an assertion during refactor, and then be removed once the invariant is validated by tests.

## Composition And Extern Inputs

Current composition still has some buffer-based machinery:

- `compositionSourceBuffer`
- `findChannel(name)?.finalSnapshot()`
- block input recovery from composition buffers or parent buffers

Architecturally, this should change.

The target is:

- all composition operations use explicit named inputs
- this should follow the same `with ...` / extern-style pattern consistently
- composition should not rely on channel linking/visibility for value transport
- composition should pass named snapshots/promises/macros as inputs

So yes: composition should move away from buffer linking.

This is not just an adjacent cleanup. It is the main remaining source of runtime-dynamic channel names, so it needs to be solved as part of this refactor if we want fully static lane sets.

The chosen direction should be stated directly:

- composition/block calls should use explicit `with ...`-style named inputs
- block entry functions should receive those inputs explicitly rather than discovering names from block contracts at runtime
- the current runtime loop over `context.getBlockContract(...).inputNames` should be removed

## Runtime-Dynamic Channel Names

This should be fixed as part of this refactor.

The target is:

- no runtime-dynamic channel names
- all buffer lane/channel names are statically known

That means composition/block input handling must be redesigned so it does not loop over runtime names and call:

- `declareBufferChannel(currentBuffer, name, ...)`

Instead:

- composition should pass explicit named snapshot values
- the receiving template/script should use explicit extern/input bindings
- the buffer structure should be fully determined at compile time

So the current composition/block-input runtime loop is not something to accommodate with a permanent lazy fallback. It is technical debt to remove.

This is not a follow-up; it is part of the refactor's target architecture.

## What About `owned` vs `visible` if Everything Is Static?

If buffer structure becomes fully static, the strongest simplification is:

- compile-time analysis determines the full set of channel names a buffer can address
- runtime materializes one local map for those names
- optional ownership metadata may survive only for assertions/debugging

So the likely end state is:

- local addressability map is the real runtime structure
- `_ownedChannels` is optional metadata, not a separate visibility system

## `getFinishedPromise()`

`getFinishedPromise()` remains load-bearing.

It is the bridge used by async-boundary finalization to wait for a child buffer to complete.

What changes is not its existence, but what resolves it:

- today it resolves when `_tryCompleteFinish()` succeeds after merged lane discovery
- after the refactor it should resolve when the static-lane completion check succeeds

## Tests And Invariants

The refactor should preserve and strengthen invariants such as:

- `findChannel()` is local-only
- `add()` cannot create lanes
- missing lane in `add()` is an internal error
- `_linkedChannels` is removed
- child lexical scope never becomes visible to the parent through buffer traversal
- no runtime-dynamic channel names remain
- deferred exports resolve from final snapshots
- composition uses explicit named inputs, not channel visibility
- special channels receive no command-buffer-level shortcut treatment
- aggregate finish depends only on this buffer's lane set

## Migration Strategy

Because the current runtime still tolerates incomplete analysis in a few places, the refactor should introduce stricter invariants in stages:

1. add debug/development assertions around missing lanes, missing linked parent channels, unexpected export fallbacks, and unexpected child-buffer discovery
2. run the focused and full test suites to surface any remaining analysis gaps
3. remove the old fallback paths once the assertions stop firing

This is especially important for:

- `add()` missing-lane checks
- removal of `_findLinkedChildOwnedChannel(...)`
- removal of deferred-export fallback lookup
- composition/block-input staticization

## Implementation Plan

This section turns the target architecture into a practical implementation sequence. The order matters: each step should shrink one category of ambiguity while preserving as much existing behavior as possible.

### Step 1. Make scope ownership and lane specs explicit in analysis

Goal:

- make the compiler the authoritative source for lane membership and return-scope ownership before changing runtime lookup rules

Primary files:

- [src/compiler/analysis.js](C:\Projects\cascada\src\compiler\analysis.js)
- [src/compiler/emit.js](C:\Projects\cascada\src\compiler\emit.js)
- [src/compiler/compiler-async.js](C:\Projects\cascada\src\compiler\compiler-async.js)
- [src/compiler/macro.js](C:\Projects\cascada\src\compiler\macro.js)
- [src/compiler/rename.js](C:\Projects\cascada\src\compiler\rename.js)

Changes:

- add a compiler helper parallel to `getLinkedChannelsArg(...)` for declared/local lane specs
- update `getLinkedChannelsArg(...)` filtering so scope-unique return names like `__return__#<scopeId>` are still excluded from parent-linked lanes
- keep declaration ownership and parent-linked usage separate and explicit
- add explicit return-scope metadata such as:
  - `ownsReturnScope`
  - `returnScopeId`
  - `returnChannelRuntimeName`
- assign a scope-stable runtime return name like `__return__#<scopeId>` once per return-owning scope
- make `return` analysis resolve to the nearest owning return scope instead of mutating bare `__return__`
- validate lane-spec assumptions early:
  - after filtering out local declarations from raw `usedChannels`, the resulting parent-linked set must be disjoint from the local declared set
  - every referenced parent-linked lane must correspond to an analyzable outer declaration
  - every return-owning scope must have exactly one scope-stable return runtime name

Tests for this step:

- add/extend compile-source tests showing nested scopes get distinct return runtime names
- keep existing passing integration tests green:
  - root return isolated from nested macro returns
  - caller return isolated from the enclosing return

Still-unimplemented tests to add here:

- integration test: structural child buffers inside the same return scope still target the enclosing return lane
- if early-return semantics are implemented as part of this work, unskip and update:
  - `should support early return`
  - `should support conditional return branches`
  - `should support return inside loops`
  - `should support return inside guard/recover blocks`

Important note:

- same-scope return routing and true early-return control flow are related but not identical. If early-exit semantics remain out of scope for this refactor, only add tests for correct lane targeting, not for "stop executing the rest of the scope."
- the declared-lane helper is the main prerequisite for Step 2; full `__return__` scope-uniqueness work can proceed in parallel if needed
- the new declared-lane helper must be threaded through the same boundary creation call sites that currently use `getLinkedChannelsArg(...)`, especially in `boundaries.js`, `loop.js`, and root/macro buffer creation paths
- lane-spec validation should begin as warnings or debug assertions during migration and only become hard errors after Step 10 removes the remaining runtime-dynamic composition lanes

### Step 2. Change `createCommandBuffer(...)` to receive static lane specs and build eager arrays

Goal:

- make buffer structure complete at construction time

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/async-boundaries.js](C:\Projects\cascada\src\runtime\async-boundaries.js)
- [src/compiler/buffer.js](C:\Projects\cascada\src\compiler\buffer.js)
- [src/compiler/boundaries.js](C:\Projects\cascada\src\compiler\boundaries.js)
- [src/compiler/macro.js](C:\Projects\cascada\src\compiler\macro.js)

Changes:

- extend buffer creation so the runtime receives:
  - parent-linked lane names
  - local declared lane names
- apply the same static-lane-spec model to root buffers as well as child buffers
- update the compiler call sites that currently pass only linked channels so they also pass declared-lane specs
- eagerly create `arrays[name] = []` for the full static lane set
- move alias inheritance/canonical-name setup into construction-time buffer initialization, before populating any local addressability entries
- store:
  - `buffer._laneNames`
  - `buffer._totalLaneCount`
- keep child/parent structural insertion separate from lane creation
- assert at construction time that every parent-linked lane resolves on the effective link target (`linkedParent` where present, otherwise `parent`)
- do not remove `_registerLinkedChannel(...)` calls from `add()` yet; that compatibility cleanup belongs to Step 11 when finish bookkeeping is collapsed

Tests for this step:

- existing passing test: outer var writes across async `if` boundaries

Still-unimplemented tests to add here:

- integration test: declared-but-unused local channels do not prevent buffer completion
- targeted runtime/integration test: `getFinishedPromise()` still resolves for buffers with unused eager local lanes
- integration test anchor: loop body buffers still behave correctly under eager lane creation
- integration test anchor: macro/caller invocation buffers still behave correctly under eager lane creation

Clarification:

- `buffer._laneNames` / `buffer._totalLaneCount` are introduced here as constructor-time metadata
- Step 5 will start using them for finish accounting; it does not reintroduce them
- alias setup here is a sequencing change to existing behavior, not a new alias feature

### Step 3. Introduce the local addressability map and clean up channel registration

Goal:

- make one local map the source of channel resolution

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/channel.js](C:\Projects\cascada\src\runtime\channel.js)

Changes:

- make `declareBufferChannel(...)` the single canonical registration path
- remove registration from `Channel` construction
- repurpose `_visibleChannels` into the unified local addressability map during migration, so it becomes the single primary runtime lookup structure
- install locally declared channel objects into that map
- install parent-linked channel refs from static analysis into that same map
- keep `_ownedChannels` only as optional assertions/debug metadata; it must no longer participate in lookup
- remove dead `_channelTypes` state if nothing reads it
- move iterator binding along with the registration cleanup so channel iterators still bind to the owning buffer correctly
- establish and enforce the construction-order invariant for parent-linked refs:
  - parent-linked channel refs must already exist on the effective link target when the child buffer is constructed
  - if that invariant is violated, fail via assertion during migration rather than adding a new deferred-binding fallback

Tests for this step:

- keep existing declaration and snapshot suites green
- keep existing call-block parent-variable read tests green

Still-unimplemented tests to add here:

- integration test: a true child lexical scope does not become parent-visible merely because a child buffer exists
- integration test: outer-scope-owned declarations emitted through async boundaries still resolve correctly without child-buffer discovery

### Step 4. Remove ambient lookup and child-buffer scanning from normal resolution

Goal:

- make `findChannel()` local-only

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)

Changes:

- remove ancestor walk from `findChannel(...)`
- remove `_findLinkedChildOwnedChannel(...)` from the normal lookup path
- re-evaluate `channelLookup(...)` routing so it uses the local map semantics directly instead of relying on ambient ancestry assumptions
- during migration, temporarily convert unexpected child-buffer discovery into an assertion/debug trap

Clarification:

- Step 4 changes behavior by making lookup local-only and wiring `_findLinkedChildOwnedChannel(...)` out of normal resolution
- Step 7 is only the dead-code cleanup for disabled dynamic lookup-linking
- Step 12 is where any surviving `_findLinkedChildOwnedChannel(...)` assertion trap is deleted entirely

Tests for this step:

- existing passing tests:
  - read outer variable directly inside call block
  - allow reading parent variables in call blocks
  - allow observing outer var channel inside call blocks

Still-unimplemented tests to add here:

- integration test: parent lookup cannot see a child-scope-only declaration across an async/control-flow boundary
- debug/assertion test: if `_findLinkedChildOwnedChannel(...)` would have been needed, the suite fails loudly instead of silently succeeding

### Step 5. Replace finish discovery with static lane accounting

Goal:

- introduce explicit lane metadata and prepare finish logic for later simplification

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/buffer-iterator.js](C:\Projects\cascada\src\runtime\buffer-iterator.js)

Changes:

- replace `_collectKnownChannelNames()` with the constructor-time lane list
- keep `_visitingIterators` only as a notification mechanism
- introduce `_totalLaneCount`
- introduce `_finishedLaneCount` alongside the existing scan-based aggregate check and assert that the two agree during migration
- increment `_finishedLaneCount` in `_markChannelFinished(...)`, which remains the per-lane finished-state transition point
- do not fully remove `_linkedChannels` / `_finishRequestedChannels` yet if runtime-dynamic lanes or lazy lane creation still exist anywhere
- simplify `markFinishedAndPatchLinks()` to iterate the constructor-time lane list directly

Clarification:

- `_collectKnownChannelNames()` should stop driving the main finish path here, but it may remain temporarily for assertion parity until Step 11 removes the old finish scaffolding completely
- `_linkedChannels` / `_finishRequestedChannels` survive until after Step 10; Step 11 is where they are actually removed

Tests for this step:

- existing passing tests around normal flattening and buffer completion should remain green

Still-unimplemented tests to add here:

- integration test: declared-but-unused lanes do not block aggregate finish
- integration test: child buffers entered through iterators still complete correctly under static lane accounting

### Step 6. Make missing lanes a hard error and remove lazy lane creation

Goal:

- stop hiding compiler/runtime mismatches

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)

Changes:

- remove the lazy `if (!this.arrays[name]) this.arrays[name] = []` path from `add(...)`
- assert that every add/snapshot path targets a known static lane
- keep this assertion behind a development/debug gate at first
- do not make it unconditional until after Step 10 removes runtime-dynamic composition lanes; Step 12 is where it should become unconditional
- acknowledge that `_addCommand(...)` will now fail through the same missing-lane assertion path, which is the desired outcome for an invalid compiled/runtime contract
- leave `_registerLinkedChannel(...)` calls in `add()` alone for now if they are still carrying finish-accounting compatibility; that cleanup belongs to Step 11

Tests for this step:

- keep all passing integration tests green

Still-unimplemented tests to add here:

- targeted runtime test: missing lane in `add()` throws immediately
- targeted runtime test: missing linked parent channel at buffer creation throws immediately

### Step 7. Remove dynamic lookup-time linking and child-buffer discovery fallbacks

Goal:

- make lookup stop mutating structure or rescuing incomplete analysis

Primary files:

- [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)
- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)

Changes:

- remove dead `LOOKUP_DYNAMIC_CHANNEL_LINKING` support
- remove dead `ensureReadChannelLink(...)`
- remove dead `_readChannelLinks`
- if `_findLinkedChildOwnedChannel(...)` is still present as an assertion trap from Step 4, keep Step 7 limited to the dead dynamic-linking cleanup and defer final trap removal to Step 12

Tests for this step:

- existing parent-variable read tests should remain green; no behavioral change is expected because dynamic lookup linking is already disabled

Still-unimplemented tests to add here:

- no new behavior-focused tests are required here beyond confirming the existing Step 4 tests still pass

### Step 8. Remove `_channels` and fix the finished-snapshot fast path

Goal:

- eliminate the hierarchy-wide channel registry completely

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)

Changes:

- remove `_channels`
- remove its dead initialization guard in `_registerChannel(...)`
- route `addSnapshot(...)`, `addRawSnapshot(...)`, and especially `_runFinishedSnapshotCommand(...)` through the local addressability map
- update the finished-buffer fast path in `addSnapshot(...)` / `addRawSnapshot(...)` so both channel retrieval and the `output._buffer.isFinished(...)` guard use the local addressability map instead of `_channels`
- narrow `_registerChannel(...)` so it no longer manages `_channels`; if `_ownedChannels` remains as debug metadata, its write can stay there

Tests for this step:

- keep existing snapshot suites green

Still-unimplemented tests to add here:

- integration test: finished-buffer snapshot still works after `_channels` removal
- integration test: finished raw snapshot still works after `_channels` removal

### Step 9. Simplify deferred exports around explicit producer records

Goal:

- stop using buffer visibility for export resolution

Primary files:

- [src/environment/context.js](C:\Projects\cascada\src\environment\context.js)
- [src/compiler/compiler-async.js](C:\Projects\cascada\src\compiler\compiler-async.js)

Changes:

- make `resolveExports(...)` rely on the explicit `{ buffer, channelName }` producer record
- convert the `currentBuffer.findChannel(name)` fallback into an assertion first
- remove `linkDeferredExportsToBuffer(...)` once tests confirm it is unnecessary
- keep `exportChannels` / `exportResolveFunctions` as the explicit producer-record mechanism
- remove the emitted `context.linkDeferredExportsToBuffer(...)` call from compiler output
- remove `linkVisibleChannel(...)` as well, since export linking is its only current use

Tests for this step:

- keep existing async import/from-import export tests green
- keep loop-concurrent-limit async export tests green

Still-unimplemented tests to add here:

- integration test: exported async value resolves correctly without parent visibility linking
- integration test: `resolveExports(...)` fails/asserts if a deferred resolver exists without an explicit producer record

### Step 10. Remove runtime-dynamic block/composition channel names

Goal:

- make composition fully static and align it with the same explicit-input model as other composition operations

Primary files:

- [src/compiler/compiler-async.js](C:\Projects\cascada\src\compiler\compiler-async.js)
- [src/compiler/inheritance.js](C:\Projects\cascada\src\compiler\inheritance.js)
- [src/environment/context.js](C:\Projects\cascada\src\environment\context.js)

Changes:

- redesign block/composition entry so inputs are passed explicitly via `with ...`-style named inputs
- make block entry functions receive an explicit named-input object or equivalent explicit parameter payload
- have the compiler generate that payload from statically known call-site inputs instead of discovering input names at runtime
- rewrite `_emitAsyncBlockInputInitialization(...)` around those static explicit inputs
- stop looping over `context.getBlockContract(...).inputNames` at runtime to declare channels
- remove the runtime `declareBufferChannel(currentBuffer, name, ...)` loop for composition inputs
- remove `compositionSourceBuffer`-based channel lookup from block input initialization
- keep composition value transport snapshot-based and explicit
- update `Context.forkForComposition(...)` if its current contract assumes channel/buffer-based composition lookup
- audit whether `setCompositionSourceBuffer(...)`, `getCompositionSourceBuffer(...)`, `getBlockContract(...)`, and `forkForComposition(...)` still have any remaining purpose after this redesign

Concrete target:

- block/call-site compilation should construct the explicit named-input payload from compile-time-known inputs
- the generated block entry function should consume that payload directly instead of recovering names from `Context`
- `inheritance.js` and `compiler-async.js` must agree on the new entry-function signature and call shape
- in practice, `inheritance.js` should build and pass the explicit named-input payload at block override/super call sites, and `compiler-async.js` block entry code should accept that payload directly
- compile-time block-input metadata must exist at the call site; if current analysis does not yet provide that, this step must add it explicitly before runtime loop removal can proceed

Dependency:

- this step requires block input names to be compile-time-known at call sites; if Step 1 does not already provide that, Step 10 must add it explicitly

Tests for this step:

- keep current composition/import tests green

Still-unimplemented tests to add here:

- integration test: composition block inputs work through explicit named `with ...` inputs
- compile-source test: generated block entry code no longer loops over runtime block-contract input names
- integration test: no runtime-dynamic channel declaration is needed for composition/block inputs

### Step 11. Collapse finish handling and remove remaining compatibility state

Goal:

- finish the transition to fully static lane-based completion once all dynamic structure creation is gone

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/buffer-iterator.js](C:\Projects\cascada\src\runtime\buffer-iterator.js)

Changes:

- remove `_linkedChannels`
- remove `_registerLinkedChannel(...)`
- remove the `_registerLinkedChannel(...)` call from `add()`
- remove `_finishRequestedChannels`
- remove `_finishKnownChannelIfRequested(...)`
- remove the backward-compatibility alias `markChannelFinished(...)` if it no longer serves a purpose
- make `requestChannelFinish(...)` the direct lane-finish path:
  - resolve canonical name
  - assert the lane exists
  - call `_markChannelFinished(...)`
  - notify iterators / update aggregate completion through the surviving finish path
- update `_tryCompleteFinish()` so it stops scanning lane names and instead resolves completion when `_finishedLaneCount === _totalLaneCount`
- make aggregate finish rely on:
  - `_totalLaneCount`
  - `_finishedLaneCount`
- keep per-lane finished flags
- keep `_visitingIterators` only for notifications
- keep `_ownedChannels` as debug/assert metadata only unless Step 12 proves it is no longer useful

Tests for this step:

- declared-but-unused lanes do not block aggregate finish
- child buffers entered through iterators still complete correctly under static lane accounting
- `getFinishedPromise()` resolves under the final static-lane finish model

### Step 12. Remove migration fallbacks and make invariants unconditional

Goal:

- finish the cleanup and stop tolerating partial analysis/runtime drift

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)
- [src/environment/context.js](C:\Projects\cascada\src\environment\context.js)

Changes:

- delete `_findLinkedChildOwnedChannel(...)` if it survived as a migration-time assertion trap
- delete any remaining export fallback lookup
- delete any temporary debug-only compatibility paths that are no longer needed
- make the static-lane / local-lookup invariants unconditional
- finalize the disposition of `_ownedChannels`:
  - keep it only as debug/assert metadata if it still provides value
  - otherwise remove it entirely
- audit `parent` vs `linkedParent` separately:
  - keep `parent` if it is still required for iterator/tree structure
  - remove or simplify `linkedParent` only if it no longer serves a distinct purpose after local-only lookup and eager linking are in place
- remove `compositionSourceBuffersByTemplate` and related helpers if Step 10 leaves them unused
- remove `getBlockContract(...)` as well if Step 10 leaves no remaining callers

Final verification for this step:

- run focused suites for:
  - `tests/explicit-outputs.js`
  - `tests/pasync/calls.js`
  - `tests/pasync/composition.js`
  - `tests/pasync/template-command-buffer.js`
  - `tests/pasync/loop-concurrent-limit.js`
- then run the full relevant test suite

## Final Recommendation

The refactor should proceed with these goals:

1. Remove `_channels`.
2. Remove lazy lane creation from `add()`.
3. Replace `_collectKnownChannelNames()` with a static per-buffer lane set.
4. Track aggregate finish only for this buffer's own lanes.
5. Make `findChannel()` local-only and O(1).
6. Remove descendant/ancestor/global lookup from normal channel resolution.
7. Keep lexical scope ownership separate from command-buffer parent/child structure.
8. Remove `_linkedChannels`.
9. Make `declareBufferChannel(...)` the single canonical registration path.
10. Collapse finish handling once static lane creation guarantees lane existence.
11. Keep `_channelAliases` as a separate future-facing concern.
12. Treat all channels uniformly inside command-buffer/runtime logic.
13. Redesign composition around explicit named inputs/snapshots.
14. Remove runtime-dynamic channel names as part of this refactor.

In short:

- structure should be static
- arrays should be eager
- lookup should be local
- finish should be lane-based
- exports should resolve from snapshots
- composition should use explicit inputs
- command-buffer logic should stop carrying language-level special cases
