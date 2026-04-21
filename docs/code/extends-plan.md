# `extends` Implementation Plan

This plan assumes a restart from commit
`016801d694a82068a3c8102231ae0636a68a6c42` and a fresh implementation of the
architecture described in:

- `docs/code/extends-architecture.md`

Evaluation baseline:

- all future evaluation of the `extends-next` implementation must compare
  against commit `016801d694a82068a3c8102231ae0636a68a6c42`
- this is the branch point for `extends-next`
- do not evaluate against the current state of `master`
- code added on `master` after that branch point is not part of the target
  baseline for this work and may be removed entirely during the restart

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
  - for script inherited dispatch, stop depending on the current
    context-based super bridge helpers:
    - script `super()` should route through the caller-side inherited
      invocation path, not `Context.getAsyncSuper(...)`
    - keep `Context.getAsyncSuper(...)` / `Context.getSyncSuper(...)` only as
      template/block legacy helpers until Phase 9 moves templates onto the
      same constructor/method model
  - remove any temporary helper-owned admission/barrier scaffolding once the
    caller-side invocation path owns ordering:
    - keep `invokeInheritedMethod(...)` / `invokeSuperMethod(...)` only if
      they are the real caller-side admission entrypoints rather than a second
      helper-owned architecture
    - do not keep a separate pre-Phase-7 helper barrier path alongside the
      real admission-command path
    - do not carry forward the temporary helper barrier's current narrow link
      set (`__return__` plus shared channels only); the real invocation path
      must link the full caller-observable channel set needed by inherited
      method execution, including non-shared channels when required
    - keep `__constructor__` on a dedicated admission path unless callable
      entry signatures are truly unified; do not reintroduce the old argument
      misalignment where constructor `inheritanceState` and method payload
      slots overlap
    - if Phase 7 keeps a separate method-call payload builder, treat that as a
      temporary runtime-owned shape and explicitly revisit ownership in the
      later template/execution-state cleanup rather than coupling it back to
      legacy `Context` payload helpers
    - avoid deepening that temporary helper-owned barrier path while Phase 7 is
      in progress:
    - do not add new behavior there that belongs to the final caller-side
      admission/linking model
    - keep new inherited dispatch ordering work on the real invocation path so
      the temporary helper scaffolding does not become a second architecture
    - if a distinct admission placeholder/buffer still remains after the Phase
      7 fixes, freeze it as compatibility scaffolding only:
    - do not add new behavior there that belongs to the final shared
      script/template/component call-site ordering model
    - collapse that remaining placeholder/buffer shape in Phase 10 cleanup once
      the shared runtime model is stable across the later phases
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
  - if a late-resolved inherited/shared lane is discovered after the caller
    buffer has already closed that lane, do not try to reopen the finished
    caller buffer just to attach the link:
    - keep the late lane registered on the admission/invocation buffers for
      correctness of the already-running call
    - treat wider late-lane ownership/lifecycle cleanup as part of the later
      component/template execution-state work, not as a reason to weaken
      finished-buffer rules here

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
- decide whether `runtime.allowInheritanceBoundaryRead(...)` remains part of
  the explicit component-binding model:
  - keep it only if component `ns.x` / method wiring still needs an explicit
    boundary-read escape hatch
  - otherwise treat it as leftover script/template bridge scaffolding and
    schedule its removal in Phase 10 rather than carrying it forward by default
  - this decision should cover both sides of the current bridge:
    - compiler-side emission sites such as `_emitValueImportBinding(...)`
    - the runtime-side channel flag / lookup behavior that honors that marker
- decide the ownership of `src/runtime/inheritance-inputs.js` on the component
  path:
  - remove the leftover Phase 4/5 shared-input preload helper once explicit
    component payloads stop auto-materializing shared channels
  - do not keep a public runtime helper/module around once the component path
    no longer uses it
- component payload semantics on the explicit component path:
  - `component ... with ...` populates `compositionPayload`
  - those inputs are available through the component composition/render context
  - they do not auto-materialize undeclared or declared `shared` channels
  - declared shared channels still come from shared declarations plus
    constructor/method writes, not implicit payload preload
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
- constrain the component namespace surface:
  - supported forms are `ns.x`, `ns.x.snapshot()`, `ns.x.isError()`,
    `ns.x.getError()`, and `ns.method(...)`
  - do not allow arbitrary JS-object-style chaining such as `ns.x.y` or
    `ns.method.prop`
