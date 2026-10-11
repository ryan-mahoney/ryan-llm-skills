#!/usr/bin/env node
// Mechanical accounting for design packages (docs/design-packages.md): index
// validation, per-screen lint, derived status, the pinned Tailwind runtime, and
// reference lines for specs. No model calls. Writes only vendor/tailwind.js
// inside the named design directory and the user cache.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESIGN_LIMITS, lintScreen, parseDesign, screenStatus } from './schema.mjs';

export const TAILWIND = Object.freeze({
  version: '3.4.17',
  url: 'https://cdn.tailwindcss.com/3.4.17',
  sha256: '176e894661aa9cdc9a5cba6c720044cbbf7b8bd80d1c9a142a7c24b1b6c50d15',
});
export const cacheDir = (home = homedir()) => process.env.AGENT_DESIGN_CACHE ?? join(home, '.cache', 'agent-design');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function readBounded(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.size > limit) throw new Error(`${path} exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

const exists = async path => { try { const info = await lstat(path); return info.isFile(); } catch { return false; } };

// Reads and validates <dir>/design.json. The directory name is the slug.
export async function readDesign(dir) {
  const directory = resolve(dir);
  let record;
  try { record = JSON.parse((await readBounded(join(directory, 'design.json'), DESIGN_LIMITS.recordBytes)).toString('utf8')); }
  catch (error) { return { directory, error: `design.json unreadable: ${error.message}` }; }
  const parsed = parseDesign(record, { slug: basename(directory) });
  return parsed.error ? { directory, error: `design.json invalid: ${parsed.error}` } : { directory, design: parsed.design };
}

export async function lintDesign(dir) {
  const { directory, design, error } = await readDesign(dir);
  if (error) return { directory, outcome: 'fail', error, screens: [] };
  const status = await screenStatus(design, rel => exists(join(directory, rel)));
  const screens = [];
  let outcome = 'pass';
  for (const screen of status.screens) {
    if (!screen.produced) { screens.push({ step: screen.step, file: screen.file, produced: false, findings: [] }); continue; }
    const html = (await readFile(join(directory, screen.file))).toString('utf8');
    const findings = lintScreen(html);
    if (findings.some(f => f.level === 'fail')) outcome = 'fail';
    else if (outcome === 'pass' && findings.length) outcome = 'warn';
    screens.push({ step: screen.step, file: screen.file, produced: true, captured: screen.captured, findings });
  }
  return { directory, outcome, summary: status.summary, screens };
}

export async function statusDesign(dir) {
  const { directory, design, error } = await readDesign(dir);
  if (error) return { directory, error };
  const status = await screenStatus(design, rel => exists(join(directory, rel)));
  return { directory, design: design.design, title: design.title, viewport: design.viewport, ...status };
}

// Copies the pinned Tailwind play runtime into <dir>/vendor/tailwind.js, fetching
// it into the cache once and refusing a file whose digest differs from the pin.
export async function vendorTailwind(dir, { fetchImpl = globalThis.fetch, cache = cacheDir(), pin = TAILWIND } = {}) {
  const directory = resolve(dir);
  const cached = join(cache, `tailwind-${pin.version}.js`);
  let bytes = null;
  if (await exists(cached)) {
    bytes = await readFile(cached);
    if (sha256(bytes) !== pin.sha256) throw new Error(`${cached} does not match the pinned digest; delete it and rerun`);
  } else {
    const response = await fetchImpl(pin.url);
    if (!response.ok) throw new Error(`fetch ${pin.url} failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== pin.sha256) throw new Error(`downloaded runtime does not match the pinned digest ${pin.sha256}`);
    await mkdir(cache, { recursive: true });
    await writeAtomic(cached, bytes);
  }
  const target = join(directory, 'vendor', 'tailwind.js');
  if (!(await exists(target)) || sha256(await readFile(target)) !== pin.sha256) {
    await mkdir(dirname(target), { recursive: true });
    await writeAtomic(target, bytes);
  }
  return { path: target, version: pin.version, sha256: pin.sha256 };
}

async function writeAtomic(path, bytes) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, path);
}

// A reference line for spec.md and step cards: identity, resolvable path, digest.
export async function referenceLine(dir, step) {
  const { directory, design, error } = await readDesign(dir);
  if (error) throw new Error(error);
  const screen = design.screens.find(s => s.step === Number(step));
  if (!screen) throw new Error(`step ${step} is not in design.json`);
  const path = join(directory, screen.file);
  if (!(await exists(path))) throw new Error(`${screen.file} is not produced yet`);
  const workspace = basename(dirname(dirname(directory)));
  return { workspace, design: design.design, step: screen.step, path, sha256: sha256(await readFile(path)),
    line: `Design reference: ${workspace}/${design.design} step ${screen.step} → ${path} sha256:${sha256(await readFile(path))}` };
}

function usage() {
  return [
    'Usage: node scripts/design/cli.mjs <command> <design-dir> [args]',
    '  lint <dir>            validate design.json and lint every produced screen (exit 1 on fail)',
    '  status <dir>          derived produced/captured status per screen as JSON',
    '  vendor <dir>          copy the pinned Tailwind runtime to <dir>/vendor/tailwind.js',
    '  ref <dir> <step>      print the Design reference line for one produced screen',
  ].join('\n');
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, dir, arg] = argv;
  if (!command || !dir || !['lint', 'status', 'vendor', 'ref'].includes(command)) { stderr.write(usage() + '\n'); return 2; }
  if (!isAbsolute(dir) && !dir.startsWith('.')) { stderr.write('Design directory must be an absolute or ./relative path\n'); return 2; }
  try {
    if (command === 'lint') {
      const result = await lintDesign(dir);
      stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result.outcome === 'fail' ? 1 : 0;
    }
    if (command === 'status') {
      const result = await statusDesign(dir);
      stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result.error ? 1 : 0;
    }
    if (command === 'vendor') { stdout.write(JSON.stringify(await vendorTailwind(dir)) + '\n'); return 0; }
    if (command === 'ref') { if (!arg) { stderr.write(usage() + '\n'); return 2; } stdout.write((await referenceLine(dir, arg)).line + '\n'); return 0; }
  } catch (error) { stderr.write(`${error.message}\n`); return 1; }
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
