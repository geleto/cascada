# Command Buffer Refactor

## Overview

This document records the current understanding of `CommandBuffer` and the target refactor direction.

The original trigger was the shared `_channels` registry in [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js):

```js
this._channels = parent ? parent._channels : new Map();
```

That line is too broad, but the correct fix is not just deleting it. The deeper issue is that the command-buffer runtime still allows too much ambient visibility and too much lazy structural creation.

Composition/import/export follow-up work now lives in [composition-update.md](C:\Projects\cascada\docs\code\composition-update.md). This document focuses on the core command-buffer/runtime structure changes.

The target architecture should be:

- static lane sets per buffer
- eager lane creation
- local-only channel lookup
- no runtime-dynamic channel names
- no command-buffer-level special treatment for "special" channels

## Status Refresh

This document is still the right refactor note, but parts of its earlier
"current runtime state" description are now stale.

The most important current facts are:

- ordinary `findChannel(...)` is already narrower than this document originally
  described: it walks ancestor `_ownedChannels` only; it does not recurse into
  child buffers and it does not use `_channels` for normal lookup
- `_visibleChannels`, `_findLinkedChildOwnedChannel(...)`,
  `LOOKUP_DYNAMIC_CHANNEL_LINKING`, `ensureReadChannelLink(...)`, and
  `_readChannelLinks` are not present in the current runtime anymore
- `_channels` is still present and still too broad, but its concentrated
  remaining value is the finished-snapshot fast path and the shared hierarchy
  registry for channel objects
- iterator-driven cleanup has moved forward: processed command entries are set
  to `null`, finished child-buffer slots are set to `null`, whole finished lane
  arrays are now released with `buffer.arrays[channelName] = null`, and
  finished iterators dispose their own state
- `_channelAliases` is now real behavior rather than a speculative future-only
  mechanism; alias/canonical-name handling must therefore be part of the
  refactor plan, not treated as an optional afterthought
- command taxonomy has also moved since some earlier notes: both
  `WaitResolveCommand` and `WaitCurrentCommand` exist in the runtime
- `_channelTypes` is not currently dead state: composition payload capture uses
  it to avoid redeclaring existing channels
- `_channelRegistry` still appears to be write-only, but it should be audited
  before deletion rather than removed together with `_channelTypes`
- `createCommandBuffer(...)` call sites do not all share `_channels` the same
  way: some linked buffers pass `parent = null` and `linkedParent =
  parentBuffer`, so the registry problem is broad but irregular rather than a
  single uniform parent-chain behavior
- runtime-dynamic declaration paths still exist, especially compatibility paths
  that emit `declareBufferChannel(..., name, ...)`; these must be removed or
  converted before static/eager lane assertions become unconditional

So the overall direction of this document remains valid, but the migration
sequence should be read as "update from the current narrowed runtime" rather
than "start from the much broader transitional runtime this document first
described."

## Main Conclusions

The refactor should move toward these rules:

1. Channel/lane structure must be static for each buffer.
2. `_add()` must never create missing lanes.
3. `findChannel()` must be local-only and O(1).
4. The command buffer should not understand lexical scoping beyond what compile-time analysis already encoded.
5. `usedChannels` is the real source of truth; runtime visibility is just its materialized form.
6. Command-buffer parent/child structure must not be confused with lexical scope ownership.
7. The refactor must reduce long-lived `CommandBuffer` state overall. Do not
   add new persistent maps, counters, or properties unless the same stage
   removes or repurposes existing state so the structure gets simpler.

## Current Runtime State

Before changing the runtime, it helps to name the structures that currently overlap:

- `_ownedChannels`: channels declared locally in this buffer
- `_linkedChannels`: bookkeeping for child buffers structurally linked into this buffer's lanes
- `_channels`: hierarchy-wide registry shared across parent/child buffers
- `_channelAliases`: narrow alias/canonical-name mapping used for explicit
  runtime channel binding
- `arrays`: per-channel lane payload arrays; still created lazily today, but
  finished iterator cleanup can now set individual entries and whole finished
  lane arrays to `null`
- `_visitingIterators`: notification/bookkeeping for iterators currently
  visiting this buffer's lanes

The refactor is not just about deleting one of these maps. The real problem is that they currently overlap in responsibility:

- some structures describe lexical ownership
- some describe runtime addressability
- some describe structural child-buffer linking
- one bypasses all of the above

The target model should separate those concerns much more sharply while also
reducing the number of overlapping `CommandBuffer` properties:

- one local addressability mechanism for lookup, preferably by repurposing
  existing ownership/registry state during the same stage that removes
  `_channels`
- `arrays` as the lane structure/finish source, not a parallel lane-name list
  or lane counter
- optional ownership metadata only if it remains useful for assertions/debugging
- alias resolution sequenced before lane/addressability installation

## Current Problems

### 1. Ambient visibility

Current `findChannel(...)` in [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js) is already simpler than this document originally assumed:

- local `_ownedChannels`
- ancestor `_ownedChannels`

That is much broader than the compiler's explicit linking model.

The compiler already computes:

- `usedChannels`
- `declaredChannels`
- linked parent-visible channels for each boundary

So the runtime should not rediscover channels beyond that contract.

