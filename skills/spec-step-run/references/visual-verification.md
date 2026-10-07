# Visual step verification

When the target entry in `spec-steps.json` has `visualDesign: true`, treat seeing the
rendered result as required implementation work, not optional final polish:

In the Pi owner/editor pair, the owner owns capture, image inspection, visual decisions
and evidence. Use `spec_verify` for capture/vision-relay commands after the editor
returns; the editor applies bounded corrections and does not run the visual checks.
Read `uishot` and `see` only when visual work is relevant. Establish vision for the
current model/harness rather than carrying another worker's cached verdict across
model changes. Independent reviewers reuse applicable captures and obtain fresh ones
only to close a concrete evidence gap against a stable reviewed revision.

For a needed dev server, pass `server: {command, ready_url, readiness_timeout}` to
`spec_verify` and put the capture operation in its outer `command`. The server command
runs in the foreground; readiness uses an owned loopback port. The runtime retains
the writer reservation through startup, capture and cleanup, then returns image/log
paths for inspection. Close browsers created by the capture and preserve pre-existing
ones. Do not leave `nohup` or background servers between tool calls. Readiness failure,
capture failure or cancellation still requires cleanup; unconfirmed termination blocks
another writer and notifies the coordinator.

1. Before editing, inspect any named visual reference and the applicable local design
   system and design/UX rules. Read the installed `uishot` skill completely and resolve
   its bundled launcher before the first capture. Open static reference images directly.
   For an executable reference or an existing production view reachable by URL, use
   `uishot` to capture the relevant page, region, states, and viewport sizes before
   editing so the implementation loop begins with observed pixels rather than inference.
2. Use `uishot` as the default Playwright-backed observation runner for the real changed
   UI, including when the repository has its own Playwright suite. A local app, Storybook,
   or component preview may serve the production component with its real styles. Run
   `uishot` from the worktree root, run its setup command when required, and keep its
   browser warm throughout the correction loop. `uishot` satisfies the Playwright-only
   screenshot requirement; do not classify it as a generic browser screenshot fallback.
3. Reuse the repository's Playwright configuration and fixture helpers. Run only an affected
   automated journey when the changed behavior needs browser evidence; do not launch the full
   suite for a capture. For an expensive journey with setup or live-state dependencies,
   apply [Verification fixtures and journey readiness](verification-fixtures.md): reuse
   the real fixture lifecycle, establish bounded application/worker readiness, and
   diagnose the first failing boundary before repeating the journey. The managed server's
   HTTP readiness alone does not establish the required live UI state.
   Use direct browser interaction and capture for capabilities that improve
   the observation: existing authentication or data fixtures, and
   interaction-driven states that `uishot` cannot create directly, such as hover, drag,
   form entry, or opening a transient surface. When those helpers can establish a stable
   URL or server-side state, capture the resulting view with `uishot`; otherwise capture
   in the repository's Playwright context and inspect that image. Create a temporary raw
   Playwright runner only when neither route can produce the required state. Do not add a
   lasting Playwright dependency solely for disposable observation, and do not use
   Cypress or a non-Playwright screenshot method as a fallback.
4. Capture the smallest representative set that proves the visual outcome: at least the
   primary changed view, plus any viewport, interaction, or non-ideal state materially
   affected by the step or named acceptance criteria. Use `--wait-for`, `--wait-text`,
   or `--selector` to pin `uishot` to meaningful content, and react to its readiness,
   console-error, broken-image, and failed-request output. Reveal menus, dialogs,
   validation, focus, overflow, or responsive behavior when those are part of the
   change. When the reference is executable, capture reference and production at
   matching states and viewport sizes.
5. Inspect every screenshot through the eyes established by the `see` skill: view the
   image directly under `host-vision`, or relay it through `see`'s `codex-see` under
   `codex-relay`. Establish that mode once, before the first inspection, instead of
   assuming the model running this step can view images — one that cannot will
   describe a screenshot it never saw. Do not infer correctness from a successful
   capture command, DOM assertions, or snapshot bytes.
   Compare against the visual reference when one exists and assess hierarchy, alignment,
   spacing, typography, color and contrast, clipping, overflow, layering, content states,
   responsive behavior, and obvious interaction affordances under the project's design
   posture. Confirm the image actually contains the changed UI and is not an error,
   login, loading, blank, or stale page.
6. Fix credible defects, repeat the affected local smoke interaction, recapture, and inspect again.
   Continue while an iteration yields new evidence or improvement. Capture and inspect
   at least one final image after the last visual code change; never call an image final
   when it predates the current implementation.

Write or update existing Playwright visual regression assertions and schedule the affected checks under the shared policy, but do not treat
baseline acceptance as a substitute for looking at the rendered pixels. Keep ad hoc
screenshots out of the commit unless the repository explicitly tracks Playwright visual
baselines, retain the final inspected images under `.specs/<feature>/evidence/` so they
survive as merge evidence, and terminate any server or watcher started for capture. If the first `uishot` capture launched its warm
browser, stop it after the final capture and confirm `uishot status` reports it stopped;
preserve a browser that was already running. Record the cleanup commands and outcomes.

If `uishot` and the repository's Playwright path cannot render the UI, or screenshots
can be neither viewed directly nor relayed through `see` after practical local
diagnosis, record the exact attempts and preserve
the result as `checkpoint`; passing non-visual tests does not make a `visualDesign: true`
step complete. Count visual correction cycles in `fix_attempts`. In the learning prose,
record the exact `uishot` and repository Playwright commands, target route or harness,
viewport and state coverage, screenshot paths, readiness and console evidence, what the
inspection found, corrections made, and the final visual assessment.

The final captures and deterministic scenario/setup notes are QA-tour inputs. Preserve
them under `.specs/<feature>/evidence/` with sensitive data removed. Rendered evidence
does not replace behavioral, data, policy, or production-reachability gates.
