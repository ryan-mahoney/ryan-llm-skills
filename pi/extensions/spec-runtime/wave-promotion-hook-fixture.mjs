// Card49 promotion interruption seam.
//
// The canonical repository gets a real `reference-transaction` hook. It only
// observes and logs committed updates of the package branch; it never kills the
// coordinator, because a reference-transaction hook runs while `update-ref` is
// still waiting for the ref transaction to finish. The fixture-only `git`
// wrapper installed on PATH performs the fault injection later, at the exact
// read-tree boundary that the protected integration reaches only after its
// durable `ref-updated` journal write.
//
// Recovery stays real: an unarmed read-tree (including the replay performed by
// a replacement coordinator) delegates to the absolute real git untouched.
import {
  accessSync, chmodSync, constants, mkdirSync, realpathSync, statSync, writeFileSync
} from 'node:fs';
import { delimiter, join } from 'node:path';

function resolveExecutable(name) {
  const pathValue = typeof process.env.PATH === 'string' ? process.env.PATH : '';
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // Keep looking: a non-executable or missing entry is not the real tool.
    }
  }
  throw new Error(`unable to resolve ${name} on PATH before installing the fixture wrapper`);
}

export function installPromotionHook(primary, sandbox, branch, packagePath, integrationCheckout) {
  // Resolve the real git before the wrapper directory can influence PATH.
  const realGit = resolveExecutable('git');

  const hooksDir = join(primary, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'reference-transaction');
  const armedPath = join(sandbox, 'promotion-hook-armed.json');
  const hookScript = [
    `#!${process.execPath}`,
    "const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');",
    `const sandbox = ${JSON.stringify(sandbox)};`,
    `const packagePath = ${JSON.stringify(packagePath)};`,
    `const armedPath = ${JSON.stringify(armedPath)};`,
    `const integrationCheckout = ${JSON.stringify(integrationCheckout)};`,
    `const branch = ${JSON.stringify(branch)};`,
    "const phase = process.argv[2] ?? '';",
    'const hookPid = process.pid;',
    'const hookPpid = process.ppid;',
    "const targetRef = branch.startsWith('refs/') ? branch : 'refs/heads/' + branch;",
    "let coordinatorPid = '';",
    "try { coordinatorPid = readFileSync(sandbox + '/coordinator.pid', 'utf8').trim(); } catch { coordinatorPid = ''; }",
    "const observationsPath = sandbox + '/hook-observations.log';",
    "const hookLogPath = sandbox + '/hook.log';",
    "let input = '';",
    "try { input = readFileSync(0, 'utf8'); } catch { input = ''; }",
    "const lines = input.split('\\n').filter(line => line.trim() !== '');",
    'const matching = [];',
    'for (const line of lines) {',
    '  const parts = line.trim().split(/\\s+/);',
    '  if (parts.length < 3) continue;',
    "  if (parts.slice(2).join(' ') === targetRef) matching.push({ old: parts[0], new: parts[1], ref: targetRef });",
    '}',
    "const refmatch = matching.length > 0 ? 'yes' : 'no';",
    "if (phase !== 'committed') {",
    "  appendFileSync(observationsPath, 'phase=' + phase + ' pid=' + hookPid + ' ppid=' + hookPpid + ' refmatch=no coordinator_pid=' + coordinatorPid + ' kill_attempt=none\\n');",
    '  process.exit(0);',
    '}',
    "for (const update of matching) appendFileSync(hookLogPath, update.old + ' ' + update.new + ' ' + update.ref + '\\n');",
    "if (matching.length > 0 && existsSync(sandbox + '/kill-on-promote')) {",
    '  const update = matching[0];',
    "  writeFileSync(armedPath, JSON.stringify({ phase, old: update.old, new: update.new, ref: update.ref, branch, packagePath, integrationCheckout, hook_pid: hookPid, hook_ppid: hookPpid, coordinator_pid: coordinatorPid }, null, 2) + '\\n');",
    '}',
    "appendFileSync(observationsPath, 'phase=' + phase + ' pid=' + hookPid + ' ppid=' + hookPpid + ' refmatch=' + refmatch + ' coordinator_pid=' + coordinatorPid + ' kill_attempt=none\\n');",
    'process.exit(0);',
  ].join('\n') + '\n';
  writeFileSync(hookPath, hookScript);
  chmodSync(hookPath, 0o755);

  const promotionBin = join(sandbox, 'promotion-bin');
  mkdirSync(promotionBin, { recursive: true });
  const wrapperPath = join(promotionBin, 'git');
  const wrapperScript = [
    `#!${process.execPath}`,
    "const { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    `const realGit = ${JSON.stringify(realGit)};`,
    `const sandbox = ${JSON.stringify(sandbox)};`,
    `const packagePath = ${JSON.stringify(packagePath)};`,
    `const integrationCheckout = ${JSON.stringify(integrationCheckout)};`,
    `const armedPath = ${JSON.stringify(armedPath)};`,
    `const killPath = ${JSON.stringify(join(sandbox, 'kill-on-promote'))};`,
    `const observationsPath = ${JSON.stringify(join(sandbox, 'hook-observations.log'))};`,
    'const args = process.argv.slice(2);',
    "function fail(message) { process.stderr.write('promotion-hook-fixture: ' + message + '\\n'); process.exit(1); }",
    "function delegate() {",
    "  const result = spawnSync(realGit, args, { stdio: 'inherit' });",
    "  if (result.error) fail('cannot run real git: ' + result.error.message);",
    "  if (result.signal) { try { process.kill(process.pid, result.signal); } catch {} process.exit(1); }",
    '  process.exit(result.status ?? 1);',
    '}',
    "const isIntercept = args.length === 7 && args[0] === '-C' && args[1] === integrationCheckout && args[2] === 'read-tree' && args[3] === '-m' && args[4] === '-u';",
    'if (!isIntercept) delegate();',
    'if (!existsSync(armedPath)) delegate();',
    'let marker = null;',
    "try { marker = JSON.parse(readFileSync(armedPath, 'utf8')); } catch (error) { fail('armed promotion marker is unreadable: ' + error.message); }",
    "if (!marker || marker.old !== args[5] || marker.new !== args[6] || typeof marker.ref !== 'string') fail('armed promotion marker does not match the read-tree command: ' + JSON.stringify(marker));",
    "if (marker.packagePath !== packagePath || marker.integrationCheckout !== integrationCheckout) fail('armed promotion marker names another fixture: ' + JSON.stringify(marker));",
    "const wavesDir = packagePath + '/runtime/waves';",
    'let entries = [];',
    "try { entries = readdirSync(wavesDir).filter(name => name.endsWith('.json')); } catch (error) { fail('cannot read the durable wave journal directory ' + wavesDir + ': ' + error.message); }",
    'const matches = [];',
    'const mismatches = [];',
    'for (const name of entries) {',
    "  const file = wavesDir + '/' + name;",
    '  let record = null;',
    "  try { record = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { fail('cannot parse the durable wave journal ' + file + ': ' + error.message); }",
    '  const promotion = record && record.target && record.target.promotion ? record.target.promotion : null;',
    '  if (!promotion) continue;',
    '  if (promotion.expected_old === args[5] && promotion.candidate === args[6] && promotion.checkout === integrationCheckout) {',
    "    if (record.state === 'promoting' && promotion.state === 'ref-updated') matches.push({ file, record, promotion });",
    '    else mismatches.push({ file, state: record.state, promotion_state: promotion.state });',
    '  }',
    '}',
    "if (matches.length === 0) fail('armed read-tree has no durable ref-updated journal: ' + JSON.stringify(mismatches));",
    "if (matches.length > 1) fail('armed read-tree matches multiple durable ref-updated journals: ' + JSON.stringify(matches.map(match => match.file)));",
    'const journal = matches[0];',
    'const branch = journal.promotion.branch;',
    "if (typeof branch !== 'string' || branch === '') fail('the durable journal names no branch');",
    "const expectedRef = branch.startsWith('refs/') ? branch : 'refs/heads/' + branch;",
    "if (marker.ref !== expectedRef) fail('the committed hook armed ' + marker.ref + ' but the journal names ' + expectedRef);",
    "const observed = spawnSync(realGit, ['-C', integrationCheckout, 'rev-parse', branch], { encoding: 'utf8' });",
    "if (observed.error) fail('cannot observe branch ' + branch + ': ' + observed.error.message);",
    "if (observed.status !== 0) fail('cannot observe branch ' + branch + ': ' + (observed.stderr ?? '').trim());",
    "if (observed.stdout.trim() !== args[6]) fail('branch ' + branch + ' does not hold the read-tree candidate ' + args[6] + ': ' + observed.stdout.trim());",
    "let coordinatorPid = '';",
    "try { coordinatorPid = readFileSync(sandbox + '/coordinator.pid', 'utf8').trim(); } catch (error) { fail('the armed promotion has no recorded coordinator pid: ' + error.message); }",
    "if (!/^[1-9][0-9]*$/.test(coordinatorPid)) fail('the armed promotion coordinator pid is invalid: ' + JSON.stringify(coordinatorPid));",
    "try { unlinkSync(armedPath); } catch (error) { fail('cannot consume the armed promotion marker: ' + error.message); }",
    "try { if (existsSync(killPath)) unlinkSync(killPath); } catch (error) { fail('cannot consume the kill marker: ' + error.message); }",
    "appendFileSync(observationsPath, 'phase=journal-ref-updated coordinator_pid=' + coordinatorPid + ' old=' + args[5] + ' new=' + args[6] + ' ref=' + marker.ref + '\\n');",
    "try { process.kill(Number(coordinatorPid), 'SIGKILL'); } catch (error) { fail('cannot SIGKILL coordinator ' + coordinatorPid + ': ' + error.message); }",
    'process.exit(97);',
  ].join('\n') + '\n';
  writeFileSync(wrapperPath, wrapperScript);
  chmodSync(wrapperPath, 0o755);
  return promotionBin;
}
