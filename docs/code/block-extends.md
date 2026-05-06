# Block Extends Architecture

This note describes a future async-template inheritance model that unifies
template blocks with script methods. It is a design target, not the current
implementation.

The existing Nunjucks-compatible synchronous compiler path remains unaffected.
This design applies only to the async Cascada inheritance pipeline.

The layout rule stays close to Nunjucks: the root/base template declares the
structure and the in-scope block placement sites; extending templates override
those named methods without creating new implicit placements.

## Goal

Template inheritance should lower to the same core model as script
inheritance:

- template output is an implicit shared text channel, `__text__`
- template blocks are inherited methods
- block placement is an inherited method invocation
- `super(...)` in a block uses the same dispatch rules as script methods
- shared state and text output are ordered through the same command-buffer
  invocation machinery

Conceptually, this template:

```njk
Base before [{% block body %}base{% endblock %}] after
```

can lower to:

```cascada
shared text __text__

method __constructor__()
  __text__("Base before [")
  this.body()
  __text__("] after")
endmethod

method body()
  __text__("base")
endmethod
```

An overriding template:

```njk
{% extends "base.njk" %}
{% block body %}child{% endblock %}
```

then contributes only the `body` method override. It does not create a second
top-level placement unless it explicitly invokes the block.

## AST Lowering

The AST transform that already collects blocks/methods should split each block
declaration in an async template into two concepts:

1. A hoisted inherited method declaration.
2. An invocation left at the original block position.

For example:

```njk
Base before [{% block row %}default{% endblock %}] after
```

lowers structurally to:

```njk
{% block row %}
default
{% endblock %}

Base before [{% this.row() %}] after
```

The exact internal node shape does not need to be a public syntax node, but it
should be equivalent to inherited method invocation. This removes the need for
a special text-placement boundary: parent text placement is just constructor
source order around a block-method call.

The transform must distinguish declaration from placement:

- In a root/no-extends template, an inline block declaration is both a method
  declaration and a placement site. The transform leaves an invocation at the
  original source position.
- In an extending template, an inline block declaration is an override-only
  method declaration. It does not leave an invocation at the override site.
- Block declarations in extending templates should be root-scope declarations,
  matching the existing Nunjucks layout model. Constructor/setup code after
  `extends` remains normal constructor code.
- If an extending template wants additional output placement, it should use an
  explicit invocation in constructor code.

## Explicit Block Invocation

The model should support explicit invocation syntax:

```njk
{% block row(item, index) %}
  {{ item.name }}
{% endblock %}

{% this.row(item, loop.index) %}
```

This mirrors script inheritance:

```cascada
method row(item, index)
  text(item.name)
endmethod

this.row(item, loop.index)
```

The syntax makes block placement explicit and removes ambiguity between block
declaration and block invocation.

Implicit invocation remains for existing inline block placement syntax. An
explicit `{% this.row(...) %}` is an additional invocation, not a replacement
for the implicit one. Override-only block declarations in extending templates
do not create an implicit invocation at the override site; they only replace the
method selected by existing or explicit invocation sites.

## Block Arguments

Blocks can appear inside loops and other local scopes. Nunjucks-compatible
templates already allow blocks inside loops, and Cascada tests preserve the
rule that block bodies do not see loop-local variables by default.

Arguments are therefore still useful. They provide the explicit contract for
which placement-local values are available to overrides:

```njk
{% for item in items %}
  {% this.row(item, loop.index) %}
{% endfor %}

{% block row(item, index) %}
  {{ index }}. {{ item.name }}
{% endblock %}
```

Do not infer override-visible values by scanning block body code. That would
make the inheritance contract depend on implementation details and would be
fragile across parent/child templates. The parent placement site should define
the call contract explicitly.

Optional future shorthand can allow declaration-site placement with arguments:

```njk
{% block row(item, index) %}
  {{ index }}. {{ item.name }}
{% endblock %}
```

In that form the declaration still defines the method signature, and the
lowering may leave behind an invocation that passes same-named placement values
from the current scope. More flexible remapping can be added later with an
explicit syntax such as:

```njk
{% block row(item = product, index = loop.index) %}
```

The important rule is that override access is declared by the block/method
signature and invocation arguments, not inferred from free variables.

## Implementation Direction

Reuse the existing inherited method implementation wherever possible. The first
implementation should be a compiler-path simplification: make block placement
emit the same inherited method invocation as explicit `this.name(...)` calls,
then delete block-only placement machinery. AST lowering is a fallback only if
it enables more deletion than it adds.

Current implementation status:

- template blocks are already compiled as method metadata by
  `CompileInheritance.compileAsyncCallableEntry()` /
  `collectCompiledMethods()`
- explicit `this.name(...)` calls already compile through
  `runtime.invokeInheritedMethod(...)`
- `super(...)`, signatures, `with context`, extends payloads, shared metadata,
  and parent-chain readiness already live on the inherited method path
- the Phase 1 implementation makes block placement emit inherited method
  invocation directly; `CompileBoundaries.compileBlockTextBoundary()` has been
  deleted

Therefore the smallest useful migration is to keep the existing block-entry
compiler and method metadata intact, and replace only inline block placement
with the same inherited method invocation used by `{{ this.blockName(...) }}`.
Placement is now an inherited method call; future phases should focus on any
remaining text/shared-channel unification rather than reintroducing a
block-specific placement path.

Compiler-path behavior for root/no-extends templates:

- emit inline block placement sites as ordinary inherited method invocations at
  the original source position
- block placement sites may appear in non-root scopes such as loops or
  conditionals; the method metadata is already available, and the invocation
  must remain in that original local scope

Compiler-path behavior for extending templates:

- none for block placement. Root-scope block declarations are just method
  overrides, and no invocation is emitted at the override site.

Shared compiler/analysis changes:

- template output writes should compile as normal `this.__text__`
  shared-channel writes
- inferred template shared declarations are already collected during root
  analysis; that path should recognize `this.__text__` as shared `text` rather
  than inferring the default shared `var`

The existing inherited method implementation should handle:

- method metadata and admission links, including `__text__` once it appears as
  a normal shared channel use/mutation
- implicit shared-channel declaration/registration through the shared-schema
  path, instead of block-specific text output declarations
- source-order command buffering for writes to `__text__` and other shared
  channels
- `super(...)` dispatch, argument arity checks, inherited signatures, and
  transitive invoked-method metadata
- constructor/startup ordering and parent-chain metadata readiness

As the lowering takes over, remove old async block-specific implementation
surfaces instead of preserving compatibility layers around them. In particular,
delete block-only text-placement boundaries, block-only parent-buffer linking,
and block-only argument payload plumbing once their behavior is expressed by
method invocation and normal shared-channel metadata.

## Implementation Phases

Bias the implementation toward deletion. New code is acceptable only when it
lets us remove a block-specific compiler/runtime path or directly route block
behavior through inherited methods. If an implementation mostly adds traversal
or compatibility plumbing while leaving the old placement path intact, stop and
redesign the step.

### Phase 1: Replace Placement In The Existing Compiler Path

Goal: make `CompileInheritance.compileAsyncBlock()` a small compatibility
adapter around inherited method dispatch, then delete the generic block-only
placement machinery.

Start inside the existing block compiler instead of adding a broad AST rewrite:

- keep `compileAsyncCallableEntry()` as the only callable body compiler
- change non-dynamic block placement emission to call the same helper used by
  explicit `this.name(...)` dispatch
- factor a tiny shared emitter if needed, for example
  `emitInheritedMethodInvocation(methodName, argsNode, errorContext, options)`
- keep `runtime.markSafe(...)` for template method calls in that shared emitter
- preserve the dynamic root `extends none` check as the only temporary
  block-specific branch

Then remove or shrink immediately:

- the generic branch of `compileAsyncBlock()` that constructs block-only text
  boundaries for all placements
- `CompileBoundaries.compileBlockTextBoundary()`
- any block-only argument payload construction that can be represented as
  ordinary method call arguments
