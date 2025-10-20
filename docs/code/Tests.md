### Cascada Tests Overview

This document explains how the test suites are organized and how to run them efficiently.

### What the tests run against
- Node-side tests import from `src` and run the source directly.
- No tests import from `dist` compiled artifacts (yet).
- Browser tests run via a bundle produced on the fly from source.

### NPM scripts
- test:quick
  - Runs Mocha directly on a subset of tests.
  - No build, no precompile, no coverage/instrumentation.
  - Fastest inner loop.

- test:node
  - Runs Node tests from source with NYC coverage and @babel/register.
  - No build/precompile.

- test:browser
  - Builds a browser bundle from source using `scripts/bundle.js` and runs the browser tests.
  - No full build/precompile.

- test
  - The only script that performs a build/precompile first.
  - Sequence: build + precompile, then `test:node`, then `test:browser`.

### Which tests to use when
- Quick local feedback on Node tests: `npm run test:quick`
- Coverage or full Node test run from source: `npm run test:node`
- Browser-including runs without build: `npm run test:browser`
- CI/full validation including build + precompile: `npm test`

### Code coverage instrumentation
- Node (source tests): Coverage is collected by `nyc` with `@babel/register`, no build required. Reports (html/text/json) are emitted by `nyc` and map back to `src` via sourcemaps.
- Browser (bundled tests): In test mode the webpack config enables `babel-plugin-istanbul` and emits bundles into `tests/browser` (not `dist/browser`). Production bundles in `dist/browser` are not instrumented.
- Quick runs: `test:quick` intentionally skips coverage for speed.

### Notes and conventions
- Use `it.only()` / `describe.only()` during development to focus runs.
- Avoid asserting on the timing/order of concurrent operations; assert on final, deterministic output.
- The precompile step is validated by `npm test`; the Node tests themselves do not depend on compiled output.

### Combined totals and coverage (Full test)
- When running `npm test`, Node test stats are written to `coverage/node-tests-stats.json` by a custom reporter.
- The browser runner merges Node and browser coverage and prints a combined summary.
- If there are failures, it also prints a breakdown like: `7 failing (2 node, 5 browser)`.


