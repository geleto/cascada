# Flatten Next - Current and Future Design

**Status:** Draft planning doc for refactor

## Intro (Read First)

Cascada runs templates/scripts in async execution contexts. An async context is the unit of
concurrent work created by an async block; it owns its own output collection and completes
independently.

Each async context writes output into a CommandBuffer. A CommandBuffer is a container that
holds commands per output handler (for example: text, data, value). A command is a single
output operation (for example: emit text, data.set(path, value)). Commands are stored in
handler arrays and linked into per-handler chains.

Output buffers form a tree: parent contexts can contain nested CommandBuffers created by
child async blocks. Flattening walks this tree to produce final output. In template mode, this
means producing a string; in script mode, it means applying commands to an output target.

## Scope and Goals

This document focuses on:
- How output data is laid out today (buffers, arrays, command wrapping, poison markers).
- The intended future layout and responsibilities (template mode largely unchanged).
- A step-by-step migration plan with tests runnable after each step.

It intentionally omits detailed flattening logic that will be rewritten.

---

## Current System (Data Layout and Flow)

### 1) Buffers and Output Arrays
- In async mode, output is written into a CommandBuffer.
- Each output handler has its own array inside CommandBuffer.arrays.
  - Common handlers: text, data, value.
  - There is also output as a default stream.
- The buffer stores items, not just raw strings.

### 2) What Can Be Inside a Handler Array Today
When CommandBuffer.add() or fillSlot() is used, values are passed through _wrapCommand().

_wrapCommand() behavior (current):
- Pass-through (not wrapped):
  - CommandBuffer (nested buffers)
  - Array
  - PoisonedValue (via isPoison)
- Wrap to a command object otherwise:
  - If the value is already a command object (has handler), it is stamped with chain metadata.
  - Otherwise it becomes a text command: { handler: 'text', arguments: [value] }.

Therefore handler arrays can contain:
- Wrapped command objects (the normal case)
- Nested CommandBuffer instances
- Arrays
- PoisonedValue
- Poison markers (special objects used to mark skipped outputs)
- Plain objects in script mode (result objects with { text, data } behavior)

### 3) Poison Handling in Current Layout
- Errors can be represented as:
  - PoisonedValue inserted directly into arrays
  - Special poison markers inserted into arrays via addPoisonMarkersToBuffer()
- Poison markers exist to preserve handler targeting when a branch is skipped due to poison.

### 4) Command Chains (Next Pointers)
- Each handler array forms a linked chain of commands through next pointers.
- CommandBuffer containers themselves are not part of the chain.
- Chain is patched when async blocks finish, using firstCommand/lastCommand to link.
- Nested CommandBuffer instances are used as containers and are traversed to find real commands.

### 5) Template Mode (Flatten Text)
- Template mode uses flatten-text to reduce a text array into a string.
- It accepts:
  - primitives
  - arrays
  - PoisonedValue
  - CommandBuffer (flattened recursively)

### 6) Script Mode (Flatten Commands)
- Script mode uses flatten-commands and processes:
  - command objects (handler/command/subpath/arguments)
  - CommandBuffer containers
  - arrays
  - plain objects with { text, data } semantics
  - poison markers and PoisonedValue

---

## Target System (Future Design)

### 1) Template Mode
- Unchanged in behavior and representation.
- Still accepts primitives, arrays, and PoisonedValue.
- May standardize on PoisonedValue for error collection, but no structural refactor required.

### 2) Script Mode: Data Layout
- Everything is either a Command or a CommandBuffer.
- No raw arrays or plain objects in handler arrays.
- Poison handling is represented as a command that carries a PoisonedValue.

### 3) Command Objects
- Command should be a class (or a strict object type) with a single apply(target) method.
- The flattener becomes a simple loop that calls apply on each command in order.
- The flattener receives a single target object and applies only to that target.
- We flatten one buffer at a time, not combining multiple outputs into a composite result.

### 4) Shared CommandBuffer Context (Telemetry/Tracing)
- We keep shared CommandBuffer objects across handlers to preserve execution-context grouping
  for telemetry and tracing.
- Child buffers inherit the parent trace id and remain part of the same execution context.

---

## Migration Plan (Each Step Testable)

### Step 1: Implement Producer Inventory and Coverage Checks
Background: Before changing formats, we need a precise list of all producers that place
non-command values into script buffers (arrays, result objects, poison markers) and ensure
we have tests that cover each producer.
- Identify all sources that insert non-command values into CommandBuffer arrays in script mode:
  - arrays
  - result objects with {text, data}
  - poison markers
- Confirm test coverage for each producer.
- Tests: full suite should pass.

### Step 2: Implement Command Class Interface (No Behavior Change)
Background: We want commands to be first-class objects with apply(target) so we can simplify
flattening. This step adds the interface without changing produced output.
- Add a Command class with apply(target) but keep existing command object usage.
- Implement an adapter so old command objects can be treated as Command without changing outputs.
- Tests: full suite should pass.

### Step 3: Implement Poison Command Support (No Producer Changes)
Background: Script mode should represent poison as a command instead of a special marker. First,
teach the flattener to understand poison commands while leaving producers unchanged.
- Teach the flattener to accept a poison command and collect errors from it.
- Keep template behavior unchanged.
- Tests: full suite should pass.

### Step 4: Implement Script Poison Marker Switch
Background: Once the flattener accepts poison commands, switch script-mode producers away from
poison markers to poison commands.
- Replace addPoisonMarkersToBuffer for script output with a command that carries PoisonedValue.
- Keep template behavior unchanged.
- Tests: full suite should pass.

### Step 5: Implement Result Object Removal in Script Buffers
Background: Result objects ({text, data}) are a script-mode shortcut. We will replace them with
explicit commands per handler.
- Stop emitting {text, data} objects into script output arrays.
- Replace their use with explicit commands per handler.
- Deprecate object handling in flatten-commands (keep temporarily if needed).
- Tests: full suite should pass.

### Step 6: Implement Script Buffer Invariants
Background: Enforce the target data layout once legacy producers are removed.
- Add runtime checks to ensure script buffers contain only Command or CommandBuffer.
- Remove array handling from flatten-commands in script mode.
- Tests: full suite should pass.

### Step 7: Implement flatten-commands Rewrite
Background: With commands and invariants in place, flatten-commands can be rewritten as a clean
pipeline that only applies command objects to a target.
- Replace current logic with a clean pipeline:
  - single target object
  - iterate chain or array of commands
  - call apply(target)
- Keep template flattening unchanged.
- Tests: full suite should pass.

---

## Notes and Constraints
- This plan keeps template mode as-is to avoid broad changes.
- Script mode moves to a strict command-only buffer layout.
- Each step is intended to be testable with the existing full test suite.
- We flatten a single buffer per call (no merging of multiple handler outputs).
