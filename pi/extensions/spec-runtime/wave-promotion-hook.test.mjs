// Card49 regression: the native promotion hook must not kill the coordinator
// before the ref update returns and the durable journal is written.
//
// Scope note: this is a *fault-injection* regression, not kernel proof. It runs
// against the real `reference-transaction` hook installed by
// `makeWaveFixture({ members: 1, promotionKill: true })` on the real canonical
// fixture repository, and drives the protected order (update-ref, journal,
// read-tree) itself from a small Node stand-in coordinator. It does not import
// or modify the protected integration, so a green result records
// `kernel_proof=false`: it proves the hook ordering contract only.
//
// Protocol (the exact existing order of the protected integration):
//   1. git update-ref <branch> <candidate> <expected_old>
//   2. durable wave record target.promotion.state = 'ref-updated'
//   3. git -C <integration checkout> read-tree -m -u <expected_old> <candidate>
//
// Current behaviour kills the coordinator inside the hook, i.e. during (1),
// before (2). The assertions below therefore require the SIGKILL, the surviving
// candidate ref, the durable `ref-updated` journal entry, an untouched index and
// checkout, and exactly one committed branch update in the hook log. Absent the
// journal entry the case must stay red; do not weaken it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeWaveFixture } from './package-fixture.mjs';

const FIXTURE_TIMEOUT_MS = 120000;
const COORDINATOR_TIMEOUT_MS = 15000;

// The stand-in coordinator: records its pid, arms the hook kill, performs the
// three protected steps in order and reports each completed step. Ordinary
// stdout pipe output; stdin is never touched.
const COORDINATOR_SCRIPT = `import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const [sandbox, repo, branch, candidate, expectedOld, checkout, packagePath] = process.argv.slice(1);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const recordPath = join(packagePath, 'runtime', 'waves', 'wave-001.json');

writeFileSync(join(sandbox, 'coordinator.pid'), String(process.pid));
writeFileSync(join(sandbox, 'kill-on-promote'), 'armed\\n');

git(repo, 'update-ref', branch, candidate, expectedOld);
process.stdout.write('ref-updated\\n');

mkdirSync(dirname(recordPath), { recursive: true });
writeFileSync(recordPath, JSON.stringify({
  wave_id: 'wave-001',
  state: 'promoting',
  target: { promotion: { state: 'ref-updated', expected_old: expectedOld, candidate, branch, checkout } }
}, null, 2) + '\\n');
process.stdout.write('journal-written\\n');

git(checkout, 'read-tree', '-m', '-u', expectedOld, candidate);
process.stdout.write('read-tree-done\\n');
`;

