# `extends-next`: Inheritance Architecture

## Overview

`extends` gives Cascada scripts and templates a class-style inheritance model.

The runtime model is intentionally simple:

- one hierarchy instance owns one long-lived root command buffer
- constructor code writes directly into that root buffer
- each `extends` site creates one child buffer for the parent constructor chain
- each namespace method call creates one child buffer under the namespace buffer
- namespace operations are admitted immediately through a side-channel
- ordinary command-buffer ordering and dependency handling do the rest

## Core Principles

The architecture follows three rules:

- shared state lives on the instance root buffer
- constructors and namespace method calls run in child buffers
- child-owned inheritance metadata is available before that child's constructor
  code relies on it

Everything else follows from ordinary command-buffer tree behavior.

## OOP Mapping

| JS OOP | Cascada |
|---|---|
| `class C extends B` | `C.script` with `extends "B.script"` |
| Constructor body | Code outside methods/blocks |
| `super()` in constructor | The `extends "parent.script"` line |
| Method | script `method name(args)` / template `{% block name(args) %}` |
| Override | Same method name in a descendant file |
| `super()` in a method | `super()` |
| Instance variable | `shared var x`, `shared text t`, `shared data d`, `shared sequence s` |
| `new X({...})` | `import "X.script" as ns with { ... }` |
| `this` | The namespace object `ns` |
| Multiple instances | `import ... as ns1`, `import ... as ns2` |

## Two Ways to Run a Hierarchy

**Direct render**: render `C.script` or `C.njk` as the entry file. The
hierarchy runs and C's root buffer is the instance root.

**Namespace instantiation**: `import "C.script" as ns with { ... }` creates an
independent instance. The caller keeps its own output and uses `ns` to call
methods or observe shared state.

This model assumes a static parent chain. "Known" here means the parent paths
are declared statically in source and are not computed dynamically. It does not
mean the whole parent chain must already be loaded before constructor execution
starts.

## Bootstrap

Before any constructor code that depends on inherited dispatch starts, the
runtime bootstraps the local hierarchy state:

1. Resolve the static ancestry chain.
2. Register the child file's method metadata immediately at root start.
3. Register shared-channel schema on the instance root buffer.
4. Preload `with { }` values into shared state when namespace instantiation uses
   `with { }`.
5. Start constructor execution.

Parent methods register later, when each `extends` load boundary resolves. The
deferred-slot mechanism covers the window before those registrations arrive.

Both direct render and namespace instantiation use this same local bootstrap
shape.

On the new static inheritance / namespace-instantiation path:

- `with { }` preloads declared `shared` names only
- unknown `with` keys are an error
- this preload path does not target `extern`

For plain direct-render `extends`, there is no `with { }` preload at the
`extends` site. Shared defaults come from `shared` declarations plus descendant
pre-extends initialization.

`extern` remains the caller-input mechanism for ordinary composition paths such
as plain `import`, `from import`, and `include`.

## Constructor Chain

For `C extends B extends A`:

- C owns the instance root buffer
- B runs in a child buffer created at C's `extends` site
- A runs in a child buffer created at B's `extends` site
- shared channels live on the instance root buffer
- each file's own methods are registered before that file's constructor code
  relies on inherited dispatch; parent methods register later as `extends`
  boundaries resolve

Runtime nesting:

```text
C root buffer
  C pre-extends code
  extends-B child buffer
    B pre-extends code
    extends-A child buffer
      A constructor body
        A async children
    B post-extends code
  C post-extends code
```

Execution order:

1. C pre-extends
2. B pre-extends
3. A constructor
4. B post-extends
5. C post-extends

`extends` is therefore a constructor boundary, not a deferred parent-render
handoff.

## Async Boundary Semantics

Static script `extends` follows the same async-boundary model as `if` and other
control-flow boundaries:

- at the `extends` site, the current buffer immediately gets a child-buffer
  entry reserved in source order
- async work waits only for parent template/script resolution and loading
- once loaded, the parent constructor chain emits into that child buffer
- code after `extends` is still emitted immediately into the current buffer
- ordering comes from the ordinary hierarchical command-buffer traversal, not
  from blocking the parent on child apply-completion

So post-`extends` constructor code does not need a special apply barrier. It
stays after the parent constructor chain because the child buffer occupies that
position in the lane structure.

## `shared`

`shared` declares hierarchy-owned instance state. Any level that declares the
same shared name refers to the same root-owned channel.

Supported forms:

```cascada
shared var theme = "dark"
shared text log
shared data state
shared sequence db
```

Semantics:

- `shared x = default` means initialize-if-not-set
- `with { }` preload values win over shared defaults
- a more-derived shared default wins over an ancestor default
- shared declarations should be routed to the instance root at declaration time
  from the current buffer; they should not require a general-purpose root lookup
  API on `CommandBuffer`
- a later plain assignment is unconditional and overwrites the current value

Per channel type:

