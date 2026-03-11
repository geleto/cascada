# Output Analysis Pass Plan

This document defines the architecture and implementation plan for moving output metadata analysis to a dedicated pre-pass while keeping logic colocated with compiler node handling.

Scope of this plan:
- Compute `declaredOutputs`, `usedOutputs`, and `mutatedOutputs` before emission.
- Keep async script/template behavior identical.
- Remove duplicated metadata bookkeeping from emit-time paths.
- Support guard lowering and async block linking from precomputed metadata.
- Add reusable `_analysis` properties that compile methods consume directly to avoid duplicated logic.

## 1. Goals

1. Single source of truth for output metadata (`declares`, `uses`, `mutates`).
2. Deterministic scope semantics using explicit scope metadata (`createScope`, `scopeBoundary`).
3. Reuse existing compiler node knowledge (no second implementation in transformer files).
4. Full rollout (all relevant nodes), not partial migration.
5. Keep runtime behavior unchanged during migration.
6. Avoid duplicated logic between `analyzeXxx` and `compileXxx`; compile should consume `_analysis` data whenever possible.

## 2. Non-Goals

1. No runtime semantic redesign in this phase.
2. No parser AST schema changes beyond adding `_analysis` metadata.
3. No partial-node fallback mode once rollout is completed.

## 3. Core Model

Each AST node may receive `node._analysis`.

Suggested shape:

```js
node._analysis = {
  createScope: false,       // this node owns a declaration scope/frame
  scopeBoundary: false,     // lookup boundary for declaration search
  parent: null,             // parent node._analysis (or null at root)

  declaresLocal: new Map(), // name -> { type, node, ...optional info }
  usesLocal: new Set(),     // names read by this node
  mutatesLocal: new Set(),  // names mutated by this node

  // filled by resolver/aggregator
  declaredOutputs: null,    // Map attached to scope owners
  usedOutputs: null,        // Set attached per frame-owner node
  mutatedOutputs: null,     // Set attached per frame-owner node

  // optional analyzer-computed facts for compile-time reuse
  facts: null
};
```

Important conventions:
- `declaresLocal` is intent recorded on the source node; final declaration placement is resolved centrally.
- No node analyzer writes directly into arbitrary ancestor maps; placement happens through explicit owner resolution.
- Name canonicalization (aliases, lock keys) happens before insertion into local sets/maps for this rollout.
- `_analysis` may include any additional properties that remove duplicated logic in compile.
- If compile can consume `_analysis` instead of recomputing the same fact, it should consume `_analysis`.

## 4. Scope Semantics

Two explicit flags are used:

1. `createScope`
- Node creates a declaration scope/frame owner.
- Declaration placement target is the nearest ancestor (including self) where `createScope === true`.

2. `scopeBoundary`
- Stops upward lookup for declaration resolution.
- Used for "search until boundary" rules (for example symbol resolution or boundary-aware propagation logic).

Notes:
- `createScope` and `scopeBoundary` may be equal on many nodes, but are not forced to match.
- Root node is both `createScope: true` and `scopeBoundary: true`.

## 5. Pass Architecture

The pre-pass has 3 stages, but declaration placement should be fused into Stage A to avoid an extra full AST traversal.

### Stage A: Annotate + Analyze (+ inline declaration placement) (top-down traversal)

For each node:
1. Allocate `node._analysis`.
2. Set `parent`.
3. Set `createScope` / `scopeBoundary` from node kind.
4. Call node-specific `analyzeXxx(node, state)` to fill local metadata:
   - `declaresLocal`
   - `usesLocal`
   - `mutatesLocal`
   - optional precomputed facts reused later by compiler emit.
5. Place declarations immediately during the same traversal:
   - for each declaration intent, resolve nearest `createScope` owner through `parent`.
   - update owner `declaredOutputs` map in-place.

Constraint:
- `analyzeXxx` may mutate current node `_analysis` and declaration-owner maps resolved through traversal state.

### Stage B: Declaration Placement (optional standalone fallback)

Preferred approach: Stage B is folded into Stage A.

Keep a separate Stage B implementation only as a temporary debug/parity fallback if needed:
1. For each `(name, decl)` in `node._analysis.declaresLocal`:
   - find nearest ancestor analysis with `createScope === true`.
   - write into that owner `declaredOutputs` map.
2. Detect and handle declaration conflicts with existing current behavior parity.

### Stage C: Usage/Mutation Aggregation (bottom-up or owner-routed)

Goal: produce final `usedOutputs` and `mutatedOutputs` for scope owners/frames used by emission.

Rule:
1. For each local `usesLocal`/`mutatesLocal`, route into the intended metadata owner (normally nearest current frame owner).
2. Preserve existing propagation behavior used by async block metadata, include linking, and guard analysis.

Result:
- Emit phase consumes precomputed sets instead of calling metadata registration ad hoc.

## 6. API and Naming

Use the compiler as host for node analyzers:
- `analyzeRoot`
- `analyzeSet`
- `analyzeOutputDeclaration`
- `analyzeMacro`
- `analyzeFunCall`
- etc.

Shared helpers should use `register` naming when mutating metadata:
- `registerOutputDeclaration(...)`
- `registerOutputUsage(...)`
- `registerOutputMutation(...)`
- `registerSequentialLockUsage(...)`

Prefer this split:
- classify helper (pure): compute canonical names and access mode.
- register helper (side effect): write into `_analysis`.

