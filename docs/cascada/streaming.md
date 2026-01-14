This document details a future, not yet implemented feature of Cascada

## Streaming

Cascada provides **streaming types** for producing ordered sequences of values or text under concurrent execution.

Unlike `@text` and `@data`, **streams support iteration and index access**.
Streams preserve **deterministic, source-order semantics** while allowing concurrent execution and out-of-order processing.

Streams are available as:

* **Output Streams** — written using output handlers (`@stream`, `@textStream`) and declared via result types (`:stream`, `:textStream`)
* **Stream Variables** — declared explicitly (`stream`, `textStream`)

> **Unified API**
> Output streams and stream variables expose the **same read operations and helpers**.

---

### Quick Examples

<table>
<tr>
<th width="50%" valign="top">Output Stream (@stream)</th>
<th width="50%" valign="top">Stream Variable (stream)</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@stream(1)
@stream(2, 3)

for x of @stream
  @text(x)
endfor
```

</td>
<td width="50%" valign="top">

```javascript
stream results

results(1)
results(2, 3)

for x of results
  @text(x)
endfor
```

</td>
</tr>

<tr>
<th width="50%" valign="top">Output Text Stream (@textStream)</th>
<th width="50%" valign="top">Stream Variable (textStream)</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@textStream("Hello ")
@textStream("world")

@text(@textStream.toString())
```

</td>
<td width="50%" valign="top">

```javascript
textStream out

out("Hello ")
out("world")

@text(out.toString())
```

</td>
</tr>
</table>

---

### Stream Semantics

All streams in Cascada follow these rules:

* **Source-order visibility**
  Stream reads (including iteration, indexing, and helper methods) see only values emitted by source code at or before the read location. Values emitted later in the script are never visible at earlier read points.

  **Definition (source order):**
  Source order is defined as the order that would result from executing the script **sequentially, top to bottom**, including all nested scopes and loop iterations. Streams behave as if values were appended in that sequential order, even if work runs concurrently.

* **Chronological freedom**
  Earlier source code may execute later in real time. Reads wait automatically for their visible items to become available.

* **Deterministic behavior**
  Output from streams behave exactly as if processing was done sequentially.

* **Append-only**
  Stream contents cannot be modified or reordered.

* **Visibility lifetime**
  Stream items remain visible for the duration of the script. Once emitted, an item is visible to all reads that appear after it in source order.

* **No mutation during iteration (compile-time error)**
  A stream must not be written to while it is being iterated.

#### Poisoned items (Error Values)

Streams may contain **poisoned values** (Error Values) as items/chunks.

* Reading or iterating a stream **does not throw** because an item is poisoned.
* Instead, the yielded element/chunk is itself a poisoned value, following the same semantics as yielding poison from async iterators.

---

## `:stream`/`@stream` — Output Item Streams

Item streams are **output streams** representing ordered sequences of values.

The default output item stream is accessed via `@stream` and has result type `:stream`.

---

### Mental Model: Source-Order Visibility

When reading from a stream, think in terms of **where you are in the script**, not when code happens to run.
A stream read sees all values emitted by source code **above it**, and never values emitted **below it**—even if later code runs earlier due to concurrency. Cascada may execute work out of order for performance, but it always assembles stream values **as if the script were executed top to bottom**. This guarantees that iteration, indexing, and snapshots behave deterministically while still allowing full parallel execution.

---

### Writing to `@stream`

<table>
<tr>
<th width="50%" valign="top">Output Stream</th>
<th width="50%" valign="top">Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@stream(1)
@stream(2, 3)
@stream(...items)
```

</td>
<td width="50%" valign="top">

```javascript
stream results

results(1)
results(2, 3)
results(...items)
```

</td>
</tr>
</table>

Rules:

* `@stream(item)` emits a single item
* `@stream(...items)` emits multiple items
* Arrays expand **only when spread**

---

## Reading & Helpers (Items)

The following operations apply identically to `@stream` and `stream`.

All read operations respect source-order visibility: they see only items emitted at or before the read point in the script.

---

### `toArray()`

<table>
<tr>
<th width="50%" valign="top">Output Stream</th>
<th width="50%" valign="top">Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
var items = @stream.toArray()
```

</td>
<td width="50%" valign="top">

```javascript
var items = results.toArray()
```

</td>
</tr>
</table>

