// Additive F10-4/F10-5 receipt-projection coverage (step 010).
//
// The durable wave record stores members as an insertion-ordered object, and
// `status` is a read-only projection. These tests prove:
//   F10-5  a replayed `startup` exposes the same bounded member preview;
//   F10-5  `status` projects the public spec.md K member shape (workspace
//          evidence, never the internal durable member fields), orders blocked
//          before active/queued/sealed, bounds the preview and reports the
//          full/omitted counts without writing the record.
//
// These tests add coverage only. They do not edit production code or existing
// tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CASE4_TIMEOUT_MS,
  WAVE_ID,
  COORDINATOR_SESSION,
  makeCase4Fixture
} from './waves-fixture.mjs';

// The standard owner/model selectors used by the admission and progression
// cases, so the startup here is the same shaped request as those suites.
const STANDARD_OWNER_INPUT = {
  owner_model: 'fixture-provider/team/owner',
  strong_owner_model: 'fixture-provider/team/owner',
  editor_model: 'fixture-provider/team/owner',
  review_model: 'fixture-provider/team/reviewer:high',
  fix_model_override: 'fixture-provider/team/owner',
  scout_model: 'fixture-provider/team/scout'
};

const startupInput = f => ({
  package: f.packagePath,
  workflow_id: WAVE_ID,
  execution: 'waves',
  isolation: 'worktree',
  ...STANDARD_OWNER_INPUT
});

test('wave receipt: a replayed startup exposes the same bounded member preview',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t, { memberCount: 1, holdOwners: true });

    const first = await f.controller.startup(startupInput(f), { session: COORDINATOR_SESSION });
    const replay = await f.controller.startup(startupInput(f), { session: COORDINATOR_SESSION });

    assert.equal(replay.wave_id, first.wave_id, 'a replayed startup must return the same wave id');
    assert.equal(replay.generation, first.generation, 'a replayed startup must return the same generation');
    assert.deepEqual(replay.members, first.members,
      'a replayed startup must expose the same member preview');
    assert.ok(Array.isArray(first.members), 'the first startup must expose a member array');
    assert.equal(first.members.length, 1, 'the first startup must expose exactly one member');
    assert.equal(first.member_count, 1, 'the first startup must report one member');
    assert.equal(first.omitted_count, 0, 'the first startup must omit no members');
    const durableMember = JSON.parse(readFileSync(first.record_path, 'utf8')).members[first.members[0].step];
    assert.equal(first.members[0].run_id, durableMember.run_id,
      'the previewed member run id must match the durable member run id');
    assert.equal(f.entry.startup, 2, 'only the two startups may be recorded');
  });

test('wave receipt: status bounds, orders and reports an eighteen-member preview read-only',
  { timeout: CASE4_TIMEOUT_MS }, async t => {
    const f = await makeCase4Fixture(t, { memberCount: 1, holdOwners: true });

    const receipt = await f.controller.startup(startupInput(f), { session: COORDINATOR_SESSION });
    const waveId = receipt.wave_id ?? WAVE_ID;
    const recordPath = receipt.record_path
      ?? join(f.packagePath, 'runtime', 'waves', `${waveId}.json`);

    // Snapshot the live durable record the controller just wrote. Every seeded
    // member below is a clone of its real member shape with only the fields the
    // projection reads changed, so this stays a projection test rather than a
    // hand-built record shape.
    const original = readFileSync(recordPath, 'utf8');
    try {
      const record = JSON.parse(original);
      const templateStep = Object.keys(record.members ?? {})[0];
      const template = record.members[templateStep];
      assert.ok(template, 'the startup must have written a real member to clone');

      const phases = { 1: 'sealed', 2: 'queued', 3: 'implementing', 4: 'blocked' };
      const seeded = {};
      // Reverse numeric insertion order (18 down to 1): a projection that
      // trusted insertion order instead of grouping and sorting by step would
      // fail the ordering assertion below.
      for (let step = 18; step >= 1; step -= 1) {
        const clone = JSON.parse(JSON.stringify(template));
        clone.step = step;
        clone.phase = phases[step] ?? 'sealed';
        clone.run_id = `seeded-run-${String(step).padStart(3, '0')}`;
        if (step === 4) clone.blocking_reason = 'confirmation-failed';
        seeded[String(step)] = clone;
      }
      record.members = seeded;
      writeFileSync(recordPath, JSON.stringify(record, null, 2));

      const seededBytes = readFileSync(recordPath, 'utf8');
      const status = await f.controller.status({ package: f.packagePath, wave_id: waveId });

      assert.equal(readFileSync(recordPath, 'utf8'), seededBytes,
        'status must be byte-read-only and never rewrite the durable record');
      assert.equal(status.record_path, recordPath, 'status must report the unchanged record path');
      assert.equal(status.member_count, 18, 'status must count every member, not just the preview');
      assert.equal(status.omitted_count, 2, 'status must report the members omitted from the preview');

      const preview = status.members ?? [];
      assert.equal(preview.length, 16, 'the member preview must be bounded to sixteen entries');
      assert.deepEqual(preview.slice(0, 4).map(member => member.step), [4, 3, 2, 1],
        'the preview must order blocked, active, queued, then sealed members');
      assert.equal(preview.find(member => member.step === 4)?.phase, 'blocked',
        'the blocked seed member must preview as blocked');
      assert.equal(preview.find(member => member.step === 4)?.blocking_reason, 'confirmation-failed',
        'the blocked preview must retain its blocking reason');
      assert.deepEqual(
        preview.filter(member => member.phase === 'sealed').map(member => member.step),
        [1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        'sealed members must be ascending by step and bounded by the preview cap');

      // The public K member shape exposes workspace evidence and must not leak
      // the internal durable member fields.
      const K_MEMBER_FIELDS = ['step', 'phase', 'run_id', 'checkout', 'base_commit',
        'sealed_head', 'review_artifacts', 'blocking_reason', 'backend',
        'fallback_reason', 'snapshot_id', 'upper_id', 'active_phase', 'git_dir'];
      for (const member of preview) {
        for (const field of K_MEMBER_FIELDS) {
          assert.ok(field in member, `preview member ${member.step} must expose the K field ${field}`);
        }
        assert.equal(typeof member.phase, 'string', 'phase must survive the projection');
        assert.equal(typeof member.run_id, 'string', 'run_id must survive the projection');
        for (const internal of ['workspace', 'transitions', 'claim_token']) {
          assert.ok(!(internal in member),
            `preview member ${member.step} must not leak the internal field ${internal}`);
        }
      }

      const templateWorkspace = template.workspace ?? {};
      const blockedPreview = preview.find(member => member.step === 4);
      assert.equal(blockedPreview.backend ?? null, templateWorkspace.backend ?? null,
        'backend must map from the member workspace');
      assert.equal(blockedPreview.fallback_reason ?? null, templateWorkspace.backendReason ?? null,
        'fallback_reason must map from the member workspace backend reason');
      assert.equal(blockedPreview.snapshot_id ?? null, templateWorkspace.snapshotId ?? null,
        'snapshot_id must map from the member workspace');
      assert.equal(blockedPreview.upper_id ?? null, templateWorkspace.retained?.upperId ?? null,
        'upper_id must map from the retained member workspace');
      assert.equal(blockedPreview.checkout ?? null,
        (templateWorkspace.merged ?? templateWorkspace.worktree) ?? null,
        'checkout must map from the member workspace');
    } finally {
      // Restore the real record before the fixture cleanup tears the package
      // down, even when an assertion above fails.
      writeFileSync(recordPath, original);
    }
  });
