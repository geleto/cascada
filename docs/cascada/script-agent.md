# Cascada Script - AI Agent Reference

## Core Description
Parallel-by-default scripting language for JavaScript/TypeScript async orchestration. Data-driven execution engine that automatically resolves dependencies, maximizes concurrency, and guarantees deterministic output assembly.

## Core Differentials (vs Standard JavaScript)
- **Parallel-first execution**: Independent operations run concurrently by default (no `await` needed)
- **Data-driven flow**: Code executes when inputs available (automatic dependency resolution)
- **Sequential marker (`!`)**: Explicit ordering only for side-effectful operations
- **Dataflow poisoning**: Errors propagate as values (no exceptions in dataflow)
- **Deterministic outputs**: Concurrent execution, sequential assembly guarantees
- **Scope isolation**: Control blocks create isolated scopes in async mode

## UID Schema
```
EXEC-xxx   : Execution model invariants
VAR-xxx    : Variable declaration and scope rules
OUT-xxx    : Output building (@data syntax)
CAPT-xxx   : Capture blocks and output focus
CTRL-xxx   : Control flow (if/else, loops, switch)
ERR-xxx    : Error handling and poison values
FN-xxx     : Functions, filters, operators
MACRO-xxx  : Macro definition and invocation
MOD-xxx    : Module system (import, include, extends)
API-xxx    : Runtime API and compilation
TEMP-xxx   : Template integration
LIMIT-xxx  : Constraints and limitations
```

---

## Sigil/Symbol Table

| Symbol | Name | Differential | Constraint | Example |
|:-------|:-----|:-------------|:-----------|:--------|
| `!` | Sequential marker | Forces strict ordering on operation chain | Only on context properties, not variables | `!context.saveUser()` |
| `!!` | Repair operator | Repairs poisoned sequential path before operation | Only on sequential paths | `!!context.db.rollback()` |
| `@data` | Output builder | Declares output construction intent | Creates isolated scope per assignment | See OUT-001 |
| `@data.path=` | Output assignment | Assigns value to output path | No `set`/`var` needed | `@data.user.name = "Alice"` |
| `@data.path.method()` | Output method | Invokes built-in method on path | Returns new value, doesn't mutate | `@data.items.push(x)` |
| `@handler._revert()` / `revert` | Handler revert | Resets handler(s) to scope start | Specific handler or all (revert = all) | `@data._revert()` or `revert` |
| `#` | Peek operator | Accesses error properties without propagation | Must check `is error` first | `if x is error: x#message` |
| `var` | Variable declaration | Creates local variable | Scope rules differ in async mode | See VAR-001 |
| `set` | Variable assignment | Assigns to existing variable | Can cross scope boundaries | See VAR-002 |
| `capture` | Capture block | Executes scope and returns result | Right side of assignment only | See CAPT-001 |
| `:data`, `:text` | Output focus | Extracts single handler from result | Script, macro, capture, call | See CAPT-002 |
| `guard` | Guard block | Transaction-like state protection | Auto-reverts on failure | See ERR-008 |
| `recover` | Recovery block | Runs if guard finishes poisoned | Optional, follows guard | See ERR-008 |
| `~macro_name` | Tilde-macro | Captures entire block as string | Must be defined with `captureblock` | See MACRO-005 |
| `{% ... %}` | Template syntax | Fallback to template mode | Nests within script blocks | See TEMP-001 |
| `.` (dot) | Property access | Auto-awaits promises | Works on any value | See EXEC-003 |
| `\|` | Pipe/filter | Applies transformation | Chainable, left-to-right | `value \| upper \| trim` |

---

## Semantic Library

### Category: Execution Model & Concurrency

#### [EXEC-001] Parallel-by-default execution
```javascript
// RULE: Independent operations run concurrently automatically
// DIFFERENTIAL: No await/Promise.all needed
var user = fetchUser(id)        // Starts immediately
var posts = fetchPosts(userId)  // Starts immediately, parallel with user
var profile = fetchProfile(id)  // Starts immediately, parallel with both

// ✅ Valid: All three fetches run concurrently
var result = {
  user: user,
  posts: posts,
  profile: profile
}

// ❌ Invalid: No way to force sequential without ! marker
// If you write:
var a = fetchA()
var b = fetchB()  // Still runs in parallel with a
```

#### [EXEC-002] Data-driven execution waits for dependencies
```javascript
// RULE: Operations wait for their inputs before executing
// DIFFERENTIAL: Engine tracks dependencies
var user = fetchUser(123)
var greeting = "Hello, " + user.name

// ✅ Valid: greeting waits for user.name to resolve
@data.message = greeting

// ✅ Valid: Chained dependencies resolve automatically
var profile = fetchProfile(user.id)
var posts = fetchPosts(user.id)
var combined = profile.bio + posts[0].title

// ❌ Invalid: No construct to force execution before input ready
// The engine never executes code with unresolved dependencies
```

#### [EXEC-003] Automatic promise resolution on access
```javascript
// RULE: Property access, function args, operators auto-await promises
// DIFFERENTIAL: No await/then needed
var user = fetchUser(123)  // Returns promise

// ✅ Valid: Dot notation auto-awaits
var name = user.name

// ✅ Valid: Function arguments auto-await
var formatted = formatName(user.name)

// ✅ Valid: Operators auto-await operands
var fullName = user.firstName + " " + user.lastName

// ✅ Valid: Nested access chains auto-await at each step
var city = user.address.city

// ❌ Invalid: Cannot access promise metadata or force manual await
// No .catch(), .finally(), Promise.race(), etc.
```

#### [EXEC-004] Sequential marker (!) scope is call-chain only
```javascript
// RULE: ! enforces ordering within marked chain, not globally
// DIFFERENTIAL: Scoped sequencing vs global blocking
// CONSTRAINT: Only works on context properties, not variables (LIMIT-001)

// ✅ Valid: Sequential chain via context
!context.step1()
!context.step2()
!context.step3()

// ✅ Valid: Parallel operations unaffected by sequential chain
!context.saveUser(user)
var posts = fetchPosts()  // Still runs in parallel with saveUser

// ✅ Valid: Sequential marker on method chain
!context.db.connect()
!context.db.createTable()
!context.db.insertRow()

// ❌ Invalid: Cannot use ! on script variables
var result = step1()
!result  // Error: ! only works on context properties
```

#### [EXEC-005] Deterministic output assembly order
```javascript
// RULE: Outputs assemble in source code order despite concurrent execution
// DIFFERENTIAL: Order guarantee despite concurrent execution
// CONSTRAINT: Only applies to @data assignments

// ✅ Valid: Items appear in source order
@data.items.push(fetchSlow())   // May complete last
@data.items.push(fetchFast())   // May complete first
@data.items.push(fetchMedium()) // May complete second
// Result: [slow, fast, medium] - always in source order

// ✅ Valid: Object properties maintain declaration order
@data.first = slowOperation()
@data.second = fastOperation()
@data.third = mediumOperation()
// Result: { first, second, third } in source order

// ❌ Invalid: Variables have no order guarantee
var arr = []
arr.push(fetchSlow())
arr.push(fetchFast())
// Result: Race condition - undefined order
```

