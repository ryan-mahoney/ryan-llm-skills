---
name: spec-pr
description: "Publish verified spec-driven work as a pull request with a concise explanation of the problem and resulting change. Rebase, refresh evidence after changes, require a passing independent audit and ready work tour, and push safely."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "10"
---

# Spec PR

Publish a merge candidate whose applicable merge evidence is complete and whose deployment
readiness, authorization and post-deployment observations are recorded separately. Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). The PR explains the problem and resulting change to a teammate. The supporting artifacts retain the full verification record; neither opening the PR nor a future human review creates merge safety.

This skill opens or updates PRs and never merges them. It may change repository and remote Git state only as required for rebase, commit, and push. It never publishes a red or stale evidence case as merge-ready.

## Required Inputs

Resolve an explicit `.specs/<feature>/` folder or contained `spec.md` first, then conversation/footer context. Stop on ambiguity. Unlike a generic PR helper, this spec-driven publisher requires the complete package:

- sourced `context.md`, `spec.md`, `spec-steps.json`, version 2 `evidence-plan.json`
- version 3 `preparation.json`
- `merge-evidence.json` and `merge-evidence.md`
- latest `reviews/branch-<n>-review.md`
- version 2 `work-tour.json` and its `work-tour.html`
- `blockers.md` when present

Also read proposal, critique, preparation report, criteria/invariants, learnings, evidence artifacts, and review/fix history for PR summarization. Missing or legacy required inputs, an unresolved merge blocker, an audit other than `pass` + `evidence_verdict: proven`, a tour other than `ready`, or any artifact bound to a different commit blocks publication.

Write these artifacts atomically under the spec folder:

- `pr-rebase-log.md` — base, SHAs, conflicts, resolutions, commands, and evidence invalidation/re-establishment.
- `pr-message.md` — exact PR title and body submitted.
- `pr-url.json` — `{ "url": "...", "submittedAt": "...", "commit": "full SHA", "tour": "work-tour.html" }`.

`.specs/` is often gitignored. Read it directly and do not stage it unless the repository explicitly tracks it.

## Order Of Operations

```text
resolve evidence -> fetch/rebase -> resolve conflicts -> commit staged work
-> re-establish affected evidence -> independent branch refine -> render work tour
-> verify all artifacts bind HEAD -> push -> create/update PR -> verify mergeability
```

Do not push or open/update the PR before the evidence gate passes.

## Rebase Safely

1. Read current project context and validate the snapshot/decision sources before publication.
   Resolve the default branch from `refs/remotes/origin/HEAD`, then repository convention, then `main`/`master`. Stop if HEAD is that branch.
2. Fetch `origin/<base>` and rebase when it is not an ancestor of HEAD.
3. Resolve conflicts from intent: read both sides, the spec, changed history, and relevant surrounding code. Integrate both intents when compatible; never mechanically choose ours/theirs.
4. For every non-trivial conflict, run safe, authorized focused merge tests and EV gates for the affected claims;
   preserve later-phase procedures and pending execution honestly. A compile-only result is insufficient when the conflict crosses a behavioral/data/security boundary.
5. If intent is irreconcilable or a trustworthy result cannot be produced, abort the rebase and stop. Do not open a conflicted or deliberately uncertain PR for someone else to solve.
6. Confirm the rebased tree is conflict-free with `git merge-tree`.

Write `pr-rebase-log.md` even when already current. Record pre/post HEAD, base SHA, each side's intent, resolution, affected claims/gates, exact verification, and remaining uncertainty. Remaining material merge uncertainty blocks publication. Pending deployment authorization or
post-deployment observations remain separate and do not require live operations to publish.

## Commit Coherent Staged Changes

Create a conventional commit for coherent staged work only. Preserve unrelated user changes. If nothing is staged, do not invent a commit.
Apply the commit section of [Engineering Writing](../../rules/engineering-writing.md); name the actual change, not the publication stage.

## Re-Establish Evidence After Git Changes

A rebase, conflict resolution, staged commit, dependency/base change, or any code/test/config/migration/deploy change invalidates prior commit-bound readiness. Do not edit SHAs in evidence files as a shortcut.

