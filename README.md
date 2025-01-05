# Cascada - async templating with automatic parallelization

Cascada is a fork of the [Nunjucks](https://github.com/mozilla/nunjucks) template engine designed to handle asynchronous operations seamlessly. It automatically parallelizes independent components during rendering while managing data dependencies, all without requiring special syntax or explicit async handling.

## The Problem

Traditional template engines either require pre-resolving all async data before rendering or use special syntax for async operations. None provide automatic parallelization - operations run sequentially by default, and any parallel processing requires explicit orchestration through special constructs.

## Motivation
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

## Key Features

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
The key differences are
 - Use the regular CallExtension node instead of CallExtensionAsync (which is for the old callback API)
 - The run() method is async and return a promise directly

## Parallel Processing Examples
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

- **Full Programming Constructs**: Variables, loops, conditionals, functions, and scoping rules
- **First-class Functions**: Macros with support for default values and keyword arguments
- **Expression System**: Complex expressions including inline conditionals and mathematical operations
- **Template Composition**: Inheritance (extend), content embedding (include), and importing (import)

## Implementation Strategies

1. **Divide Into Independent Tasks**
Break down complex operations into smaller, independent components that don't rely on each other's results.

2. **Balance**
Find the right balance between parallelization and operational complexity. Consider batching many small operations.

3. **Smart Dependencies**
Design your template structure to minimize dependencies between operations.

4. **Pure Functions**
Use functions that depend only on their input parameters for predictable parallel execution.

5. **Direct API Access**
Consider exposing APIs directly to templates instead of pre-processing all data.

6. **API Layer Design**
Create purpose-built API methods that return data in the exact shape needed by templates.

7. **Use Imported Macros Over Includes**
Prefer macros over includes for better parallelization when passing variables between templates.


