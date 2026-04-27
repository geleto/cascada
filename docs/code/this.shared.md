# `this.<shared>` Shared Access Proposal

This document captures the agreed direction for moving inherited shared access
from bare identifiers to an explicit `this.<name>` surface.

It is a design note, not the current implementation contract. Once implemented,
the relevant user docs and architecture docs should be updated to make this the
canonical model.

## Goal

Inside an executing `extends` / `component` script or template hierarchy,
shared state should be accessed through `this`, the same object used for
inherited method dispatch. Caller-side component observation remains a separate
surface such as `widget.theme`.

Current script style:

```cascada
shared var theme
shared text log

theme = "dark"
log("started")
return theme
```

Target script style:

```cascada
shared var theme
shared text log

this.theme = "dark"
this.log("started")
return this.theme
```

The long-term rule is:

> Everything that currently works as `<shared>` in scripts should work as
> `this.<shared>`.

The long-term direction is that bare shared access in scripts should be
deprecated and removed. Bare identifiers should mean ordinary ambient lookup:
locals, arguments, composition payload, context, and globals. The additive
migration step is only a compatibility bridge, not the desired final language
surface.

## Why

`this.<shared>` has several advantages over bare shared names:

- it is consistent with inherited method calls (`this.method(...)`)
- it gives readers a clear signal that the access goes through inherited
  hierarchy state
- it lets bare identifiers return to ordinary local / argument / payload /
  context / global lookup
- it makes missing per-file shared declarations easier to report as structural
  errors
- it maps well to the object-oriented mental model:
  - `this.theme` is instance state
  - `this.render(...)` is virtual method dispatch
  - `super(...)` calls the parent implementation

## Script Semantics

Scripts still need explicit `shared` declarations in every file that uses a
shared channel.

That requirement remains because scripts support typed shared channels:

- `shared var`
- `shared text`
- `shared data`
- `shared sequence`

The compiler must know the channel type in the current file to compile the
operation correctly.

Examples:

```cascada
shared var theme
shared text log
shared data result
shared sequence db

var current = this.theme
this.theme = "dark"

this.log("boot|")
var text = this.log.snapshot()

this.result.user.name = "Ada"
var data = this.result.snapshot()

this.db.insert({ id: 1 })
```

The same syntax applies inside methods:

```cascada
shared var theme
shared data result

method build(name)
  this.result.name = name
  return "[" + this.theme + "] " + name
endmethod
```

`this.<name>` in scripts should resolve as follows:

| Form | Meaning |
|---|---|
| `this.method(...)` | inherited method dispatch |
| `this.varName` | shared `var` read at the current source position |
| `this.varName = value` | shared `var` write |
| `this.textName(...)` | call the shared text channel, normally appending the argument |
| `this.dataName.path = value` | shared data-channel operation |
| `this.channel.snapshot()` | explicit shared-channel snapshot |
| `this.sequenceName.method(...)` | shared sequence-channel operation |

`this.varName` is a shared-var read/observation at that point in ordered
execution. It uses the same ordering semantics as current shared-var reads; it
does not mean ambient context lookup and it does not fall through to payload or
globals.

Shared default expressions still use ordinary bare-name ambient lookup for
payload, context, and global values:

```cascada
shared var theme = initialTheme or "light"
```

Here `initialTheme` is a composition-payload / context / global lookup, not a
shared access. The new `this.<shared>` surface does not change default
expression lookup rules.

If `this.<name>` is used in a script, the compiler/runtime must disambiguate
the name:

- declared shared channel only: compile as shared access
- inherited method target only:
  - `this.name(...)` is inherited method dispatch
  - bare `this.name` is a structural error; inherited methods must be called
- both shared channel and inherited method target: structural ambiguity error
- neither shared channel nor inherited method target: structural missing-name
  error

The error should be caught at compile time where the current file has enough
information, such as a local shared declaration colliding with a local method
definition. Collisions with inherited method metadata may require bootstrap /
metadata finalization, because the final method table is only known after the
chain is loaded.

If the same name is both a declared shared channel and an inherited method
target, that is a structural ambiguity and should be rejected. The compiler
should not silently choose one meaning based on syntax or ordering.

