# Code Review Skills

In-process, spec-aware **correctness review** for the spec-driven workflow. After
code is written for a spec, these skills look for *bugs* — logic errors, security
holes, resource leaks, and needless complexity — and apply fixes, without leaving
the coding agent and without any external review service.

Because they run inside the workflow, they read everything the pipeline already
produced — `spec.md`, the per-step subspecs, the per-step learnings, and the
conformance checklist — and review each change *as the spec intended*, not as an
opaque diff. A reviewer that knows what a step was supposed to do can tell a
deliberate design from a defect; a diff-only reviewer cannot.

There are five skills: two review/fix pairs (one per step, one per branch) and a
loop driver that runs the branch pair to convergence.

| Skill | Command | Purpose |
|---|---|---|
| **spec-step-review** | `/spec-step-review spec=<path> step=<n>` | Read-only correctness review of one step's committed diff; writes `reviews/step-<n>-review.md`. Never edits code. |
| **spec-step-fix** | `/spec-step-fix spec=<path> step=<n>` | Reads `step-<n>-review.md`, decides per finding, applies the actionable fixes scoped to that step, writes `reviews/step-<n>-fix.md`, commits. |
| **spec-branch-review** | `/spec-branch-review [spec=<path>] [iter=<n>]` | Read-only correctness review of the whole branch diff; fixed core lenses plus conditional fan-out; writes `reviews/branch-<i>-review.md`. Never edits code. |
| **spec-branch-fix** | `/spec-branch-fix [spec=<path>] [iter=<n>]` | Reads `branch-<i>-review.md`, decides per finding, applies fixes across the branch, writes `reviews/branch-<i>-fix.md`, commits. |
| **spec-branch-refine** | `/spec-branch-refine [spec=<path>] [max-iterations=<n>]` | Loop driver: alternates `spec-branch-review` and `spec-branch-fix`, re-reviewing until clean, no progress, or the cap (default 10). |

---

## Architecture, Intent & Capabilities

### Intent

- **Own the correctness gate in-process.** The pipeline already manufactures the
  context a reviewer needs. Reviewing an opaque diff in a separate service throws
  that context away and adds an external dependency. These skills keep review where
  the context lives, so the workflow has no out-of-process review requirement.
- **Correctness, not conformance.** They hunt for bugs. Whether the code matches
  what the spec *said* is a separate, orthogonal gate (`spec-criteria` →
  `spec-audit` → `spec-remediate`). A change can conform perfectly and still be
  wrong; it can be correct and still drift from the spec. Each gate answers its own
  question and neither replaces the other.
- **Composable primitives over a monolith.** Review and fix are distinct skills,
  not one black box, so each is independently inspectable, testable, and reusable.

### Architecture

- **Review and fix are separate skills, coupled only by a file contract.** A
  read-only review skill writes a findings file. A separate fix skill reads that
  file, decides what to act on, edits code, and writes a decisions file. The
  reviewer never edits; the fixer never re-reviews. The only thing passed between
  them is a file on disk. This is what keeps both honest: a reviewer with no stake
  in the fix, and a fixer judged by an independent re-review (or by the targeted
  tests), not by its own say-so.

- **Artifacts live beside the spec.** Everything is written under
  `.specs/<feature-slug>/reviews/`, parallel to `subspecs/` and `learnings/`, so a
  review trail accumulates with the rest of the spec record:

  ```txt
  .specs/<feature-slug>/reviews/
    step-<n>-review.md      step-<n>-fix.md        # one pair per implementation step
    branch-<i>-review.md    branch-<i>-fix.md       # one pair per branch-loop iteration
  ```

- **The loop lives in a thin driver.** The four leaf skills are single-pass and
  stateless. Everything that spans iterations — counting, convergence, and the
  anti-thrash memory — lives in `spec-branch-refine`. The leaves stay simple; the
  driver holds the state.

### Capabilities

- **Spec-aware.** Reviewers read `spec.md` (and its adaptation log), the relevant
  subspecs, the per-step learnings, and the conformance checklist for *judgement* —
  never to re-run conformance checks. They use that context to avoid flagging a
  recorded, deliberate trade-off as a bug.
