# Command Buffer Refactor 2: Mutate/Observe Lane Runners

## Overview

This refactor replaces recursive `BufferIterator` traversal with lane runners that run command-buffer entries through explicit observation and mutation phases.

The public command result promise does not change. `addCommand(...)` still returns the command result promise immediately for commands that produce a result, and not every command needs to produce one.

Internal execution changes from command application through chain helpers:

```js
cmd.apply(chain); // currently reached through chain._applyCommand(cmd)
```

to command-like phase methods:

```js
entry.observe(chainName);
entry.mutate(chainName);
```

Mixed child buffers use a composite child-buffer path:

```js
entry.iterate(chainName, observerState);
```

The execution model remains the same:

- observations may run concurrently between mutation barriers
- mutations run strictly in source order
- a mutation waits for all source-prior pending observations
- a later mutation must not cross unfinished earlier observations
- root/final snapshot waits for chain completion; any full observation cleanup is separate

## Terms

- **result promise**: the public promise returned by `addCommand(...)`, such as a snapshot result.
- **phase completion**: the internal completion value returned by `observe()` or `mutate()`. On synchronous paths this may be a non-thenable resolved value such as `undefined`.
- **iteration completion**: the `{ mutateDone, observeDone }` record returned by `iterate(...)` for mixed child buffers.
- **mutation completion**: `completion.mutateDone`; returned only by `iterate(...)` and settles when all child mutations for that mixed child execution are complete.
- **observation completion**: `completion.observeDone`; returned only by `iterate(...)`. It is meaningful only for the iteration that owns the observer state's observation-completion resolver. With a fresh Stage 1 observer state this means child observation work is complete. With an inherited Stage 2 observer state the field may be `undefined` or another non-thenable resolved value; parent lane execution relies on the shared `observerState.drain()` barriers instead.
- **chain completion**: the existing chain/final-snapshot gate resolved by `start(...)` when the chain state is stable enough to materialize.
- **observer state**: the active set of source-prior observations that a mutation must drain before it can run.
- **owned lane execution**: a lane execution started with a fresh observer state.
- **inherited lane execution**: a Stage 2 lane execution that borrows an ancestor's observer state.

Phase completions are not result promises. Do not force-wrap resolved phase completions in promises; sync-first behavior is a runtime requirement.

## Capabilities

This plan depends on [chain-facts-refactor.md](./chain-facts-refactor.md). That refactor separates phase-driving observations from broad chain usage:

```text
observedChains
mutatedChains
declaredChains
usedChains = observedChains union mutatedChains union declared chain names
```

`usedChains` is not a phase-classification input for this refactor. It is a derived broad footprint.

Command capability is represented by phase method presence:

```text
observe-only -> has observe(chainName)
mutate-only  -> has mutate(chainName)
```

Command-buffer lane capability is fact-driven. A command buffer may expose `observe(...)`, `mutate(...)`, and `iterate(...)` methods, but the lane runner decides which one to call from the lane facts for the current caller. Method presence alone must not classify command buffers.

Owned `start(chainName)` uses this buffer's own finalized facts:

```text
O = chainName in observedChains
M = chainName in mutatedChains
```

Parent phase dispatch of a child buffer has two steps:

```text
boundaryLinkedChains decides whether the child buffer appears in the parent lane
observedChainsFromParent / mutatedChainsFromParent decide how that resolved lane runs once selected
```

Runtime carries these fields in one `chainFacts` payload. Do not add parallel
constructor or boundary-helper arguments for placement facts; `boundaryLinkedChains`,
`boundaryLinkedMutatedChains`, and the observed/mutated lane facts must stay together.

Once the parent is processing a resolved lane, child-buffer capability uses the child's parent-visible per-lane facts:

```text
O = chainName in child.observedChainsFromParent
M = chainName in child.mutatedChainsFromParent
```

Per-lane rules:

```text
O && !M -> call observe(chainName)
M && !O -> call mutate(chainName)
O && M  -> call iterate(chainName, observerState)
!O && !M -> no entry should be present for that lane
```

This means parent-visible facts are not enough for owned starts. A buffer can mutate or observe local lanes that are not visible from its parent, and `start(chainName)` must still classify those lanes correctly.

`boundaryLinkedChains` is therefore a visibility/insertion fact, not the phase classifier. Do not derive phase-driving observations from `usedChains`; classify lanes from `observedChains` and `mutatedChains`.

When there is no parent/child link for a lane, there is no `boundaryLinkedChains` projection to consult, so the lane runner must use the buffer's own resolved chain facts.

`sequenceLocks` are declaration/setup metadata for sequential-path lanes, not phase-shape metadata. Actual sequence operations already flow into normal facts: sequence get/status checks contribute observation facts, and sequence calls or repairs contribute mutation facts.

