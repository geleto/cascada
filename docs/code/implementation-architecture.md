# Cascada Implementation Architecture

Reference guide for compiler internals, runtime mechanics, and channel architecture. Read this when modifying `src/compiler/`, adding channel types, changing async boundary mechanics, or debugging unexpected runtime behavior. For most tasks — adding data methods, writing tests, fixing script-level bugs — the Overview, Glossary, and Golden Rules in `AGENTS.md` are sufficient.

---

## Async Execution Model

Cascada's async execution has two phases:

1. **Enqueue phase** — Compiled code runs synchronously. Instead of mutating outputs directly, it creates `CommandBuffer` objects and enqueues command objects in source order. Async boundaries insert reserved child-buffer slots into the parent's command stream before any async work begins.

2. **Apply phase** — The buffer iterator (`buffer-iterator.js`) walks the command-buffer tree depth-first in source order. When it reaches an unfilled child-buffer slot, it waits. When the async work completes and fills the slot, the iterator resumes and applies those commands next.

The two phases interleave: enqueue work for one boundary may still be running while the iterator is already applying earlier commands. This is safe because each child buffer reserves its slot synchronously before any async work starts.

---

## Compile-to-Runtime Pipeline

**Goal:** Prevent race conditions; ensure sequential equivalence when concurrent blocks read/write same outer-scope variables.

**Mechanism:** Compile-time channel analysis + command buffer tree system.

-   **Compile-time analysis** (`src/compiler/analysis.js`): Annotates AST nodes with declaration/use/mutation metadata. Important fields include `declaredChannels`, `usedChannels`, `mutatedChannels`, and `sequenceLocks`.
-   **Buffer code generation** (`src/compiler/buffer.js`, `src/compiler/emit.js`): Emits command creation, linked-channel metadata, child buffer creation, and async boundary wiring.
-   **Command Buffer Tree** (`src/runtime/command-buffer.js`): Runtime command buffers hold source-ordered commands and child buffers. Linked channels make values visible where the compiler determined they are used.
-   **Ordered Application via Buffer Iterator** (`src/runtime/buffer-iterator.js`): A depth-first iterator walks the buffer tree and applies commands in source-code order. It waits on unfilled slots (child buffers not yet finished) before advancing.
-   **Implicit Variable Synchronization**: Channel observations and `resolveAll`/`resolveSingle` await pending values only when consumed. Data dependencies serialize naturally without explicit locks.
-   **Linked channels**: When the compiler creates a child buffer, `analysis.js` computes which parent channels the child body reads or mutates (`usedChannels`, `mutatedChannels`). `emit.js`/`buffer.js` pass these as a `linkedChannels` argument to `createCommandBuffer`. At runtime, `CommandBuffer._linkedChannels` registers the links so the child buffer routes commands back to the correct parent channel lanes. If a channel is not linked, commands in the child buffer silently miss their target — the fix is always in analysis/emit, never in the runtime.

---

## Commands And Channels

Commands are split by channel under `src/runtime/channels/`. A command is enqueued in the current `CommandBuffer` and applied in source order. Observation commands return promises; mutating commands change channel state. Look up the relevant channel file instead of adding cross-channel special cases.

Use the right observation primitive. `SnapshotCommand` inspects the channel and turns poison into a rejected observation. `RawSnapshotCommand` captures the raw channel target without poison inspection — used where poisoned leaves may be replaced by an incoming write (e.g., `var`-channel `set_path` overwrites). To wait for a whole channel result, prefer `channel.finalSnapshot()` over enqueueing a snapshot command unless source-position observation is specifically required.

Always add commands through the compiler's active buffer expression: `compiler.buffer.currentBuffer` (often emitted as the runtime variable `currentBuffer` inside boundary callbacks, or `output` at the root). Never skip to a parent/root/producer buffer, and never call a channel directly to "just apply" a command. If the current buffer cannot see the needed channel, fix analysis/linking/current-buffer selection rather than bypassing the buffer tree.

Channels come into existence via `runtime.declareBufferChannel(buffer, name, type, context, null)`, emitted at codegen time. This call creates the `Channel` object, registers it in `_channels`, and binds its iterator. Any new channel type or new declaration form must go through this call.

`WaitCurrentCommand` (`src/runtime/channels/timing.js`) is a timing-only sync point: it resolves when the iterator reaches this source-position slot on a specific channel lane, carrying no snapshot or error semantics. Used by concurrency-limited loops to enforce "slot N must finish before N+1 begins" across async iterations.

Two distinct error-injection commands exist in `src/runtime/channels/error.js`:
-   **`ErrorCommand`** — placed in the buffer command stream; the iterator throws immediately when it reaches this entry. Used when an entire async boundary has failed and no channel mutation will occur.
-   **`TargetPoisonCommand`** — writes `PoisonedValue` directly into a specific channel's target. Used to contaminate a channel's output mid-stream when a value-consumption failure occurs without aborting the whole boundary.