Also:
- analyzers should write reusable compile-time facts into `_analysis` so compile paths do not reclassify or re-resolve the same data.

## 7. Node Coverage Requirements (Full Rollout)

Must be fully covered before switching compile to rely on pass output:

1. Declarations
- `OutputDeclaration`
- `Set` / `CallAssign` declaration forms
- `Macro` declaration
- macro args / kwargs / caller bindings
- import/from-import bindings
- loop vars + loop metadata
- sequence lock declarations

2. Usage-only
- symbol/lookup reads
- observation ops (`snapshot`, `is error`, `#`, checkpoints)
- sequence read paths
- waited-output bookkeeping if it contributes to used metadata

3. Usage + mutation
- output commands (non-observation)
- sequence calls and repairs (`!` and `!!`)
- async output emission paths
- macro binding init writes

4. Control-flow-sensitive sites
- guard, include, block/inheritance prelink inputs
- async block metadata emission (`usedOutputs`)

## 8. Compiler Integration Plan

### Step 1: Introduce analysis runner

Add compiler entry:
- `runOutputAnalysisPass(ast, rootFrame, options)`

It performs Stage A (with inline declaration placement) and Stage C, and stores final metadata on node/frame owners.

### Step 2: Dual-write transition (short-lived)

Temporarily keep existing runtime registrations while verifying pass parity:
- emit-time path still registers
- pass computes in parallel
- add assertions in debug mode to compare sets

### Step 3: Switch consumers to pass output

Replace emit-time metadata writes with reads:
- async block args from analyzed owner metadata
- guard metadata from analyzed block node metadata
- include/prelink candidate collection from analyzed metadata

### Step 4: Remove old bookkeeping calls

Delete/retire:
- ad hoc `registerOutputUsage`/`registerOutputMutation` calls in compile paths
- duplicated declaration bookkeeping where now provided by pass

### Step 5: Alias computation migration (future step)

Current rollout assumption:
- aliased output names are still computed before/around analysis where needed.

Planned follow-up:
1. Move alias-name computation to run after analysis metadata is populated.
2. Make alias computation consume `_analysis` data as the primary input.
3. Remove duplicate alias-scanning logic from compile paths.
4. Keep resolver rules in one place for higher robustness and simpler maintenance.

## 9. Guard-Specific Requirements

Guard must consume pre-pass metadata only:
- guarded declaration set from selector + boundary logic
- mutated/used intersections from analyzed block metadata
- no compile-body side-channel registration dependency

This removes the fragile "compile first to discover metadata" dependency.

## 10. Data Structures and Performance

1. Use `Map` for declarations; `Set` for `uses`/`mutates`.
2. Canonicalize names once (especially sequence keys and aliases) for this rollout.
3. Avoid repeated ancestor scans by caching nearest scope owner when possible.
4. Keep analysis allocation lightweight; no deep cloning of node metadata.

## 11. Invariants

After pass completion:

1. Every relevant node has `_analysis`.
2. Every declaration is placed in exactly one `createScope` owner map.
3. Every emitted async block owner has final `usedOutputs` set.
4. Every mutating node contributes to owner `mutatedOutputs`.
5. Compile paths use `_analysis` whenever equivalent data is available.

## 12. Edge Cases to Preserve

1. Aliased output names (`x#N`) and boundary remapping.
2. Imported/included composition where parent-child linkage depends on exact handler names.
3. Inheritance/super/block behavior with boundary restrictions.
4. Macro/caller bindings and nested macro scopes.
5. Sequence lock paths and repair operations.

## 13. Validation Strategy

1. Parity assertions during dual-write phase:
- compare pass sets vs legacy sets for:
  - `declaredOutputs`
  - `usedOutputs`
  - `mutatedOutputs`

2. Focus suites:
- `tests/poison/guard.js`
- async composition/inheritance tests
- macro and script-output tests
- sequence operation tests

3. Full sweep:
- `npm run test:quick`

## 14. Rollout Checklist

1. Add `_analysis` schema + traversal scaffolding.
2. Implement all `analyzeXxx` methods for declaration/use/mutation nodes.
3. Implement inline declaration placement in Stage A.
4. Implement usage/mutation aggregation resolver.
5. Add analyzer-computed facts needed by compile and switch compile paths to consume them.
6. Wire compiler consumers to analyzed metadata.
7. Remove legacy metadata writes from compile emission paths.
8. Run full test suite and remove parity asserts after stabilization.
9. Follow-up: migrate alias computation to post-analysis phase using `_analysis` data.

## 15. Simplifications Enabled After Completion

1. Remove duplicated metadata registration logic in compile emission code.
2. Eliminate guard metadata dependency on body compile side effects.
3. Centralize scope/declaration behavior in one deterministic resolver.
4. Make later transformer migration straightforward (analyzers already isolate metadata logic).
5. Reduce compile-time branching by reusing analyzer facts from `_analysis`.

## 16. Suggested Implementation Order

1. Build scaffolding and no-op analyzers.
2. Implement declarations first (prefer inline placement in Stage A).
3. Implement usage-only nodes.
4. Implement mutation nodes.
5. Add reusable `_analysis` facts and switch compile paths to consume them.
6. Enable dual-write parity checks.
7. Switch consumers.
8. Remove legacy writes.
9. Follow-up: migrate alias computation to post-analysis phase using `_analysis` data.

This order minimizes risk while still delivering full-node migration in one cohesive rollout.