#### [EXEC-006] Unordered side-effects race
```javascript
// RULE: Operations without ! have no ordering guarantee
// CONSTRAINT: Dangerous for side-effectful operations
// DIFFERENTIAL: Must explicitly mark sequential dependencies

// ❌ Invalid: Race condition on side-effectful operations
context.deleteUser(userId)
context.sendEmail(userId, "deleted")  // May run before delete

// ✅ Valid: Use ! to enforce order
!context.deleteUser(userId)
!context.sendEmail(userId, "deleted")  // Guaranteed after delete

// ✅ Valid: Read-only operations can be parallel
var users = fetchUsers()
var posts = fetchPosts()
var comments = fetchComments()  // All safe in parallel
```

#### [EXEC-007] Context vs variables - ! compatibility
```javascript
// RULE: Sequential marker (!) only works on context properties
// CONSTRAINT: See LIMIT-001 for planned variable support
// DIFFERENTIAL: Distinction between context and script locals

// ✅ Valid: Context properties support !
!context.apiCall()
!context.db.save()
!context.service.method()

// ❌ Invalid: Variables don't support ! (current limitation)
var api = context.api
!api.call()  // Error: ! doesn't work on variables

// Workaround: Use context directly
!context.api.call()  // Works
```

#### [EXEC-008] Error propagation as data (poison values)
```javascript
// RULE: Failed operations produce Error values that propagate
// DIFFERENTIAL: Errors flow through dataflow
// CONSTRAINT: Unrelated parallel work continues unaffected

// ✅ Valid: Error propagates to dependents
var user = fetchUser(123)  // Fails -> Error value
var name = user.name       // Becomes Error (depends on user)
var greeting = "Hello " + name  // Becomes Error (depends on name)

// ✅ Valid: Independent operations continue
var user = fetchUser(123)  // Fails
var posts = fetchPosts()   // Still executes, unaffected

// ✅ Valid: Check for errors before use
var user = fetchUser(id)
if user is error
  @data.error = "Failed to fetch user"
else
  @data.name = user.name
endif

// ❌ Invalid: Cannot catch or handle errors mid-expression
var name = try user.name catch "Unknown"  // No such construct
```

---

### Category: Variables & Scope

#### [VAR-001] var creates local variable in current scope
```javascript
// RULE: var declares variable in current block scope
// DIFFERENTIAL: Isolated scopes vs JS var hoisting
// CONSTRAINT: Cannot redeclare same name in scope

// ✅ Valid: Basic declaration
var x = 10
var name = "Alice"
var user = fetchUser(123)

// ✅ Valid: Scoped to block in async mode
if condition
  var local = "value"  // Only visible inside if
endif
// local is undefined here

// ❌ Invalid: Redeclaration in same scope
var x = 1
var x = 2  // Error: x already declared

// ❌ Invalid: Access before declaration
var y = x + 1
var x = 10  // Error: x used before declaration
```

#### [VAR-002] set assigns to existing variable
```javascript
// RULE: set modifies existing variable from outer scope
// DIFFERENTIAL: Can cross scope boundaries (unlike var)
// CONSTRAINT: Variable must exist in an outer scope

// ✅ Valid: Modify outer variable from inner scope
var counter = 0
if condition
  set counter = counter + 1  // Modifies outer counter
endif

// ✅ Valid: Multiple scope levels
var total = 0
for item in items
  if item.valid
    set total = total + item.value  // Reaches outer total
  endif
endfor

// ❌ Invalid: set without prior declaration
set newVar = 10  // Error: newVar doesn't exist

// ❌ Invalid: set in same scope (use var or just assign)
var x = 1
set x = 2  // Unnecessary, but works
```

#### [VAR-003] Scope isolation in async mode
```javascript
// RULE: Control blocks create isolated scopes in async mode
// DIFFERENTIAL: Prevents race conditions; differs from JS/Nunjucks
// CONSTRAINT: Use 'set' to modify outer variables

// ✅ Valid: Each iteration has isolated scope
for item in items
  var temp = process(item)  // Local to this iteration
  @data.results.push(temp)
endfor

// ✅ Valid: if/else blocks are isolated
if condition
  var result = "A"
else
  var result = "B"  // Different variable, same name OK
endif
// result undefined here

// ❌ Invalid: Assuming shared scope (JS habit)
var sum = 0
for item in items
  var sum = sum + item.value  // Creates new local sum
endfor
// Outer sum unchanged

// ✅ Valid: Correct accumulation
var sum = 0
for item in items
  set sum = sum + item.value  // Modifies outer sum
endfor
```

#### [VAR-004] Sync mode behaves like classic templates
```javascript
// RULE: With asyncMode: false, no scope isolation
// DIFFERENTIAL: Legacy Nunjucks behavior for compatibility
// CONSTRAINT: Only use for fully synchronous templates

// ✅ Valid in sync mode: var modifies parent scope
var x = 0
{% for i in [1,2,3] %}
  {% set x = x + i %}  // Modifies parent x
{% endfor %}
// x is 6

// ❌ Invalid: Sync mode cannot handle promises safely
// Race conditions possible without scope isolation
```

---

### Category: Capture Blocks & Output Focus

#### [CAPT-001] capture block for inline scope execution
```javascript
// RULE: capture ... endcapture runs logic and returns result
// DIFFERENTIAL: Isolated output scope per assignment
// CONSTRAINT: Used only on right side of assignment (=)

// ✅ Valid: Basic capture
var user = capture :data
  var raw = fetchUser(id)
  @data.id = raw.id
  @data.name = raw.name | upper
endcapture
// user = { id: 123, name: "ALICE" }

// ✅ Valid: Capture with complex logic
var summary = capture :data
  var posts = fetchPosts()
  for post in posts
    @data.count++
    @data.titles.push(post.title)
  endfor
  @data.total = posts | length
endcapture

// ❌ Invalid: Capture without assignment
capture :data
  @data.value = 1
endcapture  // Error: must be on right side of =

// ❌ Invalid: Capture in expression
var x = capture :data @data.v = 1 endcapture + 5  // Syntax error
```

#### [CAPT-002] Output focus directives (:data, :text, :handler)
```javascript
// RULE: :handler focuses result to single handler property
// DIFFERENTIAL: Returns value, not {handler: value}
// CONSTRAINT: Applies to scripts, macros, captures, call blocks

// ✅ Valid: Script-level focus
:data
@data.user.name = "Alice"
@text("Processing...")
// Returns: { user: { name: "Alice" } } not { data: {...}, text: "..." }

// ✅ Valid: Capture focus
var result = capture :data
  @data.value = 42
  @text("Ignored due to :data focus")
endcapture
// result = { value: 42 } only

// ✅ Valid: Macro focus
macro buildUser(name) : data
  @data.user.name = name
  @text("Building...")  // Ignored
endmacro
var user = buildUser("Alice")
// user = { user: { name: "Alice" } }

// ✅ Valid: call block focus
macro processor()
  var data = caller()  // Gets focused result
  @data.processed = data
endmacro
call processor() : data
  @data.value = 100
  @text("Ignored")
endcall
// processor receives: { value: 100 }

// ✅ Valid: Unfocused returns all handlers
@data.value = 1
@text("Done")
// Returns: { data: { value: 1 }, text: "Done" }
```

