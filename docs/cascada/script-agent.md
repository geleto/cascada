# Cascada Script - Compressed Reference

**Technology**: Cascada Script - Data orchestration language for JavaScript/TypeScript async workflows
**Baseline**: JavaScript/TypeScript syntax familiarity, standard programming constructs
**Target Use**: AI code generation for async orchestration, LLM workflows, data pipelines

## Core Differentials Summary

1. **Parallel-by-default** — Independent operations execute concurrently automatically
2. **Data-driven execution** — Code runs when inputs are ready, eliminating race conditions
3. **Explicit sequencing with `!`** — Sequential order only when needed for side effects
4. **Deterministic output assembly** — Final outputs ordered as written despite concurrent execution
5. **Errors as data** — Failures propagate through dataflow without throwing exceptions

## UID Schema

```
EXEC-xxx: Execution model rules
VAR-xxx: Variable declaration and scoping
EXPR-xxx: Expression and operator behavior
CTRL-xxx: Control flow (if/for/while/each)
OUT-xxx: Output command system (@data/@text)
ERR-xxx: Error handling and propagation
SEQ-xxx: Sequential execution control (!)
MOD-xxx: Modularity (import/include/extends)
MAC-xxx: Macros and reusability
API-xxx: API and extension points
```

---

## Core Execution Model

**[EXEC-001] Parallel-by-Default Execution**
DIFFERENTIAL: Operations execute concurrently unless dependencies exist
Independent operations (API calls, async functions) run automatically in parallel without `await` keyword

**[EXEC-002] Data-Driven Flow**
Operations wait for their required inputs before executing
Dependency analysis ensures correct execution order while maximizing parallelism

**[EXEC-003] Deterministic Output Ordering**
DIFFERENTIAL: Execution is concurrent and out-of-order; outputs assembled in source-code order
Final result identical to sequential execution despite parallel processing

**[EXEC-004] Three-Phase Execution: Collect-Execute-Assemble**
1. **Collect**: `@` commands buffered in source order
2. **Execute**: All logic (`var`, functions, loops) runs to completion concurrently
3. **Assemble**: Buffered `@` commands dispatched sequentially to build final result

**[EXEC-005] Implicit Promise Resolution**
Any variable can be a promise; no explicit await needed
Pass promises into functions, use in expressions without async ceremony

---

## Sigil/Symbol Table

| Symbol | Name | Differential | Constraint | Example |
|:-------|:-----|:-------------|:-----------|:--------|
| `var` | Variable declaration | Must declare before assign | No shadowing allowed | `var user = fetch()` |
| `extern` | External variable | For included/imported scripts | Cannot initialize | `extern currentUser` |
| `!` | Sequential execution | Forces sequential order | Only on context objects | `db!.insert(data)` |
| `!!` | Path repair | Clears poison on seq path | Sequential paths only | `db!!.rollback()` |
| `@` | Output command | Deferred assembly | Runs after scope completes | `@data.x = 5` |
| `:data` | Output focus | Returns single handler | At scope start or call | `:data` |
| `none` | Null/undefined | Explicit null value | Default for uninitialized | `var x` → `none` |
| `is error` | Error test | Tests for Error Value | Only way to detect errors | `if x is error` |
| `#message` | Error property | Access error message | Only on Error Values | `err#message` |
| `guard` | Transactional rollback | Auto-restores on error | Protects outputs/sequences | `guard` |
| `recover` | Error recovery block | Runs if guard fails | Follows guard block | `recover err` |
| `capture` | Block assignment | Assigns block result | Right side of `=` only | `var x = capture :data` |
| `call` | Dynamic macro call | Passes code block | With `caller()` in macro | `call wrapper()` |
| `caller()` | Execute call block | From inside macro | Returns block result | `var result = caller()` |

---

## Semantic Library

### Core Concepts & Differentials

```javascript
// [EXEC-001] DIFFERENTIAL: Parallel-by-default execution
// Independent async operations run concurrently without await
// ✅ Valid: These three fetches run in parallel automatically
var user = fetchUser(123)
var posts = fetchPosts(123)
var comments = fetchComments(456)
// All three execute concurrently, no await needed

// ❌ Invalid: Don't use await (throws syntax error)
var user = await fetchUser(123)  // SyntaxError
```

