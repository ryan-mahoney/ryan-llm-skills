// Run with: node --import tsx --test --test-name-pattern='readiness|starting|Ready|planning' src/readiness.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coverageConcern,
  READINESS,
  READINESS_ORDER,
  epicPlanningIncomplete,
  landedStatus,
  memberPlanning,
  nextToPlan,
  planningAssignmentFor,
  positivelyPrepared,
  specReadiness,
} from './readiness';
import type { WireRecord } from './model';

const preparedRow = (overrides: WireRecord = {}): WireRecord => ({
  workspace: 'fixture',
  package: '/store/projects/fixture/specs/ccs-01-command-proposals',
  package_ref: 'fixture/ccs-01-command-proposals',
  planned: true,
  step_count: 7,
  prepared: true,
  preparation: { outcome: 'prepared', reported_at: '2026-10-10T12:00:00Z', source: 'spec-prepare.md', read: 'ok', bytes: 120 },
  decision: null,
  receipts: [],
  worktree_recorded: null,
  proposal: true,
  critique: true,
  critique_recommended: true,
  ...overrides,
});

const memberFacts = (overrides: WireRecord = {}): WireRecord => ({
  prepared: false,
  decision: null,
  step_count: null,
  preparation: { outcome: 'missing' },
  receipts: [],
  worktree_recorded: null,
  ...overrides,
});

const proposal = (name: string, overrides: WireRecord = {}): WireRecord => ({
  name,
  status: 'proposed',
  package: name,
  workspace: 'w',
  planning: memberFacts(),
  requires: [],
  ...overrides,
});

const epic = (members: WireRecord[]): WireRecord => ({ workspace: 'w', members });

const assignment = (display: string, skill: string | null, id = 'a-1'): WireRecord => ({
  assignment_id: id,
  workspace: 'fixture',
  workspace_id: 'fixture',
  spec_package: 'fixture/ccs-01-command-proposals',
  display,
  skill,
});

