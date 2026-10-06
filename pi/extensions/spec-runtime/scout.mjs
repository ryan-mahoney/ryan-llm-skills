import { randomUUID } from 'node:crypto';

// pi-subagents/delegation's public owned-leaf event contract. The installed package
// owns agent resolution, tools, the foreground session, timeout and cancellation.
export const SCOUT_MODEL = 'openai-codex/gpt-6-luna:low';
const REQUEST = 'prompt-template:subagent:request';
const STARTED = 'prompt-template:subagent:started';
const RESPONSE = 'prompt-template:subagent:response';
const CANCEL = 'prompt-template:subagent:cancel';

export function createOwnedLeaf(events, {
  ownerRunId, nodeId, agent, cwd, model,
  timeoutMs = 120000, readyMs = 5000,
  toolBudget, skill, artifacts,
  context = 'fresh', intercomBridge = { mode: 'off' }, result = { kind: 'text' },
  brief = task => task, maxTaskLength = 6000, label = 'Owned leaf',
}) {
  let active, closed = false;
  return {
    run(task, signal) {
      if (closed) return Promise.reject(new Error(`${label} channel is closed.`));
      if (active) return Promise.reject(new Error(`A ${label.toLowerCase()} is already active; await its result.`));
      if (typeof task !== 'string' || !task.trim() || task.length > maxTaskLength) return Promise.reject(new Error(`${label} brief must contain 1–${maxTaskLength} characters.`));
      if (signal?.aborted) return Promise.reject(new Error(`${label} request aborted.`));
      const identity = { requestId: randomUUID(), ownerRunId, nodeId };
      const matches = value => value?.requestId === identity.requestId && value.ownerRunId === ownerRunId && value.nodeId === identity.nodeId;
      const suffix = model.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
      return new Promise((resolve, reject) => {
        let settled = false, readyTimer, deadline;
        const cleanup = () => {
          offStarted(); offResponse(); clearTimeout(readyTimer); clearTimeout(deadline);
          signal?.removeEventListener('abort', abort); active = undefined;
        };
        const cancel = reason => {
          if (settled) return;
          settled = true;
          // Dispose listeners first: a synchronous cancellation reply must not win.
          cleanup();
          events.emit(CANCEL, identity);
          reject(new Error(reason));
        };
        const abort = () => cancel(`${label} request aborted.`);
        const offStarted = events.on(STARTED, value => { if (matches(value)) clearTimeout(readyTimer); });
        const offResponse = events.on(RESPONSE, value => {
          if (!matches(value) || settled) return;
          settled = true; cleanup();
          if (value.status !== 'completed' || value.result?.kind !== 'text') {
            reject(new Error(value.error || `${label} did not complete: ${value.status}`)); return;
          }
          resolve({ result: value.result.text, run_id: value.runId, model: value.model, thinking: value.thinking, usage: value.usage });
        });
        active = { cancel };
        readyTimer = setTimeout(() => cancel(`pi-subagents did not accept the ${label.toLowerCase()} request; abstain and diagnose its extension.`), readyMs);
        deadline = setTimeout(() => cancel(`${label} deadline reached; no findings accepted.`), timeoutMs + 1000);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          events.emit(REQUEST, { ...identity, agent, context, cwd,
            model: suffix ? model.slice(0, -suffix[0].length) : model,
            ...(suffix ? { thinking: suffix[1] } : {}), timeoutMs,
            ...(toolBudget ? { toolBudget } : {}),
            ...(skill !== undefined ? { skill } : {}),
            ...(artifacts !== undefined ? { artifacts } : {}),
            intercomBridge, result, task: brief(task) });
        } catch (error) { cancel(error.message); }
      });
    },
    close() { closed = true; active?.cancel(`${label} channel closed.`); },
  };
}

export function createScout(events, { ownerRunId, cwd, model = SCOUT_MODEL, timeoutMs = 120000, readyMs = 5000 }) {
  const leaf = createOwnedLeaf(events, {
    ownerRunId, nodeId: 'scout', agent: 'scout', label: 'Scout', model, cwd, timeoutMs, readyMs,
    brief: task => `${task}\n\nDiscovery only: use read/search tools, no edits or checks. Return at most 3000 characters with paths, symbols, short exact excerpts, searched scope and uncertainties. For diagnosis, distinguish supplied runtime observations from source inference and identify the first unobserved boundary; do not invent a root cause. Stop when this question is answered; do not repeat already supplied evidence.`,
  });
  return { run: leaf.run, close: leaf.close };
}