```javascript
// [EXEC-002] DIFFERENTIAL: Data-driven execution
// Operations automatically wait for dependencies
// ✅ Valid: Dependent operations wait for inputs
var user = fetchUser(123)
var fullName = user.firstName + " " + user.lastName
// fullName waits for user automatically

// ✅ Valid: No race condition - dependency detected
var data = fetchData()
var processed = transform(data)  // Waits for data
```

```javascript
// [EXEC-003] DIFFERENTIAL: Deterministic output despite concurrent execution
// Outputs assembled in source order regardless of completion order
// ✅ Valid: Array built in source order
for id in [1, 2, 3]
  var item = fetchItem(id)  // May complete out of order
  @data.items.push(item)     // But pushed in order 1,2,3
endfor
```

```javascript
// [EXEC-004] Three-phase execution model
// DIFFERENTIAL: @commands run after scope completes
// ✅ Valid: @data runs after loop finishes
for id in employeeIds
  var details = fetchEmployeeDetails(id)  // Execute phase
  @data.employees.push(details)            // Collect phase
endfor
// Assemble phase: all @data commands execute sequentially

// ❌ Invalid: Cannot read @data during execution
var name = @data.user.name  // Error: @data not available yet
```

```javascript
// [EXEC-005] DIFFERENTIAL: Implicit promise resolution
// Variables can be promises, no async/await syntax
// ✅ Valid: Pass promise into function
var user = fetchUser(123)  // Returns promise
var result = processUser(user)  // user auto-resolved

// ✅ Valid: Use promise in expression
var greeting = "Hello, " + user.name  // user.name auto-resolved
```

### Variable Declaration & Scoping

```javascript
// [VAR-001] RULE: var declares new local variable
// CONSTRAINT: Re-declaring existing variable causes compile error
// ✅ Valid: Declare and initialize
var user = fetchUser(1)

// ✅ Valid: Declare without init (defaults to none)
var report

// ✅ Valid: Multiple variables, single value
var x, y = 100

// ❌ Invalid: Re-declare existing variable
var user = fetchUser(1)
var user = fetchUser(2)  // Compile error
```

```javascript
// [VAR-002] RULE: extern declares expected external variable
// DIFFERENTIAL: For variables from including script, not context
// CONSTRAINT: Cannot initialize, can reassign later
// ✅ Valid: In component.script
extern currentUser, theme
theme = "dark"  // Reassignment OK

// ❌ Invalid: Cannot initialize extern
extern user = fetchUser()  // Compile error
```

```javascript
// [VAR-003] RULE: Assignment requires prior declaration
// CONSTRAINT: Using = on undeclared variable causes compile error
// ✅ Valid: Reassign declared variable
var name = "Alice"
name = "Bob"  // OK

// ✅ Valid: Multiple reassignment
var x, y = 100
x, y = 200  // OK if both declared

// ❌ Invalid: Assign to undeclared variable
username = "Charlie"  // Compile error: not declared
```

```javascript
// [VAR-004] RULE: No variable shadowing
// DIFFERENTIAL: Child scopes cannot redeclare parent variables
// CONSTRAINT: Prevents common bugs
// ✅ Valid: Unique names in nested scopes
var item = "parent"
for i in range(2)
  var other = "child " + i  // Different name
endfor

// ❌ Invalid: Redeclare in child scope
var item = "parent"
for i in range(2)
  var item = "child " + i  // Compile error: shadows parent
endfor
```

```javascript
// [VAR-005] RULE: capture block assigns block result
// CONSTRAINT: Only on right side of =
// DIFFERENTIAL: Orchestrates logic to create single value
// ✅ Valid: Transform data with capture
var user = capture :data
  @data.id = rawData.id
  @data.name = rawData.name | title
  @data.status = "active" if rawData.isActive == 1 else "inactive"
endcapture
// user is clean data object

// ❌ Invalid: capture not on right side
capture :data
  @data.x = 5
endcapture  // Error: must be assigned to variable
```

```javascript
// [VAR-006] RULE: Strict null handling
// DIFFERENTIAL: Throws errors on null/undefined access (unlike Nunjucks)
// CONSTRAINT: Use none for null values
// ✅ Valid: Declare with none
var x  // Defaults to none

// ✅ Valid: Assign none explicitly
var y = none

// ❌ Invalid: Access property of null throws error
var user = none
var name = user.name  // Runtime error (Nunjucks returns undefined)
```

