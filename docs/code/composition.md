# Composition Architecture

## Status

This document describes the intended composition architecture for Cascada's
modern async path.

It does **not** change the non-async/sync path. Sync rendering remains the
authoritative Nunjucks-compatible implementation and should preserve existing
behavior.

The new rules apply to async composition only.

---

## Purpose

Cascada's concurrency model needs composition boundaries to be explicit.

Implicit parent-scope access works against:

- compile-time dependency analysis
- predictable async visibility
- JS-local execution strategies
- structural command-buffer ownership

The goal of this design is to replace implicit cross-template lexical access
with explicit contracts:

- the child declares what it expects with `extern`
- the parent declares what it provides with `with ...`

At the top level, the same model applies to the render entry point:

- the template/script declares expected external inputs with `extern`
- the render context provides the initial input values

This keeps composition analyzable without changing sync/Nunjucks behavior.

---

## Scope

This document covers:

- async `include`
- async `extends` / `block` / `super()`
- async `import` / `from import`
- `extern` declarations
- the relationship to macros and `caller()`

This document does not change:

- sync include/import/extends semantics
- Nunjucks compatibility in sync mode
- macro/caller syntax itself

---

## Compatibility Split

### Sync path

The sync path stays unchanged.

That means:

- `include` keeps current Nunjucks-compatible behavior
- `import ... with context` keeps current Nunjucks-compatible behavior
- `extends` keeps current Nunjucks-compatible behavior

This is intentional. Sync remains the compatibility surface.

### Async path

The async path moves to explicit composition contracts.

That means:

- no implicit parent template/script scope access across composition boundaries
- no implicit visibility via parent var-channel linking
- no implicit visibility bridging from parent canonical runtime names into child
  locals
- child-local bindings are initialized explicitly from `extern` + `with`

This still allows alias use internally when resolving parent-side runtime names.
If analysis renames a parent-local binding to something like `name#7`, the
parent-side `with name` evaluation may use aliases to resolve `name` to its
canonical runtime name before passing the value to the child. That is argument
binding, not ambient child visibility.

---

## Core Model

Composition works like parameter passing, not like shared lexical scope.

The child file or child block declares root-level `extern` bindings. The parent
supplies values explicitly through `with ...`. At the top-level render entry
point, the render context supplies those values. The child receives fresh local
bindings initialized from those values.

Async composition also supports explicit render-context access through
`with context`.

That special token does not inject render-context properties as child locals.
Instead, it makes the child use the render context for ordinary bare-name
lookup in the same way the parent does.

Important consequences:

- value passing across composition boundaries is explicit
- local rebinding inside the child is allowed
- child locals are initialized from passed values rather than bound to parent
  variable channels
- render-context visibility is explicit through `with context`
- shared mutable state must use channels or other explicit stateful constructs

This makes async composition much closer to macro invocation than to ambient
scope sharing.

---

## Language Surface

### `extern`

Child templates/scripts declare externally-provided bindings at root scope:

```njk
{% extern user %}
{% extern theme = "light" %}
{% extern errors = [] %}
```

Rules:

- `extern` is allowed only at root scope
- `extern` declares a local binding
- `extern` is treated as an async `var` for ordinary analysis after
  initialization
- `extern x = expr` is a fallback initializer
- if a value is provided by the render entry point or by a composition
  invocation, that provided value wins
- if no value is provided, the fallback is used
- if `x` has no provided value and no fallback, initialization of `x` is an
  error
- `extern` names are never renamed by the async renaming pass

Initialization semantics:

- extern initialization is declaration-ordered
- a fallback may reference earlier externs and globals
- a fallback must not depend on later externs
- extern initialization cycles are invalid

Because `extern` is var-like after initialization, it should participate in the
same ordinary analysis surface as other vars:

- symbol lookup
- declaration and scope ownership
- ordinary variable uses contributing to `usedChannels`
- ordinary variable mutations contributing to `mutatedChannels`
- declaration conflict checks
- ordinary assignment/reassignment rules

In the async implementation, "var-like" means reusing the ordinary async var
representation:

- declared as a normal async `var` channel
- read through the normal async var lookup/snapshot path
- written through the normal async var assignment / `VarCommand` path

So `extern` does not introduce a second runtime storage model for async vars.

### `include`

Async include becomes explicit:

```njk
{% include "card.njk" with context, user, theme %}
```

Meaning:

- if `context` is listed, the child gets render-context visibility through
  ordinary bare-name lookup
- evaluate `user` and `theme` in the parent scope
- pass them as named inputs
- initialize matching child `extern` bindings
- do not expose any other parent locals
- do not expose render-context properties unless `with context` is used

### `block`

Async block contracts are explicit:

```njk
{% block content with context, user, theme %}
```

Ownership of the contract:

- the authoritative `with ...` clause belongs on the base/invoking block
  definition
- the values are evaluated at block invocation time in the invoking scope
- an overriding child block receives those values as local invocation inputs
- an overriding child block should not declare its own independent `with ...`
  clause

Meaning:

- if `context` is listed, the overriding block gets render-context visibility
  through ordinary bare-name lookup
- when this block is invoked, `user` and `theme` are evaluated in the invoking
  scope
