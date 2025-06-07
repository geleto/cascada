# Cascada - async-enabled templating and scripting engine with automatic parallelization

### Write templates and scripts that look synchronous but execute concurrently under the hood.

**Note**: Cascada is under active development. Some features mentioned here may not be fully implemented, and this documentation may not yet reflect the latest changes.

Cascada is a powerful engine designed to dramatically simplify complex, asynchronous workflows. It allows you to write clean, synchronous-looking code that executes with maximum concurrency. The engine **automatically parallelizes** independent operations and **manages data dependencies**, delivering high performance without the boilerplate of manual async handling.

It offers both a familiar **template syntax** for generating text-based output and a clean **scripting language** for complex data orchestration, all powered by the same concurrent core. This makes Cascada exceptionally versatile, whether you're building a dynamic website, crafting detailed LLM prompts, or orchestrating multi-step AI agent workflows.

## Core Features

At its core, Cascada offers a set of powerful features available in both its templating and scripting modes:

<table>
<tr>
<td width="50%" valign="top">

### Automatic Parallelization

Cascada automatically identifies and executes **independent operations concurrently**, without any special syntax or configuration. Tasks that don't depend on each other run in parallel, dramatically speeding up execution time for I/O-bound workflows.

</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// The fetchUser() and fetchConfig() calls are independent
// and will run in parallel.

set user = fetchUser(123)
set config = fetchSiteConfig()

