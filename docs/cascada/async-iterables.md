# Shared async iteration

Cascada automatically shares consumption of async iterables in script `for`,
`each`, and `of N` loops and async template loops.
The explicit `makeSharedIterable` helper supports both synchronous and async
sources, preserving their iteration protocol.

- **Replay spans renders.** Every reader starts at the first recorded value
  and walks the retained history before reaching new items. If one render
  processes `job1` and `job2`, a later render replays those jobs and can repeat
  loop-body side effects, such as database inserts.
- **History follows source lifetime.** Values remain buffered while the source
  or its shared iterable stays reachable, unless disposed. Sources kept in
  globals or services accumulate history across renders as more values are read.
- **Disposal is permanent for replay.** It ends the shared history rather than
  resetting it. Later default-mode loops over the same async source produce
  `IteratorThrew` poison caused by `SharedSourceDisposedError`.
- **Incremental work needs a fresh batch or native consumption.** Pass a fresh
  source or batch to each render, or choose [native mode](#native-iteration-mode).
  Native early exit can close or cancel the source, so continuation depends on
  that source's cleanup behavior.
- **Native early-exit cleanup applies to sequential loops.** These are `each`
  and `for` with concurrency limit `1`; parallel loops and loops with a higher
  limit do not guarantee it.
- **Explicit replay in native mode requires the wrapper.** Pass the shared
  iterable itself to the render. Passing the raw source uses native consumption.

```cascada
var stream = makeStream()
data result
for item in stream
  result.first.push(item)
endfor
for item in stream
  result.second.push(item)
endfor
return result.snapshot()
```

If the source yields `a`, `b`, `c`, both arrays contain all three values.
A late reader replays the buffered prefix and continues from there. Readers
advance independently; only one underlying `next()` runs at a time.

## Sources and readers

One weak cache associates each source object with a replay factory. Each loop
gets a new cursor from that factory. The first cursor read acquires the native
iterator; subsequent reads pull on demand and retain the results for replay.
The native iteration method and `next` method are captured once.

Raw aliases, promised sources, and later renders of the same source object use
the same factory. Includes, imports, inheritance, macros, components, and retained
template callbacks follow the same rule. A fresh source object gets fresh history.
Sharing starts at the source's current position; it cannot recover values
already consumed elsewhere.

Completion and failure follow the buffered prefix. Cascada reports source
failures through `IteratorThrew` poison, preserving existing poison origins.
Fatal runtime errors remain fatal. Loop-body failures keep their own error
classification.

Arrays and synchronous iterables keep their normal loop behavior. An array
that defines an async iterator uses shared async iteration too.

## Native values and JavaScript

Sharing happens when a Cascada loop starts. Reading a variable or property,
passing a value to JavaScript, and returning a value do not wrap it or inspect
its iteration protocol. Native identity, properties, methods, and type checks
remain intact. Native APIs such as `ReadableStream.getReader()` and Node
stream `pipe()` retain their normal behavior.

Data snapshots and merges preserve async iterable objects as opaque values,
including sources implemented as plain objects. They do not copy stream state.

JavaScript iteration and native consuming methods use the original source
directly, outside Cascada's replay coordination. For a JavaScript consumer that
needs replay, explicitly obtain the shared iterable:

```javascript
import {makeSharedIterable} from 'cascada-engine';

const source = makeStream();
const shared = makeSharedIterable(source);
try {
  for await (const item of shared) { /* first reader */ }
  for await (const item of shared) { /* replay */ }
  await env.renderScriptString(script, {stream: shared});
} finally {
  await shared.dispose();
}
```

`makeSharedIterable(source)` is the only public sharing function. It accepts
synchronous or async iterables and prefers async iteration when both protocols
exist. For async sources, it returns the same factory used by Cascada loops,
whether called before or after those loops. Passing an existing shared iterable
returns it unchanged. It validates the iteration method immediately but does not
acquire or pull the native iterator. Source objects are cached; primitive
strings get a fresh shared iterable on each call.

An async shared iterable exposes async iteration and `dispose()`; a synchronous
one exposes sync iteration and `dispose()`. Where available, they also support
`Symbol.asyncDispose` and `Symbol.dispose`, respectively. Neither forwards native properties
or methods or is callable. Keep the original source for native APIs. Use the
matching iteration symbol to obtain a cursor with `next()` and `return()`.

Functions retain ordinary call behavior. For unusual functions that are also
async iterable, prepare an explicit shared iterable before passing them as
members for iteration: ordinary member binding does not retain their iteration
protocol.

## Synchronous sources

```javascript
const source = (function* () { yield 'a'; yield 'b'; })();
const shared = makeSharedIterable(source);
try {
  const first = [...shared];  // ['a', 'b']
  const second = [...shared]; // ['a', 'b']
  await env.renderScriptString(script, {stream: shared});
} finally {
  shared.dispose();
}
```

Synchronous readers share one lazily acquired iterator and retain the same
replay and error behavior. Their `next()`, `return()`, and `dispose()` operations
are synchronous. Closing one cursor does not close the source. Disposal calls
the unfinished source iterator's `return()` at most once; cleanup failure throws
from that call to `dispose()`, and later disposal calls are no-ops.

Ordinary synchronous loops keep their native consumption behavior. Pass the
shared iterable itself to Cascada to replay a synchronous source; passing the
raw source bypasses its shared factory, including after disposal. Async Cascada
loops report synchronous iterator consumption failures as `IteratorThrew`
poison. JavaScript readers receive the original thrown error.

## Lifetime and memory

Closing a cursor ends only that reader. Breaking or returning from a Cascada
loop leaves the source available for other readers. Render completion, failure,
and cancellation do not dispose shared sources.

**When finished with a shared source, explicitly dispose it, especially after
stopping early.** The caller can obtain its factory before or after rendering:

```javascript
const source = makeStream();
try {
  await env.renderScriptString(script, {stream: source});
} finally {
  await makeSharedIterable(source).dispose();
}
```

For async sources, `dispose()` returns the same cleanup promise on every call.
It clears history, rejects pending and future reads with an error named
`SharedSourceDisposedError`, and calls the acquired iterator's `return()` at most
once. It never acquires an unused source or closes an iterator that already ended
normally. Failed iterators remain
available for explicit cleanup. Cleanup failure rejects the disposal promise
independently of the read failure. An outstanding native pull cannot be
interrupted; its eventual result is ignored.

The cache retains the consumed sequence while the source or its shared iterable
remains reachable, unless disposed. Values are retained by reference, not copied.
Large or unbounded streams therefore need deliberate lifetime management.
Reusing a disposed async source in a Cascada loop reuses its disposed factory.

## Native iteration mode

To use the source's native iteration without automatic replay in Cascada loops:

```javascript
const env = new AsyncEnvironment(null, {replayAsyncIterables: false});
```

This option adds no replay buffer and ignores automatic replay factories.
Repeated loops follow the source's native behavior. It applies at runtime,
including to precompiled code.

Sequential loops (`each`, or `for` with concurrency limit `1`) call the
iterator's `return()` on early exit. Parallel loops and loops with a higher
concurrency limit do not guarantee this cleanup.

Explicit shared iterables still replay when the wrapper itself is passed to
the render, as in the helper example above. Passing the raw source bypasses
the cache in this mode, even if `makeSharedIterable(source)` was called;
those reads are outside shared replay coordination. The caller remains
responsible for disposing explicit shared iterables.

The helper's type declarations require TypeScript 5.2 or later for
`Symbol.dispose` and `Symbol.asyncDispose`.
