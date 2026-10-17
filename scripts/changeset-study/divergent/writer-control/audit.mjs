import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, model, packet, read, rows, safePath, same } from './support.mjs';

// No model/runtime imports. The caller verifies the frozen manifest/inputs first.
export async function auditCell({ directory, expectedJob, expectedPlan, taskHash, expectedWriterSelector = model, frozenBackendRoot = join(dirname(directory), 'backend') }) {
  if (![model, 'deepseek/deepseek-flash:off'].includes(expectedWriterSelector)) throw new Error('Unsupported explicit audit writer selector');
  const checks = [], check = (ok, name) => checks.push({ check: name, ok: Boolean(ok) });
  let result = {}, requests = [], receipts = [], responses = [], actualJob = {}, plan = null, candidate = null;
  try { result = read(join(directory, 'result.json')); } catch {}
  try { actualJob = read(join(directory, 'job.json')); } catch {}
  try { requests = rows(join(directory, 'requests.jsonl')); receipts = rows(join(directory, 'receipts.jsonl')); responses = rows(join(directory, 'responses.jsonl')); } catch { check(false, 'parseable model receipts'); }
  try { plan = read(join(directory, 'plan-0.json')); } catch {}
  try { candidate = read(join(directory, 'candidate.json')); } catch {}
  check(same(actualJob, expectedJob) && actualJob.task && hash(JSON.stringify(actualJob.task)) === taskHash, 'exact frozen source task, brief, plan, limits and control job');
  check(result.task_hash === taskHash && result.task === expectedJob.task.id && result.strategy === 'owner-query-writer' && result.selector === expectedJob.selector &&
    result.editor_selector === expectedWriterSelector && result.writer_recovery_selector == null, 'result source identity and authorized writer role');
  check(result.optimization === 'none' && result.query_mode === expectedJob.queryMode && result.query_granularity === expectedJob.queryGranularity,
    'result treatment identity');
  check(Object.entries(expectedJob.task.limits).every(([key, value]) => same(result.limits?.[key], value)), 'unchanged requested limits');
  check((result.reviews ?? []).length === 0 && result.repairs === 0 && !result.routing?.attempted, 'no review, batch repair or routing inference');
  check(requests.length > 0 && requests.every(request => request.selector === expectedWriterSelector && request.stage === 'editor') &&
    receipts.every(receipt => receipt.selector === expectedWriterSelector && receipt.stage === 'editor'), 'only authorized writer requests and receipts');
  const ids = new Set(requests.map(request => request.reservation));
  check(requests.every(request => typeof request.reservation === 'string' && request.reservation.length > 0) && ids.size === requests.length && receipts.length === requests.length && new Set(receipts.map(receipt => receipt.reservation)).size === receipts.length &&
    receipts.every(receipt => ids.has(receipt.reservation)), 'one receipt per unique request');
  check(responses.length === requests.length && new Set(responses.map(response => response.reservation)).size === responses.length &&
    responses.every(response => response.stage === 'editor' && ids.has(response.reservation)), 'response reservations exactly join editor requests; no orphan responses');
  check(responses.every(response => {
    const receipt = receipts.find(receipt => receipt.reservation === response.reservation), message = response.response;
    return receipt && receipt.stop_reason === (message?.stopReason ?? 'exception') &&
      (receipt.error ?? null) === (response.error ?? message?.errorMessage ?? null) && same(receipt.usage ?? null, message?.usage ?? null);
  }), 'response outcome and usage match the corresponding receipt');
  check(result.model_calls === requests.length && requests.length <= expectedJob.task.limits.model_calls, 'call accounting and shared call limit');
  check(same(plan, expectedPlan) && result.executions?.length === 1 && result.executions[0].plan_sha256 === hash(JSON.stringify(expectedPlan)),
    'exact donor dispatched plan and one execution');
  const operations = expectedPlan.operations, seen = new Map();
  for (const request of requests) {
    const operation = operations.find(operation => operation.id === request.operation_id), input = packet(request);
    const previous = seen.get(request.operation_id) ?? [];
    check(operation && request.writer_attempt === previous.length && previous.length < 2,
      'attempt belongs to a dispatched operation in initial/retry order');
    check(operation && input && ['objective', 'instruction', 'requirements', 'writes'].every(field => same(input[field], operation[field])), 'packet matches dispatched assignment');
    const receipt = receipts.find(receipt => receipt.reservation === request.reservation);
    check(receipt?.operation_id === request.operation_id && receipt?.writer_attempt === request.writer_attempt && receipt?.selector === request.selector && receipt?.stage === request.stage,
      'request and receipt route metadata match');
    if (request.writer_attempt === 1) {
      const base = value => value && Object.fromEntries(Object.entries(value).filter(([key]) => !['application_failure', 'rejected_edit_summary', 'rejected_response_excerpt'].includes(key)));
      check(typeof input?.application_failure === 'string' && input.application_failure.trim().length > 0 && previous.length === 1 &&
        same(base(input), base(packet(previous[0]))) && request.context?.systemPrompt === previous[0].context?.systemPrompt,
        'single local retry preserves staged input and adds only application diagnostics');
    } else check(input && !Object.hasOwn(input, 'application_failure'), 'initial request has no failure feedback');
    previous.push(request); seen.set(request.operation_id, previous);
  }
  const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
  check(receipts.every(receipt => usageKeys.every(key => Number.isFinite(receipt.usage?.[key]) && receipt.usage[key] >= 0)) &&
    usageKeys.every(key => result.tokens?.[key] === receipts.reduce((sum, receipt) => sum + (receipt.usage?.[key] ?? 0), 0)), 'complete writer token accounting');
  if (existsSync(join(directory, 'candidate.json'))) check(hash(readFileSync(join(directory, 'candidate.json'))) === result.candidate_hash, 'candidate artifact hash');
  else check(false, 'candidate artifact retained');
  const source = expectedJob.task.files, writable = new Set(operations.flatMap(operation => operation.writes));
  try {
    check(candidate && Object.entries(candidate).every(([path, text]) => { safePath(path); return typeof text === 'string' && (Object.hasOwn(source, path) || writable.has(path)); }) &&
      [...new Set([...Object.keys(source), ...Object.keys(candidate ?? {})])].every(path => writable.has(path) || source[path] === candidate[path]) &&
      expectedJob.task.protected.every(path => source[path] === candidate[path]), 'candidate respects declared paths and protected source');
  } catch { check(false, 'candidate respects declared paths and protected source'); }
  let replayed = false;
  const replayOutcomes = new Map(), records = result.executions?.[0]?.operations ?? [];
  check(records.length === operations.length && new Set(records.map(record => record.id)).size === records.length &&
    records.every(record => operations.some(operation => operation.id === record.id)), 'one execution status per dispatched operation');
  try {
    const backend = join(frozenBackendRoot, 'scripts');
    const [{ compile, transform, validateFileSyntax }, { focusedInput }, { parse }, { parseJson }] = await Promise.all([
      import(pathToFileURL(join(backend, 'changeset/engine.mjs')).href),
      import(pathToFileURL(join(backend, 'changeset-study/focused-editors.mjs')).href),
      import(pathToFileURL(join(backend, 'changeset-study/parser/acorn.mjs')).href),
      import(pathToFileURL(join(backend, 'changeset/models.mjs')).href),
    ]);
    const staged = { ...source };
    for (const operation of compile(expectedPlan)) {
      const attempts = requests.filter(request => request.operation_id === operation.id);
      const record = records.find(record => record.id === operation.id);
      const dependenciesPassed = operation.depends_on.every(id => replayOutcomes.get(id)?.status === 'passed');
      if (!dependenciesPassed) {
        check(attempts.length === 0 && record?.status === 'blocked' && same(record.dependencies, operation.depends_on),
          'failed dependencies block operation without dispatch');
        replayOutcomes.set(operation.id, { status: 'blocked', successful_attempts: [] });
        continue;
      }
      if (!attempts.length) {
        check(record?.status === 'failed' && typeof record.error === 'string' && record.error.length > 0,
          'unattempted operation cannot be recorded passed');
        replayOutcomes.set(operation.id, { status: 'unattempted', successful_attempts: [] });
        continue;
      }
      for (const dependency of operation.depends_on) {
        const reservation = replayOutcomes.get(dependency)?.successful_attempts[0];
        check(reservation && requests.findIndex(request => request.reservation === reservation) < requests.indexOf(attempts[0]) &&
          responses.findIndex(response => response.reservation === reservation) < responses.findIndex(response => response.reservation === attempts[0].reservation),
          'dependency final attempt precedes dependent request and response');
      }
      const successful = [];
      const context = Object.fromEntries([...new Set([...operation.reads, ...operation.writes])].map(path => [path, staged[path] ?? null]));
      const expected = focusedInput(operation, context, { parse });
      expected.file_state = Object.entries(context).map(([path, text]) => ({ path, writable: operation.writes.includes(path), exists: text !== null }));
      let localFailure = null;
      for (const [index, request] of attempts.entries()) {
        const input = packet(request), base = input && Object.fromEntries(Object.entries(input).filter(([key]) =>
          !['application_failure', 'rejected_edit_summary', 'rejected_response_excerpt'].includes(key)));
        check(same(base, expected), 'exact frozen/staged source excerpts and bounded assignment packet');
        if (index > 0) check(localFailure !== null && typeof input?.application_failure === 'string' && input.application_failure.startsWith(localFailure),
          'retry follows a reproduced decoded-format/application/syntax rejection, never transport');
        const origins = responses.filter(response => response.reservation === request.reservation && response.stage === 'editor');
        check(origins.length === 1, 'one retained response per writer request');
        const origin = origins[0];
        localFailure = null;
        if (!origin || origin.error || origin.response?.stopReason !== 'stop') continue;
        try {
          const text = origin.response.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          const value = parseJson(text);
          if (!Array.isArray(value?.edits) || !value.edits.length) throw new Error('Editor returned no edits');
          const changed = transform({ ...operation, edits: value.edits }, context);
          validateFileSyntax(changed);
          check(index === attempts.length - 1, 'successful application has no extra retry');
          successful.push(request.reservation);
          for (const [path, text] of Object.entries(changed)) { if (text === null) delete staged[path]; else staged[path] = text; }
        } catch (error) { localFailure = error.message.slice(0, 2000); }
      }
      const passed = successful.length === 1 && successful[0] === attempts.at(-1).reservation;
      check(passed ? record?.status === 'passed' && record.executor === operation.executor :
        record?.status === 'failed' && typeof record.error === 'string' && record.error.length > 0,
        'execution status matches one successful final application or a failed attempt');
      replayOutcomes.set(operation.id, { status: passed ? 'passed' : 'failed', successful_attempts: successful });
    }
    check(same(staged, candidate), 'retained responses reproduce the complete candidate from initial source');
    replayed = true;
  } catch { check(false, 'source replay using exact frozen parser and edit backend'); }
  const applicationComplete = replayed && operations.every(operation => replayOutcomes.get(operation.id)?.status === 'passed') && result.executions?.[0]?.ok === true && records.length === operations.length && new Set(records.map(record => record.id)).size === records.length &&
    records.every(record => operations.some(operation => operation.id === record.id && operation.executor === record.executor) && record.status === 'passed');
  const visible = result.checks?.at(-1)?.visible, candidateTests = visible?.candidate_tests ?? [];
  const delivered = applicationComplete && result.accepted === true && result.hidden_pass === true && visible?.ok === true &&
    candidateTests.every(test => test.ok === true) && !result.error && !result.grading_error;
  const valid = checks.every(item => item.ok);
  return { integrity_valid: valid, validation: checks, application_complete: applicationComplete, qualified_application: valid && applicationComplete,
    recorded_delivery_checks_pass: delivered, qualified_delivery_checks_pass: valid && delivered, independent_review_performed: false, source_replay_performed: replayed, replayed_operations: Object.fromEntries(replayOutcomes),
    downstream: { visible: visible?.ok ?? null, candidate_count: candidateTests.length, candidate_failed: candidateTests.filter(test => test.ok !== true).length,
      external: result.accepted ?? null, hidden_pass: result.hidden_pass ?? null },
    writer_calls: requests.length, retries: requests.filter(request => request.writer_attempt === 1).length,
    writing_seconds: (result.stages ?? []).filter(stage => stage.name === 'execution' || stage.name === 'optimization').reduce((sum, stage) => sum + stage.elapsed_ms, 0) / 1000,
    reported_usd: receipts.every(receipt => Number.isFinite(receipt.usage?.cost?.total)) ? receipts.reduce((sum, receipt) => sum + receipt.usage.cost.total, 0) : null,
    normalized_usd: receipts.every(receipt => usageKeys.every(key => Number.isFinite(receipt.usage?.[key]))) ?
      receipts.reduce((sum, receipt) => sum + (receipt.usage.input * 0.3 + receipt.usage.output * 1.2 + receipt.usage.cacheRead * 0.006 + receipt.usage.cacheWrite * 0.3) / 1e6, 0) : null,
    tokens: Object.fromEntries(usageKeys.map(key => [key, receipts.reduce((sum, receipt) => sum + (receipt.usage?.[key] ?? 0), 0)])),
    staged_context_hashes: requests.map(request => ({ operation_id: request.operation_id, writer_attempt: request.writer_attempt, context_hash: hash(JSON.stringify(request.context)) })) };
}