#### [CAPT-003] Output scope boundaries and revert
```javascript
// RULE: Capture creates revert boundary
// SEE: ERR-009 for complete scope boundary list

// ✅ Valid: Revert in capture
var result = capture :data
  if @data is error
    revert  // To capture start, not script
  endif
endcapture

// For other boundaries: guard, macro, caller, include → see ERR-009
```

#### [CAPT-004] Capture scope variable access
```javascript
// RULE: Capture can access outer scope variables
// DIFFERENTIAL: Read outer, but var creates local
// CONSTRAINT: Use set to modify outer variables

// ✅ Valid: Read outer variables
var userId = 123
var user = capture :data
  @data.id = userId  // Access outer userId
  @data.name = fetchUser(userId).name
endcapture

// ✅ Valid: Modify outer with set
var counter = 0
var result = capture :data
  set counter = counter + 1  // Modify outer
  @data.count = counter
endcapture

// ❌ Invalid: var creates local, doesn't modify outer
var total = 0
var result = capture :data
  var total = 10  // Creates local total
endcapture
// Outer total still 0

// ✅ Valid: Correct outer modification
var total = 0
var result = capture :data
  set total = 10  // Modifies outer total
  @data.total = total
endcapture
// Outer total now 10
```

---

### Category: Output Building (@data)

#### [OUT-001] @data declares output construction
```javascript
// RULE: @data assignments build the final output object
// DIFFERENTIAL: Separate from variable space; isolated scope per assignment
// CONSTRAINT: Each @data expression runs in own scope

// ✅ Valid: Building output object
@data.user.name = "Alice"
@data.user.email = "alice@example.com"
@data.status = "success"
// Output: { user: { name: "Alice", email: "..." }, status: "success" }

// ✅ Valid: Using variables in @data
var user = fetchUser(id)
@data.result.name = user.name
@data.result.id = user.id

// ✅ Valid: Each assignment is independent
@data.items.push(slowOperation())
@data.items.push(fastOperation())
// Order preserved despite parallel execution
```

#### [OUT-002] @data creates nested paths automatically
```javascript
// RULE: @data auto-creates intermediate objects/arrays
// DIFFERENTIAL: No need to initialize containers
// CONSTRAINT: Final path segment determines type

// ✅ Valid: Auto-creates nested objects
@data.user.profile.settings.theme = "dark"
// Creates: { user: { profile: { settings: { theme: "dark" } } } }

// ✅ Valid: Array access auto-creates array
@data.items[0] = "first"
@data.items[2] = "third"
// Creates: { items: ["first", undefined, "third"] }

// ✅ Valid: Mixed nesting
@data.users[0].name = "Alice"
@data.users[0].posts[0] = "Post 1"
```

#### [OUT-003] @data methods are immutable operations
```javascript
// RULE: @data methods return new value without mutating
// DIFFERENTIAL: Functional style; concurrent-safe
// CONSTRAINT: Must assign result back to @data path

// ✅ Valid: push returns new array
@data.items.push("new")  // Creates/extends items array

// ✅ Valid: Chaining methods
@data.text.upper().trim()  // Returns transformed text

// ✅ Valid: concat creates new array
@data.all.concat(moreItems)

// ❌ Invalid: Methods don't mutate in place
var arr = [1, 2, 3]
arr.push(4)  // arr is still [1,2,3] - push returns new array
```

#### [OUT-004] Built-in @data methods
```javascript
// RULE: Standard methods available on @data paths
// TYPES: push, concat, append (arrays); upper, lower, trim (strings)

// ✅ Valid: Array methods
@data.items.push(item)           // Append single
@data.items.concat(arrayOfItems) // Merge arrays
@data.items.append(item)         // Alias for push

// ✅ Valid: String methods
@data.text.upper()  // Uppercase
@data.text.lower()  // Lowercase
@data.text.trim()   // Remove whitespace

// ✅ Valid: Custom methods via addDataMethods
// env.addDataMethods({ incrementBy: (target, n) => (target || 0) + n })
@data.count.incrementBy(5)
```

#### [OUT-005] @data scope isolation per assignment
```javascript
// RULE: Each @data assignment executes in isolated scope
// DIFFERENTIAL: No shared variables between @data expressions
// CONSTRAINT: Use regular variables for shared computation

// ❌ Invalid: Cannot share variables across @data assignments
@data.first = var temp = process()  // Syntax error
@data.second = temp  // temp not accessible

// ✅ Valid: Use regular variables for sharing
var temp = process()
@data.first = temp
@data.second = temp

// ✅ Valid: Each @data is independent expression
@data.user.name = fetchUser().name
@data.user.email = fetchUser().email  // Fetches again
```

---

### Category: Control Flow

#### [CTRL-001] if/else creates isolated scope (async mode)
```javascript
// RULE: if/elif/else branches execute in isolated scope
// DIFFERENTIAL: Variables don't leak; use set for outer
// CONSTRAINT: Async mode only; sync mode shares scope

// ✅ Valid: Isolated branch scopes
var result = null
if condition
  var result = "A"  // Local to if branch
endif
// result is still null

// ✅ Valid: Modify outer variable
var result = null
if condition
  set result = "A"  // Modifies outer result
endif
// result is "A"

// ✅ Valid: elif/else also isolated
if x > 10
  var msg = "high"
elif x > 5
  var msg = "medium"  // Different local variable
else
  var msg = "low"     // Different local variable
endif
```

#### [CTRL-002] for loop iterations execute in parallel
```javascript
// RULE: for loop iterations run concurrently unless using !
// DIFFERENTIAL: Not sequential like traditional loops
// CONSTRAINT: Each iteration has isolated scope

// ✅ Valid: Parallel iterations
for item in items
  var processed = processItem(item)  // All run in parallel
  @data.results.push(processed)
endfor

// ✅ Valid: Accessing loop variable
for user in users
  @data.names.push(user.name)  // Each iteration independent
endfor

// ✅ Valid: Accumulating with set
var total = 0
for item in items
  set total = total + item.value  // Shared accumulator
endfor

// ❌ Invalid: Assuming sequential execution
for i in range(5)
  !context.log(i)  // Error: ! doesn't work on loop variable
endfor
```