Shared sequence access through `this` should use sequence-channel operations,
not the `!` operator:

```cascada
this.db.insert(row)
```

The `!` operator remains limited to static context-object paths. It should not
be extended to shared roots such as `this.db!`.

## Bare Shared Access

"Bare shared access" means using a shared name without `this.`:

```cascada
shared var theme
shared text log

theme = "dark"
log("started")
return theme
```

The target model prefers:

```cascada
this.theme = "dark"
this.log("started")
return this.theme
```

For migration, implementation can be additive first:

1. support `this.<shared>` everywhere bare `<shared>` works today
2. update docs and examples to prefer `this.<shared>`
3. deprecate bare shared access once `this.<shared>` has full parity
4. remove bare shared access in a later breaking/migration pass
5. after removal, undeclared bare names remain ordinary
   ambient lookup

Keeping bare shared access permanently would preserve two meanings for the same
state and would lose one of the main benefits of this proposal.

## Templates

Templates should use `this.<name>` for inherited shared vars:

```njk
{% set this.theme = "light" %}
{{ this.theme }}
{{ this.user.name }}
```

Templates do not need explicit shared declarations for this access.

Reason: template shared access is var-only. Templates do not expose typed shared
channels (`text`, `data`, or `sequence`) through this surface, so the compiler
does not need a declaration to disambiguate the channel type.

Inferred template shared vars are declaration-only. They do not provide shared
defaults. For example, `{% set this.theme = "light" %}` is a runtime
constructor write to the shared var, not a default initializer and not part of
child-first shared default priority.

Template compiler behavior:

- analyze static `this.<name>` paths and infer only the root name
- infer each root name as an implicit `shared var`
- feed those inferred names into the same shared-schema metadata path as
  explicit `shared var` declarations
- compile `this.name` as a shared-var read/observation at the current source
  position
- compile `this.name.path` as a shared-var read/observation of `name`, followed
  by ordinary property lookup on the resolved value
- compile `{% set this.name = value %}` as shared-var assignment

Dynamic paths should stay out of scope initially:

```njk
{{ this[name] }}
{% set this[userKey] = value %}
```

Those should be rejected clearly as unsupported dynamic shared access until the
compiler has a deliberate dynamic-shared design.

## Template Assignment Scope

The required template form is:

```njk
{% set this.theme = "light" %}
```

This should assign the shared var `theme`.

The first implementation pass only needs to support direct-root writes like
`{% set this.theme = value %}`.

Nested writes need to follow existing template assignment capabilities. If
ordinary `{% set obj.path = value %}` is supported, then
`{% set this.user.name = "Ada" %}` can map to a shared-var object mutation. If
that object-path assignment is not already supported, it should not be invented
as part of the first `this.<shared>` implementation pass.

## Channels In Templates

Template `this.<name>` access is only for shared vars. This is the core
script/template boundary rule for this proposal: scripts use declarations to
access typed shared channels; templates infer shared vars only.

Do not implicitly expose shared `text`, `data`, or `sequence` channels to
templates through `this`.

If script-side shared channels need to be rendered by a template, that should be
done through explicit script orchestration or a future deliberately designed
template channel API.

This proposal targets async inheritance templates. The synchronous
Nunjucks-compatible template path should remain unchanged unless a separate
sync-template design explicitly opts into this behavior.

Within async inherited templates, `this` becomes reserved for inheritance shared
access. A render-context variable named `this` should not intercept
`this.<name>` shared lookup in that mode.

## Component Observations

The existing component namespace behavior remains a separate caller-side
observation surface:

```cascada
component "Widget.script" as widget

var theme = widget.theme
var name = widget.theme.name
var logLength = widget.log.snapshot().length
```

Rules:

- `widget.theme` is an implicit shared-var snapshot
- `widget.theme.name` is an implicit shared-var snapshot followed by ordinary
  property lookup
- implicit nested reads are var-only
- non-var channels require explicit `.snapshot()`
- Cascada must not implicitly call `.snapshot()` for non-var channels, because
  `snapshot()` waits for ordered channel work to finish and may be expensive

This component behavior is related to `this.<shared>` but not identical:

- `this.<shared>` is intra-hierarchy access from the currently executing script
  or template
- `componentName.<shared>` is caller-side observation of another component
  instance

