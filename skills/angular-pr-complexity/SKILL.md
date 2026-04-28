---
name: angular-pr-complexity
description: "Analyze a git merge commit for PR complexity. Use when: 'analyze this PR', 'how complex is this commit', 'PR complexity for', 'score this merge'."
argument-hint: "<commit-hash>"
---

# Angular PR Complexity Analysis

Analyzes a git merge commit hash and produces a complexity scorecard covering size, spread, cognitive load, and risk signals. Designed for an Angular/Nx monorepo with HTML, SCSS, TypeScript, and spec files.

## Arguments

- `commit` — A git commit hash (short or full). Should be a merge commit representing a PR.

## Before Starting

1. Verify the hash exists: `git cat-file -t <commit>`
2. Confirm it's a merge commit: `git rev-list --parents -1 <commit>` (merge commits have 2+ parents)
3. If not a merge commit, proceed anyway but note it in the output.

## Steps

### 1. Gather Raw Diff Stats

```bash
# For merge commits, diff against the first parent to get the PR's actual changes
git diff --numstat <commit>^1 <commit>
git diff --stat <commit>^1 <commit>
git show --format="%s%n%b" --no-patch <commit>
```

Capture:
- Total files changed
- Total lines added / deleted
- Per-file additions and deletions

### 2. Compute Size Metrics

Calculate and report:

| Metric | Formula |
|--------|---------|
| **Lines Changed** | additions + deletions |
| **Net Lines** | additions − deletions |
| **Files Changed** | count of files in diff |
| **Churn Ratio** | deletions / additions (0 = pure addition, >1 = mostly rewrite) |

#### Size Classification

| Lines Changed | Label |
|---------------|-------|
| 1–50 | Trivial |
| 51–200 | Small |
| 201–500 | Medium |
| 501–1000 | Large |
| 1001+ | XL |

### 3. Compute Spread Metrics

From the file paths in the diff, calculate:

| Metric | How |
|--------|-----|
| **Distinct libraries touched** | Unique `libs/<team>/<lib>` or `libs/<category>/<lib>` prefixes (e.g., `libs/teams/internal-crm/case-admin`) |
| **Distinct apps touched** | Unique `apps/` prefixes |
| **Directory depth** | Count unique parent directories of changed files |
| **Cross-team** | Whether files span multiple `libs/teams/<team>` directories |

#### Spread Classification

| Libraries Touched | Label |
|-------------------|-------|
| 1 | Focused |
| 2–3 | Moderate spread |
| 4+ | Wide spread |

Flag **Cross-team = true** as a review risk signal.

### 4. File Type Breakdown

Categorize every changed file by extension and report counts + line changes per category:

| Category | Extensions |
|----------|------------|
| Template | `.html` |
| Style | `.css`, `.scss` |
| Logic | `.ts`, `.js` (excluding `.spec.ts`, `.test.ts`) |
| Test | `.spec.ts`, `.test.ts` |
| Config | `.json`, `.yaml`, `.yml` |
| Other | everything else |

Calculate:
- **Test Ratio** = test lines changed / logic lines changed
  - `< 0.3` → Low test coverage for changes (flag as risk)
  - `0.3–1.0` → Adequate
  - `> 1.0` → Test-heavy (good)

- **Template-to-Logic Ratio** = template lines / logic lines
  - High ratio (> 2.0) suggests markup-heavy change (lower logic complexity)
  - Low ratio (< 0.3) suggests logic-heavy change (higher complexity)

### 5. Cognitive Load Signals

Identify and flag:

| Signal | Detection | Risk |
|--------|-----------|------|
| **Large single file** | Any file with > 150 lines changed | Hard to review in isolation |
| **New components** | New `.component.ts` files | New concepts to understand |
| **New modules** | New `.module.ts` files | Architectural addition |
| **New services** | New `.service.ts` files | New shared state/logic |
| **Modified barrel exports** | Changes to `index.ts` or `public-api.ts` | Public API surface change |
| **Modified routing** | Changes to `*routing*` or `*routes*` files | Navigation impact |
| **Modified guards/resolvers** | Changes to `*.guard.ts` or `*.resolver.ts` | Auth/data flow impact |
| **Config changes** | Changes to `*.json`, `*.yaml` outside src | Build/CI impact |

### 6. Produce the Scorecard

Present results as a structured report:

```
## PR Complexity Scorecard: <short commit subject>

**Commit:** `<hash>`
**Author:** <name>
**Date:** <date>

### Size
- Lines changed: X (Label)
- Net lines: +X / -Y
- Files changed: N
- Churn ratio: X.XX

### Spread
- Libraries touched: N (Label)
- Apps touched: N
- Cross-team: Yes/No
- Directories: N unique

### File Type Breakdown
| Category | Files | +Lines | -Lines |
|----------|-------|--------|--------|
| Logic    |       |        |        |
| Template |       |        |        |
| Style    |       |        |        |
| Test     |       |        |        |
| Config   |       |        |        |

- Test ratio: X.XX (Label)
- Template-to-logic ratio: X.XX

### Cognitive Load Signals
- [list any flags from Step 5]

### Overall Complexity: <Trivial | Low | Moderate | High | Very High>
```

#### Overall Complexity Heuristic

Score each dimension 0–3, then sum:

| Dimension | 0 | 1 | 2 | 3 |
|-----------|---|---|---|---|
| Size | Trivial | Small | Medium | Large/XL |
| Spread | 1 lib | 2–3 libs | 4+ libs | Cross-team |
| New Concepts | 0 new files | 1–2 new components | 3+ new components or new module | New module + service + routing |
| Test Coverage | Ratio > 1.0 | 0.3–1.0 | < 0.3 | No tests |

| Total Score | Label |
|-------------|-------|
| 0–2 | Trivial |
| 3–4 | Low |
| 5–7 | Moderate |
| 8–9 | High |
| 10–12 | Very High |

## Conventions

- File paths in this repo follow `libs/teams/<team>/<lib>/src/lib/...` or `libs/<category>/<lib>/src/lib/...` patterns (e.g., `libs/teams/internal-crm/case-admin/src/lib/components/...`).
- Apps live under `apps/<app-name>/`.
- Angular components use the 4-file pattern: `.component.ts`, `.component.html`, `.component.scss`, `.component.spec.ts`.
- Merge commits from Bitbucket PRs use the format: `Merged in <branch> (pull request #NNNN)`.
- When the commit is not a merge commit, use `git diff <commit>^..<commit>` instead of diffing against `^1`.
