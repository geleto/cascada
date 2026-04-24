# Extends / Inheritance / Component Refactor

## Overview

This document records the current understanding of the async
`extends` / inheritance / component implementation and the next simplification
direction.

It is intentionally similar in shape to
[command-buffer-refactor.md](command-buffer-refactor.md): it names the runtime
structures that still overlap, describes the target model, and proposes a
cleanup-first migration plan.

The metadata redesign described in
[extends-architecture.md](extends-architecture.md) and
[extends-metadata-architecture.md](extends-metadata-architecture.md) is now
mostly implemented:

- inheritance chains are loaded before constructor/root execution
- method metadata is direct and synchronous after finalization
- shared state usage requires explicit per-file declarations
- normal execution uses `mergedUsedChannels` / `mergedMutatedChannels`
- bootstrap-only metadata is pruned after finalization

The remaining opportunity is not another semantic redesign. It is to reduce the
surface area around the implementation so the runtime has fewer duplicated
entry points, fewer transitional objects, and fewer long-lived fields.

## Status Refresh

The most important current facts are:

- compiled async scripts/templates expose inheritance-specific state through
  `inheritanceSpec`
- async block functions are no longer emitted on the public compiled return
  object; they live in `inheritanceSpec.methods`
- `scriptBody` / `scriptBodyRenderFunc` are no longer part of the compiled
  public surface
- pending method-entry structs and promise-shaped metadata resolution are gone
- `bootstrapInheritanceMetadata(...)` takes the explicit argument shape:
  `(state, methods, sharedSchema, invokedMethods, currentBuffer, context)`
- `finalizeInheritanceMetadata(...)` computes final method footprints and then
  prunes bootstrap-only metadata
- finalized resolved method metadata is intentionally lean:
  - `fn`
  - `signature`
  - `ownerKey`
  - `super`
  - `mergedUsedChannels`
  - `mergedMutatedChannels`
- raw method entries retain `_resolvedMethodData`, but their bootstrap-only
  fields are deleted after successful finalization
- state-level `invokedMethods` is a bootstrap catalog only and is cleared after
  finalization
- component instances use the same inheritance metadata model as direct
  inheritance chains
- sync template inheritance remains outside this architecture and stays on the
  Nunjucks-compatible path

The current implementation is therefore past the "make it correct" stage. The
next work should be about making the shapes smaller and the boundaries sharper.

## Main Conclusions

The refactor should move toward these rules:

1. Compiled inheritance data should have one canonical public shape.
2. Bootstrap metadata should be separate from finalized execution metadata.
3. Normal execution should never inspect raw compiled method-entry fields.
4. `InheritanceState` should retain only instance state needed after
   finalization.
5. Method invocation, `super()`, and component method calls should share one
   admission/linking core.
6. Shared-channel observation should remain explicit and current-buffer based.
7. Composition payload, extern inputs, and shared channels should stay separate.
8. Component lifecycle should use the same metadata barrier as direct extends,
   but without extra calling-convention shims.
9. Test-only exports and white-box assertions should keep shrinking as behavior
   coverage grows.

Later sections turn these rules into the concrete cleanup sequence. The final
summary intentionally stays shorter than this list to avoid maintaining two
parallel plans.

## Current Runtime State

### Compiled Template / Script Surface

Compiled async files currently return:

- `root`
- `externSpec`
- `inheritanceSpec`

`inheritanceSpec` contains:

- `setup`
- `methods`
- `sharedSchema`
- `invokedMethods`
- `hasExtends`

Compatibility getters on `Template` / `AsyncTemplate` still expose:

- `setupRenderFunc`
- `methods`
- `sharedSchema`
- `invokedMethods`
- `hasExtends`

Those getters keep existing runtime/test call sites working while the compiled
shape has moved to `inheritanceSpec`.

### Raw Method Entries

Raw compiled method entries are still the bootstrap input shape:

- `fn`
- `signature`
- `ownerKey`
- `ownUsedChannels`
- `ownMutatedChannels`
- `super`
- `superOrigin`
- `invokedMethods`

