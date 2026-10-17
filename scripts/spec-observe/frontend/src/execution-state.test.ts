import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectRecords, normalizeEnvelope, packageSummaries, type Envelope } from './model';
import { activeRun, attention } from './format';
import { candidateAttempts, executionCounts, executionSummary, waveSealedCount, waveIdentity, packageKey, packageMatchesKey, resolvePackageRecord, stepAttempts, stepRuns, waveExpanded } from './execution-state';
import { visibleSpecs } from './spec-state';

const snapshot = (fields: Record<string, unknown>): Envelope => ({ observers: [{ observer_id: 'o', state: 'observing', published_at: '2026-10-17T12:00:00Z', snapshot: { workspace: 'w', runs: [], ...fields } }] });
const run = (fields: Record<string, unknown> = {}) => ({ workspace: 'w', package: '/p', package_ref: 'w/p', execution: 'running', is_current_assignment: true, ...fields });
const summary = (fields: Record<string, unknown> = {}) => ({ mode: 'waves', phase: 'running', attention: true, step_count: 3, integrated_count: 1, active_count: 1, blocked_count: 1, queued_count: 0, waves: [{ wave_id: 'a', ordinal: 1, state: 'running', counts: { blocked: 1 }, members: [{ step: 2, phase: 'running' }, { step: 3, phase: 'blocked' }] }], steps: [], coverage: { state: 'complete', reasons: [], omitted: 0 }, ...fields });
// node --import tsx --test --test-name-pattern='aggregates concurrent siblings' src/execution-state.test.ts
test('aggregates concurrent siblings without hiding attention or changing package identity on worker turnover', () => {
  const records = collectRecords(snapshot({ runs: [run({ assignment_id: 'one', activity: 'Implementing', obligation: 'Keep obligation' }), run({ assignment_id: 'two', workflow_state: 'blocked' })], package_executions: [run({ execution_summary: summary() })] }));
  const aggregate = packageSummaries(records)[0];
  assert.equal(aggregate.key, JSON.stringify(['w', '/p', 'package-execution']));
  assert.equal(aggregate.obligation, 'Keep obligation');
  assert.equal(aggregate.run_records.length, 2);
  assert.equal(activeRun(aggregate), true);
  assert.equal(attention(aggregate), true);
  assert.equal(visibleSpecs(records, 'attention', '').length, 1);
  assert.equal(resolvePackageRecord([aggregate], records[0].key), aggregate);
  const next = packageSummaries(collectRecords(snapshot({ runs: [run({ assignment_id: 'three' })], package_executions: [run({ execution_summary: summary({ attention: false, blocked_count: 0, waves: [{ wave_id: 'a', ordinal: 1, state: 'running', members: [{step: 2, phase: 'running'}] }] }) })] })))[0];
  assert.equal(next.key, aggregate.key);
  assert.equal(attention(next), false);
  assert.equal(packageMatchesKey(next, records[0].key), true);
});
// node --import tsx --test --test-name-pattern='wave-only records' src/execution-state.test.ts
test('wave-only records remain visible and width one remains waves while serial choice stays flat', () => {
  const wave = { wave_id: 'solo', ordinal: 2, state: 'sealed', requested_width: 1, admitted_width: 1, members: [{step: 8, phase: 'sealed'}] };
  const records = collectRecords(snapshot({ package_executions: [run({ execution_summary: summary({ waves: [wave] }) })] }));
  assert.equal(visibleSpecs(records, 'active', '').length, 1);
  assert.equal(executionSummary(packageSummaries(records)[0])?.mode, 'waves');
  assert.equal(waveExpanded(wave), true);
  assert.equal(waveExpanded({state: 'integrated', observed: true}), false);
  assert.equal(waveExpanded({state: 'waiting_dependencies', observed: false}), false);
  assert.equal(executionSummary(run({execution_summary: summary({mode:'serial',waves:[]})}))?.mode, 'serial');
});
// node --import tsx --test --test-name-pattern='corrupt wave observations' src/execution-state.test.ts
test('corrupt wave observations stay unknown and recover without switching selection identity', () => {
  const bad = run({execution_summary: summary({waves:null, coverage:{state:'partial', reasons:['waves-unreadable'],omitted:2}})});
  assert.equal(executionSummary(bad)?.mode,'unknown');
  assert.equal(executionSummary(bad)?.coverage.state,'unknown');
  assert.ok(executionSummary(bad)?.coverage.reasons.includes('waves-unreadable'));
  assert.equal(packageKey(bad), packageKey(run({execution_summary:summary()})));
});
// node --import tsx --test --test-name-pattern='manual completion and planned' src/execution-state.test.ts
test('manual completion and planned inventory retain their partitions despite package execution summaries', () => {
  const records = collectRecords(snapshot({ runs: [run()], recently_completed: [run({completed_at:'2026-10-17T12:00:00Z',completion_basis:'manual'})], package_executions:[run({visibility:'recently_completed',execution_summary:summary({phase:'complete'})}),run({package:'/future',visibility:'planned',execution_summary:summary({phase:'planned'})}),run({package:'/old',visibility:'completed',execution_summary:summary({phase:'complete'})})], planned_packages:[run({package:'/future'})] }));
  assert.equal(visibleSpecs(records,'active','').length,0);
  assert.equal(visibleSpecs(records,'completed','')[0].completion_basis,'manual');
  assert.equal(visibleSpecs(records,'ready','')[0].package,'/future');
  assert.equal(records.some(row=>row.package==='/old'),false);
});
// node --import tsx --test --test-name-pattern='repeated package timing' src/execution-state.test.ts
test('repeated package timing produces one attempt with its recorded owner and retains legacy flat position', () => {
  const attempts = [{ step: 3, assignment_id: 'one', started_at: '2026-10-17T12:00:00Z', state:'running', attempt_kind:'implementation' }];
  const aggregate = packageSummaries(collectRecords(snapshot({ runs:[run({assignment_id:'one',timing:{attempts}}),run({assignment_id:'two',timing:{attempts}})] })))[0];
  assert.deepEqual(stepAttempts(aggregate,{step:3}),attempts);
  assert.deepEqual(stepRuns(aggregate,{step:3}).map(row=>row.assignment_id),['one']);
  assert.equal(executionSummary(aggregate),null);
  assert.equal(aggregate.run_records.length,2);
  assert.equal(executionCounts(run({execution_summary:summary({integrated_count:1, waves:[{members:[{phase:'sealed',integrated:true},{phase:'sealed'}]}]})})), '1 integrated · 1 sealed · 1 active · 1 blocked · 0 queued');
});