## `super()` And Shared State

The new syntax does not change shared-state ordering or default semantics.

If a child declares:

```cascada
shared var theme = "dark"
```

and a parent constructor later runs through `super()` and writes:

```cascada
this.theme = "light"
```

then the parent assignment is an ordinary runtime shared-var write. It can
overwrite the default value just like today's bare shared assignment can.

Child-first default priority still applies only to shared default
initialization. Runtime writes from constructors and methods follow normal
source-order and command-buffer ordering.

## Runtime And Metadata Notes

For scripts, `this.<shared>` should compile to the same runtime operations as
the current bare shared access, using the current file's explicit shared
declaration to select the correct channel behavior.

For templates, inferred `this.<name>` roots should participate in shared schema
metadata as `var` channels. The final runtime should not need a special
template-only lookup path if the inferred names are normalized into the shared
metadata during compilation/finalization.

Structural error behavior:

- script `this.<name>` with no local shared declaration and no inherited method
  dispatch target should be a structural error
- template `this.<name>` should infer shared `var` metadata instead of requiring
  a declaration
- bare undeclared names in both scripts and templates remain ordinary ambient
  lookup

## Core Disambiguation Model

The compiler should not let each syntactic form decide independently what
`this.<name>` means. It should classify the static `this.<root>` access first,
then lower according to that classification.

The same classifier should be used for:

- expression reads: `this.theme`
- assignment targets: `this.theme = value`, `this.result.path = value`
- call expressions: `this.render(...)`, `this.log(...)`
- sequence-channel calls: `this.db.insert(row)`
- invalid bare method references: `this.render`

Classification rules:

1. Extract a static `this.<root>` path when possible.
2. Check whether `<root>` is declared as a shared channel in the current file.
3. Check whether `<root>` is a known inherited/local method target.
4. If both shared and method exist, report a structural ambiguity error.
5. If only shared exists, lower through shared-channel logic using the declared
   shared type.
6. If only method exists:
   - `this.name(...)` is inherited method dispatch.
  - bare `this.name` and assignment to `this.name` are structural errors.
  - `this.name!` is also invalid; `!` remains limited to static
    context-object paths, not inherited methods or shared roots.
7. If neither exists, report a structural missing-name error.

The lookup order above is not precedence. It is only a way to compute the
classification. Shared declarations must not silently win over method metadata,
and method metadata must not silently win over shared declarations.

Call-form examples:

```cascada
this.render()   // method dispatch if `render` is only a method
this.log("x")   // shared channel call if `log` is only declared shared text/data
```

If `render` or `log` exists in both spaces, the file is ambiguous and should
fail structurally.

## Documentation Updates Required

When implemented, update:

- `docs/cascada/script.md`
  - make `this.<shared>` the preferred script shared-access syntax
  - explain that script files still declare shared names because the compiler
    needs the channel type
  - show examples for `var`, `text`, `data`, and `sequence`
  - explain the template contrast: templates infer `this.<name>` as shared var
  - mark bare shared access as legacy / shorthand if it remains supported

- `docs/cascada/template.md`
  - add a focused inheritance/shared-var section
  - explain that templates use `this.name` for inherited shared vars
  - explain that templates do not need shared declarations because shared access
    is var-only
  - show `{% set this.theme = "light" %}` and `{{ this.theme }}`
  - state that typed shared channels are script-only in this model

- `docs/code/extends-architecture.md`
  - update the shared access surface to include `this.<shared>`
  - clarify script declarations versus template inference

- `docs/code/extends-metadata-architecture.md`
  - describe template inference of implicit shared-var metadata from static
    `this.<name>` paths
  - clarify that script `this.<shared>` still relies on per-file declarations

## Test Coverage Required

These are design-time test requirements. Add them as real tests as each pass is
implemented; do not add them as failing tests before the feature exists.