### Expressions & Operators

```javascript
// [EXPR-001] RULE: Multiline expressions via unclosed syntax
// DIFFERENTIAL: Auto-detects continuation without explicit marker
// ✅ Valid: Multiline with unclosed operator
var result = 5 + 10 *
  20 - 3

// ✅ Valid: Unclosed parentheses
var total = (
  price + shipping
) * 1.05

// ❌ Invalid: Complete expression on each line
var result = 5 + 10
  * 20  // Treated as new statement, error
```

```javascript
// [EXPR-002] RULE: Inline if expression (ternary)
// ✅ Valid: Syntax is value_if_true if condition else value_if_false
var theme = "dark" if user.darkMode else "light"

// ✅ Valid: Nested inline if
var status = "admin" if user.role == "admin" else ("user" if user.verified else "guest")
```

```javascript
// [EXPR-003] RULE: Regular expressions with r prefix
// ✅ Valid: Create regex with r/pattern/
var emailRegex = r/^[^\s@]+@[^\s@]+\.[^\s@]+$/
if emailRegex.test(user.email)
  @text("Valid")
endif
```

```javascript
// [EXPR-004] RULE: Filters with pipe operator
// ✅ Valid: Chain filters
var title = "a tale of two cities" | title
@text(title)  // "A Tale Of Two Cities"

// ✅ Valid: Filter in expression
@text("Users: " + (users | join(", ")))
```

### Control Flow

```javascript
// [CTRL-001] RULE: for loops execute concurrently by default
// DIFFERENTIAL: Loop iterations run in parallel automatically
// ✅ Valid: Parallel iteration (default)
for userId in userIds
  var user = fetchUserDetails(userId)  // All fetch concurrently
  @data.users.push(user)
endfor

// ✅ Valid: Concurrency limit with of
for item in largeCollection of 5
  processItem(item)  // Max 5 concurrent
endfor

// ❌ Invalid: Concurrency limit on plain objects (ignored)
for key, val in { a: 1, b: 2 } of 5  // of ignored for objects
  @text(key)
endfor
```

```javascript
// [CTRL-002] RULE: for auto-fallback to sequential
// DIFFERENTIAL: Automatic sequential when dependencies detected
// CONSTRAINT: Triggered by shared variable modification or ! usage
// ✅ Valid: Auto-sequential from shared variable
var total = 0
for item in items
  total = total + item.value  // Modifies shared var → sequential
endfor

// ✅ Valid: Auto-sequential from ! operator
for item in items
  db!.insert(item)  // Sequential path → sequential loop
endfor
```

```javascript
// [CTRL-003] RULE: while loops always sequential
// DIFFERENTIAL: Body executes sequentially, condition re-evaluated after
// ✅ Valid: Sequential iteration
var count = 0
while count < 3
  count = count + 1
  @text("Count: " + count)
endwhile
```

```javascript
// [CTRL-004] RULE: each loops always sequential
// DIFFERENTIAL: Like for but guarantees sequential order
// ✅ Valid: Sequential over collection
each item in collection
  db.insert(item)  // Waits for previous
endeach
```

```javascript
// [CTRL-005] RULE: for else block for empty collections
// ✅ Valid: else executes if collection empty
for item in []
  @text("Item")
else
  @text("Empty")  // Executes
endfor
```

```javascript
// [CTRL-006] RULE: loop variable properties
// CONSTRAINT: Some properties unavailable based on context
// ✅ Valid: Always available
for item in items
  @text(loop.index)   // 1-indexed
  @text(loop.index0)  // 0-indexed
  @text(loop.first)   // true on first
endfor

// ✅ Valid: Available on arrays/objects
for item in [1, 2, 3]
  @text(loop.length)  // 3
  @text(loop.last)    // true on last
endfor

// ❌ Invalid: Not available on sequential async iterators
for item in asyncGen() of 5
  @text(loop.length)  // undefined (can't know length)
endfor
```

```javascript
// [CTRL-007] RULE: if with error condition skips both branches
// DIFFERENTIAL: Error in condition poisons both if and else
// CONSTRAINT: Error propagates to variables modified in either branch
// ✅ Valid: Both branches skipped
var errorVal = fetchError()  // Returns error
if errorVal
  result = "yes"
else
  result = "no"
endif
// result is now an Error Value
```

