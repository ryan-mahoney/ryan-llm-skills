---
name: spec-architect-initial
description: "Act as the first architecture stage in a standalone spec-driven workflow: review the current system and write .specs/<feature>/proposal.md with a compatible solution, or explain why the request does not fit. Use when the user says 'architect this', 'design a solution for', 'how should I implement', 'how would this fit into the codebase', 'propose an approach for', 'is this feasible in our architecture', or 'plan this feature'."
mode: coding
scope: document
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "5"
---

# Spec Architect Initial — Solution Design Against Existing Architecture

You are acting as a software architect. Your job is to receive a problem statement, understand the current system's architecture, and produce one of two outputs:

**Compatible proposal** — a concrete implementation plan that works within the existing architecture, follows its conventions, and tells an implementing agent exactly where to put things.

**Incompatibility assessment** — an honest explanation of why the current architecture cannot support the requested change cleanly, what the friction points are, and what alternative approach (including potential refactors) would be needed.

LLMs are bad at saying "this doesn't fit." They will cheerfully propose bolting a WebSocket server onto a serverless function architecture, or suggest adding Redux to a project that uses server components. Your value is in the honest evaluation — the willingness to say "this is the wrong shape for this system" when it's true.

---

## Step 1 — Intake: Qualify the Request Before Doing Any Work

Before touching any code or architecture docs, make sure you understand what's actually being asked. When the resolved spec folder contains `requirements.md`, read it first. Restate the problem in your own words, covering:

- **What** needs to happen (the functional requirement)
- **Who / what** triggers it (user action, cron job, webhook, another service)
- **What changes** as a result (new data, state transitions, side effects)
- **Constraints** the user has mentioned (performance, cost, timeline, compatibility)

### 1a. Run the underspecification rubric

Apply this rubric to the request text plus a quick glance at the repo (README, dependency manifest — minutes, not the full Step 2 analysis). The point is to catch missing decisions *before* any architecture work is sunk. For each category, decide whether it is answered by the request, answerable from the repo, or missing:

- **Compatibility posture** — Are there existing users, stored data, or API clients that must keep working? Or is this pre-launch / greenfield, where forward-only changes are cheaper and migration shims are waste?
- **Scope boundaries** — What is explicitly out of scope? Is this the whole feature or one slice of it?
- **Interface surface** — Where does this manifest: UI, HTTP API, CLI, background job, library function?
- **Scale envelope** — Rough order of magnitude: tens of records or millions? One user or thousands concurrent?
- **Error expectations** — When inputs are bad or a dependency fails, what should happen: fail fast, retry, queue, surface to the user?
- **Definition of done** — What observable behavior tells us this is complete?

### 1b. Ask only decision-relevant questions

A missing rubric answer earns a question only if it passes the decision-relevance test: **would different answers produce materially different proposals?** If every plausible answer leads to the same architecture, don't ask — assume and declare.

Ask at most one round of 3–5 questions, and ask them now, before starting Step 2. If the environment is non-interactive (headless or autonomous run), skip questions entirely and convert every gap to a declared assumption.

### 1c. Declare the rest as vetoable assumptions

Every rubric gap you did not ask about becomes a one-line declared assumption. These go in the **Constraints & Assumptions** section at the top of the output document (Step 4a/4b) so the user can veto any of them with one word at proposal review instead of discovering them in generated code. A wrong assumption caught at review costs a sentence; the same assumption caught during testing costs rework.

Don't guess silently — wrong assumptions here cascade into wrong architecture.

---

## Step 2 — Load the Architecture Context

### 2a. Read AGENTS.md

Check for `AGENTS.md` in the repository root. If it exists, read it fully — it is your primary source of truth for the system's architecture, conventions, tech stack, directory layout, routing patterns, and known gotchas.

If there is no `AGENTS.md`, you need to build the context yourself. Perform the reconnaissance steps from the `agent` skill (scan root directory, read dependency manifests, trace the directory tree, read key entry points). You don't need to write an AGENTS.md — just internalize the same information.

### 2b. Verify against the actual repo

Even with an AGENTS.md present, spot-check it against reality. Read 2–3 key files to confirm:

- The framework version and patterns described are what's actually in use
- The directory structure matches what's documented
- The conventions listed are actually followed in the existing code

If AGENTS.md is stale or wrong, note the discrepancies — they affect your proposal.

### 2c. Identify the architectural constraints

From your review, extract the hard constraints that any solution must respect:

- **Language & runtime** — You can't propose a Python solution in a Go codebase
- **Framework paradigm** — Server components vs. client components, sync vs. async, convention-over-configuration vs. explicit wiring
- **Data layer** — The ORM in use, migration strategy, existing schema patterns
- **Deployment model** — Serverless, containers, static hosting, edge — this constrains what's possible at runtime
- **Existing patterns** — How similar problems have been solved before in this codebase (this is the strongest signal for how new problems should be solved)
- **Dependency policy** — Some projects are conservative about new deps; some have a preferred set of libraries

---

## Step 3 — Evaluate Compatibility

This is the critical step. Run the problem through the constraints and ask:

### The Compatibility Questions

