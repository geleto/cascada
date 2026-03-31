# `caller()` Structural Attachment Architecture

## Problem

This document describes the architectural problem around `caller()` in async Cascada execution and the intended solution.

The current late-link failures come from a mismatch between:

- macro-local rendering scope,
- `caller()`'s read-only access to the parent scope,
- nested composition boundaries,
- and the channels-refactor rule that structural buffer relationships must be established early, not attached later as a side effect of consuming a returned promise.

The important facts are:

- A macro has its own scope and should not directly write into the parent command buffer tree as if it were ordinary parent output.
- A `caller()` body has read-only access to the parent scope.
- The caller body may issue observable commands when it is rendered.
  - In practice this means text output and other composition-visible reads/observable behavior.
  - Parent-owned mutations across the caller boundary are not allowed.
- A macro may call `caller()` multiple times.
- Those `caller()` invocations may happen from control-flow-flexible code:
  - loops
  - `if` / `elif` / `switch`
  - nested macros
  - nested `caller()` chains
- The macro must not finish its relevant composition boundary until all `caller()` invocations have finished scheduling their commands.
- This is a structural scheduling problem, not just a value-resolution problem.

This also relies on a broader channels-refactor principle:

- child buffers are not used only for dynamic async control flow
- they are also used when a brand new command/output tree is needed, with its own scope boundary and no direct writes into the parent tree

That matters here because a macro/caller boundary may still need its own buffer even when its internal command structure is otherwise known synchronously.

The failure shape we have already seen:

- nested async callers can hit `Cannot add command to finished CommandBuffer`
- nested imports through macro/caller composition can hit the same failure
- sequential side effects inside `caller()` can stop registering correctly if the caller boundary finishes too early

The concrete late operation currently shows up through:

- `runtime.linkWithParentCompositionBuffer(...)`

That means the core bug is:

- the caller-owned composition structure is still being attached after its owning parent boundary has already started finishing.

## Design Constraints

Any valid solution must satisfy all of the following:

1. Macros remain their own scope/root buffer boundary.
2. `caller()` remains read-only with respect to parent-owned state.
3. Multiple `caller()` invocations from the same macro are supported.
4. Nested callers are supported.
5. `caller()` inside loops / conditionals is supported.
6. The solution must determine structural command-buffer relationships early.
7. The solution must not rely on "just await the returned caller value before adding text".
   - We already tried that shape.
   - It deadlocked nested caller/import/sequencing cases.
8. The solution must distinguish:
   - structural completion of caller scheduling
   - final text/value materialization returned to the caller
9. The solution should be compatible with the channels-refactor principle:
   - commands are added synchronously when structure is already known
   - child buffers are used only when async/control-flow determines structure

## High-Level Model

The solution uses three levels of ownership:

1. The macro buffer
2. One macro-local "all callers" composition buffer
3. One child buffer per individual `caller()` invocation

### 1. Macro Buffer

The macro itself still owns its normal local buffer:

- local macro text
- local macro vars
- local macro return channel
- local control-flow buffers created by normal async lowering

This macro buffer is not the same as the caller composition boundary.

Crucially:

- the macro buffer is not connected to the parent buffer tree as a normal child branch
- it is an isolated macro-local tree
- the parent consumes the macro's returned value, not the macro buffer's internal command stream directly

### 2. All-Callers Buffer

Each async macro that can call `caller()` owns one dedicated composition buffer for all `caller()` output scheduled by that macro.

This buffer is:

- local to the macro
- separate from the ordinary macro buffer
- not finished until the macro is sure no more `caller()` invocation buffers will be added to it

This buffer is the structural parent for all individual caller invocations from that macro call.

Unlike the macro buffer, this buffer is linked to the parent buffer tree.

But that linkage is restricted:

- it is linked only for parent-visible observable commands
- it is not a general "macro writes directly into parent scope" escape hatch
- the restriction is enforced by static analysis through the read-only caller boundary rules

### 3. Per-Invocation Caller Buffers