---

## Command Buffer Mental Model

Command-buffer add helpers return the command's result promise immediately; that promise resolves or rejects only when the buffer iterator reaches and applies the command. This means observation commands (snapshots, error reads) return a pending promise that downstream code can `await` — the actual channel state is read only when the iterator reaches that source position.

"Finished" has three distinct lifecycle stages — be explicit about which you are touching:
-   **Accept-closed** (`markChannelFinished()` / `markFinished()`): the buffer stops accepting new commands on a lane or all lanes.
-   **Iterator-exited**: the iterator has applied all commands in the relevant lane and moved on.
-   **Materialized** (`channel.finalSnapshot()`): waits for iterator completion then returns the fully assembled value.

Observable commands are source-ordered reads, not free side channels. The buffer iterator waits for all pending observable command promises before applying later mutating commands on the same lane. `SnapshotCommand` sets `isUniversalObservationCommand = true`, which blocks mutating commands on *any* lane until it resolves; `RawSnapshotCommand` only blocks its own lane.

---

## Async Boundary Mental Model

Prefer creating the command-buffer shape synchronously. Plain async values usually do not need a child buffer: enqueue the command immediately with promise arguments, and let the target channel resolve those arguments when source order reaches the command.

Child buffers usually represent an async boundary where the future command shape is unknown until a value resolves. Common cases are async conditions (`if`/`switch`), loops whose iterable or continuation is async (`for`/`each`/`while`), includes/imports/extends or composition loading, caller/macro scheduling, and other constructs where resolving a value decides which commands exist or how many commands are produced.

Once a child buffer is inserted into the parent buffer, its contents may arrive later. That is expected: the parent preserves the source-order slot, and the iterator waits only when it reaches that slot. Do not delay adding an ordinary command merely because one of its arguments is a promise.

Two distinct boundary primitives exist in `src/compiler/boundaries.js`:
-   **`runControlFlowBoundary`** — statement-level. Errors report via `cb`; no return value into expression context. Used for `if`, `for`, `each`, includes, macros, and similar statements.
-   **`runValueBoundary`** — expression-level. Returns a value or rejects with `PoisonError` into the expression consumer. Used when an async value must resolve before an expression can proceed.

Using the wrong type causes either silently swallowed errors or broken expression evaluation.

---

## Loop Parallelism: `for` vs `each`

`for item in list` launches all loop-body iterations concurrently — each gets its own child buffer; `data` and `text` channels guarantee source-order assembly despite out-of-order completion. `each item in list` executes iterations strictly one at a time (each completes before the next begins). Internally these map to `asyncAll` (parallel) and `asyncEach` (sequential) in `src/runtime/loop.js`. Use `each` when the loop body has ordered side effects that don't use a `!` path.

---

## Value Resolution Rules

Everything inside Cascada can be either a plain value or a promise for that value. Runtime code should preserve that shape unless it is at a real consumption boundary.

Common runtime value shapes:
-   **Plain JS values**: strings, numbers, objects, arrays, functions, channel facades, etc.
-   **Promises / `RuntimePromise`**: deferred values that flow through expressions, command arguments, channels, and variables until consumed. `RuntimePromise` wraps a native Promise with source-location context (lineno/colno) so that if the promise rejects after flowing far from its creation site, the error still carries the original source location. It remains promise-like so Cascada's value-shape checks continue to work.
-   **Lazy objects/arrays with `RESOLVE_MARKER`**: `createObject()` / `createArray()` mark containers whose properties/elements may be async — emitted when an object/array literal expression contains async values (e.g., `{ a: asyncFn(), b: other() }`). The object remains usable synchronously; when consumed, its marker promise resolves children, mutates the container in place, and then removes the marker.
-   **PoisonedValue**: a thenable error container. It is cheap to detect synchronously with `isPoison(value)` and rejects as `PoisonError` if awaited.
-   **Resolved-value wrappers**: internal thenable fast-path wrappers from `makeResolvedValue()`. They are cheap to detect synchronously with `isResolvedValue(value)` and signal "already resolved" without forcing a real Promise.

Use the runtime `resolve*` helpers (`resolveAll`, `resolveSingle`, `resolveDuo`, `resolveObjectProperties`, etc.) at consumption boundaries instead of direct `await`. They know all Cascada value shapes and preserve fast paths. This is especially important for `RESOLVE_MARKER` objects/arrays: unlike thenable fast paths such as resolved-value wrappers and `PoisonedValue`, a plain `await value` will not finalize their async properties.

