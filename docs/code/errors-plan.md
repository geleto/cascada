# Output Error Model Refactor Plan

This document defines the target error model for typed outputs (`data`, `text`, `value`, `sink`, `sequence`) and a migration plan that keeps the test suite green after every step.

## Goal

Replace legacy command-history poison collection with `_target`-state-based error inspection so recovered outputs are no longer sticky-poisoned.

Required output APIs:

- `snapshot()`
- `isError()`
- `getError()`

Primary semantics:

- Output health is derived from current `_target` state at observation time.
- Repairing `_target` clears output error state when no poison remains.
- `is error` and guard/recover checks for outputs must use output APIs, not command-buffer poison history.
- `#` on outputs must use `getError()` semantics.
- All output observations (`snapshot/isError/getError`) must execute through observation commands, including facade method calls.

## Current Problems

1. Output poison is sticky in `Output._errors` even after later writes repair `_target`.
2. Guard output error detection uses `CommandBuffer.getPosonedBufferErrors(...)`, which scans history, not current state.
3. Generic `runtime.isError(value)` and `runtime.peekError(value)` do not recognize output facades.
4. Repeated `snapshot()/isError()/getError()` can be expensive without caching.

## Target Model

## 1. `_target` Is the State Source of Truth

- `_target` always represents the current snapshot state for that output.
- `snapshot()` returns `_target` (output-specific finalization rules may map sink internals before assigning `_target`).
- `isError()` and `getError()` are derived from `_target`.
- `Output._errors` is removed as an authoritative health source.

Accessor decision:

- Introduce centralized target access hooks in `Output`:
  - `_getTarget()`
  - `_setTarget(nextTarget, meta?)`
- `_setTarget` is the single place that:
  - updates target value
  - bumps state version/invalidation
  - applies output-type hooks (for copy-on-write/snapshot semantics)
- Concrete outputs may customize behavior behind these hooks, but command classes should not bypass them.

Important constraints:

- This model assumes command semantics ensure poison is represented in `_target` when the output should be considered poisoned.
- If a command fails but does not update `_target`, that failure is not persistent output poison (unless encoded into `_target` by output implementation).

## 2. Why `resolveSingle` Alone Is Not Enough

`resolveSingle` is useful for top-level resolution and `RESOLVE_MARKER` objects, but insufficient for whole-output health by itself:

- It does not recursively scan arbitrary plain object/array graphs for nested poison unless marker-managed.
- `DataOutput` often contains plain mutable objects from data handlers.

Conclusion:

- Keep `resolveSingle` as a primitive for top-level settling.
- Add `inspectTargetForErrors(target)` for recursive poison detection in `_target` graphs.

## 3. Output Observation Contract

On base `Output` and exposed through facades:

- `snapshot()`:
  - Point-in-stream via command scheduling, returns current output value.
  - Throws `PoisonError` when `_target` currently contains poison.
- `isError()`:
  - Returns true if `_target` currently contains poison.
  - No deep-copy.
- `getError()`:
  - Returns `PoisonError` for current `_target` poison state; otherwise `null`.
  - `#` invalid-peek behavior (healthy target -> poison) remains a compiler/runtime callsite rule, not default `getError()` behavior.

Execution rule:

- Even when facade exposes these methods, calls must enqueue and execute through observation commands.
- No direct read path may bypass command ordering.

## 4. Observation Synchronization: Commands, Not `_tail`

Do not add a separate `_tail`/`_lastResult` barrier field.

Use command ordering only:

- Keep observation operations queued (`SnapshotCommand`, new `IsErrorCommand`, new `GetErrorCommand`).
- Iterator ordering ensures each observation runs after all prior commands for that handler segment.
- Direct facade calls must enqueue observation commands through `CommandBuffer`.

This avoids dual state and keeps source-order semantics deterministic.

## 5. `inspectTargetForErrors(target)` Rules

Shared helper (in `output.js` or helper module):

- Detect `PoisonedValue` via `isPoison` and collect `.errors`.
- Resolve promise-like values while collecting all failures (never-miss-any-error behavior).
- Recursively inspect arrays and plain objects.
- Deduplicate errors with existing error helpers.
- Track visited objects to avoid cycles.
- Return `{ hasError, error }` where `error` is a single `PoisonError` containing all collected errors.

Output-type policy:

