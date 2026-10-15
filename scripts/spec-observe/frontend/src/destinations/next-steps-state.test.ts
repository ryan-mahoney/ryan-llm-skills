import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireRecord } from '../model';
import type { CatalogEntry } from '../scope';
import {
  filterCounts,
  freshScan,
  nextStepRows,
  nextStepsViewState,
  railCount,
  visibleRows,
} from './next-steps-state';
import type {
  NextStepRow,
  NextStepsContext,
  NextStepsFileRow,
  NextStepsFilter,
  NextStepsScan,
} from './next-steps-state';

const ALPHA: CatalogEntry = { id: 'kit-alpha', directory: '/store/projects/alpha-dir', name: 'Alpha workspace' };
const BETA: CatalogEntry = { id: 'kit-beta', directory: '/store/projects/beta-dir', name: 'Beta workspace' };
const ALPHA_WS = 'alpha-dir';
const ALPHA_PKG = '/store/projects/alpha-dir/specs/shared';
const WRITTEN = '2026-01-02T03:00:00.000Z';
const SCANNED = '2026-01-02T03:05:00.000Z';
const NOW = Date.parse('2026-01-02T03:05:30.000Z');
const STALE_NOW = Date.parse('2026-01-02T03:08:00.000Z');

const packageRow = (overrides: Partial<NextStepsFileRow> = {}): NextStepsFileRow => ({
  key: JSON.stringify([ALPHA.id, 'package', 'shared']),
  kind: 'package',
  workspace_id: ALPHA.id,
  workspace: ALPHA_WS,
  workspace_name: 'Alpha checkout',
  slug: 'shared',
  package: ALPHA_PKG,
  stage: 'proposal',
  file: 'proposal.md',
  path: 'specs/shared/proposal.md',
  written_at: WRITTEN,
  observed_files: [{ name: 'proposal.md', stage: 'proposal', written_at: WRITTEN }],
  signal: { state: 'ok', verdict: 'COMPATIBLE', critique_recommended: false },
  ...overrides,
});

const scanOf = (rows: NextStepsFileRow[], overrides: Partial<NextStepsScan> = {}): NextStepsScan => ({
  schema_version: 1,
  scanned_at: SCANNED,
  window_ms: 604800000,
  coverage: { state: 'complete', reasons: [], workspaces: { read: 2, total: 2 }, unread: [] },
  rows,
  ...overrides,
});

const packageRecord = (overrides: WireRecord = {}): WireRecord => ({
  key: 'alpha-record',
  workspace: ALPHA_WS,
  package: ALPHA_PKG,
  planned: true,
  targets: [{ id: 'primary', primary: '/store/projects/alpha-dir' }],
  assignment_coverage: { state: 'complete' },
  ...overrides,
});

const readyContext = (overrides: Partial<NextStepsContext> = {}): NextStepsContext => ({
  live: true,
  connectionFailed: false,
  token: 'action-token',
  now: NOW,
  ...overrides,
});

const rowFor = (rows: NextStepRow[], workspace: string): NextStepRow => {
  const row = rows.find(candidate => candidate.workspace === workspace);
  assert.ok(row, `a row for ${workspace}`);
  return row;
};

const heldPackageRow = (slug: string): NextStepsFileRow => packageRow({
  key: `${slug}-key`,
  slug,
  package: `/store/projects/alpha-dir/specs/${slug}`,
  stage: 'proposal',
  file: 'proposal.md',
  path: `specs/${slug}/proposal.md`,
  signal: { state: 'ok', verdict: 'COMPATIBLE', critique_recommended: true },
});

const heldRecord = (slug: string, overrides: WireRecord = {}): WireRecord => packageRecord({
  key: `${slug}-record`,
  package: `/store/projects/alpha-dir/specs/${slug}`,
  ...overrides,
});

const epicRow = (overrides: Partial<NextStepsFileRow> = {}): NextStepsFileRow => ({
  key: 'epic-trip', kind: 'epic', workspace_id: ALPHA.id, workspace: ALPHA_WS, workspace_name: 'Alpha checkout',
  slug: 'trip', stage: 'epic', file: 'epic.json', path: 'epics/trip/epic.json', written_at: WRITTEN,
  observed_files: [{ name: 'epic.json', stage: 'epic', written_at: WRITTEN }],
  signal: { state: 'ok' },
  ...overrides,
});

