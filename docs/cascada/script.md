# Cascada Script Documentation

[Download as Markdown](https://raw.githubusercontent.com/geleto/cascada/master/docs/cascada/script.md)

[Markdown for AI Coding Agents](https://raw.githubusercontent.com/geleto/cascada/refs/heads/master/docs/cascada/script-agent.md)

[Cascada Github](https://github.com/geleto/cascada)

**Cascada Script** inverts the traditional programming model: it is parallel by default, sequential only when explicitly asked. Everything runs at once - all statements, each part of every expression, every operation in each call, each iteration of every loop - an operation only waits when it depends on another's result. What makes it extraordinary is how ordinary the syntax looks - instantly familiar to any JavaScript or Python developer. And the result is identical to sequential execution.

## Cascada Script  -  Implicitly Parallel, Explicitly Sequential

**Cascada Script** is a specialized scripting language designed for orchestrating complex asynchronous workflows in JavaScript and TypeScript applications. It is not a general-purpose programming language; instead, it acts as a **data-orchestration layer** for coordinating APIs, databases, LLMs, and other I/O-bound operations with maximum concurrency and minimal boilerplate.

It uses familiar syntax and language constructs, while offering language-level support for boilerplate-free concurrent workflows, explicit control over side effects, deterministic output construction, and dataflow-based error handling with recovery rollbacks.

The core execution model:

* ⚡ **Parallel by default**  -  Independent operations — variable assignments, function calls, loop iterations — execute concurrently without `async`, `await`, or promise management.
* 🚦 **Data-driven execution**  -  Code runs automatically when its input data becomes available, eliminating race conditions by design.
* ➡️ **Explicit sequencing only when needed**  -  Order specific calls, loops, or external interactions with dedicated language constructs — the rest of the script stays concurrent.
* 📋 **Deterministic outputs**  -  Even though execution is concurrent and often out-of-order, Cascada guarantees that final outputs are assembled exactly as if the script ran sequentially.
* ☣️ **Errors are data**  -  Failures propagate through the dataflow instead of throwing exceptions, allowing unrelated concurrent work to continue safely.

Cascada Script is particularly well suited for:

* AI and LLM orchestration
* Data pipelines and ETL workflows
* Agent systems and planning patterns
* High-throughput I/O coordination

In short, Cascada lets developers **write clear, linear logic** while the engine handles **concurrent execution, ordering guarantees, and error propagation** automatically.

Despite executing concurrently by default, it reads exactly like the synchronous code you already write:

```javascript
var user  = fetchUser(userId)   // ┐ start immediately,
var posts = fetchPosts(userId)  // ┘ run concurrently

// evaluates as soon as 'user' resolves — posts may still be fetching
var role = "admin" if user.isAdmin else "member"

// for loop — every iteration runs concurrently
data result  // writes are concurrent, output is assembled in source order
for post in posts
  var enriched = enrichPost(post)
  result.posts.push({
    title:  enriched.title | title,
    status: "published" if enriched.isLive else "draft"
  })
endfor

// ! makes these sequential with each other, without breaking concurrency with the rest
db!.log("report", userId)
db!.updateLastSeen(userId)

return { name: user.name, role: role, posts: result.snapshot() }  // snapshot waits for all writes
```

Every construct above runs exactly as you'd read it — the engine orchestrates all the async concurrency.

## Read First

**Articles:**

- [Cascada Script Introduction](https://geleto.github.io/posts/cascada-script-intro/) - An introduction to Cascada Script's syntax, features, and how it solves real async programming challenges

- [The Kitchen Chef's Guide to Concurrent Programming with Cascada](https://geleto.github.io/posts/cascada-kitchen-chef/) - Understand how Cascada works through a restaurant analogy - no technical jargon, just cooks, ingredients, and a brilliant manager who makes concurrent execution feel as natural as following a recipe

**Learning by Example:**
- [Casai Examples Repository](https://github.com/geleto/casai-examples) - Explore practical examples showing how Cascada and Casai (an AI orchestration framework built on Cascada) turn complex agentic workflows into readable, linear code - no visual node graphs or async spaghetti, just clear logic that tells a story (work in progress)

## Table of Contents
- [Quick Start](#quick-start)
- [Cascada's Execution Model](#cascadas-execution-model)
- [Language Fundamentals](#language-fundamentals)
- [Control Flow](#control-flow)
- [Channels](#channels)
- [Managing Side Effects: Sequential Execution with `!`](#managing-side-effects-sequential-execution-with-)
- [Functions and Reusable Components](#functions-and-reusable-components)
- [Error Handling](#error-handling)
- [Return Statements](#return-statements)
- [Composition and Loading](#composition-and-loading)
- [API Reference](#api-reference)
- [Development Status and Roadmap](#development-status-and-roadmap)

## Quick Start

```bash
npm install cascada-engine
```

### The script

Write plain, familiar logic. Cascada runs independent operations concurrently:

```javascript
const script = `
  var user  = fetchUser(userId)
  var posts = fetchPosts(userId)

  return {
    name:      user.name,
    postCount: posts.length
  }
`;
```

No `async`, no `await`. `fetchUser` and `fetchPosts` run concurrently — Cascada handles it.

### Running a script

Pass the script and a context object to `renderScriptString`. Any value in the context can be a promise or an async function:

```javascript
import { AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();

const result = await env.renderScriptString(script, {
  userId:    123,
  fetchUser: (id) => db.users.findById(id),
  fetchPosts: (id) => db.posts.findByUser(id)
});

console.log(result);
// { name: 'Alice', postCount: 5 }
```

To understand how Cascada achieves effortless concurrency, read the next section.


## Cascada's Execution Model

Cascada's approach to concurrency inverts the traditional programming model. Understanding this execution model is essential to writing effective Cascada scripts - it explains why the language behaves the way it does and how to leverage its concurrency.

#### ⚡ Parallel by default
Cascada fundamentally inverts the traditional programming model: instead of being sequential by default, Cascada is **parallel by default**. Independent variable assignments, function calls, loop iterations, and function invocations all run concurrently — no special syntax required.

#### 🚦 Data-Driven Flow: Code runs when its inputs are ready.
In Cascada, any independent operations - like API calls, LLM requests, and database queries - are automatically executed concurrently without requiring special constructs or even the `await` keyword. The engine intelligently analyzes your script's data dependencies, guaranteeing that **operations will wait for their required inputs** before executing. This applies to all constructs: expressions evaluate as soon as their operands resolve, conditionals wait for their condition, loops wait for their iterable, and function calls wait for their arguments. This orchestration **eliminates the possibility of race conditions** by design, ensuring correct execution order while maximizing performance for I/O-bound workflows.

#### ✨ Implicit Concurrency: Write Business Logic, Not Async Plumbing.
Forget await. Forget .then(). Forget manually tracking which variables are promises and which are not. Cascada fundamentally changes how you interact with asynchronous operations by making them invisible.
This "just works" approach means that while any variable can be a promise under the hood, you can pass it into functions, use it in expressions, and assign it without ever thinking about its asynchronous state.

#### ➡️ Implicitly Parallel, Explicitly Sequential
While this "parallel-first" approach is powerful, Cascada recognizes that order is critical for operations with side-effects. For these specific cases you have three tools: the `!` marker, which **enforces strict sequential order on a specific chain of operations** (such as database writes or stateful API calls); the `each` loop, which **iterates a collection one item at a time** when per-item side-effects must not overlap; and a `sequence` channel, which provides **strictly ordered reads and calls on an external object** while still returning each call's value. All three are surgical — they sequence only what they touch, without affecting the concurrency of the rest of the script.

#### 📋 Execution is chaotic, but the result is orderly
While independent operations run concurrently and may start and complete in any order, Cascada guarantees the final output is identical to what you'd get from sequential execution. This means all your data manipulations are applied predictably, ensuring your final texts, arrays and objects are assembled in the exact order written in your script.

#### ☣️ Dataflow Poisoning - Errors that flow like data
Cascada replaces traditional try/catch exceptions with a data-centric error model called **dataflow poisoning**. If an operation fails, it produces an `Error Value` that propagates to any dependent operation, variable and output - ensuring corrupted data never silently produces incorrect results. For example, if fetchPosts() fails, any variable or output using its result also becomes an error - but critically, unrelated operations continue running unaffected. Poisoning is conservative with control flow: if an `if` condition is an Error Value, neither branch runs and every variable that either branch would have modified becomes poisoned. You can detect and repair these errors using `is error` checks, providing fallbacks and logging without derailing your entire workflow.

#### 💡 Clean, Expressive Syntax
Cascada Script offers a modern, expressive syntax designed to be instantly familiar to JavaScript and TypeScript developers. It provides a complete toolset for writing sophisticated logic, including variable declarations (`var`), `if/else` conditionals, `for/while` loops, and a full suite of standard operators. Build reusable components with `function`, which supports default values and keyword arguments, and compose complex applications by organizing your code into modular files with `import` and `extends`.


## Language Fundamentals

### Features at a Glance

What makes Cascada Script remarkable is how unremarkable it looks. Despite executing concurrently by default, the language offers the same familiar constructs found in Python, JavaScript, and similar languages - but without the async keyword, no callbacks, no promise chains. You write straightforward sequential-looking logic, the engine handles the concurrency.

| Feature | Syntax | Notes |
|---|---|---|
| Variable declaration | `var name = value` | Always declare before use with `var` |
| Assignment | `name = value`, `obj.prop = value` | Assign or reassign a variable or property to a new value |
| Arithmetic | `+`, `-`, `*`, `/`, `//`, `%`, `**` | `//` is integer division, `**` is exponentiation |
| Comparisons | `==`, `!=`, `<`, `>`, `<=`, `>=`, `===` | Standard comparisons |
| Logic | `and`, `or`, `not` | Word-form boolean operators |
| Strings | `"text"`, `'text'` | Concatenation with `+` |
| Arrays | `[1, 2, 3]` | Array literals |
| Objects / dicts | `{key: "value"}` | Object literals |
| Expressions | `obj.prop`, `arr[i]`, `2*x + 1` | Member access, indexing, compound expressions; any expression is a valid standalone statement |
| Inline if (ternary) | `a if condition else b` | Python-style conditional expression |
| Conditionals | `if / elif / else / endif` | Standard branching |
| Switch | `switch / case / default / endswitch` | Multi-way branching |
| Concurrent loop | `for item in array`, `for key, value in object`, `for element in iterator` | Iterations run concurrently |
| Sequential loop | `each item in list / endeach` | Iterations run in strict order |
| While loop | `while condition / endwhile` | Condition-based loop |
| Filters | `value \| filterName(args)` | Transform values with built-in or custom filters |
| Function calls | `funcName(a, b)` | Call script functions, context functions, globals, or inherited methods |
| Functions | `function name(arg, optional="x") ... endfunction` | Define reusable callable functions; supports default values and keyword arguments |
| Methods | `method name(args) … endmethod` | Define overridable, value-returning methods for `extends` chains |
| Imports | `import "file" as ns`, `from "file" import name` | Import a namespace or specific functions from another script |
| Comments | `// line`, `/* block */` | Standard comment syntax |

Everything above is the language you already know. Cascada adds a small set of simple purpose-built constructs on top:

| Cascada Feature | Syntax | Purpose |
|---|---|---|
| Implicit concurrency | *(no syntax)* | Independent operations run concurrently automatically |
| `text` channel | `text log`, `log("line")` | Generate text from concurrent code, assembled in source order |
| `data` channel | `data out`, `out.items.push(item)` | Build structured objects and arrays from concurrent code - writes are concurrent, result is in source order |
| `sequence` channel | `sequence db = services.db`, `var user = db.getUser(1)` | Sequential reads and calls on an external object |
| Sequential operator | `obj!.method()`, `obj!.prop` | Enforce strict execution order on a context object path |
| Guard | `guard [targets] / recover [err] / endguard` | Transaction-like block: auto-restores state on error |
| Dataflow error poisoning | `value is error`, `value#message` | Failures propagate as error values through the dataflow; unrelated operations continue unaffected. If a control-flow condition is an error, all writes that would have happened in the skipped branches become poisoned too. Detect with `is error`, inspect with `#` |

### Core Syntax and Expressions

- **Multiline Expressions**: Expressions can span multiple lines for readability. The system automatically detects continuation based on syntax (e.g., unclosed operators, brackets, or parentheses). For example:
  ```
  var result = 5 + 10 *
    20 - 3
  ```
- **Standard Comments**: Use JavaScript-style comments (`//` and `/* */`)
- **Code**: Any standalone line that isn't a recognized command (e.g., `var`, `if`, `for`, `import`) or tag is treated as an expression. For example:
  ```
  computeTotal(items, tax)
  ```

### Variable Declaration and Assignment
Cascada Script uses a strict and explicit variable handling model that separates declaration from assignment for better clarity and safety.

#### Declaring Local Variables with `var`
Use `var` to declare a new, script-local variable. Re-declaring a variable that already exists in a visible scope will cause a compile-time error. If no initial value is provided, the variable defaults to `none`.

```javascript
// Declare and initialize a variable
var user = fetchUser(1)

// Declare a variable, which defaults to `none`
var report

// Declare multiple variables and assign them a single value
var x, y = 100
```

#### Variable Assignment and Value Semantics

Use the `=` operator to assign or reassign a variable to a new value. Using `=` on an undeclared variable will cause a compile-time error.

```javascript
var name = "Alice"
name = "Bob" // OK: Re-assigning a declared variable

// Re-assign multiple existing variables at once
x, y = 200 // OK, if x and y were previously declared

// ERROR: 'username' was never declared with 'var'
username = "Charlie"
```

**Object and Array Composition**

You can compose new objects and arrays directly in assignments by using object and array literals. This is the normal way to build up a fresh value from existing variables and expressions.

```javascript
var fullName = user.firstName + " " + user.lastName
var profile = {
  id: user.id,
  name: fullName,
  active: true
}

var summary = [user.id, fullName, role]
```

This works especially well when you want to create a new value instead of mutating an existing one.

**Assignment creates an independent copy.** Objects and arrays are deep copied, not shared by reference.

```javascript
var a = {x: 1, y: 2}
var b = a              // b receives a deep copy
a.x = 10
b.x  // 1 - b is independent

var nums = [1, 2, 3]
var copy = nums        // copy receives a deep copy
nums[0] = 99
copy[0]  // 1 - copy is independent
```

This ensures concurrent operations never interfere—each variable owns its data independently.

**Performance Note**

Cascada uses optimized techniques so that assignments do not copy entire objects. Objects may be shared internally until modified, at which point only the affected parts are copied as needed. This keeps memory usage and performance overhead low while preserving the simple independent value semantics shown in the examples.

**Property Assignment**

You can directly assign to object properties and array elements:

```javascript
var point = {x: 1, y: 2}
point.x = 10

var items = [1, 2, 3]
items[0] = 100
```

When you assign an async value to a property, code that reads that property waits for the value to resolve:

```javascript
var point = {x: 1, y: 2}
point.x = slowApiCall()
return {
  x: point.x,  // waits because this value is being read
  y: point.y   // no wait needed - point.y is already resolved
}
```

**\* *Note:** Property Assignment is a **script-only feature** and is not available in the Cascada template language.

#### Mutation Methods and Side Effects

Direct assignment (`=` and property `=`) is the safe, idiomatic way to update values in Cascada. **Mutation methods** - methods that modify an existing value in-place rather than producing a new one - need more care. The main unsafe cases are the familiar JavaScript array mutators: `.push()`, `.pop()`, `.shift()`, `.unshift()`, `.splice()`, `.sort()`, `.reverse()`, `.fill()`, and `.copyWithin()`. Treat similar in-place methods on custom objects the same way: they are **side effects** in exactly the same sense as writing to a database or calling a stateful external service.

The problem is not "methods are always forbidden". The problem is **concurrent mutation of the same value**. If only one execution path is mutating a local value, ordinary JavaScript methods like `items.push(x)` are fine. But when concurrent branches can touch the same `var`, these methods become race-prone.

Calling a mutation method on a plain `var` inside a concurrent `for` loop is unsafe - iterations run concurrently, so whichever branch finishes last wins and source-code order is not preserved:

```javascript
// ❌ UNSAFE - concurrent iterations race on the same var
var items = []
for id in ids
  items.push(fetchItem(id))  // order not guaranteed
endfor
```

If you truly do not care about preserving source order, a plain mutable `var` may still be acceptable in non-concurrent code paths. But when multiple concurrent branches build a collection, do not mutate one shared `var` from all branches. Use one of these ordering tools instead:

- Use a `data` channel when concurrent branches are assembling an array or object and the final value should be deterministic.
- Use an `each` loop when every iteration must finish before the next one starts.
- Use the `!` operator when the thing being mutated is a stateful object from the render context, such as a database handle, queue, file writer, or other external service.

**`data` channel (preferred for building collections)** - this is the main mitigation. Writes run concurrently, but the assembled result always matches source-code order:
```javascript
data result
for id in ids
  var item = fetchItem(id)
  result.items.push(item)
endfor
return result.snapshot()
```

Use the `data` channel when you are assembling arrays or objects from concurrent code, whether order matters strictly or you just want to avoid shared-mutation races entirely.

**`each` loop (sequential iteration)** - runs one iteration at a time, making mutation methods on a plain `var` safe:
```javascript
var items = []
each id in ids
  items.push(fetchItem(id))  // safe: each iteration completes before the next starts
endeach
```

**`!` operator (for context objects)** - serializes calls on an object from the script context; see [Managing Side Effects: Sequential Execution](#managing-side-effects-sequential-execution):
```javascript
// 'collection' is a context object
for id in ids
  collection!.push(fetchItem(id))  // sequential; rest of the loop still runs concurrently
endfor
```

**Scoping: No Reuse of Visible Names**

You cannot declare a variable in an inner scope (e.g., inside a `for` loop or `if` block) if a variable with the same name is already declared in an outer scope. This prevents accidental overwrites in concurrent execution.

```javascript
var item = "parent"
for i in range(2)
  // ERROR: 'item' is already declared in the outer scope.
  var item = "child " + i
endfor
```

Variables declared inside control-flow blocks (`if`, `for`, `switch`, etc.) are **local to that block** and are not visible outside it.

```javascript
if condition
  var local = "only visible here"
endif
// ERROR: 'local' is not defined here
```

To use a value both inside and outside a block, declare it in the outer scope first:

```javascript
var status = "default"
if condition
  status = "updated"  // assigns to the outer variable
endif
// 'status' is visible and possibly updated here
```

**Handling `none` (null)**

The keyword `none` represents `null` in Cascada Script. Accessing a property on `none` produces an `Error Value`, so any dependent expression or assignment becomes poisoned. Variables declared without an initial value default to `none`:

```javascript
var report  // defaults to none (null)

var title = report.title   // title becomes an Error Value
return title               // returning it makes the script fail
```

### The Context Object

The **context** is the plain JavaScript object you pass when running a script. It is how you inject external data, functions, and services into Cascada:

```javascript
const result = await env.renderScriptString(script, {
  userId: 123,
  fetchUser: (id) => db.users.findById(id),
  db: myDatabase
});
```

Inside the script, context properties are accessed by name just like any other variable:

```javascript
var user = fetchUser(userId)
return user.name
```

**Context values are read-only unless you first copy them into a local `var`:** you cannot modify a context path directly in script code. When you assign a context property to a `var`, you get an independent copy, so later changes to that variable do not affect the original context object.

```javascript
appConfig.debug = true      // ERROR: cannot modify context directly

var config = appConfig      // local copy
config.debug = true
// appConfig is unchanged
```

### Literals, Operators, and Expressions

Cascada Script supports a wide range of expressions, similar to JavaScript.

#### Literals
You can use standard literals for common data types:
*   **Strings**: `"Hello"`, `'World'`
*   **Numbers**: `42`, `3.14159`
*   **Arrays**: `[1, "apple", true]`
*   **Dicts (Objects)**: `{ key: "value", "another-key": 100 }`
*   **Booleans**: `true`, `false`

#### Math
All standard mathematical operators are available:
`+` (addition), `-` (subtraction), `*` (multiplication), `/` (division), `//` (integer division), `%` (remainder), `**` (power).

```javascript
var price = (item.cost + shipping) * 1.05
```

#### Comparisons and Logic
Standard comparison (`==`, `!=`, `===`, `!==`, `>`, `>=`, `<`, `<=`) and logic (`and`, `or`, `not`) operators are used for conditional logic.

```javascript
if (user.role == "Admin" and not user.isSuspended) or user.isOwner
  // ... grant access
endif
```

Cascada also provides a rich, data-centric error handling model. You can test if a variable contains a failure using the `is error` test. For more details, see [Error Handling](#error-handling).

#### Inline `if` Expressions
For concise conditional assignments, you can use an inline `if` expression. This uses the Python-style conditional-expression syntax rather than the JavaScript `condition ? a : b` form.

```javascript
// Syntax: value_if_true if condition else value_if_false
var theme = "dark" if user.darkMode else "light"
```

#### Regular Expressions
You can create regular expressions by prefixing the expression with `r`.

```javascript
var emailRegex = r/^[^\s@]+@[^\s@]+\.[^\s@]+$/
if emailRegex.test(user.email)
  // Valid email address.
endif
```

### Filters and Global Functions

Cascada Script supports the full range of Nunjucks [built-in filters](https://mozilla.github.io/nunjucks/templating.html#builtin-filters) and [global functions](https://mozilla.github.io/nunjucks/templating.html#global-functions).

#### Filters
Filters are applied with the pipe `|` operator.
```javascript
var title = "a tale of two cities" | title
var users = ["Alice", "Bob"]
return {
  title: title,           // "A Tale Of Two Cities"
  users: users | join(", ")  // "Alice, Bob"
}
```

#### Global Functions
Global functions like `range` can be called directly.
```javascript
// range(n) returns [0, 1, ..., n-1]
for i in range(3)
  processItem(i)  // called with i = 0, 1, 2
endfor
```

#### Additional Global Functions

##### `cycler(...items)`
The `cycler` function creates an object that cycles through a set of values each time its `next()` method is called.

```javascript
// cycler requires sequential order - use 'each' so calls to next() stay in order
data rows = []
var rowClass = cycler("even", "odd")
each item in items
  // First item gets "even", second "odd", third "even", etc.
  rows.push({ class: rowClass.next(), value: item })
endeach
return rows.snapshot()
```

##### `joiner([separator])`
The `joiner` creates a function that returns the separator (default is `,`) on every call except the first. This is useful for delimiting items in a list.

```javascript
var comma = joiner(", ")
var output = ""
each tag in ["rock", "pop", "jazz"]
  output = output + comma() + tag
endeach
// output is "rock, pop, jazz"
```

## Control Flow

This section covers control flow constructs. Remember that Cascada's concurrent-by-default execution means loops and conditionals behave differently than in traditional languages.
These constructs also participate in Cascada's error-propagation model; for the full rules on poisoning, detection, and recovery, see [Error Handling](#error-handling).


### Conditionals
```
if condition
  // statements
elif anotherCondition
  // statements
else
  // statements
endif
```

### Switch Statements
```javascript
switch expression
case value1
  // statements
case value2
  // statements
default
  // statements
endswitch
```

Switch statements provide a clean way to handle multiple conditional branches based on a single expression. Each branch creates its own scope, similar to `if` statements.

**Example:**
```javascript
var orderStatus = order.status
var nextStep
var notification
var trackingUrl

switch orderStatus
case "pending"
  nextStep = "process_payment"
  notification = "awaiting_payment"
case "confirmed"
  nextStep = "prepare_shipment"
  notification = "order_confirmed"
case "shipped"
  nextStep = "track_delivery"
  trackingUrl = getTrackingUrl(order.id)
default
  nextStep = "review_order"
  notification = "unknown_status"
endswitch
```

**Important:** Unlike C-style languages, Cascada's `switch` does **not** have fall-through behavior - each `case` exits automatically without needing a `break`. The `default` branch runs when no `case` matches.

### Loops
Cascada provides `for`, `while`, and `each` loops for iterating over collections and performing repeated actions, with powerful built-in support for asynchronous operations.

##### `for` Loops: Iterate Concurrently
Use a `for` loop to iterate over arrays, dictionaries (objects), async iterators, and other iterable data structures. By default, the body of the `for` loop executes **concurrently for each item**, maximizing I/O throughput for independent operations.

```javascript
// Each iteration runs concurrently, fetching user details
data result
for userId in userIds
  var user = fetchUserDetails(userId)
  result.users.push(user)  // data channel preserves source-code order
endfor
return result.snapshot()
```

**Concurrency Limits**
You can control the maximum number of concurrent iterations using the `of` keyword followed by an expression that evaluates to a number. This allows you to rate-limit API calls or manage resource usage dynamically.

```javascript
var limit = 5
// Process items 5 at a time
for item in largeCollection of limit
  processItem(item)
endfor
```

You can iterate over various collection types:

*   **Arrays**:
    ```javascript
    data result
    var items = [{ title: "foo", id: 1 }, { title: "bar", id: 2 }]
    for item in items
      result.posts.push({ id: item.id, title: item.title })
    endfor
    return result.snapshot()
    ```
*   **Objects/Dictionaries**:
    Iterates over keys and values. Note that concurrency limits (`of N`) are ignored for plain objects.
    ```javascript
    text log
    var food = { ketchup: '5 tbsp', mustard: '1 tbsp' }
    for ingredient, amount in food
      log("Use " + amount + " of " + ingredient)
    endfor
    ```
*   **Unpacking Arrays**:
    ```javascript
    var points = [[0, 1, 2], [5, 6, 7]]
    text log
    for x, y, z in points
      log("Point: " + x + ", " + y + ", " + z)
    endfor
    ```
*   **Async Iterators**:
    Iterate seamlessly over async generators or streams. Cascada automatically handles waiting for items to be yielded.

    **Context Setup:**
    ```javascript
    const context = {
      generateNumbers: async function* () {
        yield 1;
        await new Promise(r => setTimeout(r, 100));
        yield 2;
      }
    };
    ```

    **Script:**
    ```javascript
    text log
    for num in generateNumbers()
      log("Received: " + num)
    endfor
    ```

**The `else` block**
A `for` loop can have an `else` block that is executed only if the collection is empty:
```javascript
text log
for item in []
  log("Item: " + item.name)
else
  log("The collection was empty.")
endfor
```

##### `while` Loops: Iterate Sequentially based on Condition
Use a `while` loop to execute a block of code repeatedly as long as a condition is true. Unlike the concurrent `for` loop, the `while` loop's body executes **sequentially**. The condition is re-evaluated only after the body has fully completed its execution for the current iteration.

```
while some_expression
  // These statements run sequentially in each iteration
endwhile
```

##### `each` Loops: Iterate Sequentially
For cases where you need to iterate over a collection but **preserve strict sequential order**, use an `each` loop. It has the same syntax as a `for` loop but guarantees that each iteration completes before the next one begins.

```
each item in collection
  // Each iteration completes before the next one starts
endeach
```

##### The `loop` Variable

Inside a `for`, `while`, or `each` loop, you have access to the special `loop` variable, which provides information about the current iteration.

**Always-Available Properties**
These properties are available in **all** loop types and modes:
*   `loop.index`: The current iteration of the loop (1-indexed).
*   `loop.index0`: The current iteration of the loop (0-indexed).
*   `loop.first`: `true` if this is the first iteration.

**Length-Dependent Properties**
Properties that require knowledge of the total collection size:
*   `loop.length`: The total number of items in the sequence.
*   `loop.last`: `true` if this is the last iteration.
*   `loop.revindex`: The number of iterations until the end (1-indexed).
*   `loop.revindex0`: The number of iterations until the end (0-indexed).

Use the following guidelines to determine if these properties are available:

1.  **Arrays and Objects:**
    ✅ **Always Available.** Because the size of an array or object is known upfront, these properties are available regardless of whether the loop runs concurrently, sequentially, or with a concurrency limit.

2.  **Concurrent Async Iterators:**
    ✅ **Available (Async).** For fully concurrent async iterators, `loop.length` and `loop.last` are resolved asynchronously after Cascada has consumed the entire iterator. In practice, these behave like promise-backed loop metadata: loop bodies can start immediately as items arrive, and expressions that depend on `loop.length` or `loop.last` simply wait until the stream has been fully consumed.

3.  **Sequential or Constrained Async Iterators:**
    ❌ **Not Available.** When an async iterator is restricted - by `each` or by a concurrency limit (`of N`) - Cascada treats it as a stream and does **not** provide `loop.length` or `loop.last`. In these modes, the loop only learns about the next item by continuing iteration. If an iteration were allowed to wait on `loop.length` or `loop.last`, it could block the very iteration progress needed to discover the end of the stream, causing a deadlock.

    In other words:
    - In an `each` loop, the current iteration must finish before Cascada can request the next item. Waiting for `loop.length` or `loop.last` would therefore wait for the end of the stream while preventing the stream from advancing.
    - In a bounded `for ... of N` loop, worker slots move on independently, and earlier iterations may still be unfinished while later items are being fetched. If all active workers waited for `loop.length` or `loop.last`, no worker would be free to keep draining the iterator, so the end would never be discovered.

    Because of that, these properties are intentionally treated as unavailable rather than as deferred values in sequential or bounded async-iterator loops.

4.  **`while` Loops:**
    ❌ **Not Available.** Since a `while` loop runs until a condition changes, the total number of iterations is never known before all iterations complete.


### Error handling and recovery with conditionals and loops

When an Error Value affects a conditional or loop, Cascada ensures that corrupted data never silently produces incorrect results by propagating the error to any variables or channels that would have been modified.

#### Error handling with `if` and `switch` statements

If the condition of an `if` statement (or the expression of a `switch` statement) evaluates to an Error Value, all branches are skipped, and the error is propagated to any variables or channels that would have been modified within any branch.

```javascript
var user = fetchUser(userId)  // May fail
var accessLevel  // declare in outer scope

// If user is an Error Value, both branches are skipped
// and accessLevel becomes poisoned (it would have been modified)
if user.role == "admin"
  accessLevel = "full"
else
  accessLevel = "limited"
endif

// If user was an error, accessLevel is now poisoned
```

This behavior is important to understand: it's not just that the code doesn't execute - any variables or channels that would have been assigned in any of the branches become poisoned. This ensures you can detect downstream that something went wrong, rather than having undefined or stale values.

**Note:** `switch` statements behave identically - if the switch expression is an Error Value, all `case` and `default` branches are skipped and their outputs become poisoned.

#### Error handling with loops

If a loop's iterable evaluates to an Error Value, the loop body is skipped and the error propagates to any variables or channels that would have been modified by the loop.

```javascript
var posts = fetchPosts()  // May fail
data out

// If posts is an Error Value, loop body is skipped
// and out becomes poisoned
for post in posts
  out.titles.push(post.title)
endfor

// If posts was an error, out is now poisoned
```

Similar to conditionals, the loop doesn't just skip execution - any outputs or variables that the loop body would have modified become poisoned, ensuring error detection downstream.

For details on detecting and recovering from errors in your scripts, see the [Error Handling](#error-handling) section.


## Channels

Channels are named values you build over time. You write into them with assignments and method calls, and read the current assembled value with `snapshot()`. They are the main tool for ordered writes and external interactions in Cascada Script: their writes run as soon as their inputs are ready, and the final assembled result still follows source-code order.

Channels also participate in Cascada's error-propagation model; for the full rules on poisoning, detection, and recovery, see [Error Handling](#error-handling).

| Declaration | Type | Purpose |
|---|---|---|
| `text name` | Text channel | Build a text string |
| `data name` | Data channel | Build structured objects and arrays |
| `sequence name = initializer` | Sequence channel | Sequential reads and calls on an external object |

Use `name.snapshot()` to read the current assembled value. `snapshot()` is an observable operation - it waits for any pending writes to finish before returning. Because of that, it is more expensive than reading a plain `var`, so prefer `var` for simple cases and reach for `data`, `text`, or `sequence` when you need ordered assembly or external interaction.

### A Simple Example

Before diving into the details, here's a simple `text` channel example:

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
text log
log("Starting import\n")
for user in users
  log("Imported: " + user.name + "\n")
endfor
log("Done.")
return log.snapshot()
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Text</strong></summary>

```text
Starting import
Imported: Alice
Imported: Bob
Done.
```
</details>
</td>
</tr>
</table>

### How Channel Writes Are Ordered

Channel writes execute as soon as their required input data is available, following the same data-driven scheduling as the rest of Cascada. The key guarantee is that the **assembled result is always in source-code order**, regardless of when individual writes actually execute.

### The `text` Channel: Generating Text

The `text` channel builds a string of text. It is the simplest channel to reach for when concurrent code needs to contribute to one final piece of text while preserving source-code order.

```javascript
text log
log("Processing user " + userId + "...")
for item in items
  log("Item: " + item.name)
endfor
log("...done.")
return log.snapshot()
```

Two write forms:

| Syntax | Description |
|---|---|
| `name(expr)` | Appends `expr` to the text stream |
| `name = expr` | Overwrites the entire text with `expr` |

### The `data` Channel: Building Structured Data
The `data` channel is the main tool for constructing structured output. It is especially useful when concurrent code needs to build arrays or objects in a predictable order - all writes execute concurrently, but the assembled result always matches source-code order. This is the right alternative to [mutation methods on plain `var` values](#mutation-methods-and-side-effects), which race in concurrent code.

The key difference from a plain `var` is that `data` operations such as `.push()`, `.merge()`, and `.append()` are **channel commands**, not ordinary JavaScript in-place mutations. They are scheduled and assembled safely by Cascada, so they remain safe even when multiple concurrent branches write to the same `data` channel. On a plain `var`, those same method names are just standard JavaScript side effects on the current value, so concurrent calls do not get ordered assembly guarantees.

Use a plain `var` when you are building a value locally in one place, or when you genuinely do not need channel ordering/assembly behavior. Use a `data` channel when multiple concurrent branches contribute to the same result, or when you want ordered path-based construction without shared-mutation races.

As a rule of thumb, `data` channels optimize for correctness and ordered assembly, not raw in-memory mutation speed. On very large nested structures, many fine-grained property writes can be slower than composing a plain object or array locally and assigning or returning it once.

Here's a simple example:

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
data out

// Set a simple value
out.user.name = "Alice"
// Initialize 'logins' and increment it
out.user.logins = 0
out.user.logins++

// The 'roles' array is created
// automatically on first push
out.user.roles.push("editor")

return out.snapshot()
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Assembled Data</strong></summary>

```json
{
  "user": {
    "name": "Alice",
    "logins": 1,
    "roles": [ "editor" ]
  }
}
```
</details>
</td>
</tr>
</table>

#### Implicit Initialization in `data`

The `data` channel automatically initializes **structural values** when assembling output. This allows data to be built declaratively without manual setup.

###### What `data` Initializes Automatically

* **Objects (`{}`)**
  Created on first property write or object operation (`merge`, `deepMerge`).

  ```cascada
  out.user.name = "Alice"
  out.settings.merge({ theme: "dark" })
  ```

* **Arrays (`[]`)**
  Created on first array operation.

  ```cascada
  out.items.push("a")
  ```

* **Strings (`""`) - string operations only**
  Created on first string-specific operation.

  ```cascada
  out.log.append("Started\n")
  out.title += "!"
  ```

###### What `data` Does *Not* Initialize

Scalar values must be explicitly initialized before use:

* **Numbers**

  ```cascada
  out.count = 0
  out.count++
  ```

* **Booleans / logical values**

  ```cascada
  out.ready = false
  out.ready ||= true
  ```

###### Summary

| Type    | Auto-initialized | Notes                  |
| ------- | ---------------- | ---------------------- |
| Object  | Yes              | Structural operations  |
| Array   | Yes              | Structural operations  |
| String  | Yes              | String operations only |
| Number  | No               | Must initialize        |
| Boolean | No               | Must initialize        |

#### `data` Operations
Below is a detailed list of all available commands and operators.

**Assignment and Deletion**

| Command | Description |
|---|---|
| `name.path = value` | **Replaces** the value at `path`. Creates objects/arrays as needed. Shorthand for `set`. |
| `name.path.delete()` | **Deletes** the value at `path`. |

**Array Operations**

| Command | Description |
|---|---|
| `name.path.push(value)` | Appends an element to the array at `path`. |
| `name.path.concat(value)` | Concatenates another array or value to the array at `path`. |
| `name.path.pop()` | Removes the last element from the array at `path`. |
| `name.path.shift()` | Removes the first element from the array at `path`. |
| `name.path.unshift(value)`| Adds one or more elements to the beginning of the array at `path`. |
| `name.path.reverse()` | Reverses the order of the elements in-place. |
| `name.path.at(index)` | Replaces `path` with the element at the specified `index`. |
| `name.path.sort()` | Sorts the array at `path` in-place. |
| `name.path.sortWith(func)` | Sorts the array using a custom comparison function. |
| `name.path.arraySlice(start, [end])`| Replaces `path` with a slice of the array. |

**Object Manipulation**

| Command | Description |
|---|---|
| `name.path.merge(value)` | Merges the properties of an object into the object at `path`. Shallow merge. |
| `name.path.deepMerge(value)`| Deeply merges the properties of an object into the object at `path`. |

**Arithmetic Operations**
These operators require the target to be a number (must be initialized first).

| Command | Description |
|---|---|
| `name.path += value` | Adds a number to the target. |
| `name.path -= value` | Subtracts a number from the target. |
| `name.path *= value` | Multiplies the target by a number. |
| `name.path /= value` | Divides the target by a number. |
| `name.path++` | Increments the target number by 1. |
| `name.path--` | Decrements the target number by 1. |
| `name.path.min(value)` | Replaces target with `min(target, value)`. |
| `name.path.max(value)` | Replaces target with `max(target, value)`. |

**String Operations**
String is created automatically if the path does not exist.

| Command | Description |
|---|---|
| `name.path += value` | Appends a string to the target. |
| `name.path.append(value)`| Appends a string to the string value at `path`. |
| `name.path.toUpperCase()` | Replaces with uppercase version. |
| `name.path.toLowerCase()` | Replaces with lowercase version. |
| `name.path.slice(start, [end])` | Replaces with the extracted section. |
| `name.path.substring(start, [end])`| Replaces with the extracted section (no negative indices). |
| `name.path.trim()` | Removes whitespace from both ends. |
| `name.path.trimStart()` | Removes leading whitespace. |
| `name.path.trimEnd()` | Removes trailing whitespace. |
| `name.path.replace(find, replace)` | Replaces the first occurrence. |
| `name.path.replaceAll(find, replace)` | Replaces all occurrences. |
| `name.path.split([separator])` | Replaces with an array of substrings. |
| `name.path.charAt(index)` | Replaces with the character at the specified index. |
| `name.path.repeat(count)` | Repeats the string `count` times. |

**Logical & Bitwise Operations**

| Command | Description |
|---|---|
| `name.path &&= value` | Logical AND assignment. |
| `name.path \|\|= value` | Logical OR assignment. |
| `name.path &= value` | Bitwise AND assignment. |
| `name.path \|= value` | Bitwise OR assignment. |
| `name.path.not()` | Logical NOT. |
| `name.path.bitNot()` | Bitwise NOT. |

#### Advanced Pathing

Paths in `data` commands are highly flexible.

*   **Dynamic Paths**: Paths can include variables and expressions.
    ```javascript
    for user in userList
      result.report.users[user.id].status = "processed"
    endfor
    ```
*   **Root-Level Modification**: Use the `data` value directly to replace the root.
    ```javascript
    // Replaces the entire data object with a new one
    result = { status: "complete", timestamp: now() }
    ```
    After re-assignment, you can use methods appropriate for the new type:
    ```javascript
    result = []
    result.push("first item")
    ```
*   **Array Index Targeting**: Target specific array indices with square brackets. The empty bracket notation `[]` refers to the last item added in the script's sequential order.
    ```javascript
    result.users[0].permissions.push("read")

    result.users.push({ name: "Charlie" })
    result.users[].permissions.push("read") // Affects "Charlie"
    ```

#### Handling Missing and `none` Targets
*   **Structure-building methods** (`.push()`, `.merge()`, `.append()`) can create the needed structure when the target path does not exist yet.
*   **Arithmetic and logical operators** (`+=`, `--`, `&&=`, etc.) throw a runtime error if the target is `none`/`null` or missing. Initialize explicitly first.

#### Extending `data` with Custom Methods

You can add your own custom methods or override existing ones for the built-in `data` channel using `env.addDataMethods()`. This lets you extend `data` with domain-specific operations while keeping the same ordered channel semantics.

```javascript
// In your JS setup
env.addDataMethods({
  // methodName is how you'll call it in the script: name.path.methodName(...)
  methodName: function(target, ...args) {
    // ... your logic ...
    return newValue;
  }
});
```

**Parameters:**

*   `target`: The current value at the path the command is targeting. If the path doesn't exist yet, `target` will be `undefined`.
*   `...args`: A list of the arguments passed to the method in the script.

**Return Value:**

*   **If you return any value**, it **replaces** the `target` value at that path.
*   **If you return `undefined`**, it signals the engine to **delete** the property at that path.

**Overriding Operators:**

All shortcut operators (`+=`, `++`, `&&=`, etc.) are mapped to underlying methods.

| Operator | Corresponding Method |
|---|---|
| `name.path = value` | `set(target, value)` |
| `name.path += value` | `add(target, value)` |
| `name.path -= value` | `subtract(target, value)` |
| `name.path *= value` | `multiply(target, value)` |
| `name.path /= value` | `divide(target, value)` |
| `name.path++` | `increment(target)` |
| `name.path--` | `decrement(target)` |
| `name.path &&= value` | `and(target, value)` |
| `name.path \|\|= value` | `or(target, value)` |
| `name.path &= value` | `bitAnd(target, value)` |
| `name.path \|= value` | `bitOr(target, value)` |

**Example: Adding a custom `upsert` method**

```javascript
// --- In your JavaScript setup ---
env.addDataMethods({
  upsert: (target, newItem) => {
    if (!Array.isArray(target)) {
      target = [];
    }
    const index = target.findIndex(item => item.id === newItem.id);
    if (index > -1) {
      Object.assign(target[index], newItem);
    } else {
      target.push(newItem);
    }
    return target;
  }
});

// --- In your Cascada Script ---
data out
out.users.upsert({ id: 1, name: "Alice" })
out.users.upsert({ id: 1, name: "Alice", status: "active" })
return out.snapshot()
```

### The `sequence` Channel

A `sequence` wraps an external object with **strictly sequential** access. All reads and calls happen in source-code order, serialized with the rest of the sequence.

```javascript
sequence db = services.db
var user = db.getUser(1)
var state = db.connectionState
return { user: user, state: state }
```

```javascript
sequence db = services.db
var id = db.api.client.getId()
return id
```

**Key characteristics:**
- The initializer **must** come from the context object
- Supports value-returning calls: `var x = seq.method(args)`
- Supports property reads: `var s = seq.status`
- Supports nested sub-path calls: `var id = seq.api.client.getId()`
- Supports `snapshot()`: `var snap = seq.snapshot()`
- Property assignment is currently a compile error, but this is expected to be supported in the future


```javascript
sequence db = services.db
db.connectionState = "offline"  // ❌ compile error - assignment not allowed
```

If a `sequence` becomes poisoned, the built-in way to recover it is with a `guard`. See [Protecting State with `guard`](#protecting-state-with-guard).

### The `sequence` Channel vs. `!`

`sequence` and `!` both give you ordering, but they solve different problems:

| | `sequence` | `!` marker |
|---|---|---|
| **What it is** | A declared channel | A marker on a static context path |
| **What it is for** | Ordered reads and calls on one object | Ordering side effects on one path |
| **Return values** | Read immediately in normal expressions | Mainly used for side-effectful operations |
| **Example** | `var user = db.getUser(1)` | `db!.insert(user)` |

Use `sequence` when the object itself is your ordered interface. Use `!` when you want to serialize side effects on a context path.

For details on the `!` operator, see [Sequential Execution Control](#managing-side-effects-sequential-execution).


### Error handling and recovery with channels

When an Error Value is written to a channel, that channel becomes **poisoned**. This means the channel's final output will be an Error Value, which causes the current script's `snapshot()` or `return` to fail.

```javascript
data out
var user = fetchUser(userId)  // May fail

// If user is an Error Value, this write poisons out
out.userName = user.name

// out is now poisoned - returning it will fail the script
return out.snapshot()
```

You can protect these values from poisoning and recover from errors using `guard` blocks:

```javascript
data out
guard
  var payload = fetchData()  // May fail
  out.result = payload
recover err
  out.result = "fallback value"
endguard
return out.snapshot()
```

For details, see [Protecting State with `guard`](#protecting-state-with-guard).


## Managing Side Effects: Sequential Execution with `!`

For functions with **side effects** (e.g., database writes), the `!` marker enforces a **sequential execution order** for a specific object path. Once a path is marked, *all* subsequent method calls on that path (even those without a `!`) will wait for the preceding operation to complete, while other independent operations continue to run concurrently.

Sequential paths also participate in Cascada's error-propagation model; for the full rules on poisoning, repair, and recovery, see [Error Handling](#error-handling).

```javascript
// The `!` on deposit() creates a
// sequence for the 'bank.account' path.
bank.account!.deposit(100)
bank.account.getStatus()
bank.account!.withdraw(50)
```

For details on how to handle errors within a sequential path, see [Repairing Sequential Paths with `!!`](#repairing-sequential-paths-with-) in the Errors Are Data section.

### Method-Specific Sequencing

You can also sequence calls to a **specific method** on an object, rather than locking the whole object. Place the `!` after the method name:

```javascript
// Only calls to 'log' are sequential
logger.log!("Entry 1")
logger.log!("Entry 2")

// Unmarked methods run concurrently
logger.getStatus()
```

This is useful for rate-limiting or ordering specific actions (like "append") while keeping the rest of the object non-blocking. Note that unlike object-path sequencing (`obj!.method()`), unmarked calls to the same method (`logger.log()`) will **not** wait for the sequence.

### Ordered External APIs

Use sequential paths for stateful external APIs that need strict ordering. For example, a turtle graphics object can be provided in the render context, and each drawing command can be ordered with `!`:

```javascript
// `turtle` is provided by the render context.
turtle!.penDown()
turtle!.moveTo(10, 10)
turtle!.lineTo(50, 10)
turtle!.lineTo(50, 40)
turtle!.penUp()
```

Only the `turtle` path is serialized. Other independent work in the script can still run concurrently.


### Context Requirement for Sequential Paths

Sequential paths must reference objects from the context, not local variables.
The JS context object:
```javascript
// Assuming 'db' is provided in the context object:
const context = { db: connectToDatabase() };
```
The script:
```javascript
// ✅ CORRECT: Direct reference to context property
db!.insert(data)

// ❌ WRONG: Local variable copy
var database = db
database!.insert(data)  // Error: sequential paths must be from context
```

Nested access from context properties works fine:
```javascript
services.database!.insert(data)  // ✅ CORRECT (if 'services' is in context)
```

**Why this restriction?** The engine uses object identity from the context to guarantee sequential ordering. Copying context objects to local variables breaks this tracking, which is why it's not allowed.

Support for using `!` through `function` parameters is planned, but it is not implemented yet.


## Functions and Reusable Components

Functions in Cascada Script are declared with `function ... endfunction`. They let you define reusable chunks of logic that build and return values. They operate in a completely isolated scope and are the primary way to create modular, reusable components in Cascada Script.

These functions use `return` to return values. If no `return` runs, the
function returns `none`. Channels declared inside a function are local to that
function.

### Defining and Calling a Function

A function can call async functions and use `return` to provide its result. Like a script, it runs to completion before its return value is available to the caller.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
function buildDepartment(deptId)
  // These two async calls run concurrently.
  var manager = fetchManager(deptId)
  var team = fetchTeamMembers(deptId)

  return { manager: manager.name, teamSize: team.length }
endfunction

// Call the function. 'salesDept' is the returned object.
var salesDept = buildDepartment("sales")

return { company: { sales: salesDept } }
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Return Value</strong></summary>

```json
{
  "company": {
    "sales": {
      "manager": "David",
      "teamSize": 15
    }
  }
}
```
</details>
</td>
</tr>
</table>

### Keyword Arguments
Functions support keyword arguments, allowing for more explicit and flexible calls. You can define default values for arguments, and callers can pass arguments by name.

```javascript
// Function with default arguments
function input(name, value="", type="text")
  return { name: name, value: value, type: type }
endfunction

// Calling with mixed and keyword arguments
var passwordField = input("pass", type="password")
return passwordField
// { name: "pass", value: "", type: "password" }
```

### Returning a Computed Value

Functions can `return` any ordinary value directly - a primitive, an object literal, or a variable. Channels themselves are not returned directly; use `snapshot()` and return the resulting value:

```javascript
function computeTotal(items)
  var sum = 0
  for item in items
    sum = sum + item.price
  endfor
  return sum
endfunction

var total = computeTotal([
  { price: 10 },
  { price: 20 },
  { price: 30 }
])
return total  // 60
```

### Dynamic Call Blocks (`call`)

A `call` block lets you pass a chunk of code to a function as a callback. The function controls when and how that code executes by calling `caller()` with explicit arguments.

#### Syntax

In **scripts**, `call` blocks must be used in assignment form:

```javascript
var x = call functionName(args)
  (param1, param2)  // Declare parameters
  // Block body - use return to provide the value
  return someValue
endcall
```

Or the assignment form without initialization:
```javascript
x = call functionName(args)
  // ...
endcall
```

Bare `call` blocks (without assignment) are not supported in scripts.

The function invokes the callback by passing arguments:

```javascript
function functionName(args)
  var result = caller(value1, value2)
endfunction
```

If no parameters are needed, the `()` can be omitted from the call block.

#### Example: Grid Generator

```javascript
function grid(rows, cols)
  data cells = []
  for y in range(rows)
    for x in range(cols)
      var cell = caller(x, y)  // Pass coordinates
      cells.push(cell)
    endfor
  endfor
  return cells.snapshot()
endfunction

var gridResult = call grid(3, 3)
  (x, y)
  return { position: [x, y], value: x * 10 + y }
endcall

return gridResult
```

#### Example: Simple Value Transformation

```javascript
function sum(items)
  var total = 0
  for item in items
    var value = caller(item)
    total = total + value
  endfor
  return total
endfunction

var result = call sum([{price: 10}, {price: 20}, {price: 30}])
  (item)
  return item.price
endcall
return result  // 60
```

#### Example: Error Handling

```javascript
function withRetry(maxAttempts)
  var attempts = 0
  var result = none

  while attempts < maxAttempts and result is none
    result = caller()
    if result is error
      result = none
      attempts = attempts + 1
    endif
  endwhile

  return result
endfunction

var userData = call withRetry(3)
  var user = fetchUser(userId)
  return user
endcall

return userData
```

#### Variable Scope

The call block runs with access to variables from where it was written, not the function's internal scope:

```javascript
function processItem(transformer)
  var internalVar = "function scope"
  var result = caller(transformer)
  return result
endfunction

var outerVar = "call scope"

var processed = call processItem(item)
  (item)
  // ✅ Can access outerVar; ❌ Cannot access internalVar
  return { item: item, context: outerVar }
endcall

return processed
```

The call block's access to the parent scope is **read-only**:

- **Reads** can see variables from the parent scope (where the call block was written).
- **Writes** (e.g. `x = ...`, `var x = ...`) do **not** propagate to the parent scope. They create/modify variables in the call block's own scope.

This ensures the call block remains decoupled from the function's implementation details.

#### How Call Blocks Work

- **Parameters**: The function explicitly passes values via `caller(args)`, declared as `(params)` in the call block header
- **Return value**: The value provided by `return` in the call block body is returned by `caller()` in the function
- **Caller's context**: The block reads variables from the scope where it was written, not the function's internal scope
- **Execution control**: The function decides when - and how many times - to invoke `caller()`
- **Isolated scope**: Writes inside the call block stay local; the function sees only what `caller()` returns

### Error handling and recovery with functions

Functions participate in the normal dataflow poisoning rules, but they are still called with poisoned arguments and can handle those Error Values explicitly inside the function body. For comprehensive information on error handling and recovery patterns, see the [Error Handling](#error-handling) section.


## Error Handling

Cascada's concurrent-by-default execution creates a unique challenge: when multiple operations run concurrently and one fails, traditional exception-based error handling would need to interrupt the entire execution graph, halting all independent work. Instead, Cascada treats **errors as just another type of data** that flows through your script. Failed operations produce a special **Error Value** that is stored in variables, passed to functions, and can be inspected.

This data-centric model allows independent operations to continue running while failures are isolated to only the variables and operations that depend on the failed result.

### Error Handling Fundamentals

#### Error Handling in Action
Here's a concrete example showing how error propagation works in concurrent execution:

```javascript
// These three API calls run concurrently
var user = fetchUser(123)      // ✅ succeeds
var posts = fetchPosts(123)    // ❌ fails with network error
var comments = fetchComments() // ✅ succeeds

// Only operations depending on 'posts' are affected
var username = user.name           // ✅ works fine
var commentCount = comments.length // ✅ works fine
var postCount = posts.length       // ❌ becomes an error
var summary = posts + " analysis"  // ❌ becomes an error

// You can detect and repair the error
if posts is error
  postCount = 0  // ✅ assign a fallback
  summary = ''   // ✅ assign a fallback
endif

return { username: username, commentCount: commentCount, postCount: postCount, summary: summary }
```

#### The Core Mechanism: Error Propagation

Once an Error Value is created, it automatically spreads to any dependent operation or variable - this process is known as **error propagation**, **dataflow poisoning**, or just **poisoning**. This ensures that corrupted data never silently produces incorrect results.

#### Data Operations

* **Expressions:**
  If any operand in an expression is an error, the entire expression evaluates to that error.

  ```javascript
  var total = myError + 5  // ❌ total becomes myError
  var result = 10 * myError / 2  // ❌ result becomes myError
  ```

* **Function Calls:**
  If an Error Value is passed as an argument, the function still receives it and can detect or repair it explicitly.

  ```javascript
  function processData(value)
    if value is error
      return "fallback"
    endif
    return value.name
  endfunction

  var result = processData(myError)  // "fallback"
  ```

#### Control Flow

* **Loops:**
  A loop whose iterable is an Error Value will not execute its body. The error propagates to all variables and outputs that would have been affected.
    ```javascript
  var itemCount = 0
  for item in myErrorList
    itemCount = itemCount + 1
  endfor
  // ❌ itemCount is now poisoned
  ```

* **Conditionals:**
  If a conditional test evaluates to an Error Value, neither the `if` nor `else` branch executes. The error propagates to all variables modified by either branch.

  ```javascript
  if myErrorCondition
    result = "yes"
  else
    result = "no"
  endif
  // ❌ The 'result' variable is now an Error Value
  ```

#### Channels & Effects

* **Channels:**
  If an Error Value is written to a channel, that channel becomes **poisoned**, causing the script to fail when the channel is read or returned.

* **Sequential Side-Effect Paths:**
  If a call in a sequential execution path (marked with `!`) fails, that path becomes **poisoned**. Later operations using the same `!path` will instantly yield an Error Value without executing.

  ```javascript
  context.database!.connect()      // ❌ fails
  context.database!.insert(record) // ❌ skipped, returns error immediately
  context.database!.commit()       // ❌ skipped, returns error immediately
  ```

This mechanism ensures that once an operation fails, all dependent results and channels reflect that failure, maintaining data integrity across both concurrent and sequential execution flows.
#### Deciding When to Handle Errors

**❌ Do not handle errors, let them propagate when:**
- The operation is critical to the final output
- You want the entire script to fail if this operation fails
- The error should bubble up to the calling JavaScript/TypeScript code
- There's no reasonable fallback or default value
- You're building a strict data pipeline where partial results are unacceptable

**✅ Handle errors locally when:**
- You have a sensible fallback or default value
- The operation is optional or non-critical
- You're implementing retry logic for transient failures
- You're aggregating results where partial success is acceptable
- You want to collect multiple errors for reporting without halting execution
- The error represents a business-logic case that should produce specific output (e.g., "user not found" → guest mode)

```javascript
// ❌ Critical operation - let it propagate and fail the script
var primaryData = fetchCriticalData()

// ✅ Optional enhancement - handle locally
var recommendations = fetchRecommendations()
if recommendations is error
  recommendations = []  // Not critical, use empty array as fallback
endif

return { report: primaryData.summary, recommendations: recommendations }
```

#### How Scripts Fail

A script fails only if the value you return is an Error Value.

You can have poisoned values inside the script and still succeed, as long as you repair them or avoid returning them:

```javascript
var user = fetchUser(999)  // ❌ Returns an error

if user is error
  user = { name: "Guest" }  // ✅ Repaired
endif

return user.name  // ✅ Script succeeds: "Guest"
```

If the returned value is still poisoned, the script fails:

```javascript
var user = fetchUser(999)  // ❌ Returns an error
return user.name  // ❌ Script fails
```

### Detecting and Inspecting Errors

#### Detecting and Repairing Errors

The fundamental way to detect if a variable holds an Error Value is the `is error` test. Once detected, you can "repair" it by re-assigning the variable.

**Example: Assigning a Fallback Value**
```javascript
var user = fetchUser(999)  // assumed to fail

if user is error
  var msg = user#message  // peek at the error details
  user = { name: "Guest", isDefault: true }
endif

return user.name  // 'Alice' or 'Guest' depending on success
```

**Example: Retrying a Failed Operation**
```javascript
var retries = 0
var user
var success = false

while retries < 3 and not success
  user = fetchUser(123)
  if user is not error
    success = true
  else
    retries = retries + 1
  endif
endwhile

if user is error
  user = { name: "Guest", isDefault: true }
endif

return user
```

#### Peeking Inside Errors with `#`

Because of error propagation, a standard property access like `myError.message` would just return `myError` again. To inspect the properties of an Error Value itself, use the special **`#` (peek) operator**. This operator "reaches through" the error to access its internal properties without triggering propagation.

```javascript
var failedUser = fetchUser(999)

if failedUser is error
  var message = failedUser#message
  var origin = failedUser#source.origin
endif
```

**`x#` returns `none` when `x` is not an error.** Always check with `is error` before peeking:

```javascript
context.db!.insert(data)  // ✅ Succeeds

// ❌ WRONG: Peeking at healthy value returns none, not an error
var msg = context.db!#message  // none - not useful

// ✅ CORRECT: Check first, then peek
var msg
if context.db! is error
  msg = context.db!#message  // Safe
endif
```

#### Anatomy of an Error Value

An Error Value is a rich object designed for easy debugging. Access its properties with the `#` peek operator.

*   **`errors`**: (array) A list of one or more underlying error objects:
    *   **`message`**: (string) The specific error message.
    *   **`name`**: (string) A custom name for business-logic errors (e.g., `'ValidationError'`).
    *   **`lineno`**: (number) The line number where the error occurred.
    *   **`colno`**: (number) The column number.
    *   **`path`**: (string) The script file where the error originated.
    *   **`operation`**: (string) A description of the internal operation (e.g., `FunCall`, `LookupVal`, `Add`).
    *   **`cause`**: (object | null) The original JavaScript `Error` object, if applicable.
*   **`message`**: (string) A summary of all individual error messages.

#### Handling Multiple Concurrent Errors

When multiple operations fail concurrently, their errors are collected into a single `PoisonError` that holds all the original errors.

```javascript
var user = fetchUser(999)        // ❌ fails
var profile = fetchProfile(999)  // ❌ fails
var settings = fetchSettings(999) // ❌ fails

var summary = user.name + " - " + profile.bio + " - " + settings.theme

if summary is error
  var count = summary#errors | length  // 3

  data errorList = []
  each err in summary#errors
    errorList.push({
      message: err#message,
      source: err#source.origin
    })
  endeach

  summary = "User data unavailable"
endif
```

This aggregation is particularly valuable in error reporting and debugging, as you can see all failures that occurred in a concurrent batch rather than just the first one encountered.

### Advanced Recovery Mechanisms

#### Repairing Sequential Paths with `!!`

When a sequential path becomes poisoned, the `!!` operator provides two ways to recover:

**Repair the Path:**
Use `!!` alone to clear the poison state.

```javascript
context.db!.insert(data)  // ❌ Fails and poisons the path

context.db!!  // ✅ Repairs the path

context.db!.insert(otherData)  // ✅ Now executes
```

**Repair and Execute:**
Use `!!` before a method call to repair the path and then execute the method.

```javascript
context.db!.beginTransaction()
context.db!.insert(userData)      // ❌ Fails, poisons path
context.db!.insert(profileData)   // ❌ Skipped due to poison

// ✅ Repairs path and executes rollback
context.db!!.rollback()
```

This is particularly useful for cleanup operations that must run regardless of failure:

```javascript
var file = context.fileSystem!.open(path)
context.fileSystem!.writeHeader(metadata)
var writeResult = context.fileSystem!.writeData(data)  // ❌ Might fail

// ✅ Always close the file, even if writes failed
context.fileSystem!!.close()
```

**Checking Path State:**
```javascript
context.api!.sendRequest(data)  // ❌ Might fail

if context.api! is error
  var message = context.api!#message
  context.api!!  // Repair the path
endif
```

#### Protecting State with `guard`

The `guard` block provides **controlled, transaction-like recovery** for your script. It allows you to attempt complex operations with the confidence that if something goes wrong, Cascada will automatically restore selected state.

You can think of `guard` like a save point: if the block finishes in an error, the specified state is restored before recovery logic runs.

#### Syntax

```javascript
guard [targets...]
  // 1. Attempt risky operations
  // 2. Changes to guarded targets are tracked for recovery
recover [err]  // Optional recover block; 'err' variable binding is also optional
  // 3. Runs ONLY if the guard block remains poisoned
  // 4. Guarded state has already been restored
endguard
```

---

#### Default Protection: Channels & Sequences

By default, a `guard` block (with no arguments) protects:

1. **All channels** (`data`, `text`, `sequence`)
   Writes made inside the block are discarded on error.
   For `sequence` channels, this is also the built-in way to recover from poisoning. If the underlying object provides `begin()`, `commit()`, and `rollback()` hooks, `guard` uses them automatically. Missing hooks are tolerated. Hook errors become guard errors.

2. **All sequential-operation lock paths** (`!`)
   If a path such as `db!` becomes poisoned, it is automatically repaired with `!!`.
   Paths are hierarchical - guarding `api!` also guards `api.db!`, `api.connection!`, etc.

**Variables are NOT protected by default.**

##### Example: Database Transaction

```javascript
// db! is a sequential path from context
db!.beginTransaction()

data out

guard
  out.status = "processing"

  db!.insert(user)
  db!.update(account) // ❌ Assume this fails

  db!.commit()
  out.status = "success"

recover err
  // STATE RESTORED:
  // - data channel writes inside the guard are reverted
  // - db! is repaired and safe to use

  db!.rollback()
  out.error = "Transaction failed: " + err#message
endguard

return out.snapshot()
```

##### Example: Guarding a `sequence` Channel

```javascript
sequence tx = services.tx
var state = "starting"

guard tx, state
  state = "running"
  tx.step("A")
  tx.fail()
  state = "done"
recover err
  state = "rolled back"
endguard
```

---

#### Selective Protection

You can explicitly specify what the guard should protect.

```javascript
// Protects the out data channel, the db! path, and the 'status' variable
guard out, db!, status
```

##### Selectors

| Selector | Meaning |
|----------|---------|
| `guard` (no selectors) | Global guard: protects all channels and sequential-operation locks touched inside the block |
| `guard *` | Protect everything (all channels, all lock paths, all variables written inside the guard) |
| `guard var` | Protect all variables written inside the guard |
| `guard data` | Protect all `data` channel declarations touched inside the guard |
| `guard text` | Protect all `text` channel declarations touched inside the guard |
| `guard sequence` | Protect all `sequence` channel declarations touched inside the guard |
| `guard name1, name2` | Protect specific declaration names (channels or variables) |
| `guard lock!` | Protect a specific sequential-operation lock path (e.g., `db!`) |
| `guard !` | Protect all sequential-operation lock paths touched inside the guard |

> **Rules:**
> - `*` cannot be combined with any other selector
> - Duplicate selectors are invalid
> - Lock selectors (`lock!`, `!`) are for sequential-operation lock paths, not `sequence` channels

**Hierarchical Protection of Sequential Paths:**
```javascript
guard api!
  api!.connect()
  api.db!.insert(data)         // Also protected (child of api!)
  api.connection!.setState(s)  // Also protected (child of api!)
endguard
```

##### Example: Protecting Specific Variables or Channel Types

```javascript
var attempts = 0
var lastLog = ""
data result

guard attempts, data
  attempts = attempts + 1
  result.try = attempts
  lastLog = "Trying..."  // not protected

  riskyOperation() // ❌ Fails
recover err
  // 'attempts' is restored to 0
  // 'data' channel writes are reverted (all data channels)
  // 'lastLog' remains "Trying..." (not protected, so not restored)
endguard
```

---

#### `guard *` (Protect Everything)

```javascript
guard *
  var x = calculate()
  var y = fetch()
endguard
```

**⚠️ Performance warning**
When variables are protected (via `guard *` or explicit variable names), any code that depends on such variables must wait for the guard to finish. This can reduce concurrency. Use `guard *` only for small, tightly scoped operations.

---

#### The `recover` Block

The `recover` block is optional. If omitted, the guard silently restores protected state and execution continues after `endguard`.

If present, it runs only if the guard finishes poisoned:

* Guarded `data`, `text`, and `sequence` values have already been reverted
* Guarded sequential paths have already been repaired
* Guarded variables have already been restored
* `recover err` binds the final `PoisonError` for inspection via the `#` peek operator — the variable name is optional; bare `recover` (without a binding) is also valid

> Note: If all errors are detected and repaired inside the guard (using `is error`), the guard is considered successful and no recovery occurs.

#### Manually Reverting Channel State

> ⚠️ **Work in progress:** The `revert` statement for manually resetting channel state inside a `guard` block is not yet available in script mode.

When implemented, `revert` will reset all `data`, `text`, and `sequence` values in the current channel scope to their state at the start of the nearest enclosing scope boundary (e.g., the start of the `guard` block). This provides fine-grained control complementing automatic guard recovery.

#### Error Handling with Sequential Operations

```javascript
db!.beginTransaction()

var insertResult = db!.insert("users", userData)
var updateResult = db!.update("profiles", profileData)

var status
var errorMsg

if db! is error
  db!!.rollback()
  status = "transaction_failed"
  errorMsg = db!#message
else
  db!.commit()
  status = "success"
endif

return { status: status, error: errorMsg }
```


## Return Statements

Use `return` to explicitly shape what a script, function, method, or call block
produces. After a `return` runs, later statements in that same callable body are
skipped.

```javascript
// Return a simple value
return 42

// Return no value
return

// Return an explicit null value
return none

// Return a variable
return user

// Return an object literal
return { name: user.name, count: items.length }

// Build with plain variables and return them directly
var report = { name: user.name, count: items.length }
return report

// Use snapshot() only when you are intentionally building through data/text/sequence
data reportData
reportData.user.name = "Alice"
return reportData.snapshot()
```

`snapshot()` captures the assembled value at that point, waiting for all pending writes to complete. It can be called anywhere after the declaration is made.

For most cases, returning a `var` or a plain object literal is simpler than declaring `data`, `text`, or `sequence`. Use those constructs when you need ordered writes, structured path updates, text building, or `sequence` behavior.

If no `return` runs, or if you use bare `return`, the JavaScript API resolves
with `null`, the same value used for Cascada `none`.

## Composition and Loading

When a project grows beyond a single file, Cascada Script provides two file-composition tools plus component instances:

- **`import`** — load a library of reusable functions from another file
- **`extends` / `method`** — inherit a base script's structure and override specific behaviors
- **`component`** — create isolated, independently-stateful instances of a script hierarchy

All composition inputs use the same **payload** model: values passed with `with` become bare-name inputs inside the composed file. Payload is copied at the composition boundary and is not shared state. There is no implicit sharing of caller-scope variables.

### Importing Libraries with `import`

Use `import` to share public root-scope declarations across multiple scripts — helper functions, reusable constants, and assembled channel values — without duplicating them. Public declarations are root-scope names that do not start with `_`. Exported non-`shared` channel declarations are exposed through their final snapshots, so importing a `text` or `data` channel gives the assembled value rather than the channel object itself. `shared` declarations belong to `extends`/`component` state and are accessed through `this.<name>`, not through import namespaces.

#### Importing a Namespace with `as`

Bind the library to a name and call its functions through that namespace:

```cascada
// formatters.script
function formatUser(user)
  return user.firstName + " " + user.lastName
endfunction
```

```cascada
// main.script
import "formatters.script" as fmt

var user = fetchUser(1)
return { name: fmt.formatUser(user) }
```

This returns `{ name: "Alice Durand" }`.

#### Importing Specific Names with `from`

Pull specific functions directly into the caller's namespace instead:

```cascada
// formatters.script — same file as above
function formatUser(user)
  return user.firstName + " " + user.lastName
endfunction
```

```cascada
// main.script
from "formatters.script" import formatUser

var user = fetchUser(1)
return { name: formatUser(user) }
```

This returns `{ name: "Alice Durand" }`.

Use `as` when importing several functions from the same library; use `from ... import` when you only need one or two specific names directly in scope.

#### Passing Values to Libraries with `with`

A library can read payload values passed by the caller with `with`. Here the same library is enriched with a configurable `locale`:

```cascada
// formatters.script
function formatUser(user)
  var selectedLocale = locale or "en"
  return user.firstName + " " + user.lastName + " [" + selectedLocale + "]"
endfunction
```

```cascada
// main.script
var locale = "fr"
import "formatters.script" as fmt with locale

var user = fetchUser(1)
return { user: fmt.formatUser(user) }
```

This returns `{ user: "Alice Durand [fr]" }`.

Instead of passing an explicit var, you can expose the render context as payload:

```cascada
// main.script — locale comes from the render context, no child var needed
import "formatters.script" as fmt with context

var user = fetchUser(1)
return { user: fmt.formatUser(user) }
```

This returns `{ user: "Alice Durand [en-GB]" }` when `locale` comes from the render context.

`from ... import` follows the same `with` rules. Named inputs always take priority over context lookup. The full payload rules are in the next section.

### `with`: Composition Payload

**`with varName, ...`** — passes the named parent `var`s by value into the child. Only `var` declarations can be listed; `data`, `text`, and `sequence` declarations cannot cross a composition boundary.

**`with { key: expr, ... }`** — an explicit object literal; keys become named inputs inside the child, values are expressions evaluated in the caller's scope. Merged after named-var entries; overrides on key collision.

**`with context`** — makes the render context (the object passed to the renderer) available to bare-name lookups inside the child. It does **not** expose parent local variables or `data`/`text`/`sequence` declarations, and it does **not** create a variable named `context` inside the child.

**`without context`** — explicitly opts out of render-context access. Useful to make isolation guarantees visible in code.

All forms can be combined: `with context, var1, { extra: computed() }`. `with` inputs are named value bindings — not a scope reference or JavaScript object — only the names you list cross the boundary.

**Resolution order**: explicit `with` value → `with context` lookup → ordinary globals/unknown-name behavior.

```cascada
import "formatters.script" as fmt with context, locale
// locale — satisfied by the explicit var, which wins over context
// other bare payload names are looked up in context
```

### Script Inheritance with `extends`, `shared`, and `method`

Plain `import` is good for sharing utility functions, but when you need multiple scripts to share a common execution flow — with each one customizing specific steps — you need inheritance. A base script defines the overall logic and calls `this.buildBody(...)` at the right moment; different child scripts override `buildBody` to produce different output, without duplicating the fetch-and-orchestrate code. Child scripts can also add new methods, override the constructor, and set different defaults for shared values.

Three concepts make this work together:

- **`shared` state** — hierarchy-owned values accessible via `this.<name>` from any constructor or method in the chain, regardless of where in the hierarchy the code runs. This is the equivalent of instance fields in OOP.
- **`method` overrides** — named override points declared in a base script and called via `this.method(...)`. The most-derived child's version always runs, regardless of where the call site is. A child can extend rather than replace the parent's behavior with `super()`.
- **Constructor** — the script body (everything after `extends`). It runs the setup and orchestration logic for that level of the chain. Parent constructors run only when the child explicitly calls `super()`.

There are two ways to run an inheritance chain:

- **Direct render** — run the chain once as a script and return a result. Use this when the chain is the top-level entry point.
- **Component** — create an isolated instance with its own shared state and constructor run. The caller interacts through method calls and shared-value observation. Multiple independent instances of the same script can coexist.

A typical pattern: a base report script fetches data, orchestrates the flow, and calls `this.buildBody(...)` to produce the content. Different child scripts supply their own `buildBody` — one for summaries, one for detailed output — without duplicating the fetch-and-orchestrate logic.

> If you know class-based OOP, these map onto familiar concepts — see [Comparison to Class Inheritance](#comparison-to-class-inheritance) at the end of this section.

**Quick reference:**

- [`extends`](#extends-base-and-child-flow) — link a script to a base script
- [`shared`](#shared-shared-state) — declare chain-level state
- [`method`](#method-inherited-dispatch) — define an overridable behavior
- [`super()`](#super-and-super) — call the parent's implementation
- [The `constructor`](#the-constructor-script-body) — the script body; setup logic for one chain level
- [Direct render](#direct-render) — run the chain once and return a result
- [`component`](#component-component-instances) — create isolated instances

#### `extends`: Base and Child Flow

`extends` declares that one script inherits from another. You render the child script, and the base script's constructor can run as part of that chain.

```cascada
// base.script
method buildBody(title, user)
  return user.name + ": " + title
endmethod

var body = this.buildBody(title, user)
return body
```

```cascada
// child.script
extends "base.script"

method buildBody(title, user)
  return "[Custom] " + user.name + ": " + title
endmethod
```

When you render `child.script`, the inherited flow runs with the child's overrides in place.

**Composition payload: `extends ... with`**

`extends` can pass a composition payload to the parent chain. Payload keys are plain bare-name inputs inside constructors and methods.

```cascada
// base.script
shared var theme = initialTheme or "light"

method render(label)
  return "[" + theme + "] " + label
endmethod
```

```cascada
// child.script
extends "base.script" with { initialTheme: "dark" }
```

Supported `with` forms mirror `component` payloads:

```cascada
extends "base.script" with context
extends "base.script" with theme, id
extends "base.script" with context, theme, id
extends "base.script" with { initialTheme: "dark", id: 0 }
extends "base.script" with context, { initialTheme: "dark", id: 0 }
```

`with theme, id` captures the current caller-scope values of `theme` and `id` by their existing names. This shorthand is limited to `var` values.

#### `shared`: Shared State

`shared` declares hierarchy-owned state — values accessible via `this.<name>` from any constructor or method in the chain, regardless of where in the hierarchy the code runs. Unlike local `var` declarations, shared values are not tied to a single constructor scope; they live at the chain level and persist across method calls.

`shared` declarations must appear before `extends`.

**Accessing shared state**

Inside an inheritance chain or component script, shared state is accessed through `this.<name>`, unifying shared-channel reads and writes with inherited method dispatch under a single prefix. From the outside — when calling a component — shared channels are observed through the component binding instead: `ns.theme`, `ns.log.snapshot()`, etc. (see [`component`](#component-component-instances) below). Bare names always follow ordinary ambient lookup (context, globals, composition payload) even when a matching `shared` declaration exists in the same file. `this.theme` reads the shared channel; bare `theme` reads from context.

| Form | Meaning |
|---|---|
| `this.x` | `var`: read (implicit snapshot) |
| `this.x = value` | `var`: write |
| `this.x.a.b` | `var`: read, then property lookup on the snapshot |
| `this.x("msg")` | `text`: append |
| `this.x.path = value` | `data`: set value at path |
| `this.x.command(args)` | `data`: command call (`push`, `merge`, etc.) |
| `this.x.method(args)` | `sequence`: ordered call on the underlying object |
| `this.x.snapshot()` | any: explicit snapshot of current value |
| `this.x is error` | any: true if the channel is poisoned |
| `this.x#` | any: peek the error message |

**Per-file declaration requirement:** Every script that uses `this.<name>` for a shared channel must declare it in that file. Because each file is compiled independently, the compiler needs to know the channel type at compile time — it cannot infer it from a parent file. A parent declaring `shared var theme` does not authorize `this.theme` in a child file that has not declared it. Any bare name — including one that matches a `shared` declaration in the same file — follows ordinary ambient lookup and does not read the shared channel.

**`shared` declaration forms:**

| Declaration | Description |
|---|---|
| `shared var x = value` | Shared variable. Read and written via `this.x`. |
| `shared data x` | Shared `data` channel. Operated on via `this.x.command(...)` and `this.x.path = value`. |
| `shared text x` | Shared `text` channel. Appended via `this.x("msg")`. |
| `shared sequence db = seqExpr` | Shared `sequence` channel with an initializer. Called via `this.db.method(args)`. |
| `shared sequence db` | Declares participation without claiming a default. |

**Default priority rules:**
- A declaration *without* an initializer (`shared var x`) declares participation only — it does not claim a default value for the channel.
- Only a declaration *with* an initializer (`shared var x = expr`) claims the default.
- The first assigned default encountered in child-to-parent startup order wins. Later ancestor defaults for the same channel are not evaluated.
- A shared default expression can read from composition payload — payload values are available at startup time.

The example below uses both surfaces of `this.`: `this.theme` reads the shared var and `this.buildBody(...)` calls the inherited method.

```cascada
// base.script
shared var theme = "light"

method buildBody(title, user)
  return "[" + this.theme + "] " + user.name + ": " + title
endmethod

data result
result.body = this.buildBody(title, user)
return result.snapshot()
```

```cascada
// child.script — must also declare 'theme' to use this.theme
shared var theme = "dark"   // child default wins; base default is not evaluated

extends "base.script"
```

```javascript
await env.renderScript("child.script", {
  title: "Q1 Report",
  user: { name: "Ada" }
})
// { body: "[dark] Ada: Q1 Report" }
```

**`shared` rules:**
- Every file that accesses a shared channel via `this.<name>` must declare it — parent declarations do not extend to child files.
- Only `shared` declarations are allowed before `extends`. Arbitrary `var` declarations before `extends` are not permitted.
- Bare assignment to a declared shared name (`theme = value`) is a compile-time error. Use `this.theme = value`.
- Re-declaring an existing shared channel with a different type is a fatal error. Re-declaring with the same type is a no-op.

#### `method`: Inherited Dispatch

Define override points in the base script with `method ... endmethod`. Call them with `this.methodName(...)` — the `this.` prefix triggers inheritance dispatch and looks up the most-derived override in the chain. A bare `methodName(...)` call is an ordinary local or context call and does not participate in inheritance.

```cascada
// base.script
method buildBody(title, user)
  return user.name + ": " + title
endmethod

var body = this.buildBody(title, user)
return body
```

```cascada
// child.script
extends "base.script"

method buildBody(title, user)
  return "[Custom] " + user.name + ": " + title
endmethod
```

You render the child script. The base script's constructor runs with the child's `buildBody` in place:

```javascript
await env.renderScript("child.script", {
  title: "Q1 Report",
  user: { name: "Ada" }
})
// "[Custom] Ada: Q1 Report"
```

**Method rules:**
- `this.method(...)` participates in inheritance lookup. `this.method` without a call is a compile-time error.
- Every overriding method declares its own argument list.
- Methods return values via `return`. Shared channels are declared before `extends` at the top of the file; methods read and write them via `this.<name>`. Constructor-local variables (declared after `extends`) are not visible inside method bodies.
- Composition payload values are accessible by bare name, and render-context values when `with context` applies (see below).

#### `super()` and `super(...)`

Use `super()` when the child wants to augment the parent's result rather than replace it entirely — adding a prefix, wrapping the output, or delegating to the parent for certain inputs.

Bare `super()` calls the parent method with the original invocation arguments:

```cascada
// child.script — wraps the parent result
extends "base.script"

method buildBody(title, user)
  return "URGENT — " + super()
endmethod
```

With `title: "Q1 Report"` and `user: { name: "Ada" }`, this renders to `"URGENT — Ada: Q1 Report"`.

`super(...)` lets the child pass different arguments to the parent:

```cascada
// child.script — passes modified args to the parent
extends "base.script"

method buildBody(title, user)
  return super(title, { name: "Anonymous" })
endmethod
```

This renders to `"Anonymous: Q1 Report"`.

#### `method ... with context`

A method can declare `with context` to access render-context values by bare name inside the body. The contract is inherited automatically by child overrides — the child does not need to re-declare it:

```cascada
// base.script
method buildBody(title, user) with context
  return "[" + siteName + "] " + user.name + ": " + title
endmethod

var body = this.buildBody(title, user)
return body
```

```cascada
// child.script
extends "base.script"

method buildBody(title, user)
  return "[Child/" + siteName + "] " + user.name + ": " + title
endmethod
```

```javascript
await env.renderScript("child.script", {
  title: "Q1 Report",
  user: { name: "Ada" },
  siteName: "Acme"
})
// "[Child/Acme] Ada: Q1 Report"
```

The default for a method is "without context" unless the base method explicitly declares `with context`. Child overrides and `super()` calls inherit that render-context visibility automatically — the child does not need to re-declare `with context`. Unlike shared channels, which require `this.<name>`, render-context values in a `with context` method are accessible as plain bare names.

#### Direct Render

An `extends` chain can be rendered directly as a script. In that mode, the inheritance chain runs once and returns the result of whichever constructor ran as the active entry: the child's local constructor body if it has one, otherwise the nearest inherited constructor found through the normal dispatch path.

#### The `constructor`: Script Body

The top-level body of every script in the chain is its **constructor**. When the chain runs:

1. The most-derived child's constructor runs first.
2. Each ancestor's constructor runs in turn as `super()` is reached.

If a script has executable body code after `extends`, that code becomes the local constructor body. Parent constructor execution is never automatic inside a real constructor body: it only happens when the body explicitly calls `super()`. If there is no executable body after `extends`, no local constructor is created and normal inherited lookup finds an ancestor constructor if one exists:

```cascada
// child.script
shared var greeting = "Hello"

extends "base.script"

// Local constructor body: super() must be called explicitly.
var processed = doSomething()
super()                       // parent constructor runs here
result.extra = processed      // runs after the parent constructor completes
```

**Return semantics**: `super()` returns the parent constructor's return value to the calling constructor body, where it can be used locally. For direct render, the final script result is the `return` from the active constructor entry — the child's local body if it has one, otherwise the inherited constructor that ran.

`extends` marks an async boundary. The constructor body (everything after `extends`) starts executing after the inheritance chain has been set up and the shared metadata has been registered.

#### Conditional or Optional `extends`

The `extends` target can be any expression, including a conditional expression. If that expression evaluates to `none` or `null`, the script simply has no parent and acts as the root of its own chain:

```cascada
// base.script
shared var theme = "light"

extends parentScript if useInheritance else none

method buildBody(title, user)
  return "[" + theme + "] " + user.name + ": " + title
endmethod

return this.buildBody(title, user)
```

This is useful when a script sometimes needs `extends` semantics — shared values and `this.method(...)` dispatch — but in other cases should behave as the root of its own hierarchy. At the root, a `this.method(...)` call whose method name was not registered during bootstrap is a fatal structural error. Declaration-only shared vars (`shared var x` with no initializer) are valid at the root and resolve to `none`; undeclared identifiers are not shared access and follow ordinary ambient lookup.

#### `component`: Component Instances

Use the `component` keyword to create multiple independent, isolated instances of a script hierarchy. Each instance gets its own set of shared values, its own constructor run, and its own method dispatch table. Unlike direct render, a component does not expose its constructor return to the caller; callers interact through method calls and shared-value observation. The most-derived child's constructor `return` is ignored in component mode rather than treated as an error, so the same script can serve as both a directly rendered script and a component.

Component instances are not ordinary `var` values. You create them only with `component "file" as name`; they live under that binding in the current scope.

`component` is a dedicated keyword, distinct from `import`. The compiler uses it to emit the correct setup code for shared-channel wiring and inherited method dispatch.

```cascada
// widget.script
shared var theme = initialTheme or "light"   // reads from payload; falls back to "light"

method render(label)
  return "[" + theme + "] " + label
endmethod
```

```cascada
// page.script
component "widget.script" as header with { initialTheme: "dark" }
component "widget.script" as footer with context   // 'initialTheme' from render context

var h = header.render("Header")
var f = footer.render("Footer")

return { header: h, footer: f }
```

The two instances are fully independent — separate shared values, separate method tables, separate execution. Calling a method on one has no effect on the other.

**Observing shared state from the caller**

In addition to method calls, you can observe a component's shared channels directly:

```cascada
var snap = header.theme              // snapshot of shared var 'theme'
var name = header.theme.name         // nested read from shared var 'theme'
var snap2 = header.log.snapshot()    // explicit snapshot of shared channel 'log'
var size = header.log.snapshot().length
var ok   = header.log is error       // true if 'log' is poisoned
var msg  = header.log#               // peek the error message
```

Component shared channels are **read-only from the caller** — writes must go through the component's own constructors and methods. The allowed observation forms are: bare shared-var read (implicit snapshot), nested property read from a shared `var`, `.snapshot()`, `is error`, and `#`. Shared channel names that start with `_` are private to the component and are not observable through the component binding. Anything else is a compile error.

A nested read such as `header.theme.name` is treated as `header.theme.snapshot().name` — Cascada observes the shared var first, then applies ordinary property lookup to the result. This implicit snapshot only applies to shared `var` channels. For `shared text`, `shared data`, or other channel types, call `.snapshot()` explicitly, because `snapshot()` waits for ordered channel work to finish:

```cascada
return header.log.snapshot().length
```

**Composition payload: `with`**

The values passed in `with` become a **composition payload** — a context-like key/value object accessible by bare name inside every constructor and method in the component's hierarchy. Payload is separate from shared state.

> **Payload does not override shared defaults.** `with { x: value }` does not write into a `shared var x`. Payload keys and shared channel names are independent namespaces that happen to resolve through the same ambient lookup. To initialize a shared var from a payload value, read the payload key in the shared default expression (as shown above with `initialTheme`) or assign it explicitly in the constructor body.

For multi-level inheritance, the payload flows upward through the chain unchanged.

Supported `with` forms:

```cascada
component "X" as ns with context
component "X" as ns with theme, id
component "X" as ns with context, theme, id
component "X" as ns with { initialTheme: "dark", id: 0 }
component "X" as ns with context, { initialTheme: "dark", id: 0 }
```

`with theme, id` captures the current caller-scope values of `theme` and `id` by their existing names. This shorthand is limited to `var` values.

**Component method calls return values directly.** Calling `ns.method(...)` returns the method's return value without exposing any internal channel state.

Multiple instantiations of the same script are always fully independent:

```cascada
component "button.script" as saveBtn   with { label: "Save" }
component "button.script" as cancelBtn with { label: "Cancel" }
```

#### Methods vs. Functions

Both are callable, but they serve different roles:

| | `function` | `method` |
|---|---|---|
| **Call syntax** | `name(...)` | `this.name(...)` |
| **Inheritance** | No | Yes — child overrides parent |
| **`super()`** | Not available | Available inside method body |
| **Shared channel access** | No — functions are isolated | Yes — declared shared channels |
| **Use case** | Reusable utility logic | Override point for child scripts |

A method body can call functions and read or write shared channels declared in the same file. A function body is isolated: it cannot dispatch inherited methods via `this.method(...)` and does not access shared state.

#### Comparison to Class Inheritance

| OOP concept | Cascada equivalent | Notes |
|---|---|---|
| `class Child extends Base` | `extends "base.script"` | File-level, not type-level. You render the child file. |
| Constructor | Script body (after `extends`) | No local body → inherited constructor dispatch finds the nearest ancestor's constructor directly; a no-op root constructor is synthesized only at the topmost level when `super()` needs a target. |
| Constructor parameters | `compositionPayload` via `extends ... with` or `component ... with` | Flows up the chain; accessible by bare name. |
| Instance state (`this.x`) | `shared` values | Visible across the chain; each file must declare the shared names it uses. |
| Virtual / abstract method | `method` | Called via `this.method(...)`. Every override re-declares the full signature. |
| `super.method(args)` | `super(args)` | Bare `super()` reuses the original invocation's arguments. |
| Single instance per render | `extends` chain (direct render) | One chain instance per render; constructor calls follow `super()` / inherited constructor lookup. |
| Multiple instances | `component "X" as ns` | Each `component` declaration is a fully independent instance. |
| Multiple inheritance | Not supported | One parent per `extends`. |

**The key difference from OOP:** Cascada does have the equivalents of instance state and overridable methods, but instance creation is much more constrained. In OOP, you can usually create instances freely, store them in variables, and pass them around as ordinary object values. In Cascada, `component "X" as name` creates a scoped component instance. That instance has `shared` state and overridable `this.method(...)` dispatch, but it is accessed through its binding in the current scope rather than as a freely constructed general-purpose object value. Direct render mode is even more limited: it runs one inheritance chain and returns a result instead of exposing any instance at all.

### Loaders and File Resolution

When you write:

```cascada
import "utils.script" as utils
extends "base.script"
```

the environment resolves those file names through its configured **loader** or loaders.

Loaders define:

- where scripts are loaded from, such as the filesystem, a web server, a database, or a precompiled bundle
- how relative paths are resolved
- which source wins when multiple loaders are configured

In practice:

- `FileSystemLoader` loads scripts from disk
- `WebLoader` loads scripts over HTTP in browser environments
- `PrecompiledLoader` loads templates or scripts that were precompiled ahead of time

You can pass one loader or several loaders to `AsyncEnvironment`. If multiple loaders are configured, Cascada tries them in order until one finds the requested script.

The detailed loader API is documented in [API Reference](#api-reference).

## API Reference

Cascada builds upon the robust Nunjucks API, extending it with a powerful new execution model for scripts. This reference focuses on the APIs specific to Cascada Script.

For details on features inherited from Nunjucks, such as the full range of built-in filters and advanced loader options, please consult the official [Nunjucks API documentation](https://mozilla.github.io/nunjucks/api.html).

### Key Distinction: Script vs. Template

*   **Script**: A file or string designed for **logic and data orchestration**. Scripts use features like `var`, `for`, `if`, channel declarations (`data`, `text`, `sequence`), and explicit `return` to execute asynchronous operations and produce a structured result. Their primary goal is to *build data*.
*   **Template**: A file or string designed for **presentation and text generation**. Templates use `{{ variable }}` and `{% tag %}` syntax to render a final string output. Their primary goal is to *render text*.

Use ESM imports for new code. The main entry can compile from source:

```javascript
import {
  AsyncEnvironment,
  FileSystemLoader,
  precompileScript,
  precompileTemplateAsync
} from 'cascada-engine';
```

Use the precompiled entry when templates or scripts are compiled ahead of time and the app only needs the runtime. This entry does not import the compiler, parser, lexer, or precompile API:

```javascript
import { AsyncEnvironment, PrecompiledLoader } from 'cascada-engine/precompiled';
```

### AsyncEnvironment Class

The `AsyncEnvironment` is the primary class for orchestrating and executing Cascada Scripts. All its rendering methods return Promises.

#### Execution

*   `asyncEnvironment.renderScript(scriptName, [context])`
    Loads and executes a script from a file using the configured loader.

    ```javascript
    const userData = await env.renderScript('getUser.casc', { userId: 123 });
    ```

*   `asyncEnvironment.renderScriptString(source, [context])`
    Executes a script from a raw string.

    ```javascript
    const script = `
      var user = { name: "Alice" }
      return user
    `;
    const result = await env.renderScriptString(script);
    // { name: "Alice" }
    ```

*   `asyncEnvironment.renderTemplate(templateName, [context])`
*   `asyncEnvironment.renderTemplateString(templateSource, [context])`
    Renders a traditional Nunjucks template to a string.


#### Configuration

*   `new AsyncEnvironment([loaders], [opts])`
    Creates a new environment.
    *   `loaders`: A single loader or an array of loaders to find script/template files.
    *   `opts`: Configuration flags:
        *   `autoescape` (default: `true`): Automatically escapes template output.
        *   `throwOnUndefined` (default: `false`): Throw when rendering an undefined value.
        *   `trimBlocks` (default: `false`): Remove the first newline after a block tag.
        *   `lstripBlocks` (default: `false`): Strip leading whitespace from a block tag.
        *   `tags`: Override template tag delimiters.

    ```javascript
    import { AsyncEnvironment, FileSystemLoader } from 'cascada-engine';

    const env = new AsyncEnvironment(new FileSystemLoader('scripts'), {
      trimBlocks: true
    });
    ```

**Loaders**
Loaders are objects that tell the environment how to find and load your scripts and templates from a source, such as the filesystem, a database, or a network.

*   **Built-in Loaders:**
    *   **`FileSystemLoader`**: (Node.js only) Loads files from the local filesystem.
    *   **`NodeResolveLoader`**: (Node.js only) Resolves templates through Node package resolution.
    *   **`WebLoader`**: (Browser only) Loads files over HTTP.
    *   **`PrecompiledLoader`**: Loads assets from a precompiled JavaScript object.
    You can pass a single loader or an array of loaders to the `AsyncEnvironment` constructor. If an array is provided, Cascada will try each loader in order until one successfully finds the requested file.

    ```javascript
    const env = new AsyncEnvironment([
      new FileSystemLoader('scripts'),
      new PrecompiledLoader(precompiledData)
    ]);
    ```

*   **Custom Loaders:** Create a custom loader by providing a function or class. Return `null` to allow fallback to the next loader.

    **Loader Function:**
    ```javascript
    const networkLoader = async (name) => {
      const response = await fetch(`https://my-cdn.com/scripts/${name}`);
      if (!response.ok) return null;
      const src = await response.text();
      return { src, path: name, noCache: false };
    };
    ```

    **Loader Class:**

    | Method | Description | Required? |
    |---|---|:---:|
    | `load(name)` | Loads an asset by name. Returns string, `LoaderSource`, or `null`. | **Yes** |
    | `isRelative(name)` | Returns `true` if a filename is relative. | No |
    | `resolve(from, to)`| Resolves a relative path. | No |
    | `on(event, handler)` | Listens for environment events. | No |

    ```javascript
    class DatabaseLoader {
      constructor(db) { this.db = db; }

      async load(name) {
        const record = await this.db.scripts.findByName(name);
        if (!record) return null;
        return { src: record.sourceCode, path: name, noCache: false };
      }

      isRelative(filename) {
        return filename.startsWith('./') || filename.startsWith('../');
      }

      resolve(from, to) {
        const fromDir = from.substring(0, from.lastIndexOf('/'));
        return `${fromDir}/${to}`;
      }
    }
    ```

    **Running Loaders Concurrently:**
    The **`raceLoaders(loaders)`** function creates a single loader that runs multiple loaders concurrently and returns the result from the first one that succeeds.

    ```javascript
    import { raceLoaders, FileSystemLoader, WebLoader } from 'cascada-engine';

    const fastLoader = raceLoaders([
      new WebLoader('https://my-cdn.com/scripts/'),
      new FileSystemLoader('scripts/backup/')
    ]);

    const env = new AsyncEnvironment(fastLoader);
    ```

#### Compilation and Caching

*   `asyncEnvironment.getScript(scriptName)`
    Retrieves a compiled `Script` object, loading and caching it if not already cached.

*   `asyncEnvironment.getTemplate(templateName)`
    Retrieves a compiled `AsyncTemplate` object.

    ```javascript
    const compiledScript = await env.getScript('process_data.casc');

    const result1 = await compiledScript.render({ input: 'data1' });
    const result2 = await compiledScript.render({ input: 'data2' });
    ```

#### Adding Global Methods

*   `asyncEnvironment.addGlobal(name, value)`
    Adds a global function or object with methods accessible in all scripts and templates.

    ```javascript
    env.addGlobal('utils', {
      formatDate: (d) => d.toISOString(),
      API_VERSION: 'v3'
    });
    // In script: var formatted = utils.formatDate(now())
    ```

*   `asyncEnvironment.addFilter(name, func, [isAsync])`
    Adds a custom filter for use with the `|` operator.

*   `asyncEnvironment.addFilterAsync(name, func)`
    Adds an async filter.

*   `asyncEnvironment.addDataMethods(methods)`
    Extends the built-in `data` channel with custom methods.

    ```javascript
    env.addDataMethods({
      incrementBy: (target, amount) => (target || 0) + amount,
    });
    // In script: name.path.incrementBy(10)
    ```

### Compiled Objects: `Script`

When you compile an asset, you get a reusable object that can be rendered efficiently multiple times.

#### `Script`

Represents a compiled Cascada Script.

*   `asyncScript.render([context])`
    Executes the compiled script with the given `context`, returning a `Promise` that resolves with the result.

#### `AsyncTemplate`

Represents a compiled Nunjucks Template.

*   `asyncTemplate.render([context])`
    Renders the compiled template, returning a `Promise` that resolves with the final string.

### Precompiling for Production

For maximum performance, precompile your scripts and templates into JavaScript ahead of time:

*   `precompileScript(path, [opts])`
*   `precompileTemplate(path, [opts])`
*   `precompileTemplateAsync(path, [opts])`
*   `precompileScriptString(source, [opts])`
*   `precompileTemplateString(source, [opts])`
*   `precompileTemplateStringAsync(source, [opts])`

The resulting JavaScript can be saved to a `.js` file and loaded using the `PrecompiledLoader`. A key option is `opts.env`, which ensures custom filters, global functions, and data methods are included in the compiled output.

For compiler-free precompiled rendering, import the precompiled entry. It loads only the runtime and precompiled loader, not the compiler:

```javascript
import { AsyncEnvironment, PrecompiledLoader } from 'cascada-engine/precompiled';
```

Use `renderTemplate(...)` for precompiled templates and `renderScript(...)` for precompiled scripts.

The CLI uses the same modes:

```bash
cascada-precompile views --mode template
cascada-precompile views --mode template-async
cascada-precompile script.casc --mode script --format esm
```

**For a comprehensive guide on precompilation options, see the [Nunjucks precompiling documentation](https://mozilla.github.io/nunjucks/api.html#precompiling).**

## Development Status and Roadmap

### Development Status
Cascada is a new project and is evolving quickly! This is exciting, but it also means things are in flux. You might run into bugs, and the documentation might not always align perfectly with the released code. I am working hard to improve everything and welcome your contributions and feedback.

### Differences from classic Nunjucks

- **Block-local scoping:** `if`, `for`/`each`/`while`, and `switch` branches run in their own scope. `var` declarations inside them stay local unless you intentionally write to an outer variable. This avoids race conditions and keeps loops concurrent.

### Roadmap
This roadmap outlines key features and enhancements that are planned or currently in progress.

-   **Streaming support** - see [streaming.md](streaming.md)

-   **Expanded Sequential Execution (`!`) Support**
    Enhancing the `!` marker to work on variables and not just objects from the global context.

-   **Function parameters by reference**
    Allowing functions that accept arguments by reference such as `function myFunction(var state, sequence seq, db!)`, where caller `var` and `sequence` arguments can be modified from inside the function, and sequential-path arguments (db) can be used in `!` execution paths.

-   **Compound Assignment for Variables (`+=`, `-=`, etc.)**
    Extending support for compound assignment operators to regular variables (currently only supported for data channels).

-   **Enhanced Error Reporting**
    Improving the debugging experience with detailed syntax and runtime error messages.

-   **Execution Replay and Debugging**
    A dedicated logging system to capture the entire execution trace.

-   **OpenTelemetry Integration for Observability**
    Native support for tracing using the OpenTelemetry standard.

-   **Robustness and Concurrency Validation**
    Extensive testing and validation for concurrency, poisoning, and recovery behavior.
