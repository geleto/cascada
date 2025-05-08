Here are descriptions for integration tests for expressions with sequential execution:

**Integration Test Descriptions for Sequential Execution in Expressions:**

1.  **Simple Contention (Same Operator, Same Key):**
    *   `{{ data.item!.op() + data.item!.op2() }}`
    *   Verify `op()` and `op2()` (or the shared `data.item!` part) are sequenced correctly relative to each other if `data.item!` is the contended lock.

2.  **Nested Contention (Different Operators, Same Key):**
    *   `{{ (data.item!.op() + data.item!.op2()) * data.item!.op3() }}`
    *   Ensure all three operations on `data.item!` are correctly sequenced.

3.  **Contention with Path Access (Same Key):**
    *   `{{ data.item!.prop + data.item!.op() }}`
    *   Verify access to `prop` and call to `op()` on `data.item!` are sequenced.

4.  **Distinct Keys (No Contention in Expression):**
    *   `{{ data.itemA!.op() + data.itemB!.op() }}`
    *   Verify operations on `itemA!` and `itemB!` can run in parallel (no unintended sequencing between them).

5.  **Shared Prefix, Distinct Suffix Keys (No Contention for full key):**
    *   `{{ data.obj.itemA!.op() + data.obj.itemB!.op() }}`
    *   Ensure `itemA!.op()` and `itemB!.op()` are treated as independent sequences.

6.  **Shortest Key Coverage (Implicit):**
    *   `{{ data.obj!.prop1.opA() + data.obj!.prop2.opB() }}`
    *   If `data.obj!` is contended, verify its wrapper covers both `opA` and `opB` calls, implying they are sequenced relative to the `data.obj!` lock but might still allow `opA` and `opB` to proceed if their *own full paths* aren't directly contended. (This tests the "wrap shortest" strategy's effect).

7.  **Mixed Sequenced and Non-Sequenced Operations:**
    *   `{{ data.item!.op() + data.other.nonSequencedOp() }}`
    *   Ensure `data.item!.op()` is handled by sequencing logic, while `nonSequencedOp()` runs normally.

8.  **Contention Deep in One Operand:**
    *   `{{ (data.item!.opA() + data.item!.opB()) + data.unrelated.opC() }}`
    *   Verify `opA` and `opB` are sequenced with each other, and this group is independent of `opC`.

9.  **No `!` Marker (Baseline):**
    *   `{{ data.item.op() + data.item.op2() }}`
    *   Verify no sequence-specific wrappers are generated; relies on standard async parallelism.

10. **Sequenced Path, Non-Sequenced Method:**
    *   `{{ obj.path!.method() + obj.path!.otherMethod() }}`
    *   Tests sequencing of `obj.path!` lookups. `method` and `otherMethod` calls occur on the resolved (and unlocked) `path`.

11. **Non-Sequenced Path, Sequenced Method:**
    *   `{{ obj.path.method!() + obj.path.method!() }}`
    *   Tests that the two calls to `method!` are sequenced under the `!obj!path!method` key.

12. **Contention on Template Variable Path (Should Be Ignored):**
    *   `{% set x = data.item %}{{ x!.op1() + x!.op2() }}`
    *   Verify no sequence wrappers are generated because `x` is a template variable.

13. **Dynamic Path Segments with `!` (Error or Ignored):**
    *   `{{ data[myKey]!.op() }}` (where `myKey` is a variable)
    *   Verify this either triggers a compile-time error or is ignored by the sequencing mechanism (as `!` requires static paths).

14. **Multiple `!` in one path segment (Error or Ignored):**
    *   `{{ data.item!!op() }}`
    *   Verify compile-time error or that the extra `!` is ignored/handled as per rules.

These tests aim to cover various combinations of key contention, path structures, and `!` marker placements within expressions. Each test would involve inspecting the generated JavaScript for the presence/absence of `_emitAsyncBlockValue` (or similar) around the expected expression parts, and checking the sequence keys used.


