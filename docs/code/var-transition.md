# Var To Value Transition: Flag-Driven Usage

This document tracks places where behavior must be value-based when migration flags are enabled.

`var` language support is intentionally retained (parser/transpiler/runtime compatibility). The goal is not to remove `var` syntax support, but to ensure internal emission/execution paths use value outputs when the relevant flags are `true`.

Current migration flags in [`src/feature-flags.js`](../../src/feature-flags.js) are all `true`:
- `CONVERT_TEMPLATE_VAR_TO_VALUE`
- `CONVERT_SCRIPT_VAR_TO_VALUE`
- `LOOP_VARS_USE_VALUE`
- `SEQUNTIAL_PATHS_USE_VALUE`
- `VALUE_IMPORT_BINDINGS`

## Active Areas To Verify (With Flags = true)

### 1) Script transpiler conversion coverage
- Ensure `var` declarations route to `value` emission when `CONVERT_SCRIPT_VAR_TO_VALUE=true`, including `capture` and `call` forms.
- Primary logic lives in [`src/script/script-transpiler.js`](../../src/script/script-transpiler.js), notably `_convertVarDeclarationToValue(...)` and `_processVar(...)`.

### 2) Template symbol lookup path selection
- In async template conversion mode, verify symbol reads use value-aware lookup where expected.
- Relevant branch: [`src/compiler/compiler-base.js:427`](../../src/compiler/compiler-base.js#L427), fallback at [`src/compiler/compiler-base.js:430`](../../src/compiler/compiler-base.js#L430).

### 3) Macro/export publication path
- Macro publication still uses frame/context variable assignment paths at [`src/compiler/compiler.js:1436`](../../src/compiler/compiler.js#L1436), [`src/compiler/compiler.js:1444`](../../src/compiler/compiler.js#L1444).
- Decide whether this remains acceptable or should be value-output aligned under flags.

### 4) Dynamic extends parent binding path
- Transformer injects `Set` assignment for `__parentTemplate` in [`src/transformer.js:510`](../../src/transformer.js#L510), [`src/transformer.js:530`](../../src/transformer.js#L530).
- Root completion reads via lookup at [`src/compiler/compiler.js:1744`](../../src/compiler/compiler.js#L1744).

## Flag-Off Compatibility Paths (Intentionally Retained)

These paths support behavior when flags are disabled and can remain by design.

### 1) Import bindings fallback when `VALUE_IMPORT_BINDINGS=false`
- Legacy var/frame/context import alias path in [`src/compiler/compile-inheritance.js:188`](../../src/compiler/compile-inheritance.js#L188), [`src/compiler/compile-inheritance.js:257`](../../src/compiler/compile-inheritance.js#L257).

### 2) Loop variable fallback when `LOOP_VARS_USE_VALUE=false`
- Legacy loop `frame.set(...)` variable binding path in [`src/compiler/compile-loop.js:89`](../../src/compiler/compile-loop.js#L89), [`src/compiler/compile-loop.js:463`](../../src/compiler/compile-loop.js#L463).

### 3) Sequential path fallback when `SEQUNTIAL_PATHS_USE_VALUE=false`
- Legacy frame-lock/read-lock implementation in [`src/runtime/sequential.js:214`](../../src/runtime/sequential.js#L214), [`src/runtime/sequential.js:246`](../../src/runtime/sequential.js#L246), [`src/runtime/sequential.js:301`](../../src/runtime/sequential.js#L301).

## Port Checklist (Suggested Order)

1. Script transpiler: ensure all declaration shapes (`simple`, `capture`, `call`) emit value-path forms when `CONVERT_SCRIPT_VAR_TO_VALUE=true`.
2. Template compilation: verify converted template set/symbol paths consistently use value-aware lookup/commands when `CONVERT_TEMPLATE_VAR_TO_VALUE=true`.
3. Macro/export behavior: decide and document whether macro publication should remain var-based or be value-aligned under flags.
4. Dynamic extends: decide whether `__parentTemplate` remains variable-based or gets a value-aligned path.
5. Keep flag-off compatibility branches (`VALUE_IMPORT_BINDINGS`, `LOOP_VARS_USE_VALUE`, `SEQUNTIAL_PATHS_USE_VALUE`) unless there is a deliberate decision to remove that compatibility.

## Risk / Effort Notes

- High risk:
  - Template symbol lookup default changes (can affect broad read semantics).
  - Dynamic extends parent-template binding migration (affects inheritance flow).
  - Sequential fallback removal (ordering/poison behavior sensitive).

- Medium risk:
  - Macro publication path migration (imports/exports and top-level scope behavior).
  - Import fallback removal (inter-template symbol exposure behavior).

- Low to medium risk:
  - Transpiler declaration conversion cleanup.
  - Flag gating consistency across declaration forms.

## Exit Criteria

- With flags enabled, generated code/emission follows value-output paths for targeted features.
- With flags disabled, existing var-compatible behavior remains intact.
- Full test suite passes, with focused coverage for:
  - capture/call assignment forms
  - imports/from-imports
  - async loops and loop metadata
  - sequential path ordering/repair
  - template inheritance/dynamic extends
