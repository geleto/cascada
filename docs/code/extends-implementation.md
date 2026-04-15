# `extends-next` Implementation Plan

## Overview

This plan implements the inheritance architecture described in
`docs/code/extends-next.md`.

The design has five core runtime pieces:

1. shared root-owned channels
2. root-buffer constructor chaining for `extends`
3. inheritance state with upfront method metadata and ordered method chains
4. explicit inherited dispatch via `this.method(...)` and `super()`
5. namespace instances built from one long-lived buffer plus a side-channel

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
- on the new static inheritance / namespace-instantiation path, `with { }`
  preloads declared `shared` names only
- unknown `with` keys on that new path are an error
- `extern` remains the mechanism for ordinary composition paths, not the new
  static inheritance path
- namespace semantics apply only to the direct binding introduced by
  `import ... as ns`; aliasing/passing/returning that value is out of scope for
  the first implementation

Implementation rule for every step:

- say what existing machinery is reused
- say what static-extends / namespace path replaces
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

**Goal:** Compile shared declarations as one root-owned channel per shared name.

### Semantics

- `shared var x = value` uses initialize-if-not-set
- `shared var x` declares participation without a default
- `shared sequence db = sinkExpr` initializes the shared sequence
- `shared sequence db` declares participation without an initializer

### Main work

- record shared-channel schema on the compiled file
- add a declaration-time runtime helper that resolves the instance root from the
  current buffer and binds shared declarations there
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

- extend declaration compilation so shared declarations bind to the root-owned
  channel instead of declaring a local channel in the current buffer
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
  descendant shared-var defaults beat ancestor defaults until Step 3/4 make the
  full inheritance path available
- the true preloaded-value / `with { x: 99 }` integration case lands with Step
  4 bootstrap

## Step 3 - Root-Buffer Constructor Chaining

**Goal:** Make `extends` run parent constructors in nested child buffers under
the most-derived root buffer.

### Async-boundary contract

For this step, static script `extends` should behave like other async
control-flow boundaries:

- reserve the child buffer at the `extends` site immediately
- wait only for parent template/script resolution and loading
- once loaded, emit the parent constructor chain into that child buffer
- keep emitting post-`extends` code into the current buffer without waiting for
  the child buffer to finish applying

Constructor ordering then comes from the ordinary hierarchical command-buffer
iterator, not from an explicit apply barrier.

### Runtime shape

- C owns the root buffer
- B runs in a child buffer created at C's `extends` site
- A runs in a child buffer created at B's `extends` site
- post-extends code is emitted immediately after the `extends` site into the
  current buffer

### Main work

- rewrite async `extends` compilation around child buffers at the `extends` site
- lower static script `extends` through the same structural child-buffer
  boundary pattern used by async `if` / loop control-flow
- reserve the child buffer synchronously at the `extends` site before parent
  loading resolves
- move parent loading/wiring into that child-buffer callback
- emit post-`extends` code normally in the current buffer after the boundary
  call without awaiting child apply-completion
- update async root completion so composition mode returns the root buffer
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
  land that deletion only together with the replacement path used by static
  async templates
- retire static-path extends-composition state that only exists to support the
  old parent-handoff model: `extendsCompositionByParent`,
  `setExtendsComposition()`, `getExtendsComposition()`, and
  `forkForComposition()` at the static `extends` boundary; this cleanup is part
  of the target direction but is not fully landed yet while the current Step 3
  implementation still reuses parts of the existing composition context path
- replace the old static `extends` handoff with an ordinary structural
  child-buffer boundary instead of adding a new apply-complete runtime concept

### Keep

- keep `getFinishedPromise()` for scheduling-complete use cases unrelated to the
  static script `extends` boundary
- keep dynamic-extends machinery alive for the dynamic path until that path is
  redesigned explicitly
- keep the existing sync path unchanged unless a later step explicitly widens
  scope

### Tests

`tests/pasync/extends.js`

- constructor order is `pre-C`, `pre-B`, `A`, `post-B`, `post-C`
- shared state written in descendant pre-extends code is visible to ancestors
- static script `extends` lowers through a structural child-buffer boundary
- post-extends output stays after parent output through normal buffer-tree
  ordering, not an explicit apply wait
- multiple top-level script `extends` declarations are rejected clearly

## Step 4 - Inheritance State Bootstrap

**Goal:** Expose child-owned method metadata up front and create inheritance
state before that child's constructor code relies on inherited dispatch.

