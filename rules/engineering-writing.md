# Engineering Writing

Apply to PRs, commit messages, work tours, and the explanatory prose in proposals,
critiques, and specs. Read the section for the artifact being written. For PRs and
tickets, also apply [PR and Ticket Writing](pr-and-ticket-writing.md). Preserve
required repository templates and machine-readable contracts.

## Audience and substance

Write for an experienced software engineer who knows the language and tools but
has not followed this work. Supply the relevant domain context without teaching
basic engineering. Familiar terms such as transaction, cache invalidation, and
idempotency are useful when they name the actual mechanism.

Lead with the condition, behavior, and consequence. Name the component that acts
and what it does. Explain a non-obvious choice or tradeoff; leave routine mechanics
to the diff. One small example can replace several paragraphs of abstraction.

Write from the final diff and observed results. A plan says what was intended;
it does not establish what shipped. Check scope, caller behavior, persistence,
compatibility, and operational claims against their sources. Distinguish an
observed failure from a suspected cause and a test result from a broader guarantee.
A synthetic example establishes a mechanism, not its frequency in production.

Keep human-facing prose about the software and the engineering decision. Do not
narrate the generating workflow: “step 4 completed,” “the spec required,” “the agent
found,” or “the evidence pipeline proves.” State the behavior, reason, or observation
directly. Internal handoffs and machine manifests may retain workflow provenance.

Before referencing a file in human-facing material, confirm it is committed in the
relevant revision and accessible to the reader. Do not cite `.specs/`, ignored or
uncommitted files, temporary reports, or paths outside the repository. A local file's
existence does not make it a shared source. Use a committed document, an accessible
issue/PR/artifact link, or explain the needed fact inline. Do not commit internal
workflow files just to create a citation. A portable tour must include its supporting
material or link to shared sources; it must not depend on the author's filesystem.

Use direct verbs and consistent domain terms. Replace phrases such as “establishes
batch-invariant aggregation semantics” with the behavior they mean: “Splitting the
same predictions into different batches produces the same accuracy.” Use that
sentence only when the implementation and evidence support it.

Remove praise, ceremonial openings, repeated conclusions, implementation diaries,
and claims such as “robust,” “seamless,” or “fully proven” that add no specific fact.
Do not compress sentences into noun piles or invent compound labels to save words.
Do not remove useful technical distinctions, uncertainty, or conditions to sound
confident. Natural prose has no fixed sentence length or banned-word quota.

## PRs: select what the reviewer needs

A small change usually needs a short paragraph or two: the problem, the correction,
and a relevant dependency or limitation. Add detail when it helps someone assess
the change. Do not fill sections merely because the workflow produced artifacts.

Keep claim/gate IDs, full SHA inventories, audit iterations, and routine passing
checks in their evidence records. Include a result when it answers a likely review
question. Link supporting material only where the reader can access it; an ignored
local `.specs/` path is not a shared reference. If important context is unavailable
elsewhere, explain that context briefly in the body.

For example, given a fix that retains the existing populated-bucket scoring rule:

> Replay combines prediction accuracy across vehicles and batches. When only one
> of four time buckets contains predictions, merging two 100% results reports 25%
> because the merge inserts three empty buckets. The merge now retains observed
> buckets and recalculates percentages from their combined counts. Each populated
> scored bucket still has equal weight in the overall percentage.

That example explains the bug and preserved scoring rule. It does not claim to fix
stored summaries or establish how common sparse results are.

## Commits: explain this diff

Use the repository's commit convention. Name the changed behavior or concrete
technical purpose in the subject, with a real module/domain scope when useful.
For example, `fix(replay): retain counts when merging time buckets` is more useful
in history than `fix(replay): address branch review (iter 3)`.

Add a body only for a reason, constraint, tradeoff, breaking change, or material
limitation that the subject and diff cannot explain. Describe the actual partial
result when committing a checkpoint. Do not imply the whole feature is complete.
Keep step numbers, spec basenames, and audit iteration metadata in workflow records
unless the repository requires them. Preserve required issue references and trailers.

## Work tours: explain the result, then let readers inspect it

Use the title and opening summary to explain the changed behavior and why it
matters. Give each section distinct information; do not repeat the summary in the
before/after account, evidence explanation, and implementation log.

Prefer ordinary labels such as “What changed,” “Verification,” “Test scenarios,”
and “Deployment.” Avoid slogans (“Evidence that closes the work”) and workflow
jargon (“sourced context,” “proof boundary”). Show the summary without requiring
a click. Keep internal IDs in reference details, not headings or navigation.

Write observations as scenario and result: “Two requests for the same key create
one row.” State the relevant limit: “This exercises one database instance.” Avoid
“EV-4 closes FH-2” as the explanation; retain those IDs in the traceability fields.
Keep exact commands, statuses, sources, and proof boundaries available in the
evidence inspector. Use descriptive link labels and included/shared evidence rather
than exposing internal paths or preparation artifacts. Describe only actual
operational obligations and uncertainties.

## Proposals, critiques, and specs: retain useful implementation detail

These primarily serve agents. Preserve exact contracts, defaults, edge cases,
ownership, rationale, source references, acceptance criteria, and evidence mappings.
Length is acceptable when each part supplies accurate, useful information. Do not
apply PR brevity to required coverage or change schema keys/statuses for style.

Open a proposal with the problem and recommended approach. Separate established
constraints from assumptions and unresolved decisions. In a critique, lead each
finding with the failure condition and consequence, then its evidence and proposed
correction. Practitioner perspectives should produce specific challenges, not
imagined quotations or theatrical dialogue. Remove duplicated explanations and
speculative obligations without deleting real requirements.

## Final edit

Read the title and opening without the conversation or spec. Can a teammate tell
what changes and why? Check each material claim against the implementation or its
source. Keep each sentence only if it adds context, behavior, rationale, evidence,
or an action the reader needs. Shorten by removing repetition, not by hiding limits.
