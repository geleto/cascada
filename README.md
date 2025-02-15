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
    - [1. PAsyncEnvironment Method Mappings](#1-pasynccenvironment-method-mappings)
    - [2. Function Mappings](#2-function-mappings)
    - [3. Class Mappings](#3-class-mappings)
    - [4. API Examples](#4-api-examples)
    - [5. Development Environment Updates](#5-development-environment-updates)
- [Parallelization Examples](#parallelization-examples)
  - [1. Variables](#1-variables)
  - [2. Expressions](#2-expressions)
  - [3. Async Functions](#3-async-functions)
  - [4. Loop Iterations](#4-loop-iterations)
  - [5. Template Includes](#5-template-includes)
  - [6. Async Filters](#6-async-filters)
- [Templating Features](#templating-features)
  - [Additional Tags](#additional-tags)
  - [The try/retry/except Tags](#the-tryretryexcept-tags)
  - [The while Tag](#the-while-tag)
- [Technical Constraints](#technical-constraints)
  - [Cross-Template Mutable Variable Access](#cross-template-mutable-variable-access)
  - [Dependency Declarations](#dependency-declarations)
- [Best Practices](#best-practices)
- [Development Status and Roadmap](#development-status-and-roadmap)
  - [Core Functionality](#core-functionality)
  - [Performance and Testing](#performance-and-testing)
  - [New Template Features](#new-template-features)
  
## Background

Traditional template engines either require pre-resolving all async data before rendering or use special syntax for async operations. None provide automatic parallelization - operations run sequentially by default, and any parallel processing requires explicit orchestration through special constructs.

Cascada was developed with AI agent workflows in mind, where template rendering often involves multiple long-running operations like LLM calls, reasoning steps, or external API requests.

## Why Cascada?

### 1. Transparent Async Support
- Set promises, async functions, and async iterators in your context object and use them anywhere in your templates
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
Use naturally in templates, no await needed:
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

### Getting Started
```javascript
const { PAsyncEnvironment } = require('cascada');

const env = new PAsyncEnvironment();
const context = {
  data: Promise.resolve({ message: "Hello" })
};

env.renderString("Message: {{ data.message }}", context)
   .then(result => console.log(result));
```
### Key Differences

Cascada uses the "PAsync" prefix/suffix to indicate Promise-based versions of Nunjucks functions and classes. For async template processing, use `PAsyncEnvironment` instead of `Environment` - it provides the same interface but returns Promises instead of using callbacks.

#### 1. PAsyncEnvironment Method Mappings

Most methods in PAsyncEnvironment keep their original names but return Promises:

| Method | In Environment | In PAsyncEnvironment |
|--------|---------------|---------------------|
| `render` | Returns string or accepts callback | Returns Promise<string> |
| `renderString` | Returns string or accepts callback | Returns Promise<string> |
| `getTemplate` | Returns Template or accepts callback | Returns Promise<PAsyncTemplate> |

Additional async-specific methods:
- `getTemplatePAsync()`: Promise-based template loading
- `addFilterPAsync()`: Add Promise-returning filters

#### 2. Function Mappings

New top-level functions use the PAsync suffix:

| Nunjucks Function | Cascada Equivalent | Difference |
|------------------|-------------------|------------|
| `render` | `renderPAsync` | Returns a Promise instead of string (or accepting callback parameter) |
| `renderString` | `renderStringPAsync` | Returns a Promise instead of string (or accepting callback parameter) |
| `compile` | `compilePAsync` | Returns a PAsyncTemplate instead of Template, requires PAsyncEnvironment instead of Environment |
| `precompile` | `precompilePAsync` | Requires PrecompileOptionsPAsync instead of PrecompileOptions, which uses PAsyncEnvironment instead of Environment |
| `precompileString` | `precompileStringPAsync` | Requires PrecompileOptionsPAsync instead of PrecompileOptions, which uses PAsyncEnvironment instead of Environment |

#### 3. Class Mappings

| Nunjucks Class | Cascada Equivalent | Key Differences |
|----------------|-------------------|-----------------|
| `Environment` | `PAsyncEnvironment` | - Extends `Environment`<br>- Methods keep same names but return Promises<br>- Adds async-specific methods |
| `Template` | `PAsyncTemplate` | - `render()` returns Promise<br>- Works with PAsyncEnvironment |

#### 4. API Examples

##### Basic Template Rendering
```javascript
// Initialize async environment
const env = new PAsyncEnvironment();

// Promise-based rendering
const result = await env.renderString('Hello {{ username }}', context);
```

##### Async Filters
```javascript
// Add async filter
env.addFilter('translate', async (text, lang) => {
    return translator.translate(text, lang);
});

// Use in template
const template = 'Hello {{ "World" | translate("es") }}';
```

##### Async Extensions
```javascript
// Define async extension
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
The key differences to keep in mind when developing asyn extensions:
- Use the regular CallExtension node instead of CallExtensionAsync (which is for the old callback API)
- The run() method is async and return a promise directly

##### Async Context Data
```javascript
const context = {
    user: fetch('https://api.example.com/user/1').then(res => res.json()),
    posts: async (userId) => {
        const res = await fetch(`https://api.example.com/users/${userId}/posts`);
        return res.json();
    }
};

// Use in template
await env.renderString('Welcome {{ user.name }}! Posts: {{ posts(user.id) }}', context);
```

The key patterns in Cascada are:
1. Environment methods keep their names but return Promises
2. New top-level functions use the PAsync suffix
3. All async operations return Promises instead of using callbacks
4. Async extensions use `return await` instead of callbacks
5. Context can contain promises and async functions that resolve automatically


5. Cascada introduces several updates and improvements to the development and testing environment:
	- **Updated Libraries**
	- **Revamped Build Scripts**
	- **Updated Testing Frameworks and Scripts**: Testing and has been improved, including improved coverage tests and the use of **Playwright** for browser tests.
	- **ESM Module Support**: The development environment now fully supports ECMAScript Modules (ESM), while retaining compatibility with the older CommonJS bindings.
  - **TypeScript definitions**: Implement TypeScript definitions as part of the library to ensure the API is fully typed

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

## Additional Tags

Cascada supports additional tags, not found in Nunjucks:
- `depends` tag: See [Cross-Template Variable Access](#cross-template-variable-access)
- `try`/`retry`/`except` tags for error handling
- `while` loop for conditional iteration

### The try/retry/except Tags

**Note**: This feature is not yet implemented. 

Cascada's async nature makes error handling particularly important. When an error occurs and is handled by except:
- Variables whose final values are already determined (execution has moved past any point where they could change) retain those values
- Variables that could still change (their values depend on operations after the error point) are rejected because their final values cannot be determined
- Template execution continues after the except block

```njk
{% try %}
    {% set a = "safe value" %}
    {{ someAsyncOperation() }}
    {% set b = "never set" %}
{% retry if askUser('Retry operation?') %}
    Retrying... (attempt {{ retry.count }})
    Failed operation: {{ retry.source }}
{% except %}
    {# 'a' retains "safe value" because it was set before the error
       'b' is rejected because we never reached its assignment #}
    {{ throwError('Operation failed permanently') }}
{% endtry %}
```

Key features:
- `try` block contains code that might fail
- `retry` block handles errors and can retry the failed operation
- If retry condition is true, execution continues from the point of failure
- If retry condition is false, control passes to the except block
- Special variables in retry block:
  - `retry.count`: Number of retry attempts so far
  - `retry.source`: Name/path of the operation that failed (e.g., 'fetch', 'userApi.getProfile')
- Error handling in except block:
  - `error`: The error object that caused the failure
  - Can throw errors using context methods (e.g., `throwError` must be provided in context)

Examples:

1. API call with retry based on error source:
```njk
{% try %}
    {% set userData = fetchUserData(userId) %}
    {% set extraData = processUserData(userData) %}
{% retry if retry.source == 'fetchUserData' and retry.count < 3 %}
    {% set warningMessage = 'Retrying user data fetch (attempt ' + retry.count + ')' %}
{% except %}
    {# userData and extraData are rejected if fetchUserData fails
       only userData retains value if processUserData fails #}
    {{ throwError('Failed to fetch user data: ' + error.message) }}
{% endtry %}
```

### The while Tag

**Note**: This feature is not yet implemented. 

`while` creates a loop that continues as long as a condition is true. Unlike `for`, it doesn't iterate over collections but instead repeats until a condition becomes false. It fully supports async iterators and async conditions.

```njk
{% while condition %}
    Template content
{% endwhile %}
```

Inside while loops, you have access to these special variables:
* `loop.index`: current iteration (1 indexed)
* `loop.index0`: current iteration (0 indexed)
* `loop.first`: boolean indicating first iteration
* `loop.revindex`: number of iterations from end (undefined until loop completes)
* `loop.revindex0`: number of iterations from end (undefined until loop completes)

Example with async iterator:
```njk
{% set stream = createAsyncStream() %}
{% while await stream.hasNext() %}
    {% set chunk = await stream.next() %}
    Processing chunk {{ loop.index }}: {{ chunk }}
{% endwhile %}
```

## Technical Constraints

### Cross-Template Mutable Variable Access

**Note**: This feature is not yet implemented. 

To maintain Cascada’s parallelization capabilities, mutable variable scopes must be known at compile time for proper dependency management. However, certain scenarios involve accessing and changing variables across templates:
 - **Included templates** (`include`): Included templates have **read-only** access to parent variables.
 - **Extended Templates** (`extends`): Blocks in child templates can **read and modify** parent variables.
 
 The variables of the parent template can not be known, thus variable dependencies need to be declared.

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

## Development Status and Roadmap

Cascada is still under active development. The following tasks remain to be completed:

### Core Functionality
- **Dependency declarations**: Finalize and integrate explicit dependency declaration features ([see Technical Constraints: Cross-Template Variable Access](#cross-template-variable-access))
- **Variable scoping and dependency management for loops**: Ensure proper variable handling and dependency management within loop contexts
- **Async iterators**: Complete implementation of async iterators to enable real-time processing instead of waiting for all elements before processing begins

### Performance and Testing
- **Address parallelism inefficiencies**: Resolve some known inefficiencies in parallel execution, such as the current behavior where all elements in template-declared arrays must be resolved together before individual elements can be accessed
- **Optimizations**: Apply some low-hanging fruit optimizations
- **Extensive testing**: Conduct additional tests to ensure robustness and coverage across various scenarios

### New Template Features
- **Additional Tags**:
  - `while` loops for conditional iteration
  - Error handling with `{% try %}/{% retry %}/{% except %}`
  - `depends` tag for explicit dependency declarations