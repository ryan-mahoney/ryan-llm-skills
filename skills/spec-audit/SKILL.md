---
name: spec-audit
description: This skill should be used when the user asks to "audit the implementation against the spec", "run the spec audit", "check spec conformance", "verify the branch against the criteria", or "spec audit". Executes the frozen conformance checklist from .specs/<slug>/criteria/ against the implementation diff and reports PASS/VIOLATION/UNVERIFIABLE per criterion with file:line evidence. Report-only; never edits production code.
disable-model-invocation: true
argument-hint: "[feature-slug, spec path, or GitHub issue number]"
---

# Spec Audit

Execute a compiled conformance checklist against an implementation. This skill answers "is it the thing the spec described", not "is it correct" — correctness review (roborev, generic code review) is a separate, orthogonal gate. A criterion can be violated while every test passes; most criteria exist precisely because tests cannot see them. "All tests pass" is never exculpatory evidence here.

Run this at the end of a branch, after correctness review. Re-running after fixes is cheap because the criteria are frozen.

## Resolve the Spec and Criteria

Resolve the spec target in this order:

1. If `$ARGUMENTS` is a path to a markdown file, use that file.
2. If `$ARGUMENTS` names a folder under `.specs/`, use `.specs/<feature-slug>/spec.md`.
3. If `$ARGUMENTS` is a GitHub issue number and the current repository is hosted on GitHub, read the issue with `gh issue view <issue-number> --json body --jq .body`, extract its `Spec folder: .specs/<feature-slug>/` footer, and use the local `.specs/<feature-slug>/spec.md`. If the local file is missing but the issue body has a valid footer, create the folder and write the issue body to `spec.md`.
4. If no argument is provided, use the most recently modified `.specs/*/spec.md`.

Then locate the checklist from local artifacts. A worktree does not need to know that it is "phase N"; phase is only a planning/checklist artifact.

Use this order:

1. If the resolved `spec.md` footer or body contains a phase marker such as `(phase N)` or `Phase N of M`, use `.specs/<feature-slug>/criteria/phase-<n>.md`.
2. Else, if `.specs/<feature-slug>/criteria.md` exists, use it.
3. Else, if exactly one `.specs/<feature-slug>/criteria/phase-*.md` file exists, use that file and treat its phase number as the checklist identity for report naming.
4. Else, if multiple `criteria/phase-*.md` files exist and no phase marker was resolved, stop and ask the user to pass the phase-specific criteria path or add a phase marker to the local `spec.md`. Do not infer the phase from the worktree branch name.

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

Write the audit report next to the spec, overwriting any previous run:

- If the checklist is `criteria/phase-<n>.md`, write `.specs/<feature-slug>/audit/phase-<n>.md`.
- If the checklist is `criteria.md`, write `.specs/<feature-slug>/audit.md`.

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