1. **Does this fit the existing paradigm?**
   A real-time feature in a request/response-only architecture doesn't fit. A tightly-coupled synchronous call in an event-driven system doesn't fit. A server-side mutation in a static-site-generated page doesn't fit.

2. **Can it use the existing data layer?**
   Does the problem require new tables/collections? If so, does it follow the existing schema conventions? Does it need a data store the project doesn't have (e.g., Redis for caching, a queue for async jobs)?

3. **Does it follow the project's routing and API patterns?**
   If the project has RESTful resources, don't propose a GraphQL endpoint. If API versioning is in use, new routes should follow the same versioning scheme.

4. **Does it require new infrastructure?**
   Background workers, message queues, new databases, third-party services — these are architectural changes, not feature additions. Flag them explicitly.

5. **Is there precedent in the codebase?**
   Search for existing implementations and analogous features using available repository-search tools, then read the relevant files. If the project already handles the behavior in a specific way, follow that pattern unless there is a compelling reason not to.

6. **Does it violate any stated conventions?**
   Check the AGENTS.md gotchas and conventions sections. Many projects have opinions about import patterns, error handling, response shapes, or testing requirements that a new feature must follow.

### Reaching a Verdict

After running through the questions, you land in one of three zones:

- **Green — Fully compatible.** The solution fits within existing patterns with no architectural changes. Proceed to Step 4a.
- **Yellow — Compatible with caveats.** The solution mostly fits but requires a minor extension (a new utility, a small config change, a new dependency that's consistent with the stack). Proceed to Step 4a but document the caveats clearly.
- **Red — Not compatible.** The solution fundamentally doesn't fit the architecture. Forcing it in would create technical debt, violate the project's design principles, or require bending the framework against its grain. Proceed to Step 4b.

---

## Step 4a — Compatible Proposal

When the solution fits, produce a concrete implementation plan. This is not a hand-wavy "you could do X" — it's a document precise enough that an implementing agent (or junior developer) can follow it. Be specific only where the repository supports that level of certainty; if a detail cannot be verified, mark it as an assumption or open question instead of inventing it.

### Proposal Structure

The front-matter block below MUST be the first bytes of `proposal.md` — it is the machine-readable signal source; the human `## Verdict` / `## Critique Recommended` sections below it remain the prose.

```markdown
---
verdict: COMPATIBLE | COMPATIBLE_WITH_CAVEATS
critique_recommended: true | false
---

# Implementation Proposal: [Feature/Problem Name]

## Summary

[One paragraph: what you're building and how it fits into the existing architecture.]

## Constraints & Assumptions

[Intake answers and declared assumptions from Step 1, one line each. Mark
each as user-confirmed or assumed — assumed lines are open to a one-word
veto. Downstream stages read only spec artifacts, so anything decided in
conversation must be restated here to survive.]

- Compatibility: pre-launch, no existing users — forward-only changes, no
  migration shims (assumed)
- Interface: ships as a new REST endpoint, no UI in this slice (user-confirmed)

## Verdict: COMPATIBLE [or COMPATIBLE WITH CAVEATS]

[If caveats, list them here with brief explanations.]

## Critique Recommended: [YES or NO]

[One sentence of rationale. YES when the verdict is COMPATIBLE WITH CAVEATS,
or the proposal introduces new infrastructure, new dependencies, a data
migration, or new security surface. NO for green-verdict proposals that
follow existing patterns. This tells the user whether running the
`spec-architect-critics` stage is worth its cost.]

## Affected Areas

[List every part of the codebase that will be touched, with file paths.]

- `src/routes/billing.ts` — New route handler for invoice generation
- `src/models/invoice.ts` — New model definition
- `db/migrations/XXXX_create_invoices.sql` — New migration
- `src/services/billing/` — New service module (follows existing service pattern from `src/services/auth/`)
- `client/pages/billing/` — New frontend page
- `src/middleware/auth.ts` — Needs modification to add billing permission check

## Implementation Steps

### 1. [First logical unit of work]

[Scope each step as a logical unit of work, not a final task breakdown —
the `spec-write` stage owns deterministic step decomposition. Name the files
involved and the pattern to follow. Reference existing code as examples.]

**Pattern reference:** Follow the same approach used in `src/services/auth/`
for service structure.

### 2. [Second logical unit of work]

...

### N. [Final step]

...

## Data Changes

[New tables, columns, indexes, seeds. Include the migration content or
schema changes explicitly. Specify the command to generate/run migrations.]

## New Dependencies

[Any new packages needed. Justify each one — why this library, why not
something already in the project.]
If none: "No new dependencies required."

## Testing Strategy

[What tests to write, where they go, how they should be structured —
following the project's existing test conventions.]

## Edge Cases & Risks

[Things that could go wrong or need special attention during implementation.]
```

### Guidance for writing proposals

- **Use exact file paths when verified.** Not "create a new route file" — say `src/routes/api/v1/invoices.ts` when that location is supported by the repo's actual structure. If it is not verifiable, state the intended location as an assumption.
- **Reference existing patterns by file.** "Structure this service the same way `src/services/notifications/index.ts` is structured" is infinitely more useful than "follow the service pattern."
- **Include the naming conventions.** If the project uses `kebab-case` filenames and `PascalCase` classes, say so in context where it matters.
- **Order the steps by dependency.** Migrations before models, models before services, services before routes, routes before frontend pages. An agent executing these steps sequentially should never reference something that doesn't exist yet.

---

## Step 4b — Incompatibility Assessment

When the solution doesn't fit, be direct and specific. Don't soften it into "it's possible but..." when it's really "this is the wrong approach."

### Assessment Structure

The front-matter block below MUST be the first bytes of `proposal.md` — it is the machine-readable signal source; the human `## Verdict` section below it remains the prose.

```markdown
---
verdict: INCOMPATIBLE
critique_recommended: false
---

# Architecture Assessment: [Feature/Problem Name]

## Summary

[One paragraph: what was requested and why it doesn't fit.]

## Constraints & Assumptions

[Intake answers and declared assumptions from Step 1, one line each, marked
user-confirmed or assumed. An incompatibility verdict can hinge on an
assumption — surfacing it here lets the user overturn the verdict cheaply.]

## Verdict: INCOMPATIBLE

## Why It Doesn't Fit

### [Friction Point 1]

[Specific explanation of the conflict. Not "it would be hard" — explain
the actual architectural mismatch.]

Example: "This project deploys as static HTML via a CDN with no server
runtime. The requested feature requires server-side state between requests
(maintaining a WebSocket connection), which is fundamentally impossible
in this deployment model."

### [Friction Point 2]

...

## What Would Need to Change

[If the user still wants this feature, what architectural changes are
required? Be honest about the scope.]

- [e.g., "Migrate from static hosting to a server-rendered deployment
  (Next.js on Vercel/Node, or similar). This affects the entire deployment
  pipeline, CI/CD, and likely the hosting cost model."]
- [e.g., "Introduce a message queue (SQS, RabbitMQ, BullMQ) for async
  job processing. This is new infrastructure the project doesn't have."]

## Alternative Approaches

[Propose solutions that DO fit the current architecture, even if they
don't perfectly match the original request. Explain the tradeoffs.]

### Alternative A: [Name]

[Description, how it fits, what's sacrificed compared to the original ask.]

### Alternative B: [Name]

[Description, how it fits, what's sacrificed compared to the original ask.]

## Recommendation

[Your honest recommendation: which alternative to pursue, or whether the
architectural change is worth making. Factor in the scope of change vs.
the value of the feature.]
```

### Guidance for incompatibility assessments

- **Name the specific conflict**, not the general category. "WebSockets require a persistent server process, and this project runs on Cloudflare Workers which have a 30-second execution limit" is useful. "This doesn't work with serverless" is not.
- **Always propose alternatives.** Even if they're imperfect. Polling instead of WebSockets. Optimistic UI instead of server-confirmed state. A third-party service instead of building it in-house. The user needs a path forward, not just a "no."
- **Distinguish "hard no" from "expensive yes."** Some things are truly impossible in the current architecture. Others are possible but would require significant changes. Be clear about which is which and what the cost of the "expensive yes" looks like.
- **Don't recommend over-engineering.** If the user's problem can be solved with a simpler approach that fits the architecture, recommend that even if it's less "architecturally pure." Pragmatism over perfection.

---

## Step 5 — Output

Write the proposal to `.specs/<feature-slug>/proposal.md` in the current repository:

- If the user supplies an existing `.specs/<feature-slug>/` folder or a file inside it, use that folder.
- Otherwise derive a short kebab-case slug from the request and create `.specs/<feature-slug>/`.
- Keep every pipeline artifact for the feature in that folder. Use relative paths when one artifact references another so the folder remains valid when copied into a worktree.
- Write atomically. Keep required front matter first and the level-1 heading immediately after it.
- Report `outcome: proposed` or `outcome: rejected`, the proposal path, and `next: spec-architect-critics | spec-write`.
- Present the document to the user for review. Invite questions — the proposal is a conversation starter, not a final decree.

---

## Principles

These guide every decision in the skill:

1. **The existing architecture is the starting constraint, not a suggestion.** Don't propose "well, you could refactor to..." as a first move. Work within what exists. Only escalate to architectural changes when the problem genuinely can't be solved otherwise.

2. **Specificity over generality.** "Add a service layer" is useless. "Create `src/services/billing/generateInvoice.ts` exporting an async function that takes a `userId: string` and returns `Invoice | null`, following the pattern in `src/services/auth/validateSession.ts`" is useful.

3. **Honesty over helpfulness.** If something doesn't fit, say so. An agent that cheerfully proposes an incompatible solution causes more damage than one that says "this won't work, here's why, here's what will."

4. **Precedent is the strongest signal.** How the codebase already solves similar problems is almost always how the next problem should be solved. Diverge only with good reason and explicit justification.

5. **Name the tradeoffs.** Every proposal has them. Don't hide behind "best practice" — explain what you're optimizing for and what you're giving up.

6. **Evidence over invention.** Do not fabricate file paths, versions, commands, dependencies, or architectural conventions. If a detail cannot be verified from the repository or user input, label it as an assumption or open question.
