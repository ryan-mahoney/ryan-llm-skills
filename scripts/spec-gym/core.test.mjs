import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWrite,
  comparisonLabel,
  contaminated,
  discoverSkills,
  evaluateCheck,
  gradeCell,
  indexDrift,
  loadScenario,
  renderIndex,
  renderReport,
  scenarioVersion,
  validateScenario,
} from './core.mjs';

// The documented example from .specs/super1-spec-gym/spec.md, "Scenario library contract".
const exampleScenario = () => ({
  id: 'missing-required-context',
  skill: 'spec-step-run',
  driver: 'managed-step',
  status: 'draft',
  purpose: 'The owner must request a missing consequential fact before implementing the dependent decision.',
  source: { summary: 'Extracted from a real step with a redacted package name', revision: 'abc123...' },
  fixture: { feature: 'example-feature', step: 1 },
  task: 'spec=.specs/example-feature/spec.md step=1',
  roles: { editor_model: 'provider/model', scout_model: 'provider/model' },
  timeout_ms: 1800000,
  expectation_sources: ['requirements.md item 3', 'context.md decision D-2'],
  checks: [
    { id: 'learning-written', kind: 'file-exists', root: 'package', path: 'learnings/step-001-learning.md' },
    { id: 'no-dependent-diff', kind: 'git-untouched', root: 'checkout', paths: ['src/billing.mjs'] },
    { id: 'owner-finished', kind: 'run-state', equals: 'completed' },
  ],
});

const preparedPackageNames = ['context.md', 'spec.md', 'spec-prepare.md', 'evidence-plan.json', 'spec-steps.json'];

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spec-gym-core-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function gitIn(repo) {
  return (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
}

function writeScenario(folder, scenario) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`);
}

function writeInput(folder) {
  const packageDir = join(folder, 'input', 'package');
  mkdirSync(packageDir, { recursive: true });
  for (const name of preparedPackageNames) {
    writeFileSync(join(packageDir, name), name === 'spec-steps.json' ? '{"steps":[{"step":1}]}\n' : `# ${name}\n`);
  }
  writeFileSync(join(packageDir, 'step-001-subspec.md'), '# Step 1 card\n');
  writeFileSync(join(folder, 'input', 'project-context.md'), 'Shared project context.\n');
}

function buildScenario(t, mutate = () => {}) {
  const root = fixture(t);
  const id = 'missing-required-context';
  const skill = 'spec-step-run';
  const folder = join(root, 'scenarios', skill, id);
  const scenario = exampleScenario();
  mutate(scenario);
  writeScenario(folder, scenario);
  writeInput(folder);
  return { root, folder, skill, id, scenario };
}

test('discovery lists only spec- skills and excludes non-eligible directories', t => {
  const skillsDir = join(fixture(t), 'skills');
  const addSkill = (name, withSkillFile) => {
    mkdirSync(join(skillsDir, name), { recursive: true });
    if (withSkillFile) writeFileSync(join(skillsDir, name, 'SKILL.md'), `# ${name}\n`);
  };
  addSkill('spec-a', true);
  addSkill('spec-b', false);
  addSkill('specops-x', true);
  addSkill('design-spec-y', true);
  assert.deepEqual(discoverSkills(skillsDir), ['spec-a']);
});

