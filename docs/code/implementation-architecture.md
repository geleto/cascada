# Cascada Implementation Architecture

Reference guide for compiler internals, runtime mechanics, and chain architecture. For most tasks — adding data methods, writing tests, fixing script-level bugs — the Overview, Glossary, and Golden Rules in `AGENTS.md` are sufficient.

| Task | Go to |
|---|---|
| New compiler statement or expression | Compile-to-Runtime Pipeline · Async Boundary Rules |
| New chain type | Chain Types · Commands And Chains · Compile-to-Runtime Pipeline |
| Linked-chain / chain-visibility bug | Chain Scope And Visibility · Failure Modes |
| Async boundary type selection | Async Boundary Rules |
| Value or poison issue | Value Resolution Rules · Error Handling |
| Output / rendering issue | Final Output Materialization · Value Resolution Rules |
| `!` serialization bug | Sequential Operations |
| Unknown symptom | Failure Modes · Debugging |

---

## Conceptual Model: Cascading Chain Network

Cascada implements the **Cascading Chain Network** — a concurrency model for imperative programming languages. The core idea: every mutable variable is a chain; all values are immutable and may be promises; and the execution flow orchestrates them synchronously without blocking.

-   **Chain** — Each mutable variable is a chain. A chain holds mutable state and its own command iterator (`BufferIterator`). Its commands are stored in command arrays within the command buffer tree. `data`, `text`, and `var` chains are the user-facing types; the runtime can have additional internal chains.

-   **Command array** (`CommandBuffer.arrays[chainName]`) — The ordered sequence of commands for one chain within a single command buffer. Commands are added synchronously by the execution flow.

-   **Command buffer** (`CommandBuffer`) — Scope container holding one command array per active chain, plus child command buffers for async boundaries. Forms the nodes of the command buffer tree.

-   **Mutation command** (`MutatingCommand`) — Modifies the chain's state. Strictly ordered relative to other mutations on the same chain. Takes input values and may return a value.

-   **Observation command** (`ObservableCommand`) — Queries the chain's state or returns a snapshot. Ordered relative to mutations (cannot cross a mutation boundary), but runs concurrently with other observations that fall between the same two mutations. Always returns a value.

-   **Value** — Cascada value flow treats values as immutable; the exception is runtime-owned lazy containers (`RESOLVE_MARKER` objects/arrays) which resolve and mutate in place internally. Any value can be a promise — this applies everywhere: command inputs, command outputs, pure-function arguments and results. Promises are awaited at semantic consumption boundaries; marker-backed containers start background resolution immediately when created, so consumers await an already-running marker.

-   **Execution flow** — The compiled Cascada program: the imperative orchestration layer. Synchronously adds commands to chains, evaluates pure expressions (values outside chains — no state, no side effects), and drives conditions, loops, and other control flow. Chains run in parallel, interconnected through values that flow as resolved values or promises interchangeably. Because commands are added synchronously, `await` is not used in the main flow — except at async boundaries.

-   **Async boundary** — A point where the execution flow must wait for a value before it can proceed (e.g., `if` conditions, loop iteration, `for` iterables). Handled inside its own async function so the surrounding flow remains unblocked. At each boundary a child `CommandBuffer` is inserted into the parent alongside ordinary commands; the child's command arrays are filled asynchronously once the boundary resolves. Together these form the **command buffer tree**.

-   **Command iterator** (`BufferIterator`) — Each chain has its own command iterator that walks the command buffer tree depth-first, independently of the execution flow. Mutations execute strictly in sequence; observations between the same two mutations run concurrently. When the iterator reaches a child buffer slot, it waits until the child's mutations complete. The execution flow and command iterator run concurrently — the iterator may already be applying earlier commands while the flow is still filling later child buffers. This is safe because each child buffer reserves its slot synchronously before any async work begins.

---

## Compile-to-Runtime Pipeline

