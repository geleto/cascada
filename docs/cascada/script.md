# Cascada Script Documentation

## Overview

Cascada Script is a scripting language built on top of the Cascada templating engine, designed for orchestrating asynchronous workflows and data processing tasks. Unlike traditional templating, which focuses on generating text output, Cascada Script prioritizes logic flow, task coordination, and data assembly.

## Table of Contents
- [Overview](#overview)
- [Key Features](#key-features)
- [Core Syntax Features](#core-syntax-features)
- [Expressions](#expressions)
- [Sequential Execution Control (`!`)](#sequential-execution-control-)
- [Output Commands (`@`)](#output-commands-)
- [Macros](#macros)
- [Resilient Error Handling (`try`/`resume`/`except`)](#resilient-error-handling-tryresumeexcept)
- [Filters and Global Functions](#filters-and-global-functions)
- [Importing Templates](#importing-templates)
- [API Methods](#api-methods)
- [Return Values](#return-values)
- [Executing a Script](#executing-a-script)

### Key Features

- **Clean Syntax**: No template delimiters (`{% %}` or `{{ }}`) cluttering your code
- **Automatic Parallelization**: Independent operations run concurrently with no extra effort
- **Seamless Async Handling**: Work with promises, async functions, and async iterators naturally
- **Data Assembly**: Build complex data structures with specialized commands
- **Smart Dependency Management**: While independent operations run in parallel, Cascada ensures that **dependent operations wait for their prerequisites**. This guarantees correct execution order, giving you the performance of parallelism with the predictability of sequential code.
- **Macros**: Reusable code blocks for building independent data objects

## Core Syntax Features

Cascada Script removes the visual noise of template syntax while preserving Cascada's powerful capabilities:

- **No Tag Delimiters**: Write `if condition` instead of `{% if condition %}`
- **Multiline Expressions**: Expressions can span multiple lines for readability. The system automatically detects continuation based on syntax (e.g., unclosed operators, brackets, or parentheses). For example:
  ```
  set result = 5 + 10 *
    20 - 3
  ```
- **Standard Comments**: Use JavaScript-style comments (`//` and `/* */`)
- **Implicit `do` Statements**: Any standalone line that isn’t a recognized command (e.g., `set`, `if`, `for`, `put`) or tag is treated as an expression and implicitly wrapped in a `do` statement. For example:
  ```
  items.push("value")  // Implicitly a "do" statement
  ```
- **Macros**: Define reusable blocks of code with `macro`

### Basic Statements

#### Variable Assignment
```
set variableName = expression
```

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
Loops can also iterate seamlessly over **async iterators**. First, you would provide the async iterator function in your context object:
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

## Expressions

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
set price = (item.cost + shipping) * 1.05
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
set theme = "dark" if user.darkMode else "light"
```

#### Regular Expressions
You can create regular expressions by prefixing the expression with `r`.

```javascript
set emailRegex = r/^[^\s@]+@[^\s@]+\.[^\s@]+$/
if emailRegex.test(user.email)
  print "Valid email address."
endif
```

## Sequential Execution Control (`!`)

**Note**: This feature is under development.

For functions with **side effects** (e.g., database writes), the `!` marker enforces a **sequential execution order** for a specific object path. Once a path is marked, *all* subsequent method calls on that path (even those without a `!`) will wait for the preceding operation to complete, while other independent operations continue to run in parallel.

```javascript
// The `!` on deposit() creates a
// sequence for the 'account' path.
set account = getBankAccount()

//1. Set initial Deposit:
account!.deposit(100)
//2. Get updated status after initial deposit:
account.getStatus()
//3. Withdraw money after getStatus()
account!.withdraw(50)
```

## Output Commands (`@`)

Cascada Script features a powerful system for operations that are guaranteed to execute in a strict sequential order. These **Output Commands**, marked with the `@` sigil, are your primary tool for building the script's final return value.

All `@` commands are assembled during script execution and run sequentially *after* all other template logic (including async operations) has completed. This provides a highly efficient way to construct complex, structured results.

**Important Distinction:** Output Commands are different from the `!` marker for sequential execution.
*   **Output Commands (`@`)**: Fast, non-async, and executed *after* the script or macro finishes. They are designed exclusively for building a return value. Although the methods are not async - you can use buffering and process them asynchronously.
*   **Sequential Execution (`!`)**: Slower, can be `async`, executes *during* the script run and the result can be used in the script. They are for controlling the order of operations with side effects.

### Command Syntax

Output Commands support two distinct syntaxes, depending on the task.

#### Statement-Style Syntax
This syntax (`@command path value`) is used for path-based data manipulation. It offers a clean, declarative feel.

```javascript
// Set a value at a path
@put user.settings.theme 'dark'

// Push an element into an array
@push user.roles 'editor'
```

#### Function-Style Syntax
This syntax (`@command(arg1, arg2, ...)`) is used for imperative actions and can take multiple complex expressions as arguments. It is required for all commands on named handlers.

```javascript
// Call a command on a named handler
@turtle.forward(50)

// Call a custom command with multiple arguments
@log('User updated', user.id, { level: 'INFO' })
```

### The Built-in Data Object

By default, Cascada provides a built-in data object and a rich set of commands to modify it. This is the simplest way to produce a structured result.

#### Standard Output Data Assembly Methods

These statement-style commands manipulate the script's data object.

| Command | Description |
|---|---|
| `@put path value` | **Replaces** the value at `path`. |
| `@push path value` | Appends an element to an array at `path`. |
| `@merge path value` | Merges an object into the object at `path`. |
| `@pop path` | Removes and returns the last element from the array at `path`. |
| `@shift path` | Removes and returns the first element from the array at `path`. |
| `@unshift path value`| Adds one or more elements to the beginning of the array at `path`. |
| `@reverse path` | Reverses the order of the elements in the array at `path`. |

#### The `@print` Command
The `@print` command is a versatile tool for generating text output. Its behavior depends on whether a path is provided.

*   **`@print path value`**: **Appends** the `value` to the content at `path`. If the existing content is a string, it concatenates.
    ```javascript
    @put user.log "Login successful. "
    @print user.log "Session extended."
    // user.log is now "Login successful. Session extended."
    ```
*   **`@print value`** (no path): Appends to the global text output stream, similar to how `{{ value }}` works in a template.
    ```javascript
    @print "Request received at " + timestamp
    ```

#### Array Index Targeting

Target specific array indices with square brackets. The empty bracket notation `[]` always refers to the last item added in the script's sequential order, **not** the most recently pushed item in terms of operation completion. Due to implicit concurrency, the order of completion can vary, but Cascada Script ensures consistency by following the script's logical sequence.

```
// Target specific index
push users[0].permissions "read"

// Target the last item added in the script's sequence
push users { name: "Charlie" }
push users[].permissions "read"  // Always affects "Charlie", not a randomly completed item
```

#### Customizing the Data Object
You can add your own custom methods to the default data builder using `env.addDataMethods()`.

**Example: A custom `@upsert` command.**
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
@push users {id: 1, name: "Alice"}
// This custom command will UPDATE Alice
@upsert users {id: 1, status: "inactive"}
```

### Output Command Handlers
For advanced use cases that go beyond simple data construction, you can define **Output Command Handlers**. These are classes that receive and process `@` commands, allowing you to create powerful domain-specific logic within your scripts.

#### Registering and Using Named Handlers
You register all handlers with a unique name using `addCommandHandlerClass`. To use a named handler, prefix the command with the handler's name and a dot.

**Example: Using a `turtle` handler.**
```javascript
// --- In your JavaScript setup ---
env.addCommandHandlerClass('turtle', CanvasTurtle);

// --- In your Cascada Script ---
// These commands are dispatched to the 'turtle' handler
@turtle.begin()
@turtle.forward(50)
@turtle.stroke('cyan')
```

#### The `@default` Directive

To simplify scripts that primarily use one command handler, you can declare a default handler for the entire script. Any unqualified command (e.g., `@fetchOrder()`) will automatically be routed to this default handler.

**Syntax:** `@default 'handlerName'`

Place it at the top of the script file, the name must be a static string like `'db'`, not a variable.

**Example:**

<table>
<tr>
<td width="50%" valign="top">

**Without <code>@default</code>**
```javascript
// All commands must be fully qualified.
set order = @db.fetchOrder(123)
@db.updateStatus(order.id)

// Other handlers are qualified.
@log.info("Updated")
```
</td>
<td width="50%" valign="top">

**With <code>@default</code>**
```javascript
@default 'db'

// Unqualified commands now use the 'db' handler.
set order = @fetchOrder(123)
@updateStatus(order.id)

// Qualified calls still work.
@log.info("Updated")
```
</td>
</tr>
</table>

#### Handler Implementation Patterns
Cascada supports two powerful patterns for how your handler classes are instantiated and used.

**Pattern 1: The Factory (Clean Slate per Render)**
Provide a **class** with `addCommandHandlerClass(name, handlerClass)`. For each render, the engine creates a new, clean instance, passing the `context` to its `constructor`. This is the recommended pattern for most use cases.

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

// --- In your JavaScript setup (API Usage) ---
env.addCommandHandlerClass('turtle', CanvasTurtle);
```

**Pattern 2: The Singleton (Persistent State)**
Provide a pre-built **instance** with `addCommandHandler(name, handlerInstance)`. The same instance is used across all render calls, which is useful for accumulating state (e.g., logging). If the handler has an `_init(context)` method, the engine will call it before each run.

```javascript
// --- In your JavaScript setup (Handler Class) ---
class CommandLogger {
  constructor() { this.log = []; }
  // This hook is called before each script run
  _init(context) { this.log.push(`--- START (User: ${context.userId}) ---`); }
  _call(command, ...args) { this.log.push(`${command}: ${JSON.stringify(args)}`); }
}

// --- In your JavaScript setup (API Usage) ---
const logger = new CommandLogger();
env.addCommandHandler('audit', logger);
```

### Script Return Value

#### The Final Result Object
`renderScriptString` returns a single, flat object containing all the outputs generated by your script. Each output type has a distinct top-level key.

**Default Structure:**
```javascript
{
  // From path-based data commands (@put, @push, etc.)
  "data": { /* ... */ },

  // From un-pathed @print commands
  "text": "...",

  // Final state of each named command handler
  "handlerName1": ... // Final state of handler 1
  "handlerName2": ... // Final state of handler 2
}
```

**Customizing Result Keys:**
You can rename the default `data` and `text` keys for the result object.
```javascript
env.setResultStructure({
  dataKey: 'payload',
  textKey: 'consoleOutput'
});
```

#### Focused Output
To get just one piece of the result, use the `output` option in the render call. The value should be the final key name of the property you want. If any of these properties
are missing - the return value will be `undefined`.

```javascript
// Get ONLY the structured data object
const myData = await env.renderScriptString(script, context, { output: 'data' });

// Get ONLY the final state of the turtle handler
const myTurtle = await env.renderScriptString(script, context, { output: 'turtle' });

// Get ONLY the final state of the turtle handler
const myText = await env.renderScriptString(script, context, { output: 'text' });
```

## Macros

Macros allow you to define reusable chunks of logic that build and return structured data objects. They operate in a completely isolated scope and are the primary way to create modular, reusable components in Cascada Script.

Inside a macro, the **Data Assembly Commands** (`put`, `push`, `merge`) work on a local, implicit return object. This object is automatically returned by the macro when it finishes.

A `return` statement is not required. If you omit it, the macro returns the object built by the assembly commands. If you include an explicit `return` statement, its value will override the implicit return object.

#### Defining a Macro
```
macro buildUser(id)
  set userData = fetchUserData(id)
  // These 'put' commands operate on the macro's return object
  put user.id userData.id
  put user.name userData.name
endmacro
```

#### Calling a Macro
```
// The macro returns { user: { id: ..., name: ... } }
set myUser = buildUser(123)
put result.user myUser
```

#### Keyword Arguments in Macros
Macros support keyword arguments, allowing for more explicit and flexible calls. You can define default values for arguments, and callers can pass arguments by name.

```javascript
// Macro with default arguments
macro input(name, value="", type="text")
  put field.name name
  put field.value value
  put field.type type
endmacro

// Calling with mixed and keyword arguments
set password = input("pass", type="password")
put result.password password
```

#### The `call` Block
A `call` block allows you to pass a block of logic into a macro. This content is available inside the macro via a special function called `caller()`, which executes the block and returns its result.

```javascript
macro withWrapper(title)
  put block.title title
  // caller() executes the logic from the 'call' block
  put block.content caller()
endmacro

call withWrapper("User Data")
  // This logic is executed by caller()
  set user = fetchUser(123)
  return user.name
endcall
```

### Simple Example with Macros
```
// Define a macro to build and return a user object
macro buildUser(id)
  set userData = fetchUserData(id)
  put user.id userData.id
  put user.name userData.name
endmacro

// Use the macro to build two user objects in parallel
set user1 = buildUser(123)
set user2 = buildUser(456)

// Assemble the final result
put result.firstUser user1
put result.secondUser user2
```

## Resilient Error Handling (`try`/`resume`/`except`)

**Note**: This feature is under development.

Handle runtime errors gracefully with **`try`/`resume`/`except`**. This structure lets you catch errors, define **conditional retry logic** with `resume`, and provide a final fallback. The special `resume.count` variable is **automatically managed by the engine** to track retry attempts.

```javascript
try
  // Attempt a fallible operation
  set image = generateImage(prompt)
  put result.imageUrl image.url
resume resume.count < 3
  // Retry up to 3 times
  print "Retrying attempt " + resume.count
except
  // Handle permanent failure
  put result.error "Image generation failed: "
   + error.message
endtry
```

## Filters and Global Functions

Cascada Script supports the full range of Nunjucks [built-in filters](https://mozilla.github.io/nunjucks/templating.html#builtin-filters) and [global functions](https://mozilla.github.io/nunjucks/templating.html#global-functions). You can use them just as you would in a template.

### Filters
Filters are applied with the pipe `|` operator.
```javascript
set title = "a tale of two cities" | title
print title // "A Tale Of Two Cities"

set users = ["Alice", "Bob"]
print "Users: " + (users | join(", ")) // "Users: Alice, Bob"
```

### Global Functions
Global functions like `range` can be called directly.
```javascript
for i in range(3)
  print "Item " + i // Prints Item 0, Item 1, Item 2
endfor
```

### Additional Global Functions

#### `cycler(...items)`
The `cycler` function creates an object that cycles through a set of values each time its `next()` method is called.

```javascript
set rowClass = cycler("even", "odd")
for item in items
  // First item gets "even", second "odd", third "even", etc.
  push report.rows { class: rowClass.next(), value: item }
endfor
```

#### `joiner([separator])`
The `joiner` creates a function that returns the separator (default is `,`) on every call except the first. This is useful for delimiting items in a list.

```javascript
set comma = joiner(", ")
set output = ""
for tag in ["rock", "pop", "jazz"]
  // The first call to comma() returns "", subsequent calls return ", "
  set output = output + comma() + tag
endfor
print output // "rock, pop, jazz"
```

## Importing Templates

In Cascada scripts, use `import` to access templates:

```
import "header.njk" as header
```

Use `import-script` to load Cascada scripts:

```njk
{% import-script "data.script" as data %}
```

```
import-script "data.script" as data
```

## API Methods

### Environment Class

```javascript
environment.renderScript(scriptName, context[, callback])
environment.renderScriptString(scriptSource, context[, options][, callback])
```

### AsyncEnvironment Class

```javascript
// Always returns Promises
asyncEnvironment.renderScript(scriptName, context[, callback])
asyncEnvironment.renderScriptString(scriptSource, context[, options][, callback])
```

For production environments, you can improve performance by **precompiling** your scripts to JavaScript, which eliminates parsing overhead at runtime. This can be done using the same precompilation API methods available for templates.

## Return Values

Scripts return **either** text output **or** structured data:

- **Text output**: When only using `print` statements without target paths
- **Data output**: When using assembly commands (`put`, `merge`, `push`) or `print` with target paths

## Executing a Script

Here’s an example of executing a script with a macro:

```javascript
const { AsyncEnvironment } = require('cascada-tmpl');
const env = new AsyncEnvironment();

const script = `
macro fetchAndEnhanceUser(id)
  set userData = fetchUser(id)
  put user.id userData.id
  put user.name userData.name
  push user.tasks "Review code"
endmacro

set user1 = fetchAndEnhanceUser(1)
set user2 = fetchAndEnhanceUser(2)

put result.user1 user1
put result.user2 user2
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
const result = await env.renderScriptString(script, context);
console.log(JSON.stringify(result, null, 2));
// Output:
// {
//   "result": {
//     "user1": {
//       "user": {
//         "id": 1,
//         "name": "Alice",
//         "tasks": [ "Review code" ]
//       }
//     },
//     "user2": {
//       "user": {
//         "id": 2,
//         "name": "Bob",
//         "tasks": [ "Review code" ]
//       }
//     }
//   }
// }
```