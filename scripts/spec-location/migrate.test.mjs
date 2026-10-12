// Run: node --test scripts/spec-location/migrate.test.mjs
// Two real git repositories with a legacy .specs/ layout, migrated into a temp storage root.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkPackage, migrate, resolveWorkspace } from './index.mjs';
import { makeFixture, put } from './fixture.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));

function tree(dir) {
  const out = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path); else out.push(relative(dir, path));
    }
  };
  if (existsSync(dir)) visit(dir);
  return out.sort();
}

function legacyFixture() {
  const fx = makeFixture();
  const a = join(fx.alpha, '.specs');
  const b = join(fx.beta, '.specs');
  put(join(a, 'p1', 'spec.md'), '# P1 spec\n\nBody.\n');
  put(join(a, 'p1', 'context.md'), '# P1 context\n');
  put(join(a, 'p1', 'spec-steps.json'), JSON.stringify({ package: join(a, 'p1'), sibling: join(a, 'p1-other') }));
  put(join(a, 'p1', 'pr-url.json'), JSON.stringify({ schema_version: 1, kind: 'pr_submission', url: 'https://example.test/pull/1', draft: false, package: join(a, 'p1') }));
  put(join(a, 'p1', 'runtime', 'run.json'), JSON.stringify({ state: 'completed', pid: 999999, package: join(a, 'p1') }));
  put(join(a, 'p1', 'runtime', 'runs', 'r1.json'), 'receipt\n');
  put(join(a, 'p1', 'runtime', 'runs', 'r1.jsonl'), 'transcript\n');
  put(join(a, 'project-context.md'), '# Alpha context\n\nAlpha facts.\n');
  put(join(a, '_epics', 'e1', 'epic.json'), JSON.stringify({
    schema_version: 1, epic: 'e1', title: 'E1', plan: '../../_plans/e1-plan.md', state: 'active',
    packages: [{ package: 'p1', requires: [] }, { package: 'p2', repository: fx.beta, requires: ['p1'] }],
  }));
  put(join(a, '_epics', 'e1', 'run.md'), 'log\n');
  put(join(a, '_plans', 'e1-plan.md'), '# E1 plan\n');
  put(join(a, 'images', 'shot.png'), 'png');
  put(join(b, 'p2', 'spec.md'), '# P2 spec\n');
  put(join(b, 'project-context.md'), '# Beta context\n\nBeta facts.\n');
  return fx;
}

async function withLegacy(run) {
  const fx = legacyFixture();
  try { await run(fx); } finally { fx.cleanup(); }
}

test('migrate: preview lists the actions and writes nothing', () => withLegacy(async fx => {
  const before = [tree(fx.tmp)];
  const preview = await migrate({ ...fx.options, workspace: 'demo' });
  assert.equal(preview.ok, true);
  assert.equal(preview.apply, false);
  const [alpha, beta] = preview.repositories;
  assert.deepEqual(alpha.packages.map(p => [p.slug, p.files, p.rewritten.sort(), p.transcripts_excluded]), [['p1', 6, ['pr-url.json', 'runtime/run.json', 'spec-steps.json'], true]]);
  assert.deepEqual(alpha.epics.map(e => e.slug), ['e1']);
  assert.deepEqual(alpha.plans.map(p => p.name), ['e1-plan.md']);
  assert.deepEqual(beta.packages.map(p => p.slug), ['p2']);
  assert.deepEqual([tree(fx.tmp)], before);
  const withRuns = await migrate({ ...fx.options, workspace: 'demo', includeTranscripts: true });
  assert.equal(withRuns.repositories[0].packages[0].files, 7);
}));

