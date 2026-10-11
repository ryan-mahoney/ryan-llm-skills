import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectAssignment,
  QUIET_ACTIVITY_MS,
  LAUNCHING_ATTENTION_MS,
} from './assignments.mjs';

const NOW = 1_800_000_000_000;
const ASSIGNMENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const SPEC_PACKAGE = '/repo/packages/alpha';
const WORKFLOW_ID = 'workflow-alpha-1';
const PI_IDENTITY = { pid: 43210, started_at: 'Thu Jan  1 00:00:00 1970' };

function makeRecord(overrides = {}) {
  return {
    assignment_id: ASSIGNMENT_ID,
    spec_package: SPEC_PACKAGE,
    workflow_id: WORKFLOW_ID,
    state: 'live',
    created_at: new Date(NOW - 5000).toISOString(),
    ...overrides,
  };
}

function makeClassification(overrides = {}) {
  return {
    state: 'live',
    piIdentity: PI_IDENTITY,
    sessionFile: null,
    attention: [],
    gone: false,
    ...overrides,
  };
}

function project(record, classification, options = {}) {
  return projectAssignment(record, classification, { now: NOW, ...options });
}

test('assignment projection maps a live record to live with an attach hint and no control', () => {
  const row = project(makeRecord(), makeClassification());
  assert.equal(row.display, 'live');
  assert.equal(row.recordedState, 'live');
  assert.equal(row.observedState, 'live');
  assert.equal(row.unrecorded, false);
  assert.equal(row.nextAction, 'Attach command');
  assert.equal(row.safeAction, 'Attach command');
  assert.equal(row.hasControl, false);
  assert.equal(row.coverage, 'complete');
  assert.equal(row.assignment_id, ASSIGNMENT_ID);
  assert.equal(row.spec_package, SPEC_PACKAGE);
  assert.equal(row.workflow_id, WORKFLOW_ID);
});

test('assignment projection shows an observed live agent over an unrecorded launch as live-unrecorded', () => {
  for (const state of ['launching', 'launch_unknown']) {
    const row = project(makeRecord({ state }), makeClassification());
    assert.equal(row.display, 'live-unrecorded');
    assert.equal(row.unrecorded, true);
    assert.equal(row.nextAction, `adjacent locate ${ASSIGNMENT_ID}`);
  }
});

test('assignment projection keeps a launching record under 60 seconds waiting', () => {
  const row = project(makeRecord({ state: 'launching' }), makeClassification({ state: 'launching' }));
  assert.equal(row.display, 'launching');
  assert.equal(row.nextAction, 'Wait');
  assert.equal(row.unrecorded, false);
});

test('assignment projection marks a launching record at 60 seconds or later as launch-unconfirmed', () => {
  const record = makeRecord({
    state: 'launching',
    created_at: new Date(NOW - LAUNCHING_ATTENTION_MS).toISOString(),
  });
  const row = project(record, makeClassification({ state: 'launching' }));
  assert.equal(row.display, 'launch-unconfirmed');
  assert.equal(row.nextAction, `adjacent locate ${ASSIGNMENT_ID}`);
});

test('assignment projection marks a launch_unknown record with probes ok as launch-unconfirmed', () => {
  const row = project(makeRecord({ state: 'launch_unknown' }), makeClassification({ state: 'launch_unknown' }));
  assert.equal(row.display, 'launch-unconfirmed');
  assert.equal(row.nextAction, `adjacent locate ${ASSIGNMENT_ID}`);
});

test('assignment projection shows a confirmed gone live record as exited-unrecorded without rewriting it', () => {
  const record = Object.freeze(makeRecord());
  const row = project(record, makeClassification({ state: 'ended', gone: true }));
  assert.equal(row.display, 'exited-unrecorded');
  assert.equal(row.unrecorded, true);
  assert.equal(row.nextAction, `adjacent locate ${ASSIGNMENT_ID}`);
  assert.equal(record.state, 'live');
});

test('assignment projection shows terminal-lost for a matching orphan process without a terminal', () => {
  const classification = makeClassification({
    piIdentity: PI_IDENTITY,
    attention: ['matching Pi process is alive without the exact recorded terminal; retaining the reservation'],
  });
  const row = project(makeRecord(), classification);
  assert.equal(row.display, 'terminal-lost');
  assert.match(row.nextAction, /^Do not relaunch/);
  assert.equal(row.hasControl, false);
});

