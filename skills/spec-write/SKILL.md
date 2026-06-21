---
name: spec-write
description: This skill should be used when the user asks to "write a spec", "create a spec", "spec this out", "plan this feature", or "write an implementation plan" for a feature or change. Creates a structured implementation spec in .specs/<slug>/spec.md and mirrors it to GitHub only when the current repository is hosted on GitHub.
mode: coding
scope: document
capability: repo-write
disable-model-invocation: true
argument-hint: "[feature-slug or GitHub issue number (optional)]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "7"
---

# Spec Write

Create a deterministic implementation spec from the current proposal and persist it to the repository-local spec folder. The local file is canonical; issue trackers are optional mirrors.

## Non-Interactive Operation

This skill runs to completion without user interaction. Do not pause to ask clarifying questions, request confirmation, or wait for input mid-run. When something is unclear or underspecified, make a reasonable, well-grounded decision from the available context — the conversation, the repository, existing conventions, and the spec's own intent — then proceed. Summarize every such judgement call and its rationale in the final report so the user can review what was decided and why.

Stop only when a required input is genuinely missing and cannot be inferred (for example, no proposal or analysis to spec from). In that case, report what is missing and halt — do not ask for it interactively.

## Output Contract

Always write the completed spec to:

```txt
.specs/<feature-slug>/spec.md
```

If the current repository is a GitHub repository and `gh` is authenticated, also mirror the same spec body to a GitHub issue:

- If `$ARGUMENTS` is an issue number, edit that issue.
- If no issue number is provided, create a new issue.
- If GitHub is unavailable, unauthenticated, or the repo is hosted elsewhere, skip the mirror and report the local spec path.

Do not require GitHub for this workflow. Bitbucket, GitLab, self-hosted, and local-only repositories use `.specs/<feature-slug>/spec.md` only.

## Pre-Step - Load Pipeline Inputs

Before writing the spec, locate the spec folder for this feature: `.specs/<feature-slug>/`.

Resolve the folder in this order:

1. If `$ARGUMENTS` names an existing `.specs/<feature-slug>/` folder, use it.
2. If the conversation names a folder announced by `spec-architect-initial`, use it.
3. Pick the `.specs/*/` folder whose `proposal.md` matches the feature under discussion, using the most recently modified match on ties.
4. If there is current architecture analysis in the conversation but no folder yet, create `.specs/<feature-slug>/` from a short kebab-case feature slug.

The folder contains fixed-name artifacts:

- **`proposal.md`** - the architecture proposal. This is the primary input for the Architecture and Implementation Steps sections. If there is no spec folder, no proposal, and no analysis in the current conversation, stop and tell the user there is nothing to spec from.
- **`critique.md`** - optional. If present, reconcile it using the rules below. If absent, skip reconciliation; the critique stage is optional and its absence is not an error.
- **`spec.md`** - the output of this skill. Overwrite it only after producing the complete updated spec body.

### Phase specs

A large proposal may be split into multiple specs, one per phase. All phase specs share the same spec folder unless the proposal explicitly creates separate folders.

When writing a phase spec:

- State which phase of the proposal this spec covers in the Problem Statement.
- Reconcile only the critique recommendations that fall within this phase's scope. Recommendations belonging to other phases are not deferrals; note them as "covered by phase N" only if helpful.
- End the spec with the footer block, keeping the phase marker on the folder line: `Spec folder: .specs/<feature-slug>/ (phase N)` followed by the `Visual design:` line (see Spec Footer).

## GitHub Mirror Detection

Treat GitHub as an optional mirror only when all of these are true:

1. `git remote get-url origin` identifies a GitHub remote, such as `git@github.com:owner/repo.git` or `https://github.com/owner/repo.git`.
2. `command -v gh` succeeds.
3. `gh auth status` succeeds for the remote host.

If any check fails, continue with the local `spec.md` output and report why the GitHub mirror was skipped. Do not block spec creation on issue-tracker access.

## Issue-ID Folder Prefix

When a GitHub issue is associated with this spec, prefix the spec folder slug with the issue number so the canonical folder is `.specs/<issue-number>-<feature-slug>/`.

- Determine the issue number before finalizing the folder. When creating a new issue, create it first (title or provisional body) to obtain its number; when editing an existing issue, the number is already known.
- If the resolved folder (e.g. `.specs/<feature-slug>/` from the architecture stage) is not already prefixed with this issue number, rename it to `.specs/<issue-number>-<feature-slug>/`, moving every artifact with it (`proposal.md`, `critique.md`, and any others). Use `git mv` when the folder is tracked.
- The prefixed folder name is now the canonical slug. The `Spec folder:` footer and the issue body must reference it.
- Repositories with no GitHub issue (Bitbucket, GitLab, self-hosted, local-only) keep the plain `.specs/<feature-slug>/` slug. Do not prefix.