### Bootstrap responsibilities

1. compile a file before reading that file's inheritance metadata
2. expose a `methods` map on the compiled file
3. create inheritance state at child root start
4. register child methods immediately in child-first chains
5. register shared-channel schema on the root buffer
6. preload `with { }` values into shared state for namespace-instantiation
   cases that use `with { }`

### Main work

- emit upfront method metadata for each compiled file:
  `{ fn, contract, ownerKey }`
- create inheritance state on `context` for the near-term steps
- register the child file's methods immediately at root start, before its own
  constructor flow continues
- parent methods are not required to be present yet; they register later when
  the structural `extends` load boundary resolves
- validate `with { }` keys for the new static inheritance / namespace path
  against declared shared schema, and preload only declared shared names
- keep the current structural `extends` load boundary from Step 3; this step
  only prepares inheritance state and metadata

### Main files

- compiler metadata emission for compiled files
- `src/environment/context.js`
- root-start inheritance bootstrap path

### Reuse

- keep `template.compile()` / `script.compile()` as the way to materialize
  compiled metadata before bootstrap reads it
- keep child-first constructor execution from Step 3
- keep `shared` root-channel routing from Step 2

### Replace

- replace the idea that inherited methods must be discovered implicitly from
  ordinary script/global lookup
- replace "winning override only" thinking with ordered per-method chains

### Keep

- keep inheritance state on `context` for this step
- keep block/method entry function signatures unchanged for this step
- keep dynamic-extends machinery separate; this step is for the new static path

### Tests

`tests/pasync/extends.js`

- compiled files expose `methods` metadata up front
- child methods register before child constructor code relies on them
- parent methods register later when the `extends` load boundary resolves
- `with { }` preload is visible to ancestor constructor code
- shared schema is registered before constructor work begins

## Step 5 - Explicit Inherited Dispatch

**Goal:** Implement `this.method(...)` and `super()` using deferred method
slots backed by ordered per-method chains.

### Dispatch rules

- `this.method(args)` is the only inherited-dispatch syntax
- bare `foo()` never participates in inheritance lookup
- `this.method` without a call is invalid in the first implementation
- `super()` uses the same deferred-slot mechanism
- method calls may resolve immediately or later; promise transparency is normal
  Cascada behavior, not a special inheritance exception

### Runtime model

- inheritance state stores `name -> [{ fn, contract, ownerKey }, ...]` in
  child-first order
- `this.method(...)` resolves to the first entry in that chain
- `super()` resolves to the next entry after the current method's `ownerKey`
- parent methods register later, when the `extends` load boundary resolves
- if a needed method is not registered yet, only that call site waits

### Main work

- reserve explicit AST / transpiler support for `this.method(...)`
- reject unsupported `this.name` non-call forms
- compile `this.method(...)` to a runtime inherited-dispatch helper
- compile `super()` to a runtime super-dispatch helper using current method name
  plus current `ownerKey`
- register parent methods into inheritance state when the `extends` load
  boundary resolves
- report a clear error if the chain finishes loading and an inherited method is
  still missing

### Main files

- script transpiler / parser support for `this.method(...)`
- async compiler call lowering
- runtime inherited-dispatch helpers
- `src/environment/context.js`

### Reuse

- keep the ordered structural child-buffer `extends` boundary from Step 3
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

- `this.method(...)` can call a child-defined override before the parent chain
  has finished loading
- post-`extends` `this.method(...)` waits only at the call site, not by
  stalling the whole constructor flow
- `super()` resolves to the next method after the current `ownerKey`
- missing inherited methods fail clearly after the chain has finished loading

## Step 6 - Inheritance State Signature Cleanup

**Goal:** Move inheritance state off `context` and into an explicit runtime
argument once the semantics are stable.

### Main work

- introduce an explicit `inheritanceState` runtime parameter for root and
  method/block entrypoints that need inherited dispatch
- thread that parameter through `extends`, method dispatch, and `super()` call
  paths
- remove the temporary static-path inheritance-state storage from `context`
- keep `context` focused on render/global/extern lookup rather than inheritance
  dispatch state
- keep inheritance state as a plain data object only while it remains mostly
  storage plus trivial lookup
- if inheritance state starts owning substantial behavior, validation,
  deferred-slot lifecycle, chain mutation, or dispatch helpers, promote it to a
  dedicated `InheritanceState` class in this step rather than leaving complex
  behavior split across `Context`, runtime helpers, and an unstructured object
