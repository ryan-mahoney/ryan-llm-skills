# Repair wave promotion and recovery defects in wave-integration.mjs

`pi/extensions/spec-runtime/wave-integration.mjs` assembles a wave candidate from
sealed member heads, runs candidate checks, prepares and accepts integration repairs,
and promotes the verified candidate into the canonical checkout through a crash
journal (`promoteWave`, `recoverPromotion`). An independent review and a later
card refresh found the defects below. Fix all of them in that module, keeping every
existing export, return shape and refusal reason unless an item says otherwise.
Regression tests go in `pi/extensions/spec-runtime/wave-integration.test.mjs`; keep
every existing case.

## Review findings

1. **Ignored destination overwritten (HIGH).** Promotion permits ignored files, but
   `read-tree -m -u` overwrites an ignored destination when the candidate starts
   tracking that path. `observePromotion` excludes ignored paths and therefore reports
   the checkout clean. Reproduction: start from a verified candidate, add `feature.txt`
   to `.git/info/exclude` (with `core.excludesFile` set to `/dev/null`) and write
   valuable ignored bytes to canonical `feature.txt`; `promoteWave` returns
   `promoted` and replaces those bytes with the candidate's content. Protect ignored
   destination collisions, including directory/file overlaps, before destructive
   publication and on recovery. Preserve unrelated ignored files without rejecting all
   ignored content. A collision found before the intent is written refuses with the
   module's `integration-refusal` error and writes no intent; a collision that appears
   after intent but before `read-tree` blocks the promotion (result and journal state
   `blocked`), and recovery stays blocked. In every case canonical bytes, raw index and
   `main` stay unchanged.

2. **Verified input identity not bound (HIGH).** `verifyMembers` validates the current
   context members against their current refs, not against the
   `integration.base_commit`/`members` used to assemble and verify this candidate, and
   promotion never compares input identity. If a member's retention ref and
   `ctx.sealedHead` are both changed consistently after verification, promotion
   publishes the old candidate with its old receipts. Bind promotion eligibility to the
   durable assembly input identity (base and the complete normalized member list)
   before intent or publication, refusing contradictions with the existing
   `integration-input-changed` contract.

3. **Live retained inputs not revalidated on pending paths (HIGH).** Comparing the
   journal with the context is not enough: pending-intent `recoverPromotion` and any
   revalidation after a publication boundary must also observe live retention refs.
   Reproduction: crash at `before-cas`, move only `ctx.members[0].retentionRef` to the
   base commit (context and recorded members unchanged), then call `recoverPromotion`
   with the current revision: it returns `promoted` and publishes while the live member
   ref resolves to base. Moving that ref inside `before-cas` without a crash also
   promotes. Revalidate live retention-ref bindings on pending publication and recovery
   paths before publication. A live-only ref move refuses with the existing
   `integration-refusal`/`sealed-head-changed` refusal, leaving canonical files, raw
   index, raw journal and `main` unchanged.

## Defects found while refreshing later cards

4. **Stale revision after failed checks.** When `runCandidateChecks` fails, its internal
   `prepareIntegrationRepair` call is queued and it returns
   `{status:'failed', repair:null}` with a revision two writes old, so the next
   `updateWaveRecord`-based call refuses `revision-mismatch`. When the internal repair
   reservation is queued, return the module's queued shape (`status: 'queued'`, the
   current `revision`, `repair: null` and the queuing `constraint`); a later
   `prepareIntegrationRepair` then succeeds `repair-ready`.
5. **Checks cannot resume.** A crash mid-gate leaves `integration.status` `checking`, and
   a drain-unknown or candidate-tree-changed block leaves `blocked`; no export moves it
   back, so `runCandidateChecks` refuses `candidate-not-assembled` and `assembleCandidate`
   replays without resetting status. Provide the recovery path: re-run checks on a
   verified candidate tree after confirmed drain. A thrown gate transport blocks as
   drain-unknown and keeps claims until a confirmed retry.
6. **Explicit repair unusable.** Once the automatic repair budget is spent,
   `prepareIntegrationRepair` blocks `repair-unresolved` without writing a repair
   request, so `acceptIntegrationRepair` always refuses `no-repair-pending` and an
   operator-assigned explicit repair can never be accepted. With `explicit: true`,
   write the repair request.
7. **Unrecorded promotion claim.** A crash between reserving the promotion checkout and
   writing the intent leaves a claim recorded nowhere; recovery then gets
   `checkout-held`. Record the claim token before reserving, or have `recoverPromotion`
   find the claim by attempt `<wave_id>:promotion` via `inspectClaims` and adopt it.
8. **Promoted replay omits `ref`.** A replay of an already promoted wave must return the
   same branch `ref` as the original promotion.

Focused check: `node --test --test-name-pattern='^wave integration:' pi/extensions/spec-runtime/wave-integration.test.mjs`
(real Git repositories in temporary directories; about 15-40 seconds).
