# Async Frame Removal Plan

## Current Status

This plan is actively in progress.

Completed so far:

- Phase 1 is effectively done:
  - `node.isAsync` has been removed as an async compile-routing mechanism
  - the old async-determination pass was deleted
- Phase 2 is partly done:
  - modern async symbol reads were reduced away from frame-shaped fallback in several places
  - modern async template symbol fallback no longer consults `frame.lookup(...)`
    - async template symbols now resolve through channel snapshot lookup first, then context
  - async channel lookup now prefers buffer-owned lookup paths in the modern runtime
  - visible buffer lookup no longer relies only on the shared `buffer._channels` map
    - buffers now retain the owned channel object per name
    - visible channel reads now go directly through `currentBuffer.findChannel(...)` / owned-buffer ancestry
  - inheritance now reads `__parentTemplate` through direct var-channel lookup instead of the generic frame-or-channel symbol fallback
  - a direct root-buffer export-resolution shortcut was attempted and reverted; conditional inheritance/export parity still needs visible-channel semantics broader than `currentBuffer.getChannel(...)`
- Phase 9 is partly done:
  - `CommandBuffer` no longer stores or validates frame ownership
  - channel instances no longer thread/store frame internally
  - direct channel constructors now use one consistent frame-free signature
  - channel factory helpers now also use frame-free signatures
  - `createCommandBuffer(...)` no longer takes a frame argument
  - dead `finalizeUnobservedSinks(...)` plumbing was removed
  - a direct `declareChannel(...) -> buffer-only` ownership flip was attempted and reverted because linked-child visibility and local shadowing are not represented precisely enough by the current buffer registry alone
  - compile-time replacement of async `if(frame.topLevel)` export checks was attempted and reverted
    - `frame.topLevel` is not currently equivalent to simple compile-time `!frame.parent`
    - macro / caller / deferred-export codegen still depends on the runtime top-level marker in ways that need a deeper audit first
  - a narrower analysis-driven exportability replacement now works for ordinary async var/import bindings
    - root-scope async `var` / `import` / `from import` exports now use analysis scope ownership instead of runtime `frame.topLevel`
  - async macro exportability now also uses analysis data instead of runtime `frame.topLevel`
    - macro exports are decided through explicit parent-owned declaration ownership
    - this avoids confusing the macro's local declaration with the parent-owned exported binding
  - async render entry no longer sets `frame.topLevel`
    - there are no remaining async reads of that runtime flag
    - the remaining top-level frame marker is now explicitly sync-only: `frame.syncTopLevel`
  - dead async frame flags were removed:
    - `_seesRootScope` no longer exists in the async runtime path
    - `_returnWaitCount` was dead and is gone
  - `markChannelBufferScope(...)` is no longer a frame method
    - it now lives on runtime as a direct buffer/channel-root helper
  - runtime `createScope` is gone
    - `_compileCreateScope` was also removed instead of being kept as a new frame-side replacement
    - async no-scope boundaries now reuse the current compile-time frame
    - lexical scope creation stays analysis-owned through `node._analysis.createScope`
  - some internal async channels now bypass `frame._channels` entirely:
    - `__return__`
    - waited-control-flow channels
    - macro caller-scheduling channels
    - sequential-path lock channels
    - `__parentTemplate`
    - root-owned async `var` declarations
    - explicit async `data` / `text` / `sink` / `sequence` channel declarations
    - explicit async `var` channel declarations
    - guard recovery error vars
    - async loop vars / loop metadata bindings
    - async macro `caller` / arg / kwarg bindings
  - async text-channel declarations now also bypass `frame._channels`
    - the underlying blocker was fixed by preserving owned channels per buffer and resolving visible channels by buffer ancestry instead of the shared map alone
    - guard / capture / revert semantics stay green with buffer-only async text registration
  - a broader "mirror only text + sequential-path channels into `frame._channels`" reduction was also attempted and reverted
    - ordinary var/data/sink/sequence channel visibility is still not represented precisely enough by the current buffer registry alone
    - guard/recover and deferred export cases still depend on stronger visible-channel semantics
  - deferred export resolution is no longer purely lookup-based
    - async deferred exports now record their owning buffer + channel name directly
    - `forkForPath(...)` shares that deferred-export channel metadata across inheritance context forks
    - this keeps root export resolution off frame for root-owned async var channels
  - imported bindings and async macro bindings now also bypass `frame._channels`
    - inherited block composition now prelinks deferred-export visibility into the parent root buffer as lookup-only channel visibility
    - visible channel lookup can resolve those child-owned bindings without closing parent lanes early
  - sequential runtime no longer uses frame to discover lock channels
    - sequential lock channels are now declared buffer-only
    - `ensureSequentialPathChannel(...)` validates through `currentBuffer.getChannel(...)`
    - sequential runtime helpers no longer thread a frame parameter just to discover lock channels
  - visible-channel lookup is now buffer-only
    - `findVisibleChannel(...)` was removed
    - async lookup/guard/export reads now call `currentBuffer.findChannel(...)` directly
    - async compiler output no longer emits frame-backed channel declaration helpers
    - the remaining legacy sync script-output declaration helper is now explicit: `declareSyncOutput(...)`
  - dead async helper signatures were trimmed further:
    - `Context.resolveExports(...)` no longer accepts `frame` or `runtime`
    - `guard.initChannelSnapshots(...)` no longer accepts `frame`
    - `getChannelFromBuffer(...)` was removed in favor of direct `buffer.findChannel(...)`
    - dead `contextOrChannelLookupScript(...)` and `AsyncFrame.lookupAndLocate(...)` were removed
  - dead frame-era node async hooks were removed:
    - `Node.checkIsAsync(...)`
    - `Symbol.checkIsAsync(...)`
  - compile-time async codegen no longer constructs `AsyncFrame`
    - async root compilation now uses plain `Frame` for compiler-only scope tracking
    - `AsyncFrame.withCompilerContext(...)` and `AsyncFrame.inCompilerContext` were removed
  - `AsyncFrame.set(...)` is now an unconditional runtime guard
    - the one-value `THROW_ON_ASYNC_FRAME_ASSIGN` feature flag was removed
    - any remaining runtime async frame write now fails loudly by default

