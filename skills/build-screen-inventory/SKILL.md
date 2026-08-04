---
name: build-screen-inventory
description: Build a screen inventory for a product with more than one audience — a layered app, a multi-tenant product, or a monorepo. Partitions screens into separate inventories by who can actually reach them, then writes an index plus one inventory per audience. Use when the user says "build a screen inventory", "list every page", "inventory the app", "map the screens", "what pages exist", or asks to separate an existing inventory by product line, role, or layer. Precedes documenting individual screens.
argument-hint: "[product line, area, or path to scope the inventory]"
disable-model-invocation: true
metadata:
  version: "1"
---

# Build Screen Inventory

Produce a map of every screen in the product, cut into inventories by **who can reach it**.

One flat list of screens is nearly useless in a product with several audiences. It mixes surfaces no single person will ever see, buries the distinction between running the product and configuring it, and hides the fact that one route can render two different products. The cut is the deliverable — the list is just what fills it.

The rule that governs everything here: **an inventory is a set of screens one coherent audience can reach while pursuing one product's journeys.** If two audiences can never see each other's screens, they get separate inventories, however entangled the code is.

## The trap this skill exists to avoid

Code layout is not audience layout. In a product with layered access, all three of these are normal and all three will mislead you:

- **A route prefix belongs to the wrong product.** A `/sales/*` tree can hold back-office commerce while the sales CRM lives on shared routes.
- **A directory name describes its history, not its audience.** A file called `hiring-routes` can serve the public candidate site.
- **One route renders two products.** A proxy component switching on tenant type puts a hiring job list and a sales funnel list on one path. That is two screens in two inventories, not one screen.

Partition by the access predicate. Verify against routes. Never the reverse.

## Step 0 — Read the permission model

```
docs/permissions/permission-model.md
```

When this file exists, it is the source of truth for who reaches what, and it saves the most expensive part of this job.

- Read `#audience-predicates`. **These are your partition axes.** Do not re-derive them.
- Read `#route-guards` for the per-route role sets you will put in each inventory row.
- Read `#role-registry` for the `ROLE-##` IDs to reference. Never invent one.
- Record its `verified_against` in each inventory's `derived_from`, so drift between the two is detectable.

When it does not exist, say so, then either run `build-permission-model` first — strongly preferred — or derive the axes yourself with Step 1 and note in the index that the partition is unverified against a permission model.

## Step 1 — Find the axes

Skip this step when Step 0 gave you predicates. Otherwise derive them, in this order, and stop when you run out of evidence. `references/partition-method.md` carries the full method, the evidence sources, and the tests.

| Axis | What to look for | Boundary strength |
|---|---|---|
| Authentication | Public routes, auth middleware, session gates | Hard — always separate |
| Tenant or product line | Account type, workspace type, plan family, tenant switch components | Hard — always separate |
| Role family | Role constants, grouped by prefix and by which routes they open | Hard when role sets are disjoint |
| Layer | Configuration vs. operation vs. instance administration | Firm — separate within a product line |
| Entitlement tier | Free/paid branches that render different screens on one route | Soft — a variant, usually not its own inventory |

Report the axes you found before writing anything. If they contradict what the user expected, say so with the evidence — the user's mental model is a hypothesis, and the code is the fact.

## Step 2 — Apply the three tests

For each candidate boundary, run all three. Two passes make it a real boundary.

- **Reachability.** Can this audience ever navigate here, under any role or state they can hold? If never, the boundary is real.
- **Vocabulary.** Does the same underlying object carry a different user-facing name on each side — candidate versus contact, job versus funnel? A renamed object means a different product.
- **Cadence.** Is this used daily to do the work, or occasionally to define how the work behaves? Daily is operation; occasional-and-by-admins is configuration.

## Step 3 — Name the layers

Within a product line, split by layer. Use these names, and say what each covers:

- **Operation** — the daily work. Acts on records: lists, pipelines, detail pages, the actions that move work forward.
- **Configuration** — defines how the product behaves for everyone in the tenant. Settings, taxonomies, templates, reference data. Rarely visited, admin-gated, and changing it changes the operation surface.
- **Instance administration** — above the tenant. The vendor's own surfaces for managing tenants, keys, and provisioning.
- **Account and identity** — sign-in, profile, billing, connected apps. Reachable from every product line; belongs in one shared inventory, cross-referenced from the others.

Not every product has all four. Say which are absent.

## Step 4 — Assign every screen

One row per screen, in exactly one inventory — or in the shared inventory with a cross-reference. A screen that appears in two inventories without explanation is a partition error.

Where one route renders different screens per audience, write one row per screen, each in its own inventory, and record the switch as a seam. Note the shared route in both rows so nobody assumes a duplicate.

## Step 5 — Reconcile

The inventory is only trustworthy if it is complete. Count.

1. Extract every route the application registers.
2. Confirm each one appears in exactly one inventory, or is listed as shared, or is listed as excluded with a reason (API endpoints, redirects, dev-only routes).
3. Report the totals: routes registered, screens inventoried, shared, excluded, unassigned.
4. **Unassigned routes are a finding, not a rounding error.** List them.

Also reconcile the other direction: any existing screen documents that no inventory claims, and any inventory row with no route.

## Step 6 — Write the files

```
docs/screen-inventory.md                          <- index: axes, partition map, traps, coverage
docs/inventories/<product>-<layer>-screens.md     <- one per inventory
```

Use `references/inventory-template.md` for both. The index carries the reasoning; each inventory carries its audience, access predicate, entry points, screen table, journeys, and seams.

Keep every inventory row thin — identifier, name, route, access, status, and a one-line purpose. The inventory says what exists and who reaches it. Depth belongs in the screen page, written by the sibling `document-screen-behavior` skill.

State each inventory's access predicate by its `AUD-##` ID and its expression together, so the file is readable alone and traceable back to the permission model.

## Step 6a — Hand off

`document-screen-behavior` reads what you write. Give it what it needs:

- Every row marked `undocumented` is that skill's work queue. Keep the list ordered so someone can work down it.
- Never invent a `SCRN-` ID for an undocumented screen — write `—`. That skill assigns the ID.
- Each inventory's `AUD-##` becomes the screen page's access predicate. Do not restate the permission model in the inventory; reference it.

## Step 7 — Validate

1. Every axis you claim is backed by an `AUD-##` predicate, or by a named constant, middleware, or component — never by a directory name.
2. Every inventory states its access predicate in terms a reader can evaluate, with its `AUD-##` ID where one exists.
3. Every route reconciles: assigned, shared, or excluded with a reason.
4. Every shared screen appears once and is cross-referenced, never duplicated.
5. Every one-route-two-screens case is recorded as a seam in both inventories.
6. Screen IDs match the existing corpus; new screens are marked as undocumented rather than given invented IDs.
7. The index names any boundary you were unsure about, with the evidence on both sides.

Report the partition, the coverage totals, the unassigned routes, and the boundaries that need a human ruling.

## Keeping it current

The inventory rots faster than the screen pages, because a new route lands in it before anyone writes the page. Record in the index how to regenerate the route list, so the next run is a diff rather than a rebuild.
