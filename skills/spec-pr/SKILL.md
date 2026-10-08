---
name: spec-pr
description: "Publish draft spec-driven checkpoints early, then establish final-commit evidence and a ready work tour before marking the PR ready. Report CI status once; never gate on it. Push safely and explain the resulting change concisely."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>] [mode=draft|ready]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "17"
---

# Spec PR

Publish an authorized draft after a meaningful implementation checkpoint so the operator
can follow progress. Mark it ready only when applicable merge evidence is complete. CI
results belong to the operator: this skill reads CI status once and reports it, never
waits for it. Deployment
readiness, authorization and post-deployment observations remain separate. Apply
[Verification and Review](../../rules/verification-and-review.md), including Jev checkpoints. Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). The PR explains the problem and resulting change to a teammate. The supporting artifacts retain the full verification record; neither opening the PR nor a future human review creates merge safety.

This skill opens or updates PRs and never merges them. It may change repository and remote Git state only as required for rebase, commit, and push. It never publishes a red or stale evidence case as merge-ready.

## Review Completion

Default to the shared **Step Review Completion** contract: consume completed independent
step reviews and fixes, including the last step, from current merge evidence. No branch
audit artifact is required. Do not launch a final review or turn artifact assembly into
one. Additional PR review and merge decisions belong to the operator/organization.

### Explicit Branch Refinement

Apply the shared **Bounded Refinement Completion** policy when refinement returns
`verified-at-cap`. Its current completion record replaces the final independent-audit
pass requirement below. Check its links to recorded fix decisions and current evidence;
inspect implementation again only for a concrete discrepancy. Retain the stated
absence of independent post-fix review, and do not launch an extra review or reset the
round budget. A stale completion remains a blocker.

## Required Inputs

Resolve an explicit `.specs/<feature>/` folder or contained `spec.md` first, then conversation/footer context. Stop on ambiguity. Confirm publication is within the user's authorized scope.

Use `mode=draft` while implementation or required evidence is incomplete, including early
checkpoint publication. Require the sourced context/spec, a coherent committed checkpoint,
and enough actual diff/learning evidence to explain progress and gaps. A ready tour and
final audit are not prerequisites for pushing or opening/updating this draft. Keep an
existing draft in draft status; if a formerly ready candidate becomes incomplete, restore
draft status and explain the gap.

Use `mode=ready` for final readiness. Before marking the PR ready, require the complete
package below. Reuse current outputs at entry; establish missing or invalidated final
evidence under the sequence below instead of demanding a tour before a planned rebase:

- sourced `context.md`, `spec.md`, `spec-steps.json`, version 2 `evidence-plan.json`
- `merge-evidence.json` and `merge-evidence.md`
- completed step review/fix records linked from merge evidence; branch audit/completion only when explicitly selected
- version 2 `work-tour.json` and its `work-tour.html`
- `blockers.md` when present

Summarize from the current tour, merge evidence, sourced scope, and relevant diff.
Open planning history, learnings, or review/fix details only to resolve missing context,
a contradiction, or a material limitation. Drafts use available checkpoint learnings
and the actual diff without requiring final artifacts. Missing or legacy required
inputs, unresolved merge blockers, invalid audit/completion, a tour other than `ready`,
or stale commit bindings block ready status, not an honest authorized draft.

Write these artifacts atomically under the spec folder:

- `pr-rebase-log.md` — base, SHAs, conflicts, resolutions, commands, and evidence invalidation/re-establishment.
- `pr-message.md` — exact PR title and body submitted.
- `pr-url.json` — `{ "url": "...", "submittedAt": "...", "commit": "full SHA", "tour": "work-tour.html" }`.

For a draft without a tour, use `"tour": null` in `pr-url.json`.

`.specs/` is often gitignored. Read it directly and do not stage it unless the repository explicitly tracks it.

## Order Of Operations

```text
draft: resolve authority/checkpoint -> safe push -> create/update draft
ready: fetch/rebase -> resolve conflicts -> commit coherent work -> focused evidence
-> safe push -> consume step review/fix completion -> render work tour
-> verify HEAD/evidence bindings and mergeability -> update PR to ready -> read CI status once -> verify publication
```

Push checkpoints and open/update the draft before final regression evidence is complete.
After review fixes or other new commits, push again before ready status. Preserve the
selected review budget.

## Rebase Safely

For ready mode, reconcile the current base before final evidence. An early draft can use
its current coherent branch unless project policy requires an immediate rebase; perform the
safe rebase and refresh affected proof before ready status.
In an end-to-end run, the coordinator applies this procedure before final evidence and the work tour. At publication, reuse its recorded result when the
fetched base is still an ancestor of HEAD and no relevant state has changed.

1. Read current project context and validate the snapshot/decision sources before publication.
   Resolve the default branch from `refs/remotes/origin/HEAD`, then repository convention, then `main`/`master`. Stop if HEAD is that branch.
2. Fetch `origin/<base>` and rebase when it is not an ancestor of HEAD.
3. Resolve conflicts from intent: read both sides, the spec, changed history, and relevant surrounding code. Integrate both intents when compatible; never mechanically choose ours/theirs.
4. For every non-trivial conflict, run safe, authorized focused merge tests and EV gates for the affected claims;
   preserve later-phase procedures and pending execution honestly. A compile-only result is insufficient when the conflict crosses a behavioral/data/security boundary.
