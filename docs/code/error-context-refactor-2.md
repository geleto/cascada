# ErrorContext Refactor 2

This document tracks the second-stage refactor after the main compact
`ErrorContext` migration. Phases 1-5 in
[`error-context-refactor.md`](error-context-refactor.md) established compact
prepared `__ec` tables, explicit compiler-emitted context arguments, command and
buffer context storage, and the removal of the broad legacy object/positional
async adapters.

## Current Invariants

- async compiler/runtime code passes compact prepared error contexts
  (`__ec[index]`) explicitly
- compact context normalization is owned inside runtime error classes/helpers;
  callers pass non-null compact prepared contexts and do not normalize them
  directly
- `contextualizeError(error, errorContext)` is the async runtime
  wrapper for non-poison errors
- `handleError(error, lineno, colno, label, path)` remains only for the frozen
  synchronous Nunjucks-compatible compiler path
- synchronous positional `handleError(...)` calls must not be rewritten as part
  of this cleanup
- wrapped errors preserve the first source-origin context assigned to them
- `PoisonError` is the individual non-fatal contextual error; `PoisonErrorGroup`
  aggregates individual poison errors and does not invent a consumption origin
- async helpers, commands, and buffer stackes should receive an originating
  `errorContext`; handling for missing async contexts is temporary cleanup
  scaffolding
- commands and direct chain invocations receive their source-origin
  `errorContext` explicitly; they must not infer it from the current buffer
- value-consumption paths must preserve an incoming error's origin context; they
  must not attach the consuming lookup/call/loop/output context to an error or
  poisoned value that already originated elsewhere
- command-buffer stack stack metadata follows the same source-origin rule:
  a stack frame's origin is the async/render boundary created for the source
  operation, not a later value-consumption point
- command buffers use `bufferStackContext` only for buffer stack trace
  frames, such as root, call, loop, include/render, and condition buffers. It is
  not a fallback source context for commands.
- command and branch diagnostics must not invent source origin from ambient
  buffer, parent, or render context state

## Out Of Scope

- changing the frozen synchronous Nunjucks-compatible compiler path
- changing `RuntimePromise` beyond preserving the source context it already
  carries for rejected promise values
- introducing a class-based `ErrorContext`
- using command-buffer stack context as a replacement for source-origin context

## Phase A - Remove Async Legacy Error-Context Adapters

Implemented for the async runtime:

1. Removed the remaining async/runtime positional and object-context adapters:
   `resolveErrorContextArgs(...)`, `compactErrorContext(...)`, object support in
   compact context normalization, and object fallback conversion in
   `resolveEffectiveErrorContext(...)`.
2. Collapsed `RuntimeError(...)`, `RuntimeFatalError(...)`,
   `createPoison(...)`, and async wrapping to compact-context inputs. Async
   runtime code uses `contextualizeError(error, errorContext)`.
   The frozen sync/Nunjucks compiler path keeps the positional
   `handleError(error, lineno, colno, label, path)` adapter.
3. Collapsed `ensureDefinedAsync(...)` and its async helper to remove
   positional `lineno` and `colno` arguments. Async safe-output diagnostics use
   compact `errorContext`; synchronous `ensureDefined(...)` stays on the frozen
   sync path.
4. Audited compiler-emitted entry/catch blocks in `emit.js`; the remaining
   positional emitted catches are on the frozen sync path or currently
   unreachable async-guarded legacy code.
5. Checked `handleFatal(...)`; it remains compact-only and delegates through
   the same compact fatal path as `contextualizeError(...)`.
6. Verified active `RuntimePromise.errorContext` producers use compact contexts
   before removing object-context support from normalization.
7. Removed `errorContextString` aliases from async runtime diagnostics and
   tests; `label` is the async diagnostic field.
8. Re-checked already-wrapped error handling and `PoisonError.errors`
   handling. The old `attachErrorContextIfMissing(...)` helper has been
   inlined into `contextualizeError(...)` as a marked temporary bridge for
   already-wrapped errors; `PoisonError.errors` in-place mutation is left for a
   later behavior-preserving cleanup if needed.

## Phase B - Command Context Strictness

Implemented for async commands:

1. Removed command constructor `errorContext = null` defaults from chain,
   observation, wait, sequence, sequential-path, poison-target, and component
   operation commands, including command-buffer `ErrorCommand` poison entries.
   Command constructors now require a compact
   `errorContext`.
2. Removed test and runtime use of backward-compatible command `pos` inputs.
   Command construction stores compact contexts directly and normalization stays
   at error-reporting points.
3. Threaded explicit contexts into runtime-created command paths:
   `chainLookup(...)`, guard snapshot/restore/repair/error observations, public
   chain invocation helpers, and component operation wrappers. Public runtime
   chain invocation takes the compact source context as the last invocation
   argument, with the shared `Chain` helper extracting that context before the
   command is created.
4. Removed the `ChainCommand` static-path label special case from
   `_generateErrorContext(...)`. Chain command diagnostics now use the stable
   source-operation label, with command payload details supplied by the command
   itself at reporting time.
5. `_generateErrorContext(...)` still serves frozen sync compiler paths and
   remains in place until a separate sync-compiler cleanup is opened.

## Phase C Prerequisite - Error-Only Compiled Callback

Implemented before inheritance owner-table binding: the compiled async
reporting callback contract is explicit and error-only.

1. Audit generated async code so the render/reporting callback passed through
   compiled template/script functions is never used to return a value. Values
   should flow through return values, command buffers, snapshots, promises, or
   explicit external callback adapters, not through the render/report callback.
2. Keep public/environment and third-party callback APIs free to use Node-style
   `(err, value)` callbacks. This cleanup is only for the internal compiled
   async reporting callback that carries fatal/runtime errors and is embedded in
   prepared error contexts.
3. Renamed the generated async callback parameter from generic `cb` to
   `reportError`. Local adapter callbacks used for external APIs may keep
   conventional names such as `callback`.
4. Updated `prepareErrorContexts(...)` / generated `getErrorContexts(...)`
   terminology so the callback slot reads as an error-reporting callback, not a
   value completion callback.

## Phase C - Inheritance Metadata And Test Cleanup

1. Establish and verify the inheritance reporting invariant: within a single
   `InheritanceInstance` (including constructor, method, block, component, and
   super invocations), one fatal/reporting `reportError` function is used for
   all error reporting and all prepared error-context tables. Component
   instances created from an inheritance instance should use the parent instance
   reporter or an intentionally scoped reporter, not an arbitrary local
   callback. Do not move prepared `__ec` tables into compiled-module/global
   mutable state while entries still embed a per-render reporter; compiled
   template/script objects can be rendered concurrently.
2. Add and verify `getErrorContexts` support on `Script` instances, matching
   `TemplateRuntime`, so script-based inheritance participants can contribute
   owner artifact tables.
3. Prepare one compact error-context table per owner template/script entry per
   inheritance instance in the `bind-instance-metadata.js` binding pass called
   from `InheritanceInstance.create`, after `finalizeInheritanceChain(...)`
   returns and while `options.reportError` is available. Use the owner artifact
   path and the instance reporter. Do not thread `reportError` into
   `finalizeInheritanceChain(...)`; `finalize-metadata.js` should remain a
   generic metadata pass. Treat the entry template/script as just another owner
   entry so `entryErrorContextTable` can be unified with the same per-owner
   table binding path.
4. Keep the existing `ownerEntry.errorContextTable` prepared with
   `reportError = null` during `loadEntry(...)` as a finalization-only table.
   It is used for validation diagnostics before an `InheritanceInstance` exists
   and must stay separate from the per-instance callback-bearing table.
5. Bind or store each owner prepared table on finalized constructor/method/block
   runtime entries so inheritance invocation does not rediscover or select a
   table for each call. Phase C first used per-instance wrappers to append the
   owner table to raw compiled callables; Phase D removed that temporary ABI by
   storing the table on `methodData.errorContextTable` and emitting inherited
   callable contexts from that table directly.
6. Remove hot-path owner-table lookup after runtime callable entries carry their
   prepared owner table directly. The removed lazy lookup helpers
   `getErrorContextTableForMethod(...)`, `getErrorContextForMethod(...)`, and
   `errorContextTablesByOwner` must stay gone; future cleanup should shrink the
   binding wrapper itself rather than reintroduce per-call table selection. The
   benefit is simpler ownership and less invocation plumbing, not primarily
   performance.
