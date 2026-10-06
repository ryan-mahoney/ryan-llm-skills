import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decisionReport } from './report.mjs';

test('Jev reports observed usefulness without counting rotation duplicates or claiming savings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const row = { decision_id: 'one', repository_hash: createHash('sha256').update('/repo').digest('hex'),
    time: '2026-10-05T10:00:00Z', status: 'uncertain', task: 'verification', uncertainty: ['context_incomplete'], latency_ms: 400, outcome: 'pending' };
  const rows = [row, { ...row, decision_id: 'two', status: 'recommendation', uncertainty: [], latency_ms: 200 },
    { ...row, decision_id: 'old', time: '2026-09-01T10:00:00Z' }, { ...row, decision_id: 'other', repository_hash: 'another' }];
  await writeFile(join(directory, 'decisions.jsonl'), rows.map(JSON.stringify).join('\n') + '\ninvalid\nnull\n');
  await writeFile(join(directory, 'decisions.jsonl.previous'), JSON.stringify(row));
  const result = await decisionReport({ directory, repo: '/repo', since: '2026-10-05' });
  assert.equal(result.calls, 2); assert.equal(result.statuses.recommendation, 1);
  assert.equal(result.uncertainty.context_incomplete, 1); assert.equal(result.mean_latency_ms, 300);
  assert.equal(result.malformed_rows, 2); assert.equal(result.savings, 'not_measured');
  assert.equal((await decisionReport({ directory: join(directory, 'missing') })).status, 'unavailable');
  await assert.rejects(decisionReport({ directory, since: 'nonsense' }), /Invalid/);
});
