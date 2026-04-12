# `extends-next` Implementation Plan

## Agent Prompt

You are implementing the `extends-next` class-system composition architecture
for the Cascada engine. The target design is fully specified in
`docs/code/extends-next.md` and `docs/code/namespace-method-ordering.md`.
Read both documents before starting any step.

Your working codebase is a JavaScript/Node.js project. Key directories:
- `src/compiler/` — compiler passes, AST transformation, code generation
- `src/environment/` — public API, `AsyncEnvironment`, `AsyncTemplate`, context
- `src/runtime/` — runtime helpers, command buffer, buffer iterator, commands
- `src/parser.js`, `src/nodes.js` — parser and AST node definitions
- `tests/pasync/` — async test suite; add new tests here

Follow all rules in `AGENTS.md`. Use `it.only()` / `describe.only()` to isolate
tests during development. Run `npm run test:quick` for fast feedback. After each
step passes its own tests, remove `.only()` and run `npm run test:quick` to
check for regressions before proceeding.

Implement steps in order. Each step is self-contained and testable. Do not
implement a later step's design inside an earlier step.

## Scope Decision

This plan targets **static ancestry only** for the first `extends-next`
implementation.

- Static `extends "base.script"` / `{% extends "base.njk" %}` are in scope.
- Dynamic or conditional parent selection is out of scope for these steps.
- Existing dynamic-extends behavior should either remain on the current path or
  be rejected explicitly for `extends-next` features until a separate
  bootstrap-compatible design exists.

---

## Context: What Already Exists

- `extends` compiles in `src/compiler/inheritance.js` (`compileAsyncExtends`,
  `compileSyncExtends`)
- `_emitAsyncRootCompletion` in `src/compiler/compiler-async.js` handles the
  current sequential hand-off model (child completes → parent `rootRenderFunc()`)
- `getAsyncSuper` / `getBlock` / `addBlock` in `src/environment/context.js`
  manage the block table
- `findChannel` in `src/runtime/command-buffer.js` already traverses parent
  chain (used for upward lookup)
- `getFinishedPromise()` on `CommandBuffer` (`src/runtime/command-buffer.js:78`)
  resolves when buffer is done receiving commands
- `onLeaveBuffer` fires when the buffer iterator finishes traversing a child
  buffer (`src/runtime/buffer-iterator.js:171`)
- `_analysis.usedChannels` (Set) — all channels touched by a node
- `_analysis.mutatedChannels` (Set) — channels written by a node
  (`src/compiler/analysis.js:621-622`)
- `composition-update.md` Steps A–E are complete; `captureCompositionValue`,
  `createInheritancePayload`, `forkForComposition` are in place

---

## Step 1 — `shared` Keyword: Parser and Nodes

**Goal:** Parse `shared var x`, `shared text t`, `shared data d`,
and `shared sequence db` declaration syntax in script mode.

Default-value legality and initialize-if-not-set semantics are specified in
Step 3, not here.

### Changes

**Frontend rule**
- Reuse the existing script frontend where possible instead of introducing a
  second direct-parser syntax path for script-only keywords.

**`src/nodes.js`**
- Prefer extending existing channel-declaration metadata with a `shared` flag
  over introducing a separate `SharedDeclaration` family.
- If a dedicated node is still used, keep it as a thin syntax wrapper that
  lowers immediately into the normal channel-declaration model.

**`src/script/script-transpiler.js`**
- Recognize `shared` as a script statement-opening keyword and lower it into one
  explicit parser/runtime form.

**`src/parser.js`**
- Parse the lowered representation.
- Error on `shared` in template (non-script) mode unless template-side `shared`
  syntax is deliberately added later.
- Error on `shared` inside a method/block body (only valid at file top level or
  in constructor scope).

### Tests

`tests/pasync/shared-keyword.js` — parser-only tests using `_compileSource()`:
- `shared var theme = "dark"` parses without error.
- `shared text log` (no default) parses without error.
- `shared` inside a method body throws a parse error.
- `shared` in template mode throws a parse error.

---

## Step 2 — `method ... endmethod` Syntax

**Goal:** Verify and complete `method name(args) ... endmethod` in script mode
as a block definition equivalent to `{% block name(args) %}`.

