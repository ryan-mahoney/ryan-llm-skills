import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { configurationFailure, splitModelSelector } from '../../pi/extensions/spec-runtime/model-selector.mjs';
import { Runtime, groupAlive, launch, loadRun, summary } from '../../pi/extensions/spec-runtime/runtime.mjs';
import { gitFacts } from '../spec-facts/core.mjs';
import { atomicWrite, comparisonLabel, discoverSkills, gradeCell, indexDrift, loadScenario, readUsage, renderReport, validateScenario } from './core.mjs';

const CELL_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'SPEC_GYM_FAKE_PI_LOG', 'SPEC_GYM_FAKE_PI_SCRIPT', 'SPEC_GYM_FAKE_PI_RUN_SNAPSHOT',
]);
const GENERATED_GITIGNORE = '.specs/\n';
const FIXTURE_USER = { name: 'Spec Gym', email: 'spec-gym@example.invalid' };
const MANAGED_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const MANAGED_TERMINATION_INSTRUCTION = 'Confirm the process group is terminated before removing the cell.';

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
  const cellOwners = new Map();
  for (const entry of loaded) {
    for (const selector of models) {
      const parsed = splitModelSelector(selector);
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const id = cellId(entry.scenario.id, selector, repeat);
        const selection = `scenario ${entry.scenario.id} model ${selector} repeat ${repeat}`;
        const previous = cellOwners.get(id);
        if (previous) throw new Error(`cell id ${JSON.stringify(id)} collides between ${previous} and ${selection}`);
        cellOwners.set(id, selection);
        cells.push({
          id,
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

function cellDirFor(run, cell) {
  const id = typeof cell === 'string' ? cell : cell?.id;
  const valid = typeof id === 'string' && id.length > 0 && !id.includes('/') && !id.includes('\\')
    && id !== '.' && id !== '..' && !/^[A-Za-z]:/.test(id);
  if (!valid) throw new Error(`cell id ${JSON.stringify(id)} must be a non-empty single path segment without "." or ".."`);
  const runDir = resolve(run.runDir);
  const cellDir = resolve(runDir, id);
  if (!cellDir.startsWith(runDir + sep)) throw new Error(`cell id ${JSON.stringify(id)} resolves outside the run directory`);
  return cellDir;
}

export function materializeCell(run, cell, scenario) {
  const cellDir = cellDirFor(run, cell);
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

export async function runLeafCell(run, cell, scenario, materialized, hooks = {}) {
  const cellDir = materialized?.cellDir ?? cellDirFor(run, cell);
  const sessions = join(cellDir, 'sessions');
  const streams = join(cellDir, 'streams');
  mkdirSync(sessions, { recursive: true });
  mkdirSync(streams, { recursive: true });
  const session = join(sessions, 'leaf.jsonl');
  const stream = join(streams, 'leaf.jsonl');
  const stderr = join(streams, 'leaf.stderr');
  const { provider, model, thinking } = splitModelSelector(cell.model);
  const args = [
    '--print', '--mode', 'json', '--session', session,
    '--no-context-files', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--skill', run.skillDir, '--append-system-prompt', join(run.skillDir, 'SKILL.md'),
    '--provider', provider, '--model', model,
    ...(thinking ? ['--thinking', thinking] : []),
    '--', scenario.scenario.task,
  ];
  const timeoutMs = scenario.scenario.timeout_ms ?? run.timeoutMs;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const { pid, done } = spawnWithDeadline({ command: run.pi, args, cwd: materialized.repoDir, env: cellEnvironment(process.env), timeoutMs, stream, stderr });
  hooks.onPid?.(pid);
  const execution = await done;
  const finishedAt = new Date().toISOString();
  const usage = await readUsage([session]);

  let outcome, reason;
  if (execution.timedOut) {
    outcome = 'timed-out';
    reason = 'deadline exceeded';
  } else if (execution.stopReason === 'error' || execution.stopReason === 'aborted') {
    outcome = 'blocked';
    reason = execution.error;
  } else if (execution.error) {
    outcome = 'blocked';
    reason = execution.error;
  } else if (execution.code !== 0 || execution.signal) {
    outcome = 'blocked';
    reason = `Pi exited ${execution.code ?? execution.signal}`;
  } else if (!execution.text || execution.stopReason === 'toolUse') {
    outcome = 'blocked';
    reason = 'Pi exited without a final assistant result';
  } else {
    outcome = 'finished';
    reason = null;
  }

  return {
    id: cell.id,
    scenario: cell.scenarioId,
    version: cell.version,
    model: cell.model,
    state: 'finished',
    outcome,
    reason,
    configuration_failure: configurationFailure(execution.error),
    pid,
    exit_code: execution.code,
    signal: execution.signal,
    stop_reason: execution.stopReason,
    started_at: startedAt,
    finished_at: finishedAt,
    elapsed_ms: Date.now() - started,
    tokens: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    cost_usd: usage.cost_usd,
    session,
    stream,
    stderr,
    text: execution.text,
    checks: [],
  };
}

export async function runManagedCell(run, cell, scenario, materialized, hooks = {}) {
  const cellDir = materialized?.cellDir ?? cellDirFor(run, cell);
  const repoDir = materialized?.repoDir ?? join(cellDir, 'repo');
  const packageDir = materialized?.packageDir ?? join(repoDir, '.specs', scenario.scenario.fixture.feature);
  const checkoutDir = join(cellDir, 'checkout');
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const common = () => ({
    id: cell.id,
    scenario: cell.scenarioId,
    version: cell.version,
    model: cell.model,
    state: null,
    outcome: null,
    reason: null,
    configuration_failure: undefined,
    pid: null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    tokens: { input_tokens: null, output_tokens: null },
    cost_usd: null,
    run_id: null,
    record: null,
    sessions: [],
    checks_root: { package: packageDir, repo: repoDir, checkout: checkoutDir },
    text: null,
    checks: [],
  });

  const ambient = ambientContext(repoDir, { home: homedir() });
  if (ambient.length) return { ...common(), outcome: 'invalid', reason: 'ambient-context', detail: ambient };

  const step = scenario.scenario.fixture.step;
  const roles = { ...(scenario.scenario.roles ?? {}), ...(run.roles ?? {}) };
  const childExtensions = run.manifest?.child_extensions ?? run.childExtensions;
  const snapshot = process.env;
  let runId = null;
  let startError = null;
  try {
    process.env = cellEnvironment(snapshot);
    let reportTerminal = () => {};
    const terminal = new Promise(resolveTerminal => { reportTerminal = resolveTerminal; });
    const runtime = new Runtime({
      indexDir: join(run.runDir, 'index'),
      notify: value => {
        if (!MANAGED_TERMINAL_STATES.has(value?.state) || runId === null || value.run_id !== runId) return;
        reportTerminal(value);
      },
      launchProcess: (record, role, prompt, options) => launch(record, role, prompt, {
        ...options, command: run.pi, prefix: ['--no-context-files', '--no-mcp'],
      }),
    });
    let initial;
    try {
      initial = runtime.start({
        package: packageDir,
        step: join(packageDir, `step-${String(step).padStart(3, '0')}-subspec.md`),
        checkout: checkoutDir,
        owner_model: cell.model,
        editor_model: roles.editor_model,
        scout_model: roles.scout_model,
        child_extensions: childExtensions,
        timeout_ms: scenario.scenario.timeout_ms ?? run.timeoutMs,
        assignment_id: cell.id,
        instructions: scenario.scenario.task,
      }, join(cellDir, 'gym.json'));
    } catch (error) {
      startError = error;
    }
    if (!startError) {
      runId = initial.run_id;
      hooks.onRuntime?.({ runtime, package: packageDir, runId });
      // A reused assignment returns its terminal record instead of launching; do not await a notify that will never come.
      if (!MANAGED_TERMINAL_STATES.has(initial.state)) await terminal;
    }
  } finally {
    process.env = snapshot;
  }
  if (startError) {
    return { ...common(), state: 'blocked', outcome: 'blocked', reason: startError.message, configuration_failure: configurationFailure(startError.message) };
  }

  const record = loadRun(packageDir, runId);
  const sessions = [record.owner_session, record.editor_session];
  const usage = await readUsage(sessions.filter(existsSync));
  let outcome, reason;
  if (record.state === 'completed') {
    outcome = 'finished';
    reason = null;
  } else if (record.state === 'cancelled' && deadlineReached(packageDir, record.id)) {
    outcome = 'timed-out';
    reason = 'deadline exceeded';
  } else {
    outcome = 'blocked';
    reason = record.error ?? `managed run ended in state ${record.state}`;
    if (record.state === 'blocked') reason = `${reason} ${MANAGED_TERMINATION_INSTRUCTION}`;
  }
  return {
    ...common(),
    state: record.state,
    outcome,
    reason,
    configuration_failure: configurationFailure(record.error),
    pid: record.pid ?? null,
    run_id: record.id,
    record: summary(record),
    sessions,
    checks_root: { package: packageDir, repo: repoDir, checkout: record.checkout },
    tokens: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    cost_usd: usage.cost_usd,
    text: record.result ?? null,
  };
}

export async function runCampaign(options, { log = () => {} } = {}) {
  const {
    repoRoot = process.cwd(), root, skill, scenarios = [], models = [],
    roles = {}, timeoutMs = 1800000, repeats = 1, childExtensions = [], pi = 'pi',
  } = options;

  // Refuse every invalid input before createRun can make the run directory.
  const eligible = discoverSkills(join(repoRoot, 'skills'));
  if (!eligible.includes(skill)) throw new Error(`skill not eligible: ${skill}`);
  const typeFolder = join(repoRoot, 'scenarios', skill);
  const indexPath = join(typeFolder, 'scenarios.md');
  if (!existsSync(indexPath)) throw new Error(`missing scenario index: ${indexPath}`);
  const drift = indexDrift(skill, typeFolder);
  if (!drift.same) throw new Error(`index drift: ${indexPath}`);
  const loaded = scenarios.map(folder => loadScenario(folder));
  for (const entry of loaded) {
    if (entry.scenario.skill !== skill) {
      throw new Error(`scenario ${entry.scenario.id} belongs to skill ${entry.scenario.skill}, not ${skill}`);
    }
    const validation = validateScenario(entry.folder);
    if (!validation.ok) throw new Error(`${entry.folder}: ${validation.errors.join('; ')}`);
    if (entry.scenario.status !== 'ready') throw new Error(`scenario ${entry.folder} has status ${entry.scenario.status}; only ready scenarios run`);
  }
  for (const selector of models) splitModelSelector(selector);
  for (const name of ['editor_model', 'scout_model']) {
    if (roles?.[name] !== undefined) splitModelSelector(roles[name]);
  }

  const run = createRun({ repoRoot, root, skill, scenarios, models, roles, timeoutMs, repeats, childExtensions, pi });
  const manifest = freezeManifest(run);
  const record = {
    run_id: run.runId,
    manifest: 'manifest.json',
    label: null,
    cells: run.cells.map(cell => ({
      id: cell.id,
      scenario: cell.scenarioId,
      version: cell.version,
      model: cell.model,
      repeat: cell.repeat,
      state: 'pending',
      outcome: null,
      reason: null,
      started_at: null,
      finished_at: null,
      elapsed_ms: null,
      tokens: null,
      cost_usd: null,
      checks: [],
      artifacts: {},
    })),
  };
  writeRunRecord(run, record);

  let stopRequested = false;
  let activePid = null;
  let activeRuntime = null;
  const signals = [];
  const onSignal = () => {
    stopRequested = true;
    const running = record.cells.find(cell => cell.state === 'running');
    if (running) {
      running.outcome = 'aborted';
      running.reason = 'interrupted';
      running.finished_at = new Date().toISOString();
    }
    record.label = comparisonLabel(manifest, record.cells);
    try { writeRunRecord(run, record); } catch { /* preserve partial record */ }
    try { atomicWrite(join(run.runDir, 'report.md'), renderReport(record)); } catch { /* preserve partial report */ }
    // Capture the owned handles before any await: a cell can finish and clear
    // them mid-escalation, and -null would target this process's own group.
    const ownedRuntime = activeRuntime;
    const ownedPid = activePid;
    void (async () => {
      if (ownedRuntime) {
        try { await ownedRuntime.runtime.cancel(ownedRuntime.package, ownedRuntime.runId); } catch { /* retention is explicit */ }
      } else if (Number.isInteger(ownedPid)) {
        try { process.kill(-ownedPid, 'SIGTERM'); } catch { /* process group is already gone */ }
        if (!(await waitGroupGone(ownedPid, 1000))) {
          try { process.kill(-ownedPid, 'SIGKILL'); } catch { /* process group is already gone */ }
          await waitGroupGone(ownedPid, 500);
        }
      }
      process.exit(130);
    })();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, onSignal);
    signals.push(signal);
  }

  try {
    for (const [index, cell] of run.cells.entries()) {
      if (stopRequested) await new Promise(() => {});
      const recordCell = record.cells[index];
      recordCell.state = 'running';
      recordCell.started_at = new Date().toISOString();
      writeRunRecord(run, record);
      log(`start ${cell.id}`);

      const scenario = loaded.find(entry => entry.scenario.id === cell.scenarioId);
      const materialized = materializeCell(run, cell, scenario);
      const graded = scenario.scenario.driver === 'managed-step'
        ? await runManagedCell(run, cell, scenario, materialized, { onRuntime: value => { activeRuntime = value; } })
        : await runLeafCell(run, cell, scenario, materialized, { onPid: pid => { activePid = pid; } });
      activePid = null;
      activeRuntime = null;
      if (stopRequested) await new Promise(() => {});

      const driver = scenario.scenario.driver;
      const result = gradeCell(graded, scenario, {
        package: materialized.packageDir,
        repo: materialized.repoDir,
        checkout: driver === 'leaf' ? materialized.repoDir : join(materialized.cellDir, 'checkout'),
        fixtureCommit: materialized.fixtureCommit,
      });
      recordCell.state = 'finished';
      recordCell.outcome = result.outcome;
      recordCell.reason = result.reason;
      recordCell.started_at = result.started_at ?? recordCell.started_at;
      recordCell.finished_at = result.finished_at;
      recordCell.elapsed_ms = result.elapsed_ms;
      recordCell.tokens = result.tokens;
      recordCell.cost_usd = result.cost_usd;
      recordCell.checks = result.checks;
      recordCell.artifacts = artifactsFor(run, result);
      writeRunRecord(run, record);
      log(`finish ${cell.id} ${result.outcome}`);
    }

    if (!stopRequested) {
      record.label = comparisonLabel(manifest, record.cells);
      writeRunRecord(run, record);
      atomicWrite(join(run.runDir, 'report.md'), renderReport(record));
    }
  } finally {
    for (const signal of signals) process.removeListener(signal, onSignal);
  }
  return record;
}

function artifactsFor(run, result) {
  const artifacts = {};
  if (result.stream) artifacts.stream = toPosix(relative(run.runDir, result.stream));
  if (result.session) artifacts.session = toPosix(relative(run.runDir, result.session));
  const sessionNames = ['owner_session', 'editor_session'];
  [result.sessions].flat().filter(Boolean).forEach((session, index) => {
    // A session the driver never launched has no retained transcript to link.
    if (!existsSync(session)) return;
    artifacts[sessionNames[index] ?? `session_${index + 1}`] = toPosix(relative(run.runDir, session));
  });
  const record = result.record ?? {};
  for (const [name, path] of [['run_receipt', record.run_receipt], ['events', record.events]]) {
    if (path && existsSync(path)) artifacts[name] = toPosix(relative(run.runDir, path));
  }
  return artifacts;
}

function deadlineReached(packageDir, runId) {
  const events = join(packageDir, 'runtime', 'events.jsonl');
  if (!existsSync(events)) return false;
  return readFileSync(events, 'utf8').split('\n').some(line => {
    if (!line.trim()) return false;
    try {
      const entry = JSON.parse(line);
      return entry?.event === 'deadline_reached' && entry.run_id === runId;
    } catch {
      return false; // preserve unparseable diagnostics on disk without classifying them
    }
  });
}

function spawnWithDeadline({ command, args, cwd, env, timeoutMs, stream, stderr }) {
  mkdirSync(dirname(stream), { recursive: true });
  mkdirSync(dirname(stderr), { recursive: true });
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  let pending = '';
  let text = '';
  let stopReason;
  let failure;
  let timedOut = false;
  child.stdout.on('data', chunk => {
    appendFileSync(stream, chunk, { mode: 0o600 });
    pending += chunk.toString();
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value.type === 'message_end' && value.message?.role === 'assistant') {
          stopReason = value.message.stopReason;
          text = (value.message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
          failure = stopReason === 'error' || stopReason === 'aborted' ? value.message.errorMessage || stopReason : undefined;
        }
      } catch { /* preserve non-JSON diagnostics on disk */ }
    }
  });
  child.stderr.on('data', chunk => appendFileSync(stderr, chunk, { mode: 0o600 }));
  const done = new Promise(resolveDone => {
    let cleanup;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-pid, 'SIGTERM'); } catch { /* process group is already gone */ }
      // The leader's close event is not proof the detached group is gone: a
      // TERM-resistant member can outlive it, so keep the escalation running.
      cleanup = (async () => {
        if (await waitGroupGone(pid, 2000)) return;
        try { process.kill(-pid, 'SIGKILL'); } catch { /* process group is already gone */ }
        await waitGroupGone(pid, 1000);
      })();
    }, timeoutMs) : undefined;
    timer?.unref();
    child.on('error', error => { failure = error.message; });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (cleanup) await cleanup;
      resolveDone({ pid, timedOut, code, signal, stopReason, text, error: failure });
    });
  });
  return { pid, done };
}

async function waitGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!groupAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
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
      if (info.isSymbolicLink()) entries.push({ relativePath, content: Buffer.from(readlinkSync(path)) });
      else if (info.isDirectory()) visit(path);
      else entries.push({ relativePath, content: readFileSync(path) });
    }
  };
  if (existsSync(root)) visit(root);
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const entry of entries) {
    hash.update(`${entry.relativePath}\0`);
    hash.update(entry.content);
  }
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
  chmodSync(destination, info.mode & 0o777);
}