- the overriding block receives fresh local bindings for those names
- no other parent locals are implicitly visible through inheritance
- those input names behave like local var declarations for that block

Recommended async rule:

- if an overriding child block also declares `with ...`, that is a compile error

### `extends`

Async `extends` does not require new syntax on the `extends` tag itself.

The composition contract for inheritance is carried entirely by:

- the base template's `block ... with ...` declarations
- the child block overrides that receive those invocation inputs

So the `extends` tag remains structurally the same, while block invocation
semantics become explicit.

### `import` and `from import`

Async import is isolated from parent lexical vars and channels, but it uses the
same `with` surface as other async composition forms.

That means:

- no implicit parent scope access
- `with name1, name2` passes explicit named inputs that initialize matching
  child `extern`s
- `with context` makes render-context properties visible through ordinary
  bare-name lookup in the imported file
- imported files still rely on their own declarations, globals, explicit
  composition inputs, and explicit macro arguments

Examples:

```njk
{% import "forms.njk" as forms with context %}
{% from "lib.njk" import helper with context, theme %}
{% import "cards.njk" as cards with user, theme %}
```

If an imported file declares required `extern`s with no defaults, async import
is invalid unless those `extern`s are provided through `with ...` or satisfied
by fallbacks.

### Async `with context`

For consistency, all async composition forms support `with context`:

- `include`
- `block`
- `import`
- `from import`

Meaning in async mode:

- `with context` is explicit opt-in access to the render context
- it does not pass parent frame locals or async var channels
- it does not create a special local binding that must be declared via
  `extern`
- instead, it seeds child lookup so bare names can read render-context
  properties the same way the parent does

Reserved-name rule:

- `context` is reserved in async composition syntax
- async local declarations named `context` are invalid
- `extern context` is invalid
- `with context` always means the special render-context access, never a normal
  variable named `context`

### Sync handling of `extern`

Because the parser is shared, sync compilation must define behavior for
`Extern` nodes explicitly.

Recommended sync rule:

- sync compilation rejects `extern` with a clear error

Reason:

- sync mode remains Nunjucks-compatible
- the explicit extern contract model is an async-only feature
- silently treating `extern x = default` like `set x = default` would change the
  meaning of the syntax and blur the sync/async boundary

---

## Why `extern` Is Not Just `var`

`extern` should share a lot of implementation machinery with `var`, but it
should not be treated as the same declaration kind.

`extern` and `var` are similar because both ultimately produce local bindings.

They differ because `extern` also contributes to the composition contract:

- `extern` is root-only
- `extern` may have a fallback initializer
- `extern` participates in include/block validation
- `extern` is initialized from parent-provided values before normal body logic

Recommended implementation rule:

- analyze `extern` as a distinct declaration type
- lower it to the same async local var representation as `var` after
  composition initialization

`extern` itself remains a distinct declaration kind in analysis throughout.
Only the initialized binding reuses the normal async var model.

So `extern` is "var-like at runtime, contract-like at analysis time".

---

## Semantics by Construct

### Include

#### Desired async semantics

`include` behaves like a child render with explicit named inputs.

The included child:

- has access only to declared `extern`s that are supplied by the parent or have
  fallbacks
- may rebind those names locally
- may not mutate parent bindings
- contributes rendered output through the normal composition buffer structure

#### Important architectural change

The current async include path derives visible parent vars from analysis and
links child buffers into matching parent var lanes.

That must stop.

What must be removed for async include:

- implicit visible-var discovery
- boundary alias maps for parent var names
- parent var-channel linking into the child
- parent command-buffer binding for passed variables

What stays:

- normal child composition buffering for text and other child-owned outputs
- normal include output ordering

So the change is:

- stop structurally sharing parent variable lanes or parent variable buffers
- keep structurally composing rendered output

#### Local mutation rule

Bindings received through `extern` are locally mutable in the child.

That means:

- `{% set user = normalize(user) %}` is allowed inside the child
- this changes only the child's local `user`
- it does not change the parent's `user`

This is the same broad shape as macro parameters.

The recommended async implementation is:

- evaluate parent-side `with` expressions in the parent scope
- resolve any parent-side aliases needed to reach canonical runtime names
- materialize the passed values
- initialize child-local `extern` vars from those values
- do not bind the child locals back to parent variable channels or the parent
  template command buffer

---

### Extends, Block, and Super

#### Desired async semantics

Inheritance should stop behaving like implicit shared parent lexical scope.

Instead:

- the base block definition declares the contract with `with ...`
- the overriding child block receives explicit inputs
- the block executes in the child template's own scope plus those explicit block
  inputs
- parent bindings are not directly shared

#### Child block scope

An overriding block should behave like a deferred callable body that:

- is defined in the child template
- executes later when invoked by the base template
- can see the child template's own declarations
- also receives explicit block inputs from the invocation site

This is closer to `caller()` than to today's shared-scope inheritance model, but
only at the level of explicit input binding. It should not inherit the full
`caller()` scheduling architecture automatically.

#### Relationship to `super()`

`super()` is the main place where the `caller()` analogy stops being exact.

`super()` is not "call another passed function"; it is "call the next block in
the inheritance chain".

Recommended semantics:

- `super()` receives the same explicit block-input map as the overriding block
- `super()` does not observe local rebindings performed inside the child block
- each block implementation gets its own local binding initialization from the
  same invocation inputs

