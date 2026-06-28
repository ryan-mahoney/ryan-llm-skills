---
name: specops-intent-extract
description: This skill should be used when the user asks to extract the intent of a commit, determine what a commit changed and why, interpret a commit from its code rather than only its message, summarize the product or behavioral decisions a commit asserts, or produce a structured intent record for one commit. It is the per-commit leaf used by specops-decision-ledger.
disable-model-invocation: true
argument-hint: "<commit-sha or range> [repo-root optional]"
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# SpecOps Intent Extract

Read one commit and return a structured **intent record**: what the change accomplishes, why, and
which atomic product or behavioral decisions it asserts. Interpret the commit message *and* the code
— the message states the claim, the diff is the evidence. When they disagree, the code wins and you
say so.

This is a leaf utility. `specops-decision-ledger` invokes it once per commit during a history walk,
then folds the records into the decision ledger. Run it directly to inspect a single commit.

## Inputs

- Commit SHA (or a small range) and repo root: `$ARGUMENTS` or current repository.
- Optional manifest at `docs/specops/targets.json` to map changed files to target slugs.

## Method (a two-step micro-pipeline, not one shot)

Do not jump straight to "intent". Decomposing the judgment into stages produces sharper records:

1. **What changed (mechanical).** Read the commit message, then the diff. List the concrete changes:
   files, functions, config, schema, tests. Note added, removed, and rewritten behavior. Quote the
   message's stated reason if any.
2. **Why it changed (interpretive).** From the concrete changes, infer the product/behavioral
   intent and the atomic decisions the commit asserts. A decision is a statement about how the
   product *should* behave that a future reader could later contradict — not a description of the
   code. Prefer decisions you can anchor to a specific hunk.

Mark confidence honestly. A terse message plus a small mechanical diff is `high`; a large diff whose
purpose you are inferring is `low`. Label inferred intent as inferred.

## Output Contract

Return a single JSON object (the orchestrator consumes it; do not write files):

```json
{
  "commit": "<full-sha>",
  "abbrev": "<short-sha>",
  "author": "<name>",
  "email": "<email>",
  "date": "<ISO-8601>",
  "subject": "<commit subject>",
  "targets": ["<slug>", "..."],
  "intent": "<one paragraph: what this change accomplishes and why>",
  "decisions": [
    {
      "id": "<stable-kebab-slug, e.g. rate-limit-login>",
      "statement": "<a product/behavioral decision this commit asserts>",
      "kind": "requirement|behavior|policy|constraint|ux|data|removal",
      "evidence": ["<path:line or quoted message>"]
    }
  ],
  "supersedes_hint": [
    "<free text: any earlier decision this change appears to undo, replace, or relax, if visible from this commit alone>"
  ],
  "confidence": "high|medium|low"
}
```

Rules for the record:

- `decisions` are atomic and reusable: one statement each, stable `id` slugs so the orchestrator can
  match a later contradiction to an earlier decision.
- `kind: "removal"` is for a commit that deletes or disables a previously-present behavior; pair it
  with a `supersedes_hint` naming what was removed.
- `supersedes_hint` is a *soft* signal only. You see one commit, not the whole history, so never
  assert supersession as fact here — that judgment belongs to the orchestrator, which holds the
  active decisions. Note what the diff/message *suggests* and stop.
- Keep evidence to file:line anchors or short quotes; do not paste large diff blocks.

## Guardrails

- Do not edit source code, the manifest, the ledger, or the decision files.
- Do not analyze more than the requested commit(s); the walk order is the orchestrator's job.
- Describe decisions, not implementation mechanics — "logins are rate-limited to 5/min" is a
  decision; "added a `RateLimiter` class" is not.
- If the commit is a pure mechanical change (formatting, dependency bump, rename) with no product
  decision, return an empty `decisions` array and say so in `intent`; do not invent decisions.
