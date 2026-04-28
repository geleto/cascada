### Cascada Tests Overview

This document explains how the test suites are organized and how to run them efficiently.

### What the tests run against
- Node-side tests import from `src` and run the source directly.
- No tests import from `dist` compiled artifacts (yet).
- Browser tests run source ESM directly in Playwright through native `<script type="module">`.

### NPM scripts
- test:quick
  - Runs Mocha directly on a subset of tests.
  - No build, no precompile, no coverage/instrumentation.
  - Fastest inner loop.

- test:node
  - Runs Node tests from source with NYC coverage.
  - No build/precompile.

- test:browser
  - Starts the browser test server and runs native browser ESM tests in Playwright.
  - No full build/precompile.

- test
  - The only script that performs a build/precompile first.
  - Sequence: build + precompile, then `test:node`, then `test:browser`.

### Which tests to use when
- Quick local feedback on Node tests: `npm run test:quick`
- Coverage or full Node test run from source: `npm run test:node`
- Browser-including runs without build: `npm run test:browser`
- CI/full validation including build + precompile: `npm test`
- Run a single file: `npm run mocha:single -- tests/poison/tests.js`

### Code coverage instrumentation
- Node (source tests): Coverage is collected by `c8` using V8 native ESM coverage, no build required. Reports (html/text/json) are emitted by `c8`.
- Browser (native ESM tests): The test server instruments served `src/**/*.js` modules with `babel-plugin-istanbul` while preserving native `import`/`export`. Test files and dependencies are served uninstrumented.
- Quick runs: `test:quick` intentionally skips coverage for speed.

### Notes and conventions
- Use `it.only()` / `describe.only()` during development to focus runs.
- Avoid asserting on the timing/order of concurrent operations; assert on final, deterministic output.
- The precompile step is validated by `npm test`; the Node tests themselves do not depend on compiled output.

### Combined totals and coverage (Full test)
- When running `npm test`, Node test stats are written to `coverage/node-tests-stats.json` by a custom CommonJS reporter. Mocha loads reporters through its CommonJS reporter path even while the test suite itself is native ESM.
- The browser runner merges Node and browser coverage and prints a combined summary.
- If there are failures, it also prints a breakdown like: `7 failing (2 node, 5 browser)`.