This matters not only for name resolution, but also for ordered traversal semantics. Helpers such as lookup/snapshot logic assume that if a buffer can observe a lane, that lane is structurally part of the buffer's linked hierarchy in source order. Ambient ancestor/descendant discovery breaks that assumption by making a channel appear readable even when the current buffer was never explicitly wired into the lane that owns the ordered command stream.

### 2. Lazy structural creation

Current `_add(...)` still does:

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

In the new model, a missing lane in `_add(...)` must be a hard internal error.

### 3. Shared/global registry

`_channels` is a hierarchy-wide registry of all channels. It bypasses explicit ownership and visibility and especially leaks into finished-snapshot paths.

The regular command path already does not need it. The most problematic use is the finished-snapshot fast path.

More concretely, `_channels` lets the runtime answer "does some channel with this name exist anywhere in the hierarchy?" when what it really needs to answer is "is this buffer explicitly wired to the lane that owns the ordered history for this name?" Those are not equivalent questions. The first one is a global existence test; the second is the compiler/runtime contract the iterator model actually depends on.

### 4. Runtime-dynamic channel names

There are still places where channel names are declared in runtime loops through compatibility paths.

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
3. remaining runtime-dynamic compatibility names

The first two populations are already compiler-known and should be eagerly materialized.

The third population is the current blocker to "everything is static", and it should be eliminated as part of this refactor rather than preserved as a special runtime escape hatch.

### Local addressability

The runtime should maintain local channel addressability for this buffer without
adding another overlapping long-lived registry.

That addressability mechanism should include:

- local channels actually declared in this buffer
- parent-linked channels that static analysis says this buffer may read/write through

`findChannel(name)` should just look up the resolved/canonical name through
that local mechanism.

That means:

- no ancestor walk
- no descendant recursion
- no global fallback registry

Common-case lookup should be O(1). If a new map is temporarily introduced
during migration, it must replace `_channels` and/or `_ownedChannels` in the
same stage rather than becoming another permanent `CommandBuffer` property.

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

The current runtime has already dropped the older child-buffer discovery path
from ordinary `findChannel(...)`.

That is good progress, but it is not the end state.

The remaining work is:

- remove the ancestor walk from ordinary `findChannel(...)`
- make finished-snapshot and shared-observation paths use the same explicit
  local addressability model
- stop treating "an ancestor owns some channel of this name" as sufficient
  runtime evidence that the current buffer may observe that lane

So the target is still "no runtime rediscovery", but the migration point is now
"finish removing ancestor/global rediscovery", not "stop scanning child
buffers."

## Used Channels, Visible Channels, Owned Channels

### `usedChannels` is the real source of truth

The compiler's static analysis already determines which channels a buffer may access.

That is the important set.

Runtime visibility should be nothing more than the materialized form of compile-time `usedChannels`.

In other words:

- compile time computes names
- runtime installs concrete channel references for those names

This is why "visible channels" only make sense as explicit runtime materialization of static analysis, not as a discovery mechanism.

In the stricter model, local addressability is the runtime form of:

- parent-linked `usedChannels`
- plus local declarations that belong to this buffer's own lane set

### Do we need `_visibleChannels`?

Not as an existing structure. The current runtime does not have a live
`_visibleChannels` map anymore.

But it still needs the concept the earlier document was trying to name:

- one local addressability mechanism
- populated explicitly from compile-time lane/link information
- used by `findChannel(...)`, finished snapshots, and shared observation

So the recommendation remains:

- repurpose existing state for explicit addressability where possible
- if a new local map is temporarily introduced, remove the state it replaces in
  the same stage
- do not reintroduce `_visibleChannels` as a second overlapping runtime system

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

- one local addressability mechanism used by `findChannel(...)`
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

### Structural eagerness vs lazy value semantics

This refactor should make structure eager, not values eager.

In other words:

- lane existence should be known at buffer construction time
- lane arrays should exist before any writes happen
- channel visibility/addressability should be installed before any lookup happens

But values inside those lanes can still remain lazy:

- commands can still be appended later
- child buffers can still finish later
- async values carried by commands can still resolve later

So the change here is "make the shape of the buffer tree static and explicit", not "force all runtime data to become precomputed or synchronous."

### What `_add(...)` should do

After the refactor:

- `_add(...)` should assume the lane already exists
- a missing `arrays[name]` should be an internal assertion/error
- the lazy fallback should be removed

## What Replaces `_collectKnownChannelNames()`

`_collectKnownChannelNames()` is not a global channel store. It is currently a helper for finish accounting.

It also exists because the current runtime has no single authoritative lane list. It has to reconstruct that list by merging several partial structures.

Its current job is to infer:

- which lanes this buffer should consider when closing
- which lanes must be marked finished before aggregate `buffer.finished` becomes true

In the target model, it should be replaced by the static lane set for the buffer.

Because arrays are eager, `Object.keys(arrays)` is already structurally that list.

The practical choice is therefore:

- `arrays` is the authoritative static lane structure
- `Object.keys(arrays)` is the lane list for finish accounting during this
  migration
- do not add parallel `_laneNames` / `_totalLaneCount` state

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

Repeated `Object.keys(arrays)` scans are acceptable during the migration because
they avoid adding more persistent buffer state. If performance later proves this
path is hot, any counter-based optimization must replace existing finish state
in the same change rather than adding `_totalLaneCount` / `_finishedLaneCount`
beside it.

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

