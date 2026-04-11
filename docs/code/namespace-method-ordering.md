# Namespace Method Call Ordering

## Problem

When a script uses a namespace import:

```
import "Component.script" as ns with { theme: "dark" }
```

methods on `ns` may be called from multiple places in the calling script, including concurrent async branches. Without ordering, two calls that both write `shared var count` race and produce incorrect results.

Using `!` (`ns!.method()`) prevents the race but is too coarse: it serializes all calls through the `ns` sequence key globally, blocking even calls that touch completely different channels.

The goal is **channel-level ordering**: calls that touch the same channel are sequenced; calls that touch only disjoint channels run concurrently.

---

## Core Insight: Iterator Position Encodes Program Order

When the calling script's buffer iterator applies a method-call command, it is at a specific position in the calling buffer tree. This position — the iterator's stack of `{ buffer, index }` pairs at that moment — encodes the call's place in the program order.

Because the buffer iterator is single-threaded and processes commands in depth-first order, any two call commands that the iterator applies have a well-defined total order: earlier DFS position = earlier in program order.

The problem arises because call arguments may be async. A call at position P_A (earlier in DFS) whose args take 1 second to resolve will have its method execute later than a call at position P_B > P_A with immediate args. The coordination mechanism must enforce program order on channel writes even when method executions arrive out of that order.

---

## Two-Phase Registration

Each call command operates in two phases:

### Phase 1: Command fires (synchronous)

When the calling iterator applies the call command at position P:

- The command immediately **registers** with the namespace coordination object, carrying:
  - **Position**: the iterator's current `{ buffer, index }` stack
  - **Channel metadata**: which channels this method reads and writes
  - **Level-finish promises**: for each buffer in the stack, a promise that resolves when that buffer finishes being traversed — signals that no more commands will fire from within it
  - **Execution slot promise**: a deferred promise the coordination object will resolve when this call's turn arrives
- The command-applied event is synchronous — registration happens before args start resolving

### Phase 2: Arguments resolve, method executes

- Once all arguments resolve, the method waits on the execution slot promise provided by the coordination object
- When the coordination object resolves that promise (the call's turn in channel order has arrived), the method executes
- After its writes are committed, it signals the coordination object, which advances the next waiting call

---

## The Coordination Object

Each namespace instance owns one coordination object. It is the "class that defers execution" — it receives registrations, maintains per-channel ordering state, and controls when each method actually runs.

```
CoordinationObject {
  perChannelQueue: Map<channelName, ChannelQueue>
}
```

On registration (phase 1), for each channel in the call's `writes`:

1. Get or create `perChannelQueue[channelName]`
2. Append a new entry: `{ position: P, executionSlot: Deferred, writeCommitted: Deferred }`
3. Chain: this entry's execution slot resolves only after the previous entry's `writeCommitted` has resolved

On registration for channels in `reads` (non-fast-snapshot):

1. Get or create `perChannelQueue[channelName]`
2. Append: `{ position: P, readCommitted: Deferred }`
3. Any subsequent write entry on this channel must wait for `readCommitted` before its execution slot opens
4. The entry's `readCommitted` resolves when the method's read of this channel completes

For fast-snapshot reads (e.g., `var`): no queue entry is created. The value is captured synchronously at execution time. Subsequent writes are not blocked.

---

## The Per-Channel Queue

For each channel, the queue is an ordered list of pending operations, ordered by position (DFS order of the calling buffer).

```
ChannelQueue for 'count':
  [
    { position: P1, type: write, executionSlot: Deferred, writeCommitted: Deferred },
    { position: P2, type: read,  readCommitted: Deferred },
    { position: P3, type: write, executionSlot: Deferred, writeCommitted: Deferred },
  ]
```

Chaining rules:

- **write after write**: `P3.executionSlot` resolves only when `P1.writeCommitted` resolves
- **write after read**: `P3.executionSlot` resolves only when `P2.readCommitted` resolves
- **read after write**: read execution waits for `P1.writeCommitted`
- **read after read**: multiple reads between the same two writes can run concurrently — no dependency between them

This gives correct read-write ordering with maximum concurrency between non-conflicting operations.

---

## Fast-Snapshot Reads

For channel types whose values can be captured synchronously (notably `var`, whose current value lives on `_target` and requires no buffer traversal):

- The read resolves at execution time without waiting for the iterator to apply anything
- No queue entry is created for that channel
- Subsequent writes to that channel are not blocked by this read

This mirrors the existing optimization in the command buffer iterator where fast-snapshot commands never enter `_pendingObservables` and do not delay subsequent mutable commands.

---

## Structural Completion vs Value Result

These are explicitly separate in this design:

- **Value result**: the method's return value — resolves when the return channel has a value. This may happen before all the method's write commands have been applied by the namespace buffer iterator.

- **Write committed**: each `writeCommitted` promise in the channel queue resolves when the specific write command is actually applied by the namespace buffer iterator — not when the method returns.

A subsequent call waiting for channel `count` to be in a consistent state waits for `writeCommitted`, not for the method's return value. This prevents the bug where a downstream call reads a stale value because the upstream method returned early (before its writes were applied).

The coordination object therefore needs to hook into the namespace buffer iterator's command-application event for each write, not just the method's return promise. The `getFinishedPromise()` mechanism on `CommandBuffer` (specified in `caller.md`) provides the buffer-level signal; per-write command promises provide the individual-command signal.

---

## Cleanup via Level-Finish Promises

Each registered call carries a level-finish promise for each buffer in its position stack. When buffer B finishes being traversed:

- No more calls will register with positions inside B
- All registrations from positions inside B have already occurred (phase 1 is synchronous)
- Queue entries from those positions can be garbage collected once their promises resolve

This bounds the size of the per-channel queues: entries accumulate only while the corresponding buffers are still active.

---

## Example

```
// Calling script
var x = slowOp()
ns.setCount(x)       // writes count — position (root, 3); x is async, method executes later

ns.setLabel("ok")    // writes label — position (root, 5); immediate args, method executes first

ns.render()          // reads count, label — position (root, 7)
```

Registration order at the coordination object (synchronous, DFS order):
1. `setCount` registers at position (root, 3): writes `count`; execution slot is immediately open (no prior write)
2. `setLabel` registers at position (root, 5): writes `label`; execution slot open (no conflict with `count`)
3. `render` registers at position (root, 7): reads `count`, `label`; waits for `setCount.writeCommitted` and `setLabel.writeCommitted`

Execution order:
- `setLabel` args resolve immediately → its execution slot is open → executes → `label.writeCommitted` resolves
- `setCount` args resolve (after `slowOp` finishes) → its execution slot was already open → executes → `count.writeCommitted` resolves
- `render` was waiting for both → now executes → reads consistent values of both channels

`setCount` and `setLabel` run concurrently (different channels). `render` correctly sees both writes.

---

## Relationship to Existing Machinery

- The position stack and level-finish promises come from the calling script's `BufferIterator`. No new iterator state is needed — the iterator already tracks this information.
- `getFinishedPromise()` on `CommandBuffer` (from `caller.md`) provides the buffer-level finish signal.
- The per-channel queue is a new runtime object, local to each namespace coordination object. It does not modify the calling buffer tree or the namespace buffer tree.
- The namespace's buffer iterator continues to apply commands in its own DFS order. The coordination object controls only WHEN a method fires; the namespace iterator determines HOW its commands are applied.
- Channel metadata (`{ reads: Set, writes: Set }`) is derived from single-file static analysis of each method body in the namespace script. It travels with the method object at runtime and requires no multi-file analysis at the call site.
