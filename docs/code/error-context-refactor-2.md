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
- `RuntimeError.create(...)`, `RuntimeError.report(...)`, and
  `RuntimeError.reportAndThrow(...)` are the async runtime wrappers/reporting
  paths for fatal non-poison errors
- `createSyncRuntimeError(error, lineno, colno, label, path)` remains only for the frozen
  synchronous Nunjucks-compatible compiler path
- synchronous positional `createSyncRuntimeError(...)` calls must not be rewritten as part
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
- command buffers use `bufferStackErrorContext` only for buffer stack trace
  frames, such as root, call, loop, include/render, and condition buffers. It is
  not a fallback source context for commands.
- command and branch diagnostics must not invent source origin from ambient
  buffer, parent, or render context state

## Out Of Scope

- changing the frozen synchronous Nunjucks-compatible compiler path
- changing `RuntimePromise` beyond preserving the source context it already
  carries for rejected promise values
- introducing a class-based `ErrorContext`
- using command-buffer stack error context as a replacement for source-origin context

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
   `createSyncRuntimeError(error, lineno, colno, label, path)` adapter.
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
`RuntimeError` is the fatal runtime family, while `PoisonError`
(`PoisonError` plus `PoisonErrorGroup`, since `PoisonErrorGroup extends
PoisonError`) remains the non-fatal value/data error family.
`isRuntimeError(...)` remains as the predicate at the few
value-consumption guards that still need to spell out the fatal-vs-poison
distinction.

Phase E active taxonomy:

| Current type/helper | Phase E target |
| --- | --- |
| `PoisonedValue` | Value container, not an error family |
| `PoisonError` | Keep as the only poisoned-value error wrapper |
| `RuntimeError` | Fatal runtime error family |
| `CompileError` | Keep as the compile/load-time error family |
| `createSyncRuntimeError(...)` | Frozen sync compiler adapter only |

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
   - Done in Phase H: keep `createSyncRuntimeError(...)` isolated to the frozen sync
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
   `bufferStackErrorContext` display fields. Use the current canonical field names
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
16. Done: added focused coverage for waited-control-flow cleanup when fatal
    state is reported while a waited child boundary is settling. The runtime now
    skips the waited-chain drain after fatal reporting so cleanup cannot hang on
    pending waited commands.
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
own compact context normalization internally. New engine-authored non-fatal
value errors use `PoisonError.create(message, errorContext)`, caught
user/source failures use `PoisonError.wrap(error, errorContext)`, existing
poison errors aggregate through `PoisonError.group(errors)`, and synchronous
poison transport is created with `createPoison(typedPoisonError)`. Fatal
runtime errors use `RuntimeError.create(...)`, `RuntimeError.report(...)`, or
`RuntimeError.reportAndThrow(...)`.

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
- done: grep for removed contextualization helpers, strict `createPoison(...)`
  usage, command constructors, and boundary helpers that may still receive null
- done: verify that tests do not directly assert `normalizeOptionalErrorContext(...)`
  behavior or depend on `EMPTY_ERROR_CONTEXT_INFO` field values
- done: scan generated/precompiled fixtures, including the browser precompile
  fixture, for boundary calls that still rely on fallback arguments. No missing
  final buffer stack error context arguments remain in the current generated output.
- done: run the focused error-context, composition, conditional, inheritance,
  component, precompile, and CLI suites before removing the fallback helpers

1. Done: removed the nullable normalization helper cluster:
   `normalizeOptionalErrorContext(...)`, `EMPTY_ERROR_CONTEXT_INFO`, and the
   associated `TODO(error-context-cleanup)` markers.
2. Done: replaced optional normalization at runtime wrapper/reporting sites
   with internal error-class normalization calls for non-null compact contexts.
   `RuntimeError`, `RuntimeContextError.getInfo(...)`,
   `PoisonError.create(...)`, `PoisonError.wrap(...)`, and
   `PoisonErrorGroup` construction consume compact context directly. Context-free
   poison aggregation remains separate as `PoisonError.group(errors)`, and the
   normalizer is no longer exported as a public runtime helper.
3. Done: removed boundary no-context tolerance. Async boundary helpers now take
   a required `bufferStackErrorContext` object, store it on child buffers for stack
   diagnostics, and use its compact `ec` field when reporting boundary errors.
4. Done: removed the remaining `resolveEffectiveErrorContext(...)` helper.
   Runtime wrappers now apply the final precedence rule directly: preserve an
   existing error-owned context, otherwise use a compact fallback only when the
   current operation is the error source. Non-array legacy contexts are no
   longer converted or silently tolerated by normalization.
5. Done: removed the inline already-wrapped-error bridge from the old
   contextualization path; wrapped errors must carry their compact context from
   construction time or keep their original positional fields.
