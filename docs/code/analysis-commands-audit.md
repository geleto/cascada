# Analysis ↔ Command Classification Audit

## Purpose

Verify that every `analyze*` method in the compiler correctly classifies output
interactions as `uses` (read) or `mutates` (write) in alignment with the
`isObservable` / `mutatesOutput` flags on the runtime `Command` objects those
methods cause to be emitted.

A mismatch means the analysis layer advertises different read/write semantics
than the command that actually executes at runtime. This breaks async block
linkage, copy-on-write protection, and the buffer-iterator's observable vs
mutable routing.

---

## Command flags reference

Two boolean flags on every `Command` instance drive runtime behavior:

- **`mutatesOutput`** — set to `true` on `OutputCommand` base class; overridden
  to `false` on read-only commands. Triggers `DataOutput._beforeApplyCommand`
  copy-on-write cloning before the command runs.
- **`isObservable`** — `false` by default; set to `true` on commands that carry
  a deferred result promise. Routes through `BufferIterator._applyObservable`
  instead of `_applyMutable`.

---

## Full classification table

| Command | `mutatesOutput` | `isObservable` | Analysis path | Analysis records | Match |
|---|---|---|---|---|---|
| `TextCommand` | true | false | `analyzeOutput` | uses + mutates | ✅ |
| `ValueCommand` | true | false | `analyzeSet` / `analyzeMacro` | uses + mutates | ✅ |
| `DataCommand` | true | false | `analyzeOutputCommand` | uses + mutates | ✅ |
| `SinkCommand` | true | false | `analyzeOutputCommand` | uses + mutates | ✅ |
| `SequenceCallCommand` | true | false | `analyzeFunCall` / `analyzeOutputCommand` | uses + mutates | ✅ |
| `SequenceGetCommand` (via `analyzeLookupVal`) | false | true | `analyzeLookupVal` | uses only | ✅ |
| `SequenceGetCommand` (via `analyzeOutputCommand`, non-call) | false | true | `analyzeOutputCommand` | **uses + mutates** | ❌ |
| `SnapshotCommand` | false | true | `analyzeFunCall` (snapshot) / `analyzeSymbol` | uses only | ✅ |
| `RawSnapshotCommand` | false | true | synthetic | N/A | — |
| `IsErrorCommand` | false | true | `analyzeFunCall` (isError) | uses only | ✅ |
| `GetErrorCommand` | false | true | `analyzeFunCall` (getError) | uses only | ✅ |
| `SequentialPathReadCommand` | false | true | `analyzeSymbol` / `analyzeLookupVal` (lock lookup) | uses only (`!` key) | ✅ |
| `SequentialPathWriteCommand` | true | false | `analyzeFunCall` (lock call) | uses + mutates (`!` key) | ✅ |
| `WaitResolveCommand` | **true** (inherited) | false | synthetic — no analysis path | N/A | ⚠️ |
| `ErrorCommand` | false | false | synthetic | N/A | — |
| `TargetPoisonCommand` | true | false | synthetic | N/A | — |
| `CaptureGuardStateCommand` | false | true | runtime only (`guard.js`) | N/A | — |
| `SinkRepairCommand` | true | false | runtime only (`guard.js`) | N/A | — |
| `RestoreGuardStateCommand` | false | false | runtime only (`guard.js`) | N/A | — |

---

## Issue 1 — `__checkpoint` in observation lists but no compile path

### What analysis says

Both `analyzeFunCall` (`compiler-base.js`) and `analyzeOutputCommand`
(`compiler.js`) include `__checkpoint` in the observation method list:

```javascript
// analyzeFunCall (compiler-base.js)
isObservation:
    sequencePath.length === 2 &&
    (methodName === 'snapshot' || methodName === 'isError' ||
     methodName === 'getError' || methodName === '__checkpoint')

// analyzeOutputCommand (compiler.js)
const isObservation = callNode &&
    path.length === 2 &&
    (path[1] === 'snapshot' || path[1] === 'isError' ||
     path[1] === 'getError' || path[1] === '__checkpoint');
```

Both return `{ uses: [handler] }` for `__checkpoint` — read-only, no mutation.

### What compilation does

`_compileOutputObservationFunCall` only handles `snapshot`, `isError`, and
`getError`. It returns `false` for `__checkpoint`.

Control falls through to `_compileSequenceOutputFunCall`. For a sequence
output, this emits `SequenceCallCommand` (`mutatesOutput = true`) — **a
mutation**, contradicting the analysis. For a non-sequence output,
`_compileSpecialOutputFunCall` returns `false` entirely and no command is
emitted, making the output interaction invisible at runtime.

`__checkpoint` has no tests and no documentation. It is either a
planned-but-unimplemented feature or dead code in both observation lists.

