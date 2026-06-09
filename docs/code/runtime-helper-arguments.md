# Runtime Helper Argument Guidelines

Design note for keeping Cascada runtime helper calls readable, compact, and stable in generated JavaScript.

> **Read first.** Positional arguments are the default. Named object-form records are used only where genuinely warranted (see Decision Boundary). The positional signatures shown here exist in the source; per `AGENTS.md`, prefer current source when docs and implementation disagree -- verify before assuming an object-form API exists.
>
> **On parameter names.** Signature blocks use the real source identifiers where it matters for correctness (e.g. `obj`, `linkedChainNames`, `asyncFn`). Some prose uses domain-friendly aliases (`target`, `key`) for readability. When in doubt, the source is authoritative.
>
> **Related work.** Two concrete cleanups (boundary-body consolidation and readable `CommandBuffer` construction) are tracked in [runtime-helper-arguments-cleanup.md](runtime-helper-arguments-cleanup.md).

Cascada emits a lot of runtime calls. Argument shape trades off three things:

-   **Generated code size and regularity** -- positional arguments are shorter and easier for the compiler to emit.
-   **Runtime correctness** -- long tails of same-shaped values (`context`, `renderState`, `currentBuffer`, `errorContext`) are easy to misorder.
-   **API evolution** -- named objects help when they represent a real runtime concept reused across helpers, not when they wrap a single call.

**Default: positional arguments for compiled-code helpers.** A named object is justified only when one of two decisive thresholds is met (see below). Everything else is a supporting signal, not a trigger.

---

## Decision Boundary

The default is positional. Use a named object only when a **decisive threshold** is met; the **supporting signals** can reinforce that choice but never justify a record on their own.

**Decisive thresholds (either one justifies a named object):**

-   The record is passed through **>=2 helper layers**, or
-   The helper carries **>=3 same-typed nullable infrastructure fields** whose combinations matter.

**Supporting signals (reinforce a record once a threshold is met; not triggers by themselves):**

-   The call contains more infrastructure than domain operands.
-   The helper is structural, lifecycle-oriented, or setup-oriented rather than expression-level.
-   The object is created once and reused through a small subsystem.
-   Adding/removing one field is expected and should not churn every call site.

**Stay positional** when all of these hold (the common case):

-   The helper is emitted directly by the compiler in hot or common generated code.
-   The argument list is stable and normally complete.
-   The arguments are mostly domain operands, not infrastructure.
-   The call reads as an operation: `memberLookupScript(obj, val, errorContext, currentBuffer)`, `callWrapAsync(obj, name, context, args, errorContext, currentBuffer)`.
-   A named object would be allocated only for that one call and not passed onward.

Do **not** reach for a named object just to make one call site look prettier -- that bloats generated code without simplifying the runtime model.

---

## Standard Argument Order

When positional, keep a consistent order -- this matters more than raw argument count:

```text
domain operands, execution context, placement, diagnostics, options
```

1.  **Domain operands** -- values the operation acts on: `target`, `key`, `func`, `funcName`, `args`, `arr`, `loopBody`.
2.  **Execution context** -- usually `context`.
3.  **Placement** -- `currentBuffer`, `parentBuffer`, `linkedChainNames`, `linkedMutatedChainNames`.
4.  **Diagnostics / fatal-state handle** -- `errorContext`; add `renderState` only when the helper needs direct fatal reporting or root-boundary coordination.
5.  **Options** -- booleans, limits, modes, repair flags.

Expression helpers in practice place `errorContext` before `currentBuffer`. That is fine when the local family is consistent:

```js
memberLookupScript(obj, val, errorContext, currentBuffer)
callWrapAsync(obj, name, context, args, errorContext, currentBuffer)
```

Do not permute the same tail within one family:

```js
// Avoid:
helperA(value, context, errorContext, currentBuffer)
helperB(value, context, currentBuffer, errorContext)
helperC(value, errorContext, context, currentBuffer)
```

For new positional helpers, prefer one of:

```js
runtime.expressionHelper(domainA, domainB, context, errorContext, currentBuffer)
runtime.structuralHelper(domainA, domainB, context, currentBuffer, renderState, errorContext, options)
```

Use `renderState` only when needed; many helpers reach fatal state through `errorContext` via `throwReportedFatal(errorContext)`.

---

## Named Object Rules

Treat named objects as small runtime records, not generic bags.

**Good:** clear name and lifecycle; semantically cohesive fields; reused across >=2 helpers or stored briefly by one subsystem; reduces repeated tails; makes optional fields explicit; avoids repeated allocation in tight paths.

**Bad:** called `options` but holds required execution state; contains every runtime variable (`env`, `context`, `runtime`, `renderState`, `currentBuffer`, `errorContext`, plus domain fields); created by generated code for one immediate call; hides ownership of `errorContext` or `currentBuffer`; tempts helpers to depend on fields they don't need.

Objects passed from compiled code must have stable, narrow shapes. Internal runtime-only objects may be more flexible but should still be explicit.

---

## Argument Shapes by Helper Family

Pick the shape by family, not by field count.

### Named objects

