// Explicit metadata reconciliation, separate from the read-only observer.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const MERGE_POLL_MS = 10 * 60 * 1000;
export async function boundedJson(path, root) {
  try {
    if (await realpath(path) !== path || !path.startsWith(root + '/')) return null;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const info = await file.stat(); if (!info.isFile() || info.size > 65536) return null;
      const buffer = Buffer.alloc(65537), { bytesRead } = await file.read(buffer,0,buffer.length,0);
      return bytesRead <= 65536 ? JSON.parse(buffer.subarray(0,bytesRead)) : null;
    } finally { await file.close(); }
  } catch { return null; }
}
export function mergeBinding(input) {
  return hash([input.package, input.pr.url, input.pr.branch, input.pr.base, input.commits, input.receipts, input.checkpoints]);
}
export function applicableMerge(record, input) {
  return record?.schema_version === 1 && record.package === input.package
    && (record.binding === mergeBinding(input) || record.url === input.pr.url
      && typeof record.branch === 'string' && typeof record.base === 'string'
      && (input.pr.branch == null || input.pr.branch === record.branch)
      && (input.pr.base == null || input.pr.base === record.base))
    && record.state === 'merged' && /^[a-f0-9]{40,64}$/.test(record.head ?? '') && /^[a-f0-9]{40,64}$/.test(record.merge_commit ?? '')
    && Number.isFinite(Date.parse(record.merged_at)) && (input.checkpoints??[]).every(c=>c[0]==='complete'||Number.isFinite(Date.parse(c[1]))&&Date.parse(c[1])<=Date.parse(record.merged_at)) && input.receipts.every(r => Number.isFinite(Date.parse(r[2])) && Date.parse(r[2]) <= Date.parse(record.merged_at));
}
export const MERGE_RETRY_MS = 60 * 1000;
export const MERGE_NETWORK_BUDGET_MS = 6000;
const validRef = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) && !value.includes('..');
async function boundedText(path, root) {
  let file;
  try {
    const real = await realpath(path);
    if (real !== path || !real.startsWith(root + '/')) return { state: 'unknown' };
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) return { state: 'unknown' };
    const buffer = Buffer.alloc(65537), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead <= 65536 ? { state: 'read', text: buffer.subarray(0, bytesRead).toString('utf8') } : { state: 'unknown' };
  } catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'unknown' }; }
  finally { await file?.close(); }
}
// Local validation does not spend the network budget or spawn Git processes.
async function readGitRef(primary, ref) {
  if (!ref.startsWith('refs/') || !validRef(ref)) return { state: 'unknown' };
  const root = join(primary, '.git');
  const loose = await boundedText(join(root, ref), root);
  if (loose.state === 'read') return /^[a-f0-9]{40,64}\s*$/.test(loose.text)
    ? { state: 'present', head: loose.text.trim() } : { state: 'unknown' };
  if (loose.state !== 'missing') return loose;
  const packed = await boundedText(join(root, 'packed-refs'), root);
  if (packed.state === 'missing') return packed;
  if (packed.state !== 'read') return { state: 'unknown' };
  const entry = packed.text.split('\n').find(line => line.endsWith(' ' + ref));
  if (!entry) return { state: 'missing' };
  const head = entry.split(' ')[0];
  return /^[a-f0-9]{40,64}$/.test(head) ? { state: 'present', head } : { state: 'unknown' };
}
export async function readMergeBranch(primary, branch) {
  return validRef(branch) ? readGitRef(primary, 'refs/heads/' + branch) : { state: 'unknown' };
}
// Shared by active reconciliation and cold observational reads.
export async function validateMergeCache(record, input, readBranch = readMergeBranch) {
  if (!applicableMerge(record, input)) return false;
  const branch = input.pr.branch ?? record.branch;
  if (!validRef(branch)) return false;
  const local = await readBranch(input.primary, branch);
  if (local.state === 'unknown' || local.state === 'present' && local.head !== record.head) return false;
  if (record.evidence_source !== 'local-git') return true;
  if (!validRef(record.base) || input.pr.base != null && input.pr.base !== record.base) return false;
  const tracked = await readGitRef(input.primary, 'refs/remotes/origin/' + record.base);
  return tracked.state === 'present' && tracked.head === record.base_tip;
}
export const MERGE_LOCAL_BUDGET_MS = 2000;
const defaultCommand = async (program, args, cwd, timeout) => (await exec(program, args, { cwd, timeout, maxBuffer: 65536,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } })).stdout;
// Classify only; never retain stderr, which can contain credentials or repository data.
function apiFailure(error) {
  if (error.code === 'ENOENT') return 'api-client-unavailable';
  const text = `${error.code ?? ''} ${error.message ?? ''} ${error.stderr ?? ''}`;
  if (error.killed || /ETIMEDOUT|timed?\s*out/i.test(text)) return 'api-timeout';
  if (/rate.limit|HTTP\s*429/i.test(text)) return 'api-rate-limited';
  if (/authenticate|authentication|not.logged|gh.auth|HTTP\s*401|bad.credentials/i.test(text)) return 'api-authentication-unavailable';
  if (/connecting|connection|ENET|ECONN|EAI_AGAIN|ENOTFOUND|TLS|SSL/i.test(text)) return 'api-network-unavailable';
  return 'api-request-failed';
}
async function localMergeEvidence(input, prior, { run, readBranch, now }) {
  const fail = reason => ({ state: 'unknown', reason });
  try {
    if (await realpath(input.primary) !== input.primary || dirname(input.package) !== join(input.primary, '.specs')
      || await realpath(join(input.primary, '.git')) !== join(input.primary, '.git')
      || !(await lstat(join(input.primary, '.git'))).isDirectory()) return fail('local-repository-unavailable');
    const pr = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(input.pr.url);
    if (!pr) return fail('local-pr-association-unavailable');
    const origin = (await run(input.primary, ['config', '--get', 'remote.origin.url'])).trim();
    const remote = /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+)$/i.exec(origin);
    if (!remote || remote[1].toLowerCase() !== pr[1].toLowerCase()
      || remote[2].replace(/\.git$/i, '').toLowerCase() !== pr[2].toLowerCase()) return fail('local-repository-mismatch');
    let base = input.pr.base ?? (prior?.url === input.pr.url ? prior.base : null);
    if (base == null) {
      const symbolic = await boundedText(join(input.primary, '.git', 'refs', 'remotes', 'origin', 'HEAD'), join(input.primary, '.git'));
      base = symbolic.state === 'read' ? /^ref: refs\/remotes\/origin\/([^\s]+)\s*$/.exec(symbolic.text)?.[1] : null;
    }
    if (!validRef(base)) return fail('local-base-unavailable');
    const tracked = await readGitRef(input.primary, 'refs/remotes/origin/' + base);
    if (tracked.state !== 'present') return fail('local-tracked-base-unavailable');
    const log = await run(input.primary, ['log', '--first-parent', '--max-count=100', '--format=%H%x00%P%x00%cI%x00%s', tracked.head]);
    const matches = [];
    for (const line of log.trim().split('\n')) {
      const fields = line.split('\0');
      if (fields.length !== 4) return fail('local-merge-log-invalid');
      const [commit, parents, time, subject] = fields;
      const title = /^Merge pull request #([1-9][0-9]*) from ([A-Za-z0-9_.-]+)\/(.+)$/.exec(subject);
      if (!title || title[1] !== pr[3]) continue;
      const branch = title[3], graph = parents.split(' ');
      if (!validRef(branch) || input.pr.branch != null && input.pr.branch !== branch) continue;
      if (graph.length !== 2 || ![commit, ...graph].every(value => /^[a-f0-9]{40,64}$/.test(value))) continue;
      matches.push({ branch, commit, head: graph[1], time });
    }
    if (matches.length !== 1) return fail(matches.length ? 'local-pr-merge-ambiguous' : 'local-pr-merge-not-found');
    const match = matches[0], branch = await readBranch(input.primary, match.branch);
    if (branch.state !== 'present' || branch.head !== match.head) return fail('local-head-mismatch');
    if (!Number.isFinite(Date.parse(match.time)) || Date.parse(match.time) > now()) return fail('local-merge-time-unavailable');
    const currentBase = await readGitRef(input.primary, 'refs/remotes/origin/' + base);
    if (currentBase.head !== tracked.head) return fail('local-tracked-base-changed');
    const record = { schema_version: 1, package: input.package, binding: mergeBinding(input), url: input.pr.url,
      branch: match.branch, base, tip: match.head, head: match.head, base_tip: tracked.head,
      checked_at: new Date(now()).toISOString(), state: 'merged', reason: 'local-pr-merge',
      merge_commit: match.commit, merged_at: match.time, evidence_source: 'local-git' };
    return applicableMerge(record, input) ? record : fail('newer-dispatch-or-checkpoint');
  } catch (error) { return fail(error.code === 'LOCAL_BUDGET' ? 'local-merge-budget' : 'local-merge-unavailable'); }
}
const memory = new Map();
export function createMergeReconciler({ persist = false, now = Date.now, monotonic = () => performance.now(),
  readBranch = readMergeBranch,
  command = defaultCommand } = {}) {
  let checks = 0, spent = 0, localChecks = 0, localSpent = 0;
  const runLocal = async (cwd, args) => {
    const remaining = Math.min(MERGE_LOCAL_BUDGET_MS - localSpent, MERGE_NETWORK_BUDGET_MS + MERGE_LOCAL_BUDGET_MS - spent - localSpent);
    if (remaining < 1) throw Object.assign(new Error('Local budget'), { code: 'LOCAL_BUDGET' });
    const started = now(), startMono = monotonic();
    try { return await command('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], cwd, Math.max(1, Math.floor(Math.min(750, remaining)))); }
    finally { localSpent += Math.max(0, now() - started, monotonic() - startMono); }
  };
  const finish = async (input, record) => {
    if (memory.size >= 500 && !memory.has(input.package)) memory.delete(memory.keys().next().value);
    memory.set(input.package, record);
    return persist ? persistRecord(input, record) : record;
  };
  return async input => {
    const path = join(input.package, 'sentinel-merge.json'), binding = mergeBinding(input);
    const prior = memory.get(input.package) ?? await boundedJson(path, input.package);
    let branch = input.pr.branch ?? (prior?.url === input.pr.url ? prior.branch : null);
    let local = branch ? await readBranch(input.primary, branch) : null;
    if (local?.state === 'unknown') return { state: 'unknown', reason: 'branch-tip-unavailable' };
    if (await validateMergeCache(prior, input, readBranch)) return persist ? persistRecord(input, prior) : prior;
    const tip = local?.head ?? null;
    const retry = prior?.state === 'unmerged' ? MERGE_POLL_MS : MERGE_RETRY_MS;
    const cached = prior?.binding === binding && prior.tip === tip && now() - Date.parse(prior.checked_at) >= 0
      && now() - Date.parse(prior.checked_at) < retry;
    // Recorded local misses also cool down, allowing later packages a turn.
    if (cached && (prior.state === 'unmerged' || prior.state === 'unknown' && prior.local_reason && prior.local_reason !== 'local-merge-budget')) return prior;
    let localReason = 'local-merge-budget';
    if (localChecks < 3 && localSpent < MERGE_LOCAL_BUDGET_MS) {
      localChecks++;
      const evidence = await localMergeEvidence(input, prior, { run: runLocal, readBranch, now });
      localReason = evidence.reason;
      if (evidence.state === 'merged') {
        const authoritativeOpen = prior?.url === input.pr.url
          ? prior.authoritative_unmerged_at ?? (prior.state === 'unmerged' ? prior.checked_at : null) : null;
        if (!authoritativeOpen || Date.parse(authoritativeOpen) < Date.parse(evidence.merged_at)) return finish(input, evidence);
        // An expired contradictory remote response must be refreshed, not frozen.
      }
    }
    if (checks >= 3 || spent >= MERGE_NETWORK_BUDGET_MS || spent + localSpent >= MERGE_NETWORK_BUDGET_MS + MERGE_LOCAL_BUDGET_MS) return { state: 'unknown', reason: 'merge-check-budget' };
    checks++;
    let record = { schema_version: 1, package: input.package, binding, url: input.pr.url, branch, base: input.pr.base ?? prior?.base ?? null,
      authoritative_unmerged_at: prior?.url === input.pr.url ? prior.authoritative_unmerged_at ?? (prior.state === 'unmerged' ? prior.checked_at : null) : null,
      tip, checked_at: new Date(now()).toISOString(), state: 'unknown', reason: 'merge-check-unavailable', local_reason: localReason };
    const started = now(), startedMono = monotonic();
    try {
      const output = await command('gh', ['pr', 'view', input.pr.url, '--json',
        'url,state,mergedAt,mergeCommit,headRefOid,headRefName,baseRefName'], input.primary,
        Math.max(1, Math.floor(Math.min(3500, MERGE_NETWORK_BUDGET_MS - spent, MERGE_NETWORK_BUDGET_MS + MERGE_LOCAL_BUDGET_MS - spent - localSpent))));
      let pr; try { pr = JSON.parse(output); } catch { throw Object.assign(new Error('Invalid PR response'), { code: 'PR_RESPONSE' }); }
      if (pr.url !== input.pr.url || !validRef(pr.headRefName) || !validRef(pr.baseRefName)
        || input.pr.branch && pr.headRefName !== input.pr.branch || input.pr.base && pr.baseRefName !== input.pr.base)
        throw Object.assign(new Error('PR identity differs'), { code: 'PR_IDENTITY' });
      branch = pr.headRefName;
      // Read again after the remote response to reject a branch advanced meanwhile.
      local = await readBranch(input.primary, branch);
      record = { ...record, branch, base: pr.baseRefName, tip: local.head ?? null,
        state: pr.state === 'MERGED' ? 'unknown' : 'unmerged', reason: pr.state === 'MERGED' ? 'head-mismatch' : 'pr-not-merged' };
      if (pr.state !== 'MERGED') record.authoritative_unmerged_at = record.checked_at;
      if (local.state === 'unknown') record.reason = 'branch-tip-unavailable';
      else if (pr.state === 'MERGED' && (local.state === 'missing' || local.head === pr.headRefOid)
        && /^[a-f0-9]{40,64}$/.test(pr.headRefOid ?? '') && Number.isFinite(Date.parse(pr.mergedAt))
        && /^[a-f0-9]{40,64}$/.test(pr.mergeCommit?.oid ?? '')) {
        record = { ...record, state: 'merged', reason: 'authoritative-pr', head: pr.headRefOid,
          local_branch_absent: local.state === 'missing', authoritative_unmerged_at: null, merge_commit: pr.mergeCommit.oid, merged_at: pr.mergedAt };
        if (!applicableMerge(record, input)) record = { ...record, state: 'unknown', reason: 'newer-dispatch-or-checkpoint' };
      }
    } catch (error) { record.reason = error.code === 'PR_IDENTITY' ? 'api-pr-identity-mismatch' : error.code === 'PR_RESPONSE' ? 'api-response-invalid' : apiFailure(error); }
    finally { spent += Math.max(0, now() - started, monotonic() - startedMono); }
    return finish(input, record);
  };
}
async function persistRecord(input,record){
  const path=join(input.package,'sentinel-merge.json');
  const existing=await boundedJson(path,input.package);
  if(existing&&JSON.stringify(existing)===JSON.stringify(record))return record;
  // Canonical package was validated by the collector; reject a replacement before writing.
  if (await realpath(input.package) !== input.package) return {state:'unknown',reason:'package-changed'};
  try { const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())return {state:'unknown',reason:'metadata-path-invalid'}; } catch(error){if(error.code!=='ENOENT')return {state:'unknown',reason:'metadata-path-unavailable'};}
  const temporary=join(input.package,`.sentinel-merge-${randomUUID()}.tmp`);
  try { const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(record,null,2)+'\n');}finally{await handle.close();}await rename(temporary,path); }
  finally { await unlink(temporary).catch(()=>{}); }
  return record;
}
