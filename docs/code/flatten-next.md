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

### 1) Outputs, Buffers and Output Arrays
- In async mode, output is written into a CommandBuffer.
- Each output handler has its own Output object, and separately array inside a CommandBuffer created for each async context (AsyncState)
  - Common handlers: text, data, value, sink. There is an output class for each one (TextOutput, DataOutput, etc...)
  - For templates only text output is used
- The buffer stores instances of Command extending classes (TextCommand, DataCommand, etc)
-

### 2) What Can Be Inside a Handler Array Today
When CommandBuffer.add() or fillSlot() is used the values can be either Command* class instances ot CommandBuffer (for child async contexts)

### 3) Poison Handling in Current Layout
- Errors can be stored inside an ErrorCommand clobjectsass or in the other Command class instances, and can be extracted using the getError() method.

### 4) Command Chains (Next Pointers)
- Each handler array forms a linked chain of Commands through next pointers.
- CommandBuffer containers themselves are not part of the chain.
- Chain is patched when async blocks finish, using firstCommand/lastCommand to link.
- Nested CommandBuffer instances are used as containers and are traversed to find real commands.

### 6) Flatten Commands
- Currently the commands are flattened when the OutputData/Text/etc .snapshot() is called. In the future they will be dynamically flattened as new commands are added.

---

## The New Current design:

### 1) Template Mode - uses Commands just as Script Mode

### 2) Script And Template Mode: Data Layout
- Everything is either a Command or a CommandBuffer.
- Poison handling is represented as a command that carries a PoisonedValue.

### 3) Command Objects
- Command is a class (or a strict object type) with a single apply(target) method.
- The flattener becomes a simple loop that calls apply on each command in order.
- The Command.apply() methods work with a single target object

### 4) Shared CommandBuffer Context
- We keep shared CommandBuffer objects across handlers to preserve execution-context grouping. The arrays property has an array for each output (the output name is the key)
- In the future can be used for telemetry and tracing : child buffers inherit the parent trace id and remain part of the same execution context.