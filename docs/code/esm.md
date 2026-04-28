# ESM Migration Plan

## Goal

Cascada should be an ESM-only package. The source tree, published Node entry points, browser entry points, tests, and build scripts should use native `import`/`export` instead of CommonJS `require`/`module.exports`.

Cascada is not released yet, so this migration does not need to preserve CommonJS compatibility.

## Decisions

- Drop CommonJS package support.
- Drop generated `dist/cjs`.
- Drop the `require` export condition from `package.json`.
- Drop browser UMD bundles.
- Keep browser support through native browser ESM.
- Support only modern browsers with native ESM support.
- Keep both Node and browser test lanes.
- Keep Istanbul-format coverage for both Node and browser.
- Use Istanbul only in test commands and test servers, never in package builds or published files.
- Do not use lazy `require` to avoid circular dependencies. Fix circular dependencies directly.
- Avoid package bundling for the Node ESM module. Ship normal ESM files with module boundaries.
- Require a modern Node version for development, tests, and published Node usage.
- Do not use `NODE_PATH`; Node's ESM resolver ignores it.

## Runtime Targets

Node support should target Node `>=22`.

Reasons:

- native ESM behavior is stable and current,
- `import.meta.resolve(...)` is available without experimental flags,
- modern Mocha and `c8` ESM workflows are well supported,
- this lets the migration avoid compatibility code for old Node releases.

Browser support targets current evergreen browsers with native ESM and top-level `await` in modules. Cascada should not transpile ESM or syntax for old browsers.

## Package Shape

