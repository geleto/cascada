# Cascada AI Agent Guide

This guide provides context for developing the Cascada engine. Assist in writing, refactoring, and testing code under supervision, adhering to the architecture and patterns below.

**Package**: `cascada-engine`
**Repository**: https://github.com/geleto/cascada

## Table of Contents

- [Key Files and Directories](#key-files-and-directories)
- [Primary Agent Directives & Rules](#primary-agent-directives--rules)
- [Project Overview](#project-overview)
- [Language & Features](#language--features)
- [Implementation Architecture](#implementation-architecture)
- [Development & Testing Guide](#development--testing-guide)
- [API & File Reference](#api--file-reference)


## Key Files and Directories

### Source Directories
-   `src/compiler/`: Core compiler logic including AST transformation, async analysis, and code generation.
-   `src/environment/`: Public API, environment configuration, and wrapper classes (`AsyncEnvironment`, `AsyncTemplate`).
-   `src/loader/`: Template loading mechanisms (FileSystem, String, etc.).
-   `src/runtime/`: Runtime helpers, async state machine, and error handling (Poison system).
-   `src/script/`: Cascada Script specifics and the script-to-template transpiler.

### Key Files

-   `src/environment/environment.js`: **User-facing API & Test Setup**. Entry point for users. Tests instantiate `AsyncEnvironment` from here. Contains `AsyncTemplate` and `AsyncScript` classes.
-   `src/runtime/runtime.js`: **Runtime helpers.** Contains `resolveAll`, `flattenBuffer`, `isPoison`, `PoisonError`, and all functions called by compiled code.
-   `src/compiler/compiler.js`: **Main compiler.** Handles statements (`if`, `for`, `block`, etc.) and orchestrates code generation.
-   `src/compiler/compiler-base.js`: **Expression compiler.** Handles expressions (`+`, `*`, `myVar.prop`, `myFunc()`).
-   `src/compiler/compile-async.js`: **Async analysis.** Contains `propagateIsAsync` and logic for calculating `readVars` and `writeCounters`.
-   `src/compiler/compile-sequential.js`: **Sequential (`!`) analysis.** Logic for identifying and managing sequential operation paths.
-   `src/data-handler.js`: **`@data` handler implementation.** The logic for all `@data` commands resides here.
-   `src/script/script-*.js`: **Script-specific features,** including the script-to-template transpiler.
-   `tests/`: **Test suites.**
    -   `tests/pasync/`: Tests for advanced asynchronous execution and parallelism.
    -   `tests/poison/`: Tests for the error handling (Poison) system.
    -   `tests/util.js`: Test utilities including `StringLoader` class.

### Documentation Files

#### Documentation Directories
-   **User Docs**: `docs/cascada/` (e.g., `script.md`)
-   **Implementation Guides**: `docs/code/` (e.g., `Async - Implementation.md`)

#### Documentation Files
-   **User Docs** (`docs/cascada/`):
    -   `script-agent.md`: More concise guide to Cascada Script syntax and features for AI agents, may not be up-to-date on the very latest features being developed.
    -   `script.md`: Comprehensive, human-readable guide to Cascada Script syntax and features, almost always up-to-date with the latest features even before they are developed.
    -   `template.md`: Very outdated guide to Cascada Template syntax (Nunjucks-compatible). Use your nunjucks knowledge and the scripting docs instead.

-   **Implementation Guides** (`docs/code/`), may not be up-to-date on the latest implementation details:
    -   `Tests.md`: General testing guidelines and philosophy.
    -   `Async - Implementation.md`: Deep dive into the async runtime and promise handling.
    -   `Error Handling Guide.md`: Overview of the "Poison" error system.
    -   `Error Handling Patterns In Script.md`: Common patterns for handling errors in scripts.
    -   `Poisoning - Implementation Principles.md`: Detailed mechanics of error propagation.
    -   `Poisoning - Output Handler Implementation.md`: How output handlers deal with poison values.
    -   `Sequential Operations - Execution.md`: How `!` operations are serialized.
    -   `Sequential Operations - In Expressions.md`: Implementation of sequential operations within expressions.
    -   `Loops - Implementation.md`: Parallel loop execution details.
    -   `Loops - Implementation Principles.md`: Theoretical principles behind loop implementation.
    -   `Output - Revert Implementation.md`: Details on the output revert mechanism.

## Primary Agent Directives & Rules

**Most important section. Adhere to these rules in all development tasks.**

### Your Core Task

Write and modify TypeScript/JavaScript for `cascada-engine`: implement features, fix bugs, write tests. All work aligns with **Implicitly Parallel, Explicitly Sequential**.

### Golden Rules (DOs and DON'Ts)

**Follow strictly. Designed to align with Cascada's architecture, prevent bugs, and ensure performance.**

#### **Language & Scripting (Writing Cascada Code)**

*   ✅ **DO:** Use `!` on **static context paths** (e.g., `db.users!.create()`) to enforce strict execution order for side effects.
*   ✅ **DO:** Use output focusing (`:data`, `:text`) in scripts/macros for clean, predictable return values.
*   ✅ **DO:** Use `var result = capture :data ...` to build complex intermediate objects, leveraging the `@data` assembly system's guaranteed order.

*   ❌ **DON'T:** Use `!` on template variables (`{% set x = ... %}{{ x!.method() }}`) or dynamic lookups (`items[i]!.method()`). Compiler only supports static paths from initial context.
*   ❌ **DON'T:** Manually collect results from parallel loops into temporary arrays if final order matters. The `@data` system handles this, guaranteeing ordered assembly despite concurrent execution.

#### **Testing**

*   ✅ **DO:** Use `it.only()` or `describe.only()` to isolate tests during development. Critical for speed.
*   ✅ **DO:** Write tests for both success path and `PoisonError` failure path for every new async feature.

*   ❌ **DON'T:** Write tests depending on completion order of concurrent operations when verifying correctness. **Test the final, deterministic output, not the intermediate race.**
    *   **Exception:** When specifically testing concurrency mechanism itself (e.g., using mocks with delays to prove `for` runs parallel while `each` runs sequential).

#### **Compiler Implementation (Modifying `src/compiler/*.js`)**

*   ✅ **DO:** Trust the runtime to handle synchronization. Provide correct `readVars` and `writeCounters` to `frame.pushAsyncBlock`.
*   ❌ **DON'T:** Write raw `(async () => { ... })()` blocks. Always use `emit.asyncBlock*` helpers (essential for frame management, `astate` tracking, error context propagation).
*   ❌ **DON'T:** Modify legacy synchronous error handling (top-level `lineno`/`colno` variables). All new error handling targets async model (`errorContext` objects and per-block `try/catch`).

#### **Runtime & Performance**

*   ✅ **DO:** Prioritize **"Sync-First Hybrid" pattern** to maximize performance:
    1.  Create main **non-`async`** function (e.g., `memberLookupAsync`).
    2.  Handle fast paths synchronously: check poison (`if (isPoison(value)) return value;`), check simple literals (`if (!val || typeof val.then !== 'function') return processSync(val);`).
    3.  Delegate complex cases (actual promises, arrays of promises) to separate **`async`** helper (e.g., `_memberLookupAsyncComplex`).
    *   **Why:** Avoids Promise overhead for 30-40% of synchronous cases—major performance win.

*   ✅ **DO:** Check if value is promise (`if (val && typeof val.then === 'function')`) before `await`. Cheaper than blind `await` on literals.

*   ❌ **DON'T:** Reflexively make runtime functions `async`. An `async` function always returns Promise, adding overhead. Only use `async` on helper functions needing `await`.
*   ❌ **DON'T:** Check `isPoison()` **AFTER** `await`. Architecturally impossible for `await somePromise` to return `PoisonedValue`. Check before awaiting; catch `PoisonError` after awaiting.
*   ❌ **DON'T:** Treat `isPoison()` as definitive test for all errors. It's synchronous check for existing `PoisonedValue`, not for whether Promise will reject. For promises, use `try/catch`.
*   ❌ **DON'T:** `return` `PoisonedValue` from `async` function. **MUST** `throw new PoisonError(...)`. Only non-`async` (or sync-first hybrid) functions can return `PoisonedValue` directly.
*   ❌ **DON'T:** Short-circuit error collection. Always await ALL promises and collect ALL errors before returning/throwing (**"Never Miss Any Error"** principle).
*   ❌ **DON'T:** Use `instanceof` for poison detection. Always use `isPoison()` and `isPoisonError()` helpers.
*   ❌ **DON'T:** Construct `TemplateError` directly in `catch` blocks. Always use idempotent `runtime.handleError(e, ...)`.

---

## Project Overview

**Cascada** is a parallel-first scripting & templating engine for JavaScript/TypeScript that inverts traditional programming: **Implicitly Parallel, Explicitly Sequential**. Based on Nunjucks, provides both scripting language and template syntax with automatic, implicit concurrency.

### Core Philosophy

**Think Sequentially. Execute Concurrently.**

Write code that looks synchronous; Cascada's engine handles complex concurrent execution automatically. Any variable can be a promise under the hood—pass it into functions, use in expressions, assign it—all without thinking about async state.

### Key Differentiators

-   **Parallel by Default**: Independent operations run concurrently without special syntax.
-   **Data-Driven Flow**: Code runs when inputs ready, eliminating race conditions by design.
-   **Transparent Async**: Promises/async functions work seamlessly; no `await` needed in templates/scripts.
-   **Ordered Output**: Parallel execution, but results assembled in source-code order.
-   **Two Modes**: Script (data orchestration) + Template (text generation).

---

## Language & Features

<details>
<summary><strong>Click to expand Language & Features documentation...</strong></summary>

### Two Execution Modes

#### Cascada Script (Data-First)

Clean, delimiter-free syntax (`var`, `if`, `for`, no `{% %}`). **Output Commands** (`@data`, `@text`) for declarative data assembly. Focus on logic/orchestration (AI agents, data pipelines). Returns structured data objects.

```javascript
// AI orchestration example
var plan = makePlan("Analyze competitor's feature")
for step in plan.steps
  var result = executeStep(step.instruction)
  @data.stepResults.push({step: step.title, result: result})
endfor
@data.summary = summarize(result.stepResults)
```

#### Cascada Template (Text-First)

Familiar Nunjucks syntax (`{% %}`, `{{ }}`). Template composition (extends, include, import). Best for HTML, emails, LLM prompts. Returns rendered text.

```njk
{% set user = getUser() %}
{% set posts = getPosts(user.id) %}
<h1>{{ user.name }}</h1>
{% for post in posts %}
  <article>{{ post.title }}</article>
{% endfor %}
```

### Core Features

#### 1. Automatic Parallelization

Independent operations run concurrently. Data dependencies automatically respected.

```javascript
var user = getUser()          // Runs immediately
var posts = getPosts(user.id) // Waits for user
var footer = getFooter()      // Runs parallel with getUser
```

#### 2. Sequential Execution Control (`!`)

Use `!` for side effects needing strict ordering. **Only works on static paths from context variables.**

```javascript
var account = getBankAccount()
account!.deposit(100)    // 1. Runs first
account!.withdraw(50)    // 2. Waits for deposit
```

#### 3. Output Commands (`@` - Scripts Only)

Scripts use **Output Commands** via "Collect, Execute, Assemble" model.

-   `@data`: Build structured data (objects/arrays).
-   `@text`: Generate text output.
-   **Output focusing**: `:data` or `:text` at scope top (script, macro, capture) returns just that output.

```javascript
:data  // Returns just data object, not { data: {...}, text: "..." }
@data.user.name = "Alice"
@data.user.roles.push("editor")
@text("Processing complete")
```

#### 4. Macros & Reusable Components

Macros in scripts create reusable, data-producing components.

```javascript
macro buildUserSummary(userId) : data
  var details = fetchUserDetails(userId)
  var posts = fetchUserPosts(userId)
  @data.name = details.name
  @data.postCount = posts.length
endmacro

var user1 = buildUserSummary(101)
@data.users.push(user1)
```

#### 5. Error Handling (`try/resume/except`)

Resilient error handling system under development.

</details>

---

## Implementation Architecture

<details>
<summary><strong>Click to expand detailed architecture notes...</strong></summary>

### Async Execution Model

-   **Core Principle**: Transparently handle promises as first-class values, awaiting only when needed.
-   **Mechanism**: Potentially async operations wrapped in `async` IIFEs for non-blocking execution. Runtime state manager (`astate`) tracks completion.
-   **Key Components**: `AsyncFrame`, `runtime.resolveAll`, `runtime.flattenBuffer`.
-   **Reference**: `docs/code/Async - Implementation.md`

### Variable Synchronization

**Goal:** Prevent race conditions; ensure sequential equivalence when concurrent blocks read/write same outer-scope variables.

**Mechanism:** Compile-time analysis + runtime locking system.

1.  **Compile-Time Analysis:** Compiler statically analyzes each async block for variables it reads (`readVars`) and writes (`writeCounts`). `writeCounters` are conservative count of all potential writes, including those in conditional branches that may not be executed.

2.  **Runtime Locking (`pushAsyncBlock`):** When async block starts:
    *   **Snapshots:** Variables for reading snapshotted from parent frame, capturing state at block initiation.
    *   **Promisification (Locking):** Variables for writing **promisified** in parent frame. Value temporarily replaced with `Promise` (acts as lock), forcing other operations to wait.

3.  **Runtime Unlocking (Write Counting):** Writes inside async block update local copy and decrement internal `writeCounter`. When counter hits zero (all potential writes accounted), resolves parent's lock promise with final value, "unlocking" variable.

-   **Key Functions**: `frame.pushAsyncBlock`, `frame._promisifyParentVariables`, `frame._countdownAndResolveAsyncWrites`.

### Sequential Operations (`!`)

-   **Mechanism**: Uses **Sequence Keys** (e.g., `!account!deposit`) treated like special variables. Same promise-locking mechanism applied.
-   **Compiler Pass**: `_declareSequentialLocks` identifies `!` markers to register keys.
-   **Runtime Helpers**: `runtime.sequentialCallWrap`, `runtime.sequentialMemberLookupAsync` acquire/release lock.
-   **Reference**: `docs/code/Sequential Operations - Execution.md`

### Error Handling (Poison System)

-   **Core Principle**: "Never Miss Any Error." Await all promises and collect all errors before throwing.
-   **`PoisonedValue`**: *Thenable* object carrying `.errors[]` array. Can be passed synchronously.
-   **`PoisonError`**: `Error` thrown when `PoisonedValue` is awaited.
-   **Detection**:
    -   `isPoison(value)` -> Use **before** `await`. Fast, synchronous check. It identifies existing `PoisonedValue` objects, but it will not `await` a promise to see if it will reject with a `PoisonError`. Ideal for fast-path in Sync-First Hybrid pattern.
    -   `isPoisonError(err)` -> Use **in `catch` block**.
-   **Reference**: `docs/code/Error Handling Guide.md`, `docs/code/Poisoning - Implementation Principles.md`

#### Error Propagation (Dataflow Poisoning)

Cascada treats errors as data ("Poison") flowing through system.

*   **Skip & Propagate:** If operation receives Poison input, **does not execute**. Immediately returns new Poison combining input errors.
*   **Contamination:** Any variable/output that would've been modified by skipped operation/block automatically Poisoned.
*   **No Crash on Generation:** Script/template **only throws** if Poison reaches final **Output Handler** (e.g., `@data`, `@text`). Handle/repair error internally → script succeeds.
*   **Context Function Warning:** **DO NOT** pass Poison to context functions (e.g., logging). Function never executes. Use `is error` to check first.

**Propagation Logic by Type:**
*   **Expressions:** `1 + error` → `error`.
*   **Function Calls:** `myFunc(error)` → Function body skipped; returns `error`.
*   **Loops:** `for x in error` → Loop body skipped; all variables modified within poisoned.
*   **Conditionals:** `if error` → Both branches skipped; all variables modified within poisoned.
*   **Sequential (`!`):** `db!.fail()` → Subsequent `db!.op()` calls skipped, return error.

</details>

---

## Development & Testing Guide

Practical instructions for writing and testing code.

### Common Development Scenarios

#### Add New `@data` Method (e.g., `incrementBy`)

1.  **Locate API**: `src/environment/environment.js`.
2.  **Find `AsyncEnvironment.addDataMethods`**: Public API for adding methods.
3.  **Implement Logic**: Method receives `(target, ...args)`, returns new value. `target` is current value at path (could be `undefined`). `...args` are script arguments.
4.  **Add Method**: Add to `env.addDataMethods` call in test setup or user-facing API.
    ```javascript
    // In environment.js or a test setup file
    env.addDataMethods({
      incrementBy: (target, amount) => (target || 0) + amount
    });
    ```
5.  **Write Test**: Add `it.only(...)` block in relevant test file (e.g., `tests/script.js`) to verify method, including edge cases like `undefined` targets.

#### Fix Bug in Compiler Pass

1.  **Isolate Bug**: Write small, failing test using `it.only()`. Use simplest script demonstrating bug via `env.renderScriptString`.
2.  **Identify Compiler Pass**: Check `Key Files` reference. Bug likely in `src/compiler/compiler.js` (statements like `if`, `for`), `src/compiler/compiler-base.js` (expressions), or `src/compiler/compile-sequential.js` (`!` logic).
3.  **Trace Compilation**: Entry point is `Compiler.compile()`. Follow `compileNodeType` methods (e.g., `compileIf`, `compileFunCall`) to trace AST→JavaScript conversion.
4.  **Inspect Generated Code**: `compile` function returns generated JS string. Log this in test to see incorrect compiler output.
5.  **Modify & Re-run**: Modify compiler logic, re-run test with `npm run mocha`. Repeat until isolated test passes.
6.  **Remove `.only()`**: Run full test suite (`npm test`) to check regressions.

### Running Tests

-   **Quick Test (No Build)**: `npm run test:quick`
-   **Single File (Recommended)**: `npm run mocha:single -- tests/pasync/loop-phase1-two-pass.js --timeout 5000`
-   **Node Only (from source, with coverage)**: `npm run test:node`
-   **Browser Only (bundled from source)**: `npm run test:browser`
-   **Full Suite (build + precompile + Node + Browser)**: `npm test`
-   **Isolate Tests**: Use `.only()` on `it()` or `describe()` blocks. Standard workflow for focused development.

```javascript
describe.only('My New Feature', () => {
  it.only('should handle primary use case', async () => {
    // Your test. Only this runs.
  });
});
```

### Test Assertions (`expect.js`)

<details>
<summary><strong>Click to expand common assertions...</strong></summary>

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

</details>

### Advanced Testing Techniques

<details>
<summary><strong>Click to expand advanced testing examples...</strong></summary>

#### Using `StringLoader` for In-Memory Templates

Use `StringLoader` from `tests/util.js` for in-memory template tests:

```javascript
const { StringLoader } = require('./util');
const loader = new StringLoader();
const env = new AsyncEnvironment(loader);

loader.addTemplate('header.njk', '<h1>{{ title }}</h1>');
loader.addTemplate('main.njk', '{% include "header.njk" %}');

const result = await env.renderTemplate('main.njk', { title: 'Hello' });
```

#### Inspecting Compiled Code with `_compileSource()`

For debugging compiler issues, examine generated JavaScript:

```javascript
const { AsyncTemplate, AsyncScript } = require('../src/environment/environment');

const template = new AsyncTemplate('{% set x = asyncFunc() %}{{ x }}', env);
const source = template._compileSource();
expect(source).to.contain('await');

const script = new AsyncScript(':data\n@data.count = 5', env);
const compiledCode = script._compileSource();
expect(compiledCode).to.contain('output_command');
```

#### Transpiling Script to Template with `scriptTranspiler.scriptToTemplate()`

Verify script-to-template conversion:

```javascript
const scriptTranspiler = require('../src/script/script-transpiler');

const script = ':data\nvar user = getUser()\n@data.userName = user.name';
const template = scriptTranspiler.scriptToTemplate(script);

expect(template).to.contain('{% option focus="data" %}');
expect(template).to.contain('{% var user = getUser() %}');
expect(template).to.contain('output_command data.set(userName, user.name)');
```

</details>

---

## API & File Reference

### Main API (`AsyncEnvironment`)

```javascript
import { AsyncEnvironment } from 'cascada-engine';
const env = new AsyncEnvironment();

// Execute script and get focused data output
const result = await env.renderScriptString(script, context, {output: 'data'});

// Render template to text
const html = await env.renderTemplateString(template, context);

// Add custom logic
env.addGlobal('utils', myUtils);
env.addFilter('myFilter', myFilterFunc);
env.addDataMethods({ myMethod: myDataMethodFunc });
env.addCommandHandlerClass('myHandler', MyHandlerClass);
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

#### `AsyncScript`

Represents compiled async Cascada script. Automatically transpiles script syntax to template syntax.

```javascript
import { AsyncScript, AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();
const script = new AsyncScript(scriptSource, env, 'path/to/script.casc');

// Render returns Promise with script result (data object or string)
const result = await script.render(context);
```

**Key Methods:**
- `render(context)` - Returns `Promise` with script output (object/string based on output focus)
- `compile()` - Compiles script (called automatically on first render)
- `_compileSource()` - Returns generated JavaScript source code (debugging)