1. Determine which claims, gates, and operational assumptions the new base or conflict touched.
2. Re-run affected focused gates, plus any build/integration gate whose dependency graph changed.
3. Regenerate `merge-evidence.json`/Markdown from actual outcomes.
4. Run `spec-branch-refine` against the final branch. It must end with a current audit pass and
   `evidence_verdict: proven`.
5. Run `spec-work-tour`, then confirm its JSON/HTML, the audit artifact, and every required gate bind
   the exact full `git rev-parse HEAD` SHA. Open `work-tour.html` and confirm it renders.

If evidence cannot be re-established, stop without pushing. A red evidence case may still be retained locally as useful diagnosis; it is not a deploy candidate.

## Push Without Overwriting Foreign Work

Push the branch. After a rebase, use `--force-with-lease`, never bare `--force`. If the lease fails, fetch and inspect remote divergence. Rebase/integrate the remote work and repeat the full affected-evidence and audit/tour sequence, or stop. Never overwrite commits the lease identified as foreign.

After pushing, compare the remote branch SHA to the tour's commit. They must match exactly.

Apply the Assembly, Tour, And Publication section of [Engineering Decisions](../spec-work-tour/references/standalone-engineering-decisions.md).
Include consequential behavior rules, observations, proof limits, and follow-up destinations
when they affect review of this change. Keep full local follow-up briefs in internal records; if a brief
is inaccessible and its contents are needed to assess the PR, summarize the limitation and next
action in the body. Do not create issues implicitly. Describe only the slice actually delivered,
and never hide an unmet merge claim as future work.

## Write The PR

Read [PR and Ticket Writing](../../rules/pr-and-ticket-writing.md) and apply repository/user
writing guidance. Create a specific title under 70 characters using the repository's convention.
Write `pr-message.md` with the title and exact body before submission; submit its body unchanged.

For a small change, start with one or two short paragraphs explaining the trigger, consequence,
and resulting behavior. Add a small example or the reason for a non-obvious choice when useful.
Use headings for a larger change or a required template, not as a fixed six-section report.

Include dependencies, limitations, review navigation, or deployment instructions only when they
change how someone should assess or use this work. Link actual predecessor PRs in a stack.
Describe meaningful verification as scenario and observed result; omit routine success reports.
Keep full SHAs, audit iterations, AC/CL/EV tables, command inventories, and phase bookkeeping in
the tour/evidence artifacts unless the repository explicitly requires them in the PR.

Link the tour or other evidence only when accessible to the intended reader. Verify file links
refer to committed content in the relevant revision. Do not cite `.specs/`, uncommitted files,
temporary reports, or paths outside the repository. If no shared artifact location exists, retain the
local tour and include only essential findings or instructions in the PR. Do not expand the
whole evidence record into the body or invent a hosting service.

Before submission, read the body without the spec or conversation. Check that it explains the
actual final diff, bounds every material claim, and contains no workflow narration, stale scope,
or invented rollout requirements. A short description does not excuse omitting a consequential
defect or limitation.

Do not make future human review or required manual testing a substitute for the evidence gate.
Do not copy secrets or sensitive evidence into the PR.

Use `gh pr view --json number,url,state` to find an existing PR for the branch. Create one when absent; otherwise update its body and title. Write `pr-url.json` after the platform returns the URL.

## Verify Publication

Query `gh pr view --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url` and confirm:

- `headRefOid` equals the work-tour commit;
- mergeability is not `CONFLICTING` (brief `UNKNOWN` may be polled a few times);
- required platform checks are passing or still pending, never failing;
- the submitted body equals `pr-message.md`.

Pending required remote checks leave platform merge readiness pending; they do not authorize
or establish deployment. Keep this platform state distinct from the local merge evidence verdict. Failed checks invalidate readiness: update local evidence/tour after diagnosing and correcting them, push, and refresh the PR. Do not call a PR deploy-ready while a required remote gate is red.

## Report

Report the PR URL and whether it was created or updated, plus pending checks or material
limitations. Link the local tour and publication records for detailed SHAs, rebase history,
evidence counts, and separate release states. Expand those details only when requested or needed
to explain a blocker. Do not equate local verification with passing remote checks or deployment.

Do not add model attribution or co-author trailers.
