# `extends-next`: Class-System Composition Architecture

## Overview

This document describes the next-generation `extends`/composition architecture for Cascada. The model treats every script and template as a **class**:

- Code outside methods/blocks is a **constructor**.
- `extends` chains constructors the same way `super()` chains class constructors in JS.
- `shared` channels are **instance variables** visible across the entire hierarchy.
- `import "X.script" as ns with { ... }` is `new X({ ... })` — each import is an independent instance.

---

## The Class Metaphor

| OOP concept | Cascada equivalent |
|---|---|
| Class definition | Any `.script` or `.njk` file |
| Constructor | Code outside methods/blocks |
| Method | `method name(args)` (script) or `block name` (template) |
| Overriding a method | Declaring the same method name in a descendant |
| `super()` | `super()` inside a method, calls the next ancestor's version |
| Inheritance | `extends "parent.script"` |
| Instance variable | `shared var x`, `shared text t`, `shared data d`, `shared sequence s` |
| `new X({ ... })` | `import "X.script" as ns with { ... }` |
| `this` / `self` | The namespace object `ns` |
| Independent instances | Multiple `import ... as ns1`, `import ... as ns2` |

---

## The `shared` Keyword

`shared` declares an instance variable that is visible across the entire inheritance hierarchy. Any level that declares `shared x` with the same name refers to the same channel.

All channel types are supported:

```
shared var theme = "dark"
shared text log
shared data state
shared sequence db
```

### Semantics

`shared x = default` is an **initialize-if-not-set** declaration: the value is written only if the channel has not already received a value. A `shared` channel set by a `with { }` argument or by a descendant's pre-extends code will not be overwritten by an ancestor's `shared x = default`.

`shared x` without an assignment declares participation in the channel without providing a default.

A regular unconditional assignment (`x = newValue`) in any constructor code overwrites whatever is currently in the channel, regardless of whether it was set earlier.

### `shared` vs `extern`

`extern` is retained for non-extends composition. It means "required input from a caller's `with { }` block." `shared` means "instance state jointly owned by the hierarchy." They are distinct concepts with distinct keywords.

---

## Constructor Chaining

The `extends` keyword is the equivalent of a `super()` call. Code before `extends` in a file is that level's pre-super initialization; code after `extends` in the same file is its post-super code.

```
// C.script (most-derived child)
shared var theme = "dark"    // C's default — initialize-if-not-set; runs first
shared var count = 0
extends "B.script"           // ← constructor chain; C waits here for B and A to finish
count = count + 1            // C's post-super code — runs after B and A complete

// B.script (intermediate)
shared var count = 0         // lower priority — only applies if C didn't set count
extends "A.script"
// B's post-super code here

// A.script (root ancestor — no extends)
method buildHeader()
  text "Default header"
endmethod
buildHeader()                // A drives its own orchestration
```

### Execution Order

The hierarchy `C extends B extends A` produces this conceptual nesting at runtime:

```
C pre-extends code           (C's root buffer)
  B pre-extends code         (child buffer of C's root)
    A's full body            (child buffer of B's buffer)
  B post-extends code        (B's buffer)
C post-extends code          (C's root buffer)
```

Each ancestor runs inside a nested async boundary created by the descendant below it — the same child-buffer model used by `if`, `for`, and `macro` blocks. This is not a sequential hand-off.

Each level independently drives its own code. A drives its own orchestration. B drives its own pre- and post-extends logic. C drives its own. The `extends` line is the synchronization point where a level waits for all inner ancestors to finish before continuing.

---

## Buffer Structure

C's buffer is the **root buffer**. B and A execute inside nested child buffers.

```
C's root buffer                        ← shared channels registered here
  └── extends-B child buffer
        └── extends-A child buffer
              └── A's constructor commands
                    └── (A's own async child buffers, if any)
```

### Why C's Buffer Is the Root

`findChannel` traverses up the parent chain. Because A's buffer is a grandchild of C's root, any `shared x` access in A walks up through B's buffer and finds the channel in C's root. No special routing or aliasing is needed — the natural upward traversal delivers shared state automatically.

