# Cascada Script Documentation

## Overview

Cascada Script is a scripting language built on top of the Cascada templating engine, designed for orchestrating asynchronous workflows and data processing tasks. Unlike traditional templating, which focuses on generating text output, Cascada Script prioritizes logic flow, task coordination, and data assembly.

## Table of Contents
- [Key Features](#key-features)
- [Core Syntax Features](#core-syntax-features)
- [Expressions](#expressions)
- [Data Assembly Commands](#data-assembly-commands)
- [Data Assembly Ordering](#data-assembly-ordering)
- [Macros](#macros)
- [Sequential Execution Control (`!`)](#sequential-execution-control-)
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

## Data Assembly Commands

Cascada Script provides special commands for constructing data objects during script execution. These commands let you build complex result objects.

**Important**: Despite the automatic concurrency of operations, Data Assembly Commands (`put`, `merge`, `push`) and `print` maintain the sequential order in which they appear in the script. This ensures consistent and predictable output, regardless of when underlying async operations complete.

### print

Outputs text content, with an optional target path.

```
// Basic usage (adds to text output)
print "Hello world!"

// With target path (adds to data output)
print info.message "Hello world!"
```

The second example produces a data object: `{ info: { message: "Hello world!" } }`

### put

Sets a value at a specific path in the result data.

```
// Setting simple and nested values
put count 100
put user.name "Alice"
put user.role "Admin"

// Setting object literals
put config {
  darkMode: true,
  language: "en"
}
```

### merge

Combines objects at a specific path.

```
// Create initial object
put user { name: "Alice" }

// Merge additional properties
merge user {
  role: "Admin",
  location: "New York"
}
```

### push

Adds values to arrays in the result data.

```
// Basic push to arrays
push items 123
push items 456

// Push with target path
push user.roles "Editor"
push user.roles "Reviewer"

// Push objects to arrays
push users { name: "Alice", role: "Admin" }
push users { name: "Bob", role: "Editor" }
```

### Array Index Targeting

Target specific array indices with square brackets. The empty bracket notation `[]` always refers to the last item added in the script's sequential order, **not** the most recently pushed item in terms of operation completion. Due to implicit concurrency, the order of completion can vary, but Cascada Script ensures consistency by following the script's logical sequence.

```
// Target specific index
push users[0].permissions "read"

// Target the last item added in the script's sequence
push users { name: "Charlie" }
push users[].permissions "read"  // Always affects "Charlie", not a randomly completed item
```

This sequential behavior aligns with how `print` appends text and how Data Assembly Commands arrange data, providing predictability despite async execution.

### Data Assembly Ordering

Cascada Script’s Data Assembly Commands (`put`, `push`, `merge`) and `print` maintain consistent **sequential ordering** based on their appearance in the script, regardless of when their underlying operations complete. This ensures that the final data structure reflects the logical sequence in your code, combining the mental simplicity of sequential programming with the performance benefits of automatic parallelization.

For example:
```
// These commands produce consistent results despite parallel execution
put user.name "Alice"
push user.roles "Admin"
push user.roles "Editor"
merge user.settings { theme: "dark" }
```

Here, `user.roles` will always be `["Admin", "Editor"]` in that order, and `print` statements will append text in the order they appear, not based on operation completion.

This sequential ordering is especially critical for array targeting with `[]`:
```
push users { name: "Alice" }
push users[].permissions "read"  // Always affects "Alice"
```

The empty bracket `[]` reliably references the "Alice" object because it follows the script’s sequence, not the unpredictable timing of concurrent operations.

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

#### Variable Scope Rules
- Variables defined within a macro are local and do not affect the outer scope.
- Arguments passed to a macro are also local.
- A macro returns the data object constructed by its internal data assembly commands, unless an explicit `return` statement is used.

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
const result = await env.renderScript(script, context);
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