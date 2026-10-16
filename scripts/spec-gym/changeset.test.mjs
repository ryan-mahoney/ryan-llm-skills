// Focused: node --test scripts/spec-gym/changeset.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCheck, scenarioVersion, gradeCell } from './core.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gym-grade-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const dir of ['graders','repo','package']) mkdirSync(join(root,dir));
  writeFileSync(join(root,'scenario.json'),JSON.stringify({id:'case',status:'draft'}));
  return root;
}
const check={id:'behavior',kind:'node-check',script:'graders/check.mjs',timeout_ms:1000};
test('external grader executes assertions against actual output and fails broken behavior', t=>{
  const root=fixture(t), roots={repo:join(root,'repo'),package:join(root,'package')};
  writeFileSync(join(root,'graders/check.mjs'),"import {readFileSync} from 'node:fs'; import a from 'node:assert/strict'; a.equal(readFileSync(process.argv[2]+'/answer','utf8'),'42');");
  writeFileSync(join(root,'repo/answer'),'41'); assert.equal(evaluateCheck(check,roots,{scenarioFolder:root}).ok,false);
  writeFileSync(join(root,'repo/answer'),'42'); assert.equal(evaluateCheck(check,roots,{scenarioFolder:root}).ok,true);
});
test('grader edits change frozen scenario identity and symlinks cannot escape',t=>{
  const root=fixture(t); writeFileSync(join(root,'graders/check.mjs'),'process.exit(0)'); const before=scenarioVersion(root);
  writeFileSync(join(root,'graders/check.mjs'),'process.exit(1)'); assert.notEqual(scenarioVersion(root),before);
  symlinkSync(join(root,'scenario.json'),join(root,'graders/link.mjs'));
  assert.equal(evaluateCheck({...check,script:'graders/link.mjs'},{repo:join(root,'repo')},{scenarioFolder:root}).ok,false);
  assert.equal(evaluateCheck({...check,script:'../outside.mjs'},{repo:join(root,'repo')},{scenarioFolder:root}).ok,false);
});
test('grader deadline terminates an infinite assertion process', t=>{
  const root=fixture(t); writeFileSync(join(root,'graders/check.mjs'),'while(true){}');
  assert.equal(evaluateCheck({...check,timeout_ms:100},{repo:join(root,'repo'),package:join(root,'package')},{scenarioFolder:root}).ok,false);
});
test('execution failure cannot be relabeled passed by successful file checks',()=>{
  const result=gradeCell({outcome:'failed',reason:'model output invalid'}, {scenario:{driver:'changeset',checks:[]}},{});
  assert.equal(result.outcome,'failed'); assert.equal(result.reason,'model output invalid');
});

test('campaign snapshot survives later runtime, skill, input and grader edits', async t => {
  const { createRun, freezeManifest, materializeCell } = await import('./runner.mjs');
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const root = fixture(t), repo = join(root, 'source');
  const scenario = join(repo, 'scenarios/spec-test/case');
  for (const path of ['scripts/changeset', 'scripts/spec-gym', 'skills/spec-test', 'scenarios/spec-test/case/input/repository', 'scenarios/spec-test/case/input/package', 'scenarios/spec-test/case/graders']) mkdirSync(join(repo, path), { recursive: true });
  const put = (p, text) => writeFileSync(join(repo, p), text);
  put('skills/spec-test/SKILL.md', 'frozen skill');
  put('scripts/changeset/gym-worker.mjs', '// frozen worker');
  put('scripts/spec-gym/core.mjs', '// frozen driver');
  put('scenarios/spec-test/case/input/repository/answer', '42');
  put('scenarios/spec-test/case/input/package/spec.md', 'Keep answer 42');
  put('scenarios/spec-test/case/input/project-context.md', '# Fixture');
  put('scenarios/spec-test/case/graders/check.mjs', 'process.exit(0)');
  put('scenarios/spec-test/case/scenario.json', JSON.stringify({ id: 'case', skill: 'spec-test', driver: 'changeset', status: 'ready', fixture: { feature: 'case' }, task: 'Keep answer', checks: [check] }));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']);
  const run = createRun({ repoRoot: repo, root: join(root, 'runs'), skill: 'spec-test', scenarios: [scenario], models: ['test/model'], timeoutMs: 1000, pi: '/bin/false' });
  freezeManifest(run);
  put('scripts/changeset/gym-worker.mjs', '// changed worker');
  put('skills/spec-test/SKILL.md', 'changed skill');
  put('scenarios/spec-test/case/input/repository/answer', 'wrong');
  put('scenarios/spec-test/case/graders/check.mjs', 'process.exit(1)');
  const cell = await materializeCell(run, run.cells[0], run.scenarios[0]);
  assert.equal(readFileSync(join(cell.repoDir, 'answer'), 'utf8'), '42');
  assert.equal(readFileSync(join(run.runtimeRoot, 'scripts/changeset/gym-worker.mjs'), 'utf8'), '// frozen worker');
  assert.equal(readFileSync(join(run.skillDir, 'SKILL.md'), 'utf8'), 'frozen skill');
  assert.equal(evaluateCheck(check, { repo: cell.repoDir, package: cell.packageDir }, { scenarioFolder: run.scenarios[0].folder }).ok, true);
});