#### [CTRL-003] while loop syntax (limited use case)
```javascript
// RULE: while condition ... endwhile supported
// CONSTRAINT: Rarely useful due to parallel execution model
// DIFFERENTIAL: Condition must become false via external state

// ✅ Valid: while with external state change
while context.hasMore
  var item = !context.fetchNext()
  @data.items.push(item)
endwhile

// ❌ Invalid: Internal loop variable doesn't work
var i = 0
while i < 5
  set i = i + 1  // Parallel execution - unpredictable
endwhile

// Note: Traditional counting loops should use 'for' with range
for i in range(5)
  @data.items.push(i)
endfor
```

#### [CTRL-004] switch/case for multi-way branching
```javascript
// RULE: switch value ... case x ... case y ... default ... endswitch
// DIFFERENTIAL: Each case branch isolated scope (async mode)
// CONSTRAINT: No fall-through (unlike C/JS switch)

// ✅ Valid: Basic switch
switch status
  case "active"
    @data.message = "User is active"
  case "pending"
    @data.message = "User is pending"
  default
    @data.message = "Unknown status"
endswitch

// ✅ Valid: Isolated case scopes
switch type
  case "user"
    var entity = fetchUser(id)
  case "post"
    var entity = fetchPost(id)  // Different local 'entity'
endswitch

// ❌ Invalid: Case fall-through doesn't exist
switch value
  case 1
    @data.result = "one"
    // No break needed, no fall-through possible
  case 2
    @data.result = "two"
endswitch
```

#### [CTRL-005] Nested control flow
```javascript
// RULE: Control structures nest with isolated scopes per block
// DIFFERENTIAL: Each level maintains scope isolation

// ✅ Valid: Nested if in for
for user in users
  if user.active
    var posts = fetchPosts(user.id)
    @data.active.push({ user: user, posts: posts })
  endif
endfor

// ✅ Valid: for in if
if shouldProcess
  for item in items
    @data.processed.push(process(item))
  endfor
endif

// ✅ Valid: switch in for
for item in items
  switch item.type
    case "A"
      @data.typeA.push(item)
    case "B"
      @data.typeB.push(item)
  endswitch
endfor
```

---

### Category: Error Handling

#### [ERR-001] Errors propagate as poison values
```javascript
// RULE: Failed operations produce Error objects that propagate
// DIFFERENTIAL: No exceptions thrown; errors are data values
// CONSTRAINT: Dependent operations become errors automatically

// ✅ Valid: Error propagation chain
var user = fetchUser(id)  // Fails -> Error
var name = user.name      // Error (depends on user)
var greeting = "Hello " + name  // Error (depends on name)
@data.result = greeting   // @data.result becomes Error

// ✅ Valid: Independent operations unaffected
var user = fetchUser(id)  // Fails
var posts = fetchPosts()  // Still executes successfully
@data.posts = posts       // Not affected by user error

// ❌ Invalid: Cannot catch errors mid-dataflow
var user = fetchUser(id)
var name = user.name || "Unknown"  // Error propagates through ||
```

#### [ERR-002] is error checks for poison values
```javascript
// RULE: 'is error' tests if value is an Error object
// DIFFERENTIAL: Predicate for error detection without try/catch

// ✅ Valid: Basic error check
var user = fetchUser(id)
if user is error
  @data.error = "Failed to fetch user"
else
  @data.name = user.name
endif

// ✅ Valid: Multiple error checks
var users = fetchUsers()
var posts = fetchPosts()
if users is error or posts is error
  @data.error = "Data fetch failed"
endif

// ✅ Valid: Negation
if user is not error
  @data.success = true
endif

// ❌ Invalid: Cannot catch specific error types
if user is NetworkError  // No such syntax
```

#### [ERR-003] Recovering from errors with fallbacks
```javascript
// RULE: Use 'is error' checks to provide fallback values
// PATTERN: Test before use to prevent error propagation

// ✅ Valid: Fallback value
var user = fetchUser(id)
if user is error
  set user = { name: "Guest", id: 0 }
endif
@data.greeting = "Hello, " + user.name

// ✅ Valid: Conditional output
var data = fetchData()
if data is error
  @data.error = "Failed to load"
  @data.fallback = defaultData
else
  @data.result = data
endif

// ✅ Valid: Error logging without stopping flow
var result = riskyOperation()
if result is error
  !context.logError(result)
  set result = defaultValue
endif
```

#### [ERR-004] Peek operator (#) for error introspection
```javascript
// RULE: # operator accesses error properties without propagation
// DIFFERENTIAL: Normal access (err.message) propagates; # does not
// CONSTRAINT: Must check 'is error' before peeking

// ✅ Valid: Peek at error message
var user = fetchUser(id)
if user is error
  @data.errorMsg = user#message  // Access message property
  @data.errorName = user#name
  @data.errorLine = user#lineno
endif

// ✅ Valid: Peek at sequential path error
!context.db.insert(data)  // Fails
if context.db! is error
  var msg = context.db!#message  // Peek at path error
  !context.logger.error(msg)
endif

// ❌ Invalid: Peek without checking is error first
var user = fetchUser(id)  // Succeeds
var msg = user#message  // Returns poison value - user not error

// ❌ Invalid: Peek on handler without check
@data.value = 42
var msg = @data#message  // Poison - @data not poisoned
```

#### [ERR-005] Handler poisoning by error assignment
```javascript
// RULE: Assigning Error to @handler poisons that handler
// DIFFERENTIAL: Handler becomes unusable until reverted
// CONSTRAINT: All subsequent operations on handler become errors

// ✅ Valid: Handler poisoning
var user = fetchUser(id)  // Fails -> Error
@data.user = user  // Poisons @data handler
@data.status = "ok"  // Also becomes Error (handler poisoned)

// ✅ Valid: Check before assignment to prevent poisoning
var user = fetchUser(id)
if user is not error
  @data.user = user  // Only assign if valid
endif

// ✅ Valid: Mixed handler states
@data.success = true  // @data OK
@text("Processing...")  // @text OK
@data.result = fetchData()  // Might poison @data
// @text remains unaffected even if @data poisoned
```

#### [ERR-006] Repairing sequential paths with !!
```javascript
// RULE: !! repairs poisoned sequential path before operation
// DIFFERENTIAL: Single ! continues poison; !! clears and executes
// CONSTRAINT: Only works on sequential paths (!), not handlers/variables

// ✅ Valid: Repair poisoned path
!context.db.connect()
!context.db.insert(data)  // Fails, poisons db!
!context.db.update(other)  // Skipped (path poisoned)
!!context.db.disconnect()  // Repairs path, then executes

// ✅ Valid: Check then repair
if context.api! is error
  var msg = context.api!#message  // Peek at error
  !!context.api.reset()  // Repair and reset
endif

// ❌ Invalid: !! on non-sequential path
var x = fetchData()
!!x.retry()  // Error: !! only for sequential paths

// ❌ Invalid: !! on handler
@data.value = failedOp()  // Poisons @data
!!@data.retry()  // Error: use _revert() for handlers
```

