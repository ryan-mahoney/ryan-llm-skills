---
name: axi-checker
description: Review a prompt, skill, or agent instruction file against the 10 AXI (Agent eXperience Interface) principles and recommend specific structural and content changes. Use when the user says "AXI check", "check this prompt", "review this skill", "is this SKILL.md any good", "make this prompt agent-ergonomic", "audit my agent instructions", "why does my agent ignore this", or asks whether an instruction file is well structured for an agent to follow. Reports findings as a table of principle, severity, location, and fix. It recommends changes. It does not apply them.
argument-hint: "[path to a prompt, SKILL.md, or AGENTS.md — or pasted instruction text]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
  framework: AXI 10 principles — axi.md, github.com/kunchenguid/axi
---

# axi-checker — Audit an Instruction Artifact Against AXI

Audit the target against the 10 AXI principles. Report findings as a table. Recommend changes; do not apply them.

AXI is 10 design principles for CLI tools that agents drive through a shell. This skill applies the same 10 principles to instruction artifacts: prompts, skills, and agent instruction files. The translation for each principle is in `references/principles.md`.

## Step 1 — Resolve and classify the target

| Input | Action |
|---|---|
| A path | Read the file. For a skill directory, read `SKILL.md` and list `references/`. |
| Pasted text | Audit the text as given. |
| No argument | Use the artifact under discussion. In a skill directory, use its `SKILL.md`. |

If you cannot identify exactly one target, name what you found and stop. Do not audit a guess.

Classify the target, then apply the principles marked for its type:

| Type | What it is | Principles |
|---|---|---|
| `skill` | `SKILL.md`, with or without `references/` | 1–10 |
| `prompt` | A system prompt or a single-shot task prompt | 1–6, 8, 9 |
| `agent-instructions` | `AGENTS.md`, `CLAUDE.md`, a rules file | 1–6, 9, 10 |

Two targets are out of scope. Refuse them by name and stop:

- **A CLI tool.** AXI applies literally. Point the user at `github.com/kunchenguid/axi` or `npx skills add kunchenguid/axi`.
- **Human-facing prose.** AXI does not apply. Offer the sibling `simple-english` skill instead.

## Step 2 — Structural pass

Check the target against each applicable principle. `references/principles.md` carries the source rule, the full translation, and a before/after rewrite for each one.

| # | AXI principle | What it means for an instruction artifact | Symptom |
|---|---|---|---|
| 1 | Token-efficient output | The artifact's own weight. Every line loads into context on every invocation. | A prose paragraph a table would carry. The same rule stated twice in different words. A preamble about what the artifact is. |
| 2 | Minimal default schemas | Only what every run needs stays in the always-loaded file. Catalogs, rubrics, and long examples move to `references/`. Emitted findings carry 3–4 fields, not 10. | A long `SKILL.md` with no `references/`. A rubric with 12 scored dimensions. |
| 3 | Content truncation | A pointer to deep material carries one line on what is inside and when to open it. Output instructions cap volume and state what was cut. | "See `references/`." "Report all findings." A bare filename with no description. |
| 4 | Pre-computed aggregates | State the constant instead of making the agent derive it: exact paths, exact commands, the decision table, the naming rule. Fuse steps that always run together. | "Follow the project conventions." "Determine the appropriate location." Two steps that never occur apart. |
| 5 | Definitive empty states | Define the zero result. An agent given a finding-shaped task and no defined null output invents findings to fill it. | No "if nothing is found" branch. No "not applicable" exit. |
| 6 | Structured errors and exit codes | A second run produces the same result, not duplicates. Unmet preconditions stop the run. Out-of-scope input is refused, not guessed at. A mid-run question costs a turn. | No precondition check. "Ask the user which approach they prefer" for a choice with an obvious default. An instruction to append to a file that a second run would double. |
| 7 | Ambient context | `description` is the always-loaded tier and must be trigger-shaped: outcome first, then the literal phrases a user says. The body is the on-demand tier. | A description that describes implementation. No trigger phrases. A body that repeats the description. |
| 8 | Content first | The first screen is the operative instruction. With no argument, infer the target and act. | An opening paragraph that introduces the artifact. A first step that asks the user what to work on. |
| 9 | Contextual disclosure | Each step names what the next step consumes. The final output names next actions as concrete commands with `<placeholders>`. | A report that ends at the finding list. A guessed concrete value where a placeholder belongs. |
| 10 | Consistent way to get help | One predictable place per topic. Reference files listed once, each with one line on when to open it. | The same rule explained in three sections. A references section that is missing or unannotated. |

Principle 5 is the highest-value check in the set. Run it on every target.

Principle 1 for an instruction artifact is **not** "emit TOON". TOON is an output format for agent-consumed CLI data. Recommend TOON only when the artifact tells an agent to produce structured data that another program reads.

## Step 3 — Language pass

Instruction artifacts are procedures written for a reader that cannot ask questions. Run the sibling `simple-english` skill over the target in procedural mode. Four of its rules carry most of the weight here:

| Rule | Why it matters to an agent |
|---|---|
| One instruction per sentence | A compound sentence gets half-followed. |
| Condition before the command | A trailing condition gets dropped. |
| No "should" | A model reads "should" as optional. Write "must", or delete the line. |
| One word, one meaning | "check", "verify", and "validate" read as three different operations. |

Cite STE rule numbers only from `simple-english/SKILL.md`. Do not cite them from memory; the numbering is unintuitive and invented numbers are common.

Do not double-report. If the fix changes the shape of a sentence, it is a language finding. If the fix changes what the artifact does or does not specify, it is a structural finding.

## Step 4 — Report

Open with the header, then the table. Order blocking findings first.

```
axi-check: <path>
type: skill | prompt | agent-instructions
findings: 7 (3 blocking, 4 costly)
```

| # | Principle | Severity | Location | Fix |
|---|---|---|---|---|

| Severity | Meaning |
|---|---|
| `blocking` | The agent produces wrong, fabricated, or silently incomplete output. |
| `costly` | The agent succeeds, but spends turns or tokens it did not need to. |

Each `Fix` is replacement text or a concrete edit. "Add an empty-state branch" is not a fix. This is a fix:

> Add after the reporting instruction: "If you find no violations, report `clean: <path>` and name the checks you ran. Do not report a finding you cannot locate by line."

`Location` is a line number or a section heading. Drop any finding you cannot anchor to one.

Close with next steps. Use placeholders, not guessed values:

```
Next:
- Apply the blocking findings — say the word and I will edit <path>.
- Re-run after edits: /axi-checker <path>
- Language pass only: /simple-english <path>
```

## When the target is clean

Report exactly this, then name the two or three principles you checked most closely:

```
axi-check: <path>
type: <type>
findings: 0
```

Do not manufacture a finding to fill the table.

## Limits

AXI governs the interface, not the substance. This skill does not judge whether the procedure is the right procedure, whether the domain content is correct, or whether the artifact is safe. It judges whether an agent can execute it cheaply and without guessing.

Where a principle translates by analogy rather than directly, `references/principles.md` says so.

## References

- `references/principles.md` — per principle: the AXI source rule quoted, the translation to instruction artifacts, detection symptoms, and a before/after rewrite. Open it when a finding needs justification or when you need the fix pattern.
- Sibling skill `simple-english` — the sentence-level pass in Step 3. Its `references/use-cases.md` has a section on instructions for AI agents.
