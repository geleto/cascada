# `extends-next`: Class-System Composition Architecture

## Overview

This document describes the next-generation `extends`/composition architecture for Cascada. The central insight is that every Cascada script (and template) is implicitly a **class**:

- Code outside of methods is a **constructor**.
- `extends` is **inheritance**, triggering constructor chaining.
- `shared` channels are **instance variables** shared across the hierarchy.
- `import "X" as ns with { ... }` is `new X({ ... })` — each import creates an independent instance.

This model supports the **Template Method Pattern** (ancestor drives orchestration, descendants override steps), the **Strategy Pattern** (caller drives an imported stateful namespace), and **full OOP-style composition** with shared mutable state across the inheritance hierarchy.

---

## The Class Metaphor

| OOP concept | Cascada equivalent |
|---|---|
| Class definition | Any `.script` or `.njk` file |
| Constructor | Code outside methods/blocks |
| Method | `method name(args)` (script) or `block name` (template) |
| `super()` | `super()` call inside a method |
| Inheritance | `extends "parent.script"` |
| Instance variable | `shared var x`, `shared data d`, etc. |
| `new X({ ... })` | `import "X.script" as ns with { ... }` |
| `this` | The namespace object `ns` |
| Independent instances | Multiple `import ... as ns1`, `import ... as ns2` |

---

## The `shared` Keyword

### What It Is

`shared` declares an instance variable that is visible across the entire inheritance hierarchy. Any ancestor or descendant that declares `shared x` with the same name refers to the same channel in the root buffer.

### Supported Channel Types

Any channel type may be marked `shared`:

```
shared var theme = "dark"
shared text log
shared data state
shared sequence db
```

This means `shared` is not limited to variables — text buffers, data accumulators, and sequence paths can all be shared across the hierarchy.

### Semantics: Initialize-If-Not-Set

`shared x = default` is an **initialize-if-not-set** declaration. The assignment only takes effect if the channel has not already been set. Because the most-derived child (C) runs its pre-extends code first, C's assignment wins over B's, which wins over A's. A `with` value beats all.

Declaration without assignment (`shared var theme`) means: "I will read/write this channel, but I am not providing a default here."

### Why Not `extern`

`extern` is retained for non-extends composition — it means "required input from a caller via the `with { }` block." `shared` means "instance state shared across the hierarchy." These are distinct concepts and deserve distinct keywords.

---

## Constructor Chaining Execution Model

### Mental Model: `super()` at the `extends` Keyword

The `extends` line is the equivalent of a `super()` call. Code before `extends` is pre-super initialization; code after is post-super initialization.

```
// C.script
shared var theme = "dark"   // C's default (pre-super)
shared var count = 0

extends "B.script" {        // ← this IS the super() call
    // B runs here
}

count = count + 1           // C's post-super code
```

### Nested Execution Order

Given a three-level hierarchy `C extends B extends A`:

```
C pre-extends code          (in C's root buffer)
  extends B {               (async boundary, child buffer of C's root)
    B pre-extends code
      extends A {           (async boundary, child buffer of B's buffer)
        A's full body       (innermost — A drives its own orchestration)
      }
    B post-extends code
  }
C post-extends code
```

The nesting is important: each ancestor's constructor runs **inside** a nested async boundary created by the descendant below it. This is not a sequential hand-off — it is the same nested-child-buffer model used by `if`, `for`, and `macro` blocks.

### Who Drives the Flow

Each level drives its own flow independently. The root ancestor (A) runs its full constructor logic. B has a before and after slot around A's execution. C has before and after slots around B+A's execution. There is no single "driver" — each ancestor is its own execution unit.

---

## Buffer Structure

C's buffer is the **root buffer**. B and A execute inside nested child buffers. This is the reverse of what intuition might suggest.

```
C's root buffer           ← shared channels live here
  └── extends-B boundary buffer   (child of C's root)
        └── extends-A boundary buffer  (child of B's buffer)
              └── A's constructor commands
                  └── (A's own async blocks, if any)
```

### Why C's Buffer Is the Root

`findChannel` traverses upward through the parent chain. Because A's buffer is a grandchild of C's root, A can resolve `shared var theme` by walking up through B's buffer and into C's root. No special routing or aliasing is needed. The natural upward traversal delivers shared state automatically.

