# Cascada Testing Guide

Detailed reference for writing and debugging tests. See `AGENTS.md` for the short version of test commands and task pointers.

---

## Development Scenarios

### Add a New Data-Channel Method

1.  **Locate the right file**: Built-in methods live in `src/script/default-data-methods.js`. Custom/user methods are registered via `AsyncEnvironment.addDataMethods` in `src/environment/async-environment.js`.
2.  **Understand runtime application**: `src/runtime/channels/data.js` applies `DataCommand` instances and dispatches custom methods.
3.  **Implement**: Method receives `(target, ...args)` and returns the new value. `target` is the current value at the path (may be `undefined`); `...args` are the script arguments.
4.  **Register** (built-in: add to `default-data-methods.js`; custom: use `env.addDataMethods` in test setup):
    ```javascript
    env.addDataMethods({
      incrementBy: (target, amount) => (target || 0) + amount
    });
    ```
5.  **Test**: Add an isolated test in `tests/pasync/output-data-methods.js`. Include edge cases like `undefined` targets.

### Fix a Bug in a Compiler Pass

1.  **Isolate**: Write a small failing test with `it.only()`. Use the simplest script that demonstrates the bug via `env.renderScriptString`.
2.  **Identify the pass**: Bug likely lives in:
    -   `compiler-async.js` or `compiler-sync.js` — statements
    -   `compiler-base-async.js` or `compiler-base-sync.js` — expressions
    -   `analysis.js` — channel metadata
    -   `buffer.js` / `emit.js` — command-buffer wiring
    -   `sequential.js` — `!` logic
3.  **Trace**: Entry point is `Compiler.compile()`. Follow `compileNodeType` methods (e.g., `compileIf`, `compileFunCall`) to trace the AST → JavaScript conversion.
4.  **Inspect generated code**: Log `script._compileSource()` in the test to see the incorrect compiler output directly.
5.  **Iterate**: Modify compiler logic, re-run with `npm run mocha -- tests/path/to/file.js`. Repeat until the isolated test passes.
6.  **Widen**: Remove `.only()`, run `npm test` to check for regressions.

---

## Test Assertions (`expect.js`)

Tests use **expect.js**.

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

// Async error testing
it('should throw on poison', async () => {
  try {
    await env.renderScriptString(badScript);
    expect().fail('Should have thrown');
  } catch (err) {
    expect(isPoisonError(err)).to.be(true);
    expect(err.errors[0].message).to.contain('expected error');
  }
});
```

---

## Advanced Testing Techniques

### Using `StringLoader` for In-Memory Templates

Use `StringLoader` from `tests/util.js` when a test needs named templates that reference each other:

```javascript
import {StringLoader} from './util.js';
import {AsyncEnvironment} from '../src/environment/environment.js';

const loader = new StringLoader();
const env = new AsyncEnvironment(loader);

loader.addTemplate('header.njk', '<h1>{{ title }}</h1>');
loader.addTemplate('main.njk', '{% include "header.njk" %}');

const result = await env.renderTemplate('main.njk', { title: 'Hello' });
```

### Inspecting Compiled Code with `_compileSource()`

Use `_compileSource()` to examine the JavaScript the compiler emits. Essential for diagnosing incorrect compiler output.

For script syntax or transpiler bugs, inspect both the transpiler output and the compiled source:

```javascript
import {AsyncEnvironment, AsyncTemplate, Script} from '../src/environment/environment.js';
import {transpiler as scriptTranspiler} from '../src/script/script-transpiler.js';

const env = new AsyncEnvironment();

// Template
const template = new AsyncTemplate('{% set x = asyncFunc() %}{{ x }}', env);
const templateSource = template._compileSource();
expect(templateSource).to.contain('await');

// Script
const script = new Script('data result\nresult.count = 5\nreturn result.snapshot()', env);
const scriptSource = script._compileSource();
expect(scriptSource).to.contain('DataCommand');
```

For ordinary execution tests, prefer `env.renderScriptString(...)` over `script.render(...)` directly.

### Inspecting Transpiler Output with `scriptTranspiler.scriptToTemplate()`

Verify the script-to-template conversion step independently:

```javascript
import {transpiler as scriptTranspiler} from '../src/script/script-transpiler.js';

const script = 'data result\nvar user = getUser()\nresult.userName = user.name\nreturn result.snapshot()';
const template = scriptTranspiler.scriptToTemplate(script);

expect(template).to.contain('{%- var user = getUser() -%}');
expect(template).to.contain('command result.set(["userName"], user.name)');
```

---

## Compiled-Class API

### `AsyncTemplate`

Represents a compiled async Nunjucks template. Usually created internally by `AsyncEnvironment`; instantiate directly only for debugging or API testing.

```javascript
import { AsyncTemplate, AsyncEnvironment } from '../src/environment/environment.js';

const env = new AsyncEnvironment();
const tmpl = new AsyncTemplate(templateSource, env, 'path/to/template.njk');

const html = await tmpl.render(context);      // Promise<string>
const source = tmpl._compileSource();         // generated JS (debugging)
```

### `Script`

Represents a compiled async Cascada script. Automatically transpiles script syntax to template syntax before compilation.

```javascript
import { Script, AsyncEnvironment } from '../src/environment/environment.js';

const env = new AsyncEnvironment();
const script = new Script(scriptSource, env, 'path/to/script.casc');

const source = script._compileSource();       // generated JS (debugging)
const result = await env.renderScriptString(scriptSource, context);  // preferred for tests
```

**Key Methods:**
- `render(context)` — Lower-level render path; prefer `env.renderScriptString(...)` in normal tests.
- `compile()` — Compiles the script (called automatically on first render).
- `_compileSource()` — Returns generated JavaScript source code for debugging.
