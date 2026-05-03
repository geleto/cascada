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

## Compatibility

The synchronous Nunjucks-compatible compiler path should keep its existing
block behavior. This design is for async Cascada templates, where blocks are
already represented by inherited method metadata and command-buffer scheduling.

During migration, old inline block placement can be preserved as syntax by
lowering it to a hoisted method declaration plus an invocation at the original
source position. Public `this.blockName(...)` invocation can be introduced
after the internal lowering is stable.
