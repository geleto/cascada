# Accumulator Channels Proposal

Still implemented as a channel (for snapshotting), but commands between snapshots are merged, similar to how snapshot commands will be merged.

## Overview

Accumulators are a channel type for **order-independent reductions** — operations where the combining function is commutative and associative (sum, min, max, etc.). Because order doesn't matter, accumulators can accept values from parallel branches without synchronization overhead and without the deterministic-ordering machinery that ordered `data` and `text` channels require.

## Declaration

```
accum(reducer) name
accum(modifier reducer) name
accum(reducer, comparator) name
accum(modifier reducer, comparator) name
```

Examples:

```
accum(sum) total
accum(max) highScore
accum(any) hasErrors
accum(collect) allTags
accum(sorted) rankings          // shorthand for: accum(sorted collect)
accum(sorted union) uniqueNames
accum(sorted, byScore) leaders  // custom comparator
```

## Reducer Categories

### Scalar Reducers

Combine values into a single result. Cannot be modified with `sorted`.

| Reducer     | Identity     | Operation              | Accepts            |
|-------------|--------------|------------------------|--------------------|
| `sum`       | `0`          | `current + value`      | numbers            |
| `count`     | `0`          | `current + 1`          | (no argument)      |
| `min`       | `Infinity`   | `Math.min(cur, value)` | numbers            |
| `max`       | `-Infinity`  | `Math.max(cur, value)` | numbers            |
| `product`   | `1`          | `current * value`      | numbers            |
| `any`       | `false`      | `current \|\| value`   | any (truthy check) |
| `all`       | `true`       | `current && value`     | any (truthy check) |
| `avg`       | `undefined`  | running mean           | numbers            |

Notes:

- `avg` maintains internal sum and count; returns `sum/count` on snapshot. Returns `undefined` if no values fed.

### Collection Reducers

Gather values into a collection. Can be modified with `sorted`.

| Reducer     | Identity | Duplicates | Result type |
|-------------|----------|------------|-------------|
| `collect`   | `[]`     | allowed    | `Array`     |
| `union`     | `Set()`  | deduplicated by `===` | `Set` |

### Collection Modifier: `sorted`

`sorted` is a modifier that applies to collection reducers. It maintains insertion order using a comparator.

|                    | Duplicates allowed     | Unique only            |
|--------------------|------------------------|------------------------|
| **Unordered**      | `collect`              | `union`                |
| **Sorted**         | `sorted` / `sorted collect` | `sorted union`    |

`accum(sorted)` is shorthand for `accum(sorted collect)`.

`accum(sorted sum)` is a compile-time error — `sorted` only applies to collection reducers.

### Custom Comparator

The second argument to a sorted accumulator is a comparator — a **macro** or **context function** that compares two values:

```
macro byScoreDesc(a, b) : value
  return b.score - a.score
endmacro

accum(sorted, byScoreDesc) leaderboard
```

Or using a context function:

```javascript
// In context setup
env.addGlobal('byPrice', (a, b) => a.price - b.price);
```

```
accum(sorted, byPrice) catalog
accum(sorted union, byPrice) uniqueItems
```

Without a comparator, sorted accumulators use natural ordering (numeric ascending, string lexicographic).

## Feeding Values

Accumulators use the callable syntax:

```
total(item.price)
highScore(player.score)
hasErrors(result.failed)
allTags(item.tags)
```

For `count`, no argument is needed (each call increments by 1):

```
hitCount()
```

## Reading Results

Use `snapshot()` for a point-in-stream value:

```
accum(sum) total
for item in items
  total(item.price)
endfor
return total.snapshot()
```

## Custom Reducers

User-defined reducers via the API:

```javascript
env.addAccumulatorType('bitOr', {
  identity: 0,
  reduce: (current, value) => current | value
});
```

Then in script:

```
accum(bitOr) flags
flags(FLAG_READ)
flags(FLAG_WRITE)
```

## Parallel Behavior

Accumulators are designed for concurrent feeding. Multiple parallel branches can call the accumulator simultaneously without coordination:

```
accum(sum) total
for item in items          // parallel loop
  var price = fetchPrice(item)
  total(price)             // safe from any branch, any order
endfor
```

No ordering guarantees exist between feeds from concurrent branches. The final result is the same regardless of execution order — this is the core invariant.

## Comparison with Ordered Channels

| Property             | `data` / `text` channels     | `accum`                     |
|----------------------|------------------------------|-----------------------------|
| Order matters        | Yes (source-order assembly)  | No (commutative)            |
| Parallel overhead    | Buffering + ordering         | Direct accumulation         |
| Snapshot consistency | Ordered up to snapshot point | All values fed so far       |
| Use case             | Structured results, text     | Reductions, aggregations    |

## Error / Poison Behavior

- Feeding a poisoned value into an accumulator **skips the feed** and records the error on the accumulator.
- `snapshot()` of a poisoned accumulator throws `PoisonError` containing all accumulated errors.
- An accumulator with zero successful feeds and at least one error is fully poisoned.
- An accumulator with some successful feeds and some errors: the result reflects only the successful feeds, but `snapshot()` still throws because errors must not be silently dropped.
