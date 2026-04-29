# Cascada File Map

Complete source and documentation file reference. The most critical files for day-to-day work are listed in `AGENTS.md`; this file covers everything.

---

## Source Directories

-   `src/compiler/`: Core compiler logic — AST transformation, channel analysis, async boundaries, code generation.
-   `src/environment/`: Public API, environment configuration, wrapper classes (`AsyncEnvironment`, `AsyncTemplate`, `Script`).
-   `src/loader/`: Template loading — FileSystem, Web, precompiled, string helpers.
-   `src/runtime/`: Runtime helpers, command buffers, channels, async boundaries, lookups/calls, error handling (Poison system).
-   `src/script/`: Cascada Script specifics — default data-channel methods, channel helpers, script-to-template transpiler.

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
-   `src/runtime/runtime.js` — Runtime barrel. Re-exports helpers and channel/command classes used by compiled code.
-   `src/runtime/errors.js` — Poison and error helpers: `PoisonError`, `isPoison`, `isPoisonError`, `handleError`.
-   `src/runtime/resolve.js` — Promise/poison resolution: `resolveAll`, `resolveSingle`, sync-first helpers.
-   `src/runtime/command-buffer.js` — Command buffer implementation. Creates and links runtime buffers, routes commands to channels.
-   `src/runtime/buffer-iterator.js` — Buffer iterator. Walks the command buffer tree depth-first in source order, applies commands, waits on unfilled child slots.
-   `src/runtime/async-boundaries.js` — Runtime support for compiler-inserted async boundaries.
-   `src/runtime/markers.js` — `RESOLVE_MARKER` and related value-shape markers.
-   `src/runtime/guard.js` — Guard snapshot/restore for conditional error-recovery blocks.
-   `src/runtime/loop.js` — Loop runtime helpers: `asyncAll` (parallel `for`) and `asyncEach` (sequential `each`).

### Runtime Channels
-   `src/runtime/channels/data.js` — `DataCommand`, custom data-method dispatch.
-   `src/runtime/channels/text.js` — Text channel and `TextCommand`.
-   `src/runtime/channels/var.js` — `VarCommand` — single-value variable channel.
-   `src/runtime/channels/sequence.js` — `SequenceCallCommand`, `SequenceGetCommand` — sequential `!` path execution.
-   `src/runtime/channels/sequential-path.js` — `SequentialPathReadCommand`, `SequentialPathWriteCommand`, repair commands.
-   `src/runtime/channels/observation.js` — `SnapshotCommand`, `RawSnapshotCommand`, `IsErrorCommand`, `GetErrorCommand`, `CaptureGuardStateCommand`, `RestoreGuardStateCommand`.
-   `src/runtime/channels/timing.js` — `WaitCurrentCommand`, `WaitResolveCommand` — timing-only sync points.
-   `src/runtime/channels/error.js` — `ErrorCommand` (iterator throws), `TargetPoisonCommand` (writes poison into channel target).
-   `src/runtime/channels/base.js` — `Channel` base class.

### Compiler
-   `src/compiler/compiler.js` — Main compiler entry. Chooses sync/async/script mode, orchestrates code generation.
-   `src/compiler/compiler-async.js` — Async statement compiler. Handles statements, output commands, guards, async boundaries.
-   `src/compiler/compiler-sync.js` — Sync statement compiler. Handles non-async templates and statements.
-   `src/compiler/compiler-base-async.js` — Async expression compiler. Lookups, function calls, waited reads.
-   `src/compiler/compiler-base-sync.js` — Sync expression compiler.
-   `src/compiler/compiler-base.js` — Shared expression compiler base.
-   `src/compiler/compiler-common.js` — Shared statement compiler base.
-   `src/compiler/analysis.js` — Channel analysis pre-pass. Computes `declaredChannels`, `usedChannels`, `mutatedChannels`, `sequenceLocks`.
-   `src/compiler/buffer.js` — Buffer/codegen helpers. Emits command construction and command-buffer interactions.
-   `src/compiler/emit.js` — Low-level code generation primitives.
-   `src/compiler/boundaries.js` — Async boundary emission. Emits `runControlFlowBoundary` / `runValueBoundary` wiring.
-   `src/compiler/sequential.js` — Sequential (`!`) analysis. Identifies static sequence paths, validates `!` usage.
-   `src/compiler/scope-boundaries.js` — Canonical lexical-scope boundary definitions used by analysis and transformation.
-   `src/compiler/loop.js` — Loop compilation helpers.
-   `src/compiler/macro.js` — Macro compilation.
-   `src/compiler/inheritance.js` — Template inheritance / `extends` compilation.
-   `src/compiler/component.js` — Component/composition compilation.
-   `src/compiler/return.js` — Return statement compilation.
-   `src/compiler/channel.js` — Channel declaration and command emission helpers.

### Script
-   `src/script/script-transpiler.js` — Script-to-template transpiler.
-   `src/script/default-data-methods.js` — Built-in data-channel methods: `push`, `merge`, etc.

---

## Test Directories

-   `tests/pasync/` — Async/parallelism tests, organized by feature:
    `loops.js`, `conditional.js`, `expressions.js`, `macros.js`, `sequential-*.js`, `script.js`, `extends*.js`, `snapshots.js`, `return.js`, `race.js`, `channels-explicit.js`, etc.
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

May not be fully up-to-date. Treat as design context, not authority over live behavior.

-   `implementation-architecture.md` — Full compiler/runtime architecture reference: async execution model, channel system, buffer mechanics, value resolution, error propagation, sequential operations.
-   `testing-guide.md` — Test assertion examples, advanced testing techniques, development scenario walkthroughs.
-   `file-map.md` — This file.
-   `Error Handling Guide.md` — Overview of the Poison error system.
-   `Error Handling Patterns In Script.md` — Common error-handling patterns in scripts.
-   `Poisoning - Implementation Principles.md` — Detailed mechanics of error propagation.
-   `sequence.md` — Notes on `!` sequence behavior.
-   `output.md`, `output-scoping.md` — Output channel and scoping notes.
-   `channels-refactor.md`, `command-buffer-refactor.md`, `expression-channels.md` — Channel and command-buffer implementation notes.
-   `waited-loops.md` — Loop/wait behavior notes.
-   `return.md`, `return-transpile.md` — Return semantics and script transpilation notes.
-   `Tests.md` — General testing guidelines and philosophy.
