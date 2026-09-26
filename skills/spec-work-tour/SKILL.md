---
name: spec-work-tour
description: "Build or refresh the final machine-readable evidence verdict and practitioner-facing HTML work tour for an implemented standalone spec. Use as the explicit stage after spec-branch-refine and before spec-pr, or when asked for an implementation walkthrough, deploy-safety case, executable-evidence report, proof review, or QA handoff. The tour surfaces blocking evidence, residual risk, claim-to-gate traceability, rerunnable proof, QA scenarios, and deployment recovery without presenting the manifest as a wall of cards or tables."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "5"
---

# Spec Work Tour

Assemble the implemented spec's evidence into two commit-bound artifacts with separate merge,
deployment-readiness, authorization and post-deployment states:

- `.specs/<feature>/work-tour.json` — the machine-readable context, claim, proof, QA and phase verdicts.
- `.specs/<feature>/work-tour.html` — a portable browser tour of what changed and why the evidence is sufficient.

The tour is not a narrative substitute for proof. It is a navigable projection of evidence that already exists and can be rerun. Read [references/executable-evidence.md](references/executable-evidence.md) before producing either artifact.

Apply the work-tour section of [Engineering Writing](../../rules/engineering-writing.md).
Write for an experienced engineer unfamiliar with this change. Describe the software and observed
results directly; keep workflow provenance in machine fields. Before sharing the HTML, include
needed supporting material with it or use accessible shared links. Do not make readers follow
`.specs/`, uncommitted files, temporary reports, or paths outside the repository.

## Reader and layout

Build the HTML for an engineer, reviewer, QA practitioner, or operator who needs to:

1. orient — identify the outcome, merge verdict, exact commit, context, and separate release states;
2. decide — see blockers, stale evidence, residual risk, and optional follow-up before supporting detail;
3. trace — follow requirement → claim → gate → observed proof → proof boundary without joining distant tables;
4. rerun — copy the exact command and open the artifact for the selected gate;
5. explore — execute one QA scenario with its setup, expected result, automation, and visual evidence;
6. decide on operations — see actual release/recovery obligations, authorization, pending checks,
   and any new configuration or maintenance burden. No person is expected to read specs or code.

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

Use this default reading order: verdict and commit → attention queue → sourced context and decisions → before/after architecture → selected claim and gates → selected QA scenario → deployment and recovery → collapsed implementation log. Default the claim and QA inspectors to the first non-passing or incomplete evidence path; otherwise select the first item.

Use ordinary section labels: **Outstanding issues**, **Background**, **What changed**,
**Verification**, **Test scenarios**, **Deployment**, and **Commits**. In the HTML, call a
gate a check, describe a claim as behavior, and label a proof boundary **Limits**. Keep
the exact machine terms in JSON and identifiers in optional reference details. Do not
add slogans such as “evidence that closes the work,” labels such as “sourced context,”
or a footer explaining the workflow. Show the change summary directly below the title.

## Evidence Assembly Boundary

Assemble existing observations; do not perform live operations to finish the report. Never weaken
an applicable gate to make the tour pass. Missing, stale, red, or non-reproducible required merge
evidence produces `verdict: blocked`. Pending deploy/post-deploy evidence stays in its own phase.
Route unresolved consequential context decisions to the coordinator under the shared contract.
Human operational authorization is a separate legitimate decision, not a correctness gate.

## Resolve The Package And Commit

Resolve an explicit `.specs/<feature>/` folder or contained artifact first, then the feature named in the conversation. Stop on ambiguity. Resolve the repository root, merge base, current branch, and exact `HEAD` SHA. The tour is commit-bound to that SHA.

Read, when present:

- sourced `context.md` and current project context; compare relevant sources for material changes
- `proposal.md`, `critique.md`, and `prototype/`
- `spec.md`, `spec-steps.json`, `evidence-plan.json`
- `spec-prepare.md`, `preparation.json`, `criteria.md`, `invariants.md`
- every `step-<NNN>-subspec.md` and `step-<NNN>-learning.md`
- `merge-evidence.md` and `merge-evidence.json`
- `evidence/`, `blockers.md`, and the latest branch review/fix artifacts
- the merge-base-to-HEAD commits and diff

Required inputs for an implemented spec are `context.md`, `spec.md`, version 2 `evidence-plan.json`, version 3 `preparation.json`, all expected learnings, and `merge-evidence.json`. A final merge-ready tour additionally requires a current passing branch evidence audit. If an older package predates one of these contracts, report the missing artifact as a blocking evidence gap; do not silently infer a pass.

## Revalidate Provenance And Gates

Validate all artifact hashes and commit bindings that their schemas provide. Then walk every claim and required gate in `evidence-plan.json`:

1. Confirm the claim maps to an applicable sourced requirement, with the correct decision phase.
   Validate the context snapshot/hash and expose consequential decisions and omissions.
2. Confirm each failure hypothesis has at least one relevant gate capable of rejecting it.
3. Confirm each executed gate has an observation artifact, exact command/procedure, actual target,
   effects, authority source, outcome and proof boundary. Later-phase gates may be `pending`, with a
   concrete procedure but no fabricated observations. Commands are not permission to execute them.
4. Re-run cheap, safe gates when freshness is uncertain. For expensive or environment-specific gates, verify a commit-bound result and record why it was not rerun.
5. Confirm the final branch audit independently examined the integrated diff and closed every actionable finding.
6. Treat open merge blockers, unresolved merge findings, material context changes, stale code
   bindings and missing required merge environments as blocking. Classify later-phase gaps
   separately; a known defect that also disproves a merge claim remains a merge blocker.

Record honest limits. A unit test proves the unit behavior it observes; it does not prove production reachability. A screenshot proves the rendered state shown; it does not prove data integrity. A migration dry-run proves the tested fixture and environment; it does not prove an untested production dataset.

For standalone version 2 packages, apply the Assembly, Tour, And Publication section of [Engineering Decisions](references/standalone-engineering-decisions.md).
Expose consequential domain rules and resolved challenges in `architecture.decisions`, ordinary
entry observations in existing QA/gate fields, and accepted follow-ups in `context.omissions`.
For a local follow-up, include the actionable brief and revisit condition, not just an ignored
`.specs` path. Preserve the distinction between a bounded completed slice and an unmet merge
claim. Use the existing schema and renderer; do not add keys or a new readiness calculation.

## Build `work-tour.json`

Write version 2 JSON with a trailing newline:

```json
{
  "version": 2,
  "feature": "feature-slug",
  "title": "Concise observable outcome",
  "generatedAt": "canonical ISO 8601 timestamp",
  "repository": ".",
  "branch": "feature-branch",
  "base": "origin/main",
  "commit": "full HEAD SHA",
  "verdict": "ready",
  "summary": "What changed and the user/system outcome.",
  "context": {
    "artifact": ".specs/feature/context.md",
    "sha256": "<64 lowercase hex characters>",
    "summary": "Actual users, retained data, compatibility and release model.",
    "decisions": ["Decision and its user/project-policy source."],
    "omissions": ["No rollout flag: the existing release process does not require one."],
    "burden": ["New maintained or operational obligations, or none."]
  },
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
    "phase": "merge",
    "statement": "Observable claim",
    "requirements": ["AC-1"],
    "status": "proven",
    "gates": ["EV-1"],
    "explanation": "Why the evidence closes the claim."
  }],
  "gates": [{
    "id": "EV-1",
    "phase": "merge",
    "kind": "integration-test",
    "required": true,
    "status": "passed",
    "command": "bun test path/to/test.js",
    "environment": "isolated local test database",
    "effects": "Creates and removes disposable fixtures.",
    "authorization": "isolated local execution",
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
    "readiness": "not-assessed",
    "authorization": "not-requested",
    "authorizationSource": "none",
    "postDeploy": "not-run",
    "gaps": ["Deployment process has not been assessed in this run."],
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

Keep `title` specific to the changed behavior. Write `summary` as a short explanation of the
problem and resulting behavior; include an observation or limitation only when needed to assess
the result. Do not require a sentence about audit corrections or the implementation process.
Use before/after fields for the relevant data flow and evidence fields for scenario, observed
result, and limits. Each field should add information, not repeat the summary in different jargon.
Keep all required IDs, statuses, provenance, and commands in their designated machine fields.

The top-level `verdict` is **merge evidence**: `ready` or `blocked`. `gaps` contains merge gaps only.
Include at least one merge claim. Claims have `phase: merge | deploy | post-deploy` and status `proven | partial | unproven`. Gates
have the same phase enum, `required: boolean`, and status `passed | failed | blocked | stale | pending`.
Copy phases, required flags, target/effects and authority from the evidence plan; do not reclassify
failed merge work to a later phase. Claim/gate links are reciprocal and same-phase. A proven claim
requires at least one required gate and all its required gates passed at this commit.

- `verdict: ready` requires all merge claims proven, required merge gates passed, no merge gaps,
  and a current independent audit pass. Later-phase pending gates are permitted.
- `deployment.readiness`: `ready | blocked | not-assessed | not-applicable`. `ready` requires merge
  readiness, all deploy claims proven and required deploy gates passed, no deployment gaps, and an
  assessed existing release process. `not-applicable` needs a context justification and no deploy
  or post-deploy claims/gates; authorization and observations are also `not-applicable`. Do not infer it just because the project is a prototype.
- `deployment.authorization`: `not-requested | required | granted | not-applicable`. `granted`
  requires a precise `authorizationSource` citing current user instructions/project policy for the
  target/action; an agent-authored plan or credential is insufficient. Readiness never grants it.
- `deployment.postDeploy`: `not-run | passed | failed | not-applicable`. `passed` requires observed
  required post-deploy gates and all post-deploy claims proven. Pending execution is `not-run`.
  A failed post-deploy gate cannot be hidden behind `not-run` or `passed`.

The renderer checks structure and contradictory statuses, not whether an authorization source or
observed result is truthful. The audit verifies those sources. Keep unrelated or optional discovery
out of blocking calculations. No manual code review or testing may establish correctness; a human
may still decide whether an independently evidenced operation is authorized.

Never mark a claim `proven` on an optional gate while a required gate is unpassed. A runbook proves that a procedure exists; it does not prove that the procedure ran or that production recovered. Keep post-deploy execution `unproven` or restate the claim narrowly around the verified runbook artifact.

Every acceptance criterion must appear in at least one claim. Every claim must name at least one gate. Every gate must name the failure hypothesis it rejects. Use portable artifact paths: resolve `.specs/` from the primary repository and code/test paths from the execution checkout. Pass canonical absolute input/output paths to the renderer while running it in the code checkout. Do not embed secrets, credentials, production records, or sensitive screenshots.

## Render And Inspect The HTML

Run:

```bash
node ~/.agents/skills/spec-work-tour/scripts/render-work-tour.mjs \
  .specs/<feature>/work-tour.json \
  .specs/<feature>/work-tour.html