## Reconcile Critique Feedback

Triage each recommendation by scope and relevance:

| Priority | Action |
|---|---|
| **Must Address** - flaws that will cause real problems if shipped | Incorporate into the spec's architecture. If a recommendation changes a core decision, update the design and document the rationale. |
| **Should Address** - meaningful improvements, not showstoppers | Address in the spec if the scope of the feature makes it natural to include. Otherwise, record in the Notes section as a known follow-up with a brief rationale for deferring. |
| **Consider** - polish/refinement | Note in the Notes section only if relevant. Skip if out of scope. No need to address every consideration. |

Reconciliation principles:

- Be pragmatic, not exhaustive. A critique explores possibilities; the spec commits to decisions.
- State your reasoning when deferring a critique recommendation.
- Do not over-engineer to satisfy hypotheticals.
- Resolve tensions using actual project context: team size, maturity, timeline, and current architecture.
- Make the final spec read as one coherent plan, not an accumulated list of compromises.

Apply reconciled decisions when writing the Architecture, Notes, and Implementation Steps sections below.

## Select Applicable Rules

Rule files are short, reusable convention guides (UX, forms, tables, copy, testing) that step implementers must follow when their subject matter is in play. Enumerate candidates from:

1. A repo-local rules folder (`rules/` or `.agents/rules/`) when one exists.
2. The user-global rules folder `~/.agents/rules/`.

Select by relevance, not completeness: form rules only when the spec builds or changes a form, table rules for tabular UI, CTA/copy rules for user-facing text, testing rules when steps add tests, broad design rules only for user-facing UI work. A backend-only spec typically selects nothing, or only the testing rule. Repo-local rules win over global rules on conflict.

Record the selection in the Applicable Rules section below. `spec-run` injects these paths into every step prompt, so an unselected rule is invisible at implementation time — but do not pad the list; irrelevant rules dilute the ones that matter.

## Required Sections

Every section is required. If not applicable, include the heading with "N/A".

### 1. Qualifications

List concrete technical domains required for this implementation. Include only skills actually needed.

### 2. Problem Statement

In 2-4 sentences: what capability is missing or broken, what the current behavior is, and what this spec addresses.

### 3. Goal

One sentence describing the concrete outcome when implementation is complete.

### 4. Architecture

Include:

- Files to create or modify, with responsibilities.
- Key types, interfaces, or contracts in concrete syntax for the project's language.
- Design decisions and rationale.
- Dependency map covering internal modules and external packages/services.

Design for current requirements, not imagined future ones. Start simple: boring technology, explicit boundaries, and data flow that can be explained in under 5 minutes. Fail fast on invalid inputs; do not add defensive fallbacks unless explicitly required.

Avoid abstractions with only one use, abstract layers "for future flexibility," complex patterns without matching problem complexity, and optimizations without measured need.

### 5. Acceptance Criteria

Create a numbered list (`AC-1`, `AC-2`, etc.) of observable, automatable assertions:

- Group by concern: core behavior, error handling, edge cases, integration.
- Include non-happy-path behaviors.
- Make every criterion testable without subjective judgment.

### 6. Notes

Cover trade-offs, risks, ambiguities, migration concerns, and sequencing dependencies.

For each significant trade-off, state why this approach was chosen, what it gives up, what it gains, and which alternatives were considered.

### 7. Implementation Steps

Create a flat, numbered, sequential list of deterministic engineering tasks.

For each step include:

1. What to do: exact files and changes required.
2. Why: tie to architecture or acceptance criteria.
3. Signatures/contracts: public API shape when adding or changing interfaces.
4. Tests: concrete automated test assertions and target test files. Test behavior, not implementation. Focus on edge cases and failure modes.
5. Coverage: which acceptance criteria this step satisfies, as a tag line (`Covers: AC-3, AC-7`). Every criterion must be covered by at least one step; a step covering no criterion must trace to a stated architectural need instead.
6. Complexity: how hard *this step* is, as a tag line (`Complexity: easy`). One of `easy`, `medium`, `hard` — see the rubric below. The system uses per-step tags to route each step to an appropriately strong implementation model, so score every step, not just the spec.

