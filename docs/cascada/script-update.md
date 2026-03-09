# Cascada Script Doc Update Plan (`script.md`)

This document summarizes what is outdated in [script.md](/c:/Projects/cascada/docs/cascada/script.md) and what the docs should reflect based on current implementation and tests.

## Source of truth used

- Parser/compiler/runtime:
  - [parser.js](/c:/Projects/cascada/src/parser.js)
  - [script-transpiler.js](/c:/Projects/cascada/src/script/script-transpiler.js)
  - [compiler.js](/c:/Projects/cascada/src/compiler/compiler.js)
  - [compiler-base.js](/c:/Projects/cascada/src/compiler/compiler-base.js)
  - [output.js](/c:/Projects/cascada/src/runtime/output.js)
  - [validation.js](/c:/Projects/cascada/src/compiler/validation.js)
  - [default-data-methods.js](/c:/Projects/cascada/src/script/default-data-methods.js)
- Behavior/tests:
  - [explicit-outputs.js](/c:/Projects/cascada/tests/explicit-outputs.js)
  - [script-transpiler.js](/c:/Projects/cascada/tests/script-transpiler.js)
- Background docs (checked, but treated as secondary):
  - [next.md](/c:/Projects/cascada/docs/cascada/next.md)
  - [sequence.md](/c:/Projects/cascada/docs/code/sequence.md)

## Terminology policy for the rewrite

- Prefer `types` / `typed variables` / `typed declarations`.
- Avoid leading with `output` / `output handlers` terminology in user-facing docs.
- Acceptable type names:
  - `data`
  - `text`
  - `var` (single value type)
  - `sink`
  - `sequence`

## Documentation policy (strict current-version only)

- `script.md` must describe only the current language behavior.
- Do not include historical versioning in the main reference flow:
  - no "old syntax" walkthroughs,
  - no deprecation timelines,
  - no migration narrative.
- If a removed form must be mentioned, keep it as a short validity rule only
  - example: "`capture` is not supported".

## Current language model (what `script.md` should describe)

1. Script state is built with explicit typed declarations, not legacy `@...` commands.
- Declarations:
  - `data name`
  - `text name`
  - `var name` (single value type)
  - `sink name = initializer`
  - `sequence name = initializer`
- Scope:
  - typed declarations are validated for async script mode (not template mode and not sync-only script flow).

2. Legacy syntax is removed/rejected in scripts.
- `@data`, `@text`, `@value` are rejected by transpiler.
- Focus directives (`:data`, `:text`, `:value`, custom focus) are not supported.
- `capture...endcapture` is not supported.
- Explicit `value x = ...` declarations are not supported.
- `extern` declarations are not part of the current script surface.

3. Type operations are done through declared typed variables.
- `data`:
  - assignment/path assignment: `out.user.name = "A"`
  - methods: `out.items.push(v)`, `out.merge(...)`, etc.
- `text`:
  - callable append: `out("hello")`
  - assignment overwrite: `out = "hello"` (replaces current text value)
- `var` (value output):
  - assignment set: `v = 42`
  - callable assignment is not supported.
  - bare symbol reads are allowed and behave like snapshot reads in expressions.
- `sink`/`sequence`:
  - method calls on initialized object.
  - `sequence` supports read access, call return values, and `snapshot()`.
  - `sequence` property assignment is rejected.

4. Snapshots and returns are explicit.
- `return` exists and can return arbitrary values.
- Snapshot API: `name.snapshot()`.
- Non-`var` outputs cannot be used as bare symbols; docs should instruct `snapshot()`.

5. Guard/recovery semantics for typed declarations.
- `guard`, optional `recover`.
- Selectors include declaration names/types, `var`, `*`, and sequence-path selectors.
- `revert` is currently not available in script transpilation unless implemented there first.
- `sink snapshot()` is currently forbidden inside guard blocks.
- `@handler._revert()` documentation is stale and should be removed from script docs.

