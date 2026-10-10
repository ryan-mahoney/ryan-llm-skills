import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { splitModelSelector } from '../../pi/extensions/spec-runtime/model-selector.mjs';
import { gitFacts } from '../spec-facts/core.mjs';
import { atomicWrite, loadScenario } from './core.mjs';

const CELL_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'SPEC_GYM_FAKE_PI_LOG', 'SPEC_GYM_FAKE_PI_SCRIPT',
]);
const GENERATED_GITIGNORE = '.specs/\n';
const FIXTURE_USER = { name: 'Spec Gym', email: 'spec-gym@example.invalid' };

const toPosix = path => path.split(sep).join('/');

export function runRootFor(repoRoot, override) {
  return resolve(override ?? join(repoRoot, 'tmp', 'spec-gym'));
}

export function cellId(scenarioId, selector, repeat) {
  const { provider, model, thinking } = splitModelSelector(selector);
  return [scenarioId, provider, model, ...(thinking ? [thinking] : []), `r${repeat}`].join('--').replace(/[/:]/g, '-');
}

export function createRun({ repoRoot = process.cwd(), root, skill, scenarios = [], models = [], roles = {}, timeoutMs, repeats = 1, childExtensions = [], pi = 'pi' } = {}) {
  if (typeof skill !== 'string' || !skill.trim()) throw new Error('skill must be a non-empty string');
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error('scenarios must be a non-empty array');
  if (!Array.isArray(models) || models.length === 0) throw new Error('models must be a non-empty array');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  if (!Number.isInteger(repeats) || repeats <= 0) throw new Error('repeats must be a positive integer');
  if (!Array.isArray(childExtensions)) throw new Error('childExtensions must be an array');

  const loaded = scenarios.map(folder => loadScenario(folder));
  for (const selector of models) splitModelSelector(selector);
  for (const name of ['editor_model', 'scout_model']) {
    if (roles?.[name] !== undefined) splitModelSelector(roles[name]);
  }

  const runRoot = runRootFor(repoRoot, root);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  const runId = `${stamp}-${randomBytes(2).toString('hex')}`;
  const runDir = join(runRoot, runId);
  const cells = [];
  for (const entry of loaded) {
    for (const selector of models) {
      const parsed = splitModelSelector(selector);
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        cells.push({
          id: cellId(entry.scenario.id, selector, repeat),
          scenarioId: entry.scenario.id,
          version: entry.version,
          model: selector,
          provider: parsed.provider,
          model_id: parsed.model,
          thinking: parsed.thinking ?? null,
          repeat,
        });
      }
    }
  }
  mkdirSync(runDir, { recursive: true });
  return {
    runId, runDir, repoRoot, root: runRoot, skill, skillDir: join(repoRoot, 'skills', skill),
    scenarios: loaded, models, roles, timeoutMs, repeats, childExtensions, pi, cells,
  };
}

export function freezeManifest(run) {
  const manifest = {
    schema_version: 1,
    run_id: run.runId,
    created_at: new Date().toISOString(),
    gym: gitFacts({ repo: run.repoRoot }),
    pi: { command: run.pi, version: piVersion(run.pi) },
    skill: run.skill,
    skill_sha256: hashTree(run.skillDir),
    scenarios: run.scenarios.map(({ scenario, version }) => ({
      id: scenario.id, status: scenario.status, version, driver: scenario.driver,
    })),
    cells: run.cells.map(({ id, scenarioId, version, model, provider, model_id, thinking, repeat }) => ({
      id, scenario: scenarioId, version, model, provider, model_id, thinking, repeat,
    })),
    roles: run.roles,
    timeout_ms: run.timeoutMs,
    child_extensions: run.childExtensions,
    env_names: Object.keys(cellEnvironment(process.env)).sort(),
    ambient_context: ambientContext(join(run.runDir, run.cells[0]?.id ?? '', 'repo')),
  };
  atomicWrite(join(run.runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function materializeCell(run, cell, scenario) {
  const cellDir = join(run.runDir, typeof cell === 'string' ? cell : cell.id);
  const scenarioFolder = scenario.folder;
  const inputDir = join(scenarioFolder, 'input');
  if (existsSync(inputDir)) {
    for (const link of findSymlinks(scenarioFolder, inputDir)) throw new Error(`${link}: symlink not allowed`);
  }
  validateFeature(scenario.scenario?.fixture?.feature);
  const feature = scenario.scenario.fixture.feature;

  const repoDir = join(cellDir, 'repo');
  const packageDir = join(repoDir, '.specs', feature);
  const projectContext = join(repoDir, '.specs', 'project-context.md');
  const repositorySource = join(inputDir, 'repository');
  if (existsSync(repositorySource)) copyTree(repositorySource, repoDir);
  else mkdirSync(repoDir, { recursive: true });
  if (!existsSync(join(repoDir, '.gitignore'))) writeFileSync(join(repoDir, '.gitignore'), GENERATED_GITIGNORE);
  const packageSource = join(inputDir, 'package');
  if (existsSync(packageSource)) copyTree(packageSource, packageDir);
  copyTree(join(inputDir, 'project-context.md'), projectContext);

  const git = (...args) => execFileSync('git', ['-C', repoDir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', FIXTURE_USER.name);
  git('config', 'user.email', FIXTURE_USER.email);
  git('add', '-A');
  git('commit', '-qm', 'Fixture');
  const fixtureCommit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { cellDir, repoDir, packageDir, projectContext, fixtureCommit };
}

export function cellEnvironment(env = {}) {
  const result = {};
  for (const name of Object.keys(env).sort()) {
    if (CELL_ENV_NAMES.has(name) || /^PI_/.test(name) || /_API_KEY$/.test(name)) result[name] = env[name];
  }
  return result;
}

export function ambientContext(repoDir, { home } = {}) {
  const base = home ?? process.env.HOME ?? homedir();
  const found = [];
  let current = resolve(repoDir);
  for (;;) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = join(current, name);
      if (existsSync(path)) found.push(path);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(base, '.pi', 'agent', name);
    if (existsSync(path)) found.push(path);
  }
  return [...new Set(found)].sort();
}

export function writeRunRecord(run, record) {
  atomicWrite(join(run.runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
}

function piVersion(command) {
  try {
    const output = execFileSync(command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return output.trim() || null;
  } catch {
    return null;
  }
}

function hashTree(root) {
  const hash = createHash('sha256');
  const entries = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      const relativePath = toPosix(relative(root, path));
      if (info.isSymbolicLink()) entries.push({ relativePath, content: readlinkSync(path) });
      else if (info.isDirectory()) visit(path);
      else entries.push({ relativePath, content: readFileSync(path, 'utf8') });
    }
  };
  if (existsSync(root)) visit(root);
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const entry of entries) hash.update(`${entry.relativePath}\0${entry.content}`);
  return hash.digest('hex');
}

function findSymlinks(folder, directory) {
  const links = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) links.push(toPosix(relative(folder, path)));
    else if (info.isDirectory()) links.push(...findSymlinks(folder, path));
  }
  return links;
}

function validateFeature(feature) {
  const valid = typeof feature === 'string' && feature.length > 0 && !feature.startsWith('/') && !/^[A-Za-z]:/.test(feature)
    && feature.split('/').every(segment => segment && segment !== '.' && segment !== '..');
  if (!valid) throw new Error(`fixture.feature ${JSON.stringify(feature)} must be a non-empty relative path without "", "." or ".." segments`);
}

function copyTree(source, destination) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`${source}: symlink not allowed`);
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source).sort()) copyTree(join(source, name), join(destination, name));
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
}
