---
name: repo-search
description: "Discover relevant code in an enrolled checkout with the optional local repo-search engine. Use for bounded behavioral discovery when an exact rg query is not enough, and when the operator asks to search a repository semantically. Read-only: it never builds, installs, configures, or refreshes an index."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# repo-search

Bounded, read-only semantic discovery over an already-enrolled checkout.

## Authority and effects

- This skill only queries. It never runs `build`, `update`, `reindex`, `install`,
  or `configure`, and it never enrolls or refreshes anything.
- An empty candidate list is not evidence of absence; never claim a behavior is
  missing from an empty result.
- Exact literals, symbol names, and existence/absence checks still use `rg`.
  Query this engine for behavioral discovery, not exact-string lookup.

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

## Commands

Check readiness first:

```bash
node "<helper>/cli.mjs" status --root <checkout> [--state <root>] --json
```

Search when the checkout is ready:

```bash
node "<helper>/cli.mjs" search --root <checkout> --query <text> [--mode vector|bm25] [--limit 1..20] [--state <root>] [--models <root>] [--json]
```

- `--mode` defaults to vector; use `bm25` when no model should load.
- `--limit` is 1..20.
- Read the receipt: `unavailable` reasons such as `unenrolled`,
  `model-unavailable`, or `busy` mean fall back; report the prerequisite rather
  than retrying.

## Source follow-through

For every returned hit, read the actual file and verify the returned path and
line range before relying on it. Omit hits whose bytes changed, disappeared, or
were never eligible. Report which findings came from excerpts and which came from
fresh source reads.
