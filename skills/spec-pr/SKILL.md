---
name: spec-pr
description: This skill should be used when the user asks to open or update a pull request for prepared spec-driven work. It rebases, commits staged changes, pushes, and drafts the PR from the spec, preparation report, guardrails, branch reviews, learnings, and blockers.
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "3"
---

# Spec PR

> **Spec artifacts live in the feature document folder — outside the git checkout.**
> Read and write them directly on the filesystem at the absolute paths you are given;
> do not run `git diff`/`log`/`status`/`show` on artifact paths to read or recover
> them — they are not in any repository, so git returning nothing there is expected,
> not an error. This is scoped to spec artifacts; the rebase and diff of the **code**
> are unaffected. The PR body *summarizes* these artifacts; the artifacts themselves
> are not part of the PR diff.

Open a pull request for spec-driven work that **is mergeable at the time it is
opened**. The common failure this skill removes: open a PR, then discover the branch
is behind the default branch and needs a rebase after the fact. This skill rebases
first, confirms the branch merges cleanly, *then* opens the PR — and drafts the PR
body from the full set of artifacts the spec workflow produced, not from the diff
alone.

Order matters: **rebase → commit → push → open/update PR → verify mergeable.** Do not
open the PR before the branch is rebased and pushing succeeds.

Do not infer, persist, or add GitHub issue linkage (including `Closes #...`) from a
standalone `spec-issue` run. Link an issue only when the user explicitly requests it
while invoking this skill.

**This skill does not test, type-check, or otherwise verify the change.** That work was
already done before this skill was invoked — if someone is opening the PR, the change is
considered ready. Do **not** run the test suite, type-checker, linter, or build as a
normal step. A clean rebase or an already-current branch goes straight to commit → push
→ PR with no test run. The *only* exception is verifying a **non-trivial** conflict
resolution during the rebase (see *Resolving Conflicts*), and even then you build/test
just the affected area — not the whole suite. "Verify mergeable" in the order above means
querying GitHub's merge status, not running anything locally.

**This skill opens PRs; it never merges them.** Code review on the open PR is the
safety net, so the bar for resolving a conflict yourself and proceeding is *low*: if a
resolution turns out wrong, it gets caught and corrected on the PR before merge — no
production damage is possible from this step alone. Lean toward resolving and opening
the PR, documenting every decision loudly (in `pr-rebase-log.md` and the PR body) so the
reviewer can check your work. Stopping to ask a human is the rare exception, reserved for
the cases in *Resolving Conflicts*.

This skill leaves three artifacts so its work is auditable after the fact:

- **`<spec-dir>/pr-rebase-log.md`** — a detailed record of the rebase: whether one was
  needed, the base it rebased onto, every conflict, how each was resolved and why, and
  how the resolution was verified.
- **`<spec-dir>/pr-message.md`** — the exact PR title and body it drafted and submitted.
- **`<machineStateRoot>/pr-url.json`** — the machine-readable PR URL the app reads to
  mark the spec's PR as submitted: `{ "url": "<pull request url>", "submittedAt": "<ISO 8601 timestamp>" }`.

`<spec-dir>` is the feature document folder — the folder outside the git checkout
holding `spec.md` and the other spec artifacts (the stanza's `artifactsRoot`).
`<machineStateRoot>` is the machine-state folder from the stanza
(`<documentRoot>/.restory/spec/`). Write the artifacts directly with normal file
writes at those absolute paths — atomically (temp file in the destination directory,
then rename), never inside the git checkout, and start each markdown artifact with a
level-1 `#` heading on line 1.

## Resolve The Spec

Resolve `<spec-dir>` (the feature document folder containing `spec.md`):

1. If the prompt includes a **# Canonical spec artifact paths** stanza, use its paths
   exactly — the `spec` path, `artifactsRoot`, `machineStateRoot`, and the listed
   `pr-rebase-log.md`, `pr-message.md`, and `pull request URL` locations. The stanza
   is the primary path source.
2. Else, if `spec=<path>` or a feature document folder is given in `$ARGUMENTS`, use it.
3. Else the feature document folder named in the conversation.
4. Else the directory containing the active working document file.

Never fall back to a spec folder inside a git checkout, and never create one there.
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
| `spec-prepare.md` | Preparation outcome and decisions. |
| `reviews/branch-<n>-review.md` | **Latest** correctness-review verdict (highest `<n>`); state pass/needs-fix and any unresolved actionable findings. |
| `step-<NNN>-learning.md` | Notable trade-offs/decisions worth calling out (per-step learnings, flat in the folder). |
| `blockers.md` | **Open blockers — surface prominently** so reviewers see them. |

Distill, do not dump: the body is a reviewer's brief (what changed, why, how it was
verified, what remains), citing these artifacts — not their full text. If the latest
branch review is `needs-fix` or `blockers.md` is non-empty, say so plainly near the
top; do not bury an unmergeable-in-spirit state under a clean summary.

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
- After resolving a **non-trivial** conflict, **verify just the affected area**:
  build/typecheck and run only the tests covering the files you touched, if the project
  makes that quick. A resolution that compiles and passes is the bar — do not hand back a
  guess. This is the one place the skill runs tests, and only to validate the resolution
  — not the change as a whole. Trivial conflicts (imports, adjacent non-overlapping edits,
  formatting) need no test run.

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

