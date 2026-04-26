# Cascada Template Documentation

**Reference Documentation:**

* [Cascada Script Documentation](https://geleto.github.io/cascada-script/) — Complete reference for Cascada Script features
* [Nunjucks Templating Documentation](https://mozilla.github.io/nunjucks/templating.html) — Nunjucks syntax and features

This document focuses on the **differences** between Cascada Script and Cascada Template syntax. For complete coverage of features, consult the reference documentation above.

---

Cascada Templates provide an alternative syntax for writing Cascada workflows using a template-based approach similar to Nunjucks/Jinja2. While Cascada Script is optimized for data orchestration with explicit channel declarations, Cascada Templates are ideal for text generation with embedded logic.

Cascada maintains full compatibility with Nunjucks when running in non-async mode.

## Template vs Script: Key Differences

Cascada Templates are built on top of Nunjucks and support most Cascada Script **control-flow and expression** features, but with these key differences:

* **Text output is the default** — Content outside tags renders as text; in scripts, use a `text` channel to build text output explicitly
* **Expressions in `{{ }}`** — Use double braces for value interpolation
* **No channels** — The `data`, `text`, and `sequence` channel types are script-only; templates only output text
* **Tags use `{% %}`** — All logic goes inside tag delimiters (use standard Nunjucks whitespace control where needed)
* **`set` for variables and assignment** — Use Nunjucks `{% set %}` syntax instead of Script's `var` and `=`
* **`do` for execution-only expressions** — Standalone calls and sequence path repair (`!!`) use `{% do %}`

## Script ↔ Template Syntax Reference

| Feature                  | Cascada Script                                             | Cascada Template                                                             |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Text channel**         | `text t`                                                   | *(text output is implicit — no declaration needed)*                          |
| **Text Output**          | `t("Hello " + user.name)`                                  | `Hello {{ user.name }}`                                                      |
| **Expressions**          | `t(total * 1.2)`                                           | `{{ total * 1.2 }}`                                                          |
| **Variable Declaration** | `var user = fetchUser(1)`                                  | `{% set user = fetchUser(1) %}`                                              |
| **Assignment**           | `count = count + 1`                                        | `{% set count = count + 1 %}`                                                |
| **Multiple Variables**   | `var x, y = none`                                          | `{% set x, y = none %}`                                                      |
| **Comments**             | `// Single line`<br>`/* Multi line */`                     | `{# Single or multi-line #}`                                                 |
| **Filters**              | `t(name \| upper)`                                         | `{{ name \| upper }}`                                                        |
| **Filter with Args**     | `t(items \| join(", "))`                                   | `{{ items \| join(", ") }}`                                                  |
| **Execution-only Call**  | `service.notify(user)`                                     | `{% do service.notify(user) %}`                                              |
| **Sequence Path Repair** | `user.profile!!`                                           | `{% do user.profile!! %}`                                                    |
| **If Statement**         | `if user.age >= 18`<br>  `...`<br>`elseif ...`<br>  `...`<br>`else`<br>  `...`<br>`endif` | `{% if user.age >= 18 %}`<br>  `...`<br>`{% elseif ... %}`<br>  `...`<br>`{% else %}`<br>  `...`<br>`{% endif %}` |
| **For Loop**             | `for item in items`<br>  `...`<br>`endfor`                 | `{% for item in items %}`<br>  `...`<br>`{% endfor %}`                       |
| **Each Loop**            | `each item in items`<br>  `...`<br>`endeach`               | `{% each item in items %}`<br>  `...`<br>`{% endeach %}`                     |
| **While Loop**           | `while count < 10`<br>  `...`<br>`endwhile`                | `{% while count < 10 %}`<br>  `...`<br>`{% endwhile %}`                      |
| **Switch**               | `switch value`<br>  `case 1`<br>    `...`<br>`endswitch`   | `{% switch value %}`<br>  `{% case 1 %}`<br>    `...`<br>`{% endswitch %}`   |
| **Function Definition**  | `function greet(name)`<br>  `...`<br>`endfunction`         | `{% macro greet(name) %}`<br>  `...`<br>`{% endmacro %}`                     |
| **Function/Macro Calls** | `var result = greet("Alice")`                              | `{{ greet("Alice") }}`                                                       |
| **Call Block**           | `var x = call wrapper()`<br>  `(param)`<br>  `return value`<br>`endcall` | `{% call wrapper() %}`<br>  `...`<br>`{% endcall %}`              |
| **Caller Invocation**    | `var result = caller(value)`                               | `{{ caller() }}`                                                             |
| **Block Assignment**     | *(not available in scripts)*                               | `{% set html %}`<br>  `...`<br>`{% endset %}`                                |
| **Template Inheritance** | `extends "base.html"`                                      | `{% extends "base.html" %}`                                                  |
| **Inherited Override**   | `method name(arg1, arg2)`<br>  `...`<br>`endmethod`        | `{% block name(arg1, arg2) %}`<br>  `...`<br>`{% endblock %}`                |
| **Shared var declaration** | `shared var theme = "dark"`                              | *(inferred automatically — no declaration needed)*                           |
| **Shared var write**     | `this.theme = "dark"`                                      | `{% set this.theme = "dark" %}`                                              |
| **Shared var read**      | `this.theme`                                               | `{{ this.theme }}`                                                           |
| **Nested shared var read** | `this.user.name`                                         | `{{ this.user.name }}`                                                       |
| **Include**              | *(not supported in scripts)*                               | `{% include "file" %}`                                                       |
| **Include with inputs**  | *(not supported in scripts)*                               | `{% include "file" with context, var1, var2 %}`                              |
| **Import namespace**     | `import "file" as lib`                                     | `{% import "file" as lib %}`                                                 |
| **Import with inputs**   | `import "file" as lib with context, var1`                  | `{% import "file" as lib with context, var1 %}`                              |
| **Import names**         | `from "file" import helper`                                | `{% from "file" import helper %}`                                            |
| **From import with inputs** | `from "file" import helper with context, var1`          | `{% from "file" import helper with context, var1 %}`                         |
| **Extern (required)**    | `extern user`                                              | `{% extern user %}`                                                          |
| **Extern (with default)**| `extern theme = "light"`                                   | `{% extern theme = "light" %}`                                               |
| **Guard Block**          | `guard`<br>  `...`<br>  `recover`<br>  `...`<br>`endguard` | `{% guard %}`<br>  `...`<br>  `{% recover %}`<br>  `...`<br>`{% endguard %}` |
| **Revert**               | `revert`                                                   | `{% revert %}`                                                               |

## Examples

### Script Example

```javascript
var user = fetchUser(userId)
var posts = fetchPosts(user.id)

text output
output("# User Profile\n\n")
output("Name: " + user.name + "\n")
output("Posts:\n")

for post in posts
  output("- " + post.title + "\n")
endfor

return output.snapshot()
```

### Equivalent Template

```nunjucks
{% set user = fetchUser(userId) %}
{% set posts = fetchPosts(user.id) %}

# User Profile

Name: {{ user.name }}
Posts:
{% for post in posts %}
- {{ post.title }}
{% endfor %}
```

## The `do` Tag

The `{% do %}` tag executes expressions without rendering any output. In Script mode, the equivalent is simply writing the expression on its own line.

### Sequence Path Repair (`!!`)

The sequence path repair operator `!!` repairs poisoned sequence paths. In templates, it must be used with `{% do %}`:

```nunjucks
{# Repair sequence path #}
{% do config.database.connection!! %}

{# Now safe to use #}
Database: {{ config.database.connection.host }}
```


## Render vs Return: The Core Difference

Templates and scripts have a fundamentally different output model:

- **Templates render** — macros, call blocks, and the template itself write text directly to an output stream. `{{ expr }}` interpolates inline; `caller()` renders the call block's content inline at the point of invocation.
- **Scripts return** - functions and call blocks produce values via explicit `return`. `caller()` returns the value that the call block body returned. The script's final result is whatever `return` produces (a plain value, a channel snapshot, or a composed object).

This means the same logical structure behaves differently across modes:

| | Cascada Script | Cascada Template |
|---|---|---|
| **Function/macro result** | Script function returned as a value - assign with `var result = myFunction(args)` | Template macro rendered inline - invoke with `{{ myMacro(args) }}` |
| **`caller()` result** | Returns the call block's `return` value | Renders the call block's content inline |
| **Script/template result** | Explicit `return value` or `return ch.snapshot()` | Text accumulated in the output stream |

## Call Blocks and `caller()`

In Script mode, `caller()` returns the value explicitly returned by the call block body. Call blocks must always use assignment form:

```javascript
function map(items)
  data results
  for item in items
    var result = caller(item)   // receives the call block's return value
    results.items.push(result)
  endfor
  return results.snapshot()
endfunction

var mapped = call map([1, 2, 3])
  (n)
  return n * n   // explicit return — this is what caller() receives
endcall
```

```javascript
// assignment form (only form supported in scripts):
var x = call wrapper(args)
  (param)
  return value
endcall
```


## `guard`, `recover`, and `revert`

`guard` and `recover` work the same as in scripts. In templates, the relevant effect is that **text output from the guarded scope is discarded** if the guard fails (rather than restoring channel state, which is the script use case).

### `revert`

`revert` unconditionally triggers rollback of the current guard scope, discarding its output and running the `recover` block if present.

```nunjucks
{% guard %}
  {% set result = riskyCall() %}
  {% if result is error %}
    {% revert %}
  {% endif %}
  Result: {{ result }}
{% recover %}
  Could not load result.
{% endguard %}
```

## Async Composition (`extern`, `with`, inheritance contracts)

The full composition model — `extern`, `with`, `with context`, `extends ... with ...`, resolution order, pass-through patterns — is documented in [Composition and Loading](https://geleto.github.io/cascada-script/#composition-and-loading) in the script docs. The same rules apply to templates; only the syntax differs.

**Template-specific notes:**

- `include` is supported in templates (it is not available in scripts). It follows the same isolation and `with` rules as `import`.
- Template inheritance uses `{% block name(args) %}` / `{% endblock %}` where scripts use `method name(args)` / `endmethod`. Both support `this.blockName(args)` / `this.methodName(args)` for calling an override via inherited dispatch.
- `extern`, `with` clauses, and the explicit-contract model are **async-only**. In classic Nunjucks (sync) mode, `extern` is a compile error and templates retain implicit access to all parent-scope variables.

### Inheritance Example

```nunjucks
{# base.njk #}
{% extern theme = "light" %}
{% block content(user) with context %}
  Base {{ user }} / {{ siteName }} / {{ theme }}
{% endblock %}
```

```nunjucks
{# child.njk #}
{% set theme = "dark" %}
{% extends "base.njk" with theme %}

{% block content(user) %}
  {% set user = "Grace" %}
  Child {{ user }} / {{ siteName }} / {{ super() }}
{% endblock %}
```

Rendered with:

```javascript
{ user: "Ada", siteName: "Docs" }
```

Produces:

```text
Child Grace / Docs / Base Ada / Docs / dark
```

What this shows:

- `super()` still sees the original block argument `user = "Ada"`, even though the child reassigned the local `user` to `"Grace"`.
- `siteName` is visible inside both blocks because of `with context`, not because it is an explicit argument.
- `theme` comes from the `extends ... with ...` composition boundary, not from block arguments or render context.

### Shared State in Inherited Templates

In async templates that use `extends` or `block`, the `this.<name>` surface provides shared `var` state across the hierarchy — the template equivalent of `shared var` in scripts.

**Key differences from scripts:**

- No `shared` declarations are needed. The compiler infers shared vars from static `this.<name>` paths in the template source.
- Templates only have `var`-type values — there are no typed channels. Because the type is always `var`, the compiler can infer it and no declaration is needed.
- In a plain template that does not contain `extends` or `block`, `this` is an ordinary render-context variable and `this.<name>` is a normal property lookup — inference does not apply.
- Dynamic `this[expression]` is not supported in inheritance templates.

```nunjucks
{# base.njk #}
{% block body %}
  Theme: {{ this.theme }}
{% endblock %}
```

```nunjucks
{# child.njk #}
{% extends "base.njk" %}
{% set this.theme = "dark" %}
```

The child's `{% set this.theme = "dark" %}` writes the shared var before the constructor runs. The base's `{{ this.theme }}` inside the block reads it. Both templates infer `theme` automatically — no declaration required in either file.

## Variable Scoping

| Construct | Classic Nunjucks / sync | Async Cascada Template |
|---|---|---|
| `if` / `switch` | No scope — `{% set %}` writes to parent | Local scope — variables stay inside the branch |
| `for` / `each` loop body | All iterations share one inner scope that is discarded after the loop | Each iteration has its own isolated scope |
| `while` loop body | Uses the parent scope directly — `{% set %}` inside writes to the outer scope | Each iteration has its own isolated scope |
| `include` | Child sees all parent `{% set %}` variables | Isolated — child sees only explicit `with` inputs |
| `block` inputs | Not applicable | Declared by the block signature, e.g. `{% block content(user) %}`; available as locals inside the block |
| Child top-level `{% set %}` | Visible in the child's blocks | Visible in the child's own blocks |

The short version: in async mode every construct that can run concurrently gets its own scope, preventing race conditions between parallel iterations or branches.

## Unsupported Features

### Script features not available in templates

* **Channels**: `data`, `text`, and `sequence` channel declarations are script-only
* **Property assignment**: `obj.prop = value` is not supported; use `{% set obj = ... %}` to reassign entire variables

### Template features not available in scripts

* **Implicit text output**: scripts have no implicit text rendering; use a `text` channel and return `t.snapshot()`
* **Block assignment** (`{% set var %}...{% endset %}`): not available in scripts; use a `text` channel instead. Note: `{% set this.name = value %}` is distinct — it writes to the hierarchy's shared var `name`, not a block-captured text value.
* **`{{ }}` interpolation and `{% %}` tags**: script syntax uses no delimiters

## When to Use Templates vs Script

**Use Cascada Templates when:**

* Primary goal is text/HTML generation
* Output is predominantly static text with dynamic insertions
* Working with existing Nunjucks templates

**Use Cascada Script when:**

* Building structured data (JSON objects/arrays)
* Complex data orchestration workflows
* Need explicit control over multiple output streams
* Working with LLM orchestration or data pipelines
