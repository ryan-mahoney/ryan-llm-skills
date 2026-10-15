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
Reviewer, fixer, final-review and diagnostic profiles declare the policy through additive
`subagentOnlyExtensions`. This preserves ambient provider discovery and the final editor's
existing provider adapter. It also loads when ambient discovery is disabled. Profile
replacement/overrides or a capability ceiling denying extensions can still exclude it;
external CLI workers are outside the native Pi policy. A shared event-bus claim prevents
duplicate installation. This uses Pi 1.2.0 and pi-subagents 0.78.0 APIs.

| Control | Value | Purpose |
| --- | ---: | --- |
| Session working context window | 88,000 tokens maximum | Trigger native compaction early |
| Response and thinking allowance | Selected model/settings | Preserve provider-specific generation semantics |
| Native default compaction reserve | 16,384 tokens | Starts compaction around 71,616 reported tokens with the working window |
| Native default recent context | 20,000 tokens | Keep recent exact messages alongside the summary |
| Request estimate stop | 90,000 projected tokens | Leave headroom below the desired 100k input ceiling |
| Tool text threshold | 12,000 characters | Archive large outputs and return head/tail excerpts |

The working model is a session-local copy. Smaller native limits stay smaller; provider,
model identity, registry capabilities, credentials, rates, selected thinking effort
and output allowance are unchanged. There is no blanket output cap: reasoning and
visible output share budgets on some providers and have different controls on others.
Without a cap, one very long response can push the next projected context past the
summarizer's own 90k estimate, so the compaction preflight refuses and the run stops
instead of compacting. This is rare but possible; recover with a bounded handoff.
The managed owner/editor launcher classifies a final `length` response as a failed,
incomplete packet even if it contains text and the process exits zero. It retains the
partial result and stop reason. Inspect current changes and assign a bounded continuation;
do not blindly retry or treat partial text as completion. A later native successful
response can recover a previous length stop. Pi's own overflow recovery remains intact.
This does not change how external CLI runners or pi-subagents classify their final result.

Native compaction runs before later responses, including during tool loops, and writes
a durable summary. It makes additional model calls. Existing Pi compaction settings
still apply: disabling compaction or setting a large retained tail can lead to a budget
stop instead. Use the native defaults above. This extension does not overwrite settings.

DeepSeek compaction uses Pi's native summarization, cut points and persistence with
an added working-handoff instruction. It aims for 8,000 characters, replacing completed
investigation narratives with outcomes and artifact references while preserving active
constraints, authority, revisions, known failures and pending obligations. This is a
prompt target, not truncation or an acceptance waiver. Both history and split-turn
summaries receive it. The summary request runs with thinking disabled; the provider,
native output budgets and configured transient retry policy remain unchanged, and the
session's selected reasoning level applies again to the next response. Pi caps a history
summary at 13,107 output tokens and a split-turn summary at 8,192, and reasoning shares
that cap. On 2026-10-15 a `deepseek-flash:max` editor spent 6-13k reasoning tokens per
summary; three of five hit `length` with no text and aborted the editor. The summary is a
fresh single-prompt request, so this does not affect reasoning replay in the session.

This intervention addresses an observed run whose saved summaries grew from 7,502 to
40,992 characters before repeated summary truncations. It is scoped to DeepSeek;
other providers retain their native summary path. The wrapper uses the configured
registry transport and guards the actual summary payload as well as its preflight
estimate. A failed or truncated summary cancels compaction, preserves original history,
and stops the current turn instead of falling back to the unchanged failing prompt.
It does not automatically resume a stopped coordinator.

The provider hook estimates the entire serialized payload, including tools, system
instructions and cached/replayed conversation. It uses UTF-8 bytes / 3 plus 1,024 tokens
and 4,096 per recognized image; this is **not an exact tokenizer or a guaranteed 100k
provider ceiling**. Content, image detail and provider serialization can change error.
Validate estimates against actual reported input on real runs before tightening limits.

The request guard and compaction preflight compare a projected value with the 90k stop:
the estimate times the latest reported/estimated input ratio, clamped to 0.5-2. The raw
estimate applies until a response reports usage. Native compaction triggers on reported
input, so an uncalibrated guard can fire first. On 2026-10-15 the estimate ran 1.3x high
for DeepSeek and 1.6x for Codex; a Codex reviewer reached a 93k estimate at about 57k
real input and was stopped before compaction could start at 59.6k. `request` entries
record the raw estimate, projected value and calibration. The ratio comes from the
previous request, so one unusually dense tool burst can still be underestimated.
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

