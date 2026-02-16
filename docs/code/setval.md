# `setval` Implementation Notes (Current)

This document describes the implemented behavior of `setval` in the current codebase.

## What `setval` Is

`setval` is the assignment tag used for **value outputs** in script mode.

- Value declarations use `value ...`
- Subsequent assignments to that declared value output use `setval ...`
- Runtime writes are emitted as `ValueCommand` entries into the active `CommandBuffer`

## End-to-End Flow

1. Script transpiler identifies declared outputs in scope.
2. For a declared `value` output, assignment forms (`x = ...`) are rewritten to `setval x = ...` (or block/call equivalents).
3. Parser builds a `nodes.Set`/`nodes.CallAssign` shape and marks value-declaration forms with `isSetvalDeclaration`.
4. Compiler routes these nodes to `compileSetval`.
5. `compileSetval` validates declaration/assignment rules and emits `ValueCommand` writes.

## Transpiler Behavior (`src/script/script-transpiler.js`)

Current script mappings:

- `value x = 1` -> `{%- value x = 1 -%}`
- `x = 2` (where `x` is declared as value output) -> `{%- setval x = 2 -%}`
- `value x = capture ... endcapture` -> `{%- value x capture -%}...{%- endvalue -%}`
- `x = capture ... endcapture` (value output) -> `{%- setval x capture -%}...{%- endsetval -%}`
- `value x = call ... endcall` -> `{%- call_assign value x = ... -%}...{%- endcall_assign -%}`
- `x = call ... endcall` (value output) -> `{%- call_assign setval x = ... -%}...{%- endcall_assign -%}`

Important: declarations remain `value`, not `setval`.

## Parser Behavior (`src/parser.js`)

### `value` tag (script mode)

`parseValue()` supports:

- declaration only: `{% value x %}` (`node.declarationOnly = true`)
- declaration with initializer: `{% value x = expr %}`
- declaration capture block: `{% value x capture %}...{% endvalue %}`

It marks these with `node.isSetvalDeclaration = true`.

### `setval` tag

`parseSet('setval', 'setval', 'endsetval')` supports:

- assignment: `{% setval x = expr %}`
- capture assignment block: `{% setval x capture %}...{% endsetval %}`

Parser also accepts bare `{% setval x %}` syntactically, but current compiler rejects it (see mismatch below).

### `call_assign`

`parseCallAssign()` supports:

- `call_assign value x = ...` (declaration form; marked as `isSetvalDeclaration`)
- `call_assign setval x = ...` (assignment form)
- plus legacy var/set forms

## Compiler Behavior (`src/compiler/compiler.js`)

### Routing

`compileSet()` routes to `compileSetval()` when any of these are true in script mode:

- `node.varType === 'setval'`
- `node.isSetvalDeclaration === true`
- assignment targets are all declared value outputs

`compileCallAssign()` reuses this by constructing a `Set` node and forwarding `isSetvalDeclaration`.

### `compileSetval()` rules

- only valid in `scriptMode` + `asyncMode`
- declaration path (`isSetvalDeclaration`):
  - declares a `value` output via `runtime.declareOutput(frame, name, "value", ...)`
  - registers output declaration metadata (`_addDeclaredOutput`)
- assignment path:
  - requires target to already be a declared `value` output
  - otherwise errors with:
    - `Cannot assign to undeclared value output 'x'. Use 'value x' to declare it first.`
- read-only call scopes (`frame.isolateWrites`) block outer-scope assignment, same as vars
- `set_path` writes for value outputs use:
  - `runtime.getOutput(frame, name).getCurrentResult()`
- non-declaration assignment requires one of:
  - `node.value`, `node.body`, or `node.path`
  - otherwise errors with `set value assignment requires a value or capture body.`

### Emitted runtime writes

Assignments emit `new runtime.ValueCommand(...)` through async buffered output writes.

If assigned at top level and name does not start with `_`, compiler emits `context.addExport(name, value)`.

## Expression Read Semantics

When a declared value output symbol is read in expressions, `compileSymbol()` emits a point-in-stream snapshot:

- `x` behaves like `x.snapshot()` in script expressions
- implementation uses `currentBuffer.addSnapshot("x", pos)`

This is how value outputs participate naturally in arithmetic/logic expressions.

## Runtime Default Value

`ValueOutput` defaults to `null` when declared without assignment. This aligns declaration-only `value x` with `none`-like semantics.

## Guard Note

Value outputs are outputs, not script variables. Guard **variable selectors** validate against declared vars (`_isDeclared`), not outputs. Output behavior in guards is handled via output handler tracking/snapshots.

## Current Known Mismatch

Parser accepts bare `{% setval x %}` but compiler currently rejects it unless the node is a declaration form (`value x`). In practice, declaration-only should use `{% value x %}`.
