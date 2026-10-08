// Durable workflow facts. Process exit, a complete handoff and acceptance are distinct.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, lstatSync, watch } from 'node:fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildHistoryIndex } from '../../../skills/spec-run/scripts/build-history-index.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const now = () => new Date().toISOString();
const runFile = (r, suffix) => join(r.package, 'runtime/runs', `${r.id}-${suffix}.json`);
export const outcomes = ['as-specified', 'adapted', 'checkpoint', 'no-artifact', 'decision-required', 'needs-spec-correction'];
const completeOutcomes = new Set(['as-specified', 'adapted', 'no-artifact']);
function safePath(root, file) {
  const target = resolve(root, file), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Artifact must be inside its canonical root');
  let current = target;
  while (current !== root) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Symlink artifact is not supported: ${current}`);
    current = dirname(current);
  }
  return target;
}
function atomic(file, value, raw = false) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, raw ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}
function git(r, ...args) {
  return execFileSync('git', ['-C', r.checkout, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }).trim();
}
export function revision(r) {
  return { commit: git(r, 'rev-parse', 'HEAD'), dirty: Boolean(git(r, 'status', '--porcelain', '--untracked-files=no')) };
}
export function verificationReceipts(r) {
  const file = runFile(r, 'verification');
  return existsSync(file) ? read(file).receipts : [];
}
export function recordVerification(r, command, before, after, result, timing = {}) {
  const receipts = verificationReceipts(r);
  const receipt = { id: randomUUID(), command, observed_at: now(), before, after,
    exit_code: result.exit_code ?? null, error: result.error || null, artifact: result.full_output_path || null,
    outcome: result.error || result.exit_code !== 0 ? 'fail' : 'pass',
    started_at: timing.started_at ?? null,
    elapsed_ms: Number.isFinite(timing.elapsed_ms) && timing.elapsed_ms >= 0 ? timing.elapsed_ms : null };
  receipt.summary_artifact = safePath(r.package, join(r.package, 'runtime/runs', `${r.id}-verification-${receipt.id}.md`));
  // Mechanical facts come from the execution receipt, never file mtimes or an
  // owner's reconstructed timestamp. Judgment remains in the gate assessment.
  atomic(receipt.summary_artifact, '# Verification execution\n\n'
    + 'Command outcome only; gate acceptance and applicability require owner assessment.\n\n'
    + '```json\n' + JSON.stringify({ ...receipt, checkout: r.checkout }, null, 2) + '\n```\n', true);
  receipts.push(receipt);
  atomic(safePath(r.package, runFile(r, 'verification')), { version: 1, run_id: r.id, receipts });
  return receipt;
}
function stepNumber(r) {
  const value = basename(r.step).match(/^step-(\d+)-subspec\.md$/)?.[1];
  if (!value) throw new Error('Completion requires a canonical numbered step card');
  return Number(value);
}
function learningPath(r) { return join(r.package, 'learnings', `step-${String(stepNumber(r)).padStart(3, '0')}-learning.md`); }
function gatesFor(r) {
  const plan = read(join(r.package, 'evidence-plan.json'));
  if (!Array.isArray(plan.gates)) throw new Error('evidence-plan.json must contain gates; repair preparation rather than invent evidence obligations');
  return plan.gates.filter(g => Number(g.ownerStep) === stepNumber(r));
}
// Package artifacts accept canonical absolute, repo-relative .specs, or package-relative paths.
function packageArtifactPath(packagePath, path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Artifact path is required');
  const root = resolve(packagePath);
  const target = isAbsolute(path) ? path : path.startsWith('.specs/')
    ? resolve(dirname(dirname(root)), path) : resolve(root, path);
  return safePath(root, target);
}
function artifactPath(r, path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Evidence artifact path is required');
  if (isAbsolute(path) || path.startsWith('.specs/')) {
    const absolute = isAbsolute(path) ? path : resolve(r.primary, path);
    return safePath(absolute.startsWith(r.package + '/') ? r.package : r.checkout, absolute);
  }
  const packageTarget = safePath(r.package, path);
  const checkoutTarget = safePath(r.checkout, path);
  if (existsSync(packageTarget) && existsSync(checkoutTarget) && packageTarget !== checkoutTarget)
    throw new Error(`Ambiguous evidence artifact: ${path}; use a canonical absolute or .specs repo-relative path`);
  return existsSync(checkoutTarget) ? checkoutTarget : packageTarget;
}
// JSON-quoted scalars are YAML scalars too; fixed indentation remains compatible
// with existing history/evidence readers without a second schema or YAML dependency.
function yaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) return value.length ? value.map(v => typeof v === 'object' && v !== null
    ? pad + '-\n' + yaml(v, indent + 2) : pad + '- ' + JSON.stringify(v)).join('\n') : pad + '[]';
  return Object.entries(value).map(([key, v]) => {
    if (Array.isArray(v) && !v.length) return `${pad}${key}: []`;
    if (v !== null && typeof v === 'object') return `${pad}${key}:\n${yaml(v, indent + 2)}`;
    return `${pad}${key}: ${JSON.stringify(v)}`;
  }).join('\n');
}
function render(submission) {
  const sections = [['Decisions and departures', submission.decisions], ['Unresolved gaps', submission.gaps], ['Findings for subsequent steps', submission.findings]];
  return '```yaml\n' + yaml({ learning: submission.learning }) + '\n```\n' + sections.filter(([, values]) => values.length)
    .map(([title, values]) => `\n## ${title}\n\n${values.map(v => `- ${v}`).join('\n')}\n`).join('');
}
function strings(value, name) {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 4000)) throw new Error(`${name} must be an explicit array of concise strings (empty is allowed)`);
  return value;
}
export function submitCompletion(r, input) {
  if (JSON.stringify(input).length > 48000) throw new Error('Completion exceeds 48KB; reference existing evidence, not transcripts');
  if (!outcomes.includes(input.outcome)) throw new Error('Unknown completion outcome');
  const head = revision(r), gates = gatesFor(r), receipts = verificationReceipts(r);
  if (!Number.isInteger(input.fix_attempts ?? 0) || (input.fix_attempts ?? 0) < 0) throw new Error('fix_attempts must be a nonnegative integer');
  const decisions = strings(input.decisions, 'decisions'), gaps = strings(input.gaps, 'gaps'), findings = strings(input.findings, 'findings');
  if (completeOutcomes.has(input.outcome) && gaps.length) throw new Error('Unresolved gaps require a checkpoint or decision outcome');
  if (!Array.isArray(input.introduced) || input.introduced.some(v => !v || ['symbol', 'path', 'purpose'].some(k => typeof v[k] !== 'string' || !v[k].trim()))) throw new Error('introduced must list symbol/path/purpose or be []');
  for (const item of input.introduced) if (!existsSync(safePath(r.checkout, item.path))) throw new Error(`Introduced path unavailable: ${item.path}`);
  if (!['test-first', 'implementation-first'].includes(input.strategy)) throw new Error('strategy must be test-first or implementation-first');
  if (!Array.isArray(input.evidence) || new Set(input.evidence.map(e => e.id)).size !== input.evidence.length || input.evidence.length !== gates.length || input.evidence.some(e => !gates.some(g => g.id === e.id)))
    throw new Error(`Supply exactly the step-owned evidence IDs: ${gates.map(g => g.id).join(', ') || 'none'}`);
  const commands = receipts.map(v => ({ command: v.command, phase: 'verify', outcome: v.outcome, observedCommit: v.before.commit, receipt: v.id,
    observed_at: v.observed_at, started_at: v.started_at ?? null, elapsed_ms: v.elapsed_ms ?? null,
    exit_code: v.exit_code, artifact: v.summary_artifact ?? v.artifact }));
  const evidence = input.evidence.map(e => {
    const gate = gates.find(g => g.id === e.id);
    if (!['passed', 'failed', 'blocked', 'pending'].includes(e.status) || typeof e.proof_boundary !== 'string' || !e.proof_boundary.trim()) throw new Error(`${e.id}: status and proof_boundary required`);
    if (completeOutcomes.has(input.outcome) && gate.required !== false && gate.phase === 'merge' && e.status !== 'passed') throw new Error(`${e.id}: unfinished required merge evidence requires checkpoint`);
    const entry = { id: gate.id, status: e.status, phase: gate.phase, artifact: e.artifact || gate.artifact, rejects: gate.rejects, proof_boundary: e.proof_boundary };
    if (e.status === 'passed') {
      const path = artifactPath(r, entry.artifact);
      if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size === 0) throw new Error(`${e.id}: passed evidence artifact missing or empty: ${path}; create the actual evidence or report pending/blocked`);
      const receipt = receipts.find(v => v.id === e.receipt_id);
      if (e.receipt_id && !receipt) throw new Error(`${e.id}: unknown verification receipt`);
      if (receipt) {
        if (receipts.slice(receipts.indexOf(receipt) + 1).some(v => v.command === receipt.command && v.outcome === 'fail')) throw new Error(`${e.id}: a later failure of the same command must be resolved before using this pass`);
        if (receipt.outcome !== 'pass') throw new Error(`${e.id}: failed receipt cannot establish passed evidence`);
        entry.observedCommit = receipt.before.commit;
        if (receipt.before.commit !== head.commit || receipt.before.dirty || receipt.after.dirty || receipt.after.commit !== receipt.before.commit) {
          if (!e.applicability?.trim()) throw new Error(`${e.id}: explain applicability of earlier or dirty-tree execution; do not rerun only to change its SHA`);
        }
      } else {
        if (!e.command?.trim() || !/^[a-f0-9]{40,64}$/.test(e.observedCommit || '') || !e.applicability?.trim()) throw new Error(`${e.id}: external evidence needs command, observedCommit and applicability`);
        git(r, 'cat-file', '-e', `${e.observedCommit}^{commit}`);
        entry.observedCommit = e.observedCommit;
        commands.push({ command: e.command, phase: 'verify', outcome: 'pass', observedCommit: e.observedCommit, source: 'owner-reported external evidence' });
      }
      if (e.applicability) entry.applicability = e.applicability;
    }
    return entry;
  });
  const submission = { version: 1, run_id: r.id, submitted_at: now(), decisions, gaps, findings,
    learning: { version: 2, kind: 'step', step: stepNumber(r), outcome: input.outcome,
      commit: head.commit, verification: { commit: head.commit, strategy: input.strategy,
        fix_attempts: input.fix_attempts ?? 0, commands }, evidence, introduced: input.introduced } };
  if (completeOutcomes.has(input.outcome) && head.dirty) throw new Error('Commit tracked implementation changes before complete handoff; use checkpoint for unfinished work');
  // Save the intent first: an interrupted materialization is visible and repeatable.
  atomic(safePath(r.package, runFile(r, 'completion')), submission);
  atomic(safePath(r.package, learningPath(r)), render(submission), true);
  return completionStatus(r);
}
export function completionStatus(r, { checkHead = false } = {}) {
  if (!r.completion_contract) return { status: 'legacy_unchecked', missing: ['legacy handoff needs coordinator reconciliation'] };
  try {
    const file = runFile(r, 'completion');
    if (!existsSync(file)) return { status: 'handoff_incomplete', missing: ['spec_complete submission'], learning_path: learningPath(r) };
    const submission = read(file);
    if (submission.invalidated_at) throw new Error('work continued after submission; submit the updated handoff');
    if (submission.run_id !== r.id || readFileSync(safePath(r.package, learningPath(r)), 'utf8') !== render(submission)) throw new Error('canonical learning missing, changed, or belongs to another attempt');
    if (checkHead && (revision(r).commit !== submission.learning.commit || completeOutcomes.has(submission.learning.outcome) && revision(r).dirty)) throw new Error('HEAD changed after submission; update the handoff');
    return { status: 'recorded', outcome: submission.learning.outcome, learning_path: learningPath(r), commit: submission.learning.commit,
      acceptance: 'independent review/fix and evidence applicability remain coordinator obligations', missing: [] };
  } catch (error) { return { status: 'handoff_incomplete', missing: [error.message] }; }
}
const refreshes = new Map();
export function refreshProgress(packagePath) {
  const prior = refreshes.get(packagePath) || Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const index = await buildHistoryIndex(packagePath);
    atomic(safePath(packagePath, join(packagePath, 'history-index.json')), index);
    const runsPath = join(packagePath, 'runtime/runs');
    const runs = existsSync(runsPath) ? readdirSync(runsPath).filter(n => /^[\w-]+\.json$/.test(n)).flatMap(n => {
      const r = read(join(runsPath, n));
      if (!r.id || !r.step || !r.state) return [];
      return [{ run_id: r.id, step: r.step, checkout: r.checkout, execution: r.state, started_at: r.started_at, finished_at: r.finished_at,
        handoff: r.handoff || completionStatus(r), verification_receipts: verificationReceipts(r).length }];
    }) : [];
    runs.sort((a, b) => (a.started_at || '').localeCompare(b.started_at || '') || a.run_id.localeCompare(b.run_id));
    const ledger = { version: 1, observed_at: now(), purpose: 'Runtime facts, not acceptance or publication authority', runs,
      stages: existsSync(join(packagePath, 'runtime/stages')) ? readdirSync(join(packagePath, 'runtime/stages')).filter(n => n.endsWith('.json')).map(n => read(join(packagePath, 'runtime/stages', n))) : [],
      artifacts: index.records.map(({ path, kind, step }) => ({ path, kind, step, assessment: 'inspect source; presence is not approval' })) };
    const latestStages = new Map();
    for (const entry of ledger.stages) {
      const stage = stageAliases[entry.stage] || entry.stage;
      const previous = latestStages.get(stage);
      if (!previous || (entry.recorded_at || '') > (previous.recorded_at || '') ||
          entry.recorded_at === previous.recorded_at && entry.status === 'blocked') latestStages.set(stage, { ...entry, stage });
    }
    ledger.stages = [...latestStages.values()];
    atomic(safePath(packagePath, join(packagePath, 'runtime/progress.json')), ledger);
    return ledger;
  });
  refreshes.set(packagePath, next);
  next.finally(() => { if (refreshes.get(packagePath) === next) refreshes.delete(packagePath); }).catch(() => {});
  return next;
}
export function reminder(r, role = 'owner') {
  const status = completionStatus(r);
  return `Spec runtime: ${basename(r.step)}; role=${role}; execution=${r.state}.\nCanonical package: ${r.package}\nHandoff: ${status.status}${status.missing.length ? '; missing: ' + status.missing.join('; ') : ''}.\n${role === 'owner' ? 'Before ending this assignment, submit spec_complete after the editor/verification returns. Use recorded verification receipts; do not rerun checks for paperwork. A recorded handoff is not independent review acceptance.' : role === 'editor' ? 'Apply the assigned edits; return to the owner. Owner submits completion and runs verification.' : 'Consume runtime/progress.json and canonical review/fix records. Missing handoffs remain obligations; worker exit is not acceptance. No polling or repeated tests.'}`;
}
// Watch artifact directories rather than every transcript/tool event. Reconciliation
// repairs missed/coalesced fs.watch notifications without any model turn.
export function watchProgress(packagePath, onError = () => {}, onFresh = () => {}, { watchDirectory = watch } = {}) {
  let closed = false, queued, signature = '';
  const watchers = new Map();
  const refresh = () => {
    if (closed || queued) return;
    queued = setTimeout(() => { queued = undefined; refreshProgress(packagePath).then(onFresh).catch(onError); }, 100);
    queued.unref?.();
  };
  const reconcile = () => {
    try {
    if (closed) return;
    const dirs = [packagePath, ...['learnings', 'reviews', 'runtime/runs'].map(d => join(packagePath, d))];
    const parts = [];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      if (!watchers.has(dir)) {
        try {
          const watcher = watchDirectory(dir, (_event, filename) => {
          const name = filename?.toString();
          if (!name || /(?:learning|review|fix)\.md$/.test(name) || dir.endsWith('/runs') && name.endsWith('.json')) refresh();
          if (dir === packagePath && ['learnings', 'reviews', 'runtime'].includes(name)) reconcile();
          });
          watcher.on('error', error => {
            watchers.delete(dir);
            watcher.close();
            if (!closed) onError(error);
          });
          watchers.set(dir, watcher);
        } catch (error) { onError(error); }
      }
      for (const name of readdirSync(dir)) if (/(?:learning|review|fix)\.md$/.test(name) || dir.endsWith('/runs') && name.endsWith('.json')) {
        const s = lstatSync(join(dir, name)); parts.push(`${dir}/${name}:${s.mtimeMs}:${s.size}`);
      }
    }
    const next = parts.sort().join('|');
    if (next !== signature) { signature = next; refresh(); }
    } catch (error) { onError(error); }
  };
  reconcile(); refresh();
  const timer = setInterval(reconcile, 15000); timer.unref?.();
  return () => { closed = true; clearTimeout(queued); clearInterval(timer); for (const w of watchers.values()) w.close(); return refreshes.get(packagePath)?.catch(() => {}); };
}