`superOrigin` is the concrete raw-entry field for the architecture's
`super()` source-origin metadata. It should be documented in the architecture
docs as the implementation name for that origin record.

After finalization, raw entries mostly serve as stable table slots containing
`_resolvedMethodData`. Bootstrap-only fields are pruned.

### Execution Method Data

Pruned execution method data is the post-finalization dispatch shape:

- `fn`
- `signature`
- `ownerKey`
- `super`
- `mergedUsedChannels`
- `mergedMutatedChannels`

During finalization, resolved data temporarily also has callable-local
`invokedMethods` so the fixed-point channel-footprint pass can run. That field
is pruned before normal execution.

### Inheritance State

The long-lived shared metadata object remains the architecture-defined instance
shape:

- `methods`
- `sharedRootBuffer`
- `sharedSchema`
- `compositionPayload`

`InheritanceState` also currently carries `invokedMethods` during bootstrap.
That field is a temporary catalog for resolving ordinary inherited method
references and is cleared after successful finalization.

Internal symbol state contains:

- startup promise state
- metadata-ready promise state
- a one-shot metadata-ready yield flag
- composition mode
- chain-path stack for cycle detection

The chain-path stack is cleared after finalization. The metadata-ready yield
flag remains because `runCompiledRootStartup(...)` may already be on the stack
when finalization settles readiness.

### Bootstrap Runtime

The bootstrap layer owns:

- registering method/shared/invoked metadata
- loading parent chains
- rendering parent roots for composition
- starting the local root constructor
- finalizing metadata
- linking current buffers to parent/shared channels

This module still has a few small helper functions that are called only once or
only from one public entry point. They are not necessarily harmful, but they
make the startup path harder to read.

### Inherited Call Runtime

The call layer owns:

- direct method metadata lookup
- shared-channel schema lookup
- method payload validation
- invocation command creation
- method and `super()` admission
- invocation buffer creation and finalization
- late metadata-ready gating at admission boundaries

`invokeInheritedMethod(...)` and `invokeSuperMethod(...)` are now very similar:
both wait for metadata readiness if needed, assert direct method data, create an
admitted invocation buffer, enqueue one invocation command, and return the
deferred result.

### Component Runtime

The component layer owns:

- component instance creation
- ordered component startup command
- method operation command
- shared observation command
- component lifecycle / close behavior
- component-specific extern validation and payload normalization

Component operations already dispatch through the inherited-call runtime rather
than carrying their own method metadata model.

## Current Problems

### 1. Documentation shape drift

The architecture documents still describe finalized method metadata as carrying
`ownUsedChannels`, `ownMutatedChannels`, and `invokedMethods`.

That was true during finalization, but it is no longer the post-finalization
execution shape after pruning.

The docs should distinguish three shapes:

1. compiled raw method entry
2. finalization-only resolved method data
3. pruned execution method data

### 2. Compatibility getters obscure the canonical compiled shape

`inheritanceSpec` is now the canonical compiled descriptor, but the `Template`
class still exposes individual inheritance fields through getters.

This is useful compatibility scaffolding, but it means internal call sites can
continue to look like the old spread-out property model.

The target should be:

- internal runtime code reads `template.inheritanceSpec`
- tests that inspect compiled shape inspect `inheritanceSpec`
- compatibility getters remain only if they are intentionally public/debug API

### 3. Bootstrap and execution shapes still share table objects

`inheritanceState.methods[name]` is a raw entry table slot with
`_resolvedMethodData` attached.

This is pragmatic, but it mixes:

- bootstrap chain wiring
- raw compiled metadata
- execution metadata cache

The final target could be a separate execution method table:

- bootstrap builds from raw entries
- finalization publishes direct method data into `state.methods`
- raw entries can then be discarded completely

That would remove the need for raw-entry pruning and make normal execution
state easier to inspect. A separate `state.resolvedMethods` table can be used
only as migration scaffolding; the architecture end state should keep
`state.methods[name]` as the canonical execution method table.