Important correction:

- scope ownership and buffer ownership are **not** the same thing
  - command buffers exist only where async/control-flow structure needs them
  - lexical scopes exist on every AST node that creates a child/root scope
  - therefore “binding is visible from / declared in the root command buffer” does **not** imply “binding belongs to the root lexical scope”
  - exportability, shadowing, and parent-owned declarations must stay analysis-driven

Current next target:

- continue Phase 5 / Phase 9 cleanup around channel ownership:
  - keep shrinking frame-based channel readers
  - retry the broader `declareChannel(...)` ownership move now that:
    - visible channel lookup is buffer-ancestry-based
    - async text channels are already buffer-owned
    - deferred exports now remember their owning buffer/channel directly
  - then remove the remaining frame fallback from `findVisibleChannel(...)`
    - done: buffer-only visibility is now sufficient for async lookup
  - focus next on deleting dead async frame-era helpers and signatures
    - done: `findVisibleChannel(...)` was removed and callers now use `currentBuffer.findChannel(...)` directly
    - done: modern async template symbol fallback no longer passes through `frame.lookup(...)`
    - done: the remaining legacy sync script-output declaration helper was isolated as `declareSyncOutput(...)`
  - continue shrinking the remaining sync/runtime compatibility lookup helpers that still rely on frame-only vars
  - continue isolating remaining sync-only frame state:
    - done: `frame.topLevel` was renamed to explicit sync-only `frame.syncTopLevel`
    - done: loop frame metadata writes now go through explicit sync-only `setSyncLoopBindings(...)`
  - continue deleting dead async frame scaffolding:
    - done: compile-time async codegen no longer uses `AsyncFrame`
    - done: the compiler-context escape hatch on `AsyncFrame.set(...)` was removed
  - continue isolating legacy callback-async compatibility paths from modern async mode:
    - done: internal loop compiler helpers were renamed to explicit legacy-callback names
  - continue reducing runtime frame flags:
    - async export codegen no longer depends on `frame.topLevel`
    - async render entry also no longer depends on `frame.topLevel`
    - `_seesRootScope` and `_returnWaitCount` are already gone
    - `markChannelBufferScope(...)` is already off frame
    - runtime/compile-time transitional `createScope` frame markers are gone
    - async no-scope boundaries now follow analysis `createScope` directly
    - the remaining work is channel-ownership lookup/declaration state

Focused verification currently used during this migration:

- `tests/pasync/output-errors.js`
- `tests/pasync/snapshots.js`
- `tests/explicit-outputs.js`
- `tests/pasync/loop-concurrent-limit.js`
- `tests/poison/call-suppression.js`
- `tests/poison/lookup.js`
- `tests/poison/guard.js`

Current broad verification baseline:

- `npm run test:quick`
  - currently green at `2459 passing`, `21 pending`

## Goal

Remove runtime `frame` dependence from **async mode only**.

The main way to achieve that is:

- replace async `frame` usage with `node._analysis`-driven codegen decisions

This should be treated as the primary migration strategy, not just one technique among others.

This does **not** mean "remove lexical scoping." It means:

- async lexical scoping is resolved statically at compile time
- async runtime variable/channel access no longer depends on a mutable frame object
- async channels and scope visibility are owned by command-buffer / channel structures plus compile-time runtime names
- async execution no longer needs a separate `AsyncFrame` runtime model

Sync mode can keep the existing frame-based model for now.

---

## Non-Goals

- Do not rewrite sync-mode scoping in the same pass.
- Do not remove callback-based fatal-error propagation from fire-and-forget async boundaries.
- Do not collapse async and sync compiler pipelines prematurely.
- Do not try to delete `frame` first and "figure out the rest later."

## Revert Discipline

When a frame-removal change fails, do **not** leave the result as an undocumented failed experiment.

Every reverted change must do one of these two things:

1. find and fix the underlying issue in the same line of work, or
2. be explicitly postponed in this plan with:
   - the exact blocker
   - why postponing is reasonable
   - what concrete prerequisite should unblock it later

This is especially important for async frame removal because "safe mechanical cleanup" can easily hide real architectural dependencies.

The preferred direction after a failed experiment is:

- first ask whether the missing information belongs in `node._analysis`
- only keep runtime/frame dependence if the information is truly runtime-only

---

## Analysis-First Replacement Rule

When removing async `frame` support, prefer moving facts into analysis instead of recreating them dynamically at runtime.

This is not only a preference. It is the main mechanism by which async `frame` removal becomes possible.

Practical rule:

- if async code still needs `frame` for a decision, first ask whether that decision should already exist in `node._analysis`
- the burden of proof is on keeping runtime/frame dependence, not on analysis replacement

In particular, the following kinds of information should become analysis-owned wherever possible:

- declaration ownership
- root-scope ownership
- parent-owned declaration ownership
- read-only boundary crossing
- include-visible channel projection
- runtime channel names after renaming/shadowing resolution
- whether a scope boundary is lexical-only or must also become a buffer/channel boundary

Good existing examples:

- `declares` / `declaresInParent`
- `parentOwned`
- `createScope`
- `scopeBoundary`
- `parentReadOnly`
- `getIncludeVisibleVarChannels(...)`
- `isRootScopeOwner(...)`
- `isDeclarationRootOwned(...)`
- `isParentOwnedDeclarationRootOwned(...)`

This means future frame-removal steps should first ask:

- is this really a runtime visibility problem?
- or are we missing analysis metadata that should have made the decision explicit before codegen?

Success for this plan should look like:

- modern async codegen reads analysis metadata
- emits canonical runtime names / explicit channel operations / explicit local bindings
- and no longer asks `frame` to rediscover lexical facts during execution

---

## Core Thesis

In async mode, `frame` is now mostly legacy glue.

The clearest path to removing it is:

- move every non-runtime fact that `frame` still carries into `node._analysis`
- then generate direct async code from that analysis instead of consulting `frame` at runtime

The modern async compiler/runtime already relies on:

- command buffers for structural ordering
- channels for observable state
- static analysis for declarations, scope boundaries, and visible names
- analysis-time runtime-name mangling to avoid collisions

That means the remaining async `frame` usage is valuable only if it still provides something that analysis + channels + buffer ancestry cannot provide more directly.

Stated more strongly:

- if an async `frame` usage is not describing a truly runtime-only fact, it should be considered a candidate for replacement with `node._analysis`

The likely end state is:

- async mode has no runtime variable frame
- user-visible mutable async lexical state is channel-backed
- compiler-private or read-only async locals may still be plain JS locals
- all async symbol resolution is done through compile-time-resolved runtime names
- shadowing is already handled by unique runtime names assigned during analysis before compilation
- parent visibility is represented by buffer/channel ancestry or explicit prelinking/aliasing

Important clarification:

- this plan is about removing the **runtime** async frame
- it does **not** require deleting the compiler's scope-tracking frame immediately
- but the end state should also stop depending on compiler-frame objects at codegen time and use analysis data directly

---

## Already True / Already Reduced

These are important because they shrink the real scope of the migration.

- `THROW_ON_ASYNC_FRAME_ASSIGN` is already active, so most accidental runtime async `frame.set(...)` calls are already rejected.
- modern async loop variable bindings already use channel commands instead of frame writes
- modern async loop metadata already uses channels, not frame vars
- `Channel` instances no longer store frame internally
- `CommandBuffer` no longer stores or validates `frame`
- compile-time frame depth validation is already separate from runtime behavior
- direct channel constructors and channel factory helpers now use frame-free signatures
- `createCommandBuffer(...)` now uses a frame-free signature
- dead `finalizeUnobservedSinks(...)` plumbing has already been removed

This means a lot of the remaining work is cleanup and migration of ownership/lookup, not invention of entirely new machinery.

---

## One Important Constraint

This migration is only realistic if async mode stops depending on `node.isAsync`.

Today the compiler still splits many paths by:

- `asyncMode`
- and then again by `node.isAsync`

Those paths have diverged too far. Keeping both models alive makes deeper refactors much harder.

So one explicit plan step is:

- remove `node.isAsync` as a routing mechanism
- keep only async-compiler lowering when `asyncMode` is enabled
- within that async compiler, prefer sync-first runtime helpers instead of dual compile paths

That is a prerequisite for clean frame removal.

Another prerequisite:

- every frame-related runtime check that is really a lexical/scope/declaration rule must already exist in analysis (or be moved there first)
- frame removal should not silently delete validation
- only genuinely runtime-only checks should remain at runtime

Additional rule:

- do not infer lexical-root ownership from:
  - root command-buffer ownership
  - lack of parent buffer
  - lack of parent frame
- infer it only from:
  - analysis scope owners
  - declaration ownership
  - explicit parent-owned declaration metadata

---

## Current Async Responsibilities of `frame`

These are the areas that still need to be evaluated and replaced.

### 1. Lexical variable storage and lookup

Current shape:

- runtime lookup helpers still read from frame variables
- macros/loops/conditionals still emit runtime `frame.push()` / `frame.pop()`
- some async code still uses `frame.set(...)`

Examples:

- `src/runtime/lookup.js`
- `src/compiler/compiler.js`
- `src/compiler/compile-loop.js`
- `src/compiler/compile-macro.js`

Important distinction:

- some of this is in the **modern async path**
- some of it is only in the **legacy callback-style path** (`node.isAsync === false` in async mode)

The audit must distinguish those two buckets.

Replacement direction:

- compile-time name resolution to canonical async runtime channel names
- no runtime string-name lexical lookup in modern async mode
- no async `frame.set(...)` except during migration

Concrete analysis-first follow-up:

- replace remaining modern async `frame.lookup(...)` / `frame.lookupAndLocate(...)` decisions with:
  - declaration lookup from analysis
  - canonical runtime names from rename/analysis
  - direct channel or JS-local codegen chosen at compile time

### 2. Channel ownership and lookup

Current shape:

- `declareChannel(frame, ...)`
- `getChannel(frame, name)`
- channel lookup walks the frame parent chain

Examples:

- `src/runtime/channel.js`

Important observation:

- there are already **two registries** today:
  - `frame._channels`
  - `buffer._channels`
- `buffer._channels` is already shared through the buffer tree

So the migration target is probably not "invent a new owner" but:

1. register async channels in `buffer._channels`
2. make async lookup read from buffer ancestry instead of frame ancestry
3. keep only the cases that still need analysis-owned visibility projection or explicit aliasing

Important caution:

- `buffer` ancestry can answer "which channel lane is visible here?"
- it does **not** answer:
  - which lexical declaration owns the name
  - whether a parent-owned declaration should export
  - whether shadowing/renaming should hide another same-base-name channel

Those must remain analysis-owned decisions.
3. remove the dead frame threading from channel construction and declaration

Progress:

- channel construction is already frame-free
- channel factory helpers are already frame-free
- the remaining live frame dependence here is channel declaration/registration and frame-based fallback lookup

Replacement direction:

- channel namespace owned by command buffers
- lookup by canonical runtime name
- parent visibility via buffer ancestry or explicit boundary alias/prelink rules

Important limitation:

- channel registry ownership can move to buffers
- lexical scope ownership cannot
- if two scope-distinct bindings share one command buffer, correctness still depends on:
  - analysis-time renaming
  - declaration ownership
  - boundary visibility rules

### 3. Loop state

Current shape:

- the **modern async loop path already uses channels** for loop variables
- the **modern async loop path already uses channels** for metadata
- the remaining frame-based loop path is the legacy path

Examples:

- `src/runtime/loop.js`
- `src/compiler/compile-loop.js`

Correction to earlier draft:

- loop variables are also already channel-backed in the modern async path
- the real migration work here is:
  - keep or simplify the modern channel-based loop-variable path
  - remove the legacy frame-based path
  - keep or simplify the modern channel-based path

### 4. Scope balancing / structural validation

Current shape:

- compile-time and runtime push/pop balance checks are frame-based

Examples:

- `src/compiler/validation.js`
- `src/runtime/checks.js`

Important distinction:

- compile-time validation is already a compiler-only concern
- runtime frame-balance checks are separate and should be evaluated independently

Replacement direction:

- for async mode, runtime structural validation should move to:
  - lexical-scope compilation stacks
  - boundary/buffer ownership invariants
- compile-time frame validation can stay if it is still useful

### 5. Root/composition/macro API signatures

Current shape:

- async render/block/macro functions still accept `frame`
- even after `astate` removal, `frame` remains the ambient async lexical carrier

Examples:

- `src/compiler/compile-emit.js`
- `src/environment/template.js`
- `src/compiler/compile-macro.js`

Replacement direction:

- async generated signatures should eventually take only the runtime state they actually need:
  - `context`
  - current buffer / parent buffer where relevant
  - callback for real fatal errors where relevant

### 6. Top-level/export/scope-root flags

Current shape:

- async code still uses frame-owned state such as:
  - `createScope`

Examples:

- `src/runtime/frame.js`
- `src/compiler/compiler.js`
- `src/compiler/compile-boundaries.js`

Replacement direction:

- move runtime flags to the object that actually owns the concept:
  - render/composition invocation state
  - command buffer / scope-root metadata
  - compile-time scope analysis

Current refined understanding:

- async exportability is not “belongs to root buffer”
- it is “belongs to root lexical scope” or “is declared parent-owned into the root lexical scope”
- ordinary async `var` / `import` bindings can already use analysis scope ownership
- macro/caller exportability still needs explicit parent-owned declaration handling
- async `frame.topLevel` is already gone from async export codegen and async render entry
- `_seesRootScope` / `_returnWaitCount` were dead and are gone
- `markChannelBufferScope(...)` already moved off frame to a runtime buffer helper
- internal waited / return / caller-scheduling channels can already be buffer-owned
- text channels are the counterexample:
  - they still participate in guard/capture/revert visibility
  - removing frame registration there currently breaks guard semantics

This is easy to miss because these uses are not ordinary variable lookup, but
they still block full runtime-frame removal.

### 7. CommandBuffer ownership

Current shape:

- `CommandBuffer` no longer validates or stores frame

Examples:

- `src/runtime/command-buffer.js`

Replacement direction:

- already simplified
- remaining work is to remove any leftover frame-flavored callsites/tests and keep the signature narrow

This is not a major design dependency. It is a cleanup step.

---

## Scope vs Buffer Invariant