Prevents race conditions and ensures sequential equivalence when concurrent blocks read/write the same outer-scope variables, via compile-time chain analysis and the command buffer tree.

-   **Compile-time analysis** (`src/compiler/analysis.js`): Annotates AST nodes with declaration/use/mutation metadata. Important fields include `declaredChains`, `usedChains`, `mutatedChains`, `usedChainsFromParent`, `mutatedChainsFromParent`, and `sequenceLocks`.
-   **Buffer code generation** (`src/compiler/buffer.js`, `src/compiler/emit.js`): Emits command creation, linked-chain metadata, child buffer creation, and async boundary wiring.
-   **Implicit Variable Synchronization**: Chain observations and `resolveAll`/`resolveSingle` await pending values only when consumed. Data dependencies serialize naturally without explicit locks.
-   **Linked chains**: `analysis.js` derives `boundaryLinkedChains` and `boundaryLinkedMutatedChains` from the boundary's chain footprint (see Chain Scope And Visibility). Analyzers set `wantsLinkedChildBuffer` as intent; finalization computes `createsLinkedChildBuffer` as the outcome. `createsLinkedChildBuffer` means the node creates a child `CommandBuffer`; it can be true even when the finalized link sets are empty. `emit.js`/`buffer.js` pass finalized links to `new CommandBuffer(...)` and boundary functions so child buffers route commands to the correct parent lanes. Pure-observation expression boundaries keep the intent but compute `createsLinkedChildBuffer = false` and drop both link sets. If a chain is not linked, fix analysis/emit rather than adding runtime fallbacks.

---

## Chain Scope And Visibility

A chain is visible in a scope only if it is declared there or linked from a parent. Visibility is fixed at compile time — there is no runtime fallback lookup.

-   `declaredChains` — chains introduced at this scope level; not linked to the parent even if the parent has the same name.
-   `usedChains` / `mutatedChains` — full aggregate read and write footprint, including chains declared by this node.
-   `usedChainsFromParent` / `mutatedChainsFromParent` — parent-visible read and write footprint, derived from the aggregate footprint minus local declarations. Compiler consumers that need outer dependencies should use the `analysis.getChainsUsedFromParent(...)` / `analysis.getChainsMutatedFromParent(...)` helpers.
-   `boundaryLinkedChains` — parent-visible chains the child can observe, derived from `usedChainsFromParent` unless custom node analysis narrows it.
-   `boundaryLinkedMutatedChains` — parent-visible chains the child can mutate, derived from `mutatedChainsFromParent` unless custom node analysis narrows it.

If a child cannot see a chain, fix `usedChainsFromParent`/`mutatedChainsFromParent` in `analysis.js` or the `boundaryLinkedChainNames`/`boundaryLinkedMutatedChainNames` emit path. Do not add runtime lookup fallbacks.

Function, macro, and method bodies create scope boundaries where outer chains are not automatically visible; their linked sets must cover every chain the body touches.

---

## Commands And Chains

Commands are split by chain under `src/runtime/chains/`. A command is enqueued in the current command buffer's command array and applied in source order. Observation commands return promises; mutation commands change chain state. Look up the relevant chain file instead of adding cross-chain special cases.

Use the right observation primitive. `SnapshotCommand` inspects the chain and turns poison into a rejected observation. `RawSnapshotCommand` captures the raw chain target without poison inspection — used where poisoned leaves may be replaced by an incoming write (e.g., `var`-chain `set_path` overwrites). To wait for a whole chain result, prefer `chain.finalSnapshot()` over enqueueing a snapshot command unless source-position observation is specifically required.

Always add commands through the compiler's active buffer expression: `compiler.buffer.currentBuffer` (often emitted as the runtime variable `currentBuffer` inside boundary callbacks, or `output` at the root). Never skip to a parent/root/producer buffer, and never call a chain directly to "just apply" a command. If the current buffer cannot see the needed chain, fix analysis/linking/current-buffer selection rather than bypassing the buffer tree.

