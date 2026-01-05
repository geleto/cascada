# Documentation Compression for AI Agents Instructions

## Your Task

Transform the provided documentation into a token-efficient, AI-optimized reference that preserves all technical information while eliminating redundancy and narrative. Follow the compression protocol below to create a lossless semantic compression.

---

## Input Requirements

**You will receive:**
1. Source documentation to compress
2. Context about the technology/language (if applicable)
3. Target use case (e.g., "for AI code generation", "for agent workflows", etc.)

**Before starting, identify:**
- What baseline knowledge the target AI already possesses (e.g., standard JavaScript, Python conventions)
- Which behaviors/features are **differentials** (novel or different from standard)
- Which behaviors are standard and should be excluded
- Treat the source document as the single authoritative grammar, API and syntax reference; syntax is semantic.
- When identifying baseline knowledge for exclusion purposes, NEVER use it to replace, normalize, or rewrite syntax forms from the source, even if an equivalent exists in another language or API (e.g., JS, Python).
- Identify all language/API/operational modes present in the source (e.g., Script syntax, Template syntax, different APIs, different modes of operation, etc.) and treat each mode separately. Do NOT translate, normalize, or import constructs across modes unless the source explicitly defines such mapping.

---

## Compression Protocol

### Phase 1: Normative Extraction & UID Indexing

**Extract all behavioral rules from the source:**

1. **Scan for normative statements:**
   - Modal verbs: must, must not, shall, shall not, should, may
   - Absolutes: only, never, always, all, none
   - Conditionals: if...then, when...then, unless
   - Constraints: requires, depends on, limited to
   - Boundaries: cannot, prohibited, restricted
   - Syntax forms, grammar constructs, and expression shapes shown in the source (e.g. inline if expressions, operators, keywords, ordering, for loops, etc.) are NORMATIVE and MUST receive UIDs if they define valid language syntax.

2. **Create UID Pattern Index:**
   ```
   UID-[Category]-[Number]: [Normative Statement]
   ├── Source: [Original location]
   ├── Type: [Rule|Constraint|Edge Case|Limitation]
   ├── Differential: [Yes|No]
   └── Dependencies: [Related UIDs]
   ```

3. **Verification gate:**
   - Ensure 100% coverage: every normative statement has a UID
   - No rule is discarded without mapping
   - Create bidirectional index (UID ↔ Statement)

---

### Phase 2: Semantic Deduplication

**Collapse redundant expressions:**

1. **Identify duplicates:**
   - Same rule phrased differently
   - Overlapping constraints
   - Redundant examples showing identical behavior
   - Transitively derivable rules

2. **Canonicalize:**
   - Select strictest constraint version
   - Merge all expressions into single invariant
   - Mark duplicates as: `UID-XXX: DEPRECATED → UID-YYY`
   - Preserve unique edge cases

3. **Eliminate transitives:**
   ```
   IF Rule-A + Rule-B → Rule-C (logically)
   THEN remove Rule-C, reference Rule-A and Rule-B
   ```

4. **Semantic deduplication MUST NOT:**
- Canonicalize or normalize syntax forms
- Replace one expression grammar with another
- Merge rules that differ in syntactic form, even if behavior appears equivalent

If two constructs differ in syntax, they are NOT duplicates.
They must remain separate UIDs or be marked explicitly as invalid alternatives.

---

### Phase 3: Atomic Encoding

**Transform each UID into a Semantic Atom using this rigid format:**

```javascript
// [UID-XX] RULE: [Single declarative statement]
// DIFFERENTIAL: [How this differs from standard behavior - ONLY if applicable]
// CONSTRAINT: [Conditions, limitations, or dependencies]

// ✅ Valid: [Minimal reasoning why this is correct]
[Shortest code demonstrating correct usage]

// ❌ Invalid: [Common mistake or boundary violation]
[Code showing what breaks/fails]
```

**Each atom must:**
- Demonstrate exactly one rule/differential
- Be independently understandable (no prior context needed)
- Contain minimal code (no boilerplate unless boilerplate IS the rule)
- Show both valid and invalid usage
- State rules in comments, not narrate code flow
- Include DIFFERENTIAL only if behavior differs from standard
- Code examples MUST use the exact syntax and mode shown in the source

**Each atom MUST NOT:**
- Substitute equivalent usage or syntax from other languages, APIs or technologies
- Rewrite expression forms for brevity or familiarity
- Substitute equivalent constructs from other modes (Script vs Template, etc.)

