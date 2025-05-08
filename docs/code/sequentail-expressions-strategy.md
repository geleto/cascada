**Expression-level sequence lock handling strategy:**
To manage `!` sequence markers within expressions, an analysis phase determines
which parts require async block wrappers to ensure correct ordered execution.
For a given expression:
1. Key Discovery & Ordered Collection:
   - Identify all `!` path nodes from a`FunCall`, (these are "sequenced lock nodes").
   - Identify all `Symbol`/`LookupVal` that have identical sequence lock node already declared
   (these are "sequenced path nodes").
   - Keys must be collected in the order they are found/compiled
2. Prune Non-Critical Terminal Lock Node Wrappers (Optimization):
   For sequenced lock nodes (e.g. the `!` path from calls), if their specific sequence lock is
   not identical to a subsequent sequence path node within the *same expression*, 
   it does not need async block wrapping. (Global sequencing for side-effects remains).
3. Initial Broad Marking:
   All identified sequenced path nodes and all remaining (non-pruned) sequenced lock nodes
   are initially marked `needsWrapper = true`.
4. Bottom-Up Wrapper Merging & Optimization:
   Traverse the expression AST bottom-up. A parent node may merge `needsWrapper=true` children
   into its own potential wrapper, clearing the child's flag. The parent wrapper then assumes
   responsibility for all sequence keys involved in the merged operations.
   Merge conditions (applied by parent node `N` to its children `C_i`):
   - A `LookupVal`/`Symbol` (sequenced path segment) can merge all it's children (also LookupVal)
   - A `FunCall` sequenced lock node can merge all it's children (all are LookupVal/Symbol)
   - A node with only sequence paths and no locks can merge all it's children
   - A node where all collected lock keys are not followed by identical paths (similar to step 2 but local)
The node ultimately hosting a (potentially merged) wrapper is flagged `wrapInAsyncBlock = true`.