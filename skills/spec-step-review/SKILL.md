---
name: spec-step-review
description: This skill should be used when the user or an external task-runner asks to review, code-review, or correctness-check a single already-implemented spec step for bugs — given only a step marker (spec path plus step). The read-only correctness counterpart to spec-step-judge: it hunts for logic, security, and over-complexity defects in that step's committed diff and writes a structured findings file at reviews/<step>-review.md. It never edits code and never re-checks conformance (that is spec-step-judge / spec-audit). Self-sufficient by design — resolves the step's commit, subspec, learning, criteria, and invariants deterministically from the spec directory. spec-step-fix consumes its output. Trigger on "review this step", "code-review the step", "correctness review the step", "find bugs in this step", or "spec step review".
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "spec=<path/to/spec.md> step=<number-or-exact-step>"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "4"
---

# Spec Step Review

Review exactly one already-implemented step for **correctness** defects and write
the findings to a file. This is the read-only half of the per-step *correctness*
loop: it produces `reviews/<step-number>-review.md`; its partner `spec-step-fix`
reads that file and decides what to fix. This skill never edits code.

Correctness is not conformance. `spec-step-judge` already checked that the step
matches its intent and stays green, and `spec-audit` checks the branch against
`criteria.md`. This skill is the orthogonal gate the project otherwise outsourced
to an external reviewer: does this step's code have **bugs** — logic errors,
security holes, resource leaks, or needless complexity — regardless of whether it
conforms. A step can conform perfectly and still be wrong.

## Operating Context

This is the correctness-review stage of an externally-orchestrated per-step
pipeline. The intended order is:

```txt
spec-step-run → spec-step-judge → spec-step-review → spec-step-fix
(implement)     (conformance)      (this skill)       (apply fixes)
```

The external review orchestrator schedules this skill after each step's commit.
Nothing carries state between stages except files, so this skill is self-contained:
it reconstructs everything it needs from the spec directory and emits one durable
artifact — the review file — that `spec-step-fix` consumes.

Single pass: review once, write the file, stop. There is no per-step re-review
loop; the end-of-run `spec-branch-refine` loop is the thorough backstop.

## Run Directly — No Subagents

Do this skill's work directly in your own context. Do **not** spawn subagents,
fan out parallel agents, or delegate the run to another agent. This is a leaf
skill: the external task-runner already dispatches it in isolation, one step at a
time, so a nested agent adds no isolation — only the failure modes of delegation
(needless fan-out, or a child whose completion goes unnoticed). The reviewer is
already independent of the fixer — `spec-step-fix` is a separate skill invocation
in its own context — so no in-skill agent is needed to keep them apart. (Invoking
a conditional-lens skill below is an in-context skill call, not a subagent, and
stays allowed.)

## Non-Interactive Operation

This skill runs to completion without user interaction. Do not pause to ask
clarifying questions or wait for input. When something is unclear, make a
reasonable, well-grounded decision from the step text, the diff, and the
repository, then proceed. Stop only when a required input is genuinely missing and
cannot be inferred; report what is missing and halt.

## Required Inputs

This skill takes one thing: a **step marker**. Everything else is derived. Stop
before reviewing if either part of the marker is missing or unreadable:

1. `spec`: path to the local `spec.md`.
2. `step`: the exact step number, stable step id, or full step text to review.

Do not expect the caller to pass anything else. Resolve every related artifact
yourself from the spec directory (`<spec-dir>` = the folder containing `spec.md`):

- `subspec`:    `<spec-dir>/subspecs/<step-number>-spec.md`
- `learning`:   `<spec-dir>/learnings/<step-number>-learning.md`
- `criteria`:   `<spec-dir>/criteria.md`
- `invariants`: `<spec-dir>/invariants.md`
- `blockers`:   `<spec-dir>/blockers.md`
- prior fixes:  `<spec-dir>/reviews/step-<step-number>-fix.md` (if a previous pass exists)

Treat a missing sibling artifact as non-blocking absence, not an error. Never
block waiting for a path the caller did not give you.

## Resolve The Step And Its Diff

Read the full local spec and isolate its Implementation Steps section. Locate the
single requested step by number/id first, then by exact text match. If multiple
steps match, stop and ask for a unique identifier. If none match, stop and report
the missing step.