#### [ERR-007] Handler revert with _revert() and revert statement
```javascript
// RULE: @handler._revert() resets handler to scope start
// DIFFERENTIAL: Clears all writes and poison status
// CONSTRAINT: Revert point is current output scope boundary

// ✅ Valid: Revert specific handler
@data.timestamp = now()
@data.content = fetchContent()  // Fails, poisons @data
if @data is error
  @data._revert()  // Clears all @data writes
  @data.error = "Content unavailable"
endif

// ✅ Valid: Revert all handlers
@data.value = 1
@text("Started")
var result = riskyOp()  // Fails
if result is error
  @._revert()  // Clears all handlers (@data and @text)
  revert  // Same as @._revert()
endif

// ✅ Valid: Revert in capture scope
var message = capture :text
  @text("Processing...")
  var result = riskyOp()
  if result is error
    revert  // Reverts to start of this capture
    @text("Operation failed")
  endif
endcapture

// ❌ Invalid: Cannot revert subpaths
@data.user.name = "Alice"
@data.user._revert()  // Error: only root handlers
```

#### [ERR-008] guard block for transaction-like recovery
```javascript
// RULE: guard [targets...] protects state, auto-restores on failure
// DIFFERENTIAL: Automatic rollback vs manual error checking
// CONSTRAINT: recover block runs only if guard finishes poisoned

// ✅ Valid: Guard with default protection
guard  // Protects all handlers and sequential paths
  !context.db.beginTransaction()
  !context.db.insert(userData)
  !context.db.insert(profileData)
  @data.userId = userData.id
recover err
  // @data reverted, db! repaired automatically
  !context.db.rollback()
  @data.error = err#message
endguard

// ✅ Valid: Protection selector syntax
guard @             // All handlers
guard !             // All sequential paths
guard @data         // Specific handler
guard context.api!  // Specific path (hierarchical)
guard var1, var2    // Specific variables
guard *             // Everything (LIMIT-017)

// ✅ Valid: Selective protection
guard @data, context.db!, attempts
  set attempts = attempts + 1
  !context.db.save(data)
  @data.saved = true
recover err
  // Only @data, db!, and 'attempts' restored
  @data.error = "Save failed"
endguard

// ✅ Valid: No recover block (silent restore)
guard
  var result = riskyOperation()
  @data.result = result
endguard
// If poisoned, guard restores state and continues

// ❌ Invalid: Cannot access unguarded state in recover
var temp = "value"
guard @data
  @data.result = riskyOp()
recover err
  @data.temp = temp  // OK - temp not guarded
endguard
```

#### [ERR-009] Output scope boundaries for _revert()
```javascript
// RULE: _revert() restores to nearest scope boundary
// BOUNDARIES: guard, capture, macro, caller, include, script root
// DIFFERENTIAL: Revert checkpoint determined by scope nesting

// ✅ Valid: Revert in nested scopes
macro process()
  @data.start = now()
  var result = riskyOp()
  if result is error
    @data._revert()  // Reverts to macro start
    @data.error = "Failed"
  endif
endmacro

// ✅ Valid: Guard creates revert boundary
guard
  @data.attempt = 1
  var result = riskyOp()
  if result is error
    revert  // Reverts to guard start, not script start
  endif
recover
  // Guard buffer already reverted
endguard

// ✅ Valid: Capture creates boundary
var result = capture :data
  @data.value = compute()
  if @data.value is error
    revert  // Reverts to capture start
    @data.value = defaultValue
  endif
endcapture

// ✅ Valid: Nested revert scopes
guard
  var result = capture :data
    @data.inner = riskyOp()
    if @data.inner is error
      revert  // Reverts capture, not guard
    endif
  endcapture
  @data.outer = result
endguard
```

---

### Category: Functions & Operators

#### [FN-001] Function calls auto-await arguments
```javascript
// RULE: All function arguments automatically await promises
// DIFFERENTIAL: No manual await needed on any argument

// ✅ Valid: Promise arguments auto-await
var user = fetchUser(id)
var formatted = formatName(user.name)

// ✅ Valid: Multiple promise arguments
var result = combine(fetchA(), fetchB(), fetchC())

// ✅ Valid: Nested function calls
var text = upper(trim(user.name))
```

#### [FN-002] Operators auto-await operands
```javascript
// RULE: All operators (+, -, *, /, %, <, >, ==, etc.) await operands
// DIFFERENTIAL: Works on promises without .then()

// ✅ Valid: Arithmetic operators
var a = fetchNumber()
var b = fetchNumber()
var sum = a + b

// ✅ Valid: Comparison operators
var user = fetchUser(id)
if user.age > 18
  @data.adult = true
endif

// ✅ Valid: String concatenation
var first = fetchFirst()
var last = fetchLast()
var full = first + " " + last
```

#### [FN-003] Pipe operator (|) for transformations
```javascript
// RULE: | pipes value through chain of filters left-to-right
// DIFFERENTIAL: Auto-awaits input value before applying filter

// ✅ Valid: Single filter
var text = user.name | upper

// ✅ Valid: Chained filters
var clean = rawText | trim | lower | replace(" ", "_")

// ✅ Valid: Filters with arguments
var formatted = date | dateformat("YYYY-MM-DD")
var limited = items | slice(0, 5)

// ✅ Valid: Pipe on promise
var name = fetchUser(id) | upper

// ❌ Invalid: Cannot pipe into non-filter
var result = value | someFunction  // Error if not registered filter
```

#### [FN-004] Built-in filters
```javascript
// RULE: Standard filters available by default
// TYPES: upper, lower, trim, replace, length, default, safe

// ✅ Valid: String filters
@data.name = name | upper
@data.clean = text | trim
@data.slug = title | lower | replace(" ", "-")

// ✅ Valid: Utility filters
@data.count = items | length
@data.safe = userInput | default("N/A")
@data.html = content | safe  // Mark as safe HTML

// ✅ Valid: Custom filters via addFilter
// env.addFilter('double', x => x * 2)
@data.doubled = value | double
```

#### [FN-005] Defining custom filters
```javascript
// RULE: Register filters via env.addFilter(name, fn, isAsync)
// CONSTRAINT: Async filters must be marked with isAsync: true

// ✅ Valid: Sync filter
env.addFilter('capitalize', (str) => {
  return str.charAt(0).toUpperCase() + str.slice(1);
});
// Usage: @data.title = name | capitalize

// ✅ Valid: Async filter
env.addFilter('fetchData', async (id) => {
  return await database.fetch(id);
}, true);  // Must specify isAsync: true

// ❌ Invalid: Async filter without isAsync flag
env.addFilter('asyncOp', async (x) => await process(x));
// Missing isAsync: true causes incorrect execution
```

#### [FN-006] Logical operators short-circuit
```javascript
// RULE: and, or operators short-circuit evaluation
// DIFFERENTIAL: Right side not evaluated if result known from left

// ✅ Valid: and short-circuits
if user and user.active  // If user is falsy, user.active never evaluated

// ✅ Valid: or short-circuits
var name = user.name or "Guest"  // If user.name truthy, "Guest" not used

// ✅ Valid: Chained short-circuit
if a and b and c  // Stops at first falsy

// Note: Even with promises, short-circuit still applies
if fetchA() and fetchB()  // fetchB() not called if fetchA() is falsy
```

