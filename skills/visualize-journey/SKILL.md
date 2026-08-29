---
name: visualize-journey
description: Turn one documented JRNY-### user journey into a practitioner-facing visual instrument with a compact repository path, selected-step inspector, screenshots, exact CTAs, seam handoffs, exits, context losses, prioritized risks, evidence links, and a portfolio index. Use when the user asks to visualize a journey, create a journey storyboard or operator map, show where a journey begins and crosses repositories, explain what each step looks like, expose journey problems visually, or help product and operations teams troubleshoot and improve a documented journey. Requires a journey registry row and journey page; follows build-journey-map and document-journey.
metadata:
  version: "1"
---

# Visualize Journey

Create a derived visual tool for operators. Keep the journey registry and `JRNY-###` page canonical; the visual map makes their evidence scannable and actionable.

## Design posture — practitioner instrument

This is a working surface for someone analyzing and improving a journey, not a presentation or executive dashboard. Optimize the default view for four tasks:

1. Orient — understand the goal, start, terminal outcome, repositories, and complete path.
2. Compare — scan the steps as small multiples and spot changes in ownership, surface, action, and evidence.
3. Diagnose — identify where context is lost, commitments become ambiguous, recovery weakens, or evidence is absent.
4. Choose the next investigation — move from a prioritized risk directly to the affected step and its source evidence.

Every element visible by default must help one of those tasks. Do not add KPI tiles, journey-score metrics, decorative hero regions, large endpoint cards, legends that duplicate direct labels, or repeated expanded cards. Counts belong in validation output or a compact portfolio listing unless a count changes an operator decision.

Use a minimalist, functionalist composition:

- white background, Inter or a system sans-serif, compact type, thin rules, and direct labels;
- grayscale for structure and reading order;
- muted repository color only for lane and ownership wayfinding;
- severity color only for risk, warning, missing evidence, or destructive outcomes;
- a compact journey path first, followed by one selected-step inspector and one prioritized work queue;
- small screenshot thumbnails in the path; one legible screenshot in the selected-step inspector;
- readable small-multiple nodes; prefer deliberate horizontal path scrolling to truncated labels, and keep repository ownership visible while scrolling;
- details such as coverage gaps and recovery paths collapsed until requested.

Color must never be the only carrier of meaning. Do not use color as decoration, alternate-card styling, or brand theater. Do not fabricate opportunities, impact estimates, or behavioral conclusions. Label proposed work as an investigation or hypothesis until linked behavioral evidence supports it.

The map must answer, without opening source code:

1. Where does the journey begin, and what triggers it?
2. Which repository, host, route, and screen owns each step?
3. What does the user see?
4. Which CTA advances, branches, cancels, or abandons the journey?
5. What context crosses each seam, and what gets lost?
6. Which issues block trust or conversion, how severe are they, and where do they occur?
7. What evidence exists, what is inferred, and what has not been captured or tested?
8. Which investigation should the practitioner take next, and why is it prioritized?

## Step 0 — Require canonical inputs

Read the full registry row, journey page, and referenced seams first:

```text
docs/journey-registry.md
docs/journeys/JRNY-###-<slug>.md
```

If the row does not exist, run `build-journey-map`. If the row exists but the page does not, run `document-journey`. Do not visualize a journey from memory or a loose list of routes.

Then read the journey page's linked screen pages, screenshots, context findings, E2E catalog lane, and source files for visible CTA strings. Re-verify routes and CTA wording against code because these details rot fastest.

## Step 1 — Build the operator step sequence

Use one visual step for each user-perceivable surface or redirect that changes ownership, state, or decision context. Do not force one card per abstract journey stage when several surfaces occur inside that stage.

For every step record:

- sequence number and standard stage;
- repository, host, route, and `SCRN-###` when one exists;
- what the user sees and the decision the user makes;
- exact CTA labels and destinations;
- context established and required;
- seam ID and transition type;
- exits and recovery paths;
- screenshot status;
- issues with severity, status, source, and a concrete consequence;
- evidence links.

Record redirect-only controller states when they change identity, ownership, or delivery behavior even though they have no stable screenshot. Record registered content-sync or other pre-entry seams in `upstreamSeams` so the visual projection covers every seam declared by the canonical journey.

Use `references/operator-map-schema.md` for the manifest contract.

## Step 2 — Treat screenshots as evidence

Prefer existing versioned captures under `docs/screenshots/SCRN-###/`. Use the capture whose state matches the journey step, not merely the screen's default.

When no capture exists:

1. Capture the real surface when a safe local or test environment is available.
2. Store journey-only captures under `docs/journeys/visuals/JRNY-###/captures/`.
3. Use seeded or synthetic data only; never include real customer data, tokens, or payment details.
4. Record the viewport, state, source version, and capture date in the manifest note.
5. For an external provider or inbox surface that the product team does not own, use `status: external` and state what evidence would be needed for a safe capture.
6. For a controller redirect with no stable UI, use `status: redirect` and explain the automatic behavior.
7. For an owned surface that should be capturable but is not, use `status: missing` and state why. Never substitute a stock image, generated mockup, or unrelated screenshot.

Prefer one stable synthetic JobKit, level, buyer, and organization across the complete capture set. When existing screen captures use different fixtures, keep them as structural evidence but add a visible coverage issue; do not imply that they prove visual object continuity.

A missing capture is visible operational debt. The renderer must show the placeholder; do not hide the step.

## Step 3 — Encode CTAs and seams

Quote CTA text exactly from source. Classify each CTA:

- `primary` — advances the registered goal;
- `secondary` — stays useful but branches from the canonical path;
- `destructive` — ends or irreversibly changes state;
- `system` — automatic redirect, poll, email, or provider callback.

