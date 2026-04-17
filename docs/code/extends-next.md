# `extends-next`: Inheritance Architecture

## Overview

`extends` gives Cascada scripts and templates a class-style inheritance model.

The runtime model is intentionally simple:

- one hierarchy instance owns one long-lived shared root command buffer
- all `shared` channels for that hierarchy live on that shared root
- each compiled file exposes upfront method metadata, including an internal
  `__constructor__`
- constructor admission and inherited method admission both use one runtime
  admission model: the most-derived entry constructor starts immediately after
  bootstrap, while parent constructors and unresolved inherited dispatch use
  inheritance side-channel admission on the shared root through an
  `InheritanceAdmissionCommand`
- component operations are admitted immediately through the component
  side-channel
- ordinary command-buffer ordering and dependency handling do the rest

## Core Principles

The architecture follows four rules:

- shared state lives on one persistent hierarchy shared root
- top-level constructor flow is represented as an internal `__constructor__`
  method
- inherited dispatch is explicit through `this.method(...)` and `super()`
- if inheritance must finish loading before shared-visible work can continue,
  that stall happens at side-channel apply on the shared root

Everything else follows from ordinary command-buffer tree behavior plus that
shared-root admission rule.

## OOP Mapping

| JS OOP | Cascada |
|---|---|
| `class C extends B` | `C.script` with `extends "B.script"` |
| Constructor body | top-level code compiled as internal `__constructor__` |
| `super()` in constructor | `extends "parent.script"` inside `__constructor__` |
| Method | script `method name(args)` / template `{% block name(args) %}` |
| Override | Same method name in a descendant file |
| `super()` in a method | `super()` |
| Instance variable | `shared var x`, `shared text t`, `shared data d`, `shared sequence s` |
| `new X({...})` | `import "X.script" as ns with { ... }` |
| `this` | The component object `ns` |
| Multiple instances | `import ... as ns1`, `import ... as ns2` |

`__constructor__` is internal. It should be reserved just like `__return__` and
must not be a user-declarable method or identifier.

## Two Ways to Run a Hierarchy

**Direct render**: render `C.script` or `C.njk` as the entry file. The
hierarchy runs and C's shared root is the instance shared root.

**Component instantiation**: `import "C.script" as ns with { ... }` creates an
independent instance. The caller keeps its own output and uses `ns` to call
methods or observe shared state.

This model assumes a static parent chain. "Known" here means the parent paths
are declared statically in source and are not computed dynamically. It does not
mean the whole parent chain must already be loaded before constructor execution
starts.

Shared-root ownership is single-origin:

- the most-derived direct-render entry creates the hierarchy shared root once
- component instantiation creates the component instance shared root once
- parent files do not create replacement shared roots
- composition/inheritance entry calls receive and reuse the already-created
  shared root

## Bootstrap

Before any constructor or method code that depends on inherited dispatch starts,
the runtime bootstraps the local hierarchy state:

1. Compile the local file before reading its inheritance metadata.
2. Register the child file's method metadata immediately at root start.
3. Register the child file's shared schema on the hierarchy shared root.
4. Preload `with { }` values into shared state when component instantiation uses
   `with { }`.
5. Start constructor execution through the internal `__constructor__`.

Parent methods do not need to be present yet. They register later when the
relevant parent file finishes loading. Parent shared schema also registers at
that time, and any newly discovered shared-root lanes are created only while
shared-root progress is stalled behind the corresponding inheritance admission.

Both direct render and component instantiation use this same local bootstrap
shape.

So after Step 7, the compiled root function is no longer "the constructor
body". It becomes a bootstrap preamble that:

1. establishes/reuses the shared root
2. creates or reuses `inheritanceState`
3. registers local method metadata and local shared schema
4. preloads component-instantiation shared inputs when applicable
5. admits the local `__constructor__`

During the implementation steps, some of that constructor bootstrap/admission
machinery may temporarily live in generic compiler/runtime files such as
`compiler-async.js`, `runtime.js`, and `call.js`. That is an implementation
staging choice, not part of the intended long-term layering. Once the
constructor/root contract has stabilized across script, component, and template
inheritance, those extends-specific helpers should move into dedicated
extends-focused compiler/runtime modules in one cleanup pass. In the numbered
implementation plan, that cleanup pass is Step 11. Step 11 should also split
ordinary callable invocation (`invokeCallable*`) away from extends/inheritance
admission and dispatch helpers that currently share `src/runtime/call.js`.
After that extraction, the intended shape is that one runtime owner is
responsible for inheritance bootstrap/state setup and one runtime owner is
responsible for inheritance admission/dispatch, with any remaining
dynamic-extends compatibility bridge isolated behind one explicit seam rather
than spread across multiple generic files.
That explicit seam now includes the async inheritance-registration wait surface:
compiler-emitted dynamic-extends registration waits should flow through runtime
inheritance helpers rather than direct `Context` bookkeeping calls from
multiple compiler/runtime sites.
Under the current Option B adapter, the remaining compiler-side dynamic seam is
intentionally narrow: the compiler stores the late parent template on the
explicit `__parentTemplate` channel and the root-completion path reads that
channel, while registration waits, top-level dynamic block dispatch, and parent
constructor startup flow through runtime inheritance helpers.
Treat that as the closed Step 12 end state. Any further work should be planned
as Step 13 rather than appended back onto Step 12:

