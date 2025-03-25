## Cascada Script

Cascada Script is a scripting language built on top of the Cascada templating engine, designed specifically for orchestrating asynchronous workflows and data processing tasks. Unlike traditional templating where the focus is on generating HTML or other structured output, Cascada Script prioritizes logic flow, task coordination, and data assembly.

### Purpose and Benefits

Cascada Script excels at managing multiple asynchronous operations while keeping code clean and readable:

- **Clean Syntax**: No template delimiters (`{% %}` or `{{ }}`) cluttering your code
- **Automatic Parallelization**: Independent operations run concurrently with no extra effort
- **Seamless Async Handling**: Work with promises and async functions naturally
- **Data Assembly**: Build complex data structures with specialized commands

### Core Syntax Features

Cascada Script removes the visual noise of template syntax while preserving Cascada's powerful capabilities:

- **No Tag Delimiters**: Write `if condition` instead of `{% if condition %}`
- **Multi-line Expressions**: Split complex expressions across lines for readability
- **Standard Comments**: Use JavaScript-style comments (`//` and `/* */`)
- **Implicit `do`**: Any line not starting with a keyword is treated as a `do` statement

### Simple Example

Here's a basic Cascada Script example:

```
// Fetch user data and process it
set user = fetchUser(userId)

if user.isActive
  print "Active user: " + user.name

  // Process user orders in parallel
  for order in fetchOrders(user.id)
    processOrder(order)
  endfor
else
  print "Inactive user: " + user.name
endif
```

### Executing a Script

To run a Cascada Script:

```javascript
const env = new AsyncEnvironment();

const script = `
set user = fetchUser(123)
print "Hello, " + user.name
`;

const context = {
  fetchUser: async (id) => ({ id: 123, name: "Alice", isActive: true })
};

// Execute the script
const { text, data } = await env.renderScript(script, context);
console.log(text);  // "Hello, Alice"
console.log(data);  // Any data assembled during execution
```

## Data Assembly Commands

Cascada Script provides special commands for constructing data objects during script execution. These commands let you build complex result objects alongside any text output.

### Available Commands

#### print

Outputs text content, with an optional target path.

```
// Basic usage (adds to text output)
print "Hello world!"

// With target path (adds to data output)
print info.message "Hello world!"
```

The second example would produce a data object: `{ info: { message: "Hello world!" } }`

#### put

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

#### merge

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

#### push

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

Target specific array indices with square brackets:

```
// Target specific index
push users[0].permissions "read"

// Target most recently pushed item with []
push users { name: "Charlie" }
push users[].permissions "read"
```

The empty bracket notation `[]` refers to the last item added to the array, regardless of execution order.

### Example with Context Data and Async

This example demonstrates building a data structure using loops, conditionals, and async data:

```
// Set up basic project data
put project {
  name: projectName,
  version: version
}

// Add stats from async API call
merge project.stats projectStats

// Process team members
for member in teamMembers
  // Add to contributors array
  push project.contributors {
    name: member.name,
    role: member.role
  }

  // Add details from async function
  merge project.contributors[] getMemberDetails(member.name)

  // Add tasks with async and loops
  for task in member.tasks
    push project.contributors[].tasks task
  endfor

  // Add additional tasks from async function
  for task in getAdditionalTasks(member.name)
    push project.contributors[].tasks task
  endfor
endfor
```

With context including:

```javascript
{
  projectName: "Cascada App",
  version: "1.2.0",
  teamMembers: [
    { name: "Alice", role: "Developer", tasks: ["Documentation"] },
    { name: "Bob", role: "Designer", tasks: ["UI Components"] }
  ],
  getMemberDetails: async (name) => {
    // Async function that fetches member details
    return { expertise: ["JavaScript"], yearsOfExperience: 5 };
  },
  projectStats: fetch('https://api.example.com/stats').then(res => res.json()),
  getAdditionalTasks: async (name) => ["Code Review", "Testing"]
}
```

### Async Operations

All commands work seamlessly with async data:

```
// These all work naturally with async functions and promises
put profile await getUserProfile(userId)
merge stats dataService.fetchMetrics()
push activities activityService.getLatestActivity()
```

Cascada automatically handles promise resolution and ensures operations execute in the correct order when dependencies exist.

### Best Practices

- **Maximize Parallelism**: Let independent tasks run concurrently for better performance
- **Use `print` for Debugging**: Monitor script execution with targeted print statements
- **Building Complex Structures**: Use the data assembly commands to organize your results
- **Readable Async Code**: Write straightforward, synchronous-looking code even for complex async flows