### 4. Metadata-ready barrier is still visible in hot admission helpers

`invokeInheritedMethod(...)`, `invokeSuperMethod(...)`, and constructor startup
still call `awaitInheritanceMetadataReadiness(...)`.

This is correct for dynamic/static startup ordering today, but it leaves a
transitional smell: normal execution knows about a readiness barrier that should
usually have settled.

The target is not necessarily to remove the barrier entirely, but to narrow it:

- constructor/root startup may use it
- external admission boundaries may guard for diagnostics
- finalized direct method invocation should not feel promise-driven

### 5. Invocation and component operation commands duplicate lifecycle shape

Inherited method invocation and component method invocation are both expressed
as commands with deferred results and cleanup behavior.

They now share more than they did originally, but the code still has separate
layers for:

- component method operation admission
- inherited method admission
- invocation command buffering

There is room to make component method operations thinner wrappers around one
shared inherited-call admission primitive.

### 6. Shared observation has the right semantics but a wide call surface

Component shared observation currently passes an observation command through a
side-channel command. That is the right model.

The remaining complexity is at the compiler/runtime boundary:

- implicit component var reads
- explicit `.snapshot()`
- `is error`
- `#`

These should remain separate language surfaces, but runtime validation can
likely be reduced to one "safe observational command" gate.

### 7. Some tests still assert intermediate object structure

The test suite has been improved, but a few tests still construct method data
objects manually with fields that are not part of the final execution shape,
such as `ownUsedChannels` or `invokedMethods`.

Those tests are valuable while they cover runtime helpers directly, but they
should gradually be replaced with behavior-level coverage or with explicitly
named white-box tests for the final execution shape.

## Target Runtime Model

### One compiled inheritance descriptor

The compiled return object should stay:

```js
{
  externSpec,
  inheritanceSpec,
  root
}
```

`inheritanceSpec` is the only inheritance-specific compiled descriptor.

Everything else should either be:

- sync-template compatibility data, or
- deliberate compatibility/debug API on `Template`

### Three explicit metadata phases

The implementation should name and preserve three different shapes:

1. compiled raw entries
2. finalization work data
3. execution method data

Compiled raw entries contain source-origin and local-body information.

Finalization work data may contain temporary graph edges such as
`invokedMethods`.

Execution method data contains only what dispatch needs:

- function
- owner identity
- signature
- direct `super`
- merged channel footprint

### Execution table, not raw-entry table

Eventually, `state.methods[name]` should be the canonical execution method data
itself, not a raw entry with `_resolvedMethodData`.

That would make runtime dispatch simpler:

```js
const methodData = state.methods[name];
```

instead of:

```js
const methodData = state.methods[name]._resolvedMethodData;
```

The raw chain can remain internal to finalization and be released afterward.

A separate resolved-method table is acceptable only as an intermediate
migration aid. It should not become the final public/shared metadata shape,
because the broader `extends` architecture defines `methods` as the method
metadata member of the shared inheritance object.

### One admission/linking primitive

The inherited-call layer should converge on one primitive that does:

1. take direct method data
2. validate call arguments
3. create/link the invocation buffer from merged channels
4. create/enqueue the invocation command
5. return the deferred result

`this.method(...)`, `super(...)`, and component method calls can all use this
primitive after resolving the correct direct method data.

### Shared channel observation remains separate

Shared observation should not collapse into ordinary lookup.

The stable rule remains:

- declared shared access is explicit shared-state access
- undeclared bare names use ordinary ambient lookup
- component shared property access is an explicit observation surface

The cleanup target is a smaller runtime API, not a semantic merge.

### Component instances remain normal inheritance instances

A component instance should continue to be:

- one root buffer
- one inheritance state
- one composition payload
- one shared root
- one lifecycle wrapper

The component layer should not own a second metadata model.

## What Should Not Change

This refactor should preserve:

- async script/template `extends`
- dynamic `extends`: resolve the parent expression first, then load and
  finalize the full resolved chain before constructor/root execution starts
