import { hash, read, rows, packet, same } from '../writer-control/support.mjs';
import { join } from 'node:path';
export function auditEvidence(directory, job, result) {
  const requests = rows(join(directory, 'requests.jsonl')), receipts = rows(join(directory, 'receipts.jsonl')), responses = rows(join(directory, 'responses.jsonl'));
  const errors = [];
  const reject = (valid, message) => { if (!valid) errors.push(message); };
  reject(result.task_hash === hash(JSON.stringify(job.task)) && result.selector === job.selector, 'Task or selector identity differs');
  reject(requests.length === receipts.length && requests.length === responses.length && result.model_calls === requests.length, 'Call evidence counts differ');
  reject(new Set(requests.map(row => row.reservation)).size === requests.length, 'Duplicate request reservation');
  reject(new Set(receipts.map(row => row.reservation)).size === receipts.length && new Set(responses.map(row => row.reservation)).size === responses.length, 'Duplicate response/receipt reservation');
  let plan;
  if (job.mode === 'execute') {
    plan = read(join(job.preparation_directory, 'plan.json'));
    reject(result.plan_hash === hash(JSON.stringify(plan)), 'Prepared plan identity differs');
    if (result.execution) {
      reject(result.execution.plan_sha256 === result.plan_hash, 'Execution plan identity differs');
      const records = result.execution.operations ?? [];
      reject(records.length === plan.operations.length && new Set(records.map(row => row.id)).size === records.length && records.every(row => plan.operations.some(operation => operation.id === row.id && operation.executor === row.executor)), 'Execution operation records differ');
    }
    if (result.candidate_hash) reject(hash(JSON.stringify(read(join(directory, 'candidate.json')))) === result.candidate_hash, 'Candidate identity differs');
  }
  const attempts = new Map();
  for (const request of requests) {
    const receipt = receipts.find(row => row.reservation === request.reservation), response = responses.find(row => row.reservation === request.reservation);
    const expectedStage = job.mode === 'plan' ? 'implementation-planning' : 'editor';
    reject(request.selector === job.selector && receipt?.selector === job.selector && request.stage === expectedStage && receipt?.stage === expectedStage && response?.stage === expectedStage, 'Unexpected model or stage');
    reject(same(receipt?.usage, response?.response?.usage ?? null) && receipt?.stop_reason === (response?.response?.stopReason ?? 'exception') && receipt?.error === (response?.error ?? response?.response?.errorMessage ?? null), 'Receipt/response outcome differs');
    if (job.mode === 'execute') {
      const operation = plan.operations.find(operation => operation.id === request.operation_id), input = packet(request), prior = attempts.get(request.operation_id) ?? [];
      reject(job.representation === 'delegated' && !!operation && [0, 1].includes(request.writer_attempt) && request.writer_attempt === prior.length &&
        receipt?.operation_id === request.operation_id && receipt?.writer_attempt === request.writer_attempt, 'Invalid writer assignment/attempt metadata');
      reject(!!operation && input?.objective === operation.objective && same(input?.writes, operation.writes), 'Writer packet does not belong to assigned operation');
      if (request.writer_attempt === 1) reject(prior.length === 1 && typeof input?.application_failure === 'string' && input.application_failure.length > 0, 'Retry lacks local failure context');
      prior.push(request); attempts.set(request.operation_id, prior);
    }
  }
  reject(job.mode !== 'plan' || requests.length <= 3, 'Planning cap exceeded');
  reject(requests.length <= result.limits?.model_calls, 'Original remaining call allowance exceeded');
  if (job.mode === 'execute' && job.representation === 'executable') reject(requests.length === 0, 'Self execution called a separate writer');
  return { valid: errors.length === 0, errors, requests: requests.length };
}