6. Macro/call behavior changed from focus-based model.
- No focus directives in macro/call syntax.
- Standard macro invocation remains regular function-call style:
  - `var result = myMacro(args)`.
- Script transpiler rejects bare `call ... endcall` blocks; call-block usage is assignment form:
  - `var x = call ... endcall` or `x = call ... endcall`.
- Macro/caller return patterns should be documented via typed declarations + `return`.

## High-priority corrections needed in `script.md`

## 1) Remove legacy `@` language as primary API

Problem:
- Major sections describe `@data/@text/@value` as user syntax.

Action:
- Rewrite to explicit types (`data/text/var/sink/sequence`) and typed-variable operations.
- Keep `@...` only as internal implementation detail if needed (prefer not in user docs).

Affected sections (non-exhaustive):
- `## Building Outputs Declaratively with @`
- `### Output Handlers: @data, @text, @value...`
- `### Built-in Output Handlers`
- `### Customizing the @data Handler` (rename and reframe around `data` outputs)

## 2) Delete focus-directive content

Problem:
- `:data/:text/:value` appears throughout examples and semantics.

Action:
- Remove focus sections and all focused examples.
- Replace with explicit `return ...` and `.snapshot()`.

Affected sections:
- `### Focusing the Output (:data, :text, :handlerName)`
- Macro and call sections with `:data/:value` signatures.

## 3) Remove capture-based guidance

Problem:
- Doc still contains capture-era conceptual framing in many places.

Action:
- Keep only: "capture is not supported in scripts".
- Replace old capture workflows with output declaration + snapshot + return examples.

## 4) Rework macro and call-block sections

Problem:
- Current text describes focus-based macro returns and bare `call` block usage.

Action:
- Document current pattern:
  - Call macros normally with function syntax when no caller block is needed.
  - Declare typed variables inside macro/call body when building structured return values.
  - Return snapshots/objects explicitly.
  - Use assignment-form call blocks only for caller-block scenarios.

## 5) Rework guard/revert section

Problem:
- `_revert()` APIs are documented as script-level tools.

Action:
- Promote selector-based `guard`.
- Remove script-facing `_revert()` usage examples.
- Keep current restriction: sink snapshots inside guard are invalid.
- Explain selector grammar as it exists now:
  - `guard *`
  - `guard var`
  - `guard data`, `guard text`, `guard sink`, `guard sequence`
  - `guard someName, otherName`
  - `guard lock!` and `guard !`
  - `*` cannot be combined with other selectors.
- Explain behavior explicitly:
  - `recover` runs when guard finalization detects errors.
  - `recover err` binds the aggregated guard error payload for inspection in the recovery block.
- Explain why sink snapshot is blocked in guard:
  - guard is transactional (capture/restore on failure),
  - exposing sink snapshots mid-transaction can leak temporary state that may be rolled back,
  - compiler therefore rejects `sink.snapshot()` in guard blocks to preserve deterministic rollback semantics.

Decision gate for `revert` in rewritten `script.md`:
- If `revert` is implemented in script transpiler before docs rewrite, document it as language syntax.
- If not implemented, do not document it as available script syntax. Mention only as unsupported.

## 6) Update API examples

Problem:
- Quick start/API examples still use legacy output-option/focus-style scripts.

Action:
- Show scripts that explicitly declare outputs and use `return`.
- Avoid implying `renderScriptString(..., { output: 'data' })` is the modern pattern.
- Add mandatory examples for `sink` and `sequence` in early sections.

## 7) Update data operations section from runtime method list

Problem:
- Existing method documentation is framed as `@data.path.method(...)` and misses current type framing.