- `shared var x = value` is allowed
- `shared text x = value` is invalid
- `shared data x = value` is invalid
- `shared sequence db = sinkExpr` initializes the shared sequence
- `shared sequence db` declares participation without an initializer

`shared sequence` is the existing `sequence` channel placed into shared
instance state. In current Cascada terms, it is the channel type used for the
`!` sequential path/call mechanism.

`shared` and `extern` stay separate:

- `extern` means caller-provided composition input
- `shared` means hierarchy-owned instance state

For this inheritance model, `with { }` preloads `shared` state rather than
binding `extern` inputs.

## Methods, Overrides, and `super()`

Inherited dispatch is explicit:

- `this.method(args)` means "call the inherited/overridable method named
  `method`"
- bare `foo()` remains an ordinary local/context/global function call and never
  participates in inheritance lookup
- `this.method` without a call is not part of the first implementation

Near-term, inheritance state lives on `context`. A later cleanup step may move
it to a separate explicit runtime argument, but the semantics stay the same.
That state may remain a plain object if it is still mostly storage plus trivial
lookup. If it grows substantial behavior, validation, deferred-slot lifecycle,
chain mutation, or dispatch helpers, it should become a dedicated
`InheritanceState` class rather than leaving that logic split across `Context`,
runtime helpers, and an unstructured object.
Likewise, the new inheritance / extends runtime helpers should converge behind
one dedicated module or class boundary once the runtime API stabilizes, rather
than staying spread across `Context`, `Template`, and unrelated helpers.
Compiler-side inheritance / extends lowering should likewise converge behind a
dedicated compiler helper boundary rather than staying spread across unrelated
compiler files.

Each compiled file exposes its methods up front in a `methods` map. Each entry
contains:

- `fn`: the compiled method/block entry function
- `contract`: the method signature / call contract
- `ownerKey`: the declaring file's identity in the inheritance chain

The child file registers its own methods immediately at root start. Parent
methods register later, when the `extends` load boundary resolves.

The inheritance state therefore stores an ordered chain per method name, in
child-first order:

- `buildHeader -> [{ fn: C.buildHeader, ownerKey: C }, { fn: B.buildHeader, ownerKey: B }, { fn: A.buildHeader, ownerKey: A }]`

This ordered-chain model drives both normal inherited dispatch and `super()`.

### `this.method(...)`

`this.method(args)` resolves through the first entry in that method's chain.

- if the child already declared the method, the call can resolve immediately
- if the method depends on a parent that has not loaded yet, the call resolves
  through a deferred slot and waits only at that call site
- constructor execution as a whole does not stall just because parent loading is
  still in progress

This is normal Cascada behavior: the call result may be a plain value or a
promise, and only code that actually consumes it waits.

Inherited method dispatch is a direct runtime call emitted at the call site. It
is not a separate buffer command or side-channel admission step. Ordering comes
from the method invocation's per-call child command buffer and ordinary
channel/buffer structure, so method-body writes land at the call site's source
position.

Inherited dispatch may reuse low-level argument-resolution and invocation
helpers with ordinary function/macro calls, but it remains a separate dispatch
path because it resolves through inheritance state rather than ordinary
lookup.

### `super()`

`super()` inside a method uses the same deferred-slot model.

The current method name is statically known at compile time, and the current
method's `ownerKey` is also statically known. So `super()` resolves to "the
next entry in this method's chain after my owner."

For example, inside `C`'s `buildHeader()`:

- `super()` means "the next `buildHeader` after `ownerKey = C`"
- if that next method has not registered yet because the parent chain is still
  loading, only this `super()` call waits for it

So the inheritance state must store ordered per-method chains, not just the
winning override.

Safety rule:

> If an ancestor constructor calls `this.method(...)`, the override should only
> depend on shared state that is already available from `with { }` preload or
> descendant pre-extends initialization.

## Return Semantics

`extends` is not a value-producing expression. Forms such as
`var res = extends "Base.script"` are not part of this model.

For direct render:

- only the most-derived entry file's explicit `return` counts
- any ancestor constructor `return` is ignored by the outer instance render
- if the entry file has no explicit `return`, the instance falls back to its
  normal mode-specific result

Mode-specific fallback means:

- template mode: final rendered text output
- script mode: the script's normal result when there is no explicit `return`

For namespace instantiation:

- constructor return is ignored
- `import "Component.script" as ns with { ... }` always yields the namespace
  object

Namespace method return is separate from constructor return. Calling
`ns.method(args)` resolves to that method invocation's return value when its
per-call child buffer has finished applying.

Template inheritance follows the same model. Templates have no constructor-
return concept.

## Namespace Instances

### Namespace Runtime

A namespace instance has:

- one long-lived namespace buffer
- one side-channel that immediately starts namespace operations when caller-side
  commands apply

For a namespace instance, this long-lived namespace buffer is the instance root
buffer for that instance.