`WaitCurrentCommand` (`src/runtime/commands/wait.js`) is a timing-only sync point: it resolves when the iterator reaches this source-position slot on a specific chain lane, carrying no snapshot or error semantics. Used by concurrency-limited loops to enforce "slot N must finish before N+1 begins" across async iterations.

Two distinct error-injection commands exist in `src/runtime/commands/errors.js`:
-   **`ErrorCommand`** — placed in the buffer command stream; the iterator throws immediately when it reaches this entry. Used when an entire async boundary has failed and no chain mutation will occur.
-   **`TargetPoisonCommand`** — writes `PoisonedValue` directly into a specific chain's target. Used to contaminate a chain's output mid-stream when a value-consumption failure occurs without aborting the whole boundary.

---

## Chain Types

| Type | Class | `snapshot()` | Primary commands | Declared by |
|---|---|---|---|---|
| `data` | `DataChain` | Assembled object | `DataCommand` (method dispatch) | `data name` in script; `output` chain in templates |
| `text` | `TextChain` | Concatenated string | `TextCommand` | `text name` in script; template write chain |
| `var` | `VarChain` | Current value (sync fast-path) | `VarCommand` | `var x = …` / `{% set x = … %}` |
| `sequence` | `SequenceChain` | — | `SequenceCallCommand`, `SequenceGetCommand` | `!`-path compile pass |
| `sequential_path` | `SequentialPathChain` | — | `SequentialPathWriteCommand`, `SequentialPathReadCommand` | `!`-path state / poison tracking |

All chains are created via `runtime.declareBufferChain(buffer, name, type, context, initializer)`. New chain types must subclass `Chain` (`base.js`), register a factory in `createChain` (`index.js`), and implement `_applyCommand` and `finalSnapshot`.

---

## Command Buffer Mechanics

Command-buffer add helpers return `cmd.promise` immediately. For observation commands and result-producing mutation commands this is a promise that resolves or rejects when the command iterator reaches and applies the command — the actual chain state is read only at that source position. Plain mutation commands carry no result promise; their add call returns `undefined`.

"Finished" has three distinct lifecycle stages — be explicit about which you are touching:
-   **Accept-closed** (`markChainFinished()` / `markFinished()`): the buffer stops accepting new commands on a lane or all lanes.
-   **Iterator-exited**: the iterator has applied all commands in the relevant lane and moved on.
-   **Materialized** (`chain.finalSnapshot()`): waits for iterator completion then returns the fully assembled value.

Observation commands are source-ordered reads, not free side chains. The command iterator tracks pending observation promises in `_pendingObservables` and waits for them before applying later mutation commands on the same chain. Both `SnapshotCommand` and `RawSnapshotCommand` block their own chain's mutations; `isUniversalObservationCommand` is a marker used by component shared-observation validation, not for global cross-lane blocking.

---

## Async Boundary Rules

Prefer creating the command-buffer shape synchronously. Plain async values usually do not need a child buffer: enqueue the command immediately with promise arguments, and let the target chain resolve those arguments when source order reaches the command.

Child buffers represent an async boundary where the future command shape is unknown until a value resolves. Common cases are async conditions (`if`/`switch`), loops whose iterable or continuation is async (`for`/`each`/`while`), includes/imports/extends or composition loading, caller/macro scheduling, and other constructs where resolving a value decides which commands exist or how many commands are produced. Do not delay adding an ordinary command merely because one of its arguments is a promise — the parent preserves the source-order slot and the iterator waits only when it reaches that slot.

Four boundary primitives exist in `src/runtime/async-boundaries.js`. All except `runRenderBoundary` take `(parentBuffer, boundaryLinkedChainNames, boundaryLinkedMutatedChainNames, ...)` as their leading arguments.