Runtime assertions should verify that child placement matches `boundaryLinkedChains` and lane dispatch matches finalized `observedChains` / `mutatedChains`.

### Command Methods

Command classes migrate mechanically:

```js
class SnapshotCommand {
  observe(chain) {
    return this.apply(chain);
  }
}

class TextCommand {
  mutate(chain) {
    return this.apply(chain);
  }
}
```

The `apply(chain)` body can stay during Stage 0; the lane runner calls `observe()` or `mutate()` through method-shape dispatch.

This is Stage 0: split command APIs without changing CommandBuffer traversal. Stage 0 keeps current traversal and dispatches through `observe(...)` or `mutate(...)` based on command shape. Result promises and observable/mutable behavior remain identical to the current `apply(...)` path.

### CommandBuffer Methods

Command-buffer methods process one lane. They do not classify the lane by themselves:

- `observe(chainName)` runs a lane that has observations and no mutations for the current caller.
- `mutate(chainName)` runs a lane that has mutations and no observations for the current caller.
- `iterate(chainName, observerState)` runs a lane that has both observations and mutations for the current caller.

Parent lane runners use `boundaryLinkedChains` to place child buffers in lanes, then classify the selected child lane from the child's `observedChainsFromParent` / `mutatedChainsFromParent`. Root/owner `start(...)` classifies its own buffer with owned facts. `start(...)` is only a one-shot dispatcher, not another lane-processing loop.

```js
async observe(chainName) {
  const observations = [];
  for await (const entry of new CommandIterator(this, chainName)) {
    observations.push(entry.observe(chainName));
  }
  await settleAllObservations(observations);
}

async mutate(chainName) {
  for await (const entry of new CommandIterator(this, chainName)) {
    await entry.mutate(chainName);
  }
}

iterate(chainName, observerState) {
  const completion = createIterationCompletion();
  const iterator = new CommandIterator(this, chainName);
  if (!observerState.attachObserveOwner(
    () => iterator.isClosedAndConsumed(),
    completion.resolveObserveDone
  )) {
    // Inherited Stage 2 execution: this child does not own observe completion.
    completion.observeDone = undefined;
  }
  const task = runMixedIteration(iterator, chainName, observerState, completion);
  markPromiseHandled(task);
  return completion;
}
```

This is the clear `for await` shape. Stage 3 replaces these loops with a non-`async` fast path. Do not add another redirection layer just to name "observe child lane" or "mutate child lane". The observe-only loop starts every child observation as soon as its entry is available, then waits for all of them while preserving the runtime's collect-all-errors discipline; the mutate-only loop awaits each child mutation in source order.

A buffer lane with both observations and mutations is mixed:

- Stage 1 runs a mixed child as a full-completion mutation barrier.
- Stage 2 routes a mixed child through `iterate(...)` with inherited observer state.

Stage 1 waits for both `mutateDone` and `observeDone` for mixed children, so a plain `mutate()` projection is not enough for full-completion barrier semantics.

`iterate(...)` may exist on every command buffer as an internal method. Its presence alone does not classify a buffer as mixed. The lane runner uses it only when the current lane facts say both observation and mutation are possible.

### Lane Shape Rules

Classify lane shape from the facts appropriate to the caller.

Owned start:

```text
O = observedChains has chainName
M = mutatedChains has chainName
```

Parent phase dispatch of a child buffer:

```text
boundaryLinkedChains has chainName -> the child is present in the parent lane
O = child observedChainsFromParent has chainName
M = child mutatedChainsFromParent has chainName
```

Rules:

1. For child buffers, `boundaryLinkedChains` only decides presence in the parent lane; phase dispatch uses the child's parent-visible `observedChainsFromParent` / `mutatedChainsFromParent`.
2. If neither `O` nor `M`, no entry should be present for the lane in that caller context.
3. If `O` is true and `M` is false, call `observe(chainName)`.
4. If `M` is true and `O` is false, call `mutate(chainName)`.
5. If both `O` and `M` are true, use the composite `iterate(...)` path.

This is per-lane and shadowing-safe. A buffer that observes parent-visible lane `x` and mutates parent-visible lane `y` can be observable for `x` and mutable for `y`. A buffer that mutates a local lane not visible from the parent can still be observable for a parent-visible lane. Local mutations do not pessimize the parent lane because the parent sees the child only through `boundaryLinkedChains`, then classifies the selected lane through the child's parent-visible facts.

## Lane Execution and Observer State

There is one owner/root lane starter:

```js
buffer.start(chainName);
```

There are observable entries:

```js
bufferOrCommand.observe(chainName);
```

There are mutable entries:

```js
bufferOrCommand.mutate(chainName);
```

There are mixed command-buffer entries:

```js
buffer.iterate(chainName, observerState);
```