Find the commit that implemented it, using the same logic as `spec-step-judge`:
the commit that adds the step's `learnings/<n>-learning.md` (`git log --oneline --
<learning-path>`); fall back to the most recent commit touching the step's named
files. Read the diff with `git show <commit>`. Review **only that diff** — the code
this step changed — not the whole tree.

If neither a learning file nor a step-scoped commit can be found, review the
working-tree diff for the step's named files instead, and note the weaker target
in the review.

## Load Spec-Aware Context (for judgement, not conformance)

Read these to review *as the spec intended*, not to re-run conformance checks:

- The resolved step text and its `Covers:` tags.
- The step's `subspec` — the intended edit sequence. A diff that deviates from the
  subspec is a signal, not automatically a defect; the subspec tells you what was
  meant so you can tell a deliberate adaptation from a mistake.
- The step's `learning` — what the implementer discovered. Use it to avoid
  flagging a known, recorded trade-off as a bug.
- `criteria.md` / `invariants.md` are background only. Do **not** turn their
  `Check:` commands or grep patterns into findings — conformance is owned by
  `spec-audit` and `spec-step-judge`. Reading them only helps you avoid
  contradicting an intentional ownership/placement decision.

## Review For Correctness

Review the step's diff directly. The reviewer's independence from the fixer is
structural — `spec-step-fix` runs as a separate skill — so no subagent is needed
for it.

Apply three lenses to the step's diff. These are bug classes, not style nits:

1. **Correctness / logic.** Off-by-one and boundary errors; null/undefined and
   empty-collection assumptions; wrong operator or condition; unhandled error and
   rejection paths; swallowed errors; race conditions and ordering assumptions;
   resource leaks (unclosed handles, timers, listeners); incorrect async/await;
   data-integrity gaps (non-atomic read-modify-write, missing idempotency where it
   matters).
2. **Security.** Injection (SQL/command/path/template/XSS/SSRF); missing input
   validation on trust boundaries; authz/ownership gaps; secrets in code; unsafe
   deserialization; weak crypto or randomness for security purposes. Flag only what
   this diff introduces or directly exposes.
3. **Simplification / maintainability.** Abstractions that don't earn their keep,
   dead or duplicated code, needless indirection, clever code that sacrifices
   clarity. These are almost always advisory (see severity).

Skip pure formatting and naming nits a linter would catch. Prefer a few real
findings over a long list. If the diff is clean, say so — an empty findings list
with verdict `pass` is the common, good outcome.

**Conditional lens (only when this step's diff fires a risk trigger).** A single
step is usually pure correctness, but when its diff clearly touches a high-risk
area, add the matching focused lens — and delegate to an existing skill when one is
available, else run an inline check:

- **Deep security** — auth, crypto, secrets, sessions, tokens, permissions:
  delegate to `security-review` when available.
- **Design / UX** — UI/component/style files or design rules in scope: delegate to
  `design-align` or `ux-auditor` when available.
- **Performance** — hot paths, large-collection loops, or DB/network access in the
  step: inline check for N+1, blocking async, and unbounded work.

Keep this proportionate: the thorough, full risk fan-out is `spec-branch-review`'s
job at end of run; here it only catches an obvious high-risk step early. Record any
lens that fired in the `lenses:` field.

## Severity And Actionability

Tag every finding:

- **Severity:** `HIGH` | `MED` | `LOW`.
- **Category:** `correctness` | `security` | `perf` | `simplification` | `design`.
- **Actionable** when it is `HIGH` or `MED` and in `correctness` or `security`.
  Everything else — all `LOW`, and all `simplification`/`design` regardless of
  severity — is **advisory**: recorded for the human, never required to fix. This
  split is the contract `spec-step-fix` and the branch loop rely on; keep it
  strict so downstream automation converges.

**Verdict** is `needs-fix` if any actionable finding exists, otherwise `pass`.

Give each finding a **stable signature** `category:file:symbol:gist`, where `symbol`
is the nearest stable anchor (enclosing function, method, class, or exported name; a
heading anchor for non-code) and `gist` is the 3–6 word essence. The line number is
**not** part of identity — it churns when nearby code moves — so keep it as a
separate `line` field for display only. Downstream skills dedupe on the signature,
so make it deterministic: the same defect must produce the same signature on
re-review.

## Emit The Review File

Write the findings to:

```txt
<spec-dir>/reviews/step-<step-number>-review.md
```

Use `reviews/step-<short-slug>-review.md` for a step with no numeric id. Create the
`reviews/` folder if it does not exist. Overwrite an existing file for the same
step (a re-review supersedes its predecessor).

The file leads with a fenced YAML block — the machine-readable contract that
`spec-step-fix` parses — followed by prose that only explains the findings.
Downstream reads the YAML first; the prose is never parsed for control flow. Keep it
terse; `None`/`findings: []` for an empty list:

````txt
# Step Review — step <step-number> (<feature-slug>)

```yaml
review:
  kind: step
  step: <step-number>
  spec: <spec-dir>/spec.md
  target: <commit-sha or "working-tree">
  verdict: pass | needs-fix
  actionable: <count>
  advisory: <count>
  lenses: [correctness, security, simplification]   # plus any fired conditional lens
  findings:
    - id: F1
      severity: HIGH
      category: correctness
      actionable: true
      file: src/foo.ts
      line: 42
      symbol: loopBound
      signature: correctness:src/foo.ts:loopBound:off-by-one in loop bound
    - id: F2
      severity: LOW
      category: simplification
      actionable: false
      file: src/bar.ts
      line: 10
      symbol: wrap
      signature: simplification:src/bar.ts:wrap:redundant wrapper
```

## Findings

### F1 · HIGH · correctness · src/foo.ts:loopBound (L42) · [actionable]
What: <one line>
Why:  <one line — the concrete failure, not a vibe>
Fix:  <concrete suggested change>

### F2 · LOW · simplification · src/bar.ts:wrap (L10) · [advisory]
What: ...
Why:  ...
Fix:  ...

Review: <spec-dir>/reviews/step-<step-number>-review.md (step <step-number>)
````

A clean step stays minimal: `verdict: pass`, `actionable: 0`, empty `findings: []`,
`## Findings\nNone`, and the locator line.

## Completion Report

Report:

1. Spec path and resolved step.
2. Review file path.
3. Verdict (`pass` | `needs-fix`) and the actionable/advisory counts.
4. The target reviewed (commit sha or working tree).
5. Any input that was missing or any weak-target caveat.

Do not implement fixes — that is `spec-step-fix`. Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
