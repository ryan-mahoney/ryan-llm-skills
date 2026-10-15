#!/usr/bin/env node
// Mechanical assembly only. This does not accept reviews, rerun checks or infer
// applicability across revisions. Drafts remain blocked until those judgments exist.
import { readFileSync, existsSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkPackage } from '../../../scripts/spec-location/index.mjs';
import { completionStatus } from '../../../pi/extensions/spec-runtime/completion.mjs';
import { buildHistoryIndex } from '../../spec-run/scripts/build-history-index.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
function contained(root, file) {
  const target = resolve(root, file), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Artifact escapes its declared base');
  for (let p = target; p !== root; p = dirname(p))
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('Symlink artifacts are not supported');
  return target;
}
function portable(packageDir, targets, file) {
  if (typeof file !== 'string' || !isAbsolute(file)) return file;
  for (const [prefix, root] of [['', packageDir], ...targets.map(t => [`${t.id}:`, t.worktree || t.primary])]) {
    const rel = relative(root, file);
    if (rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) return prefix + rel;
  }
  return 'unavailable: outside declared artifact bases';
}
function artifactExists(packageDir, targets, reference) {
  try {
    if (typeof reference !== 'string') return false;
    const target = targets.find(t => reference.startsWith(`${t.id}:`));
    const file = target ? contained(target.worktree || target.primary, reference.slice(target.id.length + 1))
      : contained(packageDir, reference);
    return lstatSync(file).isFile() && lstatSync(file).size > 0;
  } catch { return false; }
}
export async function assembleEvidence(packageDir, locations, { base = 'origin/main' } = {}) {
  packageDir = realpathSync(packageDir);
  const plan = read(contained(packageDir, 'evidence-plan.json'));
  if (plan.version !== 2 || !Array.isArray(plan.gates) || !Array.isArray(plan.claims)) throw new Error('A version 2 evidence plan is required');
  const steps = read(contained(packageDir, 'spec-steps.json')).steps;
  const progress = existsSync(join(packageDir, 'runtime/progress.json')) ? read(contained(packageDir, 'runtime/progress.json')) : { runs: [] };
  const targets = locations.targets;
  const revisions = targets.map(t => {
    const cwd = t.worktree || t.primary;
    return { id: t.id, branch: git(cwd, 'branch', '--show-current'), commit: git(cwd, 'rev-parse', 'HEAD'),
      base: git(cwd, 'merge-base', base, 'HEAD'), dirty: Boolean(git(cwd, 'status', '--porcelain', '--untracked-files=no')) };
  });
  const gaps = [], observations = [], implementations = [];
  for (const step of steps) {
    const number = String(step.step).padStart(3, '0');
    const candidates = [];
    for (const run of progress.runs || []) {
      if (basename(run.step || '') !== `step-${number}-subspec.md` || !/^[a-zA-Z0-9-]+$/.test(run.run_id || '')) continue;
      try {
        const record = read(contained(packageDir, `runtime/runs/${run.run_id}.json`));
        // Reconcile from original records, not cached progress. Do not copy the
        // run record (it contains launch secrets) into the assembly output.
        record.package = packageDir;
        record.id = run.run_id;
        record.step = contained(packageDir, `step-${number}-subspec.md`);
        if (completionStatus(record).status !== 'recorded') continue;
        const submission = read(contained(packageDir, `runtime/runs/${run.run_id}-completion.json`));
        if (submission.learning.step !== step.step) continue;
        candidates.push({ run, submission });
      } catch { /* A missing or stale handoff remains a gap below. */ }
    }
    if (candidates.length !== 1) {
      gaps.push(`Step ${step.step}: ${candidates.length ? 'ambiguous current handoffs' : 'no current structured handoff'}; inspect its canonical learning.`);
      continue;
    }
    const { run, submission } = candidates[0], learning = submission.learning;
    implementations.push({ step: step.step, name: step.name, commit: learning.commit, outcome: learning.outcome,
      introduced: learning.introduced, learning: `learnings/step-${number}-learning.md` });
    gaps.push(...submission.gaps);
    let receipts = [];
    const receiptFile = contained(packageDir, `runtime/runs/${run.run_id}-verification.json`);
    if (existsSync(receiptFile)) receipts = read(receiptFile).receipts;
    for (const assessment of learning.evidence) {
      const gate = plan.gates.find(g => g.id === assessment.id && Number(g.ownerStep) === step.step);
      if (!gate) { gaps.push(`Step ${step.step}: handoff evidence does not match the prepared gate ${assessment.id}`); continue; }
      // Keep command receipts distinct from gate judgments: passing git status
      // is not evidence that a behavioral gate passed.
      observations.push({ gate: gate.id, step: step.step, assessment: { ...assessment, artifact: portable(packageDir, targets, assessment.artifact) },
        assessedCommit: learning.commit, source: `runtime/runs/${run.run_id}-completion.json`,
        commands: learning.verification.commands.map(command => {
          const receipt = receipts.find(r => r.id === command.receipt);
          return { ...command, artifact: portable(packageDir, targets, command.artifact),
            ...(receipt ? { receipt: { id: receipt.id, outcome: receipt.outcome, before: receipt.before, after: receipt.after,
              elapsed_ms: receipt.elapsed_ms, observed_at: receipt.observed_at, artifact: portable(packageDir, targets, receipt.summary_artifact || receipt.artifact) } } : {}) };
        }) });
    }
  }
  const history = await buildHistoryIndex(packageDir);
  const reviews = history.records.filter(r => r.kind !== 'learning').map(({ path, kind, step, verdict, signatures, decisions }) =>
    ({ path, kind, step, recordedVerdict: verdict, signatures, decisions, acceptance: 'requires scoped review reconciliation' }));
  const facts = { version: 1, purpose: 'Mechanical evidence assembly; observations are not acceptance', generatedAt: new Date().toISOString(),
    bases: { package: '.', repositories: 'Resolve target IDs through locations.json' }, targets: revisions, observations, reviews,
    implementation: implementations, gaps };
  if (targets.length !== 1) return { facts, limitation: 'Multiple target revisions collected; assemble the per-repository tour manifests explicitly.' };
  const target = revisions[0];
  const gates = plan.gates.map(g => {
    const matches = observations.filter(o => o.gate === g.id), o = matches.length === 1 ? matches[0] : null;
    const a = o?.assessment;
    // A prior assessment never silently becomes an assessment of a new HEAD.
    const artifact = portable(packageDir, targets, a?.artifact || g.artifact);
    const status = a?.status === 'passed' && !artifactExists(packageDir, targets, artifact) ? 'blocked'
      : a?.status === 'passed' && (o.assessedCommit !== target.commit || target.dirty) ? 'stale' : a?.status || 'pending';
    return { ...g, artifact, status, commit: target.commit,
      proof: a ? `Recorded ${a.status} in ${o.source}; inspect the observation and scoped review.` : 'No current structured observation.',
      boundary: a?.proof_boundary || 'Observation and proof boundary not recorded.',
      ...(a?.observedCommit ? { observedCommit: a.observedCommit, applicability: o.assessedCommit === target.commit && a.applicability
        ? a.applicability : 'UNASSESSED for this candidate; retained observation requires scoped applicability review.' } : {}) };
  });
  const claims = plan.claims.map(c => ({ ...c, status: 'unproven', explanation: 'Pending reconciliation of scoped review and gate applicability.' }));
  const mergeGaps = [...gaps, 'Reconcile scoped review completion and evidence applicability; add the behavior, QA and deployment explanation.'];
  if (target.dirty) mergeGaps.push('Target has uncommitted tracked changes.');
  const deployment = { readiness: 'not-assessed', authorization: 'not-requested', authorizationSource: 'none', postDeploy: 'not-run',
    gaps: ['Deployment process not assessed by mechanical assembly.'], migrations: 'Not assessed.', configuration: 'Not assessed.',
    observability: [], rollback: 'Not assessed.', residualRisks: [] };
  const audit = { scope: 'steps', verdict: 'pending', artifact: 'merge-evidence.md', commit: target.commit };
  const tour = { version: 2, feature: basename(packageDir), title: basename(packageDir), generatedAt: facts.generatedAt,
    repository: target.id, branch: target.branch, base: target.base, commit: target.commit, verdict: 'blocked',
    summary: 'Draft: explain the changed behavior from the specification and accepted step evidence.',
    context: { artifact: plan.context.path, summary: 'Draft: summarize the sourced project context.', decisions: [], omissions: [], burden: [] },
    architecture: { before: 'Draft: describe the prior behavior.', after: 'Draft: describe the implemented behavior.', boundaries: plan.posture.boundaries, decisions: [] },
    implementation: { steps: implementations }, claims, gates,
    qa: { mode: plan.posture.qaMode, entrypoints: [], scenarios: [] }, deployment, audit, gaps: mergeGaps };
  const merge = { version: 2, spec: plan.spec, context: plan.context, repository: target.id, branch: target.branch, base: target.base,
    commit: target.commit, verdict: 'blocked', posture: plan.posture, claims, failureHypotheses: plan.failureHypotheses, gates,
    review_completion: { scope: 'steps', status: 'pending', records: reviews }, audit, gaps: mergeGaps };
  return { facts, tour, merge };
}

async function main() {
  const [selector, ...flags] = process.argv.slice(2);
  if (!selector || flags.some(f => f !== '--stdout')) throw new Error('Usage: assemble-evidence.mjs PACKAGE [--stdout]');
  const checked = await checkPackage(selector);
  if (!checked.ok) throw new Error(`${checked.message}\n${checked.remedy}`);
  const root = realpathSync(checked.locations.package_dir), assembled = await assembleEvidence(root, checked.locations);
  if (flags.includes('--stdout')) { console.log(JSON.stringify(assembled, null, 2)); return; }
  const outputs = [['evidence-assembly.json', assembled.facts], ['work-tour.draft.json', assembled.tour], ['merge-evidence.draft.json', assembled.merge]].filter(([, v]) => v);
  for (const [name] of outputs) if (existsSync(contained(root, name))) throw new Error(`${name} already exists; preserve edits and deliberately remove only obsolete generated drafts before regenerating.`);
  for (const [name, value] of outputs) writeFileSync(contained(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ outputs: outputs.map(([name]) => name), verdict: 'blocked', limitation: assembled.limitation }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
