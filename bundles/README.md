# Skill Bundles

This directory documents the distributable skill bundles generated from this repo.

The build script creates portable bundle directories plus `.tar.gz` and `.zip`
archives under `dist/skill-bundles/`. Generated artifacts are not committed.

## Bundles

### spec-skills

The spec-driven development workflow:

- `spec-architect-initial`
- `spec-architect-critics`
- `spec-write`
- `spec-review`
- `spec-branch`
- `spec-branch-worktree`
- `spec-run`
- `spec-dev-workflow`

Includes the Augment CLI subagent adapter:

- `augment/agents/spec-step-implementer.md`

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