| Area | Case | Source shape | Expected |
|---|---|---|---|
| Script var | Shared var read | `shared var theme = "dark"\nreturn this.theme` | Returns `"dark"` with the same ordering semantics as bare `theme`. |
| Script var | Shared var write | `shared var theme = "dark"\nthis.theme = "light"\nreturn this.theme` | Returns `"light"`. |
| Script var | Method-body shared var read/write | `method setTheme(v)\n  this.theme = v\nendmethod` then `this.setTheme("light")` | Method writes the shared var visible to later reads. |
| Script var + `super()` | Parent writes during `super()` | Child calls `super()`, parent writes `this.theme = "parent"`, child reads `this.theme` after `super()` | Child reads `"parent"`; runtime writes keep normal ordering and can override defaults. |
| Script dispatch | Shared read passed to inherited method | `return this.render(this.theme)` | Dispatch and shared-var read both lower correctly in one expression. |
| Script text | Shared text call | `shared text log\nthis.log("a")\nreturn this.log.snapshot()` | Returns `"a"`. |
| Script data | Shared data path write | `shared data result\nthis.result.user.name = "Ada"\nreturn this.result.snapshot()` | Returns `{ user: { name: "Ada" } }` or the existing data-channel equivalent. |
| Script sequence | Shared sequence call | `shared sequence db = makeDb()\nthis.db.insert(row)` | Uses the existing sequence-channel operation path; no `!` is involved. |
| Script sequence | Constructor and method share sequence channel | Constructor calls `this.db.insert("c")`; method calls `this.db.insert("m")` | Both operations serialize through the same shared sequence channel. |
| Script method | Inherited dispatch still works | `return this.build("Ada")` | Dispatches to the most-derived `build`. |
| Script method | Bare inherited method reference | `return this.build` | Structural error; inherited methods must be called. |
| Script missing | Undeclared `this` access | `return this.theme` without `shared var theme` and without method `theme` | Structural missing-name error, not ambient lookup. |
| Script ambient | Bare undeclared access unchanged | `return theme` with `theme` only in context/payload/global | Uses ordinary ambient lookup. |
| Script ambiguity | Local shared/method collision | Same file declares `shared var build` and `method build()` | Structural ambiguity error. |
| Script ambiguity | Inherited shared/method collision | Child declares `shared var build`; parent contributes method `build()` | Bootstrap/finalization structural ambiguity error. |
| Script invalid `!` | `!` on shared root | `shared sequence db = makeDb()\nthis.db!.insert(row)` | Rejected; `!` remains limited to static context-object paths. |
| Template read | Inferred shared var read | `{{ this.theme }}` in an async inherited template | Reads shared var `theme` without explicit template shared declaration. |
| Template write | Inferred shared var write | `{% set this.theme = "light" %}{{ this.theme }}` | Writes and reads shared var `theme`. |
| Template nested read | Inferred root plus property lookup | `{{ this.user.name }}` | Infers shared var `user`, then does ordinary `.name` lookup. |
| Template chain | Parent and child infer same shared var | Parent reads `this.theme`; child writes `this.theme` | Both use the same shared var. |
| Template context clash | Context has `this` property | Render context is `{ this: { theme: "wrong" } }`, template uses `{{ this.theme }}` | Reads inherited shared var, not context `this.theme`. |
| Template dispatch + shared | Method and shared access in same block | Template block uses `this.render(...)` and `this.theme` with different names | Method dispatch and shared-var inference do not collide. |
| Template dynamic | Dynamic `this[...]` | `{{ this[name] }}` or `{% set this[name] = value %}` | Clear unsupported dynamic shared-access error. |
| Template channel boundary | Typed shared channel not inferred | Template attempts to use `this.log(...)` for a script `shared text log` | Rejected or not inferred; template `this.<name>` is var-only. |
| Sync template boundary | Sync template compatibility | Existing sync Nunjucks-style template with context `this` | Unchanged unless a separate sync-template design opts in. |
| Component observation | Component shared var nested read | `widget.theme.name` where `theme` is shared var object | Works as implicit shared-var observation plus property lookup. |
| Component observation | Component non-var nested read | `widget.log.value` where `log` is shared text | Errors; no implicit snapshot for non-var channels. |
| Component observation | Explicit non-var snapshot property | `widget.log.snapshot().length` | Works explicitly. |
| Migration | Bare shared removal does not affect templates | After script bare shared access removal, template `{{ this.theme }}` still works | Template inference remains operational. |

## Implementation Checklist

