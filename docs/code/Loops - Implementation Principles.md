## Loop Execution Implementation Principles

When the compiler generates the per-iteration closure it now uses `astate.asyncBlock(...)` instead of the legacy `runtime.executeAsyncBlock(...)`. The semantics are identical: the async state registers the child block, creates the frame via `frame.pushAsyncBlock`, and ensures `_leaveAsyncBlock()` runs in a `finally` so `waitAllClosures()` keeps working. The emitted call looks like:

```
astate.asyncBlock(async (childState, childFrame) => {
  // loop body
  return output;
}, runtime, frame, readVars, writeCounts, cb, lineno, colno, context, errorContext);
```
