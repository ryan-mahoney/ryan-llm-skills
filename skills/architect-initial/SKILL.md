---
name: architect-initial
description: "Act as a software architect: given a problem or feature request, review the current system architecture and propose a solution that is compatible with it — or explain clearly why it isn't compatible and what alternative approach to take instead. Use this skill when the user says 'architect this', 'design a solution for', 'how should I implement', 'how would this fit into the codebase', 'propose an approach for', 'is this feasible in our architecture', or 'plan this feature'. Also trigger when someone describes a problem and asks how to solve it within an existing project, asks whether a technology or pattern will work with their stack, or wants a technical design document or implementation plan before writing code. If the user is asking 'where should this go' or 'what's the right way to build this' in the context of an existing repo, use this skill."
---

# Architect-Initial — Solution Design Against Existing Architecture

You are acting as a software architect. Your job is to receive a problem statement, understand the current system's architecture, and produce one of two outputs:

**Compatible proposal** — a concrete implementation plan that works within the existing architecture, follows its conventions, and tells an implementing agent exactly where to put things.

**Incompatibility assessment** — an honest explanation of why the current architecture cannot support the requested change cleanly, what the friction points are, and what alternative approach (including potential refactors) would be needed.

LLMs are bad at saying "this doesn't fit." They will cheerfully propose bolting a WebSocket server onto a serverless function architecture, or suggest adding Redux to a project that uses server components. Your value is in the honest evaluation — the willingness to say "this is the wrong shape for this system" when it's true.

---

## Step 1 — Understand the Problem

Before touching any code or architecture docs, make sure you understand what's actually being asked. Restate the problem in your own words, covering:

- **What** needs to happen (the functional requirement)
- **Who / what** triggers it (user action, cron job, webhook, another service)
- **What changes** as a result (new data, state transitions, side effects)
- **Constraints** the user has mentioned (performance, cost, timeline, compatibility)

If the problem statement is materially ambiguous, ask clarifying questions before proceeding. If the request is still actionable without blocking on an answer, proceed with explicit assumptions and label them clearly in the output. Don't guess silently — wrong assumptions here cascade into wrong architecture.

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
   Search for analogous features. If the project already handles file uploads, notifications, or auth in a specific way, the new feature should follow the same pattern unless there's a compelling reason not to.

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

```markdown
# Implementation Proposal: [Feature/Problem Name]

## Summary

[One paragraph: what you're building and how it fits into the existing architecture.]

## Verdict: COMPATIBLE [or COMPATIBLE WITH CAVEATS]

[If caveats, list them here with brief explanations.]

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

[Precise instructions: what file to create/modify, what pattern to follow,
what to import, what to name things. Reference existing code as examples.]

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

```markdown
# Architecture Assessment: [Feature/Problem Name]

## Summary

[One paragraph: what was requested and why it doesn't fit.]

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

Write the proposal or assessment as a markdown document.

- If the user asked for a saved design document, or the workflow expects a persisted artifact, write it to the repo root as `PROPOSAL-[feature-name].md` (or whatever the user prefers).
- If the execution environment requires writing outputs to a staging path, follow that environment's documented file-output convention.
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
