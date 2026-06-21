---
name: spec-branch-review
description: This skill should be used when the user or the spec-branch-refine loop asks to code-review or correctness-check the whole branch for bugs at the end of implementation. Reviews the branch diff (committed merge-base..HEAD by default, or the working tree including untracked files with scope=working-tree) in one spec-aware pass and writes structured findings — a machine-readable YAML block plus prose — to reviews/branch-<i>-review.md. It runs a fixed core review (correctness, reference/contract integrity, security, simplification, AI-authorship tells) and fans out specialized lenses by risk (design, deep-security, data/deployment, dependency, performance, test-quality), delegating to existing skills where available. Read-only — it never edits code and never re-checks conformance (that is spec-audit). spec-branch-fix consumes its output. Trigger on "review the branch", "code-review the branch", "branch correctness review", "find bugs across the branch", or "spec branch review".
mode: review
scope: document
capability: reviewer
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>] [iter=<n>] [scope=committed|working-tree] [base=<ref>] [since=<commit>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "5"
---

# Spec Branch Review

Review the whole branch for **correctness** defects in one pass and write the
findings to `reviews/branch-<iteration>-review.md`. This is the read-only half of
the branch *correctness* loop driven by `spec-branch-refine`: it finds bugs; its
partner `spec-branch-fix` reads the file and applies fixes. This skill never edits
code.

This is correctness, not conformance. `spec-audit` checks the branch against
`criteria.md`; this skill is the orthogonal bug-hunt the project otherwise
outsourced to roborev. It is spec-aware — it has the whole spec, every subspec, and
every learning — so it can tell an intended design from a defect far better than a
blind diff review can.

## Operating Context

One iteration of the end-of-run branch loop:

```txt
spec-branch-refine (loop) → spec-branch-review → spec-branch-fix → re-review …
                            (this skill)          (apply fixes)
```

`spec-branch-refine` calls this skill with the current `iter` and stops the loop
when this skill returns `pass`. The skill is also runnable standalone for a one-off
branch review. Single pass per call: review once, write the file, stop.

## Non-Interactive Operation

This skill runs to completion without user interaction. Make well-grounded
judgement calls from the diff, the spec, and the repository; do not pause for
confirmation. Stop only when a required input is genuinely missing and cannot be
inferred; report what is missing and halt.

## Resolve Inputs

- **Spec.** If `spec=<path>` or a `.specs/<slug>/` folder is supplied, use it
  exactly. Otherwise resolve like `spec-run`: a path in the arguments, else the
  folder named in the conversation, else the most recently modified
  `.specs/*/spec.md`. `<spec-dir>` is the folder containing it. If no spec
  resolves, stop and report.
- **Iteration.** Use `iter=<n>` when given. Standalone default: one higher than the
  highest existing `<spec-dir>/reviews/branch-<k>-review.md`, or `1` if none exist.
- **Comparison base.** Resolve the point the branch is diffed against, in this order:
  - `base=<ref>` — use `merge-base(<ref>, HEAD)`. The base is treated like a branch to
    fork-point from, not a raw endpoint.
  - `since=<commit>` — use `<commit>` directly as the base, giving the range
    `<commit>..HEAD` (exclusive of `<commit>` itself, like any git range).
  - neither — use `merge-base(<default-branch>, HEAD)`, resolving the default branch
    from the repo (`git symbolic-ref refs/remotes/origin/HEAD`, else the project
    convention, else `main`/`master`).

  Call the resolved point `<base>`. **Refuse ambiguous targets:** if `HEAD` is the
  default branch and neither `base` nor `since` was given, there is no branch to diff
  — stop and report. Never silently review the default branch against itself.
- **Scope.** Default `scope=committed`. Review the whole range, not a single commit:
  - `scope=committed` (default) — `<base>..HEAD`. Changed files:
    `git diff --name-only <base>..HEAD`; diff: `git diff <base>..HEAD`.
  - `scope=working-tree` — the committed range `<base>..HEAD` **plus** uncommitted and
    untracked changes layered on top. Enumerate the extra work with
    `git status --porcelain` (untracked files are the `??` entries) and review
    `git diff <base>` together with the contents of new untracked files. Use this for a
    standalone review of work not yet committed.
- **Dirty-tree handling.** In `scope=committed`, if `git status --porcelain` is
  non-empty, the working tree has uncommitted or untracked changes this review does
  **not** see. Keep the `scope` field a pure enum and record the exclusion in the
  separate `excluded_worktree_changes` count and `scope_note` string (see Emit) so a
  reader — and a parser — knows live work was excluded. This is the failure mode that
  would otherwise let the review silently miss its own untracked files.

## Load Spec-Aware Context

Read for judgement (not to re-run conformance):

- `spec.md` — the whole intent, plus any `## Adaptations` log.
- Every `<spec-dir>/subspecs/*-spec.md` — what each step meant to do.
- Every `<spec-dir>/learnings/*-learning.md` — what each step discovered and any
  recorded trade-offs. Do not flag a recorded, deliberate trade-off as a bug.
- `criteria.md` / `invariants.md` are background only. Never convert their `Check:`
  commands or grep patterns into findings — conformance is `spec-audit`'s job.

## Load Prior Dismissals (dedup)

Read every earlier `<spec-dir>/reviews/branch-<k>-fix.md` (`k < iter`) and collect
the **signatures** of `dismissed` findings **with their dismissal class**. This is
the loop's anti-thrash memory, but not every dismissal class suppresses re-raise —
only the ones that mean "this is not a bug" do:

| Dismissal class | Suppress re-raise? |
|---|---|
| `false-positive` | Yes — the finding was wrong. |
| `intentional` | Yes — the code is deliberate. |
| `accepted-risk` | Only when the fix decision has `approved: true`; otherwise re-raise. |
| `deferred` | No — it is a real, unaddressed defect. Keep surfacing it. |
| `unfixable` | No — real but blocked; keep surfacing so the human sees it. |

- Do **not** re-raise a finding whose signature matches a suppressing dismissal:
  `false-positive`, `intentional`, or an `accepted-risk` whose decision carries
  `approved: true`.
- Re-raise `deferred` and `unfixable` signatures normally; they are unresolved bugs,
  not settled disagreements.
- If you believe a *suppressing* dismissal was itself wrong, you may re-raise it —
  but only as a clearly marked new finding (`re-raising: <sig> (dismissed
  <class> iter <k>)`) with explicit rationale. This surfaces real disagreement
  without letting the loop oscillate silently.

## Review: Fixed Core + Conditional Fan-Out

Run the review in subagents when the harness supports them, so the reviewer stays
independent of the later fixer. Merge all findings into one file.

### Core review (always runs)

One pass over the whole branch diff applying five lenses — the same bug classes as
`spec-step-review`, plus branch-level reference/contract integrity and an
AI-authorship pass, across the integrated change where cross-step interactions live:

1. **Correctness / logic** — boundary and null/empty errors, wrong conditions,
   unhandled errors and rejections, races and ordering, resource leaks, broken
   async, data-integrity gaps, and **integration bugs** the per-step reviews could
   not see (mismatched contracts between steps, a caller and callee that disagree,
   state set in one step and misread in another).
2. **Reference & contract integrity** — the cross-file consistency that only a
   whole-branch view can check, and the highest-yield class an integrated review
   adds over per-step review. Two sub-checks:
   - **Reference existence** — every symbol, import, file path, route, env var,
     config key, CLI flag, or feature flag the branch *references* actually exists
     in the branch's end state. Flag the dangling ones: a call to a function that
     was renamed or never added, an import of a deleted module, a config key read
     but never defined, a flag a command passes that the callee removed.
   - **Producer/consumer agreement** — where one part of the branch produces a
     value, shape, or interface another part consumes, confirm they still agree
     across the *whole* diff: a changed function signature and its call sites, a
     renamed field and its readers, a removed return value still destructured, an
     event emitted with one payload and handled expecting another. A rename or
     removal applied in one place but not its mirror is the canonical defect here.
3. **Security** — injection, missing validation on trust boundaries, authz/ownership
   gaps, secrets, unsafe deserialization, weak crypto/randomness. Flag what the
   branch introduces or exposes.
4. **Simplification / maintainability** — abstractions that don't earn their keep,
   dead/duplicated code, needless indirection (almost always advisory).
5. **AI-authorship tells** — this branch was written by an LLM (`spec-step-run`), so
   hunt the failure modes current models still produce that slip past ordinary
   review: invented methods or options on a third-party library or framework API
   that the dependency does not actually expose (hallucinated dependency
   symbols — repo-internal dangling references belong to lens 2); copy-paste
   blocks left with stale identifiers from the source context (a renamed concept
   whose body still names the old entity); over-broad `catch`/`except` that swallows
   the real error, or a silent fallback to empty/zero/null that masks failure instead
   of surfacing it; collection or key access that assumes non-empty/present without
   checking; and reinvented helpers that duplicate something already in the repo.
   File each under its **natural category** — a hallucinated call or swallowed error
   is `correctness`, a reinvented helper is `simplification`. This lens is a hunting
   heuristic, not a new category, and it never re-flags a trade-off the learnings
   already record as deliberate.

### Conditional fan-out (fan out by risk, not by habit)

After the core pass, run a specialized lens for **each risk trigger the diff fires**
— often none, sometimes several. Fan out by what the branch actually touches, not
by rote. When the harness supports subagents, run each fired lens as its own
parallel read-only subagent so lenses stay independent; merge every lens's findings
into the one review file, deduped by signature.

Each lens below names its trigger and what it looks for. Where an existing skill
covers the lens, **delegate to it when available** and record which you used; if it
is not available in this workspace, run the inline checklist instead — never skip a
fired lens because its preferred skill is absent.

- **Design / UX** — trigger: the diff touches UI/component/style files
  (`.tsx`/`.jsx`/`.vue`/`.svelte`/`.css`/`.scss` or component/view directories) **or**
  the spec's Applicable Rules list design rules. Looks for: design-system token
  drift, missing UX states (loading/empty/error/disabled), and accessibility
  regressions. Delegate to `design-align` or `ux-auditor` when available.
- **Deep security** — trigger: the diff touches auth, crypto, secrets, sessions,
  tokens, permissions, or access-control paths. Looks for: authz/ownership gaps,
  token/session handling, secret exposure, weak crypto/randomness — beyond the core
  baseline. Delegate to the `security-review` skill when available; otherwise run an
  inline deep-security checklist covering those classes.
- **Data / deployment** — trigger: the diff adds or changes migrations, persistent
  schema, queues, or rollout/config. Looks for: destructive or locking migrations,
  back-compat with existing data/in-flight messages, deployment-ordering hazards,
  and unsafe rollback.
- **Dependency** — trigger: package manifests, lockfiles, or new third-party imports
  changed. Looks for: unjustified or duplicate dependencies, known-vulnerable or
  unmaintained packages, and avoidable bundle/footprint growth.
- **Performance** — trigger: the diff touches hot paths, loops over large
  collections, rendering loops, or database/network access. Looks for: N+1 queries,
  blocking work in async contexts, needless re-computation/re-render, missing
  pagination, and unbounded growth.
- **Test quality** — trigger: the diff changes tests, **or** changes high-risk
  behavior (auth, money, data integrity) with thin or absent test evidence. Looks
  for: tests that assert implementation detail over behavior, brittle/flaky timing
  or order dependence, over-mocking that verifies nothing, and untested critical
  paths. This lens stays advisory — it never blocks the loop.

Record the lenses that ran on the `lenses:` field (and any delegated skill). A lens
that finds nothing still counts as run — list it so the record shows the risk was
checked, not skipped.

## Severity, Actionability, Verdict

Identical rule to `spec-step-review`:

- **Severity** `HIGH`/`MED`/`LOW`; **Category** `correctness`/`security`/`perf`/
  `simplification`/`design`.
- **Actionable** = `HIGH` or `MED` in `correctness` or `security`. All else is
  **advisory** (recorded, never loop-blocking). This split is what lets
  `spec-branch-refine` converge instead of looping on nits.
- **Verdict** = `needs-fix` if any actionable finding exists, else `pass`.
- Each finding carries a deterministic **signature** `category:file:symbol:gist`,
  where `symbol` is the nearest stable anchor — the enclosing function, method,
  class, or exported name (a heading or section anchor for non-code files). The line
  number is **not** part of identity; it churns when nearby code moves. Keep the line
  as a separate `line` field in the metadata block and for display only. `gist` is
  the 3–6 word essence. The same defect must produce the same signature on re-review.

## Emit The Review File

Write to:

```txt
<spec-dir>/reviews/branch-<iteration>-review.md
```

Create `reviews/` if needed. The file leads with a fenced YAML block — the
machine-readable contract that `spec-branch-fix` and `spec-branch-refine` parse —
followed by human-readable prose that only explains the findings. Downstream skills
read the YAML first; the prose is never parsed for control flow.

````txt
# Branch Review — iteration <iteration> (<feature-slug>)

```yaml
review:
  kind: branch
  iteration: <iteration>
  spec: <spec-dir>/spec.md
  target: <base-sha>..<head-sha>
  scope: committed | working-tree   # pure enum — never annotate this field
  excluded_worktree_changes: 0      # count of uncommitted/untracked files NOT reviewed (committed scope only)
  scope_note: ""                    # e.g. "3 uncommitted/untracked files were not reviewed"; "" when clean
  verdict: pass | needs-fix
  actionable: <count>
  advisory: <count>
  lenses: [correctness, reference-integrity, security, simplification, ai-authorship]   # plus any fired: design, deep-security, data-deploy, dependency, performance, test-quality
  findings:
    - id: F1
      severity: HIGH
      category: correctness
      actionable: true
      file: src/foo.ts
      line: 42
      symbol: resolveRoot
      signature: correctness:src/foo.ts:resolveRoot:caller passes unresolved root
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

### F1 · HIGH · correctness · src/foo.ts:resolveRoot (L42) · [actionable]
What: <one line>
Why:  <one line>
Fix:  <concrete suggested change>

### F2 · LOW · simplification · src/bar.ts:wrap (L10) · [advisory]
...

Review: <spec-dir>/reviews/branch-<iteration>-review.md (iteration <iteration>)
````

A clean branch stays minimal: `verdict: pass`, `actionable: 0`, an empty `findings: []`,
`## Findings\nNone`, and the locator line. A `pass` verdict is the signal
`spec-branch-refine` stops on.

## Completion Report

Report:

1. Spec path and iteration.
2. Review file path.
3. Verdict and actionable/advisory counts.
4. The lenses that ran (and any delegated skill), and any risk trigger that did not fire.
5. The scope and diff target (e.g. `committed merge-base..HEAD`), whether the working
   tree was dirty (and excluded), and how many prior dismissals were honored — by class.

Do not implement fixes — that is `spec-branch-fix`. Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
