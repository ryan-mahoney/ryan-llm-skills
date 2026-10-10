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

Prepare one checkout for optional local search with the bundled script. It
copies six pinned model assets to an external user directory, installs the
locked search dependencies, builds the first index, and optionally enables
spec use. It does not acquire model assets.

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

If the helper itself is absent, the optional private repo-search bundle must be
installed first; the low-level install command also needs that helper.

## Run

Resolve the requested checkout, or use the current Git checkout. Use an existing
model root supplied by the user, `REPO_SEARCH_MODELS`, or known session context.
The root is the **parent** of `jinaai/jina-embeddings-v2-base-code/`. If neither
a source root nor an already prepared external copy exists, ask for a source
path. Do not download or guess model assets.

```bash
bun --no-install "<this-skill-dir>/scripts/setup.mjs" \
  --root "$checkout" --models-from "$model_root"
```

Omit `--models-from` when the external copy already exists. Add `--spec-use on`
when the operator asks to use search from spec tooling. The wrapper locates and
invokes the helper; the command above is the setup entry point. A zero exit
prints the checkout, external model and state roots, current generation, and
spec-use flag. Report those fields. On failure, report the reason; do not delete
an existing model copy or replace a current index implicitly.

The script rejects model or index destinations inside any Git repository,
including `.git`. Its defaults are
`~/.local/share/agent-repo-search/models` and
`~/.cache/agent-repo-search`. The source may be in a repository: setup reads it
and copies the assets outside Git. If source assets were already committed,
report that separately; copying cannot remove existing history.

Read [the setup and recovery guide](references/setup-and-recovery.md) when
giving an operator a shell command, explaining effects or prerequisites, or
handling a failed setup.
