import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { atomicWrite, loadScenario, PREPARED_PACKAGE_FILES, renderIndex } from './core.mjs';

// Mirrors the core scenario id rule so extraction refuses before it writes anything.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const PROJECT_CONTEXT = '../project-context.md';
const EXTRACT_TIMEOUT_MS = 1800000;

// Stage-entry allowlists. Package files are read from the live package because
// `.specs/` is ignored and has no Git history; repository inputs come only from
// `git show <pinned-revision>:<path>`.
export const STAGE_PROFILES = {
  'spec-architect-initial': {
    driver: 'leaf',
    requiresStep: false,
    packageFiles: ['requirements.md', 'context.md', PROJECT_CONTEXT],
    optionalPackageFiles: [],
  },
  'spec-step-run': {
    driver: 'managed-step',
    requiresStep: true,
    packageFiles: PREPARED_PACKAGE_FILES,
    optionalPackageFiles: ['criteria.md', 'invariants.md'],
  },
};

export const DENYLIST = ['.env', '.env.*', '*.pem', '*.key', 'auth.json', 'id_rsa*', 'node_modules/', '.git/'];

const DENIED_DIRS = DENYLIST.filter(name => name.endsWith('/')).map(name => name.slice(0, -1));
const DENIED_FILES = DENYLIST.filter(name => !name.endsWith('/')).map(pattern => {
  const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${expression}$`);
});

const padStep = step => String(step).padStart(3, '0');

const isInside = (parent, child) => {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(prefix);
};

// Resolve through the nearest existing ancestor so a symlinked parent cannot
// present an unreal path that dodges the source-overlap refusal.
function canonicalDestination(path) {
  const suffix = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  return join(existsSync(current) ? realpathSync(current) : current, ...suffix);
}

function deniedInclude(path) {
  const segments = path.split('/');
  if (segments.some(segment => DENIED_DIRS.includes(segment))) return true;
  return segments.some(segment => DENIED_FILES.some(pattern => pattern.test(segment)));
}

function validateInclude(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('include path must be a non-empty relative path');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) throw new Error(`include path ${JSON.stringify(path)} must be a POSIX relative path`);
  if (path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) throw new Error(`include path ${JSON.stringify(path)} must not contain empty, "." or ".." segments`);
  if (deniedInclude(path)) throw new Error(`include path ${JSON.stringify(path)} is denylisted`);
  return path;
}

function readPackageSource(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${path}: package input must be a regular file`);
  return readFileSync(path);
}