- Step 13A-13C: safe Option B cleanup on the explicit seam and remaining
  ownership residue
- Step 14: architecture-parity omissions after Step 13 closes; preserve the
  current Option B behavior contract, but land the missing exact-link-after-load
  side-channel admission guarantee from this architecture
- Step 15: architecture-readability cleanup after Step 14 restores parity;
  reorganize compiler/runtime/state code so root startup, parent startup,
  admission/dispatch, and composition payload handoff each have a small,
  obvious owner
- Step 16 optional: explicit Option A redesign if we choose to replace the
  adapter seam with late-resolved static extends

Step 11 should begin with an explicit inventory pass before moving code:
confirm which helpers belong to compiler bootstrap/completion ownership, which
belong to runtime inheritance bootstrap ownership, and which belong to runtime
inheritance dispatch ownership. The likely target files are
`src/compiler/compiler-extends.js`, `src/runtime/inheritance-bootstrap.js`,
and `src/runtime/inheritance-call.js`, but that split should be treated as the
default direction rather than a hard promise until the analysis pass confirms
it.
Step 11 is extraction-only. Analysis-authoritative cleanup, imported-call
boundary metadata cleanup, macro caller-capture threading cleanup, duplicated
async-extends compilation collapse, and the linked-channel contract cleanup all
belong to Step 12 after the new ownership boundaries are in place.
The extraction also preserves one-way ownership: broad facades may delegate into
the new inheritance modules, but the new inheritance modules must not depend
back on those broad facades as owners.

Before that larger extraction, small structural simplifications are still fair
game during the intermediate steps:

- reduce compiler-local staging state when a scoped helper can express the same
  behavior more clearly
- remove private wrapper layers that do not carry a distinct semantic role

But do not use those intermediate cleanups to silently change the Step 7
contract itself. Behavioral cleanup such as removing the legacy
`asyncExtendsBlocksPromise` bridge belongs only after the later constructor /
component / template steps settle.

On the new static inheritance / component-instantiation path:

- `with { }` preloads declared `shared` names only
- unknown `with` keys are an error
- this preload path does not target `extern`

For plain direct-render `extends`, there is no `with { }` preload at the
`extends` site. Shared defaults come from `shared` declarations plus descendant
pre-extends initialization.

`extern` remains the caller-input mechanism for ordinary composition paths such
as plain `import`, `from import`, and `include`.

## Shared Root

Every hierarchy instance has one persistent shared root buffer.

That shared root exists before local constructor execution starts.

That shared root owns:

- all hierarchy-visible `shared` channels
- the shared-root lane structure that determines temporal correctness for
  constructor and inherited-method work
- the point where inheritance side-channel apply may stall shared-visible
  progress until additional ancestry has loaded

Any level that declares the same shared name refers to the same shared-root
channel.

Private non-shared constructor-local channels are different:

- they belong to the constructor or method invocation that declared them
- they may live in ordinary child buffers
- they finish with that invocation
- inherited methods do not rely on ancestor-private constructor-local state

So the architecture separates:

- hierarchy-visible `shared` state on the persistent shared root
- private invocation-local state in temporary invocation buffers

## `shared`

`shared` declares hierarchy-owned instance state.

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
- shared declarations should be routed to the hierarchy shared root at
  declaration time from the current buffer; they should not require a
  general-purpose root lookup API on `CommandBuffer`
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

## Constructors

Top-level code is the constructor body, but runtime-wise it is represented as
one internal method named `__constructor__`.

This gives constructors and inherited methods one common admission model:

- they are both runtime call targets
- they both run in invocation buffers
- they both write shared-visible state through the shared root

For `C extends B extends A`, constructor order is still:

1. C pre-extends
2. B pre-extends
3. A constructor body
4. B post-extends
5. C post-extends

`extends` is therefore still the constructor boundary in source order, but the
runtime implementation uses constructor-as-method admission rather than a
separate constructor-specific execution model.

The most-derived entry file starts its own `__constructor__` immediately after
bootstrap. An `extends` site inside that constructor admits the parent
`__constructor__` through the inheritance side-channel when the parent must be
loaded first.

