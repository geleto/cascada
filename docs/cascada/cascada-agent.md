# Cascada Agent Reference

AI-optimized reference for **Cascada Script** and **Cascada Template** code generation. Cascada is parallel-by-default; familiar syntax, unfamiliar execution model.

**Modes covered (do not cross-translate constructs between them):**
- **Script** — logic/data orchestration, channel declarations, explicit `return`.
- **Template** — Nunjucks-compatible text generation with `{{ }}` and `{% %}`.

**Core differentials (vs JS/Python/Nunjucks baseline):**
1. Independent statements/expression parts/loop iterations run **concurrently by default**; an op only waits when it depends on another's result.
2. Errors are **data** (`PoisonedValue`) — they propagate through dependents while unrelated work continues. No `try/catch`.
3. **Channels** (`data`, `text`, `sequence`) collect concurrent writes and assemble the final value in source-code order.
4. `!` marker enforces **sequential order** on a static context path; `each` iterates sequentially; `while` is sequential.
5. Block-local scoping for `if`/`for`/`each`/`while`/`switch`; `var` declared inside is invisible outside.

**UID schema:** `[CATEGORY-NN]`. Categories: LANG, VAR, EXPR, CTRL, LOOP, CHAN, DATA, TEXT, SEQ, SEQOP, FUNC, CALL, ERR, GUARD, COMP, IMP, EXT, METH, COMPONENT, TPL, API.

---

## Sigil / Operator Table (Differentials)

| Symbol | Mode | Meaning | UID |
|:---|:---|:---|:---|
| `!` | both | Sequence lock on static context path; serializes calls on that path | SEQOP-01 |
| `!!` | both | Repair poisoned sequence path (clear poison) | ERR-10 |
| `!!.method()` | both | Repair then execute | ERR-11 |
| `#` | both | Peek operator: read property of an Error Value without propagating | ERR-06 |
| `is error` / `is not error` | both | Test whether a value is poisoned | ERR-05 |
| `r/regex/` | both | Regex literal prefix | EXPR-04 |
| `a if c else b` | both | Inline conditional (Python-style only; **not** `c ? a : b`) | EXPR-03 |
| `//`, `**` | both | Integer division, exponentiation | EXPR-01 |
| `and`, `or`, `not` | both | Boolean operators (word form only — not `&&`/`\|\|`/`!`) | EXPR-02 |
| `none` | both | Null literal (Python-style; **not** `null`) | LANG-02 |
| `\|` | both | Filter pipeline | EXPR-05 |

---

## Core Execution Model (Invariants)

- **[EXEC-01]** Every independent operation (assignment, function call, expression operand, loop iteration) starts immediately; it waits only on its inputs.
- **[EXEC-02]** Outputs are deterministic: writes execute concurrently but the assembled result equals what sequential execution would produce.
- **[EXEC-03]** Errors are values (`PoisonedValue`). Propagation rules are conservative — see ERR-* atoms.
- **[EXEC-04]** Each block (`if`, `for`/`each`/`while`, `switch` case, function body) gets its own isolated scope.
- **[EXEC-05]** Composition boundaries (`import`, `include`, `extends`, `component`, function call) are isolated; only declared inputs cross.
- **[EXEC-06]** Sequential ordering is opt-in: `!` (path), `each` (loop), `sequence` (channel), `while` (loop).

---

# Semantic Library — Script Mode

## LANG — Language Fundamentals

```javascript
// [LANG-01] RULE: Standalone expressions are valid statements (any line that isn't a recognized command).
// ✅ Valid:
computeTotal(items, tax)
// ❌ Invalid: undeclared assignment - see VAR-02

// [LANG-02] RULE: `none` is the null literal. Variables declared without value default to `none`.
var report                 // = none
return none

// [LANG-03] RULE: Multiline expressions auto-continue across lines when syntactically incomplete.
var result = 5 + 10 *
  20 - 3

// [LANG-04] RULE: SCRIPT comments are JS-style — `// line` and `/* block */`.
// CONSTRAINT: Templates use `{# ... #}` instead — see TPL-03.

// [LANG-05] RULE: Property access on `none`/null produces an Error Value (poisoning).
// DIFFERENTIAL: Differs from JS `TypeError` throw.
var report             // = none
var title = report.title    // ❌ title is an Error Value
return title                // ❌ script fails
```

## VAR — Variables, Assignment, Scope

```javascript
// [VAR-01] RULE: `var name = value` declares; `name = value` reassigns. Both work for tuples.
// CONSTRAINT: Re-declaring a name visible in any enclosing scope is a compile-time error.
var name = "Alice"
name = "Bob"            // ✅ reassign declared var
var a, b = 100          // ✅ multiple decls, single value
a, b = 200              // ✅ multi-assign existing vars

// ❌ Invalid:
username = "C"   // ERROR: not declared with var

// [VAR-02] RULE: Assignment to undeclared name is a compile-time error (no implicit globals).
// ❌ Invalid:
foo = 1          // ERROR

// [VAR-03] RULE: Variables declared in `if`/`for`/`each`/`while`/`switch` blocks are local to that block.
// DIFFERENTIAL: Differs from JS `var` hoisting. To use across block boundary, declare in outer scope.
if cond
  var local = "x"
endif
// local is undefined here

var status = "default"
if cond
  status = "updated"   // writes to outer
endif

// [VAR-04] RULE: Inner scope cannot re-declare a name visible in outer scope.
// ❌ Invalid:
var item = "p"
for i in range(2)
  var item = "c"     // ERROR: shadowing forbidden
endfor

// [VAR-05] RULE: Assignment performs a logical deep copy — variables are independent.
// DIFFERENTIAL: Differs from JS reference semantics on objects/arrays.
var a = {x: 1}
var b = a
a.x = 10
// b.x === 1

// [VAR-06] RULE: Property assignment is allowed: `obj.prop = expr`, `arr[i] = expr`.
// CONSTRAINT: Script-only — NOT available in templates.
var point = {x: 1, y: 2}
point.x = 10
items[0] = 100

// [VAR-07] RULE: Reading a property whose value is async waits; sibling reads do not.
var p = {x: 1, y: 2}
p.x = slowApiCall()
return { x: p.x, y: p.y }   // p.x waits, p.y resolved

