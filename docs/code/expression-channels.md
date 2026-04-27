# Expression Channels

This document describes the current async expression model for expressions that
can enqueue command-buffer work while also producing a value.

## Core Rule

Expression compilation must preserve source-order command emission.

JavaScript evaluates function arguments left-to-right before the callee runs. As
long as command-emitting expression helpers enqueue their commands during that
synchronous evaluation, sibling expression effects enter the current
`CommandBuffer` in source order. The buffer iterator then owns actual execution
ordering.

The compiler must therefore avoid lowering command-emitting expression work into
a later `.then(...)` path that can start after the enclosing boundary has moved
on or finished.

## Command-Emitting Expressions

These expression forms can enqueue commands:

- sequential path reads and writes, such as `db!.query()` and `obj!.prop`
- `caller()` invocation paths
- sequence-channel calls and reads, such as `data.push(...)` and
  `data.snapshot()` (script mode only — `compileSpecialChannelFunCall` returns
  `false` in template mode, so these fall through to normal dynamic calls)
- channel/output observations that produce values through snapshot/error
  commands (script mode only, same guard as above)
- control-flow expressions whose selected branch may contain any of the above

For direct non-control-flow expressions, the helpers enqueue commands on the
current buffer immediately. Promise-valued arguments remain promise-valued until
the command is applied; command application is the consumer boundary.

## Structural Expression Boundaries

Some expressions do not know which command-emitting subexpression will run until
after a value is consumed. These require a structural child buffer whose slot is
reserved before sibling operands continue.

Current structural expression cases include:

- async inline-if expressions when the selected branch mutates channels
- async `and` / `or` short-circuit expressions when the right-hand side can
  mutate channels
- ambiguous imported-callable calls, where a binding can dispatch to a macro or
  a normal function and the macro path may create command-buffer structure

These cases use explicit boundary helpers such as `runValueBoundary(...)` or
control-flow boundary lowering. The old generic expression wrapper machinery is
gone; do not reintroduce a broad wrapper to solve one ordering bug.

## Analysis Inputs

Expression boundary decisions use existing compile analysis:

- `node._analysis.usedChannels` decides which parent channels the boundary must
  link into
- `node._analysis.mutatedChannels` identifies command effects that make a
  value-dependent expression structurally significant
- locally declared channels are excluded from parent linking

The runtime should receive already-resolved linked channel names. It should not
infer lexical ownership or search parent buffers to compensate for missing
compiler analysis.

See also: `output-scoping.md` for how expression analysis (`mutatedChannels`)
drives buffer linking decisions.

## Value Consumption

Ordinary Cascada value consumers must use the marker-aware resolve helpers:

- `resolveSingle(...)`
- `resolveDuo(...)`
- `resolveAll(...)`

These helpers understand promises, poison, and marker-backed arrays/objects from
`runtime.createArray(...)` and `runtime.createObject(...)`.

Macro invocation is the important exception. Macro arguments stay promise- and
poison-transparent so the macro body can observe or handle them as Cascada
values.

## Command Arguments

Command arguments are not eagerly deep-resolved when commands are enqueued.

The current split is:

- true consumer commands resolve their top-level deferred values at apply time
- storage/timing commands keep raw deferred values when their semantics require
  staging
- marker-backed arrays and objects keep their `RESOLVE_MARKER` boundary; nested
  contents are resolved only when a real consumer observes them

This prevents both early materialization and late unhandled-promise noise.

## Important Invariants

Keep these invariants when changing expression compilation:

1. Command emission must happen in source order.
2. Command-emitting work must not start from a later `.then(...)` if a child
   buffer or observable command is needed.
3. Structural child buffers are reserved synchronously before later sibling
   operands emit commands.
4. Value-only async work should stay lightweight and should not allocate a child
   buffer.
5. Returned values are materialized through their true consumer boundary, not by
   waiting for unrelated top-level async work.
6. Arrays and objects with async elements must keep their marker-backed lazy
   resolution until consumed.
7. Macro arguments remain raw; ordinary function/filter/output consumers use
   resolve helpers.

## Regression Areas

The behavior is covered by focused regressions for:

- ternary / `and` / `or` expressions with command-emitting operands
- imported-callable shadowing and ambiguous imported macro calls
- direct and nested `caller()` expression paths
- call-block assignments where a macro pushes `caller(item)` into a returned
  channel/value
- explicit return ordering around guard commit/rollback
- async arrays/objects flowing through output, filters, and function arguments
- unused async variable assignments not delaying template/script completion