- `DataOutput`: recursive inspect of `_target`.
- `TextOutput`: inspect `_target` fragment array.
- `ValueOutput`: inspect scalar `_target` (recursive if object/array).
- `SinkOutput`: fixed policy, sink health is `_target`-driven and sink failures poison `_target`.
- `SequenceOutput`: no mandatory global poison behavior; state poison is optional and implementation-defined via `_target`.

## 6. Caching and Versioning

Introduce output-local cache keyed by monotonic version:

- `_stateVersion`
- `_inspectCacheVersion`
- `_inspectCacheHasError`
- `_inspectCacheErrors`
- `_inspectCachePoisonError`

Invalidation on any `_target`-affecting change:

- command apply that writes/replaces `_target`
- `SetTargetCommand`
- guard restore/clear/revert affecting output state

Cache abstraction requirement:

- Cache lifecycle must be owned by `Output` base (not by command implementations).
- Custom sink/sequence/data/value implementations interact through hooks only:
  - `_setTarget(...)` for state mutation
  - `_inspectTargetForErrors(...)` or override points for specialized inspection
- This keeps cache correctness independent of concrete sink/sequence object internals.

Read path:

- `snapshot()/isError()/getError()` use shared `ensureInspection()`.
- If cache version matches, reuse.
- Else recompute from `_target` and refresh cache.

Mutation safety:

- cache copied/frozen errors array
- `getError()` returns `PoisonError` built from copied errors (or cached instance built from immutable copy)

Copy policy by output type:

- `DataOutput`: snapshot copy-on-write for returned values, but error inspection should avoid deep cloning where possible.
- `ValueOutput`: no deep snapshot copy by default; inspection reads value directly.
- `TextOutput`: no deep clone for inspection.
- `SinkOutput`/`SequenceOutput`: inspection must not assume object cloneability; inspect `_target` only.

## 7. Command-Class Changes (Critical)

This is the core of proper `_target` handling.

### 7.1 `OutputCommand` Base (`src/runtime/commands.js`)

Current behavior throws early via `getError()` before `apply` mutates output. That must change.

New behavior:

- `OutputCommand.apply(dispatchCtx)` must not throw just because arguments contain poison.
- It must delegate to concrete command semantics that update `_target` consistently.
- Add helper APIs:
  - `extractPoisonFromArgs()` -> `Error[]`
  - `toPoisonValue(errors)` -> `createPoison(errors)`

Rationale: poisoning must be represented in `_target`, not in side-channel `_errors`.

### 7.2 `DataCommand`

When args/path contain poison:

- Do not throw.
- Write poison value into addressed path in `_target` (or equivalent data-handler operation).
- This ensures later healthy overwrite repairs state.

When healthy:

- apply method normally, update `_target` with `DataHandler.data`.

### 7.3 `TextCommand`

When args contain poison:

- append poison as value in text target representation (or an agreed poison placeholder strategy that preserves poison in `_target`).
- do not throw during apply.

When healthy:

- append normally.

### 7.4 `ValueCommand`

Argument contract:

- `ValueCommand` accepts exactly one argument in normal usage.
- Compiler should enforce one argument where possible.
- Runtime fallback:
  - 0 args -> set `undefined` (or preserve current behavior if already relied on; lock with tests)
  - >1 args -> encode poison in `_target` (invalid command usage) rather than silent last-arg wins

When args contain poison:

- set `_target` to poison value.

When healthy:

- set `_target` to the single argument value.

### 7.5 `SinkCommand`

Sink poisoning policy (fixed):

- If any sink method fails, `_target` becomes `PoisonedValue`.
- Once sink `_target` is poisoned, subsequent sink calls are skipped.
- `sink.repair()` is required at output-runtime layer:
  - default behavior: set `_target = undefined`
  - if underlying sink object has `repair()`, call it; it may repair internal state but does not own `_target` reset.

### 7.6 `SequenceCallCommand` / `SequenceGetCommand`

Sequence policy (fixed):

- Method-level failures may be independent; one failed call does not automatically poison all subsequent sequence calls.
- Whether sequence maintains poisoned state is implementation-defined via `_target`.
- If implementation chooses stateful poison, it must encode/read it from `_target`; if not, keep `_target` clean and treat failures as call-level only.

### 7.7 `ErrorCommand`

Transition role (restricted):