This keeps `super()` stable and avoids accidental dependence on child-local
mutation.

#### Child top-level code

Under this model, the child template's top-level scope is its own scope.

That means async inheritance should not depend on shared mutable top-level
bindings between base and child.

Recommended ordering:

- child template top-level setup runs before base-template layout execution
- block definitions are registered before base-template block dispatch
- explicit block-input initialization happens at each block invocation
- `super()` uses the same invocation inputs, but its own fresh local bindings

If state must be shared across inheritance boundaries:

- pass it explicitly with `with ...`
- or use channels / other explicit shared state

#### Why blocks do not automatically need `__caller__`

`caller()` needs special scheduling because:

- the macro body owns an isolated macro-local buffer
- `caller()` may create parent-visible output from a separate all-callers
  boundary
- the macro may invoke `caller()` multiple times from flexible async control
  flow
- the macro must not finish before all caller-invocation child buffers have
  finished accepting commands

That is why async macros use the internal scheduling channel
`__caller__` / `CALLER_SCHED_CHANNEL_NAME`.

Blocks do not inherently have this shape.

Recommended async block model:

- a block invocation is a normal direct render at the invocation site
- explicit block inputs are initialized as local vars for that invocation
- the block emits into the current render/output boundary
- `super()` is another direct block invocation in the inheritance chain

Under that model, blocks do not need a macro-style all-callers coordination
channel.

So the recommendation is:

- do not copy `__caller__` / `CALLER_SCHED_CHANNEL_NAME` machinery to blocks by
  default
- do not introduce a detached parent-linked "all block calls" buffer
- keep block and `super()` invocation structurally direct unless a future design
  introduces a real detached multi-invocation scheduling problem

---

### Import and From Import

Async imports should be treated as isolated libraries with the same explicit
`with` surface as other async composition forms.

That means:

- no ambient parent locals
- no implicit parent frame/channel access
- `with context` is allowed and exposes render-context properties through
  ordinary bare-name lookup
- named `with ...` inputs initialize declared child `extern`s
- no implicit `extern` provisioning from the importer

Imported macros continue to receive explicit macro arguments as usual.

This keeps import isolated while preserving async consistency:

- import has no implicit parent scope access
- import still uses the same explicit `with ...` interface as include/block

### Comparison Table

| Construct | Where inputs come from | Can see ambient parent locals? | Local rebinding allowed? | Parent variable lanes/bindings shared? | Needs `__caller__`-style scheduling? |
| --- | --- | --- | --- | --- | --- |
| `include` | Parent `with ...` or top-level render context | No | Yes | No | No |
| `block` override | Invoking block's `with ...` | No | Yes | No | No |
| `super()` | Same block invocation input map | No | Yes, in its own local invocation scope | No | No |
| `import` / `from import` | Parent `with ...` plus optional `with context` | No | Yes, for imported-file locals | No | No |
| macro params | Call arguments / kwargs | No | Yes | No | No |
| `caller()` body | Call-site scope plus explicit caller args | Yes, by caller design | Yes, in caller-local scope | No parent-owned mutation; separate caller composition subtree | Yes |

Note on `caller()` and `extern`:

- if a `caller()` body is defined in a template whose locals include initialized
  `extern` bindings, then `caller()` sees those values in the same way it sees
  other call-site locals
- this does not create new cross-composition ambient visibility; it follows the
  ordinary definition of caller using its call-site scope

---

## Relationship to Macros and `caller()`

The new async composition model is strongly related to macro machinery.

### `extern` vs macro parameters

`extern` is analogous to macro parameters:

- both declare local bindings
- both are initialized from explicit inputs
- both allow local rebinding
- neither should mutate the caller's bindings

### child block invocation vs `caller()`

An overriding child block is similar to a `caller()` body:

- it is defined in one scope
- invoked later from another place
- receives explicit inputs
- should not rely on ambient shared parent locals

This suggests that async block invocation can reuse some of the same structural
ideas as `caller()`:

- explicit input binding initialization
- no parent-owned mutation across the boundary

### where the analogy breaks

Blocks are still different from `caller()` because of:

- inheritance-chain dispatch
- `super()`
- base-template ownership of the invocation site
- lack of a separate all-callers scheduling problem

So this is an architectural analogy, not a claim that blocks should literally
be compiled as caller blocks.

---

## Root-Only `extern`

`extern` should be allowed only at root scope.

This is a deliberate restriction.

Benefits:

- the child contract is easy to discover statically
- include/import/block validation is simple
- the extern spec can be compiled once per file
- nested dynamic dependency contracts are avoided

This also makes the contract reusable across:

- full-template include
- full-script include
- block overrides
- imported-file validation

Recommended validation:

- `extern` inside loops, conditionals, macros, blocks, guards, or nested scopes
  is a compile error

---

## Validation Rules

Recommended async validation rules:

1. `extern` is root-only.
2. `extern` names must not conflict with local declarations or reserved names.
3. `context` is reserved for async composition and cannot be declared as a
   local var or `extern`.
4. A passed `with` name must correspond to a declared child `extern`, except
   for the reserved special token `context`.
5. A required child `extern` with no fallback must be provided by the render
   entry point or by the composition caller.
