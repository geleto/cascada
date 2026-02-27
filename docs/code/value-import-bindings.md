# VALUE_IMPORT_BINDINGS: From-Scratch Implementation Plan

## Goal

When `VALUE_IMPORT_BINDINGS=true`, import aliases are handled as value outputs, not vars:

- `{% import "x.njk" as m %}` -> `m` is a `value` output.
- `{% from "x.njk" import a, b as c %}` -> `a` / `c` are `value` outputs.

The implementation should stay simple:

1. Do not use legacy `frame.set/context.setVariable` for import aliases.
2. Keep command-tree ordering guarantees (always enqueue on compiler `currentBuffer`).
3. Resolve final values through snapshot/finalSnapshot semantics.
4. Publish exported `ctx` shape immediately (stable keys), while values resolve later.

## Required Context

### Legacy behavior (flag off)

Legacy imports store aliases as vars. Those var values can be promises. They are resolved lazily when used by normal async expression/call machinery.

Legacy export timing is already useful and should be reused:

- Export names are registered early with `context.addExport(name)`.
- `Template.getExported()` (async mode) returns the exported object immediately (values may be promises).
- Macro exports are bound immediately in `getExported()`.

Do not reinvent this part unless strictly required.

Macro readiness detail:

- Top-level macro bindings are created synchronously during root execution and assigned to context immediately.
- In async `getExported()`, macro exports are then bound and returned immediately.
- Therefore macro exports can be published as final callable values in the initial export object (or as immediately-resolved deferreds for uniformity).

### Why value imports are different

Value outputs are command-buffer based. Writes are ordered by command insertion; reads are point-in-stream snapshots. This is the model we want for imported aliases too.

### Hard invariants

- Never bypass command insertion order for writes.
- Never write commands to buffers other than compiler `currentBuffer`.
- Do not add fallback direct state mutation APIs for this feature.
- Keep legacy path unchanged when `VALUE_IMPORT_BINDINGS=false`.
- Keep runtime generic; do not add import-only runtime write/read helpers.
- With all migration flags enabled, normal value-var handling inside template/script must keep working; only import-alias publication timing changes.

## Scope

This plan changes only template import alias binding:

- In scope: async template `import` / async template `from import` alias handling.
- Out of scope (first iteration): sync template imports, script mode imports, non-import symbols.

This plan does not change general var behavior, call resolution, or non-import symbol semantics.

## Implementation

### 1. Compiler: import/from-import alias binding

In `compileImport` and `compileFromImport`:

- If `asyncMode && VALUE_IMPORT_BINDINGS`:
  - declare alias output as `value` (`declareOutput` path),
  - enqueue a `ValueCommand` assignment for alias on `currentBuffer`,
  - return (do not run legacy `frame.set/context.setVariable` alias branch).
- Else:
  - keep existing legacy var branch.

Contract:

- There is exactly one write path when flag is on: `ValueCommand` enqueue.
- No direct `_setTarget` and no direct output setter helpers.

### 2. Compiler: symbol reads for imported aliases

Imported aliases must compile as value-output reads even in out-of-line compiled bodies (blocks/macros).

Required pieces:

- Carry value declaration metadata into out-of-line compile frames (`inheritedDeclaredOutputs`).
- In `compileSymbol`, if symbol resolves to declared/inherited `value` output and is not a var declaration, emit snapshot read path.

Contract:

- There is exactly one read path when flag is on: snapshot-based value read.
- No direct output current-value read helper.
- In debug/check mode, missing expected inherited metadata should fail loudly (compile-time assertion) instead of silently falling back to var lookup.

### 3. Runtime: output lookup visibility

Out-of-line runtime frames (macro/caller/block execution frames) must still find outputs declared in definition/root frame.

Use `_outputLookupFrame` linkage plus `parent` chain traversal in output lookup.

This is lookup-only support; no direct mutation/read shortcuts. Traversal must be cycle-safe.

### 4. Include behavior

Includes are separately compiled templates. If caller-side value aliases should be visible there, pass them as snapshot promises in include vars map (as today).

Keep this aligned with value output semantics. If this behavior is retained, keep it in one helper and document it as intentional coupling.

### 5. End-of-render resolution

No special import resolver is needed.

