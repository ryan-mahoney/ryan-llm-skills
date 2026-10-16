import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makePackageFixture } from '../../../pi/extensions/spec-runtime/package-fixture.mjs';
import { recordVerification, submitCompletion, revision } from '../../../pi/extensions/spec-runtime/completion.mjs';
import { assembleEvidence } from './assemble-evidence.mjs';

test('assembly preserves receipts and observed revisions, renders a blocked draft, and never fabricates acceptance', async t => {
  const f = await makePackageFixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const pkg = f.packagePath, step = join(pkg, 'step-001-subspec.md');
  mkdirSync(join(pkg, 'runtime/runs'), { recursive: true });
  mkdirSync(join(pkg, 'evidence')); mkdirSync(join(pkg, 'reviews'));
  writeFileSync(step, 'Prepared step'); writeFileSync(join(pkg, 'spec.md'), '# Example');
  writeFileSync(join(pkg, 'context.md'), 'Context');
  writeFileSync(join(pkg, 'evidence/result.txt'), 'Behavior observed');
  writeFileSync(join(pkg, 'reviews/step-001-review.md'), 'verdict: pass\n');
  writeFileSync(join(pkg, 'spec-steps.json'), JSON.stringify({ steps: [{ step: 1, name: 'Example' }] }));
  const gate = { id: 'EV-1', ownerStep: 1, phase: 'merge', required: true, kind: 'test', command: 'check behavior', claims: ['CL-1'], rejects: ['FH-1'],
    artifact: 'evidence/result.txt', environment: 'isolated', effects: 'none', authorization: 'local test' };
  writeFileSync(join(pkg, 'evidence-plan.json'), JSON.stringify({ version: 2, spec: 'spec.md', context: { path: 'context.md' },
    posture: { boundaries: [], qaMode: 'automated' }, failureHypotheses: [{ id: 'FH-1' }], gates: [gate],
    claims: [{ id: 'CL-1', phase: 'merge', statement: 'Behavior works', requirements: ['AC-1'], gates: ['EV-1'] }] }));
  const r = { id: 'run-1', package: pkg, checkout: f.repo, step, completion_contract: 1, launch_token: 'NEVER_COPY_THIS' };
  writeFileSync(join(pkg, 'runtime/runs/run-1.json'), JSON.stringify(r));
  const rev = revision(r);
  const receipt = recordVerification(r, 'check behavior', rev, rev, { exit_code: 0, full_output_path: join(pkg, 'evidence/result.txt') }, { elapsed_ms: 12 });
  submitCompletion(r, { outcome: 'as-specified', strategy: 'implementation-first', decisions: [], gaps: [], findings: [], introduced: [],
    evidence: [{ id: 'EV-1', status: 'passed', receipt_id: receipt.id, proof_boundary: 'Isolated fixture only' }] });
  writeFileSync(join(pkg, 'runtime/progress.json'), JSON.stringify({ runs: [{ run_id: r.id, step }] }));
  let result = await assembleEvidence(pkg, f.locations, { base: 'HEAD' });
  assert.equal(result.tour.gates[0].status, 'passed');
  assert.equal(result.tour.verdict, 'blocked');
  assert.equal(result.tour.claims[0].status, 'unproven');
  assert.equal(result.facts.observations[0].commands[0].receipt.elapsed_ms, 12);
  assert.equal(result.facts.observations[0].commands[0].receipt.artifact.startsWith('runtime/runs/'), true);
  assert.doesNotMatch(JSON.stringify(result), /NEVER_COPY_THIS/);
  assert.equal(result.facts.reviews[0].recordedVerdict, 'pass');
  const draft = join(pkg, 'draft.json'), html = join(pkg, 'draft.html');
  writeFileSync(draft, JSON.stringify(result.tour));
  execFileSync(process.execPath, [new URL('./render-work-tour.mjs', import.meta.url).pathname, draft, html], { cwd: f.repo });
  assert.match(readFileSync(html, 'utf8'), /blocked/);
  execFileSync('git', ['-C', f.repo, 'commit', '--allow-empty', '-m', 'Change candidate']);
  result = await assembleEvidence(pkg, f.locations, { base: 'HEAD' });
  assert.equal(result.tour.gates[0].status, 'stale');
  assert.equal(result.tour.gates[0].observedCommit, rev.commit);
  assert.notEqual(result.tour.commit, rev.commit);
  rmSync(join(pkg, 'evidence/result.txt'));
  assert.equal((await assembleEvidence(pkg, f.locations, { base: 'HEAD' })).tour.gates[0].status, 'blocked');
  writeFileSync(join(pkg, 'learnings/step-001-learning.md'), 'Replaced by another attempt');
  result = await assembleEvidence(pkg, f.locations, { base: 'HEAD' });
  assert.equal(result.tour.gates[0].status, 'pending');
  assert.match(result.facts.gaps[0], /no current structured handoff/);
});