test('validation rejects invalid scenarios naming the file and rule', t => {
  const structural = [
    ['id mismatch', s => { s.id = 'other-id'; }, 'does not match folder'],
    ['unknown driver', s => { s.driver = 'other'; }, 'driver'],
    ['managed-step without fixture.step', s => { delete s.fixture.step; }, 'fixture.step'],
    ['managed-step without roles.editor_model', s => { delete s.roles.editor_model; }, 'roles.editor_model'],
    ['leaf with roles', s => { s.driver = 'leaf'; }, 'must not declare roles'],
    ['zero timeout', s => { s.timeout_ms = 0; }, 'timeout_ms'],
    ['unknown check kind', s => { s.checks[0].kind = 'other'; }, 'kind'],
  ];
  for (const [label, mutate, rule] of structural) {
    const { folder } = buildScenario(t, mutate);
    const result = validateScenario(folder);
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some(error => error.includes(rule)), `${label}: ${JSON.stringify(result.errors)}`);
  }

  const broken = [
    ['missing package directory', folder => rmSync(join(folder, 'input/package'), { recursive: true, force: true }), 'input/package'],
    ['missing project context', folder => rmSync(join(folder, 'input/project-context.md')), 'input/project-context.md'],
    ['missing prepared card input', folder => rmSync(join(folder, 'input/package/spec-prepare.md')), 'input/package/spec-prepare.md'],
    ['symlinked input file', folder => symlinkSync(join(folder, 'input/package/context.md'), join(folder, 'input/package/link.md')), 'symlink', 'input/package/link.md'],
  ];
  for (const [label, breakFixture, rule, detail] of broken) {
    const { folder } = buildScenario(t);
    breakFixture(folder);
    const result = validateScenario(folder);
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some(error => error.includes(rule)), `${label}: ${JSON.stringify(result.errors)}`);
    if (detail) assert.ok(result.errors.some(error => error.includes(detail)), `${label} path: ${JSON.stringify(result.errors)}`);
  }
});

