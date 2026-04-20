# `extends` Implementation Plan

This plan assumes a restart from commit
`016801d694a82068a3c8102231ae0636a68a6c42` and a fresh implementation of the
architecture described in:

- `docs/code/extends-architecture.md`

## Strategy

- start from `016801d694a82068a3c8102231ae0636a68a6c42` on a fresh branch called extends-next
- treat the current implementation mainly as a source of tests and regression
  cases, not as architecture to preserve
- prefer integration tests throughout; use isolated/unit-style tests mainly
  when a slice cannot yet be exercised cleanly end-to-end
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
- reapply the agreed generic fixes before new inheritance/component work starts

Deliverables:

- architecture docs in place
- carry over the three current extends docs onto the restart branch:
  - `docs/code/extends-architecture-raw.md`
  - `docs/code/extends-architecture.md`
  - `docs/code/extends-plan.md`
- delete old superseded extends planning/implementation docs from the restart
  branch so the new branch keeps only the current documentation set
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
- Phase 0 implementation work:
  - land non-shared `text x = ...` and `data x = ...` assignment / initializer
    support
  - land fatal runtime errors staying fatal instead of degrading into poison
  - land the improved export workflow:
    - exports are initialized up front as promises
    - they are resolved at end-of-code with `finalSnapshot()` of their producer
      channels
  - copy the current new regression tests onto the restart branch
  - rewrite copied tests minimally where the new spec intentionally changes the
    surface syntax or API, such as `import` vs `component`
  - rearrange copied tests into groups that match the implementation phases so
    `describe.skip(...)` can be removed exactly when the corresponding slice is
    implemented
  - prefer group-level `.skip()` over scattered per-test `.skip()` markers,
    unless a mixed group genuinely cannot be split more cleanly
  - update the later phases with explicit notes about which test groups should
    be unskipped when that phase lands
  - once those grouped phase-aligned test suites exist, remove the older
    per-phase ad hoc test lists from the later phase `Tests` sections and
    replace them with references to the grouped suites to unskip/run

## Generic Fixes To Keep Or Reapply

- keep non-shared `text x = ...` and `data x = ...` assignment / initializer
  support
- keep fatal runtime errors staying fatal instead of degrading into poison
- reapply export handling as the improved version, not the current
  implementation:
  - exports are initialized up front as promises
  - they are resolved at end-of-code with `finalSnapshot()` of their producer
    channels

## Wrong Fixes To Avoid Repeating

- do not add extern fallback cycle detection as a special fix here; normal
  existing-declared-var validation should already be enough for that class of
  error, so we should not reintroduce a separate extern-cycle mechanism by
  mistake
- do not carry forward the current "wait for whole render completion before
  reading exports" workaround; the restart should use the improved promise-first
  export workflow above instead
- do not preserve macro-export metadata such as used-channel metadata or
  caller-channel scheduling metadata as part of exported/imported macro
  semantics

Guardrail:

- do not land regression-driven fixes silently when they require architectural
  or semantic changes
- if a fix changes architecture or exported semantics in order to avoid a
  regression, pause and get explicit user sign-off first
- this includes changes such as macro-export metadata, export workflow changes,
  or similar "make the regression pass by changing the model" fixes

## Phase 1 - Frontend Syntax

Goal:

- add or verify the frontend syntax needed by the new architecture
- audit the legacy `extends` implementation that still exists on the restart
  baseline and decide what must be removed, and when

Scope:

- verify the baseline `extends` syntax already present at
  `016801d694a82068a3c8102231ae0636a68a6c42`
- produce a legacy-extends removal map:
  - identify the existing `extends` / inheritance implementation pieces on the
    restart baseline
  - decide which pieces must be removed immediately
  - decide which pieces may survive temporarily until a later phase replaces
    them
  - record, for each later phase, what old pieces must be removed first before
    implementing that phase's new slice
  - schedule those removals explicitly, so later phases say what gets deleted
    at the start of that phase rather than leaving old pieces to linger
- script `method ... endmethod`
- script `shared` declarations
- explicit inherited dispatch syntax:
  - `this.method(...)`
  - `super()`
