import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

// Prepared-package file set for `managed-step` fixtures. The authoritative list
// is owned by preparedEntry in pi/extensions/spec-runtime/startup.mjs; the
// indexed step-NNN-subspec.md cards are additional. Keep this mirror in sync.
export const PREPARED_PACKAGE_FILES = [
  'context.md',
  'spec.md',
  'spec-prepare.md',
  'evidence-plan.json',
  'spec-steps.json',
  '../project-context.md',
];

export const CHECK_KINDS = ['file-exists', 'file-absent', 'line-1', 'text-match', 'json-equals', 'git-untouched', 'run-state'];

const INDEX_SENTENCE = 'Scenarios in this index exercise only the listed purposes; behaviors absent from this table are not covered.';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

const toPosix = path => path.split(sep).join('/');
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a, b) => byString(a.scenario.id, b.scenario.id);

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function readScenarioFile(folder) {
  const scenario = JSON.parse(readFileSync(join(folder, 'scenario.json'), 'utf8'));
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    throw new Error('scenario must be a JSON object');
  }
  return scenario;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortedValue(value[key]);
    return sorted;
  }
  return value;
}

function walkEntries(folder, directory = join(folder, 'input')) {
  if (!existsSync(directory)) return [];
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const info = lstatSync(path);
    const relativePath = toPosix(relative(folder, path));
    if (info.isSymbolicLink()) entries.push({ relativePath, content: Buffer.from(readlinkSync(path)) });
    else if (info.isDirectory()) entries.push(...walkEntries(folder, path));
    else entries.push({ relativePath, content: readFileSync(path) });
  }
  return entries;
}

function collectPaths(folder, directory = folder, files = [], symlinks = []) {
  if (!existsSync(directory)) return { files, symlinks };
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const info = lstatSync(path);
    const relativePath = toPosix(relative(folder, path));
    if (info.isSymbolicLink()) {
      symlinks.push(relativePath);
      files.push(relativePath);
    } else if (info.isDirectory()) {
      collectPaths(folder, path, files, symlinks);
    } else {
      files.push(relativePath);
    }
  }
  return { files, symlinks };
}

