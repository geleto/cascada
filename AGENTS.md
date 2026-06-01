# Cascada AI Agent Guide

Assistance guide for developing the Cascada engine — writing, refactoring, and testing JavaScript.

**Package**: `cascada-engine` | **Repository**: https://github.com/geleto/cascada

## Table of Contents

- [Project Overview](#project-overview)
- [Glossary](#glossary)
- [Key Files](#key-files)
- [Primary Agent Directives & Rules](#primary-agent-directives--rules)
- [Implementation Architecture](#implementation-architecture)
- [Development & Testing](#development--testing)
- [API Quick Reference](#api-quick-reference)

---

## Project Overview

Cascada is a parallel-first scripting and templating engine. Core model: **Implicitly Parallel, Explicitly Sequential** — code reads like synchronous logic, independent operations run concurrently, and `!` markers or named chains enforce ordering where needed.

Scripts use named chains for output. Templates are Nunjucks-compatible. Script variables use `var x = value` (equivalent to `{% set x = value %}` in templates).

| Chain | Declaration | Return | Output |
|---|---|---|---|
| `data` | `data result` | `return result.snapshot()` | plain object |
| `text` | `text body` | `return body.snapshot()` | string |
| `var` | implicit | read as `x` | any value |

```javascript
data result
var user = fetchUser(userId)
var posts = fetchPosts(userId)
for post in posts
  var enriched = enrichPost(post)
  result.posts.push({ title: enriched.title, status: enriched.status })
endfor
db!.log("report", userId)
return result.snapshot()
```

Language syntax: `docs/cascada/script.md` (authoritative). `docs/cascada/cascada-agent.md` is an AI-optimized reference for both Cascada Script and Cascada Template. Nay lag the reference documents.

---

## Glossary

**Chain** — Named, typed state lane in a `CommandBuffer`. User-facing: `data` (structured accumulation), `text` (ordered text), `var` (single-value variable, fast `snapshot()`). Commands enqueue in source order and are applied by the buffer iterator.

**Command Buffer (`CommandBuffer`)** — Runtime tree node holding source-ordered commands and child buffers. Compiled async code enqueues into the *current* buffer; the iterator walks depth-first in source order, waiting on unfilled child slots.

**Poison / `PoisonedValue`** — Thenable error container (`.errors[]`). Operations receiving poison are skipped and propagate it. Awaiting throws a poison error: a single `PoisonError` for one failure, or `PoisonErrorGroup` for multiple failures. Detect with `isPoison(value)` before `await`; use `isPoisonError(err)` in `catch` because it matches both individual and aggregate poison errors.

**`snapshot()`** — Materializes chain state. `data`/`text`: assembles source-ordered commands into object/string. `var`: fast direct read. Use `return result.snapshot()` to capture named chain output.

**Async Boundary** — Compiler-inserted child buffer for code whose command shape is unknown until a value resolves. Parent preserves the source-order slot; child fills later.

**Sync-First Hybrid** — Non-`async` outer function handles sync fast paths; real promises delegate to an inner `async` helper. Avoids Promise overhead for ~30–40% of calls.

**Sequential Path / `!`** — Signals that an operation has side effects on an external path. Once any call on that path uses `!`, all subsequent accesses wait for the preceding operation to complete before starting.

---

## Key Files

Full file map: [`docs/code/file-map.md`](docs/code/file-map.md)

**Entry / API**
- `src/environment/async-environment.js` — User-facing async API; tests instantiate `AsyncEnvironment` here
- `src/index.js` — Package exports

**Runtime**
- `src/runtime/errors.js` — `PoisonError`, `isPoison`, `isPoisonError`, `handleError`
- `src/runtime/resolve.js` — `resolveAll`, `resolveSingle`, sync-first resolution helpers
- `src/runtime/command-buffer.js` — Buffer creation, chain linking, command routing
- `src/runtime/chains/data-chain.js` / `src/runtime/commands/data.js` — data chain state and `DataCommand` method dispatch

**Compiler**
- `src/compiler/compiler.js` — Main entry; chooses sync/async/script mode
- `src/compiler/compiler-async.js` — Async statement compilation
- `src/compiler/compiler-base-async.js` — Async expression compilation
- `src/compiler/analysis.js` — Chain analysis: `usedChains`, `mutatedChains`, `sequenceLocks`
- `src/compiler/emit.js`, `boundaries.js`, `buffer.js` — Codegen primitives and boundary wiring
- `src/compiler/sequential.js` — Sequential (`!`) path analysis

**Script**
- `src/language/script-transpiler.js` — Script-to-template transpiler
- `src/builtins/data-methods.js` — Built-in data-chain methods: `push`, `merge`, etc.

**Tests**
- `tests/pasync/` — Async/parallelism tests by feature (`loops.js`, `conditional.js`, `macros.js`, `sequential-*.js`, …). Scan before writing new tests.
- `tests/poison/` — Error/poison system tests
- `tests/util.js` — `StringLoader` and other test utilities

When docs and implementation disagree, prefer current source and tests.

---

## Primary Agent Directives & Rules

**Most important section. Adhere to these rules in all development tasks.**

### Your Core Task

Write and modify JavaScript for `cascada-engine`: implement features, fix bugs, write tests. All work aligns with **Implicitly Parallel, Explicitly Sequential**.

Development and tests require Node `>=22`.

### Golden Rules (DOs and DON'Ts)

**Follow strictly. Designed to align with Cascada's architecture, prevent bugs, and ensure performance.**

#### **Repository Hygiene**

*   ✅ **DO:** Work with a dirty tree carefully. User changes may already be present.
*   ✅ **DO:** Leave completed edits unstaged unless the user explicitly asks you to stage them.
*   ❌ **DON'T:** Revert unrelated changes or use destructive git commands unless explicitly asked.

#### **Language & Scripting (Writing Cascada Code)**

*   ✅ **DO:** Use `!` on **static context paths** (e.g., `db.users!.create()`) to enforce strict execution order for side effects.
*   ✅ **DO:** Use explicit returns (`return result.snapshot()`, `return body.snapshot()`, or direct values) in scripts/functions for clean, predictable return values.
*   ✅ **DO:** Use named chains (`data result`, `text body`, etc.) with explicit `return result.snapshot()` / `return body.snapshot()` to build complex intermediate outputs with guaranteed source-order assembly.

*   ❌ **DON'T:** Use `!` on template variables (`{% set x = ... %}{{ x!.method() }}`) or dynamic lookups (`items[i]!.method()`). Compiler only supports static paths from initial context.
*   ❌ **DON'T:** Manually collect results from parallel loops into temporary arrays if final order matters. Data/text chains handle this, guaranteeing ordered assembly despite concurrent execution.

#### **Testing**

*   ✅ **DO:** Use `it.only()` or `describe.only()` to isolate tests during development. Critical for speed.
*   ✅ **DO:** Write tests for both success path and `PoisonError` failure path for every new async feature.

*   ❌ **DON'T:** Write tests depending on completion order of concurrent operations when verifying correctness. **Test the final, deterministic output, not the intermediate race.**
    *   **Exception:** When specifically testing concurrency mechanism itself (e.g., using mocks with delays to prove `for` runs parallel while `each` runs sequential).
*   ❌ **DON'T:** Add runtime fallbacks for stale precompiled scripts/templates unless backwards compatibility is an explicit requirement; precompiled artifacts are build outputs.

#### **Compiler Implementation (Modifying `src/compiler/*.js`)**

*   ✅ **DO:** Keep cleanup passes minimal and behavior-preserving: remove unused helpers, inline one-line or single-use helpers when the call site stays clearer, and delete defensive checks only when setup/analysis guarantees the shape.
*   ✅ **DO:** Trust compiler-owned structure after parser, transformer, or analysis initialization. Check boundaries where public inputs, optional feature paths, or complex conditions can produce missing/invalid values; avoid rechecking arguments or properties whose shape normal execution guarantees.
*   ✅ **DO:** Prefer clear modern JS for guaranteed shapes: direct access for invariants, `?.` for genuinely optional paths, `??` for nullish defaults in value selection, and type checks only where values can really vary.
*   ✅ **DO:** Keep helpers that name real domain concepts, are reused, or prevent meaningful duplication.
*   ✅ **DO:** Use explicit `if` statements for conditional processing or side effects, such as iterating, pushing, emitting, or mutating optional values. Avoid `(items ?? []).forEach(...)` when `if (items) { ... }` is clearer.
*   ❌ **DON'T:** Swap `||` and `??` casually: `||` treats `false`, `0`, and `""` as missing; `??` only treats `null`/`undefined` as missing.
*   ❌ **DON'T:** Hide invariant violations with optional chaining, `||` defaults, `!!`, or repeated `typeof`/array/object/string/number guards. Keep guards that support sync mode, public helpers, synthetic nodes, or pre-child-walk metadata seeding.
*   ✅ **DO:** Trust the runtime to handle synchronization. Provide correct chain analysis metadata (`declaredChains`, `usedChains`, `mutatedChains`, `sequenceLocks`) and linked-chain information so buffers can observe the right values in source order.
*   ❌ **DON'T:** Write raw `(async () => { ... })()` blocks. Use the established compiler boundary/buffer helpers in `emit.js`, `boundaries.js`, `buffer.js`, and related compiler modules so chain linking, current-buffer state, and error context stay consistent.
*   ❌ **DON'T:** Modify legacy synchronous error handling (top-level `lineno`/`colno` variables). All new error handling targets async model (`errorContext` objects and per-block `try/catch`).

#### **Runtime & Performance**

*   ✅ **DO:** Prioritize **"Sync-First Hybrid" pattern** to maximize performance:
    1.  Create main **non-`async`** function (e.g., `memberLookupAsync`).
    2.  Handle fast paths synchronously: check poison (`if (isPoison(value)) return value;`), check simple literals (`if (!val || typeof val.then !== 'function') return processSync(val);`).
    3.  Delegate complex cases (actual promises, arrays of promises) to separate **`async`** helper (e.g., `_memberLookupAsyncComplex`).
    *   **Why:** Avoids Promise overhead for 30-40% of synchronous cases—major performance win.

*   ✅ **DO:** Check if value is promise (`if (val && typeof val.then === 'function')`) before `await`. Cheaper than blind `await` on literals.
*   ✅ **DO:** Distinguish **value consumption** from **normal control-flow/runtime throws**:
    *   If a loop/conditional/include path is **consuming a value** (awaiting a promise, reading a thenable, iterating an async iterator, evaluating an async condition, etc.), failures belong to normal Cascada error flow. Poison the affected writes/effects and do **not** rethrow from that path.
    *   Error context and stack metadata belong to the **source/origin of the error**, not the consumer. When consuming an already-failed value or `PoisonedValue`, preserve its existing context unchanged; only attach local `errorContext` or boundary stack metadata when the current operation is the source.
    *   If the **normal flow itself** throws (invariant violation, bad control-flow contract, unexpected runtime bug, invalid hard precondition), let that error propagate as a real error. Do **not** silently convert it into poison.
    *   Callback-based fire-and-forget runtime boundaries (for example helpers that own async child-buffer cleanup) should still report real errors via `reportError(...)` with context, because there may be no awaiting caller on that path.
*   ✅ **DO:** Treat the current command buffer as the only place where runtime commands are enqueued for an execution point.
    *   Observable commands (`addSnapshot`, waits, error reads, etc.) and mutating commands must both be added to the current buffer.
    *   If a value/scope is visible, the current buffer must already have the needed linked chain path. Fix the linking or payload transport; do not jump to a parent/root producer buffer.
*   ✅ **DO:** Keep ordinary lookup, explicit shared observation, and explicit composition payload capture as separate mechanisms.
    *   Ordinary bare-name lookup must use the current buffer hierarchy.
    *   Explicit inheritance/shared observation may use inheritance metadata, but should still enqueue on the current buffer.
    *   Immediate composition capture (`extends ... with ...`) is not an ordered snapshot read and must stay a narrow dedicated primitive.

#### **Runtime Error Model**

*   ✅ **DO:** Keep the three public error roles clear:
    *   `CompileError` is compile-time/source-position failure.
    *   `RuntimeError` is fatal runtime/contract failure. Report with `RuntimeError.report(...)` or `RuntimeError.reportAndThrow(...)` when context exists.
    *   `PoisonError` is non-fatal value failure. It travels inside `PoisonedValue`; awaiting poison throws a poison error.
*   ✅ **DO:** Use the three explicit poison factories:
    *   `PoisonError.create(message, errorContext)` for a new engine-created value failure.
    *   `PoisonError.wrap(error, errorContext)` for one normal JS/user error caught at the source operation.
    *   `PoisonError.group(poisonErrors)` for grouping existing poison errors only.
*   ✅ **DO:** Use `createPoison(poisonError)` only with a ready `PoisonError` from `create`, `wrap`, or `group`.
*   ✅ **DO:** Pass `PoisonError` objects between runtime components. Use `.errors[]` only for `PoisonedValue` storage/inspection or local collection before grouping.
*   ✅ **DO:** Preserve origin context: when handling existing poison, pass it through or group it; never replace its context with the consumer's context.
*   ❌ **DON'T:** Put raw `Error`, strings, or arrays directly into `createPoison(...)`, command poison payloads, or chain poison hooks.
*   ❌ **DON'T:** Convert `RuntimeError` to poison. Fatal runtime errors must stay fatal.

*   ❌ **DON'T:** Reflexively make runtime functions `async`. An `async` function always returns Promise, adding overhead. Only use `async` on helper functions needing `await`.
*   ❌ **DON'T:** Check `isPoison()` **AFTER** `await`. Architecturally impossible for `await somePromise` to return `PoisonedValue`. Check before awaiting; catch poison errors with `isPoisonError(err)` after awaiting.
*   ❌ **DON'T:** Treat `isPoison()` as definitive test for all errors. It's synchronous check for existing `PoisonedValue`, not for whether Promise will reject. For promises, use `try/catch`.
*   ❌ **DON'T:** `return` `PoisonedValue` from an `async` function. **MUST** throw a poison error instead, usually `PoisonError.group(value.errors)` for existing poison or `PoisonError.wrap(error, errorContext)` for a newly caught value failure. Only non-`async` (or sync-first hybrid) functions can return `PoisonedValue` directly.
*   ❌ **DON'T:** Catch broad runtime errors and turn them into poison "just to keep going". Only value-consumption failures should be normalized into poison/effect poisoning.
*   ❌ **DON'T:** Short-circuit error collection. Always await ALL promises and collect ALL errors before returning/throwing (**"Never Miss Any Error"** principle).
*   ❌ **DON'T:** Use `instanceof` for poison detection. Always use `isPoison()` and `isPoisonError()` helpers.
*   ❌ **DON'T:** Construct legacy sync `TemplateError` directly in `catch` blocks. Frozen sync compiler paths use idempotent `runtime.handleError(e, ...)`; async runtime paths use `RuntimeError`, `PoisonError`, or `PoisonErrorGroup` with compact source context.
*   ❌ **DON'T:** "Fix" missing visibility by reading or waiting on the owner/producer buffer directly.
    *   No ordinary lookup fallback to parent/root buffers.
    *   No "current position" wait on parent/root buffers.
    *   If the current buffer cannot observe a value in source order, the real bug is missing linked chains, wrong `currentBuffer`, or missing explicit payload wiring.

---

## Implementation Architecture

Full reference: [`docs/code/implementation-architecture.md`](docs/code/implementation-architecture.md)

Read it when modifying compiler internals (`src/compiler/`), adding chain types, changing async boundary mechanics, or debugging unexpected runtime behavior.

---

## Development & Testing

Full guide (assertion examples, advanced techniques, scenario walkthroughs): [`docs/code/testing-guide.md`](docs/code/testing-guide.md)

### Running Tests

-   **Single file**: `npm run mocha -- tests/pasync/my-test.js`
-   **Quick (no build, no coverage)**: `npm run test:quick`
-   **Node + coverage**: `npm run test:node`
-   **Full suite (build + browser)**: `npm test`
-   **Lint**: `npm run lint` | **Build**: `npm run build`

Test locations: `tests/pasync/` (async/parallel), `tests/poison/` (error system), `tests/script-transpiler.js`, `tests/api.js`, `tests/core.js`.

### Common Tasks

**Add data-chain method**: implement in `src/builtins/data-methods.js` (built-in) or via `env.addDataMethods({ method: (target, ...args) => newValue })` (custom). Method receives current value at path as `target` (may be `undefined`). Test in `tests/pasync/output-data-methods.js`.

**Fix compiler bug**: isolate with `it.only()` + `env.renderScriptString`. Inspect generated JS with `script._compileSource()`. Trace `compileNodeType` methods from `Compiler.compile()`. Full walkthrough in [`docs/code/testing-guide.md`](docs/code/testing-guide.md).

---

## API Quick Reference

```javascript
import { AsyncEnvironment } from 'cascada-engine';
const env = new AsyncEnvironment();

const result = await env.renderScriptString(script, context);           // returns explicit return value
const html   = await env.renderTemplateString(template, context);       // returns string
// opts: { path: 'file.casc' } improves error messages on both

env.addGlobal('utils', myUtils);
env.addFilter('myFilter', fn);
env.addDataMethods({ myMethod: (target, ...args) => newValue });
```

`AsyncTemplate` and `Script` compiled-class API (constructors, `_compileSource()`, `render()`): [`docs/code/testing-guide.md`](docs/code/testing-guide.md).