7. Replace hand-built inheritance metadata object error-context test
   scaffolding in `tests/pasync/inheritance.js` with integration tests or
   index-based fixture helpers. Then remove legacy fallback fields and helper
   adapters for object-format fields such as `errorContext` and
   `superErrorContext` that only exist for those tests.
8. Keep `reportError` as explicit render/inheritance-load state. Do not recover
   it from an incoming compact error context just to prepare another `__ec`
   table; inheritance parent resolution should receive `reportError` directly.
9. Keep `loadEntry(...)` and `createRuntimeOwnerEntry(...)` separate for now:
   `loadEntry(...)` is loader-owned and prepares finalization-only metadata,
   while `createRuntimeOwnerEntry(...)` creates frozen finalization entries.
   Revisit only if a later pass exposes real duplication after the callable ABI
   cleanup.
10. Perform a narrow final inheritance naming audit: confirm historical
    `origin` names are gone for originating error contexts, and that remaining
    `errorContext` fields genuinely hold compact source contexts rather than
    renamed legacy object-origin payloads.
11. Rename runtime-internal async composition parameters that still call the
    error-only reporter `cb`, including `AsyncTemplateRuntime.getExported(...)`
    and `Script.getExported(...)`. Async `getExported(...)` should be treated as
    an internal composition API that returns the exported object synchronously
    while exported values may still be promises; its trailing argument is
    `reportError`, not a Node-style `(err, value)` callback. Resolve direct
    no-reporter `getExported(...)` use as an explicit compatibility case.
    Generated render/include/import paths must pass `reportError`; do not add
    defensive null-reporter fallbacks to those internal paths.

## Follow-Up - Render Fatal State And Early Exit

