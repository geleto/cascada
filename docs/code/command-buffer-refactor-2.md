# Command Buffer Refactor 2: Mutate/Observe Scheduler

## Overview

This refactor replaces recursive `BufferIterator` traversal with lane runners that schedule command-buffer entries through explicit observation and mutation phases.

The public command result promise does not change. `addCommand(...)` still returns the command result promise immediately for commands that produce a result, and not every command needs to produce one.

Internal scheduling changes from:

```js
chain._applyCommand(command);
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
- **observation completion**: `completion.observeDone`; returned only by `iterate(...)`. It is meaningful only for the iteration that owns the observer state's observation-completion resolver. With a fresh Stage 1 observer state this means child observation work is complete. With an inherited Stage 2 observer state the field may be `undefined` or another non-thenable resolved value; parent scheduling relies on the shared `observerState.drain()` barriers instead.
- **chain completion**: the existing chain/final-snapshot gate resolved by `start(...)` when the chain state is stable enough to materialize.
- **observer state**: the active set of source-prior observations that a mutation must drain before it can run.
- **owned lane execution**: a lane execution started with a fresh observer state.
- **inherited lane execution**: a Stage 2 lane execution that borrows an ancestor's observer state.

Phase completions are not result promises. Do not force-wrap resolved phase completions in promises; sync-first behavior is a runtime requirement.

## Capabilities

Entry capability is represented by the scheduler methods installed on the entry:

```text
observe-only -> has observe(chainName)
mutate-only  -> has mutate(chainName)
mixed buffer -> has neither projection; scheduler falls back to iterate
```

This is a method-shape contract, not a separate enum or bitflag. Each command class defines exactly one scheduler method: `observe(...)` or `mutate(...)`. Command buffers define `observe(...)`, define `mutate(...)`, or fall back to `iterate(...)` when neither projection is installed. The constructor uses finalized analysis metadata to decide that shape; the lane runner does not inspect lane contents while scheduling.

Use finalized parent-visible lane facts:

- `linkedObservedChains`: parent-visible lanes where this buffer may enqueue an observable entry
- `linkedMutatedChains`: parent-visible lanes this buffer may mutate
- `linkedChains`: parent-visible lanes this buffer may touch

The analysis invariant should be:

```text
linkedChains = linkedObservedChains union linkedMutatedChains
```

Do not derive `linkedObservedChains` as `linkedChains - linkedMutatedChains`. A lane can contain both observations and mutations. Also do not derive it directly from raw `usedChains`: mutating commands count as uses, and raw chain facts may include child-owned local declarations.

The generic analysis should derive:

```text
observedChains
observedChainsFromParent
linkedObservedChains
```

in parallel with the existing mutation facts:

```text
mutatedChains
mutatedChainsFromParent
linkedMutatedChains
```

Observable command sources add observation facts. Mutating command sources add mutation facts. Mutations may still imply ordinary use for validation and addressability, but mutation must not imply observation.

`sequenceLocks` are declaration/setup metadata for sequential-path lanes, not scheduler-shape metadata. Actual sequence operations already flow into normal facts: sequence get/status checks contribute observation facts, and sequence calls or repairs contribute mutation facts.

Runtime assertions should verify that installed methods match the finalized parent-visible lane facts.

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

The `apply(chain)` body can stay during Stage 0; the scheduler calls `observe()` or `mutate()` through method-shape dispatch.

This is Stage 0: split command APIs without changing CommandBuffer traversal. Stage 0 keeps current traversal and dispatches through `observe(...)` or `mutate(...)` based on command shape. Result promises and observable/mutable behavior remain identical to the current `apply(...)` path.

### CommandBuffer Methods

The command buffer constructor should make uniform child buffers look command-like to the parent runner:

- observe-only buffer: expose `observe(chainName)`
- mutate-only buffer: expose `mutate(chainName)`
- mixed buffer: do not install either projection

Those methods are the command-buffer entry points. Parent schedulers call them on child buffers; root/owner `start(...)` calls them on its own buffer. `start(...)` is only a one-shot dispatcher, not another lane-processing loop.

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
  if (!observerState.attachObserveOwner({
    isInputConsumed: () => iterator.isClosedAndConsumed(),
    resolve: completion.resolveObserveDone,
    reject: completion.rejectObserveDone
  })) {
    // Inherited Stage 2 execution: this child does not own observe completion.
    completion.observeDone = undefined;
  }
  const task = runMixedIteration(iterator, chainName, observerState, completion);
  markPromiseHandled(task);
  return completion;
}
```