- Do not use `ErrorCommand` for `data` or `text` outputs in the new model.
- Prefer encoding poison directly in concrete output commands.
- Keep only as compatibility fallback for legacy plumbing and non-output contexts.
- Long term: remove from output flow.

Evaluation of use cases:

- Keep only where producer-side async slot plumbing has no output-specific context to encode path/target poison directly.
- If all producer paths can emit output-specific commands (preferred end-state), remove `ErrorCommand` entirely.
- Decision checkpoint: after Step 3, if no remaining legitimate callers for output flow, delete `ErrorCommand` usage in output buffers.

### 7.8 Observation Commands

Add commands:

- `IsErrorCommand`
- `GetErrorCommand`

They:

- execute in stream order
- call output observation helpers
- resolve deferred result promises
- do not mutate `_target`

`SnapshotCommand` remains barrier/observation command.

### 7.9 Per-Class Pseudocode Checklist (`src/runtime/commands.js`)

This checklist is keyed to the current classes/methods and is intended to be implemented in small, test-safe commits.

#### A. `Command` base

Target methods:

- `constructor(options)`
- `resolveResult(value)`
- `rejectResult(err)`
- `getError()`
- `apply(ctx)`

Pseudocode:

```javascript
class Command {
  // keep as-is for deferred result plumbing
  // no poison-specific behavior here
}
```

Notes:

- no semantic change required, except optional `supersedes/mergeWith` hooks in later step.

#### B. `OutputCommand` base

Target methods:

- `constructor(...)`
- `getError()` (legacy)
- `apply(dispatchCtx)`
- new: `extractPoisonFromArgs()`
- new: `toPoisonValue(errors)`

Pseudocode:

```javascript
class OutputCommand extends Command {
  extractPoisonFromArgs() {
    // collect poison from this.arguments only
    // return [] if none
  }

  toPoisonValue(errors) {
    // return createPoison(errors)
  }

  getError() {
    // transitional: keep for compatibility only
    // do NOT use as apply gate
    const errs = this.extractPoisonFromArgs();
    return errs.length ? new PoisonError(errs) : null;
  }

  apply(dispatchCtx) {
    // IMPORTANT: no early throw from arg poison.
    // concrete commands decide how poison is encoded in _target.
  }
}
```

Required invariant:

- `OutputCommand.apply()` must never throw solely because an argument is poison.

#### C. `TextCommand.apply(dispatchCtx)`

Current behavior:

- calls `super.apply()` then validates/appends scalar args
- poison arg currently triggers throw via base

Pseudocode:

```javascript
apply(dispatchCtx) {
  const target = dispatchCtx._getTarget();
  ensure target is array;

  const poisonErrors = this.extractPoisonFromArgs();
  if (poisonErrors.length > 0) {
    target.push(createPoison(poisonErrors));
    dispatchCtx._setTarget(target);
    return;
  }

  for each arg in arguments:
    validate supported text-like types
    append arg to target
  dispatchCtx._setTarget(target);
}
```

Decision point to lock in with tests:

- if arguments contain both healthy scalars and poison, either:
  - append only combined poison marker (recommended for determinism), or
  - append scalars and poison in source order.
- pick one policy and test it explicitly.

#### D. `ValueCommand.apply(dispatchCtx)`

Pseudocode:

```javascript
apply(dispatchCtx) {
  if (!dispatchCtx) return;

  if (arguments.length > 1) {
    dispatchCtx._setTarget(createPoison([new Error('value output accepts exactly one argument')]));
    return;
  }

  const poisonErrors = this.extractPoisonFromArgs();
  if (poisonErrors.length > 0) {
    dispatchCtx._setTarget(createPoison(poisonErrors));
    return;
  }

  dispatchCtx._setTarget((arguments.length === 1) ? arguments[0] : undefined);
}
```

#### E. `DataCommand.apply(dispatchCtx)`

Current behavior:

- calls base apply (currently throws on poison)
- calls DataHandler method

Pseudocode:

```javascript
apply(dispatchCtx) {
  if (!dispatchCtx || !dispatchCtx._base) return;

  const poisonErrors = this.extractPoisonFromArgs();
  if (poisonErrors.length > 0) {
    // encode poison into addressed path, no throw
    // path is arguments[0] in data command ABI
    const path = this.arguments[0];
    const poison = createPoison(poisonErrors);
    dispatchCtx._base.set(path, poison); // or equivalent helper
    dispatchCtx._setTarget(dispatchCtx._base.data);
    return;
  }

  const method = resolve data handler method by this.command;
  if (method missing) {
    // encode poison into addressed path instead of throwing
    // (unknown method is represented as poison in target model)
  }

  method.apply(dispatchCtx._base, this.arguments);
  dispatchCtx._setTarget(dispatchCtx._base.data);
}
```

Implementation note:

- if `DataHandler` does not expose a direct `set(path, value)` for all paths, add a small runtime helper to perform poison write reliably.

#### F. `SinkCommand.apply(dispatchCtx)`

Fixed behavior:

- on first sink failure, set `_target` to poison
- while poisoned, skip subsequent sink calls
- support explicit sink repair via `SinkRepairCommand` that resets `_target` to `undefined` and invokes underlying `sink.repair()` when available

Pseudocode:

```javascript
apply(dispatchCtx) {
  if (isPoison(dispatchCtx._getTarget())) return; // skip while poisoned
  // execute sink call
  // on failure: dispatchCtx._setTarget(createPoison(...))
}
```

Add explicit tests for this fixed sink policy.

#### G. `SequenceCallCommand.apply(dispatchCtx)` and `SequenceGetCommand.apply(dispatchCtx)`

Pseudocode (sequence policy is independent from sink):

```javascript
apply(dispatchCtx) {
  // preserve deferred promise behavior
  // failures do not globally poison sequence by default
  // optional implementation may track state poison in _target
}
```

Non-negotiable:

- do not break existing deferred `this.promise` resolve/reject behavior.

#### H. `ErrorCommand.apply(ctx)`

Current behavior throws `PoisonError`. New flow should avoid this command for `data/text`.

Transitional pseudocode (legacy/fallback only):

```javascript
apply(ctx) {
  throw new PoisonError(this.errors);
}
```

Long-term:

- remove `ErrorCommand` from normal output path once producer-side commands encode poison directly.

#### I. `SnapshotCommand.apply(dispatchCtx)`

No structural change, but expectation changes:

- it should now rely on output `snapshot` logic that reads `_target` + inspection cache.
- it remains a strict observation barrier.

#### J. New `IsErrorCommand` and `GetErrorCommand`

Suggested shape:

```javascript
class IsErrorCommand extends Command {
  constructor({ handler, pos }) { super({ withDeferredResult: true }); ... }
  apply(dispatchCtx) {
    const res = dispatchCtx._isErrorNow(); // internal helper, may be bool or promise
    Promise.resolve(res).then(v => this.resolveResult(!!v), e => this.rejectResult(contextualize(e)));
  }
}

class GetErrorCommand extends Command {
  constructor({ handler, pos }) { super({ withDeferredResult: true }); ... }
  apply(dispatchCtx) {
    const res = dispatchCtx._getErrorNow(); // internal helper, PoisonError|null or promise
    Promise.resolve(res).then(v => this.resolveResult(v), e => this.rejectResult(contextualize(e)));
  }
}
```

Compiler/CommandBuffer integration checklist:

- add `CommandBuffer.addIsError(outputName, pos)`
- add `CommandBuffer.addGetError(outputName, pos)`
- add `CommandBuffer.addSinkRepair(outputName, pos)` for sink recovery command path
- compiler routes output `is error` and output `#` through these observation commands.
- facade methods `snapshot()/isError()/getError()` must route through the same command path.
- sink `repair()` calls (including facade method) must route through command path.

## 8. Guard and Compiler Semantics

Guard:

- `runtime.guard.getErrors(...)` collects output errors via `output.isError()` + `output.getError()`.
- remove dependency on `getPosonedBufferErrors(...)` for output decisions.

Compiler:

- `is error` on output symbols/paths emits output-aware path (command/API based).
- `#` on outputs emits output `getError()` path.

## 9. Command Coalescing (`supersedes` / `mergeWith`)

Introduce extension points:

- `supersedes(prev)` for redundant replacement
- `mergeWith(prev)` for future algebraic merge

What `supersedes` means (detailed):

- `next.supersedes(prev) === true` means:
  - `prev` can be dropped from the queue without observable behavior change.
  - any externally observable promise/result from `prev` must still resolve/reject correctly (either by aliasing to `next` or by disallowing supersede).