Render-scoped fatal state and early-exit behavior are tracked in
[`error-handling-analysis.md`](error-handling-analysis.md#6-render-fatal-state-and-early-exit).
They are intentionally outside this error-context refactor and should be
implemented after this plan is complete. When that follow-up lands, re-check the
direct no-reporter `getExported(...)` compatibility path: async
`getExported(...)` should otherwise receive a render-scoped `reportError`,
return the exported object synchronously, and leave individual exported values
to resolve independently.

## Phase D - Compiled Callable Error-Context ABI Cleanup

Implemented for inherited callables:

1. Removed the final low-level `__ec` parameter from inherited method, block,
   and constructor functions. Callable error-context references now read from
   `methodData.errorContextTable[...]`, so the method metadata owns the table
   used by the generated callable.
2. Kept root and parent-resolution `__ec` tables local to their generated
   functions. Only inherited callable entries use the method-owned table.
3. Kept per-render `reportError` ownership unchanged. Prepared owner tables are
   still created per `InheritanceInstance` in `bind-instance-metadata.js` and
   are not stored globally on compiled template/script artifacts.
4. Shrunk `bindInheritanceRuntimeState(...)`: bound method entries now store
   `errorContextTable` directly instead of wrapping `fn(...)` solely to append
   an owner table argument.
5. Regenerated precompiled/browser fixtures for the callable ABI shape.
6. Verified the focused inheritance, component, error-context, and precompile
   suites.

## Phase E - Error Taxonomy And Fatal Delivery

Implemented scope:

- Phase E kept a separate fatal runtime marker during the audit. Phase I later
  merged fatal runtime failures into `RuntimeError` itself: every
  `RuntimeError` is fatal, and every `PoisonError` is non-fatal.
- Removed the unused `currentBuffer` parameters from
  `contextualizeError(...)`, `createPoison(...)`, and `handleFatal(...)`.
  Command-buffer stack enrichment remains a `getErrorInfo(...)` concern.
- Removed `attachErrorContextIfMissing(...)` as a separate helper. The remaining
  late compact-context bridge is inline in `contextualizeError(...)` and marked
  for deletion.
- Audited `handleFatal(...)`: it currently has no runtime callers. Its existing
  callback-or-throw contract is preserved by focused tests, but fatal delivery
  unification belongs with the render fatal-state work rather than this phase.
- Re-checked fatal runtime tests. Tests now assert the fatal-vs-poison
  distinction through `RuntimeError` vs `PoisonError`.

End-state taxonomy goal:

The refactor targets three user-visible error families: `PoisonError`,
`RuntimeError`, and `CompileError`. Phase I completed the fatal runtime merge:
`RuntimeError` is the fatal runtime family, while `PoisonErrorBase`
(`PoisonError` plus `PoisonErrorGroup`) remains the non-fatal value/data error
family. `isRuntimeError(...)` remains as the predicate at the few
value-consumption guards that still need to spell out the fatal-vs-poison
distinction.

Phase E active taxonomy:

| Current type/helper | Phase E target |
| --- | --- |
| `PoisonedValue` | Value container, not an error family |
| `PoisonError` | Keep as the only poisoned-value error wrapper |
| `RuntimeError` | Fatal runtime error family |
| `CompileError` | Keep as the compile/load-time error family |
| `handleError(...)` | Frozen sync compiler adapter only |

1. Done: audit value-consumption boundaries before changing the fatal marker:
   command argument resolution, chain error recording, loop iteration catches,
   async boundary catches, and inheritance/component structural checks. Today
   fatal runtime marker is the hard-runtime-error discriminator that prevents
   broken runtime contracts from being converted into poison at those
   consumption points.
2. Done in Phase I: removed the separate `RuntimeFatalError` subclass. Use
   `RuntimeError` for hard runtime failures, with `isRuntimeError(...)`
   retained as the predicate name at existing guard sites.
3. Done: audit all `handleFatal(...)` callers before changing delivery
   behavior. There are no runtime callers; only focused tests exercise its
   current callback-or-throw contract. Do not make it the global fatal delivery
   surface in this phase.
4. Deferred to render fatal-state work: unify fatal delivery after the render
   state owns one reporting function, reported-state tracking, and the
   root/fatal-promise race. That work should decide whether `handleFatal(...)`
   stays as a helper or becomes unnecessary.
5. Done as a scoped audit: runtime-owned construction sites either pass compact
   context or are generic value/lazy-resolution helpers where missing context is
   still tolerated by the temporary nullable-context bridge. Removing those
   fallback paths is Phase H cleanup after render fatal-state behavior is
   stable.
6. Remove or shrink the temporary error-context glue cluster in dependency
   order:
   - Done: remove `attachErrorContextIfMissing(...)` as a separate helper.
     The remaining late compact-context bridge is now inline and marked at the
     already-wrapped error branch in `contextualizeError(...)`.
   - Done in Phase H: shrink `resolveEffectiveErrorContext(...)` to the final
     compact-context precedence rule after non-array legacy tolerance is proven
     dead.
   - Done in Phase H: keep `handleError(...)` isolated to the frozen sync
     compiler path and publicly exported for now; final public surface
     narrowing is Phase J.
   - Done in Phase H: remove `EMPTY_ERROR_CONTEXT_INFO` and
     `normalizeOptionalErrorContext(...)` after every compiler-owned async path
     has a guaranteed non-null compact context.
   - Done in Phase I: collapse the fatal runtime subclass into `RuntimeError`.
7. Done: remove the unused `currentBuffer` parameters from `contextualizeError(...)`,
   `createPoison(...)`, and `handleFatal(...)`. Stack enrichment remains a
   `getErrorInfo(error, ec, currentBuffer, includeStack)` concern rather than a
   side effect of contextualization.
8. Deferred to Phase I: re-check `PoisonError` handling and remove the in-place mutation of
   `PoisonError.errors` if it can be replaced with clearer construction without
   changing multiple-error propagation. Verify that re-running
   `PoisonError` deduplication is idempotent, and note that immutable
   replacement means existing references to the old `PoisonError` object will
   not see newly contextualized contained errors.
9. Done: migrate tests that asserted the separate fatal subclass to assert
   `RuntimeError`.
10. Done for current docs: re-check docs and public exports so the active error
    taxonomy is explicit. Public export narrowing is deferred to Phase J after
    strict-context and error-family cleanup.

## Phase F - Render Fatal State And Delivery

Implemented the render-owned fatal-state model described in
[`error-handling-analysis.md`](error-handling-analysis.md#6-render-fatal-state-and-early-exit).
This phase owns fatal delivery behavior; it is deliberately separate from
helper/buffer cleanup because it changes the runtime reporting model rather
than only removing scaffolding.

1. Introduce a small render-state object that owns:
   - one shared `reportFatalError(error)` / `reportError(error)` function for a
     render call and its composition participants
   - `isFatalErrorReported()` state
   - the root-result vs fatal-error race helpers currently spread across
     render-root, include, import, and inheritance entry paths
2. Prepare the render-state object at the public render boundary, before
   compiled root/script execution. Pass the same render state through main
   templates/scripts, includes, imports, direct `getExported(...)` execution,
   components, and inheritance participants.
3. Use explicit render-state threading for runtime execution ownership:
   - async boundary helpers (`runControlFlowBoundary(...)`,
     `runWaitedControlFlowBoundary(...)`, `runRenderBoundary(...)`) receive
     `renderState` instead of a bare `reportError` callback
   - generated async roots/callables receive or close over `renderState` so
     boundary calls can pass it directly; generated code may still use
     `reportError` as a local alias for `renderState.reportError` where that
     keeps emitted code readable
   - keep that alias at compiled root/function boundaries only; runtime APIs
     should not accept both `renderState` and a separate `reportError`
     callback for the same execution path
   - command-buffer execution gets render state through the buffer/runtime
     execution path so command application can check fatal state without
     guessing from callbacks
   - regenerate precompiled/browser fixtures if this changes the compiled ABI
4. Keep value-consumption failures on the poison path. Non-`PoisonError`
   failures observed at value-consumption boundaries remain fatal runtime
   errors and must not be degraded into poison.
5. Add early-exit checks only at useful synchronous choke points:
   - before entering async boundary bodies
   - after awaited boundary work settles, before continuing synchronous work
   - before invoking composition roots: include, import, export/getExported,
     component, and inherited participant roots
   - before command-buffer command application
   Command-buffer early exit must still finish buffers/chains and unblock
   pending snapshots; it may skip useful command application, but must not skip
   cleanup that prevents deadlocks. Apply after-boundary checks only where the
   helper already awaits boundary work; do not add checks to value-returning
   async boundaries whose promise/value is intentionally consumed later.
   Do not await additional promise values only to check fatal state; if an async
   boundary returns a promise value, its error should surface when the value is
   consumed.
6. Re-evaluated `handleFatal(...)` after render-state delivery landed. It has
   no runtime callers today, and fatal delivery is now owned by render state.
   Phase I removes the helper instead of keeping the old callback-or-throw
   adapter.
7. Added tests proving:
   - main render, includes/imports, components, and inherited participants use
     one reporting state per render
   - direct async `getExported(...)` execution creates or receives render state
     instead of using an ad hoc local `reportedError` closure
   - fatal delivery reports once even if both a callback path and a returned
     promise observe the same failure
   - include/import/export composition roots stop before invoking child roots
     when fatal state has already been reported
   - fatal-state early exit stops useful synchronous work without swallowing
     value-consumption poison
8. Implemented in this order to keep the change reviewable:
   - add the render-state object and root/fatal race ownership
   - migrate public render, include/import/export/getExported, component, and
     inheritance entry paths to receive/pass render state
   - migrate async boundary helper signatures and generated calls
   - add command-buffer early-exit checks with cleanup preserved
   - re-run/regenerate precompile fixtures if generated ABI changed
   - only then re-check whether `handleFatal(...)` has a remaining role

## Phase G - Helper Ownership And Buffer API Cleanup

Implemented as the low-to-medium risk cleanup pass after render-state delivery.
This phase improved ownership and naming without tightening the core compact
context invariant or changing error-family semantics.

Prerequisite: Phase F is complete and the render-state tests are passing.

1. Done: reconciled deferred optional
   `bufferStackContext` display fields. Use the current canonical field names
   (`branchName`, `loadName`, `targetIdentifier`, `loop`, `branch`) unless a
   specific field has been deliberately renamed. Re-evaluate the
   `branchName`/`branch` pair in particular: `branchName` currently identifies
   the buffer stack/root/callable frame, while `branch` identifies conditional
   direction such as `then` or `case`.
2. Done: renamed/reframed the `CommandBuffer` constructor's fourth parameter as
   a chain `linkTarget`, not a diagnostic or ownership parent.
3. Done: simplified the long positional `managedBlock(...)` signature to an
   options object.
4. Done as a narrow ownership review: helpers added after Phase D were checked
   without restructuring core chain/command classes.
5. Decision: keep `requireCommandErrorContext(...)` in `commands/base.js` for
   now because it enforces a base command-construction invariant shared by
   command subclasses and runtime helper constructors.
6. Done: split `_generateErrorContext(...)` so label construction and
   compiler-table registration are separate, named operations. The frozen sync
   path behavior is unchanged.
7. Done: removed finalization-only `errorContextIndex` from bound method
   entries after the binder resolves `errorContext` and `errorContextTable`.
8. Done within this guard: do not remove `normalizeOptionalErrorContext(...)`,
   `EMPTY_ERROR_CONTEXT_INFO`, or nullable-context paths in this phase; those
   belong to Phase H. Within that guard, make `contextualizeError(...)` the
   single runtime error-context wrapper for non-poison runtime errors by
   inlining or removing helper wrappers that only forward to it, including
   `contextualize*` helpers that do not add real domain-specific data. Keep
   small helpers only when they attach additional command, chain, or buffer
   information before calling `contextualizeError(...)`.
9. Done: re-checked the command constructor shape and kept
   `ErrorCommand(errors, errorContext)` positional because both arguments are
   fixed and required. Removed the generic missing-error fallback so missing
   `errors` is treated as an invalid command construction.
10. Revisited shared-schema default source locations. Merged shared schema entries
    currently use the declaration context for both `errorContext` and
    `defaultErrorContext`; preserving a parent's default initializer location
    would require a separate compiled `defaultErrorContextIndex` field. Defer
    that as a separate design change.
11. Done: made `reportFatalError(...)` a void reporter.
12. Done: avoided the redundant `reportFatalError(...)` call inside
    `raceRootResult(...)` when the fatal promise rejection already came from the
    same render state.
13. Done: removed redundant render-state aliases such as
    `InheritanceInstance.reportError` after internal callers use
    `this.renderState.reportError` directly.
14. Done: re-checked `_stopAfterFatalReport(...)` cleanup for intermediate
    buffer stack entries and release/leave bookkeeping.
15. Done as a narrow audit: duplicate adjacent `throwIfFatalErrorReported()` checks at
    composition/component/inheritance entry points where doing so does not
    weaken a real boundary were left only where they mark real boundaries.
16. Deferred to Phase H preflight or a dedicated follow-up: add focused
    coverage for waited-control-flow cleanup when fatal state is reported while
    a waited child boundary is settling. Existing loop coverage exercises the
    path indirectly, but a direct no-deadlock/finalSnapshot resolution test
    would make the guarantee explicit.
17. Done: audited all callers of `getExported(...)` and `_renderIncludeText(...)` to
    confirm every production call site passes a `RenderState`.
18. Done: removed the `TODO(render-state-cleanup)` direct callback compatibility
    bridge in `AsyncTemplateRuntime.getExported(...)` after item 17 confirms all
    production export callers enter through a render-state owner. Direct export
    execution should either receive an existing render state or create one
    explicitly at that boundary, not rebuild the old local
    callback/reported-error pattern.
19. Done: fixed or verified stale terminology in legacy docs, including the old
    `error-context-refactor.md` `handleFatal(...)` description that still says
    `cb` instead of `reportError`, unless already fixed before this phase.

## Phase H - Strict Async Error-Context Invariants

Implemented strict async error-context cleanup after Phase G confirmed helper
ownership and render-state fatal delivery were stable. Runtime error classes now
own compact context normalization internally. Poison aggregation uses
`PoisonError.create(errors)` for already-originated poison errors and
`createPoison(errors, errorContext)` at public/source boundaries; operations
that create a new non-fatal value error at that source use
`new PoisonError(error, errorContext)` or `new PoisonErrorGroup(errors,
errorContext)`; fatal runtime errors use `contextualizeError(error,
errorContext)`.

Prerequisite satisfied: Phase G is complete. Nullable `errorContext` defaults in
compiler-owned async helpers and command constructors are eliminated or exposed
as explicit validation failures. Direct runtime invocation/component helper
compatibility remains marked in code with `TODO(strict-error-context-cleanup)`
because those helpers are still used manually in tests and are not purely
compiler-owned entry points.

Preflight audit performed:

- done: grep for every `normalizeOptionalErrorContext(...)` and
  `EMPTY_ERROR_CONTEXT_INFO` use
- done: grep for `errorContext = null`, `errorContext: null`, and nullable
  `errorContext` call paths in async runtime/compiler code
- done: grep for `contextualizeError(...)`, `createPoison(...)`, command
  constructors, and boundary helpers that may still receive null
- done: verify that tests do not directly assert `normalizeOptionalErrorContext(...)`
  behavior or depend on `EMPTY_ERROR_CONTEXT_INFO` field values
- done: scan generated/precompiled fixtures, including the browser precompile
  fixture, for boundary calls that still rely on fallback arguments. No missing
  final buffer stack context arguments remain in the current generated output.
- done: run the focused error-context, composition, conditional, inheritance,
  component, precompile, and CLI suites before removing the fallback helpers

1. Done: removed the nullable normalization helper cluster:
   `normalizeOptionalErrorContext(...)`, `EMPTY_ERROR_CONTEXT_INFO`, and the
   associated `TODO(error-context-cleanup)` markers.
2. Done: replaced optional normalization at runtime wrapper/reporting sites
   with internal `internal error-class normalization` calls for non-null compact
   contexts. `RuntimeError`, `contextualizeError(...)`,
   `getErrorInfo(...)`, `new PoisonError(error, errorContext)`, and
   `new PoisonErrorGroup(errors, errorContext)` consume compact context
   directly. Context-free poison aggregation remains separate as
   `createPoison(errors)`, and the normalizer is no longer exported as a public
   runtime helper.
3. Done: removed boundary no-context tolerance. Async boundary helpers now take
   a required `bufferStackContext` object, store it on child buffers for stack
   diagnostics, and use its compact `ec` field when reporting boundary errors.
4. Done: removed the remaining `resolveEffectiveErrorContext(...)` helper.
   Runtime wrappers now apply the final precedence rule directly: preserve an
   existing error-owned context, otherwise use a compact fallback only when the
   current operation is the error source. Non-array legacy contexts are no
   longer converted or silently tolerated by normalization.
5. Done: removed the inline already-wrapped-error bridge in
   `contextualizeError(...)`; wrapped errors must carry their compact context
   from construction time or keep their original positional fields.
6. Done: reinforced the source-origin rule for poison and value-consumption
   paths. `contextualizeError(PoisonErrorBase, fallbackContext)` preserves the
   poison unchanged, and consuming lookup/call/loop/output paths no longer
   attach their local `errorContext` to incoming failed values.
7. Decision: keep `handleError(...)` publicly exported for now as the frozen
   sync compiler adapter. Public export narrowing remains Phase J after the
   fatal-family cleanup.

## Phase I - Poison And Fatal Error Semantics

This phase contains semantic error-shape work that should not be hidden inside
general helper cleanup.

Prerequisite: Phase H is complete for item 4. Items 2 and 3 may be implemented
independently if they stay behavior-preserving.

1. Done after the Phase H source-origin cleanup: `contextualizeError(...)` no
   longer mutates `PoisonError` contents or attaches fallback context to poison
   at consumption sites. `PoisonError.create(...)` remains the strict
   aggregate rehydration path for errors that already carry origin context,
   while `createPoison(errors, errorContext)` is the source-boundary helper for
   raw failures that are being poisoned at their origin. External/user code
   should throw ordinary non-poison errors; the call/filter/consumption boundary
   converts those errors to typed `PoisonError`s with that boundary's source
   context and the original error preserved as `cause`.
2. Done: moved shared compact-context normalization and diagnostic message
   formatting behind the runtime error classes. `PoisonError` owns individual
   non-fatal context/message construction, `PoisonErrorGroup` owns aggregate
   error-state construction, and `RuntimeError` owns fatal runtime context
   construction instead of spreading that work across public helpers.
3. Done: removed `handleFatal(...)` after strict-context cleanup. Render state
   now owns fatal delivery, and runtime code reports or throws `RuntimeError`
   directly through that path.
4. Done: completed the runtime error-family merge. `RuntimeError` is always
   fatal, and `PoisonErrorBase` (`PoisonError` plus `PoisonErrorGroup`) is
   always non-fatal. `isRuntimeError(err)` is a predicate for
   `err instanceof RuntimeError`. The active fatal
   guards remain in the loop iteration boundary (`loop.js`), command argument
   resolution (`commands/arguments.js`), and chain error recording
   (`chains/base.js`). The separate `RuntimeFatalError` subclass/export is
   gone, leaving the target runtime families: `PoisonError`, `PoisonErrorGroup`,
   `RuntimeError`, and `CompileError`.
5. Done: split the former aggregate-style `PoisonError` shape into typed
   individual and aggregate poison errors. `PoisonError` is now the individual
   non-fatal contextual error and the cardinality-aware `PoisonError.create(...)`
   factory; `PoisonErrorGroup` is the multi-error aggregate; and
   `PoisonErrorBase` is the shared `instanceof`/type-guard target for both.

## Post-H Follow-Up - Diagnostic Stack Metadata

This is a small diagnostic-quality follow-up after strict-context cleanup. Keep
the Phase H invariant changes intact; this pass should only refine what
buffer stack metadata is attached to stack frames and how that metadata is
named. A diagnostic stack frame's origin is the async/render boundary created
for the source operation; do not move stack attachment to later value consumers.

1. Revisit the `bufferStackContext` display schema with real compiled stacks:
   - decide whether `branchName` should be renamed or split so conditional
     branch direction (`then`, `else`, `case`) is distinct from buffer/frame
     identity (`root`, `caller`, component binding, macro name)
   - keep absent metadata absent; do not emit `undefined` display fields
   - keep loop-specific details inside `loop`, including the loop variable
     names already added after Phase H
   - attach function, macro, caller, component, include/import/render, and
     switch/if details outside the loop object using names that describe the
     domain concept directly
2. Add or expand an integration test that captures an actual compiled stack
   containing representative boundary kinds: root, macro call/caller(), loop,
   if/switch branch, include/import or render composition, and component
   creation or component method/observation. Use the test to drive the display
   schema rather than hand-building simulated stack frames.
3. After the display schema is settled, update `BUFFER_CONTEXT_OPTIONAL_KEYS`,
   compiler-emitted `emitBufferStackContext(...)` payloads, and docs together.
   Avoid changing source-origin error contexts (`ec`) as part of this pass.

## Phase J - Final Generated Artifacts And Public Surface

This is the terminal cleanup phase. Do not start it until strict-context cleanup
and error-family semantics have settled.

Prerequisite: Phase H has removed the generated boundary fallback, and Phase I
item 4 is complete.

1. Done: re-checked generated/precompiled boundary calls after the final async
   compatibility adapters are removed. Boundary helper calls should continue to
   pass the final buffer stack context argument explicitly.
2. Done: performed the terminal quick-suite pass after final async
   compatibility adapters were removed. This closes out fixture churn from the
   refactor and is distinct from incremental fixture updates in earlier phases.
3. Done: re-checked public exports, tests, active docs, and TypeScript
   declarations after the strict-context and error-family phases. The public
   surface now exports and documents `CascadaError`, `CompileError`,
   `RuntimeError`, `PoisonErrorBase`, `PoisonError`, `PoisonErrorGroup`,
   `isPoisonError(...)`, and `isRuntimeError(...)`. Public docs describe
   render failures as `CompileError | RuntimeError | PoisonError | PoisonErrorGroup`,
   and `peekError(...)` / `#` as returning `PoisonError | PoisonErrorGroup | null/none`.
4. Done: reviewed `error-context-refactor.md` and other referenced docs for
   stale terminology not already fixed in-phase, including `cb`,
   `reportedError`, old aggregate-style `PoisonError` examples, and old runtime
   type descriptions. Historical first-stage planning docs are now explicitly
   marked as historical instead of being rewritten as current guidance.
5. Revisit `TODO(strict-error-context-cleanup)` direct runtime helper
   compatibility. Remove the remaining nullable/direct-call contexts if those
   helpers are made internal-only, or document the direct public contract if
   they remain supported.
