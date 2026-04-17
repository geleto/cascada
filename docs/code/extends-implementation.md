# `extends-next` Implementation Plan

## Overview

This plan implements the inheritance architecture described in
`docs/code/extends-next.md`.

The design has five core runtime pieces:

1. one persistent shared root per hierarchy instance
2. upfront method metadata including an internal `__constructor__`
3. explicit inheritance state with ordered method chains
4. side-channel admission that stalls shared-root apply when inheritance must
   finish loading before a constructor or inherited method can proceed, using
   an `InheritanceAdmissionCommand`
5. component instances built from one long-lived shared root plus a side-channel

Implement the steps in order. Each step should land with focused tests before
moving on.

Scope:

- static ancestry only
- parent paths must be declared statically in source before constructor
  execution starts; the full parent chain does not need to be loaded eagerly
- dynamic or computed parent selection is out of scope for this plan
- async templates are in scope for the template side of this plan
- sync template extends stays on its current path unless a later step widens
  scope explicitly
- on the new static inheritance / component-instantiation path, `with { }`
  preloads declared `shared` names only
- unknown `with` keys on that new path are an error
- `extern` remains the mechanism for ordinary composition paths, not the new
  static inheritance path
- component semantics apply only to the direct binding introduced by
  `import ... as ns`; aliasing/passing/returning that value is out of scope for
  the first implementation

Implementation rule for every step:

- say what existing machinery is reused
- say what static-extends / component path replaces
- say what stays in place for legacy or dynamic paths

## Step 1 - Script Syntax

**Goal:** Add the script `shared` syntax and verify the script method syntax
needed by the inheritance model.

### Add

- `shared var x`
- `shared text x`
- `shared data x`
- `shared sequence x`

### Verify

- `method name(args) ... endmethod`

### Parser rules

- `shared` is allowed in script constructor scope
- `shared` is not allowed inside a method/block body
- `shared text x = ...` is invalid
- `shared data x = ...` is invalid
- `extends` remains a statement, not an expression

### Main files

- `src/script/script-transpiler.js`
- `src/parser.js`
- `src/nodes.js`

### Reuse

- keep the existing script lowering of `method -> block` and
  `endmethod -> endblock` in `src/script/script-transpiler.js`
- keep using the existing `Block` node shape unless a small metadata addition
  such as `isMethod` is needed
- keep using the existing channel-declaration parsing path rather than creating
  a second AST family for shared declarations

### Replace / extend

- extend the script frontend so `shared` lowers into the normal
  channel-declaration pipeline
- add only the extra metadata needed to mark a declaration as shared

### Keep

- plain `block` / template block parsing stays unchanged
- plain channel declarations stay unchanged

### Tests

`tests/pasync/extends.js`

- `shared var theme = "dark"` parses
- `shared text log` parses
- `shared` inside a method fails
- `shared text log = "x"` fails
- `shared data state = 1` fails

- `method foo() ... endmethod` compiles correctly
- method arguments are preserved
- bad `endmethod` usage fails clearly

## Step 2 - Shared Root Channels

**Goal:** Compile shared declarations as one hierarchy-owned channel per shared
name.

### Semantics

- `shared var x = value` uses initialize-if-not-set
- `shared var x` declares participation without a default
- `shared sequence db = sinkExpr` initializes the shared sequence
- `shared sequence db` declares participation without an initializer

### Main work

- record shared-channel schema on the compiled file
- add a declaration-time runtime helper that resolves the hierarchy shared root
  from the current buffer and binds shared declarations there
- add `initializeIfNotSet` support for `VarCommand`

### Main files

- compiler shared-declaration path
- `src/runtime/command-buffer.js`
- `src/runtime/commands.js`

### Reuse

- keep using the existing `ChannelDeclaration` node shape and normal channel
  declaration compilation path as the base
- keep the existing parser restriction that `text` and `data` declarations do
  not accept scalar initializers
- keep ordinary `VarCommand` behavior except for the added
  `initializeIfNotSet` option

### Replace / extend

- extend declaration compilation so shared declarations bind to the persistent
  hierarchy shared root instead of declaring a local channel in the current
  buffer
- keep this as declaration-time routing, not as a new general-purpose
  `CommandBuffer` root-lookup API; the later command-buffer refactor should keep
  shared handling as ordinary lane/channel structure rather than a special
  buffer feature

### Keep

- non-shared channel declarations continue to use the current local-buffer path

### Tests

`tests/pasync/extends.js`

- normal script compile output lowers shared declarations to
  `declareSharedBufferChannel(...)` and shared-var defaults to
  `initializeIfNotSet`
- normal script compile output lowers `shared sequence` declaration-only and
  initialized forms correctly
- normal script rendering applies shared-var defaults and preserves
  declaration-only shared vars until a later plain assignment