### Finish lifecycle interaction during migration

One implementation trap here is that eager creation changes *when* lanes become known, but it must not accidentally change the observable finish behavior of the existing runtime while intermediate compatibility code still exists.

Today some finish behavior is coupled to registration paths such as `_registerChannel(...)` and `_registerLinkedChannel(...)`. As long as those hooks still exist, eager lane creation must preserve their effective finish-side effects somewhere equivalent. Only after static lane metadata fully owns finish accounting should those legacy registration-time finish paths be removed.

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
5. install local addressability without adding an overlapping permanent map
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
- sequence
- sequential_path


Related cleanup:

- `targetBuffer._channelRegistry[channelName] = channel` appears to be
  write-only state today and is a good deletion candidate after an audit
- `targetBuffer._channelTypes[channelName] = channelType` is still used by
  composition payload capture and must not be removed until that consumer has a
  replacement
- if lane specs become constructor-time metadata, channel type should live
  there instead of in a parallel runtime map
- after composition payload capture no longer reads `_channelTypes`, the map
  should be removed rather than surviving as a second unused parallel registry

This section is more urgent now than when the document was first drafted:

- the current runtime still does register in both places
- `declareBufferChannel(...)` already reassigns `channel._buffer` and
  re-registers, so this is a good concrete cleanup target even before the
  larger static-lane refactor lands

## `_channels`

The shared `_channels` registry should be removed.

It currently leaks into finished-snapshot handling and bypasses explicit structure.

The most concentrated dependency is `_runFinishedSnapshotCommand(...)`, which currently does direct `_channels.get(channelName)` lookup for the finished-buffer snapshot fast path. That method should be converted to use local addressability just like the rest of the runtime.

This asymmetry is important. Normal command traversal is already much closer to the intended structural model because it walks buffer lanes and child-buffer entries in order. The finished-snapshot fast path is broader: it can answer from a global registry even when the current buffer was never explicitly linked to that lane. That is why `_channels` removal is not just cleanup; it closes one of the biggest remaining "ambient visibility" loopholes.

Also, while it still exists during transition, the guard:

```js
if (!this._channels) {
  this._channels = new Map();
}
```

in `_registerChannel(...)` is dead code because `_channels` is always initialized in the constructor.

That guard should be deleted even in any intermediate stage.

Current note:

- `_channels` is still load-bearing for finished `SnapshotCommand` /
  `RawSnapshotCommand` handling in `addCommand(...)` and
  `_runFinishedSnapshotCommand(...)`
- ordinary lookup no longer uses `_channels`, which means `_channels` removal is
  now more concentrated and more realistic than when this document was first
  written

## Channel Aliases

`_channelAliases` should remain as a separate concern.

They are not currently central to macro/caller behavior, but they should be kept for future implementation.

The important rule is:

- alias resolution is orthogonal to ownership/visibility
- channel maps should store canonical/resolved names
- visibility installation must use the same resolved names that lookups will later use

Canonical runtime names like `name#7` are already treated as resolved and should continue to be.

The important sequencing constraint is that alias/canonical-name setup must happen before eager lane creation is treated as complete. Otherwise the runtime can eagerly create a lane under one name, then later attempt lookup or visibility installation under a different resolved name and falsely conclude that the lane is missing. So alias inheritance and canonical-name resolution belong in construction-time initialization, not as an afterthought once channels start registering.

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

## What About `owned` vs `visible` if Everything Is Static?

If buffer structure becomes fully static, the strongest simplification is:

- compile-time analysis determines the full set of channel names a buffer can address
- runtime materializes local addressability for those names
- optional ownership metadata may survive only for assertions/debugging

So the likely end state is:

- local addressability is the real runtime structure
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
- `_add()` cannot create lanes
- missing lane in `_add()` is an internal error
- `_linkedChannels` is removed
- child lexical scope never becomes visible to the parent through buffer traversal
- no runtime-dynamic channel names remain
- special channels receive no command-buffer-level shortcut treatment
- aggregate finish depends only on this buffer's lane set
- lookup/snapshot logic cannot observe a lane unless the buffer was explicitly wired to that lane's ordered structure
- alias-based lookup, lane creation, and visibility installation all agree on the same canonical runtime name
- removing `_channels` does not change finished-snapshot correctness for explicitly linked lanes

## Migration Strategy

Because the current runtime still tolerates incomplete analysis in a few places, the refactor should introduce stricter invariants in stages:

1. add debug/development assertions around missing lanes, missing linked parent channels, and unexpected ambient lookup success
2. run the focused and full test suites to surface any remaining analysis gaps
3. remove the old fallback paths once the assertions stop firing

This is especially important for:

- `_add()` missing-lane checks
- removal of ancestor/global fallback behavior from lookup and finished snapshots

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
- lane-spec validation should begin as warnings or debug assertions during migration and only become hard errors after the remaining runtime-dynamic lane cases have been removed

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
- use `arrays` itself as the materialized lane structure; do not store a
  parallel lane-name list or lane-count property
- keep child/parent structural insertion separate from lane creation
- assert at construction time that every parent-linked lane resolves on the effective link target (`linkedParent` where present, otherwise `parent`)
- do not remove `_registerLinkedChannel(...)` calls from `_add()` yet; that compatibility cleanup belongs to Step 9 when finish bookkeeping is collapsed

