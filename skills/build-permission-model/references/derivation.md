# Tracing the chain

The permission model is a chain of lookups. Find every hop before drawing any conclusion, because each hop can silently drop a role.

## Common chain shapes

Most products use one of these. Identify which before searching.

**Direct guard.** The route names the role.

```
route → role
```

Simplest and rarest. The matrix is nearly free; the risk is that role checks drift apart across routes because nothing centralizes them.

**Capability indirection.** The route names a capability; a table maps roles to capabilities.

```
role → capability → route guard
```

The common shape. The matrix is the role-to-capability table. Watch for capabilities used in a guard but absent from the table.

**Resource indirection.** A capability opens resources; surfaces are selected by the resources they use.

```
role → capability → resource → component → surface
```

Common in framework-driven admin products where navigation is generated. Both a guard chain and a visibility chain usually exist, and they can disagree. Trace both.

**Policy objects.** A function decides per request, often reading the record.

```
role + record state → policy → allow/deny
```

Here the matrix cannot be fully static. Record the static part and describe the dynamic conditions as rule IDs in the cells.

Products mix these. A product with capability indirection for most screens often has three routes with a hardcoded role check.

## Finding each hop

**Roles.** Search for a constants file, an enum, or a database column. Names: `roles`, `role-constants`, `access-roles`, `user-types`. Cross-check against the database: a role present in data but absent from the constants is a finding, and vice versa.

**Capabilities.** Search for the roles constant and see what it is used to build. The role-to-capability map is usually one object literal keyed by role. Names: `activities`, `permissions`, `abilities`, `grants`, `scopes`.

**Resources.** Look for a map keyed by capability whose values are resource names. Names: `entities`, `objects`, `models`, `subjects`.

**Guards.** Search for the middleware wrapper by name — `allow`, `can`, `require`, `authorize`, `protect` — and list every call site. Then separate page routes from API routes: page routes render a document or a shell; API routes return data.

**Navigation.** Search for where the menu is built. It usually filters the same component list the guard chain uses, but on different criteria. This is where a tenant-type or plan check often hides.

## Distinguishing page routes from API routes

Page access is the scope. Separate the two by handler, not by path.

- A page route renders HTML, a template, or a client-app shell.
- An API route returns JSON or a data payload.

Path prefixes such as `/api` help but are not reliable: some products serve pages under an API prefix, and some serve data from a page-shaped path. Read the handler.

When one path serves both — a GET renders the page and a POST mutates — document the GET only, and say so.

## Reading a guard correctly

Three details change the answer and are easy to miss:

**The bypass.** Many guards short-circuit for a superuser. Check what value it compares against. A bypass on a literal string that appears nowhere else in the source is either dead or a hole, and you cannot tell which without checking the data.

**The direction of failure.** Does an unknown capability deny, or permit? A guard that permits when it cannot resolve the capability turns every typo into an open door.

**Composition.** A route may carry several middlewares, of which only one is the access check. Others may enforce entitlement, tenancy, or rate limits. Record only the access check in the guard map, and note the others if they can also block.

## When guard and navigation disagree

Common, and always worth recording. Three cases:

- **Nav hides, guard permits.** The screen is reachable by deep link. It belongs in the model, marked unlinked.
- **Nav shows, guard denies.** A user sees a link that fails. A live defect.
- **Different criteria.** The guard checks a capability while the nav checks tenant type. Both are real conditions; the audience predicate must carry both.

The guard is authoritative for reachability. The nav is evidence of intent. When they differ, the difference is the finding.

## Verifying against data

The constants describe what the code expects. The database holds what exists. Check both when you can:

- Which role values actually appear on user records?
- Does any user hold a role the constants do not define?
- Does any defined role have no users?

A role with no users may be dead, or may be the vendor's own. Do not guess — note it and ask.

If the database is not reachable, say so and mark the model as source-derived only. That is an honest limit, not a failure.

## Confidence

Mark each row of the matrix:

- **verified** — traced end to end, and the guard confirms it.
- **derived** — follows from the chain, but no guard exercises it.
- **assumed** — a hop was missing and you inferred it. Every assumed row needs an open question.

A matrix without confidence marks reads as fully verified. Very few are.