- explicit component syntax:
  - `component "X" as ns`
  - `component "X" as ns with context`
  - `component "X" as ns with theme, id`
  - `component "X" as ns with context, theme, id`
  - `component "X" as ns with { ... }`
  - `component "X" as ns with context, { ... }`
- `component` reserved as a keyword on this new path
- `extends` source-order restriction:
  - only `shared` declarations are allowed before `extends`
  - all other statements before `extends` are rejected
- enforce the pre-`extends` restriction in the AST/compiler path wherever that
  is simplest, with earlier frontend rejection used when it falls out naturally
- audit the current use of `component` as an identifier in tests/templates so
  the breaking-change surface is explicit before the keyword is reserved

Legacy removal map:

- keep the legacy async template inheritance/runtime path in place during this
  phase; frontend syntax lands first
- remove nothing immediately in Phase 1 beyond reserving the new frontend
  syntax surface
- audit result for the `component` keyword on this branch:
  - no existing script/template declaration currently uses `component` as an
    identifier
- later removals should start from these legacy areas:
  - `src/compiler/inheritance.js`
  - async-root inheritance handling in `src/compiler/compiler-async.js`
  - legacy inheritance/super helpers on `Context` / template runtime paths
  - legacy inheritance runtime modules under `src/runtime/inheritance-*`

Tests:

- parser/transpiler tests for all accepted and rejected forms
- especially:
  - `shared` only at root/constructor scope
  - only `shared` declarations allowed before `extends`
  - `this.method` without call rejected
  - bare `foo()` stays ordinary call
  - component shorthand/object `with` forms
- re-enable groups:
  - `tests/pasync/extends-foundation.js` -> `Phase 1 - Frontend Syntax`

Remove first notes for later phases:

- Phase 3:
  - keep `src/compiler/inheritance.js` only for the old call path while the
    new metadata shape is introduced
  - do not add new owner-key / chain metadata to the legacy method objects
- Phase 4:
  - remove any temporary dependence on legacy inheritance startup ordering
    before wiring the new shared method/shared registration path
- Phase 5:
  - remove the old root `__parentTemplate` / final-parent handoff path and the
    template-local-capture assumptions in `src/compiler/compiler-async.js`
    before moving top-level code into `__constructor__`
- Phase 6:
  - remove legacy "read raw method metadata directly" paths before helper-based
    resolution is introduced
- Phase 7:
  - remove legacy inherited dispatch / `Context.getAsyncSuper(...)`-style call
    routing before landing the new invocation/linking model
- Phase 8:
  - remove any remaining import-style component shortcuts before explicit
    `component ... as ns` runtime wiring lands
- Phase 9:
  - remove the old async template inheritance pre/post-extends flow before
    switching templates onto the constructor/method model

## Phase 2 - Generic Channel Baseline

Goal:

- land the generic channel/runtime behavior that the new architecture depends
  on, independent of inheritance

Before adding anything, inventory what the baseline already provides so this
phase only lands the missing generic behavior.

This phase is mainly a baseline-verification and cleanup phase after Phase 0.
It should not duplicate the Phase 0 generic fixes; it should only add generic
channel behavior that is still missing after the restart baseline plus the
Phase 0 reapplications.

Scope:

- verify plain `var`, `text`, `data`, `sink`, and `sequence`
  declaration/runtime behavior on the restart baseline
- land only the remaining generic channel/runtime pieces that are still missing
  after Phase 0
- current-buffer observation and snapshot semantics

Tests:

- focused explicit-channel coverage
- no inheritance yet
- run active baseline suites:
  - `tests/pasync/channels-explicit.js`
  - `tests/pasync/channel-errors.js`
- no deferred extends/component groups are re-enabled in this phase

## Phase 3 - Metadata Compilation

Goal:

- compile methods/blocks and shared-channel metadata into the new shared-object
  shape

Scope:

- compile `methods` object up front
- treat the current root/block scan in `_collectCompiledMethods(...)` as a
  temporary bridge only
  - do not keep reconstructing the method model late from `Root` plus `Block`
    nodes as the long-term design
  - keep `_collectMethodChannelNames(...)` only as the same bridge-era
    metadata extraction helper, not as the permanent architectural boundary
  - replace that bridge with the dedicated transformed AST node for methods and
    constructor described in `docs/code/extends-architecture.md`
  - compile the runtime `methods` key-value object from that transformed node
    once it exists
- include internal `__constructor__`
  - in this phase, establish the presence and compiled-object shape of the
    constructor entry
  - Phase 5 fills in the final constructor body semantics such as implicit
    `super()`, post-`extends` code movement, and async-boundary behavior
- emit `usedChannels` / `mutatedChannels` as plain arrays of channel names
- compile shared schema metadata with:
  - channel type
  - local default value
  - treat any raw root-child scan for shared declarations as a temporary bridge
    only
    - do not keep re-scanning raw root children as the long-term source of
      shared-schema metadata
    - move shared-schema compilation onto analyzed/transformed metadata along
      with the later dedicated methods/constructor node work
- handle `shared sequence` explicitly:
  - `shared sequence db = sinkExpr` carries an initializer expression
  - `shared sequence db` declares participation with no initializer
- emit code that creates unresolved method/shared entries as pending promise
  structs at runtime startup where needed
- remove first:
  - do not extend the legacy compiled method/block contract with more owner-key
    or chain-specific state
  - keep `src/compiler/inheritance.js` only as a temporary caller while this
    phase emits the new metadata shape
  - do not let `_collectCompiledMethods(...)` become permanent follow-on
    architecture after this metadata shape lands
  - do not let raw root-child scans remain the permanent shared-schema source
    once analyzed/transformed metadata exists

Tests:

- compiled-output assertions
- method/shared metadata shape assertions
- this phase is structural only: inspect emitted metadata/code shape rather
  than trying to run inheritance scenarios before startup/dispatch exist
- re-enable groups:
  - `tests/pasync/extends-foundation.js` ->
    `Phase 3 - Shared Channel Metadata and Lowering`
  - `tests/pasync/extends-foundation.js` ->
    `Phase 3 - Method Metadata Compilation`

## Phase 4 - Root Startup and Registration

Goal:

- implement synchronous startup registration/resolve/reject

Scope:

- establish/reuse the shared metadata object:
  - the most-derived entry creates it once per render/instance
  - parents receive that same object and enrich it
- finish the Phase 3 metadata-source cleanup in the async compiler:
  - move method/block and shared-channel metadata lookup onto a transformed
    inheritance-metadata AST node attached at `Root`
  - stop re-scanning raw `Root` / `Block` structure for startup metadata in
    `compiler-async.js`
  - keep render-time block execution on the existing block nodes for now; this
    step is only about where startup metadata comes from
- create and assign `sharedRootBuffer` once at the owning most-derived
  direct-render entry or component owner, then thread that same buffer through
  the shared metadata object
- shared-channel register / resolve / reject
- method register / resolve / reject
- `super` wiring during method register / resolve / reject when the current
  level defines the same method name needed by a child `super()`
- root rejection of any still-pending entries
- remove first:
  - stop depending on legacy inheritance startup ordering/state before landing
    the synchronous register/resolve/reject path
  - replace `Context._copySharedStructuralState(...)` with the reusable shared
    composition/inheritance runtime state object rather than keeping a manual
    copied field list on every fork

Tests:

- prefer integration tests where startup behavior can be observed cleanly
- use structural/startup-focused tests only for what cannot yet be exercised
  end-to-end before invocation exists
- observe startup either by:
  - running startup registration synchronously and inspecting the shared
    metadata object before helper resolution and invocation exist, or
  - inspecting emitted startup code / metadata shape where no better runtime
    hook exists
- re-enable groups:
  - `tests/pasync/extends-foundation.js` ->
    `Phase 4 - Shared Channel Runtime Startup`
  - `tests/pasync/extends-foundation.js` ->
    `Phase 4 - Method and Shared Startup Registration`

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
- this phase establishes the constructor-side async-boundary shape at compile
  time; the runtime helper/barrier/linking behavior that makes the stall work
  is implemented in Phases 6 and 7
