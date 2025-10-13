# Cascada AI Agent Guide

## Project Overview

**Cascada** is a parallel-first scripting & templating engine for JavaScript/TypeScript that fundamentally inverts the traditional programming model: **parallel by default, sequential by exception**. Based on Nunjucks, it provides both a scripting language and template syntax with automatic, implicit concurrency.

### Core Philosophy

**Think Sequentially. Execute Concurrently.**

Write code that looks synchronous, and Cascada's engine handles complex concurrent execution automatically. Any variable can be a promise under the hood - pass it into functions, use it in expressions, assign it - all without thinking about async state.

### Key Differentiators

- ⚡ **Parallel by Default**: Independent operations run concurrently without special syntax
- 🚦 **Data-Driven Flow**: Code runs when inputs are ready, eliminating race conditions by design
- ✨ **Transparent Async**: Promises/async functions work seamlessly - no `await` needed in templates/scripts
- 📋 **Ordered Output**: Parallel execution, but results assembled in source-code order
- 🎭 **Two Modes**: Script (data orchestration) + Template (text generation)

## Two Execution Modes

### Cascada Script (Data-First)
- Clean, delimiter-free syntax (`var`, `if`, `for`, no `{% %}`)
- **Output Commands** (`@data`, `@text`, custom handlers) for declarative data assembly
- Focus on logic and orchestration (AI agents, data pipelines)
- Returns structured data objects

```javascript
// Example: AI orchestration
var plan = makePlan("Analyze competitor's feature")
for step in plan.steps
  var result = executeStep(step.instruction)
  @data.stepResults.push({step: step.title, result: result})
endfor
var summary = summarize(result.stepResults)
@data.summary = summary
```

### Cascada Template (Text-First)
- Familiar Nunjucks syntax (`{% %}`, `{{ }}`)
- Template composition (extends, include, import)
- Best for HTML, emails, LLM prompts
- Returns rendered text

```njk
{% set user = getUser() %}
{% set posts = getPosts(user.id) %}
<h1>{{ user.name }}</h1>
{% for post in posts %}
  <article>{{ post.title }}</article>
{% endfor %}
```

## Core Features

### 1. Automatic Parallelization

**Independent operations run concurrently without configuration:**

```javascript
// Both calls execute in parallel
var user = fetchUser(123)
var config = fetchSiteConfig()

// Wait for both before use
@data.greeting = "Welcome, " + user.name
```

**Data dependencies are automatically respected:**

```javascript
var user = getUser()          // Runs immediately
var posts = getPosts(user.id) // Waits for user
var footer = getFooter()      // Runs in parallel with getUser
```

### 2. Sequential Execution Control (`!`)

For side effects that need strict ordering, use the `!` marker:

```javascript
var account = getBankAccount()
account!.deposit(100)    // 1. Deposit first
account.getStatus()      // 2. Get status (waits for deposit)
account!.withdraw(50)    // 3. Withdraw (waits for getStatus)
```

**Important constraints:**
- Only works on **static paths from context variables**
- Cannot use with template variables: `{% set x = ctx %}{{ x!.method() }}` ❌
- Cannot use with dynamic lookups: `items[i]!.method()` ❌

### 3. Output Commands (`@` - Scripts Only)

Scripts use **Output Commands** to build results via "Collect, Execute, Assemble" model:

**Built-in handlers:**
- `@data` - Build structured data (objects/arrays)
- `@text` - Generate text output
- Custom handlers - Domain-specific logic

**The `@data` handler:**

```javascript
// Assignment & manipulation
@data.user.name = "Alice"
@data.user.logins = 0
@data.user.logins++

// Arrays
@data.user.roles.push("editor")
@data.users.concat([newUser])

// Objects
@data.settings.merge({theme: "dark"})

// Arithmetic
@data.counter += 5
@data.total *= 1.05

// Strings
@data.log.append(" Login successful")
```

**Output focusing:**
Use `:data` or `:text` to return just that output:

```javascript
:data  // Returns just the data object

@data.result = processData()
@text("Processing complete")
// Returns: {result: {...}} instead of {data: {result: {...}}, text: "..."}
```

### 4. Macros & Reusable Components

**Scripts:**
```javascript
macro buildUserSummary(userId) : data
  var details = fetchUserDetails(userId)
  var posts = fetchUserPosts(userId)

  @data.name = details.name
  @data.postCount = posts.length
endmacro

var user1 = buildUserSummary(101)
@data.users.push(user1)
```

**Templates:**
```njk
{% macro profile_widget(user) %}
  <div>
    <h2>{{ user.name }}</h2>
    <p>Followers: {{ fetchStats(user.id).followers }}</p>
  </div>
{% endmacro %}

{{ profile_widget(currentUser) }}
```

### 5. Error Handling (Under Development)

**Resilient error handling with retry logic:**

```javascript
try
  var image = generateImage(prompt)
  @data.imageUrl = image.url
resume resume.count < 3
  @text("Retrying attempt " + resume.count)
except
  @data.error = "Failed: " + error.message
endtry
```

## API Quick Reference

### AsyncEnvironment (Main API)

```javascript
import { AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();

// Render template from string (returns text)
const html = await env.renderTemplateString(template, context);

// Render template from file (returns text)
const html = await env.renderTemplate('template.njk', context);

// Execute script from string (returns data/result object)
const result = await env.renderScriptString(script, context, {output: 'data'});

// Execute script from file (returns data/result object)
const result = await env.renderScript('script.casc', context);

// Add globals
env.addGlobal('utils', myUtils);

// Add filters
env.addFilter('myFilter', async (val) => transform(val));

// Extend @data handler
env.addDataMethods({
  incrementBy: (target, amount) => (target || 0) + amount
});

// Add custom output handler
env.addCommandHandlerClass('myHandler', MyHandlerClass);
```

### Loaders

```javascript
import { FileSystemLoader, PrecompiledLoader } from 'cascada-engine';

const env = new AsyncEnvironment([
  new FileSystemLoader('templates'),
  new PrecompiledLoader(precompiledData)
]);
```

## Testing & Development

### Test Commands

```bash
# Quick tests (no build)
npm run test:quick
npm run mocha

# Full test suite
npm test                    # All tests (node + browser)
npm run test:node          # Node tests only
npm run test:browser       # Browser tests only
npm run test:pasync        # Async/poison tests

# Specific test debugging - USE .only()
# In test file, add .only() to focus on specific tests:
it.only('should handle async operations', async () => {
  // Your test
});

describe.only('Async features', () => {
  // Only this suite runs
});
```

**Important:** When debugging, use `.only()` on `it()` or `describe()` to run specific tests, not the entire suite.

### Build Commands

```bash
npm run build              # Full build (lint + transpile + bundle)
npm run lint              # ESLint check
npm run test:prep         # Build + precompile for tests
```

### Test Assertions (expect.js)

The test suite uses **expect.js** (not Chai). Key assertion methods:

```javascript
// Basic assertions
expect(value).to.be(expected)           // === equality
expect(value).to.eql(expected)          // Deep equality (objects/arrays)
expect(value).to.be.ok()                // Truthy
expect(value).to.be.a('string')         // Type checking
expect(value).to.be.an(Array)           // instanceof

// Collections
expect(arr).to.have.length(3)
expect(arr).to.contain(item)
expect(arr).to.be.empty()
expect(obj).to.have.property('key')
expect(obj).to.have.key('key')
expect(obj).to.only.have.keys('a', 'b')

// Strings
expect(str).to.match(/pattern/)
expect(str).to.contain('substring')

// Functions & Errors
expect(fn).to.throwException()
expect(fn).to.throwException(/error message/)
expect(fn).withArgs(arg1, arg2).to.throwException()

// Ranges
expect(num).to.be.within(0, 100)
expect(num).to.be.above(5)
expect(num).to.be.below(10)

// Negation
expect(value).to.not.be(other)
expect(value).to.not.eql(other)
```