- keep runtime-only coverage minimal here: one focused child-buffer test proves
  descendant shared-var defaults beat ancestor defaults until Step 4 makes the
  full inheritance path available
- the true preloaded-value / `with { x: 99 }` integration case lands with Step
  4 bootstrap

## Step 3 - Structural Extends Load Boundary

**Goal:** Make static script `extends` reserve a structural async boundary at
the source site immediately, while parent loading continues later.

### Async-boundary contract

For this step, static script `extends` should behave like other async
control-flow boundaries:

- reserve the boundary position at the `extends` site immediately
- wait only for parent template/script resolution and loading
- keep emitting post-`extends` code into the current buffer without waiting for
  parent application to finish

Ordering then comes from the ordinary hierarchical command-buffer iterator, not
from an explicit apply-complete wait.

### Main work

- rewrite async `extends` compilation around an ordinary structural async
  boundary at the `extends` site
- lower static script `extends` through the same child-buffer reservation
  pattern used by async `if` / loop control-flow
- reserve the boundary synchronously before parent loading resolves
- move parent loading/wiring into that boundary callback
- emit post-`extends` code normally in the current buffer after the boundary
  call without awaiting child apply-completion
- update async root completion so composition mode returns the current
  structural root rather than relying on the old parent handoff
- remove static-path inheritance payload/local-capture threading rather than
  adapting it; it is dead machinery in the new model
- remove static-path extends-composition context threading rather than adapting
  it; it is dead machinery in the new model

### Main files

- `src/compiler/inheritance.js`
- `src/compiler/compiler-async.js`
- `src/runtime/command-buffer.js`
- `src/environment/context.js`

### Reuse

- keep the existing command-buffer tree model and child-buffer attachment model
- keep composition-mode root rendering as the mechanism that returns a buffer
  instead of finalizing via callback

### Replace

- replace the static-extends branch of `compileAsyncExtends()` that currently:
  - calls `context.beginAsyncExtendsBlockRegistration()`
  - writes `__parentTemplate`
  - records `setExtendsComposition(...)`
  - incrementally registers parent blocks through `context.addBlock(...)`
  - calls `context.finishAsyncExtendsBlockRegistration()`
- replace the static-extends part of `_emitAsyncRootCompletion()` that
  currently looks up `finalParent` and calls
  `finalParent.rootRenderFunc(...)` after the child finishes
- retire static-path `__parentTemplate` analysis/declaration/transformer
  plumbing that only exists to support that handoff; keep `__parentTemplate`
  only for the dynamic path
- do not remove static-path inheritance payload/local-capture plumbing yet if
  async template block args / local captures / `super(...)` still depend on it;
  land that deletion in Step 10 together with the replacement path used by
  static async templates

### Keep

- keep `getFinishedPromise()` for scheduling-complete use cases unrelated to the
  static script `extends` boundary
- keep dynamic-extends machinery alive for the dynamic path until that path is
  redesigned explicitly
- keep the existing sync path unchanged unless a later step explicitly widens
  scope

### Tests

`tests/pasync/extends.js`

- constructor order is still `pre-C`, `pre-B`, `A`, `post-B`, `post-C`
- shared state written in descendant pre-extends code is visible to ancestors
- static script `extends` lowers through a structural async boundary
- post-`extends` output stays after parent output through normal buffer-tree
  ordering, not an explicit apply wait
- multiple top-level script `extends` declarations are rejected clearly

## Step 4 - Inheritance State Bootstrap

**Goal:** Expose child-owned method metadata up front and create inheritance
state before that child's constructor flow relies on inherited dispatch.

### Bootstrap responsibilities

1. compile a file before reading that file's inheritance metadata
2. expose a `methods` map on the compiled file
3. include an internal `__constructor__` entry in that map for top-level
   constructor code
4. create inheritance state at child root start
5. register child methods immediately in child-first chains
6. register shared-channel schema on the hierarchy shared root
7. preload `with { }` values into shared state for component-instantiation
   cases that use `with { }`

### Main work

- emit upfront method metadata for each compiled file:
  `{ fn, contract, ownerKey }`
- compile top-level constructor code as an internal `__constructor__` method
- reserve `__constructor__` as a forbidden user identifier
- create inheritance state for the near-term steps
- register the child file's methods immediately at root start, before its own
  constructor flow continues
- parent methods are not required to be present yet; they register later when
  the structural `extends` load boundary resolves
- parent shared schema likewise registers later when the structural `extends`
  load boundary resolves; any newly discovered shared lanes are still only
  materialized once Step 7's shared-root stall-and-link admission exists
- validate `with { }` keys for the new static inheritance / component path
  against declared shared schema, and preload only declared shared names
- keep the current structural `extends` load boundary from Step 3; this step
  only prepares inheritance state and metadata

