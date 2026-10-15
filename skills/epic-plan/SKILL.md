---
name: epic-plan
description: "Plan an epic from the user's conversation: split the body of work into spec packages, sequence them for the most parallel work, and write the epic record, the epic plan, and one proposed package per member with a context.md that spec-architect-initial can start from. Use when the user says 'plan this epic', 'split this into specs', 'break this work into packages', or 'sequence this for parallel work'. High-level only: stops before any architecture, proposal, or spec."
argument-hint: "<workspace-id> <prefix>"
disable-model-invocation: true
license: MIT
metadata:
  version: "1"
---

# Epic Plan — Context In, Sequenced Packages Out

Turn the user's description of a body of work into an epic: the spec packages it splits
into, the dependencies between them, and the order that lets the most packages run at
once. Write the epic record, the epic plan, and one proposed package per member, each with
a `context.md` that lets `spec-architect-initial` start without the original conversation.
Then stop.

Contract: [Spec epics](../../docs/spec-epics.md). Paths come only from
[Spec Location](../spec-end-to-end/references/spec-location.md); never build them yourself.
This skill decides package boundaries and sequence. It does not choose mechanisms, trace
code paths, write proposals, or estimate steps; each member's architecture stage does that.

## Arguments

- `workspace-id` — an existing workspace.
- `prefix` — the epic slug and the member name prefix: 2 to 5 lowercase letters
  (`^[a-z]{2,5}$`). Members are named `<prefix>-<NN>-<short-slug>`, for example
  `bill-01-invoice-schema`.

The conversation supplies the context. It can be one sentence pointing at the current
thread, a long prompt, or a prompt that references files, folders, issues, plans, or design
packages. There is no context-file argument. Resolve references from the location the
prompt states: the workspace directory, a named kit repository, or an absolute path.

## Non-interactive operation

Run to completion. Ask at most one round of questions, and only when different answers
would produce a different package split or sequence (see Step 2). In a non-interactive run,
ask nothing and record every gap as a declared assumption in the plan.

## Step 1 — Resolve the workspace and check the prefix

1. Run `node ~/.agents/scripts/spec-location/cli.mjs resolve --workspace <workspace-id> --authoring`.
   On refusal print `message` and `remedy`, then stop. Note `specsDir`, `epicsDir`,
   `plansDir`, `projectContext` and the kit's repositories with their roles.
2. Run `node ~/.agents/scripts/spec-location/cli.mjs epics --workspace <workspace-id>` and list
   `specsDir`. Stop with `outcome: blocked`, `reason: prefix-taken` when an epic named
   `<prefix>` exists, a package name starts with `<prefix>-`, or `plansDir/<prefix>-epic.md`
   exists. Never extend or rewrite an existing epic here.

## Step 2 — Read the context and qualify the request

Read the conversation, every referenced item, `projectContext`, and the existing epics and
packages of the workspace (to find work that is already planned or done). For each kit
repository the work may touch, read `AGENTS.md` or the README and the top-level layout.
Stop there: enough to know which repositories own which surfaces and where shared contracts
live, not how to implement them.

Restate the goal: the outcome when the epic is complete, who benefits, and what is out of
scope. Then decide for each item whether the context answers it, the repositories answer it,
or it is missing:

- **Outcome and done** — the observable result that closes the epic.
- **Boundaries** — what is explicitly excluded, and which existing packages already cover part of it.
- **Repositories** — which kit repositories change. A needed repository outside the kit is a
  blocker with the remedy `workspace-kit add-repo`; do not plan around it.
- **Shared contracts** — schemas, APIs, events, module interfaces, or data that several parts consume.
- **Constraints** — compatibility, retained data, release order, or deadlines that force a sequence.
- **Designs** — design packages the work implements, if any.

A missing answer earns a question only when different answers change the split or the
sequence. Everything else becomes a one-line declared assumption.

## Step 3 — Split the work into packages

A member is one `spec-end-to-end` run: one coherent change that a reviewer can assess
and that merges as one PR per target repository. Each member delivers observable behavior
or a contract another member consumes, and must be verifiable on its own.

- **Slice vertically.** A member that delivers one capability through every layer can run
  beside other slices. Splitting by layer (all schema, then all API, then all UI) chains
  every member behind the one before it.
- **Fix shared contracts first, and keep that member narrow.** When several members consume
  the same schema, API or interface, put it in a small foundation member so the consumers
  can run in parallel after it. Everything waits on the foundation, so it carries only the
  contract and the minimum needed to verify it.
- **One owner per surface.** Each shared file, contract or screen belongs to one member.
  Others consume it; they do not co-edit it.
- **Split across repositories only where the parts can land apart.** A change that must
  land in two repositories together is one member with two targets. Parts that can land
  separately are separate members joined by `requires`.
- **Size honestly.** Every member pays for architecture, review, evidence and a PR. Merge
  a member that has nothing to verify on its own. Split one whose parts have different
  risk (a data migration and a UI change), different repositories that can land apart, or
  a part that could start while the rest waits.
- **Designs.** When the work implements design packages, cut members on each `design.json`
  screen inventory and give every screen exactly one owning member.

Give each member a short slug of two to four words that names its outcome.

## Step 4 — Sequence for parallel work