test('readiness separates ready, waiting, incomplete, not-planned, decision and unknown facts', () => {
  assert.deepEqual(READINESS_ORDER, ['ready', 'planning', 'decision', 'waiting', 'incomplete', 'not-planned', 'unknown']);
  for (const state of READINESS_ORDER) {
    assert.ok(READINESS[state].label, state);
    assert.ok(READINESS[state].tone, state);
    assert.ok(READINESS[state].proposal, state);
  }

  const ready = specReadiness(preparedRow(), { coverage: { state: 'complete' } });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.label, 'Ready to implement');
  assert.equal(ready.tone, 'info');
  assert.equal(ready.launchable, true);
  assert.deepEqual(ready.waitingOn, []);
  assert.equal(ready.reason, null);

  const waiting = specReadiness(preparedRow(), { coverage: { state: 'complete' }, prerequisites: [{ name: 'super2', state: 'prepared' }] });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.label, 'Prepared · waiting');
  assert.equal(waiting.tone, 'neutral');
  assert.deepEqual(waiting.waitingOn, ['super2']);
  assert.equal(waiting.reason, 'Available when super2 is merged');
  // A waiting prerequisite is a concern the operator weighs; the action stays available.
  assert.equal(waiting.launchable, true);

  const incomplete = specReadiness(preparedRow({ prepared: false, preparation: { outcome: 'missing' } }), { coverage: { state: 'complete' } });
  assert.equal(incomplete.state, 'incomplete');
  assert.equal(incomplete.tone, 'warning');

  const notPlanned = specReadiness(preparedRow({ step_count: null, prepared: false, preparation: { outcome: 'missing' } }), { coverage: { state: 'complete' } });
  assert.equal(notPlanned.state, 'not-planned');

  // Planning entry shares the observed prerequisite truth: a prepared
  // dependency may plan before merge, unresolved or unknown dependencies refuse
  // entry, and incomplete coverage is advisory only.
  const notPlannedRow = preparedRow({ step_count: null, prepared: false, preparation: { outcome: 'missing' } });
  const planPrepared = specReadiness(notPlannedRow, { action: 'plan', coverage: { state: 'complete' }, prerequisites: [{ name: 'base', state: 'prepared' }] });
  assert.equal(planPrepared.state, 'not-planned');
  assert.equal(planPrepared.launchable, true);
  assert.equal(planPrepared.reason, null);
  const planWaiting = specReadiness(notPlannedRow, { action: 'plan', coverage: { state: 'complete' }, prerequisites: [{ name: 'base', state: 'unresolved' }] });
  assert.equal(planWaiting.launchable, false);
  assert.equal(planWaiting.reason, 'Waiting on base');
  const planUnknown = specReadiness(notPlannedRow, { action: 'plan', coverage: { state: 'complete' }, prerequisites: [{ name: 'base', state: 'unknown' }] });
  assert.equal(planUnknown.launchable, false);
  assert.equal(planUnknown.reason, 'base is not observed');
  const planUncovered = specReadiness(notPlannedRow, { action: 'plan', coverage: { state: 'partial' }, prerequisites: [{ name: 'base', state: 'prepared' }] });
  assert.equal(planUncovered.launchable, true);
  assert.equal(planUncovered.reason, null);
  assert.match(String(coverageConcern(notPlannedRow, { coverage: { state: 'partial' } })), /coverage is partial/);
  assert.equal(coverageConcern(notPlannedRow, { coverage: { state: 'complete' } }), null);

  const decision = specReadiness(preparedRow({ prepared: false, decision: { stage: 'specification', question: 'Choose the storage shape', recommendation: '', recorded_at: '2026-10-10T12:00:00Z', source: 'decision-required.md' } }), { coverage: { state: 'complete' } });
  assert.equal(decision.state, 'decision');
  assert.equal(decision.reason, 'Choose the storage shape');

  const unknown = specReadiness({ workspace: 'fixture', package: '/store/projects/fixture/specs/legacy' });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.launchable, false);
  assert.match(String(unknown.reason), /unavailable/);

  assert.equal(specReadiness({ workspace: 'fixture', package: '/store/projects/fixture/specs/gone', status: 'missing' }).state, 'no-package');
  assert.equal(specReadiness({ workspace: 'fixture' }).state, 'no-package');

  // Declared prerequisites survive partial observations: absent facts stay
  // unknown instead of authorizing implementation.
  const erased = specReadiness(preparedRow({ requires: ['base'] }), { coverage: { state: 'complete' }, prerequisites: [] });
  assert.equal(erased.state, 'waiting');
  assert.deepEqual(erased.waitingOn, ['base']);
  assert.equal(erased.reason, 'base is not observed');

  const partial = specReadiness(preparedRow({ requires: ['a', 'b'] }), { coverage: { state: 'complete' }, prerequisites: [{ name: 'a', state: 'landed' }] });
  assert.equal(partial.state, 'waiting');
  assert.deepEqual(partial.waitingOn, ['b']);

  // Prepared work never increases landed evidence.
  assert.equal(landedStatus('prepared'), false);
  assert.equal(landedStatus('published'), false);
  assert.equal(landedStatus('merged'), true);
  assert.equal(landedStatus('complete'), true);
  assert.equal(memberPlanning({ name: 'a', status: 'prepared' }), null);
  assert.equal(positivelyPrepared(memberPlanning({ name: 'a', status: 'prepared' })), false);
});

test('starting and planning follow live assignments; coverage is a concern on a Ready launch, not a gate', () => {
  const record = preparedRow();
  assert.equal(planningAssignmentFor(record, [assignment('ended', 'spec-end-to-end'), assignment('launch-failed', 'spec-architect-initial')]), null);

  const live = assignment('live', 'spec-end-to-end');
  assert.equal(planningAssignmentFor(record, [live])?.assignment_id, 'a-1');
  const starting = specReadiness(record, { assignments: [live] });
  assert.equal(starting.state, 'starting');
  assert.equal(starting.label, 'Implementation starting');
  assert.equal(starting.owner?.assignment_id, 'a-1');
  assert.equal(starting.launchable, false);

  const planning = specReadiness(record, { assignments: [assignment('live', 'spec-architect-initial')] });
  assert.equal(planning.state, 'planning');
  assert.equal(planning.tone, 'info');
  assert.equal(specReadiness(record, { assignments: [assignment('launching', 'spec-write')] }).state, 'planning');

  const partial = specReadiness(record, { coverage: { state: 'partial' } });
  assert.equal(partial.state, 'ready');
  assert.equal(partial.launchable, true);
  assert.match(String(partial.reason), /coverage is partial/);

  const absent = specReadiness(record);
  assert.equal(absent.state, 'ready');
  assert.equal(absent.launchable, true);
  assert.match(String(absent.reason), /coverage is unknown/);

  // Equal basenames under distinct canonical paths never join: the current
  // package keeps its action while the previous-path assignment owns nothing.
  const currentRecord: WireRecord = { workspace: 'w', package: '/storage/current/specs/foo', package_ref: '/storage/current/specs/foo' };
  const previousOwner: WireRecord = { assignment_id: 'a-9', workspace: 'w', workspace_id: 'w', spec_package: '/storage/previous/specs/foo', display: 'live', skill: 'spec-architect-initial' };
  assert.equal(planningAssignmentFor(currentRecord, [previousOwner]), null);
  const exactOwner: WireRecord = { assignment_id: 'a-10', workspace: 'w', workspace_id: 'w', spec_package: '/storage/current/specs/foo', display: 'live', skill: 'spec-architect-initial' };
  assert.equal(planningAssignmentFor(currentRecord, [exactOwner])?.assignment_id, 'a-10');
});