- **Self-sufficient from a step marker.** The per-step pair needs only
  `spec=<path> step=<n>`. They resolve the step's commit, subspec, learning,
  checklist, and any prior fix file themselves from the spec directory. A missing
  sibling artifact is a non-blocking absence, not an error.
- **Risk-triggered branch fan-out.** The branch reviewer always runs a fixed core
  (correctness, security, simplification) and *fans out by risk*: it adds a
  specialized lens for each trigger the diff fires — design/UX for UI/style changes,
  deep-security for auth/crypto/session paths, data/deployment for migrations,
  dependency for manifest/lockfile changes, performance for hot paths, test-quality
  for thin tests on risky behavior. Where a skill already covers a lens
  (`design-align`, `ux-auditor`, `security-review`), it delegates when that skill is
  available and runs an inline checklist otherwise. It fans out only where the risk
  is, never by rote.
- **Explicit review scope.** The branch reviewer reviews committed branch work
  (`merge-base..HEAD`) by default, refuses to review the default branch against
  itself unless given a `base`/`since`, and warns when the working tree is dirty so
  it never silently misses uncommitted or untracked work. A `scope=working-tree`
  mode reviews uncommitted and untracked changes for standalone use.
- **Convergence and anti-thrash.** Findings are split into **actionable** and
  **advisory**; only actionable findings drive the loop. Dismissed findings are
  recorded by a stable signature **and a dismissal class** — `false-positive`,
  `intentional`, and `accepted-risk` with `approved: true` suppress re-raise, while
  `deferred` and `unfixable` keep surfacing because they are real, unresolved bugs. The loop
  stops on a clean verdict, at the cap, or when a fix made no material change — it
  does not grind to the iteration limit on nits, nor bury a bug by dismissing it.
- **Two scopes, same shape.** The step pair reviews one step's diff in isolation
  (catching bugs early, cheaply). The branch pair reviews the whole branch
  (catching cross-step integration bugs no single-step review can see). Both use the
  identical file contract.
- **Harness-portable.** Each skill runs its review or fix in a dedicated subagent
  when the harness supports subagents — preserving reviewer/fixer independence — and
  falls back to running inline, reporting the limitation, when it does not.

---

## The File Contract

The coupling between every review and its fix is a single file with a fixed shape.

Each artifact leads with a fenced YAML block — the machine-readable contract
downstream skills parse — followed by human-readable prose that only explains the
findings. Control flow is driven by the YAML; the prose is never parsed.

### `*-review.md` (written by a review skill)

````txt
# {Step|Branch} Review — {step <n> | iteration <i>} (<feature-slug>)

```yaml
review:
  kind: step | branch
  step: <n>                 # step only
  iteration: <i>            # branch only
  spec: .specs/<feature-slug>/spec.md
  target: <commit-sha | merge-base..HEAD | working-tree>
  scope: committed | working-tree   # branch only — pure enum, never annotated
  excluded_worktree_changes: 0      # branch only — uncommitted/untracked files NOT reviewed
  scope_note: ""                    # branch only — human note when the tree was dirty
  verdict: pass | needs-fix
  actionable: <count>
  advisory: <count>
  lenses: [correctness, security, simplification]   # plus any fired risk lens
  findings:
    - id: F1
      severity: HIGH
      category: correctness
      actionable: true
      file: src/foo.ts
      line: 42
      symbol: loopBound
      signature: correctness:src/foo.ts:loopBound:off-by-one in loop bound
```

## Findings
### F1 · HIGH · correctness · src/foo.ts:loopBound (L42) · [actionable]
What: <one line>
Why:  <one line — the concrete failure>
Fix:  <concrete suggested change>
````

- **Severity** is `HIGH`, `MED`, or `LOW`. **Category** is `correctness`,
  `security`, `perf`, `simplification`, or `design`.
- A finding is **actionable** when it is `HIGH` or `MED` in `correctness` or
  `security`. Everything else is **advisory**: recorded for the human, never
  required to fix. This split is what makes the loop converge.
- **verdict** is `needs-fix` when any actionable finding exists, otherwise `pass`.
- **signature** is `category:file:symbol:gist` — keyed on the nearest stable anchor
  (function/method/class/exported name), *not* the line number, which churns when
  nearby code moves. `line` is a separate display-only field. Downstream skills
  dedupe on the signature, so the same defect always produces the same one.

