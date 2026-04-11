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

## Core Insight: DFS Order Is Program Order

The calling buffer iterator processes commands in depth-first order — a total ordering that matches source-code (program) order. Because `apply()` is synchronous, every call command registers its ordering information before the iterator moves to the next command. There is no need to track explicit position metadata: DFS order of registration is program order.

---

## The Coordination Channel

Each namespace instance owns a coordination channel. Its `_target` is a promise map:

```
{ channelName: Promise<committed> }
```

Each entry resolves when the last committed write to that channel has been applied by the namespace buffer iterator. Initially all entries resolve immediately (no pending writes).

Channel metadata — `{ reads: Set<channelName>, writes: Set<channelName> }` — comes from single-file static analysis of each method body, embedded in the method object at compile time. It travels with the method at runtime; no multi-file analysis is needed at the call site.

---

## How `apply()` Works

When the calling iterator applies a namespace method call command:

**Step 1 — Capture deps (synchronous):**
For each channel in `reads` and `writes`, read `target[ch]` as a dependency promise. This captures the "last committed write before this call" for each relevant channel.

**Step 2 — Register write slots (synchronous, before returning):**
For each channel in `writes`, create a new deferred `done[ch]` and immediately set `target[ch] = done[ch].promise`. Any command applied after this (later in DFS order) that touches `ch` will find the new pending promise as its dependency.

**Step 3 — Fire and return:**
Launch an async operation and return from `apply()` immediately.

```
apply(target):
  deps = [target[ch] for ch in (reads ∪ writes)]
  done = {}
  for ch in writes:
    done[ch] = new Deferred
    target[ch] = done[ch].promise   // visible to all subsequent commands
  async:
    await Promise.all(deps)
    resolvedArgs = await resolve(this.args)
    childBuffer = this.method.execute(resolvedArgs)
    onLeaveBuffer(childBuffer):
      for ch in writes: done[ch].resolve()
```

---

## Write Committed Signal

Write-committed is signalled by `onLeaveBuffer` on the method's child buffer in the namespace: when the iterator finishes traversing that child buffer, every write command inside it has been applied. At that point the deferred `done[ch]` promises resolve, unblocking any downstream calls that were waiting for a consistent channel state.

**Why not `WaitResolveCommand`:** `WaitResolveCommand` signals at a specific command mid-buffer. Here the unit of completion is the entire child buffer — all of a method's write commands live inside one child buffer, and we need all of them applied before signalling committed.

**Why not `getFinishedPromise()`:** `getFinishedPromise()` on `CommandBuffer` resolves when the buffer is done *receiving* commands (scheduling complete), not when the iterator has *applied* them. `onLeaveBuffer` is the correct signal.

---

## Ordering Rules

**Write after write:** the second write's deps include the first write's `done[ch]` promise → it executes only after the first write is committed.

**Read after write:** the read's deps include the write's `done[ch]` promise → the read executes only after the write is committed.

**Write after read:** the write's deps include `target[ch]` at registration time. Since reads do not update `target[ch]`, the write sees the same predecessor promise as the read and the two may execute concurrently. For **fast-snapshot channels** (see below) this is correct because the read value is already captured; for non-fast-snapshot channels, write-after-read ordering is not enforced by this mechanism.

**Concurrent writes on disjoint channels:** calls whose `writes` sets have no overlap have independent `done` promises and run concurrently.

---

## Fast-Snapshot Reads

For channels whose current value can be captured synchronously — notably `var`, whose value lives directly on the namespace's `_target` — the value is read inside `apply()`, synchronously, in DFS order, before any subsequent command's `apply()` runs.

Consequences:
- No dependency promise is needed for a fast-snapshot read: the value is already in hand.
- Subsequent writes to the same channel are not blocked: the read is already complete.
- The correctness argument: because DFS order is program order, all commands registered before a write have already captured their `var` values before the write's `apply()` fires.

This matches the existing fast-snapshot optimization in the buffer iterator where such commands never enter `_pendingObservables` and do not delay subsequent mutable commands.

---

## Example

```
// Calling script
var x = slowOp()
ns.setCount(x)       // writes count — args async, registers synchronously at DFS position 1
ns.setLabel("ok")    // writes label — registers at DFS position 2
ns.render()          // reads count, label — registers at DFS position 3
```

Registration sequence (synchronous, DFS order):

1. `setCount` applied: deps = `[target.count]` (resolved); creates `done.count`; sets `target.count = done.count.promise`. Fires async: waits for `x` to resolve, executes `setCount`, resolves `done.count` when child buffer done.
2. `setLabel` applied: deps = `[target.label]` (resolved); creates `done.label`; sets `target.label = done.label.promise`. Fires async: args immediate, executes `setLabel`, resolves `done.label` when child buffer done.
3. `render` applied: deps = `[target.count, target.label]` = `[done.count.promise, done.label.promise]`. Fires async: waits for both to resolve, then executes `render`.

Execution:
- `setLabel` args resolve immediately → executes → `done.label` resolves
- `setCount` args resolve after `slowOp` → executes → `done.count` resolves
- `render` was waiting for both → now executes → reads consistent values of both channels

`setCount` and `setLabel` run concurrently (disjoint channels). `render` correctly sees both committed writes.

---

## Relationship to Existing Machinery

- The coordination channel uses the existing channel and `_target` infrastructure — no new iterator state is needed in the calling buffer.
- `onLeaveBuffer` on the namespace child buffer provides the write-committed signal; it fires when the namespace iterator finishes traversing the child buffer.
- The per-channel promise map is local to each namespace instance's coordination channel. It does not modify the calling buffer tree.
- The namespace buffer iterator continues to apply commands in its own DFS order. The coordination channel controls only *when* a method fires; the namespace iterator determines *how* its commands are applied.
- Channel metadata (`{ reads, writes }`) is derived from single-file static analysis and embedded in the method object — no call-site analysis required.
