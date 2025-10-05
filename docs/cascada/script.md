# Cascada Script Documentation

## Write synchronous-style scripts that execute concurrently under the hood.
The core philosophy of Cascada is to let you write asynchronous code with the clarity of synchronous logic. You write your script as a straightforward, top-to-bottom set of instructions, and Cascada's engine handles the complex concurrent execution for you.
Use it as the backbone for your data layer to compose complex workflows, wiring together LLMs, APIs, databases, and external services in parallel with maximum I/O throughput, all while keeping the logic clean and readable.

## Overview

### ⚡ Parallel by default
Cascada Script is a scripting language for **JavaScript** and **TypeScript** applications, purpose-built for **effortless concurrency and asynchronous workflow orchestration**. It fundamentally inverts the traditional programming model: instead of being sequential by default, Cascada is **parallel by default**.

### 🚦 Data-Driven Flow: Code runs when its inputs are ready.
In Cascada, any independent operations - like API calls, LLM requests, and database queries - are automatically executed concurrently without requiring special constructs or even the `await` keyword. The engine intelligently analyzes your script's data dependencies, guaranteeing that **operations will wait for their required inputs** before executing. This orchestration **eliminates the possibility of race conditions** by design, ensuring correct execution order while maximizing performance for I/O-bound workflows.

### ✨ Implicit Concurrency: Write Business Logic, Not Async Plumbing.
Forget await. Forget .then(). Forget manually tracking which variables are promises and which are not. Cascada fundamentally changes how you interact with asynchronous operations by making them invisible.
This "just works" approach means that while any variable can be a promise under the hood, you can pass it into functions, use it in expressions, and assign it without ever thinking about its asynchronous state.

### ➡️ Parallel by default, sequential by exception
While this "parallel-first" approach is powerful, Cascada recognizes that order is critical for operations with side-effects. For these specific cases, such as writing to a database, interacting with a stateful API or making LLM request, you can use the simple `!` marker to **enforce a strict sequential order on a specific chain of operations, without affecting the parallelism of the rest of the script.**.

### 📋 Execution is chaotic, but the result is orderly
While independent operations run in parallel and may start and complete in any order, Cascada guarantees the final output is identical to what you'd get from sequential execution. This means all your data manipulations are applied predictably, ensuring your final texts, arrays and objects are assembled in the exact order written in your script.

This inversion - parallel by default, sequential by exception - makes building complex, high-performance data pipelines feel surprisingly simple and intuitive.

### 💡 Clean, Expressive Syntax
Cascada Script offers a modern, expressive syntax designed to be instantly familiar to JavaScript and TypeScript developers. It provides a complete toolset for writing sophisticated logic, including variable declarations (`var`), `if/else` conditionals, `for/while` loops, and a full suite of standard operators. Build reusable components with `macros` that support keyword arguments, and compose complex applications by organizing your code into modular files with `import` and `extends`.

**⚠️ Under Development! ⚠️**
Cascada is a new project and is evolving quickly! This is exciting, but it also means things are in flux. You might run into bugs, and the documentation might not always align perfectly with the released code. It could be behind, have gaps, or even describe features that are planned but not yet implemented (these are marked as under development). I am working hard to improve everything and welcome your contributions and feedback.

