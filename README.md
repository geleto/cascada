

# Cascada: The Parallel-First Scripting & Templating Engine

### Write simple synchronous-style code that runs concurrently

## Overview

### ⚡Parallel by default
Cascada is a powerful engine (with both a [template syntax](docs/cascada/template.md) and a [scripting language](docs/cascada/script.md)) designed to dramatically simplify complex, asynchronous workflows by fundamentally inverting the traditional programming model: instead of being sequential by default, Cascada is **parallel by default**.

### 🚦Data-Driven Flow: Code runs when its inputs are ready.
The engine intelligently analyzes your code, automatically executing independent operations - like API calls, LLM requests, and database queries - concurrently. It guarantees that operations will wait for their required inputs before executing, a smart orchestration that **eliminates race conditions by design** while delivering high performance without the complexity and boilerplate of manual async handling.

### 🎭 One Engine, Two Modes
This parallel-first philosophy is the foundation for both of its powerful modes:
* 🚀   A purpose-built **[scripting language](docs/cascada/script.md)** for orchestrating complex data pipelines. Use it as the backbone for your data layer to compose complex workflows, wiring together LLMs, APIs, databases, and external services with maximum I/O throughput, all while keeping the logic clean and readable.
* 📜   A familiar **[template syntax](docs/cascada/template.md)** for generating text-based output, ideal for dynamic websites, writing emails or crafting detailed LLM prompts.

### 📋Execution is chaotic, but the result is orderly
While this approach is powerful, Cascada recognizes that order is critical for operations with side-effects. For these specific cases, you can use the simple `!` marker to **enforce a strict sequential order on a specific chain of operations, without affecting the parallelism of the rest of your code.**

### ➡️Parallel by default, sequential by exception
While this "parallel-first" approach is powerful, Cascada recognizes that order is critical for operations with side-effects. For these specific cases, such as writing to a database, interacting with a stateful API or making LLM request, you can use the simple `!` marker to **enforce a strict sequential order on a specific chain of operations, without affecting the parallelism of the rest of the script.**.

This inversion - parallel by default, sequential by exception - is what makes Cascada so effective and intuitive.

**⚠️ Welcome to the Cutting Edge! ⚠️**
Cascada is a new project and is evolving quickly! This is exciting, but it also means things are in flux. You might run into bugs, and the documentation might not always align perfectly with the released code. It could be behind, have gaps, or even describe features that are planned but not yet implemented  (these are marked as under development). I am working hard to improve everything and welcome your contributions and feedback.

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
// The fetchUser() and fetchConfig() calls
// are independent and will run in parallel.

var user = fetchUser(123)
var config = fetchSiteConfig()