The package should use native ESM:

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/types/index.d.ts",
  "engines": {
    "node": ">=22"
  },
  "exports": {
    ".": {
      "types": "./dist/types/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

If browser and Node surfaces diverge, prefer explicit environment entries:

```json
{
  "exports": {
    ".": {
      "types": "./dist/types/index.d.ts",
      "import": "./dist/index.js"
    },
    "./browser": {
      "types": "./dist/types/browser.d.ts",
      "import": "./dist/browser/index.js"
    },
    "./node": {
      "types": "./dist/types/node.d.ts",
      "import": "./dist/node/index.js"
    }
  }
}
```

`dist/browser/index.js` should be browser-safe ESM, not a bundled UMD artifact.

## Source Rules

- Use `import` and `export` in all runtime source files.
- Use explicit relative file extensions, for example `import lib from './lib.js'`.
- Do not introduce new `require` calls.
- Do not use lazy imports to hide circular dependencies.
- Use dynamic `import()` only when the module boundary is genuinely asynchronous or optional by design.
- Keep Node-only APIs behind Node-specific modules or entry points.
- Keep browser-safe APIs free of top-level imports of `fs`, `path`, `os`, `stream`, `chokidar`, or other Node-only modules.

## CommonJS Globals

ESM files do not have CommonJS globals.

Replace `__dirname` and `__filename` with URL-based helpers:

```js
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

Prefer local names such as `moduleDir` or `projectRoot` in newly touched code instead of recreating `__dirname` by habit.

Replace `require.resolve(...)` with one of:

- `import.meta.resolve(...)` for package/module resolution,
- URL construction for relative files,
- or a dedicated resolver API when the caller needs custom package search paths.

Replace `require.main === module` with an ESM helper based on `process.argv[1]` and `import.meta.url`:

```js
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function isMainModule(metaUrl) {
  return process.argv[1] && fileURLToPath(metaUrl) === path.resolve(process.argv[1]);
}
```

Scripts that currently use `__dirname`, `__filename`, `require.main`, or `require.resolve` must be converted before `"type": "module"` is enabled. Do not add temporary CommonJS script shims for the package migration.

## Circular Dependencies

CommonJS often hides dependency cycles that ESM exposes. During migration, treat cycle failures as architecture bugs.

Preferred fixes:

- Move shared constants or helpers into a lower-level module.
- Split mixed modules into smaller dependency layers.
- Pass collaborators as parameters where that matches the design.
- Keep registration/bootstrap code separate from core definitions.

Avoid:

- Lazy `require`.
- Dynamic `import()` solely to break a cycle.
- Re-export barrels that create broad accidental cycles.

Add an automated cycle check during the migration:

```json
{
  "scripts": {
    "check:cycles": "madge --extensions js --circular src"
  }
}
```

Run it in CI once the source tree is ESM. Runtime failures are too late and too sporadic for this migration.

## Build

The Node ESM package should not be bundled. Build output should preserve module boundaries.

Expected build steps:

- Clean `dist`.
- Lint source and tests.
- Copy ESM source to `dist` while preserving native `import`/`export`.
- Copy type declarations to `dist/types`.
- Copy docs needed in the package.
- Do not produce `dist/cjs`.
- Do not produce `dist/browser/*.js` UMD bundles.
- Do not transpile browser ESM for older browsers.

Babel should not be part of the package build. The supported Node and browser targets must run the published ESM directly.

## Script Transition

When `"type": "module"` is added, every `.js` file becomes ESM. Any `.js` script that still uses `require`, `module.exports`, `__dirname`, or `require.main` will break immediately.

Preferred path:

1. Convert scripts to ESM before enabling `"type": "module"`.
2. Avoid `.cjs` migration exceptions unless a file intentionally tests CommonJS interop.
3. Track and remove any temporary `.cjs` exception before the migration is considered complete.

Exit criterion: no `.cjs` scripts remain unless they are intentionally testing CommonJS interop. Since Cascada is dropping CommonJS support, the expected final count is zero.

## Browser Support

Browser support targets modern browsers only. Cascada should not transpile ESM or modern JavaScript syntax for older browsers.

Browser support should be validated through native browser ESM:

```html
<script type="module">
  import { AsyncEnvironment } from "/src/index.js";

  const env = new AsyncEnvironment();
  const result = await env.renderScriptString("@data.ok = true\nreturn data.snapshot()");
  console.log(result);
</script>
```

The browser test server should use import maps for bare browser imports. Do not use Webpack/Rollup or server-side module bundling to make browser tests work.

Any dependency that is not browser-native ESM must be handled through a browser ESM wrapper or replaced with an ESM-compatible dependency. Test-only globals such as Mocha, `expect.js`, and `he` may be loaded as scripts or through explicit browser shims, but Cascada runtime modules should remain native ESM.

The browser test lane should test the browser ESM surface directly, not a generated browser bundle.

## Testing

Keep both test lanes:

- Node tests run under Node ESM.
- Browser tests run in Playwright using native `<script type="module">`.

Node tests should import source or built ESM directly. Browser tests should load ESM through the local test server.

The old browser bundle tests should be replaced with browser ESM tests. The goal is no longer "does the UMD bundle work"; the goal is "does Cascada's browser ESM surface work in a real browser."

## Current Test And Coverage Flow

The current CommonJS/browser-bundle setup has these npm commands:

- `npm run mocha`: quick Node Mocha run without coverage.
- `npm run test:quick`: alias for `npm run mocha`.
- `npm run test:node`: Node Mocha run with c8 coverage through `scripts/run-node-tests.js`.
- `npm run test:pasync`: focused async/poison Node coverage run.
- `npm run test:browser`: starts the browser test server, then runs Playwright browser tests against native ESM modules.
- `npm test`: full flow through `scripts/run-all-tests.js`.

Current `npm test` flow:

1. Runs `npm run build`.
2. Runs `node scripts/runprecompile.js`.
3. Runs `npm run test:browser`.
4. Runs `npm run test:node`.
5. Runs `node scripts/report-results.js`.
6. Exits non-zero if either browser or Node tests fail.

Current Node coverage:

- Uses `c8` with V8 native ESM coverage.
- Uses Mocha without Babel/register hooks.
- Writes Node coverage to `coverage/coverage-final.json`.
- Writes Node test stats to `coverage/node-tests-stats.json` through `scripts/run-node-tests.js`.

Current browser coverage:

- `scripts/run-browser-tests.js` starts the local test server and opens `tests/browser/slim.html` and `tests/browser/index.html` in Playwright.
- Browser pages import native ESM modules from `src`.
- Browser pages use import maps for test-only and browser-shimmed bare imports.
- The test server applies `babel-plugin-istanbul` only to served `src/**/*.js` modules and preserves native `import`/`export`.
- Each page runs browser Mocha and sends `{ stats, coverage: window.__coverage__ }` back through `window.sendTestResults`.
- Browser coverage is written to:
  - `coverage/browser-std.json`
  - `coverage/browser-slim.json`
- Browser stats are written to `coverage/browser-tests-stats.json`.
- Browser coverage is merged with `istanbul-lib-coverage`.
- `istanbul-lib-report` and `istanbul-reports` write text/html/lcov reports from merged coverage.

Current combined reporting:

- `scripts/report-results.js` reads:
  - `coverage/browser-std.json`
  - `coverage/browser-slim.json`
  - `coverage/coverage-final.json`
  - `coverage/browser-tests-stats.json`
  - `coverage/node-tests-stats.json`
- It merges coverage maps with `istanbul-lib-coverage`.
- It writes text/html/lcov reports through `istanbul-lib-report` and `istanbul-reports`.
- It prints combined passing/pending/failing totals.

The ESM migration should preserve the command-level behavior: quick Node tests, Node coverage, browser tests, full build/test/precompile flow, combined coverage reports, combined test stats, and non-zero exit behavior.

## Target Test And Coverage Flow

The new setup should keep the same user-facing npm workflow while replacing the internals.

Target commands:

```json
{
  "scripts": {
    "mocha": "cross-env NODE_ENV=test mocha --check-leaks -R spec \"tests/*.js\" \"tests/pasync/**/*.js\" \"tests/poison/**/*.js\"",
    "test:quick": "npm run mocha",
    "test:node": "cross-env NODE_ENV=test c8 --include \"src/**/*.js\" --reporter=html --reporter=text --reporter=json node scripts/run-node-tests.js",
    "test:pasync": "cross-env NODE_ENV=test c8 --include \"src/**/*.js\" --reporter=html --reporter=text node scripts/run-node-tests.js tests/pasync tests/poison",
    "test:browser": "cross-env NODE_ENV=test node scripts/run-browser-tests.js",
    "check:cycles": "madge --extensions js --circular src",
    "test": "node scripts/run-all-tests.js"
  }
}
```

Notes:

- Remove `--require @babel/register`.
- Remove `NODE_PATH`; it is ignored by Node's ESM resolver.
- Keep Node test stats in `scripts/run-node-tests.js` so the test lane stays native ESM end to end.
- Keep `coverage/node-tests-stats.json`.
- Keep `coverage/browser-tests-stats.json`.
- Keep `coverage/coverage-final.json` as the Node JSON coverage report if using `c8 --reporter=json`.
- Keep `scripts/report-results.js`, converted to ESM, as the combined coverage/stat reporter.
- Keep `cross-env`; it is a process wrapper and is unaffected by whether project scripts are ESM.

### Test Package Fixtures

The current tests use `NODE_PATH=./tests/test-node-pkgs` so `dummy-pkg` can be resolved by `NodeResolveLoader` tests. This will not work under ESM.

Replace that setup with a real local package dependency:

```json
{
  "devDependencies": {
    "dummy-pkg": "file:tests/test-node-pkgs/dummy-pkg"
  }
}
```

After `npm install`, Node resolves `dummy-pkg` from `node_modules` normally in both CommonJS and ESM. Tests should stop mutating `Module.globalPaths`, `module.paths`, and `process.env.NODE_PATH`.

For `NodeResolveLoader`, use `import.meta.resolve(name)` for default package resolution, then convert the returned `file:` URL with `fileURLToPath(...)` before reading from disk. If custom search roots are still needed, add an explicit loader option rather than relying on process-global resolver mutation.

Target full test flow should remain:

1. Run `npm run build`.
2. Run `node scripts/runprecompile.js` if precompiled-template fixtures are still needed.
3. Run `npm run test:browser`.
4. Run `npm run test:node`.
5. Run `node scripts/report-results.js`.
6. Exit non-zero if either browser or Node tests fail.

The order can stay browser-first then Node-first because the final reporter is independent of execution order. `scripts/run-browser-tests.js` writes browser stats and coverage only; `scripts/report-results.js` performs the final merge after both lanes complete.

## Target Browser Test Runner

The browser runner should keep the current Playwright + browser Mocha model:

- start a local test server,
- open one or more browser test HTML pages,
- expose `sendTestResults`,
- run `mocha.run()` inside the page,
- collect `runner.stats`,
- collect `window.__coverage__`,
- write browser stats and coverage files,
- close browser and server,
- exit non-zero on browser failures.

The browser runner no longer builds or loads browser bundles.

Playwright remains the supported browser automation layer. The migration removes Webpack/UMD artifacts, not real-browser testing.

Old-to-new page mapping:

```text
tests/browser/index.html
  old: standard UMD browser bundle
  new: tests/browser/esm.html using native browser ESM

tests/browser/slim.html
  old: slim UMD bundle for precompiled templates
  new: tests/browser/precompiled.html using native browser ESM precompiled runtime
```

The new runner should still open each page in Chromium through Playwright. Additional browsers can be added later, but Chromium should remain the baseline because it keeps the current test infrastructure stable.

The command should remain:

```json
{
  "scripts": {
    "test:browser": "cross-env NODE_ENV=test node scripts/run-browser-tests.js"
  }
}
```

The implementation of `scripts/run-browser-tests.js` changes, but its responsibility and command name stay the same.

Suggested browser coverage files:

- `coverage/browser-esm.json` for the main browser ESM test page.
- `coverage/browser-precompiled.json` for the precompiled-template browser mode.

The old `slim` bundle should become a native ESM precompiled-template lane. Keep the capability, but name it after what it validates rather than the removed bundle artifact.

That lane should verify:

- precompiled templates can be generated for browser use,
- the browser runtime can execute precompiled templates without loading the full compiler/parser path,
- async rendering still works when templates are precompiled,
- coverage and stats are collected separately from the main browser ESM lane.

## Current Slim Path

The old `slim` path was implemented as a Webpack build mode, not as a separate source architecture.

Previously, `scripts/bundle.js` changed the browser bundle in two important ways when `opts.slim` was enabled:

- imports matching `nodes`, `lexer`, `parser`, `precompile`, `transformer`, or `compiler` are replaced with `node-libs-browser/mock/empty`;
- imports of `loader/loaders.js` are rewritten to `loader/precompiled-loader.js` instead of `loader/web-loaders.js`.

The generated artifact was `tests/browser/nunjucks-slim.min.js` in test mode, or `dist/browser/nunjucks-slim*.js` in package build mode. It was advertised as "only works with precompiled templates".

The browser test page `tests/browser/slim.html` loads:

- the full bundle first as `window.nunjucksFull`,
- the slim bundle as `window.nunjucks`,
- `tests/browser/precompiled-templates.js`,
- then a subset of the browser tests.

The full bundle is still used by the slim test helper to call `precompileString(...)` dynamically during tests. The slim runtime then loads the generated template through `PrecompiledLoader`.

`PrecompiledLoader` itself is simple. It maps a template name to a source object:

```js
{
  src: {
    type: 'code',
    obj: precompiledTemplateObject
  },
  path: name
}
```

`Template._compile()` already understands this shape. If `tmplProps` exists, it skips the compiler and uses the compiled object directly:

```js
if (this.tmplProps) {
  props = this.tmplProps;
} else {
  const source = this._compileSource();
  const func = new Function('runtime', source);
  props = func(globalRuntime);
}
```

So the real precompiled runtime dependency is not the compiler. It is:

- environment setup,
- loader dispatch,
- `PrecompiledLoader`,
- `Template` / `AsyncTemplate` runtime execution,
- runtime helpers,
- filters/tests/globals needed by the template.

The current slim bundle hides compiler imports by replacing them with empty modules. That works because precompiled templates never call `_compileSource()`. In ESM this should be made explicit by module boundaries rather than by bundle rewrites.

## Async Coverage Gap In Current Slim Path

The current slim browser page appears to test the precompiled path mostly through legacy sync-oriented tests.

`tests/browser/index.html` loads async suites such as:

- `tests/pasync/calls.js`
- `tests/pasync/conditional.js`
- `tests/pasync/custom.js`
- `tests/pasync/expressions.js`
- `tests/pasync/loader.js`
- `tests/pasync/loops.js`
- `tests/pasync/macros.js`
- `tests/pasync/race.js`
- `tests/pasync/setblock.js`
- `tests/pasync/structures.js`
- `tests/pasync/variables.js`

`tests/browser/slim.html` does not load those `pasync` suites. It loads the traditional compiler/runtime/filter/global/Jinja tests against precompiled templates.

The ESM migration should add explicit async precompiled tests. Do not assume the old slim path already covers async precompiled rendering.

## ESM Precompiled Runtime

Replace the slim bundle with a compiler-free ESM runtime entry.

Suggested entries:

```text
src/index.js                  full ESM entry: runtime + compiler/precompile APIs
src/browser/index.js          browser full ESM entry
src/precompiled/index.js      environment/runtime + PrecompiledLoader, no compiler
src/browser/precompiled.js    browser precompiled ESM entry
src/node/precompiled.js       optional Node precompiled ESM entry
```

The precompiled entries should not import:

- `src/compiler/**`
- `src/parser.js`
- `src/lexer.js`
- `src/nodes.js`
- `src/transformer.js`
- `src/precompile.js`
- Node-only loaders

To make this real, split compile-capable classes from runtime-capable classes. The current `src/environment/template.js` imports the compiler at module top level. In ESM that would pull the compiler into precompiled-only entries even if `_compileSource()` is never called.

Preferred shape:

```text
src/environment/template-runtime.js
  BaseTemplate runtime behavior for { type: 'code', obj }
  render/getExported/context/block binding
  no compiler imports

src/environment/template.js
  Template and AsyncTemplate compile-capable classes
  imports compiler
  extends or composes template-runtime

src/environment/precompiled-template.js
  PrecompiledTemplate and AsyncPrecompiledTemplate
  no _compileSource()
  throws a clear error if constructed with string source
```

Then precompiled environments can use only precompiled template classes.

This avoids the old Webpack trick where compiler modules are present as empty mocks.

## ESM Precompile Output

The legacy default wrapper writes browser globals:

```js
window.nunjucksPrecompiled = window.nunjucksPrecompiled || {};
window.nunjucksPrecompiled[name] = compiledTemplateObject;
```

That is now a legacy/browser-global wrapper only. The ESM wrapper exports the compiled template map:

```js
export default {
  "item.njk": (function() {
    const runtime = null;
    // compiled template object returned here
  })()
};
```

More directly, because compiled templates currently return an object from generated JavaScript, the wrapper can emit:

```js
const templates = {};

templates["item.njk"] = (function() {
  /* compiled template source */
})();

