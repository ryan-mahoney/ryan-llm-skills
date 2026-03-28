---
name: identify-where
description: "Identify where a plain-language feature or behavior lives in the current codebase and return the top-level file(s) to inspect first. Use this when the user says 'where is X implemented', 'find where this logic lives', 'which file handles Y', 'locate this feature', or 'what file should I read first for Z'. Also trigger when someone describes behavior in prose and wants likely owning files."
argument-hint: "[plain-language functionality description] [optional search scope path]"
---

# Identify-Where

Find the best starting file(s) for a feature described in plain language. This skill favors top-level ownership files (routes, feature entry modules, public API exports, page roots, orchestrators) over leaf helpers so the next agent can orient quickly.

## Arguments

- `$1` - Required. Plain-language description of functionality to locate (example: `user invite email flow`).
- `$2` - Optional. Search scope path. Defaults to `.`.

## Before Starting

1. Confirm `$1` is present and non-empty.
2. Set variables:

```bash
feature_query="$1"
search_scope="${2:-.}"
```

3. If `AGENTS.md` exists, read it first to learn routing, module boundaries, and naming conventions.
4. List top-level directories and manifests to understand stack boundaries before searching deeply.

## Steps

### 1. Build search terms from the plain-language request

Extract likely domain terms, synonyms, and implementation words from `feature_query`.

- Keep domain nouns (for example: `invoice`, `workspace`, `invite`).
- Keep action verbs (for example: `create`, `sync`, `validate`).
- Add likely technical variants where obvious (for example `invite` -> `invitation`).

### 2. Find candidate files by filename and content

Run both filename and content searches using `rg`.

```bash
query_regex="$(printf '%s' "$feature_query" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 ]/ /g' | xargs -n1 | paste -sd'|' -)"
rg --files "$search_scope" | rg -i "$query_regex"
rg -n -i "$query_regex" "$search_scope"
```

### 3. Prioritize top-level ownership files

From all matches, rank files in this order:

1. Route/entry wiring (router configs, endpoint declarations, feature registries)
2. Feature root modules/pages/components
3. Service/orchestration modules coordinating business logic
4. Domain models/contracts used by the above
5. Leaf helpers/utilities (only when no stronger owner exists)

When present, prefer files that are imported by many callers or act as the first boundary for the behavior.

**Pattern reference:** Reachability-first analysis mirrors `skills/controller-refactor-plan/SKILL.md`.

### 4. Validate with one hop of dependency tracing

For the top 3-5 candidates, confirm they are actually involved by checking imports/callers:

```bash
candidate="<path>"
candidate_base="$(basename "${candidate%.*}")"
rg -n "$candidate_base" "$search_scope"
```

Discard false positives and promote files with concrete behavioral evidence.

### 5. Produce a concise ranked result

Return:

- One `Primary file` when confidence is high.
- `Other likely files` (usually 2-5) ranked by confidence.
- A short rationale per file with concrete evidence.
- Confidence level (`high`, `medium`, `low`).

Use this output shape:

```markdown
## Primary File
- `<path>` - Why this is the ownership entry point.

## Other Likely Files
- `<path>` - Why it likely participates.

## Evidence
- `<search signal 1>`
- `<search signal 2>`

## Confidence
- `<high|medium|low>`
```

## Conventions

- Prefer exact repository paths over conceptual guesses.
- Separate observed evidence from inference.
- If multiple areas look valid, include all plausible top-level owners rather than forcing a single answer.
- If evidence is weak, say so explicitly and list the next best files to inspect.
- Keep recommendations entry-first, not utility-first.

**Pattern reference:** Evidence-first reporting style should follow `skills/specops-analysis/SKILL.md` and architecture-context checks should follow `skills/architect-initial/SKILL.md`.
