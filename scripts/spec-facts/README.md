# Deterministic workflow facts

Use these helpers when an agent needs Git facts or a large command log. They make no
model calls and add no required startup checks. Reuse an applicable result instead of
asking another agent to collect the same facts. Recollect only when the underlying
checkout, revision range or log changes and the new facts matter to a decision.

```sh
node ~/.agents/scripts/spec-facts/cli.mjs git --repo /absolute/checkout
node ~/.agents/scripts/spec-facts/cli.mjs git --repo /absolute/checkout --base BASE --head HEAD
node ~/.agents/scripts/spec-facts/cli.mjs log --file /absolute/command.log
```

`git` returns branch, checkout HEAD, cleanliness and staged/unstaged/untracked paths
with their two-character Git status. Paths are Git-root-relative; JSON preserves
quotes and newlines. Moves appear as deletion/addition. An explicit base adds resolved
endpoint revisions, commits reachable from head but not base, and changed paths
between those endpoints. It does not select a merge base. `--head` defaults to HEAD
and requires `--base`. Each list defaults to 100 entries with total/omitted counts;
`--limit 1..1000` adjusts this. Git calls have a 15-second deadline and 16 MiB output
ceiling; exceeding either returns an error, never fabricated clean/empty facts.

The snapshot is not atomic. A changing checkout can yield mixed observations; review
the assigned fixed revisions and inspect relevant diffs for correctness. Facts do not
prove acceptance or authorize staging, commits, rebase or publication. No fetch, Git
index refresh, model discovery or test execution occurs.

`log` returns exact decoded text up to 8,000 characters. Larger logs return a bounded
beginning, the first diagnostic-pattern excerpts with surrounding lines, and the end.
Excerpts carry physical line numbers; long lines and overflowing excerpt selections
are marked clipped. Extraction is deliberately incomplete: unknown formats, later
diagnostics and content past long-line prefixes may be omitted. Read the relevant
raw-log ranges when these excerpts do not explain the result. Do not rerun a command
just to recover output. Pattern matches are not failure counts or a test verdict;
standalone log summaries return `exit_code: null` because log text cannot prove it.

The Pi runtime uses the same selector automatically for managed command results.
Each command gets a separate mode-0600 raw log, including commands with no output.
Its actual exit code, signal and timeout/cancellation error stay in the tool result.
Raw stdout/stderr bytes are retained in arrival order without channel labels. The
summary decodes UTF-8; the raw artifact remains authoritative for bytes and omissions.
Owners use `spec_verify` to call the Git helper when needed; coordinators and reviewers
use their shell tool. Editors receive the same compact command results automatically.
No additional agent or required per-edit invocation is needed.

Focused checks: `node --test scripts/spec-facts/core.test.mjs`