- `extends none` / `extends null` as the no-parent branch for the current
  file's parent-selection expression
- constructor semantics
- `__constructor__` dispatch as an inherited method call, including the topmost
  no-op root constructor rule for constructor `super()`
- direct-render return semantics:
  - only the most-derived entry file's explicit return counts
  - ancestor constructor returns are ignored
  - component constructor returns are ignored
  - component method returns are preserved as method-call results
- explicit per-file shared declarations
- `extends ... with ...` payload flow
- component constructor ordering
- component method ordering
- component shared observation semantics
- owner-relative `super()` semantics
- final callable linking through exact merged method footprints, not wildcard
  parent-lane or whole-shared-schema linking
- sync template inheritance compatibility
- Nunjucks import/include/macro compatibility

The refactor should not make shared names ambient again and should not
reintroduce promise-shaped structural metadata.

## Cleanup / Refactor Plan

### Phase 0. Lock Baseline and Align Architecture Docs

Goal:

- preserve the current post-metadata simplification before deeper cleanup
- make the architecture docs match the current pruned execution metadata shape
  before later implementation phases rely on this refactor plan

Work:

- keep or add tests that assert:
  - `scriptBodyRenderFunc` is absent
  - async block functions are not public compiled props
  - finalized state-level `invokedMethods` is empty
  - resolved execution method data does not retain `invokedMethods`
  - resolved execution method data does not retain `ownUsedChannels`
  - resolved execution method data does not retain `ownMutatedChannels`
  - callable body linking uses merged channel footprints
- add or keep at least one behavior test for async imports that confirms
  exported macros are available after composition startup finishes
- keep explicit coverage for the topmost no-op root constructor case so
  execution-table migration does not regress constructor `super()`
- update `extends-architecture.md`
- update `extends-metadata-architecture.md`
- update `extends-architecture.md` section `Shared Metadata Objects` /
  `Method Entries`, especially the `Finalized method metadata includes` list
- update `extends-metadata-architecture.md` section `Method Metadata Shape`
- rewrite or remove `extends-metadata-architecture.md` section
  `Per-Method Compiled Channel-List Helpers`; execution no longer reads
  `methodData.invokedMethods.*` for channel lists because merged footprints are
  precomputed and `invokedMethods` is pruned before normal execution
- explicitly distinguish:
  - compiled raw method entry
  - finalization work data
  - pruned execution method data
- document that `state.invokedMethods` is a bootstrap catalog and is cleared
  after finalization
- document that raw entries are bootstrap slots and normal execution uses
  `_resolvedMethodData` only until the direct execution method-table cleanup
- document `superOrigin` as the concrete raw-entry field for `super()` call-site
  source-origin metadata
- document that `state.methods[name]` remains the canonical execution method
  table end state
- document that `sharedRootBuffer` remains part of the long-lived shared
  metadata object and is not replaced by the method-table cleanup
- audit the generated compiled output for obsolete
  `methodData.invokedMethods.*` channel-helper patterns and update tests/docs
  to assert the replacement model

Primary files:

- `docs/code/extends-architecture.md`
- `docs/code/extends-metadata-architecture.md`
- `tests/pasync/extends-foundation.js`
- `tests/pasync/extends.js`
- `tests/pasync/loader.js`
- `tests/pasync/template-command-buffer.js`

Validation:

- run the focused extends/component/template-command-buffer suites if tests
  change
- docs-only changes do not require runtime tests, but compile-source tests
  should be updated if stale helper-pattern assertions are found

### Phase 1. Audit the Compiled Inheritance Surface

Goal:

- make the canonical compiled descriptor obvious everywhere
- avoid churn where compatibility getters are the only remaining users

Work:

- audit internal runtime/bootstrap code for reads of spread-out compatibility
  getters
- update meaningful internal reads to use `template.inheritanceSpec` directly
- keep compatibility getters on `Template` only if they are deliberately
  public/debug API
- update tests that inspect spread-out fields to inspect `inheritanceSpec`
  unless they are intentionally compatibility tests