**Quality checklist per atom:**
- [ ] UID referenced
- [ ] Invariant is single sentence
- [ ] Differential stated (if applicable)
- [ ] Valid example is minimal
- [ ] Invalid example shows common mistake
- [ ] No mixed concepts
- [ ] No narrative prose
- [ ] No changed usage or syntax forms

---

### Phase 4: Structural Assembly

**Organize atoms into optimal lookup structure:**

#### 1. Sigil/Symbol Table (if applicable)
Dense reference for operators, keywords, special symbols that differ from standard.

```markdown
| Symbol | Name | Differential | Constraint | Example |
|:-------|:-----|:-------------|:-----------|:--------|
| ... | ... | ... | ... | ... |
```

#### 2. Core Execution Model / Invariants
- Core differentials defining runtime behavior
- Pure invariants with UID references
- No examples here (examples go in Semantic Library)
- Ordered by logical dependency

#### 3. Semantic Library
All Semantic Atoms organized by:
- Logical categories (relevant to the technology)
- Ordered by prerequisite knowledge within each category
- Cross-referenced via UID (never duplicate content)

**Suggested categories** (adapt to your domain):
- Core Concepts & Differentials
- Data Flow & Dependencies
- Control Flow
- Side Effects & Sequencing
- Error Handling & Recovery
- Modularity & Composition
- Extension Points
- API Reference

#### 4. Constraint Index
Quick lookup table of all constraints, limitations, and gotchas.

---

## Compression Strategies

### 1. Differential-Only Documentation

**Document ONLY what differs from standard:**

```javascript
// ❌ Don't document standard behavior
// RULE: if/else executes one branch based on condition

// ✅ Document ONLY the differential
// DIFFERENTIAL: if branches run in isolated scope (unlike standard JS)
if condition
  var x = 1  // Local to if block
endif
// x is undefined here (differs from JS var hoisting)
```

### 2. Eliminate All Scaffolding

**Remove:**
- Transition text: "In this section," "As we saw," "Now let's"
- Narrative connectors: "Furthermore," "However," "Additionally"
- Boilerplate code (unless boilerplate IS the rule)
- Motivational prose
- Historical context (unless it clarifies behavior)

### 3. Dense Tables Over Prose

**Any list of 3+ similar items becomes a table:**

```markdown
// ❌ Don't write as prose
The push() method adds items. The pop() method removes items.

// ✅ Use table
| Method | Effect | Example |
|:-------|:-------|:--------|
| push() | Append | `arr.push(x)` |
| pop() | Remove last | `arr.pop()` |
```

### 4. Define Once, Reference Everywhere

```javascript
// ✅ First occurrence - full explanation
// [UID-001] RULE: Operations execute in parallel by default
var a = fetch('/api/a')
var b = fetch('/api/b')  // Runs concurrently with a

// ✅ Later reference - just cite UID
// Parallel execution (see UID-001)
var posts = fetchPosts()
var users = fetchUsers()
```

### 5. Contract Templates for Interfaces

**For modularity features, show BOTH sides:**

```javascript
// [UID-MOD-001] RULE: Cross-boundary interactions must be explicit

// ✅ Provider side
// file: module-a
export function helper() { return "result" }

// ✅ Consumer side
// file: module-b
import { helper } from './module-a'
var result = helper()

// ❌ Invalid: Implicit access
var result = helper()  // Error: not declared
```

---

## Quality Assurance

### Red Flags - Auto-Fail Conditions

**Content red flags:**
- Prose explaining motivation rather than constraint
- Examples over 30 lines without atom separation
- Multiple concepts in single atom
- Rules without code demonstration
- Duplicate information across UIDs
- Standard behaviors documented as differentials

**Structure red flags:**
- Narrative transitions between atoms
- Atoms requiring prior atoms to understand
- Missing ❌ for patterns with common mistakes
- UID referenced but not defined
- Forward dependencies without UID reference

**Format red flags:**
- Long sentences in code comments
- Comments narrating code flow
- Missing differential statement (when applicable)
- No invalid example for non-trivial pattern
- Tables with redundant prose columns

### Verification Metrics

**Mathematical proof of completeness:**
```
Coverage = (Source Normatives with UIDs / Total Normatives) × 100%
Completeness = (UIDs with Atoms / Total UIDs) × 100%

Transformation VALID only if:
  Coverage = 100% AND Completeness = 100%
```

### Hallucination Prevention