- consolidate the new inheritance / extends runtime helpers behind a dedicated
  module or class boundary in this step rather than leaving metadata shaping,
  chain registration, deferred-slot handling, and dispatch support scattered
  across `Context`, `Template`, and unrelated runtime helpers
- consolidate compiler-side inheritance / extends lowering behind a dedicated
  compiler module boundary in this step rather than leaving dispatch emission,
  bootstrap threading, and signature plumbing scattered across unrelated
  compiler files

### Main files

- root/method entry function signatures
- compiler call-site threading for inherited dispatch
- compiler inheritance / extends helper module
- `src/environment/context.js`
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

## Step 7 - Constructor Return Rules

**Goal:** Implement the simplified return model.

### Rules

- only the entry file's explicit `return` counts in direct render
- ancestor constructor returns are ignored
- namespace import ignores constructor return
- async templates follow the same inheritance model without constructor returns

### Main work

- most of the runtime effect of this step should fall out of Step 3, because
  removing the static parent handoff also removes the old path by which an
  ancestor constructor became the outer final result
- keep explicit return handling rooted in the entry render only
- make ancestor constructor returns non-final in composition/inheritance mode
- ensure namespace import always yields the namespace object

### Main files

- `src/compiler/compiler-async.js`
- return-handling paths for script render and composition render

### Reuse

- keep the existing top-level entry render as the only place that finalizes the
  direct-render result

### Replace / simplify

- do not introduce a hierarchy-wide return-slot or ancestor-priority system
- after Step 3, verify whether any remaining ancestor-return finalization logic
  still exists; only patch the leftover cases

### Keep

- namespace import still produces the namespace object
- template renders stay on their normal text-result path

### Tests

`tests/pasync/extends-return.js`

- if C returns explicitly, that value is the direct-render result
- if only A returns explicitly and C does not, A's return is ignored
- namespace import still yields the namespace object when constructor code
  contains an explicit `return`

## Step 8 - Namespace Instances

**Goal:** Implement namespace instances as one long-lived namespace buffer plus
one side-channel.

The side-channel is a runtime object owned by the namespace instance. It accepts
namespace operations from caller code, immediately enqueues the corresponding
namespace command or per-call child buffer into the namespace buffer tree, and
returns the resulting promise to the caller.

### Creation

- `import "C.script" as ns with { ... }` creates one long-lived namespace buffer
  as a child of the caller buffer
- bootstrap creates inheritance state, registers child-owned method metadata,
  and builds the shared schema
- constructor execution runs immediately into that namespace buffer
- the caller receives a namespace object bound to `ns`

### Namespace object semantics

- `ns.method(args)` compiles to a namespace-side call path
- `shared var` reads compile as namespace shared-value reads
- `shared text`, `shared data`, and `shared sequence` observations compile as
  namespace-side observation commands
- `.snapshot()`, `.isError()`, and `.getError()` remain current-buffer
  observations, not JS method calls on stored objects

Shared-var reads therefore use the same namespace-side operation path as other
namespace operations, not a plain JS object field read.

The compiler therefore needs explicit namespace-binding tracking so it can
distinguish `ns.method()` and `ns.state.snapshot()` from ordinary member access
on non-namespace values.

This requires a new typed namespace-binding structure parallel to the existing
`importedBindings` Set. The current Set/boolean imported-callable tracking is
not enough to distinguish namespace instances from ordinary imported bindings.

First implementation restriction:

- namespace semantics apply only to the direct binding introduced by
  `import ... as ns`
- aliasing, passing, or returning that binding is out of scope
- compile only direct syntactic uses such as `ns.method()`, `ns.x`,
  `ns.log.snapshot()`, `ns.db.isError()`, and `ns.db.getError()` to the
  namespace-side path

### Side-channel semantics

- side-channel `apply()` runs immediately
- it does not wait for argument resolution first
- `ns.method(args)` immediately creates one child buffer under the namespace
  buffer and calls the method immediately
- shared observations are immediately added into the namespace buffer
- the side-channel returns the resulting method/observation promise directly

Caller expressions such as `var result = ns.method(args)` therefore compile to a
namespace-side command path whose returned promise becomes the value of the
expression in the ordinary Cascada way.

### Lifetime

- the side-channel is owned by the caller buffer that owns the `ns` binding
- constructor startup does not finish the namespace buffer
- later method calls and observations keep appending through the side-channel
  while that caller buffer is still being applied
