# Documentation Review: Staged Changes

This document reviews the seven staged documentation changes against the actual
implementation. Each section gives an accuracy verdict, what's correct, what's
wrong or missing, and specific recommendations.

**Priority convention used below:**
- **Correctness fix** — the document says something false or misleading; must change.
- **Should restore** — real information was lost in the rewrite; worth adding back.
- **Optional breadth** — dropped examples or patterns that are useful but not wrong.

---

## Error Handling Patterns In Script.md

### Verdict: Good — one correctness risk, optional dropped patterns

### What's correct
All key syntax forms verified against `docs/cascada/script.md`:
- `data out` declaration ✓
- `return out.snapshot()` ✓
- `sequence db = context.db` ✓
- `guard out, db!` ✓
- `context.api!!` repair operator ✓
- `result#message` / `result#source` peek syntax ✓
- `function ... endfunction` ✓

The new Core Rules section and Anti-Patterns section are accurate and useful
additions that the old document lacked entirely.

### Correctness fix
- **`sleep()` is used in the retry example but does not appear anywhere in `src/`,
  tests, or `script.md` global functions.** If it is not a real built-in, the
  example is broken. Either verify it exists and document it in `script.md`, or
  replace it with a host-provided comment (`// await host-provided delay`).

### Optional breadth (not correctness issues)
- The retry pattern changed from exponential backoff (`100 * (2 ** attempt)`) to
  linear backoff (`100 * attempt`). A one-sentence note on the intent would help,
  but the example is not wrong.
- The "Retry Loop with Guard" pattern (retry inside a guard with per-attempt state
  rollback) was dropped. It is a distinct use case from sequential path repair and
  would be a useful addition, but its absence does not make the document incorrect.
- The batch processing example dropped the post-loop summary field. Minor optional
  breadth.
- The "Transaction With Guard" example could gain a one-line comment noting that
  sequential paths are automatically repaired on guard exit.

---

## caller.md

### Verdict: Excellent — ~95% accurate, minor gaps only

### What's correct
All major architectural claims verified against `src/compiler/macro.js` and
`src/runtime/command-buffer.js`:
- `CALLER_SCHED_CHANNEL_NAME = "__caller__"` ✓ (macro.js:6)
- Three-level ownership model (Macro Buffer / All-Callers Buffer / Per-Invocation
  Buffers) fully matches implementation ✓
- `WaitResolveCommand` used for `__caller__` timing bookkeeping ✓
- `CommandBuffer.getFinishedPromise()` exists ✓ (command-buffer.js:85)
- `addSnapshot("__caller__", {...})` → await → `allCallersBuffer.markFinishedAndPatchLinks()` finalization sequence ✓
- `_macroUsesCaller()` detection, `__callerUsedChannels` metadata ✓
- All Runtime/Compiler Touchpoints verified ✓
- `__caller__` vs `__waited__` distinction is accurate ✓

The rewrite from design proposal to current-state description is the right
approach. The old document was a planning artifact; this is a proper architecture
reference.

### Should restore
- The implementation adds **two** WaitResolveCommands per caller invocation
  (macro.js lines 40-43, 219-224): one for `invocationBuffer.getFinishedPromise()`
  (structural completion) and one for the invocation result settling via `.finally()`.
  The document only describes the structural one. A sentence on the dual tracking
  matters for anyone debugging caller timing.
- The `macroParentBuffer` parameter passed to the compiled macro function is not
  mentioned. It is how the all-callers buffer gets its parent reference at call
  time — one sentence would complete the picture.

---

## expression-channels.md

### Verdict: Mostly correct — one inaccuracy about observation commands, some lost rationale

### What's correct
- The core left-to-right evaluation guarantee and why it matters ✓
- Listed command-emitting forms (sequential paths, caller(), sequence-channel
  calls) ✓
- Three structural boundary cases (inline-if with mutations, and/or with
  mutations, ambiguous imported callables) ✓
- `usedChannels` / `mutatedChannels` analysis vocabulary ✓
- `resolveSingle` / `resolveDuo` / `resolveAll` value consumption ✓
- All 7 invariants are sound ✓

### Correctness fix
- **Observation commands (snapshot, isError, getError) are listed as
  command-emitting expressions, but they only emit commands in script mode.**
  `compileSpecialChannelFunCall()` returns `false` when `!compiler.scriptMode`
  (channel.js:265-267) and they fall through to normal dynamic calls in template
  expressions. The document must qualify this as script-mode channel syntax or
  remove observations from the general command-emitting list.

### Should restore
- No cross-reference to `output-scoping.md`, even though expression analysis
  (`mutatedChannels`) directly drives buffer linking decisions described there.
  A one-line "See also" at the bottom of each document is enough.

### Optional breadth
- The old document had a concrete failing-pattern example
  (`(asyncCond ? a!.method() : b!.method()) + c!.method()`) showing why generic
  wrappers break ordering. Adding one would make the rule less abstract for new
  contributors, but the principle is stated.
- The design rationale for why specific boundary forms exist (not a generic
  "wrap everything async") was dropped. Useful context, not a correctness gap.
- Macro argument transparency could explain why (macros are control structures,
  not value consumers), but the stated rule is correct.

---

## output-scoping.md

### Verdict: Good rewrite, but one misleading claim about buffer creation sites

### What's correct
- Channel analysis vocabulary (`declaredChannels`, `usedChannels`,
  `mutatedChannels`) matches `src/compiler/analysis.js` lines 100-102 ✓