These are not called as a sequence. `observe(...)`, `mutate(...)`, and `iterate(...)` are invoked only by `start(...)` or by another `observe(...)` / `mutate(...)` / `iterate(...)` loop while processing an entry.

`start(chainName)` starts one owned buffer lane by dispatching once from the buffer's owned lane facts:

```js
start(chainName) {
  const observes = this.observesOwnedLane(chainName);
  const mutates = this.mutatesOwnedLane(chainName);
  if (observes && !mutates) {
    // observe-only lanes cannot mutate final chain state
    handleStartedLane(this.observe(chainName), undefined);
    return;
  }
  if (mutates && !observes) {
    handleStartedLane(undefined, this.mutate(chainName));
    return;
  }
  const observerState = new ObserverState();
  const completion = this.iterate(chainName, observerState);
  handleStartedLane(completion.observeDone, completion.mutateDone);
}
```

`start(...)` does not process entries itself. It classifies the owned lane from `observedChains` / `mutatedChains`, calls exactly one of `observe(...)`, `mutate(...)`, or `iterate(...)`, passes the resulting observation and mutation completions to `handleStartedLane(observeDone, mutateDone)`, and returns no completion record.

Use `start(chainName)` only for the buffer that owns the lane start, such as a root/final-drain lane. Parent lane runners never call `child.start(...)`; they use `boundaryLinkedChains` for child placement, classify the selected child lane from parent-visible observed/mutated facts, and then call `observe(...)`, `mutate(...)`, or `iterate(...)`.

`start(chainName)` is lane-scoped. It does not mean "start the whole buffer". There is no whole-buffer start/drain helper in the lane-runner contract. Buffer input is closed with `finish()` / `finishChain(...)`; execution is pulled by the chain lane that needs completion.

`start(chainName)` does not use the source-order loop directly. The loop lives inside the method it dispatches to. It does not create or expose `mutateDone` / `observeDone`; those names matter only when `start(...)` calls `iterate(...)` for a mixed buffer.

Lane execution has a single-start invariant:

- `start(chainName)` is called once for an owned buffer lane
- a parent lane runner never calls `child.start(...)`
- a lane is never traversed twice
- commands are never applied twice
- a lane execution is bound to exactly one observer-state identity

If a lane is started twice, or if the same mixed child lane is entered twice with different observer-state identities, that is a lane/linking bug and should fail loudly. The implementation does not need to return or reuse an existing start result.

### Iteration Completion and Internal State

`start(...)` does not create a lane completion record. It acts on the single return value from its dispatched method. `iterate(...)` returns the only two-field completion shape because a parent mixed-child path needs to distinguish child mutation completion from child observation completion:

```js
const completion = {
  mutateDone: undefined,
  observeDone: undefined
};
```

Input traversal is encapsulated by `CommandIterator`:

```js
const iterator = new CommandIterator(buffer, chainName);
```

Observer-state ownership is determined by the caller:

- `start(...)` creates a fresh observer state only when it dispatches to `iterate(...)` for a mixed root/owner buffer.
- `observe(...)` and `mutate(...)` own any local state they need for single-mode lanes.
- Stage 1 `iterate(...)` receives a fresh child observer state, so `observeDone` reports full child observation completion.
- Stage 2 `iterate(...)` receives inherited parent observer state; the parent does not await `observeDone` at the child slot, and the child does not compute a terminal shared-state drain. Following mutations still drain the shared observer state.

`observeDone` is not the same thing as `pendingObserversEmpty`.

`pendingObserversEmpty` is a transient mutation-barrier primitive. Owned `iterate(...).observeDone` must resolve only when:

```text
iterator input closed === true
and
iterator input consumed === true
and
pendingObservers.size === 0
```

These are not new command-buffer promises. `iterator input closed` is the existing lane-finish condition from `finishChain(chainName)` / `_finishedChains`; `iterator input consumed` is local `CommandIterator` state that replaces the current iterator's finished/chain-completion handoff. Chain completion and final snapshot remain a separate gate.

For a fresh Stage 1 child observer state this handles child lanes whose observer set was never non-empty and prevents a mixed child from reporting full observation completion before all child lane entries have been appended. For an inherited Stage 2 observer state, the child completion does not install or resolve its own `observeDone`. The ancestor-owned observer state resolves its own observation completion, if it has one.

The completion check must run when:

- `finishChain(chainName)` says no more entries can be appended
- `CommandIterator` consumes all entries after input closure
- an active observation is removed from `pendingObservers`

For inherited lane executions, parent lane execution does not await the returned `observeDone` immediately. Child observations are represented directly in the shared observer state. Adding parallel per-child observation bookkeeping would duplicate the shared set and reintroduce double counting. Computing `observeDone` by awaiting a terminal drain of the inherited state would also leave detached child coroutines pinned to ancestor/root observations that the child does not own.

### ObserverState Helper

`ObserverState` owns additions, removals, and mutation barriers:

```js
class ObserverState {
  constructor() {
    this.pendingObservers = new Set();
    this.pendingObserversEmpty = null;
    this.resolvePendingObserversEmpty = null;
    this.observeOwner = null;
  }

  attachObserveOwner(isInputConsumed, resolveObserveDone) {
    if (this.observeOwner) {
      return false;
    }
    this.observeOwner = {
      done: false,
      isInputConsumed,
      resolveObserveDone
    };
    this.checkObserveDone();
    return true;
  }

  track(key, observeDone) {
    if (!observeDone || typeof observeDone.then !== 'function') {
      return;
    }
    if (!this.pendingObserversEmpty) {
      this.pendingObserversEmpty = new Promise((resolve) => {
        this.resolvePendingObserversEmpty = resolve;
      });
    }
    this.pendingObservers.add(key);
    observeDone.finally(() => {
      this.pendingObservers.delete(key);
      if (
        this.pendingObservers.size === 0 &&
        this.resolvePendingObserversEmpty
      ) {
        const resolve = this.resolvePendingObserversEmpty;
        this.pendingObserversEmpty = null;
        this.resolvePendingObserversEmpty = null;
        resolve();
      }
      this.checkObserveDone();
    });
  }

  checkObserveDone() {
    const owner = this.observeOwner;
    if (!owner || owner.done) {
      return;
    }
    if (owner.isInputConsumed() && this.pendingObservers.size === 0) {
      owner.done = true;
      owner.resolveObserveDone();
    }
  }

  drain() {
    if (this.pendingObservers.size === 0) {
      return undefined;
    }
    return this._drainAsync();
  }

  async _drainAsync() {
    while (this.pendingObservers.size > 0) {
      await this.pendingObserversEmpty;
    }
  }
}
```

`observeOwner` is optional and singular. A fresh state used by a root/owner mixed lane or a Stage 1 mixed child installs it; a Stage 2 inherited child sees that the state is already owned and leaves its own `completion.observeDone` `undefined` or resolved. This is an implementation hook, not a second permanent registry.

In Stage 3, do not allocate a promise for `completion.observeDone` until `attachObserveOwner(...)` returns true.

The implementation must still use the runtime's existing unhandled-rejection discipline, such as `markPromiseHandled(...)`, when attaching cleanup callbacks. `drain()` must remain sync-first: it returns `undefined` when the set is already empty and only returns a thenable when there is real observation work to wait for.

The loop is intentional. A nested mixed child can add observations to shared observer state while a drain is waiting. The barrier must wait until the set is actually empty.

This is the only Stage 2 rule needed to prevent mutations from crossing observations: every mutable entry calls `observerState.drain()` before it runs. A mixed child's residual observations are safe because they are already members of the shared `pendingObservers` set.

The lane runner does not need a durable map of observe promises. The cleanup closure owns the thenable it is attached to, and mutable barriers wait on the set-empty signal. Add a completion map only if fatal handling or debugging needs to inspect in-flight observation completions directly.

## Mixed Lane Algorithm

`iterate(...)` starts the mixed loop and returns its completion record immediately. The loop below shows the Stage 2 shared-observer-state branch for nested mixed buffers. Stage 1 uses the full-completion branch shown in the Stage 1 section.

```js
async function runMixedIteration(iterator, chainName, observerState, completion) {
  try {
    for await (const entry of iterator) {
      const observes = entryObservesLane(entry, chainName);
      const mutates = entryMutatesLane(entry, chainName);
      if (observes && !mutates) {
        const observeDone = entry.observe(chainName);
        observerState.track(entry, observeDone);
        continue;
      }
      if (mutates && !observes) {
        await observerState.drain();
        await entry.mutate(chainName);
        continue;
      }
      // Mixed command-buffer lane: child lane facts say both observe and mutate.
      assert(entry.iterate);
      const childCompletion = entry.iterate(chainName, observerState);
      // Stage 2: child observations are already tracked in observerState.
      // The next mutable drains them through observerState.drain().
      await childCompletion.mutateDone;
    }
    completion.resolveMutateDone();
    observerState.checkObserveDone();
  } catch (err) {
    completion.reject(err);
  }
}
```

`entryObservesLane(...)` / `entryMutatesLane(...)` are conceptual helpers. For ordinary commands they read method presence. For child command buffers they read the child's `observedChainsFromParent` / `mutatedChainsFromParent` for the current parent lane. `boundaryLinkedChains` only explains why the child entry is present in that parent lane.

Because `runMixedIteration(...)` is detached from the immediate caller, it must attach rejection handlers, mark the task handled, and report fatal errors through the owning render state or buffer context. Rejecting the completion record is not enough when Stage 2 callers intentionally do not await `observeDone`. Inherited Stage 2 iterations must not end by awaiting `observerState.drain()` because that would wait on ancestor or later-parent observations and keep a useless child coroutine alive.