Returns all items visible at the read point (source-order bounded).

---

### `slice(start, end?)` — Stream

Returns an array of items currently visible in the stream, restricted to the range `[start, end)`.

* `slice()` **does not** return a stream.
* The result respects source-order visibility.
* Equivalent to slicing the result of `toArray()`.

#### Semantics

* `@stream.slice(start, end?) → Array`
* Does **not** affect the stream.
* Safe to call during concurrent writes.
* `@stream.toArray()` is equivalent to `@stream.slice(0, @stream.length)`.

#### Examples

<table>
<tr>
<th width="50%" valign="top">Output Stream (@stream)</th>
<th width="50%" valign="top">Stream Variable (stream)</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@stream(1)
@stream(2)
@stream(3)

var a = @stream.slice(0, 2)
// a === [1, 2]
```

</td>
<td width="50%" valign="top">

```javascript
stream s

s.push(10)
s.push(20)
s.push(30)

var b = s.slice(1)
// b === [20, 30]
```

</td>
</tr>
</table>

---

### `length`

<table>
<tr>
<th width="50%" valign="top">Output Stream</th>
<th width="50%" valign="top">Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
var count = @stream.length
```

</td>
<td width="50%" valign="top">

```javascript
var count = results.length
```

</td>
</tr>
</table>

Returns the count of items visible at the read point (source-order bounded).

---

### Index Access

<table>
<tr>
<th width="50%" valign="top">Output Stream</th>
<th width="50%" valign="top">Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
var value = @stream[2]
```

</td>
<td width="50%" valign="top">

```javascript
var value = results[2]
```

</td>
</tr>
</table>

Returns the item at the specified index, or `none` if the index is beyond the visible range.

---

## Stream Initialization

Streams can be assigned at initialization from other streams or context object properties.

Assigned streams are read-only and stream all items from the source.

### From Another Stream

<table>
<tr>
<th width="50%" valign="top">Stream Variable Assignment</th>
<th width="50%" valign="top">Variable Assignment (Snapshot)</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
stream source
source(1, 2, 3)

stream dest = source
// dest is read-only
// streams continuously from source
// remains connected, but visibility
// respects source-order rules
```

</td>
<td width="50%" valign="top">

```javascript
stream source
source(1, 2, 3)

var snapshot = source
// snapshot captures items visible
// at assignment point
```

</td>
</tr>
</table>

### From Context Object

```javascript
stream results = context.stream
// read-only, continuous streaming
var results = context.stream
// identical behavior - read-only, continuous streaming
```

When initializing from the context object, `stream` and `var` behave identically - both create read-only streams that continuously reflect the source.
---

## Iteration

Direct iteration traverses stream items in deterministic source order.

Iteration sees only items visible at the iteration statement's position in the script, processing the items as they become available.

<table>
<tr>
<th width="50%" valign="top">Output Stream</th>
<th width="50%" valign="top">Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@stream(1)
@stream(2)

for x of @stream
  @text(x)
endfor

@stream(3)
```

</td>
<td width="50%" valign="top">

```javascript
stream results

results(1)
results(2)

for x of results
  @text(x)
endfor

results(3)
```

</td>
</tr>
</table>

In both examples, the loop iterates over `[1, 2]`. The value `3` is added after the iteration statement in source order and is therefore not visible to the loop.

**Concurrency note:**
The loop body is **not executed sequentially**. Each item is processed **as soon as it becomes available**, and different iterations may run concurrently. Despite this, the **observable results are equivalent to sequential execution**: iteration order, visibility, and final output remain deterministic.

> **Restriction (compile-time error)**
> A stream must not be written to while it is being iterated.

<table>
<tr>
<th width="50%" valign="top">Invalid (Mutation During Iteration)</th>
<th width="50%" valign="top">Correct Pattern</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@stream(1, 2, 3)

for item of @stream
  // ❌ DO NOT mutate the iterated stream
  @stream(item * 10)
endfor
```

</td>
<td width="50%" valign="top">

```javascript
@stream(1, 2, 3)

for item of @stream
  // ✅ OK: write to a different stream
  @text(item)
endfor
```

</td>
</tr>
</table>

---

## Loop Object Properties

During iteration, the `loop` object provides index-related properties:

* `loop.index`: the current iteration of the loop (1-indexed)
* `loop.index0`: the current iteration of the loop (0-indexed)
* `loop.revindex`: number of iterations from current position to the end of visible items (1-indexed)
* `loop.revindex0`: number of iterations from current position to the end of visible items (0-indexed)

### With Nested Concurrent Contexts

When iterating streams with nested concurrent contexts (e.g., parallel tasks each emitting independently), reading these properties **blocks until the position is determined**:

```javascript
for item of @stream
  var idx = loop.index  // blocks until source-order position is known
  var remaining = loop.revindex  // blocks until total count of visible items is determined
  @text("Item #{idx}: #{item}")
endfor
```

**Behavior:**
* `loop.index` and `loop.index0` block until the item's source-order position is resolved
* `loop.revindex` and `loop.revindex0` block until both the item's position and the total count of visible items are known
* "Visible items" means items visible at the iteration statement's source position
* This ensures deterministic results while allowing concurrent execution

---

## `:textStream`/`@textStream` — Output Text Streams

Text streams are **output streams** for text concatenation with chunk-level visibility.

The default output text stream is accessed via `@textStream` and has result type `:textStream`.

Text streams follow the same source-order visibility rules as item streams.

---

### Writing to `@textStream`

<table>
<tr>
<th width="50%" valign="top">Output Text Stream</th>
<th width="50%" valign="top">Text Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@textStream("Hello ")
@textStream("Cascada")
```

</td>
<td width="50%" valign="top">

```javascript
textStream output

output("Hello ")
output("Cascada")
```

</td>
</tr>
</table>

---

## Reading & Helpers (Text)

All read operations respect source-order visibility: they see only chunks emitted at or before the read point in the script.

---

### `toString()`

<table>
<tr>
<th width="50%" valign="top">Output Text Stream</th>
<th width="50%" valign="top">Text Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@text(@textStream.toString())
```

</td>
<td width="50%" valign="top">

```javascript
@text(output.toString())
```

</td>
</tr>
</table>

Returns the concatenation of all text chunks visible at the read point.

---

### `slice(start, end?)` — Text Stream

Returns a substring of text currently visible in the text stream, restricted to the range `[start, end)`.

* `slice()` **does not** return a text stream.
* Operates on the concatenated visible text.
* Equivalent to slicing the result of `toString()`.

#### Semantics

* `@textStream.slice(start, end?) → string`
* Does **not** affect the text stream.
* Respects source-order visibility.
* `@textStream.toString()` is equivalent to slicing the full visible text.

#### Examples

<table>
<tr>
<th width="50%" valign="top">Output Text Stream (@textStream)</th>
<th width="50%" valign="top">Text Stream Variable (textStream)</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@textStream("Hello")
@textStream(" World")

var t = @textStream.slice(0, 5)
// t === "Hello"
```

</td>
<td width="50%" valign="top">

```javascript
textStream ts

ts.push("Cascada")
ts.push(" Script")

var u = ts.slice(8)
// u === "Script"
```

</td>
</tr>
</table>

---

### Iteration (Text Chunks)

Direct iteration traverses text chunks in deterministic source order.

Iteration sees only chunks visible at the iteration statement's position in the script, waiting as needed for those chunks to become available.

<table>
<tr>
<th width="50%" valign="top">Output Text Stream</th>
<th width="50%" valign="top">Text Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
@textStream("Hello")
@textStream(" ")

for chunk of @textStream
  @text(chunk)
endfor

@textStream("World")
```

</td>
<td width="50%" valign="top">

```javascript
textStream output

output("Hello")
output(" ")

for chunk of output
  @text(chunk)
endfor

output("World")
```

</td>
</tr>
</table>

In both examples, the loop iterates over `["Hello", " "]`. The chunk `"World"` is added after the iteration statement in source order and is therefore not visible to the loop.

The loop processes each text chunk as if the stream were a regular sequence.

**Concurrency note:**
The loop body is **not executed sequentially**. Each chunk is processed **as soon as it becomes available**, and different iterations may run concurrently. Despite this, the **observable results are equivalent to sequential execution**: iteration order, visibility, and final output remain deterministic.

> **Restriction (compile-time error)**
> A stream must not be written to while it is being iterated.

---

## Stream Result Types

Macros, captures, and full scripts may declare a stream type as their result.

When a block returns `:stream` or `:textStream`, all values emitted using the corresponding output handler become part of the returned stream, ordered by source code position.

