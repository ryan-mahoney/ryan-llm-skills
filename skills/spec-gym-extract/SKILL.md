---
name: spec-gym-extract
description: "Extract a draft spec-gym scenario from a real package and Git revision without modifying the source. Use to seed the curated scenario library from an existing package, then curate expectation sources and checks before promotion to ready."
mode: coding
scope: document
disable-model-invocation: true
argument-hint: "--source .specs/<feature> --repo DIR --revision REV --skill NAME --id ID [--step N] [--include PATH]..."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Spec Gym Extract

Create a new `scenarios/<skill>/<id>/` draft from a real package and a pinned Git
revision. Extraction reads only; it never runs a model, never edits a source, and
never commits. It refuses a destination that overlaps the source package or
repository, including through linked parents, so run it from a separate gym
checkout.

```bash
node scripts/spec-gym/cli.mjs extract --source <source-repo>/.specs/<feature> \
  --repo <source-repo> --revision <rev> --skill <spec-skill> --id <scenario-id> \
  [--step N] [--include PATH]...
```

## Read-only guarantee

The source package digest and the source repository `git status --porcelain` stay
unchanged. Git access is limited to read subcommands (`rev-parse`, `ls-tree`,
`show`); repository inputs come only from the pinned revision, never the working
tree. Post-stage artifacts such as `learnings/`, `reviews/`, `runtime/`,
`evidence/`, `history-index.json` and `inbox/` are outside every profile and are
never copied.

## Stage profiles

- `spec-architect-initial` (`leaf`) copies `requirements.md` and `context.md` from
  the source package, plus `../project-context.md` to `input/project-context.md`.
- `spec-step-run` (`managed-step`, requires `--step`) copies the prepared set
  (`context.md`, `spec.md`, `spec-prepare.md`, `evidence-plan.json`,
  `spec-steps.json`, `../project-context.md`), `criteria.md`/`invariants.md` when
  present, and every indexed `step-NNN-subspec.md` card.

Other skills fail fast as unsupported stage profiles.

## Includes and denylist

Each `--include <path>` is read with `git show <revision>:<path>` and written under
`input/repository/<path>`. Denylisted paths are refused: `.env`, `.env.*`, `*.pem`,
`*.key`, `auth.json`, `id_rsa*`, anything under `node_modules/` or `.git/`. A path
absent at the revision is recorded in `missing_inputs` and the scenario is written
as `draft`.

## Sanitization and curation

Copied package Markdown and `project-context.md` have the absolute source package
path and `$HOME` rewritten to `<SOURCE_PACKAGE>` and `<HOME>`; the rewrite count is
recorded in `scenario.json.source.rewrites`. Repository files are byte-exact.
Content inside allowed files can still be private: review every copied file before
promotion, and extract only from trusted local sources.

## Promotion to ready

Extraction seeds `draft` checks, including `todo: true` placeholders. Promote in
this order:

1. Replace the seeded checks with checks that cite `expectation_sources`, fill the
   sources, and resolve every `missing_inputs` entry.
2. Set `status: ready`.
3. Track every file under the scenario folder with Git (for example
   `git add scenarios/<skill>`); ready validation refuses untracked fixture files.
4. Regenerate the index:
   `node scripts/spec-gym/cli.mjs validate --skill <skill> --write-index`.
5. Require a final `node scripts/spec-gym/cli.mjs validate --skill <skill>` to
   pass with no drift.

The index is generated; never hand-edit `scenarios.md`.
