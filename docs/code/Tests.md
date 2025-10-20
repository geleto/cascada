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

- test:node-no-prep
  - Runs Node tests from source with NYC coverage and @babel/register.
  - No build/precompile.

- test:node
  - Alias to the no-prep Node run with coverage (no build).

- test:browser-no-prep
  - Builds a browser bundle from source using `scripts/bundle.js` and runs the browser tests.
  - No full build/precompile.

- test:browser
  - Alias to the browser no-prep run (no build).

- test
  - The only script that performs a build/precompile first.
  - Sequence: build + precompile, then Node tests (from source), then browser tests (bundled from source).

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


