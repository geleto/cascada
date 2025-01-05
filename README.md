# Cascada

Cascada is a fork of the [Nunjucks](https://github.com/mozilla/nunjucks "Nunjucks") templating engine, designed to handle asynchronous operations seamlessly. It automatically parallelizes independent components during rendering while accounting for data dependencies, all without requiring special syntax and logic.

## Key async features
- **Transparent Async Support**: Use promises and async operations naturally in your templates without special syntax.
- **Implicit Parallel Processing**: Cascada identifies and executes independent operations in parallel without requiring explicit setup
- **Dependency Management**: The engine tracks dependencies between operations and makes sure async operations wait for their prerequisites while allowing unrelated operations to proceed.
- **Sequential-Equivalent Results**: Despite parallel execution, output remains consistent with sequential processing
- **Compatible with Nunjucks**: Works with existing Nunjucks templates, with some minor exceptions.

## Templating

Cascada fully supports the Nunjucks template syntax and features. You can reference the [Nunjucks Templating Documentation](https://mozilla.github.io/nunjucks/templating.html) for details.
It provides many programming language features in a template-friendly syntax:

- **Full Programming Constructs**
Complete with variables, loops, conditionals, functions, and scoping rules. Templates can contain complex logic and data transformations.

- **Rich Inheritance System**
Full template inheritance with blocks that can be extended and overridden, including support for multiple levels of inheritance and super() calls.

- **First-class Functions**
Macros can be defined in templates, imported between files, and passed around as variables. They support default values, keyword arguments, and proper scoping.

- **Expression System**
Full support for complex expressions including inline conditionals, mathematical operations, and method calls.

- **Template Composition**
Templates can be composed through inheritance (extend), content embedding (include), and accessing macros and variables from other templates (import), , providing extensive code reuse capabilities.

## Transparent handling of asynchronous data and operations
All template features support asynchronous operations:
#### Context objects can contain async values:
```javascript
const context = {
    user: fetch('https://jsonplaceholder.typicode.com/users/1').then(res => res.json())
}
```
Use naturally - no await or special handling of Promise values needed:
```njk
{{ user.name }}
```
#### Use asynchronous API calls directly in your context or as globals:
```javascript
const context = {
    user: fetch('https://api.example.com/user').then(res => res.json()),
    posts: fetch('https://api.example.com/posts').then(res => res.json())
}
```
Reference them like regular values:
```njk
<h1>Welcome {{ user.name }}!</h1>
<div class="posts">
{% for post in posts %}
    <article>
        <h2>{{ post.title }}</h2>
        {{ post.content }}
        <div class="metadata">
            {{ getAuthor(post.authorId) }}      {# Async call per post #}
            {{ fetchComments(post.id)  }}        {# Runs in parallel #}
        </div>
    </article>
{% endfor %}
</div>
```
#### Full support for async iterators and generators in loops:
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

The key differences are:
- Use `AsyncEnvironment` instead of `Environment` for templates containing async operations.
```javascript
const env = new AsyncEnvironment();
```
- The `renderString` and `render `methods return promises and the old callback arguments are optional.
```javascript
const result = await env.renderString('Hello {{ username }}', context);
```
- Filters: Cascada accepts both the old callback and promise-based filters:
 Old callback style
 ```javascript
 env.addFilter('translate', (text, lang, callback) => {
     callback(null, translator.translate(text, lang)),
 }, true); // async flag required
```
New promise style:
 ```javascript
 env.addFilter('uppercase', async (str) => {
     return str.toUpperCase();
 }); // no async flag needed, just return a promise
```
- Extensions:
Supports old style extensions with `CallExtension` (sync) and `CallExtensionAsync` (callback-based). New `AsyncExtension` helper class that handles async operations through promises instead of callbacks:
 ```javascript
TODO
```
## Parallel Processing
Cascada automatically parallelizes operations that can safely run concurrently. Every value can be a promise internally, and all template components (expressions, filters, functions, macros) return promises immediately to prevent blocking.
- **Variables**: Async assignments don't block execution. Values resolve when needed while preserving order:
```javascript
{% set slow = slowData() %}
{% set fast = fastData() %}
{{ slow }}
{{ fast }}
```
Output will be slowfast regardless of resolution order.

- **Expressions**: Components evaluate concurrently:
```javascript
{{ countPosts(user.id) / daysSinceRegistration(user.id) + ' posts/day, ' + getLikes(user.id) + ' likes' }}
```
- **Async Functions**: Run in parallel unless dependencies require waiting
```javascript
{% set user = getUser() %}: <br> {{ getUserPosts(user.id) | join('<br>') }}{{ getFooter() }}
```
getUserPosts will wait for getUser, but getFooter will not be delayed.
- **Function Arguments**: All arguments resolve concurrently before function execution:
```javascript
{{ asyncFunc( getData(), fetchUser(), configPromiseVar ) }}
```
- **Loop Iterations**: Each iteration runs in parallel:
```javascript
{% for id in [1,2,3] %}
	{{ getUser(id) }}
{% endfor %}
```
- **Template Includes**: Templates load and process simultaneously:
```javascript
{% include "heavy1.njk" %}
{% include "heavy2.njk" %}
```
- **Async Filters**: Execute concurrently:
```javascript
env.addFilter('translate', async (text, lang) => await translator.translate(text, lang));
```
```njk
{{ "Hello World" | translate('es') }}   {# Both translations run in parallel #}
{{ "Hello World" | translate('fr') }}
```
- **Custom Extensions**: Add your own async-enabled tags:
```javascript
env.addExtension('FetchBlock',{
	  tags:['fetch'],
	  parse(p,n){
		p.nextToken()
		return new n.CallExtension(this,'run',[p.parseExpression()])
	},
	async run(_context,url){
		return fetch(url)
	}
})
```
Both fetches run concurrently:
```njk
Config: {% fetch "/api/config" %}
Data: {% fetch "/api/data" %}
```

## Implementation Strategies

1. **Divide Into Independent Tasks**
Break down complex operations into smaller, independent components that don't rely on each other's results. This allows Cascada to process multiple pieces simultaneously rather than waiting for one large operation to complete.

1. **Balance**
While breaking tasks down enables parallel processing, too many tiny async operations can create overhead. Find the right balance between parallelization and operational complexity. For instance, fetching 1000 individual user records might be better handled as a few batch requests rather than 1000 parallel calls.

1. **Smart Dependencies**
Design your template structure and data flow to minimize dependencies between operations. Think about what data each component truly needs and architect your solution around minimizing these dependencies.

1. **Pure Functions**
Design functions that only depend on their input parameters, not on external state. This makes behavior more predictable when operations run in parallel and makes it easier to verify the correctness of your templates.

1. **Exposing APIs**
When exposing API methods for use in templates, ensure they return promises rather than using callbacks. Use promisify or custom wrappers to adapt existing callback-based APIs if needed.

1. **Consider Direct API Access**
Cascada's support for async operations enables a different pattern than traditional template design: rather than pre-processing all data before passing it to templates, consider exposing your APIs directly and letting templates handle data transformation. This pattern can enable more efficient parallel processing as templates can fetch and transform only the data they need, when they need it.

1. **API Layer Design**
Design your API layer to match your template needs. Instead of creating generic API methods and transforming their results, create purpose-built methods that return data in the exact shape needed by templates. This minimizes transformation overhead and clarifies the relationship between templates and data.

1. **Use Imported Macros Over Includes**
When you need to pass variables between templates, use imported macros rather than includes. Includes create dependency bottlenecks through shared context variables, while macros receive their dependencies as parameters, leading to better parallelization and more maintainable templates.