The previous list was a good starting point, but to thoroughly test the robustness of the "shortest key first + terminate on already wrapped" strategy and address the potential issues we discussed, we need more specific tests targeting those complexities.

Here are additional integration test descriptions focusing on hierarchical locking, complex termination conditions, and potential edge cases:

**Integration Test Descriptions (Advanced & Edge Cases):**

15. **Contention for Both Prefix and Specific Path:**
    *   Template: `{{ data.obj!.prop1.opA() + data.obj!.prop2.opB() + data.obj!.commonOp() }}` (Assume `!data!obj` is the primary contended key due to `commonOp` also existing elsewhere with `data.obj!`).
    *   Goal: Verify that a single wrapper for `!data!obj` is generated (due to "shortest key first"), and this wrapper correctly serializes all three operations. Test if `_asyncWrap` for `!data!obj!prop1!opA` (if it were a key) terminates correctly due to `!data!obj` being wrapped.

16. **Explicit Specific Path Contention Despite Shorter Prefix:**
    *   Template: `{{ data.obj.item!.opX() + data.obj.item!.opY() }}` (Here, `!data!obj!item` is the contended key. Assume `!data!obj` is *not* contended elsewhere in this expression).
    *   Goal: Verify a wrapper is generated specifically for `!data!obj!item` (or the node representing `data.obj.item!`), and not prematurely for `!data!obj`. This tests if the "shortest key" applies only to *contended* keys.

17. **Overlapping Wrappers (Different Keys, Shared AST Node):**
    *   Template: Consider `{% set d = data %}{{ (d.itemA!.op1() + d.itemB!.op2()) + d.itemA!.op3() }}`.
        *   `!d!itemA` is contended between first and third part.
        *   `!d!itemB` is used once.
    *   Goal: Verify `d.itemA!` parts are sequenced. `d.itemB!` is independent. Check if `_asyncWrap` for `!d!itemA` correctly marks relevant nodes, and `_asyncWrap` for `!d!itemB` (if it were contended) wouldn't interfere or be wrongly terminated.

18. **Deeply Nested Path with Intermediate `wrapInAsyncBlock`:**
    *   Template: `{{ root.mid!.leafA.op1() + root.mid!.leafB.op2() }}` (Assume `!root!mid` is the shortest contended key).
    *   Goal: `root.mid!` node gets `wrapInAsyncBlock=true`. Verify that subsequent compilation of `.leafA.op1()` and `.leafB.op2()` effectively occurs "under" this lock (tests the critical compiler generation aspect).

19. **Sibling Operators with Different Contention Levels:**
    *   Template: `{{ (data.A!.x + data.A!.y) * (data.B!.z + data.C!.w) }}`
        *   `!data!A` is contended in the left operand of `*`.
        *   `!data!B` and `!data!C` are not contended with each other in the right operand.
    *   Goal: Verify wrapper for `!data!A` is generated for the `(data.A!.x + data.A!.y)` part. The right part `(data.B!.z + data.C!.w)` should not be affected by `!data!A`'s wrapping.

20. **`_asyncWrapKey` Termination Test - Exact Key Match:**
    *   Template: `{{ lib.obj!.op() + lib.obj!.op() }}` (Second `lib.obj!.op()` is redundant but tests logic).
    *   Goal: The first `lib.obj!` (or its call) gets wrapped. When `_asyncWrapKey` is called for the second instance, it should find the *first* instance's node already marked `wrapInAsyncBlock=true` and terminate for that second instance without re-marking.

