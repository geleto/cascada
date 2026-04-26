# Script Return Architecture

## Overview

Script `return` is implemented as a source-to-source rewrite in the script
transpiler. The compiler and runtime continue to use the existing internal
`__return__` channel as the return value carrier.

The core idea is:

1. A script `return` writes to the ordered `__return__` channel.
2. `__return__ == __RETURN_UNSET__` is a valid ordered read of that channel.
3. After a return has appeared in a lexical execution path, all following
   statements in that path are guarded by `if __return__ == __RETURN_UNSET__`.
4. The guard propagates outward through enclosing blocks until the current
   function boundary is reached.

This preserves Cascada's model: code can still be compiled as ordinary Cascada
control flow, and ordered channel reads provide temporal correctness without
turning the language into an imperative stop-the-world execution model.

## Goals

- Make `return` behave like a real script/function return: statements after an
  executed return must not execute in the same function body.
- Preserve Cascada's maximal concurrency and temporal correctness by expressing
  return state as ordered channel reads.
- Keep the implementation in the script transpiler. The compiler should receive
  normal template tags such as `return`, `if`, `endif`, `while`, and `endwhile`.
- Preserve physical line numbers after script transpilation: the generated
  template should keep the same physical line count and source-line alignment as
  the script input.

## Required Decisions And Invariants

The return rewrite depends on a few compiler/runtime invariants. These are
blocking prerequisites, not optional confirmations.

### `__RETURN_UNSET__` Visibility

`__RETURN_UNSET__` is not a user variable. The runtime sentinel currently exists
as `runtime.RETURN_UNSET`.

The implementation must make `__RETURN_UNSET__` a compiler-recognized internal
symbol:

```cascada
__return__ == __RETURN_UNSET__
```

must compile as an ordered read of the current return channel compared with
`runtime.RETURN_UNSET`.

The transpiler may emit the name `__RETURN_UNSET__`, but user scripts must not
be able to declare or shadow it. The compiler must treat it like an internal
symbol rather than a normal context lookup.

### `__return__` Ownership And Initialization

The transpiler does not declare or initialize `__return__`.

Return-channel initialization remains the compiler's responsibility. Each
return-owning scope declares a function/script-local `__return__` var channel
initialized to `runtime.RETURN_UNSET`.

Return-owning scopes include:

- script root
- function/method bodies
- caller/callback bodies whose return value is local to that invocation

### Child Buffer Visibility

Injected guards inside nested control flow and loop bodies must observe the same
function-local `__return__` channel as the `return` statement writes.

This is a required invariant. If child buffers cannot currently observe the
function-local return channel because `__return__` is excluded from linked
channels, implementation must add a deliberate return-channel observation path
or adjust linking/lookup for return channels. The guard architecture is only
correct if:

```cascada
if __return__ == __RETURN_UNSET__
```

is an ordered read of the same return channel that later/following `return`
statements write.

### Return-State Reads Must Ignore Return-Value Errors

Injected guards ask only whether a return has happened. They must not consume or
report the returned value's error state.

This matters when a script returns a poison/error value. A normal channel
snapshot may inspect the return channel target and surface the poison. That is
wrong for guard control flow: later statements should be skipped because return
happened, and the final return resolution should be responsible for reporting
the returned error.

Therefore `__return__ == __RETURN_UNSET__` in injected guards must compile to an
ordered return-state read that can distinguish `runtime.RETURN_UNSET` from "any
set return value" without throwing because the return value is poison.

Implementation options:

- compile this exact internal comparison to a raw/no-error return-channel
  observation
- add a dedicated runtime/compiler primitive such as
  `returnIsUnset(__return__)`
- add a return-channel command that resolves only whether the return channel is
  still unset

The ordinary final return snapshot must continue to inspect and report returned
errors.

### First Visible Return

"First visible return wins" means first according to Cascada's ordered channel
semantics, not wall-clock completion order.

This depends on the child-buffer visibility invariant above. In a parallel
`for`, guarding the return statement itself is sufficient only if the guard read
is ordered against prior writes to the same function-local return channel. If
that invariant cannot be satisfied, parallel `for` return needs a stronger
runtime primitive, such as compare-and-set on the return channel.

### Compile-Time Declarations

The return guard controls runtime execution, not compile-time declaration
registration.

Constructs that are collected or registered at compile time may still be
available even if they appear textually after a `return`. This can include
function/method declarations, imports, inheritance/composition metadata, and
extern declarations depending on their current implementation.

The implementation must classify script constructs into:

- runtime statements that should be guarded after return
- compile-time declarations/metadata that should still be collected
- constructs that are invalid after return if guarding would produce malformed
  script/template syntax

Tests should lock down this behavior instead of assuming every line after
`return` is a normal runtime statement.

## Return State

The internal return channel starts with a sentinel value:

```text
__return__ = __RETURN_UNSET__
```

The sentinel means no return has been executed for the current function/script
body. A normal `return expr` writes `expr` to `__return__`. From that point,
ordered reads of:

```cascada
__return__ == __RETURN_UNSET__
```

evaluate to false after the return write is visible in source order.

This is intentionally channel-based rather than a separate JavaScript flag. It
lets Cascada's existing ordered output/channel machinery decide when the return
has happened relative to other source-ordered effects.

## Semicolon Logical Lines

To preserve physical line numbers after transpiling script to template, injected
guard tags must not add new newline characters to the generated template.
Semicolon support should be added at the lexer/logical-line layer, because the
lexer already knows which spans are code and which spans are strings, comments,
template literals, or regexes.

The lexer should split semicolon-separated logical statements inside `CODE`
tokens:

```cascada
return value; if __return__ == __RETURN_UNSET__
```

is treated like two logical script lines on the same physical line:

```cascada
return value
if __return__ == __RETURN_UNSET__
```

The rule applies only inside `CODE` tokens. Semicolons inside strings, comments,
template literals, and regex tokens are data, not logical separators.

Each split statement should be represented as a logical line that keeps the same
physical source line number. Logical lines created by semicolon splitting should
carry a flag:

```javascript
{
  tokens: [...],
  physicalLine: 12,
  logicalIndex: 1,
  isSemicolonLine: true
}
```

The first logical statement on a physical line has `isSemicolonLine: false`.
Subsequent logical statements from the same physical line have
`isSemicolonLine: true`.

Generated template output should remain on the same physical line. The
semicolon is a lexer/transpiler logical separator, not script output text. The
transpiler should therefore join logical semicolon lines without inserting a
newline in the generated template.

Injected return guards should use the same mechanism as user-authored
semicolons. In other words, `return value; if __return__ == __RETURN_UNSET__` should
not be special string concatenation; it should produce two logical statements on
one physical line.

Semicolon splitting must also preserve comment placement. If a physical line has
a trailing `//` comment, injected semicolon logical statements for that line must
not be emitted inside the comment text. The logical-line representation should
keep code statements and comments as separate token-aware pieces so output
generation can place generated tags safely.

Semicolon logical lines inherit the physical line's indentation for formatting,
but their `colno` should reflect the logical statement's start position after
the semicolon. This keeps error locations useful without adding physical lines.

## Basic Rewrite

For a simple top-level return:

```cascada
var a = first()
return a
var b = second()
return b
```

the transpiler behaves as though it rewrote the script to:

```cascada
var a = first()
return a; if __return__ == __RETURN_UNSET__
var b = second()
return b; if __return__ == __RETURN_UNSET__
endif
endif
```

The physical output should keep injected `if` and `endif` on existing physical
lines where possible, using semicolon logical statements.

There are two closing `endif`s because each `return` opens a guard for all
following statements in the same function/script body. Multiple returns
therefore create nested guards.

## Guard Cascade

The transpiler maintains a block stack. Each stack frame tracks:

- the block tag (`root`, `if`, `for`, `while`, `function`, etc.)
- the expected end tag, or enough metadata to derive it from `blockPairs`
- whether this frame is a function boundary
- whether this frame is a loop, and if so whether it is `for` or `each`
- whether a return occurred inside this frame
- whether a return guard is currently open in this frame

When a `return` is processed:

1. Emit the original `return`.
2. Emit `; if __return__ == __RETURN_UNSET__` on the same physical line.
3. Mark the current frame as having an open return guard.
4. Mark the current frame as containing a return.

The current frame is the block that lexically contains the `return` at the
moment the return is processed. The opened guard belongs to that frame. Later
nested blocks that appear inside the guarded region do not take ownership of the
guard, and their end tags must not close it.

For example:

```cascada
sometag
  return x
  anothertag
    work()
  endanothertag
endsometag
```

The injected `if` opened after `return x` belongs to `sometag`, because
`sometag` was the current frame when the return was processed. `endanothertag`
does not close that guard, even though it is the first end tag after the return.
The guard closes before `endsometag`:

```cascada
sometag
  return x; if __return__ == __RETURN_UNSET__
  anothertag
    work()
  endanothertag
  endif; endsometag
```

When an end tag is processed:

1. If the closing frame has an open return guard, emit `endif; ` before the end
   tag on the same physical line.
2. Emit the original end tag.
3. Pop the closing frame.
4. If the popped frame contained a return and the new parent frame is not a
   function boundary, emit `; if __return__ == __RETURN_UNSET__` after the end tag on
   the same physical line.
5. Mark the parent frame as having an open return guard and containing a return.

The propagation stops at the function boundary. A return inside a function must
not guard code after the function declaration in the outer scope.

## Return-Owning Scopes And Boundaries

The script root is a return-owning scope. It has no closing end tag, so return
guards opened at the root are closed at EOF by appending generated `endif`
logical statements to the last physical source line.

Callable bodies are also return-owning scopes. The guard cascade stops at these
boundaries. In user-facing script syntax this includes:

- `function ... endfunction`
- `method ... endmethod`
- assigned call blocks written as `var x = call ... endcall` or
  `x = call ... endcall`
- any aliases or lowered forms used by the transpiler for script functions
- callback/caller bodies whose `return` is local to that callable body

The generated template uses the internal tag pair
`call_assign ... endcall_assign` for assigned call blocks. Return handling should
understand that internal pair as the callable boundary, while documentation and
user-facing syntax should refer to the assigned `call ... endcall` form.

Implementation should use the script transpiler's block model, not only the
surface spelling, so future aliases remain correct.

Example:

```cascada
function pick(x)
  if x
    return "yes"
  endif
  return "no"
endfunction

var value = pick(flag)
return value
```

The return inside `pick` guards only the rest of `pick`. It must not guard
`var value = ...` or the outer `return value`.

Raw/verbatim bodies are not parsed as script control flow. Text that looks like
`return`, `if`, `endif`, or contains semicolons inside raw/verbatim content must
not trigger return rewriting or semicolon logical-line splitting.

## Middle Tags

Middle tags such as `else`, `elif`, `case`, `default`, and recovery-style middle
tags are block transition points. If a return guard is open in the current branch,
it must be closed before emitting the middle tag, otherwise the middle tag would
bind to the injected guard rather than the original control-flow block.

Example source:

```cascada
if ok
  return a
else
  return b
endif
next()
```

Conceptual rewrite:

```cascada
if ok
  return a; if __return__ == __RETURN_UNSET__
  endif
else
  return b; if __return__ == __RETURN_UNSET__
  endif
endif; if __return__ == __RETURN_UNSET__
next()
endif
```

The exact generated template should preserve physical line count using semicolon
logical statements.

## While Loops

If the enclosing callable may return, `while` conditions must include the return
guard so another iteration is not started after a return:

```cascada
while condition
  body()
endwhile
```

becomes:

```cascada
while __return__ == __RETURN_UNSET__ and (condition)
  body()
endwhile
```

If the loop body also contains a return, the normal guard cascade still applies
inside and after the loop body.

The condition must preserve the user's original expression with parentheses so
operator precedence does not change.

This intentionally changes condition evaluation after a return. If the original
condition performs ordered observations or other work, that condition is skipped
once `__return__` is no longer `__RETURN_UNSET__`. That is the point of the rewrite:
after return, later loop-condition work is no longer part of the active source
path.