- remove first:
  - no separate import-style or legacy component-binding shortcuts remain after
    the explicit Phase 8 namespace surface landed:
    - the constrained `ns.x` / `ns.method(...)` forms are now the only
      supported component binding surface
    - keep any further namespace-surface cleanup focused on that explicit
      runtime path rather than reintroducing compatibility aliases

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
  - this Phase 9 cleanup may stop short of moving the remaining shared
    block/export state off `Context` if doing so would entangle the untouched
    sync/Nunjucks compatibility path; any residue must be called out and
    finished in Phase 10 rather than being treated as complete here
- remove first:
  - remove the remaining template/block legacy super helpers once template
    blocks use the shared constructor/method runtime path:
    - `Context.getAsyncSuper(...)`
    - keep `Context.getSyncSuper(...)` for the untouched sync/Nunjucks
      compatibility path; defer its fate to Phase 10 cleanup instead of
      coupling Phase 9 async-template work back to sync inheritance
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
  - unify remaining method-call payload ownership here or in the adjacent
    cleanup once templates are on the same callable-entry/runtime model:
    - remove the drift between the script inherited-call payload builder and
      the older context-owned template payload helpers
    - keep one authoritative payload/execution-state contract once both script
      methods and template blocks share the same model
    - collapse temporary runtime compatibility adapters such as
      `_normalizeMethodMeta(...)` once both sides produce one canonical
      callable metadata shape instead of normalizing mixed entry/meta inputs at
      dispatch time
      - if constructor admission still passes raw entries at the end of Phase
        9, finish that canonical-meta conversion in Phase 10 before collapsing
        `_normalizeMethodMeta(...)` to a validation-only assertion
  - drop script-only dead payload-local-capture setup once the shared
    script/template entry-compilation path is split cleanly:
    - stop emitting the unused script-method `payloadLocalCapturesVar` /
      `localsByTemplate[...]` read in `compileAsyncBlockEntry(...)`
    - keep payload-local-capture wiring only on the template/block path that
      still consumes it
    - remove any remaining script-side `localsByTemplate` payload coupling once
      method/block payload ownership is unified
  - remove `isBlockedInheritanceBoundaryChannelRead(...)` in `src/runtime/lookup.js`
    once cross-template bare-name reads are no longer part of the template
    inheritance path
  - remove the temporary dual shared-declaration metadata source once template
    shared declarations always arrive through transformed inheritance metadata:
    - drop the raw `node.findAll(nodes.ChannelDeclaration)` fallback in
      `CompilerCommon._getSharedDeclarations(...)`
    - keep one authoritative metadata source for scripts and templates
  - if the template-side inheritance metadata source is not fully unified in
    this phase, schedule the remaining callable/shared metadata unification in
    Phase 10 instead of leaving the raw-template fallback implicit

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

## Phase 10 - Visibility and Current-Buffer Cleanup

Goal:

- remove constructor-scope leakage and the runtime workarounds that try to
  compensate for missing payload/linking by reading from parent/root buffers

Scope:

- make the inheritance visibility model explicit in implementation:
  - the script/template body is the `__constructor__` method
  - methods/blocks do not read constructor-local or ancestor-private locals
  - inherited execution sees only shared channels plus explicit
    payload/argument/context inputs
- enforce current-buffer ownership for command emission:
  - observational commands (`addSnapshot`, waits, error reads, shared
    observations) are added to the current buffer only
  - mutating commands are added to the current buffer only
  - if a value is visible from an execution point, the current buffer must
    already have the needed linked channel path
  - missing visibility is a compiler/linking/payload bug, not a reason to jump
    to a parent/root producer buffer
- split the three read/capture models cleanly:
  - ordinary bare-name lookup uses the current buffer hierarchy only
  - explicit shared/inheritance observation remains a separate runtime path
  - immediate composition capture for `extends ... with ...` remains a narrow
    dedicated primitive and is not implemented through ordinary channel lookup
