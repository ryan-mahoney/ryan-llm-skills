// Public observation output, never recovery input. One atomic file per observer
// avoids competing Pi sessions overwriting each other's status.
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { workspaceKey } from '../../../scripts/spec-observe/sentinel.mjs';

export function createSnapshotPublisher({ agentDir, scope, now = Date.now }) {
  const observerId = randomUUID();
  const directory = join(agentDir, 'spec-sentinel', workspaceKey({ agentDir, scope }), 'observers');
  const path = join(directory, `${observerId}.json`);
  let queue = Promise.resolve();
  let sequence = 0;
  return {
    path,
    publish({ state, mode, snapshot, note = null }) {
      const value = {
        schema_version: 1, observer_id: observerId, pid: process.pid,
        sequence: ++sequence, published_at: new Date(now()).toISOString(),
        refresh_interval_ms: 15000, state, mode, note, snapshot,
      };
      const job = queue.catch(() => {}).then(async () => {
        // A terminal update must not recreate an observer store removed by cleanup.
        if (state === 'observing') await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(`${JSON.stringify(value)}\n`); }
          finally { await file.close(); }
          await rename(temporary, path);
        } finally { await unlink(temporary).catch(() => {}); }
      });
      queue = job;
      return job;
    },
  };
}
