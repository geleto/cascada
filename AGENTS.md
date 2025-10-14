# Cascada AI Agent Guide

This guide provides the necessary context for developing the Cascada engine. Your primary role is to assist in writing, refactoring, and testing code under supervision, adhering to the architecture and patterns outlined below.

## Table of Contents

- [Primary Agent Directives & Rules](#primary-agent-directives--rules)
- [Project Overview](#project-overview)
- [Language & Features](#language--features)
- [Implementation Architecture](#implementation-architecture)
- [Development & Testing Guide](#development--testing-guide)
- [API & File Reference](#api--file-reference)

## Primary Agent Directives & Rules

**This is the most important section. Adhere to these rules in all development tasks.**

### Your Core Task

Your goal is to write and modify TypeScript/JavaScript code for the `cascada-engine` package. This includes implementing new features, fixing bugs, and writing tests. All work must align with Cascada's core philosophy: **Parallel by Default, Sequential by Exception.**

### Golden Rules (DOs and DON'Ts)

**Follow these rules strictly. They are designed to align with Cascada's core architecture, prevent common bugs, and ensure high performance.**

#### **Language & Scripting (Writing Cascada Code)**

*   ✅ **DO:** Use the `!` marker on **static context paths** (e.g., `db.users!.create()`) to enforce strict execution order for operations with side effects.
*   ✅ **DO:** Use output focusing (`:data`, `:text`) in scripts and macros to ensure a clean, predictable return value.
*   ✅ **DO:** Use `var result = capture :data ...` to build complex intermediate objects. This leverages the power and guaranteed order of the `@data` assembly system for more than just the final output.

*   ❌ **DON'T:** Use the `!` marker on template variables (`{% set x = ... %}{{ x!.method() }}`) or dynamic lookups (`items[i]!.method()`). The compiler only supports this for static paths from the initial context.
*   ❌ **DON'T:** Manually collect results from parallel loops into temporary arrays (e.g., `var temp = []; for ... temp.push(...)`) if the final order is important. The `@data` system is specifically designed to handle this, guaranteeing ordered assembly despite concurrent execution.

#### **Testing**

*   ✅ **DO:** Use `it.only()` or `describe.only()` to isolate tests during development. This is the standard workflow and is critical for speed.
*   ✅ **DO:** Write tests for both the success path and the `PoisonError` failure path for every new async feature. A feature is not complete until its error handling is verified.

*   ❌ **DON'T:** Write tests that depend on the completion order of concurrent operations when verifying correctness. **Test the final, deterministic *output*, not the intermediate race.**
    *   **Exception:** This rule does not apply when you are *specifically testing the concurrency mechanism itself* (e.g., using mocks with delays to prove that `for` runs in parallel while `each` runs sequentially).

#### **Compiler Implementation (Modifying `src/compiler/*.js`)**

*   ✅ **DO:** Trust the runtime to handle synchronization. Your primary job in the compiler is to provide the correct `readVars` and `writeCounters` to `frame.pushAsyncBlock`.
*   ❌ **DON'T:** Write raw `(async () => { ... })()` blocks. Always use the `emit.asyncBlock*` helpers. They are essential for correct frame management, `astate` tracking, and error context propagation.
*   ❌ **DON'T:** Modify the legacy synchronous error handling model (the one using top-level `lineno`/`colno` variables). All new error handling work must target the async model (`errorContext` objects and per-block `try/catch`).

#### **Runtime & Performance**

*   ✅ **DO:** Prioritize the **"Sync-First Hybrid" pattern** to maximize performance. For any runtime function that might handle promises, structure it like this:
    1.  Create a main, **non-`async`** function (e.g., `memberLookupAsync`).
    2.  Inside it, handle the fast paths synchronously:
        *   Check for poison: `if (isPoison(value)) return value;`
        *   Check for simple literals (not promises/arrays): `if (!val || typeof val.then !== 'function') return processSync(val);`
    3.  Delegate all other complex cases (actual promises, arrays of promises) to a separate **`async`** helper function (e.g., `_memberLookupAsyncComplex`).
    *   **Reasoning:** This avoids creating a Promise and paying the async overhead for the 30-40% of cases that are synchronous, which is a major performance win.

*   ✅ **DO:** Check if a value is a promise (`if (val && typeof val.then === 'function')`) before attempting to `await` it. This is cheaper than a blind `await` on a value that might be a literal.

*   ❌ **DON'T:** Reflexively make runtime functions `async`. An `async` function *always* returns a `Promise`, which adds overhead. Only use the `async` keyword on the helper functions that actually need `await`, as described in the hybrid pattern above.
*   ❌ **DON'T:** Check `isPoison()` **AFTER** an `await`. It is architecturally impossible for `await somePromise` to return a `PoisonedValue`. Check for poison *before* awaiting, and catch `PoisonError` *after* awaiting.
*   ❌ **DON'T:** `return` a `PoisonedValue` from an `async` function. You **MUST** `throw new PoisonError(...)`. Only non-`async` (or sync-first hybrid) functions can return a `PoisonedValue` directly.
*   ❌ **DON'T:** Short-circuit error collection. Always await ALL promises and collect ALL errors before returning or throwing, adhering to the **"Never Miss Any Error"** principle.
*   ❌ **DON'T:** Use `instanceof` for poison detection. Always use the `isPoison()` and `isPoisonError()` helpers.
*   ❌ **DON'T:** Construct `TemplateError` directly in `catch` blocks. Always use the idempotent `runtime.handleError(e, ...)` function.

---

## Project Overview

**Cascada** is a parallel-first scripting & templating engine for JavaScript/TypeScript that fundamentally inverts the traditional programming model: **parallel by default, sequential by exception**. Based on Nunjucks, it provides both a scripting language and template syntax with automatic, implicit concurrency.

### Core Philosophy

**Think Sequentially. Execute Concurrently.**

Write code that looks synchronous, and Cascada's engine handles complex concurrent execution automatically. Any variable can be a promise under the hood—pass it into functions, use it in expressions, assign it—all without thinking about its async state.

### Key Differentiators

-   **Parallel by Default**: Independent operations run concurrently without special syntax.
-   **Data-Driven Flow**: Code runs when inputs are ready, eliminating race conditions by design.
-   **Transparent Async**: Promises/async functions work seamlessly; no `await` needed in templates/scripts.
-   **Ordered Output**: Parallel execution, but results are assembled in source-code order.
-   **Two Modes**: Script (data orchestration) + Template (text generation).

---

## Language & Features

<details>
<summary><strong>Click to expand Language & Features documentation...</strong></summary>

### Two Execution Modes

#### Cascada Script (Data-First)

-   Clean, delimiter-free syntax (`var`, `if`, `for`, no `{% %}`).
-   **Output Commands** (`@data`, `@text`) for declarative data assembly.
-   Focus on logic and orchestration (AI agents, data pipelines).
-   Returns structured data objects.

```javascript
// Example: AI orchestration
var plan = makePlan("Analyze competitor's feature")
for step in plan.steps
  var result = executeStep(step.instruction)
  @data.stepResults.push({step: step.title, result: result})
endfor
var summary = summarize(result.stepResults)
@data.summary = summary
```

#### Cascada Template (Text-First)

-   Familiar Nunjucks syntax (`{% %}`, `{{ }}`).
-   Template composition (extends, include, import).
-   Best for HTML, emails, LLM prompts.
-   Returns rendered text.

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

Independent operations run concurrently. Data dependencies are automatically respected.

```javascript
var user = getUser()          // Runs immediately
var posts = getPosts(user.id) // Waits for user
var footer = getFooter()      // Runs in parallel with getUser
```

#### 2. Sequential Execution Control (`!`)

Use the `!` marker for side effects that need strict ordering. **Crucially, this only works on static paths from context variables.**

```javascript
var account = getBankAccount()
account!.deposit(100)    // 1. Runs first.
account!.withdraw(50)    // 2. Waits for deposit to finish.
```

#### 3. Output Commands (`@` - Scripts Only)

Scripts use **Output Commands** to build results via a "Collect, Execute, Assemble" model.

-   `@data`: Build structured data (objects/arrays).
-   `@text`: Generate text output.
-   **Output focusing**: Use `:data` or `:text` at the top of a scope (script, macro, capture) to return just that specific output.

```javascript
:data  // Returns just the data object, not { data: {...}, text: "..." }

@data.user.name = "Alice"
@data.user.roles.push("editor")
@text("Processing complete")
```

#### 4. Macros & Reusable Components

Macros in scripts are powerful tools for creating reusable, data-producing components.

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

A resilient error handling system is under development.

</details>

---

## Implementation Architecture

<details>
<summary><strong>Click to expand detailed architecture notes...</strong></summary>

### Async Execution Model

-   **Core Principle**: Transparently handle promises as first-class values, resolving them only when needed.
-   **Mechanism**: Potentially async operations are wrapped in `async` IIFEs, allowing non-blocking execution. A runtime state manager (`astate`) tracks completion.
-   **Key Components**: `AsyncFrame`, `runtime.resolveAll`, `runtime.flattenBuffer`.
-   **Reference**: `docs/code/Async - Implementation.md`

### Variable Synchronization

**Goal:** To prevent race conditions and ensure sequential equivalence when concurrent blocks read from and write to the same outer-scope variables.

**Mechanism:** A compile-time analysis + runtime locking system.

1.  **Compile-Time Analysis:**
    *   The compiler statically analyzes each potential async block to determine which variables it might read (`readVars`) and write to (`writeCounts`).
    *   The `writeCounters` are a **conservative count** of all *potential* writes, including those in conditional branches that may not be executed.

2.  **Runtime Locking (`pushAsyncBlock`):**
    *   When an async block starts, its frame is initialized.
    *   **Snapshots:** Variables needed for *reading* are snapshotted from the parent frame, capturing their state at the moment the block was initiated.
    *   **Promisification (Locking):** Variables identified for *writing* are **promisified** in the parent frame. Their value is temporarily replaced with a `Promise`, which acts as a **lock**, forcing other operations to wait for it.

3.  **Runtime Unlocking (Write Counting):**
    *   Writes inside the async block update a local copy of the variable and decrement the block's internal `writeCounter`.
    *   When a block's `writeCounter` for a variable hits zero (meaning all its potential writes are accounted for), it resolves the parent's **lock promise** with the final, correct value. This "unlocks" the variable for other parts of the script to use.

-   **Key Functions**: `frame.pushAsyncBlock`, `frame._promisifyParentVariables`, `frame._countdownAndResolveAsyncWrites`.

### Sequential Operations (`!`)

-   **Mechanism**: Uses **Sequence Keys** (e.g., `!account!deposit`) which are treated like special variables. The same promise-locking mechanism used for variables is applied to these keys.
-   **Compiler Pass**: `_declareSequentialLocks` pass identifies all `!` markers to register the keys.
-   **Runtime Helpers**: `runtime.sequencedCallWrap` and `runtime.sequencedMemberLookupAsync` acquire and release the lock.
-   **Reference**: `docs/code/Sequential Operations - Execution.md`

### Error Handling (Poison System)

-   **Core Principle**: "Never Miss Any Error." Await all promises and collect all errors before throwing.
-   **`PoisonedValue`**: A *thenable* object that carries an `.errors[]` array. It can be passed around synchronously.
-   **`PoisonError`**: The `Error` that is *thrown* when a `PoisonedValue` is awaited.
-   **Detection**:
    -   `isPoison(value)` -> Use **before** `await`.
    -   `isPoisonError(err)` -> Use **in a `catch` block**.
-   **Reference**: `docs/code/Error Handling Guide.md` and `docs/code/Poisoning - Implementation Principles.md`

</details>

---

## Development & Testing Guide

This section provides practical instructions for writing and testing code.

### Common Development Scenarios

#### How to Add a New `@data` Method (e.g., `incrementBy`)

1.  **Locate the API**: Go to `src/environment.js`.
2.  **Find `AsyncEnvironment.addDataMethods`**: This is the public API for adding methods.
3.  **Implement the Logic**: The method receives `(target, ...args)` and should return the new value.
    -   `target` is the current value at the path (e.g., `data.counter`). It could be `undefined`.
    -   `...args` are the arguments from the script (e.g., `10` from `incrementBy(10)`).
4.  **Add the Method**: Add your new method to the `env.addDataMethods` call in the testing setup or user-facing API.
    ```javascript
    // In environment.js or a test setup file
    env.addDataMethods({
      incrementBy: (target, amount) => (target || 0) + amount
    });
    ```
5.  **Write a Test**: Add a new `it.only(...)` block in a relevant test file (e.g., `tests/script.js`) to verify the new method works correctly, including edge cases like `undefined` targets.

#### How to Fix a Bug in a Compiler Pass

1.  **Isolate the Bug**: Write a small, failing test case using `it.only()`. The test should use `env.renderScriptString` with the simplest possible script that demonstrates the bug.
2.  **Identify the Compiler Pass**: Look at the `Key Files` reference below. The bug is likely in `src/compiler/compiler.js` (for statements like `if`, `for`), `src/compiler/compiler-base.js` (for expressions), or `src/compiler/compile-sequential.js` (for `!` logic).
3.  **Trace the Compilation**: The entry point is `Compiler.compile()`. Follow the `compileNodeType` methods (e.g., `compileIf`, `compileFunCall`) to trace how the AST node is converted to JavaScript.
4.  **Inspect Generated Code**: The `compile` function returns the generated JS string. You can log this string in your test to see the incorrect output from the compiler.
5.  **Modify and Re-run**: Modify the compiler logic and re-run the test with `npm run mocha`. Repeat until the isolated test passes.
6.  **Remove `.only()`** and run the full test suite (`npm test`) to check for regressions.

### Running Tests

-   **Quick Test (No Build)**: `npm run mocha`
-   **Run a single file (Recommended)**: `npm run mocha -- tests/pasync/loop-phase1-two-pass.js`
-   **Run all async tests**: `npm run pasync`
-   **Node Only**: `npm run test:node`
-   **Full Suite (Node + Browser)**: `npm test`
-   **Isolate Specific Tests**: Use `.only()` on `it()` or `describe()` blocks in the test files. This is the standard workflow for focused development.

```javascript
// In a test file like tests/script.js
describe.only('My New Feature', () => {
  it.only('should handle the primary use case', async () => {
    // Your test here. Only this test will run.
  });
});
```

### Test Assertions (`expect.js`)

<details>
<summary><strong>Click to expand common assertions...</strong></summary>

The test suite uses **expect.js**.

```javascript
// Equality
expect(value).to.be(expected);           // Strict equality (===)
expect(value).to.eql(expected);          // Deep equality (objects/arrays)

// Truthiness & Type
expect(value).to.be.ok();                // Truthy
expect(value).to.be.a('string');         // Type check
expect(value).to.be.an(Array);           // instanceof check

// Collections
expect(arr).to.have.length(3);
expect(arr).to.contain(item);
expect(obj).to.have.property('key');

// Errors
expect(fn).to.throwException(/message/);

// Async Error Testing
it('should throw an error', async () => {
  try {
    await env.renderScriptString(badScript);
    expect().fail('Should have thrown'); // Fail if it doesn't throw
  } catch (err) {
    expect(isPoisonError(err)).to.be(true); // Check for PoisonError
    expect(err.errors[0].message).to.contain('expected error');
  }
});
```

</details>

### Advanced Testing Techniques

<details>
<summary><strong>Click to expand advanced testing examples...</strong></summary>

#### Using `StringLoader` for In-Memory Templates

Use `StringLoader` from `tests/util.js` to manage templates in memory for tests:

```javascript
const { StringLoader } = require('./util');
const loader = new StringLoader();
const env = new AsyncEnvironment(loader);

loader.addTemplate('header.njk', '<h1>{{ title }}</h1>');
loader.addTemplate('main.njk', '{% include "header.njk" %}');

const result = await env.renderTemplate('main.njk', { title: 'Hello' });
```

#### Inspecting Compiled Code with `_compileSource()`

For debugging compiler issues, use `_compileSource()` to examine generated JavaScript:

```javascript
const { AsyncTemplate, AsyncScript } = require('../src/environment');

const template = new AsyncTemplate('{% set x = asyncFunc() %}{{ x }}', env);
const source = template._compileSource();
expect(source).to.contain('await');

const script = new AsyncScript(':data\n@data.count = 5', env);
const compiledCode = script._compileSource();
expect(compiledCode).to.contain('output_command');
```

#### Transpiling Script to Template with `scriptTranspiler.scriptToTemplate()`

Use `scriptTranspiler.scriptToTemplate()` to verify script-to-template conversion:

```javascript
const scriptTranspiler = require('../src/script-transpiler');

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

// Execute a script and get focused data output
const result = await env.renderScriptString(script, context, {output: 'data'});

// Render a template to text
const html = await env.renderTemplateString(template, context);

// Add custom logic
env.addGlobal('utils', myUtils);
env.addFilter('myFilter', myFilterFunc);
env.addDataMethods({ myMethod: myDataMethodFunc });
env.addCommandHandlerClass('myHandler', MyHandlerClass);
```

### Compiled Template/Script Classes

#### `AsyncTemplate`

Represents a compiled async Nunjucks template. Created internally by `AsyncEnvironment` or can be instantiated directly.

```javascript
import { AsyncTemplate, AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();
const tmpl = new AsyncTemplate(templateSource, env, 'path/to/template.njk');

// Render returns a Promise
const html = await tmpl.render(context);
```

**Key Methods:**
- `render(context)` - Returns a `Promise<string>` with the rendered output
- `compile()` - Compiles the template (called automatically on first render)
- `_compileSource()` - Returns the generated JavaScript source code (useful for debugging)

#### `AsyncScript`

Represents a compiled async Cascada script. Automatically transpiles script syntax to template syntax.

```javascript
import { AsyncScript, AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();
const script = new AsyncScript(scriptSource, env, 'path/to/script.casc');

// Render returns a Promise with the script result (data object or string)
const result = await script.render(context);
```

**Key Methods:**
- `render(context)` - Returns a `Promise` with the script output (object/string based on output focus)
- `compile()` - Compiles the script (called automatically on first render)
- `_compileSource()` - Returns the generated JavaScript source code (useful for debugging)

### Key Files and Directories

-   `src/environment.js`: **User-facing API & Test Setup**. This is the entry point for users. Tests will instantiate `AsyncEnvironment` from here. Contains `AsyncTemplate` and `AsyncScript` classes.
-   `src/runtime.js`: **Runtime helpers.** Contains `resolveAll`, `flattenBuffer`, `isPoison`, `PoisonError`, and all functions called by the compiled code.
-   `src/compiler/compiler.js`: **Main compiler.** Handles statements (`if`, `for`, `block`, etc.) and orchestrates code generation.
-   `src/compiler/compiler-base.js`: **Expression compiler.** Handles expressions (`+`, `*`, `myVar.prop`, `myFunc()`).
-   `src/compiler/compile-async.js`: **Async analysis.** Contains `propagateIsAsync` and logic for calculating `readVars` and `writeCounters`.
-   `src/compiler/compile-sequential.js`: **Sequential (`!`) analysis.** Logic for identifying and managing sequential operation paths.
-   `src/data-handler.js`: **`@data` handler implementation.** The logic for all `@data` commands resides here.
-   `src/script-*.js`: **Script-specific features,** including the script-to-template transpiler.
-   `tests/`: **Test suites.**
    -   `tests/pasync/`: Tests for advanced asynchronous execution and parallelism.
    -   `tests/poison/`: Tests for the error handling (Poison) system.
    -   `tests/util.js`: Test utilities including `StringLoader` class.

### Documentation

-   **User Docs**: `docs/cascada/` (e.g., `script.md`)
-   **Implementation Guides**: `docs/code/` (e.g., `Async - Implementation.md`)

---
**Package**: `cascada-engine`
**Repository**: https://github.com/geleto/cascada