This migration must preserve the following invariant:

- buffer visibility answers “can this runtime read reach that channel lane?”
- scope ownership answers “which lexical binding does this name refer to?”

They are related, but not interchangeable.

Examples:

- two distinct lexical variables can end up in the same command buffer
  - renaming avoids collisions
  - buffer ownership alone cannot recover that distinction
- a parent-owned declaration may belong to a different lexical scope owner than the node currently compiling
- include/import visibility can use buffer/channel linking at runtime, but the set of names that should be exposed is still decided by analysis

Any future frame-removal change must classify itself first:

- scope question
  - use analysis
- runtime channel-visibility question
  - use buffer/channel ancestry
- mixed question
  - preserve both models explicitly; do not collapse one into the other

---

## Audit Checklist For Frame Removal Changes

Before removing any async frame usage, audit whether the behavior depends on exact lexical scope rather than buffer structure.

Cases that already require exact scope reasoning today:

- declaration ownership
  - `declares`
  - `declaresInParent`
  - `parentOwned`
- shadowing and runtime-name mangling
  - [compile-rename.js](/c:/Projects/cascada/src/compiler/compile-rename.js)
- scope-owner lookup
  - `getScopeOwner(...)`
  - `findDeclarationOwner(...)`
  - `getIncludeVisibleVarChannels(...)`
- read-only parent visibility
  - `parentReadOnly`
  - `_passesReadOnlyBoundary(...)`
- macro/caller exportability
  - macro nodes declare the same name both locally and in the parent scope
- runtime local lookups that still depend on lexical frame storage
  - `frame.lookup(...)`
  - `lookupAndLocate(...)`

Cases that are more naturally buffer/channel questions:

- channel final visibility/read reachability
- linked child-buffer lane visibility
- final snapshot vs ordered snapshot choice
- composition buffer linking

Required discipline for future changes:

- if a change removes a frame check, document whether it was:
  - replaced by analysis
  - replaced by buffer/channel runtime state
  - or proven dead
- if the change affects exportability or shadowing, add or update focused tests for:
  - nested scopes in the same buffer
  - parent-owned declarations
  - import/include/macro/caller composition

### 8. Sink finalization and other frame-walking helpers

Current shape:

- the old sink-finalization helper has already been removed

Examples:

- `src/runtime/channel.js`

Replacement direction:

- keep checking for any other frame-walking helper that survived outside `declareChannel(...)` / `getChannel(...)`

### 9. Runtime while iterator helper

Current shape:

- `whileConditionIterator(...)` still does runtime `frame.push()` / `frame.pop()` directly

Examples:

- `src/runtime/loop.js`

Replacement direction:

- treat this as part of runtime async frame-stack removal
- not just generated-code cleanup

### 10. `AsyncFrame.inCompilerContext`

Current shape:

- a runtime class exposes a compiler-only escape hatch

Examples:

- `src/runtime/frame.js`

Replacement direction:

- remove this once async runtime frame writes are gone

This is an architectural smell and should be an explicit cleanup target.

---

## Key Invariants Required Before Removal

These are the must-have truths before async frame removal is safe.

### Invariant A

In async mode, source-level names are never resolved dynamically at runtime in the modern path.

Instead:

- every async variable/channel read uses a compile-time-resolved runtime name
- shadowing is already represented in that runtime name

If this invariant is false, frame removal is not safe.

### Invariant B

In async mode, channel ownership is not discovered by walking frame ancestry.

Instead:

- the relevant buffer structure already knows which channels exist
- runtime lookup uses canonical naming plus buffer ancestry / aliasing metadata

### Invariant C

In async mode, loop metadata is not stored in frame variables.

Channel-based or JS-local bindings are both acceptable. The modern path already uses channels.

### Invariant D

In async mode, boundary nesting/scoping does not rely on runtime frame push/pop to be correct.

### Invariant E

In async mode, macro/include/inheritance/caller composition no longer requires `frame` for lexical variable visibility.

### Invariant F

In async mode, top-level/export/scope-root runtime flags no longer live on frame.

### Invariant G

In async mode, `CommandBuffer` creation no longer validates or requires frame ownership.

---

## Migration Risks

### 1. Hidden runtime lookups by source name

This is the biggest risk.

If any async path still does:

- `lookup("x")`
- `frame.lookup("x")`
- `lookupAndLocate("x")`

using source-level names instead of canonical runtime names, removing frame will break shadowing and parent visibility.

### 2. Mixed variable/channel semantics

If some async names are frame vars and some are channels, behavior becomes hard to reason about.

The migration should aim for:

- mutable user-visible lexical state -> channels
- read-only/compiler-private locals may remain JS locals
- not "some channels, some frame variables forever"

### 3. Include/inheritance visibility rules

Includes, blocks, `super()`, imports, macro caller boundaries, and composition aliasing already have subtle visibility semantics.

Moving lookup off frame must preserve:

- nearest visible declaration wins
- parent-visible only when analysis says so
- shadowed locals never leak through parent aliases

### 4. Sequential-path behavior

Some sequence locks and path poison logic still use frame-linked channel access.

Removing frame means sequence path ownership must also move cleanly to the channel/buffer model.

### 5. `node.isAsync` duality

