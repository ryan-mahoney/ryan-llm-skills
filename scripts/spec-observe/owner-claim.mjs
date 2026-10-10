// Keyed transactional singleton ownership in one isolated SQLite file. This
// store is ownership coordination only: it holds no workspace records, never
// adopts, signals or unlinks another owner, and keeps the database file after
// release. Process identity stays in process-identity.mjs so there is exactly
// one PID/start parser shared with sibling consumers.
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { inspectProcess, processIdentity } from './process-identity.mjs';

const KEY_LIMIT = 256;
const TIMEOUT_MIN_MS = 1;
const TIMEOUT_MAX_MS = 5000;

const OWNER_SCHEMA = `CREATE TABLE IF NOT EXISTS owner_claims (
  key TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  token TEXT NOT NULL
) STRICT`;

class OwnerClaimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OwnerClaimError';
  }
}

function refuse(detail) {
  throw new OwnerClaimError(detail);
}

function isKey(key) {
  return typeof key === 'string' && key.length >= 1 && key.length <= KEY_LIMIT;
}

function isTimeout(timeoutMs) {
  return Number.isInteger(timeoutMs) && timeoutMs >= TIMEOUT_MIN_MS && timeoutMs <= TIMEOUT_MAX_MS;
}

function isIdentity(identity) {
  return identity !== null && typeof identity === 'object'
    && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && typeof identity.started_at === 'string' && identity.started_at.length > 0;
}

// The caller must already own the parent directory; the database path must be
// its physical spelling so aliases cannot create a second lease per directory.
function canonicalDatabasePath(database) {
  if (typeof database !== 'string' || !isAbsolute(database)) {
    refuse('ownership database path must be absolute');
  }
  let canonicalParent;
  try {
    canonicalParent = realpathSync(dirname(database));
  } catch (error) {
    refuse(`ownership database parent directory for ${database} is unavailable (${error.code ?? error.message}); create the owner directory first`);
  }
  const canonical = join(canonicalParent, basename(database));
  if (canonical !== database) {
    refuse(`ownership database path ${database} is not canonical; use ${canonical}`);
  }
  return canonical;
}

// Create a missing database exclusively with mode 0600 and never truncate an
// existing one. Symlinks and nonregular owner files are refused, not followed.
function ensureDatabaseFile(database) {
  let current;
  try {
    current = lstatSync(database);
  } catch (error) {
    if (error.code !== 'ENOENT') refuse(`ownership database ${database} is unreadable (${error.code ?? error.message})`);
  }
  if (current !== undefined) {
    if (current.isSymbolicLink()) refuse(`ownership database ${database} is a symlink; refusing to follow it`);
    if (!current.isFile()) refuse(`ownership database ${database} is not a regular file`);
    return;
  }
  try {
    closeSync(openSync(database, 'wx', 0o600));
  } catch (error) {
    if (error.code === 'EEXIST') {
      const raced = lstatSync(database);
      if (raced.isSymbolicLink()) refuse(`ownership database ${database} is a symlink; refusing to follow it`);
      if (!raced.isFile()) refuse(`ownership database ${database} is not a regular file`);
      return;
    }
    refuse(`ownership database ${database} cannot be created exclusively with mode 0600 (${error.code ?? error.message})`);
  }
}

function storedRowIsValid(row) {
  return row !== undefined
    && Number.isSafeInteger(row.pid) && row.pid > 0
    && typeof row.started_at === 'string' && row.started_at.length > 0
    && typeof row.token === 'string' && row.token.length > 0;
}

const REQUIRED_COLUMNS = [
  { name: 'key', type: 'TEXT', primaryKey: true, notNull: false },
  { name: 'pid', type: 'INTEGER', primaryKey: false, notNull: true },
  { name: 'started_at', type: 'TEXT', primaryKey: false, notNull: true },
  { name: 'token', type: 'TEXT', primaryKey: false, notNull: true },
];

// The table created below is STRICT with exactly the shared columns. Any
// existing owner_claims table must match that shape through SQLite metadata,
// never a textual comparison, before a row is read or written.
function validateOwnerTable(database, path) {
  const invalid = () => refuse(`stored ownership table owner_claims in ${path} does not match the required STRICT schema (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL, token TEXT NOT NULL); refusing acquisition`);
  const tables = database.prepare('PRAGMA table_list').all()
    .filter(table => table.schema === 'main' && table.name === 'owner_claims');
  if (tables.length !== 1 || tables[0].type !== 'table' || tables[0].strict !== 1) invalid();
  const columns = database.prepare('PRAGMA table_info(owner_claims)').all();
  if (columns.length !== REQUIRED_COLUMNS.length) invalid();
  for (const required of REQUIRED_COLUMNS) {
    const matches = columns.filter(column => column.name === required.name);
    if (matches.length !== 1) invalid();
    const column = matches[0];
    if (String(column.type ?? '').toUpperCase() !== required.type
      || (column.pk === 1) !== required.primaryKey
      || (required.notNull && column.notnull !== 1)) invalid();
  }
}