| Function | Level | Completion/error path | When to use |
|---|---|---|---|
| `runControlFlowBoundary` | Statement | Boundary callback returns a value or thenable; runner finishes child buffer and reports structural failures | `if`, `for`, `each`, includes, macros |
| `runWaitedControlFlowBoundary` | Statement | Same as `runControlFlowBoundary`, then drains `waitedChainName` before completion | Concurrency-limited loops; `waitedChainName` enforces slot-N-before-N+1 ordering |
| `runRenderBoundary` | Statement | Boundary callback returns a value or thenable; runner finishes isolated render buffer and reports structural failures | Render-scope boundaries with no parent chain links |
| `runValueBoundary` | Expression | Preserves `asyncFn` rejection | Async value must resolve before expression continues; generated code wraps consumption errors as `PoisonError` |

Using the wrong primitive causes silently swallowed errors or broken expression evaluation.

Generated statement-boundary callbacks should be sync/async hybrids: emit a
plain function that returns either a concrete result or a thenable, and let the
runtime boundary runner handle the thenable path. For branch selectors
(`if`, `switch`, dynamic `case`, `while` continuation), use
`runtime.consumeControlFlowValue(...)` so selector resolution, poison
normalization, and skipped-chain poisoning stay in the runtime instead of being
reimplemented in generated `try/catch` or manual `.then` probes. Waited loop
callbacks should return `runtime.finishBufferAndWait(...)` rather than locally
awaiting the waited chain, or `runtime.finishBufferAndContinue(...)` when a
clean waited-chain completion should resolve to a control-flow signal such as
`true` for another `while` iteration. Use `asyncCallback` only for callback
bodies that genuinely need local `await` because they must produce multiple
values at different generated-code points.

---

## Loop Parallelism: `for` vs `each`

`for item in list` launches all loop-body iterations concurrently — each gets its own child buffer; `data` and `text` chains guarantee source-order assembly despite out-of-order completion. `each item in list` executes iterations strictly one at a time (each completes before the next begins). Internally these map to `asyncAll` (parallel) and `asyncEach` (sequential) in `src/runtime/loop.js`. Use `each` when the loop body has ordered side effects that don't use a `!` path.

---

## Value Resolution Rules

Everything inside Cascada can be either a plain value or a promise for that value. Runtime code should preserve that shape unless it is at a real consumption boundary.

Runtime value shapes:
-   **Promises / `RuntimePromise`**: deferred values flowing through expressions, command arguments, chains, and variables until consumed. `RuntimePromise` wraps a native Promise with source-location context so that late rejections still carry the original source position.
-   **Lazy objects/arrays with `RESOLVE_MARKER`**: `createObject()` / `createArray()` mark containers whose properties/elements may be async. Background resolution starts immediately when the factory is called; consumers await the already-running marker promise. A plain `await value` will not finalize their async properties.
-   **PoisonedValue**: a thenable error container. Detect synchronously with `isPoison(value)` before `await`; it rejects as a `PoisonError` for one failure or `PoisonErrorGroup` for multiple failures if awaited.

Use the runtime `resolve*` helpers (`resolveAll`, `resolveSingle`, `resolveDuo`, `resolveObjectProperties`, etc.) at consumption boundaries for arbitrary Cascada values instead of direct `await` — they know all value shapes and preserve fast paths. Direct `await` and `Promise.resolve` are fine for known internal promises, iterator cleanup, and already-classified native promises. Do not use `Promise.resolve` as a reflex on Cascada values; it collapses thenables and breaks the value-shape system.

Avoid resolving or awaiting values early. Resolution belongs at true async boundaries and final consumption (function calls, condition checks, iteration, output materialization). Command arguments must be enqueued as-is; command/chain apply paths consume them only when the command's semantics require a concrete value. A `var` assignment is a raw store and keeps promise, `RESOLVE_MARKER`, and poison shapes intact.

Values are awaited only at three semantic points:

1. **Command application** — `Command.apply(...)` and command argument
   preparation may consume command inputs when the command iterator reaches the
   source-ordered slot.
2. **Control boundaries** — async boundary bodies may await values that decide
   command shape or control flow, such as conditions, iterables, loop
   continuation checks, composition targets, and load/selection results.
