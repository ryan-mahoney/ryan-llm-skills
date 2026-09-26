---
name: spec-branch-review
description: "Independently audit an implemented spec branch and its executable evidence. Use from spec-branch-refine or when asked to prove the integrated branch is correct, safe, and claim-complete before publication."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "[spec=<path/to/spec.md>] [iter=<n>] [scope=committed|working-tree] [base=<ref>] [since=<commit>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "15"
---

# Spec Branch Evidence Audit

> **`.specs/` is standalone working state and is often gitignored.** Read and write it directly; do not depend on git history to recover it. Diffing implementation code under review is unaffected.

Read the shared [Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Independently audit the whole branch for correctness, integration, prepared-guardrail, and evidence-closure defects, then write the
findings to `reviews/branch-<iteration>-review.md`. This is the read-only half of
the branch evidence loop driven by `spec-branch-refine`: it finds bugs and invalid proof; its
partner `spec-branch-fix` reads the file and applies fixes. This skill never edits
code.

This is the independent final evidence boundary before the work tour. It must not trust
the implementer's readiness conclusion. It receives intent, implementation, and produced
evidence so it can try to falsify claims against the integrated branch. Its recall comes
from per-commit decomposition plus claim/failure/gate auditing.

## Operating Context

One iteration of the end-of-run branch loop:

```txt
spec-branch-refine (loop) → spec-branch-review → spec-branch-fix → re-review …
                            (this skill)          (apply fixes)
```

`spec-branch-refine` calls this skill with the current `iter` and stops the loop
when this skill returns `pass`. The skill is also runnable standalone for a one-off
branch review. Single pass per call: review once, write the file, stop.

## Autonomous Audit

Make ordinary audit judgments from sourced context, the diff and observed evidence. Route an
unresolved consequential decision to the coordinator under the shared context contract; do not
infer acceptance or authority. Continue independent audit work and report affected merge claims
as incomplete. A pending later-phase authorization does not itself invalidate merge evidence. When an essential audit input is genuinely unavailable, report `missing input: <name>` and stop.
For consequential decisions discovered during an otherwise possible audit, write the findings
and incomplete affected merge claims, then return `decision-required` with the exact decision.

## Resolve Inputs

- **Spec.** Resolve `spec=<path>` or an explicit `.specs/<feature>/` folder first;
  otherwise use the folder named in the conversation or the `Spec folder:` footer.
  If exactly one `.specs/*/spec.md` exists, use it. If more than one matches, stop.
  Do not select by modification time. `<spec-dir>` is that `.specs/<feature>/` folder.
- **Iteration.** Use `iter=<n>` when given. Standalone default: one higher than the
  highest existing `<spec-dir>/reviews/branch-<k>-review.md`, or `1` if none exist.
- **Comparison base.** Resolve the point the branch is diffed against, in this order:
  - `base=<ref>` — use `merge-base(<ref>, HEAD)`. The base is treated like a branch to
    fork-point from, not a raw endpoint.
  - `since=<commit>` — use `<commit>` directly as the base, giving the range
    `<commit>..HEAD` (exclusive of `<commit>` itself, like any git range).
  - neither — use `merge-base(<default-branch>, HEAD)`, resolving the default branch
    from the repo (`git symbolic-ref refs/remotes/origin/HEAD`, else `main`/`master`).

  Call the resolved point `<base>`. **Refuse ambiguous targets:** if `HEAD` is the
  default branch and neither `base` nor `since` was given, there is no branch to diff
  — report `out of scope: HEAD is the default branch (pass base= or since=)`, write no
  review file, and stop. Never silently review the default branch against itself.
- **Scope.** Default `scope=committed`. Review the whole range, not a single commit:
  - `scope=committed` (default) — `<base>..HEAD`. Changed files:
    `git diff --name-only <base>..HEAD`; diff: `git diff <base>..HEAD`.
  - `scope=working-tree` — the committed range `<base>..HEAD` **plus** uncommitted and
    untracked changes layered on top. Enumerate the extra work with
    `git status --porcelain` (untracked files are the `??` entries) and review
    `git diff <base>` together with the contents of new untracked files. Use this for a
    standalone review of work not yet committed.

  If `<base>..HEAD` contains no commits: in `committed` scope, report
  `nothing to review: <range>`, write no review file, and stop. In `working-tree`
  scope, review only the uncommitted and untracked changes and set
  `commits_reviewed: 0`.
- **Dirty-tree handling.** In `scope=committed`, if `git status --porcelain` is
  non-empty, the working tree has uncommitted or untracked changes this review does
  **not** see. Keep the `scope` field a pure enum and record the exclusion in the
  separate `excluded_worktree_changes` count and `scope_note` string (see Emit) so a
  reader — and a parser — knows live work was excluded. This is the failure mode that
  would otherwise let the review silently miss its own untracked files.
  When excluded changes can affect code, tests, evidence, configuration, migrations,
  or deployment, emit an actionable evidence finding; a commit-bound pass cannot omit
  part of the candidate state.

## Load Spec-Aware Context

Read for judgement:

- `context.md` and current project sources — users/data/compatibility, release model, authority,
  decision provenance, and deliberate omissions; check snapshot hashes and material changes.
- `spec.md` — the whole intent, plus any `## Adaptations` log.
- `evidence-plan.json` — the posture and AC → CL → FH → EV graph.
- `merge-evidence.json` and `merge-evidence.md` — produced gate results and proof boundaries.
- Every `step-<NNN>-subspec.md` in `<spec-dir>` — what each step meant to do (per-step
  artifacts live flat in the spec folder, step numbers zero-padded to three digits).
- Every `step-<NNN>-learning.md` in `<spec-dir>` — what each step discovered and any
  recorded trade-offs. A sourced, applicable deliberate trade-off is not a bug; a learning alone
  cannot accept material risk — the canonical
  exclusion list lives in Report Discipline.
- `criteria.md` — consume only prose `Statement:` values.
- `invariants.md` — consume only live invariant statements not marked superseded.

Missing required evidence artifacts are blocking findings, not optional context.

### Executable-evidence lens (always runs)

For every claim, independently inspect its sourced necessity and phase, acceptance source, changed production path,
failure hypotheses, gate implementation, recorded execution, artifact, proof boundary,
environment, and commit binding. Re-run focused gates only when safe, authorized and useful. Select adversarial cases for
credible remaining failures at material boundaries; do not add a case solely to meet a quota.
Reuse sufficient evidence and record why it rejects the failure. Later-phase pending gates are
honest handoffs, not instructions to perform live verification. Confirm that:

- every AC and material deployment obligation maps to a falsifiable claim;
- every credible failure hypothesis has a gate capable of rejecting it;
- gates exercise real production composition where the claim is runtime-facing;
- negative policy/data/security paths and applicable recovery obligations fit actual exposure;
- new flags, environment variables, compatibility paths, release machinery and maintained proof
  tooling each have a sourced need; explicit context constraints and deliberate omissions hold;
- merge, deploy and post-deploy claims/gates are separate and no gate grants operational authority;
- visual work has inspected states/viewports and a deterministic QA handoff;
- gate results and artifacts describe the current HEAD and disclose proof limits;
- no readiness conclusion depends on future human review or required manual QA.

Emit a `category: evidence` finding for a missing, stale, irrelevant, circular,
unreproducible, under-independent, or overstated gate. Evidence findings are actionable
whenever they leave a merge-blocking claim unproven, regardless of code-change size.

### Bounded guardrail lens

After correctness/integration review, check the sourced constraints and deliberate omissions in `context.md`, observable acceptance
criteria and step obligations in `spec.md`, criteria `Statement:` values, and live invariants. Do not execute embedded commands, invent checks, inspect retired
audit artifacts, or expand into a second conformance program. A concrete mismatch is
an ordinary finding with `category: guardrail`, the same evidence, signature,
severity, actionability, dismissal, fix, and re-review lifecycle as every other
finding. Do not create a separate verdict or report.

## Load Prior Dismissals (dedup)

Read every earlier `<spec-dir>/reviews/branch-<k>-fix.md` (`k < iter`) and collect
the **signatures** of `dismissed` findings **with their dismissal class**. This is
the loop's anti-thrash memory, but not every dismissal class suppresses re-raise —
only the ones that establish no unresolved applicable defect do. An agent-generated
assumption, spec sentence, or learning does not authorize material risk acceptance:

| Dismissal class | Suppress re-raise? |
|---|---|
| `false-positive` | Yes — the finding was wrong. |
| `intentional` | Only for behavior justified by sourced requirements/context, not merely deliberate defects. |
| `accepted-risk` | Only when `approved: true` cites a prepared decision grounded in current user authorization or project policy; otherwise re-raise. |
| `deferred` | No — a real, unaddressed defect. Re-raise it each iteration. |
| `unfixable` | No — real but blocked. Re-raise it so the final verdict remains blocked. |

- Do **not** re-raise a finding whose signature matches a suppressing dismissal:
  `false-positive`, `intentional`, or an `accepted-risk` whose decision carries
  `approved: true`, after verifying the source meets the table's conditions.
- Re-raise `deferred` and `unfixable` signatures normally; they are unresolved bugs,
  not settled disagreements.
- If you believe a *suppressing* dismissal was itself wrong, you may re-raise it —
  but only as a clearly marked new finding (`re-raising: <sig> (dismissed
  <class> iter <k>)`) with explicit rationale. This surfaces real disagreement
  without letting the loop oscillate silently.

## Review: Per-Commit Passes + Aggregation

Recall comes from **structure**, not a cleverer prompt: review every commit
individually (a small, focused diff), store each finding, then aggregate the
per-commit findings and keep the ones that still persist in the final tree. A single
pass over the whole combined diff skims a thousand-plus lines across a dozen commits
and quietly misses the localized defects a focused per-commit read catches every
time: a non-atomic read-modify-write race, a `catch` that swallows a post-`rename`
error, one error type where the rest of the module raises another, an untested
validation branch. Review the small units, never only the combined blob.

**Fan-out rule.** When the harness supports subagents, run every review pass in
read-only subagents — the reviewer stays independent of the later fixer and the
per-commit passes run in parallel. Merge all findings, deduped by signature, into
the one review file. The stages and lenses below reference this rule.

### Core review (always runs) — decompose, review per commit, then aggregate

The core review applies five lenses (correctness, reference/contract integrity,
security, simplification, and AI-authorship), but
in three stages instead of one combined pass:

**Stage A — Decompose the range into commits.** List `git rev-list --reverse
<base>..HEAD`; each commit is a review unit. Map commits to steps using the `commit:`
field of the `learning:` YAML block in `step-<NNN>-learning.md`, an explicit step
marker in the commit subject (for example `step 3:` or `(step 3)`), or spec order as
a last resort. Give each reviewer that step's immutable subspec intent. If a commit
maps to no step, review it against `spec.md` alone and record `step: none` in its
findings' context.

**Stage B — Per-commit review pass (the recall engine).** For each commit, review
**that commit's own diff** (`git show <sha>`), not the combined diff, applying the
localized lenses — 1 (correctness), 3 (security), 4 (simplification), 5
(AI-authorship) — to its small, focused change, seeded with the step's subspec intent.
Fan out one subagent per commit (per the fan-out rule above) so each stays focused
on its unit. Every commit gets a focused pass. Across refine iterations: if the
previous fix did not touch a commit's files, you can reuse its prior per-commit
result. Re-review only the commits the last fix changed. Always re-run Stage C.

**Stage C — Aggregate + integrate (the range layer).** Over the union of fresh
per-commit findings plus the integrated end state:

- **Carry forward** each per-commit finding that **still persists in the final tree**,
  and **drop** any a later commit already fixed — a defect introduced at commit C and
  resolved at C+3 is not a branch finding.
- Run **lens 2 (reference & contract integrity)** here, and only here — it is
  inherently whole-branch and invisible commit-by-commit: a rename applied in one
  commit but not its mirror, a signature changed in one step and miscalled in another.
- Add the cross-commit/integration findings no single commit reveals, then **dedup by
  signature** so a defect that recurs across commits is reported once.

**Stage D — Semantic precedent and duplication pass.** After the integrated
end-state review, run a repository precedent search for the branch's new or changed
behaviors. When this turn exposes the `code_search` MCP tool, prefer it: search by
behavior and responsibility (for example "resolve feature worktree code index
status", "track generated review artifact", "parse branch review verdict"), not only
by newly introduced symbol names. For each meaningful hit, switch to exact search
(`rg`) and direct file reads to confirm whether the branch duplicates an existing
helper, store, parser, route, UI state model, or workflow. If `code_search` is not
available, perform the same pass with exact search only and record that semantic
search was unavailable.

This pass is mandatory for the branch review because duplicated/reinvented
functionality is often invisible in a narrow diff. Report only confirmed overlap:
state the existing implementation, the new implementation, and the concrete harm
(divergent behavior, stale copy, future fix needing two edits, broken single source
of truth). If both implementations intentionally serve different contracts, do not
flag the similarity.

The five lenses (Stage B runs 1, 3, 4, 5 per commit; Stage C runs 2 plus the
aggregation):

1. **Correctness / logic** — boundary and null/empty errors, wrong conditions,
   unhandled errors and rejections, races and ordering, resource leaks, broken
   async, data-integrity gaps, and **integration bugs** the per-commit passes could
   not see (mismatched contracts between steps, a caller and callee that disagree,
   state set in one step and misread in another).
2. **Reference & contract integrity** (Stage C — whole-branch) — the cross-file
   consistency that only a whole-branch view can check, and the highest-yield class an
   integrated review adds beyond isolated per-commit passes. Two sub-checks:
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
   dead/duplicated code, needless indirection, and internal-contract inconsistencies
   (a docstring that contradicts the code's behavior, one error type where the rest
   of the module raises another, a caller that cannot discriminate the failure).
   Duplicated/reinvented behavior must be grounded in Stage D's repository search,
   preferably `code_search` plus exact confirmation. These are usually
   `LOW`/advisory — still always emitted (see Severity, Actionability, Verdict).
5. **AI-authorship tells** — this branch was written by an LLM (`spec-step-run`), so
   hunt the failure modes current models still produce that slip past ordinary
   review: invented methods or options on a third-party library or framework API
   that the dependency does not actually expose (hallucinated dependency
   symbols — repo-internal dangling references belong to lens 2), judged from the
   project's dependency manifest and lockfile rather than memory, which may be stale
   on recent APIs; **misunderstood** third-party behavior — a dependency call that
   *exists* and typechecks but whose runtime contract was assumed wrongly (a callback
   fed each delta versus the cumulative text, an iterator's order or termination,
   mutation-in-place versus a copy, a rejection versus a thrown error), judged from
   the dependency's own source or type definitions rather than memory; copy-paste
   blocks left with stale identifiers from the source context (a renamed concept
   whose body still names the old entity); over-broad `catch`/`except` that swallows
   the real error, or a silent fallback to empty/zero/null that masks failure instead
   of surfacing it; collection or key access that assumes non-empty/present without
   checking; reinvented helpers that duplicate something already in the repo
   according to the semantic precedent pass; and **over-editing** — a fix or step
   that rewrites or restructures working code beyond what the change required (a
   function reshaped where a localized edit sufficed, nesting or branching the
   original lacked), which passes every test and so slips past every gate but this
   review.
   File each under its **natural category** — a hallucinated call or swallowed error
   is `correctness`, a reinvented helper or needless rewrite is `simplification`. This
   lens is a hunting heuristic, not a new category; it honors the Report Discipline
   exclusions.

### Conditional fan-out (fan out by risk, not by habit)

After the core pass, run a specialized lens for **each risk trigger the diff fires**
— often none, sometimes several. Fan out by what the branch actually touches, not
by rote. Run each fired lens as its own subagent per the fan-out rule, so lenses
stay independent.

Each lens below names its trigger and what it looks for. When a fired lens has a
matching skill available, **delegate to it**. Record which skill you used. If the
skill is not available in this workspace, run that lens's inline checklist. Never
skip a fired lens because its preferred skill is absent.

- **Design / UX** — trigger: the diff touches UI/component/style files
  (`.tsx`/`.jsx`/`.vue`/`.svelte`/`.css`/`.scss` or component/view directories) **or**
  the spec's Applicable Rules list design rules. Looks for: design-system token
  drift, missing UX states (loading/empty/error/disabled), and accessibility
  regressions. When `design-align` or `ux-auditor` is available, delegate to it. When
  the branch has a reachable dev server, Storybook, or component harness, render the
  changed views before judging them. Establish eyes with `see`. Capture with
  `uishot` at the default viewport and at 320px. Cite what you saw. Layout
  breakage, clipping, and contrast failures do not appear in a diff. When nothing
  renders, review from source and record the lens as source-only rather than
  implying the UI was seen.
- **Deep security** — trigger: the diff touches auth, crypto, secrets, sessions,
  tokens, permissions, or access-control paths. Looks for: authz/ownership gaps,
  token/session handling, secret exposure, weak crypto/randomness — beyond the core
  baseline. When the `security-review` skill is available, delegate to it; otherwise
  run an inline deep-security checklist covering those classes.
- **Data / deployment** — under the resolved data value, compatibility commitments and established
  release process; schema changes over disposable fixtures do not imply live migration machinery. Trigger: the diff adds or changes migrations, persistent
  schema, queues, or rollout/config. Looks for: destructive or locking migrations,
  required compatibility with retained data/in-flight messages, deployment-ordering hazards,
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

## Report Discipline (every lens, every finding)

These rules apply to the core lenses and to every fired lens. (The advisory
always-emit rule lives once in Severity, Actionability, Verdict.)

- **Concrete-harm mandate.** For each finding, state *what specifically goes wrong
  if it is not fixed* — a traced failure path (the interleaving, the input, the
  caller that breaks), not "violates best practices." If you cannot complete that
  sentence with concrete harm, **drop the finding**. This both kills nits and
  surfaces subtle real bugs: you cannot write the harm without simulating the
  failure. For an **internal-contract** finding — a docstring that contradicts its
  own code, an error type a caller cannot discriminate — the concrete harm *is* the
  future caller or maintainer the contract misleads: trace which wrong assumption
  that caller or maintainer makes, and do **not** drop it merely because nothing
  crashes today. (If a
  sourced requirement or authorized risk decision supports the recorded trade-off, it is
  intentional rather than an unaccepted defect — see the exclusions below.)
- **Severity by impact** (feeds the section below):
  - `HIGH` — data loss, security breach, crash, or incorrect results in the actual intended environment.
  - `MED` — degraded behavior under specific conditions, **or blocks future
    maintainability** (internal-contract drift, an error a caller cannot
    discriminate, a docstring that lies about behavior).
  - `LOW` — minor improvement, no immediate functional impact. Still emitted.
- **Do not report** (no evidence in the diff = not a finding): hypothetical issues
  in code not shown; style or naming opinions that do not affect correctness;
  "missing tests" unless the change adds testable behavior with no coverage;
  patterns consistent with visible codebase conventions — *unless* this change
  introduces a docstring or contract claim its own code contradicts, which a matching
  sibling-module shape does **not** license; a deliberate trade-off or deferral
  grounded in sourced project context or an authorized risk decision and recorded in a learning,
  **subspec**, or the spec's *Out of scope* / *Adaptations* section (e.g. concurrency lost-update protection deferred to a later step, or a
  plain `Error` the spec deliberately chooses over a subclass — cite the location).
  Naming the exclusions is what frees you to report the legitimate remainder without
  fear of nitpicking.
- **Confirm, then drop.** Before emitting, confirm every finding: it references the
  narrowest stable location, its severity matches the harm you traced, and no two
  findings contradict. Drop any that fail. A strong drop-filter — not
  self-censorship — is what lets you surface borderline findings confidently.
- **Record considered-and-dismissed candidates.** When a per-commit pass raises a
  *real* code property and you drop it because a subspec, learning, or the spec
  records a deferral grounded in context or an authorized risk decision (not because it was vague), note it in a short
  **Considered & dismissed** list in the prose, each with its citation. This is
  non-actionable and never affects the verdict — but it turns a silent `pass` into an
  auditable one: a reader sees the candidate was weighed and why it is not a bug,
instead of wondering whether the review looked at all. This is exactly where a
blind whole-diff pass fails — it reports `pass` with no evidence it ever considered
the defect a spec-unaware external tool would raise. Keep it to candidates with a
  concrete code location and an explicit citation; never pad it with nits.

## Severity, Actionability, Verdict

- **Severity** `HIGH`/`MED`/`LOW`; **Category** `correctness`/`security`/`perf`/
  `simplification`/`design`/`guardrail`/`evidence`.
- **Actionable** = `HIGH` or `MED` in `correctness`, `security`, `guardrail`, or `evidence`. All else is
  **advisory**. A violation of an explicit context constraint or sourced omission is `guardrail`, even when
  removing unnecessary machinery is the fix. Ordinary simplification stays advisory. The split
  gates only the **verdict and the loop**: advisory findings
  are recorded and never block `spec-branch-refine`, but they are **always emitted**.
  The split must never collapse to silence — a clean diff yields `findings: []`; a
  diff with only `LOW` issues yields a `pass` verdict **with those findings listed**.
  Suppressing a real low-severity finding because it "won't block the loop" is a
  defect in this review, not a convergence feature.
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

If `reviews/` does not exist, create it. Write the file atomically: write a temp file
in the destination directory, then rename it. Begin the file with a level-1 `#`
heading on line 1. The file leads with a fenced YAML block — the
machine-readable contract that `spec-branch-fix` and `spec-branch-refine` parse —
followed by human-readable prose that only explains the findings. Downstream skills
read the YAML first; the prose is never parsed for control flow.

````txt
# Branch Evidence Audit — iteration <iteration> (<feature-slug>)

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
  commit: <full audited HEAD SHA>
  evidence_verdict: proven | incomplete
  claims_audited: <count>
  gates_reexecuted: <count>
  actionable: <count>
  advisory: <count>
  lenses: [correctness, reference-integrity, security, simplification, ai-authorship, executable-evidence]   # plus any fired: design, deep-security, data-deploy, dependency, performance, test-quality
  commits_reviewed: <n>             # informational: commits decomposed and reviewed in the per-commit pass (Stage B)
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
Harm: <what concretely goes wrong if unfixed — a traced failure path, not "violates best practices">
Fix:  <concrete suggested change>

### F2 · LOW · simplification · src/bar.ts:wrap (L10) · [advisory]
...

## Considered & Dismissed

List non-actionable candidates dropped because a cited artifact records a sourced requirement or authorized risk decision; include stable locations/citations and never pad the list.

Review: <spec-dir>/reviews/branch-<iteration>-review.md (iteration <iteration>)
````
A clean branch requires `verdict: pass`, `evidence_verdict: proven`, all required merge claims closed, no excluded working-tree changes capable of affecting the candidate, `actionable: 0`, and an empty `findings: []`,
`## Findings\nNone`, and the locator line — plus a **Considered & dismissed** list when a
per-commit pass weighed and (correctly) dropped a context-justified candidate. That list is
what distinguishes an audited `pass` from a blind one. When no candidates were
dismissed, keep the `## Considered & Dismissed` section and write `None.` under it —
an explicit zero, not an absent section. A pending deploy/post-deploy claim does not block a merge pass. A known later-phase failure
that also disproves a merge claim does block it; document the dependency. A `pass` verdict is the signal
`spec-branch-refine` stops on.

## Completion Report

Report:

1. Spec path and iteration.
2. Review file path.
3. Verdict and actionable/advisory counts.
4. The lenses that ran, claim/gate counts, re-executed gates, evidence verdict, any risk trigger that did not fire, and how many commits the per-commit pass reviewed.
5. The scope and diff target (e.g. `committed merge-base..HEAD`), whether the working
   tree was dirty (and excluded), and how many prior dismissals were honored — by class.

Do not implement fixes — that is `spec-branch-fix`. Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