// The script waits here for both to complete before printing.
print "Welcome, " + user.name
print "Theme: " + config.theme
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# The fetchUser() and fetchConfig() calls are independent #}
{# and will run in parallel. #}

{% set user = fetchUser(123) %}
{% set config = fetchSiteConfig() %}

{# The template waits here for both to complete before rendering. #}
<p>Welcome, {{ user.name }}</p>
<p>Theme: {{ config.theme }}</p>
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Transparent Async Support

Work with **promises, `async` functions, and `async` iterators** as if they were synchronous values. Cascada automatically resolves them when they are needed, eliminating the need for `await` or promise-chaining syntax within your code.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// fetchPost and fetchComments are async functions/iterators.
// Cascada handles the promise resolution automatically.

set post = fetchPost(42)

// The loop waits for post to resolve, then iterates
// over the async comments iterator.
for comment in fetchComments(post.id)
  print comment.author + ": " + comment.body
endfor
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# fetchPost and fetchComments are async functions/iterators. #}
{# Cascada handles the promise resolution automatically. #}

{% set post = fetchPost(42) %}

<h1>{{ post.title }}</h1>
<ul>
  {# The loop waits for post to resolve, then iterates #}
  {# over the async comments iterator. #}
  {% for comment in fetchComments(post.id) %}
    <li>{{ comment.author }}: {{ comment.body }}</li>
  {% endfor %}
</ul>
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Smart Dependency Management

While independent operations run in parallel, Cascada ensures that **dependent operations wait for their prerequisites**. This guarantees the correct execution order and produces results identical to a sequential process, giving you the best of both worlds: performance and predictability.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// getUser() and getFooter() run in parallel.
// getPosts(user.id) depends on `user`, so it waits for
// getUser() to complete before starting.

set user = getUser()
set posts = getPosts(user.id)
set footer = getFooter()

print "User: " + user.name
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# getUser() and getFooter() run in parallel. #}
{# getPosts(user.id) depends on `user`, so it waits for #}
{# getUser() to complete before starting. #}

{% set user = getUser() %}
{% set posts = getPosts(user.id) %}
{% set footer = getFooter() %}

<div class="user">User: {{ user.name }}</div>
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Sequential Execution Control (`!`)

For functions with **side effects** (e.g., database writes), the `!` marker enforces a **sequential execution order** for a specific object path. Once a path is marked, *all* subsequent method calls on that path (even those without a `!`) will wait for the preceding operation to complete, while other independent operations continue to run in parallel.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// The `!` on deposit() creates a sequence for the 'account' path.
set account = getBankAccount()

account!.deposit(100)       // #1 in the sequence.
account.getStatus()         // #2, waits for deposit, uses updated state.
account!.withdraw(50)       // #3, waits for getStatus to complete.
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# The `!` on deposit() creates a sequence for 'account'. #}
{% set account = getBankAccount() %}

{% do account!.deposit(100) %}      {# #1 in the sequence. #}
{% do account.getStatus() %}        {# #2, waits for deposit. #}
{% do account!.withdraw(50) %}      {# #3, waits for getStatus. #}
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Consistent Output Assembly

**Note**: This feature is under active development for Cascada Script.

Both the final **text output of templates** and the **structured data from scripts** are assembled in a predictable, sequential order that matches your source code. This is true even when underlying async operations complete at different times, guaranteeing that the final result is always consistent.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// Assume fetchProductDetails for ID 205 is the slowest.
set productIds = [101, 205, 302]

// Each loop iteration runs in parallel.
for id in productIds
  // For each product, fetch details and reviews concurrently.
  set details = fetchProductDetails(id)
  set reviews = fetchProductReviews(id)

  // The final `report.products` array is built in the
  // order of `productIds` [101, 205, 302], not the
  // order in which the data for each product resolves.
  push report.products {
    id: details.id,
    name: details.name,
    reviewCount: reviews.length
  }
endfor
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# The final HTML is buffered and assembled sequentially. #}
<div class="slow-data">
  {{ fetchSlowData() }}
</div>

{# This div will always render second, even if its #}
{# data resolves faster than the one above. #}
<div class="fast-data">
  {{ fetchFastData() }}
</div>
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Resilient Error Handling

**Note**: This feature is under active development.

Handle runtime errors gracefully with **`try`/`resume`/`except`**. This structure lets you catch errors, define **conditional retry logic** with `resume`, and provide a final fallback. The special `resume.count` variable is **automatically managed by the engine** to track retry attempts.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
try
  // Attempt a fallible operation
  set image = generateImage(prompt)
  put result.imageUrl image.url
resume error.type == 'rate_limit' and resume.count < 3
  // Retry up to 3 times on rate limit errors
  print "Rate limited. Retrying attempt " + resume.count
except
  // Handle permanent failure
  put result.error "Image generation failed: " + error.message
endtry
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{% try %}
  {# Attempt a fallible operation #}
  {% set image = generateImage(prompt) %}
  <img src="{{ image.url }}" />
{% resume error.type == 'rate_limit' and resume.count < 3 %}
  <p>Rate limited. Retrying attempt {{ resume.count }}...</p>
{% except %}
  <p class="error">Image generation failed: {{ error.message }}</p>
{% endtry %}
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Powerful Template Composition

Build complex, modular templates using **`extends`** for inheritance, **`block`** for defining overrideable sections, **`include`** for embedding content, and **`import`** for reusing macros. Included templates and other async operations are processed concurrently.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// Import a script defining a 'process' macro
import-script "utils.script" as utils

// Fetch data in parallel
set items = fetchItems()
set config = fetchConfig()

// Use the imported macro to process the data
set processedItems = utils.process(items, config)
put result.items processedItems
```

</details>
<details>
<summary><strong>Cascada Template (`child.njk`)</strong></summary>

```njk
{% extends "base.njk" %}
{% import "macros.njk" as macros %}

{% block title %}My Page{% endblock %}

{% block content %}
  {% include "header.njk" %}
  
  <h1>{{ macros.page_title("Latest News") }}</h1>
  
  {% for item in fetchNews() %}
    <article>{{ item.title }}</article>
  {% endfor %}
{% endblock %}
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Rich Templating (Cascada Templates)

As a fork of the Nunjucks engine, Cascada provides a familiar, feature-rich syntax ideal for generating text-based output like HTML or for **crafting complex LLM prompts** by dynamically embedding data.
- **Full programming constructs**: `if`, `for`, `set`
- **First-class functions**: `{% macro %}`
- **Complex expressions** and filters

</td>
<td valign="top">
<details open>
<summary><strong>AI Prompt Generation Example</strong></summary>

```njk
Analyze the following meeting transcript and generate a summary.

MEETING CONTEXT:
- Topic: {{ fetchMeetingTopic(meetingId) }}
- Attendees: {{ (fetchAttendees(meetingId) | join(", ")) }}

TRANSCRIPT:
{{ fetchTranscript(meetingId) }}

KEY DECISIONS TO IDENTIFY:
{% for objective in ["Product Launch", "Budget Allocation", "Hiring"] %}
- Decisions related to: {{ objective }}
{% endfor %}

Based on the transcript, extract action items and assign owners.
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Powerful Scripting (Cascada Script)

For logic-heavy tasks and **AI agent orchestration**, Cascada Script offers a cleaner, delimiter-free syntax. It maintains all of Cascada's parallelization capabilities and adds specialized commands for building structured data results.
- **Clean, delimiter-free syntax**
- **Data assembly commands**: `put`, `push`, `merge`
- **Focus on logic and orchestration**

</td>
<td valign="top">
<details open>
<summary><strong>AI Orchestration Example</strong></summary>

```javascript
// 1. Generate a plan with an LLM call.
set plan = generatePlan("Analyze competitor's new feature")
put result.plan plan

// 2. Execute each step of the plan in parallel.
for step in plan.steps
  // Each `executeStep` call is an independent async operation.
  set stepResult = executeStep(step.instruction)
  push result.stepResults {
    step: step.title,
    result: stepResult
  }
endfor

// 3. Summarize the parallel results after all are complete.
set summary = summarizeResults(result.stepResults)
put result.summary summary
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Simple and Powerful API

Cascada provides a straightforward, **promise-based API** for rendering templates and scripts. Use the `AsyncEnvironment` class to get started.

For production, you can improve performance by **precompiling** your templates and scripts to JavaScript files, eliminating the parsing overhead at runtime.

</td>
<td valign="top">
<details open>
<summary><strong>Rendering a Template</strong></summary>

```javascript
import { AsyncEnvironment } from 'cascada-tmpl';

const env = new AsyncEnvironment();
const template = '<h1>Hello {{ username }}</h1>';
const context = {
  username: Promise.resolve('World')
};

const html = await env.renderString(template, context);
console.log(html); // <h1>Hello World</h1>
```

</details>
<details>
<summary><strong>Executing a Script</strong></summary>

```javascript
import { AsyncEnvironment } from 'cascada-tmpl';

const env = new AsyncEnvironment();
const script = 'put result.greeting "Hello, " + user.name';
const context = {
  user: fetchUser(123) // An async function
};

const data = await env.renderScriptString(script, context);
console.log(data); // { result: { greeting: "Hello, Alice" } }
```

</details>
</td>
</tr>
</table>

## Further Reading

- **Cascada Script:** [docs/cascada/script.md](docs/cascada/script.md)
- **Cascada Template:** [docs/cascada/template.md](docs/cascada/template.md)
- **Nunjucks (Original Engine):** [https://mozilla.github.io/nunjucks/](https://mozilla.github.io/nunjucks/)