const proposedMember = (name: string): WireRecord => ({
  name, package: `/store/projects/alpha-dir/specs/${name}`, status: 'proposed', planning: { prepared: false },
});

test('fresh scan requires a valid observation time within two minutes of a finite now', () => {
  const scan = scanOf([]);
  const at = Date.parse(scan.scanned_at);
  assert.equal(freshScan(scan, at), true);
  assert.equal(freshScan(scan, at + 120000), true);
  assert.equal(freshScan(scan, at + 120001), false);
  assert.equal(freshScan(scan, Number.NaN), false);
  assert.equal(freshScan(scan, null), false);
  assert.equal(freshScan(null, at), false);
  assert.equal(freshScan(scanOf([], { scanned_at: 'not-a-date' }), at), false);
});

test('duplicate slug across workspaces never joins the other workspace record or assignment', () => {
  const alphaRow = packageRow({
    key: 'alpha-spec', slug: 'shared', package: ALPHA_PKG, stage: 'spec', file: 'spec.md',
    path: 'specs/shared/spec.md', signal: { state: 'ok' },
  });
  const betaRow = packageRow({
    key: 'beta-spec', workspace_id: BETA.id, workspace: 'beta-dir', workspace_name: 'Beta checkout',
    package: '/store/projects/beta-dir/specs/shared', slug: 'shared', stage: 'spec', file: 'spec.md',
    path: 'specs/shared/spec.md', signal: { state: 'ok' },
  });
  const betaRun = packageRecord({
    key: 'beta-run', workspace: 'beta-dir', package: '/store/projects/beta-dir/specs/shared',
    planned: false, execution: 'running', is_current_assignment: true,
  });
  const betaAssignment = {
    workspace_id: BETA.id, spec_package: '/store/projects/beta-dir/specs/shared',
    display: 'running', assignment_id: 'beta-assignment',
  };
  const rows = nextStepRows(scanOf([alphaRow, betaRow]), {
    records: [betaRun], assignments: [betaAssignment], catalog: [ALPHA, BETA], ...readyContext(),
  });
  const alpha = rowFor(rows, ALPHA_WS);
  const beta = rowFor(rows, 'beta-dir');
  assert.equal(alpha.record, null);
  assert.equal(alpha.running, null);
  assert.equal(alpha.step.id, 'open-spec');
  assert.equal(alpha.step.reason, 'Readiness unknown');
  assert.deepEqual(alpha.step.route, { dest: 'specs', ws: ALPHA.id, filter: 'ready', q: 'shared' });
  assert.equal(beta.record?.key, 'beta-run');
  assert.equal(beta.step.id, 'open-agent');
});

