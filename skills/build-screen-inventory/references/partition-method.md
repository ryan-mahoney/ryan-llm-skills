# Finding the partition

The partition is a claim about who can reach what. Build it from access control, then check it against routes. Doing it the other way round produces an inventory organized by the codebase's history instead of the product's audiences.

## Where the axes live

Work down this list. Each rung is weaker than the one above it.

### 1. Authentication boundary — strongest

Find where the session gate sits: route bundles mounted without auth, middleware that redirects anonymous requests, controllers that render for a tenant slug rather than a session.

Public surfaces are always their own inventory. They usually have a different audience entirely — a customer, a candidate, a recipient of an email — and often a different vocabulary for the same records.

Watch for public routes carrying a tenant slug (`/:slug/...`). That pattern marks a tenant-branded public surface, which is a product in its own right even though it lives in the same deployment.

### 2. Tenant or product-line type — strongest

Look for a constant naming the tenant's kind: account type, workspace type, org type, plan family. Then find every branch on it:

- Controllers that dispatch to a different render per type.
- Proxy or switch components that map one route to one of several component trees.
- Navigation builders that emit a different menu per type.

A branch on tenant type is a hard partition. Users on one side never see the other side's screens, even when the route is identical.

### 3. Role families — strong

Collect the role constants. Group them by prefix and by which routes each opens. Most products have families that are obvious once listed: an operations family, an administration family, a vendor-side family, and sometimes a customer-side family.

Two signals that a role family is a real boundary:

- The role sets are disjoint in practice — no real user holds roles from both families.
- Each family has its own landing surface.

A role *priority order* (this role outranks that one) means those roles are in the same family with different reach, not different families. Nested reach is a column in one inventory, not a second inventory.

### 4. Layer — firm, and the one teams most often skip

Within a product line, separate what runs the work from what defines it.

| Layer | Test | Typical signals |
|---|---|---|
| Operation | Acts on records that flow through the product | Lists, pipelines, detail views, actions with side effects on work items |
| Configuration | Defines how the product behaves for the whole tenant | Settings trees, taxonomies, templates, reference data, CRUD over lookup tables |
| Instance administration | Acts on tenants themselves | Tenant lists, provisioning, API keys, vendor-only roles |
| Account and identity | Acts on the person or the subscription | Sign-in, profile, billing, connected apps |

The reliable marker for configuration is a dense run of near-identical list/detail/edit triples over reference data. When you find twenty routes that are all "manage a lookup table", you have found the configuration layer.

The reliable marker for instance administration is a role that no tenant user can hold.

### 5. Entitlement tier — soft

Free and paid branches on one route usually render variants of one screen for one audience. Record them as variants inside an inventory row. Promote them to their own inventory only when the free surface is a genuinely different product with its own journeys.

## The three tests

Run all three on every candidate boundary. Two passes make it real.

**Reachability.** Enumerate the states a single user can hold — roles, tenant type, entitlement, onboarding stage. Can any one of those states reach both sides? If no state reaches both, the boundary is real. This is the primary test; the other two are corroboration.

**Vocabulary.** Compare the user-facing name of the same underlying record on each side. A record that is a "candidate" on one side and a "contact" on the other is being used for two different jobs by two different audiences. Renaming is strong evidence of a product boundary, and it is visible in the interface copy rather than the schema.

**Cadence.** Ask how often the audience visits and why. Daily, to move work forward, is operation. Monthly, to change how the product behaves, is configuration. Once, at setup, is onboarding — which belongs with configuration unless it is large enough to stand alone.

## Traps

**A route prefix is not a product line.** Prefixes accumulate by build order. A `/sales/*` tree can be back-office commerce while the sales CRM sits on the same routes as the hiring CRM. Always check what the prefix's screens actually do and who reaches them.

**A directory name is not an audience.** Bundle and folder names record what the team called the work at the time. A bundle named for an internal product can serve the public site.

**One route can be two screens.** When a switch component chooses a component tree by tenant type, that route holds one screen per branch. Give each its own row in its own inventory, and record the switch as a seam in both. Treating it as one screen erases a whole product line.

**A shared screen is not two screens.** Profile, billing, and sign-in are reachable by every audience. They belong in one shared inventory, cross-referenced. Copying them into each product's inventory creates rows that drift apart.

**Nav visibility is not reachability.** A screen missing from the menu may still be reachable by deep link or by a redirect after an action. Check the route guard, not the navigation builder. If the guard permits it, it is in the inventory — note that it is unlinked.

**Dead routes exist.** A registered route with no navigation path and no guard may be abandoned. Do not silently drop it and do not assume it works. List it, mark it unverified, and open a question.

## Handling ambiguity

Some boundaries genuinely do not resolve from the code. A screen used both to configure and to operate, or a role family that one real user does hold across, is a product question.

Do not pick silently. Put the screen in the inventory that matches its dominant use, mark the row ambiguous, and record both readings in the index with the evidence for each. The person who can settle it will settle it in one sentence if you show them the choice; they cannot settle a decision you buried.

## Recording the derivation

The index must show the work, because the next person to run this will otherwise redo it. For each axis, record the constant, file, or component that proves it, and the command that regenerates the route list. An inventory whose reasoning is invisible gets rebuilt from scratch every time it goes stale.
