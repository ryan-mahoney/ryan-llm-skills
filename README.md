# Spec-Driven Agent Skills

Skills, rules, and harness instructions for LLM coding agents (Claude Code, Codex, Pi,
Augment, Cline, and OpenCode). The main workflow is **spec-driven development**: an agent
takes a feature goal through architecture, a prepared plan, step-by-step implementation,
independent review, and a commit-bound evidence tour to a published pull request.

People supply product decisions and review the evidence. Specs and code are written for
agents. Each skill is a slash command defined in `skills/<name>/SKILL.md` using the Agent
Skills format.

## Verification across harnesses

The shared [verification and review policy](rules/verification-and-review.md) uses focused
local feedback and leaves broad checks to CI or the operator after publication. Repository
instructions supply the commands and required gates. Broad testing never becomes a local
agent obligation, and no stage waits for CI; publication reads its status once and reports it.

The [Jev tool](scripts/jev/README.md) advises at two checkpoints: verification planning and
review triage. Pi, Claude CLI, and Codex CLI use the same questions through its CLI or MCP
interface. Unavailable or uncertain judgments return control to the agent under the same
repository policy. Install its pinned dependencies with `npm ci --prefix scripts/jev`.

`node scripts/verification/ci.mjs --repo /absolute/checkout` reads required PR checks and
verifies the remote head matches the clean checkout. When a repository has no platform-required
checks, its guidance must identify explicit gates using `--require 'Check name'`. Missing,
skipped, stale, or pending required checks never produce a passing receipt. This checks CI
status, not semantic coverage or overall merge readiness.

`node scripts/verification/install-warden.mjs` installs a narrow local adapter in Pi's
installed Warden package so it recognizes Elixir wrapper results and these CI receipts.
It preserves the previous file as `done.js.project-verification-backup` and refuses an
unrecognized classifier. Restart Pi afterward; package updates may require reapplying the
adapter. This is a local integration patch, not an upstream Warden release.

## Spec-driven development

### Quick start

```text
/spec-end-to-end add CSV export for the filtered results, using a worktree
/spec-end-to-end resume sample-workspace/results-export through PR publication
/spec-upgrade all pending specs in this repository
```

`spec-end-to-end` runs every stage below, resumes from the earliest stage whose artifacts are
missing or stale, and keeps run-wide directives such as a worktree, named delegation, or
the model assigned to each role. `spec-upgrade` refreshes older unimplemented specs and stops
before implementation. The [workflow guide](docs/spec-workflow.md) covers prerequisites,
running stages individually, recovery, and harness setup.

### Where spec files live

Spec work requires workspace storage. Each spec package belongs to one workspace and lives in
that workspace's adjacent storage at `<storage root>/projects/<workspace>/specs/<slug>/`, with its
epics, plans, project context, and workflow captures beside it. A package names the kit
repositories it targets; repositories hold code, branches, worktrees, and committed documentation,
and no `.specs/` folder exists in any checkout. Each workspace names one execution host in
`kit.yaml`, and spec work for it runs only there. [Linux host setup](docs/linux-host-setup.md) prepares an execution host,
and [storage operations](docs/adjacent-storage-operations.md) covers syncing, backups and migration.

`scripts/spec-location/` is the only resolver. Every spec skill starts with
`node ~/.agents/scripts/spec-location/cli.mjs check <package>` and reads paths from the package's
`locations.json`; none builds a path itself. When the resolver refuses, the skill stops and prints
the remedy. See [spec location](skills/spec-end-to-end/references/spec-location.md) and the
[resolver](scripts/spec-location/README.md). Two skills set up the preconditions:
`adjacent-storage-setup` designates the storage root, and `workspace-kit` edits the kit
(repositories, roles, design system, execution host). A repository with an older `.specs/` folder
moves into its workspace with `spec-location migrate`.

### What the workflow upholds

