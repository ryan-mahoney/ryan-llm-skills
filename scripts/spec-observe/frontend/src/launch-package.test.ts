// Focused unit coverage for the step-009 bound review corrections (F1-F4).
// Run with: node --import tsx --test src/launch-package.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalMemberOf,
  hostValueFor,
  nextPlannableMember,
  planningPlanFor,
  planningResultStopValue,
  planningStagesValue,
  planningStopValue,
  preparationValueFor,
  prerequisiteValueFor,
} from './launch-package';
import type { WireRecord } from './model';

test('F1: preparation uses planning facts with steps and report basis, never lifecycle flags', () => {
  const row: WireRecord = {
    workspace: 'fixture',
    package: '/store/fixture/specs/browser',
    package_ref: 'fixture/browser',
    planned: true,
    planned_at: '2026-10-10T12:00:00Z',
    execution: 'running',
    is_current_assignment: true,
    prepared: true,
    step_count: 7,
    preparation: { outcome: 'prepared', reported_at: '2026-10-10T12:00:00Z', source: 'spec-prepare.md', read: 'ok', bytes: 120 },
    decision: null,
    receipts: [],
  };
  const value = preparationValueFor(row, null);
  assert.match(value, /Prepared/);
  assert.match(value, /7 steps/);
  assert.match(value, /prepared/);
  assert.match(value, /spec-prepare\.md/);
  assert.doesNotMatch(value, /Planned 2026/);

  const incomplete: WireRecord = {
    workspace: 'fixture',
    package: '/store/fixture/specs/other',
    prepared: false,
    step_count: 0,
    preparation: { outcome: 'missing' },
    decision: null,
    receipts: [],
  };
  const incompleteValue = preparationValueFor(incomplete, null);
  assert.match(incompleteValue, /Preparation incomplete/);
  assert.match(incompleteValue, /0 steps/);

  const unknown = preparationValueFor({ workspace: 'fixture', package: '/x', planned: true, planned_at: '2026-10-10T12:00:00Z' }, null);
  assert.match(unknown, /not observed|unconfirmed|unknown/i);
  assert.doesNotMatch(unknown, /Planned 2026/);
});

test('F1: member planning fallback supplies the report basis when the snapshot row is inventory-only', () => {
  const row: WireRecord = { workspace: 'fixture', package: '/tmp/pkg', package_ref: 'fixture/browser', planned: true, planned_at: '2026-10-10T12:00:00Z' };
  const member: WireRecord = { name: 'browser', package: 'browser', workspace: 'fixture', planning: { prepared: true, step_count: 3, preparation: { outcome: 'prepared', reported_at: '2026-10-10T12:00:00Z', source: 'spec-prepare.md' }, decision: null, receipts: [] } };
  const value = preparationValueFor(row, member);
  assert.match(value, /Prepared/);
  assert.match(value, /3 steps/);
});

test('F2: prerequisites enumerate declared requires with readiness facts and stay unknown when unobserved', () => {
  const epic: WireRecord = {
    workspace: 'fixture',
    epic: 'demo',
    title: 'Demo epic',
    members: [
      { name: 'base', package: 'base', workspace: 'fixture', status: 'prepared', requires: [], planning: { prepared: true, step_count: 2, preparation: { outcome: 'prepared' }, decision: null, receipts: [] } },
      { name: 'browser', package: 'browser', workspace: 'fixture', status: 'prepared', requires: ['base'], planning: { prepared: true, step_count: 3, preparation: { outcome: 'prepared' }, decision: null, receipts: [] } },
    ],
  };
  const record: WireRecord = { workspace_id: 'fixture', package_ref: 'fixture/browser', skill: 'spec-end-to-end' };
  const found = canonicalMemberOf([epic], record, 'fixture/browser');
  assert.ok(found);
  assert.equal(prerequisiteValueFor(found), 'base: Ready to implement');

  const missing = canonicalMemberOf([epic], { workspace_id: 'fixture', package_ref: 'fixture/unknown' }, 'fixture/unknown');
  assert.equal(missing, null);
  assert.equal(prerequisiteValueFor(missing), 'Prerequisites not observed');

  const emptyEpic: WireRecord = { workspace: 'fixture', epic: 'demo', members: [{ name: 'solo', package: 'solo', workspace: 'fixture', requires: [] }] };
  const solo = canonicalMemberOf([emptyEpic], { workspace_id: 'fixture', package_ref: 'fixture/solo' }, 'fixture/solo');
  assert.equal(prerequisiteValueFor(solo), 'None declared');
});

