---
name: repo-search-setup
description: Prepare local repository search for a Git checkout in one invocation using existing pinned model assets. Copies model files outside Git, installs locked dependencies, builds the first index, and optionally enables spec use. Use when asked to set up or first index a repository; it does not download models.
argument-hint: "[checkout] [--models-from PATH] [--spec-use on]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Repo search setup

Use the bundled setup script for a first index. It copies the six verified model
assets to an external user directory, then calls the existing install and build
commands. Model and index destinations must be outside **every** Git repository;
never add model files, indexes, or generated state to a repository or its history.

<!-- repo-search-helper -->
## Resolving the helper

Resolve the repo-search helper directory without using the target repository cwd,
in this priority order:

1. `$REPO_SEARCH_HELPER` when that directory contains `cli.mjs`.
2. `~/.agents/scripts/repo-search` when it contains `cli.mjs` (canonical
   copied-install helper location).
3. The sibling source package `<this-skill-dir>/../../scripts/repo-search` when
   it contains `cli.mjs`.

If none contains `cli.mjs`, report that optional repository search is not
installed, point at the `repo-search-install` skill, and continue with ordinary
spec tools. Never install, download, build, or enroll as a side effect. Run every
command as `node "<helper>/cli.mjs" ...`.
<!-- /repo-search-helper -->

## Run

Resolve the requested checkout, or use the current Git checkout. Find an existing
model root from the user's path, `REPO_SEARCH_MODELS`, or known session context.
It must contain `jinaai/jina-embeddings-v2-base-code/` with the pinned files.
If neither that root nor an already prepared external destination is available,
ask for an existing model root. Do not download assets or guess a source.

```bash
bun --no-install "<this-skill-dir>/scripts/setup.mjs" \
  --root <checkout> --models-from <existing-root> [--spec-use on]
```

`--root` defaults to the current checkout. `--models-from` is optional after the
external copy exists; `--models-to` and `--state` override the default external
locations. Use `--spec-use on` when the operator wants spec or sentinel search;
building alone does not grant that opt-in. The script is idempotent for a ready
index. It refuses an existing damaged model copy or current index rather than
replacing either implicitly. Report the final status and any prerequisite.

The default model destination is `~/.local/share/agent-repo-search/models` and
the index state is `~/.cache/agent-repo-search`. The model source may be inside
another repository; setup only reads it and stores its own verified copy outside
Git. If source model files were committed previously, setup cannot remove that
history; report that separately when observed.
