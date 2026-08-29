# Journey page template

The section order below is the repository standard's journey standard (FirstWho: `docs/rules/feature-documentation-rules.md` §9, DR-083) as a subsequence. Sections 1–3, 7, and 8 are the standard's. Sections 4, 5, and 6 are this skill's extensions to the standard's seams and stage requirements. Where a repository standard defines its own order, keep its order and insert the extensions.

Every level-2 heading carries a stable anchor. Every empty section reads `None.` with a reason. Prose follows the standard's §14.

---

## Front matter

```yaml
---
id: JRNY-001
title: Purchase a standalone JobKit          # the actor's goal, verb phrase (DR-045)
type: journey
status: draft                                 # draft | in-review | active | deprecated | retired
owner: growth
last_reviewed: 2026-08-28
review_interval_days: 90
verified_against:
  - app@<commit the tracing read>
  - marketing@<commit the tracing read>
repos: [marketing, app, stripe]               # in visit order, with third parties
actor: anonymous-prospect                     # one actor; see personas.js
roles: []                                     # ROLE-## when authenticated; empty for anonymous
jobs: [JOB-0041]                              # primary story first (DR-106)
screens: [SCRN-030, SCRN-031]                 # registered screens the journey visits
features: []                                  # FEAT-## when a feature registry exists
rules: [BR-0101]                              # BR- IDs, referenced never restated (DR-092)
seams: [SEAM-004, SEAM-007]                   # registry seam IDs
e2e_lanes: [GP-1]                             # catalog IDs that run this journey
context_keys: [kitName, quotedPrice]          # ledger facts the journey establishes
tests:
  - app/test/e2e/journeys/GP-001-anonymous-standalone-purchase.e2e.js
derived_from:
  - docs/journey-registry.md@<version>
---
```

An empty list is valid. A missing key is not. `context_keys` uses the E2E ledger key names verbatim so the context audit consumes this page without translation.

---

<a id="1-goal"></a>
## 1. The goal

What the user completes, in the user's words, and what "completed" means as an observable end state. Name the promise the journey was launched from: the CTA or content that created the expectation. 60 words or fewer.

<a id="2-actor-and-situation"></a>
## 2. Actor and situation

Who this actor is (persona, `ROLE-##` when they hold one), what triggers the journey, and the state they start in. The E2E catalog fields `persona`, `startState`, and `acquisition` are the sourced form of this section; quote them when they exist.

One paragraph on what the actor must believe at the end — the trust outcome, not just the record outcome.

<a id="3-job-stories"></a>
## 3. Job stories

Primary story first, then secondaries, in the standard's exact form:

```
JOB-####  When <situation>, I want to <motivation>, so I can <expected outcome>.
Evidence: <what supports this>
Confidence: sourced | inferred
```

Every `inferred` story has an open question. A story that spans the redesign survives it: no control or screen names in the motivation.

<a id="4-stages"></a>
## 4. Stages

The journey's spine. One subsection per stage the journey visits; state which of the eight standard stages are absent and why. Each stage subsection carries a table:

### 4.n Confirm — commit to the purchase

*Why this stage exists, in one sentence, naming the journey.*

| Surface | Action and decision | Establishes | Requires | Exit |
|---|---|---|---|---|
| app: `/review-order` (SCRN-031) | Confirm the kit and price before paying | `kitName`, `quotedPrice` | — | Stripe Checkout (SEAM-007) |

Authoring notes:

- **Surface** is repository-qualified. `marketing:` , `app:`, `jobs.*:`, `email:`, `stripe:`. An unregistered screen is written as `app: /route (no SCRN — inventory gap)`.
- **Establishes / Requires** use ledger keys. A `requires` fact not visible on the surface is written as `REQUIRES NOT MET on page: <what the user must remember>` and repeated in §6 and `Open questions`.
- **Exit** names the next surface and whether the user ever returns to this one changed.
- Stage cadence: mark stages the user revisits (plan comparison, library return) versus pass-throughs.

<a id="5-entry-and-exit-points"></a>
## 5. Entry and exit points

**Entries.** Every way the journey starts: marketing CTA, email link, campaign landing, direct URL, in-app cross-sell. One row each, with its source file.

**Exits and abandonment.** Every way the journey ends without the goal — payment failure, budget exhausted, verification email never opened, user closes the tab between repos — and what state the product leaves behind. Most abandonment lives in `prepare` and `confirm` (DR-084 rationale); those stages get named exit rows, not prose.

<a id="6-seams"></a>
## 6. Seams

Reference the registry's `SEAM-###` rows; add only the journey-specific consequence. Format per seam:

> **SEAM-004** (handoff, marketing → app) — The prospect carries `kitName` and `quotedPrice` only in memory across `/register`. The app re-derives both from the shortcode on `/review-order`; the register page itself names neither. Consequence: the promise made by the marketing page is unverifiable at the identity step. Related finding: CTX-GP-1-start-checkout-missing-object.

A crossing the registry lacks is written here, marked `provisional`, and raised as an open question for `build-journey-map`.

<a id="7-features-and-rules-per-stage"></a>
## 7. Features and rules per stage

| Stage | Feature | Rule | Audience |
|---|---|---|---|

`FEAT-##` and `BR-##` IDs with the point of application. Never a rule's number — the registry holds values (DR-092). `None.` until a feature registry exists.

<a id="8-end-to-end-examples"></a>
## 8. End-to-end examples

Two or three complete runs, Given/When/Then, `EX-####` IDs, realistic seed data, at least one boundary and one failure:

```markdown
#### EX-0101 Kit purchased at the trial boundary
**Given** a verified user "dana@acme.test" on a new account with no org
**And** marketing page "Senior Backend Engineer Kit" priced $149.00 USD
**When** the user completes `/buy/kit/sbe-1042` through Stripe test mode
**Then** the settlement shows `payment_status: paid` via the Stripe API
**And** `/my-kits/sbe-1042` renders the owned kit
**And** no org exists until the first job is created
Rules: BR-0101
Test: app/test/e2e/journeys/GP-001-anonymous-standalone-purchase.e2e.js:settles
```

The negative statement (`And no org exists...`) is required wherever a reader might assume extra side effects (DR-119).

<a id="9-visual-and-evidence-links"></a>
## 9. Visual and evidence links

| Stage | Kind | Reference | Notes |
|---|---|---|---|

Screenshots from `docs/screenshots/SCRN-###/`, E2E receipts and storyboard locations, `CTX-` findings, marketing content files. This section feeds journey evaluation and design QA; it links, never copies. States with no capture read `Not captured — <reason>.`

## Open questions

`OQ-###` — question, owner, date. Every inferred story, provisional seam, inventory gap, unmet `requires`, and proposed ledger key.

## Changelog

| Date | Version | Change | Author |
|---|---|---|---|