test('F2: equal-named foreign members never supply prerequisite status', () => {
  const foreign: WireRecord = { workspace: 'other', epic: 'foreign', members: [{ name: 'browser', package: 'browser', workspace: 'other', status: 'merged', requires: [] }] };
  const local: WireRecord = { workspace: 'fixture', epic: 'demo', members: [{ name: 'browser', package: 'browser', workspace: 'fixture', status: 'prepared', requires: ['base'], planning: { prepared: true, step_count: 1, preparation: { outcome: 'prepared' }, decision: null, receipts: [] } }] };
  const record: WireRecord = { workspace_id: 'fixture', package_ref: 'fixture/browser', skill: 'spec-end-to-end' };
  const found = canonicalMemberOf([foreign, local], record, 'fixture/browser');
  assert.ok(found);
  assert.equal(found.epic.workspace, 'fixture');
});

test('F3: fresh architecture keeps its conditional critique stop instead of promising Prepared', () => {
  const record: WireRecord = { skill: 'spec-architect-initial' };
  const plan = planningPlanFor(record, { brief: '/spec-architect-initial Plan x.', instruction: 'Perform.' });
  assert.deepEqual(plan.stages, ['spec-architect-initial', 'spec-write']);
  assert.equal(plan.stop, 'prepared');
  assert.match(planningStagesValue(record, plan), /stops at Proposal if critique is recommended/);
  assert.equal(planningStopValue(record, plan), 'Prepared, or Proposal if critique is recommended');
});

test('F3: proposal-only briefs stay at Proposal and critics/write keep their resume plans', () => {
  const proposalOnly = planningPlanFor({ skill: 'spec-architect-initial' }, { brief: 'Stop at Proposal. This launch ends at the proposal; critique waits.', instruction: '' });
  assert.deepEqual(proposalOnly, { skill: 'spec-architect-initial', stages: ['spec-architect-initial'], stop: 'proposal' });
  assert.equal(planningStopValue({ skill: 'spec-architect-initial' }, proposalOnly), 'Proposal');

  const critics = planningPlanFor({ skill: 'spec-architect-critics' });
  assert.deepEqual(critics.stages, ['spec-architect-critics', 'spec-write']);
  const writer = planningPlanFor({ skill: 'spec-write' });
  assert.deepEqual(writer.stages, ['spec-write']);
  assert.equal(planningStopValue({ skill: 'spec-write' }, writer), 'Prepared spec');

  const criticsOnly = planningPlanFor({ skill: 'spec-architect-critics' }, { brief: 'This launch ends at the critique.', instruction: '' });
  assert.deepEqual(criticsOnly, { skill: 'spec-architect-critics', stages: ['spec-architect-critics'], stop: 'critique' });
  assert.equal(planningStopValue({ skill: 'spec-architect-critics' }, criticsOnly), 'critique.md');
});

// Focused unit coverage for the step-010 bound result corrections (F1-F4).
// Run with: node --import tsx --test src/launch-package.test.ts