// Waits for both to complete before printing.
@text("Welcome, " + user.name)
@text("Theme: " + config.theme)
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# fetchUser() and fetchConfig() are independent #}
{# and will run in parallel. #}

{% set user = fetchUser(123) %}
{% set config = fetchSiteConfig() %}

{# Waits for both to complete. #}
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
// fetchPost is an async function
// fetchComments is an async iterator.

var post = fetchPost(42)

// Waits for post to resolve, then iterates
// over the async comments iterator.
for comment in fetchComments(post.id)
  @text(comment.author + ": " + comment.body)
endfor
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# fetchPost is async function. #}
{# fetchComments is async iterator. #}

{% set post = fetchPost(42) %}

<h1>{{ post.title }}</h1>
<ul>
  {# The loop iterates after post is resolved #}
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

### Data-Driven Flow

While independent operations run in parallel, Cascada ensures that **dependent operations wait for their prerequisites**. This guarantees the correct execution order and produces results identical to a sequential process, giving you the best of both worlds: performance and predictability.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// getUser(), getFooter() run in parallel.
// getPosts(user.id) depends on `user`,
// so it waits for getUser() to complete
// before starting.

var user = getUser()
var posts = getPosts(user.id)
var footer = getFooter()

@text("User: " + user.name)
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# getUser()/getFooter() run in parallel. #}
{# getPosts(user.id) waits for getUser() #}
{# to complete before starting. #}

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

For functions with **side effects** (e.g., database writes), the `!` marker enforces a **sequential execution order** for a specific object path. Once a path is marked, *all* subsequent access on that path (reads and calls without side effects do not need `!`) will wait for the preceding operation to complete, while other independent operations continue to run in parallel.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// The `!` on deposit() creates a
// sequence for the 'account' path.
var account = getBankAccount()

//1. Set initial Deposit:
account!.deposit(100)
//2. Get new status after the deposit:
account.getStatus()
//3. Withdraw money after getStatus()
account!.withdraw(50)
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# The `!` on deposit() creates a sequence for 'account'. #}
{% set account = getBankAccount() %}

{% do account!.deposit(100) %}
{% do account.getStatus() %}
{% do account!.withdraw(50) %}
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Consistent Output Commands Assembly

In scripts, **Output Commands**, marked with the `@` sigil, follow a **"Collect, Execute, Assemble"** model: they are buffered during parallel execution and then applied sequentially to build a final result, guaranteeing a predictable output order. The built-in `@data` handler uses this to provide a rich set of commands for building structured data, including assignment (`=`), array manipulation (`.push`, `.pop`), object merging (`.merge`), and even direct arithmetic (`+=`, `++`), string (`.append`), and logical (`||=`) operations. You can also add your own custom commands.

Similarly in templates, the final text output is also assembled in source-code order, guaranteeing that the rendered content is always predictable, even when built from multiple async operations that finish at different times.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// Assume fetchProductDetails for
// ID 205 is the slowest.
var productIds = [101, 205, 302]
@data.report.totalReviews = 0 // Initialize

// Each loop iteration runs in parallel.
for id in productIds
  // fetch concurrently:
  var details = fetchProductDetails(id)
  var reviews = fetchProductReviews(id)

  // The final `report.products` array is
  // built in the order of `productIds`
  // [101, 205, 302], not the order in
  // which the data resolves.
  @data.report.products.push({
    id: details.id,
    name: details.name,
    reviewCount: reviews.length
  })
  @data.report.totalReviews += reviews.length
endfor
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# The HTML is assembled sequentially. #}
<div class="slow-data">
  {{ fetchSlowData() }}
</div>

{# This div will always render second #}
<div class="fast-data">
  {{ fetchFastData() }}
</div>
```

</details>

<details>
<summary><strong>Using `capture` for Inline Data Assembly</strong></summary>

```javascript
// Use `capture` to run parallel operations
// and assign the assembled object to a variable.
var userProfile = capture :data
  // These run in parallel
  var details = fetchUserDetails(123)
  var preferences = fetchUserPrefs(123)

  // Assemble the final object
  @data.id = details.id
  @data.name = details.name
  @data.theme = preferences.theme
endcapture

// 'userProfile' is now a clean object:
// { id: 123, name: "Alice", theme: "dark" }
@data.profile = userProfile
```

</details>

<details>
  <summary><strong>Customizing the Data Object</strong></summary>

  ```javascript
  const env = new AsyncEnvironment();
  // You can add your own custom methods to the built-in
  // @data handler using env.addDataMethods().
  env.addDataMethods({
    upsert: (target, data) => {
      if (!Array.isArray(target)) return;
      const index = target.findIndex(item => item.id === data.id);
      if (index > -1) Object.assign(target[index], data);
      else target.push(data);
    }
  });

  const script = `// The built-in @data.push command
    @data.users.push({id: 1, name: "Alice", active: true})
    @data.users.push({id: 2, name: "Bob", active: true})

    // The custom @data.upsert command will UPDATE Alice.
    @data.users.upsert({id: 1, active: false})

    // This will ADD Charlie.
    @data.users.upsert({id: 3, name: "Charlie", active: true})`;

  console.log( await env.renderScriptString(
    script, {}, { output: 'data' }
  ));

  /*
  {
    users: [
      { id: 1, name: 'Alice', active: false },
      { id: 2, name: 'Bob', active: true },
      { id: 3, name: 'Charlie', active: true }
    ]
  }
  */
  ```
</details>

</td>
</tr>
<tr>
<td valign="top">

### Command Handlers

For scripts, the **Command Handlers** feature lets you specify classes and objects that execute commands.
You can add a class that executes custom commands with `addCommandHandlerClass`.
The custom commands are guaranteed to execute in-order and are much more efficient than the Sequential Execution feature, but they can't be async and the processing happens after rendering.

</td>
<td valign="top">

<details>
  <summary><strong>Custom Command Handlers - Class Setup</strong></summary>

  ```javascript
  // Turtle graphics on an HTML5 Canvas
  class CanvasTurtle {
    constructor(context) {
      this.ctx = context.canvas.getContext('2d');
      this.x = this.ctx.canvas.width / 2;
      this.y = this.ctx.canvas.height / 2;
      this.angle = -90; // Start pointing up
    }
    begin() {
      this.ctx.beginPath();
      this.ctx.moveTo(this.x, this.y);
    }
    forward(dist) {
      const rad = this.angle * (Math.PI / 180);
      this.x += dist * Math.cos(rad);
      this.y += dist * Math.sin(rad);
      this.ctx.lineTo(this.x, this.y);
    }
    turn(deg) { this.angle = (this.angle + deg) % 360; }
    stroke(color) {
      this.ctx.strokeStyle = color ?? 'white';
      this.ctx.stroke();
    }
  }
  ```
</details>

<details open>
  <summary><strong>Custom Command Handlers - Usage</strong></summary>

  ```javascript
  // Draw an 8-sided star using canvas
  const env = new AsyncEnvironment();
  env.addCommandHandlerClass('turtle',
    CanvasTurtle);
  const script = `// Draw an 8-point star
    @turtle.begin()
    for i in range(8)
      @turtle.forward(60)
      @turtle.turn(135)
    endfor
    @turtle.stroke('cyan')`;

  env.renderScriptString(script, {
    canvas:
      document.querySelector('canvas')
  });
  ```
</details>
</td>
</tr>
<tr>
<td valign="top">

### Macros for Reusable Components

Macros allow you to define reusable chunks of logic. In templates, they're great for repeated UI components. In scripts, they can perform complex, parallel async operations internally and return a clean, structured data object, making them the primary way to build modular, data-generating components. For single-use, inline data construction, the `capture` block provides a similar capability for assigning a complex, assembled result directly to a variable.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script (Macro)</strong></summary>

```javascript
// This macro fetches a user's details
// and recent activity in parallel and
// builds a summary object.
macro buildUserSummary(userId) : data
  // Run three async calls concurrently
  var details = fetchUserDetails(userId)
  var posts = fetchUserPosts(userId)
  var comments = fetchComments(userId)

  // Assemble the result:
  @data.summary.name = details.name
  @data.summary.postCount = posts.length
  @data.summary.comCount = comments.length
endmacro

// Call the macro for two different users,
// in parallel.
var user1 = buildUserSummary(101)
var user2 = buildUserSummary(102)

// Assemble the final report.
@data.report.user1Summary = user1.summary
@data.report.user2Summary = user2.summary
```

</details>
<details>
<summary><strong>Cascada Template (Macro)</strong></summary>

```njk
{#
  This macro generates a user profile widget.
  It works with a user object (which could be a promise)
  and fetches additional related data in parallel.
#}
{% macro profile_widget(user) %}
  <div class="profile-widget">
    <h2>{{ user.name }}</h2>
    <ul>
      {# These two fetches run in parallel #}
      <li>Followers:
        {{ fetchStats(user.id).followerCount }}
      </li>
      <li>Latest Post:
        "{{ fetchLatestPost(user.id).title }}"
      </li>
    </ul>
  </div>
{% endmacro %}

{# Fetch user data in parallel #}
{% set userA = fetchUser(1) %}
{% set userB = fetchUser(2) %}

{# Render widgets. Each widget will internally #}
{# perform its own parallel data fetches. #}
{{ profile_widget(userA) }}
{{ profile_widget(userB) }}
```

</details>
</td>
</tr>
<tr>
<td valign="top">


### Resilient Error Handling

**Note**: This feature is under development.

Handle runtime errors gracefully with **`try`/`resume`/`except`**. This structure lets you catch errors, define **conditional retry logic** with `resume`, and provide a final fallback. The special `resume.count` variable is **automatically managed by the engine** to track retry attempts.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
try
  // Attempt a fallible operation
  var image = generateImage(prompt)
  @data.result.imageUrl = image.url
resume resume.count < 3
  // Retry up to 3 times
  @text("Retrying attempt " + resume.count)
except
  // Handle permanent failure
  @data.result.error =
    "Image generation failed: " +
      error.message
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
{% resume resume.count < 3 %}
  <p>Retrying attempt {{ resume.count }}...</p>
{% except %}
  <p class="error">Image generation failed:
  {{ error.message }}</p>
{% endtry %}
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Modular Composition

**Note**: This feature is under development.

Build complex, modular templates using **`extends`** for inheritance, **`block`** for defining overrideable sections, **`include`** for embedding content, and **`import`** for reusing macros. Included templates and other async operations are processed concurrently.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// Import utils from a script
import "utils.script" as utils

// Fetch data in parallel
var items = fetchItems()
var config = fetchConfig()

// Use the imported utils.process
var items = utils.process(items, config)
@data.result.items = items
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

  <h1>
    {{ macros.page_title("Latest News") }}
  </h1>

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

### Rich Templating **[(Cascada Templates)](docs/cascada/template.md)**

As a fork of the Nunjucks engine, Cascada provides a familiar, feature-rich syntax ideal for generating text-based output like HTML or for **crafting complex LLM prompts** by dynamically embedding data.
- **Full programming constructs**: `if`, `for`, `set`
- **First-class functions**: `{% macro %}`
- **Complex expressions** and filters

</td>
<td valign="top">
<details open>
<summary><strong>AI Prompt Generation Example</strong></summary>

```njk
Analyze the following meeting
transcript and generate a summary.

MEETING CONTEXT:
- Topic: {{ fetchMeetingTopic(meetingId) }}
- Attendees: {{ (fetchAttendees(meetingId) |
   join(", ")) }}

TRANSCRIPT:
{{ fetchTranscript(meetingId) }}

KEY DECISIONS TO IDENTIFY:
{% for objective in ["Product Launch",
        "Budget Allocation", "Hiring"] %}
- Decisions related to: {{ objective }}
{% endfor %}

Based on the transcript, extract
action items and assign owners.
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Powerful Scripting **[(Cascada Script)](docs/cascada/script.md)**

For logic-heavy tasks and **AI agent orchestration**, Cascada Script offers a cleaner, delimiter-free syntax. It maintains all of Cascada's parallelization capabilities and adds specialized commands for building structured data results.
- **Clean, delimiter-free syntax**
- **Data assembly commands**: `@data.set`, `@data.push`, `@data.merge`
- **Focus on logic and orchestration**

</td>
<td valign="top">
<details open>
<summary><strong>AI Orchestration Example</strong></summary>

```javascript
// 1. Generate a plan with an LLM call.
var plan = makePlan(
  "Analyze competitor's new feature")
@data.result.plan = plan

// 2. Each step runs in parallel.
for step in plan.steps
  var stepResult =
    executeStep(step.instruction)
  @data.result.stepResults.push({
    step: step.title,
    result: stepResult
  })
endfor

// 3. Summarize the results once complete
var summary = summarize(result.stepResults)
@data.result.summary = summary
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

<summary><strong>Executing a Script</strong></summary>

```javascript
import {AsyncEnvironment} from 'cascada-tmpl';

const env = new AsyncEnvironment();
const script =
  '@data.result.greet = "Hello "+ user.name';
const ctx = {
  user: fetchUser(123) // An async function
};

const data = await env.renderScriptString(
  script, ctx, { output: 'data' }
);
console.log(data);
// { result: { greet: 'Hello, Alice' } }
```

</details>
<details>
<summary><strong>Rendering a Template</strong></summary>

```javascript
import {AsyncEnvironment} from 'cascada-tmpl';

const env = new AsyncEnvironment();
const tpl = '<h1>Hello {{ username }}</h1>';
const context = {
  username: Promise.resolve('World')
};

const html = await env.renderString(
  tpl,
  context
);
console.log(html); // <h1>Hello World</h1>
```
</details>
</td>
</tr>
</table>


## Quick Start
  1. Install Cascada:
     ```bash
     npm install cascada-tmpl
     ```
  2. Create a simple template:
     ```njk
     Hello, {{ name }}!
     ```
  3. Render a Cascada template
     ```javascript
     import { AsyncEnvironment } from 'cascada-tmpl';
     const env = new AsyncEnvironment();
     const result = await env.renderString('Hello, {{ name }}!', { name: 'World' });
     console.log(result); // Hello, World!
     ```
  4. Run a Cascada script
     ```javascript
     import { AsyncEnvironment } from 'cascada-tmpl';
     const env = new AsyncEnvironment();
     const script = `// Set initial user object
       @data.user = {name: 'Alice', id: 123, log: "User profile created. "}
       // Append to a string property within the data object
       @data.user.log.append("Login successful.")`;

     // The 'data' output focuses the result on the data object
     const { user } = await env.renderScriptString(script, {}, { output: 'data' });
     console.log(user.name);    // Alice
     console.log(user.log);     // User profile created. Login successful.
     ```

## Further Reading

- **Cascada Script:** [docs/cascada/script.md](docs/cascada/script.md)
- **Cascada Template:** [docs/cascada/template.md](docs/cascada/template.md)
- **Nunjucks (Original Engine):** [https://mozilla.github.io/nunjucks/](https://mozilla.github.io/nunjucks/)