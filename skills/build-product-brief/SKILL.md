---
name: build-product-brief
description: Write a neutral product brief from the repository's own documents — a Basis statement, a FEAT-### table of shipped behavior, a jobs-coverage matrix, a Planned section and environment limits — in which every claim cites a SCRN-###, JRNY-### or FEAT-### ID. Use when the user says "write a product brief", "brief the partners", "what can this product do", or before a QA or review round, so a description cannot outrun the evidence behind it. Precedes validating the brief with validate-brief.mjs.
argument-hint: "[repository path (optional)]"
disable-model-invocation: true
metadata:
  version: "1"
---

# Build Product Brief

Write `docs/product-brief.md`: a description of what the product does today, in which
every claim names the screen, journey or feature ID that supports it.

A brief is read by people who did not build the product and who will act on it. The
only defense against a brief outrunning its evidence is mechanical: every claim
carries an ID, and `scripts/validate-brief.mjs` fails on an ID that resolves to
nothing. Prose confidence is not evidence.

## Inputs

Read in this order and record the state of each in the Basis section:

| Input | Path | If absent |
|---|---|---|
| Feature list | `docs/feature-list.md` | run the `feature-list` skill first |
| Screen inventory | `docs/screen-inventory.md` and `docs/inventories/*.md` | run `build-screen-inventory` first |
| Journey registry | `docs/journey-registry.md` and `docs/journeys/JRNY-###-*.md` | run `build-journey-map` first |
| Job sources | committed job stories (`docs/requirements/*.md`), a manual test plan (`docs/manual-test-plan.md`), the information-architecture document (`docs/information-architecture.md`) | name the missing input in the Basis and say which coverage questions it leaves open |

An uncommitted file may guide the job list while you read it; the brief never cites
one, and never cites a local, uncommitted spec or run path.

## Output

`docs/product-brief.md`, written from
[`references/brief-template.md`](references/brief-template.md). Keep the section
order and the table columns the template defines; the validator and the summary
deck both read the FEAT table's shape.

## Section 1 — What it is and who uses it

Two short paragraphs. Name what the product does and who uses it, in product
terms. Describe shipped behavior only. A capability that exists only in a branch, a
spec or an uncommitted file belongs in section 4, not here.

## Section 2 — What you can do

One table, one `FEAT-###` row per capability a user or operator can exercise:

| ID | Feature | Description | Actor | Screens | Journeys |
|---|---|---|---|---|---|

- `Feature` is a verb phrase. `Description` is one sentence.
- `Screens` holds `SCRN-###` IDs and `Journeys` holds `JRNY-###` IDs, or
  `none` where no journey is registered. Every row cites at least one ID.
- **Issue `FEAT-001` upward.** Search the whole corpus for the number first and
  confirm it is unused. An issued ID is permanent: it never changes, is never
  reused, and is never renumbered when a feature is retired. It is the key the
  summary deck's coverage matrix joins on, so a reissued number silently rewrites
  history.

## Section 3 — Jobs coverage

Rows are jobs from outside the code: a job story, a task named in a specification
the product implements, a task in the manual test plan. The matrix says what
supports each job today.

| Job | Source | Supporting screens | Supporting journeys | Status |
|---|---|---|---|---|

`Status` is `served`, `partial`, `planned` or `none`.

Then two explicit gap lists, each a finding in its own right:

- **Jobs with no screen** — the job is real and nothing in the product serves it.
- **Screens with no job** — a surface exists that no job story accounts for.

A brief that leaves either list implicit reads as full coverage. Write both.

## Section 4 — Planned

Keep planned work separate from shipped behavior. Each item cites the
information-architecture status or another committed document that describes it,
and carries no `SCRN-###` or `JRNY-###` ID: nothing in the corpus can support a
claim about work that has not shipped. An item described only in an uncommitted
file is not planned work; it is an assumption, and it does not go in the brief.

## Section 5 — Environment limits

Name the integrations that are stubbed, simulated or absent in the environment a
reader would run, and anything else that changes what the reader will observe.
This section is why a reader can trust sections 1 to 3.

## Writing rules

From `rules/functionalist-design.md` section 5:

- Plain, active, front-loaded prose. Omit needless words.
- No comparison with other products.
- No evaluative adjectives — not "easy", "comprehensive", "robust", "seamless".
  Describe the behavior; the reader judges it.
- Every claim names at least one ID.
- No uncommitted file and no local, uncommitted spec or run path is ever cited.

## Validate

Run the validator from the application repository root, before reporting the
brief as done:

```bash
node "$SKILL_DIR/scripts/validate-brief.mjs" docs/product-brief.md \
  --inventories docs/inventories \
  --registry docs/journey-registry.md \
  --routes <route-list-file>
```

`--routes` takes a file of route paths; raw `mix phx.routes` output is accepted.
Add it when the repository documents a route-list command; omit it otherwise. The
validator resolves every `SCRN-###`, `JRNY-###` and `FEAT-###` token, rejects a
local, uncommitted spec or run path, requires the Basis heading, and checks each
inventory row's routes against the route list.

Fix each failure at its source. An unknown token is corrected in the brief; a
route the router does not serve is corrected in the inventory, because the router
is the authority. Then sample claims against the code: open the cited route or
module behind ten of them and confirm the behavior exists. A citation that
resolves proves the reference is real, not that the claim is true.

## Reports

Report the path written, the input states, the ID range issued, both gap-list
counts, and the validator result. When the validator is unavailable, say so
instead of reporting the brief as validated.

## References

- `references/brief-template.md` — the section order, the FEAT table header and
  the jobs matrix header.
- `scripts/validate-brief.mjs` — ID resolution, the uncommitted-path ban, the
  Basis heading and the route check.