**Required counter-examples for:**
- Novel operators or syntax
- Behaviors differing from standard expectations
- Common mistakes from similar languages
- Boundary conditions and limitations

**Interface contracts required for:**
- Modularity features (import, include, extend)
- Scope and visibility rules
- Shared state access
- Custom extensions

**Syntax Normalization Prohibited**

The transformation MUST NOT:
- Rewrite Python-style expressions into JavaScript syntax
- Rewrite JavaScript-style expressions into Python syntax
- Replace one conditional expression form with another
- “Improve”, “simplify”, or “modernize” syntax
- Introduce keywords, operators, control structures, or expression forms not present in the source document.

If multiple syntaxes appear equivalent, preserve the one used in the source
and mark others as INVALID if necessary.

---

## Output Format

Provide the compressed documentation with:

1. **Header section:**
   - Brief description of the technology
   - Core differentials summary (3-5 bullet points)
   - UID schema explanation

2. **Sigil/Symbol Table** (if applicable)

3. **Core Execution Model** (invariants with UIDs)

4. **Semantic Library** (all atoms, organized by category)

5. **Constraint Index** (quick reference table)

6. **API Reference** (if applicable - methods, functions, built-ins)

7. **Appendix:**
   - UID Index (complete mapping)
   - Coverage metrics
   - Verification checklist results

---

## Success Criteria

The compression succeeds when:

✅ **Mathematical Completeness**
- Coverage = 100% (all normatives → UIDs)
- Completeness = 100% (all UIDs → atoms)
- Back-reference check passes

✅ **Semantic Preservation**
- All behavioral rules represented
- All constraints encoded
- All edge cases demonstrated
- All differentials explicitly stated

✅ **Token Efficiency**
- Narrative prose eliminated
- No redundant explanations
- Maximal use of tables and structure
- Only differentials documented

✅ **AI Usability**
- Every atom independently understandable
- All patterns demonstrable via code
- Invalid usage explicitly shown
- Standard knowledge not duplicated

✅ **Quality Gates**
- No red flags detected
- All UIDs have atoms
- All normatives have UIDs
- Cross-references valid

---

## Execution Checklist

**Before transformation:**
- [ ] Identify baseline knowledge (what AI already knows)
- [ ] Create differential map (what's novel/different)
- [ ] Set up UID schema (category structure)

**Phase 1 - Extraction:**
- [ ] Extract all normative statements
- [ ] Assign UID to each
- [ ] Create Pattern Index
- [ ] Verify coverage = 100%

**Phase 2 - Deduplication:**
- [ ] Identify semantic duplicates
- [ ] Canonicalize overlapping rules
- [ ] Mark deprecated UIDs
- [ ] Verify no information lost

**Phase 3 - Encoding:**
- [ ] Transform each UID to Semantic Atom
- [ ] Verify atom format compliance
- [ ] Add ✅ valid examples
- [ ] Add ❌ invalid examples
- [ ] Add differentials (where applicable)
- [ ] Verify completeness = 100%

**Phase 4 - Assembly:**
- [ ] Organize into section structure
- [ ] Create sigil/symbol table
- [ ] Build semantic library
- [ ] Create constraint index
- [ ] Verify cross-references

**Final Verification:**
- [ ] Run back-reference check
- [ ] Check for red flags
- [ ] Verify metrics (coverage, completeness, density)
- [ ] Validate AI usability criteria

---

## Additional Instructions

**When compressing, you should:**
- Prioritize behavioral precision over readability
- Use code as the primary form of specification
- Trust that the AI can infer obvious patterns
- Be ruthless about eliminating redundancy
- Preserve every unique constraint, edge case, and limitation
- Make invalid usage as clear as valid usage

**Never:**
- Add information not in the source
- Remove edge cases or limitations
- Simplify rules that have nuance
- Create examples that weren't validated
- Document standard behaviors as differentials
- Duplicate content across atoms

---

## Expected Result

The final output should be:
- **50-80% smaller** in tokens than the original
- **100% complete** in behavioral coverage
- **Immediately usable** by AI code generators
- **Mechanically verifiable** for correctness
- **Self-documenting** through UID references
- **Hallucination-resistant** through counter-examples

The AI consuming this documentation should be able to:
- Generate correct code for any documented feature
- Recognize invalid patterns from ❌ examples
- Apply constraints without additional context
- Compose atoms into valid larger programs
- Access complete reference through UID system
- Distinguish novel behaviors from standard knowledge

---