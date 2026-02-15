# setval Design Notes (Temporary Bridge to Future `set`)

This document records the implementation plan for introducing `setval/endsetval` as a temporary template-layer tag for **value semantics**.

It is based on the current migration goal:
- Script mode keeps `var ...` and `value ...` declarations.
- Template/compiler layer distinguishes `set` and `setval`.
- Long-term goal: `setval` semantics may later become the default `set` semantics.

No code in this document; this is design/plan only.

## 1) Scope and Intent

`setval` is **not** only for converted `var`.
It is the template-mode representation of `value` semantics in general:
- direct script `value x = ...`
- migration conversion paths
- mixed scripts containing both `var` and `value`

Key requirement:
- `var` and `value` must coexist in the same script with their own semantics.

## 2) Non-Negotiable Behavioral Requirements

1. Script syntax remains:
- `var x = ...`
- `value x = ...`

2. Template-layer tags:
- existing: `set/endset`
- new temporary: `setval/endsetval`

3. Shadowing rules during migration:
- Preserve current behavior: `value` shadowing remains allowed for now.
- Do not force `var`-style shadowing restrictions onto `value` yet.

4. `capture` / `call` compatibility:
- `value` declarations/assignments must support capture/call assignment flows, like `var` does today.

5. Property/path mutation compatibility:
- `value`-declared mutable symbols must be recognized by `set_path` logic where intended.

6. Guard compatibility:
- Guard selectors for variables must correctly resolve symbols declared via `value` semantics.

## 3) Architectural Principle

Reuse existing var/set machinery as much as possible.

Preferred approach:
- Keep one shared compile/runtime assignment engine.
- Distinguish declaration/assignment semantics by a small kind flag (e.g. `var`, `set`, `setval`) rather than duplicating code paths.

Goal:
- Minimal surface changes
- Elegant and maintainable behavior partitioning
- Fast rollback/forward migration options

## 4) Syntax Layer Separation

Important distinction:
- Script layer: `var` and `value` keywords.
- Template layer: assignment/control tags (`set`, `setval`, etc.).

`setval/set` discussion applies to template/compiled representation, not user script keyword syntax.

## 5) Proposed End-to-End Flow

### 5.1 Parsing / Tag Registration

Add support for:
- `setval` (start tag)
- `endsetval` (end tag)

Update tag/block registries and block-pair validation tables to treat `setval` as a block-capable assignment tag (analogous to `set`/`var` block behavior where applicable).

### 5.2 Script Transpiler Mapping

Transpile script `value` declarations/assignment forms into `setval` template tags.

Examples (conceptual):
- `value x = 1` -> `{% setval x = 1 %}`
- `value x = capture ... endcapture` -> `{% setval x %} ... {% endsetval %}`
- call-assignment variants should emit a `setval`-kind assignment form.

For mixed scripts:
- `var` continues mapping to existing var-oriented template representation.
- `value` maps to `setval`.

### 5.3 Compiler Canonicalization

Compiler should normalize `set` and `setval` into the same underlying assignment pipeline, but carry assignment/declaration kind metadata.

That metadata drives:
- scope rules
- shadowing/redeclaration checks
- guard eligibility
- path mutation eligibility

### 5.4 Runtime / Frame Interaction

No separate runtime engine for `setval`.

Reuse existing variable write/read synchronization and async mechanisms; only enforce differing semantics where rules differ (e.g., shadowing policy, declaration checks).

## 6) capture / call Design

Current capture/call assignment logic is tied to var/set assumptions.

Required generalization:
- Assignment block plumbing carries assignment-kind (`set`, `setval`, possibly `var` depending on flow).
- Start/end pairing must close correctly:
  - `set` -> `endset`
  - `setval` -> `endsetval`
- `call_assign`-style internals should become kind-aware, not hard-coded to one assignment tag kind.

Outcome:
- `value` can use capture/call with behavior parity to intended mutable semantics.

## 7) Property Mutation (`set_path`) Design

Observed failures indicate root symbol resolution is too var-specific.

Required behavior:
- `set_path` root validation must understand symbols declared with `value` semantics (via `setval`).
- Errors should reflect actual path/value issues, not false undeclared-variable errors, when declaration is valid.

Implementation style:
- Centralize symbol lookup by declaration kind, not tag string checks.

## 8) Scoping, Redeclaration, Shadowing

Need a kind-aware symbol model:
- `var` symbols keep current rules.
- `value` symbols keep current migration-era rule: shadowing allowed.

Checks (redeclare/conflict/lookup) must consult symbol kind policy rather than assuming one global policy.

This avoids current drift where value flows are treated as output declarations and produce mismatched diagnostics.

## 9) Guard Integration

Guard variable selectors currently fail when declaration kind is not recognized as variable.

Required:
- Guard compile/runtime variable resolution includes `value` symbols.
- Modification-tracking for guarded vars works for `setval` writes.
- Guard diagnostics remain precise and kind-aware.

## 10) Mixed `var` + `value` in One Script

Must work as first-class scenario.

Rules:
- Both declaration kinds can appear in same scope chain.
- Conflicts resolved by explicit kind-aware policy.
- Assignment dispatch targets the correct symbol kind.

This is critical because migration will not be all-at-once.

## 11) Minimal Change Strategy

1. Introduce `setval/endsetval` tags and parsing/validation support.
2. Map script `value` flows to `setval` in transpiler.
3. Extend existing assignment compiler path with kind metadata.
4. Make capture/call assignment plumbing kind-aware.
5. Make set_path and guard symbol lookup kind-aware.
6. Preserve current value shadowing behavior.

Avoid:
- Duplicating runtime write/lock logic
- Creating separate assignment engines for `set` vs `setval`

## 12) Testing Strategy (Targeted)

Focus regression/validation around known failing clusters:

1. Path mutation
- `tests/pasync/path-assignment.js`
- `tests/pasync/structures.js`

2. Guard variable handling
- `tests/poison/guard.js`
- sequence guard tests in `tests/explicit-outputs.js`

3. Loop write tracking / mutable state
- `tests/phase5-while-generator.js`
- `tests/pasync/loop-phase1-two-pass.js`
- `tests/pasync/loops.js`

4. capture/call assignment
- `tests/pasync/calls.js`
- `tests/pasync/script-output.js`
- capture-focused cases in `tests/pasync/script.js`

5. Mixed var/value coexistence
- add/adjust tests where both are declared and mutated in same script.

## 13) Migration Plan to Future `set`

Temporary phase:
- `set` = existing semantics
- `setval` = value semantics

Future convergence phase:
- migrate semantics from `setval` onto `set`
- remove `setval` once behavior is stable and tests updated

This reduces risk by isolating semantic changes behind an explicit temporary tag.

## 14) Open Decisions to Confirm Before Coding

1. Assignment to existing identifiers (`x = ...`) when both kinds are in scope:
- exact precedence and diagnostics.

2. Whether any `value`-specific immutability rules exist (if introduced later) and how they interact with set_path.

3. Error message harmonization:
- keep existing wording vs introduce kind-aware wording now.

4. Call/capture AST representation:
- whether to encode assignment kind in node payload or in emitted tag name only.

## 15) Practical Summary

Best path is to add `setval/endsetval` as a temporary template-layer semantic carrier for `value`, then reuse the existing var/set compiler-runtime machinery with minimal kind-aware extensions.

This preserves momentum, keeps changes elegant, and directly targets current failures in:
- path/property mutation
- guard variable recognition
- loop write tracking
- capture/call assignment flows