### What already exists

`src/script/script-transpiler.js` already maps `method` → `block` and
`endmethod` → `endblock` during transpilation. Basic `method foo() ... endmethod`
already works. This step only adds what is missing.

### Changes

**`src/nodes.js`**
- Add `isMethod` boolean field to `Block.fields` for diagnostic messages.
  Set it when the `Block` node is created from a `method` transpilation.

**`src/script/script-transpiler.js`**
- Verify that `method name(args)` correctly passes the argument signature
  through to `{% block name(args) %}`. Confirm with a test — if the signature
  is dropped or mangled, fix it here.

**`src/parser.js`** (template mode guard)
- If `method` ever reaches the template-mode parser without transpilation,
  emit a clear error. Check whether the transpiler already prevents this;
  if so, no change needed.

### Tests

`tests/pasync/method-syntax.js`:
- `method foo() ... endmethod` compiles to the same output as
  `{% block foo() %} ... {% endblock %}`.
- `method add(a, b) ... endmethod` — signature is preserved correctly.
- `endmethod` without `method` throws a parse/transpiler error.
- `method` in template mode (non-script) throws an error.

---

## Step 3 — `shared` Channel Analysis

**Goal:** Compile shared declarations into channel declarations that use
upward `findChannel` traversal instead of declaring a new channel locally.

### Initialize-if-not-set semantics per channel type

`shared x = default` must work for all supported channel types. The mechanism
differs by type and must be specified explicitly — `VarCommand.initializeIfNotSet`
only covers `var`:

- **`shared var x = default`**: emit a `VarCommand` with an `initializeIfNotSet`
  flag. In `VarCommand.apply()`, skip the write if the channel's current value
  is not `undefined`.
- **`shared text t`**: `text` channels do not take a scalar default. `shared text t`
  without a default declares participation; with a default it is not meaningful.
  Disallow `shared text t = "..."` at the parser level. An unconditional `t.append(...)`
  in pre-extends code is the correct way to initialize shared text.
- **`shared data d`**: same pattern as `text` — no scalar default is meaningful.
  Disallow `shared data d = ...` at the parser level. Shared data is populated
  through channel method calls in constructor code.
- **`shared sequence db`**: the current sequence channel requires an initializer
  (enforced in `src/compiler/validation.js`). For `shared sequence db`, decide
  one of:
  - **Option A** (recommended): require `shared sequence db = sinkExpr` just
    like a regular `sequence` declaration. The root-owned channel is initialized
    once by the most-derived file that provides an initializer; others declare
    participation with `shared sequence db` (no initializer).
  - **Option B**: relax the validation rule for shared sequence channels so that
    an initializer is optional, with a `null`/`undefined` target until set via
    bootstrap `with { }` or pre-extends code.
  Whichever option is chosen must be stated explicitly here before implementation.

### Changes

**`src/compiler/compiler-async.js`** (or `compiler.js` for sync path)
- Add `compileSharedDeclaration(node)` / `analyzeSharedDeclaration(node)` or
  the equivalent on the reused declaration node shape.
- Analysis: mark the channel name as `shared: true` in the scope's declared
  channels. Shared channels must cross scope boundaries and not be blocked by
  `scopeBoundary` rules.
- Compilation: emit one root-owned shared-channel declaration path that walks up
  to the root buffer and registers the channel there if not already present.
- Avoid a special-purpose shared runtime path if ordinary channel declaration
  machinery can be reused with a `shared` modifier.
- Emit initialize-if-not-set writes according to the per-type rules above.

**`src/runtime/command-buffer.js`**
- Add `declareSharedChannel(name, keyword)`: walks `this.parent` chain to find
  the root buffer (no parent), calls `getChannel(name)` or creates it there.

**`src/runtime/commands.js`**
- Add `initializeIfNotSet` flag to `VarCommand.apply()`: skip the write if the
  channel's current value is not `undefined`. No equivalent flag is needed for
  `text`/`data`/`sequence` because those types do not have a scalar default.

### Tests

`tests/pasync/shared-channels.js`:
- `shared var x = 1` in A, `shared var x = 2` in C (most-derived): C's value
  wins when rendered as `C extends A`.
