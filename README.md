# Spec-Driven Agent Skills

Skills, rules, and harness instructions for LLM coding agents (Claude Code, Codex, Pi,
Augment, Cline, and OpenCode). The main workflow is **spec-driven development**: an agent
takes a feature goal through architecture, a prepared plan, step-by-step implementation,
independent review, and a commit-bound evidence tour to a published pull request.

People supply product decisions and review the evidence. Specs and code are written for
agents. Each skill is a slash command defined in `skills/<name>/SKILL.md` using the Agent
Skills format.

## Spec-driven development

### Quick start

```text
/spec-end-to-end add CSV export for the filtered results, using a worktree
/spec-end-to-end resume .specs/results-export/ through PR publication
/spec-upgrade all pending specs in this repository
```

`spec-end-to-end` runs every stage below, resumes from the earliest stage whose artifacts are
missing or stale, and keeps run-wide directives such as a worktree, named delegation, or
the model assigned to each role. `spec-upgrade` refreshes older unimplemented specs and stops
before implementation. The [workflow guide](docs/spec-workflow.md) covers prerequisites,
running stages individually, recovery, and harness setup.

### What the workflow upholds

| Principle | In practice | Enforced by |
|---|---|---|
| Proof proportional to context | Users, data value, compatibility, release process, and permitted operations are recorded once in `.specs/project-context.md`. Evidence matches actual exposure: disposable data needs no migration machinery, while security and valuable data keep full protection. | [Project context contract](skills/spec-end-to-end/references/project-context.md), `spec-write` |
| Escalate only consequential decisions | Agents settle ordinary engineering questions themselves. They stop only for choices that change scope, authority, or risk, and never ask people to review specs or code. | Every stage's `decision-required` outcome |
| Prepared intent is immutable | `spec-write` publishes a hash-bound package. Implementation may adapt to the repository but never edits the plan. Changed intent or proof goes back for re-preparation. | `spec-write`, `spec-run` |
| Every claim can fail | Each acceptance criterion maps to a claim, its credible failure hypotheses, and a gate able to reject each one (AC → CL → FH → EV). | [Executable evidence contract](skills/spec-work-tour/references/executable-evidence.md), `spec-branch-review` |
| Proof through the real entry point | Runtime claims are shown through production composition, at the boundary that owns the behavior, without test-only prerequisites. | `spec-step-run`, `spec-run` verification |
| Tests earn their place | A new test names the failure existing tests miss. A removal names the retained protection or the source that retired the obligation. Test counts, coverage, and a green suite after deletion justify neither. | [Unit testing guide](rules/unit-testing.md), `spec-branch-review`, `test-audit` |
| One owner per behavior | Steps reuse existing helpers. A fix to one copy searches for others. Review searches the repository for reinvented behavior. | [Engineering decisions](skills/spec-work-tour/references/standalone-engineering-decisions.md), `spec-branch-review` |
| Minimal implementation | Steps write the least code that solves the stated problem, with no speculative abstractions, flags, or compatibility shims. | [Minimal implementation guide](rules/minimal-implementation.md), selected for every spec |
| Reviewers do not fix; fixers do not review | Review and fix are separate agents that communicate only through `reviews/*-review.md` and `*-fix.md`. Reviewers test the implementer's conclusions instead of trusting them. | `spec-branch-review`, `spec-branch-fix` |
| Review early, converge in bounded rounds | Each step is reviewed in the background while the next is built, and its findings are fixed before the following step. The branch then gets one review-and-fix round, or two when step reviews are incomplete. The completion record says when final fixes were not re-reviewed. | `spec-run`, `spec-branch-refine` |
| Honest, commit-bound results | Every result names the revision it ran against and goes stale after later changes. An unrun test is never reported as passing. Incomplete work is recorded as `checkpoint` and gaps stay visible. | `spec-run`, merge evidence, `spec-work-tour` |
| Bounded execution | Every command and worker has an explicit deadline. A timeout is a recorded failure, not a pass. | Verification scheduling policy, `spec-run` |
| Merge readiness is not deploy authority | The workflow ends at a published PR. Deployment readiness, authorization, and post-deploy observations are tracked separately, and no gate grants operational authority. | `spec-work-tour`, `spec-pr` |
| Readable output | PRs, commits, and work tours explain the software without workflow narration or local file references. Specs keep the detail agents need. | [Engineering writing](rules/engineering-writing.md) |

### Stages

