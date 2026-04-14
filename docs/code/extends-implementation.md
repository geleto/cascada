# `extends-next` Implementation Plan

## Overview

This plan implements the inheritance architecture described in
`docs/code/extends-next.md`.

The design has four core runtime pieces:

1. shared root-owned channels
2. root-buffer constructor chaining for `extends`
3. hierarchy bootstrap before constructor execution
4. namespace instances built from one long-lived buffer plus a side-channel

Implement the steps in order. Each step should land with focused tests before
moving on.

Scope:

- static ancestry only
- the full parent chain must be known before constructor execution starts
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
- add a helper on `CommandBuffer` to declare/find shared channels on the root
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

### Apply-complete contract

For this step, `waitForApplyComplete()` must be aggregate, not per-event:

- it must not resolve from a single iterator leave event
- it must mean all active channels for that buffer have finished applying
- child-buffer work attached under that buffer must also be applied before it
  resolves

This aggregate apply-complete wait is the barrier used by post-`extends` code.

### Runtime shape

- C owns the root buffer
- B runs in a child buffer created at C's `extends` site
- A runs in a child buffer created at B's `extends` site
- post-extends code runs only after the parent child buffer has been fully
  applied

### Main work

- rewrite async `extends` compilation around child buffers at the `extends` site
- add `waitForApplyComplete()` on `CommandBuffer`
- `waitForApplyComplete()` returns a Promise stored on the buffer
- resolve that Promise only when aggregate apply-complete has been reached for
  the buffer, across all relevant channels, after child-buffer work has applied
- at the `extends` site, await `childBuffer.waitForApplyComplete()` directly in
  the compiled async flow before emitting post-extends code
- use that apply-complete await for post-extends code instead of
  `getFinishedPromise()`
- update async root completion so composition mode returns the root buffer
- remove static-path inheritance payload/local-capture threading rather than
  adapting it; it is dead machinery in the new model
- remove static-path extends-composition context threading rather than adapting
  it; it is dead machinery in the new model

### Main files

- `src/compiler/inheritance.js`
- `src/compiler/compiler-async.js`
- `src/runtime/command-buffer.js`
- `src/runtime/buffer-iterator.js`
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
  `forkForComposition()` at the static `extends` boundary; do not preserve this
  on the new static path
- replace the idea of a structural barrier command/channel for static `extends`
  with a direct await on `childBuffer.waitForApplyComplete()` in the compiled
  async control flow

### Keep

- keep `getFinishedPromise()` for scheduling-complete use cases unrelated to the
  extends barrier
- keep dynamic-extends machinery alive for the dynamic path until that path is
  redesigned explicitly
- keep the existing sync path unchanged unless a later step explicitly widens
  scope

### Tests

`tests/pasync/extends-root-inversion.js`

- constructor order is `pre-C`, `pre-B`, `A`, `post-B`, `post-C`
- shared state written in descendant pre-extends code is visible to ancestors
- post-extends code waits for parent application, not just scheduling

## Step 4 - Hierarchy Bootstrap

**Goal:** Build the hierarchy instance before constructor execution starts.

### Bootstrap responsibilities

1. resolve the static ancestry chain
2. compile each ancestor before reading its metadata
3. register shared-channel schema on the root buffer
4. preload `with { }` values into shared state
5. build the method/block dispatch table most-derived first
6. start constructor execution

### Main work

- add a hierarchy bootstrap helper
- emit metadata for static parent lookup, shared schema, and method signatures
- add a context path that consumes a prebuilt dispatch table
- validate `with { }` keys for the new static inheritance / namespace path
  against declared shared schema, and preload only declared shared names
- remove `beginAsyncExtendsBlockRegistration` /
  `finishAsyncExtendsBlockRegistration` / `getAsyncBlock` usage from the
  static-extends path only
- keep those methods in `context.js` for the dynamic-extends path

### Main files

- new hierarchy-bootstrap helper
- compiler metadata emission
- `src/environment/context.js`

### Reuse

- keep `template.compile()` as the way to materialize compiled metadata before
  bootstrap reads it
- keep the existing `Context.blocks` block-table shape and
  `getBlock()` / `getAsyncSuper()` lookup model
- prebuild the dispatch table in the same shape already consumed by `Context`
  rather than inventing a second method-dispatch representation

### Replace

- replace incremental static-extends block registration with bootstrap-time
  dispatch-table construction for the static path

### Keep

- keep `beginAsyncExtendsBlockRegistration()` /
  `finishAsyncExtendsBlockRegistration()` / `getAsyncBlock()` wired for the
  dynamic-extends path
- keep existing `super()` lookup entrypoints if the bootstrap table can feed
  them directly

### Tests

`tests/pasync/hierarchy-bootstrap.js`

- methods from C are visible while A's constructor runs
- `with { }` preload is visible to ancestor constructor code
- shared schema is registered before constructor work begins

## Step 5 - Constructor Return Rules

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

## Step 6 - Namespace Instances

**Goal:** Implement namespace instances as one long-lived namespace buffer plus
one side-channel.

The side-channel is a runtime object owned by the namespace instance. It accepts
namespace operations from caller code, immediately enqueues the corresponding
namespace command or per-call child buffer into the namespace buffer tree, and
returns the resulting promise to the caller.

### Creation

- `import "C.script" as ns with { ... }` creates one long-lived namespace buffer
  as a child of the caller buffer
- bootstrap builds the shared schema and dispatch table
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
- close the side-channel from that owner-buffer apply-complete event and finish
  the namespace buffer there

### Main work

- preserve namespace-import metadata through parsing/compilation
- extend the parser/frontend so `import ... as ns with { ... }` survives as a
  distinct namespace-instantiation form rather than collapsing into the plain
  extern-composition import path
- compile namespace method calls to namespace-side commands
- compile namespace shared observations to namespace-side commands
- add namespace-side side-channel state
- wire namespace lifetime to the apply-complete event of the caller buffer that
  owns the `ns` binding
- when that owner buffer's `waitForApplyComplete()` resolves, close the
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

## Step 7 - Templates

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