### `*-fix.md` (written by a fix skill)

````txt
# {Step|Branch} Fix — {step <n> | iteration <i>} (<feature-slug>)

```yaml
fix:
  kind: step | branch
  step: <n>                 # or iteration: <i>
  consumed: .specs/<feature-slug>/reviews/{...}-review.md
  target: <ref>
  decisions:
    - id: F1
      decision: fixed
      signature: correctness:src/foo.ts:loopBound:off-by-one in loop bound
      note: corrected loop bound
    - id: F2
      decision: dismissed
      dismissal: intentional
      approved: false        # only meaningful for accepted-risk; true suppresses re-raise
      signature: simplification:src/bar.ts:wrap:redundant wrapper
      note: wrapper kept for the API surface
  material_change: true     # branch only — false when the iteration changed no code
  commit: <hash or none>
```

## Decisions
- F1 · fixed — corrected loop bound (src/foo.ts:loopBound, L42)
- F2 · dismissed (intentional) — wrapper kept for the API surface

## Verification
<targeted commands> → <outcomes>; <n> fix-up attempt(s)
````

- Every actionable finding must be **fixed** or **dismissed** with a reason and a
  **dismissal class**: `false-positive`, `intentional`, `accepted-risk`, `deferred`,
  or `unfixable`.
- Dismissal class is the loop's memory. A later review suppresses a signature only
  for a *settled* class (`false-positive`, `intentional`, or an `accepted-risk` with
  `approved: true`); `deferred` and `unfixable` keep surfacing, so a real bug is never
  silenced by being
  set aside. A reviewer may still re-raise a suppressed dismissal it disagrees with,
  clearly marked, so genuine disagreement surfaces.
- **Artifacts are always committed.** They are product, not scratch — iteration
  memory, dismissal memory, and the audit trail. The fix skill commits the
  review+fix pair (a `chore(reviews):` commit when there is no code change); the loop
  driver commits the trailing review on any terminal stop — clean, cap, or stalled.
  The read-only reviewer never commits.

---

## How They Work

### Per step — a single pass

After a step is implemented, verified, and committed:

1. `spec-step-review` reviews **only that step's diff** against the three core
   lenses, spec-aware via the step's subspec and learning. It writes
   `step-<n>-review.md` and stops. It changes no code.
2. `spec-step-fix` reads that file, decides each finding (fix or dismiss), applies
   the actionable fixes scoped to the step, runs the step's targeted tests as the
   oracle (up to two fix-up attempts), writes `step-<n>-fix.md`, and commits
   `fix(<scope>): address step <n> review`.

There is no per-step loop. The step pass is a cheap early catch; the branch loop is
the thorough backstop.

### Whole branch — a loop to convergence

At the end of the run, `spec-branch-refine` drives the branch pair:

```txt
i = 1
loop:
  spec-branch-review (iteration i)      → writes branch-<i>-review.md
  read the verdict (from the YAML block)
  stop if:  verdict == pass             (clean; driver commits the trailing review)
            i == max-iterations         (cap; residual findings reported, trailing review committed)
            branch-<i-1> fix had material_change == false
              AND actionable set == branch-<i-1>'s   (stalled; a fix changed nothing)
  recurrence = actionable sigs that branch-<i-1>-fix marked `fixed`
  spec-branch-fix (iteration i, terminalize: recurrence)
                                        → writes branch-<i>-fix.md, fixes, commits
  i = i + 1
```

The branch reviewer dedupes against every prior `branch-<k>-fix.md` dismissal (by
class), so the loop cannot oscillate on a finding that was settled. **Recurrence is
computed before the stalled stop**: a finding that recurs as actionable after a
claimed `fixed` is handed to the fixer with a *terminalize* instruction — resolve it
with a genuinely different change or dismiss it with a class — so the fixer always
gets the chance to terminalize before the loop can declare a dead end. "Stalled"
means a fix made *no material change* and the same bugs remain, not merely that the
signature set repeated.

### Severity, actionability & convergence

