---
name: repo-search-index
description: Build, incrementally update, reindex, and opt in or out of an optional local repo-search index using an already available model root. Use for manual index maintenance; use repo-search-setup for first-time end-to-end setup.
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# repo-search-index

One lifecycle owner for explicit indexing and opt-in.

For a first usable checkout index with model files kept outside Git, use
`repo-search-setup`.

## Commands

First explicit build:

```bash
node "<helper>/cli.mjs" build --root <checkout> --models <existing-root> [--state <root>] [--json]
```

Incremental update (never falls back to a cold build):

```bash
node "<helper>/cli.mjs" update --root <checkout> --models <existing-root> [--state <root>] [--json]
```

Explicit full reindex (preserves the prior current until publication):

```bash
node "<helper>/cli.mjs" reindex --root <checkout> --models <existing-root> [--state <root>] [--json]
```

Bounded content check (no embedding):

```bash
node "<helper>/cli.mjs" check --root <checkout> [--state <root>] [--json]
```

Spec-use opt-in/out (requires an existing enrollment):

```bash
node "<helper>/cli.mjs" configure --root <checkout> --spec-use on|off [--state <root>] [--json]
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

Building never enables spec use. Query and status never build. A failed
build/update/reindex leaves the previous current generation intact; repair with
an explicit reindex rather than an implicit cold build.
