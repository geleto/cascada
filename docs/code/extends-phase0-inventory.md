# Phase 0 Inventory

This note records the restart-branch baseline for `extends-next`, starting from
commit `016801d694a82068a3c8102231ae0636a68a6c42` and then applying the Phase 0
carry-overs that are intentionally architecture-independent.

## Branch Setup

- restart branch: `extends-next`
- restart base commit: `016801d694a82068a3c8102231ae0636a68a6c42`
- current extends docs kept on this branch:
  - `docs/code/extends-architecture-raw.md`
  - `docs/code/extends-architecture.md`
  - `docs/code/extends-plan.md`
- superseded extends docs removed from this branch:
  - `docs/code/extends-implementation.md`
  - `docs/code/extends-next.md`

## Restart Baseline Inventory

### Existing `extends` / inheritance surface on the restart baseline

- async templates already support ordinary static `extends`
- async templates also already contain dynamic/conditional `extends` behavior
- async templates already have `super()` block dispatch
- script `extends "base.script" with theme` already exists
- script `method ... endmethod` syntax already exists in the transpiler/tests
- the restart baseline does not contain the new `shared` frontend syntax
- the restart baseline does not contain the explicit `component ... as ns`
  keyword path

### Generic channel/runtime behavior already present on the restart baseline

- explicit `var`, `text`, `data`, `sink`, and `sequence` channels exist
- deferred exports are already promise-first:
  - `Context.addDeferredExport(...)` creates a promise up front
  - `Context.resolveExports()` resolves from the producer channel
    `finalSnapshot()`
- explicit producer records for deferred exports are already present through
  `exportChannels`

## Phase 0 Carry-Overs Landed Here

### Non-shared `text` / `data` initializers

Landed on this branch:

- parser now accepts non-shared `data x = ...` and `text x = ...`
- compiler lowers those initializers into normal channel commands
- regression coverage added for sync and async initializer cases

Files:

- `src/parser.js`
- `src/compiler/validation.js`
- `src/compiler/compiler-async.js`
- `tests/explicit-outputs.js`

### Fatal runtime errors remain fatal

Landed on this branch:

- command-argument resolution now rethrows `RuntimeFatalError` instead of
  converting it into poison
- channel inspection keeps fatal failures as fatal inspection results instead of
  rewrapping them as `PoisonError`
- focused runtime tests added

Files:

- `src/runtime/commands.js`
- `src/runtime/channel.js`
- `tests/pasync/channel-errors.js`

### Export workflow

No extra carry-over was needed here because the restart baseline already uses
the Phase 0 target model:

- exports are initialized up front as promises
- exports resolve from producer `finalSnapshot()`

Relevant baseline files:

- `src/environment/context.js`
- `src/environment/template.js`
- `tests/pasync/template-command-buffer.js`
- `tests/pasync/composition.js`

## Test Inventory Snapshot

Existing baseline coverage already present on this branch:

- parser / transpiler: `tests/parser.js`, `tests/script-transpiler.js`
- explicit channels / outputs: `tests/explicit-outputs.js`
- async composition / inheritance: `tests/pasync/composition.js`,
  `tests/pasync/loader.js`, `tests/pasync/script.js`,
  `tests/pasync/template-command-buffer.js`
- runtime / poison: `tests/pasync/channel-errors.js`,
  `tests/pasync/error-reporting.js`, `tests/poison/*`

Phase-grouped deferred suites now present on `extends-next`:

- `tests/pasync/extends-foundation.js`
  - contains skipped groups for Phases 1, 3, 4, 6, and 10
- `tests/pasync/extends.js`
  - contains the runtime-side skipped groups for Phases 5 and 7
  - includes the nested skipped group `Phase 7 - Late Inherited Linking`
- `tests/pasync/extends-template.js`
  - contains the template-specific skipped groups for Phase 9
- `tests/pasync/component.js`
  - contains the Phase 8 deferred groups for observations, method calls, and
    lifecycle
  - updated to the planned `component "X" as ns` syntax
  - includes the nested skipped groups
    `Phase 8 - Late Component Invocation Linking` and
    `Phase 8 - Late Component Shared Linking`
- sync extends compatibility regression now lives in `tests/compiler.js`
  - this should keep running through the rebuild alongside the existing sync
    extends coverage

Per-phase enablement belongs in `docs/code/extends-plan.md`; this inventory only
records which grouped suites exist on the restart branch.

## Focused Verification Run

- `npx.cmd mocha tests/explicit-outputs.js --timeout 10000`
- `npx.cmd mocha tests/pasync/channel-errors.js --timeout 10000`
- `npx.cmd mocha tests/pasync/extends-foundation.js --timeout 10000`
- `npx.cmd mocha tests/pasync/extends.js --timeout 10000`
- `npx.cmd mocha tests/pasync/extends-template.js --timeout 10000`
- `npx.cmd mocha tests/pasync/component.js --timeout 10000`
- `npx.cmd mocha tests/compiler.js --grep "should keep sync extends block scope isolated from top-level child assignments" --timeout 10000`
