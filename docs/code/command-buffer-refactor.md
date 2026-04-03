# Command Buffer Refactor

## Overview

This document records the findings from evaluating the current `CommandBuffer` architecture and the refactor direction around channel visibility, lane linking, and eager runtime structure creation.

The immediate trigger was this line in [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js):

```js
this._channels = parent ? parent._channels : new Map();
```

That line makes channel registration effectively hierarchy-global. It is too broad for the current compiler/runtime model, because the compiler already computes which parent-visible channels a child buffer actually uses, and the runtime already accepts that narrower set when creating child buffers.

The main conclusion is:

- the current shared `_channels` registry is overreaching and should be removed
- visibility should become explicit rather than ambient
- structural lanes and declared channels should be created eagerly from compile-time information rather than lazily on first write/read

This is not just a one-line change. The shared registry is only one part of the problem.

There is also one important orthogonal piece of runtime state that is not part of the four-way simplification below:

- `_channelAliases`

That alias layer is used for explicit channel binding cases such as macro/caller aliasing. It is not the same kind of state as `_ownedChannels`, `_visibleChannels`, `_linkedChannels`, or `_channels`, and it should be treated as a separate concern during the refactor rather than merged into the ownership/visibility model.

## Current Runtime State

`CommandBuffer` currently tracks four related pieces of channel state:

- `_linkedChannels`
- `_ownedChannels`
- `_visibleChannels`
- `_channels`

Their current roles are:

### `_ownedChannels`

`_ownedChannels` contains channels declared by this buffer itself.

Examples:

- channels created by `runtime.declareBufferChannel(...)`
- text channels declared for local text boundaries
- local `var`, `data`, `sink`, `sequence`, and `sequential_path` channels

This concept is valid and should remain.

### `_visibleChannels`

`_visibleChannels` contains explicit lookup-only visibility links to channels owned elsewhere.

This is currently used for composition/export-style cases where a buffer should be able to read a channel without structurally owning a child buffer on that lane.

This concept is also valid and should remain.

### `_linkedChannels`

`_linkedChannels` records channel names that are structurally linked into the buffer tree, so finish accounting knows that the buffer participates in those lanes even if it does not own the channel itself.

Today this is mostly a bookkeeping structure for finish behavior.

This concept can probably be removed if lane arrays are created eagerly for all linked lanes at buffer creation time.

### `_channels`

`_channels` is a shared registry of channel objects across the whole hierarchy.

This is the problematic structure.

It bypasses boundary-local ownership and visibility and makes channels discoverable far outside the lanes/scopes the compiler intended a child to see.

## Why `_channels` Is Wrong

The compiler already computes channel usage information:

- `node._analysis.usedChannels`
- `node._analysis.mutatedChannels`
- per-boundary linked channels in [src/compiler/emit.js](C:\Projects\cascada\src\compiler\emit.js)

`getLinkedChannelsArg(...)` already filters `usedChannels` down to the channels a child buffer should be structurally attached to:

- current text channel is included when needed
- `__return__` is excluded
- channels declared locally inside the child are excluded

That filtered set is already passed to runtime helpers such as:

- `runtime.runControlFlowBoundary(...)`
- `runtime.runValueBoundary(...)`
- `runtime.runWaitedControlFlowBoundary(...)`
- direct `runtime.createCommandBuffer(...)` calls in macro/caller paths

The runtime boundary helpers in [src/runtime/async-boundaries.js](C:\Projects\cascada\src\runtime\async-boundaries.js) already pass those linked channels into `createCommandBuffer(...)`.

So the architecture is already half-way to a narrower, explicit model.

The problem is that `_channels` undermines it by keeping all registered channels globally reachable anyway.

## The Deeper Problem: Ambient Visibility

Even if `_channels` were removed, the current implementation would still be too broad.

`findChannel(...)` in [src/runtime/command-buffer.js](C:\Projects\cascada\src\runtime\command-buffer.js) currently:

1. checks local `_ownedChannels`
2. checks local `_visibleChannels`
3. checks linked child-owned channels
4. walks up ancestor buffers and checks their `_ownedChannels`
5. finally falls back to `_channels`

Steps 4 and 5 create ambient parent-channel visibility.

That means a child can often discover a parent-owned channel even when the compiler did not link that lane into the child.

This is especially dangerous because [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js) assumes:

- if `findChannel(name)` returns a channel whose owner is in the current buffer ancestry
- then `currentBuffer.addSnapshot(name, ...)` is a valid ordered read

That assumption is only valid if the current buffer actually participates in that lane structurally.

With ambient visibility, a child can enqueue a snapshot on a channel lane that was never linked into its buffer tree.

That is the core architectural mismatch.

## What The Correct Model Should Be

The refactor should make channel resolution explicit.

