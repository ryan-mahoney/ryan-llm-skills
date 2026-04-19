---
name: feature-list
description: This skill should be used when the user asks for an inventory of features a codebase provides, grouped logically into capability areas. Produces an implementation-language-agnostic catalog of user-facing and operator-facing features, their entry points, and their supporting modules. Uses sub-agents to shard discovery across the repository so the top-level context stays small.
disable-model-invocation: true
argument-hint: "[target-scope (optional)]"
---

# Feature List

Produce a comprehensive, logically grouped inventory of the features a codebase provides. Output is implementation-language-agnostic and intended to support product reviews, roadmap audits, migration planning, and onboarding.

If `$ARGUMENTS` is provided, treat it as `TARGET_SCOPE` (a path, module, service name, or prose description).
If `$ARGUMENTS` is not provided, infer `TARGET_SCOPE` from the user request and repository context. When the repo is large and no scope is given, default to the whole repository.

You are an orchestrator. Do not read every file yourself. Use sub-agents to partition the work so your own context stays small. Only read enough to plan the partitioning and to aggregate results.

## What Counts As A Feature

A feature is a capability the system offers to an external actor (end user, operator, admin, integrator, scheduled job consumer). Features are expressed in user/operator terms, not code terms.

Examples of what is and is not a feature:

- ✅ "Reset password via email link"
- ✅ "Bulk-export invoices as CSV"
- ✅ "Nightly stale-session cleanup job"
- ✅ "Webhook notifications on order status change"
- ❌ "PasswordService.reset() method" (implementation detail)
- ❌ "Uses bcrypt for hashing" (technology choice, not a feature)
- ❌ "Has a Redis cache" (infrastructure, not a feature)

Include internal operator/admin features (CLI tools, cron jobs, feature flags that gate visible behavior). Exclude pure implementation details, libraries, and code architecture concerns unless they manifest as a user- or operator-visible capability.

## Orchestration Workflow

Execute the following phases in order. Each phase has an explicit context-management rule.

### Phase 1 — Shape Discovery (orchestrator, minimal reads)

Without reading file bodies, build a map of the repository:

1. Identify the project layout (monorepo packages, services, apps, top-level directories).
2. Identify likely feature surfaces:
   - HTTP routes / RPC handlers / GraphQL resolvers
   - CLI commands
   - Background jobs, cron schedules, queue consumers
   - Event handlers, webhooks, stream subscribers
   - UI entry points (pages, screens, top-level components)
   - Public SDK/API exports
   - Configuration-driven feature flags
3. Locate authoritative documentation (`README.md`, `AGENTS.md`, `docs/**`) and scan its table of contents only, to identify claimed features.
4. Partition the work into 3–10 shards. Each shard is a coherent slice: a service, a package, a route group, a directory, or a feature surface (e.g. "all cron jobs"). Shards should be roughly balanced and non-overlapping.

Announce the shard plan before delegating.

### Phase 2 — Sharded Extraction (sub-agents, in parallel)

Dispatch one sub-agent per shard, in parallel, using the `Explore` subagent type. Each sub-agent is responsible for enumerating features within its shard and returning a compact structured list to the orchestrator.

#### Sub-agent prompt template

```txt
Agent(
  subagent_type: "Explore",
  description: "Feature extraction — <shard-name>",
  prompt: "<EXTRACTION_PROMPT>"
)
```

#### EXTRACTION_PROMPT

```txt
You are extracting the feature inventory for one shard of a larger codebase.

Shard name: <shard-name>
Shard scope: <paths / modules / surfaces>
Exclusions: <anything in the scope that should be ignored>

Task:
1. Enumerate every user-facing, operator-facing, or integrator-facing feature provided by this shard.
2. Express each feature in the language an end user, operator, or integrator would use — not code terms.
3. Skip pure implementation details (helpers, internal services, libraries) unless they manifest as a visible capability.
4. Do not read more than needed; prefer routes/handlers/commands/jobs/exports as entry points, and follow the shortest path to understand what each does.

For each feature return:
- name: short verb-phrase name (e.g. "Reset password via email")
- description: one sentence describing what the feature does for the actor
- actor: end user | admin | operator | integrator | scheduled | system
- entry_points: list of concrete triggers (route, CLI command, job name, UI page, event)
- evidence: 1–3 file references with line numbers when useful
- confidence: high | medium | low (low = inferred from indirect signals)
- notes: anything ambiguous, legacy, flagged, or that looks dead

Also return:
- shard_summary: 2–3 sentence description of what this shard does as a whole
- likely_duplicates: any feature you suspect may also appear in another shard
- gaps: areas inside the shard scope you could not confidently enumerate, and why

Return the full list in your response. Do not write a file. Keep prose minimal — the orchestrator will consolidate."
```

