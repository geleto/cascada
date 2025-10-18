# Cascada Poison Value Implementation: Complete Reference Guide

## Part 1: Foundational Concepts

### The Core Principle: Never Miss Any Error

**FUNDAMENTAL DESIGN PRINCIPLE:**
> When processing multiple async operations in parallel, we MUST await ALL promises and collect ALL errors before making any decisions. No error shall be lost, even if we've already found other errors.

#### Why This Principle Exists

**Traditional Eager Failure (what we DON'T want):**
```javascript
// Traditional async code - STOPS at first error
async function processItems(items) {
  for (const item of items) {
    const result = await process(item);  // If this throws, we stop
    if (isError(result)) {
      return result;  // Return immediately, ignoring remaining items
    }
  }
}

// Result: User only sees FIRST error
// Problem: Items 2-5 might also have errors, but user never knows
```

**Cascada's Complete Error Collection (what we DO want):**
```javascript
// Cascada approach - COLLECTS ALL errors
async function processItems(items) {
  const errors = [];

  for (const item of items) {
    try {
      const result = await process(item);
      if (isError(result)) {
        errors.push(result);
        continue;  // KEEP GOING to find more errors
      }
    } catch (err) {
      errors.push(err);
      continue;  // KEEP GOING to find more errors
    }
  }

  if (errors.length > 0) {
    return createPoison(errors);  // Return ALL errors at once
  }
}

// Result: User sees ALL errors at once
// Benefit: Fix all problems in one iteration
```

#### Real-World Impact

**Template Example:**
```html
{{ asyncFunc1() }} + {{ asyncFunc2() }} + {{ asyncFunc3() }}
```

**Without "Never Miss Any Error":**
- First render: see error from `asyncFunc1()` → fix it
- Second render: see error from `asyncFunc2()` → fix it
- Third render: see error from `asyncFunc3()` → fix it
- **Result:** 3 debug cycles to fix 3 errors

**With "Never Miss Any Error":**
- First render: see ALL errors from `asyncFunc1()`, `asyncFunc2()`, AND `asyncFunc3()`
- **Result:** 1 debug cycle to fix all 3 errors

#### How It's Implemented

**1. Always Await ALL Promises Before Deciding:**
```javascript
async function callWrapAsync(obj, name, context, args) {
  // Even if obj is poison, MUST await all arg promises
  const errors = [];

  if (isPoison(obj)) {
    errors.push(...obj.errors);  // Collect, but DON'T return yet
  }

  // MUST await ALL args to find their errors too
  const argErrors = await collectErrors(args);
  errors.push(...argErrors);

  // NOW we have ALL errors
  if (errors.length > 0) {
    return createPoison(errors);
  }
}
```

**2. Use `continue` Not `return` in Loops:**
```javascript
for (const item of items) {
  if (isPoison(item)) {
    errors.push(...item.errors);
    continue;  // ✅ KEEP GOING
    // NOT: return createPoison(...)  ❌ Would stop here
  }

  if (item && typeof item.then === 'function') {
    try {
      item = await item;
    } catch (err) {
      errors.push(...(isPoisonError(err) ? err.errors : [err]));
      continue;  // ✅ KEEP GOING
    }
  }
}
```

**3. Deterministic Order:**
- Errors are collected in the order they appear in the code
- Parallel operations wait for ALL to complete before reporting
- User sees consistent error messages across runs

#### Benefits of This Principle

✅ **Better Developer Experience:** See all problems at once, not one-at-a-time
✅ **Faster Debugging:** Fix multiple issues in one iteration
✅ **Deterministic Behavior:** Same errors every time, not race-dependent
✅ **Complete Information:** No hidden errors waiting to surprise you
✅ **Parallel-Safe:** Works correctly even with Promise.all or parallel execution

#### The Contract

When you see `collectErrors()`, `callWrapAsync()`, or `deepResolveArray()`:
- **Contract:** They will find and collect EVERY error in their inputs
- **Guarantee:** No promise will be ignored, no error will be lost
- **Behavior:** ALL async operations complete before returning
- **Result:** Complete error information or complete success

This principle is why error collection code looks "verbose" - we're being thorough, not paranoid.

---

### The Two Types of Poison

**PoisonedValue** - A thenable object that contains errors:
- Has a `.then()` method (implements thenable protocol)
- Contains an `.errors` array with one or more Error objects
- Has `[POISON_KEY] = true` for detection
- **IS a Promise-like object** (thenable)
- Used to propagate errors through the data flow as VALUES

**PoisonError** - An Error thrown when awaiting a PoisonedValue:
- Extends Error
- Contains the same `.errors` array
- Has `[POISON_ERROR_KEY] = true` for detection
- Used when poison transitions from value to exception

### How They Interact with JavaScript's Async System

```javascript
class PoisonedValue {
  constructor(errors) {
    this.errors = Array.isArray(errors) ? errors : [errors];
    this[POISON_KEY] = true;
  }

  then(onFulfilled, onRejected) {
    const error = new PoisonError(this.errors);
    if (onRejected) {
      try {
        return onRejected(error);
      } catch (e) {
        // Handler threw - return new poison with the new error
        // Matches Promise behavior: replaces error, doesn't accumulate
        return createPoison(e);
      }
    }
    return this;
  }
}

class PoisonError extends Error {
  constructor(errors) {
    super(buildMessage(errors));
    this.name = 'PoisonError';
    this.errors = deduplicateAndFlattenErrors(errors);
    this[POISON_ERROR_KEY] = true;
  }
}
```

### Three Function Return Patterns

**Pattern 1: Pure Synchronous Functions**
- Never declared with `async`
- Can return PoisonedValue directly
- Example: `callWrap()`, `memberLookup()`

```javascript
function callWrap(obj, name, context, args) {
  if (isPoison(obj)) {
    return obj; // Returns PoisonedValue directly
  }
  // ... rest of logic
}
```

**Pattern 2: Sync-First Hybrid Functions**
- NOT declared with `async` keyword
- Return literal values synchronously when possible
- Return poison values directly (thenable protocol handles conversion)
- Delegate to async helper for complex cases
- Example: `suppressValueAsync()`, `ensureDefinedAsync()`

```javascript
function suppressValueAsync(val, autoescape) {
  // Sync poison check - return poison directly
  // When awaited, thenable protocol converts to PoisonError automatically
  if (isPoison(val)) {
    return val;
  }

  // Sync literal - return value directly
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return suppressValue(val, autoescape);
  }

  // Complex - delegate to async
  return _suppressValueAsyncComplex(val, autoescape);
}

async function _suppressValueAsyncComplex(val, autoescape) {
  // This MUST throw PoisonError, not return poison
  if (isPoison(val)) {
    throw new PoisonError(val.errors);
  }
  // ...
}
```

**Pattern 3: Pure Async Functions**
- Declared with `async` keyword
- MUST throw PoisonError, cannot return PoisonedValue
- Example: `sequencedCallWrap()`, all `_complex` helpers

```javascript
async function sequencedCallWrap(...) {
  if (isPoison(val)) {
    throw new PoisonError(val.errors); // MUST throw
  }
  // ...
}
```

### Critical Execution Flow: Why await Cannot Return PoisonedValue

**FUNDAMENTAL RULE: `await` CANNOT return a PoisonedValue.**

Why? Because PoisonedValue is a thenable (Promise-like object), and JavaScript's `await` unwraps ALL thenables:

```javascript
// When you await a thenable, JavaScript does this:
// 1. Calls thenable.then(onFulfilled, onRejected)
// 2. Recursively unwraps if result is also thenable
// 3. Returns final non-thenable value OR throws

// Our PoisonedValue.then() immediately throws:
then(onFulfilled, onRejected) {
  throw new PoisonError(this.errors);
}

// Therefore:
const result = await poisonValue; // Throws PoisonError
// The assignment NEVER happens
```

**The Only Two Outcomes of await:**
1. **Success path**: Returns a non-thenable value (string, number, object, array, etc.)
2. **Error path**: Throws an error (PoisonError or other Error)

**Where to Check:**
- Check `isPoison(value)` **BEFORE** await (on the thenable itself)
- Check `isPoisonError(err)` **IN catch block** (on thrown errors)
- **NEVER** check `isPoison(result)` after await (impossible to be true)

### Detection Functions

```javascript
// Check if a VALUE is a PoisonedValue (before await)
function isPoison(value) {
  return value != null && value[POISON_KEY] === true;
}

// Check if a CAUGHT ERROR is a PoisonError (in catch block)
function isPoisonError(err) {
  return err != null && err[POISON_ERROR_KEY] === true;
}
```

**Usage:**
- Use `isPoison()` on values you haven't awaited yet
- Use `isPoison()` on return values from NON-async functions
- Use `isPoison()` on return values from sync-first hybrid functions (before awaiting)
- Use `isPoisonError()` on errors caught in catch blocks
- **Never** use `isPoison()` on the result of await (as it will just throw if poison)
- **Never** use `isPoison()` directly on return value of async function

---

## Part 2: Critical Bugs to Avoid

### Bug #1: Returning PoisonedValue from Async Function

**❌ WRONG:**
```javascript
async function process(val) {
  if (isPoison(val)) {
    return val; // BUG! Wraps in Promise<PoisonedValue>
  }
  return await doWork(val);
}

// Caller:
try {
  const result = await process(poison);
  // Never reaches here - throws PoisonError
  if (isPoison(result)) { // Never true!
    // ...
  }
} catch (err) {
  // PoisonError ends up here
}
```

**Why it fails:**
- `async` keyword wraps ALL returns in Promise
- `return poison` becomes `Promise.resolve(poison)`
- When caller awaits, poison's `.then()` throws PoisonError
- Result assignment never happens

**✅ CORRECT:**
```javascript
async function process(val) {
  if (isPoison(val)) {
    throw new PoisonError(val.errors); // Throw directly
  }
  return await doWork(val);
}
```

### Bug #2: Forgetting Sync-First Hybrid Pattern

**❌ WRONG:**
```javascript
async function suppressValueAsync(val, autoescape) {
  if (isPoison(val)) {
    throw new PoisonError(val.errors);
  }
  // Even for literal "hello", we create a Promise!
  return suppressValue(val, autoescape);
}
```

**Why suboptimal:**
- Creates Promise wrapper for every literal value
- Template `{{ "hello" }}` pays async overhead unnecessarily
- Loses 30-40% of fast path cases

**✅ CORRECT - Sync-First Pattern:**
```javascript
function suppressValueAsync(val, autoescape) {
  // NOT async keyword!
  if (isPoison(val)) {
    return val;  // Return poison directly - thenable protocol handles it
  }

  // Fast path for literals
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return suppressValue(val, autoescape); // Direct return
  }

  // Only complex cases use async
  return _suppressValueAsyncComplex(val, autoescape);
}

async function _suppressValueAsyncComplex(val, autoescape) {
  // Helper IS async, so must throw
  // ...
}
```

### Bug #3: Checking isPoison() After Await

**❌ WRONG:**
```javascript
const result = await someAsyncFunc();
if (isPoison(result)) {  // IMPOSSIBLE - never true
  errors.push(...result.errors);
}
```

**Why this is impossible:**
- PoisonedValue is a thenable
- `await` unwraps all thenables by calling `.then()`
- Our `.then()` throws PoisonError
- Therefore `await poisonValue` always throws, never returns

**What actually happens:**
```javascript
// Step by step:
const poison = createPoison(err);     // Create PoisonedValue
const result = await poison;           // Calls poison.then(...)
                                       // which throws PoisonError
                                       // Execution jumps to catch
if (isPoison(result)) {               // This line NEVER executes
```

**✅ CORRECT:**
```javascript
// Check BEFORE await (sync-first hybrid):
const value = hybridFunction();
if (isPoison(value)) {
  return value;
}

// After await, handle in catch:
try {
  const result = await asyncFunction();
  // Only reached if NOT poison
  return result;
} catch (err) {
  if (isPoisonError(err)) {
    return createPoison(err.errors);
  }
  throw err;
}
```

### Bug #4: Wrong Check Order in Resolution Functions

**❌ WRONG:**
```javascript
if (Array.isArray(value)) {
  // Process array
} else if (value && typeof value.then === 'function') {
  // Never reached if value is Promise.resolve([...])
}
```

**Why it fails:**
- `Promise.resolve([1,2,3])` is a promise that RESOLVES to an array
- Checking `Array.isArray()` on the promise returns false
- Must check for promise first, await it, THEN check structure

**✅ CORRECT ORDER:**
```javascript
// 1. Check if already poison
if (isPoison(item)) {
  errors.push(...item.errors);
  continue;
}

// 2. Check if promise/thenable FIRST
if (item && typeof item.then === 'function') {
  try {
    item = await item;
  } catch (err) {
    if (isPoisonError(err)) {
      errors.push(...err.errors);
    } else {
      errors.push(err);
    }
    continue;
  }
}

// 3. NOW check structure
if (Array.isArray(item)) {
  // Recurse
}
```

### Bug #5: Using instanceof for Detection

**❌ WRONG:**
```javascript
catch (err) {
  if (err instanceof PoisonError) {
    // Fails after transpilation
  }
}
```

**Why it fails:**
- Babel/Webpack create multiple copies of classes
- `instanceof` compares constructor references
- PoisonError from module A ≠ PoisonError from module B
- Breaks in bundled/transpiled code

**✅ CORRECT:**
```javascript
const POISON_ERROR_KEY = Symbol.for('cascada.poisonError');

class PoisonError extends Error {
  constructor(errors) {
    super(message);
    this[POISON_ERROR_KEY] = true;
  }
}

function isPoisonError(err) {
  return err != null && err[POISON_ERROR_KEY] === true;
}

catch (err) {
  if (isPoisonError(err)) {
    errors.push(...err.errors);
  }
}
```

### Bug #6: Short-Circuiting Error Collection (Violates "Never Miss Any Error")

**❌ WRONG:**
```javascript
for (const item of items) {
  try {
    await processItem(item);
  } catch (err) {
    return createPoison(err); // ❌ STOPS HERE - misses remaining items
  }
}
```

**Why it's wrong:**
- Returns immediately on first error
- Remaining items never processed
- User only sees ONE error, even if items 2-5 also have errors
- Violates "never miss any error" principle
- Forces user to fix errors one-at-a-time

**✅ CORRECT:**
```javascript
const errors = [];
for (const item of items) {
  try {
    await processItem(item);
  } catch (err) {
    if (isPoisonError(err)) {
      errors.push(...err.errors);
    } else {
      errors.push(err);
    }
    continue; // ✅ KEEP GOING - find ALL errors
  }
}

if (errors.length > 0) {
  return createPoison(errors);  // Return ALL errors at once
}
```

**Why it's correct:**
- Processes ALL items even after finding errors
- Collects every single error
- User sees complete error information
- Follows "never miss any error" principle
- User can fix all problems in one iteration

### Bug #7: Forgetting to Extract .errors Array

**❌ WRONG:**
```javascript
catch (err) {
  if (isPoisonError(err)) {
    errors.push(err); // Pushing wrapper
  }
}

// Result: errors = [PoisonError, PoisonError]
// Want:   errors = [Error1, Error2, Error3]
```

**Why it fails:**
- PoisonError is a container
- The actual errors are in `err.errors[]` array
- Pushing the container creates nested structure
- Later deduplication and reporting breaks

**✅ CORRECT:**
```javascript
catch (err) {
  if (isPoisonError(err)) {
    errors.push(...err.errors); // Spread the array
  } else {
    errors.push(err);
  }
}
```

---

## Part 3: When CAN You Use Synchronous Propagation?

### Pattern 1: Pure Synchronous Functions

You can check `isPoison()` and return PoisonedValue when:
- Function is NOT declared with `async`
- Function returns immediately without await
- Example: `callWrap()`, `memberLookup()`

```javascript
function callWrap(obj, name, context, args) {
  if (isPoison(obj)) {
    return obj; // Direct return of PoisonedValue
  }

  const poisonedArgs = args.filter(isPoison);
  if (poisonedArgs.length > 0) {
    return createPoison(poisonedArgs.flatMap(p => p.errors));
  }

  // ... rest of sync logic
}
```

### Pattern 2: Sync-First Hybrid Functions

You can return values OR poison values synchronously when:
- Function is NOT declared with `async`
- You check for simple cases first
- Delegate complex cases to async helper
- Example: `suppressValueAsync()`, `ensureDefinedAsync()`, `callWrapAsync()`

```javascript
function suppressValueAsync(val, autoescape) {
  // Poison → return poison directly (thenable protocol converts when awaited)
  if (isPoison(val)) {
    return val;
  }

  // Literal → return value directly (NO promise wrapper)
  if (!val || (typeof val.then !== 'function' && !Array.isArray(val))) {
    return suppressValue(val, autoescape);
  }

  // Complex → delegate to async helper
  return _suppressValueAsyncComplex(val, autoescape);
}
```

**Benefits:**
- 30-40% of calls return immediately
- No Promise allocation for literals or poison values
- Template `{{ "hello" }}` is fast
- Poison values are returned synchronously, converted via thenable protocol when awaited

### Pattern 3: Pure Async Functions

You CANNOT return PoisonedValue, MUST throw:
- Function IS declared with `async`
- All returns are wrapped in Promise
- Must throw PoisonError for poison
- Example: `sequencedCallWrap()`, `_suppressValueAsyncComplex()`

```javascript
async function sequencedCallWrap(...) {
  if (isPoison(val)) {
    throw new PoisonError(val.errors); // MUST throw
  }

  const result = await doWork();
  return result; // OK - non-poison value
}
```

**Why you MUST throw:**
- `return createPoison(err)` becomes `Promise.resolve(poison)`
- Caller awaits → poison's `.then()` → throws PoisonError
- Caller never sees the return value
- So just throw directly

---

## Part 4: The Complete Correct Patterns

### Template for Pure Sync Functions

```javascript
function syncProcess(value) {
  // Can check and return poison directly
  if (isPoison(value)) {
    return value;
  }

  // Can check for thenable, but can't handle it
  if (value && typeof value.then === 'function') {
    throw new Error('Cannot process promises synchronously');
  }

  return processValue(value);
}
```

### Template for Sync-First Hybrid Functions

```javascript
function hybridAsync(value, options) {
  // NOT declared with async!

  // 1. Poison check - return poison directly
  // Thenable protocol converts to PoisonError when awaited
  if (isPoison(value)) {
    return value;
  }

  // 2. Simple case - return value directly (no Promise!)
  if (!value || (typeof value.then !== 'function' && !Array.isArray(value))) {
    return processSimple(value, options);
  }

  // 3. Complex case - delegate to async helper
  return _hybridAsyncComplex(value, options);
}

async function _hybridAsyncComplex(value, options) {
  // This IS async, so must throw not return

  // Check after await
  if (value && typeof value.then === 'function') {
    try {
      value = await value;
    } catch (err) {
      throw isPoisonError(err) ? err : new PoisonError([err]);
    }

    if (isPoison(value)) {
      throw new PoisonError(value.errors);
    }
  }

  // Handle arrays
  if (Array.isArray(value)) {
    const errors = await collectErrors(value);
    if (errors.length > 0) {
      throw new PoisonError(errors);
    }
    // ... process array
  }

  return processComplex(value, options);
}
```

### Template for Sync-First Hybrid with Multi-Source Error Collection

When you need to collect errors from multiple sources before proceeding:

```javascript
function callWrapAsync(obj, name, context, args) {
  // NOT declared with async!

  // Check if ANY input requires async processing
  const objIsPromise = obj && typeof obj.then === 'function' && !isPoison(obj);
  const hasArgPromises = args.some(arg => arg && typeof arg.then === 'function' && !isPoison(arg));

  if (objIsPromise || hasArgPromises) {
    // Delegate to async helper
    return _callWrapAsyncComplex(obj, name, context, args);
  }

  // Sync path: Collect ALL errors from all sources
  const errors = [];
  if (isPoison(obj)) {
    errors.push(...obj.errors);
  }
  for (const arg of args) {
    if (isPoison(arg)) {
      errors.push(...arg.errors);
    }
  }

  if (errors.length > 0) {
    return createPoison(errors);
  }

  // Validate and call
  if (!obj) {
    return createPoison(new Error('Unable to call `' + name + '`, which is undefined'));
  } else if (typeof obj !== 'function') {
    return createPoison(new Error('Unable to call `' + name + '`, which is not a function'));
  }

  return obj.apply(context, args);
}

async function _callWrapAsyncComplex(obj, name, context, args) {
  // Collect ALL errors from ALL sources (never miss any error principle)
  const errors = [];

  // Await and check obj
  if (obj && typeof obj.then === 'function' && !isPoison(obj)) {
    try {
      obj = await obj;
      if (isPoison(obj)) {
        errors.push(...obj.errors);
      }
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        errors.push(err);
      }
    }
  } else if (isPoison(obj)) {
    errors.push(...obj.errors);
  }

  // Await ALL args to collect all errors
  const argErrors = await collectErrors(args);
  errors.push(...argErrors);

  if (errors.length > 0) {
    return createPoison(errors);  // Returns poison - throws when awaited
  }

  // Resolve all arg promises
  const resolvedArgs = [];
  for (const arg of args) {
    if (arg && typeof arg.then === 'function') {
      resolvedArgs.push(await arg);
    } else {
      resolvedArgs.push(arg);
    }
  }

  // Validate and call with resolved args
  if (!obj) {
    return createPoison(new Error('Unable to call `' + name + '`, which is undefined'));
  } else if (typeof obj !== 'function') {
    return createPoison(new Error('Unable to call `' + name + '`, which is not a function'));
  }

  return obj.apply(context, resolvedArgs);
}
```

**Key Points:**
- Must check ALL sources for errors/promises before deciding path
- Sync path collects all poison errors from all sources
- Async path awaits ALL promises (never miss any error principle)
- Returns poison directly (thenable protocol handles conversion)

### Template for Pure Async Functions

```javascript
async function pureAsync(value) {
  // 1. Sync poison check - throw immediately
  if (isPoison(value)) {
    throw new PoisonError(value.errors);
  }

  // 2. Await and catch
  if (value && typeof value.then === 'function') {
    try {
      value = await value;
    } catch (err) {
      throw isPoisonError(err) ? err : new PoisonError([err]);
    }
  }

  // 3. Deep resolution with error collection
  if (Array.isArray(value)) {
    try {
      const resolved = await deepResolveArray(value);
      return resolved;
    } catch (err) {
      throw isPoisonError(err) ? err : new PoisonError([err]);
    }
  }

  return processValue(value);
}
```

### Template for Deep Resolution Functions

```javascript
async function deepResolveArray(arr) {
  const errors = [];

  for (let i = 0; i < arr.length; i++) {
    let item = arr[i];

    // 1. Check if already poison (before await)
    if (isPoison(item)) {
      errors.push(...item.errors);
      continue;
    }

    // 2. Check if promise/thenable (BEFORE structure checks)
    if (item && typeof item.then === 'function') {
      try {
        item = await item;
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        continue;
      }
    }

    // 3. Check structure and recurse WITH try-catch
    if (Array.isArray(item)) {
      try {
        const resolved = await deepResolveArray(item);
        arr[i] = resolved;
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        continue;
      }
    } else if (isPlainObject(item)) {
      try {
        const resolved = await deepResolveObject(item);
        arr[i] = resolved;
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        continue;
      }
    } else {
      arr[i] = item;
    }
  }

  // 4. Return poison if ANY errors collected
  if (errors.length > 0) {
    return createPoison(errors);
  }

  return arr;
}
```


---

## Part 5: Testing Checklist

### Basic Poison Behavior
- [ ] Create poison from single error
- [ ] Create poison from multiple errors
- [ ] Verify `isPoison()` detects PoisonedValue correctly
- [ ] Verify `isPoisonError()` detects thrown error correctly
- [ ] Test that `await poisonValue` throws PoisonError
- [ ] Test that `await Promise.resolve(poison)` throws PoisonError
- [ ] Test that poison.then() throws PoisonError
- [ ] Test error deduplication works

### Function Return Type Handling
- [ ] Test pure sync function returning poison (can check with isPoison)
- [ ] Test sync-first hybrid returning literal (no Promise wrapper)
- [ ] Test sync-first hybrid returning rejected promise for poison
- [ ] Test sync-first hybrid delegating to async helper for complex cases
- [ ] Test pure async function throwing PoisonError (not returning poison)
- [ ] Test async helper function throws PoisonError (not returns)
- [ ] Test mixed sync/async function calls

### Sync-First Hybrid Pattern
- [ ] Test literal values return synchronously (no Promise wrapper)
- [ ] Test poison returns rejected Promise synchronously
- [ ] Test complex values (arrays/promises) delegate to async helper
- [ ] Verify helper throws PoisonError not returns poison
- [ ] Verify no Promise allocation for simple literals
- [ ] Test performance: sync returns are faster than async

### Promise Interactions
- [ ] Test Promise.resolve(poison) throws when awaited
- [ ] Test Promise.reject() in arrays
- [ ] Test awaiting promise that rejects with error
- [ ] Test mixed promises and poison values
- [ ] Verify `isPoison(await something)` is never true
- [ ] Test promise that resolves to poison (throws when awaited)

### Deep Resolution
- [ ] Test nested arrays with errors at multiple levels
- [ ] Test nested objects with errors at multiple levels
- [ ] Test mixed nested structures (arrays in objects, etc.)
- [ ] Test Promise.resolve([...]) with nested errors
- [ ] Test deeply nested Promise chains

### Error Collection ("Never Miss Any Error" Principle)
- [ ] Verify ALL errors are collected (count them)
- [ ] Verify errors collected in deterministic order
- [ ] Test that processing continues after finding error (no early return)
- [ ] Test multiple errors from different sources collected simultaneously
- [ ] Test error deduplication across sources
- [ ] Test no short-circuiting (all items processed even after finding errors)
- [ ] Test parallel error collection is deterministic
- [ ] Test poison value + rejecting promise in args = both errors collected
- [ ] Test multiple rejecting promises in parallel = all collected
- [ ] Verify no errors are lost even if first input is poison

### Recursive Calls
- [ ] Test deepResolveArray with poison at various depths
- [ ] Test deepResolveObject with poison in properties
- [ ] Verify recursive calls wrapped in try-catch
- [ ] Test error propagation through recursion
- [ ] Test that recursive poison returns throw when awaited

### Edge Cases
- [ ] Test empty arrays
- [ ] Test null/undefined values
- [ ] Test primitive values (strings, numbers, booleans)
- [ ] Test functions that return poison (sync functions)
- [ ] Test async functions that throw PoisonError
- [ ] Test Symbol.for() key works across modules (after transpilation)
- [ ] Test very deeply nested structures
- [ ] Test circular references (if applicable)

### Integration
- [ ] Test with actual Cascada template rendering
- [ ] Test with async function calls in templates
- [ ] Test with property lookups
- [ ] Test with conditional expressions
- [ ] Test with loops
- [ ] Verify no unhandled rejection warnings
- [ ] Test error messages are user-friendly
- [ ] Test stack traces are preserved from original errors

---

## Part 6: Quick Reference Card

### What to Check When

| Situation | Pattern | What to Check | How |
|-----------|---------|---------------|-----|
| Pure sync function result | Pattern 1 | Is value poison? | `if (isPoison(value))` → return value |
| Sync-first hybrid result | Pattern 2 | Check before delegating | `if (isPoison(value))` → return value |
| Sync-first hybrid literal | Pattern 2 | Return directly | Return value (no Promise) |
| Async function result | Pattern 3 | Can't check - will throw | Wrap in try-catch |
| Before await | All | Is value poison? | `if (isPoison(value))` |
| After await | All | **Cannot be poison** | Never check - impossible |
| In catch block | All | Is error PoisonError? | `if (isPoisonError(err))` |
| Extracting errors | All | From PoisonError | `err.errors` (spread it) |
| Extracting errors | All | From PoisonedValue | `value.errors` (spread it) |

### The Three Function Patterns

```
Pattern 1: Pure Sync
├─ NOT declared with async
├─ Can return PoisonedValue directly
├─ Example: callWrap(), memberLookup()
└─ Usage: if (isPoison(val)) return val;

Pattern 2: Sync-First Hybrid
├─ NOT declared with async
├─ Returns: literal values OR poison values (thenables) OR delegated promises
├─ Fast path for 30-40% of calls
├─ Example: suppressValueAsync(), ensureDefinedAsync(), callWrapAsync()
└─ Usage:
    if (isPoison(val)) return val;  // Thenable protocol handles conversion
    if (literal) return processedValue;
    return _asyncHelper(val);

Pattern 3: Pure Async
├─ IS declared with async
├─ MUST throw PoisonError, never return PoisonedValue
├─ Example: sequencedCallWrap(), _asyncHelper()
└─ Usage: if (isPoison(val)) throw new PoisonError(...);
```

### The Fundamental Rules

**Rule 1: await CANNOT return PoisonedValue**
- PoisonedValue is a thenable
- await unwraps all thenables
- Our .then() throws PoisonError
- Therefore: await either returns non-poison OR throws

**Rule 2: async functions CANNOT return PoisonedValue synchronously**
- async keyword wraps ALL returns in Promise
- Even `return poison` becomes `Promise.resolve(poison)`
- Result is Promise<PoisonedValue>, not PoisonedValue
- Must await the Promise to trigger the poison

**Rule 3: Sync-first hybrid functions are the performance sweet spot**
- NOT async, so can return values directly
- Return poison values directly (thenable protocol converts on await)
- Delegate to async helper for complex cases
- Captures 30-40% fast path without Promise overhead

**Rule 4: Never Miss Any Error**
- Await ALL promises before making decisions
- Use `continue` not `return` in error collection loops
- Collect errors from ALL sources (obj + all args, all array items, etc.)
- Process ALL items even after finding errors
- Return/throw only AFTER collecting everything
- Benefits: see all problems at once, deterministic behavior, complete information

**Rule 5: Check poison:**
- BEFORE await: `if (isPoison(value))`
- AFTER await in catch: `if (isPoisonError(err))`
- On sync function results: `if (isPoison(result))`
- On hybrid function results (before delegating): `if (isPoison(result))`
- NEVER after await in success path: impossible
- NEVER on async function results without try-catch: will throw