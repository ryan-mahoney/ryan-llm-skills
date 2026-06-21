---
name: spec-audit
description: This skill should be used when the user asks to "audit the implementation against the spec", "run the spec audit", "check spec conformance", "verify the branch against the criteria", or "spec audit". Executes the frozen conformance checklist from .specs/<slug>/criteria.md against the implementation diff and reports PASS/VIOLATION/UNVERIFIABLE per criterion with file:line evidence. Report-only; never edits production code.
mode: coding
scope: document
capability: shell
disable-model-invocation: true
argument-hint: "[feature-slug, spec path, or GitHub issue number]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "5"
---

# Spec Audit

> **`.specs/` is untracked working state — often gitignored.** Read and write spec files directly on the filesystem; do not run `git diff`/`log`/`status`/`show` on paths under `.specs/` to read, compare, or recover them — git returning nothing there is expected, not an error. This is scoped to `.specs/`; diffing the code under review is unaffected. For moves, use `git mv` only when the path is tracked, otherwise `mv`.

Execute a compiled conformance checklist against an implementation. This skill answers "is it the thing the spec described", not "is it correct" — correctness review (roborev, generic code review) is a separate, orthogonal gate. A criterion can be violated while every test passes; most criteria exist precisely because tests cannot see them. "All tests pass" is never exculpatory evidence here.

Run this at the end of a branch, after correctness review. Re-running after fixes is cheap because the criteria are frozen.

## Non-Interactive Operation

This skill runs to completion without user interaction. Do not pause to ask clarifying questions, request confirmation, or wait for input mid-run. When something is unclear or underspecified, make a reasonable, well-grounded decision from the available context — the criteria checklist, the diff, the spec's intent, and the repository — then proceed. Summarize every such judgement call and its rationale in the final report so the user can review what was decided and why.

Stop only when a required input is genuinely missing and cannot be inferred (for example, no compiled checklist to execute). In that case, report what is missing and which prerequisite skill must run first, then halt — do not ask for it interactively.

## Resolve the Spec and Criteria

Resolve the spec target in this order:

1. If `$ARGUMENTS` is a path to a markdown file, use that file.
2. If `$ARGUMENTS` names a folder under `.specs/`, use `.specs/<feature-slug>/spec.md`.
3. If `$ARGUMENTS` is a GitHub issue number and the current repository is hosted on GitHub, read the issue with `gh issue view <issue-number> --json body --jq .body`, extract its `Spec folder: .specs/<feature-slug>/` footer, and use the local `.specs/<feature-slug>/spec.md`. If the local file is missing but the issue body has a valid footer, create the folder and write the issue body to `spec.md`.
4. If no argument is provided, use the most recently modified `.specs/*/spec.md`.

Then locate the checklist: `.specs/<feature-slug>/criteria.md`. Each phase runs in its own worktree with its own copy of the spec folder, so there is exactly one checklist per worktree — phase is a content label only, never a file path, and needs no phase-qualified name or subdirectory.

**If no checklist exists, stop** and instruct the user to run `spec-criteria` first. Do not derive criteria inline from the spec: compiling criteria while reading the implementation defeats the epistemic firewall the checklist exists to provide — an auditor that interprets the spec and judges the code in the same pass will harmonize them.

Also load `.specs/<feature-slug>/invariants.md` in full when it exists — every entry from every phase, not just the current one.

## Determine the Audit Scope

- Default: the current branch's diff against its merge base with the default branch (`git diff $(git merge-base <default-branch> HEAD)...HEAD`), plus the changed-file list.
- If `$ARGUMENTS` includes a PR number or commit range, audit that instead (`gh pr diff <number>` or the given range).

The diff defines what this branch is accountable for. Checks read whole files where the criterion demands it, but every finding must cite code this branch introduced or changed; pre-existing violations of a criterion are reported separately as `pre-existing`, not charged to the branch.

## Execute the Checks

Work through every criterion block in the checklist, by mode:

- **G — Greppable tripwire.** Run the compiled command verbatim. Compare actual hits against the expected hit set. Hits outside the expected set are a VIOLATION; cite each `file:line`. Do not reinterpret the expectation — if the compiled expectation seems wrong, that is an UNVERIFIABLE with a note, not a silent adjustment.
- **D — Precedent-diff.** Read the precedent block at its stated location and the corresponding new code. Enumerate every observable divergence between them — structure, status codes, envelopes, validation placement, helper usage, ordering. Match each divergence against the licensed-delta list: listed → record as conforming evidence; unlisted → VIOLATION quoting the divergence. If the precedent has moved or changed since the criteria baseline so the comparison cannot be made faithfully, mark UNVERIFIABLE and say why.
- **S — Structural judgment.** Read the named files in full with the compiled question in hand. These are absence and placement claims: answer yes/no and cite the evidence either way — for absence claims, state what was searched for and not found. When the harness supports subagents, fan out one subagent per S criterion, each given only the criterion block and the file list, and collect verdicts.
- **Ledger invariants.** Execute the suggested check for every `invariants.md` entry not marked superseded, including invariants established by earlier phases. A current-phase change that violates an earlier phase's invariant is a finding of the current phase — phase boundaries are where ownership violations happen.

Verdict vocabulary, per criterion:

- `PASS` — check executed, expectation met; record the evidence, not just the verdict.
- `VIOLATION` — check executed, expectation not met; `file:line` evidence required.
- `UNVERIFIABLE` — the check could not be executed as compiled (precedent moved, file renamed, command matches nothing it should, question ambiguous). Never silently skip or guess: UNVERIFIABLE items are criteria-quality feedback to route back to `spec-criteria`.

Do not soften verdicts. A behaviorally-silent violation — same observable behavior, wrong placement, duplicated rule, unlicensed divergence — is still a VIOLATION. Equivalence of behavior is not conformance.

## Report

Write the audit report to `.specs/<feature-slug>/audit.md`, overwriting any previous run. One worktree holds one audit report, so the name is fixed — no phase-qualified name or subdirectory.

Begin `audit.md` with the front-matter block below as the first bytes of the file — before the human-readable report. No leading blank line, no leading heading, no front-matter anywhere else in the file. The block is the machine-readable signal the in-app review gate parses (`parseAuditSignal`) and freshness-checks (`resolveAuditVerdict`); the human-readable report follows below it.

```
---
verdict: clean | violations | non-converged
violations: <integer>
unverifiable: <integer>
reviewed_ahead: <commits between the audit merge-base and HEAD at audit time>
---
```

- `verdict` is `clean` when `violations === 0`, else `violations`. The parser rejects a `clean` verdict with a positive count and a `violations` verdict with a zero count as self-contradictory, so the count and the verdict must agree.
- `violations` is the count of VIOLATION entries in the report's verdict table (the integer the parser cross-checks against `verdict`).
- `unverifiable` is the count of UNVERIFIABLE entries.
- `reviewed_ahead` is `git rev-list --count <merge-base>..HEAD`, where `<merge-base>` is the audit's diff base — the same merge-base the "Determine the Audit Scope" section above computes its diff range from. Emit it on every audit so the resolver can freshness-check the audit against the worktree's current ahead-count.
- `spec-audit` emits `clean` (when `violations === 0`) or `violations` only. `non-converged` is reserved for `spec-remediate`, which sets it only when it exits at the remediation cap with unresolved findings; never emit `non-converged` from this skill.

The human-readable report body follows the front-matter, unchanged:

1. Header: branch and merge-base (or PR/range), criteria file and its compile baseline, date, verdict counts.
2. A verdict table: criterion ID, mode, one-line title, verdict.
3. One finding block per VIOLATION: criterion ID, the spec quote, the evidence (`file:line` plus the offending excerpt), and a one-paragraph description of what conforming code would look like. Describe; do not patch.
4. An UNVERIFIABLE section listing what to fix in the criteria, and a `pre-existing` section if applicable.
5. The ledger results, grouped by establishing phase.

Summarize in conversation with violations first, then counts. If there are zero violations, say so plainly.

## Boundaries

- **Report-only.** Never edit production code, tests, or the spec. The loop is: hand findings to the implementer, re-run this skill.
- **No scope creep.** Do not report style, correctness, or performance findings — other gates own those. If a genuine bug surfaces while reading, confine it to a single out-of-scope note at the end.
- **No criteria authorship.** If the implementation does something the spec never constrained, that is not a finding here; it is feedback for `spec-review` or `spec-criteria`.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
