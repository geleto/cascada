# Cascada Poison Value Implementation: Complete Reference Guide

## Part 1: Foundational Concepts

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
      return onRejected(error); // ← Calls reject(), THROWS
    }
    return this; // Fallback (shouldn't happen with await)
  }
}

class PoisonError extends Error {
  constructor(errors) {
    super(buildMessage(errors));
    this.name = 'PoisonError';
    this.errors = deduplicateErrors(errors);
    this[POISON_ERROR_KEY] = true;
  }
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
  return onRejected(new PoisonError(this.errors)); // THROWS
}

// Therefore:
const result = await poisonValue; // Throws PoisonError
// The assignment NEVER happens

// This is also impossible:
const result = await Promise.resolve(poisonValue); // Also throws
if (isPoison(result)) { // Never reached
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
- Use `isPoisonError()` on errors caught in catch blocks
- **Never** use `isPoison()` on the result of await
- **Never** use `isPoison()` directly on return value of async function

---

## Part 2: Critical Bugs to Avoid

### Bug #1: Checking isPoison() on Promise or Async Function Result

**❌ WRONG:**
```javascript
const promise = asyncFunction(); // Returns Promise<PoisonedValue>
if (isPoison(promise)) {  // Always false!
  // Never executed - promise is a Promise, not a PoisonedValue
}

// Also wrong:
async function getPoison() {
  return createPoison(err); // Even this returns Promise<PoisonedValue>
}
const result = getPoison();
if (isPoison(result)) { // Always false!
```

**Why it fails:**
- Async functions ALWAYS wrap return values in Promises
- Even `return poison` before any await becomes `Promise.resolve(poison)`
- `Promise.resolve(poison)` wraps poison in a Promise
- The poison is INSIDE the promise, not the promise itself
- `isPoison(Promise<PoisonedValue>)` → false

**✅ CORRECT - Synchronous Functions:**
```javascript
// NON-async function CAN return poison synchronously
function mayReturnPoison(value) {
  if (isPoison(value)) {
    return value; // Returns PoisonedValue directly
  }
  return processValue(value);
}

const result = mayReturnPoison(input);
if (isPoison(result)) { // CAN be true!
  return result;
}
```

**✅ CORRECT - Async Functions:**
```javascript
// Async function - must await
async function mayReturnPoison(value) {
  if (isPoison(value)) {
    return value; // Returns Promise<PoisonedValue>
  }
  return await processValue(value);
}

try {
  const result = await mayReturnPoison(input);
  // Only reached if NOT poison
} catch (err) {
  if (isPoisonError(err)) {
    return createPoison(err.errors);
  }
  throw err;
}
```

**Key distinction:**
- **Synchronous function**: Can return PoisonedValue → check `isPoison(result)`
- **Async function**: Returns Promise<PoisonedValue> → must await + try-catch
- **Already a Promise**: Must await + try-catch

---

### Bug #2: Expecting await to Return PoisonedValue

**❌ WRONG:**
```javascript
const result = await someAsyncFunc();
if (isPoison(result)) {  // IMPOSSIBLE - never true
  errors.push(...result.errors);
}
```

**Why this is impossible:**
- PoisonedValue is a thenable (Promise-like object)
- `await` unwraps ALL thenables by calling `.then()`
- Our `.then()` method throws PoisonError
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
// Check BEFORE await (on non-async function results):
const value = syncFunction();
if (isPoison(value)) {
  return value; // Propagate synchronously
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

---

### Bug #3: Wrong Check Order in Resolution Functions

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
// 1. Check if already poison (synchronous check on actual value)
if (isPoison(item)) {
  errors.push(...item.errors);
  continue;
}

// 2. Check if promise/thenable FIRST (before any structure checks)
if (item && typeof item.then === 'function') {
  try {
    item = await item;
    // If we reach here, item is NOT poison (would have thrown)
  } catch (err) {
    if (isPoisonError(err)) {
      errors.push(...err.errors);
    } else {
      errors.push(err);
    }
    continue;
  }
}

// 3. NOW check structure (item is unwrapped)
if (Array.isArray(item)) {
  // Recurse
} else if (isPlainObject(item)) {
  // Recurse
}
```

---

### Bug #4: Using instanceof for Detection

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
const POISON_KEY = Symbol.for('cascada.poison');
const POISON_ERROR_KEY = Symbol.for('cascada.poisonError');

class PoisonedValue {
  constructor(errors) {
    super();
    this[POISON_KEY] = true;
  }
}

class PoisonError extends Error {
  constructor(errors) {
    super(message);
    this[POISON_ERROR_KEY] = true;
  }
}

function isPoison(value) {
  return value != null && value[POISON_KEY] === true;
}

function isPoisonError(err) {
  return err != null && err[POISON_ERROR_KEY] === true;
}

// Usage:
catch (err) {
  if (isPoisonError(err)) {
    errors.push(...err.errors);
  }
}
```

---

### Bug #5: Short-Circuiting Error Collection

**❌ WRONG:**
```javascript
for (const item of items) {
  try {
    await processItem(item);
  } catch (err) {
    return createPoison(err); // STOPS HERE
  }
}
```

**Why it fails:**
- If items[0] and items[3] both error
- Returning after items[0] means items[3] error never discovered
- Results become non-deterministic (depends on execution order)
- Violates the "collect ALL errors" principle

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
    continue; // KEEP GOING
  }
}

