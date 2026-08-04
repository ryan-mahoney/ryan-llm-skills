---
name: document-screen-behavior
description: Document one screen — a page, route, dialog, or surface — as a product specification that records its features, behavior rules, states, access model, inferred job stories, the journeys it belongs to, and captured screenshots of each state. Use when the user says "document this page", "document this screen", "write up the dashboard", "what does this surface do", or names a route and asks for documentation. Also use to correct or extend an existing screen page. Not for cross-screen capabilities (feature page) or end-to-end goals (journey page).
argument-hint: "<screen, route, or existing SCRN- page>"
metadata:
  version: "2"
---

# Document Screen Behavior

Write one screen page that answers four questions a reader cannot answer from the code in under an hour:

1. **What does this surface do, exactly?** Every feature, every state, and the rules that decide what appears.
2. **Who is it for?** Whether sign-in is required, which groups reach it, and what each group sees differently.
3. **Why does someone come here?** The job they arrived with, and the journey the visit belongs to.
4. **What does it actually look like?** Captured screenshots of each state, not prose about them.

The failure this skill exists to prevent is a document that describes the render and calls it a specification. A page that lists every control but never states which priority ranks first, who sees the page at all, or what the user came to accomplish has documented the machine and skipped the product.

## Scope check

This skill writes **screen** pages only.

- A request naming one surface and asking what it shows or permits → screen page. Continue.
- A request naming a user capability that survives a redesign and spans surfaces → feature page. Stop and say so.
- A request following a goal across screens until success or abandonment → journey page. Stop and say so.

Do not force a feature or journey request into a screen page. Name the correct type and offer to write it.

## Step 0 — Read what the upstream skills produced

Two files answer questions this skill would otherwise re-derive. Read whichever exist.

```
docs/permissions/permission-model.md      <- who reaches what
docs/screen-inventory.md                  <- which inventory owns this screen
docs/inventories/<slug>-screens.md
```

From the permission model: `#role-registry` for the `ROLE-##` IDs, `#capability-matrix` for what each role may do, `#route-guards` for this screen's guard, and `#audience-predicates` for the `AUD-##` that admits it. Section 2 of the page references these — it does not restate them.

From the inventory: which inventory owns the screen, its `AUD-##`, and whether a row already exists for it. **Take the `SCRN-###` ID from the inventory row if it has one; assign the next unused ID if the row reads `—`, and update the row.**

When neither exists, derive access yourself in Step 2 and open a question recommending `build-permission-model`. Say in the handoff that access is unverified. When both exist, record what you read:

```yaml
derived_from:
  - docs/permissions/permission-model.md@<its verified_against>
  - docs/inventories/<slug>-screens.md@<its verified_against>
```

If the code contradicts either file, the code wins. Report the contradiction as a finding against the upstream document — do not silently correct it here, or the two will disagree forever.

## Step 1 — Read the repository standard

1. Find the repository instruction files and any product-documentation standard (search for `documentation-rules`, `doc-standard`, `docs/rules/`).
2. Read the standard in full before any research or writing.
3. Use its directory layout, ID scheme, front-matter keys, status vocabulary, and prose rules.
4. If no standard exists, use the template in `references/screen-page-template.md` as written.

**The standard wins on conflict.** This skill's template extends the common 11-section screen order rather than replacing it — the standard's sections stay in their original relative order, and the additions sit between them. If a standard forbids an addition outright, follow the standard, write the section's content into `Open questions`, and propose the amendment in the handoff. Never diverge silently.

Search the corpus for the next unused `SCRN-###`. Never copy an ID from an example.

## Step 2 — Research before writing

Work from evidence. Every claim in the finished page must trace to source, test, or capture.

| Question | Where to look |
|---|---|
| Does it require sign-in, and who reaches it? | `docs/permissions/permission-model.md` first; otherwise route registration, auth middleware, permission and activity checks, role-to-scope mapping, redirect branches |
| What decides what appears? | Ordering constants, eligibility thresholds, display limits, scope resolvers, feature flags, entitlement checks |
| What are the exact strings? | Component source and copy modules — never paraphrase visible text |
| Which states exist? | Loading, empty, partial, and error branches in the component and its data context |
| What happens after each action? | Destination routes, and whether the user returns to a changed page |
| What do the tests assert? | Test files pinned in the front matter; they are the behavioral contract |

Record what you could not establish as an open question with a named owner. Do not invent registry IDs, thresholds, or product decisions.