- shared declaration collection
  - keep explicit per-file declarations for scripts
  - add template inference of static `this.<root>` names as declaration-only
    `shared var` entries
- lookup lowering
  - compile script `this.<shared>` reads through the same shared-aware path as
    the current bare shared access
  - compile template `this.<root>` reads through inferred shared-var metadata
  - compile `this.<root>.path` as shared-var read plus ordinary property lookup
- assignment lowering
  - compile script `this.<shared> = value` and channel writes through the same
    channel logic as current bare shared assignments
  - compile template `{% set this.<root> = value %}` as shared-var assignment
- call lowering
  - preserve `this.method(...)` inherited dispatch
  - compile `this.<sharedChannel>(...)` as a channel operation only when the
    current file declares that shared channel
  - reject method/shared name collisions as structural ambiguity
- sequence-channel lowering
  - compile `this.<sharedSequence>.method(...)` through the existing shared
    sequence-channel operation path
- diagnostics
  - script undeclared `this.<name>` should be a structural error
  - template dynamic `this[...]` should be rejected clearly
  - bare undeclared names should continue to use ordinary ambient lookup

## Implementation Strategy

This section describes the expected implementation path, but it is not a
line-by-line prescription. The behavior contract above is authoritative. The
implementor should choose the smallest, clearest code changes that fit the
existing compiler/runtime structure.

If the current code already has a simpler helper, a cleaner analysis hook, or a
more direct lowering path than the one described here, use it. If implementing a
pass reveals a better simplification, prefer the clearer implementation and
update this document only when the behavior contract changes.

Guiding constraints:

- reuse existing shared-channel analysis and lowering wherever possible
- avoid new runtime command types unless existing shared-channel commands cannot
  express the behavior
- keep script `this.<shared>` additive at first
- keep template inference var-only
- preserve current command-buffer ordering and linked-channel semantics
- keep diagnostics structural and explicit
- add focused tests before or alongside each behavior change

### Pass 0: Baseline Inventory

Before changing behavior, identify the exact existing lowering paths for bare
shared access. This is a quick orientation step, not a required standalone
commit.

Inventory should cover:

- shared declaration collection
- shared `var` lookup and assignment lowering
- shared `text` / `data` / `sequence` channel-call lowering
- explicit `snapshot()` lowering
- inherited `this.method(...)` dispatch lowering
- current diagnostics for bare `this.method` without a call
- parser / AST behavior for:
  - `this.name` as a bare expression
  - `this.name = value` as an assignment target
  - `this.db.insert(row)` as a sequence-channel call

Expected output:

- no behavior change
- enough notes for the implementor to reuse existing helpers instead of adding
  a parallel shared-access implementation

This pass can be folded into Pass 1 if doing so keeps the code easier to
understand.

#### Phase 0 Inventory Results

Phase 0 found that most of the needed behavior already exists for bare shared
names and component observations. Pass 1 should reuse those paths rather than
build a parallel implementation.

Existing compiler/runtime paths:

- Shared declaration collection
  - `CompilerCommon._getSharedDeclarations(...)` reads
    `InheritanceMetadata.sharedDeclarations`.
  - `CompileInheritance.compileSharedSchemaLiteral(...)` emits the compiled
    `sharedSchema` object from explicit declarations.
  - `CompileInheritance.emitRootSharedDeclarations(...)` emits runtime channel
    declarations for those shared declarations.
- Shared default initialization
  - `compileChannelDeclaration(...)` already routes shared declarations through
    `runtime.getInheritanceSharedBuffer(...)`.
  - `runtime.claimInheritanceSharedDefault(...)` controls child-first default
    claiming.
  - `runtime.initializeInheritanceSharedChannelDefault(...)` handles shared
- Bare shared `var` reads
  - `_compileDeclaredSymbolLookup(...)` detects shared channel declarations.
  - Shared var reads lower to `_emitSharedChannelObservation(name, node,
    'snapshot', true)`.
  - Runtime enforcement lives in
    `runtime.observeInheritanceSharedChannel(..., implicitVarRead = true)`,
    which rejects non-var channels used as bare symbols.
- Shared `is error` and `#`
  - `compileIs(...)` and `compilePeekError(...)` detect declared shared
    channels and call `_emitSharedChannelObservation(...)` with `isError` /
    `getError`.