#### [FN-007] Ternary operator (condition ? true : false)
```javascript
// RULE: Ternary operator for inline conditionals
// DIFFERENTIAL: Auto-awaits condition and selected branch

// ✅ Valid: Basic ternary
var status = user.active ? "Active" : "Inactive"

// ✅ Valid: Ternary with promises
var display = fetchUser(id) ? "Has user" : "No user"

// ✅ Valid: Nested ternary
var level = score > 90 ? "A" : score > 80 ? "B" : "C"

// ✅ Valid: In @data assignment
@data.status = isValid ? "success" : "error"
```

---

### Category: Macros

#### [MACRO-001] Macro definition with parameters
```javascript
// RULE: macro name(param1, param2, ...) ... endmacro
// DIFFERENTIAL: Supports keyword arguments unlike JS functions
// CONSTRAINT: Parameters are local to macro scope

// ✅ Valid: Basic macro
macro greet(name)
  @data.greeting = "Hello, " + name
endmacro

// ✅ Valid: Multiple parameters
macro formatUser(firstName, lastName, age)
  @data.user.name = firstName + " " + lastName
  @data.user.age = age
endmacro

// ✅ Valid: Default parameter values
macro fetch(id, limit=10)
  var items = fetchItems(id, limit)
  @data.items = items
endmacro

// ❌ Invalid: Cannot use same parameter name twice
macro test(x, x)  // Error: duplicate parameter
```

#### [MACRO-002] Macro invocation with positional arguments
```javascript
// RULE: Call macros with arguments in definition order
// DIFFERENTIAL: Arguments auto-await like functions

// ✅ Valid: Positional arguments
macro greet(name)
  @data.message = "Hello, " + name
endmacro

greet("Alice")  // Positional

// ✅ Valid: Promise arguments auto-await
var user = fetchUser(id)
greet(user.name)

// ✅ Valid: Multiple arguments
macro format(first, last)
  @data.full = first + " " + last
endmacro

format("Alice", "Smith")
```

#### [MACRO-003] Macro invocation with keyword arguments
```javascript
// RULE: Call macros with name=value syntax for any/all parameters
// DIFFERENTIAL: Can skip parameters with defaults; order-independent

// ✅ Valid: Keyword arguments
macro greet(name, greeting="Hello")
  @data.message = greeting + ", " + name
endmacro

greet(name="Alice")  // Uses default greeting
greet(name="Bob", greeting="Hi")  // Override greeting
greet(greeting="Hey", name="Charlie")  // Order independent

// ✅ Valid: Mix positional and keyword (positional first)
macro format(first, last, middle="")
  @data.name = first + " " + middle + " " + last
endmacro

format("Alice", last="Smith", middle="M")

// ❌ Invalid: Keyword before positional
format(last="Smith", "Alice")  // Error: positional after keyword
```

#### [MACRO-004] Macros execute in isolated scope
```javascript
// RULE: Macro body has its own scope, can't access caller variables
// CONSTRAINT: Use parameters or context to pass data in

// ✅ Valid: Parameters pass data in
var userName = "Alice"
macro display(name)
  @data.user = name
endmacro
display(userName)

// ❌ Invalid: Cannot access caller's variables directly
var userName = "Alice"
macro display()
  @data.user = userName  // Error: userName not in scope
endmacro

// ✅ Valid: Access context properties
macro save()
  !context.db.save(context.currentUser)
endmacro
```

#### [MACRO-005] Tilde macros capture blocks
```javascript
// RULE: ~macroname syntax captures entire block as string
// CONSTRAINT: Macro must be defined with 'captureblock' parameter
// DIFFERENTIAL: Defers evaluation; useful for templates

// ✅ Valid: Define captureblock macro
macro template(captureblock)
  @data.html = "<div>" + captureblock + "</div>"
endmacro

// ✅ Valid: Invoke with tilde
~template
  <h1>Title</h1>
  <p>Content</p>

// Result: @data.html = "<div>\n  <h1>Title</h1>\n  <p>Content</p>\n</div>"

// ✅ Valid: Combine with regular parameters
macro wrap(tag, captureblock)
  @data.html = "<" + tag + ">" + captureblock + "</" + tag + ">"
endmacro

~wrap tag="section"
  Content here

// ❌ Invalid: Tilde on non-captureblock macro
macro normal(param)
  @data.value = param
endmacro
~normal  // Error: macro doesn't accept captureblock
```

#### [MACRO-006] Macro return values
```javascript
// RULE: Macros don't have explicit return; produce effects
// CONSTRAINT: Effects are @data assignments or context mutations

// ✅ Valid: Macro builds output
macro buildUser(id)
  var user = fetchUser(id)
  @data.user.id = user.id
  @data.user.name = user.name
endmacro

// ✅ Valid: Macro with side effects
macro log(message)
  !context.logger.log(message)
endmacro

// ❌ Invalid: No 'return' statement
macro compute(x)
  return x * 2  // Error: return not supported
endmacro

// Workaround: Use @data for output
macro compute(x)
  @data.result = x * 2
endmacro
```

---

### Category: Modules (Import, Include, Extends)

#### [MOD-001] import loads external script
```javascript
// RULE: import 'path/to/file.cas' brings in definitions
// DIFFERENTIAL: Imported macros/variables available in current scope
// CONSTRAINT: Path relative to current file or configured paths

// ✅ Valid: Import macros
// file: utils.cas
macro formatDate(date)
  @data.formatted = date | dateformat("YYYY-MM-DD")
endmacro

// file: main.cas
import 'utils.cas'
formatDate(now())  // formatDate available after import

// ✅ Valid: Multiple imports
import 'helpers.cas'
import 'formatters.cas'
import 'api.cas'

// ❌ Invalid: Cannot import non-existent file
import 'missing.cas'  // Runtime error
```

#### [MOD-002] include injects file content
```javascript
// RULE: include 'path' inserts file content at that point
// DIFFERENTIAL: Runs in current scope; shares variables
// CONSTRAINT: Included code has access to parent scope

// ✅ Valid: Include template fragment
// file: header.cas
@data.html.header = "<header>Site Header</header>"

// file: main.cas
include 'header.cas'  // @data.html.header now set
@data.html.body = "<body>Content</body>"

// ✅ Valid: Include can reference parent variables
// file: process.cas
var result = doSomething(inputVar)
@data.processed = result

// file: main.cas
var inputVar = fetchData()
include 'process.cas'  // Can access inputVar

// ❌ Invalid: Include doesn't isolate scope
// Changes in included file affect parent
```

