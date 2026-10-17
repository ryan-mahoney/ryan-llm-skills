// node --test pi/extensions/spec-runtime/source-commands.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceCommand } from './source-commands.mjs';

test('Linux command boundary refuses source writes but allows declared build output', { skip: process.platform !== 'linux' ? 'Linux mount enforcement requires the execution host or Linux CI' : false }, t => {
  const root = mkdtempSync(join(tmpdir(), 'source-boundary-')), checkout = join(root, 'repo'), packageDir = join(root, 'package');
  mkdirSync(checkout); mkdirSync(packageDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', checkout]);
  writeFileSync(join(checkout, '.gitignore'), 'build/\n');
  writeFileSync(join(checkout, 'source.mjs'), 'export const value = 1;\n');
  execFileSync('git', ['-C', checkout, 'add', '.']);
  const record = { checkout, package: packageDir };
  const denied = sourceCommand(record, 'printf changed > source.mjs');
  try { assert.throws(() => execFileSync(denied.command, denied.args, { stdio: 'pipe', timeout: 10000 })); }
  finally { denied.cleanup(); }
  assert.equal(readFileSync(join(checkout, 'source.mjs'), 'utf8'), 'export const value = 1;\n');
  const allowed = sourceCommand(record, 'printf artifact > build/result.txt', { outputs: ['build'] });
  try { execFileSync(allowed.command, allowed.args, { stdio: 'pipe', timeout: 10000 }); }
  finally { allowed.cleanup(); }
  assert.equal(readFileSync(join(checkout, 'build/result.txt'), 'utf8'), 'artifact');
  assert.throws(() => sourceCommand(record, 'true', { outputs: ['source.mjs'] }), /no tracked source/);
});
