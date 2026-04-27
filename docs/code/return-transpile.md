# Return Transpilation Design

This note describes the intended simplified script-transpiler design for
`return` handling. It supersedes the heavier multi-pass return transpilation
shape that grew during the initial implementation.

## Goal

`return` should behave like ordinary structured control flow from the script
author's point of view. The transpiler implementation may need guards and
return-channel checks, but those details should stay small, local, and aligned
with the existing line/tag processing model.

The current direction is:

- keep return lowering in the script transpiler;
- avoid moving the complexity into the compiler;
- avoid hiding the complexity in a separate large module;
- minimize the amount of return-specific logic in the first place.

All return cases should first be expressed as state on the single return stack
frame. Adding a separate return pass is a design failure unless there is a
specific invariant that cannot be represented by the stack walk.

The pass should be stateful, not analytical: it mutates processed lines directly
as it walks them. It should not build metadata for later return passes.

## Core Principle

The transpiler already processes script as logical lines with `blockType` and
`tagName`. Return handling should use one tag stack over those processed lines.

When a `return` line is encountered, mark frames down the current stack as
having returned, stopping at the nearest return-owning boundary:

- `root`
- `function`
- `method`
- `call_assign`

That marking is the main fact needed by the rest of the pass.

```js
function markReturn(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    frame.hasReturn = true;
    if (frame.usesReturnBodyGuard && !frame.returnBodyGuardOpen) {
      openReturnBodyGuard(frame);
    }
    if (frame.isReturnBoundary) {
      break;
    }
  }
}
```

`markReturn()` sets the summary return fact and performs the only retroactive
loop body-gate patch needed by `for`/`each` frames.

## Stack Frame

The return pass should use a small frame object. It should not build a second
analysis tree or attach broad return-analysis metadata to every line.

```js
{
  tagName,
  startLine,
  startIndex,
  hasReturn: false,
  returnGuardOpen: false,
  pendingReturnGuard: false,
  returnBodyGuardOpen: false,
  isReturnBoundary,
  usesReturnBodyGuard,
  usesReturnConditionGuard
}
```

Fields:

- `tagName`: source tag for the block (`if`, `for`, `while`, `function`, etc.).
- `startLine`: processed line object for the opening tag, used for late patching
  loop/while guards.
- `startIndex`: processed line index for the opening tag, used to find
  continuation ends without object-identity scans.
- `hasReturn`: this block, or a nested non-boundary child, contains a runtime
  return in any branch that is visible to this frame.
- `returnGuardOpen`: a return guard has been materialized and must be closed.
- `pendingReturnGuard`: a return has happened, but no later executable statement
  has needed a guard yet. This avoids emitting empty `if/endif` pairs.
- `returnBodyGuardOpen`: a loop body guard was opened after this frame's start
  tag and must be closed before a middle/end tag.
- `isReturnBoundary`: return propagation stops at this frame.
- `usesReturnBodyGuard`: this frame opens a body/iteration gate when a visible
  return is found inside it (`for`, `each`).
- `usesReturnConditionGuard`: this frame rewrites its condition when a visible
  return is found inside it (`while`).

The frame should be self-describing. Compute these facts when the frame is
created instead of scattering repeated tag checks through the pass.
Keep this simple: either store the booleans on the frame or use tiny predicates.
Do not introduce a separate configurable tag table.

`call_assign` is a return boundary because it represents a caller body. Bare
`call` blocks are not listed because the script transpiler rejects them before
return handling.

The return frame must stay boolean. Do not reintroduce guard depths/counts. If
the implementation appears to need `returnGuardDepth` or
`pendingReturnGuardDepth`, that is a sign the pass is double-propagating or
opening nested identical guards.

Do not store a delayed guard line unless an implementation proves it is needed.
The normal shape is only `pendingReturnGuard: true`; when the next executable
line arrives, patch that line immediately. This avoids stale-line state.

`returnGuardOpen` and `returnBodyGuardOpen` are intentionally separate. They use
the same guard condition, but protect different regions:

- `returnBodyGuardOpen` protects a whole loop iteration/body once some visible
  return may already have happened.
- `returnGuardOpen` protects later statements in the same frame after a return
  statement or return-containing child block.

A loop can need both:

```cascada
for item in items
  if item.ready
    return item
  endif
  record(item)
endfor
```

Conceptually, the loop body is guarded so later iterations can skip after a
return, and `record(item)` is also guarded because it is after a return-capable
child tag inside the same body.

## Branch State And Middle Tags

Middle tags are not child blocks. They start a new branch inside the same frame.

Examples:

- `else`
- `elif`
- `case`
- `default`
- `recover`

Because middle tags are branch boundaries, each frame needs both frame-level and
branch-local guard state:

- `hasReturn` means at least one branch/body of the frame has returned.
- `pendingReturnGuard` and `returnGuardOpen` describe the current branch's
  post-return guarded region.

On `return`:

- mark `hasReturn = true` down the stack until the nearest return boundary.
- set `pendingReturnGuard = true` on the current frame.

On a middle tag:

1. Close any materialized `returnGuardOpen` before the middle tag.
2. Close `returnBodyGuardOpen` before the middle tag when the current frame is a
   loop, because loop `else` is not part of the iteration body.
3. Drop any `pendingReturnGuard`; if only comments/blank lines followed the
   return in that branch, no empty guard should be emitted.
4. Keep `hasReturn` unchanged so the frame can still propagate after its end tag.

This same rule covers `if/else`, `switch/case/default`, `guard/recover`, and
`for/else`.

Future child start tags after a return are handled by the parent frame's pending
or open return guard. The child frame itself was not on the stack when the
earlier return happened, and that is fine:

```cascada
return 1
if expensive()
endif
```

The `if` start tag is executable because its condition can run, so the parent
guard must materialize before the `if` line, before the child frame is pushed.

## Single-Pass Shape

Return handling should be one stack walk over processed logical lines.

Tag-specific decisions should be fact-driven, not spread through the pass as
ad-hoc checks. A small helper or frame constructor is enough:

```js
{
  isReturnBoundary: tagName === 'root' ||
    tagName === 'function' ||
    tagName === 'method' ||
    tagName === 'call_assign',
  usesReturnBodyGuard: tagName === 'for' || tagName === 'each',
  usesReturnConditionGuard: tagName === 'while'
}
```

Middle tags do not need separate per-tag return behavior. The existing
`blockType === MIDDLE` classification is the universal branch-boundary signal.

Use one small executable-line predicate instead of repeating skip conditions:

```js
line &&
  !line.isContinuation &&
  !line.isEmpty &&
  !line.isCommentOnly &&
  line.lineType !== 'RAW_TEXT'
```

This helper should only express the skip rule. It should not become a generic
line classifier.

For each processed line:

1. Skip continuation lines, raw/verbatim body text, empty lines, and comment-only
   lines for structural decisions. Prefer the existing `RAW_TEXT` line type for
   raw/verbatim bodies; add explicit raw-depth tracking only if implementation
   shows opaque content can appear as ordinary processed lines.
2. Before any executable line or tag that must not run after return, materialize
   the current frame's `pendingReturnGuard`. This includes ordinary code lines
   and `START` tags whose conditions/expressions would otherwise run.
3. On a `START` tag, after any parent pending guard has materialized, push a new
   frame with `startLine` and `startIndex`.
4. On a `return` tag:
   - materialize any pending guard for the current frame before the return;
   - close any currently open guard after the return line's continuation end;
   - call `markReturn(stack)`;
   - while marking ancestors, if a frame `usesReturnBodyGuard` and
     `returnBodyGuardOpen` is false, append the body-guard open suffix to that
     frame's `startLine` and set `returnBodyGuardOpen = true`;
   - set the current frame's `pendingReturnGuard`.
5. On a `MIDDLE` tag (`else`, `elif`, `case`, `default`, `recover`):
   - close the current branch guard before the middle tag;
   - close the current loop body guard before loop `else`;
   - clear pending branch guards;
   - keep `hasReturn` on the frame so later `end*` propagation still happens.
6. On an `END` tag:
   - close the popped frame's open post-return guard before the end tag;
   - close any open loop body guard before the end tag;
   - close in that order: post-return guard first, then body guard, because the
     post-return guard is nested inside the body gate;
   - patch a `usesReturnConditionGuard` start condition if the popped frame has
     `hasReturn`;
   - propagate to the parent unless the popped frame is a return boundary:
     set `parent.hasReturn = true` and `parent.pendingReturnGuard = true`.
7. At EOF:
   - drop pending guards;
   - close only guards that were actually materialized.

## Return Guard Emission

The guard condition is the internal helper:

```cascada
__return_is_unset__()
```

It compiles to `ReturnIsUnsetCommand`, which reads the return channel without
poison inspection. This is required because a returned poison value must count
as "return has happened" without surfacing through later guard checks.

Generated guard tags:

```njk
{%- if __return_is_unset__() -%}
...
{%- endif -%}
```

Guards must preserve physical line count. Add guard open/close snippets as
`inlinePrefix` or `inlineSuffix` on existing processed lines. Do not introduce
new generated physical lines.

There should be one small set of guard helpers:

- append return guard open before a line;
- append return guard open after a line;
- append return guard close before a line;
- append return guard close after a line.

Name the close helpers by placement, for example:

- `closeReturnGuardBefore(line)`
- `closeReturnGuardAfter(line)`

The same helpers should be used for loop body guards and post-return guards.
The difference belongs in frame state, not in separate guard emitters.

Keep the helpers boring and local. Use the fewest helpers that keep call sites
clear. Two helpers with a placement argument, or local closures inside the pass,
are fine. Do not introduce a configurable guard-emitter abstraction.

## Loops

Loops should not require a separate pre-analysis pass.