// [VAR-08] RULE: Context (the JS object passed to render) is read-only from script code.
// To mutate, copy into a local var first.
// ❌ Invalid:
appConfig.debug = true        // ERROR
// ✅ Valid:
var config = appConfig
config.debug = true
```

## EXPR — Operators & Literals

```javascript
// [EXPR-01] RULE: Arithmetic — `+ - * / // % **`. Comparisons — `== != === !== > >= < <=`.
// DIFFERENTIAL: `//` is integer division; `**` is exponentiation.

// [EXPR-02] RULE: Boolean ops use words `and`, `or`, `not` (no `&&`, `||`, `!`).
if user.role == "Admin" and not user.isSuspended
endif

// [EXPR-03] RULE: Inline conditional uses Python-style `a if c else b`.
// ❌ Invalid: c ? a : b (NOT supported)
var theme = "dark" if user.darkMode else "light"

// [EXPR-04] RULE: Regex literals use `r` prefix.
var re = r/^\w+$/
if re.test(s)
endif

// [EXPR-05] RULE: Filters apply with `|` operator: `value | filter` or `value | filter(arg)`.
// Filters and globals come from Nunjucks built-ins.
var t = "hi" | upper
var s = items | join(", ")

// [EXPR-06] RULE: Object literal uses explicit `{key: expr}`; array literal uses `[a, b]`.
var name = "Ada"
var p = { id: 1, name: name, "k-2": 100 }
var a = [1, "x", true]
// âŒ Invalid: JS shorthand object keys are NOT supported.
var bad = { name }

// [EXPR-07] RULE: Member access `obj.prop` or `arr[i]`; works in expression position.

// [EXPR-08] RULE: Nunjucks built-in `cycler(...items)` is STATEFUL — its `.next()` method must be called
// in source order. Use it inside an `each` loop (sequential), not a concurrent `for`.
// DIFFERENTIAL: Calling cycler.next() concurrently produces non-deterministic ordering.
data rows = []
var rowClass = cycler("even", "odd")
each item in items
  rows.push({ class: rowClass.next(), value: item })
endeach

// [EXPR-09] RULE: Nunjucks built-in `joiner([sep])` is STATEFUL — first call returns `""`,
// subsequent calls return `sep` (default `","`).
// CONSTRAINT: Call it in sequential context (`each`) when output order matters.
var comma = joiner(", ")
var output = ""
each tag in tags
  output = output + comma() + tag
endeach
```

## LOOP — Loops

```javascript
// [LOOP-01] RULE: `for item in iter` runs all iterations CONCURRENTLY.
// DIFFERENTIAL: Source-order side effects on shared `var` are race-prone — use channels/each/!.
for id in ids
  var u = fetchUser(id)
endfor

// [LOOP-02] RULE: `for ... of N` limits concurrency to N (`of` clause = expression).
// CONSTRAINT: `of N` is ignored for plain objects.
for item in coll of 5
  processItem(item)
endfor

// [LOOP-03] RULE: Iteration shapes: `for x in arr`, `for k, v in obj`, `for x, y, z in arrayPairs`, `for x in asyncIter`.
for k, v in food
  log("Use " + v + " of " + k)
endfor

// [LOOP-04] RULE: `else` block in `for` runs only when iterable is empty.
for item in []
  // ...
else
  log("empty")
endfor

// [LOOP-05] RULE: `each item in coll` iterates SEQUENTIALLY (one finishes before next starts).
each id in ids
  items.push(fetchItem(id))   // safe vs concurrent for-loop
endeach

// [LOOP-06] RULE: `while cond` runs SEQUENTIALLY; condition re-evaluated only after the body completes.
while attempts < 3
endwhile

// [LOOP-07] RULE: Loop body has access to `loop` variable.
// Always-available: loop.index (1-based), loop.index0, loop.first.
// Length-dependent: loop.length, loop.last, loop.revindex, loop.revindex0.
// Availability matrix:
//   Arrays / Objects (any loop mode):                            ✅ always
//   Unbounded concurrent async iter (`for x in iter`):           ✅ resolved asynchronously after stream ends
//   `each` over async iter / bounded `for ... of N` async iter:  ❌ unavailable (would deadlock the iter)
//   `while`:                                                     ❌ never (total unknown until done)

// [LOOP-08] RULE: Mutating an outer `var` from concurrent `for` iterations races (last writer wins).
// Use `data` channel, `each`, or `!` instead.
// ❌ Unsafe:
var items = []
for id in ids
  items.push(fetchItem(id))   // concurrent race
endfor
// ✅ Use data channel:
data result
for id in ids
  result.items.push(fetchItem(id))
endfor
return result.snapshot()
```

## CTRL — Conditionals & Switch

```javascript
// [CTRL-01] RULE: SCRIPTS use `if / elif / else / endif` (keyword `elif`).
// CONSTRAINT: Templates use `{% elseif %}` instead of `elif` — see TPL-12.
if a
elif b
else
endif

// [CTRL-02] RULE: `switch expr / case v / default / endswitch`. NO fall-through; NO `break`.
// DIFFERENTIAL: Each case exits automatically; `default` matches when no case did.
switch s
case "a"
  // ...
case "b"
  // ...
default
  // ...
endswitch

// (Block-local scoping for if/switch branches — see VAR-03 / EXEC-04)
```

## CHAN — Channels (Overview)

```javascript
// [CHAN-01] RULE: Channels collect writes from concurrent code and assemble in source-code order.
// DIFFERENTIAL: Writes execute concurrently; the assembled result is deterministic.
// Three types: `data` (structured), `text` (string), `sequence` (external object, sequential).

// [CHAN-02] RULE: Read assembled value with `name.snapshot()`.
// CONSTRAINT: snapshot() waits for pending writes — more expensive than reading a `var`.
data out
out.x = 1
return out.snapshot()

// [CHAN-03] RULE: Channel declarations cannot cross composition boundaries.
// Only `var` may be passed via `with`; `data`/`text`/`sequence` cannot.