The constructor does not need a permanently special buffer. The persistent part
is the shared root. Constructor-local non-shared state remains private to the
constructor invocation that created it.

That means non-shared constructor-local declarations conceptually move with the
`__constructor__` invocation, not with the bootstrap root preamble.

Constructor admission and ordinary method admission therefore share one runtime
model, but they do not yet have to share one compile-time linked-channel
analysis pass. For now, constructor linked-channel collection may stay
separate from ordinary method linked-channel collection because constructor
compilation still owns top-level flow concerns such as bootstrap-adjacent
setup, pre/post-`extends` ordering, and constructor-local non-shared channels.
That unification is cleanup work for Step 12 after constructor semantics and
the Step 11 extraction settle; it is not part of the current architecture
contract.

## Methods, Overrides, and `super()`

Inherited dispatch is explicit:

- `this.method(args)` means "call the inherited/overridable method named
  `method`"
- bare `foo()` remains an ordinary local/context/global function call and never
  participates in inheritance lookup
- `this.method` without a call is not part of the first implementation

Inheritance state threads through root and block/method entrypoints as an
explicit `inheritanceState` runtime argument rather than living on `context`.
Because it owns contract validation, method-chain mutation, and shared-schema
registration, it should live behind a dedicated `InheritanceState` class rather
than leaving that logic split across `Context`, runtime helpers, and an
unstructured object.

Each compiled file exposes its methods up front in a `methods` map. Each entry
contains:

- `fn`: the compiled method/block entry function
- `contract`: the method signature / call contract
- `ownerKey`: the declaring file's identity in the inheritance chain

That map includes the internal `__constructor__`.

The child file registers its own methods immediately at root start. Parent
methods register later, when the parent file finishes loading.

The inheritance state therefore stores an ordered chain per method name, in
child-first order:

- `buildHeader -> [{ fn: C.buildHeader, ownerKey: C }, { fn: B.buildHeader, ownerKey: B }, { fn: A.buildHeader, ownerKey: A }]`

This ordered-chain model drives both normal inherited dispatch and `super()`.

### `this.method(...)`

`this.method(args)` resolves through the first entry in that method's chain.

- if the child already declared the method, the call can resolve immediately
- if the method depends on a parent that has not loaded yet, resolution is
  handled by the inheritance side-channel at apply time on the shared root

Inherited method dispatch is not a plain JS lookup. It is an explicit runtime
call path emitted by the compiler.

Method invocation uses a separate invocation buffer, but that buffer is attached
under the hierarchy shared root for shared-visible ordering. Method-local
temporary channels stay private to that invocation buffer.

Inherited dispatch may reuse low-level argument-resolution and invocation
helpers with ordinary function/macro calls, but it remains a separate dispatch
path because it resolves through inheritance state rather than ordinary lookup.

### `super()`

`super()` inside a method uses the same ordered-chain model.

The current method name is statically known at compile time, and the current
method's `ownerKey` is also statically known. So `super()` resolves to "the
next entry in this method's chain after my owner."

For example, inside `C`'s `buildHeader()`:

- `super()` means "the next `buildHeader` after `ownerKey = C`"
- if that next method has not loaded yet, the same side-channel apply stall
  handles the wait before the actual invocation proceeds

So the inheritance state must store ordered per-method chains, not just the
winning override.

### Method Visibility

The clean visibility rule is:

- inherited methods operate on shared state, method arguments, and method
  payload
- they do not depend on ancestor-private constructor-local channels

That keeps private constructor-local state private while still allowing dynamic
dispatch across the hierarchy.

## Inheritance Side-Channel and Stalling

Each loaded extended/imported script has an inheritance side-channel entry point
for constructor and inherited-method admission.

That side-channel is the only place where inheritance loading is allowed to
stall shared-root progress.

The concrete admission unit is an observable command on the shared root, called
here `InheritanceAdmissionCommand`.

Its job is:

- carry the requested target (`__constructor__`, `this.method(...)`, or
  `super()`)
- decide whether the target is already available in `inheritanceState`
- if available, create the invocation buffer with exact static links and start
  the call immediately
- if unavailable, stall shared-root apply, wait for the needed load, register
  the newly loaded metadata/schema, then create the invocation buffer with
  exact static links and start the call

When side-channel `apply()` sees that the requested constructor or inherited
method is unavailable:

1. It stalls shared-root application at that point.
2. It waits for the necessary parent load to finish.
3. During that stalled window, it may register newly loaded methods, extend the
   shared schema, and link any newly discovered shared lanes.
4. Once that metadata is current, it performs the ordinary static linking and
   invocation for the target constructor/method.
5. Shared-root application then continues.

This is intentionally stronger than "wait only at that one JS call expression."
The important guarantee is:

- no shared-visible command is allowed to apply past that stalled admission
  point until the hierarchy metadata and shared-root topology needed there are
  current

At the same time:

- JS emission does not have to stop
- unrelated private non-shared local work may still continue in its own scopes
- the stall is about shared-root application order, not about freezing the
  whole runtime

This model avoids:

- wildcard caller-side channel linking
- late structural parent-lane membership changes during active dependent apply
- per-iterator id/promise side tables

The only allowed topology extension is inside that stalled side-channel apply
window, before any dependent shared-visible application is allowed to continue.

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

For component instantiation:

- constructor return is ignored
- `import "Component.script" as ns with { ... }` always yields the component
  object

Component method return is separate from constructor return. Calling
`ns.method(args)` resolves to that method invocation's return value when its
per-call child buffer has finished applying.

Template inheritance follows the same model. Templates have no constructor-
return concept.

## Component Instances

### Component Runtime

A component instance has:

- one long-lived component shared root
- one side-channel that immediately starts component operations when caller-side
  commands apply

For a component instance, this long-lived component shared root is the hierarchy
shared root for that instance.

The component side-channel is a runtime object owned by the component instance.
It accepts component operations from caller code, immediately enqueues the
corresponding component command or per-call child buffer into the component
buffer tree, and returns the resulting promise to the caller. It does not do
caller-side shared-channel dependency tracking or maintain a second scheduler.
It is only a thin admission object. Ordinary caller-buffer application order
decides when a component operation starts; after that, ordinary command-buffer
ordering and dependency handling take over.

Constructor startup:

- constructor code runs through the same internal `__constructor__` admission
  path
- constructor commands therefore also use the component shared root as their
  shared-visible base

After constructor startup:

- each component operation starts immediately when its caller-side command
  applies
- the side-channel does not wait for argument resolution first
- unresolved arguments flow through as ordinary Cascada values

Method calls:

- `ns.method(args)` immediately creates one child buffer under the component
  shared root
- the method is called immediately from side-channel `apply()`
- method-local declarations and temporary outputs live in that per-call child
  buffer

Shared observations:

- component shared-value observations use the same side-channel path
- the side-channel immediately adds the corresponding observation command into
  the component shared root

Once commands or per-call child buffers are attached, ordinary Cascada
buffer/tree semantics handle dependencies and ordering.

### Component Object

`ns` exposes:

- all methods from the hierarchy
- shared channels through component properties
- no ambient caller-side variables

First implementation restriction:

- component semantics apply only to the direct binding introduced by
  `import ... as ns`
- aliasing, passing, or returning that component value is out of scope
- only direct syntactic uses such as `ns.method()`, `ns.x`, and
  `ns.log.snapshot()` participate in component dispatch

Caller-side access rules:

- `shared var x`: `ns.x` compiles to a component shared-value read at the
  caller's current position; it is not a stored JS property read
- `shared text`, `shared data`, `shared sequence`: use explicit observation
  forms such as `ns.log.snapshot()`, `ns.state.snapshot()`, `ns.db.isError()`,
  and `ns.db.getError()`

These observation forms are still current-buffer operations:

- `.snapshot()`, `.isError()`, and `.getError()` operate on the caller's
  current buffer position
- they observe the component's shared channel from that position
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

- constructor startup does not finish the component shared root
- later method calls and shared observations continue to append through the
  side-channel while that caller buffer is still being applied
- once the owning caller buffer finishes applying, no new component operations
  can arrive from that scope or any of its async children
- at that point the side-channel closes and the component shared root is marked
  finished

## Multiple Instances

```cascada
import "Button.script" as okBtn with { label: "OK" }
import "Button.script" as cancelBtn with { label: "Cancel" }
```

These are fully independent instances with separate shared roots, shared state,
side-channels, and method calls.

## Templates

Templates follow the same model:

- template body code is constructor code and compiles to internal
  `__constructor__`
- `{% block name(args) %}` is the method form
- `{% extends "parent.njk" %}` is constructor chaining
- async template inheritance and component instances use the same shared-root,
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
- the internal `__constructor__` entry in that same metadata
- method override metadata for ordered chain construction

Not required:

- caller-side method read/write tracking for component scheduling
- per-call dependency metadata attached to the caller command stream
- wildcard parent-lane linking for unresolved inherited calls

Inside constructors and methods, ordinary Cascada analysis still applies for
async blocks, local channels, and command-buffer linking.

## Error and Poison Propagation

Constructor and method execution follow normal Cascada poison rules:

- value-consumption failures poison affected writes and effects
- downstream reads and writes follow normal dataflow poisoning
- real invariant/runtime errors still propagate as real errors

This architecture changes where work is attached and where shared-root apply may
stall. It does not change poison semantics.

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
- component method calls that return values without exposing internal buffers
