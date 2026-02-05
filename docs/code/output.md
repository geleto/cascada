# Output Architecture

**Status:** ✅ Current — reflects the command-next refactor (output-refactor-2 branch).

This document describes how output handlers work end-to-end: from declaration through command
enqueueing, flatten, and final resolution via `snapshot()`. It covers both script mode (the
primary focus) and template mode (which retains the legacy path).

---

## Table of Contents

- [Big Picture](#big-picture)
- [Output Class Hierarchy](#output-class-hierarchy)
- [The `_target` / `_base` Split](#the-_target--_base-split)
- [Output Wrapping: Callable vs Proxy](#output-wrapping-callable-vs-proxy)
- [Output Scoping](#output-scoping)
- [The Output Lookup Maps](#the-output-lookup-maps)
- [Command Classes](#command-classes)
- [The Flatten Pipeline](#the-flatten-pipeline)
- [Error Handling: ErrorCommand vs Legacy Markers](#error-handling-errorcommand-vs-legacy-markers)
- [snapshot() Resolution](#snapshot-resolution)
- [Handler Classes: DataHandler and ValueHandler](#handler-classes-datahandler-and-valuehandler)
- [Template vs Script Mode](#template-vs-script-mode)
- [How Output Commands Flow Through the Compiler](#how-output-commands-flow-through-the-compiler)
- [Buffer Allocation Checklist](#buffer-allocation-checklist)
- [Key Invariants and Gotchas](#key-invariants-and-gotchas)

---

## Big Picture

A script declares typed output handlers (`data myData`, `text myText`, `value myVal`,
`sink mySink = expr`). Commands targeting those handlers accumulate in a `CommandBuffer`.
When the user calls `myData.snapshot()`, the buffer is flattened: each command is replayed
against the Output object, populating its `_target` (accumulator) and `_base` (handler instance).
`snapshot()` then reads the final value from those properties directly — no second flatten pass.

```
  Script code                  Buffer                     Flatten                  snapshot()
  ──────────                   ──────                     ───────                  ──────────
  data myData                  creates Output             (noop)                   (noop)
  @data.set("x", 1)           enqueues command ─────►    replays → _base.set()    reads _base.getReturnValue()
  @data.set("y", 2)           enqueues command ─────►    replays → _base.set()    reads _base.getReturnValue()
  return data.snapshot()       ─────────────────────────►  triggers flatten  ─────► returns {x:1, y:2}
```

The flatten pass runs exactly once per buffer (cached on `buffer._flattenState`). Subsequent
`snapshot()` calls on any output that shares the buffer skip the flatten and read directly
from `_target` / `_base`.

---

## Output Class Hierarchy

All output types share a common base. The class chosen at declaration time determines the
accumulator shape and how `snapshot()` resolves the final value.

```
Output  (base — owns _buffer, snapshot(), _resolveFromOutput(), _enqueueCommand())
├── TextOutput      _target: []            wrapped via createCallableOutput
├── ValueOutput     _target: undefined     wrapped via createCallableOutput
│                   _base:   null
├── DataOutput      _target: {}            wrapped via createOutputProxy (Proxy)
│                   _base:   null
└── SinkOutputHandler  (standalone, not extends Output)
                    _target: undefined
                    _base:   null
```

**File:** [`src/runtime/output.js`](src/runtime/output.js)

### TextOutput
- `_target` is an array of strings. Each text command pushes one element.
- No `_base` — text has no handler instance; it accumulates directly.
- `snapshot()` joins the array: `_target.join('')`.

### ValueOutput
- `_target` starts as `undefined`. A value command replaces it entirely.
- `_base` is the `ValueHandler` instance (see [Handler Classes](#handler-classes-datahandler-and-valuehandler)).
  Resolved lazily on first command via `getOrInstantiateHandler`.
- `snapshot()` delegates to `_base.getReturnValue()` when `_base` is set.

### DataOutput
- `_target` starts as `{}` — the empty-data default returned when no commands fire.
- `_base` is the `DataHandler` instance. Resolved lazily.
- `snapshot()` delegates to `_base.getReturnValue()` when `_base` is set; otherwise returns `_target`.
- Wrapped in a **Proxy** (see [Output Wrapping](#output-wrapping-callable-vs-proxy)) so that
  arbitrary method calls (`myData.set(...)`, `myData.push(...)`) are intercepted and enqueued as
  commands without needing to pre-declare every method.

### SinkOutputHandler
- Does not extend `Output`. It is a standalone class that owns its own `snapshot()`.
- The sink object itself is the "handler". `_base` points to the resolved sink after flatten.
- `snapshot()` calls `sink.snapshot()` / `sink.getReturnValue()` / `sink.finalize()` — whichever
  the sink provides.

---

## The `_target` / `_base` Split

Every Output has up to two accumulator properties. Understanding the split is essential for
reasoning about the error path.

| Property | Purpose | Set by |
|----------|---------|--------|
| `_target` | The value that `snapshot()` returns (or throws from). Type-appropriate default at construction. | TextCommand pushes; ValueCommand replaces; ErrorCommand poisons. |
| `_base`   | The handler instance that data/value commands dispatch to. Stable across the Output lifetime. | `getOrInstantiateHandler()` during first flatten command for this handler. |

**Happy path (data/value):** Commands dispatch to `_base`; `snapshot()` reads from
`_base.getReturnValue()`. `_target` remains at its default but is never read.

**Error path:** `ErrorCommand.apply(ctx)` sets `ctx._target = new PoisonedValue(errors)`.
`snapshot()` sees the PoisonedValue on `_target` and throws `PoisonError` before ever reading
`_base`. This means a single error poisons the entire output regardless of how many successful
commands preceded it.

**Text path:** No `_base`. Commands push directly into `_target` (the string array).
`snapshot()` joins it.

---

## Output Wrapping: Callable vs Proxy

Output instances are never handed to user code directly. They are wrapped so that user-facing
API calls (`myText("hello")`, `myData.set("x", 1)`) translate into buffer commands.

### Callable outputs (Text, Value)

`createCallableOutput(output)` returns a **function** that, when called, invokes `output.invoke(...)`.
`attachOutputApi` copies metadata (`snapshot`, `_outputName`, etc.) onto the function and — critically —
installs **live bindings** for `_target` and `_base`:

```javascript
// src/runtime/output.js — attachOutputApi
Object.defineProperty(target, '_target', {
  get() { return output._target; },
  set(v) { output._target = v; },
  ...
});
Object.defineProperty(target, '_base', {
  get() { return output._base; },
  set(v) { output._base = v; },
  ...
});
```

**Why live bindings matter:** The wrapper (`target`) is what gets stored in `frame._outputs` and
later in `buffer._outputs`. When the flattener writes `outputCtx._target.push(...)` or
`outputCtx._base = instance`, those writes must land on the underlying `Output` instance so that
`snapshot()` — which is bound to `output` — can read them. A plain property copy (`target._target = output._target`)
would snapshot an empty array and never see flatten's writes.

### Proxy outputs (Data)

`createOutputProxy(output)` returns a **Proxy** with a `get` trap. The trap:

1. **Whitelists** internal properties: `snapshot`, `_outputName`, `_outputType`, `_frame`,
   `_context`, `_target`, `_base`, `_buffer`. These read directly from the underlying `DataOutput`.
2. **Returns `undefined` for `then`** — prevents the Proxy from being treated as a thenable.
3. **Returns a command-enqueueing closure** for everything else: `(...args) => target._enqueueCommand(prop, args)`.
   This is how `myData.set("x", 1)` becomes a `{ handler: "myData", command: "set", arguments: ["x", 1] }` entry
   in the buffer.

DataOutput has no `set` trap. Property assignments to `_target` and `_base` fall through to the
underlying object via default Proxy behavior.

---

## Output Scoping

Outputs follow the same scoping rules as variables: **lexical parent-chain lookup**.

- `createOutput` runs exactly once, at the declaration site (`data myData`). The Output is stored
  in `frame._outputs[name]`.
- When code in a nested scope references `myData`, `getOutputHandler(frame, name)` walks up the
  frame parent chain until it finds the declaring frame.
- The Output is **not** re-created at each nested frame. There is exactly one Output instance per
  declaration, shared by all inner scopes.

```javascript
// src/runtime/output.js — getOutputHandler
function getOutputHandler(frame, outputName) {
  let current = frame;
  while (current) {
    if (current._outputs && Object.prototype.hasOwnProperty.call(current._outputs, outputName)) {
      return current._outputs[outputName];
    }
    current = current.parent;
  }
  return undefined;
}
```

---

## The Output Lookup Maps

The flattener needs two name-keyed lookups on the buffer. They cover disjoint sets of outputs —
mixing them is one of the most error-prone parts of the system.

| Property | Contains | Used for |
|----------|----------|----------|
| `buffer._outputHandlers` | **Sink outputs only.** The `SinkOutputHandler` instance is itself the handler. | `getOrInstantiateHandler` early-return: if a sink is registered here, it IS the handler instance — return it directly. |
| `buffer._outputs` | **All non-sink outputs** (text, data, value). The Output wrapper (callable or Proxy). This is the same object as `frame._outputs` — the buffer stores a reference, so later declarations in the same frame are visible without re-wiring. | `getOutputCtx(name)` during flatten, to wire `_target` and `_base`. |

### Registration (compiler)

`frame._outputs` is lazily created before the buffer; the buffer captures a reference to it once:

```javascript
// src/compiler/compiler.js — compileOutputDeclaration (simplified)
frame._outputs = frame._outputs || Object.create(null);
if (!frame._outputBuffer) { frame._outputBuffer = new CommandBuffer(...); }
if (!frame._outputBuffer._outputs) { frame._outputBuffer._outputs = frame._outputs; }
```

Sink outputs additionally register into `_outputHandlers`; non-sink outputs only go into
`frame._outputs` (which the buffer already references):

```javascript
if (outputType === 'sink') {
  // ... createSinkOutput ...
  frame._outputBuffer._outputHandlers["name"] = frame._outputs["name"];
} else {
  // ... createOutput — no second registration needed ...
}
```

### Propagation to flatten state

`flattenCommandBuffer` copies `_outputs` from the buffer into the shared flatten state once,
at the root:

```javascript
if (!state.outputCtxs && buffer && buffer._outputs) {
  state.outputCtxs = buffer._outputs;
}
```

The guard (`!state.outputCtxs`) ensures child buffers (async blocks, loop iterations) do not
overwrite the root's map. All nested flatten calls share the same `outputCtxs` reference.

### Why the separation

During the command-next refactor, an early attempt stored non-sink Outputs in `_outputHandlers`.
`getOrInstantiateHandler` has an early-return path:

```javascript
if (state.outputHandlers && state.outputHandlers[handlerName]) {
  return state.outputHandlers[handlerName];   // ← returns the value AS the handler
}
```

For sinks this is correct: the `SinkOutputHandler` IS the handler. For a `DataOutput` wrapper
(a Proxy), returning it as a handler caused data commands to call `.set()` on the Proxy —
which enqueued another command instead of mutating state, producing empty `{}` outputs.
Separating the two maps makes the contract unambiguous.

---

## Command Classes

**File:** [`src/runtime/commands.js`](src/runtime/commands.js)

Commands are the items that live in script-mode buffers. Each has an `apply(ctx)` method that
mutates the Output (`ctx`) in place. The flattener does not inspect command internals — it just
calls `apply`.

```
Command  (abstract base)
├── TextCommand(value)            apply: ctx._target.push(value)
├── ValueCommand(value)           apply: ctx._target = value
├── ErrorCommand(poisonedValue)   apply: ctx._target = poisonedValue
└── HandlerCommand(subpath)       (shared base for handler-dispatching commands)
    ├── DataCommand(path, command, args)   apply: ctx._base[command](...args)
    └── SinkCommand(command, args, subpath)  apply: ctx._base[command](...args)

---

## The Flatten Pipeline

Flatten is the pass that replays the buffer and populates `_target` / `_base` on each Output.

### Entry: `flattenOutput` and `flattenBuffer` (flatten-buffer.js)

There are two entry points. The Output owns everything flatten needs — buffer, context, and
output name — so script mode goes through the Output-driven entry. Template mode and internal
recursion use the array-based entry.

**`flattenOutput(output)`** — script-mode entry. Extracts `_buffer`, `_context`, `_outputName`
from the Output. Handles the template-mode empty-output shortcut. For script mode it triggers
the flatten (which populates `_target`/`_base` as a side effect), then resolves the final value
via `output._resolveFromOutput()`. For template mode or the implicit `output` handler it returns
the flatten result directly.

**`flattenBuffer(arr, context, outputName)`** — internal / template entry. Still used by:
- Template mode (no Output object exists)
- The legacy fallback in `snapshot()` (no CommandBuffer)
- All recursive descent into nested CommandBuffers during flatten

`flattenBuffer` dispatches:
- **CommandBuffer + context** → `flattenCommandBufferCached`
- **No context** → `flattenText` (template text rendering)
- **Array + context** → `flattenCommands` (legacy or sub-array)

### Caching: `flattenCommandBufferCached`

A CommandBuffer is flattened **at most once**. The result state is cached on `buffer._flattenState`
(sync) or `buffer._flattenStatePromise` (async). Subsequent calls skip flatten and resolve
directly from the cached state. This is safe because flatten is idempotent: once `_target`/`_base`
are populated, re-running would produce the same result.

```javascript
// flatten-buffer.js
if (buffer._flattenState) {
  return resolveFromState(buffer._flattenState);  // cache hit — sync
}
if (buffer._flattenStatePromise) {
  return buffer._flattenStatePromise.then(resolveFromState);  // cache hit — async
}
// cache miss — run flatten, store result
```

### `flattenCommandBuffer` (flatten-commands.js)

Handles the top-level dispatch for a CommandBuffer:

1. Propagates `_scriptMode`, `_outputHandlers`, `_outputs` from the buffer into the shared
   flatten state.
2. If a specific `outputName` is requested, flattens only that handler's array.
3. Otherwise, discovers all declared handler names from `buffer.arrays` and flattens each one,
   collecting any pending promises for `Promise.all`.
4. Finalizes: throws `PoisonError` if errors were collected; otherwise returns the assembled result
   via `buildFinalResultFromState`.

### `flattenCommands` (flatten-commands.js)

The workhorse. Iterates items in a handler's array and dispatches each one:

- **ErrorCommand** → applies to the Output ctx (`item.apply(outputCtx)`) AND collects errors
  into `state.collectedErrors`.
- **Legacy poison marker** (`__cascadaPoisonMarker`) → collects errors into state.
- **PoisonedValue** → collects errors directly.
- **CommandBuffer** → recurses via `flattenBuffer`.
- **Command object** (`item.handler !== undefined`) → dispatches to `processCommandItem` (sync)
  or `processCommandItemAsync` (if args contain promises or handler is a sink).
- **Plain object** (`{text, data}`) → handled by `processObjectItem` (see [gotchas](#key-invariants-and-gotchas)).
- **Bare value** → emitted as text.

### How `_target` and `_base` get populated

Two specific points in `flattenCommands` wire the new Output properties:

**Text → `_target`:** `emitText` pushes values into both the legacy `state.textOutput[name]`
array AND the Output's `_target`:

```javascript
function emitText(name, values) {
  getTextOutputFromState(state, name).push(...values);   // legacy path
  const outputCtx = getOutputCtx(name);
  if (outputCtx && Array.isArray(outputCtx._target)) {
    outputCtx._target.push(...values);                   // new path
  }
}
```

**Data/Value → `_base`:** Every instantiation path inside `getOrInstantiateHandler` wires `_base`
after creating the handler instance:

```javascript
const instance = new HandlerClass(context.getVariables(), env);
state.handlerInstances[handlerName] = instance;   // legacy path
const outputCtx = getOutputCtx(handlerName);
if (outputCtx && !outputCtx._base) {
  outputCtx._base = instance;                     // new path
}
```

Both paths coexist: the legacy `state.textOutput` / `state.handlerInstances` still feed
`buildFinalResultFromState` (used by the implicit-return / `output` handler path), while
`_target` / `_base` feed `_resolveFromOutput` (used by explicit `snapshot()` calls on named
outputs in script mode).

---

## Error Handling: ErrorCommand vs Legacy Markers

Script mode and template mode use different error representations in buffers.

### Script mode: ErrorCommand

When a branch is skipped due to a poisoned condition, `addPoisonMarkersToBuffer` in
[`src/runtime/buffer.js`](src/runtime/buffer.js) emits an `ErrorCommand`:

```javascript
if (isScript) {
  array.push(new ErrorCommand(new PoisonedValue(processedErrors)));
}
```

During flatten, `processItem` detects `ErrorCommand` first:

```javascript
if (item instanceof ErrorCommand) {
  const outputCtx = getOutputCtx(outputName || 'text');
  if (outputCtx) { item.apply(outputCtx); }          // sets _target = PoisonedValue
  if (item.value && item.value.errors) {
    state.collectedErrors.push(...item.value.errors); // collects for PoisonError
  }
  return;
}
```

The `apply` call poisons the Output's `_target`. When `snapshot()` later calls
`_resolveFromOutput`, it sees the PoisonedValue and throws.

### Template mode: legacy markers

Template mode (and guard recovery scanning) uses plain marker objects:

```javascript
{ __cascadaPoisonMarker: true, errors: [...], handler: name }
```

These are detected by `item.__cascadaPoisonMarker === true` checks in both `processItem` and
`getPosonedBufferErrors`.

### `getPosonedBufferErrors`

Guard blocks scan buffers for errors before deciding whether to recover.
`getPosonedBufferErrors` must detect **both** formats:

```javascript
// ErrorCommand (script mode)
if (item instanceof ErrorCommand) {
  if (item.value && item.value.errors) allErrors.push(...item.value.errors);
  continue;
}
// Legacy marker (template mode)
if (item.__cascadaPoisonMarker === true) { ... }
```

---

## snapshot() Resolution

`snapshot()` is the user-facing method that materializes an output's current value.

### Template mode / `output` handler

Returns the flatten result directly — `buildFinalResultFromState` assembles a `{text, data, ...}`
object from `state.textOutput` and `state.handlerInstances`. No `_target`/`_base` involved.

### Script mode (named outputs)

`snapshot()` delegates entirely to `flattenOutput(this)`. The Output carries everything flatten
needs (`_buffer`, `_context`, `_outputName`), so the call is a single expression. Inside
`flattenOutput`:

1. Triggers `flattenBuffer` on the Output's buffer. The flatten populates `_target`/`_base`
   as a side effect.
2. If flatten returned a promise (async commands), waits for it.
3. Calls `output._resolveFromOutput()`:

```javascript
_resolveFromOutput() {
  if (isPoison(this._target)) {
    throw new PoisonError(this._target.errors);     // error path
  }
  if (this._outputType === 'text') {
    return Array.isArray(this._target) ? this._target.join('') : '';
  }
  // data and value — unified path
  if (this._base) {
    return typeof this._base.getReturnValue === 'function'
      ? this._base.getReturnValue()
      : this._base;
  }
  return this._target;                              // empty default ({} or undefined)
}
```

The check for `_base` is **not** gated on output type. Both `data` and `value` outputs go through
`getOrInstantiateHandler` and get a `_base`. The unified path is intentional: `ValueHandler` is a
registered handler class just like `DataHandler`, and both expose `getReturnValue()`.

### Repeated snapshots

Because flatten is cached (`buffer._flattenState`), a second `snapshot()` call on the same buffer
skips flatten entirely and reads directly from the already-populated `_target`/`_base`.

---

## Handler Classes: DataHandler and ValueHandler

Both are registered in `env.commandHandlerClasses` by [`src/environment/script.js`](src/environment/script.js):

```javascript
env.addCommandHandlerClass('data',  DataHandler);   // src/script/data-handler.js
env.addCommandHandlerClass('value', ValueHandler);  // src/script/value-handler.js
```

### DataHandler

A stateful object. Commands like `.set(path, value)`, `.push(path, value)`, `.merge(path, obj)`
mutate an internal `this.data` structure. `getReturnValue()` returns `this.data`.

### ValueHandler

A **callable constructor** — `new ValueHandler()` returns a *function*, not `this`:

```javascript
class ValueHandler {
  constructor(context) {
    this.value = undefined;
    const handler = (val) => { this.value = val; };
    handler.getReturnValue = () => { return this.value; };
    return handler;   // ← returns the function, not the ValueHandler instance
  }
}
```

The returned function is what gets stored in `state.handlerInstances` and in `Output._base`.
Calling it directly (`handler(42)`) sets the value; `handler.getReturnValue()` retrieves it.
This is why `_resolveFromOutput` does not need to distinguish data from value — both have
`getReturnValue()` on `_base`.

---

## Template vs Script Mode

| Aspect | Template mode | Script mode |
|--------|---------------|-------------|
| Buffer type | Plain arrays | `CommandBuffer` instances |
| Poison markers | `{ __cascadaPoisonMarker: true }` objects | `ErrorCommand` instances |
| `snapshot()` entry | `flattenBuffer` directly | `flattenOutput(output)` — extracts buffer/ctx/name from Output |
| `snapshot()` resolution | Returns flatten result directly | Reads from `_target`/`_base` via `_resolveFromOutput` |
| Output lookup | Not used | `buffer._outputs` references `frame._outputs`; visible to flatten |
| Flatten caching | Not cached (re-runs each call) | Cached on `buffer._flattenState` |
| `{text, data}` result objects | Valid (template composition) | Valid (user-authored macro returns) |

---

## How Output Commands Flow Through the Compiler

Even though script syntax no longer uses `@data/@text/@value`, the **compiler pipeline still
emits internal output commands**. This is why `buffer.currentBuffer` is still used in script
mode today.

### Current flow (as of the command-next refactor)

1. **Script transpiler emits `output_command` tags.**
   Script source like:
   ```
   data result
   result.set("x", 1)
   ```
   becomes template-like code with `{% output_command ... %}` tags.

2. **Parser creates `OutputCommand` AST nodes.**
   The `{% output_command ... %}` tag maps to `nodes.OutputCommand`.

3. **Compiler routes `OutputCommand` into the current buffer.**
   `compileOutputCommand` ultimately writes command objects into
   `this.buffer.currentBuffer` (a `CommandBuffer` instance in async/script mode).

4. **Flatten replays commands into Outputs.**
   The buffer is flattened on `snapshot()`, which populates `_target/_base`.

### Why this matters for `buffer.currentBuffer`

`buffer.currentBuffer` is not tied to the old `@...` syntax. It is the **transport** that
all output commands currently go through, regardless of whether those commands originate from
`@data` (legacy) or from typed output variables (current script syntax).

So long as the compiler still emits `OutputCommand` nodes and compiles them into a
`CommandBuffer`, `buffer.currentBuffer` remains required in script mode for:

- output command enqueueing
- guard/poison marker insertion
- async buffer composition

### What would make `buffer.currentBuffer` removable

To eliminate `buffer.currentBuffer` from script mode, the pipeline would need to change so that
output variable calls **enqueue directly on their own Output instances** (or another buffer owned
by the output), instead of routing through a shared `CommandBuffer` in the compiler. Concretely:

- stop emitting `{% output_command %}` in the script transpiler
- remove `nodes.OutputCommand` and its compiler path
- make output-variable calls compile as normal JS calls that enqueue on `Output._buffer`
- replace any compiler sites that write poison markers or buffer slots with output-owned logic

Until that refactor lands, `buffer.currentBuffer` is still the authoritative write target for
output operations in script mode.

---

## Buffer Allocation Checklist

This section enumerates **every compiler path that can emit output** and states whether it
**creates a new `CommandBuffer`** or **writes into the current buffer via slotting**. The goal
is to prevent subtle ordering bugs when new AST nodes are added or refactored.

### New `CommandBuffer` required (nested buffer branch)

These nodes can emit **multiple output commands** asynchronously. They **must** isolate output
to preserve source-order determinism and correct guard/poison behavior.

- **Root / render function bodies**  
  `emit.funcBegin(...)` creates the initial `CommandBuffer` for root and blocks (async mode).

- **Guard blocks**  
  `compileGuard` → `buffer.asyncBufferNodeBegin(...)` (async-only).

- **Async control-flow with bodies**  
  `compileIf`, `compileSwitch` (async path) → `buffer.asyncBufferNodeBegin(...)`.

- **Async loops and loop sub-bodies**  
  `compileFor` / `compileWhile` → `buffer.asyncBufferNodeBegin(...)`  
  `_compileLoopBody` → `buffer.asyncBufferNodeBegin(...)`  
  `_compileLoopElse` → `buffer.asyncBufferNodeBegin(...)`

- **Capture (async)**  
  `compileCapture` → `new runtime.CommandBuffer(...)`

- **Call / caller block rendering (async)**  
  `emit.asyncBlockRender(...)` → `buffer.push()` → `new CommandBuffer(...)`

- **Legacy asyncEach/asyncAll parallel path (non-async mode)**  
  `_compileAsyncLoop(..., parallel=true)` → `buffer.push()`  
  (isolates parallel body output)

### Slotting into current buffer (no new buffer)

These nodes produce **a single output value/command**, so they should reserve a slot in the
current buffer and fill it when ready.

- **Output node**  
  `compileOutput` → `asyncAddToBufferBegin/End` (slot per output)

- **OutputCommand**  
  `compileOutputCommand` → `reserveSlot` / `fillSlot` or `add` in current buffer

- **TemplateData**  
  `compileTemplateData` / `compileOutput` → `addToBuffer` (single literal)

- **Include / Block / CallExtension (async)**  
  `compileInclude`, `compileBlock`, `compileCallExtension` → `asyncAddToBuffer` (slot)

- **Sync include/block paths**  
  `compileIncludeSync`, sync `compileBlock` → direct append to current buffer

### Nodes that do not emit output

These compile to values or side effects only; they should not create buffers:

- `compileSet`, `compileReturn`, `compileDo`
- Most expression nodes in `compiler-base.js`

---

## Key Invariants and Gotchas

1. **`_outputHandlers` is sinks only. `_outputs` is non-sinks only.** Mixing them causes
   `getOrInstantiateHandler` to return the Output wrapper as if it were a handler instance.
   Data commands silently fail (enqueue onto the Proxy instead of mutating state).

2. **`_base` check must not be gated on `_outputType === 'data'`.** `ValueHandler` IS a registered
   handler class. It goes through `getOrInstantiateHandler` and ends up in `_base`. If the check
   only fires for data, value outputs fall through to `return this._target` (which is `undefined`).

3. **Live bindings are required for callable outputs.** `TextOutput` and `ValueOutput` are wrapped
   in functions by `createCallableOutput`. Plain property copies would snapshot stale state.
   `Object.defineProperty` with get/set is mandatory.

4. **`{text, data}` result objects are valid in script mode.** They originate from user-authored
   macro returns (`return {data: data.snapshot()}`). Do not add a script-mode guard that drops
   the `data` merge in `processObjectItem` — it breaks caller blocks.

5. **Flatten state propagation uses a one-time guard.** `if (!state.outputCtxs && ...)` means the
   root buffer's `_outputs` wins. Child buffers (async blocks) share the same Output instances
   via the parent chain.

6. **ErrorCommand poisons `_target`, not `_base`.** `_base` (the handler instance) is stable and
   may already have accumulated partial state. The poison goes on `_target` so that `snapshot()`
   can detect it without inspecting the handler. Subsequent commands dispatched to `_base` after
   an ErrorCommand are a no-op at the `snapshot()` level — the PoisonedValue on `_target` short-circuits.

7. **DataOutput Proxy has no `set` trap.** `_target` and `_base` assignments fall through to the
   underlying DataOutput via default Proxy behavior. Only `get` is trapped.