- remove hacky fixes that tried to work around the scope problem:
  - producer-buffer / owner-buffer fallback for ordinary lookup
  - producer-buffer / owner-buffer fallback for current-position waits
  - broad ancestry/path-heuristic fallback in normal channel resolution
  - any special boundary-read reopening that exists only to simulate ambient
    constructor/local visibility instead of fixing payload/linkage
  - the explicit boundary-read bridge surface itself when it still exists:
    - `runtime.allowInheritanceBoundaryRead(...)`
    - `_allowsInheritanceBoundaryRead`
    - `findBoundaryOwnedChannel(...)` and similar bridge-only ownership
      helpers if they are only supporting reopened cross-boundary visibility
- audit compiler/runtime ownership points so the visibility model is structural
  rather than heuristic:
  - verify `currentBuffer` is correct for block entry, method entry,
    constructor admission, caller invocation, component invocation, and async
    control-flow boundaries
  - verify linked-channel computation for inherited method/block metadata,
    caller used-channel metadata, component invocation/shared lanes, and other
    async boundaries
  - fix missing `usedChannels` / `mutatedChannels` / linked-channel sets rather
    than reopening fallback reads
- restore or keep only the narrow transitional bridges that are still valid:
  - immediate composition capture for explicit payload construction
  - explicit shared-channel observation through inheritance metadata
  - do not preserve any bridge that recreates ambient constructor-scope access
- align block/method symbol compilation with the final model:
  - shared names compile to explicit shared/inheritance observation
  - explicit extern/context visibility compiles through explicit composition
    context paths
  - constructor-local values are not discoverable from inherited methods/blocks
    unless forwarded explicitly in payload or written into shared channels
- remove remaining ambient inherited-symbol fallback shapes:
  - inherited block/method bare-name compilation must not rely on broad
    `context.lookup(...)` fallback for names that are neither shared nor
    explicit payload/context inputs
  - if an inherited bare-name read works, it must be because the symbol is
    explicitly allowed by the architecture and structurally present in the
    current invocation context or linked shared lanes
- stop representing explicit inherited extern inputs as ambient runtime
  channels where that representation reintroduces ordinary channel lookup paths:
  - inherited/block-time extern visibility should come from explicit
    composition/extern context first
  - do not let root extern channel materialization become a reason later code
    can "discover" externs ambiently through the generic lookup path
- concrete examples of Phase 10 bugs to remove:
  - inherited template blocks reading `extern` names such as `theme` or
    `locale` through ambient channel lookup instead of explicit
    composition/extern context
  - inherited template blocks reading undeclared bare names through broad
    `context.lookup(...)` fallback instead of failing or using explicit
    shared/payload/context inputs
  - inherited execution seeing constructor-local values because block entry
    seeded payload context from `context.getVariables()`
  - shared channels such as `theme` being visible in ancestry but failing at
    call time because the current inherited invocation buffer was never linked
    to the shared lane
  - non-inheritance composition paths keeping explicit inputs on ambient
    channel/bridge surfaces, making later inheritance regressions easy to
    "fix" by reopening visibility instead of repairing payload or linkage
  - "fixes" that make those cases pass by reading/waiting on owner buffers
    instead of repairing linkage, payload, or `currentBuffer`

Deliverables:

- runtime lookup/wait paths no longer skip the current buffer in favor of
  parent/root buffers
- inherited methods/blocks cannot observe constructor-local values ambiently
- inherited methods/blocks no longer rely on broad ambient context fallback for
  undeclared bare names
- explicit `extends ... with ...` capture still works at execution time without
  creating later ambient visibility
- the remaining runtime bridge hooks are narrowed to explicit payload/shared
  responsibilities only

Tests:

- add or keep focused regressions for:
  - no inherited access to constructor-local values
  - no inherited ambient fallback for undeclared bare names
  - no boundary-read bridge dependency for inherited visibility
  - no producer-buffer fallback for ordinary lookup
  - no producer-buffer fallback for current-position waits
  - `extends ... with ...` captures at execution time, not after later
    reassignment
  - shared channels remain visible from inherited methods/blocks
  - explicit extern/render-context visibility still works only through the
    intended payload/context mechanisms
- run:
  - `tests/pasync/loader.js` targeted `extends with` coverage
  - `tests/pasync/extends-template.js`
  - `tests/pasync/extends.js`
  - `tests/pasync/template-command-buffer.js`
  - `tests/pasync/component.js` targeted visibility/method tests
  - `npm run test:quick`

Cleanup pass before closing Phase 10:

- explicitly search for workaround-shaped code added to compensate for missing
  payload/linkage/current-buffer ownership instead of fixing the real model
- look for and remove or rewrite:
  - producer-buffer / owner-buffer reads or waits
  - fallback reads guarded by ancestry/path heuristics
  - "if current buffer cannot see it, read from parent/root" logic
  - ambient inherited bare-name fallback through broad `context.lookup(...)`
  - inherited block/method entry code that seeds scope from
    `context.getVariables()` or similarly broad constructor-local maps
  - bridge markers/flags that reopen cross-boundary visibility
  - explicit input values represented as ambient channels just to make later
    lookup succeed
- when cleaning up, prefer deleting the workaround and exposing the missing
  payload/linking bug rather than preserving the workaround behind a narrower
  helper
- if a workaround cannot yet be removed, add a short comment saying:
  - what architectural rule it is temporarily violating
  - what later phase owns removing it
  - what must not be built on top of it

## Phase 11 - Non-Extends Compatibility and Boundary Cleanup

Goal:

- preserve non-extends behavior and remove leftover boundary/runtime bridges
  that do not belong to the final visibility model

Scope:

- plain scripts/templates without `extends`
- plain `import`, `from import`, `include` remain on the ordinary composition
  path unless optional code-sharing is useful
- `caller()` in macros
- sync template inheritance untouched for Nunjucks compatibility
- sequential `!` paths, including inherited-method support once that deferred
  work is taken up
- revisit root extern/runtime ownership on the non-inheritance composition
  path:
  - remove or narrow root extern var-channel materialization if it is no longer
    needed for include/import/component compatibility
  - keep explicit extern/composition context as the authoritative model for
    inherited/non-inherited composition visibility
- preserve non-extends compatibility without reopening inheritance visibility:
  - fix `import` / `from import` / `include` / `caller()` regressions by using
    explicit payload/context or ordinary composition rules
  - do not repair those regressions by reintroducing ambient inherited lookup
    or parent-buffer reads
- clean up remaining low-risk parser/compiler consistency nits that are not
  worth carrying as architecture work:
  - parser recovery around `parseCompositionWithClause(...)` consuming a symbol
    before rejecting object-style trailing named inputs
  - extract helper-based save/restore for compiler buffer context if the
    current manual restoration pattern still exists
- remove compatibility-only shared-channel normalization once all startup paths
  emit canonical shared var defaults directly:
  - drop the `null -> undefined` normalization bridge in
    `declareInheritanceSharedChannel(...)` if it is no longer needed for older
    compile/output shapes
- remove leftover bootstrap/API defensive code once the final ownership
  boundaries are settled:
  - drop the unreachable `bootstrapInheritanceMetadata(...)` fallback that
    creates a new inheritance state when the caller already owns creation

Tests:

- `npm run test:quick`
- targeted non-extends compatibility coverage:
  - `tests/pasync/loader.js` non-extends import/include groups
  - `tests/pasync/component.js` compatibility groups
  - macro/caller coverage that still depends on explicit composition behavior

Cleanup pass before closing Phase 11:

- explicitly search non-extends composition paths for workaround fixes that
  silently reintroduce inheritance-style ambient visibility
- look for and remove or rewrite:
  - compatibility shims that use `allowInheritanceBoundaryRead(...)`-style
    logic after Phase 10 made visibility structural
  - include/import/from-import/caller fixes that depend on parent-buffer reads
    or reopened boundary visibility instead of explicit payload/context
  - root extern behavior kept alive only because later code expects externs to
    be ambient channels
  - compatibility fallbacks that preserve old behavior by broadening lookup
    rather than passing data explicitly
  - non-extends fixes that accidentally depend on async-template inheritance
    internals instead of ordinary composition rules
- when a compatibility path truly needs a temporary bridge, document:
  - why it is still needed for non-extends compatibility
  - why it is not part of the inheritance visibility model
  - which later phase removes it or formalizes it

## Phase 12 - Dynamic Extends and Runtime Shape Cleanup

Goal:

- finish the transitional runtime/compiler cleanup after the main static model
  is stable

Scope:

- dynamic `extends` uses normal compiler expression compilation when the parent
  is an expression and literal compilation when static
- dynamic `extends` waits for parent-name resolution and loading
- detailed dynamic `extends` work remains deferred until the main static model
  is stable; if the static model is not yet stable by this phase, dynamic
  `extends` may remain deferred past Phase 12 rather than being forced in here