- `shared var x` (no default) in A: channel exists but is `undefined` without
  other initialization.
- Unconditional `x = 3` in C's post-extends code overwrites A's
  initialize-if-not-set write.
- `with { x: 99 }` prevents any `shared x = default` from overwriting it.

---

## Step 4 — Root Buffer Inversion

**Goal:** Invert the extends execution model so C's buffer is the root and B+A
execute in nested child buffers, instead of the current child-completes-then-
parent-runs hand-off.

This is the most architecturally invasive step. Read
`src/compiler/inheritance.js` and `src/compiler/compiler-async.js` carefully
before starting.

### Current model (to replace)

`_emitAsyncRootCompletion` in `compiler-async.js`:
1. Template body finishes running.
2. Looks up `finalParent` from `__parentTemplate` channel.
3. Calls `finalParent.rootRenderFunc(env, parentContext, runtime, cb, ...)`.
4. The child buffer completes separately; the parent renders to its own buffer.

### New model

1. C runs first; its buffer is the root.
2. When C hits `extends "B.script"`, it creates a child buffer and calls B's
   `rootRenderFunc` inside that child buffer synchronously as part of C's
   execution flow.
3. B similarly creates a child buffer for A.
4. The `extends` site waits for the child buffer to be fully *applied* by the
   iterator before continuing with post-extends code.

**Scope note:** this step applies only to static ancestry. Dynamic or
conditional extends stay on the old path or are rejected for `extends-next`.

### Changes

**`src/compiler/inheritance.js`** — `compileAsyncExtends(node)`
- Replace the current `rootRenderFunc` call emission with:
  1. Create an extends child buffer: `runtime.createCommandBuffer(context, parentBuffer, ...)`.
  2. Call the resolved parent template's `rootRenderFunc` with `compositionMode = true`
     so it returns its root buffer rather than calling `cb`.
  3. Attach that buffer as a child of the current buffer.
  4. Post-extends code must wait until the ancestor chain's commands have been
     *applied* by the iterator, not merely scheduled. Use `onLeaveBuffer` on the
     extends child buffer to signal completion — specifically, register a callback
     on the child buffer that resolves a promise, then emit a `WaitResolveCommand`
     with that promise. Do **not** use `getFinishedPromise()` here:
     `getFinishedPromise()` resolves when the buffer finishes receiving commands
     (scheduling complete), not when the iterator has applied them. Applied
     ordering is required so shared-channel values written by ancestors are
     visible to post-extends code.

**`src/compiler/compiler-async.js`** — `_emitAsyncRootCompletion(node)`
- Remove the `finalParent` lookup and `rootRenderFunc` call.
- When `compositionMode` is true: `markFinishedAndPatchLinks()` and return
  the root buffer (caller attaches it as a child).
- When `compositionMode` is false (top-level entry): mark finished and call `cb`.

