// Wave dispatch controller fixture (step 10). Extracted from waves.test.mjs so
// the fixture/helper implementation is reusable without changing any test case.
//
// Only external boundaries are substituted: the contained service transport and
// hostCheck. Everything else in the proof is real: package-fixture repositories,
// spec-location storage, the real spec-steps index and evidence plan,
// validateStepIndex, ownership.mjs, Runtime, Runtime's own notify route,
// wave-review.mjs, wave-integration.mjs and sentinel.mjs.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makePackageFixture } from './package-fixture.mjs';
import { Runtime } from './runtime.mjs';
import { createOwnership } from './ownership.mjs';
import * as reviewModule from './wave-review.mjs';
import * as integrationModule from './wave-integration.mjs';
import { recordCheckpoint, readCheckpointRecord, reconcileRuntimeReturn } from './sentinel.mjs';
import { validateStepIndex } from '../../../scripts/spec-observe/steps.mjs';
import { inspectProcess } from '../../../scripts/spec-observe/process-identity.mjs';
import { calculateResourcePolicy, DEFAULT_LIFECYCLE_MEMORY_MIB, DEFAULT_LIFECYCLE_TASKS, MIB, setupRuntimeHost } from './linux-resources.mjs';
import { createProcessRegistry } from './waves-fixture-processes.mjs';
import { hostFixture as isolatedHostFixture, hostOptions as isolatedHostOptions, hostTransport as isolatedHostTransport } from './linux-resources-fix-fixture.mjs';
import * as waves from './waves.mjs';

export const CASE4_TIMEOUT_MS = 120000;
export const WAVE_ID = 'wave-skeleton-4';
export const COORDINATOR_SESSION = 'session-skeleton-4';
const here = dirname(fileURLToPath(import.meta.url));

const stepFile = step => `step-${String(step).padStart(3, '0')}-subspec.md`;

