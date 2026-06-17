# Cascada Agent Reference

AI-optimized reference for **Cascada Script** and **Cascada Template** code generation. Cascada is parallel-by-default; familiar syntax, unfamiliar execution model.

**Modes covered (do not cross-translate constructs between them):**
- **Script** — logic/data orchestration, channel declarations, explicit `return`.
- **Template** — Nunjucks-compatible text generation with `{{ }}` and `{% %}`.

**Core differentials (vs JS/Python/Nunjucks baseline):**
1. Independent statements/expression parts/loop iterations run **concurrently by default**; an op only waits when it depends on another's result.
2. Errors are **data** (`PoisonedValue`) — they propagate through dependents while unrelated work continues. No `try/catch`.
3. **Channels** (`data`, `text`) collect concurrent writes and assemble the final value in source-code order; `sequence` is a related ordered-access construct for one external object.
4. `!` marker enforces **sequential order** on a static context path; `each` iterates sequentially; `while` is sequential.
5. Block-local scoping for `if`/`for`/`each`/`while`/`switch`; `var` declared inside is invisible outside.

**UID schema:** `[CATEGORY-NN]`. Categories: LANG, VAR, EXPR, CTRL, LOOP, CHAN, DATA, TEXT, SEQ, SEQOP, FUNC, CALL, ERR, GUARD, COMP, IMP, EXT, METH, COMPONENT, RETURN, TPL, API, EXEC.

---

## Sigil / Operator Table (Differentials)

| Symbol | Mode | Meaning | UID |
|:---|:---|:---|:---|
| `!` | both | Marks a sequence path — signals side effects; all subsequent accesses on that path wait | SEQOP-01 |
| `!!` | both | Repair poisoned sequence path (clear poison) | ERR-10 |
| `!!.method()` | both | Repair then execute | ERR-11 |
| `#` | both | Peek operator: read property of an Error Value without propagating | ERR-06 |
| `is error` / `is not error` | both | Test whether a value is poisoned | ERR-05 |
| `r/regex/` | both | Regex literal prefix | EXPR-04 |
| `a if c else b` | both | Inline conditional (Python-style only; **not** `c ? a : b`) | EXPR-03 |
| `//`, `**` | both | Integer division, exponentiation | EXPR-01 |
| `~` | both | Explicit text concatenation / stringify (use instead of `+` for mixed types) | EXPR-01 |
| `and`, `or`, `not` | both | Boolean operators (word form only — not `&&`/`\|\|`/`!`) | EXPR-02 |
| `none` | both | Null literal (Python-style; **not** `null`) | LANG-02 |
| `\|` | both | Filter pipeline | EXPR-05 |
| `of N` | script | Concurrency limit on a `for` loop | LOOP-02 |

---

## Core Execution Model (Invariants)

- **[EXEC-01]** Every independent operation (assignment, function call, expression operand, loop iteration) starts immediately; it waits only on its inputs.
- **[EXEC-02]** Outputs are deterministic: writes execute concurrently but the assembled result equals what sequential execution would produce.
- **[EXEC-03]** Errors are values (`PoisonedValue`). Propagation rules are conservative — see ERR-* atoms.
- **[EXEC-04]** Each block (`if`, `for`/`each`/`while`, `switch` case, function/method body) gets its own isolated scope.
- **[EXEC-05]** Composition/call boundaries (`import`, `include`, `component`, function call) are isolated; `extends` uses inheritance context, not `with`.
- **[EXEC-06]** Sequential ordering is opt-in: `!` (path), `each` (loop), `sequence` (external object), `while` (loop).

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

// [LANG-06] RULE: Identifier names may contain letters, digits, and `_`; `$` is reserved for compiler internals.

// [LANG-05] RULE: Property/index reads are lenient on object/array/string (missing → undefined),
//            but property access on `none`/null or a scalar primitive (number/boolean) produces an Error Value.
// DIFFERENTIAL: Differs from JS `TypeError` throw; templates keep Nunjucks leniency everywhere (see TPL-22).
var ok1 = obj.missing       // undefined (lenient)
var ok2 = items[10]         // undefined
var ok3 = "abc"[9]          // undefined
var bad1 = none.title       // ❌ Error Value (property on none)
var bad2 = (5).missing      // ❌ Error Value (property on scalar)
```

## VAR — Variables, Assignment, Scope

```javascript
// [VAR-01] RULE: `var name = value` declares; `name = value` reassigns. Both work for tuples.
// CONSTRAINT: Re-declaring a name visible in any enclosing scope is a compile-time error.
// This applies to ALL declaration binders: var, loop targets, call-block params, import/from-import names,
// component aliases, recover bindings.
var name = "Alice"
name = "Bob"            // ✅ reassign declared var
var a, b = 100          // ✅ multiple decls, single value
a, b = 200              // ✅ multi-assign existing vars

// [VAR-02] RULE: Assignment to an undeclared name is a compile-time error (no implicit globals).
// ❌ Invalid:
username = "C"   // ERROR: not declared with var

// [VAR-03] RULE: Variables declared in `if`/`for`/`each`/`while`/`switch` blocks are local to that block.
// DIFFERENTIAL: Differs from JS `var` hoisting. To use across the boundary, declare in an outer scope first.
if cond
  var local = "x"
endif
// reading local here -> UnknownVariable poison

var status = "default"
if cond
  status = "updated"   // writes to outer var
endif

// [VAR-04] RULE: An inner scope cannot re-declare a name visible in an outer scope (no shadowing).
// ❌ Invalid:
var item = "p"
for i in range(2)
  var item = "c"     // ERROR: shadowing forbidden
endfor
for item in items     // ERROR: loop target shadowing also forbidden
endfor
// Functions/methods open clean scopes, so their params may reuse outer names — see FUNC-01.

// [VAR-05] RULE: Assignment performs a logical deep copy — variables are independent.
// DIFFERENTIAL: Differs from JS reference semantics on objects/arrays. (Engine copies lazily on write.)
var a = {x: 1}
var b = a
a.x = 10
// b.x === 1

// [VAR-06] RULE: Property assignment is allowed: `obj.prop = expr`, `arr[i] = expr`.
// CONSTRAINT: Script-only — NOT available in templates (see TPL-05).
var point = {x: 1, y: 2}
point.x = 10
items[0] = 100

// [VAR-07] RULE: Reading a property whose value is async waits; sibling reads do not.
var p = {x: 1, y: 2}
p.x = slowApiCall()
return { x: p.x, y: p.y }   // p.x waits, p.y already resolved

// [VAR-08] RULE: Context (the JS object passed to render) is read-only from script code.
// Context properties are read by bare name; values may be promises or async functions. To mutate, copy into a local var first.
// Rejected context promises become ContextValueRejected poison when consumed/returned.
// ❌ Invalid:
appConfig.debug = true        // ERROR
// ✅ Valid:
var config = appConfig
config.debug = true           // appConfig unchanged