6. Async `import` of a file with required `extern`s and no defaults is invalid
   unless those inputs are supplied explicitly with `with ...`.
7. `extern` fallback initializers should not introduce hidden ambient
   dependencies.
8. `extern` declarations participate in ordinary var usage/mutation analysis.
9. `extern` declarations are never renamed.
10. extern fallback initializers may depend only on earlier externs and globals.
11. extern initialization cycles are invalid.
12. block input names participate in ordinary local declaration conflict rules.
13. `with context` must not implicitly expose parent frame locals or async var
    channels.

Validation timing:

- when the child target is statically known, validate the contract at compile
  time
- when the child target is dynamic, validate the contract at runtime when the
  resolved child is known

Recommended conservative rule for fallback initializers:

- an `extern` fallback may reference globals and other declared `extern`s
- it should not implicitly depend on undeclared parent locals

Example:

```njk
{% extern theme = "light" %}
{% extern siteTheme %}
{% extern finalTheme = siteTheme %}
```

This is preferable to allowing hidden fallback dependencies on undeclared names.

---

## Compiler and Runtime Architecture

### Current code touch points

The main implementation areas affected by this design are:

- `src/parser.js`
  - parse `extern`
  - parse `include ... with ...`
  - parse `block ... with ...`
  - support `with ...` consistently across async composition forms
  - keep sync `with context` parsing unchanged
- `src/nodes.js`
  - add `Extern`
  - extend `Include` / `Block` metadata for explicit inputs
- `src/compiler/analysis.js`
  - collect and validate root/block extern contracts
  - contains `getIncludeVisibleVarChannels()`, one of the key include-specific
    async visibility mechanisms to retire from composition semantics
- `src/compiler/boundaries.js`
  - review async boundary creation/ownership so explicit extern input passing
    uses normal output composition without preserving old parent-var visibility
- `src/compiler/scope-boundaries.js`
  - add `Extern` as a declaration site / scope-aware construct where needed
- `src/compiler/rename.js`
  - preserve the rule that `extern` names are not renamed
- `src/compiler/inheritance.js`
  - replace async include/import/extends visibility plumbing with explicit input
    binding
  - current include-specific methods to review/remove from async composition
    semantics include:
    - ` _emitDeclaredValueSnapshots()`
    - ` _emitDeclaredValueAliasMap()`
- `src/compiler/compiler-async.js`
  - add async analysis/compilation hooks for `extern`
  - update async include/block/import semantics
- `src/compiler/macro.js`
  - reuse parameter-style binding ideas where helpful for `extern` and block
    invocation
- `src/environment/context.js`
  - preserve sync behavior
  - avoid using shared context state as the async composition mechanism
- `src/runtime/command-buffer.js`
  - keep output composition structure
  - stop using parent var-channel visibility as the async composition model
  - review `_setBoundaryAliases()` as part of removing include-specific child
    visibility bridging
- `src/runtime/runtime.js`
  - adjust include/inheritance helpers so only output structure remains linked

Additional current methods/helpers to review explicitly during migration:

- `analysis.getIncludeVisibleVarChannels()`
- `compiler.emitLinkWithParentCompositionBuffer()`
- `runtime.linkWithParentCompositionBuffer()`
- `context.prepareForAsyncBlocks()`
- `context.finishAsyncBlocks()`

### Parser and AST

Async composition needs new syntax and AST metadata.

Recommended parser additions:

- `extern`
- `include ... with name1, name2`
- `block name with name1, name2`
- `import ... with name1, name2`
- `from ... import ... with name1, name2`

Recommended AST shape:

- new `Extern` node
- `Include` gains explicit `withVars`
- `Block` gains explicit `withVars`
- `Import` / `FromImport` retain `withContext` and gain explicit `withVars`
- async compilation distinguishes the reserved `context` token from ordinary
  explicit extern inputs

### Analysis

Analysis should collect an `externSpec` for each root. Block contracts should
also record their own explicit input lists.

That spec should include:

- extern name
- whether it is required
- fallback initializer node, if any
- a flag that it is a non-renamable var-like declaration

For dynamic-target validation, `externSpec` must be exposed on compiled async
template/script objects as accessible metadata.

That path is:

- analysis collects `externSpec`
- code generation embeds it on the compiled async template/script object
- runtime reads it when dynamic include/import targets resolve

Async composition analysis should stop treating parent-visible vars as an
implicitly discoverable property of include/block boundaries.

That means the current "what parent vars are visible here?" analysis is no
longer the source of truth for async composition visibility.

The source of truth becomes:

- child root/block `extern` declarations
- parent `with ...` clauses

Once initialized, externs behave like normal vars for the rest of analysis.
They should participate in ordinary declaration/use/mutation accounting rather
than living in a separate "special visibility" system.

For blocks, explicit input names should be treated as invocation-local var
bindings for analysis purposes. That means:

- they participate in local declaration/conflict checks
- they are available to ordinary symbol lookup inside the block body
- they are not renamed into child-canonical extern names; they are already the
  final local names for that block invocation

### Lowering

`extern` should lower to local bindings using the same runtime representation as
ordinary async vars after initialization.

Recommended pattern:

1. collect the extern input object
2. initialize fresh local bindings from provided values or fallbacks in
   declaration order