### Channel Ownership

Shared channels are **registered in C's root buffer** (the most-derived child's buffer). B and A declare `shared x` too, but since their buffers are children of C's root, `findChannel` resolves their reads and writes to C's root buffer's channel — the same physical channel. All writes to `shared x` from any level of the hierarchy land in the same place.

---

## Method Hoisting and Dynamic Dispatch

### Hoisting

Before any constructor code runs, **all methods are registered** across the entire hierarchy. This happens bottom-up: C's methods are registered first, then B's (as fallbacks for any methods C did not define), then A's (as fallbacks for anything B did not cover). The result is that when A's constructor runs, it sees the complete, fully-overridden method table.

Order within a single file does not matter. A method declared at the bottom of C.script is visible to C's pre-extends code at the top.

### Dynamic Dispatch (JS Semantics)

Method calls use **JS-style dynamic dispatch**: calling a method by name always invokes the most-derived override, regardless of which ancestor makes the call.

```
// A.script
method buildHeader()
  text "Default header"
endmethod

// A's constructor calls buildHeader
buildHeader()           // ← calls C's override, not A's
```

This is the same as `this.buildHeader()` in a JS constructor — the child's override is called even from the parent constructor.

### Safety Rule for JS Dispatch

This creates a known risk: if A's constructor calls `buildHeader()` and C's override of `buildHeader` reads `shared var title` that C sets in its **post-extends** code, `title` is not yet set when A's constructor runs. The safety rule:

> Methods called from an ancestor's constructor should only read `shared` variables that are set in a descendant's **pre-extends** code or supplied via `with { }`.

This rule is a documentation/design contract, not a compile-time enforcement. It mirrors the same risk in JS class constructors.

---

## Instantiation: `import ... as ns with { ... }`

### Syntax

```
import "Component.script" as ns with { theme: "dark", label: "OK" }
```

This creates a **new independent instance** of `Component.script` and its entire ancestry chain. Each `import ... as ns` call creates its own root buffer, its own shared channels, and its own method table. Multiple imports create multiple independent instances.

### `with { }` Values

`with` values are pre-loaded into the root buffer **before any constructor code runs**. They have the highest initialization priority and cannot be overridden by `shared x = default` declarations. This is the equivalent of passing constructor arguments.

### The Namespace Object

`ns` is the namespace object returned by the import. It exposes:

- All methods declared across the hierarchy (most-derived wins)
- All `shared` channels readable as properties
- Callable as `ns.methodName(args)` — invokes the method with `ns`'s buffer as execution context

### Multiple Instances

```
import "Button.script" as okBtn with { label: "OK" }
import "Button.script" as cancelBtn with { label: "Cancel" }
```

`okBtn` and `cancelBtn` are completely independent instances with no shared state. Each has its own root buffer, its own `shared` channels, its own method dispatch table.

---

## Initialization Priority

From highest to lowest priority:

1. **`with { }` values** — pre-loaded before any constructor runs; always wins
2. **Most-derived child's pre-extends assignments** — C runs first; its `shared x = v` sets x if `with` did not
3. **Intermediate ancestors' pre-extends assignments** — B runs next; sets x if C and `with` did not
4. **Root ancestor's assignments** — A runs last; sets x if no one above did
5. **`shared x = default` at any level** — initialize-if-not-set; first writer wins (C beats B beats A)

This ordering is a natural consequence of the constructor chaining execution order: C runs before B, which runs before A.

---

## `super()` Inside Methods

When a child overrides a method, it can call `super()` to invoke the parent's version:

```
// C.script
method buildHeader()
  text "<strong>"
  super()             // calls B's buildHeader, or A's if B didn't override
  text "</strong>"
endmethod
```

`super()` is a static call resolved at compile time to the next ancestor in the chain that defines the same method name.

---

## Template/Script Unification

The same model applies to Nunjucks-style templates:

- Template body = constructor
- `block` definitions = methods
- `extends "parent.njk"` = same constructor-chaining `extends`
- `{{ caller() }}` = method body invocation from macro caller
- `shared` channels work identically

For templates, code before `{% extends %}` is pre-super code; code after (if any) is post-super code. This is unusual but consistent with the model.

---

## Relationship to `caller()` Architecture