Because each stack frame keeps `startLine`, the return pass can patch loop
opening tags as soon as the first visible return marks the loop frame.

Loop body gates and post-return guards should not be separate passes. They are
both produced by the same stack walk:

- when a loop frame closes with `hasReturn`, patch the loop start line to open
- when `markReturn(stack)` reaches a loop frame that uses a body guard, patch
  that loop's start line to open the body guard if it has not already been
  opened;
- close that body guard before the loop's middle/end tag;
- still use ordinary `pendingReturnGuard` / `returnGuardOpen` handling for
  statements after return-capable child tags inside the loop body.

### `for`

Parallel `for` bodies should be gated with the same return-unset check. This
preserves Cascada's concurrency invariance:

- iterations may start in parallel;
- once a source-visible return has written the return channel, later guarded
  work observes that and skips;
- no special `for ... with return` syntax is part of this design.

### `each`

Sequential `each` uses the same body guard at transpile time. The compiler/runtime
may also use the return channel as an ordered advancement check between
iterations, but the transpiler does not need separate loop metadata to request
that. The generated body references `__return__` through `__return_is_unset__()`,
so normal used-channel analysis can discover the dependency.

### `while`

`while` needs one extra local rewrite because a return inside the body must
prevent the next condition evaluation.

When a `while` frame closes with `hasReturn`, patch its start condition:

```cascada
while __return_is_unset__() and (originalCondition)
```

For multi-line conditions, place the opening wrapper on the `while` line and
the closing `)` on the continuation end line. This can still be done from the
same stack pass because the frame has `startLine`/`startIndex`, and the
transpiler already has continuation metadata.

## Raw And Verbatim

Raw/verbatim body text is opaque. The return pass should ignore body content
inside these blocks and only react to their structural start/end tags.

Do not add raw-depth tracking preemptively. The processed-line model already
represents opaque body content as `RAW_TEXT`; skipping that line type should be
enough unless a concrete test proves otherwise.

## What To Remove From The Current Shape

The simplified design should make these concepts unnecessary:

- `_analyzeReturnMetadata`
- `returnAnalysis` objects stamped onto lines
- `returnOwningScopes`
- `analysis.loops`
- `currentReturnBoundary`
- `insideParallelFor`
- `loopBodyContainsReturn`
- `returnGuardDepth`
- `pendingReturnGuardDepth`
- `containsReturn`
- separate while return pass
- separate parallel-for return pass
- multiple return-specific stacks
- `analyzeReturn()` as a public/test introspection API

`scriptToTemplate()` should prepare processed lines, run one return stack pass,
validate/render, and stay close to the existing transpiler style.

Tests that currently inspect `analyzeReturn()` should move to integration tests
or focused generated-template assertions for externally meaningful contracts.

Keep `_validateBlockStructure` separate. A generic reusable block walker sounds
tempting, but it would add indirection without removing meaningful return
complexity. The return pass can use the same simple stack discipline directly.

## Refactor Plan

1. Add the new single-pass helpers next to the existing return code:
   - `_createReturnFrame(tagName, startLine, startIndex)`
   - `_isReturnExecutableLine(line)`
   - small local guard open/close helpers inside `_applyReturnGuards`
2. Rewrite `_applyReturnGuards(processedLines)` around one frame stack:
   - push self-describing frames on `START`;
   - call `markReturn(stack)` on `return`;
   - reset branch-local guard state on `MIDDLE`;
   - close and propagate on `END`.
   During the transition, it is fine to build this as a temporary
   `_applyReturnGuardsSinglePass()` beside the old passes, switch
   `scriptToTemplate()` to it once focused tests pass, then delete the old pass
   functions and rename the new function back to `_applyReturnGuards()`.
3. Fold loop behavior into that pass:
   - `for`/`each` body gates open when `markReturn()` reaches the loop frame;
   - body gates close before loop `else` or loop end;
   - `while` conditions are patched when the `while` frame closes with
     `hasReturn`.
4. Change `scriptToTemplate()` to call only the new `_applyReturnGuards()`.
5. Delete the old return analysis and separate guard passes:
   - `_analyzeReturnMetadata`
   - `_applyWhileReturnGuards`
   - `_applyParallelForReturnGuards`
   - analysis frame helpers and nearest-boundary helpers
   - `analyzeReturn()`
6. Replace tests that inspect `analyzeReturn()` internals with integration tests
   or generated-template checks that lock down externally meaningful behavior.
7. Run the return-focused tests first, then the broader script transpiler and
   loop suites.

## Non-Goals

- Do not move return waterfall control into the compiler. The script transpiler
  has the source-line and physical-line preservation responsibilities.
- Do not reintroduce `for ... with return`.
- Do not optimize away every redundant nested guard at the cost of a much more
  complex state machine. The priority is simple, correct, physical-line-preserving
  output.
- Do not add abstractions merely to make the return pass look more generic. A
  direct stack walk is preferred over callback walkers, configurable emitters,
  or compatibility metadata.
