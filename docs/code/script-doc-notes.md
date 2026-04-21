TODO
depends - in transpiler and tests: remove
rewrite intro doc
rewrite kitchen doc
regenerate and publish docs
remove sink
"Context values follow the same value semantics". What about appConfig.debug = true? I think the config shall be a local copy - you can modify it but changes are only local? The difference: side-effect functions.
Do we support else if on the same line? elseif
sequence - add property access (do we have), do we have sub-paths (as data). Shall we support property assignment?
Update streaming and link it from 
Roadmap - handle push, etc.. as data handles this??? Maybe replace var with data?

script.md
+ Ordinary stressed at the start with simple example or features. Move it from Features at a glance: What makes Cascada Script remarkable is how unremarkable it looks.
+ explicit sequencing only when needed - not just !, also sequential
+ mention dataflow poisoning
- read first - the linked docs are outdated. 
+ quick start - separate script and running a script - make it more readable, good example script must look very familiar, yet be short. We already have script example, this one shows mostly the API
+ Parallel by default - mention loops, calls, … 
+ Data-Driven Flow - mention if, expression depending on values that are not ready yet
+ Implicitly Parallel, Explicitly Sequential
 + while, each, !, sequential
- Dataflow Poisoning - if condition - poison both branches
- Features at a Glance - NO: Re-assign declared vars; supports +=, -=, *=, etc.
 - Parallel loop - for item in array / also show for property in object , for element in iterator
 - Function calls	funcName(a, b, keyword=c), is the keyword = c supported? named arguments?
 - Macros - rename to Functions, all function examples, etc..
 - Imports - show import from too
-  purpose-built constructs - show how data, text, sequence, etc.. work, not just declarations
- Core Syntax and Expressions: Remove No Tag Delimiters
- Variable Assignment and Value Semantics : " assign or re-assign a value to a previously declared variable" - assign or reassign a variable to a new value.
- Performance Note - mark it differently
- Add object composition, array composition after assignment
- Mutation Methods and Side Effects, Say there are still ways to use these safely: next section is data channel : say it mitigates these problems. Also Use if you don't care about order. Also - list the unsafe methods.
- Handling none (null) - show usage that poisons - obj.propery
- "Context values follow the same value semantics". What about appConfig.debug = true? I think the config shall be a local copy - you can modify it but changes are only local? The difference: side-effect functions.
- Inline if Expressions : mention the Python syntax
- Conditionals - I don't think we support elseif. Do we support else if
- "Sequential or Constrained Async Iterators: ❌ Not Available. When an async iterator is restricted - by each or a concurrency limit (of N) - it behaves like a stream. Cascada cannot see the end of the stream in advance, so loop.length and loop.last are undefined." - I think they are promises? Can you create a deadlock. We shall forbid these in the condition. Explain, we move onto the next iteration, but the previous one remains unfinished till the loop ends.
- Error handling and recovery with conditionals and loops. We have not mentioned error handling at this point. We shall reference the error handling section at the start.
- "Note: Direct assignment to var is safe in concurrent code" - we do not need this in Channels, it is about var and is implied in multiple places.
- "How Channel Writes Are Ordered" - shows data example followed immediately by the data docs, the first example is not needed.
- The data Channel: Building Structured Data - explain how it is different than var: push/etc are safe, in var they use the standard JS side-effect calls. Use if you don't care about order. Property mutation - slower with big data.
- text channel shall be first
- remove sink
- sequential - Property assignment is a compile error - shall it be this way? "Show an invalid property assignment" - this is instruction not example title
-  ⚠️ Guard transaction hooks in the sequence channel - this is not the place!!!

- Maybe we shall move Error handling before Channels? We have error handling section there. Guard too? I think not, but let us mention the Error Handling at the start of such sections that predate the error handling explanations.
- ## Managing Side Effects: Sequential Execution [Operator - add]. Mention sequential
- "**Exception for macros:** When a macro uses `!` on a parameter," - this is not implemented
- #### How Scripts Fail: too convoluted. It fails only when the returned value is a poison. that's it. We may have poisoned values through the script, as long as they do not reach the returned value - they are successful
- ## Macros and Reusable Components - before Error handling
- "Macros can `return` any value" - not channels, these must be snapshotted!!!
- "### Error handling and recovery with macros - When an Error Value is passed as an argument to a macro, the macro body is skipped entirely and the macro immediately returns a poisoned value." - This is not true anymore, some arguments may be poisoned, but the macro can handle these
- ## Modular Scripts - extends and include are not supported in scripts, remove them! The whole ## Modular Scripts section shall become only about import, so maybe rename it to Importing from Scripts. Do not start with extern and with (importing can do just fine without both). Start with the import basics and most common and simple use case
- Extending Cascada is now only about extending data - move it in data, remove the whole extending cascada section.
- ### Creating Custom Command Handlers, #### Registering and Using Handlers - these are no longer needed we have sequential for this!!! A Turtle Graphics Handler - maybe move this in sequential
#### Extending the Engine - add global is not exactly this. Just say adding global methods.
- Roadmap
 - streaming - add link
 - macro pass by reference, sequence too
 - **Root-Level Sequential Operator** - remove this
 - **Automated Dependency Declaration Tool** - remove this
**Robustness and Concurrency Validation** -  Extensive … Testing and Validation



Template document:
-  **differences** between Cascada Script and Cascada Template syntax  - and nunjucks!
- remove sink
- macro vs function
- scripts do not have extends and include, only import
- with context - same as script

## Variable Scoping - difference between sync/async
Must have two sections
- Differences between Script and Templates
- Differences between Sync and Async templates