-   **Component startup / method / observation** -- component startup passes a named spec into `createComponentInstance`; method dispatch is emitted as `runtime.callComponentMethod({ ... })` and observation as an object-form command ([`src/compiler/component.js`](../../src/compiler/component.js)). Structural, chain-scheduled, and many-fielded -- named objects are correct here. If startup ever splits owner vs target fields, prefer one cohesive spec over two always-recombined objects.
-   **Inheritance lifecycle** -- `{ templateOrScript, env, context, runtime, errorContext, renderState }` and similar. Lifecycle operations with optional state and related handles; keep them separate from a generic execution frame (domain-specific ownership and error-loading rules).
-   **Command constructors / command objects added to buffers** -- named.

### Positional

-   **Expression helpers** -- `memberLookup{Async,Script}(obj, val, errorContext, currentBuffer)`, `callWrapAsync(obj, name, context, args, errorContext, currentBuffer)`, operators. Hot and operand-like; positional is shorter and clearer.
-   **Sequential-path wrappers** -- the four `sequential*Value` wrappers are positional. Their shared `pathKey, repair, currentBuffer, errorContext` tail is centralized in `withSequentialPathChain` ([`sequential.js:12`](../../src/runtime/sequential.js#L12)), so no per-call record is needed.
-   **Loop internals** -- positional; the internal `iterate*` helpers carry `loopVars, errorContext, buffer, asyncOptions` directly.
-   **Async boundaries** -- positional public wrappers; the structural boundary bodies should share one internal helper (not a record). See [runtime-helper-arguments-cleanup.md](runtime-helper-arguments-cleanup.md).

### CommandBuffer construction

Positional constructor (`new CommandBuffer(context, parent, linkedChains, linkTarget, linkedMutatedChains, bufferStackErrorContext, traceParent, renderState)`, [`command-buffer.js`](../../src/runtime/command-buffer.js)). The long, nullable, same-typed list is unreadable at call sites, so an object-form `CommandBuffer.fromSpec({ ... })` factory for runtime-owned construction is warranted; compiler-emitted `new runtime.CommandBuffer(...)` stays positional. Tracked in [runtime-helper-arguments-cleanup.md](runtime-helper-arguments-cleanup.md).

---

## Objects To Avoid

**UniversalRuntimeContext** -- bundling `env, context, runtime, renderState, currentBuffer, errorContext, parentBuffer, linkedChains, linkedMutatedChains` into one object. Too broad: it blurs user context vs runtime module, current buffer vs parent/link target, static vs owned error context, fatal reporting vs value poisoning, and structural setup vs expression evaluation -- and tempts helpers to take more authority than they need.

**Generic `options` for required state** -- `helper(value, { context, currentBuffer, errorContext })` when those fields are required for correctness. `options` should mean *optional behavior*; required state is positional or a named domain record.

**One-off generated objects** -- `runtime.memberLookupScript({ target, key, errorContext, currentBuffer })`. Longer, allocates, creates no reusable meaning.

---

## Compiler Emission Guidance

Emission code lives in [`src/compiler/async-boundaries.js`](../../src/compiler/async-boundaries.js), [`src/compiler/buffer.js`](../../src/compiler/buffer.js), and related modules.

**Prefer inline emit strings.** A literal `runtime.runControlFlowBoundary(parentBuffer, ...)` template shows exactly what is generated. Extract an `emit*` helper only where an *identical* long emit is duplicated across many (5+) sites; at a handful of sites the helper hides the output behind a jump and is not worth it.

**Group repeated expressions locally** -- bind a repeated long expression once (`const ec = __ec[12];`) when it meaningfully reduces repetition or when the context is an owned dynamic clone that must be mutated later.

**Avoid reordering churn** -- standardize families opportunistically; do not churn every call site to match this document unless touching the area anyway or fixing a real bug.

---

## Performance Notes

Named objects are not free: they allocate unless reused/optimized away, can cause hidden-class churn if shapes differ across call sites, and grow generated code when field names repeat. Property reads are cheap but not cheaper than positional locals in hot paths. Use a named object only where it reduces *total* complexity -- not merely where a function has many arguments.

```js
helper(value, key, errorContext, currentBuffer)            // hot helpers: positional
helper({ value, key, currentBuffer, errorContext, mode })  // setup/lifecycle: named
```

---

## Error Context Ownership

`errorContext` is not a generic logging field -- it carries source position, label, path, added diagnostic metadata, and render-state ownership. The general rules live in **`AGENTS.md` -> "Compact Error Context Ownership"**; follow them.

The point specific to *helper arguments*:

-   **A reusable record containing `errorContext` must not be reused after that context is mutated** (via `mergeAddedContext(...)` / `setContextLabel(...)`) unless that reuse is intentional and documented. Static contexts must not be mutated at all; owned dynamic contexts may be, which is exactly why a shared record holding one is hazardous.
-   Do not hide context ownership inside a generic object name -- keep it visible at the signature.
-   A helper needing only fatal-state checks can take just `errorContext` (`throwReportedFatal(errorContext)` reaches render state). A helper reporting fatal structural errors against a buffer stack needs `renderState` plus the relevant buffer/context passed explicitly.

---

## Quick Reference

| Helper type | Shape |
|---|---|
| Expression lookup / call / operator | Positional |
| Promise / value resolution | Positional |
| Sequential path scheduling | Positional (tail centralized in `withSequentialPathChain`) |
| Loop internals | Positional |
| Async boundary lifecycle | Positional; structural bodies share one internal helper |
| Command constructors | Named object |
| Component startup / method / observation | Named object |
| Inheritance lifecycle | Named object |
| CommandBuffer construction | Positional constructor; object-form `fromSpec` only if the args stay long |
| Generic runtime context | Avoid |