This is the clear `for await` shape. Stage 3 replaces these loops with a non-`async` fast path. Do not add another redirection layer just to name "observe child lane" or "mutate child lane". The constructor installs these projections only for uniform buffers, so the loops can trust that entries expose the matching method. The observe-only loop starts every child observation as soon as its entry is available, then waits for all of them while preserving the runtime's collect-all-errors discipline; the mutate-only loop awaits each child mutation in source order.

A buffer with both linked observations and linked mutations is mixed. When neither `observe` nor `mutate` is installed, the parent treats the child as composite:

- Stage 1 schedules a mixed child as a full-completion mutation barrier.
- Stage 2 routes a mixed child through `iterate(...)` with inherited observer state.

Stage 1 waits for both `mutateDone` and `observeDone` for mixed children, so a plain `mutate()` projection is not enough for full-completion barrier semantics.

`iterate(...)` may exist on every command buffer as an internal method. Its presence alone does not classify a buffer as mixed. The parent scheduler uses it only when no `observe()` or `mutate()` projection is installed.

### Buffer Shape Rules

Classify child-buffer shape from finalized parent-visible lane facts:

```text
L = linkedChains
O = linkedObservedChains
M = linkedMutatedChains
```

Rules:

1. Require `L = O union M`; otherwise the analysis/linking metadata is stale.
2. If `L` is empty, the buffer is not inserted into a parent lane.
3. If `O` is non-empty and `M` is empty, install `observe(chainName)`.
4. If `M` is non-empty and `O` is empty, install `mutate(chainName)`.
5. If both `O` and `M` are non-empty, install neither projection; use the composite path.

This is object-wide. A buffer that observes one parent-visible lane and mutates another is mixed from the parent scheduler's perspective. A later optimization may install per-lane projection dispatch, but the base design keeps method presence object-wide. This can pessimize multi-lane buffers: a buffer that is observe-only for lane `x` but mutates lane `y` will be routed through the mixed path on both lanes. Track per-lane projection dispatch as a later concurrency optimization if compiled output commonly produces those shapes.

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

`start(chainName)` starts one owned buffer lane by dispatching once to the buffer's own installed scheduler method:

```js
start(chainName) {
  if (this.observe) {
    const observeDone = this.observe(chainName);
    // observe-only lanes cannot mutate final chain state
    handleStartedObservation(observeDone);
    return;
  }
  if (this.mutate) {
    const mutateDone = this.mutate(chainName);
    handleStartedMutation(mutateDone);
    return;
  }
  const observerState = new ObserverState();
  const completion = this.iterate(chainName, observerState);
  handleStartedMixedIteration(completion);
}
```

`start(...)` does not process entries itself. It calls exactly one of `observe(...)`, `mutate(...)`, or `iterate(...)`, resolves the existing chain completion according to the returned phase/iteration completion, and returns no completion record.

Use `start(chainName)` only for the buffer that owns the lane start, such as a root/final-drain lane. Parent schedulers never call `child.start(...)`; they see only the child buffer's installed `observe(...)`, `mutate(...)`, or `iterate(...)` method.

`start(chainName)` is lane-scoped. It does not mean "start the whole buffer". There is no whole-buffer start/drain helper in the scheduler contract. Buffer input is closed with `finish()` / `finishChain(...)`; execution is pulled by the chain lane that needs completion.

`start(chainName)` does not use the source-order loop directly. The loop lives inside the method it dispatches to. It does not create or expose `mutateDone` / `observeDone`; those names matter only when `start(...)` calls `iterate(...)` for a mixed buffer.

Lane execution has a single-start invariant:

- `start(chainName)` is called once for an owned buffer lane
- a parent scheduler never calls `child.start(...)`
- a lane is never traversed twice
- commands are never applied twice
- a lane execution is bound to exactly one observer-state identity

If a lane is started twice, or if the same mixed child lane is entered twice with different observer-state identities, that is a scheduler/linking bug and should fail loudly. The implementation does not need to return or reuse an existing start result.

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
- `observe(...)` and `mutate(...)` own any local state they need for uniform buffer lanes.
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

