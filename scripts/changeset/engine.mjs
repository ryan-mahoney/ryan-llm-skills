import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { hash, safePath, Workspace } from './workspace.mjs';

const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const intersects = (a, b) => a.some(x => b.some(y => overlap(x, y)));
export function compile(plan) {
  if (plan?.schema_version !== 1 || !Array.isArray(plan.operations) || !plan.operations.length || plan.operations.length > 200) throw new Error('Expected schema_version 1 and 1..200 operations');
  const ids = new Set();
  const ops = plan.operations.map(raw => {
    const op = structuredClone(raw);
    if (!/^[a-z][a-z0-9_-]*$/.test(op.id) || ids.has(op.id)) throw new Error('Invalid or duplicate operation ID');
    ids.add(op.id);
    if (!['deterministic', 'simple', 'involved'].includes(op.executor)) throw new Error(`Invalid executor: ${op.id}`);
    for (const key of ['reads', 'writes', 'depends_on']) {
      if (!Array.isArray(op[key]) || op[key].some(x => typeof x !== 'string') || new Set(op[key]).size !== op[key].length) throw new Error(`Invalid ${key}: ${op.id}`);
    }
    [...op.reads, ...op.writes].forEach(safePath);
    if (op.executor === 'deterministic' && Array.isArray(op.edits)) {
      const affected = op.edits.flatMap(e => e.kind === 'rename' ? [e.path, e.to] : [e.path]);
      affected.forEach(safePath);
      op.inferred_writes = affected.filter(path => !op.writes.includes(path));
      op.writes = [...new Set([...op.writes, ...affected])];
    }
    if (!op.writes.length) throw new Error('Operation needs write ownership');
    if (op.executor === 'deterministic' && (!Array.isArray(op.edits) || !op.edits.length)) throw new Error('Deterministic operation needs edits');
    if (op.executor !== 'deterministic' && (typeof op.instruction !== 'string' || !op.instruction.trim())) throw new Error('Model operation needs instruction');
    for (const [path, expected] of Object.entries(op.preconditions ?? {})) {
      if (![...op.reads, ...op.writes].includes(path) || !(expected === null || /^[a-f0-9]{64}$/.test(expected))) throw new Error('Invalid precondition');
    }
    return op;
  });
  for (const op of ops) if (op.depends_on.some(id => !ids.has(id) || id === op.id)) throw new Error('Unknown or self dependency');
  const ordered = [], remaining = new Set(ops);
  while (remaining.size) {
    const ready = [...remaining].find(op => op.depends_on.every(id => ordered.some(o => o.id === id)));
    if (!ready) throw new Error('Dependency cycle');
    ordered.push(ready); remaining.delete(ready);
  }
  // Resolve undeclared ordering conflicts once, without a model call. Explicit dependencies win.
  for (let i = 0; i < ordered.length; i++) for (let j = 0; j < i; j++) {
    const a = ordered[j], b = ordered[i];
    if (intersects(a.writes, [...b.reads, ...b.writes]) || intersects(a.reads, b.writes)) {
      if (!b.depends_on.includes(a.id)) b.depends_on.push(a.id);
    }
  }
  return ordered;
}