- direct-render constructor return behavior:
  - only the most-derived entry file's explicit `return` counts
  - ancestor constructor returns are ignored
- plain `extends`-chain `compositionPayload` handling belongs here:
  - include `compositionPayload` in the shared metadata object for plain
    extends chains
  - keep upward propagation unchanged across multiple levels
- once the constructor split lands:
  - script `__constructor__` should point at its own compiled function rather
    than aliasing `root`
  - any remaining template use of `root` as the constructor entry stays
    temporary until Phase 9 moves templates onto the same constructor/method
    model
- remove first:
  - replace the temporary script-transform source-order bridge
    `_preExtendsMovedMethodNode` with direct source-order validation before
    method/shared extraction, so pre-`extends` validation no longer depends on
    ad hoc transformer side state
  - delete the old root `__parentTemplate` / final-parent continuation path
    and the template-local-capture assumptions in `src/compiler/compiler-async.js`
    before constructor lowering becomes authoritative
  - remove the current plain-extends payload capture bridge once
    `compositionPayload` is wired directly:
    - `captureCompositionValueImpl(...)` in `src/runtime/lookup.js`
    - `CommandBuffer._recordTemporaryCompositionAssignedValue(...)`
    - `recordTemporaryCompositionAssignedValue(...)` /
      `getTemporaryCompositionAssignedValue(...)` on channels
  - if any narrow composition-capture helper still survives after this phase,
    it must be just an ordered channel lookup plus ordinary context fallback,
    not a channel-side "latest assigned value" escape hatch

Tests:

- constructor ordering
- emitted/source-order constructor structure
- root vs non-root empty constructor behavior
- full parent-constructor ordering tests land after invocation/linking exists
- re-enable groups:
  - `tests/pasync/extends.js` -> `Phase 5 - Constructor Model`
  - `tests/pasync/extends.js` -> `Phase 5 - Extends Return Rules`

## Phase 6 - Helper/Barrier Resolution

Goal:

- implement the helper-based late-resolution model

Scope:

- method helper
- shared-channel helper
- helper memoization of merged metadata
- no helper-driven entry replacement
- reuse of the existing inheritance-state object across parent startup and
  later helper resolution
- expose helper/runtime surface needed by later caller-side invocation work
- remove first:
  - remove legacy direct metadata reads on the helper path so helper-based
    resolution is the only Phase 6 way to obtain effective inherited/shared
    metadata
- explicitly defer caller-side barrier/linking behavior to Phase 7:
  - helper-awaited exact-link-after-load behavior
  - `apply()` awaiting the helper before it creates child invocation buffers or
    performs linking
  - side-channel command split between method-call and shared-channel lookup
    commands
  - removal of compiler-side inherited visibility/linking bridges

Tests:

- direct helper/resolution tests only
- helper memoization coverage
- end-to-end call/observation wait behavior lands in Phase 7 when invocation
  exists
- re-enable groups:
  - `tests/pasync/extends-foundation.js` ->
    `Phase 6 - Helper and Resolution Lifecycle`

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
- define the invocation context/execution model consistent with the
  architecture:
  - methods run in child buffers on top of the shared command-buffer/execution
    context, rather than creating a second inheritance-specific context model
  - method bodies see shared channels, method arguments, and
    `compositionPayload`
- method bodies do not inherit the caller's local variables
- sequential `!` paths inside inherited methods are intentionally deferred
  until the main model is stable and are taken up in Phase 10
