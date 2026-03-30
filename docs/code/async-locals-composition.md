# Async JS Locals and Composition Boundaries

## Purpose

This document tracks a separate design question from async frame removal:

- when async mode uses plain JS locals instead of channels, how do those values
  interact with composition boundaries such as `include`, `extends`, blocks,
  `super()`, imports, and caller/macro boundaries?

This is related to frame removal, but it is not the same migration. It should
be reasoned about separately.

---

## Core Constraint

Plain JS locals do **not** flow through command-buffer linking.

That means:

- channel state participates naturally in buffer/channel ancestry
- JS locals do not

So if a value is stored only as a JS local, it will not automatically be visible
across:

- `include`
- `extends`
- blocks / `super()`
- import-like composition
- other deferred composition boundaries

---

## Include

Preferred direction:

- `include "template" with var1, var2, ...`

Meaning:

- included templates get explicit read-only access only to the listed values
- there is no implicit ambient access to parent JS locals

This is a strong fit for any future increase in JS-local async values.

---

## Extends / Blocks / Super

Preferred direction:

- `extends "base" with user, theme`

Meaning:

- inheritance/block composition gets explicit read-only values
- overridden blocks and `super()` may read them
- they are not shared mutable parent locals

Recommended semantics:

- read-only access: yes
- implicit parent-local writes: no
- shared mutable state: use channels/outputs instead

This avoids recreating a hidden ambient-scope model while still allowing
selected parent values to cross inheritance boundaries.

---

## Import / From Import

These need separate evaluation.

The problematic case is:

- `with context`

because it implies broad lexical visibility. If async locals are no longer
frame-backed, then imports should likely move toward one of:

- no implicit local visibility
- explicit projected values, similar to `with ...`

---

## Loop Variables and Loop Metadata

Current important fact:

- the modern async loop path already uses channels for loop variables and loop metadata

So loop state is **not currently a JS-local design problem**.

This document is only relevant if, in the future, some async locals are moved to
plain JS variables and we need those values to cross composition boundaries.

---

## Design Rule

If composition boundaries remain implicitly able to read ambient parent locals,
then JS locals are much harder to support.

So the cleanest direction is:

- make cross-boundary local visibility explicit
- keep it read-only
- use channels for shared mutable state

---

## Relationship to Frame Removal

Frame removal does **not** require solving all JS-local composition questions up
front if the relevant async state remains channel-backed.

This is why this topic is separated from `frame-remove.md`:

- async frame removal is primarily about runtime lexical storage and lookup
- JS-local composition is about a future design direction for values that are
  intentionally *not* channels