Tests for this step:

- existing passing test: outer var writes across async `if` boundaries

Still-unimplemented tests to add here:

- integration test: declared-but-unused local channels do not prevent buffer completion
- targeted runtime/integration test: `getFinishedPromise()` still resolves for buffers with unused eager local lanes
- integration test anchor: loop body buffers still behave correctly under eager lane creation
- integration test anchor: macro/caller invocation buffers still behave correctly under eager lane creation

Clarification:

- lane names are constructor inputs, not new long-lived `CommandBuffer`
  properties
- Step 5 will use eager `arrays` keys for finish accounting
- alias setup here is a sequencing change to existing behavior, not a new alias feature

### Step 3. Introduce local addressability and clean up channel registration

Goal:

- make one local mechanism the source of channel resolution

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/channels/index.js](C:\Projects\cascada\src\runtime\channels\index.js)

Changes:

- make `declareBufferChannel(...)` the single canonical registration path
- remove registration from `Channel` construction
- establish one unified local addressability mechanism during migration so it
  becomes the single primary runtime lookup structure
- prefer repurposing existing `_ownedChannels`/registration state over adding a
  new permanent map
- install locally declared channel objects into that mechanism
- install parent-linked channel refs from static analysis into that same mechanism
- if `_ownedChannels` remains after this step, keep it only as optional
  assertions/debug metadata; it must no longer participate in cross-buffer
  lookup
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

### Step 4. Remove ambient lookup from normal resolution

Goal:

- make `findChannel()` local-only

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)

Changes:

- remove ancestor walk from `findChannel(...)`
- re-evaluate `channelLookup(...)` routing so it uses the local map semantics directly instead of relying on ambient ancestry assumptions
- route shared-observation readability checks through the same explicit local
  addressability mechanism
- during migration, temporarily convert any remaining unexpected ambient lookup
  success into an assertion/debug trap

Clarification:

- Step 4 changes behavior by making ordinary lookup local-only and narrowing the
  remaining helper paths that still rely on ancestry/global knowledge
- later cleanup steps remove the compatibility scaffolding once those narrowed
  paths are gone too

Tests for this step:

- existing passing tests:
  - read outer variable directly inside call block
  - allow reading parent variables in call blocks
  - allow observing outer var channel inside call blocks

Still-unimplemented tests to add here:

- integration test: parent lookup cannot see a child-scope-only declaration across an async/control-flow boundary
- debug/assertion test: if an ambient lookup would have succeeded without explicit local addressability, the suite fails loudly instead of silently succeeding

### Step 5. Replace finish discovery with static lane accounting

Goal:

- use eager lane structure for finish accounting without adding finish counters

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/buffer-iterator.js](C:\Projects\cascada\src\runtime\buffer-iterator.js)

Changes:

- replace `_collectKnownChannelNames()` with `Object.keys(buffer.arrays)`
- keep `_visitingIterators` only as a notification mechanism
- do not introduce `_totalLaneCount` or `_finishedLaneCount`
- do not fully remove `_linkedChannels` / `_finishRequestedChannels` yet if runtime-dynamic lanes or lazy lane creation still exist anywhere
- simplify `markFinishedAndPatchLinks()` to iterate eager `arrays` keys directly

Clarification:

- `_collectKnownChannelNames()` should disappear rather than surviving as
  another lane enumeration helper
- `_linkedChannels` / `_finishRequestedChannels` survive until static lane completion is fully in place; Step 9 is where they are actually removed

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

- remove the lazy `if (!this.arrays[name]) this.arrays[name] = []` path from `_add(...)`
- assert that every add/snapshot path targets a known static lane
- keep this assertion behind a development/debug gate at first
- do not make it unconditional until after the remaining runtime-dynamic lane cases are gone; Step 10 is where it should become unconditional
- acknowledge that `_addCommand(...)` will now fail through the same missing-lane assertion path, which is the desired outcome for an invalid compiled/runtime contract
- leave `_registerLinkedChannel(...)` calls in `_add()` alone for now if they are still carrying finish-accounting compatibility; that cleanup belongs to Step 9

Tests for this step:

- keep all passing integration tests green

Still-unimplemented tests to add here:

- targeted runtime test: missing lane in `_add()` throws immediately
- targeted runtime test: missing linked parent channel at buffer creation throws immediately

### Step 7. Remove dead transitional runtime state

Goal:

- remove dead or redundant transitional state once the earlier structural steps land

Primary files:

- [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)
- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)

Changes:

- remove dead `_channelTypes`
- remove dead `_channelRegistry` if no runtime reads remain
- remove the dead `_channels` initialization guard in `_registerChannel(...)`
- remove any remaining duplicate registration scaffolding once
  `declareBufferChannel(...)` becomes canonical
- if temporary migration assertions were added for ambient lookup success, keep
  this step limited to deleting the dead transitional scaffolding around them,
  not the assertions themselves

Tests for this step:

- existing declaration/snapshot tests should remain green; no major behavioral
  change is expected if this step is kept to dead-state cleanup

Still-unimplemented tests to add here:

- no new behavior-focused tests are required here beyond confirming the earlier
  steps still pass