### Main files

- compiler metadata emission for compiled files
- root-start inheritance bootstrap path
- reserved-identifier validation

### Reuse

- keep `template.compile()` / `script.compile()` as the way to materialize
  compiled metadata before bootstrap reads it
- keep child-first constructor execution order from Step 3
- keep `shared` root-channel routing from Step 2

### Replace

- replace the idea that inherited methods must be discovered implicitly from
  ordinary script/global lookup
- replace ad-hoc constructor handling with the same metadata pipeline used by
  methods
- replace "winning override only" thinking with ordered per-method chains

### Keep

- keep inheritance state on `context` for the near-term steps
- keep dynamic-extends machinery separate; this step is for the new static path

### Tests

`tests/pasync/extends.js`

- compiled files expose `methods` metadata up front
- compiled files expose `__constructor__` in the methods map with the expected
  internal metadata shape
- `__constructor__` is a forbidden user identifier and cannot be declared by
  user code
- child methods register before child constructor flow relies on them
- parent methods register later when the `extends` load boundary resolves
- parent methods become reachable through inherited dispatch after the `extends`
  load boundary resolves, not only through direct unit calls to
  `registerCompiledMethods(...)`
- `with { }` preload is visible to ancestor constructor code
- shared schema is registered before constructor work begins

## Step 5 - Explicit Inherited Dispatch Syntax

**Goal:** Implement `this.method(...)` and `super()` syntax on top of ordered
method chains.

### Dispatch rules

- `this.method(args)` is the only inherited-dispatch syntax
- bare `foo()` never participates in inheritance lookup
- `this.method` without a call is invalid in the first implementation
- `super()` resolves by ordered chain position using current method name plus
  current `ownerKey`

### Main work

- reserve explicit AST / transpiler support for `this.method(...)`
- reject unsupported `this.name` non-call forms
- compile `this.method(...)` to a runtime inherited-dispatch helper
- compile `super()` to a runtime super-dispatch helper using current method name
  plus current `ownerKey`
- register parent methods into inheritance state when the `extends` load
  boundary resolves
- keep unresolved inherited-call stalling and shared-root admission for Step 7;
  this step only establishes syntax, ordered lookup, and the already-registered
  fast path

### Main files

- script transpiler / parser support for `this.method(...)`
- async compiler call lowering
- runtime inherited-dispatch helpers
- inheritance-state lookup helpers

### Reuse

- keep the ordered structural `extends` load boundary from Step 3
- keep the method metadata emitted in Step 4
- keep `super()` as the user-facing syntax

### Replace

- replace implicit inherited-method lookup hacks on the static-extends path
- replace single-winning-override tables with ordered method chains

### Keep

- keep inheritance state on `context` for this step
- keep ordinary local/context/global call semantics for bare `foo()`

### Tests

`tests/pasync/inherited-dispatch.js`

- `this.method(...)` resolves immediately when the needed method entry is
  already registered
- `super()` resolves to the next method after the current `ownerKey`
- unsupported `this.name` non-call forms fail clearly
- missing inherited methods still fail clearly once the chain is known complete

## Step 6 - Inheritance State Plumbing Cleanup

**Goal:** Keep the current semantics but move inheritance plumbing behind an
explicit runtime argument and dedicated helper boundaries.

### Main work

- introduce an explicit `inheritanceState` runtime parameter for root and
  method/block entrypoints that need inherited dispatch
- thread that parameter through `extends`, method dispatch, and `super()` call
  paths
- remove temporary inheritance-state storage from `context`
- keep `context` focused on render/global/extern lookup rather than inheritance
  dispatch state
- move the state behind a dedicated `InheritanceState` class
- consolidate inheritance / extends runtime helpers behind a dedicated module or
  class boundary
- consolidate compiler-side inheritance / extends lowering behind a dedicated
  compiler module boundary
- factor out low-level invocation pieces that can be shared between ordinary
  function/macro calls and inherited method dispatch, while keeping inherited
  dispatch as a separate top-level path with its own inheritance-state
  resolution rules

### Main files

- root/method entry function signatures
- compiler call-site threading for inherited dispatch
- compiler inheritance / extends helper module
- `src/environment/context.js`
- `src/runtime/inheritance-state.js`
- inheritance / extends runtime helper module or class

### Reuse

- keep the semantics from Steps 4 and 5 exactly the same
- keep the same inheritance-state data shape and ordered method chains

### Replace

- replace near-term `context`-hosted inheritance state with an explicit runtime
  argument

### Keep

- keep block/method contracts and `ownerKey` semantics unchanged

### Tests

`tests/pasync/inherited-dispatch.js`

- inherited dispatch still works after the state move
- `super()` still resolves by ordered chain position, not by ambient context

`tests/pasync/extends.js`