6. Done: reinforced the source-origin rule for poison and value-consumption
   paths. Contextualizing an existing `PoisonError` preserves it unchanged, and
   consuming lookup/call/loop/output paths no longer attach their local
   `errorContext` to incoming failed values.
7. Decision: keep `createSyncRuntimeError(...)` publicly exported as the frozen
   sync compiler adapter. Public export narrowing remains Phase J after the
   fatal-family cleanup.

## Phase I - Poison And Fatal Error Semantics

This phase contains semantic error-shape work that should not be hidden inside
general helper cleanup.

Prerequisite: Phase H is complete for item 4. Items 2 and 3 may be implemented
independently if they stay behavior-preserving.

1. Done after the Phase H source-origin cleanup: consumption sites no longer
   mutate `PoisonError` contents or attach fallback context to incoming poison.
   `PoisonError.group(...)` is the strict aggregate rehydration path for errors
   that already carry origin context, while source boundaries create individual
   poison errors with `PoisonError.create(...)` or `PoisonError.wrap(...)` before
   passing them to `createPoison(...)` when a synchronous `PoisonedValue` is
   needed. External/user code should throw ordinary non-poison errors; the
   call/filter/consumption boundary converts those errors to typed
   `PoisonError`s with that boundary's source context and the original error
   preserved as `cause`.
2. Done: moved shared compact-context normalization and diagnostic message
   formatting behind the runtime error classes. `PoisonError` owns individual
   non-fatal context/message construction, `PoisonErrorGroup` owns aggregate
   error-state construction, and `RuntimeError` owns fatal runtime context
   construction instead of spreading that work across public helpers.
3. Done: removed `handleFatal(...)` after strict-context cleanup. Render state
   now owns fatal delivery, and runtime code reports or throws `RuntimeError`
   directly through that path.
4. Done: completed the runtime error-family merge. `RuntimeError` is always
   fatal, and `PoisonError` (`PoisonError` plus `PoisonErrorGroup`) is always
   non-fatal. `isRuntimeError(err)` is a predicate for
   `err instanceof RuntimeError`. The active fatal
   guards remain in the loop iteration boundary (`loop.js`), command argument
   resolution (`commands/arguments.js`), and chain error recording
   (`chains/base.js`). The separate `RuntimeFatalError` subclass/export is
   gone, leaving the target runtime families: `PoisonError`, `PoisonErrorGroup`,
   `RuntimeError`, and `CompileError`.
5. Done: split the former aggregate-style `PoisonError` shape into typed
   individual and aggregate poison errors. `PoisonError` is now the individual
   non-fatal contextual error; `PoisonErrorGroup` is the multi-error aggregate
   and extends `PoisonError`, making `PoisonError` the shared
   `instanceof`/type-guard target for both.

## Post-H Follow-Up - Diagnostic Stack Metadata

This is a small diagnostic-quality follow-up after strict-context cleanup. Keep
the Phase H invariant changes intact; this pass should only refine what
buffer stack metadata is attached to stack frames and how that metadata is
named. A diagnostic stack frame's origin is the async/render boundary created
for the source operation; do not move stack attachment to later value consumers.

1. Revisit the `bufferStackErrorContext` display schema with real compiled stacks:
   - decide whether `branchName` should be renamed or split so conditional
     branch display (`If.Then`, `If.Else`, `Switch.Case`) is distinct from
     buffer/frame identity (`root`, `caller`, component binding, macro name)
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
3. After the display schema is settled, update compact-context added metadata
   emitted by compiler boundary helpers and docs together.
   Avoid changing source-origin error contexts (`ec`) as part of this pass.

## Phase J - Final Generated Artifacts And Public Surface

This is the terminal cleanup phase. Do not start it until strict-context cleanup
and error-family semantics have settled.

Prerequisite: Phase H has removed the generated boundary fallback, and Phase I
item 4 is complete.

1. Done: re-checked generated/precompiled boundary calls after the final async
   compatibility adapters are removed. Boundary helper calls should continue to
   pass the final buffer stack error context argument explicitly.
2. Done: performed the terminal quick-suite pass after final async
   compatibility adapters were removed. This closes out fixture churn from the
   refactor and is distinct from incremental fixture updates in earlier phases.
3. Done: re-checked public exports, tests, active docs, and TypeScript
   declarations after the strict-context and error-family phases. The public
   surface now exports and documents `CascadaError`, `CompileError`,
   `RuntimeError`, `PoisonError`, `PoisonErrorGroup`,
   `isPoisonError(...)`, and `isRuntimeError(...)`. Public docs describe
   render failures as `CompileError | RuntimeError | PoisonError | PoisonErrorGroup`,
   and `peekError(...)` / `#` as returning `PoisonError | PoisonErrorGroup | null/none`.
