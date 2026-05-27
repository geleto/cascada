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
- `normalizeErrorContext(ec)` expects a non-null compact prepared context;
  callers that still permit no context during migration must handle that before
  normalization
- `contextualizeError(error, errorContext)` is the async runtime
  wrapper for non-poison errors
- `handleError(error, lineno, colno, label, path)` remains only for the frozen
  synchronous Nunjucks-compatible compiler path
- synchronous positional `handleError(...)` calls must not be rewritten as part
  of this cleanup
- wrapped errors preserve the first source-origin context assigned to them
- `PoisonError` stores context on contained errors, not as the wrapper origin
- async helpers, commands, and buffer branches should receive an originating
  `errorContext`; handling for missing async contexts is temporary cleanup
  scaffolding
- commands and direct chain invocations receive their source-origin
  `errorContext` explicitly; they must not infer it from the current buffer
- command buffers use `bufferBranchContext` only for buffer-branch trace
  frames, such as root, call, loop, include/render, and condition buffers. It is
  not a fallback source context for commands.
- command and branch diagnostics must not invent source origin from ambient
  buffer, parent, or render context state

## Out Of Scope

- changing the frozen synchronous Nunjucks-compatible compiler path
- preserving producer-origin context on `RuntimePromise` beyond places where it
  consumes or reports errors
- introducing a class-based `ErrorContext`
- using command-buffer stack context as a replacement for source-origin context

## Phase A - Remove Async Legacy Error-Context Adapters

Implemented for the async runtime:

1. Removed the remaining async/runtime positional and object-context adapters:
   `resolveErrorContextArgs(...)`, `compactErrorContext(...)`, object support in
   `normalizeErrorContext(...)`, and object fallback conversion in
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

- Kept `RuntimeFatalError` as the current hard-runtime-error marker. The audit
  confirmed it is still used by value-consumption boundaries to prevent
  structural runtime failures from being converted into poison.
- Removed the unused `currentBuffer` parameters from
  `contextualizeError(...)`, `createPoison(...)`, and `handleFatal(...)`.
  Command-buffer stack enrichment remains a `getErrorInfo(...)` concern.
- Removed `attachErrorContextIfMissing(...)` as a separate helper. The remaining
  late compact-context bridge is inline in `contextualizeError(...)` and marked
  for deletion.
- Audited `handleFatal(...)`: it currently has no runtime callers. Its existing
  callback-or-throw contract is preserved by focused tests, but fatal delivery
  unification belongs with the render fatal-state work rather than this phase.
- Re-checked `RuntimeFatalError` tests. Tests that assert the fatal-vs-poison
  distinction remain valid while `RuntimeFatalError` is the active marker.

End-state taxonomy goal:

The refactor still targets three user-visible error families:
`PoisonError`, `RuntimeError`, and `CompileError`. Phase E does not complete
that merge because `RuntimeFatalError` is still the active in-band marker that
prevents hard runtime failures from being downgraded to poison at
value-consumption boundaries. The merge is deferred until render fatal-state
delivery is in place and an equivalent `RuntimeError` fatal marker/property can
replace all `isRuntimeFatalError(...)` checks without changing behavior.

Phase E active taxonomy:

| Current type/helper | Phase E target |
| --- | --- |
| `PoisonedValue` | Value container, not an error family |
| `PoisonError` | Keep as the only poisoned-value error wrapper |
| `RuntimeError` | Keep as the only non-poison runtime error family |
| `RuntimeFatalError` | Keep during this phase as the hard-runtime-error marker; replace only when an equivalent `RuntimeError` fatal marker/property exists |
| `TemplateError` / compile errors | Move toward `CompileError` naming separately from runtime errors |
| `handleError(...)` | Frozen sync compiler adapter only |

1. Done: audit value-consumption boundaries before changing the fatal marker:
   command argument resolution, chain error recording, loop iteration catches,
   async boundary catches, and inheritance/component structural checks. Today
   `RuntimeFatalError` is the hard-runtime-error discriminator that prevents
   broken runtime contracts from being converted into poison at those
   consumption points.