test('validation accepts the documented example scenario as draft', t => {
  const { folder } = buildScenario(t);
  const result = validateScenario(folder);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test('validation requires every indexed step card and selected step membership', t => {
  const withIndex = steps => {
    const { folder } = buildScenario(t);
    writeFileSync(join(folder, 'input/package/spec-steps.json'), `${JSON.stringify({ steps: steps.map(step => ({ step })) })}\n`);
    return folder;
  };

  const complete = withIndex([1, 2]);
  writeFileSync(join(complete, 'input/package/step-002-subspec.md'), '# Step 2 card\n');
  const completeResult = validateScenario(complete);
  assert.equal(completeResult.ok, true, JSON.stringify(completeResult.errors));

  const missingIndexedCard = withIndex([1, 2]);
  const missingResult = validateScenario(missingIndexedCard);
  assert.equal(missingResult.ok, false);
  assert.ok(
    missingResult.errors.some(error => error.includes('input/package/step-002-subspec.md') && error.includes('indexed step card')),
    JSON.stringify(missingResult.errors),
  );

  const unindexedSelection = withIndex([2]);
  writeFileSync(join(unindexedSelection, 'input/package/step-002-subspec.md'), '# Step 2 card\n');
  const unindexedResult = validateScenario(unindexedSelection);
  assert.equal(unindexedResult.ok, false);
  assert.ok(
    unindexedResult.errors.some(error => error.includes('fixture.step 1') && error.includes('not indexed')),
    JSON.stringify(unindexedResult.errors),
  );
});

test('validation rejects non-object scenario.json and loadScenario names the file', t => {
  const { folder } = buildScenario(t);
  for (const [label, text] of [['null', 'null'], ['array', '[]'], ['string', '"scenario"']]) {
    writeFileSync(join(folder, 'scenario.json'), `${text}\n`);
    const result = validateScenario(folder);
    assert.equal(result.ok, false, label);
    assert.ok(
      result.errors.some(error => error.startsWith('scenario.json:') && error.includes('scenario must be a JSON object')),
      `${label}: ${JSON.stringify(result.errors)}`,
    );
  }

  assert.throws(
    () => loadScenario(folder),
    error => error.message.includes('scenario.json: invalid scenario.json (scenario must be a JSON object)'),
  );
});

test('ready scenario refuses untracked files empty expectations empty checks and todos', t => {
  const root = fixture(t);
  const skill = 'spec-step-run';
  const id = 'missing-required-context';
  const folder = join(root, 'scenarios', skill, id);
  const readyScenario = () => ({ ...exampleScenario(), status: 'ready' });
  writeScenario(folder, readyScenario());
  writeInput(folder);

  const git = gitIn(root);
  git('init', '-q');
  git('config', 'user.name', 'Spec Gym Core Test');
  git('config', 'user.email', 'spec-gym@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'Fixture');
  assert.equal(validateScenario(folder).ok, true);

  writeFileSync(join(folder, 'input/extra.md'), 'untracked fixture file\n');
  const untracked = validateScenario(folder);
  assert.equal(untracked.ok, false);
  assert.ok(
    untracked.errors.some(error => error.includes('input/extra.md') && error.includes('untracked')),
    JSON.stringify(untracked.errors),
  );

  git('add', join('scenarios', skill, id, 'input/extra.md'));
  assert.equal(validateScenario(folder).ok, true);

  const refused = [
    ['empty expectation_sources', scenario => { scenario.expectation_sources = []; }, 'expectation_sources'],
    ['empty checks', scenario => { scenario.checks = []; }, 'checks'],
    ['todo check', scenario => { scenario.checks = [...scenario.checks, { id: 'pending-check', kind: 'file-exists', root: 'package', path: 'learnings/step-001-learning.md', todo: true }]; }, 'todo'],
  ];
  for (const [label, mutate, rule] of refused) {
    const scenario = readyScenario();
    mutate(scenario);
    writeScenario(folder, scenario);
    const result = validateScenario(folder);
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some(error => error.includes(rule)), `${label}: ${JSON.stringify(result.errors)}`);
  }
});

test('version ignores status and tracks input bytes and checks', t => {
  const { folder, scenario } = buildScenario(t);
  const initial = scenarioVersion(folder);
  assert.match(initial, /^[0-9a-f]{64}$/);

  const inputFile = join(folder, 'input', 'package', 'context.md');
  const originalInput = readFileSync(inputFile);
  writeScenario(folder, { ...scenario, status: 'ready' });
  assert.equal(scenarioVersion(folder), initial);

  writeFileSync(inputFile, Buffer.concat([originalInput, Buffer.from('changed byte\n')]));
  assert.notEqual(scenarioVersion(folder), initial);

  writeFileSync(inputFile, originalInput);
  assert.equal(scenarioVersion(folder), initial);

  const changedCheck = { ...scenario.checks[0], path: 'learnings/step-002-learning.md' };
  writeScenario(folder, { ...scenario, checks: [changedCheck, ...scenario.checks.slice(1)] });
  assert.notEqual(scenarioVersion(folder), initial);

  const binaryFile = join(folder, 'input', 'package', 'binary.bin');
  writeFileSync(binaryFile, Buffer.from([0x80]));
  const firstByteVersion = scenarioVersion(folder);
  writeFileSync(binaryFile, Buffer.from([0x81]));
  assert.notEqual(scenarioVersion(folder), firstByteVersion);
});

test('index drift detected and cleared by atomicWrite with the fixed not-covered sentence', t => {
  const { root, folder, skill } = buildScenario(t);
  const typeFolder = join(root, 'scenarios', skill);
  const indexPath = join(typeFolder, 'scenarios.md');
  const stale = '# Scenarios: spec-step-run\nstale index\n';
  writeFileSync(indexPath, stale);

  const rendered = renderIndex(skill, [loadScenario(folder)]);
  const drift = indexDrift(skill, typeFolder);
  assert.equal(drift.same, false);
  assert.equal(drift.actual, stale);
  assert.equal(drift.expected, rendered);

  atomicWrite(indexPath, rendered);
  assert.equal(indexDrift(skill, typeFolder).same, true);
  assert.ok(rendered.trimEnd().endsWith('Scenarios in this index exercise only the listed purposes; behaviors absent from this table are not covered.'));

  for (const name of ['spec-architect-initial', 'spec-step-run']) {
    const committed = readFileSync(new URL(`../../scenarios/${name}/scenarios.md`, import.meta.url), 'utf8');
    assert.equal(committed, renderIndex(name, []));
  }
});

test('check file-exists and file-absent report present and missing paths', t => {
  const root = fixture(t);
  const packageDir = join(root, 'package');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'artifact.txt'), 'present\n');
  const roots = { package: packageDir, checkout: packageDir, repo: packageDir };
  const present = join(packageDir, 'artifact.txt');
  const missing = join(packageDir, 'missing.txt');

  const exists = evaluateCheck({ id: 'e1', kind: 'file-exists', root: 'package', path: 'artifact.txt' }, roots, {});
  assert.equal(exists.ok, true);
  assert.ok(exists.detail.includes(present), exists.detail);

  const existsMissing = evaluateCheck({ id: 'e2', kind: 'file-exists', root: 'package', path: 'missing.txt' }, roots, {});
  assert.equal(existsMissing.ok, false);
  assert.ok(existsMissing.detail.includes(missing), existsMissing.detail);

  const absent = evaluateCheck({ id: 'a1', kind: 'file-absent', root: 'package', path: 'missing.txt' }, roots, {});
  assert.equal(absent.ok, true);
  assert.ok(absent.detail.includes(missing), absent.detail);

  const absentPresent = evaluateCheck({ id: 'a2', kind: 'file-absent', root: 'package', path: 'artifact.txt' }, roots, {});
  assert.equal(absentPresent.ok, false);
  assert.ok(absentPresent.detail.includes(present), absentPresent.detail);
});