- remove dynamic/static parent-selection transition scaffolding once the final
  model is stable:
  - `__parentTemplate` temporary-channel handoff where it is no longer needed
  - `asyncStoreIn` / transformer temp-variable plumbing that exists only to
    stage parent resolution through legacy shapes
  - compatibility-only remark:
    - do not add new inheritance/local-capture/visibility behavior to the
      `__parentTemplate` or `asyncStoreIn` path
    - treat this path as transitional parent-resolution scaffolding only
- move pending inherited-method/shared dependency discovery off ad hoc AST
  rescans and onto analysis-owned metadata
- remove the temporary compiler rescans in `src/compiler/inheritance.js`:
  - `collectPendingMethodNames(...)`
  - `collectPendingSharedNames(...)`
- flatten the temporary inheritance registry classes when they no longer add
  value over plain shared metadata objects and helpers:
  - `InheritanceMethodRegistry`
  - `InheritanceSharedRegistry`
- collapse the remaining helper-owned admission-buffer scaffolding in
  `src/runtime/inheritance-call.js` if it still exists after the main
  caller-side invocation model is stable:
  - `_createAdmissionBarrier(...)`
  - `_linkBarrierChannel(...)`
  - any distinct placeholder/buffer shape that still sits between the caller
    buffer and the real invocation buffer
- revisit buffer-finish completion ownership once component/template lifecycle
  semantics are fully stable:
  - redesign or rename `CommandBuffer.getFinishCompletePromise()` if the
    current "finished plus channel completion promises" contract is still a
    transitional helper rather than the final runtime boundary
  - compatibility-only remark:
    - do not build new ownership or visibility semantics around
      `getFinishCompletePromise()`
- rename remaining internal admission/barrier terminology once the shared
  runtime model is stable across script/template/component dispatch:
  - revisit `InheritanceAdmissionCommand` and related helper names if they
    still reflect Phase 7 transitional jargon rather than the final runtime
    responsibility
- simplify component-runtime helper structure once template integration is
  complete and no temporary cross-phase compatibility shims remain:
  - revisit component helper/class naming and any runtime-only staging layers
    that were kept to land Phase 8 incrementally
  - collapse the current double-resolution path for component method calls if
    the shared inherited-dispatch API still makes components resolve method
    metadata once for linked-channel waiting and again for admission
  - revisit the current component-startup shortcut that awaits
    `constructorBoundaryPromise` inside `createComponentInstance(...)` before
    exposing the instance, and collapse it if the later shared caller-side
    lifecycle model makes that eager wait unnecessary
  - replace the current component-mode sentinel string
- remove remaining async-template-only legacy `Context` helpers and state once
  dynamic/static compatibility work no longer needs them:
  - `beginAsyncExtendsBlockRegistration(...)` /
    `finishAsyncExtendsBlockRegistration(...)`
  - `Context.getAsyncBlock(...)`
  - `setExtendsComposition(...)` / `getExtendsComposition(...)`
  - template-local capture / inheritance-payload helpers still left on
    `Context`
  - move the last shared block/export state off `Context` and onto the explicit
    per-render execution-state object if Phase 9 left that bridge in place for
    sync/Nunjucks compatibility
- decide the final async-template compatibility surface for legacy block
  registry metadata:
  - remove or formally keep the empty `AsyncTemplate.blocks` /
    `AsyncTemplate.blockContracts` surface now that async inheritance no longer
    uses the old block-registry runtime path
  - compatibility-only remark:
    - do not add new async inheritance behavior to `Context.blocks`,
      `getBlock(...)`, `blockContracts`, `AsyncTemplate.blocks`, or
      `AsyncTemplate.blockContracts`
    - the final async extends model is metadata/method-based, not
      block-registry-based
- revisit the constructor/script-vs-template callable wrapper duplication in
  `src/compiler/inheritance.js` and collapse it if the Phase 9 shared
  callable-entry model is stable enough to support one helper-owned emission
  path
