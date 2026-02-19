# value vs var parity gaps (CONVERT_VAR_TO_VALUE mode)

Fresh regression snapshot for `CONVERT_VAR_TO_VALUE = true` in `src/script/script-transpiler.js`.

Run details:
- Date: February 19, 2026
- Command:
  - `npm run test:quick`
  - `NODE_ENV=test NODE_PATH=./tests/test-node-pkgs npx mocha --check-leaks -R json 'tests/*.js' 'tests/pasync/**/*.js' 'tests/poison/**/*.js'`
- Result:
  - Total: 2413
  - Passing: 2353
  - Failing: 43
  - Pending: 17

Purpose:
- Track parity gaps when `var` is converted to `value`.
- This is a diagnosis map, not a fix plan.

## High-level summary

Compared to the older 127-failure snapshot, several clusters are now resolved or reduced, but 43 regressions remain in core mutable-variable behavior.

Current major clusters:
- Loop poison/while condition behavior and loop write semantics: 20 failures with loop/while-related titles.
- Script variable scoping/capture behavior (many timeouts): 11 failures in `tests/pasync/script.js`.
- Name conflict diagnostics drift to output-style messages: 4 failures.
- Path-assignment strict/lazy error-shape mismatches: 3 failures.
- Callback/output command ordering regression (`finished CommandBuffer`): 1 failure.
- Callback argument behavior mismatch (`18` vs `12`): 1 failure.
- Peek operator regression: 2 failures.
- Remaining poison integration/recovery mismatches: 2 failures.

Quick symptom counts:
- `expected false to equal true`: 17
- Timeout failures: 10

## File-level failure distribution

- `tests/pasync/script.js`: 11
- `tests/phase6-integration.js`: 6
- `tests/phase5-while-generator.js`: 6
- `tests/explicit-outputs.js`: 4
- `tests/pasync/loops.js`: 4
- `tests/pasync/path-assignment.js`: 3
- `tests/poison/peek-operator.js`: 2
- `tests/pasync/phase2-loop-poison-sync.js`: 2
- `tests/pasync/script-output.js`: 2
- `tests/poison/phase4 - async-iterator-errors.js`: 1
- `tests/poison/error-recovery.js`: 1
- `tests/poison/integration.js`: 1

## Detailed regression groups

### 1) Loop/while poison behavior and mutable write tracking

Representative failing files:
- `tests/phase5-while-generator.js`
- `tests/phase6-integration.js`
- `tests/pasync/loops.js`
- `tests/pasync/phase2-loop-poison-sync.js`
- `tests/poison/phase4 - async-iterator-errors.js`
- `tests/poison/integration.js`

Symptoms:
- Many assertions expect poisoning/error handling to trigger but see non-poison result (`expected false to equal true`).
- One mutable-parent-loop semantic mismatch:
  - `tests/pasync/loops.js`: expected `1`, got `3`.
- One loop timeout:
  - `tests/pasync/loops.js`: `should keep script loops parallel with local vars inside if block`.

Interpretation:
- Loop condition poisoning and body-write propagation are still not equivalent when declarations are converted from `var` to `value`.
- This appears to affect both while-condition evaluation and for/loop body contamination behavior.

### 2) Script variable scope/capture regressions

File:
- `tests/pasync/script.js` (11 failures)

Symptoms:
- Multiple timeouts in:
  - capture assignment tests
  - branch-local scoping tests (`if/else`, `switch`)
  - complex variable declaration test
- Var-style declaration/shadow expectations now return output-style errors.

Representative diagnostics:
- `Output 'user' already declared in this scope` (expected var redeclaration wording)
- `Output 'item' cannot shadow an output declared in a parent scope`

Interpretation:
- Converted declarations are still following output namespace/scoping/capture machinery in places where mutable var semantics are expected.

### 3) Output/variable conflict diagnostic drift

Files:
- `tests/explicit-outputs.js`
- `tests/pasync/script.js`

Symptoms:
- Expected:
  - `Cannot declare output ... conflicts with variable`
  - `Cannot declare variable ... conflicts with output`
- Observed:
  - `Output 'x' already declared in this scope`

Interpretation:
- Conflict checks are happening too late or at the wrong layer, after names are already treated as output declarations.

### 4) Path assignment (`set_path`) parity gaps

File:
- `tests/pasync/path-assignment.js`

Failing scenarios:
- strict missing-path/null-root error message expectations
- lazy semantics case: expected overwrite behavior but receives surfaced `Sync Poison`

Interpretation:
- Value-converted declarations still do not perfectly match var-path assignment and lazy poison overwrite behavior.

### 5) Callback/output command timing and result mismatches

File:
- `tests/pasync/script-output.js`

Failures:
- `Cannot add command to finished CommandBuffer` during explicit callback path.
- Numeric mismatch in callback-with-args path (`{ value: 18 }` vs expected `{ value: 12 }`).

Interpretation:
- Async callback/focus execution order is not stable under current conversion and can enqueue writes after block completion.

### 6) Caller/call result reuse anomalies

File:
- `tests/explicit-outputs.js`

Symptoms:
- Caller outputs duplicated/reused instead of per-call values:
  - expected `[2, 4, 6]`, observed `[6, 6, 6]`
  - expected per-call text/data pairs, observed repeated values.

Interpretation:
- Converted variable/value state is leaking or being snapshotted at the wrong stream point across caller invocations.

### 7) Poison recovery and peek operator regressions

Files:
- `tests/poison/error-recovery.js`
- `tests/poison/peek-operator.js`

Symptoms:
- Recovery case does not throw expected condition error text.
- Peek assignment throws `Assignment Error`.
- Sequencing-peek message shape mismatch:
  - expected exact `Sequence Error`
  - observed wrapped contextual error string.

Interpretation:
- Error wrapping and assignment handling around value-converted symbols are still behaviorally different from var baseline.

## What changed vs the previous analysis

- Failure count dropped from 127 to 43.
- Large prior clusters (for example transpiler literal string expectations) are no longer present in the current failing set.
- Remaining failures are now concentrated in runtime/semantic parity, especially:
  - loop poisoning + mutable writes
  - script scoping/capture
  - output/variable conflict semantics
  - callback/output command timing
