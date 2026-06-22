---
name: spec-pr
description: This skill should be used when the user asks to "open a PR", "open the spec PR", "create a PR for this spec", "submit a PR", "push and open PR", or "send a pull request" for spec-driven work. Rebases the branch onto the default branch so it is mergeable at PR time — always rebasing when behind and resolving conflicts itself (the PR review is the safety net; it never merges) — commits any staged changes, force-pushes with lease, then opens (or updates) a GitHub pull request whose body is drafted from the spec's artifacts (spec.md, proposal/requirements/critique, criteria/invariants, audit, spec-review, branch reviews, learnings, blockers). Leaves an auditable pr-rebase-log.md and pr-message.md in .specs/<slug>/. Named spec-pr to avoid colliding with built-in PR skills.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>] [issue-number]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Spec PR

> **`.specs/` is untracked working state — often gitignored.** Read spec artifacts
> directly from the filesystem; do not run `git diff`/`log`/`status`/`show` on paths
> under `.specs/` to read or recover them — git returning nothing there is expected,
> not an error. This is scoped to `.specs/`; the rebase and diff of the **code** are
> unaffected. The PR body *summarizes* these artifacts; the artifacts themselves are
> not part of the PR diff.

Open a pull request for spec-driven work that **is mergeable at the time it is
opened**. The common failure this skill removes: open a PR, then discover the branch
is behind the default branch and needs a rebase after the fact. This skill rebases
first, confirms the branch merges cleanly, *then* opens the PR — and drafts the PR
body from the full set of artifacts the spec workflow produced, not from the diff
alone.

Order matters: **rebase → commit → push → open/update PR → verify mergeable.** Do not
open the PR before the branch is rebased and pushing succeeds.

**This skill opens PRs; it never merges them.** Code review on the open PR is the
safety net, so the bar for resolving a conflict yourself and proceeding is *low*: if a
resolution turns out wrong, it gets caught and corrected on the PR before merge — no
production damage is possible from this step alone. Lean toward resolving and opening
the PR, documenting every decision loudly (in `pr-rebase-log.md` and the PR body) so the
reviewer can check your work. Stopping to ask a human is the rare exception, reserved for
the cases in *Resolving Conflicts*.

This skill leaves three artifacts in `<spec-dir>` so its work is auditable after the fact:

- **`pr-rebase-log.md`** — a detailed record of the rebase: whether one was needed, the
  base it rebased onto, every conflict, how each was resolved and why, and how the
  resolution was verified.
- **`pr-message.md`** — the exact PR title and body it drafted and submitted.
- **`pr-url.json`** — the machine-readable PR URL the app reads to mark the spec's PR as
  submitted: `{ "url": "<pull request url>", "submittedAt": "<ISO 8601 timestamp>" }`.

All are written under `.specs/<slug>/`, which is untracked working state (see banner)
— write them directly with normal file writes.

## Resolve The Spec

Resolve `<spec-dir>` (the folder containing `spec.md`) like `spec-run`:

1. If `spec=<path>` or a `.specs/<slug>/` folder is given in `$ARGUMENTS`, use it.
2. Else the `.specs/<slug>/` folder named in the conversation.
3. Else the most recently modified `.specs/*/spec.md`.

If no spec resolves, this is not necessarily fatal — fall back to a plain branch PR
(skip artifact gathering) and say so in the completion report. A resolved spec makes a
richer PR body; its absence does not block opening the PR.

## Gather Spec Artifacts (for the PR body)

Read whatever exists in `<spec-dir>`; every file is **optional**. Skip any that are
missing without comment. Use them to draft the body, not to gate the PR.

