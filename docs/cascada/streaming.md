# Streaming Channel Proposal

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

---

## JavaScript Stream Integration

The proposed integration lets native JavaScript consume Cascada streams as async iterables and produce unordered streams for Cascada to consume. The `indexed()`, `indexedPath()`, and `at()` APIs described here are not yet implemented or exported by the current package. Ordinary JavaScript async iterable inputs, described above, are already supported.

Chunk availability and source-order position are separate: a chunk may be ready before earlier chunks, while its position still determines where it belongs in the assembled result.

In the following consumption examples, `stream` is a live stream handle exposed to JavaScript. A `snapshot()` result is a materialized array, not a live stream.

### Ordered Iteration

```javascript
for await (const chunk of stream) {
  console.log(chunk);
}
```

Ordered iteration delivers chunks in source order. Each chunk is delivered once it and all preceding chunks are available; a slow earlier chunk can delay later chunks that are already ready.

### Unordered Iteration with Index

Unordered iteration delivers chunks as they become available, together with their source-order positions:

```javascript
for await (const { chunk, index } of stream.indexed()) {
  console.log({ chunk, index });
}
```

**Index semantics:**

- `index` is the chunk's zero-based position in the flattened, source-ordered stream
- When the position is already known, `index` is a `number`
- When nested concurrent regions leave preceding item counts unknown, `index` is a `Promise<number>`
- The promise resolves once enough preceding structure is known to determine the position

The consumer can process a chunk immediately and resolve its numeric index separately when needed. Awaiting an unresolved index inside the loop body delays consumption of subsequent chunks.

### Unordered Iteration with Index Path

For immediate hierarchical position information, use `indexedPath()`:

```javascript
for await (const { chunk, indexpath } of stream.indexedPath()) {
  console.log(`[${indexpath.join('.')}]: ${chunk}`);
}
```

**Index path semantics:**

- `indexpath` is an array of numbers representing hierarchical source position, such as `[1, 4, 7, 8]`
- Each number represents the position at that nesting level
- Paths are available at emission time, without waiting for preceding regions to finish or their total item counts to become known
- Paths are compared lexicographically by numeric elements; if one path is a prefix of another, the shorter path comes first

For example:

| Earlier path | Later path | Reason |
|---|---|---|
| `[1, 8, 9]` | `[2, 0]` | First differing element: `1 < 2` |
| `[1, 2, 5]` | `[1, 3, 0]` | First differing element: `2 < 3` |
| `[1, 2]` | `[1, 2, 0]` | The shorter path is a prefix |

This comparison is a stream ordering rule, not JavaScript's built-in `<` comparison between arrays. Paths let JavaScript position or preview chunks as they arrive without waiting for a flattened numeric index.

### Creating Unordered Streams from JavaScript

The proposed `at(chunk, index)` helper tags an emitted chunk with its logical position, allowing arrival order to differ from assembly order:

```javascript
async function* createUnorderedStream() {
  yield at("world", 1);
  yield at("Hello ", 0);
  // Logical order: "Hello ", "world"
}
```

The native integration would use these tags to assemble `"Hello world"`, despite receiving `"world"` first.

The index may also be a promise when the producer cannot yet determine the flattened position:

```javascript
async function* hierarchicalStream() {
  const index = determinePositionAsync(); // Promise<number>
  yield at("data", index);
}
```

**Rules:**

- `index` can be a `number` or `Promise<number>`
- Final order cannot be determined until the required index promises resolve
- Tagged chunks are assembled by their logical positions, regardless of arrival order
- Ordinary untagged async iterables retain yield order; Cascada cannot infer a different intended order from their values

For example, the proposed tagged-stream integration could be consumed into a text channel:

```javascript
text output

for chunk in createUnorderedStream()
  output(chunk)
endfor

return output.snapshot()
```

The intended result is `"Hello world"`. This requires the proposed position-aware integration; it is not the behavior of ordinary async iterable inputs in the current runtime.
