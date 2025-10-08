# Handler Poisoning in Cascada Scripts: Complete Implementation Guide

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Background: The Poison System](#background-the-poison-system)
3. [The Handler Poisoning Challenge](#the-handler-poisoning-challenge)
4. [Solution Design](#solution-design)
5. [Syntax Reference](#syntax-reference)
6. [Implementation Phases](#implementation-phases)
7. [Runtime Protocol](#runtime-protocol)
8. [Compiler Changes](#compiler-changes)
9. [Examples](#examples)
10. [Edge Cases and Limitations](#edge-cases-and-limitations)

---

## Problem Statement

### The Core Issue

When a condition evaluation in a Cascada script is poisoned (i.e., results in a `PoisonedValue` due to an error), all side effects that would have occurred in the conditional branches must be properly accounted for. This includes:

1. **Variable modifications** - Already handled via `poisonBranchWrites(error, varCounts)`
2. **Output handler modifications** - **NOT YET HANDLED** - this document addresses this gap

### Why This Matters

Consider this script:

```javascript
{% if asyncFunc() %}
  @data.user.name = "Alice"
  @text("User created")
{% endif %}
```

If `asyncFunc()` throws an error:
- In **templates**: Simple - just add poison to the single output buffer
- In **scripts**: Complex - we have multiple independent handlers (`@data`, `@text`, potentially custom handlers)

**Question:** Which handlers need to be poisoned?

**Answer:** All handlers that would have been modified if the condition had evaluated successfully.

### Why Inefficient Solutions Are Unacceptable

**Option: "Poison all handlers"**
```javascript
// If condition fails, poison EVERY handler
poisonAllHandlers(error);
```

**Why this doesn't work:**
1. **False positives**: Handlers not used in the branch get poisoned unnecessarily
2. **Composition breaks**: Including a component that uses `@data` would poison unrelated `@turtle` handler
3. **Performance**: Checking/cleaning up all handlers is expensive
4. **Semantics**: Violates the principle of minimal poisoning

**Requirement:** We must know **exactly** which handlers are modified by each code block.

---

## Background: The Poison System

### What is Dataflow Poisoning?

Cascada uses **dataflow poisoning** instead of traditional exception handling. When an operation fails:

1. The operation returns a `PoisonedValue` (not throws an exception)
2. The poison propagates through data dependencies automatically
3. Any computation using poisoned values becomes poisoned
4. All errors are collected deterministically
5. Errors are thrown only at the final output stage

### Variable Poisoning in Conditionals

When a condition is poisoned, we must account for variables that would have been written:

```javascript
{% if asyncCondition() %}
  {% set x = 123 %}
  {% set y = 456 %}
{% else %}
  {% set x = 789 %}
{% endif %}
```

**Compiler calculates:**
- `true` branch writes: `{ x: 1, y: 1 }`
- `false` branch writes: `{ x: 1 }`
- Combined: `{ x: 2, y: 1 }` (sum of all possible paths)

**Runtime behavior:**
If condition is poisoned → `poisonBranchWrites(error, { x: 2, y: 1 })`

This ensures:
- Variable `x` is poisoned (would be written in either branch)
- Variable `y` is poisoned (would be written in true branch)
- No deadlocks in async synchronization system
- Deterministic error propagation

### The Parallel with Handlers

**Key insight:** Handler modifications are side effects just like variable modifications.

**What we need:** The same tracking and poisoning mechanism for handlers as we have for variables.

---

## The Handler Poisoning Challenge

### Case 1: Local Code (Easy)

```javascript
{% if condition %}
  @data.user.name = "Alice"
  @text("Created user")
{% endif %}
```

**Solution:** Compiler can see all `@handler` commands directly.
- Traverse child nodes
- Collect unique handler names: `['data', 'text']`
- Include in `poisonBranchWrites` call

**Status:** ✅ Straightforward static analysis

### Case 2: Includes (Medium)

```javascript
{% include "component.script" %}
```

**Problem:**
- `component.script` might use `@data`, `@text`, `@turtle`, etc.
- Component file might not be available at compile time (dynamic loading, external server)
- Static analysis is unreliable or impossible

**Solution:** Explicit declaration required.

**Status:** ⚠️ Needs annotation syntax

### Case 3: Imported Macros (Medium)

```javascript
{% from "ui.script" import pushButton, formatUser %}

{% if condition %}
  {{ pushButton("Submit") }}
{% endif %}
```

**Problem:**
- `pushButton` macro might use `@data`, `@text`
- Macro definition in external file
- Need to know which handlers each macro uses

**Solution:** Declare handlers per imported macro.

**Status:** ⚠️ Needs annotation syntax

### Case 4: Namespace Imports (Hard)

```javascript
{% import "ui.script" as ui %}

{% if condition %}
  {{ ui.pushButton("Submit") }}
  {{ ui.formatUser(user) }}
{% endif %}
```

**Problem:**
- Namespace could contain dozens of macros
- Each macro might use different handlers
- Can't know at compile time which macros will be called
- Can't use conservative "poison all handlers" approach

**Solution:** Map macro names to their handler usage.

**Status:** ⚠️ Needs special syntax for namespace imports

### Case 5: Extensions and Custom Tags (Hard)

```javascript
{% if condition %}
  {% customTag %}...{% endcustomTag %}
{% endif %}
```

**Problem:**
- Extensions are JavaScript code, not Cascada templates
- No way to statically analyze which handlers they use
- Need metadata from extension author

**Solution:** Extension registration API includes handler metadata.

**Status:** ⚠️ Needs API extension

---

## Solution Design

### Core Principles

1. **Explicit is better than implicit** - Require declarations for cross-file handler usage
2. **@-prefix distinguishes handlers from variables** - `modifies @data` not `modifies data`
3. **Consistent with existing syntax** - Reuse `:returnType` pattern from macros
4. **No inefficient fallbacks** - Must poison exactly the right handlers
5. **Tooling support** - Provide tools to auto-generate declarations

### Design Strategy

**Three-tier approach:**

1. **Tier 1: Local Analysis (Automatic)**
   - Compiler analyzes local `@handler` commands
   - No annotations needed
   - Works for simple cases

2. **Tier 2: Explicit Declarations (Required)**
   - Use `modifies @handler` or `:@handler` syntax
   - Required for includes and imports
   - Compiler uses declarations for poisoning

3. **Tier 3: Verification (Optional but Recommended)**
   - Static analysis tool processes all templates
   - Verifies declarations match actual usage
   - Auto-generates missing declarations
   - Warns on incorrect declarations

### Handler Poisoning Protocol

Each handler must implement a standard interface:

```javascript
class Handler {
  /**
   * Called when commands targeting this handler were skipped
   * due to a poisoned condition.
   *
   * @param {PoisonedValue} error - The poison value
   */
  poisonWrites(error) {
    // Handler-specific implementation
  }

  /**
   * Get final value, possibly throwing if poisoned
   */
  getReturnValue() {
    // Return final value or throw PoisonError
  }
}
```

**Handler-specific behavior:**

- **DataHandler**: Mark as poisoned, throw `PoisonError` in `getReturnValue()`
- **TextHandler**: Add poison to text buffer (like templates do)
- **Custom Handlers**: Define their own poisoning semantics

---

## Syntax Reference

### 1. Include with Handler Declarations

**Syntax:**
```javascript
{% include "path" modifies @handler1, @handler2 %}
```

**Examples:**
```javascript
// Include component that uses @data and @text
{% include "user-card.script" modifies @data, @text %}

// Include component that uses custom handler
{% include "chart.script" modifies @data, @canvas %}

// Include template (no handlers - only text output)
{% include "header.html" %}
```

**Semantics:**
- Declares which handlers the included file might modify
- Compiler uses this for poisoning when include is in poisonable context
- Error if declaration is missing and file uses handlers

### 2. Macro Return Type (Local Definition)

**Syntax:**
```javascript
macro name(args) :@handler
  // body
endmacro
```

**Examples:**
```javascript
// Macro that only builds data
macro buildUser(name) :@data
  @data.user.name = name
  @data.user.active = true
endmacro

// Macro that produces text
macro greeting(name) :@text
  @text("Hello, " + name)
endmacro

// Macro that uses multiple handlers
macro renderCard(user) :@data, @text
  @data.card.title = user.name
  @text("<div class='card'>")
endmacro
```

**Semantics:**
- `:@handler` specifies which handlers the macro modifies
- Used for poisoning when macro is called in poisonable context
- Optional - compiler can infer from local analysis
- Serves as documentation even when inference works

### 3. Named Imports with Handler Declarations

**Syntax:**
```javascript
{% from "path" import macroName:@handler1, @handler2 %}
```

**Examples:**
```javascript
// Import button macro that uses data
{% from "ui.script" import pushButton:@data %}

// Import multiple macros with different handlers
{% from "ui.script" import
  pushButton:@data,
  showToast:@text,
  drawChart:@canvas
%}

// Import macro that uses multiple handlers
{% from "formatters.script" import formatUser:@data, @text %}
```

**Semantics:**
- `:@handler` suffix declares which handlers each macro uses
- Multiple handlers separated by commas
- Required for named imports
- Used for poisoning when macro is called in poisonable context

### 4. Namespace Imports with Macro Mapping

**Syntax:**
```javascript
{% from "path" import namespace with macros
  macroName1:@handler1,
  macroName2:@handler2, @handler3
%}
```

**Examples:**
```javascript
// Import UI namespace with macro mappings
{% from "ui.script" import ui with macros
  pushButton:@data,
  toggleCheckbox:@data,
  showToast:@text
%}

// Usage
{{ ui.pushButton("Submit") }}
{{ ui.showToast("Saved!") }}

// Compact single-line form for few macros
{% from "utils.script" import fmt with macros format:@text, escape:@text %}
```

**Semantics:**
- `with macros` keyword introduces macro-to-handler mapping
- Each line maps a macro name to its handlers
- Only mapped macros are accessible via namespace
- Used for poisoning based on which macro is actually called
- Allows different macros in namespace to use different handlers

### 5. Extension Handler Metadata

**Registration API:**
```javascript
env.addExtension('customTag', {
  tags: ['customTag'],
  modifies: ['@data', '@text'], // Handler declarations
  parse: function(parser, nodes, lexer) { ... },
  run: function(context, args, body) { ... }
});
```

**Examples:**
```javascript
// Extension that only modifies data
env.addExtension('validator', {
  tags: ['validate'],
  modifies: ['@data'],
  run: function(context, rules) {
    // Validation logic that writes to @data
  }
});

// Extension that uses custom handler
env.addExtension('chart', {
  tags: ['chart'],
  modifies: ['@canvas', '@data'],
  run: function(context, config) {
    // Drawing logic
  }
});
```

**Semantics:**
- `modifies` array declares which handlers the extension might use
- Compiler uses this for poisoning
- Optional - defaults to conservative behavior if missing
- Recommended for all extensions that use handlers

### 6. Variable Declarations (Existing)

**For completeness, here's the variable syntax:**

```javascript
// Read-only access to variables
{% include "component.script" reads user, theme %}

// Read-write access to variables
{% include "component.script" modifies theme %}

// Combined variable and handler declarations
{% include "component.script"
   reads user
   modifies theme, @data, @text
%}
```

---

## Implementation Phases

### Phase 1: Foundation (Core Runtime)

**Objective:** Implement handler poisoning protocol

**Tasks:**
1. Add `poisonWrites(error)` method to handler interface
2. Implement `poisonWrites()` for built-in handlers:
   - `DataHandler`: Mark poisoned, throw in `getReturnValue()`
   - `TextHandler`: Add poison to buffer
3. Extend `poisonBranchWrites()` to handle handlers:
   ```javascript
   poisonBranchWrites(error, {
     variables: { x: 1, y: 2 },
     handlers: ['data', 'text']
   })
   ```
4. Update `flattenBuffer()` to call `poisonWrites()` on handlers

**Deliverables:**
- Updated `runtime.js` with handler poisoning support
- Tests for handler poisoning protocol
- Documentation for custom handler authors

### Phase 2: Compiler Support (Local Analysis)

**Objective:** Track handler usage in local code

**Tasks:**
1. Extend frame analysis to track handlers:
   ```javascript
   frame = {
     variables: new Set(['x', 'y']),
     handlerUsage: new Set(['data', 'text'])
   }
   ```
2. Traverse AST nodes to find `@handler` commands
3. Collect unique handler names per scope
4. Generate `poisonBranchWrites()` calls with handler info:
   ```javascript
   if (isPoison(condition)) {
     frame.poisonBranchWrites(condition, {
       variables: { x: 1, y: 2 },
       handlers: ['data', 'text']
     });
   }
   ```

**Deliverables:**
- Updated compiler with handler tracking
- Tests for local handler analysis
- Handler tracking in `if`, `switch`, `while` statements

### Phase 3: Syntax Support (Declarations)

**Objective:** Implement declaration syntax

**Tasks:**
1. Extend parser to recognize:
   - `modifies @handler` in include statements
   - `:@handler` in macro definitions
   - `:@handler` in from-import statements
   - `with macros` in namespace imports
   - `modifies` in extension registration
2. Store handler declarations in AST nodes
3. Compiler uses declarations for poisoning:
   ```javascript
   // For include
   node.handlerDeclarations = ['data', 'text'];

   // For macro
   node.returnHandlers = ['data'];

   // For namespace
   node.macroHandlerMap = {
     pushButton: ['data'],
     showToast: ['text']
   };
   ```

**Deliverables:**
- Parser support for all declaration syntaxes
- Compiler uses declarations for poisoning
- Tests for each syntax variant
- Error messages for missing/invalid declarations

### Phase 4: Verification Tool (Static Analysis)

**Objective:** Build tool to verify/generate declarations

**Tasks:**
1. Create static analysis tool that:
   - Recursively loads all templates/scripts
   - Analyzes which handlers each file/macro uses
   - Compares with declared handlers
   - Reports mismatches
2. Add auto-generation mode:
   - Scans codebase
   - Generates correct declarations
   - Inserts into source files
3. Add CI/CD integration:
   - Fails build on incorrect declarations
   - Suggests corrections

**Deliverables:**
- `cascada-verify` command-line tool
- `--fix` mode to auto-generate declarations
- CI/CD plugin
- Documentation for tool usage

### Phase 5: IDE Support (Optional)

**Objective:** Provide IDE integration for declarations

**Tasks:**
1. Language server protocol support
2. Auto-completion for handler names
3. Inline diagnostics for incorrect declarations
4. Quick-fix actions to add/correct declarations
5. Hover documentation showing handler usage

**Deliverables:**
- LSP server implementation
- VS Code extension
- Documentation for IDE setup

---

## Runtime Protocol

### Handler Interface

```javascript
/**
 * Interface that all handlers must implement
 */
class Handler {
  /**
   * Called when output commands were skipped due to poisoned condition.
   * Handler should mark itself as poisoned or add poison to its output.
   *
   * @param {PoisonedValue} error - The poison value containing errors
   */
  poisonWrites(error) {
    throw new Error('Not implemented');
  }

  /**
   * Get the final return value for this handler.
   * Should throw PoisonError if handler is poisoned.
   *
   * @returns {any} The handler's final value
   * @throws {PoisonError} If handler is poisoned
   */
  getReturnValue() {
    throw new Error('Not implemented');
  }
}
```

### DataHandler Implementation

```javascript
class DataHandler extends Handler {
  constructor() {
    this.data = {};
    this.poisoned = false;
    this.poisonError = null;
  }

  poisonWrites(error) {
    this.poisoned = true;
    this.poisonError = error;
  }

  getReturnValue() {
    if (this.poisoned) {
      throw new PoisonError(this.poisonError.errors);
    }
    return this.data;
  }

  // ... other methods (set, push, merge, etc.)
}
```

### TextHandler Implementation

```javascript
class TextHandler extends Handler {
  constructor() {
    this.buffer = [];
  }

  poisonWrites(error) {
    // Add poison to buffer - will be caught by flattenBuffer
    this.buffer.push(error);
  }

  getReturnValue() {
    // Text handler returns string, poison is caught during flattening
    return this.buffer.join('');
  }
}
```

### Custom Handler Example

```javascript
class CanvasHandler extends Handler {
  constructor() {
    this.commands = [];
    this.poisoned = false;
    this.poisonError = null;
  }

  poisonWrites(error) {
    // Mark entire canvas as invalid
    this.poisoned = true;
    this.poisonError = error;
  }

  getReturnValue() {
    if (this.poisoned) {
      throw new PoisonError(this.poisonError.errors);
    }
    return this.toImageData();
  }

  // Canvas-specific methods
  drawLine(x1, y1, x2, y2) {
    this.commands.push({ type: 'line', x1, y1, x2, y2 });
  }
}
```

### Runtime Poisoning Function

```javascript
/**
 * Poison all branch writes including handlers
 *
 * @param {PoisonedValue|Error} error - The poison or error
 * @param {Object} counts - What would have been written
 * @param {Object} counts.variables - Variable write counts
 * @param {Array<string>} counts.handlers - Handler names used
 */
AsyncFrame.prototype.poisonBranchWrites = function(error, counts) {
  const poison = isPoison(error) ? error : createPoison(error);

  // Poison variables (existing logic)
  if (counts.variables) {
    for (let varName in counts.variables) {
      // ... existing variable poisoning logic
    }
  }

  // NEW: Poison handlers
  if (counts.handlers && counts.handlers.length > 0) {
    for (const handlerName of counts.handlers) {
      const handler = this.getHandler(handlerName);
      if (handler && typeof handler.poisonWrites === 'function') {
        handler.poisonWrites(poison);
      }
    }
  }
};

/**
 * Get handler instance by name
 */
AsyncFrame.prototype.getHandler = function(handlerName) {
  // Look up in context/environment
  const context = this.getContext();
  const env = context.env;

  // Check handler instances
  if (env.commandHandlerInstances[handlerName]) {
    return env.commandHandlerInstances[handlerName];
  }

  // Instantiate if needed
  if (env.commandHandlerClasses[handlerName]) {
    const HandlerClass = env.commandHandlerClasses[handlerName];
    const instance = new HandlerClass(context.getVariables(), env);
    env.commandHandlerInstances[handlerName] = instance;
    return instance;
  }

  // Built-in handlers
  if (handlerName === 'text') {
    // Text is special - always available
    return env.getTextHandler();
  }

  return null;
};
```

---

## Compiler Changes

### AST Node Extensions

Add handler tracking to relevant AST nodes:

```javascript
// Include node
class Include extends Node {
  constructor(lineno, colno, template, modifiesVars, modifiesHandlers) {
    super(lineno, colno);
    this.template = template;
    this.modifiesVars = modifiesVars || [];
    this.modifiesHandlers = modifiesHandlers || []; // NEW
  }
}

// Macro node
class Macro extends Node {
  constructor(lineno, colno, name, args, body, returnHandlers) {
    super(lineno, colno);
    this.name = name;
    this.args = args;
    this.body = body;
    this.returnHandlers = returnHandlers || []; // NEW
  }
}

// FromImport node
class FromImport extends Node {
  constructor(lineno, colno, template, names, withContext, macroHandlers) {
    super(lineno, colno);
    this.template = template;
    this.names = names; // Array of {name, alias, handlers} objects
    this.withContext = withContext;
    this.macroHandlers = macroHandlers || {}; // NEW: {macroName: [handlers]}
  }
}

// Import node
class Import extends Node {
  constructor(lineno, colno, template, target, withContext, macroHandlers) {
    super(lineno, colno);
    this.template = template;
    this.target = target; // namespace name
    this.withContext = withContext;
    this.macroHandlers = macroHandlers || {}; // NEW: {macroName: [handlers]}
  }
}
```

### Frame Handler Tracking

Extend `AsyncFrame` during compilation:

```javascript
class AsyncFrame extends Frame {
  constructor(parent, isolateWrites, createScope = true) {
    super(parent, isolateWrites);
    // ... existing properties

    if (AsyncFrame.inCompilerContext) {
      this.handlerUsage = undefined; // NEW: Set<string>
    }
  }
}
```

### Handler Collection Algorithm

```javascript
/**
 * Collect handler names from AST subtree
 *
 * @param {Node} node - AST node to analyze
 * @param {Set<string>} handlers - Accumulator for handler names
 */
function collectHandlers(node, handlers) {
  if (node instanceof OutputCommand) {
    // Extract handler name from @handler.command() syntax
    const handlerName = extractHandlerName(node.call.name);
    if (handlerName) {
      handlers.add(handlerName);
    }
  }

  if (node instanceof Include) {
    // Use declared handlers
    node.modifiesHandlers.forEach(h => handlers.add(h));
  }

  if (node instanceof FunCall) {
    // Check if calling a macro with known handlers
    const macro = resolveMacro(node.name);
    if (macro && macro.returnHandlers) {
      macro.returnHandlers.forEach(h => handlers.add(h));
    }
  }

  // Recurse to children
  for (const child of getImmediateChildren(node)) {
    collectHandlers(child, handlers);
  }
}

/**
 * Extract handler name from @handler.path syntax
 *
 * @param {Node} nameNode - The name node (Symbol or LookupVal)
 * @returns {string|null} Handler name or null
 */
function extractHandlerName(nameNode) {
  const staticPath = _extractStaticPath(nameNode);
  if (staticPath && staticPath.length >= 1) {
    return staticPath[0]; // First segment is handler name
  }
  return null;
}
```

### Conditional Compilation

Update `compileIf` to include handler poisoning:

```javascript
compileIf(node, frame) {
  // ... existing code ...

  // Collect handlers used in branches
  const trueBranchHandlers = new Set();
  const falseBranchHandlers = new Set();

  collectHandlers(node.body, trueBranchHandlers);
  if (node.else_) {
    collectHandlers(node.else_, falseBranchHandlers);
  }

  // Combine into single set
  const allHandlers = new Set([
    ...trueBranchHandlers,
    ...falseBranchHandlers
  ]);

  // Generate poisoning code
  if (this.asyncMode && allHandlers.size > 0) {
    const handlerList = JSON.stringify([...allHandlers]);

    // Add to poison check
    this.emit.insertLine(poisonCheckPos,
      `  frame.poisonBranchWrites(condResult, {
         variables: ${JSON.stringify(combinedCounts)},
         handlers: ${handlerList}
       });`
    );

    // Add to catch block
    this.emit.insertLine(catchPoisonPos,
      `    frame.poisonBranchWrites(e, {
         variables: ${JSON.stringify(combinedCounts)},
         handlers: ${handlerList}
       });`
    );
  }

  // ... rest of existing code ...
}
```

---

## Examples

### Example 1: Simple If Statement

**Input:**
```javascript
{% if asyncFunc() %}
  @data.user.name = "Alice"
  @text("User created")
{% endif %}
```

**Compiled (simplified):**
```javascript
try {
  const condResult = await asyncFunc();
  if (runtime.isPoison(condResult)) {
    // Poison both handlers
    frame.poisonBranchWrites(condResult, {
      handlers: ['data', 'text']
    });
  } else if (condResult) {
    // Execute body
    // ...
  }
} catch (e) {
  if (runtime.isPoisonError(e)) {
    frame.poisonBranchWrites(e, {
      handlers: ['data', 'text']
    });
  } else {
    throw e;
  }
}
```

### Example 2: Include with Handlers

**Input:**
```javascript
{% if condition %}
  {% include "user-card.script" modifies @data, @text %}
{% endif %}
```

**Behavior:**
- If `condition` is poisoned, both `@data` and `@text` are poisoned
- Include statement declares which handlers it uses
- Compiler uses declaration for poisoning

### Example 3: Macro with Return Type

**Input:**
```javascript
macro buildUser(name) :@data
  @data.user.name = name
  @data.user.active = true
endmacro

{% if condition %}
  {{ buildUser("Alice") }}
{% endif %}
```

**Behavior:**
- Macro declares `:@data` as return handler
- If `condition` is poisoned, `@data` is poisoned
- Compiler knows `buildUser` only affects `@data`

### Example 4: Named Import

**Input:**
```javascript
{% from "ui.script" import
  pushButton:@data,
  showToast:@text
%}

{% if condition %}
  {{ pushButton("Submit") }}
{% endif %}
```

**Behavior:**
- Import declares `pushButton` uses `@data`
- If `condition` is poisoned, `@data` is poisoned (not `@text`)
- Precise poisoning based on which macro is called

### Example 5: Namespace Import

**Input:**
```javascript
{% from "ui.script" import ui with macros
  pushButton:@data,
  showToast:@text
%}

{% if condition %}
  {{ ui.pushButton("Submit") }}
{% endif %}
```

**Behavior:**
- Namespace maps each macro to its handlers
- Compiler knows `ui.pushButton` uses `@data`
- Only `@data` is poisoned if condition fails
- Different macros can use different handlers

### Example 6: Complex Branching

**Input:**
```javascript
{% switch asyncGetType() %}
  {% case "user" %}
    @data.entity.type = "user"
    {% include "user-card.script" modifies @data %}
  {% case "group" %}
    @data.entity.type = "group"
    @text("Group info")
  {% default %}
    @text("Unknown type")
{% endswitch %}
```

**Behavior:**
- Compiler collects handlers from all branches:
  - Case "user": `@data` (local + include)
  - Case "group": `@data`, `@text`
  - Default: `@text`
  - Combined: `@data`, `@text`
- If `asyncGetType()` is poisoned, both handlers are poisoned

### Example 7: Nested Conditionals

**Input:**
```javascript
{% if outerCondition %}
  @data.outer = true

  {% if innerCondition %}
    @data.inner = true
    @text("Both true")
  {% endif %}
{% endif %}
```

**Behavior:**
- Outer if: handlers = `@data`, `@text` (includes nested)
- Inner if: handlers = `@data`, `@text`
- If `outerCondition` poisoned: both handlers poisoned
- If `innerCondition` poisoned: both handlers poisoned
- Handler sets are propagated upwards correctly

---

## Edge Cases and Limitations

### 1. Dynamic Handler Names

**Not Supported:**
```javascript
var handlerName = "data"
@[handlerName].value = 123
```

**Reason:** Cannot determine handler at compile time.

**Workaround:** Use explicit handler names.

### 2. Dynamically Generated Template Names

**Problem:**
```javascript
var templateName = "component-" + type + ".script"
{% include templateName %}
```

**Solution:** Require explicit handler declaration:
```javascript
{% include templateName modifies @data, @text %}
```

**Note:** Static analysis tool cannot verify this - runtime is trusted.

### 3. External/Remote Templates

**Problem:** Template loaded from external server at runtime.

**Solution:** Must declare handlers explicitly:
```javascript
{% include fetchTemplate("user-card") modifies @data %}
```

**Note:** Cannot be verified by static analysis tool.

### 4. Conditional Handler Usage

**Problem:**
```javascript
{% if featureEnabled %}
  @data.feature.enabled = true
{% else %}
  @text("Feature disabled")
{% endif %}
```

**Behavior:**
- Compiler sees both `@data` and `@text` might be used
- If condition poisoned, BOTH are poisoned
- Even though only one would execute in practice

**Rationale:** Conservative but correct - we must account for all possible paths.

### 5. Handler Usage in Loops

**Problem:**
```javascript
{% for item in items %}
  @data.items.push(item)
{% endfor %}
```

**Behavior:**
- If `items` is poisoned, `@data` is poisoned
- Loop body handlers are collected once (not multiplied by iterations)
- Same as variable write counts - loop counts as 1 write

### 6. Handlers in Macros Not Declared

**Problem:** Macro uses handlers but doesn't declare them.

**Solution:**
- Compiler warning/error if macro uses handlers without declaration
- Static analysis tool can detect and fix
- Consider requiring declarations for exported macros

### 7. Handler in Extension Without Metadata

**Problem:** Extension uses handlers but doesn't declare in `modifies`.

**Behavior:**
- Conservative approach: assume all handlers might be used
- Performance penalty - more handlers poisoned than necessary
- Recommendation: Always add `modifies` metadata

### 8. Recursive Includes

**Problem:**
```javascript
// a.script includes b.script
// b.script includes a.script
```

**Solution:**
- Handler declarations must be complete at each level
- Circular includes are already problematic for other reasons
- No special handling needed for handler poisoning

### 9. Multiple Output Focuses

**Problem:**
```javascript
macro m1() :@data
macro m2() :@text

:@data, @text  // Multiple focuses?
```

**Behavior:**
- Output focus selects which handler to return
- Can only focus on one handler
- Multiple focuses not supported

### 10. Handler Aliasing

**Problem:**
```javascript
var d = @data
d.value = 123  // Does this count as @data usage?
```

**Current:** Not supported - cannot track aliased handlers.

**Future:** May need dataflow analysis to track aliases.

---

## Appendix: Related Concepts

### Comparison with Variable Poisoning

| Aspect | Variables | Handlers |
|--------|-----------|----------|
| **Tracking** | Compile-time write counts | Compile-time handler usage |
| **Propagation** | Poison value in frame | Call `poisonWrites()` |
| **Detection** | Count-based (decrements) | Presence-based (used/not used) |
| **Deduplication** | By variable name | By handler name |
| **Scope** | Frame hierarchy | Global per-handler |

### Handler Lifecycle

1. **Registration**: Handler registered with environment
2. **Instantiation**: Instance created when first used
3. **Command Execution**: Commands buffered during template execution
4. **Poisoning**: `poisonWrites()` called if branch skipped
5. **Assembly**: Commands dispatched after all async work completes
6. **Finalization**: `getReturnValue()` called, may throw PoisonError

### Integration with Async System

Handler poisoning integrates with Cascada's existing async framework:

- Uses same `PoisonedValue` and `PoisonError` classes
- Follows same "never miss any error" principle
- Respects same async block boundaries
- Works with variable synchronization system

---

## References

- [Poison Implementation Reference Guide](./Poison%20Implementation%20Reference%20Guide.md) - Core poison system
- [Cascada Script Documentation](./script.md) - Script syntax and semantics
- [Async Implementation Guide](./async-implementation.md) - Async execution details
- [Progress Summary](./progress-summary.md) - Current implementation status

---

**Document Status:** Complete Design Specification
**Implementation Status:** Phase 0 (Not Started)
**Next Steps:** Begin Phase 1 - Foundation (Core Runtime)