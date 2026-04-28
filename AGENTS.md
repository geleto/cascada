# Cascada AI Agent Guide

This guide provides context for developing the Cascada engine. Assist in writing, refactoring, and testing code under supervision, adhering to the architecture and patterns below.

**Package**: `cascada-engine`
**Repository**: https://github.com/geleto/cascada

## Table of Contents

- [Key Files and Directories](#key-files-and-directories)
- [Primary Agent Directives & Rules](#primary-agent-directives--rules)
- [Project Overview](#project-overview)
- [Implementation Architecture](#implementation-architecture)
- [Development & Testing Guide](#development--testing-guide)


## Key Files and Directories

### Source Directories
-   `src/compiler/`: Core compiler logic including AST transformation, channel analysis, async boundaries, and code generation.
-   `src/environment/`: Public API, environment configuration, and wrapper classes (`AsyncEnvironment`, `AsyncTemplate`, `Script`).
-   `src/loader/`: Template loading mechanisms (FileSystem, Web, precompiled, string helpers).
-   `src/runtime/`: Runtime helpers, command buffers, channels, async boundaries, lookups/calls, and error handling (Poison system).
-   `src/script/`: Cascada Script specifics, default data-channel methods, channel helpers, and the script-to-template transpiler.

### Key Files

-   `src/index.js`: **Package entry point.** Exports public classes/functions from the source tree.
-   `src/environment/environment.js`: **Environment barrel.** Re-exports `Environment`, `AsyncEnvironment`, `Template`, `AsyncTemplate`, and `Script`.
-   `src/environment/async-environment.js`: **Async user-facing API.** Tests usually instantiate `AsyncEnvironment` from here or from `src/index.js`.
-   `src/environment/template.js`: **Compiled template classes.** Contains `Template` and `AsyncTemplate`.
-   `src/environment/script.js`: **Compiled script class.** Contains `Script`, which transpiles Cascada Script to template syntax before compilation.
-   `src/runtime/runtime.js`: **Runtime barrel.** Re-exports helpers and channel/command classes used by compiled code.
-   `src/runtime/errors.js`: **Poison and error helpers.** Contains `PoisonError`, `isPoison`, `isPoisonError`, `handleError`, and related utilities.
-   `src/runtime/resolve.js`: **Promise/poison resolution.** Contains `resolveAll`, `resolveSingle`, and related sync-first resolution helpers.
-   `src/runtime/command-buffer.js`: **Command buffer implementation.** Creates and links runtime buffers and routes commands to channels.
-   `src/runtime/channels/*.js`: **Channel and command implementations.** Text, data, var, observation, timing, sequence, sequential-path, and error commands live here.
-   `src/compiler/compiler.js`: **Main compiler entry.** Chooses sync/async/script compiler behavior and orchestrates code generation.
-   `src/compiler/compiler-async.js`: **Async statement compiler.** Handles async templates/scripts, statements, output commands, guards, and async boundaries.
-   `src/compiler/compiler-base-async.js`: **Async expression compiler.** Handles expression-level async behavior, lookups, function calls, and waited reads.
-   `src/compiler/analysis.js`: **Channel analysis.** Computes declarations, `usedChannels`, `mutatedChannels`, and `sequenceLocks`.
-   `src/compiler/buffer.js`: **Buffer/codegen helpers.** Emits command construction and command-buffer interactions.
-   `src/compiler/sequential.js`: **Sequential (`!`) analysis.** Identifies static sequence paths and validates `!` usage.
-   `src/script/default-data-methods.js`: **Built-in data-channel methods.** Defines default data mutations such as `push`, `merge`, and related helpers.
-   `src/runtime/channels/data.js`: **Runtime data channel.** Applies `DataCommand` instances and custom data methods registered with `AsyncEnvironment.addDataMethods`.
-   `src/script/script-transpiler.js`: **Script-to-template transpiler.**
-   `tests/`: **Test suites.**
    -   `tests/pasync/`: Tests for advanced asynchronous execution and parallelism.
    -   `tests/poison/`: Tests for the error handling (Poison) system.
    -   `tests/util.js`: Test utilities including `StringLoader` class.

### Documentation Files

#### Documentation Directories
-   **User Docs**: `docs/cascada/` (e.g., `script.md`)
-   **Implementation Guides**: `docs/code/` (current guides are split by subsystem rather than one async overview)

#### Documentation Files
-   **User Docs** (`docs/cascada/`):
    -   `script-agent.md`: Intended concise guide to Cascada Script syntax and features for AI agents. It is currently referenced by docs but may not exist in the working tree; if absent, use `script.md` as the source of truth and keep this reference for planned restoration.
    -   `script.md`: Comprehensive, human-readable guide to Cascada Script syntax and features, almost always up-to-date with the latest features even before they are developed.
    -   `template.md`: Very outdated guide to Cascada Template syntax (Nunjucks-compatible). Use your nunjucks knowledge and the scripting docs instead.

-   **Implementation Guides** (`docs/code/`), may not be up-to-date on the latest implementation details:
    -   `Tests.md`: General testing guidelines and philosophy.
    -   `Error Handling Guide.md`: Overview of the "Poison" error system.
    -   `Error Handling Patterns In Script.md`: Common patterns for handling errors in scripts.
    -   `Poisoning - Implementation Principles.md`: Detailed mechanics of error propagation.
    -   `sequence.md`: Current notes for `!` sequence behavior.
    -   `output.md` and `output-scoping.md`: Output channel and scoping notes.
    -   `channels-refactor.md`, `command-buffer-refactor.md`, `expression-channels.md`: Channel and command-buffer implementation notes.
    -   `waited-loops.md`: Loop/wait behavior notes.
    -   `return.md` and `return-transpile.md`: Return semantics and script transpilation notes.

When docs and implementation disagree, prefer current source and tests. Treat `docs/code/` as design context, not an authority over live behavior.

## Primary Agent Directives & Rules

**Most important section. Adhere to these rules in all development tasks.**

### Your Core Task

Write and modify JavaScript for `cascada-engine`: implement features, fix bugs, write tests. All work aligns with **Implicitly Parallel, Explicitly Sequential**.

Development and tests require Node `>=22`.

### Golden Rules (DOs and DON'Ts)

**Follow strictly. Designed to align with Cascada's architecture, prevent bugs, and ensure performance.**

#### **Repository Hygiene**

*   ✅ **DO:** Work with a dirty tree carefully. User changes may already be present.
*   ❌ **DON'T:** Revert unrelated changes or use destructive git commands unless explicitly asked.

#### **Language & Scripting (Writing Cascada Code)**

*   ✅ **DO:** Use `!` on **static context paths** (e.g., `db.users!.create()`) to enforce strict execution order for side effects.
*   ✅ **DO:** Use explicit returns (`return result.snapshot()`, `return body.snapshot()`, or direct values) in scripts/functions for clean, predictable return values.
*   ✅ **DO:** Use named channels (`data result`, `text body`, etc.) with explicit `return result.snapshot()` / `return body.snapshot()` to build complex intermediate outputs with guaranteed source-order assembly.

*   ❌ **DON'T:** Use `!` on template variables (`{% set x = ... %}{{ x!.method() }}`) or dynamic lookups (`items[i]!.method()`). Compiler only supports static paths from initial context.
*   ❌ **DON'T:** Manually collect results from parallel loops into temporary arrays if final order matters. Data/text channels handle this, guaranteeing ordered assembly despite concurrent execution.

#### **Testing**

*   ✅ **DO:** Use `it.only()` or `describe.only()` to isolate tests during development. Critical for speed.
*   ✅ **DO:** Write tests for both success path and `PoisonError` failure path for every new async feature.

*   ❌ **DON'T:** Write tests depending on completion order of concurrent operations when verifying correctness. **Test the final, deterministic output, not the intermediate race.**
    *   **Exception:** When specifically testing concurrency mechanism itself (e.g., using mocks with delays to prove `for` runs parallel while `each` runs sequential).

#### **Compiler Implementation (Modifying `src/compiler/*.js`)**

*   ✅ **DO:** Trust the runtime to handle synchronization. Provide correct channel analysis metadata (`declaredChannels`, `usedChannels`, `mutatedChannels`, `sequenceLocks`) and linked-channel information so buffers can observe the right values in source order.
*   ❌ **DON'T:** Write raw `(async () => { ... })()` blocks. Use the established compiler boundary/buffer helpers in `emit.js`, `boundaries.js`, `buffer.js`, and related compiler modules so channel linking, current-buffer state, and error context stay consistent.
*   ❌ **DON'T:** Modify legacy synchronous error handling (top-level `lineno`/`colno` variables). All new error handling targets async model (`errorContext` objects and per-block `try/catch`).

#### **Runtime & Performance**

*   ✅ **DO:** Prioritize **"Sync-First Hybrid" pattern** to maximize performance:
    1.  Create main **non-`async`** function (e.g., `memberLookupAsync`).
    2.  Handle fast paths synchronously: check poison (`if (isPoison(value)) return value;`), check simple literals (`if (!val || typeof val.then !== 'function') return processSync(val);`).
    3.  Delegate complex cases (actual promises, arrays of promises) to separate **`async`** helper (e.g., `_memberLookupAsyncComplex`).
    *   **Why:** Avoids Promise overhead for 30-40% of synchronous cases—major performance win.

*   ✅ **DO:** Check if value is promise (`if (val && typeof val.then === 'function')`) before `await`. Cheaper than blind `await` on literals.
*   ✅ **DO:** Distinguish **value consumption** from **normal control-flow/runtime throws**:
    *   If a loop/conditional/include path is **consuming a value** (awaiting a promise, reading a thenable, iterating an async iterator, evaluating an async condition, etc.), failures belong to normal Cascada error flow. Poison the affected writes/effects and do **not** rethrow from that path.
    *   If the **normal flow itself** throws (invariant violation, bad control-flow contract, unexpected runtime bug, invalid hard precondition), let that error propagate as a real error. Do **not** silently convert it into poison.
    *   Callback-based fire-and-forget runtime boundaries (for example helpers that own async child-buffer cleanup) should still report real errors via `cb(...)` with context, because there may be no awaiting caller on that path.
*   ✅ **DO:** Treat the current command buffer as the only place where runtime commands are enqueued for an execution point.
    *   Observable commands (`addSnapshot`, waits, error reads, etc.) and mutating commands must both be added to the current buffer.
    *   If a value/scope is visible, the current buffer must already have the needed linked channel path. Fix the linking or payload transport; do not jump to a parent/root producer buffer.
*   ✅ **DO:** Keep ordinary lookup, explicit shared observation, and explicit composition payload capture as separate mechanisms.
    *   Ordinary bare-name lookup must use the current buffer hierarchy.
    *   Explicit inheritance/shared observation may use inheritance metadata, but should still enqueue on the current buffer.
    *   Immediate composition capture (`extends ... with ...`) is not an ordered snapshot read and must stay a narrow dedicated primitive.

*   ❌ **DON'T:** Reflexively make runtime functions `async`. An `async` function always returns Promise, adding overhead. Only use `async` on helper functions needing `await`.
*   ❌ **DON'T:** Check `isPoison()` **AFTER** `await`. Architecturally impossible for `await somePromise` to return `PoisonedValue`. Check before awaiting; catch `PoisonError` after awaiting.
*   ❌ **DON'T:** Treat `isPoison()` as definitive test for all errors. It's synchronous check for existing `PoisonedValue`, not for whether Promise will reject. For promises, use `try/catch`.
*   ❌ **DON'T:** `return` `PoisonedValue` from `async` function. **MUST** `throw new PoisonError(...)`. Only non-`async` (or sync-first hybrid) functions can return `PoisonedValue` directly.
*   ❌ **DON'T:** Catch broad runtime errors and turn them into poison "just to keep going". Only value-consumption failures should be normalized into poison/effect poisoning.
*   ❌ **DON'T:** Short-circuit error collection. Always await ALL promises and collect ALL errors before returning/throwing (**"Never Miss Any Error"** principle).
*   ❌ **DON'T:** Use `instanceof` for poison detection. Always use `isPoison()` and `isPoisonError()` helpers.
*   ❌ **DON'T:** Construct `TemplateError` directly in `catch` blocks. Always use idempotent `runtime.handleError(e, ...)`.
*   ❌ **DON'T:** “Fix” missing visibility by reading or waiting on the owner/producer buffer directly.
    *   No ordinary lookup fallback to parent/root buffers.
    *   No “current position” wait on parent/root buffers.
    *   If the current buffer cannot observe a value in source order, the real bug is missing linked channels, wrong `currentBuffer`, or missing explicit payload wiring.

---

## Project Overview

Cascada is a parallel-first scripting and templating engine. The core model is **Implicitly Parallel, Explicitly Sequential**: code reads like ordinary synchronous logic, independent operations run concurrently, and explicit `!` markers or channels provide ordering where side effects or assembled output require it.

Scripts are data-orchestration code with named channels (`data result`, `text body`, etc.). Templates are Nunjucks-compatible text generation. For language details, prefer `docs/cascada/script.md`; `docs/cascada/script-agent.md` is intentionally still referenced but may be absent in the working tree.

```javascript
data result
var user = fetchUser(userId)
var posts = fetchPosts(userId)
for post in posts
  var enriched = enrichPost(post)
  result.posts.push({ title: enriched.title, status: enriched.status })
endfor
db!.log("report", userId)
return result.snapshot()
```

---

## Implementation Architecture

### Async Execution Model

-   **Core Principle**: Transparently handle promises as first-class values, awaiting only when needed.
-   **Mechanism**: Async-mode compilation emits scheduled boundaries through `src/compiler/emit.js`, `src/compiler/boundaries.js`, and statement/expression compilers. Boundaries use `runtime.createCommandBuffer`, linked channels, and runtime async-boundary helpers rather than ad hoc async IIFEs.
-   **Key Components**: `runtime.resolveAll`, `runtime.resolveSingle`, `CommandBuffer`, channel classes under `src/runtime/channels/`, and compiler analysis metadata from `src/compiler/analysis.js`.
-   **Reference**: See `docs/code/channels-refactor.md`, `docs/code/command-buffer-refactor.md`, `docs/code/expression-channels.md`, and focused subsystem notes in `docs/code/`.

### Variable Synchronization

**Goal:** Prevent race conditions; ensure sequential equivalence when concurrent blocks read/write same outer-scope variables.

**Mechanism:** Compile-time channel analysis + command buffer tree system.

-   **Compile-time analysis** (`src/compiler/analysis.js`): Annotates AST nodes with declaration/use/mutation metadata. Important fields include `declaredChannels`, `usedChannels`, `mutatedChannels`, and `sequenceLocks`.
-   **Buffer code generation** (`src/compiler/buffer.js`, `src/compiler/emit.js`): Emits command creation, linked-channel metadata, child buffer creation, and async boundary wiring.
-   **Command Buffer Tree** (`src/runtime/command-buffer.js`): Runtime command buffers hold source-ordered commands and child buffers. Linked channels make values visible where the compiler determined they are used.
-   **Ordered Application via Buffer Iterator** (`src/runtime/buffer-iterator.js`): A depth-first iterator walks the buffer tree and applies commands in source-code order. It waits on unfilled slots (child buffers not yet finished) before advancing.
-   **Implicit Variable Synchronization**: Channel observations and `resolveAll`/`resolveSingle` await pending values only when consumed. Data dependencies serialize naturally without explicit locks.

### Commands And Channels

Commands are split by channel under `src/runtime/channels/`. A command is enqueued in the current `CommandBuffer` and applied in source order. Observation commands return promises; mutating commands change channel state. Look up the relevant channel file instead of adding cross-channel special cases.

Use the right observation primitive. `SnapshotCommand` inspects the channel and turns poison into a rejected observation; `RawSnapshotCommand` returns the raw target for narrow overwrite/repair-style paths. To wait for a whole channel result, prefer `channel.finalSnapshot()` over enqueueing a snapshot command unless source-position observation is specifically required.

Always add commands through the compiler's active buffer expression: `compiler.buffer.currentBuffer` (often emitted as the runtime variable `currentBuffer` inside boundary callbacks, or `output` at the root). Never skip to a parent/root/producer buffer, and never call a channel directly to "just apply" a command. If the current buffer cannot see the needed channel, fix analysis/linking/current-buffer selection rather than bypassing the buffer tree.

### Command Buffer Mental Model

Compiled async work does not mutate outputs directly. It enqueues commands into the current `CommandBuffer`. When async control flow can produce nested output, the compiler creates a child buffer in the parent buffer's source-order slot. The buffer iterator walks parent and child buffers in source order, waiting for unfilled child slots when needed.

Channels are named state lanes inside buffers. `analysis.js` determines which channels a block declares, reads, or mutates; `emit.js` uses that to link parent channels into child buffers. If a value is visible, the current buffer must already have a linked path to observe it. Do not read from producer/root buffers to "fix" visibility.

Mutating commands change channel state. Observation commands, such as snapshots and error reads, are also enqueued in the current buffer. Command-buffer add helpers return the command's result promise immediately; that promise resolves or rejects later when the buffer iterator reaches and applies the command.

"Finished" has three separate meanings. A buffer may stop accepting more commands for one or all channel lanes; the iterator may later exit that buffer after all commands in the relevant lane have been applied; and a channel may be fully consumable when `finalSnapshot()` waits for iterator completion and materializes the result. Be explicit about which lifecycle you are touching.

Observable commands are source-ordered reads, not free side channels. The buffer iterator tracks pending observable command promises and waits for them before applying later mutating commands on the same lane. This preserves ordered reads such as snapshots, `is error`, `getError`, and guard-state capture.

### Async Boundary Mental Model

Prefer creating the command-buffer shape synchronously. Plain async values usually do not need a child buffer: enqueue the command immediately with promise arguments, and let the target channel resolve those arguments when source order reaches the command.

Child buffers usually represent an async boundary where the future command shape is unknown until a value resolves. Common cases are async conditions (`if`/`switch`), loops whose iterable or continuation is async (`for`/`each`/`while`), includes/imports/extends or composition loading, caller/macro scheduling, and other constructs where resolving a value decides which commands exist or how many commands are produced.

Once a child buffer is inserted into the parent buffer, its contents may arrive later. That is expected: the parent preserves the source-order slot, and the iterator waits only when it reaches that slot. Do not delay adding an ordinary command merely because one of its arguments is a promise.

### Value Resolution Rules

Everything inside Cascada can be either a plain value or a promise for that value. Runtime code should preserve that shape unless it is at a real consumption boundary.

Common runtime value shapes:
-   **Plain JS values**: strings, numbers, objects, arrays, functions, channel facades, etc.
-   **Promises / `RuntimePromise`**: deferred values that should flow through expressions, command arguments, channels, and variables until consumed. `RuntimePromise` preserves error context for delayed consumption while remaining promise-like.
-   **Lazy objects/arrays with `RESOLVE_MARKER`**: `createObject()` / `createArray()` mark containers whose properties/elements may be async. The object remains usable synchronously; when consumed, its marker promise resolves children, mutates the container in place, and then removes the marker.
-   **PoisonedValue**: a thenable error container. It is cheap to detect synchronously with `isPoison(value)` and rejects as `PoisonError` if awaited.
-   **Resolved-value wrappers**: internal thenable fast-path wrappers from `makeResolvedValue()`. They are cheap to detect synchronously with `isResolvedValue(value)` and signal "already resolved" without forcing a real Promise.

Use the runtime `resolve*` helpers (`resolveAll`, `resolveSingle`, `resolveDuo`, `resolveObjectProperties`, etc.) at consumption boundaries instead of direct `await`. They know all Cascada value shapes and preserve fast paths. This is especially important for `RESOLVE_MARKER` objects/arrays: unlike thenable fast paths such as resolved-value wrappers and `PoisonedValue`, a plain `await value` will not finalize their async properties.

Avoid normalizing Cascada values with `Promise.resolve(value)` as a reflex. Cascada code is designed to carry direct values, native promises, and custom thenables without collapsing them. Use `Promise.resolve` only when you deliberately need native Promise semantics; otherwise preserve the value shape or use the runtime `resolve*` helpers at the proper consumption boundary.

Avoid resolving or awaiting values early. Resolution is allowed at true async boundaries, and when preparing values for final consumption such as function calls, expression evaluation, condition checks, iteration, or final output materialization.

Command arguments must be resolved only by the command/channel apply path. If a command argument is a promise, enqueue it as-is; the channel applies source-order semantics and resolves arguments when the command is actually applied.

Marking a deferred promise as handled is not resolution. Runtime helpers such as `markPromiseHandled()` and command argument staging attach rejection handlers so delayed Cascada-owned consumption does not produce unhandled-rejection warnings; they must not be replaced with eager `await`/resolution.

When a value depends on prerequisite async work before it can be read, do not `await` that prerequisite in the main execution flow unless you are at a real async boundary. For example, do not write `await compositionReady; return readSharedValue();`. Instead, return a single promise that represents the whole operation, either with `.then(...)` chaining or by wrapping the wait/read sequence in a small async function.

### Error Handling (Poison System)

-   **Core Principle**: "Never Miss Any Error." Await all promises and collect all errors before throwing.
-   **`PoisonedValue`**: *Thenable* object carrying `.errors[]` array. Can be passed synchronously.
-   **`PoisonError`**: `Error` thrown when `PoisonedValue` is awaited.
-   **Detection**:
    -   `isPoison(value)` -> Use **before** `await`. Fast, synchronous check. It identifies existing `PoisonedValue` objects, but it will not `await` a promise to see if it will reject with a `PoisonError`. Ideal for fast-path in Sync-First Hybrid pattern.
    -   `isPoisonError(err)` -> Use **in `catch` block**.
-   **Reference**: `docs/code/Error Handling Guide.md`, `docs/code/Poisoning - Implementation Principles.md`

#### Error Propagation (Dataflow Poisoning)

Cascada treats errors as data ("Poison") flowing through system.

*   **Native JS Call Suppression:** Native JS/context calls that receive Poison input do not execute because they cannot handle Cascada error values safely; they immediately return new Poison combining input errors. Cascada-level functions, macros, methods, and explicit call constructs may receive poison/error values so they can inspect or repair them.
*   **Contamination:** Any variable/output that would've been modified by skipped operation/block automatically Poisoned.
*   **Value Consumption Errors Become Poison:** When Cascada consumes a value (for example via `resolve*`, command apply, function-call argument preparation, expression evaluation, condition checks, iteration, or final materialization), rejections/poison are handled as Cascada poison. If ordinary Cascada control flow throws during normal execution, treat it as a real bug; do not normalize it into poison just to continue.
*   **Returned Channel Poison:** If a channel returned by a script, function, macro, call, method, or similar Cascada construct contains poison, return that poison through Cascada value flow. Public render APIs such as `renderScriptString` materialize that as a rejected promise.
*   **Fatal Runtime Errors:** `RuntimeFatalError` and broken runtime contracts are real failures, not poison data. Async callback-style boundaries that have no awaiting caller should report such failures through `cb(err)` with context.
*   **Context Function Warning:** **DO NOT** pass Poison to context functions (e.g., logging). Function never executes. Use `is error` to check first.

**Propagation Logic by Type:**
*   **Expressions:** `1 + error` → `error`.
*   **Function Calls:** `myFunc(error)` → Function body skipped; returns `error`.
*   **Loops:** `for x in error` → Loop body skipped; all variables modified within poisoned.
*   **Conditionals:** `if error` → Both branches skipped; all variables modified within poisoned.
*   **Sequential (`!`):** `db!.fail()` → Subsequent `db!.op()` calls skipped, return error.

### Sequential Operations (`!`)

-   **Sequence Keys**: Each static `!` path (e.g., `account!.deposit`) maps to a named sequence channel key.
-   **Compiler Pass** (`src/compiler/sequential.js` + `src/compiler/analysis.js`): `collectSequenceLocks()` identifies `!` markers, validates static paths, and records `sequenceLocks` on analysis metadata.
-   **Runtime Commands**: `SequenceCallCommand` and `SequenceGetCommand` carry a deferred-result promise. The buffer iterator applies them in source order; each call awaits the prior result for that sequence channel before executing.
-   **Poison propagation**: If a `!`-call fails, `SequentialPathWriteCommand` marks the path poisoned. All subsequent commands on that path see the poison via `_getSequentialPathPoisonErrors()` and skip execution, rejecting their deferred promises.

---

## Development & Testing Guide

Practical instructions for writing and testing code.

### Common Development Scenarios

#### Add New Data-Channel Method (e.g., `incrementBy`)

1.  **Locate defaults or custom API**: Built-in methods live in `src/script/default-data-methods.js`; user/custom methods are registered through `AsyncEnvironment.addDataMethods` in `src/environment/async-environment.js`.
2.  **Understand runtime application**: `src/runtime/channels/data.js` applies `DataCommand` instances and resolves custom methods.
3.  **Implement Logic**: Method receives `(target, ...args)`, returns new value. `target` is current value at path (could be `undefined`). `...args` are script arguments.
4.  **Add Method**: Add built-ins to `default-data-methods.js`, or add custom methods in test setup with `env.addDataMethods`.
    ```javascript
    env.addDataMethods({
      incrementBy: (target, amount) => (target || 0) + amount
    });
    ```
5.  **Write Test**: Add an isolated test in a relevant file such as `tests/pasync/output-data-methods.js`, including edge cases like `undefined` targets.

#### Fix Bug in Compiler Pass

1.  **Isolate Bug**: Write small, failing test using `it.only()`. Use simplest script demonstrating bug via `env.renderScriptString`.
2.  **Identify Compiler Pass**: Check `Key Files` reference. Bug likely lives in `src/compiler/compiler-async.js` or `compiler-sync.js` for statements, `compiler-base-async.js` or `compiler-base-sync.js` for expressions, `analysis.js` for channel metadata, `buffer.js`/`emit.js` for command-buffer wiring, or `sequential.js` for `!` logic.
3.  **Trace Compilation**: Entry point is `Compiler.compile()`. Follow `compileNodeType` methods (e.g., `compileIf`, `compileFunCall`) to trace AST→JavaScript conversion.
4.  **Inspect Generated Code**: `compile` function returns generated JS string. Log this in test to see incorrect compiler output.
5.  **Modify & Re-run**: Modify compiler logic, re-run the focused test with `npm run mocha -- tests/path/to/file.js`. Repeat until isolated test passes.
6.  **Remove `.only()`**: Run full test suite (`npm test`) to check regressions.

### Running Tests

-   **Quick Test (No Build)**: `npm run test:quick`
-   **Single File (Recommended)**: `npm run mocha -- tests/pasync/loop-phase1-two-pass.js`
-   **Node Only (from source, with coverage)**: `npm run test:node`
-   **Browser Only (bundled from source)**: `npm run test:browser`
-   **Full Suite (build + precompile + Node + Browser)**: `npm test`
-   **Lint**: `npm run lint`
-   **Build**: `npm run build`
-   **Cycle Check**: `npm run check:cycles`
-   **Isolate Tests**: Use `.only()` on `it()` or `describe()` blocks. Standard workflow for focused development.

Test location guide:
-   Compiler/runtime async behavior: `tests/pasync/`
-   Poison/error behavior: `tests/poison/`
-   Script transpiler: `tests/script-transpiler.js`
-   Public API: `tests/api.js`
-   Classic Nunjucks compatibility: `tests/core.js`, `tests/compiler.js`

```javascript
describe.only('My New Feature', () => {
  it.only('should handle primary use case', async () => {
    // Your test. Only this runs.
  });
});
```

### Test Assertions (`expect.js`)

<details>
<summary><strong>Click to expand common assertions...</strong></summary>

Uses **expect.js**.

```javascript
// Equality
expect(value).to.be(expected);           // Strict equality (===)
expect(value).to.eql(expected);          // Deep equality (objects/arrays)

// Truthiness & Type
expect(value).to.be.ok();                // Truthy
expect(value).to.be.a('string');         // Type check
expect(value).to.be.an(Array);           // instanceof

// Collections
expect(arr).to.have.length(3);
expect(arr).to.contain(item);
expect(obj).to.have.property('key');

// Errors
expect(fn).to.throwException(/message/);

// Async Error Testing
it('should throw error', async () => {
  try {
    await env.renderScriptString(badScript);
    expect().fail('Should have thrown');
  } catch (err) {
    expect(isPoisonError(err)).to.be(true);
    expect(err.errors[0].message).to.contain('expected error');
  }
});
```

</details>

### Advanced Testing Techniques

<details>
<summary><strong>Click to expand advanced testing examples...</strong></summary>

#### Using `StringLoader` for In-Memory Templates

Use `StringLoader` from `tests/util.js` for in-memory template tests:

```javascript
import {StringLoader} from './util.js';
import {AsyncEnvironment} from '../src/environment/environment.js';

const loader = new StringLoader();
const env = new AsyncEnvironment(loader);

loader.addTemplate('header.njk', '<h1>{{ title }}</h1>');
loader.addTemplate('main.njk', '{% include "header.njk" %}');

const result = await env.renderTemplate('main.njk', { title: 'Hello' });
```

#### Inspecting Compiled Code with `_compileSource()`

For debugging compiler issues, examine generated JavaScript:

For script syntax/transpiler bugs, inspect both `scriptTranspiler.scriptToTemplate(source)` and `new Script(source, env)._compileSource()`. For ordinary execution tests, prefer `env.renderScriptString(...)` over direct `script.render(...)`.

```javascript
import {AsyncEnvironment, AsyncTemplate, Script} from '../src/environment/environment.js';

const env = new AsyncEnvironment();

const template = new AsyncTemplate('{% set x = asyncFunc() %}{{ x }}', env);
const source = template._compileSource();
expect(source).to.contain('await');

const script = new Script('data result\nresult.count = 5\nreturn result.snapshot()', env);
const compiledCode = script._compileSource();
expect(compiledCode).to.contain('DataCommand');
```

#### Transpiling Script to Template with `scriptTranspiler.scriptToTemplate()`

Verify script-to-template conversion:

```javascript
import {transpiler as scriptTranspiler} from '../src/script/script-transpiler.js';

const script = 'data result\nvar user = getUser()\nresult.userName = user.name\nreturn result.snapshot()';
const template = scriptTranspiler.scriptToTemplate(script);

// Focus directives removed: use explicit returns instead.
expect(template).to.contain('{%- var user = getUser() -%}');
expect(template).to.contain('command result.set(["userName"], user.name)');
```

</details>

---

## API & File Reference

### Main API (`AsyncEnvironment`)

```javascript
import { AsyncEnvironment } from 'cascada-engine';
const env = new AsyncEnvironment();

// Execute script and get data output via explicit return
const result = await env.renderScriptString(script, context, {output: 'data'});

// Render template to text
const html = await env.renderTemplateString(template, context);

// Add custom logic
env.addGlobal('utils', myUtils);
env.addFilter('myFilter', myFilterFunc);
env.addDataMethods({ myMethod: myDataMethodFunc });
```

### Compiled Template/Script Classes

#### `AsyncTemplate`

Represents compiled async Nunjucks template. Created internally by `AsyncEnvironment` or instantiated directly.

```javascript
import { AsyncTemplate, AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();
const tmpl = new AsyncTemplate(templateSource, env, 'path/to/template.njk');

// Render returns Promise
const html = await tmpl.render(context);
```

**Key Methods:**
- `render(context)` - Returns `Promise<string>` with rendered output
- `compile()` - Compiles template (called automatically on first render)
- `_compileSource()` - Returns generated JavaScript source code (debugging)

#### `Script`

Represents compiled async Cascada script. It automatically transpiles script syntax to template syntax. Most tests should use `env.renderScriptString(...)`; instantiate `Script` directly mainly when inspecting `_compileSource()` or testing compiled-class behavior.

```javascript
import { Script, AsyncEnvironment } from 'cascada-engine';

const env = new AsyncEnvironment();
const script = new Script(scriptSource, env, 'path/to/script.casc');

const source = script._compileSource();
```

**Key Methods:**
- `render(context)` - Lower-level render path; prefer `env.renderScriptString(...)` in normal tests
- `compile()` - Compiles script (called automatically on first render)
- `_compileSource()` - Returns generated JavaScript source code (debugging)