4. Done: reviewed `error-context-refactor.md` and other referenced docs for
   stale terminology not already fixed in-phase, including `cb`,
   `reportedError`, old aggregate-style `PoisonError` examples, and old runtime
   type descriptions. Historical first-stage planning docs are now explicitly
   marked as historical instead of being rewritten as current guidance.
5. Done: revisited `TODO(strict-error-context-cleanup)` direct runtime helper
   compatibility. No source/test TODO markers remain. The remaining
   `errorContext: null` runtime entries are no-parent/finalization metadata
   sentinels rather than compiler-owned async helper fallbacks.

## Phase K - Post-Semantic Cleanup

This is a low-risk cleanup phase after H/I/J have settled. It should not change
the public error taxonomy or source-origin behavior; each item should either be
behavior-preserving or come with focused tests that spell out the intended
contract.

1. [x] Inline `resolveRuntimeErrorContext(...)` into the `RuntimeError` constructor
   unless another real caller appears. It is constructor-local selection logic,
   not a reusable runtime concept.
2. [x] Decide whether `PoisonErrorGroup` should reject an existing
   `PoisonErrorGroup` constructor input. Today `PoisonError.group(...)` is the
   intended aggregate entry point, and direct re-wrapping is not a meaningful
   public use case.
3. [x] Remove double normalization/deduplication paths in poison aggregation if a
   local simplification keeps the constructor and factory contracts clear.
   Preserve the current identity-based deduplication semantics.
4. Deferred: do not add a small `PoisonError.toErrors(...)`-style helper unless
   repeated `isPoisonError(value) ? value.errors : [value]` patterns reappear.
   Call sites are currently clean, so adding it speculatively would increase
   surface area without simplifying active code.
5. [x] Add an assertion or explicit test around `RuntimeError.create(existing,
   context)` ignoring the second context. If idempotency remains the contract,
   either require the second context to be absent or document why it is ignored.
6. [x] Keep the active docs and TypeScript declarations aligned with the strict
   internal error API. Runtime code creates `RuntimeError` and `PoisonError`
   through compact-context factories, but the public declarations expose these
   error classes only as inspectable/catchable error types. The compact context
   tuple, runtime error factories, poison factories, and
   `createPoison(typedPoisonError)` are internal runtime transports, not public
   API.
7. [x] Remove stale public TypeScript support for the `{ ec, ...metadata }`
   runtime-context wrapper and later the compact context tuple itself. Compact
   context is an internal compiled/runtime ABI, not a language-user API.
8. [x] Keep `createSyncRuntimeError(...)` publicly exported only as the frozen sync
   compiler adapter. It is not part of the async runtime error model, and new
   async/runtime code should use `RuntimeError.create(...)`,
   `RuntimeError.report(...)`, or `RuntimeError.reportAndThrow(...)`. Do not
   include `createSyncRuntimeError(...)` in async error API docs except as a sync
   compatibility note.
9. [x] Record the import/from-import `RuntimePromise` wrapping from
   `error-handling-analysis.md` Phase 2 as complete. Async `import` and
   `from import` loading paths now wrap emitted `.then(...)` chains in
   `RuntimePromise`, and from-import bindings use `RuntimePromise` instead of
   raw async IIFEs. Remaining follow-up from that analysis belongs in a later
   consumer-hardening phase rather than Phase K.
10. [x] Verify declaration/doc alignment by checking both public declaration
    entry points (`src/index.d.ts` and `src/precompiled/index.d.ts`) after any
    runtime error API surface changes. At minimum, run lint and inspect both
    declaration files; add a declaration smoke test if the project gains a
    TypeScript verification step.
11. [x] Rename the private poison helpers so their contracts are clear:
    `_normalizePoisonErrors(...)` validates and flattens existing typed poison
    errors, while `_deduplicateCollectedErrors(...)` remains the private
    `collectErrors(...)` dedup helper. Further consolidation is not required for
    Phase K unless duplication grows again.
12. [x] Remove the legacy `cause.errorContext` fallback from `RuntimeError`
    construction. Runtime-owned context is `_errorContext`; accepting plain
    `errorContext` risks accidental matches on third-party errors.
13. [x] Document the intentional `RuntimeError.report(existingRuntimeError,
    context)` asymmetry: the existing error keeps its origin, while the supplied
    context is used only to find the active `renderState` for reporting.
14. [x] Tighten poison aggregation readability: use caller-agnostic validation
    messages in `_normalizePoisonErrors(...)`, remove stale `deduped` aliases,
    document existing-poison passthrough in `PoisonError.wrap(...)`, and document
    the defensive `RuntimePromise._wrapRejection(isPoison(...))` safety net.
15. [x] Track the private poison-group construction token for Phase M cleanup.
    Phase M removed the `NormalizedPoisonGroupState` class and kept the
    single-validation path through `PoisonErrorGroup._fromState(...)`.