| Artifact | Contributes to the PR body |
|---|---|
| `spec.md` | Intent, scope, and any `## Adaptations` log — the spine of the summary. |
| `requirements.md` | What was asked for — frame the "why". |
| `proposal.md` | The chosen architecture/design direction — frame the "how". |
| `critique.md` | Known concerns weighed during design — note unresolved ones. |
| `criteria.md` / `invariants.md` | Conformance guardrails the change was held to. |
| `audit.md` | Conformance verdict — surface pass/fail and any open items. |
| `spec-review.md` | Spec-level review outcome. |
| `reviews/branch-<n>-review.md` | **Latest** correctness-review verdict (highest `<n>`); state pass/needs-fix and any unresolved actionable findings. |
| `learnings/*-learning.md` | Notable trade-offs/decisions worth calling out. |
| `blockers.md` | **Open blockers — surface prominently** so reviewers see them. |

Distill, do not dump: the body is a reviewer's brief (what changed, why, how it was
verified, what remains), citing these artifacts — not their full text. If the latest
branch review is `needs-fix` or `blockers.md` is non-empty, say so plainly near the
top; do not bury an unmergeable-in-spirit state under a clean summary.

## Determine The Issue Number

Use `$ARGUMENTS` if a number is given. Otherwise, in order: the `Spec folder:` /
issue footer in `spec.md`, then the trailing number on the branch name (after the last
hyphen, or a standalone numeric path segment). If none resolves, open the PR without an
issue link.

## Stage 1 — Rebase To Mergeable

1. Resolve the default branch: `git symbolic-ref refs/remotes/origin/HEAD` (strip the
   `origin/` prefix), else the repo convention, else `main`/`master`. Call it `<base>`.
   If `HEAD` *is* `<base>`, stop — there is no feature branch to open a PR from.
2. `git fetch origin <base>`.
3. If the branch already contains `origin/<base>` (`git rev-list --count
   origin/<base>..HEAD` shows commits and `origin/<base>..` is an ancestor), it is up
   to date — skip to Stage 2.
4. Otherwise rebase: `git rebase origin/<base>`. **Always rebase when the branch is
   behind** — do not skip it and do not ask whether to.
   - **Clean rebase** → continue.
   - **Conflicts** → **resolve them yourself, do not default to stopping.** An LLM with
     the spec, the surrounding code, and both sides of the conflict in view is usually a
     better conflict-resolver than a human reading hunk markers, so this is the expected
     path, not the exception. See *Resolving Conflicts* below.
5. After a clean (or resolved) rebase, sanity-check mergeability locally: `git merge-tree
   $(git merge-base HEAD origin/<base>) HEAD origin/<base>` should report no
   conflicts. Since the branch now sits on `origin/<base>`, this should hold; if it does
   not, stop and report.
6. **Write `<spec-dir>/pr-rebase-log.md`** capturing what happened (see *The Rebase Log*
   below) — whether a rebase was needed, the base, every conflict and its resolution and
   rationale, and how each was verified. Write it even when no rebase was needed (a one-
   line "already current" entry), so the artifact always reflects this run.

### Resolving Conflicts

For each conflict, work from understanding, not from mechanically picking a side:

- Read both sides plus enough surrounding code to know *what each change was for*. Use
  the spec artifacts and `git log`/`git show` on the conflicting commits to recover
  intent. The right resolution usually **integrates both intents**, not "take ours" or
  "take theirs".
- Resolve, `git add` the file, and `git rebase --continue`. Repeat until the rebase
  finishes.
- After resolving, **verify**: build/typecheck and run the relevant tests if the project
  makes that quick. A resolution that compiles and passes is the bar — do not hand back
  a guess.

**When to loop in a person** — rarely, because the PR review catches a wrong
resolution before merge. Resolve and proceed even when you are *uncertain*, as long as
you can produce a working tree (it builds, tests pass) and you flag the uncertainty
loudly in `pr-rebase-log.md` and the PR body so the reviewer scrutinizes it. Only
`git rebase --abort` and stop when you genuinely *cannot* land a trustworthy resolution:
the two sides encode irreconcilable intent you cannot reconstruct from the spec or
history, or tests fail in a way you cannot fix. Even then, prefer opening the PR with the
conflict isolated and clearly called out over blocking — a flagged, reviewable PR beats a
halted one. When you do stop, restore the pre-rebase state and report the specific
conflict and *why* it is unresolvable — not a generic "there were conflicts". Never leave
a half-finished rebase in the working tree.

