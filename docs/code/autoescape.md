# Autoescape & Output Text Helpers

Here is the full picture of how these functions work, how they relate to autoescape, and what flows into them.

---

## The functions, collected

All defined in `src/runtime/safe-output.js`. Two categories: the ones that run per-output-expression (emitted by the compiler into every `{{ expr }}` site), and the one that runs once at the end of a macro/template body to wrap the final flattened text.

### Per-expression helpers (compiler emits these around every `{{ expr }}`)

| Function | File:lines | Role |
|---|---|---|
| `suppressValueAsync` | `safe-output.js:110` | Main gatekeeper for template `{{ }}` output. Coerces `null`/`undefined` → `""`, HTML-escapes if `autoescape` is on and value is not a `SafeString`. Sync-first hybrid: handles literals and promise-free arrays synchronously, delegates to `_suppressValueAsyncComplex` only when the value is a promise or an array containing promises/poison. |
| `_suppressValueAsyncComplex` | `safe-output.js:151` | The `async` half of the above. Awaits the promise or `Promise.all`s the array, collects poison errors, then applies the same escape logic. |
| `suppressValueScriptAsync` | `safe-output.js:310` | Script-mode variant. Passes through plain objects (unlike template mode which would stringify them). Delegates promises to `_suppressValueScriptAsyncComplex`. |
| `ensureDefinedAsync` | `safe-output.js:238` | Wraps the inner expression when `throwOnUndefined` is enabled. Throws if value is null/undefined. Same sync-first hybrid pattern. Nested *inside* `suppressValueAsync` by the compiler — its return value is the input to `suppressValueAsync`, never reaches the buffer directly. |

### End-of-body wrapper (runs once, on the flattened text string)

| Function | File:lines | Role |
|---|---|---|
| `newSafeStringAsync` | `safe-output.js:36` | Called on the return value of `flattenBuffer()` at the end of every **template** macro/block body (`compiler.js:1000`). Wraps the already-assembled text in a `SafeString` so that if this macro's output is later interpolated into an outer template, it won't be double-escaped. |

---

## Relationship to autoescape

`autoescape` is the environment-wide flag (`env.opts.autoescape`). The compiler passes it literally into every `suppressValue*` call site (`compiler.js:1174`):

```js
await runtime.suppressValueAsync(expr, env.opts.autoescape, errorContext);
```

Inside `suppressValue` (`safe-output.js:100`), the logic is:

```
if (autoescape && value is NOT a SafeString)  →  HTML-escape via lib.escape()
```