const stageAliases = { 'spec-run': 'implementation', 'spec-step-run': 'implementation', 'spec-pr': 'publication',
  'spec-prepare': 'preparation', 'spec-write': 'preparation', 'spec-architect-initial': 'architecture',
  'spec-branch-refine': 'review', 'spec-work-tour': 'work-tour' };
export function recordCheckpoint(packagePath, input) {
  input = { ...input, stage: stageAliases[input.stage] || input.stage };
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.stage) || !['pending', 'running', 'complete', 'blocked'].includes(input.status)) throw new Error('Invalid stage or status');
  if (typeof input.next !== 'string' || !input.next.trim() || input.next.length > 2000) throw new Error('A concise next action is required');
  strings(input.decisions, 'decisions'); strings(input.artifacts, 'artifacts');
  for (const path of input.artifacts) if (!existsSync(packageArtifactPath(packagePath, path))) throw new Error(`Missing stage artifact: ${path} (resolved to ${packageArtifactPath(packagePath, path)}); reference an existing artifact, not an expected future file`);
  if (input.status === 'complete' && !input.artifacts.length) throw new Error('A complete stage must reference its actual artifacts');
  if (input.status === 'complete' && ['implementation', 'publication'].includes(input.stage)) {
    const progress = read(join(packagePath, 'runtime/progress.json'));
    const latest = new Map();
    for (const r of progress.runs) latest.set(r.step, r);
    if ([...latest.values()].some(r => r.execution !== 'completed' || r.handoff.status !== 'recorded' || !completeOutcomes.has(r.handoff.outcome))) throw new Error('Unfinished worker/handoff obligations remain; preserve them before closing this stage');
  }
  const directory = safePath(packagePath, join(packagePath, 'runtime/stages'));
  const value = { version: 1, ...input, recorded_at: now(), source: 'coordinator assessment; not a runtime verification verdict' };
  atomic(join(directory, `${input.stage}.json`), value);
  return value;
}

