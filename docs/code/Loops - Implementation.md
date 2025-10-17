# Cascada For Loop Implementation: Complete Deep Dive

## Overview: The Two-Phase Architecture

For loops in Cascada use a **compile-time + runtime** architecture where:
1. **Compiler** analyzes the loop structure, generates metadata, compiles loop body/else as functions
2. **Runtime** receives these functions + metadata, handles actual iteration and state management

This separation allows the compiler to be deterministic (static analysis) while the runtime handles dynamic concerns (poison detection, async iteration, variable synchronization).

---

## Part 1: Compilation Phase

### Step 1: Initial Setup and Frame Management

```javascript
_compileFor(node, frame, sequential = false, iteratorCompiler = null) {
  // Create an async block for the entire loop structure
  frame = this.emit.asyncBlockBufferNodeBegin(node, frame, true, node.arr);
```

**What's happening:**
- The entire loop (array evaluation + iteration + else) becomes one async block
- `createScope = true` because loop introduces new variables (loop vars)
- A new `AsyncFrame` is pushed onto the frame stack
- This frame will track: write counts from body + else, variables declared in loop scope

**Why async block even for sync loops?**
Because the array expression `arr` might be async, and we need consistent handling.

### Step 2: Array Expression Compilation

```javascript
const arr = this._tmpid();

if (iteratorCompiler) {
  // Special case: while loops pass a custom iterator compiler
  iteratorCompiler(node.arr, frame, arr);
} else {
  // Normal for loop: compile the array expression
  this.emit(`let ${arr} = `);
  this._compileExpression(node.arr, frame, false);
  this.emit.line(';');
}
```

**Key insight:** We do NOT await the array expression. Why?
- `arr` might be: `[1,2,3]`, `Promise.resolve([1,2,3])`, or even a `PoisonedValue`
- Runtime `iterate()` will handle all cases
- Keeps compilation simple and uniform

**The iteratorCompiler pattern (for while):**
While loops use a fake `For` node and pass a custom function that:
1. Evaluates the condition
2. Creates an async iterator that yields on each truthy evaluation
3. Tracks write counts from condition evaluation

### Step 3: Loop Variable Declaration

```javascript
const loopVars = [];
if (node.name instanceof nodes.Array) {
  // Destructuring: for [key, value] in items
  node.name.children.forEach((child) => {
    loopVars.push(child.value);
    frame.set(child.value, child.value);
    if (node.isAsync) {
      this._addDeclaredVar(frame, child.value);
    }
  });
} else {
  // Single var: for item in items
  loopVars.push(node.name.value);
  frame.set(node.name.value, node.name.value);
  if (node.isAsync) {
    this._addDeclaredVar(frame, node.name.value);
  }
}
```

**What's happening:**
- Extract loop variable names: `["item"]` or `["key", "value"]`
- Register them in the frame (so child scopes can reference them)
- In async mode: add to `declaredVars` (important for write count tracking)

**Why set them to their own name?**
The frame maps template var names → JS var names. Here they're the same because they become function parameters later.

### Step 4: Compile Loop Body as Function

```javascript
const loopBodyFuncId = this._tmpid();
this.emit(`let ${loopBodyFuncId} = `);

const bodyFrame = this._compileLoopBody(node, frame, arr, loopVars, sequential);
const bodyWriteCounts = bodyFrame.writeCounts;
```

**What `_compileLoopBody` generates:**

```javascript
let loop_body_123 = (async function(item, i, len, isLast, errorContext) {
  return runtime.executeAsyncBlock(async (astate, frame) => {
    // Set up loop.index, loop.first, etc.
    runtime.setLoopBindings(frame, i, len, isLast);

    // Set loop variable in frame
    frame.set("item", item);

    // ... compiled body code here ...

    return output; // The buffer array
  }, astate.enterAsyncBlock(), frame.pushAsyncBlock(...), cb, ...);
}).bind(context);
```

**Key points:**
1. **Function signature:** Matches what runtime will call with
2. **Async IIFE wrapper:** Each iteration can spawn async work
3. **Frame setup:** Loop bindings (`loop.index`, etc.) + loop var
4. **Return value:** The output buffer for this iteration
5. **Bound context:** So `this` works correctly inside the function