// [CHAN-04] RULE: Channels declared inside a function are local to that function.
```

## TEXT — Text Channel

```javascript
// [TEXT-01] RULE: Declare with `text name`. Two write forms.
text log
log("appended\n")        // append
log = "replaces all"     // overwrite
return log.snapshot()
```

## DATA — Data Channel

```javascript
// [DATA-01] RULE: Declare with `data name`. Build via path-based commands; `.snapshot()` returns plain object.
data out
out.user.name = "Alice"
out.user.roles.push("editor")
return out.snapshot()

// [DATA-02] RULE: Auto-initialization — Objects, Arrays, and Strings (string ops only) are created on first write.
// Numbers and Booleans are NOT auto-initialized — must be assigned explicitly first.
// ❌ Invalid:
data o
o.count++              // ERROR: count is none
// ✅ Valid:
data o
o.count = 0
o.count++

// [DATA-03] RULE: Path commands — assignment/deletion/array/object/arith/string/logic/bitwise.
// Assign:    name.path = value             // shorthand for set
//            name.path.delete()
// Array:     push, concat, pop, shift, unshift, reverse, at(i), sort, sortWith(fn), arraySlice(s,[e])
// Object:    merge(v) (shallow), deepMerge(v)
// Arith:     +=, -=, *=, /=, ++, --, .min(v), .max(v)   (number target required)
// String:    +=, .append, .toUpperCase, .toLowerCase, .slice, .substring, .trim, .trimStart, .trimEnd,
//            .replace(f,r), .replaceAll(f,r), .split([sep]), .charAt(i), .repeat(n)
// Logic/bit: &&=, ||=, &=, |=, .not(), .bitNot()

// [DATA-04] RULE: Paths can include variables and expressions (dynamic paths).
for u in users
  result.report.users[u.id].status = "ok"
endfor

// [DATA-05] RULE: Empty bracket `path[]` refers to the last item appended in source order.
result.users.push({ name: "Charlie" })
result.users[].permissions.push("read")   // affects Charlie

// [DATA-06] RULE: Root-level replacement — assign directly to the channel name.
data result
result = { status: "complete" }
result = []                  // change type
result.push("first")

// [DATA-07] RULE: Structure-building methods (push, merge, append) auto-create the missing path.
// Arithmetic/logical operators (+=, --, &&=) THROW a runtime error on `none`/missing target.

// [DATA-08] RULE: Custom data methods via `env.addDataMethods({ name: (target, ...args) => newValue })`.
// Return value REPLACES target; returning `undefined` DELETES the path.
// Operator-method mapping: =→set, +=→add, -=→subtract, *=→multiply, /=→divide,
//   ++→increment, --→decrement, &&=→and, ||=→or, &=→bitAnd, |=→bitOr.

// [DATA-09] RULE: Data channels optimize for ordered assembly, not raw mutation speed.
// Many fine-grained writes on large nested structures may be slower than building a plain object once.
```

## SEQ — Sequence Channel

```javascript
// [SEQ-01] RULE: Declare with `sequence name = initializer`. Wraps an external object with strictly sequential access.
// CONSTRAINT: Initializer MUST come from the context object (not a local var).
sequence db = services.db
var user = db.getUser(1)              // value-returning call
var state = db.connectionState        // property read
var id = db.api.client.getId()        // nested sub-path
var snap = db.snapshot()

// [SEQ-02] RULE: Property ASSIGNMENT on a `sequence` is a compile error.
// ❌ Invalid:
sequence db = services.db
db.connectionState = "offline"   // ERROR

// [SEQ-03] RULE: A poisoned sequence is recovered with `guard` (see GUARD-*).

// [SEQ-04] DIFFERENTIAL: `sequence` vs `!`:
// `sequence` = declared channel; ordered reads/calls on one object; values flow back into normal exprs.
// `!` = marker on a static context path; orders side-effects on that path.
```

## SEQOP — `!` Sequential Operator (Path Lock)

```javascript
// [SEQOP-01] RULE: `path!.method()` enforces strict execution order on that path.
// Once any call on the path uses `!`, ALL subsequent calls on the same path (with or without `!`) wait.
bank.account!.deposit(100)
bank.account.getStatus()        // also waits
bank.account!.withdraw(50)

// [SEQOP-02] RULE: Method-specific sequencing — `obj.method!(args)`.
// CONSTRAINT: Unmarked calls to the SAME method (`obj.method(...)`) do NOT wait. Differs from path-level !.
logger.log!("a")
logger.log!("b")
logger.getStatus()      // unaffected

// [SEQOP-03] RULE: `!` paths must reference CONTEXT objects, not local vars.
// CONSTRAINT: Engine uses object identity from context. Function-parameter pass-through is NOT yet supported.
// ✅ Valid: db!.insert(d)         // db from context
// ✅ Valid: services.database!.insert(d)
// ❌ Invalid:
var database = db
database!.insert(d)     // ERROR

```

## FUNC — Functions

```javascript
// [FUNC-01] RULE: Declare with `function name(args) ... endfunction`. Returns via `return`.
// CONSTRAINT: Isolated scope — does NOT see caller locals.
// If no return runs, returns `none`. Channels declared inside are local.
function buildDept(deptId)
  var manager = fetchManager(deptId)   // concurrent
  var team = fetchTeamMembers(deptId)
  return { manager: manager.name, teamSize: team.length }
endfunction
var d = buildDept("sales")

// [FUNC-02] RULE: Default values and keyword arguments supported.
function input(name, value="", type="text")
  return { name: name, value: value, type: type }
endfunction
var f = input("pass", type="password")

// [FUNC-03] RULE: Functions cannot dispatch via `this.method(...)` and cannot access shared state.
// (Methods do — see METH-*).

// [FUNC-04] RULE: Channels themselves are not returned directly; return `ch.snapshot()`.
```

## CALL — Call Blocks

```javascript
// [CALL-01] RULE: Script `call` blocks REQUIRE assignment form (`var x = call ...` or `x = call ...`).
// Bare `call` (no assignment) is unsupported in scripts.
// CONSTRAINT: Function controls invocation via `caller(args)`; param list declared on call block header.
function grid(rows, cols)
  data cells = []
  for y in range(rows)
    for x in range(cols)
      var c = caller(x, y)
      cells.push(c)
    endfor
  endfor
  return cells.snapshot()
endfunction

var g = call grid(3, 3)
  (x, y)
  return { pos: [x, y], v: x*10 + y }
endcall
var x
x = call grid(1, 1)
  return "ok"