**`src/environment/template.js`** / `src/environment/context.js`
- `rootRenderFunc` signature: add `compositionMode` parameter.
- `forkForPath` / `forkForComposition` at the extends site now creates a context
  whose root buffer is the instance root buffer (C's buffer), not a fresh one.

### Tests

`tests/pasync/extends-root-inversion.js`:
- `C extends B extends A`: all three levels' constructor code runs; output order
  is pre-C, pre-B, A-body, post-B, post-C.
- `shared var x` set in C's pre-extends code is visible in A's constructor via
  upward `findChannel`.
- The `onLeaveBuffer` + `WaitResolveCommand` barrier ensures post-extends code
  in B does not run before A's constructor commands have been fully applied.

---

## Step 5 — Two-Phase Hierarchy Bootstrap

**Goal:** Before any constructor code runs, resolve the full ancestry chain,
pre-register shared channels, preload `with { }` values, and build the method
dispatch table.

### Changes

**New file: `src/runtime/hierarchy-bootstrap.js`**
- `bootstrapHierarchy(rootTemplate, withValues, env)`:
  1. Walk the **static** extends chain: for each template in the chain, call
     `template.compile()` if not already compiled, then read its static parent
     name from compiled metadata. Collect `[C, B, A]` in most-derived-first
     order. Templates are lazily compiled by default — bootstrap must ensure each
     ancestor is compiled before reading its chain metadata.
  2. Collect all `sharedChannelSchema` entries from each template's compiled
     metadata (channel name → keyword). Register them in the root buffer, most-
     derived first (so C's type wins if there is a conflict).
  3. Preload `withValues` into the root buffer's shared channels using
     initialize-if-not-set semantics.
  4. Build the dispatch table: for each method/block name, register most-derived
     override first (skip if already registered).
  5. Return `{ rootBuffer, dispatchTable }`.

**`src/compiler/compiler-async.js`**
- Emit `sharedChannelSchema` as compiled metadata on the template object: an
  array of `{ name, keyword }` for every `shared` declaration in this file.
- Emit `blockContracts` already handles block signatures; ensure `isMethod` is
  also recorded.

**`src/environment/context.js`**
- `beginAsyncExtendsBlockRegistration`: remove from the **static-extends path
  only**. Retain the function for dynamic extends, which remains on the old path
  until a separate bootstrap-compatible design exists. Do not remove the function
  entirely or the existing dynamic-extends tests will break.
- Add `setDispatchTable(table)`: replace current `addBlock` chain-walking with a
  pre-built table, used only on the static-extends/namespace path.

### Tests

`tests/pasync/hierarchy-bootstrap.js`:
- Methods from C are visible during A's constructor (hoisting).
- `with { x: 5 }` is visible as the value of `shared var x` in A's constructor,
  even though A runs after bootstrap.
- If C and A both declare `shared var x`, C's type (var) is used.

---

## Step 6 — Return Value Threading

**Goal:** Most-derived explicit return takes precedence; ancestor fallback
returns propagate if the most-derived has none.

### Changes

**`src/runtime/command-buffer.js`**
- Add a `returnSlot` to the root buffer: a deferred that holds the script return
  value. Initially unset.
- `setReturn(value, priority)`: sets the slot only if `priority` is higher than
  any previously recorded return (most-derived = highest priority).

**`src/compiler/compiler-async.js`** — `_emitScriptRootLeafResult(node)`
- Instead of directly calling `cb(null, result)`, emit a call to
  `rootBuffer.setReturn(result, priority)`.
- `priority` is the template's depth in the hierarchy (0 = most-derived,
  higher = deeper ancestor). Depth is not known at compile time — it is only
  known after bootstrap resolves the full chain. Bootstrap must therefore pass
  the depth value to each ancestor's render call as a parameter (e.g., added to
  the `compositionMode` argument or as a new `hierarchyDepth` parameter on
  `rootRenderFunc`). The compiled leaf-result code reads this runtime parameter
  rather than a compile-time constant.
- The root buffer's `markFinishedAndPatchLinks()` triggers resolution of the
  return slot; the top-level callback receives the winning value.

### Tests

`tests/pasync/extends-return.js`:
- C has `return data.snapshot()`, A has `return text.snapshot()`: C's wins.
- Neither C nor B has an explicit return, A has `return data.snapshot()`: A's
  propagates.
- No file has an explicit return: result is the rendered text output.

---

## Step 7 — Namespace Instances (`import ... as ns`)

**Goal:** `import "C.script" as ns with { ... }` creates an independent
namespace object that exposes methods and `shared` channels.

### Changes

**`src/parser.js`**
- Normalize namespace instantiation syntax on `import "X.script" as ns with { ... }`.
- The namespace-import distinction (`import ... as ns` vs plain `import`) is
  still expressed by whether `as target` is present on the node.
- If the current script frontend only supports the existing capture-style
  `with name1, name2` form, add the minimal frontend lowering needed so the
  namespace form can accept `with { key: value }` and preserve it through to
  compilation as explicit preload values.
- Plain `import` / `include` keep their existing `extern`-composition meaning.
  Namespace import uses the `with { ... }` payload for shared-instance preload.

**Syntax/frontend rule**
- The target syntax for namespace instantiation is
  `import "X.script" as ns with { key: value }`.
- If the current parser/transpiler does not yet preserve that object-literal
  form, this step includes the necessary frontend work. Do not leave the plan
  in a mixed-syntax state.