Avoid normalizing Cascada values with `Promise.resolve(value)` as a reflex. Cascada code is designed to carry direct values, native promises, and custom thenables without collapsing them. Use `Promise.resolve` only when you deliberately need native Promise semantics; otherwise preserve the value shape or use the runtime `resolve*` helpers at the proper consumption boundary.

Avoid resolving or awaiting values early. Resolution is allowed at true async boundaries, and when preparing values for final consumption such as function calls, expression evaluation, condition checks, iteration, or final output materialization.

Command arguments must be resolved only by the command/channel apply path. If a command argument is a promise, enqueue it as-is; the channel applies source-order semantics and resolves arguments when the command is actually applied.

When a value depends on prerequisite async work before it can be read, do not `await` that prerequisite in the main execution flow unless you are at a real async boundary. For example, do not write `await compositionReady; return readSharedValue();`. Instead, return a single promise that represents the whole operation, either with `.then(...)` chaining or by wrapping the wait/read sequence in a small async function.

---

## Error Handling (Poison System)

-   **Core Principle**: "Never Miss Any Error." Await all promises and collect all errors before throwing.
-   **`PoisonedValue`**: *Thenable* object carrying `.errors[]` array. Can be passed synchronously.
-   **`PoisonError`**: `Error` thrown when `PoisonedValue` is awaited.
-   **Detection**:
    -   `isPoison(value)` — Use **before** `await`. Fast, synchronous check. Identifies existing `PoisonedValue` objects; will not `await` a promise to see if it rejects. Ideal for fast-path in Sync-First Hybrid pattern.
    -   `isPoisonError(err)` — Use **in `catch` block**.
-   **Suppressing unhandled-rejection warnings**: `markPromiseHandled()` and command argument staging attach rejection handlers to Cascada-owned promises that will be consumed later. This prevents Node's unhandled-rejection warning on promises Cascada deliberately defers. Do not replace with eager `await`/resolution — that would change semantics.
-   **Reference**: `docs/code/Error Handling Guide.md`, `docs/code/Poisoning - Implementation Principles.md`

### Error Propagation (Dataflow Poisoning)

Cascada treats errors as data ("Poison") flowing through the system.

*   **Native JS Call Suppression:** Native JS/context calls that receive Poison input do not execute; they immediately return new Poison combining input errors. Cascada-level functions, macros, methods, and explicit call constructs may receive poison/error values so they can inspect or repair them.
*   **Contamination:** Any variable/output that would've been modified by a skipped operation/block is automatically Poisoned.
*   **Value Consumption Errors Become Poison:** When Cascada consumes a value (via `resolve*`, command apply, function-call argument preparation, expression evaluation, condition checks, iteration, or final materialization), rejections/poison are handled as Cascada poison. If ordinary Cascada control flow throws during normal execution, treat it as a real bug; do not normalize it into poison just to continue.
*   **Returned Channel Poison:** If a channel returned by a script, function, macro, call, method, or similar Cascada construct contains poison, return that poison through Cascada value flow. Public render APIs such as `renderScriptString` materialize that as a rejected promise.
*   **Fatal Runtime Errors:** `RuntimeFatalError` and broken runtime contracts are real failures, not poison data. Async callback-style boundaries that have no awaiting caller should report such failures through `cb(err)` with context.
*   **Context Function Warning:** **DO NOT** pass Poison to context functions (e.g., logging). The function never executes. Use `is error` to check first.

**Propagation Logic by Type:**
*   **Expressions:** `1 + error` → `error`.
*   **Function Calls:** `myFunc(error)` → Function body skipped; returns `error`.
*   **Loops:** `for x in error` → Loop body skipped; all variables modified within poisoned.
*   **Conditionals:** `if error` → Both branches skipped; all variables modified within poisoned.
*   **Sequential (`!`):** `db!.fail()` → Subsequent `db!.op()` calls skipped, return error.

---

## Sequential Operations (`!`)

-   **Sequence Keys**: Each static `!` path (e.g., `account!.deposit`) maps to a named sequence channel key.
-   **Compiler Pass** (`src/compiler/sequential.js` + `src/compiler/analysis.js`): `collectSequenceLocks()` identifies `!` markers, validates static paths, and records `sequenceLocks` on analysis metadata.
-   **Runtime Commands**: `SequenceCallCommand` (for `db!.method()` calls) and `SequenceGetCommand` (for `db!.property` reads) each carry a deferred-result promise. The buffer iterator applies them in source order; each awaits the prior result for that sequence channel before executing.
-   **Poison propagation**: If a `!`-call fails, `SequentialPathWriteCommand` marks the path poisoned. All subsequent commands on that path see the poison via `_getSequentialPathPoisonErrors()` and skip execution, rejecting their deferred promises.