- parent composition/extends paths reuse the existing `inheritanceState`
  instead of creating a second one in the `inheritanceState = inheritanceState || ...`
  branch

## Step 7 - Shared Root Constructors and Load-Stalled Dispatch

**Goal:** Replace the remaining transitional dispatch model with one persistent
shared root, constructor-as-method execution, and side-channel apply stalling
when inheritance must finish loading before shared-visible work can proceed.

### Runtime model

- one hierarchy instance owns one persistent shared root buffer for all `shared`
  channels
- that shared root exists before local constructor execution starts
- the most-derived entry creates that shared root once and passes it downward;
  parent files reuse it instead of creating replacement shared roots
- each compiled file exposes an internal `__constructor__` method alongside its
  ordinary methods
- the most-derived entry `__constructor__` starts immediately after bootstrap
- parent constructor invocation uses the same runtime admission path as
  inherited method calls
- non-shared constructor-local channels remain private to that constructor
  invocation and end with it
- methods and constructors access shared state through the shared root; they do
  not depend on ancestor-private constructor state
- each loaded extended/imported script owns one inheritance side-channel entry
  point for constructor and inherited-method admission

### Stalling rule

- the concrete shared-root admission unit is an observable
  `InheritanceAdmissionCommand`
- when side-channel `apply()` sees that the requested constructor or inherited
  method is not available yet, it stalls shared-root application there
- while stalled, it waits for the needed inheritance load to finish
- during that stalled window it may register newly loaded methods, extend the
  shared schema, and link newly discovered shared lanes because no dependent
  shared-visible apply has been allowed to pass that point yet
- after the stall resolves, it performs the ordinary static linking and
  invocation for the now-known target method
- later shared-visible commands therefore run only after the shared-root
  topology and method table are current

### Main work

- refactor the compiled root function into a bootstrap preamble that:
  - establishes/reuses the shared root
  - creates or reuses `inheritanceState`
  - registers local methods and local shared schema
  - preloads component-instantiation shared inputs when applicable
  - admits local `__constructor__`
- compile top-level constructor flow to the internal `__constructor__` method
  all the way through the runtime path
- move non-shared constructor-local declarations/return-channel setup from the
  bootstrap preamble into `__constructor__` invocation setup
- add the inheritance side-channel entry point used by constructor and inherited
  method admission
- add the `InheritanceAdmissionCommand` used by that side-channel
- move unresolved inherited calls off the current deferred/wildcard bridge and
  onto side-channel apply stalling
- link shared lanes only through the shared root, never through wildcard
  caller-side channel linking
- ensure newly loaded shared channels are created/linked only while the
  side-channel stall is holding shared-root progression
- keep known-method invocations on the ordinary fast path once metadata is
  available

### Main files

- `src/compiler/inheritance.js`
- `src/compiler/compiler-async.js`
- `src/runtime/call.js`
- `src/runtime/command-buffer.js`
- `src/runtime/inheritance-state.js`

### Reuse

- keep the explicit `inheritanceState` plumbing from Step 6
- keep ordered method chains and `ownerKey`-based `super()` lookup
- keep the shared-channel schema emitted in Step 2 and registered in Step 4
- keep constructor linked-channel analysis separate from ordinary method
  linked-channel analysis for now; although both flow through method metadata,
  the constructor still owns top-level-flow-specific concerns and should not be
  force-merged into the ordinary method collector yet

### Replace

- replace any remaining constructor-specific runtime path separate from method
  admission
- replace unresolved inherited-call deferred-slot behavior with side-channel
  apply stalling on the shared root
- replace wildcard/dynamic caller-side channel linking with the shared-root
  stall-and-link model

### Keep

- keep ordinary local/context/global call semantics for bare `foo()`
- keep non-shared local channels private to the invocation that declared them
- postpone constructor-vs-method linked-channel-analysis unification to a later
  cleanup step after Step 10, once script and template constructor behavior has
  both stabilized
- keep Step 7 extends-specific bootstrap/admission helpers in the generic
  compiler/runtime files for now, but treat that as temporary organization
  rather than a long-term layering decision; move them in the post-Step-10
  extraction pass described below

### Later cleanup

Treat the remaining cleanup in three layers so we do not mix harmless
structural simplifications with behavior-changing post-Step-7 work.

#### Safe now

- reduce compiler-instance staging state where possible without changing the
  Step 7 runtime contract
  - prefer scoped helper wrappers over repeated manual save/restore around
    `_currentRootExportBufferVar`
- reduce thin internal wrapper layers in Step 7 admission/runtime code when the
  wrappers do not encode a separate semantic concept
  - keep the public runtime surface stable, but simplify private helper flow
- keep compatibility aliases such as `callWrap` / `callWrapAsync` temporarily,
  but do not add new internal callers to those legacy names

