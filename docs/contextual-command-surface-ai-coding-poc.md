# Contextual command surface: proof of concept

Status: proposed viability experiment.
The [vision](contextual-command-surface-ai-coding.md) describes the eventual experience.

## Question and smallest useful version

Can a spoken request plus the current Sentinel context produce a correct, recognizable action quickly enough for repeated use?
Can the selected action reach the existing host workflow without losing its target or inputs?

The smallest useful version adds one command panel to Sentinel.
It accepts text or a short recording, shows an editable transcript, and proposes an action.
The operator selects the action. Sentinel then uses its existing assignment preview and launch path.

The experiment uses one real workspace, one execution host, one speech adapter, and one fast generative model.
Three actions exercise distinct entity types:

| Action | Skill | Required context |
| --- | --- | --- |
| Plan an epic | `epic-plan` | Workspace and a described goal |
| Produce planned screens | `design-run` | Existing design package with its brief and screen plan |
| Implement a prepared spec | `spec-run` | Existing package and authoritative preparation records |

The routing trial evaluates all three actions. The first real execution trial uses only a small epic-planning assignment.
That trial produces workspace artifacts without application-code changes.
Design and implementation launches remain preview-only during the first experiment.

This scope proves a path from speech to a real host task.
It does not establish production readiness for every skill or workflow.

## Scope limits

The panel can open from Sentinel home or the selected workspace, design, or spec.
At home, the operator selects the single enrolled workspace before interpretation.
Workspace inference across several real workspaces remains a later experiment.

The prototype uses a bounded catalog read from existing records.
It does not add a graph database, embeddings, a second workflow engine, or automatic skill discovery.
It does not fine-tune models, build a native phone app, or promise background recording on a phone.
One foreground recording and one interpretation request can be active at a time.

Web research and repository search requests appear in the proposed action or clarification.
The interpreter does not perform those investigations before selection.
The launched skill retains its normal context reads and research obligations.

## Context and action catalog

The server builds a compact catalog from the enrolled workspace.
The client supplies entity identities, not filesystem paths.
The catalog includes display names, canonical references, linked context, prerequisite facts, and observation times.
Source errors and omitted entries remain visible.

The catalog includes a few actual designs and specs. Two similarly named entities exercise ambiguity.
Spec preparation comes from the current preparation contract, not a guessed `planned` flag.
Active assignments and uncertain launches come from existing assignment and runtime records.

Three manually authored action definitions describe target type, required inputs, effects, and a skill name.
The definitions reference the current skill instructions. They do not duplicate the complete skill workflow.
The existing resolver remains responsible for package identity and host paths.

The packet contains only the material necessary for interpretation.
It excludes complete repositories, large transcripts, and unrelated workspace documents.
Long requests need an explicit input limit and a visible error, not silent truncation.

## Interpretation contract

One tool-free model request receives the transcript, navigation context, catalog, and three action definitions.
`deepseek/deepseek-flash` is the first candidate because this repository already configures it for thread naming.
The interpretation adapter needs bounded output and a deadline. It cannot reuse title cleanup as a structured parser.

The following JSON illustrates a new proposal contract. It is not an existing endpoint or launch payload.

```json
{
  "schema_version": 1,
  "request_id": "request-identity",
  "catalog_revision": "server-catalog-digest",
  "transcript": "Implement this using the onboarding designs",
  "resolution": "proposal",
  "candidates": [
    {
      "action": "implement_spec",
      "workspace_id": "example-workspace",
      "entity_ref": "example-workspace/onboarding",
      "context_refs": ["designs/onboarding"],
      "research": { "web": "unspecified", "repository": "unspecified" }
    }
  ],
  "unresolved_references": [],
  "question": null
}
```

`resolution` is `proposal`, `clarification`, or `unsupported`.
Research intent is `requested`, `suggested`, or `unspecified` for each source.
The model can return at most three candidates. One candidate is the normal case.
The server derives display text and skill names from the action definitions.

