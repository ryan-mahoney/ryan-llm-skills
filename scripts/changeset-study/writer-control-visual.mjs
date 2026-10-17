#!/usr/bin/env node
// Embed a retained writer-control comparison in its self-contained offline page.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const templatePath = new URL('./writer-control-visual.html', import.meta.url);

export function render(report, template) {
  if (!report || report.schema_version !== 1 || !Array.isArray(report.arms))
    throw new Error('Expected writer-control comparison schema_version 1 with an arms array');
  const data = JSON.stringify(report).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  const block = `<script id="report-data" type="application/json">${data}</script>`;
  if (template.includes('<!-- WRITER_CONTROL_DATA -->')) return template.replace('<!-- WRITER_CONTROL_DATA -->', block);
  if (/<script id="report-data" type="application\/json">[\s\S]*?<\/script>/.test(template))
    return template.replace(/<script id="report-data" type="application\/json">[\s\S]*?<\/script>/, block);
  throw new Error('HTML template is missing its report-data insertion point');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: writer-control-visual.mjs WRITER_CONTROL_RESULTS.json OUTPUT.html');
  const report = JSON.parse(readFileSync(input, 'utf8'));
  writeFileSync(output, render(report, readFileSync(templatePath, 'utf8')));
  console.log(`Wrote ${output} (${report.arms.length} arms)`);
}