endcall

// [CALL-02] RULE: If no parameters, `()` after `call` header is omitted.
var r = call wrapper(args)
  return value
endcall

// [CALL-03] RULE: Call block reads from CALLER scope (where it was written), not function's scope.
// Writes inside the call block stay LOCAL — they do NOT propagate to the parent.
// The function only sees what `caller()` returns.
```

## ERR — Errors as Data (Poisoning)

```javascript
// [ERR-01] RULE: Failed operations produce an Error Value (PoisonedValue).
// Operations whose inputs are errors evaluate to that error (propagation).
// DIFFERENTIAL: No try/catch. Errors flow with data; unrelated work continues.
var posts = fetchPosts(123)        // may fail
var n = posts.length               // ❌ becomes error if posts is error
var ok = comments.length           // ✅ unaffected

// [ERR-02] RULE: If `if`/`switch` condition is an error, NO branch runs and ALL vars/channels that ANY branch
// would have modified become poisoned.
var accessLevel
if user.role == "admin"            // user may be error
  accessLevel = "full"
else
  accessLevel = "limited"
endif
// if user is error → accessLevel is poisoned

// [ERR-03] RULE: If a loop's iterable is an error, body is skipped; vars/channels the body would have
// modified become poisoned.

// [ERR-04] RULE: A script fails ONLY if the final returned value is an Error Value.
// Internal poison is allowed if repaired or not returned.
var u = fetchUser(999)     // error
if u is error
  u = { name: "Guest" }    // repaired
endif
return u.name              // ✅ "Guest"

// [ERR-05] RULE: `is error` / `is not error` test whether a value is an Error Value.
if u is error
  u = fallback
endif

// [ERR-06] RULE: `value#prop` peeks INSIDE an Error Value (avoids propagation).
// CONSTRAINT: `x#` returns `none` when x is not an error — always check `is error` first.
if failed is error
  var msg = failed#message
  var origin = failed#source.origin
endif

// [ERR-07] RULE: Error Value shape (peek with #):
//   #errors — array of { message, name, lineno, colno, path, operation, cause }
//   #message — concatenation of individual messages
// Multiple concurrent failures aggregate into a single PoisonError holding all.

// [ERR-08] RULE: Functions still receive Error Value arguments — the function can detect/repair.
function processData(v)
  if v is error
    return "fallback"
  endif
  return v.name
endfunction

// [ERR-09] RULE: Writing an Error Value into a channel POISONS the channel; reading/returning fails the script.

// [ERR-10] RULE: `path!!` (alone) repairs a poisoned sequential path — clears poison.
context.db!.insert(d)   // fails → path poisoned
context.db!!            // path repaired
context.db!.insert(d2)  // runs

// [ERR-11] RULE: `path!!.method(args)` repairs THEN executes (always-run cleanup pattern).
context.fileSystem!.writeData(d)   // may fail
context.fileSystem!!.close()       // runs regardless

// [ERR-12] RULE: A failure on a `!` path POISONS the path; later `!` calls on it return error immediately
// without executing.
context.db!.connect()       // fails
context.db!.insert(r)       // skipped, returns error
context.db!.commit()        // skipped, returns error

// [ERR-13] RULE: `path! is error` checks if a `!` path is currently poisoned.
if context.api! is error
  var msg = context.api!#message
  context.api!!
endif
```

## GUARD — Transactional Recovery

```javascript
// [GUARD-01] RULE: `guard [selectors] / [recover [err]] / endguard` — transaction-like block.
// On error, protected state is RESTORED before recover runs. recover is OPTIONAL.
guard
  out.status = "processing"
  db!.insert(user)
  db!.update(account)         // ❌ fails
  db!.commit()
  out.status = "success"
recover err
  // out reverted; db! repaired
  db!.rollback()
  out.error = err#message
endguard

// [GUARD-02] RULE: Default `guard` (no selectors) protects:
//   1. ALL channels (data, text, sequence) — writes inside discarded on error.
//   2. ALL `!` paths touched inside — auto-repaired with `!!`.
// Variables NOT protected by default.
// `sequence` channel guard uses optional begin()/commit()/rollback() hooks if present on underlying object.
// Hook errors become guard errors. Missing hooks tolerated.

// [GUARD-03] RULE: Selectors:
//   guard          → channels + ! paths touched (default)
//   guard *        → everything (vars + channels + ! paths)         CANNOT be combined
//   guard var      → all variables written inside
//   guard data     → all data channels touched
//   guard text     → all text channels touched
//   guard sequence → all sequence channels touched
//   guard name1, name2  → specific channels or vars by name
//   guard lock!    → specific ! path
//   guard !        → all ! paths touched
// CONSTRAINT: duplicates are invalid; lock selectors (lock!, !) are for ! paths, not sequence channels.

// [GUARD-04] RULE: ! path protection is HIERARCHICAL — guarding `api!` also covers `api.db!`, `api.connection!`, etc.
guard api!
  api!.connect()
  api.db!.insert(d)
  api.connection!.setState(s)
endguard

// [GUARD-05] RULE: `recover [err]` runs ONLY if guard finishes poisoned. The optional `err` binds the
// final PoisonError (use `#` to inspect). Bare `recover` is also valid.
// If all errors were detected and repaired inside the guard via `is error`, guard is successful — no recovery.

// [GUARD-06] RULE (PERFORMANCE): Variable protection (via `guard *` or explicit names) makes any code
// depending on those variables WAIT for the guard to finish. Use `guard *` only for small scopes.

// [GUARD-07] RULE: `revert` — manually reset channel state inside a guard. Work-in-progress for scripts;
// available in templates: `{% revert %}`.
```

## IMP — Importing Libraries

```javascript
// [IMP-01] RULE: `import "file" as ns` binds the library namespace; functions called via `ns.fn(...)`.
import "formatters.script" as fmt
return fmt.formatUser(user)

// [IMP-02] RULE: `from "file" import name1, name2` pulls specific names directly into caller scope.
from "formatters.script" import formatUser
return formatUser(user)

// [IMP-03] RULE: Public root-scope decls export by default. Names starting with `_` are private.
// Exported non-`shared` channel decls expose their final SNAPSHOT (assembled value), not the channel object.
// `shared` decls are not exposed via import — they belong to extends/component state via `this.<name>`.

