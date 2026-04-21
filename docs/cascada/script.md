# Cascada Script Documentation

[Download as Markdown](https://raw.githubusercontent.com/geleto/cascada/master/docs/cascada/script.md)

[Markdown for AI Coding Agents](https://raw.githubusercontent.com/geleto/cascada/refs/heads/master/docs/cascada/script-agent.md)

[Cascada Github](https://github.com/geleto/cascada)

## Cascada Script  -  Implicitly Parallel, Explicitly Sequential

**Cascada Script** is a specialized scripting language designed for orchestrating complex asynchronous workflows in JavaScript and TypeScript applications. It is not a general-purpose programming language; instead, it acts as a **data-orchestration layer** for coordinating APIs, databases, LLMs, and other I/O-bound operations with maximum concurrency and minimal boilerplate.

It uses syntax and language constructs that are instantly familiar to Python and JavaScript developers, while offering language-level support for boilerplate-free parallel workflows, explicit control over side effects, deterministic output construction, and dataflow-based error handling with recovery rollbacks.

Cascada inverts the traditional async model:

* ⚡ **Parallel by default**  -  Independent operations — variable assignments, function calls, loop iterations — execute concurrently without `async`, `await`, or promise management.
* 🚦 **Data-driven execution**  -  Code runs automatically when its input data becomes available, eliminating race conditions by design.
* ➡️ **Explicit sequencing only when needed**  -  Order specific calls, loops, or external interactions with dedicated language constructs — the rest of the script stays parallel.
* 📋 **Deterministic outputs**  -  Even though execution is concurrent and often out-of-order, Cascada guarantees that final outputs are assembled exactly as if the script ran sequentially.
* ☣️ **Errors are data**  -  Failures propagate through the dataflow instead of throwing exceptions, allowing unrelated parallel work to continue safely.

Cascada Script is particularly well suited for:

* AI and LLM orchestration
* Data pipelines and ETL workflows
* Agent systems and planning patterns
* High-throughput I/O coordination

In short, Cascada lets developers **write clear, linear logic** while the engine handles **parallel execution, ordering guarantees, and error propagation** automatically.

**What makes Cascada Script remarkable is how unremarkable it looks.** Despite executing concurrently by default, it uses the same familiar constructs found in Python and JavaScript — no `async`, no `await`, no callbacks, no promise chains. Here's what a real concurrent workflow looks like:

```javascript
var user  = fetchUser(userId)   // ┐ start immediately,
var posts = fetchPosts(userId)  // ┘ run in parallel

// evaluates as soon as 'user' resolves — posts may still be fetching
var role = "admin" if user.isAdmin else "member"

// for loop — every iteration runs concurrently
data result  // channel: writes are concurrent, output is in source order
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

- [The Kitchen Chef's Guide to Concurrent Programming with Cascada](https://geleto.github.io/posts/cascada-kitchen-chef/) - Understand how Cascada works through a restaurant analogy - no technical jargon, just cooks, ingredients, and a brilliant manager who makes parallel execution feel as natural as following a recipe

**Learning by Example:**
- [Casai Examples Repository](https://github.com/geleto/casai-examples) - Explore practical examples showing how Cascada and Casai (an AI orchestration framework built on Cascada) turn complex agentic workflows into readable, linear code - no visual node graphs or async spaghetti, just clear logic that tells a story (work in progress)

## Table of Contents
- [Quick Start](#quick-start)
- [Cascada's Execution Model](#cascadas-execution-model)
- [Language Fundamentals](#language-fundamentals)
- [Control Flow](#control-flow)
- [Channels](#channels)
- [Managing Side Effects: Sequential Execution](#managing-side-effects-sequential-execution)
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

Write plain, familiar logic. Cascada runs independent operations in parallel automatically:

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

No `async`, no `await`. `fetchUser` and `fetchPosts` run in parallel — Cascada handles it.

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

Cascada's approach to concurrency inverts the traditional programming model. Understanding this execution model is essential to writing effective Cascada scripts - it explains why the language behaves the way it does and how to leverage its parallel capabilities.

#### ⚡ Parallel by default
Cascada fundamentally inverts the traditional programming model: instead of being sequential by default, Cascada is **parallel by default**. Independent variable assignments, function calls, loop iterations, and function invocations all run concurrently — no special syntax required.

#### 🚦 Data-Driven Flow: Code runs when its inputs are ready.
In Cascada, any independent operations - like API calls, LLM requests, and database queries - are automatically executed concurrently without requiring special constructs or even the `await` keyword. The engine intelligently analyzes your script's data dependencies, guaranteeing that **operations will wait for their required inputs** before executing. This applies to all constructs: expressions evaluate as soon as their operands resolve, conditionals wait for their condition, loops wait for their iterable, and function calls wait for their arguments. This orchestration **eliminates the possibility of race conditions** by design, ensuring correct execution order while maximizing performance for I/O-bound workflows.

#### ✨ Implicit Concurrency: Write Business Logic, Not Async Plumbing.
Forget await. Forget .then(). Forget manually tracking which variables are promises and which are not. Cascada fundamentally changes how you interact with asynchronous operations by making them invisible.
This "just works" approach means that while any variable can be a promise under the hood, you can pass it into functions, use it in expressions, and assign it without ever thinking about its asynchronous state.

#### ➡️ Implicitly Parallel, Explicitly Sequential
While this "parallel-first" approach is powerful, Cascada recognizes that order is critical for operations with side-effects. For these specific cases you have three tools: the `!` marker, which **enforces strict sequential order on a specific chain of operations** (such as database writes or stateful API calls); the `each` loop, which **iterates a collection one item at a time** when per-item side-effects must not overlap; and a `sequence` channel, which provides **strictly ordered reads and calls on an external object** while still returning each call's value. All three are surgical — they sequence only what they touch, without affecting the parallelism of the rest of the script.

#### 📋 Execution is chaotic, but the result is orderly
While independent operations run in parallel and may start and complete in any order, Cascada guarantees the final output is identical to what you'd get from sequential execution. This means all your data manipulations are applied predictably, ensuring your final texts, arrays and objects are assembled in the exact order written in your script.

#### ☣️ Dataflow Poisoning - Errors that flow like data
Cascada replaces traditional try/catch exceptions with a data-centric error model called **dataflow poisoning**. If an operation fails, it produces an `Error Value` that propagates to any dependent operation, variable and output - ensuring corrupted data never silently produces incorrect results. For example, if fetchPosts() fails, any variable or output using its result also becomes an error - but critically, unrelated operations continue running unaffected. Poisoning is conservative with control flow: if an `if` condition is an Error Value, neither branch runs and every variable that either branch would have modified becomes poisoned. You can detect and repair these errors using `is error` checks, providing fallbacks and logging without derailing your entire workflow.

#### 💡 Clean, Expressive Syntax
Cascada Script offers a modern, expressive syntax designed to be instantly familiar to JavaScript and TypeScript developers. It provides a complete toolset for writing sophisticated logic, including variable declarations (`var`), `if/else` conditionals, `for/while` loops, and a full suite of standard operators. Build reusable components with `function ... endfunction`, which supports default values and keyword arguments, and compose complex applications by organizing your code into modular files with `import` and `extends`.


## Language Fundamentals

### Features at a Glance

What makes Cascada Script remarkable is how unremarkable it looks. Despite executing concurrently by default, the language offers the same familiar constructs found in Python, JavaScript, and similar languages - no async keyword, no callbacks, no promise chains. You write straightforward sequential-looking logic; the engine handles the parallelism.

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
| Parallel loop | `for item in array`, `for key, value in object`, `for element in iterator` | Iterations run concurrently |
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
| Implicit parallelism | *(no syntax)* | Independent operations run concurrently automatically |
| `text` channel | `text log`, `log("line")` | Generate text from parallel code, assembled in source order |
| `data` channel | `data out`, `out.items.push(item)` | Build structured objects and arrays from parallel code - writes are concurrent, result is in source order |
| `sequence` channel | `sequence db = services.db`, `var user = db.getUser(1)` | Sequential reads and calls on an external object |
| Sequential operator | `obj!.method()`, `obj!.prop` | Enforce strict execution order on a context object path |
| Guard | `guard [targets] / recover [err] / endguard` | Transaction-like block: auto-restores channel/sequence state on error |
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

This ensures parallel operations never interfere—each variable owns its data independently.

**Performance Note**

Cascada uses optimized techniques so that assignments do not copy entire values. Values may be shared internally until modified, at which point only the affected parts are copied as needed. This keeps memory usage and performance overhead low while preserving the simple independent value semantics shown in the examples.

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

The problem is not "methods are always forbidden". The problem is **concurrent mutation of the same value**. If only one execution path is mutating a local value, ordinary JavaScript methods like `items.push(x)` are fine. But when parallel branches can touch the same `var`, these methods become race-prone.

Calling a mutation method on a plain `var` inside a parallel `for` loop is unsafe - iterations run concurrently, so whichever branch finishes last wins and source-code order is not preserved:

```javascript
// ❌ UNSAFE - parallel iterations race on the same var
var items = []
for id in ids
  items.push(fetchItem(id))  // order not guaranteed
endfor
```

If you truly do not care about preserving source order, a plain mutable `var` may still be acceptable in non-concurrent code paths. But when multiple parallel branches build a collection, the safest and most idiomatic fix is the `data` channel described in the next section.

Three tools handle this correctly:

**`data` channel (preferred for building collections)** - this is the main mitigation. Writes run concurrently, but the assembled result always matches source-code order:
```javascript
data result
for id in ids
  var item = fetchItem(id)
  result.items.push(item)
endfor
return result.snapshot()
```

Use the `data` channel when you are assembling arrays or objects from parallel code, whether order matters strictly or you just want to avoid shared-mutation races entirely.

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
  collection!.push(fetchItem(id))  // sequential; rest of the loop still runs in parallel
endfor
```

**Scoping: No Reuse of Visible Names**

You cannot declare a variable in an inner scope (e.g., inside a `for` loop or `if` block) if a variable with the same name is already declared in an outer scope. This prevents accidental overwrites in parallel execution.

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

This section covers control flow constructs. Remember that Cascada's parallel-by-default execution means loops and conditionals behave differently than in traditional languages.
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
Use a `for` loop to iterate over arrays, dictionaries (objects), async iterators, and other iterable data structures. By default, the body of the `for` loop executes **in parallel for each item**, maximizing I/O throughput for independent operations.

```javascript
// Each iteration runs concurrently, fetching user details in parallel
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
Use a `while` loop to execute a block of code repeatedly as long as a condition is true. Unlike the parallel `for` loop, the `while` loop's body executes **sequentially**. The condition is re-evaluated only after the body has fully completed its execution for the current iteration.

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
    ✅ **Always Available.** Because the size of an array or object is known upfront, these properties are available regardless of whether the loop runs in parallel, sequentially, or with a concurrency limit.

2.  **Parallel Async Iterators:**
    ✅ **Available (Async).** For fully parallel async iterators, `loop.length` and `loop.last` are resolved asynchronously after Cascada has consumed the entire iterator. In practice, these behave like promise-backed loop metadata: loop bodies can start immediately as items arrive, and expressions that depend on `loop.length` or `loop.last` simply wait until the stream has been fully consumed.

3.  **Sequential or Constrained Async Iterators:**
    ❌ **Not Available.** When an async iterator is restricted - by `each` or by a concurrency limit (`of N`) - Cascada treats it as a stream and does **not** provide `loop.length` or `loop.last`. In these modes, the loop only learns about the next item by continuing iteration. If an iteration were allowed to wait on `loop.length` or `loop.last`, it could block the very iteration progress needed to discover the end of the stream, causing a deadlock.

    In other words:
    - In an `each` loop, the current iteration must finish before Cascada can request the next item. Waiting for `loop.length` or `loop.last` would therefore wait for the end of the stream while preventing the stream from advancing.
    - In a bounded `for ... of N` loop, worker slots move on independently, and earlier iterations may still be unfinished while later items are being fetched. If all active workers waited for `loop.length` or `loop.last`, no worker would be free to keep draining the iterator, so the end would never be discovered.

    Because of that, these properties are intentionally treated as unavailable rather than as deferred values in sequential or bounded async-iterator loops.

4.  **`while` Loops:**
    ❌ **Not Available.** Since a `while` loop runs until a condition changes, the total number of iterations is never known before all iterations complete.


### Error handling and recovery with conditionals and loops

When an Error Value affects a conditional or loop, Cascada ensures that corrupted data never silently produces incorrect results by propagating the error to any variables or outputs that would have been modified.

#### Error handling with `if` and `switch` statements

If the condition of an `if` statement (or the expression of a `switch` statement) evaluates to an Error Value, all branches are skipped, and the error is propagated to any variables or outputs that would have been modified within any branch.

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

This behavior is important to understand: it's not just that the code doesn't execute - any variables or outputs that would have been assigned in any of the branches become poisoned. This ensures you can detect downstream that something went wrong, rather than having undefined or stale values.

**Note:** `switch` statements behave identically - if the switch expression is an Error Value, all `case` and `default` branches are skipped and their outputs become poisoned.

#### Error handling with loops

If a loop's iterable evaluates to an Error Value, the loop body is skipped and the error propagates to any variables or outputs that would have been modified by the loop.

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

Use `name.snapshot()` to read a channel's current value. `snapshot()` is an observable operation - it waits for any pending writes to finish before returning. Because of that, it is more expensive than reading a plain `var`, so prefer `var` for simple cases and reach for channels when you need ordered assembly or external interaction.

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

The `text` channel builds a string of text. It is the simplest channel to reach for when parallel code needs to contribute to one final piece of text while preserving source-code order.

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
The `data` channel is the main tool for constructing structured output. It is especially useful when parallel code needs to build arrays or objects in a predictable order - all writes execute concurrently, but the assembled result always matches source-code order. This is the right alternative to [mutation methods on plain `var` values](#mutation-methods-and-side-effects), which race in parallel code.

The key difference from a plain `var` is that `data` operations such as `.push()`, `.merge()`, and `.append()` are **channel commands**, not ordinary JavaScript in-place mutations. They are scheduled and assembled safely by Cascada, so they remain safe even when multiple parallel branches write to the same `data` channel. On a plain `var`, those same method names are just standard JavaScript side effects on the current value, so parallel calls do not get ordered assembly guarantees.

Use a plain `var` when you are building a value locally in one place, or when you genuinely do not need channel ordering/assembly behavior. Use a `data` channel when multiple parallel branches contribute to the same result, or when you want ordered path-based construction without shared-mutation races.

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

// The 'roles' array is created automatically on first push
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
*   **Root-Level Modification**: Use the channel directly to replace the root.
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

You can protect channels from poisoning and recover from errors using `guard` blocks:

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

For functions with **side effects** (e.g., database writes), the `!` marker enforces a **sequential execution order** for a specific object path. Once a path is marked, *all* subsequent method calls on that path (even those without a `!`) will wait for the preceding operation to complete, while other independent operations continue to run in parallel.

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

// Unmarked methods run in parallel
logger.getStatus()
```

This is useful for rate-limiting or ordering specific actions (like "append") while keeping the rest of the object non-blocking. Note that unlike object-path sequencing (`obj!.method()`), unmarked calls to the same method (`logger.log()`) will **not** wait for the sequence.


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

These functions use `return` to return values, or implicitly return `none` if no `return` is present. Channels declared inside a function are local to that function.

### Defining and Calling a Function

A function can call async functions and use `return` to provide its result. Like a script, it runs to completion before its return value is available to the caller.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
function buildDepartment(deptId)
  // These two async calls run in parallel.
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

Cascada's parallel-by-default execution creates a unique challenge: when multiple operations run concurrently and one fails, traditional exception-based error handling would need to interrupt the entire execution graph, halting all independent work. Instead, Cascada treats **errors as just another type of data** that flows through your script. Failed operations produce a special **Error Value** that is stored in variables, passed to functions, and can be inspected.

This data-centric model allows independent operations to continue running while failures are isolated to only the variables and operations that depend on the failed result.

### Error Handling Fundamentals

#### Error Handling in Action
Here's a concrete example showing how error propagation works in parallel execution:

```javascript
// These three API calls run in parallel
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

#### Output & Effects

* **Channels:**
  If an Error Value is written to a channel, that channel becomes **poisoned**, causing the script to fail when the channel is read or returned.

* **Sequential Side-Effect Paths:**
  If a call in a sequential execution path (marked with `!`) fails, that path becomes **poisoned**. Later operations using the same `!path` will instantly yield an Error Value without executing.

  ```javascript
  context.database!.connect()      // ❌ fails
  context.database!.insert(record) // ❌ skipped, returns error immediately
  context.database!.commit()       // ❌ skipped, returns error immediately
  ```

This mechanism ensures that once an operation fails, all dependent results and outputs reflect that failure, maintaining data integrity across both parallel and sequential execution flows.
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

This aggregation is particularly valuable in error reporting and debugging, as you can see all failures that occurred in a parallel batch rather than just the first one encountered.

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
When variables are protected (via `guard *` or explicit variable names), any code that depends on such variables must wait for the guard to finish. This can reduce parallelism. Use `guard *` only for small, tightly scoped operations.

---

#### The `recover` Block

The `recover` block is optional. If omitted, the guard silently restores protected state and execution continues after `endguard`.

If present, it runs only if the guard finishes poisoned:

* Guarded channels have already been reverted
* Guarded sequential paths have already been repaired
* Guarded variables have already been restored
* `recover err` binds the final `PoisonError` for inspection via the `#` peek operator — the variable name is optional; bare `recover` (without a binding) is also valid

> Note: If all errors are detected and repaired inside the guard (using `is error`), the guard is considered successful and no recovery occurs.

#### Manually Reverting Channel State

> ⚠️ **Work in progress:** The `revert` statement for manually resetting channel state inside a `guard` block is not yet available in script mode.

When implemented, `revert` will reset all channels in the current output scope to their state at the start of the nearest enclosing scope boundary (e.g., the start of the `guard` block). This provides fine-grained control complementing automatic guard recovery.

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

Use `return` to explicitly shape what a script or function produces. Without a `return`, scripts and functions return `none`.

```javascript
// Return a simple value
return 42

// Return a variable
return user

// Return an object literal
return { name: user.name, count: items.length }

// Build with plain variables and return them directly
var report = { name: user.name, count: items.length }
return report

// Use snapshot() only when you are intentionally building through a channel
data reportData
reportData.user.name = "Alice"
return reportData.snapshot()
```

`snapshot()` captures the assembled state of a channel at that point, waiting for all pending writes to complete. It can be called anywhere after the channel is declared.

For most cases, returning a `var` or a plain object literal is simpler than declaring a channel. Use channels when you need ordered writes, structured path updates, text building, or `sequence` behavior.


## Composition and Loading

When a project grows beyond a single file, Cascada Script provides two ways to organize logic:

- **`import`** — load a library of reusable functions from another file
- **`extends` / `method`** — inherit a base script's structure and override specific behaviors

Both use the same **explicit-contract model**: any value that crosses a composition boundary must be declared with `extern` and explicitly passed with `with`. There is no implicit sharing of parent-scope variables.

### Importing Libraries with `import`

Use `import` to share functions across multiple scripts — helper functions, formatters, validators — without duplicating them. The imported script's top-level body does not run in the caller; only its function definitions are exposed.

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

A library can declare **`extern`** values — inputs it expects the caller to provide. The caller passes them with `with`. Here the same library is enriched with a configurable `locale`:

```cascada
// formatters.script
extern locale = "en"    // optional — defaults to "en"

function formatUser(user)
  return user.firstName + " " + user.lastName + " [" + locale + "]"
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

Instead of passing an explicit var, you can expose the render context so the library resolves its externs from it:

```cascada
// main.script — locale comes from the render context, no child var needed
import "formatters.script" as fmt with context

var user = fetchUser(1)
return { user: fmt.formatUser(user) }
```

This returns `{ user: "Alice Durand [en-GB]" }` when `locale` comes from the render context.

`from ... import` follows the same `with` rules. Named inputs always take priority over context lookup. The full `extern` / `with` rules are in the next section.

### `extern` and `with`: Cross-File Contracts

The examples above showed the pattern: a library declares `extern` for each value it needs; the caller satisfies those externs with `with`. This section covers the complete rules.

```cascada
// required — caller must provide it
extern user

// optional — defaults to "light" if caller doesn't provide it
extern theme = "light"
```

`extern` is only valid at root scope (not inside `if`, `for`, functions, etc.).

**`extern` rules:**
- **Vars only**: `extern` works only with `var`-type values. Channels (`data`, `text`, `sequence`) cannot be declared as externs or passed via `with`.
- **Value-copy semantics**: the caller's value is copied at the composition boundary. Mutating it inside the child does not affect the caller.
- **Transparent async**: an `extern` can hold a promise just like a normal `var`.
- **Declaration order**: externs initialize in declaration order. A fallback expression cannot reference an `extern` declared later:
  ```cascada
  extern a = b   // ERROR: b is declared later
  extern b = "default"
  ```
- **Post-init behavior**: after initialization, an `extern` behaves exactly like a normal local `var`.
- **Required vs. optional**: an `extern` without a fallback is required. If the caller does not provide it, rendering fails with a contract error.
- **Reserved name**: `context` is reserved. `extern context` and `var context = ...` are compile errors.

**`with varName, ...`** — passes the named parent `var`s by value. Only `var` declarations can be listed; channels cannot cross a composition boundary.

**`with context`** — makes the render context (the object passed to the renderer) available to bare-name lookups inside the child. It does **not** expose parent local variables or channels, and it does **not** create a variable named `context` inside the child.

**`without context`** — explicitly opts out of render-context access. Useful to make isolation guarantees visible in code.

**Resolution order**: explicit `with` value → `with context` lookup → own `extern` fallback → error.

```cascada
// Given: extern locale = "en" in the library
import "formatters.script" as fmt with context, locale
// locale  — satisfied by the explicit var (wins over context and over "en")
// any other extern — looked up in context, then falls back to its own default
```

### Script Inheritance with `extends` and `method`

Use `extends` when you want to build a family of related scripts that share structure but differ in specific behaviors. The base script defines **methods** — named override points that take arguments and return a value. Child scripts inherit the full flow of the base and replace individual methods with their own implementations.

A common pattern: a base report script fetches data, orchestrates the flow, and calls `buildBody` to format the content. Different child scripts supply their own `buildBody` — one for summaries, one for detailed output — without duplicating the fetch-and-orchestrate logic.

> If you know class-based OOP, `extends` / `method` / `super` map onto familiar concepts with some key differences — see [Comparison to Class Inheritance](#comparison-to-class-inheritance) below.

```cascada
// base.script
// title and user come from the render context
method buildBody(title, user)
  return user.name + ": " + title
endmethod

var body = buildBody(title, user)
return body
```

```cascada
// child.script
extends "base.script"

method buildBody(title, user)
  return "[Custom] " + user.name + ": " + title
endmethod
```

You render the child script, not the base script. The base script's top-level flow runs with the child's `buildBody` in place:

```javascript
await env.renderScript("child.script", {
  title: "Q1 Report",
  user: { name: "Ada" }
})
```

This renders to `"[Custom] Ada: Q1 Report"`.

**Method rules:**
- Every overriding method declares its own argument list. Parent and child signatures must match.
- Method arguments are ordinary local bindings. You can reassign them locally without affecting the caller.
- Methods return values via `return`. Method bodies do not issue channel commands — use the surrounding script flow for output assembly and methods to compute the values that feed into it.
- Top-level `var` declarations in the child script are visible in the child's own top-level flow, but method arguments and locals belong to the method body.

#### `extends ... with ...`

Use `extends ... with ...` to configure the base script before it runs. If the base declares root-level `extern` values, the child supplies them via `with`. This is the place for data that applies to the whole run — not per-method-call, but once for the entire execution.

Here is the same base from above, now with two configurable values:

```cascada
// base.script
extern theme = "light"
extern locale = "en"

method buildBody(title, user)
  return "[" + locale + "/" + theme + "] " + user.name + ": " + title
endmethod

var body = buildBody(title, user)
return body
```

```cascada
// child.script — configures the base without overriding the method
var theme = "dark"
var locale = "de"

extends "base.script" with theme, locale
```

```javascript
await env.renderScript("child.script", {
  title: "Q1 Report",
  user: { name: "Ada" }
})
```

This renders to `"[de/dark] Ada: Q1 Report"`.

`extends` can appear after `var` declarations in the child — the natural position when those vars are being computed before being handed to the base.

**Pass-through pattern.** A child can declare its own `extern` and forward it directly to the base, letting callers configure a value that flows all the way down the chain. Rendering the wrapper still runs the base script's top-level flow and returns the base script's output.

```cascada
// wrapper.script — receives theme from its own caller and forwards it to the base
extern theme
extends "base.script" with theme
```

**Combining `with context` and named vars.** You can expose render-context lookup for satisfying the base's root `extern` values, while still overriding specific externs explicitly. Named vars always win over context lookup:

```cascada
// child.script — hardcodes theme, exposes locale from render context
var theme = "dark"

extends "base.script" with context, theme
```

In the base script, `theme` resolves to `"dark"` (explicit), while `locale` is looked up in the render context.

**Rules for `extends ... with ...`:**
- It passes values into the base script's root-level `extern` declarations.
- Values are copied at the composition boundary, just like `import ... with ...`. Reassigning the child variable later does not affect the already-configured base value.
- `extends` can appear after `var` declarations in the child. Values are copied when `extends` runs, not when the vars are first declared.
- This configures base-script state; it does not replace method arguments. Use method arguments for per-call override inputs.
- `with context` and `without context` follow the same rules as they do for `import`.

#### `method ... with context`

`extends ... with ...` configures the base once before it runs. `method ... with context` is different: it gives an individual method body access to the render context on each call.

A base method can declare `with context` to read render-context values by bare name inside the body:

```cascada
// base.script
method buildBody(title, user) with context
  return "[" + siteName + "] " + user.name + ": " + title
endmethod

var body = buildBody(title, user)
return body
```

The `with context` contract is inherited automatically by child overrides — the child does not need to re-declare it:

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
```

This renders to `"[Child/Acme] Ada: Q1 Report"`.

**Named arguments take precedence over render-context names.** If an argument and a render-context property share the same name, the explicit argument wins.

There is no special `without context` form for methods. The default is already "without context" unless the base method declares `with context`.

If a base method declares `with context`, child overrides inherit that render-context visibility automatically, and `super()` / `super(...)` call the parent method with the same inherited render-context access.

#### `super()` and `super(...)`

Use `super()` when the child wants to augment the parent's result rather than replace it entirely — adding a prefix, wrapping the output, or delegating to the parent for certain inputs.

Bare `super()` calls the parent with the original invocation arguments:

```cascada
// child.script — wraps the parent result
extends "base.script"

method buildBody(title, user)
  return "URGENT — " + super()
endmethod
```

With `title: "Q1 Report"` and `user: { name: "Ada" }`, this renders to `"URGENT — Ada: Q1 Report"`.

`super(...)` lets the child change what the parent sees:

```cascada
// child.script — passes different args to the parent
extends "base.script"

method buildBody(title, user)
  return super(title, { name: "Anonymous" })
endmethod
```

With `title: "Q1 Report"` and `user: { name: "Ada" }`, this renders to `"Anonymous: Q1 Report"`.

#### Methods vs. functions

Both are callable, but they serve different roles:

- **Function (`function`)**: a reusable helper for shared utilities. Does not participate in inheritance or `super()`.
- **`method`**: an explicit override point in an `extends` chain. Use when a base script needs child scripts to customize part of its behavior.
- Methods return values via `return` and do not issue channel commands directly. Output assembly belongs to the script's top-level flow; methods compute the values that feed into it.

#### Comparison to Class Inheritance

If you know object-oriented languages, `extends` / `method` / `super` will feel familiar. Here is how the concepts map, and where they diverge:

| OOP concept | Cascada equivalent | Notes |
|---|---|---|
| `class Child extends Base` | `extends "base.script"` | File-level, not type-level. You render the child file. |
| Constructor parameters | `extern` in base + `extends ... with ...` | Configured once per render, not per instantiation. |
| Virtual / abstract method | `method` | Every override must re-declare the full signature. |
| `super.method(args)` | `super(args)` | Bare `super()` reuses the original invocation's arguments. |
| Instance state (`this.x`) | Not available | No shared mutable state between calls. Use `extern` for configuration that is copied once per render. |
| Multiple inheritance | Not supported | A child script can extend only one base. |

**The key difference: no instances.** `extern theme = "light"` in a base script is like a constructor parameter with a default. `extends "base.script" with theme` is like passing `{ theme }` to the parent constructor — but there are no objects. Rendering `child.script` runs the base script's top-level flow exactly once, with the child's method overrides active. There is no `this`, no per-object state, and `extends` is a file-level relationship between scripts, not a type-level one.

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
- `PrecompiledLoader` loads scripts that were precompiled ahead of time

You can pass one loader or several loaders to `AsyncEnvironment`. If multiple loaders are configured, Cascada tries them in order until one finds the requested script.

The detailed loader API is documented in [API Reference](#api-reference).

## API Reference

Cascada builds upon the robust Nunjucks API, extending it with a powerful new execution model for scripts. This reference focuses on the APIs specific to Cascada Script.

For details on features inherited from Nunjucks, such as the full range of built-in filters and advanced loader options, please consult the official [Nunjucks API documentation](https://mozilla.github.io/nunjucks/api.html).

### Key Distinction: Script vs. Template

*   **Script**: A file or string designed for **logic and data orchestration**. Scripts use features like `var`, `for`, `if`, channel declarations (`data`, `text`, `sequence`), and explicit `return` to execute asynchronous operations and produce a structured result. Their primary goal is to *build data*.
*   **Template**: A file or string designed for **presentation and text generation**. Templates use `{{ variable }}` and `{% tag %}` syntax to render a final string output. Their primary goal is to *render text*.

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
        *   `trimBlocks` (default: `false`): Remove the first newline after a block tag.
        *   `lstripBlocks` (default: `false`): Strip leading whitespace from a block tag.

    ```javascript
    const { AsyncEnvironment, FileSystemLoader } = require('cascada-engine');

    const env = new AsyncEnvironment(new FileSystemLoader('scripts'), {
      trimBlocks: true
    });
    ```

**Loaders**
Loaders are objects that tell the environment how to find and load your scripts and templates from a source, such as the filesystem, a database, or a network.

*   **Built-in Loaders:**
    *   **`FileSystemLoader`**: (Node.js only) Loads files from the local filesystem.
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
    const { raceLoaders, FileSystemLoader, WebLoader } = require('cascada-engine');

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

The resulting JavaScript can be saved to a `.js` file and loaded using the `PrecompiledLoader`. A key option is `opts.env`, which ensures custom filters, global functions, and data methods are included in the compiled output.

**For a comprehensive guide on precompilation options, see the [Nunjucks precompiling documentation](https://mozilla.github.io/nunjucks/api.html#precompiling).**

## Development Status and Roadmap

### Development Status
Cascada is a new project and is evolving quickly! This is exciting, but it also means things are in flux. You might run into bugs, and the documentation might not always align perfectly with the released code. I am working hard to improve everything and welcome your contributions and feedback.

### Differences from classic Nunjucks

- **Block-local scoping:** `if`, `for`/`each`/`while`, and `switch` branches run in their own scope. `var` declarations inside them stay local unless you intentionally write to an outer variable. This avoids race conditions and keeps loops parallel.

### Roadmap
This roadmap outlines key features and enhancements that are planned or currently in progress.

-   **Streaming support** - see [streaming.md](streaming.md)

-   **Expanded Sequential Execution (`!`) Support**
    Enhancing the `!` marker to work on variables and not just objects from the global context.

-   **Function parameters by reference**
    Allowing functions to accept references such as `function myFunction(var state, sequence seq, db!)`, where caller `var` and `sequence` arguments can be modified from inside the function, and sequential-path arguments can be used in `!` execution paths.

-   **Compound Assignment for Variables (`+=`, `-=`, etc.)**
    Extending support for compound assignment operators to regular variables.

-   **Enhanced Error Reporting**
    Improving the debugging experience with detailed syntax and runtime error messages.

-   **Execution Replay and Debugging**
    A dedicated logging system to capture the entire execution trace.

-   **OpenTelemetry Integration for Observability**
    Native support for tracing using the OpenTelemetry standard.

-   **Robustness and Concurrency Validation**
    Extensive testing and validation for concurrency, poisoning, and recovery behavior.