2. Decision: `RuntimeFatalError` is not redundant yet. Keep it as the
   hard-runtime-error marker for Phase E unless the same pass introduces an
   equivalent `RuntimeError` fatal marker/property and updates all
   `isRuntimeFatalError(...)` call sites without changing fatal-vs-poison
   behavior.
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
   fallback paths is Phase G cleanup after render fatal-state behavior is
   stable.
6. Remove or shrink the temporary error-context glue cluster in dependency
   order:
   - Done: remove `attachErrorContextIfMissing(...)` as a separate helper.
     The remaining late compact-context bridge is now inline and marked at the
     already-wrapped error branch in `contextualizeError(...)`.
   - Shrink `resolveEffectiveErrorContext(...)` to the final compact-context
     precedence rule after non-array legacy tolerance is proven dead.
   - Deferred: keep `handleError(...)` isolated to the frozen sync compiler
     path; decide in Phase G whether runtime exports should expose it publicly
     or only through sync internals.
   - Deferred: remove `EMPTY_ERROR_CONTEXT_INFO` and
     `normalizeOptionalErrorContext(...)` last, together, after every async path
     has a guaranteed non-null compact context and all callers can use
     `normalizeErrorContext(...)` directly.
   - Revisit `RuntimeFatalError` only after item 2's replacement condition is
     met.
7. Done: remove the unused `currentBuffer` parameters from `contextualizeError(...)`,
   `createPoison(...)`, and `handleFatal(...)`. Stack enrichment remains a
   `getErrorInfo(error, ec, currentBuffer, includeStack)` concern rather than a
   side effect of contextualization.
8. Deferred: re-check `PoisonError` handling and remove the in-place mutation of
   `PoisonError.errors` if it can be replaced with clearer construction without
   changing multiple-error propagation. Verify that re-running
   `PoisonError` deduplication is idempotent, and note that immutable
   replacement means existing references to the old `PoisonError` object will
   not see newly contextualized contained errors.
9. Done: review tests that assert `RuntimeFatalError` specifically. Keep tests
   that verify the fatal-vs-poison distinction while `RuntimeFatalError` remains
   the marker; migrate only tests that assert subclass identity after a real
   replacement marker exists.
10. Done for current docs: re-check docs and public exports so the active error
    taxonomy is explicit. Public export narrowing is deferred to Phase G because
    the frozen sync adapter still imports through the shared runtime surface.

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
   no runtime callers today, and its tested callback-or-throw behavior already
   participates in render state when the compact context's `reportError` slot
   came from `renderState.reportError`. Keep it unchanged until Phase G decides
   whether to remove the helper or keep it as a narrow adapter.
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

1. Reconcile and either fill or explicitly drop deferred optional
   `bufferBranchContext` display fields. Use the current canonical field names
   (`branchName`, `loadName`, `targetIdentifier`, `loop`, `branch`) unless a
   specific field has been deliberately renamed. Re-evaluate the
   `branchName`/`branch` pair in particular: `branchName` currently identifies
   the buffer branch/root/callable frame, while `branch` identifies conditional
   direction such as `then` or `case`.
2. Rename or reframe the `CommandBuffer` constructor's `linkedParent` parameter
   as a chain `linkTarget`, not a diagnostic or ownership parent.
3. Simplify the long positional `managedBlock(...)` signature once
   error-context and trace-parent arguments have settled.
4. Review all helpers, methods, and small bridge functions added during this
   refactor for final ownership. Move them to the file/class that owns the
   concept, inline one-off helpers where clearer, and remove migration-only
   helpers instead of leaving them in incidental locations. This includes
   deciding whether `requireCommandErrorContext(...)` belongs in
   `commands/base.js` long term or in a smaller shared runtime validation
   module. Split `_generateErrorContext(...)` so label construction and
   compiler-table registration are separate, named operations; keep the frozen
   sync path behavior unchanged while doing so. Remove finalization-only fields
   such as `errorContextIndex` from bound method entries after the binder has
   resolved `errorContext` and `errorContextTable`.