test('check line-1 matches only the first line', t => {
  const root = fixture(t);
  const packageDir = join(root, 'package');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'card.md'), 'header\n---\nbody\n');
  const roots = { package: packageDir, checkout: packageDir, repo: packageDir };

  assert.equal(evaluateCheck({ id: 'l1', kind: 'line-1', root: 'package', path: 'card.md', pattern: '^---$' }, roots, {}).ok, false);
  assert.equal(evaluateCheck({ id: 'l2', kind: 'line-1', root: 'package', path: 'card.md', pattern: '^header$' }, roots, {}).ok, true);
  assert.equal(evaluateCheck({ id: 'l3', kind: 'line-1', root: 'package', path: 'missing.md', pattern: '^header$' }, roots, {}).ok, false);
});

test('check text-match honors absent and fails on a missing file', t => {
  const root = fixture(t);
  const packageDir = join(root, 'package');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'notes.md'), 'target text\n');
  const roots = { package: packageDir, checkout: packageDir, repo: packageDir };

  assert.equal(evaluateCheck({ id: 't1', kind: 'text-match', root: 'package', path: 'notes.md', pattern: 'target' }, roots, {}).ok, true);
  assert.equal(evaluateCheck({ id: 't2', kind: 'text-match', root: 'package', path: 'notes.md', pattern: 'target', absent: true }, roots, {}).ok, false);
  assert.equal(evaluateCheck({ id: 't3', kind: 'text-match', root: 'package', path: 'notes.md', pattern: 'other', absent: true }, roots, {}).ok, true);
  assert.equal(evaluateCheck({ id: 't4', kind: 'text-match', root: 'package', path: 'missing.md', pattern: 'target' }, roots, {}).ok, false);
  assert.equal(evaluateCheck({ id: 't5', kind: 'text-match', root: 'package', path: 'missing.md', pattern: 'target', absent: true }, roots, {}).ok, false);
});

test('check json-equals compares by JSON.stringify at a pointer', t => {
  const root = fixture(t);
  const packageDir = join(root, 'package');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'state.json'), '{"steps":[{"difficulty":1}]}\n');
  const roots = { package: packageDir, checkout: packageDir, repo: packageDir };

  assert.equal(evaluateCheck({ id: 'j1', kind: 'json-equals', root: 'package', path: 'state.json', pointer: 'steps/0/difficulty', equals: 1 }, roots, {}).ok, true);
  assert.equal(evaluateCheck({ id: 'j2', kind: 'json-equals', root: 'package', path: 'state.json', pointer: 'steps/0/difficulty', equals: '1' }, roots, {}).ok, false);
  assert.equal(evaluateCheck({ id: 'j3', kind: 'json-equals', root: 'package', path: 'state.json', pointer: 'steps/0/missing', equals: 1 }, roots, {}).ok, false);
});