**Async Testing Patterns:**

```javascript
// Testing for errors in async functions
it('should throw error', async () => {
  try {
    await env.renderTemplateString(badTemplate, context);
    expect().fail('Should have thrown');
  } catch (err) {
    expect(err).to.be.a(TemplateError);
    expect(err.message).to.contain('expected error');
  }
});

// Testing PoisonError (multiple errors collected)
it('should collect all errors', async () => {
  try {
    await env.renderTemplateString(template, context);
    expect().fail('Should have thrown');
  } catch (err) {
    expect(isPoisonError(err)).to.be(true);
    expect(err.errors).to.be.an('array');
    expect(err.errors).to.have.length(2);
    expect(err.errors[0].message).to.contain('first error');
  }
});
```

### Key Files

```
src/compiler/
  ├── compiler.js        # Main compiler - AST traversal, code generation
  ├── compile-async.js   # Async block compilation
  ├── compile-emit.js    # Code emission helpers
  ├── compile-sequential.js  # Sequential execution (`!`) analysis
  └── compiler-base.js   # Base class - expression compilation, basic helpers

src/
  ├── runtime.js         # Runtime helpers (resolveAll, flattenBuffer, etc.)
  ├── environment.js     # AsyncEnvironment class
  ├── transformer.js     # AST transformations
  ├── data-handler.js    # @data implementation
  ├── parser.js          # Nunjucks parser
  ├── lexer.js           # Template lexer
  └── script-*.js        # Script-specific features

tests/
  ├── *.js               # Main test suites
  ├── pasync/            # Async execution tests
  └── poison/            # Error handling tests

docs/
  ├── cascada/           # User documentation
  └── code/              # Implementation guides
```

## Implementation Architecture

### Async Execution Model

**Core Principles:**
1. **Transparent Asynchronicity**: Promises as first-class values
2. **Non-Blocking Execution**: Wrap operations in async IIFEs
3. **Deferred Resolution**: Resolve promises only when values needed
4. **State Synchronization**: Variable snapshots + promise-based locking
5. **Ordered Output**: Hierarchical buffer preserves source order

**Key Runtime Components:**
- `AsyncFrame`: Manages async variable state (snapshots, writeCounters, promiseResolves)
- `AsyncState`: Tracks active blocks, completion waiting
- `runtime.resolveAll/resolveDuo/resolveSingle`: Concurrent promise resolution
- `runtime.flattenBuffer`: Assembles final output in correct order

### Variable Synchronization

**Two-level tracking system:**
1. **Frame Snapshots**: Capture variable state at async block creation
2. **Promise Locks**: Variables modified concurrently replaced with promises
3. **Write Counting**: Track potential writes across all code paths
4. **Completion Signaling**: Child blocks signal parent when done

```javascript
// Compiler calculates writeCounters for all possible paths
// Runtime uses these to create promise locks
frame.pushAsyncBlock(reads, writeCounters)
frame._promisifyParentVariables() // Creates locks
// After writes complete:
frame._countdownAndResolveAsyncWrites() // Releases locks
```

### Sequential Operations (`!`)

**Implementation:**
- **Sequence Keys**: Unique identifiers for execution lanes (e.g., `!account!deposit`)
- **Compiler Analysis**: `_declareSequentialLocks` pass identifies all `!` markers
- **Runtime Helpers**: `sequencedCallWrap`, `sequencedMemberLookupAsync`
  - Acquire: `await runtime.awaitSequenceLock(sequenceKey)`
  - Operate: Execute the actual function/lookup
  - Release: `frame.set(sequenceKey, ...)` resolves promise
- **AsyncFrame Integration**: Sequence keys use same promise-locking as variables

### Error Handling (Poison Values)

**Core Principle: "Never Miss Any Error"**
- Always await ALL promises and collect ALL errors before deciding
- Use `continue` not `return` in error collection loops

**Two Types:**
1. **PoisonedValue**: Thenable with `.errors[]` array (before await)
2. **PoisonError**: Error thrown when awaiting PoisonedValue

