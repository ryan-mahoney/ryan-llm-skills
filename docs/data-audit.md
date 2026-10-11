# Data audit: agent tooling, spec workflow, Sentinel, and workspace storage

Audit date: 2026-10-11. Repository: `~/.agents`, branch `design-packages` (`dcc2c0c`). The audit was read-only. Credential files were inspected only by key names and value classification; this document reproduces no secret values.

The audit covers every persisted data structure that this repository defines, writes, or reads. That includes structures stored outside the repository: per-repository `.specs/` trees, `~/.pi/agent`, workspace storage in `~/Documents/adjacent-storage`, caches, and harness mirrors. For each structure it records:

- what the data is for
- how often it changes
- who or what writes it
- who or what reads it

It also records schemas, relationships, retention, and observed drift. Sections 1–7 hold the per-structure detail. This summary gives the map, the cross-cutting findings, and the suggested next steps.

## Contents

1. [Spec packages](#spec-packages)
2. [Epics, plans, and designs](#epics-plans-and-designs)
3. [Workspace storage: workspaces, kits, threads, assignments](#workspace-storage-workspaces-kits-threads-assignments)
4. [Sentinel and spec observation](#sentinel-and-spec-observation)
5. [Pi runtime, Jev, and benchmark data](#pi-runtime-jev-and-benchmark-data)
6. [Git, ledgers, search indexes, and verification facts](#git-ledgers-search-indexes-and-verification-facts)
7. [Rules, skills, configuration, and documentation](#rules-skills-configuration-and-documentation)

## Where the data lives

The data sits in five storage zones. Only the first is under version control.

| Zone | Location | Size (2026-10-11) | Versioned | What it holds |
|---|---|---|---|---|
| Tracked source | `~/.agents` (git) | small | Yes | Rules, 84 skills, scripts, the Pi `spec-runtime` extension, Pi agent profiles, docs, scenario fixtures |
| Spec packages | `<repo>/.specs/` in every repository the spec skills touch | 2.3 GB in `~/.agents`; about 19.5 GB of `runtime/` across 68 packages in all repos | No (gitignored everywhere) | Intent and plan files, step cards, learnings, reviews, evidence, runtime receipts and transcripts, PR and merge records, epics (`_epics/`), plans (`_plans/`) |
| Pi home | `~/.pi/agent/` | 5.5 GB (4.9 GB sessions) | No | Pi sessions, subagent artifacts, run history, missions, settings, provider config and credentials, the cross-package run index (`spec-runtime/`), Sentinel state (`spec-sentinel/`), third-party Pi package state |
| Workspace storage | `~/Documents/adjacent-storage` (or `$ADJACENT_STORAGE_ROOT`) | about 2.2 GB (`transitops` 1.8 GB) | No; manual backup at `~/adjacent-storage-backup-2026-10-11` | Workspaces (`kit.yaml`), briefs, notes, artifact references, discussion threads and their Pi sessions, assignments, design packages, Phoenix-era legacy data |
| Caches and mirrors | `~/.claude/`, `~/.codex/`, other harness skill dirs, `~/.cache/agent-repo-search`, `dist/`, `tmp/`, `.uishot/` | `tmp/` 21 MB, `.uishot/` 6.4 MB | No | Copied or symlinked policy and skills, auto-memory, repo-search state (unbuilt), generated skill bundles, scratch files, screenshots |

## How the data flows

```
 operator ──► rules/, skills/, claude/CLAUDE.md ──sync.sh──► ~/.claude, ~/.codex, ~/.pi/agent (symlinks/copies)
    │                                                          │ read at session start by every harness
    ▼
 planning skills (spec-architect-*, spec-write, design-plan)
    │ write once per package
    ▼
 .specs/_plans/*.md ◄── .specs/_epics/<slug>/epic.json ──► member packages
 .specs/<pkg>/{context,proposal,critique,spec}.md, spec-steps.json, evidence-plan.json, step-NNN-subspec.md
    │
    ▼
 Pi spec-runtime extension (owner/editor workers in Pi)              Pi core / pi-subagents
    │ per dispatch, seconds–minutes                                      │
    ▼                                                                    ▼
 .specs/<pkg>/runtime/** (receipts, events, streams, sessions)       ~/.pi/agent/sessions, run-history, missions
 .specs/<pkg>/{learnings,reviews,evidence}/, history-index.json
 ~/.pi/agent/spec-runtime/<run>.json (cross-package index)
    │
    ▼
 spec-run / spec-work-tour / spec-pr ──► merge-evidence.*, work-tour.*, pr-message.md, pr-url.json ──► GitHub PR
    │
    ▼
 Sentinel host (Pi extension, 15 s + file watcher) reads all of the above plus epics, designs, assignments
    │ writes
    ├─► ~/.pi/agent/spec-sentinel/<ws>/observers/<uuid>.json (snapshot) ──► dashboard /api/state (5 s poll)
    ├─► .specs/<pkg>/sentinel-merge.json (shadow/recover only), sentinel-completion.json (operator click)
    └─► .specs/<pkg>/runtime/sentinel/<wf>/** (checkpoints, incidents, grants, shadow records)

 dashboard ──► workspace storage: threads/ (pi --mode rpc child per thread), briefs/, assignments/ (tmux + interactive Pi)
```

## Structures at a glance

The main structures are grouped by how often they change. The sections give the full list (about 120 structures).

| Change rate | Structure | Writer | Primary readers | Purpose |
|---|---|---|---|---|
| Per commit (daily during active work) | `rules/*.md`, `skills/*/SKILL.md`, `pi/agents/*.md`, extension and script source | Operator; `skill-factory`; spec runs editing this repo | Claude Code, Codex, Pi, Augment, humans | Instructions and tooling that every agent session loads |
| Rare (weeks) | `claude/CLAUDE.md`, `codex/AGENTS.md`, `kit.yaml`, `~/.pi/agent/settings.json`, `trust.json`, `spec-runtime.json`, `.specs/project-context.md` | Operator; `sync.sh` copies | Harnesses at startup; workspace and design tools | Global policy, workspace composition, runtime configuration |
| Once per plan | `context.md`, `proposal.md`, `critique.md`, `spec.md`, `spec-steps.json`, `evidence-plan.json`, `step-NNN-subspec.md`, `epic.json`, `_plans/*.md`, `design.json`, `brief.md` | Planning skills; operator edits | Step runners, reviewers, Sentinel, dashboard | Define what to build, the steps, and the acceptance evidence |
| Per step (minutes–hours during a run) | `learnings/`, `reviews/`, `evidence/`, `runtime/runs/*.json`, `progress.json`, `history-index.json`, checkpoints | spec-runtime extension, owner/editor/reviewer agents | Next steps, coordinator, Sentinel, work tour | Execution record and proof per step |
| Per package close (once) | `merge-evidence.*`, `work-tour.*`, `pr-message.md`, `pr-url.json`, `sentinel-merge.json` | spec-run, spec-work-tour, spec-pr, Sentinel | PR reviewers, Sentinel, operator | Merge-readiness case and the PR and merge link |
| Continuous (seconds) | Observer snapshots, activity registries, Pi sessions, raw worker streams, `pi-warden` state, `run-history.jsonl` | Sentinel host, spec-runtime, Pi core, Pi packages | Dashboard, monitor widget, process-improvement analysis | Live status and full transcripts |
| Per conversation | `threads/<uuid>.json` + session, `assignments/<uuid>.json`, auto-memory | Sentinel discussion service, workspace CLI, Claude Code | Dashboard, Pi, Claude Code | Discussion history, launched-agent mapping, cross-session memory |

### Writers

- **The operator** writes policy, rules, skills, kits, provider config, epics, and closeout notes, mostly by hand.
- **Planning skills** (`spec-architect-*`, `spec-write`, `spec-upgrade`, `design-plan`) write intent files once per package.
- **The Pi `spec-runtime` extension** writes all runtime receipts, streams, learnings, progress, and the cross-package run index.
- **Worker agents** (owner, editor, reviewer, and fixer profiles in `pi/agents`) write evidence, reviews, fixes, and code commits.
- **Publication skills** (`spec-run`, `spec-work-tour`, `spec-pr`) write merge evidence, tours, and PR records.
- **The Sentinel host** writes snapshots, merge and completion records, and supervision records. It also runs the discussion service that writes threads.
- **Pi core and third-party Pi packages** (`pi-subagents`, `pi-warden`, `pi-typesafe`, `pi-intercom`) write sessions, missions, history, and their own state.
- **`sync.sh`** writes policy copies and symlinks only. It does not prune.
- **Claude Code** writes auto-memory.

### Readers

- Every harness (Claude Code, Codex, Pi, Augment, Cline, OpenCode) reads rules and skills.
- Spec stages read the package files written by earlier stages. They read only that package's files, plus `project-context.md`.
- The Sentinel reads nearly everything under `.specs/`, the run index, epics, designs, and assignments, then derives one snapshot.
- The dashboard reads only that snapshot and workspace storage.
- Humans read PRs, work tours, plans, and docs. `spec-process-improvement` reads sessions, receipts, and telemetry after the fact.

## Cross-cutting findings

These are ordered by consequence. Each one cites the section that has the evidence.

1. **Most workflow state is neither versioned nor backed up.** `.specs/` is gitignored in every observed repository, so epics, plans, `closeout.md`, step cards, reviews, evidence, and merge records live only on this Mac (§1, §2, §4). Workspace storage has one manual backup (§3). The only durable shared copies are PR bodies and committed docs.
2. **Nothing prunes the runtime data.**
   - About 19.5 GB of `runtime/` sits across 68 packages. Raw owner streams of 50–100 MB each make up most of it, although the runtime README says they are needed only for concrete failures (§5).
   - Pi sessions take 4.9 GB in 7,927 files, and the `pi-warden` WAL is 420 MB (§5).
   - Sentinel observer files are never deleted. Because the dashboard includes them, `/api/state` returns 8.5 MB on every 5-second poll, about 15 files below the 12 MiB cap (§4).
   - `tmp/` and `.uishot/` have no cleanup (§7).
3. **Secrets are duplicated in plain files.**
   - The `restory` provider's literal API key is stored in `models.json` and in all 10 `.bak*` copies (§5).
   - `auth.json.bak` duplicates the live login store (§5).
   - `tmp/jev-config-backup-*` is a full copy of the global Claude config (§5, §7).
   - Pi sessions and `pi-warden` SQLite hold unredacted tool output (§5).
4. **Record formats have drifted, and few are validated.**
   - `pr-url.json` has about six shapes, and the documented `draft` key appears in none. Draft PRs recorded as `mode: "draft"` pass the Sentinel's ready-PR check (§1, §4).
   - `merge-evidence.json` has three live shapes with no validator (§1).
   - `reviews/final-review.md` is prose in two packages and YAML in a third (§1).
   - ThreadV1 has many more fields than contract C-8 lists. C-7 describes a sha256-indexed reservation that the code does not implement (§3).
   - Version fields are inconsistent across stores: `schema_version`, `version`, `schemaVersion`, or none (§5).
5. **Some stored state contradicts the state derived from it.**
   - Stored `epic.state` disagrees with member status derived from package files. `adj7` (not undertaken) will stay `prepared` because no "dropped" status exists (§2, §4).
   - `spec-prepare.md` and the subspec verdicts in `adj1` and `adj3` still say `blocked` after merge (§1).
   - `sentinel-merge.json` is written only in shadow or recover mode, so it goes stale under the observe-only host (§4).
   - Two Phoenix-era threads are still marked `active` (§3).
6. **References dangle, and the Sentinel is near its limits.**
   - 46 of 114 package paths and 49 of 823 run-index manifests in `~/.pi/agent/spec-runtime/` point at missing targets (§5).
   - Those dangling pointers fill the Sentinel's 50-entry coverage-reason cap, which hides other reasons. The 10-second scan timeout is firing. The 20-root cap drops 8 of 28 discovered repositories (§4).
   - Mission records point into OS temp directories (§5).
7. **Several structures exist with no instances or are unused.**
   - Recover-mode records have never been written (§4).
   - The overseer inbox has zero messages, and there are zero dismissed findings (§1).
   - Spec-gym indexes are empty, and no gym run has been recorded (§5).
   - The repo-search index is unbuilt and no model root is present (§6).
   - `~/.roborev/` and the `roborev` binary are absent (§6).
   - Design packages and assignments have no real instances yet (§2, §3).
   - The adj7 importer and `sentinel-background-indexing` are specs without code (§3, §4).
   - Jev has logged 1,204 decisions: 83% `unavailable`, none `recommendation`, 70% at the daily budget, and `outcome` is almost never recorded (§5).
8. **Policy and configuration distribution has drifted.**
   - `claude/CLAUDE.md` and `codex/AGENTS.md` name different rule subsets (§7).
   - `~/.claude/rules` has a dangling symlink that `sync.sh` never removes (§7).
   - The generated bundle manifest still lists four deleted `design-spec-*` skills (§7).
   - The Jev MCP server is registered outside `sync.sh` (§5).
   - Run history names agent profiles (`spec-step-implementer`, `delegate`) that `pi/agents` does not contain (§5).
   - `unit-testing.md` depends on gitignored research notes (§7).
9. **Git history breaks the commit and attribution policy in places.**
   - One commit has a `Co-Authored-By: Claude` trailer and one has a `Findings:` workflow trailer. Eight subjects use `stepN:` (§6).
   - 11 of 12 linked worktrees sit in `$HOME` rather than the documented `~/.worktrees/<repo>/<slug>`, and nothing prunes merged ones (§6).
10. **Workspace storage writes don't share a concurrency model.** Thread, assignment, and kit writes use three separate locking schemes. A thread's `updated_at` is not updated when its Pi child exits. The dashboard file viewer does not exclude `assignments/` or `migration/` (§3).

## Suggested next steps

1. Move the `restory` key to a command reference like the `atria` provider uses, then delete the `models.json.bak*` files, `auth.json.bak`, and `tmp/jev-config-backup-*`, or rotate the key.
2. Add retention:
   - an age or size cap for `runtime/runs/*-owner-*.jsonl`
   - deletion of closed Sentinel observer files
   - pruning of dangling `~/.pi/agent/spec-runtime/` entries
   - `git worktree prune` for merged spec worktrees
3. Decide what must survive the loss of this machine. At minimum, back up `.specs/_epics`, `.specs/_plans`, and workspace storage, or commit the durable parts.
4. Add validators for `pr-url.json` and `merge-evidence.json` in the code that writes them, and make the Sentinel's ready check reject `mode: "draft"`.
5. Bring the C-7 and C-8 contract text, `docs/spec-epics.md`, and the Sentinel skill into line with the code.

## Corrections made while merging

The sections were checked against each other and against the filesystem. These corrections were applied:

- `.uishot/` is 6.4 MB (`du`), not 13 MB.
- Workspace storage is about 2.2 GB on disk (`du`).
- This checkout has 11 `sentinel-merge.json` records, not 10.
- The uncommitted changes at audit time were in `dashboard.html`, the workspace discussion and RPC modules, and `docs/adjacent-architecture.md`. `sentinel.mjs` and `pi/agents/spec-final-editor.md` had no uncommitted changes; the latter's earlier edit is in `12e8485`.
- A saved note located roborev reviews at `~/.roborev/reviews.db`. That directory no longer exists.

---

## Spec packages

Scope: the per-feature `.specs/<feature>/` directories and the shared `.specs/project-context.md`, in `/Users/ryanmahoney/.agents` and in other repositories the `spec-*` skills operate on. `_epics`, `_plans`, and design packages belong to another audit; links to them are noted only. Read-only audit; no credential contents were opened (credential shapes are not relevant to this area, and `runtime/` transcripts were treated as opaque).

Method: inspected all 17 package directories under `/Users/ryanmahoney/.agents/.specs` (adj1..adj7, spec-sentinel, super1..3, repo-status, repo-search-index, sentinel-background-indexing, browser-capture-workspace, prototype-component-library, 3-agent-docs-automation), then compared with the authoritative definitions in `skills/spec-*/SKILL.md` + `references/`, `skills/spec-work-tour/scripts/validate-evidence-plan.mjs`, `skills/spec-run/scripts/build-history-index.mjs`, `pi/extensions/spec-runtime/{runtime,completion,startup,sentinel}.mjs`, `scripts/spec-observe/{sentinel,package-files,manual-completion,merge-reconciliation,overseer-inbox}.mjs`, `docs/spec-epics.md`, `docs/spec-runtime-observation.md`. Frequency evidence is file mtimes, `git log` on the skill paths, and census scripts over all packages.

### Overview

A spec package is a **filesystem record with no database and no manifest**. A feature slug is a directory; its lifecycle is inferred from which files exist. The package accumulates in six layers, each owned by a different skill or runtime:

1. **Intent and plan** (architect/critic/spec-write): `requirements.md`, `context.md`, `proposal.md`, `critique.md`, `spec.md`, `spec-steps.json`, `evidence-plan.json`, `criteria.md`, `invariants.md`, `spec-prepare.md`, `step-NNN-subspec.md`, plus `difficulty-input.json`, `upgrade.md`.
2. **Execution** (Pi runtime + spec-step-run): `learnings/`, `evidence/`, `runtime/`, `history-index.json`.
3. **Review/fix** (spec-branch-review/fix, spec-final-review, spec-branch-refine): `reviews/`.
4. **Assembly and publication** (spec-run, spec-work-tour, spec-pr): `merge-evidence.{json,md}`, `work-tour.{json,html}`, `pr-message.md`, `pr-rebase-log.md`, `pr-url.json`.
5. **Operator/Sentinel lifecycle**: `sentinel-merge.json`, `sentinel-completion.json`, `inbox/`, `processed/`.
6. **Legacy and ad hoc** residue: `run-ledger.md`, `preparation.json`, `implementation-record.md`, `conversation-notes.md`, follow-up briefs, etc.

Scale in this checkout (2026-10-11): 17 package directories, 2.3 GB (`du`), of which `runtime/` is about 2.44 GB by apparent size (editor/owner Pi JSONL transcripts are ~2.3 GB of that). 11 packages ran under the managed Pi runtime and are merged (`sentinel-merge.json` present, 8 `authoritative-pr`, 3 `local-pr-merge`); `repo-status` was published before the runtime existed; 4 packages are prepared/proposed but unrun (adj7, browser-capture-workspace, sentinel-background-indexing, prototype-component-library); `3-agent-docs-automation` is a June legacy layout. Observed 82 learning records, 85 review records, 58 fix records, 115 runtime dispatch receipts (109 completed, 2 failed, 1 cancelled), 12 `merge-evidence.json`, 12 `pr-url.json`, 12 `work-tour.json`.

`.specs/` is gitignored (`.gitignore:4`), `git ls-files .specs` is empty: nothing in any package is under version control or backed up by the repo. Durable, shared outputs are published through a PR body or committed docs (`docs/adjacent-architecture.md`).

#### Summary table

| Structure | Path (under `.specs/`) | Format | Writer | Reader | Change frequency |
|---|---|---|---|---|---|
| Project context | `project-context.md` | Markdown, 11 labeled bullets | operator + any spec stage when missing | all spec stages, startup.mjs | rare: 1 file, mtime Oct 10 (repo skill changed 4x since Sep 26) |
| Feature context snapshot | `<f>/context.md` | Markdown (free form + fact labels) | spec-architect-initial, spec-upgrade, spec-write | every later stage | once per package, rewritten on upgrade |
| Requirements | `<f>/requirements.md` | numbered Markdown | operator/architect | spec-architect-initial | 3 of 17 packages, once |
| Proposal | `<f>/proposal.md` | Markdown + YAML front matter (`verdict`, `critique_recommended`) | spec-architect-initial | critics, spec-write | once; backed up when re-planned |
| Critique | `<f>/critique.md` | Markdown | spec-architect-critics | spec-write | once |
| Spec | `<f>/spec.md` | Markdown, 10 sections + footer | spec-write | everything | once, rewritten on upgrade/re-plan |
| Step index | `<f>/spec-steps.json` | JSON `{spec, steps[]}` (no version) | spec-write | runtime startup, sentinel, dashboard | once per planning pass |
| Evidence plan | `<f>/evidence-plan.json` | JSON `version: 2` | spec-write (validated) | step-run, review, run, tour, PR | once per planning pass |
| Guardrails | `<f>/criteria.md` | Markdown records | spec-write | step-run, review | once |
| Invariants | `<f>/invariants.md` | Markdown records | spec-write | step-run, review | once |
| Preparation report | `<f>/spec-prepare.md` | Markdown + table | spec-write | humans, runtime checks existence | once (stale after first run) |
| Execution cards | `<f>/step-NNN-subspec.md` | Markdown + 2 YAML blocks | spec-write / spec-subspec-write | owner/editor, sentinel (indirect) | once per planning pass |
| Difficulty input | `<f>/difficulty-input.json` | JSON `schema_version: 1` | spec-write (for Jev) | Jev CLI | once |
| Upgrade note + backups | `<f>/upgrade.md`, `.upgrade-backups/`, `.planning-backups/` | Markdown / file copies | spec-upgrade, spec-write | humans | per upgrade |
| Learning | `<f>/learnings/step-NNN-learning.md` | YAML `learning:` v2 + prose | runtime `spec_complete` (materialized) | next steps, history-index, tour | once per step attempt (overwritten) |
| Evidence artifacts | `<f>/evidence/**` | arbitrary (md/txt/json/mjs/png) | owners/reviewers | review, merge-evidence, tour | per EV gate; dozens to hundreds of files |
| Review | `<f>/reviews/step-NNN-review.md` etc. | YAML `review:` + heading | spec-branch-review (spec-stage-reviewer) | fixer, history-index, run | per step, 1x each |
| Fix | `<f>/reviews/step-NNN-fix.md` etc. | YAML `fix:` | spec-branch-fix | next review (anti-thrash), run | per review that needs fix |
| Final review / refinement | `reviews/final-*.md`, `refinement-completion.md` | mixed (prose vs YAML) | spec-final-review, spec-run, spec-branch-refine | tour, PR | 0-1 per package |
| History index | `<f>/history-index.json` | JSON `version: 1` | runtime (watcher) / `build-history-index.mjs` | workers (navigation) | rebuilt on every learning/review/fix change |
| Inbox / processed | `<f>/inbox/`, `<f>/processed/` | Markdown with 5-key front matter | spec-message / operator CLI; coordinator archives | coordinator, sentinel | created at first dispatch; **0 messages ever** |
| Runtime tree | `<f>/runtime/**` | JSON/JSONL/MD/logs | spec-runtime extension, sentinel | sentinel, dashboard, monitor | continuous during runs |
| Merge evidence | `<f>/merge-evidence.{json,md}` | JSON "version 2" (see drift) + MD | spec-run (then branch-fix updates) | tour, PR, reviewers | assembled once; patched after fixes/rebase |
| Work tour | `<f>/work-tour.{json,html}` | JSON `version: 2` + rendered HTML | spec-work-tour | humans, PR, sentinel (`work-tour.json`) | once per candidate HEAD |
| PR body / rebase log | `<f>/pr-message.md`, `pr-rebase-log.md`, `pr-body.txt` | Markdown | spec-pr | humans | once per publication |
| PR receipt | `<f>/pr-url.json` | JSON `schema_version: 1` (drifted) | spec-pr | sentinel merge reconciliation | once, rewritten on draft->ready |
| Merge reconciliation | `<f>/sentinel-merge.json` | JSON `schema_version: 1` | sentinel observer (explicit reconciliation) | sentinel, epics | once per merge; revalidated every 10 min |
| Manual completion | `<f>/sentinel-completion.json` | JSON `schema_version: 2` | dashboard "Mark complete" | sentinel | 0 present today |
| Legacy/ad hoc | `run-ledger.md`, `preparation.json`, `implementation-record.md`, `conversation-notes.md`, follow-up briefs | misc | pre-runtime coordinators, agents | humans | historic |
| Top-level ledgers | `.specs/performance-interventions.md`, `.specs/pi-runtime-interventions-ledger.md` | Markdown | agents (Oct 5-6) | nobody (no references) | static, stale |

---

### 1. The package directory and `.specs/` root

- **Location / naming**: `<primary checkout>/.specs/<feature>/`. Never inside a linked worktree (`skills/spec-end-to-end/references/workspace-handoff.md:27-60`). `resolve-spec-path.mjs` maps worktree paths back to the primary. Names follow `docs/spec-epics.md` "Naming": `<epic><NN>-<slug>` for epic members (`adj1-…`, `super2-…`), `<NN>-<slug>` or bare slug for standalone, letter suffix for splits. `_`-prefixed children are not packages; `.`-prefixed backups are not excluded by that rule (see Observations). Gitignored (`.gitignore:4`) in this repo; other repos choose.
- **Format**: a directory; identity = absolute path. `canonicalPackage()` (`pi/extensions/spec-runtime/runtime.mjs:137-147`) requires it to be a direct child of a directory named `.specs` whose parent is a primary checkout (`git-common-dir == <primary>/.git`).
- **Purpose**: unit of work for one spec-driven change; folder = lifecycle state.
- **Lifecycle**: created by `spec-architect-initial` (slug derivation, duplicate-ordinal refusal) or `spec-write`; mutated until PR; stays forever. Never renamed after first dispatch (receipts, `pr-url.json`, `sentinel-merge.json` store absolute paths).
- **Writers/readers**: all spec skills write; sentinel enumerates children (`scripts/spec-observe/sentinel.mjs:573`: directories not starting with `_`, cap 100 per `.specs`), `startup.mjs` for prepared entry, `package-files.mjs` for dashboard file serving (bounded 500 entries/page, 10 000 total, depth 12, 8 MiB per file, no symlinks).
- **Relationships**: slug <-> epic member (`_epics/<epic>/epic.json` `packages[].package`), slug <-> worktree `~/.agents-<slug>` on branch `spec-<slug>` (`git worktree list` shows 12 such sibling worktrees still registered after merge; `repo-status` used `spec/repo-status` under `~/.worktrees/agents/`), slug <-> workflow_id (usually equal; `repo-search-index` uses `spec-repo-search-index`; spec-sentinel recorded `None` because it predates workflow ids).
- **Retention**: none. No archive/cleanup step exists for merged packages. Merged packages keep their full `runtime/`.
- **Observations**:
  - `.planning-backups` and `.upgrade-backups` pass the sentinel's package filter (`!name.startsWith('_')`) and `canonicalPackage()`, so sentinel enumerates them as candidate packages and counts them against `packageChildren: 100`. The skills put backups behind `.`, the sentinel only knows `_`.
  - `docs/spec-workflow.md`/`README.md:93-107` document only 9 of ~35 artifact kinds in this audit; `criteria.md`, `invariants.md`, `difficulty-input.json`, `pr-*`, `sentinel-*.json`, `inbox/`, `upgrade.md`, `reviews/final-*` are absent from the user-facing table.
  - Permissions drift: files written through temp-file+rename show `0600` in older packages (spec-sentinel, repo-search-index) and `0644` in newer ones; `runtime/` is `0700`/`0600` throughout.

---

### 2. Shared project context: `.specs/project-context.md`

- **Location**: `<primary>/.specs/project-context.md` (one per repository, shared by all features; legacy root-level `project-context.md` is to be migrated, `skills/spec-end-to-end/references/project-context.md:25-29`). Gitignored here.
- **Format/schema**: Markdown. The template (`project-context.md:43-62`) is 11 bullets: Intended use and users, Data, Compatibility, Scale, Release process, Configuration, Verification, Delivery priorities, Operational authority, Constraints, Unknowns and decisions. The real file (5126 bytes, "Established 2026-10-04; reconciled 2026-10-10 against repository revision d6a022c") adds `Dependencies and reuse` and `Spec placement`, and labels each fact `repository-observed | project-policy | user-confirmed | assumed`. No machine schema; no front matter.
- **Purpose**: record, once, who uses the product, what data is valuable, what compatibility/release/authority applies, so specs scale proof to exposure rather than re-asking.
- **Lifecycle/frequency**: created when missing at first intake; edited when a user decision changes policy. This file: mtime Oct 10 10:17 (a single reconciliation after 6 days). The skill that defines it has 4 commits (Sep 26 -> Oct 5), the latest removing preparation hashes.
- **Writers**: spec-architect-initial / spec-write / spec-upgrade (any stage that finds it missing), operator by hand.
- **Readers**: every stage (read at resolve); `startup.mjs:32` makes its existence a **hard prerequisite** of prepared dispatch (`dirname(packagePath)/project-context.md` must exist or `Prepared input missing: shared project-context.md`); `spec-gym-extract` copies it into scenario inputs (rewritten to `<SOURCE_PACKAGE>`); `warden-evidence.mjs:60` treats edits to it as `'unknown'` verification state.
- **Relationships**: each package's `context.md` is a snapshot of the relevant facts of this file; `evidence-plan.json.context.path` points to the snapshot, not here.
- **Retention**: single living file, no history except the revision SHA string in its header.
- **Observations**: (a) Snapshot drift is real and undetected: adj1's `context.md` (10:33, after the project-context reconciliation at 10:17) quotes the superseded 2026-10-04 policy ("env vars and CLI args only, no config files", "no new runtime dependencies", "no CI tests"), while the current file says model assignments/time limits are operator controls and the runtime depends on a locked watcher. adj7's `upgrade.md` explicitly corrects "stale 2026-10-04 policy claims". The contract says "check relevant sources for material changes ... A new file timestamp alone is not material" (`project-context.md:36-41`), but nothing mechanically compares snapshot to source. (b) The contract talks about "Operational authority" as a field, but authority per task is also scattered through each `context.md` as dated quotations.

---

### 3. Feature context snapshot: `<feature>/context.md`

- **Location**: `.specs/<f>/context.md`. Present in 16/17 packages (absent only in the June `3-agent-docs-automation`). Size 10-18 KB.
- **Format**: Markdown, level-1 heading `# Context: <title>`, sections "Sources and authority", facts labelled `user-confirmed`, `project-policy`, `repository-observed`, `assumed`, with revision SHAs and dated quotations; also "Permitted verification environments", deliberate omissions, unresolved questions, and (after upgrade) an "Upgrade reconciliation <date>" section. Definition: `project-context.md:31-39`. No machine schema.
- **Purpose**: the sourced constraint set a worker/reviewer reads instead of the conversation; separates what was decided from assumed; "records constraints, not new authority".
- **Lifecycle**: written at intake (before architecture), kept immutable in principle during execution ("Do not silently edit an immutable prepared snapshot"), refreshed through intake/preparation or upgrade. Observed mtimes cluster at planning: adj1 Oct 10 10:33, repo-search-index Oct 6 11:49; re-written for upgraded packages (adj3 Oct 10 20:43, adj5 Oct 11 00:33, adj6 Oct 11 07:28).
- **Writers**: spec-architect-initial (first), spec-upgrade and spec-write (refresh).
- **Readers**: spec-write, subspec-write, step-run (first use), branch-review, work-tour (tour `context.{artifact,summary,decisions,omissions,burden}`), spec-gym-extract (copied), process-improvement, startup.mjs (existence is required: `startup.mjs:29-31`).
- **Relationships**: `evidence-plan.json.context.path`, `merge-evidence.json.context.{path,sha256}`, `work-tour.json.context.artifact`.
- **Retention**: stays; old versions only survive in `.planning-backups`/`.upgrade-backups`.
- **Observations**: Hash binding exists only in `merge-evidence.json.context.sha256` (adj1..4 style), not in the plan. A later edit to `context.md` is not detected by anything that does not recompute that hash (sentinel and runtime do not).

---

### 4. `requirements.md` (optional)

- **Location**: `.specs/<f>/requirements.md`. 3 instances (super1, super2, super3).
- **Format**: numbered Markdown list, `# Requirements: <title>`, "Source: user direction on <date>".
- **Purpose**: raw operator ask preserved verbatim before architecture.
- **Lifecycle**: written once by the operator/orchestrating agent before `spec-architect-initial`; never changed.
- **Writers**: human or the coordinating agent. **Readers**: `spec-architect-initial` ("read it first", `SKILL.md:32`), `spec-write` (`SKILL.md:71`).
- **Observations**: optional, rarely used (3/17); for the 14 others the original ask lives only in `context.md` quotes.

---

### 5. `proposal.md`

- **Location/format**: `.specs/<f>/proposal.md`, 17/17 packages. Markdown with **YAML front matter as the first bytes**: `verdict: COMPATIBLE | COMPATIBLE_WITH_CAVEATS | INCOMPATIBLE`, `critique_recommended: true|false` (`skills/spec-architect-initial/SKILL.md:165-200, 290-310`). Body: Summary, Constraints & Assumptions, Verdict, Critique Recommended, architecture, steps outline. 20-49 KB.
- **Purpose**: chosen architecture; primary input for spec-write.
- **Lifecycle**: written once at architecture; not touched after spec-write (adj1: Oct 10 10:06, spec.md next).
- **Writers**: spec-architect-initial. **Readers**: spec-architect-critics, spec-write, spec-upgrade.
- **Observations**: The front matter is billed as "the machine-readable signal source" but no script parses it (`grep critique_recommended` only hits the writing skill). Distribution: 16/17 `COMPATIBLE_WITH_CAVEATS`, 15/17 `critique_recommended: true` - near-constant, so it carries little information. `prototype-component-library` has proposal + context only (no spec): a proposal-only package is a legal end state and sentinel shows it as `proposed`.

---

### 6. `critique.md`

- **Format**: Markdown, two practitioner perspectives, "Must Address / Should Address / Consider" recommendations; `critique.md` for pipeline, `CRITIQUE-[name].md` for loose material (`spec-architect-critics/SKILL.md:277`). 14/17 packages.
- **Lifecycle**: once; reconciled by spec-write into `spec.md` (Notes) and `spec-prepare.md` ("Review corrections").
- **Writers/readers**: spec-architect-critics / spec-write, spec-subspec-write, spec-branch-review (checks Must Address landed).
- **Observations**: No machine form of the recommendation priorities; reconciliation is only prose in `spec-prepare.md`.

---

### 7. `spec.md`

- **Location/format**: `.specs/<f>/spec.md`, 16 packages; 22-88 KB. Level-1 heading on line 1, then (`spec-write/SKILL.md:145-357`) 10 required sections: Qualifications, Problem Statement, Goal, Architecture, Acceptance Criteria (`AC-n`), Executable Evidence Plan (Evidence Posture, `CL-n`, `FH-n`, `EV-n`), Pre-mortem (`PM-n` with `Disposition:`), Notes (incl. "Deferred work"), Implementation Steps (flat integer numbering; each step ends with tag lines `Covers:`, `Complexity: easy|medium|hard`, `Visual: yes|no`, `Evidence:`), Applicable Rules. Footer (`SKILL.md:375-391`): `Spec folder: .specs/<f>/ [(phase N)]` and `Visual design: yes-visual-design|no-visual-design`. All 16 specs carry the footer.
- **Purpose**: canonical prose for behavior, acceptance, and step list; "agent instructions, not human review".
- **Lifecycle**: written once by spec-write (atomic temp+rename), overwritten wholesale on re-plan/upgrade after a snapshot to `.planning-backups/<f>/<ts>/`. Corrected by "needs-spec-correction" returns to spec-write; execution never edits it ("immutable preparation").
- **Writers**: spec-write (and spec-upgrade through spec-write). **Readers**: step-run (assigned step only), subspec-write, branch-review, work-tour, spec-gym-extract (profile copies it), sentinel indirectly (`spec-steps.json`.spec path).
- **Relationships**: AC-n -> `evidence-plan.json.claims[].requirements`; step numbers <-> `spec-steps.json` <-> `step-NNN-subspec.md`; `Evidence: EV-n` tags <-> `evidence-plan.json.gates[].ownerStep`; footer path = `spec-steps.json.spec`.
- **Observations**: (a) `spec-branch-review` refers to an `## Adaptations` log (`SKILL.md:186, 551`) that no skill writes and no package contains. (b) adj1's `spec.md` was edited 36 minutes after its PR receipt (14:45 vs 14:09) without any refresh of `merge-evidence.json` or the tour (they bind commit and context hash, not spec hash). (c) Steps are addressed by integer in `spec-steps.json` but zero-padded string in review/fix (`step: "001"`), integer in learning (`step: 1`).

---

### 8. `spec-steps.json`

- **Location/format**: `.specs/<f>/spec-steps.json`, 16 files. **No `version`/`schema_version`**. Schema (`spec-write/SKILL.md:393-434`): `{ "spec": ".specs/<f>/spec.md", "steps": [ { step:int, name, description, difficulty: easy|medium|hard, visualDesign: bool, evidence: ["EV-n"…], design?: {workspace, design, step, path, sha256} } ] }`. Census: 109 step entries with `evidence`, 8 (all in the June `3-agent-docs-automation`) without; `design` appears in none yet.
- **Purpose**: derived index so runners can enumerate/route steps without parsing Markdown; "spec.md stays canonical".
- **Lifecycle**: written last in planning, reconciled to spec.md; difficulty can be refined once after Jev `step-difficulty` advice. Not touched during execution.
- **Writers**: spec-write. **Readers**: `startup.mjs:34-40` (validates ordered unique positive ints, picks cards, routes `hard` -> strong owner), spec-run, sentinel `readStepIndex` (progress bar position/total, `spec_progress`; `accepted_steps` stays null), dashboard, epics status (`proposed` vs `prepared` = file exists), spec-gym-extract.
- **Relationships**: `step` <-> `step-NNN-subspec.md` filename (zero-padded 3) <-> learning/review/fix names.
- **Observations**: Presence of this file is the **definition of "prepared"** in epic status (`docs/spec-epics.md` derived-status table), even though `spec-prepare.md` may say `Outcome: decision-required / Package prepared: no` (adj1, adj7). No schema version means the `design` extension and `evidence` array were added silently.

---

### 9. `evidence-plan.json`

- **Location/format**: `.specs/<f>/evidence-plan.json`, 15 files, all `version: 2` today (v1 still accepted by the validator with a legacy notice). Schema (`skills/spec-work-tour/references/executable-evidence.md:424-470`, enforced by `skills/spec-work-tour/scripts/validate-evidence-plan.mjs:1-120`): `{version, spec, context:{path}, posture:{risk: low|medium|high|critical, rationale, changeTypes[], boundaries[], impacts[], reversibility: easy|moderate|hard|irreversible, uncertainty: low|medium|high, requiredLayers[], independence[], environments[], qaMode: automated|automated-with-exploration-output|blocked-automation-gap}, claims[{id CL-n, phase: merge|deploy|post-deploy, statement, requirements[], failureHypotheses[], gates[]}], failureHypotheses[{id FH-n, statement, claims[], gates[]}], gates[{id EV-n, phase, required:bool, kind, description, claims[], rejects[], ownerStep:int, command, artifact, environment, effects, authorization, independence}]}`. Validator checks reciprocal links, one owner per gate, claims and gates in the same phase, at least one merge claim, each claim has a required rejecting gate.
- **Purpose**: traceability graph AC -> CL -> FH -> EV and execution routing; ties evidence to the step that owns it.
- **Lifecycle**: authored in spec-write's first phase, "written after the other outputs" then validated once after reconciliation; steps and reviewers do not edit it. IDs are stable across re-plans ("preserve stable identifiers where their meaning survives"). Version history: v2 introduced Sep 26 (`f6185dc feat(spec): make planning and proof context-aware`).
- **Writers**: spec-write (+ spec-upgrade). **Readers**: step-run (owned gates), branch-review (graph), spec-run (mirror to merge-evidence), work-tour, spec-pr, validator, sentinel (existence checked in spec-gym extract profile only).
- **Relationships**: `ownerStep` <-> step number; `gates[].artifact` -> `evidence/…` or a committed test path; mirrored into `merge-evidence.json.{claims,failureHypotheses,gates}` and `work-tour.json.{claims,gates}`.
- **Observations**: The graph is triplicated (plan, merge-evidence, tour) with different key spellings (`claims`/`rejects`/`observedCommit` vs `stepCommits`); the mirrors are hand-assembled by agents and have no validator (see 31).

---

### 10. `criteria.md` (implementation guardrails) and 11. `invariants.md`

- **Location/format**: optional files, 14/17 and 13/17 packages respectively. Written by spec-write step 4 (`prepare-package.md:100-116`), only when a guardrail/cross-step ownership constraint exists (otherwise the file must be absent).
  - `criteria.md`: `# Implementation Guardrails`, `Source: .specs/<f>/spec.md`, then per property a `## <Heading>` with `Statement:` (prose, no commands), `Source:`, `Applies to: establish: step N | preserve: steps … | final completion`.
  - `invariants.md`: `# Cross-Step Invariants`, `## INV-n <title>` with `Status: live|superseded`, `Statement:`, `Source:`, `Establishing step:`.
- **Purpose**: implementer guidance (not an audit program); reviewers consume only `Statement:` of live entries.
- **Lifecycle**: generated at preparation; invariants.md can be appended by later specs and entries superseded explicitly. Written once in practice.
- **Writers**: spec-write. **Readers**: step-run, subspec-write, branch-review (`SKILL.md:194-195`), spec-final-review, spec-gym-extract (copied "when present").
- **Relationships**: `Applies to` references step numbers; INV ids are cited from learnings/reviews/subspec `Live invariants:` lines.
- **Observations**: `criteria.md` has no ids (identified by heading text), so cross-references are by title. super3 has `criteria.md` but no `invariants.md`; 14 vs 13 counts show the "absent when not applicable" rule works.

---

### 12. `spec-prepare.md`

- **Location/format**: Markdown, `# Preparation: <title>`; contents per `prepare-package.md:291-318`: version line ("Preparation version: 3"), outcome `prepared | decision-required | blocked`, review corrections, step/guardrail reconciliation, a per-step table (difficulty, visual summary, card path, strategy, focused command, verdict), evidence/dispositions, advisory and validation notes, open blockers. 15 packages.
- **Purpose**: human-readable report of the planning invocation; legacy filename retained ("does not imply a separate skill").
- **Lifecycle**: rewritten on every spec-write run; **never updated afterwards**.
- **Writers**: spec-write / spec-upgrade. **Readers**: startup.mjs (existence required for prepared dispatch, `startup.mjs:29-31`), spec-gym-extract profiles, humans; the version-3 `preparation.json` hashes it (`reportSha256`) in older packages.
- **Observations**: Point-in-time snapshot that goes stale: adj1's report says `Outcome: decision-required ... Package prepared: no` and every card row `blocked`, and the cards keep `verdict: blocked`, yet all four steps were executed and merged 4 hours later (see 13). Because `startup.mjs` only checks existence, execution proceeded.

---

### 13. `step-NNN-subspec.md` (execution card)

- **Location/format**: `.specs/<f>/step-<NNN>-subspec.md` (3-digit zero-pad), one per `spec-steps.json` entry. Counted 109 (+ copies in backups). 3.5-8.6 KB. Structure (`skills/spec-subspec-write/SKILL.md`): H1, one-sentence objective, then **two strict YAML blocks** - `planning: {version: 2, step, output_file, verdict: ready|needs-spec-correction|blocked}` (new cards allow no extra keys; legacy `spec_sha256` ignored) and `verification: {strategy: test-first|implementation-first, commands[], test_files[], cases[]}` - then `### Targets` (files; `Evidence: EV-n — rejects FH-n for CL-n — command — env — artifact — proof boundary`; `Production wiring:`/`Concrete adapter:`; `Visual reference:`), optional `### Visual Implementation Brief` (8 fixed fields), `### Edit Sequence`, `### Setup and Hazards` (with `Risk lenses:` from a fixed 12-label vocabulary and `Live invariants:` for medium/hard), optional `### Correction or Blocker`, footer `Subspec: .specs/<f>/step-NNN-subspec.md (step N)`.
- **Purpose**: the technical hand-off to a retained owner/editor pair; workers do not re-derive planning.
- **Lifecycle**: written in spec-write phase 2 by the same planner (leaf `spec-subspec-write` only on escalation); then treated as immutable ("Keep prepared subspecs immutable as historical inputs", `spec-run/SKILL.md`). Census: 91 `ready`, 12 `blocked` (adj1:4, adj3:2, adj7:6), 6 retain obsolete `spec_sha256`.
- **Writers**: spec-write (parent only; leaf writes only its own card). **Readers**: `spec_dispatch` (path is the step identity and part of the launch contract), owner/editor, `build-history-index`, reviewers.
- **Relationships**: filename number <-> `spec-steps.json`; `Evidence:` lines <-> gates; `Live invariants:` <-> `invariants.md`; learnings/reviews/fixes named `step-NNN-*`.
- **Observations**: `verdict: blocked` remains in adj1 (4/4) and adj3 (2) after the steps were completed and merged, so "every planning verdict is `ready`" (a validation bullet in `prepare-package.md`, §6) is untrue for merged packages. The immutable-card policy conflicts with a status-like field.

---

### 14. `difficulty-input.json`

- **Location/format**: `.specs/<f>/difficulty-input.json`, 5 packages (adj1, adj3, adj4, adj6, adj7). `{schema_version: 1, steps:[{id, planner_difficulty, objective, precedent, settled_contracts, remaining_judgment, failure_consequences, focused_evidence}]}` - the input contract of the Jev `step-difficulty` CLI (`scripts/jev/README.md`).
- **Purpose**: persisted request to the advisory difficulty service.
- **Lifecycle**: written when spec-write calls Jev during "Refine complexity once"; 5/17 packages kept it (others presumably used a temp file or no advice).
- **Observations**: No skill names the file; it is only an input retained by agents. Retention is accidental. The corresponding output (advice) is only recorded as prose in `spec-prepare.md` ("Jev step-difficulty ... unavailable with uncertainty budget") - adj1 and adj7 both record "unavailable", so the pipe was not effective.

---

### 15. `upgrade.md`, `.upgrade-backups/`, `.planning-backups/`

- **Location/format**: `upgrade.md` (5 packages: adj3-7), Markdown with Date/Outcome, original snapshot path, context source, retained outcomes, consequential changes, remaining blockers, validation (`spec-upgrade/SKILL.md:107-110`). Backups: `.specs/.upgrade-backups/<f>/<run-ts>/` (5 dirs) and `.specs/.planning-backups/<f>/<ts>/` (10 packages, 13 snapshots): copies of context/spec/steps/evidence-plan/subspecs/invariants/criteria/critique/spec-prepare (162 files, ~1.9 MB total).
- **Purpose**: since specs are gitignored, Git is not a backup; snapshot before overwrite. `upgrade.md` explains what changed in an upgraded package.
- **Lifecycle**: per upgrade or re-plan; never pruned; backups are the only history of a prior plan.
- **Writers**: spec-upgrade (`upgrade.md`, `.upgrade-backups`), spec-write (`.planning-backups`). **Readers**: humans only (no script reads them).
- **Retention**: forever; small (1 MB each).
- **Observations**: **Two backup roots with different rules**: spec-write -> `.planning-backups/<f>/<snapshot>`, spec-upgrade -> `.upgrade-backups/<f>/<unique-run>/`. Snapshot directory names are free-form and inconsistent: `20261010T101000`, `shared-owner-20261010T103322`, `20261010-critique-spec`, `20261010T205523Z`, `20261006T153301.337960Z`, `20261011T112500Z-prepare-reconcile`. Both roots are `.`-prefixed and therefore visible to sentinel's package enumeration (see 1). Backups copy `context.md` too, so stale policy text is duplicated.

---

### 16. Visual references: `prototype/`, `visual-references/`, `reference/`

- **Defined**: `spec-write/SKILL.md:74-77` - existing visual input is copied (byte-identical reuse; conflict = stop) into `.specs/<f>/visual-references/`, or an in-package `prototype/` stays in place; design-package screens are not copied but referenced by identity (path + sha256 via `scripts/design/cli.mjs ref`) in the spec Architecture "Design reference:" line and each `Visual: yes` step.
- **Observed**: none of the 17 packages has a `prototype/` or `visual-references/`. The only related directory is `prototype-component-library/reference/route-ladders/` (a manifest, README, `board-results.json` and copies of another package's `records/*.md`) - a third name for reference material, created by hand for that package.
- **Observations**: Documented path conventions are unexercised here; `spec-steps.json.design` is also unexercised. `route-ladders/records/` duplicates files that belong to a different feature package (`context.md`, `merge-evidence.md`, `spec-prepare.md`, `step-006/007-subspec.md`).

---

### 17. `learnings/step-NNN-learning.md`

- **Location/format**: `.specs/<f>/learnings/step-<NNN>-learning.md`. 82 files (81 in YAML v2, 1 free-prose recovery record at adj4 step-007). Older packages' "historical root-level learning copies" still exist as a supported read path (`spec-run/SKILL.md` History Index; none found at root today). Schema (`skills/spec-step-run/SKILL.md:306-345`): fenced `learning:` block with `version: 2`, `kind: step`, `step`, `outcome: as-specified | adapted | checkpoint | no-artifact | decision-required | needs-spec-correction`, `commit` (SHA|none), `verification: {commit, strategy, fix_attempts, commands[{command, phase: red|green|verify, outcome: pass|fail|hung|skipped}]}`, `evidence[{id, status: passed|failed|blocked|pending, phase, artifact, rejects, proof_boundary}]` (+ `observedCommit`, `applicability` for reuse), `introduced[{symbol, path, purpose}]`; followed by prose (decisions, departures, `## Findings for subsequent steps`). In managed runtime the command entries gain `receipt`, `observed_at`, `started_at`, `elapsed_ms`, `exit_code`, `artifact` (`completion.mjs:34-48`) - fields not in the skill's schema. Outcome census: 63 `as-specified`, 18 `adapted`.
- **Purpose**: the step's durable handoff: what was done, evidence status, symbols for later steps, findings to later owners.
- **Lifecycle**: one per step attempt; in the Pi runtime it is **materialized by `spec_complete`** from the owner's structured submission (`runtime/runs/<run>-completion.json`) plus recorded verification receipts, written atomically with mode 0600 (`completion.mjs:24-27, 61`). Overwritten when a step is re-completed.
- **Writers**: runtime `spec_complete` tool (owner judgments + receipts); outside Pi, the owner by hand. **Readers**: next step workers (via history index), reviewers (`step` mapped via `learning` YAML `commit`), `build-history-index`, `spec-watcher` (triggers index refresh), work-tour/merge-evidence assembly, process-improvement.
- **Relationships**: `commit` <-> git SHA in the worktree; `evidence[].id` <-> EV gates; `verification.commands[].receipt` <-> `runtime/runs/<id>-verification.json` receipt ids; `artifact` -> `runtime/runs/<id>-verification-<receipt>.md`.
- **Retention**: forever.
- **Observations**: The learning embeds absolute paths into `runtime/` (e.g. `/Users/ryanmahoney/.agents/.specs/adj1-foundational-contracts/runtime/runs/…md`), so deleting/pruning `runtime/` breaks learning artifact links. `observedCommit` (camelCase) in learnings vs `observed_commit` (snake) in fix records vs `observedCommit` in merge-evidence/tour: three casings for the same concept.

---

### 18. `evidence/` directory

- **Location/format**: `.specs/<f>/evidence/**` ("non-committed artifacts ... under the prepared filename", `spec-step-run/SKILL.md:262-285`). 13 packages. Free-form: `ev-N-result.md` (34), `ev-N.txt`, `step-N-fix.txt`, `step-N-review-evidence.md`, `qa-tour.md` (4), verifier scripts and result JSON (`rpc-compat.mjs/.json`, `contracts-check.*`), screenshots (`screenshots/*.png`, `screenshots-step-N-fix-verified/`), `*.patch`, `branch-1-*-repro.mjs`, `planning/`.
- **Purpose**: concrete observations behind each EV gate (command output, captures, disposable verifier sources). Gate artifacts must contain actual observations, not just test source (`executable-evidence.md:471-472`).
- **Lifecycle**: created by step owners and by reviewers (reviewer `step-N-review-evidence.md`), added to during fix cycles; never cleaned.
- **Size**: 0-27 MB per package (adj5: 27 MB, adj3: 7.3 MB, adj6: 5.2 MB, repo-status: 2 MB; PNG captures dominate).
- **Writers**: spec-step-run owners, step reviewers/fixers, spec-branch-fix. **Readers**: reviewers, merge-evidence (`gates[].artifact`), work-tour (links, `tour-browser-N.png`), spec-pr.
- **Observations**: Names are only stable where the card prescribes them; there is no manifest, hence `merge-evidence.json.artifactRevisions` (adj1/2) is an ad hoc per-file revision map.

---

### 19. `reviews/*-review.md` (step, final-N, branch-N)

- **Location/format**: `.specs/<f>/reviews/step-<NNN>-review.md`, `final-<k>-review.md` (bounded final fix review), `branch-<i>-review.md` (explicit refinement only). Level-1 heading + one fenced YAML record `review:` (`spec-branch-review/SKILL.md:595-657`): `kind: branch|step`, `iteration` | `step`, `target: <base>..<head>`, `scope: committed|working-tree|step`, `commit`, `verdict: pass | needs-fix`, `evidence_verdict: proven|incomplete` (branch only), `findings[{id Fn, severity HIGH|MED|LOW, category (correctness|guardrail|evidence|simplification|security…), actionable, file, line, symbol, commit, signature, explanation, correction}]`, optional `limitations[]`, `fix_verdicts[]` (step records; required), `dismissals[]`, `decision_required`. Census: 85 review files: 58 `needs-fix`, 34 `pass`, 1 `pass-after-fix` (not in the schema), 2 legacy prose without YAML (adj4, adj5). 174 findings: 153 MED, 16 HIGH, 5 LOW; categories correctness 116, guardrail 22, evidence 22, simplification 6, security 6.
- **Purpose**: independent per-step audit of an exact commit range, anti-thrash memory via stable `signature` strings.
- **Lifecycle**: one per completed step, launched in background while the next step runs; range pinned to full SHAs; a second round only as `final-2`. Never rewritten.
- **Writers**: `spec-branch-review` run by `spec-stage-reviewer` (never edits code). **Readers**: `spec-branch-fix`, the next reviews (prior dismissals / `fix_verdicts`), `build-history-index`, spec-run (reads only the leading YAML), work-tour/merge-evidence (`stepReview.reviews[]`).
- **Relationships**: `commit`/`target` <-> git; `findings[].signature` <-> fix `decisions[].signature`; `step` <-> learning/subspec.
- **Observations**: (a) The `target` of adj1 step-001 is `d6a022c..d6a022c` (same SHA both ends, empty range) because that step's deliverables were non-committed evidence in `.specs/`; the schema allows it but the review verifies nothing in Git. (b) `step` is a quoted string (`"001"`) here but an integer in learnings/spec-steps. (c) All 169 fix decisions across 58 fix records are `fixed`; none `dismissed`, so the dismissal-class machinery (false-positive/intentional/accepted-risk/deferred/unfixable) and `dismissals[]` are unexercised in 8 packages.

---

### 20. `reviews/*-fix.md`

- **Format**: `# Step Fix — step 001 (<f>)` + YAML `fix:` (`spec-branch-fix/SKILL.md:200-247`): `kind: branch|step`, `iteration|step`, `consumed:` (absolute path of review), `target`, `decisions[{id, decision: fixed|dismissed, dismissal: false-positive|intentional|accepted-risk|deferred|unfixable, approved?, approval_source?, signature, note}]`, `material_change`, `commit` (SHA|none), `verification[{evidence, outcome, observed_commit}]`; prose scope/checkpoint sections allowed after. 58 files; 56 have `observed_commit`.
- **Purpose**: record each decision once; feeds anti-thrash memory; `material_change:false` is the "stalled" signal in the refine loop.
- **Lifecycle**: written by fix worker between steps (never overlapping a step writer); commit named `fix(<scope>): …`; `commit: none` for non-committed evidence-only fixes (adj1 step-001).
- **Writers**: `spec-branch-fix` (agent `spec-step-fixer`, model = reviewed step's owner). **Readers**: next reviews, spec-run (decides to launch fixer when `verdict: needs-fix` and no fix file exists), history-index, merge-evidence.
- **Observations**: `consumed:` embeds an absolute path (non-portable). The "no fix file => needs a fixer" rule makes file existence the work queue; an interrupted fixer that wrote the file leaves a "done" marker without proof.

---

### 21. `reviews/final-review.md`, `final-*-input/verification.json`, `refinement-completion.md`

- **final-N-review/fix** (`final-1-review.md`, `final-1-fix.md`, `final-2-review.md`): the bounded final fix review from `spec-run`, same schema as step reviews with `step: final-1`. Observed in adj5, adj6.
- **`reviews/final-review.md`**: written by `spec-final-review` (`SKILL.md:96-107`): "concise report: reviewed base/HEAD, exact model assignments, concerns and dispositions, changed commits, evidence, resulting HEAD, push result, unresolved findings, outcome `complete|blocked`" plus assessment budget. 3 packages (adj4, adj5, adj6). **Two incompatible shapes**: adj4/adj5 are free prose with bold `Outcome: **complete**`; adj6 is a YAML `review:` with `kind: final`, `scope: whole-branch`, `verdict: pass-after-fix`, `outcome: complete`, `findings[]` with `disposition`, `originally_actionable`, `unresolved_findings` - none in the review schema.
- **adj4 `reviews/final-{triage-input,verification-input,verification}.json`**: Jev CLI inputs/outputs preserved (`schema_version: 1`, `policy`, `base_revision`, `change_summary`, `acceptance_criteria`, `mandatory_gates`, `focused_checks`, `planned_ci_checks`, `evidence`, `findings`, `outcome`; `final-verification.json` has `reviewedBase/Head, finalHead, patchSha256, applicability, commands, jev, safety, limits`). One-off.
- **`reviews/refinement-completion.md`** (`spec-branch-refine/SKILL.md:153-170`): YAML `refinement:{outcome: proven|verified-at-cap|cap|stalled|decision-required|needs-spec-correction, max_iterations, iterations_completed, commit, review, fix, independent_post_fix_review, evidence_verdict, unresolved[]}`. 1 instance (repo-status).
- **Purpose**: record the final reviews/refinement budget so tour/PR consume completion instead of relaunching reviews.
- **Writers/readers**: above skills / spec-work-tour (`audit` fields), spec-pr.
- **Observations**: `final-review.md` format is unspecified beyond prose, so three variants exist; tooling cannot parse it.

---

### 22. `history-index.json`

- **Location/format**: `.specs/<f>/history-index.json` (12 packages; mode 0600). `{version: 1, purpose: "navigation only; source records remain authoritative", records:[{path, kind, step, verdict|null, signatures[], decisions[], status, headings[], introduced, proseSections[], relevantPaths[]}]}` generated by `skills/spec-run/scripts/build-history-index.mjs` (parses fenced YAML blocks and headings of learnings, reviews, fixes, including historical root-level learnings).
- **Purpose**: let workers locate decisions, introduced symbols and unresolved findings without rescanning prose. "An indexing failure is never an empty history."
- **Lifecycle**: built at first prepared dispatch if absent (`startup.mjs:46-51`), then rebuilt by `completion.mjs`/`spec-watcher` on any learnings/reviews/runtime-runs change (watch list at `completion.mjs:222-231`). adj5, super1, super3 and spec-sentinel show it modified after the PR receipt (late learnings/reviews).
- **Writers**: runtime (spec-runtime extension), `build-history-index.mjs` CLI. **Readers**: owner/editor/reviewers (path passed in prompts), step-run "Prior Step Handoff".
- **Relationships**: indexes paths in `learnings/`, `reviews/`; script is also imported directly by `startup.mjs` and `completion.mjs` (code coupling to a skill script).
- **Observations**: derived, regenerable, yet persisted. Because it embeds absolute path fragments and signatures, copies drift. It is the only derived file the docs call out clearly as "not authority".

---

### 23. Overseer mailbox: `inbox/` and `processed/`

- **Location/format**: `.specs/<f>/inbox/<id>.md`, `.specs/<f>/processed/<id>.md`. One UTF-8 Markdown file per message with 5-key front matter (`id`, `run`, `sender`, `audience`, `kind`), audiences `coordinator|implementation|step-NNN|review|fix`, kinds `direction|information|hold` (`skills/spec-end-to-end/references/overseer-inbox.md:26-60`). Atomic tmp+rename delivery by `spec-message`; archival to `processed/` by the top-level coordinator only; receipts live in the stage ledger/checkpoint (id, sha256, outcome `applied|not-applicable|held|decision-required|needs-spec-correction`, `release_source_id`).
- **Purpose**: one-way operator steering of a running spec.
- **Lifecycle**: both dirs created empty at first dispatch (`startup.mjs:45`). **All inbox/ and processed/ dirs in all 11 runtime packages are empty**: no real message has ever been sent or the archive was never retained.
- **Writers**: `spec-message` skill; `scripts/spec-observe/overseer-inbox.mjs` (the dashboard operator path: sender fixed to `operator`, **audience restricted to `coordinator`, kinds restricted to `hold|direction`**, 64 KiB cap, control chars refused). **Readers**: coordinator, `startup.mjs` (any `*.md` in `inbox/` makes startup return `needs_intake`), sentinel `readInboxGuard` (`sentinel.mjs:1323`; max 200 files, 64 KiB per file, 1 MiB total, projected into `checkpoint.json.inbox`).
- **Relationships**: `run` <-> run id (stage ledger / `runtime/sentinel/<workflow>/checkpoint.json.workflow_id`); hold release by `release_source_id` direction.
- **Retention**: archived originals kept forever by design.
- **Observations**: Protocol is the most elaborate (hash-bound hold release) and the least used. Protocol vs implementation mismatch: skill allows 5 audiences and `information`; the dashboard CLI emits only coordinator-audience hold|direction. `startup.mjs` does not validate front matter, so a stray `.md` blocks dispatch until intake.

---

### 24. `runtime/` - managed Pi run records (overview)

All under `.specs/<f>/runtime/` (`docs/spec-runtime-observation.md:5-18`, `pi/extensions/spec-runtime/README.md:200-211`). Directory `0700`, files `0600`, all JSON written atomically (tmp+rename), all keyed by absolute paths. Sizes per package: 20-540 MB. Writer for all of the below: the `spec-runtime` Pi extension (`runtime.mjs`, `completion.mjs`, `monitor.mjs`, `sentinel*.mjs`), except where noted. Common retention: none; no pruning anywhere (`rmSync` is used only for lock directories).

**24a. `runtime/run.json`** - latest assignment receipt. `{schema_version: 1, completion_contract: 1, id, assignment_id (default = step path), workflow_id, package, primary, step, checkout, owner_model, editor_model, scout_model, dispatch_requested_at, attempt_kind (implementation|verification-continuation|implementation-repair|review-repair|launch-retry|null), session_scope (package|step), environment{checkout, primary, observed_only, dependency_paths, build_paths, configured_paths, next}, child_extensions[], owner_session, editor_session, parent_session, lock, package_lock, token, state (running|cancelling|blocked|completed|failed|cancelled), started_at, timeout_ms, pid, result, handoff{status, outcome, learning_path, commit, acceptance, missing[]}, result_truncated, full_result_path, finished_at}`. `completion_contract` absent in 1/11 (spec-sentinel's earlier run). Rewritten every state transition (a few times per step). Read by startup (`state` drives `needs_reconciliation`), sentinel (`RECEIPT_KEYS`), monitor, dashboard. Contains an owner `token` (lease token) and absolute session paths: do not publish.

**24b. `runtime/runs/<run-id>.json`** - historical copy of each assignment receipt (same shape, immutable after finish). 115 files.

**24c. `runtime/events.jsonl`** - append-only lifecycle events `{timestamp, event: run_started|editor_started|editor_finished|verification_finished|…, run_id, …}`; 49 lines for adj1. Reader: monitor/sentinel timing (`timing.attempts`).

**24d. `runtime/assignments/<sha256>.json`** - persistent attempt lookup `{assignment_id, run_id, contract}` keyed by hash of the assignment id; makes `spec_dispatch` idempotent (an identical repeat returns the receipt, a changed contract errors). 115 files.

**24e. `runtime/progress.json`** - derived ledger `{version: 1, observed_at, purpose: "Runtime facts, not acceptance or publication authority", runs[{run_id, step, checkout, execution, started_at, finished_at, handoff, verification_receipts}], stages[…], artifacts[{path, kind: learning|review|fix…, step, assessment}]}`; and **`runtime/stages/<stage>.json`** (`implementation`, `work-tour`, `publication`, also `publication-draft`): `{version: 1, artifacts[], decisions[], next, package, stage, status: complete|…, recorded_at, source: "coordinator assessment; not a runtime verification verdict"}` written by the `spec_checkpoint` tool. This replaces the handwritten run-ledger (`spec-end-to-end/SKILL.md:203-208`).

**24f. `runtime/runs/<run-id>-completion.json`** - `spec_complete` submission `{version: 1, run_id, submitted_at, decisions[], gaps[], findings[], learning{…v2 as in 17}}`; source for the learning markdown. 97 files.

**24g. `runtime/runs/<run-id>-verification.json` + `-verification-<receipt>.md`** - verification receipts from `spec_verify`: `{version: 1, run_id, receipts[{id, command, observed_at, before{commit, dirty}, after{commit, dirty}, exit_code, error, artifact (raw log path), outcome pass|fail, started_at, elapsed_ms, summary_artifact}]}` and a Markdown render of one receipt. Ground truth for timestamps ("Never reconstruct execution timestamps from file mtimes").

**24h. Raw logs and transcripts** - `runs/<run>-command-<uuid>.log` (2 724 files, 5.6 MB; raw stdout/stderr bytes of managed commands), `runs/<run>-editor-<uuid>.jsonl` (+ `.result.txt`), `runs/<run>-owner-<uuid>.jsonl` (+ `.result.txt`) (native Pi JSON streams), `sessions/<pair-hash>/{owner,editor}.jsonl` (retained Pi sessions, + `subagent-artifacts/` scout transcripts). Measured totals across the 11 packages: **editor JSONL 1.80 GB (491 files), owner JSONL 514 MB (115 files), retained sessions ~118 MB**, i.e. ~2.4 GB of the package tree. They contain source and command details, are never read by sentinel ("no transcript read"), and exist for diagnosis only.

**24i. `runs/<run>-activity/{owner,editor}.json`** - bounded monitor snapshot `{run_id, role, started_at (epoch ms), last_activity (epoch ms), phase, activity, hint, error}` rewritten per stream event; watched by the Pi widget. Epoch-ms numbers here vs ISO strings everywhere else.

**24j. `runs/<run>-processes/<pid>.json`** - process-group registry `{pid, role (owner|editor|shell), active, started_at, finished_at}`; 3 330 tiny files (one run has 1 082). Used for lease/cancellation safety, never pruned.

**24k. `runtime/package.lock` (and git-dir lock)** - exclusive writer reservation directories (`<git-dir>/spec-runtime.lock`, `<package>/runtime/package.lock`), removed on release; stale ones are never auto-removed (README "Lifecycle and records").

**24l. `runtime/sentinel/<workflow-id>/`** - Sentinel/runtime-owned state per workflow: `checkpoint.json` (`version: 1, workflow_id, package, checkout, coordinator_session, revision, obligation_revision, state, obligation{key, stage, step?, summary<=160, artifacts[{path, sha256}]}, workers[{id, kind, state}], inbox{items[{id, sha256, outcome, release_source_id?}], observed_directories}, inbox_guard{…}, input_revision, observed_at`; validators `sentinel.mjs:875-1010`), `verification-incidents.json` (per-assignment repeated-failure fingerprints and replay ids), `authority/grant.json` + `authority/activations/<uuid>.json` (mode shadow|recover grant: `actions`, `max_effects`, `max_diagnostics`, `expires_at`, `authority_reference`, revoked/reason), and a legacy flat `runtime/sentinel/verification-incidents.json` (spec-sentinel/early runs). Another audit covers sentinel internals.

- **Relationships (runtime as a whole)**: `workflow_id` (checkpoint key) <-> package slug (equal for 10/11; `spec-repo-search-index` for repo-search-index); `run id` <-> `assignment_id` <-> `runs/<id>.*`; `parent_session` <-> `~/.pi/agent/sessions/…jsonl` and the global index `~/.pi/agent/spec-runtime/<run-id>.json` (826 entries) outside the repo; `learning.commit` <-> branch commits in `~/.agents-<slug>`.
- **Observations**: (1) Runtime evidence for a merged feature is ~96% of package bytes and never expires. (2) Learnings, receipts, tours and `merge-evidence` reference `runtime/runs/*.md` by absolute path, so pruning raw JSONL while keeping `*-verification-*.md` and `*-completion.json` would be safe, but no tool encodes that split. (3) `progress.json.runs[].verification_receipts` is a count, not a list. (4) `run.json.token` is a live lease secret stored in plaintext in an ignored-but-unbacked directory.

---

### 25. `merge-evidence.json` / `merge-evidence.md`

- **Location/format**: `.specs/<f>/merge-evidence.{json,md}`. 12 JSON files. Skill contract (`spec-run/SKILL.md:392-404`): "version 2" JSON that "identifies `context.md` by canonical path, mirrors every CL/FH/EV item and its phase from `evidence-plan.json`, adds actual statuses, commands/outcomes/artifacts/proof boundaries, step commits, QA inputs, separate deployment readiness/authority/observations, merge gaps and later-phase gaps, and the full current `commit`", plus `audit {scope: steps, verdict: pass, commit, artifact: merge-evidence.md}` when step review completion holds. Markdown sections: What was built, Right problem, Correct, Safe, Evidence index, QA tour input, Gaps, Step review completion.
- **Purpose**: evidence assembly bound to current HEAD; the single input of the tour and PR; updated after branch-fix/rebase.
- **Lifecycle**: assembled once by spec-run at the Completion Gate (adj1 14:06), patched on rebase/fix (repo-status and spec-sentinel modified it after the PR receipt).
- **Writers**: spec-run coordinator (hand-assembled by an LLM; no generator script), spec-branch-fix/spec-pr updates. **Readers**: spec-work-tour, spec-pr, reviewers, spec-gym-extract tests only. **No code in `pi/` or `scripts/` parses it** (matches only in `warden-evidence.mjs` filename allowlist and `startup.mjs:26` resume heuristics).
- **Relationships**: `commit` <-> HEAD at assembly; `context.sha256`/`preparation.sha256` (older); mirrors of plan ids; `steps[].{learning,review,fix}` paths.
- **Retention**: forever. 
- **Observations (schema drift - highest-value finding in this area)**: the "version 2" contract has no JSON schema or validator. Only 8 top-level keys are common to all 12 files (`audit, claims, commit, context, deployment, failureHypotheses, gates, spec`). Three families coexist: (i) adj1-4, super1-3: `version: 2`, `steps[]`, `requirements[]`, `stepReview{coverage, reviews[]}`, `qa`, `postDeploy`, `gaps`, `generatedAt`; adj1-4 also keep `preparation:{path, sha256}` although "preparation hashes are not prerequisites" since Oct 5; (ii) adj5-6: `schema_version: 2`, `kind: merge_evidence`, `review_completion{stepReviewCoverage, finalFixReview, artifact, finalReviewReport}`, `stepCommits`, `qaTour`, `mergeGaps` (no `version`, no `steps`); (iii) pre-runtime repo-status / repo-search-index / spec-sentinel: no `version` at all or `version` plus `readyForAudit`, `unreviewedCommits`, `architecture`, `preMortem`, `finalChecks`. Because nothing reads it programmatically the drift is harmless today, but spec-pr/tour (LLM readers) and any future automation must tolerate three shapes. `audit.scope` is `steps` (10), `branch` (1), `working-tour` (1, a typo-like value), or absent.

---

### 26. `work-tour.json` and `work-tour.html`

- **Location/format**: `.specs/<f>/work-tour.json` (12) and `work-tour.html` (12; 40-63 KB single file). JSON `version: 2` (`spec-work-tour/SKILL.md:139-190`; renderer accepts 1 and 2: `render-work-tour.mjs:51-52`): `feature, title, generatedAt, repository, branch, base, commit, verdict (ready|blocked), summary, context{artifact, summary, decisions[], omissions[], burden[]}, architecture{before, after, boundaries[], decisions[{decision, reason, source}]}, implementation{steps[{step, name, commit, files[], outcome}]}, claims[], gates[] (same shape as merge-evidence gates incl. commit/observedCommit/applicability), qa{mode, entrypoints[], scenarios[]}, deployment{readiness, authorization, authorizationSource, postDeploy, gaps[], migrations, configuration, observability[], rollback, residualRisks[]}, audit{scope, verdict, artifact, commit}, gaps[]`. HTML is rendered by `scripts/render-work-tour.mjs` (escapes values, checks unavailable supporting files). All 12 verdicts are `ready` (10 `audit.scope: steps`, 1 `branch`, 1 absent).
- **Purpose**: commit-bound human-facing verdict and walkthrough; "nobody is expected to read the spec or code".
- **Lifecycle**: built after the last step review/fix and base reconciliation; invalidated by any later code/context change; `spec-pr` refuses `ready` when its `commit` != pushed HEAD.
- **Writers**: spec-work-tour (agent writes JSON, script renders HTML). **Readers**: humans, spec-pr, **sentinel** (`LIFECYCLE_FILES` includes `work-tour.json` for ready-tour completion basis), epics. `repo-status` additionally has `tour-support/` (EV captures, copied source) and `repo-status-work-tour.zip` (80 KB) as a shareable bundle.
- **Relationships**: `commit` <-> `pr-url.json.commit` and `merge-evidence.json.commit`; `gates[].artifact` -> `evidence/…`.
- **Observations**: HTML references `.specs/`-relative supporting files; the standard says to "include needed supporting material with it", only repo-status complied (zip). spec-sentinel's tour/JSON are modified after the PR receipt.

---

### 27. `pr-message.md`, `pr-rebase-log.md`, `pr-body.txt`

- **Format**: `pr-message.md` = `# <PR title>` + exact PR body (sections What changes / Why / Verification…); `pr-rebase-log.md` = base SHA, branch, pre/post-rebase HEAD, commands, base delta, conflicts, evidence invalidation/re-establishment (`spec-pr/SKILL.md:85-86, 132`). `pr-body.txt` only in repo-status (older body copy).
- **Purpose**: record exactly what was submitted and how the branch was rebased.
- **Lifecycle**: once at ready publication (written even if rebase is trivial; draft mode rewrites body); 12 each.
- **Writers**: spec-pr. **Readers**: humans only (not sentinel). `spec-pr` verifies the submitted body equals `pr-message.md`.
- **Observations**: `spec-pr` mentions `blockers.md` when present; none exists in any package, no skill writes it.

---

### 28. `pr-url.json`

- **Location/format**: `.specs/<f>/pr-url.json`, 12 files. Documented receipt (`spec-pr/SKILL.md:87-96`): `{schema_version: 1, kind: "pr_submission", package: <absolute>, url, submitted_at, commit, draft: bool, tour: "work-tour.html"|null, parent_session}`; "Sentinel ignores a record without `kind`, `package`, `submitted_at`". Reader: `sentinel.mjs` `LIFECYCLE_FILES` and `merge-reconciliation.mjs` (matches PR url/branch/base).
- **Purpose**: publication receipt: completion basis `ready-pr`, input for merge reconciliation.
- **Lifecycle**: written at draft creation, rewritten at ready; commit must equal pushed HEAD.
- **Writers**: spec-pr (agent, by hand). **Readers**: sentinel (completion, merged-PR checks), epics, dashboard.
- **Observed drift** (12 files, 6 shapes): the documented `draft` key appears in none; `mode: "ready"|"draft"` appears in 6 and is undocumented; both `submittedAt` (camel) and `submitted_at` coexist in 5 (a legacy alias kept beside the new key); extra undocumented keys `draft_submitted_at`, `ready_at`, `updated_at`, a nested `pr{number,isDraft,mergeable,mergeStateStatus,statusCheckRollup,note}` (repo-search-index); adj5 lacks `parent_session`; repo-status is the legacy `{url, submittedAt, commit, tour}` shape that the docs say leaves the package "visible as unfinished and blocks merge reconciliation" (repo-status has no `sentinel-merge.json`). Git: the doc fix landed Oct 11 (`1385f03 fix(spec-pr): document the pr-url.json shape sentinel reads`), after 9 of the files were written, which explains most of the drift.

---

### 29. `sentinel-merge.json`

- **Location/format**: `.specs/<f>/sentinel-merge.json`, 11 files (mode 0600). `{schema_version: 1, package, binding (sha256 of [package, pr.url, branch, base, commits, receipts, checkpoints]), url, branch, base, tip, head, base_tip, checked_at, state: "merged", reason: authoritative-pr|local-pr-merge, merge_commit, merged_at, evidence_source?: "local-git"}` (`merge-reconciliation.mjs:`). Read with `boundedJson` (<=64 KiB, no symlink).
- **Purpose**: cache of a confirmed PR merge so Sentinel can report lifecycle `merged-pr` completion without repeated GitHub calls; "records lifecycle completion, independently of acceptance".
- **Lifecycle**: created on first confirmed merge (observer's active reconciliation, polling every 10 min; 3 local proofs and 6 s network per scan); revalidated against the local branch tip and `refs/remotes/origin/<base>`; invalid if newer dispatches or checkpoints appear.
- **Writers**: Sentinel observer's explicit reconciliation (breaks the "read-only" label; the module says "separate from the read-only observer"). **Readers**: Sentinel snapshot (`fact.merge`), epic status, dashboard.
- **Relationships**: `url` <-> `pr-url.json.url`; `head`/`tip` <-> branch tip; `merge_commit` <-> main.
- **Observations**: adj1 `pr-url.commit` (2657ae7) != `sentinel-merge.tip/head` (ed2dad0): the published SHA changed after PR receipt (post-push fixes); only the receipt's SHA is "bound" to the tour.

---

### 30. `sentinel-completion.json`

- **Format**: `{schema_version: 2, kind: "manual_completion", package, completed_at}` (v1 additionally bound a `revision`), mode 0600, written atomically via temp+rename by `writeManualCompletion()` (`scripts/spec-observe/manual-completion.mjs`). Only through the dashboard's same-origin "Mark complete" action; removal removes the override; a later dispatch reopens work.
- **Present today**: 0 packages. Purpose: operator lifecycle decision independent of worker/acceptance evidence. Listed in `docs/spec-epics.md` as one of the package files epic status reads. Frequency: manual, rare.

---

### 31. Legacy and ad hoc package files

- **`run-ledger.md`** (repo-status): pre-runtime hand-maintained coordinator ledger (run id, canonical paths, role models, authority, review budget, stage table, decisions). The skill still names it for non-managed runs (`spec-end-to-end/SKILL.md:209-213`) and `startup.mjs:26` treats it as evidence of existing progress; the managed replacement is `runtime/progress.json` + `runtime/stages/*`. Last modified Oct 5, after the PR (Oct 4).
- **`implementation-record.md`** (repo-status): execution record kept by the coordinator (dispatches, deadlines); also pre-runtime.
- **`preparation.json`** (repo-status): version 3 hash manifest `{version: 3, preparedAt, specSha256, contextSha256, stepIndexSha256, evidencePlanSha256, reportSha256, criteriaSha256, invariantsSha256, steps[{step, subspec{file, sha256}}]}`. Removed from the workflow Oct 5 (`6be6bfe`); discard on re-preparation; only 1 instance remains. `merge-evidence.json.preparation.sha256` in adj1-4 is the same idea surviving in another file.
- **`conversation-notes.md`** (adj7): free-form operator notes ("not part of the package's specification, acceptance criteria, or evidence plan") - findings that adj7's blocking prerequisites are stale. No skill defines it; acts as a de facto operator annotation.
- **Follow-up briefs** (`repo-search-index/{automatic-refresh,missing-source,model-acquisition,restory-adoption,warm-query-session}.md`): produced from `standalone-engineering-decisions.md` "Deferred work" ("a local follow-up brief ... with an outcome and completion criteria"): `# Follow-up: <title>`, Source, Current limitation, Revisit condition, Actionable scope, Authority and preservation. `missing-source.md` is a "Source clarification resolved" note. Filename and location are unspecified, they sit at package root next to canonical files and are never referenced by the sentinel or any skill.
- **`3-agent-docs-automation/`** (June 21): the pre-pipeline layout: `proposal.md`, `critique.md`, `spec.md`, `spec-steps.json` (no `evidence`), and `subspecs/<N>-spec.md` + `subspecs/route-ladders/`. No context, no evidence plan, no `step-NNN-subspec.md`: such a package cannot be dispatched (`startup.mjs` would throw `Prepared input missing`).
- **Observations**: `warden-evidence.mjs:64-68` maintains a hardcoded allowlist of package artifact names (including legacy `learning.md`, `ledger.md`, `steps/step-N-…` layouts, and `reviews/(step|branch)-N-(review|fix).md` - but **not** `final-N-*`, `final-review.md`, `refinement-completion.md`, `pr-url.json`'s siblings) - a third place besides docs and the sentinel where "what files does a package have" is encoded.

---

### 32. `.specs/performance-interventions.md` and `.specs/pi-runtime-interventions-ledger.md`

- **Location/format**: loose Markdown files directly under `.specs/` (not packages). `performance-interventions.md` (18 KB, mtime Oct 5): "Performance interventions for spec-end-to-end", eight prioritized proposals (owner + Mercury editor pairing, retained sessions, history index, hash-free readiness, ...). `pi-runtime-interventions-ledger.md` (49 KB, mtime Oct 6): "Pi spec runtime implementation ledger" with objective, work-ownership table (`pi_runtime`, `run_observer`, `analyze_step_session`, parent), baseline measurements from a 2026-10-05 legacy run, durable-record paths, install state ("Status: installed and ready for operator restart").
- **Purpose**: working notes from the Pi-runtime rollout; planning ledger for runtime work.
- **Lifecycle**: written Oct 5-6 while the runtime was built; not edited since although the runtime has seen 38 commits through Oct 11; the status line "ready for operator restart" is stale.
- **Writers**: coordinating agents. **Readers**: none - `grep` over `skills/ docs/ scripts/ pi/ README.md` finds no references; the performance file does cross-link the ledger.
- **Observations**: Real design knowledge (rationale, baseline numbers, deferred "additional interventions") lives in two ignored, unreferenced, un-versioned files; `docs/spec-workflow-efficiency.md` and `docs/spec-coding-process-improvements.md` (tracked) are the published successors, so these are likely duplicates in part. The files are siblings of packages and are not excluded by the `_` rule, but are files not directories, so sentinel ignores them.

---

### 33. Cross-cutting identity and linkage model

Keys that tie package structures together (there is no central registry):

| Key | Where it appears | Notes |
|---|---|---|
| package slug | dir name, `epic.json packages[].package`, `workflow_id`, worktree dir `~/.agents-<slug>`, branch `spec-<slug>`, `spec-steps.json.spec`, spec footer | never renamed after first dispatch |
| absolute package path | `run.json`, `runs/*.json`, `pr-url.json.package`, `sentinel-merge.json.package`, `checkpoint.json.package`, review `consumed:`, learning artifact paths | makes packages non-relocatable and non-portable; `package-files.mjs` requires realpath equality |
| step number | `step-NNN-subspec.md`, `spec-steps.json step:int`, learning `step:int`, review/fix `step:"NNN"`, `Evidence ownerStep` | int vs padded string mix |
| AC/CL/FH/EV/PM ids | spec.md, evidence-plan, merge-evidence, tour, learnings, subspecs | stable by convention; validator enforces form `^(CL|FH|EV)-[1-9]\d*$` only |
| commit SHA | learning, review `target/commit`, fix `commit`, merge-evidence `commit`, tour `commit`, `pr-url.commit`, `sentinel-merge.{tip,head,merge_commit}` | full 40-hex SHAs; bound to the worktree branch, which outlives the package |
| finding `signature` | review `findings[]`, fix `decisions[]`, `dismissals[]`, history-index | anti-thrash identity across rounds |
| run id / assignment id / receipt id | `runtime/**`, learning `verification.commands[].receipt`, `events.jsonl` | UUIDs; assignment id = step path by default |
| `workflow_id` | checkpoint, `run.json`, `sentinel/<wf>/` | equals slug except repo-search-index |
| epic member | `.specs/_epics/<epic>/epic.json` | linked, other audit; spec-end-to-end only reads it (`SKILL.md` Resolve The Run step 4) |
| design screen | `Design reference:` line, `spec-steps.json step.design{path, sha256}` | other audit; none present yet |
| Pi session | `parent_session`, `owner_session`, `editor_session`; `~/.pi/agent/spec-runtime/<run>.json` | outside the repo |

### 34. Change frequency and ownership summary (evidence)

- **Skill/definition churn** (git log paths, first -> last): spec-run 45 commits (Jun 11 -> Oct 10), spec-step-run 38, spec-write 34 (-> Oct 11), spec-branch-review 29 (-> Oct 11), spec-end-to-end 30 (-> Oct 11), spec-subspec-write 28, spec-work-tour 26, spec-pr 24 (-> Oct 11), spec-branch-fix 21, spec-branch-refine 19, spec-architect-initial 16, spec-final-review 1 (Oct 10), spec-message 1 (Sep 28), spec-upgrade 4. Runtime: `pi/extensions/spec-runtime` 38 commits Oct 6-11; `scripts/spec-observe` 53 commits Oct 6-11. Schema-defining files: `spec-write/SKILL.md` v27, `spec-step-run` v35, `spec-run` v37, `spec-pr` v19, `spec-branch-review` v26, `spec-end-to-end` v25. Two format transitions in the last 6 weeks: evidence-plan v2 + context.md (Sep 26) and removal of preparation hashes/`preparation.json` (Oct 5).
- **Package churn**: package lifetimes are 4-12 h of intense mutation then static (adj1: proposal Oct 10 10:06 -> PR receipt 14:09; adj5: Oct 10 -> Oct 11 06:06). After merge only `sentinel-merge.json` (revalidated) and occasionally `history-index.json`/`merge-evidence.*` change.
- **Writers by role**: operator (requirements, project-context edits, dashboard completion, inbox via CLI); architect/critic/planner agents (proposal, critique, spec stack, context); Pi extension (runtime/, learnings, history-index, stages); reviewer agents (reviews); fixer agents (fix records, evidence); run coordinator (merge-evidence, checkpoints, stages); publication agent (tour, pr-*); Sentinel (sentinel-merge, checkpoint projections).

### 35. Retention and cleanup (consolidated)

Nothing in the repo deletes, archives, compresses, or garbage-collects a package or any of its parts. Disk cleanup is manual (`docs/disk-hygiene.md` covers TMPDIR/worktrees/Docker, not `.specs`). Merged-and-done worktrees (`~/.agents-adj1…super3`, 12 siblings) remain registered. Growth is dominated by `runtime/runs/*-editor-*.jsonl` and `*-owner-*.jsonl` (2.3 GB for 11 packages, 20-540 MB each; adj5 alone 539 MB). Total `.specs/` is 2.3 GB with no backup (gitignored, not shipped).

### 36. Top observations (ranked)

1. **`merge-evidence.json` has three live shapes and no validator**, though it is the pivot between execution and tour/PR (see 25). Same pattern, milder, for `pr-url.json` (6 shapes) and `reviews/final-review.md` (prose vs YAML).
2. **Runtime transcripts are 95% of storage and have no retention policy**; derived artifacts reference `runtime/runs/*.md` by absolute path, so selective pruning needs a defined keep-set (completion.json, verification.json/.md, events, run records; drop editor/owner JSONL, command logs after N days).
3. **`.specs/` is the system of record and is neither tracked nor backed up**; only PR bodies and a few committed docs survive loss. `.planning-backups`/`.upgrade-backups` are the only history of superseded plans.
4. **State-bearing "immutable" files go stale**: `spec-prepare.md` (outcome `decision-required`), subspec `planning.verdict: blocked` (adj1, adj3), `context.md` quoting superseded project policy, `spec.md` edited after publication (adj1). Nothing reconciles them, and epic status uses file existence (`spec-steps.json`) as "prepared".
5. **Backup dirs and package enumeration disagree**: skills put backups under `.`-prefixed names, sentinel excludes only `_`-prefixed names (see 1).
6. **Unused/unreferenced machinery**: inbox (0 messages in 11 runs), dismissal classes (0 dismissals in 169 decisions), `## Adaptations`, `blockers.md`, `visual-references/`, `spec-steps.json.design`, front-matter `critique_recommended` (no parser), `sentinel-completion.json`; plus two unreferenced loose ledgers in `.specs/`.
7. **Naming/typing inconsistency** for the same concept: `step` int vs `"001"`; `observedCommit` vs `observed_commit`; `submittedAt` vs `submitted_at`; epoch-ms vs ISO timestamps (`activity/*.json`); `version` vs `schema_version` (JSON files with neither: `spec-steps.json`, `history-index.json` has `version`, `merge-evidence` mixed).
8. **Docs drift**: `README.md:96-107` and `docs/spec-workflow.md` list ~9 artifact kinds; the true set (this document) is ~35, and the skill-local definitions are scattered across 12 SKILL.md files with `executable-evidence.md:396-418` as the only consolidated tree (which also omits `runtime/`, `inbox/`, `pr-*`, `sentinel-*`, `upgrade.md`, `criteria`-adjacent files other than `criteria.md/invariants.md`).


---

## Epics, plans, and designs

Audit date 2026-10-11, repo `/Users/ryanmahoney/.agents`, branch `design-packages` (HEAD `dcc2c0c`, equal to `origin/design-packages`, one commit ahead of `main`). Read-only. Paths below are relative to the repo root unless absolute.

### Overview

Three families of records sit around the spec-package workflow:

1. **Epic records** group existing spec packages (`.specs/<pkg>/`) and say what they depend on. Status is never stored. It is derived from package files at read time by the Sentinel.
2. **Plans** are free-form Markdown rationale documents that an epic points at. No code parses them.
3. **Design packages** are one-HTML-per-screen-state folders plus a `design.json` index, kept in workspace storage (outside every repo). They were added in the last commit (`dcc2c0c`, 2026-10-11) and have no real instances yet.

Related prototype tooling: `.specs/prototype-component-library/` (a proposal that was never built), `rules/prototype-design.md`, `skills/uishot` and `.uishot/` captures.

Everything under `.specs/` is git-ignored (`.gitignore` lists `.specs/`; `git ls-files .specs` returns 0 files). So epics, plans and the component-library proposal are local-only, and the only copy is the primary checkout on this Mac. Design packages live in `~/Documents/adjacent-storage`, which is also outside git (backed up by hand, see the adj closeout).

| Structure | Path | Format | Writer | Reader | Change frequency |
| --- | --- | --- | --- | --- | --- |
| Epic record | `.specs/_epics/<slug>/epic.json` (2 exist: `adj`, `super`) | JSON, `schema_version: 1` | spec-architect-initial (planning), epic-end-to-end (state/notes), operator | `scripts/spec-observe/epics.mjs` (Sentinel snapshot, dashboard Epics view, `sentinel status`), epic-end-to-end, spec-end-to-end intake | Created once per plan. `state` and notes change a few times over days. Both files dated 2026-10-10/11. |
| Epic run log | `.specs/_epics/<slug>/run.md` | Markdown, free form | epic-end-to-end | the same skill on resume | Documented, but none exists (see Observations). |
| Epic plan copy | `.specs/_epics/<slug>/plan.md` | Markdown | spec-architect-initial | humans, epic-end-to-end | Documented as "recommended". None exists. |
| Epic closeout checklist | `.specs/_epics/adj/closeout.md` | Markdown checklist | operator and agent, by hand | operator | One file, edited once or twice (mtime 2026-10-11 12:10). Not in any schema or doc. |
| Project plan | `.specs/_plans/*.md` (2 exist) | Markdown | spec-architect-initial or an agent in a planning session, then operator edits | humans; epic `plan` field resolves the path; spec-architect and spec-write read it as intake | Rewritten while the project is live, then frozen. `adjacent-functionality-plan.md` 2026-10-10; `design-studio-plan.md` 2026-10-11. |
| Design index | `<storage>/projects/<ws>/designs/<slug>/design.json` | JSON, `schema_version: 1` | design-plan (create), design-run (notes/deviations) | `scripts/design/{schema,cli}.mjs`, `scripts/spec-observe/designs.mjs`, dashboard | Created once per design. Edited per screen run. No instance on disk yet. |
| Design brief | `.../designs/<slug>/brief.md` | Markdown, fixed headings | design-plan | design-run, humans | Written once. |
| Screen file | `.../designs/<slug>/screens/NN-<id>.html` | HTML, offline, under 200 KiB | design-run | dashboard iframe, implementers, `design ref` | Rewritten with `--step N` or `--from N`. |
| Capture | `.../designs/<slug>/captures/NN-<id>@<width>.png` | PNG | design-run via uishot | design-run inspection, `screenStatus` | One per screen per declared width. |
| Lens review | `.../designs/<slug>/review.md` | Markdown table | design-run | humans | Written once after the last screen. |
| Vendored Tailwind | `.../designs/<slug>/vendor/tailwind.js` plus cache `~/.cache/agent-design/tailwind-3.4.17.js` | JS, digest pinned | `scripts/design/cli.mjs vendor` | screens, dashboard CSP `'self'` | Written once per design. The cache directory does not exist yet. |
| Design reference line | inside `spec.md`, `spec-steps.json` `design` object, `epic.json` `designs[]` | text line / JSON | spec-write, spec-architect-initial | step-run, Sentinel | Per spec preparation. |
| Prototype component library | `.specs/prototype-component-library/` | `context.md`, `proposal.md`, `reference/route-ladders/` | spec-architect | humans | Dormant since 2026-10-09. |
| UI screenshots | `.uishot/*.png` (9 files, 6.4 MB) | PNG | uishot | the viewing model | Ad hoc. Newest 2026-10-10. |

---

### 1. Epic record (`epic.json`)

**Location / naming.** `<primary checkout>/.specs/_epics/<slug>/epic.json`. The slug matches `^[a-z][a-z0-9-]{0,31}$` and must equal the directory name (`scripts/spec-observe/epics.mjs:14,22-24`). The record lives only in the primary checkout, never in a linked worktree (`docs/spec-epics.md:20-23`). Not git-tracked (`.specs/` is ignored). Two instances: `.specs/_epics/adj/` (7 members) and `.specs/_epics/super/` (3 members).

**Format and schema.** JSON. The authoritative validator is `parseEpic` in `scripts/spec-observe/epics.mjs:19-65`. Its limits are `EPIC_LIMITS = { epics: 50, members: 100, recordBytes: 65536 }` (`:11`).
- `schema_version` must be `1` (`:23`).
- `epic` is the slug. `title` is required and non-blank.
- `state` is one of `planned | active | complete | abandoned` (`:13`, `:26`).
- `created_at` and `note` are optional strings (`:27`). `created_at` is not parsed as a date.
- `plan` is optional and relative to the epic directory. It is checked lexically so it stays inside `.specs/` (`:28-32`). `adj` uses `../../_plans/adjacent-functionality-plan.md`.
- `designs[]` is optional, at most 20 entries of `{workspace, design(slug), path?(absolute)}` (`:33-43`). It was added in `dcc2c0c`.
- `packages[]` is required, at most 100. Each entry has `package` (a bare directory name, unique), optional `repository` (absolute path), optional `requires[]` (names of other members, no self-reference, no unknown names), and optional `note` (`:44-62`).
- Unknown extra keys are dropped silently by the allowlist (the test uses `extra: 1`, `epics.test.mjs:10`).
- Derived member statuses (never stored): `missing | unobserved | proposed | prepared | in-progress | published | merged | complete | unknown` (`deriveMemberStatus`, `epics.mjs:~130-138`; table at `docs/spec-epics.md:105-118`).

**Purpose.** Records what package receipts cannot say: which packages belong together, their intended order, their `requires` edges, and which plan and designs they serve.

**Lifecycle and change frequency.** Both records were created on 2026-10-10 and touched on 2026-10-11 (`adj/epic.json` mtime 10-11 12:10, `super/epic.json` 10-11 10:29). The epic feature itself is only three commits old (`797943f` skill, `1271074` sentinel derivation, `dcc2c0c` designs field, all 2026-10-11). `state` changes once at start (`active`) and once at the end (`complete`). Membership is edited by hand. `adj` has stayed `active` since creation. Its `note` says it completes only after the closeout gates are recorded on the host machine and D-7.3 is decided.

**Writers.**
- spec-architect-initial writes it when one plan is decomposed into two or more packages (`skills/spec-architect-initial/SKILL.md:380`).
- epic-end-to-end sets `state` to `active` on first dispatch and `complete` at the end. It may edit member `note` fields with user direction. It writes a record first when given `PACKAGES` and no record (`skills/epic-end-to-end/SKILL.md`, "One epic record").
- The operator edits `state`, `note` and member notes by hand.
- spec-end-to-end and the Sentinel never write it.

**Readers.**
- Sentinel `readEpicRecords` and `collectEpics` (`epics.mjs`, called from `scripts/spec-observe/sentinel.mjs:20,598`).
- It surfaces as `snapshot.epics[]` and `run.epic`. The dashboard Epics view uses it, and the CLI renders it at `sentinel.mjs:447`.
- spec-end-to-end intake scans `_epics/*/epic.json` for the package name (`skills/spec-end-to-end/SKILL.md:191`).
- epic-end-to-end reads membership and order from it.

**Relationships.**
- `packages[].package` points at the directory `.specs/<package>/` (or `<repository>/.specs/<package>/`). Receipts, `pr-url.json` and `sentinel-merge.json` store absolute package paths, so packages are never renamed.
- Status comes from `spec-steps.json`, dispatch receipts, `sentinel-completion.json` and merge data. PR URL and `assignment_id` are copied into the snapshot only.
- `plan` points at a `_plans/*.md` file. `designs[]` points at workspace storage by identity (`workspace/design`) with an absolute `path` as a convenience.
- Sentinel stamps `run.epic = {epic, repository, position, total}` on member package rows.

**Retention / cleanup.** None. Epics are never deleted or archived. Completed epics stay, and `state: complete` plus result files stay in place (closeout, last line). The Sentinel hides nothing by age: epic member status ignores the 7-day completion window and the 24-hour activity filter (`docs/spec-epics.md:131-134`).

**Observations.**
- Docs and instances disagree on the plan location. `docs/spec-epics.md:15-18` and the example at `:44` put the plan at `_epics/<slug>/plan.md`, and spec-architect-initial says to copy or move the plan there. Both real epics instead point at `../../_plans/…` (adj) or have no plan (super). The validator allows both, so this is documentation drift, not a bug.
- `run.md` is specified as written by epic-end-to-end, but neither `adj` nor `super` has one. The `adj` epic was evidently run without the loop (it has `closeout.md` instead), or the loop never wrote it. The `run.md` format is prose only. Nothing validates it or reads it mechanically.
- `closeout.md` is a third sibling file that is not in `docs/spec-epics.md` (Location lists only `epic.json`, `plan.md`, `run.md`). It carries the real operational state of `adj`: pilot gates, the D-7.3 decision, host-move steps. This is the only place that state exists. It is untracked, so it is lost with the machine.
- Naming drift. The docs say members are named `<epic><NN>-<slug>` with two digits (`adj07-…`), but the real packages are `adj1-…` to `adj7-…` and `super1-…` with one digit. The docs also say existing members keep their names, so this is tolerated drift. The `adj7-adjacent-import-pilot` entry stays in `packages[]` with a note "Not undertaken". Its derived status will therefore read `prepared` (it has a `spec-steps.json`) indefinitely and the epic's `next` can point at it. The status model has no "dropped" value. `adj/epic.json` also lists adj7 as a requirement-bearing member, so the epic cannot reach "all landed" in the Sentinel summary even once `state` is set to `complete`.
- `created_at` is documented as an ISO date but accepted as any string. `state` is operator-managed and nothing checks it against member status. No check compares `state` with the derived member statuses.
- `super` has a `note` stating "no shared plan document", so a missing `plan` is a supported shape.
- Unknown keys are silently dropped, so a typo such as `require` instead of `requires` yields no error. The effect is an epic with no dependency ordering.

---

### 2. Epic closeout checklist (`closeout.md`)

**Location / naming.** `.specs/_epics/adj/closeout.md`, 8 KB. Git-ignored. Referenced from `epic.json` `note` and from the adj7 member note. It is the only per-epic file other than `epic.json`.

**Format and schema.** Free Markdown with fixed headings: "Move to the host machine", "Pilot session", "Decide", "Known follow-ups, not blocking", "Then". It has relative links to package specs and `evidence/*.json` result files. No machine-readable fields.

**Purpose.** Replaces the dropped adj7 import package. It lists the remaining pilot gates (adj2 EV-7 and EV-8, adj4 EV-8, adj5 EV-13) and decision D-7.3 (retire the Phoenix app), plus the exact commands. It states the end condition: set `epic.json` `state` to `complete`.

**Lifecycle and change frequency.** Written 2026-10-11 and edited the same day (mtime 12:10). It is current-state prose ("Current state (2026-10-11)") with no history, so it will be edited as gates complete.

**Writers / readers.** Written by an agent with the operator (inferred; no skill owns it). Read by the operator, and by agents resuming the adj work.

**Relationships.** It points at result files in `.specs/adj2…/evidence/*.json`, `adj4…/evidence/remote-attach.json` and `adj5…/evidence/ev-13-result.md`. Those are the real completion evidence. It also names the backup `~/adjacent-storage-backup-2026-10-11` and the Sentinel coordination SQLite files.

**Retention.** The final instruction is to keep the result files in place. There is no archive step.

**Observations.** It duplicates what an `epic.json` could express (state, blocking gates) in prose, so the Sentinel cannot show that `adj` is blocked on a host move. The dashboard shows only package statuses. The checklist holds some of the project's only documentation of the remote-host gates. Several of its recorded results are `pending` records that "a rerun without authority overwrites".

---

### 3. Plans (`.specs/_plans/*.md`)

**Location / naming.** `.specs/_plans/<descriptive-name>.md`. Directory names starting with `_` are skipped by package discovery (`scripts/spec-observe/sentinel.mjs:572`, `docs/spec-epics.md:24`). Git-ignored. Two files:
- `adjacent-functionality-plan.md` (22 KB, mtime 2026-10-10 09:20).
- `design-studio-plan.md` (23 KB, mtime 2026-10-11 12:05).

**Format and schema.** Free Markdown. Neither file has front matter or a schema, and nothing in code parses them. Both open with `# Title` and a `Status:` line.
- The adjacent plan's sections are Objective, Architecture to preserve, Capability scope, Delivery sequence 1-7, Milestones, Verification and rollout, Decisions to keep explicit, Deferred scope, Follow-on specification packages.
- The design-studio plan's sections are Problem, Recommended approach, Established constraints, The index schema, Skills, Sentinel, What to remove / salvage, Designs as the authoritative reference, Decisions to confirm, Suggested order of work.

**Purpose.** A planning document one level above specs. It is the intent and decision record that an epic implements and that architecture and spec stages read. The only code reference is the epic's `plan` field: `epics.mjs` resolves it to an absolute path (`buildEpics`, `plan: resolve(entry.dir, epic.plan)`). The test fixture in `scripts/spec-observe/sentinel.test.mjs:1203-1230` uses `_plans/demo.md`.

**Lifecycle and change frequency.** One file per project. Edited heavily during the planning session and then rarely. The design plan changed within minutes of the implementing commit (mtime 12:05, commit 12:11), and the adjacent plan has not changed since the day it was written.

**Writers.** An agent in a planning session or spec-architect-initial, then the operator. There is no fixed owning skill. `docs/spec-epics.md` ("Who writes the record") does not name `_plans`.

**Readers.** Humans and architecture skills. `epics.mjs` stores only the path.

**Relationships.**
- `adjacent-functionality-plan.md` is referenced by `_epics/adj/epic.json`. It lists seven phases that became adj1-adj7.
- `design-studio-plan.md` has no epic record. It implements the design-packages feature, and that feature's source of truth moved to `docs/design-packages.md`. It names `.specs/prototype-component-library/` as related.

**Retention.** None. Plans are never removed.

**Observations.**
- Stale status line. `design-studio-plan.md:3` says "implemented 2026-10-11 on branch `design-packages` (uncommitted at time of writing)". The work was committed in `dcc2c0c` the same day.
- Unfinished items in that plan. Its "Suggested order of work" step 3 ("one real design against transitops") has not happened, since no `designs/` directory exists in storage. Step 5 (remove old skills) is done, and `skills/` has no `design-spec-*` or `design-align`. The plan's open "Decisions to confirm" list (item 6, epic tracking on branch) was settled by the merge of PR #23.
- The adjacent plan's "Follow-on specification packages" and phase list predate the epic record. It has no `Status:` update to reflect that adj7 was dropped. That fact lives only in `epic.json` and `closeout.md`.
- Plans are invisible to the Sentinel except as a path, so a plan with no epic record is undiscoverable apart from the directory listing.

---

### 4. Design package: index (`design.json`)

**Location / naming.** `<ADJACENT_STORAGE_ROOT>/projects/<workspace>/designs/<slug>/design.json`. The root resolves as `--root`, then `ADJACENT_STORAGE_ROOT`, then `~/Documents/adjacent-storage` (`docs/design-packages.md:26-29`). It is not git-tracked. Current state: workspaces `adjacent`, `firstwho`, `transitops` exist under `projects/` and none has a `designs/` directory (checked). So there are zero real instances. Only the committed unit tests exercise the format.

**Format and schema.** JSON. The authoritative validator is `parseDesign` in `scripts/design/schema.mjs:21-85`. Limits (`:7`): 100 screens, 4 widths, 64 KiB record, 200 KiB per screen, 50 designs per workspace.
- `schema_version: 1`, `design` (slug `^[a-z][a-z0-9-]{0,47}$`, equal to the directory name), `title` (required).
- Optional strings: `brief`, `created_at`, `note`.
- `design_system` is optional: `{path (required), tokens?}`.
- `viewport` is required: `posture` is `desktop-only | responsive` (`:9`). `widths` is 1 to 4 distinct integers from 320 to 3840, with at least 2 for `responsive`.
- `context[]` is an optional list of non-empty path strings.
- `screens[]` is required, 1 to 100, and `step` must run 1..N in array order. Each screen has `id` (slug, unique), `title`, `person`, `job`, `kind` in `decision | action | flow-step`, and `state` in `ideal | empty | loading | error | partial | denied | offline | stale` (`:11`, `:61`).
- Optional per-screen fields: `file` (derived; must equal `screens/NN-<id>.html` if present), `shell_from` (an earlier step), `primary_action`, `notes`.
- `deviations[]` is optional: `{screen, token, from, to, reason}`, all required, with `screen` an existing step.
- Not stored: `produced` and `captured`. `screenStatus` derives them from file presence (`:88-99`).

**Purpose.** An ordered index of screens with the person and job each serves, viewport posture, design-system link and recorded deviations, so a design can be listed, flipped through and resumed. `docs/design-packages.md` states that "Nothing about progress is stored in the index".

**Lifecycle and change frequency.** The feature was created and committed in one commit on 2026-10-11 (`dcc2c0c`, 17+ files). Per design: design-plan writes the index once, then design-run rewrites it atomically as it adds `notes` and `deviations` for each screen. The inventory (`step`, `id`, `person`, `job`, `kind`, `state`) is meant to be immutable during design-run and changes only through design-plan. A design index is expected to change about N+1 times for N screens. No real data exists to confirm.

**Writers.** The design-plan skill (`skills/design-plan/SKILL.md`, Step 5, atomic temp-and-rename) and the design-run skill (Step 1.7). Both are `disable-model-invocation`, so the operator has to invoke them. `scripts/design/cli.mjs` itself never writes `design.json`. The Sentinel never writes it.

**Readers.**
- `scripts/design/cli.mjs` `readDesign`, using `O_NOFOLLOW` and a 64 KiB bound.
- `scripts/spec-observe/designs.mjs` `listWorkspaceDesigns`, behind `/api/workspace-designs` at `scripts/spec-observe/dashboard.mjs:223`. The dashboard Designs section and screen flipper are in `dashboard.html:451-461`.
- design-run, spec-write, humans.

**Relationships.**
- Identity is `workspace/design`: the workspace is the directory two levels above the design (`referenceLine` takes `basename(dirname(dirname(directory)))`).
- The workspace's `kit.yaml` supplies the design system under a supplemental `design_system` key (`repository`, `applies_to`, `paths[]`). `transitops/kit.yaml:25-32` carries it; `adjacent` and `firstwho` do not.
- `epic.json` `designs[]` points at it, and the design never names epics. A `spec-steps.json` entry may carry a `design` object, `{workspace, design, step, path, sha256}`.
- `context[]` names workspace-relative inputs (`context/`, `sources/`).

**Retention / cleanup.** None defined. A design folder stays until someone deletes it. Rerunning design-run only produces missing screens.

**Observations.**
- `design_system` appears in two forms. In `kit.yaml` it is `{repository, applies_to, paths[]}`. In `design.json` it is `{path, tokens}` with absolute paths. design-plan converts one to the other by hand, and nothing checks that they stay in step. `scripts/workspaces/kit.mjs` has no `design_system` handling beyond generic YAML passing it through (the tests parse it as arbitrary nested data), so the key is "supplemental" and unvalidated.
- `created_at` is a free string, as in epics.
- `context[]` is documented as workspace-relative but is only validated as non-empty strings (`schema.mjs:48`).
- The reader checks the directory slug against `design`, but nothing checks that `brief` points at an existing file.
- `designs.mjs` skips symlinked directories silently, and reports per-design errors in an `errors[]` list rather than failing the whole listing.
- Both skills hard-code `node ~/.agents/scripts/design/cli.mjs`, which is a path outside the project, so the tooling must be installed at `~/.agents`.

---

### 5. Design package: screens, captures, brief, review, vendor runtime

**Location / naming.** Under the same `designs/<slug>/`: `screens/NN-<id>.html`, `captures/NN-<id>@<width>.png`, `brief.md`, `review.md`, `vendor/tailwind.js`. The names are built by `screenFile` and `captureFile` (`schema.mjs:15-16`) with a two-digit zero-padded step. Not git-tracked.

**Format and schema.**
- A screen is one self-contained HTML file under 200 KiB with `<script src="../vendor/tailwind.js">` and an inline `tailwind.config`. It loads nothing outside the folder, matching the dashboard CSP `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src … ; img-src 'self' data:; font-src 'self'; connect-src 'none'` (`docs/design-packages.md:46-50`).
- `lintScreen` (`schema.mjs:92-110`) emits `fail` findings for: size over cap, Tailwind CDN, any external `src`/`href`/`@import`/`url()`, `<form action>`, `fetch`/`XHR`/beacon/WebSocket. It emits `warn` for: missing styles, 11 self-reference phrases, 16 marketing words, and `data-state|data-variant|data-screen` attributes. A design's lint outcome is `pass | warn | fail`.
- `brief.md` has fixed headings: People and jobs, Surface and posture, Design system, Lenses, Screens table, Assumptions, Context read (design-plan Step 5).
- `review.md` is a table: screen, lens, finding, consequence, change or reason declined.
- The Tailwind runtime is pinned in `cli.mjs` (version 3.4.17, sha256 `176e894…`). It is fetched once into `~/.cache/agent-design/` (override `AGENT_DESIGN_CACHE`) and copied into each design.

**Purpose.** Screens are the visual source of truth that implementers read where they live. Captures are inspection evidence and the basis for the `captured` status. `vendor/` makes the HTML render under the offline CSP.

**Lifecycle and change frequency.** Screens are produced in step order and rebuilt through `--step N` or `--from N`. Captures are re-taken after each correction (two or three rounds per screen is "normal"). All of this is untested on real data. The skill text is the only evidence, plus `scripts/design/cli.test.mjs` (6 tests: parse, reject classes, lint, status derivation, on-disk lint plus ref, vendor cache).

**Writers.** design-run (one model) for screens, captures (through `uishot`), `review.md` and `notes`; design-plan for the brief; `cli.mjs vendor` for the runtime. The skills restrict writes to inside the design folder.

**Readers.** The dashboard serves files through the workspace file reader (8 MiB per file, symlinks refused, excluded names such as `.adjacent`, `sessions`, `threads`). `designs/` is not excluded. Implementers read screens; `cli.mjs ref` hashes them.

**Relationships.** `shell_from` links screens by step. A reference line is `Design reference: <workspace>/<design> step N → <abs path> sha256:<digest>`. The digest binds a spec to the screen as prepared (see section 6).

**Retention / cleanup.** None. Captures and the vendor copy are never pruned. Each design carries its own copy of the Tailwind runtime.

**Observations.**
- `docs/design-packages.md` says design-run uses `uishot` for captures, and the `uishot` launcher writes to cwd-relative `.uishot/` by default. The skill passes `--out <design-dir>/captures/...`, so captures bypass `.uishot/`. If `--out` is omitted, captures go to the git-ignored `.uishot/` and `captured` status stays false.
- The lint is regex-based over raw HTML, so it can be fooled by text inside comments or attributes. It is explicitly advisory ("decides nothing about the design itself").
- "Self-contained" depends on the iframe CSP, which this commit changed (`font-src 'self'` added to the workspace and package file CSP). Viewing from disk works regardless; only the Sentinel path is constrained.
- `cli.mjs lint` requires an absolute or `./` path and rejects bare relative ones (`cli.mjs` main).

---

### 6. Design reference (cross-record link)

**Location / naming.** Three representations of one fact:
1. A text line `Design reference: <workspace>/<design> step N → <abs path> sha256:<digest>` in `spec.md` and repeated in every `Visual: yes` step card. Header form: `Design reference: <workspace>/<design> steps 1–3 (<abs dir>)` (`skills/spec-write/SKILL.md:175,302`).
2. `design: {workspace, design, step, path, sha256}` on `visualDesign: true` entries of `spec-steps.json` (`SKILL.md:432`).
3. `designs[]` on `epic.json` (see section 1).

**Format and schema.** The line is produced by `referenceLine` (`cli.mjs`). The JSON object has five required keys when present. Nothing validates the `design` object on the runtime side: a grep of `pi/` and `scripts/` for `visualDesign` shows it is read only in `pi/agents/spec-step-owner.md`, `skills/spec-step-run`, and `skills/spec-write`, as prompt text.

**Purpose.** Cites a screen by identity with a content hash, so a spec never copies the design into a repo and a later edit to the screen is detectable.

**Lifecycle and change frequency.** Written when a spec is prepared (spec-write) and never updated, which is the point of the digest. Re-preparation is needed after a design changes.

**Writers.** spec-write, spec-architect-initial (epic `designs`), and `cli.mjs ref` (the only generator of the line).

**Readers.** Step owners and implementers (by reading the line), Sentinel (passes `designs[]` through in `snapshot.epics[].designs`).

**Relationships.** Joins three stores: a spec package in `.specs/`, a design in workspace storage, and an epic in `.specs/_epics/`. The identity `workspace/design` survives a storage-root move while the absolute path does not.

**Retention.** The reference is frozen inside the spec package.

**Observations.**
- The documented drift policy is not enforced anywhere. `docs/design-packages.md` says a step owner that finds a different digest "reports a departure needing re-preparation; it never builds to the newer file silently". A search of `skills/spec-step-run/SKILL.md`, `references/visual-verification.md` and `pi/agents/spec-step-owner.md` finds no mention of `sha256` or `Design reference`, so this is a promise in the doc and in spec-write text only. It depends on the step owner reading the line and recomputing the hash by hand.
- `design-studio-plan.md` ("Sentinel" subsection) planned derived coverage: per-screen claiming member, unclaimed screens, "hash differs" flags. The commit ships only the design lister and flipper, and passes `epic.designs` through. Coverage and hash-drift projection are not implemented, and the doc's "the back-reference is derived" has no code behind it yet.
- Absolute paths are baked into specs and `epic.json`, which breaks on a storage-root or username move. The adj closeout already warns about the same constraint for assignment records.

---

### 7. Prototype component library proposal (`.specs/prototype-component-library/`)

**Location / naming.** `.specs/prototype-component-library/` containing `context.md` (12.7 KB), `proposal.md` (36.7 KB, front matter `verdict: COMPATIBLE_WITH_CAVEATS`, `critique_recommended: true`) and `reference/route-ladders/` (README, `manifest.json`, prototype, records, screenshots, implementation). It is a standard architecture-stage spec package with no `spec.md` and no `spec-steps.json`. Git-ignored. Dated 2026-10-09 20:19-20:24.

**Format and schema.** Markdown plus a copied example with a `manifest.json` for provenance. The proposal says "the proposed commands, files, and schemas do not exist yet".

**Purpose.** A plan for a tool that decomposes large interactive prototypes into verified state references and named components in a library at `~/.local/share/agent-design-library`, with deterministic extraction and subagent semantic checks.

**Lifecycle and change frequency.** Static since 2026-10-09. Superseded in practice by design packages: `design-studio-plan.md` says one-screen-per-file "removes most of the pressure that proposal responds to; its component library remains useful later for reuse across designs but is not a prerequisite".

**Writers / readers.** Written by spec-architect. Read only by humans and by the design-studio plan reference.

**Relationships.** It is a standalone package (no epic membership). Its example (`route-ladders`) matches the design-package example slug `ladder-overview` in the transitops workspace.

**Retention.** It is dormant. Because no epic lists it, the Sentinel treats it as an ordinary `proposed` package with no activity.

**Observations.** Its context file references `docs/adjacent-architecture.md` as "pre-existing untracked", but that file is now tracked (and currently modified in the working tree). It contains a large copied prototype, so the ignored `.specs/` folder carries bulky reference material that is not backed up. No decision records that the proposal is deferred or abandoned, and the unbuilt library path is documented as a future option in two places.

---

### 8. UI screenshots (`.uishot/`)

**Location / naming.** `<repo>/.uishot/<slug>-<HHMMSS>.png` (for example `file-users-ryanmahoney-agents-specs-adj3-211041.png`, `sentinel-desktop-final.png`). Git-ignored (`.gitignore:7`). Nine PNGs, 6.4 MB in total, dated 2026-10-07 to 2026-10-10.

**Format and schema.** PNG only. The uishot launcher prints `file:` and `console_errors:` as key-value text on stdout, and that output is not persisted.

**Purpose.** Evidence for the model's visual inspection of UI work (see skill `uishot`, `see`). Captures are the visual evidence, and the unit-testing rule says to add assertions only for behavior that will regress silently.

**Lifecycle and change frequency.** Written whenever a UI is changed. The last captures are from the adj3 and Sentinel dashboard work.

**Writers / readers.** `skills/uishot/scripts/uishot` writes them. The viewing model reads them (`see`). Humans occasionally.

**Relationships.** None recorded. Filenames embed a URL slug and a time but no package or step id, so a capture cannot be tied to a step or spec after the fact.

**Retention.** No automatic cleanup. `docs/disk-hygiene.md` is the general guidance. The folder only grows.

**Observations.** Design runs bypass this folder and write captures into the design package, which is a better home. The 2 MB-per-image repo captures are not referenced by any evidence record.

---

### Cross-cutting observations

1. **Everything here is untracked.** `.specs/` (epics, plans, closeout, component-library proposal) is ignored by git, and designs live outside the repo. Loss of this Mac loses the live state of the `adj` epic. The closeout's own D-2 backup covers `~/Documents/adjacent-storage` only.
2. **Single reader, no writer API.** The only code that reads epic records is the Sentinel (`epics.mjs`). Nothing in code writes `epic.json`. Writers are skills and operators following prose. The only guard is the reader skipping invalid records and reporting `epic-invalid: <file> (<reason>)` as a coverage reason.
3. **Duplicated limits.** The 64 KiB record cap and slug-style regexes appear separately in `epics.mjs` and `schema.mjs`, and `EPIC_SLUG` (32 chars) differs from `DESIGN_SLUG` (48 chars). The design `designs[]` entry regex in `epics.mjs:36` is a third copy of `DESIGN_SLUG`, which means a slug rule change must touch both.
4. **Status is derived, never stored** is applied consistently in both families (`deriveMemberStatus`, `screenStatus`), which keeps the records small and stable. The exception is `epic.state`, which is operator-set, and it is the one field that can drift from the derived facts.
5. **Doc and code drift to fix:** plan location (`plan.md` vs `../../_plans/`), `run.md` and `closeout.md` (documented vs actual), member name format (`adj07` vs `adj7`), no "dropped" member status for adj7, the design-studio plan's "uncommitted" status line, and the unimplemented design-drift and coverage claims.
6. **Branch and working-tree state.** The `design-packages` branch is committed and pushed (local = `origin/design-packages` = `dcc2c0c`), so it is not uncommitted work. `main` is behind by that commit. Working-tree changes (8 modified files: docs/adjacent-architecture.md, dashboard.html and tests, workspaces/discussion*, pi-rpc*) concern discussion threads and are unrelated to this area, apart from `dashboard.html`, which is shared with the Designs viewer. No stashes exist. The other local `spec-*` branches (`+` marks worktrees) belong to the adj and super packages.


---

## Workspace storage: workspaces, kits, threads, assignments

Scope: the "adjacent" storage outside repositories. Code in `/Users/ryanmahoney/.agents/scripts/workspaces/*`, consumers in `scripts/spec-observe/{dashboard,assignments}.mjs` and `pi/extensions/spec-runtime/sentinel-host.mjs`. Contracts in `docs/adjacent-architecture.md` (C-1..C-10) and `.specs/adj1..adj7`. Real store inspected read-only on 2026-10-11. Paths are relative to `/Users/ryanmahoney/.agents` unless absolute. All line numbers refer to the working tree as of the audit.

### 0. Overview

**Where it lives.** One storage root, resolved by `resolveStorageRoot` (`scripts/workspaces/store.mjs:251-260`): `--root` flag (CLI only), else `ADJACENT_STORAGE_ROOT` (must be absolute, else throws), else `~/Documents/adjacent-storage`. `ADJACENT_STORAGE_ROOT` is not set in this shell, so the live root is `/Users/ryanmahoney/Documents/adjacent-storage` (about 2.2 GB on disk per `du`: transitops 1.8 GB / 18,442 files, firstwho 49 MB / 386 files, adjacent 484 KB / 9 files). The Sentinel host (`sentinel-host.mjs:128,135`) and dashboard (`dashboard.mjs:128`) resolve the same way; a launchd-installed host must put the variable in its plist (`scripts/spec-observe/README.md:274-276`). The root is a Phoenix "Adjacent" app's former data directory reused in place (C-2/C-3), so it mixes Phoenix-era data with new-system data. A byte-for-byte backup exists at `/Users/ryanmahoney/adjacent-storage-backup-2026-10-11` (18,840 files, excludes `.adjacent/asr-cache`); `diff -rq` shows the live root differs from it only by `projects/transitops/{threads,sessions}` (the first new-system thread), i.e. nothing else has been written since the backup.

**Layout.**

```
<root>/
  .adjacent/                       Phoenix-only: state.sqlite3 (+ -wal/-shm), asr-cache/ (Whisper). Never read/written by new code (C-3).
  .sentinel/                       NEW, created only on first assignment launch (assignments.mjs:619-624). Absent in real store.
      coordination.sqlite          owner_claims table; key "adjacent-launch" (root launch lease)
      adjacent.sock                dedicated tmux server socket
  projects/<workspace-id>/
      kit.yaml                     manifest v1 (the only required file)
      kit.yaml.prev-<UTC>-<UUID>   backup per kit edit            (new system)
      kit.yaml.lock                transient apply lock           (new system)
      context/ sources/ migration/ Phoenix-era or migration material (keep meaning, C-2)
      .specs/                      workspace-local spec packages (only `adjacent` has one: ci/)
      .adjacent/                   Phoenix-era per-project threads/sessions/subagents (not read)
      briefs/*.md  notes/*.md      new material
      artifacts/<uuid>.json        artifact references
      threads/<thread-uuid>.json   ThreadV1 discussion records
      sessions/<thread-or-assignment-uuid>/<ts>_<uuid>.jsonl   Pi session files
      assignments/<uuid>.json + <uuid>.brief.md                assignment record + brief snapshot
      designs/<slug>/              design packages (docs/design-packages.md; out of scope here, separate audit)
```

**Summary table.**

| Structure | Path | Format | Writer | Reader | Change frequency |
|---|---|---|---|---|---|
| Storage root + `projects/` | `<root>/projects` | dirs | `cli setup` (`setupStorage`, store.mjs:1178) | everything | once (Oct 6 16:50) |
| Workspace kit manifest | `projects/<id>/kit.yaml` | YAML subset v1 | `cli create`, `add-repo`, `set-role`; Phoenix before | store/kit, dashboard, discussion, assignments, design skills | rare: 3 files, last edit Oct 6 13:43 |
| Kit backups / lock | `kit.yaml.prev-*`, `kit.yaml.lock` | raw bytes / empty | `applyKitEdit` | operator (manual recovery) | per kit edit; none exist now |
| Context entries | `kit.yaml` `context:` -> `context/`, `sources/...` | relative path strings | operator / Phoenix-era migration | `fetchWorkspace`, dashboard file viewer | static since Oct 6 |
| Migration manifests | `projects/<id>/migration/*.json` | JSON (ad hoc, un-versioned) | one-off external Python/Elixir-era scripts | humans, adj7 importer (spec only) | 3 files, Oct 5-6, frozen |
| Briefs / notes | `briefs/`, `notes/` `*.md` | Markdown | `cli add-brief/add-note`, discussion `saveBrief` | `fetchWorkspace` (names only), assignments (reads bytes), dashboard viewer | none yet in real store |
| Artifact references | `artifacts/<uuid>.json` | JSON `schema_version:1` | `cli add-artifact` | `fetchWorkspace` | none yet in real store |
| Thread record (ThreadV1) | `threads/<uuid>.json` | JSON `schema_version:1`, 0600 | Sentinel host discussion service (via dashboard routes) | discussion service, routes (local-only) | live: 1 thread, mutated every send/delivery/exit |
| Thread Pi session | `sessions/<thread-uuid>/*.jsonl` | Pi session v3 JSONL | Pi RPC child (`pi --mode rpc`) | Pi, `readSessionBranch` (history), discussion | live (1 file, 11 lines, 37 KB) |
| Assignment record | `assignments/<uuid>.json` | JSON `schema_version:1` | `launchAssignment`, `locateAssignment` (CLI, discussion handoff) | CLI `locate/assignments/attach/takeover`, sentinel `collectAssignments`, reconcile | none yet in real store; code 2 days old |
| Brief snapshot | `assignments/<uuid>.brief.md` | Markdown copy | `publishLaunchReservation` | Pi (`@file` arg), humans | per launch |
| Assignment Pi session | `sessions/<assignment-uuid>/*.jsonl` | Pi session JSONL | interactive Pi in tmux | reconcile (`discoverPiSession`), sentinel | per launch |
| Root launch lease | `<root>/.sentinel/coordination.sqlite` | SQLite `owner_claims` | `acquireRootClaim` via `claimOwner` | same | per launch/locate (absent today) |
| tmux server/session | `<root>/.sentinel/adjacent.sock`, session `adj-<12hex>` | tmux | `startSession` | `probeSession`, `attach` | per launch |
| Phoenix SQLite state | `<root>/.adjacent/state.sqlite3` | SQLite (6 tables) | none now (Phoenix app retired) | adj7 importer (not written) | frozen Oct 7/8 |
| Phoenix per-project data | `projects/*/.adjacent/{threads,sessions,subagents}` | JSON/JSONL | none now | none (adj7 would read) | frozen Oct 5-8 |
| Host coordination DB (adjacent but not in root) | `~/.pi/agent/spec-sentinel/coordination.sqlite` | SQLite `owner_claims` | sentinel host | host | refreshed at each host start (Oct 11 12:50) |

**Identity mapping (assignment, Pi session, tmux, workspace, execution dir, workflow).**

```
assignment_id (UUID, caller or random)  -- one value reused as:
   file name            projects/<ws>/assignments/<id>.json  (+ <id>.brief.md)
   Pi session id        pi --session-id <id>               (assignments.mjs ~line 523)
   Pi session dir       projects/<ws>/sessions/<id>/        (pi_session_dir; pi_session_file discovered later)
   tmux session         adj-<first 12 hex of id>            (derived, SESSION_NAME_PATTERN assignments.mjs:64)
   tmux user option     @adjacent_assignment_id = <full id>; env ADJACENT_ASSIGNMENT_ID=<id>  (tmux.mjs:291-295)
   tmux socket          <root>/.sentinel/adjacent.sock      (one server per root)
   tmux pane            pane_id "%N" saved after spawn; pi_identity {pid, started_at(ps lstart)} of the pane process
   launcher_identity    {pid, started_at} of the CLI/host process that did the launch
workspace_id + workspace_directory + storage_root    stored verbatim in the record, validated against physical catalog on every read
execution_dir        canonical physical dir resolved by resolveTarget(workspace, repository_id|null, specPackage); repository_id nullable
spec_package         absolute path of canonical .specs/<pkg>; workflow_id = free string; Sentinel joins runs on (workflow_id, canonical spec_package)
```

Thread side: `thread_id == session_id` (a UUID), `execution_dir` and `session_dir = projects/<ws>/sessions/<thread_id>` (discussion.mjs:1087-1088). A thread points to assignments one-way via `handoffs[].assignment_id` (discussion.mjs:2582-2589); the assignment record has no back-pointer to the thread, only the brief path.

**Locking and atomicity (summary).** Publication primitives are in `store.mjs:94-160`: write a 0600 temp file `.workspace-publish-<uuid>.tmp` in the target directory, `fsync` it, then either `link()` it into place (exclusive create, refuses `EEXIST`) or `rename()` over it (atomic replace). No directory fsync, so no power-loss durability (store.mjs:6-9). Rewriting a record is serialized only by the caller: threads by an in-process per-thread promise chain (`withThreadLock`, discussion.mjs:819), assignments by a cross-process SQLite owner claim (`acquireRootClaim`, assignments.mjs:680), kit edits by an `O_EXCL` `kit.yaml.lock` file. There is no shared lock between those three domains.

**Biggest findings (detail in Observations below).**
1. The root also holds Phoenix `.adjacent/` data and migration manifests that the new code explicitly ignores; the adj7 importer that would reconcile them is spec-only (no code, no PR). The three Phoenix threads remain un-imported, and the only new-system thread was created from scratch.
2. Two different thread schemas coexist conceptually: C-8's short field list vs the real ThreadV1 (about 20 fields). The doc is behind the code.
3. C-7 describes a separate sha256-indexed execution-dir reservation; the code instead scans all assignment records under the root claim. Fields named in C-7 (`launch error`, `ended-observed time`, `pi pid/start`) have different names or live in `attention[]`.
4. The dashboard's workspace file viewer excludes `threads`, `sessions`, `.adjacent` but not `assignments` (which holds `instructions` and brief snapshots) or `migration` (3-4 MB path inventories).
5. Uncommitted working-tree edits (8 files) are removing thread-context injection (`--append-system-prompt`, `context` argument). Real thread record still carries a legacy `context: []` key.

---

### 1. Storage root and root-level coordination

**Location / naming.** `<root>` = `/Users/ryanmahoney/Documents/adjacent-storage` (see overview). `projects/` is the only directory code requires. `.sentinel/` is derived: `coordinationPaths(physicalRoot)` returns `{sentinel, database: .sentinel/coordination.sqlite, socket: .sentinel/adjacent.sock}` (assignments.mjs:619-625). The `.sentinel` directory is created mode 0700 non-recursively on first launch (assignments.mjs:630-660).

**Format & schema.** `storageStatus(root)` returns `{root, status, errors}` with status in `ok | missing_root | missing_projects | invalid_root | invalid_projects | unreadable` (store.mjs:269-355; README table says `invalid_*`). Never creates anything. `setupStorage` (store.mjs:1178) creates root and `projects/` one component at a time, refusing symlinks and wrong types. Catalog scans are bounded by `CATALOG_READ_HARD_LIMITS` = 400 entries, 100 rows, 64 KiB per file, 4 MiB total (store.mjs:359-364), enforced through a shared `budget` object that records `omissions: "none"|"unknown"` and `reasons[]`.

**Purpose.** Neutral anchor; guarantees startup/status never create state (C-3).

**Lifecycle & frequency.** Root and `projects/` created Oct 6 16:50 (mtime), unchanged. `.sentinel/` does not exist, which is direct evidence that no assignment has ever been launched against the real store (adj4 landed Oct 10-11; backup says "No workspace-store write or import has been performed" in docs "Unverified assumptions").

**Writers.** `cli.mjs setup` only (explicit). **Readers.** CLI `status/list/show`, dashboard `/api/workspaces`, sentinel `collectAssignments` (`storageStatus` gate), discussion service.

**Relationships.** Everything under it; `.sentinel/` shared with the launch lease and tmux socket (one tmux server per root).

**Retention / privacy.** Nothing is ever deleted by code (C-3). Root contains personal project content (sources/ copies of untracked files from repos, `tmp/` logs with environment details). Root permissions are default 0755 for dirs.

**Observations.**
- C-6 lists a *second* coordination DB in the agent dir (`~/.pi/agent/spec-sentinel/coordination.sqlite`, key `sentinel-host`, exists, pid 77259 at audit time). Two `owner_claims` DBs with identical schema (`owner-claim.mjs:16-21`) but different keys and locations; only the doc distinguishes them.
- `status` is described in the README as `invalid_*`; code has two distinct statuses. Minor drift.
- Root default is duplicated in four places (store.mjs:254, discussion.mjs:440 via `resolveStorageRoot`, dashboard.mjs:128, sentinel-host.mjs:128) but all go through `resolveStorageRoot`; no divergence found. `docs/design-packages.md:16,26` restates the rule in prose.

---

### 2. Workspace (project directory) and kit manifest

**Location / naming.** `<root>/projects/<workspace-id>/kit.yaml`. Real workspaces: `adjacent`, `firstwho`, `transitops` (all directory name == kit id). Id regex `^[a-z0-9][a-z0-9-]*$` (kit.mjs:41; store.mjs:1154; discussion.mjs:32). Directory/id mismatch yields attention `directory_mismatch` instead of rename (store.mjs readWorkspaceEntry end; C-4).

**Format & schema.** YAML *subset* parsed by a hand-written bounded parser (`parseKit`, kit.mjs:584; supported subset in header comment kit.mjs:1-60, max depth 64). `validateKit` (kit.mjs:664-740) normalizes to:

```
version: 1                      (required; only 1 accepted)
id: string                      (required, id regex)
name: string                    (required, non-empty)
repositories: [ {id (unique in kit), path (string), remote? (string), role? (string)} ]   (required; [] valid)
context: [ string ... ]         (optional list of workspace-relative paths; mappings with `path:` also tolerated by contextPath, store.mjs:814)
```

Unknown top-level keys are ignored by the validator but retained byte-for-byte by edits (transitops has a supplemental `design_system:` block with a comment "the current catalog ignores unknown keys"; `docs/design-packages.md` now relies on it as a de-facto schema extension). Real examples: `adjacent` 1 repo (`main`), `firstwho` 6 repos + 3 context entries, `transitops` 4 repos + 10 context entries + `design_system`. Repo `path` values are absolute (`/Users/ryanmahoney/Documents/<repo>`), relative paths are tolerated on read (resolved against the workspace dir, store.mjs:745-760) but `add-repo` refuses non-absolute paths (README).

**Resolved (computed, not stored) views.** `fetchWorkspace` (store.mjs:1098-1150) returns `{id, name, directory, kit, repositories[], context[], briefs[], notes[], artifacts[], has_workspace_specs, attention[]}`. Repository record `status` in `ok | missing | not_git | unreadable` plus attention `remote_mismatch | unreadable` (store.mjs:745-812); uses `resolveCheckout` and a 5 s git timeout. Context record status `ok | missing | outside_root | unreadable` (store.mjs:875-911), symlinks refused.

**Purpose.** A workspace is the home of research, notes, briefs, threads, and assignments that span repositories; the kit declares the repos and shared context (C-2). One workspace to one kit.

**Lifecycle & frequency.** Created once per project; edited rarely. mtimes: `adjacent/kit.yaml` Oct 5 02:59 (Phoenix), `firstwho/kit.yaml` Oct 5 19:14, `transitops/kit.yaml` Oct 6 13:43. No new-system edit has been applied: there are no `kit.yaml.prev-*` files. Code history: 15 commits on Oct 10 (`95e9b50` parser through `c3f40a2`); store logic is stable since.

**Writers.** Operator via CLI only: `create ID [--name]` (`createWorkspace`, store.mjs:1212: mkdir then exclusive kit publish), `add-repo`/`set-role` (preview by default, `--apply` runs `applyKitEdit`, store.mjs:1550-1649). No dashboard writer. No agent writer. Phoenix wrote the three existing kits.

**Readers.** CLI `list/show`; dashboard `/api/workspaces`, `/api/workspace`, `/api/workspace-files`, `/api/workspace-file`, `/api/workspace-designs` (dashboard.mjs:209-232, re-authorizes the id against a fresh catalog each request); discussion `fetchWorkspace` for each create/launch; assignments `resolveTarget`; design skills.

**Relationships.** Parent of every workspace-owned structure below. `repositories[].id` is referenced by thread `target.repository_id`, assignment `repository_id`, and artifact `target.repository_id`. `context[]` entries point into `context/` and `sources/`.

**Retention / privacy.** `kit.yaml` contains absolute local paths and (optionally) git remotes. Never deleted; edits keep a `.prev-*` copy that is never garbage-collected.

**Observations.**
- **Kit edit protocol has a leftover-lock failure mode** (store.mjs:1620-1649): `kit.yaml.lock` is created `wx`; if the process dies mid-apply the lock persists and every later apply refuses until a human removes it (documented in README). No staleness detection (unlike the SQLite claim used for assignments).
- Backups accumulate unboundedly (`kit.yaml.prev-<ISO>-<UUID>`, ISO contains `:` characters; acceptable on macOS, unusual on other filesystems).
- Kit edit is serialized only by operator discipline ("keep the exclusion window", README). Thread/assignment code never edits the kit, so there is no cross-writer risk, but the Phoenix app (if run) is another potential writer.
- `docs/design-packages.md` and `transitops/kit.yaml` use `design_system:` as supplemental metadata that `kit.mjs` neither validates nor documents. A typo there is invisible.
- C-5 text says status "is `ok`, `missing`, or `not_git`"; the code adds `unreadable` (store.mjs:745+). Doc is behind.

---

### 3. Kit `context:` entries, `sources/`, `context/`, migration manifests ("context files adjacent to projects")

**Location / naming.** `projects/<id>/context/project.txt` (plain text, 2.4 KB for transitops), `projects/<id>/sources/<repo-dir>/...` (copies of untracked, repo-local files like `.specs/`, `tmp/`, `.pi/`, `priv/static/images`), `projects/<id>/migration/<YYYY-MM-DD>[-name]-untracked.json`.

**Format & schema.**
- Context entries in `kit.yaml` are plain relative path strings; resolved lexically then lstat-by-component to refuse symlinks and `..` (`inspectContainedReference`, store.mjs:827-873).
- Migration manifest (un-versioned JSON, produced by an external one-off script, not in this repo): `started_at, status ("complete"), [source_root], units[] ({repo, relative_path}), files[] ({repo, source, destination, type, size, sha256, mode}), excluded[], completed_units[], finished_at, verification{...}`. Real counts: transitops 2026-10-05: 29 units; 2026-10-06: 7 units / 6,884 files / 3.4 MB; firstwho: 151 units / 379 files / 171 KB. `verification` keys differ per file (e.g. `all_destination_hashes_verified`, `tracked_files_unchanged`, `adjacent_catalog{valid, repository_statuses, resolved_context_paths}`, free-text `jev` note).
- Workspace-local spec packages: `projects/adjacent/.specs/ci/{context.md,proposal.md}` (an ordinary spec package created in Phoenix), detected by `hasWorkspaceSpecs` (store.mjs:1076).

**Purpose.** Phoenix "Adjacent" made agents work with research and untracked repo material outside git. The migration manifests record the one-time move of those files from repo working trees to `sources/`, so repos stay clean. Kit `context:` tells a launcher/agent which of them to read.

**Lifecycle & frequency.** Data-only, frozen: migration manifests Oct 5 19:08, Oct 5 19:14, Oct 6 13:43; `context/project.txt` Oct 6 13:43; `sources/transitops/warbler_ux` last touched Oct 7 18:30. Nothing in new code writes these. New material goes to `briefs/`, `notes/`, `artifacts/`, not `sources/`.

**Writers.** One-off external script (not in repo) + operator hand edits. **Readers.** `fetchWorkspace` (existence/status only, content not read except a readable-test), dashboard file viewer (`listPackageFiles` / `readPackageFile`, excludes `.adjacent, sessions, threads, .git, .env*, node_modules, _build, deps`: dashboard.mjs:118), design skills (`designs/` references `context/...` in `design.json`).

**Relationships.** `context[]` -> files under the workspace; `files[].source` -> absolute repo paths outside the store, `destination` -> absolute paths inside it (absolute paths baked into the manifests, so they break if the root moves). The thread record's `context: []` (legacy) and the design index `context[]` are separate lists with the same name.

**Import / adj7 status ("adjacent-import-pilot").** Per `.specs/adj7-adjacent-import-pilot/proposal.md` (verdict COMPATIBLE_WITH_CAVEATS), because adj1 C-2/C-3 reuse the Phoenix tree in place, projects/kits/context/sources/migration need *no* import. What remains is Phoenix's SQLite thread coordination state. Planned design (not implemented): a stdlib CLI reading `.adjacent/state.sqlite3` with `sqlite3 -readonly`, previewing by default, then on `--apply` writing (a) new ThreadV1 records `projects/<project_id>/threads/<thread_id>.json` with `import: {source, digest, imported_at, adjacent:{authority:"none", ...}}`, (b) byte-identical copies of Pi session files under `sessions/<thread_id>/`, (c) a manifest `migration/<UTC date>-adjacent-threads.json`. Rows with `desired_state='active'` import as `history_only:true` (validated by `validateThread`, discussion.mjs:198-206). Item outcomes: `create | unchanged | missing_session | session_ambiguous | missing_execution_root | unknown_repository | missing_workspace | source_changed | diverged | foreign_destination`. **Status: spec only.** `grep` finds no importer, no `adjacent-threads` or `foreign_destination` symbol in `scripts/`, `pi/`, or `docs/`. `.specs/adj7-*` has `spec.md` and 7 step subspecs but no `pr-url.json`, whereas adj1..adj6 each have one. The consumer half exists: `validateImport` (discussion.mjs:153-166) and `history_only` already ship in ThreadV1.

**Retention / privacy.** `sources/` holds raw copies of untracked repo files, including `tmp/` logs, env-sandbox logs, Stripe verification JSON, Fly deploy logs (e.g. `firstwho/sources/shared/tmp/*`). I did not read contents. Treat the whole workspace tree as sensitive; the dashboard viewer can serve any non-excluded file under it (CSP sandboxed).

**Observations.**
- Manifests are the only machine record of what was copied from where; there is no schema/version, so any importer must key on shape.
- Absolute paths in `files[].destination` embed `/Users/ryanmahoney/Documents/adjacent-storage/...`.
- The `migration/` directory is exposed through the dashboard workspace file routes (not in `WORKSPACE_EXCLUDED`), including 3-4 MB path inventories of the operator's repos.
- No new-system structure records provenance for files that *do* come from repos after migration; `artifacts/*.json` is the only reference mechanism and none exist yet.

---

### 4. Briefs and notes

**Location / naming.** `projects/<id>/briefs/*.md`, `projects/<id>/notes/*.md`. Two filename schemes in `addMaterial` (store.mjs:1298-1396): (a) no `request_id`: `<UTC date>-<slug>.md` with `-2..-1000` suffix on collision; content is stored raw. (b) with `request_id` (UUID): `brief-<sha256(workspace NUL kind NUL request_id)>.md` and content `# <title>\n\n<content>\n`; idempotent only if existing bytes are identical, else typed `request-conflict`.

**Format & schema.** Plain Markdown, no front matter or schema. Created 0600 (temp file mode, kept through `link`).

**Purpose.** Immutable inputs for assignments. A brief's path (workspace-relative) is the launch input; `resolveAssignment` reads its bytes once, hashes (`brief_sha256`), and `launchAssignment` snapshots them to `assignments/<id>.brief.md`.

**Lifecycle & frequency.** Append-only; never rewritten by code. None exist in the real store (no `briefs/` or `notes/` directories), so frequency is zero to date; new code is 2 days old.

**Writers.** Operator via `cli add-brief/add-note` (stdin or `--from FILE`); discussion service `saveBrief` (discussion.mjs:2384-2447) for the idempotent kind-`brief` path, invoked from `POST /api/thread/save-brief`. **Readers.** `fetchWorkspace` lists names (dot-files hidden); assignments read bytes; dashboard viewer.

**Relationships.** thread `handoffs[].brief` = this workspace-relative path; assignment `brief` + `brief_sha256` + `brief_snapshot`.

**Retention / privacy.** Never deleted. Brief content comes from model conversation and may be sensitive; file mode 0600, but the dashboard viewer serves `briefs/`.

**Observations.**
- Request-id briefs written with `kind: "note"` also get the `brief-<sha>.md` prefix (the name hard-codes "brief-" at store.mjs ~1337), but only `saveBrief` calls this path, with `kind:"brief"`, so it is latent.
- UUID validators disagree: `isUuid` in discussion.mjs:31 accepts any hex UUID; `REQUEST_ID_PATTERN` (store.mjs:1239) and assignments' `UUID_PATTERN` (assignments.mjs:44) require version 1-5 and variant 8/9/a/b. A syntactically valid but non-RFC UUID passes `saveBrief` validation and then fails in `addMaterial` with `invalid-request-id` (a different code than `invalid-brief`, mapped to HTTP 500/503 rather than 400 in `STATUS_BY_CODE`, discussion-routes.mjs:~55-75).
- Two filename schemes in one directory: dated slugs for CLI, content-hash names for RPC; no index ties a brief to its thread besides `handoffs[]`.
- `create`-time idempotency depends on workspace-id NUL kind NUL request-id hash, so identical `request_id` across threads in one workspace collides to the same file (conflict only if bytes differ).

---

### 5. Artifact references

**Location / naming.** `projects/<id>/artifacts/<artifact_id>.json` (file name == UUID v4).

**Format & schema** (written at store.mjs:1464-1470, read at 913-1052):

```
{ "schema_version": 1, "artifact_id": uuid, "kind": "repository" | "url",
  "target": { "repository_id": str, "path": workspace-repo-relative str }   // kind=repository
          | "<canonical http(s) URL>",                                     // kind=url
  "added_at": ISO8601, "title"?: str, "note"?: str }
```

Derived read-only `status` per record: `ok | missing | outside_root | repository_unavailable | external | unreadable(+reason)`. Records with unknown schema/kind or symlinked record files are reported `unreadable`, never skipped silently.

**Purpose.** Associate a workspace with a file in a repository (by repo id + relative path, retained even if the checkout is missing) or an external URL, without copying content (C-5). URLs are never fetched.

**Lifecycle & frequency.** Append-only, no update path. None exist in the real store.

**Writers.** `cli add-artifact` only (`addArtifact`, store.mjs:1398). **Readers.** `fetchWorkspace`/`show`, dashboard `/api/workspace`.

**Relationships.** `target.repository_id` -> kit repositories. Not referenced by threads or assignments (no `artifact_id` field exists in ThreadV1 or the assignment record), so the architecture doc's "assignment results and artifact references can return to the workspace" is only a convention today.

**Retention / privacy.** Never deleted; no way to remove or supersede a wrong reference except deleting the file by hand.

**Observations.** No "results" structure exists: there is no schema for assignment output being recorded back as artifacts (doc "Handoff and supervision" implies one). Notes (`notes/`) have no writer other than the CLI.

---

### 6. Thread record (ThreadV1)

**Location / naming.** `projects/<ws>/threads/<thread_id>.json`, mode 0600 (verified on the real file), `<thread_id>` = UUID v4 from `randomUUID` (discussion.mjs:1081). Real store: one record, `projects/transitops/threads/2afa199b-665e-4fbc-a167-bb530eadc292.json` (896 bytes). The directory `threads/` is created 0755.

**Format & schema.** Single-line JSON + `\n`. Validator `validateThread` (discussion.mjs:177-225) is lexical; unknown keys are preserved (lines 168-176), malformed required fields throw `invalid-thread` and are never repaired:

```
schema_version: 1
thread_id: uuid, session_id: uuid (always == thread_id on creation)
workspace_id: id regex
title: 1..200 chars
target: { kind: "workspace" | "repository" | "worktree", repository_id? (kind=repository), path? (kind=worktree, canonical absolute) }
execution_dir: canonical absolute (resolved physical dir)
session_dir: canonical absolute, must equal <workspace>/sessions/<thread_id> (assertOwnedSessionPaths, discussion.mjs:246)
session_file: null | canonical absolute path directly inside session_dir
history_only: bool            // true => queue_paused must be true, queue empty, no process
queue: [ { id uuid, text, queued_at ISO, state: queued|delivering|uncertain, attempt: int>=0 } ]
queue_paused: bool
accepted_message_ids: [uuid] (max 100)    // dedupe window for sends
handoffs: [ { request_id uuid, brief: ws-relative path, saved_at ISO, assignment_id? } ]
attention: null | string                  // observed values: live-owner, start-failed, uncertain, missing-directory, stalled, session-mismatch, plus spec-resolution attention
created_at, updated_at: ISO UTC (strict round-trip check)
model?: { provider, model, thinking? in off|minimal|low|medium|high|xhigh|max }
process?: { pid, started_at }             // owned Pi child identity, validated, absent when history_only
import?: { source, digest, imported_at, adjacent:{authority:"none",...} }   // reserved for adj7
```

The real record additionally has a legacy `"context": []` key (preserved as an unknown key; no code now writes or reads it).

**Purpose.** Durable state of one discussion conversation: where it runs, its Pi session, the pending-prompt queue (message text lives only here and in the session file), dedupe ids, the saved briefs/handoffs, and the owned child process identity.

**Lifecycle & frequency.** Created on `POST /api/thread/create` (`create`, discussion.mjs:1050-1123: `mkdir sessions/<id>` then exclusive-create the JSON, returning `thread-exists` on EEXIST). Rewritten on every state change via `persistRecord` (discussion.mjs:834): send/enqueue, delivering/delivered, discard, stop, resume, child start/exit, idle expiry, stall, saveBrief, handoff link. Evidence: real record shows two `accepted_message_ids`, created 16:39:30Z, `updated_at` 16:51:37Z, file mtime 13:01 local (17:01Z). Mtime > `updated_at` shows rewrites that do not bump `updated_at` (see observations). Rate: bounded by user messages (minutes), not by Pi event rate (streamed deltas are SSE-only, never persisted).

**Writers.** Only the Sentinel host's in-process discussion service (`createDiscussionService`, constructed once at `sentinel-host.mjs:135`), reached from the dashboard via `/api/thread/{create,send,stop,resume,discard,save-brief,preview-assignment,launch-assignment}` (discussion-routes.mjs:48-60). Mutations carry the per-server action token. The CLI has no thread commands. The Pi RPC child never writes the thread JSON; it only writes its session JSONL.

**Readers.** The service (list/history/subscribe), `/api/threads`, `/api/thread/history`, SSE `/api/thread/events` (local only, `remote` classification in dashboard.mjs:101-110, `403` text in `STATUS_TEXT`). The generic workspace file viewer excludes `threads` (dashboard.mjs:118, with an explicit comment that queued prompt text is private).

**Relationships.** `workspace_id` -> workspace; `target.repository_id` -> kit repo; `execution_dir` from `resolveTarget` (assignments.mjs:256); `session_dir/session_file` -> Pi session JSONL; `handoffs[].brief` -> briefs/; `handoffs[].assignment_id` -> assignment; `process.pid/started_at` -> OS process; `import.*` -> Phoenix `threads` row. Phoenix `commands` table (queue) is replaced by `queue[]` + Pi's own queue (C-1).

**Retention / privacy.** Never deleted. `accepted_message_ids` capped at 100 (oldest not documented as trimmed; validator rejects >100, so the writer must trim; check `send` path, discussion.mjs ~1830). Records and session files contain the full conversation; thread JSON is 0600 but the sibling `sessions/<id>/*.jsonl` is written by Pi as 0644 (verified `-rw-r--r--`), and `sessions/` and `threads/` directories are 0755. Dashboard excludes both from file listing.

**Observations.**
- **Docs vs code drift (C-8).** C-8 says the record has `thread_id, workspace_id, title, execution_dir, session_file, optional model settings, created_at`. Code requires about 20 fields (see above); no document lists ThreadV1 completely (only `validateThread` does). The uncommitted `docs/adjacent-architecture.md` edit rewrites C-8 to say threads inject no context, matching uncommitted code deletions in `pi-rpc.mjs` (`--append-system-prompt`, `CONTEXT_LIMIT_BYTES`) and `discussion.mjs` (-146 lines). Until those are committed the committed C-8, README and tests describe the old context-injecting behavior, and the real record still has `context: []`.
- **`updated_at` not bumped on owned exit** (discussion.mjs:985-990 persists `{...rest, attention}` without a new `updated_at`), as the real file's mtime/`updated_at` gap shows. Any consumer sorting by `updated_at` will mis-order.
- **In-process locks only** (`threadLocks` Map, discussion.mjs:482-487, 819): correct only while exactly one host process serves the root. C-6 enforces single-host via the SQLite owner claim, but a second process writing the same JSON (e.g. a future CLI or the adj7 importer running while the host is up) would race on `rename`. Writes are atomic so no torn files, but a read-modify-write can lose updates.
- `session_id` and `thread_id` are always equal at creation but stored separately; adj7 import maps Phoenix ids the same way (INV-1).
- Max 4 concurrent owned Pi children (`MAX_OWNED_CHILDREN`, discussion.mjs:489) with eviction of idle ones; a global one-in-flight-response lease. Neither limit is persisted; both are reset at restart, and delivery state is reconstructed from `queue[].state` (`delivering` -> `uncertain` on first access, `recoverRecord` discussion.mjs:858-880).
- Thread IDs and workspace ids are the only join keys; `thread_id` is not stored in the assignment record, so "which thread launched this assignment" is only derivable by scanning `handoffs[]`.

---

### 7. Thread Pi session files and RPC child

**Location / naming.** `projects/<ws>/sessions/<thread_id>/<ISO-ts>_<thread_id>.jsonl` (Pi 1.1.0 naming; real example `2026-10-11T16-51-32-993Z_2afa199b-....jsonl`, 36,925 bytes, 11 lines: 1 `session`, 7 `message`, 1 each `session_info`, `model_change`, `thinking_level_change`).

**Format & schema.** Pi-owned JSONL, header `{"type":"session","version":3,"id":<thread_id>,"timestamp":...,"cwd":<execution_dir>}`. Created lazily by Pi on the first user/assistant message (C-8). `assertHeaderIdentity` (pi-rpc.mjs ~178) requires header `id == session_id` and `cwd == execution_dir` for resume; history is parsed by `readSessionBranch` from `scripts/spec-observe/core.mjs` (LF-only splitter).

**Child process.** `createPiRpc` (pi-rpc.mjs:228) spawns `pi` with `shell:false`, cwd = `execution_dir`, args `--mode rpc --session-dir <dir> --name discussion:<thread_id> --tools read,grep,find,ls --no-extensions --no-mcp --no-skills --no-prompt-templates --no-approve` plus `--session <file>` (resume) or `--session-id <id>` (new) and optional `--provider/--model/--thinking`. Allowed RPC commands are a fixed set (`prompt,get_state,get_messages,get_entries,get_commands,clear_queue,abort`; pi-rpc.mjs:29). Frame cap 1 MiB, startup 10 s, request 30 s, graceful close 4 s then SIGKILL via the owned handle (never a recorded pid). The tool restriction (read-only tools) is not stated in C-8.

**Purpose.** Persist conversation history; the file is the authority for browsing (no live process needed).

**Lifecycle & frequency.** Appended by Pi on each turn; file updated Oct 11 12:51. One per thread.

**Writers.** Pi RPC child. **Readers.** discussion `history`, pi-rpc resume check, `discoverOwnedSessionFile` (discussion.mjs:1017, expects exactly one `*.jsonl` in the dir, else `session-mismatch`).

**Relationships.** `thread.session_file`/`session_dir`; Pi session id == `thread_id`. Assignment sessions share the parent `sessions/` directory (see §9).

**Retention / privacy.** Unbounded, never pruned. Contains full conversation incl. tool outputs from read-only tools over repositories. File mode 0644.

**Observations.**
- `thread.session_file` stays `null` until discovered; the record and the file can disagree transiently (create-on-open hazard documented in the doc).
- Phoenix thread sessions (3 files under `projects/{adjacent,firstwho}/.adjacent/sessions/`) are v3 JSONL too (C-8 compatibility evidence) but are *not* in `sessions/<thread-id>/`; the shape difference (flat dir, two threads sharing one directory) is why adj7 copies rather than moves.

---

### 8. Assignment record and brief snapshot

**Location / naming.** `projects/<ws>/assignments/<assignment_id>.json` and `<assignment_id>.brief.md`. `assignments/` created 0700 on first launch (`ensureOwnedDirectory`). Real store: none (no `assignments/` dir, no `.sentinel/`).

**Format & schema.** Single-line JSON, `schema_version:1`; built by `resolveAssignment` (assignments.mjs:557-594) and validated on every read by `validateAssignmentRecord` (assignments.mjs:752-897), which re-derives paths and refuses any mismatch:

```
Identity:   schema_version, assignment_id (UUID 1-5/variant), workspace_id, workspace_directory, storage_root (physical)
Contract:   brief (ws-relative), brief_sha256, brief_snapshot (== <ws>/assignments/<id>.brief.md), skill ("general" | name), skill_path (null for general),
            instructions, provider/model (both or neither), thinking (needs model), project_trust (always|approve|ask|never|no-approve|null),
            execution_dir (existing, canonical), repository_id|null, spec_package|null (absolute), workflow_id|null,
            publication_authority (none|draft-pr|pr), attempt_kind (initial|launch-retry), supersedes (uuid|null),
            contract_digest = sha256(JSON of 24-field ordered array, assignments.mjs:490-515)
Runtime:    tmux_socket, tmux_session (adj-<12hex>), pi_path, coordination_database, pi_session_dir (== <ws>/sessions/<id>)
Observed:   state (launching|live|launch_unknown|launch_failed|ended), launch_token (uuid), launcher_identity{pid,started_at}, pane_id ("%N"),
            pi_identity{pid,started_at}, pi_session_file (inside pi_session_dir), attention[] (strings), created_at, updated_at
```

The in-memory preview has `state:"preview"`, which is never persisted (`ASSIGNMENT_STATES` excludes it). `IMMUTABLE_RECORD_FIELDS` (assignments.mjs:68-96) define idempotent same-id repeats: same id + same digest + equal immutable fields returns the existing record; same id, different contract is an error.

State machine (`classify`, reconcile.mjs:154+): `launching -> live` only on exact pane id + saved Pi identity; `launching -> launch_unknown` on interrupted/ambiguous; `launch_unknown -> live | launch_failed` (after confirmed gone); `live -> ended` only after confirmed gone (dead launcher, absent terminal, dead/replaced Pi, and UUID absent from a *complete* process listing); `launch_failed`/`ended` terminal. Age over 60 s adds attention only. The default `ps` probe reports `unknown`, never `absent`, so under defaults `ended` can be reached only via a recorded dead Pi identity or an injected complete `psRun`.

**Purpose.** Single durable mapping among assignment, Pi session, tmux session/pane, workspace, execution directory, and workflow identity (C-7), and the reservation that prevents two writers in one directory.

**Lifecycle & frequency.** Created by exclusive `link()` *before* any process starts (`publishLaunchReservation`, assignments.mjs:1304-1377), then rewritten at most: once on launch completion (`live`, pane, identity), on retry (superseded record rewritten with observed state), and on each `locate`/observation that changes state or attention. Rewrites use `writeFileAtomic` under the root claim. Expected cadence: a handful of writes per assignment, then on operator `locate` or when the Sentinel host observes. Real frequency: zero records. Code: 22 commits Oct 10-11 (`032562d` resolve, `d2a99d7` tmux, `60ecbe3` launch, `c5ea3aa` CLI preview launch, `f559140`..`56979f3` supervision).

**Writers.** `cli launch` (preview then `--yes`/`--digest`), discussion handoff `POST /api/thread/launch-assignment` -> `launchAssignmentOwner`, `cli locate` (persists observational fields only: `state, pi_identity, pi_session_file, pane_id (recovered), attention, updated_at`; assignments.mjs:1569). The Pi process itself never writes it. Sentinel only reads.

**Readers.** `cli locate/assignments/attach/takeover/resume`; `scripts/spec-observe/assignments.mjs` (`collectAssignments`, read-only, bounded via `createCatalogReadBudget`, `SENTINEL_LIMITS.assignments = 50`, sentinel.mjs:~24, 690) which projects `classify` output to display states (live, live-unrecorded, launching, launch-unconfirmed, exited-unrecorded, terminal-lost, unknown, ended, launch-failed) and joins to spec runs on `(workflow_id, canonical spec_package)` (spec-observe/assignments.mjs:214-225); the dashboard; `overseer-inbox` for takeover holds.

**Relationships.** See the identity-mapping block in section 0. Additionally: `supersedes` chains launch retries; `spec_package` points into a repo's `.specs/<pkg>/` (package `runtime/package.lock` is observed read-only before launch); `workflow_id` is caller-supplied, not generated here.

**Retention / privacy.** Never deleted; terminal states retained; `instructions` plaintext and the brief snapshot are stored per assignment. `.sentinel` and `assignments/` are 0700 but the workspace dir above is 0755, and the dashboard workspace viewer does *not* exclude `assignments` (dashboard.mjs:118).

**Observations.**
- **C-7 vs code drift.** (a) C-7 says the reservation is "a separate storage-root-wide execution-directory reservation, indexed by sha256 of the canonical execution directory ... full-assignment record". Code has no such index: exclusion is enforced by listing all assignment records under the root claim and refusing if another record in `launching|live|launch_unknown` has the same `execution_dir` (assignments.mjs:1424-1431). Behaviorally equivalent but O(n) per launch and bounded by `listAssignments` budgets (if the scan is truncated the launch should refuse; verify). (b) C-7 lists `launch error`, `ended-observed time`, `Pi path/pid/start`; code uses `attention[]` strings (`"launch spawn failed: ..."`), no `ended_at`, and `pi_identity {pid, started_at}` plus a separate `launcher_identity`. (c) C-7 says "tmux session and socket derived"; socket is derived per root (`.sentinel/adjacent.sock`), not per assignment; an explicit `tmux_socket` input is allowed if absolute (assignments.mjs ~500), which the CLI README does not expose.
- The root claim is held across scan + publish, then **released before tmux spawn** and reacquired afterward (assignments.mjs ~1443-1463). The only guard between is the durable `launching` record plus `launch_token` and `launcher_identity` re-check (1472-1479). A crash in that window leaves `launching`, resolved to `launch_unknown` by `classify`; the reservation is retained until confirmed gone. This is designed, but the operator-visible remedy for a stuck `launch_unknown` is manual (retry requires confirmed-gone).
- `locate` run by hand can see its own argv containing the UUID and keep reporting `live` (README documents this self-match).
- No back-pointer to a thread; no `result`/`artifact` fields (the doc's "results can return to workspace" has no schema).
- Assignment and thread sessions share `sessions/<uuid>/`; ids are different UUID populations so collision is improbable, but the directory name does not say which it is.

---

### 9. Assignment Pi session and tmux session

**Location / naming.** Pi session: `projects/<ws>/sessions/<assignment_id>/` (dir created 0700 at reservation time, assignments.mjs ~1359-1366); Pi creates `<ts>_<assignment_id>.jsonl` there because argv has `--session-dir <dir> --session-id <assignment_id>` (assignments.mjs ~516-524). tmux: server socket `<root>/.sentinel/adjacent.sock`; session `adj-<12 hex>`; session option `@adjacent_assignment_id` = full UUID; env `ADJACENT_ASSIGNMENT_ID`. Pi argv ends with `@<brief_snapshot>` and an initial instruction ("Perform the following request ..." or "Read the skill at <abs path> ...") plus an assignment block `Assignment <id> workspace <ws> dir <execdir>. Publication authority: <x> (grants no merge/deploy).`

**Format & schema.** Pi session v3 JSONL (same as thread). tmux state is live process state, not a file. `startSession` (tmux.mjs:272-312) runs one command queue: `start-server; set-option -s extended-keys on; set-option -s extended-keys-format csi-u; new-session -d -x 200 -y 50 -s <name> -c <cwd> -e ADJACENT_ASSIGNMENT_ID=<id> -- <pi> <args...>; set-option -t =<name>: @adjacent_assignment_id <id>`. `attachArgs` = `-S <sock> attach-session -t =<name>`. `probeSession` returns `{status: present|absent|unknown, assignment_id, pane_id, pid}`.

**Purpose.** Interactive Pi that survives disconnects; attached with `cli attach` (requires TTY and exact pane/PID/start match), also over `ssh -t`.

**Lifecycle & frequency.** Lives until the operator quits Pi; the launcher never kills. No tmux server runs now (`tmux ls`: no server), consistent with zero launches. Session file appended on every turn.

**Writers.** Interactive Pi (agent) writes the session; tmux server is the process host. **Readers.** `reconcile.discoverPiSession` (bounded read of file header, ambiguous if multiple `.jsonl`), `probeSession`, sentinel, `takeover` (workflow hold via overseer inbox, not terminal input).

**Relationships.** `pi_session_file` recorded back into the assignment record once discovered; session header `cwd == execution_dir`; workflow identity becomes relevant only if the launched coordinator itself runs `spec_dispatch`, which acquires its own writer lease (launcher does not take it, only *observes* `<gitdir>/spec-runtime.lock` and `<spec_package>/runtime/package.lock`, refusing launch if present: assignments.mjs:1274-1303).

**Retention / privacy.** Session files never pruned; tmux scrollback is in-memory only.

**Observations.** tmux liveness is socket-based and per-user; a reboot loses all sessions and leaves `live` records that `classify` will transition only after confirmed gone (dead launcher + absent terminal + dead Pi). `ps` default probe never claims "absent", so such records may stay `live` with attention until `psRun` is injected or Pi identity is confirmed dead; verify in practice before relying on it.

---

### 10. Root launch lease (SQLite `owner_claims`) and host singleton

**Location / naming.** Launcher: `<root>/.sentinel/coordination.sqlite` (derived only; overrides refused: assignments.mjs:680-700). Host: `~/.pi/agent/spec-sentinel/coordination.sqlite` (C-6, adj2). Both use `claimOwner` (spec-observe/owner-claim.mjs).

**Format & schema.** `CREATE TABLE owner_claims (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL, token TEXT NOT NULL) STRICT` (owner-claim.mjs:16-21), `node:sqlite` `DatabaseSync`, `BEGIN IMMEDIATE` transactions, file created 0600 exclusively, symlinks refused, database kept after release. `started_at` is opaque `ps -o lstart=` text compared exactly (process-identity.mjs). Launcher key `adjacent-launch`; host key `sentinel-host` (value observed: pid 77259, 12:50:59 today).

**Purpose.** Cross-process mutual exclusion (record scan/publish, locate persists) and single-host guarantee; PID reuse-safe via start-time identity.

**Lifecycle & frequency.** Launcher DB created on first launch (absent). Claims held for milliseconds to seconds; retry every 50 ms up to 5 s (assignments.mjs:50-53). Host claim for the host lifetime.

**Writers.** `acquireRootClaim` callers: `launchAssignment` (twice per launch), `locateAssignment`. **Readers.** same.

**Relationships.** Not authoritative for any workspace/thread/assignment data (C-6 explicit: "holds no records").

**Observations.** The lease serializes assignment-record writes but not thread-record writes or kit edits (three independent locking domains). An unreadable owner identity is treated as unknown, never reclaimed, so a crashed holder with `EPERM` start probe can block launches until the 5 s deadline throws.

---

### 11. Phoenix legacy state (`.adjacent/`)

**Location / naming.** `<root>/.adjacent/state.sqlite3` (49 KB; `-wal` 297 KB Oct 8 07:03; `-shm`), `<root>/.adjacent/asr-cache/` (Whisper model, excluded from backup), and per-project `projects/{adjacent,firstwho}/.adjacent/{threads/<uuid>/context.json, sessions/<ts>_<uuid>.jsonl, subagents/{async-subagent-runs,async-subagent-results,supervisor-channels,async-retention-maintenance.jsonl,.async-retention-cursor.json}}`. `transitops` has no `.adjacent/`.

**Format & schema.** SQLite tables (read-only inspection): `schema_migrations` (2 rows), `threads` (3 rows; columns id, project_id, repository_id, skill, title, spec_package, execution_root, session_dir, bundle_fingerprint, desired_state, attention, pi_os_pid, pi_started_at, live_runs JSON, recovery_attempts, inserted_at, updated_at, provider, model_id, thinking_level, model_attention; triggers enforce provider/model/thinking validity), `commands` (7 rows; per-thread seq queue with body, body_sha256, state, disposition, leaf_before, entry_id), `thread_resources` (4 rows; path claims with `released_at`), `app_owner` (1 row, pid + process_started_at), `pi_model_default` (1 row, all null). Thread rows: `adjacent` finished (Oct 5), `firstwho` active (Oct 7), `adjacent` active (Oct 8). Per-thread `context.json` stores resolved context paths, `executionRoot`, `skill`, `rulesRoot`, `skillRoot` (pointing into the Phoenix `_build/dev/...` tree).

**Purpose.** State of the retired Phoenix app. The architecture doc says it "will not run again" and its three threads "migrated by hand"; adj7 would import them.

**Lifecycle & frequency.** Frozen: last write Oct 8 07:03 (WAL). Two rows are still `desired_state='active'`, so Phoenix's recovery-on-boot semantics (restart active threads) would revive them if the Phoenix app is ever started; adj7 I-6/I-7 exists to guard that.

**Writers.** None now. **Readers.** None in committed code (adj7 importer not built). C-3: opened read-only, never written.

**Relationships.** Thread rows map to `projects/<project_id>/.adjacent/threads/<id>/` and sessions; `threads.execution_root`/`session_dir` hold absolute paths in the old layout; `app_owner` pid/start is the Phoenix owner (stale).

**Retention / privacy.** Backup taken (confirmed by file count, bytes, SQLite integrity check, per docs). The WAL contains uncommitted-to-main-file pages: copying only `state.sqlite3` would lose data (backup includes all three).

**Observations.** The root carries two parallel thread representations (Phoenix SQLite + JSONL dirs vs new `threads/*.json`); nothing reconciles them yet. Nothing in the new system detects or warns about active Phoenix rows.

---

### 12. Cross-cutting observations

**Docs vs code drift (summary).**
- C-8 thread record field list is far shorter than ThreadV1; the Pi child's `--tools read,grep,find,ls` restriction and `--no-*` flags are not in the contract; uncommitted edits are changing the context-injection stance in both code and doc simultaneously.
- C-7: sha256-indexed reservation not implemented as described; `launch error` / `ended-observed time` have no fields.
- C-5: repo status enumeration lacks `unreadable`.
- README says storage-root status `invalid_*`; the code has two statuses; README's "default matches Adjacent's dev default (`../adjacent-storage`)" is a Phoenix-ism.
- Docs call an assignment "results" return path; no schema exists.

**Concurrency / integrity risks.**
1. Three independent locking domains (kit lock file, in-process thread locks, SQLite root claim) and no cross-domain ordering. Fine today because writer sets are disjoint; fragile if a CLI thread command or the adj7 importer is added.
2. `updated_at` is not a reliable change marker for ThreadV1 (owned-exit persists omit the bump).
3. No directory fsync: crash after `rename`/`link` can lose the file entry on power failure (documented, accepted).
4. Hand-written YAML subset parser is the single gate for `kit.yaml`; any YAML feature outside the subset (anchors, block scalars, flow lists) makes the entire workspace `invalid` (hidden from `listWorkspaces` valid set but shown under `invalid` with errors).
5. Kit `context:` / repository paths are absolute and per-machine; the store is not portable (also true for migration manifests).

**Privacy / exposure.**
- Private by design: thread JSON 0600, `.sentinel` 0700, `assignments/` and assignment session dir 0700, dashboard thread routes local-only, `threads`/`sessions`/`.adjacent` excluded from the workspace file viewer.
- Not covered: `assignments/` (instructions, brief snapshots), `migration/`, `.specs/` content, `designs/`, `kit.yaml.prev-*`, `kit.yaml.lock` are all reachable through `/api/workspace-file` if the Host/Origin checks pass (also over tailscale serve: remote read is allowed for files, remote is only blocked for thread routes). Brief files are intentionally viewable; assignment `instructions` and absolute paths in `*.json` records are not.
- Pi session files are 0644 inside 0755 directories.
- `sources/` and `migration/` contain copies of untracked repo files (logs, scripts, verification JSON); contents not inspected.

**Change-frequency estimates (evidence).**
- Code: `scripts/workspaces/` and `docs/adjacent-architecture.md` have about 55 commits, all between 2026-10-10 and 2026-10-11 (git log). Newest working-tree edits (Oct 11 12:47-12:49) are uncommitted in 8 files.
- Data: real store changes since Oct 7 are limited to one new thread (created Oct 11 12:39 local, updated 12:51/13:01). Workspace manifests untouched since Oct 6. Phoenix data frozen since Oct 8. No assignments, briefs, notes, artifacts, or `.sentinel/` yet.
- `.specs/adj*` are gitignored (`.gitignore:4`), so history for specs comes only from mtimes: adj1 Oct 10 14:45, adj3 20:43, adj4 21:33, adj5 Oct 11 02:41, adj6 07:28, adj7 Oct 10 16:56 (never advanced beyond spec/steps).

**Candidate follow-ups (for the audit synthesis, not actions taken).**
1. Document ThreadV1 and the assignment record schemas in one place (the validators are the only authority).
2. Decide whether `assignments/` and `migration/` belong in `WORKSPACE_EXCLUDED`.
3. Fix `updated_at` on exit persistence or stop treating it as monotonic.
4. Commit or revert the in-flight context-injection removal so C-8, tests, and the real record agree.
5. Build or formally defer adj7; until then the three Phoenix threads (two `active`) remain unreconciled.


---

## Sentinel and spec observation

Audit date: 2026-10-11 (UTC ~17:15). Read-only. Credential files were not opened; the only secret-bearing structures touched were `coordination.sqlite` (token column length only) and `/api/state` (the per-process `action_token` was never printed or stored).

### 0. Scope corrections and headline findings

- **The premise that `scripts/spec-observe/sentinel.mjs` has uncommitted edits is not true.** `git status` shows modifications only in `scripts/spec-observe/dashboard.html`, `dashboard.test.mjs`, `scripts/workspaces/{discussion,discussion-routes,pi-rpc}*.mjs` and `docs/adjacent-architecture.md`. `sentinel.mjs` last changed in commit `5f673f0` (per-package read floor). The in-flight data changes are: (a) dashboard UI for a **new-thread form** that POSTs to `/api/thread/create` (a route that is already committed in `scripts/workspaces/discussion-routes.mjs:45`), and (b) `discussion.mjs` no longer requires kit context files before a thread starts (the `missing-context` help text changed accordingly, `dashboard.html` diff). Neither alters the observer snapshot schema.
- `.specs/` is **git-ignored** in `~/.agents` (`.gitignore:4`) and every other observed repo (`git check-ignore` confirmed for all six repos that hold `sentinel-merge.json`). All package-local sentinel files are therefore local-only and unversioned.
- There is exactly **one durable sentinel store outside the packages**: `~/.pi/agent/spec-sentinel/` (8.4 MB) plus the shared run index `~/.pi/agent/spec-runtime/` (3.2 MB, written by the runtime, read by the sentinel).
- Shadow mode has been used (54 grants, 98 shadow observations, 120 activation receipts). **Recover mode has never produced a record**: zero `intents/`, `effect-slots/`, `diagnostic-slots/`, `diagnoses/` files exist in the 11 observed `.specs` roots.
- Live problems seen in the running host (pid 77259, started 12:50 local): the 10 s reader timeout is being hit (snapshot flips between `partial` and `stale`, note "Sentinel scan exceeded 10000 ms" / "reader cooling down"), and `/api/state` returns **8.5 MB every 5 s poll** because 19 closed observer files are included.

### 1. Overview

#### 1.1 Data flow

```
 spec runtime (Pi ext)              operator / skills                     sentinel observer
 ─────────────────────              ─────────────────                     ─────────────────
 .specs/<pkg>/runtime/run.json      pr-url.json, work-tour.json           reads (bounded, read-only):
   runs/<id>.json, -activity/*       spec-steps.json                        receipts, activity, lease, checkpoints,
   runtime/sentinel/<wf>/…           inbox/ processed/                      incidents, intents, pr-url, work-tour,
 ~/.pi/agent/spec-runtime/<id>.json  .specs/_epics/<slug>/epic.json         completion, merge cache, epics
                                     adjacent-storage assignments         │
                                                                          ▼
                 collectWorkspace() ──► in-memory snapshot (v1) ──► ~/.pi/agent/spec-sentinel/<ws>/observers/<uuid>.json
                 (isolated reader child, 15 s + chokidar)                      │ (atomic rewrite, ~800 KB)
                                                                               ▼
                                              dashboard.mjs readDashboardState() ──► GET /api/state ──► dashboard.html (5 s poll)
 writes by sentinel into packages: sentinel-merge.json (shadow/recover only), sentinel-completion.json (operator click),
 runtime/sentinel/<wf>/{checkpoint,verification-incidents,authority/*,shadow/*,intents/*,slots,diagnoses/*} (runtime ext)
```

#### 1.2 Table: persisted data

| Structure | Path | Format | Writer | Reader | Change frequency (evidence) |
|---|---|---|---|---|---|
| Observer snapshot envelope | `~/.pi/agent/spec-sentinel/<sha256(agentDir,scope)>/observers/<observer-uuid>.json` | JSON, `schema_version:1`, 0600, ~800 KB live | `createSnapshotPublisher` in Pi ext / host | dashboard server, `jq`-style tools | every reconcile: 15 s + watcher-triggered + failure paths (seq 94→96 in ~25 s; 83 publishes in 20.7 min) |
| Owner claim DB | `~/.pi/agent/spec-sentinel/coordination.sqlite` | SQLite STRICT, table `owner_claims` | `claimOwner` (host) | host startup | once per host start/stop (mtime 12:50 = host start) |
| Discovery config | `~/.pi/agent/spec-sentinel/discovery.json` | JSON `{version:1,root}` | `saveDiscoveryRoot` (`/spec-sentinel root`) | `createRepositoryDiscovery` | not present here (default `~/Documents` in use) |
| Enrollment records | `…/<ws>/enrollments/<sha256(common)>.json` | JSON `{version:1,root,common,enrolled_at}` | `enroll` (`/spec-sentinel add`) | `readEnrollments` | not present here |
| Managed run index | `~/.pi/agent/spec-runtime/<run-uuid>.json` | JSON 4 fields | spec runtime dispatch | `discoverManaged`, `cli runs` | 823 files, 7 days; 101 created today |
| Run receipt / activity / lease | `<pkg>/runtime/run.json`, `runs/<id>.json`, `runs/<id>-activity/{owner,editor}.json`, `<git-common>/worktrees/<n>/spec-runtime.lock/lease.json` | JSON | spec runtime (not sentinel) | sentinel (allowlisted subset) | seconds–minutes during a run |
| Coordinator checkpoint | `<pkg>/runtime/sentinel/<workflow-id>/checkpoint.json` | JSON `version:1`, ≤1 MiB | `recordCheckpoint` / `reconcileRuntimeReturn` (Pi ext) | sentinel, overseer-inbox, policy guard | 55 files, max revision 108, 21/19/7/7 files touched on 10-08/09/10/11 |
| Verification incidents | `<pkg>/runtime/sentinel/<wf>/verification-incidents.json` (or `…/sentinel/verification-incidents.json` unbound) | JSON `version:1`, ≤64 KiB | `createVerificationRecorder` | sentinel | 58 files / 520 KB; 572 entries; **0 incidents ever opened** |
| Authority grant + activations | `<pkg>/runtime/sentinel/<wf>/authority/grant.json`, `authority/activations/<uuid>.json` | JSON `version:1` | `activateRuntimePolicy`, `disablePolicy` | policy guard (live capability re-verifies) | 54 grants, 120 activations since 10-08 |
| Shadow observations | `<pkg>/runtime/sentinel/<wf>/shadow/<intent-id>.json` | JSON `version:1` | `reserveIntent` in shadow mode | Pi ext report only | 98 files in 29 dirs, all `shadow-would-continue` |
| Intents / slots / diagnoses | `…/intents/<id>.json`, `…/effect-slots/{0,1}.json`, `…/diagnostic-slots/{0,1}.json`, `…/diagnoses/<incident-id>.json` | JSON `version:1` | `reserveIntent`, `finishIntent`, `diagnoseIncident` | `readReservationState`, sentinel (`intents/` only) | **none exist** (recover never ran) |
| Manual completion | `<pkg>/sentinel-completion.json` | JSON `schema_version` 1 or 2 | dashboard "Mark complete" | collector, dashboard overlay | 7 files (6 v2, 1 v1) |
| Merge reconciliation cache | `<pkg>/sentinel-merge.json` | JSON `schema_version:1` | `createMergeReconciler({persist:true})` | collector, `epics` | 52 files; mtime 10-08 22:30 → 10-11 16:15; written only in shadow/recover |
| PR publication record | `<pkg>/pr-url.json` | JSON, **heterogeneous** | publication skills (not sentinel) | collector (completion + merge input) | 130 files, 52 canonical |
| Work-tour verdict | `<pkg>/work-tour.json` | JSON `version` 1/2 | work-tour skill | collector (evidence + completion) | 114 files |
| Overseer inbox/processed | `<pkg>/inbox/<id>.md`, `processed/<id>.md` | Markdown + 5-key frontmatter | `deliverOverseerMessage`, spec-message skill (inbox); coordinator (processed) | `readInboxGuard` | 3 inbox, 9 processed files across all roots |
| Epic records | `<primary>/.specs/_epics/<slug>/epic.json` | JSON `schema_version:1` | operator / epic skills (sentinel never writes) | `readEpics` | 7 records, all touched 10-11 |
| Design packages | `<workspace>/designs/<slug>/design.json` | JSON, see `docs/design-packages.md` | design skills | `/api/workspace-designs` | read per request |

#### 1.3 Table: derived / in-memory (not persisted except as part of the snapshot envelope)

| View | Where built | Notes |
|---|---|---|
| Workspace snapshot (`runs`, `recently_completed`, `assignments`, `epics`, `coverage`, `conditions`) | `collectWorkspace` `sentinel.mjs:483-767` | one pass per scan; persisted only as the `snapshot` field of the envelope |
| Conditions | `runConditions`/`reduceConditions` `sentinel.mjs:348-396` | recomputed, IDs are content hashes |
| Epic member status | `deriveMemberStatus` `epics.mjs` | never stored; epic `state` is stored and hand-maintained |
| Assignment display state | `projectAssignment` `assignments.mjs:378` | pure projection of Adjacent records + process probes |
| Merge in-memory cache | `memory` Map ≤500 entries, `merge-reconciliation.mjs:139` | reader-process lifetime only |
| Discovery cache | `createRepositoryDiscovery` `discovery.mjs:90-101` | 5-minute in-memory cache inside the reader child |
| Dashboard `/api/state` cache | `dashboard.mjs:183` | 1 s |
| Dashboard manual-completion overlay | `applyManualCompletions` `manual-completion.mjs:41-64` | mutates the in-memory copy, not the observer files |
| Authority capability | `createSentinelAuthority` (Symbol-keyed state) | armed flag is memory-only; disk grants never arm |
| Intercom control channel `spec-sentinel/v1` | `sentinel-control.mjs` | tokens live in memory only; no disk record of a shadow/recover "start" |
| Browser state | `dashboard.html` | no `localStorage`/`sessionStorage`; imported snapshots are in-page |

---

### 2. Observer snapshot envelope

- **Location / naming:** `~/.pi/agent/spec-sentinel/<workspace-key>/observers/<observer-uuid>.json` (`sentinel-snapshot.mjs:8-13`). `workspace-key = sha256(JSON([resolve(agentDir), scope|null]))` (`sentinel.mjs:104-106`). One directory exists here: `183e59be…3088` (scope null). Each Pi session or host process creates a fresh `observerId = randomUUID()` and a new file.
- **Format & schema:** top level `{schema_version:1, observer_id, pid, sequence, published_at, refresh_interval_ms:15000, state, mode, note, snapshot}` (`sentinel-snapshot.mjs:17-21`). `state ∈ observing|off|closed` (validated at `dashboard.mjs:73-74`), `mode ∈ observe|shadow|recover` (from `modeStatus()`, `sentinel.mjs:96` area), `note` = last failure text or null. `snapshot` = §3. Written compact (`JSON.stringify`), mode 0600, through a same-directory temp + `rename` (`sentinel-snapshot.mjs:25-31`), serialized by a promise queue so one observer never interleaves writes.
- **Purpose:** public observation output "never recovery input" (header comment). One file per observer avoids two Pi sessions overwriting each other.
- **Lifecycle & frequency:** `reconcileTimer = repeat(run, 15000)` (`SENTINEL_RECONCILE_MS`, `sentinel.mjs:28`; arm at `activate()`), plus a 250 ms-coalesced invalidation from chokidar watchers on `.specs` trees (`SENTINEL_COALESCE_MS`, up to 60 watchers). Every `run()` that is not hidden/closed calls `publishSnapshot()`, including the failure branches (stale + note). Measured: sequence 83 after 20.7 min for the live host (14.9 s/publish); sequence 94→94→94→96 across ~25 s while the reader was cooling down. Closed files carry final sequences from 2 up to 17064, so earlier sessions published far more often than 15 s (watcher traffic).
  - File size ≈ 800 KB per publish (runs 435 KB, recently_completed 330 KB, epics 32 KB, coverage 10 KB). That is ≈3.2 MB/min ≈ 190 MB/h of rewritten data while the host runs.
- **Writers:** Pi extension observer (`pi/extensions/spec-runtime/sentinel.mjs:92 publishSnapshot`) and the headless host (`sentinel-host.mjs` composes the same observer with `headless:true`).
- **Readers:** `readDashboardState` (§17), the dashboard "Import snapshot" feature (user saves a file), the `spec-sentinel` skill (documentation says "JSON snapshots for other tools"), operator.
- **Relationships:** `workspace-key` links to agentDir+`PI_INTERCOM_SCOPE_ID`; `pid` links to the Pi/host process; `snapshot.runs[].package` links to spec packages; `snapshot.workspace` repeats the key and is what `dashboard.html authoritativeObservers()` groups on.
- **Retention / cleanup:** **none.** 21 files, 8.4 MB, spanning 10-07 → today. Terminal writes (`closed`/`off`) never delete; a terminal publish deliberately avoids `mkdir` so cleanup could remove the directory (`sentinel-snapshot.mjs:23-24`), but no cleanup exists in the repo (grep for unlink of observer files found nothing).
- **Observations:**
  1. **Orphans stay `observing` forever.** `977d5ad5…` (pid 92114, mode `shadow`, 8.4 KB, last published 2026-10-07T18:28:52Z) is still `state:"observing"`; pid is dead. The dashboard copes (45 s staleness rule, `dashboard.html:92`), but the file is never reaped. Consumers must apply their own liveness test; the docs say so ("a stale observing file is never proof").
  2. **Everything is shipped to the browser.** `/api/state` returned 21 observers / 8,475,785 bytes (0.14 s) with `truncated:false`. Server limits are `MAX_FILE 4 MiB`, `MAX_TOTAL 12 MiB`, `MAX_FILES 200` (`dashboard.mjs:21`); at ~800 KB per live-observer file, the 12 MiB ceiling is ~15 files away, after which older observers are silently dropped (`result.truncated=true` is the only signal). The client then discards all but one observer per workspace (`authoritativeObservers`).
  3. **Write amplification:** a full 800 KB rewrite every ~15 s even when nothing changed (no content hash check before publish).

### 3. Snapshot model (`snapshot` field; produced by `collectWorkspace`)

- **Location:** in-memory (Pi UI process or reader child) → persisted only inside the envelope; also printed by `cli.mjs sentinel status --format json` (`cli.mjs:105-108`).
- **Format & schema** (`sentinel.mjs:761-766`): `{version:1, workspace, coverage, activity_filter, runs[], assignments[], assignment_coverage, recently_completed[], epics[], completion_history, spec_roots[], discovery?, roots, reader?}`. `reader` (`isolated, pid, runtime, runtime_version, scan_ms`) is appended by the child (`sentinel-reader-process.mjs:140`); `roots` by the observer.
  - `coverage` = `{state: complete|partial|stale|unavailable, reasons[≤50], omitted:int|null, bytes_read, observed_at}` (`makeCoverage` `:174`). `omitted:null` means unknown omission.
  - **Run row** (`observeRun` `:992-1018`): `repository` (git common dir), `package`, `checkout`, `workflow_id`, `workflow_state` (checkpoint state), `workflow_workers[]`, `workflow_observed_at`, `merge{state,checked_at,reason,url,merged_at,head,merge_commit}`, `completion_revision`, `is_current_assignment`, `assignment_id`, `coordinator_session`, `execution` (receipt state: running|blocked|cancelling|completed|failed|cancelled|unknown), `obligation`, `spec_progress{basis:'step-position',total_steps,current_step,current_position,current_name,accepted_steps:null}`, `timing{basis:'first-recorded-dispatch',started_at,finished_at,observed_at,attempts[]}`, `activity`, `evidence{state: recorded|not-assessed|unavailable, verdict, commit, source:'work-tour.json', scope:'declared-artifact',…}`, `incidents[]`, `actions[]`, `source_paths[]`, `source_hashes[]`, `observed_at`, per-run `coverage`, `conditions[]`, optional `epic{epic,repository,position,total}`.
  - **Recently-completed row:** a run row spread with `{completed_at, completion_basis: workflow-checkpoint|ready-pr|manual|merged-pr, workflow_state:'complete', is_current_assignment:false}` (`:710`).
  - **Condition** (`:348-386`): `{id, kind, severity: info|attention, state: open|resolved|unknown, fact_ids, …}`. Kinds seen in code: `activity-unreadable|activity-mismatch|activity-unknown`, `repeated-verification-failure`, `action-outcome-unknown`, `reconciliation-pending`, `execution-failed|blocked|cancelled`, `lease-missing|mismatch|revoked`, `quiet-activity`. ID = sha256 of package, assignment, kind, **a signature that includes `source_hashes`**, and `CONDITION_GENERATION=1`, so IDs change whenever any source file changes.
  - **Limits** (`SENTINEL_LIMITS` `:22-42`): roots 20, assignments 50, workspaceAssignments 100, packageChildren 100, receiptFiles 100, receiptDirectoryEntries 5000, indexEntries 1000, smallJsonBytes 64 KiB, totalBytes 16 MiB, packageFloorBytes 96 KiB, quietActivityMs 120 s, recentActivityMs 24 h, recentCompletionMs 7 d, completedPackages 50, activityEntries 10000. `MAX_REASONS=50` (`:49`).
- **Purpose:** the single read model of "what spec work exists, what it owes, and how sure are we".
- **Lifecycle & frequency:** rebuilt from scratch each scan; fixed 16 MiB read budget, per-package 96 KiB floor reserved up to half the total (`makeBudget` `:182-203`). Last live scan reported `bytes_read: 11,065,440` of 16,777,216.
- **Writers:** `collectWorkspace`. **Readers:** envelope consumers (§2), `renderWorkspace` text view (`:410-456`), `inspect`, `cli`.
- **Relationships:** each run row joins a spec package (`.specs/<pkg>`), a Pi coordinator session (`coordinator_session` path), a git common dir (`repository`), a worktree checkout (`checkout`, validated against the common dir), and optionally an epic and a tmux assignment (via `assignments.mjs linkedRuns` by `spec_package`/`workflow_id`).
- **Retention:** none beyond the envelope's retention. In-memory "last facts" are retained across failures (`run()` keeps `latest` and flips coverage to `stale`, `sentinel.mjs:236-262`); `retainMissingSummaries` (`:106-137`) re-adds prior incidents/actions as `state:'unknown'` when their source vanishes.
- **Observations (live snapshot, 10-11 17:11Z):**
  1. **`MAX_REASONS` crowding.** `coverage.reasons` is exactly 50: 46 × `index-entry-invalid`, 3 × `discovery-cap`, 1 × `roots-cap`. Any further reason (e.g. `assignments-cap`, `package-noncanonical`, receipt caps) is silently truncated (`slice(0, 50)` in `makeCoverage`). The 46 are stale run-index pointers (§6).
  2. **Roots cap loses repos.** `roots-cap: selected 20 of 28`: eight discovered repositories are never observed (`SENTINEL_LIMITS.roots=20`, `sentinel.mjs:501-505`); discovery itself hits caps (1,939 dirs, 20,001 entries; limits 2000/20000 at `discovery.mjs:8`), so even the 28 are a prefix of a BFS.
  3. **`assignments-cap`** (50 runs) is spent mostly by one package: the 50 `runs` span only 4 distinct packages (one package has 23 attempts). Runs are per receipt, not per package, so a package with many retries can crowd out other packages' current assignment.
  4. `completion_history.omitted: 7` — seven completed packages inside the 7-day window are not shown (50 cap).
  5. `assignments: []`, `assignment_coverage.state: "stale"` with no reasons: the stale flag is set by the failure branch (`:244-246`) without recording why.
  6. `merge.reason` for the 79 rows visible: 29 `pr-record-invalid`, 25 `missing-pr-record`, 29 `authoritative-pr`, 5 `local-pr-merge`, 3 `pr-not-merged`, 2 `merge-check-budget` — i.e. most legacy packages cannot be merge-verified (see §14).

### 4. Observer host process, reader child and coordination lock

#### 4.1 Owner claim (`coordination.sqlite`)

- **Location:** `~/.pi/agent/spec-sentinel/coordination.sqlite` (12 KB, 0600, `claimHost` `sentinel-host-owner.mjs:29-42`; dir forced 0700).
- **Schema** (`owner-claim.mjs:17-22`): `owner_claims(key TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL, token TEXT NOT NULL) STRICT`. Schema is validated through `PRAGMA table_list/table_info` before use (`:112-127`). One live row now: `key='sentinel-host'`, `pid=77259`, `started_at='Sun Oct 11 12:50:59 2026'` (the `ps -o lstart` text), token 36 chars (UUID; value not read).
- **Purpose:** exactly one observe-only host per canonical agentDir, regardless of scope or port (`HOST_OWNER_KEY='sentinel-host'`). Not a lock on workspace data.
- **Lifecycle:** `claimOwner` runs `BEGIN IMMEDIATE`; refuses if the stored pid is alive with the same start text or if its status is unknown (fail closed); replaces a row only when the pid is confirmed dead or alive with a different start text (`:189-204`). `release()` deletes by `(key,token,pid,started_at)`; the file is intentionally retained. Written once per host start/stop (mtime 12:50).
- **Writers:** the host (`composeHost`, `sentinel-host.mjs:67`). **Readers:** the next host start. Pi-session observers do **not** take this claim (only `sentinel-host.mjs` calls `claimHost`), so a Pi `/spec-sentinel observe` and the launchd host can run concurrently, each writing its own envelope.
- **Relationships:** PID/start identity shared with `process-identity.mjs`, which is also used by `assignments.mjs`, `workspaces/{tmux,reconcile,discussion,assignments}.mjs`.
- **Retention:** one row, deleted on clean release; a crashed host leaves a stale row that the next claim reclaims after a dead-pid check. Requires experimental `node:sqlite` (Node v24.9 target; the reader child reported `v24.9.0`).
- **Observations:** the start-time identity is `ps -o lstart=` text under `LC_ALL=C` compared as an opaque string (`process-identity.mjs:7-13`). That text is rendered in the **local timezone**, so a TZ/DST change while a process runs makes the same live process look "alive, different start" and permits a duplicate claim (inference from the code; not exercised). Contrast with the runtime's own `<pid>.json` process files (`runtime.mjs:70-84`), which store only `{pid, role, active, started_at(ISO launch time)}` with no OS start identity: two different notions of process identity in one codebase.

#### 4.2 Reader child process

- **Location:** forked `node sentinel-reader-process.mjs --sentinel-observer-child` (`sentinel-reader-process.mjs:36`); in-memory only (observed live pid 66686 from the snapshot is already gone; the child is SIGKILLed on timeout/stop).
- **Contract:** IPC messages `read|watch` → `result|change|watch-error`. Timeout 10 s (`timeoutMs`), cooldown 15 s after any failure (`cooldownMs`), `execArgv: []`. Child imports `collectWorkspace`, `readEnrollments`, `createRepositoryDiscovery`, `createMergeReconciler`, `watchSpecTree` and runs scans with `mergeLookup` on for non-read-only passes (`:131-139`).
- **Frequency:** one scan per reconcile (15 s) or invalidation (watchers debounced 1 s in the child, 250 ms in the parent).
- **Observations:** the README promises up to 8 s of merge command work per scan plus a 16 MiB read budget plus discovery (2 s cap) inside a 10 s scan timeout. Live evidence shows the timeout firing (`note: "Sentinel scan exceeded 10000 ms; reader stopped, last facts retained."`, then `"Sentinel reader cooling down after a failed scan"`), and each kill discards the child's 5-minute discovery cache and merge memory so the next scan pays full cost again. The `scan_ms` of a successful scan was 2423 ms, so the failures are likely scans where `gh pr view` network calls (budget 3.5 s each, 3 per scan) stack on discovery (inference; the logs do not name the cause).

#### 4.3 Host composition and dashboard

- `createDirectDashboard` (`sentinel-dashboard.mjs:93-153`) serves `createDashboardServer` in-process for the host; `createSentinelDashboard` (`:13-91`) forks `dashboard.mjs` for Pi sessions (ready/error messages over IPC). Both bind `127.0.0.1` only; `--public-host` only widens Host/Origin acceptance.
- Host receipt: one stdout JSON line `{type:"ready", state, snapshot_path, dashboard_url, dashboard_state, discussion_state}`.

### 5. Repository registry: discovery, enrollment, roots

- **Location / naming:** (a) discovery root config `~/.pi/agent/spec-sentinel/discovery.json` (`discovery.mjs:10`); (b) enrollment records `~/.pi/agent/spec-sentinel/<ws-key>/enrollments/<sha256(common dir)>.json` (`sentinel.mjs:126-128`, writer `enroll` `sentinel.mjs` ext `:322-345`); (c) the effective list is **derived** each scan and published as `snapshot.roots` and `snapshot.discovery`.
- **Format & schema:** config `{version:1, root:absolute}` ≤8 KiB, written `wx` 0600 then `rename` (`discovery.mjs:36-45`); enrollment `{version:1, root, common, enrolled_at}`, allowlisted at read to `{version, root, common}` (`sentinel.mjs:150-153`; `enrolled_at` is write-only). `snapshot.discovery = {root, roots[], reasons[≤50], directories, entries, observed_at}`.
- **Purpose:** there is no standing registry. The "discovered repository registry" is recomputed: BFS beneath the root (`DISCOVERY_LIMITS` depth 8, 2000 dirs, 20000 entries, 2000 ms, cache 300000 ms), a directory with both `.git` and `.specs` is a candidate root; skip list `node_modules, vendor, deps, _build, build, dist, target, coverage, __pycache__` and dot-dirs; symlinks never followed (`discovery.mjs:47-88`). Roots from enrollment ∪ discovery are then validated per package by `canonicalPackage`, which rejects linked worktrees by comparing the checkout's git common dir (`sentinel.mjs:509-523`).
- **Lifecycle & frequency:** discovery re-scans at most every 5 min inside a long-lived reader (cache is lost on every reader kill, see §4.2). Config and enrollment are written only by explicit commands; neither file exists on this machine.
- **Writers:** `/spec-sentinel root PATH` (config), `/spec-sentinel add PATH` (enrollment; cap 20). **Readers:** reader child, `cli.mjs sentinel status`.
- **Relationships:** root → git repo → `.specs/<pkg>` → packages; managed run index pointers supplement packages but "never enroll" a repo (`sentinel.mjs:541`).
- **Retention:** enrollment records are never removed by code (no `/spec-sentinel remove`).
- **Observations:** this machine's live registry is capped at both layers: discovery hit all three caps (`discovery-cap` ×3) and 8 of 28 found roots were dropped by `roots-cap`. Default root `~/Documents` is hard-coded in `configuredRoot` (`discovery.mjs:31`) and README. Enrollment limit (20) equals `SENTINEL_LIMITS.roots`, so a large discovery result can starve enrolled repos as well (enrolled and discovered roots are merged before the cap with no priority for enrolled).

### 6. Managed run index (`~/.pi/agent/spec-runtime/<run-uuid>.json`)

- **Format:** `{run_id, package, manifest, parent_session}` (`runtime.mjs:317`). Sentinel keeps only these plus `indexed_at` from file mtime (`core.mjs:57-59`).
- **Purpose:** "pointer index" so `cli.mjs runs` and the sentinel can find packages without scanning disk; pointers are discovery hints, never run rows.
- **Lifecycle & frequency:** one new file per dispatch. Counts by mtime day: 05:39, 06:70, 07:126, 08:194, 09:237, 10:56, 11:101 (total 823, 3.2 MB).
- **Writers:** spec runtime (`Runtime.start`). **Readers:** `discoverManaged` (≤1000 candidates, ≤4000 examined, 64 KiB per record, charged to the scan budget), `cli.mjs runs`.
- **Retention:** none (`rmSync` in `runtime.mjs` is used only for locks). **46 of 823 pointers reference packages that no longer exist** (`existsSync` check), each producing one `index-entry-invalid` reason on every scan (see §3 obs 1). Headroom: 823 pointers vs the 1000 candidate cap — within ~2 days at the current ~100–200/day rate the cap is exceeded and the oldest-by-mtime tail gets `index-cap`/`candidates_truncated` (sorted newest first, so loss is of the oldest).
- Write ownership belongs to the spec-runtime area; noted here because it feeds sentinel coverage.

### 7. Run receipts, activity, lease (inputs; allowlisted)

- **Location:** `<pkg>/runtime/run.json` (latest), `runtime/runs/<id>.json`, `runtime/runs/<id>-activity/{owner,editor}.json`, `runtime/runs/<id>-processes/<pid>.json`, lease at `<receipt.lock>/lease.json` under `<git-common>/worktrees/<name>/spec-runtime.lock/`.
- **Format:** receipt keys on disk include `schema_version,id,assignment_id,package,primary,step,checkout,owner_model,editor_model,scout_model,dispatch_requested_at,routing_reason,environment,child_extensions,owner_session,editor_session,parent_session,lock,package_lock,token,state,started_at,timeout_ms,pid,result,finished_at` (sample on `.specs/spec-sentinel/runtime/run.json`). The sentinel keeps only `RECEIPT_KEYS` (`sentinel.mjs:44-45`) plus `attempt_kind` and `handoff.outcome` from enumerated values (`:863-864`); `token`, `result`, `pid`, session paths beyond those, `environment` are dropped. Activity snapshot `{run_id, role, started_at, last_activity, phase, activity, hint, error}` → kept `{run_id, hint, activity, phase, last_activity}`, with `publicHint` redaction. Lease `{id, token, package, revoked}` → kept `{id, revoked}` (token never retained or hashed).
- **Lifecycle:** receipts written by the runtime during a run; the sentinel reads `run.json` first (stable path), then up to 100 `runs/*.json` (excluding `*-verification.json`, `*-completion.json`) from at most 5000 directory entries (`collectPackage` `:835-890`) so logs and transcripts in the same folder do not hide receipts.
- **Writers:** spec runtime. **Readers:** sentinel; `metrics`/`core` use the same files plus sessions.
- **Observations:** a receipt whose `id`/`package` disagree with its filename/package is marked `receipt-mismatch` and sets `staleReceipts` → workspace coverage `stale`; `lease-*` conditions only fire for non-terminal runs. `runs/` is large (1,698 entries in the sample package; 14 command logs per run id) so the 5000-entry examination cap is a real ceiling for long-lived packages.

### 8. Coordinator checkpoint

- **Location:** `<pkg>/runtime/sentinel/<workflow-id>/checkpoint.json` (`checkpointPath`, `sentinel.mjs` ext `:1115`). Workflow id regex `^[A-Za-z0-9_-]{1,128}$`.
- **Schema** (`recordCheckpoint` record `:1255-1281`): `{version:1, workflow_id, package, checkout, coordinator_session, revision, obligation_revision, state, obligation{key,stage,step?,summary≤160,artifacts[{path,sha256}]}, workers[{id,kind,state}], inbox{items[{id,sha256,outcome,kind,directory,release_source_id?}], observed_directories[]}, inbox_guard{state,blocking,reasons,items,observed_at}, input_revision, observed_at}`. `state ∈ ready|waiting-worker|waiting-external|decision-required|blocked|user-held|complete|unknown`; worker states add `working|failed|aborted|cancelled`. Observed distribution (55 files): complete 29, waiting-worker 11, ready 9, decision-required 3, blocked 2, user-held 1; max `revision` 108; total 106 KB.
- **Purpose:** the durable coordinator record that binds one workflow exclusively to one coordinator session + checkout, with optimistic `expected_revision` concurrency, SHA-256 bound artifacts and a retained inbox guard.
- **Lifecycle & frequency:** `publishDurable` (temp + fsync + rename; first registration is `link`-exclusive; parent-dir fsync) on every `spec_sentinel_checkpoint` call and on `reconcileRuntimeReturn` when a worker returns. Fully rewritten per revision; ~21 files changed on 10-08, 19 on 10-09, 7 each on 10-10/10-11.
- **Writers:** only `recordCheckpoint` / `reconcileRuntimeReturn` / `completeWorkflowsAfterPublication` / `final-checkpoint.mjs` (all Pi runtime, never the observer). **Readers:** sentinel (allowlist at `sentinel.mjs:1234-1248`, 64 KiB cap on read), `readInboxGuard`, `deliverOverseerMessage`, policy guard, `final-checkpoint.mjs`.
- **Relationships:** `workflow_id` ↔ many receipts via `workers[].id` (a worker id may be a run id or an assignment id); `coordinator_session` ↔ receipt `parent_session`; `checkout` ↔ receipt `checkout`; one checkpoint per workflow per package, so a package with several workflows has several.
- **Retention:** none; completed checkpoints are kept (29 complete).
- **Observations:** the writer allows `ARTIFACT_TOTAL_BYTES = 1 MiB` per checkpoint but the sentinel reads only the first 64 KiB (`smallJsonBytes`); a checkpoint between 64 KiB and 1 MiB is writable but unobservable (reported as `checkpoint-invalid`). Current files are tiny (avg 1.9 KB) so the mismatch is latent. Completion by "workflow checkpoint" requires *every* checkpoint in the package to be `complete` with no active workers (`packageCompletion` `:806`): a single leftover `waiting-worker` checkpoint from an abandoned workflow blocks completion and keeps the package "current" until the operator uses Mark complete (7 manual completions exist, which is consistent with this).

### 9. Verification incidents

- **Location:** `<pkg>/runtime/sentinel/<workflow-id>/verification-incidents.json`; unbound variant `<pkg>/runtime/sentinel/verification-incidents.json` (`sentinel.mjs` ext `:756-761`).
- **Schema:** `{version:1, package, workflow_id|null, updated_at, assignments{<assignment>: {assignment_id, checkout, workflow_id, count, fingerprint{command_sha256,summary_sha256,tree_digest}, tool_call_ids[≤8], replay_ids[≤96 truncated digests], replay_exhausted, state: idle|counting|open|resolved, generation, incident_id, linked_from, incident_fingerprint, observed_at}}}`. ≤20 assignment entries (oldest non-open evicted first, `pruneAssignments` `:630`), file ≤64 KiB. The observer allowlists to `{id, generation, workflow_id, assignment_id, count, state, observed_at}` and rejects the whole file if any entry violates the schema (`sentinel.mjs:1266-1292`).
- **Purpose:** count consecutive identical failing `spec_verify` results; the third opens an incident generation. Only hashes and counts are stored, never command text.
- **Lifecycle & frequency:** rewritten on each completed `spec_verify` tool event (synchronous `writeFileSync` + rename, inside the event seam; failures swallowed). 58 files / 520 KB; 572 entries (505 idle, 67 counting); **no incident has ever opened**, so the whole `repeated-verification-failure` condition path has never fired in production data.
- **Writers:** `createVerificationRecorder.observe` (Pi ext, invoked from the runtime event seam). **Readers:** sentinel, diagnosis (`diagnoseIncident`), tests.
- **Retention:** per-file cap of 20 assignments; files themselves never removed.
- **Observations:** this write is not fsynced (unlike checkpoint), so a crash can lose the last count; the replay-digest set caps at 96 and then permanently disables new incident generations for that assignment (`replay_exhausted`) — safe but silent.

### 10. Authority, shadow and recover records

- **Modes:** `observe` (default, no authority), `shadow` (would-act, records "would-continue"), `recover` (can reserve effects). Selected with `/sentinel shadow|recover [--model] [--root]`; the model-facing `sentinel_lifecycle` tool can only observe/status/off (`lifecycle()` rejects other actions, `sentinel.mjs` ext `:540s`). Default diagnosis model `openrouter/inception/mercury-2.5:high` (`sentinel-options.mjs:3`). Cross-session start/stop travels over the in-memory intercom channel `spec-sentinel/v1` (`sentinel-control.mjs`); there is no disk record of the controller token.
- **Grant / activation** (`activateValidatedPolicy` `sentinel.mjs` ext `:1976-2046`):
  - `authority/activations/<uuid>.json` — immutable, written exclusive with parent fsync: `{version:1, activation_id, workflow_id, package, coordinator_session, checkout, source_path|null, source_hash, command, mode, actions[], max_effects(≤2), max_diagnostics(≤2), diagnosis{model}|null, expires_at|null, authority_reference, activated_at}`.
  - `authority/grant.json` — activation fields plus `revoked:bool`, `activation_path`, and on revocation `revoked_at`, `reason` (`disablePolicy` `:2048-2081`).
  - Policy-file route (`/spec-sentinel enable <policy.json>`) vs runtime-mode route (`activateRuntimePolicy`, `authority_reference:'operator:runtime-mode'`, `expires_at:null`, `source_path:null`). Policy files are ≤16 KiB, max 8 h expiry.
- **Observed data (54 grants):** all `mode:'shadow'`, all `source_path:null`, `command:'/spec-sentinel shadow'`, `expires_at:null`, actions `[continue,cancel]`, diagnosis model Mercury. 47 revoked with reason `runtime-mode-stopped-or-changed`; **7 not revoked** (6 activated within the same 15 ms at 2026-10-08T18:02:53Z and one at 2026-10-09T04:44:04Z) — consistent with the observer files closing at 18:02:43 and a controller disappearing without calling `disablePolicy`. These remain `revoked:false` on disk indefinitely. Docs say disk files never arm authority, so they are inert, but any reader that trusts `revoked:false` would misreport them as armed. Activation receipts: 120 (≈2.2 per grant; each re-arm adds one).
- **Shadow observations** (`shadow/<intent-id>.json`): `{version:1, id, kind, workflow_id, package, subject_key, source_revision, reason_code:'shadow-would-<kind>', observed_at}`; exclusive write, deduped by id = `sha256(workflow\0kind\0subject)[:32]`, so a subject generation records once per workflow. 98 records in 29 workflow dirs, all `continue`. Not read by the observer snapshot (they do not appear in `actions[]`); only a UI report is emitted (`sentinelControl.report`).
- **Intents / slots / diagnoses** (recover mode; exist in code and tests, absent on disk):
  - `intents/<id>.json` exact keys `version,id,workflow_id,package,coordinator_session,kind(continue|cancel|diagnose),subject_key,source_revision,policy_hash,reserved_at,state(accepted|requested|applied|blocked|failed|unknown),reason_code,result_reference?`. Lifecycle accepted→requested→terminal; `unknown` retains the writer reservation and blocks all further automation for that workflow until reconciled (`readReservationState` `:2207-2290`).
  - `effect-slots/{0,1}.json` and `diagnostic-slots/{0,1}.json`: `{version:1, workflow_id, pool, slot, intent_id, kind, reserved_at}`; written **before** the intent (a crash leaves a spent orphan slot that blocks). Capacity is never reclaimed; 5-minute cooldown between diagnoses.
  - `diagnoses/<incident-id>.json`: `{version:1, workflow_id, package, incident_id, incident_generation, assignment_id, record_id, model, intent_id, state, validation, decision(observe|cancel-candidate|human-decision|abstain), fact_ids, reason_code, …, usage, packet_sha256}`; packet ≤16 KiB, response ≤8 KiB, no raw model text kept.
  - The observer reads only `intents/*.json` (≤64 files, `readActionSummaries` `sentinel.mjs:1294-1319`) and maps them to `actions[]` rows `{id, workflow_id, kind(continue|cancel|diagnose), subject_hash, state, reason_code}`; `actions[]` rows are attached to the run whose checkpoint `workflow_id` matches, and are marked `current` by comparing `subject_hash` to the obligation revision or an incident id.
- **Writers:** Pi runtime extension only (`reserveIntent`, `finishIntent`, `diagnoseIncident`, `activate*`/`disablePolicy`). **Readers:** the live authority itself (re-reads and compares every field on every guard), observer (`intents`, `verification-incidents`), operator.
- **Relationships:** bound by `(package, workflow_id, checkout, coordinator_session)` to exactly one checkpoint; re-activation can only narrow (no mode/cap/expiry expansion).
- **Retention:** nothing deleted, including 120 activation receipts and revoked grants.
- **Observations:** (1) Documentation (`docs/spec-runtime-observation.md` "Guarded recovery") and `skills/spec-sentinel/SKILL.md` list `/spec-sentinel enable <policy>` as the arming path; every grant on disk came from the runtime-mode path. (2) `SKILL.md` "Native commands" omits `enable`, `disable`, `root`, `add`, all of which the handler implements. (3) Shadow observations are not surfaced in the snapshot or dashboard, so the only durable trace of what shadow mode "would have done" is 98 files nobody reads.

### 11. Overseer inbox and processed mailbox

- **Location / naming:** `<pkg>/inbox/<id>.md` and `<pkg>/processed/<id>.md`; id = `<UTC compact timestamp>-<suffix>` (skill examples `20260928T150000Z-a71c`; code-generated `YYYYMMDDTHHMMSSmmmZ-<uuid>`, `overseer-inbox.mjs:32-41`).
- **Format & schema:** UTF-8 Markdown with exactly five unquoted frontmatter keys `id, run, sender, audience, kind` then body (`serialize` `:50-52`). `kind ∈ hold|direction|information` in the protocol; the module accepts only `hold|direction` (`KINDS` `:16`). `audience ∈ coordinator|implementation|step-NNN|review|fix` in the protocol; the module hardcodes `coordinator` and `sender === 'operator'` (`:91-92`). Body ≤ `INBOX_FILE_BYTES` (64 KiB), no NUL/unsafe controls. Run id `^[A-Za-z0-9_-]{1,128}$`.
- **Purpose:** one-way operator→coordinator direction/hold channel. The protocol is in `skills/spec-end-to-end/references/overseer-inbox.md` and the sender skill in `skills/spec-message/SKILL.md`.
- **Lifecycle & frequency:** operator-driven; 3 originals still in `inbox/` (gtfs-planner: 2 for `04-timetable-paste-import` dated 2026-09-28, 1 for `28-stop-add-edit` dated 2026-10-01 18:46) and 9 in `processed/` across all roots. The coordinator moves originals to `processed/` and records intake receipts in its stage ledger; nothing moves them automatically. Hold release requires a later `direction` that names the hold id plus matching `applied` outcomes and hashes in the checkpoint (`readInboxGuard` projection retained in `checkpoint.inbox_guard`).
- **Writers:** (a) `deliverOverseerMessage` (exclusive `createFileExclusive`, one publication, one guard verification; returns `delivered|unconfirmed`), called from `scripts/workspaces/cli.mjs:34`; (b) the `spec-message` skill via filesystem tools; (c) the coordinator (archive move). **Readers:** `readInboxGuard` (bounded: 200 files, 1 MiB total), coordinator, `verifyPublished`.
- **Relationships:** `run` ↔ coordinator workflow id (run id recorded in the stage ledger, also the checkpoint `workflow_id`); lives in the primary-checkout package; guard sources are recorded in `checkpoint.inbox`.
- **Retention:** originals are never deleted by design.
- **Observations:** (1) **Format drift between writers.** The two surviving hand-written originals use free-text `sender: relay of the user's request (interactive session in the primary checkout)`, which the module's `sender === 'operator'` rule would reject, and the skill allows `information` plus audiences the module never emits. (2) The skill says "write a sibling temporary file then rename" while the module uses link-exclusive publish; both are no-overwrite but are different mechanisms. (3) The two 2026-09-28 messages are two weeks old and still unprocessed in `04-timetable-paste-import/inbox`; the observer does not surface unprocessed inbox files at all (only the Pi checkpoint guard does), so stale holds are invisible in the dashboard.

### 12. Manual completion marker

- **Location:** `<pkg>/sentinel-completion.json` (`COMPLETION_FILE`, `manual-completion.mjs:7`).
- **Schema:** v2 `{schema_version:2, kind:'manual_completion', package, completed_at}`; v1 additionally binds `revision` (= `completion_revision`, a sha256 of dispatches+checkpoints) and is honored only while the revision matches (`manualCompletion` `:10-19`). v2 holds until a dispatch is started after `completed_at`. 6 v2 + 1 v1 on disk.
- **Purpose:** operator lifecycle override ("Mark complete") separate from acceptance/evidence.
- **Lifecycle:** written once per click: `lstat` guard, `wx` temp 0600, `realpath` re-check, `rename` (`writeManualCompletion` `:21-38`). Overwritten on repeat click. Removing the file removes the override on the next observation.
- **Writers:** `POST /api/package-completion` only (local loopback, same-origin token, `Content-Type: application/json`, ≤8 KiB body, package must be published by a current snapshot and canonical, `dashboard.mjs:163-181`). **Readers:** collector (`sentinel.mjs:651-656`; skipped if workflow/PR completion already established), `applyManualCompletions` (re-reads up to 200 packages on **every** `readDashboardState`, i.e. every `/api/state` miss and every package-file request).
- **Relationships:** `completion_basis:'manual'` suppresses merge lookup for that package (`mergeInput = … 'manual' ? null`) and maps to epic member status `complete` (not `merged`).
- **Retention:** kept forever; no expiry.
- **Observations:** (1) The dashboard overlay moves a manually-completed run from `runs` into `recently_completed` in memory only; the persisted observer envelope still lists it as a run until the next scan, so an independent reader of the JSON files sees different state than the browser. (2) v1 marker (1 on disk) is effectively dead once any dispatch or checkpoint changes `completion_revision`. (3) `applyManualCompletions` has a hard-coded 7-day window and 50-row cap duplicating `SENTINEL_LIMITS` (`manual-completion.mjs:57-59`).

### 13. Merge reconciliation record

- **Location:** `<pkg>/sentinel-merge.json`; in-memory `memory` Map (≤500 packages) in the reconciler (`merge-reconciliation.mjs:139,152`).
- **Schema** (`:132-135`, `:183-185`, `:205-206`): `{schema_version:1, package, binding(sha256 of package,pr url,branch,base,commits,receipts,checkpoints), url, branch, base, authoritative_unmerged_at|null, tip, checked_at, state: merged|unmerged|unknown, reason, local_reason?, head?, local_branch_absent?, merge_commit?, merged_at?, base_tip?, evidence_source?:'local-git'}`. `reason ∈ authoritative-pr|local-pr-merge|pr-not-merged|head-mismatch|branch-tip-unavailable|newer-dispatch-or-checkpoint|api-*|…`. Observed (52 files): merged/authoritative-pr 32, merged/local-pr-merge 9 (`evidence_source:'local-git'`), unmerged/pr-not-merged 10, unknown/api-request-failed 1.
- **Purpose:** a cache of "was this package's PR merged" evidence so completed work can be classified `merged-pr` without calling GitHub every scan; `applicableMerge` re-validates it against current receipts/checkpoints so later work reopens the package.
- **Lifecycle & frequency:** active observers only (`mergeLookup: !readOnly`). Retry rules: local miss/API failure 60 s (`MERGE_RETRY_MS`), authoritative unmerged 10 min (`MERGE_POLL_MS`); per scan ≤3 local proofs (2 s total, 750 ms each), ≤3 `gh pr view` calls (6 s total, 3.5 s each). **Persisted only when `reconcileMergeMetadata` is true, i.e. in `shadow`/`recover` modes** (`sentinel.mjs` ext `:228-250 run()`, `sentinel-reader-process.mjs:139`). In pure observe mode (what the host runs) results live in reader memory and `readJson` only validates what shadow/recover previously wrote. Measured: file mtimes 2026-10-08T22:30 → 2026-10-11T16:15:31 (last write before the observe-only host started).
- **Writers:** `persistRecord` (temp `wx` 0600 + rename; skip if identical JSON; refuses symlink/non-file). **Readers:** collector (`validateMergeCache` re-checks the local branch ref, `refs/heads/<branch>` loose or packed, and for local-git evidence the fetched `refs/remotes/origin/<base>` tip), epics, cold status (never runs commands).
- **Relationships:** git branch refs in the primary checkout (read directly, no git subprocess), GitHub PR identified by `pr-url.json.url`, receipts and checkpoints via `binding`.
- **Retention:** kept forever; a changed branch tip invalidates rather than deletes.
- **Observations:** (1) Record content depends on **who is running** (observe vs shadow/recover), so `sentinel-merge.json` is stale for any package whose PR merged while only the observe-only host was running; the host recomputes in memory every scan (extra `gh` calls) but never saves. (2) `local_reason:"local-merge-budget"` persists in a merged/authoritative record (`.specs/spec-sentinel/sentinel-merge.json`), showing the local proof was skipped on that pass. (3) Writes into `.specs` retrigger chokidar (`awaitWriteFinish:false`, `atomic:true`) and therefore another scan within seconds when persistence is on.

### 14. PR publication and work-tour records (read, not written, by the sentinel)

- **Location:** `<pkg>/pr-url.json`, `<pkg>/work-tour.json`.
- **Expected schema (reader side):** `pr-url.json` = `{package, kind:'pr_submission', commit(40–64 hex), submitted_at, draft, url(https://…)}` for ready-PR completion; `https://github.com/<o>/<r>/pull/<n>` plus valid optional `branch`/`base` refs for merge lookup (`packageCompletion` `:810-824`, `packageMergeInput` `:772-792`). `work-tour.json` = `{version 1|2, verdict ready|blocked, commit}` (`readTourEvidence` `:1047-1084`).
- **Observed schema (130 `pr-url.json`):** only 52 carry `schema_version:1` + `kind` + `submitted_at` + `package`; 95 use camelCase `submittedAt`, 5 have `draft`, 6 `isDraft`, 7 `is_draft`, 25 have `mode` (ready 17, draft 7, integrated 1); 90+ distinct keys in total (`ci`, `checks`, `mergeStateStatus`, `pull_number`, `rebaseLog`, …).
- **Observations (drift with consequences):** (1) `pr-record-invalid` is the `merge.reason` for 29 visible rows and `missing-pr-record` for 25, so more than half the visible packages cannot be merge-verified; they fall back to checkpoint/ready-PR completion. (2) The draft test is `pr.draft === true`, but the canonical writer records draft state as `mode:"draft"` (e.g. `.specs/spec-sentinel/pr-url.json`, `mode:"draft"`, no `draft` key), so a draft PR whose `commit` equals a ready tour's commit passes the ready-PR completion check. (3) `submitted_at` vs `submittedAt` vs `first_submitted_at` variants mean `validTime(pr.submitted_at)` is false for ~60 % of historical records. These are producer-side schema problems that the sentinel tolerates by returning "unknown", rather than normalizing.

### 15. Process identity records (as used by sentinel code)

- `process-identity.mjs` returns `{state:'alive',pid,started_at}`, `{state:'dead',pid}` or `{state:'unknown',pid,reason}`; only ESRCH proves dead; timeouts/EPERM/unparseable output are unknown and must never authorize signalling or reclaim (`:32-59`). It is persisted in only two places: the `owner_claims` row (§4.1) and Adjacent tmux assignment records (`assignments.mjs`, read-only here). The runtime's per-run `<pid>.json` files use a different, weaker shape (see §4.1 observation).
- **Writers:** n/a (library). **Readers:** `claimOwner`, `assignments.mjs`, workspaces reconcile/tmux.

### 16. Assignment rows (Adjacent tmux assignments, derived)

- **Source:** assignment records under `ADJACENT_STORAGE_ROOT` (default `~/Documents/adjacent-storage`; contains `projects/`, `.adjacent/state.sqlite3`, `asr-cache`), listed by `workspaces/assignments.mjs listAssignments`; observed by `workspaces/reconcile.mjs observeAssignment` with process, tmux, ps and session probes (2 s probe deadline, 4 MiB ps buffer).
- **Output schema** (`projectAssignment` `assignments.mjs:378-466`): `{assignment_id, spec_package, workflow_id, recordedState, observedState, display(live|live-unrecorded|launching|launch-unconfirmed|exited-unrecorded|terminal-lost|unknown|ended|launch-failed), unrecorded, quiet, attachedCount, hasControl:false, workersUnconfirmed, nextAction, safeAction, attention[], coverage(complete|partial), coverageReasons[]}`; `assignment_coverage` has its own `{state,reasons,omitted,bytes_read,observed_at}`. Limit `workspaceAssignments:100`.
- **Frequency:** every scan when `storageRoot` is passed (the host does; the Pi-session observer passes `resolveStorageRoot` too). Live snapshot: `assignments: []`.
- **Relationships:** joins a run row by canonicalized `spec_package` and `workflow_id` to derive `workersUnconfirmed` from `lease-*` run reasons.
- **Observations:** `hasControl:false` is hard-coded; quiet is informational (120 s). Without `storageRoot` the source is reported `assignment-storage-root-unavailable`. The storage layout itself belongs to the Adjacent area.

### 17. Dashboard HTTP API and data contracts

Server: `createDashboardServer` (`dashboard.mjs:123-242`), bound to 127.0.0.1, default port 4319; Host header must be `127.0.0.1:<port>`, `localhost:<port>` or the normalized `--public-host`; Origin must match when present; `Cache-Control: no-store`, CSP set on every response. Remote requests (non-local Host/Origin or `x-forwarded-*`, `forwarded`, `tailscale-user-login` headers) get `completion:'local-only'` and no token.

| Route | Method | Response contract | Notes |
|---|---|---|---|
| `/` , `/dashboard.html` | GET/HEAD | `dashboard.html` (165 KB, inline CSS+JS) | read from disk per request |
| `/api/state` | GET/HEAD | `{schema_version:1, generated_at, observers[envelope + source], errors[≤20 {source,message}], truncated, action_token \| completion:'local-only'}` | 1 s server cache; reads every observer file (see §2); the client polls every 5 s (`setInterval … 5000`) |
| `/api/package-completion` | POST | `{completed_at}` | writes `sentinel-completion.json` (§12); 403 unless local + token + same Origin + JSON |
| `/api/package-files?package=&cursor=` | GET | `{files[{name,size,available,reason}], truncated, next_cursor, errors, limits}` | pages of 500, ≤10,000 entries, depth 12, no symlinks (`package-files.mjs:5,29`) |
| `/api/package-file?package=&file=` and `/package-view/<b64url package>/<path>` | GET | raw bytes + `X-Package-File-Kind: image|markdown|json|html|text|download` | ≤8 MiB regular files, sandboxed CSP; package must appear in a published snapshot and be canonical (`authorizePackage` `:6-14`) |
| `/api/workspaces` | GET | `{storage: storageStatus, valid[], invalid[]…}` | Adjacent catalog |
| `/api/workspace?id=` | GET | workspace record | catalog re-listed per request |
| `/api/workspace-files`, `/api/workspace-file` | GET | like package files, excluding `.adjacent, sessions, threads, .git, .env*, node_modules, _build, deps` | `threads` reachable only via thread routes |
| `/api/workspace-designs?id=` | GET | `{designs[{slug,path,…design,screens,summary}], errors[]}` | ≤50 designs, 64 KiB per `design.json`, derived produced/captured counts (`designs.mjs:11-47`) |
| `/api/threads`, `/api/thread/{history,events,create,send,stop,resume,discard,save-brief,preview-assignment,launch-assignment}` | GET/POST | discussion-service contracts | `/api/thread/create` is what the uncommitted dashboard form calls; all thread routes refuse remote requests |

- **Data-contract notes:** the client accepts a bare snapshot, an envelope, or a `{observers,errors}` state when importing a file (limits: ≤512 observers, ≤10,000 runs, assignments ≤200, `dashboard.html:108-110`). `readDashboardState` re-reads all observer files for each package-file/view request (no cache on those paths), so opening a file in the viewer triggers an 8 MB parse. `HEAD /api/state` returns the same headers but the handler still performs the read. Error mapping is coarse: every exception becomes `503 {"error":"Dashboard data unavailable. Retry shortly."}`, hiding 4xx-class causes (unpublished package, invalid path).
- **Retention / state:** none server side apart from the 1 s cache and the in-process `actionToken` (new random 32 bytes per process, so a host restart invalidates any open tab's token until the next `/api/state`).

### 18. CLI and Pi-facing outputs (not persisted)

- `cli.mjs list|runs|report|metrics|sentinel status|sentinel inspect` print JSON/text to stdout (`cli.mjs:1-125`). `metrics` returns `{schema_version:1, measured_at, package, scope, coordinator_sessions, startup, process, totals, leaders, mercury, agents[], steps[], coverage, discovery_errors, limits[]}` (`metrics.mjs:280-300`); it writes nothing, so "snapshot file for later comparison" exists only if the operator redirects output. It reads Pi session JSONL transcripts (64 MiB per file cap) and managed runtime events (first 4 MiB).
- **Drift:** `cli.mjs` implements `sentinel inspect FULL-UUID` and `--all`; the README's "Workspace sentinel status" section documents `sentinel status` only.

### 19. Epic records (read-only input, derived output)

- **Location / schema:** `<primary>/.specs/_epics/<slug>/epic.json` ≤64 KiB, ≤50 epics per `.specs`, ≤100 packages per epic. `{schema_version:1, epic(slug), title, state: planned|active|complete|abandoned, plan?, created_at?, note?, designs[≤20 {workspace,design,path?}], packages[{package, repository?, requires[], note?}]}` (`parseEpic` `epics.mjs:17-64`). 7 records on disk (adj, super, workspace in `~/.agents` and `adjacent`; home, data, pages in `warbler_ux`; ai in `gtfs-planner`).
- **Derived:** member status `unobserved|missing|merged|complete|published|unknown|in-progress|prepared|proposed` computed from package facts at read time (`deriveMemberStatus`), plus `next`, `waiting_on`, `summary`, per-epic `coverage`; emitted as `snapshot.epics` (32 KB live) and `run.epic`.
- **Writers:** operator and the epic-end-to-end skill; the sentinel never writes. **Readers:** sentinel, dashboard Epics view, `cli` text output.
- **Observations:** the stored `state` is hand-maintained and disagrees with derived status: epic `ai` has `state:"complete"` while all 11 members are `prepared` (0 landed); epic `super` is `active` with 3/3 members `merged`; `home` is `complete` with 3 merged + 1 manual-complete. Because member status never lands from `epic.state`, dashboards that surface `state` next to the derived counts will show contradictory pairs. The `_`-prefixed folder convention (`_epics`, `_plans`) is enforced in two places (`sentinel.mjs:573` and `epics.mjs`).

### 20. Specs for the sentinel (design artifacts, not runtime data)

- `.specs/spec-sentinel/` — the shipped sentinel package: `spec.md` (81 KB), 8 step sub-specs, `evidence-plan.json`, `history-index.json`, `merge-evidence.{json,md}`, `work-tour.{html,json}`, `pr-url.json` (PR #11, draft), `sentinel-merge.json` (merged 2026-10-07T15:23:43Z, checked 2026-10-10T21:10Z), 5 `learnings/`, 20 `reviews/`, `runtime/` with 11 assignment files and 1,698 `runs/` entries (activity dirs, process dirs, `.jsonl` sessions, `.result.txt`, 14 command logs per run). Empty `inbox/` and `processed/`.
- `.specs/sentinel-background-indexing/` — **design only, not implemented**. It specifies a SQLite table in the repo-search state store for background-refresh requests, a Node `background.mjs` scheduler and boundary producers in `Runtime.finish` and `skills/spec-branch-fix`; no code or runtime directory exists for it (no matches in `scripts/` or `pi/`), and the package has no `runtime/`. Treat it as a proposed future data structure, not a current one.

### 21. Change frequency of the code itself

- 69 commits touch `scripts/spec-observe` or `pi/extensions/spec-runtime/sentinel*.mjs`; per-day counts since the first commit on 2026-10-06: 17 (10-06), 3 (10-07), 5 (10-08), 17 (10-10), 24 (10-11). Schemas introduced during that window and still carrying legacy readers: `manual_completion` v1→v2 (`manual-completion.mjs:16-17`), `work-tour.json` versions 1 and 2 accepted (`sentinel.mjs:1054`), `activity` numeric vs ISO `last_activity`, `pr_submission` loose records.

### 22. Cross-cutting observations

**Source of truth vs derived**
- Source of truth: receipts, checkpoints, incident files, `pr-url.json`, `work-tour.json`, `spec-steps.json`, epic records, enrollment/discovery config, assignment records. The sentinel's snapshot, conditions, epic member status, completion basis and assignment display are all derived and recomputable.
- Two derived values are **cached as files inside the source package**: `sentinel-merge.json` (derived from GitHub + git refs) and the grant/activation records (derived from an operator command). The merge cache is revalidated against live refs on every read; grants are not read by the observer.
- `sentinel-completion.json` is an operator decision, i.e. genuine source data placed under a "sentinel-" name; `docs/spec-epics.md` already lists it alongside lifecycle sources.

**Staleness, races and failure modes**
1. *Stale `observing` envelopes* (orphan `977d5ad5`) and *stale `revoked:false` grants* (7) are the two forms of crash residue; both need liveness checks that the data itself cannot provide (no heartbeat from a dead process).
2. *Concurrent observers:* Pi sessions and the host each publish independently; only the host takes the SQLite claim. The dashboard resolves duplicates per workspace by freshness rank, so two live observers can both run `gh` merge lookups and (in shadow/recover) both rewrite `sentinel-merge.json` (atomic rename, last writer wins, no merge conflict logic).
3. *Watcher feedback:* chokidar watches the whole `.specs` tree (including `runtime/runs/*.jsonl` growth and the sentinel's own `sentinel-merge.json` writes) with `awaitWriteFinish:false`; active runs therefore keep the 250 ms/1 s invalidation path busy and add extra scans beyond the 15 s schedule.
4. *Read budget races:* package floors are reserved up front (`budget.reserve(facts.size)`) but the order of packages is hash-map insertion order, so under pressure later packages get coverage `read-budget` while earlier ones read fully; the live scan used 11.07 MB of 16.78 MB.
5. *Reader timeout vs README budgets:* see §4.2.
6. *Heartbeat semantics:* `published_at` advances on every publish including failures; `snapshot.coverage.observed_at` does not advance when a scan fails, so freshness must use `observed_at`, which the README states and the dashboard uses.

**Docs vs code drift (consolidated)**
- User premise on `sentinel.mjs` edits (§0).
- `SKILL.md` command list incomplete (`enable|disable|root|add` omitted); `enable <policy-file>` documented as the arming path but unused in practice (§10).
- README documents only `sentinel status`; CLI also has `inspect` and `--all` (§18).
- README: discovery "cached five minutes" is true only while the reader child survives; it is killed on every timeout (§4.2).
- `docs/spec-runtime-observation.md` lists `runtime/progress.json`, `runtime/stages/`, `runs/<id>-editor-configuration.json`; they exist in `warbler_ux` packages (31 each) but not in the older `.agents` packages, and `docs` does not mention `runtime/assignments/` (11 files in `spec-sentinel`) or `runs/<id>-processes/`.
- Overseer-inbox protocol (kinds/audiences/senders) is broader than the only code that writes it (§11).

**Retention / cleanup summary:** no cleanup exists for observer envelopes (8.4 MB, 21 files), run index pointers (823; 46 dangling), grant/activation receipts (54/120), shadow observations (98), checkpoints, completed packages' `runtime/` trees, or enrollment records. Estimated growth: ~3–4 observer files/day (≈0.8 MB each) plus ~100–200 index pointers/day; the dashboard server's 12 MiB state ceiling will start dropping envelopes first (about 15 live-observer files), and the 1000-pointer index cap is about 1–2 days away at the current dispatch rate.

**Highest-value follow-ups for the audit consumer (observations, not changes made):**
1. Prune closed/orphan observer envelopes or exclude them from `/api/state` (8.5 MB per poll today).
2. Garbage-collect or ignore dangling run-index pointers so they stop consuming the 50-reason budget and the 1000-candidate cap.
3. Normalize `pr-url.json` at the writer (or add a tolerant reader) so `mode:"draft"`, camelCase timestamps and missing `kind` stop producing `pr-record-invalid` and a draft/ready false positive.
4. Decide whether merge reconciliation should persist in observe mode, or stop calling it a cache that only shadow/recover populates.
5. Resolve the 10 s reader timeout versus 8 s merge budget + discovery + file reads, since every kill resets discovery and merge caches.


---

## Pi runtime, Jev, and benchmark data

Audit date 2026-10-11. Read-only. Secret-bearing files (`auth.json`, `ifm-api-key.txt`, `models.json`, `pi-typesafe/auth.json`) were inspected by key names and value classification only; no values are reproduced here.

### Overview

Three storage zones cover this area.

1. **Tracked source in `~/.agents`** (git): `pi/agents/*.md` (8 profiles), `pi/extensions/spec-runtime/**` (42 tracked files, 38 commits since 2026-10-06), `scripts/jev/**` (3 commits), `scenarios/**` and `scripts/spec-gym` (all created 2026-10-10, 1 commit for scenarios). `sync.sh:91-105` symlinks the profiles and the extension into `~/.pi/agent/`. Nothing else here is written by `sync.sh`.
2. **Untracked runtime data in `~/.pi/agent`** (not git; 5.5 GB total). Written by Pi core, by third-party Pi packages (`pi-subagents`, `pi-warden`, `pi-typesafe`, `pi-intercom`), by the spec-runtime extension (a small cross-package index only), and by the operator.
3. **Untracked runtime data inside each repository's `.specs/<feature>/runtime/`** (git-ignored, e.g. `adjacent/.gitignore:47 /.specs/`). The spec-runtime extension writes the bulk of its durable state here, not in `~/.pi`. Across the 68 packages that still have a `runtime/` directory this is about 19.5 GB (largest single package 1.1 GB).

Jev keeps its own untracked state in `scripts/jev/state/` (git-ignored via `scripts/jev/.gitignore`). The same Jev core is called three ways: CLI, stdio MCP server (`mcp.mjs`, registered in `~/.claude.json` and `~/.codex/config.toml`, not by `sync.sh`), and in-process from the Pi extension (`runtime.mjs:10` imports `scripts/jev/core.mjs`).

Spec-gym scenarios are scaffolding only. Both scenario indexes are empty tables and no gym run has ever been recorded (`tmp/spec-gym/` does not exist).

### Summary table

| Structure | Path | Format | Writer | Reader | Change frequency |
|---|---|---|---|---|---|
| Pi agent profiles | `~/.agents/pi/agents/*.md` (symlinked to `~/.pi/agent/agents/`) | Markdown + YAML frontmatter, git | Operator / spec workflow edits | pi-subagents, spec-runtime children | 13 commits in 6 days |
| spec-runtime extension source | `~/.agents/pi/extensions/spec-runtime/` (symlinked to `~/.pi/agent/extensions/spec-runtime`) | ESM + `index.ts`, git | Operator | Pi | 38 commits in 6 days |
| spec-runtime config | `~/.pi/agent/spec-runtime.json` | JSON object, `child_extensions[]` | Operator | `index.ts:708` | Static since 2026-10-05 |
| Cross-package run index | `~/.pi/agent/spec-runtime/<run-uuid>.json` | JSON, 4 keys | `runtime.mjs:316-317` | discovery, metrics | 823 files, ~130/day |
| Run receipt and lease | `<pkg>/runtime/{run.json,runs/<id>.json,assignments/*.json}`, `<repo .git>/spec-runtime.lock/lease.json`, `<pkg>/runtime/package.lock/` | JSON, `schema_version: 1` | `runtime.mjs` | runtime, monitor, sentinel, metrics | Per dispatch |
| Event log | `<pkg>/runtime/events.jsonl` | JSONL `{timestamp,event,run_id,...}` | `runtime.mjs:37-39` | sentinel, process-improvement | Per run event |
| Raw worker streams and logs | `<pkg>/runtime/runs/<id>-{owner,editor}-<uuid>.jsonl`, `-command-<uuid>.log`, `-server-*.log`, `.result.txt` | Pi JSON stream, plain text | `runtime.mjs:197-235, 530-601` | metrics, monitor (64 KiB tail) | Per worker turn |
| Retained worker sessions | `<pkg>/runtime/sessions/<pair-hash>/{owner,editor}.jsonl` | Native Pi session JSONL | Pi child processes | Pi (`--session`) | Per assignment |
| Activity and process registries | `<pkg>/runtime/runs/<id>-activity/{owner,editor}.json`, `<id>-processes/<pid>.json` | JSON | `monitor.mjs`, `runtime.mjs:70` | monitor widget, cancel | Seconds, during runs |
| Completion handoff and verification receipts | `<pkg>/runtime/runs/<id>-completion.json`, `<id>-verification.json`, `<id>-verification-<uuid>.md`, `<pkg>/learnings/step-NNN-learning.md` | JSON v1, Markdown | `completion.mjs` | coordinator, work tour, history-index | Per step |
| Progress ledger, stage receipts, history index | `<pkg>/runtime/progress.json`, `<pkg>/runtime/stages/<stage>.json`, `<pkg>/history-index.json` | JSON v1 | `completion.mjs:187, 271, 178` | coordinator, spec-run | Per checkpoint |
| Sentinel workflow state (per package) | `<pkg>/runtime/sentinel/<workflow-id>/{checkpoint.json,verification-incidents.json,authority/,diagnoses/,intents/}` | JSON v1 | `sentinel.mjs`, `index.ts:284` | sentinel observer and dashboard | Per checkpoint (82 dirs exist) |
| Sentinel observer snapshots | `~/.pi/agent/spec-sentinel/<workspace-key>/observers/<observer-id>.json` | JSON envelope `schema_version: 1` | `sentinel-snapshot.mjs:10-31` | dashboard, spec-observe, other tools | Every refresh (15 s) while observing |
| Sentinel host ownership claim | `~/.pi/agent/spec-sentinel/coordination.sqlite` | SQLite, table `owner_claims` | `sentinel-host-owner.mjs:41` | sentinel host | On host start/stop |
| Pi sessions | `~/.pi/agent/sessions/--<cwd-slug>--/*.jsonl` and nested | JSONL, session header `version: 3` | Pi core | Pi, metrics, process-improvement, workspaces | Per session; 4.9 GB, 7,927 files |
| Subagent artifacts | `~/.pi/agent/sessions/--<cwd-slug>--/subagent-artifacts/<runId>_<agent>_{input.md,output.md,meta.json,transcript.jsonl}` | MD, JSON, JSONL | pi-subagents | reviewers, missions | Per subagent run |
| Run history | `~/.pi/agent/run-history.jsonl` | JSONL, 7 keys | pi-subagents | pi-subagents | 1,667 rows since 2026-09-26 |
| Missions | `~/.pi/agent/missions/{projects/<hash>/<id>.json,index/<hash>.json}` | JSON `schemaVersion: 1` | pi-subagents | pi-subagents | 2,644 records each |
| Settings | `~/.pi/agent/settings.json` (+2 `.bak-*`) | JSON | Pi core, operator | Pi | Last edit 2026-10-07 |
| Provider config | `~/.pi/agent/models.json` (+10 `.bak*`) | JSON (contains one literal key) | Operator / scripts | Pi | 11 edits in 9 days |
| Model catalog cache | `~/.pi/agent/models-store.json` | JSON, per provider `{models[],checkedAt,etag,lastModified}` | Pi core (`@earendil-works/pi-coding-agent/dist/core/models-store.js`) | Pi | Refreshed repeatedly (747 KB) |
| Credentials | `~/.pi/agent/auth.json` (+`.bak`), `ifm-api-key.txt`, `pi-typesafe/auth.json` | JSON / text, mode 0600 | Pi login, operator | Pi, `ifm-provider.ts`, Jev via pi-typesafe | On login |
| Trust store | `~/.pi/agent/trust.json` | JSON array of 2 project paths | Pi core | Pi | Static since 2026-09-23 |
| pi-warden state | `~/.pi/agent/pi-warden/{holds.db,holds/,rules/,prefs/,loops/,steer-stats.json,config.json}` | SQLite + JSONL + JSON | pi-warden | pi-warden | Continuous (543 MB) |
| pi-typesafe usage | `~/.pi/agent/pi-typesafe/{usage.json,auth-state.json}` | JSON | pi-typesafe | pi-typesafe | Continuous |
| Intercom | `~/.pi/agent/intercom/{broker.pid,broker.sock,pending-asks/,extension-state/}` | PID, UNIX socket, empty dirs | pi-intercom | spec-runtime communication | Per broker start |
| Provider extension and subagent config | `~/.pi/agent/extensions/{ifm-provider.ts,subagent/config.json}` | TS, JSON | Operator | Pi | Static since 2026-09-28/10-01 |
| Removed goal extension archive | `~/.pi/agent/pi-goal-x-removed-20261007-234755/` | `*-goals/` dirs + `*-snapshot.json` | Operator rename | none | Frozen 2026-10-07 |
| Jev decision ledger | `~/.agents/scripts/jev/state/decisions.jsonl[.previous]` | JSONL v1, git-ignored | `core.mjs:363-382` | `report.mjs` | 1,204 rows in 7 days |
| Jev usage ledger | `~/.agents/scripts/jev/state/usage.json` | JSON `{version,days{}}` | pi-typesafe library via `core.mjs:269,325` | pi-typesafe (cap enforcement) | Daily |
| Jev config backup | `~/.agents/tmp/jev-config-backup-20261004-184818/` | copy of `claude.json` + codex `config.toml` | Operator (one-off) | none | Frozen 2026-10-04 |
| Spec-gym scenarios | `~/.agents/scenarios/<skill>/scenarios.md` | Generated Markdown index, git | `spec-gym validate --write-index` / `extract` | spec-gym | Created once 2026-10-10; empty |
| Spec-gym run output (not yet existing) | `~/.agents/tmp/spec-gym/<run-id>/{manifest.json,run.json,report.md,<cell>/...}` | JSON v1 + Markdown, git-ignored | `runner.mjs:85-108, 184` | operator | No runs yet |

---

### 1. Pi agent profiles

**Location**: `/Users/ryanmahoney/.agents/pi/agents/{spec-clerk,spec-final-editor,spec-final-reviewer,spec-sentinel-diagnostician,spec-stage-reviewer,spec-step-editor,spec-step-fixer,spec-step-owner}.md`, git-tracked. `sync.sh:92` creates per-file symlinks in `~/.pi/agent/agents/`.

**Format and schema**: Markdown with a YAML frontmatter block, then the system-prompt body. Observed frontmatter keys: `name`, `description`, `model` (only `spec-clerk` and `spec-step-editor`, both `openrouter/inception/mercury-2.5:high`), `systemPromptMode: append`, `inheritProjectContext`, `inheritSkills` (false everywhere), `allowNestedSubagents` (clerk, diagnostician false; final-reviewer and stage-reviewer true), `allowedAgents` (final-reviewer: `spec-final-editor`; stage-reviewer: `scout`), `tools` (comma list; owner gets `spec_editor, spec_answer, spec_verify, spec_scout, spec_advice`; editor gets `spec_question`; diagnostician has an empty `tools:`), and `subagentOnlyExtensions` (only `spec-final-editor`, one absolute path). There is no schema file or validator in the repo; `scripts/lint-skills.sh` covers skills, not these profiles.

**Purpose**: Role definitions the spec workflow dispatches through pi-subagents and the spec-runtime child launcher.

**Lifecycle and change frequency**: 13 commits between 2026-10-05 and 2026-10-11. `spec-final-editor.md` was added in `070b42a` (2026-10-10) and changed in `12e8485` (2026-10-11, "load the Codex compat adapter in the final-editor child"). At audit time the working tree is clean for `pi/`; the brief's "uncommitted diff" on `spec-final-editor.md` has since been committed.

**Writers**: Operator and spec workflow edits. **Readers**: pi-subagents (profile discovery from `~/.pi/agent/agents/`), spec-runtime for `spec-step-owner` and `spec-step-editor` (README "Owner/editor profile instructions are in `pi/agents/`"), `scripts/spec-gym` (hashes them into `managed_sha256`, `skills/spec-gym/SKILL.md`).

**Relationships**: Names must match the `agent` values in `run-history.jsonl` and in subagent-artifact filenames. `allowedAgents` is a cross-reference to another profile or to the installed `scout` profile, which is defined in `settings.json` `subagents.agentOverrides.scout`, not in this directory.

**Retention / cleanup**: Unbounded, small.

**Observations**:
- Drift: `run-history.jsonl` and session artifacts show agents with no profile here: `spec-step-implementer` (211 runs, 36 artifact sets), `delegate` (140), `worker` (375), `provisioning-review` (18), `spec-step-run` (14). `git log` finds no history for `spec-step-implementer.md`. These are either pi-subagents built-ins or removed profiles; the repo does not say which.
- The absolute `subagentOnlyExtensions` path in `spec-final-editor.md` pins the profile to one machine's `~/.pi/agent/npm/node_modules` layout (`/Users/ryanmahoney/...`).
- Profiles hold no machine-readable role contract (tools, extension needs) beyond free-form frontmatter; runtime.mjs hardcodes the owner/editor tool lists separately (`index.ts:123-183` registers tools by role), so the two can drift.

---

### 2. spec-runtime configuration: `~/.pi/agent/spec-runtime.json`

**Location**: untracked, mode 0600. 201 bytes.

**Format and schema**: `{"child_extensions": ["<abs path to provider-compat index.ts>", "<abs path to pi-intercom index.ts>"]}`. Read at `index.ts:708-711`. The same read honours `config.scout_model`, which the README never documents and the file does not set.

**Purpose**: Default extension list loaded into owner/editor child processes (children disable extension discovery).

**Lifecycle**: Last written 2026-10-05. The call-level `child_extensions` replaces it. The list is part of the assignment launch contract (`runtime.mjs:~279`), so editing it changes the contract hash for new assignments and the retained session key (`runtime.mjs:~301`).

**Writers**: Operator. **Readers**: `index.ts` at dispatch time only.

**Relationships**: Both referenced files exist under `~/.pi/agent/npm/node_modules/` (checked).

**Retention**: n/a.

**Observations**: Absolute, machine-specific, not in git, no backup. Loss of the file silently changes children to zero extensions (the code falls back to `{}`), which then fails intercom dependent tools at run time instead of at load.

---

### 3. Cross-package run index: `~/.pi/agent/spec-runtime/<run-uuid>.json`

**Location**: `/Users/ryanmahoney/.pi/agent/spec-runtime/`, 823 files, 3.2 MB, mode 0600, untracked.

**Format and schema** (`runtime.mjs:316-317`): `{run_id, package, manifest, parent_session}`. `parent_session` is absent from 47 of 823 files (older runs). Written with `atomic()` (`runtime.mjs:19-24`: temp file plus rename, mode 0600).

**Purpose**: A flat directory that maps a run id to its package, manifest path and the coordinator's Pi session file, so tools can find runs without walking repositories. README: "indexes each manifest and parent session for future discovery".

**Lifecycle and change frequency**: One file per dispatch, written at start, never updated or removed. Oldest mtime 2026-10-05, newest 2026-10-11 13:03 (about 130 per day). 114 distinct packages are referenced.

**Writers**: `Runtime.start` only. **Readers**: sentinel run index (README "managed run index"), `spec-process-improvement`, metrics.

**Relationships**: Links Pi session file (`parent_session`) to spec package (`package`) to run manifest in the package's `runtime/runs/`. This is the only join key between `~/.pi/agent/sessions/` and `.specs`.

**Retention / cleanup**: None. Stale pointers have already accumulated: 46 of 114 package paths no longer exist on disk and 49 of 823 manifest paths are missing (removed worktrees or deleted specs). Nothing prunes them.

**Observations**: Absolute paths only, so the index is unusable after a repo move. No `schema_version`. Consumers must tolerate dangling entries.

---

### 4. Per-package runtime tree: `<package>/runtime/`

**Location**: `<repo>/.specs/<feature>/runtime/`, git-ignored (`.gitignore:47 /.specs/` in `adjacent`; each repo owns its ignore rule). Primary-checkout path only (canonical package rule, `README.md` dispatch contract). The checkout's own `.git/spec-runtime.lock/` (`runtime.mjs:169`) holds the code-writer lease and `runtime/package.lock/` holds the package-writer lease; both contain `lease.json` `{id, token, package, revoked}` (`runtime.mjs:312-313`).

**Format and schema**: Observed on `adjacent/.specs/15-audio-transcription/runtime` (50 runs, 1,332 files, 257 MB):

- `runs/<id>.json` and `run.json` (latest copy): the run record, `schema_version: 1`, `completion_contract: 1`, fields `id, assignment_id, workflow_id, package, primary, step, checkout, owner_model, editor_model, scout_model, dispatch_requested_at, routing_reason, attempt_kind, session_scope, environment, child_extensions, owner_session, editor_session, parent_session, lock, package_lock, token, state (running|completed|failed|cancelled|cancelling|blocked), started_at, finished_at, pid, timeout_ms, result, result_truncated, full_result_path, handoff, error` (`runtime.mjs:305-311`, `save()` at `:35`). The `token` is the lease capability and is stored in cleartext in the receipt.
- `assignments/<sha256(assignment_id)>.json`: `{assignment_id, run_id, contract}` where `contract` is a JSON string of `[step, checkout, owner_model, editor_model, scout_model, child_extensions, instructions, (attempt_kind/session_scope), (workflow_id)]` (`runtime.mjs:276-283, 316`). Enforces idempotent re-dispatch and rejects an ID reused with a changed contract.
- `events.jsonl`: `{timestamp, event, run_id, ...detail}` (`runtime.mjs:37-39`); 515 lines in the sample.
- `runs/<id>-owner-<uuid>.jsonl` / `-editor-<uuid>.jsonl` (+ `.result.txt`), `-command-<uuid>.log`, `-server-<uuid>.log`, `<id>-activity/{owner,editor}.json` (`{run_id, role, started_at, last_activity, phase, activity, hint, error}`, `monitor.mjs:51`), `<id>-processes/<pid>.json` (`{role, pid, active, started_at, finished_at}`), `<id>-editor-configuration.json`.
- `<id>-completion.json` (`{version:1, run_id, submitted_at, decisions, gaps, findings, learning{version:2, kind:"step", step, outcome, commit, verification{commands[], strategy, fix_attempts}, evidence[]}}`, `completion.mjs:150-151`) and `<id>-verification.json` (`{version:1, run_id, receipts[{id, command, exit_code, outcome, before, after, observed_at, artifact, error}]}`, `completion.mjs:53`), plus `<id>-verification-<uuid>.md` human summaries.
- `progress.json`: `{version:1, observed_at, purpose:"Runtime facts, not acceptance or publication authority", runs[], stages[], artifacts[]}` (`completion.mjs:187`), regenerated from records.
- `stages/<stage>.json`: `{version:1, package, stage, status, next, decisions[], artifacts[], recorded_at, source}` (`completion.mjs:271`, written by `spec_checkpoint`).
- `sessions/<pair-hash>/{owner,editor}.jsonl`: native Pi session files keyed by `sha256([checkout, owner_model, editor_model, child_extensions(, step)])[0:16]` (`runtime.mjs:302`).
- `sentinel/<workflow-id>/`: see section 6.

Outside `runtime/` the extension also writes into the package: `learnings/step-NNN-learning.md` (from `spec_complete`) and `history-index.json` (`completion.mjs:177-178`, built by `skills/spec-run/scripts/build-history-index.mjs`; v1 `{purpose, records[]}`).

**Purpose**: Durable receipt, lease, evidence and diagnostic store for one managed implementation run of a spec package. README states "Records stay in the canonical package".

**Lifecycle and change frequency**: Active while a step runs; `events.jsonl` and `runs/` append for every attempt. Heavy: the sample package has 50 runs for ~6 steps (about 8 attempts per step). Receipts are never rewritten after a terminal state except `progress.json`, `run.json` and `history-index.json`.

**Writers**: `runtime.mjs`, `completion.mjs`, `monitor.mjs`, `final-checkpoint.mjs`, sentinel code, and child Pi processes (session files). **Readers**: coordinator, sentinel observer (reads `run.json`, receipts, events), spec-observe CLI/dashboard, `/spec-metrics`, `spec-process-improvement`, `spec-work-tour`, spec-gym (writes its own `gym.json` run via the same runtime).

**Relationships**: `package` ties to `.specs/<feature>/spec-steps.json` and `step-NNN-subspec.md`; `workflow_id` ties to sentinel checkpoints; `parent_session` ties to `~/.pi/agent/sessions`; `assignment_id` ties to the gym cell id (`runner.mjs:~320`).

**Retention / cleanup**: None implemented. README: runtime never deletes records; stale lock directories require manual reconciliation. Measured footprint (68 packages with a `runtime/` directory): about 19.5 GB; top five: `warbler_ux/p09-operator-reports` 1.1 GB, `p08-speed-map` 874 MB, `p03-playback` 857 MB, `warbler/performance-query-layer` 782 MB, `warbler_ux/p07-run-times` 668 MB. In `p09`, 1.06 GB of 1.06 GB is `runs/`, where single owner stream files reach 52, 66 and 100 MB.

**Observations**:
- The raw owner streams are the dominant cost and are only needed "for concrete failures" (README). A size cap, compression, or age-based pruning of `runs/*-owner-*.jsonl` would remove most of the 19.5 GB without affecting receipts.
- Receipts contain the lease `token`, absolute checkout paths and user home paths; README warns they are local-only.
- Record sizes and shapes are versioned inconsistently: run record `schema_version`, other files `version`; learning is `version: 2` inside submission `version: 1`.
- Abrupt coordinator loss leaves `package.lock/` and `.git/spec-runtime.lock/` (by design, manual recovery).
- Because `.specs/` is git-ignored per repository, an unignored repo would commit run streams. The ignore rule is not enforced by this repo.

---

### 5. Structured messages and session entries from the extension

**Location**: inside Pi session files (`~/.pi/agent/sessions/**/*.jsonl`) and over the intercom broker; not separate files.

**Format and schema**:
- `pi.sendMessage({customType:'spec-runtime', content: JSON.stringify(summary), display:true}, {triggerTurn:true})` (`index.ts:506, 510`): completion/failure notices carrying `summary(record)` (`runtime.mjs:~52-62`: `run_id, assignment_id, workflow_id, attempt_kind, session_scope, state, package, step, checkout, owner_session, editor_session, ledger, run_receipt, events, owner_model, editor_model, routing_reason, environment, handoff, progress, result*, error, next`). The payload is a JSON string inside `content`, not a typed object.
- `customType:'spec-sentinel'` visible message for bounded continuation (`index.ts:600-602`; README "Bounded continuation").
- Pi custom entries: `spec-progress-binding {package}` (`completion.mjs:286`) and `spec-progress-input {observed_at}` (`completion.mjs:291`), restored on session resume (`completion.mjs:298-299`).
- Tool schemas via TypeBox: `spec_dispatch`, `spec_editor`, `spec_answer`, `spec_question`, `spec_verify`, `spec_scout`, `spec_advice`, `spec_complete`, `spec_checkpoint`, `spec_sentinel_checkpoint`, `sentinel_lifecycle`, managed `bash` (`index.ts:123-323, 660`).
- Commands: `/spec-metrics`, `/spec-monitor`, `/sentinel` and alias `/spec-sentinel`.

**Purpose**: Deliver completion events to the coordinator and carry coordinator bindings across session restarts.

**Lifecycle**: Per event, persisted only as part of the session transcript. Counts in sampled sessions: `subagent-notify` 330, `spec-runtime` 266, `pi-goal-event` 91, `spec-progress-input` 67, `pi-warden-steer` 45.

**Writers**: extension, pi-subagents, pi-warden, pi-intercom, the removed goal extension. **Readers**: Pi (resume), `spec-process-improvement`, metrics.

**Relationships**: `spec-runtime` messages are the only record in the session transcript of a run's outcome; the full receipt is in the package.

**Observations**: Stringified JSON in `content` means consumers must `JSON.parse` a string field and there is no `version` on it. The `pi-goal-event` messages come from an extension that was removed on 2026-10-07 (see section 16); old transcripts still carry them.

---

### 6. Sentinel workflow state inside a package: `<pkg>/runtime/sentinel/<workflow-id>/`

**Location**: 82 such directories across repositories. `workflow-id` is constrained to `^[A-Za-z0-9_-]{1,128}$` (`runtime.mjs:~265`).

**Format and schema**: `checkpoint.json` v1 with keys `workflow_id, package, checkout, coordinator_session, state, obligation, obligation_revision, input_revision, inbox, inbox_guard, observed_at, revision, version, workers`. Also `verification-incidents.json`, `authority/grant.json`, `authority/activations/<id>.json`, `diagnoses/<incident-id>.json`, `intents/<id>.json`, `effect-slots/`, `diagnostic-slots/` (README "Diagnosis and guarded cancellation"), and the dashboard's `sentinel-merge.json` lifecycle record.

**Purpose**: Durable workflow checkpoint, recovery authority and incident records for the sentinel observer and its shadow/recover modes.

**Lifecycle and change frequency**: Written by `spec_sentinel_checkpoint` (`index.ts:284`) and, when `spec_checkpoint` records publication complete, a closing checkpoint with obligation `publication-complete`. Slots implement per-obligation and per-workflow budgets (two diagnoses, two actual effects).

**Writers**: `sentinel.mjs`, `index.ts`. **Readers**: sentinel observer and dashboard; spec-observe CLI.

**Relationships**: `workers[]` entries must resolve to `runtime/runs/*.json` by run id or assignment id; `coordinator_session` points into `~/.pi/agent/sessions`.

**Retention**: Same as the runtime tree: never deleted.

**Observations**: Detailed sentinel semantics are covered by the sentinel audit; flagged here only because it lives under the extension's tree.

---

### 7. Sentinel observer snapshots: `~/.pi/agent/spec-sentinel/<workspace-key>/observers/<observer-id>.json`

**Location**: `/Users/ryanmahoney/.pi/agent/spec-sentinel/183e59be.../observers/`, 22 files, 8.4 MB, mode 0600. `workspace-key` is a sha256 of agent dir plus intercom scope.

**Format and schema** (`sentinel-snapshot.mjs:10-31`): envelope `{schema_version:1, observer_id, pid, published_at, sequence, refresh_interval_ms, state (observing|off|closed), mode (observe|shadow|recover), note, snapshot}`. `snapshot` keys: `version, workspace, roots, discovery, spec_roots, coverage, assignment_coverage, assignments, runs, epics, activity_filter, completion_history, recently_completed, reader`. The latest file is 813 KB and sequence 84; individual files range from 8 KB to 813 KB.

**Purpose**: Atomic, owner-readable status export for the dashboard and other tools; never recovery authority (README "Recent activity and public sentinel snapshots").

**Lifecycle and change frequency**: One file per observer invocation, rewritten each refresh (about every 15 s). Active files updated within minutes; 22 files span 2026-10-07 to 2026-10-11.

**Writers**: `sentinel-snapshot.mjs`. **Readers**: sentinel dashboard, `scripts/spec-observe`, skills/spec-sentinel.

**Relationships**: Duplicates data from `runtime/run.json`, checkpoints and the managed run index; it is a derived cache.

**Retention / cleanup**: None. `sentinel-snapshot.mjs` unlinks only its temp files; nothing removes old observer files. A crashed observer never marks its file closed (README says consumers must check `published_at`). Growth is about one 100 to 800 KB file per observer session.

**Observations**: The snapshot's own `version` field is null in the latest file while the envelope has `schema_version: 1`, so snapshot schema versioning is not effective. A snapshot of this size rewritten every 15 s per observer is the largest steady writer in `~/.pi/agent/spec-sentinel`.

---

### 8. Sentinel host ownership: `~/.pi/agent/spec-sentinel/coordination.sqlite`

**Location**: 12 KB, mode 0600.

**Format and schema**: SQLite STRICT table `owner_claims(key TEXT PRIMARY KEY, pid INTEGER, started_at TEXT, token TEXT)`. One live row: `sentinel-host`, pid 77259, started 2026-10-11 12:50.

**Purpose**: Single-owner claim so only one observe-only host process runs (`sentinel-host-owner.mjs:41`, `HOST_OWNER_KEY`).

**Lifecycle**: Claim inserted on host start, removed on bounded shutdown; stale claims are reclaimed by PID check. File updated 2026-10-11 12:50.

**Writers/readers**: `sentinel-host.mjs` / `sentinel-host-owner.mjs`. **Relationships**: independent of per-package checkpoints.

**Retention**: single row. **Observations**: A SQLite database for one row is deliberate (atomic claim) but is the only SQLite file the extension owns; the PID in the row is a liveness hint only, matching README's "never treat a persisted PID as ownership".

---

### 9. Pi sessions: `~/.pi/agent/sessions/`

**Location and naming**: `~/.pi/agent/sessions/--<cwd path with / replaced by ->--/<ISO-timestamp-with-dashes>_<uuid-v7>.jsonl`. 248 project directories. Not git, not synced.

**Format and schema**: JSONL tree. Line 1 is the header `{type:"session", version:3, id, timestamp, cwd}`. Subsequent entries carry `{type, id (8 hex), parentId, timestamp, ...}`; the parent link makes the conversation a tree. Entry types seen: `message` (roles `user`, `assistant`, `toolResult`, `system`), `custom_message`, `custom`, `model_change`, `thinking_level_change`. A 312 KB, 95-entry current session had 77 messages and 8 custom entries.

**Purpose**: Pi's own conversation store; also the source for `/spec-metrics`, `spec-process-improvement`, and workspace discussion routes.

**Lifecycle and change frequency**: One file per Pi session plus nested trees for subagents. Measured: 7,927 files; 4,873 `.jsonl` of which 708 are top-level session files, 3,153 are nested `<session>/<child-uuid>/run-N/session.jsonl` subagent sessions, and 1,012 are `*_transcript.jsonl` artifacts. 2,034 `.md` and 1,009 `.json` are subagent artifacts. 5,142 files modified in the last 7 days. 179 of the 708 top-level sessions started since 2026-10-04. Top-level files run up to 13 MB (`gtfs-planner`, 2026-09-28 and 09-30).

Size by project: `gtfs-planner` 2.7 GB, `warbler_ux` 1.1 GB, `adjacent` 393 MB, `.agents` 268 MB, `warbler` 190 MB, `rearrange-writer` 115 MB.

**Writers**: Pi core and child Pi processes. **Readers**: Pi (resume), `scripts/spec-observe` metrics, `scripts/workspaces/pi-rpc.mjs` (uncommitted changes), spec-runtime `parent_session` consumers, spec-process-improvement.

**Relationships**: `parent_session` in the run index and run records points here. Gym cells use their own runs under `tmp/spec-gym`, not here.

**Retention / cleanup**: None for transcripts. `subagent-artifacts/.last-cleanup` files (a single-line epoch ms timestamp) are written by pi-subagents in 11 project dirs; they signal an artifact cleanup pass but the artifact counts per project remain high (e.g., 513 stage-reviewer inputs), so cleanup is age-based and lenient or limited to certain artifact classes.

**Observations**:
- 4.9 GB and growing at roughly 100 to 200 MB per busy day; 2.7 GB is a single repository.
- Transcripts contain full tool output and can hold secrets or customer data from any repo the agent read. They are not redacted. `run-history.jsonl` redacts task text but sessions do not.
- Slug naming collides: `/a/b-c` and `/a-b/c` both slug to `--a-b-c--`. Reconstructing the path from the directory name is lossy; the header `cwd` is authoritative.

---

### 10. Subagent artifacts: `.../sessions/--<slug>--/subagent-artifacts/`

**Location**: per project under sessions; e.g. 513 `spec-stage-reviewer`, 299 `spec-step-fixer`, 36 `spec-step-implementer` trios.

**Format and schema**: For each subagent run id: `<runId>_<agent>_input.md` (the task prompt), `_output.md` (final answer), `_meta.json`, and sometimes `_transcript.jsonl`. `_meta.json` keys: `acceptance, agent, exitCode, launchContractDigest, launchResolvedExtensions, model, parentSessionId, requestedModel, runId, skills, task, timestamp, transcriptPath, usage`.

**Purpose**: Durable result of each pi-subagents run; reviewer output is referenced from mission records and review packages.

**Lifecycle**: Written once per subagent run; 920 session-dir files changed since 2026-10-10. **Writers**: pi-subagents. **Readers**: mission records (`artifacts[].path`), spec-run reviewers, process-improvement.

**Relationships**: `mission.artifacts` and `runs[].asyncDir` point here and to `/var/folders/.../pi-subagents-uid-501/async-subagent-runs/<runId>` (OS temp, disappears on reboot).

**Retention**: See section 9. **Observations**: Mission records keep the temp-dir `asyncDir` and `status.json` paths, which will dangle after a reboot or temp cleanup; only the `sessions/.../subagent-artifacts` paths are durable.

---

### 11. `~/.pi/agent/run-history.jsonl`

**Location/format**: 326 KB, 1,667 lines, mode 0600. Rows `{agent, task, taskHash, ts (unix seconds), status (ok|error), outcome, duration (ms)}`. `task` is the literal string `[redacted]` in every row sampled; `taskHash` identifies repeats.

**Purpose**: pi-subagents' run log used for duration estimation and run history (`pi-subagents/src/runs/shared/run-history.js`, `recordRun`).

**Lifecycle**: Append-only; 2026-09-26 to 2026-10-11. Agent mix: `spec-stage-reviewer` 515, `worker` 375, `spec-step-fixer` 296, `spec-step-implementer` 211, `delegate` 140, `scout` 36; 91 rows `error`.

**Writers**: pi-subagents. **Readers**: pi-subagents. **Retention**: unbounded but tiny. **Observations**: `ts` is a Unix integer while sibling stores use ISO strings or epoch milliseconds (`.last-cleanup` is ms). Useful for a retrospective on reviewer volume (stage reviewers dominate).

---

### 12. Missions: `~/.pi/agent/missions/`

**Location**: `missions/projects/<project-hash>/<mission-uuid>.json` (133 project dirs, 2,644 records) and `missions/index/<mission-hash>.json` (2,644 files, one per record). 23 MB.

**Format and schema**: `schemaVersion: 1`. Mission record keys: `id, title, objective, status, createdAt, updatedAt, runs[{runId, mode, asyncDir, status, startedAt, completedAt, usage{tokens}}], workflowChildren[], decisions[], artifacts[{kind, path, description?}], receipts[], cwd, ownerSessionId, summary`. `title` and `objective` are `[prompt redacted]`. Index entries carry `{schemaVersion, missionId, projectRoot, recordPath, ...}`.

**Purpose**: pi-subagents' durable mission state linking a parent session to async subagent runs.

**Lifecycle**: Created 2026-09-25; 1,318 files modified since 2026-10-08 and 3,806 older, so roughly a quarter of files are recent. **Writers/readers**: pi-subagents.

**Relationships**: `ownerSessionId` to sessions, `artifacts[].path` to subagent artifacts, `cwd` to worktrees.

**Retention**: none; every dispatch creates a record plus an index file (2 files per mission). **Observations**: Not read by any code in this repo. Duplicated index/record layout doubles inode count.

---

### 13. Pi settings and provider configuration

**`settings.json`** (724 B, 644, untracked): keys `defaultProvider, defaultModel, lastChangelogVersion, packages[7 npm specs], retry.provider{maxRetries:3,maxRetryDelayMs:60000}, subagents.agentOverrides.scout{model,thinking,tools,output}, theme`. Writer: Pi core (changelog, theme) and operator edits. Reader: Pi. Last changed 2026-10-07 (goal-x removal). Two backups: `settings.json.bak-20261004-200741-before-codex-compat` and `settings.json.bak-20261007-232334-before-goal-x-removal`. Observations: `packages` pins are mixed (some exact, `pi-typesafe`, `pi-warden`, `pi-subagents` floating), so the installed set in `npm/package.json` can drift from this list. The scout override is the only persisted definition of the `scout` profile referenced by `pi/agents`.

**`models.json`** (15 KB, 0600): `{providers: {<name>: {api, baseUrl, compat, models[], apiKey?}}}`. 13 custom providers, including `gmicloud` (83 models) and `deepinfra` (61). Writers: operator and ad hoc scripts. Reader: Pi. Ten backups named inconsistently: `.bak`, `.bak-1790743005`, `.bak-20260926-153544`, `.bak-20260926-231031`, `.bak-20260926-gemini-fix`, `.bak-20260927-021526-pixel-canary`, `.bak-20261002-151514-kimi-reasoning-sync`, `.bak-20261004-142752-dots3-maxtokens`, `.bak-20261004-deepseek-together`, plus the live file. Eleven edits between 2026-09-26 and 2026-10-04. **Observations (secrets)**: the `atria` provider's `apiKey` is a command reference (safe pattern), but the `restory` provider holds a 64-character literal key in `models.json` and in all 10 backup copies, so one credential is stored 11 times. Backups are 0600, outside git, and not rotated. There is no schema or validator, and backups are not time-ordered by name.

**`models-store.json`** (747 KB, 0600): `{<provider>: {models[], checkedAt, etag, lastModified}}` for 12 providers; each model has `api, baseUrl, compat, contextWindow, cost, id, input, maxTokens, name, provider, reasoning, type`. Writer: Pi core (`models-store.js` in `@earendil-works/pi-coding-agent`). Reader: Pi. Refreshed repeatedly (mtime 2026-10-11 11:56); it is a cache and safe to delete.

---

### 14. Credentials and trust

Described by purpose only.

- `auth.json` (4.3 KB, 0600) and `auth.json.bak` (4.2 KB): Pi's per-provider login store (OAuth and API-key logins). Writer: Pi `/login`. Readers: Pi, and Jev indirectly when pi-typesafe resolves "the existing owner-only Pi login store". The `.bak` is a second copy of live credentials with an older mtime (2026-09-27).
- `ifm-api-key.txt` (71 B, 0600): API key for the custom `ifm` provider; read by `extensions/ifm-provider.ts:26` from a hardcoded absolute path. Writer: operator.
- `pi-typesafe/auth.json` (126 B, 0600): the pi-typesafe login; `pi-typesafe/auth-state.json` records verification time. Writer: pi-typesafe. Reader: Jev through the library.
- `trust.json` (109 B): JSON array of two project directories (`CodexBar`, `rearrange-writer`) that Pi has been told to trust. Writer: Pi. Static since 2026-09-23.
- `openai-codex-compat-installation-id`: a UUID generated by `pi-openai-codex-compat`.

**Observations**: The hardcoded key path and the literal `restory` key in `models.json` are the two places a secret escapes a purpose-built store. Neither is covered by `sync.sh`, `.gitignore` in this repo, or any rotation.

---

### 15. pi-warden: `~/.pi/agent/pi-warden/` (543 MB)

**Location and contents**: `holds.db` (88 MB) with `holds.db-wal` (420 MB) and `-shm`; `holds/<date>-<session-id>.jsonl` (2,423 files, 42 MB); `rules/` (98 entries, 3.4 MB); `prefs/<project-hash>.json`; `loops/<project-hash>/`; `steer-stats.json` `{version, models}`; `config.json` `{typesafe:true}`.

**Schema**: SQLite tables `holds` (129,493 rows; columns include `timestamp, project_root, tool, signature_hash, command_preview, task, plan, context_summary, preceding_actions, scores, level, held, reasons, agent_reason, outcome, outcome_at, confidence, session_id, task_hash, input_summary, prediction`), `hold_tasks` (3,068), `hold_meta` (2), `causes` (11), plus indexes on `(project_root, signature_hash)`, `outcome`, `timestamp`.

**Purpose**: Third-party Pi package that scores tool calls and records human hold/steer outcomes. Not authored here, but it runs inside Pi sessions that use this repo's extension, and it injects `pi-warden-prefs` and `pi-warden-steer` custom entries into sessions.

**Observations**: The 420 MB WAL is about five times the main database, indicating checkpointing is not occurring (long-lived reader or crashed process). `holds.command_preview`, `task` and `context_summary` contain command and prompt text across all projects, so it duplicates sensitive session content in a different format. Out of this repo's control but part of the same footprint.

---

### 16. Other Pi home directories

- `intercom/` (4 KB): `broker.pid`, `broker.sock` (UNIX socket, 0700 dir), `pending-asks/` and `extension-state/` (both empty). Writer: pi-intercom. Reader: spec-runtime communication (`communication.mjs`) and sentinel control. Broker started 2026-10-07; stale pid risk on reboot.
- `pi-subagents/last-seen-version.json` `{"version":"0.77.0"}`: update-notice marker.
- `extensions/subagent/config.json`: `{timeoutMs:7200000, modelResponseAliases:{...}}`; `extensions/ifm-provider.ts` (3.4 KB, operator-authored provider extension). Neither is in this repo, so they are unversioned.
- `npm/` (95 MB): Pi's package install root (`package.json` lists `@kmiyh/pi-full-text-paste, @saccolabs/pi-claude-cli, pi-intercom, pi-openai-codex-compat, pi-subagents, pi-typesafe, pi-warden`). It also holds three stray generated scripts, `wf-01a.js`, `wf-01b.js`, `wf-01c.js` (8 to 12 KB, 2026-10-05), which hardcode `/Users/ryanmahoney/Documents/adjacent-01-workspace-shell` and model names. They are leftovers of the "generated workflow script" approach the README says is no longer part of startup, and nothing references them.
- `bin/fd` (2.8 MB): bundled `fd` binary.
- `agents/`: eight symlinks into this repo.
- `pi-goal-x-removed-20261007-234755/` (1.8 MB, 114 files): renamed state of the removed `pi-goal-x` extension, `*-goals/` directories (including `archived/` and `goal_events.jsonl`) and `*-snapshot.json` `{dirMtimeMs, goals, version}` per repository. Frozen since 2026-10-07 23:47, no reader. Safe to archive or delete after a last look.
- `spec-runtime/` is section 3; `spec-sentinel/` is sections 7 and 8.

**Observations**: Third-party state (`missions`, `run-history`, `pi-warden`) is larger and busier than first-party state. Only `agents/` and `extensions/spec-runtime` are managed by `sync.sh`; everything else here is unmanaged and unbacked.

---

### 17. Jev: decision ledger `scripts/jev/state/decisions.jsonl`

**Location/naming**: `/Users/ryanmahoney/.agents/scripts/jev/state/decisions.jsonl` (+ `decisions.jsonl.previous` on rotation, `decisions.lock/` directory lock). `JEV_STATE_DIR` overrides. Git-ignored (`scripts/jev/.gitignore: state/`). Mode 0600.

**Format and schema** (`core.mjs:363-382`, rotation constant `core.mjs:14` `MAX_LOG_BYTES = 1048576`): JSONL, `schema_version: 1`, fields `decision_id, time, repository_hash (sha256 of exact repo path), revision, working_tree_digest, task (verification|review-triage|step-difficulty), status (recommendation|uncertain|unavailable), latency_ms, outcome (pending|accepted|overridden), local, broad_suite, finding_counts{must_fix,investigate,follow_up}, focused_check_hashes, mandatory_gate_count, difficulty_counts{easy,medium,hard} (step-difficulty only), uncertainty[]`. No diff, command text or finding text is stored (README "Bounds, privacy and persistence").

**Purpose**: Mechanical usage ledger so `jev report` can count outcomes and uncertainty reasons without a model call.

**Lifecycle and change frequency**: 1,204 rows from 2026-10-04 22:43 to 2026-10-11 16:55, 764 KB. Rows per day: 10-05 96, 10-06 105, 10-07 158, 10-08 280, 10-09 383, 10-10 80, 10-11 94 (to mid-day). Rotates to `.previous` at 1 MiB, overwriting the earlier `.previous`, so retention is the last 1 to 2 MiB (about 2 to 3 weeks at current volume). No `.previous` exists yet.

**Writers**: Jev core (CLI, MCP and in-process `runAdvice` from `runtime.mjs`). **Readers**: `report.mjs` (reads both files, 2 MiB limit, 7 days default).

**Relationships**: `repository_hash` can be matched to repositories only by hashing a known path, so the ledger cannot be joined to spec packages or run ids; `revision` and `working_tree_digest` are the only joins. Pi extension calls log here too, so the ledger mixes interactive CLI, MCP and `spec_advice` traffic without recording the caller.

**Retention**: bounded by rotation. A killed writer leaves `decisions.lock/` and logging unavailable until manual removal (README).

**Observations**:
- Utility is low: 997 of 1,204 rows (83%) are `unavailable` and 207 are `uncertain`; zero are `recommendation` (status values in the file are only `unavailable` and `uncertain`). Reasons (not exclusive): `context_incomplete` 904, `budget` 842, `context_excerpt_limit` 549, `stale_evidence` 211, `context_no_change_excerpt` 188, `model_uncertain` 182, `offline` 152, `context_redacted` 137, `incomplete_git_facts` 128, `context_collection_failed` 127.
- `budget` hits 70% of rows. `usage.json` shows daily input tokens at 100k to 103k on most days against a 100,000-token cap (`core.mjs:177`, default 30 requests, 100,000 input tokens), i.e. the token cap, not the request cap, is the binding limit. Calls beyond the cap are logged as unavailable, inflating the row count (383 rows on 10-09 for 25 started requests).
- 134 rows have `revision: null` (offline or non-git collection). The first rows (2026-10-04) carry synthetic `aaaa...`/`bbbb...` revision and digest values, so test or smoke data reached the live ledger.
- `outcome` is `pending` in 1,201 rows and `accepted` in 3; the "caller-declared outcome" is effectively never recorded, so the report cannot say whether advice was used.
- Jev README states "Noul probability" (typo, `README.md` thresholds paragraph).

---

### 18. Jev: usage ledger `scripts/jev/state/usage.json`

**Location**: `/Users/ryanmahoney/.agents/scripts/jev/state/usage.json`, 1.9 KB, 0600, git-ignored.

**Format**: `{version:1, days:{"YYYY-MM-DD":{requestsStarted, requestsSucceeded, requestsFailed, inputTokens, outputTokens, costUsd, costedInputTokens}}}`. Opened with `lib.openUsageLedger({path: join(directory,'usage.json')})` (`core.mjs:269, 325`), a pi-typesafe library API. Jev's ledger is deliberately separate from `~/.pi/agent/pi-typesafe/usage.json` (README).

**Lifecycle**: One entry per local day, eight days so far (2026-10-04 to 10-11); 21 to 30 requests/day, 65k to 104k input tokens/day, total spend about USD 0.032. **Writers/readers**: pi-typesafe library inside Jev; cap enforcement only. **Retention**: days accumulate forever (small). **Observations**: Cost is trivial; the cap is the constraint (see section 17). `failed` is 0 every day, so every unavailable result came from local caps or context, never transport errors.

---

### 19. Jev: input and output contract (version 1)

**Location**: `scripts/jev/README.md`, `core.mjs` (404 lines), `cli.mjs`, `mcp.mjs`, `report.mjs`; tests in `core.test.mjs`, `report.test.mjs`. Dependencies in `package.json` (`@modelcontextprotocol/sdk 1.28.0`, `pi-typesafe 0.9.1`, `typebox 1.3.31`), locked in `package-lock.json`.

**Input (verification, review-triage)**, max 32 KiB (`MAX_INPUT`), unknown fields and duplicate IDs rejected:
`schema_version: 1`, `policy.broad_suite_owner` (`ci|operator`), `change_summary`, `acceptance_criteria[]`, `mandatory_gates[]`, `focused_checks[<=20]{id,purpose,command?,source?,scope?}`, `planned_ci_checks[<=24]`, `evidence[<=24]{id,revision,observed_at,kind(local|ci),status(passed|failed|unknown),command?,artifact?,working_tree_digest?,scope?}`, `findings[<=7]{id,summary,category?,relevant_failure?}`, `base_revision?` (40 to 64 hex), `outcome?` (`pending|accepted|overridden`).

**Input (step-difficulty)**: `steps[1..8]{id, planner_difficulty, objective, precedent, settled_contracts, remaining_judgment, failure_consequences, focused_evidence}` (each prose field <= 2,000 chars, 32 KiB total). Reads no repository files.

**Output**: `schema_version, task, status (recommendation|uncertain|unavailable), decision_id, revision, working_tree_digest, recommendation, assessment, uncertainty[], fallback ("main_agent_judgment" always), test_pass_claim (always false), evidence, latency_ms, log`. Probability thresholds: >=0.8 true, <=0.2 false, otherwise unknown; review choices under 0.8 confidence map to `investigate`. `step-difficulty` outputs `calibration: not_validated_for_step_difficulty`.

**Interfaces**: CLI (`verification|review-triage|step-difficulty|status|report`), MCP tools (`jev_verification`, `jev_review_triage`, `jev_step_difficulty`, `jev_status`, schema `{repo, input}` at `mcp.mjs:9-17`), Pi tool `spec_advice` (`task` restricted to `verification|review-triage`, so step-difficulty is not reachable from the extension).

**Lifecycle**: 3 commits (2026-10-04 to 10-07); README changed with each feature (step-difficulty added, report added).

**Writers**: operator. **Readers**: global rules (`~/.agents/rules/verification-and-review.md` documents the same CLI contract), `skills/spec-*` prepare/run flows, the Pi extension, Claude Code and Codex via MCP.

**Observations**:
- Contract is documented only in README prose; there is no JSON Schema file, so each caller (rules, extension tool description, MCP `inputSchema: {type:'object'}` with `input` untyped) re-describes it. MCP clients get no field-level schema.
- MCP registration lives outside the repo: `~/.claude.json` (`jev-workflow`, node at `/opt/homebrew/bin/node`) and `~/.codex/config.toml:339-341`. `sync.sh` has no `jev` entry, so a new machine will not get the server.
- The docs and the sources disagree slightly on retention: README says rotation bounds storage to "about 2 MiB"; code rotates at 1 MiB and keeps one prior file (consistent), but `report.mjs` rejects any file over 2 MiB, which can only occur if rotation fails.

---

### 20. Jev config backup: `~/.agents/tmp/jev-config-backup-20261004-184818/`

**Location**: git-ignored (`.gitignore:3 tmp/`); 584 KB; created 2026-10-04 18:48.

**Contents**: `claude-config.json` (282 KB, 82 top-level keys, a snapshot of Claude Code's global `~/.claude.json`: caches, onboarding flags, per-project state and settings), `codex-config.toml` (13.6 KB, 109 sections, mostly `[projects."<path>"]` trust entries). Both mode 0600. A key-name scan found no `sk-`, `ghp_`, `xox` or `AIza` tokens in the JSON.

**Purpose**: Safety copy taken before registering the `jev-workflow` MCP server in both clients.

**Lifecycle**: Frozen. No reader. **Writers**: operator (one-off). **Retention**: manual.

**Observations**: A full copy of the Claude global config includes account/cache fields and the list of every project path used; it lives in a repo working tree (ignored, but one `git add -f` or `git clean -x` mistake away). Delete or move it to the home directory once the registration is verified (the live `~/.claude.json` already contains `jev-workflow`).

---

### 21. Spec-gym and scenario data

**Location**: `/Users/ryanmahoney/.agents/scenarios/{spec-architect-initial,spec-step-run}/scenarios.md` (both git-tracked, 8 KB total), `scripts/spec-gym/{cli,core,extract,runner,fake-pi}.mjs` + tests (3,889 lines), `skills/spec-gym/{SKILL.md,references/scenario-contract.md}`, `skills/spec-gym-extract/SKILL.md`. All created 2026-10-10 (15 commits in `scripts/spec-gym`, 3 in `skills/spec-gym`, 2 in `skills/spec-gym-extract`, 1 for `scenarios/`).

**Format and schema**:
- Index file `scenarios.md`: generated table `| id | status | version | driver | purpose | folder |` plus the fixed sentence "Scenarios in this index exercise only the listed purposes; behaviors absent from this table are not covered." Both tables are currently empty.
- Scenario (per `references/scenario-contract.md`, `core.mjs:130-265`): `scenarios/<skill>/<id>/scenario.json` with `id` (`^[a-z0-9][a-z0-9-]{1,63}$`, equals folder name), `skill`, `driver` (`leaf|managed-step`), `status` (`draft|ready`), `timeout_ms`, `task`, `purpose`, `fixture{feature, step?}`, `roles{editor_model?, scout_model?}`, `expectation_sources[]`, `checks[]` of kinds `file-exists, file-absent, line-1, text-match, json-equals, git-untouched, run-state`, optional `source.rewrites` count. Inputs under `input/{repository,package,project-context.md}`. `version` is a sha256 over `scenario.json` minus `status` plus every file under `input/` (`core.mjs:118-120`). Eligible skills are `skills/spec-*` directories (`list`).
- Run output (`runner.mjs`): `tmp/spec-gym/<run-id>/manifest.json` (`schema_version:1, run_id, created_at, gym{git facts}, pi{command,version}, skill, skill_sha256, managed_sha256?, scenarios[], cells[], roles, timeout_ms, child_extensions, env_names, ambient_context`), `run.json` (`{run_id, manifest, label, cells[...]}`), `report.md`, per-cell `gym.json`, a fresh Git repo per cell, and a retained Pi session; labels `matched` or `exploratory`. Cell outcomes: `passed|failed|blocked|invalid|timed-out`.

**Purpose**: Replay a frozen workload against explicitly selected models without touching live packages, and seed that library from real packages via `extract`.

**Lifecycle and change frequency**: Tooling is new and heavily changed on a single day; the library has no scenarios and no run has produced output, so none of the schema has been exercised on real data. `extract` is a one-time seed from `.specs/<feature>` at a pinned revision, with path sanitization (`<SOURCE_PACKAGE>`, `<HOME>`) and a denylist (`.env*`, `*.pem`, `*.key`, `auth.json`, `id_rsa*`).

**Writers**: `spec-gym extract` and `validate --write-index` (index); curators (scenario.json); `run` (tmp output). **Readers**: `spec-gym validate/list/run`.

**Relationships**: Managed-step cells drive the same `spec-runtime` dispatch (`assignment_id = cell.id`), freezing `pi/agents/spec-step-owner.md`, `spec-step-editor.md` and the extension into `managed_sha256` (`MANAGED_INSTRUCTION_PATHS`). Scenarios copy a prepared package set (`context.md, spec.md, spec-prepare.md, evidence-plan.json, spec-steps.json, step-NNN-subspec.md`, project-context), so they depend on the spec package format owned by another audit area.

**Retention**: The runner never deletes runs (`SKILL.md`); `tmp/` is ignored.

**Observations**: Ready-status rules require every file to be Git-tracked and forbid `todo` checks, which is a good guard against ignored fixtures. Pending risk is fixtures copied from real packages (private content) landing in a public repo; the skill itself notes that review before promotion is manual. No scenarios means the benchmark claims in the skill descriptions are currently unsupported by data.

---

### Cross-cutting findings

1. **Disk footprint outside `~/.agents`**: about 19.5 GB of per-package `runtime/` data plus 5.5 GB in `~/.pi/agent` (4.9 GB sessions, 543 MB pi-warden, 95 MB npm). Almost all growth has no pruning code. The largest single saving is truncating or compressing `runtime/runs/*-owner-*.jsonl` (50 to 100 MB each).
2. **Dangling cross-references are normal**: 46 of 114 indexed package paths and 49 of 823 indexed manifests no longer exist; mission `asyncDir` points into OS temp; observer snapshots are never removed. Consumers need to treat every cross-store path as optional.
3. **Secret handling**: credentials are in purpose-built 0600 stores, except a literal provider key in `models.json` duplicated across 10 backups and a hardcoded key-file path in `ifm-provider.ts`. `auth.json.bak` duplicates the live login store. Session transcripts and `pi-warden` SQLite hold unredacted command and tool output.
4. **No schemas outside code**: Jev's contract, agent frontmatter, run record, progress ledger and observer snapshot are defined only in code or README prose. Versions are inconsistent (`schema_version`, `version`, `schemaVersion`, null `snapshot.version`).
5. **Backup sprawl in `~/.pi/agent`**: 10 `models.json.bak*`, 2 `settings.json.bak-*`, `auth.json.bak`, a `pi-goal-x-removed-*` directory and three stray `wf-01*.js` scripts, named by four different conventions and never cleaned.
6. **Jev is mostly unavailable**: 83% of 1,204 decisions are `unavailable`, zero are `recommendation`, 70% hit the daily token budget, and `outcome` is almost never recorded, so the ledger measures its own caps rather than usefulness.
7. **Install state is not reproducible from the repo**: the Jev MCP registration, `spec-runtime.json`, the `scout` override in `settings.json`, `ifm-provider.ts`, and the Pi package list all live only in the home directory.


---

## Git, ledgers, search indexes, and verification facts

Scope: read-only audit of Git-derived data and the stores that tooling writes from it, in `/Users/ryanmahoney/.agents` as of 2026-10-11 (branch `design-packages`, HEAD `dcc2c0c`). No indexes were built and nothing was modified.

### Overview

Most Git-derived state is not kept in this repository. Ledgers and manifests (`docs/specops/history/`, `docs/specops/targets.json`) are defined as files in the *target* repository that the scripts operate on, and this repository does not contain them. The data that lives here is:

- the Git history itself (396 commits, 23 merges, 8 tags, 13 registered worktrees, 9 local branches, plus remote-tracking refs);
- untracked per-run spec artifacts under the gitignored `.specs/` tree (including `sentinel-merge.json`);
- the optional repo-search state under `~/.cache/agent-repo-search` (outside the repo);
- generated bundles under the gitignored `dist/`.

| Structure | Path | Format | Writer | Reader | Change frequency |
|---|---|---|---|---|---|
| Git history | `.git` (this repo) | Git objects | Human commits, `spec-branch-*` skills, merges | `spec-facts`, `commit-ledger`, `repo-status`, `merge-reconciliation` | 396 commits; 206 in 2026-W41 |
| Branches and worktrees | `refs/heads/*`, `git worktree list` | Git refs | `spec-branch-worktree` skill, humans | repo-status, spec-sentinel discovery | 9 local branches, 13 worktrees (12 linked) |
| Commit-coverage ledger | `<target>/docs/specops/history/ledger.jsonl` (not in this repo) | JSON Lines, one row per commit per lens | `scripts/commit-ledger.mjs record` | `commit-ledger.mjs uncovered/reconcile/churn/status`, specops skills | Append-only; no instance in this repo |
| Coverage frontier | `<target>/docs/specops/history/frontier.json` | JSON object keyed by lens | `commit-ledger.mjs record/reconcile` | `commit-ledger.mjs` | Rewritten on each record/reconcile; no instance here |
| Target manifest | `<target>/docs/specops/targets.json` | JSON, `version: 1` | `decompose-skeleton.mjs` (stdout only; the manifest is hand-kept) | `agent-docs.mjs`, `commit-ledger.mjs`, `decompose-skeleton --check` | No instance in this repo |
| Spec merge record | `.specs/<pkg>/sentinel-merge.json` (gitignored) | JSON, mode 0600 | `spec-observe/merge-reconciliation.mjs` | Sentinel dashboard | 11 instances in this checkout's `.specs/`; modification dates not inspected |
| Verification receipt (CI) | stdout of `scripts/verification/ci.mjs` | JSON, `schema_version: 1` | Caller (not persisted here) | `warden-evidence.mjs`, spec-verify | Per call; none stored |
| Spec facts | stdout of `scripts/spec-facts/cli.mjs`; raw logs under Pi runtime | JSON, `schema_version: 1` | `spec-facts` CLI, Pi runtime | Owners, reviewers, coordinators | Per call |
| Repo-search state | `~/.cache/agent-repo-search/{state.sqlite,checkouts/,generations/}` | SQLite (Bun), directories | `scripts/repo-search` lifecycle | `repo-search` skills, `client.mjs` | Currently: `state.sqlite` (108 KB); `checkouts/` and `generations/` empty |
| Repo-search settings / model root | `~/.cache/agent-repo-search/settings.json`, `~/.local/share/agent-repo-search/models/` | JSON (0600); model files | `repo-search install` / `setup` | `build`, `update`, `search` | Model root absent on this machine; no `settings.json` present |
| Embedding cache | `<state>/embedding-cache.sqlite` | SQLite | repo-search engine | repo-search engine | Not present on this machine |
| Skill lint | `skills/*/SKILL.md` (read only) | Stdout text, exit code | n/a | Pre-commit | Read-only |
| Skill bundles | `dist/skill-bundles/` (gitignored) | Directory tree plus `install.sh` | `scripts/build-skill-bundles.sh` | Installer | Regenerated per build; `dist/` present |
| roborev DB | `~/.roborev/reviews.db` | SQLite | roborev daemon | roborev skills | **Absent**: `~/.roborev/` does not exist, no `roborev` binary on PATH |

Git-derived data is therefore split in two: the commit history is authoritative and shared; the coverage ledger, frontier and target manifest are per-target-repo files produced by SpecOps tooling. This repository only contains the code that writes them.

---

### 1. Git history, branches, and worktrees

**Location / naming.** Git objects in `.git`. No checked-in Git-derived data files.

**Format and schema.** Commit subjects follow Conventional Commits (`type(scope): summary`). Last 300 commits by type: `feat` 120, `fix` 82, `docs` 39, `refactor` 12, `chore` 7, `test` 2, with a small tail of non-conventional subjects (for example `step5: support headless observer lifecycle (EV-3)` and `work on automated document maintenance`).

**Commit volume (`git log --format=%ad --date=format:%G-W%V`).** 2026-W11 through W16 show 2 to 12 per week; W24 26 and W25 34; W40 52; W41 206 (the current week, 2026-10-05 to 10-11). Total 396.

**Branches.** Local: `1-add-worktree-isolation-to-dev-workflow`, `3-decomposition-first-agents-documentation-pipeline-phase`, `backup/spec-31-pre-rebase-c3a2de9`, `chore/shared-verification-tools`, `design-packages` (checked out), `feat/sentinel-discovery-specs-watching`, `feat/spec-end-to-end-workflow`, `llm-project`, `main`. Spec branches exist as local branches with linked worktrees: `spec-adj1-foundational-contracts` through `spec-adj6-supervision-integration`, `spec-repo-search-index`, `spec-spec-sentinel`, `spec-super1-spec-gym`, `spec-super2-final-fix-review`, `spec-super3-owner-orchestrator-clarification`, and `spec/31-ux-journey-qa`. Remote-only: `origin/spec/repo-status`.

**Worktrees (`git worktree list`).** 13 entries including the main checkout. Linked worktrees sit in two locations:
- siblings of the repo in `$HOME`: `~/.agents-adj1-…`, `~/.agents-repo-search-index`, `~/.agents-spec-sentinel`, etc. (11 entries);
- `~/.worktrees/agents/31-ux-journey-qa` (1 entry; `~/.worktrees/` contains one directory per repo, `agents/` among them).

**Commit trailers.** Over the last 300 commits: one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer, one `Findings: step-006 F1-F4.` trailer, and 8 subjects with workflow step labels (`step-001 read active session branches (EV-2)` and similar). Merges: 23 total.

**Lifecycle and change frequency.** Commits are written by humans and by the spec workflow's per-step commits. Spec branches are created per spec package and are not deleted after merge (the `spec-adj*` branches remain with live worktrees, and `backup/spec-31-pre-rebase-c3a2de9` is a rebase backup). No `git stash` entries; 8 tags.

**Writers.** `skills/spec-branch-worktree/SKILL.md:55-72` creates branch `<slug>` and worktree `$HOME/.worktrees/<repo>/<slug>` using `git worktree add --no-track -b`. `skills/spec-branch/SKILL.md:52` removes upstream tracking. `skills/commit/SKILL.md:28` forbids Co-Authored-By and AI attribution.

**Readers.**
- `scripts/spec-facts/core.mjs:7-42` (`gitFacts`) runs `status --porcelain=v1 -z`, `rev-parse`, `symbolic-ref`, `diff --name-status -z`, and `rev-list --count` with a 15 s timeout and 16 MiB output cap.
- `scripts/commit-ledger.mjs:284` reads `%H %h %T %P %an %ae %aI %s` via `git log`.
- `scripts/spec-observe/merge-reconciliation.mjs:52-57` reads `.git/refs/heads/...` and `packed-refs` directly with a 64 KB bound, avoiding a `git` process.
- `scripts/repo-search/identity.mjs:173` reads `git worktree list --porcelain -z` to resolve checkout identity.
- The `repo-status` skill (`skills/repo-status`) reads branches, tracking, divergence, dirty files, and worktrees for status reports.

**Retention / cleanup.** No pruning or branch-deletion automation exists in this repo. Worktrees persist until removed by hand. The `spec-branch-worktree` skill reuses an existing worktree on the same branch but never removes one.

**Observations.**
1. Branch and worktree naming is inconsistent with the documented layout. The skill says `~/.worktrees/<repo>/<slug>` with branch `<slug>`, but 11 of 12 linked worktrees are at `~/.agents-<slug>`, and one branch uses `spec/` as a prefix while the rest are bare `spec-…`. The one matching the skill is `spec/31-ux-journey-qa` under `~/.worktrees/agents/`, which uses a different nesting (`agents/` instead of a repo-name directory layer that matches the sibling form).
2. Two commits from the last 300 violate the commit policy (`skills/commit/SKILL.md:28` and the user's attribution rule): the `Co-Authored-By: Claude …` trailer and the `Findings:` workflow metadata. Eight subjects carry `stepN:` workflow labels, which `rules/engineering-writing.md` says belong in workflow records rather than history.
3. Eleven linked worktrees and nine local branches are retained with no cleanup path; this is the largest growing structure on the machine.
4. Commit volume is strongly bursty (206 commits in one week), so any "churn" or "commits since" metric derived from history reflects the batch cadence of spec runs, not steady development.

---

### 2. `scripts/commit-ledger.mjs` (+ `commit-ledger.test.mjs`, 25 tests)

**Location / naming.** Default paths are relative to the *target* repository: `docs/specops/history/ledger.jsonl` (`scripts/commit-ledger.mjs:8`) and `docs/specops/history/frontier.json` (`:9`). The default manifest is `docs/specops/targets.json` (`:6`). This repository has no `docs/specops/` directory, so no instance is present here.

**Format and schema.**
- Ledger row (`buildRecord`, `:90-106`): `commit`, `abbrev`, `tree`, `author`, `email`, `date`, `subject`, `targets[]`, `lens` (`doc|intent|rework`, `:10`), `recorded_at` (ISO timestamp, injected), `collapsed_from[]`. Serialized as JSONL (`serializeLedger`, `:61-72`).
- Frontier (`advanceFrontier`, `:116-117`; `frontierEntry`, `:112-114`): object keyed by lens, each value `{ commit, tree, date }`. Written as pretty JSON with trailing newline (`writeFrontier`, `:332`).
- Churn output (`churnByUnit`, test `:253`): aggregated touches, authors, commit types, and reverts per target or file.

**Purpose.** Records which commits have been covered by each documentation or analysis lens, so SpecOps can process only new commits. The reconcile logic (`reconcilePlan`, `:123-`) re-anchors to the newest still-reachable covered commit when squash merges or rewrites remove the frontier commit.

**Lifecycle and change frequency.** Append-only ledger (`appendLedgerRecords`, `:335-338`, using `appendFileSync`); frontier rewritten in place. `init` creates an empty ledger file if absent (`:398-403`). The script was introduced 2026-06-28 and has one commit touching it since.

**Writers.** `record` (`:432-449`) and `reconcile` (`:464-516`), invoked from `skills/specops-branch-refresh/SKILL.md:85` (the only skill whose text references `commit-ledger.mjs`, per grep). Reconcile may also write new rows (`:516`).

**Readers.** `uncovered` (`:432-434`), `status` (`:537-547`), `churn`, and `coveredShas` (`:483`). The CLI prints JSON to stdout (`:639`).

**Relationships.** Keyed on commit SHA and lens; `targets[]` come from `decompose-skeleton.mjs` target globs (`matches`, `:20-30`, supports `**`, `*`, `dir/**`, `dir/*`). The ledger and `targets.json` are versioned together in the target repo; `skills/build-skill-bundles.sh:610-611` documents both files in the generated SpecOps how-to.

**Retention / cleanup.** None. Rows accumulate indefinitely; the design expects this ("treat the ledger as append-only", `skills/specops-branch-refresh/SKILL.md:131`).

**Observations.**
1. Ledger and frontier are per-target-repo files; the `scripts/` copy here is the only code, which means ledger correctness depends on the target repo's commit history being preserved (squash merges trigger reconciliation).
2. `record --all-uncovered` and `reconcile` both append; no file lock or dedupe key beyond `(commit, lens)` in `coveredShas`. Concurrent runs against the same target could double-append (not tested).
3. `buildRecord` stores author email in every row (`:90-106`), so a committed ledger publishes contributor email addresses.

---

### 3. `scripts/agent-docs.mjs` (+ test, 6 tests) and `scripts/decompose-skeleton.mjs` (+ test, ~41 cases)

**`agent-docs.mjs`**

- **Inputs/outputs.** Reads a target manifest (`DEFAULT_MANIFEST = docs/specops/targets.json`, line 6) and writes an index block into `AGENTS.md` (`DEFAULT_AGENTS`, line 7) between markers `<!-- agents-docs:start -->` and `<!-- agents-docs:end -->` (lines 8-9). `writeIndex` (`:171-178`) replaces the block and `mkdir -p`s the parent directory.
- **Per-target status** (`targetStatus`, `:110-122`): `slug`, `name`, `scope`, `tier2_path`, `agent_path`, `analysis_exists`, `agent_doc_exists`, `source_hash`, `last_synthesized`.
- **Format.** Generated Markdown index; CLI prints JSON (`:239-243`) for changed-file detection, `write`, and `status`.
- **Writers.** `writeIndex` only, invoked from `skills/specops-index-agents/SKILL.md` and `skills/specops-branch-refresh/SKILL.md`.
- **Readers.** Agents reading `AGENTS.md`; `status` command.
- **Change frequency.** Two commits in the repo history (the first 2026-06-28).
- **Observations.** The index block is the only generated section in `AGENTS.md`; the markers are the sole ownership boundary, so hand edits outside them persist. Glob handling is narrower than `decompose-skeleton.mjs` (the file's own comment at `commit-ledger.mjs:20-22` notes agent-docs throws on unsupported shapes).

**`decompose-skeleton.mjs`**

- **Inputs.** A repository root; discovers source files under `SOURCE_ROOTS = [src, lib, app, packages, services, cmd]` (`:30`) excluding `IGNORED_DIRS` (`:9-28`, including `.specs`, `docs`, `tests`) and `IGNORED_FILES`. Uses `git` through `execFileSync` (`:4`) and `package.json`/`pnpm-workspace.yaml` (`:249-255`) for workspace detection.
- **Outputs.** `derive` (`:730`) returns targets with `source_globs`, `source_hash` (`sourceHash`, `:711-716`, `sha256:` over sorted `unit\0sha256(content)` lines), and byte totals (`:824`). The manifest-level object has `version: 1` (`:747`). `frontier` (`:851`) reports targets whose hash changed. `check` (`:976-1059`) compares a stored manifest to the derived one and fails on `source_globs` mismatch (`:968-970`).
- **Unassigned files.** Listed up to `UNASSIGNED_SAMPLE_LIMIT = 50` with 3 per top-level directory (`:20-21`).
- **Writers.** The script itself only prints JSON (`:1059`, `:1064`); the manifest is written by the operator/skill (`skills/specops-decompose/SKILL.md`). `--check <path>` reads the manifest.
- **Readers.** `commit-ledger.mjs` (glob semantics), `agent-docs.mjs`, `specops-decompose`, `specops-branch-refresh`.
- **Lifecycle.** Nine commits; the most recent 2026-06-29.
- **Observations.** `source_hash` is computed from file bytes, so a whitespace-only change to any source file reclassifies a target as changed; it does not use Git blob IDs, which would be cheaper (`execFileSync('git', …)` is already imported).

---

### 4. `scripts/spec-facts/*` (`cli.mjs`, `core.mjs`, `core.test.mjs` with 6 tests, `README.md`)

**Location / naming.** No files written; results are printed to stdout.

**Git facts schema** (`gitFacts`, `core.mjs:24-41`): `schema_version: 1`, `observed_at` (ISO), `repo`, `branch` (`symbolic-ref --short HEAD`, nullable), `head` (`rev-parse HEAD`, nullable), `clean` (boolean), `snapshot: "non_atomic"`, and three bounded lists `staged`, `unstaged`, `untracked`, each `{ total, omitted, entries[] }` with entries `{ status: 2-char porcelain code, path }`. With `--base`: `range: { base, head, comparison: "endpoints", commits_ahead, changed: bounded([{status, path}]) }`. The default list limit is 100 (`:7`), range 1..1000.

**Log summary.** `createLogSummary` (`core.mjs:44-97`) returns a bounded excerpt set (8,000 characters per README) with line numbers and a `exit_code: null` for standalone summaries. Raw logs are written by the Pi runtime at mode 0600, one per command, outside this repo (README lines 36-44).

**Purpose.** Replace repeated Git and log inspection by agents with bounded, deterministic facts; explicitly not a verdict. README: "Facts do not prove acceptance or authorize staging, commits, rebase or publication."

**Writers.** None persistent. The CLI is invoked by owners, reviewers, and coordinators (`README.md`, `pi/agents/spec-stage-reviewer.md`, `skills/spec-run/SKILL.md`, `docs/spec-workflow-efficiency.md`).

**Readers.** The same callers.

**Retention.** Results are ephemeral; raw logs per command follow the Pi runtime's retention (not inspected here).

**Observations.** `gitFacts` rejects `--head` without `--base` and never fetches. Its non-atomic snapshot means a rapidly changing checkout can produce mixed `status` and `range` data; the README warns about this. Only one commit has touched the directory (2026-10-06).

---

### 5. `scripts/verification/*` (`ci.mjs`, `warden-evidence.mjs`, `install-warden.mjs`, `evidence.test.mjs` with 8 tests)

**CI receipt schema** (`ci.mjs:52-64`): `schema_version: 1`, `type: "verification_evidence"`, `kind: "ci"`, `status` (`stale` if the checkout or PR head changed during the read, `:55`), `revision`, `observed_at`, `repo`, `checkout_clean`, `head_verified`, `reason`, `artifact` (PR URL), and `checks: [{ name, status (bucket), artifact (link) }]`. Data comes from `gh pr view --json headRefOid,url,state` and `gh pr checks --json …` (`:31-37`). Failures emit `status: "unavailable"` with a bounded reason (`:87`).

**Warden classifier** (`warden-evidence.mjs`): `classifyProjectCheck` (`:11`) accepts only receipts with `type: verification_evidence`, `schema_version: 1`, `kind: ci` (`:31-32`), returning `unknown` otherwise. `classifySpecArtifact` (`:53`) classifies spec artifact writes.

**Warden patch** (`install-warden.mjs`): writes into an external Pi extension file, not this repo. It creates a one-time backup `${target}.project-verification-v2-backup` with `flag: 'wx'` (`:30`) before overwriting the target (`:31`), and injects an import line at a marker (`:23`).

**Writers.** `ci.mjs` (stdout); `install-warden.mjs` (external file, once).
**Readers.** `warden-evidence.mjs`, spec verification steps; no file store.
**Relationships.** The CI receipt's `revision` is the same SHA `spec-facts` reports as `head`; the classifier does not compare them.
**Retention.** None; receipts are not persisted in this repo.

**Observations.**
1. `ci.mjs` is the only place that tests the "CI passed" fact, and its result is not stored. A later verifier must re-run `gh` to recover it.
2. The `stale` detection compares `HEAD`, `git status`, and `headRefOid` before and after the read (`:41-45`), which is a good guard against mixing revisions.
3. `install-warden.mjs` modifies an external file under `~/.pi`. Its backup filename is fixed, so a second install after an upstream update leaves the first backup in place.

---

### 6. `scripts/spec-observe/merge-reconciliation.mjs` (+ test, 9 tests)

**Location.** `.specs/<package>/sentinel-merge.json`. `.specs/` is gitignored (`.gitignore`), so these records are local to the checkout. Eleven instances exist under `.specs/` (17 package directories; the unrun and legacy packages have none).

**Schema.** Record fields include `binding` (a SHA-256 of the input JSON, `:9`, `:21`), `url`, `branch`, `tip`, `state` (`merged|unmerged|unknown`), `reason` (`local-merge-budget`, `local-repository-unavailable`, `branch-tip-unavailable`), and `checked_at`. Persistence (`:215-222`) writes a 0600 temp file in the package directory and renames it into place, with `JSON.stringify(record, null, 2)`.

**Caching rules.**
- Poll interval for an unmerged PR is 10 minutes (`MERGE_POLL_MS`, `:10`); retry for other states is 60 seconds (`MERGE_RETRY_MS`, `:33`).
- Local and network budgets are 2 s and 6 s (`:34`, `:80`), with at most 3 local checks (`:82`).
- The prior record is read with `boundedJson`, capped at 64 KB (`:11-18`).
- An in-memory map holds up to 500 packages (`:145`).

**Writers.** `createMergeReconciler` with `persist: true` (`:140-175`).
**Readers.** Sentinel dashboard and `validateMergeCache`.

**Observations.**
1. The record binds to the package and PR URL, so a re-opened PR with a new URL invalidates the cache (`applicableMerge`, `:24`), which is correct.
2. `primary` path checks (`:96-98`) reject symlinked `.git`, which is a useful guard for reading refs directly.
3. The `binding` hash covers the input JSON, so a change in any input field (for example a new `headRefOid`) forces re-evaluation.

---

### 7. repo-search state, enrollment, model registry, and indexes (`scripts/repo-search/*`, `skills/repo-search*`)

Not built. Structure read from source only.

**Default state root.** `~/.cache/agent-repo-search` (`scripts/repo-search/identity.mjs:185-187`), overridable by `--state` or `stateRoot`. The root holds:
- `state.sqlite` (+ `-wal`, `-shm`) opened with Bun SQLite (`state.ts:1214-1269`), mode 0600, with sidecar safety checks;
- `checkouts/<checkoutKey>/` (`state.ts:407`, `identity.mjs:212-214`), where `checkoutKey` is `SHA256(JSON [repoKey, gitDir, root])` (`identity.mjs:20`); `enrollment.json` lives there (`identity.mjs:212-214`, metadata owned by the current user with no group/world permissions, `lifecycle.ts:207-232`);
- `generations/<id>/` plus `<id>.tmp` for atomic publication (`state.ts:408-424`);
- `embedding-cache.sqlite` (`state.ts:1050`);
- `settings.json` (mode 0600) holding the registered model root (`scripts/repo-search/README.md`, install section).

**State schema** (`state.ts:305-349`): `generations(id, status, base_id REFERENCES generations(id), …)` with indexes on `status` and `base_id`; `current_generations(…, generation_id REFERENCES generations(id) ON DELETE CASCADE)` with triggers (`:352-374`) that prevent changing the status of a generation that is current.

**Enrollment registry.** Per-checkout `enrollment.json` under `checkouts/<key>/`. The registry is a directory of records, not a single index; there is no central list, so enumeration requires scanning `checkouts/`.

**Model root registry.** `<state>/settings.json` (install writes it atomically after verifying the six pinned digests in `core/codeModelAssets.ts`); default model location `~/.local/share/agent-repo-search/models` (`skills/repo-search-setup/SKILL.md:62`). The package never downloads assets.

**Chunk and embedding formats.** Chunks come from `core/chunk.ts` (`lineWindow` or AST via `code-chunk`); vectors use the jina-embeddings-v2-base-code model; the embedding cache key includes the full compatibility identity (`createCodeEmbeddingCacheNamespace`), and the index compatibility identity includes `assetDigest`. Orama persistence is the index format (`core/codeIndexRuntime.ts`).

**Refresh cadence.** Explicit only: `build`, `update`, `reindex` commands; repo-search skills state they never refresh automatically. The `spec-facts`/Sentinel path does not trigger refresh. `skills/repo-search-index/SKILL.md` is the manual maintenance entry point.

**Present state on this machine.** `~/.cache/agent-repo-search/state.sqlite` (108 KB); `checkouts/` and `generations/` are empty; no `settings.json`; no `~/.local/share/agent-repo-search/models`. The index is therefore installed-but-unbuilt.

**Writers.** `setup.mjs` (model + setup), `cli.mjs install|build|update|reindex`, `lifecycle.ts`, `state.ts`, `worker.ts`.
**Readers.** `client.mjs`, `search.ts`, the four `skills/repo-search*` skills.
**Relationships.** Checkout identity uses `git worktree list` (`identity.mjs:173`), so each worktree is a separate checkout key. Generations are per-primary plus overlays per worktree (commit `9769e6f` "build worktree overlays").
**Retention.** Not automatic; `repo-search-status` skill provides explicit `forget` and `prune`.

**Observations.**
1. The default state root is outside the repository, so repo-search state is not exposed to Git; the only in-repo guard for spec-derived data is the `.specs/` entry in `.gitignore`.
2. Each worktree gets its own enrollment and overlay, and the 13 worktrees here would become 13 enrollments once enrolled.
3. `enrollment.json` ownership and permission checks (`lifecycle.ts:216-249`) are a deliberate integrity boundary; the registry has no schema version field in the JSON reviewed.

---

### 8. roborev review data (`~/.roborev/reviews.db`) and `roborev-*` skills

- `~/.roborev/` does not exist on this machine (`ls: /Users/ryanmahoney/.roborev/: No such file or directory`). `sqlite3` is at `/usr/bin/sqlite3`, but there is no database to inspect, so `.schema` and row counts were not obtained.
- `roborev` is not on PATH (`which roborev` returned "roborev not found").
- The `roborev-*` skills named in the skill listing (`roborev-review`, `roborev-review-branch`, `roborev-design-review`, `roborev-design-review-branch`, `roborev-fix`, `roborev-refine`, `roborev-respond`) have no source in `skills/` or `claude/skills/` in this repository. They are provided by the harness, not by files here.
- The user's auto-memory references roborev internals (`~/.roborev/reviews.db`, per-commit reviews aggregated into range reviews). That information cannot be checked against the live database in this environment.

**Observations.** The review store is absent here, so any roborev-derived review history must be read on the machine that runs the daemon. Nothing in this repository depends on roborev output; the spec workflow uses its own review records under `.specs/`.

---

### 9. `scripts/lint-skills.sh` and `scripts/build-skill-bundles.sh`

**`lint-skills.sh` (102 lines, 3 commits).**
- Reads `skills/*/SKILL.md`: staged additions and modifications by default (`git diff --cached --name-only --diff-filter=ACM`, `:27`), or every skill with `--all` (`:20`).
- Checks: frontmatter opens and closes with `---`; `name:` equals the directory name; non-empty `description:`; `version:` present under metadata; spec and design skills (`spec-*`, `design-*`) contain no Restory-specific terms (regex at `:70`, list in header).
- Warnings only for missing `disable-model-invocation:` and `argument-hint:`.
- Writes nothing; output is text on stdout with a summary line and a non-zero exit on error.
- Observation: the Restory-term check is a single case-insensitive regex; it cannot see terms split across lines.

**`build-skill-bundles.sh` (875 lines, 34 commits, most recent 2026-10-11).**
- Output root `DIST="${DIST:-$ROOT/dist/skill-bundles}"` (`:5`); `mkdir -p` at `:8`. `dist/` is gitignored, and the directory exists in this checkout.
- Copies skills (`copy_skill`, `:10-21`), rules (`copy_rules`, `:39-49`, `rules/*.md`), scripts (`copy_scripts`, `:52-61`, allowlist), and generated how-to documents (`write_spec_workflow_howto`, `:277`; `write_specops_workflow_howto`, `:469`). The SpecOps how-to documents `docs/specops/history/ledger.jsonl` and `frontier.json` (`:610-611`), so the generated bundle describes the target-repo ledger that this repo does not contain.
- Generates `install.sh` (`write_install_script`, `:63-`) with copy and link modes, and writes Pi/Augment install instructions (`:688`).
- Reads only the repository's own `skills/`, `rules/`, `scripts/`, and agent folders; no network access.
- Observation: bundle contents are rebuilt from source each run into a directory that is not versioned, so a stale bundle from an earlier build can persist alongside a new one unless the target is cleaned by hand.

---

### Relationships (summary)

- Git history is the common source: `spec-facts` and `repo-status` read live state; `commit-ledger` and `decompose-skeleton` read history and file bytes; `merge-reconciliation` reads refs directly.
- `commit-ledger` rows reference `decompose-skeleton` targets (by `targets[]`) and are validated against them via `source_globs` matching.
- `agent-docs` renders `targets.json` into `AGENTS.md`; `targets.json` and `ledger.jsonl` are versioned in the target repo and are not present here.
- Verification receipts (`ci.mjs`) carry the same SHA that `spec-facts` reports; the warden classifier does not check them against each other.
- repo-search identity depends on `git worktree list`, so worktree creation or removal changes repo-search enrollments.

### Retention and cleanup (summary)

| Structure | Retention |
|---|---|
| Git history, branches, worktrees | Unbounded; no cleanup automation (11 linked sibling worktrees, 9 local branches) |
| Commit-coverage ledger / frontier | Append-only, unbounded (target repo) |
| `sentinel-merge.json` | One per package, overwritten; in-memory cache capped at 500 |
| CI receipts, spec facts | Not stored |
| repo-search state | Manual only (`repo-search-status forget/prune`) |
| `dist/skill-bundles` | Overwritten per build; old trees not removed |
| roborev DB | Not present |

### Observations (cross-cutting)

1. The ledger, frontier, and target manifest are referenced throughout SpecOps but live in other repositories; the audit can verify their schema only from code and docs.
2. Commit-message policy is violated in at least one recent commit (`Co-Authored-By: Claude …`) even though `skills/commit/SKILL.md:28` forbids it; the `Findings:` trailer and `stepN:` subjects are workflow metadata in history.
3. Branch and worktree naming diverges from the documented layout (`~/.worktrees/<repo>/<slug>`); 11 of 12 linked worktrees are siblings in `$HOME`.
4. The repo-search index is installed but has no model root and no built generations on this machine, so no search data exists to audit.
5. No Git-derived fact is persisted in a versioned file here, so reproducibility depends on re-running `git`.


---

## Rules, skills, configuration, and documentation

Read-only audit of `/Users/ryanmahoney/.agents` as of 2026-10-11. Git facts come from `git log` on the `design-packages` checkout. File mtimes are from the local filesystem. Credential-bearing files were listed by name and size only; none were read.

### Overview

The static corpus has four layers: policy text that agents load at session start (`claude/CLAUDE.md`, `codex/AGENTS.md`, and the `rules/` guides they name), 84 skill directories whose `SKILL.md` files are the slash-command bodies, distribution and mirror plumbing (`sync.sh`, `bundles/`, `dist/`, `~/.claude/rules`, `~/.claude/skills`), and prose documentation (`README.md`, `docs/`, `content/`, `research/`). Three of these have drifted: the live policy copies no longer match the rule set the skills expect, a generated bundle manifest still lists removed skills, and the research notes are ignored by git.

| Structure | Path | Format | Writer | Reader | Change frequency |
|---|---|---|---|---|---|
| Design, copy, and engineering guides | `rules/*.md` (12 files) | Markdown, no frontmatter | Operator by hand; `rules-from-experts` skill as the research pipeline | Claude Code via `~/.claude/rules` mirror and session context; Codex via `~/.codex/guides`; skills by path | 19 commits total; newest `prototype-design.md` on 2026-10-11 |
| Claude global policy | `claude/CLAUDE.md` copied to `~/.claude/CLAUDE.md` | Markdown | Operator; `sync.sh` copies | Claude Code | 1 commit per day at most; last 2026-10-08 |
| Codex global policy | `codex/AGENTS.md` copied to `~/.codex/AGENTS.md` | Markdown | Operator; `sync.sh` copies | Codex | Same time as CLAUDE.md (2026-10-08) |
| Mirror of rules | `~/.claude/rules/*` (outside repo) | Symlinks to `rules/*.md` | `sync.sh` | Claude Code | 13 entries, one dangling |
| Skill definitions | `skills/<name>/SKILL.md` (84) | YAML frontmatter plus Markdown | Operator; `skill-factory` creates new ones | Claude Code, Codex, Augment, Cline, OpenCode via symlink; Pi and humans | 84 directories; top 10 changed 2026-10-10 or later |
| Skill sub-assets | `skills/*/references/` (49 files), `skills/*/scripts/` (28), `skills/*/agents/openai.yaml` (22) | Markdown, Python/shell/JS, YAML | Operator | Skill body via relative link; Codex/OpenAI agent UI for `agents/openai.yaml` | Tracked with the owning skill |
| Skill mirrors | `~/.claude/skills`, `~/.codex/skills`, `~/.cline/skills`, `~/.augment/skills`, `~/.opencode/skills` | Directory symlinks | `sync.sh` | Each harness | `~/.claude/skills` holds 92 entries, 84 from this repo |
| Augment subagent | `augment/agents/spec-step-implementer.md` | Markdown with YAML frontmatter (`name`, `description`, `model`, `color`) | Operator | Augment CLI | Tracked; not checked for change history |
| Distribution config | `sync.sh`, `scripts/build-skill-bundles.sh`, `.github/workflows/release-skill-bundles.yml` | Bash, YAML | Operator | Shell, GitHub Actions on tag push | Stable |
| Bundle docs | `bundles/README.md` | Markdown | Operator | Humans | 2 commits |
| Generated bundles | `dist/skill-bundles/` (gitignored) | Directories, `bundle.json`, `.tar.gz`, `.zip` | `scripts/build-skill-bundles.sh` | Install script users | Last written 2026-10-06; stale |
| Essay | `content/context-and-harness.md` | Markdown | Operator | Humans | Mtime 2026-07-12 |
| Prose docs | `README.md`, `docs/*.md` (11 files) | Markdown | Operator | Humans and agents | README has 62 commits; `docs/spec-workflow.md` has 16 |
| Research notes | `research/test-value/`, `docs/research/` | Markdown | Operator and research sessions | Humans | Gitignored; untracked |
| Auto-memory | `~/.claude/projects/-Users-ryanmahoney--agents/memory/` (outside repo) | Markdown with `name`, `description` frontmatter plus index `MEMORY.md` | Claude Code (agent-written) | Claude Code at session start | 8 files plus index; mtimes 2026-06-21 to 2026-10-11 |
| Scratch | `tmp/` (gitignored, 21 MB) | Logs, text, cloned repos, backups | Spec runs, review sessions, manual clones | Nobody routinely | No cleanup script found |
| Screenshots | `.uishot/` (gitignored, 6.4 MB) | PNG | `uishot` skill, sentinel captures | Humans, agents via `see` | 9 files, 2026-10-07 to 2026-10-10 |
| Finder metadata | `.DS_Store` (5 files) | Binary | macOS Finder | Nobody | Gitignored, none tracked |

### 1. `rules/*.md`

- **Location and naming.** `rules/<topic>-<kind>.md`, flat directory of 12 files. Tracked in git.
- **Format and schema.** No frontmatter. Each file opens with an H1 title carrying a version in parentheses for most, for example `# CTA & Button Wording Guide (v1.1)` (`rules/cta-design.md:1`) and `# Minimal Implementation Guide (v1.0)`. `pr-and-ticket-writing.md`, `verification-and-review.md`, and `engineering-writing.md` open with an unversioned H1 and a prose scope paragraph. Most have a bold "Core rule:" line directly after the title (`rules/ux-states.md:3`, `rules/table-row-design.md:3`). Sections are numbered H2 headings (`rules/form-design.md` uses `## 1. Defaults` through `## 10. Final Test`). The `functionalist-design.md` file is a manifesto with a `**Version:** 1.0` field and does not follow the version-in-title pattern.
- **Purpose.** Reusable guidance an agent applies by topic: UI and copy (`cta-design`, `form-design`, `table-row-design`, `ux-states`, `functionalist-design`, `expressive-design`, `prototype-design`), engineering discipline (`minimal-implementation`, `unit-testing`, `verification-and-review`), and writing (`engineering-writing`, `pr-and-ticket-writing`).
- **Lifecycle and change frequency.** Commits per file (from `git log -- rules/<file>`):

  | File | Commits | First | Last |
  |---|---|---|---|
  | `unit-testing.md` | 4 | 2026-06-12 | 2026-10-08 |
  | `engineering-writing.md` | 2 | 2026-09-26 | 2026-09-28 |
  | `minimal-implementation.md` | 2 | 2026-08-03 | 2026-09-26 |
  | `pr-and-ticket-writing.md` | 2 | 2026-09-18 | 2026-09-26 |
  | `verification-and-review.md` | 2 | 2026-10-04 | 2026-10-08 |
  | `cta-design.md`, `form-design.md`, `functionalist-design.md`, `table-row-design.md` | 1 each | 2026-03-14 | 2026-03-14 |
  | `expressive-design.md` | 1 | 2026-06-13 | 2026-06-13 |
  | `ux-states.md` | 1 | 2026-06-12 | 2026-06-12 |
  | `prototype-design.md` | 1 | 2026-10-11 | 2026-10-11 |

  The four design guides from March have not changed in seven months. The engineering and testing guides change monthly.
- **Writers.** Operator by hand. `skills/rules-from-experts/SKILL.md` is the documented pipeline for turning research into a rules file. Its `references/rules-doc.md` and `scripts/verify_rules_doc.py` check the output shape. The `rules/` files show no sign of machine generation beyond this.
- **Readers.** Claude Code: the `~/.claude/rules/` mirror (see section 2) and the policy that names specific files. The `rules` text appears in session context through that mirror. Codex: `~/.codex/guides/` symlinks and `codex/AGENTS.md`. Skills: 6 tracked files under `skills/` name a rule by its `~/.agents/rules/<file>` path. Counts from grep (path mentions, all skills): `minimal-implementation.md` 5 references, `unit-testing.md` 2, `form-design.md` 2, `cta-design.md` 1, `functionalist-design.md` 1. Humans.
- **Relationships.** `claude/CLAUDE.md` and `codex/AGENTS.md` are the only policy files that name rules, and they name different subsets (see section 3 and 4). Cross-references inside rules: `expressive-design.md` points to `functionalist-design.md`, `ux-states.md`, and `cta-design.md`; `unit-testing.md` points to `verification-and-review.md`.
- **Retention and cleanup.** None. No file in `rules/` is marked deprecated. Nothing prunes the directory.
- **Observations.**
  - `minimal-implementation.md` is read by four spec skills (`spec-architect-critics`, `spec-architect-initial`, `spec-step-run`, `spec-write`) but not named in `claude/CLAUDE.md` or `codex/AGENTS.md`. The rule's only enforcement path is skill text.
  - `prototype-design.md` is named only by `design-plan` and `design-run`. It was added on 2026-10-11, the newest rule file, and does not appear in either policy file.
  - `unit-testing.md` is named in `codex/AGENTS.md` (line 43) and in seven skill files, but not in `claude/CLAUDE.md`. The Claude-side policy does not point to the testing rule that the Codex copy asks for.
  - The versioning convention is inconsistent (`v1.0`, `v1.1`, a `**Version:**` line, and none for three files). Nothing reads the version.
  - `functionalist-design.md` (a manifesto with a quotation footer) is named in the design-application policy for functional surfaces, and `expressive-design.md` defers to it; the boundary is stated only in prose.

### 2. `~/.claude/rules/` mirror (outside the repo)

- **Location.** `/Users/ryanmahoney/.claude/rules/`, 13 directory entries.
- **Format.** Symbolic links, `ln -sfn` to `~/.agents/rules/<file>` (`sync.sh`, Claude Code block).
- **Purpose.** Makes the rule set visible to Claude Code as user-level memory.
- **Lifecycle.** Links created by `sync.sh`, which only adds and replaces links. It does not prune stale rule links.
- **Writers.** `sync.sh`.
- **Readers.** Claude Code.
- **Relationships.** Mirror of section 1. `engineering-standards.md` (created 2026-03-15) is a dangling link to a file that no longer exists in `rules/` and has no history in git.
- **Retention.** Manual removal only.
- **Observations.** One dangling link, `~/.claude/rules/engineering-standards.md`. The file it pointed to was never committed, and `sync.sh` cannot remove it because it only deletes dangling skill links, not rule links. `prototype-design.md` is mirrored (new 2026-10-11 run of `sync.sh`), so the sync was run after that rule was added.

### 3. `claude/CLAUDE.md` and `~/.claude/CLAUDE.md`

- **Location.** Source `claude/CLAUDE.md` (tracked, 4130 bytes). Target `/Users/ryanmahoney/.claude/CLAUDE.md`, copied by `sync.sh`. The two files are byte-identical at audit time (`cmp` succeeds).
- **Format.** Markdown with H2 sections: "External Rules Source", "Design Rule Application Policy", "Verification and Review", "Spec Artifacts and Worktrees", "Engineering Writing", "PR and Ticket Writing", "Symlinked Rules Mirror", "Sync Command", "Attribution Policy" (`claude/CLAUDE.md`, section headers).
- **Purpose.** Session-start policy: tells Claude where the rules live, the precedence order (system, repository, then `~/.agents/rules`), when to load each guide, and the attribution rule for commits and PRs.
- **Lifecycle.** 1 commit per change; last modified 2026-10-08.
- **Writers.** Operator. `sync.sh` copies to the live location; the policy's own "Sync Command" section requires running `~/.agents/sync.sh` after edits.
- **Readers.** Claude Code.
- **Relationships.** Names the rules `functionalist-design.md` (line 32), `verification-and-review.md` (line 37), `engineering-writing.md` (line 52), `pr-and-ticket-writing.md` (line 57), and the spec-skill reference `workspace-handoff.md` (line 46). It does not name `cta-design.md`, `form-design.md`, `ux-states.md`, `unit-testing.md`, `minimal-implementation.md`, or `prototype-design.md`; it relies on the design-policy paragraph to mention "design/copy guides" in general.
- **Retention.** Not applicable.
- **Observations.** The live file and the source are in sync, so `sync.sh` ran after the last edit. The policy says design guidance is applied "by default" for UI and copy work, but the named guides are not listed, so an agent must infer which files to read from the mirror listing.

### 4. `codex/AGENTS.md` and `~/.codex/AGENTS.md`

- **Location.** Source `codex/AGENTS.md` (tracked, 4169 bytes), copied to `~/.codex/AGENTS.md` by `sync.sh` when `~/.codex` exists (it does).
- **Format.** Same structure as CLAUDE.md with Codex wording. Opens with "# Global Codex Instructions" and has an "Instruction Type Clarification" section stating that rule files are context, not `.rules` approval files (lines 3-5).
- **Purpose.** Same policy for Codex, with a separate design-guide list.
- **Lifecycle.** Last changed 2026-10-08, the same commit as CLAUDE.md.
- **Writers.** Operator, `sync.sh`.
- **Readers.** Codex.
- **Relationships.** Lists six design guides (lines 14-19): `cta-design`, `form-design`, `table-row-design`, `functionalist-design`, `expressive-design`, and `ux-states`. Does not list `prototype-design.md`, which `design-plan` and `design-run` require. Names `unit-testing.md` (line 43) and `engineering-writing.md` (line 57), which CLAUDE.md does not name in the same way.
- **Observations.** The two policy files have diverged in content, not only wording. The Codex design list is missing `prototype-design.md`, and the Claude policy is missing `unit-testing.md` and the design guide list. Keep one canonical list or generate both from the same source. `sync.sh` writes both with `cp`, so there is no shared template.

### 5. `augment/agents/` and Augment mirror

- **Location.** `augment/agents/spec-step-implementer.md` (tracked, single file). `~/.augment/agents/` symlinks it when `~/.augment` exists or `SYNC_AUGMENT=1` (`sync.sh`, Augment block).
- **Format.** Markdown with YAML frontmatter: `name`, `description`, `model` (`sonnet4.5`), `color` (`blue`).
- **Purpose.** Subagent definition for Augment CLI that implements one prepared step.
- **Lifecycle.** Single file; change history not checked.
- **Writers.** Operator.
- **Readers.** Augment CLI.
- **Relationships.** Parallel to the Pi subagent definitions under `pi/agents/` (not in this audit's scope).
- **Observations.** The `model` value `sonnet4.5` is a fixed model name in a file that other harnesses share the spec workflow with; it is not checked against the current model list.

### 6. `sync.sh` (distribution)

- **Location.** `/Users/ryanmahoney/.agents/sync.sh`, tracked, executable.
- **Format.** Bash with two helper functions: `sync_dir_symlinks` (skills; prunes dangling symlinks that point into the source tree) and `sync_file_symlinks` (rules and agents; prunes dangling links the same way). Each harness has a block gated on its home directory existing.
- **Purpose.** Installs one set of skills, rules, instructions, and subagents into Claude Code, Codex, Cline, Pi, Augment, and OpenCode.
- **Targets by harness.**
  - Claude Code: `claude/CLAUDE.md` is copied to `~/.claude/CLAUDE.md`; `rules/*` symlinked to `~/.claude/rules/`; `skills/*` symlinked to `~/.claude/skills/`.
  - Codex: `codex/AGENTS.md` copied; `rules/*` symlinked into `~/.codex/guides/`; skills to `~/.codex/skills/`.
  - Cline: skills to `~/.cline/skills/`.
  - Pi: `pi/agents/*` to `~/.pi/agent/agents/`; `pi/extensions/*/` to `~/.pi/agent/extensions/` (fails if a real directory is in the way).
  - Augment: skills to `~/.augment/skills/`; `augment/agents/*` to `~/.augment/agents/`.
  - OpenCode: rules to `~/.opencode/rules/`; skills to `~/.opencode/skills/`.
- **Lifecycle.** Stable; last modified 2026-10-05.
- **Writers.** Operator runs it. Its own text says the Claude policy changes require a run.
- **Readers.** Bash.
- **Relationships.** Source for every mirror listed in the overview table. Copies, not symlinks, for the two policy files. Only skills and agents get pruning.
- **Retention.** Prunes only dangling links that point into the source tree; no cleanup for the rule mirrors, which is why `engineering-standards.md` persists (section 2).
- **Observations.** `~/.claude/skills` has 92 entries against 84 skill directories here, so 8 or more entries come from another source. This audit did not trace them. The script's pruning rule matches on `"$source_dir"/*` prefix, so links to the same skill name from another location are kept.

### 7. `skills/*/SKILL.md` frontmatter

- **Location.** `skills/<name>/SKILL.md`, 84 files, all tracked. `skills/` also holds a `.DS_Store`, which is ignored.
- **Format.** YAML frontmatter between `---` lines at the top of the file, followed by Markdown. Example from `skills/spec-run/SKILL.md:1-13`:
  - Required on all 84: `name` (matches the directory name in every case; the check found no mismatches), `description` (double-quoted in most), `metadata` with `author`, `homepage`, and `version` (quoted string such as `"37"`).
  - Present on 71: `license` (`MIT`).
  - Present on 65: `disable-model-invocation: true`. The other 19 are model-invocable.
  - Present on 55: `argument-hint` (quoted string, e.g. `"[.specs/<feature>/spec.md or spec folder]"`).
  - Present on 15: `mode: coding` and `scope: document` (same values in all 15).
  - Under `metadata`: `framework` appears only on `axi-checker`; `source` and `standard` only on `simple-english`. `version` is `"1"` on 43 skills, `"2"` on 16, `"4"` on 6, and higher on the rest.
- **Purpose.** Harness discovery: `name` and `description` decide whether a skill loads; `disable-model-invocation` keeps it slash-only; `argument-hint` documents the slash arguments.
- **Lifecycle.** Each change to a skill is one commit. The `metadata.version` field is manually bumped; it has no matching tag or changelog.
- **Writers.** Operator by hand. `skills/skill-factory/SKILL.md` creates new skills from a codebase; it is `disable-model-invocation: true`.
- **Readers.** Claude Code, Codex, Augment, Cline, OpenCode (symlinked trees); Pi via its extensions; `scripts/lint-skills.sh` (not reviewed).
- **Relationships.** Each skill body links to `references/`, `scripts/`, and `agents/`. Skills name rules by path (section 1). Many skills name other skills in prose (`spec-run` references `spec-end-to-end`).
- **Retention.** Removed skills are deleted in git. About 27 skill directories were deleted over the history, including `spec`, `spec-run`, `spec-step-review`, `spec-step-fix`, `spec-step-judge`, `spec-review`, `spec-audit`, `design-spec-*` (five), `spec-run-glm`, `spec-run-glm-mimo`, `spec-run-glm-deepseek`, `spec-run-kimi-stepfun`, `spec-run-deepseek-longcat`, `branch`, `pr`, `run`, and `codex-review-fix`.
- **Observations.** The `metadata.version` values are not used by any reader found. `mode` and `scope` appear on only 15 skills: `spec-architect-initial`, `spec-architect-critics`, `spec-branch`, `spec-branch-refine`, `spec-branch-worktree`, `spec-branch-fix`, `spec-gym`, `spec-gym-extract`, `spec-pr`, `spec-step-run`, `spec-branch-review`, `spec-run`, `spec-subspec-write`, `spec-write`, and `journey-qa`. Both keys have one value across the set (`coding`, `document`), so they do not vary; the keys have no written schema.

### 8. Skill sub-asset folders (`references/`, `scripts/`, `agents/`)

- **Location.** Inside skill directories. Counts from `find`:
  - `references/`: 25 skills, 49 files. Examples: `spec-run/references/scouting.md`, `spec-write/references/`, `ux-auditor/references/`, `journey-qa/references/rubric.md`.
  - `scripts/`: 11 skills, 28 files. Examples: `rules-from-experts/scripts/verify_rules_doc.py`, `see/scripts/`, `uishot/scripts/`, `visualize-journey/scripts/`, `repo-search-setup/scripts/`.
  - `agents/`: 22 skills, each with one `agents/openai.yaml`. Covers the `specops-*` group plus `build-*`, `document-*`, `journey-qa`, `view-journeys`, `visualize-journey`, `uishot`, `spec-end-to-end`, `spec-work-tour`, `spec-upgrade`, `spec-final-review`, `spec-process-improvement`.
- **Format.** Markdown for references; Python, shell, and JS for scripts; YAML for `agents/openai.yaml`.
- **Purpose.** References hold detailed procedures kept out of the main SKILL.md. Scripts hold deterministic steps. `agents/openai.yaml` is an OpenAI-facing UI definition for Codex.
- **Lifecycle.** Tracked with the skill; change counts follow the skill.
- **Writers.** Operator; `skill-factory` and `rules-from-experts` generate the first version.
- **Readers.** The owning SKILL.md, plus the harness for `agents/openai.yaml`.
- **Observations.** Only `agents/openai.yaml` is a non-Markdown config inside a skill, and it is present on 22 of 84 skills, which means the Codex UI metadata is inconsistent across the set. `references/` links use relative paths; no link checker was run.

### 9. Skill families

Counts from the directory listing (84 skills):

| Family | Count | Examples |
|---|---|---|
| `specops-*` | 22 | `specops-analysis`, `specops-make-spec`, `specops-run-spec`, `specops-decompose`, `specops-spec-conformance`, `specops-doc-catchup` |
| `spec-*` (all) | 22 | Workflow: `spec-end-to-end` (30 commits), `spec-run` (45), `spec-step-run` (38), `spec-write` (34), `spec-pr`, `spec-work-tour`, `spec-sentinel`, `spec-message`, `spec-upgrade`, `spec-final-review`, `spec-issue`, `spec-process-improvement`, `spec-subspec-write`. Also the sub-groups below. |
| `spec-branch-*` (within `spec-*`) | 5 | `spec-branch`, `spec-branch-worktree`, `spec-branch-refine`, `spec-branch-review` (29 commits), `spec-branch-fix` (21) |
| `spec-architect-*` and `spec-gym*` (within `spec-*`) | 4 | `spec-architect-initial`, `spec-architect-critics`, `spec-gym`, `spec-gym-extract` |
| `repo-search*` | 5 | `repo-search`, `repo-search-setup`, `repo-search-index`, `repo-search-install`, `repo-search-status` |
| `ux-*` | 4 | `ux-auditor`, `ux-cover-critique`, `ux-information-critique`, `ux-page-critique` |
| `build-*` and `document-*` (journey and screen docs) | 6 | `build-journey-map`, `build-product-brief`, `build-screen-inventory`, `build-permission-model`, `document-journey`, `document-screen-behavior` |
| Journey lifecycle (additional) | 3 | `journey-qa`, `visualize-journey`, `view-journeys` |
| Design packages | 2 | `design-plan`, `design-run` (added 2026-10-11) |
| Other | remainder | `commit`, `pr-review`, `pr-feedback`, `test-audit`, `uishot`, `see`, `simple-english`, `skill-factory`, `rules-from-experts`, `epic-end-to-end`, `repo-status`, `form-modernizer`, `feature-list`, `identify-where`, `bun-test-fix`, `axi-checker`, `architect-inspect`, `angular-pr-complexity`, `controller-refactor-plan`, `agents-update` |

- **Roborev family.** The task named `roborev-*` as a family. No `roborev-*` directory exists under `skills/`, and `grep -r roborev` over `skills`, `rules`, `README.md`, and `docs` returns nothing. The roborev skills listed in the session context are provided from elsewhere and are not part of this repository.
- **Change frequency.** Most spec-workflow skills changed on 2026-10-08 through 2026-10-11. The highest-churn skills are `spec-run` (45 commits, last 2026-10-10), `spec-step-run` (38, 2026-10-10), `spec-write` (34, 2026-10-11), and `spec-end-to-end` (30, 2026-10-11). The `specops-*` set was last changed mostly between 2026-06-21 and 2026-08-23 (`specops-orchestrate-analysis` 7 commits, last 2026-06-29; `specops-decompose` 6, 2026-06-29), and many of its skills have not changed since.
- **Observations.** The `specops-*` family and the `spec-*` family do different jobs on the same `.specs/` contract (`README.md` names both). `docs/spec-workflow.md` and `README.md` describe the `spec-*` workflow in detail; `specops-*` is documented in `README.md` lines 243-258 only.

### 10. `bundles/README.md` and `dist/skill-bundles/` (gitignored)

- **Location.** `bundles/README.md` (tracked, 7806 bytes, 2 commits). `dist/skill-bundles/` (gitignored by `dist/`): directories `spec-skills/`, `specops-skills/`, `augment/`, `pi/`, `rules/`, `scripts/`, `skills/`, `docs/`, plus `bundle.json`, `install.sh`, `README.md`, and archives `*-v2026.06.13.2-<sha>-dirty.tar.gz` and `.zip`.
- **Format.** Bundle README is Markdown; `bundle.json` has `name`, `version`, `description`, `skills` (array), `augment_agents`; archives are tar and zip.
- **Purpose.** Installable skill packages for other machines, produced by `scripts/build-skill-bundles.sh` (`DIST` defaults to `$ROOT/dist/skill-bundles`). Release workflow `.github/workflows/release-skill-bundles.yml` runs on tag push.
- **Lifecycle.** Generated, not committed. Directories and archives were last written 2026-10-06. Three archive generations exist (`85-`, `149-`, `153-g…`, all `-dirty`), and versions are cut from the `v2026.06.13.2` tag base.
- **Writers.** `scripts/build-skill-bundles.sh` (operator-run or tag workflow).
- **Readers.** Human installers via `install.sh`; Pi and Augment via their bundle directories.
- **Relationships.** `bundles/README.md` documents two bundles (`spec-skills` and `specops-skills`). Its skill lists match the current `skills/` names. The bundle directory `dist/skill-bundles/spec-skills/bundle.json` (21 skills) still lists `design-spec-architect`, `design-spec-prototype`, `design-spec-critique`, and `design-spec-writer`, which were deleted from git history and do not exist under `skills/`.
- **Retention.** Keep the latest archive only; no pruning script found. Older archives accumulate in `dist/`.
- **Observations.** The `dist/` build is stale: it predates the removal of `design-spec-*`, and the current `build-skill-bundles.sh` contains no `design-spec` reference, so a rebuild would drop them. `bundles/README.md` does not mention the new `design-plan` and `design-run` skills. Dist is ignored, so an installer that pulls a stale archive will get removed skills.

### 11. `.github/workflows/`

- **Location.** `.github/workflows/release-skill-bundles.yml` (tracked). `.github/` directory created 2026-06-11.
- **Format.** GitHub Actions YAML; trigger `on: push: tags:`.
- **Purpose.** Builds bundles for a release tag.
- **Writers.** Operator.
- **Readers.** GitHub Actions.
- **Observations.** The only workflow. Its outputs are the gitignored `dist/` archives, so release artifacts are not stored in the repo.

### 12. `.claude/` (repo-local)

- **Location.** `/Users/ryanmahoney/.agents/.claude/`, directory exists, empty (0 entries, mtime 2026-10-10).
- **Purpose.** Repo-local Claude Code config directory.
- **Observations.** Empty. Not tracked (git does not track empty directories). It is a leftover from the `.claude/` path that the CLAUDE.md sync would otherwise create; nothing reads it.

### 13. `content/context-and-harness.md`

- **Location.** `content/context-and-harness.md` (tracked, 10696 bytes, mtime 2026-07-12). Parent `content/` holds only this file.
- **Format.** Long-form Markdown essay with H1 title and H2 sections ("The two systems", "Context engineering, line by line"). Cites external sources with inline links.
- **Purpose.** Compares the spec-driven workflow with Bayer's PRINCE knowledge engine as an illustration of "context plus harness" reliability.
- **Lifecycle.** Single write as far as the mtime shows; `git log` on the path was not inspected separately.
- **Writers.** Operator.
- **Readers.** Humans. Not named in `claude/CLAUDE.md`, `codex/AGENTS.md`, or any `skills/*/SKILL.md` (checked by name).
- **Observations.** Editorial content next to operational docs and not linked from the README. It describes the "spec-driven skill suite" in present tense, so it will drift with the skills. Candidate for moving to `docs/` or removing.

### 14. `docs/*.md`

- **Location.** `docs/` (tracked). Eleven Markdown files plus two subdirectories (`docs/research/`, ignored).

  | File | Lines/size | Commits | Last changed | Topic |
  |---|---|---|---|---|
  | `adjacent-architecture.md` | 26 KB | 4 | 2026-10-11 | Sentinel router and adjacent capabilities |
  | `design-packages.md` | 9 KB | 1 | 2026-10-11 | Design packages (design-plan, design-run) |
  | `disk-hygiene.md` | 5 KB | 3 | 2026-10-09 | Reclaiming temp, worktrees, Docker |
  | `product-documentation.md` | 9 KB | 4 | 2026-09-30 | Product-documentation skills |
  | `reviews.md` | 13 KB | 17 | 2026-10-10 | Step reviews, branch audit, work tour |
  | `spec-coding-process-improvements.md` | 15 KB | 4 | 2026-10-10 | Process improvement notes |
  | `spec-epics.md` | 9 KB | 2 | 2026-10-11 | Spec epics |
  | `spec-runtime-observation.md` | 12 KB | 6 | 2026-10-10 | Observing Pi spec runs |
  | `spec-workflow-efficiency.md` | 9 KB | 1 | 2026-10-06 | Reducing repeated workflow work |
  | `spec-workflow.md` | 23 KB | 16 | 2026-10-11 | End-to-end spec workflow |

- **Format.** Markdown, H1 title, prose and tables. No frontmatter.
- **Purpose.** Design and process notes for maintainers and for agents that need context beyond the skills.
- **Writers.** Operator. Some docs are written by agent-run workflows.
- **Readers.** Humans; agents when a skill or rule points to them (`spec-workflow.md` is the main reference).
- **Relationships.** `docs/spec-workflow-efficiency.md` (1 commit, 2026-10-06) and `docs/spec-coding-process-improvements.md` (4 commits, 2026-10-10) overlap on the same topic: efficiency and process changes to the spec runner. `docs/reviews.md` and `docs/spec-runtime-observation.md` overlap with `docs/spec-workflow.md`, and the `spec-workflow.md` file carries the current workflow description.
- **Retention.** Not pruned.
- **Observations.** Two overlapping efficiency documents with different last dates. The newest, `spec-workflow.md`, cites agent names (`spec-clerk`, `spec-final-editor`, `spec-stage-reviewer`, `spec-step-fixer`, `spec-final-reviewer`) that exist as `pi/agents/*.md` files, so those names are current. No doc names a deleted skill, so the removed `spec-*` skills are not referenced by the docs. `docs/product-documentation.md` (last 2026-09-30) describes product-doc skills whose files are `build-*`, `document-*`, and `journey-*`; those names are current.

### 15. `docs/research/` and `research/test-value/` (gitignored)

- **Location.** `docs/research/spec-workflow-efficiency-2026-10-04/` (five files: `00-brief.md`, `01-naming.md`, `02-roster.md`, `03-report.md`, `04-spec-execution-efficiency-rules.md`). `research/test-value/` (six files: `00-brief.md`, `01-naming.md`, `02-roster.md`, `04-test-value-rules.md`, `05-adoption-proposal.md`, `test-value-rationale.md`; there is no `03-*` file).
- **Format.** Numbered Markdown stages from a multi-phase research run; `00-brief` then `01-naming` then `02-roster` then later analysis.
- **Purpose.** Research notes that fed the `unit-testing.md` rule (the `test-value` set) and the spec-efficiency changes (`docs/research/...`).
- **Lifecycle.** `research/` pattern in `.gitignore` also matches `docs/research/`, so both trees are untracked. `research/test-value` mtime 2026-10-02; `docs/research` mtime 2026-10-04.
- **Writers.** Research sessions; `rules-from-experts` uses the same numbered-phase layout.
- **Readers.** No tracked file references either path (`git grep` for `docs/research` and `research/test-value` returns nothing), so the rule text in `unit-testing.md` cannot be traced back to these notes from the repo.
- **Retention.** Not cleaned. Ignored by git, so a fresh clone does not have them.
- **Observations.** The `unit-testing.md` rule and `test-audit` skill cite a "value rubric" that is documented only in these ignored notes. A reader on another machine cannot verify the source. Either commit a shared copy or cite the rule's source inline.

### 16. `README.md`

- **Location.** `/Users/ryanmahoney/.agents/README.md` (tracked, 26673 bytes, 62 commits, last 2026-10-11).
- **Format.** Markdown, H1 "Spec-Driven Agent Skills", tables for principles, file trees (`skills/`, `bundles/`), and workflow sections.
- **Purpose.** Entry point for humans: principles, skill list, install instructions, directory map.
- **Writers.** Operator.
- **Readers.** Humans; agents on first read.
- **Relationships.** Links to `skills/spec-run/references/scouting.md` (line 122), `skills/spec-run/references/owner-routing.md` (line 180), `bundles/`, and the `specops-*` family (lines 243-258). Line 327 states Augment reads `~/.agents/skills/` directly.
- **Observations.** README does not state the skill count; a reader cannot tell from it whether the list is current without listing the directory. The principle table (lines 56-62) repeats policy text from `rules/verification-and-review.md` and `rules/unit-testing.md` in summary form, so it can drift from those files.

### 17. Auto-memory (outside the repo)

- **Location.** `/Users/ryanmahoney/.claude/projects/-Users-ryanmahoney--agents/memory/`. Not under git. Nine markdown files: `MEMORY.md` (index, 8 lines) plus eight topic files.
- **Format.** Topic files open with frontmatter `name` and `description` (checked on all eight). No `type` key appeared in the first five lines. `MEMORY.md` is a bullet list of `[Title](file.md) - summary` entries.
- **Purpose.** Persistent operator preferences and project facts: deterministic vs LLM balance, roborev internals, spec-branch skill rules, PR messages, test strategy, epic tracking, design packages.
- **Lifecycle.** Mtimes from 2026-06-21 to 2026-10-11. Newest are `design-packages.md` and `epic-tracking-branch.md` (2026-10-11). `MEMORY.md` mtime 2026-10-11 12:06.
- **Writers.** Claude Code, under operator direction.
- **Readers.** Claude Code at session start.
- **Relationships.** Several memories duplicate policy in `rules/` (`tests-strategic-ci-is-operators.md` vs `rules/unit-testing.md` and `rules/verification-and-review.md`; `pr-body-argues-merge-readiness.md` vs `rules/pr-and-ticket-writing.md`). The memory index links all resolve (checked).
- **Retention.** Manual. No cap on index length.
- **Observations.** Duplicated guidance is the main risk: if a rule changes, the memory copy does not. `spec-branch-skills-are-leaf-no-orchestration.md` and `roborev-review-internals.md` describe tools whose skill files are no longer in this repo (`roborev-*`, `spec-branch-*`), so they describe behavior outside this corpus.

### 18. `tmp/` (gitignored, 21 MB)

- **Location.** `/Users/ryanmahoney/.agents/tmp/`, mtime 2026-10-10. Gitignored by `tmp/`.
- **Contents (names and size only).**
  - `.specs/328-workspace-root-resolution` (a spec-folder remnant from a run, gitignored `.specs/` mirror).
  - `orchestrator-start.log` (805 KB, 2026-10-05), `step-owner.log` (940 KB, 2026-10-05), `step-editor.log` (244 KB, 2026-10-05): spec-run orchestrator logs. Contents not read.
  - `session-for-step.txt` (524 KB, 2026-10-05): a saved Pi session transcript for one step.
  - `spec-agent-workflow.html` (39 KB, 2026-10-05): a rendered workflow diagram.
  - `spec-diagram-build/` (15 MB, includes `node_modules`): a diagram build with compiled CSS and PNG screenshots.
  - `superpowers/` (2.5 MB, 2026-10-10): copy of a third-party repository (contains `AGENTS.md`, `LICENSE`, `.claude-plugin`, `.codex-plugin`) with no `.git`. Provenance is inferred from the `review-skills-review*.md` notes of June 20; not confirmed.
  - `ai-code-review-skills/`: copies of third-party repos (`hamilton-greene_hamy`, `joshua-mcdonald_spec-driven`, `roborev-code-review-skills`, `vikas-sah_vibe-guard`) with no `.git`; contains `.DS_Store` files. Provenance inferred from the June 20 review notes.
  - `files (2)/`: contains a `ux-page-critique.skill` file and a `rubric.md`; looks like a manual download copy of the ux-page-critique skill.
  - `jev-config-backup-20261004-184818/` (292 KB, 2026-10-04): contains `claude-config.json` and `codex-config.toml`. These are config backups and may contain credentials; contents deliberately not read.
  - `agent-docs-implementation-plan.md` (24 KB, 2026-06-21), `review-skills-review.md` and `review-skills-review-2.md` (June 20).
- **Writers.** Spec-run and review agents (logs, transcripts, diagrams), the operator (clones and backups), and session tooling (`.specs/` remnant).
- **Readers.** Nobody routinely; the logs are read only when debugging a run.
- **Relationships.** `orchestrator-start.log`, `step-owner.log`, and `step-editor.log` cover the same period as the `spec-run` and `spec-end-to-end` changes.
- **Retention and cleanup.** No cleanup script covers `tmp/`. `docs/disk-hygiene.md` (2026-10-09) is the only maintained note on it, and this audit did not verify whether that doc's procedure covers these paths.
- **Observations.** Largest pieces are `spec-diagram-build/` (15 MB) and the two logs (about 1.1 MB combined). The `jev-config-backup` folder is a credential-risk item: confirm it is needed, then remove or move it out of the workspace. The third-party clones (`superpowers`, `ai-code-review-skills`) are reference copies without provenance metadata. Both can be deleted once their review notes are recorded.

### 19. `.uishot/` (gitignored, 6.4 MB)

- **Location.** `/Users/ryanmahoney/.agents/.uishot/`, gitignored. `skills/uishot/SKILL.md:30` says to add `.uishot/` to a project's `.gitignore`; this repo's `.gitignore` covers it.
- **Format.** PNG screenshots, 9 files, sizes 227 KB to 2.3 MB.
- **Naming.** Auto-named by the uishot skill (`SKILL.md:121`, `:139`): a URL-derived name (`127-0-0-1-4319-233032.png`), a file-path-derived name (`file-users-ryanmahoney-agents-specs-adj3-211041.png`), or a manual name (`sentinel-desktop-final.png`, `sentinel-mobile.png`). The trailing six digits are HHMMSS.
- **Writers.** The `uishot` skill (the 2026-10-07 and 2026-10-10 captures). The `sentinel-*` captures (2026-10-08) are not named by the skill and were probably taken by hand.
- **Readers.** Humans; `see` skill when an agent needs to view one.
- **Retention.** No cleanup script found.
- **Observations.** Two of the files have "final" in the name and two others do not; no version naming scheme. Screenshots from 2026-10-07 and 2026-10-10 are from prior UI iterations and are likely superseded.

### 20. `.DS_Store` files

- **Location.** `./.DS_Store`, `./.specs/.DS_Store`, `./skills/.DS_Store`, `./tmp/ai-code-review-skills/.DS_Store`, `./tmp/ai-code-review-skills/joshua-mcdonald_spec-driven/.DS_Store`. Five files.
- **Tracking.** Gitignored (`.DS_Store` pattern); zero tracked.
- **Writers.** macOS Finder.
- **Readers.** Nobody.
- **Retention.** Can be deleted at any time; Finder recreates them.
- **Observations.** Harmless. The two nested copies under `tmp/` come from third-party clones.

### Cross-cutting observations

1. **Two policy files, two rule lists.** `claude/CLAUDE.md` and `codex/AGENTS.md` name different rule subsets and disagree on design guides and the testing rule. Nothing checks that they agree.
2. **Generated distribution is stale.** `dist/skill-bundles` still ships `design-spec-*` skills removed from `skills/`. The gitignored `dist/` has no check that it matches current source.
3. **Mirror cleanup is asymmetric.** Skill links are pruned on sync; rule links are not. This leaves `engineering-standards.md` dangling in `~/.claude/rules/`.
4. **Ignored research is cited as authority.** `unit-testing.md` depends on value-rubric notes in `research/test-value/`, which are gitignored and absent on other machines.
5. **Duplicated guidance in memory.** Memory files repeat policy text from `rules/`; no link or check keeps them aligned.
6. **Scratch growth.** `tmp/` (21 MB) and `.uishot/` (6.4 MB) have no cleanup routine. `tmp/jev-config-backup-*` may hold credentials and should be reviewed.
7. **Count drift.** README and bundles docs do not state the skill count; the count itself (84 skill directories; 92 entries in `~/.claude/skills`) is only available by listing.


---