if (errors.length > 0) {
  return createPoison(errors);
}
```

---

### Bug #6: Forgetting to Extract .errors Array

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

### Bug #7: Consuming Rejections in Tests

**❌ WRONG:**
```javascript
// In test setup:
const p = Promise.reject(new Error('test'));
p.catch(() => {}); // Silence unhandled rejection warning

// In code being tested:
try {
  await p; // Returns undefined, doesn't throw!
} catch (err) {
  // Never executed
}
```

**Why it fails:**
- `.catch()` handler marks rejection as "handled"
- Subsequent awaits see promise as resolved to undefined
- The error is swallowed

**✅ CORRECT:**
```javascript
// Let the resolution function catch it
const items = [
  Promise.reject(new Error('test')), // No .catch()
  Promise.resolve(123)
];

// deepResolveArray's try-catch will handle rejection
try {
  const result = await deepResolveArray(items);
} catch (err) {
  if (isPoisonError(err)) {
    // Contains the test error
  }
}
```

---

### Bug #8: Race Conditions from Promise.race()

**❌ WRONG:**
```javascript
const result = await Promise.race(promises); // Nondeterministic

// Also wrong:
let foundError = false;
await Promise.all(promises.map(async p => {
  if (foundError) return; // Race on foundError
  try {
    await p;
  } catch (err) {
    foundError = true;
  }
}));
```

**Why it fails:**
- Promise.race() depends on which promise resolves first
- Timing varies between runs
- Same input can produce different error sets
- Violates deterministic error collection

**✅ CORRECT:**
```javascript
// Sequential - deterministic order
const errors = [];
for (const promise of promises) {
  try {
    await promise;
  } catch (err) {
    if (isPoisonError(err)) {
      errors.push(...err.errors);
    } else {
      errors.push(err);
    }
  }
}

// Or Promise.all with proper error capture:
const results = await Promise.all(
  promises.map(p => p.catch(err => createPoison(err)))
);
const errors = results
  .filter(isPoison)
  .flatMap(p => p.errors);
```

---

### Bug #9: Mixing Sync and Async Without Type Awareness

**❌ WRONG:**
```javascript
function processValue(value) {
  // Don't know if value is from sync or async function
  if (isPoison(value)) {
    return value; // Might be Promise<PoisonedValue>!
  }
  return value * 2;
}

// Calling code:
const result = processValue(asyncFunc()); // Promise passed in!
```

**Why it fails:**
- Can't tell if value is PoisonedValue or Promise<PoisonedValue>
- Type confusion leads to incorrect checks
- Must be consistent about sync vs async

**✅ CORRECT - Separate Functions:**
```javascript
// For synchronous values
function processSyncValue(value) {
  if (isPoison(value)) {
    return value;
  }
  return value * 2;
}

// For async values
async function processAsyncValue(value) {
  try {
    const resolved = await value;
    return resolved * 2;
  } catch (err) {
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    }
    throw err;
  }
}
```

**✅ CORRECT - Duck Typing:**
```javascript
function processValue(value) {
  // Check if promise first
  if (value && typeof value.then === 'function') {
    // It's async, can't check isPoison
    return processAsyncValue(value);
  }

  // It's sync, can check isPoison
  if (isPoison(value)) {
    return value;
  }
  return value * 2;
}
```

---

### Bug #10: Not Wrapping Rejected Promises in Try-Catch

**❌ WRONG:**
```javascript
const items = [
  Promise.reject(new Error('fail')),
  123
];