**Write count tracking:**
During compilation of the body:
- Any `set x = ...` triggers `updateFrameWrites(bodyFrame, 'x')`
- This propagates up: `bodyFrame → loopFrame → parentFrame`
- After body compilation: `bodyFrame.writeCounts` contains all variables written in body

### Step 5: Sequential Detection

```javascript
if (bodyWriteCounts) {
  // Body modifies outer-scope variables
  // MUST run sequentially to maintain consistency
  sequential = true;
}
```

**Why this matters:**
```javascript
var count = 0
for item in [1,2,3]
  set count = count + 1  // Race condition if parallel!
endfor
```

If multiple iterations write to the same outer variable, they MUST run one-at-a-time. Otherwise:
- Iteration 1 reads `count=0`, writes `count=1`
- Iteration 2 reads `count=0` (before 1 finishes), writes `count=1`
- Final value: `count=1` (wrong! should be 3)

**How it's enforced:**
The `sequential` flag is passed to `iterate()`, which then:
- Awaits each iteration before starting the next
- Uses `sequentialLoopBody = true` to suppress immediate write propagation
- Calls `finalizeLoopWrites()` after the entire loop completes

### Step 6: Collect Body Handlers

```javascript
const bodyHandlers = node.isAsync ? this._collectBranchHandlers(node.body) : null;
```

**What this does:**
Recursively walks the body AST looking for:
- `Output` nodes (regular `{{ ... }}` → handler: 'text')
- `OutputCommand` nodes (`@data.push(...)`, `@turtle.forward(...)`)
- Extracts handler names: `Set(['data', 'text', 'turtle'])`

**Why we need this:**
If the loop never executes (poisoned array), we need to poison the handlers that WOULD have been written to. This prevents downstream code from seeing incomplete data.

### Step 7: Compile Else Block (if present)

```javascript
let elseFuncId = 'null';
let elseWriteCounts = null;
let elseHandlers = null;

if (node.else_) {
  elseFuncId = this._tmpid();
  this.emit(`let ${elseFuncId} = `);

  const elseFrame = this._compileLoopElse(node, frame, sequential);

  elseWriteCounts = this.async.countsTo1(elseFrame.writeCounts);
  elseHandlers = node.isAsync ? this._collectBranchHandlers(node.else_) : null;
}
```

**What `_compileLoopElse` generates:**

```javascript
let loop_else_456 = (async function() {
  return runtime.executeAsyncBlock(async (astate, frame) => {
    // ... compiled else code ...
    return output; // The buffer array
  }, astate.enterAsyncBlock(), frame.pushAsyncBlock(...), cb, ...);
}).bind(context);
```