| Principle | In practice | Enforced by |
|---|---|---|
| Proof proportional to context | Users, data value, compatibility, release process, and permitted operations are recorded once in the workspace's `project-context.md`. Evidence matches actual exposure: disposable data needs no migration machinery, while security and valuable data keep full protection. | [Project context contract](skills/spec-end-to-end/references/project-context.md), `spec-write` |
| Escalate only consequential decisions | Agents settle ordinary engineering questions themselves. They stop only for choices that change scope, authority, or risk, and never ask people to review specs or code. | Every stage's `decision-required` outcome |
| Prepared intent is immutable | `spec-write` produces ready cards and structurally valid inputs. Implementation may adapt to the repository but never edits the plan. Changed intent or proof goes back for re-preparation. | `spec-write`, `spec-run` |
| Every claim can fail | Each acceptance criterion maps to a claim, its credible failure hypotheses, and a gate able to reject each one (AC → CL → FH → EV). | [Executable evidence contract](skills/spec-work-tour/references/executable-evidence.md), `spec-branch-review` |
| Proof through the real entry point | Runtime claims are shown through production composition, at the boundary that owns the behavior, without test-only prerequisites. | `spec-step-run`, `spec-run` verification |
| Tests earn their place | A new test names the failure existing tests miss. A removal names the retained protection or the source that retired the obligation. Test counts, coverage, and a green suite after deletion justify neither. | [Unit testing guide](rules/unit-testing.md), `spec-branch-review`, `test-audit` |
| One owner per behavior | Steps reuse existing helpers. A fix to one copy searches for others. Review searches the repository for reinvented behavior. | [Engineering decisions](skills/spec-work-tour/references/standalone-engineering-decisions.md), `spec-branch-review` |
| Minimal implementation | Steps write the least code that solves the stated problem, with no speculative abstractions, flags, or compatibility shims. | [Minimal implementation guide](rules/minimal-implementation.md), selected for every spec |
| Reviewers do not fix; fixers do not review | Review and fix are separate agents that communicate only through `reviews/*-review.md` and `*-fix.md`. Reviewers test the implementer's conclusions instead of trusting them. | `spec-branch-review`, `spec-branch-fix` |
| Review each step, then publish | Each step is independently reviewed while the next is built. Finish all findings, including the last step’s fixes, then publish. Whole-branch review is opt-in; the operator owns further PR review and merge. | `spec-run`, `spec-pr` |
| Honest, commit-bound results | Every result names the revision it ran against; relevant later changes require reassessing applicability. An unrun test is never reported as passing. Incomplete work is recorded as `checkpoint` and gaps stay visible. | `spec-run`, merge evidence, `spec-work-tour` |
| Bounded execution | Every command and worker has an explicit deadline. A timeout is a recorded failure, not a pass. | Verification scheduling policy, `spec-run` |
| Merge readiness is not deploy authority | The workflow ends at a published PR. Deployment readiness, authorization, and post-deploy observations are tracked separately, and no gate grants operational authority. | `spec-work-tour`, `spec-pr` |
| Readable output | PRs, commits, and work tours explain the software without workflow narration or local file references. Specs keep the detail agents need. | [Engineering writing](rules/engineering-writing.md) |

### Stages

1. `spec-architect-initial` resolves project context and consequential decisions, then writes
   `context.md` and `proposal.md`.
2. `spec-architect-critics` stress-tests the proposal and writes `critique.md` (optional).
3. `spec-write` writes the spec, its evidence plan, and one execution card per step, then
   validates required inputs and ready cards.
4. The top-level agent chooses a branch or worktree for each target repository. Spec files
   stay in the workspace and are never in a checkout or worktree.
5. `spec-run` implements each step with its tests and evidence and commits it. After each
   step it starts a background review and fixes earlier findings before the next step.
6. Finish the last step’s review/fix cycle, including the bounded final fix review of
   the trailing fix range, reconcile the base, refresh affected evidence, and push all
   task-owned commits. CI status is reported, not gated on.
   `spec-branch-refine` is available only when explicitly requested or required by project policy.
7. `spec-work-tour` writes `work-tour.json` and a browser-ready `work-tour.html` for the
   final commit.
