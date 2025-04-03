# Cascada Script Documentation

## Overview

Cascada Script is a scripting language built on top of the Cascada templating engine, designed for orchestrating asynchronous workflows and data processing tasks. Unlike traditional templating, which focuses on generating text output, Cascada Script prioritizes logic flow, task coordination, and data assembly.

### Key Features

- **Clean Syntax**: No template delimiters (`{% %}` or `{{ }}`) cluttering your code
- **Automatic Parallelization**: Independent operations run concurrently with no extra effort
- **Seamless Async Handling**: Work with promises and async functions naturally
- **Data Assembly**: Build complex data structures with specialized commands
- **Macros and Procedures**: Reusable code blocks with distinct scope rules for building independent data objects

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
- **Macros and Procedures**: Define reusable blocks of code with `macro` and `procedure`

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

#### Output
```
print expression
```

### Macros and Procedures

Cascada Script provides two types of reusable code blocks: **macros** and **procedures**.

- **Macros**: Build and return independent data objects using data assembly commands (`put`, `merge`, `push`). They operate in a local scope and return a data object that can be used by the caller.
- **Procedures**: Encapsulate reusable logic and operate within their own local scope, returning data objects via explicit `return` statements or implicit returns.

#### Defining a Macro
```
macro macroName(arg1, arg2)
  put local.field arg1
  put local.settings { key: arg2 }
  return local
endmacro
```

#### Calling a Macro
```
set var = macroName(value1, value2)
put result.section var
```

#### Defining a Procedure
```
procedure procedureName(arg1, arg2)
  set local = {}
  put local.field arg1
  merge local.settings { key: arg2 }
  return local
endprocedure
```

#### Calling a Procedure
```
set data = procedureName(value1, value2)
```

#### Variable Scope Rules

- **Macros**:
  - Variables defined within a macro are local and do not affect the outer scope.
  - Arguments passed to a macro are local.
  - Macros return a data object that can be assigned or used by the caller.

- **Procedures**:
  - Variables defined within a procedure are local and do not persist outside their scope.
  - Arguments passed to a procedure are local.
  - Procedures return a data object explicitly via `return` or implicitly if no `return` is specified.

### Simple Example with Macro and Procedure

```
// Define a macro to build and return a user object
macro buildUser(id)
  set userData = fetchUserData(id)
  put user.id userData.id
  put user.name userData.name
  return user
endmacro

// Define a procedure to build and return user data
procedure updateUsers(id)
  set userData = buildUser(id)
  set local = {}
  put local.user userData
  return local
endprocedure

// Use the macro to build a user object
set localUser = buildUser(123)

// Use the procedure to get user data
set globalData = updateUsers(456)
put result globalData
```

## Data Assembly Commands

Cascada Script provides special commands for constructing data objects during script execution. These commands let you build complex result objects, either globally (directly in the script) or locally (in macros or procedures).

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

## Data Assembly Ordering

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

## Return Values

Scripts return **either** text output **or** structured data:

- **Text output**: When only using `print` statements without target paths
- **Data output**: When using assembly commands (`put`, `merge`, `push`) or `print` with target paths

## Executing a Script

Here’s an example of executing a script with a macro and procedure:

```javascript
const { AsyncEnvironment } = require('cascada-tmpl');
const env = new AsyncEnvironment();

const script = `
macro fetchAndEnhanceUser(id)
  set userData = fetchUser(id)
  put user.id userData.id
  put user.name userData.name
  put user.tasks userData.tasks
  return user
endmacro

procedure updateUsers()
  set user1 = fetchAndEnhanceUser(1)
  set user2 = fetchAndEnhanceUser(2)
  set local = {}
  put local.user1 user1
  put local.user2 user2
  push local.user1.tasks "Go home"
  push local.user2.tasks "Go to work"
  return local
endprocedure

set resultData = updateUsers()
put result resultData
`;

const context = {
  fetchUser: async (id) => {
    const users = {
      1: { id: 1, name: "Alice", tasks: ["Review pull requests"] },
      2: { id: 2, name: "Bob", tasks: ["Write documentation"] },
    };
    return users[id] || null;
  }
};

// Execute the script
const result = await env.renderScript(script, context);
console.log(result);
// Output: {
//   result: {
//     user1: { id: 1, name: "Alice", tasks: ["Review pull requests", "Go home"] },
//     user2: { id: 2, name: "Bob", tasks: ["Write documentation", "Go to work"] }
//   }
// }
```