## Table of Contents
- [Overview](#overview)
- [Getting Started](#getting-started)
- [Core Syntax and Expressions](#core-syntax-and-expressions)
- [Macros and Reusable Components](#macros-and-reusable-components)
- [Advanced Flow Control](#advanced-flow-control)
- [Modular Scripts](#modular-scripts)
- [API Reference](#api-reference)
- [Development Status and Roadmap](#development-status-and-roadmap)

## Getting Started

 Install Cascada (package name will change):
  ```bash
  npm install cascada-engine
  ```

Here's a simple of executing a script.

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

## Core Syntax and Expressions

Cascada Script removes the visual noise of the [template syntax](template.md) while preserving Cascada's powerful capabilities.

- **No Tag Delimiters**: Write `if condition` instead of `{% if condition %}`
- **Multiline Expressions**: Expressions can span multiple lines for readability. The system automatically detects continuation based on syntax (e.g., unclosed operators, brackets, or parentheses). For example:
  ```
  var result = 5 + 10 *
    20 - 3
  ```
- **Standard Comments**: Use JavaScript-style comments (`//` and `/* */`)
- **Code**: Any standalone line that isn't a recognized command (e.g., `var`, `if`, `for`, `import`) or tag is treated as an expression. For example:
  ```
  items.push("value")
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

#### Declaring External Variables with `extern`
Use `extern` to declare a variable that is expected to be provided by an including script (via `include` or `extends`), not from the global context. External variables cannot be initialized at declaration but can be changed later.

```javascript
// In 'component.script'
extern currentUser, theme

if not currentUser.isAuthenticated
  // Re-assigning an extern variable is allowed
  theme = "guest"
endif
```

#### Assigning to Existing Variables with `=`
Use the `=` operator to assign or re-assign a value to any **previously declared** variable (`var` or `extern`). Using `=` on an undeclared variable will cause a compile-time error.

```javascript
var name = "Alice"
name = "Bob" // OK: Re-assigning a declared variable

// Re-assign multiple existing variables at once
x, y = 200 // OK, if x and y were previously declared

// ERROR: 'username' was never declared with 'var' or 'extern'
username = "Charlie"
```

#### Block Assignment with `capture`
The `capture...endcapture` block is a special construct used **exclusively on the right side of an assignment (`=`)** to orchestrate logic and assemble a value. It's perfect for transforming data or running a set of parallel operations to create a single variable.

The block runs its own logic and uses [Output Commands](#the-handler-system-using--output-commands) to build a result, which is then assigned to the variable. You can use an [output focus directive](#focusing-the-output-data-text-handlername) like `:data` to assign a clean data object.

```javascript
// First, fetch some raw data from an async source.
// This might return an object with inconsistent field names or values.
var rawUserData = fetchUser(123) // e.g., returns { id: 123, name: "alice", isActive: 1 }

// Use a 'capture' block for declaration and assignment.
// It transforms the raw data into a clean 'user' object.
var user = capture :data
  // Logic inside the block can access variables from the outer scope.
  @data.id = rawUserData.id
  @data.username = rawUserData.name | title // Use a filter for formatting
  @data.status = "active" if rawUserData.isActive == 1 else "inactive"
endcapture

// Now, the 'user' variable holds a clean, structured object:
// {
//   "id": 123,
//   "username": "Alice",
//   "status": "active"
// }
```

#### Variable Scoping and Shadowing
Cascada Script does not allow variable shadowing. You cannot declare a variable in a child scope (e.g., inside a `for` loop or `if` block) if a variable with the same name already exists in a parent scope. This helps prevent common bugs and improves code clarity.

```javascript
var item = "parent"
for i in range(2)
  // This would cause a compile-time ERROR, because 'item'
  // is already declared in the parent scope.
  var item = "child " + i
endfor
```

#### Handling `null` and `undefined` Values
Unlike Nunjucks/Cascada templates, which silently return `undefined` when accessing properties of `null` or `undefined` values, Cascada Script throws runtime errors. This stricter approach catches potential bugs early and ensures more predictable script execution.

In Cascada Script, the keyword `none` is used to represent null/undefined values. When you declare a variable without an initial value, it defaults to `none`:

### Basic Statements

#### Conditional Logic
```
if condition
  // statements
elif anotherCondition
  // statements
else
  // statements
endif
```

#### Loops
Cascada provides `for`, `while`, and `each` loops for iterating over collections and performing repeated actions, with powerful built-in support for asynchronous operations.

##### `for` Loops
Use a `for` loop to iterate over arrays, dictionaries (objects), and other iterable data structures. In Cascada, the body of the `for` loop executes **in parallel for each item** in the collection. This is the default and most powerful looping construct for maximizing I/O throughput when performing independent asynchronous operations.

```javascript
// Each iteration runs concurrently, fetching user details in parallel
for userId in userIds
  var user = fetchUserDetails(userId)
  @data.users.push(user)
endfor
```

You can iterate over various collection types:

*   **Arrays**:
    ```javascript
    var items = [{ title: "foo", id: 1 }, { title: "bar", id: 2 }];
    for item in items
      @data.posts.push({ id: item.id, title: item.title })
    endfor
    ```
*   **Objects/Dictionaries**:
    ```javascript
    var food = { ketchup: '5 tbsp', mustard: '1 tbsp' }
    for ingredient, amount in food
      @text("Use " + amount + " of " + ingredient)
    endfor
    ```
*   **Unpacking Arrays**:
    ```javascript
    var points = [[0, 1, 2], [5, 6, 7]]
    for x, y, z in points
      @text("Point: " + x + ", " + y + ", " + z)
    endfor
    ```

A `for` loop can have an `else` block that is executed only if the collection is empty:
```javascript
for item in []
  @text("This will not be printed.")
else
  @text("The collection was empty.")
endfor
```

###### Looping over Async Iterators
`for` loops can iterate seamlessly over **async iterators**. Cascada automatically handles waiting for each item to be yielded from the iterator before starting its parallel processing.

First, you would provide the async iterator function in your context object:
```javascript
// Add an async generator to the context
const context = {
  fetchComments: async function* (postId) {
    let page = 0;
    while(true) {
      const comments = await fetchPageOfComments(postId, page++);
      if (comments.length === 0) break;
      for (const comment of comments) {
        yield comment;
      }
    }
  }
};
```
Then, use it in your script. Each yielded comment will be processed in a concurrent loop body.
```javascript
// The loop processes each comment as it becomes available
for comment in fetchComments(postId)
  @data.comments.push({ author: comment.author, body: comment.body })
endfor
```

##### `while` Loops
Use a `while` loop to execute a block of code repeatedly as long as a condition is true. Unlike the parallel `for` loop, the `while` loop's body executes **sequentially**. The condition is re-evaluated only after the body has fully completed its execution for the current iteration.

This makes `while` loops ideal for stateful, iterative workflows where the result of one step is required to decide the next. For example, many AI agent frameworks use a reasoning loop to repeatedly think, act, and observe until a task is complete.

```
while some_expression
  // These statements run sequentially in each iteration
endwhile
```
**Example: Polling an API**

```javascript
var jobStatus = "pending"
// Poll the job status, but no more than 5 times
while jobStatus != "complete" and loop.index0 < 5
  // This async call must complete before the next iteration
  jobStatus = checkJobStatus(jobId)
endwhile
```

##### Sequential `each` Loops
For cases where you need to iterate over a collection but **preserve a strict sequential order**, use an `each` loop. It has the same syntax as a `for` loop but guarantees that each iteration completes before the next one begins. This is the opposite of the default parallel behavior of `for`.

Use `each` when the operations inside the loop have side effects that depend on the previous iteration, such as a sequence of database writes.

```
each item in collection
  // Statements run sequentially for each item
endeach
```

**Example: Creating Dependent Records**

```javascript
// Creates users and their settings one by one to avoid race conditions.
each user_data in new_users
  // create_user must finish before create_settings is called
  var newUser = db.create_user({ name: user_data.name })
  db.create_settings({ userId: newUser.id, theme: 'dark' })
endeach
```

##### The `loop` Variable

Inside a `for`, `while`, or `each` loop, you have access to the special `loop` variable, which provides metadata about the current iteration.

**Always-Available Properties**

These properties are available in all loop types:

*   `loop.index`: The current iteration of the loop (1-indexed).
*   `loop.index0`: The current iteration of the loop (0-indexed).
*   `loop.first`: `true` if this is the first iteration.

**Length-Dependent Properties**

The availability of the following properties depends on the type of loop and its contents:

*   `loop.revindex`: The number of iterations until the end (1-indexed).
*   `loop.revindex0`: The number of iterations until the end (0-indexed).
*   `loop.length`: The total number of items in the sequence.
*   `loop.last`: `true` if this is the last iteration.

Here is when you can use them:

#### 1. `for` loops over standard arrays or objects

This is the simplest case. The loop is iterating over a collection whose size is already known.

*   ✅ **Available**: All `loop` properties work as expected.

#### 2. `while` and `each` loops

`while` and `asyncEach` loops are **always sequential** by design. They process one item at a time, and therefore have no concept of a predetermined length.

*   ❌ **Not Available**: Length-dependent properties are not available because the loop's end point is not known in advance.

#### 3. `for` loops over Asynchronous Iterators (Default Mode)

This applies when you loop over something like an async generator, where items are processed as they arrive.

*   ✅ **Available**: To prioritize speed, Cascada starts processing items without waiting to count the entire collection first. The length-dependent properties are still available, but their final, correct values only become available **after the entire loop has finished processing**. Cascada handles this asynchronously for you, so you can use `loop.last` in a condition as you normally would.

    ```nunjucks
    {# Cascada handles the async nature of loop.last automatically. #}
    {% for item in myAsyncGenerator %}
      {{ item }}
      {% if loop.last %}
        {# This content will appear at the very end, after all items are processed. #}
        <p>Loop complete!</p>
      {% endif %}
    {% endfor %}
    ```

#### 4. `for` loops (in Sequential Fallback Mode)

For safety, Cascada automatically switches an async `for` loop into a "Sequential Fallback" mode when an iteration depends on the result of a previous one.

*   ❌ **Not Available**: In this mode, the `for` loop behaves like an `each` loop, running strictly one iteration at a time. Because it cannot see the end of the sequence in advance, the length-dependent properties are not available.

**When does a `for` loop enter Sequential Fallback?**

A `for` loop will automatically fall back to this safer, sequential mode when you:

*   **Modify a shared variable** with `{% set %}`:
    ```nunjucks
    {# This loop enters sequential fallback to prevent a race condition. #}
    {% set total = 0 %}
    {% for item in items %}
      {% set total = total + item.value %}
    {% endfor %}
    ```
*   **Use the sequential execution operator (`!`) on a function call**

#### Output
```
@text(expression)
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

#### Inline `if` Expressions
For concise conditional assignments, you can use an inline `if` expression, which works like a ternary operator.

```javascript
// Syntax: value_if_true if condition else value_if_false
var theme = "dark" if user.darkMode else "light"
```

#### Regular Expressions
You can create regular expressions by prefixing the expression with `r`.

```javascript
var emailRegex = r/^[^\s@]+@[^\s@]+\.[^\s@]+$/
if emailRegex.test(user.email)
  @text("Valid email address.")
endif
```

### **The Handler System: Using @ Output Commands**

Output Commands, marked with the `@` sigil, are the heart of Cascada Script's data-building capabilities. Their purpose is to declaratively construct a **result object** that is returned by any executable scope, such as an entire **script**, a **[macro](#macros-and-reusable-components)**, or a **[`capture` block](#block-assignment-with-capture)**.

All output operations use a standard function-call syntax, such as `@handler.method(...)`. This approach separates the *definition* of your final output from the *execution* of your asynchronous logic, allowing Cascada to run independent operations in parallel while ensuring your data is assembled correctly and in a predictable order.

#### A Simple Example

Before diving into the theory, let's look at how a few commands work together to build a JSON object.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// This script builds a user object.
// The :data directive focuses the output to
// get just the data property.
:data

var userId = 123
var userProfile = { name: "Alice", email: "alice@example.com" }
var userSettings = { notifications: true, theme: "light" }

@data.user.id = userId
@data.user.name = userProfile.name

// @data.push: Adds an item to an array
@data.user.roles.push("editor")
@data.user.roles.push("viewer")

// @data.merge: Combines properties into an object
@data.user.settings.merge(userSettings)
@data.user.settings.theme = "dark" // Overwrite one setting
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Assembled Data</strong></summary>

```json
{
  "user": {
    "id": 123,
    "name": "Alice",
    "roles": [
      "editor",
      "viewer"
    ],
    "settings": {
      "notifications": true,
      "theme": "dark"
    }
  }
}
```
</details>
</td>
</tr>
</table>

#### The Core Concept: Collect, Execute, Assemble

Instead of being executed immediately, `@` commands are handled in a three-step process that applies at the end of each **execution scope** (the main script, a [macro](#macros-and-reusable-components), or a [`capture` block](#block-assignment-with-capture)):

1.  **Collect:** As your script runs, Cascada collects `@` commands into a buffer, preserving their source-code order.
2.  **Execute:** All other logic—`var` assignments, `async` function calls, `for` loops—runs to completion. Independent async operations happen concurrently, maximizing performance.
3.  **Assemble:** Once all other logic in the current scope has finished, Cascada dispatches the buffered `@` commands **sequentially** to their handlers to build the final result for that scope.

This model is especially powerful for parallel operations, as shown below. The `for` loop dispatches all `fetchEmployeeDetails` calls in parallel. Only after they have *all* completed does the engine begin executing the buffered `@data.push` commands, using the data that was fetched.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
:data
var employeeIds = fetchEmployeeIds()

// Each loop iteration runs in parallel.
for id in employeeIds
  var details = fetchEmployeeDetails(id)

  // This command is buffered. It runs after all
  // fetches are done, using the 'details' variable.
  @data.company.employees.push({
    id: details.id,
    name: details.name
  })
endfor
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Assembled Data</strong></summary>

```json
{
  "company": {
    "employees": [
      { "id": 101, "name": "Alice" },
      { "id": 102, "name": "Bob" }
    ]
  }
}
```
</details>
</td>
</tr>
</table>

#### Output Handlers: `@data`, `@text`, and Custom Logic

Every `@` command is directed to an **output handler**. The handler determines what action is performed. Cascada provides two built-in handlers and allows you to [define your own for custom logic](#creating-custom-output-command-handlers).

*   **`@data`**: The built-in handler for building structured data (objects, arrays, strings and numbers).
*   **`@text`**: The built-in handler for generating a simple string of text.
*   **Custom Handlers**: You can define your own handlers for domain-specific tasks where a sequence of operations is important, such as drawing graphics (`@turtle.forward(50)`), logging, or writing to a database (`@db.users.insert(...)`).

Handler methods are executed synchronously during the "Assemble" step. For asynchronous tasks, your handler can use internal buffering or other state management techniques to collect commands and dispatch them asynchronously.

#### Understanding the Result Object

Any block of logic—the entire script, a macro, or a `capture` block—produces a result object. The keys of this object correspond to the **names of the output handlers** used within that scope. After the "Assemble" phase, the engine populates this object using values from each handler.

For example, a scope that uses the `data`, `text`, and a [custom `turtle` handler](#creating-custom-output-command-handlers) will produce a result object like this:
```json
{
  "data": { "report": { "title": "Q3 Summary" } },
  "text": "Report generation completed.",
  "turtle": { "x": 100, "y": 50, "angle": 90 }
}
```

#### Focusing the Output (`:data`, `:text`, `:handlerName`)

Often, you only need one piece of the result. You can **focus the output** using a colon (`:`) followed by the name of the desired handler (`data`, `text`, or a custom handler name). This **output focus directive** changes the return value of its scope from the full result object to just the single property you specified.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script (Unfocused)</strong></summary>

```javascript
// No directive. Returns the full result object.
@data.report.title = "Q3 Summary"
@text("Report generation complete.")
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Return Value (Unfocused)</strong></summary>

```json
{
  "data": {
    "report": {
      "title": "Q3 Summary"
    }
  },
  "text": "Report generation complete."
}
```
</details>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script (Focused with <code>:data</code>)</strong></summary>

```javascript
// The :data directive filters the final return value.
:data

@data.report.title = "Q3 Summary"
@text("Report generation complete.")
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Return Value (Focused)</strong></summary>

```json
{
  "report": {
    "title": "Q3 Summary"
  }
}
```
</details>
</td>
</tr>
</table>

#### Built-in Output Handlers

##### The `@data` Handler: Building Structured Data
The `@data` handler is the primary tool for constructing your script's `data` object. It provides a declarative, easy-to-read syntax for building complex data structures. All `@data` commands are collected during the script's execution and then applied in order to assemble the final data object.

Here's a simple example of how it works:

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
// The ':data' directive focuses the output
:data

// Set a simple value
@data.user.name = "Alice"
// Initialize 'logins' and increment it
@data.user.logins = 0
@data.user.logins++

// The 'roles' array is created automatically on first push
@data.user.roles.push("editor")
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

Of course. Here is a more concise version:

---

**Note:** Currently, `@data` commands can only be used on the left side of an expression to **write** data. Reading from `@data` on the right side is not yet supported, as the final data object is assembled *after* the main script logic runs.

**Valid:**
```
@data.user.name = "George"
```

**Invalid:**
```
// This will cause an error because you cannot read from @data yet.
@data.user.alias = @data.user.name
```
This functionality will be implemented in a future release.

###### `@data` Operations
Below is a detailed list of all available commands and operators.

**Assignment and Deletion**
The most common operations involve setting or removing a value at a given path.

| Command | Description |
|---|---|
| `@data.path = value` | **Replaces** the value at `path`. Creates objects/arrays as needed. This is a shortcut for the underlying `set` method. |
| `@data.path.delete()` | **Deletes** the value at `path` by setting it to `undefined`, which typically removes the key from the final JSON output. |

**Array Manipulation**
These methods modify arrays in place. If the target path does not exist when a method is called, an empty array is created first.

| Command | Description |
|---|---|
| `@data.path.push(value)` | Appends an element to the array at `path`. |
| `@data.path.concat(value)` | Concatenates another array to the array at `path`. If `value` is not an array, it is simply pushed as a single element. |
| `@data.path.pop()` | Removes the last element from the array at `path`. |
| `@data.path.shift()` | Removes the first element from the array at `path`. |
| `@data.path.unshift(value)`| Adds one or more elements to the beginning of the array at `path`. |
| `@data.path.reverse()` | Reverses the order of the elements in the array at `path`. |

**Object Manipulation**
These methods are used for combining objects.

| Command | Description |
|---|---|
| `@data.path.merge(value)` | Merges the properties of an object into the object at `path`. This is a shallow merge. |
| `@data.path.deepMerge(value)`| Deeply merges the properties of an object into the object at `path`. |

**Arithmetic Operations**
These operators provide a concise way to perform numeric modifications. They require the target to be a number.

| Command | Description |
|---|---|
| `@data.path += value` | Adds a number to the target. |
| `@data.path -= value` | Subtracts a number from the target. |
| `@data.path *= value` | Multiplies the target by a number. |
| `@data.path /= value` | Divides the target by a number. |
| `@data.path++` | Increments the target number by 1. |
| `@data.path--` | Decrements the target number by 1. |

**String Operations**
These methods are specialized for string manipulation.

| Command | Description |
|---|---|
| `@data.path += value` | Appends a string to the target string. Note: This operator is overloaded and also works for number addition. |
| `@data.path.append(value)`| Appends a string to the string value at `path`. |

**Logical & Bitwise Operations**
These operators are shortcuts for common logical and bitwise operations.

| Command | Description |
|---|---|
| `@data.path &&= value` | Performs a logical AND assignment (`target = target && value`). |
| `@data.path ||= value` | Performs a logical OR assignment (`target = target || value`). |
| `@data.path &= value` | Performs a bitwise AND assignment. |
| `@data.path |= value` | Performs a bitwise OR assignment. |
| `@data.path.not()` | Replaces the target with its logical NOT (`!target`). |
| `@data.path.bitNot()`| Replaces the target number with its bitwise NOT (`~target`). |

###### Handling `undefined` and `null` Targets
The `@data` handler is designed to be robust but also safe. Its behavior with non-existent (`undefined`) or `null` targets depends on the type of operation:

*   **Structure-building methods** (like `.push()`, `.merge()`, `.append()`) will gracefully handle an `undefined` target. For example, if you call `.push()` on a path that doesn't exist, Cascada will automatically create an empty array before pushing the new element.
*   **Arithmetic and Logical operators** (`+=`, `--`, `&&=`, etc.) are stricter. To prevent silent errors and unexpected results (like `null + 1` evaluating to `1`), these operators will throw a runtime error if the target path is `undefined` or `null`. You must explicitly initialize a value (e.g., `@data.counter = 0`) before you can increment or add to it.

##### The `@text` Command: Generating Text
The `@text(value)` command is a convenient shorthand for the `{{ value }}` output syntax found in the Cascada templating engine. It appends its `value` to a simple text stream, which populates the `text` property of the result object. This stream is completely separate from the `data` object.

```javascript
@text("Processing user " + userId + "...")
for item in items
  @text("Item: " + item.name)
endfor
@text("...done.")
```

#### Advanced Pathing

Paths in `@data` commands are highly flexible.

*   **Dynamic Paths**: Paths can include variables and expressions, allowing you to target structures dynamically.
    ```javascript
    for user in userList
      // Use the user's ID to set their status in the report object
      @data.report.users[user.id].status = "processed"
    endfor
    ```
*   **Root-Level Modification**: Use the `@data` handler directly to modify the root of the `data` object itself.
    ```javascript
    // Replaces the entire data object with a new one
    @data = { status: "complete", timestamp: now() }
    ```
    While it defaults to an object, you can also re-assign the root to a different type, such as an array or a string. After re-assignment, you can use methods appropriate for that type directly on `@data`.
    ```javascript
    // Re-assign the root to be an array before pushing to it.
    @data = []
    @data.push("first item")
    ```
*   **Array Index Targeting**: Target specific array indices with square brackets. The empty bracket notation `[]` always refers to the last item added in the script's sequential order, **not** the most recently pushed item in terms of operation completion. Due to implicit concurrency, the order of completion can vary, but Cascada Script ensures consistency by following the script's logical sequence.
    ```javascript
    // Target a specific index
    @data.users[0].permissions.push("read")

    // Target the last item added in the script's sequence
    @data.users.push({ name: "Charlie" })
    // The path 'users[]' now refers to Charlie's object
    @data.users[].permissions.push("read") // Affects "Charlie"
    ```

#### Extending Output Commands

##### Customizing the `@data` Handler
You can add your own custom methods or override existing ones for the built-in `@data` handler using `env.addDataMethods()`. This method takes an object where each key is a method name and each value is a function that defines the custom logic.

This is a powerful way to create reusable, domain-specific logic. Your custom methods are defined in JavaScript and can be called from within your Cascada scripts like any built-in method.

A custom data method has the following signature:

```javascript
// In your JS setup
env.addDataMethods({
  // methodName is how you'll call it in the script: @data.path.methodName(...)
  methodName: function(target, ...args) {
    // ... your logic ...
    return newValue;
  }
});
```

**Parameters:**

*   `target`: The current value at the path the command is targeting. For example, in `@data.users[0].name.append("!")`, the `target` passed to the `append` method would be the current string value of `users[0].name`. If the path doesn't exist yet, `target` will be `undefined`. Your method should often handle this case, for instance by creating a default array or object.
*   `...args`: A list of the arguments passed to the method in the script. For a call like `@data.users.upsert(newUser, { overwrite: true })`, the `args` array would be `[newUser, { overwrite: true }]`.

**Return Value:**

The value returned by your function determines the new state of the data at the target path.

*   **If you return any value** (an object, array, string, number, etc.), it **replaces** the `target` value at that path. For in-place mutations (like modifying an array), you must return the mutated `target` itself to save the changes.
*   **If you return `undefined`**, it signals to the engine to **delete** the property at that path. This is equivalent to `delete parent[key]`.

**Overriding Operators:**

All shortcut operators (`+=`, `++`, `&&=`, etc.) are mapped to underlying methods. By overriding these methods, you can fundamentally change the behavior of the operators.

| Operator | Corresponding Method |
|---|---|
| `@... = value` | `set(target, value)` |
| `@... += value` | `add(target, value)` |
| `@... -= value` | `subtract(target, value)` |
| `@... *= value` | `multiply(target, value)` |
| `@... /= value` | `divide(target, value)` |
| `@...++` | `increment(target)` |
| `@...--` | `decrement(target)` |
| `@... &&= value` | `and(target, value)` |
| `@... ||= value` | `or(target, value)` |
| `@... &= value` | `bitAnd(target, value)` |
| `@... |= value` | `bitOr(target, value)` |


**Example: Adding a custom `@data.upsert` command.**
Here's how you can add a new `upsert` method that either updates an existing item in an array or adds it if it's not found. This example demonstrates handling an `undefined` target and returning the modified array.

```javascript
// --- In your JavaScript setup ---
env.addDataMethods({
  upsert: (target, newItem) => {
    // 1. Handle the case where the path doesn't exist yet.
    if (!Array.isArray(target)) {
      target = []; // Initialize target as a new array.
    }

    // 2. Implement the upsert logic.
    const index = target.findIndex(item => item.id === newItem.id);
    if (index > -1) {
      // Item found, so update it.
      Object.assign(target[index], newItem);
    } else {
      // Item not found, so add it.
      target.push(newItem);
    }

    // 3. Return the modified array to save the changes.
    return target;
  }
});

// --- In your Cascada Script ---
// 'users' doesn't exist yet, but `upsert` will create the array.
@data.users.upsert({ id: 1, name: "Alice" })

// Now call it again to update Alice's record.
@data.users.upsert({ id: 1, name: "Alice", status: "active" })
```

##### Creating Custom Output Command Handlers
For advanced use cases, you can define **Custom Output Command Handlers**. These are classes that receive and process `@` commands, allowing you to create powerful, domain-specific logic.

###### Registering and Using Handlers
You register handlers with a unique name. To use a named handler, prefix the command with the handler's name and a dot.

**Example: Using a `turtle` handler.**
```javascript
// --- In your JavaScript setup ---
env.addCommandHandlerClass('turtle', CanvasTurtle);

// --- In your Cascada Script ---
@turtle.begin()
@turtle.forward(50)
@turtle.stroke('cyan')
```

###### Handler Implementation Patterns
Cascada supports two powerful patterns for how your handler classes are instantiated and used.

**Pattern 1: The Factory (Clean Slate per Render)**
Provide a **class** using `env.addCommandHandlerClass(name, handlerClass)`. For each render, the engine creates a new, clean instance, passing the `context` to its `constructor`. This is the recommended pattern for most use cases.

```javascript
// --- In your JavaScript setup (Handler Class) ---
class CanvasTurtle {
  // The constructor receives the runtime context
  constructor(context) {
    this.ctx = context.canvas.getContext('2d');
    // ... setup logic ...
  }
  forward(dist) { /* ... */ }
  turn(deg) { /* ... */ }
}

// --- In your JavaScript setup (Registration) ---
env.addCommandHandlerClass('turtle', CanvasTurtle);
```

**Pattern 2: The Singleton (Persistent State)**
Provide a pre-built **instance** using `env.addCommandHandler(name, handlerInstance)`. The same instance is used across all render calls, which is useful for accumulating state (e.g., logging). If the handler has an `_init(context)` method, the engine will call it before each run.

```javascript
// --- In your JavaScript setup (Handler Class) ---
class CommandLogger {
  constructor() { this.log = []; }
  // This hook is called before each script run
  _init(context) { this.log.push(`--- START (User: ${context.userId}) ---`); }
  _call(command, ...args) { this.log.push(`${command}: ${JSON.stringify(args)}`); }
}

// --- In your JavaScript setup (Registration) ---
const logger = new CommandLogger();
env.addCommandHandler('audit', logger);
```

###### Contributing to the Result Object: The `getReturnValue` Method
A handler can optionally implement a `getReturnValue()` method.
*   If `getReturnValue()` **is implemented**, its return value will be used as the value for the handler's key in the final result object.
*   If it **is not implemented**, the handler instance itself will be used.

This is how the built-in `@data` handler provides a clean data object in the final result, rather than the `DataHandler` instance itself.

#### Important Distinction: `@` Commands vs. `!` Sequential Execution

It is crucial to understand the difference between these two features, as they solve different problems.

*   **`@` Output Commands:**
    *   **Purpose:** For **assembling a result** from a buffer after data is fetched.
    *   **Timing:** They are processed *after* their containing scope finishes its main evaluation. This delay may not be optimal if the operations need to have side effects as early as possible.
    *   **Nature:** They are for data construction and sequenced logic, not for controlling live async operations.

*   **`!` [Sequential Execution](#sequential-execution-control-):**
    *   **Purpose:** For **controlling the order of live, async operations** that have side effects (e.g., database writes).
    *   **Timing:** It forces one async call to wait for another to finish *during* the main script evaluation, ensuring operations run as early as possible.
    *   **Nature:** It manages the real-time execution flow of asynchronous functions, and their results are immediately available to the next line of code.

## Macros and Reusable Components

Macros allow you to define reusable chunks of logic that build and return structured data objects. They operate in a completely isolated scope and are the primary way to create modular, reusable components in Cascada Script.

Macros implicitly return the structured object built by the [Output Commands](#the-handler-system-using--output-commands) (`@data =`, `@data.push`, etc.) within their scope. An explicit `return` statement is not required, but if you include one, its value will override the implicitly built object.

### Defining and Calling a Macro

A macro can perform its own internal, parallel async operations and then assemble a return value.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Cascada Script</strong></summary>

```javascript
macro buildDepartment(deptId) : data
  // These two async calls run in parallel.
  var manager = fetchManager(deptId)
  var team = fetchTeamMembers(deptId)

  // Assemble the macro's return value.
  @data.department.manager = manager.name
  @data.department.teamSize = team.length
endmacro

// Call the macro. 'salesDept' becomes the data object.
var salesDept = buildDepartment("sales")

// Use the returned object in the main script's assembly.
@data.company.sales = salesDept
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Return Value (`:data` focused)</strong></summary>

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
Macros support keyword arguments, allowing for more explicit and flexible calls. You can define default values for arguments, and callers can pass arguments by name.

```javascript
// Macro with default arguments
macro input(name, value="", type="text") : data
  @data.field.name = name
  @data.field.value = value
  @data.field.type = type
endmacro

// Calling with mixed and keyword arguments
var passwordField = input("pass", type="text")
@data.result.password = passwordField.field
```

### Output Scopes and Focusing in Macros

Like the main script body, a macro's output can be focused using a directive such as `:data`. This controls the macro's return value, making it easier to consume. The example below shows a macro that returns a clean data object, which is then assigned to a variable.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Macro with <code>:data</code> focus</strong></summary>

```javascript
// The :data directive filters the macro's
// return value to be just the data object.
macro buildUser(name) : data
  @data.user.name = name
  @data.user.active = true
endmacro

// 'userObject' is now a clean object,
// not { data: { user: ... } }.
var userObject = buildUser("Alice")

@data.company.manager = userObject.user
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Return Value of Script</strong></summary>

```json
{
  "company": {
    "manager": {
      "name": "Alice",
      "active": true
    }
  }
}
```
</details>
</td>
</tr>
</table>

## Advanced Flow Control

### Sequential Execution Control (`!`)

For functions with **side effects** (e.g., database writes), the `!` marker enforces a **sequential execution order** for a specific object path. Once a path is marked, *all* subsequent method calls on that path (even those without a `!`) will wait for the preceding operation to complete, while other independent operations continue to run in parallel.

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

### Resilient Error Handling: An Error is Just Data

**Note**: This feature is under development.

Cascada has a simple yet powerful approach to error handling: **an error is just another type of data**. Instead of halting execution with exceptions, failed operations produce a special **Error Value**. Any variable can hold this value, it can be passed to functions, and it can be inspected just like a number or a string.

This model is designed for concurrency. When an operation in one part of your script fails, it produces an Error Value. This has no effect on independent, parallel operations, which continue to run unaffected.

### The Core Mechanism: Error Propagation

Once an Error Value is created, it automatically "poisons" any subsequent operation that depends on it. This is called **error propagation**.

*   **Expressions:** An expression involving an Error Value immediately resolves to that error without evaluating the other parts.
    ```javascript
    var x = myError + (2 * 10) // The result is myError, (2 * 10) is not calculated
    ```
*   **Function Calls:** A function call with an Error Value as an argument is never actually executed. It returns the Error Value immediately.
    ```javascript
    var result = someFunction(arg1, myError) // someFunction is not called
    ```
*   **Loops:** A loop over an Error Value will not execute its body.
    ```javascript
    for item in myErrorCollection // The loop body is skipped entirely
      // ...
    endfor
    ```
*   **Conditionals:** For an `if` statement with an Error Value, neither the `if` nor the `else` block is executed.

This propagation happens for both errors returned from functions and for errors caused by expressions, such as dividing by zero or accessing a property on a `none` value.

### Anatomy of an Error Object

Every Error Value in Cascada is a rich object designed for easy debugging.

*   `message`: (string) The human-readable error message.
*   `name`: (string) A custom name for business-logic errors (e.g., `'ValidationError'`).
*   `jsError`: (object | null) The underlying JavaScript `Error` object if the failure originated from the JS environment, providing access to the original stack trace.
*   `source`: (object) A tracer that tells you the error's history:
    *   `origin`: (string) The string representation of the function call or `@error` command that *first* created the error.
    *   `variables`: (string[]) An array of all variable names that were subsequently assigned this exact Error Value as it propagated through your script.

### Inspecting, Reporting, and Handling Errors

Cascada provides a complete toolkit for creating, detecting, inspecting, and handling errors.

#### Peeking Inside Errors with `#`

Because of error propagation, a standard property access like `myError.message` would just return `myError`. To inspect the properties of an Error Value itself, use the special **`#` (peek) operator**.

```javascript
var failedUser = fetchUser(999)

if failedUser is error
  // Use '#' to access properties of the Error Value
  @text("Operation failed!")
  @text("Origin: " + failedUser#source.origin)
  @text("Message: " + failedUser#message)
endif
```

#### Checking for Errors with `is error`

The `is error` test is the fundamental way to check if a variable holds an Error Value.
```javascript
var user = fetchUser(123)
if user is error
  // Use '#' to get the error message for logging
  @data.error_message = user#message
endif
```

#### Providing Defaults with `fallback()`

To concisely provide a default value for an expression that might fail, use the `fallback()` global function. An error handled this way is considered resolved and will not trigger a `catch` block.

**`fallback(expression, defaultValue)`**
It evaluates `expression`. If the result is an Error Value, it returns the `defaultValue`.

```javascript
// Provide a default avatar if the user's preference is missing or invalid.
@data.avatar = fallback(user.prefs.avatar_url, "default_avatar.png")
```

#### Reporting Custom Errors with `@error`

You can **report** your own business-logic errors using the `@error()` output command. This is perfect for validation or enforcing rules within your script.

**`@error(message, [error])`**
*   `message`: (string) The error message.
*   `error` (optional): A string name (e.g., `'Validation'`) or a raw JavaScript Error object.
```javascript
if user.balance < requiredAmount
  @error("Insufficient funds for transaction.", "BalanceError")
endif
```

### Handling Failures with the `try/on error/catch` Block

The `try/on error/catch` construct is designed to handle real-time failures, build in resilience, and provide a final aggregation point, all without sacrificing concurrency.

The block has three parts, each serving a distinct purpose:

| Part | Purpose | Execution Timing |
| :--- | :--- | :--- |
| **`try`** | The main logic. | Executed first. |
| **`on error`** | (Optional) A real-time event handler for each individual failure. | Runs immediately and concurrently each time an error occurs within `try`. |
| **`catch`** | (Optional) A final aggregation block for all unhandled errors. | Runs once at the end, after all `try` and `on error` logic has completed. |

#### The `try` Block: Defining the Scope
This is where you place your main logic. All operations inside this block are monitored for failures.
```javascript
try
  // Your main workflow logic goes here.
  var user = fetchUser(123)
  var report = generateReportFor(user)
  db.save(report)
  // ... on error and catch blocks follow
```

#### The `on error` Block: Real-time Intervention and Resilience
This optional block is a powerful, real-time event handler. It is invoked **each time** an operation within the `try` scope fails, allowing you to react to failures as they happen. It is not invoked for Error Objects that were overriden by a `fallback()` call.

*   **It Does Not Block:** The `on error` handler for one failure runs concurrently with other independent operations in the `try` block. It does not create a performance bottleneck.
*   **Safe Scope:** It has read-only access to variables from the outer scope but can safely use buffered output commands (like `@data` or `@text`).
*   **The `error` Variable:** Inside this block, a special `error` variable is available, holding the details of the specific failure that triggered it. You can access its properties directly without the `#` peek operator.

The `error` variable provides properties for inspection and methods for taking action:
*   **Properties for Inspection:**
    *   `error.message`, `error.name`, `error.jsError`, `error.source`: The same rich properties as a standard Error Value.
    *   `error.retryCount`: The number of times this specific operation has been retried (1-indexed).
*   **Methods for Action:**
    *   **`error.retry()`**: Re-invokes the original function call that failed. This is the primary mechanism for building resilience. The method returns `true` if a retry is possible (it was a function call error), and `false` otherwise (e.g., for a divide-by-zero error).
    *   **`error.resolve(value)`**: Halts the error propagation and substitutes the given `value` as the successful result of the failed operation. The operation is now considered a success.

Here is a full example demonstrating a retry strategy:
```javascript
try
  var reportData = generateReport()      // Might fail with a 'TransientError'
  db.saveReport(reportData)              // Might fail with a 'DBConnectionError'
on error
  // This logic runs for each failure.
  if error.retryCount < 3 and error.name == 'TransientError'
    // Log the attempt and retry for transient errors.
    @text("Transient error on " + error.source.origin + ". Retrying...")
    error.retry()
  else
    // For permanent errors or too many retries, just log it.
    // The error will continue to propagate and be caught by the 'catch' block.
    @text("Permanent failure on " + error.source.origin)
  endif
```
---
#### The `catch` Block: Final Aggregation
This optional block is the final backstop. It runs **once** after all logic in the `try` block and all `on error` handlers have completed. Its primary purpose is for final logging, setting a global failure status, reporting on the ultimate outcome of the workflow, or recovering from the errors.

Inside this block, a special `errors` variable is available, containing an array of all **unhandled** Error Objects—those that were not resolved by `error.resolve()`, a successful `error.retry()`, or a `fallback()` call. You can access its properties directly without the `#` peek operator.

```javascript
catch errors
  // This runs only if there are errors that were not successfully handled
  // by the 'on error' block.
  @data.status = "FAILED_PERMANENTLY"
  for err in errors
    @data.unhandled_errors.push({
      culprit: err.source.origin,
      message: err.message
    })
  endfor
endtry // This concludes the full try/on error/catch construct.
```

### Unhandled Errors and the Final Return Value

Cascada provides a crucial safety net to ensure that unhandled errors are never silently ignored, especially when using output focusing. This mechanism applies not just to the entire script, but to any execution scope that produces a result, such as a [macro](#macros-and-reusable-components) or a [`capture` block](#block-assignment-with-capture).

Under the hood, all unhandled errors that are not resolved within a `try/on error/catch` block are collected by a special `@error` output handler. The presence of errors in this handler fundamentally changes the final return value of the scope.

#### Behavior Without Output Focusing

If you do not focus the output (i.e., you do not use `:data`, `:text`, etc.), the result of the scope is the standard result object. The collected errors will be neatly contained within the `error` property.

*   **Result:** A standard object like `{ data: {...}, text: "...", error: <PoisonError> }`.
*   **Error Propagation:** This return value is **not** an Error Value itself. It does not trigger error propagation. Your calling code is responsible for checking the `result.error` property to see if failures occurred.

```javascript
// A script without output focusing
var user = fetchUser(999) // Fails

// Returns: { data: {}, text: "", error: <PoisonError> }
```

#### Behavior With Output Focusing (`:data`, `:text`, etc.)

This is where the safety net becomes critical. When you focus the output, you are asking for a specific, clean piece of data. If unhandled errors have occurred, returning just the (potentially incomplete) focused data would be misleading and dangerous.

*   **Rule:** If a scope's output is focused (e.g., `:data`) AND the `@error` handler for that scope is not empty, the scope will **ignore the focusing directive**.
*   **Result:** Instead of returning the focused data, the scope will return a single **Compound Error Value**.
*   **Error Propagation:** Because the return value is a proper Error Value, it **will trigger error propagation** in the calling scope.

```javascript
// A macro with output focusing
macro buildUser() :data
  var user = fetchUser(999) // Fails, populates the @error handler
  @data.id = user#id
endmacro

// Calling the macro
var report = capture
  // buildUser() returns a Compound Error Value, not the data object.
  var userData = buildUser()
  // Because userData is an error, this line propagates the error.
  @data.final_user = userData
endcapture

// The 'report' variable will now hold the Compound Error Value from buildUser().
```

This design guarantees that you cannot accidentally consume partial or incorrect data from a failed, focused operation. The failure is forced into the data flow, demanding that it be handled.

#### The Compound Error Object

The `PoisonError` is a special type of Error Value that aggregates all unhandled errors from an execution scope. It shares the standard error properties (`message`, `name`, `source`) but also includes an `errors` property containing the array of all the individual Error Objects that were collected. This provides a complete summary of everything that went wrong within that scope.

### Filters and Global Functions

Cascada Script supports the full range of Nunjucks [built-in filters](https://mozilla.github.io/nunjucks/templating.html#builtin-filters) and [global functions](https://mozilla.github.io/nunjucks/templating.html#global-functions). You can use them just as you would in a template.

#### Filters
Filters are applied with the pipe `|` operator.
```javascript
var title = "a tale of two cities" | title
@text(title) // "A Tale Of Two Cities"

var users = ["Alice", "Bob"]
@text("Users: " + (users | join(", "))) // "Users: Alice, Bob"
```

#### Global Functions
Global functions like `range` can be called directly.
```javascript
for i in range(3)
  @text("Item " + i) // Prints Item 0, Item 1, Item 2
endfor
```

#### Additional Global Functions

##### `cycler(...items)`
The `cycler` function creates an object that cycles through a set of values each time its `next()` method is called.

```javascript
var rowClass = cycler("even", "odd")
for item in items
  // First item gets "even", second "odd", third "even", etc.
  @data.push(report.rows, { class: rowClass.next(), value: item })
endfor
```

##### `joiner([separator])`
The `joiner` creates a function that returns the separator (default is `,`) on every call except the first. This is useful for delimiting items in a list.

```javascript
var comma = joiner(", ")
var output = ""
for tag in ["rock", "pop", "jazz"]
  // The first call to comma() returns "", subsequent calls return ", "
  output = output + comma() + tag
endfor
@text(output) // "rock, pop, jazz"
```


## Modular Scripts
**Note:** This functionality is under active development. Currently you can not safely access mutable fariables from a parent script.

Cascada provides powerful tools for composing scripts, promoting code reuse and the separation of concerns. This allows you to break down complex workflows into smaller, maintainable files. The three primary mechanisms for this are [`import`](#importing-libraries-with-import) for namespaced libraries, [`include`](#including-scripts-with-include) for embedding content, and [`extends`/`block`](#script-inheritance-with-extends-and-block) for script inheritance.

### Declaring Cross-Script Dependencies
To enable its powerful parallel execution model, Cascada's compiler must understand all variable dependencies at compile time. When you split your logic across multiple files, you must explicitly declare how these files share variables. This creates a clear "contract" between scripts and allows the engine to understand the variable dependencies for concurrent execution.

This contract is formed by three keywords:

*   **`extern`**: Used in the *called* script (the one being included or imported). It declares which variables it **expects** to receive from a parent script. It is a declaration of need.
    ```cascada
    // in component.script
    extern user, theme // Declares that this script needs 'user' and 'theme'
    ```

*   **`reads`**: Used in the *calling* script on an `import`, `include`, or `block` statement. It grants **read-only permission** to the specified variables.
    ```cascada
    // in main.script
    include "component.script" reads user, theme
    ```

*   **`modifies`**: Used in the *calling* script, just like `reads`. It grants **full read and write permission** to the specified variables, allowing the called script to change their values in the parent scope.
    ```cascada
    // in main.script
    include "component.script" reads user modifies theme
    ```

### Importing Libraries with `import`
Use `import` to load a script as a library of reusable, stateless components, primarily macros. By default, an `import` is completely isolated: it does not execute and cannot access the parent's variables or global context.

#### Importing a Namespace with `as`
This is the cleanest way to share utility functions, binding all of a script's exported macros and variables to a single namespace object.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong><code>utils.script</code></strong></summary>

```cascada
// Defines a reusable macro for formatting.
macro formatUser(user) : data
  @data.fullName = user.firstName + " " + user.lastName
endmacro
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong><code>main.script</code></strong></summary>

```cascada
// Import the macros from utils.script into the 'utils' namespace.
import "utils.script" as utils

var user = fetchUser(1)
var formatted = utils.formatUser(user)

@data.user = formatted
```
</details>
</td>
</tr>
</table>

#### Importing Specific Macros with `from`
Use `from ... import` to pull specific macros into the current script's namespace, allowing you to call them directly.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong><code>utils.script</code></strong></summary>

```cascada
macro formatUser(user) : data
  @data.fullName = user.firstName + " " + user.lastName
endmacro
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong><code>main.script</code></strong></summary>

```cascada
from "utils.script" import formatUser

var user = fetchUser(1)
var formattedUser = formatUser(user)

@data.user = formattedUser
```
</details>
</td>
</tr>
</table>

#### Stateful Imports with `reads` and `modifies`
To create stateful libraries (e.g., a logging utility) that can interact with the caller's state, an `import` must be explicitly granted permissions. This turns a typically stateless `import` into a powerful tool for modular, state-aware logic.

*   Use `reads` and `modifies` on the `import` statement to grant access to specific script variables from the parent. The imported script must declare these variables using `extern`.
*   Use the special `context` keyword in **`reads context`** to grant the imported script **read-only access to the global context object** (the data passed in from your JavaScript code). This syntax is unique to the `import` statement.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong><code>logger.script</code></strong></summary>

```cascada
// This library declares that it needs a 'log_messages'
// variable from whatever script imports it.
extern log_messages

// This macro provides the "function" to be called.
macro add(message)
  // It modifies the 'log_messages' variable from the parent scope,
  // because the parent explicitly granted permission.
  log_messages.push(message)
endmacro
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong><code>main.script</code></strong></summary>

```cascada
// The main script defines the state to be modified.
var log_messages = []

// Import the 'add' macro and explicitly grant it
// permission to modify the 'log_messages' variable.
from "logger.script" import add as log modifies log_messages

// Call the imported macro. It can now modify our local state.
log("Process started.")
log("User authenticated.")

@data.final_log = log_messages
```
</details>
</td>
</tr>
</table>

### Including Scripts with `include`
Use `include` to execute another script within the current script's scope. This is useful for breaking a large workflow into smaller, stateful components. An `include` automatically shares the global context. As described above, you must use `reads` and `modifies` to grant access to parent variables, and the included script must declare them with `extern`.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong><code>user_widget.script</code></strong></summary>

```cascada
// The script declares that it expects 'user' and
// 'usageStats' variables from its parent.
extern user, usageStats

// Use these variables to build its part of the data.
@data.widget.user.name = user.name

// Modify a variable from the parent scope.
usageStats.widgetLoads++
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong><code>main.script</code></strong></summary>

```cascada
var user = fetchUser(1)
var usageStats = { widgetLoads: 0 }

// Include the component, defining its permissions.
include "user_widget.script" reads user modifies usageStats

@data.stats = usageStats
```
</details>
</td>
</tr>
</table>

### Script Inheritance with `extends` and `block`
Use `extends` for an "inversion of control" pattern, where a "child" script provides specific implementations for placeholder `block`s defined in a "base" script.

#### Scoping in `extends` and `block`
When a child script extends a base script, they effectively merge into a single scope.
- **Shared State & Contract:** The base script uses `reads` and `modifies` on the `block` definition to declare a "contract" for which variables the child's implementation can access. The child script must use `extern` to declare these variables.
- **Top-Level `var` in Child:** Variables declared with `var` at the top level of the child script (outside any `block`) are set *before* the base script's layout is executed, so the base script can see and use them.
- **`var` Inside a `block`:** Variables declared inside a `block` are **temporary and local** to that block's execution. They cannot be seen by the base script or other blocks, preventing side effects.

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong><code>base_workflow.script</code> (Base)</strong></summary>

```cascada
var inputData = loadInitialData()
var result = { processed: false }

// Define a block contract. Child scripts can read
// 'inputData' and both read and write to 'result'.
block process_data reads inputData modifies result
  // Default processing logic.
  result.defaultProcessed = true
endblock

// This will use the final value of 'result',
// which may have been changed by the child script.
if result.processed
  saveResult(result)
endif
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong><code>custom_workflow.script</code> (Child)</strong></summary>

```cascada
extends "base_workflow.script"

// Declare variables from the base script.
extern inputData, result

// Override the 'process_data' block.
block process_data
  var enhancedData = enhance(inputData)

  // Modify the shared 'result' object
  result.summary = summarize(enhancedData)
  result.processed = true
endblock
```
</details>
</td>
</tr>
</table>

## API Reference

Cascada builds upon the robust Nunjucks API, extending it with a powerful new execution model for scripts. This reference focuses on the APIs specific to Cascada Script, including the `AsyncEnvironment`, the distinction between `Script` and `Template` objects, and methods for extending the engine's capabilities.

For details on features inherited from Nunjucks, such as the full range of built-in filters and advanced loader options, please consult the official [Nunjucks API documentation](https://mozilla.github.io/nunjucks/api.html).

### Key Distinction: Script vs. Template

Cascada introduces a clear separation between two types of assets:

*   **Script**: A file or string designed for **logic and data orchestration**. Scripts use features like `var`, `for`, `if`, and `@` output commands to execute asynchronous operations, compose data, and produce a structured result (typically a JavaScript object or array). Their primary goal is to *build data*.
*   **Template**: A file or string designed for **presentation and text generation**. Templates use `{{ variable }}` and `{% tag %}` syntax to render a final string output, such as HTML, XML, or Markdown. Their primary goal is to *render text*.

The API provides distinct methods and classes for working with each type.

### AsyncEnvironment Class

The `AsyncEnvironment` is the primary class for orchestrating and executing Cascada Scripts. It is fully asynchronous and all its rendering methods return Promises. It's the central hub for managing configuration, loaders, filters, and extensions.

#### Execution
These methods execute a script or template and return the final result.

*   `asyncEnvironment.renderScript(scriptName, [context])`
    Loads and executes a script from a file using the configured loader. Returns a `Promise` that resolves with the script's output.

    ```javascript
    // Assuming 'scripts/getUser.casc' exists and a loader is configured.
    const userData = await env.renderScript('getUser.casc', { userId: 123 });
    ```

*   `asyncEnvironment.renderScriptString(source, [context])`
    Executes a script from a raw string. This is useful for dynamic or simple scripts. Returns a `Promise` that resolves with the script's output.

    ```javascript
    const script =
    `:data
    @data.user.name = "Alice"`;
    const result = await env.renderScriptString(script);
    // result is: { user: { name: "Alice" } }
    ```

*   `asyncEnvironment.renderTemplate(templateName, [context])`
*   `asyncEnvironment.renderTemplateString(templateSource, [context])`
    Renders a traditional Nunjucks template to a string. These methods work just like their Nunjucks counterparts but return Promises.


#### Configuration

You create an environment instance by calling its constructor, optionally passing in loaders and configuration options.

*   `new AsyncEnvironment([loaders], [opts])`
    Creates a new environment.
    *   `loaders`: A single loader or an array of loaders to find script/template files.
    *   `opts`: An object with configuration flags:
        *   `autoescape` (default: `true`): If `true`, automatically escapes output from templates to prevent XSS attacks.
        *   `trimBlocks` (default: `false`): Automatically remove the first newline after a block tag.
        *   `lstripBlocks` (default: `false`): Automatically strip leading whitespace from a block tag.
        *   For other options, see the Nunjucks documentation.

    ```javascript
    const { AsyncEnvironment, FileSystemLoader } = require('cascada-engine');

    // Configure the environment to load files from the 'scripts' directory
    const env = new AsyncEnvironment(new FileSystemLoader('scripts'), {
      trimBlocks: true
    });
    ```

**Loaders**

Loaders are objects that tell the environment how to find and load your scripts and templates from a source, such as the filesystem, a database, or a network.

*   **Built-in Loaders:** Cascada comes with several useful loaders inherited from Nunjucks:
    *   **`FileSystemLoader`**: (Node.js only) Loads files from the local filesystem.
    *   **`WebLoader`**: (Browser only) Loads files over HTTP from a given base URL.
    *   **`PrecompiledLoader`**: Loads assets from a precompiled JavaScript object, offering the best performance for production.

    You can pass a single loader or an array of loaders to the `AsyncEnvironment` constructor. If an array is provided, Cascada will try each loader in order until one successfully finds the requested file.

```javascript
const env = new AsyncEnvironment([
  new FileSystemLoader('scripts'),
  new PrecompiledLoader(precompiledData)
]);
```

*   **Custom Loaders:** You can create a custom loader by providing either a simple function or a more structured class. The engine automatically handles both synchronous and asynchronous loaders. If a loader can't find an asset, it should return `null` to allow fallback to the next loader in the chain.

    **1. The Simple Way: A Loader Function**
    For simple cases, a loader can be a function that takes the asset name and returns its content as a string, or a `Promise` that resolves to the content.

    **2. Adding Metadata with `LoaderSource`**
    For more control, your loader function (or class method) can return a `LoaderSource` object: `{ src, path, noCache }`.
    *   `src`: The script or template source code.
    *   `path`: The resolved path, used for error reporting and debugging.
    *   `noCache`: A boolean that, if `true`, prevents this specific asset from being cached by the environment.

    ```javascript
    // A custom loader that fetches scripts from a network
    const networkLoader = async (name) => {
      const response = await fetch(`https://my-cdn.com/scripts/${name}`);
      if (!response.ok) return null;
      const src = await response.text();
      // Return a LoaderSource object for better debugging and caching control
      return { src, path: name, noCache: false };
    };
    ```

    **3. The Advanced Way: A Loader Class**
    For the most power and flexibility, create a class that implements the loader interface. This allows for features like relative path resolution (`import`, `include`) and event-driven cache invalidation.

    A loader class has one required method and several optional ones for advanced functionality:

    | Method | Description | Required? |
    |---|---|:---:|
    | `load(name)` | The core method. Loads an asset by name and returns its content (as a string or `LoaderSource` object), or `null` if not found. Can be async. | **Yes** |
    | `isRelative(name)` | Returns `true` if a filename is relative (e.g., `./component.script`). Used for `include`, `import`, and `extends`. | No |
    | `resolve(from, to)`| Resolves a relative path (`to`) based on the path of a parent script (`from`). | No |
    | `on(event, handler)` | Listens for environment events (`'load'`, `'update'`). Useful for advanced caching strategies. | No |

    Here is an example of a class-based loader that supports relative paths:
    ```javascript
    // A custom loader that fetches scripts from a database and handles relative paths
    class DatabaseLoader {
      constructor(db) { this.db = db; }

      // The required 'load' method can be synchronous or asynchronous
      async load(name) {
        const scriptRecord = await this.db.scripts.findByName(name);
        if (!scriptRecord) return null;
        // Return a LoaderSource object with the content and path
        return { src: scriptRecord.sourceCode, path: name, noCache: false };
      }

      // Optional method to identify relative paths
      isRelative(filename) {
        return filename.startsWith('./') || filename.startsWith('../');
      }

      // Optional method to resolve relative paths
      resolve(from, to) {
        // This is a simplified example; a real implementation would use a
        // library like 'path' or a URL resolver.
        const fromDir = from.substring(0, from.lastIndexOf('/'));
        return `${fromDir}/${to}`;
      }
    }

    const env = new AsyncEnvironment(new DatabaseLoader(myDbConnection));
    ```

    **4. Running Loaders Concurrently**

The **`raceLoaders(loaders)`** function creates a single, optimized loader that runs multiple loaders concurrently and returns the result from the first one that succeeds. This is ideal for scenarios where you want to implement fallback mechanisms (e.g., try a CDN, then a local cache) or simply load from the fastest available source without waiting for slower ones.

    ```javascript
    const { raceLoaders, FileSystemLoader, WebLoader } = require('cascada-engine');

    // This loader will try to fetch from the web first, but if that is slow
    // or fails, it will fall back to the filesystem loader.
    const fastLoader = raceLoaders([
      new WebLoader('https://my-cdn.com/scripts/'),
      new FileSystemLoader('scripts/backup/')
    ]);

    const env = new AsyncEnvironment(fastLoader);
    ```

#### Compilation and Caching

For better performance, the environment can compile and cache assets.

*   `asyncEnvironment.getScript(scriptName)`
    Retrieves a compiled `AsyncScript` object for the given `scriptName`, loading it via the configured loader if it's not already in the cache. Returns a `Promise` that resolves with the `AsyncScript` instance.

*   `asyncEnvironment.getTemplate(templateName)`
    Retrieves a compiled `AsyncTemplate` object. Works similarly to `getScript`.

    ```javascript
    // Get a compiled script once
    const compiledScript = await env.getScript('process_data.casc');

    // Render it multiple times with different contexts
    const result1 = await compiledScript.render({ input: 'data1' });
    const result2 = await compiledScript.render({ input: 'data2' });
    ```

#### Extending the Engine

You can add custom, reusable logic to any environment.

*   `asyncEnvironment.addGlobal(name, value)`
    Adds a global variable or function that is accessible in all scripts and templates.

    ```javascript
    env.addGlobal('utils', {
      formatDate: (d) => d.toISOString(),
      API_VERSION: 'v3'
    });
    // In script: var formatted = utils.formatDate(now())
    ```

*   `asyncEnvironment.addFilter(name, func, [isAsync])`
    Adds a custom filter that can be used in both scripts and templates with the `|` operator.

*   `asyncEnvironment.addDataMethods(methods)`
    Extends the built-in `@data` handler with your own methods.

    ```javascript
    env.addDataMethods({
      // Called via @data.path.incrementBy(10)
      incrementBy: (target, amount) => (target || 0) + amount,
    });
    ```

*   `asyncEnvironment.addCommandHandlerClass(name, handlerClass)`
    Registers a **factory** for a custom output command handler. A new instance of `handlerClass` is created for each script run.

*   `asyncEnvironment.addCommandHandler(name, handlerInstance)`
    Registers a **singleton** instance of a custom output command handler. The same object is used across all script runs.

### Compiled Objects: `AsyncScript`

When you compile an asset, you get a reusable object that can be rendered efficiently multiple times.

#### `AsyncScript`

Represents a compiled Cascada Script.

*   `asyncScript.render([context])`
    Executes the compiled script with the given `context`, returning a `Promise` that resolves with the result (typically a data object).

#### `AsyncTemplate`

Represents a compiled Nunjucks Template.

*   `asyncTemplate.render([context])`
    Renders the compiled template, returning a `Promise` that resolves with the final string.

### Precompiling for Production

For maximum performance, you should precompile your scripts and templates into JavaScript ahead of time. This eliminates all parsing and compilation overhead at runtime, allowing your application to load assets instantly.

Cascada provides functions to precompile files or strings directly to JavaScript:

*   `precompileScript(path, [opts])`
*   `precompileTemplate(path, [opts])`

The resulting JavaScript string can be saved to a `.js` file and loaded in your application using the `PrecompiledLoader`. A key option is `opts.env`, which ensures that any custom filters, global functions, or command handlers you've added are correctly included in the compiled output.

**For a comprehensive guide on all precompilation options and advanced usage, please refer to the [Nunjucks precompiling documentation](https://mozilla.github.io/nunjucks/api.html#precompiling).**

## Development Status and Roadmap

Cascada is a new project and is evolving quickly! This is exciting, but it also means things are in flux. You might run into bugs, and the documentation might not always align perfectly with the released code. It could be behind, have gaps, or even describe features that are planned but not yet implemented  (these are marked as under development). I am working hard to improve everything and welcome your contributions and feedback.

This roadmap outlines key features and enhancements that are planned or currently in progress.


-   **Resilient Error Handling: An Error is Just Data**
    Tne error-handling construct designed for asynchronous workflows. This will allow for conditional retries and graceful failure management.

-   **Declaring Cross-Script Dependencies for (`import`, `include`, `extends`)**
    Support declaring variable dependencies wtih the `extern`, `reads`, and `modifies` keywords.

-   **Reading from the `@data` Object**
    Enabling the ability to read from the `@data` object on the right side of `@data` expressions (e.g., `@data.user.name = @data.form.firstName + ' ' + @data.form.lastName`). This will allow for more powerfull data composition.

-   **Expanded Sequential Execution (`!`) Support**
    Enhancing the `!` marker to work on variables and not just objects from the global context. This is especially important for macro arguments as macros don't have access to the context object.

-   **Direct Property Assignment on Variables**
    Adding support for direct property modification on variables (e.g., `myObject.property = "new value"`). This is currently possible only for `@data` assignments

-   **Compound Assignment for Variables (`+=`, `-=`, etc.)**
    Extending support for compound assignment operators (`+=`, `*=`, etc.) to regular variables (this is currently supported only for `@data` assignments). Like their `@data` counterparts, the default behavior of each operator will be overridable with custom methods.

-   **Root-Level Sequential Operator**
    Allowing the sequential execution operator `!` to be used directly on root-level function calls (e.g., `!.saveToDatabase(data)`), simplifying syntax for global functions with side effects.

-   **Expanded Built-in `@data` Methods**
    Adding comprehensive support for standard JavaScript array and string methods (e.g., `map`, `filter`, `slice`, `replace`) as first-class operations within the `@data` handler.

-   **Enhanced Error Reporting**
    Improving the debugging experience by providing detailed syntax and runtime error messages that include code snippets, file names, and line/column numbers to pinpoint issues quickly.

-   **Automated Dependency Declaration Tool**
    A command-line tool that analyzes modular scripts (import, include, extends) to infer cross-file variable dependencies. This tool will automatically add the required extern, reads, and modifies declarations to your script files.

-   **Execution Replay and Debugging**
    Creating an advanced logging system, via a dedicated output handler, to capture the entire execution trace. This will allow developers to replay and inspect the sequence of operations and variable states for complex debugging.

-   **OpenTelemetry and MLflow Integration for Observability**
    Implementing native support for tracing using the OpenTelemetry standard. This will capture the inputs and outputs of scripts and templates, as well as the arguments and return values of individual function calls. This integration is designed for high-level observability, enabling developers to monitor data flow, analyze performance, and track costs (e.g., token usage in LLM calls) with platforms like MLflow's tracing system. It focuses on key I/O points rather than a complete execution trace.

-   **Robustness and Concurrency Validation**
    Continuously expanding the test suite with a focus on complex, high-concurrency scenarios to formally verify the correctness and stability of the parallel.