# Cascada - async-enabled templating with automatic parallelization

Cascada is a fork of the [Nunjucks](https://github.com/mozilla/nunjucks) template engine designed to handle asynchronous operations seamlessly. It automatically parallelizes independent components during rendering while managing data dependencies, all without requiring special syntax or explicit async handling.

**Note**: This is an ongoing project under active development. For details on the current progress and remaining tasks, please refer to the [Development Status and Roadmap](#development-status-and-roadmap) section.

## Table of Contents
- [Background](#background)
- [Why Cascada?](#why-cascada)
  - [1. Transparent Async Support](#1-transparent-async-support)
  - [2. Automatic Parallel Processing](#2-automatic-parallel-processing)
  - [3. Smart Dependency Management](#3-smart-dependency-management)
- [Core Async Features](#core-async-features)
  - [Asynchronous Data](#asynchronous-data)
  - [Async Iterators and Generators](#async-iterators-and-generators)
- [API](#api)
  - [Getting Started](#getting-started)
  - [Key Differences](#key-differences)
- [Parallelization Examples](#parallelization-examples)
  - [1. Variables](#1-variables)
  - [2. Expressions](#2-expressions)
  - [3. Async Functions](#3-async-functions)
  - [4. Loop Iterations](#4-loop-iterations)
  - [5. Template Includes](#5-template-includes)
  - [6. Async Filters](#6-async-filters)
- [Templating Features](#templating-features)
- [Technical Constraints](#technical-constraints)
  - [Cross-Template Variable Access](#cross-template-variable-access)
  - [Dependency Declarations](#dependency-declarations)
- [Development Status and Roadmap](#development-status-and-roadmap)
- [Best Practices](#best-practices)

## Background

Traditional template engines either require pre-resolving all async data before rendering or use special syntax for async operations. None provide automatic parallelization - operations run sequentially by default, and any parallel processing requires explicit orchestration through special constructs.

Cascada was developed with AI agent workflows in mind, where template rendering often involves multiple long-running operations like LLM calls, reasoning steps, or external API requests.

## Why Cascada?

Cascada takes a radically different approach by making async operation handling completely transparent while maximizing performance through automatic parallelization:

### 1. Transparent Async Support
- Use promises, async functions, and async iterators anywhere in your templates
- No special syntax needed - write templates as if all data were synchronous

### 2. Automatic Parallel Processing
- Independent operations execute concurrently without setup and configuration
- The engine identifies operations that can run in parallel

### 3. Smart Dependency Management
- Ensures correct execution order
- Related operations wait for prerequisites while unrelated ones proceed in parallel

## Core Async Features

#### Asynchronous Data
Promise values and functions can be added to the context object or as globals:
```javascript
env.addGlobal('footer', fetch('https://api.example.com/global/footer').then(res => res.text()));

const context = {
    user: fetch('https://api.example.com/user/1').then(res => res.json()),
    getPosts: (userId) => fetch(`https://api.example.com/users/${userId}/posts`).then(res => res.json())
}
```
Use naturally in templates:
```njk
<h1>Welcome {{ user.name }}!</h1>
{% for post in getPosts(user.id) %}
    <article>
		<h2>{{ post.title }}</h2>
		<div class="content">{{ post.content }}</div>
	</article>
{% endfor %}
<footer>{{ footer.content }}</footer>
```

#### Async Iterators and Generators
Handle sequences of asynchronous values generated over time, ideal for processing async data as it becomes available from APIs, streams, message queues, or dependent iterations.
```javascript
env.addGlobal('crawlPages', async function* (url) {
    do {
        const page = await fetchDOM(url);
        yield page;
        url = page.next;
    } while (url);
});
```

```njk
{% for page in crawlPages('https://api.example.com/start') %}
    <h2>{{ page.title }}</h2>
    <p>{{ page.description }}</p>
{% endfor %}
```

## API

While Cascada maintains compatibility with the traditional [Nunjucks API](https://mozilla.github.io/nunjucks/api.html) that uses callbacks, it introduces a simpler promise-based API for working with async templates.

#### Getting Started
```javascript
const { AsyncEnvironment } = require('cascada');

const env = new AsyncEnvironment();
const context = {
  data: Promise.resolve({ message: "Hello" })
};

env.renderString("Message: {{ data.message }}", context)
   .then(result => console.log(result));
```

#### Key Differences:

1. Use `AsyncEnvironment` instead of `Environment`:
	```javascript
	const env = new AsyncEnvironment();
	```

2. Promise-based render methods
	```javascript
	const result = await env.renderString('Hello {{ username }}', context);
	```

3. Filters and Extensions use promises by default:
	```javascript
	env.addFilter('translate', async (text, lang) => {
		return translator.translate(text, lang);
	});
	```
4. Custom Async Extensions:
	```javascript
	env.addExtension('Fetch', {
		tags: ['fetch'],
		parse(parser, nodes) {
			parser.nextToken();
			return new nodes.CallExtension(this, 'run', [parser.parseExpression()]);
		},
		async run(context, url) {
			return fetch(url);
		}
	});
	```
	Both fetches run concurrently:
	```njk
	Config: {% fetch "/api/config" %}
	Data: {% fetch "/api/data" %}
	```
	The key differences are:
	- Use the regular CallExtension node instead of CallExtensionAsync (which is for the old callback API)
	- The run() method is async and return a promise directly

5. Cascada introduces several updates and improvements to the development and testing environment:
	- **Updated Libraries**
	- **Revamped Build Scripts**
	- **Updated Testing Frameworks and Scripts**: Testing and has been improved, including improved coverage tests and the use of **Playwright** for browser tests.
	- **ESM Module Support**: The development environment now fully supports ECMAScript Modules (ESM), while retaining compatibility with the older CommonJS bindings.

## Parallelization Examples
Cascada automatically parallelizes operations that can safely run concurrently:

#### 1. Variables
Async assignments don't block execution:
```njk
{% set slow = slowData() %}
{% set fast = fastData() %}
{{ slow }}
{{ fast }}
```

#### 2. Expressions
Independent components evaluate concurrently:
```njk
{{ (fetchPrice() + getShipping()) * getTaxRate() | round(getPrecision()) }}
```

#### 3. Async Functions
Run in parallel unless dependencies require waiting:
```njk
{% set user = getUser() %}
{{ getUserPosts(user.id) | join('<br>') }}
{{ getFooter() }}
```
Here getUser and getFooter run concurrently, while getUserPosts waits for the user to resolve.
#### 4. Loop Iterations
Each iteration runs in parallel:
```njk
{% for id in [1,2,3] %}
    {{ getUser(id) }}
{% endfor %}
```

#### 5. Template Includes
Included templates load and process simultaneously:
```njk
{% include "heavy1.njk" %}
{% include "heavy2.njk" %}
```

#### 6. Async Filters
Execute concurrently:
```javascript
env.addFilter('translate', async (text, lang) => await translator.translate(text, lang));
```
Both translations run in parallel:
```njk
{{ "Hello World" | translate('es') }}
{{ "Hello World" | translate('fr') }}
```
## Templating Features

Cascada fully supports the Nunjucks template syntax and features. You can reference the [Nunjucks Templating Documentation](https://mozilla.github.io/nunjucks/templating.html) for complete details. Key features include:

- **Full programming constructs**: variables, loops, conditionals, functions, and scoping rules
- **First-class functions**: macros with support for default values and keyword arguments
- **Expression system**: complex expressions including inline conditionals and mathematical operations
- **Template composition**: inheritance (extend), content embedding (include), and importing (import)

## Technical Constraints

### Cross-Template Variable Access
To maintain Cascada’s parallelization capabilities, variable scopes must be known at compile time for proper dependency management. However, certain scenarios involve accessing variables across templates, which can complicate this:
 - **Included templates** (`include`): Included templates have **read-only** access to parent variables.
 - **Extended Templates** (`extends`): Blocks in child templates can **read and modify** parent variables.

### Dependency Declarations
To address these challenges, dependencies must be explicitly declared:
1. **Included Templates**
   Declare dependencies with {% depends %} to ensure proper tracking:
   ```njk
   {% depends var1, var2 %}
   ```
   Consider using imported macros instead of includes. Macros allow for better encapsulation and improved parallelization by avoiding unnecessary variable scope sharing.

2. **Dynamic Includes**
   For templates with dynamic names (determined at runtime), specify dependencies in the `include` tag:
   ```njk
   {% include includedTemplateName + ".njk" depends = var1, var2 %}
   ```

3. **Extended Templates and Blocks**
   In the parent template, explicitly separate **read-only** and **read-write** variables to define their roles. The child template uses `depends` to declare its dependencies **only if the parent template is dynamically determined**.

   - **Parent Template**:
     Use `readonly` for variables that cannot be modified and `readwrite` for variables that can:
     ```njk
     {% set frameVar1 = "Value 1" %}
     {% set frameVar2 = "Another Read-Only Value" %}
     {% block content readonly frameVar1, frameVar2 readwrite frameVar3 %}
         {% set frameVar3 = "Value 3" %}
     {% endblock %}
     ```

   - **Child Template**:
     If the parent template is dynamically determined, use `depends` in the child template to explicitly declare its dependencies:
     ```njk
     {% extends "parentTemplate_" + dynamicPart + ".njk" %}

     {% block content depends frameVar1, frameVar2, frameVar3 %}
         <h1>{{ frameVar1 }}</h1>
         <h2>{{ frameVar2 }}</h2>
         {% set frameVar3 = "Updated Value" %}
     {% endblock %}
     ```


## Development Status and Roadmap

Cascada is still under development. The following tasks remain to be completed:

- **Dependency Declarations**: Finalize and integrate explicit dependency declaration features ([see Dependency Declarations](#dependency-declarations)).
- **Variable Scoping and Dependency Management for Loops**: Ensure proper variable handling and dependency management within loop contexts.
- **Async Iterators**: Complete implementation of async iterators to enable real-time processing instead of waiting for all elements before processing begins.
- **Complete Async API**: Finalize the API for precompiled templates - implement `asyncCompile` and `AsyncTemplate`.
- **Address Parallelism Inefficiencies**: Resolve some known inefficiencies in parallel execution, such as the current behavior where all elements in template-declared arrays must be resolved together before individual elements can be accessed.
- **Optimizations**: Apply some low-hanging fruit optimizations.
- **Extensive Testing**: Conduct additional tests to ensure robustness and coverage across various scenarios.
- **TypeScript Definitions**:  Implement TypeScript definitions as part of the library to ensure the API is fully typed.

## Best Practices

1. **Divide into independent tasks**

	Break down complex operations into smaller, independent components that don't rely on each other's results.

2. **Balance**

	Find the right balance between parallelization and operational complexity. Consider batching many small operations.

3. **Minimize Dependencies**

	Design your template structure to minimize dependencies between operations.

4. **Pure functions**

	Use functions that depend only on their input parameters for predictable parallel execution.

5. **Direct API access**

	Consider exposing APIs directly to templates instead of pre-processing all data.

6. **API layer design**

	Create purpose-built API methods that return data in the exact shape needed by templates.

7. **Use imported macros over includes**

	Use imported macros instead of includes wherever possible. Macros allow for better encapsulation and improved parallelization by avoiding unnecessary variable scope sharing.

8. **Do not use the old async tags**

	Do not use the old async versions of the following Nunjucks tags, as they will prevent parallel rendering: `asyncEach`, `asyncAll`, `asyncMacro`.
Instead, use the standard synchronous versions of these tags (each, for, macro) in combination with async values.