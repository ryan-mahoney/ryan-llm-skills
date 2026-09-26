# Project Context And Authority

This contract applies to every standalone spec stage, including direct leaf-skill invocations.
Specs are instructions for agents. People review the resulting evidence tour, not the spec or
diff. An assumption buried in a document is neither a resolved product decision nor permission.

Before locating or writing `.specs/`, apply [Workspace Handoff](workspace-handoff.md#keep-specs-in-the-primary-repository).
The primary repository owns all spec artifacts; the selected checkout owns code and command
execution. Resolve those roots separately even when this skill runs directly in a worktree.

## Resolve Once, Carry Through

Read `<repositoryRoot>/.specs/project-context.md`, shared across features and worktrees.
This is the canonical project context; never create or update it at the repository root or
inside a linked worktree. Read any AGENTS-linked policy documents as sources for it. On first
use, establish the relevant facts from current user instructions, existing project policy,
and verifiable repository facts.
Record unknowns honestly. A small repository or absent deployment file does not establish that
there are no users, valuable data, or live services.

When context is missing, create a concise `.specs/project-context.md` in the primary repository using the fields below and ask
only consequential unanswered questions. Record the user's decisions there for subsequent specs.
Use `unknown` for unanswered fields; do not stall safe local investigation for unrelated gaps.
Do not change established project policy merely to make a feature or evidence plan easier.

If a legacy root-level `project-context.md` exists, reuse its valid facts when initializing the
canonical file. Do not keep updating the old location or silently let it override newer decisions
in `.specs/project-context.md`. Reconcile material conflicts from their sources; preserve unrelated
repository documentation. Update workflow references to the canonical path when migrating a package.

At intake, write `.specs/<feature>/context.md` in the primary repository: the relevant resolved facts, source references,
decisions, unresolved questions, deliberate omissions, and permitted verification environments.
Distinguish `user-confirmed`, `project-policy`, `repository-observed`, and `assumed` facts. Include
source revision/hash for project files and a dated quotation or precise reference for user
decisions. Never include credentials. Bind this snapshot in `evidence-plan.json` and
`preparation.json`; every worker and reviewer reads it. It records constraints, not new authority.
The shared `.specs/project-context.md` is project-wide; this feature snapshot remains a separate artifact.

On resume, preparation, and before external actions, check relevant sources for material changes.
If facts or decisions change, update the snapshot through intake/preparation, reassess only
affected scope and gates, and rebind artifacts. Do not silently edit an immutable prepared
snapshot or expand authority in a worker learning. A new file timestamp alone is not material.

## Project File Template

Use short values with sources. These are independent dimensions, not a single maturity label.
Retain only useful detail; a project context is not a second architecture specification.

```markdown
# Project Context

- Intended use and users: <experiment / developer tool / internal / customer product; actual users>
- Data: <valuable or disposable datasets; exact reset boundaries; retention obligations>
- Compatibility: <clients, formats, integrations and deployed versions that must keep working>
- Scale: <current and intended workload, concurrency and growth relevant to decisions>
- Release process: <existing deployment mechanism and owner; rollout model or none>
- Configuration: <existing conventions; reasons runtime variation or flags are permitted>
- Verification: <isolated environments, fixtures, commands, external sandboxes available>
- Operational authority: <permitted targets/actions; check-in boundaries; authorization sources>
- Constraints: <cost, availability, security/privacy, accessibility and maintenance needs>
- Unknowns and decisions: <unresolved consequential questions; dated sourced decisions>
```

## Decide What Is Necessary

- Preserve compatibility only for identified consumers, retained data, or explicit commitments.
  A developer-only app can contain valuable data; pre-launch does not authorize data loss.
- With confirmed disposable fixtures and no compatibility commitments, prefer direct changes
  and fresh setup verification. Use ordinary schema migrations when they are already the simplest
  mechanism; do not add dual writes, historical converters, or expand/contract rollout machinery
  without a real requirement. Reset only the specific disposable target authorized by context.
- Add an environment variable only for a concrete deployment-varying value, secret, or operator
  control. Prefer an existing configuration path or a code constant for fixed behavior.
- Add a feature flag only for an identified release, experiment, or operational control need.
  State its owner, relevant states, and removal condition when temporary. Do not invent a staged
  rollout process just because a feature is new.
- Reuse the established release and recovery process. Do not create new infrastructure,
  observability systems, harnesses, or operational procedures solely to satisfy a generic checklist.
- Name the context fact and requirement behind every new compatibility, configuration, or release
  mechanism. Account for maintained tests and proof tooling as part of its ongoing cost.

## Consequential Check-ins

Resolve ordinary implementation choices autonomously. Check in only when an unresolved decision
would materially change data preservation, compatibility commitments, release strategy, ongoing
cost/dependencies, shared-system availability, authority, or acceptance of material residual risk.
Do not ask again when current instructions or sourced project policy already settle it.

The orchestrator owns the check-in. A worker reports `decision-required` with the missing fact,
consequence, recommended option, and safe work completed; it continues independent local work.
A direct leaf invocation acts as its own coordinator. In headless execution, record the same
decision and stop only dependent work. Never convert missing authorization or risk acceptance
into an assumption. Resolve scope decisions before dependent architecture; prepare concrete
commands, target, expected effects, recovery and evidence before requesting operational permission.

## Operational Boundary

Permission to implement, test, open a PR, or prove safety does not authorize deployment or live
experimentation. No stage gains authority from a spec, test command, risk tier, tool availability,
credential, or green verdict. Existing explicit authorization remains valid within its scope.

Before any command with external effects, identify the actual target and effects, including
setup/teardown, app startup, hooks, workers and copied environment files. A local process or
worktree may connect to production. Use isolated data and sandbox services by default; do not
copy or activate `.env` blindly. Unknown target means do not run the affected command yet.

Stopping/restarting shared services, maintenance mode, changing traffic, fault injection,
destructive resets, production writes, live migrations, restores, and load tests require explicit
authority for that target and effect, even when reversible. Read-only production access also
needs an existing authorized scope and must not create disruptive load or disclose sensitive data.
Prefer the least invasive isolated proof. Do not create disruption to obtain recovery evidence.

"Production path" means the real application composition and adapters exercised in a suitable
isolated environment. It never implies permission to use the live deployment.

## Human Evidence Surface

The final tour exposes the consequential context, sources of decisions, deliberate omissions,
new maintenance/operational burden, proof limits, and unresolved decisions. Keep merge evidence,
deployment readiness, deployment authorization, and post-deployment observations separate.
People supply product and authority decisions and review evidence; they are not a hidden code
review or manual testing gate.