```javascript
// [CTRL-008] RULE: Iterate various collection types
// ✅ Valid: Arrays
for item in [1, 2, 3]
  @text(item)
endfor

// ✅ Valid: Objects (key, value)
for key, val in { a: 1, b: 2 }
  @text(key + ": " + val)
endfor

// ✅ Valid: Array unpacking
for x, y in [[1, 2], [3, 4]]
  @text(x + "," + y)
endfor

// ✅ Valid: Async iterators
for num in generateNumbers()
  @text(num)
endfor
```

### Sequential Execution Control

```javascript
// [SEQ-001] RULE: ! forces sequential order on object path
// DIFFERENTIAL: Creates ordered sequence for side-effect operations
// CONSTRAINT: Must reference context objects, not local variables
// ✅ Valid: Sequential on context object
db!.insert(data)      // 1. Executes first
db.getStatus()        // 2. Waits for insert
db!.update(moreData)  // 3. Waits for getStatus

// ❌ Invalid: Sequential on local variable
var database = db
database!.insert(data)  // Error: must be context object
```

```javascript
// [SEQ-002] RULE: Sequential path applies to all subsequent calls
// DIFFERENTIAL: Once ! used, all calls on path are sequential
// ✅ Valid: First ! makes entire path sequential
account!.deposit(100)  // Creates sequence
account.getStatus()    // Waits even without !
account.withdraw(50)   // Also waits
```

```javascript
// [SEQ-003] RULE: Nested context access allowed
// ✅ Valid: Path from context property
services.database!.insert(data)  // OK if services in context

// ✅ Valid: Deep nesting from context
app.modules.db!.connect()
```

```javascript
// [SEQ-004] RULE: Macro parameters can use !
// CONSTRAINT: Argument must originate from context when calling
// ✅ Valid: Macro with sequential parameter
macro performWork(database)
  database!.insert(data)
endmacro

performWork(db)  // OK: db from context

// ❌ Invalid: Pass local variable to macro using !
var myDb = db
performWork(myDb)  // Error: must be context object
```

```javascript
// [SEQ-005] RULE: !! repairs poisoned sequential path
// DIFFERENTIAL: Clears poison state or repairs and executes
// ✅ Valid: Repair path only
db!.insert(data)  // Fails, poisons path
db!!  // Repairs path
db!.insert(other)  // Now executes

// ✅ Valid: Repair and execute
db!.beginTransaction()
db!.insert(userData)      // Fails
db!.insert(profileData)   // Skipped
db!!.rollback()           // Repairs and executes rollback
```

```javascript
// [SEQ-006] RULE: Check sequential path poison state
// ✅ Valid: Test if path poisoned
db!.sendRequest(data)  // Might fail
if db! is error
  @data.error = db!#message
  db!!  // Repair
endif
```

### Output Commands System

```javascript
// [OUT-001] RULE: @data builds structured data
// DIFFERENTIAL: Commands buffered, executed after scope completes
// ✅ Valid: Simple assignment
@data.user.name = "Alice"
@data.user.id = 123

// ✅ Valid: Creates nested structures automatically
@data.company.employees.push({ name: "Bob" })

// ❌ Invalid: Cannot read @data during execution
var x = @data.user.name  // Error: not yet assembled
```

```javascript
// [OUT-002] RULE: @data operations executed in source order
// DIFFERENTIAL: Deterministic despite concurrent execution
// ✅ Valid: Sequential assembly
@data.items.push(1)
@data.items.push(2)
@data.items.push(3)
// Always results in [1, 2, 3]
```

```javascript
// [OUT-003] RULE: @text appends to text stream
// ✅ Valid: Build text output
@text("Processing...")
for item in items
  @text("Item: " + item.name)
endfor
@text("Done.")
```

```javascript
// [OUT-004] RULE: :focus directive returns single handler
// DIFFERENTIAL: Changes return from full object to single property
// CONSTRAINT: Placed at scope start or on call/capture
// ✅ Valid: Focus entire script
:data
@data.report.title = "Q3"
@text("Done")
// Returns: { report: { title: "Q3" } } not { data: {...}, text: "..." }

// ✅ Valid: Focus macro
macro buildUser() : data
  @data.user.name = "Alice"
endmacro

// ✅ Valid: Focus call block
call processor() : data
  @data.value = 100
endcall

// ✅ Valid: Focus capture
var result = capture :data
  @data.x = 5
endcapture
```