#### Post-Step-9 cleanup, before Step 10

- remove the remaining `asyncExtendsBlocksPromise` bridge from unresolved
  inherited lookup and shared-channel-type resolution once script and component
  constructor return/finalization behavior no longer depends on the old
  registration lifecycle
  - this should happen after Step 9, while the work is still script/component
    only, and before Step 10 adds template-extends behavior on top
- re-evaluate whether constructor admission still needs a separate
  `value + completion` shape, or whether root completion can collapse onto a
  simpler single admission contract

#### Step 11

After Steps 8-10 stabilize the constructor/root contract, do one explicit
cleanup/extraction step that moves the stable extends-specific helpers out of
generic files into dedicated extends compiler/runtime modules.

This Step 11 extraction should cover the non-obvious Step 7 helpers too, not
just the obvious `compileAsyncStaticRootExtends(...)` path. Current examples
include:

- compiler-side constructor bootstrap/finalization helpers in
  `src/compiler/compiler-async.js`, such as:
  - `_compileAsyncScriptConstructorEntry(...)`
  - `_emitRootConstructorAdmission(...)`
  - `_emitAsyncConstructorRootCompletion(...)`
  - `_emitRootInheritanceBootstrap(...)`
- runtime-side admission/bootstrap helpers currently living in broad files,
  such as:
  - `runtime.bootstrapInheritanceMetadata(...)` in `src/runtime/runtime.js`
  - `runtime.admitMethodEntry(...)` /
    `runtime.admitMethodEntryWithCompletion(...)` in `src/runtime/call.js`
  - ordinary callable invocation and inheritance admission currently sharing
    `src/runtime/call.js`; once the Step 7-10 behavior settles, split that file
    into a normal callable-invocation surface (`invokeCallable*`) and an
    extends/inheritance-dispatch surface
  - the underlying inheritance-admission helpers in `src/runtime/call.js`

Do not do this extraction during Step 7 itself. First let Steps 8-10 settle the
final constructor/component/template behavior, then use Step 11 to move the
stable extends-only surface out of the generic files in one cleanup pass.

### Tests

`tests/pasync/extends.js`

- `__constructor__` is reserved and cannot be user-declared
- constructor order remains `pre-C`, `pre-B`, `A`, `post-B`, `post-C`
- the hierarchy shared root is created once at the most-derived entry and
  reused by loaded parents
- non-shared constructor-local channels do not leak out of `__constructor__`
- the entry `__constructor__` starts from bootstrap admission, not through the
  old root-body execution path
- newly loaded ancestor shared channels become available only through the shared
  root after the stalled side-channel apply resumes

`tests/pasync/inherited-dispatch.js`

- unresolved inherited calls stall shared-root apply at the admission point,
  not JS emission
- later known-method calls do not outrun a pending load that may still extend
  the shared-root topology
- two unresolved inherited admissions from the same flow resume in source order
- once loading completes, ordinary static linking / fast-path invocation is used
  for the actual call instead of repeated stalled admission
- `super()` still resolves to the next owner correctly through the stalled
  admission path

## Step 8 - Constructor Return Rules

**Goal:** Implement the simplified return model.

### Rules

- only the entry file's explicit `return` counts in direct render
- ancestor constructor returns are ignored
- component import ignores constructor return
- async templates follow the same inheritance model without constructor returns

### Main work

- keep explicit return handling rooted in the entry render only
- make ancestor `__constructor__` returns non-final in composition/inheritance
  mode
- ensure component import always yields the component object

### Main files

- `src/compiler/compiler-async.js`
- return-handling paths for script render and composition render

### Reuse

- keep the existing top-level entry render as the only place that finalizes the
  direct-render result

### Replace / simplify

- do not introduce a hierarchy-wide return-slot or ancestor-priority system

### Keep

- component import still produces the component object
- template renders stay on their normal text-result path

### Tests

`tests/pasync/extends-return.js`

- if C returns explicitly, that value is the direct-render result
- if only A returns explicitly and C does not, A's return is ignored
- if the entry file has no explicit `return`, the normal fallback result still
  works
- an ancestor `__constructor__` explicit return is ignored even when it
  resolves later than child work

Component-return cases are validated when the component runtime lands in Step 9,
not in Step 8 itself:

- component import still yields the component object when constructor code
  contains an explicit `return`
- component instantiation ignores constructor return even when the constructor
  performs async work

## Step 9 - Component Instances

**Goal:** Implement component instances as one long-lived shared root plus one
side-channel.

The side-channel is a runtime object owned by the component instance. It accepts
component operations from caller code, immediately enqueues the corresponding
component command or per-call child buffer into the component buffer tree, and
returns the resulting promise to the caller.

### Creation

- `import "C.script" as ns with { ... }` creates one long-lived component
  shared root as a child of the caller buffer