export default templates;
```

The browser precompiled test page can then use:

```js
import { AsyncEnvironment } from '../../src/browser/precompiled.js';
import { PrecompiledLoader } from '../../src/loader/precompiled-loader.js';
import templates from './precompiled-templates.js';

const env = new AsyncEnvironment(new PrecompiledLoader(templates));
const result = await env.renderTemplate('item.njk', context);
```

Use `.js` for generated ESM fixtures because the package has `"type": "module"`. Reserve `.mjs` only for files that must remain ESM outside the package boundary.

Done for the current browser precompiled fixture:

- `src/precompile-esm.js` emits `export default templates`.
- `precompile(..., { format: 'esm' })` selects the ESM wrapper.
- `bin/precompile --format esm` exposes the wrapper from the CLI.
- `tests/browser/precompiled-templates.js` is generated as a native ESM module.

The slim browser harness now imports the precompiled map as ESM and passes it through an explicit `PrecompiledLoader`. The native ESM browser test path no longer depends on `window.nunjucksPrecompiled`.

## Node Precompiled Lane

The precompiled runtime can and should be tested in Node too.

Precompiled templates are not browser-only in the architecture. `PrecompiledLoader` is already available from `node-loaders.js`, and `Template._compile()` already accepts `{ type: 'code', obj }` in Node.

Add Node tests that:

- precompile a template to an in-memory object using an ESM wrapper,
- load it through `PrecompiledLoader`,
- render it with `AsyncEnvironment`,
- verify async filters/functions still work,
- verify compiler/parser modules are not needed by the precompiled runtime entry.

Possible command:

```json
{
  "scripts": {
    "test:precompiled": "cross-env NODE_ENV=test mocha --check-leaks \"tests/precompiled/**/*.js\""
  }
}
```

Or fold these tests into `test:node` and `test:browser` so precompiled behavior is always covered.

The stronger long-term contract is:

- Node full entry can compile and render.
- Node precompiled entry can render precompiled templates without compiler imports.
- Browser full entry can compile and render in modern browser ESM.
- Browser precompiled entry can render precompiled templates without compiler imports.

## Precompiled Browser Test Modes

Use two browser ESM pages:

```text
tests/browser/esm.html
  imports the full browser ESM entry
  runs compile-and-render browser tests
  writes coverage/browser-esm.json

