import { appendFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { diskPath } from './workspace.mjs';

export function writeArtifact(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
}

// One trace per invocation, shared by planning, application and publication.
// Events contain identifiers and measurements, never prompts or source text.
export function createEditTrace({ directory, root, identity = {}, onEvent = () => {} }) {
  if (root) directory = diskPath(root, relative(root, directory));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const started = performance.now();
  let sequence = 0;
  const calls = [], observerErrors = [];
  const summary = { schema_version: 1, ...identity, started_at: new Date().toISOString(),
    status: 'running', publication: 'not-started', calls, observation_errors: observerErrors };
  const emit = (event, detail = {}) => {
    const { elapsed_ms: duration, ...fields } = detail;
    const value = { schema_version: 1, ...identity, sequence: ++sequence,
      timestamp: new Date().toISOString(), elapsed_ms: performance.now() - started, event, ...fields,
      ...(duration === undefined ? {} : { duration_ms: duration }) };
    appendFileSync(join(directory, 'events.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
    try { onEvent(value); } catch (error) { observerErrors.push({ event, error: error.message, at: value.timestamp }); }
    return value;
  };
  const artifact = (name, value) => {
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(name)) throw new Error('Invalid edit artifact name');
    writeArtifact(join(directory, name), value);
    return name;
  };
  const finish = (status, detail = {}) => {
    Object.assign(summary, detail, { status, finished_at: new Date().toISOString(), elapsed_ms: performance.now() - started });
    summary.model_calls = calls.length;
    summary.unknown_usage_calls = calls.filter(call => !['input', 'output'].every(key => Number.isFinite(call.usage?.[key]))).length;
    summary.known_cost_usd = calls.reduce((sum, call) => sum + (Number.isFinite(call.usage?.cost?.total) ? call.usage.cost.total : 0), 0);
    summary.unknown_cost_calls = calls.filter(call => !Number.isFinite(call.usage?.cost?.total)).length;
    emit('edit_finished', { status, publication: summary.publication, model_calls: calls.length,
      unknown_usage_calls: summary.unknown_usage_calls, elapsed_ms: summary.elapsed_ms });
    artifact('summary.json', summary);
    return summary;
  };
  artifact('summary.json', summary);
  return { emit, artifact, finish, calls, summary, directory, path: file => relative(directory, file) };
}
