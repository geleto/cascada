# Sequential and Concurrency-Limited Loop `__waited__` Channel

## Overview

Sequential loops (`while`, `each`) and concurrency-limited loops (`for ... of N`) use a per-iteration `__waited__` channel to define when an iteration is complete.

`__waited__` is loop-specific infrastructure. It is not a general async-boundary mechanism for macros, includes, callers, or other template/script scopes.

An iteration is complete only when:

1. its async body has finished enqueueing commands,
2. its child command buffer has been marked finished, and
3. the buffer iterator has fully applied the commands in that iteration's `__waited__` channel.

This gives the runtime one authoritative completion signal for:

- gating the next sequential iteration,
- releasing a bounded-concurrency slot,
- preserving source-order output application even when iteration work is async.

## Core Model

Each sequential or concurrency-limited async iteration runs inside an `asyncBlock(...)` that creates a child command buffer. That child buffer owns the iteration's `__waited__` channel.

The compiler emits the iteration body so that it:

1. executes the body and enqueues all normal output commands,
2. explicitly calls `childBuffer.markFinishedAndPatchLinks()`,
3. reads `childBuffer.getChannel(waitedChannelName).finalSnapshot()`,
4. returns that snapshot promise, or awaits it before returning a control-flow result.

The loop runtime then awaits the `asyncBlock(...)` result directly.

In other words, loop coordination no longer waits on deferred outer promises or special sentinels. It waits on the iteration child buffer's waited-channel completion.

Outside sequential/bounded loop coordination, this mechanism is not used. Other async boundaries return ordinary values or promises, and parents only await them when they actually consume those values.

## Why `markFinishedAndPatchLinks()` Comes First

`finalSnapshot()` resolves only after the parent buffer iterator descends into the child buffer and fully processes the requested channel.

That descent cannot begin until the child buffer is marked finished.

If the iteration waited for `finalSnapshot()` before marking the child buffer finished, the system would deadlock:

- the snapshot would wait for the iterator,
- the iterator would wait for the child buffer to be marked finished.

Calling `markFinishedAndPatchLinks()` before `finalSnapshot()` breaks that cycle. The parent iterator can descend immediately, and the `__waited__` channel can complete.

`asyncBlock` cleanup still calls `markFinishedAndPatchLinks()` in `finally`. That second call is safe and idempotent; it is not the mechanism that defines iteration completion.

## `finalSnapshot()` as the Iteration Completion Signal

`Channel.finalSnapshot()` resolves after the channel's completion promise resolves, meaning after the buffer iterator has fully applied the channel's commands. If the channel is already complete, it resolves immediately with the current value.

For waited loops, this is the authoritative definition of "iteration finished":

- not "the async function returned",
- not "the commands were enqueued",
- not "some deferred loop promise resolved".

The iteration is done when the `__waited__` channel is done.

This should not be generalized into "every async template boundary uses `finalSnapshot()` plus `__waited__`." The authoritative rule is narrower:

- loop iteration completion is defined by the iteration's `__waited__` channel,
- text-producing boundaries may return promises derived from text-channel snapshots,
- those promises only become part of `__waited__` when a waited loop needs them as one iteration-completion unit.

## While Loops

For async `while` loops, the iteration body also performs the condition check.

Behavior:

- If the condition is false, the body returns `false` immediately.
- If the condition is true, the body runs, marks the child buffer finished, awaits the waited-channel `finalSnapshot()`, then returns `true`.

The sequential loop runtime breaks on `result === false`.

So for async `while` loops:

- `false` means "stop iterating",
- `true` means "this iteration completed and the loop may continue".

There is no separate `STOP_WHILE` sentinel.

## WaitResolveCommand (`WRC`) Rules

The `__waited__` channel is populated with `WaitResolveCommand` entries. These commands are bookkeeping only: they track completion timing and must not change output semantics.

The high-level rule is:

- root expressions inside waited-loop-owned bodies add WRCs,
- composition boundaries add WRCs,
- control-flow inputs do not.
- async control-flow blocks inside waited-loop-owned bodies contribute one parent-visible waited unit and may also own child-local waited tracking.

## Root Expression Rule

Root-expression WRC emission is centralized in `compileExpression(...)`.

`compileExpression(...)` is the statement/root-expression wrapper. In waited scope it:

1. compiles the root expression,
2. captures its single result value,
3. emits one `WaitResolveCommand` for that root result,
4. returns the same result value unchanged.

`_compileExpression(...)` is the recursive low-level expression compiler and does not emit WRCs on its own.

This means:

- a statement root contributes one WRC,
- subexpressions do not contribute additional WRCs,
- aggregate expressions contribute one WRC for the aggregate result, not one per child.

## What Adds WRCs

### Included

The following add WRCs when compiled inside a waited-loop-owned scope:

- template output roots
- `set` roots
- `do` roots
- script `var` roots
- `return` roots
- async var-channel initializer roots

If a template-mode boundary returns rendered text as a promise derived from its own text-channel snapshot, that returned promise may also be added to the parent iteration's `__waited__` as one waited unit. This is how waited loops account for text-producing child boundaries without turning `__waited__` into a general-purpose mechanism outside loops.

Composition operations also add waited completion units:

- `include`
- `import`
- `from import`
- block invocation / composed block rendering
- `super()`

For composition, the WRC represents the completion of the composition boundary, not the individual internal expressions used to implement it.

### Excluded

The following are excluded from waited-root tracking:

- `if` / `elif` / `while` / `for` condition expressions
- loop source expressions
- `concurrentLimit` expressions
- other scheduler/control inputs

These expressions are awaited inline because they determine control flow, but they do not define iteration completion.