The actionable/advisory split is the single rule that makes automation safe to run
unattended. Only `HIGH`/`MED` `correctness`/`security` findings block the loop;
all `LOW`, and all `simplification`/`design`, are advisory. A clean branch returns
`pass` on the first review and the loop stops after one pass with no fixes — the
common, good outcome on a well-built branch.

---

## Fitting Into An Orchestrated Pipeline

These skills are designed to be driven by an orchestrator, not just run by hand.

### A separate review orchestrator, not `spec-run`

Review orchestration is **deliberately kept out of `spec-run`**. `spec-run` stays
the in-repo implementation orchestrator — implement, verify, commit each step,
acceptance gate. A separate targeted orchestrator owns the review pass and drives
these skills, so review can evolve independently of implementation. That orchestrator
owns the decisions the leaf skills do not:

- **Scope and clean-tree policy** — committed vs. `working-tree`, and refusing an
  ambiguous default-branch target.
- **Review packet assembly** — gather the standardized local context (diff, changed
  files, `spec.md`, relevant subspecs, learnings, criteria/invariants as background,
  prior review/fix artifacts, dismissal registry, verification results, applicable
  rules, and the risk triggers) before calling a review skill. This packet is the
  whole advantage over a generic external reviewer: it reviews *as the spec intended*.
- **Scheduling** — per-step review after each step's commit; the branch loop at end
  of run, before the acceptance gate, so correctness fixes land first.
- **Blocking policy** (see below).
- **Artifact commit policy** — always record and commit (the skills already do this).

Resulting gate order:

```txt
per step:    implement → verify → commit → step-review → step-fix
end of run:  branch-refine (review ⇄ fix, until clean) → acceptance gate → [conformance audit]
```

### Blocking vs. best-effort

Distinguish two failure modes — do not collapse them to "best-effort":

- **Review harness failure** (a skill could not run, returned empty, a subagent
  died) — best-effort and reported. It never blocks the pipeline.
- **A confirmed `HIGH`/`MED` `correctness`/`security` finding that survives the loop**
  (left at the cap or a stalled stop, not dismissed) — this should **block**, or drive
  the run to a `needs-human` / `blocked-review` state. Automation must not quietly
  proceed past a real, unresolved bug it already found.

### Step-diff resolution (no separate ledger needed)

`spec-step-run` always writes `learnings/<n>-learning.md` and commits it **in the same
commit** as the step's code, so "the commit that adds the learning file" pins the
step's implementation diff deterministically — `spec-step-review` resolves the target
from it with no heuristic. A separate step-ledger artifact would only duplicate what
the committed learning file already records, so the workflow does not add one.

### Inside an isolated per-step pipeline

When steps are dispatched in isolation — each run and judged on its own, with no
in-context orchestrator carrying state — the per-step skills slot in by file
contract alone, needing no extra plumbing:

```txt
spec-step-run → spec-step-judge → spec-step-review → spec-step-fix
(implement)     (conformance)      (correctness)      (apply fixes)
```

Each stage reads what the previous stage wrote to the spec directory and writes its
own artifact for the next. Because the review and fix skills are self-sufficient
from the step marker, a dumb sequential runner can dispatch all four in order with
nothing but `spec=<path> step=<n>`.

### Standalone

Every skill also runs on its own. Review one step, apply one review file, do a
single whole-branch pass, or run the full branch loop before opening a pull
request — each is a valid entry point. `spec-branch-refine` is the natural
"clean up this branch" command.

---

## Correctness vs. Conformance (the boundary)

| Gate | Question it answers | Skills |
|---|---|---|
| Conformance (per step) | Does the change match the step's intent and stay green? | `spec-step-judge` |
| Conformance (branch) | Does the branch satisfy the frozen conformance checklist? | `spec-audit` → `spec-remediate` |
| **Correctness (per step)** | **Are there bugs in this step's code?** | **`spec-step-review` + `spec-step-fix`** |
| **Correctness (branch)** | **Are there bugs across the branch?** | **`spec-branch-review` + `spec-branch-fix` + `spec-branch-refine`** |

The correctness skills never run the conformance checklist's commands or patterns,
and the conformance skills never hunt for bugs. Run both — they catch different
failures, and "all tests pass" is evidence for neither.