`lib.escape` (`lib.js:184`) replaces `& " ' < > \` with their HTML entities.

`SafeString` is the escape hatch: anything wrapped in it (by `markSafe`, `newSafeStringAsync`, or the `| safe` filter) carries a flag that makes it pass through `suppressValue` untouched. This is why `newSafeStringAsync` exists at macro boundaries — the macro already escaped each individual expression when it was output; the assembled string must not be escaped again when the macro result is interpolated into the caller.

---

## What goes into these functions as input

The compiler emits them around the **compiled expression** for each output child in an `Output` node (a `{{ ... }}` in a template, or a bare expression in a script `@text` line). The input is whatever that expression evaluates to at runtime. It can be:

1. **A plain value** — string, number, object. Most common fast path; handled synchronously inline.
2. **A `Promise`** — if the expression involves an async call or an unresolved variable. Awaited inside `_*Complex`.
3. **An array** — when the expression evaluates to a sub-buffer's `.text` or `.output` array (e.g. a nested async block's output that hasn't been flattened yet). `suppressValueAsync` joins it and escapes it directly; see note below on why it does not need to defer.
4. **A `PoisonedValue`** — short-circuits immediately, returned as-is for downstream poison propagation.
5. **A `CommandBuffer`** — returned as-is; the flattener handles it later.

Before any of the above, `normalizeBufferValue` (`safe-output.js:7`) unwraps wrapper objects: if the value has a `.text` or `.output` property that is an array, it extracts that array. `CommandBuffer` instances are explicitly *not* unwrapped here.

---

## Per-expression helpers do not need the deferred function pattern

All three helpers push a function onto an array when they receive one. Only `newSafeStringAsync` actually needs to. The other two have already fully resolved the array by the time they push, so the function is redundant. `ensureDefinedAsync`'s function is worse than redundant — it never executes at all.

**`suppressValueAsync`** — both the sync array path (line 133) and the async path after `Promise.all` (line 186) do `val.join(',')` *before* pushing the escape function. Every item is already a resolved string at that point. The push produces `["joinedText", escapeFn]` which enters the buffer as a nested array; `flattenText` recurses into it, the fn runs, and escaping happens. But the same result would come from simply returning `suppressValue(val.join(','), autoescape)` — a plain escaped string, no nested array, no deferred round-trip.

**`ensureDefinedAsync`** — the compiler nests it *inside* `suppressValueAsync`:

```js
// compiler.js:1157,1161 — generated code structure
await runtime.suppressValueAsync(
  await runtime.ensureDefinedAsync(expr, ...),
  env.opts.autoescape, errorCtx
);
```

`ensureDefinedAsync` appends its validation function to the array (line 265) and returns the array. That array — now containing `[...items, validationFn]` — becomes the input to `suppressValueAsync`. `suppressValueAsync` calls `join(',')` on it, which **stringifies the function** into the output text. The validation function never executes as a deferred transformer. It is dead code in the array path.

---

## The "function item at the end of the array" mechanism — `newSafeStringAsync`

This mechanism is used by `newSafeStringAsync` and only `newSafeStringAsync`. It is the outermost wrapper on `flattenBuffer`'s return value at macro/block boundaries — nothing downstream joins or processes the array further.

In composition mode `flattenBuffer` returns the raw output array, which may still contain unresolved promises. `newSafeStringAsync` cannot eagerly join and wrap: items are not yet settled. So it appends a deferred transformer:

```js
// safe-output.js:40-42
val.push((v) => {
  return new SafeString(v, lineno, colno);
});
```

The array (with the function at the end) is returned to the caller and eventually processed by `flattenText` (`src/runtime/flatten-text.js`), which does a `.reduce()` over every item. When it hits a function item (`flatten-text.js:60-61`):

```js
if (typeof value === 'function') {
  return (value(acc) || '');  // acc = the string accumulated so far from all prior items
}
```

It calls the function with `acc` — the **already-joined text of all preceding items in that array**. The function wraps that text in `SafeString` and returns it as the new accumulator.

So the function item is not applied to its own value — it is applied to the **merged text of everything before it in the array**.

---

## Examples

### Template: `suppressValueAsync` receives an array

```njk
{% set greeting = asyncGetGreeting() %}
{% set name = asyncGetName() %}
Hello {{ greeting }}, {{ name }}!
```

Each `{{ }}` compiles to:

```js
// compiled pseudocode (simplified)
let t1 = await runtime.suppressValueAsync(greeting, env.opts.autoescape, ctx);
let t2 = await runtime.suppressValueAsync(name, env.opts.autoescape, ctx);
```

If `greeting` resolves to a plain string `"<b>Hi</b>"`, `suppressValueAsync` takes the fast path and returns `"&lt;b&gt;Hi&lt;/b&gt;"` synchronously. No array involved.

If `greeting` is a raw output array `["<b>", Promise<"Hi">, "</b>"]` from a nested async block, `suppressValueAsync` delegates to `_suppressValueAsyncComplex`, which does `Promise.all`, joins to `"<b>Hi</b>"`, then — unnecessarily — pushes the escape function, producing `["<b>Hi</b>", escapeFn]`. `flattenText` recurses into that nested array and the fn runs. But `suppressValueAsync` already had the joined string in hand. It could have just returned `suppressValue("<b>Hi</b>", true)` directly.

### Macro: `newSafeStringAsync` defers legitimately

```
macro renderCard(title, body) : text
  var titleHtml = formatTitle(title)
  var bodyHtml = formatBody(body)
  @text("<div class='card'>")
  @text(titleHtml)
  @text(bodyHtml)
  @text("</div>")
  return text.snapshot()
endmacro

var card = renderCard("Hello", "World")
@text(card)
```

The macro body compiles with its own `CommandBuffer`. Each `@text(...)` adds an item to the buffer's `text` array. At the macro's `return`, the compiler emits (`compiler.js:996-1003`):

```js
return astate.waitAllClosures().then(() => {
  return runtime.newSafeStringAsync(runtime.flattenBuffer(output));
});
```

`flattenBuffer` resolves the `CommandBuffer` — if all promises are settled it returns the joined string `"<div class='card'>HelloWorld</div>"` directly. `newSafeStringAsync` receives that string, takes the non-array branch, and returns `new SafeString(...)`.

If `flattenBuffer` returns a **promise** (some items still pending), `newSafeStringAsync` takes the promise branch and returns `(async (v) => new SafeString(await v))(val)` — awaits, then wraps.

If `flattenBuffer` returns a **raw array** (composition mode, where the buffer is handed back to a parent un-flattened), `newSafeStringAsync` appends the `SafeString` constructor as a deferred function:

```
array: ["<div class='card'>", Promise<"Hello">, "World", "</div>",
        (v) => new SafeString(v)]
```

When the parent's `flattenText` processes this array, it joins and resolves all the text items first, then hits the function at the end, which wraps the entire assembled string in `SafeString` — preventing double-escape when the macro result is interpolated into the outer template via `{{ card }}`.
