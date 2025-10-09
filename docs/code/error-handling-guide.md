# Cascada Error Handling: A Comprehensive Guide

## 1. Core Philosophy: Precise and Developer-Friendly Errors

The primary goal of Cascada's error handling system is to provide developers with the most precise and helpful error messages possible. An error message should always include:

1.  **What** went wrong (the error message).
2.  **Where** it went wrong (the template path, line number, and column number).
3.  **Context** about the operation being performed (e.g., "in a `LookupVal`").

To achieve this, Cascada employs a sophisticated system that bridges the gap between the compiler (which knows the "where") and the runtime (which knows the "what"). This guide explains the components of this system and the design decisions behind them.

## 2. The Three Core Components

Three key constructs form the foundation of our error handling.

### `TemplateError`
This is the **universal, user-facing error object**. The goal is for every unhandled exception that bubbles up from a template render to be an instance of `TemplateError`. It wraps a standard JavaScript `Error` but enriches it with positional information (`lineno`, `colno`, `path`, etc.).

### `PoisonError` and `PoisonedValue` (Async Mode Only)
`PoisonError` is a special error type used exclusively in async mode. Its purpose is to act as a **transport mechanism for one or more `TemplateError`s**.

*   **It is a container:** It holds an `.errors` array of the actual errors that occurred.
*   **It has no context of its own:** A `PoisonError` should never have a `lineno` or `colno` attached to it. The individual errors inside it must each retain their own unique contextual information.
*   **It enables "Never Miss Any Error":** It allows us to collect all errors from parallel async operations before throwing, ensuring the developer sees a complete picture of what's wrong.

`PoisonedValue` is the thenable counterpart used to propagate poison through the data flow before an `await` forces it to become a thrown `PoisonError`.

### `runtime.handleError()`
This is the central, **idempotent** utility for ensuring any error is correctly formatted. It is the gatekeeper for creating `TemplateError`s. It intelligently handles three types of input:

1.  **Raw JavaScript Error (e.g., `TypeError`):** It wraps the raw error in a new `TemplateError`, adding the provided positional context.
2.  **Existing `TemplateError`:** It recognizes the error has already been handled (by checking for a `.lineno` property) and returns it unmodified, preventing double-wrapping.
3.  **`PoisonError`:** It recognizes the error is a container and returns it unmodified, preserving the multiple errors within.

**Fundamental Rule:** Any `catch` block in the runtime or compiled code that needs to process an unknown error `e` **MUST** pass it through `runtime.handleError(e, ...)`.

## 3. The Two Coexisting Systems

Cascada maintains two distinct error handling models that run in parallel: the battle-tested synchronous model inherited from Nunjucks, and a new, more robust model for asynchronous operations.

### The Synchronous Model ("The Nunjucks Way")

For stability and backward compatibility, the error handling for non-async templates remains unchanged.

*   **Mechanism:** It uses a "global" variable hack. The compiler injects code that updates `lineno` and `colno` variables just before an operation.
    ```javascript
    // Compiled Sync Code
    output += runtime.callWrap(
      (lineno = 10, colno = 5, frame.lookup("myFunc")), // The hack in action
      ...
    );
    ```
*   **Error Catching:** A single, top-level `try...catch` block wraps the entire template rendering function. When an error is thrown, this block catches it.
    ```javascript
    // In the compiled root function
    try {
      // ... all template code ...
    } catch (e) {
      // Uses the *last known* values of lineno/colno
      var err = runtime.handleError(e, lineno, colno, ...);
      cb(err);
    }
    ```
*   **Why it's preserved:** This model is simple and has been battle-tested for years. While slightly less precise than the async model, its stability is paramount. We avoid changing it to prevent introducing regressions.

### The Asynchronous Model (Cascada Enhancements)

Async operations introduce complexities (like parallel execution and decoupled call stacks) that the sync model cannot handle. The async model is designed for maximum precision and robustness, using a hybrid strategy.

#### Strategy A: "Pass the Context" (For Logic-Domain Errors)

This is the **preferred strategy** for errors that we explicitly check for in our own runtime code.

*   **Problem:** A runtime function like `callWrapAsync` needs to report an error if it's asked to call a non-function. How does it know the `lineno` of that call?
*   **Solution:** We pass the context directly to the function.
    1.  **The Compiler** creates a context object from the current node's position.
    2.  **The Runtime Function** signature is updated to accept this object.
    3.  When the runtime function needs to create an error, it uses the context it was given.

