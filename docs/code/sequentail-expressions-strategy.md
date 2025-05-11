**Expression-Level Sequence Lock Handling Strategy**

This strategy determines which parts of an expression require "async block wrappers" for `!` sequence marker handling. It uses a bottom-up pass. Each node calculates its "Sequenced Operations List."

**1. Initial Node Analysis (Pre-Pass / AST Decoration):**
*   **For every node in the expression:**
    *   If it's a `FunCall` with a `!` path: Store its key on `node.sequenceLockKey`.
    *   If it's a `Symbol`/`LookupVal` on an already declared `!` lock path: Store its key on `node.sequencePathKey`.

**2. Bottom-Up sequenceOperations list Calculation & Wrapper Decision (Main Recursive Pass):**
*   **When processing a parent node (after its children are processed):**
    1.  **Build Parent's sequenceOperations list:**
        *   Start with an empty list.
        *   For each child (in execution order, usually the one in node.fields), append all `(key, type, count)` tuples from the child's sequenceOperations list.
        *   If the parent node has `node.sequenceLockKey` or `node.sequencePathKey`, convert to `(key, type, count=1)` and append to the list in execution order.
        *   **Resolve Duplicates & Aggregate Counts in this list:**
            *   Iterate through the list to produce a new, condensed list.
            *   If multiple entries exist for the *same `key`*:
                *   For `lock` types: Keep the one that appeared *first* in the original list; sum the `counts` of all `lock` types for this `key`.
                *   For `path` types: Keep the one that appeared *last* in the original list; sum the `counts` of all `path` types for this `key`.
            *   The result is the parent's final sequenceOperations list `[(key, type, aggregatedCount), ...]`, stored on the parent. This list maintains the relative order of unique `(key,type)` pairs, with specific rules for choosing representative when only type differs for same key.
    2.  **Determine if Parent Becomes an Async Block Wrapper:**
        *   The parent node sets `parent.isWrapper = true` if **both** conditions below are met based on its sequenceOperations list:
            *   **(a) No Lock-Path Conflict:** No `(K, lock, ...)` entry is followed by a `(K, path, ...)` entry for the *same key `K`*.
            *   **(b) Single Distinct Lock Usage Per Key:** For every `(K, lock, aggregatedCountL)` entry, `aggregatedCountL` must be `1`. (This `aggregatedCountL` is the sum from step 2.1.e, representing distinct underlying lock operations for key `K` within the parent's scope).
        *   If the conditions are met and `parent.isWrapper` is set to `true`:
            *   **Subsume Descendant Wrappers:** Traverse down from this parent. If any descendant node `D` has `D.isWrapper = true` (set in its own processing), now set `D.isWrapper = false`. Stop downward traversal for a branch once a `D.isWrapper` is set to false.
        *   If the conditions are *not* met, `parent.isWrapper` remains `false` (or is explicitly set to `false` if it might have been true from a previous consideration).

**3. Code Generation:**

*   If a node has `isWrapper = true` after the entire pass, compile it with an `async IIFE`.
*   All sequenced operations use runtime helpers (e.g., `sequencedCallWrap`) for global lock interactions.