tests/browser/precompiled.html
  imports the browser precompiled ESM entry
  imports precompiled-templates.js
  runs precompiled runtime tests, including async cases
  writes coverage/browser-precompiled.json
```

Both pages should be driven by Playwright and browser Mocha, mirroring the current browser test model. Each page should call `window.sendTestResults({ stats, coverage })` when Mocha finishes so the Node-side runner can persist coverage and aggregate stats.

The precompiled page should not import the full entry just to get the compiler. Precompilation should happen before the browser test page loads, through `scripts/runprecompile.js` or an equivalent test setup step.

If dynamic precompilation inside tests is still useful, run it in Node before launching Playwright and write a generated ESM fixture module. Avoid loading the compiler into the browser precompiled lane.

## Precompiled Test Cases To Add

Add focused async precompiled tests for both Node and browser:

- render a precompiled async template with an async context function,
- render a precompiled template with an async filter,
- render a precompiled template with `for` over async values,
- render a precompiled template using macros,
- render a precompiled template using include/import if the loader map contains all referenced templates,
- verify a poison/error path from a precompiled async template reports the template name.

These tests should exercise `AsyncTemplate`/`AsyncEnvironment`, not only the legacy sync `Template` path.

## Target Browser Test Pages

Browser test pages should use native ESM:

```html
<script type="module">
  import * as cascada from '../../src/index.js';
  import './setup-browser-tests.js';
  import '../api.js';
  import '../pasync/calls.js';

  window.nunjucks = cascada.default || cascada;
  window.nunjucks.testing = true;

  const runner = mocha.run((failures) => {
    window.sendTestResults({
      stats: runner.stats,
      coverage: window.__coverage__
    });
  });
