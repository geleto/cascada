# Cascada File Map

Complete source and documentation file reference. The most critical files for day-to-day work are listed in `AGENTS.md`; this file covers everything.

---

## Source Directories

-   `src/compiler/`: Core compiler logic — AST transformation, chain analysis, async boundaries, code generation.
-   `src/environment/`: Public API, environment configuration, wrapper classes (`AsyncEnvironment`, `AsyncTemplate`, `Script`).
-   `src/loader/`: Template loading — FileSystem, Web, precompiled, string helpers.
-   `src/runtime/`: Runtime helpers, command buffers, chains, async boundaries, lookups/calls, error handling (Poison system).
-   `src/language/`: Template and Cascada Script language frontends — lexer, parser, AST nodes, transformer, script transpiler.

---

## Key Source Files

### Entry Points
-   `src/index.js` — Package entry point. Exports public classes/functions.
-   `src/environment/environment.js` — Environment barrel. Re-exports `Environment`, `AsyncEnvironment`, `Template`, `AsyncTemplate`, `Script`.
-   `src/environment/async-environment.js` — Async user-facing API. Tests instantiate `AsyncEnvironment` here or from `src/index.js`.

### Environment / Compiled Classes
-   `src/environment/template.js` — Compiled template classes (`Template`, `AsyncTemplate`).
-   `src/environment/script.js` — Compiled script class (`Script`). Transpiles script syntax to template syntax before compilation.

### Runtime Core
-   `src/runtime/runtime.js` — Runtime barrel. Re-exports helpers and chain/command classes used by compiled code.
-   `src/runtime/errors.js` — Poison and error helpers: `PoisonError`, `isPoison`, `isPoisonError`, `createSyncRuntimeError`.
-   `src/runtime/resolve.js` — Promise/poison resolution: `resolveAll`, `resolveSingle`, sync-first helpers.
-   `src/runtime/command-buffer.js` — Command buffer implementation. Creates and links runtime buffers, routes commands to chains.
-   `src/runtime/command-iterator.js` — Lane input iterator used by command-buffer observe/mutate/iterate runners.
-   `src/runtime/async-boundaries.js` — Runtime support for compiler-inserted async boundaries.
-   `src/runtime/markers.js` — `RESOLVE_MARKER` and related value-shape markers.
-   `src/runtime/guard.js` — Guard snapshot/restore for conditional error-recovery blocks.
-   `src/runtime/loop.js` — Loop runtime helpers: `asyncAll` (parallel `for`) and `asyncEach` (sequential `each`).

### Runtime Chains
-   `src/runtime/chains/data-chain.js` — Data chain state and custom data-method dispatch.
-   `src/runtime/chains/text-chain.js` — Text chain state.
-   `src/runtime/chains/var-chain.js` — Single-value variable chain state.
-   `src/runtime/chains/sequence-chain.js` — Sequence chain state for sequential `!` targets.
-   `src/runtime/chains/sequential-path-chain.js` — Sequential-path poison/repair state.
-   `src/runtime/commands/data.js` — `DataCommand`.
-   `src/runtime/commands/text.js` — `TextCommand`.
-   `src/runtime/commands/var.js` — `VarCommand`.
-   `src/runtime/commands/sequence.js` — `SequenceCallCommand`, `SequenceGetCommand`.
-   `src/runtime/commands/sequential-path.js` — `SequentialPathReadCommand`, `SequentialPathWriteCommand`, repair commands.
-   `src/runtime/commands/observation.js` — `SnapshotCommand`, `RawSnapshotCommand`, `IsErrorCommand`, `GetErrorCommand`, `CaptureGuardStateCommand`, `RestoreGuardStateCommand`.
-   `src/runtime/commands/wait.js` — `WaitCurrentCommand`, `WaitResolveCommand` — timing-only sync points.
-   `src/runtime/commands/errors.js` — `ErrorCommand` (iterator throws), `TargetPoisonCommand` (writes poison into chain target).
-   `src/runtime/chains/base.js` — `Chain` base class.

### Compiler
-   `src/compiler/compiler.js` — Main compiler entry. Chooses sync/async/script mode, orchestrates code generation.
-   `src/compiler/compiler-async.js` — Async statement compiler. Handles statements, output commands, guards, async boundaries.
-   `src/compiler/compiler-sync.js` — Sync statement compiler. Handles non-async templates and statements.
-   `src/compiler/compiler-base-async.js` — Async expression compiler. Lookups, function calls, waited reads.
-   `src/compiler/compiler-base-sync.js` — Sync expression compiler.
-   `src/compiler/compiler-base.js` — Shared expression compiler base.
-   `src/compiler/compiler-common.js` — Shared statement compiler base.
-   `src/compiler/analysis.js` — Chain analysis pre-pass. Computes observed, mutated, declared, linked, and sequenced chain facts.
-   `src/compiler/buffer.js` — Buffer/codegen helpers. Emits command construction and command-buffer interactions.
-   `src/compiler/emit.js` — Low-level code generation primitives.
-   `src/compiler/async-boundaries.js` — Async boundary emission. Emits `runControlFlowBoundary` / `runValueBoundary` wiring.
-   `src/compiler/sequential.js` — Sequential (`!`) analysis. Identifies static sequence paths, validates `!` usage.
-   `src/compiler/scope-boundaries.js` — Canonical lexical-scope boundary definitions used by analysis and transformation.
-   `src/compiler/loop.js` — Loop compilation helpers.
-   `src/compiler/macro.js` — Macro compilation.
-   `src/compiler/inheritance.js` — Template inheritance / `extends` compilation.
-   `src/compiler/component.js` — Component/composition compilation.
-   `src/compiler/return.js` — Return statement compilation.
-   `src/compiler/chain.js` — Chain declaration and command emission helpers.
-   `docs/code/source-order-declarations.md` — Planned source-order declaration lookup design for compiler symbol resolution.

