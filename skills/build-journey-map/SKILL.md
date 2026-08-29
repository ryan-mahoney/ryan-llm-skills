---
name: build-journey-map
description: Identify the distinct user journeys of a product whose surfaces live in more than one repository — for example a marketing site, an application monolith, and public microsites — and publish a journey registry with permanent JRNY-### IDs, actors, triggers, outcomes, and cross-repo seams. Use when the user says "identify the user journeys", "map the journeys", "build a journey registry", "what journeys span these repos", or before documenting individual journeys. Precedes document-journey. The registry is the basis for journey evaluation and design QA.
metadata:
  version: "1"
---

# Build Journey Map

Produce a journey registry: every distinct journey a user completes across a set of related repositories, with a permanent ID, one actor, one goal, and the seams where the journey crosses a repository boundary.

The failure this skill exists to prevent is the per-repository journey list. Marketing teams map the funnel that ends at "clicked Sign up." Product teams map journeys that begin at a signed-in dashboard. Both lists are locally true and jointly wrong: the prospect who buys a kit crosses `firstwho.co`, `app.firstwho.co`, and Stripe on the way to the library, and no single repository documents that journey end to end. A journey that cannot be completed inside one repository is exactly the unit this registry records.

**A journey is one actor's one goal, from trigger to terminal outcome, however many repositories it crosses.** A repository is a deploy boundary, not a journey boundary.

## Step 0 — Declare the repository set

Before discovery, write down the system this registry covers. For each repository record:

| Field | Example (FirstWho) |
|---|---|
| Path | `/Users/ryanmahoney/Documents/firstwho/app` |
| Role | product monolith / marketing site / content source |
| Hostnames users see | `app.firstwho.co`, `jobs.*`, `info.*` |
| What it owns | routes and data / pre-rendered funnels and CTAs / kit content JSON |
| Instruction file | `AGENTS.md` |

Read each repository's `AGENTS.md` (or README) first. It names the route tables, the build-time content fetches, and the hostname rewrites — the places journeys hide.

Include a repository when a user's path touches it, even if the repository holds no app logic: the marketing site owns the first half of every buying journey; a content repository's JSON decides what the job-kit landing pages promise.

`references/discovery-method.md` carries the evidence-source table per repository archetype.

## Step 1 — Read what the upstream skills produced

These files answer questions discovery would otherwise re-derive. Read whichever exist, in every repository in scope:

```
docs/permissions/permission-model.md      <- who reaches what (ROLE-##, AUD-##)
docs/screen-inventory.md                  <- screen ownership (INV-###, SCRN-###)
docs/inventories/<slug>-screens.md        <- each inventory's journeys column
app/test/e2e/fixtures/journey-catalog.js  <- journeys already automated (GP-#, RB-###, …)
docs/journey-registry.md                  <- a previous run of this skill
```

The E2E journey catalog is a registry of journeys that already run end to end with step sequences and personas. **Mine it before inventing anything.** Each catalog entry is a sourced journey with its steps already researched.

Record what you read as `derived_from` entries pinned to their `verified_against` versions. When the permission model or an inventory contradicts the code, the code wins; report the contradiction as a finding against the upstream document.

When no permission model and no inventory exist, derive actors from auth guards and persona fixtures, and open a question recommending `build-permission-model` and `build-screen-inventory`.

## Step 2 — Collect journey seeds from every repository

A seed is evidence that some actor wants something and a surface exists to give it to them. Harvest, at minimum:

1. **Outbound links with intent.** Every absolute URL in navigation, headers, footers, pricing constants, and CTAs. In a marketing repository these are the funnel's end: `https://app.firstwho.co/register`, `/buy/kit/:shortcode`. Each one names a journey that continues in another repository.
2. **Public entry routes.** Registration, checkout, invitation acceptance, application forms, password and email verification — the app routes reachable without a session.
3. **Actor switches.** Pages one actor publishes and another consumes: a job the org posts that a candidate applies to; an invitation the admin sends that the invitee opens; a confirmation email whose link returns the buyer to the product.
4. **Existing automations.** The E2E catalog's `persona`, `startState`, `acquisition`, `expectedOutcome`, and step `intent` fields — each journey there is a complete seed with named steps.
5. **Funnel and product documents.** Launch plans, checklists, and QA plans in any repository's docs; they name journeys the code implies but nobody wrote down.
6. **Forms and their destinations.** Where a marketing-site form posts, and which back-office role opens the response.

Write each seed as: actor, desired outcome, repository and surface it starts in, repository and surface it ends in. `references/discovery-method.md` gives the full source table and the per-repository hunt commands.

Do not merge seeds yet. A seed that later turns out to be part of a bigger journey is never discarded — it becomes a stage.

## Step 3 — Merge and split into journeys

Apply these rules to the seed pile. Record every merge and every split with its reason; the registry's `Ambiguous boundaries` section carries the ones that a human should revisit.