Because this rewrite depends on whether the enclosing callable may return, the
transpiler needs either:

- a pre-pass that marks callable/root bodies that contain runtime `return`
  statements, excluding nested callable declarations and raw/verbatim content
- or an explicit decision to rewrite all `while` loops unconditionally

The preferred approach is the pre-pass, so scripts without returns do not pay for
dead return checks.

## For Loops

`for` does not expose a source-level condition that can be rewritten in the same
way as `while`. The guard cascade still prevents statements after a return from
running within an active iteration path:

```cascada
for item in items
  return item
  after()
endfor
outside()
```

conceptually becomes:

```cascada
for item in items
  return item; if __return__ == __RETURN_UNSET__
  after()
  endif
endfor; if __return__ == __RETURN_UNSET__
outside()
endif
```

### For With Return

`for item in items with return` is the explicit syntax for normal sequential
short-circuit return behavior in loops.

This syntax is script-level syntax. The transpiler must recognize the trailing
`with return` before passing the loop to the template parser, because the parser
currently treats the loop iterable as a normal expression after `in` and has no
user-facing `with return` loop option.

The intended script grammar is:

```text
for <target> in <iterable> with return
```

The transpiler should lower it to an internal sequential loop representation
with a return-guard option. The exact generated template syntax should be
compiler-facing and unambiguous; it does not need to be user-facing script
syntax.

Because `for ... with return` is explicitly sequential/return-aware, the loop
implementation can observe the function-local return channel before starting the
next iteration. The guard cascade still handles statements inside the active
iteration, but loop advancement must also check `__return__ == __RETURN_UNSET__` so
later iterations are not started after return.

### Parallel For

`for` is parallel by default. A return inside a parallel `for` is not a
cancellation primitive and is not a side-effect barrier. Work that appears before
the return point in other iterations may already have started, and that work may
still complete after one iteration returns.

Example:

```cascada
for item in items
  doSomeWorkWithSideEffects(item)
  if item.ok
    return item
  endif
endfor
```

Many iterations may already be running `doSomeWorkWithSideEffects(item)` before
the first return becomes visible.

However, the return statement itself should be guarded inside a `for` loop:

```cascada
if __return__ == __RETURN_UNSET__
  return item
endif
```

This prevents later ordered returns from overwriting the first visible return
value. Combined with the normal guard waterfall, the conceptual rewrite is:

```cascada
for item in items
  doSomeWorkWithSideEffects(item)
  if item.ok
    if __return__ == __RETURN_UNSET__
      return item; if __return__ == __RETURN_UNSET__
      endif
    endif
  endif
endfor; if __return__ == __RETURN_UNSET__
outside()
endif
```

The semantics are:

- all already-started parallel iteration work may still run
- statements after a return in the same source path are guarded
- statements after the return point in later source-ordered iterations are also
  guarded, so they do not run after the first visible return
- this guard is an ordered return-channel read; therefore post-return-path work
  in later iterations may wait for earlier return-state checks, which partially
  reduces concurrency after the return point
- code after `endfor` in the enclosing scope is guarded
- once one return has set `__return__`, later return statements in the loop are
  skipped
- the first visible return value is the value returned from the function/script

The transpiler-level responsibility is to make return state explicit and
source-ordered. It does not cancel concurrent work that has already been
scheduled. The tradeoff is that the generated guards introduce ordered
observation points after possible returns, so code after those guards may be
less parallel than ordinary `for` body code before the return point.

## Nested Blocks

Return guards must propagate through nested blocks until a function boundary:

```cascada
if a
  if b
    return value
  endif
  afterInner()
endif
afterOuter()
```

Conceptual rewrite:

```cascada
if a
  if b
    return value; if __return__ == __RETURN_UNSET__
    endif
  endif; if __return__ == __RETURN_UNSET__
  afterInner()
  endif
endif; if __return__ == __RETURN_UNSET__
afterOuter()
endif
```

The important property is that every statement after the return in the same
function is dominated by an ordered `__return__ == __RETURN_UNSET__` check.

## Continuations And Comments

The rewrite must respect the existing multi-line expression machinery.

- Do not insert guards in the middle of a continued expression.
- A `return` line that continues onto later physical lines should receive its
  guard only after the logical return statement is complete.
- Comments attached to a line should stay attached to that physical line.
- Semicolon splitting is part of the lexer/logical-line layer. It should happen
  after the lexer has classified spans on a physical line, using only
  semicolons from `CODE` spans as logical-line separators.
- Raw/verbatim content must not be semicolon-split or return-rewritten.

At end of file, any open root-level injected guards must be closed without
creating unrelated source lines. The preferred representation is to append the
needed `endif` logical statements to the last physical line as semicolon logical
lines. If the source is empty, associate the synthetic closure with line 1.

If the last physical line is comment-only or has a trailing line comment, EOF
closures still use that physical line for source mapping, but output generation
must not place the generated `endif` inside the user's comment. The generated
logical statements should be emitted as tags associated with that line's
metadata, not as raw text appended to the comment token.

## Validation Rules

The transpiler should reject or avoid generating malformed guard structure:

- Every injected `if` must have a matching injected `endif`.
- Injected guards must not cross function boundaries.
- Injected guards must close before middle tags.
- `while` condition rewriting must not alter expression precedence.
- Logical semicolon splitting must not split strings, comments, template
  literals, or regexes.
- `__RETURN_UNSET__` must not be user-declarable or shadowable.
- Return guards inside child buffers must resolve to the nearest function-local
  return channel.
- Injected return-state reads must not surface poison/error values stored as the
  return value.
- Raw/verbatim content must remain untouched.
- The implementation must define which compile-time declarations remain
  effective after an earlier textual return.

## Parser Coding Style

Keep the implementation aligned with the current script transpiler style.

- Prefer existing parsed fields such as `firstWord`, `tagName`, `blockType`,
  `codeContent`, and token arrays.
- Prefer helper methods like `_getFirstWord`, `_getBlockType`,
  `_processLine`, `_generateOutput`, and the existing channel/block-scope
  helpers.
- Do not introduce broad regular-expression parsing for return guards,
  semicolon handling, while rewriting, or block matching.