- Shared channel calls and snapshots
  - `analyzeFunCall(...)` already builds `specialChannelCall` from static paths
    whose root is a declared channel.
  - `_compileSpecialChannelFunCall(...)` is the likely reuse point for
    `this.log(...)`, `this.result...`, `this.db.insert(...)`, and
    `this.channel.snapshot()`.
- Shared sequence channels
  - Shared `sequence` channels are ordinary channel declarations with type
    `sequence`.
  - Sequence-channel calls should reuse channel-call lowering. The `!` operator
    is unrelated and must remain context-path-only.
- Inherited method dispatch
  - `_getExplicitThisDispatchFacts(...)` recognizes static `this.method`.
  - `compileFunCall(...)` marks the lookup as an allowed call and lowers it to
    `runtime.invokeInheritedMethod(...)`.
  - `compileLookupVal(...)` currently rejects bare `this.method` references.
- Component observation
  - `_getComponentBindingFacts(...)` and component observation lowering are a
    useful local pattern for classifying a static root before lowering.
  - Do not merge component observation with `this.<shared>`; it is caller-side
    observation of another instance.
- Parser / AST shape
  - Existing code already sees `this.method` as a `LookupVal`, so
    `this.name` as a bare expression is likely already parsed.
  - Assignment and channel-call target support still needs confirmation while
    implementing Pass 1, because `compileSet(...)` currently expects simple
    symbol targets for ordinary set declarations/assignments.

Implementation implication:

- Add a small shared classifier for script `this.<root>` static paths.
- Feed the classifier into existing shared symbol/channel lowering paths.
- Avoid adding runtime commands.
- Do not extend sequential `!` analysis for shared roots.
- Template inference will need separate collection because current shared
  schema generation only reads explicit `sharedDeclarations`.

### Pass 1: Script Shared Surface

Add script support for `this.<shared>` parity for `var`, `text`, `data`, and
`sequence` shared channels. These should be implemented together unless the
codebase shows a simpler natural split, because the hard part is recognizing
`this.<name>` as a declared shared root and then reusing the existing
shared-channel lowering.

Required behavior:

```cascada
shared var theme
shared text log
shared data result
shared sequence db

var current = this.theme
this.theme = "dark"

this.log("boot|")
var text = this.log.snapshot()

this.result.user.name = "Ada"
var data = this.result.snapshot()

this.db.insert(row)
```

should match the existing bare shared behavior.

Calls to `this.<sharedSequence>.method(...)` are ordered by the shared sequence
channel itself; they do not need, and must not use, the context-path-only `!`
operator.

Implementation notes:

- add one shared-root recognition path for script `this.<name>` static paths
- route all script `this.<name>` forms through the core disambiguation model
- lower `this.theme` and `this.theme = value` through the existing shared-var
  read/write path
- lower `this.log(...)`, `this.log.snapshot()`, and
  `this.result.path = value` through the existing typed shared-channel paths
- lower `this.db.insert(row)` through the existing shared sequence-channel path
- preserve the existing source-position ordering semantics
- keep bare shared access working during this additive pass
- do not introduce a new runtime command unless the existing command set cannot
  represent the behavior

Diagnostics:

- `this.missing` should be a structural error, not ambient lookup
- `this.methodName` without a call should remain a structural error when the
  name is only an inherited method target
- `this.name(...)` where `name` is both a shared channel and inherited method
  target should be a structural ambiguity
- `this.name(...)` where `name` is neither shared nor inherited method should
  be a structural missing-name error

Tests:

- script shared-var read parity
- script shared-var write parity
- nested script shared-var assignment parity
- method body reads/writes `this.theme`
- shared text call and snapshot parity
- shared data write and snapshot parity
- shared sequence call parity
- shared sequence call on an object whose method reads `this`
- method body can write shared data through `this.result`
- undeclared `this.missing` fails clearly
- bare undeclared `missing` still uses ordinary ambient lookup
- method/shared name collision fails clearly
- parent constructor writes `this.theme` during `super()`, child reads
  `this.theme` afterward
- combined dispatch and shared read in one expression, such as
  `this.render(this.theme)`
- constructor and method operations on `this.db` serialize on the same shared
  sequence channel