## Step 3 — Cover behavior in detail

Vague capability lists are the most common defect in screen pages. "Review a ranked priority" describes nothing a reader can act on.

For every feature the screen hosts, record:

- **The outcome** the user reaches, as a verb phrase.
- **The gate** — the condition, permission, entitlement, or data state that makes it appear.
- **The decision values** — the ordering rule, eligibility threshold, and display limit, with their actual numbers and precedence.
- **The audience** — which groups get it, and how it differs for each.
- **The exit** — where each control goes, and whether the user returns to a changed screen.

The decision values matter most and get dropped most often. When a screen ranks, filters, or truncates anything, the reader must be able to predict what appears without reading the code. If the repository has a business-rule registry, extract these into `BR-` entries and reference them. If it does not, record them in `Behavior rules` and open a question about migrating them.

Cover every state in `references/screen-page-template.md` §9. Write `None.` with a reason when a state cannot occur. Never delete a state heading.

## Step 4 — Infer intent, and label it as inference

Deduce the job stories and per-role intent from the evidence. Read `references/intent-inference.md` for the method, the evidence sources ranked by strength, and the rules for the job-story form.

Two rules govern this step:

- **Mark every story `sourced` or `inferred`.** A sourced story traces to a written artifact — a spec, a ticket, an existing job-story document. An inferred story is your reading of the interface and its logic. Never present inference as fact.
- **Open a question for every inferred story**, addressed to the page owner, so a human confirms or corrects it.

The interface tells you more about intent than it looks like it does: empty-state copy states what belongs on the page, ranking logic states what the product believes is urgent, and first-run copy states what the user is trying to start.

## Step 5 — Place the screen in its journeys

A screen is a stop, not a destination. Record which journeys it belongs to, the stage it occupies, what state arrives with the user, and what departs with them.

Use the standard's stage frame when it has one; otherwise use `define → locate → prepare → confirm → execute → monitor → modify → conclude`.

Document the **return loop** explicitly. When a control sends the user to another screen, state whether they come back and what has changed when they do. An unclosed loop is the defect this section exists to catch. If the corpus has no journey registry, record candidate journeys with proposed names and mark them provisional.

## Step 6 — Capture the states

Screenshots are required, not optional. Read `references/screenshots.md` for the capture protocol, the authenticated-session setup, the naming scheme, and the honesty rules.

In short: capture each documented state with realistic seeded data, write PNGs to `docs/screenshots/SCRN-###/`, link each one inline in the state it shows, and record every capture in the `Visual evidence` manifest.

Three rules do not flex:

- **Never publish real customer data.** Use a seed or demo organization. Redact anything that survives.
- **Confirm you can see the image before describing it.** Use the sibling `see` skill to establish whether this host has vision. A model that cannot see an image will describe it anyway.
- **Write `Not captured.` and the reason** for any state you could not reach. Never describe an uncaptured state as though you saw it.

## Step 7 — Write the page

Use `references/screen-page-template.md`. It carries the section order, the required front matter, the table shapes, and an authoring note for each section.

Write the durable content first: access model, job stories, objects, behavior rules, states, and messages survive a redesign. Write layout and visual detail last and expect to rewrite them.

## Step 8 — Validate

1. The title names the surface as the interface names it.
2. The ID and directory match a screen page, and the ID matches the inventory row or is the next unused one.
3. Every section exists in order. Empty sections read `None.`, never blank.
4. Front-matter lists agree with the body.
5. Every quoted string matches the source exactly.
6. Every referenced ID, file, test, and screenshot path exists — including every `ROLE-##` and `AUD-##`, which must appear in the permission model.
7. The inventory row for this screen carries its `SCRN-###` and reads `documented`.
8. Every threshold, limit, and ordering rule in the page matches the code.
9. Every inferred story carries its label and an open question.
10. Each captured state links to a file that exists; each uncaptured state says why.
11. Run the linked tests and any documentation or link checks the repository provides.

Report the file path, validation result, capture coverage, unresolved registry gaps, any conflict with the repository standard, and any contradiction you found against the permission model or the inventory.

## Correcting an existing page

1. Keep researched facts that are still true.
2. Add the missing sections rather than rewriting correct ones.
3. Re-verify every threshold and quoted string against the current source — these rot first.
4. Move the file if the type was wrong; never leave two sources of truth.
5. Record the change and the reason in the changelog.