21. **`_asyncWrapKey` Termination Test - Prefix Key Already Wrapped:**
    *   Template: `{{ lib.obj!.sub.opX() + lib.obj!.sub.opY() }}`
        *   Assume `!lib!obj` is the shortest contended key and `lib.obj!` node gets `wrapInAsyncBlock=true`.
    *   Goal: When `_determineExpressionAsyncBlocks` later considers contention for a hypothetical `!lib!obj!sub` (if it were directly counted and contended), the `_asyncWrapKey` search for `!lib!obj!sub` should encounter the already-wrapped `lib.obj!` node and terminate, assuming `!lib!obj`'s wrapper covers `!lib!obj!sub`. (This directly tests the core of the "no `pathFlagsInfo`" strategy).

22. **No Contention, but Path has `!` (Single Use):**
    *   Template: `{{ data.item!.op() + data.unrelated.op() }}`
    *   Goal: `data.item!.op()` should still get its own sequence wrapper (for `!data!item!op` or `!data!item` depending on `!` placement) because `!` implies it *must* be sequenced, even if not contended *within this expression*. The `writeIntent` registration (Step 1 of original plan) should ensure this. Step 9 would see its count as 1, so it wouldn't act due to *contention*, but the node *itself* is a sequence operation. (This test clarifies if Step 9 *only* acts on contention, or if a single `!` also forces a wrap via another mechanism).
    *   *Self-correction:* Step 9 as designed *only* acts on count > 1. The wrapping for single `!` uses (like `{{ obj!.method() }}`) is handled by the logic in `compileFunCall` / `compileLookupVal` checking `node.sequenceLockKey` or `node.sequencePathKey` and `!(pathFlags & ...)` *without* relying on `node.wrapInAsyncBlock` set by Step 9. Step 9 is *only* for resolving contention *within* an expression. This test would verify that Step 9 *doesn't* interfere with the standard wrapping of single `!` uses.

23. **Complex Expression with Multiple, Intertwined Locks:**
    *   Template: `{{ (A!.x + B!.y + A!.z) * (B!.p + C!.q + B!.r) }}`
    *   Goal: This is a stress test. Verify that wrappers are correctly placed for `!A` (around `A!.x`, `A!.z`) and `!B` (around `B!.y`, `B!.p`, `B!.r`) and `!C` (around `C!.q`), and that they interact correctly according to the "shortest key first" and termination rules.

24. **Function Call Whose *Target* is a Sequenced Path:**
    *   Template: `{{ (obj.path!.getHandler())() + (obj.path!.getAnotherHandler())() }}`. Here `obj.path!` retrieval is sequenced. The returned functions are then called.
    *   Goal: Verify the lookups for `obj.path!` are sequenced. The actual function calls `()` happen on the (unlocked) results. This distinguishes from `obj.path.handler!()`.

These more nuanced tests will be crucial for validating the sophisticated interactions your proposed Step 9 (`_determineExpressionAsyncBlocks` and `_asyncWrapKey` with its termination logic) aims to handle. They directly probe the conditions where the "shortest key wrapper covers longer paths" assumption would be most stressed.

**Overall Strategy Review:**

The core strategy relies on:
1.  **Step 1 (Original):** Compiler registers "write intent" for `!` marked static context paths (`_updateFrameWrites`), leading to runtime lock promise creation.
2.  **Steps 2-7 (Original):** Runtime awaits these lock promises (`awaitSequenceLock`, `sequencedMemberLookupAsync`, etc.) before proceeding with operations on those paths. `frame.set` on the lock key releases the lock. This handles individual `!` operations.
3.  **Step 8 (New):** `_processExpressionSequenceKeysAndPaths` analyzes expressions, decorates AST nodes with their specific sequence keys, and aggregates key usage counts onto expression nodes.
4.  **Step 9 (New):** `_determineExpressionAsyncBlocks` uses counts from Step 8. If a key `K` is contended among an operator's children, it calls `_asyncWrapKey` for each implicated child. `_asyncWrapKey` (respecting "shortest key first" via sorted processing in its caller, and terminating if an AST ancestor in its search path is already `wrapInAsyncBlock=true`) sets `N.wrapInAsyncBlock=true` on the highest node `N` within the child's subtree responsible for key `K`.
5.  **Compilation (Future - Step 3 of original plan):** `compileSymbol/LookupVal/FunCall` will see `node.wrapInAsyncBlock`. If true, they generate an IIFE that acquires/releases the node's specific sequence key. They *also* need to respect `pathFlagsInfo` from their caller (e.g., `_compileExpression`) to avoid emitting this IIFE if an even higher-level compiler function (like `compileOutput`) already created a wrapper for that key.

