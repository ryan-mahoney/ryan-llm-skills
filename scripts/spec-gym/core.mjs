import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { readMetrics } from '../spec-observe/metrics.mjs';

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

export async function readUsage(sessionFiles = []) {
  let inputTokens = null;
  let outputTokens = null;
  let cost = null;
  for (const file of sessionFiles) {
    if (!existsSync(file)) continue;
    const { agents } = await readMetrics({ file, role: 'leaf' });
    for (const agent of agents) {
      if (Number.isFinite(agent.input_tokens)) inputTokens = (inputTokens ?? 0) + agent.input_tokens;
      if (Number.isFinite(agent.output_tokens)) outputTokens = (outputTokens ?? 0) + agent.output_tokens;
      if (Number.isFinite(agent.reported_cost)) cost = (cost ?? 0) + agent.reported_cost;
    }
  }
  return { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost !== null && cost > 0 ? cost : null };
}

function rootCommit(repo) {
  try {
    const output = execFileSync('git', ['-C', repo, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return output.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

export function evaluateCheck(check, roots, context = {}) {
  const id = check?.id;
  let resolved;
  try {
    if (check?.kind === 'run-state') {
      if (context.driver !== 'managed-step') return { id, ok: false, detail: 'run-state requires managed-step' };
      const ok = context.state === check.equals;
      return { id, ok, detail: `state ${JSON.stringify(context.state)}` };
    }
    const root = roots?.[check?.root];
    if (!root) return { id, ok: false, detail: `root ${JSON.stringify(check?.root)} is unavailable` };
    resolved = join(root, check?.path ?? '');
    switch (check?.kind) {
      case 'file-exists':
      case 'file-absent': {
        const present = existsSync(resolved);
        const ok = check.kind === 'file-exists' ? present : !present;
        return { id, ok, detail: `${resolved}: ${present ? 'present' : 'missing'}` };
      }
      case 'line-1': {
        if (!existsSync(resolved)) return { id, ok: false, detail: `${resolved}: missing` };
        const first = readFileSync(resolved, 'utf8').split('\n', 1)[0];
        const ok = new RegExp(check.pattern).test(first);
        return { id, ok, detail: `${resolved}: first line ${ok ? 'matches' : 'does not match'} ${JSON.stringify(check.pattern)}` };
      }
      case 'text-match': {
        if (!existsSync(resolved)) return { id, ok: false, detail: `${resolved}: missing` };
        const present = new RegExp(check.pattern).test(readFileSync(resolved, 'utf8'));
        const ok = check.absent ? !present : present;
        return { id, ok, detail: `${resolved}: pattern ${JSON.stringify(check.pattern)} is ${present ? 'present' : 'absent'}` };
      }
      case 'json-equals': {
        if (!existsSync(resolved)) return { id, ok: false, detail: `${resolved}: missing` };
        let value;
        try {
          value = JSON.parse(readFileSync(resolved, 'utf8'));
        } catch (error) {
          return { id, ok: false, detail: `${resolved}: invalid JSON at pointer ${JSON.stringify(check.pointer)} (${error.message})` };
        }
        for (const segment of String(check.pointer ?? '').split('/').filter(Boolean)) {
          if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segment)) {
            return { id, ok: false, detail: `${resolved}: pointer ${JSON.stringify(check.pointer)} not found` };
          }
          value = value[segment];
        }
        const ok = JSON.stringify(value) === JSON.stringify(check.equals);
        return { id, ok, detail: `${resolved}: pointer ${JSON.stringify(check.pointer)} is ${JSON.stringify(value)}` };
      }
      case 'git-untouched': {
        if (!context?.fixtureCommit) return { id, ok: false, detail: `${root}: git-untouched requires a fixture commit` };
        const paths = Array.isArray(check.paths) ? check.paths : [];
        const run = args => {
          try {
            return { code: 0, out: execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
          } catch (error) {
            return { code: error.status ?? 1, out: error.stdout ?? '', err: error.stderr ?? '' };
          }
        };
        const quiet = run(['diff', '--quiet', context.fixtureCommit, '--', ...paths]);
        const status = run(['status', '--porcelain', '--no-renames', '--', ...paths]);
        if (quiet.code === 0 && !status.out.trim()) {
          return { id, ok: true, detail: `${paths.join(', ') || 'paths'}: unchanged since ${context.fixtureCommit}` };
        }
        const names = new Set();
        for (const line of status.out.split('\n')) {
          const name = line.slice(3).trim();
          if (name) names.add(name);
        }
        const diff = run(['diff', '--name-only', context.fixtureCommit, '--', ...paths]);
        for (const name of diff.out.split('\n')) {
          const trimmed = name.trim();
          if (trimmed) names.add(trimmed);
        }
        const changed = names.size ? [...names] : paths;
        return { id, ok: false, detail: `${changed.join(', ')}: changed since ${context.fixtureCommit}` };
      }
      default:
        return { id, ok: false, detail: `unknown check kind ${JSON.stringify(check?.kind)}` };
    }
  } catch (error) {
    return { id, ok: false, detail: `${resolved ?? check?.path ?? 'check'}: ${error.message}` };
  }
}

export function contaminated(sessionFiles, scenarioFolder) {
  const folder = String(scenarioFolder ?? '');
  if (!folder) return false;
  const tools = new Set(['read', 'grep', 'find', 'ls', 'bash']);
  for (const file of sessionFiles ?? []) {
    if (!file || !existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type !== 'toolCall' || !tools.has(part.name)) continue;
        if (JSON.stringify(part.arguments ?? {}).includes(folder)) return true;
      }
    }
  }
  return false;
}

export function gradeCell(cellResult, scenario, roots) {
  const driver = scenario?.scenario?.driver;
  const fixtureCommit = cellResult.fixture_commit ?? roots?.fixtureCommit ?? (roots?.repo ? rootCommit(roots.repo) : null);
  const context = {
    fixtureCommit,
    state: driver === 'managed-step' ? cellResult.record?.state ?? cellResult.state ?? null : null,
    driver,
  };
  const checks = roots && Array.isArray(scenario?.scenario?.checks)
    ? scenario.scenario.checks.map(check => evaluateCheck(check, roots, context))
    : (cellResult.checks ?? []);
  const sessionFiles = [cellResult.sessions, cellResult.session].flat().filter(Boolean);
  const result = { ...cellResult, checks };
  if (contaminated(sessionFiles, scenario?.folder)) return { ...result, outcome: 'invalid', reason: 'grader-read' };
  if (cellResult.outcome === 'invalid') return { ...result, outcome: 'invalid', reason: cellResult.reason ?? 'invalid' };
  if (cellResult.outcome === 'timed-out') return { ...result, outcome: 'timed-out', reason: cellResult.reason ?? null };
  if (cellResult.outcome === 'blocked') return { ...result, outcome: 'blocked', reason: cellResult.reason ?? null };
  const failed = checks.filter(check => !check.ok);
  if (failed.length) return { ...result, outcome: 'failed', reason: failed.map(check => check.id).join(', ') };
  return { ...result, outcome: 'passed', reason: null };
}

export function comparisonLabel(manifest = {}, cells = []) {
  const scenarios = new Map((manifest.scenarios ?? []).map(entry => [entry.id, entry]));
  const fields = ['skill', 'scenario', 'version', 'driver', 'roles', 'timeout', 'env_names', 'ambient_context'];
  const descriptors = (cells ?? []).map(cell => {
    const scenario = scenarios.get(cell.scenario) ?? {};
    return {
      skill: cell.skill_sha256 ?? manifest.skill_sha256,
      scenario: cell.scenario,
      version: cell.version ?? scenario.version,
      driver: cell.driver ?? scenario.driver,
      roles: cell.roles ?? manifest.roles,
      timeout: cell.timeout_ms ?? manifest.timeout_ms,
      env_names: cell.env_names ?? manifest.env_names,
      ambient_context: cell.ambient_context ?? manifest.ambient_context,
    };
  });
  const differing = fields.filter(field => descriptors.some(descriptor => JSON.stringify(descriptor[field]) !== JSON.stringify(descriptors[0]?.[field])));
  if (differing.length) return { label: 'exploratory', differing: differing.sort() };
  return { label: 'matched', differing: [] };
}

export function renderReport(runRecord = {}) {
  const label = typeof runRecord.label === 'string'
    ? { label: runRecord.label, differing: [] }
    : (runRecord.label ?? { label: 'unknown', differing: [] });
  const manifestPath = runRecord.manifest ?? 'manifest.json';
  const lines = [
    `# Run ${runRecord.run_id ?? 'unknown'}`,
    '',
    `Label: ${label.label}${label.differing?.length ? ` (differing: ${label.differing.join(', ')})` : ''}`,
    '',
    `Manifest: [${manifestPath}](${manifestPath})`,
    '',
  ];
  const grouped = new Map();
  for (const cell of runRecord.cells ?? []) {
    const scenario = cell.scenario ?? 'unknown';
    if (!grouped.has(scenario)) grouped.set(scenario, []);
    grouped.get(scenario).push(cell);
  }
  for (const [scenario, cells] of grouped) {
    lines.push(`## Scenario ${scenario}`, '', '| model | outcome | reason | elapsed_ms | tokens | cost | failed checks |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const cell of cells) {
      const failed = (cell.checks ?? []).filter(check => !check.ok).map(check => check.id).filter(Boolean);
      const reason = String(cell.reason ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const tokens = cell.tokens?.input_tokens === null || cell.tokens?.input_tokens === undefined
        ? 'unknown'
        : `${cell.tokens.input_tokens}/${cell.tokens.output_tokens ?? 'unknown'}`;
      const cost = cell.cost_usd === null || cell.cost_usd === undefined ? 'unknown' : `$${cell.cost_usd}`;
      lines.push(`| ${cell.model ?? 'unknown'} | ${cell.outcome ?? 'unknown'} | ${reason} | ${cell.elapsed_ms ?? 'unknown'} | ${tokens} | ${cost} | ${failed.length ? failed.join(', ') : 'none'} |`);
    }
    lines.push('');
  }
  lines.push('Artifacts:', `- [manifest.json](${manifestPath})`);
  for (const cell of runRecord.cells ?? []) {
    for (const [name, path] of Object.entries(cell.artifacts ?? {})) lines.push(`- [${name}](${path})`);
  }
  lines.push('', 'Unknown cost means the provider did not price the calls; it is not zero.');
  return `${lines.join('\n')}\n`;
}
