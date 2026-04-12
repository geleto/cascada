## Composition Review Status

This file described the pre-Step-A through Step-D implementation state and is
no longer a current bug list after the Step E cleanup.

The major items from that review have now landed:

- deferred exports resolve from explicit producer records rather than legacy
  visibility-link recovery
- extern self-cycles and indirect cycles are validated
- inheritance call sites build explicit payloads instead of recovering inputs
  through `compositionSourceBuffer`, `context.getBlockContract(...)`, or
  `parentBuffer.findChannel(...)`
- block entry consumes explicit payload fields instead of runtime-discovered
  inherited input names
- same-template local captures are forwarded explicitly in inheritance payloads
- legacy named block `with` inputs have been removed in favor of explicit block
  signatures

Historical note:

- if this file is kept around, it should be read as a snapshot of the
  pre-cleanup architecture, not as a list of current known issues
- current implementation/documentation follow-up should now live in
  `composition-update.md`, `composition.md`, or targeted review notes for the
  new inheritance/shared-state work