### Script
-   `src/language/script-transpiler.js` — Script-to-template transpiler.
-   `src/builtins/data-methods.js` — Built-in data-chain methods: `push`, `merge`, etc.

---

## Test Directories

-   `tests/pasync/` — Async/parallelism tests, organized by feature:
    `loops.js`, `conditional.js`, `expressions.js`, `macros.js`, `sequential-*.js`, `script.js`, `extends*.js`, `snapshots.js`, `return.js`, `race.js`, `chains-explicit.js`, etc.
    Before writing a new test, scan for an existing file covering the relevant feature.
-   `tests/poison/` — Poison/error system tests.
-   `tests/script-transpiler.js` — Script transpiler tests.
-   `tests/api.js` — Public API tests.
-   `tests/core.js`, `tests/compiler.js` — Classic Nunjucks compatibility tests.
-   `tests/util.js` — `StringLoader` and other test utilities.

---

## Documentation Files

### User Docs (`docs/cascada/`)

-   `script.md` — Comprehensive, human-readable Cascada Script syntax and features reference. Authoritative — almost always up-to-date even before features are developed.
-   `cascada-agent.md` — Concise AI-optimized guide to Cascada Script and Cascada Template, may lag `script.md`.
-   `template.md` — Outdated Nunjucks-compatible template syntax guide. Use Nunjucks knowledge and scripting docs instead.
-   `legacy.md` — Design document describing the old implicit-handler model. Useful when rewriting scripts that use legacy semantics.
-   `streaming.md` — Async iterable inputs and streaming support.

### Implementation Guides (`docs/code/`)

Documentation of current architecture and runtime behavior. May not be fully up-to-date; treat as design context, not authority over live behavior.

-   `implementation-architecture.md` — Full compiler/runtime architecture reference: async execution model, chain system, buffer mechanics, value resolution, error propagation, sequential operations.
-   `sync-first.md` — Sync-first runtime/compiler pattern for new async-aware helpers and generated callbacks.
-   `testing-guide.md` — Test assertion examples, advanced testing techniques, development scenario walkthroughs.
-   `Tests.md` — General testing guidelines and philosophy.
-   `file-map.md` — This file.
-   `Error Handling Guide.md` — Authoritative reference for the runtime error model.
-   `Error Handling Patterns In Script.md` — Common error-handling patterns in scripts.
-   `Poisoning - Implementation Principles.md` — Detailed mechanics of error propagation.
-   `deferred-rejection-handling.md` — Where to attach rejection handlers and avoid unhandled rejections.
-   `sequence.md` — Current `sequence` chain implementation and `!` behavior.
-   `output.md`, `output-scoping.md` — Chain runtime and chain-scoping model.
-   `expression-chains.md` — Async expression model for value-producing, command-enqueuing expressions.
-   `caller.md` — `caller()` structural-attachment architecture.
-   `composition.md` — Current payload-based composition architecture.
-   `waited-loops.md` — Sequential/bounded loop `__waited__` chain behavior.
-   `return.md` — Script return architecture.

### Plans & Design Notes (`docs/plans/`)

Audits, refactor/migration plans, reviews, and future design proposals. These describe *intended* or *in-progress* work, not necessarily current behavior — always verify against source. Once a plan lands and is documented under `docs/code/`, its note here is historical.

-   Analysis & chains: `analysis-audit.md`, `analysis-audit-2.md`, `analysis-audit-3.md`, `analysis-chains-refactor.md`, `chain-facts-refactor.md`, `chains-refactor.md`.
-   Command buffer: `command-buffer-refactor.md`, `command-buffer-refactor-2.md`.
-   Error handling: `error-context-refactor.md`, `error-context-refactor-2.md`, `error-handling-analysis.md`, `error-handling-implementation.md`.
-   Composition & inheritance: `composition-review.md`, `composition-update.md`, `extends-refactor.md`, `extends-architecture.md`, `extends-metadata-architecture.md`, `block-extends.md`, `async-locals-composition.md`.
-   Language & runtime proposals: `this.shared.md`, `macro-aliasing.md`, `return-transpile.md`, `Lazy Deep Resolve.md`, `sync-first-conversion-plan.md`.
-   Migration & docs tracking: `esm.md`, `doc-review.md`, `undocumented.md`, `script-doc-notes.md`.