Every CTA states its destination or effect. Every repository, host, identity, content-sync, or third-party boundary references its registry `SEAM-###` when available.

If a third-party surface has not been safely captured, do not invent its CTA copy. Use a descriptive label with `labelStatus: unknown`, explain the known destination or effect, and attach a coverage issue. Rendered unknown labels must remain visually distinct from verified product copy.

Show both sides of a seam:

- **Carries:** URL params, identity, identifiers, and ledger facts that survive.
- **Loses:** user-visible context, attribution, state, or work that disappears.

Do not issue new seam IDs. Mark an unregistered crossing `provisional` and open a question for `build-journey-map`.

Encode conditional paths explicitly in `transition.branches`, including returns to an earlier step, direct-to-terminal success, retries, cancellation, and provider-owned recovery. Keep `toStep` as the default forward reading path; branches record the alternatives.

## Step 4 — Put issues on the step where they cost the user

Attach each `CTX-` finding, test gap, inventory gap, stale promise, context loss, or abandonment risk to the affected step.

Use severity consistently:

- `critical` — prevents the terminal outcome or risks an unsafe transaction;
- `high` — breaks identity, price, object, or commitment trust at a major decision;
- `medium` — creates recoverable confusion, context loss, or abandonment risk;
- `low` — localized friction with a clear recovery;
- `info` — evidence or coverage gap without a confirmed user defect.

Do not inflate severity. A source finding keeps its existing severity. Derived issues state `source: inferred` and link an open question or code evidence.

Each issue must say what the operator can investigate next. Avoid generic labels such as “UX issue.”

Record product-analytics, timing, abandonment, error-rate, support-volume, or research evidence in top-level `behaviorEvidence`. If none is linked, set `status: missing` and state visibly that severity reflects implementation evidence and expert judgment rather than observed user impact. Never translate implementation issue counts into a funnel score or implied business metric.

## Step 5 — Write and render the visual package

Write:

```text
docs/journeys/visuals/JRNY-###/
├── manifest.json
├── index.html
└── captures/                 # only when journey-specific captures are needed
```

The manifest is a derived projection, not a new authority. Its `journey.source` points to the canonical journey page and its `verifiedAgainst` values match that page.

The generated individual map uses this default composition:

1. compact journey identity and start-to-terminal route;
2. the complete repository path, with directly labeled steps and inline seam, context-loss, and severity cues;
3. a selected-step inspector for surface, decision, action, context, handoff, local risk, and evidence;
4. a severity-ordered work queue that selects the affected step;
5. collapsed coverage gaps and recovery or abandonment paths.

Do not render all step details simultaneously in the interactive view. The print view may expand every inspector panel so the artifact remains archival.

Render the individual map:

```bash
node ~/.agents/skills/visualize-journey/scripts/render-journey-map.mjs \
  --manifest docs/journeys/visuals/JRNY-###/manifest.json \
  --output docs/journeys/visuals/JRNY-###/index.html
```

Regenerate the portfolio index so twenty journeys remain navigable:

```bash
node ~/.agents/skills/visualize-journey/scripts/render-journey-map.mjs \
  --collection docs/journeys/visuals \
  --output docs/journeys/visuals/index.html
```

The generated portfolio provides text search, entry-system filtering, live result counts, and a clear empty state. Link this portfolio from the registry, then link the individual operator map from its journey row and journey page.

Add the operator map to the journey page's visual/evidence links. Do not widen the registry row with visual detail; the registry remains a thin index.

## Step 6 — Validate the operator map

Run the renderer with `--check` after rendering. This flag validates while regenerating the derived HTML; it is not a read-only command:

```bash
node ~/.agents/skills/visualize-journey/scripts/render-journey-map.mjs \
  --manifest docs/journeys/visuals/JRNY-###/manifest.json \
  --output docs/journeys/visuals/JRNY-###/index.html \
  --check
```

Confirm:

1. The manifest ID, title, source, stages, screens, seams, CTAs, and issues agree with the canonical journey page and source evidence.
2. Step sequence numbers are contiguous and each repository exists in `repositories`.
3. Every screenshot has accurate alt text and either resolves or is explicitly `missing`; external and redirect-only states are identified separately.
4. Every CTA has a label, kind, and destination or effect; unknown external labels carry `labelStatus: unknown` and a coverage issue.
5. Every issue has an ID, severity, consequence, status, source, and next investigation.
6. Every canonical `SEAM-###` is projected once or more, including pre-entry seams; every `SCRN-###`, `CTX-`, E2E lane, and evidence link resolves.
7. The page works at wide and narrow viewports, with keyboard-visible filters and no horizontal page overflow. The swimlane itself may scroll horizontally.
8. Selecting a path node, priority item, or recovery item updates the inspector, selected state, and URL hash. Exactly one inspector panel is visible interactively; every panel is available in print.
9. The first wide viewport contains the journey identity and useful path evidence; it does not begin with metrics, ornamental framing, or duplicate endpoint summaries.
10. Repository and severity colors retain readable text labels and are not used decoratively.
11. The behavioral-evidence status is visible beside the priority queue and never implies observed impact when evidence is missing.
12. Print output preserves step order, repository ownership, CTAs, and issues.
13. The portfolio index links every manifest exactly once and can search, filter, clear, and show an empty result at 320px and wider. Portfolio counts remain subordinate navigation aids, not performance claims.

Report the map path, portfolio path, steps and repositories shown, screenshots present and missing, external and redirect-only states, issue counts by severity, seams shown, conditional branches, and evidence or test gaps.

## Updating an existing map

Re-read the canonical journey page and sources. Preserve the journey identity, replace stale step projections, remove resolved issues only when their source status changed, retain missing-capture placeholders until evidence exists, and regenerate both HTML files. Never hand-edit generated HTML.