// [IMP-04] RULE: `import ... with [forms]` passes a composition payload. See COMP-* for `with` rules.
import "formatters.script" as fmt with locale
import "formatters.script" as fmt with context
import "formatters.script" as fmt with context, locale
```

## COMP — Composition Payload (`with`)

```javascript
// [COMP-01] RULE: `with var1, var2, ...` — passes named parent vars BY VALUE into child as bare-name inputs.
// CONSTRAINT: Only `var` declarations can be listed; data/text/sequence cannot cross.

// [COMP-02] RULE: `with { key: expr, ... }` — explicit object literal; keys become bare-name inputs.
// Merged AFTER named-var entries; overrides on key collision.

// [COMP-03] RULE: `with context` — exposes RENDER CONTEXT to bare-name lookups inside the child.
// Does NOT expose parent locals or channels. Does NOT create a `context` variable inside the child.

// [COMP-04] RULE: `without context` — explicitly opts out of render-context access.

// [COMP-05] RULE: Forms combine: `with context, var1, { extra: computed() }`.

// [COMP-06] RULE: Resolution order inside the composed file:
//   explicit `with` value  →  `with context` lookup  →  ordinary globals/unknown-name behavior.
import "f.script" as fmt with context, locale
// locale → satisfied by explicit var; other bare names look up in context
```

## EXT — Extends / Method / Shared / Super

```javascript
// [EXT-01] RULE: `extends "file"` declares inheritance. Render the CHILD; base constructor runs as part of chain.
// extends "expr" if cond else none — conditional extends; `none` means root of own chain.
// Composition payload via `extends "f" with [forms]` — same forms as `component`/`import`.

// [EXT-02] RULE: Only `shared` declarations are allowed BEFORE `extends`. Plain `var` before extends is a compile error.

// [EXT-03] RULE: `shared` declares chain-owned state, accessed via `this.<name>` from constructors/methods.
// Forms:
//   shared var x = expr        // shared variable; this.x reads/writes
//   shared var x               // declares participation only — no default claimed
//   shared data x              // shared data channel; this.x.path = v / this.x.cmd(args)
//   shared text x              // shared text channel; this.x("msg") to append
//   shared sequence db = expr  // shared sequence with initializer
//   shared sequence db         // declares participation only

// [EXT-04] RULE: PER-FILE declaration requirement — every file using `this.<name>` must declare it locally.
// CONSTRAINT: Compiler infers channel type from THIS file. Parent decls do not extend to child files.

// [EXT-05] RULE: Shared default priority — first encountered in CHILD-to-PARENT startup order wins.
// Only initializer forms claim defaults. Later ancestor defaults are NOT evaluated.
// Shared default expressions can read composition payload.

// [EXT-06] RULE: Bare assignment to a declared shared name is a compile error. Use `this.name = value`.
// Bare name lookup follows ordinary ambient lookup (context/globals/payload) — does NOT read shared.
// Re-declaring shared with a DIFFERENT type is fatal; same type is no-op.

// [EXT-07] RULE: `this.<name>` access forms (any channel type):
//   this.x                 → var read (implicit snapshot) | data/text/sequence: depends on channel type
//   this.x = v             → var write
//   this.x.a.b             → var: read then property lookup
//   this.x("msg")          → text: append
//   this.x.path = v        → data: set
//   this.x.cmd(args)       → data: command call
//   this.x.method(args)    → sequence: ordered call
//   this.x.snapshot()      → any: explicit snapshot
//   this.x is error        → any: poison check
//   this.x#                → any: peek error

// [METH-01] RULE: `method name(args) ... endmethod` defines an override point. Call via `this.name(...)`.
// CONSTRAINT: `this.method` without `(...)` is a compile error — must be a CALL.
// Bare `name(...)` is an ordinary call, NOT inheritance dispatch.

// [METH-02] RULE: Every overriding method declares its own argument list. Methods read/write shared via this.
// CONSTRAINT: Constructor-local vars (declared after `extends`) are NOT visible inside method bodies.
// Composition payload accessible by bare name.

// [METH-03] RULE: `super()` calls the parent's method with the ORIGINAL invocation arguments.
// `super(args...)` lets the child pass DIFFERENT arguments.
// In direct-render mode, super() returns the parent constructor's return value to the calling body.

// [METH-04] RULE: `method name(args) with context` exposes render-context bare names inside the body.
// CONSTRAINT: Contract is INHERITED by overrides automatically — child does not re-declare with context.
// Default is "without context".

// [EXT-08] RULE: Constructor = the script body (after `extends`). Most-derived child runs first; ancestor
// constructors run only when `super()` is reached. If no executable body after `extends`, no local
// constructor — inherited dispatch finds nearest ancestor's body.
// `extends` is an async boundary: body executes after chain setup and shared metadata registration.

// [EXT-09] RULE: Direct render returns the active constructor entry's `return` value
// (child's local body if present; otherwise inherited constructor).

// [EXT-10] RULE: At root of chain, calling `this.method(...)` for a method NOT registered during bootstrap
// is a fatal structural error.
// Declaration-only `shared var x` (no initializer) at root resolves to `none`.

// [EXT-11] RULE: Multiple inheritance is NOT supported — one parent per `extends`.
```

## COMPONENT — Component Instances

```javascript
// [COMPONENT-01] RULE: `component "file" as name [with forms]` creates an INDEPENDENT INSTANCE of a script
// hierarchy with its own shared state, constructor run, and method dispatch table.
// CONSTRAINT: Components are NOT ordinary `var` values; they only live under their `as` binding.
// `component` is a dedicated keyword (distinct from `import`).
component "widget.script" as header with { initialTheme: "dark" }
component "widget.script" as footer with context

// [COMPONENT-02] RULE: Multiple instantiations of the same script are FULLY INDEPENDENT — separate state,
// separate methods, separate execution.
component "btn.script" as save with { label: "Save" }
component "btn.script" as cancel with { label: "Cancel" }

// [COMPONENT-03] RULE: Method calls return values directly: `ns.method(...)` returns the method's return value.
var h = header.render("Header")

