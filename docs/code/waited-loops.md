# Sequential and Bounded Loop `__waited__` Channel

Sequential loops (`while`, `each`) and bounded-concurrency loops
(`for ... of N`) use a per-iteration `__waited__` channel to define when an
iteration is complete.

`__waited__` is loop-specific infrastructure. It is not a general async-boundary
mechanism for macros, includes, callers, or other template/script scopes.

## Completion Rule

A waited-loop iteration is complete only after:

1. the iteration body has finished enqueueing commands,
2. the iteration child buffer has been marked finished, and
3. the buffer iterator has fully applied that iteration's `__waited__` channel.

This gives the runtime one authoritative signal for:

- starting the next sequential iteration,
- releasing a bounded-concurrency slot,
- preserving ordered output application when iteration work is async.

## Current Runtime Shape

Async waited-loop bodies execute through explicit control-flow/boundary helpers.

The key runtime primitive for waited control flow is:

- `runtime.runWaitedControlFlowBoundary(parentBuffer, usedChannels, context, cb,
  asyncFn, waitedChannelName)`

That helper:

1. creates a child buffer linked to the requested parent channels,
2. declares the child-local waited channel,
3. runs the async body,
4. marks the child buffer finished,
5. awaits `childBuffer.getChannel(waitedChannelName).finalSnapshot()`.

The mark-before-snapshot order is essential. The parent iterator cannot descend
into the child buffer until it is marked finished, and the waited-channel
snapshot cannot complete until the iterator has applied that channel. If
`finalSnapshot()` were called before `finish()`, the system
would deadlock: the snapshot waits for the iterator to apply the waited channel,
the iterator waits for the child buffer to be marked finished, and the child
buffer never gets marked finished because the iteration body is still waiting on
the snapshot.

## Iteration Bodies

For sequential and bounded loops, the compiler emits an iteration body that
uses a child buffer as the active `currentBuffer`.

At the end of an async iteration body, generated code marks the child buffer
finished and awaits the child waited-channel `finalSnapshot()`. For async
`while`, the body returns:

- `false` when the condition is false and the loop should stop
- `true` after a successful iteration has completed through the waited channel

There is no separate stop sentinel.

## WaitResolveCommand Rules

The `__waited__` channel is populated with `WaitResolveCommand` (WRC) entries.
These commands are timing-only bookkeeping. They do not mutate user-visible
output.

The high-level rule is:

- root expressions inside waited-loop-owned bodies add waited commands
- composition boundaries add one waited unit for the boundary
- scheduler/control inputs do not add waited commands
- async control-flow blocks inside waited-loop-owned bodies contribute one
  parent-visible waited unit and may own child-local waited tracking

## Root Expression Rule

Root-expression waited emission is centralized in expression compilation.

In a waited scope, a root expression:

1. compiles normally,
2. captures its result value,
3. emits one `WaitResolveCommand` for that result into the owning waited
   channel,
4. returns the same value unchanged.

Recursive subexpressions do not emit their own waited commands. Aggregate roots
emit one waited command for the aggregate value, not one per element.

`compileExpression(...)` in `src/compiler/compiler-base-async.js` is the sole
place where ordinary root expressions emit waited commands. Subexpressions and
the lower-level `_compileExpression` do not emit their own waited commands.

## Included Work

These roots/boundaries add waited units when compiled inside a waited-loop-owned
scope:

- template output roots
- `set` roots
- `do` roots
- script `var` roots
- `return` roots
- async channel initializer roots
- include/import/from-import boundaries
- block invocation and `super()` boundaries
- text-producing composition boundaries whose text promise defines one
  iteration-level unit

For composition, the waited command represents boundary completion, not every
internal expression used by that boundary.

## Excluded Work

These are awaited or consumed by their owning control path, but do not add
ordinary root waited commands:

- `if` / `elif` / `while` / `for` condition expressions
- loop source expressions
- concurrency-limit expressions
- other scheduler/control inputs

This exclusion applies to the control expression itself. If an async
control-flow block appears inside a waited-loop body, the block still
contributes one waited unit through its own child boundary.

## Async Control Flow Inside Waited Loops

Async `if`, `switch`, and similar control-flow blocks inside waited loops use a
child-local waited channel.

The implemented model is:

1. reserve a child control-flow buffer synchronously,
2. declare a waited channel local to that child buffer,
3. compile branch roots so their waited commands go to the child-local waited
   channel,
4. add one parent waited command for the whole control-flow boundary.

This avoids:

- finishing the parent iteration before branch work completes
- adding parent-level waited commands after the parent iteration buffer is
  already closing

## Nested Loops

Nested unrestricted loops do not own a new waited channel. Their root work
propagates to the enclosing waited scope.

Nested sequential or bounded loops own their own waited channel. The parent
waited scope sees the nested loop as one completion unit; internal per-root
waited commands do not leak upward.

## Text-Producing Boundaries Outside Waited Loops

Text-producing boundaries may return promises derived from text-channel
snapshots. That is normal value behavior.

Those promises enter `__waited__` only when a waited loop owns the surrounding
iteration. Outside sequential/bounded loop coordination:

- no `__waited__` channel is created solely for text finalization
- parents do not eagerly wait for child text promises unless they consume them
- command/buffer structure still must be registered early

## Flat Waited Channel

The waited channel stays flat. It holds `WaitResolveCommand` leaves, not child
buffers.

Child buffers are linked through their real output/channel lanes. When a child
boundary must participate in iteration completion, the parent `__waited__`
channel receives one timing command for that boundary's completion promise.

## Error And Poison Behavior

Waited commands do not change error semantics.

Errors still flow through normal Cascada poison/output behavior:

- failed body roots poison affected channels
- failed loop sources or conditions poison the effects described by loop/control
  metadata
- failed composition boundaries poison the surrounding waited iteration through
  their ordinary value/command result

The loop runtime awaits waited completion so those errors still participate in
correct gating and source-order output application.

## Key Files

- `src/compiler/loop.js` - sequential/bounded loop lowering
- `src/compiler/buffer.js` - waited-channel state and waited command emission
- `src/compiler/boundaries.js` - waited control-flow boundary lowering
- `src/compiler/compiler-base-async.js` - root expression waited emission
- `src/runtime/async-boundaries.js` - waited boundary runtime helpers
- `src/runtime/channels/timing.js` - `WaitResolveCommand`
