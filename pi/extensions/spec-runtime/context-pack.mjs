// Dispatch-time grounding for a step owner. Planning-time cards cannot know the
// as-built APIs of earlier steps or current line numbers; in one run editors read
// the step's target file 165 times and prerequisite modules about 90 times to
// reconstruct them. This pack records those facts once, at owner start.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

const DECLARATION = /^(export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/;
const METHOD = /^ {2}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);
const CODE = /\.(m?js|ts)$/;

/** Top-level declarations and two-space class methods with inclusive line ranges. */
export function outline(text) {
  const lines = text.split('\n');
  const items = [];
  lines.forEach((line, index) => {
    const declaration = line.match(DECLARATION);
    if (declaration) { items.push({ name: declaration[3], kind: declaration[2], exported: Boolean(declaration[1]), start: index + 1 }); return; }
    const method = line.match(METHOD);
    if (method && !NOT_METHOD.has(method[1])) items.push({ name: method[1], kind: 'method', exported: false, start: index + 1 });
  });
  items.forEach((item, index) => { item.end = (items[index + 1]?.start ?? lines.length + 1) - 1; });
  return items;
}

/** Exported declaration lines, the closest cheap stand-in for an as-built signature. */
export function exportsOf(text) {
  return text.split('\n').flatMap((line, index) => /^export\s/.test(line)
    ? [{ line: index + 1, text: line.length > 220 ? `${line.slice(0, 220)}...` : line }] : []);
}

function testNames(text) {
  return text.split('\n').flatMap((line, index) => {
    const match = line.match(/^\s*test\((['"`])(.+?)\1/);
    return match ? [{ line: index + 1, name: match[2] }] : [];
  });
}

function introduced(learning) {
  const lines = learning.split('\n');
  const start = lines.findIndex(line => /^\s*introduced:/.test(line));
  if (start < 0) return [];
  const indent = lines[start].match(/^\s*/)[0].length;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    block.push(line);
  }
  return block.slice(0, 60);
}

function git(checkout, args) {
  try { return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

/** Build the pack text for one prepared step; never reads outside the checkout or package. */
export function buildContextPack({ packageDir, stepPath, checkout, maxChars = 40000 }) {
  const number = Number(basename(stepPath).match(/step-(\d+)/)?.[1]);
  const index = JSON.parse(readFileSync(join(packageDir, 'spec-steps.json'), 'utf8'));
  const steps = new Map((index.steps || []).map(step => [step.step, step]));
  const step = steps.get(number);
  if (!step) throw new Error(`step ${number} is absent from spec-steps.json`);
  const pad = value => String(value).padStart(3, '0');
  const out = [`# Context pack: step ${pad(number)}`, '',
    'Generated at owner start from the current checkout. Line ranges are current; pass the ones a packet needs to `spec_editor` `context` instead of asking the editor to search.', ''];

  const planned = existsSync(stepPath) ? Math.floor(statSync(stepPath).mtimeMs / 1000) : null;
  const watched = [...new Set([...(step.writes || []), ...(step.requires || []).flatMap(r => steps.get(r)?.writes || [])])];
  const changes = planned && watched.length ? git(checkout, ['log', `--since=@${planned}`, '--format=%h %s', '-n', '30', '--', ...watched]) : '';
  out.push('## Changes since this card was written', '', changes ? changes.split('\n').map(line => `- ${line}`).join('\n') : '- none recorded', '');

  out.push('## Prerequisite contracts as built', '');
  for (const required of step.requires || []) {
    const prerequisite = steps.get(required);
    out.push(`### Step ${pad(required)}: ${prerequisite?.name ?? ''}`);
    const learningPath = join(packageDir, 'learnings', `step-${pad(required)}-learning.md`);
    if (existsSync(learningPath)) {
      const block = introduced(readFileSync(learningPath, 'utf8'));
      out.push(`Learning: learnings/step-${pad(required)}-learning.md`);
      if (block.length) out.push('Introduced (from the learning):', '```yaml', ...block, '```');
    }
    for (const file of (prerequisite?.writes || []).filter(path => CODE.test(path) && !/\.test\./.test(path))) {
      const full = join(checkout, file);
      if (!existsSync(full)) continue;
      const exported = exportsOf(readFileSync(full, 'utf8'));
      out.push(`- ${file}`, ...exported.map(item => `  - ${file}:${item.line} \`${item.text.trim()}\``));
    }
    out.push('');
  }

  out.push('## Anchor map of files this step changes', '');
  for (const file of step.writes || []) {
    const full = join(checkout, file);
    if (!existsSync(full)) { out.push(`- ${file}: new file`); continue; }
    const text = readFileSync(full, 'utf8');
    const total = text.split('\n').length;
    if (/\.test\./.test(file)) {
      const names = testNames(text);
      out.push(`- ${file} (${total} lines, ${names.length} tests)`, ...names.slice(0, 80).map(item => `  - ${file}:${item.line} ${item.name}`));
    } else if (CODE.test(file)) {
      out.push(`- ${file} (${total} lines)`, ...outline(text).map(item => `  - ${file}:${item.start}-${item.end} ${item.kind} ${item.name}${item.exported ? ' (exported)' : ''}`));
    } else out.push(`- ${file} (${total} lines)`);
  }

  let text = `${out.join('\n')}\n`;
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[Pack truncated at ${maxChars} characters; read the named files for the rest.]\n`;
  return text;
}

/** Write the pack atomically to runtime/context/step-NNN.md and return its path. */
export function writeContextPack({ packageDir, stepPath, checkout }) {
  const number = String(Number(basename(stepPath).match(/step-(\d+)/)?.[1])).padStart(3, '0');
  const target = join(packageDir, 'runtime', 'context', `step-${number}.md`);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, buildContextPack({ packageDir, stepPath, checkout }), { mode: 0o600 });
  renameSync(temporary, target);
  return target;
}
