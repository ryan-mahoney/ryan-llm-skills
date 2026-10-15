# Pi context management

Keep working context proportional to the current decision. A cache hit reduces repeated
input processing charges; cached tokens still occupy context and may count toward a
provider's long-context pricing threshold. Optimize total input and useful progress,
not cache-hit percentage alone.

## Prevent growth before summarizing

- Coordinators retain progress, decisions, review outcomes and artifact pointers. Read
  only the current stage's references; do not collect implementation transcripts.
- Owners retain one step by default. Package scope is explicit and applies to owners.
- Every `spec_editor` call starts a fresh disk session, including repairs and commits.
  The packet supplies current decisions, relevant contracts/source paths, preservation
  constraints and the stop rule. Questions stay in the same active editor process.
- Editors inspect only relevant source ranges and return compact changes and exceptions.
  Reuse exact source within an assignment. Do not reread whole files for narration.
- Keep full evidence in artifacts; link to it and retrieve missing ranges on demand.
  Preserve acceptance criteria, unresolved work, known failures and evidence revisions.

`runtime/runs/<run-id>-editor-sessions.json` records all editor invocations. The legacy
`editor_session` field remains a directory anchor. Metrics discover every recorded
session. Existing transcripts are preserved; fresh sessions do not reset the checkout.
Writer locks, cancellation, model selectors and review requirements remain in force.

## Native compaction and request protection

The `context-budget` extension installs on normal Pi sessions. The managed spec runtime
also installs it explicitly because its children disable automatic extension discovery.
A shared event-bus claim prevents duplicate installation. This uses Pi 1.2.0 APIs.

| Control | Value | Purpose |
| --- | ---: | --- |
| Session working context window | 76,000 tokens maximum | Trigger native compaction early |
| Maximum response allowance | 12,000 tokens | Bound one response's growth, including reasoning where the provider counts it |
| Native default compaction reserve | 16,384 tokens | Starts compaction around 59,616 with the working window |
| Native default recent context | 20,000 tokens | Keep recent exact messages alongside the summary |
| Request estimate stop | 90,000 tokens | Leave headroom below the desired 100k input ceiling |
| Tool text threshold | 12,000 characters | Archive large outputs and return head/tail excerpts |

The working model is a session-local copy. Smaller native limits stay smaller; provider,
model identity, registry capabilities, credentials, rates and selected thinking effort
are unchanged. The output allowance is reduced: this can require another turn for work
that formerly used a very long response. A truncated response is not completion.

Native compaction runs before later responses, including during tool loops, and writes
a durable summary. It makes additional model calls. Existing Pi compaction settings
still apply: disabling compaction or setting a large retained tail can lead to a budget
stop instead. Use the native defaults above. This extension does not overwrite settings.

The provider hook estimates the entire serialized payload, including tools, system
instructions and cached/replayed conversation. It uses UTF-8 bytes / 3 plus 1,024 tokens
and 4,096 per recognized image; this is **not an exact tokenizer or a guaranteed 100k
provider ceiling**. Content, image detail and provider serialization can change error.
Validate estimates against actual reported input on real runs before tightening limits.
Native virtual-model routing is not covered by the working-window guarantee; the final
payload guard still applies. External extensions making their own API calls are outside
this policy. Do not combine competing memory/compaction extensions without testing.

Pi swallows provider-hook exceptions, so the guard aborts the native request signal;
throwing alone would still send. Oversized legacy compaction input is cancelled before
the summarizer can bypass the ordinary request hook. Preserve its transcript and resume
from canonical artifacts with a bounded handoff rather than resending the same history.
For managed workers, settle/cancel the previous writer before replacing it.

Oversized tool text is saved with private file permissions beside the session in
`<session-name>-context-artifacts/`. The model receives the first 8,000 and last 2,000
characters, the full-output path and an explicit omission notice. Nontext blocks remain.
Read missing ranges before editing; never infer omitted source. If no durable session
file exists, the output is preserved and the request guard remains the backstop.
Archives follow transcript retention and are not automatically deleted by this policy.

## Measurement and activation

Custom `context-budget` session entries record numeric request estimates, blocked status,
actual assistant input/output/cache/reasoning usage, compaction usage and policy changes.
They are not added to model context and contain no prompt bodies. Native timestamps
provide ordering. Actual input is input + cacheRead + cacheWrite. Zero reported usage on
an error means billing is unknown; it does not prove a free request.

Compare similar completed steps: input p50/p95/max, requests above 100k, response p50/p95,
error rate, total input/output and compaction usage, elapsed time and acceptance/rework.
Use native session costs only when provider prices are configured; reconcile invoices
separately. Fresh editors may lower cache-hit percentage while lowering total cost.

Run `~/.agents/sync.sh` to register the extension and sync instruction changes. New Pi
processes load it; existing processes require a safe reload/restart. Do not interrupt an
active writer to activate it. Tests use a local HTTP provider and synthetic usage with
Pi 1.2.0; they establish request/lifecycle behavior, not production latency or cost savings.