16. [x] Remove active test usages of the pre-Phase-K
    `createPoison([new Error(...)])` shape. Tests should construct poison
    through `PoisonError.create(...)`, `PoisonError.wrap(...)`, or
    `PoisonError.group(...)` before passing it to `createPoison(...)`; the only
    remaining raw-error `createPoison(...)` call should be the unit test that
    asserts the strict factory contract rejects it.

## Phase L - RuntimePromise Consumer Hardening

Placeholder for the remaining follow-up from
`docs/code/error-handling-analysis.md` after Phase K's import/from-import source
wrapping is complete. This phase should be separate from Phase M's compact
context ABI work.

1. [x] Audit consumers whose inputs are now guaranteed to arrive through
   `RuntimePromise`, especially catch blocks that still contain non-`PoisonError`
   fallback branches. The audit covers raw-error-to-poison conversions generally,
   not only literal `createPoison(err)` calls. Remaining `createPoison(err)`
   calls are guarded by `isPoisonError(err)`.
2. [x] Replace unreachable raw rejection fallbacks with fatal propagation where
   source wrapping guarantees hold. Output materialization now treats non-poison
   value-consumption rejections as `RuntimeError`, and async lookup separates
   resolution failures from lookup-operation failures so raw resolution failures
   cannot be converted into lookup poison. Command argument resolution, chain
   target inspection, and sequential-path async operation rejection also preserve
   existing poison while treating raw async failures as fatal.
3. [x] Revisit fire-and-forget sink behavior and callback-owned boundaries.
   Existing `runValueBoundary(...)`, guard repair/setup promises, and render
   boundary callbacks intentionally route non-poison failures through
   render-state fatal reporting or marked handled promises; no additional
   compatibility path was added.
4. [x] Reconfirm `collectErrors(...)` and `isError(...)` behavior for raw promise
   or lazy-marker rejections. Raw non-poison rejections remain fatal unless a
   source boundary intentionally wraps them as poison.
5. [x] Verify with integration-heavy coverage rather than adding compatibility
   scaffolding. Existing RuntimePromise, error-context, poison, chain, loop, and
   path-assignment tests cover promise-returning imports, function calls, loops,
   output application, command arguments, chain inspection, sequential paths, and
   raw lazy-marker fatal behavior.

### Post-L Follow-Up

1. Revisit `_suppressValueScriptComplex(...)` array handling for parity with
   `_suppressValueAsyncComplex(...)`. The script path currently resolves arrays
   directly with `resolveAll(...)`; a future pass should consider collecting all
   poison errors before resolution so script text output follows the same
   "never miss any error" behavior as template output.

## Phase M - Compact Added Context Unification

This phase removes the current hybrid buffer-stack error context shape and makes the
compact context the single carrier for source position plus optional added
diagnostic metadata. The goal is one narrow consumption boundary: ordinary
runtime code carries compact context as opaque data, and error classes unpack it
when constructing or formatting diagnostic output.

### Target Shape

Replace the current compact context:

```js
[lineno, colno, label, path, renderState]
```

with:

```js
[lineno, colno, label, path, addedContext, renderState]
```

Rules:

1. `addedContext` is `null` when there are no extra diagnostic fields.
2. `addedContext` contains command-buffer/render metadata such as
   `entryName`, `methodName`, `loop`, `macroName`, `macroSignature`,
   `callableName`, `callSignature`, `includeName`, or `loadName`.
3. `label` lives only in tuple slot `2`. When an owned context needs a
   diagnostic-stack identity such as `If.Then` or `Iteration`, mutate slot `2`
   with `setContextLabel(...)`; do not put label overrides in `addedContext`.
4. `renderState` moves from slot `4` to slot `5`; it remains runtime
   coordination state, not diagnostic source metadata.
5. Do not add an `ec` wrapper around compact context. The compact context is
   itself the `ec`.

### Architecture

1. `CommandBuffer` stores and exposes only compact context values. It must not
   store or expose expanded diagnostic context objects or a separate
   `{ ec, ...metadata }` wrapper object.
2. Diagnostic stack is computed from the command-buffer graph as an array of
   compact contexts:

```js
[compactContext, compactContext, compactContext]
```

   The stack has no expanded frames and no wrapper objects. Error classes
   normalize each compact context only when constructing `fullMessage`,
   `getInfo(...)`, or `formatInfo(...)`.
3. `RuntimeContextError`, `RuntimeError`, `PoisonError`, and
   `PoisonErrorGroup` are the only places that unpack compact context into an
   expanded diagnostic object.
4. Any printed diagnostic context with extra properties is formatted the same
   way no matter where it came from. The formatting layer receives one expanded
   object:

```js
{
  lineno,
  colno,
  label,
  path,
  renderState,
  ...addedContext
}
```