// [COMPONENT-04] RULE: Caller may OBSERVE shared channels via the binding (READ-ONLY):
//   ns.var               // shared var snapshot (implicit)
//   ns.var.prop          // implicit snapshot then property lookup
//   ns.ch.snapshot()     // explicit snapshot (required for shared text/data/sequence)
//   ns.ch is error
//   ns.ch#
// CONSTRAINT: Writes from caller are NOT allowed. Names starting with `_` are private (not observable).
// Anything else is a compile error.
// Implicit snapshot only applies to shared `var` channels — for text/data/sequence call `.snapshot()` explicitly.

// [COMPONENT-05] RULE: Component constructor return is IGNORED in component mode (vs direct-render which uses it).

// [COMPONENT-06] RULE: `with` forms supported (mirrors `extends`):
//   with context
//   with var1, var2
//   with context, var1, var2
//   with { key: expr }
//   with context, { key: expr }
// `with var1, var2` shorthand = capture caller-scope var values by their existing names. Limited to var values.

// [COMPONENT-07] RULE: Payload does NOT override shared defaults.
// `with { x: v }` does NOT write into `shared var x`. Payload keys and shared names are independent namespaces.
// To initialize shared from payload, read the payload key in the shared default expression
// (e.g. `shared var theme = initialTheme or "light"`).

// [COMPONENT-08] RULE: Payload flows UPWARD through the inheritance chain unchanged.
```

## RETURN — Return Statements

```javascript
// [RETURN-01] RULE: `return [expr]` shapes the producing value of script/function/method/call block.
// After return runs, later statements in that callable are SKIPPED.
return 42
return                  // bare — JS API resolves null
return none             // explicit null
return user
return { name: u.name }
data r
r.x = 1
return r.snapshot()     // capture channel value

// [RETURN-02] RULE: If no return runs (or bare return), JS API resolves with `null` (= Cascada `none`).