test('assignment projection keeps unavailable probes and unknown classifications unknown, never ended', () => {
  const missing = project(makeRecord(), undefined);
  assert.equal(missing.display, 'unknown');
  assert.equal(missing.coverage, 'partial');
  assert.equal(missing.nextAction, 'Fix probe; no relaunch');

  const terminal = project(makeRecord(), makeClassification({
    state: 'launching',
    attention: ['terminal observation is unknown'],
  }));
  assert.equal(terminal.display, 'unknown');
  assert.equal(terminal.coverage, 'partial');

  const listing = project(makeRecord(), makeClassification({
    attention: ['process listing is incomplete; assignment UUID absence cannot be confirmed'],
  }));
  assert.equal(listing.display, 'unknown');
});

test('assignment projection keeps ended and launch-failed records terminal when no positive process evidence exists', () => {
  const ended = project(makeRecord({ state: 'ended' }), makeClassification({ state: 'ended', piIdentity: null }));
  assert.equal(ended.display, 'ended');
  assert.equal(ended.recordedState, 'ended');
  assert.equal(ended.nextAction, 'History');
  assert.equal(ended.unrecorded, false);

  const failed = project(makeRecord({ state: 'launch_failed' }), makeClassification({ state: 'launch_failed', piIdentity: null }));
  assert.equal(failed.display, 'launch-failed');
  assert.equal(failed.nextAction, 'History');
  assert.equal(failed.unrecorded, false);
});

test('assignment projection surfaces a terminal record contradicted by matching live evidence as unknown', () => {
  for (const state of ['ended', 'launch_failed']) {
    const classification = makeClassification({
      state,
      attention: [`assignment state ${state} is terminal but live evidence was observed; refusing to revive it`],
    });
    const row = project(makeRecord({ state }), classification);
    assert.equal(row.recordedState, state);
    assert.equal(row.display, 'unknown');
    assert.equal(row.nextAction, 'Fix probe; no relaunch');
    assert.equal(row.unrecorded, false);
    assert.equal(row.coverage, 'partial');
    assert.equal(row.hasControl, false);
  }
});

test('assignment projection treats a retained live classification without matching identity as unknown', () => {
  const retained = makeClassification({
    piIdentity: null,
    attention: ['recorded Pi process 43210 is confirmed dead'],
  });
  const row = project(makeRecord(), retained);
  assert.equal(row.recordedState, 'live');
  assert.equal(row.observedState, 'live');
  assert.equal(row.display, 'unknown');
  assert.equal(row.nextAction, 'Fix probe; no relaunch');
  assert.equal(row.unrecorded, false);
  assert.equal(row.coverage, 'partial');
  assert.equal(row.quiet, false);

  const launching = project(makeRecord({ state: 'launching' }), retained);
  assert.equal(launching.display, 'unknown');
  assert.equal(launching.nextAction, 'Fix probe; no relaunch');
  assert.equal(launching.unrecorded, false);
});

test('assignment projection marks quiet only from successful finite activity metadata over 120 seconds', () => {
  const row = project(makeRecord(), makeClassification(), {
    activity: { ok: true, size: 128, mtime: NOW - QUIET_ACTIVITY_MS - 1 },
  });
  assert.equal(row.quiet, true);

  const boundary = project(makeRecord(), makeClassification(), {
    activity: { ok: true, size: 128, mtime: NOW - QUIET_ACTIVITY_MS },
  });
  assert.equal(boundary.quiet, false);
});

test('assignment projection never infers quiet from absent, failed, mismatched or transcript activity', () => {
  const live = makeClassification({ sessionFile: '/sessions/one.jsonl' });
  const staleMtime = NOW - QUIET_ACTIVITY_MS - 1;
  const cases = [
    project(makeRecord(), live),
    project(makeRecord(), live, { activity: { ok: false, size: 1, mtime: staleMtime } }),
    project(makeRecord(), live, { activity: { ok: true, mtime: staleMtime } }),
    project(makeRecord(), live, { activity: { ok: true, size: Number.NaN, mtime: staleMtime } }),
    project(makeRecord(), live, { activity: { ok: true, size: 1, mtime: 'not-a-date' } }),
    project(makeRecord(), live, { activity: { ok: true, size: 1, mtime: staleMtime, assignment_id: OTHER_ID } }),
    project(makeRecord(), live, { activity: { ok: true, size: 1, mtime: staleMtime, session_file: '/sessions/other.jsonl' } }),
    project(makeRecord(), live, { activity: { ok: true, text: 'transcript text only' } }),
    project(makeRecord({ state: 'ended' }), makeClassification(), { activity: { ok: true, size: 1, mtime: staleMtime } }),
  ];
  for (const row of cases) assert.equal(row.quiet, false);
});