test('planning eligibility follows record order, positive preparation and landed prerequisites', () => {
  assert.equal(nextToPlan(epic([proposal('one'), proposal('two')]))?.name, 'one');

  // A legacy prepared status is not positive preparation, so the only candidate stays blocked.
  assert.equal(nextToPlan(epic([{ name: 'base', status: 'prepared' }, proposal('one', { requires: ['base'] })])), null);

  assert.equal(nextToPlan(epic([
    { name: 'base', status: 'prepared', planning: memberFacts({ prepared: true }) },
    proposal('one', { requires: ['base'] }),
  ]))?.name, 'one');
  assert.equal(nextToPlan(epic([{ name: 'base', status: 'merged' }, proposal('one', { requires: ['base'] })]))?.name, 'one');

  // A live owner hides its own row without blocking an independent member.
  const owner = { assignment_id: 'live-1', workspace: 'w', spec_package: 'one', display: 'live', skill: 'spec-architect-initial' };
  assert.equal(nextToPlan(epic([proposal('one'), proposal('two')]), [], [owner])?.name, 'two');

  // An observed decision keeps its member out of planning.
  assert.equal(nextToPlan(epic([
    proposal('one', { planning: memberFacts({ decision: { stage: 'architecture', question: 'q', recorded_at: '2026-10-10T12:00:00Z' } }) }),
    proposal('two'),
  ]))?.name, 'two');

  // A positively prepared member is implementation work, not planning work.
  assert.equal(nextToPlan(epic([proposal('one', { planning: memberFacts({ prepared: true }) }), proposal('two')]))?.name, 'two');

  // Producer-shaped resume: index present with a blocked report and no
  // receipts keeps legacy prepared status but incomplete planning facts.
  const blockedResume: WireRecord = { name: 'base', status: 'prepared', package: 'base', workspace: 'w', planning: { ...memberFacts(), prepared: false, step_count: 3, preparation: { outcome: 'blocked' } }, requires: [] };
  assert.equal(nextToPlan(epic([blockedResume]))?.name, 'base');

  // Resume exclusions hold: positive preparation, decisions, live owners and
  // execution history keep a legacy prepared member out of planning.
  const preparedPositive: WireRecord = { name: 'base', status: 'prepared', package: 'base', workspace: 'w', planning: { ...memberFacts(), prepared: true, step_count: 3 } , requires: [] };
  assert.equal(nextToPlan(epic([preparedPositive])), null);
  const resumeDecision: WireRecord = { name: 'base', status: 'prepared', package: 'base', workspace: 'w', planning: { ...memberFacts(), prepared: false, step_count: 3, preparation: { outcome: 'blocked' }, decision: { stage: 'architecture', question: 'q', recorded_at: '2026-10-10T12:00:00Z' } }, requires: [] };
  assert.equal(nextToPlan(epic([resumeDecision])), null);
  const resumeOwner = { assignment_id: 'live-2', workspace: 'w', spec_package: 'base', display: 'live', skill: 'spec-architect-initial' };
  assert.equal(nextToPlan(epic([blockedResume]), [], [resumeOwner]), null);
  const resumeHistory: WireRecord = { name: 'base', status: 'prepared', package: 'base', workspace: 'w', planning: { ...memberFacts(), prepared: false, step_count: 3, preparation: { outcome: 'blocked' }, receipts: [{ state: 'active' }] }, requires: [] };
  assert.equal(nextToPlan(epic([resumeHistory])), null);
});

test('epic planning incomplete counts only positive preparation or landed members', () => {
  assert.equal(epicPlanningIncomplete({ members: [] }), false);
  assert.equal(epicPlanningIncomplete({ members: [{ name: 'a', status: 'merged' }, { name: 'b', status: 'complete' }] }), false);
  assert.equal(epicPlanningIncomplete({ members: [{ name: 'a', status: 'prepared' }] }), true);
  assert.equal(epicPlanningIncomplete({ members: [{ name: 'a', status: 'proposed', planning: memberFacts({ prepared: true }) }] }), false);
  assert.equal(epicPlanningIncomplete({ members: [{ name: 'a', status: 'merged' }, { name: 'b', status: 'missing' }] }), true);
});