The `for await` loop is the clarity shape. The iterator handles waiting for appended entries and lane finish; the lane-processing method handles observe/mutate/iterate semantics. Stage 3 replaces this with a non-`async` outer loop so synchronously-ready entries do not allocate a promise or take a microtask hop per entry.

Sync-first mutation composition:

```js
function processMutateEntry(entry, chainName, observerState) {
  const drained = observerState.drain();
  if (drained && typeof drained.then === 'function') {
    return drained.then(() => entry.mutate(chainName));
  }
  return entry.mutate(chainName);
}
```

### CommandIterator

`CommandIterator` is the narrow input iterator for one buffer lane. It is not a lane runner and it does not know about observe/mutate/iterate semantics or pending observers. It owns only:

- `nextIndex`
- waiting when the lane array is currently exhausted
- waking when an entry is appended
- waking when `finishChain(chainName)` closes iterator input
- detecting that closed input has been fully consumed
- fatal wakeup/abort if needed

Async clarity shape:

```js
class CommandIterator {
  constructor(buffer, chainName) {
    this.buffer = buffer;
    this.chainName = chainName;
    this.nextIndex = 0;
    this.waiting = null;
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const entry = this._nextReadyEntry();
      if (entry) {
        yield entry;
        continue;
      }
      if (this._isClosedAndConsumed()) {
        return;
      }
      await this._waitForAppendOrFinish();
    }
  }
}
```

`_nextReadyEntry()` reads `buffer.arrays[chainName][nextIndex]`, increments `nextIndex` only when an entry exists, and yields entries in source order. `_waitForAppendOrFinish()` parks only when the iterator has reached the current end of an unfinished lane. `_isClosedAndConsumed()` should be a direct predicate over the existing lane-finished flag plus iterator-local position, roughly `buffer.isChainFinished(chainName) && nextIndex >= current lane length`.

`finishChain(chainName)` means input is closed, not that all work has completed. Work completion is separate:

- iterator input closed: no more entries will be appended
- iterator input consumed: all appended entries have been yielded after input closure
- chain completion: root/owner final state is stable enough to materialize
- `iterate(...).mutateDone`: mixed child mutation work is complete
- owned `iterate(...).observeDone`: the owned observer state has drained after iterator input is consumed

`CommandIterator` is registered as the single active iterator for its buffer lane. Command append and lane finish both call `_notifyLaneChanged(chainName)`, which calls `iterator.onAnyChange()` and lets the iterator re-check whether an entry is ready or the input is closed and consumed.

Use one active lane-execution registry for append/finish wakeups and fatal shutdown fan-out. A second active iterator for the same buffer lane is a linking/startup bug, not a supported scheduling shape.

### Stage 3 Sync-First Execution

Stage 3 is not only about `CommandIterator`. It makes the whole lane execution path sync-first:

- `CommandIterator` returns a ready entry synchronously when one exists.
- `observe(...)` and `mutate(...)` return non-thenable resolved values when all work finishes synchronously.
- `iterate(...)` returns its completion record immediately; its `mutateDone` and `observeDone` fields may be non-thenable resolved values.
- call sites check for thenables before composing waits.

The async iterator form can remain for clarity or tests. Hot lane loops use a non-`async` pull method:

```js
const next = iterator.nextReady();
```

`nextReady()` returns one of three shapes:

- a command or child buffer entry when an entry is synchronously available
- a thenable when the lane is currently exhausted but still open
- `null` when the lane is closed and all appended entries have been yielded

The lane loop then composes sync-first phase completions:

```js
function advanceMixed(iterator, chainName, observerState, completion) {
  while (true) {
    const next = iterator.nextReady();
    if (next === null) {
      completion.resolveMutateDone();
      observerState.checkObserveDone();
      return undefined;
    }
    if (next && typeof next.then === 'function') {
      return next.then(() =>
        advanceMixed(iterator, chainName, observerState, completion)
      );
    }
    const done = processMixedEntry(next, chainName, observerState);
    if (done && typeof done.then === 'function') {
      return done.then(() =>
        advanceMixed(iterator, chainName, observerState, completion)
      );
    }
  }
}
```

The same pattern applies to observe-only and mutate-only buffer projections. Observe-only starts every available observation before waiting; mutate-only waits after each mutation. Stage 3 is a performance stage, not a semantic change.

Observe-only projections record only thenable observation completions. If no observation returns a thenable, the projection returns `undefined` without calling the all-settled helper. If there are thenables, the helper must use all-settled/collect-all-errors behavior rather than fail-fast `Promise.all(...)`.

`handleStartedLane(observeDone, mutateDone)` follows the same rule. It resolves chain completion synchronously when `mutateDone` is absent or non-thenable, waits only when `mutateDone` is a thenable, and treats `observeDone` as cleanup/error-reporting work rather than the final-snapshot gate unless a root cleanup path explicitly needs full observation completion.

