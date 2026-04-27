# Output Scoping And Buffer Access

This document describes the current output/channel scoping model in async
Cascada.

## Ordering Contract

Cascada executes independent work concurrently, but output-visible effects must
match a valid sequential source-order run.

That contract is enforced by the command-buffer tree:

- commands are enqueued into the active `currentBuffer`
- async/control/composition boundaries reserve child-buffer slots early
- linked parent channels determine where a child buffer is visible
- the buffer iterator applies commands in source order and waits for unfinished
  child slots when it reaches them

Do not work around an ordering bug by reading from a producer/parent buffer
directly. If the current buffer cannot observe a value in source order, the bug
is missing linking, wrong `currentBuffer`, or missing explicit payload wiring.

## Frames And Buffers

Lexical frames and command buffers are separate concepts.

- not every frame owns a `CommandBuffer`
- many lexical scopes can emit into one active command stream
- the active stream is the compiler/runtime `currentBuffer` binding
- declarations, mutations, snapshots, and timing commands for a visible channel
  must be enqueued on the current buffer

Runtime channel lookup must not infer lexical ownership by climbing to a parent
producer buffer. The compiler's channel analysis decides what is visible and
which parent channels are linked into each child boundary.

## Channel Analysis

The current analysis vocabulary is:

- `declaredChannels` - channels declared by a scope/boundary
- `usedChannels` - channels a node may need to observe or touch
- `mutatedChannels` - channels a node may mutate or otherwise affect through
  command-emitting work

See also: `expression-channels.md` for how expressions contribute to channel
analysis through command-emitting expression forms.

These sets drive:

- child-buffer linking
- control-flow poisoning when a controlling value fails
- guard target resolution
- method/block/component channel metadata
- expression-boundary decisions

Observation commands count as channel use. Mutating commands count as use and
mutation.

## Buffer Creation

New command buffers are created for structural ownership, not merely because
some value is async.

Current buffer creation sites include:

- root render entry
- control-flow boundaries whose command structure depends on async values
- waited-loop iteration/control-flow boundaries
- macro/caller boundaries
- `include` and component composition boundaries (`include` uses
  `_compileAsyncControlFlowBoundary`; `import` and `from-import` are
  promise/value-based bindings and do NOT create `CommandBuffer` boundaries)
- block entry functions (each block is compiled as a separate callable entry
  with its own buffer scope; in template mode the block body uses a text
  boundary, not a general control-flow `CommandBuffer` child slot)
- capture/text boundaries that require isolated text collection

Pure value async work should remain a value or promise. It should not allocate a
child command buffer unless it can enqueue commands or affect visible structure.

## Linking

Child buffers link only the parent channels they need.

The compiler filters `usedChannels` through local declarations before emitting
linked channel lists. Locally declared channels are owned by the child boundary;
parent-visible channels are linked into the parent tree.

The `__waited__` loop timing channel is intentionally flat and is not linked as
a normal child channel. Waited-loop control-flow uses child-local waited
channels and contributes one parent waited unit instead.

## Observations

Observation commands are ordered commands:

- `snapshot()`
- raw snapshot reads
- `isError()`
- `getError()`
- guard-state capture/restore reads
- sequence/path reads

They must be added to the current buffer just like mutations. A snapshot is an
ordered source-position read, not a shortcut to the producer buffer's current
state.

## Poison And Guard Behavior

When an async control value fails, the compiler/runtime poisons the channels
that the skipped body could have affected.

Current implementation uses analysis-derived channel sets:

- `if` / `switch` gather branch `usedChannels` into `poisonChannels`
- loops pass body/else channel metadata into runtime loop options
- guards resolve selected channels and sequence paths from guard targets plus
  body analysis

Guard behavior remains separate from ordinary control-flow poisoning:

- guard targets decide what state is captured/reverted
- sequence targets use sequential-path guard commands
- output/channel guard state is captured and restored through ordered commands
- unrelated unguarded poison can still escape

Observation-only reads should not be treated as mutations, but they remain
ordered uses of the current buffer.

## Dynamic Targets

Channel declarations and ordinary channel operations are statically resolved by
the compiler/transpiler.

Runtime receives concrete channel names and command payloads. It should not
decide whether a source-level operation was a declaration, assignment,
observation, or parent-scope write. Those are compiler concerns.

## Invariants

Keep these invariants when changing output or buffer behavior:

1. Every command for an execution point is enqueued on the active
   `currentBuffer`.
2. A visible parent channel must be linked into a child boundary before child
   commands need it.
3. Snapshots and error reads are ordered observations, not direct state peeks.
4. Local declarations shadow parent channels through compiler analysis.
5. Runtime code must not repair missing visibility by falling back to parent or
   root producer buffers.
6. Guard state and control-flow poison use analysis metadata; they are not
   inferred from runtime buffer contents.
7. Template set-block/capture boundaries remain isolated text collection
   boundaries and must not be flattened into parent text output.

## Key Files

- `src/compiler/analysis.js` - channel declaration/use/mutation analysis
- `src/compiler/buffer.js` - command-buffer emission helpers
- `src/compiler/boundaries.js` - control/value/text boundary lowering
- `src/compiler/compiler-async.js` - async control-flow and guard compilation
- `src/compiler/loop.js` - loop boundary and waited-loop integration
- `src/runtime/command-buffer.js` - command-buffer tree and channel access
- `src/runtime/buffer-iterator.js` - source-order command application
- `src/runtime/channels/*` - channel command implementations