- command-buffer tests that assert block-only boundary shapes

This phase should produce a net reduction in block placement code. If it does
not, the implementation is too indirect.

Verify this phase with behavior tests:

- no-extends block renders once: `A{% block body %}B{% endblock %}C`
- extending template override renders only at the parent placement
- block inside a loop preserves output order
- block signatures pass same-named placement locals as method arguments
- child override receives those arguments and `super()` receives the original
  arguments
- `with context` still exposes render-context names
- block body does not see loop locals unless they are explicit arguments
- dynamic `extends none` still renders local root block placements

### Phase 2: Hoist Only What Deletion Requires

Goal: hoist template blocks into inherited method metadata only if Phase 1
cannot delete enough by editing the existing compiler path.

Phase 2 decision after Phase 1: no hoisting/lowering is needed. Phase 1 already
deleted `CompileBoundaries.compileBlockTextBoundary()` and routes block
placement through inherited method dispatch from the existing compiler path.
Keep reusing `node.findAll(nodes.Block)` for template block metadata discovery
until a later phase has a concrete deletion that requires changing it.

Prefer reusing the current metadata discovery (`node.findAll(nodes.Block)`) as
long as possible. Add a transformer lowering only when it lets us delete
`compileAsyncBlock()` or `compileBlockTextBoundary()` entirely.

If lowering is needed, keep it narrow:

- do not introduce a general-purpose AST traversal framework
- rewrite only direct render-position `nodes.Block` nodes
- preserve declaration metadata with the smallest possible change
- avoid fallback readers that scan both metadata and the original tree forever;
  choose one canonical source after the migration

The generated invocation shape should still be exactly the existing expression
call shape:

```javascript
Output([
  FunCall(
    LookupVal(Symbol("this"), Literal(blockName)),
    NodeList(invocationArgs)
  )
])
```

That call must flow through:

- `CompileCall.analyzeFunCall()`
- `CompileInheritance.analyzeExplicitThisDispatchCall()`
- `CompileInheritance.postAnalyzeExplicitThisDispatchCall()`
- `CompileInheritance.compileExplicitThisDispatchCall()`

Treat any new transformer code as temporary scaffolding unless it replaces and
removes more compiler code than it adds.

### Phase 3: Confirm No Block Text Boundary Remains

Goal: keep `CompileBoundaries.compileBlockTextBoundary()` deleted.

Phase 3 decision after Phases 1 and 2: complete. Source no longer references
`compileBlockTextBoundary()`, and dynamic root `extends none` placement uses the
same inherited method invocation path as ordinary block placement. The only
special handling that remains is the parent-selection guard in
`compileAsyncBlock()`, which prevents fallback block text from being placed when
a dynamic parent template exists.

Keep:

- no `CompileBoundaries.compileBlockTextBoundary()` helper
- no block-only text placement boundary
- command-buffer tests asserting inherited method invocation and absence of the
  old block boundary

Do not delete `compileAsyncCallableEntry()`: it is the shared entry compiler
for template blocks and script methods.

### Phase 4: Treat Template Text As Normal Shared Text

Goal: align template text with the inherited method shared-channel model only
after the placement path has been simplified.

Phase 4 implementation: keep inference in the existing template shared
declaration collector. `this.__text__` now infers a shared `text` declaration
for inheritance metadata, while the root scope keeps its ordinary `__text__`
text channel declaration instead of adding a duplicate shared `var`
declaration. Template shared-channel observations can reuse the existing
`observeInheritanceSharedChannel(...)` path for `this.__text__.snapshot()`.

Phase 4 review follow-up: current-phase quality gaps were fixed in place
(unused call-compiler local removed; runtime coverage added for
`this.__text__.snapshot()`). No Phase 4 issues are intentionally postponed.

Update inferred shared declaration handling so `this.__text__` is recognized as
the root template text channel:

- infer channel type `text` for `__text__`
- keep other inferred `this.<name>` declarations as shared `var`
- avoid declaring a duplicate `var __text__` when the root already has the
  ordinary template text channel declaration

