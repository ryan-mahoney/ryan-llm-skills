# The Rules Document: Phase 6

Full specification for the final deliverable. Read before writing.

## Contents

- [Who it is for](#who-it-is-for)
- [Required section order](#required-section-order)
- [Writing rules](#writing-rules)
- [Severity vocabulary](#severity-vocabulary)
- [Plain English discipline](#plain-english-discipline)
- [AXI structure](#axi-structure)
- [Reconciling plain English with AXI](#reconciling-plain-english-with-axi)
- [Design sections and code examples](#design-sections-and-code-examples)
- [Conformance checks](#conformance-checks)
- [Verification](#verification)

---

## Who it is for

The report is for a human deciding what to believe. The rules file is for an agent or a team executing.

That difference drives every constraint below. In particular:

**No expert names. No citations. No references. No hedging.** The authority has been absorbed in Phase 5. A rules file that says "according to one researcher" invites the reader to relitigate, which is exactly what the report was for. The rules stand on their own or they are not rules.

---

## Required section order

1. **Title and one-line purpose**
2. **About this document** — scope, what it does not cover, the writing standard used
3. **Aggregates block** — total rule count, counts by severity, counts by group
4. **Terms** — one term, one meaning; every word the document uses for a repeated idea
5. **The one idea** — the single insight everything else supports, in a few short paragraphs
6. **Decide first** — the three to six decisions that determine everything downstream, as a table of question and consequence
7. **Rules** — grouped, each with a stable ID and a severity
8. **Design sections** — worked examples with code, only where a rule needs showing rather than stating
9. **Conformance checks** — pass or fail tests mapped to rule IDs
10. **Lookup** — common questions mapped to rule IDs
11. **Notes** — override policy, ID stability, the most common misdiagnosis

Sections 5 and 6 are what make it usable rather than a checklist. "The one idea" gives the reader a way to reason about cases the rules do not cover. "Decide first" front-loads the decisions that change which rules apply.

---

## Writing rules

**One instruction per rule.** If a rule contains "and" joining two actions, split it.

**Imperative mood.** "Show a count next to every filter value." Not "counts should be shown."

**Twenty words maximum.** Rules are procedural text.

**Testable.** A reader must be able to say whether a build complies without arguing. "Make the gap between sections at least twice the gap between groups" is testable; "use space thoughtfully" is not.

**Stable IDs.** One letter for the group, one or two digits. `G3`, `X11`. These get used in tickets and code comments, so they must not be renumbered when the document is edited — append rather than insert.

**Numbers wherever a source gave one.** The most valuable thing carried over from the research is a threshold. Rules with numbers get followed; rules with adjectives get debated.

**Point to a design section when a rule needs showing.** `See detail F16 below.` Keeps the rule short without losing the explanation.

---

## Severity vocabulary

Exactly three levels. More becomes unenforceable; fewer loses the distinction between a requirement and a default.

| Severity | Meaning |
|---|---|
| **MUST** | Required. A build that omits this is incomplete. |
| **NEVER** | Prohibited. There is no exception. |
| **DEFAULT** | Do this unless you write down a reason not to. |

MUST and NEVER come from Phase 5 consensus. DEFAULT is where a disagreement resolved to "depends on a variable" — the default is the common case and the override is documented.

Include the severity table in the document. A reader must not have to guess whether DEFAULT is negotiable.

---

## Plain English discipline

Apply the Simplified Technical English rules. If a Simplified Technical English skill is available in the environment, read it and follow it. The essentials:

**Sentence length.** Descriptive text 25 words maximum. Procedural text (rules, checks) 20 words maximum.

**One word, one meaning.** Choose a single verb for each idea and never vary it. Standard choices: `show` for display and render and present; `make sure that` for check and verify and confirm; `remove` for delete and clear. Declare these in the Terms section.

**No hedging modals.** Only `can`, `will`, and `must`. Every `should` becomes `must` (for a requirement) or a plain statement of fact (for a recommendation). Every `may`, `might`, and `could` becomes `can` or gets restructured.

**Active voice, simple tenses.** No present perfect. No `-ing` forms used as verbs.

**Condition before instruction.** "If a value returns zero rows, disable the value." Not the reverse — a reader acting on the first half of a sentence must not have to undo it.

**No semicolons. No contractions. Keep `that` after verbs** like `make sure` and `show`.

**Vertical lists for anything complex.** A sentence enumerating more than three things becomes a list. This is usually the fix for an over-length sentence.

**Delete filler.** `genuinely`, `actually`, `it is worth noting`, `robust`, `comprehensive`, `leverage`, `in order to`, `e.g.`, `i.e.`, `etc.` If a word carries no fact, cut it rather than replacing it.

**Untouchable:** proper nouns, product names, quoted interface labels, code, URLs, and numbers with units. Do not simplify these.

---

## AXI structure

The document is read by agents as often as by people. Structure it accordingly.

**Content first.** No preamble, no table of contents, no history. The aggregates block and the rules appear at the top. An agent reading only the first screen should know the full scope.

**Pre-computed aggregates.** State the totals so nothing has to be derived by counting: total rules, counts by severity, counts by group. Verify these with a script — a wrong count at the top destroys trust in everything below it.

**Minimal fields.** Three per rule: ID, severity, rule text. Anything needing more goes to a design section keyed by ID.

**Compact blocks over prose.** For the rule index and conformance checks, use tables or comma-delimited rows rather than paragraphs. If using comma-delimited rows, write rule text without internal commas so the format stays unambiguous.

**Definitive empty states.** State the cases where a rule does not apply rather than staying silent. Silence reads as an omission.

**Contextual next steps.** After each major section, say what to read next.

**Consistent lookup.** A single index mapping common questions to rule IDs.

---

## Reconciling plain English with AXI

The two standards pull against each other in three places. Resolve them this way.

**Compactness against readability.** AXI wants dense machine-readable blocks; plain English wants clear sentences. Resolution: rules and checks go in compact tables or delimited rows; explanatory sections use full sentences under the length limits.

**No hedging against honest uncertainty.** Plain English forbids `might` and `could`, which removes the normal way to express a weakly-held position. Resolution: state uncertainty as a fact in its own sentence. "No large study covers this case." Not "this might not apply."

**Brevity against completeness.** Resolution: the rule stays under twenty words and points to a design section for the reasoning. Never pad a rule to carry an explanation.

---

## Design sections and code examples

Include a worked example only where a rule needs **showing** rather than stating. A rule that is complete as written does not get a design section.

Good candidates:

- A ratio or a scale, where the relationship matters more than the values
- A correct-versus-wrong pair, where the contrast teaches faster than either alone
- Anything with an accessibility dimension — markup carries meaning that prose cannot
- A test the reader can run immediately
- A decision table keyed to a variable, coming out of a Phase 5 resolution

Write examples in the technology the person actually uses. For web work that means modern, accessible, responsive code: custom properties for tokens, logical properties, container queries where a component should respond to its own size, `clamp()` for fluid type, and a `prefers-reduced-motion` guard on anything animated. Include the accessible markup, not only the styling — `aria-labelledby`, `aria-current`, real heading levels, text alternatives for anything carried by color.

Comment the examples to say which rule they demonstrate and why.

Keep code blocks exact. They are exempt from the plain English rules.

---

## Conformance checks

The section that converts opinion into test. Each check has four parts:

| Part | Content |
|---|---|
| **ID** | Stable, for reference in reviews |
| **Rules** | Which rule IDs it verifies |
| **Check** | The observation to make, as an instruction |
| **Fails when** | The specific condition constituting failure |

**Give check IDs a prefix that no rule group uses.** If a rule group is `C`, do not number checks `C1`, `C2`. A reviewer reading `C3` in a ticket cannot tell which document section is meant, and the verification script will flag the collision.

Fifteen to twenty checks is typical. Every check must be runnable by someone who has not read the report — no judgment calls, no "looks wrong."

Prefer checks that are cheap and physical: measure this, count that, blur the screen, run it in grayscale, load it with the longest real record, view it at the smallest supported size. A check someone will actually perform beats a rigorous one they will not.

---

## Verification

Run `scripts/verify_rules_doc.py` on the finished file. It checks:

- Stated total matches the actual rule count
- Stated severity counts match
- Stated per-group counts match
- Every referenced rule ID is defined
- No sentence exceeds its length limit (code blocks excluded)
- No banned modals, semicolons, or contractions in prose
- Every rule ID is unique

Fix every finding, then re-run until clean. Do not count by eye — in practice the manual count is wrong more often than it is right, and a document that fails its own first check is worthless as a standard.
