# Cascada Script Documentation

## Write scripts that look synchronous but execute concurrently under the hood.

## Overview

Cascada Script is a scripting language built on top of the Cascada templating engine, designed for orchestrating asynchronous workflows and data processing tasks. Unlike traditional templating, which focuses on generating text output, Cascada Script prioritizes logic flow, task coordination, and data assembly.

## Table of Contents
- [Overview](#overview)
- [Key Features](#key-features)
- [Executing a Script](#executing-a-script)
- [Core Syntax and Expressions](#core-syntax-and-expressions)
- [Macros and Reusable Components](#macros-and-reusable-components)
- [Advanced Flow Control](#advanced-flow-control)
- [API Reference](#api-reference)

## Key Features

- **Automatic Parallelization**: Independent operations run concurrently with no extra effort
- **Seamless Async Handling**: Work with promises, async functions, and async iterators naturally
- **Data Assembly**: Build complex data structures with specialized [output commands](#the-handler-system-using--output-commands).
- **Smart Dependency Management**: While independent operations run in parallel, Cascada ensures that **dependent operations wait for their prerequisites**. This guarantees correct execution order, giving you the performance of parallelism with the predictability of sequential code.
- **Controlled Sequential Execution**: Use the [`!` marker](#sequential-execution-control-) to enforce a strict execution order for operations with side effects (like database writes) without sacrificing overall parallelism.
- **Separation of Logic and Presentation**: Promotes a clear separation of logic from presentation—use scripts for coordinating tasks and handling data, and templates for generating text output.

## Executing a Script

Here's an example of executing a script that defines and uses a [macro](#macros-and-reusable-components) to build a structured data object.

```javascript
const { AsyncEnvironment } = require('cascada-tmpl');
const env = new AsyncEnvironment();

const script = `
// The '[:data](#focusing-the-output-data-text-handlername)' directive focuses the macro's output
macro fetchAndEnhanceUser(id) : data
  var userData = fetchUser(id)
  @data.set(user.id, userData.id)
  @data.set(user.name, userData.name)
  @data.push(user.tasks, "Review code")
endmacro

// Each macro call runs in parallel
var user1 = fetchAndEnhanceUser(1)
var user2 = fetchAndEnhanceUser(2)

// Assemble the final result using the macro outputs
@data.set(result.user1, user1.user)
@data.set(result.user2, user2.user)
`;

const context = {
  fetchUser: async (id) => {
    const users = {
      1: { id: 1, name: "Alice" },
      2: { id: 2, name: "Bob" },
    };
    return users[id] || null;
  }
};

// Execute the script
// We will focus the script's output later to get this clean result.
const result = await env.renderScriptString(script, context);
console.log(JSON.stringify(result.data, null, 2)); // Focusing on the .data property for clarity
// Output:
// {
//   "result": {
//     "user1": {
//       "id": 1,
//       "name": "Alice",
//       "tasks": [ "Review code" ]
//     },
//     "user2": {
//       "id": 2,
//       "name": "Bob",
//       "tasks": [ "Review code" ]
//     }
//   }
// }
```

## Core Syntax and Expressions

Cascada Script removes the visual noise of template syntax while preserving Cascada's powerful capabilities.

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
Use `extern` to declare a variable that is expected to be provided by an including script (via `import-script`), not from the global context. External variables cannot be initialized at declaration.

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
  @data.set(id, rawUserData.id)
  @data.set(username, rawUserData.name | title) // Use a filter for formatting
  @data.set(status, "active" if rawUserData.isActive == 1 else "inactive")
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
```
for item in collection
  // statements
endfor
```
A `for` loop can have an `else` block that is executed only if the collection is empty:
```
for item in []
  print "This will not be printed."
else
  print "The collection was empty."
endfor
```
Inside a loop, you have access to the special `loop` variable:
*   `loop.index`: The current iteration (1-indexed).
*   `loop.index0`: The current iteration (0-indexed).
*   `loop.first`: `true` if this is the first iteration.
*   `loop.last`: `true` if this is the last iteration.
*   `loop.length`: The total number of items in the sequence.

```javascript
for item in ["apple", "banana", "cherry"]
  print loop.index + "/" + loop.length + ": " + item
endfor
```

#### Output
```
print expression
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
  print "Valid email address."
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
// The [:data](#focusing-the-output-data-text-handlername) directive focuses the output to get just the data.
:data

var userId = 123
var userProfile = { name: "Alice", email: "alice@example.com" }
var userSettings = { notifications: true, theme: "light" }

// @data.set: Sets or creates a value at a path
@data.set(user.id, userId)
@data.set(user.name, userProfile.name)

// @data.push: Adds an item to an array
@data.push(user.roles, "editor")
@data.push(user.roles, "viewer")

// @data.merge: Combines properties into an object
@data.merge(user.settings, userSettings)
@data.set(user.settings.theme, "dark") // Overwrite one setting
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

Instead of being executed immediately, `@` commands are handled in a three-step process:

1.  **Collect:** As your script, macro, or `capture` block runs, Cascada collects `@` commands and places them into a buffer, preserving their source-code order.
2.  **Execute:** All other logic—like `var` assignments, `async` function calls, and `for` loops—runs to completion. Independent async operations happen concurrently, maximizing performance.
3.  **Assemble:** Once all data-fetching and logic in the current scope has finished, Cascada dispatches the buffered `@` commands **sequentially** to their corresponding handlers. Each handler is responsible for executing its commands and building its internal state.

#### Output Handlers: `@data`, `@text`, and Custom Logic

Every `@` command is directed to an **output handler**. The handler determines what action is performed. Cascada provides two built-in handlers and allows you to [define your own for custom logic](#creating-custom-output-command-handlers).

*   **`@data`**: The built-in handler for building structured data (objects and arrays).
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
@data.set(report.title, "Q3 Summary")
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

@data.set(report.title, "Q3 Summary")
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
The `@data` handler is the primary tool for constructing your script's `data` object. Paths are provided as the first argument and can be complex expressions.

| Command | Description |
|---|---|
| `@data.set(path, value)` | **Replaces** the value at `path`. Creates objects/arrays as needed. |
| `@data.push(path, value)` | Appends an element to an array at `path`. |
| `@data.append(path, value)`| Appends a string to the string value at `path`. |
| `@data.merge(path, value)` | Merges an object into the object at `path`. |
| `@data.deepMerge(path, value)`| Deep-merges an object into the object at `path`. |
| `@data.pop(path)` | Removes the last element from the array at `path`. |
| `@data.shift(path)` | Removes the first element from the array at `path`. |
| `@data.unshift(path, value)`| Adds one or more elements to the beginning of the array at `path`. |
| `@data.reverse(path)` | Reverses the order of the elements in the array at `path`. |

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
      @data.set(report.users[user.id].status, "processed")
    endfor
    ```
*   **Root-Level Modification**: Use `null` as the path to modify the root of the `data` object itself.
    ```javascript
    // Replaces the entire data object with a new one
    @data.set(null, { status: "complete", timestamp: now() })

    // Merges properties into the root data object
    @data.merge(null, { version: "2.1" })
    ```
*   **Array Index Targeting**: Target specific array indices with square brackets. The empty bracket notation `[]` always refers to the last item added in the script's sequential order, **not** the most recently pushed item in terms of operation completion. Due to implicit concurrency, the order of completion can vary, but Cascada Script ensures consistency by following the script's logical sequence.
    ```javascript
    // Target a specific index
    @data.push(users[0].permissions, "read")

    // Target the last item added in the script's sequence
    @data.push(users, { name: "Charlie" })
    // The path 'users[]' now refers to Charlie's object
    @data.push(users[].permissions, "read") // Affects "Charlie"
    ```

#### Output Command Scopes: Controlling Assembly Timing

The "Assemble" step happens at the end of a **scope**. This is key to building modular, reusable code.

##### 1. Main Script Body
Commands in the main script body are assembled **last**, building the **final return value** of the entire script.

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
  @data.push(company.employees, {
    id: details.id,
    name: details.name
  })
endfor
```
</details>
</td>
<td width="50%" valign="top">
<details open>
<summary><strong>Final Return Value</strong></summary>

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

##### 2. Macro Body (`macro ... endmacro`) and `caller` block
Commands inside a `macro` are assembled when the **macro call completes**. They build a result object that becomes the immediate **return value** of that macro. This lets you create reusable components that perform their own internal, parallel async operations.

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
  @data.set(department.manager, manager.name)
  @data.set(department.teamSize, team.length)
endmacro

// Call the macro. 'salesDept' becomes the data object.
var salesDept = buildDepartment("sales")

// Use the returned object in the main script's assembly.
@data.set(company.sales, salesDept)
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

#### Extending Output Commands

##### Customizing the `@data` Handler
You can add your own custom methods to the built-in `@data` handler using `env.addDataMethods()`. This is a powerful way to create reusable, domain-specific logic that operates on your script's `data` object.

**Example: A custom `@data.upsert` command.**
```javascript
// --- In your JavaScript setup ---
env.addDataMethods({
  upsert: (target, data) => {
    if (!Array.isArray(target)) return;
    const index = target.findIndex(item => item.id === data.id);
    if (index > -1) Object.assign(target[index], data);
    else target.push(data);
  }
});

// --- In your Cascada Script ---
@data.push(users, {id: 1, name: "Alice"})
// This custom command will UPDATE Alice instead of adding a new entry
@data.upsert(users, {id: 1, status: "inactive"})
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

Macros implicitly return the structured object built by the [Output Commands](#the-handler-system-using--output-commands) (`@data.set`, `@data.push`, etc.) within their scope. An explicit `return` statement is not required, but if you include one, its value will override the implicitly built object.

### Defining and Calling a Macro

```javascript
// Define a macro to build a user object
macro buildUser(id) : data // [:data](#focusing-the-output-data-text-handlername) focuses the return value
  var userData = fetchUserData(id)
  // These '[@data.set](#the-handler-system-using--output-commands)' commands operate on the macro's return object
  @data.set(user.id, userData.id)
  @data.set(user.name, userData.name)
endmacro

// Calling the macro
// The macro returns { user: { id: ..., name: ... } }
var myUser = buildUser(123)
@data.set(result.user, myUser.user)
```

### Keyword Arguments
Macros support keyword arguments, allowing for more explicit and flexible calls. You can define default values for arguments, and callers can pass arguments by name.

```javascript
// Macro with default arguments
macro input(name, value="", type="text") : data
  @data.set(field.name, name)
  @data.set(field.value, value)
  @data.set(field.type, type)
endmacro

// Calling with mixed and keyword arguments
var passwordField = input("pass", type="password")
@data.set(result.password, passwordField.field)
```

### Output Scopes and Focusing in Macros

Commands inside a `macro` are assembled when the **macro call completes**. They build a structured object that becomes the immediate **return value** of that macro. To get a clean data object instead of the full result object, use an [output focus directive](#focusing-the-output-data-text-handlername).

<table>
<tr>
<td width="50%" valign="top">
<details open>
<summary><strong>Macro with <code>:data</code> focus</strong></summary>

```javascript
// The :data directive filters the macro's
// return value to be just the data object.
macro buildUser(name) : data
  @data.set(user.name, name)
  @data.set(user.active, true)
endmacro

// 'userObject' is now a clean object,
// not { data: { user: ... } }.
var userObject = buildUser("Alice")

@data.set(company.manager, userObject.user)
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

### The `call` Block
The call block from Nunjucks, used for passing content to macros for text output, is not implemented in Cascada Script. Its functionality is covered by [`capture` blocks](#block-assignment-with-capture) and macro calls, aligning with Cascada's data-driven focus while simplifying the language.

## Advanced Flow Control

### Looping over Async Iterators
Loops can iterate seamlessly over **async iterators**. First, you would provide the async iterator function in your context object:
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
Then, use it in your script:
```javascript
// The loop waits for each comment to resolve
// before processing the body.
for comment in fetchComments(postId)
  print comment.author + ": " + comment.body
endfor
```

### Sequential Execution Control (`!`)

**Note**: This feature is under development.

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

### Resilient Error Handling (`try`/`resume`/`except`)

**Note**: This feature is under development.

Handle runtime errors gracefully with **`try`/`resume`/`except`**. This structure lets you catch errors, define **conditional retry logic** with `resume`, and provide a final fallback. The special `resume.count` variable is **automatically managed by the engine** to track retry attempts.

```javascript
try
  // Attempt a fallible operation
  var image = generateImage(prompt)
  @data.set(result.imageUrl, image.url)
resume resume.count < 3
  // Retry up to 3 times
  print "Retrying attempt " + resume.count
except
  // Handle permanent failure
  @data.set(result.error, "Image generation failed: " + error.message)
endtry
```

### Filters and Global Functions

Cascada Script supports the full range of Nunjucks [built-in filters](https://mozilla.github.io/nunjucks/templating.html#builtin-filters) and [global functions](https://mozilla.github.io/nunjucks/templating.html#global-functions). You can use them just as you would in a template.

#### Filters
Filters are applied with the pipe `|` operator.
```javascript
var title = "a tale of two cities" | title
print title // "A Tale Of Two Cities"

var users = ["Alice", "Bob"]
print "Users: " + (users | join(", ")) // "Users: Alice, Bob"
```

#### Global Functions
Global functions like `range` can be called directly.
```javascript
for i in range(3)
  print "Item " + i // Prints Item 0, Item 1, Item 2
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
print output // "rock, pop, jazz"
```

### Importing Scripts and Templates

In Cascada scripts, use `import` to access standard Nunjucks templates:

```
import "header.njk" as header
```

Use `import-script` to load other Cascada scripts. This can be done with the clean script syntax or the traditional tag syntax.

```
// Clean syntax
import-script "data.script" as data

// Tag-based syntax
{% import-script "data.script" as data %}
```

## API Reference

### Environment Class

```javascript
environment.renderScript(scriptName, context[, callback])
environment.renderScriptString(scriptSource, context[, options][, callback])
```

### AsyncEnvironment Class

```javascript
// Always returns Promises
asyncEnvironment.renderScript(scriptName, context[, options])
asyncEnvironment.renderScriptString(scriptSource, context[, options])
```

For production environments, you can improve performance by **precompiling** your scripts to JavaScript, which eliminates parsing overhead at runtime. This can be done using the same precompilation API methods available for templates.