// Context is ephemeral: replace one small reminder before each model call instead
// of appending messages, starting turns, or asking the model to reread every skill.
export function installProgressContext(pi, { record, role, onError = () => {} } = {}) {
  const packages = new Map();
  let latestInputAt = null;
  const attach = (packagePath, persist = true) => {
    if (packages.has(packagePath)) return;
    const item = { error: null, close: null };
    item.close = watchProgress(packagePath, error => { item.error = error.message; onError(error); }, () => { item.error = null; });
    packages.set(packagePath, item);
    if (persist) pi.appendEntry('spec-progress-binding', { package: packagePath });
  };
  if (!record) pi.on('input', event => {
    if (!['interactive', 'rpc'].includes(event.source)) return;
    latestInputAt = now();
    pi.appendEntry('spec-progress-input', { observed_at: latestInputAt });
  });
  const restoreBranch = (_event, ctx) => {
    latestInputAt = null;
    for (const item of packages.values()) item.close();
    packages.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'spec-progress-input' && entry.data?.observed_at) latestInputAt = entry.data.observed_at;
      if (entry.type === 'custom' && entry.customType === 'spec-progress-binding' && entry.data?.package) attach(entry.data.package, false);
    }
  };
  if (!record) {
    pi.on('session_start', restoreBranch);
    pi.on('session_tree', restoreBranch);
  }
  pi.on('context', event => {
    let content;
    if (record) {
      // The child closure may predate compaction or a terminal transition.
      let current = record;
      try { current = read(join(record.package, 'runtime/runs', `${record.id}.json`)); } catch { /* display last known assignment, never invent completion */ }
      content = reminder(current, role);
    } else {
      const items = [];
      for (const [packagePath, item] of packages) {
        try {
          const progress = read(join(packagePath, 'runtime/progress.json'));
          const latest = new Map(progress.runs.map(r => [r.step, r]));
          const missing = [...latest.values()].filter(r => r.handoff.status !== 'recorded');
          items.push(`${packagePath}: ${progress.runs.length} attempts; ${missing.length} without structured handoff. ${missing.slice(-4).map(r => `${basename(r.step)} ${r.execution}: ${r.handoff.missing.join(', ')}`).join('; ')}. Stages: ${(progress.stages || []).map(s => `${s.stage}=${s.status}${latestInputAt && (!s.recorded_at || s.recorded_at <= latestInputAt) ? ' (recorded before latest user input; reconcile that input before following this next action; holds remain until explicitly resolved)' : ''}, next: ${s.next.slice(0, 240)}`).join(', ') || 'not recorded'}.${item.error ? ' Refresh error: ' + item.error : ''}`);
        } catch (error) { items.push(`${packagePath}: progress unavailable (${error.message}); do not infer completion.`); }
      }
      if (!items.length) return;
      content = items.join('\n').slice(0, 4500) + '\nUse runtime/progress.json, canonical handoffs and review/fix artifacts; worker exit is not acceptance. Use spec_checkpoint for stage decisions/next action. Do not repeat checks for missing paperwork or poll running workers.';
    }
    return { messages: [...event.messages.filter(m => m.customType !== 'spec-obligations'),
      { role: 'custom', customType: 'spec-obligations', content, display: false, timestamp: Date.now() }] };
  });
  pi.on('session_shutdown', async () => { await Promise.all([...packages.values()].map(item => item.close())); packages.clear(); });
  return { attach };
}

export function invalidateCompletion(r) {
  const file = runFile(r, 'completion');
  if (existsSync(file)) atomic(safePath(r.package, file), { ...read(file), invalidated_at: now() });
}
