# Project Context And Authority

This contract applies to every standalone spec stage, including direct leaf-skill invocations.
Specs are instructions for agents. People review the resulting evidence tour, not the spec or
diff. An assumption buried in a document is neither a resolved product decision nor permission.

Before locating or writing any spec artifact, apply [Spec Location](spec-location.md). The workspace owns all spec
artifacts; each target's checkout owns code and command execution. Resolve those separately even when this skill
runs directly in a worktree.

## Resolve Once, Carry Through

Read the file at `locations.project_context`: one project context per workspace, shared across packages, targets,
and worktrees. Repository-specific facts sit under a `## Repository: <id>` heading; read the shared sections and the
headings of this package's targets. Never create or update project context at a repository root, inside a worktree,
or anywhere other than that path. Read any AGENTS-linked policy documents as sources for it. On first
use, establish the relevant facts from current user instructions, existing project policy,
and verifiable repository facts.
Record unknowns honestly. A small repository or absent deployment file does not establish that
there are no users, valuable data, or live services.

When context is missing, create a concise project context at that path using the fields below and ask
only consequential unanswered questions. Record the user's decisions there for subsequent specs.
Use `unknown` for unanswered fields; do not stall safe local investigation for unrelated gaps.
Do not change established project policy merely to make a feature or evidence plan easier.

If a legacy root-level `project-context.md` exists in a repository, reuse its valid facts when initializing the
workspace file. Do not keep updating the old location or silently let it override newer decisions
in the workspace file. Reconcile material conflicts from their sources; preserve unrelated
repository documentation.

At intake, write `context.md` in the package folder (`package_dir`): the relevant resolved facts, source references,
decisions, unresolved questions, deliberate omissions, and permitted verification environments.
Distinguish `user-confirmed`, `project-policy`, `repository-observed`, and `assumed` facts. Include
source revision or precise location for project files and a dated quotation or precise reference for user
decisions. Never include credentials. Reference this snapshot by its package-relative name in `evidence-plan.json`; workers and reviewers read the relevant constraints. It records constraints, not new authority.
The workspace project context is project-wide; this feature snapshot remains a separate artifact.

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
- Delivery priorities: <feedback speed, required completion gates, and sourced policy for nonblocking follow-up work>
- Operational authority: <permitted targets/actions; check-in boundaries; authorization sources>
- Constraints: <cost, availability, security/privacy, accessibility and maintenance needs>
- Unknowns and decisions: <unresolved consequential questions; dated sourced decisions>
```

## Decide What Is Necessary

- Keep project test commands, selection examples, suite costs, isolation requirements, and
  final-check ownership in `AGENTS.md` or its linked testing guide. This shared context records
  product priorities and accepted tradeoffs; feature snapshots select the relevant facts.
  Use the shared evidence contract for cross-project test selection and scheduling.
- Apply an explicit project preference for fast delivery and batched fix-up PRs to nonblocking
  cleanup, minor polish, and speculative hardening. Record a concrete local follow-up destination
  and revisit trigger instead of expanding every feature. Do not infer this posture from a
  small repository, low customer count, or absent deployment tooling. Current acceptance failures,
  tenant/security defects, retained-data risks, and failed required gates still need resolution
  or an explicit applicable scope/risk decision. A delivery preference is not a blanket waiver.
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

## Decide, Record, Continue

The operator does not want routine questions. When a choice is open, decide: take the option a
panel of relevant experts (the reviewer's discipline, a senior engineer in the domain, the
project's documented practice) would most likely choose, preferring the recommended option that
preserves acceptance, data and existing behavior. Record each such decision in the stage ledger's
`decisions` as `Decided without operator: <question> -> <choice>; <one-line expert rationale>;
<reversible|irreversible>; <evidence path>`, then continue. The work tour lists these decisions so
the operator can revisit them. Do not ask the operator to approve additional review or
verification passes, documentation or provenance notes, packet splits, routing within the
selected roles, or evidence wording that narrows a claim to what is proven while a stronger claim
keeps a required owner gate. A reproduced defect within the run's scope gets a bounded repair and
the review needed to close it as the orchestrator's decision, even past a planned review or fix
count: such a count bounds routine cadence, and only accepting the defect instead needs the operator.
A module that splits a declared file along the card's boundaries, in the same directory, is within
the step's scope: say so in the dispatch, and declare the module in the step's writes once the owner
reports it.

Stop for the operator only when the decision needs authority the run lacks: publication, merge or
deployment beyond granted authority; any action on shared or production systems; destructive or
irreversible changes outside the run's branch and package; new spending, credentials or accounts;
waiving, deleting or weakening a required acceptance criterion or gate; accepting material
residual risk; or contradicting an explicit user instruction. Even then, record the recommended
option and continue all independent work. Do not ask again when current instructions or sourced
project policy already settle it.

The orchestrator owns decisions and check-ins. A worker reports `decision-required` only for a
decision it cannot make within its assignment, with the missing fact, consequence, recommended
option, and safe work completed; it continues independent local work. The orchestrator then
decides under the rule above unless the decision needs authority the run lacks.
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
