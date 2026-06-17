# ErrorContext Refactor

> Historical note: this is the first-stage migration plan. Some examples below
> intentionally use transitional names such as `RuntimeFatalError`, `cb`, and
> aggregate-style `new PoisonError(errors)`. For the current runtime taxonomy
> and compact-context rules, see `error-context-refactor-2.md` and
> `Error Handling Guide.md`.

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
- the context is created at the source errorContext and then passed unchanged
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
function root(env, context, runtime, cb) {
  const __ec = getErrorContexts(runtime, context.path, cb);
  // ...
  b_body(env, context, runtime, cb, parentBuffer, __ec);
}

function b_body(env, context, runtime, cb, parentBuffer, __ec) {
  runtime.memberLookupScript(target, key, __ec[5], currentBuffer);
}

function getErrorContexts(runtime, path, cb) {
  return runtime.prepareErrorContexts(path, cb, [
    'For.Iterator(Symbol)', 'For.Limit(FunCall)'
  ], [
    [1, 0, 'Root'], [3, 7, 'If.Condition(FunCall)'], [4, 12, 0]
  ]);
}
```

The label dictionary passed as the third argument contains labels used more
than once. The context specs passed as the fourth argument are collected once
per compiled script/template artifact, not once per function, macro, block, or
method. Analysis provides the semantic facts used by context creation; codegen
may assemble and register the final compact contexts from those facts.

Each compact context spec is either:

```js
[lineno, colno, labelIndex]
[lineno, colno, labelString]
```

The compiler can collect contexts internally as uncompressed
`[lineno, colno, labelString]` entries. During final output it counts label
usage, places repeated labels in the dictionary, rewrites those repeated labels
to numeric indexes, and leaves single-use labels inline. For example:

```js
return runtime.prepareErrorContexts(path, cb,
  ['For.Iterator(Symbol)'],
  [[7, 11, 0], [7, 15, 'If.Condition(LookupVal)']]
);
```

`getErrorContexts(runtime, path, cb)` should be emitted once per compiled
script/template artifact, preferably near the end of the generated source so
the large table is out of the way. It returns the per-invocation prepared table
named `__ec`, with render-time `path` and `cb` attached and label indexes
resolved. It must not mutate shared label/spec data. Cached precompiled
templates and concurrent renders must never share mutable prepared context
entries.

The root callable prepares `__ec` once for the render invocation. All sibling
compiled callables in the artifact, such as blocks, methods, constructors,
macros, and caller bodies, must receive that prepared table explicitly or close
over it. Do not create a file-scope mutable prepared `__ec`.

When inheritance or composition invokes a callable owned by another compiled
artifact, runtime should prepare that owner artifact's table through its emitted
`getErrorContexts(runtime, ownerPath, cb)` helper and pass the prepared table to
the owner callable. This keeps the source path tied to the artifact that owns
the node while preserving the current render callback for fatal reporting.

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

Prepared error contexts should stay compact until an error is actually being
created, wrapped, formatted, or reported. Do not normalize contexts during
ordinary command construction, helper setup, or pass-through storage. Commands
store `command.errorContext` directly and command diagnostics consume that
context at the error-reporting point.

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
- `Switch.Case(Literal)`
- `For.Iterator(LookupVal)`
- `For.Limit(FunCall)`
- `While.Condition(FunCall)`
- `Include.Template`
- `Include.Script`
- `Extends.Template`
- `Extends.Script`
- `Import.Template`
- `Import.Script`
- `FromImport.Template`
- `FromImport.Script`
- `Component.Script`
- `Block`
- `Super`
- `ChainCommand`

Avoid putting command-routing payload into labels. For example, prefer
`ChainCommand` over `ChainCommand(result.posts.push)`. The command payload can
record the data path or method name separately; the error context records the
source errorContext and position.

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
   `Switch.Expression`, `Switch.Case`, `For.Iterator`, or `For.Limit`.
2. Current position-node type - for example `LookupVal`, `FunCall`, or
   `Symbol`.

Exact rule:

```js
const owner = parentProvidedOwnerLabel || node.typename;
const posType = positionNode.typename;

