import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWrite,
  discoverSkills,
  indexDrift,
  loadScenario,
  renderIndex,
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
