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

---

# Snapshot3: On-The-Fly Apply (Incremental Plan)

This section defines the next incremental step after iterator-based chaining.

## Goal

- Stop building/using a command `next` chain for execution.
- Apply commands as soon as iterator order allows.
- Keep current user-visible semantics unchanged.

## Core Execution Change

- Iterator progression becomes the execution driver.
- When iterator visits a command, it runs `command.apply(output)` immediately.
- Output stores accumulated command errors.
- Output exposes a single completion promise that resolves when root buffer execution is complete.
- `snapshot()` returns/awaits this completion promise and then:
  - throws `PoisonError` if accumulated errors exist
  - otherwise returns current output value (`getCurrentResult()` / sink snapshot result)

## Guard Temporary Strategy

- Entering a guard-owned `CommandBuffer` pauses iteration/execution.
- `CommandBuffer` has a pause refcount (not a boolean).
- Nested paused child buffers increment pause refcount on paused parent buffers.
- On guard completion, resume decrements refcount and iterator continues only when refcount reaches zero.
- Resume must be wired in `finally` paths to avoid deadlocks.

This is temporary. Future approach will snapshot/restore output targets for true guard rollback.

## Snapshot Semantics (Temporary Phase)

- `snapshot()` is completion-promise based by default.
- Temporary compatibility workaround is enabled:
  - if snapshot is requested before iterator/root completion, return current materialized value (and current accumulated errors) instead of waiting for finish.
  - this avoids circular waits in legacy/non-terminal snapshot usage paths.
- This workaround is transitional and will be removed once `SnapshotCommand` is implemented.
- Future phase will support mid-flow snapshots via explicit `SnapshotCommand` entries that resolve per-snapshot promises in deterministic order.

## Sink Semantics

- Sink commands execute immediately when iterator reaches them.
- `snapshot()` is the observation boundary for sink errors.
- Observed sink (`snapshot()` called): propagate accumulated errors.
- Unobserved sink (`snapshot()` not called): side effects still run, errors do not propagate.

This preserves current intended behavior where unused sink failures are non-fatal.

## `flattenBuffer` Compatibility

- `flattenBuffer(output)` becomes a compatibility wrapper:
  - returns/awaits output completion promise
  - performs final error throw / result read semantics only
- includes a sync-fast compatibility path when output is already fully completed.
- Chain-walk flattening logic is removed from `flattenBuffer`.

## Invariants To Preserve

- Deterministic command apply order remains source-order via slot order + gap waiting.
- "Never Miss Any Error": continue applying reachable commands and collect all errors before final throw at snapshot/completion boundary.
- Async slot fill order must not affect final deterministic output.

---

# Snapshot4: Command-Resolved Snapshots (Planned)

This section defines the next step that replaces the temporary completion-based snapshot behavior.

## Goal

- Make `snapshot()` an ordered command in the output stream.
- Allow mid-flow snapshots without waiting for root `CommandBuffer` completion.
- Keep iterator-driven apply semantics unchanged.

## Core Semantics

- `snapshot()` enqueues a `SnapshotCommand` into the same output handler stream.
- `snapshot()` immediately returns a promise tied to that command.
- The promise resolves/rejects when that specific command is applied by the iterator.
- Resolution does not wait for containing buffer/root finish.

This means snapshot timing is defined by command position, not by output completion.

## `SnapshotCommand`

- Added as a first-class command type.
- Carries a deferred result handle created at command construction.
- In `apply(output)`:
  - if output has accumulated errors up to this point, reject with `PoisonError`
  - else resolve with the output's current snapshot value
- Promise settlement happens exactly once, from `apply()`.

## Return Integration

- `return` uses normal expression evaluation.
- If return expression includes `x.snapshot()`, it receives that snapshot promise directly.
- `return` does not trigger special output finishing and does not require explicit snapshot waiting logic.
- Buffer finishing remains owned by normal block/root completion paths.

Current assumption for this phase:

- `return` is only used at end-of-function/end-of-scope flow (no early-return control flow changes in this phase).

## Copy Safety For Snapshot Values

Returned snapshot values must not be mutated by later internal commands.

- `data` / `text`: copy-on-write protection.
  - Snapshot returns a stable view.
  - Internal state is lazily cloned before the first post-snapshot mutation.
- `value`: no cloning required (replaced as scalar/reference by `ValueCommand`, not mutated in place by output commands).
- `sink`: sink object defines snapshot safety via its own `snapshot()` implementation.

## Buffer Finish Relationship

- `CommandBuffer.finished` still controls iterator lifecycle/completion signaling.
- Snapshot promise settlement is independent of `finished`.
- No dependency on `markFinishedAndPatchLinks()` for snapshot correctness.

## Error Boundary

- Snapshot observes errors accumulated up to its apply position.
- Errors from commands after the snapshot position do not retroactively affect that snapshot promise.

## Migration Notes

1. Add `SnapshotCommand` to runtime command set.
2. Extend output API `snapshot()` to enqueue `SnapshotCommand` and return its promise.
3. Add per-output copy-on-write helpers for snapshot-safe returned values (`data`/`text`).
4. Keep iterator traversal/apply flow unchanged; only add command handling.
5. Remove temporary "pre-finish snapshot returns current value" compatibility behavior once command-based snapshots are fully wired.
