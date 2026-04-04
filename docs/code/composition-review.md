## Current Implementation Review

The current implementation is much closer to the target model for async include/import than it is for async inheritance/block inputs.

Related document-hygiene note:

-   some sections of [composition.md](https://markdownlivepreview.com/composition.md) now read as historical migration notes rather than current TODOs, because parts of the include/import cleanup they describe have already landed
    

The main remaining gaps are:

-   same-template async block invocation still recovers local values through findChannel(name)?.finalSnapshot() rather than snapshotting invocation-time inputs explicitly
    
-   block input initialization is still a hybrid path that merges compile-time local-name discovery with runtime contract lookup, instead of using one explicit invocation payload
    
-   overriding blocks still recover inherited input names from context.getBlockContract(...).inputNames at runtime instead of having those names modeled as ordinary local declarations at analysis/compile time
    
-   inherited block inputs therefore do not yet behave like normal locals in all nested-scope cases
    
-   deferred exports still retain compatibility linkage through linkDeferredExportsToBuffer(...) and the currentBuffer.findChannel(name) fallback in resolveExports(...)
    
-   compositionSourceBuffer and related helpers are still carrying part of the inheritance/value-transport path instead of composition using only explicit payloads
    

More specifically, the current block-entry path still combines:

-   \_collectRootCompositionLocalChannelNames(...)
    
-   \_getBlockInputNames(...)
    
-   context.getBlockContract(...).inputNames
    
-   compositionSourceBuffer?.findChannel(name)?.finalSnapshot()
    
-   parentBuffer?.findChannel(name)?.finalSnapshot()
    

That hybrid merge is the main architectural gap left in inheritance. If same-template or child-template top-level locals remain part of the intended model, they should be captured explicitly at block invocation time into the same payload as the declared block inputs, not recovered later from source buffers by name.

Concrete currently-observable incorrect behavior:

-   a same-template block can observe a later write to a template-local value, because it is currently reading the channel's final value rather than the value at block invocation time
    
-   an overriding block can fail to treat an inherited block input like an ordinary local binding in nested assignment/control-flow cases
    
-   extern cycle validation is still incomplete: extern a = a is currently accepted instead of being rejected as an invalid initialization cycle
    

Architecturally, these are not isolated cleanup items. They are strong evidence that block invocation has not yet fully crossed over from runtime recovery to the explicit-input model described in [composition.md](https://markdownlivepreview.com/composition.md).

## Integration Tests That Can Show Incorrect Behavior

The following integration tests are likely to expose incorrect current behavior, and should be added or tightened before further refactoring:

-   same-template block invocation snapshots template-local values at invocation time, not final channel state Example shape: {% set x = "before" %}{% block content with user %}{{ x }}{% endblock %}{% set x = "after" %} Expected async result: "before"
    
-   same-template block invocation with async-produced locals snapshots the value at invocation time, not after later async reassignment
    
-   overriding block treats inherited block inputs as ordinary local bindings inside nested if / loop / guard scopes Example shape: child override does {% if true %}{% set user = "Grace" %}{% endif %}{{ user }} Expected async result: the block-local rebound value, not the original inherited invocation input
    
-   overriding block assignment to an inherited input inside nested scopes does not leak into super()
    
-   multi-level super() chain preserves original explicit invocation inputs even when the middle block rebinds those names inside nested scopes
    
-   async block invocation does not rely on compositionSourceBuffer fallback lookup for inherited inputs once explicit payload passing is in place
    
-   compile-source/integration test: overriding block entry no longer loops over context.getBlockContract(...).inputNames at runtime
    
-   compile-source/integration test: block entry no longer reads context.getCompositionSourceBuffer(...) for input initialization
    
-   extern self-cycle failure Example shape: {% extern a = a %}{{ a }} Expected result: clear validation failure, with compile-time rejection preferred once cycle validation is implemented there
    
-   extern indirect cycle failure across multiple declarations
    
-   deferred exports resolve correctly without linkDeferredExportsToBuffer(...)\-driven visibility linking
    
-   deferred export resolution fails loudly if a resolver exists without an explicit { buffer, channelName } producer record
    
-   async include/import regression tests proving those paths still behave correctly after inheritance cleanup, since they are already closer to the target architecture