# Cascada Template Documentation

**Reference Documentation:**

* [CascadaScript Documentation](https://geleto.github.io/cascada-script/) - Complete reference for CascadaScript features
* [Nunjucks Templating Documentation](https://mozilla.github.io/nunjucks/templating.html) - Nunjucks syntax and features

This document focuses on the differences between CascadaScript and Cascada Template syntax. For complete coverage of features, consult the reference documentation above.

---

Cascada Templates provide an alternative syntax for writing Cascada workflows using a template-based approach similar to Nunjucks/Jinja2. While CascadaScript is optimized for data orchestration with explicit channel declarations, Cascada Templates are ideal for text generation with embedded logic.

Cascada maintains full compatibility with Nunjucks when running in non-async mode.

**⚠️ Under active development:** Cascada is evolving rapidly - bugs are possible. Issues and contributions are very welcome.

## Template vs Script: Key Differences

Cascada Templates are built on top of Nunjucks and support most CascadaScript control-flow and expression features, but with these key differences:

* **Text output is the default** - Content outside tags renders as text; in scripts, use a `text` channel to build text output explicitly
* **Expressions in `{{ }}`** - Use double braces for value interpolation
* **No channels** - The `data`, `text`, and `sequence` channel types are script-only; templates only output text
* **Tags use `{% %}`** - All logic goes inside tag delimiters (use standard Nunjucks whitespace control where needed)
* **`set` for variables and assignment** - Use Nunjucks `{% set %}` syntax instead of Script's `var` and `=`
* **`do` for execution-only expressions** - Standalone calls and sequential path repair (`!!`) use `{% do %}`

## Render vs Return: The Core Difference

Scripts return values; templates render text. This applies uniformly to every callable construct:

| | CascadaScript | Cascada Template |
|---|---|---|
| **Overall result** | Explicit `return value` or `return ch.snapshot()` | Text accumulated in the output stream |
| **Function / macro** | Returns a value - `var result = fn(args)` | Renders text inline - `{{ macro(args) }}` |
| **Call block body** | Must `return` explicitly; outer form is `var x = call fn()` | Renders text; no explicit return |
| **`caller()`** | Returns the call block body's `return` value | Renders the call block body's text inline |
| **Method / block** | Returns a value via `return` | Renders text inline |
| **`super()`** | Returns the parent method's value | Renders the parent block's text |

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

### Sequential Path Repair (`!!`)

The sequential path repair operator `!!` repairs poisoned `!` paths. In templates, it must be used with `{% do %}`. A path must first be established with `!` before it can be checked or repaired:

```nunjucks
{% do api!.connect() %}

{% if api! is error %}
  {% do api!! %}
{% endif %}
```

## Script and Template Syntax Reference

| Feature                  | CascadaScript                                             | Cascada Template                                                             |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Text channel**         | `text t`                                                   | *(text output is implicit - no declaration needed)*                          |
| **Text channel write**   | `t("Hello " + user.name)`                                  | `Hello {{ user.name }}`                                                      |
| **Expressions**          | `t(total * 1.2)`                                           | `{{ total * 1.2 }}`                                                          |
| **Variable Declaration** | `var user = fetchUser(1)`                                  | `{% set user = fetchUser(1) %}`                                              |
| **Assignment**           | `count = count + 1`                                        | `{% set count = count + 1 %}`                                                |
| **Multiple Variables**   | `var x, y = none`                                          | `{% set x, y = none %}`                                                      |
| **Comments**             | `// Single line`<br>`/* Multi line */`                     | `{# Single or multi-line #}`                                                 |
| **Filters**              | `t(name \| upper)`                                         | `{{ name \| upper }}`                                                        |
| **Filter with Args**     | `t(items \| join(", "))`                                   | `{{ items \| join(", ") }}`                                                  |
| **Execution-only Call**  | `service.notify(user)`                                     | `{% do service.notify(user) %}`                                              |
| **Sequential Path Repair** | `api!!`                                                  | `{% do api!! %}`                                                             |
| **If Statement**         | `if user.age >= 18`<br>  `...`<br>`elif ...`<br>  `...`<br>`else`<br>  `...`<br>`endif` | `{% if user.age >= 18 %}`<br>  `...`<br>`{% elseif ... %}` or `{% elif ... %}`<br>  `...`<br>`{% else %}`<br>  `...`<br>`{% endif %}` |
| **For Loop**             | `for item in items`<br>  `...`<br>`endfor`                 | `{% for item in items %}`<br>  `...`<br>`{% endfor %}`                       |
| **Each Loop**            | `each item in items`<br>  `...`<br>`endeach`               | `{% asyncEach item in items %}`<br>  `...`<br>`{% endeach %}`                |
| **While Loop**           | `while count < 10`<br>  `...`<br>`endwhile`                | `{% while count < 10 %}`<br>  `...`<br>`{% endwhile %}`                      |
| **Switch**               | `switch value`<br>  `case 1`<br>    `...`<br>`endswitch`   | `{% switch value %}`<br>  `{% case 1 %}`<br>    `...`<br>`{% endswitch %}`   |
| **Function Definition**  | `function greet(name)`<br>  `...`<br>`endfunction`         | `{% macro greet(name) %}`<br>  `...`<br>`{% endmacro %}`                     |
| **Function/Macro Calls** | `var result = greet("Alice")`                              | `{{ greet("Alice") }}`                                                       |
| **Call Block**           | `var x = call wrapper()`<br>  `(param)`<br>  `return value`<br>`endcall` | `{% call wrapper() %}`<br>  `...`<br>`{% endcall %}`              |
| **Caller Invocation**    | `var result = caller(value)`                               | `{{ caller() }}`                                                             |
| **Block Assignment**     | *(not available in scripts)*                               | `{% set html %}`<br>  `...`<br>`{% endset %}`                                |
| **Template Inheritance** | `extends "base.html"`                                      | `{% extends "base.html" %}`                                                  |
| **Inherited Override**   | `method name(arg1, arg2)`<br>  `...`<br>`endmethod`        | `{% block name(arg1, arg2) %}`<br>  `...`<br>`{% endblock %}`                |
| **Shared var declaration** | `shared var theme = "dark"`                              | *(inferred automatically - no declaration needed)*                           |
| **Shared var write**     | `this.theme = "dark"`                                      | `{% set this.theme = "dark" %}`                                              |
| **Shared var read**      | `this.theme`                                               | `{{ this.theme }}`                                                           |
| **Nested shared var read** | `this.user.name`                                         | `{{ this.user.name }}`                                                       |
| **Include**              | *(not supported in scripts)*                               | `{% include "file" %}`                                                       |
| **Include with inputs**  | *(not supported in scripts)*                               | `{% include "file" with context, var1, var2 %}`                              |
| **Import namespace**     | `import "file" as lib`                                     | `{% import "file" as lib %}`                                                 |
| **Import with inputs**   | `import "file" as lib with context, var1`                  | `{% import "file" as lib with context, var1 %}`                              |
| **Import with object**   | `import "file" as lib with { key: expr }`                  | `{% import "file" as lib with { key: expr } %}`                              |
| **Import names**         | `from "file" import helper`                                | `{% from "file" import helper %}`                                            |
| **From import with inputs** | `from "file" import helper with context, var1`          | `{% from "file" import helper with context, var1 %}`                         |
| **Guard Block**          | `guard`<br>  `...`<br>  `recover`<br>  `...`<br>`endguard` | `{% guard %}`<br>  `...`<br>  `{% recover %}`<br>  `...`<br>`{% endguard %}` |

## Call Blocks and `caller()`

In scripts, call blocks must always use assignment form:

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
  return n * n   // explicit return - this is what caller() receives
endcall
```

```javascript
// assignment form (only form supported in scripts):
var x = call wrapper(args)
  (param)
  return value
endcall
```


## `guard` and `recover`

`guard` and `recover` work the same as in scripts. In templates, the relevant effect is that text output from the guarded scope is discarded if the guard fails (rather than restoring channel state, which is the script use case).

### Manual `revert`

Manual `revert` is not available yet in async templates. Use ordinary error flow inside a `guard`: if the guarded block remains poisoned, Cascada discards its output and runs `recover`.

```nunjucks
{% guard %}
  {% set result = riskyCall() %}
  Result: {{ result }}
{% recover %}
  Could not load result.
{% endguard %}
```

## Async Composition (`with` Payloads and Inheritance Contracts)

The full composition model - `with`, `with context`, `extends ... with ...`, resolution order, pass-through patterns - is documented in [Composition and Loading](https://geleto.github.io/cascada-script/#composition-and-loading) in the script docs. The same rules apply to templates; only the syntax differs.

**Template-specific notes:**

- `include` is supported in templates (it is not available in scripts). It follows the same isolation and `with` rules as `import`.
- Template inheritance uses `{% block name(args) %}` / `{% endblock %}` where scripts use `method name(args)` / `endmethod`. Both support `this.blockName(args)` / `this.methodName(args)` for calling an override via inherited dispatch.
- `with` clauses and the explicit payload model are async-only. In classic Nunjucks (sync) mode, templates retain implicit access to all parent-scope variables.

### Blocks in Async Templates

Classic Nunjucks blocks have implicit access to the caller's scope. Cascada async blocks are isolated - they receive data only through declared arguments, with `with context` optionally exposing render-context names:

```nunjucks
{# Nunjucks - block sees caller's local variables implicitly #}
{% set user = getUser() %}
{% block greeting %}
  Hello {{ user.name }}
{% endblock %}

{# Cascada async - block receives data through declared arguments #}
{% set user = getUser() %}
{% block greeting(user) %}
  Hello {{ user.name }}
{% endblock %}
```

- `{% block name(arg1, arg2) %}` - block-local arguments; local variables that shadow render-context names.
- `{% block name(args) with context %}` - also exposes render-context bare names.
- Overrides must match the parent's signature exactly, including `with context`.
- `super()` renders the parent block with the original block arguments.

### Inheritance Example

```nunjucks
{# base.njk #}
{% block content(user) with context %}
  Base {{ user }} / {{ siteName }} / {{ theme or "light" }}
{% endblock %}
```

```nunjucks
{# child.njk #}
{% set theme = "dark" %}
{% extends "base.njk" with theme %}

{% block content(user) with context %}
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
- `theme` comes from the `extends ... with ...` payload, not from block arguments or render context.

### Shared State in Inherited Templates

In async templates that use `extends` or `block`, the `this.<name>` surface provides shared `var` state across the hierarchy - the template equivalent of `shared var` in scripts.

**Key differences from scripts:**

- No `shared` declarations are needed. The compiler infers shared vars from static `this.<name>` paths in the template source.
- Templates only have `var`-type values - there are no typed channels. Because the type is always `var`, the compiler can infer it and no declaration is needed.
- In a plain template that does not contain `extends` or `block`, `this` is an ordinary render-context variable and `this.<name>` is a normal property lookup - inference does not apply.
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

The child's `{% set this.theme = "dark" %}` writes the shared var before the constructor runs. The base's `{{ this.theme }}` inside the block reads it. Both templates infer `theme` automatically - no declaration required in either file.

## Variable Scoping

### Concurrency Isolation

In async mode, every construct that can run concurrently gets its own isolated scope, preventing race conditions between concurrent branches or iterations:

| Construct | Classic Nunjucks / sync | Async Cascada Template |
|---|---|---|
| `if` / `switch` | No scope - `{% set %}` writes to parent | Local scope - variables stay inside the branch |
| `for` / `each` loop body | All iterations share one inner scope that is discarded after the loop | Each iteration has its own isolated scope |
| `while` loop body | Uses the parent scope directly - `{% set %}` inside writes to the outer scope | Each iteration has its own isolated scope |

### Composition Isolation

All composition boundaries are isolated in async mode - the child sees only what is explicitly passed in, not the caller's local variables:

| Construct | Classic Nunjucks / sync | Async Cascada Template |
|---|---|---|
| `include` | Sees all caller's `{% set %}` variables | Isolated - sees only explicit `with` inputs |
| `import` | Macros see only their own arguments | Isolated - sees only explicit `with` inputs |
| `block` | Sees caller's frame | Isolated - sees only declared block arguments and `with context` names |
| Child top-level `{% set %}` | Visible in the child's own blocks | Visible in the child's own blocks |

### Passing Data with `with`

All Cascada composition operations support `with` for passing data across isolation boundaries - the same syntax as in scripts, and unlike classic Nunjucks which has no equivalent. See [`with`: Composition Payload](https://geleto.github.io/cascada-script/#with-composition-payload) in the script docs for the full rules.

## Unsupported Features

### Script features not available in templates

* **Channels**: `data`, `text`, and `sequence` channel declarations are script-only
* **Property assignment**: `obj.prop = value` is not supported; use `{% set obj = ... %}` to reassign entire variables

### Template features not available in scripts

* **Implicit text output**: scripts have no implicit text rendering; use a `text` channel and return `t.snapshot()`
* **Block assignment** (`{% set var %}...{% endset %}`): not available in scripts; use a `text` channel instead. Note: `{% set this.name = value %}` is distinct - it writes to the hierarchy's shared var `name`, not a block-captured text value.
* **`{{ }}` interpolation and `{% %}` tags**: script syntax uses no delimiters

## When to Use Templates vs Script

**Use Cascada Templates when:**

* Primary goal is text/HTML generation
* Rendered text is predominantly static with dynamic insertions
* Working with existing Nunjucks templates

**Use CascadaScript when:**

* Building structured data (JSON objects/arrays)
* Complex data orchestration workflows
* Need explicit control over multiple output streams
* Working with LLM orchestration or data pipelines

## API Notes

Cascada keeps Nunjucks-compatible API names where useful, but new code should use the `cascada-engine` package name and Cascada class/function names. See the [CascadaScript API section](script.md#api-reference) for the canonical API surface.

### ESM And Browser Usage

Prefer ESM imports in Node and modern browser builds. The main entry can compile from source:

```javascript
import { AsyncEnvironment, FileSystemLoader } from 'cascada-engine';

const env = new AsyncEnvironment(new FileSystemLoader('templates'));
const html = await env.renderTemplate('page.njk', data);
```

Use the precompiled entry when templates or scripts are compiled ahead of time and the app only needs the runtime. This entry does not import the compiler, parser, lexer, or precompile API:

```javascript
import { AsyncEnvironment as PrecompiledEnvironment, PrecompiledLoader } from 'cascada-engine/precompiled';
```

Old Nunjucks-style UMD bundles and automatic `window.nunjucks` globals are not supported by the ESM package. Use ESM imports in browser code.