// Poll a predicate until it returns a truthy value or the timeout elapses. The
// failure carries the last predicate value/error so a stuck wait is diagnosable
// without re-running the whole fixture.
export async function waitFor(predicate, timeout = 60000, label = 'condition') {
  const deadline = Date.now() + timeout;
  let lastValue;
  let lastError = null;
  for (;;) {
    try {
      lastValue = await predicate();
      lastError = null;
      if (lastValue) return lastValue;
    } catch (error) {
      lastError = error;
      lastValue = undefined;
    }
    if (Date.now() >= deadline) {
      const detail = lastError ? `last error: ${lastError.message ?? lastError}` : `last value: ${JSON.stringify(lastValue)}`;
      throw new Error(`waitFor(${label}) timed out after ${timeout}ms; ${detail}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// A card that can be validated and read by the pipeline. Only the planning
// header and the declared file matter for the fixture.
const cardSource = (step, file) => [
  `# Step ${step}: fixture step`,
  '',
  '<!-- spec-location:begin -->',
  '**Spec location** (fixture; do not edit)',
  '',
  '- Package: `agent-tooling/waves-fixture`',
  '- Targets:',
  '  - `repo`',
  '<!-- spec-location:end -->',
  '',
  `Implement \`${file}\`.`,
  '',
  '```yaml',
  'planning:',
  '  version: 2',
  `  step: ${step}`,
  `  output_file: ${stepFile(step)}`,
  '  verdict: ready',
  '```',
  ''
].join('\n');

// The fake worker is the executable `pi` on PATH. It is executed by the real
// Runtime bootstrap, which is the only thing that sets SPEC_RUNTIME_RECORD and
// SPEC_RUNTIME_ROLE; the transport only injects PATH and the scenario path. The
// worker reads the real durable run record, retargets `checkout` in memory only
// for the fingerprint/submission APIs, and submits through the production
// wave-review exports.
function fakeWorkerSource({ scenarioFile, completionPath, completionModulePath, reviewPath }) {
  return [
    "import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';",
    "import { dirname } from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    `const scenario = JSON.parse(readFileSync(process.env.SPEC_RUNTIME_FIXTURE_SCENARIO || ${JSON.stringify(scenarioFile)}, 'utf8'));`,
    "const record = JSON.parse(readFileSync(process.env.SPEC_RUNTIME_RECORD, 'utf8'));",
    "const role = process.env.SPEC_RUNTIME_ROLE;",
    `const runtime = await import(${JSON.stringify(pathToFileURL(completionPath).href)});`,
    `const completion = await import(${JSON.stringify(pathToFileURL(completionModulePath).href)});`,
    `const review = await import(${JSON.stringify(pathToFileURL(reviewPath).href)});`,
    "const cwd = process.cwd();",
    "const submitted = { ...record, checkout: cwd };",
    "const applyMutations = mutations => {",
    "  for (const [rel, content] of Object.entries(mutations || {})) {",
    "    const full = cwd + '/' + rel;",
    "    mkdirSync(dirname(full), { recursive: true });",
    "    writeFileSync(full, content);",
    "  }",
    "};",
    "const commit = (message, amend = false) => {",
    "  const added = spawnSync('git', ['-C', cwd, 'add', '-A']);",
    "  if (added.status !== 0) return null;",
    "  const committed = amend",
    "    ? spawnSync('git', ['-C', cwd, 'commit', '-q', '--amend', '--no-edit'])",
    "    : spawnSync('git', ['-C', cwd, 'commit', '-qm', message]);",
    "  if (committed.status !== 0) return null;",
    "  const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });",
    "  return head.status === 0 ? head.stdout.trim() : null;",
    "};",
    "const stepNumber = Number((/step-(\\d+)-subspec\\.md$/.exec(record.step) || [])[1]);",
    "// Opt-in per-phase stage hold: after the wave binding resolves and BEFORE",
    "// the owner/reviewer/fixer branch bodies run, a worker whose bound phase is",
    "// listed in scenario.holdStages parks on a separate stages.barrier file.",
    "// The default scenario lists no phase and never parks.",
    "const holdStages = Array.isArray(scenario.holdStages) ? scenario.holdStages : [];",
    "const boundPhase = record.wave_bindings?.phase ?? null;",
    "if (holdStages.includes(boundPhase) && scenario.stagesBarrierFile && existsSync(scenario.stagesBarrierFile)) {",
    "  while (existsSync(scenario.stagesBarrierFile)) await new Promise(resolve => setTimeout(resolve, 20));",
    "}",
    "if (role === 'owner') {",
    "  const candidateRepair = record.wave_bindings?.candidate ?? null;",
    "  const candidateOwner = candidateRepair !== null && candidateRepair !== undefined;",
    "  const spec = candidateOwner ? (scenario.candidateOwner || {}) : ((scenario.owners || {})[String(stepNumber)] || {});",
    "  if (scenario.holdOwners && !candidateOwner) {",
    "    appendFileSync(scenario.startsFile, `${process.pid} ${stepNumber}\\n`);",
    "    const released = () => !existsSync(scenario.barrierFile) || (scenario.releaseDir && existsSync(scenario.releaseDir + '/' + stepNumber + '.release'));",
    "    while (!released()) await new Promise(resolve => setTimeout(resolve, 20));",
    "  }",
    "  applyMutations(spec.mutations);",
    "  if (spec.commit !== false) commit('implementation');",
    "  const plan = JSON.parse(readFileSync(record.package + '/evidence-plan.json', 'utf8'));",
    "  const gates = plan.gates.filter(gate => Number(gate.ownerStep) === stepNumber);",
    "  const evidence = [];",
    "  for (const gate of gates) {",
    "    const command = gate.command;",
    "    const artifact = gate.artifact || ('evidence/' + gate.id + '.txt');",
    "    const full = record.package + '/' + artifact;",
    "    mkdirSync(dirname(full), { recursive: true });",
    "    const before = completion.revision(submitted);",
    "    const run = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' });",
    "    writeFileSync(full, ((run.stdout || '') + (run.stderr || '')) || 'ok\\n');",
    "    const after = completion.revision(submitted);",
    "    const receipt = completion.recordVerification(submitted, command, before, after,",
    "      { exit_code: run.status, error: run.error ? String(run.error) : null, full_output_path: full },",
    "      { started_at: new Date().toISOString(), elapsed_ms: 0 });",
    "    evidence.push({ id: gate.id, status: run.status === 0 ? 'passed' : 'failed', receipt_id: receipt.id, proof_boundary: gate.proofBoundary || 'owner step ' + stepNumber + ' focused check' });",
    "  }",
    "  await runtime.runCompletion(submitted, { outcome: 'as-specified', decisions: [], gaps: [], findings: [], introduced: [], strategy: 'implementation-first', evidence });",
    "} else if (role === 'reviewer') {",
    "  review.recordStageFingerprint(submitted);",
    "  const round = submitted.stage?.round ?? 1;",
    "  const step2NeedsFix = scenario.step2NeedsFix !== false && stepNumber === 2;",
    // Opt-in candidate review-repair regression: a candidate reviewer whose
    // round 1 is opted in through scenario.candidateNeedsFix returns needs-fix
    // for the marker the candidate owner wrote, and the confirmation round then
    // passes with the resolved fix verdict. Members are never affected because
    // candidateReview reads the durable candidate binding.
    "  const candidateReview = record.wave_bindings?.candidate !== null && record.wave_bindings?.candidate !== undefined;",
    "  const candidateNeedsFix = candidateReview && scenario.candidateNeedsFix === true && round === 1;",
    "  const candidateConfirmation = candidateReview && scenario.candidateNeedsFix === true && round > 1;",
    // Opt-in explicit member review-repair regression: for step 2 rounds listed in
    // scenario.failedConfirmationRounds, submit needs-fix again with F1 on the
    // current head and an unresolved fix verdict for the just-consumed fix. Only
    // rounds above the first are affected, so the default payload semantics stay
    // byte-for-byte unchanged when the scenario does not opt in.
    "  const failedRounds = Array.isArray(scenario.failedConfirmationRounds) ? scenario.failedConfirmationRounds : [];",
    "  const failAgain = step2NeedsFix && round > 1 && failedRounds.includes(round);",
    "  const payload = candidateNeedsFix",
    "    ? { verdict: 'needs-fix', findings: [{ id: 'F1', severity: 'HIGH', category: 'correctness', actionable: true, file: 'src/candidate-repair.txt', line: 1, symbol: 'candidateRepair', signature: 'correctness:candidate-repair', explanation: 'the candidate repair marker is wrong', correction: 'write the corrected candidate repair marker', commit: submitted.stage?.head }], fix_verdicts: [], limitations: [] }",
    "    : candidateConfirmation",
    "      ? { verdict: 'pass', findings: [], fix_verdicts: [{ fix: review.stagePaths(submitted).fixPath, id: 'F1', verdict: 'resolved', evidence: 'fixture reviewer verified the corrected candidate repair marker' }], limitations: [] }",
    "      : step2NeedsFix && round === 1",
    "        ? { verdict: 'needs-fix', findings: [{ id: 'F1', severity: 'HIGH', category: 'correctness', actionable: true, file: 'src/b.mjs', line: 1, symbol: 'b', signature: 'correctness:b', explanation: 'the exported constant is wrong', correction: 'restore the correct constant', commit: submitted.stage?.head }], fix_verdicts: [], limitations: [] }",
    "        : failAgain",
    "          ? { verdict: 'needs-fix', findings: [{ id: 'F1', severity: 'HIGH', category: 'correctness', actionable: true, file: 'src/b.mjs', line: 1, symbol: 'b', signature: 'correctness:b', explanation: 'the exported constant is still wrong', correction: 'restore the correct constant', commit: submitted.stage?.head }], fix_verdicts: [{ fix: review.stagePaths(submitted).fixPath, id: 'F1', verdict: 'unresolved', evidence: 'fixture reviewer re-found the wrong exported constant' }], limitations: [] }",
    "          : { verdict: 'pass', findings: [], fix_verdicts: step2NeedsFix ? [{ fix: review.stagePaths(submitted).fixPath, id: 'F1', verdict: 'resolved', evidence: 'fixture reviewer verified the corrected exported constant' }] : [], limitations: [] };",
    "  review.submitStage(submitted, 'reviewer', payload);",
    "} else if (role === 'fixer') {",
    "  const candidateFixer = record.wave_bindings?.candidate !== null && record.wave_bindings?.candidate !== undefined;",
    "  const spec = candidateFixer ? (scenario.candidateFixer || {}) : (scenario.fixer || {});",
    "  applyMutations(spec.mutations);",
    "  const head = spec.commit === false ? null : commit('fix', spec.amend === true);",
    "  const packet = record.stage && record.stage.packet ? record.stage.packet : {};",
    "  const payload = {",
    "    commits: head ? [head] : [],",
    "    decisions: (packet.ids ?? []).map(id => ({ id, decision: 'fixed', signature: 'skeleton:fix', note: 'fixed by fake fixer' })),",
    "    evidence: [], unresolved: []",
    "  };",
    "  if ((packet.index ?? 1) === 1) payload.triage = { summary: 'skeleton fix', fallback: false };",
    "  review.submitStage(submitted, 'fixer', payload);",
    "}",
    "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'fixture stage submitted' }] } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');"
  ].join('\n');
}

// gitAt
function gitAt(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}

export function isAncestor(repo, ancestor, descendant) {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inline case-4 fixture: a real spec-location repository package with two
// independent steps, a real spec-steps index, a real merge gate in the evidence
// plan, a real Runtime, a real ownership registry and one real sentinel workflow
// checkpoint. The controller, the wave record and every member workspace are
// created by the controller itself: nothing is prewritten under runtime/waves.
export async function makeCase4Fixture(t, opts = {}) {
  const pkg = await makePackageFixture({
    prefix: 'waves-skeleton-',
    slug: 'skeleton',
    repos: opts.repos ?? ['repo'],
    targets: opts.targets ?? undefined
  });
  // Own every detached worker process group this fixture spawns. The registry
  // and its teardown are registered before the rest of the fixture is built, so
  // even a setup failure part-way through still reaps every group (including a
  // live descendant whose leader already closed). The teardown references only
  // bindings that are safe no-ops until their setup step assigns them.
  const processRegistry = createProcessRegistry();
  let controller = null;
  let previousEnv = null;
  let teardownPromise = null;
  const teardown = () => {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      const failures = [];
      // Shut the controller down first, but a shutdown failure must never skip
      // the positive drain of every owned group or the workspace removal.
      try { await Promise.resolve(controller?.shutdown?.()); }
      catch (error) { failures.push(error); }
      try { await processRegistry.cleanup(); }
      catch (error) { failures.push(error); }
      // Restore the exact environment values captured before the redirect (delete
      // names that were originally unset) only after the worker children are gone.
      try {
        if (previousEnv) {
          for (const [name, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }
      } catch (error) { failures.push(error); }
      try {
        rmSync(pkg.dir, { recursive: true, force: true });
        assert.equal(existsSync(pkg.dir), false, `fixture package directory must be removed: ${pkg.dir}`);
      } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'fixture teardown failed');
    })().catch(error => { teardownPromise = null; throw error; });
    return teardownPromise;
  };
  t.after(teardown);
  const repo = pkg.repo;
  const packagePath = pkg.packagePath;
  const packageRef = pkg.ref;
  const targetId = 'repo';

  const root = join(pkg.dir, 'fixture');
  const binDir = join(root, 'bin');
  const indexDir = join(root, 'index');
  const ownershipRoot = join(root, 'ownership');
  const agentDir = join(root, 'agent');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(ownershipRoot, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // Optional owner hold barrier: every fake owner records its start line and then
  // waits for this file to be removed before it mutates or submits. The default
  // scenario never creates it.
  const barrierFile = join(root, 'owners.barrier');
  const startsFile = join(root, 'owners.starts');
  const releaseDir = join(root, 'owners.release');
  const holdOwners = opts.holdOwners === true;
  if (holdOwners) writeFileSync(barrierFile, 'hold\n');
  // Optional per-phase stage hold: a separate barrier file parks any generated
  // worker whose resolved wave_bindings.phase is listed in holdStages, AFTER
  // the role/step resolution and BEFORE the owner/reviewer/fixer branch bodies
  // run. The default is an empty list, so no generated worker ever holds and
  // the default behavior is byte-for-byte unchanged.
  const holdStages = Array.isArray(opts.holdStages) ? opts.holdStages.filter(phase => typeof phase === 'string' && phase) : [];
  const stagesBarrierFile = join(root, 'stages.barrier');
  if (holdStages.length) writeFileSync(stagesBarrierFile, 'hold\n');

  const baseCommit = gitAt(repo, ['rev-parse', 'HEAD']).trim();

  // The bare default is the two-step A/B scenario. opts.memberCount instead
  // generates N independent steps (requires [], one disjoint write each) and
  // closes the wave check and evidence gate on the final member. setup is
  // explicitly "none", so validateStepIndex can report the wave concurrency
  // ready before the controller is asked to dispatch.
  const requestedMembers = Number(opts.memberCount);
  const memberCount = Number.isInteger(requestedMembers) && requestedMembers > 0 ? requestedMembers : 2;
  const generatedMembers = opts.memberCount !== undefined;
  const memberWrite = step => (generatedMembers ? `src/member-${step}.mjs` : step === 1 ? 'src/a.mjs' : 'src/b.mjs');
  const index = {
    version: 1,
    steps: Array.from({ length: memberCount }, (_, position) => {
      const step = position + 1;
      return { step, path: stepFile(step), repository: targetId, difficulty: 'hard', requires: [], writes: [memberWrite(step)] };
    }),
    setup: { [targetId]: 'none' },
    wave_checks: [
      { after: memberCount, owner_step: memberCount, gates: ['EV-1'] }
    ]
  };
  writeFileSync(join(packagePath, 'spec-steps.json'), JSON.stringify(index, null, 2));

  const evidencePlan = {
    version: 1,
    gates: [
      {
        id: 'EV-1',
        ownerStep: memberCount,
        required: true,
        phase: 'merge',
        kind: 'focused-test',
        command: 'node -e "process.exit(0)"',
        artifact: 'evidence/EV-1.txt',
        rejects: ['an unsuccessful fixture merge check']
      }
    ]
  };
  writeFileSync(join(packagePath, 'evidence-plan.json'), JSON.stringify(evidencePlan, null, 2));
  mkdirSync(join(packagePath, 'evidence'), { recursive: true });

  for (const step of index.steps) {
    writeFileSync(join(packagePath, step.path), cardSource(step.step, step.writes[0]));
  }

  // Preparation inputs the serial path re-validates: the missing context,
  // prepared spec, and prepare notes, the workspace project context, and a
  // prebuilt history index so the fixture never invokes the history generator.
  // makePackageFixture creates the location/package scaffolding but not this
  // prepared spec.md, so create a minimal one when absent.
  for (const name of ['context.md', 'spec.md', 'spec-prepare.md']) {
    const file = join(packagePath, name);
    if (!existsSync(file)) writeFileSync(file, `# ${name}\nfixture\n`);
  }
  const projectContext = pkg.locations?.project_context;
  if (typeof projectContext === 'string' && !existsSync(projectContext)) {
    mkdirSync(dirname(projectContext), { recursive: true });
    writeFileSync(projectContext, '# project context\nfixture\n');
  }
  writeFileSync(join(packagePath, 'history-index.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));

  // The controller must itself re-check the wave precondition. Validate the
  // unmutated ready base first so a broken fixture is reported as a fixture
  // error, never as a controller error.
  const baseValidation = validateStepIndex(index, { targets: [targetId], evidencePlan });
  assert.equal(baseValidation.ok, true, `fixture index invalid: ${baseValidation.errors.join('; ')}`);
  assert.equal(baseValidation.concurrency_ready, true, 'fixture index must be concurrency ready');

  // Optional per-row mutation applied after the ready-base check: adjust the
  // stored index, the evidence plan, or the fixture files (an unparseable index,
  // a prior learning note, a persisted wave record, an inbox note).
  if (typeof opts.mutateIndex === 'function') {
    opts.mutateIndex(index, evidencePlan);
    writeFileSync(join(packagePath, 'spec-steps.json'), opts.indexRaw ?? JSON.stringify(index, null, 2));
    writeFileSync(join(packagePath, 'evidence-plan.json'), JSON.stringify(evidencePlan, null, 2));
  }
  if (opts.indexRaw !== undefined) writeFileSync(join(packagePath, 'spec-steps.json'), opts.indexRaw);
  if (typeof opts.afterCreate === 'function') opts.afterCreate({ packagePath, packageRef, repo, index, evidencePlan });

  // Actual validation for the (possibly mutated) metadata, exposed so each row
  // asserts the real result instead of a fabricated ready.
  let validation = null;
  try {
    validation = validateStepIndex(JSON.parse(readFileSync(join(packagePath, 'spec-steps.json'), 'utf8')), { targets: opts.targets ?? [targetId], evidencePlan });
  } catch { validation = null; }

  // Real, observable process identity for the coordinator epoch.
  const identity = inspectProcess(process.pid);
  assert.equal(identity.state, 'alive', 'fixture coordinator identity must be observable');
  // A scenario may supply the initial coordinator (for example a disposable child
  // process it kills to simulate a dead owner). The default stays the real current
  // process identity.
  const coordinator = opts.coordinator ?? { session: COORDINATOR_SESSION, epoch: 1, pid: identity.pid, started_at: identity.started_at };

  // Fixture budgets cover at least 16 real default lifecycle units so the widths
  // 5/9 cases are bounded by ready-width, never by an artificial capacity pool.
  const ownership = createOwnership({ registryRoot: ownershipRoot, budgets: {
    memoryBytes: 16 * DEFAULT_LIFECYCLE_MEMORY_MIB * MIB,
    tasks: 16 * DEFAULT_LIFECYCLE_TASKS
  } });
  // Scenario for the fake workers: each step's owner writes only its declared
  // file; step B's first review finds one actionable defect, the fixer commits B's
  // fix and a confirmation pass follows.
  // The default two-step A/B scenario keeps step 2's first review returning
  // needs-fix. A generated memberCount scenario writes one file per member and
  // makes every review pass (step2NeedsFix false).
  const scenario = generatedMembers
    ? {
        owners: Object.fromEntries(Array.from({ length: memberCount }, (_, position) => {
          const step = position + 1;
          return [String(step), { mutations: { [memberWrite(step)]: `export const member${step} = ${step};\n` }, commit: true }];
        })),
        fixer: { mutations: { [memberWrite(memberCount)]: `export const member${memberCount} = 2;\n` }, commit: true },
        step2NeedsFix: false
      }
    : {
        // The default two-step A/B scenario retains step 2's first review
        // needs-fix and its follow-up fix/confirmation stages so a retained
        // stage-recovery case can target reviewing/fixing/confirming directly.
        holdStages,
        stagesBarrierFile,
        owners: {
          '1': { mutations: { 'src/a.mjs': 'export const a = 1;\n' }, commit: true },
          '2': { mutations: { 'src/b.mjs': 'export const b = 1;\n' }, commit: true }
        },
        fixer: { mutations: { 'src/b.mjs': 'export const b = 2;\n' }, commit: true }
      };
  if (holdOwners) Object.assign(scenario, { holdOwners: true, barrierFile, startsFile, releaseDir });
  const scenarioFile = join(root, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  const setScenario = patch => { Object.assign(scenario, patch); writeFileSync(scenarioFile, JSON.stringify(scenario)); };

  // The fake worker and the fake `pi` executable that runs it. The agent launch
  // does not take its executable from the adapter transport: the production
  // wave-lifecycle resolves `pi` from the request environment, so the fixture
  // must make the fake bin and agent dir the process environment for the whole
  // case, not only the adapter's per-launch injection.
  const workerPath = join(root, 'fake-worker.mjs');
  writeFileSync(workerPath, fakeWorkerSource({
    scenarioFile,
    completionPath: join(here, 'runtime.mjs'),
    completionModulePath: join(here, 'completion.mjs'),
    reviewPath: join(here, 'wave-review.mjs')
  }));
  writeFileSync(join(binDir, 'pi'), `#!/bin/sh\nexec node ${JSON.stringify(workerPath)} "$@"\n`, { mode: 0o755 });

  // Redirect the process environment at the producer before any Runtime is
  // prepared or started: the real launch path reads PATH/HOME/config dir and the
  // scenario path from the inherited environment. Keep the exact previous values
  // so cleanup restores them after the worker children are gone.
  previousEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    SPEC_RUNTIME_FIXTURE_SCENARIO: process.env.SPEC_RUNTIME_FIXTURE_SCENARIO
  };
  const fixtureConfigHome = join(agentDir, '.config');
  process.env.PATH = `${binDir}:${previousEnv.PATH ?? ''}`;
  process.env.HOME = agentDir;
  // The saved policy lives under the fixture agentDir config home; export it so
  // every nested worker reads the same actual policy instead of the live one.
  process.env.XDG_CONFIG_HOME = fixtureConfigHome;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.SPEC_RUNTIME_FIXTURE_SCENARIO = scenarioFile;

  // Fixture-owned saved host policy. The native host check now fails closed
  // without a saved policy, so this fixture installs a real one with the
  // production setup action into its own agentDir/.config. Nothing outside the
  // fixture directory is read or written: the config home is fixture-owned and
  // is exported as XDG_CONFIG_HOME below so nested workers observe the same
  // actual policy. The isolated synthetic transport reports kernelProof false,
  // so the fixture never claims a host-level proof it did not perform.
  mkdirSync(fixtureConfigHome, { recursive: true });
  const fixtureHost = await isolatedHostFixture(t, { bwrap: false });
  const { run: fixtureRun } = isolatedHostTransport(fixtureHost, { bwrapAvailable: false });
  const savedPolicy = await setupRuntimeHost({
    // Resource-policy calculation must see the same synthetic 30 GiB / 8 CPU
    // topology the synthetic slice verification uses, not the real host
    // topology. Env and home still belong to this fixture.
    ...isolatedHostOptions(fixtureHost, fixtureRun),
    env: { XDG_CONFIG_HOME: fixtureConfigHome },
    home: agentDir,
    run: fixtureRun,
    ownership: { inspectClaims: async () => ({ claims: [] }) },
    lifecycleMemoryMib: DEFAULT_LIFECYCLE_MEMORY_MIB,
    lifecycleTasks: DEFAULT_LIFECYCLE_TASKS
  });
  assert.equal(savedPolicy.ok, true, `fixture saved host policy must install: ${savedPolicy.reason ?? ''} ${savedPolicy.detail ?? ''}`);

  const events = new EventEmitter();
  const launches = [];
  const drains = [];
  const children = new Set();
  const services = new Map();
  const sends = [];
  const notifications = [];
  let resolveTerminal;
  let terminalDone = false;
  const terminal = new Promise(resolve => {
    resolveTerminal = () => { if (!terminalDone) { terminalDone = true; resolve(); } };
  });

  // Owner concurrency is observed at the real service register/close boundary: a
  // service is an owner only when its bootstrap carries the Runtime owner request
  // file, so setup and reviewer/fixer services never inflate the peak. The
  // counters are the fixture's actual live-process count, not a controller claim.
  const ownerLive = new Set();
  let ownerPeak = 0;
  const isOwnerService = argv => {
    const last = Array.isArray(argv) ? argv[argv.length - 1] : null;
    return typeof last === 'string' && /-owner-request\.json$/.test(last);
  };

  // Serial owners launch through Runtime's own launchProcess seam. Each launch is
  // a real detached node child that stays alive until cleanup, so the controller
  // cannot observe a fake completion. Nothing here runs Runtime orchestration.
  const adapter = {
    async start(request) {
      const argv = Array.isArray(request?.argv) ? request.argv : [];
      const cwd = request?.cwd ?? request?.checkout;
      const env = { ...(request?.env ?? {}) };
      env.PATH = `${binDir}:${env.PATH ?? process.env.PATH ?? ''}`;
      env.SPEC_RUNTIME_FIXTURE_SCENARIO = scenarioFile;
      // Isolate any agent-config writes away from the real user home so the test
      // can assert the launcher-limit configuration never touches settings files.
      env.HOME = agentDir;
      env.XDG_CONFIG_HOME = fixtureConfigHome;
      env.PI_CODING_AGENT_DIR = agentDir;
      const sandbox = {
        unit: `wave-skeleton-${launches.length + 1}.service`,
        invocation: `inv-${launches.length + 1}`,
        main_pid: null,
        terminal: false
      };
      const register = typeof request?.register === 'function' ? request.register : null;
      if (register && register(sandbox) !== true) throw new Error(`wave service registration refused: ${sandbox.unit}`);
      const [command, ...args] = argv.length ? argv : [process.execPath, '-e', 'process.exit(0)'];
      // The real root bootstrap carries the worker's full environment, including
      // SPEC_RUNTIME_ROLE, in the mode-0600 request file named by the final argv
      // element. Observe that producer value so role counts reflect the actual
      // bootstrap rather than the caller's request shape.
      let bootstrapRole = null;
      const requestFile = argv[argv.length - 1];
      if (typeof requestFile === 'string' && existsSync(requestFile)) {
        try {
          const parsed = JSON.parse(readFileSync(requestFile, 'utf8'));
          const role = parsed?.env?.SPEC_RUNTIME_ROLE;
          if (typeof role === 'string' && role) bootstrapRole = role;
        } catch { /* a non-request final argument observes no bootstrap role */ }
      }
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stderr = [];
      child.stderr?.on('data', chunk => stderr.push(String(chunk)));
      child.on('error', error => stderr.push(String(error?.message ?? error)));
      children.add(child);
      processRegistry.register(child);
      if (isOwnerService(argv)) {
        ownerLive.add(sandbox.unit);
        ownerPeak = Math.max(ownerPeak, ownerLive.size);
      }
      child.on('close', () => { children.delete(child); ownerLive.delete(sandbox.unit); });
      sandbox.main_pid = child.pid;
      services.set(sandbox.unit, { sandbox, child });
      const launch = {
        id: `svc-${launches.length + 1}`,
        unit: sandbox.unit,
        invocation: sandbox.invocation,
        status: 'running',
        main_pid: child.pid,
        cwd,
        argv,
        role: request?.role ?? bootstrapRole ?? null,
        stage: request?.stage ?? null,
        get stderr() { return stderr.join(''); }
      };
      launches.push(launch);
      return { ok: true, status: 'running', unit: sandbox.unit, invocation: sandbox.invocation, main_pid: child.pid, child, record: sandbox };
    },
    async inspect(service) {
      return { status: 'confirmed', reason: 'unit-not-found', service };
    },
    async stop(service) {
      // Cancellation routes through the same drain observation, tagged so callers
      // can prove a contained phase was positively stopped before it drained.
      return adapter.drain(service, { cancel: true });
    },
    async drain(service, options = {}) {
      const entry = services.get(service?.unit);
      const cancel = options?.cancel === true;
      // Positive drain through the owned-group registry: SIGKILL the selected
      // group, await the leader close with a bounded wait and confirm via /proc
      // that no live member remains. An unknown/unconfirmed group is reported as
      // such instead of being converted to an unconditional confirmed.
      let status = 'confirmed';
      let reason = null;
      try {
        if (entry) await processRegistry.drainGroup(entry.child.pid);
      } catch (error) {
        status = 'unconfirmed';
        reason = String(error?.message ?? error);
      }
      drains.push({ id: service?.unit ?? null, status, cancel, ...(reason ? { reason } : {}) });
      return { status, service, kernel_proof: false, ...(reason ? { reason } : {}) };
    }
  };
  const serialLaunches = [];
  const launchProcess = opts.launchProcess ?? ((record, role, prompt, launchOpts = {}) => {
    const argv = [process.execPath, '-e', 'setTimeout(() => {}, 600000)'];
    const child = spawn(argv[0], argv.slice(1), { cwd: record.checkout, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    processRegistry.register(child);
    child.on('close', () => children.delete(child));
    serialLaunches.push({ record, role, prompt, pid: child.pid });
    launches.push({ id: `serial-${serialLaunches.length}`, unit: null, role, cwd: record.checkout, argv, serial: true });
    return { workerPid: child.pid, child, done: new Promise(() => {}), onEvent: launchOpts.onEvent };
  });

  // Runtime owns the prepared checkout, the run record and the notify route. The
  // notify route forwards to the controller exactly as the production prompt does.
  const runtime = new Runtime({
    location: pkg.location,
    indexDir,
    ownershipRoot,
    ownership,
    launchProcess,
    serviceAdapter: adapter,
    notify: event => {
      events.emit('worker', event);
      if (!controller) return;
      const routed = controller.routeNotification(event);
      let checkpoint = null;
      try { checkpoint = readCheckpointRecord(packagePath, WAVE_ID); } catch { checkpoint = null; }
      notifications.push({ event, routed, active: runtime.active.size, progressing: controller.progressing(), checkpoint });
    }
  });

  // The workflow checkpoint the controller extends. It is waiting-worker with no
  // wave worker yet: the controller is the only writer of the wave worker entry.
  recordCheckpoint({
    package: packagePath,
    workflow_id: WAVE_ID,
    expected_revision: 0,
    state: 'waiting-worker',
    obligation: { key: 'wave', stage: 'executing', step: 'step-010', summary: 'wave skeleton workflow' },
    workers: [],
    coordinator_session: COORDINATOR_SESSION,
    checkout: repo
  });

  const send = (message, opts) => {
    sends.push({ message, opts });
    const text = JSON.stringify(message ?? '');
    if (text.includes('promotion-result')) resolveTerminal();
    return { delivered: true };
  };

  // Fresh-controller factory: a replacement controller is built over the SAME
  // Runtime, ownership registry, coordinator closure and package, so it
  // reconciles the persisted wave record instead of forking the work. The
  // dependency getter is exposed so an installed-SDK composition (F10-6) can
  // build the REAL native controller over the same seams.
  const controllerDependencies = () => ({
    runtime,
    ownership,
    indexDir,
    hostCheck: opts.hostCheck ?? (async ({ readyMembers = 16, explicitCap = null } = {}) => {
      // The per-lifecycle numbers, ceilings and slot floors are the real resource
      // owner's arithmetic; only the binding label is the fixture's explicit stub,
      // so the widths 5/9 cases report ready-width as their binding constraint.
      const policy = calculateResourcePolicy({
        physicalMemoryBytes: 256 * 1024 * MIB,
        aggregateTasks: 32768,
        readyMembers,
        explicitCap
      });
      return {
        version: 1,
        status: 'ready',
        ok: true,
        reason: 'ready',
        remedy: null,
        nativeReady: true,
        softwareCeiling: policy.softwareCeiling,
        route: 'native',
        fallback: null,
        host: { host_id: 'fixture-host', boot_id: 'fixture-boot', uid: process.getuid?.() ?? 1000 },
        admission: { status: 'ready', reason: 'admitted', remedy: null, admittedWidth: policy.admittedWidth, binding: 'ready-width', bindings: policy.bindings, launchable: true, slots: policy.slots, free: policy.free },
        policy,
        // The fixture cannot offer a native overlay, so it reports the portable
        // worktree transport as positively unavailable and fallback-eligible. A
        // claimed `supported` overlay would make prepareWaveMember refuse
        // capability-unknown on a host that never proved overlay support.
        overlay: { status: 'unavailable', reason: 'fixture-worktree-transport', remedy: null, fallbackEligible: true }
      };
    }),
    // Injected inspect/drain boundary. The stub phaseLifecycle is deliberately not
    // called; the controller only needs a classification result here.
    lifecycle: {
      inspect: async () => ({ status: 'confirmed', reason: 'unit-not-found' }),
      drain: async () => ({ status: 'confirmed' }),
      classify: () => ({ status: 'confirmed' }),
      ...(opts.lifecycle ?? {})
    },
    review: reviewModule,
    integration: integrationModule,
    checkpoint: { readCheckpointRecord, recordCheckpoint, reconcileRuntimeReturn },
    coordinator: () => coordinator,
    send,
    location: pkg.location,
    now: () => Date.now()
  });
  const makeController = () => waves.createWaveController(controllerDependencies());

  // Entry-call counter: every public controller entry except startup must stay 0.
  const entry = { startup: 0, advance: 0, recover: 0, status: 0, cancel: 0 };
  const wireEntry = target => {
    for (const name of Object.keys(entry)) {
      const original = target[name];
      target[name] = (...args) => { entry[name] += 1; return original.apply(target, args); };
    }
    return target;
  };

  controller = wireEntry(makeController());

  // Bind an externally created (installed-SDK) controller over the same runtime
  // notify route so helper notifications reach it and teardown shuts it down.
  const bindController = next => {
    controller = wireEntry(next);
    return controller;
  };

  // Reconcile without a restart: build a fresh controller over the same
  // dependencies and rebind the notify route's controller variable. The
  // replaced controller is deliberately left untouched (never shut down here)
  // so a caller that still holds it can observe the pre-replacement state.
  const replaceController = () => bindController(makeController());

  const releaseOwners = () => { rmSync(barrierFile, { force: true }); };
  // Release exactly one held owner while the global barrier stays in place: the
  // worker's hold loop observes its own per-step release marker.
  const releaseOwner = step => {
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, `${step}.release`), 'release\n');
  };

  return {
    pkg, repo, packagePath, packageRef, targetId, indexDir, ownershipRoot,
    index, evidencePlan, baseCommit, coordinator, ownership, runtime, adapter,
    events, launches, serialLaunches, drains, children, sends, entry,
    notifications, terminal, setScenario, validation, git: (args, opts) => gitAt(repo, args, opts),
    agentDir, settingsPath: join(agentDir, 'settings.json'), settingsLocalPath: join(agentDir, 'settings.local.json'),
    barrierFile, startsFile, releaseOwner, releaseOwners, stagesBarrierFile,
    releaseStages: () => { rmSync(stagesBarrierFile, { force: true }); },
    // A live getter so replaceController() is observable through every existing
    // `f.controller` call site.
    get controller() { return controller; },
    controllerDependencies,
    bindController,
    replaceController,
    // Exposed for leak regressions: teardown positively drains every owned
    // group, and assertDrained resolves only on positive confirmation.
    cleanup: teardown,
    assertDrained: () => processRegistry.assertDrained(),
    processRegistry,
    ownerLive: () => ownerLive.size, ownerPeak: () => ownerPeak
  };
}
