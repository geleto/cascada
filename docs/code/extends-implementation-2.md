# `extends-next` Simplification Plan 2

## Overview

This document is a cleanup and simplification plan for the current
`extends` / inheritance / component implementation.

## Status Update

Most of the structural simplification described here has now landed.

### Completed or effectively completed

- Step 0:
  - dead inheritance-resolution fields were removed from `Context`
  - the dead `ownerKey` bootstrap parameter was removed
  - focused late-linking/shared-root tests were kept green during the cleanup
- Step 1:
  - extends-composition payload storage moved into `InheritanceState`
  - template-local inheritance captures moved into `InheritanceState`
  - `Context` no longer owns inheritance-specific payload storage
- Step 2:
  - parent startup and component startup now reuse the same shared bootstrap
    lifecycle shape
  - direct root startup still keeps its separate render/composition finalization
- Step 3:
  - payload constructors/normalizers now live with the runtime inheritance
    state owner
  - payload merge logic moved out of `Context`
- Step 4:
  - the dynamic adapter is now visibly concentrated in
    `compiler-extends-dynamic-root.js` and `inheritance-resolution.js`
  - static owners no longer own dynamic-top-level block branching directly
- Step 5:
  - method metadata moved out of `compiler-extends.js` into a dedicated helper
  - root finalization moved out of `compiler-extends.js` into a dedicated helper
  - generic template/script lookup and import-binding helpers moved out of
    `compiler-inheritance.js` into `compiler-composition.js`
  - inheritance now owns inheritance-specific block/super/extends concerns
    again
- Step 6:
  - block entry context assembly moved behind a runtime helper
    (`prepareBlockEntryContext(...)`)
  - emitted block-entry setup is shorter and no longer open-codes payload
    extraction/forking logic
- Step 7:
  - `runtime/call.js` no longer re-exports inheritance entry points
  - runtime ownership boundaries are now much clearer

### Still worth doing

- Step 8 documentation/explanation pass:
  - update `extends-next.md` ownership notes to match the landed structure
  - add a short trace for one inherited call
  - add a short trace for component startup reuse
  - document the remaining dynamic adapter seam explicitly

### Current practical status

The implementation is now much closer to the intended target shape:

- `InheritanceState` is the explicit per-hierarchy runtime owner
- `Context` is no longer the overflow container for inheritance internals
- compiler ownership is split more honestly between:
  - root/bootstrap coordination
  - method metadata
  - root finalization
  - inheritance call/block/super emission
  - generic composition/import/include lookup helpers
- the dynamic adapter remains, but it is much narrower and easier to ignore
  when reading the static path

What remains is mostly documentation, explanation, and broader verification
rather than another major architectural simplification step.

It is intentionally not a return to the original early design that assumed the
full parent chain could be fully prepared before constructor execution started.

The current late-linking rule is correct and must remain:

- shared-visible progress may stall at inheritance admission
- parent metadata and shared schema may finish loading during that stall
- exact linked channels must be attached only after the admitted target is
  current

So this plan does not try to remove:

- `InheritanceAdmissionCommand`
- shared-root admission as the stall point
- exact-link-after-load behavior
- the shared-root model

Instead, this plan simplifies the code around those requirements so the
essential complexity is concentrated in a few obvious owners instead of spread
across compiler, runtime, and `Context`.

## Problem Statement

The current implementation works from the right architectural core, but still
has too many moving parts around it:

- startup logic is split across direct root startup, parent startup, and
  component startup with duplicated shapes
- inheritance payload transport and composition payload transport are still
  partially owned by `Context`
- dynamic extends compatibility still leaks into otherwise static ownership
  paths
- compiler ownership is better than before, but root startup, inherited-call
  emission, block payload threading, and composition helpers still overlap
- dead or transitional structural state still exists after earlier refactors

The result is that the implementation is larger and harder to explain than the
underlying model.

## Simplification Goal

Reach a state where a developer can explain the feature set in four small
owners:

1. one compiler owner for root/bootstrap emission
2. one compiler owner for inheritance/component call emission
3. one runtime owner for hierarchy bootstrap/startup
4. one runtime owner for admission/dispatch

And where `Context` is no longer the fallback storage location for
inheritance-specific runtime state beyond plain render/composition context.

## Non-Goals

This plan does not:

- redesign the semantics of late linking
- remove dynamic extends support
- change user-facing `shared`, `this.method(...)`, `super()`, or component
  behavior unless explicitly called out in a later follow-up design
- merge inheritance dispatch into ordinary callable dispatch

## Guardrails

Every step in this plan should preserve these invariants:

- exact-link-after-load remains true for unresolved constructor and inherited
  method admission
- shared-channel declarations still route to the real hierarchy shared root
- component instances still own their own shared root boundary
- static extends does not regain wildcard lane linking
- dynamic extends keeps its current Option B behavior contract unless a later
  dedicated redesign replaces it

## Current Complexity Buckets

The current code splits into two kinds of complexity.

### Essential complexity

- shared-root ownership
- incremental metadata/schema registration
- admission-time stalling
- exact linking after load
- constructor/method invocation buffers

### Accidental or amplifying complexity

- duplicated startup code for parent and component paths
- payload assembly and transport logic spread across compiler plus `Context`
- dynamic-parent bridging visible in multiple non-dynamic owners
- residual state-copy behavior on `Context`
- compiler helper boundaries that are still wider than the concepts they own

This plan only targets the second category.

## Target Shape

### Runtime

Keep `InheritanceState` as the single explicit per-hierarchy runtime carrier.

Move the two remaining live inheritance-related fields off `Context` and into
that existing runtime owner:

- extends-composition payloads keyed by parent template
- template-local inheritance captures

If the dynamic adapter still needs dedicated state, keep it as a clearly named
sub-area of `InheritanceState` rather than introducing a second top-level
runtime wrapper type.

`InheritanceState` should grow explicit named sub-areas rather than becoming a
flat catch-all object. For example:

- method registration / resolution state
- shared-schema state
- dynamic-adapter state
- template-local capture state

It should not live on `Context` as scattered fields.

`Context` should keep only:

- current variable context
- render context
- extern context
- shared block/export structural state that genuinely belongs to render context

### Compiler

The intended compiler split is:

- root/bootstrap emission owner
- call-site emission owner
- generic composition owner

The inheritance compiler should not also be a back door for import/include
composition helpers, and the extends root compiler should not own broad payload
construction patterns that belong to a shared composition/input layer.

### Dynamic Extends

Dynamic extends should remain an explicit adapter seam.

That seam should have only three responsibilities:

- store or resolve the late parent template
- delay top-level block rendering until the registration wave is current
- hand off into the same runtime startup/admission helpers used elsewhere

Everything else should use the same static-path bootstrap/admission helpers.

## Step 0 - Freeze Invariants And Remove Dead Residue

**Goal:** Make the current contract explicit before moving code.

### Work

- write a short invariant checklist in tests for:
  - unresolved inherited dispatch stalls shared-visible progress
  - newly discovered shared lanes attach during the stalled window
  - component shared roots do not leak into caller shared roots
- delete these dead `Context` fields copied by `_copySharedStructuralState(...)`:
  - `inheritanceResolutionPromise`
  - `inheritanceResolutionResolver`
  - `inheritanceResolutionPendingCount`
- delete the dead `ownerKey` parameter from
  `bootstrapInheritanceMetadata(...)`
- remove comments and wrapper names that still describe superseded ownership

### Main files

- `src/environment/context.js`
- `src/runtime/inheritance-bootstrap.js`
- `src/runtime/inheritance-call.js`
- `src/runtime/command-buffer.js`
- focused tests in `tests/pasync/extends.js` and
  `tests/pasync/component-lifecycle.js`

### Success criteria