</script>
```

During the test migration, prefer converting shared test files to ESM modules. If a test file is still shared between Node and browser, it should import dependencies explicitly instead of relying on globals created by CommonJS `require`.

For browser compatibility, tests may still expose selected objects on `window` when old browser test helpers require globals. That should be treated as test harness compatibility, not runtime API design.

## Target Browser Test Server

The test server replaces the current Webpack bundle step and the current broad Babel transform.

Use the existing `connect` + `node:http` style server, converted to ESM. Do not introduce Express for the test server.

Responsibilities:

- serve project files,
- serve JavaScript as ESM-compatible `application/javascript`,
- instrument only runtime source files for coverage,
- leave test files uninstrumented unless test coverage is explicitly desired,
- leave `node_modules` uninstrumented,
- preserve `import`/`export`,
- avoid syntax downleveling,
- serve import maps and static browser shims for bare browser imports.

Instrumentation should be narrow:

```js
const shouldInstrument =
  process.env.NODE_ENV === 'test' &&
  pathname.startsWith('/src/') &&
  pathname.endsWith('.js');
```

Use Babel only for Istanbul counters:

```js
const result = await babel.transformAsync(code, {
  filename: filePath,
  sourceMaps: 'inline',
  babelrc: false,
  configFile: false,
  plugins: ['babel-plugin-istanbul']
});
```

Do not use `.babelrc`, `@babel/preset-env`, module transforms, or browser compatibility transforms in the browser test server.

## Bare Imports In Browser Tests

Native browser ESM does not understand bare npm specifiers by default.

Use import maps as the primary solution:

```html
<script type="importmap">
{
  "imports": {
    "asap": "/src/browser/shims/asap.js",
    "a-sync-waterfall": "/src/browser/shims/a-sync-waterfall.js"
  }
}
</script>
```

Browser runtime entries must import browser-safe ESM modules. If an npm dependency is CommonJS-only or Node-oriented, add a small browser ESM adapter or replace the dependency. Do not rely on a bundler to convert CommonJS dependencies for browser tests.

Test-only libraries such as Mocha, `expect.js`, and `he` may continue to be loaded as browser scripts if that is simpler. They are test harness dependencies, not Cascada runtime module dependencies.

Do not reintroduce Webpack or Rollup only to resolve browser test imports. The point of this lane is native browser ESM.

## Coverage

Keep Istanbul-format coverage for both Node and browser.

Coverage tooling is test-only. Published package files must not be instrumented, and package build commands must not run Istanbul transforms.

### Node Coverage

Use `c8` for Node coverage. It uses V8 native coverage and emits Istanbul-compatible reports.

Example:

```json
{
  "scripts": {
    "test:node": "c8 --reporter=text --reporter=html --reporter=json mocha --check-leaks \"tests/**/*.js\""
  }
}
```

Node coverage should not require Babel or `@babel/register`.

### Browser Coverage

Use Istanbul instrumentation while serving native ESM to the browser.

This instrumentation belongs only in the browser test server. It must not be used by package builds, docs builds, examples, or published browser-facing files.

The test server should:

- serve source files as ESM,
- instrument only `src/**/*.js`,
- preserve `import`/`export`,
- avoid syntax downleveling,
- exclude tests and dependencies,
- include source maps,
- expose `window.__coverage__` after Playwright runs.

Use Babel only as an instrumentation step. Babel must not apply presets or syntax transforms:

```js
const result = await babel.transformAsync(code, {
  filename,
  sourceMaps: 'inline',
  babelrc: false,
  configFile: false,
  plugins: ['babel-plugin-istanbul']
});
```

Do not use Babel module transforms, `@babel/preset-env`, or browser compatibility transforms for browser coverage.

After Playwright completes:

```js
const coverage = await page.evaluate(() => window.__coverage__);
```

Merge the coverage maps with `istanbul-lib-coverage`, then use `istanbul-lib-report` and `istanbul-reports` to write text/html/lcov reports.

## Packages

### Add

- `c8`
- `madge`
- `dummy-pkg` as a local `file:tests/test-node-pkgs/dummy-pkg` dev dependency for resolver tests

### Keep

Keep these as dev dependencies only if browser Istanbul coverage remains:

- `@babel/core`
- `babel-plugin-istanbul`
- `istanbul-lib-coverage`
- `istanbul-lib-report`
- `istanbul-reports`

Keep Playwright while browser tests remain:

- `playwright`

Keep the existing lightweight browser test server dependencies unless the server is rewritten to raw `node:http`:

- `connect`
- `serve-static`

### Removed

The legacy Babel module-transform, browser bundling, module-alias, and browser Node-polyfill dependency surface has been removed. The package now keeps only the Babel pieces still used by the native browser ESM test server for Istanbul instrumentation.

## Scripts To Remove Or Replace

Remove:

- `build:transpile`
- browser bundle generation scripts
- `--require @babel/register` from test commands
- `NODE_PATH=./tests/test-node-pkgs` from test commands
- Babel-based NYC config

Replace:

- Node coverage commands with `c8`.
- Browser bundle tests with Playwright native ESM tests.
- Browser bundle coverage with server-side Istanbul instrumentation of served ESM.
- `NODE_PATH` test fixture resolution with a `file:` dev dependency for `dummy-pkg`.

## Migration Order

1. Set the Node engine target to `>=22`.
2. Convert `src` modules to ESM.
3. Merge the current `src/index.mjs` ESM facade into the canonical `src/index.js` entry, then delete `src/index.mjs`.
4. Replace CommonJS globals and resolver APIs.
5. Add `madge` cycle checks and fix circular dependencies exposed by ESM.
6. Convert tests and test utilities to ESM.
7. Replace `NODE_PATH` test fixture resolution with a `file:` dev dependency.
8. Convert scripts to ESM without temporary CommonJS-only tooling.
9. Add `"type": "module"` once remaining `.js` files are ESM-safe.
10. Replace Node coverage with `c8`. Done for the Node coverage test scripts.
11. Replace browser bundle tests with native browser ESM tests. Done for the current browser test lane.
12. Add browser ESM Istanbul instrumentation in the test server.
13. Remove CJS build output and CJS export conditions.
14. Remove browser UMD bundle build. Done for the current package/test build.
15. Delete unused Babel/Rollup/Webpack dependencies. Done.
16. Run full Node and browser tests.

## Post-Transition Source Cleanup

After the package, tests, scripts, and browser lanes run as native ESM, remove temporary compatibility shapes that only exist to keep the staged migration working.

Cleanup targets:

- Remove the default export from `src/index.js`. Done. The canonical package API is named exports such as `import { AsyncEnvironment } from 'cascada-engine'`.
- Decide whether the public package should expose namespace convenience exports such as `compiler`, `parser`, `lexer`, `runtime`, `lib`, and `nodes`. Keep them only if they are intentional public API; otherwise export the individual supported names and leave internal module namespaces private.
- Delete the generated browser bundle artifacts from tests and source control once native browser ESM pages replace them. Done for:
  - `tests/browser/nunjucks.min.js`
  - `tests/browser/nunjucks-slim.min.js`
  - old bundle-only browser harness files that only call `require(...)`
- Remove test helpers such as `esmDefault(module) { return module.default || module; }` once tests use native ESM imports. Done for the converted test suite.
- Convert shared test utilities such as `tests/util.js` to pure ESM exports. Done. The shared util module now exposes named exports, including `utilApi`, instead of a default utility object.
- Replace CommonJS `require(...)` in tests with static ESM imports. Where tests need per-test fresh module state, prefer explicit factory helpers or dynamic `import()` with a real asynchronous boundary rather than reintroducing cache-clearing CommonJS patterns.
- Remove any `cascada.default || cascada` browser-test fallback. Done. Browser test globals now wrap the namespace import directly and add browser-only shims explicitly.
- Prefer direct re-exports in barrel-style modules:

```js
export { SomeName } from './some-module.js';
export * as runtime from './runtime/runtime.js';
```

instead of importing a module only to immediately re-export the same bindings.

- Avoid constructing API objects only to default-export them. Done for `src/index.js`; object registries now use named exports where they remain useful.
- Revisit remaining default exports in internal modules after the ESM conversion. Done for the active source tree. Remaining source defaults are browser shims that intentionally mimic package default imports, plus generated ESM precompile output.
- For object registries that stay as objects, prefer named exports for the registry itself:

```js
export const defaultDataMethods = { ... };
export const filters = { ... };
```

rather than anonymous `export default { ... }`, unless the default object is deliberately the API.

- Remove generated or transitional CommonJS interop aliases, including `__defaultExport`-style objects and duplicated default/named export mirrors.
- Keep `src/runtime/runtime.js` as a named-export runtime barrel. Do not reintroduce a default runtime object.
- Remove redundant `'use strict';` prologues from ESM source, tests, and scripts. Done for the active source/test/script tree.
- Keep one-off helpers near their only owner. For example, callback-to-promise helpers used only by async extension compilation should live in generated compiler output or compiler-owned helpers, not on the global runtime surface.
- Re-check broad namespace imports after the migration. Use namespace imports only when the namespace itself is part of the public API or when many members are genuinely consumed locally.
- Re-check mutable test hook surfaces such as `src/runtime/inheritance-call.js`. Done for the default-export part: mutable hook registries now use named exports such as `inheritanceCallApi`, `inheritanceStateApi`, `inheritanceBootstrapApi`, and `lookupApi`. A later refactor can replace the mutable registries themselves with explicit dependency injection or setter helpers if that API is still desirable.
- Re-check `src/index.js` convenience functions after named imports are canonical. Keep `configure`, `render*`, `compile*`, and `precompile*` only if they are intended top-level API; otherwise move convenience wrappers to a legacy or compatibility entry before final package publication.
- Remove transitional Rollup-generated ESM output and any `dist/esm` facade once the build copies native ESM source to the final `dist` shape.
- Normalize import style after the source is fully ESM:
  - use direct named imports for one or two symbols,
  - use namespace imports only for intentional module APIs,
  - use direct `export { name } from ...` where a file is only forwarding.
- Re-run the cycle check after each barrel cleanup. If a direct re-export creates a cycle, fix the dependency layering rather than hiding the cycle with a broad namespace import or dynamic import.

These cleanups should happen after native ESM tests are in place. The package default export and default interop helpers have now been removed from the converted test harness.

## Final Target

The final setup should be:

```text
src/                 ESM source
dist/                published ESM package files
dist/types/          declarations
tests/               Node ESM tests
tests/browser/       native browser ESM tests
scripts/             ESM tooling
```

There should be no CommonJS runtime source, no generated CJS package, and no browser UMD bundle.
