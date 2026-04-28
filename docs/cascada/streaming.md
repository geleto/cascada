# Streaming

This document details a future, not yet implemented feature of Cascada.

## Overview

Cascada supports streaming in two directions:

- **Consuming** — JavaScript async iterables used as loop sources
- **Producing** — the `stream` channel type for emitting ordered sequences of values

The `stream` channel type sits alongside `data` `text` and `sequence` as a first-class channel.

---

## Consuming Async Iterables

Any JavaScript async iterable can be passed through the script context and used as a loop source:

```javascript
data result

for item in source
  result.items.push(process(item))
endfor

return result.snapshot()
```

The loop reads the iterable as values become available. As with other Cascada loops, independent loop iterations may run concurrently, while channel writes are assembled in deterministic source order.

Use `each` when the loop body must execute sequentially:

```javascript
text body

each chunk in source
  body(chunk)
endeach

return body.snapshot()
```

### Loop Metadata for Streaming Inputs

Streaming sources may not know their full length up front. Avoid relying on `loop.length`, `loop.revindex`, or `loop.last` for async iterables unless the source has already been materialized into an array.

Stable forward indexes such as `loop.index` and `loop.index0` are the reliable loop metadata for streaming inputs.

---

## `stream` Channel Type

The `stream` channel type holds an ordered sequence of values. Like `data` and `text`, a stream channel is declared explicitly and is write-only until snapshotted.

### Declaring and Writing

```javascript
stream results

results(1)
results(2, 3)
results(...items)
```

- `results(value)` emits a single value
- `results(v1, v2, ...)` emits multiple values in order
- Arrays expand **only when spread**

### Snapshot

```javascript
var arr = results.snapshot()
```

Returns all emitted values as an array, assembled in source order. This is the standard way to materialize a stream, consistent with `data.snapshot()` and `text.snapshot()`.

```javascript
stream results

for row in readRows()
  results(transform(row))
endfor

return results.snapshot()
```

This gives deterministic, source-ordered results even when `readRows()` yields asynchronously and `transform(row)` resolves out of order.

---

## Stream Semantics

All streams follow these rules:

- **Source-order visibility** — stream reads see only values emitted by source code at or before the read location. Values emitted later in the script are never visible at earlier read points.
- **Chronological freedom** — earlier source code may execute later in real time; reads wait automatically for their visible items to become available.
- **Deterministic behavior** — output behaves exactly as if processing were done sequentially.
- **Append-only** — stream contents cannot be modified or reordered.
- **No mutation during iteration** — a stream must not be written to while it is being iterated (compile-time error).

**Definition (source order):** The order that would result from executing the script sequentially, top to bottom, including all nested scopes and loop iterations. Streams behave as if values were appended in that sequential order, even when work runs concurrently.

### Poisoned Items

Streams may contain poisoned values as items. Reading or iterating a stream does not throw because an item is poisoned; the yielded element is itself a poisoned value, following the same semantics as yielding poison from async iterators.

---

## Iteration

Direct iteration traverses stream items in deterministic source order. Iteration sees only items visible at the iteration statement's position in the script, waiting as needed for those items to become available.

```javascript
stream results

results(1)
results(2)

for x of results
  body(x)
endfor

results(3)
```

The loop iterates over `[1, 2]`. The value `3` is emitted after the iteration statement in source order and is therefore not visible to the loop.

**Concurrency note:** The loop body is not executed sequentially. Each item is processed as soon as it becomes available, and different iterations may run concurrently. Despite this, the observable results are equivalent to sequential execution: iteration order, visibility, and final output remain deterministic.

> **Restriction (compile-time error):** A stream must not be written to while it is being iterated.

### Correct Pattern

```javascript
stream source
stream output

source(1, 2, 3)

for item of source
  output(item * 10)  // ✅ write to a different stream
endfor
```

### Loop Metadata

During iteration the `loop` object provides:

- `loop.index` — current iteration (1-indexed)
- `loop.index0` — current iteration (0-indexed)

Avoid `loop.revindex`, `loop.revindex0`, `loop.length`, and `loop.last` when iterating streams whose total length is not yet known.

---

## Helpers

### `toArray()`

```javascript
var items = results.toArray()
```

Returns all items visible at the read point as an array. Equivalent to `results.snapshot()`.

---

## Guard Semantics

Streams fully participate in Cascada's transactional recovery model.

When a stream is written to inside a `guard`, all emissions made within that guard are provisional. If the guard finishes poisoned and enters recovery:

- All stream items emitted inside the guard are discarded
- The stream is restored to its state before the guard began
- No partially emitted or failed items become visible

```javascript
stream results

results(0)

guard results
  results(1)
  results(2)
  fail("error")
endguard

results(3)
```

After recovery, `results` contains only `[0, 3]`.

**Key properties:**

- Recovery is **atomic**: either all emissions inside the guard apply, or none do
- Source-order visibility is preserved across guard boundaries
- Streams are never left in a partially written state
