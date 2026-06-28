---
name: specops-rework-audit
description: This skill should be used when the user asks to find rework or churn hotspots, detect areas of the product that keep changing, surface where work is being redone, identify a possible process gap or quality gap from git history, or learn who to talk to about a churning area. It reads deterministic churn metrics and supersession density, then interprets the hotspots and produces a non-blame Context Map of who holds the relevant context.
disable-model-invocation: true
argument-hint: "[repo-root optional] [--since <ref>]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# SpecOps Rework Audit

Find where the codebase is being **redone**, decide whether that reads as healthy fast iteration or
a process gap, and name the people who hold the context — so someone can ask them, not blame them.

The deterministic signal comes from git; the judgment about what it *means* is yours. A high churn
count is a fact; "this is a process gap" is an interpretation, and you must label it as one.

## Purpose Of The People Map

This is explicit: naming contributors is for **knowledge transfer and process improvement**, never
blame. A hotspot usually means the area is hard, the requirements moved, or work shipped incomplete
— rarely that a person did poorly. The output answers "who can explain what happened here and what
constraint drove it", so the team can improve the process. Write it in that voice or do not write it.

## Inputs

- Repo root: `$ARGUMENTS` or current repository.
- Optional `--since <ref>`: bound the window (default: all history).
- Manifest at `docs/specops/targets.json` to aggregate churn by target.
- Optional `docs/specops/history/decisions/superseded.md` from `specops-decision-ledger`, for
  supersession density (a strong rework signal). Degrade gracefully if absent.
- Deterministic core: `scripts/commit-ledger.mjs` (fall back to `~/.agents/scripts/commit-ledger.mjs`).

## Procedure

### 1. Compute Churn (deterministic)

```bash
node scripts/commit-ledger.mjs churn <repo-root> --since <ref-or-omit> --by target
```

Each unit reports `touches`, `author_count`, `authors`, `first_touch`, `last_touch`, `type_counts`,
`reverts`, and `fix_ratio` (share of touches that are fixes or reverts). Sorted by `touches`.

### 2. Add Supersession Density

If `superseded.md` exists, count superseded decisions per target and note how clustered in time they
are. A target whose decisions were overturned repeatedly is reworking *intent*, not just code — the
most meaningful hotspot kind.

### 3. Select Hotspots (judgment, not a fixed cutoff)

Use these as **starting** signals, then decide with judgment — do not mechanically threshold:

- high `touches` relative to the repo's other targets, **and**
- high `fix_ratio` or `reverts` (rework, not just active development), and/or
- churn clustered in a short window (a flurry, not steady evolution), and/or
- high supersession density.

Steady `feat`-dominated churn over a long window on a core area is usually healthy growth; a short
burst of `fix` and `revert` on one target right after it shipped is usually rework. Flag what the
evidence supports; explicitly list notable-but-healthy churn as *not* flagged so the report is honest.

### 4. Interpret Each Hotspot

For each flagged target, drill in where useful:

```bash
node scripts/commit-ledger.mjs churn <repo-root> --since <ref> --by file
```

and read the relevant commit subjects (and, if needed, the decision ledger) to understand the
pattern. Classify each hotspot as `healthy iteration`, `likely process gap`, or `unclear`, with a
two-to-three line reading of the evidence. Distinguish the two failure modes the user cares about:

- **Rapidly changing product area** — requirements genuinely moved; the process worked.
- **Process gap** — incomplete or low-quality work kept landing and needing repair; the process let
  it through.

### 5. Build The Context Map

For each hotspot, from the `authors` list and the commit attribution, name who holds context and
*what specific context* — anchored to what they actually did, e.g. "authored the original importer
and both later rewrites — ask what constraint forced the second rewrite." Each person gets a
concrete question worth asking. No evaluation, no ranking of people.

### 6. Write The Report

Write `docs/specops/history/rework.md`:

```markdown
# Rework & Hotspot Report

Generated over <range>. Churn is deterministic; hotspot classification and the Context Map are
inferred — treat them as conversation starters for process improvement, not conclusions or blame.

## Hotspots

### <Target Name> (`<slug>`) — <healthy iteration | likely process gap | unclear>
- Churn: <touches> touches, <author_count> authors, <reverts> reverts, fix_ratio <x>
- Window: <first_touch> → <last_touch>
- Superseded decisions: <n>
- Reading: <2–3 lines on what the evidence suggests>
- Context Map:
  - <person> — holds <specific context>; ask about <question>
- Process check: <one process-focused suggestion>

## Notable But Healthy
- `<slug>` — <one line on why this churn reads as healthy>
```

### 7. Report

Summarize the hotspots, their classifications, and the people to consult. State the window and that
classifications are inferred.

## Guardrails

- Do not edit source code, the manifest, or the ledger files.
- Write only `docs/specops/history/rework.md`.
- Never frame a finding as a person's fault. The Context Map exists to find who to *talk to*; keep
  the language neutral and process-oriented.
- Label every classification as inferred. Churn counts are facts; "process gap" is a hypothesis.
- Do not flag churn as rework without a rework signal (fixes, reverts, supersession, or a tight
  repair window). Active feature development is not rework.
- If churn data is too thin to judge (very short history), say so rather than over-reading it.