- Use token-aware logic for semicolon splitting so only `CODE` tokens are split.
- Use the existing block stack concepts and tag metadata instead of matching
  raw strings such as `endif` / `endfor` with ad hoc patterns.
- Keep transformations explicit and local: inspect the processed logical line,
  decide whether it is a `return`, `while`, middle tag, start tag, or end tag,
  then emit the appropriate injected logical statements.

Regular expressions may still be appropriate for the small existing validation
helpers that already use them, but this feature should not add a second parsing
style beside the token/`firstWord` pipeline.

## Scope And Error-Context Effects

Injected guards create real `if` blocks. That means following runtime statements
may be compiled inside additional branch scopes.

This is intentional, but it must be accounted for:

- declarations after a return are inside the injected guard
- following statements that reference those declarations are also inside the
  same guard, preserving normal runtime visibility for reachable code
- declarations in later branches must still obey existing duplicate/shadowing
  rules
- branch-scope transitions for `else`, `elif`, `case`, `default`, and `recover`
  must account for both the user's block and the injected guard block

Injected guards should use stable synthetic source positions:

- the guard opened immediately after a `return`   should use the return line and a
  column at or just after the end of the return statement
- an `endif` inserted before an end tag should use the end tag's physical line
  and column
- EOF closure guards should use the last physical line, or line 1 for an empty
  script

If an injected guard itself fails, the error should be attributable to the
nearest relevant source construct rather than to an unrelated generated location.

## Guard/Recover Semantics

`guard/recover` has both control-flow and error-recovery semantics. Return
rewriting must preserve the guard construct before deciding return behavior.

Required semantics:

- A return inside the guard body opens a return guard for the rest of that guard
  branch.
- The injected guard must close before `recover` so `recover` remains attached to
  the original `guard`.
- If the guard body returns and no recovery path runs, the return cascades after
  `endguard`.
- If recovery runs and returns, the recovery return is the return visible after
  `endguard`.
- If both error recovery and return value behavior could apply, existing guard
  error semantics decide whether recovery executes; return rewriting must not
  bypass that decision.

These cases need integration tests because syntax-only checks will not catch
wrong recovery behavior.

## Return Value Timing

A return expression may be asynchronous. The return channel becomes observably
set only when the return write is visible through Cascada's ordered channel
machinery.

Consequences:

- later source-ordered guards may wait for the return write/value to settle
  before deciding whether to skip
- this is intentional and matches Cascada temporal correctness
- a rejected/poisoned return value still means "return happened"; guard
  decisions must use return-state reads that do not surface the returned error
- final return resolution remains responsible for awaiting/reporting the return
  value

## Testing Strategy

Prefer integration tests over brittle unit tests. The primary confidence signal
should be rendering real scripts through `AsyncEnvironment.renderScriptString`
and asserting deterministic results and side effects.

Use focused lower-level tests only for contracts that are difficult to observe
through script execution, such as semicolon token splitting and physical
line-number preservation.

Integration tests:

- simple return followed by statements
- return inside `if`
- return inside `if/else`
- nested returns
- return inside function does not guard outer code
- `while` condition rewrite
- top-level early return skips later statements
- function early return skips later function statements
- nested return skips outer sibling statements until function boundary
- `while` stops after return
- return value can be `none`/`undefined`
- return value can be an error/poison value and is still reported by final return
- returned error/poison values do not make injected guards report the error early
- `for item in items with return` provides normal sequential short-circuit
  behavior
- parallel `for` first visible return wins while pre-return side effects may
  still run
- raw/verbatim contents that look like return code are ignored by return
  rewriting
- compile-time declarations after return follow the documented classification

Focused contract tests:

- semicolons inside strings/comments/regex are not split
- injected guards preserve physical line count
- semicolon logical lines retain the original physical line number
- injected guard source positions are stable and point at the nearest relevant
  source construct

## Implementation Steps

### Phased Rollout

The detailed steps below should be implemented in dependency order, but several
steps are best landed as grouped phases so each milestone has a coherent
behavioral boundary.

#### Phase 1. Return Channel Invariants

Covers steps 0 and 3.

Audit and complete the compiler/runtime prerequisites before changing the
script lowering pipeline: `__RETURN_UNSET__`, `__return__` visibility from child
buffers, poison-safe return-state reads, and user-shadowing protection.

Several pieces already exist in the codebase, including `runtime.RETURN_UNSET`,
the internal `__return__` channel, raw snapshots, and return-channel
declaration. Treat this phase as an invariant audit plus any missing narrow
integration work.

Phase 1 review status:

- Fixed in Phase 1: `__RETURN_UNSET__` is reserved and compiled as
  `runtime.RETURN_UNSET`.
- Fixed in Phase 1: exact return-state comparisons use an ordered,
  poison-inspection-free return-state observation rather than an ordinary
  return-channel snapshot.
- Fixed in Phase 1: child control-flow and loop buffers link the current
  function-local `__return__` channel when they read return state.
- Fixed in Phase 1: the inverse internal comparison
  `__return__ != __RETURN_UNSET__` preserves ordinary observable-command
  rejection behavior.
- Test organization: return-specific tests should live in `tests/pasync/return.js`.
  Later phases should extend this file or split by behavior/domain if it grows
  too large, not by implementation phase number.
- No Phase 1 transitional scaffolding is known to be removable. Raw snapshots
  remain used for var overwrite behavior, while the dedicated return-state
  command remains the intended primitive for injected guards.
- Postponed to Phase 3: actual guard injection and cascade behavior.
- Postponed to Phase 4: parallel-`for` return-statement wrapping and
  `for ... with return` loop advancement checks.

#### Phase 2. Transpiler Infrastructure

Covers steps 1, 2, and 3a.

Add semicolon logical lines, refactor `scriptToTemplate()` to consume logical
lines, and add the return-analysis pre-pass. This phase should establish the
machinery for guard injection and line preservation without yet implementing
the full return waterfall.

#### Phase 3. Core Early-Return Control Flow

Covers steps 4, 5, and 6.

