# Seed context-budget calibration when a session resumes

`pi/extensions/context-budget/policy.mjs` installs a context budget on a Pi extension
host. Before each provider request it estimates the input size from the serialized
payload and refuses requests that would exceed the model's limit. Because the raw byte
estimate is inaccurate (for Codex it counts encrypted reasoning), the policy keeps a
calibration ratio learned from reported usage and records each observation as a
`context-budget` custom session entry with `event: 'usage'`, `input_tokens` and
`estimated_input_tokens`.

A resumed session runs in a new process whose calibration starts at 1, so its first
request is judged on the raw estimate. A retained Sol owner with about 60k real input
was refused at a 121k estimate and the step redispatch aborted.

On `session_start`, seed the calibration from the session's last recorded usage entry
(`ctx.sessionManager.getEntries()`; a recorded entry has `customType: 'context-budget'`
and the recorded object in `data`): use the most recent `context-budget` usage entry
whose `input_tokens` and `estimated_input_tokens` are both positive, skipping entries
without usable usage, and apply the same ratio and bounds as live calibration. With no
usable entry, keep the default calibration. Preserve all existing behavior and handlers.

Add a regression in `pi/extensions/context-budget/policy.test.mjs`.
Check: `node --test pi/extensions/context-budget/policy.test.mjs`.