5. Source-origin data is always taken from the compact tuple fields. Added
   metadata may add printable details, but must not replace `lineno`, `colno`,
   `label`, `path`, or `renderState`.
6. The origin AST node compiled code is the only place that chooses or creates
   an error context. It may emit a shared static tuple, an initialized owned
   clone, or a dynamic owned clone. The same expression is then passed to every
   command, helper, and buffer owned by that origin.
7. Prepared compact contexts are shared/read-only. Initialized and dynamic
   contexts are owned clones. `CommandBuffer` stores the compact context it
   receives directly; it does not clone or add metadata on behalf of the
   compiler. Only owned clones may be mutated after construction.
8. Compiler state may carry inherited added metadata, such as `{ loop }`, so a
   nested AST node can build its own source context plus ambient diagnostics.
   Compiler state must not carry a "current context" for a lexical region.
9. Dynamic boundary updates must mutate the origin-owned compact context through
   `runtime.mergeAddedContext(ownedContext, addedContext)` or
   `runtime.setContextLabel(ownedContext, label)` once the delayed control-flow
   data is known. Compiled code should not mutate tuple slots or added-context
   objects directly.
10. Promise-valued diagnostic metadata is never awaited. Diagnostic formatting
   should print thenables as `?` with minimal custom formatting rather than
   using `JSON.stringify(...)` for values that need pseudo-JSON output.

### Specific Field Decisions

1. Remove boundary/display metadata label fields from `addedContext`.
   Diagnostic labels are tuple labels only.
2. Add a narrow `setContextLabel(errorContext, label)` helper for owned
   contexts that need their tuple label updated after cloning.
3. Treat `addedContext.label`, `addedContext.lineno`,
   `addedContext.colno`, `addedContext.path`, and
   `addedContext.renderState` as invalid internal shape bugs. Source-origin
   fields come only from tuple slots.
4. Resolve the old `branchName` follow-up during this phase. Remove generic
   branch-direction metadata when the tuple label already carries the branch
   identity. Use tuple labels such as `If.Then`, `If.Else`, `Switch.Case`,
   `Switch.Default`, and `Loop.Else`; keep only non-duplicative detail such as
   `caseValue` for literal switch cases or `dynamicCase` for expression-based
   switch cases.
5. Keep `CommandBuffer.renderState` only if it remains a derived convenience
   field from compact context slot `5` or parent state. Otherwise replace direct
   reads with `getRenderState(buffer.errorContext)` / normalized access. The
   phase must update the constructor parameter and initialization logic either
   way.

### Implementation Steps

Use these as review/checkpoint slices, not as a requirement to make every
intermediate state independently shippable. Do not add dual-shape compatibility
or temporary scaffolding just to make M1/M2/M3 pass in isolation. If the cleanest
implementation requires landing several slices together, prefer the cohesive
change and verify it at the end. The split exists to keep the work readable and
to make it clear which concerns are being handled.

#### M1 - Tuple ABI And Access Helpers

1. [x] Update `prepareErrorContexts(...)` to produce six-element compact contexts.
2. [x] Update compiler-generated context tables and all helper call sites that read
   or construct compact contexts for the slot migration (`renderState` moves
   from slot `4` to slot `5`).
3. [x] Add small context helpers for tuple-safe operations:
   - `getRenderState(errorContext)` or equivalent normalized access for slot `5`
   - `getAddedContext(errorContext)`
   - `cloneContext(errorContext)` for copying a compact context before mutating
     delayed dynamic metadata into the clone
   - `cloneWithAddedContext(errorContext, addedContext)` for cloning the compact
     context and adding diagnostic metadata in the fifth tuple position
   - `mergeAddedContext(errorContext, addedContext)` for mutating an owned
     compact context clone once delayed dynamic metadata is known
   Keep these helpers minimal and avoid broader abstractions.

#### M2 - Added Context Ownership

4. [x] Move metadata currently passed as `{ ec, entryName, methodName, ... }` into
   the `addedContext` slot.
5. [x] Update compact context emission explicitly. Static origins use
   `emitErrorContext(...)` and may pass shared prepared contexts. Dynamic
   origins that need later mutation use `emitClonedErrorContext(...)`. Neither
   path emits `{ ec: __ec[i], ...metadata }`.
6. [x] Update async boundary helpers, command-buffer setup, inheritance/include/import
   boundaries, macro/function call metadata, loop/iteration metadata,
   and any direct tests that currently pass `{ ec, ... }`.
7. [x] Update `CommandBuffer` construction to accept/store compact context directly.
   Context validation should require a compact array, not an object with `ec`.
8. [x] Update dynamic branch codegen currently mutating fields such as
   `currentBuffer.bufferStackErrorContext.branch = 'then'` or `'case'` to call
   `runtime.mergeAddedContext(...)` on the origin-owned compact context.
