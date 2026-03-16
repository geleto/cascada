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
* **No channels** — The `data`, `text`, `sink`, and `sequence` channel types are script-only; templates only output text
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
| **Macro Definition**     | `macro greet(name)`<br>  `...`<br>`endmacro`               | `{% macro greet(name) %}`<br>  `...`<br>`{% endmacro %}`                     |
| **Macro Calls**          | `var result = greet("Alice")`                              | `{{ greet("Alice") }}`                                                       |
| **Call Block**           | `var x = call wrapper()`<br>  `(param)`<br>  `return value`<br>`endcall` | `{% call wrapper() %}`<br>  `...`<br>`{% endcall %}`              |
| **Caller Invocation**    | `var result = caller(value)`                               | `{{ caller() }}`                                                             |
| **Block Assignment**     | *(not available in scripts)*                               | `{% set html %}`<br>  `...`<br>`{% endset %}`                                |
| **Template Inheritance** | `extends "base.html"`                                      | `{% extends "base.html" %}`                                                  |
| **Include**              | `include "header.html"`                                    | `{% include "header.html" %}`                                                |
| **Import namespace**     | `import "utils.html" as utils`                             | `{% import "utils.html" as utils %}`                                         |
| **Import names**         | `from "utils.html" import helper`                          | `{% from "utils.html" import helper %}`                                      |
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
- **Scripts return** — macros and call blocks produce values via explicit `return`. `caller()` returns the value that the call block body returned. The script's final result is whatever `return` produces (a plain value, a channel snapshot, or a composed object).

This means the same logical structure behaves differently across modes:

| | Cascada Script | Cascada Template |
|---|---|---|
| **Macro result** | Returned as a value — assign with `var result = myMacro(args)` | Rendered inline — invoke with `{{ myMacro(args) }}` |
| **`caller()` result** | Returns the call block's `return` value | Renders the call block's content inline |
| **Script/template result** | Explicit `return value` or `return ch.snapshot()` | Text accumulated in the output stream |

## Call Blocks and `caller()`

In Script mode, `caller()` returns the value explicitly returned by the call block body. Call blocks must always use assignment form:

```javascript
macro map(items)
  data results
  for item in items
    var result = caller(item)   // receives the call block's return value
    results.items.push(result)
  endfor
  return results.snapshot()
endmacro

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

## Variable Scoping in Async Mode

In Nunjucks and non-async Cascada templates, conditional statements (`if` and `switch`) do not create a variable scope. Variables set within these blocks are created in the parent scope.

In async Cascada templates, `if` and `switch` create local variable scopes. Variables set within these blocks are local to the block and not visible in the parent scope.

## Async Inheritance Scope Note

In async mode, variable scope changed:

* `include` in async templates retains access to parent-scope variables (for example, values set with `{% set %}` before the include).
* `extends` and `super` in scripts and async templates no longer can read parent-scope template variables.

## Unsupported Features

### Script features not available in templates

* **Channels**: `data`, `text`, `sink`, and `sequence` channel declarations are script-only
* **Property assignment**: `obj.prop = value` is not supported; use `{% set obj = ... %}` to reassign entire variables

### Template features not available in scripts

* **Implicit text output**: scripts have no implicit text rendering; use a `text` channel and return `t.snapshot()`
* **Block assignment** (`{% set var %}...{% endset %}`): not available in scripts; use a `text` channel instead
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