As long as compile-time paths keep branching on both:

- `asyncMode`
- `node.isAsync`

there is too much duplicated logic to safely remove frame reasoning in one place.

### 6. Accidental overreach

Removing the runtime async frame does **not** require removing the compiler frame in the same step.

If we conflate those two goals, the migration will become much larger than necessary.

### 7. Losing validation by accident

The current codebase may still have runtime checks that are only surviving as legacy frame-based guard rails.

Before removing them, we must classify each check as one of:

- lexical/scope/declaration invariant -> should live in analysis / compile-time validation
- real runtime invariant -> should remain runtime validation
- dead compatibility check -> can be removed

If we skip that classification, frame removal may accidentally weaken correctness even when behavior seems to keep working.

---

## Recommended Migration Order

The order matters. Do not start by deleting `frame` APIs.

### Phase 0 — Document and Lock the Async-Only Target

Done when:

- we explicitly state that this plan applies to async mode only
- sync mode may continue using frame-based lookup/storage
- all future changes in this plan are evaluated only against async compilation/runtime
- all future changes in this plan explicitly classify:
  - scope/declaration ownership concerns
  - buffer/channel visibility concerns
  - and any mixed cases that need both models preserved

### Phase 1 — Remove `node.isAsync` as a Compile Routing Axis

Goal:

- async compiler emits one async-mode structure
- runtime helpers remain sync-first where needed
- but compile-time branching is no longer split between async/non-async per node

Work:

- audit compiler methods that still branch heavily on `node.isAsync`
- convert them to:
  - async-mode lowering only when `compiler.asyncMode`
  - sync-first runtime helpers for value handling
- keep sync mode separate at top-level compiler selection, not per-node async subrouting

Why first:

- frame removal is much easier if async mode has one consistent lowering model
- it also shrinks the number of runtime `frame.push()` / `frame.pop()` sites dramatically

Status:

- Done

Implemented:

- compiler async routing now uses `asyncMode` only
- the old async-determination pass was removed

Done when:

- async-mode compilation no longer relies on `node.isAsync` to choose fundamentally different structural paths

### Phase 2 — Audit All Remaining Async Runtime Name Lookups

Goal:

- prove exactly where async mode still resolves names dynamically

Work:

- audit:
  - `src/runtime/lookup.js`
  - `src/compiler/compiler-base.js`
  - `src/compiler/compiler.js`
  - `src/compiler/compile-loop.js`
  - `src/compiler/compile-macro.js`
  - inheritance/include/caller boundaries
- classify each lookup as:
  - source-name dynamic lookup in the modern async path
  - source-name dynamic lookup in the legacy callback path
  - canonical runtime-name lookup
  - context/global lookup

Output:

- a table of remaining async frame-dependent reads/writes, split between modern and legacy paths

Status:

- In progress

Implemented so far:

- modern async symbol reads were reduced away from speculative frame lookup in compiler/runtime paths
- async var-channel lookup now prefers buffer-owned channel lookup before frame fallback

Done when:

- every remaining async frame read/write is known and classified

### Phase 2.5 — Audit Frame-Related Runtime Checks

Goal:

- ensure no important validation is lost when frame-backed runtime behavior is removed

Work:

- inventory runtime checks that currently depend on frame or frame-shaped state
- classify each one as:
  - analysis/compile-time validation that already exists
  - analysis/compile-time validation that must be added
  - real runtime invariant that must stay runtime
  - dead compatibility check

Important likely categories:

- declaration / shadowing / visibility rules
- push/pop balance checks
- top-level/export eligibility checks
- sequence-path root validation
- channel ownership / declaration checks

Done when:

- every frame-related runtime check has a destination
- there is no frame-removal step that implicitly deletes validation

### Phase 3 — Make Async Variable Reads Fully Canonical

Goal:

- async runtime variable reads use canonical runtime names only in the modern path

Work:

- ensure analysis always computes canonical runtime names for async locals/shadowed vars
- adjust compiler emission so async symbol reads never ask runtime to resolve ambiguous source names
- where needed, extend analysis/runtime-name generation to cover missed cases:
  - loops
  - macros
  - call blocks
  - captures
  - imports/includes

Done when:

- modern async lexical reads no longer require frame-based source-name lookup

### Phase 4 — Remove Legacy Frame-Based Loop Metadata Path

Goal:

- async mode no longer has a frame-based loop variable/metadata path

Work:

- keep the modern channel-based loop variable path
- keep the modern channel-based loop metadata path
- remove the legacy `frame.set('loop.*', ...)` path that only survives in the old routing model
- remove any remaining legacy frame-based loop variable path that only survives in the old routing model
- re-evaluate only after Phase 1 whether any loop metadata should later become JS locals

Done when:

- async loops have no remaining frame-based runtime path for loop vars or loop metadata

### Phase 5 — Move Async Channel Ownership from `frame._channels` to `buffer._channels`

Goal:

- async channel registration and lookup stop using frame ancestry

Work:

1. in async mode, register channels in `buffer._channels`
2. in async mode, make `getChannel(...)` walk buffer ancestry / shared maps instead of frame ancestry
3. migrate helpers that still rely on frame channel walks
   - including sink finalization helpers
