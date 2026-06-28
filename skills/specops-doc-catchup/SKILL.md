---
name: specops-doc-catchup
description: This skill should be used when the user asks to catch up missed agent-docs, document commits that were never refreshed, find which commits are undocumented, back-fill SpecOps docs for skipped commits, bring AGENTS docs current with all commits, or recover doc coverage after a squash-merge or rebase. It is the commit-coverage recovery orchestrator that complements specops-branch-refresh.
disable-model-invocation: true
argument-hint: "[repo-root optional] [--status]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# SpecOps Doc Catch-Up

Bring agent documentation current with **every commit**, not just the latest branch diff. This is
the recovery orchestrator: when `specops-branch-refresh` was skipped on some commits, this skill
reads the commit-coverage ledger, fans out subagents to refresh the affected targets, and records
the newly-covered commits.

It is ledger-driven and idempotent. `specops-branch-refresh` is the normal per-branch path and
records `doc` coverage as it goes; run this skill when coverage fell behind or history was rewritten.

## Why This Exists

The manifest's `source_hash` is a content hash. It answers "is this target stale right now?" but
not "which commits were documented?". The ledger under `docs/specops/history/` answers the second
question, so a forgotten refresh can be reconstructed commit-by-commit. Because the ledger is a
committed file, the record survives squash-merge even though the branch SHAs do not.

## Inputs

- Repo root: `$ARGUMENTS` or current repository.
- Optional `--status` flag: report uncovered commits and stop without doing work.
- Manifest path: `docs/specops/targets.json`.
- Ledger: `docs/specops/history/ledger.jsonl`, frontier: `docs/specops/history/frontier.json`.
- Deterministic core: `scripts/commit-ledger.mjs` (fall back to `~/.agents/scripts/commit-ledger.mjs`).

## Procedure

### 1. Read Uncovered Commits

```bash
node scripts/commit-ledger.mjs uncovered <repo-root> --lens doc
```

Inspect the result:

- `count` and `commits` — the undocumented commits, oldest-first, each with author, date, subject,
  and the `targets` it touched.
- `reconcile_needed` — `true` when the frontier is unreachable (post-squash or post-rebase).

If `--status` was requested, report the uncovered commits grouped by target and by author, note any
`reconcile_needed` state, and stop.

If `count` is `0` and `reconcile_needed` is `false`, report that docs are current and stop.

### 2. Reconcile A Broken Frontier First

If `reconcile_needed` is `true`, run:

```bash
node scripts/commit-ledger.mjs reconcile <repo-root> --lens doc
```

Report the outcome honestly:

- `reanchor` — the frontier moved to the newest still-reachable covered commit; continue.
- `collapse` — the covered span was squashed away; a single boundary row was recorded at HEAD and
  per-commit granularity for that span is gone. Say so. Then re-read uncovered commits (step 1).

### 3. Resolve The Affected Targets

Take the union of `targets` across all uncovered commits. These are the only targets that need a
refresh — a target untouched by any uncovered commit is already current.

If any uncovered commit reports source-like files under no target, run `specops-decompose` and
re-read uncovered commits before continuing. If files remain unowned, report them and proceed with
owned targets only.

### 4. Refresh Each Affected Target With Subagents

Process the affected targets by fanning out subagents — one per target. Targets are independent, so
run a batch of subagents concurrently; keep the batch small enough to stay reviewable (a few at a
time). Each subagent refreshes one target exactly as `specops-branch-refresh` step 3 does, scoping
the changed files to the uncovered commit range.

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Doc catch-up <target-slug>",
  prompt: "<PHASE_PROMPT>"
)
```

PHASE_PROMPT:

```txt
You are refreshing one SpecOps target's documentation to catch up missed commits.

Manifest target entry:
<target-json>

Uncovered commits touching this target (oldest-first), with their changed files and hunks:
<commit-and-diff-context>

Follow the per-target contract from the sibling `specops-update-spec` skill:
- If the target's tier2_path analysis exists, update it in place from the diff (edit only sections
  traceable to the change), then return the refreshed source_hash and last_synthesized.
- If the tier2_path analysis is missing, run `specops-analysis` in manifest-driven mode for this
  target instead and write the full analysis.

Synthesize against the current HEAD state of the target's files, not each intermediate commit.
Do not edit docs/specops/targets.json. Do not edit the ledger. Do not edit product source code.
Return: summary, file written, refreshed source_hash, last_synthesized, assumptions, blockers.
```

Verify each subagent's output the way `specops-orchestrate-analysis` does: confirm the target file
exists with the required sections, and capture the returned `source_hash` and `last_synthesized`.
Update only those two fields for that target in `docs/specops/targets.json`. Allow up to 2 fix-up
subagents per target; if a target still fails, mark it blocked.

### 5. Rebuild Compressed Docs And The Index

For each refreshed target, invoke `specops-agent-docs`. Then invoke `specops-index-agents` to
refresh the generated block in root `AGENTS.md`.

### 6. Record Coverage

Record `doc` coverage **only for commits whose every touched target refreshed cleanly**. If all
affected targets succeeded, record the whole uncovered set:

```bash
node scripts/commit-ledger.mjs record <repo-root> --lens doc --all-uncovered
```

If some targets were blocked, do not advance past the blocked commits. Record only the prefix of
uncovered commits that touch exclusively clean targets by passing their SHAs explicitly:

```bash
node scripts/commit-ledger.mjs record <repo-root> --lens doc --commits <sha> <sha> ...
```

Report which commits remain uncovered because of blockers so the next run retries them.

### 7. Report

Return:

- uncovered commits found (count, target span, author span)
- reconcile action, if any, and whether granularity was lost
- targets refreshed and any blocked targets
- compressed docs and AGENTS index status
- commits recorded as covered and the new `doc` frontier
- commits still uncovered and why

## Guardrails

- Do not edit product source code.
- Synthesize documentation against HEAD; this skill keeps docs current, it does not reconstruct
  intermediate states (that is `specops-decision-ledger`).
- Treat the ledger as append-only. Write `docs/specops/history/` only through `commit-ledger.mjs`.
- Never record coverage for a commit whose target refresh was blocked or ambiguous.
- Only the manifest's `source_hash` and `last_synthesized` fields may change here; all other manifest
  changes come from `specops-decompose`.
- Preserve human-authored AGENTS content outside the generated `agents-docs` markers.