// [VAR-09] RULE: Compound assignment (`+=`, `-=`, `++`, ...) on a plain `var` is NOT yet supported — those
// operators are only available on `data` channel paths (DATA-03). Reassign explicitly instead.
// ❌ Invalid:
count += 1
// ✅ Valid:
count = count + 1
```

## EXPR — Operators & Literals

```javascript
// [EXPR-01] RULE: Arithmetic — `+ - * / // % **`. Comparisons — `== != === !== > >= < <=`.
// DIFFERENTIAL (script): `==`/`!=` are STRICT (=== / !==); arithmetic requires numeric operands except
//   `string + string`; ordering compares number-number or string-string only; `in` requires a collection.
// Mixed coercion (`"5" + 3`, `"5" * 2`) → Error Value (kind IncompatibleOperands).
// Use `~` for mixed text concatenation (`"x" ~ 1`); use `| int` / `| float` for explicit numeric conversion.
// `5 / 0` → Infinity (a value); `5 % 0` → NaNResult error; BigInt division/modulo by zero → DivideByZero error.
// Any computation producing NaN (e.g. 0/0) → Error Value; Infinity stays a value.

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

// [EXPR-05] RULE: Filters apply with `|`: `value | filter` or `value | filter(arg)`.
// Filters and global functions are the full Nunjucks built-in set (range, etc.).
var t = "hi" | upper
var s = items | join(", ")
for i in range(3)
endfor

// [EXPR-06] RULE: Object literal uses explicit `{key: expr}`; array literal uses `[a, b]`.
// ❌ Invalid: JS shorthand object keys are NOT supported.
var name = "Ada"
var p = { id: 1, name: name, "k-2": 100 }
var a = [1, "x", true]
var bad = { name }        // ERROR: shorthand not supported

// [EXPR-07] RULE: Member access `obj.prop` or `arr[i]`; valid in any expression position.

// [EXPR-08] RULE: Nunjucks `cycler(...items)` is STATEFUL — `.next()` must be called in source order.
// CONSTRAINT: Use inside `each` (sequential), not concurrent `for`, or ordering is non-deterministic.
data rows = []
var rowClass = cycler("even", "odd")
each item in items
  rows.push({ class: rowClass.next(), value: item })
endeach

// [EXPR-09] RULE: Nunjucks `joiner([sep])` is STATEFUL — first call returns "", later calls return sep (default ",").
// CONSTRAINT: Call in sequential context (`each`) when order matters.
var comma = joiner(", ")
var output = ""
each tag in tags
  output = output + comma() + tag
endeach
```

## LOOP — Loops

```javascript
// [LOOP-01] RULE: `for item in iter` runs all iterations CONCURRENTLY.
// DIFFERENTIAL: Source-order side effects on a shared `var` are race-prone — use data channel/each/! (see LOOP-08).
for id in ids
  var u = fetchUser(id)
endfor

// [LOOP-02] RULE: `for ... of N` limits concurrency to N (N is an expression → a positive number).
// CONSTRAINT: `of N` is ignored for plain objects; a non-positive N → InvalidConcurrentLimit error.
for item in coll of 5
  processItem(item)
endfor

// [LOOP-03] RULE: Iteration shapes: `for x in arr`, `for k, v in obj`, `for x, y, z in arrayPairs`, `for x in asyncIter`.
// CONSTRAINT: Multi-var destructuring needs array-like elements: `for a, b in [[1,2]]`, not `for a, b in [1,2]`.
for k, v in food
  log("Use ", v, " of ", k)
endfor

// [LOOP-04] RULE: `else` block in a `for` loop runs only when the iterable is empty.
for item in []
else
  log("empty")
endfor

// [LOOP-05] RULE: `each item in coll` iterates SEQUENTIALLY (one iteration finishes before the next starts).
each id in ids
  items.push(fetchItem(id))   // safe vs concurrent for-loop
endeach

// [LOOP-06] RULE: `while cond` runs SEQUENTIALLY; condition re-evaluated only after the body completes.
while attempts < 3
endwhile

// [LOOP-07] RULE: Loop body has a `loop` variable.
// Always-available: loop.index (1-based), loop.index0, loop.first.
// Length-dependent: loop.length, loop.last, loop.revindex, loop.revindex0. Availability:
//   Arrays / Objects (any loop mode):                            ✅ always
//   Unbounded concurrent async iter (`for x in iter`):           ✅ resolved async after the stream ends
//   `each` over async iter / bounded `for ... of N` async iter:  ❌ unavailable (would deadlock the iter)
//   `while`:                                                     ❌ never (total unknown until done)

// [LOOP-08] RULE: Concurrent mutation of one shared value is the hazard, not methods per se.
// In-place JS mutators (push, pop, shift, unshift, splice, sort, reverse, fill, copyWithin) on a plain `var`
// are FINE on a single non-concurrent path, but race when called from concurrent `for` iterations.
// Fix with: a `data` channel (ordered assembly), an `each` loop (sequential), or `!` (context objects).
// ❌ Unsafe:
var items = []
for id in ids
  items.push(fetchItem(id))   // concurrent race; order not guaranteed
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
// CONSTRAINT: Templates use `{% elseif %}` (also accept `{% elif %}`) — see TPL-12.
if a
elif b
else
endif

// [CTRL-02] RULE: `switch expr / case v / default / endswitch`. NO fall-through; NO `break`.
// DIFFERENTIAL: Each case exits automatically; `default` matches when no case did. Each branch has its own scope.
switch s
case "a"
case "b"
default
endswitch
// (Block-local scoping for if/switch branches — see VAR-03 / EXEC-04)
```

## CHAN — Channels (Overview)

```javascript
// [CHAN-01] RULE: Channels collect writes from concurrent code and assemble in source-code order.
// Two channel types: `data` (structured objects/arrays) and `text` (string).
// DIFFERENTIAL: Writes execute concurrently; the assembled result is deterministic. `sequence` (SEQ-*) is a
// separate ordered-access construct, not a channel, but shares guard/this protection surfaces.

// [CHAN-02] RULE: Read the assembled value with `name.snapshot()`.
// CONSTRAINT: snapshot() waits for pending writes — more expensive than reading a `var`; prefer `var` when simple.
data out
out.x = 1
return out.snapshot()

// [CHAN-03] RULE: Channel/sequence declarations cannot cross composition boundaries.
// Only `var` may be passed via `with`; `data`/`text`/`sequence` cannot.

// [CHAN-04] RULE: Channels declared inside a function/method are local to it.
```

## TEXT — Text Channel

```javascript
// [TEXT-01] RULE: Declare with `text name`. Two write forms.
text log
log("Processing ", userId, "...")   // appends ALL args in order; `log()` writes nothing
log = "replaces entire text"         // overwrite
return log.snapshot()
```

## DATA — Data Channel

```javascript
// [DATA-01] RULE: Declare with `data name` (optionally `data name = []` / `= {}`). Build via path commands;
// `.snapshot()` returns a plain object/array.
data out
out.user.name = "Alice"
out.user.roles.push("editor")
return out.snapshot()

// [DATA-02] RULE: Auto-initialization — Objects (first property/object op), Arrays (first array op), and
// Strings (first string op) are created automatically. Numbers and Booleans are NOT — assign explicitly first.
// ❌ Invalid:
data o
o.count++              // ERROR: count is none
// ✅ Valid:
data o
o.count = 0
o.count++
o.ready = false
o.ready ||= true

// [DATA-03] RULE: Path command vocabulary:
// Assign:    name.path = value (= set)   |   name.path.delete()
// Array:     push, concat, pop, shift, unshift, reverse, at(i), sort, sortWith(fn), arraySlice(start,[end])
// Object:    merge(v) (shallow), deepMerge(v)
// Arith:     +=, -=, *=, /=, ++, --, .min(v), .max(v)        (number target required)
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