### Step 8. Remove `_channels` and fix the finished-snapshot fast path

Goal:

- eliminate the hierarchy-wide channel registry completely

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)

Changes:

- remove `_channels`
- remove its dead initialization guard in `_registerChannel(...)`
- route finished `SnapshotCommand` / `RawSnapshotCommand` handling and especially `_runFinishedSnapshotCommand(...)` through the local addressability mechanism
- update the finished-buffer fast path in `addCommand(...)` so both channel retrieval and the `output._buffer.isFinished(...)` guard use local addressability instead of `_channels`
- narrow `_registerChannel(...)` so it no longer manages `_channels`; if `_ownedChannels` remains as debug metadata, its write can stay there

Tests for this step:

- keep existing snapshot suites green

Still-unimplemented tests to add here:

- integration test: finished-buffer snapshot still works after `_channels` removal
- integration test: finished raw snapshot still works after `_channels` removal

### Step 9. Collapse finish handling and remove remaining compatibility state

Goal:

- finish the transition to fully static lane-based completion once all dynamic structure creation is gone

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/buffer-iterator.js](C:\Projects\cascada\src\runtime\buffer-iterator.js)

Changes:

- remove `_linkedChannels`
- remove `_registerLinkedChannel(...)`
- remove the `_registerLinkedChannel(...)` call from `_add()`
- remove `_finishRequestedChannels`
- remove `_finishKnownChannelIfRequested(...)`
- remove the backward-compatibility alias `markChannelFinished(...)` if it no longer serves a purpose
- make `requestChannelFinish(...)` the direct lane-finish path:
  - resolve canonical name
  - assert the lane exists
  - call `_markChannelFinished(...)`
  - notify iterators through the surviving finish path
- keep aggregate buffer completion gated by `markFinishedAndPatchLinks(...)`;
  per-lane finish requests must not complete the aggregate buffer by themselves
- keep aggregate finish based on the lane keys in `arrays` unless a later change
  removes equivalent finish state at the same time it adds counters
- keep per-lane finished flags
- keep `_visitingIterators` only for notifications
- keep `_ownedChannels` as debug/assert metadata only unless Step 10 proves it is no longer useful

Important dependency:

- `_linkedChannels` / `isLinkedChannel(...)` are currently used by
  `hasLinkedChannelPathToOwner(...)` in [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)
  for the late-linked-child case where an ancestor lane has already finished
  and the child records the structural link on itself instead
- Step 9 therefore cannot remove `_linkedChannels` as a `command-buffer.js`
  only cleanup; the corresponding late-link readability path in `lookup.js`
  must be replaced or narrowed at the same time

Tests for this step:

- declared-but-unused lanes do not block aggregate finish
- child buffers entered through iterators still complete correctly under static lane accounting
- `getFinishedPromise()` resolves under the final static-lane finish model

### Step 10. Remove migration fallbacks and make invariants unconditional

Goal:

- finish the cleanup and stop tolerating partial analysis/runtime drift

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)

Changes:

- delete any temporary debug-only compatibility paths that are no longer needed
- make the static-lane / local-lookup invariants unconditional
- finalize the disposition of `_ownedChannels`:
  - keep it only as debug/assert metadata if it still provides value
  - otherwise remove it entirely
- audit `parent` vs `linkedParent` separately:
  - keep `parent` if it is still required for iterator/tree structure
  - remove or simplify `linkedParent` only if it no longer serves a distinct purpose after local-only lookup and eager linking are in place

Final verification for this step:

- run focused suites for:
  - `tests/pasync/channels-explicit.js`
  - `tests/pasync/calls.js`
  - `tests/pasync/template-command-buffer.js`
- then run the full relevant test suite

## Final Recommendation

The refactor should proceed with these goals:

1. Remove `_channels`.
2. Remove lazy lane creation from `_add()`.
3. Replace `_collectKnownChannelNames()` with a static per-buffer lane set.
4. Track aggregate finish only for this buffer's own lanes.
5. Make `findChannel()` local-only and O(1).
6. Remove descendant/ancestor/global lookup from normal channel resolution.
7. Keep lexical scope ownership separate from command-buffer parent/child structure.
8. Remove `_linkedChannels`.
9. Make `declareBufferChannel(...)` the single canonical registration path.
10. Collapse finish handling once static lane creation guarantees lane existence.
11. Keep `_channelAliases` as an explicit canonical-name concern integrated into the refactor.
12. Treat all channels uniformly inside command-buffer/runtime logic.

In short:

- structure should be static
- arrays should be eager
- lookup should be local
- finish should be lane-based
- command-buffer logic should stop carrying language-level special cases

## Cleanup Execution Plan

This is the practical cleanup-first sequence to use when implementing the
remaining runtime cleanup work. It is intentionally narrower than the full
architectural refactor above and is meant to keep changes reviewable.

Preflight notes for the current codebase:

- treat `_channelTypes` as live until composition payload capture no longer
  reads it
- treat `_channelRegistry` as an audit-first cleanup candidate, not as
  architecturally meaningful state
- do not make eager/static lane assertions unconditional while runtime-dynamic
  declaration paths such as `declareBufferChannel(..., name, ...)` still exist