4. remove dead frame threading from channel construction and declaration

Why this is more tractable than it first looked:

- `buffer._channels` already exists
- the main work is migrating ownership and visibility rules, not inventing a new storage model

Status:

- In progress

Implemented so far:

- buffer-owned channel lookup helper exists and is already preferred in modern async lookup paths
- visible buffer lookup now preserves owned channel objects per buffer and walks buffer ancestry
- channel construction/factory plumbing is already frame-free
- some internal async channels are already buffer-owned:
  - `__return__`
  - waited-control-flow channels
  - macro caller-scheduling channels
- async text channels are now also buffer-owned
  - root text buffers
  - render/capture text buffers
  - async macro caller text buffers
  - noop composition text buffers
- root-owned async `var` declarations are now also buffer-owned
- imported bindings and async macro bindings are now buffer-owned too
- inherited block composition now exposes deferred-export channels through lookup-only parent-buffer visibility links instead of frame ancestry
- deferred export resolution now records the owning buffer/channel explicitly instead of rediscovering exports through frame visibility
- context forks for `extends` now share deferred-export channel metadata

Remaining core work:

- move `declareChannel(...)` registration off `frame._channels`
- remove the remaining frame fallback from channel lookup once declaration ownership is migrated
- then collapse `findVisibleChannel(...)` to a buffer-only helper or remove it in favor of direct `currentBuffer.findChannel(...)` / `getChannelFromBuffer(...)`
- the remaining blockers are now:
  - other non-text lexical visibility and shadowing cases
  - deferred export / guard / recover cases that still rely on stronger visibility than a naive shared registry
  - export-resolution parity beyond the now-fixed root-owned async var case

Done when:

- async `declareChannel(...)`, `getChannel(...)`, and related helpers no longer depend on frame ancestry

### Phase 5.1 - Redesign Text-Channel Guard/Capture Visibility

Status:

- Done

Implemented:

- buffers now preserve owned channel objects per name instead of only a shared-map entry
- visible channel lookup walks buffer ancestry by owned channel
- async text channels now register with `declareBufferChannel(...)`
- guard / capture / revert semantics stay green

Verification used:

- `tests/poison/guard.js`
- `tests/pasync/snapshots.js`
- `tests/explicit-outputs.js`
- `tests/pasync/composition.js`
- `tests/pasync/macros.js`

### Phase 5.2 - Retry Buffer-Only Text Channel Registration

Status:

- Done

Implemented:

- async text-channel declaration sites now use `declareBufferChannel(...)`
  - managed root text buffer
  - render boundaries
  - capture boundaries
  - async macro caller text buffer
  - noop composition template text channel

Verification used:

- focused guard/snapshot/composition coverage
- `npm run test:quick`

### Phase 5.3 - Remove Frame Fallback From Visible Channel Lookup

Goal:

- async visible-channel reads become buffer-only
- `findVisibleChannel(...)` either becomes a thin buffer helper or disappears in favor of direct `currentBuffer.findChannel(...)`

Status:

- Blocked

What we learned:

- ordinary async symbol reads are no longer the main blocker
- a direct `findVisibleChannel(...) -> getChannelFromBuffer(currentBuffer, ...)` simplification was attempted and reverted
- the current failures are in deferred export / composition parity paths, where export resolution still finds channels that are not yet recoverable from buffer visibility alone
- root-owned async var exports were fixed by recording their owning buffer/channel directly
- imported bindings / macro bindings used through inherited blocks were fixed by adding lookup-only deferred-export visibility links on the parent root buffer
- these links must stay lookup-only; turning them into structural lane links closed parent lanes too early

Prerequisite:

- finish redesigning export/deferred-export visibility so those reads can resolve through buffer state alone
- finish migrating the remaining non-text declarations that still depend on frame-backed lexical visibility

Done when:

- `findVisibleChannel(...)` no longer falls back to `getChannel(frame, ...)`
- or all remaining callers have been rewritten to use `currentBuffer.findChannel(...)` / `getChannelFromBuffer(...)` directly

### Phase 5.5 — Move Async Top-Level / Scope-Root State Off Frame

Goal:

- async runtime no longer relies on frame for top-level/export/scope-root flags

Status:

- In progress

Implemented so far:

- async export codegen no longer uses `frame.topLevel`
- async render entry no longer sets `frame.topLevel`
- `_seesRootScope` and `_returnWaitCount` were removed
- `markChannelBufferScope(...)` now lives on runtime as a direct buffer/channel helper

Remaining work:

- remove or relocate async `createScope` runtime state
- verify no remaining async behavior still depends on frame-only scope-root flags

Work:

- finish removing `createScope` from runtime async frame/state
- keep runtime scope-root metadata on the object that actually owns it
- keep channel-scope root marking as a direct buffer/channel helper, not a frame concern

This can happen earlier than the hardest channel-migration work because it is mostly orthogonal.

Done when:

- async runtime control flags no longer require frame instances

### Phase 6 — Remove Async Runtime Variable Writes to Frame

Goal:

- no async `frame.set(...)` for lexical values

Work:

- replace remaining async variable assignment paths with channel writes
- remove `THROW_ON_ASYNC_FRAME_ASSIGN` / `AsyncFrame.set(...)` compatibility once nothing depends on it