### Fix

Remove `__checkpoint` from both observation lists until a compile path is
implemented that emits the correct command type with matching semantics.

---

## Issue 2 — `analyzeOutputCommand`: non-call sequence access classified as mutation

### What analysis says

`analyzeOutputCommand` determines observation vs mutation using:

```javascript
const isObservation = callNode &&   // <-- null for non-call access
    path.length === 2 &&
    (path[1] === 'snapshot' || ...);
return isObservation ? { uses: [handler] } : { uses: [handler], mutates: [handler] };
```

For a non-call expression such as `output_command mySeq.property`, `callNode`
is `null`, so `isObservation = false` and the function returns
`{ uses, mutates }`.

### What compilation does

`_compileCommandConstruction` for a non-call sequence output emits
`SequenceGetCommand` (`isObservable = true`, `mutatesOutput = false`) — a
read-only command. The analysis record does not match.

### Practical impact

Sequence property reads in practice go through expressions
(`var x = mySeq.property` → `analyzeLookupVal`, which is correct), not through
output command directives. This code path is probably unreachable today.
Nevertheless the logic is structurally wrong and would misclassify if reached.

### Fix

Extend the observation check to cover the non-call sequence read case:

```javascript
const outputDecl = handler ? analysisPass.findDeclaration(node._analysis, handler) : null;
const isSequenceGet = !callNode && outputDecl && outputDecl.type === 'sequence';
const isObservation = isSequenceGet ||
    (callNode && path.length === 2 &&
     (path[1] === 'snapshot' || path[1] === 'isError' || path[1] === 'getError'));
```

---

## Issue 3 — `WaitResolveCommand.mutatesOutput = true` (wrong runtime flag)

### Current state

`WaitResolveCommand extends OutputCommand`, inheriting `mutatesOutput = true`.
The `OutputCommand` base class sets this flag unconditionally in its
constructor.

### Effect

`DataOutput._beforeApplyCommand` checks `cmd.mutatesOutput` to decide whether
to clone the current target before applying a command (copy-on-write
protection). A `WaitResolveCommand` arriving after a snapshot will
unnecessarily trigger a full clone of the data object. For large nested data
structures this is a performance regression with no semantic benefit.

The analysis-audit document already calls this out:

> Register as usage, not mutation: waited commands are bookkeeping and
> should not participate in output-mutation wrapping decisions.

### Fix

Override in `WaitResolveCommand` constructor:

```javascript
this.mutatesOutput = false;
```

`WaitResolveCommand.apply()` does call `output._setTarget(resolved)` to store
the resolved iteration value, but this is internal timing plumbing and does not
represent an observable mutation of the output's public data content.

---

## Commands with no analysis path (synthetic / runtime-only)

These commands are emitted by runtime helpers or the buffer system, not by any
`analyze*` method. They do not create analysis/compile mismatches but are
listed here for completeness.

| Command | Emitted by | Notes |
|---|---|---|
| `ErrorCommand` | `addPoisonMarkersToBuffer` | Poison marker; `mutatesOutput = false` |
| `TargetPoisonCommand` | compiler guard/branch emit | Writes poison into output; `mutatesOutput = true` correct |
| `RawSnapshotCommand` | buffer helper | Observation read; `isObservable = true` correct |
| `CaptureGuardStateCommand` | `guard.js` | Observation read of guard state; `isObservable = true` correct |
| `SinkRepairCommand` | `guard.js` | Repairs sink; `mutatesOutput = true` correct |
| `RestoreGuardStateCommand` | `guard.js` | Restores guard state; `mutatesOutput = false` — see note below |

### Note on `RestoreGuardStateCommand`

`RestoreGuardStateCommand` calls `output._restoreGuardState()`, which replaces
the output's internal target with a previously captured snapshot. This is
semantically a mutation but `mutatesOutput = false`, so it does not trigger
copy-on-write protection in `DataOutput`.

This is likely intentional: the guard capture/restore pair is designed to
overwrite the current state back to a known checkpoint, not to incrementally
mutate it. Copy-on-write protection is not needed because no externally shared
snapshot exists of the state being restored over — the restore is always the
dominant write.

---

## Summary

| Issue | Severity | File | Lines |
|---|---|---|---|
| `__checkpoint` in observation lists — no compile path, causes wrong command on sequence outputs | Medium — semantic mismatch, likely dead code | `compiler-base.js`, `compiler.js` | 953, 1992 |
| `analyzeOutputCommand` classifies non-call sequence get as mutation | Low — path probably unreachable today | `compiler.js` | 1984–1993 |
| `WaitResolveCommand.mutatesOutput = true` — triggers unnecessary copy-on-write | Low-Medium — performance only, no correctness impact | `commands.js` | 248–277 |