// [DATA-06] RULE: Root-level replacement — assign directly to the channel name; then use ops for the new type.
data result
result = { status: "complete" }
result = []
result.push("first")

// [DATA-07] RULE: Structure-building methods (push, merge, append) auto-create the missing path.
// Arithmetic/logical operators (+=, --, &&=, ...) THROW a runtime error on a `none`/missing target.

// [DATA-08] RULE: Custom data methods via `env.addDataMethods({ name: (target, ...args) => newValue })`.
// `target` is the current value at the path (undefined if absent). Return value REPLACES target;
// returning `undefined` DELETES the path.
// Operator→method mapping: =→set, +=→add, -=→subtract, *=→multiply, /=→divide, ++→increment, --→decrement,
//   &&=→and, ||=→or, &=→bitAnd, |=→bitOr.

// [DATA-09] RULE: Data channels optimize for ordered assembly, not raw mutation speed.
// Many fine-grained writes on a large nested structure may be slower than building a plain object once.
```

## SEQ — Sequence Construct

```javascript
// [SEQ-01] RULE: `sequence name = initializer` wraps an external object with strictly sequential access.
// Every read and call through it is serialized in source order. CONSTRAINT: initializer MUST come from context.
sequence db = services.db
var user = db.getUser(1)              // value-returning call
var state = db.connectionState        // property read
var id = db.api.client.getId()        // nested sub-path
var snap = db.snapshot()

// [SEQ-02] RULE: Property ASSIGNMENT on a `sequence` is a compile error (planned for the future).
// ❌ Invalid:
db.connectionState = "offline"   // ERROR

// [SEQ-03] RULE: A poisoned sequence is recovered with `guard` (see GUARD-*).

// [SEQ-04] DIFFERENTIAL: `sequence` vs `!`:
//   `sequence` = declared object; ordered reads/calls; values flow back into normal expressions.
//   `!`        = marker on a static context path; orders side effects on that path.
// CONSTRAINT: `sequence` is script-only; templates use `!` on static context paths instead.
```

## SEQOP — `!` Sequential Operator (Sequence Path)

```javascript
// [SEQOP-01] RULE: `path!.method()` signals that an external call has side effects, making the path sequential.
// ALL subsequent accesses on that path wait — method calls (with or without `!`) AND property reads.
// MECHANISM: each access awaits the promise from the previous op on that path before starting.
bank.account!.deposit(100)
bank.account.getStatus()        // waits — plain call, no ! needed
bank.account!.withdraw(50)      // waits — ! calls on a sequence path also wait
var bal = bank.account.balance  // waits — property reads are sequenced too

// [SEQOP-02] RULE: Method-specific sequencing — `obj.method!(args)`.
// CONSTRAINT: Unmarked calls to the SAME method (`obj.method(...)`) do NOT wait (differs from path-level !).
logger.log!("a")
logger.log!("b")
logger.getStatus()      // unaffected

// [SEQOP-03] RULE: Sequencing is HIERARCHICAL — a side effect on a parent path sequences all sub-paths.
bank!.resetUser(userInfo)
bank.account.deposit(100)  // waits — under bank
bank.user.getName()        // waits — under bank

// [SEQOP-04] RULE: `!` paths must reference CONTEXT objects, not local vars.
// CONSTRAINT: ordering relies on object identity from context. Function-parameter pass-through is NOT yet supported.
// Missing context root → UnknownVariable poison.
db!.insert(d)                  // ✅ db from context
services.database!.insert(d)   // ✅ nested context path
// ❌ Invalid:
var database = db
database!.insert(d)            // ERROR: not a context path

// [SEQOP-05] RULE: `!` guarantees ORDER and that the call RUNS — NOT that it has finished when render resolves.
// The render awaits only the returned value, not a pure side effect. To await a side effect, fold its result
// into what you return.
db!.save(record)                       // may settle after render returns
result.ack = db!.save(record)          // ✅ awaited because its value is returned
```

## FUNC — Functions

```javascript
// [FUNC-01] RULE: `function name(args) ... endfunction`. Returns via `return`; if none runs, returns `none`.
// CONSTRAINT: Isolated scope — does NOT see caller locals (so params may reuse outer names). Channels declared
// inside are local. Channels are not returned directly — return `ch.snapshot()`.
function buildDept(deptId)
  var manager = fetchManager(deptId)   // concurrent with next line
  var team = fetchTeamMembers(deptId)
  return { manager: manager.name, teamSize: team.length }
endfunction
var d = buildDept("sales")

// [FUNC-02] RULE: Default values and keyword arguments supported.
function input(name, value="", type="text")
  return { name: name, value: value, type: type }
endfunction
var f = input("pass", type="password")

// [FUNC-03] RULE: Functions cannot dispatch via `this.method(...)` and cannot access shared state (methods can — METH-*).
```

## CALL — Call Blocks

```javascript
// [CALL-01] RULE: Script `call` blocks REQUIRE assignment form (`var x = call ...` or `x = call ...`).
// Bare `call` (no assignment) is unsupported in scripts. The function controls invocation via `caller(args)`;
// the call block declares its params in a `(params)` header and provides the value via `return`.
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

// [CALL-02] RULE: If no parameters are needed, omit the `(params)` header line.
var r = call wrapper(args)
  return value
endcall

// [CALL-03] RULE: The call block reads from the CALLER scope (where it was written), NOT the function's scope.
// Reads of visible parent vars are allowed; assignments to them are rejected; fresh `var`s stay local.
// The function sees only what `caller()` returns.
```

## RETURN — Return Statements

```javascript
// [RETURN-01] RULE: `return [expr]` shapes the producing value of a script/function/method/call block.
// After return runs, later statements in that callable are SKIPPED.
return 42
return                  // bare — JS API resolves null
return none             // explicit null
return user
return { name: u.name }
data r
r.x = 1
return r.snapshot()     // capture ordered channel value

// [RETURN-02] RULE: If no return runs (or bare return), the JS API resolves with `null` (= Cascada `none`).

// [RETURN-03] RULE: Prefer plain var/literal returns. Use `data`/`text` + snapshot for ordered writes or
// structured path updates; use `sequence` for an ordered external interface.
```

## ERR — Errors as Data (Poisoning)

```javascript
// [ERR-01] RULE: Failed operations produce an Error Value (PoisonedValue). Any operation whose input is an
// error evaluates to that error (propagation). DIFFERENTIAL: no try/catch; unrelated work continues.
var posts = fetchPosts(123)        // may fail
var n = posts.length               // ❌ becomes error if posts is error
var ok = comments.length           // ✅ unaffected

// [ERR-02] RULE: If an `if`/`switch` condition is an error, NO branch runs and EVERY var/channel that ANY branch
// would have modified becomes poisoned (conservative).
var accessLevel
if user.role == "admin"            // user may be error
  accessLevel = "full"
else
  accessLevel = "limited"
endif
// user is error → accessLevel is poisoned

// [ERR-03] RULE: If a loop's iterable is an error, the body is skipped and every var/channel the body would
// have modified becomes poisoned.
// CONSTRAINT: iterating a scalar primitive → NotIterable error; iterating `none` runs the `else` branch
// (treated as an absent collection).