5. Make `contextualizeError(...)` the single runtime error-context wrapper.
   Inline or remove helper wrappers that only forward to it, including
   `contextualize*` helpers that do not add real domain-specific data. Keep
   small helpers only when they attach additional command, chain, or buffer
   information before calling `contextualizeError(...)`.
6. Remove fallback handling for missing async error contexts after every async
   helper, command, and buffer branch has an originating context. This includes
   boundary fallback arrays such as `_reportBoundaryError(...)`'s
   no-`errorContext` path and any remaining `errorContext = null` defaults that
   hide missing compiler/runtime ownership. Remove
   `normalizeOptionalErrorContext(...)`, `EMPTY_ERROR_CONTEXT_INFO`, the
   remaining inline already-wrapped-error bridge in `contextualizeError(...)`,
   and nullable fallback handling in `resolveEffectiveErrorContext(...)` in the
   same cleanup, leaving `normalizeErrorContext(...)` as the only normalization
   path for non-null compact contexts. Do this after Phase F stabilizes fatal
   delivery and render-state reporting.
7. Remove remaining generated/precompiled boundary calls that omit the final
   buffer-branch context argument. The current browser precompile fixture still
   contains older `runControlFlowBoundary(...)` calls that rely on the boundary
   fallback path; regenerate it after the runtime fallback is removed.
8. Re-check command constructor shape and convert the positional
   `ErrorCommand(errors, errorContext)` signature to a spec object if the
   command API should be uniform after compatibility cleanup.
9. Perform the terminal precompile/browser fixture pass after final async
   compatibility adapters are removed. This closes out fixture churn from the
   refactor and is distinct from incremental fixture updates in earlier phases.
10. Revisit shared-schema default source locations. Merged shared schema entries
    currently use the declaration context for both `errorContext` and
    `defaultErrorContext`; preserving a parent's default initializer location
    would require a separate compiled `defaultErrorContextIndex` field.
11. Re-check `PoisonError` contextualization and replace in-place mutation with
    immutable construction only if re-running deduplication is behaviorally
    idempotent and no callers rely on the original `PoisonError` object being
    updated in place.
12. Re-check `handleFatal(...)` after Phase F. If it survives as an adapter,
    simplify its current double effective-context resolution; if render state
    owns fatal delivery directly, remove the helper instead.
13. Complete the error-family merge after Phase F: replace `RuntimeFatalError`
    with the final `RuntimeError` fatal marker/property, update all
    `isRuntimeFatalError(...)` value-consumption boundary checks, then narrow
    docs/tests/exports to the target user-visible families:
    `PoisonError`, `RuntimeError`, and `CompileError`.
14. Remove the `TODO(render-state-cleanup)` direct callback compatibility
    bridge in `AsyncTemplateRuntime.getExported(...)` once all production
    export callers enter through a render-state owner. Direct export execution
    should either receive an existing render state or create one explicitly at
    that boundary, not rebuild the old local callback/reported-error pattern.
15. Tighten render-state cleanup after behavior has settled:
    - make `reportFatalError(...)` a void reporter unless a real caller needs
      the stored error as a return value
    - avoid the redundant `reportFatalError(...)` call inside
      `raceRootResult(...)` when the fatal promise rejection already came from
      the same render state
    - remove redundant render-state aliases such as `InheritanceInstance.reportError`
      after internal callers use `this.renderState.reportError` directly
    - re-check `_stopAfterFatalReport(...)` cleanup for intermediate buffer
      stack entries and call any missing leave hooks needed for iterator
      bookkeeping
    - collapse duplicate adjacent `throwIfFatalErrorReported()` checks at
      composition/component/inheritance entry points where doing so does not
      weaken a real boundary
    - add or keep focused coverage for waited-control-flow cleanup when fatal
      state is reported while a waited child boundary is settling