1. `spec-architect-initial` resolves project context and consequential decisions, then writes
   `context.md` and `proposal.md`.
2. `spec-architect-critics` stress-tests the proposal and writes `critique.md` (optional).
3. `spec-write` writes the spec, its evidence plan, and one execution card per step, then
   publishes the hash-bound package.
4. The top-level agent chooses a branch or worktree. All `.specs/` reads and writes stay in
   the primary repository, even when a worktree has a tracked copy.
5. `spec-run` implements each step with its tests and evidence and commits it. After each
   step it starts a background review and fixes earlier findings before the next step.
6. `spec-branch-refine` reviews the integrated branch: unreviewed commits, cross-step
   contracts, duplication, the full test suite, and every gate. It runs one review-and-fix
   round by default when step reviews cover every step, otherwise two.
7. `spec-work-tour` writes `work-tour.json` and a browser-ready `work-tour.html` for the
   final commit.
8. `spec-pr` rebases, refreshes stale evidence, requires a ready tour, and publishes the PR.

### Artifacts

Everything lives in `.specs/<feature>/` in the primary repository. The folder is often
git-ignored.

| Artifact | Written by | Contents |
|---|---|---|
| `context.md`, `proposal.md`, `critique.md` | Architecture stages | Context snapshot, chosen approach, and challenges to it |
| `spec.md`, `evidence-plan.json` | `spec-write` | Behavior, acceptance criteria, pre-mortem, and the AC → CL → FH → EV graph |
| `step-NNN-subspec.md`, `spec-steps.json`, `preparation.json` | `spec-write` | Execution cards and the hash manifest that implementation validates before each step |
| `learnings/step-NNN-learning.md` | `spec-step-run` | What the step did, departures from the card, later-step handoffs, and its evidence |
| `reviews/step-NNN-*.md`, `reviews/branch-N-*.md` | Review and fix skills | Findings with stable signatures, and the fix or dismissal for each |
| `merge-evidence.md`, `merge-evidence.json` | `spec-run`, then review and fix | Gate results bound to the current commit |
| `work-tour.json`, `work-tour.html` | `spec-work-tour` | Final merge verdict, residual risk, QA scenarios, and deployment states |

### Running under Pi or OpenCode

