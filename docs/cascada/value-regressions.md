# value vs var parity gaps (CONVERT_VAR_TO_VALUE mode)

Fresh regression snapshot for `CONVERT_VAR_TO_VALUE = true` in `src/script/script-transpiler.js`, after the buffer-parent/linking and compiler buffer-state simplification work.

Run details:
- Date: February 23, 2026
- Command:
  - `npm run test:quick`
- Result:
  - Total: 2418
  - Passing: 2376
  - Failing: 25
  - Pending: 17

Purpose:
- Track parity gaps when `var` is converted to `value`.
- This is a diagnosis map, not a fix plan.

## High-level summary

Compared to the previous 35-failure snapshot, the suite is now at 25 failing tests.

What improved:
- Timeout-heavy script/call/capture regressions are no longer in the failing list.
- CommandBuffer parent-link consistency changes reduced cross-scope command-placement failures.

Current major clusters:
- Loop poison/while condition behavior and loop write semantics: 17 failures.
- Path-assignment strict/lazy mismatch: 3 failures.
- Peek/recovery/integration error-shape regressions: 5 failures.

Quick symptom counts:
- `expected false to equal true`: 17
- Timeout failures: 0

## File-level failure distribution

- `tests/phase6-integration.js`: 6
- `tests/phase5-while-generator.js`: 6
- `tests/pasync/loops.js`: 3
- `tests/pasync/path-assignment.js`: 3
- `tests/pasync/phase2-loop-poison-sync.js`: 2
- `tests/poison/peek-operator.js`: 2
- `tests/poison/error-recovery.js`: 1
- `tests/poison/integration.js`: 1
- `tests/poison/phase4 - async-iterator-errors.js`: 1

## Detailed regression groups

### 1) Loop/while poison behavior and mutable write tracking

Representative failing files:
- `tests/phase5-while-generator.js`
- `tests/phase6-integration.js`
- `tests/pasync/loops.js`
- `tests/pasync/phase2-loop-poison-sync.js`
- `tests/poison/integration.js`
- `tests/poison/phase4 - async-iterator-errors.js`

Symptoms:
- Poison/error conditions expected by tests are not surfaced (`expected false to equal true`).
- Mutable parent loop write parity mismatch remains (`expected 1`, got `3` in loop script test).

Interpretation:
- Remaining gaps are concentrated in control-flow poison handling and loop write contamination semantics.

### 2) Path assignment (`set_path`) parity gaps

File:
- `tests/pasync/path-assignment.js`

Symptoms:
- Strict error messages for missing path/null root do not match expected shape.
- Lazy overwrite scenario still surfaces `Sync Poison` unexpectedly.

Interpretation:
- `set_path` behavior remains partially divergent from var baseline in strict/lazy edge handling.

### 3) Recovery/peek/integration error-shape regressions

Files:
- `tests/poison/error-recovery.js`
- `tests/poison/peek-operator.js`

Symptoms:
- Recovery message mismatch.
- Peek assignment and sequence-peek message shape mismatch.

Interpretation:
- Error wrapping/normalization for value-converted paths still differs from baseline expectations.

## What changed vs the previous analysis

- Failure count improved from 35 to 25.
- Async custom-extension content duplication is no longer present in the failure list.
- Output/variable conflict diagnostic drift is no longer present in the failure list.
- Timeout cluster in script/call/capture paths remains out of the current failure list.
- Remaining work is now more concentrated in:
  - loop poison semantics,
  - error-shape parity,
  - path-assignment strict/lazy parity.
