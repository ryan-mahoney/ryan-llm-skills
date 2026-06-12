---
name: spec-remediate
description: This skill should be used when the user asks to "remediate the audit findings", "fix the spec violations", "close the audit findings", "fix conformance violations", or "spec remediate". Reads a spec-audit report, drives one smart subagent per VIOLATION to converge the code back to the frozen spec, and re-audits until clean. Edits production code; never rewrites the spec.
disable-model-invocation: true
argument-hint: "[feature-slug, spec path, or GitHub issue number]"
---

# Spec Remediate

Close the conformance loop. `spec-audit` reports VIOLATIONs but never edits code; this skill consumes that report and fixes the findings, then re-audits until the report is clean or a cap is reached.

Every fix converges the code **back to the frozen spec** — it never re-designs, re-scopes, or "improves." The audit finding is the brief and the spec is the target; remediation is a constrained search toward an existing answer, not a design task. The report/remediate split mirrors the compile/audit firewall: the skill that judges does not patch, and the skill that patches does not re-judge its own work — `spec-audit` re-runs as the independent oracle.

## Resolve the Spec and Audit Report

Resolve the spec target in this order:

1. If `$ARGUMENTS` is a path to a markdown file, use that file.
2. If `$ARGUMENTS` names a folder under `.specs/`, use `.specs/<feature-slug>/spec.md`.
3. If `$ARGUMENTS` is a GitHub issue number and the current repository is hosted on GitHub, read the issue with `gh issue view <issue-number> --json body --jq .body`, extract its `Spec folder: .specs/<feature-slug>/` footer, and use the local `.specs/<feature-slug>/spec.md`. If the local file is missing but the issue body has a valid footer, create the folder and write the issue body to `spec.md`.
4. If no argument is provided, use the most recently modified `.specs/*/spec.md`.

Then locate the audit report: `.specs/<feature-slug>/audit.md`. Each phase runs in its own worktree, so there is exactly one audit report per worktree — phase is a content label only, never a file path.

**If no audit report exists, stop** and instruct the user to run `spec-audit` first. Do not audit inline: this skill remediates a report produced by an independent audit pass; judging and patching in one context defeats that independence.

Also read, when present, `.specs/<feature-slug>/criteria.md` and `.specs/<feature-slug>/invariants.md`. The criteria give each finding its `Source:` spec quote and ownership context; the ledger names cross-phase invariants a fix must not re-break.

## Triage the Findings

Read the audit report's verdict table and finding blocks. Act only on entries the report marks `VIOLATION`. Then classify each:

- **Code drift (remediate here).** The implementation diverged from a correct spec — duplicated a rule, placed logic in the wrong layer, diverged from a licensed precedent, broke an ownership boundary. The finding's "what conforming code would look like" paragraph is the fix brief. This is the default and the common case.
- **Spec defect (escalate, do not fix code).** The violation is actually correct behavior and the spec is wrong or under-specified, or honoring the spec literally would break the system. Do not bend the code to a wrong spec. Record it for escalation (below) and move on.

`UNVERIFIABLE` entries are **not** remediation targets — they are criteria-quality gaps. Collect them for escalation to `spec-criteria`; never "fix the code" to satisfy a check that could not be executed. `pre-existing` findings are out of scope for this branch unless the user explicitly asks to address them.

If there are zero `VIOLATION` entries, report that the audit is already clean and stop. Nothing to remediate is a success state, not an error.

Announce the remediation plan: which findings will be fixed here, which are escalated, in finding order.

## Remediation Model: One Smart Subagent Per Finding

Fix one finding per subagent. Each finding is independent; do not bundle. Use a capable general-purpose subagent — remediation needs to understand structure and perform relocations/refactors, so do not down-tier the model for it.

Preferred generic invocation for Codex, Claude, OpenCode, and harnesses with a generic subagent facility:

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Remediate <feature-slug> finding <criterion-id>",
  prompt: "<REMEDIATION_PROMPT>"
)
```

Augment CLI adapter: use the `spec-step-implementer` subagent when it is configured under `~/.augment/agents/` or `./.augment/agents/`, asking it to remediate exactly one finding with the prompt below. If subagents are unavailable in the current client, remediate directly and report that subagent execution was unavailable.

### Remediation Prompt Template

```txt
You are remediating a single spec-conformance violation. Your goal is to make the
code conform to the frozen spec — not to redesign, re-scope, or improve anything.

Spec file (the frozen target): <absolute path to .specs/<feature-slug>/spec.md>
Audit finding:
  Criterion: <criterion id and title>
  Spec quote (the rule that was violated): <Source quote from the finding/criteria>
  Evidence: <file:line excerpts the audit cited>
  What conforming code looks like: <the finding's conforming-shape paragraph>
Cross-phase invariants this fix must not re-break: <relevant invariants.md entries, or "none">

