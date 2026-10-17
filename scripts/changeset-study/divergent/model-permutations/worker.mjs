import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Client, ModelJsonParseError, sdkImport } from '../../client.mjs';
import { Workspace, hash } from '../../../changeset/workspace.mjs';
import { execute } from '../../../changeset/engine.mjs';
import { patchEditor } from '../../strategies.mjs';
import { buildQueryCatalog } from '../../query-catalog.mjs';
import { resolveSourceRequests } from '../../query-source.mjs';
import { changedTestCommands } from '../../candidate-checks.mjs';
import { sandbox, grade } from '../../sandbox.mjs';
import { parse } from '../../parser/acorn.mjs';
import { validatePlan, routeLimits, checkLedgerState } from './policy.mjs';
import { planningSystem, boundedContext } from './planning.mjs';
import { read, write, rows } from '../writer-control/support.mjs';
const job = read(process.argv[2]);
const { directory, task, selector, ledger, mounts, representation, campaign } = job;
mkdirSync(directory, { recursive: true });
const root = join(directory, 'repository'); mkdirSync(root); new Workspace(task.files).materialize(root);
const limits = job.mode === 'plan' ? task.limits : routeLimits(task.limits, job.preparation);
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), limits.cell_ms);
let client; const started = performance.now();
const summary = { task: task.id, task_hash: hash(JSON.stringify(task)), selector, representation, mode: job.mode, limits, error: null };
try {
  const { ModelRuntime } = await sdkImport('pi-coding-agent/dist/core/model-runtime.js');
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const selected = read(join(campaign, 'manifest.json')).models.find(row => row.selector === selector);
  if (!selected) throw new Error('Selector metadata not frozen');
  // Keep mutable credential material outside the snapshot/transcripts; only the existing
  // provider credential selector is read. All model metadata comes from this manifest.
  const providerConfig = { models: [selected.model] };
  if (selected.model.provider === 'primalabs') {
    const config = read(join(homedir(), '.pi/agent/models.json')).providers?.primalabs;
    if (!config?.apiKey) throw new Error('Existing PrimaLabs credential configuration unavailable');
    providerConfig.apiKey = config.apiKey; providerConfig.api = selected.model.api; providerConfig.baseUrl = selected.model.baseUrl;
  }
  runtime.registerProvider(selected.model.provider, providerConfig);
  await runtime.refresh({ allowNetwork: false, providers: [selected.model.provider] });
  client = new Client({ runtime, selector, ledger, receiptPath: join(directory, 'receipts.jsonl'), signal: controller.signal,
    maxCalls: limits.model_calls, maxTokens: limits.max_output_tokens, callMs: limits.call_ms });
  const begin = client.begin.bind(client);
  client.begin = (...args) => {
    // Independent incremental campaign stop, without counting another campaign's calls.
    const own = new Set(collectRequests(campaign).map(row => row.reservation));
    const exposure = checkLedgerState(read(ledger)).entries.filter(entry => own.has(entry.id)).reduce((sum, entry) => sum + (entry.charged_usd ?? entry.reserved_usd), 0);
    if (exposure >= 15) throw new Error('Incremental campaign exposure reached $15; no new request');
    return begin(...args);
  };
  if (job.mode === 'plan') {
    const catalog = buildQueryCatalog(task.files, task.spec, { parse, maxBytes: 65536, sourceRoot: '/work' }); write(join(directory, 'catalog.json'), catalog);
    const system = planningSystem(readFileSync(join(campaign, 'frozen/skills/spec-changeset-plan/SKILL.md'), 'utf8'), representation);
    const input = { task: task.spec, visible_check: task.check, protected_files: task.protected, file_tree: Object.keys(task.files), catalog };
    let lookup = false, correction = false, plan;
    for (let call = 0; call < 3; call++) {
      boundedContext(system, input);
      let candidate;
      try { candidate = await client.json(system, input, 'implementation-planning'); }
      catch (error) {
        if (!(error instanceof ModelJsonParseError) || correction || call === 2) throw error;
        correction = true; input.format_error = { message: error.message, response_excerpt: error.responseExcerpt }; continue;
      }
      if (Object.hasOwn(candidate ?? {}, 'source_requests')) {
        if (lookup || correction || call > 0 || Object.keys(candidate).length !== 1) throw new Error('Only one initial source-request envelope is permitted');
        lookup = true; write(join(directory, 'source-requests.json'), candidate.source_requests);
        input.source_lookup = resolveSourceRequests(task.files, candidate.source_requests, { parse, maxRequests: 8, maxCharacters: 64000 });
        write(join(directory, 'source-lookup.json'), input.source_lookup); continue;
      }
      try { plan = validatePlan(candidate, representation, task.files, parse, task.limits.model_calls - client.calls); break; }
      catch (error) {
        if (correction || call === 2) throw error;
        correction = true; input.previous_plan = candidate; input.planning_validation_errors = [error.message];
      }
    }
    if (!plan) throw new Error('Planning call cap exhausted');
    write(join(directory, 'plan.json'), plan); summary.plan_hash = hash(JSON.stringify(plan));
  } else if (job.mode === 'execute') {
    const prep = read(join(job.preparation_directory, 'result.json'));
    const plan = read(join(job.preparation_directory, 'plan.json'));
    if (prep.error || prep.task_hash !== summary.task_hash || prep.plan_hash !== hash(JSON.stringify(plan)) || prep.selector !== job.planner ||
        prep.model_calls !== job.preparation.model_calls || prep.process_elapsed_ms !== job.preparation.elapsed_ms) throw new Error('Prepared plan/task/accounting identity changed');
    validatePlan(plan, representation, task.files, parse, limits.model_calls);
    write(join(directory, 'plan.json'), plan); summary.plan_hash = prep.plan_hash; summary.preparation = job.preparation;
    let draft;
    const writingBegan = performance.now();
    const adapter = args => patchEditor(client, 'editor', task.spec, args, { ranges: true, focused: true, contextParse: parse });
    try { summary.execution = await execute(plan, new Workspace(task.files), { concurrency: 4, signal: controller.signal,
      adapters: representation === 'delegated' ? { simple: adapter, involved: adapter } : {}, onDraft: value => { draft = value; } }); }
    finally { summary.writing_elapsed_ms = performance.now() - writingBegan; }
    const candidate = draft?.files ?? task.files; rmSync(root, { recursive: true, force: true }); mkdirSync(root); new Workspace(candidate).materialize(root);
    write(join(directory, 'candidate.json'), candidate); summary.candidate_hash = hash(JSON.stringify(candidate));
    summary.writing_elapsed_ms = performance.now() - writingBegan; // Includes candidate materialization/retention.
    summary.application_complete = summary.execution.ok;
    const checksBegan = performance.now();
    const protectedIntact = task.protected.every(path => candidate[path] === task.files[path]);
    const visible = await sandbox(root, task.check, { signal: controller.signal, mounts, timeoutMs: limits.command_ms, maxMs: limits.command_ms });
    const changed = [];
    for (const selected of changedTestCommands(task.files, candidate, parse)) {
      const check = await sandbox(root, selected.command, { signal: controller.signal, mounts, timeoutMs: limits.command_ms, maxMs: limits.command_ms });
      if (check.ok && selected.names && !/# pass [1-9]\d*/.test(check.output)) check.ok = false;
      changed.push({ ...selected, ...check });
    }
    summary.checks = { protected_intact: protectedIntact, visible, candidate_tests: changed };
    summary.checks_elapsed_ms = performance.now() - checksBegan;
    clearTimeout(timer); // Independent original terminal grade allowance; never model input.
    const hiddenBegan = performance.now();
    try { summary.hidden = await grade(root, task.hidden, { oracle: join(directory, 'hidden.mjs'), mounts, signal: AbortSignal.timeout(limits.grade_ms), maxMs: limits.grade_ms }); }
    finally { summary.hidden_elapsed_ms = performance.now() - hiddenBegan; }
    summary.accepted = protectedIntact && summary.hidden.ok && !controller.signal.aborted;
    summary.audited_delivered = summary.accepted && summary.application_complete && visible.ok && changed.every(row => row.ok);
  } else throw new Error('Unknown worker mode');
} catch (error) { summary.error = error.message; }
finally {
  clearTimeout(timer); summary.elapsed_ms = performance.now() - started;
  summary.model_calls = client?.receipts.length ?? 0;
  summary.tokens = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'].map(key => [key, client?.receipts.every(row => Number.isFinite(row.usage?.[key])) ? client.receipts.reduce((sum, row) => sum + row.usage[key], 0) : null]));
  summary.receipt_cost_usd = client?.receipts.length && client.receipts.every(row => Number.isFinite(row.usage?.cost?.total)) ? client.receipts.reduce((sum, row) => sum + row.usage.cost.total, 0) : null;
  write(join(directory, 'result.json'), summary);
}
function collectRequests(path) {
  // Only known route/preparation directories; never read another campaign or credentials.
  const manifest = read(join(path, 'manifest.json'));
  return manifest.request_directories.flatMap(relative => rows(join(path, relative, 'requests.jsonl')));
}