```javascript
// [OUT-005] RULE: @data.path = value creates structure
// ✅ Valid: Nested path creation
@data.a.b.c.d = "deep"  // Creates all intermediate objects

// ✅ Valid: Root replacement
@data = { status: "complete" }

// ✅ Valid: Change root type
@data = []
@data.push("item")
```

```javascript
// [OUT-006] RULE: @data array operations
// ✅ Valid: Array methods
@data.items.push(value)           // Append
@data.items.concat([1, 2])        // Concatenate
@data.items.pop()                 // Remove last
@data.items.shift()               // Remove first
@data.items.unshift(value)        // Prepend
@data.items.reverse()             // Reverse in-place
@data.items.at(2)                 // Replace with element at index
@data.items.sort()                // Sort in-place
@data.items.arraySlice(1, 3)      // Replace with slice

// CONSTRAINT: Creates empty array if path doesn't exist
@data.newArray.push(1)  // newArray created automatically
```

```javascript
// [OUT-007] RULE: @data object operations
// ✅ Valid: Merge objects
@data.user.merge({ name: "Alice", age: 30 })      // Shallow
@data.user.deepMerge({ nested: { value: 5 } })   // Deep
```

```javascript
// [OUT-008] RULE: @data arithmetic operations
// CONSTRAINT: Target must be number or throws error
// ✅ Valid: Numeric operations
@data.counter = 0
@data.counter += 5       // Add
@data.counter -= 2       // Subtract
@data.counter *= 3       // Multiply
@data.counter /= 2       // Divide
@data.counter++          // Increment
@data.counter--          // Decrement

// ❌ Invalid: Arithmetic on undefined/null throws error
@data.newCounter++  // Error: must initialize first
```

```javascript
// [OUT-009] RULE: @data string operations
// ✅ Valid: String methods
@data.text = "hello"
@data.text += " world"              // Append
@data.text.append(" more")          // Append
@data.text.toUpperCase()            // Convert
@data.text.toLowerCase()            // Convert
@data.text.slice(0, 5)              // Extract
@data.text.trim()                   // Trim
@data.text.replace("old", "new")    // Replace first
@data.text.replaceAll("a", "b")     // Replace all
@data.text.split(" ")               // Split to array

// CONSTRAINT: Creates empty string if path doesn't exist
@data.newText.append("hello")  // newText created automatically
```

```javascript
// [OUT-010] RULE: @data array index targeting
// DIFFERENTIAL: [] refers to last added in source order
// ✅ Valid: Specific index
@data.users[0].name = "Alice"

// ✅ Valid: Last added in source order
@data.users.push({ name: "Bob" })
@data.users[].age = 25  // Affects Bob's object

// CONSTRAINT: Order is source order, not completion order
for id in [1, 2, 3]
  @data.items.push(fetchItem(id))  // May complete out of order
endfor
@data.items[].highlight = true  // Affects item 3 (last pushed in source)
```

```javascript
// [OUT-011] RULE: @data.delete() removes value
// ✅ Valid: Delete property
@data.user.tempField = "temp"
@data.user.tempField.delete()  // Sets to undefined, removed from JSON
```

```javascript
// [OUT-012] RULE: Custom output handlers
// DIFFERENTIAL: Define domain-specific command sequences
// ✅ Valid: Use custom handler
@turtle.forward(100)
@turtle.turn(90)
@turtle.forward(50)
// Result: { turtle: { x: 50, y: 100, angle: 90 } }
```

### Error Handling & Recovery

```javascript
// [ERR-001] DIFFERENTIAL: Errors are data, not exceptions
// RULE: Failed operations produce Error Value that propagates
// ✅ Valid: Error propagates to dependents
var user = fetchUser(999)      // Returns Error Value
var name = user.name           // name becomes Error Value
@data.username = name          // @data poisoned

// ✅ Valid: Independent work continues
var posts = fetchPosts()    // ❌ Fails
var comments = fetchComments()  // ✅ Continues anyway
```

```javascript
// [ERR-002] RULE: is error test detects Error Values
// DIFFERENTIAL: Only way to check for errors
// ✅ Valid: Detect and repair
var user = fetchUser(999)
if user is error
  @data.log = user#message  // Access error message
  user = { name: "Guest" }  // Repair by reassigning
endif
@data.username = user.name  // Now succeeds
```

