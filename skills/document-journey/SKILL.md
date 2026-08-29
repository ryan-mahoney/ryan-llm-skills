---
name: document-journey
description: Document one registered user journey as a JRNY-### journey page, traced across every repository it crosses — marketing site, application monolith, public microsites, email, and Stripe — with stages, seams, context facts established and required, and evidence links. Use when the user says "document this journey", "write the journey page", "document JRNY-003", or names a goal like "the checkout journey" or "candidate application journey" and asks for documentation. Requires a journey-registry row; precedes journey evaluation and design QA. Not for one screen (document-screen-behavior) and not for identifying journeys (build-journey-map).
metadata:
  version: "1"
---

# Document Journey

Write one journey page: the user's end-to-end goal, stage by stage, screen by screen, repository by repository, with every seam recorded and every claim traced to evidence.

The failure this skill exists to prevent is the journey page that reads like a marketing brochure — "the user discovers the product, signs up, and purchases" — with no routes, no carried state, and no losses. Such a page supports neither evaluation nor design QA, because there is nothing in it to check the product against. A useful journey page states, for each stage: where the user is (which repository, which route, which `SCRN-###`), what they were promised, what they must decide, what facts the journey established earlier that this page must honor, and what breaks at the boundary.

This skill writes **journey** pages only:

- A request naming one surface → `document-screen-behavior`. Stop and say so.
- A request to find or register journeys → `build-journey-map`. Stop and say so.
- A request to *evaluate* a journey (audit information sufficiency, critique screens) → this page is the input to that work, not the work itself. Write or update the page, then point at the evaluation tools.

## Step 0 — Take the row from the registry

The journey must exist in `docs/journey-registry.md`. Read the row, its `SEAM-###` entries, and the E2E lane mapping. **The registry issues the ID; never invent one.** When no registry row covers the requested goal, stop and tell the user to run `build-journey-map` first — a journey documented outside the registry is a second source of truth.

Read, pinning each to its `verified_against`:

```
docs/journey-registry.md
docs/permissions/permission-model.md
docs/inventories/<relevant>-screens.md
docs/screens/SCRN-###-*.md          <- every screen page the journey touches that exists
app/test/e2e/fixtures/journey-catalog.js   <- the journey's catalog entry (steps, intent, ledger keys)
app/test/e2e/journeys/<lane>.e2e.js        <- its implementation
```

## Step 1 — Read the repository standard

Find the product-documentation standard (FirstWho: `docs/rules/feature-documentation-rules.md`). Its journey section wins over this skill's template — for FirstWho that is §9 (DR-083 to DR-085): the eight required sections, the eight-stage frame `define → locate → prepare → confirm → execute → monitor → modify → conclude`, and the seam obligations. This skill's template extends that standard with the cross-repo fields downstream evaluation needs; it does not reorder or delete standard sections. If the standard forbids an addition, honor it, put the content in `Open questions`, and propose the amendment.

## Step 2 — Trace the flow in code, in every repository

Work from evidence; every claim traces to a file. Walk the journey as the user does, and at each stage record:

| Question | Where to look |
|---|---|
| What did the user see before crossing? | The prior stage's screen page, or the marketing component and its content JSON |
| What exactly carries across the URL? | The link's href construction: constants, query params, shortcodes, `crmSlug`/`jobId` |
| Which route receives them, and what guard admits them? | `backend-routes.js` and the React route tables; host rewrites in `app.js` for `jobs.*`/`info.*` |
| What does the session depend on? | Auth middleware, verification tokens, invitation records |
| What facts does this page require or destroy? | Component source for displayed values; the E2E step's `establishes`/`requires` keys |
| Where does email re-enter? | `app/email_templates/`, `py_email/` templates and their link targets |
| What does the automation already prove? | The E2E journey file: step order, `intent`, `expected`, seeded fixtures |

Quote visible strings exactly from source. Record what you could not establish as an open question with a named owner. Do not invent thresholds, states, or product decisions.

