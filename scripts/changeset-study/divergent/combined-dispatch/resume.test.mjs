import test from 'node:test';
import assert from 'node:assert/strict';
import { remainingTrials } from './resume.mjs';

// node --test scripts/changeset-study/divergent/combined-dispatch/resume.test.mjs
test('explicit continuation selects only the four unpaid trials and refuses changed or already-started observations', () => {
  const campaign = { schedule: ['cal-base', 'cal-combined', 'handoff-combined', 'handoff-base', 'extract-base', 'extract-combined'].map(id => ({ id })) };
  const stopped = { completed: 2, rows: [{ id: 'cal-base' }, { id: 'cal-combined' }], stopped: 'audit map-order mismatch' };
  assert.deepEqual(remainingTrials(campaign, stopped, () => false).map(row => row.id), ['handoff-combined', 'handoff-base', 'extract-base', 'extract-combined']);
  assert.throws(() => remainingTrials(campaign, stopped, row => row.id === 'handoff-base'), /unstarted/);
  assert.throws(() => remainingTrials(campaign, { ...stopped, rows: [{ id: 'cal-base' }, { id: 'handoff-combined' }] }, () => false), /exactly two/);
  assert.throws(() => remainingTrials(campaign, { ...stopped, stopped: null }, () => false), /stopped/);
});