function resolveRevisionPath(repoDir, revision, path) {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `${revision}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // `--quiet` + exit 1 without diagnostics is the absent-path result; anything
    // else is an infrastructure failure that must not masquerade as missing.
    if (error.status === 1 && !error.signal && !(error.stderr?.length > 0)) return null;
    throw error;
  }
}

// The real package path is replaced first because the home directory is often
// its prefix; both counts are non-overlapping occurrences of the literal text.
function sanitizeText(text, packagePath, home) {
  let result = text;
  let count = 0;
  for (const [needle, replacement] of [[packagePath, '<SOURCE_PACKAGE>'], [home, '<HOME>']]) {
    if (!needle) continue;
    const occurrences = result.split(needle).length - 1;
    if (occurrences === 0) continue;
    count += occurrences;
    result = result.split(needle).join(replacement);
  }
  return { text: result, count };
}

function seedChecks(profile, step) {
  if (profile.driver === 'managed-step') {
    return [
      { id: 'run-state', kind: 'run-state', equals: 'completed' },
      { id: 'learning', kind: 'file-exists', root: 'package', path: `learnings/step-${padStep(step)}-learning.md` },
      { id: 'git-untouched', kind: 'git-untouched', root: 'checkout', paths: [], todo: true },
    ];
  }
  return [
    { id: 'proposal-exists', kind: 'file-exists', root: 'package', path: 'proposal.md' },
    { id: 'proposal-frontmatter', kind: 'line-1', root: 'package', path: 'proposal.md', pattern: '^---$' },
    { id: 'existing-module', kind: 'text-match', root: 'checkout', path: 'TODO', pattern: 'TODO', todo: true },
  ];
}

export function extract({
  sourcePackage,
  repo,
  revision,
  skill,
  id,
  step,
  include = [],
  update = false,
  scenariosRoot,
  home = homedir(),
} = {}) {
  if (typeof skill !== 'string' || !Object.hasOwn(STAGE_PROFILES, skill)) throw new Error(`unsupported stage profile ${JSON.stringify(skill)}`);
  const profile = STAGE_PROFILES[skill];
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`id ${JSON.stringify(id)} must match ${ID_PATTERN}`);
  if (profile.requiresStep && (!Number.isInteger(step) || step <= 0)) throw new Error('spec-step-run extraction requires --step with a positive integer');
  if (!Array.isArray(include)) throw new Error('include must be an array');
  if (typeof scenariosRoot !== 'string' || !scenariosRoot) throw new Error('scenariosRoot is required');
  if (typeof revision !== 'string' || !revision) throw new Error('revision is required');
  const includes = include.map(validateInclude);

  const sourceDir = realpathSync(sourcePackage);
  if (!statSync(sourceDir).isDirectory()) throw new Error(`source package ${JSON.stringify(sourcePackage)} is not a directory`);
  const repoDir = realpathSync(repo);
  if (!statSync(repoDir).isDirectory()) throw new Error(`repo ${JSON.stringify(repo)} is not a directory`);

  const pinned = execFileSync('git', ['-C', repoDir, 'rev-parse', '--verify', `${revision}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!/^[0-9a-f]{40,64}$/.test(pinned)) throw new Error(`revision ${JSON.stringify(revision)} did not resolve to a commit`);

  const destinationRoot = canonicalDestination(scenariosRoot);
  const typeFolder = join(destinationRoot, skill);
  const resolvedTypeFolder = canonicalDestination(typeFolder);
  if ([repoDir, sourceDir].some(root => isInside(root, resolvedTypeFolder) || isInside(resolvedTypeFolder, root))) {
    throw new Error(`destination ${typeFolder} overlaps the source repository or package; extract to a separate gym checkout`);
  }
  const target = join(typeFolder, id);
  if (existsSync(target) && !update) throw new Error(`scenario ${JSON.stringify(id)} already exists; pass update to replace it`);

  let indexedSteps = null;
  if (profile.requiresStep) {
    const specSteps = readPackageSource(join(sourceDir, 'spec-steps.json'));
    let steps;
    try {
      steps = JSON.parse(specSteps.toString('utf8'))?.steps;
    } catch (error) {
      throw new Error(`input/package/spec-steps.json: invalid JSON (${error.message})`);
    }
    if (!Array.isArray(steps) || steps.length === 0 || steps.some((entry, index) => !entry || !Number.isInteger(entry.step) || entry.step < 1 || (index > 0 && entry.step <= steps[index - 1].step))) {
      throw new Error('input/package/spec-steps.json: expected ordered, unique positive step numbers');
    }
    indexedSteps = steps.map(entry => entry.step);
    if (!indexedSteps.includes(step)) throw new Error(`requested step ${step} is absent from input/package/spec-steps.json`);
  }

  const token = randomUUID().replace(/-/g, '').slice(0, 8);
  const tempFolder = join(typeFolder, `.tmp-${id}-${token}`);
  const missingInputs = [];
  let rewrites = 0;
  let backupFolder = null;
  let published = false;
  let failure = null;
  let result = null;

  const writeCopiedFile = (destination, name, content) => {
    mkdirSync(dirname(destination), { recursive: true });
    if (name.endsWith('.md')) {
      const sanitized = sanitizeText(content.toString('utf8'), sourceDir, home);
      rewrites += sanitized.count;
      writeFileSync(destination, sanitized.text);
    } else {
      writeFileSync(destination, content);
    }
  };

  try {
    mkdirSync(tempFolder, { recursive: true });
    const packageDest = join(tempFolder, 'input', 'package');
    mkdirSync(packageDest, { recursive: true });
    for (const name of profile.packageFiles) {
      if (name === PROJECT_CONTEXT) writeCopiedFile(join(tempFolder, 'input', 'project-context.md'), name, readPackageSource(join(dirname(sourceDir), 'project-context.md')));
      else writeCopiedFile(join(packageDest, name), name, readPackageSource(join(sourceDir, name)));
    }
    for (const name of profile.optionalPackageFiles) {
      const path = join(sourceDir, name);
      if (existsSync(path)) writeCopiedFile(join(packageDest, name), name, readPackageSource(path));
    }
    if (indexedSteps) {
      for (const indexedStep of indexedSteps) {
        const name = `step-${padStep(indexedStep)}-subspec.md`;
        writeCopiedFile(join(packageDest, name), name, readPackageSource(join(sourceDir, name)));
      }
    }

    const repositoryDest = join(tempFolder, 'input', 'repository');
    for (const path of includes) {
      const objectId = resolveRevisionPath(repoDir, pinned, path);
      if (objectId === null) {
        missingInputs.push(path);
        continue;
      }
      const entry = execFileSync('git', ['-C', repoDir, 'ls-tree', '-z', pinned, '--', `:(literal)${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const mode = entry.split(' ', 1)[0];
      if (mode !== '100644' && mode !== '100755') {
        throw new Error(`include ${JSON.stringify(path)} must reference a regular repository file; unsupported Git entry mode ${mode}`);
      }
      const content = execFileSync('git', ['-C', repoDir, 'show', `${pinned}:${path}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      mkdirSync(dirname(join(repositoryDest, path)), { recursive: true });
      writeFileSync(join(repositoryDest, path), content);
      chmodSync(join(repositoryDest, path), mode === '100755' ? 0o755 : 0o644);
    }

    const managed = profile.driver === 'managed-step';
    const feature = basename(sourceDir);
    const scenario = {
      id,
      skill,
      driver: profile.driver,
      status: 'draft',
      purpose: `Candidate ${skill} scenario extracted from ${feature}; curate expectations before ready.`,
      fixture: managed ? { feature, step } : { feature },
      task: managed ? `spec=.specs/${feature}/spec.md step=${step}` : `Produce .specs/${feature}/context.md and .specs/${feature}/proposal.md.`,
      ...(managed ? { roles: { editor_model: 'TODO/editor-model', todo: true } } : {}),
      timeout_ms: EXTRACT_TIMEOUT_MS,
      expectation_sources: [],
      missing_inputs: [...missingInputs],
      source: { summary: `Extracted from ${feature} for ${skill}; content curation remains manual.`, revision: pinned, rewrites },
      checks: seedChecks(profile, step),
    };
    atomicWrite(join(tempFolder, 'scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`);

    const scenarios = [];
    if (existsSync(typeFolder)) {
      for (const name of readdirSync(typeFolder).sort()) {
        if (name.startsWith('.') || name === id) continue;
        const folder = join(typeFolder, name);
        if (!lstatSync(folder).isDirectory()) continue;
        scenarios.push(loadScenario(folder));
      }
    }
    scenarios.push(loadScenario(tempFolder));
    const indexText = renderIndex(skill, scenarios);

    try {
      if (update && existsSync(target)) {
        backupFolder = join(typeFolder, `.old-${id}-${token}`);
        renameSync(target, backupFolder);
      }
      renameSync(tempFolder, target);
      published = true;
      atomicWrite(join(typeFolder, 'scenarios.md'), indexText);
    } catch (error) {
      if (published) rmSync(target, { recursive: true, force: true });
      if (backupFolder && existsSync(backupFolder)) renameSync(backupFolder, target);
      throw error;
    }
    if (backupFolder) rmSync(backupFolder, { recursive: true, force: true });
    result = { folder: target, status: 'draft', missing_inputs: missingInputs, rewrites };
  } catch (error) {
    failure = error;
  } finally {
    try {
      rmSync(tempFolder, { recursive: true, force: true });
    } catch (cleanupError) {
      const context = `cleanup of ${tempFolder} failed: ${cleanupError.message}`;
      if (failure instanceof Error) failure.message = `${failure.message}; ${context}`;
      else if (failure) failure = new Error(`${String(failure)}; ${context}`);
      else failure = new Error(context);
    }
  }
  if (failure) throw failure;
  return result;
}
