# Output Handler Refactoring Plan

## Phase 1: CommandNode as Object
* Convert CommandNode from array to object with `context` and `commands` properties
* Run tests (no compatibility changes)

## Phase 2: Decouple Handlers
* Add `data`, `text`, `value` properties to CommandNode (each holds separate array)
* Remove handler name from individual commands
* Add same CommandNode to all parent handler arrays
* Update `flattenBuffer` to handle new structure
* Run tests (no compatibility changes)

## Phase 3: Output Variables (Implicit)
* Declare default `@data`, `@text`, `@value` as output variables at each scope
* Use all accessible declared output variables when creating CommandNode
* Run tests (no compatibility changes)

## Phase 4: Return Interface
* Implement `return` statement (replaces flattened buffer return)
* Implement `snapshot()` - temporarily uses `flattenBuffer` internally
* Transpiler auto-adds all declared output variables to return: `return { data: @data.snapshot(), text: @text.snapshot(), value: @value.snapshot() }`
* Run tests (no compatibility changes)

## Phase 5: Custom Output Variables
* Add syntax: `data x`, `text y`, `sink z = expr`
* Support both default (`@data`, `@text`, `@value`) and custom declarations
* Run tests (backward compatibility maintained)

## Phase 6: Migrate Tests
* Create prompt with instructions, examples, and minimal context
* Use smaller model for mechanical test rewrite
* Use stronger model to fix broken tests
* Run tests (no compatibility breakages for non-migrated tests)

## Phase 7: Remove Legacy
* Remove default `@data`, `@text`, `@value` declarations
* Remove `@` output syntax support

## Phase 8: Proper Snapshots
* Implement proper `snapshot()` with real buffer materialization
* Add tests for multiple snapshots at different points

## Phase 9: Implement x:data, y:test, z:sink macro arguments
* array aliases/renames in CommandNode
* smae for caller()

---

# Snapshot Implementation Plan

## Overview

This implementation provides incremental snapshot support for Cascada's output handlers through a resolution chain architecture.

**Core Mechanism**: Output commands form a linked chain where each command knows its `next` neighbor. A "resolved" flag propagates forward through this chain as commands complete. As each command resolves, it incrementally applies its operation to the handler's flattened data structure. This means the flattened data is always up-to-date with all resolved commands, making snapshots cheap - they simply return the current state.

**Async Boundary Handling**: CommandNodes act as synchronization barriers in the chain. A CommandNode blocks the resolution wave until its AsyncBlock completes (all child async operations finish and no more commands will be added). Once resolved, it links to the next segment of the chain, allowing propagation to continue.

**Copy-on-Write Snapshots**: When `snapshot()` is called, it returns the current flattened data by reference and sets a flag. If a subsequent command needs to modify that data, it first creates a deep copy. This means if only one snapshot is taken at the end (common case), no copying occurs. Multiple snapshots only trigger copies when necessary.

**Scope Hierarchy**: Each output handler (data/text/value) maintains its flattened data at variable scope boundaries. Commands walk up the parent chain to find their handler's data. This supports nested scopes while maintaining proper variable lifetime semantics.

**Promise Sharing**: Multiple snapshots at the same position share the same promise, avoiding duplicate work and ensuring consistent results.


## Command Structure
* Each command stores: next pointer, resolved flag, handler name, method/operation, arguments, snapshot pointer (marks snapshot was taken at this command), promise, resolve function
* CommandNode stores: parent pointer, nextInArray, AsyncBlock reference, isVariableScope flag, per-output-handler scope data (only at variable scope - command arrays, flattened data, snapshot taken flag) for each handler (data/text/value)
* CommandNode.lastChild() returns last command in its arrays (promise resolved when CommandNode resolves)
* Root CommandNode has parent=null, AsyncBlock=null
* First command initially marked as resolved

## Initialization
* Script root CommandNode created with parent=null, isVariableScope=true
* At variable scope boundaries: CommandNode created with isVariableScope=true
* Flattened data for handler lazily initialized on first command for that handler
* Empty state: object {} for data, string "" for text, handler-specific for value
* Empty handler arrays still exist in CommandNode

## Next Pointer Construction (Dynamic)
* When element added to array:
  * Set previous element's next = current element
  * If previous was resolved → triggers resolution propagation
* Last array element's next initially unset
* When CommandNode resolves (AsyncBlock completes via `_leaveAsyncBlock`, or immediately for root):
  * lastChild() promise resolves
  * Set last array element's next = resolve CommandNode chain:
    * Start with CommandNode.nextInArray
    * If CommandNode → wait for lastChild() promise, repeat until reaching actual command
    * Enables propagation past async boundaries

## Resolution Propagation
* Command may receive final value before being resolved (waiting for previous commands)
* When command gets final value:
  * If resolved → mark next command as resolved
* When command becomes resolved:
  * If has final value → mark next command as resolved
  * Before applying command: if snapshot taken flag set for this handler, deep copy flattened data first (new copy has flag cleared)
  * Apply command (method with arguments) to handler's flattened data (advance flattening by 1 step)
  * If pending snapshot (resolve function exists): call resolve function with flattened data, set snapshot taken flag for this handler

## Finding Flattened Data
* Iterate up parent chain from current CommandNode to find CommandNode with isVariableScope=true
* Use flattened data for command's handler from that scope's CommandNode
* Lazily initialize if not yet created

## CommandNode as Async Barrier
* CommandNode inserted into handler arrays alongside commands
* Blocks resolution until AsyncBlock completes (`_leaveAsyncBlock` → `waitAllClosures`)
* Once resolved, links last element through CommandNode chain to next command

## Snapshot Execution
* At current last command for handler:
  * If resolved → return handler's flattened data (by reference), store snapshot pointer in command, set snapshot taken flag for this handler
  * If not resolved → create and store promise + resolve function in command, return promise
* Multiple snapshots at same position return the stored promise