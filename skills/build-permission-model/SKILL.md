---
name: build-permission-model
description: Derive and document a product's permission model — the roles, the capabilities each holds, the guard on every page route, and the audience predicates that follow. Produces docs/permissions/permission-model.md, the source of truth that build-screen-inventory and document-screen-behavior both read. Use when the user says "who can access what", "document the permission model", "build a role matrix", "map the roles", "audit permissions", or asks which roles reach a page. Run this before inventorying or documenting screens.
argument-hint: "[role, area, or route to scope the derivation]"
disable-model-invocation: true
metadata:
  version: "1"
---

# Build Permission Model

Trace how the product decides who may see what, and write it down once so nothing has to re-derive it.

Permission logic is almost never in one place. It is a chain — a role grants capabilities, capabilities open resources, resources map to surfaces, and a guard on each route checks one link of that chain. Each hop lives in a different file. Reading any single hop tells you almost nothing.

This skill follows the chain end to end, writes the matrix the rest of the documentation depends on, and reports what it found broken along the way. It nearly always finds something: the chain is long, no one reads all of it at once, and the gaps are invisible from any single hop.

**Scope: page access only.** Guards on API endpoints are out of scope unless the user asks for them. Document what decides whether a person can open a screen.

## The output contract

This skill owns one file. Two sibling skills read it, so its shape is a contract, not a preference.

```
docs/permissions/permission-model.md
```

It must carry these sections with these exact anchors:

| Anchor | Holds | Read by |
|---|---|---|
| `#derivation-chain` | Each hop, with the file that proves it | humans, re-verification |
| `#role-registry` | `ROLE-##` per role, with its native constant | both sibling skills |
| `#capability-matrix` | roles × capabilities, `yes` / `no` / rule ID | `document-screen-behavior` |
| `#route-guards` | page route → capability → roles that hold it | `build-screen-inventory` |
| `#audience-predicates` | `AUD-##` reusable access predicates | `build-screen-inventory` |
| `#findings` | Defects and inconsistencies in the model | humans |

`references/permission-model-template.md` carries the full shape. Do not rename the anchors — the sibling skills locate sections by them.

## Step 1 — Find the vocabulary

Products name these things differently. Establish the native terms before writing anything, and keep using them alongside the generic ones.

- **Role** — what a user is granted. Look for a roles constants file, an enum, or a database column.
- **Capability** — what a role may do. Native names include activity, permission, scope, grant, ability, action.
- **Resource** — what a capability applies to. Native names include entity, object, model, subject.
- **Guard** — the check on the route. Native names include allow, can, require, authorize, middleware.

Record the native term for each in the derivation chain. A reader who greps for your generic word and finds nothing will assume the document is wrong.

## Step 2 — Trace the chain

Follow every hop from role to rendered screen. `references/derivation.md` carries the search strategy, the common chain shapes, and what each hop looks like in code.

For each hop, record the file that defines it. **A hop you cannot find is a finding, not an assumption.** Write what you expected, where you looked, and open a question.

Two chains usually run in parallel and must both be traced:

- **The guard chain** — what actually blocks the request. This is authoritative.
- **The visibility chain** — what builds the navigation. This is not authoritative.

When they disagree, the guard wins and the disagreement is a finding. A screen the nav hides but the guard permits is reachable by deep link, and it belongs in the model.

## Step 3 — Build the matrix

One row per role, one column per capability, each cell `yes`, `no`, or a rule ID when the grant is conditional.

Assign `ROLE-##` and `CAP-##` IDs. Record the native constant beside each. IDs are permanent — when a role is renamed, the ID stays.

Group roles into families where the product does, and say what defines the family. Note where roles nest: when one role's capabilities are a superset of another's, that is nesting, and it belongs in one family rather than two.

## Step 4 — Map the route guards

One row per **page** route: the route, the capability its guard requires, and the roles that hold that capability.

Derive the role column from the matrix rather than reading it off the guard — that is what catches a guard requiring a capability no role holds.

Mark any route with no guard. An unguarded page route reachable while signed in is either deliberate or a hole, and the difference is worth a sentence.

## Step 5 — Write the audience predicates

This is the section the inventory skill consumes, so it earns its own step.

An audience predicate is a reusable, evaluable condition describing one coherent audience:

```
AUD-03  Signed in, account type is `sales`, holds SALES_MANAGER or SALES_ORG_ADMIN.
```

Build them by collapsing the route-guard table: routes whose role sets are identical belong to one predicate. Aim for the smallest set that covers every page route.

Each predicate records the roles it admits, the route count it covers, and any state beyond roles that it depends on — tenant type, plan tier, onboarding stage.

## Step 6 — Report the findings

Audit as you go. These recur across products, and each is worth a row:

- A capability held by no role.
- A capability that gates a route but maps to no resource, or the reverse.
- A role declared with no capabilities.
- A guard requiring a capability no role holds — a dead screen.
- Nested roles where the senior role reaches less than the junior one.
- A bypass on a literal string or a hardcoded identifier.
- Guard and navigation disagreeing about a route.
- A page route with no guard.

State the consequence in one line and whether it is live or latent. Do not fix anything. This document reports; the team decides.

## Step 7 — Validate

1. Every hop in the chain names a real file.
2. Every role in the registry appears in the matrix, and the reverse.
3. Every page route appears in the guard map, or is listed as excluded with a reason.
4. Every predicate is evaluable by a reader who has not seen the code.
5. Every predicate's role set matches the matrix.
6. Every finding names its file and line.
7. `verified_against` records the commit or version you read.

Report the counts — roles, capabilities, guarded routes, unguarded routes, predicates, findings — and the findings themselves, most severe first.

## Keeping it current

Record the commands that regenerate each hop's raw input, so the next run is a diff. This file rots on a different clock than the screens do: it changes when someone adds a role, which is rare, and silently.