Action:
- Reframe as `data` typed-variable methods (`myData.path.method(...)`).
- Source methods from [default-data-methods.js](/c:/Projects/cascada/src/script/default-data-methods.js):
  - `set`, `push`, `merge`, `deepMerge`, `pop`, `shift`, `unshift`, `reverse`, `concat`
  - `text`, `append`
  - `add`, `subtract`, `increment`, `decrement`, `multiply`, `divide`, `min`, `max`
  - `and`, `or`, `bitAnd`, `bitOr`, `bitNot`, `not`
  - `toUpperCase`, `toLowerCase`, `slice`, `substring`, `trim`, `trimStart`, `trimEnd`,
    `replace`, `replaceAll`, `split`, `charAt`, `repeat`
  - `at`, `sort`, `sortWith`, `arraySlice`, `delete`

## 8) Document current return limitations honestly

Observed in tests:
- Some return scenarios are still skipped (`it.skip`) in explicit-outputs suite (for example some early-return/control-flow combinations).
- `recover err` usage appears in skipped tests and should be documented as implemented-with-limited-test-coverage.

Action:
- Avoid over-claiming full early-return coverage.
- Add a short "current limitations" subsection until skipped scenarios are enabled.

## 9) Normalize examples to regular return composition

Problem:
- Many newer tests were adapted from old semantics and often return boilerplate like:
  - `return { data: outData.snapshot(), text: outText.snapshot() }`
- This can mislead users into thinking scripts should always return `{data, text}`.

Action:
- In docs, default to regular-language style examples:
  - compute values
  - compose normal objects/arrays/scalars
  - return exactly what the example needs
- Use `data/text` pair returns only when the point of the example is multi-type composition.

## 10) Add required sink and sequence examples

Problem:
- `sink` and `sequence` are currently under-documented compared to `data`/`text`.

Action:
- Add at least one `sink` example that shows:
  - declaration with initializer,
  - command calls,
  - snapshot/final value retrieval.
- Add at least one `sequence` example that shows:
  - declaration with initializer,
  - read + call return values,
  - that property assignment is invalid.
- Add one guard + sequence transaction example showing `begin/commit/rollback` intent.

## 11) Expand sink semantics in this plan (authoring spec for new `script.md`)

The rewritten `script.md` should include a dedicated sink section with these concrete points:

- Declaration:
  - `sink name = initializer` (initializer required).
- Use:
  - call methods on the sink object: `name.method(...)`, including subpaths.
- Snapshot behavior:
  - snapshot capability is sink-object dependent.
  - runtime resolution chain is:
    1. `snapshot()`
    2. `getReturnValue()`
    3. `finalize()`
    4. sink object itself
- Guard rule:
  - `sink.snapshot()` is invalid inside `guard`.
  - rationale: guard is transactional; exposing sink state mid-transaction can leak state that may be rolled back.
- Error behavior:
  - sink command failures are surfaced on observation paths (for example snapshot/final-value retrieval), not as immediate fatal errors for unobserved sink writes.
  - snapshot errors/rejections propagate when snapshot/final-value retrieval is performed.

Required sink examples to include in rewritten `script.md`:

```cascada
sink logger = makeLogger()
logger.write("start")
logger.write("done")
return logger.snapshot()
```

```cascada
sink collector = makeCollector()
collector.events.push("a")
collector.events.push("b")
return collector.snapshot()
```

```cascada
sink logger = makeLogger()
guard logger
  logger.write("x")
  var s = logger.snapshot()  // invalid in guard
endguard
```

## 12) Expand sequence semantics in this plan (authoring spec for new `script.md`)

The rewritten `script.md` should include a dedicated sequence section with these concrete points:

- Declaration:
  - `sequence name = initializer` (initializer required).
- Supported operations:
  - value-returning method calls:
    - `var x = seq.method(args)`
  - value-returning property reads:
    - `var s = seq.status`
  - nested subpath calls/reads:
    - `var id = seq.api.client.getId()`
  - `snapshot()`:
    - `var snap = seq.snapshot()`
    - sequence snapshot uses the same fallback chain documented for sink snapshots.
- Unsupported operation:
  - property assignment is invalid:
    - `seq.status = "x"` (compile error)
