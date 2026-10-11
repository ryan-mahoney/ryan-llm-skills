#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELP = `Usage: adjacent-sync init|status|preview|run [--config PATH] [--verbose]

init     Create a private config template without replacing existing files
status   Check client and host readiness over SSH
preview  Show pending changes without transferring files
run      Sync nonconflicting changes in both directions

--config PATH  Use a private config outside Git
--verbose      Show raw diagnostics, including private connection details`;

const within = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..' + '/') && path !== '..' && !isAbsolute(path));
};
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const cleanString = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);

function args(argv) {
  const command = argv.shift();
  if (command === '--help' || command === '-h') return { command: 'help' };
  if (!['init', 'status', 'preview', 'run'].includes(command)) throw new Error(HELP);
  let configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'adjacent', 'sync.json');
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--verbose' && !verbose) verbose = true;
    else if (argv[i] === '--config' && argv[i + 1] && !argv[i + 1].startsWith('--')) configPath = argv[++i];
    else throw new Error('Unknown or incomplete option. Run adjacent-sync --help.');
  }
  return { command, configPath: resolve(configPath), verbose };
}

// Resolve existing ancestors so a symlink cannot place private files in a checkout.
async function privateLocation(path) {
  let ancestor = path;
  const suffix = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (ancestor === dirname(ancestor)) throw error;
      suffix.unshift(relative(dirname(ancestor), ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const physical = join(ancestor, ...suffix);
  const directory = (await stat(ancestor)).isDirectory() ? ancestor : dirname(ancestor);
  const git = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 });
  if (git.status === 0 || within(resolve(HERE, '../..'), physical)) {
    throw new Error('Private config and state must stay outside Git checkouts.');
  }
  return physical;
}

export async function loadConfig(path) {
  const configPath = await privateLocation(path);
  let record;
  try { record = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Private config is missing. Run adjacent-sync init.');
    throw new Error('Private config could not be read. Check its JSON syntax.');
  }
  if (record?.schema_version !== 1 || !['local_root', 'remote_root', 'ssh_host'].every(key => cleanString(record[key]))) {
    throw new Error('Private config needs schema_version 1, local_root, remote_root, and ssh_host.');
  }
  let localRoot = record.local_root.startsWith('~/') ? join(homedir(), record.local_root.slice(2)) : record.local_root;
  if (!isAbsolute(localRoot) || !isAbsolute(record.remote_root)) throw new Error('Client and host data paths must be absolute.');
  try { localRoot = await realpath(localRoot); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(record.ssh_host)) throw new Error('ssh_host must name an SSH alias. Keep authentication in SSH config.');
  const unison = record.unison ?? 'unison';
  const remoteUnison = record.remote_unison ?? 'unison';
  if (!cleanString(unison) || (!isAbsolute(unison) && !/^[\w.+-]+$/.test(unison)) || !/^[a-zA-Z0-9_/.+-]+$/.test(remoteUnison) || remoteUnison.startsWith('-')) {
    throw new Error('Unison commands must be executable names or absolute paths. The host command cannot contain spaces.');
  }
  const stateDir = await privateLocation(join(dirname(configPath), 'sync-state'));
  if (within(localRoot, configPath) || within(localRoot, stateDir)) throw new Error('Private config and state must stay outside the synced data folder.');
  if (((await stat(configPath)).mode & 0o077) !== 0) throw new Error('Private config permissions must be owner-only. Run chmod 600 on the config file.');
  return { configPath, stateDir, localRoot, remoteRoot: record.remote_root, sshHost: record.ssh_host, unison, remoteUnison };
}

function version(text) {
  const match = /(?:unison\s+(?:version\s+)?)(\d+)\.(\d+)\.(\d+)/i.exec(text);
  if (!match || Number(match[1]) !== 2 || Number(match[2]) < 52) return null;
  return match.slice(1).join('.');
}

export function execute(binary, argv, { env = process.env, verbose = false, timeout = 30_000, preview = false } = {}) {
  return new Promise(resolveResult => {
    const child = spawn(binary, argv, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', prompt = '', quitSent = false, timedOut = false;
    let killTimer;
    const stop = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
      }, 1000);
    };
    const interrupt = () => { timedOut = true; stop(); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const cleanUp = () => {
      clearTimeout(timer); clearTimeout(killTimer);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    };
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (verbose) process.stdout.write(chunk);
      if (!preview || quitSent) return;
      prompt += chunk;
      // Never send an affirmative answer. Unknown prompts stop at the deadline.
      if (prompt.includes('Proceed with propagating updates?')) {
        quitSent = true; child.stdin.end('q\n'); prompt = '';
      } else if (prompt.includes('Press return to continue.') && /\[[^\]\r\n]*\] $/.test(prompt)) {
        child.stdin.write('\n'); prompt = '';
      } else if (/\[[^\]\r\n]*\] $/.test(prompt)) {
        child.stdin.write('n\n'); prompt = '';
      }
      if (prompt.length > 8192) prompt = prompt.slice(-8192);
    });
    child.stderr.on('data', chunk => { errors += chunk; if (verbose) process.stderr.write(chunk); });
    child.on('error', error => {
      cleanUp();
      resolveResult({ code: 3, output, errors, missing: error.code === 'ENOENT', timedOut, quitSent });
    });
    child.on('close', code => {
      cleanUp(); child.stdin.destroy();
      resolveResult({ code: code ?? 3, output, errors, timedOut, quitSent });
    });
    if (!preview) child.stdin.end();
  });
}

export async function readiness(config, verbose = false) {
  try {
    if (!(await stat(config.localRoot)).isDirectory()) return { ready: false, client: 'data folder is missing', host: 'not checked' };
  } catch { return { ready: false, client: 'data folder is missing', host: 'not checked' }; }
  const local = await execute(config.unison, ['-version'], { verbose });
  const clientVersion = version(local.output + local.errors);
  if (!clientVersion) return { ready: false, client: 'install Unison 2.52 or newer', host: 'not checked' };
  const command = `test -d ${shellQuote(config.remoteRoot)} || exit 42; ${shellQuote(config.remoteUnison)} -version`;
  const remote = await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', config.sshHost, command], { verbose });
  const hostVersion = version(remote.output + remote.errors);
  const host = remote.code === 42 ? 'data folder is missing' : remote.code === 127 ? 'install Unison 2.52 or newer' : remote.code === 0 && hostVersion ? `Unison ${hostVersion}, ready` : 'connection or Unison check failed';
  return { ready: local.code === 0 && remote.code === 0 && Boolean(hostVersion), client: `Unison ${clientVersion}, ready`, host };
}

export async function writeProfile(config, preview) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await chmod(config.stateDir, 0o700);
  const ignores = await readFile(join(HERE, 'ignore.prf'), 'utf8');
  const profile = `${preview ? 'preview' : 'run'}-${randomUUID()}`;
  const text = `# Generated private profile.\nroot = ${config.localRoot}\nroot = ssh://${config.sshHost}/${config.remoteRoot}\nservercmd = ${config.remoteUnison}\nsshargs = -oBatchMode=yes -oConnectTimeout=10\nlog = false\nperms = 0\nrsrc = false\nbatch = ${!preview}\nauto = true\nconfirmbigdel = ${!preview}\n${ignores}`;
  await writeFile(join(config.stateDir, `${profile}.prf`), text, { flag: 'wx', mode: 0o600 });
  return profile;
}

