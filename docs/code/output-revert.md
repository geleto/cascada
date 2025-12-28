## Output Revert Implementation

### 1. Overview

`_revert()` resets an output handler back to the state it had at the start of the nearest enclosing **output scope**. Cascada now supports three invocation forms:

- `@handler._revert()` — handler-specific reset.
- `@._revert()` — universal reset for all handlers in the current scope.
- `{% revert %}` — template shorthand that expands to `@._revert()`.

An output scope is created whenever the compiler builds a buffer that represents a logical unit of output. These fall into two categories:

| Construct | How it’s compiled | Scope behavior |
|-----------|-------------------|----------------|
| **Root render** (`compileRoot`, includes rendered via `_renderForComposition`) | Buffer lives for the entire render | `_revert()` at top level reverts to script/template start |
| **Guard** (`compileGuard`) | Body rendered into a nested buffer appended to parent | `_revert()` inside guard reverts only that guard’s body |
| **Include / call / caller** when rendered into parent output | Child template/call output is inserted as an array entry | `_revert()` inside the included template/caller is isolated |
| **Capture / macro / call content** (returning buffers) | Body rendered into a temporary array that is flattened and returned | `_revert()` reverts only the captured/macro output before it’s returned |

Tree-attached scopes (root, guard, include/call that write straight into the parent buffer) must be marked immediately. Returning scopes (capture/macro/caller) are flattened right after their body runs, so scope metadata can be initialized lazily just before `flattenBuffer`.

### 2. Compilation Pipeline

1. **Script Transpiler**
   - Converts Cascada Script `@...` syntax to `{% output_command ... %}`.
   - Recognizes `@._revert()` shorthand and rewrites it to call handler `_`.
2. **Parser**
   - `parseRevert()` handles `{% revert %}` and emits a `nodes.Revert`.
   - `parseOutputCommand()` (existing) handles explicit `@handler._revert()`.
3. **Compiler**
   - `compileOutputCommand` validates `_revert()` (root-only, no subpaths, data handler special case).
   - Emits `{ handler: 'text'|'data'|... , command: '_revert', arguments: [] }` into the buffer.
   - Calls `runtime.markBufferHasRevert(buffer)` so the runtime knows this scope needs processing.
   - `compileRevert` (new) emits the same buffer command for `{% revert %}`.
4. **Scope Marking (`frame.markOutputBufferScope`)**
   - Guard/include/call buffers that live in the parent tree are tagged eagerly (`_outputScopeRoot = true`, `_hasRevert = false`).
   - Capture/macro buffers are no longer marked explicitly; they rely on lazy initialization when flattened (see runtime below).

### 3. Runtime Mechanics

#### 3.1 Scope Metadata

`runtime/buffer.js` introduces `ensureBufferScopeMetadata`, invoked by `flattenBuffer` before processing the array. It ensures every buffer being flattened has:

- `_outputScopeRoot`: marks the array as a scope root.
- `_hasRevert`: initially `false`; set to `true` when `_revert()` appears in that scope.

Tree-attached scopes (root, guard, include/call) still set these flags eagerly at creation so nested scopes are recognized before flattening. Returning scopes (capture/macro/caller) pass through `flattenBuffer` immediately after execution, so the lazy initialization path guarantees they behave as root scopes without extra compiler involvement.

#### 3.2 Tracking `_revert()`

- `markBufferHasRevert(buffer)` flips `_hasRevert` and resets `_revertsProcessed` so the scope will be revisited.
- Buffer entries for `_revert()` look like:

  ```js
  { handler: 'text', command: '_revert', arguments: [], pos: { lineno, colno } }
  ```

- Universal `_revert()` (`@._revert()` / `{% revert %}`) uses handler `_`. The compiler flags the marker with `targetsAllHandlers = true` so the runtime knows it applies to every handler in that scope.

#### 3.3 Pre-flatten Pass (`processReverts`)

`flattenBuffer` always calls `processReverts(arr)` (after lazy metadata). `processReverts` walks the buffer tree once, applying `_revert()` per scope:

1. **walkBufferForReverts**
   - If the current array is a scope root (`_outputScopeRoot` or forced root), it creates a fresh `linearNodes` stack to record entries in order.
   - Scopes without `_hasRevert` are skipped entirely.
   - Nested arrays:
     - If they are scope roots, recursion runs with a new stack; the parent records the child as a single entry with `parentIndexRef`.
     - If they are plain arrays, recursion shares the parent stack.
2. **revertLinearNodes**
   - When `_revert()` is encountered, items are popped from the current scope’s stack until either:
     - Another `_revert` marker for the same handler (or universal marker) is reached, or
     - The stack empties (scope start).
   - Matching entries are marked `_reverted` so `flattenBuffer` will skip them.
   - Universal markers (`targetsAllHandlers`) match both universal and handler-specific rewinds. The helper also records `parentIndexRef` so once the scope-level rewind stops, the traversal resumes precisely at the parent node that owned this child array.

#### 3.4 Flattening

`flattenBuffer` respects `_reverted` entries in both template fast-path and script mode. The final render only contains surviving text/handler results. Focused outputs (`:data`, `:text`, etc.) are applied after the pass completes.

### 4. Revert Tag (`{% revert %}`)

- Parsed as a zero-argument statement (`nodes.Revert`).
- Compiled to the same buffer command as `@._revert()` and flagged via `runtime.markBufferHasRevert`.
- Available in template mode for readability within guards, includes, call blocks, etc.

### 5. Tests

1. **Script Mode** (`tests/pasync/script-output.js`)
   - Covers handler-specific `_revert()` (text/data), nested scopes, and `_._revert()`.
2. **Template Mode (StringLoader)**
   - “Template `_revert` integration” tests confirm `{% revert %}` inside `{% include %}` and `{% call %}`/`caller()` blocks only affects the included/call scope.
   - Guard tests (`tests/poison/guard.js`) exercise `{% revert %}` directly inside guard bodies.
3. **Regression Coverage**
   - Run via `npm run mocha:single -- tests/pasync/script-output.js --timeout 5000` and `npm run mocha:single -- tests/poison/guard.js --timeout 5000`.

### 6. Future Considerations

- Potential per-handler `_hasRevert` metadata to skip scopes that only target unrelated handlers.
- Additional user-facing documentation with examples for `@._revert()` / `{% revert %}` in both script and template guides.
- Exposing `{% revert %}` syntax in template documentation alongside guard/include usage.