// A candidate commit built in a temporary index: neither the integration
// checkout nor its index is touched. The result is a real commit object in the
// fixture's canonical repository, reachable from the package branch only after
// the stand-in performs its update-ref.
function buildCandidateCommit(fixture, repo, expectedOld) {
  // The temporary index lives inside the fixture directory so fixture cleanup
  // removes it; no external mkdtemp directory is left behind.
  const indexPath = join(fixture.dir, 'candidate.index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const git = (args, input) =>
    execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', input });

  // Seed the temporary index from the expected old commit, then add the one
  // candidate-only file so the resulting tree differs from the old tree.
  git(['read-tree', expectedOld]);
  const blob = git(['hash-object', '-w', '--stdin'], 'candidate content\n').trim();
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},candidate-only.txt`]);
  const tree = git(['write-tree']).trim();
  const commit = git(
    ['commit-tree', tree, '-p', expectedOld, '-m', 'Candidate promotion commit'],
    undefined
  ).trim();
  return commit;
}

test(
  'wave promotion: hook kill after ref update preserves candidate, journal and checkout',
  { timeout: FIXTURE_TIMEOUT_MS },
  async t => {
    const fixture = await makeWaveFixture({
      members: 1,
      promotionKill: true,
      prefix: 'spec-wave-hook-'
    });
    let child = null;
    try {
      const targetId = fixture.options.targets[0];
      const repo = fixture.paths[targetId];
      // `git update-ref` rejects a short branch name, so both cases declare the
      // full ref instead; an already-full declaration is preserved as-is.
      const branch = normalizeBranchRef(fixture.locations.targets[0].branch);
      const checkout = fixture.integrationCheckout;
      const expectedOld = gitOutput(checkout, 'rev-parse', branch);

      // Real candidate commit via a temporary index.
      const candidate = buildCandidateCommit(fixture, repo, expectedOld);
      assert.equal(
        gitOutput(repo, 'cat-file', '-t', candidate),
        'commit',
        'the candidate is a real commit object in the canonical fixture repository'
      );
      assert.notEqual(candidate, expectedOld, 'the candidate differs from the expected old value');

      // Protocol preconditions: the integration checkout is at the expected old
      // value and the candidate-only file is absent from its tracked tree.
      assert.equal(
        gitOutput(checkout, 'rev-parse', 'HEAD'),
        expectedOld,
        'the integration checkout starts at the package branch head'
      );
      assert.equal(
        gitOutput(checkout, 'ls-tree', '-r', '--name-only', 'HEAD').includes('candidate-only.txt'),
        false,
        'the candidate-only file is absent before promotion'
      );

      child = spawn(
        process.execPath,
        ['-e', COORDINATOR_SCRIPT, '--',
          fixture.dir, repo, branch, candidate, expectedOld, checkout, fixture.packagePath],
        {
          // Preserve PATH: the future repaired fixture may supply promotionBin;
          // until then the inherited environment is used unchanged.
          env: fixture.promotionBin
            ? { ...process.env, PATH: `${fixture.promotionBin}:${process.env.PATH ?? ''}` }
            : { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => stderr.push(chunk));

      const outcome = await new Promise(resolve => {
        const timer = setTimeout(() => {
          resolve({ timedOut: true, signal: null, code: null });
        }, COORDINATOR_TIMEOUT_MS);
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ timedOut: false, code, signal });
        });
        child.on('error', error => {
          clearTimeout(timer);
          resolve({ timedOut: false, code: null, signal: null, error });
        });
      });

      if (outcome.timedOut) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.on('exit', resolve);
          setTimeout(resolve, 2000).unref?.();
        });
        assert.fail(
          `the coordinator did not finish within ${COORDINATOR_TIMEOUT_MS}ms; ` +
          `stdout=${JSON.stringify(stdout.join(''))} stderr=${JSON.stringify(stderr.join(''))}`
        );
      }

      // The hook must have killed it: SIGKILL, not a clean exit, not a timeout.
      assert.equal(
        outcome.signal,
        'SIGKILL',
        `the armed hook kills the coordinator during promotion ` +
        `(signal=${outcome.signal}, code=${outcome.code}, ` +
        `stdout=${JSON.stringify(stdout.join(''))} stderr=${JSON.stringify(stderr.join(''))})`
      );

      // The ref update itself survives the kill.
      assert.equal(
        gitOutput(repo, 'rev-parse', branch),
        candidate,
        'the package branch ref holds the candidate after the kill'
      );

      // The durable journal records the ref-updated phase.
      const recordPath = join(fixture.packagePath, 'runtime', 'waves', 'wave-001.json');
      assert.ok(
        existsSync(recordPath),
        'the durable wave record exists after the kill (the hook must not fire before the journal write)'
      );
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      assert.equal(record.target.promotion.state, 'ref-updated', 'the journal records the ref-updated phase');
      assert.equal(record.target.promotion.expected_old, expectedOld, 'the journal records the expected old value');
      assert.equal(record.target.promotion.candidate, candidate, 'the journal records the candidate');

      // The integration index and checkout are still at the expected old value.
      const candidateTree = gitOutput(checkout, 'rev-parse', `${candidate}^{tree}`);
      const expectedOldTree = gitOutput(checkout, 'rev-parse', `${expectedOld}^{tree}`);
      assert.equal(
        gitOutput(checkout, 'write-tree'),
        expectedOldTree,
        'the integration index still holds the expected old tree (read-tree never ran)'
      );
      const trackedCandidateOnly = gitOutput(checkout, 'ls-tree', '-r', '--name-only', expectedOld);
      assert.equal(
        trackedCandidateOnly.includes('candidate-only.txt'),
        false,
        'the expected old tree has no candidate-only file'
      );
      assert.equal(
        gitOutput(checkout, 'ls-files', '--', 'candidate-only.txt'),
        '',
        'the integration index carries no candidate-only file'
      );
      assert.equal(
        existsSync(join(checkout, 'candidate-only.txt')),
        false,
        'the integration checkout carries no candidate-only file'
      );
      // The branch ref moved to the candidate, so this checkout's HEAD (a
      // symbolic ref to the branch) now resolves to the candidate while the
      // index and worktree were never advanced past the expected old value.
      assert.equal(
        gitOutput(checkout, 'rev-parse', 'HEAD'),
        candidate,
        'the integration checkout HEAD resolves to the candidate after the ref update'
      );
      assert.equal(
        gitOutput(checkout, 'symbolic-ref', '-q', 'HEAD'),
        branch,
        'the integration checkout HEAD tracks the package branch'
      );
      // Authoritative worktree-vs-index check: with HEAD now at the candidate, a
      // clean `git status` is impossible, so compare the worktree against the
      // index directly (no tracked file differs, no candidate file). The index
      // itself was already asserted to hold the expected old tree above.
      // `diff-files --quiet` takes no revision positional argument.
      execFileSync('git', ['-C', checkout, 'diff-files', '--quiet'], {
        encoding: 'utf8'
      });
      assert.equal(
        gitOutput(checkout, 'ls-files', '--', 'candidate-only.txt'),
        '',
        'the integration worktree tracks no candidate-only file after the kill'
      );
      assert.notEqual(candidateTree, expectedOldTree, 'the candidate tree differs from the expected old tree');

      // Exactly one committed branch update reached the hook log.
      const hookLog = readFileSync(join(fixture.dir, 'hook.log'), 'utf8')
        .split('\n')
        .filter(Boolean);
      assert.equal(
        hookLog.length,
        1,
        `the reference hook records exactly one committed branch update: ${JSON.stringify(hookLog)}`
      );
      const [hookOld, hookNew, hookRef] = hookLog[0].split(' ');
      assert.equal(hookRef, branch, 'the hook line names the package branch');
      assert.equal(hookNew, candidate, 'the hook line records the candidate update');
      assert.equal(hookOld, expectedOld, 'the hook line records the expected old value');

      t.diagnostic(
        JSON.stringify({
          ev: 'card49',
          case: 'hook-kill-after-ref-update',
          kernel_proof: false,
          hook_log_entries: hookLog.length,
          candidate,
          expected_old: expectedOld
        })
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise(resolve => {
          child.on('exit', resolve);
          setTimeout(resolve, 2000).unref?.();
        });
      }
      await fixture.cleanup();
    }
  }
);

// Control: the same protocol without the kill marker completes normally. The
// stand-in never arms the hook, so the promotion reaches read-tree and leaves
// the checkout on the candidate tree.
test(
  'wave promotion: unarmed control completes the promotion protocol',
  { timeout: FIXTURE_TIMEOUT_MS },
  async t => {
    const fixture = await makeWaveFixture({
      members: 1,
      promotionKill: true,
      prefix: 'spec-wave-hook-'
    });
    let child = null;
    try {
      const targetId = fixture.options.targets[0];
      const repo = fixture.paths[targetId];
      const branch = normalizeBranchRef(fixture.locations.targets[0].branch);
      const checkout = fixture.integrationCheckout;
      const expectedOld = gitOutput(checkout, 'rev-parse', branch);
      const candidate = buildCandidateCommit(fixture, repo, expectedOld);

      // Same script with the arming write removed: kill-on-promote is never
      // created, so the hook's kill branch cannot fire. Split on the exact
      // arming lines rather than a regex, so the removal cannot silently miss.
      const ARMING_LINE = "writeFileSync(join(sandbox, 'kill-on-promote'), 'armed\\n');\n";
      assert.ok(
        COORDINATOR_SCRIPT.includes(ARMING_LINE),
        'the coordinator script arms the hook through the expected line'
      );
      const controlScript = COORDINATOR_SCRIPT.replace(ARMING_LINE, '');
      assert.notEqual(controlScript, COORDINATOR_SCRIPT, 'the control script omits the arming write');
      assert.equal(controlScript.includes('kill-on-promote'), false, 'the control script never arms the kill');

      child = spawn(
        process.execPath,
        ['-e', controlScript, '--',
          fixture.dir, repo, branch, candidate, expectedOld, checkout, fixture.packagePath],
        {
          env: fixture.promotionBin
            ? { ...process.env, PATH: `${fixture.promotionBin}:${process.env.PATH ?? ''}` }
            : { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => stderr.push(chunk));

      const outcome = await new Promise(resolve => {
        const timer = setTimeout(() => {
          resolve({ timedOut: true, signal: null, code: null });
        }, COORDINATOR_TIMEOUT_MS);
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ timedOut: false, code, signal });
        });
        child.on('error', error => {
          clearTimeout(timer);
          resolve({ timedOut: false, code: null, signal: null, error });
        });
      });

      if (outcome.timedOut) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.on('exit', resolve);
          setTimeout(resolve, 2000).unref?.();
        });
        assert.fail(
          `the control coordinator did not finish within ${COORDINATOR_TIMEOUT_MS}ms; ` +
          `stdout=${JSON.stringify(stdout.join(''))} stderr=${JSON.stringify(stderr.join(''))}`
        );
      }

      assert.equal(
        outcome.signal,
        null,
        `the unarmed control exits normally (signal=${outcome.signal})`
      );
      assert.equal(outcome.code, 0, `the unarmed control exits zero: ${JSON.stringify(stderr.join(''))}`);
      assert.match(stdout.join(''), /read-tree-done/, 'the unarmed control reaches read-tree');

      const candidateTree = gitOutput(checkout, 'rev-parse', `${candidate}^{tree}`);
      const expectedOldTree = gitOutput(checkout, 'rev-parse', `${expectedOld}^{tree}`);
      assert.notEqual(candidateTree, expectedOldTree, 'the control candidate tree differs from the old tree');
      assert.equal(
        gitOutput(repo, 'rev-parse', branch),
        candidate,
        'the control leaves the package branch on the candidate'
      );
      assert.equal(
        gitOutput(checkout, 'write-tree'),
        candidateTree,
        'the control index holds the candidate tree after read-tree'
      );
      assert.equal(
        existsSync(join(checkout, 'candidate-only.txt')),
        true,
        'the control checkout carries the candidate-only file after read-tree'
      );

      const hookLog = readFileSync(join(fixture.dir, 'hook.log'), 'utf8')
        .split('\n')
        .filter(Boolean);
      assert.equal(
        hookLog.length,
        1,
        `the control reference hook records exactly one committed branch update: ${JSON.stringify(hookLog)}`
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await new Promise(resolve => {
          child.on('exit', resolve);
          setTimeout(resolve, 2000).unref?.();
        });
      }
      await fixture.cleanup();
    }
  }
);

// `git update-ref` requires a full ref name, so normalize a short branch name
// to `refs/heads/<short>`; an already-full value is returned unchanged.
function normalizeBranchRef(branch) {
  if (branch.startsWith('refs/')) return branch;
  return `refs/heads/${branch}`;
}

function gitOutput(cwd, ...args) {
  // Bounded synchronous git read; no repository mutation.
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
