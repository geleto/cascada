# Documentation Audit: Gaps and Inaccuracies

Findings from a systematic comparison of user-facing docs
([docs/cascada/script.md](/c:/Projects/cascada/docs/cascada/script.md),
[docs/cascada/template.md](/c:/Projects/cascada/docs/cascada/template.md))
against the implementation.

---

## Critical Inaccuracy

### `revert` is documented as working but is not compiled

**Location:** `docs/cascada/template.md` - syntax table row 64, and the full
`guard` / `recover` / `revert` section.

**Problem:** `template.md` presents `{% revert %}` as a functional feature with
a complete working example. In reality, neither `compiler-async.js` nor
`compiler-sync.js` contains a `compileRevert()` method. When the compiler
encounters a `Revert` node it throws:

> `compile: Cannot compile node: Revert`

The parser (`parser.js`) and `nodes.js` have the AST infrastructure in place,
but compilation was never written.

**Contrast with `script.md`:** `script.md` correctly marks `revert` as
"Work in progress."

**Evidence:**

- `src/nodes.js`: `class Revert extends Node` defined
- `src/parser.js`: `parseRevert()` exists
- `src/compiler/compiler-async.js`: no `compileRevert()`
- `src/compiler/compiler-sync.js`: no `compileRevert()`

**Fix needed in `template.md`:** Remove the `revert` row from the syntax table
or mark it WIP, and replace the `### revert` example section with a WIP note
matching the treatment in `script.md`.

---

## Documentation Gaps

### `without context` missing from `template.md`

`without context` is a valid clause on `import` and `from import` that
explicitly opts out of render-context exposure. It is documented in
`script.md`, but is entirely absent from `template.md`.

**What is and is not supported (from `parser.js`):**

| Form | Supported |
|---|---|
| `import "file" as lib without context` | yes |
| `from "file" import helper without context` | yes |
| `include "file" without context` | no |
| `block name without context` | no |

**Fix needed in `template.md`:**

- Add `import "file" as lib without context`
- Add `from "file" import helper without context`
- Mention `without context` in the async composition rules

### `block ... with context` wording needs post-Step-E cleanup

The current async block syntax is the explicit-signature form
`block name(args) with context`. The old `block name with context, var1` form
belonged to the removed legacy block-input model and is no longer valid after
Step E.

**Doc status:** `template.md` already documents the current explicit-signature
form with `{% block content(user) with context %}`. Any remaining references to
legacy block `with` inputs should be treated as historical notes, not current
syntax.

---

## Intentional Omissions (No Change Needed)

These features exist in the code but appear to be intentionally inherited from
standard Nunjucks rather than re-documented in the Cascada user docs.

| Feature | Syntax | Notes |
|---|---|---|
| Filter block | `{% filter upper %}...{% endfilter %}` | Parser and compiler support it. |
| Ignore missing | `{% include "file" ignore missing %}` | Parser supports it. |
| Raw / verbatim | `{% raw %}...{% endraw %}` | Prevents template parsing of enclosed content. |
| `asyncAll` loop | `asyncAll item in items ... endall` | Internal parallel loop keyword, not intended as user-facing syntax. |

---

## Summary

| Finding | Severity | Affected file |
|---|---|---|
| `revert` shown as working but throws compile error at runtime | Critical | `template.md` |
| `without context` missing from syntax table and key rules | Gap | `template.md` |
| `block ... with context` wording needed post-Step-E cleanup | Minor gap | `template.md` |
| `filter`, `ignore missing`, `raw`, `asyncAll` undocumented | Intentional / OK | - |
