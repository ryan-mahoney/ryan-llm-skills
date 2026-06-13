# Skill Bundles

This directory documents the distributable skill bundles generated from this repo.

The build script creates portable bundle directories plus `.tar.gz` and `.zip`
archives under `dist/skill-bundles/`. Generated artifacts are not committed.

## Bundles

The build currently emits two installable bundles, not three. `spec-skills`
contains two workflow front-halves because the design-spec skills depend on the
same `.specs/<feature-slug>/` contract and engineering back-half as the
spec-driven workflow.

### spec-skills

The spec-driven development workflow plus the design-spec front-half:

- `spec-architect-initial`
- `spec-architect-critics`
- `spec-write`
- `spec-subspec-write`
- `spec-review`
- `spec-criteria`
- `spec-branch`
- `spec-branch-worktree`
- `spec-run`
- `spec-audit`
- `spec-remediate`
- `design-spec-architect`
- `design-spec-prototype`
- `design-spec-critique`
- `design-spec-writer`
- `design-spec-review`

Includes the Augment CLI subagent adapter:

- `augment/agents/spec-step-implementer.md`

The generated `spec-skills` README includes a workflow overview covering:

1. Start with `spec-architect-initial` and a clear goal.
2. Optionally run `spec-architect-critics` to challenge the architecture.
3. Run `spec-write` to create `.specs/<feature-slug>/spec.md`.
4. Run `spec-review` for difficult changes or handoffs.
5. Run `spec-criteria` to compile the frozen spec into a conformance checklist (before implementation).
6. Create a branch/worktree with `spec-branch` or `spec-branch-worktree`.
7. Execute with `spec-run`.
8. Run `spec-audit` to verify the implementation against the compiled checklist.
9. Run `spec-remediate` to close any audit findings, then re-audit until clean.

It also includes the design-spec front-half:

1. Run `design-spec-architect` to propose a design direction.
2. Optionally run `design-spec-prototype` and `design-spec-critique`.
3. Run `design-spec-writer` and `design-spec-review`.
4. Hand off to the same `spec-criteria` / `spec-run` / `spec-audit` back-half.

### specops-skills

Every skill whose directory name starts with `specops-`.

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