- revisit the remaining async template runtime-shape asymmetries once the
  final template/component model settles:
  - decide whether the static-only template `__parentTemplate` declaration
    remains useful as a shared compiler shape or should be removed once the
    dynamic/static parent-resolution path is finalized
  - split `currentCompilingBlock` if it still acts as both "current block body
    being compiled" state and the sentinel for "top-level block definition vs
    nested render path"
  - compatibility-only remark:
    - do not use `currentCompilingBlock`'s dual role as justification for new
      template-specific visibility fallback or inherited-scope exceptions
  - revisit the promise-wrapped
    `runtime.markSafe(runtime.invokeSuperMethod(...))` template path before any
    later text-buffer/safe-string pipeline cleanup changes how promised safe
    values are flattened
  - revisit emitted temporary-name readability for shared block payload /
    context helpers if `_tmpid()`-style names are still making generated async
    template output harder to inspect
- replace the current component-mode sentinel
  (`componentCompositionMode === runtime.COMPONENT_COMPOSITION_MODE`) with a
  cleaner final marker/API once template integration settles the shared
  inheritance-state surface
- finish the remaining template metadata-source unification if Phase 9 still
  leaves any raw `Block` / `ChannelDeclaration` rescans in place:
  - remove the `node.findAll(nodes.ChannelDeclaration)` fallback in
    `CompilerCommon._getSharedDeclarations(...)`
  - stop switching between transformed method metadata and raw template
    `Block` nodes when only metadata assembly is needed
  - decide the final policy for rejected async component declarations that are
    never observed or invoked by the caller, instead of leaving that behavior
    to the broader "unused async declaration" fallback
  - simplify the fully-normalized component payload fast path if the Phase 8
    validation-heavy branch still survives unchanged
- replace the current late-link fallback for newly discovered non-shared
  inherited-method lanes once finished-buffer ownership is settled across the
  later component/template phases:
  - avoid relying on post-close linked-channel registration as the long-term
    model for inherited non-shared channel visibility

Tests:

- `npm run test:quick`
- full test suite
- re-enable groups:
  - `tests/pasync/extends-foundation.js` ->
    `Phase 12 - Dynamic Extends Startup Plumbing`
  - `tests/pasync/extends-foundation.js` ->
    `Phase 12 - Dynamic Extends Resolution Lifecycle`
  - `tests/pasync/extends-foundation.js` ->
    `Phase 12 - Composition Payload Shape`
  - keep the sync extends regression in `tests/compiler.js` active throughout

Cleanup pass before closing Phase 12:

- explicitly search for transitional compiler/runtime shapes that survived only
  because earlier phases fixed behavior without yet collapsing the old path
- look for and remove or rewrite:
  - `__parentTemplate` staging logic that still carries old root-handoff
    assumptions
  - `asyncStoreIn` / transformer temp plumbing that only exists to preserve a
    legacy parent-selection shape
  - duplicate async-template/runtime surfaces that mirror the new metadata
    model but are no longer authoritative
  - helper/admission/barrier layers that still exist only because older code
    expected a separate placeholder buffer
  - naming/API wrappers that hide the fact a path is still transitional
  - late-link / post-close registration fallbacks that patch over ownership
    problems instead of resolving the runtime shape cleanly
  - old async-template block-registry/state paths that remain reachable after
    the metadata/method-based model is working
- for each remaining transitional path that cannot yet be removed, add a
  compatibility-only remark or TODO that states:
  - this path is not the final architecture
  - no new behavior should be added there
  - what exact condition will allow deletion

## Phase 13 - Documentation

Goal:

- update the user-facing and implementation documentation to match the final
  extends/component/import architecture

Scope:

- update `docs/code/extends-architecture.md` where implementation details or
  final terminology drifted during delivery
- make the final docs explain the inheritance visibility model explicitly:
  - the script/template body is the `__constructor__` method, not a special
    ambient parent scope
  - methods/blocks do not read constructor-local or ancestor-private locals
  - inherited execution sees only shared channels plus explicit
    payload/argument/context inputs
- update `docs/cascada/script.md` and any agent-facing script docs that
  describe:
  - `shared` declarations
  - `method ... endmethod`
  - inherited dispatch via `this.method(...)`
  - `super()`
  - `component ... as ns`
  - component `with` payload forms
  - the constrained component namespace surface:
    - allowed: `ns.x`, `ns.x.snapshot()`, `ns.x.isError()`,
      `ns.x.getError()`, `ns.method(...)`
    - not allowed: arbitrary property chaining or treating `ns` as a plain JS
      object
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
