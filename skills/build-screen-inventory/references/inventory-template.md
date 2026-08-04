# Inventory templates

Two files: one index, and one per inventory.

```
docs/screen-inventory.md
docs/inventories/<product>-<layer>-screens.md
```

Slug the inventory files after the audience, not the code: `hiring-operation-screens.md`, `hiring-configuration-screens.md`, `sales-operation-screens.md`, `public-careers-screens.md`, `instance-administration-screens.md`, `shared-account-screens.md`.

---

# Index — `docs/screen-inventory.md`

```yaml
---
id: INV-000
title: Screen inventory
type: inventory-index
status: draft
owner: <team>
last_reviewed: <date>
review_interval_days: 90
verified_against: <version or commit>
inventories: [INV-001, INV-002, ...]
---
```

## 1. How this is partitioned

One paragraph: the product has these audiences, and they cannot see each other's screens. State the rule you applied.

## 2. Axes

| Axis | Values | Proof | Boundary |
|---|---|---|---|
| Authentication | public / authenticated | `AUD-##`, or the middleware or mount point | hard |
| Tenant type | The values | `AUD-##`, or the constant and the switch that reads it | hard |
| Role family | The families | `#role-registry` families, or the role constants grouped | hard / firm |
| Layer | operation / configuration / instance / shared | The route families and their cadence | firm |

Every proof cell names a predicate ID, file, constant, or component. A directory name is not proof.

State the permission model this partition came from and the version read:

> Derived from `docs/permissions/permission-model.md` @ `<verified_against>`.

When no permission model exists, say so here and mark the partition unverified.

## 3. The inventories

| ID | Inventory | Audience | Access predicate | Screens | File |
|---|---|---|---|---|---|
| INV-001 | | Who reaches it, in product terms | The condition, evaluable by a reader | n | Link |

## 4. Shared surfaces

Screens reachable from more than one inventory, listed once here and cross-referenced. Say which inventory owns each one.

## 5. Seams

Where one route serves two inventories, or a user crosses from one to another.

| Route or crossing | Inventories | Mechanism | Notes |
|---|---|---|---|

Record every switch component that maps one route onto several products. This table is what stops the next reader assuming a duplicate row is a mistake.

## 6. Coverage

| Measure | Count |
|---|---|
| Routes registered | |
| Screens inventoried | |
| Shared | |
| Excluded (with reason) | |
| **Unassigned** | |

List every unassigned route. Zero is the goal; an honest number is the requirement.

Record the command that regenerates the route list, so the next review is a diff.

## 7. Ambiguous boundaries

| Screen or group | Reading A | Reading B | Placed in | Owner |
|---|---|---|---|---|

## 8. Excluded

What is deliberately out of scope — API endpoints, redirect-only routes, dev tools, error pages — and why.

## Changelog

| Date | Version | Change | Author |
|---|---|---|---|

---

# Inventory — `docs/inventories/<slug>-screens.md`

```yaml
---
id: INV-001
title: Hiring — operation screens
type: inventory
status: draft
owner: <team>
last_reviewed: <date>
review_interval_days: 90
verified_against: <version or commit>
predicate: AUD-02
authentication: required
roles: [ROLE-01, ROLE-02, ROLE-03, ROLE-04]
layer: operation
parent: INV-000
derived_from: docs/permissions/permission-model.md@<its verified_against>
---
```

`derived_from` pins the permission-model version this inventory was cut from. When the two drift, the mismatch is visible instead of silent.

## 1. Audience

Who these screens are for, what they come to do, and how often. Two or three sentences.

## 2. Access predicate

The `AUD-##` from the permission model, plus its expression, so this file is readable alone:

> **AUD-02** — Signed in, tenant account type is `hiring`, and the user holds at least one of ROLE-01, ROLE-02, ROLE-03, ROLE-04.

Then the exceptions: screens inside this inventory with a narrower predicate, each naming the capability that narrows it.

Do not restate the permission model here. Reference it.

## 3. Entry points

How someone arrives in this inventory at all — the landing route after sign-in, the navigation entry, any redirect that lands here.

## 4. Screens

| ID | Screen | Route | Reached by | Status | Purpose |
|---|---|---|---|---|---|
| SCRN-096 | Job list | `/opportunities/jobs` | all roles | documented | The open roles this user can act on |
| — | <name> | `/path` | role subset | undocumented | One line |

Rules for this table:

- One line of purpose. Depth belongs in the screen page.
- `Reached by` names the role subset when it is narrower than the inventory predicate; otherwise write `all`.
- `Status` is `documented` (a screen page exists), `undocumented`, or `unverified` (registered but no confirmed navigation path).
- Never invent a `SCRN-` ID. Write `—` for an undocumented screen; the sibling `document-screen-behavior` skill assigns the ID when the page is written.
- Where a route also serves another inventory, note it and link the seam.

Group rows under sub-headings when the inventory is long — by area, by object, or by journey stage. Keep the order stable across reviews so a diff is readable.

## 5. Journeys

The journeys these screens serve, and roughly which screens belong to each. Link `JRNY-` IDs where they exist; propose names where they do not, marked provisional.

## 6. Seams

| To inventory | Where | What carries across |
|---|---|---|

Where a user leaves this inventory or arrives from another, and what state travels with them. Include shared surfaces reached from here.

## 7. Coverage

Screens in this inventory, how many are documented, and what is unverified.

## Open questions

`OQ-###` — the question, the owner, the date. One for every ambiguous placement and every unverified route.

## Changelog

| Date | Version | Change | Author |
|---|---|---|---|