- account for both buffer creation shapes:
  - `createCommandBuffer(context, parent, ...)`, where `_channels` is inherited
    from `parent`
  - `createCommandBuffer(context, null, linkedChannels, linkedParent)`, where
    structural linking exists without `_channels` inheritance

Recommended implementation stages:

1. **Stage 1: Baseline and registration cleanup** combines the old Phases 0-2.
   These changes are low-level cleanup and can be implemented together if the
   validation stays focused.
2. **Stage 2: Static lane metadata and eager structure** combines the old
   Phases 3-5. These changes are tightly coupled because lane metadata, eager
   arrays, and finish accounting all need the same lane source of truth.
3. **Stage 3: Local addressability and `_channels` removal** combines the old
   Phases 6-7. Finished snapshots, `findChannel(...)`, and shared observation
   should move to the same explicit addressability model in one stage.
4. **Stage 4: Compatibility cleanup and final invariants** combines the old
   Phases 8-9. This is the final deletion pass after the new model is carrying
   all behavior.

The stage boundaries are intentional. Work inside a stage can be combined, but
do not merge Stage 2 with Stage 3 until static lane metadata is stable, and do
not start Stage 4 until late-linked/shared inheritance scenarios have dedicated
coverage.

### Stage 1A. Lock in the current cleanup baseline

Goal:

- preserve the cleanup behavior that already exists before removing more state

Work:

- keep the existing tests that assert:
  - processed command entries become `null`
  - finished child-buffer slots become `null`
  - finished lane arrays become `null`
  - finished iterators dispose their own state
  - channel completion promise state is cleared
  - finished-buffer request bookkeeping is cleared
- add or keep at least one focused test that proves linkage/readability still
  works after lane-array cleanup

Primary files:

- [tests/pasync/snapshots.js](C:\Projects\cascada\tests\pasync\snapshots.js)
- [tests/pasync/loop-concurrent-limit.js](C:\Projects\cascada\tests\pasync\loop-concurrent-limit.js)

### Stage 1B. Audit and remove dead write-only cleanup targets

Goal:

- delete state that is not part of the actual runtime contract without removing
  maps that still have live compatibility consumers

Work:

- confirm `_channelRegistry` has no runtime readers, then remove it if the audit
  stays clean
- keep `_channelTypes` for now because composition payload capture reads it
- add a replacement plan for `_channelTypes` before the static lane metadata
  stage; likely replacement: declared lane/channel-type metadata installed on
  the buffer
- remove the dead `if (!this._channels)` initialization guard in
  `_registerChannel(...)`

Primary files:

- [src/runtime/channels/index.js](C:\Projects\cascada\src\runtime\channels\index.js)
- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/composition-payload.js](C:\Projects\cascada\src\runtime\composition-payload.js)

Validation:

- run focused declaration/snapshot tests
- run at least one composition/import/export test that exercises payload
  declaration skipping

### Stage 1C. Clean up duplicate registration

Goal:

- make `declareBufferChannel(...)` the only canonical registration path

Work:

- remove `_buffer._registerChannel(...)` from `Channel` construction
- make `declareBufferChannel(...)` explicitly take over the
  `bindToCurrentBuffer()` side effect currently reached through
  `_registerChannel(...)`, so channel iterators do not silently stop binding to
  their owning buffer
- confirm that `declareBufferChannel(...)` still handles all channel kinds:
  - text
  - var
  - data
  - sequence
  - sequential path / `sequential_path`
- keep `_channelTypes` updates in `declareBufferChannel(...)` during this stage
  unless the Stage 1B replacement has already landed

Primary files:

- [src/runtime/channels/index.js](C:\Projects\cascada\src\runtime\channels\index.js)
- [src/runtime/channels/base.js](C:\Projects\cascada\src\runtime\channels\base.js)
- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)

Validation:

- run snapshot tests
- run tests that declare channels through normal environment/render entry points

### Stage 2A. Thread static lane metadata without adding buffer state

Goal:

- prepare the runtime for eager arrays and simpler finish accounting without
  adding parallel lane-list or lane-count properties

This stage is mostly plumbing, not new compiler analysis work.

`declaredChannels` already exists on node `_analysis` objects today. The work
here is to thread that existing information into buffer construction, not to
create a new analysis pass.

Work:

- thread constructor-time lane names into `createCommandBuffer(...)`
- use eager `arrays[name] = []` as the materialized lane structure
- do not add persistent `_laneNames`, `_laneNameSet`, `_totalLaneCount`, or
  `_finishedLaneCount` properties
- keep current behavior temporarily, but assert that runtime-discovered lane
  names match the eager `arrays` keys where useful
- add a helper parallel to `getLinkedChannelsArg(...)` for declared lanes
- thread declared-lane information from compiler analysis into
  `createCommandBuffer(...)`
- inventory and either eliminate or mark as temporary every runtime-dynamic
  declaration site before using the new metadata for hard assertions

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/async-boundaries.js](C:\Projects\cascada\src\runtime\async-boundaries.js)
- [src/runtime/component.js](C:\Projects\cascada\src\runtime\component.js)
- [src/runtime/inheritance-call.js](C:\Projects\cascada\src\runtime\inheritance-call.js)
- [src/compiler/emit.js](C:\Projects\cascada\src\compiler\emit.js)
- [src/compiler/buffer.js](C:\Projects\cascada\src\compiler\buffer.js)
- [src/compiler/boundaries.js](C:\Projects\cascada\src\compiler\boundaries.js)
- [src/compiler/macro.js](C:\Projects\cascada\src\compiler\macro.js)
- [src/compiler/inheritance.js](C:\Projects\cascada\src\compiler\inheritance.js)
- [src/compiler/loop.js](C:\Projects\cascada\src\compiler\loop.js)

