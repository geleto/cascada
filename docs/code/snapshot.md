# Snapshot2: Iterator-Based Command Chain Construction

This document defines a simplified replacement for the current chain-construction logic.

## Scope

Covers:

- per-output iterator ownership
- event-driven chain construction
- parent/child buffer traversal semantics
- gap waiting and finish handling
- compatibility with existing `flattenBuffer` chain walk

Does not cover:

- repeated snapshot idempotency/caching (deferred)
- changes to flatten execution semantics

## Core Model

## Ownership

- There is one iterator per utput object.
- The iterator is stored on the output object (for example `output._iterator`).
- The iterator builds and updates the `next` chain for that output only.
- The iterator never traverses above its root buffer.

This replaces per-buffer per-handler chain progress maps.

## Root Binding

Output can exist before its root `CommandBuffer` is available.

- Output starts with no attached root buffer.
- Once root buffer exists, output attaches the iterator to that root for the output name.
- Existing chain endpoints on output (`_firstChainedCommand`, `_lastChainedCommand`) remain the single flatten entrypoints.

## Traversal State

Iterator state:

- `output`: owning output object
- `outputName`: handler name for this output
- `rootBuffer`: traversal boundary
- `stack`: array of frames `{ buffer, index }`
  - `index` is current position in that buffer for `outputName`
  - initial frame is `{ rootBuffer, -1 }`
- `finished`: iterator-level completion marker (root traversal complete)

Interpretation:

- `index = -1` means "entered buffer, no slot consumed yet".
- next candidate slot is `index + 1`.

## Buffer/Iterator Contract

Buffers notify iterator of lifecycle events for this output:

- `onSlotReserved(buffer, outputName, slot)`
  - Optional trigger. No immediate advance required unless this unblocks expected traversal checks.
- `onSlotFilled(buffer, outputName, slot, value)`
  - Primary trigger. Iterator attempts to advance from current state.
- `onBufferFinished(buffer)`
  - Trigger when buffer is marked finished.
- `onEnterBuffer(buffer)` / `onLeaveBuffer(buffer)`
  - Internal iterator hooks for bookkeeping only.

A buffer must notify only iterators for outputs it participates in.

## Main Traversal Rules

## Enter Rule

When iterator reaches a slot containing a child `CommandBuffer`:

1. Enter child immediately (push `{ child, -1 }`).
2. Do not process parent next slot until child is left.
3. Child is left only when child buffer is finished and no further reachable slots exist.

## Leave Rule

When current buffer is finished and iterator has no next allocated slot in that buffer:

1. If current buffer is root: mark iterator finished.
2. Else pop to parent and continue advancing in parent.

This includes empty buffers entered at `index = -1`.

## Gap Rule

Iterator only advances to `index + 1` when that slot is allocated/filled.

- Reserved/unfilled gap blocks progression.
- No skipping over missing slots.

## Chain Link Rule

Whenever iterator moves from command `A` to command `B`, it sets:

- `A.next = B`

And maintains output endpoints:

- if first command discovered: `output._firstChainedCommand = B`
- always update tail: `output._lastChainedCommand = B`

If next visited item is a child buffer, no link is created at that step; linking occurs when first command inside child is encountered.

## Advance Loop

After every event and after every buffer enter/leave transition, iterator runs:

1. Read current frame `{ buffer, index }`.
2. Inspect `nextIndex = index + 1` for this output array.
3. If next slot is not allocated/filled: stop (wait).
4. Move to `nextIndex`.
5. If entry is command:
   - link previous visited command to it
   - set as current visited command
   - continue loop
6. If entry is child buffer:
   - enter child at `-1`
   - continue loop from child context
7. If current buffer has no next slot and is finished:
   - leave to parent (or finish at root)
   - continue loop
8. Otherwise stop (waiting for future slot fill or finish)

This is the only progression path.

## Data Structures in CommandBuffer

`CommandBuffer` keeps storage/lifecycle responsibilities only:

- `arrays[outputName]` sparse entries (`Command` or child `CommandBuffer`)
- `finished`
- `parent` and per-output position metadata
- shared output registry as needed for lookup

Removed from buffer chaining model:

- `_lastChainedIndex`
- `_lastIndexIsChained`
- `_firstLocalChainedCommand`
- `_lastLocalChainedCommand`
- child chained notification methods tied to those fields

## Parent/Child Completion

No explicit "child fully chained" signaling is required.

Simplified behavior:

- Parent blocks naturally while iterator is inside child.
- Child completion is represented by `child.finished` and absence of next slot.
- On child completion, iterator pops and resumes parent automatically.

## Flatten Compatibility

`flattenBuffer(output)` stays chain-only and unchanged:

- starts at `output._firstChainedCommand`
- follows `next`
- applies all commands
- collects all errors

Iterator design guarantees chain is already built before/while flatten is invoked.

## Invariants

- Deterministic source order is preserved by slot order plus gap waiting.
- Parent cannot outpace child for child-buffer slots.
- Iterator never crosses above its root buffer.
- Empty finished buffers unwind correctly.
- Chain endpoints on output always represent current replay chain.

## Non-Goals (Current Phase)

- Snapshot caching / point-in-time immutability.
- Deduplication of already-applied commands across repeated snapshots.

These can be layered later without changing iterator traversal semantics.

## Migration Notes

1. Add iterator field to `Output` and bind it when output gets/changes root buffer.
2. Update `CommandBuffer.add/fillSlot/markFinished...` to notify iterator events.
3. Remove legacy incremental chain fields/methods.
4. Keep existing command classes and flatten logic unchanged.
5. Validate with current poison/output tests; add focused iterator tests for:
   - reserved gaps
   - empty child buffer finish at `-1`
   - nested child completion unwind
   - out-of-order async slot fills preserving deterministic chain