test('migrate --apply: builds the storage tree, rewrites paths, archives the originals', () => withLegacy(async fx => {
  // Migration runs where the legacy data is, not necessarily on the execution host.
  const result = await migrate({ ...fx.options, hostname: 'laptop.local', workspace: 'demo', apply: true });
  assert.equal(result.ok, true);
  const ws = fx.workspaceDir;

  assert.deepEqual(tree(ws), [
    'captures/alpha/images/shot.png', 'epics/e1/epic.json', 'epics/e1/run.md', 'kit.yaml', 'plans/e1-plan.md', 'project-context.md',
    'specs/p1/context.md', 'specs/p1/locations.json', 'specs/p1/pr-url.json', 'specs/p1/runtime/run.json', 'specs/p1/runtime/runs/r1.json', 'specs/p1/scope.json',
    'specs/p1/spec-steps.json', 'specs/p1/spec.md', 'specs/p2/locations.json', 'specs/p2/scope.json', 'specs/p2/spec.md',
  ]);
  assert.equal(readFileSync(join(ws, 'specs', 'p1', 'runtime', 'runs', 'r1.json'), 'utf8'), 'receipt\n');

  const p1 = join(ws, 'specs', 'p1');
  const steps = json(join(p1, 'spec-steps.json'));
  assert.equal(steps.package, p1);
  assert.equal(steps.sibling, join(fx.alpha, '.specs', 'p1-other'));
  assert.deepEqual(json(join(p1, 'pr-url.json')), {
    schema_version: 1, kind: 'pr_submission', package_ref: 'demo/p1',
    targets: { alpha: { url: 'https://example.test/pull/1', mode: 'ready' } },
  });
  assert.equal(json(join(p1, 'runtime', 'run.json')).package, p1);
  assert.deepEqual(json(join(p1, 'scope.json')).targets, [{ id: 'alpha', branch: 'spec-p1' }]);
  assert.equal(json(join(p1, 'scope.json')).epic, 'e1');
  assert.match(readFileSync(join(p1, 'spec.md'), 'utf8'), /^# P1 spec\n\n<!-- spec-location:begin -->/);

  const epic = json(join(ws, 'epics', 'e1', 'epic.json'));
  assert.deepEqual(epic.packages, [{ package: 'p1', requires: [] }, { package: 'p2', requires: ['p1'] }]);
  assert.equal(epic.plan, 'e1-plan.md');

  const context = readFileSync(join(ws, 'project-context.md'), 'utf8');
  assert.match(context, /## Repository: alpha\n\n# Alpha context\n\nAlpha facts\.\n/);
  assert.match(context, /## Repository: beta\n\n# Beta context/);
  assert.ok(result.repositories[0].warnings.includes('review project-context.md'));

  const archive = result.repositories[0].archive;
  assert.match(archive, /data\/spec-location\/legacy\/demo\/alpha-\d{8}$/);
  assert.equal(readFileSync(join(archive, 'p1', 'runtime', 'runs', 'r1.jsonl'), 'utf8'), 'transcript\n');
  assert.equal(existsSync(join(fx.alpha, '.specs')), false);
  assert.equal(existsSync(join(fx.beta, '.specs')), false);

  assert.equal((await resolveWorkspace({ ...fx.options, workspace: 'demo' })).ok, true);
  assert.equal((await checkPackage('demo/p2', fx.options)).ok, true);
}));

test('migrate: slug collisions refuse and list every conflict', () => withLegacy(async fx => {
  put(join(fx.workspaceDir, 'specs', 'p1', 'scope.json'), '{}');
  put(join(fx.beta, '.specs', 'p1', 'spec.md'), '# also p1\n');
  const refused = await migrate({ ...fx.options, workspace: 'demo', apply: true });
  assert.equal(refused.code, 'slug-collision');
  assert.deepEqual(refused.collisions, ['package p1 already exists in demo', 'package p1 appears in alpha and beta']);
  assert.equal(existsSync(join(fx.alpha, '.specs', 'p1', 'spec.md')), true);
}));

test('migrate: a live coordinator pid refuses with run-active', () => withLegacy(async fx => {
  put(join(fx.alpha, '.specs', 'p1', 'runtime', 'run.json'), JSON.stringify({ state: 'running', pid: process.pid }));
  const refused = await migrate({ ...fx.options, workspace: 'demo', apply: true });
  assert.equal(refused.code, 'run-active');
  assert.match(refused.message, /alpha\/p1/);
  assert.equal(existsSync(join(fx.workspaceDir, 'specs')), false);
}));

test('migrate: run receipts migrate, raw jsonl and log files stay in the archive unless included', () => withLegacy(async fx => {
  const runs = join(fx.alpha, '.specs', 'p1', 'runtime', 'runs');
  put(join(runs, 'r1-completion.json'), '{}');
  put(join(runs, 'r1-processes', 'p.json'), '{}');
  put(join(runs, 'r1-processes', 'p.log'), 'log\n');
  assert.equal((await migrate({ ...fx.options, workspace: 'demo', apply: true })).ok, true);
  assert.deepEqual(tree(join(fx.workspaceDir, 'specs', 'p1', 'runtime', 'runs')), ['r1-completion.json', 'r1-processes/p.json', 'r1.json']);
}));

test('migrate: legacy pr-url.json keys are normalized and the tour path follows the package', () => withLegacy(async fx => {
  const old = join(fx.alpha, '.specs', 'p1');
  put(join(old, 'pr-url.json'), JSON.stringify({
    url: 'https://example.test/pull/2', submittedAt: '2026-01-02T03:04:05Z', isDraft: true, tour: join(old, 'tour', 'index.html'), package: old,
  }));
  assert.equal((await migrate({ ...fx.options, workspace: 'demo', apply: true })).ok, true);
  const p1 = join(fx.workspaceDir, 'specs', 'p1');
  assert.deepEqual(json(join(p1, 'pr-url.json')).targets, {
    alpha: { url: 'https://example.test/pull/2', submitted_at: '2026-01-02T03:04:05Z', mode: 'draft', tour: join(p1, 'tour', 'index.html') },
  });
}));

test('migrate: an empty package directory migrates, and a rerun finishes a partly migrated workspace', () => withLegacy(async fx => {
  mkdirSync(join(fx.alpha, '.specs', 'stub'));
  // State left by an earlier run that stopped after writing p1's scope.json.
  const scope = id => JSON.stringify({ schema_version: 1, workspace: 'demo', slug: 'p1', targets: [{ id, branch: 'spec-p1' }], designs: [], plan: null, epic: null });
  put(join(fx.workspaceDir, 'specs', 'p1', 'scope.json'), scope('beta'));
  assert.equal((await migrate({ ...fx.options, workspace: 'demo', apply: true })).code, 'slug-collision');

  put(join(fx.workspaceDir, 'specs', 'p1', 'scope.json'), scope('alpha'));
  const result = await migrate({ ...fx.options, workspace: 'demo', apply: true });
  assert.equal(result.ok, true);
  assert.equal(json(join(fx.workspaceDir, 'specs', 'stub', 'scope.json')).slug, 'stub');
  assert.equal(existsSync(join(fx.workspaceDir, 'specs', 'p1', 'spec.md')), false);
  assert.equal(existsSync(join(result.repositories[0].archive, 'p1', 'spec.md')), true);
  assert.equal(existsSync(join(fx.alpha, '.specs')), false);
}));

test('migrate: ux-qa/runs stays in the archive and is listed as unmigrated', () => withLegacy(async fx => {
  put(join(fx.alpha, '.specs', 'ux-qa', 'shot.png'), 'png');
  put(join(fx.alpha, '.specs', 'ux-qa', 'runs', 's1.json'), '{"database_url":"postgres://secret"}');
  const result = await migrate({ ...fx.options, workspace: 'demo', apply: true });
  assert.equal(result.ok, true);
  assert.deepEqual(tree(join(fx.workspaceDir, 'captures', 'alpha', 'ux-qa')), ['shot.png']);
  assert.equal(result.repositories[0].unmigrated[0].name, 'ux-qa/runs');
  assert.equal(existsSync(join(result.repositories[0].archive, 'ux-qa', 'runs', 's1.json')), true);
}));

test('migrate: a blocked run with a live pid refuses with run-active', () => withLegacy(async fx => {
  put(join(fx.alpha, '.specs', 'p1', 'runtime', 'run.json'), JSON.stringify({ state: 'blocked', pid: process.pid }));
  assert.equal((await migrate({ ...fx.options, workspace: 'demo', apply: true })).code, 'run-active');
}));
