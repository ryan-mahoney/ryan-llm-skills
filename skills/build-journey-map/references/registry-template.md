# Journey registry template

One registry per product. It lives in the repository whose documentation standard governs the corpus — for FirstWho, `app/docs/journey-registry.md`. The registry is an index, not a specification: rows stay thin, and depth belongs in the `JRNY-###` pages written by `document-journey`.

Follow the repository prose standard (FirstWho: `docs/rules/feature-documentation-rules.md` §14): active voice, `must/can/will`, no `should`, condition before command, `None.` for empty sections, stable anchors on every level-2 heading, ISO dates.

---

## Front matter

```yaml
---
id: JREG-001
title: Journey registry
type: journey-registry
status: draft
owner: <team that arbitrates journey boundaries>
last_reviewed: <ISO date>
review_interval_days: 90
verified_against:
  - app@<commit or version this run read>
  - marketing@<commit or version this run read>
repos:
  - name: app
    path: /Users/ryanmahoney/Documents/firstwho/app
    role: product monolith — auth, commerce, hiring admin, public hiring and info pages
    hosts: [app.firstwho.co, "jobs.*", "info.*"]
  - name: marketing
    path: /Users/ryanmahoney/Documents/firstwho/marketing
    role: static marketing site — funnels, kit library rendering, CTAs
    hosts: [firstwho.co]
derived_from:                       # upstream documents read, pinned
  - docs/permissions/permission-model.md@<version>
  - docs/screen-inventory.md@<version>
  - app/test/e2e/fixtures/journey-catalog.js@<version>
journeys: [JRNY-001, JRNY-002]      # every registered ID, ascending
---
```

An empty list is valid. A missing key is not.

---

<a id="scope"></a>
## 1. Scope of this run

Which repositories, which audiences, and which audiences are deliberately out. One paragraph plus the exclusion table. Name what this run did **not** map, so a reader never mistakes absence for coverage.

<a id="boundaries"></a>
## 2. Repositories and boundaries

One row per repository from Step 0: role, hosts, what it owns, instruction file. Then state, in one sentence each, the two facts that make journeys cross here: the handoff URLs users follow, and the hostname rewrites or content fetches that connect systems without sharing code.

<a id="journeys"></a>
## 3. Journey table

One row per journey. Keep to six columns (standard DR-125).

| ID | Goal (actor's words) | Actor | Trigger | Terminal outcome | Status |
|---|---|---|---|---|---|
| JRNY-001 | Purchase a standalone JobKit | anonymous prospect | Lands on a kit page from search or campaign | Owned kit in library, payment settled | documented |

Then one companion table — reach and evidence — keyed by the same IDs:

| ID | Repos touched | Entry point (repo:route) | E2E lane | Document |
|---|---|---|---|---|
| JRNY-001 | marketing → app → stripe | marketing:`/jobkits/[theme]/[shortcode]` | GP-1 | journeys/JRNY-001-purchase-a-standalone-jobkit.md |

Status values: `registered` · `documented` · `retired`.

<a id="seams"></a>
## 4. Seam ledger

The shared truth `document-journey` references. One row per seam, permanent `SEAM-###` IDs.

| ID | Journey | Type | Crossing | Carries | Lost at the crossing | Evidence |
|---|---|---|---|---|---|---|
| SEAM-004 | JRNY-001 | handoff | marketing `/jobkits/...` → app `/register` | shortcode, attribution params (`crmSlug`, `jobId`) | in-page context; the kit name is not restated after sign-up | `app/constants/pricing.js`, `registerApi` |

Types: `handoff` · `identity` · `content-sync` · `host-rewrite` · `third-party`.

The `Lost` column is the point of the section. A seam that carries everything is not worth recording. Write `Nothing observed.` only after checking.

<a id="e2e-mapping"></a>
## 5. E2E lane mapping

Every automation journey in `app/test/e2e/fixtures/journey-catalog.js` mapped to one registry row, or exempted with a reason.

| E2E ID | E2E title | JRNY | Note |
|---|---|---|---|
| GP-1 | Anonymous user purchases a standalone JobKit | JRNY-001 | |
| RB-001 | Role boundaries probe | — | internal-lane: not one actor's one goal |

<a id="coverage"></a>
## 6. Coverage

| Measure | Count |
|---|---|
| Seeds collected | N |
| Journeys registered | N |
| Seams recorded | N |
| E2E lanes mapped / exempt | N / N |
| Outbound marketing CTAs owned | N |
| Outbound marketing CTAs unowned | N — listed below |
| Journeys documented (page exists) | N of total |

List every unowned CTA with its source file. These are the registry's open front, not noise.

<a id="ambiguous"></a>
## 7. Ambiguous boundaries

| Journey or seam | Reading A | Reading B | Placed as | Owner to rule |
|---|---|---|---|---|

Every merge or split where a reasonable person would decide otherwise. Include the evidence both sides.

<a id="findings"></a>
## 8. Findings from this run

| # | Finding | Consequence |
|---|---|---|

Contradictions against the permission model or the inventories, journeys that end in email silence, CTAs that land on unregistered routes.

<a id="handoff"></a>
## 9. Handoff order

The work queue for `document-journey`, ordered: journeys with E2E evidence first, then buying and application journeys, then internal work journeys. One line per row saying which evidence already exists.

## Open questions

`OQ-###` — the question, the owner, the date opened. One entry for every `inferred` seed kept, every ambiguous boundary, every unowned CTA class.

## Changelog

| Date | Version | Change | Author |
|---|---|---|---|