`requires` is the only dependency the record stores. A member's wave is derived from it:
wave 1 requires nothing, and each later wave requires only earlier waves. Members of one
wave can run at the same time in separate `spec-end-to-end` runs.

- Add an edge only when the member needs the other's merged result: code, a contract,
  data, or a migration it builds on.
- Add an edge when two members would edit the same files or contract heavily enough that
  parallel branches would conflict. Choose the order, and say in the member's `note` that
  the edge avoids a conflict in the named surface.
- Never add an edge for preference, numbering, or a feeling that one comes first. List
  direct dependencies only; drop an edge another path already implies.
- Shorten the longest chain before reducing the member count. When a chain exists only
  because a consumer needs a small piece of a large producer, move that piece into an
  earlier, narrower member.
- Order the `packages` array by wave; within a wave, put members on the longest chain
  first, then the most valuable. Ordinals `01`, `02`, … follow array order.

`epic-end-to-end` runs members serially by default. The waves tell the operator which
members can run concurrently.

## Step 5 — Write the plan and the record

Write every file atomically (temporary file in the same directory, then rename). Use the
real date for `created_at`.

1. **The plan**, `plansDir/<prefix>-epic.md`:

   ```markdown
   # <Epic title>

   ## Goal
   <the outcome, who benefits, what closes the epic>
   ## Members
   <table: package, outcome, targets>
   ## Sequence
   <waves; the longest chain; one line per requires edge saying what the consumer needs,
   or which surface the edge keeps from conflicting>
   ## Shared contracts
   <contract, owning member, consuming members>
   ## Out of scope
   ## Assumptions
   <one line each, vetoable>
   ## Supplied context
   <the user's goals, requirements, constraints, decisions and relevant chat clarifications>
   ## Referenced material
   <paths read; omit when none>
   ```

   The record holds the edges; the plan holds the reasons. Write no status table.

2. **The record**, `epicsDir/<prefix>/epic.json`, per [Spec epics](../../docs/spec-epics.md):
   `schema_version` 1, `epic` and the directory name equal to the prefix, `title`,
   `plan: "<prefix>-epic.md"`, `state: "planned"`, `created_at`, `designs` when the epic
   implements design packages, and `packages` in the order from Step 4 with each member's
   `requires` and any `note`.

3. **Validate**:

   ```bash
   node ~/.agents/scripts/spec-observe/cli.mjs epic lint --workspace <workspace-id> --epic <prefix>
   ```

   Fix the record until `ok` is true. Every member is listed under `missing` at this point.
   Confirm that the printed `waves` match the sequence the plan describes.

## Step 6 — Create the member packages

For each member, in array order:

1. Create it:

   ```bash
   node ~/.agents/scripts/spec-location/cli.mjs new --workspace <workspace-id> --slug <member> --target <repo id>... --plan <prefix>-epic.md --epic <prefix> [--design <ref>]... --authoring
   ```

   Branches default to `spec-<member>`. Take `package_dir` from the printed `locations`.

2. Write `package_dir/context.md`. It is the package's sourced context snapshot
   ([Project Context And Authority](../spec-end-to-end/references/project-context.md)),
   started with what the epic established. Tag each fact `user-confirmed` (dated quotation
   or precise reference), `project-policy` (path), `repository-observed` (repository and
   path), or `assumed`. Never include credentials.

   ```markdown
   # <Member title>

   ## Epic position
   - Epic `<prefix>`: <epic title>. Plan: `<prefix>-epic.md`.
   - Wave <n> of <total>. Requires: <member: what it provides> | none.
   - Required by: <member: what it consumes> | none.
   - Same wave: <members>; surfaces to keep apart: <surfaces> | none.
   ## Outcome
   <what this package delivers and the observable behavior that shows it is done>
   ## Scope
   ### In scope
   ### Out of scope
   <behavior owned elsewhere, with the owning member>
   ## Contracts
   ### Provides
   <contract and what consumers rely on; the exact form is for architecture>
   ### Consumes
   <contract and its producing member>
   ## Targets
   <repository id: why it changes>
   ## Facts and decisions
   ## Open questions for architecture
   ## Supplied context
   <the parts of the user's context that bear on this member, kept verbatim where wording matters>
   ## Referenced material
   <paths read; omit when none>
   ```

   Stay at the epic's level of detail. Name the problem, boundaries and contracts; leave
   mechanisms, file lists and step plans to architecture.

3. Run `node ~/.agents/scripts/spec-location/cli.mjs stamp <workspace-id>/<member>`, then
   `check <workspace-id>/<member> --authoring`. A refusal stops the run; report what was
   created so far.

Finish with the lint command from Step 5. `missing` must be empty.

## Output

Report this compact summary before any commentary:

- `outcome`: `planned` or `blocked` (with `reason`).
- Epic record and plan paths.
- Waves, one line each, with the member names; the longest chain and its length.
- Each `requires` edge added to avoid a conflict, with the surface it protects.
- Declared assumptions a reviewer may want to veto.
- Next: review the split, then run `/spec-end-to-end <workspace-id>/<member>` for members
  of wave 1 (in parallel if wanted), or `/epic-end-to-end` with `EPIC: <prefix>` to run
  the epic serially.

Do not write a proposal, spec or step card. Do not write into a repository. Do not add
Co-Authored-By trailers, "Generated with" footers, or model attribution to any artifact.