8. `spec-pr` supports an early authorized draft and a final ready candidate. Publication
   reuses current review, evidence, and tour outputs; a newly changed base or relevant
   failure requires refreshing affected evidence. The final tour and PR links are delivered
   after publication is verified and the run's workers have finished.

### Artifacts

Everything lives in the package folder, `specs/<slug>/` in the workspace's adjacent
storage, outside every checkout.

| Artifact | Written by | Contents |
|---|---|---|
| `context.md`, `proposal.md`, `critique.md` | Architecture stages | Context snapshot, chosen approach, and challenges to it |
| `spec.md`, `evidence-plan.json` | `spec-write` | Behavior, acceptance criteria, pre-mortem, and the AC → CL → FH → EV graph |
| `step-NNN-subspec.md`, `spec-steps.json`, `spec-prepare.md` | `spec-write` | Execution cards, step index, and preparation outcome; structural readiness is checked once |
| `history-index.json` | `spec-run` script | Navigation to canonical learnings, decisions, handoffs, and unresolved reviews |
| `runtime/run.json`, `runtime/runs/*.json`, `runtime/events.jsonl` | Pi execution extension | Managed assignment state, worker session locations, and timestamped lifecycle events |
| `learnings/step-NNN-learning.md` | `spec-step-run` | What the step did, departures from the card, later-step handoffs, and its evidence |
| `reviews/step-NNN-*.md`, `reviews/branch-N-*.md` | Review and fix skills | Findings with stable signatures, and the fix or dismissal for each |
| `merge-evidence.md`, `merge-evidence.json` | `spec-run`, then review and fix | Gate results bound to the current commit |
| `work-tour.json`, `work-tour.html` | `spec-work-tour` | Final merge verdict, residual risk, QA scenarios, and deployment states |

### Running under Pi or OpenCode

