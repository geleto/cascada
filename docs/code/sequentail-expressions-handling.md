# Expression-Level Sequence Lock Handling in Cascada

Cascada manages sequence locks within expressions to ensure that operations marked with the `!` sequence marker execute in the correct order, even in complex, concurrent scenarios. We need to decide exactly which specific parts of the expression (individual lookups or function calls) have to be wrapped in their own async block/IIFE to manage their sequence lock, preventing race conditions with other parts of the same expression. 
This process involves identifying sequence operations, analyzing potential conflicts, assigning async wrappers where necessary, optimizing their placement, and generating the appropriate code. The following sections detail each step, with examples and explanations to clarify the concepts.

---

## 1. Initial Sequence Operation Identification

The process begins by examining each node within an expression's structure (Abstract Syntax Tree or AST) to identify operations that interact with sequence locks:

- **FunCall Nodes:** Function calls that include a `!` marker in their path, such as `data.item!.update()`, are identified and associated with a unique `sequenceLockKey`. This key indicates that the operation actively manages a sequence lock for the specified path (e.g., `data.item`).
- **Symbol and LookupVal Nodes:** Variable lookups that access a path declared as part of a `!` sequence are associated with a `sequencePathKey`. This marks them as operations that respect an existing sequence lock.

**Example:**
In the expression `data.item!.update() + data.item.value`, the function call `data.item!.update()` is a `FunCall` node with a `sequenceLockKey`, while `data.item.value` is a `LookupVal` node with a `sequencePathKey` (assuming `data.item` is sequence-locked).

This initial identification sets the foundation for tracking sequenced operations throughout the expression.

---

## 2. Recursive Sequence Operation Analysis & Contention Marking

Next, a recursive analysis builds a `sequenceOperations` map for each node in the expression tree. This map tracks how the node and its children interact with different sequence keys and identifies potential conflicts (contention):

- **Aggregation:** As the analysis moves up the tree, it merges `sequenceOperations` from child nodes into their parent.
- **Contention Detection:** A sequence key is marked as `CONTENDED` on a node if its subtree involves conflicting operations for that key. Conflicts occur when:
  - Multiple `LOCK` operations target the same key.
  - A `LOCK` operation and a `PATH` operation target the same key.
  - **Note:** Multiple `PATH` operations for the same key do not cause contention because they are read-only and do not modify the sequence lock. For example, reading `data.item.value` multiple times in an expression doesn’t require sequencing.

This step ensures that any potential conflicts are flagged for resolution.

---

## 3. Assigning Async Wrappers Based on Contention

When a `CONTENDED` key is identified on a node, Cascada determines where to place async wrappers to resolve the conflict:

- **Recursive Descent:** For each contended key, the system drills down into the sub-branches of the expression involved with that key.
- **Wrapper Placement:** The `wrapInAsyncBlock = true` flag is set on the first node in a branch where the key is no longer `CONTENDED`. This node represents one side of the conflict and requires its own async IIFE to manage its part of the sequence. The wrapper ensures that this operation executes in sequence with other operations on the same lock.
- **Cleanup:** After assigning wrappers for a contended key, the key is removed from the node’s `sequenceOperations` map. If the map becomes empty, it is deleted entirely.

This targeted placement ensures that only the necessary parts of the expression are wrapped, maintaining correctness without unnecessary overhead.

---

## 4. Optimizing Wrapper Placement

An optimization pass refines the initial wrapper assignments to improve efficiency:

- **Purpose:** This step moves `wrapInAsyncBlock` flags closer to the actual sequenced operation if a wrapper at a higher level isn’t necessary. This reduces the number of async IIFEs, improving performance by minimizing the overhead of creating and managing asynchronous contexts.
- **Process:**
  - The system examines nodes marked with `wrapInAsyncBlock`.
  - If a node lacks a direct `sequenceLockKey` or `sequencePathKey`, it checks its children.
  - If only one child is involved with the sequence keys that caused the parent to be wrapped, the `wrapInAsyncBlock` flag is moved to that child, ensuring wrappers are as specific as possible.

This optimization keeps the generated code efficient while preserving the required sequencing.

---

## 5. Code Generation During Expression Compilation

Finally, the compiler generates the JavaScript code for the expression, incorporating async wrappers where needed:

- **Expression Compilation:** Before compiling a node, the analyses set the `wrapInAsyncBlock` flags throughout the AST.
- **Wrapper Emission:** During the compilation of individual parts (e.g., a `LookupVal` or `FunCall`):
  - If a node has `wrapInAsyncBlock = true`, its compiled code is enclosed in an async IIFE. This isolates its execution and manages its sequence lock independently.
- **Integration:** This step ensures that the generated JavaScript code correctly manages sequence locks while allowing maximum parallelism in the template execution, integrating seamlessly with the overall compilation process.