// [RETURN-03] RULE: Use plain var/literal returns when possible. Use `data`/`text`/`sequence` + snapshot
// when ordered writes / structured path updates / sequence behavior are needed.
```

---

# Semantic Library — Template Mode

Templates are Nunjucks-compatible. Differentials below; full Nunjucks reference applies.

```nunjucks
{# [TPL-01] RULE: Text outside tags renders as output. {{ expr }} interpolates a value. #}
Hello {{ user.name }}

{# [TPL-02] RULE: Logic in {% %} tags. Variable decl/assign uses `{% set %}` — NOT `var`/`=`. #}
{% set count = count + 1 %}
{% set x, y = none %}

{# [TPL-03] RULE: Comments use {# ... #}. JS-style // and /* */ are NOT template comments. #}

{# [TPL-04] RULE: Channels (`data`/`text`/`sequence`) are SCRIPT-ONLY. Templates only output text. #}

{# [TPL-05] RULE: Property assignment (obj.prop = v) is SCRIPT-ONLY.
   To change a property in templates, reassign the whole var with {% set %}. #}

{# [TPL-06] RULE: Standalone calls and `!!` repair must use `{% do %}` (no implicit do). #}
{% do service.notify(user) %}
{% do user.profile!! %}

{# [TPL-07] RULE: Block assignment captures rendered text into a var.
   CONSTRAINT: Not available in scripts — use a `text` channel there instead. #}
{% set greeting %}
  Hello {{ name }}
{% endset %}

{# [TPL-08] RULE: Function/macro definition uses {% macro %}; calls render text inline via {{ macro(args) }}. #}
{% macro greet(name) %}Hello {{ name }}{% endmacro %}
{{ greet("Alice") }}

{# [TPL-09] RULE: Inheritance override points use {% block name(args) %} ... {% endblock %}.
   {% block %} is the template equivalent of `method` in scripts. #}
{% block content(user) %}
  Hello {{ user }}
{% endblock %}

{# [TPL-10] RULE: Call blocks use bare {% call fn() %} ... {% endcall %} (NO assignment form).
   `caller()` renders the block body's text inline (templates render; scripts return). #}
{% call wrapper() %}body{% endcall %}
{# inside wrapper macro: #}
{{ caller() }}

{# [TPL-11] RULE: `super()` inside an overriding block RENDERS the parent block's text. #}
{% block content(user) with context %}
  Child {{ user }} — {{ super() }}
{% endblock %}

{# [TPL-12] RULE: Loops, conditionals, switch — same constructs but in tags:
   {% if %}/{% elseif %}/{% else %}/{% endif %}     ← templates use `elseif` (NOT `elif`)
   {% for %}/{% endfor %}, {% each %}/{% endeach %},
   {% while %}/{% endwhile %}, {% switch %}/{% case %}/{% endswitch %}. #}

{# [TPL-13] RULE: `include`, `import`, `from ... import`, `extends` all use {% %} tags.
   `include` is template-ONLY (not in scripts). #}
{% include "f" with context, var1, var2 %}
{% import "f" as lib with { key: expr } %}
{% from "f" import helper with context, var1 %}
{% extends "base.njk" with theme %}

{# [TPL-14] RULE: `revert` is template-supported as `{% revert %}` — discards the current guard scope's
   output and runs `recover` if present. #}
{% guard %}
  {% set r = riskyCall() %}
  {% if r is error %}{% revert %}{% endif %}
  Result: {{ r }}
{% recover %}
  Could not load.
{% endguard %}

{# [TPL-15] RULE: guard/recover behavior — text output from the guarded scope is DISCARDED on failure
   (analogous to channel reverting in scripts). #}
```

## TPL-INHERIT — Block Arguments and Shared State

```nunjucks
{# [TPL-16] RULE: Async Cascada blocks are ISOLATED — receive data only via declared args and `with context`.
   DIFFERENTIAL: Classic Nunjucks blocks see caller frame implicitly. Async Cascada does not. #}
{% set user = getUser() %}
{% block greeting(user) %}
  Hello {{ user.name }}
{% endblock %}

{# [TPL-17] RULE: `{% block name(a, b) %}` declares args; `{% block name(a) with context %}` adds render-context.
   CONSTRAINT: Overrides MUST match parent's signature exactly, including `with context`.
   `super()` renders the parent with the ORIGINAL block arguments (not reassigned locals). #}

{# [TPL-18] RULE: Shared `var` state across the hierarchy uses `this.<name>`.
   DIFFERENTIAL FROM SCRIPTS: NO `shared` declaration is required in templates — compiler INFERS shared vars
   from static `this.<name>` paths. Only `var` type exists in templates. #}
{% set this.theme = "dark" %}
Theme: {{ this.theme }}

{# [TPL-19] RULE: In a plain template (no extends/block), `this` is an ordinary render-context variable.
   `this.<name>` is then a normal property lookup — inference does NOT apply. #}

{# [TPL-20] RULE: Dynamic `this[expr]` is NOT supported in inheritance templates. #}

{# [TPL-21] RULE: `with` clauses and explicit payload model are ASYNC-ONLY.
   Classic (sync) Nunjucks retains implicit access to all parent-scope variables. #}
```

## TPL-SCOPE — Scoping (Async vs Classic)

| Construct | Classic Nunjucks / sync | Async Cascada Template |
|:---|:---|:---|
| `if` / `switch` | No scope; `{% set %}` writes to parent | Local scope per branch |
| `for`/`each` body | Iterations share one inner scope, discarded after | Each iteration isolated |
| `while` body | Uses parent scope | Each iteration isolated |
| `include` | Sees caller's `{% set %}` vars | Isolated; only `with` inputs |
| `import` | Macros see only own args | Isolated; only `with` inputs |
| `block` | Sees caller frame | Isolated; declared args + `with context` |
| Child top-level `{% set %}` | Visible in child's blocks | Visible in child's blocks |

---

# Script ↔ Template Quick Reference

| Feature | Script | Template |
|:---|:---|:---|
| Text output | `text t` + `t("...")` | implicit (text outside tags) |
| Variable decl | `var x = e` | `{% set x = e %}` |
| Reassignment | `x = e` | `{% set x = e %}` |
| Multi-var | `var x, y = none` | `{% set x, y = none %}` |
| Comments | `// ...` `/* ... */` | `{# ... #}` |
| Filters | `name | upper` | `{{ name | upper }}` |
| Exec-only call | `service.notify(u)` | `{% do service.notify(u) %}` |
| Sequence repair | `user.profile!!` | `{% do user.profile!! %}` |
| If | `if/elif/else/endif` | `{% if %}/{% elseif %}/{% else %}/{% endif %}` |
| For | `for x in xs / endfor` | `{% for %} / {% endfor %}` |
| Each | `each x in xs / endeach` | `{% each %} / {% endeach %}` |
| While | `while c / endwhile` | `{% while %} / {% endwhile %}` |
| Switch | `switch / case / endswitch` | `{% switch %} / {% case %} / {% endswitch %}` |
| Function | `function f(a) / endfunction` | `{% macro f(a) %} / {% endmacro %}` |
| Function call | `var r = f(a)` | `{{ f(a) }}` |
| Call block | `var x = call f() / (p) / return v / endcall` | `{% call f() %} ... {% endcall %}` |
| `caller()` | returns body's `return` | renders body's text |
| Block assignment | n/a (use `text` channel) | `{% set v %} ... {% endset %}` |
| Inheritance | `extends "f"` | `{% extends "f" %}` |
| Override | `method n(a) / endmethod` | `{% block n(a) %} / {% endblock %}` |
| Shared var decl | `shared var theme = "x"` | (inferred — no decl) |
| Shared write | `this.theme = "x"` | `{% set this.theme = "x" %}` |
| Shared read | `this.theme` | `{{ this.theme }}` |
| Include | n/a | `{% include "f" with context, v %}` |
| Import ns | `import "f" as lib` | `{% import "f" as lib %}` |
| Import names | `from "f" import h` | `{% from "f" import h %}` |
| Guard | `guard / recover / endguard` | `{% guard %} / {% recover %} / {% endguard %}` |
| Revert | `revert` (WIP) | `{% revert %}` |

---

# Constraint Index (Quick Lookup)

| # | Constraint | UID |
|:---|:---|:---|
| C1 | Cannot reassign undeclared name | VAR-02 |
| C2 | Cannot redeclare a name visible in any enclosing scope | VAR-01, VAR-04 |
| C3 | Property assignment (`obj.prop = v`) is SCRIPT-ONLY | VAR-06, TPL-05 |
| C4 | Cannot mutate context object directly | VAR-08 |
| C5 | Inline conditional ONLY uses `a if c else b` (no `?:`) | EXPR-03 |
| C6 | Boolean ops use words `and/or/not` only | EXPR-02 |
| C7 | `loop.length`/`loop.last` unavailable in `each`, bounded async-iter `for of N`, `while` | LOOP-07 |
| C8 | `switch` has no fall-through, no `break` | CTRL-02 |
| C9 | Channels cannot cross composition boundaries | CHAN-03 |
| C10 | `data` does NOT auto-init numbers/booleans | DATA-02 |
| C11 | Arithmetic/logical ops on missing/none `data` path throw | DATA-07 |
| C12 | `sequence` initializer must come from context | SEQ-01 |
| C13 | Property assignment on `sequence` is a compile error | SEQ-02 |
| C14 | `!` paths must reference context, not local vars | SEQOP-03 |
| C15 | Method-`!` (`obj.method!()`) does NOT serialize unmarked same-method calls | SEQOP-02 |
| C16 | Script `call` block REQUIRES assignment form | CALL-01 |
| C17 | `x#` returns `none` if x is not an error | ERR-06 |
| C18 | Function scope is isolated; no caller locals | FUNC-01 |
| C19 | Functions cannot dispatch `this.method()` or access shared state | FUNC-03 |
| C20 | Only `shared` decls allowed before `extends` | EXT-02 |
| C21 | Every file that uses `this.<name>` must declare it locally | EXT-04 |
| C22 | First-encountered initializer in child→parent order claims the shared default | EXT-05 |
| C23 | Bare assignment to shared name is compile error; use `this.x = v` | EXT-06 |
| C24 | `this.method` without `(...)` is a compile error | METH-01 |
| C25 | Constructor-local vars (after `extends`) NOT visible in method bodies | METH-02 |
| C26 | `method ... with context` contract is INHERITED automatically | METH-04 |
| C27 | At chain root, `this.method(...)` for unregistered method is fatal | EXT-10 |
| C28 | Component shared channels are READ-ONLY from caller | COMPONENT-04 |
| C29 | Component names starting with `_` are private (not observable) | COMPONENT-04 |
| C30 | Component implicit snapshot only on shared `var` (text/data/seq need explicit `.snapshot()`) | COMPONENT-04 |
| C31 | Composition payload does NOT override shared defaults | COMPONENT-07 |
| C32 | `guard *` cannot be combined with other selectors; duplicates invalid | GUARD-03 |
| C33 | `guard` variable protection blocks dependents until guard finishes | GUARD-06 |
| C34 | Templates use `{% set %}`, `{% do %}`, `{% block %}` (not `var`/`=`/`method`) | TPL-02, TPL-06, TPL-09 |
| C35 | Async block overrides must match parent signature (incl. `with context`) | TPL-17 |
| C36 | Templates infer shared vars from `this.<name>` paths — no `shared` decl | TPL-18 |
| C37 | `with` payloads are ASYNC-ONLY (sync Nunjucks retains implicit caller scope) | TPL-21 |
| C38 | Template `include` not available in scripts | TPL-13 |
| C39 | Deep-copy assignment semantics for objects/arrays | VAR-05 |
| C40 | Errors short-circuit conditional/loop bodies AND poison every var/channel any branch would write | ERR-02, ERR-03 |
| C41 | Multiple inheritance not supported (one parent per `extends`) | EXT-11 |
| C42 | Property access on `none`/null produces an Error Value (not a JS TypeError throw) | LANG-05 |
| C43 | `cycler.next()`, `joiner()`, and similar stateful Nunjucks globals must be called in sequential context (`each`) | EXPR-08, EXPR-09 |
| C44 | Scripts use `elif`; templates use `elseif` | CTRL-01, TPL-12 |
| C45 | Browser/new code uses ESM imports; old UMD bundles and automatic `window.nunjucks` globals are unsupported | API-03 |
| C46 | Object literals require explicit keys (`{ name: name }`, not `{ name }`) | EXPR-06 |

---

# API Reference

## Imports

```javascript
// Compile-from-source entry
import {
  AsyncEnvironment, FileSystemLoader,
  precompileScript, precompileTemplateAsync,
  raceLoaders
} from 'cascada-engine';

// Precompiled-only entry (no compiler/parser/lexer/precompile API)
import { AsyncEnvironment, PrecompiledLoader } from 'cascada-engine/precompiled';
```

## AsyncEnvironment

```javascript
// [API-01] new AsyncEnvironment([loaders], [opts])
//   loaders: a single loader or array (tried in order until one finds the asset).
//   opts:
//     autoescape:       default true   — auto-escape template output
//     throwOnUndefined: default false  — throw on undefined render
//     trimBlocks:       default false  — remove first newline after block tag
//     lstripBlocks:     default false  — strip leading whitespace from block tag
//     tags:             override delimiters

const env = new AsyncEnvironment(new FileSystemLoader('scripts'), { trimBlocks: true });

// Execution:
const r1 = await env.renderScript('name.casc', context);          // file
const r2 = await env.renderScriptString(source, context);          // string → returns explicit return value
const r3 = await env.renderTemplate('page.njk', context);          // file → string
const r4 = await env.renderTemplateString(source, context);        // string → string

// Compilation/Caching:
const s = await env.getScript('name.casc');     // returns reusable Script
const t = await env.getTemplate('page.njk');    // returns reusable AsyncTemplate
const out = await s.render(ctx);

// Globals / extensions:
env.addGlobal(name, value);
env.addFilter(name, fn, [isAsync]);
env.addFilterAsync(name, fn);
env.addDataMethods({ name: (target, ...args) => newValue });

// [API-03] ESM is required for browser/new code; old UMD bundles and automatic `window.nunjucks`
// globals are unsupported by the ESM package.
```

## Loaders

```javascript
// Built-in: FileSystemLoader (Node), NodeResolveLoader (Node), WebLoader (Browser), PrecompiledLoader.
// Loader function returns: { src, path, noCache } | null  (null → fallback to next loader).

const networkLoader = async (name) => {
  const r = await fetch(`https://cdn.x/${name}`);
  if (!r.ok) return null;
  return { src: await r.text(), path: name, noCache: false };
};

// Loader class API:
//   load(name)              REQUIRED — string | LoaderSource | null
//   isRelative(name)        optional — bool
//   resolve(from, to)       optional — string
//   on(event, handler)      optional — env events

// raceLoaders(loaders) — runs concurrently; first success wins:
const fast = raceLoaders([
  new WebLoader('https://cdn.x/'),
  new FileSystemLoader('scripts/backup/')
]);
```

## Precompilation

```javascript
// [API-02] Precompile to JS for production. opts.env ensures filters/globals/dataMethods are bundled.
precompileScript(path, [opts]);
precompileTemplate(path, [opts]);          // sync template
precompileTemplateAsync(path, [opts]);     // async template (Cascada)
precompileScriptString(source, [opts]);
precompileTemplateString(source, [opts]);
precompileTemplateStringAsync(source, [opts]);

// CLI:
//   cascada-precompile views      --mode template
//   cascada-precompile views      --mode template-async
//   cascada-precompile script.casc --mode script --format esm
```

---

# Appendix

## UID Index

| Category | UIDs |
|:---|:---|
| LANG | 01–05 |
| VAR | 01–08 |
| EXPR | 01–09 |
| LOOP | 01–08 |
| CTRL | 01–02 |
| CHAN | 01–04 |
| TEXT | 01 |
| DATA | 01–09 |
| SEQ | 01–04 |
| SEQOP | 01–04 |
| FUNC | 01–04 |
| CALL | 01–03 |
| ERR | 01–13 |
| GUARD | 01–07 |
| IMP | 01–04 |
| COMP | 01–06 |
| EXT | 01–11 |
| METH | 01–04 |
| COMPONENT | 01–08 |
| RETURN | 01–03 |
| TPL | 01–21 |
| API | 01–03 |
| EXEC | 01–06 (invariants) |

## Notes on Source Authority

- When this reference disagrees with `docs/cascada/script.md` or `docs/cascada/template.md`, the source documents win.
- Standard JavaScript / Python / Nunjucks behaviors are NOT documented here unless they differ in Cascada.
- Script-mode and Template-mode constructs are NOT interchangeable. Use the syntax of the active mode.