9. [x] Thread inherited added metadata through compiler state so each nested AST
   node can create its own context with
   `cloneWithAddedContext(__ec[index], inheritedAddedContext)` instead of
   reusing a region-wide current context.

#### M3 - Error Consumption And Diagnostic Stack

10. [x] Update `RuntimeContextError._normalizeContext(...)` to consume the six-slot
   compact context and merge `addedContext` at the error-class boundary. This
   is a major simplification: remove the `isBufferStackContext(...)` branch, the
   `{ ec, ...metadata }` indirection, reserved-key filtering, and expanded-field
   assertion from normalization.
11. [x] Update command-buffer stack helpers so `getDiagnosticStack()` returns only an
   array of compact contexts. Error methods normalize those contexts when
   formatting stack output.
12. [x] Update `RuntimeContextError.getInfo(...)` / `formatInfo(...)` so compact
   fallback contexts and compact-context stack arrays behave consistently.
13. [x] Add minimal pseudo-JSON diagnostic value formatting for thenables in metadata
    so promise-valued fields print as `?`, e.g. `{"last":?}`, without awaiting.
14. [x] Update tests to assert compact context opacity before error construction and
   identical formatting for added context regardless of source.

#### M4 - Fixtures, Declarations, And Cleanup

15. [x] Regenerate precompiled/browser fixtures and any generated snapshots affected
    by the compiled error-context ABI change.
16. [x] Update TypeScript declarations and active docs to describe the six-slot
    compact context shape.
17. [x] Complete the cleanup checklist below only after the tuple ABI,
    command-buffer ownership, and error-consumption changes are all in their
    final shape. Do not preserve temporary compatibility paths for cleanup to
    remove later unless they are unavoidable during the implementation.
    Wrapper cleanup is complete. Error construction receives explicit stack
    sources where stack output is needed, and diagnostic stacks remain arrays
    of compact contexts.

### Cleanup

These should be removed once the new compact context shape is in place.

1. Remove `isBufferStackContext(...)`.
   - Status: done.
2. Remove `BUFFER_STACK_CONTEXT_CONTROL_KEYS`.
   - Status: done.
3. Remove `EXPANDED_SOURCE_CONTEXT_KEYS`.
   - Status: done.
4. Remove `assertNoExpandedSourceContext(...)`.
   - Status: done.
5. Remove all `{ ec, ...metadata }` construction and detection paths.
   - Status: done for source and active tests; regenerated browser precompiled
     fixtures also use compact contexts.
6. Remove `bufferStackErrorContext.diagnosticStack` lazy getter transport.
   - Status: done. Fatal error construction/reporting now receives an explicit
     stack buffer/source where stack output is needed.
7. Remove reserved-key filtering in `RuntimeContextError._normalizeContext(...)`.
   - Status: done. Added context still rejects source-field keys directly.
8. Remove defensive deletion/filtering of `diagnosticStack`, `lineno`, `colno`,
   `path`, and `renderState` from `CommandBuffer.getDiagnosticContext()`.
   - Status: done with `CommandBuffer.getDiagnosticContext()` removal.
9. Remove `CommandBuffer.getDiagnosticContext()` unless a narrow test-only use
   remains. No expanded diagnostic context should exist outside error methods.
   - Status: done.
10. Remove or collapse cloned context emission after all metadata has moved into
    compact context slot `4`.
    - Status: collapsed to two paths. Static added context is emitted as
      `[lineno, colno, label, addedContext]` and can be shared through
      `emitErrorContext(...)`. Dynamic context that is only known after boundary
      creation uses `emitClonedErrorContext(...)`, then
      `runtime.mergeAddedContext(...)` or `runtime.setContextLabel(...)` on the
      origin-owned compact context.
11. Remove direct dynamic mutations of `currentBuffer.bufferStackErrorContext.*`.
    - Status: done; compiled dynamic branch code uses `runtime.mergeAddedContext(...)`
      on the origin-owned compact context.
12. Remove or rename all `label` metadata fields that are display overrides;
    use tuple label mutation instead of added-context label metadata.
    - Status: done; owned contexts use `runtime.setContextLabel(...)` for
      diagnostic-stack identity.
13. Remove or resolve stale `branchName` metadata paths.
    - Status: done; branch identity is represented by the tuple label where it
      affects the printed context. Non-duplicative switch-case detail uses
      `caseValue` or `dynamicCase`.
14. Remove tests that assert wrapper-specific behavior and replace them with
   tests for six-slot compact contexts plus added context.
    - Status: done for active tests.
15. Search for stale five-slot assumptions, especially direct `ec[4]`
    `renderState` reads, and update them to slot `5` or normalized access.
    - Status: done for source and active tests.
