# value vs var parity gaps (temporary CONVERT_VAR_TO_VALUE mode)

This document captures failures observed when `CONVERT_VAR_TO_VALUE = true` in `src/script/script-transpiler.js` and `npm run test:quick` was executed.

Run snapshot:
- Total tests: 2407
- Passing: 2263
- Failing: 127
- Pending: 17

Goal:
- Identify where treating `var x = ...` as `value x = ...` is not behaviorally equivalent yet.
- This is a parity map, not a fix plan.

## High-level summary

Top failure clusters:
- `set_path` / property mutation on script variables: 29 failures (`tests/pasync/path-assignment.js`) + related set-path style failures in `tests/pasync/structures.js`.
- Guarded variable tracking (`guard x`, `guard a,b`, etc.): 15 failures with `guard variable "..." is not declared`.
- Timeout/deadlock/regression class (mostly loops/while/async control): 40 failures.
- Error-recovery behavior mismatches (Poison/FunCall surfaces): 13 failures (`tests/poison/error-recovery.js`).
- Call block assignment pairing mismatch (`endcall_assign` vs `endcall`): 2 direct failures.
- Name-conflict/scoping semantic drift (`Output 'x' already declared...` where var-style errors expected): multiple failures.
- Plus 13 expected transpiler assertion failures that compare literal `var` strings.

## Detailed gaps with examples

### 1) Property mutation on `var`-style objects breaks under `value` conversion

Status:
- Strongly confirmed.
- This is primarily property/path mutation (`obj.x = ...`, `list[i] = ...`, `obj.a.b = ...`), not plain scalar assignment.

Symptoms:
- Runtime errors like: `Cannot assign to undeclared variable 'obj'. Use 'var' to declare a new variable.`

Representative tests:
- `tests/pasync/path-assignment.js`
- `tests/pasync/structures.js`

Example:
Source test:
- `tests/pasync/path-assignment.js` - `Cascada Script: Variable Path Assignments (set_path) Synchronous should set property on script variable`
```cascada
var obj = { x: 1 }
obj.y = 2
return obj
```
Expected: `{ x: 1, y: 2 }`
Observed in failing mode: undeclared-variable style `Set(Symbol)` failure.

Interpretation:
- `value` declarations are not participating in variable-path mutation semantics the way `var` declarations do.
- So your intuition is correct: #1 is mostly about property mutation (`set_path`) behavior.

### 2) Guard variable selectors do not recognize converted declarations as mutable vars

Symptoms:
- `guard variable "count" is not declared`
- Affects script-mode guard flows and sequence guard transaction tests.

Representative tests:
- `tests/poison/guard.js`
- `tests/explicit-outputs.js`

Example:
Source test:
- `tests/poison/guard.js` - `Guard Block should restore guarded variables on error in script mode`
```cascada
data data
var count = 1
guard count
  count = count + 1
  count = poison()
endguard
data.res = count
return { data: data.snapshot() }
```
Expected: guard sees `count`, reverts to `1` on failure.
Observed: guard fails at declaration recognition (`count` considered not declared for guard selector).

Interpretation:
- Guard compile/runtime metadata still appears tied to variable-declaration semantics that `value` does not currently satisfy.

### 3) Call-block assignment plumbing diverges (`call_assign` end-tag mismatch)

Symptoms:
- `Unexpected 'endcall_assign', was expecting 'endcall'`

Representative tests:
- `tests/pasync/calls.js`
- `tests/pasync/script-output.js`

Example:
Source test:
- `tests/pasync/calls.js` - `Cascada Script: Call blocks (assignment) should allow assigning the result of a call block to an existing variable (x = call ... endcall)`
```cascada
var result = none
result = call map([1, 2, 3]) (n)
  value value
  value(n * 2)
  return value.snapshot()
endcall
```
Expected: normal `x = call ... endcall` assignment flow.
Observed: parser/block-pair mismatch in some paths.

Interpretation:
- `var`/`set`-based assignment-call path still has edge cases when combined with the conversion and current call block handling.

### 4) Scoping/shadowing semantics drift toward output-declaration behavior

Symptoms:
- Errors like `Output 'user' already declared in this scope` where tests expect var-shadowing/redeclaration semantics.

Representative tests:
- `tests/pasync/script.js`
- `tests/explicit-outputs.js`