## Step 3 — Write the stages

One subsection per stage that the journey actually visits; delete the stages that do not apply (DR-084) and say which are absent. Each stage row or subsection carries:

- **Surface** — repository, route, `SCRN-###` when one exists. A stage with no registered screen names an inventory gap.
- **Action and decision** — what the user does and what they must believe to do it.
- **Establishes** — facts the journey now owes the user later: kit name, quoted price, plan tier, active org. Use the E2E ledger key names where the catalog defines them, so the context audit consumes this page without translation.
- **Requires** — earlier facts this surface must display for the step to be completable from what is on screen. A `requires` fact with no visible home is a finding; record it in `Seams` and reference the matching `CTX-` finding in `docs/journey-context-findings.md` when one exists.
- **Exit** — the next surface, and whether the loop returns changed.

The return loop rule from the screen standard applies at journey scale: every control that leaves the journey's path must state whether the user comes back and what changed.

## Step 4 — Write the seams against the ledger

Reference `SEAM-###` IDs from the registry; do not restate them. Add a seam here only when tracing found a crossing the registry missed, and open a question asking `build-journey-map` to register it. The page's `Seams` section concentrates on the journey-specific consequence: what the loss at this crossing costs *this* actor at *this* moment of commitment.

## Step 5 — Job stories and intent, labeled

The journey carries one primary job story and any number of secondary ones (DR-106), in the standard's exact form, each `sourced` (named artifact: E2E `intent` fields, personas, funnel docs) or `inferred`. Every `inferred` story gets an open question. Never present inference as fact; downstream design QA will treat the page as truth.

## Step 6 — End-to-end examples

Two or three complete runs in Given/When/Then with realistic seeded data — use the E2E fixtures' demo organizations, never real customer data (DR-114). One normal path, one boundary (a blocked second claim, a budget exhausted), one failure or abandonment. Name the E2E lane that proves each, or write `Test: none — <reason>` (DR-117).

## Step 7 — Evidence links

The page is the anchor downstream evaluation reads. Link, do not copy:

- E2E lane IDs and their receipt location (`tmp/e2e-journey-evidence/`, disposable — link the catalog, not the run output).
- Screen pages and their `docs/screenshots/SCRN-###/` captures for the stages that have them.
- `CTX-` findings in `docs/journey-context-findings.md` that name this journey's steps.
- Marketing-side content the user was shown, by file path.

## Step 8 — Write the page

Use `references/journey-page-template.md`. It carries the front matter, the DR-083 section order with the cross-repo extensions, and an authoring note per section. Write durable content first — goal, actor, job stories, stages, seams, rules — and visual notes last.

File: `docs/journeys/JRNY-###-<slug>.md`, following the standard's directory layout where it exists.

## Step 9 — Validate

1. The ID exists in the registry, the row now reads `documented`, and the file path matches the row.
2. Every standard section (§9) exists, in order; empty sections read `None.` with a reason.
3. Every stage names its repository and route; every `SCRN-###`, `ROLE-##`, `AUD-##`, `SEAM-###`, `CTX-`, and `JOB-####` referenced exists.
4. Every `establishes`/`requires` key either matches an E2E ledger key or is proposed and marked as such.
5. Every quoted string matches source exactly; every threshold matches the code.
6. Every `inferred` story carries its label and an open question.
7. Each example names a test or gives the reason it has none; no example uses placeholder data.
8. The page contradicts no upstream document; any contradiction found is reported as a finding against that document, not silently corrected.
9. Run whatever documentation or link checks the repository provides.

Report the file path, validation result, registry row updated, seams referenced, ledger keys proposed, and the gaps a human must confirm.

## Correcting an existing page

1. Keep researched facts that still hold; re-verify routes, params, and quoted strings first — these rot fastest.
2. Add stages, seams, and ledger keys the journey grew; move removed ones to the changelog, not the bin.
3. If the goal changed, the registry owns that decision: open a question rather than rewriting the journey's identity.