- once the owning caller buffer finishes applying, no new namespace operations
  can arrive from that scope or any of its async children
- close the side-channel from the owning caller buffer's normal structural
  teardown point and finish the namespace buffer there

### Main work

- preserve namespace-import metadata through parsing/compilation
- extend the parser/frontend so `import ... as ns with { ... }` survives as a
  distinct namespace-instantiation form rather than collapsing into the plain
  extern-composition import path
- compile namespace method calls to namespace-side commands
- compile namespace shared observations to namespace-side commands
- add namespace-side side-channel state
- wire namespace lifetime to the normal completion/teardown of the caller
  buffer that owns the `ns` binding
- when that owner scope can no longer emit namespace operations, close the
  side-channel and call `namespaceBuffer.markFinishedAndPatchLinks()`

### Main files

- parser/frontend import handling
- imported-binding analysis and imported-callable/member-call classification
  paths in the async compiler
- `src/compiler/inheritance.js`
- namespace-call / observation command paths
- `src/runtime/command-buffer.js`
- `src/runtime/commands.js`

### Reuse

- reuse composition-mode rendering as the constructor-startup entrypoint,
  specifically the existing `rootRenderFunc(..., true)` /
  `_renderForComposition()` path
- reuse the existing imported-namespace/member-call classification machinery as
  the base for identifying namespace-bound names in expressions
- reuse existing current-buffer observation semantics for `.snapshot()`,
  `.isError()`, and `.getError()`
- reuse the normal parent/child command-buffer tree for per-call child buffers

### Replace / extend

- add a new typed namespace-binding registry parallel to the existing
  `importedBindings` Set so namespace instances can be distinguished from
  ordinary imports/macros and routed to the namespace-side command path
- add the namespace side-channel object/state and wire it to the namespace
  buffer
- add namespace-specific command emission for method calls and shared
  observations
- keep the side-channel implementation intentionally thin: immediate start on
  caller-side command apply plus close-on-owner-buffer-complete, not a second
  dependency scheduler

### Keep

- plain `import` / `include` composition keeps the current extern/composition
  behavior
- non-namespace property access keeps the normal member-lookup path

### Tests

`tests/pasync/namespace-import.js`

- namespace import creates a usable instance object
- shared var access works through `ns.x`
- shared non-var observation works through `ns.name.snapshot()` and friends
- two imports create independent instances

`tests/pasync/namespace-method-calls.js`

- method calls start immediately when their caller-side command applies
- each call gets an isolated child buffer under the namespace buffer
- side-channel apply does not wait for argument resolution before calling the
  method
- method return values resolve correctly
- method-local temporary channels do not leak across calls
- shared observations use the same immediate namespace-side path

`tests/pasync/namespace-lifecycle.js`

- constructor work and later method work both complete before the namespace
  buffer is considered done
- method calls made after constructor startup still attach correctly
- caller-side output order remains deterministic
- the namespace buffer does not finish before the side-channel finishes

## Step 9 - Templates

**Goal:** Apply the same architecture to templates.

### Includes

- template-side `shared` syntax
- pre-extends and post-extends execution around `{% extends %}`
- block-based override and `super()` behavior using the same bootstrap model
- the same root-buffer and namespace-instance model as scripts, minus
  constructor-return handling

This step intentionally changes the behavior of extending templates: top-level
code before and after `{% extends %}` becomes real pre-extends and post-extends
constructor code instead of being ignored in the classic Nunjucks style.

This step must also update or explicitly gate legacy tests that still assert
the old Nunjucks-style behavior for static `extends`.

### Reuse

- reuse the same bootstrap, root-buffer chaining, shared-channel, and
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

- plain templates without `extends` stay on the normal path
- sync template extends stays on its current path in this plan
- dynamic-extends behavior stays on its existing path until redesigned

### Tests

`tests/pasync/template-extends-pre-post.js`

- child template code before `{% extends %}` runs as pre-extends code
- code after `{% extends %}` runs as post-extends code
- block overriding still works

## Non-Goals

- caller-side read/write analysis for namespace scheduling
- per-channel promise maps on the caller side
- global serialization of all namespace calls through `ns!`
- aliasing-based replacement for per-call child buffers

## Completion Checklist

- [ ] focused tests pass for each step before moving on
- [ ] `npm run test:quick` passes at the end
- [ ] full test suite passes before closing the feature
- [ ] `docs/code/extends-next.md` still matches the implementation
