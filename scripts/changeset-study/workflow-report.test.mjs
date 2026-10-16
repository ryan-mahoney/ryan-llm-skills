// node --test scripts/changeset-study/workflow-report.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('failed trials retain their cap and behavioral passes do not hide incomplete workflows or unknown costs', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-report-'));
  const write = (path, value) => writeFileSync(path, JSON.stringify(value));
  try {
    write(join(root, 'manifest.json'), { comparison: 'sol-native-vs-sol-nemotron-workflow', models: ['sol'], simple_selector: 'nemotron',
      limits: { cell_ms: 1200000, grade_ms: 300000 }, reused: [],
      schedule: ['a', 'b'].map(task => ({ task, selector: 'sol', repetition: 0, arms: ['agent', 'changeset-mixed'] })) });
    const fixtures = [
      ['a', 'agent', true, 100000, .1], ['a', 'changeset-mixed', true, 50000, .2],
      ['b', 'agent', false, 20000, null], ['b', 'changeset-mixed', true, 100000, .3],
    ];
    fixtures.forEach(([task, arm, accepted, ms, cost], i) => {
      const dir = join(root, `${String(i).padStart(3, '0')}-${task}-${arm}`); mkdirSync(dir);
      write(join(dir, 'result.json'), { task, arm, selector: 'sol', repetition: 0, accepted,
        process_elapsed_ms: ms, capped_time_to_success_ms: accepted ? ms : 1500000,
        equivalent_usd: cost, model_calls: 1, tokens: { totalTokens: 12 },
        review_accepted: accepted, visible_accepted: accepted, executions: [{ ok: false }] });
    });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./workflow-report.mjs', import.meta.url)), root, join(root, 'report')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
    assert.equal(report.complete, true);
    assert.deepEqual(report.summaries.map(s => s.accepted), [1, 2]);
    assert.deepEqual(report.summaries.map(s => s.workflow_completed), [1, 0]);
    assert.deepEqual(report.summaries.map(s => s.delivered), [1, 0]);
    assert.deepEqual(report.summaries.map(s => s.median_wall_ms), [60000, 75000]);
    assert.equal(report.summaries[0].equivalent_usd, null);
    assert.equal(report.summaries[0].unknown_cost_cells, 1);
    assert.equal(report.summaries[1].equivalent_usd, .5);
    assert.equal(report.comparison.successful_geometric_speed_ratio, 2);
    assert.ok(Math.abs(report.comparison.capped_geometric_speed_ratio - 5.477225575051661) < 1e-12);
    assert.ok(Math.abs(report.comparison.delivery_capped_geometric_speed_ratio - 0.2581988897471611) < 1e-12);
    assert.equal(report.comparison.complete_pairs, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