In Pi, the top-level agent runs `spec-end-to-end` and `spec-run`. The installed
`spec_dispatch` tool starts a step owner with a retained disk session; the owner calls
`spec_editor` for bounded edits and `spec_verify` for owner-run focused verification. The runtime
owns process completion and cancellation, and refuses a second dispatch while the package's
recorded run still has a live coordinator.
It uses the assigned models directly and sends a completion event to the orchestrator.
See the [runtime setup and API](pi/extensions/spec-runtime/README.md) and
[run observation guide](docs/spec-runtime-observation.md) for installation and recovery.
The editor defaults to `deepseek/deepseek-flash:low`.
Optional coordinator, owner and reviewer scouting uses the installed `pi-subagents` scout profile with
`openai-codex/gpt-6-luna:low`, restricted to read/search tools. See
[scouting setup and scope](skills/spec-run/references/scouting.md). `SCOUT_AGENT` in the
initial prompt can override its model; scouting is never required for every step.
The initial `REVIEW_AGENT` selects the model; the `spec-stage-reviewer` profile supplies
the review role and compatible tools without fixing a model. Step fixes use the
`spec-step-fixer` profile with the assigned fix model and native/provider write tools.
See [workflow efficiency](docs/spec-workflow-efficiency.md) for deterministic helpers,
direct owner `spec_advice` calls to Jev, and local Jev effectiveness reports.
The [process improvements](docs/spec-coding-process-improvements.md) explain implemented
changes, observed results and the limits of current performance evidence.
Owner/editor questions use pi-intercom's scoped channel: the editor waits while the
owner answers, then continues in the same assignment with its writer reservation held.
Handoffs carry canonical paths, outcomes,
commits, and unresolved issues. The history index locates detail. Prepared focused
checks own verification; actual failures, departures, or acceptance gaps justify
additional checks. Reviews report defects and material limitations without positive
correctness narratives. For OpenCode's second worker level, see
[OpenCode nested delegation](docs/spec-workflow.md#opencode-nested-delegation).

Each stage consumes current upstream records: step reviews assess scoped changes and
evidence, the tour presents their completion and proof limits, and publication
checks freshness and remote readiness. Repeated execution needs a relevant change, failure,
or concrete gap. Existing inspected UI captures and tour-render results are reused;
unchanged evidence records are preserved through fixes.

#### Default Pi prompt

After `spec-write`, paste this into Pi as a normal prompt; **Implement spec** in Sentinel prefills the same brief. Replace `PACKAGE`
with the package folder (`package_dir`) or `workspace/slug` that the previous stage printed. Choose a stronger owner or
remove the `STRONG_OWNER` line to use one owner model throughout. The model assignments
below are an editable example; the routing policy is provider-independent.

```text
/spec-end-to-end Implement PACKAGE from its prepared specs.
Create a new branch/worktree and continue through PR publication.

Use the configured step-owner difficulty routing and retained owner/editor
pairs through the installed Pi spec runtime. Use bounded editor assignments
and separate commit assignments. Use REVIEW_AGENT for independent reviews.

DEFAULT_OWNER: deepseek-flash:max from deepseek
STRONG_OWNER: gpt-6.1-sol:medium from openai-codex
EDITOR_AGENT: deepseek-flash:low from deepseek
REVIEW_AGENT: gpt-6.1-sol:medium from openai-codex
SCOUT_AGENT: gpt-6-luna:low from openai-codex
PACKAGE: <package folder or workspace/slug>
```

The skill owns branch/worktree reuse, unfinished-work recovery, runtime pairing,
step reviews, bounded scouting, deterministic helpers and Jev checkpoints. Add only
run-specific exceptions to this prompt; keep the complete model assignment section
when customizing selectors. DeepSeek models use only the `deepseek` provider, never
OpenRouter.

No goal loop is required. The skill directs continuation between stages, and managed
worker completion events wake the top-level session while Pi remains running. A harness
goal is optional; uncoordinated auto-continuation can add idle turns while workers run.
The instructions do not keep a closed session alive or guarantee uninterrupted execution.

`DEFAULT_OWNER` handles easy and medium steps; `STRONG_OWNER` handles difficult remaining
engineering decisions and stalled repairs. `IMPLEMENT_AGENT` remains an alias for
`DEFAULT_OWNER`. Each owner retains its own editor, with one code writer active at a
time. Selection uses prepared cards and observed failures under the
[step-owner routing policy](skills/spec-run/references/owner-routing.md); it adds no
planning pass or extra verification gates. To pin a known step, add a direction such
as `Use STRONG_OWNER for steps 4 and 7.` Existing prepared specs need no new fields.

### Skills

| Skill | Command | Purpose |
|---|---|---|
| **epic-plan** | `/epic-plan <workspace> <prefix>` | Split a body of work described in the conversation into spec packages, sequence them for parallel work, and write the epic record, plan, and one proposed package per member with a `context.md` for architecture |
| **epic-end-to-end** | `/epic-end-to-end` with `EPIC:` or `PACKAGES:` | Run related specs in dependency order through publication and authorized merge, running independent packages in parallel sessions when that is safe and saves time, and updating downstream plans from feedback |
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
| **spec-gym** | `node scripts/spec-gym/cli.mjs run ...` | Replay one curated scenario against explicitly selected models with frozen inputs and compare outcomes; never edits a skill or scenario |
| **spec-gym-extract** | `node scripts/spec-gym/cli.mjs extract ...` | Extract a draft scenario from a real package and pinned Git revision without modifying the source |
| **test-audit** | `/test-audit <behavior or path> [mode=assess\|apply]` | Find redundant, weak, brittle, or costly tests in a scoped suite, and optionally apply the fixes |

### Design packages

UI work starts from a design package: one self-contained HTML/Tailwind file per screen-state
plus a `design.json` index, produced by one model from the conversation and the workspace's
design system, stored in workspace storage (`projects/<workspace>/designs/<slug>/`) rather
than a repository, and browsed in Sentinel's workspace view. Epics and specs reference
screens where they live by identity, path and digest; nothing is copied into a spec package.
Contract: [design packages](docs/design-packages.md). Content rule:
[prototype design](rules/prototype-design.md).

The [design system](design-system/README.md) provides the `agent-tooling`
workspace's palettes, component styles, HTML examples, and JavaScript helpers. Its
[offline catalog](design-system/index.html) opens without a build.

| Skill | Command | Purpose |
|---|---|---|
| **design-plan** | `/design-plan <workspace> <slug> [--posture ...]` | Use the conversation and any material it references, choose expert and designer lenses, inventory screen × state with the person and job each serves, declare the posture, write `brief.md` and `design.json` |
| **design-run** | `/design-run <workspace> <slug> [--step N]` | Produce each screen with a matching Markdown interaction guide, lint, capture and inspect at every declared width, then review the set through the brief's lenses |
| **design-prototype-explode** | `/design-prototype-explode <workspace> <slug> <prototype-path> [--context PATH]` | Extract each reachable screen/state from a compound prototype into separate HTML and granular interaction/context guides while preserving the source design |

`node scripts/design/cli.mjs` owns the mechanical part: index validation, screen lint
(no external resources, no self-referential copy), derived produced/captured status, the
pinned Tailwind runtime, and the reference line a spec cites.

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
| **visualize-journey**, **view-journeys** | `ux-qa/visuals/` under the workspace's `captures/<repository id>/`: journey maps and a canvas, served locally |
| **build-product-brief** | `docs/product-brief.md`: claims cited to screen, journey, or feature IDs |
| **journey-qa** | `ux-qa/` run output under the workspace's `captures/<repository id>/`, from the application's `bin/ux-qa` harness |

### Standalone skills

| Skill | Purpose |
|---|---|
| **agents-update** | Generate or update a repository's `AGENTS.md` |
| **adjacent-storage-setup** | Designate this machine's workspace storage root, verify it, and optionally create the first workspace; run it when a spec skill refuses with `storage-unavailable` |
| **workspace-kit** | Edit a workspace kit through the workspace CLI: repositories, roles, design system, execution host, and paths for another machine |
| **repo-status** | Collect local Git facts across repositories and worktrees, with optional open PR observations |
| **architect-inspect**, **identify-where**, **feature-list** | Describe architecture around a file, locate where a behavior lives, or inventory features |
| **controller-refactor-plan** | Find dead handlers and misplaced responsibilities in a controller |
| **ux-auditor**, **form-modernizer** | Check UI against a prototype, or modernize a form |
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
It only updates harness directories that already exist. It also installs the locked local
dependencies for the Pi execution extension and the Jev tool, so a fresh clone needs no
separate install step; run `scripts/install-deps.sh --force` to refresh them.

The same command links the optional `adjacent-sync` tool into `~/.local/bin`. See the
[adjacent sync guide](scripts/adjacent-sync/README.md) to configure and run it between machines.

```bash
~/.agents/sync.sh
```

The Pi spec runtime uses `pi-intercom@0.16.1` for scoped owner/editor questions.
Install it with `pi install npm:pi-intercom@0.16.1`, configure its explicit child
extension path as described in the [runtime guide](pi/extensions/spec-runtime/README.md),
and restart Pi. The runtime keeps dispatch and worker termination separate from messaging.

| Source | Destination |
|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| `skills/*/SKILL.md` | Harness skill directories; Augment reads `~/.agents/skills/` directly |
| `pi/agents/*.md` | `~/.pi/agent/agents/` |
| `pi/extensions/*/` | `~/.pi/agent/extensions/` (restart Pi after syncing) |
| `augment/agents/*.md` | `~/.augment/agents/` (bootstrap with `SYNC_AUGMENT=1 ~/.agents/sync.sh`) |

`sync.sh` does not edit provider credentials or runtime settings such as
`~/.config/opencode/opencode.jsonc`.

### Bundles

`scripts/build-skill-bundles.sh` builds two portable archives under `dist/skill-bundles/`:
`spec-skills` (spec skills, rules, and workflow docs) and `specops-skills`.
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
├── pi/        # Pi step profiles and managed execution extension
├── bundles/   # Bundle contents and install guide
├── scripts/   # Bundle build, skill lint, and SpecOps tooling
└── sync.sh
```