### Channel Registration

`shared x` is declared in each file independently. At runtime, when the hierarchy is assembled by the most-derived child's instantiation, C's root buffer owns the physical channel. B's and A's `findChannel` calls for `x` traverse upward and resolve to that same channel. All writes from any level land in the same place.

---

## Method Hoisting and Dynamic Dispatch

### Hoisting

All methods across the entire hierarchy are registered **before any constructor code runs**. Registration is bottom-up: C's methods first (highest priority), then B's (for any names C did not define), then A's. Position within a file does not matter — a method declared at the bottom of C.script is visible to C's pre-extends code at the top.

### Dynamic Dispatch

Method calls use **JS-style dynamic dispatch**: the most-derived override is always invoked, regardless of which ancestor issues the call.

```
// A.script
method buildHeader()
  text "Default header"
endmethod

// In A's constructor:
buildHeader()    // dispatches to C's override, not A's own definition
```

This matches JS class constructor semantics: calling a method from the parent constructor always reaches the child's override.

### Safety Rule

If A's constructor calls a method and the child's override reads a `shared` variable that the child only sets in its **post-extends** code, that variable is not yet set when A runs. The rule:

> Methods called from an ancestor's constructor should only read `shared` variables initialized in a descendant's pre-extends code or supplied via `with { }`.

This is a design contract, not a compile-time enforcement — the same implicit constraint present in JS class constructors.

---

## `super()` Inside Methods

`super()` inside a method calls the next ancestor in the chain that defines the same method name. If B overrides a method and C overrides it too, C's `super()` calls B's version, and B's `super()` calls A's.

```
// C.script
method buildHeader()
  text "<strong>"
  super()       // calls B's buildHeader
  text "</strong>"
endmethod

// B.script
method buildHeader()
  text "<em>"
  super()       // calls A's buildHeader
  text "</em>"
endmethod

// A.script
method buildHeader()
  text "Title"
endmethod
```

`super()` is resolved at compile time to the next ancestor that defines the same method name.

---

## Instantiation: `import ... as ns with { ... }`

```
import "Component.script" as ns with { theme: "dark", label: "OK" }
```

This creates an independent instance of `Component.script` and its entire ancestry. Each `import ... as ns` produces its own root buffer, its own `shared` channels, and its own method table.

### `with { }` Values

`with` values are pre-loaded into the root buffer **before any constructor code runs**. They cannot be overridden by any `shared x = default` declaration anywhere in the hierarchy.

### The Namespace Object

`ns` exposes:

- All methods from the hierarchy (most-derived wins)
- All `shared` channels as readable properties
- Method calls as `ns.methodName(args)`, executing with `ns`'s root buffer as the command target

### Multiple Instances

```
import "Button.script" as okBtn     with { label: "OK" }
import "Button.script" as cancelBtn with { label: "Cancel" }
```

`okBtn` and `cancelBtn` are completely independent — separate root buffers, separate `shared` channel state, no cross-instance coupling.

---

## Initialization Priority

1. **`with { }` values** — pre-loaded before any constructor runs; cannot be overridden.
2. **`shared x = default` declarations** — initialize-if-not-set; whichever constructor level runs first wins. C's pre-extends code runs before B's, which runs before A's, so the most-derived child's default takes precedence over ancestor defaults.

Unconditional assignments in post-extends code run after the ancestor chain completes and overwrite whatever was set during construction — they are not subject to the initialize-if-not-set rule.

---

## Template Composition

The same model applies to Nunjucks-style templates:

- Template body code = constructor
- `{% block name %}` definitions = methods (overridable per hierarchy level)
- `{% extends "parent.njk" %}` = constructor-chaining extends

`shared` channels work identically in templates. Code before `{% extends %}` in a child template is pre-extends initialization; code after it is post-extends code.

---

## End-to-End Example

