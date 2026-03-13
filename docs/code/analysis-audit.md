# Analysis Audit

## Purpose
Document the remaining gap between:
- analysis-owned semantic facts (`declares`, `uses`, `mutates`, `usedOutputs`, `mutatedOutputs`)
- compiler-side command registration (`registerOutputUsage`, `registerOutputMutation`)

The goal of this audit is to remove compiler/frame-based semantic tracking without reintroducing frame/analysis merges.

## Core Rule
Analysis should own source-level read/write semantics.

That means:
- if a source construct reads an output, analysis should record `uses`
- if a source construct writes/mutates an output, analysis should record `mutates`
- if a compiler helper currently calls `registerOutputUsage` / `registerOutputMutation` for a source-level effect, that is a migration gap

The compiler may still keep runtime-only bookkeeping temporarily, but it should not be the source of truth for semantic `usedOutputs` / `mutatedOutputs`.

## Current Discrepancy
The current discrepancy is:
- analysis models many source-level reads/writes correctly
- some effective handler usage is still discovered only during command emission
- async wrapper nodes have historically depended on that emitted usage through `frame.usedOutputs`

This is why removing a generic merge from `CompileEmit.getAsyncBlockArgs()` caused regressions:
- include inside async `capture`
- include inside async `if`
- include inside async `switch`

Those regressions are not evidence that frame usage is needed.
They are evidence that analysis is still missing some semantics that the legacy registration path is carrying.

## Include Discrepancy
This is the main known semantic gap.

### What analysis currently says
- `analyzeInclude()` records only current text output usage/mutation:
  - the include writes to the currently active text lane

### What compilation currently adds
- `compileInclude()` computes additional include link candidates from visible declared outputs
- it then calls:
  - `registerOutputUsage(frame, name)`
for each candidate

### Why this matters
Those candidate handlers are not represented in `node._analysis.usedOutputs`, but they do affect:
- async block linkage
- loop/include metadata restoration
- nested loop shadowing behavior
- capture/if/switch wrappers that contain includes

### Conclusion
Include is still a deferred exception.
Until include composition semantics are modeled in analysis, it remains the main reason compiler-side usage registration still changes observable behavior.

## Registration Audit

## 1. Output command construction
File:
- `src/compiler/compile-buffer.js`

### `_compileCommandConstruction(node, frame)`
Current registration:
- `registerOutputUsage(frame, handler)` always
- `registerOutputMutation(frame, handler)` for:
  - sequence call
  - data/text/var/sink commands

Classification:
- observation commands are read-only:
  - `snapshot`
  - `isError`
  - `getError`
- sequence reads are read-only:
  - `SequenceGetCommand`
- mutating commands:
  - `SequenceCallCommand`
  - `DataCommand`
  - `TextCommand`
  - `ValueCommand`
  - `SinkCommand`

Analysis status:
- mostly consistent in spirit
- but command semantics are still partly compiler-owned here

Needed change:
- source AST analysis must classify these commands directly
- command construction should stop deciding semantic usage/mutation

## 2. Generic buffer command enqueue
File:
- `src/compiler/compile-buffer.js`

### `emitAddCommand(frame, outputName, ...)`
Current registration:
- `registerOutputUsage(frame, outputName)`

Classification:
- if used for `TextCommand` enqueue, this is a write to text output
- if used for generic command enqueue, semantic meaning depends on caller

Problem:
- this helper treats all uses as read-only
- actual mutation semantics are carried elsewhere or implicitly assumed

Needed change:
- semantic meaning should come from the source node analysis, not this generic enqueue helper
- eventually this helper should stop registering source-level semantics entirely

## 3. Wait bookkeeping
File:
- `src/compiler/compile-buffer.js`

### `emitOwnWaitedConcurrencyResolve(frame, valueExpr, ...)`
Current registration:
- `registerOutputUsage(frame, waitedOutputName)`

Classification:
- synthetic bookkeeping only
- not a source-level read
- not a semantic write

Analysis status:
- should not be modeled as source-level `uses` / `mutates`

Needed change:
- keep separate from analysis
- if tracking remains, it should be explicitly runtime/synthetic bookkeeping

## 4. Sequence helpers
File:
- `src/compiler/compile-buffer.js`

### `emitAddSequenceGet(...)`
Current registration:
- usage only

Classification:
- semantic read

Analysis status:
- should be fully analysis-owned
- `analyzeLookupVal()` / sequence analysis should already cover this

### `emitAddSequenceCall(...)`
Current registration:
- usage + mutation

Classification:
- semantic mutation

Analysis status:
- should be fully analysis-owned
- compile helper should not be the semantic source of truth

## 5. Snapshot/error observation helpers
File:
- `src/compiler/compile-buffer.js`

### `emitAddSnapshot(...)`
### `emitAddRawSnapshot(...)`
### `emitAddIsError(...)`
### `emitAddGetError(...)`
Current registration:
- usage only

Classification:
- semantic reads
- these are observation calls

Analysis status:
- should be fully analysis-owned
- `specialOutputCall` / related analysis should describe these directly

## 6. Async buffer write helpers
File:
- `src/compiler/compile-buffer.js`

### `asyncAddToBuffer(...)`
Current registration:
- usage + mutation on `outputName`

### `asyncAddValueToBuffer(...)`
Current registration:
- delegates to `emitAddCommand()`

