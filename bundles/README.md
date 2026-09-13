# Skill Bundles

This directory documents the distributable skill bundles generated from this repo.

The build script creates portable bundle directories plus `.tar.gz` and `.zip`
archives under `dist/skill-bundles/`. Generated artifacts are not committed.

## Bundles

The build emits two installable bundles. `spec-skills` contains both architecture
and design authoring because they use the same standalone `.specs/<feature>/`
filename contract for preparation and execution.

### spec-skills

The spec-driven development workflow plus the design-spec front-half:

- `spec-end-to-end`
- `spec-architect-initial`
- `spec-architect-critics`
- `spec-write`
- `spec-subspec-write`
- `spec-prepare`
- `spec-branch`
- `spec-branch-worktree`
- `spec-run`
- `spec-step-run`
- `spec-branch-refine`
- `spec-branch-review`
- `spec-branch-fix`
- `spec-work-tour`
- `spec-pr`
- `spec-issue`
- `design-spec-architect`
- `design-spec-prototype`
- `design-spec-critique`
- `design-spec-writer`

Includes the Augment CLI subagent adapter:

- `augment/agents/spec-step-implementer.md`

`spec-branch` and `spec-branch-worktree` ship as backwards-compatible convenience utilities; the
end-to-end orchestrator manages ordinary branch/worktree setup directly.

Use `spec-end-to-end` to have one top-level agent run this complete sequence through pull-request publication, including explicit worktree or delegation modifiers.

The archive includes `docs/spec-workflow.md` and `docs/reviews.md`. The
[workflow guide](../docs/spec-workflow.md) covers quick starts, goal-mode operation, resuming stale
stages, compact handoffs, and OpenCode nested workers. The [audit guide](../docs/reviews.md) explains
the required evidence and independent review. These guides remain in the extracted archive; the
installer installs skills and supporting runtime resources, not documentation into target projects.

The generated `spec-skills` README also includes a stage-by-stage overview:

1. Start with `spec-architect-initial` and a clear goal.
2. Optionally run `spec-architect-critics` to challenge the architecture.
3. Run `spec-write` to create `spec.md` and the machine step index.
4. Run `spec-prepare` to ground and correct the spec, derive prose guardrails, plan each step, and publish the manifest.
5. Let the top-level agent establish a branch or worktree and preserve the matching `.specs` feature package.
6. Execute the immutable prepared package with `spec-run`.
7. Run `spec-branch-refine` to review and fix the integrated branch to convergence.
8. Run `spec-work-tour` to produce the commit-bound evidence and deployment verdict.
9. Publish with `spec-pr`.

`spec-issue` remains an optional standalone GitHub mirror and does not participate in this sequence.

It also includes the design-spec front-half:

1. Run `design-spec-architect` to propose a design direction.
2. Optionally run `design-spec-prototype` and `design-spec-critique`.
3. Run `design-spec-writer`.
4. Pass the existing spec to `spec-end-to-end`, or run the same preparation, workspace, execution, refinement, tour, and PR stages separately.

### specops-skills

Every skill whose directory name starts with `specops-`.

The decomposition-first agent documentation flow writes:

- `docs/specops/targets.json` — deterministic target manifest and freshness spine.
- `docs/specops/analysis/<slug>.md` — deep implementation-agnostic analysis.
- `docs/specops/agents/<slug>.md` — compressed target doc an agent should read first.
- `AGENTS.md` — compact generated index between `<!-- agents-docs:start -->` and `<!-- agents-docs:end -->`.

The commit-history skills add a coverage ledger and history-derived docs under `docs/specops/history/`:

- `ledger.jsonl` / `frontier.json` — append-only commit-coverage ledger and per-lens frontier (`doc`, `intent`, `rework`), backed by `scripts/commit-ledger.mjs`. Committed, so coverage survives squash-merge.
- `decisions/active.md` / `decisions/superseded.md` — product decisions reconstructed from history, with abrogated decisions moved aside.
- `rework.md` — rework hotspot report and a non-blame Context Map of who to consult.

Bootstrap structured docs:

1. Run `specops-decompose` to produce `docs/specops/targets.json`, the stable target manifest.
2. Run `specops-orchestrate-analysis` so the in-harness orchestrator calls `specops-analysis` once per manifest target, writes deep specs, creates compressed target docs, and refreshes the root `AGENTS.md` index.

Refresh a branch or PR:

1. Run `specops-branch-refresh` so changed files refresh the affected analysis docs, compressed agent docs, manifest freshness fields, and AGENTS index. It also records `doc` coverage in the ledger.

`specops-agent-docs` and `specops-index-agents` are leaf utilities normally called by the orchestrators, but they can be run manually to repair compressed docs or the generated index.

Understand changes and past decisions:

1. Run `specops-doc-catchup` to document any commits the ledger shows as uncovered (or `--status` to just report them); after a squash/rebase, `node scripts/commit-ledger.mjs reconcile <repo>` re-anchors the frontier.
2. Run `specops-decision-ledger` to reconstruct active and superseded product decisions by walking history (via the `specops-intent-extract` leaf).
3. Run `specops-rework-audit` to surface rework hotspots and who holds the context.

`specops-intent-extract` is a leaf used by `specops-decision-ledger`. The deterministic `scripts/commit-ledger.mjs` (commit coverage, churn, frontier reconciliation) ships in the `specops-skills` bundle.

The legacy initial-plan mode in `specops-orchestrate-analysis` remains available as a fallback, but the manifest-driven path is the documented pipeline for new multi-target agent docs automation.

## Build

```bash
scripts/build-skill-bundles.sh
```

To stamp a release version into the artifacts:

```bash
VERSION=2026.06.11 scripts/build-skill-bundles.sh
```

## Release

Pushing a `v*` tag runs the GitHub Actions release workflow:

```bash
git tag v2026.06.11
git push origin v2026.06.11
```

The workflow builds versioned `.tar.gz` and `.zip` files for both bundles,
generates `SHA256SUMS`, and attaches them to the GitHub Release for the tag.

## Install A Built Bundle

After extracting an archive, run the bundle's installer:

```bash
./install.sh
```

The default target is `~/.agents/skills/`, which is the most portable location
for clients that support Agent Skills. Use `./install.sh --help` inside the
bundle for harness-specific targets.