Done when:

- async runtime lexical state lives in channels or JS locals, not frame variables

### Phase 7 — Remove Remaining Runtime Async Frame Stack Operations

Goal:

- runtime async execution no longer needs `frame.push()` / `frame.pop()`

Work:

- separate compile-time frame/scoping analysis from runtime state
- remove runtime push/pop calls from:
  - loops
  - conditionals
  - guards
  - macros
  - blocks
  - captures
  - `whileConditionIterator(...)`
- remove `AsyncFrame.inCompilerContext`

Important note:

- Phase 1 should reduce the cleanup surface substantially before this step begins

Done when:

- async generated code and async runtime helpers no longer emit/use runtime frame stack operations

### Phase 8 — Simplify Async Render/Macro/Block Signatures

Goal:

- async generated functions stop accepting `frame`

Work:

- root/block signatures
- macro/caller signatures
- template composition APIs
- include/inheritance dispatch paths

Important:

- keep `cb` where fire-and-forget fatal error propagation still matters
- do not remove `cb` from structural boundary/root/render paths just because frame is gone

Done when:

- async generated entrypoints no longer accept runtime frame objects

### Phase 9 — Remove Dead Async Frame Parameters and Validation

Goal:

- leftover dead async frame plumbing is gone

Work:

- remove dead `frame` constructor validation from `CommandBuffer`
- remove dead frame parameters from channel constructors and helpers
- remove async-only runtime frame validation that is no longer reachable
- delete `AsyncFrame`

Status:

- In progress

Implemented so far:

- `CommandBuffer` no longer validates or stores frame
- `createCommandBuffer(...)` no longer takes frame
- channel constructors no longer take/store frame
- channel factory helpers no longer take frame
- dead sink-finalization plumbing was removed

Remaining likely work in this phase:

- remove dead frame args from `declareChannel(...)`
- continue trimming test/helper callsites that still reflect older frame-shaped APIs

Done when:

- async mode has no runtime frame model

### Phase 10 — Remove Compiler Frame Dependence from Async Codegen

Goal:

- async code generation no longer depends on compiler frame objects

Why this is later:

- runtime-frame removal does not require compiler-frame removal
- but the eventual target is analysis-driven async codegen, not permanent compiler-frame dependence

Done when:

- async codegen uses analysis data directly for scope/visibility/runtime names
- compiler-frame objects are no longer required for async-mode code generation

---

## Likely Intermediate Architecture

The most plausible intermediate shape is:

- **sync mode**
  - keep `Frame`
  - keep current lexical lookup model

- **async mode**
  - compile-time scope analysis decides canonical runtime names
  - mutable user-visible lexical state lives in channels
  - read-only/compiler-private locals may use JS locals
  - command buffers + channel ancestry represent visibility
  - no runtime variable frame

This split is acceptable. There is no need to force a unified sync/async runtime during the migration.

---

## What Probably Does Not Need to Survive

These are likely legacy in async mode:

- async `frame.lookup(...)`
- async `frame.set(...)`
- async `lookupAndLocate(...)`
- async runtime frame stack balancing checks
- async `AsyncFrame` constructor/signature threading
- frame validation in `CommandBuffer` once ownership migration is done

---

## What Probably Must Exist in Some Form

Even without async frame, the runtime still needs:

- lexical scope identity
- canonical runtime names
- channel ownership registry
- parent visibility/alias/prelink rules
- compile-time-only structural scope tracking
- top-level/export/scope-root ownership state

So the removal is really:

- remove **frame as the runtime carrier**
- not remove scope semantics

---

## Suggested First Concrete Audit Tasks

These are the best first implementation tasks after adopting this plan.

1. Remove `node.isAsync` as an async compile-routing mechanism.

2. Produce a concrete async-only lookup audit:
   - all runtime reads/writes still using frame
   - all compiler sites still emitting source-name runtime lookups
   - clearly split modern vs legacy async paths

3. Migrate the async channel registry:
   - `declareChannel(...)`
   - `getChannel(...)`
   - sink finalization helpers

4. Remove the legacy async loop frame path.

Do not begin by rewriting `channel.js` globally without first splitting async and sync behavior clearly.

---

## Success Criteria

This plan succeeds when all of the following are true in async mode:

- no `AsyncFrame`
- no async generated function takes `frame`
- no modern async runtime lexical lookup depends on frame ancestry
- no async lexical writes use `frame.set(...)`
- async loops have no remaining frame-based runtime path
- channels are resolved through buffer/channel ownership structures, not frame storage
- async runtime no longer depends on frame-owned top-level/scope-root flags
- `node.isAsync` is no longer used as the async/non-async routing mechanism

---

## Short Feasibility Verdict

Is it feasible?

Yes.

Is it a cleanup-sized change?

No. It is a major async-architecture migration.

The strongest sign that it is feasible is that the compiler/runtime already moved most async semantics to:

- static analysis
- command buffers
- channels
- explicit boundary helpers

The strongest sign that it is still substantial is that channel ownership and lookup are still frame-based today.

So the realistic strategy is:

- unify async lowering first
- eliminate runtime source-name lookup second
- migrate channel ownership third
- remove async frame last