test('check git-untouched passes at the fixture commit and names edits', t => {
  const root = fixture(t);
  const repoDir = join(root, 'repo');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src/a.mjs'), 'export const a = 1;\n');
  const git = gitIn(repoDir);
  git('init', '-q');
  git('config', 'user.name', 'Spec Gym Core Test');
  git('config', 'user.email', 'spec-gym@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'Fixture');
  const fixtureCommit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const roots = { package: repoDir, checkout: repoDir, repo: repoDir };
  const context = { fixtureCommit, state: 'finished', driver: 'leaf' };
  const check = { id: 'g1', kind: 'git-untouched', root: 'repo', paths: ['src/a.mjs'] };

  assert.equal(evaluateCheck(check, roots, context).ok, true);

  writeFileSync(join(repoDir, 'src/a.mjs'), 'export const a = 2;\n');
  const edited = evaluateCheck(check, roots, context);
  assert.equal(edited.ok, false);
  assert.ok(edited.detail.includes('src/a.mjs'), edited.detail);

  git('add', 'src/a.mjs');
  git('commit', '-qm', 'Edit');
  const committed = evaluateCheck(check, roots, context);
  assert.equal(committed.ok, false);
  assert.ok(committed.detail.includes('src/a.mjs'), committed.detail);
});

test('check run-state equals the managed record state', () => {
  assert.equal(evaluateCheck({ id: 'r1', kind: 'run-state', equals: 'completed' }, {}, { state: 'completed', driver: 'managed-step' }).ok, true);
  assert.equal(evaluateCheck({ id: 'r2', kind: 'run-state', equals: 'failed' }, {}, { state: 'completed', driver: 'managed-step' }).ok, false);
  const leaf = evaluateCheck({ id: 'r3', kind: 'run-state', equals: 'completed' }, {}, { state: 'finished', driver: 'leaf' });
  assert.equal(leaf.ok, false);
  assert.ok(leaf.detail.includes('run-state requires managed-step'), leaf.detail);
});

test('contamination marks a grader read of the scenario folder invalid', t => {
  const root = fixture(t);
  const scenarioFolder = join(root, 'scenarios', 'spec-a', 'case');
  mkdirSync(scenarioFolder, { recursive: true });
  const contaminatedSession = join(root, 'contaminated.jsonl');
  writeFileSync(contaminatedSession, `${JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: join(scenarioFolder, 'scenario.json') } }] },
  })}\n`);
  const unrelatedSession = join(root, 'unrelated.jsonl');
  writeFileSync(unrelatedSession, `${JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: join(root, 'unrelated', 'file.txt') } }] },
  })}\n`);

  assert.equal(contaminated([contaminatedSession], scenarioFolder), true);
  assert.equal(contaminated([unrelatedSession], scenarioFolder), false);
  assert.equal(contaminated([join(root, 'missing.jsonl')], scenarioFolder), false);
});

test('outcome precedence ranks invalid above timed-out blocked failed passed', t => {
  const root = fixture(t);
  const scenarioFolder = join(root, 'scenarios', 'spec-a', 'case');
  mkdirSync(scenarioFolder, { recursive: true });
  const session = join(root, 'session.jsonl');
  writeFileSync(session, `${JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: join(scenarioFolder, 'scenario.json') } }] },
  })}\n`);
  const scenario = { scenario: { id: 'case' }, folder: scenarioFolder, version: 'v1' };

  assert.equal(gradeCell({ outcome: 'finished', checks: [], session, sessions: [session] }, scenario, null).outcome, 'invalid');
  assert.equal(gradeCell({ outcome: 'timed-out', checks: [] }, scenario, null).outcome, 'timed-out');

  const failedCheck = { id: 'c', ok: false, detail: 'x' };
  const blocked = gradeCell({ outcome: 'blocked', checks: [failedCheck] }, scenario, null);
  assert.equal(blocked.outcome, 'blocked');
  assert.deepEqual(blocked.checks, [failedCheck]);

  assert.equal(gradeCell({ outcome: 'finished', checks: [failedCheck] }, scenario, null).outcome, 'failed');
  assert.equal(gradeCell({ outcome: 'finished', checks: [{ id: 'c', ok: true, detail: 'x' }] }, scenario, null).outcome, 'passed');
});

test('label matched only when the tested model differs', () => {
  const cells = [
    { id: 'c1', scenario: 'x', version: 'v1', model: 'p/a' },
    { id: 'c2', scenario: 'x', version: 'v1', model: 'p/b' },
  ];
  const manifest = {
    skill_sha256: 'h',
    roles: { editor_model: 'p/editor', scout_model: 'p/scout' },
    timeout_ms: 1000,
    env_names: ['PATH'],
    ambient_context: [],
    scenarios: [{ id: 'x', version: 'v1', driver: 'leaf' }],
    cells,
  };
  const matched = comparisonLabel(manifest, manifest.cells);
  assert.equal(matched.label, 'matched');
  assert.deepEqual(matched.differing, []);

  const drifted = { ...manifest, cells: manifest.cells.map(cell => ({ ...cell })) };
  drifted.cells[1].roles = { editor_model: 'p/other', scout_model: 'p/scout' };
  const exploratory = comparisonLabel(drifted, drifted.cells);
  assert.equal(exploratory.label, 'exploratory');
  assert.ok(exploratory.differing.includes('roles'), JSON.stringify(exploratory.differing));
});

test('label exploratory names version drift', () => {
  const manifest = {
    skill_sha256: 'h',
    roles: { editor_model: 'p/editor', scout_model: 'p/scout' },
    timeout_ms: 1000,
    env_names: ['PATH'],
    ambient_context: [],
    scenarios: [{ id: 'x', version: 'v1', driver: 'leaf' }],
    cells: [
      { id: 'c1', scenario: 'x', version: 'v1', model: 'p/a' },
      { id: 'c2', scenario: 'x', version: 'v2', model: 'p/b' },
    ],
  };
  const result = comparisonLabel(manifest, manifest.cells);
  assert.equal(result.label, 'exploratory');
  assert.ok(result.differing.includes('version'), JSON.stringify(result.differing));
});

test('report lists every repetition and prints unknown cost', () => {
  const runRecord = {
    run_id: '20261010T155900Z-abcd',
    manifest: 'manifest.json',
    label: { label: 'matched', differing: [] },
    cells: [
      { id: 'c1', scenario: 'x', version: 'v1', model: 'p/a', repeat: 1, state: 'finished', outcome: 'passed', reason: null, cost_usd: null, tokens: { input_tokens: 1, output_tokens: 2 }, elapsed_ms: 100, checks: [] },
      { id: 'c2', scenario: 'x', version: 'v1', model: 'p/b', repeat: 2, state: 'finished', outcome: 'passed', reason: null, cost_usd: 0.25, tokens: { input_tokens: 3, output_tokens: 4 }, elapsed_ms: 200, checks: [] },
      { id: 'c3', scenario: 'x', version: 'v1', model: 'p/b', repeat: 1, state: 'finished', outcome: 'blocked', reason: 'Pi exited 2', cost_usd: null, tokens: { input_tokens: null, output_tokens: null }, elapsed_ms: 50, checks: [{ id: 'b', ok: false }] },
    ],
  };
  const report = renderReport(runRecord);
  const tableLines = report.split('\n').filter(line => line.startsWith('| '));
  const dataRows = tableLines.filter(line => !/^\|[\s|:-]+\|$/.test(line)).slice(1);
  assert.equal(dataRows.length, 3, report);
  assert.ok(report.includes('Pi exited 2'), report);
  assert.ok(report.includes('unknown'), report);
  assert.ok(report.includes('Unknown cost means the provider did not price the calls; it is not zero.'), report);
  for (const line of report.split('\n')) {
    assert.ok(!/\b(?:average|mean|winner)\b/.test(line), line);
  }
});