Each step's `Covers:` and `Complexity:` tag lines sit together at the end of the step. Judge complexity by *this step's own* work, applying the rubric the same way every time so the label is reproducible across runs. Anchor the choice on four signals — scope (files/modules this step touches), novelty (new abstractions vs. reusing existing patterns), domain difficulty (the Qualifications this step exercises), and integration risk (state, I/O, migrations, blast radius this step incurs):

| Tier | When |
|---|---|
| `easy` | One file or a few closely-related files; uses existing patterns directly; no new abstractions; local or pure logic; low blast radius. |
| `medium` | Several files, or some new types/functions following established patterns; limited state/IO; standard domain knowledge. |
| `hard` | New architecture/abstractions, cross-module integration, concurrency, migrations, non-trivial algorithms, specialized domain depth, or a wide high-risk change where subtle correctness dominates. |

When torn between two tiers, choose the higher one — an under-powered model is the costlier error.

Step constraints:

- **Deterministic:** No subjective instructions such as "improve", "clean up", or "refactor as needed".
- **Minimal:** Smallest verifiable unit of progress.
- **Self-contained:** Executable in isolation by a separate engineer or LLM context.
- **Forward-only:** Target architecture only. No unnecessary compatibility layers.

Step ordering:

- Types and contracts first.
- Pure/domain logic next.
- Stateful and I/O modules after.
- Integration wiring and verification tests last.

Exclude:

- Manual testing or QA checklists.
- Documentation-only tasks.
- Running the entire test suite.
- Formatting or lint-only chores.
- Git workflow or PR process steps.

### 8. Applicable Rules

List the rule files selected above as resolvable paths, each with a one-line reason:

```markdown
- `~/.agents/rules/form-design.md` — spec adds a settings form
- `~/.agents/rules/unit-testing.md` — steps add unit tests
```

If none apply, "N/A".

## Implementation Profile

Complexity is scored **per step**, not for the spec as a whole — each step in Implementation Steps carries its own `Complexity:` tag (see §7) so the system can route each step to an appropriately strong implementation model. Do not emit a spec-level complexity.

The footer carries one spec-wide axis, classified after writing the spec body: a reproducible Visual design flag. Apply the rubric the same way every time so the label is reproducible across runs.

### Visual design

Pick exactly one flag, by whether this spec *implements* user-facing visual design:

- `yes-visual-design` — the work produces or changes visual UI: component markup, layout, styling/theming, design-system implementation, or prototypes — anywhere visual fidelity and aesthetic judgment matter. This usually coincides with selecting a design rule (`functionalist-design`, `expressive-design`, `form-design`, `table-row-design`, `cta-design`) in Applicable Rules.
- `no-visual-design` — backend, infrastructure, tooling, data, API, pure logic, tests, or copy-only work with no visual layout or styling output. UI *logic* with no styling, and CLI or other text-only output, are `no-visual-design`.

The flag is binary — emit exactly one.

## Spec Footer

End `spec.md` with a metadata footer block so downstream skills can locate the folder and route the work. The first line is the canonical folder; the second is the spec-wide Visual design flag. Per-step complexity is not in the footer — it lives on each step (see §7). When the folder is issue-prefixed, use the prefixed slug (e.g. `Spec folder: .specs/<issue-number>-<feature-slug>/`):

```txt
Spec folder: .specs/<feature-slug>/
Visual design: no-visual-design
```

`Visual design` is exactly one of `yes-visual-design`, `no-visual-design`.

For phase specs, keep the phase marker on the folder line:

```txt
Spec folder: .specs/<feature-slug>/ (phase 2)
Visual design: yes-visual-design
```

The GitHub mirror, when used, must contain the same footer block.

## Output Steps

1. Resolve the GitHub mirror and issue number (see GitHub Mirror Detection). When creating a new issue, create it first to reserve its number.
2. Apply the issue-ID folder prefix when an issue number exists (see Issue-ID Folder Prefix), so the canonical folder is `.specs/<issue-number>-<feature-slug>/`. Without an issue number, the canonical folder stays `.specs/<feature-slug>/`.
3. Write the final markdown body — including each step's `Complexity:` tag (§7) and the footer block (`Spec folder:`, `Visual design:`), referencing the canonical folder — to `<canonical folder>/spec.md`.
4. If GitHub mirroring is available, set the issue body to the same content.
5. Report:
   - Spec path.
   - GitHub issue URL or "not mirrored".
   - Proposal and critique inputs used.

Do not implement the plan.

Do not add Co-Authored-By trailers, "Generated with" footers, or any AI model attribution.