For a fresh Stage 1 child observer state this handles child lanes whose observer set was never non-empty and prevents a mixed child from reporting full observation completion before all child lane entries have been appended. For an inherited Stage 2 observer state, the child completion does not install or resolve its own `observeDone`. The ancestor-owned observer state resolves its own observation completion, if it has one.

The completion check must run when:

- `finishChain(chainName)` says no more entries can be appended
- `CommandIterator` consumes all entries after input closure
- an active observation is removed from `pendingObservers`

For inherited lane executions, parent scheduling does not await the returned `observeDone` immediately. Child observations are represented directly in the shared observer state. Adding parallel per-child observation bookkeeping would duplicate the shared set and reintroduce double counting. Computing `observeDone` by awaiting a terminal drain of the inherited state would also leave detached child coroutines pinned to ancestor/root observations that the child does not own.

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

  attachObserveOwner(owner) {
    if (this.observeOwner) {
      return false;
    }
    this.observeOwner = owner;
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
      owner.resolve();
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

The scheduler does not need a durable map of observe promises. The cleanup closure owns the thenable it is attached to, and mutable barriers wait on the set-empty signal. Add a completion map only if fatal handling or debugging needs to inspect in-flight observation completions directly.

## Mixed Scheduling Algorithm

`iterate(...)` starts the mixed loop and returns its completion record immediately. The loop below shows the Stage 2 shared-observer-state branch for nested mixed buffers. Stage 1 uses the full-completion branch shown in the Stage 1 section.

```js
async function runMixedIteration(iterator, chainName, observerState, completion) {
  try {
    for await (const entry of iterator) {
      if (entry.observe) {
        const observeDone = entry.observe(chainName);
        observerState.track(entry, observeDone);
        continue;
      }
      if (entry.mutate) {
        await observerState.drain();
        await entry.mutate(chainName);
        continue;
      }
      // Mixed command buffer: no observe/mutate projection was installed.
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

Because `runMixedIteration(...)` is detached from the immediate caller, it must attach rejection handlers, mark the task handled, and report fatal errors through the owning render state or buffer context. Rejecting the completion record is not enough when Stage 2 callers intentionally do not await `observeDone`. Inherited Stage 2 iterations must not end by awaiting `observerState.drain()` because that would wait on ancestor or later-parent observations and keep a useless child coroutine alive.

The `for await` loop is the clarity shape. The iterator handles waiting for appended entries and lane finish; the scheduling method handles observe/mutate/iterate semantics. Stage 3 replaces this with a non-`async` outer loop so synchronously-ready entries do not allocate a promise or take a microtask hop per entry.

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

`CommandIterator` is the narrow input iterator for one buffer lane. It is not a scheduler and it does not know about observe/mutate/iterate semantics or pending observers. It owns only:

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

`_nextReadyEntry()` reads `buffer.arrays[chainName][nextIndex]`, increments `nextIndex` only when an entry exists, and yields entries in source order. `_waitForAppendOrFinish()` parks only when the iterator has reached the current end of an unfinished lane. `_isClosedAndConsumed()` becomes true when `finishChain(chainName)` has closed the lane and every appended entry has been yielded.

`finishChain(chainName)` means input is closed, not that all work has completed. Work completion is separate:

- iterator input closed: no more entries will be appended
- iterator input consumed: all appended entries have been yielded after input closure
- chain completion: root/owner final state is stable enough to materialize
- `iterate(...).mutateDone`: mixed child mutation work is complete
- owned `iterate(...).observeDone`: the owned observer state has drained after iterator input is consumed

`CommandIterator` can be woken by the same notification lifecycle that replaces the current iterator hooks:

- `_notifyCommandOrBufferAdded(...)`
- `_notifyChainFinished(...)`
- `onCommandOrBufferAdded(...)`
- `onBufferFinished(...)`

Use one active lane-execution registry for append/finish wakeups and fatal shutdown fan-out. Multiple indexes over the same lane execution are fine, but do not create independent wakeup and fatal registries that can drift out of sync.

### Stage 3 Sync-First Execution

Stage 3 is not only about `CommandIterator`. It makes the whole scheduler sync-first:

- `CommandIterator` returns a ready entry synchronously when one exists.
- `observe(...)` and `mutate(...)` return non-thenable resolved values when all work finishes synchronously.
- `iterate(...)` returns its completion record immediately; its `mutateDone` and `observeDone` fields may be non-thenable resolved values.
- call sites check for thenables before composing waits.

The async iterator form can remain for clarity or tests. Hot scheduler loops use a non-`async` pull method:

```js
const next = iterator.nextReady();
```

`nextReady()` returns one of three shapes:

- a command or child buffer entry when an entry is synchronously available
- a thenable when the lane is currently exhausted but still open
- `null` when the lane is closed and all appended entries have been yielded

The scheduler loop then composes sync-first phase completions:

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

Expected Stage 2 schedule:

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

Stage 1 parent scheduling does not use:

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

The root buffer has no parent scheduler. It starts lanes with owned state:

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

Use `start(chainName)` for the lane-scoped helper that dispatches to the buffer's own scheduler method and resolves the chain completion gate. Do not add a whole-buffer execution helper to the base scheduler design. `finalSnapshot()` must not be forced to wait for unrelated trailing observations.

## Result Promise vs Phase Completion

Keep result promises and scheduler phase completions separate.

For example, a snapshot command has:

- a public result promise returned by `addCommand(...)`
- an `observe()` phase completion that tells the scheduler when applying the snapshot observation is complete

The public result may settle inside the phase:

```js
observe(chain) {
  this.settleResult(chain._makeSnapshot(this.errorContext));
}
```

The scheduler should use the public result promise as phase completion only if the command intentionally returns that same promise from `observe()`.

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

1. Extend generic analysis with `observedChains`, `observedChainsFromParent`, and `linkedObservedChains`.
2. Enforce `linkedChains = linkedObservedChains union linkedMutatedChains` for linked child buffers.
3. Use finalized parent-visible lane facts to install `observe()` or `mutate()` projections on uniform child buffers.
4. Add single-start void `start(chainName)` that dispatches once to the buffer's own `observe(...)`, `mutate(...)`, or `iterate(...)` method and resolves existing chain completion from that return value.
5. Add `ObserverState` with `track(...)`, sync-first `drain()`, `pendingObservers`, and `pendingObserversEmpty`.
6. Replace the recursive `BufferIterator` traversal with a narrow `CommandIterator` async iterator for next-entry, append wakeup, input closure, and fatal wakeup.
7. Connect `CommandIterator` wakeups to appended entries and `finishChain(...)`.
8. Route observe-only child buffers through `observe()` projections.
9. Route mutate-only child buffers through `mutate()` projections.
10. Route mixed child buffers through `iterate(...)`; Stage 1 passes a fresh observer state and waits for full completion.
11. Replace `BufferIterator` use from `Chain` with the root lane start point.
12. Preserve cleanup, completion, and fatal rejection behavior.

Stage 2:

1. Add focused mixed-buffer concurrency tests.
2. Route mixed child buffers through `iterate(...)` with inherited observer state instead of a fresh Stage 1 observer state.
3. Wait only for child `mutateDone` in the Stage 2 parent path.
4. Leave inherited child `observeDone` undefined or non-thenable resolved; do not compute it by terminally draining the shared observer state.
5. Let following parent mutables drain the shared observer state.
6. Remove the obsolete `BufferIterator` implementation and rename leftover iterator-specific names/state, such as `_resolveIteratorCompletion`.

Stage 3:

1. Add `CommandIterator.nextReady()` for the non-`async` iterator fast path.
2. Replace hot `for await` scheduler loops with sync-first outer loops.
3. Make command-buffer `observe(...)` and `mutate(...)` return non-thenable resolved values on synchronous paths.
4. Allow `iterate(...)` completion fields to be non-thenable resolved values.
5. Replace every `await` on possibly non-thenable phase completion with an explicit thenable check.
6. Keep the async iterator form only as a clarity/test adapter if useful.
7. Preserve collect-all-errors behavior in observe-only projection loops.
8. Preserve fire-and-forget rejection reporting for detached iteration tasks.

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
- Stage 1 mixed child blocks until full completion
- Stage 2 mixed child exposes residual observation work after mutations finish
- Stage 2 A-F schedule is preserved: start A, start B, wait A+B, run C, start D, start E, wait D+E, run F
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