```
// Base.script (A — root ancestor)
shared var theme = "light"    // lowest-priority default

method renderTitle()
  text "Default Title"
endmethod

renderTitle()                 // calls most-derived override due to dynamic dispatch
text " — theme: " + theme

// Middle.script (B)
extends "Base.script"
// no overrides, no pre/post code here

// Top.script (C — most-derived)
shared var theme = "dark"     // wins over Base's default

method renderTitle()
  text "Custom Title"
endmethod

extends "Middle.script"

// Instantiation
import "Top.script" as comp with { theme: "brand" }
comp.renderTitle()
```

Execution: `theme` is pre-loaded as `"brand"` from `with { }`. C's `shared var theme = "dark"` is a no-op (already set). B has no pre-extends code. A's `shared var theme = "light"` is also a no-op. A's constructor calls `renderTitle()` — dynamic dispatch reaches C's override — outputs `"Custom Title"`. Then appends `" — theme: brand"`.

---

## Static Analysis

### `shared` Channels

Each file is compiled independently, without knowledge of which descendants will extend it. At compile time, `shared x` in any file is compiled as "access channel `x` via upward `findChannel` traversal." The physical channel registration in C's root buffer is a **runtime step** that happens when the hierarchy is instantiated.

Analysis must:

- Identify `shared` channel reads and writes per file
- Propagate observable effects upward for buffer linking (same mechanism as `extern` propagation)
- Not apply `extern` read-only boundary rules to `shared` channels — `shared` channels are writable by any hierarchy level

### Method Table Construction

The override table is assembled at runtime during instantiation, bottom-up. Static analysis records method signatures per file; the runtime builds the dispatch table.

---

## Implementation Notes

### Root Buffer Inversion

Currently `compileAsyncExtends` (`src/compiler/inheritance.js`) uses a sequential hand-off model: child completes, then parent runs `rootRenderFunc()`. The new model inverts this: C's buffer is the root, and B+A execute inside nested child buffers. `_emitAsyncRootCompletion` in `src/compiler/compiler-async.js` requires corresponding changes.

### `getFinishedPromise()` on `CommandBuffer`

`getFinishedPromise()` (specified in `caller.md`) is also useful for `extends` boundaries: the extends-boundary child buffer exposes its finished promise so the surrounding constructor code knows when the nested ancestor chain has finished scheduling all its commands.

### Namespace Method Calls

Namespace method calls (`ns.method()`) use function-call boundaries, not template-rendering boundaries. The child buffer for a method invocation is registered synchronously when the call command fires, so there is no late-attachment problem and no special coordination channel is needed.

### Compatibility

The `with { }` value pre-loading from `composition-update.md` (Steps C/D) is reused unchanged. `extern` continues to work for non-extends imports. `shared` is additive — it does not break the existing `extern`/`with` pipeline.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| C's buffer is the root | `findChannel` upward traversal gives B and A access to shared channels without aliasing |
| `shared` not `extern` | `extern` = input from caller; `shared` = hierarchy instance state — distinct concepts |
| Initialize-if-not-set for `shared x = default` | Most-derived child runs first, so its defaults naturally win over ancestor defaults |
| Method hoisting before constructor code | Parent sees the full override table; matches JS class semantics |
| JS-style dynamic dispatch | Parent constructor calls child's override — same mental model as JS |
| `import...as...with` = `new X({...})` | Each import is a fully independent instance with its own root buffer |
| `extends` = nested async boundary | Consistent with `if`/`for`/`macro` — no special-cased execution model |

---

## Compatibility Requirements

Must not break:

- Plain scripts and templates without `extends`
- `import` without `as ns` (side-effect or value imports)
- Existing `extern` / `with` pipeline for non-extends composition
- `caller()` in macros (separate mechanism, documented in `caller.md`)
- Waited-loop text materialization
- Sequential `!` paths

Must enable:

- `shared` channels readable and writable at any hierarchy level
- JS-style dynamic dispatch from ancestor constructors
- Multiple independent instances via `import...as`
- `with` values overriding `shared` defaults
- Post-extends code in any ancestor
