
# Cascada: The Parallel-First Scripting & Templating Engine for TypeScript Applications

### Think Sequentially. Execute Concurrently.

The core philosophy of Cascada is to let you write asynchronous code with the clarity of synchronous logic. You write your scripts or templates as a straightforward set of instructions, and Cascada's engine handles the complex concurrent execution for you.

That said, Cascada isn’t a language you’d use to build an application. It’s a specialized scripting layer your TypeScript or JavaScript code can invoke whenever you need to orchestrate and run many interdependent async tasks in parallel without the usual boilerplate. Use it as the backbone for your data layer to compose complex workflows, wiring together LLMs, APIs, databases, and external services in parallel with maximum I/O throughput, all while keeping the logic clean and readable.

The most **up-to-date and complete information** on the features of Cascada can be found in the **[Cascada Script Documentation](docs/cascada/script.md)**!

## Read First

**Articles:**
- [Cascada Script Introduction](https://geleto.github.io/posts/cascada-script-intro/) - An introduction to Cascada Script's syntax, features, and how it solves real async programming challenges

- [The Kitchen Chef's Guide to Concurrent Programming with Cascada](https://geleto.github.io/posts/cascada-kitchen-chef/) - Understand how Cascada works through a restaurant analogy - no technical jargon, just cooks, ingredients, and a brilliant manager who makes parallel execution feel as natural as following a recipe

**Learning by Example:**
- [Casai Examples Repository](https://github.com/geleto/casai-examples) - After reading the articles, explore practical examples showing how Cascada and Casai (an AI orchestration framework built on Cascada) turn complex agentic workflows into readable, linear code - no visual node graphs or async spaghetti, just clear logic that tells a story (work in progress)

## Overview

### ⚡ Parallel by default
Cascada is a powerful engine for **JavaScript** and **TypeScript** applications, providing both a [scripting language](docs/cascada/script.md) and a [template syntax](docs/cascada/template.md). It is designed to dramatically simplify complex, asynchronous workflows by fundamentally inverting the traditional programming model: instead of being sequential by default, Cascada is **parallel by default**.

### 🚦 Data-Driven Flow: Code runs when its inputs are ready.
The engine intelligently analyzes your code, automatically executing independent asynchronous operations - like API calls, LLM requests, and database queries - concurrently. It guarantees that **operations will wait for their required inputs** before executing, a smart orchestration that **eliminates race conditions by design** while delivering high performance without the complexity and boilerplate of manual async handling.

### ✨ Implicit Concurrency: Write Business Logic, Not Async Plumbing.
Forget await. Forget .then(). Forget manually tracking which variables are promises and which are not. Cascada fundamentally changes how you interact with asynchronous operations by making them invisible.
This "just works" approach means that while any variable can be a promise under the hood, you can pass it into functions, use it in expressions, and assign it without ever thinking about its asynchronous state.

### 🎭 One Engine, Two Modes
This parallel-first philosophy is the foundation for both of its powerful modes:
* 🚀   A purpose-built **[scripting language](docs/cascada/script.md)** for orchestrating complex data pipelines. Use it as the backbone for your data layer to compose complex workflows, wiring together LLMs, APIs, databases, and external services in parallel with maximum I/O throughput, all while keeping the logic clean and readable. It offers a complete toolset for sophisticated logic with `variable declarations`, `conditionals`, `loops,` and `standard operators`. Create reusable components with `macros` and build modular applications using `import` and `extends`.
* 📜    A familiar **[template syntax](docs/cascada/template.md)** - Cascada is based on the popular [Nunjucks](https://mozilla.github.io/nunjucks/) template engine, for generating text-based output, ideal for dynamic websites, writing emails or crafting detailed LLM prompts.

### ➡️ Implicitly Parallel, Explicitly Sequential
While this "parallel-first" approach is powerful, Cascada recognizes that order is critical for operations with side-effects. For these specific cases, such as writing to a database, interacting with a stateful API or making LLM request, you can use the simple `!` marker to **enforce a strict sequential order on a specific chain of operations**, without affecting the parallelism of the rest of the code..

This inversion - Implicitly Parallel, Explicitly Sequential - is what makes Cascada so effective and intuitive.

### 📋 Execution is chaotic, but the result is orderly
While independent operations run in parallel and may start and complete in any order, Cascada guarantees the final output is identical to what you'd get from sequential execution. This means all your data manipulations are applied predictably, ensuring your final texts, arrays and objects are assembled in the exact order written in your script.

### ☣️ Dataflow Poisoning - Errors that flow like data
Cascada replaces traditional try/catch exceptions with a data-centric error model called **dataflow poisoning**. If an operation fails, it produces an `Error Value` that propagates to any dependent operation, variable and output. For example, if `fetchPosts()` fails, any variable or output using its result also becomes an error - but critically, unrelated operations continue running unaffected. You can detect and repair these errors, providing fallbacks and logging without derailing your entire workflow.

**⚠️ Heads up!** Cascada is a new project. You might run into bugs, and the documentation is catching up with the code. Your feedback and contributions are welcome as we build the future of asynchronous programming.

## Quick Start
1.  Install Cascada:
    ```bash
    npm install cascada-engine
    ```
2.  Render a Cascada template:
    ```javascript
    import { AsyncEnvironment } from 'cascada-engine';
    const env = new AsyncEnvironment();
    const result = await env.renderString('Hello, {{ name }}!', { name: 'World' });
    console.log(result); // Hello, World!
    ```
3.  Run a Cascada script:
    ```javascript
    import { AsyncEnvironment } from 'cascada-engine';
    const env = new AsyncEnvironment();
    const script = `// Set initial user object
      @data.user = {name: 'Alice', id: 123, log: "User profile created. "}
      // Append to a string property within the data object
      @data.user.log.append(" Login successful.")`;

    // The 'data' output focuses the result on the data object
    const { user } = await env.renderScriptString(script, {}, { output: 'data' });
    console.log(user.name); // Alice
    console.log(user.log);  // User profile created. Login successful.

## Core Concepts

At its core, Cascada offers a set of powerful features available in both its templating and scripting modes:

<table>
<tr>
<td width="50%" valign="top">

### Automatic Parallelization

Cascada automatically identifies and executes **independent operations concurrently**, without any special syntax or configuration. Tasks that don't depend on each other run in parallel, dramatically speeding up I/O-bound workflows.

</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// The fetchUser() and fetchConfig() calls
// are independent and will run in parallel.
var user = fetchUser(123)
var config = fetchSiteConfig()

// Waits for both to complete before use
@data.greeting = "Welcome, " + user.name
@data.theme = "Theme: " + config.theme
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

### Data-Driven Flow

While independent operations run in parallel, Cascada ensures that **dependent operations wait for their prerequisites**. This guarantees correct execution order and produces results identical to sequential code, giving you the performance of parallelism with the predictability of a synchronous process.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// getUser() and getFooter() run in parallel.
// getPosts(user.id) depends on `user`, so it
// waits for getUser() to complete before starting.
var user = getUser()
var posts = getPosts(user.id)
var footer = getFooter()

@text("User: " + user.name)
```

</details>
<details>
<summary><strong>Cascada Template</strong></summary>

```njk
{# getUser() and getFooter() run in parallel. #}
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

### Transparent Async Support

Work with **promises, `async` functions, and `async` iterators** as if they were synchronous values. Cascada automatically resolves them when they are needed, eliminating the need for `await` or promise-chaining syntax within your code.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// fetchPost is an async function.
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
{# fetchPost is an async function. #}
{# fetchComments is an async iterator. #}
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

### Declarative Data Assembly (`@` Commands)

In scripts, **Output Commands**, marked with the `@` sigil, follow a **"Collect, Execute, Assemble"** model: they are buffered during parallel execution and then applied sequentially to build a final result, guaranteeing a predictable output order. The built-in `@data` handler provides a rich set of declarative commands for building structured data, including assignment (`=`), array manipulation (`.push`), object merging (`.merge`), and even direct arithmetic (`+=`, `++`) or string (`.append`) operations.

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
<summary><strong>Using `capture` for Inline Data Assembly</strong></summary>

```javascript
// Use `capture` to run parallel operations
// and assign the assembled object to a variable.
var userProfile = capture :data
  // These run in parallel
  var details = fetchUserDetails(123)
  var prefs = fetchUserPrefs(123)

  // Assemble the final object
  @data.id = details.id
  @data.name = details.name
  @data.theme = prefs.theme
endcapture

// 'userProfile' is now a clean object:
// { id: 123, name: "Alice", theme: "dark" }
@data.profile = userProfile
```
</details>
<details>
<summary><strong>Cascada Template (Predictable Output)</strong></summary>

```njk
{# The final HTML is always assembled sequentially, #}
{# regardless of which fetch finishes first. #}
<div class="slow-data">
  {{ fetchSlowData() }}
</div>
{# This div will always render second. #}
<div class="fast-data">
  {{ fetchFastData() }}
</div>
```
</details>
</td>
</tr>
<tr>
<td valign="top">

### Custom Command Handlers

For scripts, the **Command Handlers** feature lets you create domain-specific logic by registering classes that receive and process `@` commands. These commands are guaranteed to execute in source order after all other async logic has completed. This is perfect for tasks like logging, database operations, or even drawing to a canvas.

</td>
<td valign="top">
<details>
  <summary><strong>Custom Handler Class (JavaScript)</strong></summary>

  ```javascript
  // Turtle graphics on an HTML5 Canvas
  class CanvasTurtle {
    constructor(context) {
      this.ctx = context.canvas.getContext('2d');
      this.x = this.ctx.canvas.width / 2;
      this.y = this.ctx.canvas.height / 2;
      this.angle = -90; // Start pointing up
    }
    begin() { this.ctx.beginPath(); this.ctx.moveTo(this.x, this.y); }
    forward(dist) {
      const rad = this.angle * (Math.PI / 180);
      this.x += dist * Math.cos(rad);
      this.y += dist * Math.sin(rad);
      this.ctx.lineTo(this.x, this.y);
    }
    turn(deg) { this.angle = (this.angle + deg) % 360; }
    stroke(color) { this.ctx.strokeStyle = color ?? 'white'; this.ctx.stroke(); }
  }
  ```
</details>
<details open>
  <summary><strong>Using the Custom Handler (Cascada Script)</strong></summary>

  ```javascript
  // Draw an 8-sided star using canvas
  const env = new AsyncEnvironment();
  env.addCommandHandlerClass('turtle', CanvasTurtle);

  // Use it in your script to draw a star.
  const script = `
    @turtle.begin()
    for i in range(8)
      @turtle.forward(60)
      @turtle.turn(135)
    endfor
    @turtle.stroke('cyan')`;

  // Provide the canvas context when rendering.
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

Macros allow you to define reusable chunks of logic. In templates, they're great for repeated UI components. In scripts, they can perform complex, parallel async operations internally and return a clean, structured data object, making them the primary way to build modular, data-generating components.

</td>
<td valign="top">
<details open>
<summary><strong>Cascada Script (Data-Building Macro)</strong></summary>

```javascript
// This macro fetches a user's details and
// recent activity in parallel and builds a summary.
macro buildUserSummary(userId) : data
  // Run three async calls concurrently
  var details = fetchUserDetails(userId)
  var posts = fetchUserPosts(userId)
  var comments = fetchUserComments(userId)

  // Assemble the result using @data commands
  @data.name = details.name
  @data.postCount = posts.length
  @data.commentCount = comments.length
endmacro

// Call the macro for two different users in parallel.
var user1 = buildUserSummary(101)
var user2 = buildUserSummary(102)

// Assemble the final report.
@data.report.user1Summary = user1
@data.report.user2Summary = user2
```
</details>
<details>
<summary><strong>Cascada Template (UI Macro)</strong></summary>

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
  @data.result.imageUrl = image.url
resume resume.count < 3
  // Retry up to 3 times
  @text("Retrying attempt " + resume.count)
except
  // Handle permanent failure
  @data.result.error = "Failed: " + error.message
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
</table>

## Two Modes, One Engine

Cascada's parallel-first core powers two distinct syntaxes, each tailored for a different primary purpose.

<table>
<tr>
<td width="50%" valign="top">

### Data-First: Cascada Script

For logic-heavy tasks, data pipelines, and **AI agent orchestration**, Cascada Script offers a cleaner, delimiter-free syntax. It maintains all of Cascada's parallelization capabilities and adds specialized `@` commands for declaratively building structured data results.
- **Clean, delimiter-free syntax**
- **Data assembly commands**: `@data.set`, `@data.push`, `@data.merge`
- **Focus on logic and orchestration**

</td>
<td width="50%" valign="top">
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

### Text-First: Cascada Template

As a superset of the popular Nunjucks engine, Cascada provides a familiar, feature-rich syntax ideal for generating text-based output like HTML, or for **crafting complex LLM prompts** by dynamically embedding data.
- **Full programming constructs**: `if`, `for`, `set`
- **Reusable UI components**: `{% macro %}`
- **Complex expressions** and filters

</td>
<td valign="top">
<details open>
<summary><strong>AI Prompt Generation Example</strong></summary>

```njk
Analyze the following meeting transcript
and generate a summary.

MEETING CONTEXT:
- Topic: {{ fetchMeetingTopic(meetingId) }}
- Attendees: {{ fetchAttendees(meetingId) | join(", ") }}

TRANSCRIPT:
{{ fetchTranscript(meetingId) }}

KEY DECISIONS TO IDENTIFY:
{% for objective in ["Product Launch", "Budget"] %}
- Decisions related to: {{ objective }}
{% endfor %}

Based on the transcript, extract action items.
```
</details>
</td>
</tr>
</table>


## Simple and Powerful API

Cascada provides a straightforward, **promise-based API** for rendering templates and scripts. Use the `AsyncEnvironment` class to get started. For production, you can improve performance by **precompiling** your templates and scripts to JavaScript files, eliminating the parsing overhead at runtime.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Executing a Script</strong></summary>

```javascript
import { AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();
const script = `
  // The 'user' promise resolves automatically
  @data.result.greet = "Hello, " + user.name
`;
const context = {
  // Pass in an async function or a promise
  user: fetchUser(123)
};

const data = await env.renderScriptString(
  script, context, { output: 'data' }
);
// { result: { greet: 'Hello, Alice' } }
console.log(data);
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Rendering a Template</strong></summary>

```javascript
import { AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();
const tpl = '<h1>Hello {{ username }}</h1>';
const context = {
  username: Promise.resolve('World')
};

const html = await env.renderString(
  tpl,
  context
);
// <h1>Hello World</h1>
console.log(html);
```
</details>
</td>
</tr>
</table>


## Built for AI Workflows

Cascada's parallel-first engine and data-driven flow make it the ideal foundation for orchestrating complex AI workflows. The **[Casai](https://github.com/geleto/casai)** library builds on this power, providing a high-level, intuitive API for wiring together LLMs, APIs, and data transformations. By integrating with the [Vercel AI SDK Core](https://sdk.vercel.ai/docs/ai-sdk-core), Casai lets you define sophisticated, multi-step agents using Cascada's scripting and templating.

Here's a short example of a self-improving agent built with Casai:
```javascript
import { openai } from '@ai-sdk/openai';
import { create } from 'casai';
import { z } from 'zod';

const baseConfig = create.Config({model: openai('gpt-4o')});

const draftGenerator = create.TextGenerator({
    prompt: 'Write a short, engaging blog post about {{ topic }}.',
}, baseConfig );

const critiqueGenerator = create.ObjectGenerator({
    schema: z.object({
        score: z.number().describe('Quality score from 1-10.'),
        suggestions: z.array(z.string()).describe('Actionable suggestions for improvement.'),
    }),
    prompt: 'Critique this blog post: {{ draft }}',
}, baseConfig);

const revisionGenerator = create.TextGenerator({
    prompt: 'Rewrite the following post based on these suggestions:\n\nPOST:\n{{ draft }}\n\nSUGGESTIONS:\n- {{ suggestions | join("\n- ") }}',
}, baseConfig);

// Define the orchestration script for the agent
const contentAgent = create.Script({
    context: {
      draftGenerator, critiqueGenerator, revisionGenerator,
      topic: "the future of AI-powered development",
      qualityThreshold: 8, maxRevisions: 3, minRevisions: 1
    },
    script: `:data
      var revisionCount = 0
      var currentDraft = draftGenerator({ topic: topic }).text
      var critique = critiqueGenerator({ draft: currentDraft }).object

      // Iteratively revise until the quality threshold or maxRevisions is met
      while (critique.score < qualityThreshold or revisionCount < minRevisions) and revisionCount < maxRevisions
        revisionCount = revisionCount + 1
        currentDraft = revisionGenerator({ draft: currentDraft, suggestions: critique.suggestions }).text
        critique = critiqueGenerator({ draft: currentDraft }).object
      endwhile

      @data = { finalDraft: currentDraft, finalScore: critique.score, revisionCount: revisionCount }`,
});

// Run the agent
const result = await contentAgent();
console.log(JSON.stringify(result, null, 2));
```

## Further Reading

- **Cascada Script Documentation:** [docs/cascada/script.md](docs/cascada/script.md)
- **Cascada Template Documentation:** [docs/cascada/template.md](docs/cascada/template.md)
- **Nunjucks (Original Engine):** [https://mozilla.github.io/nunjucks/](https://mozilla.github.io/nunjucks/)

## Development Status and Roadmap
See the roadmap section in the Cascada Script docsumentation: [docs/cascada/script.md#development-status-and-roadmap](docs/cascada/script.md#development-status-and-roadmap)