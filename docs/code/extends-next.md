# `extends-next`: Class-System Composition Architecture

## Overview

`extends` gives Cascada scripts and templates class-based inheritance.
This document describes the target architecture, not a claim that every
template-side behavior already matches today's Nunjucks-compatible semantics.

| JS OOP | Cascada |
|---|---|
| `class C extends B` | `C.script` with `extends "B.script"` |
| Constructor body | Code outside methods/blocks |
| `super()` in constructor | The `extends "parent.script"` line |
| Method | script `method name(args)` / template `{% block name(args) %}` |
| Override | Same method name in a descendant file |
| Adding instance variables in a subclass | `shared` declarations in any descendant file |
| `super()` in a method | `super()` |
| Instance variable | `shared var x`, `shared text t`, `shared data d`, `shared sequence s` |
| `new X({ init })` | `import "X.script" as ns with { init }` |
| `this` | The namespace object `ns` |
| Multiple instances | `import ... as ns1`, `import ... as ns2` |

### Two Ways to Run a Hierarchy

**Render the script directly** — render `C.script` as the entry point. The
hierarchy runs; C's buffer is the root and its output is the result.

**Namespace instantiation** — `import "C.script" as ns with { ... }` creates an
independent instance in an isolated buffer. The importing script drives output;
`ns` exposes methods and `shared` channels as a component.

The inheritance mechanism is identical in both cases.

### Return Values

The most-derived child's explicit `return` takes precedence. If C returns
explicitly, any `return` in an ancestor constructor is ignored. If C has no
explicit return, the nearest ancestor's explicit return propagates up — the same
"most-derived wins" rule as method overrides.

---

## Execution Model

The `extends "parent.script"` line is the constructor-chain call. Code before
it is pre-extends code; code after it runs once the ancestor chain has finished.

```cascada
// C.script (most-derived)
shared var theme = "dark"
extends "B.script"
count = count + 1

// B.script
shared var count = 0
extends "A.script"

// A.script (root ancestor)
method buildHeader()
  return "Default header"
endmethod
var header = buildHeader()
```

Runtime nesting for `C extends B extends A`:

```
C pre-extends code              (C's root buffer)
  B pre-extends code            (child buffer)
    A's full body               (child buffer)
      A's own async blocks
  B post-extends code
C post-extends code
```

Each level independently drives its own code. `extends` is the synchronization
point where that level waits for all inner ancestors to finish before continuing.

C's buffer is always the root buffer; B and A run inside nested child buffers:

```
C's root buffer
  extends-B child buffer
    extends-A child buffer
      A's constructor commands
```

`findChannel` traverses up the parent chain, so `shared x` in A or B walks up
to C's root automatically. Lookup is not the registration mechanism, though:
hierarchy bootstrap must pre-register the root-owned shared channels for the
instance before constructor code starts running.

---

## The `shared` Keyword

`shared` declares instance state visible across the entire inheritance
hierarchy. Any level that declares `shared x` with the same name refers to the
same channel.

All existing channel types are intended to be supported:

```cascada
shared var theme = "dark"
shared text log
shared data state
shared sequence db
```

`shared sequence` is not a new channel kind. It reuses the existing `sequence`
channel semantics, placing that sequence channel in the shared instance state
for the whole hierarchy.

The exact initializer/default rule for `shared sequence` is still an
implementation choice that must be pinned down in the implementation plan
before coding that step. The architecture only requires that it participate in
shared instance state; it does not depend on a particular default-policy shape.

### Semantics

`shared x = default` is an initialize-if-not-set declaration: the value is
written only if the channel has not already received a value. A `shared` channel
set by a `with { }` argument or by a descendant's pre-extends code will not be
overwritten by an ancestor's `shared x = default`.

`shared x` without an assignment declares participation in the channel without
providing a default.

A regular unconditional assignment (`x = newValue`) in constructor code
overwrites whatever is currently in the channel, regardless of whether it was
set earlier.

### `shared` vs `extern`

`extern` is retained for non-extends composition. It means "required input from
a caller's `with { }` block." `shared` means "instance state jointly owned by
the hierarchy." They are distinct concepts with distinct keywords.

---

## Method Hoisting and Dynamic Dispatch

### Hoisting

All methods across the entire hierarchy are registered before any constructor
code runs. Registration is most-derived first: C's methods first, then B's (for
names C did not define), then A's. Position within a file does not matter — a
method declared at the bottom of C.script is visible to C's pre-extends code at
the top.

For scripts, override points use `method ... endmethod`. For templates, they use
`{% block name(args) %} ... {% endblock %}`.

### Dynamic Dispatch