- bootstrap creates inheritance state, registers child-owned method metadata,
  and builds the shared schema
- constructor execution runs through the same `__constructor__` admission path
- the caller receives a component object bound to `ns`

### Component Object Semantics

- `ns.method(args)` compiles to a component-side call path
- `shared var` reads compile as component shared-value reads at the caller's
  current position, not as stored JS property reads
- `shared text`, `shared data`, and `shared sequence` observations compile as
  component-side observation commands
- `.snapshot()`, `.isError()`, and `.getError()` remain current-buffer
  observations, not JS method calls on stored objects

Shared-var reads therefore use the same component-side operation path as other
component operations, not a plain JS object field read.

The compiler therefore needs explicit component-binding tracking so it can
distinguish `ns.method()` and `ns.state.snapshot()` from ordinary member access
on non-component values.

This requires a new typed component-binding structure parallel to the existing
`importedBindings` Set. The current Set/boolean imported-callable tracking is
not enough to distinguish component instances from ordinary imported bindings.

First implementation restriction:

- component semantics apply only to the direct binding introduced by
  `import ... as ns`
- aliasing, passing, or returning that binding is out of scope
- compile only direct syntactic uses such as `ns.method()`, `ns.x`,
  `ns.log.snapshot()`, `ns.db.isError()`, and `ns.db.getError()` to the
  component-side path

### Side-channel semantics

- side-channel `apply()` runs immediately
- it does not wait for argument resolution first
- `ns.method(args)` immediately creates one child buffer under the component
  shared root and calls the method immediately when the target is already
  available
- if that target still depends on unfinished ancestry loading, the same
  Step 7 inheritance admission path stalls shared-root apply there before the
  actual invocation starts
- shared observations are immediately added into the component shared root
- the side-channel returns the resulting method/observation promise directly

Caller expressions such as `var result = ns.method(args)` therefore compile to a
component-side command path whose returned promise becomes the value of the
expression in the ordinary Cascada way.

### Lifetime

- the side-channel is owned by the caller buffer that owns the `ns` binding
- constructor startup does not finish the component shared root
- later method calls and observations keep appending through the side-channel
  while that caller buffer is still being applied
- once the owning caller buffer finishes applying, no new component operations
  can arrive from that scope or any of its async children
- close the side-channel from the owning caller buffer's normal structural
  teardown point and finish the component shared root there

### Main work

- preserve component-import metadata through parsing/compilation
- extend the parser/frontend so `import ... as ns with { ... }` survives as a
  distinct component-instantiation form rather than collapsing into the plain
  extern-composition import path
- compile component method calls to component-side commands
- compile component shared observations to component-side commands
- add component-side side-channel state
- wire component lifetime to the normal completion/teardown of the caller
  buffer that owns the `ns` binding
- when that owner scope can no longer emit component operations, close the
  side-channel and call `componentBuffer.markFinishedAndPatchLinks()`

### Main files

- parser/frontend import handling
- imported-binding analysis and imported-callable/member-call classification
  paths in the async compiler
- `src/compiler/inheritance.js`
- component-call / observation command paths
- `src/runtime/command-buffer.js`
- `src/runtime/commands.js`

### Reuse

- reuse composition-mode rendering as the constructor-startup entrypoint,
  specifically the existing `rootRenderFunc(..., true)` / `_renderForComposition()`
  path
- reuse the existing imported-component/member-call classification machinery as
  the base for identifying component-bound names in expressions
- reuse existing current-buffer observation semantics for `.snapshot()`,
  `.isError()`, and `.getError()`
- reuse the normal parent/child command-buffer tree for per-call child buffers

### Replace / extend

- add a new typed component-binding registry parallel to the existing
  `importedBindings` Set so component instances can be distinguished from
  ordinary imports/macros and routed to the component-side command path
- add the component side-channel object/state and wire it to the component
  shared root
- add component-specific command emission for method calls and shared
  observations
- keep the side-channel implementation intentionally thin: immediate start on
  caller-side command apply plus close-on-owner-buffer-complete, not a second
  dependency scheduler

### Keep

- plain `import` / `include` composition keeps the current extern/composition
  behavior
- non-component property access keeps the normal member-lookup path

### Step 9 cleanup follow-up

The first Step 9 landing may keep some implementation duplication while the
runtime/compiler behavior settles.

Completed cleanup from the initial Step 9 landing:

- the component-facing inherited-dispatch helper now stays on a plain
  final-value contract; component runtime does not understand or unwrap
  internal `{ value, completion }` admission objects
- shared runtime helpers are reused for method/schema bootstrap and
  shared-input preload; component-local copies of that logic are removed
- compiler-side component operation emission already goes through one reusable
  helper so `ns.method(...)`, `ns.x`, and
  `ns.channel.snapshot()/isError()/getError()` share one command-emission path
