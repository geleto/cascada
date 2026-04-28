### Cascada Tests Overview

This document explains how the test suites are organized and how to run them efficiently.

### What the tests run against
- Source/dev Node tests import from `src` and run the source directly.
- Source/dev browser tests run source ESM directly in Playwright through native `<script type="module">`.
- `npm test` is the package-verification lane: it builds first, then runs the same Node/browser test suites against `dist`.
- Browser tests always generate the precompiled template fixture first. Source browser runs use `src/precompile.js`; `npm test` uses `dist/precompile.js`.

### NPM scripts
- test:quick
  - Runs Mocha directly on a subset of tests.
  - No build, no precompile, no coverage/instrumentation.
  - Fastest inner loop.

- test:node
  - Runs Node tests from source with c8 coverage.
  - No build.
  - Does not generate the browser precompiled fixture.

- test:pasync
  - Runs the async/poison Node tests from source with c8 coverage.
  - No build.
  - Does not generate the browser precompiled fixture.

- test:browser
  - Starts the browser test server and runs native browser ESM tests in Playwright.
  - No full build.
  - Generates the browser precompiled fixture from source before launching Playwright.

- test
  - The only script that performs a build first.
  - Sequence: build, precompile from `dist`, browser tests served from `dist`, Node tests redirected to `dist`.

### Build and precompile behavior
- `npm run test:quick`: no build, no precompile.
- `npm run test:node`: no build, no browser precompiled fixture.
- `npm run test:pasync`: no build, no browser precompiled fixture.
- `npm run test:browser`: no build, but generates the browser precompiled fixture from `src/precompile.js`.
- `npm test`: builds first, then generates the browser precompiled fixture from `dist/precompile.js`.

### Which tests to use when
- Quick local feedback on Node tests: `npm run test:quick`
- Coverage or full Node test run from source: `npm run test:node`
- Browser-including runs without build: `npm run test:browser`
- CI/full package validation including build + precompile + dist tests: `npm test`
- Run a single file: `npm run mocha:single -- tests/poison/tests.js`

### Code coverage instrumentation
- Node (source tests): Coverage is collected by `c8` using V8 native ESM coverage, no build required. Reports (html/text/json) are emitted by `c8`.
- Node (`npm test`): Coverage is collected from `dist/**/*.js`; a test-only ESM loader redirects test imports from `src` to the built `dist` files.
- Browser (source tests): The test server instruments served `src/**/*.js` modules with `babel-plugin-istanbul` while preserving native `import`/`export`. Test files and dependencies are served uninstrumented.
- Browser (`npm test`): The test server serves `/src/...` module requests from `dist/...`, so the browser lane verifies the built package output.
- Quick runs: `test:quick` intentionally skips coverage for speed.

### Notes and conventions
- Use `it.only()` / `describe.only()` during development to focus runs.
- Avoid asserting on the timing/order of concurrent operations; assert on final, deterministic output.
- The precompile step is validated by browser tests and by `npm test`; the Node tests themselves do not depend on generated browser precompile fixtures.

### Combined totals and coverage (Full test)
- When running `npm test`, Node test stats are written to `coverage/node-tests-stats.json` by the native ESM Node test runner.
- The final reporter merges Node and browser coverage, writes Istanbul reports, and prints a combined summary.
- If there are failures, it also prints a breakdown like: `7 failing (2 node, 5 browser)`.


