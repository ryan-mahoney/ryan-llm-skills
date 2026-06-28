---
name: specops-branch-refresh
description: This skill should be used when the user asks to update agent documentation for the current branch or PR, refresh SpecOps docs from branch changes, keep docs/specops analysis and agent docs current, update AGENTS.md after code changes, or run the branch-specific agent-docs updater.
disable-model-invocation: true
argument-hint: "[repo-root optional] [base-ref optional]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# SpecOps Branch Refresh

Refresh structured agent documentation for a branch. This is the orchestrator that connects branch
diffs to deep analysis updates, compressed agent docs, the root `AGENTS.md` index, and the
commit-coverage ledger.

## Inputs

- Repo root: `$ARGUMENTS` or current repository.
- Optional base ref: default is detected by `scripts/agent-docs.mjs`.
- Manifest path: `docs/specops/targets.json`.
- Commit-coverage ledger: `docs/specops/history/ledger.jsonl` and `docs/specops/history/frontier.json`.

## Procedure

### 1. Resolve The Manifest

1. If `docs/specops/targets.json` is missing, run `specops-decompose` first.
2. Run structural validation when the deterministic core is available:

   ```bash
   node scripts/decompose-skeleton.mjs <repo-root> --check docs/specops/targets.json
   ```

   Use `~/.agents/scripts/decompose-skeleton.mjs` if the target repo does not carry the script.
3. If validation reports structural drift, run `specops-decompose` and restart target mapping.

### 2. Map Branch Changes To Targets

Run:

```bash
node scripts/agent-docs.mjs changed-targets <repo-root> --manifest docs/specops/targets.json --base <base-ref>
```

Use `~/.agents/scripts/agent-docs.mjs` if needed.

If the result includes `unowned_files` that are source-like, run `specops-decompose` and re-map.
If files remain unowned after decomposition, report them and continue with owned targets only.

### 3. Refresh Deep Analysis

For each affected target, sequentially:

1. If the target's `tier2_path` exists, invoke `specops-update-spec` with:
   - the full target manifest entry
   - the changed files and hunks scoped to that target
   - the base ref and branch name
2. If the target's `tier2_path` is missing, invoke `specops-analysis` in manifest-driven mode for
   that target instead.
3. Verify the target analysis file exists and contains the required SpecOps analysis sections.
4. Capture the returned `source_hash` and `last_synthesized`.
5. Update only this target's `source_hash` and `last_synthesized` in `docs/specops/targets.json`.

Do not update structural manifest fields in this step.

### 4. Refresh Compressed Agent Docs

For each target whose deep analysis was created or updated, invoke `specops-agent-docs` for that
target slug. Verify the target's `agent_path` exists, or the fallback
`docs/specops/agents/<slug>.md` exists.

### 5. Refresh Root Index

Invoke `specops-index-agents` to update the generated block in root `AGENTS.md`.

### 6. Record Doc Coverage

After a clean refresh, append commit-level `doc` coverage so a missed run can be caught up later
and the record survives squash-merge (it is a committed file, unlike the branch SHAs):

```bash
node scripts/commit-ledger.mjs record <repo-root> --lens doc --all-uncovered --base <base-ref>
```

Use `~/.agents/scripts/commit-ledger.mjs` if the target repo does not carry the script.

- Record only when every affected target refreshed cleanly. If any target was blocked or left
  ambiguous, skip recording and report that doc coverage was **not** advanced, so
  `specops-doc-catchup` can retry those commits without double-counting.
- The ledger and frontier live under `docs/specops/history/`; the command creates them on first run.
- A reachable frontier takes precedence over `--base`, so reruns are idempotent and never re-record
  a covered commit.
- If the command reports `reconcile_needed` (the frontier is unreachable after a squash or rebase),
  run `node scripts/commit-ledger.mjs reconcile <repo-root>` and report the re-anchor instead of
  recording blindly.

### 7. Report

Return:

- base ref and changed files considered
- affected targets
- analysis files updated or created
- compressed agent docs updated
- manifest freshness fields changed
- AGENTS index status
- doc-coverage commits recorded and the new frontier, or why coverage was not advanced
- unowned files and unresolved blockers

## Manifest Write Rules

The branch orchestrator may write `docs/specops/targets.json`, but only these fields on already
known targets:

- `source_hash`
- `last_synthesized`

All other manifest changes must come from `specops-decompose`.

## Guardrails

- Do not edit product source code.
- Process targets sequentially; do not parallelize unless explicitly requested.
- Do not regenerate all analysis when only a small branch diff changed one target.
- Preserve human-authored AGENTS content outside the generated `agents-docs` markers.
- If a target update is ambiguous, leave the existing doc in place and report the ambiguity rather
  than silently rewriting unrelated sections.
- Treat the ledger as append-only. Write `docs/specops/history/` only through `commit-ledger.mjs`
  (`record`, `reconcile`); never hand-edit or delete existing rows.