```javascript
// [ERR-003] RULE: Error in expression poisons result
// ✅ Valid: Any operand error propagates
var myError = fetchError()
var total = myError + 5     // total becomes myError
var result = 10 * myError   // result becomes myError
```

```javascript
// [ERR-004] RULE: Error as argument skips function
// DIFFERENTIAL: Function never executes, returns error immediately
// ✅ Valid: Function skipped
var myError = fetchError()
var result = processData(myError)  // processData not called

// ✅ Valid: Any error argument skips
var output = transform(validData, myError, more)  // Skipped
```

```javascript
// [ERR-005] RULE: Error in loop iterable skips loop body
// CONSTRAINT: Error propagates to all loop outputs
// ✅ Valid: Loop skipped, outputs poisoned
var errorList = fetchError()
for item in errorList
  @data.items.push(item)  // Never executes
endfor
// @data is now poisoned
```

```javascript
// [ERR-006] RULE: Error in if condition skips both branches
// CONSTRAINT: Error propagates to all variables modified in either branch
// ✅ Valid: Both branches skipped
if myErrorCondition
  result = "yes"
else
  result = "no"
endif
// result is now Error Value
```

```javascript
// [ERR-007] RULE: Error written to output handler poisons handler
// DIFFERENTIAL: Handler poisoned, script/macro/capture fails
// ✅ Valid: Handler poisoned
@data.user = myError  // Poisons @data handler
// Render promise rejects with error
```

```javascript
// [ERR-008] RULE: Error in sequential path poisons path
// CONSTRAINT: Later operations on path return error without executing
// ✅ Valid: Path poisoned
db!.connect()      // ❌ Fails
db!.insert(record) // ❌ Skipped, returns error
db!.commit()       // ❌ Skipped, returns error
```

```javascript
// [ERR-009] RULE: guard block protects outputs and sequences
// DIFFERENTIAL: Transaction-like rollback on error
// CONSTRAINT: Variables not protected by default
// ✅ Valid: Default protection (outputs + sequences)
guard
  @data.status = "processing"
  db!.insert(user)
  db!.update(account)  // ❌ Fails
recover err
  // @data reverted, db! repaired
  @data.status = "failed"
  @data.error = err#message
endguard
```

```javascript
// [ERR-010] RULE: guard with explicit targets protects variables
// ✅ Valid: Protect specific variables
guard total, summary
  total = total + fetchValue()  // ❌ Fails
  summary = buildSummary()
recover err
  // total and summary restored to pre-guard values
  @data.error = err#message
endguard
```

```javascript
// [ERR-011] RULE: Manual handler recovery with _revert()
// ✅ Valid: Manually revert handler
@data.status = "processing"
var result = riskyOperation()
if result is error
  @data._revert()  // Reverts all @data changes
  @data.status = "failed"
endif
```

```javascript
// [ERR-012] RULE: Retry pattern with error detection
// ✅ Valid: Retry loop
var retries = 0
var user = none
while retries < 3 and user is error
  user = fetchUser(123)
  if user is not error
    break
  endif
  retries = retries + 1
endwhile
if user is error
  user = { name: "Guest" }
endif
```

### Macros & Reusability

```javascript
// [MAC-001] RULE: macro defines reusable component
// ✅ Valid: Simple macro
macro greet(name)
  @text("Hello, " + name)
endmacro

greet("Alice")  // Call
```

```javascript
// [MAC-002] RULE: Macros support keyword arguments
// ✅ Valid: Keyword args with defaults
macro input(name, value="", type="text") : data
  @data.field.name = name
  @data.field.value = value
  @data.field.type = type
endmacro

var field = input("username", type="email")  // Mixed args
```

```javascript
// [MAC-003] RULE: Macro output focus with :handler
// ✅ Valid: Return focused output
macro buildUser(name) : data
  @data.user.name = name
  @data.user.active = true
endmacro

var user = buildUser("Alice")  // Returns just data, not { data: ... }
```

```javascript
// [MAC-004] RULE: call block passes code to macro
// DIFFERENTIAL: Pass executable block as argument
// ✅ Valid: Call with block
macro wrapper(title)
  @text("Before: " + title)
  caller()  // Execute the block
  @text("After")
endmacro

call wrapper("Title")
  @text("Content")
endcall
```