Implement the guard stack, middle-tag handling, and callable-boundary behavior
together. These pieces are tightly coupled: middle tags must bind to the user's
original block, and returns inside nested callable bodies must not leak into the
outer scope.

At the end of this phase, ordinary early return should work at script root,
inside nested control flow, inside functions/methods, and inside caller/call
assignment bodies.

#### Phase 4. Loop Return Semantics

Covers steps 7, 8, and 9, landed as sub-phases.

- Phase 4a: add `while` condition rewriting for return-owning scopes that may
  return.
- Phase 4b: add `for ... with return` as the explicit sequential short-circuit
  loop form.
- Phase 4c: add the parallel-`for`-specific return protections: guard the
  return statement itself, preserve first-visible-return semantics, and lock
  down the documented non-cancellation behavior.

The generic loop-body guard cascade after `endfor` belongs to Phase 3's guard
stack. Step 9 only owns the additional semantics unique to ordinary parallel
`for`.

#### Phase 5. Semantic Hardening

Covers step 10.

Lock down return values that are easy to confuse with return control state:
bare `return`, `none`, `undefined`, promises, rejected promises, poison values,
and poison returns inside guarded or parallel-loop paths.

Also verify callable bodies that complete without executing an explicit
`return`: script functions/macros and caller bodies must resolve to the public
no-value result (`undefined`/`none`, according to the final API decision), not
leak the internal `runtime.RETURN_UNSET` sentinel to callers.

#### Phase 6. User Documentation

Covers step 11.

Update user-facing script documentation after implementation behavior is stable.
Keep ordinary return documentation brief and spend detail only on the parallel
`for` quirk and the `for ... with return` recommendation.

### 0. Return Sentinel And Channel Visibility

Resolve the blocking return-channel invariants before implementing semicolon
logical lines or guard rewriting.

Required behavior:

- `__RETURN_UNSET__` is a compiler-recognized internal symbol that compiles to
  `runtime.RETURN_UNSET`.
- `__RETURN_UNSET__` cannot be declared or shadowed by user code.
- The transpiler does not initialize `__return__`; the compiler continues to
  declare the return channel for each return-owning scope.
- A guard emitted in a child control-flow/loop buffer observes the same
  function-local `__return__` channel as a `return` statement writes.
- Injected return guards use a return-state read that does not throw/report
  poison stored as the returned value.
- Parallel `for` return guarding is only considered correct after the ordered
  read/write invariant is verified.

Integration-first tests for this step:

- a script can evaluate the injected-equivalent guard before and after return
  without a missing-name error
- user code cannot declare `__RETURN_UNSET__`
- user code cannot declare `__return__`
- guard reads inside `if`, `while`, `each`, and `for` observe the nearest
  function-local return channel
- guard reads after `return errorValue` skip later statements without surfacing
  the returned error early
- a nested function's return channel is independent from the outer return
  channel

### 1. Lexer Logical Lines

Add lexer-level support for semicolon-separated logical statements inside
`CODE` tokens.

Required behavior:

- A `;` inside a `CODE` token is treated as a logical newline.
- The physical line is preserved in the generated template output.
- Semicolons inside strings, comments, template literals, and regex tokens are
  not split.
- Multiple logical statements on the same physical line are processed in order
  by the normal script line pipeline.
- Logical lines created by `;` carry `isSemicolonLine: true`.
- All logical lines from the same physical line retain the same source line
  index for parser/compiler error reporting.
- Logical lines should carry a sensible `colno` based on the start of that
  logical statement within the physical line.
- Raw/verbatim content is not split.

Example:

```cascada
return value; if __return__ == __RETURN_UNSET__
```

must be processed as:

```cascada
return value
if __return__ == __RETURN_UNSET__
```

while still producing one physical generated-template line.

This step should be implemented before return guards so the injected
`; if ...` / `endif; ...` forms use the same path as user-authored semicolons.

Integration-first tests for this step:

- a script with `var a = 1; var b = 2; return a + b` renders `3`
- a script with `if true; return 1; endif` renders `1`
- syntax errors on semicolon logical lines report the original physical line

Focused contract tests only if needed:

- semicolon between two simple statements creates two logical lines
- multiple semicolons create ordered logical lines on the same physical line
- trailing semicolon does not create a meaningful extra statement
- empty logical statements from `a;;b` are ignored or rejected consistently
- semicolon inside single-quoted string is not split
- semicolon inside double-quoted string is not split
- semicolon inside template literal is not split
- semicolon inside regex token is not split
- semicolon inside `//` comment is not split
- semicolon inside `/* ... */` comment is not split
- semicolon before a trailing `//` comment splits code before the comment and
  preserves the comment
- semicolon inside raw/verbatim content is not split
- all logical lines from one physical line keep the same line number
- semicolon logical lines report useful column numbers for errors
- logical lines after the first are marked `isSemicolonLine: true`

### 2. Transpiler Logical-Line Pipeline

Teach `scriptToTemplate()` to consume logical lines rather than assuming exactly
one processed line per physical source line.

Required behavior:

- Process all logical lines from one physical line in order.
- Keep the original physical line index for every logical line.
- Preserve `logicalIndex` / `isSemicolonLine` metadata through processing.
- Do not insert `\n` between semicolon logical lines in generated template
  output.
- Allow injected return guards to be represented as logical semicolon lines,
  not as special string concatenation.
- Preserve existing continuation/comment behavior for non-semicolon physical
  lines.
- Preserve raw/verbatim bodies without parsing their contents as logical script
  statements.

Sub-steps:

1. Refactor the pipeline so parsing, continuation handling, validation, channel
   scope updates, and output generation operate on logical lines.
2. Add same-physical-line output joining for `isSemicolonLine` entries.
3. Add an internal helper for later return passes to inject logical semicolon
   lines without manually concatenating template strings.

This step is the bridge between lexer support and return rewriting. It should
only establish the logical-line pipeline. The actual return-guard injection is
implemented later, but return guards must use this mechanism rather than
building custom output strings.

Integration-first tests for this step:

- `var a = 1; var b = 2` transpiles to two tags on one physical output line
- semicolon logical lines do not add `\n` to generated template output
- a same-line block sequence such as `if a; return 1; endif` renders correctly
- channel declarations and commands on semicolon logical lines render correctly
- raw/verbatim blocks containing semicolons and text that looks like `return`
  render unchanged

Focused contract tests only if needed:

- comments attached to a semicolon line stay on that physical line
- generated logical statements are not emitted inside a trailing `//` comment
- continuation behavior for non-semicolon multi-line expressions is unchanged
- block validation still sees semicolon logical lines in the correct order
- channel scope updates run for each semicolon logical line

### 3. Return Guard Expression Integration

Implement and verify that the injected guard expression:

```cascada
__return__ == __RETURN_UNSET__
```

is valid in every script/function scope where the transpiler may emit it.

Required behavior:

- `__return__` is the current function/script return channel.
- `__RETURN_UNSET__` compiles to `runtime.RETURN_UNSET`; it is not a normal variable.
- Reads of `__return__ == __RETURN_UNSET__` are ordered reads and participate in normal
  Cascada temporal correctness.
- Child control-flow buffers and loop bodies observe the same function-local
  return channel rather than shadowing it.
- Returning `none`, `undefined`, or an error value must still count as "a return
  happened"; guard checks must not confuse the returned value with the
  no-return sentinel.
- Guard checks must use return-state reads, not normal value snapshots that
  inspect returned poison/errors.

This step integrates the Step 0 symbol/channel decisions into the expression
compiler path used by injected guards, before the full guard waterfall is added.

Integration-first tests for this step:

- top-level guard after return skips later side effects
- guard expression works inside `if`, `while`, `each`, and `for` by observing
  rendered side effects
- guard expression inside a function uses the function-local return channel
- nested control-flow buffers observe the same function-local return channel
- user declarations cannot shadow `__return__` or `__RETURN_UNSET__`
- returned poison/error values do not make later injected guards throw before
  final return resolution

### 3a. Return Analysis Pre-Pass

Before rewriting guards and loop conditions, collect return metadata over
logical script lines.

The analysis must track:

- whether each return-owning scope contains a runtime `return`
- whether each block contains a runtime `return` in its own body
- whether each loop body contains a runtime `return`
- whether the current rewrite position is inside a parallel `for`
- whether a loop is the explicit sequential `for ... with return` form

This metadata is used to:

- rewrite only `while` loops whose enclosing return-owning scope may return
- guard return statements inside parallel `for` bodies so later visible returns
  cannot overwrite the first visible return
- avoid treating a return inside a nested callable declaration as a return from
  the enclosing loop or scope
- keep `for ... with return` handling explicit and separate from ordinary
  parallel `for`

The pre-pass must ignore:

- returns inside nested return-owning callables when analyzing the outer scope
- returns inside raw/verbatim content
- words that look like `return` inside strings, comments, template literals, or
  regex tokens

Integration-first tests for this step:

- `while` in a callable/root body with a real return is rewritten
- `while` in a callable/root body with only a nested function return is not
  rewritten
- return inside a nested function declared inside `for` does not mark the loop
  body as returning
- return inside raw/verbatim content inside a loop does not mark the loop body as
  returning
- return inside an ordinary parallel `for` is recognized as loop-body return
- `for ... with return` is identified as the explicit sequential
  return-aware loop form

### 4. Return Guard Stack

Add guard injection after `return` and cascade it outward through enclosing
blocks until a function boundary is reached.

This requires tag/endtag depth tracking. The `endif` generated for a return must
attach to the end tag of the block that was current when the guard was opened,
not to the next arbitrary end tag in the file.

Each block-stack frame should track at least:

- `tagName`
- `endTagName`, or a local cache of the value derived from `blockPairs`
- `isFunctionBoundary`
- `loopKind`, such as `for`, `each`, or `null`
- `isParallelLoop`
- `returnGuardOpen`
- `containsReturn`

When a return is emitted:

```cascada
return value; if __return__ == __RETURN_UNSET__
```

the current frame is marked with:

```text
returnGuardOpen = true
containsReturn = true
```

When processing an end tag:

1. Look at the frame that this end tag closes.
2. If that frame has `returnGuardOpen`, emit `endif; ` before the end tag.
3. Emit the original end tag.
4. Pop the frame.
5. If the popped frame had `containsReturn`, and the new parent frame is not a
   function boundary, emit `; if __return__ == __RETURN_UNSET__` after the end tag.
6. Mark the parent frame as `returnGuardOpen = true` and
   `containsReturn = true`.

This creates the waterfall:

```cascada
if outer
  if inner
    return value; if __return__ == __RETURN_UNSET__
    endif
  endif; if __return__ == __RETURN_UNSET__
  afterInner()
  endif
endif; if __return__ == __RETURN_UNSET__
afterOuter()
endif
```

Middle tags need special handling. If a branch has an open return guard, close
that guard before emitting the middle tag. The new branch continues in the
original control-flow block, not inside the injected return guard.

Root scope has no closing end tag. Any open root-level return guard must be
closed at the end of the logical script/template output without changing
physical source line mapping.

EOF closure rule:

- append required root-level `endif` logical statements to the last physical
  source line as semicolon logical lines
- if the source is empty, attach the synthetic closure to line 1
- do not create unrelated generated-template lines only to close return guards

Integration-first tests for this step:

- top-level return guards all following top-level statements
- multiple top-level returns keep the first visible return value
- return inside `if` cascades after `endif`
- return followed by a nested block closes the first guard at the returning
  block's end tag, not at the nested block's end tag
- return inside nested `if` cascades through each enclosing block
- return inside `while` cascades after `endwhile`
- return inside `for` cascades after `endfor`
- return inside `each` cascades after `endeach`
- statements after executed top-level return do not run
- nested return skips later outer sibling statements

Focused contract tests only if needed:

- root-level injected guard is closed at EOF
- generated template has balanced injected `if`/`endif`
- physical line count is preserved for simple and nested returns
- EOF guard closure on a final comment-only line does not emit tags inside the
  comment

### 5. Middle Tag Handling

Handle middle tags as their own checkpoint rather than folding them into the
basic return stack.

Middle tags include:

- `else`
- `elif`
- `case`
- `default`
- `recover`

Required behavior:

- If the current branch has an open return guard, emit `endif; ` before the
  middle tag.
- Reset branch-local `returnGuardOpen` for the new branch.
- Keep `containsReturn` on the enclosing block so the return still cascades
  after the final end tag.
- Ensure the middle tag binds to the user's original control-flow block, not to
  an injected guard.
- Add tests for `if/else`, `elif`, `switch case/default`, loop `else`, and
  `guard/recover` where applicable.

Integration-first tests for this step:

- returns in both `if` and `else` branches produce balanced guards
- return in one branch still cascades after the final end tag
- no extra guard leaks from one branch into the next branch
- `else` branch still runs when `if` condition is false and true branch contains
  a return
- after a branch return, code after the enclosing block is skipped
- `elif`, `switch case/default`, loop `else`, and `guard/recover` render
  correctly with returns where applicable
- return inside a `guard` branch closes before `recover`, and the `recover`
  branch remains attached to the original `guard`
- return inside a `recover` branch cascades after `endguard`

Focused contract tests only if needed:

- return before each middle tag closes the injected guard before the middle tag

### 6. Callable Boundaries

Stop guard propagation at callable boundaries.

Callable boundaries include:

- `function ... endfunction`
- any lowered or alias form used for script functions
- `method ... endmethod`
- `call ... endcall`
- assigned call blocks written as `var x = call ... endcall` or
  `x = call ... endcall`, which the transpiler lowers to the internal
  `call_assign ... endcall_assign` tag pair

Required behavior:

- A return inside a callable guards only the rest of that callable body.
- A return inside a nested callable declaration must not guard statements after
  the declaration in the outer scope.
- A return inside a caller/callback body must remain local to that caller body.
- The implementation should rely on block metadata rather than surface spelling
  only, so aliases and lowered forms remain correct.
- If user-facing `function/endfunction` syntax is lowered to another tag form
  internally, the return pass must run after that lowering or understand both
  spellings.
- For assigned call blocks, a return inside the caller body supplies the caller
  body's returned value for the assignment/call result. It must not behave as a
  return from the outer function/script.
- Raw/verbatim blocks are not callable boundaries; their contents are opaque and
  ignored by return analysis.

Integration-first tests for this step:

- return inside `function` does not guard outer statements after `endfunction`
- return inside `method` does not guard outer statements after `endmethod`
- return inside `call` body is local to that caller body
- return inside an assigned call body is local to that assigned caller body
- return inside an assigned call body only determines the caller result; it does
  not skip outer statements after the assigned call block
- return inside an assigned call body is captured as the assigned call result
  according to existing caller semantics
- function declared inside `if` with return does not make the enclosing `if`
  cascade unless the function declaration itself is returned from
- function declared inside `for` with return does not count as a loop-body return
- calling a function with early return skips later function statements
- defining a function with early return does not skip later outer statements

### 7. While Support

Rewrite `while` conditions so no new iteration starts after return is set.

Source:

```cascada
while condition
```

Generated logical script:

```cascada
while __return__ == __RETURN_UNSET__ and (condition)
```

Requirements:

- Preserve the user's condition with parentheses.
- Apply the rewrite only when the enclosing callable may return.
- Apply this rewrite before normal tag output generation.
- Still apply the normal return guard waterfall to returns inside the while
  body.
- Preserve line numbers; this rewrite changes content on the same physical
  line only.
- Support continued/multi-line while conditions. The injected guard belongs to
  the logical condition as a whole and must not split a continued expression.
- Intentionally skip later condition work after return. If the condition contains
  ordered reads or observable work, that work is no longer evaluated once return
  is visible.
- Use a pre-pass to rewrite only `while` loops in callable/root bodies that may
  return, excluding nested callable declarations and raw/verbatim content. If
  implementation chooses unconditional rewriting instead, update this document
  and tests accordingly before coding.

Integration-first tests for this step:

- return inside while prevents another iteration from starting
- statements after return inside the while body are skipped
- code after `endwhile` is skipped after return
- while with no return behaves as before
- while in a callable with no return is not rewritten
- while before a later return in the same callable is rewritten by the pre-pass
- while condition errors/poison behavior is unchanged except for the added return
  guard
- complex and multi-line while conditions render with the same truth behavior as
  before, except for return stopping further iterations

Focused contract tests only if needed:

- generated while tag contains the guarded condition with preserved parentheses

### 8. For With Return

Add the sequential return-aware loop syntax:

```cascada
for item in items with return
```

Required behavior:

- Parse/lower this syntax using the current script transpiler style.
- Preserve line numbers.
- Lower to sequential loop behavior, plus an
  explicit return-check mechanism before starting each next iteration.
- Ensure returns inside the body use the normal guard stack.
- Ensure later iterations are not run once return is visible by checking
  `__return__ == __RETURN_UNSET__` before starting each next iteration.
- Use this as the documented way to get normal sequential short-circuit return
  behavior in loops.
- Keep this script syntax distinct from the existing template/parser `for ...
  in ... of <concurrencyLimit>` grammar.

Lowering options:

- add an internal loop flag to the generated sequential loop representation,
  such as a compiler-only `returnGuard` option, and have loop
  compilation/runtime check the function-local return channel before each
  iteration
- or lower to an equivalent sequential construct that performs the same ordered
  return-channel check before advancing

Do not rely only on guards inside the loop body. Body guards skip the rest of an
already-started iteration; they do not, by themselves, prevent the loop from
starting the next iteration.

Integration-first tests for this step:

- `for item in items with return` parses/transpiles successfully
- loop variable binding works for the new syntax
- return in the first iteration prevents later iterations
- return in a later iteration returns that item and skips subsequent iterations
- side effects before the return do not run for later items after return
- statements after return in the same iteration are skipped
- code after `endfor` is skipped after return
- ordinary `for` without `with return` retains existing parallel behavior
- invalid `for ... with return` syntax produces a useful error
- a return in `for item in items with return` prevents the next iteration from
  starting, not merely the rest of the current body

Focused contract tests only if needed:

- generated template preserves physical line count