The server checks the output shape and every reference against the catalog.
It also checks workspace membership, required material, and relevant activity facts.
An invented reference, unavailable source, or missing prerequisite produces a clarification or unavailable action.
It cannot become a launchable card.

Each candidate keeps the original goal and constraints. Resolved references augment the request rather than replace it.
The operator can edit the transcript and request a new interpretation.
No proposal starts a worker.

## Interaction

The panel has a text field and a record button.
After capture, it preserves the transcript and shows the proposed action without a separate mandatory transcript-acceptance step.
The operator can edit the transcript before selection.

For an epic request, the card shows:

> **Plan customer onboarding epic**
>
> Example workspace · Uses onboarding brief
>
> Creates an epic plan and member spec packages
>
> **Plan epic**

The card names the workspace, target, inputs, and expected effects.
A single primary action selects the intended work.
Alternatives appear only for materially different interpretations.
An unresolved reference produces one focused question or an entity selector.

The panel preserves input through microphone denial, transcription failure, model failure, and reconnect.
The visible states include recording, transcribing, interpreting, clarification, preview, launching, and attached task.
Missing assets, stale context, and an unavailable host each have a distinct explanation and next action.

The client discards late replies after a transcript edit, navigation change, or newer request.
Double taps reuse the same request and assignment identities.
The prototype never retries an uncertain launch with a new identity.

## Speech reuse

The prototype adopts one existing speech implementation through a narrow adapter.
It does not implement a third recognition stack as a prerequisite.

| Candidate | Existing components | Integration considerations |
| --- | --- | --- |
| Adjacent | `lib/adjacent/transcription.ex`, local Whisper, and PCM capture | Existing model preparation and Elixir dependencies must be available |
| the existing writer application | `server/asr/asrDaemonWorker.ts`, daemon protocol, and dictation state handling | Existing Bun process, shared modules, dependencies, and assets must be available |

The preferred first adapter wraps the existing writer application's separate daemon using one already provisioned engine.
Its NDJSON boundary can isolate inference from Sentinel's Node host.
The initial implementation can use a configured development checkout for that process.
It must document the local dependency rather than claim a standalone installation.

If that daemon is unavailable and Adjacent already has usable assets, the adapter can wrap Adjacent's transcription boundary instead.
This choice occurs during setup. Runtime errors do not trigger an automatic backend switch.
An adapter feasibility check precedes UI work because neither implementation is a dependency-free module.

Capture uses 16 kHz mono PCM and a 30-second limit for the experiment.
The adapter reports readiness, final transcript, and errors.
Stopping capture must flush remaining audio before interpretation. Partial text does not silently become the final transcript.
Model preparation happens explicitly before the trial.

Audio stays transient during normal use. The operator can retain selected clips for the evaluation corpus.
The same transcript then enters the text path.

### Whistle as an optional comparison

Whistle offers small CPU weights, keyword biasing, and browser or mobile deployment candidates.
Its article reports 11.1 ms to the first token on an M4 Pro, after audio input.
That number does not predict this experiment's full response time. [Whistle article](https://cactuscompute.com/blog/whistle)

Whistle's repository documents streaming and windowing for longer audio. [Needle repository](https://github.com/cactus-compute/needle)
The comparison uses the same clips, vocabulary, and downstream interpreter as the selected existing adapter.
It records transcription errors, warm and cold latency, and setup cost.
Browser or phone recognition remains a separate deployment trial.
The combined Needle speech-to-tool path remains outside the minimum prototype.

## Handoff to the existing host

The selected proposal becomes a brief in an existing or newly created workspace thread.
The brief retains the transcript, goal, constraints, resolved inputs, and selected action.
The thread uses the target binding required by the existing discussion service.

The adapter uses `saveBrief`, `previewAssignment`, and `launchAssignment` from the [discussion service](../scripts/workspaces/discussion.mjs).
Their current [routes](../scripts/workspaces/discussion-routes.mjs) already expose the handoff.
The new proposal contract maps to those APIs through server code.