- Guard transaction integration:
  - if sequence object provides hooks, guard uses:
    - `begin()`
    - `commit(token?)`
    - `rollback(token?)`
  - missing hooks are tolerated.
  - hook errors become guard errors.
  - nested transactions unwind in LIFO order.

Required sequence examples to include in rewritten `script.md`:

```cascada
sequence db = makeDb()
var user = db.getUser(1)
var state = db.connectionState
return { user: user, state: state }
```

```cascada
sequence db = makeDb()
var id = db.api.client.getId()
return id
```

```cascada
sequence db = makeDb()
db.connectionState = "offline"  // invalid
```

```cascada
sequence tx = makeTransactionalSink()
guard tx
  var a = tx.step("A")
  var b = tx.step("B")
endguard
return { a: a, b: b }
```

## 13) Guard selector reference to embed in rewritten `script.md`

Use an explicit selector table in the new docs:

- `guard` (no selectors)
  - global guard behavior (equivalent to guarding all relevant state touched by the block).
- `guard *`
  - all relevant guarded state.
- `guard var`
  - all `var` declarations written in guard.
- `guard data`, `guard text`, `guard sink`, `guard sequence`
  - all declarations of that type touched in guard.
- `guard myData, logger`
  - specific declaration names.
- `guard lock!`
  - specific sequential-operation lock path from `!` syntax.
- `guard !`
  - all modified sequential-operation locks.

Rules:
- `*` cannot be combined with other selectors.
- duplicate selectors are invalid.
- selectors do not use `@name` syntax.
- lock selectors (`lock!`, `!`) are for sequential-operation locks, not `sequence` typed declarations.

## 14) Critical implementation notes for doc author (no-source environment)

These points must be treated as authoritative while rewriting `script.md`:

- `var` is the single-value type and also the variable declaration form in script syntax.
- `var` writes use assignment syntax (`v = expr`); callable `v(expr)` is not supported.
- `text` supports append and overwrite:
  - `t(expr)` appends.
  - `t = expr` overwrites.
- Bare call blocks are rejected in script transpilation.
  - Use assignment form only:
    - `var x = call ... endcall`
    - `x = call ... endcall`
- `sink.snapshot()` inside `guard` is a compile-time error.
- `sequence` supports reads and calls, but not property assignment.
- Do not imply any focus-directive behavior (`:data`, `:text`, `:value`).
- Do not imply any `@...` command syntax for scripts.
- `revert` must be documented only if script transpilation supports it at rewrite time.

## Structural replacement proposal for `script.md`

Use this structure for the rewrite:

1. Quick Start (typed declarations + return)
2. Core syntax (`var`, assignment, expressions, loops, conditionals)
3. Typed declarations (`data/text/var/sink/sequence`, async script mode scope)
4. Type operations
5. Snapshot semantics
6. Return semantics
7. Guard/recover (and `revert` only if implemented) with current selector table
8. Macros and call blocks (assignment-form call blocks in scripts)
9. Sink type (required examples)
10. Sequence type (required examples)
11. Guard selector reference table
12. Error/poison behavior with typed declarations
13. Extensibility:
- `addDataMethods` for data methods
- note that legacy command-handler registration APIs are compatibility-only/inert for output-command execution in current async environment.
14. Known limitations / pending items

## Concrete example rewrites (old -> new)

Old:
```cascada
:data
@data.user.name = "Alice"
@text("done")
```

New (typed declarations still used, but return shape is normal application data):
```cascada
data outData
text outText
outData.user.name = "Alice"
outText("done")
return {
  user: outData.snapshot().user,
  message: outText.snapshot()
}
```

Old:
```cascada
macro calc(x) :value
  @value = x * 2
endmacro
```

New:
```cascada
macro calc(x)
  var out
  out = x * 2
  return out.snapshot()
endmacro
```

Old:
```cascada
var r = capture :data
  @data.x = 1
endcapture
```

New:
```cascada
data tmp
tmp.x = 1
var r = tmp.snapshot()
```