16. Remove any runtime field, helper return value, or command payload that carries
    expanded context data outside `RuntimeContextError` methods.
    - Status: done.
17. Revisit `NormalizedPoisonGroupState` and
    `PoisonErrorGroup._buildStateFromNormalizedErrors(...)` after compact
    context unification. If Phase M removes the remaining context-construction
    special cases, replace the state wrapper with a narrower private factory or
    inline constructor path so poison grouping has less ceremony.
    - Status: done. The state wrapper class is removed; `PoisonError.group(...)`
      uses the private `_fromState(...)` path to avoid double
      validation/deduplication while direct `new PoisonErrorGroup(existingGroup)`
      remains rejected.
18. Simplify the `RuntimeError` constructor after wrapper-context support is
    gone. The remaining selection logic should be limited to cause-owned compact
    origin context, direct compact context, and the last-resort contextless
    fatal fallback.
    - Status: done. The pre-underscore `error.errorContext` bridge and wrapper
      context detection are removed.
19. Revisit `RuntimeContextError` constructor options after wrapper removal. If
    `normalizedContext` is only serving the last-resort contextless fatal path,
    narrow it or replace it with an explicit contextless constructor path.
    - Status: done. `normalizedContext`, `storedErrorContext`,
      `diagnosticFullHeaderLines`, and `diagnosticName` are removed.
      `RuntimeContextError` now owns compact-context normalization directly and
      keeps the contextless fatal-runtime fallback as an explicit named
      last-resort diagnostic context.
20. After Phase M, evaluate whether `PoisonedValue`, `createPoison(...)`,
    `isPoison(...)`, `collectErrors(...)`, and `peekError(...)` should remain in
    `runtime/errors.js` or move to a small poison-transport module. Do this only
    if `errors.js` still feels crowded after wrapper-context cleanup.
    - Decision: keep them in `runtime/errors.js` for now. Poison transport,
      poison grouping, and runtime-promise rejection normalization are tightly
      coupled enough that a split would add import churn without making
      ownership clearer.
21. Future optimization: evaluate per-command `cloneWithAddedContext(...)`
    allocation inside loop bodies and other inherited-metadata regions. Any
    optimization must preserve the three-mode ownership model and must not
    normalize context before error handling consumes it.
    - Decision: keep the eager clone/merge path in Phase N. Lazy merge would
      introduce another context representation for consumers; the current shape
      is allocation-heavier but simpler and keeps every runtime consumer holding
      one compact context tuple.

### Future Phase N - Error Runtime Slimming

Phase M is functionally complete. The remaining work is not tuple-ABI cleanup;
it is either API narrowing or runtime module slimming. Keep it separate unless a
small simplification is clearly behavior-preserving.

#### Goals

1. Keep Phase M's compact-context ownership model unchanged.
2. Reduce `runtime/errors.js` ceremony where the current implementation is only
   carrying post-refactor structure.
3. Improve inherited-diagnostic allocation only if the result is simpler or at
   least no more complex than the current code.

#### Scope

1. Record the `withInheritedLabelOverride(...)` / loop-else source-label
   exception as accepted for now.
   - Current code uses `withInheritedLabelOverride('"Loop.Else"', ...)` so every
     command compiled inside loop.else emits an owned context whose tuple label
     is `Loop.Else`.
   - This is useful because loop.else has no dedicated boundary frame, but it
     replaces the command's own source label.
   - As a result, commands inside loop.else display `Loop.Else` as their label
     rather than their own source-operation label.
   - Decision: keep the current implementation because it is simple, works, and
     preserves useful loop.else diagnostics without adding a dedicated boundary
     buffer. Treat it as a narrow accepted exception to the usual source-label
     rule.
   - No Phase N code work is planned for this item unless later diagnostics show
     that the exception causes real confusion.
2. Narrow `RuntimeContextError` constructor options where the current option
   object is only carrying post-refactor structure. Preserve the rule that
   ordinary fatal and poison errors require compact origin context.
   - Done: removed `normalizedContext` as a general option. `RuntimeContextError`
     now owns normal compact-context normalization and the explicit
     last-resort contextless fatal-runtime fallback.
   - Done: removed `storedErrorContext`; the positional compact origin context
     is stored directly as `this._errorContext`, or `null` for the contextless
     fatal fallback.
   - Done: kept `CONTEXTLESS_FATAL_RUNTIME_CONTEXT` as a named last-resort
     expanded diagnostic object with a code comment making clear that ordinary
     runtime and poison errors must carry compact origin context.
   - Done: `reportRuntimeContractError(...)` still uses the same last-resort
     contextless fatal path when no origin context is available.
   - Done: removed `diagnosticFullHeaderLines`; compact and full messages now
     share one `headerLines` option, with the diagnostic stack being the only
     formatting difference.
   - Done: removed the `diagnosticName` option. Error display identity now comes
     from the class/family name passed to `RuntimeContextError`.
   - Done: `RuntimeError` no longer prefixes its `.name` with the wrapped
     cause's name. Wrapped fatal errors now keep the family name `RuntimeError`
     while preserving the cause message, stack, and copied properties.
