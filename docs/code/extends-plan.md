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
- preserve the current tests as much as possible during the restart
- use temporary `.skip()` only for tests that cover slices not implemented yet,
  and remove those skips as the corresponding phases land
- allow small spec-aligned test updates where syntax or surface behavior has
  intentionally changed, such as `import` vs `component`
- re-implement the new model in small vertical slices
- prefer deleting/adapting less and reusing less, unless some current code fits
  the new architecture directly
- keep generic fixes that are valid independently of the new inheritance model
- a "generic fix" qualifies only if it:
  - does not depend on the old inheritance architecture
  - improves parser/compiler/runtime behavior that remains valid on the restart
  - can be carried forward without dragging old inheritance machinery with it

## Phase 0 - Baseline

Goal:

- create the restart branch from `016801d694a82068a3c8102231ae0636a68a6c42`
- collect the tests and generic fixes that should survive the restart

Deliverables:

- architecture docs in place
- baseline inventory from `016801d694a82068a3c8102231ae0636a68a6c42`:
  - what `extends` syntax already exists in scripts/templates
  - what channel behavior already exists
  - what generic fixes should be cherry-picked before new inheritance work
- initial test inventory:
  - parser/transpiler coverage
  - generic channel behavior
  - inheritance/extends integration tests
  - component integration tests
- restart test policy:
  - existing tests are carried forward by default
  - small test edits are allowed when needed to match intentional spec changes
    such as `import` vs `component`
  - tests for not-yet-implemented slices may be marked `.skip()`
  - test deletion is avoided unless the old test is invalid under the new spec

## Phase 1 - Frontend Syntax

Goal:

- add or verify the frontend syntax needed by the new architecture

Scope:

- verify the baseline `extends` syntax already present at
  `016801d694a82068a3c8102231ae0636a68a6c42`
- script `method ... endmethod`
- script `shared` declarations
- explicit inherited dispatch syntax:
  - `this.method(...)`
  - `super()`
- explicit component syntax:
  - `component "X" as ns`
  - `component "X" as ns with theme, id`
  - `component "X" as ns with { ... }`
- `component` reserved as a keyword on this new path
- `extends` source-order restriction:
  - only `shared` declarations are allowed before `extends`
  - all other statements before `extends` are rejected
- enforce the pre-`extends` restriction in the AST/compiler path wherever that
  is simplest, with earlier frontend rejection used when it falls out naturally
- evaluate/handle `component` as a new keyword so the compatibility risk is
  explicit before it is reserved

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

Before adding anything, inventory what the baseline already provides so this
phase only lands the missing generic behavior.

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
- emit `usedChannels` / `mutatedChannels` as plain arrays of channel names
- compile shared schema metadata with:
  - channel type
  - local default value
- emit code that creates unresolved method/shared entries as pending promise
  structs at runtime startup where needed

Tests:

- compiled-output assertions
- method/shared metadata shape assertions
- this phase is structural only: inspect emitted metadata/code shape rather
  than trying to run inheritance scenarios before startup/dispatch exist

## Phase 4 - Root Startup and Registration

Goal:

- implement synchronous startup registration/resolve/reject

Scope:

- establish/reuse the shared metadata object:
  - the most-derived entry creates it once per render/instance
  - parents receive that same object and enrich it
- shared-channel register / resolve / reject
- method register / resolve / reject
- `super` wiring during method register / resolve / reject when the current
  level defines the same method name needed by a child `super()`
- root rejection of any still-pending entries

Tests:

- startup ordering
- child-overrides-parent behavior
- shared default precedence
- conflicting shared channel types
- tests in this phase are structural/startup tests, not full end-to-end
  invocation behavior

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
- direct-render constructor return behavior:
  - only the most-derived entry file's explicit `return` counts
  - ancestor constructor returns are ignored

Tests:

- constructor ordering
- emitted/source-order constructor structure
- root vs non-root empty constructor behavior
- full parent-constructor ordering tests land after invocation/linking exists

## Phase 6 - Helper/Barrier Resolution

Goal:

- implement the helper-based late-resolution model

Scope:

- method helper
- shared-channel helper
- helper-awaited exact-link-after-load behavior
- helper memoization of merged metadata
- no helper-driven entry replacement
- side-channel command split:
  - method-call commands await helper-resolved used/mutated channel metadata
  - shared-channel-lookup commands await helper-resolved shared-channel
    metadata

Tests:

- direct helper/resolution tests only
- helper memoization coverage
- end-to-end call/observation wait behavior lands in Phase 7 when invocation
  exists

## Phase 7 - Invocation and Linking

Goal:

- create call-time child invocation buffers only after target metadata is
  current

Scope:

- per-call child buffers
- those call buffers live inside the shared command-buffer tree
- exact linking at call time
- inherited `this.method(...)`
- `super()`
- shared-channel current-buffer commands
- method return-value flow back to the caller expression
- invocation context/execution model consistent with the architecture:
  methods run in child buffers on top of the shared command-buffer/execution
  context, rather than creating a second inheritance-specific context model
- sequential `!` paths inside inherited methods are intentionally deferred
  until the main model is stable

Tests:

- inherited dispatch
- `super()` dispatch
- exact linking after ancestry resolution
- method return values flowing into caller expressions
- end-to-end unresolved call/channel wait behavior

## Phase 8 - Components

Goal:

- implement explicit `component` instantiation on top of the same metadata
  model

Scope:

- `component ... as ns`
- `compositionPayload`
- unchanged `compositionPayload` propagation for plain `extends` chains using
  the same shared metadata object
- direct-binding-only first implementation
- method calls through component binding
- shared-channel observations through component binding
- per-instance isolation
- component lifecycle:
  - the component shared root stays open while the owning caller buffer is
    alive
  - it closes when no new component operations can arrive from that owner
- `ns.x` for `shared var` as a current-buffer observation operation, not a
  stored JS property

Tests:

- component method calls
- component shared observations
- multiple independent instances
- shorthand/object `with` payload behavior
- component lifecycle and closure timing

## Phase 9 - Templates

Goal:

- apply the same runtime model to async templates

Scope:

- template body as `__constructor__`
- blocks as methods
- template pre/post-`extends` ordering
- no template-local captures for arbitrary pre-`extends` variables, because the
  architecture only allows `shared` declarations before `extends`
- block `withContext` behavior following the enclosing template/script model
- block argument passing on the new explicit `()` call model

Tests:

- basic async template extends
- `super()` in template blocks
- multi-level template hierarchies
- block override/source-order behavior
- block argument passing
- `withContext` coverage

## Phase 10 - Compatibility and Cleanup

Goal:

- preserve non-extends behavior and clean up any remaining architecture drift

Scope:

- plain scripts/templates without `extends`
- plain `import`, `from import`, `include` remain on the ordinary composition
  path unless optional code-sharing is useful
- `caller()` in macros
- sync template inheritance untouched for Nunjucks compatibility
- sequential `!` paths, including inherited-method support once that deferred
  work is taken up
- dynamic `extends` uses normal compiler expression compilation when the parent
  is an expression and literal compilation when static
- dynamic `extends` waits for parent-name resolution and loading, but detailed
  dynamic work remains deferred until the main static model is stable

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
- preserve existing tests wherever possible; prefer temporary `.skip()` over
  deleting regression coverage during the rebuild
- when the new spec intentionally changes syntax or surface API, update the
  affected tests minimally instead of forcing legacy behavior