3. **Value transformations** — pure value helpers may consume value inputs and
   return a new value without mutating chain state or the input values.
   Examples include expression operators, member lookup, function-call argument
   preparation, text
   materialization, and object/array property resolution.

At these value-consumption points, promise rejection and existing
`PoisonedValue`/poison-error inputs are Cascada dataflow errors. The consuming
site must preserve the originating error context and surface `PoisonError`,
`PoisonErrorGroup`, or `PoisonedValue`, while continuing to collect independent
errors when possible. Structural failures outside value consumption are fatal
runtime failures and should surface as `RuntimeError`. Compiler/analysis
failures belong to `CompileError`.

Generated control-flow handlers must keep this boundary precise: catch only
the condition, switch expression, case expression, iterator, or other selector
value being consumed. Do not wrap branch/body execution in a broad catch to
turn arbitrary throws into poison. Branch/body errors are either produced as
poison at their own value source, enqueued as command errors by their owner, or
allowed to propagate as fatal runtime failures.

---

## Final Output Materialization

-   **`chain.finalSnapshot()`** — waits for the command iterator to finish, then assembles and returns the chain value. Call only after the buffer is fully written; calling early will hang.
-   **`normalizeFinalPromise(value)`** (`resolve.js`) — converts a snapshot to a native Promise; `PoisonedValue` becomes a rejected Promise with `PoisonError` for one failure or `PoisonErrorGroup` for multiple failures.
-   **Template rendering** — each written value passes through `safe-output.js`: autoescape, array joining, and poison detection. The final text is assembled from the `text` / `output` chain.
-   **Script return** — the value of the explicit `return` expression; templates return the fully rendered text string.
-   **Public APIs** (`renderScriptString`, `renderTemplateString`) — materialize all chains via `finalSnapshot()` and surface chain poison as a rejected render promise.

---

## Error Handling (Poison System)

-   **Core Principle**: "Never Miss Any Error." Await all promises and collect all errors before throwing.
-   **`PoisonedValue`**: *Thenable* object carrying `.errors[]` array. Can be passed synchronously.
-   **`PoisonError`**: individual non-fatal contextual error. Its `cause` is the original JavaScript error when there is one.
-   **`PoisonErrorGroup`**: aggregate used when multiple poison errors are surfaced together. Its `.errors[]` entries are individual `PoisonError`s. Single-error poison paths surface the individual `PoisonError` directly.
-   **Detection**:
    -   `isPoison(value)` — Use **before** `await`. Fast, synchronous check. Identifies existing `PoisonedValue` objects; will not `await` a promise to see if it rejects. Ideal for fast-path in Sync-First Hybrid pattern.
    -   `isPoisonError(err)` — Use **in `catch` block**.
-   **Suppressing unhandled-rejection warnings**: `markPromiseHandled()` and command argument staging attach rejection handlers to Cascada-owned promises that will be consumed later. This prevents Node's unhandled-rejection warning on promises Cascada deliberately defers. Do not replace with eager `await`/resolution — that would change semantics.
-   **Reference**: `docs/code/Error Handling Guide.md`, `docs/code/Poisoning - Implementation Principles.md`

### Error Propagation (Dataflow Poisoning)

Cascada treats errors as data ("Poison") flowing through the system.

-   **Native JS Call Suppression:** Native JS/context calls that receive Poison input do not execute; they immediately return new Poison combining input errors. Cascada-level functions, macros, methods, and explicit call constructs may receive poison/error values so they can inspect or repair them.
-   **Contamination:** Any variable/output that would've been modified by a skipped operation/block is automatically Poisoned.
-   **Value Consumption Errors Become Poison:** When Cascada consumes a value (via `resolve*`, command apply, function-call argument preparation, expression evaluation, condition checks, iteration, or final materialization), rejections/poison are handled as Cascada poison. If ordinary Cascada control flow throws during normal execution, treat it as a real bug; do not normalize it into poison just to continue.
-   **Returned Chain Poison:** If a chain returned by a script, function, macro, call, method, or similar Cascada construct contains poison, return that poison through Cascada value flow. Public render APIs such as `renderScriptString` materialize that as a rejected promise.
-   **Fatal Runtime Errors:** `RuntimeError` and broken runtime contracts are real failures, not poison data. Async callback-style boundaries that have no awaiting caller should report such failures through render state/reporting paths with compact context.
-   **Context Function Warning:** **DO NOT** pass Poison to context functions (e.g., logging). The function never executes. Use `is error` to check first.