- do not remove compatibility getters in this phase unless the audit proves
  they are dead or purely test-only

Primary files:

- `src/environment/template.js`
- `src/runtime/inheritance-bootstrap.js`
- `tests/pasync/extends-foundation.js`

Validation:

- compile-source shape tests
- focused extends foundation tests
- Pass A review found one stale `extends-metadata-architecture.md` execution
  assumption that still mentioned execution-time `methodMeta.invokedMethods`;
  fix in Pass A by restating execution assumptions in terms of finalized merged
  channel footprints.

### Phase 2. Publish Direct Execution Method Data

Goal:

- separate bootstrap raw entries from normal execution metadata
- remove `_resolvedMethodData` from the normal runtime path

Work:

- make `state.methods[name]` point to execution method data after successful
  finalization
- keep raw compiled entries private to finalization
- avoid introducing `state.resolvedMethods`; use a temporary parallel execution
  table only if the direct `state.methods` migration proves too risky, and
  delete it before the phase is complete
- delete raw-entry pruning once raw entries no longer survive finalization
- update `getMethodData(...)`, `_assertDirectMethodData(...)`, and
  `_assertDirectSuperMethodData(...)` to operate on direct execution data
- keep a narrow private finalization map for raw-entry graph work only
- preserve `sharedRootBuffer`, `sharedSchema`, and `compositionPayload`
  placement while reorganizing methods; method-table cleanup must not reshape
  the rest of the shared metadata object
- preserve topmost no-op root constructor behavior while replacing the method
  table shape

Migration sequence:

1. Current state: `state.methods[name]` is a raw entry with
   `_resolvedMethodData`.
2. During this phase: finalization builds execution method data from a private
   raw graph.
3. End state: `state.methods[name]` is direct execution method data and raw
   entries are private finalization input only.

Primary files:

- `src/runtime/inheritance-state.js`
- `src/runtime/inheritance-call.js`
- `src/runtime/inheritance-bootstrap.js`

Validation:

- method dispatch tests
- super dispatch tests
- component method dispatch tests
- focused inheritance metadata tests
- behavior tests around repeated finalization idempotence
- constructor `super()` no-op root tests

### Phase 3. Consolidate Inherited and Component Method Admission

Goal:

- make `this.method(...)`, `super(...)`, `__constructor__`, and component
  method calls share the same direct admission/linking core

Work:

- extract a private helper that admits already-resolved method data
- keep lookup differences outside that helper:
  - ordinary inherited call resolves by method name
  - `super()` resolves by owner key and must remain owner-relative
  - `__constructor__` resolves as the constructor method name, including the
    topmost no-op constructor rule
  - component method resolves through the instance inheritance state
- do not normalize `super()` into ordinary override dispatch
- keep the helper sync-first; only wait for metadata readiness before calling
  it when a boundary can genuinely run early

Primary files:

- `src/runtime/inheritance-call.js`
- `src/runtime/component.js`

Validation:

- constructor startup and constructor `super()` tests
- method-in-method ordering tests
- super ordering tests
- component method ordering tests

### Phase 4. Narrow Metadata-Readiness Usage

Goal:

- keep the barrier for startup correctness without making normal execution look
  metadata-promise-driven

Work:

- audit every `awaitInheritanceMetadataReadiness(...)` call
- split "startup may still be finalizing" from "invalid runtime call before
  finalization" where useful
- consider replacing hot-path readiness waits with assertions after the direct
  execution table is in place
- preserve the one-shot metadata-ready yield only if `runCompiledRootStartup`
  still needs it to avoid recursive same-stack constructor execution

Primary files:

- `src/runtime/inheritance-state.js`
- `src/runtime/inheritance-bootstrap.js`
- `src/runtime/inheritance-call.js`

Validation:

- tests that call inherited methods during parent-chain loading
- component constructor readiness tests

### Phase 5. Reduce Component Constructor and Payload Surface

Goal:

- make component creation look like a thin inheritance-instance wrapper after
  method operations have moved onto the shared admission primitive

Work:

