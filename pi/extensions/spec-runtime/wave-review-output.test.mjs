// B3 regression: the seal phase consumes exactly the clean `git status`
// stdout written to the command log. A manager-like announcement on stderr is
// noise on a separate stream and must never be parsed as porcelain output, so
// a clean reviewed head still seals; a real tracked modification and a real
// failing git command must still block with their own reason.
//
// Every case runs the real `Runtime.runPhaseCommand` through the existing
// overlay transport (kernel_proof=false) against real Git. The test only
// rearranges the shell command the transport receives: it prepends a stderr
// announcement (clean / tracked) or substitutes a genuinely failing git
// invocation (error). Command replies are captured by delegating to the real
// `runPhaseCommand`, and no output is stripped or fabricated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSealRow, sealFixture } from './wave-review-fixture.mjs';

// A manager-style announcement a real launcher writes to stderr around a
// phase command. It is shaped like porcelain-ish noise on purpose: if the seal
// ever reads the combined log, this line would be misread as a dirtied path.
const ANNOUNCEMENT = 'announcing: service wave-fixture started for seal phase\n';

// Quote a literal for the shell with its real bytes: a single-quoted shell
// word keeps the newline intact, whereas JSON.stringify leaves a literal
// backslash-n that `printf %s` would print verbatim.
const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const announcementPrefix = `printf '%s' ${shellQuote(ANNOUNCEMENT)} >&2\n`;

// The caller's own status command, before any transport-level substitution.
const SEAL_STATUS_COMMAND = 'git status --porcelain=v1 -z --untracked-files=all';

