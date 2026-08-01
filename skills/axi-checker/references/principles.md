# The 10 AXI principles, translated to instruction artifacts

Each section gives the source rule from the AXI specification, the translation to
prompts and skills, the symptoms that detect a violation, and a before/after
rewrite you can copy as the `Fix` text.

Source: `axi.md` and `github.com/kunchenguid/axi` (`principles.yaml`,
`.agents/skills/axi/SKILL.md`). AXI was written for CLI tools that agents drive
through a shell. Sections marked **by analogy** stretch the original rule; say so
when you cite them.

## Applicability by target type

| # | Principle | skill | prompt | agent-instructions |
|---|---|---|---|---|
| 1 | Token-efficient output | yes | yes | yes |
| 2 | Minimal default schemas | yes | yes | yes |
| 3 | Content truncation | yes | yes | yes |
| 4 | Pre-computed aggregates | yes | yes | yes |
| 5 | Definitive empty states | yes | yes | yes |
| 6 | Structured errors and exit codes | yes | yes | yes |
| 7 | Ambient context | yes | no | no |
| 8 | Content first | yes | yes | no |
| 9 | Contextual disclosure | yes | yes | yes |
| 10 | Consistent way to get help | yes | no | yes |

A bare prompt has no frontmatter, so principle 7 has nothing to check. An
instruction file is never "invoked", so principle 8 has nothing to check.

---

## 1. Token-efficient output

**Source.** "Use TOON as the output format on stdout. TOON provides ~40% token
savings over equivalent JSON while remaining readable by agents."

**Translation.** The artifact is the payload. A skill body loads in full every
time the skill runs; an instruction file loads in every session. Measure the
artifact's own weight, not the format of its output.

**This is not a recommendation to emit TOON.** TOON is for agent-consumed CLI
data. Recommend it only when the artifact tells an agent to produce structured
data that another program reads. Recommending TOON for human-facing output is
cargo cult.

**Symptoms.**
- A prose paragraph that a table row would carry.
- The same rule stated twice in different words, in different sections.
- A preamble that describes the artifact rather than instructing.
- Four examples of one pattern where one example suffices.

**Before**

> When you are working on this task it is important to consider that the
> codebase has a specific set of conventions that have been established over
> time, and you will want to make sure that the code you write is consistent
> with those conventions.

**After**

> Match the surrounding code: naming, comment density, import order.

41 words to 9. The instruction is unchanged.

---

## 2. Minimal default schemas

**Source.** "Every field in stdout costs tokens — multiplied by row count in
collections. Default to the smallest schema that lets the agent decide what to do
next. Default list schemas: 3-4 fields, not 10. Offer a `--fields` flag to let
agents request additional fields explicitly."

**Translation.** Two surfaces.

1. **The artifact's own default load.** Only what every run needs stays in the
   always-loaded file. Catalogs, rubrics, long examples, and rare branches move
   to `references/`. A reference file is the `--fields` flag: the agent opens it
   when the run needs it.
2. **What the artifact tells the agent to emit.** Findings and report rows carry
   3–4 fields. A 12-dimension rubric is a 12-field schema.

**Symptoms.**
- A long `SKILL.md` with no `references/` directory.
- Material that serves one run in five sitting in the always-loaded file.
- An output format with eight or more columns.

**Before**

> `SKILL.md` holds the procedure, the full 53-rule catalog, and nine worked
> examples.

**After**

> `SKILL.md` holds the procedure and a rule index.
> `references/rules.md` holds the catalog.
> `references/examples.md` holds the worked examples.

---

## 3. Content truncation

**Source.** "Never omit large fields entirely — include a truncated preview. Show
the total size so the agent knows how much it's missing. Suggest the escape hatch
(`--full`) only when content is actually truncated."

**Translation.** A pointer to a reference file is a truncated field. It needs the
same three parts: a preview of what is inside, the scale, and the condition for
opening it. A bare filename is the omission failure — the agent either opens
every reference file defensively or opens none.

The same rule governs what the artifact tells the agent to emit: cap the volume
and state what was cut.

**Symptoms.**
- "See `references/`."
- A references section listing filenames with no annotation.
- "Report all findings" with no cap and no total.

**Before**

> See `references/checklist.md` for more.

**After**

> `references/checklist.md` — 11 mechanical searches and 4 judgment checks.
> Open it in check mode or before a final audit.

**Before**

> List every violation you find.