**`src/compiler/inheritance.js`** — `_compileAsyncImport(node)`
- Read the existing `_compileAsyncImport` carefully before modifying it — it
  already has branching for `from-import` vs plain `import` and handles
  `withVars`/`withContext` composition. The namespace path (`as ns`) must be
  added as a new branch without disturbing the existing plain-import path.
- If the import has `as ns`:
  1. Run `bootstrapHierarchy` to compile the chain, register shared channels,
     preload `withValues`, and build the dispatch table.
  2. Execute the hierarchy's constructor chain: call C's `rootRenderFunc` with
     `compositionMode = true`, creating nested child buffers for B and A. The
     namespace's root buffer is a child of the calling buffer so its commands
     are DFS-ordered relative to the caller.
  3. Wait for the root buffer to finish (via `onLeaveBuffer` on the namespace
     root buffer) before the namespace object is usable.
  4. Construct the namespace object:
     - One property per method name: a function that emits a
       `NamespaceMethodCallCommand` into the calling buffer.
     - One getter per `shared` channel name: reads from the namespace's root
       buffer at access time.
  5. Bind the namespace object to the `ns` variable.

**`src/environment/context.js`**
- `createNamespaceContext(rootBuffer, dispatchTable)`: returns a context
  configured for the namespace root buffer.

### Tests

`tests/pasync/namespace-import.js`:
- `import "C.script" as comp` creates a usable namespace.
- `comp.methodName(args)` executes the method and its result is available.
- `comp.sharedVar` reads the shared channel value.
- Two imports of the same script produce independent instances.

---

## Step 8 — Method Reads/Writes Analysis

**Goal:** Attach `{ reads: Set, writes: Set }` to each compiled method object to
support the coordination channel in Step 9.

### Changes

**`src/compiler/analysis.js`**
- `_finalizeOutputUsage` (see `src/compiler/analysis.js:569`) already computes
  both `mutatedChannels` (writes) and `usedChannels` (reads + writes) on every
  node's `_analysis`. The read-only set is `usedChannels − mutatedChannels`. No
  new traversal is needed.
- Expose a `getMethodChannelSets(blockNode)` helper that returns
  `{ reads: Set, writes: Set }` derived from `blockNode.body._analysis`.
- Filter both sets to **shared instance channels only**: keep only names that
  appear in the template's `sharedChannelSchema` (added in Step 5). This
  requires Step 5 to be complete before Step 8. Do not include internal,
  local, text, or return channels in coordination metadata — those are
  implementation details that would over-serialize unrelated calls.

**`src/compiler/compiler-async.js`** — `_compileAsyncBlockEntries`
- For each block/method, emit `b_name.reads = new Set([...])` and
  `b_name.writes = new Set([...])` after the function definition, using
  `getMethodChannelSets`. These sets are only meaningful for namespace method
  calls; they are harmless on non-namespace blocks.

### Tests

- Inspect `_compileSource()` output to verify `reads` / `writes` sets are
  emitted on method functions.
- A method that writes `shared var count` has `count` in `writes`.
- A method that only reads `shared var theme` has `theme` in `reads` and not
  in `writes`.

---

## Step 9 — Coordination Channel for Namespace Method Ordering

**Goal:** Implement channel-level method ordering without globally serializing
the whole namespace. Full spec in `docs/code/namespace-method-ordering.md`.

### Changes

**`src/runtime/commands.js`**
- Add `NamespaceMethodCallCommand` as an **observable command**
  (`isObservable = true`, carries a `promise` field):
  - Fields: `method`, `args`, `reads`, `writes`.
  - `apply(target)` (synchronous):
    1. Capture deps: `deps = [target[ch] for ch in reads ∪ writes]`.
    2. Register write slots: for each `ch` in `writes`, create `Deferred done[ch]`,
       set `target[ch] = done[ch].promise`.
    3. Create a `Deferred result` for the method's return value. Set
       `this.promise = result.promise` so callers that await `comp.method()`
       receive the return value.
    4. Fire and return: launch async operation.
       - Async: `await Promise.all(deps)`, resolve args, then invoke the method.
         Method invocation creates a child buffer in the namespace. The namespace
         has its own buffer iterator running; when that iterator finishes
         traversing the method's child buffer it calls `onLeaveBuffer` on the
         child buffer object. Wire `done[ch]` resolution to this event by
         registering a callback on the child buffer before it is attached to the
         namespace root buffer — for example, set `childBuffer._onLeave = () =>
         { writes.forEach(ch => done[ch].resolve()); }` and invoke it from
         `onLeaveBuffer`. Once all `done[ch]` are resolved, resolve `result`
         from the method invocation's own completion path.
       - The method-return path is **separate** from Step 6's hierarchy/root
         return-slot. Step 6 governs constructor/root explicit returns for the
         whole instance. Namespace method calls need their own per-call result
         channel or deferred so `ns.method()` can resolve to that method's value
         without reading or mutating the instance-wide constructor return slot.
  - The observable form means the buffer iterator places `this.promise` in
    `_pendingObservables` exactly like `SequenceCallCommand` — the calling
    expression awaits it and receives the method's return value.
  - This satisfies `comp.methodName(args)` being a usable value in expressions.