Validation:

- add focused compile-source tests for declared-lane plumbing
- keep existing integration suites green

### Stage 2B. Make lane creation eager

Goal:

- stop using first write as the mechanism that creates runtime structure

Work:

- eagerly create `arrays[name] = []` for the full static lane set at buffer
  construction
- keep alias/canonical-name setup ahead of lane creation
- preserve the current constructor ordering where `_channelAliases` inheritance
  happens before lane setup, so eager arrays use canonical/runtime names from
  the start
- add assertions for any attempted add/snapshot against a missing lane
- initially keep the assertion behind a debug/development gate if needed
- keep lazy lane creation as a temporary compatibility fallback for any
  explicitly inventoried runtime-dynamic declaration paths until those paths are
  converted or removed

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- compiler call sites that build buffers
- root/entry-buffer creation paths as well as child-buffer creation paths

Validation:

- add targeted tests for:
  - declared-but-unused lanes
  - missing-lane add failures
  - missing linked-parent lane failures

### Stage 2C. Move finish accounting onto static lane metadata

Goal:

- stop reconstructing lane membership from merged runtime state

Work:

- replace `_collectKnownChannelNames()` as the driver of finish accounting
- use `Object.keys(buffer.arrays)` as the fixed lane list during the migration
  state
- do not introduce a separate finished-lane counter while dynamic
  compatibility lanes still exist
- keep `_visitingIterators` only for notifications

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/buffer-iterator.js](C:\Projects\cascada\src\runtime\buffer-iterator.js)

Validation:

- verify `getFinishedPromise()` still resolves correctly
- verify child buffers still complete correctly under iterator traversal

### Stage 3A. Remove `_channels` by converting finished snapshots to local addressability

Goal:

- eliminate the hierarchy-wide channel registry

Work:

- establish one explicit local addressability mechanism
- prefer repurposing `_ownedChannels` during this stage rather than adding a new
  permanent map
- seed that mechanism in two stages:
  - linked parent channel refs installed during buffer construction
  - locally declared channel refs installed when `declareBufferChannel(...)`
    runs
- assert when a statically linked parent channel ref cannot be installed, so
  missing linkage fails at construction time instead of being masked by the
  old ancestor-walk fallback
- route `findChannel(...)`, finished observation handling in `addCommand(...)`,
  and `_runFinishedSnapshotCommand(...)` through that local mechanism
- remove `_channels`
- keep the net `CommandBuffer` property count flat or lower in this stage

Clarification:

- this stage routes finished snapshots and lookup through the local
  addressability mechanism
- the remaining ancestor-walk fallback in `findChannel(...)` may stay in place
  temporarily during this stage for migration safety
- Stage 3B is where that fallback is removed entirely

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)

Validation:

- keep snapshot suites green
- add explicit tests for finished snapshot behavior after `_channels` removal

### Stage 3B. Remove ambient ancestor lookup

Goal:

- make lookup local-only

Work:

- remove ancestor walk from `findChannel(...)`
- keep shared observation and readability checks aligned with the same explicit
  addressability model

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)

Validation:

- add tests proving parent lookups cannot see child-scope-only declarations
- keep explicit linked-lane observation tests green

### Post-Stage 3 review follow-ups

These are known residuals after Stages 1-3. They should not block the Stage 3
end state, but they must stay visible so the final cleanup does not normalize
the migration scaffolding into permanent design.

- `_add(...)`, `onEnterBuffer(...)`, `_registerChannel(...)`, and
  `_installLinkedChannel(...)` still reach `_ensureLane(...)`. This preserves
  runtime-dynamic compatibility for internal channels such as `__invoke__`,
  waited-loop channels, alias-linked child buffers, and shared/inheritance
  runtime-created lanes. The analysis-channel refactor must audit each
  remaining `_ensureLane(...)` call and either remove it or document the
  explicit dynamic path that still owns it.
- Missing-lane add/snapshot failures remain analysis-channel/final-invariant
  validation, because the current compatibility fallback intentionally creates
  several internal runtime lanes before the assertion can fire.
- Macro/caller, component, and inheritance-created buffers still contain some
  runtime-dynamic lane creation paths. Before hard missing-lane assertions become
  unconditional, each of those creation paths must either receive static lane
  metadata or be replaced by a narrower explicit mechanism.
- Macro/caller invocation buffer creation in
  [src/compiler/macro.js](C:\Projects\cascada\src\compiler\macro.js) now
  threads caller-visible linked channels and caller-local declared lanes through
  `__callerUsedChannels` and `__callerDeclaredChannels`.
- Async render-boundary buffer creation in
  [src/compiler/boundaries.js](C:\Projects\cascada\src\compiler\boundaries.js)
  now threads the render text lane into `runRenderBoundary(...)`. Custom
  extension content bodies can still arrive as fragments whose body-local
  declarations are not summarized on the fragment analysis object; this is
  marked `ANALYSIS-CHANNELS-REFACTOR` in code and should be resolved by the
  analysis-channel refactor rather than by ad hoc render-boundary filtering.