### `asyncAddToBufferScoped(...)`
Current registration:
- usage + mutation on `outputName`

Classification:
- these are generic emission helpers
- they are currently mixing:
  - source-level semantic write tracking
  - runtime command buffer assembly

Problem:
- semantic meaning depends on the source node that called them
- helper-level registration hides that distinction

Needed change:
- source node analysis must own the semantic `uses` / `mutates`
- these helpers should eventually stop registering source semantics

## 7. Expression compilation
File:
- `src/compiler/compiler-base.js`

### `compileSymbol()`
Current registration:
- sequence lock paths call:
  - `registerOutputUsage(frame, nodeStaticPathKey)`
  - optionally `registerOutputMutation(...)`
- var/output observation paths use snapshot/error helpers

Classification:
- sequence lock reads/writes are semantic and should be analysis-owned
- var/output snapshot reads are semantic reads and should be analysis-owned

Status:
- sequence metadata has already moved toward analysis
- some compiler-side registration still remains

### `compileLookupVal()`
Current registration:
- sequence path / lock paths can still register usage/mutation

Classification:
- sequence get is read-only
- sequence lock call path may mutate

Needed change:
- use analysis-owned sequence metadata only
- remove duplicate compile-time registration semantics

### `compileFunCall()`
Current registration:
- sequence lock operations still call:
  - `registerOutputUsage`
  - `registerOutputMutation`

Classification:
- semantic mutation/read depending on special call type

Needed change:
- `specialOutputCall` and sequence metadata should be enough
- compile should emit only

## 8. Statement compilation
File:
- `src/compiler/compiler.js`

### `compileAsyncVarSet()`
Current behavior:
- mutating `var` output assignment emits `ValueCommand`
- command helper registration still contributes to frame usage/mutation

Classification:
- semantic mutation of target output

Analysis status:
- `analyzeSet()` / `analyzeCallAssign()` should fully own this already
- helper registration is redundant once frame reads are removed

### `_emitMacroBindingInit()`
Current registration:
- explicit `registerOutputUsage`
- explicit `registerOutputMutation`

Classification:
- compiler-generated but still source-correlated
- macro argument/caller binding outputs behave like semantic writes

Question:
- should macro binding outputs be modeled in analysis as source semantics, or treated as compiler-generated runtime declarations?

Current recommendation:
- classify these explicitly as synthetic if they remain compiler-emitted implementation artifacts
- do not let them blur the source-semantics audit

### `compileOutput()`
Current behavior:
- uses generic async buffer helpers for text emission

Classification:
- semantic mutation of current text output

Analysis status:
- `analyzeOutput()` already models this
- helper registration should become redundant

### `compileCapture()`
Current behavior:
- capture body writes into capture text lane through async helper path

Classification:
- semantic mutation of capture text output

Analysis status:
- `analyzeCapture()` gives capture its own text output
- include inside capture is still incomplete because include adds extra compile-time usage not represented in analysis

## 9. Include compilation
File:
- `src/compiler/compile-inheritance.js`

### `compileInclude()`
Current registration:
- `includeLinkCandidates.forEach((name) => registerOutputUsage(f, name))`

Classification:
- not a normal local source read/write
- this is include-composition linkage metadata
- still semantically relevant for async linkage and loop metadata restoration

Status:
- this is the main remaining source of frame/analysis discrepancy

Recommendation:
- keep this isolated as the explicit deferred exception
- do not let generic compiler helpers depend on this through broad frame merges
- if possible later, move include-visible handler composition into explicit include analysis data

## Summary Table

### Should be analysis-owned
- output command observation:
  - `snapshot`
  - `isError`
  - `getError`
- sequence get
- sequence call
- data/text/value/sink output writes
- text output writes from `Output`
- var output writes from `Set` / `CallAssign`
- sequence lock read/write semantics

### Should remain synthetic/runtime-only
- waited output bookkeeping (`__waited__*`)
- other timing-only command-buffer mechanics
- any compiler-generated temporary handler not corresponding to a source declaration

### Explicit deferred exception
- include-visible declared-output linkage / alias candidates

## Why broad frame merges are wrong
Broad merges like:
- `analysis usedOutputs` + `frame.usedOutputs`

are wrong because they:
- hide where analysis is incomplete
- let synthetic bookkeeping masquerade as source semantics
- make unrelated wrapper nodes depend on compiler-side artifacts
- prevent the system from converging on analysis-owned truth

The correct approach is:
- identify which specific semantic fact is missing from analysis
- model that fact in analysis, or
- isolate the case as an explicit temporary exception

## Recommended next steps

## Step 1
Remove the temporary wrapper-node merge added for:
- `Capture`
- `If`
- `Switch`

But only after the missing semantic fact is addressed.

## Step 2
Audit every remaining `registerOutputUsage` / `registerOutputMutation` call and mark it as one of:
- source semantic read
- source semantic write
- synthetic/runtime-only bookkeeping

## Step 3
For source semantic calls:
- ensure analysis records the same fact
- then remove the compile-time registration dependency

## Step 4
Keep include isolated as a documented deferred exception until its linkage semantics are modeled more explicitly.

## Definition of success for this phase
- removing a `frame.usedOutputs` read should not require adding a new frame/analysis merge elsewhere
- source-level semantics should be recoverable from analysis alone
- compiler-side registration should either:
  - disappear, or
  - be clearly limited to synthetic/runtime-only bookkeeping
