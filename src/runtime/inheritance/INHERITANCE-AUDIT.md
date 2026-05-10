# Inheritance Audit

This file tracks inheritance issues that are not owned by
`LIFECYCLE-REFACTOR.md`.

Lifecycle-related findings, including parent-root execution as metadata
loading, `extendsState` plumbing, startup promises, overloaded root signatures,
component root-render modes, and finished-buffer lifetime workarounds, belong in
`LIFECYCLE-REFACTOR.md` instead.

## Documentation Drift Outside The Lifecycle Plan

Several design documents now describe different historical points of the
inheritance work:

- `src/runtime/inheritance/TECHNICAL-DESIGN.md` is the staged implementation
  record.
- `src/runtime/inheritance/LIFECYCLE-REFACTOR.md` is the target lifecycle
  correction.
- `docs/code/extends-architecture.md` is high-level but still contains older
  wording around shared defaults and constructor/root behavior.
- `docs/code/extends-metadata-architecture.md` is older metadata design context
  and still says every file must explicitly declare shared vars/channels.
- `docs/code/block-extends.md` documents the `this.__text__` text-channel
  exception and is closer to the current template shared-var behavior.

Action:

- Mark older documents as historical where they no longer define current or
  target behavior.
- Keep one authoritative current implementation document and one explicit target
  lifecycle document.
- After the lifecycle refactor lands, fold the target lifecycle into
  `TECHNICAL-DESIGN.md` or clearly supersede the old lifecycle section.

Risk if left unresolved:

- Future reviews can appear correct while validating against the wrong
  document. This already happened once for the root lifecycle.

## Template Shared Vars: Current Contract Needs Tests That Prevent Regression

Current intended behavior:

- templates infer ordinary static `this.<name>` roots as shared `var`
  declarations
- explicit template `{% shared ... %}` declarations are rejected
- `this.__text__` is the only typed template shared-channel exception
- inferred template shared vars are declaration-only; `{% set this.name = ... %}`
  is an ordinary runtime assignment, not a child-first default claim

This is a real behavior change from the earlier explicit-template-shared model.
The old `{% shared var theme = "dark" %}` path used
`claimInheritanceSharedDefault(...)`, so the first child-to-parent default claim
won. The current template surface has no equivalent default-claim syntax:
`{% set this.theme = "dark" %}` is just a source-ordered write. A parent setup
write that runs after the extends boundary can overwrite the child write.

The docs now say this, and tests cover basic explicit-declaration rejection.

Actions:

- Keep tests for `shared var`, `shared text`, and nested explicit shared
  declarations in templates.
- Keep generated-source tests for `this.__text__` inference and runtime tests
  for `this.__text__.snapshot()`.
- Add or preserve a focused test documenting parent/child assignment ordering
  for inferred template shared vars. This behavior is not the old explicit
  `shared var x = default` claim model.
- Document explicitly that `{% set this.name = ... %}` follows channel write
  ordering, not `claimInheritanceSharedDefault(...)` priority.

Risk if left unresolved:

- A future cleanup may reintroduce explicit template shared declarations or
  accidentally treat `{% set this.x = ... %}` as a default initializer.

## Public Runtime Surface Still Exposes Compiler ABI Helpers

`src/runtime/inheritance/index.js` intentionally exports explicit names, which
is much better than a blanket export. Still, the exported surface contains
helpers that are compiler/runtime ABI rather than user-facing API:

- `declareInheritanceSharedChannel`
- `initializeInheritanceSharedChannelDefault`
- `claimInheritanceSharedDefault`
- `linkCurrentBufferToSharedChannels`
- `linkCurrentBufferToParentChannels`
- `getCallableLinkedChannels`
- `getCallableMutatedChannels`
- `setInheritanceStartupPromise`

Some of these are necessary while compiled output calls `runtime.<helper>`
directly. The issue is not immediate correctness; it is that internal helper
names can look stable because they are exported from the package runtime module.

Action:

- After the lifecycle refactor, review which helpers are still emitted by the
  compiler.
- Keep compiler ABI helpers exported from the runtime bundle, but document them
  as compiler-private or group them under a narrower internal namespace if the
  project adopts one.

Risk if left unresolved:

- Internal lifecycle helpers become accidental public API and make future
  simplification harder.

## Shared Runtime Still Uses Channel Private Fields

`src/runtime/inheritance/shared.js` still uses channel internals:

- `_channelType` in `declareInheritanceSharedChannel(...)`
- `_setSequenceTarget` in `initializeInheritanceSharedChannelDefault(...)`

`linkCurrentBufferToSharedChannels(...)` now uses
`currentBuffer.hasLinkedChannelFromBuffer(...)` instead of reading
`channel._buffer` directly, which fixes the most fragile instance of this
pattern. The remaining private-field reads are less urgent but still make the
shared runtime depend on channel implementation details.

