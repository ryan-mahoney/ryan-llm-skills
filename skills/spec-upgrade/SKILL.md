---
name: spec-upgrade
description: "Upgrade existing, unimplemented standalone specs to the current project-context and proportional-evidence workflow. Use when the user wants to transition older specs, reassess pending specs for over-engineering, or update several prepared specs before implementation. Stops after preparation. Does not migrate application code or SpecOps analysis."
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Spec Upgrade

Bring one or more existing `.specs/<feature>/spec.md` packages up to the current standalone
workflow without implementing them. Preserve requested outcomes; reassess generated architecture
and proof obligations against actual users, data, compatibility, release process and authority.
The result is a prepared package and a short account of the consequential changes. People need
not read the rewritten specs or approve routine planning edits.

Read [Project Context And Authority](../spec-end-to-end/references/project-context.md) and the
[Executable Evidence Contract](../spec-work-tour/references/executable-evidence.md). Use
[spec-write](../spec-write/SKILL.md) and [spec-prepare](../spec-prepare/SKILL.md) for their owned
transformations and current schemas; do not invent a second upgrade schema or copy their templates.

## Select Existing Work

Accept a spec path, feature folder, explicit list, or a request for all pending specs in this
repository. A clear conversational selection is sufficient. With several candidates and no
selection, ask which to include; do not silently upgrade the entire backlog. Discover `.specs/`
directly even when gitignored. Keep each feature's canonical folder and identifiers where their
meaning survives. Do not merge separate features into a new project plan.

Read each selected spec and available requirements, proposal, critique, context, step index,
evidence plan, preparation, and progress artifacts. Check relevant repository code and recorded
step commits for signs that implementation has started. Accept an explicit user statement that
the work is unimplemented unless evidence contradicts it; missing progress files alone are not
proof. For a bulk "all pending" request, exclude clearly completed packages and identify uncertain
or partially implemented packages in the report. Do not reset them or erase execution evidence.
Resolve ambiguous implementation status before rewriting that package; continue other packages.

A proposal without a spec belongs to `spec-write`, not this upgrade. SpecOps analysis packages are
outside this skill. Report excluded or unsupported inputs with the appropriate next action.

## Resolve Context Once

Establish or reuse the project's context using the shared contract. Ask one concise batch of
consequential unresolved questions where possible. Reuse sourced answers across selected specs;
ask feature-specific questions only when they change that feature's implementation or proof.
Do not treat old generated assumptions, a "prototype" label, or absent deployment files as proof
of disposable data, absent consumers, or permission to operate services.

Inspect all selected packages for shared decisions before binding their final context snapshots.
If a later answer materially changes shared context, revisit only the affected earlier packages
and re-prepare them before reporting the batch ready. Report potentially stale unselected packages
without rewriting them. Dependencies between specs do not count as already implemented code;
use `spec-prepare`'s grounding requirements and report an unavailable prerequisite honestly.

Unanswered consequential choices block only dependent planning. Record `decision-required` and
continue independent work. Existing explicit authority remains valid within its scope; later
deployment authorization can remain pending when it does not prevent isolated merge proof.

## Reassess, Then Re-prepare

For each selected, unimplemented package:

1. Compare its behavior and constraints with current repository facts and sourced context. Identify
   which obligations are user/product commitments and which are previous agent design choices.
   Check migrations and compatibility shims, flags and configuration, new infrastructure, rollout
   procedures, verification tools and retained test code. Keep mechanisms with a concrete need;
   simplify unsupported ones without dropping required behavior, security or valuable-data protection.
2. Choose the least invasive sufficient evidence for credible failures. Reuse existing checks where
   adequate, classify merge/deploy/post-deploy obligations, and preserve independent final auditing.
   Record why removed or replaced obligations are inapplicable or covered. Do not downgrade risk
   merely because a harness is missing or a gate would fail. Resolving context is substantive work,
   not just adding fields or changing JSON version numbers.
3. Before the first edit to a package's planning inputs, preserve the existing planning files that
   will be overwritten in a filesystem snapshot outside the canonical package (for example,
   `.specs/.upgrade-backups/<feature>/<unique-run>/`). Specs may be gitignored, so Git is not a
   backup. Exclude runtime captures, credentials and unrelated files. Then remove any existing
   `preparation.json` before changing its bound inputs. A failed invalidation stops that package;
   never restore an old valid-looking manifest over changed inputs.
4. Write the sourced feature `context.md`. Reconcile any affected proposal/critique decisions with
   the resolved facts so obsolete instructions cannot be reintroduced by downstream readers.
   Preserve original feedback and note why it was superseded. Do not replay architecture or
   critique merely for an artifact upgrade; revisit only decisions invalidated by new facts.
5. Run `spec-write` in its existing-spec upgrade mode, using the original spec as an intent source
   even if no proposal exists. Pass resolved decisions and the reasons for changed obligations.
   Then run `spec-prepare` to ground the revised plan, regenerate affected execution cards and
   publish the complete current manifest last. Follow both skills in full; naming them in a report
   is not execution. If a prerequisite or consequential decision prevents preparation, leave the
   manifest absent and report that outcome rather than manufacturing readiness.
6. Check the resulting evidence plan with its validator, recompute the preparation hashes, and
   confirm the context binding and owned-step coverage. These checks establish preparation validity,
   not implementation correctness or deployment readiness. No feature has passed a future gate
   merely because its plan was upgraded.

Reuse a current package whose context, obligations, grounding and manifest already satisfy these
requirements. Return `already-current` without rewriting files, refreshing dates or taking another
backup. On an interrupted upgrade, reuse intact backups, inspect the current files and finish only
the missing work; do not overwrite the only original snapshot with partially upgraded inputs.

This invocation authorizes planning changes, not implementation, branch creation, commits, PRs or
deployment. Do not invoke `spec-run` or `spec-end-to-end`. Inspect command targets before any
preparation-time tooling; the shared operational boundary still applies. Never run destructive or
live-system verification to make an unimplemented spec appear ready.

## Report And Handoff

For each changed package, write a concise `upgrade.md` beginning with a level-1 heading. Record
original snapshot location, context source, retained outcomes, consequential simplifications and
their reasons, remaining decisions, and preparation validation results. Keep operative decisions
in `context.md` and the canonical planning artifacts, not only this report. For unchanged packages,
a conversational result is sufficient. Do not create an implementation work tour before code exists.

Return one compact row per selected package with its path and one of `prepared`, `already-current`,
`decision-required`, `blocked`, or `excluded`, plus the material change or blocker. A mixed batch
must not be reported as entirely ready. State that ready means ready to implement. Provide the
exact next invocation for each ready package, for example:

```text
Use spec-end-to-end for .specs/example-feature/. Resume from the prepared package.
```

Stop at this handoff. The user chooses when to start implementation.
