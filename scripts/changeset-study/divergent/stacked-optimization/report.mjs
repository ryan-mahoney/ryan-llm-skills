#!/usr/bin/env node
// Aggregate one or more replay rounds: per variant and task across repeats, then per
// variant totals. Usage: node report.mjs <round-dir>... [--md]
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
const dirs = process.argv.slice(2).filter(a => !a.startsWith('--'));
// Second writer attempts are counted from the request log: it is exact under concurrency.
const retries = (dir, row) => { const file = join(dir, row.directory, 'requests.jsonl'); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r => r.writer_attempt === 1).length : 0; };
const rows = dirs.flatMap(dir => JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')).rows.map(row => ({ ...row, round: basename(dir), summary: { ...row.summary, writer: { ...row.summary.writer, fallbacks: retries(dir, row) } } })));
const groups = new Map();
for (const row of rows) { const key = `${row.variant}\u0000${row.task}`; (groups.get(key) ?? groups.set(key, []).get(key)).push(row); }
const fmt = (values, digits = 1) => values.length === 1 ? values[0].toFixed(digits) : `${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(digits)} [${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)}]`;
const lines = ['| Variant | Task | n | Delivered | Applied | Writing s | Calls | Context tokens (input+cache) | Output tokens | USD | Fallbacks |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
const totals = new Map();
for (const [key, list] of groups) {
  const [variant, task] = key.split('\u0000'), s = list.map(r => r.summary);
  const t = totals.get(variant) ?? totals.set(variant, { n: 0, delivered: 0, applied: 0, writing: [], calls: [], ctx: [], out: [], usd: [], fallbacks: 0, cells: 0 }).get(variant);
  t.cells += list.length; t.delivered += s.filter(x => x.accepted).length; t.applied += s.filter(x => x.application_complete).length; t.fallbacks += s.reduce((n, x) => n + x.writer.fallbacks, 0);
  lines.push(`| ${variant} | ${task.replace('hard-', '')} | ${list.length} | ${s.filter(x => x.accepted).length}/${list.length} | ${s.filter(x => x.application_complete).length}/${list.length} | ${fmt(s.map(x => x.writing_s))} | ${fmt(s.map(x => x.calls_including_routing ?? 0), 0)} | ${fmt(s.map(x => (x.tokens?.input ?? 0) + (x.tokens?.cacheRead ?? 0)), 0)} | ${fmt(s.map(x => x.tokens?.output ?? 0), 0)} | ${fmt(s.map(x => x.usd ?? 0), 4)} | ${s.reduce((n, x) => n + x.writer.fallbacks, 0)} |`);
}
lines.push('', '| Variant | Cells | Delivered | Applied | Writing s per 3-task pass | Calls | Context tokens | Output tokens | USD | Fallbacks |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const [variant, t] of totals) {
  const passes = new Map();
  for (const row of rows.filter(r => r.variant === variant)) { const k = `${row.round}/${row.repeat}`; const p = passes.get(k) ?? passes.set(k, { writing: 0, calls: 0, ctx: 0, out: 0, usd: 0 }).get(k);
    p.writing += row.summary.writing_s; p.calls += row.summary.calls_including_routing ?? 0; p.ctx += (row.summary.tokens?.input ?? 0) + (row.summary.tokens?.cacheRead ?? 0); p.out += row.summary.tokens?.output ?? 0; p.usd += row.summary.usd ?? 0; }
  const p = [...passes.values()];
  lines.push(`| ${variant} | ${t.cells} | ${t.delivered}/${t.cells} | ${t.applied}/${t.cells} | ${fmt(p.map(x => x.writing))} | ${fmt(p.map(x => x.calls), 0)} | ${fmt(p.map(x => x.ctx), 0)} | ${fmt(p.map(x => x.out), 0)} | ${fmt(p.map(x => x.usd), 4)} | ${t.fallbacks} |`);
}
console.log(lines.join('\n'));