```

The renderer retains version 1 reading for existing Design/SpecOps callers and labels those
outputs as legacy reported statuses. A legacy render is not a valid result of this standalone
skill and cannot satisfy its version 2 publication contract.

The renderer validates the structural invariants and exits nonzero on an invalid manifest.
Supporting files beside the output HTML must travel with it when shared. Other local links
must reference committed content available in the reviewed revision; URLs must be accessible
to the intended reader. The renderer omits explicit `.specs/` and absolute local references
and marks unavailable supporting files without printing their paths. Explain essential results
inline; do not make readers reconstruct them from local provenance. Check links in the form
actually shared, not only in the author's checkout.

The default HTML composition must expose:

- a compact merge verdict header with the bound commit and separate deployment, authorization
  and post-deployment states; count merge closure separately from later pending work;
- an attention queue ordered as blocking gaps and required failures, incomplete claims, audit failure, optional non-passing gates, then residual risks;
- a concise sourced context summary with consequential decisions, omissions and new burden;
- before/after architecture and system boundaries, with implementation decisions collapsed by default;
- a claim list and selected inspector that colocates requirements, gates, rerunnable commands, artifacts, observed proof, rejected hypotheses, and proof boundaries;
- QA entrypoints plus a selected scenario with steps, expected states, automation, and visual artifacts;
- migration, configuration, observability, rollback, audit, and residual-risk facts;
- a collapsed implementation log with steps, commits, files, and outcomes.

Do not make a reviewer scroll through every gate, scenario, and implementation step to find the evidence that qualifies the verdict. Do not hide residual risk merely because `verdict: ready`.

Open the HTML in a browser and inspect it at desktop and narrow widths. For a visual implementation, include the implementation's captured states in the QA section and inspect those images too. Confirm keyboard-visible claim and scenario selection, URL-deep-link selection, copy-command feedback, local artifact links, print expansion, and that only the intended region overflows horizontally. Correct broken links, overflow, unreadable content, missing sections, and inaccurate summaries. The first wide viewport must reveal the verdict and real attention items, not a long rationale or metadata dashboard. The renderer's success proves shape, not truth; compare sampled rows back to their source artifacts.

## Freshness Rule

Any material context/authority change or code, test, migration, configuration, lockfile, or deployment-file change after the tour's evidence was assembled invalidates the tour. Re-run affected gates, re-run the branch audit when the integrated diff changed, update `work-tour.json`, and render again. `spec-pr` must compare the tour commit to the pushed HEAD and refuse publication when they differ.

## Output

For an agent handoff, return `outcome: ready` or `outcome: blocked`, JSON/HTML paths, exact bound
commit, evidence counts, and separate deployment readiness/authorization/observations and gaps.
For the user, report the result, the tour location, and any material blocker, limitation, or next
action. Keep the full bookkeeping in the manifest rather than reciting it in the response.

Do not commit `.specs/` unless the repository explicitly tracks it. Do not describe a blocked tour as merge-ready.
