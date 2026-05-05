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

Reuse the existing inherited method implementation wherever possible. The new
block path should be an AST lowering into method declarations and method
invocations, not a parallel block-specific compiler/runtime path.

Current implementation status:

- template blocks are already compiled as method metadata by
  `CompileInheritance.compileAsyncBlockEntry()` /
  `collectCompiledMethods()`
- explicit `this.name(...)` calls already compile through
  `runtime.invokeInheritedMethod(...)`
- `super(...)`, signatures, `with context`, extends payloads, shared metadata,
  and parent-chain readiness already live on the inherited method path
- the remaining special path is block placement:
  `CompileInheritance.compileAsyncBlock()` emits a block-only text boundary and
  carries block argument payloads directly

Therefore the smallest useful migration is to keep the existing block-entry
compiler and method metadata intact, and replace only inline block placement
with the same AST shape as `{{ this.blockName(...) }}`. Once placement is just
an inherited method call, the old block-specific placement boundary can be
removed.

AST transform differences for root/no-extends templates:

- replace inline block placement sites with ordinary inherited method
  invocations, leaving the invocation at the original source position
- block placement sites may appear in non-root scopes such as loops or
  conditionals; the declaration is still hoisted, but the generated invocation
  remains in that original local scope

AST transform differences for extending templates:

- none for block placement. Root-scope block declarations are just method
  overrides, and no implicit invocation is added at the override site.

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

The ten mechanical steps above collapse into four phases. Keep each phase
small enough to verify independently, but do not split the AST lowering pieces
apart: lowering, declaration preservation, placement rules, and argument
mapping are one coherent change.

### Phase 1: Lower Blocks To Existing Method Calls

Goal: make inline block placement compile as inherited method invocation
without changing runtime behavior.

Implement this in `src/transformer.js`, after async inheritance metadata is
extracted and before async analysis/renaming. Keep it template-only:

- skip the pass in sync mode
- skip the pass in script mode
- leave the existing synchronous Nunjucks block path unchanged

This phase includes the original steps 1-5:

- collect every template `nodes.Block` as a method declaration
- move hoisted template blocks into `InheritanceMetadata.methods` so
  `compileAsyncBlockEntry()` still compiles their bodies
- update `compileAsyncBlockEntries()` and `collectCompiledMethods()` to read
  template blocks from metadata when present, falling back to `node.findAll`
  only during transition
- replace render-position block nodes with the same AST shape as
  `{{ this.blockName(...) }}`
- apply the placement rules:
  root/no-extends blocks leave an invocation; root-scope extending-template
  blocks are declaration-only; non-root blocks leave an invocation in their
  original local scope
- map block signatures to implicit invocation arguments by passing same-named
  symbols, without scanning the block body for free variables

The generated invocation shape should be:

```javascript
Output([
  FunCall(
    LookupVal(Symbol("this"), Literal(blockName)),
    NodeList(invocationArgs)
  )
])
```

That call should naturally flow through:

- `CompileCall.analyzeFunCall()`
- `CompileInheritance.analyzeExplicitThisDispatchCall()`
- `CompileInheritance.postAnalyzeExplicitThisDispatchCall()`
- `CompileInheritance.compileExplicitThisDispatchCall()`

The generated argument symbols must use the source block's line/column and
remain normal symbols, not compiler-internal symbols, so the existing rename
pass can bind them to the placement scope.

Verify this phase with behavior tests:

- no-extends block renders once: `A{% block body %}B{% endblock %}C`
- extending template override renders only at the parent placement
- explicit `{{ this.row(item) }}` works in a loop and preserves output order
- implicit block signature placement passes loop locals by argument
- child override receives those arguments and `super()` receives the original
  arguments
- `with context` still exposes render-context names
- block body does not see loop locals unless they are explicit arguments
- dynamic `extends none` still renders local root block placements

### Phase 2: Treat Template Text As Normal Shared Text

Goal: align template text with the inherited method shared-channel model.

Update inferred shared declaration handling so `this.__text__` is recognized as
the root template text channel:

- infer channel type `text` for `__text__`
- keep other inferred `this.<name>` declarations as shared `var`
- avoid declaring a duplicate `var __text__` when the root already has the
  ordinary template text channel declaration

This phase can be done after Phase 1 if existing text output still passes
through the old template text channel. It becomes required before removing any
remaining block-specific text-output assumptions.

Verify with shared-channel and ordering tests, including async values and
poisoned block arguments following the inherited method-call error path.

### Phase 3: Remove Block-Only Placement Machinery

Goal: delete the old path once block placement is proven to use inherited
method dispatch.

Remove or shrink:

- `CompileInheritance.compileAsyncBlock()` placement emission
- `CompileBoundaries.compileBlockTextBoundary()` if no other caller remains
- block-specific top-level parent checks inside placement emission
- block-placement-only tests that assert specific boundary names or command
  shapes

Do not remove `compileAsyncBlockEntry()`: block bodies still need dedicated
method entry functions.

Update command-buffer tests that currently inspect block-specific boundaries so
they assert inherited method invocation metadata and normal text channel
ordering instead.

### Phase 4: Optional Public Statement Syntax

Goal: add `{% this.row(...) %}` only after the internal lowering is stable.

Public explicit invocation can initially be documented and tested with the
already-supported output expression form:

```njk
{{ this.row(item, loop.index) }}
```

If statement syntax is added later, implement it as a parser node or
`parseStatement` special case that lowers directly to the same
`Output(FunCall(...))` shape. It should not get a separate compiler/runtime
path.

### Suggested Work Order

1. Add the Phase 1 behavior tests and isolate them with `describe.only()` while
   developing.
2. Implement the Phase 1 transformer and metadata changes without touching
   runtime code.
3. Run the targeted async block and composition tests.
4. Implement Phase 2 only if `this.__text__` inference is needed to remove
   remaining special placement assumptions.
5. Remove the old block placement path in Phase 3.
6. Run `npm run mocha -- tests/pasync/loader.js tests/pasync/composition.js
   tests/pasync/template-command-buffer.js` before a broader quick suite.

## Compatibility

The synchronous Nunjucks-compatible compiler path should keep its existing
block behavior. This design is for async Cascada templates, where blocks are
already represented by inherited method metadata and command-buffer scheduling.

During migration, old inline block placement can be preserved as syntax by
lowering it to a hoisted method declaration plus an invocation at the original
source position. Public `this.blockName(...)` invocation can be introduced
after the internal lowering is stable.