Sync-first return points:

```text
command.observe(...)          -> undefined or thenable
command.mutate(...)           -> undefined or thenable
buffer.observe(...)           -> undefined or thenable
buffer.mutate(...)            -> undefined or thenable
buffer.iterate(...)           -> completion record
completion.mutateDone         -> undefined or thenable
completion.observeDone        -> undefined or thenable
observerState.drain()         -> undefined or thenable
iterator.nextReady()          -> entry, wait-thenable, or null
start(chainName)              -> undefined
```

Every conceptual `await` in the Stage 1/2 pseudocode must become explicit thenable composition in Stage 3:

```js
const done = entry.mutate(chainName);
if (done && typeof done.then === 'function') {
  return done.then(continueAfterMutation);
}
return continueAfterMutation();
```

That applies to:

- waiting for an entry from `CommandIterator`
- waiting for `observerState.drain()`
- waiting for `entry.observe(...)`
- waiting for `entry.mutate(...)`
- waiting for `childCompletion.mutateDone`
- waiting for `completion.observeDone` in Stage 1/root cleanup paths
- settling all observe-only child observations

## Cross-Level Barrier

Mixed child buffers are the only case that needs shared observer state.

Example:

```text
parent observable A
child:
  child observable B
  child mutable C
  child observable D
parent observable E
parent mutable F
```

Expected Stage 2 order:

```text
start A
start B
wait A and B
run C
start D
start E
wait D and E
run F
```

A black-box `child.mutate()` cannot satisfy both requirements:

- `B` must overlap `A`
- `C` must wait for `A` and `B`

Therefore Stage 2 mixed children use `iterate(chainName, observerState)`. Observe-only children do not need this because they are a single observable entry.

## Mutation Completion Limit

For a mixed buffer, `mutateDone` must not resolve until the runtime knows no more mutations can appear before the buffer's source-order slot is complete.

For an open lane this usually means:

```text
mutateDone ~= iterator input closed and consumed, and all discovered mutables drained
```

Otherwise a later child mutation could appear after the parent has continued past the child.

Stage 2's safe residual-observation window is:

```text
child iterator input is closed
child mutables are drained
child tail observations are still pending
parent can start adjacent observations
```

Analysis can widen this later if it can prove an observe-only suffix or prove that no future mutables can be appended after a known point.

## Stage 1

Stage 1 removes recursive iterator traversal while preserving current semantics. It does not attempt residual child-observation concurrency.

Stage 1 implements:

- `observe(chainName)`
- `mutate(chainName)`
- `iterate(chainName, observerState)`
- `start(chainName)`

Stage 1 parent phase dispatch does not use:

- inherited observer state
- parent advancement after a mixed child's `mutateDone` while child observations remain in shared observer state

Stage 1 uses `iterate(...)` only for mixed child buffers, and passes a fresh observer state so the child remains a full-completion barrier.

Stage 1 target behavior:

```text
observe-only child -> observable command equivalent
mutate-only child  -> mutable command equivalent
mixed child        -> full-completion mutation barrier
```

Mixed-child handling:

```js
await observerState.drain();
const childObserverState = new ObserverState();
const childCompletion = child.iterate(chainName, childObserverState);
await childCompletion.mutateDone;
await childCompletion.observeDone;
```

Stage 1 should still have `iterate(...)` return the two-field completion record. Stage 1 waits for both fields; Stage 2 later waits only for `mutateDone` in the parent path.

## Stage 2

Stage 2 introduces inherited observer state for mixed children:

```js
const childCompletion = child.iterate(chainName, observerState);
await childCompletion.mutateDone;
// child observations are already tracked in observerState
```

The parent does not await `childCompletion.observeDone` immediately in this path. In the inherited path, `childCompletion.observeDone` should be `undefined` or another non-thenable resolved value because the child does not own observation completion. Later parent mutables call `observerState.drain()`, which waits for `pendingObserversEmpty` on the shared observer state. That shared set includes child tail observations, so no mutation can cross them.

This unlocks the concurrency win:

- child-leading observations can overlap with prior parent observations
- child mutables wait for prior parent and child observations
- child-tail observations can overlap with following parent observations
- following parent mutables still wait for child-tail observations

The mutation completion limit above is load-bearing. A mixed child's `mutateDone` must not settle until the child iterator input is closed and consumed, or otherwise proven to have no future mutables. Therefore any remaining child observations are already registered in inherited observer state before the parent continues.

## Root Starts and Final Snapshots

The root buffer has no parent lane runner. It starts lanes with owned state:

```js
buffer.start(chainName);
```

That start happens once for the lane. `finalSnapshot()` waits on the existing chain completion gate; it does not call `start(...)` defensively.