Run sub-agents in a single message with multiple tool calls so they execute concurrently.

### Phase 3 — Aggregation & De-duplication (orchestrator)

Collect sub-agent returns. Do not re-read source files unless resolving a conflict.

1. Merge features across shards. Collapse duplicates (same feature surfaced through multiple entry points becomes one feature with multiple entry points).
2. Reconcile `likely_duplicates` flags from sub-agents.
3. Normalize names to verb-phrase form.
4. Promote or demote confidence when multiple shards corroborate or contradict.

If a conflict cannot be resolved from sub-agent output alone, dispatch one targeted fix-up sub-agent scoped to the conflicting files.

### Phase 4 — Logical Grouping (orchestrator)

Cluster the merged features into capability groups. Derive groups from the codebase, do not force a prescribed taxonomy.

Heuristics for grouping, in order of preference:

1. Domain concepts that already appear in the code or docs (e.g. "Billing", "Auth", "Inventory").
2. Actor-centric groups when the domain split is weak (e.g. "End-user self-service", "Admin tooling", "Integrator APIs").
3. Surface-centric groups as a last resort (e.g. "CLI", "Scheduled jobs").

Each feature belongs to exactly one primary group. A feature may be cross-referenced into at most one secondary group when the cross-cut is load-bearing for a reader.

Aim for 4–12 groups for a typical repository. Very small repos may have 2–3; large monorepos may have more but should prefer nesting over flattening.

### Phase 5 — Write Output (orchestrator)

Write the final markdown document to `docs/feature-list.md` unless the user specified a different path. Overwrite if it exists. Follow the output format below exactly.

After writing, report:
- feature count
- group count
- shards processed
- unresolved conflicts or gaps
- file written

## Required Output Format

The written document must contain these sections in order.

### 1. Overview

- One-paragraph description of what the system does as a product.
- Primary actors served.
- Scope of this inventory (whole repo, specific service, etc.).
- Date of inventory and commit SHA if determinable.

### 2. Feature Groups (Summary Table)

A table with one row per group:

| Group | Description | Feature count |
|---|---|---|

### 3. Features By Group

For each group, a subsection containing a table of its features:

| Feature | Actor | Entry points | Confidence | Notes |
|---|---|---|---|---|

- `Feature` is the verb-phrase name.
- `Entry points` is a comma-separated list of concrete triggers (route path, CLI command, job name, page route, event name).
- `Notes` is short — use for legacy/flagged/dead/cross-reference hints only.

Below each table, include a short prose paragraph describing how the group fits into the product.

### 4. Cross-Cutting Capabilities

Features that legitimately span multiple groups (e.g. audit logging used by many domains). List them once here with the groups they touch.

### 5. Ambiguities & Gaps

- Features with low confidence and what would be needed to raise it.
- Shards or directories that could not be fully enumerated and why.
- Suspected dead features (present in code, not reachable from any entry point).
- Features claimed in docs but not found in code, and vice versa.

### 6. Evidence Index

A flat list of `feature name → file:line` references, so a reader can jump from any feature back to source. Limit to the one or two most authoritative references per feature.

## Formatting Guidelines

- Express every feature in user/operator language. If you cannot describe it without code terms, it probably is not a feature.
- Use active verbs for feature names ("Reset password", "Export invoices", "Retry failed deliveries").
- Keep descriptions to one sentence. Detail belongs in the analysis skills, not here.
- Do not invent features. If evidence is thin, lower the confidence rating and note it.
- Do not include code snippets.

## Quality Bar

- Completeness over depth: better to list a feature with low confidence than to omit it.
- Grouping must reflect how a reader would want to navigate the product, not how the code is organized.
- De-duplication must be aggressive. One capability reachable from a web route, a CLI command, and a job is still one feature with three entry points.
- Sub-agents do the reading. The orchestrator does the planning, reconciliation, and writing. If the orchestrator finds itself reading file bodies in bulk, re-partition and dispatch another sub-agent instead.

## When Not To Use This Skill

- The user wants deep behavioral, policy, or rule extraction → use `specops-analysis`.
- The user wants an architectural map of modules and dependencies → use `architect-inspect` or `agents-update`.
- The user wants to locate where a single feature lives → use `identify-where`.