for (const item of items) {
  if (item && typeof item.then === 'function') {
    const resolved = await item; // Throws, crashes
  }
}
```

**Why it fails:**
- Rejected promise throws when awaited
- Without try-catch, error propagates up
- Crashes instead of collecting error

**✅ CORRECT:**
```javascript
for (const item of items) {
  if (item && typeof item.then === 'function') {
    try {
      const resolved = await item;
      // Process resolved value
    } catch (err) {
      if (isPoisonError(err)) {
        errors.push(...err.errors);
      } else {
        errors.push(err);
      }
      continue;
    }
  }
}
```

---

### Bug #11: Recursive Calls Can Throw PoisonError

**❌ WRONG:**
```javascript
if (Array.isArray(item)) {
  const resolved = await deepResolveArray(item);
  if (isPoison(resolved)) { // Never reached if poison
    errors.push(...resolved.errors);
  }
}
```

**Why it fails:**
- `deepResolveArray()` returns PoisonedValue
- `await PoisonedValue` throws PoisonError
- Never reaches the `if` check

**✅ CORRECT:**
```javascript
if (Array.isArray(item)) {
  try {
    const resolved = await deepResolveArray(item);
    items[i] = resolved;
  } catch (err) {
    if (isPoisonError(err)) {
      errors.push(...err.errors);
    } else {
      errors.push(err);
    }
    continue;
  }
}
```

---

### Bug #12: Returning Poison from Wrong Scope

**❌ WRONG:**
```javascript
async function processItems(items) {
  const errors = [];

  for (const item of items) {
    if (isPoison(item)) {
      // Returning from function, not continuing loop
      return createPoison(item.errors); // BUG!
    }
  }

  if (errors.length > 0) {
    return createPoison(errors);
  }
}
```

**Why it fails:**
- Returns from function on first poison, not collecting rest
- Should collect error and continue loop
- Similar to Bug #5 but at different scope level

**✅ CORRECT:**
```javascript
async function processItems(items) {
  const errors = [];

  for (const item of items) {
    if (isPoison(item)) {
      errors.push(...item.errors); // Collect, don't return
      continue; // Keep processing
    }
  }

  if (errors.length > 0) {
    return createPoison(errors);
  }
}
```

---

## Part 3: When CAN You Use Synchronous Propagation?

You can check `isPoison()` and return synchronously when:

1. **The value IS already a PoisonedValue** (not wrapped in Promise)
2. **The value came from a NON-async function** (or you checked for thenable first)
3. **You haven't awaited it yet**

```javascript
// ✅ Synchronous propagation - NON-async function
function syncProcess(value) {
  if (isPoison(value)) {
    return value; // Immediate return
  }

  // If we see a promise, can't check synchronously
  if (value && typeof value.then === 'function') {
    throw new Error('Cannot process promises synchronously');
  }

  return value * 2;
}

// ❌ Async function - always returns Promise
async function asyncProcess(value) {
  if (isPoison(value)) {
    return value; // Returns Promise<PoisonedValue>!
  }
  // Even early return is wrapped
}

// ✅ Check before await in async function
async function asyncProcess(value) {
  // Check on raw input before any await
  if (isPoison(value)) {
    return value; // OK - returns Promise<PoisonedValue>
  }

  const result = await someOperation();
  // Can't check isPoison(result) here - would have thrown
}
```

---

## Part 4: The Complete Correct Pattern

### Template for Deep Resolution Functions

```javascript
async function deepResolveArray(arr) {
  const errors = [];

  for (let i = 0; i < arr.length; i++) {
    let item = arr[i];

    // Step 1: Check if already poison (before await)
    if (isPoison(item)) {
      errors.push(...item.errors);
      continue;
    }

    // Step 2: Check if promise/thenable (BEFORE structure checks)
    if (item && typeof item.then === 'function') {
      try {
        item = await item;
        // If we reach here, item is NOT poison (would have thrown)
      } catch (err) {
        if (isPoisonError(err)) {
          errors.push(...err.errors);
        } else {
          errors.push(err);
        }
        continue;
      }
    }

    // Step 3: Check structure and recurse WITH try-catch
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
      // Primitive value, already resolved
      arr[i] = item;
    }
  }

  // Step 4: Return poison if ANY errors collected
  if (errors.length > 0) {
    return createPoison(errors);
  }

  return arr;
}
```

### Template for Simple Resolution Functions

```javascript
async function resolveSingle(value) {
  // Step 1: Synchronous poison check (before await)
  if (isPoison(value)) {
    return value;
  }

  // Step 2: Non-thenable shortcut
  if (!value || typeof value.then !== 'function') {
    return value;
  }

  // Step 3: Resolve thenable with error handling
  let resolvedValue;
  try {
    resolvedValue = await value;
    // If we reach here, resolvedValue is NOT poison
  } catch (err) {
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    }
    return createPoison(err);
  }

  // Step 4: Deep resolve if needed
  if (Array.isArray(resolvedValue)) {
    try {
      return await deepResolveArray(resolvedValue);
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors);
      }
      return createPoison(err);
    }
  } else if (isPlainObject(resolvedValue)) {
    try {
      return await deepResolveObject(resolvedValue);
    } catch (err) {
      if (isPoisonError(err)) {
        return createPoison(err.errors);
      }
      return createPoison(err);
    }
  }

  return resolvedValue;
}
```

### Template for Mixed Sync/Async Handling

```javascript
function handleValue(value) {
  // First check: is it a thenable?
  if (value && typeof value.then === 'function') {
    // It's async - delegate to async handler
    return handleAsyncValue(value);
  }

  // It's sync - can check isPoison directly
  if (isPoison(value)) {
    return value;
  }

  return processSync(value);
}