- Values resolve at normal output snapshot/finalSnapshot boundaries.
- Imported alias promises resolve as part of output resolution flow.

Guideline: create the final snapshot promise as early as possible (right after compiled root body scheduling), while preserving command-tree ordering and finalize rules.

### 6. Export publication model (new)

Use a deferred publication model for exported names:

1. Pre-create exported shape immediately.
2. Store a deferred promise per exported name in `ctx` from the start.
3. Resolve deferreds from final snapshot stage (or earlier for macro bindings).

This decouples "name availability" from "value readiness".

Contract:

- Exported object keys are available immediately.
- Deferred is resolved exactly once.
- No per-name direct mutation path after publish.

## What To Remove / Avoid

- Any direct helper like `readOutputValue` / `setOutputValue`.
- Any "if parent finished then skip link" workaround in compiler emit path.
- Any import-specific var fallback when `VALUE_IMPORT_BINDINGS=true`.
- Extra migration flags for this feature; `VALUE_IMPORT_BINDINGS` is sufficient.

## Rollout Steps

1. Make exported names/promise object available immediately.
2. Disable legacy import alias code paths when `VALUE_IMPORT_BINDINGS=true`.
3. Publish macro exports as early as possible (callable as soon as possible).
4. Return final snapshots.

Details:

1. Export names/promise object immediately
- Reuse legacy `context.addExport(...)` and `getExported()` mechanics.
- Ensure value path returns exported object early with stable keys and promise placeholders.
- For each exported name, keep `{ promise, resolve, reject }` (or equivalent deferred object).
- Put deferred promises into `ctx` immediately.
- `from import` should also publish per-name promises immediately.
- Keep `setVariable` as generic assignment API; do not use it as export finalizer.
- Use dedicated export API for finalization (`resolveExport` or equivalent).

2. Disable legacy alias code
- Under `VALUE_IMPORT_BINDINGS=true`, import alias codegen must emit no `frame.set/context.setVariable` for aliases.
- Alias write path must be value-output only (`ValueCommand` on `currentBuffer`).

3. Macro exports early
- Reuse existing macro export model: publish callable macro bindings as soon as export object is created.
- Do not force full macro resolution; only ensure availability timing matches/improves legacy behavior.
- Macro deferreds may resolve early when callable binding is ready.
- Top-level macros do not need to wait for final snapshots; they are typically ready before that stage.

4. Final snapshots
- Resolve through snapshot/finalSnapshot boundaries.
- Create final snapshot promise early, but do not bypass command insertion order, buffer hierarchy, or finalize/link rules.
- At final stage, resolve deferreds by passing snapshot promises directly (`resolve(snapshotPromise)`).
- Rely on promise assimilation for success/failure propagation.
- Use `reject(...)` only for setup/fatal paths where snapshot promises cannot be produced.

## Error and Poison Behavior

For deferred export publication:

- Prefer resolving deferreds with snapshot promises directly.
- If snapshot resolves to poison/rejection, consumer sees failure naturally.
- Do not add special poison branching in publication layer unless a fatal setup error prevents snapshot creation.

## Expected Failure Modes (and correct fixes)

- `Unable to call m[...]` / undefined import alias inside block/macro:
  - missing inherited declaration metadata at compile time.
- `Output 'x' is not declared` from macro/caller path:
  - missing runtime lookup-frame chain.
- finished-buffer/link timing errors:
  - wrong buffer ownership/lifecycle; fix insertion/linking, do not skip links conditionally.

## Test Matrix

Compile-shape tests (flag on):

- import alias codegen must not emit legacy alias `frame.set/context.setVariable`.
- imported alias symbol codegen must emit value snapshot read path.

Runtime tests (flag on):

- import alias used in root expression/call.
- from-import aliases used in root expression/call.
- alias used inside block.
- alias used inside macro.
- alias used across caller/macro.
- include/import/extends parity cases.
- async imported members/functions and poison/error propagation cases.
- exported shape available immediately even before values settle.
- deferred export promises settle after final snapshot stage.
- macro exports callable before final snapshot completion when ready.

When the flag is OFF:

- legacy import tests must keep existing behavior.

## Non-Goals

- Rewriting all var paths.
- Changing template/script global resolution semantics.
- Introducing import-specific async evaluation model outside outputs/snapshots.