`findChannel(...)` should only resolve:

1. channels owned by this buffer
2. channels explicitly visible to this buffer
3. channels owned by linked child buffers reachable through this buffer's lane structure

It should not:

- walk ancestor `_ownedChannels` generically
- use a hierarchy-global fallback registry

That gives us a clean model:

- ownership is local
- visibility is explicit
- structural participation in a lane is explicit

## How Parent Visibility Should Work

The compiler-derived linked-channel set should drive both:

1. structural linking
2. visibility

When a child buffer is created with a list of linked channels:

- the child should be structurally attached to the parent on those lanes
- the child should also receive explicit visibility to those same parent-owned channels

That means linked channels are not just a finish-tracking detail. They are the explicit contract for what parent-owned channels a child may observe or mutate in order.

This is the natural runtime interpretation of compiler-side `usedChannels`.

## Recommended Simplified State Model

The current four structures should not survive unchanged.

The recommended target model is:

- keep `arrays`
- keep `_ownedChannels`
- keep `_visibleChannels`
- remove `_channels`
- remove `_linkedChannels` after eager lane creation is in place

That leaves three runtime concepts:

### `arrays`

Per-lane structural command storage.

This is how the buffer iterator walks each lane and how child buffers are inserted into a parent lane in source order.

### `_ownedChannels`

Local channel ownership only.

### `_visibleChannels`

Explicit read/write visibility to externally owned channels.

This includes:

- linked parent-visible channels for ordinary async boundaries
- composition/export visibility links such as deferred exports
- any future explicit alias/binding cases that are truly visibility-oriented

This recommendation does not remove `_channelAliases`. Alias resolution should stay as a narrow name-remapping layer that runs before ownership/visibility lookup.

## Are `_ownedChannels` And `_visibleChannels` Both Needed?

Yes.

They represent different semantics:

- `_ownedChannels` means "this buffer declared and owns this channel"
- `_visibleChannels` means "this buffer may resolve this channel, but ownership lives elsewhere"

Those are meaningfully different and should not be merged.

Keeping them separate helps preserve important runtime distinctions:

- where the iterator belongs
- where completion lives
- whether a channel is local state or externally sourced visibility

## Is `_visibleChannels` Redundant Once `usedChannels` Is Used Properly?

No.

The current comment in `command-buffer.js` says `_visibleChannels` may become redundant once `usedChannels` is used.

That is only partly true.

What becomes redundant is ambient channel visibility through `_channels` and ancestor walks.

But explicit non-structural visibility is still needed for cases like:

- deferred exports via `context.linkDeferredExportsToBuffer(...)`
- composition source buffers
- other explicit external exposure mechanisms

So `_visibleChannels` should remain. Its purpose just becomes narrower and cleaner.

## Channel Aliases Are Orthogonal

The current command-buffer implementation also maintains `_channelAliases`.

That structure is not part of the ownership/visibility/structural-lane simplification. It serves a different purpose:

- remapping formal names to resolved runtime channel names
- preserving macro/caller alias bindings down the buffer tree
- normalizing command ingress so downstream runtime logic sees canonical runtime channel names

The refactor should preserve that alias layer, but keep it narrow:

- aliasing should remain explicit
- aliasing should not become a substitute for ambient visibility
- aliasing should resolve names before ownership/visibility lookup

So the intended simplification is about `_channels`, `_linkedChannels`, `_ownedChannels`, `_visibleChannels`, and eager `arrays` behavior, not about removing `_channelAliases`.

## Eager Initialization Requirement

The refactor should eliminate lazy creation of buffer lanes and channel-lane storage within the command-buffer/channel subsystem.

This is consistent with the compile-time architecture.

Today there are several lazy behaviors:

- `CommandBuffer.add(...)` creates `arrays[channelName]` on first write
- comments in `command-buffer.js` explicitly describe channel arrays as being created lazily
- some finish behavior relies on `_linkedChannels` because structural lanes may exist conceptually without an array being present yet

This should be changed.

One more structural-laziness point exists today in [src/runtime/lookup.js](C:\Projects\cascada\src\runtime\lookup.js):

- `LOOKUP_DYNAMIC_CHANNEL_LINKING`

That feature flag enables a runtime path where an ordered read can lazily attach the current buffer to a channel lane on demand.

This is intentionally disabled today, but it is still part of the runtime surface area and should be accounted for by the refactor.

## Recommended Eager Rules

### Declared channels

When `runtime.declareBufferChannel(buffer, name, type, ...)` is called, the buffer should eagerly create:

- `buffer._ownedChannels[name]`
- `buffer.arrays[name]`

No later command should need to create the lane on demand.

### Linked lanes

When a child buffer is created with compiler-derived linked channels, the runtime should eagerly create:

- `child.arrays[channelName] = []`
- `child._visibleChannels[channelName] = parent.findChannel(channelName)` if available

This makes the child's structural participation and channel visibility explicit from the start.

### Local-only channels declared later at runtime

If a channel is truly runtime-dynamic and is declared by an explicit runtime declaration site, that declaration should also eagerly materialize its lane immediately.

No first-write allocation should remain in this subsystem.

## Why Eager Lane Creation Lets Us Remove `_linkedChannels`

Today `_linkedChannels` exists largely so finish logic knows about lanes that may not yet have an array or command entry.

If every linked lane is created eagerly in `arrays`, then `arrays` already captures structural lane existence.

At that point:

- `_collectKnownChannelNames()` can use `Object.keys(arrays)`
- finish/accounting no longer needs `_linkedChannels`
- linked-lane existence becomes part of the actual structural model rather than extra bookkeeping

That makes `_linkedChannels` redundant.

## Important Distinction: Structural Eagerness vs Lazy Value Semantics

This refactor should remove lazy channel/lane creation.

It should not be confused with removing Cascada's broader lazy value and promise-resolution semantics.

The runtime still intentionally supports deferred/lazy values in areas such as:

- [src/runtime/resolve.js](C:\Projects\cascada\src\runtime\resolve.js)
- [src/runtime/set-path.js](C:\Projects\cascada\src\runtime\set-path.js)
- command argument application in [src/runtime/commands.js](C:\Projects\cascada\src\runtime\commands.js)

Those are about value semantics and transparent async behavior.

They are not the same as lazily creating buffer lanes or lazily deciding whether a channel exists structurally.

So the intended rule is:

- remove lazy channel/lane materialization in the command-buffer/channel structure
- do not conflate that with removing lazy/deferred value resolution across the whole engine

In the same spirit, the optional `LOOKUP_DYNAMIC_CHANNEL_LINKING` path should not remain as an accidental escape hatch that reintroduces structural laziness into the command-buffer model.

The preferred options are:

- keep it disabled and document that the refactored model depends on compile-time structural linking, or
- redesign it so any future dynamic mode still preserves explicit visibility/lane semantics rather than calling back into ambient linkage behavior

## Snapshot And Lookup Implications

Once `_channels` and ambient ancestor visibility are removed, several methods should stop consulting the global registry and instead go through explicit lookup:

- `addSnapshot(...)`
- `addRawSnapshot(...)`
- `_runFinishedSnapshotCommand(...)`
- any other path that currently assumes `_channels.get(...)`

Those paths should use `findChannel(...)` or `getChannel(...)` so they obey the same explicit visibility rules as ordinary lookups.

This is important both for correctness and for keeping snapshot behavior aligned with structural lane participation.

## Compiler/Runtime Integration

The compiler already provides most of the information the runtime needs.

Relevant places:

- channel usage analysis in [src/compiler/analysis.js](C:\Projects\cascada\src\compiler\analysis.js)
- linked channel filtering in [src/compiler/emit.js](C:\Projects\cascada\src\compiler\emit.js)
- boundary creation in [src/compiler/boundaries.js](C:\Projects\cascada\src\compiler\boundaries.js)
- direct buffer creation in macro/caller code in [src/compiler/macro.js](C:\Projects\cascada\src\compiler\macro.js)

The refactor should reuse those compile-time results rather than inventing a second runtime-only visibility mechanism.

The intended flow is:

1. compiler computes `usedChannels`
2. compiler filters that to linked parent-visible channels
3. runtime creates child buffer with exactly those lanes visible/linked
4. lookup/snapshot behavior respects only explicit ownership/visibility

This also means the runtime should not try to "discover" missing structure later through fallback registry lookup or lazy lane creation.

## Sequence Locks And Special Channels

The refactor must preserve the special treatment of:

- `sequential_path` channels such as `!foo`
- `__return__`
- text channels such as `__text__`
- caller scheduling channels such as `__caller__`
- waited channels such as generated `__waited__...`
- `__parentTemplate`

Important notes:

- sequence locks are declared eagerly at root/macro scope and should remain explicit channels
- `__return__` should continue to be excluded from parent-linking
- waited channels should remain local timing channels and should not be linked as general parent-visible channels
- text channels are special because child structural text composition often intentionally links them

The existing compiler filtering rules around these channels should remain the source of truth.

## Deferred Exports And Composition

The refactor must preserve explicit visibility flows such as:

- `context.linkDeferredExportsToBuffer(...)`
- composition source buffer lookup
- inherited block input capture from composition source buffers or parent buffers

These are exactly the cases where `_visibleChannels` remains necessary.

They should not be re-expanded into ambient hierarchy visibility.