3. continue rendering/compiling normally using those local bindings

In concrete async terms, reuse should happen through the existing var-channel
path:

- declare the binding as an ordinary async `var` channel
- initialize it through the same command path used by async var initialization
- read it through the same ordinary symbol/snapshot path used by async vars
- write it through the same ordinary assignment / `VarCommand` path used by
  async vars

The rename pass must explicitly skip extern declarations because they share the
ordinary declaration metadata shape but are non-renamable by design.

If fallback initialization encounters:

- a reference to a later extern
- a dependency cycle

initialization should fail explicitly.

This is why `extern` can share substantial code with `var` after the contract
phase is complete.

### Include lowering

Async include lowering should:

1. evaluate the explicit `with ...` expressions in the parent scope
2. if `with context` is present, seed child render-context visibility for bare
   lookup
3. build an extern input object from the remaining named inputs
4. render the child with that extern input object
5. keep child output composition ordering
6. avoid any parent var-channel linking or boundary aliasing for child variable
   reads

If parent-side names have been renamed internally, alias resolution is still
used on the parent side to find the canonical runtime source for each `with`
name before the value is passed into the child.

If the included child is statically known, its `externSpec` can be validated at
compile time. If it is dynamic, the same validation must happen when the target
template resolves at runtime.

### Block lowering

Async block invocation should:

1. evaluate the block's declared `with ...` expressions at the invocation site
2. if `with context` is present, seed block render-context visibility for bare
   lookup
3. build a block-input object from the remaining named inputs
4. invoke the overriding block with child-template scope plus initialized block
   locals
5. preserve a separate inheritance-chain context for `super()`
6. avoid macro-style detached caller scheduling unless a distinct structural
   need appears

### Import lowering

Async import/from-import lowering should:

- use isolated child execution
- support the same async `with ...` surface as include/block
- if `with context` is present, seed imported-file render-context visibility for
  bare lookup
- initialize explicit named inputs through child `extern`s
- never request parent frame locals or async var channels implicitly
- validate that required `extern`s are satisfied by explicit named inputs or
  fallbacks

If the imported target is dynamic, the same validation must happen at runtime
when the imported template resolves.

---

## What Stays Structural

This design removes implicit variable-lane sharing. It does not remove normal
composition structure.

The following still remain structural async concerns:

- include child buffers for output ordering
- caller-related child buffers
- inheritance block invocation ordering
- child-owned output channels

The rule is:

- explicit value passing replaces parent variable visibility
- it does not replace normal output composition

---

## Migration Direction

Recommended migration order:

1. Add `extern` parsing, AST, and root-only validation.
2. Add `with ...` parsing for all composition forms.
3. Build root/block `externSpec` collection.
4. Convert async include to extern-input initialization.
5. Remove async include parent-var visibility/link machinery while keeping
   parent-side alias resolution for argument binding.
6. Convert async inheritance/block invocation to explicit block inputs.
7. Define `super()` over the same invocation input map.
8. Add uniform async `with context` support across include/import/block while
   keeping parent frame locals and async var channels isolated.

The sync path is not part of this migration.

---

## Summary

The intended async composition model is:

- sync remains Nunjucks-compatible and unchanged
- async composition uses explicit contracts
- `extern` is the child-side declaration surface
- `with ...` is the parent-side provisioning surface
- `with context` is the uniform async opt-in to render-context visibility
- `include` gets explicit inputs and local-only mutation
- `block` gets explicit inputs and child-scope execution
- `super()` uses the same explicit block-input contract
- `import` is isolated from parent locals/channels while still supporting
  explicit `with ...`

Architecturally:

- `extern` is closest to macro parameters
- child block invocation is closest to `caller()`
- inheritance remains distinct because of `super()` and chain dispatch

This direction removes hidden ambient scope from async composition while keeping
the sync compatibility model intact.

---

## Step-by-Step Implementation Plan

This section turns the design into an implementation checklist.

Current status as of April 2, 2026:

- implemented:
  - parsing / AST support for `extern`, `include ... with ...`, `block ...
    with ...`, `import ... with ...`, and `from ... import ... with ...`
  - async root `extern` declaration analysis and `externSpec` exposure on
    compiled async templates/scripts
  - async root extern initialization from render context
  - extern fallback initialization and later-extern rejection
  - async include explicit-input lowering
  - async include `with context` handling using render-context visibility
  - parent-side canonicalization for renamed vars passed through `with ...`
  - runtime include contract validation through `validateExternInputs(...)`
  - async import/from-import isolation
  - async import/from-import explicit named `with ...` inputs
  - async import/from-import `with context` handling using render-context
    visibility
  - runtime validation that async import/from-import required externs are
    satisfied by explicit inputs, render-context visibility, or fallbacks
  - async reserved-name handling for `context`
  - removal of the dead `linkWithParentCompositionBuffer()` path
- partially implemented:
  - explicit extern-input plumbing exists for top-level render, async include,
    and async import/from-import, but not yet for async block/extends
  - obsolete async include visibility/linking machinery has been reduced, but
    not fully audited/removed everywhere
  - tests are strong for implemented root/include/import behavior, but async
    block/inheritance contract tests are still pending
- not implemented yet:
  - async block `with ...` contracts
  - async extends / overriding-block validation
  - `super()` over explicit invocation inputs
  - final cleanup/audit of remaining old async composition helpers