- Typical examples:
  - repeated unconsumed observation commands where only latest matters.
  - idempotent overwrite commands where intermediate state is unobservable.
- Non-examples:
  - commands separated by observation barriers
  - commands with side effects that must execute
  - commands whose deferred promises are already exposed.

Barriers:

- child buffers
- pause/resume boundaries
- guard rollback boundaries
- commands with externally observed deferred promises
- observation commands

Initial rollout:

- no merges
- conservative supersede only where promise semantics are unchanged

Related term:

- `mergeWith(prev)` differs from `supersedes(prev)`:
  - `supersedes`: drop one command.
  - `mergeWith`: produce a new combined command that preserves semantics.

## Test Strategy

At each step:

1. add/adjust focused tests
2. run targeted file(s)
3. run `npm run test:quick`

Targeted-file example:

- `npx mocha tests/output/error-observation-baseline.js --timeout 5000`

Final gate for this plan:

- `npm run test:quick`

## Step-by-Step Implementation Plan

## Step 0: Safety Net Tests (No Behavior Change)

- Characterization tests for current snapshot/guard/`is error`/`#` behavior.
- Add baseline file: `tests/output/error-observation-baseline.js`.

Gate:

- `test:quick` green.

## Step 1: Add `_target` Inspection + Cache Internals

Scope:

- add `inspectTargetForErrors`
- add version/cache fields and invalidation helpers
- no compiler/guard behavior changes yet

Gate:

- `test:quick` green.

## Step 2: Refactor Command Classes for `_target` Poison Encoding

Scope:

- modify `OutputCommand` contract (no early throw-on-poison)
- update `DataCommand`/`TextCommand`/`ValueCommand` poison behavior
- enforce sink poison/skip/repair behavior
- keep sequence behavior independent from sink
- restrict `ErrorCommand` to legacy fallback paths

Gate:

- `test:quick` green.

## Step 3: Add Output Observation APIs + Commands

Scope:

- implement `output.snapshot()/isError()/getError()` through command path only
- add `IsErrorCommand` and `GetErrorCommand`
- ensure facade methods also route through commands

Key regression target:

- `data.x = errorFunction()` then `data.x = "ok"` yields healthy output.

Gate:

- `test:quick` green.

## Step 4: Guard Switch to Output APIs

Scope:

- replace output history scan with output `isError/getError`
- keep variable/sequence checks intact

Gate:

- guard regression matrix green.

## Step 5: Compiler Wiring for `is error` / `#` on Outputs

Scope:

- output-aware emission for tests/peek
- ensure `recover err` receives final `PoisonError` from output state

Gate:

- script + poison tests green.

## Step 6: Remove `Output._errors` from Health Semantics

Scope:

- decommission `_errors` usage in snapshot/error checks
- remove command-history output poison dependency

Gate:

- `test:quick` green.

## Step 7: Conservative Supersede Infrastructure

Scope:

- add `supersedes` hook and safe eliminations for redundant observation commands
- keep `mergeWith` scaffold off by default

Gate:

- queue semantics tests + `test:quick` green.

## Step 8: Cleanup + Docs

Scope:

- mark/remove legacy `getPosonedBufferErrors` output path
- update docs (`output.md`, `script.md`, this file)

Gate:

- `test:quick` green.

## Acceptance Criteria

1. Repaired `_target` state is healthy.
2. `recover` triggers only for final unrepaired guarded errors.
3. `recover err` is deterministic and based on final output state.
4. `is error` on outputs reflects current `_target`, not history.
5. `#` on outputs reads final `PoisonError` from current state.
6. Repeated probes amortized via version cache.
7. No regressions in sequence/sink behavior according to chosen `_target` policy.

## Risks and Mitigations

Risk: incorrect poison encoding in command classes causes hidden regressions.
Mitigation: command-level tests per type before guard/compiler integration.

Risk: stale cache due to missed invalidation.
Mitigation: central `markStateChanged()` and tests asserting version increments.

Risk: sequence policy ambiguity.
Mitigation: sink policy is fixed in this plan; sequence policy must be explicitly documented and tested in implementation PRs.

## Change-Control Rule

If implementation work reveals a cleaner or more efficient approach that materially contradicts this document:

1. stop at the decision point,
2. document the contradiction and tradeoff briefly,
3. consult with the user before proceeding with that divergence.