- no unused inheritance-resolution state remains on `Context`
- `bootstrapInheritanceMetadata(...)` no longer accepts an acknowledged-dead
  parameter
- the tests clearly lock the late-linking contract before structural cleanup

### Verification

- rerun focused unresolved-admission tests in `tests/pasync/extends.js`
- rerun focused component-root-boundary tests in
  `tests/pasync/component-lifecycle.js`
- confirm no remaining reads of the deleted `Context` resolution fields

## Step 1 - Move The Two Remaining Live `Context` Fields Into `InheritanceState`

**Goal:** Finish the move to one explicit per-hierarchy runtime owner without
introducing a new wrapper type.

### Work

- move `extendsCompositionByParent` from `Context` into `InheritanceState`
  directly, or into a clearly named dynamic-adapter sub-area owned by
  `InheritanceState`
- move `inheritanceLocalCapturesByTemplate` from `Context` into
  `InheritanceState`
- keep `inheritanceState` as the only threaded vehicle for per-hierarchy state
- update the dynamic adapter and block/method paths to read from
  `inheritanceState` instead of `Context`

### Main files

- `src/environment/context.js`
- `src/runtime/inheritance-state.js`
- `src/runtime/inheritance-startup.js`
- `src/runtime/component-bootstrap.js`
- `src/runtime/inheritance-resolution.js`
- `src/compiler/compiler-extends.js`
- `src/compiler/compiler-extends-dynamic-root.js`

### Reuse

- reuse the existing explicit `inheritanceState` threading style instead of
  moving back toward ambient `Context` ownership

### Replace

- replace `Context` as the owner of extends composition payloads and template
  local captures

### Keep

- keep `Context` block/export sharing and composition-context forking behavior

### Success criteria

- `Context` no longer owns inheritance-specific payload storage
- `inheritanceState` is the single explicit per-hierarchy runtime owner

### Verification

- rerun focused dynamic-extends tests that exercise parent composition payload
  recovery
- rerun focused inherited block/method tests that rely on template-local
  captures
- confirm `forkForPath(...)` and `forkForComposition(...)` still share only
  structural render state, not inheritance payload storage

## Step 2 - Unify The Shared Runtime Bootstrap Lifecycle

**Goal:** Collapse duplicated runtime bootstrap work for parent startup and
component startup into one family, and reuse that shared lifecycle from direct
root startup where appropriate.

### Work

- identify the shared startup shape:
  - resolve/compile target
  - register methods/shared schema
  - preload shared inputs when applicable
  - ensure shared links when needed
  - admit `__constructor__`
- express that shape once as a common runtime bootstrap helper
- make parent startup and component startup thin wrappers around that helper
- let direct root startup reuse the same lifecycle pieces where appropriate
- explicitly keep root render/composition finalization outside this step

### Main files

- `src/runtime/inheritance-startup.js`
- `src/runtime/component-bootstrap.js`
- `src/runtime/inheritance-bootstrap.js`
- `src/runtime/component.js`
- `src/compiler/compiler-extends.js`
- `src/compiler/compiler-component.js`

### Reuse

- reuse the current `bootstrapInheritanceMetadata(...)`,
  `preloadSharedInputs(...)`, and `admitConstructorEntry(...)` pieces

### Replace

- replace duplicated parent/component startup orchestration

### Keep

- keep the distinction between:
  - direct root startup
  - parent startup from an `extends` site
  - component instance creation

### Success criteria

- there is one obvious runtime bootstrap entry shape
- parent startup and component startup no longer reimplement the same lifecycle

### Verification

- rerun focused parent-startup tests in `tests/pasync/extends.js`
- rerun focused component-constructor startup tests in
  `tests/pasync/component-lifecycle.js`
- confirm direct root render/composition return timing remains unchanged

## Step 3 - Normalize Payload Shapes And Move Payload Assembly To Match Storage

**Goal:** Separate and simplify the payload types crossing inheritance and
composition boundaries.

### Work

- define explicit payload shapes for:
  - extends/base configuration payload
  - inheritance call payload
  - template-local capture payload
