# Macro Argument-By-Reference Aliasing

## Goal

This document describes the architecture for explicit macro/function
argument-by-reference in async Cascada.

The motivating syntax is:

```cascada
function myFunc(var x, data z)
  x = x + 1
  @z.items.push("ok")
endfunction

myFunc(xCoord, zInfo)
```

Intended meaning:

- `x` is a local parameter name that refers to the caller-owned var channel
  passed as `xCoord`
- `z` is a local parameter name that refers to the caller-owned data channel
  passed as `zInfo`
- reads and writes inside the macro go to the caller-owned channels
- this is explicit argument binding, not ambient parent-scope visibility

This is similar to aliasing, but it is not the old include/import composition
model where child code implicitly saw parent channels.

The key rule is:

- aliasing exists only because the caller passed an explicit by-reference
  argument

---

## Why This Needs Aliasing

The callee should use its own formal parameter names:

```cascada
function myFunc(var x, data z)
```

but the caller passes actual names:

```cascada
myFunc(xCoord, zInfo)
```

So the compiled macro body needs to treat:

- `x` as the caller's `xCoord`
- `z` as the caller's `zInfo`

In async Cascada that also means handling internal runtime names correctly:

- source name: `xCoord`
- runtime name after renaming: `xCoord#7`
- formal name in macro body: `x`

So there are two mappings:

1. user-level binding:
   - `x -> xCoord`
   - `z -> zInfo`
2. runtime binding:
   - `x -> xCoord#7`
   - `z -> zInfo#2`

Without this mapping, the macro would either:

- look up `x` and `z` as ordinary local parameters detached from caller state, or
- require the caller and callee to use the same names, which defeats the point

---

## What This Is Not

This is not:

- implicit parent-scope access
- async include-style ambient visibility
- inheritance-style shared lexical scope
- a general revival of boundary alias maps for all child buffers

It is an explicit call contract:

- the caller chooses which channels are passed by reference
- the callee sees only the formal names it declared
- only those names are aliased

This makes it much closer to normal parameter passing than to the removed async
composition aliasing model.

---

## Semantics

## Declaration side

Example:

```cascada
function myFunc(var x, data z)
```

Recommended meaning:

- `var x`
  - a by-reference var parameter
  - may be read and reassigned
  - assignments target the caller-owned var channel bound to `x`
- `data z`
  - a by-reference data channel parameter
  - channel commands target the caller-owned data channel bound to `z`

Ordinary value parameters remain unchanged:

```cascada
function myFunc(var x, data z, label)
```

Here:

- `x` is by-reference
- `z` is by-reference
- `label` is ordinary by-value

## Call side

Example:

```cascada
myFunc(xCoord, zInfo, "hello")
```

Recommended rules:

- by-reference actuals must be simple declared names
- the actual declaration type must match the formal parameter kind
- caller-side renamed runtime names are resolved before invocation

So the call site does not pass snapshots or values for by-reference arguments.
It passes channel bindings.

---

## Validation Rules

Recommended validations:

1. A by-reference actual must be a simple symbol.
   - valid: `myFunc(xCoord, zInfo)`
   - invalid: `myFunc(user.x, zInfo)`
   - invalid: `myFunc(getX(), zInfo)`
2. The actual name must resolve to a declared binding/channel.
3. The actual type must match the formal parameter kind.
   - `var` formal -> caller var
   - `data` formal -> caller data channel
4. Caller-side runtime renaming must be honored.
5. Formal by-reference names should behave as non-renamable local aliases inside
   the macro body.
6. By-reference parameters should participate in ordinary declaration conflict
   checks against other macro locals.
7. Decide explicitly whether aliasing the same actual multiple times is allowed.

Example question:

```cascada
function swap(var a, var b)
swap(x, x)
```

Recommended initial rule:

- allow it
- both formals resolve to the same caller-owned runtime channel

This is simpler and matches normal aliasing semantics.

---

## Runtime Model

The clean model is:

- ordinary by-value params remain ordinary local bindings
- by-reference params are aliases to caller-owned channels

Conceptually, the caller prepares a reference map:

```js
{
  x: { channelName: "xCoord#7", buffer: callerBuffer, type: "var" },
  z: { channelName: "zInfo#2", buffer: callerBuffer, type: "data" }
}
```

The macro body then compiles against the formal names:

- reads of `x`
- writes to `x`
- commands targeting `z`

but runtime resolution redirects those names to the actual caller-owned channel
bindings.

The important point is:

- the macro still uses the formal names
- the runtime/compiler alias layer resolves those names to the actual channels

---

## Buffer and Linking Implications

Yes, this likely requires command-buffer linking, but only for the explicitly
bound channels.