**When you genuinely cannot resolve — call `ask_user`.** The "stop and report" above
assumes a human is watching a terminal. When this skill runs as the **app assistant**,
that step is MCP `ask_user`: before you `git rebase --abort`, call `ask_user` with
concrete options and consequence-oriented context, then act on the user's choice. This is
required only for the **unresolved-conflict** case above (irreconcilable intent, or tests
failing in a way you cannot fix) — it is **not** for merely-uncertain resolutions, which
you still resolve, verify, flag in `pr-rebase-log.md`, and proceed with so the open PR can
catch a wrong call. That keeps the resolve-and-proceed default and the
rebase → commit → push → PR ordering intact. Offer concrete options, for example:

- **Option A — abort the rebase and stop**: `git rebase --abort` and restore the
  pre-rebase state. *Consequence: nothing is published; the conflict stays unresolved;
  resolve it manually or re-run this skill.*
- **Option B — push the non-conflicting commits and open the PR with the conflict
  isolated**: leave the unresolved conflict clearly called out in `pr-rebase-log.md` and
  the PR body. *Consequence: the reviewer sees the conflict surfaced on a reviewable PR
  instead of a halted workflow.*
- **Option C — retry the resolution with a hint you supply**: the user gives intent for
  the conflicting region and you attempt the resolution again. *Consequence: another
  attempt that may still fail and need Option A or B.*

Note in `pr-rebase-log.md` that `ask_user` was invoked and which option was chosen.

### The Rebase Log

Write `<spec-dir>/pr-rebase-log.md` after Stage 1. Make it specific enough that a
reviewer can re-derive every decision:

- **Header**: the run's date, the branch, the resolved base and its tip SHA, and the
  pre-rebase HEAD SHA.
- **Outcome**: `already-current` | `clean-rebase` | `resolved-conflicts` | `aborted`.
- **Per conflict** (when any): the file, a short description of each side's intent, the
  resolution chosen and *why*, whether it integrated both sides or took one, and any
  residual uncertainty flagged for review.
- **Verification** (only when non-trivial conflicts were resolved): the build/typecheck/test
  commands run against the affected area and their results. Omit this section entirely for
  an `already-current`, `clean-rebase`, or trivial-conflict outcome — nothing was run.

## Stage 2 — Commit Staged Changes

If there are staged changes, create a conventional commit for them (see the `commit`
skill's conventions). If nothing is staged, skip — do not invent a commit.

## Stage 3 — Push

Push the branch to origin. Because Stage 1 may have rewritten history, use
`git push --force-with-lease` (never a bare `--force`). If the lease check fails, the
remote moved under you — this is **remote divergence**: never overwrite someone else's
push silently. When running as the app assistant, **call MCP `ask_user`** with concrete
options and consequence-oriented context before either aborting or forcing, for example:

- **Option A — re-fetch, rebase onto the updated remote, and retry the push**: re-run
  Stage 1 against the refreshed `origin/<base>`, then retry this push. *Consequence:
  integrates the other push; the re-rebase may produce conflicts you must resolve.*
- **Option B — stop and report**: *Consequence: nothing new is published; coordinate with
  the other contributor before retrying.*

Do **not** bare-`--force`, and do **not** retry `--force-with-lease` to override commits
the lease check identified as foreign.

## Stage 4 — Draft The PR Message, Then Open Or Update The PR

1. Draft the PR title and body — the reviewer's brief from *Gather Spec Artifacts*:
   - Title: short, imperative, under 70 characters.
   - Body: what changed and why, how it was verified, what remains. Footer links the
     spec folder (`Spec folder: <absolute path of the feature document folder>/`). If the rebase resolved conflicts — especially any
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
4. **Write `<machineStateRoot>/pr-url.json`** with the URL of the PR just opened or updated,
   as JSON: `{ "url": "<pull request url>", "submittedAt": "<ISO 8601 timestamp>" }`. Use the
   PR URL `gh` returned (or `gh pr view --json url`) and the current time. Overwrite it on
   every run so it always reflects the latest PR for this branch (create or update).
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
   - The paths to the artifacts written this run: `<spec-dir>/pr-rebase-log.md`,
     `<spec-dir>/pr-message.md`, and `<machineStateRoot>/pr-url.json`.

If mergeability comes back `CONFLICTING` despite a clean local rebase, the base moved
between fetch and push — say so and recommend re-running this skill.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model
attribution.
