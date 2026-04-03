# Documentation Audit: Gaps and Inaccuracies

Findings from a systematic comparison of user-facing docs (`docs/cascada/script.md`, `docs/cascada/template.md`) against the implementation.

---

## Critical Inaccuracy

### `revert` is documented as working but is not compiled

**Location:** `docs/cascada/template.md` — syntax table row 64, and the full `guard`/`recover`/`revert` section (lines 162–180).

**Problem:** `template.md` presents `{% revert %}` as a functional feature with a complete working example. In reality, neither `compiler-async.js` nor `compiler-sync.js` contains a `compileRevert()` method. When the compiler encounters a `Revert` node it throws:

> `compile: Cannot compile node: Revert`

The parser (`parser.js`) and `nodes.js` have the AST infrastructure in place, but compilation was never written.

**Contrast with script.md:** `script.md` correctly marks `revert` as "Work in progress" at line 1760.

**Evidence:**
- `src/nodes.js`: `class Revert extends Node` defined
- `src/parser.js` line 1190: `parseRevert()` exists
- `src/compiler/compiler-async.js`: no `compileRevert()` — throws on encounter
- `src/compiler/compiler-sync.js`: no `compileRevert()`

**Fix needed in template.md:** Remove the `revert` row from the syntax table (or mark it WIP), and replace the `### revert` example section with a WIP note matching the treatment in script.md.

---

## Documentation Gaps

### `without context` missing from template.md

`without context` is a valid clause on `import` and `from import` that explicitly opts out of render-context exposure. It is documented in `script.md` (lines 2089, 2096) but is entirely absent from `template.md` — not in the syntax table and not in the "Key rules" section.

**What is and is not supported (from parser.js):**

| Form | Supported |
|---|---|
| `import "file" as lib without context` | ✓ (`allowWithoutContext: true`, line 532) |
| `from "file" import helper without context` | ✓ (`allowWithoutContext: true`, line 584) |
| `include "file" without context` | ✗ (parser rejects — line 711) |
| `block name without context` | ✗ (parser rejects — line 645) |

**Fix needed in template.md:** Add two rows to the Script ↔ Template syntax table:
- `import "file" as lib without context` / `{% import "file" as lib without context %}`
- `from "file" import helper without context` / `{% from "file" import helper without context %}`

Add a mention in the "Key rules" section under Async Composition.

### `block with context` variant missing from syntax table

The parser accepts `block name with context` (and `block name with context, var1`) — `parseBlock` calls `parseCompositionWithClause` (line 645) which handles all `with` variants including `with context`. The syntax table (row 54) only shows `block name with var1, var2`. The `with context` form for blocks is not mentioned in the table or the "Key rules" section.

**Fix needed in template.md:** Add a note or table variant for `block name with context`.

---

## Intentional Omissions (No Change Needed)

These features exist in the code but are inherited from standard Nunjucks and are apparently intentionally not re-documented in the Cascada user docs. Listing them here for completeness.

| Feature | Syntax | Notes |
|---|---|---|
| Filter block | `{% filter upper %}...{% endfilter %}` | Applies a filter to a block of content. Parser + compiler support it. |
| Ignore missing | `{% include "file" ignore missing %}` | Silently skips missing included files. Parser supports it (`parser.js` line 718). |
| Raw / verbatim | `{% raw %}...{% endraw %}` | Prevents template parsing of enclosed content. |
| `asyncAll` loop | `asyncAll item in items ... endall` | Internal parallel loop keyword. Compiles identically to `for` (`compileAsyncAll` → `_compileAsyncForCore` with `sequentialLoopBody: false`). Not intended as user-facing syntax. |

---

## Summary

| Finding | Severity | Affected file |
|---|---|---|
| `revert` shown as working — throws compile error at runtime | **Critical** | `template.md` lines 64, 162–180 |
| `without context` missing from syntax table and key rules | **Gap** | `template.md` |
| `block with context` variant missing from syntax table | **Minor gap** | `template.md` line 54 |
| `filter`, `ignore missing`, `raw`, `asyncAll` undocumented | Intentional / OK | — |