If cleanup needs to wait for pending observations, that wait can stay internal to the lane runner. It does not require a public `{ mutateDone, observeDone }` lane record from `start(...)`.

`finalSnapshot()` waits for chain completion, which `start(...)` resolves when the final chain state is stable:

```js
finalSnapshot() {
  try {
    if (this._completionResolved) {
      return this._resolveSnapshotCommandResult();
    }
    return this._completionPromise.then(() => this._resolveSnapshotCommandResult());
  } catch (err) {
    return Promise.reject(err);
  }
}
```

Useful root cases:

- pure observe root lane: chain completion can resolve immediately because no future entry can mutate final chain state
- pure mutate root lane: chain completion resolves after mutations complete
- mixed root lane: final snapshot waits until mutation state is stable; full cleanup can still wait for pending observations if needed

The public finishing contract must stay compatible:

- `finish()` means no more entries will be appended to the buffer
- `finishChain(name)` means no more entries will be appended to that lane
- `finalSnapshot()` means wait until final state is stable, then materialize

Use `start(chainName)` for the lane-scoped helper that dispatches to the buffer's own phase method and resolves the chain completion gate. Do not add a whole-buffer execution helper to the base lane-runner design. `finalSnapshot()` must not be forced to wait for unrelated trailing observations.

## Result Promise vs Phase Completion

Keep result promises and phase completions separate.

For example, a snapshot command has:

- a public result promise returned by `addCommand(...)`
- an `observe()` phase completion that tells the lane runner when applying the snapshot observation is complete

The public result may settle inside the phase:

```js
observe(chain) {
  this.settleResult(chain._makeSnapshot(this.errorContext));
}
```

The lane runner should use the public result promise as phase completion only if the command intentionally returns that same promise from `observe()`.

## Lifecycle, Cleanup, and Fatal Handling

The new `CommandIterator` plus lane-processing methods must preserve current iterator cleanup:

- processed command entries become `null`
- finished child-buffer slots become `null`
- finished lane arrays become `null`
- finished lane executions release their state
- chain completion promises resolve
- abandoned command results reject after fatal shutdown

Diagnostic stack ownership should stay buffer-based:

```js
buffer.getDiagnosticStack()
```

Lane runners do not need to recreate the DFS stack for diagnostics. Runtime errors that need stack context should continue to use the relevant `CommandBuffer`.

Fatal shutdown needs explicit wakeups. A runner may be parked while waiting for pending observations or waiting for more lane entries, so fatal state must wake active runs and reject pending command result promises promptly.

The active lane-execution registry used for normal wakeups should also support fatal broadcast. Possible owners:

- `RenderState`
- the root `CommandBuffer`
- a subscription owned by each lane runner

The owner is less important than the invariant: wakeup and fatal lifecycle must track the same active lane-execution objects.

The error model remains unchanged:

- command origin errors keep command `errorContext`
- poison errors remain value failures, not fatal runtime errors
- fatal runtime errors remain fatal and must not be converted to poison
- existing unhandled-rejection discipline must be preserved

## Migration Checklist

Stage 0:

1. Add `observe()` and `mutate()` wrappers to command classes while preserving `apply()`.
2. Keep existing `BufferIterator` traversal, but dispatch commands through `observe(...)` / `mutate(...)` based on method shape.
3. Keep public command result promises unchanged.
4. Add parity tests proving behavior matches the current `apply(...)` path.

Stage 1:

1. Implement or consume [chain-facts-refactor.md](./chain-facts-refactor.md): `observedChains`, `mutatedChains`, `declaredChains`, derived `usedChains`, and `boundaryLinkedChains`.
2. Serialize compact `observedFacts` and `mutatedFacts` vectors into `CommandBuffer` construction and boundary helpers. Each vector is indexed as `[linked, owned, parentVisible]`; trailing empty slots may be omitted.
3. Use `observedFacts[linked]` to decide which parent lanes receive a child buffer.
4. Classify owned `start(chainName)` from `observedChains` / `mutatedChains`.
5. Classify child-buffer phase dispatch from the child's `observedChainsFromParent` / `mutatedChainsFromParent` for the current parent lane.
6. Add single-start void `start(chainName)` that dispatches once to the buffer's own `observe(...)`, `mutate(...)`, or `iterate(...)` method and resolves existing chain completion from that return value.
7. Add `ObserverState` with `track(...)`, sync-first `drain()`, `pendingObservers`, and `pendingObserversEmpty`.
8. Replace the recursive `BufferIterator` traversal with a narrow `CommandIterator` async iterator for next-entry, append wakeup, input closure, and fatal wakeup.
9. Connect `CommandIterator` wakeups to appended entries and `finishChain(...)`.
10. Route observe-only child lanes through `observe()` projections.
11. Route mutate-only child lanes through `mutate()` projections.
12. Route mixed child lanes through `iterate(...)`; Stage 1 passes a fresh observer state and waits for full completion.
13. Replace `BufferIterator` use from `Chain` with the root lane start point.
14. Remove the obsolete `BufferIterator` implementation and leftover iterator-specific names/state, such as `_resolveIteratorCompletion`.
15. Preserve cleanup, completion, and fatal rejection behavior.

