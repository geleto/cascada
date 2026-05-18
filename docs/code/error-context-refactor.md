# ErrorContext Refactor

This document records the target design for `ErrorContext` and the migration
plan from the current mixed `(lineno, colno, errorContextString, path)` model.

## Goals

`ErrorContext` should be the single source-origin entry passed through
compiler-emitted runtime code, helpers, commands, and command buffers.

It describes where an operation originated in source and how a fatal error
escapes from that operation. It must not become a mutable execution breadcrumb,
buffer lookup helper, or command-routing container.

Target invariants:

- every compiler node has an originating `ErrorContext`
- the context is created at the source origin and then passed unchanged
- commands store the originating context of the source operation that created
  them
- command buffers store the context of the async/control/callable boundary or
  root that created them
- errors store the originating error context when they are first wrapped
- runtime helpers receive an explicit context instead of falling back to a
  nearby buffer or parent operation
- line, column, path, and label formatting are consistent everywhere

## Target Shape

Compiled code stores error contexts in a compact internal table named `__ec`.
Each entry is an array:

```js
const __ec = runtime.prepareErrorContexts(context.path, cb, [
  'For.Iterator(Symbol)', 'For.Limit(FunCall)'
], [
  [1, 0, 'Root'], [3, 7, 'If.Condition(FunCall)'], [4, 12, 0]
]);
```

The label dictionary passed as the third argument contains labels used more
than once. The context specs passed as the fourth argument are collected once
per compiled script/template artifact, not once per function, macro, block, or
method. The analysis pass must collect contexts for the whole compiled artifact
and allocate stable context indices across all compiled callables.

Each compact context spec is either:

```js
[lineno, colno, labelIndex]
[lineno, colno, labelString]
```

Use a numeric label index when the label is present in the repeated-label
dictionary. Use an inline string when the label is used only once. For example:

```js
const __ec = runtime.prepareErrorContexts(context.path, cb,
  ['For.Iterator(Symbol)', 'For.Limit(FunCall)'],
  [[7, 11, 0], [7, 15, 'If.Condition(LookupVal)']]
);
```

`runtime.prepareErrorContexts(context.path, cb, labels, specs)` returns the
per-invocation prepared table named `__ec`, with render-time `path` and `cb`
attached and label indexes resolved. It must not mutate shared label/spec data.
Cached precompiled templates and concurrent renders must never share mutable
prepared context entries.

All compiled callables in the artifact must use the prepared table for the
current invocation. Pass or close over `__ec` wherever root, macro, block,
method, caller, or other compiled functions need to emit runtime helper calls.

Generated code passes entries directly. Runtime helpers should receive both the
source context entry and the current command buffer:

```js
runtime.callWrapAsync(fn, 'fetchUser', context, args, __ec[2], currentBuffer)
runtime.memberLookupScript(target, key, __ec[5], currentBuffer)
currentBuffer.addCommand(new runtime.DataCommand({ args, errorContext: __ec[9] }), chainName)
```

Do not emit expanded objects, constructors, or unpacking loops. Runtime helpers
own the mechanics:

- `runtime.prepareErrorContexts(context.path, cb, labels, specs)` returns a
  prepared per-invocation table with path/callback attached and repeated labels
  resolved
- helpers that need named fields call a small internal
  `normalizeErrorContext(ec)` helper

All compiler-called runtime APIs should receive both the compact prepared
context entry, such as `__ec[index]`, and `currentBuffer`. Do not support
object-or-array dual shapes in runtime helper APIs; transitional compatibility
for legacy object contexts should be isolated to old call sites during migration
and then removed.

## Properties

Required:

- `lineno` - one-based source line for user-facing diagnostics
- `colno` - source column, following the existing project convention
- `path` - template or script path
- `label` - stable description of the source operation
- `cb` - render callback for fatal boundary-owned failures

Do not include:

- `commandBuffer`
- `buffer`
- `chainName`
- `nodeType`
- `positionType`
- `prefix`
- mutable parent/child context state

## Label

Rename `errorContextString` to `label`.

The current field name is implementation-flavored and too narrow. `label`
matches the target meaning: a stable, human-readable description of the source
operation. It may contain AST type information, but it is not itself a raw AST
field.

Recommended labels:

- `FunCall`
- `LookupVal`
- `If.Condition(FunCall)`
- `Switch.Expression(Symbol)`
- `For.Iterator(LookupVal)`
- `For.Limit(FunCall)`
- `While.Condition(FunCall)`
- `Include.Template`
- `Extends.Template`
- `Block`
- `Super`
- `ChainCommand`

Avoid putting command-routing payload into labels. For example, prefer
`ChainCommand` over `ChainCommand(result.posts.push)`. The command payload can
record the data path or method name separately; the error context records the
source origin and position.

## Label Generation

The current compiler generates labels from two pieces:

1. `node` - the owner/operation node passed to `_generateErrorContext(...)`.
2. `positionNode` - the node used for source position and, when different from
   `node`, the node type placed in parentheses.

Current fallback behavior:

- if `node` and `positionNode` are the same, label is `node.typename`
- if their types are the same, label is `node.typename`
- otherwise label is `node.typename(positionNode.typename)`

Examples:

```text
Switch(Symbol)
If(FunCall)
LookupVal
FunCall
```

The target system still starts from the same two current parts: `node` and
`positionNode`. It adds an optional parent-provided owner label for important
child expressions. That parent-provided owner label replaces only the owner
part of the fallback label; the `positionNode` type remains the parenthesized
part when useful.

So labels such as `If.Condition(LookupVal)` are generated from:

1. Parent-provided owner label - for example `If.Condition`,
   `Switch.Expression`, `For.Iterator`, or `For.Limit`.
2. Current position-node type - for example `LookupVal`, `FunCall`, or
   `Symbol`.

Exact rule:

```js
const owner = parentProvidedOwnerLabel || node.typename;
const posType = positionNode.typename;

if (node === positionNode || (!parentProvidedOwnerLabel && owner === posType)) {
  return owner;
}
return `${owner}(${posType})`;
```

Examples:

```text
Switch.Expression(Symbol)
If.Condition(FunCall)
For.Iterator(LookupVal)
```

The compact `ErrorContext` entry stores only the final label, not separate
owner, parent-provided label, and position-node fields. The optional parent
owner label and current position-node type are flattened before storage. The
long-term target is explicit parent-provided owner labels for important child
expressions while preserving the current owner/position-node fallback.

## Parent-Provided Child Labels

Important parent nodes may assign semantic labels to child expressions during
analysis. This is how `Switch.Expression(Symbol)` or `For.Iterator(FunCall)`
fits into the current compiler model.

Example target pattern:

```js
analyzeSwitch(node) {
  node.expr._analysis.errorLabel = 'Switch.Expression';
  return { createsLinkedChildBuffer: true };
}
```

When compiling that child expression, context creation can combine the semantic
label with the actual child node type:

```js
const ecIndex = compiler.getErrorContextIndex(node.expr);
// __ec[ecIndex] label: "Switch.Expression(Symbol)"
```

The context is still created once for the origin. Parent analysis helps choose
the origin label before creation; it does not mutate an existing context later.

## Context Creation

Analysis should assign an error context index to every compiler node. The
compiler should expose one canonical helper for registering or retrieving that
index. The exact API can evolve, but the behavior should be:

```js
getErrorContextIndex(node, {
  positionNode = node,
  label = node._analysis?.errorLabel
} = {})
```

Rules:

