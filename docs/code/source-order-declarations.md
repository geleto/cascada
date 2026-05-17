# Source-Order Declaration Lookup

## Problem

The compiler currently keeps scope declarations in `declaredChains`. That map
acts like a whole-scope inventory: after analysis finalization, a later
declaration can be visible to an earlier expression during codegen.

That is wrong for symbol lookup. A name should become local only when the
compiler reaches its declaration point. Before that point, the same name should
compile as an ambient lookup from context, component payload, or globals.

Example:

```cascada
var before = someVar   // ambient lookup
var someVar = 5        // local declaration starts here
var after = someVar    // local var lookup
```

The same rule applies to dynamic inheritance parent selection:

```cascada
extends parentScript   // ambient lookup
var parentScript = "x" // not visible to the extends expression above
```

## Desired Design

Add a compile-time, source-order, scoped declaration log. It should reuse the
same declaration rules as the current analysis `declaredChains` machinery:

- declaration kinds: `var`, `data`, `text`, `sequence`, imports, callable
  arguments, macro params, root return/text chains, shared declarations, and
  internal declarations
- scope ownership and parent-owned declarations
- duplicate and reserved-name validation
- read-only boundary rules where applicable
- compiler-generated declarations may use `$`-prefixed internal names; user
  Cascada identifiers cannot contain `$`

The important distinction is API semantics:

- whole-scope inventory answers "what declarations exist in this scope?"
- source-order lookup answers "what declaration is visible at this node?"

`declaredChains` can remain the inventory if useful, but symbol resolution
must use source-order lookup.

## Callable Arguments

Function, macro, inherited-method, block, and constructor arguments are local
`var` chains. They are different from source-order body declarations because
they exist from the start of the callable invocation frame. A lookup inside a
callable body should see an argument name before any body statement runs:

```cascada
function pick(user, fallback = user)
  return fallback
endfunction
```

Default argument expressions should also see all argument chains declared for
the callable frame. This is why compiler emission declares all argument local
chains before it emits any argument initialization commands.

The source-order declaration log should seed a callable frame with its argument
declarations before walking the callable body. It should not treat those
arguments like declarations that appear later in the body.

## Lookup Rule

When compiling or analyzing a symbol:

1. Ask the source-order declaration log for the declaration visible at this
   source point.
2. If found, compile/analyze it as a local chain/var lookup.
3. If not found, compile/analyze it as ambient.

This removes the need for inheritance-specific parent-selection lookup hacks.
Dynamic `extends` can compile as ordinary expression code because later local
declarations will not be visible to it.

## Notes

- Conflict checks can still happen when each declaration is reached. For
  example, `var x` followed by `data x` can fail at `data x`, and the reverse
  can fail at `var x`.
- Analysis still needs aggregate facts such as `usedChains`, `mutatedChains`,
  linked chains, and callable footprints.
  Those facts should be based on source-order symbol resolution, not a later
  whole-scope lookup.
- A good implementation path is to annotate symbols during analysis with their
  resolution (`declared` vs `ambient`) and let codegen consume that annotation.
- After the fix, remove inheritance-specific parent-selection lookup hacks.
  Dynamic `extends` should use ordinary expression compilation; source-order
  declaration lookup is what prevents later locals and shared declarations from
  shadowing ambient parent-selection inputs.
- Keep whole-scope validation where it still describes a real language rule.
  For example, duplicate declarations and reserved names can still be rejected
  at the declaration point even though lookup visibility is source-ordered.

## Regression Tests To Add

- `var before = someVar; var someVar = 5` reads `someVar` from ambient context
  before the local declaration point.
- `print(someVar); var someVar = 5` in script mode compiles the first
  `someVar` as ambient, not as a local chain read.
- `var x = 1; data x` and `data x; var x = 1` still fail at the second
  declaration.
- `extends parentScript; var parentScript = "local.script"` uses ambient
  `parentScript` for parent selection, not the later local declaration.
- The same dynamic `extends` source fails naturally when ambient `parentScript`
  is missing.
- Dynamic `extends` cannot read shared declarations that appear before it;
  shared declarations are metadata/default declarations, not constructor values.
- Callable arguments stay visible from the start of function, macro, method,
  block, and constructor bodies.
- Default argument expressions can read earlier and later argument chains
  declared in the same callable signature.
