---
name: spec-work-tour
description: Build or refresh the final machine-readable evidence verdict and practitioner-facing HTML work tour for an implemented standalone spec. Use after spec-run or spec-branch-refine, before spec-pr, or when asked for an implementation walkthrough, deploy-safety case, executable-evidence report, proof review, or QA handoff. The tour surfaces blocking evidence, residual risk, claim-to-gate traceability, rerunnable proof, QA scenarios, and deployment recovery without presenting the manifest as a wall of cards or tables.
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

## Design Posture — Evidence Review Instrument

Build the HTML for an engineer, reviewer, QA practitioner, or operator who needs to:

1. orient — identify the outcome, verdict, exact commit, branch, and deployment posture;
2. decide — see blockers, stale evidence, residual risk, and optional follow-up before supporting detail;
3. trace — follow requirement → claim → gate → observed proof → proof boundary without joining distant tables;
4. rerun — copy the exact command and open the artifact for the selected gate;
5. explore — execute one QA scenario with its setup, expected result, automation, and visual evidence;
6. recover — understand migrations, configuration, observability, rollback, and post-deploy checks.

Every element visible by default must support one of those tasks. Do not add ornamental hero treatment, large metadata cards, all-equal card stacks, repeated claim and gate sections, or a fully expanded implementation diary. Readiness counts are allowed only when they directly establish the merge or deployment decision; do not turn test totals into vanity metrics.

Use a minimalist, functionalist composition:

- white background, Inter or a system sans-serif, compact type, thin rules, and direct labels;
- grayscale for structure;
- green only for proven, passed, ready, or passing audit states;
- red only for blocking, failed, or unproven states;
- amber only for partial, stale, residual-risk, or optional non-passing states;
- text labels in addition to every status color;
- progressive disclosure for long rationale, architecture decisions, and implementation history;
- one selected claim inspector and one selected QA scenario in the interactive view; expand all in print.

Use this default reading order: verdict and commit → attention queue → before/after architecture → selected claim and gates → selected QA scenario → deployment and recovery → collapsed implementation log. Default the claim and QA inspectors to the first non-passing or incomplete evidence path; otherwise select the first item.

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
  "title": "Concise observable outcome",
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

Keep `title` short enough to act as a navigation landmark. Write `summary` as two to four front-loaded sentences: prior failure, implemented behavior, strongest integrated proof, and any audit correction that materially changed the result. Put detailed history in architecture, decisions, steps, or evidence—not in the heading.

Allowed verdicts are `ready` and `blocked`. Claim statuses are `proven`, `partial`, and `unproven`. Gate statuses are `passed`, `failed`, `blocked`, and `stale`. `required` mirrors the planned merge/deploy gate; omit optional exploration artifacts from the readiness calculation but still display them. `deployment.ready` is true only when the top-level verdict is `ready`. No manual action may be necessary to establish the verdict.

Never mark a claim `proven` when none of its linked gates passed. A runbook proves that a procedure exists; it does not prove that the procedure ran or that production recovered. Keep post-deploy execution `unproven` or restate the claim narrowly around the verified runbook artifact.

Every acceptance criterion must appear in at least one claim. Every claim must name at least one gate. Every gate must name the failure hypothesis it rejects. Use checkout-relative artifact paths where possible. Do not embed secrets, credentials, production records, or sensitive screenshots.

## Render And Inspect The HTML

Run:

```bash
node ~/.agents/skills/spec-work-tour/scripts/render-work-tour.mjs \
  .specs/<feature>/work-tour.json \
  .specs/<feature>/work-tour.html
```

The renderer validates the structural invariants and exits nonzero on an invalid manifest. The HTML is self-contained except for checkout-relative evidence links. Render checkout-relative, package-relative, and URL evidence as usable links when they resolve; mark unresolved local paths visibly instead of silently styling them as ordinary code.

The default HTML composition must expose:

- a compact verdict header with the bound commit and decision-relevant closure counts;
- an attention queue ordered as blocking gaps and required failures, incomplete claims, audit failure, optional non-passing gates, then residual risks;
- before/after architecture and system boundaries, with decisions collapsed by default;
- a claim list and selected inspector that colocates requirements, gates, rerunnable commands, artifacts, observed proof, rejected hypotheses, and proof boundaries;
- QA entrypoints plus a selected scenario with steps, expected states, automation, and visual artifacts;
- migration, configuration, observability, rollback, audit, and residual-risk facts;
- a collapsed implementation log with steps, commits, files, and outcomes.

Do not make a reviewer scroll through every gate, scenario, and implementation step to find the evidence that qualifies the verdict. Do not hide residual risk merely because `verdict: ready`.

Open the HTML in a browser and inspect it at desktop and narrow widths. For a visual implementation, include the implementation's captured states in the QA section and inspect those images too. Confirm keyboard-visible claim and scenario selection, URL-deep-link selection, copy-command feedback, local artifact links, print expansion, and that only the intended region overflows horizontally. Correct broken links, overflow, unreadable content, missing sections, and inaccurate summaries. The first wide viewport must reveal the verdict and real attention items, not a long rationale or metadata dashboard. The renderer's success proves shape, not truth; compare sampled rows back to their source artifacts.

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