5. If intent is irreconcilable or a trustworthy result cannot be produced, abort the rebase and stop. Do not open a conflicted or deliberately uncertain PR for someone else to solve.
6. Confirm the rebased tree is conflict-free with `git merge-tree`.

Write `pr-rebase-log.md` even when already current. Record pre/post HEAD, base SHA, each side's intent, resolution, affected claims/gates, exact verification, and remaining uncertainty. Remaining material merge uncertainty blocks ready status. Pending deployment authorization or
post-deployment observations remain separate and do not require live operations to publish.

## Commit Coherent Staged Changes

Create a conventional commit for coherent staged work only. Preserve unrelated user changes. If nothing is staged, do not invent a commit.
Apply the commit section of [Engineering Writing](../../rules/engineering-writing.md); name the actual change, not the publication stage.

## Re-Establish Evidence After Git Changes

A rebase, conflict resolution, staged commit, dependency/base change, or any code/test/config/migration/deploy change invalidates prior commit-bound readiness. Do not edit SHAs in evidence files as a shortcut.

The steps below establish ready-mode evidence. Draft mode records pending/stale gates and
runs needed focused feedback without requiring final audit/tour assembly before its push.

For an unchanged candidate with current applicable evidence, current step review/fix completion (or an explicitly selected branch review completion), and a ready tour, skip evidence
regeneration, review, and tour rendering. Proceed to PR metadata and publication
verification. A stage transition alone does not invalidate those outputs. If the base,
candidate, authority, or relevant check result changes, explain the invalidation and
apply only the affected work below within the existing review budget.

1. Determine which claims, gates, and operational assumptions the new base or conflict touched.
2. Apply the Jev verification checkpoint before expensive/repeated checks. Re-run affected
   focused gates that inform concrete decisions or resolve relevant failures. Broad
   build/integration/regression suites belong to CI or the operator, not this stage. Reuse
   other valid focused results with their original revisions and an explicit applicability
   assessment; a new SHA does not require every local suite.
3. Update affected `merge-evidence.json`/Markdown records from actual outcomes only
   if the evidence owner has not already brought them current. Preserve applicable
   unchanged records and their original observations; do not reconstruct the package.
4. Consume the current step review/fix completion in merge evidence. Route concrete new
   defects or substantive conflict changes to the owning step/fix worker and review only
   uncovered implementation. Do not launch `spec-branch-refine` unless explicitly requested
   or required by sourced project policy. Publication, a new SHA, or a missing branch audit
   is not a reason to review completed work again.
5. Reuse a current `spec-work-tour` result or run it when missing or invalidated. Confirm
   its JSON/HTML and review completion bind the exact full `git rev-parse HEAD` SHA.
   Required evidence must apply to that candidate; preserve original review ranges and
   observed revisions with explicit applicability rather than relabeling them. Reuse the tour owner's render/inspection
   result; reopen only when output, renderer, or shared-file packaging changed, the
   inspection is missing, or a concrete presentation defect is reported.

If evidence cannot be re-established, keep the authorized PR in draft status and record the
actual gaps. Continue useful repair; do not mark the candidate ready or
publish a failed gate as passed.

## Push Without Overwriting Foreign Work

Push all coherent task-owned commits, including final step fixes; preserve unrelated user work. After a rebase, use `--force-with-lease`, never bare `--force`. If the lease fails, fetch and inspect remote divergence. Rebase/integrate the remote work and repeat the affected evidence, scoped review if needed, and tour sequence, or stop. Never overwrite commits the lease identified as foreign.

After pushing, compare the remote branch SHA to local HEAD. For ready status it must also
match the current tour/evidence. Do not wait for a tour to make the initial push.

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

For a draft, describe the actual checkpoint and remaining acceptance/evidence gaps without
claiming final readiness. Update the description as implementation changes.

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

Use `gh pr view --json number,url,state,isDraft` to find an existing PR for the branch.
For draft mode, create with `gh pr create --draft` when absent, otherwise update its body/title
and retain or restore draft status with `gh pr ready --undo` as needed. For ready mode,
change to ready only after the checks below. Write `pr-url.json` after the platform returns the URL. Retain existing publication
fields and add `schema_version: 1`, `kind: pr_submission`, `url`, `submitted_at`
(actual UTC submission time), `package` (canonical absolute spec folder), and
`parent_session` (the coordinator's exact transcript path) when available. Do not guess
session identity or reuse an older submission timestamp. This receipt records PR
submission, not coordinator completion or acceptance; later publication queries do not
change that timestamp.

## Verify Publication

Query `gh pr view --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url` and confirm:

- `headRefOid` equals the pushed local HEAD and, for ready status, the work-tour commit;
- mergeability is not `CONFLICTING` (brief `UNKNOWN` may be polled a few times);
- CI status on that exact SHA is read once and recorded in the PR body as pending, passing, or failing; it does not gate ready status;
- the submitted body equals `pr-message.md`.

CI results belong to the operator after publication. Do not poll, wait for, or diagnose
remote checks; a failing or pending check is reported, not fixed here, unless the task is
CI work or the user asks. Before `gh pr ready`, confirm closed acceptance/review gaps,
current mergeability, the selected review completion, and a ready tour. Publication never
merges or deploys.

## Report

Report the PR URL and whether it was created or updated, plus the recorded CI status and
material limitations. Link the local tour and publication records for detailed SHAs, rebase history,
evidence counts, and separate release states. Expand those details only when requested or needed
to explain a blocker. Do not equate local verification with passing remote checks or deployment.

Do not add model attribution or co-author trailers.