Examples:
- Variable redeclaration/shadowing tests expecting `has already been declared` var-style diagnostics.
- Output/variable conflict tests expecting `Cannot declare output` or `Cannot declare variable` but receiving output-redeclaration errors.

Interpretation:
- Converted declarations are entering output namespace/scoping paths, which differ from variable namespace/scoping rules.

### 5) Capture-related behavior is still fragile in mixed var/value scenarios

Symptoms:
- Timeouts and conflict errors around capture assignment/use in script-output and script variable suites.

Representative tests:
- `tests/pasync/script.js`
- `tests/pasync/script-output.js`

Example pattern:
Source test:
- `tests/pasync/script-output.js` - `Cascada Script: Output commands Scoping and Control should support capture in assignment to existing variables`
```cascada
var capturedContent = "initial"
capturedContent = capture
  data data
  data.msg = "ok"
  return data.snapshot()
endcapture
```
Observed failures include redeclaration/conflict and timeout side effects in broader suites.

Interpretation:
- Even with explicit skip for `var ... = capture`, mixed interactions with converted declarations and output scopes are not fully aligned.

### 6) Loop/while async control regressions (many timeouts)

Symptoms:
- `Timeout of 2000ms exceeded` across while/loop-focused suites.

Representative tests:
- `tests/phase5-while-generator.js`
- `tests/pasync/loop-phase1-two-pass.js`
- `tests/pasync/loops.js`
- `tests/phase3-empty-loops.js`

Example (for-loop):
Source test:
- `tests/explicit-outputs.js` - `Cascada Script: Explicit Output Declarations Edge Cases should support outputs in for, while, and each loops`
```cascada
data myData
for item in [1, 2]
  myData.forItems.push(item)
endfor
return myData.snapshot()
```

Example (while-loop):
Source test:
- `tests/phase5-while-generator.js` - `Phase 5: While Loop Generator Error Handling Test 5.4: Normal boolean condition should work with normal boolean condition`
```cascada
data data
var i = 0
while checkCondition()
  i = i + 1
endwhile
data.i = i
return data.snapshot()
```

Expected: normal completion with deterministic loop output (for example, `forItems` populated in source order and `i` incremented by loop iterations).
Observed in failing mode: loop-related suites show timeout/regression behavior in multiple scenarios.

Loop-kind failure breakdown (from failing test titles, so this is conservative):
- Total timeout failures: 40
- Explicit while mentions: 12
- Explicit for mentions: 1
- Explicit each mentions: 1
- Generic loop mentions without explicit kind: 14

Loop-site counts (explicit mentions + manually categorized generic loop titles):
- `for`: 14 (1 explicit + 13 generic)
- `while`: 13 (12 explicit + 1 generic)
- `each`: 1 (1 explicit + 0 generic)

Loop-focused failing files (all loop kinds mixed): 19 failures
- `tests/phase5-while-generator.js`: 6 (while-focused)
- `tests/pasync/loop-phase1-two-pass.js`: 7 (mixed for/while/iterators)
- `tests/pasync/loops.js`: 3 (mixed)
- `tests/phase3-empty-loops.js`: 2 (mixed)
- `tests/pasync/phase2-loop-poison-sync.js`: 1 (mixed)

Generic `loop` title categorization by test:
- `tests/phase3-empty-loops.js` - `...should handle complex nested structures` -> `for`
- `tests/pasync/loop-phase1-two-pass.js` - `...should track writes in loop body` -> `for`
- `tests/pasync/loop-phase1-two-pass.js` - `...should track writes in both blocks` -> `for`
- `tests/pasync/loop-phase1-two-pass.js` - `...should handle object iteration` -> `for`
- `tests/pasync/loop-phase1-two-pass.js` - `...should handle sequential loops with writes` -> `for`
- `tests/pasync/loop-phase1-two-pass.js` - `...should handle async iterators` -> `for`
- `tests/pasync/loop-phase1-two-pass.js` - `...should handle deeply nested loops with writes` -> `for` (nested `for` loops)
- `tests/pasync/loops.js` - `...should handle loop in script format sequentially(mutable parent var)` -> `for`
- `tests/pasync/loops.js` - `...should keep script loops parallel with local vars inside if block` -> `for`
- `tests/pasync/path-assignment.js` - `...should handle loop with lazy aggregation` -> `for`
- `tests/pasync/phase2-loop-poison-sync.js` - `...should still execute normally with valid data` -> `for`
- `tests/pasync/structures.js` - `...should handle loop with intermediate usage and mixed aggregation` -> `for`
- `tests/poison/error-recovery.js` - `...should recover from error in sequential loop iterations` -> `for` (with sequential `!` calls inside)
- `tests/poison/guard.js` - `...should handle loop control (break) inside guard` -> `while`

