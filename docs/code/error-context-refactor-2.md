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
- `contextualizeError(error, errorContext, currentBuffer)` is the async runtime
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
   runtime code uses `contextualizeError(error, errorContext, currentBuffer)`.
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
8. Re-checked `attachErrorContextIfMissing(...)` and `PoisonError.errors`
   handling. `attachErrorContextIfMissing(...)` remains a private compact-only
   helper for already-wrapped errors; `PoisonError.errors` in-place mutation is
   left for a later behavior-preserving cleanup if needed.

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
   runtime entries. The raw compiled callable may continue to accept `__ec` as a
   low-level final parameter, but inheritance invocation should not rediscover
   or select a table for each call; the runtime entry should provide its bound
   owner table when it invokes the compiled function. Create the wrapper during
   `InheritanceInstance.create` so it closes over the per-instance
   reporter-bearing table, not the finalization-time `reportError = null` table.
   Remove the explicit table argument from `_invokeFromMethodData(...)`'s call
   to `methodData.fn(...)` once wrappers provide the callable's owner table.
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

The Phase C runtime binding is correct, but it still needs wrapper functions
because inherited callables keep the low-level final `__ec` parameter. This
phase removes that ABI pressure so the runtime metadata binding can shrink
instead of wrapping solely to append an owner table.

1. Audit the compiled callable ABI for inherited methods, template blocks,
   constructors, and any macro/caller paths that can participate in inheritance.
   Identify every place that emits or invokes the final low-level `__ec`
   parameter.
2. Replace the final `__ec` parameter with a cleaner ownership model. Prefer a
   generated callable shape where the owner table is already closed over or
   otherwise explicitly bound at owner-entry creation, while keeping prepared
   tables per `InheritanceInstance` so concurrent renders do not share
   callback-bearing contexts.
3. Keep per-render `reportError` ownership unchanged: prepared error-context
   tables must still be created per inheritance instance and must not be stored
   globally on compiled template/script artifacts.
4. Remove or materially shrink `bindInheritanceRuntimeState(...)` and related
   helpers in `bind-instance-metadata.js` once compiled callables no longer need
   a runtime wrapper only to append the owner table.
5. Regenerate precompiled/browser fixtures after the ABI change. This should
   also remove stale generated `entryErrorContextTable: __ec` fields.
6. Re-run inheritance, error-context, precompile, and browser fixture tests.

## Phase E - Error Taxonomy And Fatal Delivery

1. Reduce runtime error families to the target three:
   `PoisonError`, `RuntimeError`, and `CompileError`.
2. Evaluate `RuntimeFatalError`. If it is redundant now that non-poison
   runtime errors are fatal by default, remove it or reduce it to a
   compatibility alias/shim.
3. Make `handleFatal(...)` the only fatal delivery helper. It should wrap via
   the runtime error constructor path, report through the prepared context's
   `cb` when present, and throw/rethrow according to the audited boundary
   contract.
4. Audit all `handleFatal(...)` callers before changing delivery behavior so
   callback reporting and rethrow behavior are deliberate and covered.
5. Audit `RuntimeError` construction so non-poison runtime errors are created
   with an explicit source context wherever compiler/runtime ownership can
   provide one. Any remaining `null` context should be intentional and covered.
6. Remove or shrink the temporary error-context glue cluster once the
   constructor boundary is canonical:
   - `EMPTY_ERROR_CONTEXT_INFO` - placeholder for missing async context; delete
     when missing async context is no longer tolerated.
   - `normalizeOptionalErrorContext(...)` - migration wrapper for nullable
     contexts; replace callers with `normalizeErrorContext(...)` once compact
     context is required.
   - `attachErrorContextIfMissing(...)` - bridge for already-positioned
     legacy/sync-shaped errors that lack compact `errorContext`; delete after
     async runtime errors are always constructed with compact context up front.
   - `resolveEffectiveErrorContext(...)` - currently mixes the useful compact
     context precedence rule with legacy/non-array tolerance; shrink it to the
     final precedence rule or inline that rule into constructors.
   - `RuntimeFatalError` compatibility surface - remove or reduce to an alias if
     `RuntimeError` is the only non-poison runtime error type.
   - `handleError(...)` exposure to async/runtime code - keep isolated for the
     frozen sync compiler path only.
7. Decide the final role of the `currentBuffer` parameter on
   `contextualizeError(...)`, `createPoison(...)`, and `handleFatal(...)`.
   Either use it for stack enrichment through `getErrorInfo(...)` or remove it
   from helpers that do not need direct buffer access.
8. Re-check `PoisonError` handling and remove the in-place mutation of
   `PoisonError.errors` if it can be replaced with clearer construction without
   changing multiple-error propagation.
9. Migrate tests that assert `RuntimeFatalError` specifically to the final
   runtime error contract.
10. Re-check docs and public exports so the error taxonomy is explicit and
    small.

## Phase F - Helper Ownership And Buffer API Cleanup

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
   module.
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
   `normalizeOptionalErrorContext(...)` and `EMPTY_ERROR_CONTEXT_INFO` in the
   same cleanup, leaving `normalizeErrorContext(...)` as the only normalization
   path for non-null compact contexts.
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
