import { existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { buildHistoryIndex } from '../../../skills/spec-run/scripts/build-history-index.mjs';

import { activeWaveRecords } from './runtime.mjs';
import { splitModelSelector } from './model-selector.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const entries = path => existsSync(path) ? readdirSync(path).filter(name => !name.startsWith('.')) : [];

// A pending inbox note is the package's inbound direction; it must be consumed
// before any run or wave startup decision, so it is a shared predicate.
export function pendingInbox(packagePath) {
  return entries(join(packagePath, 'inbox')).filter(name => name.endsWith('.md'));
}

// Existing progress without an explicit step means the ledger/history must be
// reconciled once before any new dispatch.
export function priorProgress(packagePath) {
  return existsSync(join(packagePath, 'run-ledger.md'))
    || entries(join(packagePath, 'learnings')).length > 0
    || entries(join(packagePath, 'reviews')).length > 0
    || entries(packagePath).some(name => /^step-\d+-(?:learning|review|fix)\.md$|^merge-evidence\.|^pr-url\./.test(name));
}

// Owner routing by difficulty, shared with the wave path. The unknown-difficulty
// refusal moves with the predicate so neither caller can widen it silently.
export function ownerFor(card, input) {
  if (!['easy', 'medium', 'hard'].includes(card.difficulty) && input.strong_owner_model && !input.owner_override)
    throw new Error('Recorded step difficulty is absent/unknown; supply owner_override from the existing routing policy without re-planning');
  return {
    owner_model: input.owner_override || (card.difficulty === 'hard' && input.strong_owner_model) || input.owner_model,
    routing_reason: input.owner_override ? 'explicit step override' : card.difficulty === 'hard' && input.strong_owner_model ? 'prepared hard tier' : 'default owner'
  };
}

// Mechanical startup only. A process exit or a learning filename never certifies
// acceptance. Legacy/resumed progress is reconciled by the coordinator once.
export async function preparedEntry(packagePath, input, locations) {
  const artifacts = Object.fromEntries(['run-ledger.md', 'history-index.json', 'spec-steps.json'].map(name => [name, join(packagePath, name)]));
  const pending = pendingInbox(packagePath);
  if (pending.length) return { state: 'needs_intake', package: packagePath,
    messages: pending.map(name => join(packagePath, 'inbox', name)), next: 'coordinator consumes and routes pending directions before dispatch' };
  const waves = activeWaveRecords(packagePath);
  if (waves.length) return { state: 'wave-active', waves, package: packagePath, artifacts,
    next: 'resume through spec_dispatch startup with execution auto or waves; serial cannot bypass an active wave' };
  const latest = join(packagePath, 'runtime/run.json');
  if (!input.step && existsSync(latest)) {
    const run = read(latest);
    return { state: run.state, run_id: run.id, package: packagePath, artifacts,
      next: ['running', 'cancelling', 'blocked'].includes(run.state)
        ? 'reuse existing run; await completion or confirmed cancellation'
        : 'reconcile this result with the ledger and outstanding review/fix obligations; pass the explicit next step or an intentional retry ID; never infer acceptance from process completion' };
  }
  if (!input.step && priorProgress(packagePath))
    return { state: 'needs_reconciliation', package: packagePath, artifacts, next: 'existing progress: reconcile the ledger/history once and supply the intended step; do not replay step 1' };

  for (const name of ['context.md', 'spec.md', 'spec-prepare.md', 'evidence-plan.json', 'spec-steps.json']) {
    if (!existsSync(join(packagePath, name))) throw new Error(`Prepared input missing: ${name}; resolve this preparation gap`);
  }
  if (!existsSync(locations.project_context)) throw new Error(`Prepared input missing: workspace project-context.md (${locations.project_context})`);
  const { steps } = read(artifacts['spec-steps.json']);
  if (!Array.isArray(steps) || !steps.length || steps.some((s, i) => !Number.isInteger(s.step) || s.step < 1 || (i && s.step <= steps[i - 1].step)))
    throw new Error('spec-steps.json must contain ordered, unique positive step numbers');
  const cards = steps.map(s => ({ ...s, path: join(packagePath, `step-${String(s.step).padStart(3, '0')}-subspec.md`) }));
  for (const card of cards) if (!existsSync(card.path)) throw new Error(`Prepared card missing: ${card.path}`);
  const selected = input.step ? cards.find(s => realpathSync(s.path) === realpathSync(input.step)) : cards[0];
  if (!selected) throw new Error('Requested step is not in spec-steps.json');
  const { owner_model: owner, routing_reason } = ownerFor(selected, input);
  splitModelSelector(owner);
  splitModelSelector(input.editor_model);
  for (const name of ['inbox', 'processed']) mkdirSync(join(packagePath, name), { recursive: true });
  if (!existsSync(artifacts['history-index.json'])) {
    const index = await buildHistoryIndex(packagePath);
    const temp = `${artifacts['history-index.json']}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(index) + '\n', { mode: 0o600 });
    renameSync(temp, artifacts['history-index.json']);
  }
  return { step: selected.path, owner_model: owner,
    routing_reason,
    instructions: `${input.instructions || ''}\nHistory index: ${artifacts['history-index.json']}. Preparation is already complete. Read the assigned card and applicable policy; do not repeat package-wide preparation validation.` };
}