That means:

- if a macro reads or writes aliased var/data channels, the macro buffer must be
  able to resolve those caller-owned channels correctly
- if the caller-owned channels live in a parent or sibling-visible scope, the
  relevant lanes must be linked structurally for ordered reads/writes

But this should be narrow and explicit:

- only channels bound through by-reference params are linked
- there is no generic "all visible parent vars are available here" model

So the design should be:

- explicit alias map
- explicit linked-channel set derived from that alias map
- no ambient child visibility beyond those bindings

---

## Low-Level Mechanics We Should Preserve

The earlier generic aliasing work already solved a few tricky runtime problems.
We should preserve those mechanics here, but in a narrower macro-by-reference
form.

Important details to keep:

1. Formal names must resolve to runtime channel names at buffer ingress.
   - If the macro writes to `x`, and `x` is bound to caller runtime channel
     `xCoord#7`, command routing must target `xCoord#7`.
   - This applies to:
     - command insertion
     - snapshots
     - channel-finish requests
     - linked-child registration
2. Runtime names must remain stable once bound.
   - The alias map should bind to the resolved runtime channel name, not to the
     source name.
   - Example:
     - source name: `xCoord`
     - resolved runtime name: `xCoord#7`
     - formal alias: `x -> xCoord#7`
3. Nested child buffers inside the macro must inherit the alias projection.
   - If the macro has loops, `if` branches, async control-flow boundaries, or
     nested child buffers, those buffers must still resolve `x` to `xCoord#7`.
4. Canonical runtime names must remain valid direct inputs.
   - If runtime code already uses `xCoord#7`, it should not be remapped again.
5. Diagnostics should stay source-facing.
   - User-facing errors should prefer the formal name (`x`) or the caller
     source name (`xCoord`) instead of raw runtime aliases unless debug detail
     is explicitly needed.

These are good low-level behaviors worth preserving even though the old generic
composition feature itself should not return.

---

## Recommendation on Reusing Old Buffer Aliasing

Short answer:

- do not bring back the old generic buffer aliasing implementation as-is

Why:

- it was designed for ambient composition visibility
- it encouraged child buffers to resolve arbitrary canonical names against
  parent-owned runtime aliases
- that is broader than what by-reference macro params need

What is worth reusing:

- the idea that a formal name can resolve to a different runtime channel name
- the idea that linked buffers may need a narrow alias projection for command
  routing
- the previously tested inheritance behavior for child buffers
- the previously tested normalization behavior at command-buffer ingress

What should change:

- aliasing must be explicit and per-call
- aliasing must be limited to the declared by-reference formals
- aliasing must not silently apply to unrelated names
- aliasing should be documented as argument binding, not composition visibility
- naming should reflect channel binding, not template-composition boundaries

So the best approach is:

1. do not restore the old generic `_boundaryAliases` mechanism wholesale
2. reintroduce only the low-level alias-resolution pieces we need
3. rename them so they describe explicit channel binding, not composition
   visibility
4. attach comments in code explaining that they exist only for explicit
   argument-by-reference bindings
5. link only the channels referenced by that map

This keeps the architecture simpler and avoids reintroducing the exact class of
hidden-scope behavior that async composition just removed.

Current implementation note:

- the low-level command-buffer alias primitive is available again under the new
  channel-binding names
- it should be treated as runtime substrate only
- async include/import/extends should not use it as ambient visibility

---

## Recommended Naming

If we reintroduce the low-level primitive, the names should describe what it
actually does.

Recommended renames:

- old `_boundaryAliases`
  - new `_channelAliases`
- old `_setBoundaryAliases(map)`
  - new `_setChannelAliases(map)`
- old `_inheritBoundaryAliases(parentMap)`
  - new `_inheritChannelAliases(parentMap)`
- old `_resolveChannelName(name)`
  - new `_resolveChannelAlias(name)` or `_resolveAliasedChannelName(name)`

Why this naming is better:

- it does not imply template/include composition boundaries
- it describes aliasing at the command-buffer/channel-routing layer
- it leaves room for macro-by-reference to use the feature without implying
  ambient parent visibility

If we want to be even more explicit, macro call sites can refer to the map as:

- `refParamAliases`
- `macroRefAliases`

while the lower-level command-buffer property remains:

- `_channelAliases`

That gives a clean split between:

- macro-level purpose
- runtime-level mechanism

---

## Suggested Architecture

Recommended implementation shape:

1. Extend macro/function parameter metadata with by-reference kinds.
   - `var`
   - `data`
2. At call analysis time:
   - validate each by-reference actual
   - resolve its declaration kind
   - resolve its runtime name