Testing policy during migration:

- update broken async tests as each step lands; do not let known-broken tests
  accumulate until the end
- when an old async test encoded implicit parent visibility, replace it with the
  new explicit-contract expectation rather than preserving the old behavior
- keep sync tests unchanged unless a sync test was incorrectly asserting async
  semantics
- add focused tests alongside the step that introduces or changes the behavior,
  not only in the final test pass

### Step 1: Add syntax and AST support

Status: implemented

Implement:

- parse `extern`
- parse `include ... with ...`
- parse `block name with ...`
- parse `import ... with ...`
- parse `from ... import ... with ...`
- add AST support for `Extern`
- add explicit input lists to `Include`, `Block`, `Import`, and `FromImport`

Keep unchanged:

- sync `import ... with context`
- sync `from ... import ... with context`
- all sync composition parsing and behavior

Verify:

- legacy sync templates still parse unchanged
- async templates can parse the new forms
- invalid nested `extern` syntax is rejected cleanly once validation is added

Add tests:

- parser coverage for `extern`
- parser coverage for `include ... with ...`
- parser coverage for `block ... with ...`
- parser coverage for `import ... with ...`
- parser coverage for `from ... import ... with ...`
- parser coverage for async `with context, var1, var2`
- regression coverage that sync `with context` parsing still works unchanged

### Step 2: Add explicit extern-input plumbing

Status: partially implemented

Implemented now:

- async top-level render entry can initialize explicit root extern inputs
- async include can pass explicit extern-input maps to children
- async import/from-import can validate isolated extern contracts without using
  ambient caller scope

Still pending in this step:

- async block/extends explicit input plumbing

Implement:

- async render/composition entry points can accept explicit extern-input maps
- async include/block/import paths have a dedicated way to pass extern inputs
  without reusing ambient shared context visibility
- async composition paths can separately carry the special `with context` flag
  without treating it as an extern input
- block invocation can carry an explicit input map separately from normal shared
  inheritance state

Verify:

- extern inputs can be supplied distinctly from legacy ambient scope
- `with context` can be supplied distinctly from extern inputs
- the new plumbing can be used by top-level render, include, and block
  invocation
- no implementation step after this needs to smuggle externs through parent
  lexical visibility

Add tests:

- low-level async render/composition tests that explicit extern-input plumbing is
  exercised rather than ambient parent visibility

### Step 3: Add root-only `extern` validation

Status: implemented

Implement:

- `extern` may appear only at root scope
- `extern` names must obey normal declaration conflict rules
- `extern` names must obey reserved-name rules

Verify:

- root-level `extern` is accepted
- `extern` inside `if`, `for`, `block`, `macro`, `guard`, and nested scopes is
  rejected
- duplicate/conflicting declarations fail with clear errors

Add tests:

- positive root-scope `extern` cases
- negative nested-scope `extern` cases
- declaration conflict cases

### Step 4: Represent `extern` in analysis as a distinct declaration kind

Status: partially implemented

Implemented now:

- `Extern` participates in async declaration analysis as a distinct declaration
  kind
- root analysis records an `externSpec`
- compiled async templates/scripts expose `externSpec`
- extern declarations are treated as non-renamable in practice

Still pending in this step:

- block contract analysis / explicit block `with ...` metadata

Implement:

- `Extern` participates in declaration analysis as a separate declaration type
- `Extern` carries fallback initializer metadata
- `Extern` is marked non-renamable
- root analysis records an `externSpec`
- block analysis records explicit `with` input contracts
- compiled async templates/scripts expose `externSpec` for runtime validation of
  dynamic composition targets

Verify:

- `extern` shows up in declaration ownership correctly
- `extern` fallback metadata is preserved
- the renaming pass leaves `extern` names unchanged
- dynamic-target callers can read `externSpec` from compiled async targets

Add tests:

- analysis coverage for extern declaration ownership
- rename-pass coverage proving ordinary locals may be renamed while extern names
  are not

### Step 5: Define extern initialization ordering and failure rules

Status: partially implemented

Implemented now:

- extern initialization runs in declaration order
- fallback references to later externs are rejected
- earlier-extern fallback dependencies work

Still pending in this step:

- any additional cycle detection beyond the current ordering rule, if desired

Implement:

- extern initialization runs in declaration order
- fallback initializers may depend on earlier externs and globals
- fallback references to later externs are rejected
- initialization cycles are rejected

Verify:

- `extern b = 1; extern a = b` works when ordered correctly
- `extern a = b; extern b = 1` fails clearly
- direct and indirect cycles fail clearly

Add tests:

- declaration-ordered fallback success
- later-extern dependency failure
- direct and indirect cycle failure

### Step 6: Make `extern` lower to ordinary local var behavior after initialization

Status: implemented

Implement:

- after composition initialization, `extern` bindings behave like local vars
- ordinary symbol lookup sees them as normal vars
- ordinary assignments/reassignments target them as normal vars
- ordinary use/mutation tracking includes them
- async lowering reuses the existing async var-channel representation rather than
  inventing a separate extern runtime store

Verify:

- reads of `extern` names compile like reads of vars
- `{% set externName = ... %}` updates the local binding
- uses and mutations involving `extern` names contribute to ordinary analysis
- async lowering uses the same var-channel / `VarCommand` machinery as ordinary
  async vars

Add tests:

- ordinary symbol read/write tests for initialized extern bindings
- analysis tests covering uses/mutations of extern-backed locals

### Step 7: Introduce explicit extern-input initialization at render entry

Status: implemented

Implement:

- top-level async template/script rendering initializes declared `extern`s from
  the render context
- fallback initializers apply only when no value is provided
- missing required externs fail during initialization

Verify:

- async top-level render works with provided extern values
- fallback externs initialize correctly
- required externs without provided values fail clearly

Add tests:

- top-level render-context provisioning
- top-level fallback initialization
- missing required extern failure at render entry

### Step 8: Define async include contract rules before conversion

Status: implemented

Implement:

- define whether async `include "x"` with no `with ...` is valid
- define how async `include ... with context` exposes render-context properties
- recommended rule:
  - valid when the child has no required externs
  - valid when all child externs have fallbacks
  - invalid when the child has required externs not supplied by `with ...`

Verify:

- includes with no `with ...` behave consistently
- required child externs are enforced
- fallback-only child externs work without explicit inputs
- `with context` exposes render-context properties without exposing parent frame
  locals or async var channels

Add tests:

- include without `with ...` and no required externs
- include without `with ...` and fallback-only externs
- include without `with ...` and missing required externs
- include with `with context`
- include with `with context, var1`

### Step 9: Convert async include from implicit visibility to explicit inputs

Status: implemented

Implement:

- async include evaluates only the parent-side `with ...` expressions
- async include treats reserved `context` separately from named extern inputs
- build an extern-input object for the child
- initialize child extern locals from that object
- seed child render-context visibility only when `with context` is present
- remove implicit include-visible parent var exposure
- remove parent var-channel linking for include-passed variables
- remove parent command-buffer binding for include-passed variables

Keep:

- child output composition structure
- include output ordering

Verify:

- included children can read only passed externs and fallback externs
- included children can read render-context properties only when `with context`
  is present
- child rebinding does not affect the parent
- output ordering remains unchanged
- includes no longer depend on parent var visibility linking

Update broken tests as needed:

- convert old async include tests that assumed implicit parent visibility to the
  new explicit `with ...` model
- keep equivalent sync include tests unchanged

Add tests:

- include with explicit extern inputs
- include with `with context`
- include local rebinding without parent mutation
- include output ordering under explicit inputs

### Step 10: Keep parent-side alias resolution only for argument binding

Status: implemented

Implement:

- when a parent-side `with name` refers to an internally renamed binding such as
  `name#7`, resolve that alias on the parent side only
- pass the resulting value into the child under the extern name `name`

Verify:

- renamed parent locals still pass correctly through `with ...`
- child extern names remain stable and unrenamed
- no child ambient visibility is created by alias handling

Add tests:

- passing renamed parent locals through `with ...`
- nested-scope/duplicated-name cases that require parent-side alias resolution

### Step 11: Convert async import/from-import to the uniform async `with` model

Status: implemented

Implement:

- async import/from-import never request parent lexical visibility
- async import/from-import support the same `with ...` interface as other async
  composition forms
- async `with context` exposes render-context properties through ordinary bare
  lookup, but does not expose parent frame locals or async var channels
- explicit named `with ...` inputs initialize imported-file externs
- imported files with required externs must be satisfied by explicit `with ...`
  inputs or fallbacks
- dynamic import targets perform the same validation at runtime once resolved

Implemented now:

- async import/from-import do not request parent lexical visibility
- async import/from-import support explicit named `with ...` inputs
- async `with context` exposes render-context properties through ordinary bare
  lookup
- imported files with required externs fail unless satisfied by explicit named
  inputs, render-context visibility, or fallbacks
- dynamic import validation exists

Verify:

- async imports cannot see parent locals
- async imports can see render-context properties only when `with context` is
  present
- async imports can receive explicit extern inputs through `with ...`
- imported macros still work through explicit macro arguments
- importing files with unsatisfied required externs fails clearly

Update broken tests as needed:

- replace old temporary async rejection tests with the uniform async
  `with context` behavior
- keep sync import compatibility tests unchanged

Add tests:

- isolated async import without `with context`
- async import with `with context`
- async import with explicit named inputs
- async from-import with `with context`
- async from-import with explicit named inputs
- dynamic import validation

### Step 12: Define block-input declaration rules

Status: not implemented yet

Implement:

- explicit block input names are treated as invocation-local var declarations
- block input names participate in declaration conflict checks
- block input names are available to ordinary symbol lookup and assignment in
  the block body
- block input names are not renamed
- the authoritative `with ...` contract belongs to the base/invoking block
- an overriding child block declaring its own `with ...` is rejected in async
  mode

Verify:

- conflicting local declarations are rejected clearly
- block input names behave like ordinary local vars inside the block
- assignment targets the invocation-local binding only
- child `with ...` on an overriding block is rejected clearly

Add tests:

- block input declaration conflicts
- block input rebinding inside the overriding block

### Step 13: Convert async block invocation to explicit block inputs

Status: not implemented yet

Implement:

- async block definitions carry explicit `with ...` contracts
- at block invocation, evaluate those expressions in the invocation scope
- initialize local block bindings from the resulting input object
- do not share parent var lanes or parent variable buffers with the block
- preserve child top-level setup ordering relative to base-template execution

Verify:

- overriding blocks see only explicit block inputs plus child-template-local
  declarations
- local rebinding inside the block stays local
- no implicit parent lexical visibility remains in async inheritance
- child top-level setup still runs in the intended order

Update broken tests as needed:

- replace old async inheritance tests that assumed shared implicit parent locals
- preserve sync inheritance compatibility tests

Add tests:

- async block invocation with explicit inputs
- child top-level setup ordering relative to base execution

### Step 14: Define `super()` over the same invocation input map

Status: not implemented yet

Implement:

- `super()` receives the same explicit input map as the overriding block
- each block implementation gets its own local initialization from that map
- `super()` does not observe local rebindings from the overriding block

Verify:

- `super()` sees the same explicit inputs the block was invoked with
- local rebinding in the child block does not leak into `super()`
- inheritance-chain dispatch still works correctly

Add tests:

- `super()` with explicit inputs
- child-local rebinding does not affect `super()`

### Step 15: Do not copy `__caller__` scheduling machinery to blocks

Status: not implemented yet

Note:

- this is still the intended direction
- no block-specific `__caller__` machinery has been added, but the block/super
  explicit-input model itself is also not implemented yet

Implement:

- keep `CALLER_SCHED_CHANNEL_NAME` / `__caller__` exclusive to macro/caller
  scheduling
- keep block and `super()` invocation structurally direct
- do not add caller-style all-blocks coordination unless a real scheduling need
  appears later

Verify:

- block rendering works without macro-style caller scheduling channels
- `super()` works without detached caller-style coordination
- caller behavior remains unchanged

Add tests:

- regression coverage proving caller scheduling still behaves unchanged
- regression coverage proving block/super work without caller-specific channels

### Step 16: Remove obsolete async include visibility machinery carefully

Status: partially implemented

Implemented now:

- include no longer uses the old parent-var snapshot/visibility path as its
  semantics
- the dead `linkWithParentCompositionBuffer()` path has been removed

Still pending in this step:

- final audit/removal of remaining obsolete include-specific helpers and
  callsites

After the new extern-input path is working, remove obsolete async composition
logic that is no longer the source of truth for variable visibility:

- include-specific use of implicit include-visible-var analysis as the async
  composition model
- include-specific boundary alias maps for child visibility
- include-specific parent var-channel linking for passed values

Do not remove shared helpers blindly until all remaining async callers of that
machinery have been audited.

Explicitly audit:

- `src/compiler/boundaries.js`
- `src/compiler/scope-boundaries.js`
- `analysis.getIncludeVisibleVarChannels()`
- `compiler.emitLinkWithParentCompositionBuffer()`
- `runtime.linkWithParentCompositionBuffer()`
- `context.prepareForAsyncBlocks()`
- `context.finishAsyncBlocks()`

Keep:

- output-composition structure used for rendering order

Verify:

- removing the old machinery does not change intended output behavior
- async composition visibility now depends only on `extern` and `with ...`
- there are no remaining async callers depending on the removed include-specific
  visibility path

Add tests:

- regression coverage after removal of old include visibility machinery
- focused tests proving no fallback to implicit parent visibility remains

### Step 17: Add focused tests

Status: partially implemented

Implemented now:

- parser / transpiler coverage for `extern` and `include ... with ...`
- sync rejection coverage for `extern`
- async root extern initialization / fallback / missing-required tests
- async include explicit-input tests
- renamed-parent-local tests for `with ...`
- regular duplicated-var renaming tests for include canonicalization
- isolated async import/from-import tests
- async import/from-import required-extern rejection tests
- async import/from-import fallback-extern tests
- dynamic async import validation tests
- dynamic include-target validation tests

Still pending in this step:

- block-input declaration/conflict tests
- overriding child block `with ...` rejection
- `super()` explicit-input tests

Add async tests for:

- root-level extern initialization from render context
- extern fallback initialization
- required extern failure
- root-only extern validation
- include with explicit extern inputs
- include local rebinding without parent mutation
- passing renamed parent locals through `with ...`
- isolated async import/from-import
- dynamic import validation
- block explicit-input invocation
- block input declaration conflicts
- overriding child block `with ...` rejection
- `super()` with explicit inputs
- child-top-level locals plus explicit block inputs
- extern initialization order
- extern fallback dependency failures
- extern initialization cycles

Keep sync regression coverage to ensure:

- Nunjucks-compatible sync composition remains unchanged

### Step 18: Update user-facing documentation

Status: not implemented yet

After implementation stabilizes, update:

- async template docs
- async script docs if script composition uses the same extern contract model
- migration notes for async users moving away from implicit parent visibility

### Step 19: Re-evaluate simplifications after implementation

Status: not implemented yet

Once the implementation exists, review whether the architecture can be
simplified further:

- whether block contracts should remain on `block ... with ...` exactly as
  proposed
- whether dynamic child validation needs any extra caching
- whether any old async composition helper code can be deleted entirely

The important rule for this final review is:

- keep sync compatibility untouched
- keep async composition explicit
- keep `extern` var-like after initialization
