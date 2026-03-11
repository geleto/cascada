# Analysis Migration - Next Steps

This is the execution plan after the current analysis pre-pass + parity-validation integration.

## 1) Expand parity verification coverage

Goal: catch drift between analysis and compile before removing remaining legacy assumptions.

Scope:
- `compileSymbol`
- `compileSet` / `compileAsyncVarSet`
- `compileOutputCommand`
- guard/recover/revert compile paths
- include/block/inheritance metadata consumers

Rules:
- For source AST nodes in async mode: analysis is mandatory.
- Any mismatch must fail fast (no masking fallback).

## 2) Remove generic `hasAnalysis` branching for source AST

Goal: enforce analysis as the single source of truth for async compilation.

Approach:
- Keep fallback only for explicitly internal/compiler-generated nodes.
- Replace implicit `hasAnalysis` guards with explicit internal-node checks where needed.
- Keep parity checks enabled to prevent regression.

Methods/branches targeted for removal when non-analysis async fallback is dropped:
- `compileIs`: remove `hasAnalysis ? ... : _getObservedOutputName(...)` branch.
- `compilePeekError`: remove `hasAnalysis ? ... : _getObservedOutputName(...)` branch.
- `compileLookupVal`: remove `analysisLookup vs compileLookup` branch selection.
- `compileFunCall`: remove `analysisCallFacts vs compileCallFacts` branch selection.
- `_getObservedOutputName(...)`: remove after `compileIs`/`compilePeekError` become analysis-only.

Methods expected to remain:
- `_compileSpecialOutputFunCallFromFacts(...)` stays as the async emission helper for special output calls.
  Input facts become analysis-only (no non-analysis fallback selection).

Post-cleanup simplification:
- Once analysis-only flow is stable, inline/remove transitional helper wrappers where they no longer add value
  (for example small delegators used only to bridge fallback-era behavior).
- Keep only helpers that materially improve readability of the primary analysis-driven path.

## 3) Move compiler-generated synthetic nodes to transformer

Goal: eliminate compile-time node creation that bypasses analysis.

Why:
- Synthetic nodes created during compile do not go through the analysis pre-pass.
- This forces dual paths and weakens guarantees.

Plan:
1. Inventory compiler-generated node creation sites (especially in guard lowering and special expression lowering).
2. Move synthetic-node construction to transformer stage where possible.
3. Ensure these nodes are present in final transformed AST before analysis runs.
4. Add/analyze corresponding `analyzeXxx` coverage.
5. Delete compile-time synthetic-node fallbacks once parity is stable.

Expected result:
- All async-relevant nodes have `_analysis`.
- Compiler paths can be analysis-only for source + transformed nodes.
- Non-analysis async compile paths are removed.

## 4) Unify metadata ownership in analysis pass

Goal: keep declaration/use/mutation ownership logic entirely in `compile-analysis.js`.

Work:
- Continue moving analysis-only helpers out of compiler files.
- Keep compiler-side helpers only when they require frame/runtime compile context.

## 5) Alias-name computation follow-up

Goal: compute alias names from analysis metadata instead of ad-hoc compile scans.

Steps:
1. Use `_analysis` declarations/usage as primary input.
2. Move alias computation after analysis pass.
3. Remove duplicate alias-detection logic from compile paths.

## 6) Cleanup and hardening

After steps 1-5:
- Remove obsolete fallback branches and dead helper methods.
- Keep `VERIFY_ANALYSIS_PARITY` enabled in CI/dev.
- Re-evaluate whether to keep it enabled by default in production.

## 7) Validation gates for each milestone

Run after each major step:
1. `npm run test:quick`
2. Focused suites:
   - `tests/poison/guard.js`
   - `tests/explicit-outputs.js`
   - sequence/poison strictness suites

Acceptance criteria:
- No regressions.
- No parity mismatches for source/transformed async AST nodes.
- Fallback usage limited to explicitly marked internal nodes during transition, then removed.
- Final invariant: async compilation fails if `_analysis` is missing on any relevant node.