- stop constructing similar-but-different objects in multiple compiler/runtime
  owners
- move payload normalization out of call sites and into small constructor-style
  helpers
- move payload merge logic to the same owner as the storage it reads from
- specifically, move the logic currently spread across:
  - `prepareInheritancePayloadForBlock(...)`
  - `_cloneInheritanceLocalsByTemplate(...)`
  into the runtime owner that now holds template-local captures after Step 1

### Main files

- `src/environment/context.js`
- `src/runtime/inheritance-state.js`
- `src/compiler/compiler-extends.js`
- `src/compiler/compiler-inheritance.js`
- `src/compiler/compiler-composition.js`
- `src/compiler/compiler-async.js`
- new helper file if needed, likely under `src/runtime/` or `src/compiler/`

### Reuse

- keep the current semantic separation between:
  - shared preloads
  - extern composition inputs
  - inherited method/block args
  - local captures

### Replace

- replace raw object-literal construction at multiple call sites

### Keep

- keep block payload transport explicit; do not restore ambient recovery

### Scope boundary

- this step owns payload shape, normalization, and merge semantics
- it does not yet try to shorten emitted block-entry setup code; that belongs to
  Step 6

### Success criteria

- every payload type has one named shape and one owner
- payload merge logic lives with its storage owner instead of partly on
  `Context`
- block entry no longer needs broad, custom payload unpacking logic emitted from
  multiple places

### Verification

- rerun focused inheritance-argument and `super()` tests
- rerun focused template-local capture tests
- add or preserve one compile-shape assertion proving payload construction is no
  longer open-coded at multiple sites

## Step 4 - Verify And Tighten The Dynamic Extends Adapter Boundary

**Goal:** Make dynamic extends visibly separate from the normal static model.

### Work

- verify that everything which only exists because of the Option B dynamic
  adapter already lives behind the intended seam
- remove any remaining leakage rather than treating this as a large refactor
- ensure non-dynamic owners do not know about:
  - `__parentTemplate` storage details
  - top-level dynamic block suppression details
  - extra dynamic completion branching beyond one explicit call

### Main files

- `src/compiler/compiler-extends-dynamic-root.js`
- `src/runtime/inheritance-resolution.js`
- `src/compiler/compiler-extends.js`
- `src/compiler/compiler-inheritance.js`

### Reuse

- reuse the current explicit dynamic root specialization file as the adapter
  home

### Replace

- replace only the remaining scattered dynamic checks in broader owners with one
  dedicated call into the adapter seam

### Keep

- keep current dynamic behavior contract unless a later design replaces it

### Success criteria

- a developer can ignore dynamic extends entirely when reading the static path
- the adapter seam is explicit and narrow

### Verification

- rerun focused dynamic-extends tests
- confirm static extends code paths no longer mention dynamic-parent storage or
  completion details beyond one explicit adapter call

## Step 5 - Shrink Compiler Ownership

**Goal:** Make compiler ownership match the real concepts instead of the
historical migration path.

### Work

- keep `compiler-extends.js` focused on root/bootstrap emission only
- keep `compiler-inheritance.js` focused on inherited block/method/super call
  emission only
- keep `compiler-component.js` focused on direct component binding syntax only
- keep `compiler-composition.js` focused on non-inheritance composition helpers
- split `compiler-extends.js` more concretely along its current fault lines:
  - method metadata helper
  - root bootstrap/admission helper
  - root finalization helper
- move method-metadata collection out of `compiler-extends.js` if that can be
  done without muddying ownership again
  the preferred direction is a small dedicated metadata helper rather than
  folding it wholesale into the call-site compiler
- keep root return/composition completion logic in a dedicated root-finalization
  helper rather than leaving it mixed with metadata and bootstrap emission
- move any remaining shared payload/capture helper that is generic enough into a
  small shared helper rather than leaving it attached to the wrong owner

### Main files