This exclusion applies to the control expressions themselves.

It does not mean async control-flow blocks are invisible to waited-loop completion. When an async `if` / `elif` / `switch` appears inside a waited-loop-owned body, the control-flow block contributes a waited completion unit as a block.

## Async Control-Flow Inside Waited Loops

Async control-flow blocks inside sequential or bounded loop iterations need stricter handling than ordinary root expressions.

The implemented model is:

1. the async control-flow block gets its own child buffer,
2. in waited-loop scope that child buffer also gets its own child-local waited channel,
3. branch-local root expressions write WRCs into that child-local waited channel,
4. the parent iteration sees the whole control-flow block as one waited unit by waiting on the control-flow block's child waited-channel `finalSnapshot()`.

This avoids two failure modes:

- finishing the parent iteration too early, before async branch work has actually completed
- trying to add parent-level waited markers from branch code after the parent iteration buffer is already finishing

So the rule is:

- control-flow conditions themselves are excluded from waited-root tracking
- async control-flow blocks are still tracked as waited work
- inside waited-loop scope, they are tracked through their own child waited channel, not by flattening child buffers into the parent `__waited__` lane

## Nested Loops

### Nested Unlimited Loops

Nested unrestricted loops do not own their own `__waited__` channel. Their body roots and composition boundaries propagate upward into the enclosing waited scope.

So if a sequential or bounded loop contains an unrestricted nested loop, async work inside the nested loop still contributes to the parent iteration's `__waited__` completion.

### Nested Sequential or Limited Loops

Nested sequential loops and nested concurrency-limited loops own their own `__waited__` channel.

That means:

- their internal body roots write WRCs to their own waited channel,
- the parent waited scope sees the nested loop as one completion unit,
- per-expression WRCs from the nested loop do not leak upward.

## Composition Boundaries

Composition inside waited loops is tracked as boundary completion, not as ordinary expression roots.

Important cases:

- `include` waits for the included template render/output completion
- `import` waits for imported exported values to resolve
- `from import` waits for imported exported values to resolve
- block invocation and `super()` wait for composed block text completion

Template/script lookup expressions used to identify the composition target are root expressions structurally, but they are excluded from waited-root tracking. The composition boundary itself is the waited unit.

Outside waited loops, these composition boundaries still return ordinary values or promises. Their parents do not eagerly await them just to keep command emission alive; they are awaited only when their values are consumed.

## Text-Producing Boundaries Outside Waited Loops

Template-mode boundaries such as macros, `caller()`-driven text, includes, and similar composed text helpers may return promises derived from a text channel snapshot.

The important distinction is:

- returning a promise of final text is normal,
- using `__waited__` to track that promise is only for waited-loop iteration ownership.

So outside sequential/bounded loop coordination:

- no `__waited__` channel is created for these boundaries,
- parents do not do extra waiting just because a child returned promised text,
- command/buffer structure is registered immediately,
- the promised text is awaited later only if some consumer actually needs the value.

This keeps `__waited__` limited to loop coordination while still allowing text-producing boundaries to expose a structurally-correct final value.

## Command Buffer Shape

The waited channel must stay flat.

It tracks local `WaitResolveCommand` leaves and must not contain child buffers.

Nested control-flow buffers are applied through their own channels and iterators. The `__waited__` iterator remains in the current iteration buffer and processes waited commands in source order.

When async control-flow appears inside waited-loop scope, the child control-flow buffer therefore cannot be linked directly into the parent iteration waited lane. Instead, the child control-flow buffer owns its own waited channel, and the parent iteration tracks that child as one waited unit.

## Runtime Cleanup Contract

`AsyncState.asyncBlock(...)` always finalizes the child buffer in cleanup by calling `markFinishedAndPatchLinks()`, even on error. This guarantees parent output chaining can continue.

But cleanup does not define loop completion.

Loop completion is defined by the promise returned from the compiled iteration body:

- for sequential and bounded loops, that promise is driven by waited-channel completion,
- for async `while`, the promise resolves to `false` or `true` after the waited-channel rules above are satisfied.

For non-loop async boundaries, cleanup still finalizes child buffers, but there is no loop-style waited channel to await. Those boundaries simply return values or promises to their caller.

## Error and Poison Behavior

WRCs are timing-only bookkeeping. They do not change functional error propagation semantics.

Errors still propagate through the normal poison/output mechanisms:

- body root failures poison the appropriate outputs,
- composition-boundary failures poison the surrounding waited iteration,
- while-condition failures poison affected outputs and terminate that control-flow path according to normal error handling.

Because the loop iterator awaits the iteration's waited completion signal, poison/error paths still participate in correct gating and ordered output application.

## Practical Reference

When reading or changing this implementation, the main architectural rules are:

1. Sequential and bounded async loop iterations complete via `childBuffer.getChannel(waitedChannelName).finalSnapshot()`.
2. `childBuffer.markFinishedAndPatchLinks()` must happen before `finalSnapshot()`.
3. `__waited__` is loop-only infrastructure, not a general async-boundary mechanism.
4. `compileExpression(...)` is the only place ordinary root expressions should emit waited WRCs.
5. Conditions, loop sources, and scheduling expressions are explicit opt-outs from waited-root tracking.
6. Async control-flow blocks inside waited-loop scope own a child-local waited channel and contribute one parent waited unit.
7. Nested sequential/bounded loops own their own waited channel; nested unrestricted loops propagate upward.
8. Composition boundaries contribute waited completion as boundary units.
9. Text-producing boundaries may return promises derived from text snapshots, but those promises enter `__waited__` only when a waited loop owns them.