Each `caller()` invocation creates a fresh child buffer linked under the macro's all-callers buffer.

This per-invocation child buffer owns the command structure of that specific `caller()` execution.

That means:

- if the macro calls `caller()` three times, there are three distinct child buffers
- if `caller()` is invoked inside a loop, each invocation still gets its own child buffer
- if nested callers occur, each nested caller chain gets its own boundary stack

This is the key difference from a naive model where all caller output is emitted directly into one shared caller buffer.

## Why Per-Invocation Child Buffers Are Needed

The macro may invoke `caller()`:

- multiple times
- from async control flow
- from nested composition paths

So we need a representation where each invocation can independently say:

- "my command structure is now fully scheduled"

without forcing:

- the all-callers buffer to finish immediately
- later caller invocations to be rejected

Per-invocation child buffers give us exactly that.

These are child buffers under the all-callers buffer:

- each `caller()` invocation owns its own rendering/composition subtree
- even when the invocation is not itself a classic "unknown branch count" control-flow site

## Compiler Model

This is a compiler-level buffer-targeting design, not a runtime-global "active buffer switch".

That distinction is important.

At compile time:

- normal macro body emission targets the macro buffer
- emission of a specific `caller()` invocation targets that invocation's child caller buffer
- after emitting that invocation's body, the compiler resumes targeting the macro buffer

So the compiler temporarily changes its emitted `currentBuffer` target for the duration of the caller invocation body, then restores it.

This is similar in spirit to other scoped buffer-target changes in the compiler, but the ownership rules here are specific to `caller()`.

## Caller Scheduling Signal

The all-callers buffer needs a structural signal that says:

- all per-invocation caller child buffers that were started by this macro have finished being populated

This is not the same as:

- the final caller text being fully materialized
- or the caller text being fully applied by the parent output iterator

### Proposed Form

Each macro call that can invoke `caller()` gets a dedicated internal channel, conceptually:

- `__caller__<id>`

This channel lives in the isolated macro buffer and coordinates the macro's all-callers boundary.

It should be a `ValueOutput` channel, the same channel kind used for timing-only `WaitResolveCommand` bookkeeping elsewhere.

For each `caller()` invocation:

1. create a fresh child caller buffer linked under the all-callers buffer
2. schedule the caller body into that child buffer
3. create one timing-only completion item on `__caller__<id>` that resolves when that child buffer is finished for command addition

The completion item here is similar in mechanism to a `WaitResolveCommand`, but semantically it is not the same as loop `__waited__`.

The important semantic difference:

- loop `__waited__` is about authoritative iteration completion
- caller `__caller__<id>` is about structural scheduling completion of caller invocation buffers

## What Promise Should Go Into `__caller__<id>`

The promise for each caller invocation should resolve when:

- that invocation's child caller buffer has been marked finished for command addition

It should not wait for:

- full text application
- parent traversal completion
- final rendered caller text materialization

Why:

- the purpose of `__caller__<id>` is to let the macro know when no more commands can be added to the all-callers subtree
- not to define the final rendered text result

So this is a "finished for emission" signal, not a "fully rendered/applied" signal.

The clean way to provide this promise is from the invocation child buffer itself:

- each caller-invocation child buffer should expose `getFinishedPromise()`
- this returns one stable promise per buffer
- if called before finish, it returns the stored deferred promise for that buffer
- if called after finish, it returns an already-resolved promise
- `markFinishedAndPatchLinks()` resolves that same stored promise

So for each `caller()` invocation, the compiler/runtime should:

1. create the child caller buffer
2. call `childBuffer.getFinishedPromise()`
3. place that promise into the `WaitResolveCommand` on `__caller__<id>`

This keeps `__caller__<id>` tied to the exact structural event we care about: the child buffer becoming closed for further command addition.

## How Macro Finalization Uses `__caller__<id>`

At the end of macro body scheduling:

1. the macro requests a snapshot/finalization read of `__caller__<id>`
2. that ensures all earlier caller-invocation completion items have been observed in source order
3. only then may the all-callers buffer be marked finished

This is the crucial point:

- the `__caller__<id>` completion is used to decide when it is safe to finish the all-callers buffer
- not as the final return value of the macro

Once the all-callers buffer is safe to finish, macro finalization can proceed without risking late `linkWithParentCompositionBuffer(...)` or late observable commands from nested caller work.

## Value Result vs Structural Completion

These must remain separate.

### Structural Completion

Needed for:

- deciding when the all-callers boundary can be finished
- preventing late command/buffer attachment
- maintaining correct parent-child buffer structure

### Value Result

Needed for:

- the actual text/value returned by the macro or caller boundary
- point-in-time snapshots when those are semantically required
- final text materialization where appropriate

The architecture must not collapse these into one signal.

This is exactly why simply changing from `addSnapshot(...)` to `finalSnapshot()` did not work by itself.

## Relationship to `__waited__`

There is a superficial similarity:

- both use timing-only entries on one internal channel
- both may use channel snapshot/finalization to know when earlier items are done

But the semantics are different.

### `__waited__`

- loop-only
- authoritative iteration completion signal
- concerned with waited-loop ownership and gating

### `__caller__<id>`

- macro/caller-only structural scheduling signal
- concerned with "are all caller invocation buffers done being populated?"
- not a general-purpose loop or rendering completion channel

This distinction should be kept explicit in code and documentation.

## Why "Await Caller Value Before Adding Final Text" Is Wrong

We already tested a version of this idea by changing the async text helper to keep its child buffer open until the mutating expression value resolved.

That failed:

- nested async callers timed out
- nested imports through macro/caller composition timed out
- caller sequencing tests timed out

So the problem is not solved by waiting longer on the value path.

The missing piece is:

- earlier structural attachment of caller-owned child buffers

while:

- final text materialization still remains on the normal value path

## Read-Only Boundary and Analysis Expectations

`Caller` scopes already behave as read-only parent boundaries in analysis.

The implementation should preserve and rely on that.

There are two distinct analysis points involved here:

1. Macro static analysis
2. Caller static analysis

They have different responsibilities.

The caller body may:

- read parent-owned channels
- issue observable commands in its own boundary

It must not:

- mutate parent-owned channels directly across the caller boundary

### Macro Static Analysis

Macro analysis owns the macro-local scheduling/ownership metadata.

It should also determine whether the macro needs caller scheduling support at all.

That detection should happen in analysis, not at runtime:

- analyze the macro body for `caller()` use
- if the macro body contains a `caller()` call boundary, mark the macro as needing caller support
- `_compileMacro` can then conditionally emit the all-callers buffer, the internal `__caller__<id>` channel, and the special generated `caller` binding only for macros that actually need them

In particular:

- the macro-side internal caller scheduling channel (conceptually `__caller__<id>`) belongs to the macro analysis
- that internal channel must be visible in the macro's mutation/ownership picture
- this is what lets the macro know it still has outstanding caller-scheduling structure before it can finish the all-callers buffer

So `__caller__<id>` is not part of caller-body analysis ownership. It belongs to the macro boundary that is coordinating all caller invocations.

### Caller Static Analysis

Caller analysis is responsible for parent-visible observable usage.

The important rule is:

- caller-body analysis must propagate parent-visible `usedChannels`
- but it must not treat the caller body as freely mutating parent-owned channels

This is how the all-callers buffer can be linked to the parent only for observable commands while still preserving the read-only boundary.

In other words:

- caller analysis contributes the parent-facing observable channel usage
- macro analysis contributes the macro-local caller scheduling channel ownership

This remains an important invariant and should continue to be enforced by analysis/validation.

## Local vs Imported Macros

This design is not primarily about "local macro vs imported macro".

The important distinction is structural:

- does this call create nested composition structure that must be attached and scheduled?

Even a local macro can be problematic if it invokes `caller()`.

