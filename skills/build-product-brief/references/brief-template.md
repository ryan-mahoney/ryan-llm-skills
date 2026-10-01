# Product brief template

The skeleton `docs/product-brief.md` is written from. Keep the section order and
the table columns as they are: the validator and the summary deck read the FEAT
table's shape, and the Basis heading is required.

Delete every `<…>` placeholder. An empty table cell is a fact to resolve, not a
placeholder to leave. An empty list reads `None.` with the reason.

---

<a id="basis"></a>
## Basis

This brief describes the behavior the code and the committed documents had at
`<commit>`, as read on `<date>`. It reports what was read, not what was
verified. No one ran the product to produce it, and a claim here is a reading of
the code and the documents, not an observation of the running system.

Exploration results — whether a first-time operator could complete a task, where
they got stuck — are not in this file. They belong to the local QA decks, which
are written per run and stay out of version control.

Inputs read:

| Input | Path | State |
|---|---|---|
| Feature list | `docs/feature-list.md` | <state> |
| Screen inventory | `docs/screen-inventory.md`, `docs/inventories/*.md` | <state> |
| Journey registry | `docs/journey-registry.md`, `docs/journeys/` | <state> |
| Job sources | `docs/requirements/*.md`, `docs/manual-test-plan.md`, `docs/information-architecture.md` | <state> |

<a id="1-what-it-is-and-who-uses-it"></a>
## 1. What it is and who uses it

<Two short paragraphs. What the product does, then who uses it. Shipped behavior
only.>

<a id="2-what-you-can-do"></a>
## 2. What you can do

| ID | Feature | Description | Actor | Screens | Journeys |
|---|---|---|---|---|---|
| FEAT-001 | <verb phrase> | <one sentence> | <actor> | SCRN-001 | JRNY-001 |

Every row cites at least one `SCRN-###` and either `JRNY-###` IDs or `none`.
Issue `FEAT-###` upward, searching the corpus first; an issued ID is permanent
and is never reused.

<a id="3-jobs-coverage"></a>
## 3. Jobs coverage

| Job | Source | Supporting screens | Supporting journeys | Status |
|---|---|---|---|---|
| <the job, in the job's own words> | <committed document> | SCRN-001 | JRNY-001 | served |

`Status` is `served`, `partial`, `planned` or `none`.

### Jobs with no screen

<Each job the product should serve and does not, with its source. None.>

### Screens with no job

<Each surface no job story accounts for, with its `SCRN-###`. None.>

<a id="4-planned"></a>
## 4. Planned

| Item | Status | Source |
|---|---|---|
| <what is planned> | <status in the source document> | <committed document> |

No `SCRN-###` or `JRNY-###` ID appears here: nothing shipped supports a claim
about work that has not shipped. An item described only in an uncommitted file is
not listed.

<a id="5-environment-limits"></a>
## 5. Environment limits

<The integrations that are stubbed, simulated or absent where a reader would run
the product, and anything else that changes what the reader will observe.>