In Pi, the top-level agent runs `spec-end-to-end` and `spec-run` itself, because a child
can launch subagents only when granted fanout. Assign models per role when starting the run,
for example a different provider for step review than for implementation. The orchestrator
passes each model on every launch for that role. For OpenCode's second worker level, see
[OpenCode nested delegation](docs/spec-workflow.md#opencode-nested-delegation).

### Skills

| Skill | Command | Purpose |
|---|---|---|
| **spec-end-to-end** | `/spec-end-to-end [goal-or-feature] [modifiers]` | Run the complete workflow from goal or existing spec to a published PR |
| **spec-upgrade** | `/spec-upgrade [spec-paths or all pending specs]` | Bring unimplemented specs up to the current context and evidence rules; stop after preparation |
| **spec-message** | `/spec-message [feature] [message]` | Send a direction, information update, or hold to a running spec through its inbox |
| **spec-architect-initial** | `/spec-architect-initial [problem-or-feature]` | Resolve context and write `proposal.md` |
| **spec-architect-critics** | `/spec-architect-critics [proposal-or-file]` | Stress-test `proposal.md` and write `critique.md` |
| **spec-write** | `/spec-write [feature-slug-or-spec-path]` | Write or re-plan the spec, ground execution cards, and publish the prepared package |
| **spec-subspec-write** | `/spec-subspec-write [step-number] [spec-path]` | Prepare one step that needs deeper planning |
| **spec-run** | `/spec-run [feature-slug-or-spec-path]` | Implement prepared steps, review each in the background, and assemble merge evidence |
| **spec-step-run** | delegated | Implement one step with its tests, evidence, learning, and commit |
| **spec-branch-refine** | `/spec-branch-refine [spec-path]` | Alternate branch reviews and fixes within the round budget |
| **spec-branch-review** | delegated | Review one step's commits, or audit the integrated branch and its evidence |
| **spec-branch-fix** | delegated | Fix or dismiss each finding from a step or branch review and commit the fixes |
| **spec-work-tour** | `/spec-work-tour [spec-path]` | Build the commit-bound JSON verdict and HTML work tour |
| **spec-pr** | `/spec-pr [spec-path]` | Rebase, refresh evidence, require a ready tour, and publish the PR |
| **spec-branch**, **spec-branch-worktree** | `/spec-branch [description]` | Optional helpers to create a branch or worktree; the orchestrator does not need them |
| **spec-issue** | `/spec-issue [markdown-path] [issue-number]` | Mirror a Markdown spec to a GitHub issue; no pipeline state |
| **test-audit** | `/test-audit <behavior or path> [mode=assess\|apply]` | Find redundant, weak, brittle, or costly tests in a scoped suite, and optionally apply the fixes |

### Design entry point

The design stages replace architecture for UI work and hand off to the same back half. Each
surface is classified as **functional** ([functionalist design](rules/functionalist-design.md))
or **expressive** ([expressive design](rules/expressive-design.md)), and as a prototype or a
real in-code deliverable. The selected rule follows the spec into every step. Prototypes give
rendered-state evidence, but production code must still prove its wiring and accessibility.

| Skill | Command | Purpose |
|---|---|---|
| **design-spec-architect** | `/design-spec-architect [surface-or-feature]` | Classify the surface and propose a design direction |
| **design-spec-prototype** | `/design-spec-prototype [feature]` | Build and serve a viewable prototype (optional) |
| **design-spec-critique** | `/design-spec-critique [feature]` | Critique the prototype or proposal (optional) |
| **design-spec-writer** | `/design-spec-writer [feature]` | Write `spec.md`, its step index, and `evidence-plan.json`, then hand off to `spec-write` or `spec-end-to-end` |

## Other workflows

### SpecOps: legacy migration and agent documentation

SpecOps decomposes a codebase into stable targets, writes an implementation-agnostic analysis
of each, compresses those into agent docs indexed from `AGENTS.md`, and keeps them current as
branches change. A commit-coverage ledger under `docs/specops/history/` records which commits
each lens (`doc`, `intent`, `rework`) has processed and survives squash merges.
`scripts/commit-ledger.mjs` does the mechanical git accounting; interpretation stays with the agent.

- **Bootstrap docs:** `specops-decompose`, then `specops-orchestrate-analysis`.
- **Refresh a branch:** `specops-branch-refresh`. Catch up missed commits with `specops-doc-catchup`
  (`--status` for a read-only report).
- **Understand history:** `specops-decision-ledger` reconstructs active and superseded product
  decisions; `specops-rework-audit` finds churn hotspots and who holds the context.
- **Migrate:** `specops-make-spec`, `specops-run-spec`, `specops-contract-tests`,
  `specops-integration-test`, and `specops-implementation-drift` turn analyses into specs,
  tests, and drift corrections.

| Skill | Purpose |
|---|---|
| **specops-decompose** | Produce or refresh the `docs/specops/targets.json` manifest |
| **specops-initial-plan**, **specops-refactor-plan**, **specops-analysis** | Write analysis and plans for a scope, refactor goal, or folder |
| **specops-orchestrate-analysis** | Analyze each manifest target, build agent docs, and refresh the index |
| **specops-update-spec** | Update one target's analysis from a branch or diff |
| **specops-agent-docs**, **specops-index-agents** | Rebuild compressed agent docs and the `AGENTS.md` index |
| **specops-branch-refresh**, **specops-doc-catchup** | Keep docs current for a branch or for uncovered commits |
| **specops-intent-extract**, **specops-decision-ledger** | Extract commit intent and maintain the decision ledger |
| **specops-rework-audit** | Report rework hotspots and a non-blame context map |
| **specops-ambiguity-audit**, **specops-spec-coherence**, **specops-spec-conformance** | Resolve ambiguity, cross-spec gaps, and dropped behavior in analyses and specs |
| **specops-make-spec**, **specops-orchestrate-spec-create**, **specops-run-spec** | Turn analyses into implementation specs and implement them |
| **specops-contract-tests**, **specops-integration-test** | Generate contract and cross-module integration tests from analyses |
| **specops-implementation-drift** | Compare migrated code with its analysis and write corrective specs |

### Product documentation: permissions, screens, and journeys

These skills document a product's user-facing surfaces, each reading the previous one's output.
See the [product documentation guide](docs/product-documentation.md).

| Skill | Writes |
|---|---|
| **build-permission-model** | `docs/permissions/permission-model.md`: roles, capabilities, route guards, and audiences |
| **build-screen-inventory** | `docs/screen-inventory.md`: screens grouped by who can reach them |
| **document-screen-behavior** | `docs/screens/SCRN-###-*.md`: one screen's states, with captures cited by ID |
| **build-journey-map** | `docs/journey-registry.md`: journeys with stable IDs and cross-repository seams |
| **document-journey** | `docs/journeys/JRNY-###-<slug>.md`: stages, carried context, and evidence |
| **visualize-journey**, **view-journeys** | `.specs/ux-qa/visuals/`: journey maps and a canvas, served locally |
| **build-product-brief** | `docs/product-brief.md`: claims cited to screen, journey, or feature IDs |
| **journey-qa** | `.specs/ux-qa/` run output from the application's `bin/ux-qa` harness |

### Standalone skills

| Skill | Purpose |
|---|---|
| **agents-update** | Generate or update a repository's `AGENTS.md` |
| **architect-inspect**, **identify-where**, **feature-list** | Describe architecture around a file, locate where a behavior lives, or inventory features |
| **controller-refactor-plan** | Find dead handlers and misplaced responsibilities in a controller |
| **ux-auditor**, **design-align**, **form-modernizer** | Check UI against a prototype or design system, or modernize a form |
| **ux-page-critique**, **ux-information-critique**, **ux-cover-critique** | Critique an application page, informational page, or book cover |
| **see**, **uishot** | Check whether the model can view images, and screenshot a running page |
| **angular-pr-complexity**, **bun-test-fix** | Score an Angular merge commit, or fix a Bun test file |
| **skill-factory**, **axi-checker**, **simple-english**, **rules-from-experts** | Create skills, audit agent instructions, apply ASD-STE100 English, or research expert rules |
| **commit**, **pr-review**, **pr-feedback** | Commit staged files, review a PR, or address review comments |

## Rules

Files in `rules/` are linked into each harness's rule directory. Agents apply each guide when
the work calls for it, and `spec-write` selects the relevant ones for every spec.

| File | Scope |
|---|---|
| `minimal-implementation.md` | Least code that solves the stated problem; proportionate verification |
| `unit-testing.md` | Test value: what a test protects, when to add or remove one, assertions, and shared state |
| `engineering-writing.md` | PRs, commits, and work tours; detail retained in agent-facing specs |
| `pr-and-ticket-writing.md` | PR descriptions, tickets, and acceptance criteria |
| `functionalist-design.md` | Functional surfaces: layout, typography, color, data-ink restraint |
| `expressive-design.md` | Expressive surfaces: brand direction, distinctive type, motion |
| `form-design.md`, `table-row-design.md`, `cta-design.md`, `ux-states.md` | Forms, tables, button wording, and required view states |

## Install and sync

Run `sync.sh` after changing instructions, rules, or skills. It copies the harness instruction
files, refreshes rule links, syncs skills and adapters, and removes links left by renamed skills.
It only updates harness directories that already exist.

```bash
~/.agents/sync.sh
```

| Source | Destination |
|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| `skills/*/SKILL.md` | Harness skill directories; Augment reads `~/.agents/skills/` directly |
| `augment/agents/*.md` | `~/.augment/agents/` (bootstrap with `SYNC_AUGMENT=1 ~/.agents/sync.sh`) |

`sync.sh` does not edit provider credentials or runtime settings such as
`~/.config/opencode/opencode.jsonc`.

### Bundles

`scripts/build-skill-bundles.sh` builds two portable archives under `dist/skill-bundles/`:
`spec-skills` (spec and design-spec skills, rules, and workflow docs) and `specops-skills`.
Each contains `skills/`, `bundle.json`, a README, and `install.sh` (see `./install.sh --help`).
Set `VERSION` to name the archive. Pushing a `v*` tag builds both bundles in GitHub Actions and
attaches them with `SHA256SUMS` to the release.

```bash
VERSION=2026.10.02 scripts/build-skill-bundles.sh
git tag v2026.10.02 && git push origin v2026.10.02
```

### Layout

```text
~/.agents/
├── skills/    # Agent Skills, one folder per slash command
├── rules/     # Design, writing, implementation, and testing guides
├── docs/      # Workflow, review, and product-documentation guides
├── claude/    # Claude Code global instructions
├── codex/     # Codex global instructions
├── augment/   # Augment CLI subagent adapters
├── bundles/   # Bundle contents and install guide
├── scripts/   # Bundle build, skill lint, and SpecOps tooling
└── sync.sh
```
