# Cascada Script Doc Alignment Notes

This document tracks how [script.md](/c:/Projects/cascada/docs/cascada/script.md) should stay aligned with the current implementation and tests.

## Scope

- Keep `script.md` focused on the current language only.
- Do not use this document for migration guidance or historical notes.
- Do not center removed syntax in either document.
- Prefer implementation-backed statements over rewrite plans based on older doc assumptions.

## Source of truth used

- Parser/compiler/runtime:
  - [parser.js](/c:/Projects/cascada/src/parser.js)
  - [script-transpiler.js](/c:/Projects/cascada/src/script/script-transpiler.js)
  - [compiler.js](/c:/Projects/cascada/src/compiler/compiler.js)
  - [compiler-base.js](/c:/Projects/cascada/src/compiler/compiler-base.js)
  - [validation.js](/c:/Projects/cascada/src/compiler/validation.js)
  - [runtime.js](/c:/Projects/cascada/src/runtime/runtime.js)
  - [channel.js](/c:/Projects/cascada/src/runtime/channel.js)
- Behavior/tests:
  - [script.js](/c:/Projects/cascada/tests/pasync/script.js)
  - [loader.js](/c:/Projects/cascada/tests/pasync/loader.js)
  - [script-transpiler.js](/c:/Projects/cascada/tests/script-transpiler.js)
  - [channels-explicit.js](/c:/Projects/cascada/tests/pasync/channels-explicit.js)

## Evaluation Summary

- `script.md` already presents the current channel model:
  - `var`
  - `data`
  - `text`
  - `sequence`
- `script.md` does not currently present removed legacy script syntax as active user syntax.
- `extern` is current behavior and should remain documented.
- `script.md` is directionally correct on modular scripts and async composition, but it still under-documents some tested edge behavior.
- The older version of this note was too focused on removed syntax and included at least one incorrect recommendation about `extern`.

## Confirmed Current Behavior To Keep In `script.md`

### Core model

- Variables use `var`.
- Structured and ordered writes use channels.
- `return` is the main way scripts and macros produce values.
- `snapshot()` is the read mechanism for channels when a materialized value is needed.

### Channels

- `data` is for structured object and array assembly.
- `text` supports append and overwrite behavior.
- `sequence` provides ordered reads and calls on an external object.

### Macros and call blocks

- Macros return values through normal `return`.
- Script `call` blocks are assignment-form only.
- Bare `call ... endcall` blocks should not be documented for scripts.

### Modular scripts

- `extern` is supported in scripts.
- `include`, `import`, `from ... import`, and `extends` / `block` should stay aligned with the current explicit input model.
- `with`, `with context`, and `without context` should be documented according to actual behavior.

### Composition details

- Async composition uses explicit contracts rather than ambient parent-scope visibility.
- `extern` is the current contract surface for child scripts/templates that expect inputs.
- `with name1, name2` passes explicit named inputs across composition boundaries.
- `with context` is separate from explicit named inputs:
  - it exposes render-context bare-name lookup,
  - it does not mean inherited explicit block inputs,
  - it does not expose parent local vars as ambient shared scope.
- `without context` should remain documented where composition isolation is explained.
- `include ... ignore missing` should be documented carefully:
  - if the target is absent, `ignore missing` skips extern-input validation and rendering continues,
  - if the target exists, extern-input validation still applies.
- Async overriding child blocks must not declare their own `with ...` clause.
- Base/invoking blocks own the explicit block-input contract.
- `block ... with context` should be documented as valid async composition behavior.
- Base block input names should be documented as ordinary local bindings inside the block body:
  - they can be rebound locally,
  - conflicting or duplicate declarations are rejected.
- Explicit block inputs should be documented as taking precedence over render-context names of the same name.
- `super()` should be documented as receiving the original invocation inputs, not child-local rebindings.
- Same-template and inherited block behavior should be documented in terms of explicit inputs plus template-local state, not shared parent lexical scope.
- Keep the docs user-facing:
  - describe the explicit contract model,
  - do not document internal runtime mechanisms such as composition source buffers, block-contract recovery, or channel-linking helpers.

### Guard and recovery

- `guard` and `recover` are current language features.
- Guard docs should stay aligned with actual selector support and current channel restrictions.
- `recover err` is documented today, but bare `recover` also appears to be accepted by the current script surface.
  - document whichever form is intended,
  - do not imply that `recover err` is the only valid spelling unless that is enforced.

### Current-Surface Checks To Resolve

- `depends` is listed as a line tag in the script transpiler (`script-transpiler.js`) and has transpiler tests confirming it passes through to template syntax.
  - However, `depends` has **no parser or compiler implementation** — it is not handled in `parser.js` or any compiler file.
  - Decision: **do not document `depends` in `script.md`** as user-facing script syntax. It is not currently supported at the parser/compiler level.
  - No note is required in `script.md` unless a user-visible restriction message makes it necessary.

## Documentation Guidance

- Describe only what is currently supported.
- Avoid historical or migration framing in the main script reference.
- Prefer direct examples of current syntax over rewrite notes about older forms.
- When a restriction matters, describe the restriction directly and briefly.
- Do not let old terminology shape chapter names or example design.

## Remaining Improvement Areas For `script.md`

- Keep strengthening `sequence` examples so read, call, and snapshot behavior are obvious.
- Keep API examples centered on explicit `return` and current channel usage.
- Keep modular-script examples aligned with `extern` and `with` semantics that are actually tested.
- Add documentation for `include ... ignore missing` with its two-case extern-validation behavior:
  - If the target file is **absent**: the include is silently skipped and extern-input validation is also skipped.
  - If the target file **exists**: it runs normally including extern-input validation.
  - The syntax can combine with `with` in any order: `include "file.script" ignore missing with user`.
  - Evidence: `tests/pasync/loader.js:1122–1149`, `nodes.js:234` (`ignoreMissing` node field), `parser.js` include parse.
- Add `block ... with context` to the `extends/block` section. It is valid syntax and tested:
  - A base block can use `with context` to expose render-context bare names to block bodies.
  - It can combine with explicit signatures: `block content(user) with context`.
  - The overriding child block inherits the `with context` visibility without re-declaring it.
  - Evidence: `tests/pasync/loader.js:1329–1334`, `tests/parser.js:760`, `nodes.js:210` (`Block.withContext` field).
- Document that explicit block inputs shadow render-context names of the same name:
  - When a block uses both `with context` and explicit signature args, the explicit block arg takes precedence over the render-context property of the same name.
  - Evidence: `tests/pasync/loader.js:1456–1461`.
- Add one short modular-composition note or example covering:
  - `extern`
  - `with`
  - `with context`
  - `ignore missing`
  - block input ownership in `extends` / `block`
  - `block ... with context`
  - explicit input precedence over render-context names
  - `super()` preserving invocation inputs
- `depends` is not currently supported script syntax (see Current-Surface Checks above) — no documentation needed in `script.md`.
- Clarify that both `recover` and `recover err` are valid script syntax:
  - The parser makes the error-binding variable optional (`parser.js` guard parse, `tests/pasync/channels-explicit.js:2380` uses bare `recover` in a live passing test).
  - The current guard syntax entry in `script.md` (`guard [targets] / recover err / endguard`) implies `err` is required — update the syntax table and the `recover` section to show the variable is optional.
- Keep macro and call-block examples aligned with assignment-form script syntax.

## Practical Editing Rule

Before changing `script.md`, verify the behavior in code or tests first. If a behavior is implemented and tested, document it as current. If a behavior is unsupported, omit it unless a short restriction note is necessary for clarity.