The document's recommendations assume that composition/export visibility remains explicit and opt-in, not inherited automatically through ancestry.

## Runtime-Dynamic Channel Names: Important Caveat

Most channel names are already compile-time known and declared explicitly.

However, there are still a few runtime-dynamic declaration sites.

The main example observed during the review is inherited/composed block local setup in [src/compiler/compiler-async.js](C:\Projects\cascada\src\compiler\compiler-async.js), where channel names are declared in a loop based on runtime block contracts and local-name lists.

That means two different claims must be distinguished:

### Feasible now

"No lazy channel/lane creation for compile-time-known declarations and linked lanes."

This is fully compatible with the refactor direction.

### Not automatically solved by this refactor

"No runtime-dynamic channel declaration anywhere in the engine."

That would require additional redesign of how block contracts and composition-local names are propagated.

So the command-buffer refactor should aggressively eliminate lazy structural creation where the structure is already known, but it should not pretend that every channel name in the system is currently compile-time static.

## Suggested Target Behavior For `createCommandBuffer(...)`

`createCommandBuffer(...)` should become the main eager-structure setup point for child buffers.

Given:

- `context`
- `parent`
- `linkedChannels`
- `linkedParent`

it should:

1. create the child buffer
2. resolve the effective link target
3. for each linked channel:
   - eagerly create `child.arrays[channelName] = []`
   - explicitly install `child._visibleChannels[channelName]` from the link target if that channel exists
   - structurally attach the child to the parent on that lane

This makes boundary creation deterministic and compile-time-driven.

Because `createCommandBuffer(...)` currently supports both `parent` and `linkedParent`, the implementation should continue to resolve an explicit effective link target rather than assuming those two are always the same object.

## Suggested Target Behavior For `findChannel(...)`

The lookup order should become:

1. local `_ownedChannels`
2. local `_visibleChannels`
3. linked child-owned channels reachable through this buffer's structural lane arrays

And then stop.

It should not:

- search ancestor `_ownedChannels`
- consult `_channels`

That is the key simplification that makes `usedChannels` actually meaningful.

## Likely Lookup Hotspot And Possible Optimization

One likely consequence of removing ambient visibility is that `_findLinkedChildOwnedChannel(...)` will become more important as a fallback path.

Today it scans a lane array in reverse and recursively descends into child buffers to find a linked child-owned channel. That is functionally correct, but it may become a noticeable lookup cost if many buffers and lanes are present.

This is not a reason to keep `_channels`, but it is worth tracking as a likely optimization target.

Possible future optimization directions:

- cache visible linked-child ownership once discovered
- eagerly register child-owned linked channels into a parent-side lookup structure
- maintain a per-lane child-channel index instead of repeated reverse scans

Those are optional follow-up optimizations, not required for the correctness refactor.

## Refactor Risks

This change will likely expose bugs that were previously hidden by over-broad visibility.

The most likely sensitive areas are:

- imported namespace/member-call boundaries
- from-import call boundaries
- caller/call-block machinery
- macro invocation buffers
- block/super/composition-local variable initialization
- `__parentTemplate`
- deferred exports
- sequence lock access

That is expected and desirable. The current broad model may be allowing invalid cross-boundary reads to succeed accidentally.

## Tests That Should Be Added Or Strengthened

The refactor should be validated with explicit tests for:

- child buffer cannot resolve an unrelated parent channel
- child buffer can resolve a linked parent-visible channel
- lookup cannot enqueue a snapshot on an unlinked lane
- deferred exports still resolve through explicit visibility links
- composition source buffer reads still work
- sequence locks still resolve correctly
- alias-based channel lookup still works
- disabled dynamic linking mode does not become required for correct ordered reads
- finished snapshot behavior still works without `_channels`
- macro caller scheduling still only links the intended channels
- imported-call boundaries still do not pull unrelated locals into linked channels

Some existing tests already cover parts of this behavior, especially around:

- imported-call boundary channel linking
- caller scheduling
- alias-based snapshots
- per-channel finish/snapshot behavior

Those tests should be preserved and expanded rather than replaced.

## Final Recommendation

The refactor should proceed with these goals:

1. Remove `_channels`
2. Remove ambient ancestor-channel visibility from `findChannel(...)`
3. Keep `_ownedChannels`
4. Keep `_visibleChannels`
5. Eagerly create lane arrays for:
   - all declared channels
   - all linked structural lanes
6. Remove `_linkedChannels` once eager lane creation makes it redundant
7. Route all snapshot/lookup paths through explicit ownership/visibility resolution
8. Reuse compiler-derived `usedChannels` / linked-channel analysis rather than inventing new runtime inference

In short:

- ownership should be local
- visibility should be explicit
- structure should be eager
- the command-buffer subsystem should be driven by compile-time channel analysis wherever possible