So the `caller()` architecture must be correct regardless of whether the surrounding macro is:

- local
- imported
- nested

## Expected Implementation Shape

The intended implementation should roughly look like this:

1. Detect that a macro/caller boundary needs caller scheduling support.
2. Create one macro-local all-callers buffer linked to the parent and one internal `__caller__<id>` channel for that macro call - inside the macro command buffer which is not linked to the parent.
3. Generate the `caller` binding so that each runtime `caller()` invocation:
   - creates a fresh child caller buffer under the all-callers buffer
   - emits the already-compiled caller body into that child buffer
   - schedules one structural completion item into `__caller__<id>` for that invocation child
4. At macro end:
   - use `__caller__<id>` completion to determine that no more invocation child buffers will be added
   - then mark the all-callers buffer finished
5. Keep the macro's actual returned value logic separate from that structural completion path.

## Regression Cases This Must Fix

Any implementation of this design should be considered incomplete unless it fixes at least these cases:

- nested async callers
- nested async caller error propagation
- nested imports through caller/macro composition
- sequential side effects inside `caller()`

And it must not regress:

- plain local macros
- imported macro calls without caller composition
- waited-loop macro text materialization cases
- inheritance/composition behavior outside this specific caller boundary problem

This document is only about the `caller()` / nested composition structural attachment problem that currently blocks macro-side refactoring.

## Step-By-Step Plan

1. Add `getFinishedPromise()` to `CommandBuffer`.
   - Return one stable promise per buffer.
   - Resolve it from `markFinishedAndPatchLinks()`.
   - If the buffer is already finished, return an already-resolved promise.

2. Extend macro analysis to detect whether a macro body uses `caller()`.
   - Mark that the macro needs caller scheduling support.
   - Record ownership of the internal `__caller__<id>` channel in macro analysis.
   - Macros without `caller()` stay on the simpler path and should not get the extra caller buffer/channel machinery.

3. Keep caller-body analysis separate from macro analysis.
   - Continue enforcing the read-only boundary for parent-owned channels.
   - Propagate the caller body's parent-visible `usedChannels` so the all-callers buffer can be linked correctly.

4. In `_compileMacro`, for macros that need caller support, generate caller scheduling infrastructure and thread parent-buffer access into the generated macro function.
   - the isolated macro buffer
   - one all-callers buffer linked to the parent only on the caller body's parent-visible `usedChannels`
   - one internal `__caller__<id>` `ValueOutput` channel owned by the macro
   - a fresh all-callers buffer / `__caller__<id>` pair for each macro/caller boundary, so nested callers do not share coordination state
   - access to the parent `currentBuffer` at macro call time, so the all-callers buffer can be linked early when the macro actually runs

5. Remove the old late-link path.
   - Remove the `runtime.linkWithParentCompositionBuffer(...)` caller-path linking from `emit.js` / `compileOutput`.
   - The new early-link path must replace it rather than coexist with it.

6. Generate the `caller` binding so each runtime `caller()` invocation:
   - creates a fresh child caller buffer under the all-callers buffer
   - passes that child buffer as the execution target to the already-compiled caller body
   - gets `childBuffer.getFinishedPromise()`
   - emits one `WaitResolveCommand` for that promise into `__caller__<id>`
   - calls `childBuffer.markFinishedAndPatchLinks()` when that invocation is done adding commands

7. At macro finalization time:
   - request ordered completion of `__caller__<id>` through a channel snapshot/finalization read of that `ValueOutput` channel
   - once that completion is reached, mark the all-callers buffer finished
   - only then continue with the macro's own return/finalization path
   - keep the macro return value on its own separate snapshot/finalization path; `__caller__<id>` is only for caller structural completion

8. Verify the required regressions.
   - nested async callers
   - nested async caller error propagation
   - nested imports through caller/macro composition
   - sequential side effects inside `caller()`
   - multiple `caller()` invocations from the same macro
   - multiple `caller()` invocations reached through different loops / conditionals / control-flow paths in the same macro