- `positionNode` controls `lineno` and `colno`
- `label` is the optional parent-provided owner label
- final label generation follows the algorithm in [Label Generation](#label-generation)
- path and callback are attached by
  `runtime.prepareErrorContexts(context.path, cb, labels, specs)` in the prepared
  per-invocation table
- the specs store already-adjusted, user-facing one-based line numbers; this
  replaces the current `_createErrorContext(...)` `positionNode.lineno + 1`
  adjustment
- the third spec element is either an inline label string or an index into the
  repeated-label dictionary
- emitted runtime calls refer to prepared contexts as `__ec[index]`; compiler
  analysis allocates indices into the artifact-wide specs array

The helper should replace ad hoc object literals like:

```js
{ lineno: node.lineno, colno: node.colno, errorContextString: "...", path: context.path }
```

Those inline literals are a source of inconsistent line numbering, stale field
names, and inconsistent context shapes.

## Commands

Commands should store the originating `ErrorContext` of the source operation
that created them.

Target shape:

```js
new DataCommand({
  args,
  errorContext
})
```

Do not pass `chainName` into command constructors just to support diagnostics.
The buffer or chain application path already knows the chain name when applying
the command. Duplicating it in the command constructor risks divergence.

The separation should be:

- `ErrorContext` - source origin and fatal escape behavior
- command payload - operation-specific data, such as method name or data path
- buffer/chain application - routing context, including the chain being applied

If a diagnostic needs both source origin and chain routing, combine
`command.errorContext` with the apply-time chain name at the reporting site.

## Stored Contexts

Only three runtime structures should store `ErrorContext`:

- commands - store the originating context of the source operation that created
  the command
- command buffers - store the context of the root, async/control boundary,
  callable boundary, include, macro/function/method, or similar execution
  boundary that created the buffer
- wrapped errors - store the originating context assigned when the error is
  first wrapped

Do not store context on `RuntimePromise`, inheritance/composition/macro callable
metadata, delayed observation values, or other helper-owned temporary values for
this refactor. It would be useful to preserve promise origin eventually, but it
is a larger refactor. For now, promise errors are reported at the point of
consumption. Also, repaired errors are not reported, so original promise-source
reporting is not reliably usable yet.

Do not store context just to avoid passing it. If a helper reports failure
synchronously within the call, passing the compact context argument is enough.

## Buffers

Do not store a command buffer reference on `ErrorContext`.

A command buffer should store the compact error context for the boundary that
created it. This buffer context is not a replacement for command/helper source
contexts. It is the execution-frame context used to build Cascada stack
information.

Each command buffer should also retain enough parent linkage to walk the
execution hierarchy:

- normal child buffers use their command-buffer parent
- buffers that intentionally start with a clear scope should still keep a trace
  parent so stack construction can cross that boundary

Clear-scope buffers are any execution boundary that intentionally does not use
the normal command-buffer parent for visibility or scope but still belongs in
the diagnostic stack. Audit and cover at least callable and composition
boundaries: macros/caller bodies, blocks, methods/constructors, includes,
imports/from-imports, components, and extends/parent rendering paths.

`traceParent` is a reasonable name for that extra link because it describes the
purpose directly: it is not visibility, ownership, or command routing; it is
only for diagnostic trace construction.

Buffer diagnostics may include extra execution information in addition to the
boundary context:

- loop variable/current item for loops
- case label or case line for `switch`
- branch line for `if`
- function, macro, method, or block name
- include/extends target when useful

Even when a full stack trace is not printed, the regular error message should
be able to include current-buffer execution info such as loop basics or the
current function/macro/method name. The root buffer may have no extra execution
info.

### Command Buffer Error Context Fields

Command-buffer error context metadata should be small, structured, and added
only when the compiler already knows the information from the AST or runtime
loop state. This metadata is consumed by `getErrorInfo(...)` for regular error
metadata and for each stack frame.

Command buffers should store one small error-context object that combines the
boundary source context and any extra execution fields. Keep it minimal:

```js
{ ec: __ec[12], loop }
```

Use this shape directly rather than spreading `__ec` into an object or adding
a helper. The `ec` field stays the source-origin tuple; other fields are
optional execution metadata owned by the buffer.

Useful optional fields:

- `name` - callable or named boundary identifier, such as macro/function/method
  name, block name, or component/import target name
- `target` - composition target identifier, such as `import x`, `component X`,
  or the target binding for a composition payload; if the target is dynamic,
  use an `@(line,col)` fallback such as `target@(1,2)`
- `source` - external source identifier, such as `include 'template.casc'`,
  `extends 'base.casc'`, or a script/module name; if the source is dynamic,
  use an `@(line,col)` fallback such as `include source@(1,2)`
- `loop` - small loop-info object, not an arbitrary runtime loop object. Use a
  stable shape such as `{ vars, index, length, first, last, value }`, where
  `vars` is an array of loop variable names and `value` is omitted or a bounded
  preview.
- `branch` - branch display string, such as `then`, `else`, `default`,
  `case 'active'`, or `case@(7,14)`

Do not stringify complex expressions for `branch`, `source`, or `target`.
Use static strings for compile-time-known branches and literal values, such as
`then`, `else`, `default`, or `case 'active'`. For dynamic or complex
expressions, use a compact source-position fallback such as `case@(7,14)` or
`include source@(1,2)`.

Likely AST sources:

- loops: `For.name`, `For.arr`, `For.concurrentLimit`, and runtime loop index
- while: `While.cond`
- if: `If.cond`, `If.body`, `If.else_`
- switch: `Switch.expr`, `Case.cond`, `Switch.default`
- composition: `Import.target`, `Component.target`, `FromImport.names`,
  `Include.template`, `Extends.template`
- callables: `Macro.name`, `Block.name`, `MethodDefinition.name`, inherited
  method/block metadata

Do not duplicate information already present in `ec`. For example, a `kind`
field is usually unnecessary because the label already says `If.Condition`,
`For.Iterator`, `Macro`, `Include`, etc.

Do not store large arbitrary values by default. For runtime values such as
current loop item or dynamic template value, store either a bounded preview or
nothing. Source position and stable identifiers are more important than dumping
large user data into diagnostics.

These optional fields should be documented next to the runtime buffer
implementation, but keep the documentation compact. The goal is to make field
meaning and type clear without introducing a large schema layer.

Not allowed:

- helpers using current-buffer context as the source origin of an operation
- commands omitting their originating context because the buffer has one
- lookup, wait, snapshot, or mutation paths falling back to parent/root buffer
  context as source-origin context

## Runtime APIs

Canonical APIs should accept compact error context entries:

```js
handleError(error, ec, currentBuffer)
createPoison(errors, ec, currentBuffer)
new RuntimeFatalError(error, ec, currentBuffer)
```

During migration, legacy overloads may remain:

```js
handleError(error, lineno, colno, errorContextString, path)
createPoison(errors, lineno, colno, errorContextString, path)
```

All runtime helper calls emitted by the compiler should pass compact prepared
entries from `__ec` plus `currentBuffer`. The compatibility layer should map
old `errorContextString` to `label` only while old call sites are being
migrated.

`createPoison(...)` remains plural-capable. The `errors` argument may be a
single error, a string, a `PoisonError`, or an array, matching current
normalization behavior.

Runtime helpers that need named fields should normalize internally:

```js
function normalizeErrorContext(ec) {
  return {
    lineno: ec[0],
    colno: ec[1],
    label: ec[2],
    path: ec[3],
    cb: ec[4]
  };
}
```

Keep this helper simple and hardcoded. Do not add generated constants or
compiled-code unpacking helpers.

`prepareErrorContexts(...)` is responsible for resolving label dictionary
references before runtime helpers see entries. `normalizeErrorContext(...)`
should see only prepared entries shaped as `[lineno, colno, label, path, cb]`.

`cb` is the callback for the current compiled callable/render invocation. It
receives one wrapped fatal error: `cb(error)`. Runtime code should call it only
for boundary-owned fatal failures that must be reported asynchronously. Value
consumption errors should be wrapped or poisoned, not reported directly through
`cb`. If no callback is present, fatal reporting paths throw the wrapped error.

Wrapped errors should store their originating compact error context. If
`handleError(...)`, `createPoison(...)`, or another helper receives both an
error that already has an error context and a helper argument `ec`, the error's
existing context wins. The helper argument is only the fallback origin for new
errors that do not already carry context.

This precedence preserves the original source of the error as it crosses later
consumption points. Later helpers may add command-buffer trace information, but
they must not replace the source-origin context already stored on the error.

Runtime helpers should receive both:

- `ec` - compact source-origin context for the operation
- `currentBuffer` - execution trace context for stack construction

The source-origin context answers "where did this operation come from?" The
command-buffer trace answers "inside what runtime execution path did it fail?"
They are separate mechanisms and should not substitute for each other.

This should be the default signature pattern for helpers called by compiled
code, even if the helper does not currently report errors. Passing both values
consistently avoids later ambiguity and keeps helper APIs ready for diagnostics.

## Passing Context To Runtime

If every compiler node has an `ErrorContext`, compiler output can pass that
context explicitly to each runtime helper it calls.

Target examples:

```js
runtime.memberLookupScript(target, key, __ec[5], currentBuffer)
runtime.callWrapAsync(fn, name, context, args, __ec[14], currentBuffer)
runtime.resolveAll(values, __ec[18], currentBuffer)
currentBuffer.addCommand(new runtime.DataCommand({ args, errorContext: __ec[21] }), chainName)
```

Runtime helpers should not infer source origin from ambient state. If a helper
is called by compiler-emitted code, it should receive the operation's compact
error context and the current command buffer as explicit arguments, or receive
the context inside the command/value object it receives.

## Error Flow

Keep the existing Cascada distinction:

- value-consumption failures become contextual poison for the affected writes
  or effects
- fatal control-flow/runtime failures are wrapped and reported through the
  owning boundary callback or thrown

`ErrorContext` should make this clearer, not blur it. Value-consumption paths
should create poison with the current compact context. Fatal boundary-owned
paths should wrap with the current compact context and then report through the
owning callback or throw according to the boundary contract.

When wrapping or poisoning an existing error, preserve any error context already
stored on that error. The current operation's `ec` is used only if the error has
no originating context yet.

## Error Info And Stack

Runtime should provide one error-formatting/context helper that returns error
information for an error plus fallback compact source context, with an option to
include the Cascada execution stack. Since `ErrorContext` is represented as a
compact array rather than an object instance, this should be a runtime helper,
not an instance method:

```js
runtime.getErrorInfo(error, ec, currentBuffer, false)
runtime.getErrorInfo(error, ec, currentBuffer, true)
```

The exact function name can change, but the behavior should be:

- if the error already stores an originating context, use that context instead
  of the helper argument `ec`
- otherwise normalize `ec` into `lineno`, `colno`, `path`, `label`, and `cb`
- include current-buffer execution info such as loop details, case/branch
  details, include target, or function/macro/method/block name in the regular
  error metadata when present
- when stack output is requested, walk `currentBuffer.parent` and `traceParent`
  links to build a Cascada stack
- format each stack element through the same error-info machinery so stack
  frames and regular error metadata describe buffers consistently
- never use the buffer stack to replace the source-origin context

This helper is where line/column/path/label and command-buffer execution info
come together for reporting.

## Migration Plan

Before implementation, audit:

- every `_createErrorContext(...)` and `_generateErrorContext(...)` call site
- inline compiler-emitted context literals
- command constructors and command application paths
- `RuntimePromise`, `RuntimeFatalError`, `createPoison`, and `handleError`
- `resolveErrorContextArgs(...)` and all legacy positional context overloads
- script symbol lookup and template symbol lookup differences
- precompiled fixture expectations
- browser precompile output

### Phase 1 - Runtime Foundation

1. Add runtime compatibility scaffolding:
   `prepareErrorContexts(context.path, cb, labels, specs)`,
   `normalizeErrorContext(ec)`, and temporary adapters for legacy positional and
   object contexts. This lets old generated code and new generated code coexist
   while call sites migrate. `prepareErrorContexts(...)` must return fresh
   prepared entries and must not mutate shared label/spec arrays.
2. Add canonical runtime error paths:
   `handleError(error, ec, currentBuffer)`,
   `createPoison(errors, ec, currentBuffer)`, and
   `RuntimeFatalError(error, ec, currentBuffer)`. Preserve plural
   `createPoison(...)` normalization.
3. Store originating compact error context on wrapped errors and enforce the
   precedence rule. For `PoisonError`, apply this per contained error, not to
   the `PoisonError` wrapper as a whole.
4. Add `getErrorInfo(error, ec, currentBuffer, includeStack)`. Initially it may
   format only source context; command-buffer fields and stack output can be
   filled in incrementally.
5. Add the dedicated `tests/pasync/error-context-tracing.js` file with focused
   tests for compact context preparation, wrapped-error precedence, and basic
   `handleError/createPoison/getErrorInfo` behavior.

### Phase 2 - Runtime Storage And Trace

1. Add the command-buffer error-context shape `{ ec: __ec[index], ...fields }`
   and store boundary contexts without optional fields first.
2. Add `traceParent` for clear-scope buffers. Audit at least macros/caller
   bodies, blocks, methods/constructors, includes, imports/from-imports,
   components, and extends/parent rendering paths.
3. Add optional command-buffer fields only where useful and cheap:
   `name`, `target`, `source`, `loop`, and `branch`. Keep complex expressions
   on `@(line,col)` fallbacks.
4. Expand `tests/pasync/error-context-tracing.js` for buffer context,
   `traceParent`, optional fields, and stack output.

### Phase 3 - Compiler Context Table

1. Add compiler-side context collection after transform/analysis has produced
   the final AST shape, plus the helper for retrieving context indices. This
   pass allocates artifact-wide context indices shared by root, blocks, macros,
   methods, and other compiled callables; builds the repeated-label dictionary;
   creates already-adjusted one-based line numbers; applies the Label
   Generation algorithm; and returns indices into the artifact-wide specs array.
2. Add semantic labels from analysis for important child expressions:
   `If.Condition`, `Switch.Expression`, `For.Iterator`, `For.Limit`,
   `While.Condition`, include/extends targets, and other high-value sites. This
   is an analysis-phase change, not just code generation: parent nodes should
   assign the parent-provided owner labels before context indices are collected.
   The compiler helper should work before this step by falling back to current
   `node`/`positionNode` labels; this step upgrades selected labels.
3. Emit artifact-wide label/spec arrays once per compiled script/template, and
   emit `const __ec = runtime.prepareErrorContexts(context.path, cb, labels,
   specs)` inside every compiled callable invocation that has its own
   `context`/`cb`. This includes root, macros/caller bodies, blocks, methods,
   constructors, and other callable render paths.

### Phase 4 - Compiler Call-Site Migration

1. Replace all compiler-emitted error-context patterns with `__ec[index]`
   references and pass `currentBuffer` through compiler-called runtime helpers.
   Commands store `errorContext` in their payload.
2. Source patterns to replace:
   generated JSON-stringified error-context objects, inline context object
   literals, and raw field-list calls such as
   `handleError(e, lineno, colno, errorContextString, path)`.
3. Coverage checklist:
   script symbol lookup, template lookup, composition, inheritance,
   macro/caller, loop, guard, output, return, and boundary codegen paths.
4. Move command constructors toward accepting `errorContext` instead of raw
   `pos` as the compiler call sites are migrated. During transition, commands
   that still expose `.pos` should derive it mechanically as
   `{ lineno: ec[0], colno: ec[1] }` from their stored `errorContext`; no call
   site should provide both independently.
5. Expand `tests/pasync/error-context-tracing.js` for command-stored context
   and migrated compiler output.

### Phase 5 - Cleanup And Fixtures

`RuntimePromise` producer-origin preservation is explicitly out of scope for
this refactor except where `RuntimePromise` consumes/reports errors. Do not
rely on `RuntimePromise` as a long-term context storage target; preserve
promise-origin context in a later refactor.

1. Replace `resolveErrorContextArgs(...)` with compact-context normalization
   and remove the current `path: ctx.path ?? ctx.errorContextString` fallback
   after all active call sites use compact contexts.
2. Remove `_createErrorContext(...)` and `_generateErrorContext(...)` after
   compiler output no longer calls them. Any remaining compile-time failures
   should use the new label-generation/index helper or direct `TemplateError`
   paths as appropriate.
3. Remove the `ChainCommand` static-path label special case; chain command
   labels become `ChainCommand`, with path/method details coming from command
   payload diagnostics when needed.
4. Update precompile/browser fixtures and finish
   `tests/pasync/error-context-tracing.js` coverage as generated output
   changes.
5. Remove `errorContextString`, expanded object contexts, and temporary legacy
   compatibility adapters once generated code, runtime APIs, tests, and
   precompile fixtures are updated.

## Tests

Add a dedicated test file for this refactor, for example:

```text
tests/pasync/error-context-tracing.js
```

This file should focus only on error context and trace behavior, not on broad
feature correctness. Cover:

- generated context labels for ordinary expressions and parent-labeled child
  expressions, such as `If.Condition(LookupVal)` and
  `Switch.Expression(FunCall)`
- preservation of an error's existing source context when consumed later by a
  helper with a different `ec`
- command-stored context for delayed command application/materialization errors
- command-buffer trace info for loops, branches, callables, and composition
- optional stack output from `getErrorInfo(error, ec, currentBuffer, true)`
- regular non-stack error output from `getErrorInfo(error, ec, currentBuffer, false)`
- compact `__ec` table shape and `runtime.prepareErrorContexts(...)` behavior

Prefer small scripts/templates that trigger one diagnostic behavior each.
Assertions should verify stable fields and meaningful substrings rather than
the full rendered message unless the exact format is part of the contract.

The success condition is simple: when an error reaches runtime formatting, it
already has the correct source-origin context. Runtime code should not need to
guess where the error came from.
