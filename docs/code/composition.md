# Composition Architecture

## Status

This document describes the current payload-based composition architecture for
Cascada's async path. The sync compiler remains the Nunjucks-compatible
implementation and is intentionally not retrofitted with Cascada payload
transport.

## Core Model

Composition passes values through an explicit payload object. The receiver sees
payload keys as ordinary bare-name inputs in its own execution context. Payload
is copied at the composition boundary; it is not shared state and does not give
the receiver access to caller-local variables beyond the values explicitly
passed.

The supported async composition boundaries are:

- `import ... with ...`
- `from ... import ... with ...`
- `include ... with ...`
- `extends ... with ...`
- `component ... with ...`

The supported input forms are:

- `with name, otherName`
- `with { name: expression, otherName: expression }`
- `with context`
- `with context, name`
- `with context, { name: expression }`
- `without context` where the grammar supports it

Named inputs and object-style inputs are evaluated in the caller. Object-style
inputs are merged last, so they override earlier shorthand inputs with the same
key.

## Render Context

`with context` exposes the original render context at the receiving boundary. It
does not expose the caller's current local variables, channel declarations, or
composition internals. Explicit payload keys win over render-context keys.

Without `with context`, render-context values do not flow through composition
unless the caller passes them explicitly.

## Shared State

Payload and shared state are separate mechanisms.

- Payload is boundary input and is read by bare name.
- Shared state is inheritance/component state and is read or written through
  `this.<name>` inside the hierarchy.
- Passing `with { theme: "dark" }` does not write `this.theme`.

To initialize shared state from payload, read the payload key in the shared
default expression or assign it explicitly in constructor code.

## Runtime Shape

The runtime represents composition input as:

```js
{
  rootContext,
  payloadContext
}
```

Use `runtime.createCompositionPayload(rootContext, payloadContext)` to build
that shape. `rootContext` is the working context for the composed root.
`payloadContext` is the stable payload baseline reused by inherited methods and
blocks so constructor-local variables cannot leak into later calls.

`Context` owns mutable local variables separately from a shared
`ContextExecutionState` object. Context forks share execution state for block
registries and deferred exports, while composition forks receive a fresh local
variable object containing only the payload/root context for that boundary.

## Compiler Ownership

Composition input transport is compiled at the composition site:

- import/from/include compile explicit payload expressions into a context object
- extends captures its payload once and passes it through the parent chain
- component startup receives its payload object and creates an independent
  component root context

Ordinary bare-name lookup must not recover missing composition values from
parent/root buffers. If a value is visible in the receiver, it must have arrived
through payload, render context via `with context`, globals, or declared shared
state.

## Sync Compatibility

The sync compiler keeps existing Nunjucks-compatible behavior. In sync mode,
explicit named/object Cascada payload inputs are rejected where they would
require async composition transport. Do not add payload machinery to the sync
compiler unless the project deliberately changes the Nunjucks compatibility
contract.