*   **Example: `callWrapAsync`**

    **Before:**
    ```javascript
    // runtime.js
    function callWrapAsync(obj, name, context, args) {
      if (typeof obj !== 'function') {
        // No lineno/colno available!
        return createPoison(new Error('...'), null, null, null, context.path);
      }
      // ...
    }
    // compiler.js
    this.emit(`runtime.callWrapAsync(...)`);
    ```

    **After:**
    ```javascript
    // runtime.js
    function callWrapAsync(obj, name, context, args, errorContext) {
      if (typeof obj !== 'function') {
        // Full context is available!
        return createPoison(new Error('...'), errorContext.lineno, errorContext.colno, ...);
      }
      // ...
    }
    // compiler.js
    const errorContext = this._createErrorContext(node); // Create the context object
    this.emit(`runtime.callWrapAsync(..., ${JSON.stringify(errorContext)})`);
    ```

#### Strategy B: "Let it Throw & Catch" (For Native JS Errors on Hot Paths)

This strategy is used sparingly for operations where the error is thrown by the **native JavaScript engine**, especially on performance-critical "hot paths."

*   **Problem:** `memberLookupScript('foo', null)` is valid. `memberLookupScript(null, 'foo')` is not. The `null['foo']` operation will cause the JS engine to throw a `TypeError`. We cannot inject our `errorContext` into the native `[]` accessor.
*   **Rationale:** We could wrap the operation in a `try/catch` *inside* `memberLookupScript`, but this can de-optimize a very high-frequency operation, penalizing every successful property lookup.
*   **Solution:** We keep the runtime function lean and fast, letting it throw the native error. The **compiler** then wraps the call site in a `try/catch` block, where the context is known.

*   **Example: `memberLookupScript`**

    **1. The Lean Runtime Function:**
    ```javascript
    // runtime.js - No try/catch for maximum performance
    function memberLookupScript(obj, val) {
      return obj[val]; // May throw native TypeError
    }
    ```

    **2. The Compiler's Generated Code:**
    ```javascript
    // compiled_template.js
    try {
      t_1 = runtime.memberLookupScript(t_2, "property");
    } catch (e) {
      // The catch block has the context from the LookupVal node
      var err = runtime.handleError(e, 10, 5, "LookupVal", "my_template.njk");
      // Propagate the enriched error as poison
      t_1 = createPoison(err);
    }
    ```

This hybrid approach gives us the best of both worlds: the clean "Pass the Context" model for most cases, and the high-performance "Let it Throw" model for critical native operations.

## 4. Advanced Context Propagation: Through Data

Sometimes, an error can only be detected long after the initial call, in a generic function like `flattenBuffer`. In these cases, context is propagated **through data structures**.

The `OutputCommand` node (`@handler()`) is a perfect example:

1.  **Compile Time:** The compiler encounters `@data.add(...)` at line 20, column 10. It compiles this not as a direct function call, but as a JavaScript object. It **serializes the position info into this object**.
    ```javascript
    // compiled_template.js
    output.push({
      handler: 'data',
      command: 'add',
      arguments: [...],
      pos: { lineno: 20, colno: 10 } // Context is now data
    });
    ```
2.  **Render Time:** Much later, `flattenBuffer` processes the `output` array. It finds this object.
3.  **Error Detection:** `flattenBuffer` discovers there is no handler named 'data'. It now needs to create an error.
4.  **Error Enrichment:** It extracts the `pos` object from the item it's processing and uses that information to call `handleError`, creating a perfectly contextualized `TemplateError`.

This powerful pattern ensures that even in decoupled parts of the system, context is never lost.

## 5. Implementation Best Practices

*   **Always use `runtime.handleError`:** Every `catch (e)` block that handles an unknown error must use `handleError` to ensure errors are correctly wrapped and not double-wrapped.
*   **Scope changes to `asyncMode`:** The legacy sync model should not be altered. All refactoring efforts target the async model.
*   **"Pass the Context" is the default:** When adding a new runtime function that can fail, prefer adding an `errorContext` parameter.
*   **"Let it Throw" is for hot-path native errors:** Only use the compiled `try/catch` strategy for high-frequency, native JS operations like property access.
*   **`PoisonError` is a sacred container:** Never add or modify the context of a `PoisonError` itself. Its value is in preserving the original, individual contexts of the errors it contains.