- `src/compiler/compiler-extends.js`
- `src/compiler/compiler-inheritance.js`
- `src/compiler/compiler-component.js`
- `src/compiler/compiler-composition.js`
- `src/compiler/compiler-async.js`

### Reuse

- reuse the existing module split introduced by Step 11 / Step 15 cleanup

### Replace

- replace broad "owner by convenience" helper placement with narrow ownership

### Success criteria

- root startup questions are answered in one compiler file
- inherited call questions are answered in one compiler file
- component binding questions are answered in one compiler file

### Verification

- compile representative script and template inheritance inputs and compare
  compile-shape before/after
- confirm `compiler-extends.js` no longer mixes metadata collection, bootstrap,
  and finalization in one broad owner

## Step 6 - Simplify Block Entry Payload Plumbing

**Goal:** Reduce the amount of inheritance payload unpacking and context forking
logic emitted into every block entry.

### Work

- identify what block entry really needs at runtime:
  - resolved original args
  - local captures for the current template
  - optional render context
- move as much of that assembly as possible out of compiler-emitted inline code
  and into a small runtime helper
- keep the compiled code explicit, but shorten it so block entry setup is
  readable

### Main files

- `src/compiler/compiler-async.js`
- `src/environment/context.js`
- possible new runtime helper for block-entry context preparation

### Reuse

- reuse the current explicit payload transport model

### Replace

- replace open-coded payload extraction and fork-selection logic where a helper
  can express the same semantics

### Keep

- keep block entry standalone-compilable

### Scope boundary

- this step owns emitted block-entry ergonomics only
- payload semantics must already be settled by Step 3

### Success criteria

- block entry generated code becomes noticeably shorter
- the helper boundary reflects a real semantic unit rather than a wrapper-only
  refactor

### Verification

- rerun focused block-argument, `super()`, and local-capture tests
- preserve at least one compile-shape test for block entry setup

## Step 7 - Runtime API Verification And Minor Cleanup

**Goal:** Make the runtime surface match the real ownership boundaries.

### Work

- verify that inheritance startup, admission/dispatch, dynamic-resolution
  adapter, and component bootstrap are already clearly separated runtime
  surfaces
- keep `call.js` as a thin compatibility facade only if it still buys something
- remove any small leftover compatibility exports that still obscure ownership

### Main files

- `src/runtime/runtime.js`
- `src/runtime/call.js`
- inheritance/component runtime modules

### Success criteria

- runtime entrypoints read like a small map of the architecture
- there is no confusion between ordinary callable runtime and inheritance
  runtime

### Verification

- audit `runtime.js` and `call.js` exports after the earlier steps land
- confirm no inheritance owner depends back on a broad facade as its real owner

## Step 8 - Documentation And Explanation Pass

**Goal:** Make the simplified implementation explainable to future maintainers.

### Work

- update `docs/code/extends-next.md` only where it is describing ownership
  rather than semantics
- add a short "how to trace one inherited call" section
- add a short "how component startup reuses the same machinery" section
- document the remaining dynamic adapter seam explicitly

### Success criteria

- a new contributor can trace:
  - root startup
  - parent startup
  - inherited dispatch
  - component method call
  in a few files without reading old migration history

## Recommended Execution Order

Implement in this order:

1. Step 0
2. Step 1
3. Step 3
4. Step 2
5. Step 5
6. Step 4
7. Step 6
8. Step 7
9. Step 8

This order keeps the late-linking core stable while progressively moving the
surrounding accidental complexity into smaller, more explicit owners.

## Expected End State

If this plan succeeds:

- the implementation remains late-linking and exact-link-after-load
- the runtime still uses shared-root admission as the correctness boundary
- the dynamic adapter still exists, but is visibly isolated
- startup logic is unified
- payload transport is explicit and normalized
- `Context` is no longer the overflow container for inheritance internals
- `inheritanceState` remains the one explicit per-hierarchy runtime carrier
- the current feature set is easier to maintain without changing the core model
