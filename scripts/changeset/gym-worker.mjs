// Tool-free planner, bounded executors, and one batch-level impact/repair boundary.
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workspace, hash } from './workspace.mjs';
import { execute } from './engine.mjs';
import { runWorkflow } from './workflow.mjs';
import { routeWithAdvice } from './routing.mjs';
import { modelRuntime, Budget, completeJson, editorAdapter } from './models.mjs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const receipts = [], started = Date.now();
const save = value => writeFileSync(config.result, JSON.stringify(value, null, 2) + '\n');
const receipt = r => { receipts.push(r); appendFileSync(config.calls, JSON.stringify(r) + '\n'); };
try {
  const ws = Workspace.load(config.repo), runtime = await modelRuntime(), budget = new Budget(config.budget);
  const source = ws.snapshot(), contract = readFileSync(join(config.package, 'spec.md'), 'utf8'), plannerSystem = readFileSync(config.skill, 'utf8');
  const planned = await completeJson({ runtime, budget, selector: config.model, system: plannerSystem,
    prompt: JSON.stringify({ task: config.task, specification: contract, files: source }),
    maxTokens: config.execution.max_tokens ?? 16000, timeoutMs: Math.min(120000, config.timeout_ms), onReceipt: receipt,
  });
  writeFileSync(join(config.package, 'change-plan.json'), JSON.stringify(planned.value, null, 2) + '\n');
  const routed = routeWithAdvice(planned.value, config.advice);
  let repairRound = 0;
  const repairAdapter = config.execution.repair_model ? editorAdapter({ runtime, budget, selector: config.execution.repair_model, maxTokens: 16000, contract, timeoutMs: 120000, onReceipt: receipt }) : null;
  const initialAdapters = Object.fromEntries(['simple', 'involved'].map(tier => [tier, editorAdapter({ runtime, budget, selector: config.execution[tier + '_model'], maxTokens: 16000, contract, timeoutMs: 120000, onReceipt: receipt })]));
  const adapters = Object.fromEntries(['simple','involved'].map(tier => [tier, input => (repairRound && repairAdapter ? repairAdapter : initialAdapters[tier])(input)]));
  let report, workflow;
  if (config.execution.review_model) {
    const verify = staged => {
      const dir = mkdtempSync(join(tmpdir(), 'changeset-impact-'));
      try {
        staged.materialize(dir);
        for (const check of config.verification) execFileSync(process.execPath, [check.script, dir, config.package], { cwd: dir, timeout: check.timeout_ms, maxBuffer: 32768, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
        return true;
      } catch (error) {
        // Give the reviewer the failed observation, never the grader's source or location.
        return { ok: false, observation: String(error.stderr ?? error.message).replaceAll(/file:\/\/[^\s:)]+/g, '<module>').replaceAll(/\/[^\s:]*graders\/[^\s:]+/g, '<behavior-check>').slice(-6000) };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    const review = async ({ files, report: evidence, history, canRepair }) => {
      const result = await completeJson({ runtime, budget, selector: config.execution.review_model, maxTokens: 16000, timeoutMs: 120000, onReceipt: receipt,
        system: `Evaluate the integrated implementation's observable behavior against the original task contract and supplied execution evidence. Inspect the whole candidate and collect all concrete violations in one review, including when the supplied check stopped at its first failure. Prior successful work is recorded in history and need not be replayed. Identify concrete requirement violations, not stylistic improvements. Do not invent requirements. Return only JSON {"accepted":true|false,"findings":[{"path":"relative path","reason":"concrete failure"}],"repair_plan":null|PLAN}. Accept only if evidence.ok is true and source behavior satisfies the task. If a repair is allowed and needed, provide a minimal executable plan against the supplied CURRENT files; preserve successful work and include missing/blocked work. The plan schema follows:\n${plannerSystem}`,
        prompt: JSON.stringify({ task_contract: contract, files, evidence, history, repair_allowed: canRepair }),
      });
      return result.value;
    };
    workflow = await runWorkflow(routed.plan, ws, { adapters, concurrency: config.execution.concurrency, verify, review, maxRepairs: config.execution.max_repairs ?? 1,
      onDraft: (draft, round) => writeFileSync(join(dirname(config.result), `draft-round-${round}.json`), JSON.stringify(draft, null, 2) + '\n'),
      onPlan: (plan, round) => { repairRound = round; if (round) writeFileSync(join(config.package, `repair-plan-${round}.json`), JSON.stringify(plan, null, 2) + '\n'); },
    });
    report = workflow.rounds.at(-1)?.report;
  } else report = await execute(routed.plan, ws, { concurrency: config.execution.concurrency, adapters });
  const ok = workflow?.ok ?? report.ok;
  if (ok) ws.publish();
  save({ outcome: ok ? 'finished' : 'failed', report, workflow, routing: routed.decisions, receipts, elapsed_ms: Date.now() - started, source_sha256: hash(JSON.stringify(source)) });
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: ok ? 'Changes applied.' : 'Changeset execution failed.' }] } }));
} catch (error) {
  save({ outcome: 'failed', error: error.message, receipts, elapsed_ms: Date.now() - started });
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Execution exception recorded.' }] } }));
}
