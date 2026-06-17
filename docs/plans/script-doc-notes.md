TODO
rewrite kitchen doc
regenerate and publish docs
"Context values follow the same value semantics". What about appConfig.debug = true? I think the config shall be a local copy - you can modify it but changes are only local? The difference: side-effect functions.
sequence - add property access (do we have), do we have sub-paths (as data). Shall we support property assignment?
Update streaming and link it from 
Roadmap - handle push, etc.. as data handles this??? Maybe replace var with data?

script.md
- read first - the linked docs are outdated. 


Template document:
-  **differences** between Cascada Script and Cascada Template syntax  - and nunjucks!
- macro vs function
- scripts do not have extends and include, only import
- with context - same as script

## Variable Scoping - difference between sync/async
Must have two sections
- Differences between Script and Templates
- Differences between Sync and Async templates
