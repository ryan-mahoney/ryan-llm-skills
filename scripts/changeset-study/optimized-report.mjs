#!/usr/bin/env node
// Read frozen artifacts only. This report never initializes a model client.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, safePath } from '../changeset/workspace.mjs';
import { parseJson } from '../changeset/models.mjs';
import { equivalentCost, costPolicy } from '../changeset-research/cost.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const rows = p => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(x => x.trim()).map(JSON.parse) : [];
const sum = xs => xs.reduce((a, b) => a + b, 0);
const exactSum = xs => xs.every(Number.isFinite) ? sum(xs) : null;
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const phase = stage => stage === 'implementation-planning' ? 'owner' : ['planning', 'discovery-planning', 'query-context'].includes(stage) ? 'query' : stage === 'editor' || stage === 'execution' ? 'writing' : stage === 'context-routing' ? 'routing' : stage === 'optimization' ? 'optimization' : ['visible-check', 'terminal-grading'].includes(stage) ? 'checks' : 'other';
const safePlanArtifact = name => name === 'raw-plan.json' || (typeof name === 'string' && /^planning-attempt-\d+\.json$/.test(name));
const phases = ['owner', 'query', 'routing', 'optimization', 'writing', 'checks', 'other'];
const portable = (base, path) => relative(base, path).split('\\').join('/');
const assert = (condition, text) => { if (!condition) throw new Error(text); };
function usage(requests, receipts) {
  const complete = requests.length === receipts.length && receipts.every(r => r.usage && tokenKeys.every(k => Number.isFinite(r.usage[k])));
  return { calls: requests.length, receipts: receipts.length, accounting_complete: complete,
    tokens: Object.fromEntries(tokenKeys.map(k => [k, complete ? sum(receipts.map(r => r.usage[k])) : null])),
    known_tokens: Object.fromEntries(tokenKeys.map(k => [k, sum(receipts.map(r => r.usage?.[k] ?? 0))])),
    equivalent_usd: requests.length === 0 ? 0 : requests.length === receipts.length ? equivalentCost(receipts) : null,
    reported_usd: requests.length === 0 ? 0 : requests.length === receipts.length ? exactSum(receipts.map(r => r.usage?.cost?.total)) : null,
    request_seconds: sum(receipts.map(r => r.elapsed_ms ?? 0)) / 1000 };
}
function plus(a, b) {
  return { calls: a.calls + b.calls, receipts: a.receipts + b.receipts, accounting_complete: a.accounting_complete && b.accounting_complete,
    tokens: Object.fromEntries(tokenKeys.map(k => [k, exactSum([a.tokens[k], b.tokens[k]])])),
    known_tokens: Object.fromEntries(tokenKeys.map(k => [k, a.known_tokens[k] + b.known_tokens[k]])),
    equivalent_usd: exactSum([a.equivalent_usd, b.equivalent_usd]), reported_usd: exactSum([a.reported_usd, b.reported_usd]),
    request_seconds: a.request_seconds + b.request_seconds };
}
const emptyUsage = () => usage([], []);
function routingUsage(r) {
  const routing = r.routing ?? {}, u = routing.answer?.usage, spend = routing.spend;
  const input = u?.input_tokens ?? u?.input ?? spend?.inputTokens;
  const output = u?.output_tokens ?? u?.output ?? spend?.outputTokens;
  return { calls: routing.attempted ? 1 : 0, usage: u ?? null, input_tokens: input ?? null, output_tokens: output ?? null,
    tokens: u?.totalTokens ?? (Number.isFinite(input) && Number.isFinite(output) ? input + output : routing.attempted ? null : 0),
    estimated_usd: spend?.estimatedUsd ?? (routing.attempted ? null : 0),
    fallback: routing.fallback ?? null, answer_ok: routing.answer?.ok ?? null };
}

