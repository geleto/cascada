# Cascada AI Agent Guide

This guide provides context for developing the Cascada engine. Assist in writing, refactoring, and testing code, adhering to the architecture and patterns below.

**Package**: `cascada-engine`
**Repository**: https://github.com/geleto/cascada

## Table of Contents

- [Project Overview](#project-overview)
- [Glossary](#glossary)
- [Key Files and Directories](#key-files-and-directories)
- [Primary Agent Directives & Rules](#primary-agent-directives--rules)
- [Implementation Architecture](#implementation-architecture)
- [Development & Testing Guide](#development--testing-guide)
- [API & File Reference](#api--file-reference)


## Project Overview

Cascada is a parallel-first scripting and templating engine. The core model is **Implicitly Parallel, Explicitly Sequential**: code reads like ordinary synchronous logic, independent operations run concurrently, and explicit `!` markers or channels provide ordering where side effects or assembled output require it.

Scripts are data-orchestration code with named channels (`data result`, `text body`, etc.). Templates are Nunjucks-compatible text generation. Script uses `var x = value` for local variables; this is equivalent to `{% set x = value %}` in Nunjucks templates.

Named channels aggregate output across parallel branches in source order. `result.snapshot()` and `body.snapshot()` materialize the assembled channel state into a plain JS value (object or string) at the point of the `return` statement.

| Channel | Declaration | `return` syntax | Output type |
|---|---|---|---|
| `data` | `data result` | `return result.snapshot()` | plain object |
| `text` | `text body` | `return body.snapshot()` | string |
| `var` | implicit (`var x = value`) | read as `x` | any value |

Script variables (`var x`) are implicitly backed by a `var` channel — a channel that can only set, hold, and observe a single value. Because it holds exactly one value, `snapshot()` on a `var` channel is a fast direct read, not the ordered-assembly operation that `data` and `text` channels perform. This is why variable access in scripts looks and feels like ordinary synchronous code.

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

For language details, prefer `docs/cascada/script.md`; `docs/cascada/script-agent.md` is a concise AI-optimized reference that will be added shortly but may not be fully up-to-date when present.

---

## Glossary

Brief definitions for terms used throughout this guide. Full mechanics are in the [Implementation Architecture](#implementation-architecture) section.

**Channel** — A named, typed state lane inside a `CommandBuffer`. User-facing channel types are `data` (structured accumulation) and `text` (ordered text output). `var` is also a channel internally — it can only set, hold, and observe a single value, so `snapshot()` on it is a fast direct read rather than an ordered assembly; this is why script variables look and feel like ordinary synchronous values. Other internal types (`sequence`, `error`, `observation`, `timing`, `sequential-path`) are managed by the runtime. Commands enqueued to a channel are applied in source order by the buffer iterator.

**Command Buffer (`CommandBuffer`)** — A runtime tree node that holds source-ordered commands and child buffers. Compiled async code enqueues commands into the *current* buffer rather than mutating state directly. The buffer iterator (`buffer-iterator.js`) walks the tree depth-first in source order, waiting on unfilled child slots.

**Poison / `PoisonedValue`** — A thenable error container carrying an `.errors[]` array. Operations receiving poison as input are skipped and propagate poison instead of executing. Awaiting a `PoisonedValue` throws a `PoisonError`. Detect with `isPoison(value)` before `await`, and `isPoisonError(err)` in `catch` blocks.

**`snapshot()`** — Materializes the current state of any channel into a plain JS value. For `data` and `text` channels this assembles source-ordered commands into an object or string; for `var` channels it is a fast direct read of the held value. Use `return result.snapshot()` / `return body.snapshot()` to capture named channel output.

**Async Boundary** — A compiler-inserted child buffer for code whose command shape is unknown until a value resolves (e.g., `if` conditions, loop iterables, macro calls). The parent buffer preserves the source-order slot; the child buffer is filled later.

**Sync-First Hybrid** — A runtime performance pattern. The outer function is non-`async` and handles synchronous fast paths directly; only cases involving actual promises are delegated to a separate inner `async` helper. Avoids Promise overhead for 30–40% of calls.

**Sequence Lock / `!`** — Runtime mechanism that enforces strict source-order execution for calls on a static path (e.g., `db!.write()`). Each call awaits the prior call on that path before executing.

---

## Key Files and Directories

### Source Directories
-   `src/compiler/`: Core compiler logic including AST transformation, channel analysis, async boundaries, and code generation.
-   `src/environment/`: Public API, environment configuration, and wrapper classes (`AsyncEnvironment`, `AsyncTemplate`, `Script`).
-   `src/loader/`: Template loading mechanisms (FileSystem, Web, precompiled, string helpers).
-   `src/runtime/`: Runtime helpers, command buffers, channels, async boundaries, lookups/calls, and error handling (Poison system).
-   `src/script/`: Cascada Script specifics, default data-channel methods, channel helpers, and the script-to-template transpiler.

### Key Files

-   `src/index.js`: **Package entry point.** Exports public classes/functions from the source tree.
-   `src/environment/environment.js`: **Environment barrel.** Re-exports `Environment`, `AsyncEnvironment`, `Template`, `AsyncTemplate`, and `Script`.
-   `src/environment/async-environment.js`: **Async user-facing API.** Tests usually instantiate `AsyncEnvironment` from here or from `src/index.js`.
-   `src/environment/template.js`: **Compiled template classes.** Contains `Template` and `AsyncTemplate`.
-   `src/environment/script.js`: **Compiled script class.** Contains `Script`, which transpiles Cascada Script to template syntax before compilation.
-   `src/runtime/runtime.js`: **Runtime barrel.** Re-exports helpers and channel/command classes used by compiled code.
-   `src/runtime/errors.js`: **Poison and error helpers.** Contains `PoisonError`, `isPoison`, `isPoisonError`, `handleError`, and related utilities.
-   `src/runtime/resolve.js`: **Promise/poison resolution.** Contains `resolveAll`, `resolveSingle`, and related sync-first resolution helpers.
-   `src/runtime/command-buffer.js`: **Command buffer implementation.** Creates and links runtime buffers and routes commands to channels.
-   `src/runtime/buffer-iterator.js`: **Buffer iterator.** Walks the command buffer tree depth-first in source order, applying commands and waiting on unfilled child slots.
-   `src/runtime/async-boundaries.js`: **Async boundary helpers.** Runtime support for compiler-inserted async boundaries.
-   `src/runtime/channels/*.js`: **Channel and command implementations.** Text, data, var, observation, timing, sequence, sequential-path, and error commands live here.
-   `src/compiler/compiler.js`: **Main compiler entry.** Chooses sync/async/script compiler behavior and orchestrates code generation.
-   `src/compiler/compiler-async.js`: **Async statement compiler.** Handles async templates/scripts, statements, output commands, guards, and async boundaries.
-   `src/compiler/compiler-sync.js`: **Sync statement compiler.** Handles non-async templates and statements.
-   `src/compiler/compiler-base-async.js`: **Async expression compiler.** Handles expression-level async behavior, lookups, function calls, and waited reads.
-   `src/compiler/compiler-base-sync.js`: **Sync expression compiler.** Handles expression-level behavior for non-async templates.
-   `src/compiler/analysis.js`: **Channel analysis.** Computes declarations, `usedChannels`, `mutatedChannels`, and `sequenceLocks`.
-   `src/compiler/buffer.js`: **Buffer/codegen helpers.** Emits command construction and command-buffer interactions.
-   `src/compiler/emit.js`: **Code emission helpers.** Low-level code generation primitives used by statement and expression compilers.
-   `src/compiler/boundaries.js`: **Async boundary emission.** Emits child buffer creation and async boundary wiring in compiled code.
-   `src/compiler/sequential.js`: **Sequential (`!`) analysis.** Identifies static sequence paths and validates `!` usage.
-   `src/script/default-data-methods.js`: **Built-in data-channel methods.** Defines default data mutations such as `push`, `merge`, and related helpers.
-   `src/runtime/channels/data.js`: **Runtime data channel.** Applies `DataCommand` instances and custom data methods registered with `AsyncEnvironment.addDataMethods`.
-   `src/script/script-transpiler.js`: **Script-to-template transpiler.**
-   `tests/`: **Test suites.**
    -   `tests/pasync/`: Tests for advanced asynchronous execution and parallelism. Organized by feature: `loops.js`, `conditional.js`, `expressions.js`, `macros.js`, `sequential-*.js`, `script.js`, `extends*.js`, etc. Before writing a new test, scan for an existing file covering the relevant feature.
    -   `tests/poison/`: Tests for the error handling (Poison) system.
    -   `tests/util.js`: Test utilities including `StringLoader` class.

### Documentation Files

#### Documentation Directories
-   **User Docs**: `docs/cascada/` (e.g., `script.md`)
-   **Implementation Guides**: `docs/code/` (current guides are split by subsystem rather than one async overview)

#### Documentation Files
-   **User Docs** (`docs/cascada/`):
    -   `script-agent.md`: Concise AI-optimized guide to Cascada Script syntax and features. Will be added shortly; when present, may not be fully up-to-date with the latest features.
    -   `script.md`: Comprehensive, human-readable guide to Cascada Script syntax and features, almost always up-to-date with the latest features even before they are developed.
    -   `template.md`: Very outdated guide to Cascada Template syntax (Nunjucks-compatible). Use your Nunjucks knowledge and the scripting docs instead.
    -   `legacy.md`: Design document describing the old implicit-handler model. Useful when rewriting scripts that use legacy semantics.

-   **Implementation Guides** (`docs/code/`), may not be up-to-date on the latest implementation details:
    -   `Tests.md`: General testing guidelines and philosophy.
    -   `Error Handling Guide.md`: Overview of the "Poison" error system.
    -   `Error Handling Patterns In Script.md`: Common patterns for handling errors in scripts.
    -   `Poisoning - Implementation Principles.md`: Detailed mechanics of error propagation.
    -   `sequence.md`: Current notes for `!` sequence behavior.
    -   `output.md` and `output-scoping.md`: Output channel and scoping notes.
    -   `channels-refactor.md`, `command-buffer-refactor.md`, `expression-channels.md`: Channel and command-buffer implementation notes.
    -   `waited-loops.md`: Loop/wait behavior notes.
    -   `return.md` and `return-transpile.md`: Return semantics and script transpilation notes.
    -   `implementation-architecture.md`: Full compiler/runtime architecture reference (async execution model, channel system, buffer mechanics, value resolution, error propagation, sequential operations).

When docs and implementation disagree, prefer current source and tests. Treat `docs/code/` as design context, not an authority over live behavior.

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
*   ❌ **DON'T:** Revert unrelated changes or use destructive git commands unless explicitly asked.

#### **Language & Scripting (Writing Cascada Code)**

*   ✅ **DO:** Use `!` on **static context paths** (e.g., `db.users!.create()`) to enforce strict execution order for side effects.
*   ✅ **DO:** Use explicit returns (`return result.snapshot()`, `return body.snapshot()`, or direct values) in scripts/functions for clean, predictable return values.
*   ✅ **DO:** Use named channels (`data result`, `text body`, etc.) with explicit `return result.snapshot()` / `return body.snapshot()` to build complex intermediate outputs with guaranteed source-order assembly.

*   ❌ **DON'T:** Use `!` on template variables (`{% set x = ... %}{{ x!.method() }}`) or dynamic lookups (`items[i]!.method()`). Compiler only supports static paths from initial context.
*   ❌ **DON'T:** Manually collect results from parallel loops into temporary arrays if final order matters. Data/text channels handle this, guaranteeing ordered assembly despite concurrent execution.

#### **Testing**

*   ✅ **DO:** Use `it.only()` or `describe.only()` to isolate tests during development. Critical for speed.
*   ✅ **DO:** Write tests for both success path and `PoisonError` failure path for every new async feature.

*   ❌ **DON'T:** Write tests depending on completion order of concurrent operations when verifying correctness. **Test the final, deterministic output, not the intermediate race.**
    *   **Exception:** When specifically testing concurrency mechanism itself (e.g., using mocks with delays to prove `for` runs parallel while `each` runs sequential).

#### **Compiler Implementation (Modifying `src/compiler/*.js`)**

*   ✅ **DO:** Trust the runtime to handle synchronization. Provide correct channel analysis metadata (`declaredChannels`, `usedChannels`, `mutatedChannels`, `sequenceLocks`) and linked-channel information so buffers can observe the right values in source order.
*   ❌ **DON'T:** Write raw `(async () => { ... })()` blocks. Use the established compiler boundary/buffer helpers in `emit.js`, `boundaries.js`, `buffer.js`, and related compiler modules so channel linking, current-buffer state, and error context stay consistent.
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
    *   If the **normal flow itself** throws (invariant violation, bad control-flow contract, unexpected runtime bug, invalid hard precondition), let that error propagate as a real error. Do **not** silently convert it into poison.
    *   Callback-based fire-and-forget runtime boundaries (for example helpers that own async child-buffer cleanup) should still report real errors via `cb(...)` with context, because there may be no awaiting caller on that path.
*   ✅ **DO:** Treat the current command buffer as the only place where runtime commands are enqueued for an execution point.
    *   Observable commands (`addSnapshot`, waits, error reads, etc.) and mutating commands must both be added to the current buffer.
    *   If a value/scope is visible, the current buffer must already have the needed linked channel path. Fix the linking or payload transport; do not jump to a parent/root producer buffer.
*   ✅ **DO:** Keep ordinary lookup, explicit shared observation, and explicit composition payload capture as separate mechanisms.
    *   Ordinary bare-name lookup must use the current buffer hierarchy.
    *   Explicit inheritance/shared observation may use inheritance metadata, but should still enqueue on the current buffer.
    *   Immediate composition capture (`extends ... with ...`) is not an ordered snapshot read and must stay a narrow dedicated primitive.

*   ❌ **DON'T:** Reflexively make runtime functions `async`. An `async` function always returns Promise, adding overhead. Only use `async` on helper functions needing `await`.
*   ❌ **DON'T:** Check `isPoison()` **AFTER** `await`. Architecturally impossible for `await somePromise` to return `PoisonedValue`. Check before awaiting; catch `PoisonError` after awaiting.
*   ❌ **DON'T:** Treat `isPoison()` as definitive test for all errors. It's synchronous check for existing `PoisonedValue`, not for whether Promise will reject. For promises, use `try/catch`.
*   ❌ **DON'T:** `return` `PoisonedValue` from `async` function. **MUST** `throw new PoisonError(...)`. Only non-`async` (or sync-first hybrid) functions can return `PoisonedValue` directly.
*   ❌ **DON'T:** Catch broad runtime errors and turn them into poison "just to keep going". Only value-consumption failures should be normalized into poison/effect poisoning.
*   ❌ **DON'T:** Short-circuit error collection. Always await ALL promises and collect ALL errors before returning/throwing (**"Never Miss Any Error"** principle).
*   ❌ **DON'T:** Use `instanceof` for poison detection. Always use `isPoison()` and `isPoisonError()` helpers.
*   ❌ **DON'T:** Construct `TemplateError` directly in `catch` blocks. Always use idempotent `runtime.handleError(e, ...)`.
*   ❌ **DON'T:** "Fix" missing visibility by reading or waiting on the owner/producer buffer directly.
    *   No ordinary lookup fallback to parent/root buffers.
    *   No "current position" wait on parent/root buffers.
    *   If the current buffer cannot observe a value in source order, the real bug is missing linked channels, wrong `currentBuffer`, or missing explicit payload wiring.

---

## Implementation Architecture

Full reference: [`docs/code/implementation-architecture.md`](docs/code/implementation-architecture.md)

Read it when modifying compiler internals (`src/compiler/`), adding channel types (`src/runtime/channels/`), changing async boundary mechanics, or debugging unexpected runtime behavior. For most tasks — adding data methods, writing tests, fixing script-level bugs — the sections above are sufficient.

---

## Development & Testing Guide

Practical instructions for writing and testing code.

### Common Development Scenarios

#### Add New Data-Channel Method (e.g., `incrementBy`)

1.  **Locate defaults or custom API**: Built-in methods live in `src/script/default-data-methods.js`; user/custom methods are registered through `AsyncEnvironment.addDataMethods` in `src/environment/async-environment.js`.
2.  **Understand runtime application**: `src/runtime/channels/data.js` applies `DataCommand` instances and resolves custom methods.
3.  **Implement Logic**: Method receives `(target, ...args)`, returns new value. `target` is current value at path (could be `undefined`). `...args` are script arguments.
4.  **Add Method**: Add built-ins to `default-data-methods.js`, or add custom methods in test setup with `env.addDataMethods`.
    ```javascript
    env.addDataMethods({
      incrementBy: (target, amount) => (target || 0) + amount
    });
    ```
5.  **Write Test**: Add an isolated test in a relevant file such as `tests/pasync/output-data-methods.js`, including edge cases like `undefined` targets.

#### Fix Bug in Compiler Pass

1.  **Isolate Bug**: Write small, failing test using `it.only()`. Use simplest script demonstrating bug via `env.renderScriptString`.
2.  **Identify Compiler Pass**: Check `Key Files` reference. Bug likely lives in `src/compiler/compiler-async.js` or `compiler-sync.js` for statements, `compiler-base-async.js` or `compiler-base-sync.js` for expressions, `analysis.js` for channel metadata, `buffer.js`/`emit.js` for command-buffer wiring, or `sequential.js` for `!` logic.
3.  **Trace Compilation**: Entry point is `Compiler.compile()`. Follow `compileNodeType` methods (e.g., `compileIf`, `compileFunCall`) to trace AST→JavaScript conversion.
4.  **Inspect Generated Code**: `compile` function returns generated JS string. Log this in test to see incorrect compiler output.
5.  **Modify & Re-run**: Modify compiler logic, re-run the focused test with `npm run mocha -- tests/path/to/file.js`. Repeat until isolated test passes.
6.  **Remove `.only()`**: Run full test suite (`npm test`) to check regressions.

### Running Tests

-   **Quick Test (No Build)**: `npm run test:quick` — runs the full Node test suite from source without coverage instrumentation, build steps, or browser tests. Fastest way to check the suite.
-   **Single File (Recommended)**: `npm run mocha -- tests/pasync/loop-phase1-two-pass.js`
-   **Node Only (from source, with coverage)**: `npm run test:node`
-   **Browser Only (bundled from source)**: `npm run test:browser`
-   **Full Suite (build + precompile + Node + Browser)**: `npm test`
-   **Lint**: `npm run lint`
-   **Build**: `npm run build`
-   **Cycle Check**: `npm run check:cycles`
-   **Isolate Tests**: Use `.only()` on `it()` or `describe()` blocks. Standard workflow for focused development.

Test location guide:
-   Compiler/runtime async behavior: `tests/pasync/` — organized by feature (`loops.js`, `conditional.js`, `expressions.js`, `macros.js`, `sequential-*.js`, `script.js`, `extends*.js`, etc.). Before writing a new test, scan for an existing file covering the relevant feature.
-   Poison/error behavior: `tests/poison/`
-   Script transpiler: `tests/script-transpiler.js`
-   Public API: `tests/api.js`
-   Classic Nunjucks compatibility: `tests/core.js`, `tests/compiler.js`

```javascript
describe.only('My New Feature', () => {
  it.only('should handle primary use case', async () => {
    // Your test. Only this runs.
  });
});
```

### Test Assertions (`expect.js`)

Uses **expect.js**.

```javascript
// Equality
expect(value).to.be(expected);           // Strict equality (===)
expect(value).to.eql(expected);          // Deep equality (objects/arrays)

// Truthiness & Type
expect(value).to.be.ok();                // Truthy
expect(value).to.be.a('string');         // Type check
expect(value).to.be.an(Array);           // instanceof

// Collections
expect(arr).to.have.length(3);
expect(arr).to.contain(item);
expect(obj).to.have.property('key');

// Errors
expect(fn).to.throwException(/message/);

// Async Error Testing
it('should throw error', async () => {
  try {
    await env.renderScriptString(badScript);
    expect().fail('Should have thrown');
  } catch (err) {
    expect(isPoisonError(err)).to.be(true);
    expect(err.errors[0].message).to.contain('expected error');
  }
});
```

### Advanced Testing Techniques

#### Using `StringLoader` for In-Memory Templates

Use `StringLoader` from `tests/util.js` for in-memory template tests:

```javascript
import {StringLoader} from './util.js';
import {AsyncEnvironment} from '../src/environment/environment.js';

const loader = new StringLoader();
const env = new AsyncEnvironment(loader);

loader.addTemplate('header.njk', '<h1>{{ title }}</h1>');
loader.addTemplate('main.njk', '{% include "header.njk" %}');

const result = await env.renderTemplate('main.njk', { title: 'Hello' });
```

#### Inspecting Compiled Code with `_compileSource()`

For debugging compiler issues, examine generated JavaScript:

For script syntax/transpiler bugs, inspect both `scriptTranspiler.scriptToTemplate(source)` and `new Script(source, env)._compileSource()`. For ordinary execution tests, prefer `env.renderScriptString(...)` over direct `script.render(...)`.

```javascript
import {AsyncEnvironment, AsyncTemplate, Script} from '../src/environment/environment.js';

const env = new AsyncEnvironment();

const template = new AsyncTemplate('{% set x = asyncFunc() %}{{ x }}', env);
const source = template._compileSource();
expect(source).to.contain('await');

const script = new Script('data result\nresult.count = 5\nreturn result.snapshot()', env);
const compiledCode = script._compileSource();
expect(compiledCode).to.contain('DataCommand');
```

#### Transpiling Script to Template with `scriptTranspiler.scriptToTemplate()`

Verify script-to-template conversion:

```javascript
import {transpiler as scriptTranspiler} from '../src/script/script-transpiler.js';

const script = 'data result\nvar user = getUser()\nresult.userName = user.name\nreturn result.snapshot()';
const template = scriptTranspiler.scriptToTemplate(script);

expect(template).to.contain('{%- var user = getUser() -%}');
expect(template).to.contain('command result.set(["userName"], user.name)');
```

---

## API & File Reference

### Main API (`AsyncEnvironment`)

```javascript
import { AsyncEnvironment } from 'cascada-engine';
const env = new AsyncEnvironment();

// Execute script — returns the script's explicit return value
const result = await env.renderScriptString(script, context);

// Render template to text
const html = await env.renderTemplateString(template, context);

// Optionally specify a source path for better error messages
const result = await env.renderScriptString(script, context, { path: 'my-script.casc' });

// Add custom logic
env.addGlobal('utils', myUtils);
env.addFilter('myFilter', myFilterFunc);
env.addDataMethods({ myMethod: myDataMethodFunc });
```

### Compiled Template/Script Classes

#### `AsyncTemplate`

Represents compiled async Nunjucks template. Created internally by `AsyncEnvironment` or instantiated directly.

```javascript
import { AsyncTemplate, AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();
const tmpl = new AsyncTemplate(templateSource, env, 'path/to/template.njk');

// Render returns Promise
const html = await tmpl.render(context);
```

**Key Methods:**
- `render(context)` - Returns `Promise<string>` with rendered output
- `compile()` - Compiles template (called automatically on first render)
- `_compileSource()` - Returns generated JavaScript source code (debugging)

#### `Script`

Represents compiled async Cascada script. It automatically transpiles script syntax to template syntax. Most tests should use `env.renderScriptString(...)`; instantiate `Script` directly mainly when inspecting `_compileSource()` or testing compiled-class behavior.

```javascript
import { Script, AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();
const script = new Script(scriptSource, env, 'path/to/script.casc');

const source = script._compileSource();
```

**Key Methods:**
- `render(context)` - Lower-level render path; prefer `env.renderScriptString(...)` in normal tests
- `compile()` - Compiles script (called automatically on first render)
- `_compileSource()` - Returns generated 
JavaScript source code (debugging)
