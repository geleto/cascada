**Expression-Level Sequence Lock Handling Strategy**

This strategy identifies parts of an expression needing "async block wrappers" for `!` sequence markers. It uses a recursive analysis to build a `sequenceOperations` map on each node, tracking its role in sequenced operations.

**1. Initial Node Decoration:**
*   **AST Decoration:** Early in the analysis (`_assignAsyncBlockWrappers`):
    *   `FunCall` nodes with a `!` path are noted as having a `sequenceLockKey`.
    *   `Symbol`/`LookupVal` nodes on a declared `!` lock path are noted as having a `sequencePathKey`.

**2. Recursive Sequence Operation Analysis & Wrapper Assignment (`_assignAsyncBlockWrappers`, `_asyncWrapKey`, `_pushAsyncWrapDownTree`):**

This combined recursive process analyzes each expression node to:
    1.  Aggregate sequence operation info from children.
    2.  Decide if the node itself needs an "async block wrapper" due to sequence key contention.
    3.  Optimize wrapper placement by pushing it to specific children if applicable.

*   **Core Recursive Function (`_assignAsyncBlockWrappers(node, frame)`):**
    *   **Initialization:**
        *   Creates `node.sequenceOperations` map.
        *   Each key is classified as `PATH` or `LOCK`.
        *   If `node` itself is a `Symbol`/`LookupVal` with `node.sequencePathKey`, adds `(key, PATH)` to its map.
        *   If `node` itself is a `FunCall` with `node.sequenceLockKey`, adds `(key, LOCK)` to its map.
    *   **Recursive Call & Aggregation:**
        *   Calls `_assignAsyncBlockWrappers` for all children.
        *   Merges children's `sequenceOperations` into `node.sequenceOperations`, removing duplicate keys:
            *   If a contention occurs (e.g., LOCK + PATH, or multiple LOCKs for the same key), the `key` is marked as `CONTENDED` in the `node.sequenceOperations` map.
            *   Otherwise, there is no contention and the key is added to the map with its type - PATH(can merge multiple PATHs) or LOCK(there can be only one LOCK for a key without contention).
    *   **Contention-Driven Wrapper Assignment (`_asyncWrapKey`):**
        *   If `node.sequenceOperations` contains a `(key, CONTENDED)` entry:
            *   For each child involved with this `key`, call `_asyncWrapKey(child, key)`.
            *   `_asyncWrapKey` descends recursively. If it reaches a node where the key is *not* `CONTENDED` - it sets `node.wrapInAsyncBlock = true`.
            *   Do a cleanup deleting the `node.sequenceOperations` map as it is no longer needed.
    *   **Continue the reursion of `_asyncWrapKey`** for each child node unless there are no contended keys in it

*   **Wrapper Optimization (`_pushAsyncWrapDownTree(node)`):**
    *   **Purpose:** `_assignAsyncBlockWrappers` assigned the wrappers as early as possible at the first uncontented node. This function moves the wrapper down for as long as there is only one child with [all the] keys.
    *   **Process:**
        *   This optimization is applied recursively, starting from the leaves of the expression tree and moving upwards.
        *   If a `node` has been marked to `wrapInAsyncBlock` but isn't directly a sequenced symbol, lookup, or call itself:
            *   The function checks if only one of its immediate children is responsible for all the sequence operations that caused the `node` to be considered for wrapping.
            *   If such a single responsible child is found, the `wrapInAsyncBlock` status is removed from the `node` and transferred to that child. This effectively pushes the wrapper closer to the actual source of the sequenced action.
                *   If that child was already marked to `wrapInAsyncBlock`, this effectively merges the wrappers.

**3. Code Generation (During Expression Compilation):**

*   **`Compiler._compileExpression(node, frame)`:**
    *   Before compiling `node`, calls `this._assignAsyncBlockWrappers(node, frame)` then `this._pushAsyncWrapDownTree(node)` to set `wrapInAsyncBlock` flags on the expression's AST.
*   **`Compiler.compile(node, frame, pathFlags)` (and specific `compile<ExpressionNodeType>` methods):**
    *   When compiling any part of an expression:
        *   **Check `node.wrapInAsyncBlock`:** If `true`, this specific `node`'s compilation is enclosed in an `this._emitAsyncBlockValue(...)`, creating an async IIFE.
        *   The node's content is compiled within this wrapper (or directly if not wrapped).