Stage 2:

1. Add focused mixed-buffer concurrency tests.
2. Route mixed child buffers through `iterate(...)` with inherited observer state instead of a fresh Stage 1 observer state.
3. Wait only for child `mutateDone` in the Stage 2 parent path.
4. Leave inherited child `observeDone` undefined or non-thenable resolved; do not compute it by terminally draining the shared observer state.
5. Let following parent mutables drain the shared observer state.

Stage 3:

1. Add `CommandIterator.nextReady()` for the non-`async` iterator fast path.
2. Replace hot `for await` lane loops with sync-first outer loops.
3. Make command-buffer `observe(...)` and `mutate(...)` return non-thenable resolved values on synchronous paths.
4. Allow `iterate(...)` completion fields to be non-thenable resolved values.
5. Replace every `await` on possibly non-thenable phase completion with an explicit thenable check.
6. Keep the async iterator form only as a clarity/test adapter if useful.
7. In observe-only projection loops, collect only thenable observation completions and return synchronously when the collection is empty.
8. Preserve collect-all-errors behavior when observe-only projection loops do have thenable completions.
9. Apply the same thenable checks in `handleStartedLane(observeDone, mutateDone)`.
10. Preserve fire-and-forget rejection reporting for detached iteration tasks.

## Focused Tests

Direct runtime tests:

- Stage 0 command `observe()` / `mutate()` wrappers preserve existing `apply()` behavior
- Stage 0 keeps public command result promises unchanged
- `start(chainName)` resolves chain completion without returning a completion record
- `finalSnapshot()` waits for mutations but not unrelated trailing observations
- pure observe root lane can materialize final snapshot immediately
- observe-only commands run concurrently until a mutable command
- mutable command waits for all preceding observations
- child observe-only buffer behaves like an observable command
- child mutate-only buffer behaves like a mutable command
- owned `start(chainName)` uses local `observedChains` / `mutatedChains` even when the lane is not parent-visible
- parent phase dispatch inserts child buffers through `boundaryLinkedChains`, then classifies the selected lane from child `observedChainsFromParent` / `mutatedChainsFromParent`
- a buffer that observes parent lane `x` and mutates local lane `y` is observable to the parent on `x` but mutating when `start(y)` runs
- a buffer that observes parent lane `x` and mutates parent lane `y` is classified per lane instead of object-wide mixed
- Stage 1 mixed child blocks until full completion
- Stage 2 mixed child exposes residual observation work after mutations finish
- Stage 2 A-F order is preserved: start A, start B, wait A+B, run C, start D, start E, wait D+E, run F
- Stage 2 child-leading observation overlaps prior parent observation
- Stage 2 child mutable waits for prior parent and child observations
- Stage 2 child-tail observation overlaps following parent observation
- Stage 2 following parent mutable waits for child-tail and parent observations
- Stage 2 remains deterministic when an observation completes before a mutation
- Stage 2 open, still-appending mixed child does not release `mutateDone` early while a later child mutation could still arrive
- Stage 2 inherited mixed child does not keep a detached coroutine alive by awaiting the shared observer state's terminal drain
- owned mixed iteration resolves `observeDone` only after input is consumed and pending observations are empty, including the never-non-empty case
- Stage 3 iterator returns entry / wait-thenable / `null` without allocating on synchronously-ready entries
- Stage 3 command and buffer phase methods return non-thenable values when synchronously complete
- Stage 3 completion fields can be non-thenable resolved values
- Stage 3 observe-only projection starts all ready observations before waiting
- Stage 3 observe-only projection ignores non-thenable observation completions and returns synchronously when none are thenable
- Stage 3 root `handleStartedLane(...)` resolves chain completion synchronously when mutation completion is absent or non-thenable
- Stage 3 mutate-only and mixed projections preserve mutation barriers
- processed entries and finished lanes are still nulled
- fatal render state wakes parked runners and rejects pending command results

Compiled behavior tests:

- snapshots still resolve at source position before later writes
- final output snapshots still observe final mutated state
- sequence gets still overlap before sequence calls
- sequence calls still wait for pending sequence gets
- loops preserve deterministic output order
- async control-flow child buffers preserve source order
- poison paths preserve origin contexts

Recommended suites:

- `tests/pasync/snapshots.js`
- `tests/pasync/script-output.js`
- `tests/pasync/sequential-expressions.js`
- `tests/pasync/side-effect.js`
- `tests/poison/`