Action:

- Add small public channel/buffer APIs for:
  - getting a channel's declared type
  - initializing channel sequence targets where supported
- Replace direct `_channelType` / `_setSequenceTarget` usage once those APIs
  exist.

Risk if left unresolved:

- A channel refactor can break shared-channel declarations with misleading
  runtime errors.

## Component Tests Still Contain Synthetic Root-Render Fixtures

Several component unit tests construct fake component targets with
`rootRenderFunc(...)` directly. That is useful for current component runtime
unit coverage, but it will become stale when the lifecycle refactor removes the
overloaded root function shape.

Action:

- When lifecycle entry points change, update component unit tests to fake the
  new compiled shape rather than preserving `rootRenderFunc(...)`.
- Keep at least one test using a real compiled script/template component for
  end-to-end confidence.

Risk if left unresolved:

- Tests will continue to pass against an adapter that exists only for test
  compatibility.

## Browser Precompiled Fixture Bakes In Old Inheritance Shape

`tests/browser/precompiled-templates.js` contains generated inheritance code
with old root plumbing such as `extendsState.parentSelection` and
`renderInheritanceParentRoot(...)`. The lifecycle plan also calls this out
because the generated shape is lifecycle-owned, but the fixture itself belongs
to the browser/precompiled test infrastructure and can easily be missed during
runtime refactoring.

Action:

- Regenerate the fixture after the lifecycle refactor lands, or remove the
  handwritten stale inheritance snippet if it is no longer representative.
- Add a quick check that precompiled browser fixtures do not contain removed
  lifecycle helpers.

Risk if left unresolved:

- Browser tests may keep validating stale generated code after Node-side tests
  have moved to the new lifecycle.

## Skipped Legacy Test Groups Need Triage

`tests/pasync/extends-foundation.js` contains skipped legacy groups for metadata
readiness, helper lifecycle, and dynamic resolution lifecycle. Some skipped
tests are intentionally obsolete; others describe invariants that still matter
under different names.

Action:

- For each skipped inheritance group, mark it as one of:
  - deleted: old implementation detail only
  - rewritten: behavior still required but target mechanism changed
  - pending lifecycle: covered by `LIFECYCLE-REFACTOR.md`
- Avoid leaving skipped generated-source assertions that require obsolete
  helpers such as `extendsState.parentSelection`.

Risk if left unresolved:

- Important behavioral expectations remain hidden in skipped tests, and obsolete
  internal expectations keep looking like future work.

## Diagnostics Still Have Uneven Origin Quality

Finalization errors now carry useful origins for many callable issues, but
shared-schema and cross-file collision errors are still uneven:

- `registerSharedSchema(...)` reports conflicts with only the file context in
  some cases.
- shared-schema entries are type-only, so they do not always retain declaration
  source origins.
- metadata loading now has real file/extends origins, but better shared
  declaration origins are a broader diagnostics improvement.

Action:

- After metadata loading has real source origins, consider storing declaration
  origins in finalization-only shared-schema input metadata.
- Keep execution shared schema type-only; origin data should not need to live in
  the hot runtime shape.

Risk if left unresolved:

- Cross-file shared conflicts can point to the file rather than the exact
  declaration, slowing debugging.

## Remaining Defensive Normalization May Hide Compiler Invariants

Some runtime finalization helpers still accept malformed compiler metadata:

- `normalizeSignature(...)` treats a missing signature as zero args.
- `normalizeInvokedMethodRefs(...)` fabricates `{ name, origin: null }` for
  non-object refs.
- `normalizeStringArray(...)` silently filters non-string channel names.

This was useful during staged development. Once the compiler shape stabilizes,
these fallbacks may hide real compiler bugs.

Action:

- After the lifecycle refactor and compiler-output split, decide which metadata
  fields are hard invariants.
- Replace silent normalization with fatal errors for invariant violations.
- Keep copying/deduplication where it prevents mutation or produces stable
  method footprint arrays.

Risk if left unresolved:

- Broken compiler output can degrade into confusing missing-channel or
  missing-callable behavior later in execution.

## Error Message Style Is Not Fully Consistent

Runtime inheritance errors now mostly use double-quoted names and capitalized
messages, while some compiler validation errors still use single quotes or
trailing punctuation. Examples include local shared/method collision validation
and generic declaration-conflict messages from analysis.

Action:

- Do a narrow diagnostics polish pass after larger architecture changes settle.
- Prefer not to churn tests solely for punctuation while lifecycle work is in
  progress.

Risk if left unresolved:

- Low correctness risk, but inconsistent diagnostics make tests and docs harder
  to scan.