#### Pass 1 Review Findings

Pass 1 is implemented and verified for the primary script surface:
`this.<shared>` works for shared `var` reads/writes, shared `text` calls,
shared `data` assignment/commands, shared `sequence` calls, shared snapshots,
shared `is error` / `#` observations, method-body shared var access,
method-body typed shared data access, local shared/method collisions,
constructor-plus-method sequence ordering, and rejection of `!` on
`this.<shared>`.

Cross-file shared/method collisions remain owned by Pass 3 as planned; template
inference remains owned by Pass 2.

Deferred cleanup and diagnostics notes:

- improve undeclared `this.<name>` diagnostics so missing shared declarations
  do not read as bare inherited-method reference errors
- consider whether the dedicated shared text/data command emitter can be folded
  back into the generic channel-call path after template inference is
  implemented

### Pass 2: Template Shared-Var Inference

Add async-template support for `this.<name>` as inferred shared vars.

Required behavior:

```njk
{% set this.theme = "light" %}
{{ this.theme }}
{{ this.user.name }}
```

Template files should not need explicit `shared` declarations for these names.

Implementation notes:

- collect static `this.<root>` paths from template expressions and assignments
- infer each root as declaration-only `shared var`
- feed inferred names into the same shared-schema metadata path as explicit
  shared declarations
- compile `this.name` as shared-var read/observation at the current source
  position
- compile `this.name.path` as shared-var read/observation of `name`, followed
  by ordinary property lookup
- compile `{% set this.name = value %}` as shared-var assignment
- compile `{% set this.name.path = value %}` as shared-var snapshot, nested
  path update, and shared-var assignment

Scope limits:

- only async inherited templates are in scope
- sync Nunjucks-compatible templates remain unchanged
- typed shared channels are not inferred for templates
- dynamic `this[...]` is rejected clearly
- render-context `this` does not intercept async inherited-template shared
  access

Tests:

- parent and child templates infer the same shared var
- `{{ this.theme }}` reads shared var without declaration
- `{% set this.theme = "light" %}` writes shared var
- `{{ this.user.name }}` reads `user` then performs ordinary property lookup
- `{% set this.user.name = "Ada" %}` updates a nested path on the shared var
- dynamic `this[name]` fails clearly
- sync template behavior remains unchanged
- render context containing `{ this: { theme: "wrong" } }` does not intercept
  `{{ this.theme }}`
- a template block can use `this.method(...)` dispatch and `this.theme` shared
  access without collision when the names differ

### Pass 3: Bootstrap-Time Collision Detection

Each earlier pass should add the diagnostics needed for the behavior it
introduces. This pass covers the narrow set of inherited-chain collisions that
cannot be known until blocking bootstrap / metadata finalization has loaded the
full method table and shared schema.

Required behavior:

- shared/method name collisions are structural ambiguity errors
- script `this.<name>` missing from shared declarations and method metadata is a
  structural missing-name error
- bare undeclared identifiers remain ordinary ambient lookup
- inherited methods still require call syntax

Implementation notes:

- catch local collisions at compile time when possible
- catch inherited collisions during blocking bootstrap / metadata finalization
  when the final method table and shared schema are known
- prefer one diagnostic helper if multiple compiler paths can report the same
  error

Tests:

- local shared declaration collides with local method name
- shared declaration collides with inherited method name
- bare `this.inheritedMethod` without call fails
- `this.inheritedMethod(...)` still dispatches correctly

### Pass 4: Documentation

Update documentation once the behavior is implemented and tested.

The user-facing docs should present `this` as one language concept, not as a
bolt-on shared-state feature. The main explanation should be:

> `this` is the current inheritance/component instance. It gives access to
> inherited methods and shared state.

Under that single model:

- `this.method(...)` calls inherited / overridable behavior
- `this.sharedName` reads or writes shared state
- `this.sharedChannel(...)` performs a declared shared-channel operation in
  scripts

The language explanations should read as if `this` was designed this way from the
start.

Required updates:

- `docs/cascada/script.md`
  - introduce `this` once as the inheritance-instance surface
  - document inherited methods and shared state together under that `this`
    model
  - make `this.<shared>` the preferred script shared-access syntax
  - show `var`, `text`, `data`, and `sequence` examples
  - explain that script shared declarations remain required for channel type
    disambiguation
  - explain that shared defaults still read payload/context/global values by
    bare ambient lookup
  - document that bare shared access has been removed for scripts: bare reads,
    calls, snapshots, `is error`, and `#` follow ordinary ambient lookup, while
    bare assignments to a declared shared name fail with a migration message

- `docs/cascada/template.md`
  - keep the template docs focused on template-specific differences instead of
    repeating the full script explanation
  - explain that async inherited templates can use `this.<name>` for shared
    `var` state and `this.method(...)` for inherited block/method dispatch
  - explain that templates do not need shared declarations because template
    shared access through `this.<name>` is var-only and inferred from static
    paths
  - explicitly contrast this with scripts: scripts need shared declarations
    because they can access typed shared channels
  - show `{% set this.theme = "light" %}` and `{{ this.theme }}`
  - say typed shared channels are script-only for this surface

- `docs/code/extends-architecture.md`
  - update the shared access model
  - describe script declarations versus template inference

- `docs/code/extends-metadata-architecture.md`
  - describe inferred template `shared var` metadata
  - clarify that script `this.<shared>` still relies on per-file declarations

### Pass 5: Bare Shared Access Deprecation / Removal

This is the breaking/migration pass that removes script bare shared access.

Long-term behavior:

- scripts should use `this.<shared>` for shared access
- bare identifiers should mean ordinary ambient lookup only

The possible migration sequence before implementation was:

1. update docs and examples to use `this.<shared>`
2. optionally emit warnings for bare shared access if the warning system can do
   so without noisy false positives
3. keep the warning/deprecation path for at least one release before removal,
   if warnings are available
4. provide a documented migration path, and preferably a simple codemod recipe,
   from `sharedName` to `this.sharedName`
5. remove bare shared access in a breaking/migration release
6. keep undeclared bare names on the ambient lookup path

The implemented pass skipped warning emission and made the removal directly:
bare script shared access is no longer a shared-channel operation.

Implementation decision for this pass:

- script bare reads, calls, snapshots, `is error`, and `#` follow ordinary
  ambient lookup only; they do not read or observe shared channels
- `!` remains context-path-only; `db!.insert(...)` where `db` is a declared
  shared sequence is rejected instead of being interpreted as either shared
  sequence access or ambient access
- script bare assignments to a declared shared name fail with a migration
  message pointing to `this.<shared> = ...`
- script `this.<shared>` remains the only shared-access surface
- template `this.<name>` inference remains unchanged

This pass applies to scripts only. Template `this.<name>` shared-var inference
must remain fully operational and should not be weakened by removing script bare
shared access.

Tests for the removal pass:

- old bare shared access fails or follows ambient lookup according to the final
  migration decision
- `this.<shared>` remains fully covered
- undeclared bare names do not probe inherited shared schema
- template `this.<name>` inference still works after script bare shared access
  is removed

### Review Gate After Every Pass

At the end of each implementation pass, perform a short cleanup review before
moving on.

Review questions:

- Completeness: did the pass implement every behavior and diagnostic it
  promised?
- Architecture: does the result still use the existing shared metadata,
  command-buffer, and inherited-method model?
- Simplicity: did the pass add parallel helpers or new runtime concepts that
  can be replaced by existing shared-channel machinery?
- Scope: did it accidentally implement future behavior, such as template typed
  channels or dynamic `this[...]` shared access?
- Tests: do tests cover success, error, method-body usage where relevant, and
  ambient lookup staying ambient?
- Documentation: if user-visible behavior changed in this pass, is the relevant
  doc updated or explicitly deferred to Pass 4?
- Optional regression depth: if a pass touches shared-schema merging, consider a
  three-level inheritance test when it would exercise behavior not already
  covered by a two-level chain.
- Cleanup naming: low-priority helper names such as
  `_templateUsesInheritanceSurface` can be revisited during cleanup if a more
  precise name improves readability without broad churn.

If the review finds a simpler implementation path, take it before starting the
next pass. The goal is a smaller and clearer compiler/runtime, not merely
checking off the pass list.

## Open Decisions

- whether dynamic template shared access should ever be supported
