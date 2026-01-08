This document details a future, not yet implemented feature of Cascada

## Streaming

Cascada provides **streaming types** for producing ordered sequences of values or text under concurrent execution.

Unlike `@text` and `@data`, **streams support iteration and index access**.
Streams preserve **deterministic, source-order semantics** while allowing concurrent execution.

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
  Reads see only values emitted by source code at or before the read location.

* **Chronological freedom**
  Earlier source code may execute later in real time. Reads wait automatically.

* **Deterministic behavior**
  Streams behave exactly as if executed sequentially.

* **Append-only**
  Stream contents cannot be modified or reordered.

* **No mutation during iteration**
  A stream must not be written to while it is being iterated.

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

Returns a **snapshot array** of items currently visible in the stream, restricted to the range `[start, end)`.

* `slice()` **does not** return a stream.
* The snapshot is taken at the read point, respecting source-order visibility.
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

Returns the current known item count (non-blocking).

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

Returns the item or `none` if out of range.

---

### Iteration

Iteration traverses the items visible at the start of the loop, in deterministic source order.

<table>
<tr>
<th width="50%" valign="top">Output Stream</th>
<th width="50%" valign="top">Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
for item of @stream
  @text(item)
endfor
```

</td>
<td width="50%" valign="top">

```javascript
stream resuts = getResults()
for item of results
  @text(item)
endfor
```

</td>
</tr>
</table>

The loop processes each element in order, as if the stream were a regular sequence.

**Concurrency note:**
The loop body is **not executed sequentially**. Each element is processed **as soon as it becomes available**, and different iterations may run concurrently. Despite this, the **observable results are equivalent to sequential execution**: iteration order, visibility, and final output remain deterministic.

> **Restriction**
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

## `:textStream`/`@textStream` — Text Streams

Text streams represent incrementally produced text assembled into a final string.

Like item streams, text streams support iteration and index access.

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

---

### `slice(start, end?)` — Text Stream

Returns a **snapshot string** of text currently visible in the text stream, restricted to the range `[start, end)`.

* `slice()` **does not** return a text stream.
* Operates on the concatenated visible text.
* Equivalent to slicing the result of `toString()`.

#### Semantics

* `@textStream.slice(start, end?) → string`
* Does **not** affect the text stream.
* Snapshot is taken at the read point.
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

Iteration traverses the emitted text chunks visible at the start of the loop, in deterministic source order.

<table>
<tr>
<th width="50%" valign="top">Output Text Stream</th>
<th width="50%" valign="top">Text Stream Variable</th>
</tr>
<tr>
<td width="50%" valign="top">

```javascript
for chunk of @textStream
  @text(chunk)
endfor
```

</td>
<td width="50%" valign="top">

```javascript
for chunk of output
  @text(chunk)
endfor
```

</td>
</tr>
</table>

The loop processes each text chunk as if the stream were a regular sequence.

**Concurrency note:**
The loop body is **not executed sequentially**. Each chunk is processed **as soon as it becomes available**, and different iterations may run concurrently. Despite this, the **observable results are equivalent to sequential execution**: iteration order, visibility, and final output remain deterministic.

> **Restriction**
> A stream must not be written to while it is being iterated.

---

## Stream Result Types

Macros, captures, and full scripts may declare a stream type as their result.

When a block returns `:stream` or `:textStream`, all values emitted using the corresponding output handler become part of the returned stream, ordered by source code position.

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

Streams fully participate in Cascada’s transactional recovery model.

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