test('step-010 F1: confirmed planning stop is planning-only and never promises no branch', () => {
  const record: WireRecord = { skill: 'spec-architect-initial', execution_dir: '/tmp/checkout-browser', execution_branch: 'plan-branch' };
  const plan = planningPlanFor(record, { brief: '/spec-architect-initial Plan x.', instruction: '' });
  const stop = planningResultStopValue(record, plan);
  assert.match(stop, /Prepared, or Proposal if critique is recommended/);
  assert.match(stop, /Planning only/);
  assert.doesNotMatch(stop, /No branch/);

  const proposal = planningPlanFor({ skill: 'spec-architect-initial' }, { brief: 'Stop here. This launch ends at the proposal; critique waits.', instruction: '' });
  const proposalStop = planningResultStopValue({ skill: 'spec-architect-initial' }, proposal);
  assert.match(proposalStop, /^Proposal\./);
  assert.doesNotMatch(proposalStop, /Prepared/);

  const criticsOnly = planningPlanFor({ skill: 'spec-architect-critics' }, { brief: 'This launch ends at the critique.', instruction: '' });
  assert.equal(
    planningResultStopValue({ skill: 'spec-architect-critics' }, criticsOnly),
    'critique.md. No spec, branch or pull request.',
  );
  const writer = planningPlanFor({ skill: 'spec-write' });
  assert.equal(
    planningResultStopValue({ skill: 'spec-write' }, writer),
    'Prepared spec, ready to implement. No branch, implementation or pull request.',
  );
});

test('step-010 F2: confirmed launch identity is excluded so the next independent member is offered', () => {
  const unprepared = (name: string): WireRecord => ({
    name, package: name, workspace: 'fixture', status: 'proposed', requires: [],
    planning: { prepared: false, step_count: 0, preparation: { outcome: 'missing' }, decision: null, receipts: [] },
  });
  const epic: WireRecord = { workspace: 'fixture', epic: 'demo', title: 'Demo epic', members: [unprepared('first'), unprepared('second')] };
  const record: WireRecord = { workspace_id: 'fixture', package_ref: 'fixture/first', skill: 'spec-architect-initial' };
  // Without the exclusion the shared owner would return the launched member
  // itself while its own assignment runs.
  const next = nextPlannableMember([epic], record, 'fixture/first', [], []);
  assert.ok(next);
  assert.equal(next.name, 'second');
});

test('step-010 F2: observed live owners pass through the shared eligibility owner', () => {
  const unprepared = (name: string): WireRecord => ({
    name, package: name, workspace: 'fixture', status: 'proposed', requires: [],
    planning: { prepared: false, step_count: 0, preparation: { outcome: 'missing' }, decision: null, receipts: [] },
  });
  const epic: WireRecord = { workspace: 'fixture', epic: 'demo', title: 'Demo epic', members: [unprepared('first'), unprepared('second')] };
  const record: WireRecord = { workspace_id: 'fixture', package_ref: 'fixture/first', skill: 'spec-architect-initial' };
  const liveSecond: WireRecord = { workspace_id: 'fixture', spec_package: 'second', display: 'live', skill: 'spec-end-to-end' };
  // The launched first member is excluded by identity and the live second
  // member by its observed owner: nothing independent remains.
  assert.equal(nextPlannableMember([epic], record, 'fixture/first', [], [liveSecond]), null);
  // Without the confirmed launch the first member stays eligible: launching
  // the second member offers the first instead.
  const launchedSecond: WireRecord = { workspace_id: 'fixture', package_ref: 'fixture/second', skill: 'spec-architect-initial' };
  assert.equal(nextPlannableMember([epic], launchedSecond, 'fixture/second', [], [])?.name, 'first');
});

test('step-010 F4: execution host prefers a recorded fact and never presents the routing default', () => {
  assert.equal(hostValueFor({}), 'Host not recorded for this assignment');
  const fallback = hostValueFor({}, { kind: 'launched', assignmentId: 'abc' });
  assert.equal(fallback, 'Host not recorded for this assignment');
  assert.doesNotMatch(fallback, /Host default/);
  assert.equal(hostValueFor({ host: 'restory-box' }), 'restory-box');
  assert.equal(
    hostValueFor({}, { kind: 'launched', assignmentId: 'abc', assignment: { execution_host: 'restory-box' } }),
    'restory-box',
  );
});
