# `extends` Implementation Plan

This plan assumes a restart from commit
`016801d694a82068a3c8102231ae0636a68a6c42` and a fresh implementation of the
architecture described in:

- `docs/code/extends-architecture-raw.md`
- `docs/code/extends-architecture.md`

The raw architecture document remains the source of truth if the two
architecture documents ever appear to diverge.

## Strategy

- start from `016801d694a82068a3c8102231ae0636a68a6c42` on a fresh branch
- treat the current implementation mainly as a source of tests and regression
  cases, not as architecture to preserve
- re-implement the new model in small vertical slices
- prefer deleting/adapting less and reusing less, unless some current code fits
  the new architecture directly
- keep generic fixes that are valid independently of the new inheritance model

## Phase 0 - Baseline

Goal:

- create the restart branch from `016801d694a82068a3c8102231ae0636a68a6c42`
- collect the tests and generic fixes that should survive the restart

Deliverables:

- architecture docs in place
- initial test inventory:
  - parser/transpiler coverage
  - generic channel behavior
  - inheritance/extends integration tests
  - component integration tests

## Phase 1 - Frontend Syntax

Goal:

- add or verify the frontend syntax needed by the new architecture

Scope:

- script `method ... endmethod`
- script `shared` declarations
- explicit inherited dispatch syntax:
  - `this.method(...)`
  - `super()`
- explicit component syntax:
  - `component "X" as ns`
  - `component "X" as ns with theme, id`
  - `component "X" as ns with { ... }`
- `extends` source-order restriction:
  - only `shared` declarations are allowed before `extends`
  - arbitrary executable pre-`extends` code is rejected

Tests:

- parser/transpiler tests for all accepted and rejected forms
- especially:
  - `shared` only at root/constructor scope
  - only `shared` declarations allowed before `extends`
  - `this.method` without call rejected
  - bare `foo()` stays ordinary call
  - component shorthand/object `with` forms

## Phase 2 - Generic Channel Baseline

Goal:

- land the generic channel/runtime behavior that the new architecture depends
  on, independent of inheritance

Scope:

- plain `var`, `text`, `data`, `sink`, `sequence` declaration/runtime behavior
- non-shared `text x = ...` and `data x = ...` initialization support
- current-buffer observation and snapshot semantics

Tests:

- focused `explicit-outputs` coverage
- no inheritance yet

## Phase 3 - Metadata Compilation

Goal:

- compile methods/blocks and shared-channel metadata into the new shared-object
  shape

Scope:

- compile `methods` object up front
- include internal `__constructor__`
- compile shared schema metadata with:
  - channel type
  - local default value
- compile unresolved method/shared entries as pending promise structs where
  needed

Tests:

- compiled-output assertions
- method/shared metadata shape assertions

## Phase 4 - Root Startup and Registration

Goal:

- implement synchronous startup registration/resolve/reject

Scope:

- establish/reuse the shared metadata object
- shared-channel register / resolve / reject
- method register / resolve / reject
- `super` register / resolve / reject
- root rejection of any still-pending entries

Tests:

- startup ordering
- child-overrides-parent behavior
- shared default precedence
- conflicting shared channel types

## Phase 5 - Constructor Model

Goal:

- move top-level code fully into internal `__constructor__`

Scope:

- constructor as ordinary method target
- root-level empty constructor stays empty
- non-root empty constructor gets implicit `super()`
- `extends` creates the async boundary
- code after `extends` runs in a later command buffer
- no executable pre-`extends` constructor code path

Tests:

- constructor ordering
- pre-extends/post-extends ordering
- root vs non-root empty constructor behavior

## Phase 6 - Helper/Barrier Resolution

Goal:

- implement the helper-based late-resolution model

Scope:

- method helper
- shared-channel helper
- helper-awaited exact-link-after-load behavior
- helper memoization of merged metadata
- no helper-driven entry replacement

Tests:

- unresolved inherited call waits correctly
- unresolved shared-channel access waits correctly
- helper memoization coverage

## Phase 7 - Invocation and Linking

Goal:

- create call-time child invocation buffers only after target metadata is
  current

Scope:

- per-call child buffers
- exact linking at call time
- inherited `this.method(...)`
- `super()`
- shared-channel current-buffer commands
- sequential `!` paths inside inherited methods are intentionally deferred
  until the main model is stable

Tests:

- inherited dispatch
- `super()` dispatch
- exact linking after ancestry resolution

## Phase 8 - Components

Goal:

- implement explicit `component` instantiation on top of the same metadata
  model

Scope:

- `component ... as ns`
- `compositionPayload`
- direct-binding-only first implementation
- method calls through component binding
- shared-channel observations through component binding
- per-instance isolation

Tests:

- component method calls
- component shared observations
- multiple independent instances
- shorthand/object `with` payload behavior

## Phase 9 - Templates

Goal:

- apply the same runtime model to async templates

Scope:

- template body as `__constructor__`
- blocks as methods
- template pre/post-`extends` ordering

Tests:

- async template inheritance integration tests
- behavior parity with the new architecture

## Phase 10 - Compatibility and Cleanup

Goal:

- preserve non-extends behavior and clean up any remaining architecture drift

Scope:

- plain scripts/templates without `extends`
- plain `import`, `from import`, `include`
- `caller()` in macros
- sync template inheritance untouched for Nunjucks compatibility
- sequential `!` paths, including inherited-method support once that deferred
  work is taken up
- dynamic `extends` through the same composition model rather than a separate
  architecture

Tests:

- `npm run test:quick`
- full test suite

## Rules While Implementing

- prioritize integration tests over isolated unit tests for inheritance and
  components
- keep the raw architecture doc authoritative
- if architecture and implementation diverge, update docs before continuing
- do not silently reintroduce the old chain/ownerKey/admission-command model
- do not overload plain `import` with component semantics
