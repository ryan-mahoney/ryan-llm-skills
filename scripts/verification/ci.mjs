#!/usr/bin/env node
// Read CI evidence without running tests or changing Git state.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function assessChecks({ revision, clean, pr, checks, required, named = [] }) {
  if (!clean || pr.headRefOid !== revision) return { status: 'stale', reason: 'checkout_does_not_match_pr' };
  if (pr.state !== 'OPEN') return { status: 'unverified', reason: 'pr_not_open' };
  if (new Set(required.map(check => check.name)).size !== required.length) return { status: 'unverified', reason: 'required_check_names_ambiguous' };
  const selected = new Map(required.map(check => [check.name, check]));
  for (const name of named) {
    const matches = checks.filter(check => check.name === name);
    if (matches.length !== 1) return { status: 'unverified', reason: 'named_check_missing_or_ambiguous' };
    selected.set(name, matches[0]);
  }
  if (!selected.size) return { status: 'unverified', reason: 'no_required_checks_identified' };
  const values = [...selected.values()];
  if (values.some(check => ['fail', 'cancel'].includes(check.bucket))) return { status: 'failed', reason: 'check_failed', selected: values };
  if (values.some(check => check.bucket === 'pending')) return { status: 'pending', reason: 'checks_pending', selected: values };
  if (values.some(check => check.bucket !== 'pass')) return { status: 'unverified', reason: 'required_check_not_passed', selected: values };
  return { status: 'passed', reason: 'required_checks_passed', selected: values };
}

export function collectCi({ repo, pr: selector, named = [] }, run = execute) {
  const cwd = resolve(repo);
  const git = args => run('git', ['-C', cwd, ...args]);
  const revision = git(['rev-parse', 'HEAD']).trim();
  const clean = git(['status', '--porcelain', '--untracked-files=normal']).trim() === '';
  const prArgs = selector ? [selector] : [];
  const view = () => JSON.parse(run('gh', ['pr', 'view', ...prArgs, '--json', 'headRefOid,url,state'], cwd));
  const pr = view();
  const fields = 'name,bucket,state,link,workflow';
  const checks = JSON.parse(run('gh', ['pr', 'checks', ...prArgs, '--json', fields], cwd, [0, 1, 8]));
  let required;
  try {
    required = JSON.parse(run('gh', ['pr', 'checks', ...prArgs, '--required', '--json', fields], cwd, [0, 1, 8]));
  } catch (error) {
    // gh exits 1 with no JSON when the branch has no required checks. Named
    // project gates remain usable; authentication/network failures stay errors.
    if (!error.noRequiredChecks) throw error;
    required = [];
  }
  if (!Array.isArray(checks) || !Array.isArray(required)) throw new Error('invalid_check_response');
  const result = assessChecks({ revision, clean, pr, checks, required, named });
  const after = view();
  const unchanged = git(['rev-parse', 'HEAD']).trim() === revision
    && git(['status', '--porcelain', '--untracked-files=normal']).trim() === ''
    && after.headRefOid === pr.headRefOid;
  const status = unchanged ? result.status : 'stale';
  return {
    schema_version: 1, type: 'verification_evidence', kind: 'ci', status,
    revision, observed_at: new Date().toISOString(), repo: cwd,
    checkout_clean: clean && unchanged, head_verified: unchanged && pr.headRefOid === revision,
    reason: unchanged ? result.reason : 'checkout_or_pr_changed_during_read', artifact: pr.url,
    checks: (result.selected ?? []).map(check => ({ name: check.name, status: check.bucket, artifact: check.link })),
  };
}

function execute(command, args, cwd, accepted = [0]) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (result.error || !accepted.includes(result.status) || (result.status === 1 && /^no required checks reported\b/i.test(result.stderr.trim()))) {
    const error = new Error(result.error?.code === 'ETIMEDOUT' ? 'command_timeout' : 'command_unavailable');
    error.noRequiredChecks = result.status === 1 && /^no required checks reported\b/i.test(result.stderr.trim());
    throw error;
  }
  return result.stdout;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = { repo: process.cwd(), named: [] };
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--help') {
        console.log('Usage: node ci.mjs --repo PATH [--pr NUMBER_OR_URL] [--require CHECK_NAME ...]\nOnly actual required or explicitly named checks count. No tests are executed.');
        process.exit(0);
      }
      if (!['--repo', '--pr', '--require'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid_arguments');
      if (args[i] === '--require') options.named.push(args[++i]);
      else options[args[i++].slice(2)] = args[i];
    }
    const receipt = collectCi(options);
    console.log(JSON.stringify(receipt));
    process.exitCode = receipt.status === 'passed' ? 0 : receipt.status === 'pending' ? 8 : 1;
  } catch (error) {
    console.log(JSON.stringify({ schema_version: 1, type: 'verification_evidence', kind: 'ci', status: 'unavailable', reason: ['command_timeout', 'invalid_arguments', 'invalid_check_response'].includes(error.message) ? error.message : 'ci_evidence_unavailable', observed_at: new Date().toISOString() }));
    process.exitCode = 1;
  }
}
