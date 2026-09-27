---
name: codex-review-fix
description: "Use when the user asks pi to delegate one round of review and fixes to Codex with Astra, including replacing spec-end-to-end's refinement stage. One session reviews, fixes, verifies, and commits; pi checks the handoff without another review or duplicate tests. Not for review-only requests or an ordinary request to use Astra within the standard refinement loop."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "2"
---

# One Review And Fix Pass

When explicitly selected, dispatch one `codex-astra-reviewer` pi agent session using
`gpt-6-astra`. That session reviews once, fixes its findings, runs required verification,
and commits. Pi checks the handoff mechanically and marks this stage complete. Do not
start `spec-branch-refine`, request a second review, redispatch automatically, or rerun
passing tests in pi. Verification and local correction of the identified fixes are part
of the single pass; discovering new review rounds is not.

In `spec-end-to-end`, this replaces the review/refinement stage, not implementation,
the work tour, or publication. An explicit request such as “use Codex Astra for one
review and fix, no refinement loop” is sufficient authorization for that substitution.
Naming Astra alone does not change the standard review policy. For standalone use,
finish after the handoff; do not start a spec workflow or publish a PR implicitly.

## Resolve And Dispatch

1. Resolve the code checkout from the active workflow or explicit user path. Honor a
   request to stay in the primary checkout; its containing `.specs/` is not a reason
   to forbid it. For spec work, use the shared
   [Workspace Handoff](../spec-end-to-end/references/workspace-handoff.md) to resolve
   the separate canonical spec-folder path. Never read a worktree copy of `.specs/`.
2. Record the base ref, resolved merge-base SHA, current HEAD, and working-tree status.
   Use the workflow/user base, otherwise repository default-branch conventions; do
   not assume the branch's upstream is its review base. Preserve unrelated dirty
   files. Include uncommitted work only when it belongs to the requested scope; stop
   only for an unresolved ownership conflict. Do not stash or clean user work.
3. Confirm pi can resolve `codex-astra-reviewer`, its external runner uses Codex with
   `gpt-6-astra`, and the CLI is available. Use its existing execution policy; do not
   add a sandbox bypass or install/reconfigure an agent as part of this skill. If
   the agent, CLI, authentication, or model is unavailable, return the exact failure
   without switching models or execution modes.
4. For spec work, record `review-mode: one-pass` and the user's directive in the
   existing stage ledger. Pass that decision through the tour and PR handoffs. Do
   not edit hash-bound preparation just to record the mode. Resolve known required
   rebases before this pass when possible so publication does not invalidate it.
5. Dispatch once, with one writer in the checkout. In pi, use:

```text
subagent({
  agent: "codex-astra-reviewer",
  cwd: "<absolute code checkout>",
  async: true,
  task: "<filled task below>"
})
```

Use completion notifications or wait for this task; do not start overlapping work or
poll repeatedly. If the current harness has no pi `subagent` tool, report that mismatch
instead of inventing a tool call or silently changing the requested delegate.

## Worker Task

Fill all paths, SHAs, scope, and output locations before dispatch. Omit spec-only inputs
for a standalone run. Pass instruction paths explicitly because the agent may not
inherit project context or skills.

```text
Perform one review followed by fixes in this session. Do not invoke a refinement loop,
spawn reviewers, or perform a second review after fixing.

Code checkout: <absolute path>
Review base: <ref and resolved merge-base SHA>
Starting HEAD: <full SHA>
Included uncommitted changes: <explicit paths or none>
Unrelated changes to preserve: <paths or none>
Canonical spec folder: <absolute path or none>
Report destination: <canonical reviews/one-pass-review-fix.md or standalone log path>
Review mode: one-pass, explicitly requested by the user in <ledger/source>.

Read applicable AGENTS.md files and engineering/commit guidance. For spec work, read
context.md, spec.md, evidence-plan.json, merge-evidence.json/Markdown, step learnings,
and the shared Executable Evidence Contract at <absolute skill reference path>.
Use the prepared commands and pending automated gates as verification inputs.

1. Review the integrated diff from the recorded merge-base to starting HEAD, plus
   explicitly included uncommitted work. Inspect callers, dependencies, and tests as
   needed to establish real defects. Check correctness, contracts, security/data
   boundaries, wiring, acceptance coverage, and useful regression coverage. Record
   findings before editing. Do not restrict investigation to changed files.
2. Fix actionable findings in this session, including adjacent files when necessary
   for a coherent repair. Add or update useful tests. Avoid unrelated refactoring.
   Record consequential product/authority decisions as unresolved rather than guessing.
3. Run required verification after fixes, including tests deferred by implementation
   steps. Choose commands from this project's actual tooling, not a generic stack
   checklist. Deduplicate overlap: do not run every focused file then a suite covering
   the same cases. Reuse still-valid results. Apply finite process-level deadlines:
   120 seconds by default for focused checks; choose and record a justified longer
   deadline before a known slower suite/build. Retain command output and elapsed time.
   Correct concrete failures within this pass and rerun affected checks only. Do not
   repeat unchanged failures or continue without new diagnostic evidence. If a gap
   remains, report blocked; do not start another review to obtain a pass.
4. Commit coherent fixes using repository conventions, excluding unrelated work and
   .specs/evidence files. Do not create an empty commit when there are no fixes. Never
   push, open a PR, change live systems, or add model attribution to repository artifacts.
5. Write the report below. For spec work, refresh canonical merge-evidence.json and
   Markdown from actual results bound to final HEAD. Preserve original preparation and
   step learnings. Leave unrun/failed gates honest. Do not claim an independent audit
   of your own fixes or write a fabricated branch-audit pass.
```

## Report And Completion

Write the report atomically. For spec work, keep it at the canonical
`reviews/one-pass-review-fix.md`; use a caller-provided log path for standalone work.
Begin with a heading and this fenced YAML, followed by findings and verification detail:

```yaml
review_fix:
  mode: one-pass
  outcome: complete # complete | blocked
  base: <full merge-base SHA>
  starting_commit: <full SHA>
  commit: <final full SHA>
  independent_post_fix_review: false
  evidence_verdict: proven # proven | incomplete
  commits: [] # fix commit SHAs; empty when no fixes
  unresolved: [] # actionable findings, decisions, failed checks, or missing evidence
```

Record each finding's location, consequence, fix or unresolved reason; verification
commands, deadlines, elapsed times, outcomes, logs, and proof limits; and residual risks.
`complete` requires the one review and its repairs to finish, required checks to pass,
and no unresolved actionable findings. `proven` describes the required executable
claims within their recorded limits; it does not assert independent post-fix review.
For standalone work, use the agreed scope's required checks as the evidence boundary.

Pi then checks final HEAD, the reported commit range/diffs, preservation of unrelated
changes, required report/log existence, and evidence bindings/statuses. Read recorded
command outcomes; do not rerun tests as a routine confirmation. Missing or contradictory
evidence makes the result blocked. Do not fix forward or redispatch automatically.
A failed CLI session is also blocked, not a completed review.

On a complete spec handoff, mark the replacement stage complete and continue to
`spec-work-tour`, then `spec-pr` if those stages were already authorized. Pass the mode,
user decision, report path, final HEAD, and evidence paths. The downstream exception in
the shared Executable Evidence Contract applies: this report satisfies the selected
review stage, without pretending the fixes received a separate independent audit.
If blocked, preserve work and report the exact remaining gap. The one-pass limit does
not authorize marking failed checks or unresolved defects successful.