**After**

> List the 10 most severe violations. State the total: "10 of 23 shown."

---

## 4. Pre-computed aggregates

**Source.** "The most expensive token cost is often not a longer response — it's a
follow-up call. If your backend has data that agents commonly need as a next
step, compute it and include it."

**Translation.** Every instruction that sends the agent to find out something the
author already knows is a follow-up call. State the constant. This is the
principle that most instruction artifacts break hardest, because vague guidance
reads as flexible when it is actually expensive.

The second half is **combined operations**: the AXI browser tool fuses
navigate + snapshot into one `open` command. Fuse steps that never occur apart.

**Symptoms.**
- "Follow the project conventions."
- "Determine the appropriate location."
- "Use the appropriate tool."
- "Identify the relevant files."
- Two consecutive steps where the second always follows the first.

**Before**

> ### 3. Find the design system
> Locate the project's design tokens.
>
> ### 4. Apply the tokens
> Update the component to use them.

**After**

> ### 3. Apply the design tokens from `src/styles/tokens.css`
> Replace every hard-coded color and spacing value in the component with the
> matching token.

Two steps become one, and the search disappears.

---

## 5. Definitive empty states

**Source.** "When the answer is 'nothing', say so explicitly. Ambiguous empty
output causes agents to re-run with different flags to verify. State the zero with
context. Make it clear the command succeeded — the absence of results is the
answer."

**Translation.** An agent given a finding-shaped task and no defined null output
invents findings. The implied contract of "report the violations" is that
violations exist. Without an explicit clean path, the agent satisfies the contract
with fabrication or with padding — a real defect, not a style issue, which is why
this is almost always `blocking`.

Two zeros need defining: *nothing found* and *does not apply*.

**Symptoms.**
- No "if nothing is found" branch anywhere in the artifact.
- No "not applicable" exit for an out-of-scope target.
- A report format with no zero-row rendering.

**Before**

> Report each violation with its line number and a fix.

**After**

> Report each violation with its line number and a fix.
>
> If you find no violations, report `clean: <path>` and name the checks you ran.
> Do not report a finding you cannot locate by line.

---

## 6. Structured errors and exit codes

**Source.** Four rules. "Don't error when the desired state already exists."
"Errors go to stdout in the same structured format as normal output... Include
what went wrong and an actionable suggestion." "Every operation must be
completable with flags alone... don't prompt." "Reject unknown flags and
arguments — never silently ignore them. A dropped flag is worse than an error:
the agent gets plausible-looking output it believes is scoped or filtered, then
proceeds confidently on wrong data."

**Translation.** Four sub-checks.

### 6a. Idempotence

A second run produces the same result, not duplicates. Check every instruction
that writes.

**Before:** Append your findings to `REVIEW.md`.
**After:** Write your findings to `REVIEW.md`. Replace the file if it exists.

### 6b. Structured failure

Define the failure output, and make it the same shape as the success output.

**Before:** If the build fails, let the user know.
**After:** If the build fails, report `error: <first failing command>` and the
last 20 lines of its output. Then stop.

### 6c. No interactive prompts

Every mid-run question costs a turn and stalls an unattended run. Reserve
questions for choices that are genuinely the user's and that have no safe
default.

**Before:** Ask the user whether to include tests.
**After:** Include tests. If the user said to skip them, skip them.

### 6d. Fail loud on out-of-scope input

This is the sharpest translation in the set. The CLI failure is an agent that
invents a flag, gets unfiltered output, and trusts it as filtered. The prompt
failure is identical: an artifact pointed at something it was not written for
produces confident, plausible, wrong output. "Do your best" is the silent-ignore
bug.

**Before:** If the file is not a component, do your best.
**After:** If the target is not a React component, report `out of scope: <path>`
and stop.

---

## 7. Ambient context

*Applies to skills only.*

**Source.** "Register your tool into the agent's session lifecycle so every
conversation starts with relevant state already visible." And for the skill
variant: "Trigger-shaped frontmatter: include `name` and a `description` written
as a trigger — terse and outcome-focused so the agent loads it on the right
intent."

**Translation.** A skill has the same two tiers the AXI spec describes. The
`description` is the ambient tier: it sits in the session's skill listing whether
or not the skill runs, so it is the part that must be cheap and must match. The
body is the on-demand tier.

A description that describes implementation never matches a user's phrasing, so
the skill never loads and the body's quality is irrelevant. Check the description
first.