- `uniqueLaneNames(...)` in `CommandBuffer` is marked
  `ANALYSIS-CHANNELS-REFACTOR`; after analysis-owned linked/declared lane
  metadata becomes authoritative, duplicate lane names should be treated as an
  assertion failure rather than normalized defensively.

### Stage 4A. Remove remaining compatibility finish/link state

Goal:

- delete the old compatibility scaffolding once the new structure owns finish
  semantics

Work:

- remove `_finishRequestedChannels` (**done**)
- remove `_finishAllChannelsRequested` (**done**)
- remove `_finishKnownChannelIfRequested(...)` (**done**)
- remove `_linkedChannels` (**done**)
- remove `_registerLinkedChannel(...)` (**done**; replaced by
  `_installLinkedChannel(...)` writing into the single local addressability map)
- remove the `_registerLinkedChannel(...)` call from `_add()` (**done**)
- remove `markChannelFinished(...)` if it is no longer needed (**done**; tests
  now use `requestChannelFinish(...)` directly)
- `requestChannelFinish(...)` is now the direct per-lane finish request path
  (**done**); it does not complete aggregate buffer state by itself. Aggregate
  completion remains gated by `markFinishedAndPatchLinks(...)`.

Important coordination:

- `hasLinkedBuffer(...)` now derives its answer from concrete channel refs in
  the local `_channels` map; it no longer relies on separate `_linkedChannels`
  storage
- `isLinkedChannel(...)` was test-only after this refactor and has been removed;
  tests assert linked addressability through `hasChannel(...)` plus
  `getOwnChannel(...)`
- before removing `hasLinkedBuffer(...)`, add a focused test that exercises the
  late-linked-child scenario explicitly: a child buffer linked to a parent lane
  created after the ancestor lane is already finished (**done**)
- only remove the fallback once that scenario is either:
  - handled correctly by eager/local lane installation without
    `hasLinkedBuffer(...)`, or
  - replaced by a narrower explicit mechanism

Primary files:

- [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js)
- [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js)

Validation:

- verify late-linked shared/inheritance cases explicitly
- add one dedicated late-linked-child regression test before deleting
  `_linkedChannels`
- verify aggregate finish still works for buffers with unused eager lanes
- verify `requestChannelFinish(...)` rejects unknown lane names instead of
  silently creating or finishing them

### Stage 4B. Final cleanup pass

Goal:

- remove any metadata that no longer provides runtime value
- collapse the remaining channel-addressability API into one clear surface
- remove the compiler/runtime split between linked-channel lists and
  declared-channel lists where a single structured local-addressability payload
  can carry the same information more clearly

Work:

- decide whether `_ownedChannels` remains as assertion/debug metadata or is
  removed entirely (**done**; ownership is derived from `channel._buffer`)
- if linked channels and owned channels both store concrete channel objects by
  this point, merge `_ownedChannels` and `_linkedChannels` into a single
  local addressability map, likely `_channels` (**done**)
- derive ownership from the channel object itself, for example
  `channel._buffer === this`, instead of maintaining a second lookup table just
  for ownership
- keep channel access behind `CommandBuffer` methods rather than reading
  `_channels` directly from other modules (**done**)
- replace the current `findChannel(...)` name with clearer accessors:
  - `getChannel(name)` for must-exist lookups that throw
  - `hasChannel(name)` for boolean local-only existence checks
  - `getChannelIfExists(name)` for optional local-only lookups that need the
    channel object and where absence is a valid branch
  - `getOwnChannel(name)` for local ownership checks
  (**done**)
- keep `getChannelIfExists(...)` rare and auditable; when a missing channel
  would indicate bad linking, declaration ordering, or analysis metadata, call
  `getChannel(...)` instead so the invariant fails loudly
- preserve the invariant that these accessors are local-only and never walk
  `parent`
- revisit buffer-construction arguments such as `linkedChannelsArg` and
  `declaredChannelsArg`; once local addressability has one runtime map, prefer
  a single structured channel/lane payload over parallel linked/declared
  arrays
- as part of that consolidation, remove capture-boundary glue that manually
  filters nested capture text outputs out of `linkedChannelsArg`; capture text
  outputs should be represented as local declarations/owned lanes in the
  analysis channel metadata described in
  [analysis-channels-refactor.md](C:\Projects\cascada\docs\code\analysis-channels-refactor.md)
  instead of filtered by custom boundary code
- delete any temporary migration assertions or debug-only fallback paths
- re-audit `parent` vs `linkedParent`
- confirm that cleanup still nulls:
  - command entries
  - child-buffer entries
  - finished lane arrays
  - iterator state
  - completion bookkeeping

Final verification:

- run focused suites:
  - `tests/pasync/snapshots.js`
  - `tests/pasync/channels-explicit.js`
  - `tests/pasync/calls.js`
  - `tests/pasync/template-command-buffer.js`
- then run the broader relevant test suite

Deferred scope:

- scope-unique `__return__#<scopeId>` ownership is intentionally deferred from
  this cleanup-first execution plan
- it remains part of the larger architectural refactor above, but it is not a
  prerequisite for the narrower cleanup stages listed here