**Propagation Logic by Type:**
-   **Expressions:** `1 + error` → `error`.
-   **Function Calls:** `myFunc(error)` → Function body skipped; returns `error`.
-   **Loops:** `for x in error` → Loop body skipped; all variables modified within poisoned.
-   **Conditionals:** `if error` → Both branches skipped; all variables modified within poisoned.
-   **Sequential (`!`):** `db!.fail()` → Subsequent `db!.op()` calls skipped, return error.

---

## Sequential Operations (`!`)

-   **Sequence Keys**: Each static `!` path (e.g., `account!.deposit`) maps to a named sequence chain key.
-   **Compiler Pass** (`src/compiler/sequential.js` + `src/compiler/analysis.js`): analysis records explicit `!` definitions/usages as local node facts. In post-analysis, ordinary static reads are matched against the completed root `sequenceLocks` set so bare reads can share the same runtime sequence chain without a separate tree walk.
-   **Runtime Commands**: `SequenceCallCommand` (for `db!.method()` calls) and `SequenceGetCommand` (for `db!.property` reads) each carry a deferred-result promise. The command iterator applies them in source order; each awaits the prior result for that sequence chain before executing.
-   **Poison propagation**: If a `!`-call fails, `SequentialPathWriteCommand` marks the path poisoned. All subsequent commands on that path see the poison via `_getSequentialPathPoisonErrors()` and skip execution, rejecting their deferred promises.

---

## Failure Modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Child can't see parent chain value | Missing `boundaryLinkedChains` | Fix `usedChains` in `analysis.js` or linked-chain emit |
| Child mutation not reflected in parent | Missing `boundaryLinkedMutatedChains` | Fix `mutatedChains` in `analysis.js` or emit |
| Output order wrong or race condition | Command added to wrong buffer | Always use `currentBuffer`; never jump to parent/root |
| Unhandled-rejection warning | Promise not handled before deferred consumption | Call `markPromiseHandled()` or stage as command argument immediately |
| Poison silently swallowed | Wrong boundary primitive | Control-flow errors need `cb`; expression errors need `runValueBoundary` |
| Final render hangs | Buffer or chain never finished | Ensure `markFinished()` / `markChainFinished()` is called on all paths |
| `!` path not serializing | Sequence lock not recorded or bare read not matched in post-analysis | Check `getSequenceLockLookup()` / `postAnalyzeSequenceLockLookup()` in `sequential.js` |
| Chain not found at runtime | `declareBufferChain()` not emitted | Emit chain declaration at codegen time |

---

## Debugging

-   **Inspect generated JS** — call `script._compileSource()` or `template._compileSource()` on a compiled object to log or step through the emitted buffer/chain code.
-   **Check analysis metadata** — `node._analysis.usedChains`, `.usedChainsFromParent`, `.boundaryLinkedChains`, `.mutatedChains`, etc. on a parsed AST node to verify chain footprints before they reach codegen.
-   **Render hangs** — find the buffer or chain where `finished === false`; trace why `markFinished()` / `markChainFinished()` was not called on all code paths.
-   **Unhandled rejection** — locate where the promise was created and verify it is either staged as a command argument or has `markPromiseHandled()` called before deferral.
-   **Wrong output order** — trace which `CommandBuffer` `currentBuffer` points to at the emit site; commands added to the wrong buffer break source-order assembly.