The `caller()` mechanism (documented in `caller.md`) uses a three-level buffer structure with `__caller__<id>` coordination channels because the caller body can produce observable commands that must be structurally attached before the macro's composition boundary finishes.

Namespace method calls via `ns.method()` do **not** need this mechanism. When a `SequenceCallCommand` fires from the caller's buffer, the child buffer for that method invocation is registered synchronously. There is no late-attachment problem because the child buffer registration happens at the moment the command is applied, not asynchronously afterward.

The `caller()` problem is about template-rendering boundaries. Method calls are function-call boundaries. These are fundamentally different and the `__caller__<id>` machinery is not needed for method dispatch.

---

## Static Analysis Considerations

### `shared` Channel Ownership

The analysis pass must determine that `shared x` declared in multiple files across the hierarchy refers to the same logical channel. The analysis for a complete `extends` chain must:

1. Collect all `shared` declarations from all ancestors.
2. Resolve name conflicts: same name = same channel.
3. Register the channel in the root buffer (most-derived child's buffer).
4. Route all reads and writes through `findChannel` upward traversal — no explicit aliasing needed.

### Method Table Construction

Static analysis for method hoisting must:

1. Collect all method definitions across the hierarchy.
2. Apply most-derived-wins ordering.
3. Make the full override table available before any constructor code is emitted.

### Read-Only Boundaries for `extern`

The existing `extern` read-only boundary rules remain unchanged. `shared` channels are different: they are writable by any level of the hierarchy. Analysis must not apply the `extern` read-only rule to `shared` channels.

---

## Implementation Notes

### Current Implementation vs This Design

The current `compileAsyncExtends` in `src/compiler/inheritance.js` uses a sequential hand-off model: child completes, then parent template runs `rootRenderFunc()`. The new model replaces this with nested async boundaries where C's buffer is the root and B+A execute inside nested child buffers.

The current `_emitAsyncRootCompletion` in `src/compiler/compiler-async.js` would need changes to support the new root-buffer-is-the-child model.

### Key Runtime Change: Who Owns the Root Buffer

Currently the base ancestor (A) effectively owns the root output buffer. In the new model, the most-derived child (C) owns the root buffer. This inversion is required for `shared` channel resolution via `findChannel` upward traversal to work correctly.

### `getFinishedPromise()` on `CommandBuffer`

The `caller.md` architecture already specifies adding `getFinishedPromise()` to `CommandBuffer`. This same mechanism is useful for the `extends` boundary: the extends-boundary child buffer can expose its finished promise so the surrounding constructor code knows when the nested ancestor chain has completed.

### Compatibility with Existing `extern` / `with` Pipeline

The `with { }` value pre-loading from Steps C/D of `composition-update.md` remains valid and is reused here. `extern` continues to work for non-extends imports. The new `shared` keyword is additive and does not break the existing `extern` path.

---

## Summary of Key Design Decisions

| Decision | Rationale |
|---|---|
| C's buffer is the root | Enables `findChannel` upward traversal for shared channel access without aliasing |
| `shared` not `extern` for hierarchy state | `extern` = "required from caller"; `shared` = "instance state"; distinct concepts |
| Initialize-if-not-set semantics | Most-derived child runs first so its default wins; consistent with JS |
| Method hoisting before constructor code | Matches JS class semantics; parent sees full override table |
| JS-style dynamic dispatch | Familiar mental model; parent constructor calls child's override |
| `import...as...with` = `new X({...})` | Clean class instantiation; each import is an independent instance |
| No `__caller__<id>` for method calls | Method invocations are function-call boundaries, not rendering boundaries |
| `extends` = nested async boundary | Same model as `if`/`for`/`macro` — consistent with rest of engine |

---

## Regression Requirements

Any implementation of this architecture must not break:

- Plain script/template files without `extends`
- `import` without `as ns` (side-effect-only imports)
- Existing `extern` / `with` pipeline for non-extends composition
- `caller()` in macros (separate mechanism, documented in `caller.md`)
- Waited-loop text materialization
- Sequential `!` paths

And it must enable:

- `shared` channels readable and writable from all levels of the hierarchy
- JS-style dynamic dispatch in ancestor constructors
- Multiple independent instances via `import...as`
- `with` values overriding `shared` defaults
- Post-extends code in any ancestor (not just the root)