## Reasoning-only responses

A response with no text and no tool call ends Pi's agent loop without a result. On
2026-10-15 MiMo fixers ended this way with `stop` and zero output, or with `length` inside
reasoning. At `agent_before_settle` the policy appends one instruction to continue and
requests another turn, at most twice in a row; a response with text or a tool call resets
the allowance. Each continuation records `empty_response_continue`. Managed owners and
editors also load `spec-runtime/provider-recovery.mjs`, which retries and falls back on
these responses first; this policy covers reviewers, fixers and other sessions without it.

## Measurement and activation

Custom `context-budget` session entries record request estimates, blocked status,
actual assistant input/output/cache/reasoning usage with provider/model identity, compaction
usage and policy changes.
They are not added to model context and contain no prompt bodies. Native timestamps
provide ordering. Actual input is input + cacheRead + cacheWrite. Zero reported usage on
an error means billing is unknown; it does not prove a free request.
`summary_request` and `summary_usage` retain DeepSeek summary request estimates and
stop reasons, including failed calls. `summary_failed` and `compaction_failed` record
failure categories without prompt bodies. Successful summary usage also appears in
the native compaction entry; do not count those two records twice.

Compare similar completed steps: input p50/p95/max, requests above 100k, response p50/p95,
error rate, total input/output and compaction usage, elapsed time and acceptance/rework.
Use native session costs only when provider prices are configured; reconcile invoices
separately. Fresh editors may lower retained input but increase rereading; total cost can
rise or fall. A fresh session does not necessarily invalidate a provider's identical-prefix
cache. Compare actual billed usage by provider/model; do not import another endpoint's rates.

The native boundary fixture reports 62k input and 12k output with reasoning replay plus
a near-12k-character tool result. The next uncompressed payload would exceed the 90k
estimate guard; native compaction completes and the continuation stays below it. This
covers that transition, not every tokenizer, image or tool burst. Keep the conservative
estimator until representative per-provider measurements justify changing it.

Background integration uses the installed runner launch builder and child-session factory
with real reviewer/fixer profiles, a loopback provider and ambient discovery on/off.
It verifies policy and usage entries in each child transcript and preserves discovery of
provider extensions. It does not exercise the detached process launcher or Bun executable.
The final-review/editor/diagnostic profile declarations are checked through the launch
builder; their full workflows and paid provider behavior are not exercised here.

Run `~/.agents/sync.sh` to register the extension and sync instruction changes. New Pi
processes load it. A live `/reload` can retain imported module code; confirm `summary_request`
telemetry and `fromHook: true` on a subsequent compaction before claiming the new wrapper
is active. Sessions holding the previous 12k session-local model copy must safely
restart or reselect the model from the registry to restore its output allowance; merely
reloading extensions can retain that copy. Do not interrupt an active writer to activate it.
Tests use a local HTTP provider and synthetic usage with Pi 1.2.0; they establish request/lifecycle behavior, not production latency or cost savings.

## Strategy choices

| Strategy | Primary effect | Decision |
| --- | --- | --- |
| Fresh bounded editor assignments | Remove prior assignment history, including reasoning | Retain; measure reread and cache tradeoffs on comparable work |
| Scoped reads and archived tool output | Reduce source/log volume and repeated retrieval | Retain; missing ranges remain recoverable |
| Early native compaction | Summarize growing history within long assignments | Retain with request guard; summary calls have a cost |
| Strip historical reasoning fields | Reduce replay directly | No generic stripping; provider contracts/signatures differ |
| Hard output or thinking cap | Shorten generation and future replay | Remove universal 12k cap; preserve chosen model settings |
| More aggressive request timeouts | Bound time waiting for one response | No global change without per-provider latency/streaming evidence |
| Semantic memory plugins | Retrieve observations instead of old history | Defer until canonical artifacts and native compaction prove insufficient |

MiMo is one validation target, not a protocol or pricing assumption in the policy.
Changing a provider adapter requires its own contract and real-provider validation.