- remove first:
  - move the remaining caller-side barrier behavior from Phase 6 into the real
    invocation path:
    - `apply()` must await the method/shared helper before it creates the child
      invocation buffer or performs linking
    - helper-awaited exact-link-after-load behavior becomes the only inherited
      method/shared access barrier
    - no separate temporary barrier buffer should remain once the real
      caller-side admission path lands
  - remove legacy inherited dispatch / super-routing helpers before the new
    invocation-buffer linking model lands
  - explicitly remove the current context-based super bridge helpers rather
    than letting them linger behind the new method model:
    - `Context.getAsyncSuper(...)`
    - `Context.getSyncSuper(...)`
  - remove any temporary helper-owned admission/barrier scaffolding once the
    caller-side invocation path owns ordering:
    - `invokeInheritedMethod(...)`
    - `invokeSuperMethod(...)`
    - `_createAdmissionBarrier(...)`
    - `_finishAdmissionBarrier(...)`
    - do not carry forward the temporary helper barrier's current narrow link
      set (`__return__` plus shared channels only); the real invocation path
      must link the full caller-observable channel set needed by inherited
      method execution, including non-shared channels when required
    - do not route `__constructor__` through the temporary method helper call
      signature as-is; Phase 7 must either unify callable entry signatures or
      keep constructor invocation on a dedicated path so the constructor's
      `inheritanceState` slot is not misaligned with method payload arguments
    - unify payload-shape ownership when the real invocation path lands so the
      method-call payload contract does not drift separately from the remaining
      context/template inheritance payload helpers
    - avoid deepening that temporary helper-owned barrier path while Phase 7 is
      in progress:
    - do not add new behavior there that belongs to the final caller-side
      admission/linking model
    - keep new inherited dispatch ordering work on the real invocation path so
      the temporary helper scaffolding does not become a second architecture
  - remove the temporary script-method visibility/linking bridge in
    `src/compiler/inheritance.js` before the phase is considered complete:
    - `_getMethodVisibleRootBindingNames(...)`
    - the `runtime.allowInheritanceBoundaryRead(currentBuffer.parent, ...)`
      emission inside `compileAsyncBlockEntry(...)`
    - reliance on method-entry-local `blockLinkedChannels` as the final
      inherited dispatch linkage set
  - if the Phase 6 helper still back-fills `entry.linkedChannels`, treat that
    as temporary bridge data only:
    - caller-side invocation/linking should use the resolved helper metadata as
      the authoritative source for exact linkage
    - remove or stop depending on helper-populated raw-entry linkage state once
      the real invocation path is in place
  - after this phase, method/shared access ordering should come from the
    caller-side admission/helper path only, not from compiler-side visibility
    exceptions

Tests:

- inherited dispatch
- `super()` dispatch
- exact linking after ancestry resolution
- method return values flowing into caller expressions
- end-to-end unresolved call/channel wait behavior
- re-enable groups:
  - `tests/pasync/extends.js` ->
    `Phase 7 - Shared Root and Invocation Scope`
  - `tests/pasync/extends.js` -> `Phase 7 - Inherited Dispatch`
    - includes `Phase 7 - Late Inherited Linking`

## Phase 8 - Components

Goal:

- implement explicit `component` instantiation on top of the same metadata
  model

Scope:

- `component ... as ns`
- `compositionPayload`
- decide the ownership of `src/runtime/inheritance-inputs.js` on the component
  path:
  - if component startup needs shared-input preload/validation helpers, move
    that module under explicit component ownership here
  - otherwise treat it as leftover Phase 4/5 scaffolding and schedule its
    removal in Phase 10 instead of letting it linger as an orphaned runtime API
- component-specific `compositionPayload` forms:
  - `component ... with context`
  - `component ... with theme, id`
  - `component ... with context, theme, id`
  - `component ... with { ... }`
  - `component ... with context, { ... }`
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
- remove first:
  - remove any temporary import-style or legacy component-binding shortcuts
    before explicit component runtime wiring lands

Tests:

- component method calls
- component shared observations
- multiple independent instances
- shorthand/object `with` payload behavior
- component lifecycle and closure timing
- re-enable groups:
  - `tests/pasync/component.js` -> `Phase 8 - Component Observations`
  - `tests/pasync/component.js` -> `Phase 8 - Component Method Calls`
    - includes `Phase 8 - Late Component Invocation Linking`
    - includes `Phase 8 - Late Component Shared Linking`
  - `tests/pasync/component.js` -> `Phase 8 - Component Lifecycle`

## Phase 9 - Templates

Goal:

- apply the same runtime model to async templates

Scope:

- template body as `__constructor__`
- blocks as methods
- template pre/post-`extends` ordering
- no template-local captures for arbitrary pre-`extends` variables, because the
  architecture only allows `shared` declarations before `extends`
- block `withContext` follows the enclosing template/script mode; it is not a
  separate block-level runtime flag to infer later
- block argument passing on the new explicit `()` call model
- once templates are on the same metadata path, remove the remaining
  script-vs-template callable-shape branching in async compilation:
  - stop switching between `MethodDefinition` and `Block` for metadata
    collection
  - move both onto one callable-entry path for metadata and startup assembly
- finish the constructor-target unification started in Phase 5:
  - remove the remaining template-side `__constructor__ -> root` aliasing
  - compile template `__constructor__` as its own callable entry as well
- move shared render-structure ownership off `Context` and onto an explicit
  per-render execution-state argument passed to async entry functions:
  - `Context` should keep lexical/render/extern variable scope concerns
  - block registries, deferred export state, inheritance payload bookkeeping,
    and related shared structural state should live on the execution-state
    object instead of `Context._sharedStructuralState`
  - update async root/block entry signatures to accept and thread that
    execution-state object directly rather than hiding it inside context forks
- remove first:
  - remove the old async template inheritance pre/post-extends flow before
    templates switch to the constructor/method model
  - remove the template-only compiler capture bridge in
    `src/compiler/inheritance.js` once templates switch to the shared
    constructor/method model:
    - `getBlockLocalCaptureNames(...)`
    - template/block use of `createInheritancePayload(...)`
    - template/block use of `prepareInheritancePayloadForBlock(...)`
  - remove the old block-registry / block-contract runtime path once template
    blocks compile as methods on the shared metadata object:
    - `blockContracts` emission and `Template.blockContracts`
    - `CompilerAsync._collectBlockContracts(...)`
    - `Template._getBlocks(...)` attaching `blockContract`
    - `Context.addBlock(...)`
    - `Context.getBlock(...)`
    - `Context.getAsyncBlock(...)`
    - the `templateVar.blocks[...]` / `context.addBlock(...)` inheritance
      merge path in `src/compiler/inheritance.js`
  - remove the old template inheritance payload/capture state on `Context`
    once templates use the shared metadata object directly:
    - `_sharedStructuralState`
    - `extendsCompositionByParent`
    - `inheritanceLocalCapturesByTemplate`
    - `setExtendsComposition(...)` / `getExtendsComposition(...)`
    - `setTemplateLocalCaptures(...)` / `getTemplateLocalCaptures(...)`
    - `createInheritancePayload(...)`
    - `createSuperInheritancePayload(...)`
    - `prepareInheritancePayloadForBlock(...)`
    - `beginAsyncExtendsBlockRegistration(...)` /
      `finishAsyncExtendsBlockRegistration(...)`
    - `asyncExtendsBlocksPromise` / resolver / pending-count state
  - when this state moves off `Context`, remove the remaining prototype
    accessor indirection and lazy accessor guards that only exist to proxy
    `_sharedStructuralState`
  - remove `isBlockedInheritanceBoundaryChannelRead(...)` in `src/runtime/lookup.js`
    once cross-template bare-name reads are no longer part of the template
    inheritance path

Tests:

- basic async template extends
- `super()` in template blocks
- multi-level template hierarchies
- block override/source-order behavior
- block argument passing
- `withContext` coverage
- re-enable groups:
  - `tests/pasync/extends-template.js` -> `Phase 9 - Template Extends Pre/Post`
  - `tests/pasync/extends-template.js` -> `Phase 9 - Template Inheritance Compiled Shape`

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
- dynamic `extends` waits for parent-name resolution and loading
- detailed dynamic `extends` work remains deferred until the main static model
  is stable; if the static model is not yet stable by this phase, dynamic
  `extends` may remain deferred past Phase 10 rather than being forced in here