**Difference from body:**
- No parameters (doesn't receive iteration values)
- No `sequentialLoopBody` flag (runs once, not iterated)
- Writes propagate normally (not suppressed)

**Why collect else metadata?**
If array is poisoned, we don't know if it would've been empty or not:
- Empty → else executes → poison else effects
- Non-empty → body executes → poison body effects
- **Poisoned → don't know → poison BOTH**

### Step 8: Build asyncOptions Object

```javascript
let asyncOptionsCode = 'null';
if (node.isAsync) {
  asyncOptionsCode = `{
    sequential: ${sequential},
    bodyWriteCounts: ${JSON.stringify(bodyWriteCounts || {})},
    bodyHandlers: ${JSON.stringify(bodyHandlers ? Array.from(bodyHandlers) : [])},
    elseWriteCounts: ${JSON.stringify(elseWriteCounts || {})},
    elseHandlers: ${JSON.stringify(elseHandlers ? Array.from(elseHandlers) : [])},
    errorContext: { lineno: ${node.lineno}, colno: ${node.colno},
                   errorContextString: ${JSON.stringify(this._generateErrorContext(node))},
                   path: context.path }
  }`;
}
```

**This is the metadata package** sent to runtime:
- **sequential:** Whether to run iterations one-at-a-time
- **bodyWriteCounts:** `{varName: count}` - what body might write
- **bodyHandlers:** `['data', 'text']` - what handlers body uses
- **elseWriteCounts/elseHandlers:** Same for else block
- **errorContext:** Position info for error messages

**Why build as code string, not JSON.stringify?**
Because `context.path` is a runtime variable - it doesn't exist at compile time. We need to emit code that references the runtime variable.

### Step 9: Generate iterate() Call

```javascript
this.emit(`${node.isAsync ? 'await ' : ''}runtime.iterate(${arr}, ${loopBodyFuncId}, ${elseFuncId}, frame, ${node.isAsync ? this.buffer : 'null'}, [`);
loopVars.forEach((varName, index) => {
  if (index > 0) this.emit(', ');
  this.emit(`"${varName}"`);
});
this.emit(`], ${asyncOptionsCode});`);
```

**Generated code looks like:**

```javascript
await runtime.iterate(
  arr_123,              // Array/iterator to loop over
  loop_body_456,        // Body function
  loop_else_789,        // Else function (or null)
  frame,                // Current async frame
  output,               // Buffer reference (or null in sync)
  ["item"],             // Loop variable names
  { sequential: true,   // Options object
    bodyWriteCounts: {x: 1},
    bodyHandlers: ['data'],
    elseWriteCounts: {},
    elseHandlers: [],
    errorContext: {...} }
);
```

**Key architectural decision:**
The compiler doesn't generate loop iteration code. It generates:
1. Functions for body/else
2. Metadata about them
3. A call to `iterate()` which handles the actual looping

This keeps loop semantics centralized in runtime, making it easier to:
- Handle different iterator types uniformly
- Implement poison detection once
- Manage variable synchronization consistently

### Step 10: Frame Cleanup and Write Count Capping

```javascript
if (iteratorCompiler || frame.writeCounts) {
  // Cap write counts to 1 for parent frame
  frame.writeCounts = this.async.countsTo1(frame.writeCounts);
}

frame = this.emit.asyncBlockBufferNodeEnd(node, frame, true, false, node.arr);
```

**What's happening:**

1. **Write count capping:**
   ```javascript
   // Before: frame.writeCounts = {x: 5, y: 3}
   // After:  frame.writeCounts = {x: 1, y: 1}
   ```

   Why? The loop as a whole is one unit of work to the parent. Whether it writes to `x` once or a million times, the parent only needs to wait for "the loop" to finish.

2. **Frame pop:**
   - Closes the async block for the loop
   - Returns parent frame
   - Parent frame has the capped counts (propagated during body/else compilation)

**Important subtlety:**
The condition checks `frame.writeCounts` (the loop frame), NOT just `bodyWriteCounts`:
- Body might not write, but else might
- Condition evaluation (in while) might write
- Any writes from any source need capping

---

## Part 2: Runtime Execution

### Phase 1: Poison Detection

```javascript
async function iterate(arr, loopBody, loopElse, loopFrame, buffer, loopVars, asyncOptions) {
  if (asyncOptions) {
    // Check for synchronous poison first
    if (isPoison(arr)) {
      poisonLoopEffects(loopFrame, buffer, asyncOptions, arr.errors);
      return;
    }

    // Check for promise that might reject
    if (arr && typeof arr.then === 'function') {
      try {
        arr = await arr;
      } catch (err) {
        const poison = isPoisonError(err) ? createPoison(err.errors) : createPoison(err);
        poisonLoopEffects(loopFrame, buffer, asyncOptions, poison.errors);
        throw err;
      }
    }
  }
```

**The two poison paths:**

**Path 1: Synchronous poison**
```javascript
for item in createPoison(new Error("DB down"))
  @data.items.push(item)
endfor
```
- `arr` is a `PoisonedValue` object
- `isPoison(arr)` returns true immediately
- No async work needed

**Path 2: Promise rejection**
```javascript
for item in fetchItems() // fetchItems returns rejected promise
  @data.items.push(item)
endfor
```
- `arr` is a promise
- `await arr` triggers the promise's `.then()` method
- If it's a poison, the `.then()` throws `PoisonError`
- We catch and convert back to poison for consistency

**What `poisonLoopEffects` does:**

```javascript
function poisonLoopEffects(frame, buffer, asyncOptions, poisonValue) {
  const poison = isPoison(poisonValue) ? poisonValue : createPoison(poisonValue);

  // Poison body variables
  if (asyncOptions.bodyWriteCounts && Object.keys(...).length > 0) {
    frame.poisonBranchWrites(poison, asyncOptions.bodyWriteCounts);
  }

  // Poison body handlers
  if (asyncOptions.bodyHandlers && asyncOptions.bodyHandlers.length > 0) {
    addPoisonMarkersToBuffer(buffer, poison, asyncOptions.bodyHandlers);
  }

  // Repeat for else...
}
```

**Variable poisoning (`poisonBranchWrites`):**
```javascript
// Loop would have written to x
// frame.pushAsyncBlock created a promise for x in parent
// Now resolve that promise with poison:
frame.asyncVars['x'] = poison;
frame._resolveAsyncVar('x'); // Resolves parent's promise with poison
```

**Handler poisoning (`addPoisonMarkersToBuffer`):**
```javascript
// Add marker objects to buffer array
buffer.push({
  __cascadaPoisonMarker: true,
  errors: poison.errors,
  handler: 'data'
});
```

Later, `flattenBuffer` will encounter these markers and collect the errors.

### Phase 2: Iterator Type Detection

```javascript
const sequential = asyncOptions ? asyncOptions.sequential : false;
const isAsync = asyncOptions !== null;

if (isAsync && arr && typeof arr[Symbol.asyncIterator] === 'function') {
  // Async iterator path
  if (sequential) {
    didIterate = await iterateAsyncSequential(arr, loopBody, loopVars, errorContext);
  } else {
    didIterate = await iterateAsyncParallel(arr, loopBody, loopVars, errorContext);
  }
} else if (arr) {
  // Sync collection path (arrays and objects)
  arr = fromIterator(arr); // Convert iterables to arrays

  if (Array.isArray(arr)) {
    // Array iteration...
  } else {
    // Object key/value iteration...
  }
}
```

**Four iteration paths:**

1. **Async iterator, sequential:** `iterateAsyncSequential`
2. **Async iterator, parallel:** `iterateAsyncParallel`
3. **Sync array:** Direct for loop
4. **Sync object:** `Object.keys()` + for loop

### Phase 3A: Async Sequential Iteration

```javascript
async function iterateAsyncSequential(arr, loopBody, loopVars, errorContext) {
  let didIterate = false;
  let i = 0;
  const errors = [];

  try {
    for await (const value of arr) {
      didIterate = true;

      // Soft error detection
      if (value instanceof Error && !isPoisonError(value)) {
        errors.push(value);
        i++;
        continue; // Keep going to collect all errors
      }

      if (isPoisonError(value)) {
        errors.push(...value.errors);
        i++;
        continue;
      }

      // Execute body
      let res = loopVars.length === 1
        ? loopBody(value, i, undefined, false, errorContext)
        : loopBody(...value.slice(0, loopVars.length), i, undefined, false, errorContext);

      // CRITICAL: await before next iteration
      try {
        await res;
        if (isPoison(res)) {
          errors.push(...res.errors);
        }
      } catch (err) {
        errors.push(...(isPoisonError(err) ? err.errors : [err]));
      }

      i++;
    }
  } catch (err) {
    // Hard error: generator threw instead of yielding
    const contextualError = handleError(err, ...errorContext);
    throw contextualError;
  }

  if (errors.length > 0) {
    throw new PoisonError(deduplicateErrors(errors));
  }

  return didIterate;
}
```

**Key behaviors:**

**Soft vs Hard errors:**
- **Soft:** Iterator yields an Error/PoisonError object → collect and continue
- **Hard:** Iterator throws → stop immediately

**Example:**
```javascript
async function* fetchComments() {
  try {
    const comment1 = await fetchComment(1);
    yield comment1;
  } catch (err) {
    yield err; // Soft error - caller can handle
  }

  // Hard error - can't continue
  throw new Error("Database connection lost");
}
```

**Sequential guarantee:**
```javascript
await res; // Wait for iteration N to complete
           // before starting iteration N+1
```

This ensures:
- Loop bindings (`loop.index`) are correct
- Variable writes don't race
- Output order matches source order

**Why `loop.length` and `loop.last` are undefined:**
Async iterators are potentially infinite. We can't know the total without consuming the entire iterator first.

### Phase 3B: Async Parallel Iteration

```javascript
async function iterateAsyncParallel(arr, loopBody, loopVars, errorContext) {
  const iterator = arr[Symbol.asyncIterator]();
  let i = 0;

  let lastPromiseResolve;
  let lastPromise = new Promise(resolve => {
    lastPromiseResolve = resolve;
  });

  const allErrors = [];
  const loopBodyPromises = [];

  // Promise for length calculation
  const lenPromise = new Promise((resolve) => {
    let length = 0;

    // Background task: consume iterator
    iterationComplete = (async () => {
      try {
        while (true) {
          try {
            result = await iterator.next();
          } catch (err) {
            // Soft error from awaiting yielded poison
            if (isPoisonError(err)) {
              allErrors.push(...err.errors);
              i++;

              // Still resolve loop bindings
              if (lastPromiseResolve) {
                lastPromiseResolve(false);
                lastPromise = new Promise(resolveNew => {
                  lastPromiseResolve = resolveNew;
                });
              }
              continue;
            }
            throw err; // Hard error
          }

          if (result.done) break;

          length++;
          const value = result.value;

          // Check for soft errors
          if (isPoison(value) || isPoisonError(value) || value instanceof Error) {
            allErrors.push(...);
            // ... still resolve promises
            continue;
          }

          // Resolve previous iteration's lastPromise
          if (lastPromiseResolve) {
            lastPromiseResolve(false);
            lastPromise = new Promise(resolveNew => {
              lastPromiseResolve = resolveNew;
            });
          }

          // Execute body (DON'T await - parallel)
          let res = loopVars.length === 1
            ? loopBody(value, i, lenPromise, lastPromise, errorContext)
            : loopBody(...value, i, lenPromise, lastPromise, errorContext);

          // Track promise for error collection
          if (res && typeof res.then === 'function') {
            loopBodyPromises.push(res);
            res.catch(err => { allErrors.push(...); });
          }

          i++;
        }

        // Resolve final lastPromise
        if (lastPromiseResolve) {
          lastPromiseResolve(true);
        }

        resolve(length); // Resolve lenPromise

        // Wait for all bodies
        await Promise.allSettled(loopBodyPromises);

        if (allErrors.length > 0) {
          throw new PoisonError(deduplicateErrors(allErrors));
        }
      } catch (error) {
        // ... handle hard error
      }
    })();
  });

  await lenPromise;
  await iterationComplete;

  return didIterate;
}
```

**The parallel magic:**

**1. Non-blocking iteration consumption:**
```javascript
// Main flow:
const lenPromise = new Promise((resolve) => {
  // Background IIFE starts consuming iterator
  (async () => { ... })();
});
```

The iterator is consumed in the background while loop bodies execute.

**2. Loop binding promises:**
```javascript
// Body receives promises, not values:
loopBody(value, i, lenPromise, lastPromise, errorContext)

// Inside compiled body:
frame.set('loop.length', lenPromise);  // Promise!
frame.set('loop.last', lastPromise);   // Promise!
```

If body code uses `loop.length`:
```javascript
{{ loop.index }} of {{ loop.length }}
```

The compiled code awaits `loop.length` when needed:
```javascript
await runtime.suppressValueAsync(loop.length, ...)
```

**3. lastPromise chain:**
Each iteration's `lastPromise` is resolved when the NEXT value arrives:
```javascript
// Iteration 1: lastPromise resolves to false (not last)
// Iteration 2: lastPromise resolves to false
// ...
// Iteration N: lastPromise resolves to true (is last)
```

**4. Parallel execution:**
```javascript
res = loopBody(...); // Returns promise
// DON'T await here!
loopBodyPromises.push(res); // Track for later
// Next iteration starts immediately
```

All iterations run concurrently, limited only by:
- Iterator yielding speed
- System resources

### Phase 4: Sync Array/Object Iteration

```javascript
if (Array.isArray(arr)) {
  const len = arr.length;

  for (let i = 0; i < arr.length; i++) {
    didIterate = true;
    const value = arr[i];
    const isLast = i === arr.length - 1;

    let res = loopVars.length === 1
      ? loopBody(value, i, len, isLast)
      : loopBody(...value.slice(0, loopVars.length), i, len, isLast);

    if (sequential) {
      await res; // Enforce ordering
    }
  }
}
```

**Simpler than async iterator:**
- Length is known: pass `len` directly (not a promise)
- `isLast` is known: pass boolean directly (not a promise)
- Still respect `sequential` flag for variable safety

**Object iteration:**
```javascript
const keys = Object.keys(arr);
const len = keys.length;

for (let i = 0; i < keys.length; i++) {
  const key = keys[i];
  const value = arr[key];
  const isLast = i === keys.length - 1;

  if (loopVars.length === 2) {
    const res = loopBody(key, value, i, len, isLast);
    if (sequential) await res;
  } else {
    throw new Error(`Expected two variables...`);
  }
}
```

Requires exactly 2 loop vars: `for key, value in object`.

### Phase 5: Else Handling

```javascript
if (!didIterate && loopElse) {
  await loopElse();
}
```

**Simple rule:** If loop never iterated, run else.

**Cases:**
- Empty array: `didIterate = false` → run else
- Poisoned array: early return before this check → else doesn't run
- Error during iteration: `didIterate = true` → else doesn't run

### Phase 6: Write Finalization

```javascript
if (bodyWriteCounts && sequential) {
  loopFrame.finalizeLoopWrites(bodyWriteCounts);
}
```

**What this does:**

During the loop:
- `sequentialLoopBody = true` suppressed write propagation
- Each `set x = ...` updated `frame.asyncVars['x']` but didn't signal completion
- Parent's promise for `x` is still pending

After the loop:
```javascript
finalizeLoopWrites(bodyWriteCounts) {
  for (const varName in bodyWriteCounts) {
    // Signal completion: loop finished all its writes to varName
    this._countdownAndResolveAsyncWrites(varName, 1);
  }
}
```

This:
1. Resolves the parent's promise for `x` with the final value
2. Decrements parent's write counter
3. Propagates the "loop finished" signal upward

**Why only for sequential loops?**
Non-sequential loops with writes don't exist (we force `sequential = true` if there are writes).

---

## Part 3: While Loop Implementation

While loops are implemented as a **transformation to for loops** using a fake iterator.

### Compilation

```javascript
compileWhile(node, frame) {
  if (!node.isAsync) {
    // Sync while: simple while() {} loop
    this.emit('while (');
    this._compileExpression(node.cond, frame, false);
    this.emit(') {');
    this.compile(node.body, frame);
    this.emit('}');
    return;
  }

  // Async while: transform to for loop
  const iteratorCompiler = (arrNode, loopFrame, arrVarName) => {
    // Compile condition evaluator
    const conditionEvaluatorName = 'while_condition_evaluator_' + this._tmpid();

    this.emit.line(`let ${conditionEvaluatorName} = async (frame) => {`);
    this.emit('  return ');
    this._compileAwaitedExpression(node.cond, loopFrame, false);
    this.emit.line(';');
    this.emit.line('};');

    // Create iterator from condition
    this.emit.line(`let ${arrVarName} = runtime.whileConditionIterator(frame, ${conditionEvaluatorName});`);
  };

  // Create fake For node
  const fakeForNode = new nodes.For(
    node.lineno, node.colno,
    new nodes.Symbol(node.lineno, node.colno, 'while_iterator_placeholder'),
    new nodes.Symbol(node.lineno, node.colno, 'iterationCount'),
    node.body,
    null // no else
  );
  fakeForNode.isAsync = true;

  // Delegate to for loop compiler
  this._compileFor(fakeForNode, frame, true, iteratorCompiler);
}
```

**The transformation:**

```javascript
// Source:
while asyncCondition()
  var result = process()
  @data.results.push(result)
endwhile

// Becomes effectively:
for iterationCount in whileConditionIterator(frame, conditionEvaluator)
  var result = process()
  @data.results.push(result)
endfor
```

### The Condition Iterator

```javascript
async function* whileConditionIterator(frame, conditionEvaluator) {
  frame = frame.push();
  frame.sequentialLoopBody = true;

  let iterationCount = 0;

  while (true) {
    try {
      const conditionResult = await conditionEvaluator(frame);

      // Soft error
      if (isPoison(conditionResult)) {
        yield new PoisonError(conditionResult.errors);
        frame.pop();
        return;
      }

      // Check if should continue
      if (!conditionResult) {
        break; // Condition false, stop looping
      }

      // Yield iteration count
      yield iterationCount;
      iterationCount++;

    } catch (err) {
      // Soft error from condition evaluation
      yield (isPoisonError(err) ? err : err);
      frame.pop();
      return;
    }
  }

  frame.pop();
}
```

**How it works:**

1. **Evaluates condition** each iteration
2. **Yields iteration count** if truthy (0, 1, 2, ...)
3. **Yields errors** if condition fails (soft errors)
4. **Throws** if condition has hard error
5. **Returns** when condition is false

**Why yield Error objects instead of PoisonedValue?**

Because `PoisonedValue` is thenable. If we yielded it:
```javascript
for await (const value of generator) {
  // If value is thenable, JS awaits it automatically
  // PoisonedValue.then() throws immediately
  // Generator terminates!
}
```

By yielding `Error` or `PoisonError` objects (not thenable), the loop stays alive and can collect all errors.

### Write Counting in While

**Special consideration:**
The condition expression might have sequential operations:
```javascript
while account!.getBalance() > 0
  var amount = account!.withdraw(10)
  @data.transactions.push(amount)
endwhile
```

The condition `account!.getBalance()` writes to the sequence lock `!account`.

**How it's handled:**

1. **During condition compilation:**
   ```javascript
   this._compileAwaitedExpression(node.cond, loopFrame, false);
   ```

   This triggers `updateFrameWrites(loopFrame, '!account')`.

2. **In iteratorCompiler:**
   The condition evaluator runs in the loop frame, so writes are tracked there.

3. **Sequential enforcement:**
   ```javascript
   frame.sequentialLoopBody = true;
   ```

   This suppresses immediate write propagation. All writes (from condition + body) are finalized together after the loop.

4. **Combined finalization:**
   ```javascript
   // In _compileFor after delegation:
   if (iteratorCompiler || frame.writeCounts) {
     frame.writeCounts = this.async.countsTo1(frame.writeCounts);
   }
   ```

   Caps both condition writes and body writes to 1 for the parent.

### Why Sequential is Always True for While

```javascript
this._compileFor(fakeForNode, frame, true, iteratorCompiler);
//                                   ^^^^
//                                   sequential = true
```

**Reason:** While loops that have async conditions with side effects need sequential execution. Since we can't statically determine if the condition has side effects, we always use sequential mode for safety.

Additionally, while loops conceptually execute one iteration at a time (checking condition between each), so parallel execution doesn't make semantic sense.

---

## Summary: The Complete Flow

### Compile Time
1. **Parse** loop structure into AST nodes
2. **Analyze** for async operations, variables, handlers
3. **Generate functions** for body and else
4. **Track metadata:** write counts, handler names, sequential flag
5. **Emit call** to `runtime.iterate()` with functions + metadata

### Runtime
1. **Poison check:** Is array/iterator poisoned before starting?
2. **Type detection:** Async iterator, sync array, or object?
3. **Iteration:** Execute body function for each value
   - Sequential: await each iteration
   - Parallel: fire all, track promises
4. **Error collection:** Gather all soft errors, throw hard errors
5. **Else handling:** Run if never iterated
6. **Write finalization:** Signal completion to parent frame

### Key Design Decisions

**Separation of concerns:**
- Compiler: static analysis, code generation
- Runtime: dynamic behavior, state management

**Function-based bodies:**
- Loop body is a function, not inline code
- Enables reuse across iterations
- Clean parameter passing

**Metadata over inline checks:**
- Pass handler names, don't check in runtime
- Pass write counts, don't calculate in runtime
- Faster, simpler, more maintainable

**Unified poison handling:**
- One place to poison variables: `poisonLoopEffects()`
- One place to poison handlers: same function
- Applied consistently across all loop types

**Promise-based synchronization:**
- Variables locked with promises during async blocks
- Write counting tracks when to unlock
- No manual mutex/semaphore management needed

This architecture supports complex features (async iterators, poison propagation, variable synchronization) while keeping the code comprehensible and maintainable.