- All files in Key Files section exist ✓
- `__waited__` channel description ✓
- Control-flow poisoning via `poisonChannels` ✓ (compiler-async.js:416, 460, 783, 812)
- Linked channels mechanism ✓ (command-buffer.js)
- Guard scopes and sequential-path declarations ✓
- All 7 invariants are sound and grounded in the implementation ✓

### Correctness fixes
- **"include/import/from-import … boundaries" are listed as buffer creation
  sites, but import and from-import are promise/value bindings — they do not
  create `CommandBuffer` boundaries in the analysis phase.** Only `include` uses
  `_compileAsyncControlFlowBoundary`. The list must distinguish which composition
  forms create buffers from which are promise-based (with waited timing where
  needed).
- Block analysis returns `createScope: true, scopeBoundary: false` — blocks
  create scopes, not full buffer boundaries. "Block/super invocation boundaries"
  in the buffer creation list is misleading and should be corrected.

### Optional breadth
- `CallAssign` creates a scope (not mentioned).
- `AsyncEach`/`AsyncAll` loop boundaries create scopes (not mentioned).
- Invariant 7 could clarify that set-block isolation is template-mode-only.

---

## script-doc-notes.md

### Verdict: Changes are fine — file itself needs a cleanup pass

The three cosmetic changes (Unicode `…` → ASCII `...` in two places, emoji
`⚠️` removed) are appropriate and consistent.

The file content is moderately stale. Many items it tracks have been implemented
in `script.md` and could be removed. Items that still look open:

- Context value semantics (`appConfig.debug = true` — local copy vs. mutation)
- Guard in sequence channel placement ("not the place!!!")
- Exception for macros with `!` on parameters (verify if implemented)
- Error handling reference at start of channels/guard sections
- Macro error handling behavior clarification

Consider a follow-up pass to strike completed items and keep only active work.

---

## undocumented.md

### Verdict: Factually accurate — lost debugging evidence, `without context` action not explicit enough

### What's correct
All three factual claims verified:
- `revert`: `Revert` node and `parseRevert()` exist; no `compileRevert()` in
  compiler files; `template.md` shows it as working ✓
- `without context`: `parseImport()` and `parseFrom()` pass
  `allowWithoutContext: true`; `parseInclude()` and `parseBlock()` do not ✓
- Block context syntax: explicit-signature form is correct; parser rejects legacy
  `with context, var1` inputs ✓

### Should restore
- The concrete compiler error message (`"compile: Cannot compile node: Revert"`)
  and the file list proving no `compileRevert()` exists were removed. Restoring
  at least the error string makes the claim self-verifying and easier to test
  against.
- The `without context` section should explicitly state the **action**: add
  `import "file" as lib without context` and `from "file" import helper without context`
  to `template.md`'s syntax table and composition rules. Without that, the section
  reads as a note, not a task.

---

## waited-loops.md

### Verdict: Accurate, good restructure — one lost explanation worth restoring

### What's correct
All technical claims verified:
- `runtime.runWaitedControlFlowBoundary(parentBuffer, usedChannels, context, cb, asyncFn, waitedChannelName)` exists exactly as documented in `src/runtime/async-boundaries.js:51-62` ✓
- All Key Files exist ✓
- `markFinishedAndPatchLinks()`, `getChannel()`, `finalSnapshot()` all present ✓
- `WaitResolveCommand` in `channels/timing.js` ✓
- While loop `false`/`true` return (no STOP_WHILE sentinel) ✓
- Nested loop propagation rules ✓
- Error/poison behavior ✓

The new "Current Runtime Shape" section showing the `runWaitedControlFlowBoundary`
signature is a clear improvement — it gives contributors an actual entry point.
The Key Files section is also a useful addition.

### Should restore
- The deadlock explanation for why `markFinishedAndPatchLinks()` must precede
  `finalSnapshot()` was reduced to one consequence sentence. The causal cycle
  (snapshot waits for the iterator, iterator waits for the buffer to be marked
  finished) is non-obvious and important for anyone touching loop coordination.
  Two to three sentences restoring the cycle would be enough.
- From the dropped "Practical Reference", only one rule is not stated elsewhere:
  `compileExpression(...)` is the only place ordinary root expressions emit waited
  commands. One sentence added to the Root Expression Rule section would cover it.

### Optional breadth
- The WRC abbreviation is used in the text without expansion after the heading
  removed it. A parenthetical on first use would help new readers.

---

## Cross-Cutting Notes

- **The shift from design-proposal to current-state style** across `caller.md`,
  `output-scoping.md`, and `waited-loops.md` is correct. The old versions mixed
  implemented architecture with planning notes, which becomes misleading once the
  work is done.
- **File path accuracy is generally high.** The one significant factual error is
  `output-scoping.md`'s buffer creation list (import/from-import).
- **Correctness fixes that must be done before these documents are treated as
  authoritative:**
  1. `sleep()` in Error Handling Patterns — verify or replace
  2. Observation commands in expression-channels.md — qualify as script-mode only
  3. import/from-import in output-scoping.md — remove from buffer creation list
- **Should-restore items** (real information lost, worth a short edit):
  1. caller.md — dual WaitResolveCommand tracking
  2. waited-loops.md — deadlock cycle explanation + `compileExpression` rule
  3. undocumented.md — compiler error string + explicit action items for `without context`
  4. expression-channels.md ↔ output-scoping.md — mutual cross-references
