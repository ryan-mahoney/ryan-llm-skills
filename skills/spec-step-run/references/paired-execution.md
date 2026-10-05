# Paired execution in Pi

Use this reference when the coordinator assigns paired execution. The owner follows
`spec-step-run`; its editor executes bounded parts of that work. No extra planning or
review stage is introduced. The coordinator explicitly grants the owner permission to
launch one editor, and only one editor may be active in the checkout.

The profiles are installed by `~/.agents/sync.sh` from `pi/agents/`. Use native Pi agents
`spec-step-owner` and `spec-step-editor`. The owner inherits the configured capable model
unless the operator assigns one. The editor defaults to OpenRouter
`inception/mercury-2.5:high`; its Pi model selector is
`openrouter/inception/mercury-2.5:high`. Honor explicit role overrides.

Use these known profiles and the explicit model selectors directly. Do not enumerate
agents/models or launch probe agents before work. Actual dispatch validates availability;
use discovery only to resolve ambiguity or diagnose a concrete launch failure.
Preserve the selected model, including the `:high` suffix;
do not substitute a different Mercury version or a provider after a launch failure.
Profile or model unavailability is a concrete setup issue, not permission to silently
switch execution modes. Harnesses without nested delegation use the direct worker route
defined by `spec-run` instead.

## Owner and editor exchange

Give the editor the checkout, canonical subspec path, and a bounded assignment with
its relevant constraints. Start with the card's decided edit sequence. Request targeted
source inspection only where needed to execute it. The editor performs searches, reads,
edits, checks, evidence writes, and commits; the owner resolves engineering choices and
accepts results from actual excerpts, diffs, and diagnostics.

Examples of useful assignments: inspect a named interface and its callers; apply the
specified behavior using the existing pattern; run the prepared focused check and
diagnose a failure. Do not require an owner exchange for every tool call or ask the
editor to independently replan the whole step. Escalate a contradiction, material
departure, or repeated failure without new evidence; continue routine execution.

Launch the editor with an explicit `cwd`, `async: true`, `context: "fresh"`,
`timeoutMs: 7200000`, and `checkpointBeforeDeadlineMs: 600000`, unless the run has a
different budget. Send only task-relevant context, not the owner's transcript. The
editor profile supplies the default model; pass an explicit model if the run overrides it.
Do not layer host verification gates over checks already owned by the step.

## Retain sessions

After completion, resume the editor with:

```js
subagent({ action: "resume", id: "<latest-editor-run-id>", message: "<next assignment>" })
```

Keep the latest returned ID: a revival may create a new run ID while preserving prior
context. Inspect the exact known ID with `action: "status"` after interruption. Never
resume or replace a still-active writer. A completed child is resumed, not steered.
If retained-session eligibility fails, record the reason and launch a fresh editor only
after confirming the prior writer is inactive. Restore context from the card and index.
Provider or tool setup failures need diagnosis on the same execution route.

At each step boundary, have the editor write the learning and commit the coherent
artifact. Return the learning path, outcome, commit, latest editor ID, and unresolved
issues to the coordinator. No editor may remain active when the owner returns; otherwise
a between-step fixer could overlap it. The coordinator resumes the matching owner for
its next assigned step, with intervening commits and new constraints since that pair
last ran. Refresh affected source before edits. A different owner model uses its own
eligible retained pair or a fresh pair, never an old session with a changed model
contract. Keep the editor attached to its owner even when another pair uses the same
editor model.

The owner and editor may reset or compact when context pressure or demonstrated confusion
warrants it. Preserve canonical requirements, evidence, and unresolved findings. Step
numbers alone are not a reason to discard a useful session.