// Only a confirmed dead pid or an alive pid with a different start text may be
// replaced. Unknown, malformed and unavailable observations fail closed.
function observeStoredRow(row, inspect) {
  let observed;
  try {
    observed = inspect(row.pid);
  } catch (error) {
    return { state: 'unknown', reason: (error && error.code) || 'inspect-failed' };
  }
  if (observed === null || typeof observed !== 'object' || observed.pid !== row.pid) {
    return { state: 'unknown', reason: 'malformed-observation' };
  }
  if (observed.state === 'dead') return { state: 'dead' };
  if (observed.state === 'alive' && typeof observed.started_at === 'string' && observed.started_at.length > 0) {
    return { state: 'alive', sameStart: observed.started_at === row.started_at };
  }
  return { state: 'unknown', reason: observed.reason ?? 'unknown' };
}

export function claimOwner({ database, key, identity = processIdentity(process.pid),
  inspect = inspectProcess, timeoutMs = 2000 } = {}) {
  const canonicalDatabase = canonicalDatabasePath(database);
  if (!isKey(key)) refuse(`ownership key must be a string of 1-${KEY_LIMIT} characters`);
  if (!isTimeout(timeoutMs)) {
    refuse(`ownership timeoutMs must be an integer from ${TIMEOUT_MIN_MS} to ${TIMEOUT_MAX_MS}`);
  }
  if (!isIdentity(identity)) refuse('ownership requires a positive self identity with pid and started_at');
  if (identity.pid !== process.pid) {
    refuse(`ownership identity pid ${identity.pid} is not this process (${process.pid}); refusing acquisition`);
  }
  // Snapshot caller-owned fields so later mutation cannot change the acquired
  // identity, the returned receipt or the release condition.
  const pid = identity.pid;
  const started_at = identity.started_at;

  let self;
  try {
    self = inspect(pid);
  } catch (error) {
    refuse(`ownership self identity for pid ${pid} cannot be observed (${error.code ?? error.message})`);
  }
  if (self === null || typeof self !== 'object' || self.state !== 'alive' || self.pid !== pid
    || typeof self.started_at !== 'string' || self.started_at !== started_at) {
    refuse(`ownership requires a fresh exact alive self identity for pid ${pid}; refusing acquisition`);
  }

  ensureDatabaseFile(canonicalDatabase);

  let db;
  try {
    db = new DatabaseSync(canonicalDatabase, { timeout: timeoutMs, enableLoadExtension: false });
  } catch (error) {
    refuse(`ownership database ${canonicalDatabase} cannot be opened (${error.code ?? error.message})`);
  }

  let token;
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(OWNER_SCHEMA);
    validateOwnerTable(db, canonicalDatabase);
    const row = db.prepare('SELECT pid, started_at, token FROM owner_claims WHERE key = ?').get(key);
    if (row !== undefined) {
      if (!storedRowIsValid(row)) {
        refuse(`stored ownership row for key "${key}" is malformed; refusing acquisition`);
      }
      const observed = observeStoredRow(row, inspect);
      if (observed.state === 'unknown') {
        refuse(`ownership of key "${key}" is held by pid ${row.pid} whose identity is unknown (${observed.reason}); refusing to reclaim`);
      }
      if (observed.state === 'alive' && observed.sameStart) {
        refuse(`ownership of key "${key}" is already held by live pid ${row.pid}; release or wait for that process to exit`);
      }
    }
    token = randomUUID();
    db.prepare('INSERT INTO owner_claims (key, pid, started_at, token) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, token = excluded.token')
      .run(key, pid, started_at, token);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    try { db.close(); } catch { /* already closed */ }
    if (error instanceof OwnerClaimError) throw error;
    throw new OwnerClaimError(`cannot claim ownership of key "${key}" in ${canonicalDatabase}: ${error.message}`);
  }

  let released = false;
  return {
    key,
    pid,
    started_at,
    token,
    // Token-conditioned delete: idempotent, and a successor row with the same
    // pid or start is never removed. The database file is retained.
    release() {
      if (released) return;
      released = true;
      let failure = null;
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM owner_claims WHERE key = ? AND token = ? AND pid = ? AND started_at = ?')
            .run(key, token, pid, started_at);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
          throw error;
        }
      } catch (error) {
        failure = error instanceof OwnerClaimError ? error
          : new OwnerClaimError(`cannot release ownership of key "${key}" in ${canonicalDatabase}: ${error.message}`);
      } finally {
        try { db.close(); } catch { /* already closed */ }
      }
      if (failure) throw failure;
    },
  };
}
