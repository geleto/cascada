# Chain Runtime Architecture

This document describes the current chain runtime. Older code and older docs
may call this layer "output"; the current language name is **chain**.

## Why This Exists

Cascada is concurrent by default, but chain-visible effects must still match a
correct sequential source-order execution. That guarantee comes from the
command-buffer tree:

- each async region enqueues commands into an ordered stream segment
- nested regions reserve child-buffer slots in that stream
- iterators apply commands in deterministic source order, waiting for reserved
  child slots when needed

Work may start and finish out of wall-clock order, but chain effects are
committed in program order.

## Scope

This document covers:

- chain types: `text`, `var`, `data`, and `sequence`
- `CommandBuffer` ownership and child-buffer linking
- chain observations: `snapshot`, `isError`, and `getError`
- guard snapshot/restore and sequence transaction behavior
- command application and poison propagation

## End-To-End Flow

1. The compiler emits command objects into the active `CommandBuffer`, keyed by
   chain name.
2. Async/control/composition boundaries receive an explicit `currentBuffer`.
3. Chain declarations call runtime helpers with the explicit target buffer.
4. Each chain owns a stream iterator over its effective command-buffer lane.
5. The iterator walks commands and child buffers in source order and applies
   commands to the chain target.
6. Command arguments are resolved at apply time, not at enqueue time.
7. Observation commands resolve at the stream point where they are enqueued.
8. Finished-buffer observations run through the registered chain path while
   still respecting chain completion.

## CommandBuffer

File: `src/runtime/command-buffer.js`

Important state:

- `parent`: parent buffer link for nested stream structure
- `arrays[chainName]`: per-chain stream entries
- `_chains`: chain registry for the buffer hierarchy
- `_pendingReservedSlots`, `_finishRequested`, `finished`
- `_visitingIterators`: iterators currently traversing a chain lane

Important behavior:

- child buffers are linked to parent lanes through explicit linked-chain lists
- `add(...)` appends commands to the current buffer lane
- `finish()` closes the buffer for further command insertion
  and releases waiting iterators
- observation helpers enqueue ordered read commands while the buffer is active
- post-finish observations run through the registered chain path

## BufferIterator

File: `src/runtime/buffer-iterator.js`

The iterator:

- walks one chain lane depth-first across nested child buffers
- advances only when the next slot is filled
- waits on gaps until slot-fill or buffer-finish notification
- applies command objects to the chain
- notifies the chain when the lane is complete

## Chain Model

Files: `src/runtime/chains/*.js`

Chains keep:

- `_target`: current materialized state
- `_buffer`: effective `CommandBuffer`
- `_iterator`: per-chain stream iterator
- `_stateVersion` and inspection cache for poison/error inspection
- completion promise state for `finalSnapshot()`

Core behavior:

- commands resolve their own arguments according to command semantics
- command failures become poison on the chain target when appropriate
- snapshot reads return the current target or throw `PoisonError`
- `isError` and `getError` inspect the current target state

Chain health is target-based. There is no separate historical error side
chain that defines health.

## Chain Types

- `text`: callable append model; snapshot/finalization materializes joined text
- `var`: replace model; default declaration target is `null`
- `data`: structured data assembly through data-chain commands such as
  `set`, `push`, and `merge`
- `sequence`: ordered command dispatch into an initialized object, with
  read/call commands and optional guard transaction hooks

## Commands

Mutating commands include:

- `TextCommand`
- `VarCommand`
- `DataCommand`
- `SequenceCallCommand`
- `TargetPoisonCommand`
- sequential-path write/repair commands

Observation/read commands include:

- `SnapshotCommand`
- `RawSnapshotCommand`
- `IsErrorCommand`
- `GetErrorCommand`
- `SequenceGetCommand`
- sequential-path read/repair commands
- guard-state capture/restore commands
- `WaitResolveCommand` timing commands

Command arguments are generally preserved at enqueue time and consumed at apply
time. This keeps promise, marker-backed aggregate, and poison semantics aligned
with the actual consumer boundary.

## Compiler Integration

Key files:

- `src/compiler/analysis.js`
- `src/compiler/buffer.js`
- `src/compiler/chain.js`
- `src/compiler/boundaries.js`
- `src/compiler/compiler-async.js`

Important analysis fields:

- `declaredChains`
- `usedChains`
- `mutatedChains`

The compiler uses these fields to:

- link parent-visible chains into child buffers
- determine control-flow poison chains
- validate chain declarations and observations
- emit ordered chain commands on the active `currentBuffer`
- keep local declarations separate from parent-visible chains

## Guard Integration

File: `src/runtime/guard.js`

Guards capture and restore selected state through ordered chain commands.

For ordinary chains:

- guard entry captures chain state
- guard failure restores captured state
- guard success keeps changes

For `sequence` chains:

- `begin()` may run on guard entry
- `commit(token?)` may run on success
- `rollback(token?)` may run on failure
- hook failures become guard errors

Sequential paths use their own path-chain read/write/repair commands.

## Invariants

1. Commands are always enqueued on the active `currentBuffer`.
2. Parent-visible chains must be linked into a child buffer before child work
   needs to observe or mutate them.
3. Snapshots and error reads are ordered observations, not direct producer-state
   peeks.
4. Runtime code should not repair missing visibility by reading a parent/root
   producer buffer.
5. Chain declarations do not implicitly create command buffers.
6. Value-only async work should remain promise/value work; command buffers are
   for command structure.

## Key Tests

- `tests/pasync/chains-explicit.js`
- `tests/pasync/chain-errors.js`
- `tests/pasync/snapshots.js`
- `tests/pasync/template-command-buffer.js`
- `tests/poison/guard.js`