**Analysis of Potential Missing Cases / Considerations:**

**A. Interactions Between Expression-Level Wrappers (Step 9) and Statement-Level Wrappers (Original Plan):**

1.  **Double Wrapping Prevention:**
    *   **Scenario:** `{{ data.item!.op() }}`.
        *   Original plan: `compileOutput` calls `compileFunCall`. `compileFunCall` sees `data.item!.op()`, gets `sequenceLockKey`, and wraps it in an IIFE (let's call this `IIFE_Outer`).
        *   New plan: `_compileExpression` calls `_processExpressionSequenceKeysAndPaths` and `_determineExpressionAsyncBlocks`. For `data.item!.op()`, `sequenceLockKeyCounts` would be `{ "!data!item!op": 1 }`. Step 9 *as currently designed* (acting on `count > 1`) would *not* set `wrapInAsyncBlock`. This is GOOD. The original plan handles it.
    *   **Scenario:** `{{ data.item!.op() + data.item!.op2() }}`.
        *   Original plan: `compileOutput` calls `_compileExpression`.
        *   New plan (Step 8): `Add` node gets `sequenceLockKeyCounts = { K1:1, K2:1 }` if `K1=!data!item!op`, `K2=!data!item!op2`. Or, if `!` is on `item`, then `sequencePathCounts = {"!data!item": 2}`.
        *   New plan (Step 9): If `"!data!item"` has count 2, `_asyncWrapKey` might set `item_node.wrapInAsyncBlock=true`.
        *   **Question:** When `compileLookupVal(item_node)` is called (by `_compileExpression` via `compileFunCall`), it sees `wrapInAsyncBlock=true`. It emits `IIFE_Inner`. Does the `_compileExpression` itself also get wrapped by `compileOutput` because the whole expression contains `!`?
        *   **Missing Logic/Clarity:** The interaction between `pathFlags` (used by `compileOutput` to signal to `_compileExpression` that a wrapper is already being made) and `wrapInAsyncBlock` needs to be crystal clear. If `compileOutput` already wraps the whole `{{ ... }}` because it contains `!`, then `_compileExpression` should receive `pathFlags` indicating this, and `compileSymbol/LookupVal/FunCall` should *not* create another IIFE even if `wrapInAsyncBlock` is true. `wrapInAsyncBlock` is for *intra-expression* contention.
    *   **Test Case Needed:** A test where `compileOutput` would naturally wrap (e.g., `{{ A! + B! }}` where `A!` implies a write intent making the whole output async) and *also* `A!` and `B!` cause internal `wrapInAsyncBlock=true`. Verify only one layer of effective wrapping per key.

**B. `_asyncWrapKey` Termination and "Covering Key" Logic:**

1.  **Precise Termination of `_asyncWrapKey`:**
    *   The current termination is: "if `currentNode` (in `_asyncWrapKey`) or an AST ancestor (on the path from the initial `targetNode` of `_asyncWrapKey` down to `currentNode`) is already `wrapInAsyncBlock = true`, then terminate."
    *   **Scenario:** `(A!.x * B!.y) + A!.z`. `!A` is contended. `_asyncWrapKey` for `!A` called on `(A!.x * B!.y)`. It descends. Let's say `A!.x` is processed, and `A_node` (for `A!`) gets `wrapInAsyncBlock=true`. Then `_asyncWrapKey` for `!A` continues to `B!.y`. The `A_node` is *not* an ancestor of `B_node`. This is fine.
    *   **Refinement:** The termination "if an AST ancestor...is already `wrapInAsyncBlock=true`" should be: if `_asyncWrapKey(N, K)` is called, and `N` itself has `wrapInAsyncBlock=true`, then return. If searching for node `N_k` (which owns key `K`) under `N`, and an intermediate node `M` (between `N` and `N_k`) has `wrapInAsyncBlock=true`, then also terminate. This means the wrapper at `M` is assumed to cover `K`.
    *   **This assumption is the core of the "no pathFlagsInfo in Step 9" strategy.**
    *   **Test Case Needed (related to Test 21):** `{{ root.mid1!.subA.leafX() + root.mid1!.subB.leafY() + root.mid2!.subC.leafZ() }}`.
        *   Assume `!root!mid1` is shortest contended. `mid1_node` gets wrapped.
        *   `_asyncWrapKey` for `!root!mid1!subA` (if it were also contended) should terminate at `mid1_node`.
        *   `_asyncWrapKey` for `!root!mid2` (if contended) should operate independently.

**C. Compiler Code Generation (Deferred, but informs Step 9's utility):**

1.  **Making "Shorter Key Wrapper" Effective:**
    *   If `obj_node` is wrapped for `!obj` due to `obj!.propA + obj!.propB`.
    *   The IIFE for `obj_node` must have `writeCounters` including `!obj`, `!obj!propA` (if `propA` is `propA!`), and `!obj!propB` (if `propB` is `propB!`).
    *   The `finally` block of this IIFE must correctly call `frame.set` (or `skipBranchWrites`) for *all* these keys based on whether the operations for `propA` and `propB` actually occurred within its scope.
    *   This is complex. It requires the compiler, when generating the IIFE for `obj_node`, to know about `propA` and `propB` operations.
    *   **Alternative:** Each distinct `!` (e.g., `obj!`, `propA!`, `propB!`) has its *own* `writeIntent` (Step 1 original) and thus its own independent lock promise. If `obj_node` gets `wrapInAsyncBlock=true` for `!obj`, its IIFE handles `!obj`. If `propA_node` (for `propA!`) also gets `wrapInAsyncBlock=true` for `!obj!propA`, it gets its own IIFE. This is simpler and aligns with distinct lock keys. The "shortest key wrap covers all" is only for *preventing Step 9 from setting deeper `wrapInAsyncBlock` flags*, not necessarily for one IIFE managing multiple distinct lock keys' full lifecycles unless explicitly designed.
    *   **This distinction is critical.** If the "hierarchical release" is not as comprehensive as initially implied, then the termination logic in `_asyncWrapKey` (stopping if an ancestor is wrapped) might be *too aggressive* if that ancestor was wrapped for a different, albeit prefix, key.

**D. Single `!` Uses (Not Involving Intra-Expression Contention):**

1.  **Test 22 Revisit:** `{{ data.item!.op() + data.unrelated.op() }}`.
    *   Step 8: `data.item!.op()` gets `sequenceLockKey=K_item_op`. `Add_node.sequenceLockKeyCounts = { K_item_op: 1 }`.
    *   Step 9: `K_item_op` count is 1. No action from Step 9's contention logic. `data.item!.op()` has no `wrapInAsyncBlock` set *by Step 9*.
    *   Compile phase: `compileFunCall(data.item!.op())`. It sees `sequenceLockKey=K_item_op`. It also receives `pathFlags` from `_compileExpression`. If `pathFlags` don't indicate an outer wrapper is already handling `K_item_op`, then `compileFunCall` *itself* emits the IIFE.
    *   **This seems correct.** Step 9 is *only* for resolving intra-expression contention by adding `wrapInAsyncBlock` flags. Standard single `!` uses are handled by the original plan's mechanisms, augmented by `pathFlags` to avoid double wraps if `compileOutput` (or similar) already wrapped.

**E. Details of `_asyncWrapKey` and Key Responsibility:**

1.  **Finding the "Responsible Node":**
    *   `_asyncWrapKey(C, K)` searches downwards from child `C`. It should mark the *first* node `N` it encounters where `N.sequencePathKey == K` or `N.sequenceLockKey == K`.
    *   **Test Case Needed:** `{{ (A.B.C! + A.B.D!) }}`. Key is `!A!B!C` or `!A!B!D`. If `!A!B` is the contended key identified by Step 9 (e.g. due to `A.B!.foo + A.B!.bar`), `_asyncWrapKey` called on `(A.B.C!)` with key `!A!B` should mark the `LookupVal` node for `B`.

**F. Scope Variable Paths:**

1.  **Test 12 Confirmation:** `{% set x = data.item %}{{ x!.op1() + x!.op2() }}`.
    *   Step 8 (`_processExpressionSequenceKeysAndPaths`): When `_extractStaticPathKey` or `_getSequenceKey` is called for `x!...`, they should correctly identify `x` as a scope variable (via `_isDeclared(frame, "x")`). Thus, no `sequencePathKey` or `sequenceLockKey` should be stored on these nodes, and no counts generated for them.
    *   Step 9 will therefore see no relevant keys/counts and do nothing.
    *   The compiler (e.g., `compileFunCall`) will also see no sequence keys and compile normally.
    *   **This seems robust.** The check `!this._isDeclared(frame, rootVarName)` in Step 8 is vital.

**Summary of Missing/Key Areas for Tests or Clarification:**

1.  **Test interaction of `compileOutput`-level wrapping with Step 9 `wrapInAsyncBlock` flags.** (Preventing true double IIFEs for the same key). This tests how `pathFlags` passed into `_compileExpression` will interact with `compileSymbol/LookupVal/FunCall`'s decision to use `node.wrapInAsyncBlock`.
2.  **Test the precise `_asyncWrapKey` termination logic.** Specifically, when it encounters an ancestor `Anc.wrapInAsyncBlock=true`:
    *   Does it terminate only if `Anc` was wrapped for a *prefix* of the current `keyToWrap`?
    *   Or does it terminate if `Anc` was wrapped for *any* key? (The latter is simpler but might be too broad if `Anc`'s key is unrelated). Your current proposal seems to be "terminate if `Anc.wrapInAsyncBlock` is true, period", relying on "shortest key first" to have set that flag for a relevant covering key.
3.  **Test the compiler code generation for a node `N` where `N.wrapInAsyncBlock=true` due to a "shorter/covering" key `K_short`.**
    *   Specifically, how does the `finally` block of the IIFE for `K_short` handle `writeCounter` decrements for more specific operations/keys (e.g., `K_long`) that occur lexically "after" `N` in the expression but are logically part of the path covered by `K_short`? (This is the "hierarchical release" crux).
    *   This is less about Step 9 itself and more about the viability of its output for the later compilation phase. If this code generation is very hard, Step 9's "covering" assumption is weakened.

The current set of tests (1-24) is quite good. Adding specific tests for point 1 above (interaction of `compileOutput` wrapping with Step 9) would be beneficial. Tests 15, 21, and 23 touch upon point 2 and 3, but dedicated, minimal tests for `_asyncWrapKey`'s termination under various "already wrapped ancestor" conditions (different keys, prefix keys) would be valuable unit/integration tests for that helper itself.

The core assumption remains: if `Node_Short` is wrapped for `Key_Short`, and `Key_Short` is a prefix of `Key_Long` (which would be on `Node_Long`, a descendant of `Node_Short`), then the IIFE for `Node_Short` handles everything, and `Node_Long` doesn't need its own IIFE for `Key_Long`. This implies the `writeCounters` for `Key_Long` are correctly managed by `Node_Short`'s IIFE. This needs to be true at runtime for the strategy to be sound.