# Documentation Compression Prompt

## Context

- **Sources**: `docs/cascada/script.md` — Cascada scripting language, authoritative reference. `docs/cascada/template.md` - Cascada prompt, differences from Nunjucks and Cascada Script
- **Protocol**: `docs/cascada/agent-compress-instructions.md` — compression rules and format
- **Output**: `docs/cascada/cascada-agent.md` — AI-optimized reference for Cascada code generation
- **Baseline**: AI agent with standard JavaScript, Python and Nunjucks template knowledge

---

## Steps

### Step 1 — Compress

Read `docs/cascada/agent-compress-instructions.md` in full.
Apply the compression protocol to the source documents
Write the result to the output document.

### Step 2 — Evaluate and Fix

Using the source documents and `docs/cascada/agent-compress-instructions.md` as reference, evaluate the output document for:

- Omissions (missing rules, constraints, edge cases)
- Errors or inaccuracies
- Structural issues (wrong ordering, poor categorization)
- Missed simplification opportunities

Update the output document to fix all issues found.
**Primary objective**: nothing important missing, nothing unnecessary present.

### Step 3 — Remove Redundancies

Analyze the output document and identify all redundancies removable without information loss. Update the document accordingly.
