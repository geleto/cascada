## `PoisonedValue` Class

A lightweight, inspectable error container that enables synchronous error detection while providing thenable protocol compatibility for `await` and promise chains.

### Design Trade-offs

**⚠️ Not Fully Promise A+ Compliant**

This implementation prioritizes performance over strict Promise A+ compliance:

1. **Synchronous Handler Execution**: Rejection handlers (`.catch()`, `.then(null, handler)`) execute synchronously instead of on the microtask queue.
2. **Reuses `this`**: When no handler is provided, `.then()` returns the same `PoisonedValue` instance instead of creating a new promise.

**Implications:**
- ✅ **faster** for sync-first error propagation patterns
- ✅ **Zero overhead** when poison propagates unchecked
- ⚠️ **Handlers run immediately** - not deferred to microtask queue
- ⚠️ **May break** complex promise chain assumptions in external libraries

**When to use:** Systems where synchronous error checking with `isPoison()` is the primary pattern, and handler execution timing is not critical.

**When NOT to use:** When strict Promise A+ compliance is required or when interoperating with libraries that depend on asynchronous handler execution.

### API

#### Constructor
```javascript
new PoisonedValue(errors)