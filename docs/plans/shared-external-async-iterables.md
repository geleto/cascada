# Shared async iteration

Status: implemented.

## Design

A module-level WeakMap associates each async iterable source with a replay
factory. A factory owns one native iterator, its captured next method, buffered
values, completion or failure, and pending demand. Each loop gets a new cursor
with its own position and pending requests.

Only loop acquisition uses this cache. Context lookups, property reads, calls,
arguments, returns, and containers keep their ordinary values. The expression
compiler needs no sharing logic. Data copies preserve async iterable objects as
opaque values rather than cloning their state or iteration protocol.

## Implementation

- `shared-iterable.js` owns the source cache and replay factories. Factories are
  ordinary iterable instances. The cache also recognizes those instances, so
  explicit and automatic readers use the same state without another registry.
- Factory construction executes no source code. Protocol lookup precedes
  construction, and the single construction path checks the cache again, so a
  reentrant getter cannot create a second factory.
- `getAsyncIterator` acquires a fresh replay cursor at the loop boundary, or a
  native iterator when replay is disabled. Non-async inputs continue through
  existing array, synchronous iterable, and dictionary dispatch.
- Loop code captures each cursor's next method once. Source acquisition, next
  calls, result validation, and result getters belong to source error handling.
  Loop-body and runtime failures remain outside that boundary.
- Sequential iteration owns early-exit cleanup directly. Parallel iteration
  schedules bodies while consuming the cursor;
  length and last metadata resolve as the source advances or ends.
- The loop compiler passes the environment's replay option at runtime. Internal
  while-loop counters use native iteration and accumulate no replay history.
- `createSharedAsyncIterable(source)` returns the same factory for JavaScript
  consumers and disposal. Its public interface contains only iteration and
  disposal. It neither forwards source members nor changes ordinary functions.
- Returning a cursor closes only that reader. Disposal clears history, rejects
  reads, ignores late pull results, and closes an acquired unfinished native
  iterator once. Failed iterators remain available for explicit cleanup.

## Boundaries

The cache is keyed by the original source object, not by repeatedly acquired
native iterators. Raw aliases, explicit factories, and independent renders share
one source history. Reusing a disposed source reuses its disposed factory.

Native consuming methods and JavaScript iteration of the original object remain
outside replay coordination. JavaScript consumers needing replay receive the
explicit shared iterable. Callable iterable members also require that explicit
preparation because ordinary method binding does not preserve their protocol.

History grows with consumption and survives early reader termination. Disposal
belongs to the source owner. There is no prediction of future readers or
implicit release/reset of a live source's history.

See [Shared async iteration](../cascada/async-iterables.md) for the public contract.