**Detection:**
```javascript
// Check BEFORE await
if (isPoison(value)) { ... }

// Check in catch block
catch (err) {
  if (isPoisonError(err)) {
    errors.push(...err.errors); // Extract array!
  }
}

// NEVER check after await - impossible
const result = await asyncFunc();
if (isPoison(result)) { } // ❌ Never true
```

**Function Patterns:**
1. **Pure Sync**: Can return PoisonedValue directly
2. **Sync-First Hybrid**: Return values OR poison, delegate complex to async helper
3. **Pure Async**: MUST throw PoisonError, cannot return PoisonedValue

### Output Handler System

**Collect, Execute, Assemble:**
1. **Collect**: Buffer `@` commands during execution
2. **Execute**: All logic runs (parallel where possible)
3. **Assemble**: Buffered commands execute sequentially in source order

**Implementation:**
- Commands are objects: `{handler: 'data', command: 'push', arguments: [...], pos: {...}}`
- `flattenBuffer` processes commands after all async work completes
- Custom handlers: Implement `getReturnValue()` to contribute to result

## Common Patterns & Best Practices

### Parallel Data Fetching
```javascript
// All fetches run concurrently
for userId in userIds
  var user = fetchUser(userId)
  @data.users.push({id: userId, name: user.name})
endfor
```

### Conditional Data Assembly
```javascript
var user = getUser()
if user.isPremium
  @data.features = fetchPremiumFeatures()
else
  @data.features = getBasicFeatures()
endif
```

### Using Capture for Inline Assembly
```javascript
var profile = capture :data
  var details = fetchDetails(userId)
  var stats = fetchStats(userId)

  @data.name = details.name
  @data.posts = stats.postCount
endcapture

@data.userProfile = profile
```

### Sequential DB Operations
```javascript
each record in records
  var newRecord = db!.create(record)
  db!.addMetadata(newRecord.id, metadata)
endeach
```

## Important Notes for AI Agents

### DO:
- ✅ Use `.only()` to focus tests when debugging
- ✅ Check `isPoison()` BEFORE await, `isPoisonError()` in catch
- ✅ Spread `.errors` array when collecting: `errors.push(...err.errors)`
- ✅ Use `!` on static context paths for side effects
- ✅ Focus output with `:data` or `:text` for clean returns
- ✅ Use macros with output focus for reusable data components

### DON'T:
- ❌ Check `isPoison()` after await (impossible)
- ❌ Return PoisonedValue from async functions (must throw)
- ❌ Use `!` on template variables or dynamic lookups
- ❌ Short-circuit error collection (await ALL promises)
- ❌ Use `instanceof` for poison detection (use `isPoison()`)
- ❌ Modify sync error handling (async mode only)

### Documentation References

**User Docs:**
- `docs/cascada/script.md` - Complete script language guide
- `docs/cascada/template.md` - Template syntax (somewhat outdated)
- `README.md` - High-level overview

**Implementation Docs:**
- `docs/code/Async - Implementation.md` - Async execution architecture
- `docs/code/Error Handling Guide.md` - Error system design
- `docs/code/Poisoning - Output Handler Implementation.md` - Poison value details
- `docs/code/Sequential Operations - Execution.md` - `!` marker implementation
- `docs/code/Sequential Operations - In Expressions.md` - Expression-level sequencing

### Current Development Status

**Under Development:**
- Error handling (`try/resume/except`) - Partially implemented
- Cross-script dependencies (`extern`, `reads`, `modifies`) - Planned
- Reading from `@data` (right-side @ access - @data.people[0].company = @data.company) - Not implemented
- Enhanced error reporting with code snippets - In progress

**Stable:**
- Core async execution model
- Output command system
- Sequential execution (`!`)
- Template/Script rendering
- Macros and composition

---

**Package**: `cascada-engine`
**Repository**: https://github.com/geleto/cascada
**Related**: [Cascador-AI](https://github.com/geleto/cascador-ai) - AI framework built on Cascada