// [ERR-04] RULE: A script fails ONLY if the final RETURNED value is an Error Value.
// Internal poison is fine if repaired or not returned.
var u = fetchUser(999)     // error
if u is error
  u = { name: "Guest" }    // repaired
endif
return u.name              // ✅ "Guest"

// [ERR-04b] RULE: A side-effect-only statement (a bare call, or `{% do %}` in templates) DISCARDS its result,
// so a failure there has no consumer and is dropped. Bind the result if you need to detect it.
fetchAndLog()                 // failure dropped
var r = fetchAndLog()         // bind to detect via `r is error`

// [ERR-05] RULE: `is error` / `is not error` test whether a value is poisoned.
if u is error
  u = fallback
endif

// [ERR-06] RULE: `value#prop` peeks INSIDE an Error Value (no propagation).
// CONSTRAINT: `x#` returns `none` when x is not an error — always check `is error` first.
if failed is error
  var msg  = failed#message
  var path = failed#errors[0].path
  var line = failed#errors[0].lineno
endif

// [ERR-07] RULE: Peeking returns a PoisonError (single failure) or PoisonErrorGroup (multiple), both sharing
// an interface so most code handles them uniformly. Fields:
//   #description  - cause's message text (no type prefix / location / stack)
//   #message      - two-line compact diagnostic: type+description, then source location
//   #fullMessage  - #message plus the Cascada execution-trace stack when available
//                   (primary frame printed once — a duplicate leading stack frame is omitted)
//   #context      - normalized diagnostic context (may include callSignature, loop, branch)
//   #errors       - array of individual PoisonError objects, each:
//                   { message, description, fullMessage, context, name, lineno, colno, path, label, kind, cause }
//   single PoisonError → #errors is [this] (single-item), so single/group code is identical.
// `kind` = stable code naming WHAT failed; `label` = compiler token naming WHERE. `kind` is diagnostic, not frozen.
// PoisonErrorGroup adds: name='PoisonErrorGroup', kinds[] (sorted unique), totalErrorCount, and #errors holds ALL
//   failures (sorted by source location); inherited single fields come from the first child error.

// [ERR-07b] REFERENCE: `kind` values (strings in the `kind` field; class is always PoisonError/PoisonErrorGroup):
//   MissingFunction      - called name resolved to undefined (no such fn/method/context prop)
//   NotAFunction         - call target is some other type
//   UserCallThrew        - a called fn/filter/data-method/sequence-method threw
//   UnknownVariable      - bare read of a missing context/global/script symbol
//   NullLookup           - property read on null/undefined
//   ScalarLookup         - script property read on a scalar primitive
//   LookupThrew          - a property getter threw
//   IteratorThrew        - a loop iterator/generator threw
//   NotIterable          - loop source / `in` RHS is not a collection
//   NotDestructurable    - loop element not array-like for multi-var destructuring
//   InvalidConcurrentLimit - `of` limit not a positive number
//   IncompatibleOperands - operator operands have incompatible types
//   DivideByZero         - BigInt division/modulo by zero
//   LoadFailed           - non-fatal import/component/include load failed
//   ImportBindingMissing - imported name not exported by the module
//   NaNResult            - a computation produced NaN
//   InvalidTextValue     - value cannot be converted to text (plain object/function/symbol)
//   ContextValueRejected - a context-supplied (or returned) promise rejected

// [ERR-08] RULE: Functions still RECEIVE Error Value arguments — the body can detect/repair.
function processData(v)
  if v is error
    return "fallback"
  endif
  return v.name
endfunction

// [ERR-09] RULE: Writing an Error Value into a channel POISONS the channel; reading/returning it fails the script.

// [ERR-10] RULE: `path!!` (alone) repairs a poisoned sequential path — clears poison.
db!.insert(d)   // fails → path poisoned
db!!            // path repaired
db!.insert(d2)  // runs

// [ERR-11] RULE: `path!!.method(args)` repairs THEN executes (always-run cleanup pattern).
fileSystem!.writeData(d)   // may fail
fileSystem!!.close()       // runs regardless

// [ERR-12] RULE: A failure on a `!` path POISONS the path; later ops on it return error immediately without executing.
db!.connect()       // fails
db!.insert(r)       // skipped → error
db!.commit()        // skipped → error

// [ERR-13] RULE: `path! is error` checks whether a `!` path is currently poisoned.
if api! is error
  var msg = api!#message
  api!!
endif

// [ERR-14] RULE (JS host side): render methods REJECT with one of four error classes; distinguish via instanceof.
// PoisonErrorGroup extends PoisonError, so one `instanceof PoisonError` catches both.
//   CompileError      - source could not be compiled (lineno/colno/path/...)
//   RuntimeError      - fatal runtime/contract failure (NOT part of dataflow recovery)
//   PoisonError       - result depends on one failed operation
//   PoisonErrorGroup  - result depends on multiple failed operations (.errors[] = individual PoisonErrors)
// In-script detection uses `is error` / `#`; JS-side detection uses instanceof.
```

## GUARD — Transactional Recovery

```javascript
// [GUARD-01] RULE: `guard [selectors] / [recover [err]] / endguard` — transaction-like block.
// On error, PROTECTED state is RESTORED before `recover` runs. `recover` is OPTIONAL.
guard
  out.status = "processing"
  db!.insert(user)
  db!.update(account)         // ❌ fails
  db!.commit()
  out.status = "success"
recover err
  // out reverted; db! repaired
  db!.rollback()
  out.error = err.message
endguard

// [GUARD-02] RULE: Default `guard` (no selectors) protects:
//   1. ALL channels (data, text) and sequence objects touched inside — writes discarded on error.
//      sequence recovery uses optional begin()/commit()/rollback() hooks if present; missing hooks tolerated;
//      hook errors become guard errors.
//   2. ALL `!` paths touched inside — auto-repaired with `!!`.
// Variables are NOT protected by default.

// [GUARD-03] RULE: Selectors:
//   guard          → channels + sequence + ! paths touched (default)
//   guard *        → everything (vars + channels + sequence + ! paths)   — CANNOT combine with others
//   guard var      → all variables written inside
//   guard data     → all data channels touched
//   guard text     → all text channels touched
//   guard sequence → all sequence objects touched
//   guard name1, name2 → specific channels / sequence objects / vars by name
//   guard lock!    → a specific ! path (e.g. db!)
//   guard !        → all ! paths touched
// CONSTRAINT: duplicates invalid; `lock!`/`!` selectors are for sequential paths, NOT `sequence` objects.

// [GUARD-04] RULE: ! path protection is HIERARCHICAL — guarding `api!` also covers `api.db!`, `api.connection!`.
guard api!
  api!.connect()
  api.db!.insert(d)
  api.connection!.setState(s)
endguard

// [GUARD-05] RULE: `recover [err]` runs ONLY if the guard finishes poisoned. `err` (optional) binds the final
// poison error; read `err.message` or inspect `err.errors`. Bare `recover` is also valid.
// If all errors are detected and repaired inside the guard via `is error`, the guard is successful — no recovery.

// [GUARD-06] RULE (PERFORMANCE): variable protection (via `guard *` or explicit names) makes code that depends
// on those vars WAIT for the guard to finish. Use `guard *` only for small, tightly scoped operations.

