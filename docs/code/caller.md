# `caller()` Structural Attachment Architecture

This document describes the current async `caller()` architecture.

`caller()` is a structural composition feature, not just a function returning
text. A macro that accepts a caller owns local output and return state, while the
caller body can read the parent scope and can produce observable work that must
be attached to the parent command-buffer tree early.

## Core Problem

The engine must support:

- multiple `caller()` invocations from one macro call
- `caller()` inside loops and conditionals
- nested caller chains
- caller bodies that contain includes, imports, sequential operations, or other
  command-emitting boundaries
- imported and local caller-capable macros

The parent-visible buffer structure must be established before the relevant
parent boundary can finish. Waiting for the final caller text value is not
enough; structure and value materialization are separate signals.

## Ownership Model

Async caller-capable macros use three levels of buffer ownership.

### Macro Buffer

The macro body owns an isolated macro-local buffer. This buffer holds:

- macro-local text
- macro-local channels
- macro-local return state
- macro-local control-flow child buffers
- the internal `__caller__` timing channel when caller support is needed

The parent consumes the macro's returned value. The macro buffer is not a
general child branch that directly writes into the parent command tree.

### All-Callers Buffer

A macro invocation that can call `caller()` lazily creates one all-callers
buffer. This buffer is linked to the parent buffer using the caller body's
parent-visible used channels.

It is deliberately narrow:

- it exists only for caller composition work
- it is linked only for channels the caller body may observe/use
- it does not allow the macro body to mutate parent-owned channels directly

### Per-Invocation Caller Buffers

Each runtime `caller()` invocation creates a fresh child buffer under the
all-callers buffer.

That per-invocation buffer owns the command structure for exactly one caller
body execution. Multiple calls, loop-started calls, and nested calls therefore
have independent structural completion.

## Scheduling Signal

Caller scheduling uses an internal macro-local channel named `__caller__`.

For each caller invocation, compiler-emitted code:

1. creates a child invocation buffer under the all-callers buffer
2. obtains `invocationBuffer.getFinishedPromise()`
3. adds a `WaitResolveCommand` for that promise to the macro buffer's
   `__caller__` channel
4. invokes the caller body with the invocation buffer
5. marks the invocation buffer finished when body command emission is complete

Two `WaitResolveCommand` entries are added to the `__caller__` channel per
invocation: one for `invocationBuffer.getFinishedPromise()` (structural buffer
completion — when command emission into the child buffer is done) and one for
the invocation result promise wrapped with `.finally(() => invocationBuffer.markFinishedAndPatchLinks())` (result settling — when the invoked caller body's
returned value resolves or rejects). Both signals must be recorded so the macro
knows that structure is fully committed and the value has settled before it can
safely close the all-callers buffer.

The `__caller__` channel records structural scheduling completion. It is not the
final caller text and is not a general rendering-completion mechanism.

## Macro Finalization

At macro finalization:

1. the macro snapshots/observes the `__caller__` channel when caller support is
   present
2. that ordered observation ensures all earlier caller invocation buffers have
   finished command emission
3. the all-callers buffer is then marked finished
4. the macro continues normal return/text finalization

This prevents late attempts to add caller child buffers after the parent-visible
composition subtree has closed.

## Analysis Contract

Macro and caller analysis have separate responsibilities.

Macro analysis:

- detects whether a macro body can call `caller()`
- emits caller support only for caller-capable macros
- owns the internal `__caller__` scheduling channel

Caller-body analysis:

- propagates parent-visible `usedChannels`
- preserves the read-only parent boundary
- prevents the caller body from freely mutating parent-owned channels

The all-callers buffer uses caller-body `usedChannels` for parent linking. The
macro-local `__caller__` channel is not part of caller-body ownership; it belongs
to the macro invocation that coordinates all caller calls.

## Runtime/Compiler Touchpoints

Important current implementation points:

- `src/compiler/macro.js` owns caller scheduling emission
- `CALLER_SCHED_CHANNEL_NAME` is `__caller__`
- `CommandBuffer.getFinishedPromise()` is the structural completion primitive
- caller invocation buffers are created with `runtime.createCommandBuffer(...)`
- `WaitResolveCommand` is used only as timing bookkeeping
- caller-capable macros expose `__callerUsedChannels` metadata for parent
  linking
- the compiled macro function receives a `macroParentBuffer` parameter; this is
  how the all-callers buffer obtains its parent buffer reference at call time,
  allowing it to be linked into the correct place in the parent command-buffer
  tree when the macro is invoked

There should be no caller path that depends on late parent-composition linking.

## Distinction From `__waited__`

`__caller__` and `__waited__` both use timing-only commands, but they are not the
same mechanism.

`__caller__`:

- macro/caller only
- tracks caller invocation buffer emission completion
- lets the all-callers buffer finish safely

`__waited__`:

- sequential/bounded loop only
- defines iteration completion
- gates the next sequential iteration or frees a bounded-concurrency slot

Do not merge these concepts.

## Regression Areas

Caller support should be considered broken if any of these regress:

- nested async callers
- nested caller error propagation
- imported macros used through caller composition
- sequential side effects inside caller bodies
- multiple caller invocations from one macro
- caller invocations reached through loops or conditionals
- ordinary local/imported macros that do not use caller
- unrelated inheritance or component composition
