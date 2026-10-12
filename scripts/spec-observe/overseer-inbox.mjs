// Safe operator hold/direction publication into a storage package mailbox.
//
// The public write surface is exactly one exclusive original file. This module
// never edits, archives, deletes or rewrites an existing original and never
// touches the coordinator checkpoint or any outcome. Verification reads only
// the exported guard projection and its relative source paths.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { locatePackage } from '../spec-location/index.mjs';
import { INBOX_FILE_BYTES, readCheckpointRecord, readInboxGuard } from '../../pi/extensions/spec-runtime/sentinel.mjs';
import { createFileExclusive } from '../workspaces/store.mjs';

const RUN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const KINDS = new Set(['hold', 'direction']);
const STAGES = new Set(['implementation', 'review']);
const COMPLETE_STATES = new Set(['complete', 'completed']);
const MAILBOXES = ['inbox', 'processed'];
const MAX_ATTEMPTS = 8;
// NUL and unsafe controls are refused; tab, newline and carriage return stay allowed.
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

let lastStamp = 0;

function fail(message) {
  throw new Error(message);
}

// Compact UTC timestamp with milliseconds, monotonic within this process so
// sequential direction ids still order after the holds they answer.
function stamp() {
  let value = Date.now();
  if (value <= lastStamp) value = lastStamp + 1;
  lastStamp = value;
  const date = new Date(value);
  const pad = (input, width) => String(input).padStart(width, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`
    + `T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}`
    + `${pad(date.getUTCMilliseconds(), 3)}Z`;
}

function physicalDirectory(info, path, label) {
  if (info.isSymbolicLink()) fail(`${label} must not be a symlink: ${path}`);
  if (!info.isDirectory()) fail(`${label} is not a directory: ${path}`);
}

// Five unquoted safe frontmatter keys plus the body; every value is validated
// as an ASCII token, so no quoting or escaping is needed.
function serialize(id, { run, sender, audience, kind }, body) {
  return `---\nid: ${id}\nrun: ${run}\nsender: ${sender}\naudience: ${audience}\nkind: ${kind}\n---\n\n${body}\n`;
}

// Verify one already-published identity through the exported guard projection.
// Guard sources use relative mailbox paths (`inbox/<id>.md`). Any throw or
// missing/inexact field is unconfirmed, never a retry signal.
function verifyPublished(packagePath, identity) {
  try {
    const guard = readInboxGuard(packagePath);
    const source = (guard.sources ?? []).find(entry => entry?.id === identity.id);
    if (!source || source.state !== 'observed') return null;
    const directory = source.directory ?? (typeof source.path === 'string'
      ? MAILBOXES.find(name => source.path === `${name}/${identity.id}.md`) : null);
    if (!MAILBOXES.includes(directory)) return null;
    if (source.path !== `${directory}/${identity.id}.md`) return null;
    if (source.sha256 !== identity.sha256 || source.kind !== identity.kind
      || source.run !== identity.run || source.sender !== identity.sender
      || source.audience !== identity.audience) return null;
    return { directory, path: join(packagePath, source.path) };
  } catch {
    return null;
  }
}

/**
 * Publish one operator hold/direction original into the package inbox.
 * @param {string} packagePath absolute physical canonical package directory
 * @param {{run: string, sender: 'operator', audience: 'coordinator',
 *   kind: 'hold'|'direction', body: string}} input
 * @returns {Promise<{id: string, path: string, sha256: string,
 *   status: 'delivered'|'unconfirmed'}>}
 */
export async function deliverOverseerMessage(packagePath, input = {}) {
  if (typeof packagePath !== 'string' || packagePath === '' || !isAbsolute(packagePath)) {
    fail('packagePath must be an absolute path');
  }
  const { run, sender, audience, kind, body } = input ?? {};
  if (typeof run !== 'string' || !RUN_PATTERN.test(run)) {
    fail('run must be an ASCII identifier of 1..128 characters');
  }
  if (sender !== 'operator') fail('sender must be operator');
  if (audience !== 'coordinator') fail('audience must be coordinator');
  if (!KINDS.has(kind)) fail('kind must be hold or direction');
  if (typeof body !== 'string' || body.trim() === '') fail('body must be a nonempty string');
  if (UNSAFE_CONTROL.test(body)) fail('body must not contain NUL or unsafe control characters');
  if (Buffer.from(body, 'utf8').toString('utf8') !== body) fail('body must roundtrip as valid UTF-8');
  if (Buffer.byteLength(body, 'utf8') > INBOX_FILE_BYTES) fail(`body exceeds ${INBOX_FILE_BYTES} bytes`);

  // Physical storage package directory only: a symlinked or aliased
  // declaration never publishes.
  const located = await locatePackage(packagePath);
  const physical = await fs.realpath(packagePath).catch(() => null);
  if (!located.ok || physical === null || physical !== located.packageDir || resolve(packagePath) !== located.packageDir) {
    fail('package must be the physical canonical package directory');
  }

  const inboxPath = join(located.packageDir, 'inbox');
  const processedPath = join(located.packageDir, 'processed');
  const [inboxInfo, processedInfo] = await Promise.all([
    fs.lstat(inboxPath).catch(() => null),
    fs.lstat(processedPath).catch(() => null),
  ]);
  if (inboxInfo === null || processedInfo === null) fail('inbox and processed must already exist');
  physicalDirectory(inboxInfo, inboxPath, 'inbox');
  physicalDirectory(processedInfo, processedPath, 'processed');
  if ((await fs.realpath(inboxPath)) !== inboxPath) fail('inbox must be the physical directory');
  if ((await fs.realpath(processedPath)) !== processedPath) fail('processed must be the physical directory');

  // Real retained checkpoint for this exact package and run. A retained
  // user-held checkpoint remains deliverable; complete work never is.
  const checkpoint = readCheckpointRecord(located.packageDir, run);
  if (checkpoint === null || checkpoint.package !== located.packageDir || checkpoint.workflow_id !== run) {
    fail('no retained checkpoint for this package and run');
  }
  const stage = checkpoint.obligation?.stage;
  if (!STAGES.has(stage)) fail('checkpoint stage must be implementation or review');
  if (COMPLETE_STATES.has(checkpoint.state)) fail('checkpoint is complete');

  // Allocate identity before every exclusive attempt so no error loses it.
  let id = null;
  let path = null;
  let sha256 = null;
  let preflightCollisions = 0;
  let attempted = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = `${stamp()}-${randomUUID()}`;
    const text = serialize(candidate, { run, sender, audience, kind }, body);
    if (Buffer.byteLength(text, 'utf8') > INBOX_FILE_BYTES) fail(`original exceeds ${INBOX_FILE_BYTES} bytes`);
    const candidatePath = join(inboxPath, `${candidate}.md`);
    id = candidate;
    path = candidatePath;
    sha256 = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

    // Prepublication collision check across both mailboxes via the mutable
    // default fs so tests can substitute only this final preflight boundary.
    // Only ENOENT proves absence; any other lstat failure is uncertain and
    // must not masquerade as one.
    let collision = false;
    let uncertain = false;
    for (const mailbox of MAILBOXES) {
      try {
        await fs.lstat(join(located.packageDir, mailbox, `${candidate}.md`));
        collision = true;
        break;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') { uncertain = true; break; }
      }
    }
    if (uncertain) break;
    if (collision) {
      preflightCollisions += 1;
      continue;
    }

    // Any exception from the exclusive primitive, including EEXIST, may be a
    // postpublication cleanup error and cannot prove no publication: break to
    // one guard verification and never resend this identity.
    attempted = true;
    try {
      await createFileExclusive(candidatePath, text);
    } catch {
      break;
    }
    break;
  }
  if (id === null) fail('could not allocate a unique original id');
  // Eight proven preflight collisions with no primitive attempt mean no unique
  // id can be allocated; never return someone else's colliding id.
  if (!attempted && preflightCollisions === MAX_ATTEMPTS) {
    fail('could not allocate a unique original id: all attempts were proven collisions');
  }

  // Exactly one verification for the retained identity; no retry or rewrite.
  const verified = verifyPublished(located.packageDir, { id, sha256, run, sender, audience, kind });
  if (verified) return { id, path: verified.path, sha256, status: 'delivered' };
  return { id, path, sha256, status: 'unconfirmed' };
}