if (!parentProvidedOwnerLabel && (node === positionNode || owner === posType)) {
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

Final `_generateErrorContext(node)` target:

- called only by analysis, except compile-time error decoration
- reads only `node._analysis.errorContextLabel` and
  `node._analysis.errorContextPositionNode`
- generates a stable source-operation label
- allocates the compact entry and stores `node._analysis.errorContextIndex`
- does not inspect command payloads, static chain paths, runtime routing, or
  helper-specific details

The final implementation should be close to:

```js
const positionNode = node._analysis.errorContextPositionNode || node;
const owner = node._analysis.errorContextLabel || node.typename;
const posType = positionNode.typename;
const label = positionNode === node && owner === posType
  ? owner
  : `${owner}(${posType})`;
```

Any remaining special cases, especially `ChainCommand` static-path label
generation, are legacy and should be removed when command diagnostics read
command payloads directly.

## Parent-Provided Child Labels

Important parent nodes may assign semantic labels to child expressions during
analysis. This is how `Switch.Expression(Symbol)` or `For.Iterator(FunCall)`
fits into the current compiler model.

Example target pattern:

```js
analyzeSwitch(node) {
  node.expr._analysis.errorContextLabel = 'Switch.Expression';
  return { wantsLinkedChildBuffer: true };
}
```

When compiling that child expression, context creation can combine the semantic
label with the actual child node type:

```js
const ecIndex = node.expr._analysis.errorContextIndex;
// __ec[ecIndex] label: "Switch.Expression(Symbol)"
```

The context is still created once for the origin. Parent analysis helps choose
the errorContext label before creation; it does not mutate an existing context later.

## Context Creation

Analysis should assign the semantic context facts for compiler nodes, such as
parent-provided labels. Immediately after each node's `analyzeXXX` hook, the
analysis pass should allocate the node's artifact-wide context index and store
it in `node._analysis.errorContextIndex`. Codegen should treat that index as
already available.

Per-node compiler context data should stay as plain info: source position,
optional `errorContextLabel`, optional `errorContextPositionNode`, and
`errorContextIndex`. The table helper owns conversion to compact runtime specs,
repeated-label compression, and table emission in one place. Do not add a
compiler-side `new ErrorContext(...)` layer unless the collector itself needs
private implementation objects.

Rules:

- the node controls `lineno` and `colno` unless `errorContextPositionNode`
  is set
- `errorContextLabel` is the optional parent-provided owner label
- `errorContextPositionNode` is the optional source-position node; when it is
  different from the owner node, the final label keeps the old
  `Owner(PositionType)` shape even if no `errorContextLabel` is set
- final label generation follows the algorithm in [Label Generation](#label-generation)
- path and callback are attached by
  `runtime.prepareErrorContexts(context.path, cb, labels, specs)` in the prepared
  per-invocation table
- the specs store already-adjusted, user-facing one-based line numbers; this
  replaces the current `_createLegacyErrorContext(...)` `positionNode.lineno + 1`
  adjustment
- the third spec element is either an inline label string or an index into the
  repeated-label dictionary
- emitted runtime calls refer to prepared contexts as `__ec[index]`; compiler
  codegen reads the index from `node._analysis.errorContextIndex`
- compiler emission helper names should distinguish the two generated shapes:
  `emitErrorContext(node)` emits the raw source-origin reference `__ec[index]`;
  `emitBufferStackContext(node, fields)` emits the buffer metadata object
  `{ ec: __ec[index], ...fields }`
- `_generateErrorContext(node)` is the analysis-time label/index helper. After
  migration, codegen should not call it for runtime error contexts; it should
  use the already-assigned index through `emitErrorContext(...)` or
  `emitBufferStackContext(...)`.
- compile-time error decoration, if needed, should use a small helper that
  consumes the same plain context info rather than an `ErrorContext` instance

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

Final target: every command that can report or propagate an error is created
with an `errorContext`. Compiler-emitted commands get the source operation's
compact `__ec[index]`; runtime-created/bootstrap commands should receive the
best available owning source or boundary context instead of relying on `null`.
Any command constructor default of `errorContext = null` is temporary migration
slack, not the long-term contract.

Do not pass `chainName` into command constructors just to support diagnostics.
The buffer or chain application path already knows the chain name when applying
the command. Duplicating it in the command constructor risks divergence.

The separation should be:

- `ErrorContext` - source errorContext and fatal escape behavior
- command payload - operation-specific data, such as method name or data path
- buffer/chain application - routing context, including the chain being applied

If a diagnostic needs both source errorContext and chain routing, combine
`command.errorContext` with the apply-time chain name at the reporting site.

Command diagnostics should provide command-specific details from the command
payload, not from the `ErrorContext` label. For chain commands this means:

- `command.errorContext` identifies the source location and stable operation
  label, such as `ChainCommand`
- `chainName`, `operation`, `path`, method name, and similar payload fields
  identify what the command attempted to apply
- the reporting site combines both, for example source errorContext plus
  `result.posts.push`

This replaces the legacy `ChainCommand` static-path label special case in
`_generateErrorContext(...)`. The source context should stay stable and
payload-independent; command-specific formatting belongs to command diagnostics.

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
this refactor. It would be useful to preserve promise errorContext eventually, but it
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
- when both `parent` and `traceParent` are present, diagnostic stack walking
  uses `traceParent`; `parent` remains the runtime hierarchy/visibility link

Clear-scope buffers are any execution boundary that intentionally does not use
the normal command-buffer parent for visibility or scope but still belongs in
the diagnostic stack. Audit and cover at least callable and composition
boundaries: macros/caller bodies, blocks, methods/constructors, includes,
imports/from-imports, components, and extends/parent rendering paths.

Callable and caller execution must always have a diagnostic trace parent.
Compiled calls should pass the current buffer into the callable invocation path
so macro/caller/method/block buffers can trace back to the call site. Direct
runtime calls that cannot provide a trace parent should be made unsupported or
should fail loudly after the migration, rather than silently creating
untraceable buffers.

`traceParent` is a reasonable name for that extra link because it describes the
purpose directly: it is not visibility, ownership, or command routing; it is
only for diagnostic trace construction.

Command buffers should be described as having only two persistent parent links:
`parent` and `traceParent`. The current `linkedParent` constructor argument is
not a parent relationship; it is only the chain registration target used while
creating linked chain lanes. Rename or reframe it as `linkTarget` in a later
cleanup.

buffer stacks may include extra execution information in addition to the
boundary context:

- loop variable/current item for loops
- case label or case line for `switch`
- branch line for `if`
- function, macro, method, or block boundary name
- include/extends target when useful

Even when a full stack trace is not printed, the regular error message should
be able to include current-buffer execution info such as loop basics or the
current function/macro/method boundary name. The root buffer may have no extra
execution info.

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

- `branchName` - compiler/runtime buffer-branch identifier, such as `root`,
  `caller`, or a generated block/method boundary. This is execution metadata,
  not a replacement for the compact `ec` label. User-visible callable names can
  be added in Phase 4 when the compiler has stable AST names at the call site.
- `loadName` - external or resolved thing being loaded/rendered, such as
  `template.casc`, `base.casc`, or a script/module name. If the loaded value is
  dynamic, use an `@(line,col)` fallback such as `include source@(1,2)`.
- `targetIdentifier` - local source identifier receiving or naming the loaded
  thing, such as an import alias, component binding name, or composition target.
  If the target is dynamic, use an `@(line,col)` fallback such as
  `target@(1,2)`.
- `loop` - the existing immutable runtime loop object for that iteration, as
  created by `runtime.createLoopBindings(...)`. Do not create a separate
  diagnostic loop summary and do not add extra fields such as loop variable
  names.
- `branch` - branch display string, such as `then`, `else`, `default`,
  `case 'active'`, or `case@(7,14)`

Do not stringify complex expressions for `branch`, `loadName`, or
`targetIdentifier`.
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

- helpers using current-buffer context as the source errorContext of an operation
- commands omitting their originating context because the buffer has one
- lookup, wait, snapshot, or mutation paths falling back to parent/root buffer
  context as source-origin context

## Runtime APIs

Canonical APIs should accept compact error context entries:

```js
contextualizeError(error, ec)
createPoison(errors, ec)
new RuntimeFatalError(error, ec)
handleFatal(error, ec)
getErrorInfo(error, ec, currentBuffer, includeStack)
```

The frozen synchronous Nunjucks-compatible compiler path keeps a separate
positional adapter:

```js
createSyncRuntimeError(error, lineno, colno, errorContextString, path)
```

All runtime helper calls emitted by the compiler should pass compact prepared
entries from `__ec`. Command-buffer stack enrichment is a separate
`getErrorInfo(...)` concern and should not be a side effect of wrapping.

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

The target error families are:

- `PoisonError` - value-consumption/dataflow failures that poison affected
  outputs or effects. Contained errors carry source-origin context.
- `RuntimeError` - all non-poison runtime failures. These are fatal to the
  current runtime execution path.
- `TemplateError`/compile errors - parse, compile, validation, and frozen sync
  template compatibility failures.

`RuntimeFatalError` is a transitional runtime subtype. Phase 6 should evaluate
whether it still adds value now that non-poison runtime errors are fatal by
default.

`handleFatal(error, ec)` owns fatal delivery. It wraps through
`contextualizeError(...)`, reads the effective context's `reportError`, reports
to `reportError` when present, and then throws/rethrows the wrapped error.
Boundary code should prefer this helper over open-coding fatal reporting.

Wrapped errors should store their originating compact error context. If
`contextualizeError(...)`, `createPoison(...)`, or another helper receives both an
error that already has an error context and a helper argument `ec`, the error's
existing context wins. The helper argument is only the fallback errorContext for new
errors that do not already carry context.

Prefer passing `errorContext` directly into error constructors and wrapping
helpers. Any remaining late attachment bridge should stay narrow and private:
use it only when an error is already wrapped and should be annotated
idempotently instead of replaced by a new `RuntimeError`. Do not let runtime
helpers call such mutators casually after the fact.

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

Runtime helpers should not infer source errorContext from ambient state. If a helper
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

- every `_createLegacyErrorContext(...)` legacy object-context call site
- every `_generateErrorContext(...)` legacy string-label call site
- inline compiler-emitted context literals
- command constructors and command application paths
- `RuntimePromise`, `RuntimeFatalError`, `createPoison`, and `createSyncRuntimeError`
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
   `contextualizeError(error, ec)`,
   `createPoison(errors, ec)`, and
   `RuntimeFatalError(error, ec)`. Add
   `handleFatal(error, ec)` for callback-or-throw fatal
   reporting. Preserve plural `createPoison(...)` normalization.
3. Store originating compact error context on wrapped errors and enforce the
   precedence rule. For `PoisonError`, apply this per contained error, not to
   the `PoisonError` wrapper as a whole.
4. Add `getErrorInfo(error, ec, currentBuffer, includeStack)`. Initially it may
   format only source context; command-buffer fields and stack output can be
   filled in incrementally.
5. Add the dedicated `tests/pasync/error-context.js` file with focused
   tests for compact context preparation, wrapped-error precedence, and basic
   `contextualizeError/createPoison/handleFatal/getErrorInfo` behavior.

### Phase 2 - Runtime Storage And Trace

1. Add the command-buffer error-context shape `{ ec: __ec[index], ...fields }`
   and store boundary contexts without optional fields first.
   Until Phase 3 emits prepared `__ec[index]` entries, compiler-created
   buffers may use the temporary bridge `{ ec: legacyObjectContext }`. Mark
   that bridge with `TODO(error-context-cleanup)` wherever the legacy context is
   generated.
2. Add `traceParent` for clear-scope buffers. Audit at least macros/caller
   bodies, blocks, methods/constructors, includes, imports/from-imports,
   components, and extends/parent rendering paths. Stack walking should prefer
   `traceParent` over `parent` when both are present.
3. Add runtime support for optional command-buffer fields and emit the cheap
   compiler fields available during this phase, especially `branchName` and
   `loop`.
   Later compiler call-site migration should fill in additional `loadName`,
   `targetIdentifier`, and `branch` fields where the compiler already has
   stable AST information. Keep complex expressions on `@(line,col)` fallbacks.
4. Expand `tests/pasync/error-context.js` for buffer context,
   `traceParent`, optional fields, and stack output.

### Phase 3 - Compiler Context Table

1. Add the artifact-wide compiler context table plus the helper for retrieving
   context indices. Codegen may register contexts from `compileXXX` methods,
   provided the final context is assembled from analysis-owned properties. The
   table allocates context indices shared by root, blocks, macros, methods, and
   other compiled callables; builds the repeated-label dictionary; creates
   already-adjusted one-based line numbers; applies the Label Generation
   algorithm; and returns indices into the artifact-wide specs array. Keep
   per-node compiler contexts as plain info, not individual `ErrorContext`
   instances.
2. Add semantic labels from analysis for important child expressions:
   `If.Condition`, `Switch.Expression`, `Switch.Case`, `For.Iterator`, `For.Limit`,
   `While.Condition`, include/extends targets, and other high-value sites. This
   is an analysis-phase change, not just code generation: parent nodes should
   assign the parent-provided owner labels before context indices are registered.
   The compiler helper should work before this step by falling back to current
   `node`/`positionNode` labels; this step upgrades selected labels.
3. Emit one artifact helper, `getErrorContexts(runtime, path, cb)`, preferably
   near the end of the generated file. This helper owns the final compressed
   label/spec arrays and calls `runtime.prepareErrorContexts(...)`.
4. Emit `const __ec = getErrorContexts(runtime, context.path, cb)` once inside
   `root(...)`. Thread that prepared table into sibling compiled callables that
   need it, including blocks, methods, constructors, macros, and caller bodies.
   Do not use a file-scope mutable prepared `__ec`; it would race across
   concurrent renders.
5. Export `getErrorContexts` from inheritance/composition participants and let
   runtime prepare owner-artifact tables lazily when invoking methods, blocks,
   constructors, or other loaded callables from another compiled artifact.

### Phase 4 - Compiler Call-Site Migration

1. Replace all compiler-emitted error-context patterns with `__ec[index]`
   references and pass `currentBuffer` through compiler-called runtime helpers.
   Commands store `errorContext` in their payload.
2. Source patterns to replace:
   generated JSON-stringified error-context objects, inline context object
   literals, and raw field-list calls such as
   `createSyncRuntimeError(e, lineno, colno, errorContextString, path)`.
3. Coverage checklist:
   script symbol lookup, template lookup, composition, inheritance,
   macro/caller, loop, guard, output, return, and boundary codegen paths.
   Include legacy inheritance catch paths that still call
   `createSyncRuntimeError(e, lineno, colno, errorContextString, path)`.
   Pass `traceParent` to emitted `runRenderBoundary(...)` calls where the
   render boundary has a diagnostic caller buffer. Ensure macro, caller,
   method, block, and other callable
   invocation paths require a current buffer/trace parent rather than
   supporting untraceable calls.
   Verify `Script` and precompiled script/template instances expose
   `getErrorContexts` through the same runtime surface while updating
   precompile/browser fixtures.
4. Move command constructors toward accepting `errorContext` instead of raw
   `pos` as the compiler call sites are migrated. Commands should store
   `errorContext` and avoid deriving `.pos` during construction. Command
   argument resolution, command application, finished-buffer observations, and
   chain-level error handling should report through `command.errorContext`.
   The first Phase 4 pass updates the shared `ChainCommand` base plus data,
   text, var, sequence, wait, observation, error, return, guard, and chain
   bootstrap command paths. During migration, some command constructors may
   still default `errorContext = null`; this default is temporary and should be
   removed after all runtime-created/bootstrap commands receive an owning
   context.
5. Use `emitErrorContext(node)` for raw `__ec[index]` references and
   `emitBufferStackContext(node, fields)` only for command-buffer stack
   metadata objects shaped as `{ ec: __ec[index], ...fields }`.
6. Expand `tests/pasync/error-context.js` for command-stored context
   and migrated compiler output.

Phase 4 may leave legacy contexts in compile-time metadata. Synchronous
compiler paths are frozen at the Nunjucks compatibility layer and are not part
of this async error-context refactor. The important boundary is that async
compiler-emitted runtime helper calls should no longer need generated
`{ lineno, colno, errorContextString, path }` objects or positional
`createSyncRuntimeError(...)` calls.
Optional command-buffer display fields such as `loadName`, `targetIdentifier`,
and `branch` may also be filled in after this migration; they need
AST-specific display choices rather than broad mechanical rewrites.

### Phase 5 - Cleanup And Fixtures

`RuntimePromise` producer-origin preservation is explicitly out of scope for
this refactor except where `RuntimePromise` consumes/reports errors. Do not
rely on `RuntimePromise` as a long-term context storage target; preserve
promise-origin context in a later refactor.

Code constructs marked with `TODO(error-context-cleanup)` are temporary
compatibility or legacy bridges introduced during this migration. Phase 5 owns
the structural cleanup from the migration. Remaining async/runtime cleanup items
are tracked in Phase 6. Synchronous compiler paths are frozen at the Nunjucks
compatibility layer and must not be rewritten as part of this refactor.

Deletion checklist for `TODO(error-context-cleanup)`:

- legacy object-context support inside `normalizeErrorContext(...)`
- `compactErrorContext(...)` as an object/positional compatibility converter
- fallback conversion inside `resolveEffectiveErrorContext(...)`; the stable
  helper should choose between `error.errorContext` and an already-compact
  fallback
- positional `RuntimeError(...)`, `RuntimeFatalError(...)`,
  `createPoison(...)`, and `contextualizeError(...)` context overloads for async
  compiler/runtime call sites
- `errorContextString` storage and message plumbing after `label` is the only
  field used by async diagnostics and tests
- compile-time inheritance metadata should store context indexes, not legacy
  `ErrorContext` objects. Runtime load/finalization resolves those indexes
  through the owner artifact's prepared context table. Any remaining legacy
  object fallback in inheritance tests or hand-built metadata is temporary
  test scaffolding, not generated output.
- command constructor `errorContext = null` defaults and any runtime-created
  commands that still lack an owning context
- optional command-buffer display fields such as `loadName`,
  `targetIdentifier`, and `branch` that were deferred from the mechanical
  Phase 4 call-site migration
- the `linkedParent` constructor naming/concept; it should become a chain
  `linkTarget`, not a third parent relationship
- the long positional `managedBlock(...)` signature after the temporary
  error-context and trace-parent parameters are no longer changing
- `resolveErrorContextArgs(...)`, `normalizeErrorsWithContext(...)` context
  handling, and all old positional/object adapter paths
- `compactErrorContext(...)` `lineno ?? 0` / `colno ?? 0` defaults if compact
  contexts no longer need `0` as an absent-position sentinel
- in-place `PoisonError.errors` mutation inside `contextualizeError(...)`

1. Replace `resolveErrorContextArgs(...)` with compact-context normalization
   and remove the current `path: ctx.path ?? ctx.errorContextString` fallback
   after all active call sites use compact contexts.
2. Remove `_createLegacyErrorContext(...)` after compiler output no longer
   emits object contexts. This is complete for async inheritance metadata:
   generated method entries, shared schema entries, super origins, and inherited
   method dependencies store context indexes and are resolved by runtime through
   owner prepared tables. Keep `_generateErrorContext(...)` as the
   analysis-time compiler label/index helper, but remove its legacy-only
   runtime codegen string-label call sites after they are migrated to compact
   `__ec[index]` contexts. Any remaining compile-time failures should use
   `_generateErrorContext(...)` or direct `TemplateError` paths as appropriate.
3. Remove the `ChainCommand` static-path label special case; chain command
   labels become `ChainCommand`, with path/method details coming from command
   payload diagnostics when needed.
4. Update precompile/browser fixtures and finish
   `tests/pasync/error-context.js` coverage as generated output
   changes.
5. Review `tests/pasync/error-context.js` and replace internal unit-style
   scaffolding tests with integration tests wherever compiled scripts/templates
   can now exercise the same behavior. Delete unit tests that only existed to
   cover incomplete migration internals and no longer prove a live contract.
6. Remove `errorContextString`, expanded object contexts, and temporary legacy
   compatibility adapters once generated code, runtime APIs, tests, and
   precompile fixtures are updated.
   The legacy `ErrorContext` runtime wrapper, the inheritance
   `createBufferStackContext(...)` bridge file, and command-buffer context-shape
   normalizer have been removed. Remaining expanded object contexts are
   hand-built test scaffolding or frozen sync-path data.
7. Re-check the late already-wrapped-error attachment bridge after all wrappers
   accept compact contexts directly. It should remain private to
   `contextualizeError(...)` or be removed if no longer needed.
8. Review all helpers, methods, and small bridge functions added during this
   refactor for final ownership. Move them to the file/class that owns the
   concept, inline one-off helpers where clearer, and remove migration-only
   helpers instead of leaving them in incidental locations.
9. Keep identifier names explicit for error-context values. Parameters and
   fields that carry an `ErrorContext` should be named `errorContext`, `ec`, or
   another explicit context name. Historical `origin` names must not be used
   where the value is an originating error context.

### Phase 6 - Final Runtime Cleanup

Phase 6 has grown into a focused follow-up refactor. Track it in
[`error-context-refactor-2.md`](error-context-refactor-2.md). It
covers async adapter removal, command context strictness, inheritance test and
metadata cleanup, runtime error taxonomy, fatal delivery, helper ownership,
buffer API cleanup, and final fixture updates.

The synchronous Nunjucks-compatible compiler path remains frozen. Any
synchronous positional `createSyncRuntimeError(...)` calls that remain are intentionally
out of scope unless a separate sync-compiler project is opened.

## Tests

Add a dedicated test file for this refactor, for example:

```text
tests/pasync/error-context.js
```

This file should focus only on error context and trace behavior, not on broad
feature correctness. Prefer integration tests that render compiled
scripts/templates and observe the resulting diagnostics. Unit tests are
acceptable during early phases when the compiler cannot yet emit the target
shape, but they should be treated as temporary scaffolding unless they cover a
stable public runtime contract. During final cleanup, rewrite unit tests as
integration tests where possible and remove unit tests that only exercised
transitional internals.

Cover:

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