This should remove special text-output assumptions rather than adding a second
way to model template text.

### Phase 5: Optional Public Statement Syntax

Goal: defer `{% this.row(...) %}` unless there is a concrete user-facing need.

Phase 5 decision: do not implement now. The public explicit invocation surface
already works through the output expression form:

```njk
{{ this.row(item, loop.index) }}
```

Verified behavior:

```njk
{% block row(item) %}<{{ item }}>{% endblock %}
{% block body %}{{ this.row("a") }}{{ this.row("b") }}{% endblock %}
```

renders the expected inherited method output.

If statement syntax is added later, implement it as a parser special case that
lowers directly to the same `Output(FunCall(...))` shape. It should not get a
separate compiler/runtime path.

### Phase 6: Generalize Callable Entry Helpers

Goal: make the already-shared callable entry path easier to understand and
evolve without changing runtime behavior.

`compileAsyncCallableEntry()` is the shared entry compiler for template
blocks and script method definitions. Phase 6 is readability scaffolding for
future cleanup, not an immediate line-count reduction phase.

Phase 6 implementation: callable signature handling now uses callable-oriented
helper names, and `compileAsyncCallableEntry()` delegates entry setup to small
helpers for context forking, parent-channel linking, callable state, and return
emission. The script-method and template-block semantic differences remain
explicit at those helper boundaries.

The implementation shares `compileAsyncCallableEntry()` for both template blocks
and script method definitions. The callable-entry helpers now cover:

- callable signature and argument discovery
- local argument channel initialization
- context forking
- parent-channel linking
- callable-definition state save/restore
- script-method versus template-block return emission

Do not change semantics:

- script methods still return through `__return__`
- template blocks still return the local `__text__` final snapshot
- template block context still accounts for composition payloads, explicit
  block arguments, and `with context`

The previous block-oriented helper name was removed in this phase.

### Phase 7: Shrink Block Placement Adapter If It Deletes Code

Goal: keep `compileAsyncBlock()` as small as possible while preserving block
syntax semantics.

The remaining block placement differences are intentional:

- static-extends top-level blocks are definition-only
- dynamic root `extends none` must render local fallback block placement only
  when no parent template is selected
- inline block placement passes same-named signature values as inherited method
  arguments
- placement output is enqueued on the current template text channel

Only refactor this phase if it makes `compileAsyncBlock()` smaller or clearer.
Good candidates:

- extract inherited-call-to-current-text emission into a tiny helper reused by
  normal and dynamic-root placement
- keep the dynamic parent-selection guard local unless a generic conditional
  text-placement helper deletes more code than it adds

Do not introduce AST lowering or parser changes for this phase unless they let
us remove more compiler code than they add.

Phase 7 implementation: `compileAsyncBlock()` now keeps the static/dynamic
block-placement decisions local, while a small `emitAsyncBlockTextPlacement()`
helper owns the shared inherited-call result assignment, current text-channel
enqueue, and waited-completion registration for both normal placement and the
dynamic root fallback path.

### Suggested Work Order

1. Revert any broad lowering that increases code before deleting old placement
   code.
2. Refactor `compileAsyncBlock()` to call the inherited method dispatch emitter
   for every non-dynamic-root placement.
3. Delete the now-unused generic block placement branch and update structural
   tests to assert inherited method dispatch.
4. Run `npm run mocha -- tests/pasync/loader.js tests/pasync/composition.js
   tests/pasync/template-command-buffer.js`.
5. Confirm dynamic-root fallback still uses inherited method dispatch and that
   `compileBlockTextBoundary()` remains deleted.
6. Run `npm run test:quick`.

## Compatibility

The synchronous Nunjucks-compatible compiler path should keep its existing
block behavior. This design is for async Cascada templates, where blocks are
already represented by inherited method metadata and command-buffer scheduling.

During migration, old inline block placement can be preserved as syntax by
lowering it to a hoisted method declaration plus an invocation at the original
source position. Public `this.blockName(...)` invocation can be introduced
after the internal lowering is stable.