// [GUARD-07] RULE: Manual `revert` (reset guarded state inside a guard) is WORK-IN-PROGRESS and not yet
// available in EITHER script or template mode. Use ordinary error flow: if the guarded block stays poisoned,
// Cascada discards its writes/output and runs `recover`.
```

## Composition & Inheritance

### IMP — Importing Libraries

```javascript
// [IMP-01] RULE: `import "file" as ns` binds a library namespace; call functions via `ns.fn(...)`.
import "formatters.script" as fmt
return fmt.formatUser(user)

// [IMP-02] RULE: `from "file" import name1, name2` pulls specific names directly into caller scope.
from "formatters.script" import formatUser
return formatUser(user)

// [IMP-03] RULE: Public root-scope declarations export by default; names starting with `_` are private.
// Exported non-`shared` channel decls expose their final SNAPSHOT (assembled value), not the channel object.
// `shared` decls are NOT exposed via import — they belong to extends/component state via `this.<name>`.

// [IMP-04] RULE: `import ... with [forms]` passes a composition payload (see COMP-*).
import "formatters.script" as fmt with locale
import "formatters.script" as fmt with context
import "formatters.script" as fmt with context, locale
```

### COMP — Composition Payload (`with`)

```javascript
// [COMP-01] RULE: `with var1, var2, ...` passes named parent vars BY VALUE as bare-name inputs in the child.
// CONSTRAINT: only `var` declarations may be listed; data/text/sequence cannot cross (CHAN-03).

// [COMP-02] RULE: `with { key: expr, ... }` — explicit object literal; keys become bare-name inputs.
// MUST come last when forms are combined; overrides on key collision.

// [COMP-03] RULE: `with context` exposes the RENDER CONTEXT to bare-name lookups inside the child.
// Does NOT expose parent locals or channels, and does NOT create a `context` variable inside the child.

// [COMP-04] RULE: Forms combine, object form last: `with context, var1, { extra: computed() }`.
// Applies to `import` and `component`; NOT to `extends` (context flows through extends automatically).

// [COMP-05] RULE: Resolution order inside the composed file:
//   explicit `with` value  →  `with context` lookup  →  globals.
import "f.script" as fmt with context, locale
// locale → explicit var wins; other bare names look up in context, then globals
```

### EXT — Extends / Shared / Method / Super

```javascript
// [EXT-01] RULE: `extends "file"` declares inheritance. Render the CHILD; the chain runs once and the base
// constructor runs as part of it. Render context flows through the chain automatically; `extends` takes NO `with`.
// Dynamic forms (script): `extends expr`, `extends expr if cond else "x.script"`, `extends ... if ... else none`.
// `extends none` = explicitly parentless but still the root of its own chain (methods still callable).

// [EXT-02] RULE: The `extends` target resolves BEFORE any constructor/startup code. It may read render context,
// globals, and (for components) the with-payload — but NOT shared state or vars created later in the body.
// Only `shared` declarations, whitespace, and comments may appear before `extends`.
// `extends` is an async boundary: the body runs after chain setup and shared-metadata registration.

// [EXT-03] RULE: `shared` declares chain-owned state, accessed via `this.<name>` from constructors/methods. Forms:
//   shared var x = expr        // shared variable
//   shared var x               // participation only — no default claimed (a parent default may still init)
//   shared data x              // shared data channel
//   shared text x              // shared text channel
//   shared sequence db = expr  // shared sequence (with initializer)
//   shared sequence db         // participation only

// [EXT-04] RULE: PER-FILE declaration — every file using `this.<name>` must declare it locally (files compile
// independently). Re-declaring with a DIFFERENT channel type is fatal; same type is a no-op.

// [EXT-05] RULE: Shared default priority — the first initializer in CHILD-to-PARENT order wins; later ancestor
// defaults are NOT evaluated. Only initializer forms claim defaults. Default expressions can read the with-payload.

// [EXT-06] RULE: Bare assignment to a shared name does NOT reach shared state — it assigns a local. Write via
// `this.name = value`. Bare-name reads use ordinary lookup (context/globals/payload), never shared state.

// [EXT-07] RULE: `this.<name>` access forms (any type):
//   this.x              → var read (implicit snapshot)
//   this.x = v          → var write
//   this.x.a.b          → var: read-through property lookup
//   this.x.prop = v     → var/data: nested write
//   this.x("msg")       → text: append
//   this.x.cmd(args)    → data: command
//   this.x.method(args) → sequence: ordered call
//   this.x.snapshot()   → any: explicit snapshot
//   this.x is error / this.x#   → any: poison check / peek

// [EXT-08] RULE: The constructor is the script body after `extends`. The most-derived child runs FIRST; an
// ancestor constructor runs only where the child reaches `super()`. If a child has no executable body, it uses
// the nearest ancestor constructor (no implicit super()). Method declarations may appear after `extends`.

// [EXT-09] RULE: Direct render returns the active constructor entry's `return` value (child's body if present,
// else the inherited constructor). `super()` in a constructor returns the parent constructor's return value.

// [EXT-10] RULE: At the chain root, calling `this.method(...)` for a method not registered during bootstrap is a
// fatal structural error. A declaration-only `shared var x` at root resolves to `none`.

// [EXT-11] RULE: Multiple inheritance is NOT supported — one parent per `extends`.

// [METH-01] RULE: `method name(args) ... endmethod` defines an override point; call via `this.name(...)`.
// CONSTRAINT: `this.method` WITHOUT `(...)` is a compile error (must be called). Bare `name(...)` is an ordinary
// call, NOT inheritance dispatch.

// [METH-02] RULE: A child override REPLACES the parent method. It may have FEWER trailing arguments than the
// parent, but any KEPT argument must use the SAME name (callers may pass by keyword). Method bodies read/write
// shared state via `this`, read render-context/payload by bare name, but do NOT see constructor-local vars.
// Declaring a shared var and a method with the same name in one file is an error.

// [METH-03] RULE: `super()` calls the parent's version with NO arguments — pass them explicitly (`super(a, b)`)
// when the parent needs them. (Same rule in templates — TPL-17.)
method title()
  return super() + " - About Us"      // parent method, no args
endmethod
method card(user)
  return super(user, "dark")          // explicit args
endmethod
```

### COMPONENT — Component Instances

```javascript
// [COMPONENT-01] RULE: `component "file" as name [with forms]` creates an INDEPENDENT INSTANCE of a script
// hierarchy — its own shared state, constructor run, and method dispatch. `component` is a dedicated keyword.
// CONSTRAINT: a component is NOT an ordinary `var`; it lives only under its `as` binding. It receives NO context
// by default — pass inputs with `with`, add `with context` to also pass the caller's context.
component "widget.script" as header with { initialTheme: "dark" }
component "widget.script" as footer with context

// [COMPONENT-02] RULE: Multiple instances of the same script are FULLY INDEPENDENT (separate state/methods/run).
component "btn.script" as save   with { label: "Save" }
component "btn.script" as cancel with { label: "Cancel" }

// [COMPONENT-03] RULE: Method calls return values directly: `ns.method(...)`.
var h = header.render("Header")

// [COMPONENT-04] RULE: Caller may OBSERVE shared state via the binding (READ-ONLY):
//   ns.var              → shared var snapshot (implicit)
//   ns.var.prop         → implicit snapshot then property lookup
//   ns.ch.snapshot()    → explicit snapshot (REQUIRED for shared text/data/sequence)
//   ns.ch is error / ns.ch#
// CONSTRAINT: caller writes are NOT allowed; names starting with `_` are private (not observable).

