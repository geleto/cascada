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
- async helpers, commands, and boundaries should receive an originating
  `errorContext`; handling for missing async contexts is temporary cleanup
  scaffolding
- command and buffer diagnostics must not invent source origin from ambient
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
   `handleError(error, lineno, colno, label, path)` adapter, isolated behind
   `compactSyncErrorContext(...)`.
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

1. Remove command constructor `errorContext = null` defaults after every
   compiler-created and runtime-created command receives an owning context.
2. Remove the backward-compatible `pos` constructor argument and
   `positionFromErrorContext(...)` helper from `ChainCommand` and
   `ChainObservableCommand` once no remaining caller passes `pos`. Normalize
   compact contexts only at error-reporting points, not during command
   construction.
3. Remove the `ChainCommand` static-path label special case from
   `_generateErrorContext(...)`. Chain command diagnostics should combine the
   compact source context with command payload details at reporting sites.
4. After async command diagnostics no longer need legacy string labels, re-check
   `_generateErrorContext(...)` ownership. It must keep serving frozen sync
   compiler paths unless a separate sync-compiler cleanup is opened.

## Phase C - Inheritance Metadata And Test Cleanup

1. Replace hand-built inheritance metadata object error-context test scaffolding
   with integration tests or index-based fixture helpers, then remove the
   legacy fallback paths in inheritance finalization.
2. Simplify `getErrorContextCallback(...)` after inheritance legacy object
   fallbacks are removed. The final helper should only read the compact callback
   slot.
3. Evaluate whether `loadEntry(...)` and `createRuntimeOwnerEntry(...)` can be
   consolidated after the inheritance object error-context fallback paths are
   gone.
4. Re-check all inheritance names and payload fields so originating
   error-context values are named `errorContext`, `ec`, or another explicit
   context name. Historical `origin` names must not be used where the value is
   an originating error context.

## Phase D - Error Taxonomy And Fatal Delivery

1. Reduce runtime error families to the target three:
   `PoisonError`, `RuntimeError`, and compile/`TemplateError`.
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
6. Decide the final role of the `currentBuffer` parameter on
   `contextualizeError(...)`, `createPoison(...)`, and `handleFatal(...)`.
   Either use it for stack enrichment through `getErrorInfo(...)` or remove it
   from helpers that do not need direct buffer access.
7. Re-check `PoisonError` handling and remove the in-place mutation of
   `PoisonError.errors` if it can be replaced with clearer construction without
   changing multiple-error propagation.
8. Migrate tests that assert `RuntimeFatalError` specifically to the final
   runtime error contract.
9. Re-check docs and public exports so the error taxonomy is explicit and
   small.

## Phase E - Helper Ownership And Buffer API Cleanup

1. Reconcile and either fill or explicitly drop deferred optional command-buffer
   display fields. Use the canonical field names from the command-buffer
   context shape (`name`, `target`, `source`, `loop`, `branch`) unless a
   specific field has been deliberately renamed.
2. Rename or reframe the `CommandBuffer` constructor's `linkedParent` parameter
   as a chain `linkTarget`, not a diagnostic or ownership parent.
3. Simplify the long positional `managedBlock(...)` signature once
   error-context and trace-parent arguments have settled.
4. Review all helpers, methods, and small bridge functions added during this
   refactor for final ownership. Move them to the file/class that owns the
   concept, inline one-off helpers where clearer, and remove migration-only
   helpers instead of leaving them in incidental locations.
5. Make `contextualizeError(...)` the single runtime error-context wrapper.
   Inline or remove helper wrappers that only forward to it, including
   `contextualize*` helpers that do not add real domain-specific data. Keep
   small helpers only when they attach additional command, chain, or buffer
   information before calling `contextualizeError(...)`.
6. Remove fallback handling for missing async error contexts after every async
   helper, command, and boundary has an originating context. This includes
   boundary fallback arrays such as `_reportBoundaryError(...)`'s
   no-`errorContext` path and any remaining `errorContext = null` defaults that
   hide missing compiler/runtime ownership.
7. Perform the terminal precompile/browser fixture pass after final async
   compatibility adapters are removed. This closes out fixture churn from the
   refactor and is distinct from incremental fixture updates in earlier phases.