Pass/fail disambiguation (script loops only):
- Failing pattern: loop body performs normal iterative updates to script variables declared with `var` (for example `total = total + i`, `i = i + 1`) and relies on that mutable state to terminate/accumulate.
  - Example failing tests:
    - `tests/phase5-while-generator.js` - `Test 5.4: Normal boolean condition should work with normal boolean condition`
    - `tests/pasync/loop-phase1-two-pass.js` - `Test 1.1: Body writes tracked should track writes in loop body`
    - `tests/pasync/loops.js` - `should handle loop in script format sequentially(mutable parent var)`
- Passing counterexample with mutable outer variable does exist, but in the `else` path (no body iteration writes):
  - `tests/pasync/loop-phase1-two-pass.js` - `Test 1.2: Else writes tracked should track writes in else block (Phase 3)`
  - Script:
    ```cascada
    data data
    var total = 0
    for i in []
      total = total + i
    else
      total = 100
    endfor
    data.total = total
    return data.snapshot()
    ```
  - Why it matters: this still mutates an outer `var` inside loop structure and passes, suggesting the regression is strongest when normal body-iteration write tracking/execution is exercised.

Interpretation:
- Variable write/read tracking or loop-phase analysis likely assumes `var` semantics; converted declarations are not fully equivalent in async loop execution paths.

### 7) Error recovery differences (Poison/FunCall surfaces instead of expected recovery)

Symptoms:
- Direct surfaced `doing 'FunCall' : ...` errors in tests that expect recoverable behavior with heal/guard patterns.

Representative tests:
- `tests/poison/error-recovery.js`

Example pattern:
Source test:
- `tests/poison/error-recovery.js` - `Poisoning Tests ! Sequential Operator Error Recovery should recover from error in sequential database writes`
```cascada
data data
var user = db!.createUser()
if heal and user is error
  user = {id: 999, name: "FallbackUser"}
endif
db!!
var profile = db!.createProfile(user.id)
```
Expected: healed path proceeds.
Observed in failing mode: upstream FunCall error bubbling in multiple cases.

Interpretation:
- Error dataflow and/or recovery gating depends on variable semantics not yet mirrored by converted `value` declarations.

### 8) Peek operator sequencing/error-shape mismatch

Symptoms:
- Assertion mismatch in `tests/poison/peek-operator.js` for sequencing-peek case.

Representative failing assertion:
- Expected `'Sequence Error'`, got full wrapped error message context.

Interpretation:
- Error wrapping/shape changed under converted flow; sequencing + peek assumptions differ from baseline.

### 9) Pure transpiler string expectation failures (expected and non-semantic)

Status:
- Expected side-effect of conversion in tests that literally assert generated `var` text.

Representative file:
- `tests/script-transpiler.js` (13 failures)

Example:
- Expected: `{%- var x = 1 -%}`
- Observed: `{%- value x = 1 -%}`

Interpretation:
- These do not indicate runtime parity bugs by themselves.

## Practical takeaway

Current conversion is useful to expose parity gaps, and the largest concrete missing area is:
- `value` declaration parity for mutable variable semantics, especially path/property mutation (`set_path`) and guard-variable tracking.

Secondary high-impact areas:
- call/capture assignment block integration
- loop/while async/write-tracking behavior
- error-recovery compatibility

## Reference files (most failing)

- `tests/pasync/path-assignment.js` (29)
- `tests/pasync/script.js` (14)
- `tests/script-transpiler.js` (13, mostly expected string diffs)
- `tests/poison/error-recovery.js` (13)
- `tests/poison/guard.js` (11)
- `tests/explicit-outputs.js` (10)
- `tests/pasync/script-output.js` (10)
- `tests/pasync/loop-phase1-two-pass.js` (7)
- `tests/phase5-while-generator.js` (6)
