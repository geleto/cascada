
# Cascada Channel & Execution Model Simplification

## Goals

This proposal simplifies Cascada by removing legacy, template-driven abstractions while preserving its defining properties:

* source-order deterministic execution
* implicit concurrency
* transactional recovery semantics

The redesign focuses on **explicit channels**, **explicit snapshot points**, and **lexically isolated modules**, resulting in a smaller, clearer, and more approachable language surface.

---

## 1. From Implicit Handlers to Typed Channels

### The Old Model

Historically, Cascada used **implicit global handlers**:

```cascada
@data.push(1)
@text("hello")
```

Custom handlers (for example, turtle graphics or database writers) were registered through APIs and invoked via special `@handler(...)` syntax.

This model had several drawbacks:

* channel targets were implicit and globally scoped
* custom handlers required registration APIs
* channel construction and value materialization were conflated
* reading code required prior Cascada knowledge

---

### The New Model: Typed Channels

Implicit handlers are replaced with **explicit, typed channels**:

```cascada
data result
text title
```


Semantics:

* channels are **write / call only**
* writes are buffered in source order
* no value exists until a snapshot or `return` occurs

This makes channel construction explicit, local, and visible in the code.

---


### Built-in Channel Types

Cascada defines two built-in channel types:

* `data` — structured data composition
* `text` — text accumulation

These types:

* directly correspond to the former `@data` and `@text` handlers
* **always support snapshotting**
* have well-defined materialization semantics

Snapshot results:

* snapshotting a `data` variable produces a structured value
* snapshotting a `text` variable produces a string

---


All custom handlers are unified under a single channel abstraction:

```cascada
```


* replaces the old "custom output handler" concept
* buffers commands during execution
* requires no registration API
* is initialized from a context value or factory
* allows exactly one assignment


* if runtime conditions prevent snapshot detection at compile time, `snapshot()` returns a poisoned value

This keeps the abstraction unified without weakening semantics.

---

## 3. Snapshots (Explicit Materialization)

Snapshots convert buffered output into values.

### Snapshot Operation

```cascada
var x = result.snapshot()
```

Snapshot semantics:

* snapshots are **source-order reads**
* they may block until all prior buffered writes resolve
* they produce normal Cascada values
* subsequent writes do not affect the snapshot

Applicability:

* `data` variables always support snapshots
* `text` variables always support snapshots

Snapshots are **explicit everywhere**, including at `return`.

---

## 4. `return` in Scripts

Scripts support an explicit `return` statement.

```cascada
data arr
text message

arr.push(1)
message("hello")

return { data: arr.snapshot(), text: message.snapshot() }
```

### Snapshot Semantics of `return`

`return` expressions can contain snapshot calls like any other expression. The explicit `.snapshot()` calls make materialization visible and consistent throughout the language.

---

## 5. Removal of `capture`

The `capture` construct is fully removed.

### Rationale

* Its functionality is fully subsumed by:

  * typed channels
  * explicit snapshots
  * `return`
* It was the only construct that did not start a line
* It introduced special scoping semantics
* It duplicated channel buffering concepts

Equivalent pattern:

```cascada
data tmp
tmp.a = 1
tmp.b = 2
var value = tmp.snapshot()
```

This is clearer, uniform, and explicit.

---

## 6. Guard, Recovery, and Revert Semantics

### Guard Scope

`guard` defines a **transactional scope**.

It may guard:

* individual variables
* channels
* **entire types**

Examples:

```cascada
guard result, title, value
guard data
guard text, var
guard *
```

Type guards apply to **all variables of that type** declared in the scope.

---

### Snapshot Assignments Inside Guards

Snapshot assignments **do occur** inside guards, but their results are transactional.

Variables assigned to snapshots revert to the snapshot state from before the guard entry. This pre-guard state may be `none` if the channel had no content before the guard, or it may be an earlier snapshot state.

However, if the **channel being snapshotted** is listed in the guard set, the snapshot assignment is preserved (not reverted).

Example with guarded channel:

```cascada
data foo
foo.push(1)
var x = foo.snapshot()  // x = snapshot of [1]
guard foo {
  foo.push(2)
  var x = foo.snapshot()  // x = snapshot of [1, 2]
  // error occurs
}
// after recovery: x = snapshot of [1, 2] (preserved because foo is guarded)
```

Example without guarded channel:

```cascada
data foo
foo.push(1)
var x = foo.snapshot()  // x = snapshot of [1]
guard {
  foo.push(2)
  var x = foo.snapshot()  // x = snapshot of [1, 2]
  // error occurs
}
// after recovery: x = snapshot of [1] (reverted to pre-guard state)
```

Example where pre-guard state is `none`:

```cascada
data foo
guard {
  foo.push(1)
  var x = foo.snapshot()  // x = snapshot of [1]
  // error occurs
}
// after recovery: x = none (reverted to pre-guard state, which is none)
```

---

### `revert` Statement

`_revert()` is removed.

Instead, `guard` supports:

```cascada
revert value, result
revert *
```

Semantics:

* reverts listed variables to their state at guard entry
* applies to channel buffers and snapshot assignments
* does not poison execution
* execution continues after revert


* buffered commands are reverted

---

## 7. Module System Simplification

### Removed Constructs

The following constructs are removed:

* `extern`
* `reads`
* `writes`

These mechanisms were complex, error-prone, and encouraged implicit coupling.

---

### New Import Model

Scripts use explicit `export` / `import`.

Rules:

* imported scripts **cannot access parent scope**
* no implicit variable sharing
* all dependencies are explicit

This enforces lexical encapsulation and aligns with functional module systems.

---

### Channels Across Modules

Channels can be passed across module boundaries and assigned like any data:

```cascada
// module.csd
export data result

// main.csd
import { result } from './module.csd'
result.push(1)  // writes to imported channel
```

This follows standard data-data assignment semantics.

---

## 8. Removal of `include` for Scripts

`include` is removed **for scripts**.

### Rationale

* `include` originates from Nunjucks template composition
* it allows implicit access to parent scope
* it breaks encapsulation
* it complicates reasoning about execution, recovery, and side effects

Script composition should be:

* explicit
* value-based
* module-scoped

These goals are incompatible with script-level `include`.

### Templates

Template `include` remains fully supported for Nunjucks compatibility and structural template composition, where repeated elements are commonly included multiple times within a single template structure.

---

## 9. Blocks, Extends, and Caller Alignment

* `block` returns a value
* `caller()` already returns a value
* both follow snapshot + return semantics

This unifies Cascada's composition constructs under a consistent value-returning model.

---

## 10. Old-to-New Conceptual Mapping

| Old Concept               | New Concept                                |
| ------------------------- | ------------------------------------------ |
| `@data`                   | `data` channels                            |
| `@text`                   | `text` channels                            |
| implicit materialization  | explicit `.snapshot()` everywhere          |
| `capture`                 | channels + snapshot                        |
| `extern / reads / writes` | `export / import`                          |
| script `include`          | removed                                    |

Execution semantics remain source-order deterministic; only syntax and scoping are simplified.

---

## 11. Resulting Mental Model

A developer needs to understand only:

1. `var` — normal variables
3. `.snapshot()` — explicit materialization
4. `return` — with explicit snapshot calls
5. `guard` — transactional control (by name or by type)
6. `export` / `import` — explicit, encapsulated modules

Everything else is removed.

---

## Outcome

This proposal:

* removes legacy template-driven abstractions from scripts
* unifies built-in and custom channels
* makes materialization explicit and predictable
* enforces encapsulation
* reduces conceptual load without weakening Cascada's execution model