test('a kit-id-only assignment is projected onto its catalog directory for the matching workspace', () => {
  const row = heldPackageRow('owned');
  const assignment = {
    workspace_id: ALPHA.id, spec_package: '/store/projects/alpha-dir/specs/owned',
    display: 'running', assignment_id: 'alpha-assignment',
  };
  const rows = nextStepRows(scanOf([row]), { assignments: [assignment], catalog: [ALPHA, BETA], ...readyContext() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record, null);
  assert.equal(rows[0].running?.workspace, ALPHA_WS);
  assert.equal(rows[0].running?.assignment_id, 'alpha-assignment');
  assert.equal(rows[0].step.id, 'open-agent');
  assert.equal(rows[0].step.kind, 'navigate');
  assert.deepEqual(rows[0].step.route, { dest: 'agents', ws: ALPHA.id, q: 'alpha-assignment' });
  assert.equal(rows[0].held, null);
  assert.ok([rows[0].step, ...rows[0].secondary].every(action => action.kind === 'navigate'));
});

test('a conflicting assignment identity stays unmatched and its launches stay held', () => {
  const row = packageRow({
    key: 'alpha-conflict', slug: 'conflict', package: '/store/projects/alpha-dir/specs/conflict',
    stage: 'proposal', file: 'proposal.md', path: 'specs/conflict/proposal.md',
    signal: { state: 'ok', verdict: 'COMPATIBLE', critique_recommended: false },
  });
  const assignment = {
    workspace_id: BETA.id, spec_package: '/store/projects/alpha-dir/specs/conflict',
    display: 'running', assignment_id: 'beta-assignment',
  };
  const rows = nextStepRows(scanOf([row]), { assignments: [assignment], catalog: [ALPHA, BETA], ...readyContext() });
  assert.equal(rows[0].running, null);
  assert.equal(rows[0].step.id, 'write-spec');
  assert.equal(rows[0].step.kind, 'held');
  assert.equal(rows[0].step.reason, 'This package has not been observed in a snapshot yet.');
});

test('an epic member owned by a kit-id assignment is excluded so Plan members selects the next unowned member', () => {
  const epic = { key: 'epic-key', workspace: ALPHA_WS, epic: 'trip', members: [proposedMember('owned'), proposedMember('later')] };
  const records = [
    packageRecord({ key: 'owned-record', package: '/store/projects/alpha-dir/specs/owned' }),
    packageRecord({ key: 'later-record', package: '/store/projects/alpha-dir/specs/later' }),
  ];
  const assignments = [{
    workspace_id: ALPHA.id, spec_package: '/store/projects/alpha-dir/specs/owned',
    display: 'running', assignment_id: 'owned-assignment',
  }];
  const rows = nextStepRows(scanOf([epicRow()]), { records, epics: [epic], assignments, catalog: [ALPHA, BETA], ...readyContext() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].running, null);
  assert.equal(rows[0].step.id, 'plan-members');
  assert.equal(rows[0].step.kind, 'launch');
  assert.equal(rows[0].step.filter, 'plan');
  assert.deepEqual(rows[0].step.planningPlan, { skill: 'spec-architect-initial', stages: ['spec-architect-initial', 'spec-write'], stop: 'prepared' });
  assert.deepEqual(rows[0].step.route, {
    dest: 'launch', ws: ALPHA.id, tab: 'brief', package: '/store/projects/alpha-dir/specs/later',
    skill: 'spec-architect-initial', stop: 'prepared',
  });
  assert.equal(rows[0].held, null);
});

test('an epic whose only eligible member is already owned holds Plan members without a package', () => {
  const epic = { key: 'epic-key', workspace: ALPHA_WS, epic: 'trip', members: [proposedMember('owned')] };
  const records = [packageRecord({ key: 'owned-record', package: '/store/projects/alpha-dir/specs/owned' })];
  const assignments = [{
    workspace_id: ALPHA.id, spec_package: '/store/projects/alpha-dir/specs/owned',
    display: 'running', assignment_id: 'owned-assignment',
  }];
  const rows = nextStepRows(scanOf([epicRow()]), { records, epics: [epic], assignments, catalog: [ALPHA], ...readyContext() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].running, null);
  assert.equal(rows[0].step.id, 'plan-members');
  assert.equal(rows[0].step.kind, 'held');
  assert.equal(rows[0].step.route, undefined);
  assert.equal(rows[0].step.reason, 'No eligible member is observed for planning.');
  assert.equal(rows[0].held, rows[0].step.reason);
});

test('an active run offers open agent with no launch anywhere and is excluded from the rail', () => {
  const row = heldPackageRow('running');
  const run = packageRecord({
    key: 'run-1', package: '/store/projects/alpha-dir/specs/running',
    planned: false, execution: 'running', is_current_assignment: true,
  });
  const rows = nextStepRows(scanOf([row]), { records: [run], catalog: [ALPHA], ...readyContext() });
  assert.equal(rows[0].step.id, 'open-agent');
  assert.equal(rows[0].step.kind, 'navigate');
  assert.equal(rows[0].step.route?.id, 'run-1');
  assert.deepEqual(rows[0].secondary.map(action => action.id), ['open-file']);
  assert.ok([rows[0].step, ...rows[0].secondary].every(action => action.kind === 'navigate' || action.kind === 'external'));
  assert.equal(rows[0].held, null);
  assert.equal(rows[0].running?.key, 'run-1');
  assert.equal(railCount(rows), 0);
});

test('recent completion and complete workflow subjects are removed from the rows', () => {
  const completed = packageRow({
    key: 'completed', slug: 'completed', package: '/store/projects/alpha-dir/specs/completed',
    stage: 'proposal', file: 'proposal.md', path: 'specs/completed/proposal.md',
  });
  const complete = packageRow({
    key: 'complete', slug: 'complete', package: '/store/projects/alpha-dir/specs/complete',
    stage: 'proposal', file: 'proposal.md', path: 'specs/complete/proposal.md',
  });
  const records = [
    packageRecord({ key: 'done-completed', package: '/store/projects/alpha-dir/specs/completed', recent_completion: true }),
    packageRecord({ key: 'done-complete', package: '/store/projects/alpha-dir/specs/complete', workflow_state: 'complete' }),
  ];
  assert.deepEqual(nextStepRows(scanOf([completed, complete]), { records, catalog: [ALPHA], ...readyContext() }), []);
});

test('a not-ready spec opens its exact ready row with the readiness label', () => {
  const row = packageRow({
    key: 'waiting-row', slug: 'waiting', package: '/store/projects/alpha-dir/specs/waiting',
    stage: 'spec', file: 'spec.md', path: 'specs/waiting/spec.md', signal: { state: 'ok' },
  });
  const record = packageRecord({
    key: 'waiting-record', package: '/store/projects/alpha-dir/specs/waiting',
    requires: ['base'], planning: { prepared: true },
  });
  const rows = nextStepRows(scanOf([row]), { records: [record], catalog: [ALPHA], ...readyContext() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record?.key, 'waiting-record');
  assert.equal(rows[0].step.id, 'open-spec');
  assert.equal(rows[0].step.kind, 'navigate');
  assert.equal(rows[0].step.filter, 'implement');
  assert.deepEqual(rows[0].step.route, { dest: 'specs', ws: ALPHA.id, filter: 'ready', id: 'waiting-record' });
  assert.equal(rows[0].step.reason, 'Prepared · waiting');
  assert.deepEqual(rows[0].secondary.map(action => action.id), ['open-file']);
  assert.equal(rows[0].held, null);
});

test('a ready launchable spec with every gate met offers implement spec as a launch', () => {
  const row = packageRow({
    key: 'ready-row', slug: 'ready-pkg', package: '/store/projects/alpha-dir/specs/ready-pkg',
    stage: 'spec', file: 'spec.md', path: 'specs/ready-pkg/spec.md', signal: { state: 'ok' },
  });
  const record = packageRecord({
    key: 'ready-record', package: '/store/projects/alpha-dir/specs/ready-pkg',
    planning: { prepared: true },
  });
  const rows = nextStepRows(scanOf([row]), { records: [record], catalog: [ALPHA], ...readyContext() });
  assert.equal(rows[0].step.id, 'implement-spec');
  assert.equal(rows[0].step.kind, 'launch');
  assert.equal(rows[0].step.filter, 'implement');
  assert.deepEqual(rows[0].step.route, { dest: 'launch', ws: ALPHA.id, tab: 'brief', package: '/store/projects/alpha-dir/specs/ready-pkg' });
  assert.equal(rows[0].step.planningPlan, undefined);
  assert.equal(rows[0].held, null);
  assert.deepEqual(rows[0].secondary.map(action => action.id), ['open-file']);
});

test('a missing action token holds every launch-family action while navigation stays available', () => {
  const rows = nextStepRows(scanOf([heldPackageRow('held-token')]), {
    records: [heldRecord('held-token')], catalog: [ALPHA],
    live: true, connectionFailed: false, token: null, now: NOW,
  });
  const { step, secondary, held } = rows[0];
  assert.equal(step.id, 'critique-proposal');
  assert.equal(step.kind, 'held');
  assert.equal(step.reason, 'This session has no action token; assignments are held.');
  assert.equal(step.filter, 'critique');
  assert.deepEqual(step.planningPlan, { skill: 'spec-architect-critics', stages: ['spec-architect-critics'], stop: 'critique' });
  assert.deepEqual(step.route, {
    dest: 'launch', ws: ALPHA.id, tab: 'brief', package: '/store/projects/alpha-dir/specs/held-token',
    skill: 'spec-architect-critics', stop: 'critique',
  });
  assert.equal(held, step.reason);
  assert.equal(secondary[0].id, 'write-spec');
  assert.equal(secondary[0].kind, 'held');
  assert.equal(secondary[0].reason, 'This session has no action token; assignments are held.');
  assert.equal(secondary[0].filter, 'spec');
  assert.deepEqual(secondary[0].planningPlan, { skill: 'spec-write', stages: ['spec-write'], stop: 'prepared' });
  assert.equal(secondary[1].id, 'open-file');
  assert.equal(secondary[1].kind, 'navigate');
});

test('offline and not-live contexts each hold every launch-family action', () => {
  const row = heldPackageRow('held-connection');
  const record = heldRecord('held-connection');
  const notLive = nextStepRows(scanOf([row]), {
    records: [record], catalog: [ALPHA], live: false, connectionFailed: false, token: 'action-token', now: NOW,
  });
  assert.equal(notLive[0].step.kind, 'held');
  assert.equal(notLive[0].step.reason, 'The live dashboard is required to start an assignment.');
  assert.equal(notLive[0].secondary[0].kind, 'held');
  assert.equal(notLive[0].secondary[0].reason, 'The live dashboard is required to start an assignment.');
  assert.equal(notLive[0].secondary[1].kind, 'navigate');

  const offline = nextStepRows(scanOf([row]), {
    records: [record], catalog: [ALPHA], live: true, connectionFailed: true, token: 'action-token', now: NOW,
  });
  assert.equal(offline[0].step.kind, 'held');
  assert.equal(offline[0].step.reason, 'The dashboard is offline; assignments are unavailable.');
  assert.equal(offline[0].secondary[0].kind, 'held');
  assert.equal(offline[0].secondary[0].reason, 'The dashboard is offline; assignments are unavailable.');
});

test('a stale scan holds every launch-family action', () => {
  const rows = nextStepRows(scanOf([heldPackageRow('held-stale')]), {
    records: [heldRecord('held-stale')], catalog: [ALPHA],
    live: true, connectionFailed: false, token: 'action-token', now: STALE_NOW,
  });
  assert.equal(rows[0].step.kind, 'held');
  assert.equal(rows[0].step.reason, 'The file scan is stale; refresh files before starting.');
  assert.equal(rows[0].secondary[0].kind, 'held');
  assert.equal(rows[0].secondary[0].reason, 'The file scan is stale; refresh files before starting.');
  assert.equal(rows[0].secondary[1].kind, 'navigate');
});

test('a record without usable targets holds every launch-family action', () => {
  const rows = nextStepRows(scanOf([heldPackageRow('held-targets')]), {
    records: [heldRecord('held-targets', { targets: [] })], catalog: [ALPHA], ...readyContext(),
  });
  assert.equal(rows[0].step.kind, 'held');
  assert.equal(rows[0].step.reason, 'No usable package target is available.');
  assert.equal(rows[0].secondary[0].kind, 'held');
  assert.equal(rows[0].secondary[0].reason, 'No usable package target is available.');
});

test('partial assignment coverage holds every launch-family action', () => {
  const rows = nextStepRows(scanOf([heldPackageRow('held-coverage')]), {
    records: [heldRecord('held-coverage', { assignment_coverage: { state: 'partial' } })], catalog: [ALPHA], ...readyContext(),
  });
  assert.equal(rows[0].step.kind, 'held');
  assert.equal(rows[0].step.reason, 'Assignment coverage is partial; assignments are held.');
  assert.equal(rows[0].secondary[0].kind, 'held');
  assert.equal(rows[0].secondary[0].reason, 'Assignment coverage is partial; assignments are held.');
});

test('filter counts classify held lifecycle actions while running and unreadable rows count only under all', () => {
  const proposalRecommended = packageRow({
    key: 'a', slug: 'a', package: '/store/projects/alpha-dir/specs/a', stage: 'proposal',
    file: 'proposal.md', path: 'specs/a/proposal.md',
    signal: { state: 'ok', verdict: 'COMPATIBLE', critique_recommended: true },
  });
  const proposalRunning = packageRow({
    key: 'b', slug: 'b', package: '/store/projects/alpha-dir/specs/b', stage: 'proposal',
    file: 'proposal.md', path: 'specs/b/proposal.md',
    signal: { state: 'ok', verdict: 'COMPATIBLE', critique_recommended: false },
  });
  const proposalUnreadable = packageRow({
    key: 'c', slug: 'c', package: '/store/projects/alpha-dir/specs/c', stage: 'proposal',
    file: 'proposal.md', path: 'specs/c/proposal.md',
    signal: { state: 'unreadable', reason: 'missing' },
  });
  const proposalDirect = packageRow({
    key: 'd', slug: 'd', package: '/store/projects/alpha-dir/specs/d', stage: 'proposal',
    file: 'proposal.md', path: 'specs/d/proposal.md',
    signal: { state: 'ok', verdict: 'COMPATIBLE', critique_recommended: false },
  });
  const specReady = packageRow({
    key: 'e', slug: 'e', package: '/store/projects/alpha-dir/specs/e', stage: 'spec',
    file: 'spec.md', path: 'specs/e/spec.md', signal: { state: 'ok' },
  });
  const workTour = packageRow({
    key: 'f', slug: 'f', package: '/store/projects/alpha-dir/specs/f', stage: 'work-tour',
    file: 'work-tour.json', path: 'specs/f/work-tour.json',
    signal: { state: 'ok', verdict: 'ready', gaps: 0 },
  });
  const epic: NextStepsFileRow = {
    key: 'g', kind: 'epic', workspace_id: ALPHA.id, workspace: ALPHA_WS, workspace_name: 'Alpha checkout',
    slug: 'trip', stage: 'epic', file: 'epic.json', path: 'epics/trip/epic.json', written_at: WRITTEN,
    observed_files: [{ name: 'epic.json', stage: 'epic', written_at: WRITTEN }],
    signal: { state: 'ok', members: ['/store/projects/alpha-dir/specs/g'], wave1: ['/store/projects/alpha-dir/specs/g'] },
  };
  const records = [
    packageRecord({ key: 'run-b', package: '/store/projects/alpha-dir/specs/b', planned: false, execution: 'running', is_current_assignment: true }),
    packageRecord({ key: 'ready-e', package: '/store/projects/alpha-dir/specs/e', planning: { prepared: true } }),
    packageRecord({ key: 'member-g', package: '/store/projects/alpha-dir/specs/g' }),
  ];
  const epics = [{
    key: 'epic-key', workspace: ALPHA_WS, epic: 'trip',
    members: [{ name: 'g', package: '/store/projects/alpha-dir/specs/g', status: 'proposed', planning: { prepared: false } }],
  }];
  const rows = nextStepRows(scanOf([proposalRecommended, proposalRunning, proposalUnreadable, proposalDirect, specReady, workTour, epic]), {
    records, epics, catalog: [ALPHA], live: true, connectionFailed: false, token: null, now: NOW,
  });
  assert.deepEqual(filterCounts(rows), { all: 7, plan: 1, critique: 1, spec: 1, implement: 1, review: 1 });
  assert.equal(railCount(rows), 5);
});

test('rail count respects workspace scope and ignores filter and query', () => {
  const alpha = packageRow({
    key: 'alpha-rail', slug: 'rail-a', package: '/store/projects/alpha-dir/specs/rail-a', stage: 'proposal',
    file: 'proposal.md', path: 'specs/rail-a/proposal.md',
  });
  const beta = packageRow({
    key: 'beta-rail', workspace_id: BETA.id, workspace: 'beta-dir', workspace_name: 'Beta checkout',
    slug: 'rail-b', package: '/store/projects/beta-dir/specs/rail-b', stage: 'proposal',
    file: 'proposal.md', path: 'specs/rail-b/proposal.md',
  });
  const alphaUnreadable = packageRow({
    key: 'alpha-bad', slug: 'rail-c', package: '/store/projects/alpha-dir/specs/rail-c', stage: 'proposal',
    file: 'proposal.md', path: 'specs/rail-c/proposal.md',
    signal: { state: 'unreadable', reason: 'missing' },
  });
  const alphaRunning = packageRow({
    key: 'alpha-run', slug: 'rail-d', package: '/store/projects/alpha-dir/specs/rail-d', stage: 'proposal',
    file: 'proposal.md', path: 'specs/rail-d/proposal.md',
  });
  const runningRecord = packageRecord({
    key: 'rail-run', package: '/store/projects/alpha-dir/specs/rail-d',
    planned: false, execution: 'running', is_current_assignment: true,
  });
  const rows = nextStepRows(scanOf([alpha, beta, alphaUnreadable, alphaRunning]), {
    records: [runningRecord], catalog: [ALPHA, BETA], scope: BETA.id, ...readyContext(),
  });
  assert.deepEqual(rows.map(row => row.workspace), ['beta-dir']);
  assert.equal(railCount(rows), 1);
  assert.deepEqual(visibleRows(rows, 'review', 'zzz'), []);
  assert.equal(railCount(rows), 1);
});

test('query matching is case insensitive over file slug workspace and human signal text only', () => {
  const row = packageRow({
    key: 'search', slug: 'searchable', package: '/store/projects/alpha-dir/specs/searchable',
    stage: 'proposal', file: 'proposal.md', path: 'specs/searchable/proposal.md',
    workspace_name: 'North star',
    signal: { state: 'ok', verdict: 'COMPATIBLE_WITH_CAVEATS', critique_recommended: false, summary: 'Handle storage eviction' },
  });
  const rows = nextStepRows(scanOf([row]), { catalog: [ALPHA], ...readyContext() });
  assert.deepEqual(visibleRows(rows, 'all', 'NORTH STAR').map(candidate => candidate.slug), ['searchable']);
  assert.deepEqual(visibleRows(rows, 'all', 'compatible_with_caveats').map(candidate => candidate.slug), ['searchable']);
  assert.deepEqual(visibleRows(rows, 'all', 'eviction').map(candidate => candidate.slug), ['searchable']);
  assert.deepEqual(visibleRows(rows, 'all', '2026-01-02').map(candidate => candidate.slug), []);
  assert.deepEqual(visibleRows(rows, 'review', ''), []);
  assert.deepEqual(visibleRows(rows, 'bogus' as NextStepsFilter, '').map(candidate => candidate.slug), ['searchable']);
});

test('a partial zero-row scan reads ideal with the partial banner and never complete empty', () => {
  const partialScan = scanOf([], {
    coverage: { state: 'partial', reasons: ['unreadable workspace'], workspaces: { read: 1, total: 2 }, unread: [{ workspace: 'beta-dir', reason: 'denied' }] },
  });
  const view = nextStepsViewState(partialScan, [], { token: 'action-token', now: NOW });
  assert.equal(view.read, 'ideal');
  assert.equal(view.partial, true);
  assert.equal(view.banner, 'partial');
});

test('an unavailable zero-row scan reads error while a complete zero-row scan reads empty', () => {
  const unavailable = scanOf([], {
    coverage: { state: 'unavailable', reasons: [], workspaces: { read: 0, total: null }, unread: [] },
  });
  const errorView = nextStepsViewState(unavailable, [], { token: 'action-token', now: NOW });
  assert.equal(errorView.read, 'error');
  assert.equal(errorView.partial, false);
  assert.equal(errorView.banner, null);

  const emptyView = nextStepsViewState(scanOf([]), [], { token: 'action-token', now: NOW });
  assert.equal(emptyView.read, 'empty');
  assert.equal(emptyView.partial, false);
  assert.equal(emptyView.banner, null);
});

test('rows with no filter or query match read filtered empty', () => {
  const scan = scanOf([packageRow({
    key: 'only-spec', slug: 'only-spec', package: '/store/projects/alpha-dir/specs/only-spec',
    stage: 'proposal', file: 'proposal.md', path: 'specs/only-spec/proposal.md',
    signal: { state: 'ok', verdict: 'COMPATIBLE', critique_recommended: false },
  })]);
  const rows = nextStepRows(scan, { catalog: [ALPHA], ...readyContext() });
  assert.equal(nextStepsViewState(scan, rows, { filter: 'review', q: '', token: 'action-token', now: NOW }).read, 'filtered-empty');
  assert.equal(nextStepsViewState(scan, rows, { filter: 'all', q: 'missing', token: 'action-token', now: NOW }).read, 'filtered-empty');
});

test('notice precedence is offline then stale then denied then partial', () => {
  const partialStale = scanOf([], {
    coverage: { state: 'partial', reasons: [], workspaces: { read: 1, total: 2 }, unread: [] },
  });
  assert.equal(nextStepsViewState(partialStale, [], { connectionFailed: true, token: null, now: STALE_NOW }).banner, 'offline');
  assert.equal(nextStepsViewState(partialStale, [], { connectionFailed: false, token: null, now: STALE_NOW }).banner, 'stale');
  assert.equal(nextStepsViewState(partialStale, [], { connectionFailed: false, token: null, now: NOW }).banner, 'denied');
  assert.equal(nextStepsViewState(partialStale, [], { connectionFailed: false, token: 'action-token', now: NOW }).banner, 'partial');
});

test('a null scan reads loading or error by connection failure', () => {
  const loading = nextStepsViewState(null, [], { token: 'action-token', connectionFailed: false });
  assert.equal(loading.read, 'loading');
  assert.equal(loading.offline, false);
  const failed = nextStepsViewState(null, [], { token: 'action-token', connectionFailed: true });
  assert.equal(failed.read, 'error');
  assert.equal(failed.offline, true);
  assert.equal(failed.banner, 'offline');
});