function sameData(a, b) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function requestInput(request) {
  try {
    const message = request.context?.messages?.filter(message => message.role === 'user').at(-1);
    const content = typeof message?.content === 'string' ? message.content : message?.content?.map(part => part.text ?? '').join('');
    return parseJson(content ?? '');
  } catch { return null; }
}
function modelValue(response) {
  try { return parseJson(response.response.content.filter(part => part.type === 'text').map(part => part.text).join('\n')); }
  catch { return null; }
}
function queryEvidence({ directory, result, job, requests, responses, verify, artifactHash, queryMode }) {
  const queries = requests.filter(request => phase(request.stage) === 'query');
  const artifact = name => { try { return existsSync(join(directory, name)) ? read(join(directory, name)) : null; } catch { return null; } };
  const catalogHash = artifactHash('catalog.json'), catalogChecks = [];
  const checkCatalog = (ok, name) => { catalogChecks.push(Boolean(ok)); verify(ok, name); };
  if (catalogHash !== null || result.catalog_hash != null || (queryMode?.startsWith('catalog') && queries.length > 0)) {
    checkCatalog(catalogHash !== null && catalogHash === result.catalog_hash, 'catalog artifact hash');
    const catalog = artifact('catalog.json');
    checkCatalog(catalog?.schema_version === 1 && Array.isArray(catalog?.files), 'catalog artifact shape');
    checkCatalog(queries.every(request => sameData(requestInput(request)?.catalog, catalog)), 'query packets retain the catalog artifact');
  }
  const requestHash = artifactHash('source-requests.json'), lookupHash = artifactHash('source-lookup.json');
  const packetLookup = queries.some(query => {
    const input = requestInput(query);
    return Object.hasOwn(input ?? {}, 'source_lookup') || Object.hasOwn(input ?? {}, 'source_requests');
  });
  const lookupPresent = packetLookup || requestHash !== null || lookupHash !== null || result.source_requests_hash != null || result.source_lookup_hash != null || result.source_lookup_characters != null;
  let lookup = null;
  if (lookupPresent) {
    const checks = [], check = (ok, name) => { checks.push(Boolean(ok)); verify(ok, name); };
    check(requestHash !== null && requestHash === result.source_requests_hash, 'source lookup request artifact hash');
    check(lookupHash !== null && lookupHash === result.source_lookup_hash, 'source lookup result artifact hash');
    const requested = artifact('source-requests.json'), resolved = artifact('source-lookup.json');
    let responseRows;
    try { responseRows = responses(); } catch { responseRows = []; }
    const origins = responseRows.filter(response => queries.some(query => query.reservation === response.reservation) && sameData(modelValue(response)?.source_requests, requested));
    check(origins.length > 0 && requested !== null, 'source requests match an original query response');
    check(job.task && hash(JSON.stringify(job.task)) === result.task_hash, 'lookup source task hash');
    const followups = queries.filter(request => Object.hasOwn(requestInput(request) ?? {}, 'source_lookup'));
    check(followups.every(request => sameData(requestInput(request).source_requests, requested) && sameData(requestInput(request).source_lookup, resolved)), 'source lookup followup packets retain exact requests and result');
    const rejected = resolved?.ok === false;
    const snippetEvidence = [];
    if (rejected) {
      check(typeof resolved.error === 'string' && resolved.error.length > 0 && !Object.hasOwn(resolved, 'snippets') && result.source_lookup_characters == null && followups.length === 0, 'rejected lookup is explicit and supplies no successful source');
    } else {
      check(resolved?.schema_version === 1 && resolved.offset_units === 'utf16-code-units' && Array.isArray(requested) && requested.length > 0 && requested.length <= 8 && Array.isArray(resolved?.snippets) && resolved.snippets.length === requested.length, 'successful lookup batch shape');
      let characters = 0;
      for (const [index, snippet] of (Array.isArray(resolved?.snippets) ? resolved.snippets : []).entries()) {
        let pathSafe = true;
        try { safePath(snippet?.path); } catch { pathSafe = false; }
        const source = pathSafe && Object.hasOwn(job.task?.files ?? {}, snippet.path) ? job.task.files[snippet.path] : null;
        check(snippet?.request_index === index && sameData(snippet?.request, requested?.[index]) && snippet?.path === requested?.[index]?.path, `lookup snippet ${index} request identity`);
        check(typeof source === 'string' && snippet?.source_hash === hash(source), `lookup snippet ${index} whole-file source hash`);
        const offsets = typeof source === 'string' && Number.isInteger(snippet?.source_start) && Number.isInteger(snippet?.source_end) && snippet.source_start >= 0 && snippet.source_end > snippet.source_start && snippet.source_end <= source.length;
        check(offsets && snippet?.text === source.slice(snippet.source_start, snippet.source_end), `lookup snippet ${index} exact source slice and offsets`);
        const endpoint = (anchor, offset, boundary) => typeof source === 'string' && (anchor === null ? offset === boundary :
          typeof anchor === 'string' && anchor.length > 0 && anchor.length <= 160 && source.indexOf(anchor) === offset && source.lastIndexOf(anchor) === offset);
        check(offsets && endpoint(snippet.start, snippet.source_start, 0) && endpoint(snippet.end, snippet.source_end, source.length), `lookup snippet ${index} unique source anchors`);
        if (typeof snippet?.text === 'string') characters += snippet.text.length;
        snippetEvidence.push({ request_index: snippet?.request_index ?? null, path: snippet?.path ?? null, source_hash: snippet?.source_hash ?? null,
          source_start: snippet?.source_start ?? null, source_end: snippet?.source_end ?? null, start: snippet?.start ?? null, end: snippet?.end ?? null,
          text_hash: typeof snippet?.text === 'string' ? hash(snippet.text) : null });
      }
      check(Number.isInteger(resolved?.source_characters) && resolved.source_characters === characters && characters <= 64000 && result.source_lookup_characters === characters, 'lookup character counts and batch cap');
    }
    lookup = { status: rejected ? 'rejected' : Array.isArray(resolved?.snippets) ? 'resolved' : 'invalid', provenance_valid: checks.every(Boolean), successful_lookup: !rejected && checks.every(Boolean), request_count: Array.isArray(requested) ? requested.length : null,
      source_characters: rejected ? null : resolved?.source_characters ?? null, error: rejected ? resolved.error : null,
      request_origin_reservation: origins[0]?.reservation ?? null, requests_hash: requestHash, result_hash: lookupHash, snippets: snippetEvidence };
  }
  const recoveries = result.query_format_recoveries ?? [];
  const lookupMode = (queryMode ?? 'discovery') === 'catalog-lookup';
  if (lookupMode) {
    verify(queries.length <= 3 && queries.every(query => query.stage === 'planning'), 'catalog-lookup planning call cap and stages');
    verify(Array.isArray(recoveries) && recoveries.length <= 1 && recoveries.every(recovery => Number.isInteger(recovery.after_call) && recovery.after_call >= 1 && recovery.after_call <= queries.length && recovery.after_call < 3 && typeof recovery.error === 'string'), 'catalog-lookup bounded format recovery metadata');
  }
  return { catalog_hash: catalogHash, catalog_evidence: catalogChecks.length ? { recorded_hash: result.catalog_hash ?? null, provenance_valid: catalogChecks.every(Boolean) } : null,
    source_requests_hash: requestHash, source_lookup_hash: lookupHash, source_lookup_characters: result.source_lookup_characters ?? null,
    source_lookup_evidence: lookup, query_format_recoveries: recoveries, query_format_recovery_count: Array.isArray(recoveries) ? recoveries.length : null, query_call_count: queries.length, query_call_cap: lookupMode ? 3 : null };
}

