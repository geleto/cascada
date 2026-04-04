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
    
-   the \_visibleChannels export-linking role becomes removable as well
    
-   any remaining \_visibleChannels usage should then be justified only by the non-composition command-buffer lookup model
    

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
    

So yes: composition should move away from buffer linking.

This is not just an adjacent cleanup. It is the main remaining source of runtime-dynamic channel names, so it needs to be solved if we want fully static composition entry and buffer lane sets.

The chosen direction should be stated directly:

-   composition/block calls should use explicit with ...\-style named inputs
    
-   block entry functions should receive those inputs explicitly rather than discovering names from block contracts at runtime
    
-   the current runtime loop over context.getBlockContract(...).inputNames should be removed
    

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

## Tests And Invariants

The composition update should preserve and strengthen invariants such as:

-   deferred exports resolve from final snapshots
    
-   resolveExports(...) relies on explicit producer records rather than ambient buffer visibility
    
-   composition uses explicit named inputs, not channel visibility
    
-   no runtime-dynamic composition/block-input channel declaration remains
    

## Migration Strategy

Because the current async composition code still tolerates some compatibility paths, the update should tighten invariants in stages:

1.  add debug/development assertions around unexpected export fallbacks and unexpected runtime-discovered composition inputs
    
2.  run focused composition and export suites to surface any remaining gaps
    
3.  remove the old fallback paths once the assertions stop firing
    

This is especially important for:

-   removal of deferred-export fallback lookup
    
-   composition/block-input staticization
    

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

-   redesign block/composition entry so inputs are passed explicitly via with ...\-style named inputs
    
-   make block entry functions receive an explicit named-input object or equivalent explicit parameter payload
    
-   have the compiler generate that payload from statically known call-site inputs instead of discovering input names at runtime
    
-   rewrite \_emitAsyncBlockInputInitialization(...) around those static explicit inputs
    
-   stop using \_collectRootCompositionLocalChannelNames(...) as a runtime recovery mechanism during block entry
    
-   stop looping over context.getBlockContract(...).inputNames at runtime to declare channels
    
-   remove the runtime declareBufferChannel(currentBuffer, name, ...) loop for composition inputs
    
-   remove compositionSourceBuffer\-based channel lookup from block input initialization
    
-   keep composition value transport snapshot-based and explicit
    
-   update Context.forkForComposition(...) if its current contract assumes channel/buffer-based composition lookup
    
-   audit whether setCompositionSourceBuffer(...), getCompositionSourceBuffer(...), getBlockContract(...), and forkForComposition(...) still have any remaining purpose after this redesign
    

Concrete target:

-   block/call-site compilation should construct the explicit named-input payload from compile-time-known inputs
    
-   the generated block entry function should consume that payload directly
    
-   any same-template / child-template top-level locals that remain intentionally visible to the block should be captured into that payload at invocation time, not re-read later via finalSnapshot() from source buffers
    
-   inheritance.js and compiler-async.js must agree on the new entry-function signature and call shape
    
-   in practice, inheritance.js should build and pass the explicit named-input payload at block override/super call sites, and compiler-async.js block entry code should accept that payload directly
    
-   compile-time block-input metadata must exist at the call site; if current analysis does not yet provide that, this step must add it explicitly before runtime loop removal can proceed
    
-   the current getBlockContract(...) use in block-input conflict validation should move to compile time if possible; this helper currently serves both runtime input discovery and runtime conflict checking, and both uses need to be retired or replaced deliberately
    

Dependency:

-   this step requires block input names to be compile-time-known at call sites; if earlier analysis does not already provide that, this step must add it explicitly
    

Tests for this step:

-   keep current composition/import tests green
    

Still-unimplemented tests to add here:

-   integration test: composition block inputs work through explicit named with ... inputs
    
-   compile-source test: generated block entry code no longer loops over runtime block-contract input names
    
-   compile-source test: generated block entry code no longer uses \_collectRootCompositionLocalChannelNames(...) as a runtime recovery source
    
-   integration test: no runtime-dynamic channel declaration is needed for composition/block inputs
    

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
    
-   remove getBlockContract(...) as well if Step B leaves no remaining callers
    
-   delete any temporary debug-only compatibility paths that only exist to support the old composition/export model
    

Final verification for this step:

-   run focused suites for:
    

-   tests/pasync/composition.js
    
-   tests/pasync/loop-concurrent-limit.js
    

-   then run the full relevant async composition/import/export suite
    

## Final Recommendation

The composition update should proceed with these goals:

1.  Resolve deferred exports from explicit producer snapshots.
    
2.  Remove buffer-visibility-based export fallback lookup.
    
3.  Redesign composition around explicit named inputs and snapshots.
    
4.  Remove runtime-dynamic block/composition input declaration.
    
5.  Delete composition/export compatibility helpers once the new path is proven.
    

In short:

-   exports should resolve from snapshots
    
-   composition should use explicit inputs
    
-   composition entry should be compile-time-shaped rather than runtime-discovered
    
-