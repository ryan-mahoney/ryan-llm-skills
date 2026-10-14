// spec-location: the only code that maps a workspace, kit or package reference
// to filesystem paths. A package lives in the synced adjacent storage root at
// projects/<workspace>/specs/<slug>/; scope.json says what it targets,
// locations.json holds the absolute paths materialized for this execution host.
//
// Every function resolves to a plain object. Refusals are
// { ok: false, code, message, remedy }; successes carry { ok: true, ... }.
// Every function accepts { env, home, hostname, root, cwd } options so tests
// and the CLI control the environment without touching process state.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir, hostname as osHostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveCheckout } from '../repo-search/identity.mjs';
import { parseKit } from '../workspaces/kit.mjs';
import { describeStorageRoot, resolveRepositoryPath, storageStatus, writeFileAtomic } from '../workspaces/store.mjs';

const run = promisify(execFile);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const REF = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const STAMP_BEGIN = '<!-- spec-location:begin -->';
const STAMP_END = '<!-- spec-location:end -->';
const STEP_CARD = /^step-\d+-subspec\.md$/;
const SETUP_REMEDY = 'Run the adjacent-storage-setup skill, or: node scripts/workspaces/cli.mjs setup --root <root> --save';

const refuse = (code, message, remedy) => ({ ok: false, code, message, remedy });
const isDir = async path => (await fs.stat(path).catch(() => null))?.isDirectory() === true;
const exists = async path => (await fs.stat(path).catch(() => null)) !== null;
const readJson = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const writeJson = (path, value) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

const firstLabel = host => host.split('.')[0].toLowerCase();
const hostLabel = options => firstLabel(options.hostname ?? osHostname());
const plainName = value => typeof value === 'string' && value !== '' && value !== '.' && value !== '..' && !/[\\/]/.test(value);

// `git check-ref-format --branch` also expands @{-N}; requiring the echoed name to equal the input rejects that.
async function validBranch(name) {
  try { return typeof name === 'string' && (await run('git', ['check-ref-format', '--branch', name])).stdout.trim() === name; } catch { return false; }
}

async function commonDirOf(path) {
  try { return (await resolveCheckout(path)).commonDir; } catch { return null; }
}

/**
 * Entries of `<primary>/.specs` that git does not track: the legacy package
 * layout that `migrate` moves into the storage root. Missing `.specs` -> [].
 */
