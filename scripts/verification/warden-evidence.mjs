import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const receiptCommand = resolve(dirname(fileURLToPath(import.meta.url)), 'ci.mjs');

// Only simple invocations qualify. Piped, backgrounded, quoted data or compound
// commands need the existing guard's judgment; a command's text is not evidence.
export function classifyProjectCheck(tool, input, failed, output = '', cwd) {
  if (tool !== 'bash' || typeof input.command !== 'string') return undefined;
  const command = input.command.trim();
  if (/[\n;&|`<>]/.test(command) || command.includes('$(')) return undefined;
  const isLocal = /^(?:[A-Z_][A-Z_0-9]*=[\w./:-]+\s+)*(?:mix\s+(?:precommit|test|compile|format --check-formatted)\b|(?:\.\/)?bin\/test-all\b|mise\s+run\s+test:elixir\b)/.test(command);
  if (isLocal) {
    if (/\s--help\b|\s-h\b/.test(command)) return 'unknown';
    if (failed) return 'check-fail';
    if (/\b(?:precommit|test-all|test:elixir|mix\s+test)\b/.test(command)) {
      const summaries = [...String(output).matchAll(/^\d+ (?:[a-z]+, \d+ )*tests?, (\d+) failures?\b/gm)];
      if (!summaries.length) return 'unknown';
      return summaries.some(match => Number(match[1]) > 0) ? 'check-fail' : 'check-pass';
    }
    return 'check-pass';
  }
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(value => value.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  const script = tokens[1]?.startsWith('~/') ? resolve(homedir(), tokens[1].slice(2)) : tokens[1];
  if (!/^(?:.*\/)?node$/.test(tokens[0] ?? '') || !script || resolve(cwd ?? process.cwd(), script) !== receiptCommand) return undefined;
  if (failed) return 'check-fail';
  try {
    const receipt = JSON.parse(String(output).trim());
    if (receipt.type !== 'verification_evidence' || receipt.schema_version !== 1 || receipt.kind !== 'ci') return 'unknown';
    if (receipt.status !== 'passed' || !receipt.checkout_clean || !receipt.head_verified || !receipt.checks?.length || receipt.checks.some(check => check.status !== 'pass')) return 'unknown';
    const options = { encoding: 'utf8', timeout: 3000 };
    const repo = resolve(cwd ?? process.cwd());
    if (resolve(receipt.repo) !== repo) return 'unknown';
    const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], options);
    const dirty = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=normal'], options);
    return head.status === 0 && dirty.status === 0 && !dirty.stdout.trim() && head.stdout.trim() === receipt.revision ? 'check-pass' : 'unknown';
  } catch { return 'unknown'; }
}
