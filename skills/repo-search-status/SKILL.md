---
name: repo-search-status
description: Diagnose the optional local repo-search installation and perform explicitly requested recovery, forget, and prune. Use when the operator asks for status, check, forget, prune, or recover.
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# repo-search-status

Diagnosis and explicitly-requested recovery.

## Commands

```bash
node "<helper>/cli.mjs" status --root <checkout> [--state <root>] [--json]
node "<helper>/cli.mjs" check --root <checkout> [--state <root>] [--json]
node "<helper>/cli.mjs" forget --root <checkout> [--state <root>] [--json]
node "<helper>/cli.mjs" prune [--state <root>] [--json]
node "<helper>/cli.mjs" recover --operation <uuid> [--state <root>] [--json]
```

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

## Effects

Run these only when the operator explicitly asks. `status` and `check` are
read-only. `forget` refuses an active writer and removes only this
registration/current reference. `prune` is bounded and never deletes by age
alone. `recover` releases only definitively abandoned recorded operations and
never signals an unrelated process.