export function transform(op, context) {
  const files = { ...context }, changed = Object.create(null);
  const read = path => {
    if (!Object.hasOwn(files, path)) throw new Error(`Undeclared read: ${path}`);
    if (files[path] === null) throw new Error(`Missing file: ${path}`);
    return files[path];
  };
  const write = (path, value) => {
    if (!op.writes.includes(path)) throw new Error(`Unowned write: ${path}`);
    files[path] = value; changed[path] = value;
  };
  const range = part => {
    const text = read(safePath(part.path));
    const anchor = value => {
      if (typeof value !== 'string' || !value || text.split(value).length !== 2) throw new Error(`Range anchor must be unique: ${part.path}`);
      return text.indexOf(value);
    };
    const start = anchor(part.start), end = part.end === null ? text.length : anchor(part.end);
    if (end <= start) throw new Error(`Invalid range ordering: ${part.path}`);
    return { text, start, end };
  };
  for (const edit of op.edits) {
    const path = safePath(edit.path);
    switch (edit.kind) {
      case 'create':
        if (!Object.hasOwn(files, path) || files[path] !== null) throw new Error(`Create requires absent owned path: ${path}`);
        if (typeof edit.text !== 'string') throw new Error('Create requires text');
        write(path, edit.text); break;
      case 'replace': {
        const text = read(path);
        if (typeof edit.search !== 'string' || !edit.search || typeof edit.text !== 'string' || !Number.isInteger(edit.count ?? 1) || (edit.count ?? 1) < 1) throw new Error('Invalid replacement');
        const parts = text.split(edit.search);
        if (parts.length - 1 !== (edit.count ?? 1)) throw new Error(`Replacement count mismatch: ${path}`);
        write(path, parts.join(edit.text)); break;
      }
      case 'compose': {
        if (!Object.hasOwn(files, path) || files[path] !== null) throw new Error(`Compose requires absent owned path: ${path}`);
        if (!Array.isArray(edit.parts) || !edit.parts.length) throw new Error('Compose requires parts');
        const text = edit.parts.map(part => {
          if (Object.hasOwn(part, 'text')) {
            if (typeof part.text !== 'string' || Object.hasOwn(part, 'path')) throw new Error('Invalid literal part');
            return part.text;
          }
          const { text, start, end } = range(part); return text.slice(start, end);
        }).join('');
        write(path, text); break;
      }
      case 'replace-range': {
        if (typeof edit.text !== 'string') throw new Error('Range replacement requires text');
        const { text, start, end } = range(edit);
        write(path, text.slice(0, start) + edit.text + text.slice(end)); break;
      }
      case 'delete': read(path); write(path, null); break;
      case 'rename': {
        safePath(edit.to);
        if (!Object.hasOwn(files, edit.to) || files[edit.to] !== null) throw new Error('Rename target must be absent and owned');
        write(edit.to, read(path)); write(path, null); break;
      }
      case 'json-set': {
        if (!Array.isArray(edit.keys) || !edit.keys.length || edit.keys.some(k => typeof k !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(k)) || !Object.hasOwn(edit, 'value')) throw new Error('Invalid JSON key path');
        const value = JSON.parse(read(path)); let parent = value;
        for (const key of edit.keys.slice(0, -1)) {
          if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('Missing JSON parent');
          parent = parent[key];
        }
        if (!parent || typeof parent !== 'object' || Array.isArray(parent)) throw new Error('JSON parent must be an object');
        parent[edit.keys.at(-1)] = edit.value;
        write(path, JSON.stringify(value, null, 2) + '\n'); break;
      }
      default: throw new Error(`Unknown edit kind: ${edit.kind}`);
    }
  }
  return changed;
}

