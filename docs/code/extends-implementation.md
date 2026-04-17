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

#### Deferred cleanup after Step 10

The following Step 7 follow-ups were originally noted as "after Step 9, before
Step 10", but the final architecture work made them clearer as post-extraction
simplification tasks instead:

- remove the remaining `asyncExtendsBlocksPromise` bridge from unresolved
  inherited lookup and shared-channel-type resolution
  - this is now owned by **Step 12A**
- re-evaluate whether constructor admission still needs a separate
  `value + completion` shape, or whether root completion can collapse onto a
  simpler single admission contract
  - this is now owned by **Step 12C**

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
  - `runtime.admitConstructorEntry(...)` in `src/runtime/call.js`
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

## Step 11 - File Extraction (Behavior-Preserving)

**Goal:** Move the stable extends/component/template machinery out of generic
files into dedicated extends-focused modules, without changing behavior. This
step is deliberately limited to code motion.

### Why extract before simplifying

The biggest simplification wins identified in the post-Step-10 architectural
review (admission-surface collapse, `{ value, completion }` dual-shape
retirement, script/template boundary unification, legacy-bridge removal) are
currently hard to see because extends helpers are sprinkled across
`compiler-async.js`, `call.js`, and `runtime.js` alongside unrelated generic
machinery. Extraction makes duplication visible: near-identical helpers end up
side-by-side in their new homes, and thin wrapper layers become obvious as
single-caller trampolines. Attempting the simplifications before the move
means doing archaeology in broad files and leaving the layering intact; doing
them after the move makes them mechanical edits. Step 12 then depends on the
ownership boundaries this step establishes.

### Includes

- one explicit extraction analysis pass that inventories the remaining
  extends/component/template helpers in generic files, groups them by stable
  responsibility, and confirms the target file split before moving code
- extract stable extends-specific compiler helpers from broad files such as
  `src/compiler/compiler-async.js` and `src/compiler/inheritance.js` into
  dedicated extends-focused compiler modules
- extract stable inheritance/component runtime helpers from broad files such as
  `src/runtime/call.js` and `src/runtime/runtime.js` into dedicated
  extends-focused runtime modules
- keep generic command-buffer invariant fixes, such as iterator-visit
  bookkeeping cleanup, separate from inheritance-specific ownership cleanup

### Explicitly out of scope for Step 11

These land in Step 12, after the ownership boundaries are in place:

- collapsing the admission surface or materializing
  `InheritanceAdmissionCommand` as a real class
- retiring the `{ value, completion }` dual-shape admission contract
- unifying script-vs-template extends-boundary and constructor-entry codegen
- retiring the `__parentTemplate` / `asyncExtendsBlocksPromise` legacy bridges
  and the parallel dynamic-extends code path
- making analysis authoritative enough to remove block-local capture raw AST
  scans and the `linkedChannels` string-or-array dual type
- revisiting macro caller-capture threading so `CompileMacro` no longer needs
  `currentCallerCaptureInfo` class-level staging state
- formalizing shared-channel cross-template read metadata
- extracting the remaining duplicated async-extends compilation structure
  shared by `compileAsyncExtends(...)` and
  `compileAsyncStaticTemplateExtends(...)`

Leaving these duplications in place *during* Step 11 is intentional. Moving
near-duplicates into the same file first is what makes them cheap to collapse
in Step 12.

### Allowed dependency direction

Step 11 should preserve one-way ownership boundaries:

- `compiler-async.js` and `inheritance.js` may delegate into
  `compiler-extends.js`
- `compiler-extends.js` must not import back into `compiler-async.js`
- `runtime.js` may re-export from `inheritance-bootstrap.js`
- `component.js` may consume `inheritance-bootstrap.js` and
  `inheritance-call.js`
- `inheritance-call.js` and `inheritance-bootstrap.js` must not depend back on
  `runtime.js` as a facade owner
- generic buffer/channel/command primitives stay leaf-like foundations; the
  extracted inheritance modules may use them, but ownership must not invert

### Architectural extraction target

Step 11 should make one architectural seam obvious even if it does not yet
materialize as a single runtime class:

- hierarchy bootstrap/state ownership (`inheritanceState`, shared-root schema
  bootstrap, shared-input preload)
- hierarchy admission ownership (constructor admission, inherited method
  admission, `super()` admission, deferred/stalled admission)
- legacy dynamic-extends compatibility ownership

After extraction, a reader should be able to point to one
inheritance-bootstrap owner and one inheritance-admission owner without
reading through broad generic files to reconstruct the model. Whether that
later becomes an explicit "hierarchy instance" abstraction is a Step 12
cleanup decision, but the ownership boundary should already be visible after
Step 11.

### Target Files

Seven files own the stable extends surface after extraction. Three of them
already exist and are well-scoped; three are new; one (`inheritance.js`) is
trimmed. The remaining broad files keep only genuinely generic machinery.

#### Files that stay as-is

- `src/runtime/inheritance-state.js` — focused runtime state holder for
  ordered method chains and shared-channel schema. No change.
- `src/runtime/component.js` --- `ComponentInstance` class, component command
  classes (`ComponentMethodCallCommand`, `ComponentObserveCommand`,
  `ComponentCloseCommand`), `createComponentInstance`, and the private
  `_resolveComponentBinding` / `_runComponentBindingOperation` /
  `_settleComponentCommandResult` helpers. The class itself does not move,
  but its imports do: it switches from pulling bootstrap helpers from
  `runtime.js` and admission helpers from `call.js` to importing them from
  the new `inheritance-bootstrap.js` and `inheritance-call.js` modules
  directly. This is a mechanical import-path change, not an API change.
- `src/callable-contract.js` — `validateCallableContractCompatibility` and
  `formatCallableContract`. No change.

#### New: `src/compiler/compiler-extends.js`

Owns the root-level extends/constructor codegen currently embedded in
`compiler-async.js` plus the extends-specific helpers currently in
`inheritance.js`.

**Ownership shape.** The module exports a `CompileExtends` helper class
modeled on the existing `this.inheritance` pattern: the main async compiler
holds an instance (e.g. `this.compileExtends = new CompileExtends(this)`),
and the helpers below become methods on that class. The class receives the
parent compiler reference in its constructor and reads compiler state
(`this.compiler.codebuf`, `this.compiler._currentRootExportBufferVar`, etc.)
through that reference rather than being passed into every call. Existing
call sites in `compiler-async.js` and `inheritance.js` change from
`this._emitRootInheritanceBootstrap(...)` to
`this.compileExtends._emitRootInheritanceBootstrap(...)`.

Exact helpers to move:

*From `compiler-async.js`:*

