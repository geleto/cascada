# Cascada Template Documentation

**Reference Documentation:**

* [Cascada Script Documentation](https://geleto.github.io/cascada-script/) — Complete reference for Cascada Script features
* [Nunjucks Templating Documentation](https://mozilla.github.io/nunjucks/templating.html) — Nunjucks syntax and features

This document focuses on the **differences** between Cascada Script and Cascada Template syntax. For complete coverage of features, consult the reference documentation above.

---

Cascada Templates provide an alternative syntax for writing Cascada workflows using a template-based approach similar to Nunjucks/Jinja2. While Cascada Script is optimized for data orchestration with explicit output commands, Cascada Templates are ideal for text generation with embedded logic.

Cascada maintains full compatibility with Nunjucks when running in non-async mode.

## Template vs Script: Key Differences

Cascada Templates are built on top of Nunjucks and support most Cascada Script **control-flow and expression** features, but with these key differences:

* **Text output is the default** — Content outside tags renders as text (no `@text()` needed)
* **Expressions in `{{ }}`** — Use double braces for value interpolation
* **No `@` output handlers** — The `@data`, `@text`, and custom handlers aren't used
* **Tags use `{% %}`** — All logic goes inside tag delimiters (use standard Nunjucks whitespace control where needed)
* **`set` for variables and assignment** — Use Nunjucks `{% set %}` syntax instead of Script’s `var` and `=`
* **`do` for execution-only expressions** — Standalone calls and sequence path repair (`!!`) use `{% do %}`

## Script ↔ Template Syntax Reference

| Feature                  | Cascada Script                                             | Cascada Template                                                             |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Text Output**          | `@text("Hello " + user.name)`                              | `Hello {{ user.name }}`                                                      |
| **Expressions**          | `@text(total * 1.2)`                                       | `{{ total * 1.2 }}`                                                          |
| **Variable Declaration** | `var user = fetchUser(1)`                                  | `{% set user = fetchUser(1) %}`                                              |
| **Assignment**           | `count = count + 1`                                        | `{% set count = count + 1 %}`                                                |
| **Multiple Variables**   | `var x, y = none`                                          | `{% set x, y = none %}`                                                      |
| **Comments**             | `// Single line`<br>`/* Multi line */`                     | `{# Single or multi-line #}`                                                 |
| **Filters**              | `@text(name \| upper)`                                     | `{{ name \| upper }}`                                                        |
| **Filter with Args**     | `@text(items \| join(", "))`                               | `{{ items \| join(", ") }}`                                                  |
| **Execution-only Call**  | `items.push("new")`                                        | `{% do items.push("new") %}`                                                 |
| **Sequence Path Repair** | `user.profile!!`                                           | `{% do user.profile!! %}`                                                    |
| **If Statement**         | `if user.age >= 18`<br>  `...`<br>`endif`                  | `{% if user.age >= 18 %}`<br>  `...`<br>`{% endif %}`                        |
| **For Loop**             | `for item in items`<br>  `...`<br>`endfor`                 | `{% for item in items %}`<br>  `...`<br>`{% endfor %}`                       |
| **Each Loop**            | `each item in items`<br>  `...`<br>`endeach`               | `{% each item in items %}`<br>  `...`<br>`{% endeach %}`                     |
| **While Loop**           | `while count < 10`<br>  `...`<br>`endwhile`                | `{% while count < 10 %}`<br>  `...`<br>`{% endwhile %}`                      |
| **Switch**               | `switch value`<br>  `case 1`<br>    `...`<br>`endswitch`   | `{% switch value %}`<br>  `{% case 1 %}`<br>    `...`<br>`{% endswitch %}`   |
| **Macro Definition**     | `macro greet(name)`<br>  `...`<br>`endmacro`               | `{% macro greet(name) %}`<br>  `...`<br>`{% endmacro %}`                     |
| **Macro Calls**          | `greet("Alice")`                                           | `{{ greet("Alice") }}`                                                       |
| **Block Capture**        | `var html = capture :text`<br>  `...`<br>`endcapture`      | `{% set html %}`<br>  `...`<br>`{% endset %}`                                |
| **Template Inheritance** | `extends "base.html"`                                      | `{% extends "base.html" %}`                                                  |
| **Include**              | `include "header.html"`                                    | `{% include "header.html" %}`                                                |
| **Import**               | `from "utils.html" import helper`                          | `{% from "utils.html" import helper %}`                                      |
| **Guard Block**          | `guard`<br>  `...`<br>  `recover`<br>  `...`<br>`endguard` | `{% guard %}`<br>  `...`<br>  `{% recover %}`<br>  `...`<br>`{% endguard %}` |
| **Revert**               | `revert`                                                   | `{% revert %}`                                                               |

## Examples

### Script Example

```javascript
:text

var user = fetchUser(userId)
var posts = fetchPosts(user.id)

@text("# User Profile\n\n")
@text("Name: " + user.name + "\n")
@text("Posts:\n")

for post in posts
  @text("- " + post.title + "\n")
endfor
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

## Block Captures

In Script mode, you can capture output into a variable using the `capture` block with a focus directive. Templates use a different approach.

### In Script Mode

Script uses `capture` with a focus directive to specify which output handler to use:

```javascript
var summary = capture :text
  @text("Total: " + items.length + " items")
endcapture

var userData = capture :data
  @data.name = user.name
  @data.count = items.length
endcapture
```

### In Template Mode

Templates use Nunjucks' block assignment syntax:

```nunjucks
{% set summary %}
  Total: {{ items.length }} items
{% endset %}
```

**Key differences:**

* Templates don't use the `capture` keyword — use `{% set %}...{% endset %}` instead
* Text output is the only mode — no focus directives needed

## The `do` Tag

The `{% do %}` tag executes expressions without rendering any output. Use it when you want something to **run**, not render.

In Script mode, the equivalent is simply writing the expression on its own line (without a keyword or assignment).

### Execution-only Calls

```nunjucks
{% set items = [] %}
{% do items.push("first") %}
{% do items.push("second") %}
{% do logger.info("Added " + items.length + " items") %}

Items: {{ items | join(", ") }}
```

### Sequence Path Repair (`!!`)

The sequence path repair operator `!!` repairs poisoned sequence paths. In templates, it must be used with `{% do %}`:

```nunjucks
{# Repair sequence path #}
{% do config.database.connection!! %}

{# Now safe to use #}
Database: {{ config.database.connection.host }}
```

## `guard`, `recover`, and `revert`

Cascada Templates support the same execution-control constructs as Cascada Script.
In templates, their relevant effect is that **text output from a scope may be skipped**.

### `guard` / `recover`

A `guard` defines a protected scope.
If the guard fails, **text output from the guarded block is skipped**.
An optional `recover` block may render alternative text on failure.

```nunjucks
{% guard %}
  {% do riskyCall() %}
  Operation succeeded.
{% recover err %}
  Operation failed: {{ err.message }}
{% endguard %}
```

### `revert`

`revert` unconditionally skips text output from the current capture, macro, or script scope.

## Variable Scoping in Async Mode

In Nunjucks and non-async Cascada templates, conditional statements (`if` and `switch`) do not create a variable scope. Variables set within these blocks are created in the parent scope.

In async Cascada templates, `if` and `switch` create local variable scopes. Variables set within these blocks are local to the block and not visible in the parent scope.

## Unsupported Features

The following Cascada Script features are **not available** in templates:

* **Output handlers**: `@data`, `@text`, and custom `@` commands (including all `@data.path` operations)
* **Output focus directives**: `:data`, `:text`, `:handlerName`
* **Property assignment**: `obj.prop = value` is not supported

**Note:** Templates only output text, so focus directives are not needed. Block captures use `{% set var %}...{% endset %}` without any focus directive. Like Nunjucks, property assignment is not supported—use `{% set %}` to reassign entire variables.

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