- audit `createComponentInstance(...)` parameters and call sites
- avoid overloaded positional signatures; prefer a single options object if
  another cleanup pass touches this API
- keep `ComponentInstance` as the lifecycle owner
- keep method-operation metadata decisions in inherited-call helpers from
  Phase 3
- keep shared observation as a component-specific command only because it is a
  component-specific language surface

Primary files:

- `src/runtime/component.js`
- `src/compiler/compiler-async.js`

Validation:

- component creation tests
- component shared observation tests
- component lifecycle tests

### Phase 6. Simplify Shared Observation Validation

Goal:

- keep shared observation explicit while reducing mode-specific runtime paths

Work:

- keep compiler paths for:
  - implicit component var read
  - `.snapshot()`
  - `is error`
  - `#`
- route all runtime validation through one "safe observational command" check
- ensure missing shared schema still fails as fatal metadata error
- ensure unsupported mutation-like or channel-incompatible component property
  operations still fail dynamically with a fatal error

Primary files:

- `src/runtime/component.js`
- `src/runtime/inheritance-call.js`
- component-related compiler helpers

Validation:

- component shared observation tests
- poison/error observation tests

### Phase 7. Remove or Reclassify White-Box Runtime Exports

Goal:

- reduce public-looking runtime surface that exists only for brittle tests

Work:

- audit exports from:
  - `src/runtime/inheritance-state.js`
  - `src/runtime/inheritance-call.js`
  - `src/runtime/inheritance-bootstrap.js`
  - `src/runtime/component.js`
  - `src/runtime/runtime.js`
- classify each as:
  - compiled-code API
  - public/test debug API
  - private implementation detail
- identify compiled-code dependencies from generated source before deleting or
  un-reexporting anything; some helpers look private but are part of the
  generated JS runtime ABI
- move private test-only coverage toward behavior tests or direct module tests
  with clear white-box naming
- stop re-exporting helpers through `runtime.js` unless compiled code or
  stable tests genuinely need them

Validation:

- focused compile-source tests, because compiled code is the real API consumer
- full quick suite after export changes

## Final Recommendation

Use the phases above as the detailed checklist, but implement them in larger
passes where the risk profile is the same:

### Pass A. Docs, Baseline Tests, and Compiled Surface Audit

Combines:

- Phase 0
- Phase 1

Why these can be together:

- mostly docs, tests, and low-risk call-site audit
- establishes the correct architecture baseline before runtime shape changes
- avoids a separate churn-only pass for obvious `inheritanceSpec` reads

Do not remove compatibility getters in this pass unless the audit proves they
are dead.

### Pass B. Direct Execution Method Table

Implements:

- Phase 2

Why this stays separate:

- changes the meaning of `state.methods[name]` after finalization
- removes `_resolvedMethodData` from the normal runtime path
- touches method lookup, `super()`, constructors, and component dispatch

This is the highest-risk simplification and should produce a focused diff.

### Pass C. Shared Admission Primitive

Combines:

- Phase 3
- the component method-call portion of Phase 5

Why these can be together:

- both are about method-call admission and invocation-buffer linking
- component method calls should become thin wrappers over the same inherited
  admission primitive

Leave component constructor/payload API cleanup for Pass E.

### Pass D. Metadata Readiness Cleanup

Implements:

- Phase 4

Why this stays separate:

- readiness behavior depends on the direct method table and shared admission
  shape
- removing or narrowing readiness waits can create subtle ordering regressions

### Pass E. Component Constructor/Payload, Shared Observation, and Exports

Combines when the diffs remain small:

- the remaining constructor/payload part of Phase 5
- Phase 6
- Phase 7

Split this pass if shared observation cleanup grows beyond a narrow validation
change. Runtime export cleanup should remain last inside the pass because
generated compiled code is the real API consumer.

In short, the next extends cleanup should make the following true:

- compiled shape should be singular
- bootstrap shape should be temporary
- execution shape should be direct
- invocation admission should be shared
- components should be wrappers, not a parallel metadata system
- tests should mostly prove behavior, not transitional object internals