// [COMPONENT-05] RULE: The component constructor's return value is IGNORED in component mode (unlike direct render).

// [COMPONENT-06] RULE: Component `with` forms (rules = COMP-*; combinable, object form must come last):
//   with context
//   with var1, var2
//   with context, var1, var2
//   with { key: expr }
//   with context, { key: expr }

// [COMPONENT-07] RULE: The payload does NOT override shared defaults. `with { x: v }` does not write `shared var x`.
// To initialize shared state from payload, read the payload key in the shared default (e.g.
// `shared var theme = initialTheme or "light"`).
```

### Loaders & File Resolution

```javascript
// [IMP-05] RULE: `import`/`extends`/`component`/`include` file names resolve through the env's loader(s).
// With multiple loaders, Cascada tries them in order until one finds the asset. See API-05 for loader shapes.
```

---

# Semantic Library — Template Mode

Templates are Nunjucks-compatible. Differentials below; the full Nunjucks reference applies. Cascada is fully Nunjucks-compatible in NON-async (sync) mode — async-mode isolation/explicit-payload rules below apply only in async mode.

```nunjucks
{# [TPL-01] RULE: Text outside tags renders as output. {{ expr }} interpolates a value. #}
Hello {{ user.name }}

{# [TPL-02] RULE: Logic goes in {% %} tags. Variable decl/assign use `{% set %}` — NOT `var`/`=`. #}
{% set count = count + 1 %}
{% set x, y = none %}

{# [TPL-03] RULE: Comments use {# ... #}. JS-style // and /* */ are NOT template comments. #}

{# [TPL-04] RULE: `data`/`text` channels are SCRIPT-ONLY; templates output text implicitly.
   `sequence` declarations are also script-only — use `!` static context paths for ordered interactions. #}

{# [TPL-05] RULE: Property assignment (obj.prop = v) is SCRIPT-ONLY. Reassign the whole var with {% set %}. #}

{# [TPL-06] RULE: Standalone calls and `!!` repair must use `{% do %}` (no implicit do). #}
{% do service.notify(user) %}
{% do api!! %}

{# [TPL-07] RULE: Block assignment captures rendered text into a var. (Scripts have no equivalent — use a text channel.)
   Distinct from {% set this.name = v %}, which writes shared state — TPL-18. #}
{% set greeting %}
  Hello {{ name }}
{% endset %}

{# [TPL-08] RULE: Functions are {% macro %}; calls RENDER text inline via {{ macro(args) }} (scripts RETURN a value). #}
{% macro greet(name) %}Hello {{ name }}{% endmacro %}
{{ greet("Alice") }}

{# [TPL-09] RULE: Inheritance override points use {% block name(args) %} ... {% endblock %};
   call inherited dispatch with this.name(args) (template equivalent of script this.method(args)). #}
{% block content(user) %}
  Hello {{ user }}
{% endblock %}
{{ this.content(user) }}

{# [TPL-10] RULE: Call blocks use BARE {% call fn() %} ... {% endcall %} (NO assignment form; scripts require assignment).
   `caller()` RENDERS the block body's text inline (scripts return the body's value). #}
{% call wrapper() %}body{% endcall %}
{# inside wrapper macro: #} {{ caller() }}

{# [TPL-11] RULE: `super()` inside an overriding block RENDERS the parent block's text. #}
{% block content(user) %}
  Child {{ user }} — {{ super(user) }}
{% endblock %}

{# [TPL-12] RULE: Same constructs, in tags:
   {% if %}/{% elseif %} (also {% elif %})/{% else %}/{% endif %}
   {% for %}/{% endfor %},  {% asyncEach item in items %}/{% endeach %}  (sequential each opener is asyncEach),
   {% while %}/{% endwhile %},  {% switch %}/{% case %}/{% endswitch %}. #}

{# [TPL-13] RULE: include / import / from-import / extends use {% %} tags.
   `include` is TEMPLATE-ONLY (not in scripts); it follows the same isolation/`with` rules as `import`.
   Templates have NO `component` — render another (even inherited) template via `include`. #}
{% include "f" with context, var1, var2 %}
{% import "f" as lib with { key: expr } %}
{% from "f" import helper with context, var1 %}
{% extends "base.njk" %}

{# [TPL-14] RULE: guard/recover work as in scripts; the effect is that text output from the guarded scope is
   DISCARDED on failure (analogous to channel reverting). Manual `revert` is NOT yet available (see GUARD-07). #}
{% guard %}
  {% set result = riskyCall() %}
  Result: {{ result }}
{% recover %}
  Could not load result.
{% endguard %}
```

## TPL-INHERIT — Inheritance, Blocks, Shared State

```nunjucks
{# [TPL-15] RULE: extends target resolves BEFORE constructor code; may read render context + globals but NOT
   top-level {% set %} values or inferred shared vars. Only whitespace/comments may precede {% extends %}.
   CONSTRAINT: templates do NOT support `extends none`, `extends ... with ...`, or dynamic-null parent selection —
   a template with extends MUST select a parent. Constructor code reaches the parent via an implicit trailing super(). #}

{# [TPL-16] RULE: Async Cascada blocks read render context by default but do NOT capture placement locals
   (loop vars, branch locals, top-level {% set %}). DIFFERENTIAL: classic Nunjucks blocks see the caller frame.
   Pass placement values as block args, use render-context names, or read shared state via this.<name>. #}
{% set user = getUser() %}
{% block greeting(user) %}
  Hello {{ user.name }}
{% endblock %}

{# [TPL-17] RULE: `{% block name(a, b) %}` = positional placement args; `{% block name(arg = localValue) %}` =
   named placement binding. An override may have FEWER block args than the parent, but kept args must keep names
   (named bindings depend on stable names). `super()` renders the parent with NO args — pass explicitly (`super(user)`). #}

{# [TPL-18] RULE: Shared `var` state across the hierarchy uses `this.<name>`.
   DIFFERENTIAL FROM SCRIPTS: NO `shared` declaration — the compiler INFERS shared vars from static this.<name>
   paths. Explicit {% shared ... %} is rejected (script-only). Reserved this.__text__ = inherited text channel. #}
{% set this.theme = "dark" %}
Theme: {{ this.theme }}

{# [TPL-19] RULE: Template shared-var writes are ordinary RUNTIME assignments, not shared-default initializers.
   Top-level child code runs before the implicit parent super(), so a parent constructor assignment can overwrite
   a child one. For shared DEFAULTS, use script `shared var`; template inference only provides the var channel. #}

{# [TPL-20] RULE: Static `this.<name>` uses the inheritance surface even in a template with no extends/block:
   this.name(args) dispatches a block; non-call paths read/write inferred shared vars.
   For plain render data use ordinary context names, NOT `this.<name>`.
   Dynamic `this[expr]` is NOT supported in inheritance templates. #}

{# [TPL-21] RULE: Composition `with` clauses and the explicit payload model are ASYNC-ONLY (sync Nunjucks retains
   implicit access to all parent-scope variables). They apply to include/import/from-import, NOT to inheritance extends. #}

{# [TPL-22] RULE: Template leniency vs script strictness:
   - A bare name that is neither declared nor in context → `undefined` (renders empty); in SCRIPTS it → poison.
   - Property access on scalars/none and loops over scalars stay lenient (undefined / loop else), NOT poison.
   - `==`/`!=` are LOOSE and operands use JS coercion (scripts are strict/typed). Invalid `in` operands poison in BOTH modes. #}

{# [TPL-23] RULE: No-shadowing applies to {% for %}/{% asyncEach %} targets, call-block params, import namespaces,
   from-import names, and block args (all introduce a fresh binding). `{% set %}` is EXEMPT — reusing a visible name
   reassigns it. Macros have their own scope, so their params may reuse outer names. `$` is reserved in identifiers. #}
```

## TPL-SCOPE — Scoping (Async vs Classic)

| Construct | Classic Nunjucks / sync | Async Cascada Template |
|:---|:---|:---|
| `if` / `switch` | No scope; `{% set %}` writes to parent | Local scope per branch |
| `for`/`asyncEach` body | Iterations share one inner scope, discarded after | Each iteration isolated |
| `while` body | Uses parent scope | Each iteration isolated |
| `include` | Sees caller's `{% set %}` vars | Isolated; only `with` inputs |
| `import` | Macros see only own args | Isolated; only `with` inputs |
| `block` | Sees caller frame | Render context + declared args; no placement locals |
| Child top-level `{% set %}` | Visible in child's blocks | Not captured; pass as block arg or use `this.<name>` |

---

# Script ↔ Template Quick Reference

| Feature | Script | Template |
|:---|:---|:---|
| Text output | `text t` + `t("...", value)` | implicit (text outside tags) |
| Variable decl | `var x = e` | `{% set x = e %}` |
| Reassignment | `x = e` | `{% set x = e %}` |
| Multi-var | `var x, y = none` | `{% set x, y = none %}` |
| Comments | `// ...`  `/* ... */` | `{# ... #}` |
| Filters | `name \| upper` | `{{ name \| upper }}` |
| Exec-only call | `service.notify(u)` | `{% do service.notify(u) %}` |
| Sequential path repair | `api!!` | `{% do api!! %}` |
| If | `if/elif/else/endif` | `{% if %}/{% elseif %} (or {% elif %})/{% else %}/{% endif %}` |
| For | `for x in xs / endfor` | `{% for %} / {% endfor %}` |
| Each (sequential) | `each x in xs / endeach` | `{% asyncEach x in xs %} / {% endeach %}` |
| While | `while c / endwhile` | `{% while %} / {% endwhile %}` |
| Switch | `switch / case / endswitch` | `{% switch %} / {% case %} / {% endswitch %}` |
| Function | `function f(a) / endfunction` | `{% macro f(a) %} / {% endmacro %}` |
| Function call | `var r = f(a)` (returns value) | `{{ f(a) }}` (renders text) |
| Call block | `var x = call f() / (p) / return v / endcall` | `{% call f() %} ... {% endcall %}` |
| `caller()` | returns body's `return` value | renders body's text |
| Block assignment | n/a (use `text` channel) | `{% set v %} ... {% endset %}` |
| Inheritance | `extends "f"` (also dynamic / `none`) | `{% extends "f" %}` (static only) |
| Override | `method n(a) / endmethod` | `{% block n(a) %} / {% endblock %}` |
| `super()` | no args (pass explicitly) | no args (pass explicitly) |
| Shared var decl | `shared var theme = "x"` | (inferred — no decl) |
| Shared write | `this.theme = "x"` | `{% set this.theme = "x" %}` |
| Shared read | `this.theme` | `{{ this.theme }}` |
| Include | n/a | `{% include "f" with context, v %}` |
| Import ns | `import "f" as lib` | `{% import "f" as lib %}` |
| Import names | `from "f" import h` | `{% from "f" import h %}` |
| Component | `component "f" as ns with ...` | n/a (use `include`) |
| Guard | `guard / recover / endguard` | `{% guard %} / {% recover %} / {% endguard %}` |
| Revert | WIP (unavailable) | WIP (unavailable) |

---

# Constraint Index (Quick Lookup)

| # | Constraint | UID |
|:---|:---|:---|
| C1 | Cannot reassign an undeclared name (no implicit globals) | VAR-02 |
| C2 | Cannot redeclare a name visible in any enclosing scope (all binders) | VAR-01, VAR-04 |
| C3 | Property assignment (`obj.prop = v`) is SCRIPT-ONLY | VAR-06, TPL-05 |
| C4 | Cannot mutate the context object directly (copy to a local first) | VAR-08 |
| C5 | Inline conditional ONLY `a if c else b` (no `?:`) | EXPR-03 |
| C6 | Boolean ops use words `and`/`or`/`not` only | EXPR-02 |
| C7 | `loop.length`/`loop.last` unavailable in `each`, bounded async-iter `for of N`, `while` | LOOP-07 |
| C8 | `switch` has no fall-through, no `break` | CTRL-02 |
| C9 | Channels/sequence cannot cross composition boundaries (only `var` via `with`) | CHAN-03 |
| C10 | `data` does NOT auto-init numbers/booleans | DATA-02 |
| C11 | Arithmetic/logical ops on a missing/none `data` path throw | DATA-07 |
| C12 | `sequence` initializer must come from context | SEQ-01 |
| C13 | Property assignment on a `sequence` is a compile error | SEQ-02 |
| C14 | `!` paths must reference context, not local vars | SEQOP-04 |
| C15 | Method-`!` (`obj.method!()`) does NOT serialize unmarked same-method calls | SEQOP-02 |
| C16 | `!` guarantees order+run, NOT completion at render; fold result into return to await | SEQOP-05 |
| C17 | Script `call` block REQUIRES assignment form; templates use bare `{% call %}` | CALL-01, TPL-10 |
| C18 | `x#` returns `none` if x is not an error | ERR-06 |
| C19 | Side-effect-only statement (bare call / `{% do %}`) drops its error; bind to detect | ERR-04b |
| C20 | Function scope is isolated (no caller locals); cannot dispatch `this.method()`/shared | FUNC-01, FUNC-03 |
| C21 | In scripts, only `shared` decls/comments/whitespace may precede `extends` | EXT-02 |
| C22 | Every file using `this.<name>` must declare it locally | EXT-04 |
| C23 | First initializer in child→parent order claims the shared default | EXT-05 |
| C24 | Bare assignment to a shared name writes a local; use `this.x = v` | EXT-06 |
| C25 | `this.method` without `(...)` is a compile error | METH-01 |
| C26 | Override may drop trailing args; kept args must keep their names | METH-02, TPL-17 |
| C27 | `super()` passes NO args in both modes; pass explicitly | METH-03, TPL-17 |
| C28 | Constructor-local vars (after `extends`) not visible in method bodies | METH-02 |
| C29 | At chain root, `this.method(...)` for an unregistered method is fatal | EXT-10 |
| C30 | Multiple inheritance not supported (one parent per `extends`) | EXT-11 |
| C31 | Component shared state is READ-ONLY from the caller; `_`-names private | COMPONENT-04 |
| C32 | Component implicit snapshot only for shared `var` (text/data/seq need explicit `.snapshot()`) | COMPONENT-04 |
| C33 | Composition payload does NOT override shared defaults | COMPONENT-07 |
| C34 | `guard *` cannot combine with other selectors; duplicates invalid | GUARD-03 |
| C35 | `guard` variable protection blocks dependents until the guard finishes | GUARD-06 |
| C36 | Manual `revert` is WIP — unavailable in BOTH script and template | GUARD-07, TPL-14 |
| C37 | Templates use `{% set %}`/`{% do %}`/`{% block %}`/`{% macro %}` (not `var`/`=`/`method`/`function`) | TPL-02, TPL-06, TPL-08, TPL-09 |
| C38 | Templates infer shared vars from `this.<name>`; `{% shared %}` rejected | TPL-18 |
| C39 | `with` payloads are ASYNC-ONLY (sync Nunjucks keeps implicit caller scope); not applicable to `extends` | TPL-21 |
| C40 | Template `include`/`component` availability differs from scripts | TPL-13, COMPONENT-01 |
| C41 | Deep-copy assignment semantics for objects/arrays | VAR-05 |
| C42 | Errors short-circuit conditional/loop bodies AND poison every var/channel any branch would write | ERR-02, ERR-03 |
| C43 | Property access on `none`/scalar → Error; object/array/string missing reads → undefined | LANG-05 |
| C44 | Templates stay lenient (unknown name → undefined, loose `==`, scalar/none/scalar-loop lenient); scripts poison | TPL-22 |
| C45 | Stateful Nunjucks globals (`cycler.next()`, `joiner()`) must run in sequential context (`each`) | EXPR-08, EXPR-09 |
| C46 | Scripts use `elif`; templates use `{% elseif %}` (also accept `{% elif %}`) | CTRL-01, TPL-12 |
| C47 | Template sequential-each opener is `{% asyncEach %}` ... `{% endeach %}` | TPL-12 |
| C48 | Templates: no `extends none`, no `extends ... with`, no dynamic-null parent; static parent required | TPL-15 |
| C49 | Object literals require explicit keys (`{ name: name }`, not `{ name }`) | EXPR-06 |
| C50 | Identifier names cannot contain `$` (reserved for compiler internals) | LANG-06 |
| C51 | Script arithmetic/order operators are typed; `+` is string+string only; use `~` / `\| int` / `\| float` | EXPR-01 |
| C52 | Render methods reject with CompileError/RuntimeError/PoisonError/PoisonErrorGroup; catch via instanceof | ERR-14 |
| C53 | ESM only for browser/new code; old UMD bundles and `window.nunjucks` are unsupported | API-06 |
| C54 | Compound assignment (`+=`, `++`, ...) on a plain `var` is unsupported (data paths only) | VAR-09 |

---

# API Reference

## Imports

```javascript
// Compile-from-source entry:
import {
  AsyncEnvironment, FileSystemLoader,
  precompileScript, precompileTemplateAsync,
  raceLoaders,
  PoisonError, CompileError, RuntimeError
} from 'cascada-engine';

// Precompiled-only entry (no compiler/parser/lexer/precompile API):
import { AsyncEnvironment, PrecompiledLoader } from 'cascada-engine/precompiled';
```

## AsyncEnvironment

```javascript
// [API-01] new AsyncEnvironment([loaders], [opts])
//   loaders: a single loader or an array (tried in order until one finds the asset).
//   opts:
//     autoescape:       default true   — auto-escape template output
//     throwOnUndefined: default false  — throw on undefined render
//     loadFailFatal:    default true   — missing/failed import|from-import|component|include is fatal;
//                                        false → LoadFailed poison (import/component) or empty render (include);
//                                        array e.g. ['import'] → only listed kinds fatal. Root & extends ALWAYS fatal.
//     trimBlocks:       default false  — remove the first newline after a block tag
//     lstripBlocks:     default false  — strip leading whitespace from a block tag
//     tags:             override delimiters
const env = new AsyncEnvironment(new FileSystemLoader('scripts'), { trimBlocks: true });

// [API-02] Execution (all return Promises):
const r1 = await env.renderScript('name.casc', context);     // file   → explicit return value
const r2 = await env.renderScriptString(source, context);    // string → explicit return value
const r3 = await env.renderTemplate('page.njk', context);    // file   → string
const r4 = await env.renderTemplateString(source, context);  // string → string

// [API-03] Compilation / caching:
const s = await env.getScript('name.casc');     // reusable Script;  s.render(ctx)
const t = await env.getTemplate('page.njk');    // reusable AsyncTemplate; t.render(ctx)

// [API-04] Globals / extensions:
env.addGlobal(name, value);
env.addFilter(name, fn, [isAsync]);
env.addFilterAsync(name, fn);
env.addDataMethods({ name: (target, ...args) => newValue });   // see DATA-08
```

## Loaders

```javascript
// [API-05] Built-in: FileSystemLoader (Node), NodeResolveLoader (Node), WebLoader (Browser), PrecompiledLoader.
// Loader function returns: { src, path, noCache } | null   (null → fall back to the next loader).
const networkLoader = async (name) => {
  const r = await fetch(`https://cdn.x/${name}`);
  if (!r.ok) return null;
  return { src: await r.text(), path: name, noCache: false };
};
// Loader class API:
//   load(name)         REQUIRED — string | LoaderSource | null
//   isRelative(name)   optional — bool
//   resolve(from, to)  optional — string
//   on(event, handler) optional — env events
// raceLoaders(loaders) — runs loaders concurrently; first success wins.
const fast = raceLoaders([ new WebLoader('https://cdn.x/'), new FileSystemLoader('scripts/backup/') ]);
```

## Browser / ESM

```javascript
// [API-06] ESM is required for browser/new code; old UMD bundles and automatic `window.nunjucks` globals
// are NOT supported by the ESM package.
import { AsyncEnvironment } from 'cascada-engine';
```

## Precompilation

```javascript
// [API-07] Precompile to JS for production. opts.env ensures filters/globals/dataMethods are bundled.
precompileScript(path, [opts]);
precompileTemplate(path, [opts]);          // sync template
precompileTemplateAsync(path, [opts]);     // async template (Cascada)
precompileScriptString(source, [opts]);
precompileTemplateString(source, [opts]);
precompileTemplateStringAsync(source, [opts]);
// CLI:
//   cascada-precompile views       --mode template
//   cascada-precompile views       --mode template-async
//   cascada-precompile script.casc --mode script --format esm
```

---

# Appendix

## UID Index

| Category | UIDs |
|:---|:---|
| EXEC | 01–06 (invariants) |
| LANG | 01–06 |
| VAR | 01–09 |
| EXPR | 01–09 |
| LOOP | 01–08 |
| CTRL | 01–02 |
| CHAN | 01–04 |
| TEXT | 01 |
| DATA | 01–09 |
| SEQ | 01–04 |
| SEQOP | 01–05 |
| FUNC | 01–03 |
| CALL | 01–03 |
| RETURN | 01–03 |
| ERR | 01–14 (incl. 04b, 07b) |
| GUARD | 01–07 |
| IMP | 01–05 |
| COMP | 01–05 |
| EXT | 01–11 |
| METH | 01–03 |
| COMPONENT | 01–07 |
| TPL | 01–23 |
| API | 01–07 |

## Notes on Source Authority

- When this reference disagrees with `docs/cascada/script.md` or `docs/cascada/template.md`, the source documents win.
- Standard JavaScript / Python / Nunjucks behaviors are NOT documented here unless they differ in Cascada.
- Script-mode and Template-mode constructs are NOT interchangeable. Use the syntax of the active mode.