async function handleAsyncValue(value) {
  try {
    const resolved = await value;
    return processSync(resolved);
  } catch (err) {
    if (isPoisonError(err)) {
      return createPoison(err.errors);
    }
    return createPoison(err);
  }
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
- [ ] Test non-async function returning poison (can check with isPoison)
- [ ] Test async function returning poison (must await + try-catch)
- [ ] Test async function with early return of poison
- [ ] Test mixed sync/async function calls

### Promise Interactions
- [ ] Test Promise.resolve(poison) throws when awaited
- [ ] Test Promise.reject() in arrays
- [ ] Test awaiting promise that rejects with error
- [ ] Test mixed promises and poison values
- [ ] Verify `isPoison(await something)` is never true

### Deep Resolution
- [ ] Test nested arrays with errors at multiple levels
- [ ] Test nested objects with errors at multiple levels
- [ ] Test mixed nested structures (arrays in objects, etc.)
- [ ] Test Promise.resolve([...]) with nested errors

### Error Collection
- [ ] Verify ALL errors are collected (count them)
- [ ] Verify errors collected in deterministic order
- [ ] Test that processing continues after finding error
- [ ] Test multiple errors from different sources
- [ ] Test error deduplication across sources
- [ ] Test no short-circuiting (all items processed)

### Recursive Calls
- [ ] Test deepResolveArray with poison at various depths
- [ ] Test deepResolveObject with poison in properties
- [ ] Verify recursive calls wrapped in try-catch
- [ ] Test error propagation through recursion

### Edge Cases
- [ ] Test empty arrays
- [ ] Test null/undefined values
- [ ] Test primitive values
- [ ] Test functions that return poison
- [ ] Test async functions that return poison
- [ ] Test Symbol.for() key works across modules

### Integration
- [ ] Test with actual Cascada template rendering
- [ ] Test with async function calls
- [ ] Test with property lookups
- [ ] Test with conditional expressions
- [ ] Verify no unhandled rejection warnings

---

## Part 6: Quick Reference Card

### What to Check When

| Situation | What to Check | How |
|-----------|---------------|-----|
| Non-async function result | Is value poison? | `if (isPoison(value))` |
| Async function result | Can't check - must await | Wrap in try-catch |
| Before await | Is value poison? | `if (isPoison(value))` |
| After await | **Cannot be poison** | Never check - impossible |
| In catch block | Is error a PoisonError? | `if (isPoisonError(err))` |
| Unknown if sync/async | Check for thenable first | `typeof value.then === 'function'` |
| Extracting errors | From PoisonError | `err.errors` (spread it) |
| Extracting errors | From PoisonedValue | `value.errors` (spread it) |

### Decision Tree for Function Results

```
What type of function returned the value?
├─ Non-async function
│   └─ Can check isPoison() directly
│       ├─ isPoison(value) === true → Propagate
│       └─ isPoison(value) === false → Process
│
├─ Async function
│   └─ Result is Promise - must await
│       └─ Wrap in try-catch
│           ├─ Success: value is NOT poison
│           └─ Catch: Check isPoisonError(err)
│
└─ Unknown (check for thenable)
    ├─ typeof value.then === 'function' → Treat as async
    └─ Otherwise → Treat as sync
```

### The Fundamental Rules

**Rule 1: await CANNOT return PoisonedValue** because:
1. PoisonedValue is a thenable
2. await unwraps all thenables
3. Our .then() throws PoisonError
4. Therefore: await either returns non-poison OR throws

**Rule 2: async functions CANNOT return PoisonedValue synchronously** because:
1. async keyword wraps ALL returns in Promise
2. Even `return poison` becomes `Promise.resolve(poison)`
3. Result is Promise<PoisonedValue>, not PoisonedValue
4. Must await the Promise to trigger the poison

**Rule 3: Check poison:**
- BEFORE await: `if (isPoison(value))`
- AFTER await in catch: `if (isPoisonError(err))`
- On non-async function results: `if (isPoison(result))`
- NEVER after await in success path: impossible
- NEVER on async function results without await: wrong type