```javascript
// [MAC-005] RULE: caller() executes call block
// ✅ Valid: Invoke and capture result
macro processor()
  var result = caller()  // Execute block, get result
  @data.processed = result
endmacro

call processor() : data
  @data.value = 100
endcall
```

```javascript
// [MAC-006] RULE: call block has caller's context
// DIFFERENTIAL: Block accesses variables from call site, not macro
// ✅ Valid: Block sees call-site variables
var userCount = 5

macro wrapper()
  caller()
endmacro

call wrapper()
  @text("Users: " + userCount)  // Accesses userCount from outer scope
endcall
```

### Modularity & Composition

```javascript
// [MOD-001] RULE: extern declares expected external variables
// DIFFERENTIAL: For cross-file variable contracts
// CONSTRAINT: Used in called script (include/import/extends)
// ✅ Valid: In component.script
extern user, theme

if not user.isAuthenticated
  theme = "guest"
endif
```

```javascript
// [MOD-002] RULE: reads grants read-only permission
// CONSTRAINT: Used in calling script on import/include/block
// ✅ Valid: Grant read access
include "component.script" reads user, theme
```

```javascript
// [MOD-003] RULE: modifies grants read-write permission
// ✅ Valid: Grant write access
include "component.script" reads user modifies theme
```

```javascript
// [MOD-004] RULE: import loads library as namespace
// DIFFERENTIAL: Stateless by default, no execution
// ✅ Valid: Import as namespace
import "utils.script" as utils
var formatted = utils.formatUser(user)

// ✅ Valid: Import specific macros
from "utils.script" import formatUser
var formatted = formatUser(user)
```

```javascript
// [MOD-005] RULE: Stateful import with permissions
// DIFFERENTIAL: Import can access parent state
// ✅ Valid: Import with variable access
from "logger.script" import add as log modifies log_messages

// ✅ Valid: Import with context access
import "api.script" as api reads context
```

```javascript
// [MOD-006] RULE: reads context grants context access
// DIFFERENTIAL: Special syntax for global context in import only
// CONSTRAINT: Only on import statement
// ✅ Valid: Grant context read access
import "api.script" as api reads context

// ❌ Invalid: reads context on include (include auto-shares context)
include "component.script" reads context  // Error: redundant
```

```javascript
// [MOD-007] RULE: include executes script in current scope
// DIFFERENTIAL: Automatically shares global context
// ✅ Valid: Include with permissions
var user = fetchUser(1)
var stats = { widgetLoads: 0 }

include "widget.script" reads user modifies stats
```

```javascript
// [MOD-008] RULE: extends for template inheritance
// DIFFERENTIAL: Child provides block implementations
// ✅ Valid: Base script with block
// base.script:
block process_data reads inputData modifies result
  result.defaultProcessed = true
endblock

// child.script:
extends "base.script"
extern inputData, result

block process_data
  result.customProcessed = true
endblock
```

```javascript
// [MOD-009] RULE: block contract with reads/modifies
// CONSTRAINT: Child must declare with extern
// ✅ Valid: Block with contract
// base.script:
block process reads input modifies output
  output.default = true
endblock

// child.script:
extends "base.script"
extern input, output

block process
  output.custom = input.value
endblock
```

```javascript
// [MOD-010] RULE: Top-level var in child available to base
// DIFFERENTIAL: Variables set before base execution
// ✅ Valid: Child sets variable
// child.script:
extends "base.script"

var pageTitle = "Custom Page"  // Available to base

block content
  @text("Content")
endblock
```

```javascript
// [MOD-011] RULE: var inside block is local
// CONSTRAINT: Not visible to base or other blocks
// ✅ Valid: Block-local variable
block process
  var tempData = enhance(input)  // Local to this block
  output.result = tempData
endblock
```

---

## Constraint Index

