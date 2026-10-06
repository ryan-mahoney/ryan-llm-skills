import { Type } from '@earendil-works/pi-ai';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Runtime, loadRun, summary, assertLease, runEditor, runCommand, runVerification, runAdvice, event as runtimeEvent } from './runtime.mjs';
import { createCommunication } from './communication.mjs';
import { createMonitor } from './monitor.mjs';
import { createScout, SCOUT_MODEL } from './scout.mjs';
import { metrics, formatMetrics } from './metrics.mjs';

const result = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value, isError });
const optional = (description: string) => Type.Optional(Type.String({ description }));

export default function (pi: any) {
  const role = process.env.SPEC_RUNTIME_ROLE;
  if (role) {
    const record = JSON.parse(readFileSync(process.env.SPEC_RUNTIME_RECORD!, 'utf8'));
    const communication = createCommunication(pi, record, role, { onEvent: (name: string, detail: any) => runtimeEvent(record, name, detail) });
    const allowed = role === 'owner' ? ['read', 'grep', 'find', 'ls', 'spec_editor', 'spec_answer', 'spec_verify', 'spec_scout', 'spec_advice'] : ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'spec_question'];
    pi.on('session_shutdown', () => communication.close());
    pi.on('session_start', () => pi.setActiveTools(allowed));
    pi.on('tool_call', (event: any) => {
      try {
        assertLease(record);
        if (!allowed.includes(event.toolName)) return { block: true, reason: 'This tool is outside the managed worker role.' };
        if (['bash', 'spec_verify'].includes(event.toolName) && /\bgit\s+(?:-[^\s]+\s+)*reset\s+--hard\b/.test(event.input.command)) return { block: true, reason: 'Hard resets are not allowed in a managed step. Return the recovery decision to the coordinator.' };
        if (event.toolName === 'spec_verify' && /\bgit\s+(?:-[^\s]+\s+)*reset\s+--hard\b/.test(event.input.server?.command || '')) return { block: true, reason: 'Hard resets are not allowed in managed server commands.' };
      } catch (error: any) { return { block: true, reason: error.message }; }
    });
    if (role === 'owner') {
      pi.registerTool({ name: 'spec_advice', label: 'Jev advice', description: 'Batch Jev verification scheduling before expensive/repeated checks, or triage actionable review findings. Uses the assigned checkout after the editor returns. Supply the version 1 input from ~/.agents/scripts/jev/README.md: change_summary, policy, acceptance_criteria, mandatory_gates, focused_checks/planned_ci_checks, evidence or findings. No shell JSON construction or editor handoff needed. Advisory only; never waives acceptance or certifies passes. Reuse a still-applicable decision; do not call per edit or retry uncertain advice unchanged.',
        parameters: Type.Object({ task: Type.Union([Type.Literal('verification'), Type.Literal('review-triage')]), input: Type.Object({}, { additionalProperties: true }), offline: Type.Optional(Type.Boolean()) }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { return result(await runAdvice(record, args.task, args.input, { offline: args.offline, signal })); }
          catch (error: any) { return result({ error: error.message, fallback: 'main_agent_judgment' }, true); }
        } });
      const scout = createScout(pi.events, { ownerRunId: record.id, cwd: record.checkout, model: record.scout_model || SCOUT_MODEL });
      pi.on('session_shutdown', () => scout.close());
      pi.registerTool({ name: 'spec_scout', label: 'Scout source', description: 'Use the installed scout profile to trace an unfamiliar failing path, find an existing integration pattern, or locate affected callers/guards. Supply one decision-relevant question, scoped paths and known evidence; ask for supporting snippets and the first unresolved boundary. No edits, checks or repair decisions. Direct reads are faster for a known small region; scouting is optional.',
        parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 6000 }) }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try {
            assertLease(record);
            const reply: any = await scout.run(args.task, signal);
            const path = join(record.package, 'runtime/runs', `${record.id}-scout-${randomUUID()}.txt`);
            writeFileSync(path, reply.result, { mode: 0o600 });
            const truncated = reply.result.length > 8000;
            return result({ ...reply, result: truncated ? reply.result.slice(0, 7000) + `\n[Truncated: read ${path}; do not repeat scouting.]` : reply.result, result_truncated: truncated, full_result_path: path });
          } catch (error: any) { return result({ error: error.message, next: 'Use direct source reads or diagnose this scout failure; do not switch models.' }, true); }
        } });
      pi.registerTool({ name: 'spec_verify', label: 'Verify step', description: 'Owner runs a necessary focused check or diagnostic after the editor returns. Never edit source, commit, or run broad suites through this tool. Reuse valid evidence; do not check every packet automatically. Commands are bounded and cannot overlap editor work. Build/test artifacts and canonical evidence output are allowed. Pipelines preserve failures; raw output is retained, so omit tail/tee wrappers. For UI capture supply server {command, ready_url, readiness_timeout}: runtime starts it, waits, runs command, and cleans up before returning. Never start a server in a separate background call.',
        parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })), server: Type.Optional(Type.Object({ command: Type.String({ description: 'Foreground dev server command; no nohup or background ampersand. Runtime owns startup and cleanup.' }), ready_url: Type.String({ description: 'Loopback HTTP(S) readiness URL on an owned free port' }), readiness_timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })) })) }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { const reply = await runVerification(record, args.command, args.timeout, signal, args.server); return result(reply, Boolean(reply.error) || reply.exit_code !== 0); }
          catch (error: any) { return result({ error: error.message }, true); }
        } });
      pi.registerTool({ name: 'spec_editor', label: 'Spec editor', description: 'Apply a bounded transformation whose behavior and architectural approach the owner has chosen; let the editor choose local implementation details. Send a Change/Edits/Preserve/Return packet with named symbols and concrete operations. The owner reads/searches source directly; reserve facts-only requests for a blocking fact unavailable through those tools. Return a compact result and artifact paths. The editor does not run verification; the owner uses spec_verify after the return. Do not delegate whole-step design or open-ended repair. Assess the return before the next assignment; commit is separate. No polling.',
        parameters: Type.Object({ assignment: Type.String() }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { const reply = await communication.beginEditor(() => runEditor(record, args.assignment, signal), signal); return result(reply, Boolean(reply.error)); }
          catch (error: any) { return result({ error: error.message, ...(signal?.aborted ? { requires_cancellation: true } : {}), next: 'resolve this failure; do not start an unmanaged replacement' }, true); }
        } });
      pi.registerTool({ name: 'spec_answer', label: 'Answer editor', description: 'Answer the retained editor\'s pending decision and await the same editor process. Do not start a replacement editor.',
        parameters: Type.Object({ request_id: Type.String(), answer: Type.String() }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { const reply = await communication.answer(args.request_id, args.answer, signal); return result(reply, Boolean(reply.error)); }
          catch (error: any) { return result({ error: error.message, ...(signal?.aborted ? { requires_cancellation: true } : {}), next: 'resolve the pending editor question without launching another writer' }, true); }
        } });
    } else {
      pi.registerTool({ name: 'spec_question', label: 'Ask step owner', description: 'Ask the current step owner one concrete implementation decision. Wait for its answer in this same editor process. Include relevant source excerpts or diagnostics; do not contact other sessions.',
        parameters: Type.Object({ question: Type.String() }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          try { return result(await communication.question(args.question, signal)); }
          catch (error: any) { return result({ error: error.message, next: 'return the unresolved decision to the owner; do not assume permission or launch another agent' }, true); }
        } });
      pi.registerTool({ name: 'bash', label: 'Managed bash', description: 'Run a bounded foreground editing, formatting or explicitly assigned commit command in the code checkout. Do not run tests, compile/build checks, lint or other verification; the owner runs those after your return. Do not leave background or detached processes alive after it returns. Large output is saved to the run log.',
        parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })) }),
        async execute(_id: string, args: any, signal: AbortSignal) {
          const reply = await runCommand(record, args.command, args.timeout, signal);
          return result(reply, Boolean(reply.error) || reply.exit_code !== 0);
        } });
    }
    return;
  }
  const monitor = createMonitor();
  pi.registerCommand('spec-metrics', {
    description: 'Read-only timing, model/tool calls, test submissions and cost: /spec-metrics /absolute/canonical/package',
    handler: async (args: string, ctx: any) => {
      try {
        const packagePath = args.trim();
        if (!packagePath) { ctx.ui.notify('Usage: /spec-metrics /absolute/repo/.specs/feature', 'info'); return; }
        const value = await metrics(packagePath);
        ctx.ui.notify(formatMetrics(value), 'info');
      } catch (error: any) { ctx.ui.notify(`Metrics unavailable: ${error.message}`, 'error'); }
    },
  });
  pi.on('session_start', (_event: any, ctx: any) => {
    monitor.close();
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const message = entries[i].message;
      if (message?.role !== 'toolResult' || message.toolName !== 'spec_dispatch') continue;
      const receipt = message.details;
      if (!receipt?.package || !receipt.run_id) continue;
      try { monitor.attach(loadRun(receipt.package, receipt.run_id), ctx); } catch { /* Missing historical record. */ }
      break;
    }
  });
  pi.registerCommand('spec-monitor', {
    description: 'Observe a canonical spec package without taking ownership: /spec-monitor /repo/.specs/feature; /spec-monitor off hides it.',
    handler: async (args: string, ctx: any) => {
      const path = args.trim();
      if (path === 'off' || path === 'hide') { monitor.close(); return; }
      try { monitor.attach(loadRun(path), ctx); }
      catch { ctx.ui.notify('Cannot open that package runtime receipt. Use /spec-monitor /absolute/repo/.specs/feature', 'error'); }
    },
  });
  const runtime = new Runtime({ notify: (value: any) => pi.sendMessage({ customType: 'spec-runtime', content: JSON.stringify(value), display: true }, { triggerTurn: true }) });
  pi.on('session_shutdown', async () => {
    monitor.close();
    await Promise.allSettled([...runtime.active.values()].map(({ record }: any) => runtime.cancel(record.package, record.id)));
  });
  pi.registerTool({ name: 'spec_dispatch', label: 'Spec step runtime', description: 'Use startup to enter a prepared package in one call: first-step selection, recorded difficulty routing, checkout/lease setup and dispatch; existing progress returns a resume obligation without replay. Start launches an explicit prepared spec step with an owner and retained editor. Creates/reuses the checkout, holds its exclusive writer lease, and delivers a completion event. Repeated assignment IDs are idempotent. Status is for explicit recovery, never polling. Cancellation returns only after confirmed process-group termination.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('startup'), Type.Literal('start'), Type.Literal('status'), Type.Literal('cancel')]), package: Type.String({ description: 'Absolute canonical .specs feature directory or its spec.md in the primary checkout' }),
      strong_owner_model: optional('Optional STRONG_OWNER; startup routes prepared hard steps here'), owner_override: optional('Explicit owner for the selected step; takes precedence over owner_model in start and startup, including tier routing'),
      step: optional('Absolute canonical prepared subspec path; required for start'), owner_model: optional('provider/model[:thinking]; required unless owner_override is supplied'), editor_model: optional('provider/model[:thinking]; required for start'), scout_model: optional('SCOUT_AGENT selector as provider/model[:thinking]; default openai-codex/gpt-6-luna:low'),
      checkout: optional('Existing checkout or desired new worktree path'), branch: optional('Requested worktree branch'), base: optional('Start ref for a new branch, default HEAD'),
      assignment_id: optional('Stable ID for this step attempt. Omit to use step path. Use a new ID only for an intentional subsequent attempt.'), run_id: optional('Existing run ID, otherwise latest'),
      instructions: optional('Scoped task direction, acceptance constraints and publication authority'), timeout_ms: Type.Optional(Type.Number({ minimum: 1000, maximum: 86400000, description: 'Whole assignment deadline, default 7200000 (2 hours)' })), child_extensions: Type.Optional(Type.Array(Type.String({ description: 'Explicit trusted pi-intercom and provider/compat extension paths; discovery is disabled in managed children' }))) }),
    async execute(_id: string, args: any, _signal: AbortSignal, _update: any, ctx: any) {
      try {
        if (args.action === 'status') { const record = loadRun(args.package, args.run_id); monitor.attach(record, ctx); return result(summary(record)); }
        if (args.action === 'cancel') return result(await runtime.cancel(args.package, args.run_id));
        const configFile = join(homedir(), '.pi/agent/spec-runtime.json');
        const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
        const input = { ...args, scout_model: args.scout_model ?? config.scout_model ?? SCOUT_MODEL, child_extensions: args.child_extensions ?? config.child_extensions ?? [] };
        const receipt = args.action === 'startup' ? await runtime.startup(input, ctx.sessionManager.getSessionFile()) : runtime.start(input, ctx.sessionManager.getSessionFile());
        if (receipt.run_id) monitor.attach(loadRun(args.package, receipt.run_id), ctx);
        return result(receipt);
      } catch (error: any) { return result({ error: error.message, next: 'correct this specific runtime error; do not probe unrelated models or launch another writer' }, true); }
    } });
}