### The Rebase Log

Write `<spec-dir>/pr-rebase-log.md` after Stage 1. Make it specific enough that a
reviewer can re-derive every decision:

- **Header**: the run's date, the branch, the resolved base and its tip SHA, and the
  pre-rebase HEAD SHA.
- **Outcome**: `already-current` | `clean-rebase` | `resolved-conflicts` | `aborted`.
- **Per conflict** (when any): the file, a short description of each side's intent, the
  resolution chosen and *why*, whether it integrated both sides or took one, and any
  residual uncertainty flagged for review.
- **Verification**: the build/typecheck/test commands run after resolving and their
  results.

## Stage 2 — Commit Staged Changes

If there are staged changes, create a conventional commit for them (see the `commit`
skill's conventions). If nothing is staged, skip — do not invent a commit.

## Stage 3 — Push

Push the branch to origin. Because Stage 1 may have rewritten history, use
`git push --force-with-lease` (never a bare `--force`). If the lease check fails, the
remote moved under you — stop and report rather than overwriting someone else's push.

## Stage 4 — Draft The PR Message, Then Open Or Update The PR

1. Draft the PR title and body — the reviewer's brief from *Gather Spec Artifacts*:
   - Title: short, imperative, under 70 characters.
   - Body: what changed and why, how it was verified, what remains. Footer links the
     spec folder (`Spec folder: .specs/<slug>/`) and, if an issue was resolved, adds a
     closing reference (`Closes #<n>`). If the rebase resolved conflicts — especially any
     flagged uncertain in `pr-rebase-log.md` — call them out here so the reviewer checks
     them.
2. **Write the title and body to `<spec-dir>/pr-message.md`** before submitting, and
   submit *from* that file (`gh pr create --title … --body-file <spec-dir>/pr-message.md`,
   or `gh pr edit --body-file …`). The artifact and the PR stay identical because they
   share one source.
3. Check for an existing open PR for this branch: `gh pr view --json number,url,state`.
   - **No PR exists** → create it from `pr-message.md`.
   - **PR exists** → update its body from `pr-message.md` (`gh pr edit`); the force-push
     already refreshed the diff. Do not open a duplicate.
4. **Write `<spec-dir>/pr-url.json`** with the URL of the PR just opened or updated, as
   JSON: `{ "url": "<pull request url>", "submittedAt": "<ISO 8601 timestamp>" }`. Use the
   PR URL `gh` returned (or `gh pr view --json url`) and the current time. Overwrite it on
   every run so it always reflects the latest PR for this branch (create or update).
5. **Register both artifacts with `track_file`** so the app sees them: call `track_file`
   once for `pr-message.md`'s repoRelPath and once for `pr-url.json`'s repoRelPath.

## Stage 5 — Verify Mergeable, Then Report

1. Query mergeability: `gh pr view --json mergeable,mergeStateStatus,url`. GitHub
   computes this asynchronously, so a brief `UNKNOWN` right after push is normal —
   re-query once or twice before concluding.
2. Report:
   - PR URL and whether it was created or updated.
   - Whether a rebase ran (and onto what) or the branch was already current; if
     conflicts arose, which files conflicted, how each was resolved, and how the
     resolution was verified.
   - Mergeability: `MERGEABLE` / `CONFLICTING` / still computing — and, if not
     mergeable, what blocks it.
   - The spec artifacts that informed the body, the latest branch-review verdict, and
     any open `blockers.md` items surfaced.
   - The linked/closed issue, if any.
   - The paths to the artifacts written this run: `<spec-dir>/pr-rebase-log.md`,
     `<spec-dir>/pr-message.md`, and `<spec-dir>/pr-url.json`.

If mergeability comes back `CONFLICTING` despite a clean local rebase, the base moved
between fetch and push — say so and recommend re-running this skill.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model
attribution.
