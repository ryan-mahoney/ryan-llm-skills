#!/usr/bin/env node
// A narrow, repeatable local package patch until the installed Warden recognizes
// project runners and CI receipts. Refuse unfamiliar classifier implementations.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const target = resolve(homedir(), '.pi/agent/npm/node_modules/pi-warden/dist/done.js');
const adapter = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'warden-evidence.mjs')).href;
const marker = '// shared-project-verification-v1';
const source = readFileSync(target, 'utf8');
if (source.includes(marker)) {
  console.log('Warden project verification adapter already installed.');
} else {
  const signature = 'export function classifyToolResult(tool, input, failed, output, cwd) {';
  if (source.split(signature).length !== 2) throw new Error('Unrecognized Warden classifier; review package before installing adapter.');
  const updated = `${marker}\nimport { classifyProjectCheck } from ${JSON.stringify(adapter)};\n${source.replace(signature, `${signature}\n    const projectCheck = classifyProjectCheck(tool, input, failed, output, cwd);\n    if (projectCheck !== undefined) return projectCheck;`)}`;
  writeFileSync(`${target}.project-verification-backup`, source, { flag: 'wx' });
  writeFileSync(target, updated);
  console.log('Installed Warden project verification adapter; restart Pi sessions to load it.');
}
