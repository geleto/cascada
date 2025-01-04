# Cascada

Cascada is a fork of the [Nunjucks](https://github.com/mozilla/nunjucks "Nunjucks") templating engine, designed to handle asynchronous operations seamlessly. It automatically parallelizesindependent components during rendering while accounting for data dependencies, all without requiring special syntax and logic.

## Key features
- **Transparent Async Support**: Use promises and async operations naturally in your templates without special syntax.
- **Implicit Parallel Processing**: Cascada identifies and executes independent operations in parallel without requiring explicit setup
- **Dependency Management**: The engine tracks dependencies between operations and makes sure async operations wait for their prerequisites while allowing unrelated operations to proceed.
- **Sequential-Equivalent Results**: Despite parallel execution, output remains consistent with sequential processing
- **Compatible with Nunjucks**: Works with existing Nunjucks templates, with some minor exceptions.

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