The adapter requests a resolved preview before enabling the launch action.
It uses the existing digest comparison at launch.
It separately rereads relevant catalog facts, since preparation or activity changes need not alter the existing launch digest.
Changed relevant facts require a new preview.

The live trial uses `publication_authority: "none"` and an explicitly configured execution model.
The interpretation model does not choose the execution model or publication authority.
The planning skill still applies the existing spec-location and workspace-storage rules.

After launch, the panel opens the existing assignment view.
No new progress store, cancellation protocol, or task scheduler is necessary.
Closing the browser preserves the tmux assignment. Reopening locates the same assignment.
Terminal state and produced artifacts need separate observations.

## Evaluation and decision

The experiment records transcription, interpretation, and launch results separately.
A corrected transcript does not count as successful raw speech recognition.
A successful launch does not establish that the selected skill produced an acceptable result.

The initial corpus contains 30 operator-authored cases:

- Fifteen clear requests: five for each action, including actual entity names and referenced material.
- Five context-dependent requests: identical wording paired with different selected entities.
- Five ambiguous requests: duplicate names, missing material, incomplete goals, or unclear references.
- Five unavailable requests: an unprepared spec, active assignment, unavailable host, unknown entity, or unsupported action.

The operator records the expected action, entity, references, or clarification before evaluation.
Ten clear cases and five ambiguous or unavailable cases also have spoken clips.
The clips include project vocabulary and self-corrections.
The baseline uses the existing manual workflow on the same requests.

| Measure | Proposed viability threshold |
| --- | --- |
| Clear request routing | At least 14 of 15 correct action and target pairs |
| Context-dependent routing | All five reflect the selected entity correctly |
| Ambiguous and unavailable requests | All ten ask, abstain, or show unavailability without enabling an incorrect launch |
| Reference preservation | No fabricated reference and no silently dropped explicit constraint |
| Spoken clear requests | At least 90% preserve action and target without transcript correction |
| Warm interpretation | Median at most 2 seconds and p95 at most 5 seconds from final text to proposal |
| Warm spoken path | Median at most 5 seconds and p95 at most 10 seconds from recording stop to proposal |
| Real host handoff | One planning assignment produces the expected epic artifacts and remains identifiable after client disconnect |
| Launch identity | Repeated submission yields one assignment. Changed relevant context requires a refreshed preview |

These thresholds are experiment targets, not measured results.
Thirty cases can reveal failures but cannot establish production error rates.
Latency includes transport and adapter overhead. Model downloads and cold startup have separate reported timings.
The trial also records correction count, operator preference, provider errors, and observed request cost.

The text baseline runs first. Speech then uses the same cases and interpretation contract.
One real planning task establishes the final handoff and observation path.
Focused checks cover wrong targets, stale context, duplicate submission, audio finalization, and disconnect behavior.
Broad regression remains CI-owned or operator-managed under the repository policy.

Jev is optional in this experiment. Its existing [workflow adapter](../scripts/jev/README.md) does not expose an intent-routing contract.
A comparison needs separate typed questions and the same corpus.
The baseline does not depend on that addition. [Jev primitives](https://docs.typesafe.ai/introduction)

If text routing fails, improve the context packet or action definitions before changing speech engines.
If only speech fails, compare the existing implementations and Whistle on the failing clips.
If the thresholds pass, expand workspace inference and enable a bounded design or implementation execution trial.
The next stage can then evaluate longer recordings, additional skills, and direct interaction with active work.

## Repository anchors

- [Architecture and remote access](adjacent-architecture.md)
- [Workspace storage and assignments](../scripts/workspaces/README.md)
- [Spec, epic, and design resolution](../scripts/spec-location/README.md)
- [Epic planning skill](../skills/epic-plan/SKILL.md)
- [Design production skill](../skills/design-run/SKILL.md)
- [Prepared spec execution skill](../skills/spec-run/SKILL.md)

These documents establish the existing boundaries. The prototype adds interpretation and speech adapters within those boundaries.
