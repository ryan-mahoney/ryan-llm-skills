// Host-local state is deliberately outside synchronized workspace storage.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { inspectProcess } from '../spec-observe/process-identity.mjs';

export const defaultRuntimeRoot = () => join(homedir(), '.local', 'state', 'agents', 'dev-preview');
export function openStore(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const db = new DatabaseSync(join(realpathSync(root), 'previews.sqlite'), { timeout: 2000 });
  chmodSync(join(root, 'previews.sqlite'), 0o600);
  db.exec('CREATE TABLE IF NOT EXISTS previews (key TEXT PRIMARY KEY, port INTEGER UNIQUE, record TEXT NOT NULL) STRICT');
  return db;
}
export function readRecord(root, key) {
  if (!existsSync(join(root, 'previews.sqlite'))) return null;
  const db = new DatabaseSync(join(root, 'previews.sqlite'), { readOnly: true, timeout: 2000 });
  try { const row = db.prepare('SELECT record FROM previews WHERE key = ?').get(key); return row ? JSON.parse(row.record) : null; }
  finally { db.close(); }
}
export function saveRecord(db, record) {
  db.prepare('INSERT INTO previews VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET port = excluded.port, record = excluded.record')
    .run(record.key, record.port ?? null, JSON.stringify(record));
}
export function publicRecord(record, { reason, startable = true } = {}) {
  let state = record?.state ?? 'stopped';
  let error = record?.error ?? reason ?? null;
  if (['starting', 'stopping'].includes(state) && record?.owner) {
    const fresh = inspectProcess(record.owner.pid);
    if (fresh.state === 'dead' || fresh.state === 'alive' && fresh.started_at !== record.owner.started_at) {
      state = 'error'; error = 'Dev server operation was interrupted. Stop it to clean up before restarting.';
    }
  }
  return { configured: true, state, url: state === 'running' ? record.url : null, error,
    can_start: startable && !record?.port && ['stopped', 'error'].includes(state),
    can_stop: ['running', 'error'].includes(state) && Boolean(record?.port),
  };
}