### Output restriction: no Error Values in returned streams

Returned output streams (`:stream`, `:textStream`) must not contain Error Values.

If any emitted item/chunk in a returned output stream is a poisoned value, the script throws (the render promise rejects). Iteration and reads can still observe poisoned items while running, but final output streams cannot contain them.

---

### Example

<table>
<tr>
<th width="50%" valign="top">Macro Returning :textStream</th>
<th width="50%" valign="top">Using the Result</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
macro generateText(): textStream
  @textStream("Hello ")
  @textStream("world")
endmacro
```

</td>
<td width="50%" valign="top">

```javascript
var out = generateText()
@text(out.toString())
```

</td>
</tr>
</table>

The same behavior applies when `:stream` or `:textStream` is used as the result type of a **capture** or a **full script**.

---

## `guard`-ing streams

Streams fully participate in Cascada's transactional recovery model.

When a stream is written to inside a `guard`, **all emissions made within that guard are provisional**.

If the guard finishes poisoned and enters `recover`:

* **All stream items emitted inside the guard are discarded**
* The stream is restored to its state **before the guard began**
* No partially emitted or failed items become visible

This applies uniformly to:

* Output streams (`@stream`, `@textStream`)
* Stream variables (`stream`, `textStream`)
* Streams returned from `:stream` / `:textStream` results

<table>
<tr>
<th width="50%" valign="top">Output Stream</th>
<th width="50%" valign="top">Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
guard
  @stream(1)
  @stream(2)
  fail("error")
endguard

@stream(3)
```

</td>
<td width="50%" valign="top">

```javascript
stream results

guard results
  results(1)
  results(2)
  fail("error")
endguard

results(3)
```

</td>
</tr>
</table>

### Key Properties

* Recovery is **atomic**: either all emissions inside the guard apply, or none do.
* Source-order visibility is preserved across guard boundaries.
* Streams are never left in a partially written state.

Conceptually, a `guard` creates a **temporary stream buffer** that is merged only if the guard succeeds.

---

## JavaScript Stream Integration

Cascada streams can be consumed in JavaScript as async iterables, and JavaScript can create unordered streams for Cascada to consume.

### Ordered Iteration

```javascript
for await (const chunk of result.textStream) {
  console.log(chunk)
}
```

Streams are iterated in source order, with each chunk delivered as it becomes available.

---

### Unordered Iteration with Index

When streams are written asynchronously, chunks may become available out of order. Unordered iteration allows processing chunks as soon as they arrive:

```javascript
for await (const { chunk, index } of result.textStream.indexed()) {
  console.log(`[${index}]: ${chunk}`)
}
```

**Index semantics:**

* When emissions occur sequentially in source code, `index` is a `number`
* When emissions occur through nested concurrent contexts (e.g., parallel tasks each emitting independently), `index` is a `Promise<number>`
* The index resolves once the chunk's source-order position is determined

**When to use:**

* Ordered iteration guarantees source-order delivery but may wait for slow chunks
* Unordered iteration processes chunks immediately as they arrive, useful for incremental display or streaming output

---

### Creating Unordered Streams from JavaScript

JavaScript code can create unordered streams for Cascada to consume using the `at()` function.

#### Basic Usage

```javascript
async function* createUnorderedStream() {
  yield at("world", 1)
  yield at("Hello ", 0)
  // Cascada reconstructs source order: "Hello world"
}
```

#### Index Types

<table>
<tr>
<th width="50%" valign="top">Sequential Emissions</th>
<th width="50%" valign="top">Nested Concurrent Emissions</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
async function* linearStream() {
  // Index is a number
  yield at("A", 0)
  yield at("B", 1)
  yield at("C", 2)
}
```

</td>
<td width="50%" valign="top">

```javascript
async function* hierarchicalStream() {
  // Index is a Promise<number>
  const idx = determinePositionAsync()
  yield at("data", idx)
}
```

</td>
</tr>
</table>

**Rules:**

* `index` can be a `number` or `Promise<number>`
* Cascada waits for all index promises to resolve before determining final order
* Chunks are assembled in source-order regardless of arrival order

#### Usage in Cascada

```javascript
textStream output = getInfoStream()
// Items are processed as they arrive, output assembled in source order
for chunk of output
  @text(chunk)
endfor
```
---