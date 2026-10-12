#!/usr/bin/env node
// spec-location CLI: prints the result object as JSON on stdout.
// Exit 0 ok, 2 refusal ({ ok: false, code, message, remedy }), 1 error.

import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  checkPackage, listEpics, listPackages, locatePackage, materialize, migrate, newPackage, recordWorktree, resolveWorkspace, stamp, updateScope,
} from './index.mjs';

const USAGE = `Usage: node scripts/spec-location/cli.mjs <command> [options]

  resolve [--cwd D] [--workspace W] [--authoring]
  new --workspace W --slug S --target ID[:BRANCH]... [--design REF]... [--plan NAME] [--epic SLUG] [--authoring]
  locate REF
  check REF [--authoring]
  materialize REF
  stamp REF
  scope REF [--add-target ID[:BRANCH]] [--add-design REF] [--plan NAME|--no-plan] [--epic SLUG|--no-epic] [--authoring]
  worktree REF TARGET_ID PATH
  packages --workspace W
  epics --workspace W
  migrate --workspace W [--apply] [--include-transcripts]

REF is <workspace>/<slug>, a package directory, or a file inside one.
--authoring permits planning stages on a machine other than the execution host, until a worktree is recorded.
worktree records PATH (the root of an existing git worktree of the target's repository) in locations.json and refreshes the stamps.
Global: --root PATH (storage root; otherwise ADJACENT_STORAGE_ROOT, saved root, default). Output is always JSON.`;

const OPTIONS = {
  root: { type: 'string' }, json: { type: 'boolean' }, cwd: { type: 'string' }, workspace: { type: 'string' },
  slug: { type: 'string' }, target: { type: 'string', multiple: true }, design: { type: 'string', multiple: true },
  plan: { type: 'string' }, 'no-plan': { type: 'boolean' }, epic: { type: 'string' }, 'no-epic': { type: 'boolean' },
  'add-target': { type: 'string' }, 'add-design': { type: 'string' }, apply: { type: 'boolean' },
  'include-transcripts': { type: 'boolean' }, authoring: { type: 'boolean' },
};

const target = spec => ({ id: spec.split(':')[0], branch: spec.split(':')[1] });

async function execute(command, positionals, v) {
  const options = { root: v.root };
  const authoring = v.authoring === true;
  const ref = positionals[0];
  switch (command) {
    case 'resolve': return resolveWorkspace({ ...options, authoring, cwd: v.cwd ?? (v.workspace ? undefined : process.cwd()), workspace: v.workspace });
    case 'new':
      return newPackage({
        ...options, authoring, workspace: v.workspace, slug: v.slug, targets: (v.target ?? []).map(target),
        designs: v.design ?? [], plan: v.plan ?? null, epic: v.epic ?? null,
      });
    case 'locate': return locatePackage(ref, options);
    case 'check': return checkPackage(ref, { ...options, authoring });
    case 'materialize': return materialize(ref, options);
    case 'stamp': return stamp(ref, options);
    case 'scope': {
      const change = {};
      if (v['add-target']) change.addTarget = target(v['add-target']);
      if (v['add-design']) change.addDesign = v['add-design'];
      if (v['no-plan']) change.setPlan = null; else if (v.plan !== undefined) change.setPlan = v.plan;
      if (v['no-epic']) change.setEpic = null; else if (v.epic !== undefined) change.setEpic = v.epic;
      return updateScope(ref, change, { ...options, authoring });
    }
    case 'worktree': return recordWorktree(ref, positionals[1], positionals[2], { ...options, cwd: v.cwd });
    case 'packages': return listPackages(v.workspace, options);
    case 'epics': return listEpics(v.workspace, options);
    case 'migrate': return migrate({ ...options, workspace: v.workspace, apply: v.apply === true, includeTranscripts: v['include-transcripts'] === true });
    default: throw new Error(`unknown command ${JSON.stringify(command)}\n${USAGE}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
  const [command, ...rest] = positionals;
  const needsRef = ['locate', 'check', 'materialize', 'stamp', 'scope'];
  if (!command || (needsRef.includes(command) && rest.length !== 1) || (command === 'worktree' && rest.length !== 3)) throw new Error(USAGE);
  const result = await execute(command, rest, values);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok === false ? 2 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