- clean up remaining architecture drift after the main model is stable:
  - move pending inherited-method/shared dependency discovery off ad hoc AST
    rescans and onto analysis-owned metadata
    - remove the temporary compiler rescans in `src/compiler/inheritance.js`:
      - `collectPendingMethodNames(...)`
      - `collectPendingSharedNames(...)`
  - flatten the temporary inheritance registry classes when they no longer add
    value over plain shared metadata objects and helpers:
    - `InheritanceMethodRegistry`
    - `InheritanceSharedRegistry`
  - remove leftover bootstrap/API defensive code once the final ownership
    boundaries are settled:
    - drop the unreachable `bootstrapInheritanceMetadata(...)` fallback that
      creates a new inheritance state when the caller already owns creation
    - remove `src/runtime/inheritance-inputs.js` if Phase 8 does not adopt it
  - clean up remaining low-risk parser/compiler consistency nits that are not
    worth carrying as architecture work:
    - parser recovery around `parseCompositionWithClause(...)` consuming a
      symbol before rejecting object-style trailing named inputs
    - extract helper-based save/restore for compiler buffer context if the
      current manual restoration pattern still exists

Tests:

- `npm run test:quick`
- full test suite
- re-enable groups:
  - `tests/pasync/extends-foundation.js` ->
    `Phase 10 - Dynamic Extends Startup Plumbing`
  - `tests/pasync/extends-foundation.js` ->
    `Phase 10 - Dynamic Extends Resolution Lifecycle`
  - `tests/pasync/extends-foundation.js` ->
    `Phase 10 - Composition Payload Shape`
  - keep the sync extends regression in `tests/compiler.js` active throughout

## Phase 11 - Documentation

Goal:

- update the user-facing and implementation documentation to match the final
  extends/component/import architecture

Scope:

- update `docs/code/extends-architecture.md` where implementation details or
  final terminology drifted during delivery
- update `docs/cascada/script.md` and any agent-facing script docs that
  describe:
  - `shared` declarations
  - `method ... endmethod`
  - inherited dispatch via `this.method(...)`
  - `super()`
  - `component ... as ns`
  - component `with` payload forms
- update the new import functionality in the docs too:
  - `import "X" as ns with context`
  - `import "X" as ns with theme, id`
  - `import "X" as ns with { ... }`
  - mixed `import "X" as ns with context, { ... }`
- update any composition/inheritance docs that compare or distinguish:
  - `import`
  - `from import`
  - `include`
  - `component`
  - `extends`
- remove or rewrite outdated examples that still show superseded pre-`extends`
  script patterns or older import/component terminology

Tests / Verification:

- no new runtime behavior is introduced in this phase
- verify examples and terminology against the implemented parser/compiler
  surface before considering the phase complete

## Rules While Implementing

- prioritize integration tests over isolated unit tests for inheritance and
  components
- keep the final architecture doc authoritative
- if architecture and implementation diverge, update docs before continuing
- do not silently reintroduce the old chain/ownerKey/admission-command model
- do not overload plain `import` with component semantics
- preserve existing tests wherever possible; prefer temporary `.skip()` over
  deleting regression coverage during the rebuild
- when the new spec intentionally changes syntax or surface API, update the
  affected tests minimally instead of forcing legacy behavior
- do not silently introduce architectural fixes just to satisfy regressions;
  when a regression fix would change the model, get explicit user approval
  before implementing it
- at the start of each phase, analyze what test coverage is still missing for
  that slice and add the needed tests before considering the phase complete
- for each phase, use the grouped phase-aligned test suites as the baseline,
  then add any new tests that are needed for uncovered behavior discovered
  during implementation
- at the start of each phase, after evaluating the phase against the current
  architecture and codebase state, ask the user only if something is unclear,
  under-specified, or uncertain enough that implementation details cannot be
  chosen confidently from `docs/code/extends-architecture.md`
- at the end of each phase, evaluate the implemented changes against
  `docs/code/extends-architecture.md`
- for each phase-close review, explicitly check:
  - whether anything required by the architecture is still missing from that
    phase's slice
  - whether anything implemented may be wrong, too broad, or architecturally
    inconsistent
  - whether anything in the architecture remains ambiguous at that point
  - whether there is anything still uncertain enough to require asking the user
    before continuing