| ID | Constraint | Category |
|:---|:-----------|:---------|
| EXEC-004 | @commands execute after scope completes | Execution |
| EXEC-005 | No explicit await keyword | Execution |
| VAR-001 | No variable redeclaration | Variables |
| VAR-002 | extern cannot initialize | Variables |
| VAR-003 | Assignment requires declaration | Variables |
| VAR-004 | No variable shadowing | Variables |
| VAR-005 | capture only on right side of = | Variables |
| VAR-006 | Accessing null/undefined throws error | Variables |
| EXPR-001 | Multiline via unclosed syntax only | Expressions |
| CTRL-001 | of concurrency ignored on plain objects | Control Flow |
| CTRL-006 | loop.length unavailable on sequential async | Control Flow |
| SEQ-001 | ! only on context objects | Sequential |
| SEQ-004 | Macro ! parameters must receive context objects | Sequential |
| OUT-001 | Cannot read @data during execution | Output |
| OUT-004 | :focus at scope start or on call/capture | Output |
| OUT-008 | Arithmetic requires initialized number | Output |
| ERR-007 | Error to output handler fails scope | Error |
| ERR-010 | guard default doesn't protect variables | Error |
| MOD-001 | extern in called script | Modularity |
| MOD-002 | reads in calling script | Modularity |
| MOD-006 | reads context only on import | Modularity |
| MOD-007 | include auto-shares context | Modularity |
| MOD-009 | block child must declare with extern | Modularity |

---

## API Reference

### AsyncEnvironment

```javascript
// [API-001] Create environment with loaders
const env = new AsyncEnvironment(
  [new FileSystemLoader('scripts')],
  { autoescape: true, trimBlocks: false }
)

// [API-002] Execute script from file
const result = await env.renderScript('main.casc', { userId: 123 })

// [API-003] Execute script from string
const result = await env.renderScriptString(':data\n@data.x = 5')

// [API-004] Compile and cache
const compiled = await env.getScript('main.casc')
const r1 = await compiled.render({ input: 'a' })
const r2 = await compiled.render({ input: 'b' })

// [API-005] Add global variable/function
env.addGlobal('utils', { formatDate: (d) => d.toISOString() })

// [API-006] Add custom filter
env.addFilter('double', (x) => x * 2)

// [API-007] Extend @data with methods
env.addDataMethods({
  incrementBy: (target, amount) => (target || 0) + amount
})

// [API-008] Register custom handler (factory)
env.addCommandHandlerClass('turtle', TurtleHandler)

// [API-009] Register custom handler (singleton)
env.addCommandHandler('logger', loggerInstance)
```

### Loaders

```javascript
// [API-010] Built-in loaders
const env = new AsyncEnvironment([
  new FileSystemLoader('scripts'),    // Node.js only
  new WebLoader('https://cdn.com/'),  // Browser only
  new PrecompiledLoader(precompiled)  // Production
])

// [API-011] Custom loader function
const customLoader = async (name) => {
  const src = await fetch(`https://api.com/${name}`)
  return { src: await src.text(), path: name, noCache: false }
}

// [API-012] Custom loader class
class DatabaseLoader {
  async load(name) {
    const record = await db.scripts.findByName(name)
    if (!record) return null
    return { src: record.code, path: name }
  }

  isRelative(filename) {
    return filename.startsWith('./')
  }

  resolve(from, to) {
    const fromDir = from.substring(0, from.lastIndexOf('/'))
    return `${fromDir}/${to}`
  }
}

// [API-013] Race loaders (concurrent fallback)
const fastLoader = raceLoaders([
  new WebLoader('https://cdn.com/'),
  new FileSystemLoader('backup/')
])
```

### Custom Output Handlers

```javascript
// [API-014] Handler class structure
class CustomHandler {
  constructor(env) {
    this.env = env
  }

  init() {
    // Called at scope start
    this.commands = []
  }

  invoke(name, args) {
    // Called during assembly phase
    this.commands.push({ name, args })
  }

  finalize() {
    // Return final value
    return { result: this.commands }
  }
}
```

### Precompilation

```javascript
// [API-015] Precompile for production
const js = precompileScript('main.casc', { env })
// Save js to file, load with PrecompiledLoader
```

---

## Appendix: UID Index

**Execution Model**: EXEC-001 to EXEC-005
**Variables**: VAR-001 to VAR-006
**Expressions**: EXPR-001 to EXPR-004
**Control Flow**: CTRL-001 to CTRL-008
**Sequential**: SEQ-001 to SEQ-006
**Output**: OUT-001 to OUT-012
**Errors**: ERR-001 to ERR-012
**Macros**: MAC-001 to MAC-006
**Modularity**: MOD-001 to MOD-011
**API**: API-001 to API-015

**Total UIDs**: 82