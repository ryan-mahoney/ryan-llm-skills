#!/usr/bin/env node
// Guard catalog conversion coverage, local dependencies, and runnable scripts.
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const directory = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '../../design-system'));
const failures = [];
const normalize = value => value.replace(/&amp;/g, '&').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]));
  return nested.flat();
}
const manifest = JSON.parse(await readFile(join(directory, 'conversion.json'), 'utf8'));
const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const record of [...provenance.files, ...(provenance.supporting_files || [])]) {
  try {
    const path = resolve(directory, record.path);
    if (relative(directory, path).startsWith('..')) throw new Error('outside catalog');
    if (digest(await readFile(path)) !== record.sha256) failures.push(`${record.path}: provenance digest mismatch`);
  } catch (error) { failures.push(`${record.path}: ${error.message}`); }
}
const tailwindDigest = '176e894661aa9cdc9a5cba6c720044cbbf7b8bd80d1c9a142a7c24b1b6c50d15';
if (digest(await readFile(join(directory, 'vendor/tailwind.js'))) !== tailwindDigest) failures.push('Pinned Tailwind 3.4.17 digest mismatch');
const sources = new Set();
const outputs = new Set();
for (const record of manifest.files) {
  if (sources.has(record.source)) failures.push(`Duplicate source: ${record.source}`);
  if (outputs.has(record.output)) failures.push(`Duplicate output: ${record.output}`);
  sources.add(record.source);
  outputs.add(record.output);
  try {
    const path = resolve(directory, record.output);
    if (isAbsolute(relative(directory, path)) || relative(directory, path).startsWith('..')) throw new Error('outside catalog');
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    const text = await readFile(path, 'utf8');
    if (record.output.endsWith('.html')) {
      for (const section of record.sections) if (!normalize(text).includes(normalize(section))) failures.push(`${record.output}: missing source section ${section}`);
    }
  } catch (error) { failures.push(`${record.output}: ${error.message}`); }
}
const files = await walk(directory);
for (const path of files) {
  const name = relative(directory, path);
  if (/\.tsx?$/.test(name)) failures.push(`Unconverted TypeScript source remains: ${name}`);
  if (name.endsWith('.js') && !name.startsWith('vendor/')) {
    try { new vm.Script(await readFile(path, 'utf8'), { filename: name }); }
    catch (error) { failures.push(`${name}: ${error.message}`); }
  }
  if (!name.endsWith('.html')) continue;
  const text = await readFile(path, 'utf8');
  if (!/^\s*<!doctype html>/i.test(text)) failures.push(`${name}: missing HTML document declaration`);
  if (!text.includes('vendor/tailwind.js')) failures.push(`${name}: missing pinned Tailwind runtime`);
  if (/\{\{(?:TITLE|INTRO|CONTENT|SCRIPT)\}\}/.test(text)) failures.push(`${name}: unfilled template`);
  for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=|type\s*=\s*["']application\/json/i.test(match[1])) continue;
    try { new vm.Script(match[2], { filename: name }); }
    catch (error) { failures.push(`${name}: inline JavaScript: ${error.message}`); }
  }
  // Renderer string literals are JavaScript, not document resource elements.
  const markup = text.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, '<script$1></script>').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of markup.matchAll(/<(script|link|img|iframe|source|video|audio|a)\b[^>]*?\b(?:src|href)\s*=\s*(["'])(.*?)\2/gi)) {
    const target = match[3].replace(/&amp;/g, '&');
    if (/^(?:data:|#)/.test(target)) continue;
    if (/^(?:https?:|\/\/)/.test(target)) {
      if (match[1].toLowerCase() !== 'a') failures.push(`${name}: external resource ${target}`);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    try {
      const resolved = resolve(dirname(path), decodeURIComponent(target.split(/[?#]/)[0]));
      if (!(await stat(resolved)).isFile()) failures.push(`${name}: link is not a file: ${target}`);
    } catch { failures.push(`${name}: missing local target ${target}`); }
  }
}
console.log(JSON.stringify({ outcome: failures.length ? 'fail' : 'pass', sources: sources.size, mapped_outputs: outputs.size, html_pages: files.filter(path => path.endsWith('.html')).length, failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
