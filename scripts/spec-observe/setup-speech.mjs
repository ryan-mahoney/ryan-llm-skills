#!/usr/bin/env node
// Provision the external speech worker and configure the Linux user service.
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function probeSpeech(bun, checkout, timeoutMs = 120000) {
  await new Promise((resolve, reject) => {
    const child = spawn(bun, ['run', 'server/asr/asrDaemonWorker.ts'], {
      cwd: checkout, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let pending = '', diagnostics = '', loaded = false, failure;
    const timer = setTimeout(() => {
      failure = new Error('Speech engine load timed out.');
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'ready') {
            if (event.protocolVersion !== 1) throw new Error('Unsupported speech protocol.');
            // Nonempty silence triggers the worker's lazy model load.
            child.stdin.write(JSON.stringify({ type: 'audio', pcm: Buffer.alloc(6400).toString('base64') }) + '\n');
          }
          if (event.type === 'model-ready') {
            loaded = true;
            child.stdin.end('{"type":"shutdown"}\n');
          }
          if (event.type === 'error') throw new Error(event.message || 'Speech engine load failed.');
        } catch (error) {
          failure = error;
          child.kill('SIGKILL');
        }
      }
    });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0 || !loaded) reject(failure ?? new Error(`Speech engine did not load. ${diagnostics}`));
      else resolve();
    });
  });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}

const exists = async file => access(file).then(() => true, () => false);
const quoteUnit = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';

export async function setupSpeech(args = process.argv.slice(2)) {
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const preferencesPath = path.join(configRoot, 'adjacent/speech-setup.json');
  let saved = {};
  try { saved = JSON.parse(await readFile(preferencesPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read speech setup configuration: ${error.message}`); }
  let checkout = process.env.SENTINEL_SPEECH_CHECKOUT || saved.checkout || path.join(os.homedir(), 'Documents/rearrange-writer');
  let repository = process.env.SENTINEL_SPEECH_REPOSITORY_URL;
  let auto = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--auto') auto = true;
    else if ((arg === '--checkout' || arg === '--repository') && args[i + 1] && !args[i + 1].startsWith('--')) {
      if (arg === '--checkout') checkout = path.resolve(args[++i]);
      else repository = args[++i];
    } else if (arg === '--help') {
      console.log('Usage: setup-speech.mjs [--checkout PATH] [--repository URL] [--auto]');
      return;
    } else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (process.platform !== 'linux') {
    if (auto) return;
    throw new Error('This installer configures the Linux Sentinel systemd user service.');
  }
  if (!path.isAbsolute(checkout)) throw new Error('SENTINEL_SPEECH_CHECKOUT must be absolute.');
  if (!await exists(checkout)) {
    if (repository) run('git', ['clone', '--', repository, checkout]);
    else if (auto) {
      console.warn('Speech setup skipped: no writer checkout. Run node scripts/spec-observe/setup-speech.mjs --repository <writer-clone-url>.');
      return;
    } else throw new Error('Writer checkout missing. Supply --checkout PATH or --repository URL.');
  }
  await access(path.join(checkout, 'server/asr/asrDaemonWorker.ts'));
  let bun = process.env.SENTINEL_SPEECH_BUN || saved.bun;
  if (!bun) {
    const found = spawnSync('which', ['bun'], { encoding: 'utf8' });
    bun = found.status === 0 ? found.stdout.trim() : path.join(os.homedir(), '.bun/bin/bun');
  }
  if (!path.isAbsolute(bun) || !await exists(bun)) throw new Error('Install Bun, then rerun speech setup (or set SENTINEL_SPEECH_BUN to its absolute executable path).');
  run(bun, ['install', '--frozen-lockfile'], checkout);
  // Use the worker repository's checksum-verified, idempotent provisioner.
  run(bun, ['--eval', 'import { provisionAsrModels } from "./server/asr/asrModelProvisioner.ts"; await provisionAsrModels("search-assets/asr");'], checkout);
  console.log('Checking real speech engine load...');
  await probeSpeech(bun, checkout);
  const dir = path.join(configRoot, 'systemd/user/spec-sentinel.service.d');
  await mkdir(dir, { recursive: true });
  // systemd does not read shell profiles. Keep Bun and Pi Node on its PATH.
  const servicePath = [path.dirname(bun), path.join(os.homedir(), '.local/share/pi-node/current/bin'), path.join(os.homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const dropin = path.join(dir, 'speech.conf');
  await writeFile(`${dropin}.tmp`, `[Service]\nEnvironment=${quoteUnit(`SENTINEL_SPEECH_CHECKOUT=${checkout}`)}\nEnvironment=${quoteUnit(`PATH=${servicePath}`)}\n`, { mode: 0o600 });
  await rename(`${dropin}.tmp`, dropin);
  await mkdir(path.dirname(preferencesPath), { recursive: true });
  await writeFile(`${preferencesPath}.tmp`, JSON.stringify({ checkout, bun }) + '\n', { mode: 0o600 });
  await rename(`${preferencesPath}.tmp`, preferencesPath);
  run('systemctl', ['--user', 'daemon-reload']);
  console.log('Speech engine loaded. Configuration saved. Run: systemctl --user restart spec-sentinel');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupSpeech().catch(error => { console.error(error.message); process.exitCode = 1; });
}
