# Permission model template

One file: `docs/permissions/permission-model.md`.

The anchors below are a contract. `build-screen-inventory` and `document-screen-behavior` locate sections by them. Do not rename them.

---

```yaml
---
id: PERM-000
title: Permission model
type: permission-model
status: draft
owner: <team>
last_reviewed: <date>
review_interval_days: 180
verified_against: <commit or version>
source: code            # code | code+data
roles: [ROLE-01, ROLE-02, ...]
capabilities: [CAP-01, ...]
predicates: [AUD-01, ...]
scope: page-routes
---
```

`source: code` means the model was derived from source only. Use `code+data` when role values were also checked against the database. `scope` records what was documented — `page-routes` unless the user asked for more.

---

<a id="summary"></a>
## Summary

Three or four sentences: the chain shape, how many roles and capabilities exist, whether guard and navigation agree, and the most serious finding. A reader who stops here should know whether to trust the model and whether anything is on fire.

<a id="vocabulary"></a>
## Vocabulary

| Generic term | This product's term | Defined in |
|---|---|---|
| Role | | |
| Capability | | |
| Resource | | |
| Guard | | |

<a id="derivation-chain"></a>
## Derivation chain

The hops, in order, each with the file that proves it.

```
role → capability → resource → component → route guard
```

| Hop | Maps | File | Regenerate with |
|---|---|---|---|
| 1 | role → capability | `path:line` | `<command>` |

State which chain is authoritative for reachability, and name any parallel visibility chain.

Record every hop you could not find, where you looked, and what you assumed instead.

<a id="role-registry"></a>
## Role registry

| ID | Role | Native constant | Family | Reaches | Notes |
|---|---|---|---|---|---|
| ROLE-01 | Organization admin | `ORG_ADMIN` | hiring | tenant | |

`Reaches` is the widest scope the role acts on: instance, tenant, team, or self.

Record nesting explicitly: when one role's capabilities are a superset of another's, say so here. Nested roles belong to one family.

<a id="capability-matrix"></a>
## Capability matrix

Roles down, capabilities across. Each cell `yes`, `no`, or a rule ID for a conditional grant.

| Capability | ROLE-01 | ROLE-02 | ROLE-03 |
|---|---|---|---|
| CAP-01 `MANAGE_JOB` | yes | yes | no |

Below the table, one line per capability giving its native constant, what it opens, and its confidence: **verified**, **derived**, or **assumed**.

Split into several tables by family when one table grows too wide to read. Keep the column order stable across reviews so a diff is legible.

<a id="route-guards"></a>
## Route guards

Page routes only.

| Route | Guard requires | Roles admitted | Nav shows to | Confidence |
|---|---|---|---|---|
| `/sales/orders` | CAP-12 | ROLE-06 | ROLE-06 | verified |

Derive `Roles admitted` from the matrix, not from the guard. Disagreement between that column and `Nav shows to` is a finding.

### Unguarded page routes

| Route | Reachable by | Deliberate? |
|---|---|---|

### Excluded

What was left out and why — API endpoints, redirects, health checks, error pages.

<a id="audience-predicates"></a>
## Audience predicates

The reusable access conditions. `build-screen-inventory` partitions on these.

| ID | Predicate | Roles | Also depends on | Routes covered |
|---|---|---|---|---|
| AUD-01 | Not signed in | — | — | n |
| AUD-02 | Signed in, account type `hiring`, any hiring role | ROLE-01..04 | account type | n |

Write each predicate so a reader can evaluate it without the code. `Also depends on` records non-role state the predicate needs: tenant type, plan tier, entitlement, onboarding stage.

Every page route must fall under at least one predicate. Report any that does not.

<a id="findings"></a>
## Findings

| # | Finding | Consequence | Live or latent | Evidence |
|---|---|---|---|---|

Most severe first. `Live` means it affects users now; `latent` means it needs another change to bite. Name the file and line for each. Report only — do not fix.

<a id="open-questions"></a>
## Open questions

`OQ-###` — the question, the owner, the date. One for every assumed row, missing hop, and role whose purpose is unclear.

<a id="changelog"></a>
## Changelog

| Date | Version | Change | Author |
|---|---|---|---|
