---
name: spec-work-tour
description: Build or refresh the final HTML work tour and machine-readable evidence verdict for an implemented standalone spec. Use after spec-run or spec-branch-refine, before spec-pr, or when asked for an implementation walkthrough, deploy-safety case, executable-evidence report, or QA handoff.
disable-model-invocation: true
argument-hint: "[feature-slug-or-spec-path]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Spec Work Tour

Assemble the implemented spec's evidence into two deploy-bound artifacts:

- `.specs/<feature>/work-tour.json` — the machine-readable claim, proof, QA, and deployment verdict.
- `.specs/<feature>/work-tour.html` — a portable browser tour of what changed and why the evidence is sufficient.

The tour is not a narrative substitute for proof. It is a navigable projection of evidence that already exists and can be rerun. Read [references/executable-evidence.md](references/executable-evidence.md) before producing either artifact.

## Non-Interactive Contract

Run to completion without asking for approval. Never weaken a required gate to make the tour pass. Missing, stale, red, or non-reproducible merge-blocking evidence produces `verdict: blocked`, an explicit gap, and a useful QA tour of what is known. Do not claim deploy safety from prose, screenshots alone, test count, or prior green output bound to another commit.

## Resolve The Package And Commit

Resolve an explicit `.specs/<feature>/` folder or contained artifact first, then the feature named in the conversation. Stop on ambiguity. Resolve the repository root, merge base, current branch, and exact `HEAD` SHA. The tour is commit-bound to that SHA.

Read, when present:

- `proposal.md`, `critique.md`, and `prototype/`
- `spec.md`, `spec-steps.json`, `evidence-plan.json`
- `spec-prepare.md`, `preparation.json`, `criteria.md`, `invariants.md`
- every `step-<NNN>-subspec.md` and `step-<NNN>-learning.md`
- `merge-evidence.md` and `merge-evidence.json`
- `evidence/`, `blockers.md`, and the latest branch review/fix artifacts
- the merge-base-to-HEAD commits and diff

Required inputs for an implemented spec are `spec.md`, `evidence-plan.json`, `preparation.json`, all expected learnings, and `merge-evidence.json`. A final merge-ready tour additionally requires a current passing branch evidence audit. If an older package predates one of these contracts, report the missing artifact as a blocking evidence gap; do not silently infer a pass.

## Revalidate Provenance And Gates

Validate all artifact hashes and commit bindings that their schemas provide. Then walk every claim and required gate in `evidence-plan.json`:

1. Confirm the claim still maps to a live acceptance criterion or architecture/deployment assertion.
2. Confirm each failure hypothesis has at least one relevant gate capable of rejecting it.
3. Confirm each required gate has a produced artifact, exact command or deterministic inspection procedure, environment, outcome, and proof boundary.
4. Re-run cheap, safe gates when freshness is uncertain. For expensive or environment-specific gates, verify a commit-bound result and record why it was not rerun.
5. Confirm the final branch audit independently examined the integrated diff and closed every actionable finding.
6. Treat open blockers, unresolved required findings, changed code after the last gate, and unavailable required environments as blocking.

Record honest limits. A unit test proves the unit behavior it observes; it does not prove production reachability. A screenshot proves the rendered state shown; it does not prove data integrity. A migration dry-run proves the tested fixture and environment; it does not prove an untested production dataset.

## Build `work-tour.json`

Write strict version 1 JSON with a trailing newline:

```json
{
  "version": 1,
  "feature": "feature-slug",
  "title": "Observable outcome",
  "generatedAt": "canonical ISO 8601 timestamp",
  "repository": ".",
  "branch": "feature-branch",
  "base": "origin/main",
  "commit": "full HEAD SHA",
  "verdict": "ready",
  "summary": "What changed and the user/system outcome.",
  "architecture": {
    "before": "Relevant prior path.",
    "after": "Implemented path.",
    "boundaries": ["browser -> route -> context -> model -> PostgreSQL"],
    "decisions": [{"decision": "...", "reason": "...", "source": "spec.md#Architecture"}]
  },
  "implementation": {
    "steps": [{"step": 1, "name": "...", "commit": "full SHA", "files": ["path"], "outcome": "..."}]
  },
  "claims": [{
    "id": "CL-1",
    "statement": "Observable claim",
    "requirements": ["AC-1"],
    "status": "proven",
    "gates": ["EV-1"],
    "explanation": "Why the evidence closes the claim."
  }],
  "gates": [{
    "id": "EV-1",
    "kind": "integration-test",
    "required": true,
    "status": "passed",
    "command": "bun test path/to/test.js",
    "environment": "local test",
    "artifact": "path or embedded summary",
    "claims": ["CL-1"],
    "rejects": ["FH-1"],
    "proof": "Observed result",
    "boundary": "What this does and does not prove",
    "commit": "full SHA"
  }],
  "qa": {
    "mode": "automated-with-exploration-output",
    "entrypoints": [{"label": "...", "location": "URL, route, command, or fixture", "setup": "..."}],
    "scenarios": [{"id": "QA-1", "title": "...", "steps": ["..."], "expected": ["..."], "automatedBy": ["EV-1"], "artifacts": ["..."]}]
  },
  "deployment": {
    "ready": true,
    "migrations": "none or exact plan/evidence",
    "configuration": "none or exact changes",
    "observability": ["signal and expected behavior"],
    "rollback": "exact rollback or forward-fix path",
    "residualRisks": []
  },
  "audit": {
    "iteration": 2,
    "verdict": "pass",
    "artifact": ".specs/feature/reviews/branch-2-review.md",
    "commit": "full SHA"
  },
  "gaps": []
}
```

Allowed verdicts are `ready` and `blocked`. Claim statuses are `proven`, `partial`, and `unproven`. Gate statuses are `passed`, `failed`, `blocked`, and `stale`. `required` mirrors the planned merge/deploy gate; omit optional exploration artifacts from the readiness calculation but still display them. `deployment.ready` is true only when the top-level verdict is `ready`. No manual action may be necessary to establish the verdict.

Every acceptance criterion must appear in at least one claim. Every claim must name at least one gate. Every gate must name the failure hypothesis it rejects. Use checkout-relative artifact paths where possible. Do not embed secrets, credentials, production records, or sensitive screenshots.

## Render And Inspect The HTML

Run:

```bash
node ~/.agents/skills/spec-work-tour/scripts/render-work-tour.mjs \
  .specs/<feature>/work-tour.json \
  .specs/<feature>/work-tour.html
```

The renderer validates the structural invariants and exits nonzero on an invalid manifest. The HTML is self-contained except for checkout-relative evidence links. It must expose:

- verdict, commit, and evidence posture
- before/after architecture and system boundaries
- implementation steps, commits, and files
- requirement-to-claim-to-gate traceability
- rerunnable commands, artifacts, proof boundaries, and gaps
- a QA walkthrough with routes, fixtures, expected states, and visual artifacts
- migration, configuration, observability, rollback, and residual-risk facts

Open the HTML in a browser and inspect it at desktop and narrow widths. For a visual implementation, include the implementation's captured states in the QA section and inspect those images too. Correct broken links, overflow, unreadable content, missing sections, and inaccurate summaries. The renderer's success proves shape, not truth; compare sampled rows back to their source artifacts.

## Freshness Rule

Any code, test, migration, configuration, lockfile, or deployment-file change after the tour's evidence was assembled invalidates the tour. Re-run affected gates, re-run the branch audit when the integrated diff changed, update `work-tour.json`, and render again. `spec-pr` must compare the tour commit to the pushed HEAD and refuse publication when they differ.

## Output

Report:

- `outcome: ready` or `outcome: blocked`
- tour JSON and HTML paths
- exact bound commit
- proven/partial/unproven claim counts
- passed/failed/blocked/stale gate counts
- QA scenario and visual-artifact counts
- deployment verdict, gaps, and residual risks

Do not commit `.specs/` unless the repository explicitly tracks it. Do not describe a blocked tour as merge-ready.