#### [MOD-003] extends for template inheritance
```javascript
// RULE: extends 'base' + block definitions for template inheritance
// CONSTRAINT: extends must be first statement in file
// DIFFERENTIAL: Base template defines blocks, child overrides

// ✅ Valid: Base template
// file: base.cas
@data.html = "<html><head>"
block head
  @data.html += "<title>Default Title</title>"
endblock
@data.html += "</head><body>"
block content
  @data.html += "Default content"
endblock
@data.html += "</body></html>"

// ✅ Valid: Child template
// file: page.cas
extends 'base.cas'

block head
  @data.html += "<title>My Page</title>"
endblock

block content
  @data.html += "<h1>Hello World</h1>"
endblock

// ❌ Invalid: extends not first
import 'utils.cas'
extends 'base.cas'  // Error: extends must be first
```

#### [MOD-004] block definition and override
```javascript
// RULE: block name ... endblock defines overridable section
// DIFFERENTIAL: Child templates override by redefining block
// CONSTRAINT: Block names must match between base and child

// ✅ Valid: Block in base
block sidebar
  @data.sidebar = "Default sidebar"
endblock

// ✅ Valid: Override in child
extends 'base.cas'
block sidebar
  @data.sidebar = "Custom sidebar"
endblock

// ✅ Valid: Call parent block content
block content
  super()  // Include base template's content block
  @data.html += "Additional content"
endblock

// ❌ Invalid: Block name mismatch
// Base: block sidebar ... endblock
// Child: block sideBar ... endblock  // Case-sensitive, won't override
```

#### [MOD-005] Variable scope in imports/includes
```javascript
// RULE: import creates new scope; include shares scope
// DIFFERENTIAL: import isolates; include exposes
// CONSTRAINT: Use import for encapsulation, include for injection

// ✅ Valid: import isolation
// file: module.cas
var localVar = "secret"
macro exported()
  @data.value = "visible"
endmacro

// file: main.cas
import 'module.cas'
exported()  // Works
@data.test = localVar  // Error: localVar not accessible

// ✅ Valid: include sharing
// file: fragment.cas
var sharedVar = "value"

// file: main.cas
include 'fragment.cas'
@data.test = sharedVar  // Works: sharedVar accessible

// ❌ Invalid: Mixing expectations
import 'module.cas'
set localVar = "new"  // Error: localVar not in scope
```

---

### Category: Template Integration

#### [TEMP-001] Template syntax fallback
```javascript
// RULE: {% ... %} escapes to Nunjucks template syntax
// DIFFERENTIAL: Allows mixing script and template modes
// CONSTRAINT: Template syntax operates differently

// ✅ Valid: Inline template syntax
var name = "Alice"
{% if legacy_condition %}
  @data.legacy = true
{% endif %}

// ✅ Valid: Template for in script
var items = fetchItems()
{% for item in items %}
  @data.html += "<li>{{ item.name }}</li>"
{% endfor %}

// ❌ Invalid: Mixing syntaxes incorrectly
if condition  // Script syntax
  {% set x = 1 %}  // Template syntax (works but confusing)
endif
```

#### [TEMP-002] Variable interpolation {{ }}
```javascript
// RULE: {{ expression }} outputs value as string
// DIFFERENTIAL: Primarily for template mode; rare in script mode
// CONSTRAINT: Auto-escapes HTML unless marked safe

// ✅ Valid: In template string (uncommon in pure script)
var name = "Alice"
var html = "<h1>Hello {{ name }}</h1>"
// Better: Use concatenation in script mode
var html = "<h1>Hello " + name + "</h1>"

// ✅ Valid: Template mode interpolation
{% for user in users %}
  <li>{{ user.name }}</li>
{% endfor %}

// ✅ Valid: Safe HTML
var html = content | safe
{{ html }}  // Renders without escaping
```

#### [TEMP-003] Comments {# #}
```javascript
// RULE: {# ... #} for multi-line template comments
// DIFFERENTIAL: Alternative to // for legacy compatibility

// ✅ Valid: Script comment
// This is a comment

// ✅ Valid: Template comment
{# This is also a comment #}
{# Can span
   multiple lines #}

// ✅ Valid: Both in same file
var x = 10  // Script comment
{# Template comment #}
```

#### [TEMP-004] Raw blocks {% raw %} {% endraw %}
```javascript
// RULE: {% raw %} ... {% endraw %} disables template processing
// DIFFERENTIAL: Useful for literal {{ }} or {% %} in output

// ✅ Valid: Literal template syntax in output
@data.example = "{% raw %}Use {{ variable }} in templates{% endraw %}"

// ✅ Valid: Code examples in docs
{% raw %}
  var x = {{ value }}  // This won't be processed
{% endraw %}
```

---

### Category: API Reference

#### [API-001] AsyncEnvironment creation
```javascript
// RULE: new AsyncEnvironment(loaderPath, opts) creates engine instance
// CONSTRAINT: loaderPath optional; defaults to current directory

// ✅ Valid: Basic environment
const env = new AsyncEnvironment();

// ✅ Valid: With custom loader path
const env = new AsyncEnvironment('./scripts');

// ✅ Valid: With options
const env = new AsyncEnvironment('.', {
  autoescape: true,    // Auto-escape HTML
  throwOnUndefined: false,
  trimBlocks: true,
  lstripBlocks: true
});

// ✅ Valid: Add custom globals
env.addGlobal('API_KEY', process.env.API_KEY);
env.addGlobal('utils', { format: (x) => x.toUpperCase() });
```

#### [API-002] Script execution methods
```javascript
// RULE: renderScriptString(script, context, opts) executes inline script
// RETURNS: Promise<output> based on opts.output setting
// CONSTRAINT: script is string; context is object

// ✅ Valid: Execute with data output
const result = await env.renderScriptString(`
  var user = context.fetchUser(123)
  @data.greeting = "Hello, " + user.name
`, { fetchUser: async (id) => ({ name: "Alice" }) }, { output: 'data' });
// result: { greeting: "Hello, Alice" }

// ✅ Valid: Execute with text output
const html = await env.renderScriptString(`
  @data.html += "<h1>Title</h1>"
`, {}, { output: 'text' });
// html: "<h1>Title</h1>"

// ✅ Valid: Execute with custom handler
const result = await env.renderScriptString(script, context, {
  output: 'custom'
});
```

#### [API-003] renderScriptFile(path, context, opts)
```javascript
// RULE: Loads and executes script from file
// DIFFERENTIAL: Path resolution via loader configuration

// ✅ Valid: Execute file
const result = await env.renderScriptFile('scripts/main.cas', {
  userId: 123,
  apiKey: 'secret'
}, { output: 'data' });

// ✅ Valid: With relative paths
const env = new AsyncEnvironment('./scripts');
const result = await env.renderScriptFile('utils/process.cas', context);

// ❌ Invalid: File must exist
await env.renderScriptFile('nonexistent.cas', {});  // Throws error
```

#### [API-004] Compilation for reuse
```javascript
// RULE: compileScript(path, env, opts) compiles to reusable object
// RETURNS: AsyncScript with .render(context) method
// DIFFERENTIAL: Compile once, render multiple times for performance

// ✅ Valid: Compile and reuse
const compiled = await env.compileScript('main.cas');
const result1 = await compiled.render({ input: 'data1' });
const result2 = await compiled.render({ input: 'data2' });
const result3 = await compiled.render({ input: 'data3' });

// ✅ Valid: Compile string
const compiled = await env.compileScriptString(`
  @data.output = context.input | upper