export async function legacySpecs(primary) {
  let names;
  try { names = await fs.readdir(join(primary, '.specs')); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
  let tracked;
  try {
    const { stdout } = await run('git', ['-C', primary, 'ls-files', '-z', '--', '.specs'], { maxBuffer: 64 * 1024 * 1024 });
    tracked = new Set(stdout.split('\0').filter(Boolean).map(file => file.split('/')[1]));
  } catch (error) {
    throw new Error(`git ls-files failed in ${primary}: ${error.stderr?.trim() || error.message}`, { cause: error });
  }
  return names.filter(name => !tracked.has(name)).sort();
}

// Storage root + workspace directory, with no host, repository or legacy checks.
async function locateWorkspace(workspace, options) {
  let storage;
  try { storage = describeStorageRoot(options.env ?? process.env, options.home ?? homedir(), options.root); } catch (error) {
    return refuse('storage-unavailable', error.message, SETUP_REMEDY);
  }
  const status = await storageStatus(storage.root);
  if (status.status !== 'ok') {
    return refuse('storage-unavailable', `Storage root ${storage.root} is not usable (${status.status}).`, SETUP_REMEDY);
  }
  if (!SLUG.test(workspace ?? '')) {
    return refuse('workspace-not-found', `No workspace named ${JSON.stringify(workspace)}.`, 'Run: node scripts/workspaces/cli.mjs list');
  }
  const workspaceDir = join(storage.root, 'projects', workspace);
  const read = await readKit(workspaceDir);
  if (!read) return refuse('workspace-not-found', `No kit.yaml in ${workspaceDir}.`, 'Run: node scripts/workspaces/cli.mjs list');
  if (read.errors) return refuse('kit-invalid', `kit.yaml in ${workspaceDir} is invalid: ${read.errors.join('; ')}`, 'Fix kit.yaml.');
  return { ok: true, storageRoot: storage.root, storageSource: storage.source, workspace, workspaceDir, kit: read.kit };
}

async function readKit(workspaceDir) {
  let text;
  try { text = await fs.readFile(join(workspaceDir, 'kit.yaml'), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parseKit(text);
  return parsed.ok ? { kit: parsed.kit } : { errors: parsed.errors };
}

function primaryOf(located, repo, options) {
  return resolveRepositoryPath(located.workspaceDir, repo.path, options.home ?? homedir());
}

// Workspace checks up to and including the execution host; no legacy check.
async function loadWorkspace(options) {
  let located;
  if (options.workspace) {
    located = await locateWorkspace(options.workspace, options);
    if (!located.ok) return located;
  } else {
    located = await findByCwd(options.cwd ?? process.cwd(), options);
    if (!located.ok) return located;
  }
  let repository = located.repository ?? null;
  if (options.workspace && options.cwd) {
    const common = await commonDirOf(options.cwd);
    for (const repo of located.kit.repositories) {
      if (common && common === await commonDirOf(primaryOf(located, repo, options))) { repository = repo.id; break; }
    }
    if (!repository) return notInKit(options.cwd);
  }
  const { kit } = located;
  // migrate runs wherever the legacy .specs data is; the execution host then
  // runs `materialize` to write its own locations. Authoring (architecture,
  // spec writing) may run on any machine; see `open` for its limit.
  const offHost = Boolean(kit.execution_host) && firstLabel(kit.execution_host) !== hostLabel(options);
  if (options.authoring) return workspaceResult(located, repository, offHost);
  if (!options.anyHost && !kit.execution_host) {
    return refuse('execution-host-unset', `Workspace ${located.workspace} has no execution_host.`,
      `Run: node scripts/workspaces/cli.mjs set-execution-host ${located.workspace} --host <hostname> --apply`);
  }
  if (!options.anyHost && offHost) {
    return refuse('wrong-host', `Workspace ${located.workspace} executes on ${firstLabel(kit.execution_host)}; this machine is ${hostLabel(options)}.`,
      `Run spec work on ${kit.execution_host}, or change the host with set-execution-host.`);
  }
  return workspaceResult(located, repository, offHost);
}

function workspaceResult(located, repository, offHost) {
  const base = located.workspaceDir;
  return {
    ok: true, storageRoot: located.storageRoot, storageSource: located.storageSource, workspace: located.workspace,
    workspaceDir: base, specsDir: join(base, 'specs'), projectContext: join(base, 'project-context.md'),
    epicsDir: join(base, 'epics'), plansDir: join(base, 'plans'), capturesDir: join(base, 'captures'),
    kit: located.kit, repository, executionHost: located.kit.execution_host, offHost,
  };
}

function notInKit(cwd) {
  return refuse('repository-not-in-kit', `${cwd} is not in any workspace kit.`,
    'Run: node scripts/workspaces/cli.mjs add-repo <workspace> --id <id> --path <path> --apply');
}

async function findByCwd(cwd, options) {
  const first = await locateStorageOnly(options);
  if (!first.ok) return first;
  const common = await commonDirOf(cwd);
  const matches = [];
  if (common) {
    for (const name of await fs.readdir(join(first.storageRoot, 'projects')).catch(() => [])) {
      if (!SLUG.test(name)) continue;
      const located = await locateWorkspace(name, options);
      if (!located.ok) continue;
      for (const repo of located.kit.repositories) {
        if (common === await commonDirOf(primaryOf(located, repo, options))) { matches.push({ ...located, repository: repo.id }); break; }
      }
    }
  }
  if (matches.length === 0) return notInKit(cwd);
  if (matches.length > 1) {
    return refuse('repository-in-multiple-kits', `${cwd} is in workspaces ${matches.map(m => m.workspace).join(', ')}.`, 'Pass --workspace <id>.');
  }
  return matches[0];
}

async function locateStorageOnly(options) {
  let storage;
  try { storage = describeStorageRoot(options.env ?? process.env, options.home ?? homedir(), options.root); } catch (error) {
    return refuse('storage-unavailable', error.message, SETUP_REMEDY);
  }
  const status = await storageStatus(storage.root);
  if (status.status !== 'ok') return refuse('storage-unavailable', `Storage root ${storage.root} is not usable (${status.status}).`, SETUP_REMEDY);
  return { ok: true, storageRoot: storage.root };
}

/**
 * Resolve the workspace for `workspace` or for the git checkout containing
 * `cwd`, and refuse unless this machine may run spec work for it.
 */
export async function resolveWorkspace(options = {}) {
  const ws = await loadWorkspace(options);
  if (!ws.ok) return ws;
  for (const repo of ws.kit.repositories) {
    const primary = primaryOf(ws, repo, options);
    let legacy;
    try { legacy = await legacySpecs(primary); } catch (error) {
      return refuse('legacy-check-failed', error.message, `Fix the git repository at ${primary}, then rerun.`);
    }
    if (legacy.length > 0) {
      return refuse('legacy-specs-present', `${repo.id} (${primary}) still has untracked .specs/ entries.`,
        `Run: node scripts/spec-location/cli.mjs migrate --workspace ${ws.workspace}`);
    }
  }
  return ws;
}

// Creates project-context.md and captures/ so every recorded path exists.
async function ensureWorkspaceFiles(ws) {
  await fs.mkdir(ws.capturesDir, { recursive: true });
  if (!await exists(ws.projectContext)) await writeFileAtomic(ws.projectContext, '# Project context\n');
}

// scope.json + kit -> locations.json content for this machine.
async function buildLocations(ws, scope, existing, options) {
  const packageDir = join(ws.specsDir, scope.slug);
  const targets = [];
  for (const target of scope.targets) {
    const repo = ws.kit.repositories.find(entry => entry.id === target.id);
    if (!repo) return refuse('target-not-in-kit', `Target ${target.id} is not a repository in workspace ${ws.workspace}.`,
      `Run: node scripts/workspaces/cli.mjs add-repo ${ws.workspace} --id ${target.id} --path <path> --apply`);
    const primary = primaryOf(ws, repo, options);
    const prior = existing?.targets?.find(entry => entry.id === target.id)?.worktree ?? null;
    targets.push({
      id: target.id, primary, common: await commonDirOf(primary), branch: target.branch,
      worktree: prior && await isDir(prior) ? prior : null,
    });
  }
  return {
    ok: true,
    locations: {
      schema_version: 1, package_ref: `${ws.workspace}/${scope.slug}`, execution_host: ws.executionHost,
      materialized_at: new Date().toISOString(), storage_root: ws.storageRoot, workspace_dir: ws.workspaceDir,
      package_dir: packageDir, project_context: ws.projectContext, kit: join(ws.workspaceDir, 'kit.yaml'),
      plan: scope.plan ? join(ws.plansDir, scope.plan) : null,
      epic: scope.epic ? join(ws.epicsDir, scope.epic, 'epic.json') : null,
      captures_dir: ws.capturesDir,
      designs: scope.designs.map(ref => ({ ref, dir: join(ws.storageRoot, 'projects', ref.split('/')[0], 'designs', ref.split('/')[1]) })),
      targets,
    },
  };
}

async function materializeIn(ws, slug, options) {
  const packageDir = join(ws.specsDir, slug);
  const scope = await readJson(join(packageDir, 'scope.json')).catch(() => null);
  if (!scope) return refuse('package-not-found', `${packageDir} has no readable scope.json.`, 'Create the package with: spec-location new');
  const existing = await readJson(join(packageDir, 'locations.json')).catch(() => null);
  const built = await buildLocations(ws, scope, existing, options);
  if (!built.ok) return built;
  await ensureWorkspaceFiles(ws);
  await writeJson(join(packageDir, 'locations.json'), built.locations);
  await stampIn(packageDir, built.locations);
  return { ok: true, locations: built.locations };
}

/** Create `specs/<slug>/` with scope.json and locations.json. */
export async function newPackage(args) {
  const { workspace, slug, targets, designs = [], plan = null, epic = null, ...options } = args;
  if (!SLUG.test(slug ?? '')) return refuse('invalid-input', `Slug ${JSON.stringify(slug)} must match [a-z0-9][a-z0-9-]*.`, 'Choose another slug.');
  if (!Array.isArray(targets) || targets.length === 0) return refuse('invalid-input', 'At least one target is required.', 'Pass --target ID[:BRANCH].');
  if (plan !== null && !plainName(plan)) return refuse('invalid-input', `Plan ${JSON.stringify(plan)} must be a plain file name.`, 'Use a name without / or .. ; plans live in the workspace plans/ directory.');
  for (const target of targets) {
    if (target.branch !== undefined && !await validBranch(target.branch)) return refuse('invalid-input', `Branch ${JSON.stringify(target.branch)} is not a valid git branch name.`, 'Choose another branch name.');
  }
  const ws = await resolveWorkspace({ ...options, workspace });
  if (!ws.ok) return ws;
  const packageDir = join(ws.specsDir, slug);
  if (await exists(packageDir)) return refuse('package-exists', `${workspace}/${slug} already exists.`, 'Choose another slug.');
  const scope = {
    schema_version: 1, workspace, slug,
    targets: targets.map(target => ({ id: target.id, branch: target.branch ?? `spec-${slug}` })),
    designs, plan, epic,
  };
  const built = await buildLocations(ws, scope, null, options);
  if (!built.ok) return built;
  await ensureWorkspaceFiles(ws);
  await fs.mkdir(packageDir, { recursive: true });
  await writeJson(join(packageDir, 'scope.json'), scope);
  await writeJson(join(packageDir, 'locations.json'), built.locations);
  await stampIn(packageDir, built.locations);
  return { ok: true, locations: built.locations };
}

/** Resolve `ws/slug`, a package directory, or a file inside one. */
export async function locatePackage(input, options = {}) {
  const value = String(input);
  let storageRoot;
  let workspace;
  let slug;
  if (!isAbsolute(value) && REF.test(value)) {
    [workspace, slug] = value.split('/');
    const storage = await locateStorageOnly(options);
    if (!storage.ok) return storage;
    storageRoot = storage.storageRoot;
  } else {
    const absolute = resolve(options.cwd ?? process.cwd(), value);
    const match = /^(.*)\/projects\/([a-z0-9][a-z0-9-]*)\/specs\/([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(absolute);
    if (match && await exists(join(match[1], 'projects', match[2], 'kit.yaml'))) {
      [, storageRoot, workspace, slug] = match;
    } else {
      let probe = absolute;
      while (!await exists(probe) && dirname(probe) !== probe) probe = dirname(probe);
      probe = await isDir(probe) ? probe : dirname(probe);
      if (await commonDirOf(probe)) {
        return refuse('legacy-location', `${value} is inside a git checkout, not in the storage root.`,
          'Run: node scripts/spec-location/cli.mjs migrate --workspace <workspace>');
      }
      return refuse('package-not-found', `${value} is not a package.`, 'Use ws/slug or a path under <storage root>/projects/<ws>/specs/<slug>.');
    }
  }
  const packageDir = join(storageRoot, 'projects', workspace, 'specs', slug);
  if (!await isDir(packageDir)) return refuse('package-not-found', `${workspace}/${slug} does not exist.`, 'Run: node scripts/spec-location/cli.mjs new');
  return { ok: true, packageDir, ref: `${workspace}/${slug}`, workspace, slug, storageRoot };
}

// Locate + resolveWorkspace with the same storage root the package was found in.
// Off the execution host, authoring stops once the runtime has recorded a
// worktree: from then on runtime/, leases and worktrees exist only on the host.
async function open(input, options) {
  const found = await locatePackage(input, options);
  if (!found.ok) return found;
  const ws = await resolveWorkspace({ ...options, workspace: found.workspace, cwd: undefined, root: found.storageRoot });
  if (!ws.ok) return ws;
  if (ws.offHost) {
    const recorded = await readJson(join(found.packageDir, 'locations.json')).catch(() => null);
    if (recorded?.targets?.some(target => target.worktree)) {
      return refuse('execution-started', `${found.ref} has a recorded worktree; its execution belongs to ${ws.executionHost}.`,
        `Continue ${found.ref} on ${ws.executionHost}.`);
    }
  }
  return { ...found, ws };
}

/** Read-only verification that this machine can work on the package. */
export async function checkPackage(input, options = {}) {
  const opened = await open(input, options);
  if (!opened.ok) return opened;
  const { packageDir, ref, ws } = opened;
  let locations;
  let remedy = `Run: node scripts/spec-location/cli.mjs materialize ${ref}`;
  if (ws.offHost) {
    // locations.json holds the execution host's paths; authoring here gets this
    // machine's, computed and not saved.
    const scope = await readJson(join(packageDir, 'scope.json')).catch(() => null);
    if (!scope) return refuse('package-not-found', `${packageDir} has no readable scope.json.`, 'Create the package with: spec-location new');
    const built = await buildLocations(ws, scope, null, options);
    if (!built.ok) return built;
    locations = built.locations;
    remedy = `Sync workspace storage with ${ws.executionHost}, then rerun.`;
  } else {
    locations = await readJson(join(packageDir, 'locations.json')).catch(() => null);
    if (!locations) return refuse('locations-missing', `${ref} has no readable locations.json.`, remedy);
  }
  const recorded = [locations.storage_root, locations.workspace_dir, locations.package_dir, locations.project_context, locations.kit,
    locations.plan, locations.epic, locations.captures_dir, ...locations.designs.map(d => d.dir), ...locations.targets.map(t => t.worktree)];
  for (const path of recorded) {
    if (path && !await exists(path)) return refuse('path-missing', `${ref}: recorded path ${path} does not exist.`, remedy);
  }
  for (const target of locations.targets) {
    if (!ws.kit.repositories.some(repo => repo.id === target.id)) {
      return refuse('target-not-in-kit', `${ref}: target ${target.id} is no longer a kit repository.`,
        `Run: node scripts/workspaces/cli.mjs add-repo ${ws.workspace} --id ${target.id} --path <path> --apply`);
    }
    if (!await isDir(target.primary)) {
      return refuse('target-missing', `${ref}: primary checkout ${target.primary} for ${target.id} is not on this machine.`,
        `Clone ${target.id} to ${target.primary}, or fix the kit path with set-path.`);
    }
  }
  return { ok: true, locations };
}

/** This machine's locations for a package, computed from scope.json + kit without writing. */
export async function previewLocations(input, options = {}) {
  const opened = await open(input, options);
  if (!opened.ok) return opened;
  const scope = await readJson(join(opened.packageDir, 'scope.json')).catch(() => null);
  if (!scope) return refuse('package-not-found', `${opened.packageDir} has no readable scope.json.`, 'Create the package with: spec-location new');
  return buildLocations(opened.ws, scope, null, options);
}

/** Rewrite locations.json from scope.json + kit, then refresh the stamps. */
export async function materialize(input, options = {}) {
  const opened = await open(input, options);
  if (!opened.ok) return opened;
  return materializeIn(opened.ws, opened.slug, options);
}

function stampBlock(locations) {
  const lines = [
    STAMP_BEGIN,
    '**Spec location** (generated by spec-location; do not edit)',
    '',
    `- Package: \`${locations.package_ref}\` at \`${locations.package_dir}\``,
    `- Project context: \`${locations.project_context}\``,
    `- Plan: ${locations.plan ? `\`${locations.plan}\`` : 'none'}`,
    `- Epic: ${locations.epic ? `\`${locations.epic}\`` : 'none'}`,
    `- Designs: ${locations.designs.length ? locations.designs.map(d => `\`${d.ref}\` at \`${d.dir}\``).join(', ') : 'none'}`,
    `- Captures: \`${locations.captures_dir}\``,
    '- Targets:',
    ...locations.targets.map(t => `  - \`${t.id}\`: primary \`${t.primary}\`, branch \`${t.branch}\`, worktree ${t.worktree ? `\`${t.worktree}\`` : 'none'}`),
    STAMP_END,
  ];
  return lines.join('\n');
}

function stamped(text, block) {
  const begin = text.indexOf(STAMP_BEGIN);
  const end = text.indexOf(STAMP_END);
  if (begin !== -1 && end > begin) return text.slice(0, begin) + block + text.slice(end + STAMP_END.length);
  const lines = text.split('\n');
  const h1 = lines.findIndex(line => /^# /.test(line));
  if (h1 === -1) return text === '' ? `${block}\n` : `${block}\n\n${text}`;
  const rest = lines.slice(h1 + 1);
  if (rest.length > 0 && rest[0] !== '') rest.unshift('');
  return [...lines.slice(0, h1 + 1), '', block, ...rest].join('\n');
}

async function stampIn(packageDir, locations) {
  const block = stampBlock(locations);
  const done = [];
  for (const name of (await fs.readdir(packageDir)).sort()) {
    if (name !== 'context.md' && name !== 'spec.md' && !STEP_CARD.test(name)) continue;
    const file = join(packageDir, name);
    const before = await fs.readFile(file, 'utf8');
    const after = stamped(before, block);
    if (after !== before) await writeFileAtomic(file, after);
    done.push(name);
  }
  return done;
}

/** Write the location block into context.md, spec.md and every step card. */
export async function stamp(input, options = {}) {
  const found = await locatePackage(input, options);
  if (!found.ok) return found;
  const locations = await readJson(join(found.packageDir, 'locations.json')).catch(() => null);
  if (!locations) return refuse('locations-missing', `${found.ref} has no readable locations.json.`, `Run: node scripts/spec-location/cli.mjs materialize ${found.ref}`);
  return { ok: true, files: await stampIn(found.packageDir, locations) };
}

function parseTarget(spec) {
  return typeof spec === 'string' ? { id: spec.split(':')[0], branch: spec.split(':')[1] } : spec;
}

/** Edit scope.json (add a target or design, set or clear plan and epic), then materialize. */
export async function updateScope(input, change, options = {}) {
  const opened = await open(input, options);
  if (!opened.ok) return opened;
  const { ws, packageDir, slug } = opened;
  const scope = await readJson(join(packageDir, 'scope.json'));
  if (change.addTarget) {
    const target = parseTarget(change.addTarget);
    if (!ws.kit.repositories.some(repo => repo.id === target.id)) {
      return refuse('target-not-in-kit', `Target ${target.id} is not a repository in workspace ${ws.workspace}.`,
        `Run: node scripts/workspaces/cli.mjs add-repo ${ws.workspace} --id ${target.id} --path <path> --apply`);
    }
    if (target.branch !== undefined && !await validBranch(target.branch)) {
      return refuse('invalid-input', `Branch ${JSON.stringify(target.branch)} is not a valid git branch name.`, 'Choose another branch name.');
    }
    if (scope.targets.some(entry => entry.id === target.id)) {
      return refuse('target-exists', `${opened.ref} already targets ${target.id}.`, 'Edit scope.json only through spec-location.');
    }
    scope.targets.push({ id: target.id, branch: target.branch ?? `spec-${slug}` });
  }
  if (change.addDesign && !scope.designs.includes(change.addDesign)) {
    if (!REF.test(change.addDesign)) return refuse('invalid-input', `Design ref ${change.addDesign} must be <workspace>/<design>.`, 'Use ws/design.');
    scope.designs.push(change.addDesign);
  }
  if (change.setPlan !== undefined) {
    if (change.setPlan !== null && !plainName(change.setPlan)) return refuse('invalid-input', `Plan ${JSON.stringify(change.setPlan)} must be a plain file name.`, 'Use a name without / or .. ; plans live in the workspace plans/ directory.');
    scope.plan = change.setPlan;
  }
  if (change.setEpic !== undefined) {
    if (change.setEpic !== null && !SLUG.test(change.setEpic)) return refuse('invalid-input', `Epic ${change.setEpic} must be a slug.`, 'Use an epic slug.');
    scope.epic = change.setEpic;
  }
  await writeJson(join(packageDir, 'scope.json'), scope);
  return materializeIn(ws, slug, options);
}

/** Record a target worktree in locations.json (runtime use). */
export async function setWorktree(input, targetId, path, options = {}) {
  const found = await locatePackage(input, options);
  if (!found.ok) return found;
  const file = join(found.packageDir, 'locations.json');
  const locations = await readJson(file).catch(() => null);
  if (!locations) return refuse('locations-missing', `${found.ref} has no readable locations.json.`, `Run: node scripts/spec-location/cli.mjs materialize ${found.ref}`);
  const target = locations.targets.find(entry => entry.id === targetId);
  if (!target) return refuse('target-not-in-scope', `${found.ref} does not target ${targetId}.`, 'Add it with: spec-location scope --add-target');
  target.worktree = path;
  await writeJson(file, locations);
  return { ok: true, locations };
}

/**
 * `setWorktree` for a path given by a person: PATH must be the root of a git
 * worktree of the target's repository. Refreshes the stamps afterwards.
 */
export async function recordWorktree(input, targetId, path, options = {}) {
  const found = await locatePackage(input, options);
  if (!found.ok) return found;
  const locations = await readJson(join(found.packageDir, 'locations.json')).catch(() => null);
  if (!locations) return refuse('locations-missing', `${found.ref} has no readable locations.json.`, `Run: node scripts/spec-location/cli.mjs materialize ${found.ref}`);
  const target = locations.targets.find(entry => entry.id === targetId);
  if (!target) return refuse('target-not-in-scope', `${found.ref} does not target ${targetId}.`, 'Add it with: spec-location scope --add-target');
  const absolute = resolve(options.cwd ?? process.cwd(), path);
  const checkout = await resolveCheckout(absolute).catch(() => null);
  const common = await commonDirOf(target.primary);
  if (!checkout || checkout.root !== await fs.realpath(absolute) || !common || checkout.commonDir !== common) {
    return refuse('not-a-worktree', `${absolute} is not the root of a git worktree of ${targetId} (${target.primary}).`,
      `Create one with: git -C ${target.primary} worktree add <path> <branch>`);
  }
  const recorded = await setWorktree(input, targetId, checkout.root, options);
  if (!recorded.ok) return recorded;
  await stamp(input, options);
  return recorded;
}

/** Package slugs of a workspace (directories under specs/ not starting with _ or .). */
export async function listPackages(workspace, options = {}) {
  const located = await locateWorkspace(workspace, options);
  if (!located.ok) return located;
  const specsDir = join(located.workspaceDir, 'specs');
  const names = (await fs.readdir(specsDir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && SLUG.test(entry.name)).map(entry => entry.name).sort();
  return { ok: true, packages: names.map(slug => ({ slug, ref: `${workspace}/${slug}`, packageDir: join(specsDir, slug) })) };
}

/** Epics of a workspace with each member resolved to its package directory. */
export async function listEpics(workspace, options = {}) {
  const located = await locateWorkspace(workspace, options);
  if (!located.ok) return located;
  const epicsDir = join(located.workspaceDir, 'epics');
  const epics = [];
  for (const entry of (await fs.readdir(epicsDir, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(epicsDir, entry.name, 'epic.json');
    let record;
    try { record = await readJson(file); } catch (error) {
      epics.push({ slug: entry.name, record: file, error: error.message, members: [] });
      continue;
    }
    const members = [];
    for (const member of record.packages ?? []) {
      const packageDir = join(located.workspaceDir, 'specs', member.package);
      members.push({ slug: member.package, packageDir, exists: await isDir(packageDir) });
    }
    epics.push({ slug: entry.name, record: file, epic: record, members });
  }
  return { ok: true, epics };
}

// migrate ------------------------------------------------------------------

async function walk(root, skip, base = root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const rel = relative(base, path).split('\\').join('/');
    if (entry.isDirectory()) files.push(...await walk(path, skip, base));
    else if (entry.isFile() && !skip(rel)) files.push(rel);
  }
  return files.sort();
}

function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Decide how a package file changes on the way over: null (copy as is), 'reshape'
// (single-target pr-url.json) or 'paths' (rewrite the old package path).
async function classify(root, rel, oldPackage) {
  if (!rel.endsWith('.json') || rel.startsWith('runtime/runs/')) return null;
  const text = await fs.readFile(join(root, rel), 'utf8');
  if (rel === 'pr-url.json') {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value) && !value.targets) return 'reshape';
    } catch { /* fall through to a plain path rewrite */ }
  }
  return pathPattern(oldPackage).test(text) ? 'paths' : null;
}

const pathPattern = oldPackage => new RegExp(`${escapeRegExp(oldPackage)}(?![A-Za-z0-9_-])`, 'g');

function transformer(kind, ctx) {
  if (kind === 'reshape') {
    return text => {
      // Match the shape spec-pr writes: mode replaces the legacy draft flags, submitted_at the camelCase key.
      const { package: _package, schema_version: _version, kind: _kind, draft, isDraft, is_draft: isDraftSnake, submittedAt, ...rest } = JSON.parse(text);
      const flag = [draft, isDraft, isDraftSnake].find(value => value !== undefined);
      const target = { ...rest };
      if (flag !== undefined && target.mode === undefined) target.mode = flag ? 'draft' : 'ready';
      if (submittedAt !== undefined && target.submitted_at === undefined) target.submitted_at = submittedAt;
      if (typeof target.tour === 'string') target.tour = target.tour.replace(pathPattern(ctx.oldPackage), () => ctx.newPackage);
      return `${JSON.stringify({ schema_version: 1, kind: 'pr_submission', package_ref: ctx.ref, targets: { [ctx.repoId]: target } }, null, 2)}\n`;
    };
  }
  if (kind === 'paths') return text => text.replace(pathPattern(ctx.oldPackage), () => ctx.newPackage);
  if (kind === 'epic') {
    return text => {
      const record = JSON.parse(text);
      record.packages = (record.packages ?? []).map(({ repository: _repository, ...member }) => member);
      if (typeof record.plan === 'string' && record.plan.includes('_plans/')) record.plan = basename(record.plan);
      return `${JSON.stringify(record, null, 2)}\n`;
    };
  }
  return null;
}

// Copy `files` from src to dest. A file with a transform is rewritten; every
// other file is hash-verified against its source. `created` collects dest roots
// so a failure can remove what this run wrote.
async function copyFiles(src, dest, files, transforms) {
  const rewritten = [];
  for (const rel of files) {
    const from = join(src, rel);
    const to = join(dest, rel);
    await fs.mkdir(dirname(to), { recursive: true });
    const transform = transforms[rel];
    if (transform) {
      await fs.writeFile(to, transform(await fs.readFile(from, 'utf8')));
      rewritten.push(rel);
    } else {
      await fs.copyFile(from, to);
      if (await sha256File(from) !== await sha256File(to)) throw Object.assign(new Error(`sha256 mismatch copying ${from}`), { code: 'verify-failed' });
    }
  }
  return rewritten;
}

async function movePath(from, to) {
  await fs.mkdir(dirname(to), { recursive: true });
  try { await fs.rename(from, to); } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.cp(from, to, { recursive: true });
    await fs.rm(from, { recursive: true });
  }
}

// A rerun after a partial migrate: the destination package was written for this repository and slug.
async function alreadyMigrated(ws, repoId, slug) {
  const scope = await readJson(join(ws.specsDir, slug, 'scope.json')).catch(() => null);
  return scope?.slug === slug && scope.targets?.length === 1 && scope.targets[0].id === repoId;
}

async function planRepository(ws, repo, options, includeTranscripts) {
  const primary = primaryOf(ws, repo, options);
  if (!await isDir(primary)) return { id: repo.id, primary, skipped: 'primary checkout not found on this machine' };
  const entries = await legacySpecs(primary);
  if (entries.length === 0) return null;
  const specs = join(primary, '.specs');
  const plan = { id: repo.id, primary, entries, packages: [], epics: [], plans: [], captures: [], projectContext: null, unmigrated: [], warnings: [] };
  for (const name of entries) {
    const path = join(specs, name);
    const isDirectory = await isDir(path);
    if (name === 'project-context.md' && !isDirectory) plan.projectContext = path;
    else if (name === '_plans' && isDirectory) plan.plans.push({ from: path, files: await walk(path, () => false) });
    else if (name === '_epics' && isDirectory) {
      for (const epic of (await fs.readdir(path, { withFileTypes: true })).filter(e => e.isDirectory() && SLUG.test(e.name))) {
        plan.epics.push({ slug: epic.name, from: join(path, epic.name), files: await walk(join(path, epic.name), () => false) });
      }
    } else if ((name === 'images' || name === 'ux-qa') && isDirectory) {
      // ux-qa/runs holds harness session files that embed database URLs; they stay in the legacy archive.
      const files = await walk(path, rel => name === 'ux-qa' && rel.startsWith('runs/'));
      plan.captures.push({ kind: name, from: path, files });
      if (name === 'ux-qa' && await isDir(join(path, 'runs'))) {
        plan.unmigrated.push({ name: 'ux-qa/runs', reason: 'harness session files contain database URLs; left in the legacy archive' });
      }
    } else if (isDirectory && !name.startsWith('_') && !name.startsWith('.')) {
      // Run receipts migrate; only raw transcripts and logs under runtime/runs/ are left in the archive.
      const skipped = [];
      const skipRuns = rel => {
        const raw = !includeTranscripts && rel.startsWith('runtime/runs/') && /\.(jsonl|log)$/.test(rel);
        if (raw) skipped.push(rel);
        return raw;
      };
      const files = await walk(path, skipRuns);
      const transforms = {};
      for (const rel of files) {
        const kind = await classify(path, rel, path);
        if (kind) transforms[rel] = kind;
      }
      plan.packages.push({ slug: name, from: path, files, kinds: transforms, transcriptsExcluded: skipped.length > 0, migrated: await alreadyMigrated(ws, repo.id, name) });
    } else plan.unmigrated.push({ name, reason: 'not a package, epic, plan or capture directory' });
  }
  return plan;
}

async function activeRuns(plans) {
  const active = [];
  for (const plan of plans) {
    for (const pkg of plan.packages ?? []) {
      const record = await readJson(join(pkg.from, 'runtime', 'run.json')).catch(() => null);
      if (record && ['running', 'cancelling', 'blocked'].includes(record.state)
        && (pidAlive(record.coordinator_pid) || pidAlive(record.pid))) active.push(`${plan.id}/${pkg.slug}`);
    }
  }
  return active;
}

function summarize(plan, ws, archive) {
  return {
    id: plan.id, primary: plan.primary, ...(plan.skipped ? { skipped: plan.skipped } : {
      packages: plan.packages.map(pkg => ({
        slug: pkg.slug, from: pkg.from, to: join(ws.specsDir, pkg.slug), files: pkg.files.length,
        rewritten: Object.keys(pkg.kinds), transcripts_excluded: pkg.transcriptsExcluded, already_migrated: pkg.migrated,
      })),
      epics: plan.epics.map(epic => ({ slug: epic.slug, from: epic.from, to: join(ws.epicsDir, epic.slug), files: epic.files.length })),
      plans: plan.plans.flatMap(entry => entry.files.map(file => ({ name: file, to: join(ws.plansDir, file) }))),
      captures: plan.captures.map(entry => ({ kind: entry.kind, to: join(ws.capturesDir, plan.id, entry.kind), files: entry.files.length })),
      project_context: plan.projectContext ? plan.contextAction : null,
      unmigrated: plan.unmigrated,
      archive,
      warnings: plan.warnings,
    }),
  };
}

/**
 * Move a workspace's legacy `.specs/` content into the storage root. Preview
 * by default; `apply: true` copies, verifies, rewrites and archives.
 */
export async function migrate(args) {
  const { workspace, apply = false, includeTranscripts = false, ...options } = args;
  const ws = await loadWorkspace({ ...options, workspace, cwd: undefined, anyHost: true });
  if (!ws.ok) return ws;
  const env = options.env ?? process.env;
  const dataHome = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(options.home ?? homedir(), '.local', 'share');
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');

  const plans = [];
  for (const repo of ws.kit.repositories) {
    let plan;
    try { plan = await planRepository(ws, repo, options, includeTranscripts); } catch (error) {
      if (!error.cause) throw error;
      return refuse('legacy-check-failed', error.message, `Fix the git repository for ${repo.id}, then rerun.`);
    }
    if (plan) plans.push(plan);
  }
  const migrating = plans.filter(plan => !plan.skipped);

  const active = await activeRuns(migrating);
  if (active.length > 0) {
    return refuse('run-active', `A run is active for ${active.join(', ')}.`, 'Wait for the run to finish or cancel it, then migrate.');
  }

  const collisions = [];
  const seen = new Map();
  const claim = (kind, name, label) => {
    const key = `${kind}:${name}`;
    if (seen.has(key)) collisions.push(`${kind} ${name} appears in ${seen.get(key)} and ${label}`);
    else seen.set(key, label);
  };
  for (const plan of migrating) {
    for (const pkg of plan.packages) {
      if (!SLUG.test(pkg.slug)) collisions.push(`${plan.id}/${pkg.slug} is not a valid slug`);
      claim('package', pkg.slug, plan.id);
      if (!pkg.migrated && await exists(join(ws.specsDir, pkg.slug))) collisions.push(`package ${pkg.slug} already exists in ${ws.workspace}`);
    }
    for (const epic of plan.epics) {
      claim('epic', epic.slug, plan.id);
      if (await exists(join(ws.epicsDir, epic.slug))) collisions.push(`epic ${epic.slug} already exists in ${ws.workspace}`);
    }
    for (const entry of plan.plans) {
      for (const file of entry.files) {
        claim('plan', file, plan.id);
        if (await exists(join(ws.plansDir, file))) collisions.push(`plan ${file} already exists in ${ws.workspace}`);
      }
    }
    for (const entry of plan.captures) {
      if (await exists(join(ws.capturesDir, plan.id, entry.kind))) collisions.push(`captures/${plan.id}/${entry.kind} already exists`);
    }
  }
  if (collisions.length > 0) {
    const unique = [...new Set(collisions)];
    return { ...refuse('slug-collision', `Cannot migrate: ${unique.join('; ')}.`, 'Rename the legacy entries, or remove the existing ones, then rerun.'), collisions: unique };
  }

  const contextText = await fs.readFile(ws.projectContext, 'utf8').catch(() => '');
  for (const plan of migrating) {
    if (!plan.projectContext) continue;
    const heading = `## Repository: ${plan.id}`;
    plan.contextAction = contextText.split('\n').includes(heading) ? 'skip (section exists)' : 'append';
    if (plan.contextAction === 'append') plan.warnings.push('review project-context.md');
  }

  const archives = new Map();
  for (const plan of migrating) {
    let archive = join(dataHome, 'spec-location', 'legacy', ws.workspace, `${plan.id}-${day}`);
    for (let n = 2; apply && await exists(archive); n += 1) archive = join(dataHome, 'spec-location', 'legacy', ws.workspace, `${plan.id}-${day}-${n}`);
    archives.set(plan.id, archive);
  }

  const result = () => ({
    ok: true, apply, workspace: ws.workspace,
    repositories: plans.map(plan => summarize(plan, ws, archives.get(plan.id))),
  });
  if (!apply) return result();

  const epicOf = new Map();
  for (const plan of migrating) {
    for (const epic of plan.epics) {
      const record = await readJson(join(epic.from, 'epic.json')).catch(() => null);
      for (const member of record?.packages ?? []) if (!epicOf.has(member.package)) epicOf.set(member.package, epic.slug);
    }
  }

  for (const plan of migrating) {
    const created = [];
    try {
      for (const pkg of plan.packages) {
        if (pkg.migrated) continue;
        const to = join(ws.specsDir, pkg.slug);
        created.push(to);
        await fs.mkdir(to, { recursive: true });
        const ctx = { ref: `${ws.workspace}/${pkg.slug}`, repoId: plan.id, oldPackage: pkg.from, newPackage: to };
        const transforms = Object.fromEntries(Object.entries(pkg.kinds).map(([rel, kind]) => [rel, transformer(kind, ctx)]));
        await copyFiles(pkg.from, to, pkg.files, transforms);
        await writeJson(join(to, 'scope.json'), {
          schema_version: 1, workspace: ws.workspace, slug: pkg.slug,
          targets: [{ id: plan.id, branch: `spec-${pkg.slug}` }], designs: [], plan: null, epic: epicOf.get(pkg.slug) ?? null,
        });
      }
      for (const epic of plan.epics) {
        const to = join(ws.epicsDir, epic.slug);
        created.push(to);
        const epicFile = epic.files.includes('epic.json') ? { 'epic.json': transformer('epic') } : {};
        await copyFiles(epic.from, to, epic.files, epicFile);
      }
      for (const entry of plan.plans) {
        for (const file of entry.files) created.push(join(ws.plansDir, file));
        await copyFiles(entry.from, ws.plansDir, entry.files, {});
      }
      for (const entry of plan.captures) {
        const to = join(ws.capturesDir, plan.id, entry.kind);
        created.push(to);
        await copyFiles(entry.from, to, entry.files, {});
      }
    } catch (error) {
      for (const path of created) await fs.rm(path, { recursive: true, force: true });
      if (error.code === 'verify-failed') return { ...refuse('verify-failed', error.message, 'Originals are untouched; fix the source and rerun.'), repository: plan.id };
      throw error;
    }

    if (plan.projectContext && plan.contextAction === 'append') {
      const section = (await fs.readFile(plan.projectContext, 'utf8')).trim();
      const current = await fs.readFile(ws.projectContext, 'utf8').catch(() => '# Project context\n');
      await writeFileAtomic(ws.projectContext, `${current.endsWith('\n') ? current : `${current}\n`}\n## Repository: ${plan.id}\n\n${section}\n`);
    }
    for (const pkg of plan.packages) {
      const done = await materializeIn(ws, pkg.slug, options);
      if (!done.ok) return done;
    }

    const archive = archives.get(plan.id);
    for (const name of plan.entries) await movePath(join(plan.primary, '.specs', name), join(archive, name));
    if ((await fs.readdir(join(plan.primary, '.specs'))).length === 0) await fs.rmdir(join(plan.primary, '.specs'));
  }
  return result();
}
