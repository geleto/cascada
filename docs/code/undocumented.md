# User Documentation Follow-Ups

This note tracks user-facing documentation issues found while comparing
`docs/cascada/script.md` and `docs/cascada/template.md` with the current
implementation.

It is not an implementation plan. Items here should either be fixed in the user
docs or removed from this note once resolved.

## Current Follow-Ups

### Template `revert`

`docs/cascada/template.md` currently lists template `{% revert %}` as syntax.
The parser has a `Revert` node, but async/sync compiler support is not present
in the current source.

Until compilation is implemented, template docs should mark `revert` as
work-in-progress or remove working examples. Script docs already describe manual
`revert` as work-in-progress.

If a template containing `{% revert %}` is rendered, the compiler throws at
compile time with the message:

```
compile: Cannot compile node: Revert
```

This error is produced by the fallback branch in `CompilerCommon.compile()`
(`src/compiler/compiler-common.js`, line 66) because no `compileRevert`
method exists on the compiler.

Relevant source:

- `src/parser.js` parses `revert`
- `src/nodes.js` defines `Revert`
- `src/compiler/compiler-common.js` — `compile()` fallback throws the error above
- no `compileRevert(...)` method exists in any compiler file

### Template `without context`

`without context` is supported for template imports and from-imports but is not
yet documented in `docs/cascada/template.md`.

**Action required:** Add both supported forms to `template.md`'s syntax table
and to whatever section covers template composition context rules (imports,
from-imports, and context inheritance):

- `{% import "file.njk" as lib without context %}`
- `{% from "file.njk" import helper without context %}`

Unsupported forms (do not document as valid):

- `{% include "file.njk" without context %}`
- `{% block name without context %}`

### Block Context Syntax

The current async block context syntax is explicit-signature based:

```njk
{% block content(user) with context %}
```

Legacy block-input wording such as `block name with context, var1` should not be
used as current syntax.

## Intentional Omissions

These features exist but are inherited from standard Nunjucks behavior or are
internal enough that the Cascada user docs do not need to expand them unless a
new docs pass chooses to:

- filter blocks: `{% filter upper %}...{% endfilter %}`
- `ignore missing` includes
- `raw` / `verbatim`
- internal `asyncAll` loop syntax

## Cleanup Rule

When a listed issue is fixed in the user docs or implementation, update or
delete the corresponding section here. This file should stay small and current.