const readTextOrNull = path => {
  if (typeof path !== 'string' || !path) return null;
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

// Capture the command-phase replies the seal actually received. The wrapper
// delegates to the original `runPhaseCommand` unchanged: no command swapping,
// no output rewriting, no synthetic value stands in for a real reply.
function captureSealCommandReplies(f) {
  const replies = [];
  const original = f.runtime.runPhaseCommand;
  f.runtime.runPhaseCommand = async (...args) => {
    const reply = await original.apply(f.runtime, args);
    replies.push({ command: args[1] ?? null, reply });
    return reply;
  };
  return replies;
}

// Wrap the overlay transport's start so the shell command it executes gains a
// prefix/suffix, or is replaced wholesale, while every other request field and
// stdio shape is forwarded verbatim. The contained launch argv may be a bwrap
// wrapper with the real bootstrap after `--`, so unwrap it exactly as the
// fixture transport does (`unwrapBootstrap`) and edit the bash command at that
// trailing offset, leaving the wrapper argv intact. Only called after
// `makeSealRow` finished, so worker launches the fixture still drives are
// untouched.
function rewritePhaseShellCommand(f, edit) {
  const adapter = f.runtime.serviceAdapter;
  const originalStart = adapter.start;
  adapter.start = async request => {
    const argv = request?.argv;
    if (!Array.isArray(argv)) return originalStart.call(adapter, request);
    const marker = argv.indexOf('--');
    const offset = marker >= 0 ? marker + 1 : 0;
    // A command phase is `/bin/bash -o pipefail -c <command>`; a worker
    // bootstrap is `node -e <bootstrap> <requestfile>` and passes through.
    const isCommand = argv.length >= offset + 5
      && argv[offset] === '/bin/bash' && argv[offset + 3] === '-c';
    if (!isCommand) return originalStart.call(adapter, request);
    const rewritten = argv.slice();
    rewritten[offset + 4] = edit(argv[offset + 4]);
    return originalStart.call(adapter, { ...request, argv: rewritten });
  };
  return () => { adapter.start = originalStart; };
}

// Row 1: a clean reviewed head seals. The manager announcement lands on
// stderr; the protocol `full_output_path` must hold exactly the clean git
// stdout (empty), while the separate `stderr_output_path` retains the
// announcement as its own stream.
test('wave seal output: clean head with a manager stderr announcement seals on empty stdout', async t => {
  const { f } = await makeSealRow(t, 'positive');
  // The reviewed fixture is clean before the seal runs.
  assert.equal(f.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']), '',
    'the reviewed fixture starts clean');

  const replies = captureSealCommandReplies(f);
  const restore = rewritePhaseShellCommand(f, command => `${announcementPrefix}${command}`);
  t.after(() => restore());

  const receipt = await sealFixture(f);

  // Assert the seal outcome first: if the announcement is misread as
  // porcelain noise the baseline fails here as dirty-tracked instead of
  // sealing, which is the defect this case pins.
  assert.equal(receipt.state, 'sealed',
    `a clean head with stderr noise seals (${JSON.stringify(receipt.reasons)})`);
  assert.deepStrictEqual(receipt.reasons, [], 'a clean head reports no seal reasons');

  // The protocol log keeps exactly the clean git stdout: empty.
  const statusReply = replies.at(-1);
  assert.ok(statusReply, 'the seal ran its status command');
  assert.equal(typeof statusReply.reply.full_output_path, 'string',
    'the command reply carries a protocol full_output_path');
  const stdoutBytes = readTextOrNull(statusReply.reply.full_output_path);
  assert.equal(stdoutBytes, '', 'full_output_path holds exactly the clean git stdout (empty)');
  assert.equal(stdoutBytes.includes('announcing:'), false,
    'the stderr announcement never reaches the protocol stdout log');

  // The announcement is retained on its own separate stderr stream.
  const stderrPath = statusReply.reply.stderr_output_path;
  assert.equal(typeof stderrPath, 'string',
    'the command reply carries a separate stderr_output_path');
  const stderrBytes = readTextOrNull(stderrPath);
  assert.equal(typeof stderrBytes, 'string', `stderr_output_path is readable: ${stderrPath}`);
  assert.equal(stderrBytes, ANNOUNCEMENT,
    'stderr_output_path retains exactly the manager announcement');
});

// Row 2: a real tracked modification still blocks. The identical stderr
// announcement must not mask genuine porcelain dirt.
test('wave seal output: a real tracked modification still blocks as dirty-tracked', async t => {
  const { f } = await makeSealRow(t, 'tracked');
  const headBefore = f.head;
  // The row's own real write is what dirties the view.
  assert.notEqual(f.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']), '',
    'the tracked row leaves real porcelain dirt');

  const replies = captureSealCommandReplies(f);
  const restore = rewritePhaseShellCommand(f, command => `${announcementPrefix}${command}`);
  t.after(() => restore());

  const receipt = await sealFixture(f);

  assert.equal(receipt.state, 'blocked', 'a real tracked modification blocks the seal');
  assert.ok(receipt.reasons.some(reason => reason.code === 'dirty-tracked'),
    `dirty-tracked is reported: ${JSON.stringify(receipt.reasons.map(reason => reason.code))}`);
  assert.equal(f.head, headBefore, 'a blocked seal leaves the private head unchanged');

  // The blocking status output is the real porcelain text, not the announcement.
  const statusReply = replies.at(-1);
  assert.ok(statusReply, 'the seal ran its status command');
  assert.equal(statusReply.reply.exit_code, 0, 'the real git status command exited zero');
  const stdoutBytes = readTextOrNull(statusReply.reply.full_output_path);
  assert.equal(typeof stdoutBytes, 'string', 'the protocol stdout log is readable');
  assert.ok(stdoutBytes.includes('src/a.mjs'),
    `the real porcelain output names the tracked path: ${JSON.stringify(stdoutBytes)}`);
  assert.equal(stdoutBytes.includes('announcing:'), false,
    'the announcement never reaches the protocol stdout log');
});

// Row 3: an actual git failure still blocks. The substituted command is a real
// git invocation against a nonexistent directory, so its nonzero status and
// stderr are genuine; the test asserts they were retained, never invented.
test('wave seal output: an actual git failure blocks with its real nonzero stderr', async t => {
  const { f } = await makeSealRow(t, 'positive');
  const failing = 'git -C nonexistent-seal-dir status --porcelain=v1 -z --untracked-files=all';

  const replies = captureSealCommandReplies(f);
  const restore = rewritePhaseShellCommand(f, () => failing);
  t.after(() => restore());

  const receipt = await sealFixture(f);

  assert.equal(receipt.state, 'blocked', 'a failing status command blocks the seal');
  assert.ok(receipt.reasons.some(reason => reason.code === 'dirty-tracked'),
    `an unreadable status output blocks as dirty-tracked: ${JSON.stringify(receipt.reasons.map(reason => reason.code))}`);

  const statusReply = replies.at(-1);
  assert.ok(statusReply, 'the seal ran its status command');
  // The caller still issued its original status command; only the transport's
  // shell command was substituted, so no reply value may be invented here.
  assert.equal(statusReply.command, SEAL_STATUS_COMMAND,
    'the captured command is the caller\'s original git status');
  // The reply reflects the real process: a nonzero exit, no invented status.
  assert.notEqual(statusReply.reply.exit_code, 0,
    `the real git failure exits nonzero: ${JSON.stringify(statusReply.reply.exit_code)}`);
  assert.equal(statusReply.reply.exit_code === 0, false, 'the failure is not reported as success');
  assert.equal(statusReply.reply.signal, null, 'the failure is an exit, not a signal');

  // The real git stderr is retained on the log, not fabricated by the test.
  const stderrPath = statusReply.reply.stderr_output_path;
  const stderrBytes = readTextOrNull(stderrPath) ?? '';
  assert.equal(stderrBytes.includes('announcing:'), false,
    'no test-written announcement appears in the real git stderr');
  // Whether stderr is surfaced on its own path or the combined log, the real
  // git diagnostic must be present somewhere the runtime recorded: that text
  // proves the substituted command actually ran against a missing directory.
  const combined = readTextOrNull(statusReply.reply.full_output_path) ?? '';
  assert.match(`${combined}${stderrBytes}`, /nonexistent-seal-dir/,
    'the failing command retained its own real git diagnostic output');
});