- binding-channel resolution already stays on one helper path for method calls,
  observations, and close/teardown

Deferred cleanup for Step 11:

- collapse component method/observation command plumbing toward one generic
  component-operation command shape instead of parallel near-duplicate command
  classes
- keep shrinking `src/runtime/component.js` toward the actual component model:
  explicit side-channel object/state, bootstrap, and lifetime management,
  without extra command/result-settling ceremony
- keep the side-channel object itself explicit; do not let component behavior
  spread into ad-hoc command-buffer helpers or generic buffer-skipping APIs

### Tests

`tests/pasync/component-import.js`

- component import creates a usable instance object
- shared var access works through `ns.x`
- `ns.x` shared-var reads occur at the caller's current position rather than as
  eager JS property reads
- shared non-var observation works through `ns.name.snapshot()` and friends
- two imports create independent instances
- invalid component shared-input names fail with the component-import-specific
  validation message
- component bootstrap failure (for example missing imported script/template)
  rejects cleanly instead of hanging the caller

`tests/pasync/component-method-calls.js`

- method calls start immediately when their caller-side command applies
- each call gets an isolated child buffer under the component shared root
- side-channel apply does not wait for argument resolution before calling the
  method
- a component method call can pass through unresolved inherited admission and
  still preserve caller-visible ordering
- method return values resolve correctly
- method-local temporary channels do not leak across calls
- shared observations use the same immediate component-side path
- fatal component method argument resolution rejects cleanly instead of leaving
  the component root open

`tests/pasync/component-lifecycle.js`

- constructor work and later method work both complete before the component
  shared root is considered done
- method calls made after constructor startup still attach correctly
- caller-side output order remains deterministic
- the component shared root does not finish before the side-channel finishes
- no new component operations can start after owner-scope teardown closes the
  side-channel
- two component instances sharing the same parent chain stay isolated even when
  ancestry loads asynchronously

## Step 10 - Templates

**Goal:** Apply the same architecture to templates.

### Includes

- template-side `shared` syntax
- pre-extends and post-extends execution around `{% extends %}`
- block-based override and `super()` behavior using the same bootstrap model
- the same shared-root, constructor-as-`__constructor__`, and side-channel
  model as scripts, minus constructor-return handling

This step intentionally changes the behavior of extending templates: top-level
code before and after `{% extends %}` becomes real pre-extends and post-extends
constructor code instead of being ignored in the classic Nunjucks style.

This step must also update or explicitly gate legacy tests that still assert
the old Nunjucks-style behavior for static `extends`.

### Reuse

- reuse the same bootstrap, shared-root, constructor/method admission, and
  side-channel model established for scripts
- keep block override and the existing `Context.blocks` / `getAsyncSuper()`
  lookup model for async templates

### Replace

- replace the current static-extends behavior that skips top-level rendering in
  extending templates
- remove the current static-extends definition-only guards in
  `compileAsyncBlock()` / `compileSyncBlock()` that check
  `hasStaticExtends && !hasDynamicExtends` and skip top-level block rendering on
  the new static-extends path
- replace the static-path `needsParentCheck` / `parentPromise =
  runtime.channelLookup("__parentTemplate", ...)` logic in async block
  compilation; keep that `__parentTemplate`-based parent check only for the
  dynamic path

### Keep

- plain templates without `extends` keep their normal user-visible behavior,
  even though the async compiler now routes them through the same internal
  constructor-admission root path for consistency
- sync template extends stays on its current path in this plan
- dynamic-extends behavior stays on its existing path until redesigned

### Tests

`tests/pasync/template-extends-pre-post.js`

- child template code before `{% extends %}` runs as pre-extends code
- code after `{% extends %}` runs as post-extends code
- block overriding still works
- `super()` still resolves correctly when parent block metadata arrives later
- shared state stays consistent across top-level template constructor code and
  block bodies
- pre/post ordering stays correct through multi-level static extends chains
- post-extends shared mutations remain visible to overriding block reads
- async ordering around parent loading remains correct for pre-extends and
  post-extends template code
- a static child extending a dynamically-extending parent still continues
  through the parent constructor/root path correctly
- parent-template load failures on the static extends path fail cleanly rather
  than hanging the render
- legacy static-extends tests are updated or explicitly gated so the behavior
  change is intentional

## Step 11 - Extraction And Consolidation

**Goal:** Make the final inheritance architecture easier to own by moving the
stable extends/component/template machinery out of generic files and reducing
the remaining structural duplication left after Steps 7-10.

### Includes

- start Step 11 with one explicit extraction analysis pass that inventories the
  remaining extends/component/template helpers in generic files, groups them by
  stable responsibility, and confirms the target file split before moving code
