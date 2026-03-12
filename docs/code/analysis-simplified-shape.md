# Analysis Simplified Shape Plan

This document is the implementation plan for simplifying analysis so every `analyzeXxx` method only sets local node data.

Primary goal:
1. produce correct `usedOutputs` and `mutatedOutputs` (plus declarations needed to resolve those two correctly),
2. keep analyzer logic minimal and local-only.

## 1. Target Architecture

### 1.1 Local-Only Analyzer Contract

Each `analyzeXxx` method may only modify `node._analysis` for the current node.
No propagation. No registration into owners. No visibility lookups. No cross-node writes.

### 1.2 Required Local Shape

```js
node._analysis = {
  createScope: false,
  scopeBoundary: false,

  declares: [], // [{ name, type, initializer: node|null }]
  uses: [],     // [handlerName]
  mutates: []   // [handlerName]
};
```

### 1.3 Traversal

Default traversal is always `node.fields`.

Rules:
1. Use `node.fields` for child traversal in the pass.
2. Do not use declaration-target traversal hints.
3. If special scope ownership is needed for a subtree, mark that child node with `child._analysis.createScope = true` (or, if unavoidable, use a small optional `traverse` hint as exception-only fallback).

## 2. Responsibilities Split

### 2.1 Analyzer (`analyzeXxx`)

Allowed:
1. Initialize local shape.
2. Push local `declares` entries.
3. Push local `uses` entries.
4. Push local `mutates` entries.
5. Set local `createScope` / `scopeBoundary`.
6. Optionally return an object to merge into `node._analysis` (small convenience only; direct writes to `node._analysis` are preferred).

Forbidden:
1. Calling pass aggregation APIs (`register*`).
2. Writing owner aggregates (`declaredOutputs`, `usedOutputs`, `mutatedOutputs`, etc.).
3. Parent/ancestor traversal logic.
4. Visible declaration resolution.

Analyzer signature:
1. `analyzeXxx(node, analysisPass, state)`
2. local analysis is always read/written via `node._analysis` (no separate `analysis` argument).

### 2.2 CompileAnalysis Pass

Owns all non-local work:
1. Walk AST via `node.fields`.
2. Build parent links.
3. Scope-owner resolution.
4. Declaration placement and visibility support.
5. Aggregate sets/maps for compile consumers.
6. Dedup/normalization.
7. Derived metadata used by guard and async compile paths.

## 3. Migration Phases

### Phase A: Shape and Pass Infrastructure
1. Keep current behavior green.
2. Ensure all nodes use local arrays (`declares/uses/mutates`).
3. Keep compatibility aggregates produced by pass (`declaredOutputs`, `usedOutputs`, `mutatedOutputs`, etc.).

### Phase B: Analyzer Simplification Sweep
1. Convert every `analyzeXxx` to local-only writes.
2. Remove analyzer `register*` calls.
3. Remove declaration-target hint logic.
4. Keep parity checks enabled.

### Phase C: Centralize Derived Facts
1. Move remaining analyzer-side derived decisions into pass post-processing where possible.
2. Keep compile-time read path stable by consuming pass outputs.

### Phase D: Cleanup
1. Remove dead helper paths that existed only for analyzer registration flow.
2. Keep only pass-owned aggregation APIs internally.
3. Document final model in code comments.

## 4. Acceptance Criteria

1. All `analyzeXxx` methods are local-only.
2. Traversal uses `node.fields` as default.
3. No analyzer calls to `registerOutputDeclaration/registerOutputUsage/registerOutputMutation/registerHandlerUsage/registerHandlerMutation`.
4. `npm run test:quick` passes.
5. Guard suites remain green.
6. Parity checks stay enabled during migration.

## 5. Notes

1. Arrays are preferred for local analyzer simplicity.
2. Dedup and canonicalization are pass responsibilities.
3. Back-compat aggregate fields may remain temporarily for compile consumers, but analyzers must not write them.