The side-channel is a runtime object owned by the namespace instance. It accepts
namespace operations from caller code, immediately enqueues the corresponding
namespace command or per-call child buffer into the namespace buffer tree, and
returns the resulting promise to the caller. It does not do caller-side
shared-channel dependency tracking or maintain a second scheduler. It is only a
thin admission object. Ordinary caller-buffer application order decides when a
namespace operation starts; after that, ordinary command-buffer ordering and
dependency handling take over.

Constructor startup:

- constructor code runs with the namespace buffer as its current buffer
- constructor commands are added there synchronously

After constructor startup:

- each namespace operation starts immediately when its caller-side command
  applies
- the side-channel does not wait for argument resolution first
- unresolved arguments flow through as ordinary Cascada values

Method calls:

- `ns.method(args)` immediately creates one child buffer under the namespace
  buffer
- the method is called immediately from side-channel `apply()`
- method-local declarations and temporary outputs live in that per-call child
  buffer

Shared observations:

- namespace shared-value observations use the same side-channel path
- the side-channel immediately adds the corresponding observation command into
  the namespace buffer

Once commands or per-call child buffers are attached, ordinary Cascada
buffer/tree semantics handle dependencies and ordering.

### Namespace Object

`ns` exposes:

- all methods from the hierarchy
- shared channels through namespace properties
- no ambient caller-side variables

First implementation restriction:

- namespace semantics apply only to the direct binding introduced by
  `import ... as ns`
- aliasing, passing, or returning that namespace value is out of scope
- only direct syntactic uses such as `ns.method()`, `ns.x`, and
  `ns.log.snapshot()` participate in namespace dispatch

Caller-side access rules:

- `shared var x`: `ns.x` behaves like a normal value read
- `shared text`, `shared data`, `shared sequence`: use explicit observation
  forms such as `ns.log.snapshot()`, `ns.state.snapshot()`, `ns.db.isError()`,
  and `ns.db.getError()`

These observation forms are still current-buffer operations:

- `.snapshot()`, `.isError()`, and `.getError()` operate on the caller's
  current buffer position
- they observe the namespace's shared channel from that position
- they are not JS methods on a stored channel object

Example:

```cascada
import "Component.script" as ns with { theme: "dark" }

var theme = ns.theme

if ns.theme is error
  var msg = ns.theme#message
endif

var logText = ns.log.snapshot()
var state = ns.state.snapshot()

if ns.db.isError()
  var dbErr = ns.db.getError()
endif
```

For non-`var` shared channels, callers must observe the channel explicitly
before assigning it elsewhere.

### Completion and Lifetime

The side-channel is owned by the caller buffer that owns the `ns` binding:

- constructor startup does not finish the namespace buffer
- later method calls and shared observations continue to append through the
  side-channel while that caller buffer is still being applied
- once the owning caller buffer finishes applying, no new namespace operations
  can arrive from that scope or any of its async children
- at that point the side-channel closes and the namespace buffer is marked
  finished

## Multiple Instances

```cascada
import "Button.script" as okBtn with { label: "OK" }
import "Button.script" as cancelBtn with { label: "Cancel" }
```

These are fully independent instances with separate buffers, shared state,
side-channels, and method calls.

## Templates

Templates follow the same model:

- template body code is constructor code
- `{% block name(args) %}` is the method form
- `{% extends "parent.njk" %}` is constructor chaining
- async template inheritance and namespace instances use the same root-buffer,
  side-channel, and per-call child-buffer model as scripts

Treating code before `{% extends %}` as pre-extends code and code after it as
post-extends code is part of this architecture.

This is an intentional behavioral change for extending templates. Templates
that relied on classic Nunjucks behavior of ignoring top-level code around
`{% extends %}` will behave differently under this model.

## Static Analysis

Required compile-time data:

- static parent metadata for chain resolution
- shared-channel schema declared by each file
- upfront `methods` metadata: `{ fn, contract, ownerKey }`
- method override metadata for ordered chain construction

Not required:

- caller-side method read/write tracking for namespace scheduling
- per-call dependency metadata attached to the caller command stream

Inside namespace methods, ordinary Cascada analysis still applies for async
blocks, local channels, and command-buffer linking.

## Error and Poison Propagation

Constructor and method execution follow normal Cascada poison rules:

- value-consumption failures poison affected writes and effects
- downstream reads and writes follow normal dataflow poisoning
- real invariant/runtime errors still propagate as real errors

This architecture changes where work is attached, not how poison semantics work.

## Compatibility Requirements

Must not break:

- plain scripts and templates without `extends`
- plain `import` and `include`
- existing `extern` / `with` behavior for non-inheritance composition
- `caller()` in macros
- sequential `!` paths

Must enable:

- shared channels readable and writable across the hierarchy
- JS-style dynamic dispatch from ancestor constructors
- independent instances via `import ... as`
- `with { }` values overriding shared defaults
- namespace method calls that return values without exposing internal buffers