test('assignment projection exposes attached count as information that never grants control', () => {
  const fromRecord = project(makeRecord({ attached: 3 }), makeClassification());
  assert.equal(fromRecord.attachedCount, 3);
  assert.equal(fromRecord.hasControl, false);
  assert.equal(fromRecord.nextAction, 'Attach command');

  const fromActivity = project(makeRecord(), makeClassification(), {
    activity: { ok: true, size: 1, mtime: NOW, clients: 2 },
  });
  assert.equal(fromActivity.attachedCount, 2);
  assert.equal(fromActivity.hasControl, false);
});

test('assignment projection links an exited coordinator run with lease conditions to workers-unconfirmed', () => {
  const runs = [{
    workflow_id: WORKFLOW_ID,
    spec_package: SPEC_PACKAGE,
    assignment_id: ASSIGNMENT_ID,
    execution: 'failed',
    coverage: { reasons: ['lease-missing'] },
  }];
  const row = project(makeRecord(), makeClassification(), { runs });
  assert.equal(row.workersUnconfirmed, true);
  assert.equal(row.nextAction, 'Inspect recorded workers');
  assert.ok(row.attention.includes('workers-unconfirmed'));
  assert.ok(row.attention.includes('lease-missing'));
});

test('assignment projection adds workers-unconfirmed when the coordinator exited while its run still shows running', () => {
  const runs = [{
    workflow_id: WORKFLOW_ID,
    spec_package: SPEC_PACKAGE,
    execution: 'running',
    coverage: { reasons: ['lease-revoked'] },
  }];
  const row = project(makeRecord({ state: 'ended' }), makeClassification({ state: 'ended', piIdentity: null }), { runs });
  assert.equal(row.display, 'ended');
  assert.equal(row.workersUnconfirmed, true);
  assert.equal(row.nextAction, 'Inspect recorded workers');
});

test('assignment projection does not claim workers-unconfirmed without a joined lease condition', () => {
  const makeRuns = run => [{ workflow_id: WORKFLOW_ID, spec_package: SPEC_PACKAGE, ...run }];
  const runningLease = project(makeRecord(), makeClassification(), {
    runs: makeRuns({ execution: 'running', coverage: { reasons: ['lease-missing'] } }),
  });
  assert.equal(runningLease.workersUnconfirmed, false);

  const noLease = project(makeRecord(), makeClassification(), {
    runs: makeRuns({ execution: 'failed', coverage: { reasons: ['receipt-stale'] } }),
  });
  assert.equal(noLease.workersUnconfirmed, false);

  const otherWorkflow = project(makeRecord(), makeClassification(), {
    runs: [{ workflow_id: 'workflow-other', spec_package: SPEC_PACKAGE, execution: 'failed', coverage: { reasons: ['lease-missing'] } }],
  });
  assert.equal(otherWorkflow.workersUnconfirmed, false);

  const otherPackage = project(makeRecord(), makeClassification(), {
    runs: [{ workflow_id: WORKFLOW_ID, spec_package: '/repo/packages/beta', execution: 'failed', coverage: { reasons: ['lease-missing'] } }],
  });
  assert.equal(otherPackage.workersUnconfirmed, false);

  const otherAssignment = project(makeRecord(), makeClassification(), {
    runs: makeRuns({ assignment_id: OTHER_ID, execution: 'failed', coverage: { reasons: ['lease-missing'] } }),
  });
  assert.equal(otherAssignment.workersUnconfirmed, false);
});

test('assignment projection preserves the full assignment id and never mutates its inputs', () => {
  const record = Object.freeze(makeRecord());
  const classification = Object.freeze(makeClassification());
  const activity = Object.freeze({ ok: true, size: 1, mtime: NOW - QUIET_ACTIVITY_MS - 1 });
  const runs = Object.freeze([
    Object.freeze({
      workflow_id: WORKFLOW_ID,
      spec_package: SPEC_PACKAGE,
      execution: 'failed',
      coverage: Object.freeze({ reasons: Object.freeze(['lease-missing']) }),
    }),
  ]);
  const before = JSON.stringify(record);
  const row = project(record, classification, { activity, runs });
  assert.equal(row.assignment_id, ASSIGNMENT_ID);
  assert.equal(row.assignment_id.length, 36);
  assert.equal(row.quiet, true);
  assert.equal(JSON.stringify(record), before);
  assert.equal(record.state, 'live');
});