- `_emitRootInheritanceBootstrap(compiledMethods, rootSharedSchema)`
- `_emitRootConstructorAdmission(node, constructorMethod)`
- `_emitAsyncConstructorRootCompletion(node, options)`
- `_compileAsyncScriptConstructorEntry(node, sharedChannelNames, constructorLinkedChannels)`
- `_compileAsyncTemplateConstructorEntry(node, constructorLinkedChannels)`
- `_compileAsyncRootBody(node, ...)` --- the extends-aware branching; the
  no-extends branch stays or is folded into a single path per Step 12D
- `_compileAsyncRoot(node, ...)` --- entry that dispatches to the above

Block compilation (`_compileAsyncBlockEntry`, `_compileAsyncBlockEntries`,
`_emitAsyncBlockInputInitialization`, `_getBlockLocalCaptureNames`) stays
in `compiler-async.js` for Step 11. Blocks are general template
machinery, not extends-specific: a non-extending template still uses
them. They have inheritance touchpoints (block-as-method registration,
local-capture compensation) but moving the whole surface here would pull
generic compilation into an extends-focused module. Step 12 can revisit
this once 12G/12F clarify which seams are actually inheritance-only.

**Explicit non-goal for Step 11:** do not move general block compilation just
because blocks participate in inheritance registration. The extraction target is
extends-specific ownership, not "anything touched by extends".

*From `inheritance.js`:*

- `compileAsyncStaticRootExtends(node, scriptRootNode, rootSharedChannelNames)`
- `compileAsyncStaticTemplateExtends(node)`
- `_emitResolvedParentContinuation(node, templateVar, parentContextVar, rootContextVar, externContextVar, currentBufferExpr, options)`

#### New: `src/runtime/inheritance-call.js`

Owns every extends-specific admission/dispatch helper currently in
`call.js`. The entire `_admit* / _invoke*MethodEntry / _dispatchMethodCall /
callInheritedMethod* / callSuperMethod / admitConstructorEntry` family moves.
Specifically:

*Public entries (remain named exports):*

- `callInheritedMethod`, `callInheritedMethodDetailed`, `callSuperMethod`
- `admitConstructorEntry`

*Internal helpers that move with them:*

- `_hasAsyncMethodArgs`, `_mergePoisonedArgs`, `_validateMethodArgCount`
- `_createMethodInvocationBuffer`, `_finishInvocationBuffer`
- `_createSettledMethodAdmission`, `_createMethodCompletion`,
  `_awaitMethodAdmissionResult`, `_unwrapAdmissionValue`
- `_resolveDispatchedValue`, `_contextualizeRuntimeFatalError`
- `_invokeMethodEntry`, `_invokeImmediateMethodEntry`
- `_admitKnownMethodValue`, `_admitKnownMethodWithTrackedCompletion`,
  `_admitKnownMethodWithBufferCompletion`
- `_admitDirectMethod`, `_admitDirectMethodWithCompletion`,
  `_admitDeferredMethodEntry`, `_enqueueDeferredMethodAdmission`
- `_dispatchMethodCall`

#### New: `src/runtime/inheritance-bootstrap.js`

Owns the shared-root bootstrap helpers currently re-exported from
`runtime.js`. Exact functions:

- `validateSharedInputs(sharedSchema, providedInputNames, operationName)`
- `preloadSharedInputs(sharedSchema, inputValues, currentBuffer, context, pos, operationName)`
- `ensureSharedSchemaChannels(sharedSchema, currentBuffer, context)`
- `bootstrapInheritanceMetadata(inheritanceState, methods, sharedSchema, ownerKey, currentBuffer, context)`
- `ensureCurrentBufferSharedLinks(sharedSchema, currentBuffer)`

`runtime.js` continues to re-export these names so compiled output does not
need to change; the new module is the owner, and the re-exports are a
one-line `const x = require('./inheritance-bootstrap'); module.exports = {
..., ...x };` passthrough.

#### Trimmed: `src/compiler/inheritance.js`

Keeps its role as the statement-level AST dispatcher for the inheritance /
composition family — `compileAsyncImport`, `compileSyncImport`,
`compileAsyncFromImport`, `compileSyncFromImport`, `compileAsyncInclude`,
`compileSyncInclude`, `compileAsyncBlock`, `compileSyncBlock`,
`compileAsyncExtends`, `compileSyncExtends`, `compileAsyncSuper`,
`compileSyncSuper`, plus the
composition-only helpers (`_emitCompositionContextObject`,
`_emitExtendsContextSetup`, `_emitValueImportBinding`,
`_compileAsyncGetTemplateOrScript`, `_emitExplicitExternInputs`,
`_emitImmediateExternInputs`, `_emitNamedInputBindings`,
`_getPositionalSuperArgsNode`).

The extends-specific codegen helpers listed above leave; `inheritance.js`
then calls into `compiler-extends.js` for them.

#### Broad files that keep only generic machinery

- `src/runtime/call.js` — keeps `invokeCallable`, `invokeCallableAsync`,
  `_invokeCallableAsyncComplex`, `_getCallableExecutionContext`, and the
  `callWrap` / `callWrapAsync` compatibility aliases. Everything else moves
  to `inheritance-call.js`.
- `src/runtime/runtime.js` — keeps generic macro/keyword-args/promisify/
  extern-input helpers; re-exports the bootstrap helpers from
  `inheritance-bootstrap.js` for compiled-output compatibility.
- `src/runtime/channel.js` — keeps `declareSharedBufferChannel` (generic
  channel routing with `_sharedRootBoundary` termination).
- `src/runtime/command-buffer.js` — keeps the observation API additions
  (`addSnapshot`, `addRawSnapshot`, `addIsError`, `addGetError`,
  `addCaptureGuardState`, `addRestoreGuardState`, `addSinkRepair`); these
  are generic channel-observation surface, not extends-specific.
- `src/compiler/compiler-async.js` — keeps generic node dispatch and calls
  into `compiler-extends.js` for root/constructor work. Keeps
  `_withRootExportBufferScope`, `_currentRootExportBufferVar`,
  `_emitRootSequenceLockDeclarations`, and `_emitRootExternInitialization`.
  It keeps only thin delegators for extends-specific root finalization and
  compiled-method metadata, and a thin delegator for the dynamic-extends
  legacy root-completion path until Step 12D.
- `src/compiler/compiler-base-async.js` — keeps the component-binding
  emission helpers (`_getComponentBindingFacts`, `_emitComponentCall`,
  `_emitComponentMethodCall`, `_emitComponentObservationCall`,
  `_emitComponentSharedRead`, `_emitComponentCommandPromise`). These are
  intertwined with generic expression/call compilation and would create
  churn if moved without also moving their callers; Step 12 can revisit.
