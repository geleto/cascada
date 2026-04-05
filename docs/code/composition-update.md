# Composition Update

This document extracts the composition/import/export follow-up work that was previously mixed into [command-buffer-refactor.md](https://markdownlivepreview.com/command-buffer-refactor.md).

It now owns the material that was previously tracked there as Steps 9-10.

It covers only the composition-specific changes:

-   deferred exports resolving from explicit producer snapshots
    
-   explicit named composition inputs instead of ambient buffer visibility
    
-   removal of runtime-dynamic block/composition input declaration
    

Core command-buffer structure changes remain in [command-buffer-refactor.md](https://markdownlivepreview.com/command-buffer-refactor.md).

## Main Conclusions

The composition update should move toward these rules:

1.  Deferred exports should resolve from explicit producer snapshots, not ambient visibility.
    
2.  Composition should not use channel linking/lookup for data transport.
    
3.  Async composition should use explicit named inputs consistently across include, import, block, and super().
    
4.  Block entry should receive explicit named-input payloads instead of recovering input names from Context at runtime.
    
5.  Composition-specific runtime helpers should disappear once explicit payload passing is in place.

6.  Explicit block inputs and `with context` render-context visibility must remain distinct semantics during the refactor.
    

Terminology note:

-   this document uses compositionSourceBuffer as shorthand for the per-template source-buffer entry currently stored inside compositionSourceBuffersByTemplate
    

## Deferred Exports

Current deferred exports in src/environment/context.js work by:

-   storing a promise placeholder in context.ctx
    
-   remembering the producing { channelName, buffer }
    
-   later resolving that export from channel.finalSnapshot()
    

So yes: deferred exports are ultimately resolved from final snapshots.

### Why are they linked to buffers today?

After auditing the current code, the justification looks weak.

addDeferredExport(...) stores both:

-   the resolver in exportResolveFunctions
    
-   the explicit producer record { channelName, buffer } in exportChannels
    

Then resolveExports(...) resolves from that explicit producer buffer directly.

### Target Direction

This should be simplified.

Deferred exports should not need general-purpose buffer linking if the producer { buffer, channelName } is already known.

The clean target is:

-   deferred exports resolve directly from their producer channel finalSnapshot()
    
-   they do not rely on ambient visibility or general buffer linking
    

resolveExports(...) in src/environment/context.js already mostly follows this model because it stores { buffer, channelName } pairs and resolves from the producer buffer directly.

That means linkDeferredExportsToBuffer(...) should be audited aggressively. It may already be redundant for export resolution itself.

## linkDeferredExportsToBuffer(...)

This is part of the current export/linkage mechanism, not extern passing.

After auditing current callers, it appears to be used only from async-root setup, and linkVisibleChannel(...) is only used by this export-linking path.

That should likely shrink or disappear as export handling is simplified around direct producer snapshots.

If that audit result holds, the cleanup is broader than just one call site:

-   linkVisibleChannel(...) becomes removable
    
-   the \_visibleChannels export-linking role becomes removable as well, if no other writers are introduced
    
-   any broader findChannel(...) traversal cleanup still belongs to the command-buffer/runtime migration, not to Step A alone
    

Also, resolveExports(...) still has a fallback arm that does:

-   currentBuffer.findChannel(name)
    

After auditing Context, this fallback appears defensive rather than essential:

-   addDeferredExport(...) always creates both a non-null resolver and an exportChannels\[name\] record
    
-   addResolvedExport(...) stores a resolved value and marks the resolver slot as null
    

So in normal deferred-export flow, a non-null resolver should already imply an explicit producer record. The fallback should therefore become an assertion during refactor, and then be removed once the invariant is validated by tests.

The sequencing matters:

-   first assert that a deferred export resolver never exists without a matching exportChannels\[name\] producer record
    
-   then run focused suites to prove the assertion never fires
    
-   only after that remove linkDeferredExportsToBuffer(...) and the currentBuffer.findChannel(name) fallback arm
    

## Composition And Extern Inputs

Current composition still has some buffer-based machinery:

-   compositionSourceBuffer
    
-   findChannel(name)?.finalSnapshot()
    
-   block input recovery from composition buffers or parent buffers
    

Architecturally, this should change.

The target is:

-   all composition operations use explicit named inputs
    
-   this should follow the same with ... / extern-style pattern consistently
    
-   composition should not rely on channel linking/visibility for value transport
    
-   composition should pass named snapshots/promises/macros as inputs

-   explicit block inputs and `with context` render-context visibility should remain separate channels of information rather than being collapsed into one generic inherited-input mechanism
    

So yes: composition should move away from buffer linking.

This is not just an adjacent cleanup. It is the main remaining source of runtime-dynamic channel names, so it needs to be solved if we want fully static composition entry and buffer lane sets.

The chosen direction should be stated directly:

-   composition/block calls should use explicit with ...\-style named inputs
    
-   block entry functions should receive those inputs explicitly rather than discovering names from block contracts at runtime
    
-   the current runtime loop over context.getBlockContract(...).inputNames should be removed

One important nuance:

-   the explicit payload path already exists for direct block invocations that have explicit `withVars` / `with context`; the remaining work is to generalize that model to overriding blocks and `super()` paths that currently fall back to runtime recovery when `blockContext` is null
    

## Runtime-Dynamic Composition Channel Names

This should be fixed as part of the composition update.

The target is:

-   no runtime-dynamic composition/block-input channel names
    
-   block/composition entry uses compile-time-known names
    

That means composition/block input handling must be redesigned so it does not loop over runtime names and call:

-   declareBufferChannel(currentBuffer, name, ...)
    

Instead:

-   composition should pass explicit named snapshot values
    
-   the receiving template/script should use explicit extern/input bindings
    
-   block entry should initialize from an explicit payload, not from context lookup
    

So the current composition/block-input runtime loop is not something to accommodate with a permanent lazy fallback. It is technical debt to remove.

However, that runtime-loop removal depends on a separate structural prerequisite:

-   block/composition inputs still need real local var channels/lane declarations before block bodies run

-   if the command-buffer refactor has not yet made local declared lanes constructor-time/static, this plan must keep a temporary declaration path until that prerequisite lands

## Tests And Invariants

The composition update should preserve and strengthen invariants such as:

-   deferred exports resolve from final snapshots
    
-   resolveExports(...) relies on explicit producer records rather than ambient buffer visibility
    
-   composition uses explicit named inputs, not channel visibility
    
-   no runtime-dynamic composition/block-input channel declaration remains

-   explicit block inputs do not become conflated with `with context` render-context visibility

-   same-template and inherited block invocation snapshot values at invocation time rather than reading final channel state later

-   removing compositionSourceBuffer lookup also removes the parentBuffer?.findChannel(name)?.finalSnapshot() fallback, unless that fallback is deliberately justified and retained

-   extern/input validation rejects self-cycles and indirect initialization cycles as part of the same explicit-input contract model
    

## Migration Strategy

Because the current async composition code still tolerates some compatibility paths, the update should tighten invariants in stages:

1.  add debug/development assertions around unexpected export fallbacks and unexpected runtime-discovered composition inputs
    
2.  run focused composition and export suites to surface any remaining gaps
    
3.  remove the old fallback paths once the assertions stop firing
    

This is especially important for:

-   removal of deferred-export fallback lookup
    
-   composition/block-input staticization

-   distinguishing temporary command-buffer/runtime prerequisites from composition-specific cleanup
    

## Implementation Plan

### Step A. Simplify deferred exports around explicit producer records

Goal:

-   stop using buffer visibility for export resolution
    

Primary files:

-   src/environment/context.js
    
-   src/compiler/compiler-async.js
    

Changes:

-   make resolveExports(...) rely on the explicit { buffer, channelName } producer record
    
-   convert the currentBuffer.findChannel(name) fallback into an assertion first
    
-   remove linkDeferredExportsToBuffer(...) once tests confirm it is unnecessary
    
-   keep exportChannels / exportResolveFunctions as the explicit producer-record mechanism
    
-   remove the emitted context.linkDeferredExportsToBuffer(...) call from compiler output
    
-   remove linkVisibleChannel(...) as well, since export linking is its only current use
    
-   audit whether the \_visibleChannels slot still has any remaining purpose once export-linking no longer writes into it

-   if the writer audit still shows no non-export users, remove the \_visibleChannels storage only; any broader findChannel(...) traversal simplification remains a later/runtime concern
    

Ordering constraint:

-   do not remove linkDeferredExportsToBuffer(...) until the new assertion proves that every deferred resolver already has an explicit producer record
    

Tests for this step:

-   keep existing async import/from-import export tests green
    
-   keep loop-concurrent-limit async export tests green
    

Still-unimplemented tests to add here:

-   integration test: exported async value resolves correctly without parent visibility linking
    
-   integration test: resolveExports(...) fails/asserts if a deferred resolver exists without an explicit producer record
    

### Step B. Remove runtime-dynamic block/composition channel names

Goal:

-   make composition fully static and align it with the same explicit-input model as other composition operations
    

Primary files:

-   src/compiler/compiler-async.js
    
-   src/compiler/inheritance.js
    
-   src/environment/context.js
    

Changes:

-   redesign block/composition entry so the existing explicit `blockContext` payload path becomes the universal path, not just the path for direct `with ...` block invocations
    
-   make block entry functions receive an explicit named-input object or equivalent explicit parameter payload
    
-   have the compiler generate that payload from statically known call-site inputs where possible, and add a deliberate cross-template contract propagation mechanism where separate template compilation means the caller cannot know inherited block inputs purely from its own local AST
    
-   rewrite \_emitAsyncBlockInputInitialization(...) around those explicit inputs
    
-   stop using \_collectRootCompositionLocalChannelNames(...) as a compile-time source that feeds the generated runtime recovery loop for block entry
    
-   stop looping over context.getBlockContract(...).inputNames at runtime to declare channels
    
-   remove the runtime declareBufferChannel(currentBuffer, name, ...) loop for composition inputs
    
-   remove compositionSourceBuffer\-based channel lookup from block input initialization

-   remove the parentBuffer?.findChannel(name)?.finalSnapshot() fallback from block input initialization as part of the same cleanup, unless a deliberate replacement/retention rationale is written down
    
-   keep composition value transport snapshot-based and explicit
    
-   update Context.forkForComposition(...) if its current contract assumes channel/buffer-based composition lookup
    
-   audit whether setCompositionSourceBuffer(...), getCompositionSourceBuffer(...), getBlockContract(...), and forkForComposition(...) still have any remaining purpose after this redesign
    

Concrete target:

-   block/call-site compilation should construct the explicit named-input payload from explicit invocation inputs plus any intentionally visible same-template / inherited locals captured at invocation time
    
-   the generated block entry function should consume that payload directly
    
-   any same-template / child-template top-level locals that remain intentionally visible to the block should be captured into that payload at invocation time, not re-read later via finalSnapshot() from source buffers
    
-   inheritance.js and compiler-async.js must agree on the new entry-function signature and call shape
    
-   in practice, inheritance.js should build and pass the explicit named-input payload at block override/super call sites, and compiler-async.js block entry code should accept that payload directly
    
-   explicit block inputs and `with context` render-context visibility must remain separate in that payload/entry design
    
-   the current getBlockContract(...) use in runtime input-name discovery must be retired through the new explicit payload path

-   the current getBlockContract(...) use in inherited-input conflict validation needs a separate migration path; it cannot be treated as the same problem as runtime input-name discovery because it has different cross-template knowledge requirements
    

Dependency:

-   this step depends on a concrete answer for cross-template inherited block-input knowledge during `extends`; in the current architecture that information is available only after runtime parent loading/block registration, so the replacement may need runtime-registered merged contracts or equivalent template metadata propagation rather than purely local compile-time knowledge

-   this step also depends on the command-buffer/lane work needed to ensure block-input locals still have a valid declared-channel/lane story after the runtime declaration loop is removed
    

Tests for this step:

-   keep current composition/import tests green

-   keep current async inheritance/block-input integration tests green, especially the `tests/pasync/loader.js` cases around explicit block inputs, `with context`, and multi-level `super()` chains

-   keep current compile-shape tests in `tests/pasync/template-command-buffer.js` green until their expectations are intentionally updated to the new code shape
    

Still-unimplemented tests to add here:

-   integration test: composition block inputs work through explicit named with ... inputs

-   integration test: same-template block invocation snapshots template-local values at invocation time rather than final channel state

-   integration test: same-template block invocation with async-produced locals snapshots invocation-time values

-   integration test: overriding block treats inherited block inputs as ordinary local bindings inside nested if / loop / guard scopes

-   integration test: overriding block assignment to an inherited input inside nested scopes does not leak into super()

-   integration test: multi-level super() chain preserves original invocation inputs even when the middle block rebinds them
    
-   compile-source test: generated block entry code no longer loops over runtime block-contract input names
    
-   compile-source test: generated block entry code no longer uses the output of \_collectRootCompositionLocalChannelNames(...) to build the runtime recovery loop

-   compile-source/integration test: block entry no longer reads context.getCompositionSourceBuffer(...) for input initialization

-   compile-source/integration test: block entry no longer reads parentBuffer?.findChannel(name)?.finalSnapshot() for inherited/composition input initialization
    
-   integration test: no runtime-dynamic channel declaration is needed for composition/block inputs

-   integration test: `with context` render-context visibility is not treated as inherited explicit block inputs

-   validation test: extern self-cycle is rejected

-   validation test: extern indirect cycle across multiple declarations is rejected
    

### Step C. Remove remaining composition/export fallback helpers

Goal:

-   finish cleanup once explicit producer records and explicit composition payloads are fully in place
    

Primary files:

-   src/environment/context.js
    
-   src/compiler/compiler-async.js
    
-   src/compiler/inheritance.js
    

Changes:

-   delete any remaining export fallback lookup
    
-   remove the emitted context.setCompositionSourceBuffer(...) call from async root/inheritance setup once no readers remain
    
-   remove compositionSourceBuffersByTemplate and related helpers if Step B leaves them unused
    
-   remove getBlockContract(...) only after both of its current roles have been retired or deliberately replaced:

    -   runtime input-name discovery

    -   inherited-input conflict validation
    
-   delete any temporary debug-only compatibility paths that only exist to support the old composition/export model

-   simplify Context.init(...), forkForPath(...), and forkForComposition(...) once compositionSourceBuffersByTemplate is gone, so those context shapes stop carrying the removed shared state

-   if Step A removed the last writer to \_visibleChannels and no later step reintroduces one, delete any remaining dead \_visibleChannels storage/read paths here if they were intentionally deferred from Step A
    

Final verification for this step:

-   run focused suites for:
    

-   tests/pasync/composition.js
    
-   tests/pasync/loop-concurrent-limit.js

-   tests/pasync/loader.js

-   tests/pasync/template-command-buffer.js
    

-   then run the full relevant async composition/import/export suite

-   also run the extern validation suites because extern/input-cycle behavior is part of the same explicit-input contract surface
    

## Final Recommendation

The composition update should proceed with these goals:

1.  Resolve deferred exports from explicit producer snapshots.
    
2.  Remove buffer-visibility-based export fallback lookup.
    
3.  Redesign composition around explicit named inputs and snapshots.
    
4.  Remove runtime-dynamic block/composition input declaration.
    
5.  Delete composition/export compatibility helpers once the new path is proven.

6.  Preserve the semantic distinction between explicit block inputs and `with context`.

7.  Treat inherited-input conflict validation and inherited-input transport as separate migration problems.

8.  Fold extern/input cycle validation into the same cleanup effort instead of leaving it adjacent to the composition rewrite.
    

In short:

-   exports should resolve from snapshots
    
-   composition should use explicit inputs
    
-   composition entry should move to explicit payloads, with cross-template contract propagation handled deliberately rather than implicitly

-   block-input transport and block-input conflict validation should be migrated separately

-   `with context` should remain distinct from explicit inherited inputs

-   extern/input cycle validation should be part of the same explicit-input cleanup