function changeLines(text) {
  // Only expose relative item rows, never Unison headers, root paths, or errors.
  return text.split(/\r?\n/).filter(line => /^.{8} (?:---->|<----|<-\?->|<-M->|     ) /.test(line));
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const options = args([...argv]);
  if (options.command === 'help') { console.log(HELP); return 0; }
  if (options.command === 'init') {
    const path = await privateLocation(options.configPath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const template = await readFile(join(HERE, 'config.example.json'));
    try { await writeFile(path, template, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Private config already exists. Edit it instead of running init again.');
      throw error;
    }
    console.log('Private config template created. Set the client path, host path, and SSH alias in the config file.');
    return 0;
  }
  const config = await loadConfig(options.configPath);
  const status = await readiness(config, options.verbose);
  console.log(`client: ${status.client}\nhost: ${status.host}`);
  if (!status.ready || options.command === 'status') return status.ready ? 0 : 3;
  const preview = options.command === 'preview';
  const profile = await writeProfile(config, preview);
  const result = await execute(config.unison, [profile, '-ui', 'text', '-dumbtty'], {
    env: { ...process.env, UNISON: config.stateDir }, verbose: options.verbose, preview, timeout: 30 * 60_000,
  });
  await unlink(join(config.stateDir, `${profile}.prf`));
  if (!options.verbose) for (const line of changeLines(result.output)) console.log(line.trimEnd());
  const code = preview && result.quitSent && result.code === 3 && !result.timedOut ? 0 : result.code;
  if (result.timedOut) console.log('Synchronization timed out. Run status before retrying.');
  else if (preview && code === 0) console.log('Preview complete. No files were transferred.');
  else if (code === 0) console.log('Synchronization complete.');
  else if (code === 1) console.log('Some items were skipped. Resolve conflicting changes, then run preview again.');
  else console.log('Unison did not complete. Use --verbose for private diagnostics.');
  return result.timedOut ? 3 : code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    // Filesystem and subprocess errors can contain private paths or connection details.
    const safe = error.message.startsWith('Private ') || error.message.startsWith('Unison commands') || error.message.startsWith('Client and host') || error.message.startsWith('ssh_host') || error.message.startsWith('Unknown ') || error.message.startsWith('Usage:');
    console.error(safe ? error.message : 'Adjacent sync failed. Check private config and filesystem access.');
    process.exitCode = 3;
  });
}