export async function execute(plan, workspace, { concurrency = 4, adapters = {}, verify, signal, onDraft } = {}) {
  const operations = compile(plan);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Concurrency must be 1..32');
  const started = performance.now(), initial = workspace.snapshot();
  // Work in a private transaction: callers see no partial batch on any failure.
  const staged = new Workspace(initial, null, { ...workspace.modes }), states = new Map(), records = [], active = new Map();
  let peak = 0, modelCalls = 0;
  const run = async op => {
    const start = performance.now(); let usage = null;
    try {
      if (signal?.aborted) throw new Error('Execution aborted');
      const context = staged.snapshot([...new Set([...op.reads, ...op.writes])]);
      for (const [path, expected] of Object.entries(op.preconditions ?? {})) if (hash(context[path]) !== expected) throw new Error(`Precondition failed: ${path}`);
      let files;
      if (op.executor === 'deterministic') files = transform(op, context);
      else {
        const adapter = adapters[op.executor]; if (!adapter) throw new Error(`No adapter for ${op.executor}`);
        modelCalls++;
        const response = await adapter({ operation: structuredClone(op), files: context, signal });
        files = response?.files; usage = response?.usage ?? null;
      }
      if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) throw new Error('Executor returned no files');
      for (const [path, text] of Object.entries(files)) if (!op.writes.includes(path) || !(text === null || typeof text === 'string')) throw new Error(`Invalid executor write: ${path}`);
      if (signal?.aborted) throw new Error('Execution aborted');
      for (const [path, text] of Object.entries(files)) {
        if (text === null) continue;
        if (path.endsWith('.json')) JSON.parse(text);
        if (/\.(mjs|js)$/.test(path)) {
          try { execFileSync(process.execPath, ['--input-type=module', '--check'], { input: text, timeout: 3000, maxBuffer: 16384, stdio: ['pipe', 'pipe', 'pipe'] }); }
          catch (error) { throw new Error(`Syntax check failed for ${path}: ${String(error.stderr ?? error.message).slice(0, 2000)}`); }
        }
      }
      staged.apply(files);
      if (op.executor === 'deterministic') for (const edit of op.edits) {
        if (edit.kind === 'rename' && staged.modes[edit.path] !== undefined) staged.modes[edit.to] = staged.modes[edit.path];
      }
      states.set(op.id, 'passed');
      records.push({ id: op.id, executor: op.executor, status: 'passed', elapsed_ms: performance.now() - start, usage, output_hashes: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, hash(t)])) });
    } catch (error) {
      states.set(op.id, 'failed'); records.push({ id: op.id, executor: op.executor, status: 'failed', error: error.message, elapsed_ms: performance.now() - start, usage });
    }
  };
  while (states.size < operations.length || active.size) {
    for (const op of operations) {
      if (states.has(op.id) || active.has(op.id)) continue;
      if (op.depends_on.some(id => ['failed', 'blocked'].includes(states.get(id)))) {
        states.set(op.id, 'blocked'); records.push({ id: op.id, status: 'blocked', dependencies: op.depends_on }); continue;
      }
      if (active.size >= concurrency || !op.depends_on.every(id => states.get(id) === 'passed')) continue;
      const promise = Promise.resolve().then(() => run(op)).finally(() => active.delete(op.id));
      active.set(op.id, promise); peak = Math.max(peak, active.size);
    }
    if (active.size) await Promise.race(active.values());
    else if (states.size < operations.length) throw new Error('Scheduler made no progress');
  }
  onDraft?.({ files: staged.snapshot(), modes: { ...staged.modes } });
  const execution_ms = performance.now() - started;
  let verification = { status: 'not-run' };
  if (records.every(r => r.status === 'passed') && verify) {
    const start = performance.now();
    try {
      const checked = new Workspace(staged.snapshot(), null, { ...staged.modes });
      const before = hash(JSON.stringify([checked.snapshot(), checked.modes]));
      const result = await verify(checked);
      if (hash(JSON.stringify([checked.snapshot(), checked.modes])) !== before) throw new Error('Verifier mutated candidate');
      verification = { status: result === true || result?.ok === true ? 'passed' : 'failed', detail: result, elapsed_ms: performance.now() - start }; }
    catch (error) { verification = { status: 'failed', error: error.message, elapsed_ms: performance.now() - start }; }
  }
  const ok = records.every(r => r.status === 'passed') && verification.status !== 'failed';
  const changes = staged.changes();
  if (ok) { workspace.apply(Object.fromEntries(changes.map(c => [c.path, c.after]))); workspace.modes = { ...staged.modes }; }
  return {
    schema_version: 1, ok, plan_sha256: hash(JSON.stringify(plan)), operations: records.sort((a, b) => operations.findIndex(o => o.id === a.id) - operations.findIndex(o => o.id === b.id)),
    verification, changes: changes.map(c => ({ path: c.path, before_sha256: hash(c.before), after_sha256: hash(c.after) })),
    metrics: { execution_ms, total_ms: performance.now() - started, peak_concurrency: peak, model_calls: modelCalls, deterministic_operations: records.filter(r => r.executor === 'deterministic').length, failed: records.filter(r => r.status === 'failed').length, blocked: records.filter(r => r.status === 'blocked').length },
  };
}