**`src/runtime/command-buffer.js`**
- `createCoordinationChannel()`: returns a special channel whose `_target` is a
  plain object (the promise map `{}`). The coordination channel lives on the
  namespace root buffer.
- Add support for a per-buffer `_onLeave` hook (or equivalent) that
  `onLeaveBuffer` calls when the iterator exits the buffer. This is how
  `NamespaceMethodCallCommand` wires `done[ch]` resolution without polling.

**`src/compiler/inheritance.js`** — namespace method call emission
- When `ns.method(args)` is called, emit a `NamespaceMethodCallCommand` with
  the method's `reads` and `writes` sets (from Step 8).
- For fast-snapshot `var` channels: read the value synchronously from `target`
  inside `apply()` rather than adding a dependency promise.

### Tests

`tests/pasync/namespace-ordering.js`:
- `ns.setCount(x); ns.setLabel("ok"); ns.render()`: `render` sees both
  committed writes even when `setCount` is slow (mock delay on `x`).
- Two calls writing disjoint channels run concurrently (verify with timing mocks).
- Write-after-read: later write is not blocked by earlier read of same channel
  (verify explicitly).
- Fast-snapshot: `var` channel value captured synchronously at call time.

---

## Step 10 — Template Extends Behavioral Change

**Depends on:** Step 4 (root buffer inversion) must be complete and all
Step 4 tests passing before this step is started. The guard removed here is
only safe to remove once the new execution model is in place.

**Goal:** Make template `{% extends %}` follow the new pre/post-extends model
where code before `{% extends %}` is pre-extends initialization and code after
it is post-extends code (currently, template code outside blocks in a child is
largely ignored by Nunjucks-compatible semantics).

**Note:** This step changes observable behavior for existing templates that
extend a parent. Run the full test suite carefully and document the breaking
change.

### Changes

**`src/compiler/inheritance.js`** — `compileSyncExtends` / `compileAsyncExtends`
- Remove the early-exit that skips rendering top-level non-block code in
  extending templates.
- Emit pre-extends code into the current buffer before the extends boundary.
- Emit post-extends code after the Step 4 apply-complete barrier
  (`onLeaveBuffer` + `WaitResolveCommand`), not after `getFinishedPromise()`.

**`src/compiler/compiler-async.js`**
- Remove the `if (!this.inBlock && this.hasStaticExtends && !this.hasDynamicExtends) return;`
  guard in `compileAsyncBlock` — this guard skips block definitions in child
  templates and is no longer needed once the root buffer inversion is in place.

### Tests

`tests/pasync/template-extends-pre-post.js`:
- Code before `{% extends %}` in a child template runs as pre-extends code.
- Code after `{% extends %}` runs as post-extends code (after ancestors finish).
- A `{% block %}` in a child overrides the parent's block as before.
- Regression: a template with only block definitions and no pre/post code
  behaves identically to before.

---

## Completion Checklist

After all steps:

- [ ] `npm run test:quick` passes with no regressions
- [ ] `npm test` (full suite including browser) passes
- [ ] `docs/code/extends-next.md` Implementation Notes section updated to
  reflect actual implementation (remove "currently" / "requires changes" notes)
- [ ] `docs/code/namespace-method-ordering.md` cross-referenced correctly
- [ ] `CLAUDE.md` / `AGENTS.md` updated if any new patterns or rules emerged
