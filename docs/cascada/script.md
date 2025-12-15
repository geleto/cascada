# Cascada Script Documentation

Cascada Script isn’t a language you’d use to build an application. It’s a specialized scripting layer your **TypeScript** or **JavaScript** code can invoke whenever you need to orchestrate and run many interdependent async tasks in parallel without the usual boilerplate. Use it as the backbone for your data layer to compose complex workflows, wiring together LLMs, APIs, databases, and external services in parallel with maximum I/O throughput, all while keeping the logic clean and readable.

## Write synchronous-style scripts that execute concurrently under the hood.
The core philosophy of Cascada is to let you write asynchronous code with the clarity of synchronous logic. You write your script as a straightforward, top-to-bottom set of instructions, and Cascada's engine handles the complex concurrent execution for you.

## Read First

**Articles:**

- [Cascada Script Introduction](https://geleto.github.io/posts/cascada-script-intro/) - An introduction to Cascada Script's syntax, features, and how it solves real async programming challenges

- [The Kitchen Chef's Guide to Concurrent Programming with Cascada](https://geleto.github.io/posts/cascada-kitchen-chef/) - Understand how Cascada works through a restaurant analogy - no technical jargon, just cooks, ingredients, and a brilliant manager who makes parallel execution feel as natural as following a recipe

**Learning by Example:**
- [Casai Examples Repository](https://github.com/geleto/casai-examples) - Explore practical examples showing how Cascada and Casai (an AI orchestration framework built on Cascada) turn complex agentic workflows into readable, linear code - no visual node graphs or async spaghetti, just clear logic that tells a story (work in progress)

## Overview

### ⚡ Parallel by default
Cascada Script is a scripting language for **JavaScript** and **TypeScript** applications, purpose-built for **effortless concurrency and asynchronous workflow orchestration**. It fundamentally inverts the traditional programming model: instead of being sequential by default, Cascada is **parallel by default**.

### 🚦 Data-Driven Flow: Code runs when its inputs are ready.
In Cascada, any independent operations - like API calls, LLM requests, and database queries - are automatically executed concurrently without requiring special constructs or even the `await` keyword. The engine intelligently analyzes your script's data dependencies, guaranteeing that **operations will wait for their required inputs** before executing. This orchestration **eliminates the possibility of race conditions** by design, ensuring correct execution order while maximizing performance for I/O-bound workflows.

### ✨ Implicit Concurrency: Write Business Logic, Not Async Plumbing.
Forget await. Forget .then(). Forget manually tracking which variables are promises and which are not. Cascada fundamentally changes how you interact with asynchronous operations by making them invisible.
This "just works" approach means that while any variable can be a promise under the hood, you can pass it into functions, use it in expressions, and assign it without ever thinking about its asynchronous state.

### ➡️ Implicitly Parallel, Explicitly Sequential
While this "parallel-first" approach is powerful, Cascada recognizes that order is critical for operations with side-effects. For these specific cases, such as writing to a database, interacting with a stateful API or making LLM request, you can use the simple `!` marker to **enforce a strict sequential order on a specific chain of operations, without affecting the parallelism of the rest of the script.**.

### 📋 Execution is chaotic, but the result is orderly
While independent operations run in parallel and may start and complete in any order, Cascada guarantees the final output is identical to what you'd get from sequential execution. This means all your data manipulations are applied predictably, ensuring your final texts, arrays and objects are assembled in the exact order written in your script.

This inversion - Implicitly Parallel, Explicitly Sequential - makes building complex, high-performance data pipelines feel surprisingly simple and intuitive.

### ☣️ Dataflow Poisoning - Errors that flow like data
Cascada replaces traditional try/catch exceptions with a data-centric error model called **dataflow poisoning**. If an operation fails, it produces an `Error Value` that propagates to any dependent operation, variable and output - ensuring corrupted data never silently produces incorrect results. For example, if fetchPosts() fails, any variable or output using its result also becomes an error - but critically, unrelated operations continue running unaffected. You can detect and repair these errors,  using `is error` checks, providing fallbacks and logging without derailing your entire workflow.

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

If the condition of an `if` statement evaluates to an error, both the `if` and `else` branches are skipped, and the error is propagated to any variables or outputs that would have been modified within them. For more details, see the main section on [Error Handling](#resilient-error-handling-an-error-is-just-data).

#### Loops
Cascada provides `for`, `while`, and `each` loops for iterating over collections and performing repeated actions, with powerful built-in support for asynchronous operations.

##### `for` Loops: Iterate Concurrently
Use a `for` loop to iterate over arrays, dictionaries (objects), async iterators, and other iterable data structures. In Cascada, the body of the `for` loop executes **in parallel for each item** in the collection by default. This is the most powerful looping construct for maximizing I/O throughput when performing independent asynchronous operations.

```javascript
// Each iteration runs concurrently, fetching user details in parallel
for userId in userIds
  var user = fetchUserDetails(userId)
  @data.users.push(user)
endfor
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
    var items = [{ title: "foo", id: 1 }, { title: "bar", id: 2 }];
    for item in items
      @data.posts.push({ id: item.id, title: item.title })
    endfor
    ```
*   **Objects/Dictionaries**:
    Iterates over keys and values. Note that concurrency limits (`of N`) are ignored for plain objects.
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
*   **Async Iterators**:
    Iterate seamlessly over async generators or streams. Cascada automatically handles waiting for items to be yielded.

    **Context Setup:**
    ```javascript
    const context = {
      // A simple async generator that yields numbers with a delay
      generateNumbers: async function* () {
        yield 1;
        await new Promise(r => setTimeout(r, 100));
        yield 2;
      }
    };
    ```

    **Script:**
    ```javascript
    for num in generateNumbers()
      @text("Received: " + num)
    endfor
    ```

**Automatic Sequential Fallback**
For safety, a `for` loop will automatically switch to **sequential execution** (waiting for one iteration to finish before starting the next) if you introduce dependencies between iterations. This happens if you:
1.  **Modify a shared variable** (e.g., `total = total + 1`).
2.  Use the **sequential execution operator (`!`)** on a function call inside the loop.

**The `else` block**
A `for` loop can have an `else` block that is executed only if the collection is empty:
```javascript
for item in []
  @text("This will not be printed.")
else
  @text("The collection was empty.")
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
For cases where you need to iterate over a collection but **preserve a strict sequential order**, use an `each` loop. It has the same syntax as a `for` loop but guarantees that each iteration completes before the next one begins.

```
each item in collection
  // Statements run sequentially for each item
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
Properties that require knowledge of the total collection size include:
*   `loop.length`: The total number of items in the sequence.
*   `loop.last`: `true` if this is the last iteration.
*   `loop.revindex`: The number of iterations until the end (1-indexed).
*   `loop.revindex0`: The number of iterations until the end (0-indexed).

Use the following guidelines to determine if these properties are available:

1.  **Arrays and Objects:**
    ✅ **Always Available.** Because the size of an array or object is known upfront, these properties are available regardless of whether the loop is running in parallel, sequentially, or with a concurrency limit.

2.  **Parallel Async Iterators:**
    ✅ **Available (Async).** When iterating over an async iterator in default parallel mode, Cascada resolves `loop.length` and `loop.last` only after the **iteration** (fetching all items) has finished.
    *Note:* This does **not** block the execution of the loop bodies—they will still run concurrently as items arrive—but expressions dependent on `loop.length` will wait until the end of the stream to evaluate.

3.  **Sequential or Constrained Async Iterators:**
    ❌ **Not Available.** When an async iterator is restricted—either by an explicit `each`, a concurrency limit (`of N`), or an [automatic sequential fallback](#automatic-sequential-fallback)—it behaves like a stream or a `while` loop. Cascada cannot see the end of the stream in advance, so `loop.length` and `loop.last` are undefined.

4.  **`while` Loops:**
    ❌ **Not Available.** Since a `while` loop runs until a condition changes, the total number of iterations is never known before all iterations are complete.

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

Cascada also provides a rich, data-centric error handling model. You can test if a variable contains a failure using the `is error` test. For more details, see the section on [Resilient Error Handling](#resilient-error-handling-an-error-is-just-data).

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

Instead of being executed immediately, `@` commands are stored in order and applied at the end of each **execution scope** (the main script, a [macro](#macros-and-reusable-components),or a [`capture` block](#block-assignment-with-capture)):

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

When an error is written to an output handler (e.g., `@data.user = myError`), the handler becomes "poisoned," which can cause the entire script to fail. To manage this, you can use `guard` blocks to automatically safeguard execution flow, or manually reset the handler using `_revert()`. For more information, see the sections on [Protecting State with `guard`](#protecting-state-with-guard) and [Manually Recovering Output Handlers](#manually-recovering-output-handlers-with-_revert).

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

**Array Operations**
These methods are used for array manipulation. Methods that are destructive (like `.pop()` or `.sort()`) modify the array in-place, while methods that return new values (like `.at()` or `.arraySlice()`) will replace the value at `path` with the result.
If the target path does not exist when a method is called, an empty array is created first.

| Command | Description |
|---|---|
| `@data.path.push(value)` | Appends an element to the array at `path`. |
| `@data.path.concat(value)` | Concatenates another array or value to the array at `path`. |
| `@data.path.pop()` | Removes the last element from the array at `path`. |
| `@data.path.shift()` | Removes the first element from the array at `path`. |
| `@data.path.unshift(value)`| Adds one or more elements to the beginning of the array at `path`. |
| `@data.path.reverse()` | Reverses the order of the elements in the array at `path` in-place. |
| `@data.path.at(index)` | Replaces the value at `path` with the element at the specified `index`. |
| `@data.path.sort()` | Sorts the array at `path` in-place. |
| `@data.path.sortWith(func)` | Sorts the array at `path` in-place using a custom comparison function. |
| `@data.path.arraySlice(start, [end])`| Replaces the array at `path` with a new array containing the extracted section. |

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
These methods perform common string transformations. The result of the operation replaces the original string value at `path`. If the target path does not exist when a method is called, an empty string is created first.

| Command | Description |
|---|---|
| `@data.path += value` | Appends a string to the target string. |
| `@data.path.append(value)`| Appends a string to the string value at `path`. |
| `@data.path.toUpperCase()` | Replaces the string at `path` with its uppercase version. |
| `@data.path.toLowerCase()` | Replaces the string at `path` with its lowercase version. |
| `@data.path.slice(start, [end])` | Replaces the string at `path` with the extracted section. |
| `@data.path.substring(start, [end])`| Replaces the string at `path` with the extracted section (no negative indices). |
| `@data.path.trim()` | Replaces the string at `path` with a version with whitespace removed from both ends. |
| `@data.path.trimStart()` | Replaces the string at `path` with a version with whitespace removed from the start. |
| `@data.path.trimEnd()` | Replaces the string at `path` with a version with whitespace removed from the end. |
| `@data.path.replace(find, replace)` | Replaces the string at `path` with a new string where the first occurrence of a substring is replaced. |
| `@data.path.replaceAll(find, replace)` | Replaces the string at `path` with a new string where all occurrences of a substring are replaced. |
| `@data.path.split([separator])` | Replaces the string at `path` with a new array of substrings. |
| `@data.path.charAt(index)` | Replaces the string at `path` with the character at the specified index. |
| `@data.path.repeat(count)` | Replaces the string at `path` with a new string repeated `count` times. |

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
    *   **Nature:** They are for data construction and sequential logic, not for controlling live async operations.

*   **`!` [Sequential Execution](#sequential-execution-control-):**
    *   **Purpose:** For **controlling the order of live, async operations** that have side effects (e.g., database writes).
    *   **Timing:** It forces one async call to wait for another to finish *during* the main script evaluation, ensuring operations run as early as possible.
    *   **Nature:** It manages the real-time execution flow of asynchronous functions, and their results are immediately available to the next line of code.

## Macros and Reusable Components

Macros allow you to define reusable chunks of logic that build and return structured data objects. They operate in a completely isolated scope and are the primary way to create modular, reusable components in Cascada Script.

Macros implicitly return the structured object built by the [Output Commands](#the-handler-system-using--output-commands) (`@data =`, `@data.push`, etc.) within their scope. An explicit `return` statement is not required, but if you include one, its value will override the implicitly built object.

### Defining and Calling a Macro

A macro can perform its own internal, parallel async operations and then assemble a return value.

If an Error Value is passed as an argument to a macro, the macro is skipped and immediately returns the error.

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

For details on how to handle errors within a sequential path, including how to "repair" a failed path so that subsequent operations can continue, see the section on [Repairing Sequential Paths with `!!`](#repairing-sequential-paths-with-).

#### Context Requirement for Sequential Paths

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

**Exception for macros:** When a macro uses `!` on a parameter, that argument must originate from the context when calling the macro:
```javascript
macro performWork(database)
  database!.insert(data)
endmacro

// ✅ CORRECT: Pass context object
performWork(db)  // 'db' is from context

// ❌ WRONG: Pass local variable
var myDb = db
performWork(myDb)
```

The engine uses object identity from the context to guarantee sequential ordering. Copying to local variables breaks this guarantee, which is why the restriction exists.

### Resilient Error Handling: An Error is Just Data

**Note**: This feature is under development.

Cascada's parallel-by-default execution creates a unique challenge: when multiple operations run concurrently and one fails, traditional exception-based error handling would need to interrupt the entire execution graph, halting all independent work. Also, there may already be code that executes after the try statement. Instead, Cascada treats **errors as just another type of data** that flows through your script. Failed operations produce a special **Error Value** that is stored in variables, passed to functions, and can be inspected.

This data-centric model allows independent operations to continue running while failures are isolated to only the variables and operations that depend on the failed result. When an operation in one part of your script fails, it has no effect on unrelated parallel operations—they continue executing, maximizing throughput and resilience.

#### Error Handling in Action

Here's a concrete example showing how error propagation works in parallel execution:

```javascript
// These three API calls run in parallel
var user = fetchUser(123)      // ✅ succeeds
var posts = fetchPosts(123)    // ❌ fails with network error
var comments = fetchComments() // ✅ succeeds

// Only operations depending on 'posts' are affected
@data.username = user.name           // ✅ works fine
@data.commentCount = comments.length // ✅ works fine
@data.postCount = posts.length       // ❌ becomes an error
@data.summary = posts + " analysis"  // ❌ becomes an error

// You can detect and repair the error
if posts is error
  @data.postCount = 0  // ✅ assign a fallback
  @data.summary = ''   // ✅ assign a fallback
endif
```

In this example, the failure of `fetchPosts()` only affects operations that depend on the `posts` variable. The `user` and `comments` operations complete successfully and their results are available immediately.

#### The Core Mechanism: Error Propagation

Once an Error Value is created, it automatically spreads to any dependent operation or variable—this process is known as **error propagation**, **dataflow poisoning**, or just **poisoning**. This ensures that corrupted data never silently produces incorrect results.

##### Data Operations

* **Expressions:**
  If any operand in an expression is an error, the entire expression evaluates to that error.

  ```javascript
  var total = myError + 5  // ❌ total becomes myError
  var result = 10 * myError / 2  // ❌ result becomes myError
  ```

* **Function Calls:**
  If an Error Value is passed as an argument, the function is skipped entirely and the call immediately returns that error without executing the function body.

  ```javascript
  var result = processData(myError)  // ❌ processData is never called
  var output = transform(validData, myError, moreData)  // ❌ skipped due to second arg
  ```

##### Control Flow

* **Loops:**
  A loop whose iterable is an Error Value will not execute its body. The error propagates to all variables and outputs that would have been affected by the loop.

  ```javascript
  for item in myErrorList
    // This entire block is skipped
    @data.items.push(item.name)
  endfor
  // ❌ @data is now poisoned
  ```

* **Conditionals:**
  If a conditional test evaluates to an Error Value, neither the `if` nor `else` branch executes. The error propagates to **all variables modified by either branch** and to **any output handlers** those branches write to.

  ```javascript
  if myErrorCondition
    result = "yes"
  else
    result = "no"
  endif
  // ❌ The 'result' variable is now an Error Value
  ```

##### Output & Effects

* **Output Handlers:**
  If an Error Value is written to an output handler (such as `@data` or `@text`), that handler becomes **poisoned**. This causes the **return value** of the current script, macro, or capture block to become an **Error Value** instead of normal output, which will reject the render promise. See [How Scripts Fail](#how-scripts-fail-from-error-values-to-rejected-promises) for details.

  ```javascript
  @data.user = myError  // ❌ Poisons the @data handler
  // The entire script will now fail and reject its promise
  ```

* **Sequential Side-Effect Paths:**
  If a call in a [sequential execution path](#sequential-execution-control-) (marked with `!`) fails, that path becomes **poisoned**. Any later operations using the same `!path` will instantly yield an Error Value without executing, preserving the sequential guarantee even in failure.

  ```javascript
  context.database!.connect()      // ❌ fails
  context.database!.insert(record) // ❌ skipped, returns error immediately
  context.database!.commit()       // ❌ skipped, returns error immediately
  ```

This mechanism ensures that once an operation fails, all dependent results and outputs reflect that failure, maintaining data integrity across both parallel and sequential execution flows.

#### Deciding When to Handle Errors

A key design decision in Cascada scripts is choosing where to handle errors versus letting them propagate.

**❌ Do not handle errors, let them propagate when:**
- The operation is critical to the final output (e.g., fetching the primary data for a report)
- You want the entire script to fail if this operation fails
- The error should bubble up to the calling JavaScript/TypeScript code
- There's no reasonable fallback or default value
- You're building a strict data pipeline where partial results are unacceptable

**✅ Handle errors locally when:**
- You have a sensible fallback or default value
- The operation is optional or non-critical to the final result
- You're implementing retry logic for transient failures
- You're aggregating results where partial success is acceptable
- You want to collect multiple errors for reporting without halting execution
- The error represents a business-logic case that should produce specific output (e.g., "user not found" → guest mode)

```javascript
// ❌ Critical operation - let it propagate and fail the script
var primaryData = fetchCriticalData()
@data.report = primaryData.summary  // Will fail if primaryData is an error

// ✅ Optional enhancement - handle locally
var recommendations = fetchRecommendations()
if recommendations is error
  // Not critical, use empty array as fallback
  recommendations = []
endif
@data.recommendations = recommendations  // Always succeeds
```

#### Detecting and Repairing Errors

The fundamental way to detect if a variable holds an Error Value is the `is error` test. Once a failure is detected, you can "repair" the situation by re-assigning the variable, which prevents the error from propagating further.

**Example: Assigning a Fallback Value**
```javascript
// fetchUser(999) is assumed to fail and return an Error Value
var user = fetchUser(999)

if user is error
  // The fetch failed. Log the error and repair the 'user' variable
  // by assigning a default user object.
  @data.log = "Failed to fetch user: " + user#message
  user = { name: "Guest", isDefault: true }
endif

// This next line can now execute without failing, because 'user' was repaired.
@data.username = user.name
```

**Example: Retrying a Failed Operation**
```javascript
var retries = 0
var user
var success = false

// Try to fetch the user up to 3 times
while retries < 3 and not success
  user = fetchUser(123) // This operation might fail transiently
  if user is not error
    success = true
  else
    retries = retries + 1
  endif
endwhile

// After the loop, check if the operation was ever successful
if user is error
  // All retries failed, assign a default value
  @data.log = "Fetching user failed after 3 retries."
  user = { name: "Guest", isDefault: true }
endif

@data.username = user.name
```

#### Repairing Sequential Paths with `!!`

When a sequential path becomes poisoned, all subsequent operations on that path immediately return errors without executing. The `!!` operator provides two ways to recover:

**Repair the Path:**
Use `!!` alone to clear the poison state, allowing subsequent operations to execute normally.

```javascript
context.db!.insert(data)  // ❌ Fails and poisons the path

context.db!!  // ✅ Repairs the path

context.db!.insert(otherData)  // ✅ Now executes
```

**Repair and Execute:**
Use `!!` before a method call to repair the path and then execute the method, even if the path was poisoned.

```javascript
context.db!.beginTransaction()
context.db!.insert(userData)      // ❌ Fails, poisons path
context.db!.insert(profileData)   // ❌ Skipped due to poison

// ✅ Repairs path and executes rollback
context.db!!.rollback()
```

This is particularly useful for cleanup operations that must run regardless of whether previous operations failed:

```javascript
var file = context.fileSystem!.open(path)

context.fileSystem!.writeHeader(metadata)
var writeResult = context.fileSystem!.writeData(data)  // ❌ Might fail

// ✅ Always close the file, even if writes failed
context.fileSystem!!.close()
```

**Checking Path State:**
You can check if a sequential path is poisoned using the `is error` test:

```javascript
context.api!.sendRequest(data)  // ❌ Might fail

if context.api! is error
  @data.error = context.api!#message  // Peek at the error
  context.api!!  // Repair the path
endif
```

#### Protecting State with `guard`

The `guard` block provides transaction-like safety for your script's logic. It takes a "snapshot" of your script's state—variables, output handlers, and execution locks—before running a block of code. If the code within the block results in unhandled **poisoning** (an active Error Value), Cascada rolls back all internal state changes and optionally passes control to a `recover` block.

This mechanism allows you to attempt complex, interdependent operations without worrying about leaving your data or variables in a corrupted or half-modified state.

**Syntax:**

```javascript
guard
  // Attempt risky operations here
  // Modifications to variables, outputs, and locks are tracked
recover(error)
  // Optional: Runs if the guard block is poisoned.
  // 'error' contains the compound PoisonError.
  // State is already rolled back to the start of the guard.
endguard
```

##### Automatic Rollback
If the `guard` block results in an error:

1.  **Variables:** Any variables modified or declared inside the block are reverted to their values at the start of the `guard`.
2.  **Output Handlers:** Any data written to handlers (like `@data` or `@text`) inside the block is discarded.
3.  **Sequence Locks:** If a sequential path (e.g., `db!`) was poisoned, the lock is "repaired" (unpoisoned), allowing you to use that path again immediately in the `recover` block.

**Important:** The rollback is only triggered by **unhandled** errors that poison the block. If you detect an error using `is error` and repair it (e.g., by assigning a fallback value) within the block, the `guard` considers the execution successful and commits the changes.

**Example: Protecting Data Integrity**

```javascript
var user = { name: "Guest", attempts: 0 }

guard
  // 1. Modify local state
  user.attempts = user.attempts + 1
  user.name = "Pending..."

  // 2. Write to output
  @text("Attempting login...")

  // 3. Risky operation
  var profile = fetchProfile(id) // ❌ Fails

  // If we don't handle 'profile', the block becomes poisoned.
  user.name = profile.name
recover(err)
  // STATE RESTORED:
  // 'user.name' is back to "Guest"
  // 'user.attempts' is back to 0
  // The "Attempting login..." text is removed from output

  @text("Login failed: " + err#message)
endguard
```

##### Handling External Side Effects
While `guard` can roll back the *internal* state of your script variables, it cannot undo external side effects that already happened (like an API call that was sent). However, because `guard` automatically repairs sequential execution locks (`!`), you can easily trigger compensatory actions (like a database rollback) in the `recover` block.

```javascript
// Start a transaction
context.db!.beginTransaction()

guard
  // If this fails, the 'db!' sequence becomes poisoned
  context.db!.insert(riskyData)
recover(err)
  // The 'db!' lock is automatically repaired here,
  // allowing us to run the rollback command safely.
  context.db!.rollback()

  @data.error = "Transaction cancelled"
endguard
```

##### The `recover` Block
The `recover` clause is optional. It accepts a single argument (e.g., `recover(err)`), which is a `PoisonError` containing all errors that contributed to the failure.

*   **With `recover`**: You can handle the error, log it, or set fallback values.
*   **Without `recover`**: The `guard` block acts as a silent safety net. If an unhandled error occurs, the state rolls back, the error is swallowed, and execution continues immediately after the `endguard` statement.

```javascript
// Silent failure pattern
guard
  @data.widgets = fetchWidgets() // If this fails...
endguard

// ...execution continues here with @data.widgets untouched (undefined)
```

#### Manually Recovering Output Handlers with `_revert()`

While `guard` provides automatic protection for a block of code, you may sometimes need manual control to "fix" an output handler that has become poisoned within the current flow. Unlike variables (which can be reassigned) or sequential locks (which can be repaired with `!!`), output handlers accumulate changes, so they require a specific reset mechanism.

Calling `@handler._revert()` resets that handler to the state it was in at the beginning of the **current output scope**. This discards all writes (successful or failed) made within that scope and removes the poison status.

**Output Scopes**
The "checkpoint" that `_revert()` restores to is the start of the nearest enclosing:
1.  `guard` block
2.  `capture` block
3.  `macro` definition
4.  The Script root (if none of the above apply)

**Usage**
*   **Supported Handlers:** Works on `@data`, `@text`, and any custom handlers.
*   **Root Only:** You must call this on the handler itself (e.g., `@data._revert()`), not on a specific path.

**Example: Resetting `@data` on failure**

```javascript
// 1. Write some initial data
@data.timestamp = now()

// 2. This operation fails and poisons the @data handler
@data.content = fetchContent()

// 3. Check if the handler is poisoned
if @data is error
  // 4. Revert @data to the start of the script/scope
  // This removes 'timestamp' AND the error from 'fetchContent'
  @data._revert()

  // 5. Write a clean fallback response
  @data.error = "Content unavailable"
endif
```

**Example: Resetting `@text` inside a `capture` block**

```javascript
var message = capture :text
  @text("Starting operation...")
  var result = riskyOperation()

  if result is error
     // Reverts only to the start of this capture block
     @text._revert()
     @text("Operation failed.")
  else
     @text(" Success!")
  endif
endcapture
```

#### Peeking Inside Errors with `#`

Because of error propagation, a standard property access like `myError.message` would just return `myError` again. To inspect the properties of an Error Value itself, use the special **`#` (peek) operator**. This operator "reaches through" the error to access its internal properties without triggering propagation.

```javascript
var failedUser = fetchUser(999)

if failedUser is error
  // Use '#' to access properties of the Error Value
  @text("Operation failed!")
  @text("Origin: " + failedUser#source.origin)
  @text("Message: " + failedUser#message)
endif
```

**Important**: Peeking at a non-poisoned path or handler returns a poison value. Always check with `is error` before peeking:

```javascript
context.db!.insert(data)  // ✅ Succeeds

// ❌ WRONG: Peeking at non-poisoned path returns poison
var msg = context.db!#message

// ✅ CORRECT: Check first, then peek
if context.db! is error
  var msg = context.db!#message  // Safe
endif
```

The same applies to output handlers:

```javascript
@data.value = 42  // ✅ Success

// ❌ WRONG: Returns poison
var msg = @data#message

// ✅ CORRECT: Check first
if @data is error
  var msg = @data#message
endif
```

#### Anatomy of an Error Value

An Error Value is a rich object designed for easy debugging, containing detailed information about what went wrong and where. You can read it by using the peek operator (`#`).

*   **`errors`**: (array) A list of one or more underlying error objects that contributed to this failure. Each object provides detailed context about a specific failure:
    *   **`message`**: (string) The specific error message for this particular failure.
    *   **`name`**: (string) A custom name for business-logic errors (e.g., `'ValidationError'`, `'NotFoundError'`).
    *   **`lineno`**: (number) The line number in the source file where the error occurred.
    *   **`colno`**: (number) The column number on the line where the error occurred.
    *   **`path`**: (string) The name of the script or template file where the error originated.
    *   **`operation`**: (string) A technical description of the internal operation the engine was performing when the error occurred. Examples include `FunCall` (function call), `LookupVal` (property access like `user.name`), `Add` (a `+` operation), or `Output(FunCall)` (an error while rendering the output of a function call).
    *   **`cause`**: (object | null) If the error originated from the JavaScript environment (e.g., from a native function or an external library), this property holds the original JavaScript `Error` object, providing access to the original stack trace and error details.
*   **`message`**: (string) A summary message that combines the messages from all the individual errors contained in the `errors` array.

#### Handling Multiple Concurrent Errors

When multiple operations fail concurrently, their errors are collected into a single `PoisonError` that holds all the original, individual errors. This ensures that no error is lost and you get a complete picture of all failures.

**Example: Multiple Concurrent Failures**

```javascript
// Three parallel operations that all fail
var user = fetchUser(999)        // ❌ fails: "User not found"
var profile = fetchProfile(999)  // ❌ fails: "Profile service unavailable"
var settings = fetchSettings(999) // ❌ fails: "Settings database timeout"

// Using all three creates a PoisonError containing all failures
var summary = user.name + " - " + profile.bio + " - " + settings.theme

if summary is error
  // summary#errors is an array with all three original errors
  @data.errorCount = summary#errors | length  // 3

  // Iterate through all the failures
  for err in summary#errors
    @data.errorLog.push({
      message: err#message,
      source: err#source.origin
    })
  endfor

  summary = "User data unavailable"
endif

@data.userSummary = summary
```

This aggregation is particularly valuable in error reporting and debugging, as you can see all failures that occurred in a parallel batch rather than just the first one encountered.


#### Error Handling with Sequential Operations

When using [sequential execution paths](#sequential-execution-control-) marked with `!`, error handling follows the same principles but respects the sequential guarantee:

```javascript
var db = context.db

db!.beginTransaction()

// These operations run sequentially
var insertResult = db!.insert("users", userData)
var updateResult = db!.update("profiles", profileData)

// Check if any operation failed
if db! is error
  // Path is poisoned, cleanup
  db!!.rollback()

  @data.status = "transaction_failed"
  @data.error = db!#message
else
  db!.commit()
  @data.status = "success"
endif
```

The key difference is that in a sequential chain, if any operation fails, all subsequent operations on that path are immediately skipped and return errors, maintaining the sequential guarantee even in failure scenarios.

#### How Scripts Fail: From Error Values to Rejected Promises

An important distinction in Cascada's error model: **an error is treated as data *within* the script**. A script only fails and rejects its render promise when an unhandled Error Value reaches and "poisons" a final output handler (like `@data` or `@text`).

**Internal Error Handling:**
If you handle all errors internally using `is error` tests and repair them by assigning normal values, the script completes successfully even though errors occurred during execution:

```javascript
var user = fetchUser(999)  // ❌ Returns an error

if user is error
  user = { name: "Guest" }  // ✅ Repaired - no longer an error
endif

@data.username = user.name  // ✅ Script succeeds, outputs: { username: "Guest" }
```

**Script Failure:**
When an Error Value reaches an output command without being handled, the promise rejects with an Error Value, see the [Anatomy of an Error Value](#anatomy-of-an-error-value) section:

```javascript
var user = fetchUser(999)  // ❌ Returns an error
@data.user = user  // ❌ Unhandled error reaches output - script fails
```

In your JavaScript/TypeScript code, you can catch and inspect this detailed error:

```javascript
try {
  const result = await env.renderScript('getUserData.casc', { userId: 999 });
} catch (err) {
  // err is a PoisonError with rich diagnostic information
  console.log(err.message);  // Summary of all failures

  // Inspect individual errors for detailed diagnostics
  err.errors.forEach(error => {
    console.log(`Error at ${error.path}:${error.lineno}:${error.colno}`);
    console.log(`Operation: ${error.operation}`);
    console.log(`Message: ${error.message}`);
    if (error.cause) {
      console.log('Original JS error:', error.cause);
    }
  });
}
```

This boundary between internal error handling (Error Values as data) and external error reporting (rejected promises) gives you precise control over when failures should propagate to your application code versus being handled gracefully within the script.

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
    | `isRelative(name)`

## Differences from classic Nunjucks

- **Async templates & Cascada Script:** `if`, `for`/`each`/`while`, and `switch` branches run in their own scope, so `set`/`var` stay local unless you intentionally write to an outer variable. This avoids race conditions and keeps loops parallel.
- **Sync templates (`asyncMode: false`):** No scope isolation—control-flow blocks share the parent frame exactly like Nunjucks.

So: async builds get safer block-local semantics; fully synchronous templates keep the legacy behavior.