function findGitRoot(folder) {
  let current = folder;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const defaultGit = (args, { cwd }) => execFileSync('git', args, { cwd, encoding: 'utf8' });

export function discoverSkills(skillsDir) {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('spec-') && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();
}

export function loadScenario(folder) {
  const file = join(folder, 'scenario.json');
  let scenario;
  try {
    scenario = readScenarioFile(folder);
  } catch (error) {
    throw new Error(`${file}: invalid scenario.json (${error.message})`);
  }
  return { scenario, folder, version: scenarioVersion(folder) };
}

export function scenarioVersion(folder) {
  const { status, ...rest } = readScenarioFile(folder);
  const entries = [{ relativePath: 'scenario.json', content: JSON.stringify(sortedValue(rest)) }, ...walkEntries(folder)];
  entries.sort((a, b) => byString(a.relativePath, b.relativePath));
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.relativePath}\0`);
    hash.update(entry.content);
  }
  return hash.digest('hex');
}

export function validateScenario(folder, { git = defaultGit } = {}) {
  const errors = [];
  const folderName = basename(folder);
  let scenario;
  try {
    scenario = readScenarioFile(folder);
  } catch (error) {
    return { ok: false, errors: [`scenario.json: invalid scenario.json (${error.message})`] };
  }

  if (typeof scenario.id !== 'string' || !ID_PATTERN.test(scenario.id)) {
    errors.push(`scenario.json: id ${JSON.stringify(scenario.id)} must match ${ID_PATTERN}`);
  } else if (scenario.id !== folderName) {
    errors.push(`scenario.json: id ${JSON.stringify(scenario.id)} does not match folder ${JSON.stringify(folderName)}`);
  }

  const skillFolder = basename(dirname(folder));
  if (scenario.skill !== skillFolder) {
    errors.push(`scenario.json: skill ${JSON.stringify(scenario.skill)} does not match folder ${JSON.stringify(skillFolder)}`);
  }

  if (scenario.driver !== 'leaf' && scenario.driver !== 'managed-step') {
    errors.push("scenario.json: driver must be 'leaf' or 'managed-step'");
  }
  if (scenario.status !== 'draft' && scenario.status !== 'ready') {
    errors.push("scenario.json: status must be 'draft' or 'ready'");
  }
  if (!Number.isInteger(scenario.timeout_ms) || scenario.timeout_ms <= 0) {
    errors.push('scenario.json: timeout_ms must be a positive integer');
  }
  if (typeof scenario.task !== 'string' || !scenario.task.trim()) {
    errors.push('scenario.json: task must be a non-empty string');
  }
  if (typeof scenario.purpose !== 'string' || !scenario.purpose.trim()) {
    errors.push('scenario.json: purpose must be a non-empty string');
  }
  if (typeof scenario.fixture?.feature !== 'string' || !scenario.fixture.feature.trim()) {
    errors.push('scenario.json: fixture.feature must be a non-empty string');
  }

  const roles = scenario.roles;
  if (roles !== undefined && (typeof roles !== 'object' || roles === null || Array.isArray(roles))) {
    errors.push('scenario.json: roles must be an object');
  }
  if (scenario.driver === 'managed-step') {
    if (!Number.isInteger(scenario.fixture?.step) || scenario.fixture.step <= 0) {
      errors.push('scenario.json: managed-step requires fixture.step');
    }
    if (typeof roles?.editor_model !== 'string' || !roles.editor_model.trim()) {
      errors.push('scenario.json: managed-step requires roles.editor_model');
    }
  } else if (scenario.driver === 'leaf' && roles !== undefined) {
    errors.push('scenario.json: leaf scenario must not declare roles');
  }

  if (!Array.isArray(scenario.expectation_sources)) {
    errors.push('scenario.json: expectation_sources must be an array');
  }
  if (!Array.isArray(scenario.checks)) {
    errors.push('scenario.json: checks must be an array');
  } else {
    for (const check of scenario.checks) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) {
        errors.push('scenario.json: checks entries must be objects');
        continue;
      }
      if (typeof check.id !== 'string' || !check.id.trim()) {
        errors.push('scenario.json: check must have a non-empty id');
      }
      if (!CHECK_KINDS.includes(check.kind)) {
        errors.push(`scenario.json: check ${JSON.stringify(check.id)} has unknown kind ${JSON.stringify(check.kind)}`);
      }
    }
  }

  const inputDir = join(folder, 'input');
  const packageDir = join(inputDir, 'package');
  const projectContext = join(inputDir, 'project-context.md');
  if (!isDirectory(packageDir)) errors.push('input/package/: missing required directory');
  if (!isFile(projectContext)) errors.push('input/project-context.md: missing required file');

  if (scenario.driver === 'managed-step' && isDirectory(packageDir)) {
    for (const name of PREPARED_PACKAGE_FILES) {
      if (name === '../project-context.md') continue;
      if (!isFile(join(packageDir, name))) {
        errors.push(`input/package/${name}: managed-step package is missing a prepared file`);
      }
    }
    const stepsFile = join(packageDir, 'spec-steps.json');
    let indexedSteps = null;
    if (isFile(stepsFile)) {
      try {
        const steps = JSON.parse(readFileSync(stepsFile, 'utf8'))?.steps;
        if (!Array.isArray(steps) || !steps.length || steps.some((entry, index) => !entry || !Number.isInteger(entry.step) || entry.step < 1 || (index && entry.step <= steps[index - 1].step))) {
          errors.push('input/package/spec-steps.json: managed-step package requires ordered, unique positive step numbers');
        } else {
          indexedSteps = steps.map(entry => entry.step);
        }
      } catch (error) {
        errors.push(`input/package/spec-steps.json: invalid spec-steps.json (${error.message})`);
      }
    }
    if (indexedSteps) {
      for (const indexedStep of indexedSteps) {
        const card = `step-${String(indexedStep).padStart(3, '0')}-subspec.md`;
        if (!isFile(join(packageDir, card))) {
          errors.push(`input/package/${card}: managed-step package is missing an indexed step card`);
        }
      }
    }
    const step = scenario.fixture?.step;
    if (Number.isInteger(step) && step > 0) {
      if (indexedSteps && !indexedSteps.includes(step)) {
        errors.push(`scenario.json: managed-step fixture.step ${step} is not indexed by input/package/spec-steps.json`);
      }
      const card = `step-${String(step).padStart(3, '0')}-subspec.md`;
      if (!indexedSteps && !isFile(join(packageDir, card))) {
        errors.push(`input/package/${card}: managed-step package is missing the named step card`);
      }
    }
  }

  const { files, symlinks } = collectPaths(folder);
  for (const link of symlinks) {
    if (link === 'input' || link.startsWith('input/')) errors.push(`${link}: symlink not allowed`);
  }

  if (scenario.status === 'ready') {
    if (!Array.isArray(scenario.expectation_sources) || scenario.expectation_sources.length === 0) {
      errors.push('scenario.json: ready scenario requires non-empty expectation_sources');
    }
    if (!Array.isArray(scenario.checks) || scenario.checks.length === 0) {
      errors.push('scenario.json: ready scenario requires a non-empty checks array');
    } else if (scenario.checks.some(check => check && check.todo === true)) {
      errors.push('scenario.json: ready scenario must not have a check with todo true');
    }

    const repoRoot = findGitRoot(folder);
    if (!repoRoot) {
      for (const file of files) errors.push(`${file}: untracked by Git`);
    } else {
      const repoPaths = files.map(file => toPosix(relative(repoRoot, join(folder, file))));
      try {
        git(['ls-files', '--error-unmatch', '--', ...repoPaths], { cwd: repoRoot });
      } catch (error) {
        const stderr = typeof error.stderr === 'string' ? error.stderr : String(error.stderr ?? '');
        const reported = new Set();
        for (const match of stderr.matchAll(/pathspec '([^']+)'/g)) {
          const untracked = toPosix(relative(folder, join(repoRoot, match[1])));
          if (reported.has(untracked)) continue;
          reported.add(untracked);
          errors.push(`${untracked}: untracked by Git`);
        }
        if (reported.size === 0) {
          for (const file of files) errors.push(`${file}: untracked by Git`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function renderIndex(skill, scenarios) {
  const rows = [...scenarios].sort(byId).map(({ scenario, version }) =>
    `| ${scenario.id} | ${scenario.status} | ${String(version).slice(0, 12)} | ${scenario.driver} | ${scenario.purpose} | [${scenario.id}](./${scenario.id}/) |`);
  return [
    `# Scenarios: ${skill}`,
    '',
    '| id | status | version | driver | purpose | folder |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    INDEX_SENTENCE,
  ].join('\n') + '\n';
}

export function indexDrift(skill, typeFolder) {
  const scenarios = [];
  if (existsSync(typeFolder)) {
    for (const name of readdirSync(typeFolder).sort()) {
      const folder = join(typeFolder, name);
      if (lstatSync(folder).isDirectory()) scenarios.push(loadScenario(folder));
    }
  }
  scenarios.sort(byId);
  const indexPath = join(typeFolder, 'scenarios.md');
  const actual = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  const expected = renderIndex(skill, scenarios);
  return { expected, actual, same: actual === expected };
}

export function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}