- `src/compiler/macro.js` — keeps caller-capture plumbing in place; Step
  12E removes the `currentCallerCaptureInfo` class-level staging state by
  parameter-threading, but the macro-compilation ownership stays here.

Clarification after the extraction landed:

- `compiler-base-async.js` now delegates component-boundary emission to
  `compiler-component.js`; the new file is the implementation owner for
  component-binding detection, component command emission, and script-side
  component import compilation
- `compiler-async.js` now keeps only thin delegators for extends-specific root
  finalization and compiled-method metadata; `compiler-extends.js` is the
  implementation owner for that surface

Extraction update:

- component-binding detection, component command emission, and script-side
  component import compilation now live in `src/compiler/compiler-component.js`
- extends-specific root finalization and compiled-method metadata ownership now
  live in `src/compiler/compiler-extends.js`; `compiler-async.js` keeps only
  thin delegators for that surface

### No renames during extraction

Step 11 is strictly move-only. Helpers, classes, and module file names keep
their current identifiers when moved into new files. Reasons:

- renaming and moving in the same commit blurs regression bisect: a broken
  test cannot be triaged as "extraction broke it" vs "rename broke it"
  without re-reading the diff in detail
- the admission/dispatch family is rewritten in Step 12B; renaming here
  would force a two-pass rename
- mechanical moves keep call-site churn limited to import paths, so the
  diff stays auditable

Renames happen in Step 12 alongside the simplifications that consolidate
each surface --- naming follows the final shape, not the transitional one.

### Step 11 Order

