# Optional Pi scouting

Use the installed `pi-subagents` **scout** profile for a bounded discovery question
when it will save substantial owner reading. Direct owner reads remain the default.
No scout is required at startup, before every step, or for files already inspected.

The scout earns its handoff by compressing unfamiliar cross-file discovery into evidence
for one decision. Useful cases include:

- A repair leaves the same failure: trace the fixture/event → dispatch → state → rendered
  result and identify the first boundary the supplied evidence does not establish.
- An unfamiliar integration: find the existing local pattern, callback contract or
  helper and cite the relevant implementation rather than guessing from memory.
- An uncertain installed dependency contract: confirm the callback/result shape and
  cancellation behavior in the named dependency. Return decisive excerpts and paths,
  not a source inventory. Do not reopen a prepared decision without contradictory evidence.
- A change with scattered callers or guards: locate affected sites and exceptions within
  an explicit source scope so the owner/reviewer need not open every search hit.

Use direct reads for a known small region. Give the scout existing observations and
exclude already-resolved questions. Ask for facts, exact supporting excerpts, unknowns
and the next discriminating observation; it cannot establish runtime behavior without
evidence or choose the repair. If the gap requires instrumentation, the owner groups
the needed diagnostic edits into one editor assignment and runs the reproduction.
The editor should not be used as a discovery relay to answer the same question.

Example brief: “The focused rejection-banner test still times out after a forwarding
repair. Submission returns a pending command; no rejection callback appears in these
supplied logs. Trace only the relevant test fixture, fake worker response, command
dispatch and subscription handling. Return the source path with key conditions,
what the logs establish, and the first unobserved boundary. No edits, tests or proposed
architecture rewrite.” Supply the actual test/symbol paths and log excerpts.

Scouting is available to the coordinator, step owner and independent reviewer.
The editor has no scouting/delegation tool. Default scout model is `openai-codex/gpt-6-luna:low`; an explicit
`SCOUT_AGENT` run directive overrides that selection. Never substitute providers after
a launch failure. Diagnose the specific failure or continue with direct owner reads.

The installed user override in `~/.pi/agent/settings.json` narrows the stock profile:

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": {
        "model": "openai-codex/gpt-6-luna",
        "thinking": "low",
        "tools": ["read", "grep", "find", "ls"],
        "output": false
      }
    }
  }
}
```

Merge those fields when configuring another machine; preserve unrelated settings.
Disabling `output` removes the stock `context.md` artifact. The scout has no shell,
editing, test-running or delegation tools. Project settings can override user settings;
diagnose an observed mismatch rather than probing profile capabilities on each launch.

The managed step owner uses `spec_scout(task)`; the runtime invokes the installed
pi-subagents scout profile through its structured foreground delegation API. The
coordinator passes the run's SCOUT_AGENT as `spec_dispatch.scout_model`. No general
subagent tool is exposed to the owner. The owner may read directly instead of scouting.

The reviewer profile permits nested `subagent` calls only to `scout`. Pass SCOUT_AGENT
in each reviewer assignment. For the coordinator, activate `subagent` with
`subagents_enable` if needed. Coordinator and reviewer can use this direct call:

```json
{
  "agent": "scout",
  "model": "openai-codex/gpt-6-luna:low",
  "context": "fresh",
  "cwd": "/absolute/selected-code-checkout",
  "async": false,
  "timeoutMs": 120000,
  "task": "Find the callers of <symbol> under <source roots> needed to decide <specific question>. Already inspected: <paths/facts>. Canonical spec package: <primary-checkout path>. Discovery only: no edits or checks. Return at most 3000 characters: relevant paths/symbols, short exact supporting excerpts, and uncertainties. State the searched scope; do not claim exhaustive coverage without it. Stop when the question is answered."
}
```

Use actual scope and paths, not placeholders. Keep the brief self-contained; do not
fork the entire orchestration transcript. The coordinator passes the compact answer
and source pointers to the next owner through `spec_dispatch.instructions`. Owner and
reviewer calls return to the caller. Each reads decisive code before choosing an
implementation or review finding; scout output is discovery evidence, not an acceptance
or review verdict. Review scouts must inspect unchanged code or supplied fixed-revision
artifacts when implementation runs concurrently, and confirm revision applicability. Keep any retained report in the canonical package.

Use `async: true` only when useful independent work can proceed, and consume the native
completion event without polling. A scout may inspect untouched dependencies while
the editor writes elsewhere; refresh any cited source changed since the scout read it.
Do not add a wait to first-step dispatch for speculative scouting. This route does not
make the managed owner's synchronous editor call asynchronous.
