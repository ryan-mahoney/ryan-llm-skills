#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Workspace } from './workspace.mjs';
import { execute } from './engine.mjs';
import { routeWithAdvice } from './routing.mjs';
import { Budget, modelRuntime, editorAdapter } from './models.mjs';
const { values } = parseArgs({ options: {
  advice: { type: 'string' }, spec: { type: 'string' }, plan: { type: 'string' }, repo: { type: 'string' }, report: { type: 'string' }, concurrency: { type: 'string' },
  publish: { type: 'boolean', default: false }, verify: { type: 'string' }, budget: { type: 'string' },
  'simple-model': { type: 'string' }, 'involved-model': { type: 'string' },
} });
try {
  if (!values.plan || !values.repo || !values.report) throw new Error('Required: --plan FILE --repo DIR --report FILE [--publish] [--verify SCRIPT] [--concurrency N] [--simple-model provider/model --involved-model provider/model --budget LEDGER]');
  const plan = JSON.parse(readFileSync(values.plan, 'utf8')), ws = Workspace.load(resolve(values.repo)), adapters = {};
  if (plan.operations.some(op => op.executor !== 'deterministic')) {
    if (!values.budget) throw new Error('Live model execution requires a budget ledger');
    const runtime = await modelRuntime(), budget = new Budget(values.budget);
    for (const tier of ['simple', 'involved']) if (values[tier + '-model']) adapters[tier] = editorAdapter({ runtime, budget, selector: values[tier + '-model'], contract: values.spec ? readFileSync(values.spec, 'utf8') : undefined });
  }
  const verifyScript = values.verify ? resolve(values.verify) : null;
  const verify = verifyScript ? staged => {
    const dir = mkdtempSync(join(tmpdir(), 'changeset-verify-'));
    try { staged.materialize(dir); execFileSync(process.execPath, [verifyScript, dir], { cwd: dir, timeout: 30000, maxBuffer: 65536, stdio: 'pipe' }); return true; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  } : undefined;
  const routed = routeWithAdvice(plan, values.advice ? JSON.parse(readFileSync(values.advice, 'utf8')) : undefined);
  const report = await execute(routed.plan, ws, { concurrency: Number(values.concurrency ?? 4), adapters, verify });
  report.routing = routed.decisions;
  report.published = report.ok && values.publish ? ws.publish() : [];
  writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, published: report.published, metrics: report.metrics }));
  process.exitCode = report.ok ? 0 : 1;
} catch (e) { console.error(e.message); process.exitCode = 1; }
