import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  PREPARATION_BYTES, parsePreparation, parseDecision, parseProposalFrontMatter,
  readPreparation, readDecision, readPlanningArtifacts,
} from './preparation.mjs';
// Run independently: node --test scripts/spec-observe/preparation.test.mjs

async function fixture(t, name = 'package') {
  const dir = await realpath(mkdtempSync(join(tmpdir(), 'preparation-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, name);
  mkdirSync(pkg, { recursive: true });
  return { dir, pkg };
}

const budgetOf = cap => ({ bytes: 0, cap, fits(extra) { return this.bytes + extra <= this.cap; } });
const isInside = (root, child) => child !== root && child.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

// Mirrors the sentinel reader's observable contract over real fixture files:
// within-check, per-file cap + oversize, budget refusal and memo forwarding
// (a refused read is never memoized). `cap` and `truncateAt` let a case
// simulate the legacy 4 KiB reader and a partial read.
function readerFor({ cap = PREPARATION_BYTES, truncateAt = null, calls = [] } = {}) {
  const readOnce = (file, maxBytes, budget, within) => {
    let real;
    try {
      real = realpathSync(file);
      if (within && !isInside(realpathSync(within), real)) return { outcome: 'invalid', reason: `source-outside: ${file}`, bytes: 0 };
      const info = statSync(file);
      if (!info.isFile()) return { outcome: 'invalid', reason: `source-not-regular: ${file}`, bytes: 0 };
      const limit = Math.min(maxBytes ?? cap, cap);
      if (!budget.fits(Math.min(info.size, limit + 1))) return { outcome: 'read-budget', reason: `read-budget: ${file}`, bytes: 0 };
      if (info.size > limit) return { outcome: 'oversized', reason: null, bytes: info.size };
      const text = readFileSync(file, 'utf8');
      const bytes = Buffer.byteLength(text);
      budget.bytes += bytes;
      if (truncateAt !== null && bytes > truncateAt) {
        const partial = text.slice(0, truncateAt);
        return { outcome: 'ok', text: partial, bytes: Buffer.byteLength(partial) };
      }
      return { outcome: 'ok', text, bytes };
    } catch (error) {
      return { outcome: error.code === 'ENOENT' ? 'missing' : 'invalid', reason: `${error.code}: ${file}`, bytes: 0 };
    }
  };
  return async (file, maxBytes, budget, { within, memo } = {}) => {
    // Record only underlying reads: a memo hit is served without a new read.
    if (memo?.has(file)) return memo.get(file);
    calls.push({ file, maxBytes, within, memo });
    const result = readOnce(file, maxBytes, budget, within);
    if (memo && result.outcome !== 'read-budget') memo.set(file, result);
    return result;
  };
}

test('preparation outcomes accept observed spellings and reject conflicts', () => {
  assert.deepEqual(
    parsePreparation('# Preparation\n\nOverall outcome: prepared. Preparation version: 3. Prepared 2026-10-13 against agents revision `abc`.\n', 'spec-prepare.md'),
    { outcome: 'prepared', reported_at: '2026-10-13', source: 'spec-prepare.md' });
  for (const text of ['Outcome: prepared\n', 'outcome: prepared\n', 'Overall outcome: `prepared`\n', 'Outcome: prepared, package ready.\n']) {
    assert.equal(parsePreparation(text, 's').outcome, 'prepared', text);
  }
  assert.equal(parsePreparation('Outcome: decision-required. Package prepared: no.\n', 's').outcome, 'decision-required');
  assert.equal(parsePreparation('Overall outcome: blocked. Package prepared: no.\n', 's').outcome, 'blocked');
  assert.equal(parsePreparation('Overall outcome: prepared\nOutcome: prepared.\n', 's').outcome, 'prepared', 'identical repeats are allowed');
  const conflict = parsePreparation('Overall outcome: prepared\noutcome: blocked\n', 's');
  assert.equal(conflict.outcome, 'invalid');
  assert.equal(conflict.reported_at, null);
  assert.equal(parsePreparation('# Preparation\nNo recognized outcome here.\n', 's').outcome, 'invalid');
  assert.equal(parsePreparation('Overall outcome: preparedness\n', 's').outcome, 'invalid');
  assert.equal(parsePreparation('Outcome: blocked\nReview date 2026-01-02.\n', 's').reported_at, '2026-01-02');
  assert.equal(parsePreparation('Overall outcome: prepared.\nRevision 2026-10-13.\n', 's').reported_at, null, 'a date away from Prepared/Date/Review is not a report date');
});

test('preparation outcomes reject malformed tokens that extend or unbalance prepared', () => {
  for (const text of [
    'Outcome: prepared2\n',
    'Outcome: prepared_unknown\n',
    'Overall outcome: `prepared\n',
    'Outcome: prepared`\n',
    'Outcome: decision-required2\n',
    'Outcome: `blocked\n',
  ]) assert.equal(parsePreparation(text, 's').outcome, 'invalid', text);
  assert.equal(parsePreparation('Outcome: `prepared`\n', 's').outcome, 'prepared');
  assert.equal(parsePreparation('Outcome: prepared; continuing review.\n', 's').outcome, 'prepared');
});

test('a 17 KiB report needs the complete 64 KiB read; a 4 KiB-capped reader is refused', async t => {
  const { pkg } = await fixture(t);
  const report = join(pkg, 'spec-prepare.md');
  writeFileSync(report, `# Preparation\n\nOverall outcome: prepared. Prepared 2026-10-13 against revision.\n\n${'Body line with details.\n'.repeat(700)}`);
  const size = statSync(report).size;
  assert.ok(size > 16 * 1024 && size < PREPARATION_BYTES, `fixture is ${size} bytes`);
  const calls = [];
  const memo = new Map();
  const full = await readPreparation(pkg, budgetOf(1 << 20), { readBounded: readerFor({ calls }), memo });
  assert.equal(full.outcome, 'prepared');
  assert.equal(full.reported_at, '2026-10-13');
  assert.equal(full.read, 'ok');
  assert.equal(full.bytes, size);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxBytes, PREPARATION_BYTES);
  assert.equal(calls[0].within, pkg);
  assert.equal(calls[0].memo, memo);

  // The legacy first-4KiB reader cannot serve the complete report: its
  // oversized refusal stays invalid, never prepared.
  const legacy = await readPreparation(pkg, budgetOf(1 << 20), { readBounded: readerFor({ cap: 4096 }) });
  assert.equal(legacy.outcome, 'invalid');
  assert.equal(legacy.read, 'oversized');
  assert.notEqual(legacy.outcome, 'prepared');

  // A partial 4 KiB view of a long-preamble report cannot fabricate prepared.
  const { pkg: longPkg } = await fixture(t, 'long');
  writeFileSync(join(longPkg, 'spec-prepare.md'), `${'Preamble\n'.repeat(900)}Overall outcome: prepared\n${'Body\n'.repeat(900)}`);
  const truncated = await readPreparation(longPkg, budgetOf(1 << 20), { readBounded: readerFor({ truncateAt: 4096 }) });
  assert.equal(truncated.outcome, 'invalid');
  assert.notEqual(truncated.outcome, 'prepared');
  assert.equal((await readPreparation(longPkg, budgetOf(1 << 20), { readBounded: readerFor() })).outcome, 'prepared');
});

test('missing, oversized, source-outside and budget-refused reports never read prepared', async t => {
  const { dir, pkg } = await fixture(t);
  const report = join(pkg, 'spec-prepare.md');
  const budget = budgetOf(1 << 20);
  const missing = await readPreparation(pkg, budget, { readBounded: readerFor() });
  assert.equal(missing.outcome, 'missing');
  assert.equal(missing.read, 'missing');
  assert.notEqual(missing.outcome, 'prepared');

  writeFileSync(report, `Overall outcome: prepared\n${'x'.repeat(PREPARATION_BYTES)}`);
  const oversized = await readPreparation(pkg, budgetOf(1 << 21), { readBounded: readerFor() });
  assert.equal(oversized.outcome, 'invalid');
  assert.equal(oversized.read, 'oversized');

  rmSync(report);
  const outside = join(dir, 'outside-prepare.md');
  writeFileSync(outside, 'Overall outcome: prepared\n');
  symlinkSync(outside, report);
  const escaped = await readPreparation(pkg, budget, { readBounded: readerFor() });
  assert.equal(escaped.outcome, 'invalid');
  assert.notEqual(escaped.outcome, 'prepared');
  assert.match(escaped.reason ?? '', /source-outside/);

  rmSync(report);
  writeFileSync(report, 'Overall outcome: prepared\n');
  const calls = [];
  const memo = new Map();
  const refused = await readPreparation(pkg, budgetOf(0), { readBounded: readerFor({ calls }), memo });
  assert.equal(refused.outcome, 'unavailable');
  assert.equal(refused.read, 'read-budget');
  assert.equal(memo.has(report), false, 'a budget refusal is not a file fact');
  const retried = await readPreparation(pkg, budgetOf(1 << 20), { readBounded: readerFor({ calls }), memo });
  assert.equal(retried.outcome, 'prepared', 'the refused read was retried, not cached');
  assert.equal(calls.length, 2);
});

test('decision front matter preserves validated fields and refuses malformed records', async t => {
  const { pkg } = await fixture(t);
  const source = join(pkg, 'decision-required.md');
  const question = 'Which packages should resume planning without a recorded worktree?';
  const recommendation = 'Resume only packages whose proposal recommends no critique.';
  writeFileSync(source, [
    '---',
    'stage: specification',
    `question: ${JSON.stringify(question)}`,
    `recommendation: ${JSON.stringify(recommendation)}`,
    'recorded_at: 2026-10-13T19:00:00.000Z',
    'unknown_key: ignored',
    'recommendation_copy: ignored',
    '---',
    '# Decision required',
    'Body text stays out of the observation.',
    '',
  ].join('\n'));
  const decision = await readDecision(pkg, budgetOf(1 << 20), { readBounded: readerFor() });
  assert.deepEqual(decision, { stage: 'specification', question, recommendation, recorded_at: '2026-10-13T19:00:00.000Z', source });
  assert.equal(JSON.stringify(decision).includes('Body text stays out'), false);

  const long = parseDecision(`---\nstage: architecture\nquestion: ${JSON.stringify('q'.repeat(600))}\nrecommendation: ""\nrecorded_at: 2026-10-13T19:00:00.000Z\n---\n`);
  assert.equal(long.question.length, 500, 'display excerpt is truncated after validation');
  assert.equal(long.recommendation, '');

  for (const text of [
    '---\nstage: specification\nquestion: "Missing recommendation key"\nrecorded_at: 2026-10-13T19:00:00.000Z\n---\n',
    '---\nstage: implementation\nquestion: "Bad stage"\nrecommendation: ""\nrecorded_at: 2026-10-13T19:00:00.000Z\n---\n',
    '---\nstage: architecture\nquestion: ""\nrecommendation: ""\nrecorded_at: 2026-10-13T19:00:00.000Z\n---\n',
    '---\nstage: architecture\nquestion: "Bad time"\nrecommendation: ""\nrecorded_at: not-a-date\n---\n',
    '# Heading\n---\nstage: architecture\nquestion: "Not at start"\nrecommendation: ""\nrecorded_at: 2026-10-13T19:00:00.000Z\n---\n',
    '---\nstage: architecture\nquestion: "No closing marker"\nrecommendation: ""\nrecorded_at: 2026-10-13T19:00:00.000Z\n',
  ]) assert.equal(parseDecision(text, 's'), null, text);

  writeFileSync(source, '---\nstage: architecture\nquestion: "Broken"\n---\n');
  const malformed = await readDecision(pkg, budgetOf(1 << 20), { readBounded: readerFor() });
  assert.equal(malformed.outcome, 'unavailable');
  assert.equal(malformed.stage, undefined);
  assert.notEqual(malformed.outcome, undefined);

  rmSync(source);
  assert.equal(await readDecision(pkg, budgetOf(1 << 20), { readBounded: readerFor() }), null, 'no decision file is no decision');

  writeFileSync(source, `---\nstage: architecture\nquestion: "Oversized"\nrecommendation: "${'x'.repeat(PREPARATION_BYTES)}"\nrecorded_at: 2026-10-13T19:00:00.000Z\n---\n`);
  assert.equal((await readDecision(pkg, budgetOf(1 << 21), { readBounded: readerFor() })).outcome, 'invalid');
  writeFileSync(source, '---\nstage: architecture\nquestion: "Budget"\nrecommendation: ""\nrecorded_at: 2026-10-13T19:00:00.000Z\n---\n');
  const refused = await readDecision(pkg, budgetOf(0), { readBounded: readerFor() });
  assert.equal(refused.outcome, 'unavailable');
  assert.equal(refused.read, 'read-budget');
});

test('proposal front matter reads only the leading explicit boolean', () => {
  assert.equal(parseProposalFrontMatter('---\nverdict: COMPATIBLE\ncritique_recommended: true\n---\n\n# Proposal\n'), true);
  assert.equal(parseProposalFrontMatter('---\ncritique_recommended: false\n---\n'), false);
  assert.equal(parseProposalFrontMatter('---\ncritique_recommended: "false"\n---\n'), false);
  assert.equal(parseProposalFrontMatter('---\nverdict: COMPATIBLE\n---\n'), null, 'missing recommendation is unknown');
  assert.equal(parseProposalFrontMatter('# Proposal\n---\ncritique_recommended: true\n---\n'), null, 'front matter must be at the file start');
  assert.equal(parseProposalFrontMatter('---\ncritique_recommended: maybe\n---\n'), null);
  assert.equal(parseProposalFrontMatter('---\ncritique_recommended: true\n'), null, 'a missing closing marker is malformed');
});

test('front matter rejects duplicate recognized keys instead of overwriting', () => {
  assert.equal(parseProposalFrontMatter('---\ncritique_recommended: true\ncritique_recommended: false\n---\n'), null, 'conflicting proposal booleans are malformed');
  assert.equal(parseProposalFrontMatter('---\ncritique_recommended: false\ncritique_recommended: true\n---\n'), null);
  assert.equal(parseDecision('---\nstage: architecture\nstage: specification\nquestion: "Q"\nrecommendation: ""\nrecorded_at: 2026-10-13T19:00:00.000Z\n---\n', 's'), null, 'duplicate stage is malformed');
  assert.equal(parseDecision('---\nstage: architecture\nquestion: "First"\nquestion: "Second"\nrecommendation: ""\nrecorded_at: 2026-10-13T19:00:00.000Z\n---\n', 's'), null, 'duplicate question is malformed');
  assert.equal(parseProposalFrontMatter('---\nnote: one\nnote: two\ncritique_recommended: true\n---\n'), true, 'duplicate unrecognized keys stay ignored');
});

test('planning artifacts report presence and the proposal recommendation conservatively', async t => {
  const { dir, pkg } = await fixture(t);
  const proposal = join(pkg, 'proposal.md');
  const critique = join(pkg, 'critique.md');
  const read = (budget = budgetOf(1 << 20), options = { readBounded: readerFor() }) => readPlanningArtifacts(pkg, budget, options);

  assert.deepEqual(await read(), { proposal: false, critique: false, critique_recommended: false });
  writeFileSync(proposal, '---\nverdict: COMPATIBLE_WITH_CAVEATS\ncritique_recommended: true\n---\n\n# Proposal\n');
  writeFileSync(critique, '# Critique\n');
  assert.deepEqual(await read(), { proposal: true, critique: true, critique_recommended: true });
  writeFileSync(proposal, '---\nverdict: COMPATIBLE\n---\n\n# Proposal\n');
  rmSync(critique);
  assert.deepEqual(await read(), { proposal: true, critique: false, critique_recommended: null }, 'a present proposal without an explicit boolean is unknown');
  writeFileSync(proposal, '---\ncritique_recommended: false\n---\n');
  assert.equal((await read()).critique_recommended, false);
  // Both files must exist for a budget refusal to be the observed reason: an
  // absent file is genuinely false, so only present files can stay unknown.
  writeFileSync(critique, '# Critique\n');
  assert.deepEqual(await read(budgetOf(0)), { proposal: null, critique: null, critique_recommended: null }, 'a budget refusal stays unknown');
  // Restore the absent-critique fixture the escaping case below relies on.
  rmSync(critique);

  const outside = join(dir, 'outside-proposal.md');
  writeFileSync(outside, '---\ncritique_recommended: true\n---\n');
  rmSync(proposal);
  symlinkSync(outside, proposal);
  assert.deepEqual(await read(), { proposal: null, critique: false, critique_recommended: null }, 'an escaping proposal stays unknown');
  rmSync(proposal);

  writeFileSync(proposal, '---\ncritique_recommended: true\n---\n');
  writeFileSync(critique, 'x'.repeat(PREPARATION_BYTES + 1));
  assert.deepEqual(await read(budgetOf(1 << 21)), { proposal: true, critique: null, critique_recommended: true }, 'an oversized critique is unknown, not absent');

  rmSync(critique);
  writeFileSync(critique, '# Critique\n');
  const calls = [];
  const memo = new Map();
  const options = { readBounded: readerFor({ calls }), memo };
  await readPlanningArtifacts(pkg, budgetOf(1 << 20), options);
  await readPlanningArtifacts(pkg, budgetOf(1 << 20), options);
  assert.equal(calls.length, 2, 'the injected memo serves the second observation');
});