Method calls use JS-style dynamic dispatch: the most-derived override is always
invoked, regardless of which ancestor issues the call.

```cascada
// A.script
method buildHeader()
  return "Default header"
endmethod

// In A's constructor:
var header = buildHeader()   // dispatches to C's override, not A's own definition
```

### Safety Rule

If A's constructor calls a method and the child's override reads a `shared`
variable that the child only sets in its post-extends code, that variable is not
yet set when A runs. The rule:

> Methods called from an ancestor constructor should only read `shared`
> variables initialized in descendant pre-extends code or supplied via `with { }`.

This is a design contract, not compile-time enforcement — the same constraint
that exists in JS class constructors.

---

## `super()` Inside Methods

`super()` inside a method calls the next ancestor in the chain that defines the
same method name. If B overrides a method and C overrides it too, C's `super()`
calls B's version, and B's `super()` calls A's.

```cascada
// C.script
method buildHeader()
  return "<strong>" + super() + "</strong>"
endmethod

// B.script
method buildHeader()
  return "<em>" + super() + "</em>"
endmethod

// A.script
method buildHeader()
  return "Title"
endmethod
```

`super()` is resolved at runtime to the next ancestor that defines the same
method name. The block/method table is assembled during hierarchy instantiation,
so the dispatch step is inherently runtime-based.

---

## Instantiation: `import ... as ns with { ... }`

```cascada
import "Component.script" as ns with { theme: "dark", label: "OK" }
```

This creates an independent instance of `Component.script` and its entire
ancestry. Each `import ... as ns` produces its own root buffer, its own `shared`
channels, and its own method table.

### `with { }` Values

`with` values are pre-loaded into the root instance state before any constructor
code runs. They cannot be overridden by any `shared x = default` declaration
anywhere in the hierarchy.

This reuse is about timing and value-capture semantics, not about reusing the
exact `extern` storage model unchanged. For `extends` hierarchies, `with { }`
preloads shared instance state; for ordinary composition imports/includes it
continues to satisfy `extern` inputs. The runtime must distinguish the two cases
by the import form: `import ... as ns` → shared instance preload; plain
`import` / `include` → extern satisfaction.

### The Namespace Object

`ns` exposes:

- All methods from the hierarchy, with most-derived override winning
- All `shared` channels as readable properties
- Method calls as `ns.methodName(args)`, executing with `ns`'s root buffer as
  the command target

### Multiple Instances

```cascada
import "Button.script" as okBtn     with { label: "OK" }
import "Button.script" as cancelBtn with { label: "Cancel" }
```

`okBtn` and `cancelBtn` are completely independent — separate root buffers,
separate `shared` channel state, no cross-instance coupling.

---

## Namespace Method Call Ordering

Using `!` (`ns!.method()`) serializes all calls through the `ns` sequence key
globally — including calls that touch completely different channels. The goal is
**channel-level ordering**: calls that write the same channel are sequenced;
calls on disjoint channels run concurrently.

See `docs/code/namespace-method-ordering.md` for the full design spec. This
section summarizes the key points.

### DFS Order Is Program Order

The calling buffer iterator processes commands in depth-first order — a total
ordering that matches source-code order. Because `apply()` is synchronous, every
call command registers its ordering information before the iterator moves to the
next command. No explicit position metadata is needed: DFS order of registration
is program order.

### The Coordination Channel

Each namespace instance owns a coordination channel. Its `_target` is a promise
map `{ channelName: Promise }`, where each entry resolves when the last committed
write to that channel has been applied by the namespace buffer iterator.
Initially all entries are resolved.

Channel metadata — `{ reads: Set, writes: Set }` per method — comes from
single-file static analysis of the method body, embedded in the method object at
compile time. No call-site analysis is needed. The existing analysis already
computes both `mutatedChannels` (writes) and `usedChannels` (reads + writes) on
every node; the read-only set is `usedChannels − mutatedChannels`. No new
traversal is required — the sets just need to be filtered to shared instance
channels and attached to the method object.

### How the Call Command Works

When the calling buffer iterator applies a namespace method call command,
`apply()` runs synchronously:

1. **Capture deps**: for each channel in `reads ∪ writes`, read `target[ch]` as
   a dependency promise.
2. **Register writes**: for each channel in `writes`, create a new deferred
   `done[ch]` and set `target[ch] = done[ch].promise` before `apply()` returns.
   Any subsequent command that touches `ch` will see this new pending promise.
3. **Fire and return**: launch an async operation and return immediately.

The async operation waits for all deps and resolves the call's arguments,
executes the method (which creates a child buffer in the namespace), then
resolves `done[ch]` for all write channels when `onLeaveBuffer` fires on that
child buffer.