- **Step 11A** --- analysis/inventory pass. Confirm the file inventory above
  by re-reading the current code; produce a small diff in this doc if
  anything moves into or out of the list. Do not move code yet. This pass
  has explicit authority to **shrink or expand** the planned file split: if a
  target module ends up too thin (e.g., `inheritance-bootstrap.js` turns out to
  be one function's worth of code), fold it back into an existing file; if one
  target module turns out too broad or cuts across unrelated ownership, split
  it further and record the reason in this doc. Extraction is a means, not a
  goal. 11A should also explicitly identify the single remaining owner of the
  dynamic-extends legacy bridge; if that bridge is still scattered after the
  inventory pass, the extraction target is not done yet.

  The Step 11A pass should explicitly produce four short inventories:

  - **ownership inventory** --- every extends/component helper in the current
    broad files is assigned to bootstrap/state ownership, admission/dispatch
    ownership, legacy dynamic-extends compatibility ownership, or "stays
    generic"
  - **legacy-bridge leak inventory** --- enumerate every remaining read/write
    of `asyncExtendsBlocksPromise`, `asyncExtendsBlocksPendingCount`, and
    `__parentTemplate`
  - **admission-surface inventory** --- list the public and internal
    inheritance-admission helpers, their callers, and whether they are fast
    path, deferred path, or constructor-lifecycle-specific
  - **root-finalization inventory** --- list every root-completion shape
    (`return` delivery, text delivery, parent-root handoff) and where each is
    currently emitted

  These inventories do not need to be large design notes. They exist so the
  extraction slices move code along real ownership seams rather than just
  cutting files by rough intuition.
- **Step 11B** --- create `src/runtime/inheritance-bootstrap.js` (unless
  11A collapsed it); move the bootstrap helpers from `runtime.js` into it.
  `runtime.js` keeps re-exporting the names as a **permanent** facade,
  because compiled output accesses these through the runtime object
  (e.g., `runtime.bootstrapInheritanceMetadata(...)`), not through ES
  imports. Smallest slice; lands first to prove the extraction pattern.
- **Step 11C** --- create `src/runtime/inheritance-call.js`; move the
  admission/dispatch family from `call.js` into it. Keep
  `invokeCallable*` and `_getCallableExecutionContext` in `call.js`.
  Update `runtime.js` and any direct importers to reference the new
  module; keep `call.js` export names unchanged where compiled output
  references them.
- **Step 11D** --- create `src/compiler/compiler-extends.js`; move the root
  bootstrap, constructor-entry, and root-extends boundary helpers from
  `compiler-async.js` and `inheritance.js` into the new `CompileExtends`
  class. Both source files keep thin delegation call sites. This is the
  largest slice and should land last so the runtime extractions (which
  compiled output references) are settled first.

Each slice should land on its own commit and keep `npm run test:quick`
green. No slice should try to simplify the code it moves; that is Step
12's job.

**Step 11 exit criterion:** the generic files (`compiler-async.js`,
`inheritance.js`, `call.js`, `runtime.js`) still expose their current
public surface --- compiled output continues to reference the same
runtime names, and direct importers continue to import the same module
paths --- but internally each extracted helper has exactly one
implementation owner. Thin delegation facades are allowed; duplicated
implementations are not.

### Reuse

- reuse the final behavior established in Steps 7-10 without changing user
  semantics
- keep the explicit shared-root / constructor / inheritance-state model exactly
  as stabilized by the earlier steps

### Replace

- replace "post-Step-10 cleanup" as an informal bucket with explicit Step 11
  (extraction) + Step 12 (simplification)
- replace broad-file ownership of stable extends-specific helpers with narrower,
  dedicated module ownership

### Keep

- no new user-facing inheritance behavior
- no semantic redesign of constructor return, block dispatch, or component
  lifetime rules
- duplication that Step 12 will collapse stays in place for now; the goal here
  is visibility, not reduction

### Tests

- rerun the focused inheritance/component/template suites from Steps 7-10 after
  each extraction slice
- keep `npm run test:quick` green before closing each slice

## Step 12 - Simplification Passes

**Goal:** Collapse the layering, duplication, and transitional shapes that the
Step 11 extraction makes visible. This is where the inheritance implementation
actually gets smaller, not just reorganized.

Each sub-step below is behavior-preserving at the user-visible level but
changes internal shapes and may delete substantial code. Land them one at a
time with the focused suites green between each.

### Sub-step dependency map

Substeps are not strictly linear, but some order is forced by real
dependencies:

- **12A -> 12B -> 12C** is still the chain, but 12A is intentionally split
  into two internal slices:
  - first, force the remaining legacy registration bridge behind explicit
    compatibility seams and remove the constructor-known-method tracked
    completion path
  - then let 12B replace the remaining deferred-lookup compatibility seam with
    the real admission command
  This keeps 12A small and behavior-preserving while still making 12B the
  first place where unresolved admission changes shape. Once 12B lands, 12C
  gets the `{ value, completion }` dual shape down to one obvious attachment
  point on the new command class.
- **12F -> 12G** is a chain: making analysis authoritative (12F) is what
  lets the constructor/method collector unification (12G) land without
  reintroducing the raw-AST compensations it is supposed to remove.
  12G also depends on 12D (script/template constructor-entry
  unification) because the merged collector needs one constructor-entry
  shape to attach to.
- **12D and 12E** are independent of each other and of the two chains
  above; they can land in any order once extraction (Step 11) is done.
- **12H** (dynamic-extends redesign) is the only real design decision left
  and should land last so it can assume the cleaned-up admission and
  bootstrap surface.

### Step 12A - Remove `asyncExtendsBlocksPromise` bridge

`asyncExtendsBlocksPromise` is a legacy registration-lifecycle promise used
to gate inheritance lookup on "all parent blocks have registered yet." The
new model uses side-channel admission stalling on the shared root instead,
but the old promise still leaks through both compiler and runtime call sites.
Step 12A therefore starts by collapsing those reads behind explicit
compatibility seams, then removes the constructor-known-method tracked
completion path immediately, and leaves the remaining deferred-lookup seam for
12B's admission-command rewrite.

Work:

- collapse direct compiler/runtime reads of the bridge to one explicit
  compatibility seam per owner:
  - compiler-side dynamic-extends / async-block-registration waiting should go
    through a `Context` helper rather than ad-hoc property reads
  - runtime-side unresolved inherited/shared lookup should go through one
    dedicated compatibility helper rather than each public resolve method
    reading `context.asyncExtendsBlocksPromise` itself
- remove compiler-side static-constructor completion reads of
  `context.asyncExtendsBlocksPromise`; constructor completion should now flow
  through invocation-buffer completion only
- remove `asyncExtendsBlocksPromise` / `asyncExtendsBlocksPendingCount`
  reads from the known-method constructor admission path
- delete `_admitKnownMethodWithTrackedCompletion` in its entirety once no
  caller depends on it
- leave the remaining deferred unresolved-lookup compatibility seam in place
  until 12B provides the real admission-command replacement; do not strand the
  static path between two half-models

12A is the first substep because it simplifies the constructor/known-method
half of the admission family before 12B rewrites the unresolved/deferred half.

12A must also leave the current dynamic-extends behavior intact. If any
unresolved dynamic-extends slice still depends on
`asyncExtendsBlocksPromise`, defer that slice to 12H rather than half-removing
the bridge and letting the dynamic path regress.

Before deleting the bridge entirely, 12A should first force it behind one
explicit compatibility seam. If the promise is still read from multiple
compiler/runtime owners when 12A starts, the first task is to collapse those
reads to one adapter boundary and only then remove the boundary itself. In the
current implementation that means 12A may end with a smaller compatibility
surface still alive for unresolved inherited/shared lookup; 12B is responsible
for deleting that last seam once the admission command exists.

Step 12A was not landed before Step 12 closed. Carried forward to **Step 13F**.

### Step 12B - Collapse the admission surface

With 12A done, and with the real `InheritanceAdmissionCommand` now already
landed, the runtime still exposes multiple public-ish admission entry points
(`admitConstructorEntry`, `admitInheritedMethod`, `callInheritedMethod`,
`callSuperMethod`) and still repeats some inherited-vs-super selection logic
above the two real internal command-entry helpers
(`_admitKnownMethodCommand`, `_admitDeferredMethodCommand`). The architecture
doc promises one admission model; the code should keep converging toward one
obvious selector shape above those two helpers.

Work:

- materialize `InheritanceAdmissionCommand` as a real `Command` class in
  `src/runtime/inheritance-call.js` (the inheritance-specific command
  family belongs next to its admission helpers, not in generic
  `commands.js`; Step 11 established this ownership boundary and 12B
  keeps it) with a concrete `apply()` / `getError()` contract, matching
  the `isObservable` pattern the command buffer iterator already uses
- keep collapsing duplicated inherited/super selector logic so both call
  families route through one shared "pick known vs deferred admission"
  helper instead of each repeating the same immediate/deferred split
- route every constructor entry, inherited call, super call, and component
  method operation through one command instance; component-side observation
  commands are separate (they read channels, not methods)
- reduce the admission helper family to two internal entries: one for the
  known-method fast path (synchronously settled command), one for the
  deferred/stalled path (command that waits on the side-channel load)
- collapse thin single-caller wrappers (`_admitDirectMethod`,
  `_admitDirectMethodWithCompletion`) into their callers
- delete the `callWrap` / `callWrapAsync` compatibility aliases in
  `call.js` once no compiled output references them (confirm by grepping
  generated code for those names); this alias removal is orthogonal, so if
  those names go dead earlier they may be deleted independently of the rest of
  12B
- perf sanity-check: the known-method fast path should not regress against
  a baseline; run the extends microbench or add one if it does not exist

**Command promise contract:** after 12B, the admission command needs one
explicit semantic promise surface. Write it down in code and tests:

- ordinary inherited/super/method admission resolves when the admitted method
  value is ready for the caller
- constructor admission keeps any extra lifecycle timing as explicit command
  state or explicit helper plumbing; it must not reintroduce an ambient second
  promise shape through the public return contract
- if later substeps decide to unify those timings fully, they must preserve
  this written contract or update it in the plan first

`InheritanceAdmissionCommand` is now materialized as a real `Command` class in
`inheritance-call.js` (first work item, done). The admission-surface collapse —
dispatcher tri-function, duplicated selector logic, single-caller wrappers, and
compatibility aliases — is not yet landed. Carried forward to **Step 13F**.

### Step 12C - Retire the `{ value, completion }` dual shape

The dual-shape contract exists so constructor admission can distinguish
"value ready" from "child buffer finished." It forces
`_unwrapAdmissionValue` and `_awaitMethodAdmissionResult` boilerplate at
every call site.

Like 12A, 12C may land in two small slices if that keeps the transition
cleaner:

- first, remove the paired return shape from constructor admission and use the
  `InheritanceAdmissionCommand` object itself as the lifecycle carrier
- then remove any remaining "wait for value and completion together" helper
  once component-side method completion has been moved off the old wrapper

Work:

- fold completion onto the `InheritanceAdmissionCommand`'s own promise
  lifecycle, or carry timing info as a command field rather than a paired
  return type
- for constructor admission specifically, prefer returning the command object
  itself (`.promise` for value timing, `.completion` for lifecycle timing)
  over a synthetic `{ value, completion }` wrapper
- remove `_unwrapAdmissionValue`, `_awaitMethodAdmissionResult`,
  `_createSettledMethodAdmission`, and `_createMethodCompletion` once no
  caller needs them
- update every consumer to the single-promise contract

12C builds on 12B's single admission command; do not attempt before 12B
lands.

Step 12C was not landed before Step 12 closed. Carried forward to **Step 13F**.

### Step 12D - Unify script/template codegen and collapse the root-body branches

Three duplications in the compiler collapse together:

- `compileAsyncStaticRootExtends` vs `compileAsyncStaticTemplateExtends`
  are ~95% identical; differ on shared-vs-extern validation and the
  `allowDynamicRoot` continuation flag
- `_compileAsyncScriptConstructorEntry` vs
  `_compileAsyncTemplateConstructorEntry` duplicate the pre/post-extends
  split logic and compile-pre/compile-post loops
- `_compileAsyncRootBody` has three branches where branch 1
  (script-with-static-extends) and branch 3 (no-extends / static-extends
  template) emit identical code, separated only by a mode check; only
  branch 2 (legacy dynamic-extends) is genuinely different

Like 12A and 12C, 12D may land in smaller compiler-only slices if that keeps
the cleanup honest:

- the shared static-extends async-boundary emitter is now extracted
- the script/template constructor-entry helpers now already share one
  `_compileAsyncConstructorEntry(...)` path
- the remaining work is the bigger sweep: collapse the remaining root-body
  branching and then simplify root finalization by end-state rather than file
  kind

At this point 12D should not be chipped away through isolated wrapper edits.
The remaining compiler duplication is concentrated enough that it is clearer to
land it as one bundled `compiler-extends.js` sweep:

- collapse the remaining root-body split around one "dynamic parent handoff"
  branch versus one normal constructor-admission branch
- then simplify `_emitRootConstructorAdmission(...)` / root finalization around
  explicit end states (`return value`, `return text`, `return current buffer`)
  instead of script-vs-template branching

Work:

- extract one `emitStaticExtendsAsyncBoundary(node, options)` helper
  parameterizing shared-vs-extern validation and dynamic-root
  continuation; both current `compile*StaticRootExtends` paths call it
- extract one shared constructor-entry helper parameterizing return-
  channel handling and inheritance-local-capture snapshotting so the
  script and template constructor-entry paths share one implementation
- collapse branches 1 and 3 of `compileRootBody` into one path; keep the
  dynamic-extends branch as an explicit gated guard until 12H redesigns it
- unify root finalization by **finalization strategy** rather than by source
  kind: the meaningful split is "deliver a return value", "deliver text", or
  "handoff to a parent root", not "script vs template". If separate helpers
  still survive after 12D, each surviving helper should correspond to one of
  those end states rather than to file type

Pure single-caller wrapper inlining (e.g., `emitRootConstructorAdmission`)
should fall out naturally from the above consolidations if the wrapper
no longer adds a semantic concept; if it still does after the big
collapses land, leave it alone. Do not list wrapper-inlining as its own
work item.

The static-extends async-boundary extraction and constructor-entry sharing are
landed. Root-body branching collapse and root-finalization unification are not
yet landed. Carried forward to **Step 13G**.

### Step 12E - Component command consolidation

`src/runtime/component.js` has three command classes
(`ComponentMethodCallCommand`, `ComponentObserveCommand`,
`ComponentCloseCommand`) that share an identical apply→start→settle
pipeline through `_runComponentBindingOperation` and
`_settleComponentCommandResult`. Step 9's deferred-cleanup list called
this out.

Work:

- collapse the three classes toward one `ComponentOperationCommand` with a
  discriminator field (`method` / `observe` / `close`) and operation-
  specific argument marshaling, if the merged class stays clearer than the
  parallel classes — test this on a prototype before committing
- if the merge loses semantic clarity, stop at the shared helpers already
  factored out and keep the three classes
- keep the `ComponentInstance` side-channel class intact; this step is
  about command-class plumbing, not the side-channel contract
- keep driving the file toward the smallest honest surface that still matches
  the model: one instance object, one side-channel contract, and the minimum
  operation-command plumbing needed to express method / observe / close

**Success criterion:** land the merged command only if one class plus its
discriminator branches is easier to read than the current three-class split. If
the merge merely trades duplicated files for one switch-heavy class, keep the
three commands and stop after shared-helper cleanup.

This merge is now effectively landed: the file uses one
`ComponentOperationCommand` plus operation-specific branches, while
`ComponentInstance` remains the side-channel owner. Remaining 12E cleanup, if
any, is only to simplify that merged command further without reintroducing
parallel command classes.

### Step 12F - Make analysis authoritative

- make `usedChannels` analysis authoritative for block body symbols so
  `_getBlockLocalCaptureNames` no longer needs its raw
  `findAll(nodes.Symbol)` compensation walk
- make root `extern` fallback dependency validation read analyzed symbol
  metadata rather than doing its own raw AST symbol scan during codegen-time
  validation
- formalize the compiler-side `linkedChannels` emission contract so
  helpers do not accept a silent string-or-array dual type; pick one
  shape (string/JSON) and enforce it at call sites
- move imported-call boundary linked-channel narrowing onto analysis or
  other explicit metadata so compiler emission no longer reconstructs it
  ad hoc from argument trees
- keep macro caller-capture threading on explicit parameters rather than
  class-level staging state; the old `currentCallerCaptureInfo` shape is
  already gone, so any remaining cleanup here should preserve the current
  parameter-threaded model
- formalize shared-channel cross-template read metadata so lookup does
  not rely on ad-hoc private flags as an implicit multi-file contract
- keep exported-macro rebinding centralized so macro metadata does not
  get copied piecemeal across multiple wrapper sites

The analyzed-symbol dependency and linked-channel centralization work is now
partly landed:

- root `extern` fallback validation reads analyzed dependency metadata
- imported-call boundary linked channels are derived during analysis rather than
  reconstructed during emission
- compiled method/block linked-channel collection and ordinary boundary
  emission now share the same analysis-owned linked-channel selector

`runtime.js` keeps its bootstrap-helper re-exports as a permanent facade:
compiled output reaches these helpers through the runtime object
(`runtime.bootstrapInheritanceMetadata(...)`, etc.), not through ES
imports, so removing the re-exports would require regenerating every
compiled file in existence. The re-exports are the public surface; the
new module is just the owner.

### Step 12G - Unify constructor and method linked-channel analysis

The architecture doc ([extends-next.md § Constructors](extends-next.md))
says "Constructor admission and ordinary method admission therefore share
one runtime model, but they do not yet have to share one compile-time
linked-channel analysis pass... That unification is cleanup work for a
later step." This is that step.

Work:

- merge the constructor linked-channel collector with the ordinary method
  linked-channel collector; both flow through method metadata, so one
  pass with mode-aware handling should suffice
- keep top-level-flow concerns (pre/post-`extends` ordering,
  constructor-local non-shared channels) as mode parameters on the shared
  collector, not as a reason to keep two collectors
- update `CompileBuffer` / analysis to expose one channel-collection
  surface

This is now mostly reduced to follow-through cleanup rather than a separate
design task: constructor metadata, block metadata, and ordinary boundary
emission all read the same analysis-owned linked-channel selection helper. The
remaining 12G work is to remove any last ad-hoc callers if new ones are found,
not to invent a new collector shape.

This step depends on 12D (script/template constructor-entry unification)
because the merged collector needs one constructor-entry shape to attach
to, and on 12F (analysis authoritative) because collapsing two collectors
onto one pass is only safe once analysis is the single source of truth for
channel membership — otherwise the merged collector inherits ad-hoc
compensations from both sides.

### Step 12H - Dynamic-extends redesign

Static-extends is the supported inheritance model. Dynamic-extends
(parent path computed at runtime) currently runs on a separate
compilation path with its own `__parentTemplate` channel plumbing and
block-registration lifecycle. After 12A, the legacy bridge is gone, but
the dynamic-extends compilation path itself still exists in parallel
with the new static path.

This step is a **design decision point**, not a mechanical cleanup. Both
options preserve the current user-visible dynamic-extends contract; Step
12H is a cleanup step, not the place to introduce a breaking change.
Retiring dynamic extends as a feature is a separate product decision and
belongs in its own plan if that decision is made. Pick one of the
following and commit to it:

- **Option A --- redesign onto the static admission path.** Dynamic-extends
  becomes "late-resolved static extends": at runtime, when the parent path
  resolves, register its methods/shared schema into `inheritanceState` and
  fire the side-channel admission the same way static extends does. The
  dynamic path loses its separate compilation shape entirely. Biggest
  simplification; biggest risk of user-visible timing changes.
- **Option B --- adapter shim.** Keep a dynamic-extends compile path but
  translate to the `InheritanceAdmissionCommand` at the runtime boundary.
  Preserves the dynamic-extends behavior contract; removes only the
  parallel admission plumbing.

Step 12 adopts **Option B**. That keeps the current dynamic-extends user
contract stable while still removing the last parallel compatibility path.
Revisit Option A only after the adapter-shim path has been stable for at
least one release cycle.

Land 12H in small slices:

- **12H1:** isolate the legacy dynamic-extends compile/runtime bridge
  behind explicit helpers in the current owners (`compiler-extends`,
  `inheritance`, and runtime inheritance helpers). This is a code-shape
  cleanup only; no behavior change yet.
- **12H2a:** route dynamic root-completion parent constructor startup
  through the same runtime admission surface as static extends instead
  of the current bespoke root handoff path.
- **12H2b:** route the resolved-parent continuation used by the async
  extends boundary through that same admission surface so dynamic parent
  constructor startup no longer depends on a separate direct root
  handoff helper.
- **12H3a:** rename and centralize the remaining
  `asyncExtendsBlockRegistration` wait semantics behind explicit
  inheritance-resolution helpers on the owning context/runtime path, and
  migrate inherited-method/shared-channel/block lookup callers onto that
  explicit surface.
- **12H3b:** delete the last open-coded dynamic-bridge lookup plumbing
  that only exists because callers still reach around those explicit
  helpers, keeping the adapter shim isolated to the minimum remaining
  `__parentTemplate` seam.

The first 12H1 reduction is now landed:

- compiler-emitted registration waits now go through the runtime inheritance
  facade (`runtime.beginInheritanceResolution(...)`,
  `runtime.finishInheritanceResolution(...)`,
  `runtime.getRegisteredAsyncBlock(...)`,
  `runtime.bridgeDynamicParentTemplate(...)`) instead of reaching directly into
  `Context` registration bookkeeping from multiple compiler sites
- runtime unresolved inherited/shared lookup now also reads the same
  registration wait surface through the inheritance runtime owner rather than
  directly probing `Context` from each caller

That leaves the remaining 12H work focused on reducing the compile-time dynamic
parent handoff shape itself, not on who owns the registration bridge.

The larger 12H reduction is now also landed:

- parent constructor startup no longer branches inline in the compiler between
  "call parent root in composition mode" and "bootstrap + admit constructor";
  that decision now lives behind the runtime inheritance helper surface
- top-level dynamic block dispatch no longer open-codes `__parentTemplate`
  lookup and registration waiting in compiler emission; it routes through the
  runtime inheritance bridge

At this point the dynamic-extends adapter is reduced to the explicit minimal
`__parentTemplate` seam:

- compiler-owned storage of the late parent template value
- compiler-owned root-completion lookup of that stored parent template
- runtime-owned registration waits, top-level block dispatch, and parent
  constructor startup

Treat that as the Step 12 end state for Option B. Any further reduction should
either be a small post-Step-12 cleanup on this explicit adapter seam or a
future Option A redesign, not more transitional compatibility plumbing.

## Step 13 - Post-Step-12 Simplification and Redesign

**Goal:** Keep Step 12 closed, preserve its Option B behavior contract, and
separate low-risk cleanup from any larger inheritance redesign.

Step 12 intentionally stopped at the narrow explicit dynamic seam:

- compiler-owned storage of the late parent template value
- compiler-owned root-completion lookup of that stored parent template
- runtime-owned registration waits, top-level block dispatch, and parent
  constructor startup

Step 13 picks up only the work that is still valuable after that end state.
Do not reopen Step 12 for these. Anything here either trims the remaining
adapter seam further without changing behavior, or replaces that seam with a
new architecture under an explicit new step.

Land Step 13 in two tracks:

- **Track A --- safe Option B cleanup.** Keep the current dynamic-extends
  behavior contract and reduce residual seam complexity.
- **Track B --- Option A redesign.** Replace the dynamic adapter shape with
  "late-resolved static extends" only when we are ready to re-verify timing and
  concurrency behavior as a fresh architectural change.

### Step 13A - Audit and minimize the `__parentTemplate` seam

The remaining Option B seam is intentionally small, but it is still explicit.
Start by auditing whether any part of it is now only historical layering rather
than a real behavior boundary.

- inventory every remaining read/write of `__parentTemplate`
- confirm whether compiler-owned root-completion lookup is still the narrowest
  correct owner, or whether a single runtime helper can own that lookup without
  reintroducing dual-shape completion or hidden timing changes
- remove stale comments, names, and helper boundaries that still describe the
  pre-Step-12 bridge model
- keep the dynamic parent handoff explicit; do not spread new reads/writes of
  `__parentTemplate` back into generic compiler/runtime files

Success for 13A is not "eliminate `__parentTemplate` at all costs." Success is
that the seam is either reduced further or documented as the minimal stable
Option B boundary.

### Step 13B - Tighten inheritance-resolution ownership

Step 12 centralized inheritance-resolution waits behind runtime helpers, but
the underlying bookkeeping still lives on `Context`. Step 13 should evaluate
whether that is now the correct long-term ownership boundary or merely an
intermediate hosting location.

- review `beginInheritanceResolution`, `finishInheritanceResolution`,
  `awaitInheritanceResolution`, and registered-block lookup as one lifecycle
- decide whether the lifecycle should stay as `Context` primitives wrapped by
  runtime helpers, or move behind a more explicit inheritance-state/registration
  owner
- if the ownership stays on `Context`, simplify naming and comments so it reads
  as a deliberate inheritance-registration surface rather than legacy async
  extends bookkeeping
- if the ownership moves, preserve the same temporal guarantees: no inherited
  block/method/shared lookup may observe partially registered ancestry

This step is about ownership clarity, not behavior change. Do not split the
registration lifecycle across multiple owners again.

### Step 13C - Finish the broad-file cleanup pass

Step 11 extracted the main ownership boundaries and Step 12 collapsed the
transitional logic. There may still be low-signal extends-specific residue in
the broad compiler/runtime facades.

- re-audit `src/compiler/compiler-async.js`,
  `src/compiler/compiler-base-async.js`, `src/compiler/inheritance.js`,
  `src/runtime/runtime.js`, and `src/runtime/call.js`
- remove thin delegates, comments, and helper branches that no longer carry a
  distinct non-extends role
- keep one-way ownership: broad facades may export the extends-specific helpers,
  but extends-specific modules must remain the semantic owners
- prefer deleting dead wrapper shape over inventing a new abstraction layer

This is the right place for any final "why is this still here?" cleanup we find
after the Step 12 landing.

### Step 13D - Option A redesign decision and landing plan

If we want a bigger simplification than Track A can provide, treat it as a new
architectural change rather than incremental cleanup.

Option A means dynamic extends stops being a separate compile/runtime shape and
becomes "late-resolved static extends":

- when the parent template resolves, runtime registers the parent into the same
  inheritance admission path used by static extends
- dynamic parent constructor startup uses the same admission lifecycle as static
  extends
- top-level block dispatch no longer depends on a separate dynamic adapter seam

This is the largest remaining simplification opportunity, but it carries real
risk:

- root-completion timing may shift
- inherited lookup timing may shift
- constructor/block dispatch interactions must still respect Cascada temporal
  concurrency guarantees

Do not land 13D as a hidden cleanup. Treat it as a design choice with explicit
behavior-parity verification.

### Step 13E - Contract cleanup discovered during 13A-13D

If new cleanup opportunities appear while working the steps above, classify
them before landing them:

- if the change preserves the current Option B behavior contract and only
  reduces seam complexity, it belongs in 13A-13C
- if the change alters the dynamic-extends execution model, inheritance
  admission timing, or root-completion timing, it belongs in 13D or a later
  dedicated step

Do not rebuild a mixed "misc cleanup" bucket. Keep the distinction between
safe cleanup and architectural change explicit.

### Step 13F — Carry forward: admission bridge, surface collapse, dual-shape retirement

Steps 12A, 12B (admission-surface collapse beyond command materialization), and
12C were not landed before Step 12 closed. Land them in the same order as
originally planned — bridge first, collapse second, dual-shape third — so each
substep builds a stable base for the next.

**13F1 — Remove `asyncExtendsBlocksPromise` bridge (Step 12A)**

Follow the Step 12A work specification:

- collapse compiler and runtime reads of the bridge to one explicit
  compatibility seam per owner; only then remove the seam itself
- remove compiler-side static-constructor completion reads; those now flow
  through invocation-buffer completion only
- delete `_admitKnownMethodWithTrackedCompletion` if any caller still depends
  on it
- leave any unresolved dynamic-extends bridge slice for 13A/13J rather than
  half-removing the bridge and stranding the dynamic path between two
  half-models

**13F2 — Collapse the admission helper family (Step 12B, remaining)**

`InheritanceAdmissionCommand` is already materialized. The remaining collapse:

- merge `_admitKnownMethodCommand`, `_admitDeferredMethodCommand`, and
  `_admitMethodCommand` into one internal function: one calling convention,
  two internal paths (known vs deferred), no dispatcher layer above them
- delete `callWrap`/`callWrapAsync` compatibility aliases in `call.js` if any
  survive
- perf sanity-check: known-method fast path must not regress; run the extends
  microbench or add one if it does not exist

**13F3 — Retire `{ value, completion }` dual shape (Step 12C)**

- fold completion tracking onto `InheritanceAdmissionCommand.completion` as a
  first-class command field; constructor admission callers use the command
  object directly rather than a `{ value, completion }` wrapper
- remove `_unwrapAdmissionValue`, `_awaitMethodAdmissionResult`,
  `_createSettledMethodAdmission`, and `_createMethodCompletion` once no
  caller needs them
- add explicit regression coverage for constructor completion timing — the
  scenarios the dual shape guarded (value-ready vs child-buffer-finished) must
  still hold on the collapsed contract

### Step 13G — Carry forward: collapse root-body branching (Step 12D, remaining)

The static-extends async-boundary extraction and constructor-entry sharing
landed in Step 12D. The remaining work:

- collapse the remaining branches in `_compileAsyncRootBody` around one
  explicit "dynamic-parent handoff" guard versus one normal
  constructor-admission path; only the dynamic-parent guard stays conditional
  until Step 13D/Option A
- unify root finalization by end state (`return value`, `return text`,
  `return current buffer`) rather than by script-vs-template branching; each
  surviving emitter helper should correspond to one of those end states, not
  to a source kind

### Step 13H — Resolve compiler class cross-ownership

`CompileExtends` (`compiler-extends.js`) and `CompileInheritance`
(`inheritance.js`) call into each other for extends-related helpers:

- `compiler-extends.js` calls `this.compiler.inheritance._emitExtendsContextSetup()`
  and `this.compiler.inheritance._compileAsyncGetTemplateOrScript()` — both
  are extends-path helpers living in the wrong class
- `inheritance.js` calls `this.compiler.extendsCompiler.emitDynamicTopLevelBlockResolution()`
  and `this.compiler.extendsCompiler.compileAsyncDynamicTemplateExtends()` —
  both reached across the class boundary from a non-extends dispatch site

Neither class is the authority for the extends path. This is the structural
consequence of Step 11D landing the move without settling shared-helper
ownership.

Work:

- move `_emitExtendsContextSetup` and `_compileAsyncGetTemplateOrScript` from
  `CompileInheritance` into `CompileExtends`; update all call sites in
  `compiler-extends.js` to use `this.*` directly
- `CompileInheritance` retains only non-extends template composition: include,
  import, fromimport, block, super, extern helpers
- the two reverse calls from `inheritance.js` into `extendsCompiler`
  (`emitDynamicTopLevelBlockResolution`, `compileAsyncDynamicTemplateExtends`)
  should move to caller-side sites in `compiler-extends.js` or the dispatch
  site in `compiler-async.js` that triggers them; evaluate after Step 13G
  lands whether the dynamic-extends boundary in `inheritance.js` can be
  eliminated entirely

**Success criterion:** no method on `CompileExtends` calls
`this.compiler.inheritance.*` for an extends-specific helper, and no method
on `CompileInheritance` calls `this.compiler.extendsCompiler.*`.

### Step 13I — Replace `_compileAsyncConstructorEntry` options bag with explicit functions

`_compileAsyncConstructorEntry(node, opts)` accepts a 7-field options bag
including function callbacks (`emitEntrySetup`, `emitBeforeStaticExtends`,
`emitStaticExtends`, `emitAfterBody`). Its two callers —
`_compileAsyncScriptConstructorEntry` and
`_compileAsyncTemplateConstructorEntry` — are already thin wrappers. Neither
caller is self-contained; a reader must trace through the options bag and the
base implementation to understand either path.

Work:

- identify the shared body (~25 lines: `_withRootExportBufferScope` wrapper,
  sequence-lock declarations, extern initialization, pre/post-extends child
  split loop, outcome emission)
- delete `_compileAsyncConstructorEntry`; copy those shared lines into each
  concrete function directly
- if the pre/post-extends loop logic is byte-for-byte identical, extract it as
  one small private utility with no callback arguments; otherwise duplicate
  and keep each path readable in isolation
- no function callbacks in the resulting concrete functions

**Success criterion:** `_compileAsyncConstructorEntry` no longer exists. Each
concrete entry function is a linear function with no callback arguments.

### Step 13J — Split `startParentConstructor` on its behavioral boundary

`startParentConstructor` in `src/runtime/inheritance-call.js` branches at the
top on `parentTemplate.hasDynamicExtends`. The two branches do structurally
different things:

- **static path:** bootstrap metadata, ensure shared links, admit constructor
  entry
- **dynamic path:** call `rootRenderFunc` in composition mode, extract buffer
  finish promise

The compiler already knows which path to take at compile time. The runtime
function should not branch on a compile-time decision.

Work:

- split into `_startStaticParentConstructor` and
  `_startDynamicParentConstructor` (or equivalent names expressing the intent)
- update the compiler call sites so each emits a call to the appropriate
  function directly
- if `startParentConstructor` is a public runtime surface referenced by
  compiled output, keep the name as a thin dispatch shell until compiled output
  is regenerated; the shell itself is then trivial and documents the split

### Step 13K — Make `ComponentCommand` extend `Command`

`ComponentCommand` in `src/runtime/component.js` manually manages its own
promise lifecycle (`this.promise = new Promise(...)`, `this.resolve`,
`this.reject`, `resolveResult`, `rejectResult`). `InheritanceAdmissionCommand`
gets the same plumbing free from the `Command` base class via
`withDeferredResult: true`.

Work:

- make `ComponentCommand` extend `Command` with
  `super({ withDeferredResult: true })`
- remove the manual promise/resolve/reject body from `ComponentCommand`
- confirm the `close` operation path (where no deferred result is needed) still
  works via the `Command` base class discriminator
- `ComponentOperationCommand extends ComponentCommand` inherits through; verify
  it does not re-add manual promise plumbing

### Step 13L — Remove redundant settlement tracking in `InheritanceAdmissionCommand`

This step depends on **13F3** (dual-shape retirement). Once no caller forces a
synchronous settled-value shortcut, the five internal settlement fields can be
removed.

`_applyStarted`, `_applyPromise`, `_settled`, `_settledRejected`,
`_settledValue`, and `getValueResult()` exist to return a synchronous value
when the command has already settled synchronously. The `Command` base class
already exposes `this.promise`; once resolved, awaiting it costs one microtask
and no extra infrastructure.

Work:

- remove `_settled`, `_settledRejected`, `_settledValue`, and
  `getValueResult()` from `InheritanceAdmissionCommand`
- callers that previously used `getValueResult()` switch to `this.promise`
  (already resolved at that point; settles on the next microtask)
- evaluate whether `_applyStarted` / `_applyPromise` are still needed for
  idempotent `apply()` protection, or whether the `Command` base class already
  guards this; remove what is not needed
- if profiling later shows the synchronous shortcut measurably matters on a
  real workload, re-add it as an isolated optimization with a comment — not as
  permanent structural state on the class

### Step 13 Tests

- rerun focused inheritance/component/template suites after each sub-step
- add targeted regression coverage for any ownership move in inheritance
  registration bookkeeping
- if 13A changes the `__parentTemplate` seam, add coverage for dynamic parent
  resolution, top-level dynamic block dispatch, and constructor completion
  timing on that seam
- if 13D is attempted, treat it like a fresh inheritance redesign and rerun the
  full Step 7-12 parity coverage before considering the change stable
- keep `npm run test:quick` green before closing each Step 13 sub-step

### Reuse

- reuse the file layout and ownership boundaries established by Step 11
- reuse the final user-visible behavior from Steps 7-10

### Replace

- replace the N-variant admission surface with one admission command plus
  two internal paths
- replace the `{ value, completion }` paired return type with a single
  completion promise
- replace parallel script/template codegen with parameterized helpers
- replace the dynamic-extends parallel implementation per 12H decision

### Keep

- no new user-facing inheritance behavior
- no semantic redesign of constructor return, block dispatch, or component
  lifetime rules
- test suites from Steps 7-10 must stay green after each sub-step

### Tests

- rerun the focused inheritance/component/template suites from Steps 7-10
  after each sub-step
- **12B:** add a targeted test that proves `InheritanceAdmissionCommand`
  is a real observable command on the shared root (apply/getError
  contract, buffer-iterator visit), not just an implicit code path
- **12C:** add explicit regression coverage for constructor completion
  timing — the scenarios the dual shape guarded (value-ready vs
  child-buffer-finished) must still hold on the collapsed single-promise
  contract
- **12E:** if component command classes merge, add coverage confirming
  poison propagation, close-on-owner-buffer-complete, and per-call child
  buffer isolation still hold under the merged shape
- **12F:** verify block/method analysis produces identical linked-channel
  emission for script and template paths
- **12H:** behavior-parity tests for whichever option is chosen
- keep `npm run test:quick` green before closing each sub-step

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
