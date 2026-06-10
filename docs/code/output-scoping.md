# Chain Scoping And Buffer Access

This document describes the current chain scoping model in async Cascada.

## Ordering Contract

Cascada executes independent work concurrently, but chain-visible effects must
match a valid sequential source-order run.

That contract is enforced by the command-buffer tree:

- commands are enqueued into the active `currentBuffer`
- async/control/composition boundaries reserve child-buffer slots early
- linked parent chains determine where a child buffer is visible
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
- declarations, mutations, snapshots, and timing commands for a visible chain
  must be enqueued on the current buffer

Runtime chain lookup must not infer lexical ownership by climbing to a parent
producer buffer. The compiler's chain analysis decides what is visible and
which parent chains are linked into each child boundary.

## Runtime-Name Renaming

Most lexical scopes do not need renamed runtime chain names. A duplicate local
name can keep its source name when it executes in a different `CommandBuffer`
or when the duplicated scopes are mutually exclusive control-flow paths.

The async transformer only renames user variables for a real same-buffer
collision. The current case is `guard` / `recover`: the guarded body and
recovery body execute in the same guard buffer, and recovery can run after the
guarded body has already declared local chains. If the recovery body declares a
name already declared in the guarded body, or if `recover err` collides with a
guard-body local named `err`, the recovery-side binding is renamed and all
recovery-scope uses are rewritten to that runtime name.

Do not add broad lexical duplicate-name renaming for cases such as `if` /
`else`, `switch` cases, loop bodies, set-block captures, or assigned call
blocks. Those either run in separate buffers, collect into their own boundary,
or are mutually exclusive at runtime.

## Chain Analysis

The current analysis vocabulary is:

- `declaredChains` - chains declared by a scope/boundary
- `usedChains` - chains a node may need to observe or touch
- `mutatedChains` - chains a node may mutate or otherwise affect through
  command-emitting work

See also: `expression-chains.md` for how expressions contribute to chain
analysis through command-emitting expression forms.

These sets drive:

- child-buffer linking
- control-flow poisoning when a controlling value fails
- guard target resolution
- method/block/component chain metadata
- expression-boundary decisions

Observation commands count as chain use. Mutating commands count as use and
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

Child buffers link only the parent chains they need.

The compiler filters `usedChains` through local declarations before emitting
linked chain lists. Locally declared chains are owned by the child boundary;
parent-visible chains are linked into the parent tree.

The `__waited__` loop timing chain is intentionally flat and is not linked as
a normal child chain. Waited-loop control-flow uses child-local waited
chains and contributes one parent waited unit instead.

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

When an async control value fails, the compiler/runtime poisons the chains
that the skipped body could have affected.

Current implementation uses analysis-derived chain sets:

- `if` / `switch` gather mutation-only skipped-region targets into branch poison handling
- loops pass mutation-only body/else poison targets into runtime loop options
- sequential loop return checks use a separate body observation set
- guards resolve selected chains and sequence paths from guard targets plus
  body analysis

Guard behavior remains separate from ordinary control-flow poisoning:

- guard targets decide what state is captured/reverted
- sequence targets use sequential-path guard commands
- output/chain guard state is captured and restored through ordered commands
- unrelated unguarded poison can still escape

Observation-only reads should not be treated as mutations, but they remain
ordered uses of the current buffer.

## Dynamic Targets

Chain declarations and ordinary chain operations are statically resolved by
the compiler/transpiler.

Runtime receives concrete chain names and command payloads. It should not
decide whether a source-level operation was a declaration, assignment,
observation, or parent-scope write. Those are compiler concerns.

## Invariants

Keep these invariants when changing output or buffer behavior:

1. Every command for an execution point is enqueued on the active
   `currentBuffer`.
2. A visible parent chain must be linked into a child boundary before child
   commands need it.
3. Snapshots and error reads are ordered observations, not direct state peeks.
4. Local declarations shadow parent chains through compiler analysis.
5. Runtime code must not repair missing visibility by falling back to parent or
   root producer buffers.
6. Guard state and control-flow poison use analysis metadata; they are not
   inferred from runtime buffer contents.
7. Template set-block/capture boundaries remain isolated text-chain collection
   boundaries and must not be flattened into parent text output.

## Key Files

- `src/compiler/analysis.js` - chain declaration/use/mutation analysis
- `src/compiler/buffer.js` - command-buffer emission helpers
- `src/compiler/async-boundaries.js` - control/value/text boundary lowering
- `src/compiler/compiler-async.js` - async control-flow and guard compilation
- `src/compiler/loop.js` - loop boundary and waited-loop integration
- `src/runtime/command-buffer.js` - command-buffer tree and chain access
- `src/runtime/buffer-iterator.js` - source-order command application
- `src/runtime/chains/*` - chain command implementations