### Ordering Rules

| Scenario | Enforced? | Mechanism |
|---|---|---|
| Write-after-write (same channel) | Yes | Second call's deps include first call's `done[ch]` |
| Read-after-write (same channel) | Yes | Read's deps include write's `done[ch]` |
| Write-after-read (same channel) | No | Reads do not update `target[ch]`; write sees same predecessor as read |
| Concurrent writes on disjoint channels | Concurrent | Independent `done` promises; no shared deps |

The write-after-read non-enforcement is intentional: reads don't block later
writes. For fast-snapshot channels (`var`) this is always safe because the value
is already captured synchronously at `apply()` time. For other channel types,
write-after-read ordering is not guaranteed and callers must not rely on it.

### Write Committed Signal

Write-committed is signaled by `onLeaveBuffer` on the method's child buffer in
the namespace: when the iterator finishes traversing that child buffer, every
write command inside it has been applied. The deferred `done[ch]` promises then
resolve, unblocking downstream calls waiting on those channels.

`WaitResolveCommand` is not used here — it signals at a specific command
mid-buffer; the entire child buffer is the unit of completion for
write-committed.

`getFinishedPromise()` on `CommandBuffer` is also not used here.
`getFinishedPromise()` resolves when the buffer is done *receiving* commands
(scheduling complete), not when the iterator has *applied* them. `onLeaveBuffer`
is the correct signal for write-committed.

### Read Commands

A call that only reads channel `ch` includes `target[ch]` in its deps. It does
not update `target[ch]`, so later write commands are not blocked by that pending
read.

### Fast-Snapshot Reads

For channels whose current value can be captured synchronously — notably `var`,
whose value lives directly on the namespace's `_target` — the value is read at
`apply()` time, synchronously, in DFS order, before any subsequent command's
`apply()` runs. No dependency promise is needed and later writes are not blocked.

This matches the existing fast-snapshot optimization in the buffer iterator where
such commands never enter `_pendingObservables`.

---

## Initialization Priority

1. **`with { }` values** — pre-loaded before any constructor runs; cannot be
   overridden.
2. **`shared x = default` declarations** — initialize-if-not-set; whichever
   constructor level runs first wins. C's pre-extends code runs before B's,
   which runs before A's, so the most-derived child's default takes precedence
   over ancestor defaults.

Unconditional assignments in post-extends code run after the ancestor chain
completes and overwrite whatever was set during construction — they are not
subject to the initialize-if-not-set rule.

### Cross-Level Unconditional Writes

The initialize-if-not-set rule applies only to `shared x = default`
declarations. Plain unconditional writes follow normal buffer ordering.

With C as the root buffer, C's pre-extends commands are enqueued before the
extends child-buffer slot, so an ancestor's later unconditional write can
overwrite an earlier child write. That is intentional and distinct from the
default-initialization rule.

---

## Template Composition

The same model applies to templates:

- Template body code = constructor
- `{% block name(args) %}` definitions = methods
- `{% extends "parent.njk" %}` = constructor-chaining extends

`shared` channels work identically in templates. Treating code before
`{% extends %}` as pre-extends initialization and code after it as post-extends
code is a deliberate behavior change from classic Nunjucks-style expectations,
not something already true today.

---

## End-to-End Example

```cascada
// Base.script (A — root ancestor)
shared var theme = "light"

method renderTitle()
  return "Default Title"
endmethod

var title = renderTitle()
text out
out.append(title + " — theme: " + theme)

// Middle.script (B)
extends "Base.script"

// Top.script (C — most-derived)
shared var theme = "dark"

method renderTitle()
  return "Custom Title"
endmethod

extends "Middle.script"

// Instantiation
import "Top.script" as comp with { theme: "brand" }
var title2 = comp.renderTitle()
```

Execution: `theme` is pre-loaded as `"brand"` from `with { }`. C's
`shared var theme = "dark"` is a no-op. B has no pre-extends code. A's
`shared var theme = "light"` is also a no-op. A's constructor calls
`renderTitle()` — dynamic dispatch reaches C's override, returns
`"Custom Title"`. A then appends `"Custom Title — theme: brand"` to its text
output.

---

## Static Analysis

### `shared` Channels

Each file is compiled independently, without knowledge of which descendants will
extend it. At compile time, `shared x` in any file is compiled as "access
channel `x` via upward `findChannel` traversal." The physical channel
registration in C's root buffer is a runtime step that happens during hierarchy
bootstrap.

Analysis must:

- Identify `shared` channel reads and writes per file
- Propagate observable effects upward for buffer linking
- Not apply `extern` read-only boundary rules to `shared` channels — `shared`
  channels are writable by any hierarchy level

### Method Reads/Writes Analysis

The coordination channel for namespace method ordering requires each method
object to carry `{ reads: Set, writes: Set }` — the sets of shared channel
names the method body reads and writes respectively. The existing analysis
already computes `mutatedChannels` (writes) and `usedChannels` (reads + writes)
on every node's `_analysis`; the read-only set is
`usedChannels − mutatedChannels`. These sets need to be filtered to shared
instance channels only and attached to the compiled method object — no new
traversal pass is required.

### Method Table Construction

The override table is assembled at runtime during instantiation, most-derived
first. Static analysis records method signatures per file; the runtime builds
the dispatch table.

---

## Implementation Notes

### Two-Phase Hierarchy Bootstrap

The target model requires an explicit bootstrap phase before constructor
execution:

1. Resolve the full ancestry chain (most-derived to root).
2. Register the shared-channel schema in the instance root buffer.
3. Preload `with { }` values into shared instance state.
4. Build the override/dispatch table for methods, most-derived first.
5. Only then begin constructor execution with nested child buffers.

This bootstrap phase makes method hoisting real and gives a concrete place for
shared-channel registration.

### Root Buffer Inversion

Currently `compileAsyncExtends` in `src/compiler/inheritance.js` uses a
sequential hand-off model: child completes, then parent runs `rootRenderFunc()`.
The new model inverts this: C's buffer is the root, and B plus A execute inside
nested child buffers. `src/compiler/compiler-async.js` needs corresponding
changes around root completion and instance finalization.

Return threading should be rooted at the instance root: constructors report into
one root-owned return/result slot, with most-derived explicit return taking
precedence over ancestor fallback returns.

### `getFinishedPromise()` on `CommandBuffer`

`getFinishedPromise()` from `docs/code/caller.md` is useful when a caller needs
to know that a buffer has finished *receiving* commands. It is **not** the
correct synchronization primitive for `extends` post-constructor ordering or
namespace method write-committed ordering, because those cases need
*apply-complete* visibility. Those boundaries should use `onLeaveBuffer`
instead (with `WaitResolveCommand` at an `extends` site when surrounding code
must pause until ancestor commands have been applied).

### Namespace Method Calls

Namespace method calls (`ns.method()`) use function-call boundaries, not
template-rendering boundaries, so there is no late-attachment problem.
Channel-level ordering is handled by the coordination channel described above
and in `docs/code/namespace-method-ordering.md`.

### Error and Poison Propagation

Constructor and method execution follows normal Cascada Poison rules across the
hierarchy boundary:

- Value-consumption failures poison the affected writes and effects.
- Post-extends code that depends on poisoned values becomes poisoned through
  normal dataflow rules.
- Real invariant/runtime errors still propagate as real errors.

Root-buffer inversion does not change those rules. It only changes where child
buffers attach and where their completion is awaited.

### Compatibility

The "copy now, keep promises as promises" capture behavior from
`docs/code/composition-update.md` should be reused, but extends/shared
preloading is a distinct runtime path from ordinary `extern` composition.
`extern` continues to work for non-extends imports. `shared` is additive — it
does not break the existing `extern` / `with` pipeline.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| C's buffer is the root | Upward `findChannel` traversal gives B and A access to shared channels without aliasing |
| `shared` not `extern` | `extern` means caller-provided composition input; `shared` means hierarchy instance state |
| Initialize-if-not-set for `shared x = default` | Most-derived child runs first, so child defaults naturally win over ancestor defaults |
| Method hoisting before constructor code | All levels see the complete override table before any constructor runs; matches JS class semantics |
| JS-style dynamic dispatch | Parent constructor calls child's override — same mental model as JS |
| `import ... as ... with` = `new X({...})` | Each import is a fully independent instance with its own root buffer |
| `extends` = nested async boundary | Consistent with other structural async boundaries |
| Coordination channel for `ns.method()` calls | `_target` as a promise map gives channel-level ordering without globally serializing; DFS `apply()` enforces program order |

---

## Compatibility Requirements

Must not break:

- Plain scripts and templates without `extends`
- `import` without `as ns`
- Existing `extern` / `with` pipeline for non-extends composition
- `caller()` in macros, documented in `docs/code/caller.md`
- Waited-loop text materialization
- Sequential `!` paths

Must enable:

- `shared` channels readable and writable at any hierarchy level
- JS-style dynamic dispatch from ancestor constructors
- Multiple independent instances via `import ... as`
- `with` values overriding `shared` defaults
- Post-extends code in any ancestor
