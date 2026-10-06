import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Facts only: no fetch, index refresh, hooks, patch generation or readiness verdict.
export function gitFacts({ repo = process.cwd(), base, head, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be 1..1000');
  if (head && !base) throw new Error('head requires an explicit base');
  const cwd = resolve(repo);
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const optional = (...args) => { try { return git(...args).trim(); } catch (error) { if (error.status === 1) return null; throw error; } };
  const revision = value => {
    if (typeof value !== 'string' || !value || value.startsWith('-')) throw new Error('invalid revision');
    return git('rev-parse', '--verify', '--end-of-options', `${value}^{commit}`).trim();
  };
  const bounded = entries => ({ total: entries.length, omitted: Math.max(0, entries.length - limit), entries: entries.slice(0, limit) });
  const checkoutHead = optional('rev-parse', '--verify', '--quiet', 'HEAD');
  const branch = optional('symbolic-ref', '--quiet', '--short', 'HEAD');
  // NUL records preserve spaces, quotes and newlines. Moves appear as delete/add.
  const status = git('status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none')
    .split('\0').filter(Boolean).map(entry => ({ status: entry.slice(0, 2), path: entry.slice(3) }));
  const result = { schema_version: 1, observed_at: new Date().toISOString(), repo: cwd,
    branch, head: checkoutHead, clean: status.length === 0, snapshot: 'non_atomic',
    staged: bounded(status.filter(e => ![' ', '?'].includes(e.status[0]))),
    unstaged: bounded(status.filter(e => e.status[0] !== '?' && e.status[1] !== ' ')),
    untracked: bounded(status.filter(e => e.status === '??')) };
  if (base) {
    const from = revision(base), to = revision(head || 'HEAD');
    const fields = git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', from, to, '--').split('\0');
    const changed = [];
    for (let i = 0; i < fields.length - 1; i += 2) changed.push({ status: fields[i], path: fields[i + 1] });
    result.range = { base: from, head: to, comparison: 'endpoints',
      commits_ahead: Number(git('rev-list', '--count', `${from}..${to}`, '--').trim()), changed: bounded(changed) };
  }
  return result;
}

const diagnostic = /\b(?:error|failed|failure|fatal|exception|panic|assertion)\b|^\s*(?:not ok\b|FAIL\b|[×✖])/i;
const stripAnsi = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

// A bounded excerpt selector, not a test-result parser. Short output stays exact.
export function createLogSummary() {
  const decoder = new StringDecoder('utf8');
  let raw = '', head = '', tail = '', pending = '', excerpts = '', previous = '';
  let bytes = 0, chars = 0, line = 0, hits = 0, following = 0, lastSelected = 0, clipped = false, ended = false;
  const select = (number, text) => {
    if (number <= lastSelected) return;
    const entry = `${number}: ${text}\n`;
    if (excerpts.length + entry.length <= 4000) { excerpts += entry; lastSelected = number; }
    else clipped = true;
  };
  const consumeLine = text => {
    line++;
    if (diagnostic.test(stripAnsi(text))) {
      hits++;
      if (previous) select(line - 1, previous);
      select(line, text); following = 3;
    } else if (following > 0) { select(line, text); following--; }
    previous = text;
  };
  const consume = text => {
    chars += text.length;
    if (chars <= 8000) raw += text; else raw = '';
    head = (head + text).slice(0, 1000);
    tail = (tail + text).slice(-2000);
    // Keep a capped prefix per physical line regardless of stream chunking.
    for (const part of text.split(/(?<=\n)/)) {
      if (!part) continue;
      const end = part.endsWith('\n');
      const value = end ? part.slice(0, -1) : part;
      if (pending.length + value.length > 1000) clipped = true;
      pending = (pending + value).slice(0, 1000);
      if (end) { consumeLine(pending); pending = ''; }
    }
  };
  return {
    write(chunk) {
      if (ended) throw new Error('summary already finished');
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length; consume(decoder.write(buffer));
    },
    finish() {
      if (ended) throw new Error('summary already finished');
      ended = true; consume(decoder.end()); if (pending) consumeLine(pending);
      const truncated = chars > 8000;
      return { output: truncated
        ? `[Excerpt only; full raw log retained. Pattern matches are not a verdict.]\nSTART:\n${head}\nDIAGNOSTIC PATTERN EXCERPTS (line: text):\n${excerpts || '(none captured)\n'}END:\n${tail}`
        : raw,
      output_truncated: truncated, output_bytes: bytes,
      ...(truncated ? { excerpt_selection: { pattern_matching_lines: hits, clipped, exhaustive: false } } : {}) };
    },
  };
}

export async function summarizeLog(file) {
  const summary = createLogSummary();
  for await (const chunk of createReadStream(file)) summary.write(chunk);
  return { ...summary.finish(), full_output_path: resolve(file), exit_code: null };
}