export function buildReport(runRoot) {
  const root = resolve(runRoot), cache = new Map(), active = new Set();
  const manifests = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(root, e.name, 'manifest.json')))
    .map(e => ({ name: e.name, manifest: read(join(root, e.name, 'manifest.json')) })).filter(e => e.manifest.strategy === 'owner-query-writer').sort((a, b) => a.name.localeCompare(b.name));
  function cell(run, cellName) {
    const key = `${run}/${cellName}`;
    if (cache.has(key)) return cache.get(key);
    assert(!active.has(key), `Cyclic planning source: ${key}`); active.add(key);
    assert(basename(run) === run && basename(cellName) === cellName, 'Planning source must use local run/cell names');
    const directory = join(root, run, cellName), rp = join(directory, 'result.json');
    const m = read(join(root, run, 'manifest.json'));
    if (!existsSync(rp) || !Number.isFinite(read(rp).process_elapsed_ms)) { active.delete(key); return null; }
    const r = read(rp), requests = rows(join(directory, 'requests.jsonl')), receipts = rows(join(directory, 'receipts.jsonl'));
    const checks = [], verify = (ok, message) => checks.push({ check: message, ok: Boolean(ok) });
    const artifactHash = name => existsSync(join(directory, name)) ? hash(readFileSync(join(directory, name))) : null;
    const plan = existsSync(join(directory, 'plan-0.json')) ? read(join(directory, 'plan-0.json')) : null;
    const rawHash = artifactHash('raw-plan.json'), briefHash = artifactHash('implementation-brief.md');
    const planningArtifacts = readdirSync(directory).filter(safePlanArtifact).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(name => ({ name, hash: artifactHash(name), kind: name === 'raw-plan.json' ? 'raw-plan' : 'planning-attempt' }));
    const ownOrigin = planningArtifacts.find(a => a.name === 'raw-plan.json') ?? planningArtifacts.at(-1) ?? null;
    verify(artifactHash('candidate.json') !== null && artifactHash('candidate.json') === r.candidate_hash, 'candidate hash');
    verify(r.selector === m.selector && r.editor_selector === m.editor_selector && m.strategy === 'owner-query-writer', 'result roles match manifest');
    verify((r.optimization ?? 'none') === (m.optimization ?? 'none'), 'result optimization matches manifest');
    verify((r.query_mode ?? 'discovery') === (m.query_mode ?? 'discovery'), 'result query mode matches manifest');
    verify(briefHash !== null && briefHash === r.implementation_brief_hash, 'implementation brief hash');
    verify(rawHash !== null && plan !== null, 'raw and dispatched plans retained');
    verify(!r.executions?.length || (plan && hash(JSON.stringify(plan)) === r.executions[0].plan_sha256), 'dispatched plan hash');
    const requestIds = new Set(requests.map(x => x.reservation));
    verify(requestIds.size === requests.length && new Set(receipts.map(x => x.reservation)).size === receipts.length && receipts.every(x => requestIds.has(x.reservation)), 'request and receipt identities');
    verify(receipts.every(x => { const q = requests.find(q => q.reservation === x.reservation); return q?.stage === x.stage && q?.selector === x.selector; }), 'receipt routing matches requests');
    const sol = /^(openai|openai-codex)\/gpt-6\.1-sol(?::|$)/;
    const firstWriter = requests.findIndex(x => x.stage === 'editor');
    const firstQuery = requests.findIndex(x => phase(x.stage) === 'query');
    const providerValid = sol.test(m.selector) && /^deepseek\//.test(m.editor_selector) &&
      requests.every((x, i) => ['owner', 'query', 'writing'].includes(phase(x.stage)) &&
        x.selector === (phase(x.stage) === 'query' ? m.selector : m.editor_selector) &&
        (phase(x.stage) === 'writing' || firstWriter < 0 || i < firstWriter) &&
        (phase(x.stage) !== 'owner' || firstQuery < 0 || i < firstQuery)) &&
      (r.reviews ?? []).length === 0 && (r.repairs ?? 0) === 0 &&
      (r.executions ?? []).every(e => (e.operations ?? []).every(o => o.status === 'blocked' || ['simple', 'involved'].includes(o.executor)));
    verify(providerValid, 'DeepSeek owner, Sol query, DeepSeek writers; no planning after writers');
    const byStage = Object.fromEntries(phases.map(p => [p, usage(requests.filter(x => phase(x.stage) === p), receipts.filter(x => phase(x.stage) === p))]));
    const seconds = Object.fromEntries(phases.map(p => [p, sum((r.stages ?? []).filter(x => phase(x.name) === p).map(x => x.elapsed_ms)) / 1000]));
    const job = existsSync(join(directory, 'job.json')) ? read(join(directory, 'job.json')) : {};
    const evidence = queryEvidence({ directory, result: r, job, requests, responses: () => rows(join(directory, 'responses.jsonl')), verify, artifactHash, queryMode: m.query_mode });
    const source = r.planning_source ?? job.planningSource ?? null;
    const briefSource = r.brief_source ?? job.briefSource ?? null;
    const queryContextSeconds = sum((r.stages ?? []).filter(s => s.name === 'query-context').map(s => s.elapsed_ms)) / 1000;
    let briefDonor = null, briefValid = false;
    let donor = null, sourceValid = false, selectedSourceArtifact = null;
    verify((m.plans_from ?? null) === (source?.run ?? null), 'manifest planning source matches cell');
    if (r.planning_source && job.planningSource) verify(JSON.stringify(r.planning_source) === JSON.stringify(job.planningSource), 'job and result planning source match');
    if (Number.isFinite(r.model_calls)) verify(r.model_calls === requests.length, 'recorded model calls match requests');
    if (source) {
      const sourceChecks = [];
      const verifySource = (ok, message) => { sourceChecks.push(Boolean(ok)); verify(ok, message); };
      const selectedName = source.plan_artifact ?? 'raw-plan.json';
      verifySource(safePlanArtifact(selectedName), 'safe planning source artifact name');
      donor = cell(source.run, source.cell);
      verifySource(Boolean(donor), 'planning source completed');
      if (donor) {
        selectedSourceArtifact = safePlanArtifact(selectedName) ? donor.planning_artifacts.find(a => a.name === selectedName) ?? null : null;
        verifySource(selectedSourceArtifact?.hash === source.plan_hash && rawHash === source.plan_hash, 'shared selected planning artifact hash');
        verifySource(donor.result_hash === source.result_hash, 'planning source result hash');
        verifySource(donor.provider_routing_valid && donor.owner_role_valid, 'planning source provider routing');
        verifySource(Boolean(donor.allocated_planning), 'planning source allocated planning available');
        verifySource(donor.implementation_brief_valid && donor.implementation_brief_hash === briefHash && donor.task_hash === r.task_hash, 'shared task and frozen brief');
        verifySource(requests.every(x => !['owner', 'query'].includes(phase(x.stage))), 'replay incurs no owner/query calls');
      }
      sourceValid = sourceChecks.every(Boolean);
    }
    if (briefSource) {
      const briefChecks = [];
      const verifyBrief = (ok, message) => { briefChecks.push(Boolean(ok)); verify(ok, message); };
      verifyBrief((m.briefs_from ?? m.plans_from ?? null) === briefSource.run, 'manifest brief source matches cell');
      if (r.brief_source && job.briefSource) verifyBrief(JSON.stringify(r.brief_source) === JSON.stringify(job.briefSource), 'job and result brief source match');
      briefDonor = cell(briefSource.run, briefSource.cell);
      verifyBrief(Boolean(briefDonor), 'brief source completed');
      if (briefDonor) {
        verifyBrief(briefDonor.result_hash === briefSource.result_hash, 'brief source result hash');
        verifyBrief(briefDonor.implementation_brief_valid && briefDonor.implementation_brief_hash === briefSource.brief_hash && briefHash === briefSource.brief_hash && briefHash === r.implementation_brief_hash, 'shared brief bytes and recorded hashes');
        verifyBrief(briefDonor.task_hash === r.task_hash, 'brief source task hash');
        verifyBrief(briefDonor.owner_role_valid && briefDonor.editor_selector === m.editor_selector && Boolean(briefDonor.allocated_owner), 'brief source DeepSeek owner role');
        verifyBrief(byStage.owner.calls === 0, 'shared brief incurs no owner calls');
      }
      if (source) verifyBrief(source.run === briefSource.run && source.cell === briefSource.cell && source.result_hash === briefSource.result_hash, 'plan and brief source agree');
      briefValid = briefChecks.every(Boolean);
    } else verify(!m.briefs_from, 'brief-only manifest retains brief source');
    if (!source) verify((briefSource ? byStage.owner.calls === 0 : byStage.owner.calls > 0) && byStage.query.calls > 0, 'original query and owner provenance retained');
    const inherited = source ? sourceValid && (!briefSource || briefValid) : briefSource ? briefValid : true;
    const emptyPlanning = { seconds: 0, owner_seconds: 0, query_seconds: 0, query_context_seconds: 0, usage: emptyUsage() };
    const borrowed = !inherited ? null : source ? donor.allocated_planning : briefSource ? {
      seconds: briefDonor.allocated_owner.seconds, owner_seconds: briefDonor.allocated_owner.seconds, query_seconds: 0, query_context_seconds: 0, usage: briefDonor.allocated_owner.usage,
    } : emptyPlanning;
    const planning = borrowed ? { seconds: seconds.owner + seconds.query + borrowed.seconds,
      owner_seconds: seconds.owner + borrowed.owner_seconds, query_seconds: seconds.query + borrowed.query_seconds,
      query_context_seconds: queryContextSeconds + (borrowed.query_context_seconds ?? 0),
      usage: plus(plus(byStage.owner, byStage.query), borrowed.usage) } : null;
    const borrowedOwner = source ? donor?.allocated_owner : briefSource ? briefDonor?.allocated_owner : { seconds: 0, usage: emptyUsage() };
    const allocatedOwner = inherited && borrowedOwner ? { seconds: seconds.owner + borrowedOwner.seconds, usage: plus(byStage.owner, borrowedOwner.usage) } : null;
    const ownerRequests = requests.filter(x => phase(x.stage) === 'owner'), ownerReceipts = receipts.filter(x => phase(x.stage) === 'owner');
    const ownerRoleValid = m.strategy === 'owner-query-writer' && /^deepseek\//.test(m.editor_selector) && r.editor_selector === m.editor_selector &&
      ownerRequests.every(q => q.selector === m.editor_selector) && ownerReceipts.length === ownerRequests.length &&
      new Set(ownerRequests.map(q => q.reservation)).size === ownerRequests.length && new Set(ownerReceipts.map(q => q.reservation)).size === ownerReceipts.length &&
      ownerReceipts.every(x => x.selector === m.editor_selector && ownerRequests.some(q => q.reservation === x.reservation)) &&
      Boolean(allocatedOwner) && (ownerRequests.length > 0 || (source ? sourceValid && donor?.owner_role_valid : briefSource ? briefValid : false));
    const incurred = usage(requests, receipts), jev = routingUsage(r);
    const allocated = borrowed ? plus(incurred, borrowed.usage) : null;
    const visible = (r.checks ?? []).at(-1)?.visible;
    const candidateTests = visible?.candidate_tests ?? [];
    const applicationComplete = r.executions?.at(-1)?.ok === true;
    const output = { ...evidence, task: r.task ?? cellName.replace(/^\d+-/, ''), cell: key, optimization: m.optimization ?? 'none', query_mode: m.query_mode ?? 'discovery', editor_selector: m.editor_selector, task_hash: r.task_hash,
      application_complete: applicationComplete, visible_accepted: r.visible_accepted ?? visible?.ok ?? null,
      candidate_tests: { count: candidateTests.length, failed: candidateTests.filter(t => t.ok !== true).length },
      base_visible_accepted: visible?.base_ok ?? visible?.visible_check_ok ?? null,
      external_accepted: r.accepted ?? null, hidden_pass: r.hidden_pass ?? null, error: r.error ?? null,
      downstream_failures: { visible: typeof (visible?.base_ok ?? visible?.visible_check_ok) === 'boolean' ? !(visible.base_ok ?? visible.visible_check_ok) : visible && !candidateTests.some(t => t.ok !== true) ? visible.ok !== true : null, candidate: candidateTests.some(t => t.ok !== true), external: typeof r.accepted === 'boolean' ? !r.accepted : null },
      integrity_valid: checks.every(c => c.ok), validation: checks, provider_routing_valid: providerValid,
      result_hash: artifactHash('result.json'), raw_plan_hash: rawHash, plan_hash: artifactHash('plan-0.json'), candidate_hash: r.candidate_hash,
      implementation_brief_hash: briefHash, implementation_brief_valid: briefHash !== null && briefHash === r.implementation_brief_hash,
      planning_artifacts: planningArtifacts,
      planning_origin: source ? { kind: selectedSourceArtifact?.kind === 'planning-attempt' ? 'reused-candidate-planning-attempt' : 'reused-raw-plan',
        run: source.run, cell: source.cell, artifact: source.plan_artifact ?? 'raw-plan.json', hash: selectedSourceArtifact?.hash ?? null,
        donor_integrity_valid: donor?.integrity_valid ?? null, donor_application_complete: donor?.application_complete ?? null }
        : ownOrigin ? { kind: ownOrigin.kind === 'planning-attempt' ? 'undispatched-candidate-planning-attempt' : 'original-raw-plan',
          run, cell: cellName, artifact: ownOrigin.name, hash: ownOrigin.hash } : null,
      planning_source: source, planning_source_valid: source ? sourceValid && (!briefSource || briefValid) : null,
      brief_source: briefSource, brief_source_valid: briefSource ? briefValid : null,
      brief_origin: briefSource ? { kind: 'reused-owner-brief', run: briefSource.run, cell: briefSource.cell, hash: briefSource.brief_hash, result_hash: briefSource.result_hash } : null,
      reused_planning: Boolean(source || briefSource), borrowed_planning_scope: source ? 'owner-and-query' : briefSource ? 'owner-only' : 'none',
      borrowed_planning: borrowed, allocated_planning: planning, allocated_owner: allocatedOwner, owner_role_valid: ownerRoleValid,
      incurred: { seconds: r.process_elapsed_ms / 1000, model_usage: incurred, jev, equivalent_plus_jev_estimated_usd: exactSum([incurred.equivalent_usd, jev.estimated_usd]) },
      allocated: { seconds: borrowed ? r.process_elapsed_ms / 1000 + borrowed.seconds : null,
        model_usage: allocated, equivalent_plus_jev_estimated_usd: allocated ? exactSum([allocated.equivalent_usd, jev.estimated_usd]) : null },
      phase_seconds: seconds, query_context_seconds: queryContextSeconds, writing_pipeline_seconds: seconds.writing + seconds.optimization + seconds.routing, model_usage_by_stage: byStage,
      allocated_phase_seconds: { ...seconds, owner: planning?.owner_seconds ?? null, query: planning?.query_seconds ?? null },
      optimization_metrics: r.optimization_metrics ?? null };
    cache.set(key, output); active.delete(key); return output;
  }
  const runs = manifests.map(({ name, manifest: m }) => {
    const cells = [], pending = [];
    for (const [index, task] of m.schedule.entries()) {
      const c = cell(name, `${String(index).padStart(3, '0')}-${task}`); if (c) cells.push(c); else pending.push(task);
    }
    const totalUsage = cells.reduce((a, c) => plus(a, c.incurred.model_usage), emptyUsage());
    const allocatedUsage = cells.every(c => c.allocated.model_usage) ? cells.reduce((a, c) => plus(a, c.allocated.model_usage), emptyUsage()) : null;
    return { run: name, optimization: m.optimization ?? 'none', query_mode: m.query_mode ?? 'discovery', plans_from: m.plans_from ?? null, briefs_from: m.briefs_from ?? null,
      manifest_hash: hash(readFileSync(join(root, name, 'manifest.json'))), expected: m.schedule.length, pending,
      application_complete: cells.filter(c => c.application_complete).length, integrity_valid: cells.every(c => c.integrity_valid),
      incurred_seconds: sum(cells.map(c => c.incurred.seconds)), allocated_seconds: exactSum(cells.map(c => c.allocated.seconds)),
      writing_seconds: sum(cells.map(c => c.phase_seconds.writing)), writing_pipeline_seconds: sum(cells.map(c => c.writing_pipeline_seconds)), model_usage: totalUsage, allocated_model_usage: allocatedUsage,
      incurred_equivalent_plus_jev_estimated_usd: exactSum(cells.map(c => c.incurred.equivalent_plus_jev_estimated_usd)),
      allocated_equivalent_plus_jev_estimated_usd: exactSum(cells.map(c => c.allocated.equivalent_plus_jev_estimated_usd)),
      jev: { calls: sum(cells.map(c => c.incurred.jev.calls)), tokens: exactSum(cells.map(c => c.incurred.jev.tokens)), estimated_usd: exactSum(cells.map(c => c.incurred.jev.estimated_usd)) }, cells };
  });
  const groups = new Map();
  for (const run of runs) for (const c of run.cells) if (c.raw_plan_hash) {
    const key = `${c.task_hash}:${c.raw_plan_hash}:${c.implementation_brief_hash}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(c);
  }
  const ablations = [...groups.values()].map(cells => ({ task: cells[0].task, raw_plan_hash: cells[0].raw_plan_hash,
    eligible: new Set(cells.map(c => c.optimization)).size > 1 && cells.every(c => c.integrity_valid),
    cells: cells.map(c => ({ cell: c.cell, optimization: c.optimization, application_complete: c.application_complete,
      writing_seconds: c.phase_seconds.writing, writing_pipeline_seconds: c.writing_pipeline_seconds, writer_calls: c.model_usage_by_stage.writing.calls, writer_tokens: c.model_usage_by_stage.writing.tokens.totalTokens,
      downstream_failures: c.downstream_failures })) }));
  const eligibleRuns = runs.filter(r => !r.pending.length && r.expected > 0 && r.application_complete === r.expected && r.integrity_valid);
  // Compare only the same cases and frozen owner/query inputs. Unmatched groups remain descriptive.
  const signature = r => JSON.stringify(r.cells.map(c => [c.task_hash, c.raw_plan_hash, c.implementation_brief_hash]).sort());
  const comparisons = [];
  for (const a of eligibleRuns) for (const b of eligibleRuns) if (a.run < b.run && signature(a) === signature(b)) comparisons.push({ first: a.run, second: b.run,
    faster_writing_pipeline: a.writing_pipeline_seconds === b.writing_pipeline_seconds ? 'tie' : a.writing_pipeline_seconds < b.writing_pipeline_seconds ? a.run : b.run,
    first_writing_pipeline_seconds: a.writing_pipeline_seconds, second_writing_pipeline_seconds: b.writing_pipeline_seconds,
    first_writing_seconds: a.writing_seconds, second_writing_seconds: b.writing_seconds });
  const historicalPath = join(dirname(fileURLToPath(import.meta.url)), 'sol-only-results.json');
  const historical = existsSync(historicalPath) ? read(historicalPath) : null;
  return { schema_version: 1, label: 'Owner/query/writer optimizer study', paths_relative_to: 'run_root', cost_policy: costPolicy,
    accounting_note: 'Actual incurred model usage excludes reused planning. plans_from adds original owner/query work; brief_source adds only the inherited owner, retaining newly incurred query/context generation work exactly once. Jev estimated spend is separate from normalized Sol/DeepSeek cost. Allocated seconds exclude donor writing, checks, initialization and routing. Query seconds include deterministic query-context generation.',
    historical_baselines: historical ? [{ label: 'Native Sol (historical; unmatched)', ...historical.baseline },
      ...historical.iterations.filter(x => ['06-boundary-review', '07-boundary-review-repeat'].includes(x.run)).map(x => ({ label: `${x.run} (historical; unmatched)`, seconds: x.seconds, calls: x.calls, tokens: x.tokens, equivalent_usd: x.equivalent_usd }))] : [],
    historical_source: historical ? { path_relative_to_script: 'sol-only-results.json', hash: hash(readFileSync(historicalPath)) } : null,
    runs, ablations, recommendation: { scope: 'Observed writer, optimizer and routing elapsed performance among application-complete, integrity-valid configurations with identical cases, raw plans and briefs; downstream outcomes remain separate. No global optimality claim.',
      matched_comparisons: comparisons, status: comparisons.length ? 'matched observations available' : 'pending matched application-complete configurations' } };
}

export function markdown(report) {
  const f = (x, n = 2) => Number.isFinite(x) ? x.toFixed(n) : 'unknown';
  return ['# Owner/query/writer optimizer results', '', report.accounting_note, '',
    '| Run | Mode | Applied | Pending | Actual s | Allocated s | Writing s | Writing + optimizer + routing s |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...report.runs.map(r => `| ${r.run} | ${r.optimization}/${r.query_mode} | ${r.application_complete}/${r.expected} | ${r.pending.length} | ${f(r.incurred_seconds)} | ${f(r.allocated_seconds)} | ${f(r.writing_seconds)} | ${f(r.writing_pipeline_seconds)} |`), '',
    '| Run | Calls actual / allocated | Tokens actual / allocated | Equivalent USD actual / allocated | Jev calls | Jev tokens | Jev est. USD |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...report.runs.map(r => `| ${r.run} | ${r.model_usage.calls} / ${r.allocated_model_usage?.calls ?? 'unknown'} | ${r.model_usage.tokens.totalTokens ?? 'unknown'} / ${r.allocated_model_usage?.tokens.totalTokens ?? 'unknown'} | ${f(r.model_usage.equivalent_usd, 6)} / ${f(r.allocated_model_usage?.equivalent_usd, 6)} | ${r.jev.calls} | ${r.jev.tokens ?? 'unknown'} | ${f(r.jev.estimated_usd, 6)} |`), '',
    '| Cell | Valid | Applied | Visible base | Candidate failures | External | Owner s* | Query s* | Routing s | Optimization s | Writing s | Checks s |',
    '|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|',
    ...report.runs.flatMap(r => r.cells.map(c => `| ${c.cell} | ${c.integrity_valid} | ${c.application_complete} | ${c.base_visible_accepted ?? (c.downstream_failures.visible === null ? 'unknown' : !c.downstream_failures.visible)} | ${c.candidate_tests.failed}/${c.candidate_tests.count} | ${c.external_accepted ?? 'unknown'} | ${f(c.allocated_phase_seconds.owner)} | ${f(c.allocated_phase_seconds.query)} | ${f(c.phase_seconds.routing)} | ${f(c.phase_seconds.optimization)} | ${f(c.phase_seconds.writing)} | ${f(c.phase_seconds.checks)} |`)), '',
    '*Owner and query seconds include allocated original planning for replays. JSON retains actual phase time and all stage calls/tokens separately. Application completion means execute returned ok, independently of downstream checks.', '',
    report.recommendation.scope, '', report.recommendation.status + '.',
    ...report.recommendation.matched_comparisons.map(c => `- ${c.first}: ${f(c.first_writing_pipeline_seconds)} writer + optimizer + routing seconds; ${c.second}: ${f(c.second_writing_pipeline_seconds)}. Faster observed pipeline: ${c.faster_writing_pipeline}.`), '',
    '| Historical control (unmatched) | Seconds | Calls | Tokens | Equivalent USD |', '|---|---:|---:|---:|---:|',
    ...report.historical_baselines.map(b => `| ${b.label} | ${f(b.seconds)} | ${b.calls ?? 'unknown'} | ${b.tokens ?? 'unknown'} | ${f(b.equivalent_usd, 6)} |`), '',
    'Historical controls use exposed development cases and different workflows; they are retained context, not matched optimizer ablations.', ''].join('\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, output] = process.argv.slice(2);
  if (!root || !output) throw new Error('Usage: optimized-report.mjs RUN_ROOT OUTPUT_PREFIX');
  const report = buildReport(root);
  writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
  writeFileSync(output + '.md', markdown(report));
  console.log(JSON.stringify({ runs: report.runs.length, cells: sum(report.runs.map(r => r.cells.length)), output: portable(process.cwd(), resolve(output)) }));
}