`);

// Performance: Compilation is expensive; rendering is fast
```

#### [API-005] addGlobal(name, value)
```javascript
// RULE: Adds global variable/function accessible in all scripts
// DIFFERENTIAL: Available without context parameter

// ✅ Valid: Global variable
env.addGlobal('APP_VERSION', '1.0.0');
// In script: @data.version = APP_VERSION

// ✅ Valid: Global function
env.addGlobal('formatDate', (date) => {
  return date.toISOString().split('T')[0];
});
// In script: @data.date = formatDate(now())

// ✅ Valid: Global object with methods
env.addGlobal('utils', {
  slugify: (str) => str.toLowerCase().replace(/\s+/g, '-'),
  truncate: (str, len) => str.slice(0, len) + '...'
});
// In script: @data.slug = utils.slugify(title)
```

#### [API-006] addFilter(name, fn, isAsync)
```javascript
// RULE: Registers custom filter for | operator
// CONSTRAINT: Async filters must have isAsync: true

// ✅ Valid: Sync filter
env.addFilter('double', (x) => x * 2);
// Usage: @data.doubled = value | double

// ✅ Valid: Filter with arguments
env.addFilter('multiply', (x, factor) => x * factor);
// Usage: @data.result = value | multiply(3)

// ✅ Valid: Async filter
env.addFilter('fetchData', async (id) => {
  return await database.get(id);
}, true);  // isAsync: true required
// Usage: @data.item = itemId | fetchData

// ❌ Invalid: Async without flag
env.addFilter('asyncOp', async (x) => await fn(x));
// Missing isAsync: true - incorrect behavior
```

#### [API-007] addDataMethods(methods)
```javascript
// RULE: Extends @data with custom methods
// SIGNATURE: method(currentValue, ...args) => newValue
// CONSTRAINT: Must return value; no mutation

// ✅ Valid: Custom accumulator
env.addDataMethods({
  incrementBy: (current, amount) => (current || 0) + amount
});
// Usage: @data.counter.incrementBy(5)

// ✅ Valid: Multiple methods
env.addDataMethods({
  append: (current, item) => [...(current || []), item],
  prepend: (current, item) => [item, ...(current || [])],
  merge: (current, obj) => ({ ...(current || {}), ...obj })
});

// ✅ Valid: Method receives current value
env.addDataMethods({
  double: (current) => current * 2
});
// Usage: @data.value.double()  // If value is 5, becomes 10
```

#### [API-008] addCommandHandler / addCommandHandlerClass
```javascript
// RULE: Registers custom output handler for script results
// DIFFERENTIAL: Class creates new instance per run; instance is singleton

// ✅ Valid: Singleton handler
const myHandler = {
  start() { this.output = []; },
  handleData(path, value) { this.output.push({ path, value }); },
  finish() { return this.output; }
};
env.addCommandHandler('myhandler', myHandler);

// ✅ Valid: Factory class
class CustomHandler {
  constructor() { this.data = {}; }
  start() { /* init */ }
  handleData(path, value) {
    this.data[path.join('.')] = value;
  }
  finish() { return this.data; }
}
env.addCommandHandlerClass('custom', CustomHandler);

// Usage in script:
const result = await env.renderScriptString(script, context, {
  output: 'myhandler'
});
```

#### [API-009] Precompilation for production
```javascript
// RULE: precompileScript(path, opts) generates JS string
// DIFFERENTIAL: Eliminates parsing overhead; load with PrecompiledLoader
// CONSTRAINT: opts.env should match runtime environment

// ✅ Valid: Precompile to file
const { precompileScript } = require('cascada-engine');
const js = precompileScript('./scripts/main.cas', { env });
await fs.writeFile('./compiled/main.js', js);

// ✅ Valid: Load precompiled
const { PrecompiledLoader } = require('cascada-engine');
const loader = new PrecompiledLoader('./compiled');
const env = new AsyncEnvironment(loader);

const compiled = env.getPrecompiled('main');
const result = await compiled.render(context);

// ✅ Valid: Include env customizations
env.addGlobal('VERSION', '1.0');
env.addFilter('custom', customFn);
const js = precompileScript(path, { env });  // Includes customizations
```

#### [API-010] Context object requirements
```javascript
// RULE: Context is plain object passed to render methods
// DIFFERENTIAL: Properties can be values, promises, or async functions
// CONSTRAINT: Functions invoked automatically; promises awaited automatically

// ✅ Valid: Mixed context types
const context = {
  user: { name: "Alice", id: 123 },          // Plain object
  posts: fetchPosts(),                        // Promise
  fetchComments: async (id) => { /* */ },    // Async function
  config: {
    apiKey: process.env.API_KEY,
    timeout: 5000
  }
};

// ✅ Valid: Context with methods
const context = {
  db: {
    query: async (sql) => database.execute(sql),
    save: async (data) => database.insert(data)
  },
  logger: {
    log: (msg) => console.log(msg),
    error: (msg) => console.error(msg)
  }
};

// Script usage:
// var posts = context.fetchComments(postId)
// !context.db.save(userData)
```

---

## Constraint Index

| UID | Constraint | Reference |
|:----|:-----------|:----------|
| LIMIT-001 | `!` only on context properties | EXEC-007 |
| LIMIT-002 | Cannot read @data on right side | OUT-001 |
| LIMIT-003 | No direct property assignment on vars | VAR-002 |
| LIMIT-004 | Compound assignment only on @data | OUT-003 |
| LIMIT-005 | No root-level ! operator | EXEC-004 |
| LIMIT-006 | while loops rarely useful | CTRL-003 |
| LIMIT-007 | No explicit return in macros | MACRO-006 |
| LIMIT-008 | No try/catch/throw | ERR-001 |
| LIMIT-009 | extends must be first | MOD-003 |
| LIMIT-010 | No promise introspection | EXEC-003 |
| LIMIT-011 | Scope isolation in async mode | VAR-003 |
| LIMIT-012 | for iterations parallel | CTRL-002 |
| LIMIT-013 | capture only on right of = | CAPT-001 |
| LIMIT-014 | # peek requires is error | ERR-004 |
| LIMIT-015 | _revert() only on root | ERR-007 |
| LIMIT-016 | !! only on sequential paths | ERR-006 |
| LIMIT-017 | guard * reduces parallelism | ERR-008 |

---

## Document Usage Guide

**For AI code generation:**
1. Use semantic atoms as templates
2. Combine atoms following dependencies
3. Check constraint index for limitations

**For query resolution:**
- Use Sigil Table for syntax lookup
- Use Semantic Library for specific features
- Use Constraint Index for what's not possible

**For validation:**
- Match generated code against ✅ examples
- Check for ❌ anti-patterns
- Verify constraints not violated
- Confirm UID-referenced rules followed