Before editing, read:
1. The cited evidence locations and the surrounding code.
2. The named spec quote in context in the spec file.
3. The precedent or owner the spec points to (e.g. the store, a shared module),
   so the relocated logic matches what already exists there.

Rules:
- Fix ONLY this finding. Do not touch unrelated code or other findings.
- Converge to the spec quote. If the spec says a responsibility is owned by module
  X, move it to X and delete the violating copy — do not leave both.
- Prefer deletion and relocation over addition. Most conformance fixes remove
  duplicated or misplaced code; they rarely add new structure.
- Do NOT edit the spec, the criteria, or the audit report. If you conclude the
  spec itself is wrong (conforming would break the system, or the rule contradicts
  another part of the spec), STOP and report "spec defect" with your reasoning
  instead of changing code.
- Keep changes surgical, explicit, and fail-fast. No speculative abstractions.
- Follow existing project patterns at the destination.
- Adjust tests only where this fix changes behavior or moves code under test.
- Do not run the entire test suite; run only targeted tests for the changed code.

Output requirements:
1. Summary of what changed and why it now conforms to the spec quote.
2. Exact files modified.
3. Targeted verification run and outcomes.
4. Whether you believe this finding is fully closed, plus any spec-defect concern.
```

## After Each Subagent Returns

Verification is mechanical: scope, conformance, tests. Do not re-open the design.

1. Confirm the changed files are confined to what the finding required. Out-of-scope edits fail verification; send one scoped fix-up subagent.
2. Re-check the single criterion when its check is cheap and available: run the criterion's `Check:` command from the criteria file, or read the cited location to confirm the violating pattern is gone. This is a fast local confirmation, not a substitute for the full re-audit below.
3. Run the targeted tests the subagent named and confirm they pass.
4. If the subagent reported a **spec defect**, do not edit code further for that finding; move it to the escalation list.
5. Once a code-drift finding verifies, stage its files and commit:
   - Conventional commit: `fix(<scope>): <criterion-id> <short description>`.
   - Append `(#<issue-number>)` when a GitHub issue is known.

One commit per finding, so each remediation is independently reviewable and revertable.

## Convergence Loop

After every code-drift finding has been addressed (fixed or escalated), re-run the audit as the independent oracle:

1. Re-run `spec-audit` for this spec by following `~/.agents/skills/spec-audit/SKILL.md`. It regenerates `audit.md` against the new code.
2. Compare the new VIOLATION set to the previous one:
   - Zero VIOLATIONs (ignoring any escalated spec-defect findings) → converged. Stop and report.
   - Fewer VIOLATIONs, all remaining ones are code drift → loop: remediate the new report.
   - A finding flips a previously-passing criterion to VIOLATION (a fix broke conformance elsewhere) → treat as a new code-drift finding and remediate it next round.
3. Cap at **3 remediation rounds**. If VIOLATIONs remain after the cap, stop and report the unresolved findings rather than looping indefinitely — persistent non-convergence usually signals a spec defect or a criteria defect, not a code bug.

Do not silently re-run past the cap. Surfacing "did not converge in N rounds" is the correct outcome; hand it back.

## Escalation

Remediation edits code; it never rewrites intent. Route the other failure shapes to the skill that owns them, and report them clearly instead of forcing a code fix:

- **Spec defect** (a VIOLATION that is actually correct behavior, or honoring the spec would break the system): escalate to `spec-review` to edit `spec.md`, then `spec-criteria` to recompile the checklist, then re-audit. Record each in `.specs/<feature-slug>/blockers.md` with the finding id and the reasoning.
- **Criteria defect** (`UNVERIFIABLE` entries): escalate to `spec-criteria` to tighten the compiled check. These are not code problems.
- **Non-convergence after the cap**: record the remaining findings in `.specs/<feature-slug>/blockers.md`.

When a GitHub issue mirror is available, also post escalations as an issue comment with `gh issue comment <issue-number> --body "..."`.

## Boundaries

- **Edits production code and tests; never the spec, criteria, or audit report.** Those are inputs. If the spec is wrong, escalate — do not patch it here.
- **No re-audit by this skill's own reasoning.** Convergence is measured by re-running `spec-audit`, not by self-assessment. The judge stays independent of the patcher.
- **No new scope.** Do not fix correctness, style, or performance issues the audit did not raise; those belong to other gates. Confine any incidental concern to a single note in the completion report.

## Completion

After the loop converges or hits the cap, report:

1. Spec path, audit report path, and GitHub mirror, if any.
2. Per-finding outcome: fixed (with commit hash), escalated (with reason), or unresolved.
3. Remediation rounds run and the VIOLATION count after each.
4. Final audit verdict counts.
5. Escalations filed (spec-review / spec-criteria) and any `blockers.md` entries.
6. Follow-up needed before the branch is conformance-clean.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
