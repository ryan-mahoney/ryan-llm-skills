---
name: spec-pr
description: Publish evidence-complete spec-driven work as a pull request. Rebase first, re-establish commit-bound evidence after any change, require a passing independent audit and ready HTML work tour, push safely, and make the PR an evidence index rather than a request for human review.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "7"
---

# Spec PR

Publish a deploy candidate whose executable evidence is already complete. Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). The PR distributes intent, proof, QA output, and deployment facts; neither opening the PR nor a future human review creates merge safety.

This skill opens or updates PRs and never merges them. It may change repository and remote Git state only as required for rebase, commit, and push. It never publishes a red or stale evidence case as merge-ready.

## Required Inputs

Resolve an explicit `.specs/<feature>/` folder or contained `spec.md` first, then conversation/footer context. Stop on ambiguity. Unlike a generic PR helper, this spec-driven publisher requires the complete package:

- `spec.md`, `spec-steps.json`, `evidence-plan.json`
- `preparation.json`
- `merge-evidence.json` and `merge-evidence.md`
- latest `reviews/branch-<n>-review.md`
- `work-tour.json` and `work-tour.html`
- `blockers.md` when present

Also read proposal, critique, preparation report, criteria/invariants, learnings, evidence artifacts, and review/fix history for PR summarization. Missing required inputs, a non-empty blocker, an audit other than `pass` + `evidence_verdict: proven`, a tour other than `ready`, or any artifact bound to a different commit blocks publication.

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

1. Resolve the default branch from `refs/remotes/origin/HEAD`, then repository convention, then `main`/`master`. Stop if HEAD is that branch.
2. Fetch `origin/<base>` and rebase when it is not an ancestor of HEAD.
3. Resolve conflicts from intent: read both sides, the spec, changed history, and relevant surrounding code. Integrate both intents when compatible; never mechanically choose ours/theirs.
4. For every non-trivial conflict, run focused tests and EV gates for the affected claims. A compile-only result is insufficient when the conflict crosses a behavioral/data/security boundary.
5. If intent is irreconcilable or a trustworthy result cannot be produced, abort the rebase and stop. Do not open a conflicted or deliberately uncertain PR for someone else to solve.
6. Confirm the rebased tree is conflict-free with `git merge-tree`.

Write `pr-rebase-log.md` even when already current. Record pre/post HEAD, base SHA, each side's intent, resolution, affected claims/gates, exact verification, and remaining uncertainty. Remaining material uncertainty blocks publication.

## Commit Coherent Staged Changes

Create a conventional commit for coherent staged work only. Preserve unrelated user changes. If nothing is staged, do not invent a commit.

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

## Write The Evidence PR

Create an imperative title under 70 characters. Write the body to `pr-message.md` first, then submit that file unchanged. The body contains:

```markdown
## Outcome

[Requested and implemented observable outcome.]

## Architecture and implementation

[Before/after data flow, important decisions, step commits, and affected boundaries.]

## Executable evidence verdict

- **Commit:** `<full SHA>`
- **Verdict:** ready
- **Independent audit:** pass, iteration N, `<artifact>`
- **Claims:** N/N proven
- **Gates:** N/N passed

[Compact AC → CL → EV table. Name exact commands, artifacts, and proof limits for material gates.]

## QA tour

- **HTML:** `.specs/<feature>/work-tour.html`
- **Machine manifest:** `.specs/<feature>/work-tour.json`

[Entrypoints, fixtures, automated scenarios, and visual captures. Optional exploratory product questions are clearly labeled and are not merge gates.]

## Deployment safety

[Migrations, configuration, observability, rollback/forward-fix, residual risks, and deploy gate facts.]

## Evidence provenance

[Spec folder, evidence posture, exact base/HEAD, rebase outcome, and rerun facts.]
```

Do not include “please review,” required manual testing, or claims that future review will catch mistakes. Do not copy secrets or sensitive evidence into the PR. If the platform cannot serve the local HTML, inline the essential verdict and QA steps in the body and report where the portable artifact can be published by the repository's existing artifact mechanism; do not invent a hosting service.

Use `gh pr view --json number,url,state` to find an existing PR for the branch. Create one when absent; otherwise update its body and title. Write `pr-url.json` after the platform returns the URL.

## Verify Publication

Query `gh pr view --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup,url` and confirm:

- `headRefOid` equals the work-tour commit;
- mergeability is not `CONFLICTING` (brief `UNKNOWN` may be polled a few times);
- required platform checks are passing or still pending, never failing;
- the submitted body equals `pr-message.md`.

Pending remote checks make the PR published-but-not-yet-deployable. Failed checks invalidate readiness: update local evidence/tour after diagnosing and correcting them, push, and refresh the PR. Do not call a PR deploy-ready while a required remote gate is red.

## Report

Report the PR URL and create/update result; base and rebase outcome; exact local/remote/tour SHA; audit and evidence verdicts; claim/gate counts; HTML/JSON tour paths; QA scenario/capture counts; deployment verdict; platform mergeability/check state; and all written artifact paths.

Do not add model attribution or co-author trailers.