- extract stable extends-specific compiler helpers from broad files such as
  `src/compiler/compiler-async.js` and `src/compiler/inheritance.js` into
  dedicated extends-focused compiler modules
- extract stable inheritance/component runtime helpers from broad files such as
  `src/runtime/call.js` and `src/runtime/runtime.js` into dedicated
  extends-focused runtime modules
- reduce the remaining duplicated constructor/root-completion and
  parent-continuation plumbing where the behavior is already settled
- formalize shared-channel cross-template read metadata so lookup does not rely
  on ad-hoc private flags as an implicit multi-file contract
- keep exported-macro rebinding centralized so macro metadata does not get
  copied piecemeal across multiple wrapper sites
- make async analysis authoritative enough that inheritance/template code can
  stop compensating in the compiler with raw AST symbol scans for block-local
  capture names
- move imported-call boundary linked-channel narrowing onto analysis or other
  explicit metadata so compiler emission no longer reconstructs it ad hoc from
  argument trees
- revisit macro caller-capture threading so `CompileMacro` does not need
  class-level staging state such as `currentCallerCaptureInfo`
- keep generic command-buffer invariant fixes, such as iterator-visit
  bookkeeping cleanup, separate from inheritance-specific ownership cleanup
- extract the remaining duplicated async-extends compilation structure shared by
  `compileAsyncExtends(...)` and `compileAsyncStaticTemplateExtends(...)`
- formalize the compiler-side `linkedChannels` emission contract so helpers do
  not accept a silent string-or-array dual type

### Target File Split

The exact split should be confirmed by the Step 11 analysis pass, but the
intended direction is:

- `src/compiler/compiler-extends.js`
  - root bootstrap/admission helpers now living in `compiler-async.js`
  - constructor-root completion and parent-handoff helpers
  - inheritance local-capture helpers that exist only for extends/component
    flow
- `src/compiler/inheritance.js`
  - may remain as the statement-level entry file for `extends` node
    compilation, or may become a thinner facade if the analysis pass shows the
    current responsibilities should collapse into `compiler-extends.js`
- `src/runtime/inheritance-call.js`
  - extends-specific admission/dispatch helpers currently living in `call.js`
  - inherited dispatch, super dispatch, direct method admission, and the
    detailed completion-tracking variants
- `src/runtime/inheritance-bootstrap.js`
  - shared-schema bootstrap helpers currently living in `runtime.js`
  - shared-input validation/preload helpers
  - current-buffer shared-link setup used by script/template/component
    inheritance bootstrap
- `src/runtime/inheritance-state.js`
  - keep as the focused runtime state holder unless the analysis pass finds a
    clearer ownership boundary

The analysis pass should also explicitly decide what stays in broad files:

- keep generic callable invocation in `src/runtime/call.js` unless the moved
  inheritance dispatch surface is the only remaining user of a helper
- keep generic command-buffer and channel mechanics in `src/runtime/command-buffer.js`
  and `src/runtime/channel.js`
- keep generic compiler node dispatch in `src/compiler/compiler-async.js`,
  delegating extends/component/template inheritance work outward rather than
  moving the whole compiler surface

### Step 11 Order

- Step 11A: analysis/inventory pass, with the target file split written down
  before moving code
- Step 11B: extract compiler-side extends/template/component helpers
- Step 11C: extract runtime-side inheritance bootstrap helpers
- Step 11D: extract runtime-side inheritance dispatch/admission helpers and
  leave generic callable invocation behind
- Step 11E: close the remaining structural cleanup items that depend on the new
  ownership boundaries, such as analysis-authoritative metadata and the
  `linkedChannels` contract cleanup

### Reuse

- reuse the final behavior established in Steps 7-10 without changing user
  semantics
- keep the explicit shared-root / constructor / inheritance-state model exactly
  as stabilized by the earlier steps

### Replace

- replace "post-Step-10 cleanup" as an informal bucket with one explicit step
- replace broad-file ownership of stable extends-specific helpers with narrower,
  dedicated module ownership

### Keep

- no new user-facing inheritance behavior
- no semantic redesign of constructor return, block dispatch, or component
  lifetime rules
- only structural cleanup and ownership consolidation unless a bug is found

### Tests

- rerun the focused inheritance/component/template suites from Steps 7-10 after
  each extraction slice
- keep `npm run test:quick` green before closing the cleanup step

## Non-Goals

- caller-side read/write analysis for component scheduling
- per-channel promise maps on the caller side
- global serialization of all component calls through `ns!`
- aliasing-based replacement for per-call child buffers

## Completion Checklist

- [ ] focused tests pass for each step before moving on
- [ ] `npm run test:quick` passes at the end
- [ ] full test suite passes before closing the feature
- [ ] `docs/code/extends-next.md` still matches the implementation