Rules: outcome first, then the literal phrases a user says, then the scope limit
if one exists. Keep it under roughly 500 characters.

**Symptoms.**
- A description with no user phrasing in it.
- A description written in third person about the skill.
- A body whose first paragraph restates the description.

**Before**

> `description: Analyzes component trees and produces styling recommendations.`

**After**

> `description: Audit a React component tree against the design system and
> recommend Tailwind corrections. Use when the user says "align to design
> system", "design system audit", "check design tokens", or "fix styling to match
> the design system".`

---

## 8. Content first

*Applies to skills and prompts.*

**Source.** "Running your CLI with no arguments should show the most relevant live
content — not a usage manual. When an agent sees actual state it can act
immediately. When it sees help text, it has to make a second call."

**Translation.** The first screen is the operative instruction. An opening
paragraph that introduces the artifact is help text where content belongs, and it
loads on every run.

The no-arguments half maps directly: invoked with no target, infer the target from
context and act. A first step that asks the user what to work on is the second
call the principle exists to remove.

**Symptoms.**
- An opening sentence of the form "This skill helps you to…".
- A first step that asks the user for something derivable from context.

**Before**

> # form-modernizer
>
> This skill is designed to help you modernize forms in your application. It uses
> a multi-phase approach covering analysis, redesign, typing, and verification.
>
> ## Step 1 — Ask the user which form to modernize

**After**

> # form-modernizer
>
> Modernize the form at `$1`. If `$1` is empty, use the form file under
> discussion.
>
> ## Step 1 — Read the form and list its fields

---

## 9. Contextual disclosure

**Source.** "Include a few next steps that follow logically from the current
output." Plus: "every suggestion is a complete command"; "use placeholders like
`<id>` instead of guessing a concrete value that may mislead the agent"; "when the
output fully answers the query, suggestions are noise — leave them out"; "on
errors, suggest the specific command that fixes the problem, not 'see `--help`'".

**Translation.** Two levels.

- **Between steps.** Each step names what the next step consumes. A step that
  ends without saying what it produced forces the agent to re-read.
- **At the end.** The artifact's final output names next actions as concrete
  commands with placeholders.

Honor the omit rule. A skill that answers one question does not need a next-steps
block, and adding one is noise.

**Symptoms.**
- A report format that ends at the finding list.
- A guessed concrete path or ID where a placeholder belongs.
- "See the documentation" as an error recovery step.

**Before**

> Present the findings to the user.

**After**

> Present the findings, then close with:
>
> ```
> Next:
> - Apply the blocking findings — say the word and I will edit <path>.
> - Re-run after edits: /axi-checker <path>
> ```

---

## 10. Consistent way to get help

*Applies to skills and instruction files.*

**Source.** "Every subcommand should support `--help` with a concise, complete
reference... Keep it focused on the requested subcommand — don't dump the entire
CLI's manual."

**Translation.** One predictable place per topic, and one line saying when to go
there. The `--help` equivalent is the annotated references section. Its job is
routing, not content: it tells the agent which file answers which question so the
agent opens one file instead of three.

A rule explained in three sections is the "dump the entire manual" failure. It
costs tokens on every run and the three copies drift.

**Symptoms.**
- The same rule explained in more than one section.
- A references section that is missing, or that lists bare filenames.
- Detail that belongs in one place scattered across the body.

**Before**

> ## References
> - `references/principles.md`
> - `references/examples.md`

**After**

> ## References
> - `references/principles.md` — the 10 principles with source quotes and fix
>   patterns. Open it when a finding needs justification.
> - `references/examples.md` — three audited artifacts with their reports. Open
>   it when the report format is unclear.

---

## Overlap with simple-english

Several STE rules serve AXI principles directly. Attribute each finding to one
pass so you do not report it twice.

| STE rule | AXI principle it serves | Owning pass |
|---|---|---|
| Slop substitutions, "omit needless words" | 1 — token weight | language |
| One instruction per sentence (5.2) | 6 — half-followed compound instructions | language |
| Condition before command (5.4) | 6 — dropped trailing conditions | language |
| No "should" (3.2, modal ladder) | 6 — a model reads "should" as optional | language |
| One word one meaning (1.11, 9.4) | 4 — synonym rotation reads as distinct operations | language |

If the fix changes the shape of a sentence, it is a language finding. If the fix
changes what the artifact does or does not specify, it is a structural finding.
