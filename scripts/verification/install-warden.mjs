#!/usr/bin/env node
// A narrow, repeatable local package patch until the installed Warden recognizes
// project runners and CI receipts. Refuse unfamiliar classifier implementations.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const target = resolve(homedir(), '.pi/agent/npm/node_modules/pi-warden/dist/done.js');
const adapter = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'warden-evidence.mjs')).href;
const marker = '// shared-project-verification-v2';
export function patchWarden(source, adapter) {
  if (source.includes(marker)) return source;
  const signature = 'export function classifyToolResult(tool, input, failed, output, cwd) {';
  if (source.split(signature).length !== 2) throw new Error('Unrecognized Warden classifier; review package before installing adapter.');
  // Upgrade the known v1 adapter without duplicating imports or early returns.
  if (source.includes('// shared-project-verification-v1')) {
    const oldImport = /^import \{ classifyProjectCheck \} from .*;\n/m;
    const oldHook = /    const projectCheck = classifyProjectCheck\(tool, input, failed, output, cwd\);\n    if \(projectCheck !== undefined\) return projectCheck;\n/;
    if (!oldImport.test(source) || !oldHook.test(source)) throw new Error('Unrecognized v1 adapter; refusing partial upgrade.');
    source = source.replace('// shared-project-verification-v1\n', '').replace(oldImport, '').replace(oldHook, '');
  }
  return `${marker}\nimport { classifyProjectCheck, classifySpecArtifact } from ${JSON.stringify(adapter)};\n${source.replace(signature, `${signature}\n    const artifact = classifySpecArtifact(tool, input, cwd);\n    if (artifact !== undefined) return artifact;\n    const projectCheck = classifyProjectCheck(tool, input, failed, output, cwd);\n    if (projectCheck !== undefined) return projectCheck;`)}`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = readFileSync(target, 'utf8');
  const updated = patchWarden(source, adapter);
  if (updated === source) console.log('Warden project verification adapter already installed.');
  else {
    writeFileSync(`${target}.project-verification-v2-backup`, source, { flag: 'wx' });
    writeFileSync(target, updated);
    console.log('Installed Warden project verification adapter; future Pi sessions load it.');
  }
}