- **Continue across a boundary → merge.** When the outcome a marketing page promises can only be reached on an app route, that is one journey, not two. The click from `/jobkits/…` to `/register` is a seam inside a journey, not a journey end.
- **Actor changes → split, then link.** A recruiter posting a job and a candidate applying to it are two journeys joined by a shared object (the job) and a handoff (the published URL). One actor's goal never spans another actor's intent. Record the handoff in both journeys.
- **Outcome differs → split.** "Buy one kit" and "subscribe to a plan" share checkout plumbing and end in different promises. Different terminal outcomes are different journeys even when they share every screen.
- **Same goal, different start state → variant, not twin.** A trial claim and a paid claim of the same kit are one journey with an alternate entry, unless the product treats them as different funnels (different CTAs, different landing pages). Follow the product's own distinction.
- **Name the journey by the actor's goal.** "Purchase a standalone JobKit", not "Kit checkout journey". Verb phrase, user's words (this matches the repository standard's DR-045 where one exists).

The audience predicates from the permission model keep actors honest: if two candidate journeys can never be pursued by one account, they are not one journey.

## Step 4 — Assign JRNY-### IDs

Follow the repository documentation standard when one exists (FirstWho: `docs/rules/feature-documentation-rules.md`, `JRNY-` prefix, three digits, IDs permanent, file name carries ID and slug). Otherwise use `JRNY-###`.

- Search the whole corpus — pages, registries, the E2E catalog, prior drafts — for IDs already in use. Assign the next unused number. Never copy an ID from a template example.
- An assigned ID never changes and never returns, even if the journey retires.
- Do not collide with the E2E catalog's IDs (`GP-#`, `RB-###`, `TN-###`, `LC-###`, `CP-###`). They are automation lanes; map each one *to* a `JRNY-###` in the registry instead.

## Step 5 — Record the cross-repo seams

The seam is where journeys break and where evaluation and design QA will later look hardest. For every point where a journey crosses a repository, a host, or a third party, record:

| Seam type | What it means | FirstWho examples |
|---|---|---|
| `handoff` | A link or redirect carries the user, and sometimes parameters, between repositories | marketing `/jobkits` → `app.firstwho.co/register`; `crmSlug` + `jobId` attribution carried into registration; Stripe return URLs |
| `identity` | Session or verification established on one side governs the other | email verification links, magic-link login, invitation acceptance |
| `content-sync` | Content authored or stored in one system renders in another, with a build or fetch in between | CMS pages and job-kit JSON fetched into the marketing build; the published job rendered on `jobs.*` |
| `host-rewrite` | One app serves several hostnames whose URLs do not match the registered route | `jobs.*` → `/hiring/…`, `info.*` → `/info/…` |
| `third-party` | A page the product neither renders nor controls | Stripe Checkout |

For each seam state: what carries across (params, session, ledger facts like kit name and quoted price), what does **not** carry (cart contents lost at login; the product name absent at payment — see the seeded finding in `docs/journey-context-findings.md`), and the evidence file that proves it.

## Step 6 — Reconcile, then count

The registry is only trustworthy if it is complete.

1. Every E2E catalog journey maps to exactly one `JRNY-###` row (or is marked `internal-lane` with a reason, e.g. a permissions probe that is not a user goal).
2. Every outbound CTA URL in the marketing repository lands on a stage of some journey, or is listed as `unowned` with its source file.
3. Every inventory that names journeys in its `Journeys` column has those journeys in the registry, provisionally at worst.
4. Report the totals: seeds collected, journeys registered, seams recorded, E2E lanes mapped, unowned CTAs, journeys with no document page yet.

Unowned CTAs and unmapped lanes are findings, not rounding errors. List them.

## Step 7 — Write the registry

Write `docs/journey-registry.md` in the product repository (the one whose corpus the documentation standard governs — for FirstWho, `app`). Use `references/registry-template.md`. It carries the front matter, the journey table, the seam ledger, and the coverage section.

Keep registry rows thin — ID, goal, actor, trigger, outcome, repositories, entry point, E2E lane, status, document path. Depth belongs in the journey page, written by the sibling `document-journey` skill.

Row status vocabulary: `registered` (in this file only) · `documented` (a `JRNY-###` page exists) · `retired`.

## Step 8 — Validate

1. Every row names one actor and one terminal outcome; no row describes a page or a feature.
2. Every journey that crosses a repository boundary lists its seams, and every seam names what crosses and what is lost.
3. Every `ROLE-##`, `AUD-##`, `SCRN-###`, `INV-###` referenced exists in the upstream documents, pinned by `derived_from`.
4. Every E2E catalog ID appears exactly once in the mapping table.
5. Every `JRNY-###` is unique in the whole corpus and follows the standard's digit width.
6. Coverage totals reconcile: seeds = merged + split components accounted for; CTAs = owned + unowned.
7. Inferred actors or goals are marked `inferred` and carry open questions; sourced ones cite their artifact.
8. The handoff section tells `document-journey` which rows to write first.

Report the repository set, the journey count by audience, the seams found, the unowned CTAs, the unmapped E2E lanes, and the boundaries that need a human ruling.

## Handoff to document-journey

- Every `registered` row is `document-journey`'s work queue. Order it: the journeys the E2E suite already runs first (evidence exists), then buying and application journeys (highest abandonment risk), then internal journeys.
- Never write a journey page for a row that does not exist; send new-journey requests back to this skill so the ID is issued once.
- The seam ledger is shared truth: the journey page references seam IDs, it does not restate them.

## Keeping it current

Re-running this skill on an existing registry is a diff, not a rebuild: keep every ID and its goal, add rows for new seeds, mark vanished journeys `retired`, and re-pin `verified_against` per repository. Record what changed in the changelog.
