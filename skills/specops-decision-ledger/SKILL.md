---
name: specops-decision-ledger
description: This skill should be used when the user asks to reconstruct product decisions from git history, build a decision or intent ledger, trace how requirements changed over time, find which past decisions were later reversed or abrogated, reverse-engineer ADRs from commits, or understand the intent behind a codebase by walking its history. It walks commits oldest-first and maintains active and superseded decision files.
disable-model-invocation: true
argument-hint: "[repo-root optional] [--since <ref>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# SpecOps Decision Ledger

Reconstruct the product's decision history from git, working **forward** from the first commit. For
each commit, extract the intent and the decisions it asserts; as the walk advances, detect when a
new commit overrides an earlier decision and move the abrogated decision into a separate record.

The result is two living documents:

- `docs/specops/history/decisions/active.md` — decisions currently in force.
- `docs/specops/history/decisions/superseded.md` — decisions a later commit abrogated, each
  annotated with the commit that overrode it and what replaced it.

This is the reverse of the forward doc pipeline: instead of describing the code as it is now, it
recovers *why* it became that way, including the dead ends.

## Execution Model

A plain in-harness subagent orchestrator. Extraction is parallelizable (each commit is independent);
supersession is a sequential reduce over the compact records. So:

- **Map (concurrent):** spawn `specops-intent-extract` subagents in small batches to produce one
  intent record per commit.
- **Reduce (sequential):** fold the records into the ledger in commit order, deciding supersession
  against the running set of active decisions. This is cheap because it operates on the extracted
  records, not raw diffs.

Do not parallelize the reduce — supersession depends on the decisions already in force.

## Inputs

- Repo root: `$ARGUMENTS` or current repository.
- Optional `--since <ref>`: bootstrap range for the very first run (otherwise walk all history).
- `intent`-lens commit coverage: `docs/specops/history/ledger.jsonl`, `frontier.json`.
- Manifest at `docs/specops/targets.json` to scope decisions to targets.
- Deterministic core: `scripts/commit-ledger.mjs` (fall back to `~/.agents/scripts/commit-ledger.mjs`).

## Procedure

### 1. Determine The Commits To Process

```bash
node scripts/commit-ledger.mjs uncovered <repo-root> --lens intent --base <since-or-omit>
```

This returns uncovered `intent` commits oldest-first. On the first run with no frontier it is the
whole history (optionally bounded by `--since`); on later runs it is only new commits, so the ledger
is incremental.

If `reconcile_needed` is `true`, run `node scripts/commit-ledger.mjs reconcile <repo-root> --lens
intent` first and report whether granularity was lost to a squash, then re-read.

If `count` is `0`, report that the decision ledger is current and stop.

### 2. Load The Active Digest

Read `active.md` if it exists. This is the set of decisions in force — your context for detecting
supersession. For a large file, you do not need every word; you need each decision's `id`,
`statement`, and owning target so you can match a contradiction.

### 3. Map: Extract Intent Records

Process the uncovered commits oldest-first, extracting in small concurrent batches (a handful of
subagents at a time — enough to be fast, few enough to stay reviewable).

```txt
Agent(
  subagent_type: "general-purpose",
  description: "Intent extract <abbrev>",
  prompt: "<PHASE_PROMPT>"
)
```

PHASE_PROMPT:

```txt
You are executing intent extraction for one commit.

Commit: <sha>
Repo root: <repo-root>

Follow the workflow and output contract from the sibling `specops-intent-extract` skill
(`../specops-intent-extract/SKILL.md` from this skill directory):
- Read the commit message and the full diff for <sha>.
- Produce the structured intent record JSON exactly as that skill specifies.
- supersedes_hint is a soft signal only; do not assert supersession.

Return only the JSON object.
```

Collect the records and keep them in commit order. Discard records whose `decisions` array is empty
and whose intent is purely mechanical, but still mark those commits covered in step 5.

### 4. Reduce: Fold Records Into The Ledger (sequential)

For each commit's record, in commit order, apply each of its `decisions`:

1. **Find candidates.** Look in `active.md` for decisions on the same target(s), or with a matching
   or closely related `id`/topic, or named in this commit's `supersedes_hint`.
2. **Judge supersession.** Decide whether the new decision *contradicts, replaces, relaxes, or
   removes* a candidate. This is the core judgment — be conservative:
   - Clear override → move the old decision from `active.md` to `superseded.md`, annotated with this
     commit as the superseding commit, the date, a one-line reason, and the replacement decision id
     (or "removed, no replacement" for a `kind: removal`).
   - New, unrelated decision → add it to `active.md` under its target.
   - Genuine tension you cannot resolve from the records → keep both in `active.md` and add a
     `> Note: tension with <id>` line rather than guessing.
3. **Write through.** Update `active.md` and `superseded.md` as you go so a long run is resumable.

A commit may both add and supersede (e.g. a redesign). Apply removals before additions so a
replacement reads cleanly.

### 5. Record Intent Coverage

After a commit's record is folded in (including no-op mechanical commits), mark it covered:

```bash
node scripts/commit-ledger.mjs record <repo-root> --lens intent --commits <sha> ...
```

Record in commit order so the frontier advances monotonically. If a batch is interrupted, only
record the commits you actually folded in, so a rerun resumes from the right place.

### 6. Report

Return:

- commits processed (count, date span, authors)
- decisions added to `active.md`
- decisions moved to `superseded.md`, with the overriding commit for each
- unresolved tensions noted
- new `intent` frontier and any commits left for a later run

## File Formats

`active.md`:

```markdown
# Active Product Decisions

Reconstructed from git history by specops-decision-ledger. Each entry is in force as of the latest
processed commit. See superseded.md for decisions a later commit abrogated.

## <Target Name> (`<slug>`)

### <decision-id>
- Statement: <one sentence>
- Kind: <requirement|behavior|policy|constraint|ux|data>
- Since: <abbrev> — <author>, <date>
- Evidence: <path:line>
```

`superseded.md`:

```markdown
# Superseded Product Decisions

Decisions once in force that a later commit abrogated. Kept so a reader understands why something is
no longer true, and who was involved.

## <decision-id>
- Statement: <the decision as it stood>
- Established: <abbrev> — <author>, <date>
- Superseded by: <abbrev> — <author>, <date>
- Reason: <one line>
- Replacement: <new-decision-id, or "removed, no replacement">
```

## Guardrails

- Do not edit source code, the manifest, or the ledger files by hand. Write coverage only through
  `commit-ledger.mjs`.
- Write only `active.md` and `superseded.md` under `docs/specops/history/decisions/`.
- Decisions describe product behavior, not code mechanics.
- Be conservative about supersession: a refactor that preserves behavior supersedes nothing. Only
  move a decision when a later commit genuinely overrides it.
- Never delete a superseded decision; the abandoned path is the point of the record.
- Process commits in order; the reduce is sequential by design.