3. Build a per-call alias/reference map.
4. Build the linked-channel set from those actual runtime names.
5. Invoke the macro with:
   - ordinary by-value args
   - a by-reference alias map
   - the caller buffer needed for linked access/order
6. Inside the macro:
   - formal by-reference names resolve through that alias map
   - unrelated names do not

This can be implemented either:

- in compiler lowering, by rewriting formal references to actual runtime names,
  or
- in runtime lookup/command routing, by consulting the macro-ref alias map

The runtime-map approach is usually simpler for preserving readable generated
macro bodies and source-facing names.

Recommended runtime shape:

- macro invocation builds `refParamAliases`
- child macro buffer receives those aliases as `_channelAliases`
- command-buffer routing resolves formal names through `_resolveAliasedChannelName`
- child buffers created under the macro inherit `_channelAliases`

This reuses the tested mechanics of the old low-level alias implementation,
while keeping the feature surface explicit and narrow.

---

## Compiler Responsibilities

Compiler responsibilities should be:

- parse by-reference parameter declarations
- mark the formal parameter kind in analysis
- validate call-site actuals
- resolve caller-side runtime names after renaming
- emit the alias/reference map for the invocation
- emit the linked-channel list for the invocation

The compiler should not:

- infer additional visible names beyond the explicit by-reference params
- treat this as ordinary parent-scope visibility

---

## Runtime Responsibilities

Runtime responsibilities should be:

- store the per-call alias/reference map
- resolve formal by-reference names to actual caller-owned channels
- route reads/writes/commands to the actual runtime channel names
- preserve normal ordering through linked buffers
- inherit alias projections into nested child buffers created under the macro
- keep direct runtime names stable without double-remapping

The runtime should not:

- expose the alias mapping as a general fallback for arbitrary unknown names
- let unrelated macro locals resolve through the alias map

The currently available low-level runtime hooks for this are:

- `_setChannelAliases(map)`
- `_inheritChannelAliases(parentMap)`
- `_resolveAliasedChannelName(name)`
- `_channelAliases`

---

## Interaction With Existing Macro/Caller Architecture

This design is independent from `caller()` scheduling.

It does not require:

- `__caller__`
- `CALLER_SCHED_CHANNEL_NAME`
- caller-style all-callers buffers

Those exist because `caller()` schedules parent-visible output subtrees.

By-reference macro params are a different problem:

- explicit channel aliasing and ordered channel access

So the interaction should be:

- caller scheduling stays as it is
- by-reference params add explicit alias/channel-binding behavior inside macro
  execution

---

## Examples

## By-reference var

```cascada
function bump(var x)
  x = x + 1
endfunction

var count = 3
bump(count)
```

Intended result:

- `count` becomes `4`

## By-reference data channel

```cascada
function addItem(data out, value)
  @out.items.push(value)
endfunction

data result
addItem(result, "a")
addItem(result, "b")
```

Intended result:

- `result.items == ["a", "b"]`

## Aliased names

```cascada
function copyTo(var x, data z)
  @z.value = x
endfunction

var currentValue = 7
data payload
copyTo(currentValue, payload)
```

Inside the macro:

- `x` refers to caller `currentValue`
- `z` refers to caller `payload`

---

## Test Plan

Add tests for:

- by-reference var parameter read
- by-reference var parameter reassignment
- by-reference data parameter command routing
- alias resolution at command-buffer ingress
- alias inheritance into nested child buffers inside the macro
- canonical runtime names staying unchanged when already resolved
- caller-side renamed runtime names still work
- duplicate same-name declarations in outer scopes still resolve correctly
- invalid actual expression for by-reference param
- type mismatch for by-reference param
- two formals aliasing the same actual
- by-reference params do not expose unrelated caller locals
- caller scheduling behavior remains unchanged

---

## Recommendation

This feature is a good fit for Cascada if it stays explicit.

The right model is:

- argument-by-reference aliasing
- not ambient scope visibility
- narrow linked-channel usage
- no wholesale restoration of the old generic buffer aliasing mechanism

Implementation recommendation:

- do reuse the previously tested low-level alias behavior
- do reintroduce it only in reduced form
- do rename the runtime properties/functions to `_channelAliases`,
  `_setChannelAliases`, `_inheritChannelAliases`, and
  `_resolveAliasedChannelName`
- do document clearly in code that the mechanism exists for explicit by-ref
  binding, not for ambient composition visibility

If old code is reused, it should be reused only in a reduced macro-specific
form with comments explaining:

- this aliasing exists because by-reference macro params bind formal names to
  caller-owned runtime channels
- it must not be treated as a general composition visibility feature
