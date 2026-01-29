# Temporary Code Notes

This file tracks temporary or transitional code added during the output refactor (Phase 3).

## Phase 1a output refactor (temporary - added in this chat)

- CommandBuffer unwrapping in async output normalization
  - **Where**: `src/runtime/safe-output.js` (`normalizeBufferValue` + async suppress/ensure paths)
  - **Why**: Avoid `[object Object]` when async output values are `CommandBuffer` (e.g., `super()`).
  - **Remove/Replace**: When output values no longer flow through `suppressValueAsync` / `ensureDefinedAsync`, or when CommandBuffer is fully flattened earlier.

- CommandBuffer unwrapping for output scope metadata
  - **Where**: `src/runtime/frame.js` (`markOutputBufferScope`)
  - **Why**: Ensure revert/scope metadata applies to the actual output array.
  - **Remove/Replace**: When scope metadata lives on CommandBuffer directly.

- Async-mode buffers always CommandBuffer
  - **Where**: `src/compiler/compile-emit.js`, `src/compiler/compile-buffer.js`, `src/compiler/compiler.js`
  - **Why**: Phase 1a now uses CommandBuffer for all async buffers (root, pushed, capture).
  - **Remove/Replace**: When async buffering is reworked or CommandBuffer is removed.

## Phase 1b output refactor (temporary)

- CommandBuffer index moved into runtime (`add`, `reserveSlot`, `fillSlot`)
  - **Where**: `src/runtime/buffer.js`
  - **Why**: Eliminate emitted `*_index` vars in async compiled code.
  - **Remove/Replace**: If buffer slot management is reworked again or CommandBuffer is removed.

- Split buffer write temp stack (`_bufferValueStack`)
  - **Where**: `src/compiler/compile-buffer.js`
  - **Why**: Carry temp value ids across `asyncAddToBufferBegin/End` split emission without `*_index`.
  - **Remove/Replace**: If split buffer writes are refactored to a single emit path.

- Guard revert index reset now uses `CommandBuffer._index`
  - **Where**: `src/compiler/compiler.js`
  - **Why**: Guard output revert must reset internal CommandBuffer index after index vars removed.
  - **Remove/Replace**: When guard/revert no longer depends on buffer index state.

## Phase 2 output refactor (temporary)

- Per-output CommandBuffer arrays/indexes (`data`, `text`, `value`, `_outputIndexes`, `_outputArrays`)
  - **Where**: `src/runtime/buffer.js`
  - **Why**: Transitional support for separating outputs while still keeping legacy `output` behavior.
  - **Remove/Replace**: When output declarations and dedicated buffer ownership are finalized.

- Output usage tracking (`frame.usedOutputs`, `CompileAsync.updateOutputUsage`)
  - **Where**: `src/runtime/frame.js`, `src/compiler/compile-async.js`, `src/compiler/compile-buffer.js`
  - **Why**: Determines which output arrays to attach async CommandBuffers to.
  - **Remove/Replace**: When output routing is explicit and no longer inferred.

- Deferred async buffer insertion via `_bufferAddStack`
  - **Where**: `src/compiler/compile-buffer.js`
  - **Why**: Adds child buffers to parent output arrays only after outputs used are known.
  - **Remove/Replace**: When output graph ownership is explicit.

- `resetBufferOutputIndexes` export + per-output reset usage
  - **Where**: `src/runtime/buffer.js`, `src/runtime/runtime.js`, `src/compiler/compiler.js`
  - **Why**: Keeps per-output indexes consistent after guard/revert.
  - **Remove/Replace**: When guard/revert no longer depends on buffer indexes.

- Backward-compat `AsyncState.asyncBlock` argument shifting (usedOutputs)
  - **Where**: `src/runtime/async-state.js`
  - **Why**: Support older call signatures during refactor.
  - **Remove/Replace**: Once all call sites use the new signature.

## Output handlers + snapshots

- `frame._outputBuffer` + `frame._outputs` initialization
  - **Where**: `src/compiler/compile-emit.js`, `src/compiler/compile-buffer.js`, `src/compiler/compiler.js`
  - **Why**: Transitional support for multi‑output buffers and `snapshot()` while the output refactor is in progress.
  - **Remove/Replace**: When outputs are declared explicitly (Phase 5) and buffer/handler wiring is centralized.

- `Output` class (snapshot support)
- **Where**: `src/runtime/output.js`, exported in `src/runtime/runtime.js`
  - **Why**: Provides `@data.snapshot()`, `@text.snapshot()`, `@value.snapshot()` and internal focus handling.
  - **Remove/Replace**: Once output declarations + explicit returns are fully in place.

- `Output._snapshotFocus(focusName)`
- **Where**: `src/runtime/output.js`
  - **Why**: Internal-only focus handling used by implicit returns; keeps focus validation in `flattenBuffer`.
  - **Remove/Replace**: When implicit returns are removed.

- `runtime.getOutputHandler(frame, name)`
  - **Where**: `src/runtime/runtime.js` (used by `compileSymbol` in `src/compiler/compiler-base.js`)
  - **Why**: Resolve `@handler` symbols even inside nested frames where `_outputs` is not local.
  - **Remove/Replace**: When handler lookup becomes a stable part of the compiler/runtime API.

## Phase 4 output declarations (temporary)

- Output declaration tracking + output-type map (`declaredOutputs` as Map, `_outputTypes` on CommandBuffer)
  - **Where**: `src/compiler/compile-async.js`, `src/compiler/compiler.js`, `src/compiler/compile-emit.js`, `src/runtime/buffer.js`
  - **Why**: Enables explicit outputs with custom names while reusing existing command-handler infrastructure.
  - **Remove/Replace**: When output routing is fully explicit and command handlers no longer require name->type mapping.

- Output proxies (`Output` callable/proxy + `SinkOutputHandler`)
- **Where**: `src/runtime/output.js`, `src/runtime/runtime.js`
  - **Why**: Allow explicit output symbols to be invoked directly (e.g., `myData.set(...)`, `output("...")`, `sink.write(...)`).
  - **Remove/Replace**: When compiler emits explicit output command nodes or a dedicated runtime API replaces proxies.

## Implicit return (script compatibility)

- Transpiler‑injected implicit return using `@output._snapshotFocus(...)`
  - **Where**: `src/script/script-transpiler.js`
  - **Why**: Backward compatibility for scripts that previously relied on implicit output.
  - **Remove/Replace**: When scripts require explicit `return` and output focus directives are deprecated.

## Return handling (compiler)

- `_seesRootScope` compile‑time flag propagated on `Frame.push()` but not `Frame.new()`
  - **Where**: `src/compiler/compiler.js`, `src/runtime/frame.js`
  - **Why**: Allows `return` in nested blocks to short‑circuit root render, while macro/caller returns stay local.
  - **Remove/Replace**: When return flow is reworked or root vs function return handling is encoded in AST.