### 9. Parallel For Return Guarding

Add the parallel-`for`-specific return handling without promising cancellation
of already-started parallel work.

The generic guard waterfall from Step 4 already owns the source-order body
shape and the cascade after `endfor`:

```cascada
for item in items
  return item; if __return__ == __RETURN_UNSET__
  after()
  endif
endfor; if __return__ == __RETURN_UNSET__
outside()
endif
```

Step 9 does not re-own those generic guard-stack responsibilities. Its scope is
only the additional behavior needed for ordinary parallel `for`.

Parallel `for` requirements:

- For parallel `for`, do not promise cancellation of already-started work.
- For parallel `for`, guard the `return` statement itself with
  `if __return__ == __RETURN_UNSET__` so later returns do not overwrite the first
  visible return value.
- For parallel `for`, generated post-return guards also protect statements after
  the return point in later source-ordered iterations. Those statements may wait
  for earlier ordered return-state checks, so this intentionally introduces a
  partial concurrency reduction after the return point.
- Define "first visible return" as the first return visible through Cascada's
  ordered channel semantics, not necessarily the first iteration to finish in
  wall-clock time.
- If ordered observation of the shared function-local return channel cannot be
  guaranteed, add a stronger runtime primitive before claiming first-visible
  return semantics.
- Preserve line numbers for all injected loop guards.

Integration-first tests for this step:

- multiple matching iterations do not overwrite the first visible return
- first visible return follows ordered channel semantics, not delay/completion
  order
- side effects before the return point may run for multiple iterations
- side effects after the return point do not run in later ordered iterations
  once the return is visible
- post-return body statements may be delayed by ordered return-state checks,
  demonstrating the documented partial concurrency reduction
- `for` without return retains existing parallel behavior
- nested function return inside `for` does not trigger loop return guarding

Focused contract tests only if needed:

- return statement inside `for` is wrapped in `if __return__ == __RETURN_UNSET__`
- physical line count is preserved for generated for-loop guards

### 10. Poison And Undefined Return Semantics

Add dedicated tests and implementation checks for return values that are easy to
confuse with control state.

Required cases:

- `return none`
- `return undefined` where applicable
- `return` with no expression
- returning a promise
- returning a poison/error value
- returning from nested guarded blocks with error values
- return expression rejects after later source text has been parsed but before
  guard decisions complete

The no-return sentinel must remain distinct from all valid return values. Guard
checks determine whether a return happened; final return resolution determines
what value or error is returned.

Integration-first tests for this step:

- `return` with no expression returns `undefined`/`none` according to current
  API semantics and still skips later statements
- `return none` is distinct from `__RETURN_UNSET__`
- `return undefined` is distinct from `__RETURN_UNSET__` where applicable
- returning a promise resolves to the promised value
- returning a rejected promise reports the expected error
- returning a poison/error value marks return as happened and final render
  reports the error
- guards after an error return do not execute later statements
- parallel `for` with poison return still prevents later ordered returns from
  overwriting it

### 11. User Documentation Update

Update `docs/cascada/script.md` after implementation.

Required behavior:

- Keep ordinary return documentation brief.
- Do not over-explain cases where return behaves like other programming
  languages.
- Explain only the parallel `for` quirk in detail.
- Document that `for` does not cancel already-started parallel iterations.
- Document that side effects before the return point may still happen for many
  items.
- Document that work after the return point is guarded and may run with less
  concurrency because it must observe ordered return state.
- Document that the first visible return value wins.
- Recommend `for item in items with return` when the user needs normal
  sequential short-circuit return behavior.

Integration checks for this step:

- documentation examples compile and run
- `for` example demonstrates that pre-return work may run for many items
- `for item in items with return` example demonstrates normal sequential
  short-circuit behavior
- docs do not over-explain ordinary return behavior
- docs use the exact supported syntax

## Documentation Requirements

The user-facing script documentation should not over-explain `return` where it
behaves like return in other programming languages. Ordinary top-level,
function, `if`, `while`, and sequential `for ... with return` cases should be
documented simply and briefly.

The only behavior that needs special explanation in the return section is
parallel `for`.

Required points for the `for` note:

- In parallel `for`, `return` does not cancel already-started iterations.
- In parallel `for`, work before the return point can still happen in many
  iterations, including side effects.
- In parallel `for`, work after the return point is guarded. Later iterations do
  not run that work once the first return is visible, but those guards are
  ordered checks and can reduce concurrency after the return point.
- In parallel `for`, the first visible return value wins; later returns are
  skipped once `__return__` is no longer `__RETURN_UNSET__`.
- If a user needs side-effectful iteration to stop before later items are
  processed, or otherwise needs the normal sequential short-circuit behavior
  familiar from other programming languages, they should use
  `for item in items with return`.

Suggested wording:

> `return` is source-order control flow, not cancellation. In a parallel `for`,
> Cascada may already have started many iterations. Work before the return point
> in those iterations can still run. Cascada guards the return itself so the
> first visible return value is returned, and later return statements are
> skipped. Work after the return point is also guarded, so it may run with less
> concurrency than ordinary pre-return loop work.

Example for documentation:

```cascada
for item in items
  audit(item)       // may run for many items
  if item.ok
    return item     // first visible return wins
  endif
endfor
```

If the user needs side-effectful iteration to stop before later items are
processed, or needs normal sequential return behavior, the documentation should
recommend `for ... with return`:

```cascada
for item in items with return
  audit(item)
  if item.ok
    return item
  endif
endfor
```

## Implementation Notes

This design intentionally keeps return semantics in script syntax lowering:

- The script transpiler emits ordinary Cascada template tags.
- The compiler continues to compile `return` as a write to `__return__`.
- The compiler treats `__RETURN_UNSET__` as an internal symbol for
  `runtime.RETURN_UNSET`, not as a user variable.
- The compiler/runtime must make function-local return channels observable from
  child control-flow and loop buffers where injected guards run.
- Ordered `__return__ == __RETURN_UNSET__` reads are used for control-flow guards.
- Physical line numbers are preserved by allowing semicolon-separated logical
  statements inside `CODE` tokens.