3. Keep compact context ABI helpers in `runtime/error-context.js`, separate from
   error semantics.
   - Status: complete. This is now a policy/checkpoint, not active scope.
   - Done: `prepareErrorContexts(...)`, compact-context predicates, accessors,
     cloning, mutation, and added-context validation now live in
     `runtime/error-context.js`.
   - Keep expanded diagnostic normalization in `RuntimeContextError`. Do not
     move `_normalizeContext(...)`, `_normalizeDiagnosticStack(...)`,
     `getInfo(...)`, or `formatInfo(...)` into `runtime/error-context.js`; those
     are error-consumption behavior, not ordinary runtime context handling.
   - Treat helpers exported from `runtime/runtime.js` as internal compiled
     runtime ABI. They should remain absent from public `.d.ts` declarations
     unless a future API decision intentionally exposes them.
4. Public declaration cleanup already completed during this phase should remain
   recorded as public-surface work, not constructor-option work.
   - Removed public `RuntimeErrorOptions` declarations and converted internal
     runtime reporting to pass a direct stack buffer argument instead of an
     options object.
   - Removed public compact-context tuple declarations and public
     `CompileError`/`RuntimeError`/`PoisonError` factory and constructor
     signatures. Public declarations keep the error classes available for
     inspection and narrowing without advertising internal construction.
   - Added `isCompileError(...)` declaration/export parity for the precompiled
     entry and removed public `CompileErrorOptions`.
5. Evaluate whether `PoisonedValue`, `createPoison(...)`, `isPoison(...)`,
   `collectErrors(...)`, and `peekError(...)` should move from
   `runtime/errors.js` into a small poison-transport module. Do not split the
   module unless it makes imports and ownership clearer.
   - Decision: keep poison transport in `runtime/errors.js` for now.
     `PoisonedValue`, `createPoison(...)`, `PoisonError.group(...)`,
     `collectErrors(...)`, and `peekError(...)` are tightly coupled, and moving
     only some of them would create cross-module dependency churn without a
     clearer ownership boundary.
   - Decision: keep `PoisonError`, `PoisonErrorGroup`, and `RuntimePromise` in
     `runtime/errors.js`. They are part of the active error taxonomy and
     promise-boundary normalization behavior.
6. Evaluate inherited-metadata allocation cost, especially per-command
   `cloneWithAddedContext(...)` in loop bodies and loop-else label inheritance.
   Any optimization must preserve the three ownership modes and keep
   normalization inside error handling only.
   - Do not introduce a region-wide current error-context state. The origin AST
     node compiled code must still choose/create the context for that origin.
   - Decision: do not implement lazy merge in Phase N. Carrying
     `(staticErrorContext, inheritedAddedContext)` to error construction would
     introduce another context representation and spread merge responsibility
     into consumers. The current eager clone/merge path is simpler and keeps the
     compact context shape uniform.

#### Non-Goals

1. Do not change the compact context tuple ABI.
2. Do not reintroduce wrapper contexts, expanded diagnostic frames, or
   `displayLabel`/added-context label precedence.
3. Do not add runtime compatibility for stale precompiled artifacts.
4. Do not optimize by normalizing context earlier than error construction,
   `getInfo(...)`, or `formatInfo(...)`.
5. Do not expose compact-context helpers or compact tuple types in public
   declaration files merely because generated runtime code imports them through
   `runtime/runtime.js`.

#### Checkpoints

1. Audit `RuntimeContextError`, `RuntimeError`, `PoisonError`, and
   `PoisonErrorGroup` constructor paths for option fields that are now
   single-purpose or redundant. Done for `normalizedContext`,
   `storedErrorContext`, `diagnosticFullHeaderLines`, and `diagnosticName`.
2. Confirm `runtime/error-context.js` remains limited to compact tuple ABI
   operations and does not grow error-class normalization/formatting behavior.
3. Decide whether poison transport belongs in `errors.js` or a separate module;
   if split, keep public exports stable. Decision: keep it in `errors.js`.
4. Inspect generated loop and branch code for unnecessary owned-context clones.
   Use the lazy-merge option from scope item 6 as the concrete candidate. If a
   simpler allocation pattern exists, cover it with integration tests that
   verify loop metadata, branch labels, and origin preservation. Decision: do
   not add lazy merge in Phase N because it introduces another context shape.
5. Re-run the focused error suites:
   `tests/pasync/error-context.js`, `tests/poison/unit.js`, and loop/branch
   integration tests.
