#!/usr/bin/env node
// Build a fully offline visual from optimized-report.mjs JSON output.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const templatePath = new URL('./optimized-visual.html', import.meta.url);

export function render(report, template) {
  if (!report || !Array.isArray(report.runs)) throw new Error('Expected an optimized-report JSON object with a runs array');
  const data = JSON.stringify(report).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  const block = `<script id="report-data" type="application/json">${data}</script>`;
  if (template.includes('<!-- OPTIMIZED_REPORT_DATA -->')) return template.replace('<!-- OPTIMIZED_REPORT_DATA -->', block);
  if (/<script id="report-data" type="application\/json">[\s\S]*?<\/script>/.test(template)) {
    return template.replace(/<script id="report-data" type="application\/json">[\s\S]*?<\/script>/, block);
  }
  throw new Error('HTML template is missing its report-data insertion point');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: optimized-visual.mjs OPTIMIZED_REPORT.json OUTPUT.html');
  const report = JSON.parse(readFileSync(input, 'utf8'));
  writeFileSync(output, render(report, readFileSync(templatePath, 'utf8')));
  console.log(`Wrote ${output} (${report.runs.length} runs)`);
}
