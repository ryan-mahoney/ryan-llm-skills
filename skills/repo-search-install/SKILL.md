---
name: repo-search-install
description: Install or repair the optional repo-search package dependencies and register an existing local model root without indexing. Use for package maintenance; use repo-search-setup for a first checkout index. Never downloads assets or enables spec use.
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# repo-search-install

Explicit operator setup for the optional package.

For a first usable checkout index, use `repo-search-setup`; this skill handles
only package installation and model registration.

## Commands

```bash
node "<helper>/cli.mjs" install [--models <existing-root>] [--state <root>]
```

- Install runs the locked package-manager install for this package only.
- `--models` requires pre-existing local model assets. There is no downloader,
  bootstrap, curl, or mirror; a missing Bun is a prerequisite report, not a
  reason to install it.
- All pinned model digests are verified before settings are saved.
- Re-running `install` is the repair invocation.
- Invalid or truncated assets preserve the previous valid setting and return
  `model-unavailable`.

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

Installing never indexes source, enrolls a checkout, or enables spec use. If
`cli.mjs` is not found, report the prerequisite and continue with ordinary spec
tools.
