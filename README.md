# Cascada - async-enabled templating and scripting engine with automatic parallelization

### Write templates and scripts that look synchronous but execute concurrently under the hood.

**Note**: Cascada is under active development. Some features mentioned here may not be fully implemented, and this documentation may not yet reflect the latest changes.

Cascada is a powerful engine designed to dramatically simplify complex, asynchronous workflows. It allows you to write clean, synchronous-looking code that executes with maximum concurrency. The engine **automatically parallelizes** independent operations, **manages data dependencies** and eliminates race conditions while delivering high performance without the boilerplate of manual async handling.

It offers both a familiar **template syntax** for generating text-based output and a clean **scripting language** for complex data orchestration, all powered by the same concurrent core. This makes Cascada exceptionally versatile, whether you're building a dynamic website, crafting detailed LLM prompts, or orchestrating parallel multi-step AI agent workflows.

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
// The fetchUser() and fetchConfig() calls are
// independent and will run in parallel.

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

### Transparent Dependent Operations Management

While independent operations run in parallel, Cascada ensures that **dependent operations wait for their prerequisites**. This guarantees the correct execution order and produces results identical to a sequential process, giving you the best of both worlds: performance and predictability.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// getUser() and getFooter() run in parallel.
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
//2. Get updated status after initial deposit:
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

**Note**: The assembly commands feature is under development.

In scripts, **Output Commands**, marked with the `@` sigil, are buffered and assembled in a **predictable, sequential order**. They build a structured data object using a rich set of methods on the `@data` handler: `@data.set` (set/replace), `@data.push`/`@data.unshift` (add to array), `@data.pop`/`@data.shift` (remove from array), `@data.merge` (combine objects), and `@data.reverse`. You can also add your own custom commands.

Similarly in templates, the final text output is also assembled in source-code order, guaranteeing that the rendered content is always predictable, even when built from multiple async operations that finish at different times.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// Assume fetchProductDetails for
// ID 205 is the slowest.
var productIds = [101, 205, 302]

// Each loop iteration runs in parallel.
for id in productIds
  // fetch details and reviews concurrently.
  var details = fetchProductDetails(id)
  var reviews = fetchProductReviews(id)

  // The final `report.products` array is
  // built in the order of `productIds`
  // [101, 205, 302], not the order in which
  // the data for each product resolves.
  @data.report.products.push({
    id: details.id,
    name: details.name,
    reviewCount: reviews.length
  })
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

**Note**: This feature is under development.

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
  env.addCommandHandlerClass('turtle', CanvasTurtle);
  const script = `// Draw an 8-point star
    @turtle.begin()
    for i in range(8)
      @turtle.forward(60)
      @turtle.turn(135)
    endfor
    @turtle.stroke('cyan')`;

  env.renderScriptString(script,
    { canvas: document.querySelector('canvas') });
  ```
</details>
</td>
</tr>
<tr>
<td valign="top">

### Macros for Reusable Components

Macros allow you to define reusable chunks of logic. In templates, they're great for repeated UI components. In scripts, they can perform complex, parallel async operations internally and return a clean, structured data object, making them the primary way to build modular, data-generating components.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// This macro fetches a user's details and recent
// activity in parallel and builds a summary object.
macro buildUserSummary(userId) : data
  // These three async calls run concurrently
  // inside the macro.
  var details = fetchUserDetails(userId)
  var posts = fetchUserPosts(userId)
  var comments = fetchUserComments(userId)

  // Assemble the result after all fetches complete.
  @data.summary.name.set(details.name)
  @data.summary.postCount.set(posts.length)
  @data.summary.commentCount.set(comments.length)
endmacro

// Call the macro for two different users. These
// two macro calls will also run in parallel.
var user1 = buildUserSummary(101)
var user2 = buildUserSummary(102)

// Assemble the final report.
@data.report.user1Summary.set(user1.summary)
@data.report.user2Summary.set(user2.summary)
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

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
      <li>Followers: {{ fetchStats(user.id).followerCount }}</li>
      <li>Latest Post: "{{ fetchLatestPost(user.id).title }}"</li>
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
  @data.result.imageUrl.set(image.url)
resume resume.count < 3
  // Retry up to 3 times
  @text("Retrying attempt " + resume.count)
except
  // Handle permanent failure
  @data.result.error.set("Image generation failed: " + error.message)
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
  <p class="error">Image generation failed: {{ error.message }}</p>
{% endtry %}
```

</details>
</td>
</tr>
<tr>
<td valign="top">

### Modular Composition

Build complex, modular templates using **`extends`** for inheritance, **`block`** for defining overrideable sections, **`include`** for embedding content, and **`import`** for reusing macros. Included templates and other async operations are processed concurrently.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// Import a script defining a 'process' macro
import-script "utils.script" as utils

// Fetch data in parallel
var items = fetchItems()
var config = fetchConfig()

// Use the imported macro to process the data
var processedItems = utils.process(items, config)
@data.result.items.set(processedItems)
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

### Powerful Scripting (Cascada Script)

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
var plan = makePlan("Analyze competitor's new feature")
@data.result.plan.set(plan)

// 2. Each step of the plan runs in parallel.
for step in plan.steps
  // Each `executeStep` is an independent operation.
  var stepResult = executeStep(step.instruction)
  @data.result.stepResults.push({
    step: step.title,
    result: stepResult
  })
endfor

// 3. Summarize the results after all are complete.
var summary = summarizeResults(result.stepResults)
@data.result.summary.set(summary)
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
import { AsyncEnvironment } from 'cascada-tmpl';

const env = new AsyncEnvironment();
const script =
  '@data.result.greeting.set("Hello, " + user.name)';
const ctx = {
  user: fetchUser(123) // An async function
};

const data = await env.renderScriptString(
  script, ctx, { output: 'data' }
);
console.log(data);
// { result: { greeting: 'Hello, Alice' } }
```

</details>
<details>
<summary><strong>Rendering a Template</strong></summary>

```javascript
import { AsyncEnvironment } from 'cascada-tmpl';

const env = new AsyncEnvironment();
const tpl = '<h1>Hello {{ username }}</h1>';
const context = {
  username: Promise.resolve('World')
};

const html = await env.renderString(tpl, context);
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
       @data.user.set({name: 'Alice', id: 123, log: "User profile created. "})
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