// node --import tsx --test --test-name-pattern='superseded attention' src/execution-state.test.ts
test('superseded attention remains history after a healthy successor and candidate work stays attached to its wave', () => {
  const healthy = summary({attention:false,blocked_count:0,waves:[{wave_id:'a',ordinal:1,state:'verifying',members:[{step:1,phase:'sealed'}]}]});
  const attempts=[{run_id:'checks',wave_id:'a',subject_kind:'candidate',step:null,phase:'command',started_at:'2026-10-17T12:00:00Z'}];
  const rows=collectRecords(snapshot({runs:[run({assignment_id:'old',is_current_assignment:false,execution:'failed',workflow_state:'blocked',incidents:[{state:'open'}],execution_summary:healthy}),run({assignment_id:'new',timing:{attempts},execution_summary:healthy})],package_executions:[run({visibility:'active',execution_summary:healthy})]}));
  const aggregate=packageSummaries(rows)[0];
  assert.equal(attention(aggregate),false);
  assert.equal(visibleSpecs(rows,'attention','').length,0);
  assert.deepEqual(candidateAttempts(aggregate,{wave_id:'a'}),attempts);
  assert.deepEqual(stepAttempts(aggregate,{step:1}),[]);
  assert.equal(waveSealedCount({state:'running',sealed_count:40,members:[{phase:'sealed'}]}),40);
  assert.equal(waveSealedCount({state:'integrated',sealed_count:40,members:[{phase:'sealed'}]}),0);
  assert.equal(packageSummaries(collectRecords(snapshot({runs:[run({is_current_assignment:false,execution:'completed',execution_summary:healthy})],package_executions:[run({visibility:'inactive',execution_summary:healthy})]})))[0].aggregate_active,false);
});

// node --import tsx --test --test-name-pattern='wave identity preserves' src/execution-state.test.ts
test('wave identity preserves planned admission and does not hide conflicting journals with duplicate ordinals', () => {
  const planned = {ordinal:2,wave_id:null};
  const observed = {ordinal:2,wave_id:'w2'};
  assert.equal(waveIdentity(planned,[planned]),waveIdentity(observed,[observed]));
  const conflict = {ordinal:2,wave_id:'retry'};
  assert.notEqual(waveIdentity(observed,[observed,conflict]),waveIdentity(conflict,[observed,conflict]));
});

// node --import tsx --test --test-name-pattern='malformed package execution imports' src/execution-state.test.ts
test('malformed package execution imports reject invalid collections and identities before collection', () => {
  for (const package_executions of [{}, [null], [{}], [run({workspace:3})], [run({package:''})], [run({package_ref:null})], [run({source_paths:[null]})], Array.from({length:10001},()=>run())]) {
    assert.throws(()=>normalizeEnvelope(snapshot({package_executions})),{message:'Invalid package executions.'});
  }
  // A malformed summary remains a visible unknown package observation.
  const imported=normalizeEnvelope(snapshot({package_executions:[run({execution_summary:'unreadable'})]}));
  const record=packageSummaries(collectRecords(imported))[0];
  assert.equal(executionSummary(record)?.mode,'unknown');
  assert.equal(executionSummary(record)?.coverage.state,'unknown');
  // Direct collector callers receive a defensive boundary as well.
  assert.equal(collectRecords(snapshot({runs:[run()],package_executions:{}})).length,1);
  assert.equal(collectRecords(snapshot({runs:[run()],package_executions:[null]})).length,1);
});
