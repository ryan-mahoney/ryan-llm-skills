// EV-13 wave-native harness (D-29 packet 4): the loopback provider and the child
// extension that points real Pi workers at it. Both sit at the true provider
// boundary: real Pi speaks HTTP/SSE to this server and no production module is
// patched. The coordinator-route registration belongs to the later driver
// packet; this module only serves the wire protocol and the generated extension.
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SELF_URL = import.meta.url;

const LOOPBACK_EXTENSION_FILE = 'wave-loopback-extension.mjs';
const BARRIER_DEADLINE_MS = 120000;
const PROVIDER = 'wave-loopback';
const MODEL = 'scripted';
const SELECTOR = `${PROVIDER}/${MODEL}`;

const pad2 = value => String(value).padStart(2, '0');

function stepNumber(record) {
  if (record && Number.isInteger(record.step_number)) return record.step_number;
  const match = /step-(\d+)-subspec\.md$/.exec(String(record?.step ?? ''));
  return match ? Number(match[1]) : null;
}

function partText(part) {
  if (typeof part === 'string') return part;
  if (part && typeof part.text === 'string') return part.text;
  return '';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partText).join('\n');
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function messageText(message) {
  return contentText(message?.content);
}

function lastToolResult(body) {
  const messages = body?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'tool' || message?.role === 'tool_result') return message;
  }
  return null;
}

function lastAssistantToolCall(body) {
  const messages = body?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      return message.tool_calls[message.tool_calls.length - 1];
    }
  }
  return null;
}

function promptText(body) {
  const messages = body?.messages ?? [];
  return messages
    .filter(message => message?.role === 'user' || message?.role === 'system')
    .map(messageText)
    .join('\n');
}

function toolResultText(body) {
  return messageText(lastToolResult(body));
}

function toolReply(name, args, finishReason = 'tool_calls') {
  return { tool_calls: [{ type: 'function', function: { name, arguments: JSON.stringify(args) } }], finish_reason: finishReason };
}

function textReply(text, finishReason = 'stop') {
  return { text, finish_reason: finishReason };
}

function packageRef(script) {
  return script.ref ?? script.fixture?.ref;
}

function dispatchArgs(script, execution) {
  const mode = script.mode ?? 'ordinary';
  const args = {
    action: 'startup',
    package: packageRef(script),
    execution,
    isolation: 'auto',
    owner_model: SELECTOR,
    editor_model: SELECTOR,
    review_model: SELECTOR,
    fix_model_override: SELECTOR,
    timeout_ms: 600000,
  };
  if (mode !== 'restart' && mode !== 'repeated-entry' && mode !== 'multi-target') {
    args.workflow_id = `wave-native-${script.case}`;
  }
  return args;
}

function checkpointArgs(script, revision) {
  return {
    package: packageRef(script),
    workflow_id: `wave-native-${script.case}`,
    expected_revision: revision,
    state: 'ready',
    workers: [],
    obligation: { key: 'wave-implementation', stage: 'implementation', summary: 'Wave implementation in progress', artifacts: [{ path: 'spec-steps.json' }] },
    reconciles_input_revision: 1,
  };
}

function workflowArgs(script) {
  return {
    package: packageRef(script),
    workflow_id: `wave-native-${script.case}`,
    objective: 'Run the prepared package to integration; no publication.',
    completion_stage: 'implementation',
  };
}

function coordinatorReply({ turn, body, script }) {
  const mode = script.mode ?? 'ordinary';
  if (mode === 'restart' || mode === 'repeated-entry') {
    return turn === 0 ? toolReply('spec_dispatch', dispatchArgs(script, 'auto')) : textReply('Waiting.');
  }
  if (mode === 'multi-target') {
    if (turn === 0) return toolReply('spec_dispatch', dispatchArgs(script, 'waves'));
    if (turn === 1) return toolReply('spec_dispatch', dispatchArgs(script, 'auto'));
    return textReply('Waiting.');
  }
  if (turn === 0) return toolReply('spec_sentinel_checkpoint', checkpointArgs(script, 0));
  const lastCall = lastAssistantToolCall(body);
  if (lastCall?.function?.name === 'spec_sentinel_checkpoint') {
    const match = /current native input revision (\d+)/.exec(toolResultText(body));
    return match
      ? toolReply('spec_sentinel_checkpoint', checkpointArgs(script, Number(match[1])))
      : toolReply('spec_workflow', workflowArgs(script));
  }
  if (lastCall?.function?.name === 'spec_workflow') return toolReply('spec_dispatch', dispatchArgs(script, 'auto'));
  return textReply('Waiting.');
}

function ownerReply({ turn, body, record, script }) {
  if (record?.wave_id === undefined || record?.wave_id === null) return textReply('No changes.');
  const step = stepNumber(record);
  const nn = pad2(step);
  if (turn === 0) {
    const content = step === script.defectStep ? `step ${nn} implemented-defect` : `step ${nn} implemented`;
    return toolReply('spec_editor', { assignment: `Change: write src/step-${nn}.txt with '${content}' and a newline, then commit it` });
  }
  if (turn === 1) {
    if (step === script.lengthStopStep) return textReply('Partial implementation.', 'length');
    // The verify command writes the check's own stdout to the fixture evidence
    // artifact (directory created by fixture creation). Redirection keeps the
    // command's exit status, so the spec_verify receipt stays authoritative.
    const packagePath = script.fixture?.packagePath ?? script.packagePath ?? null;
    const command = packagePath
      ? `node checks/fixture-check.mjs > ${JSON.stringify(join(packagePath, 'evidence', `fixture-check-${nn}.txt`))}`
      : 'node checks/fixture-check.mjs';
    return toolReply('spec_verify', { command, timeout: 60 });
  }
  if (turn === 2) {
    const receipt = /receipt_id["']?\s*[:=]\s*["']?([\w:-]+)/i.exec(toolResultText(body))?.[1] ?? null;
    return toolReply('spec_complete', {
      outcome: 'as-specified', strategy: 'implementation-first', decisions: [], gaps: [], findings: [], introduced: [],
      evidence: [{ id: `EV-${step}`, status: 'passed', proof_boundary: 'fixture check', receipt_id: receipt }],
    });
  }
  return textReply('Waiting.');
}

function isDepWriter(script, step) {
  if (script.depWriter === undefined || script.depWriter === null || script.depWriter === false) return false;
  if (script.depWriter === true) return step === 2;
  return Number(script.depWriter) === step;
}

function editorReply({ turn, record, script }) {
  const step = stepNumber(record);
  const nn = pad2(step);
  if (turn === 0) {
    const content = step === script.defectStep ? `step ${nn} implemented-defect` : `step ${nn} implemented`;
    return toolReply('write', { path: `src/step-${nn}.txt`, content: `${content}\n` });
  }
  if (turn === 1) {
    if (step === script.lengthStopStep) return textReply('Skipped the commit at the length stop.');
    let command = `git add src/step-${nn}.txt && git commit -qm 'step ${nn}'`;
    if (isDepWriter(script, step)) command += ' && printf mutated >> node_modules/fixture-dep/version.txt';
    return toolReply('bash', { command });
  }
  return textReply('Done.');
}

function reviewerReply({ turn, body, record, script }) {
  const step = stepNumber(record);
  if (record?.phase === 'confirming') {
    if (turn > 0) return textReply('Confirmed.');
    const path = /CONFIRM:[^\n]*fixed decision in (\S+)/.exec(promptText(body))?.[1] ?? null;
    return toolReply('spec_stage_complete', {
      verdict: 'pass', findings: [],
      fix_verdicts: [{ fix: path, id: 'F1', verdict: 'resolved', evidence: 'step 02 fixed' }],
      limitations: [],
    });
  }
  if (step === script.missingReviewStep) return textReply('Looks fine.');
  if (step === script.defectStep) {
    if (turn === 0) return toolReply('write', { path: 'src/hack.txt', content: 'x' });
    if (turn === 1) {
      const head = /REVIEW:[^\n]*head=([0-9a-f]{40})/.exec(promptText(body))?.[1] ?? null;
      const nn = pad2(step);
      return toolReply('spec_stage_complete', {
        verdict: 'needs-fix', fix_verdicts: [], limitations: [],
        findings: [{ id: 'F1', severity: 'MED', category: 'correctness', actionable: true, file: `src/step-${nn}.txt`, line: 1, symbol: `step-${nn}`, signature: 'correctness:fixture-defect', explanation: 'implemented-defect marker', commit: head }],
      });
    }
    return textReply('Waiting.');
  }
  if (turn > 0) return textReply('Review complete.');
  return toolReply('spec_stage_complete', { verdict: 'pass', findings: [], fix_verdicts: [], limitations: [] });
}

function fixerReply({ turn, body, record }) {
  const step = stepNumber(record) ?? 2;
  const nn = pad2(step);
  if (turn === 0) return toolReply('write', { path: `src/step-${nn}.txt`, content: `step ${nn} fixed\n` });
  if (turn === 1) return toolReply('bash', { command: `git add src/step-${nn}.txt && git commit -qm 'fix step ${nn}' && git rev-parse HEAD` });
  if (turn === 2) {
    const sha = /[0-9a-f]{40}/.exec(toolResultText(body))?.[0] ?? null;
    return toolReply('spec_stage_complete', {
      commits: [sha],
      decisions: [{ id: 'F1', decision: 'fixed', signature: 'correctness:fixture-defect', note: 'replaced marker' }],
      evidence: [], unresolved: [], triage: { summary: 'fixture triage', fallback: true },
    });
  }
  return textReply('Waiting.');
}

function computeReply({ role, turn, body, record, script }) {
  switch (role) {
    case 'coordinator': return coordinatorReply({ turn, body, script });
    case 'owner': return ownerReply({ turn, body, record, script });
    case 'editor': return editorReply({ turn, record, script });
    case 'reviewer': return reviewerReply({ turn, body, record, script });
    case 'fixer': return fixerReply({ turn, body, record });
    default: return null;
  }
}

function decodeRoute(url) {
  let pathname;
  try {
    pathname = new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 6 || parts[0] !== 'v1' || parts[4] !== 'chat' || parts[5] !== 'completions') return null;
  const pid = Number(parts[3]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const recordPath = parts[2] === '-' ? '-' : decodeURIComponent(parts[2]);
  return { role: parts[1], recordPath, pid };
}

function recordProjection(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const bindings = raw.wave_bindings ?? null;
  return {
    ...raw,
    wave_id: bindings?.wave_id ?? raw.wave_id,
    step_number: bindings?.step_number ?? raw.step_number,
    phase: bindings?.phase ?? raw.phase,
  };
}

function readRecord(recordPath) {
  if (!recordPath || recordPath === '-') return null;
  try {
    return recordProjection(JSON.parse(readFileSync(recordPath, 'utf8')));
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// D-29: the child extension observes the SDK context by writing the received
// messages unchanged to a per-process sidecar the loopback server reads. It is a
// pure observer: it never synthesizes or rewrites a marker and returns nothing.
export function registerSdkContextObserver(pi, recordPath, pid = process.pid) {
  if (!pi || typeof pi.on !== 'function') throw new Error('registerSdkContextObserver requires a pi extension API');
  if (typeof recordPath !== 'string' || recordPath === '') throw new Error('registerSdkContextObserver requires a record path');
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('registerSdkContextObserver requires a positive pid');
  const sidecarPath = `${recordPath}.sdk-context-${pid}.json`;
  pi.on('context', event => {
    try {
      writeFileSync(sidecarPath, JSON.stringify({ pid, recordPath, messages: event?.messages ?? [] }), { mode: 0o600 });
    } catch { /* observation must never break the worker turn */ }
    return undefined;
  });
  return sidecarPath;
}

export function sdkContextSidecarPath(recordPath, pid) {
  return `${recordPath}.sdk-context-${pid}.json`;
}

function extensionSource(port) {
  return [
    '// Generated by wave-native-provider.mjs writeLoopbackExtension (EV-13).',
    '// Real Pi loads this as a child extension and registers the loopback provider.',
    `import { registerSdkContextObserver } from ${JSON.stringify(SELF_URL)};`,
    '',
    'export default function registerWaveLoopbackProvider(pi) {',
    '  const role = process.env.SPEC_RUNTIME_ROLE;',
    '  const record = process.env.SPEC_RUNTIME_RECORD;',
    "  if (!role) throw new Error('wave-loopback: SPEC_RUNTIME_ROLE is required');",
    "  if (!record) throw new Error('wave-loopback: SPEC_RUNTIME_RECORD is required');",
    `  const baseUrl = 'http://127.0.0.1:${port}/v1/' + encodeURIComponent(role) + '/' + encodeURIComponent(record) + '/' + process.pid;`,
    `  pi.registerProvider('${PROVIDER}', {`,
    "    api: 'openai-completions',",
    '    baseUrl,',
    "    apiKey: 'local-fixture',",
    `    models: [{ id: '${MODEL}', name: 'Wave loopback scripted', reasoning: false, input: ['text'], contextWindow: 1048576, maxTokens: 65536, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],`,
    '  });',
    '  registerSdkContextObserver(pi, record, process.pid);',
    '}',
    '',
  ].join('\n');
}

// D-5: emit the deterministic child extension that redirects real Pi at the
// loopback server. The port is baked into the file; there is no env bypass, and
// a missing run identity throws instead of registering a wildcard route.
export function writeLoopbackExtension(dir, port) {
  if (typeof dir !== 'string' || dir === '') throw new Error('writeLoopbackExtension requires a directory');
  if (!Number.isInteger(port) || port <= 0) throw new Error('writeLoopbackExtension requires the loopback port');
  const path = join(dir, LOOPBACK_EXTENSION_FILE);
  writeFileSync(path, extensionSource(port));
  return path;
}

// D-8: hold the first turn-0 requests of an armed group until n are held. The
// response bodies come from computeReply; the group is identified by the run
// phase (implementing owners, reviewing reviewers).
function barrierGroup(role, phase) {
  if (role === 'owner' && phase === 'implementing') return 'implementing';
  if (role === 'reviewer' && phase === 'reviewing') return 'reviewing';
  return null;
}

export async function startLoopbackProvider(options = {}) {
  const script = options.script ?? {};
  const requests = [];
  const violations = [];
  const barriers = new Map();
  const depWaiters = [];
  let depGateOpen = false;
  let chunkId = 0;

  const barrierState = group => {
    let state = barriers.get(group);
    if (!state) {
      state = { n: 0, armed: false, released: false, reached: false, held: [], waiters: [] };
      barriers.set(group, state);
    }
    return state;
  };

  const describeHeld = state => state.held
    .map(entry => `${entry.route.role}:${stepNumber(entry.route.record) ?? '?'}:pid${entry.route.pid}`)
    .join(', ');

  const memberSummary = () => {
    const packagePath = script.fixture?.packagePath ?? script.packagePath;
    if (!packagePath) return 'wave record unavailable';
    try {
      const dir = join(packagePath, 'runtime', 'waves');
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        const members = Object.values(record.members ?? {})
          .map(member => `step ${member.step ?? member.step_number ?? '?'}:${member.phase ?? '?'}:${member.state ?? member.last_reason ?? '?'}`);
        return `members=[${members.join('; ')}]`;
      }
    } catch { /* wave record not written yet */ }
    return 'wave record unavailable';
  };

  const reachWaiters = state => {
    for (const waiter of state.waiters.splice(0)) waiter.resolve();
  };

  const armBarrier = (group, n) => {
    if (typeof group !== 'string' || group === '') throw new Error('armBarrier requires a group');
    if (!Number.isInteger(n) || n <= 0) throw new Error('armBarrier requires a positive hold count');
    const state = barrierState(group);
    state.n = n;
    state.armed = true;
    state.released = false;
    state.reached = false;
    state.held = [];
    return n;
  };

  const barrierReached = group => {
    const state = barrierState(group);
    if (state.reached) return Promise.resolve(state.held.length);
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, reject: null, timer: null };
      waiter.resolve = () => { clearTimeout(waiter.timer); resolve(state.held.length); };
      waiter.reject = reason => { clearTimeout(waiter.timer); reject(reason); };
      waiter.timer = setTimeout(() => {
        state.waiters = state.waiters.filter(entry => entry !== waiter);
        reject(new Error(`loopback barrier ${group} not reached after ${BARRIER_DEADLINE_MS}ms: held ${state.held.length}/${state.n} (${describeHeld(state)}; ${memberSummary()})`));
      }, BARRIER_DEADLINE_MS);
      state.waiters.push(waiter);
    });
  };

  const release = group => {
    const state = barrierState(group);
    if (state.armed) state.released = true;
    for (const entry of state.held.splice(0)) {
      if (entry.dropped) continue;
      sendReply(entry.res, entry.reply, entry.route.role, entry.turn);
    }
  };

  const openDepGate = (role, record, turn) => {
    if (depGateOpen) return;
    if (role === 'editor' && stepNumber(record) === 1 && turn === 2) {
      depGateOpen = true;
      while (depWaiters.length) depWaiters.shift()();
    }
  };

  const waitDepGate = () => {
    if (depGateOpen) return Promise.resolve();
    return new Promise(resolve => depWaiters.push(resolve));
  };

  const writeCompletion = (res, reply) => {
    if (res.writableEnded || res.destroyed) return;
    chunkId += 1;
    const base = { id: `chatcmpl-${chunkId}`, object: 'chat.completion.chunk', created: 1, model: MODEL };
    const delta = reply.tool_calls
      ? { tool_calls: reply.tool_calls.map((call, index) => ({ index, ...call })) }
      : { content: reply.text ?? '' };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  };

  const sendReply = (res, reply, role, turn) => {
    if (res.writableEnded || res.destroyed) return;
    if (!reply) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `wave-loopback: unscripted ${role} request`, type: 'unscripted' } }));
      return;
    }
    if (reply.tool_calls) for (const call of reply.tool_calls) call.id = `call_${role}_${turn}`;
    writeCompletion(res, reply);
  };

  const hold = (state, entry, res) => {
    state.held.push(entry);
    const drop = () => {
      entry.dropped = true;
      const index = state.held.indexOf(entry);
      if (index >= 0) state.held.splice(index, 1);
    };
    res.on('close', drop);
    if (state.held.length >= state.n) {
      state.reached = true;
      reachWaiters(state);
    }
  };

  // Event-time observation (D-29): snapshot the worker PIDs of a phase that are
  // still live when this request arrives, including the arriving request's own
  // PID. Read-only: it never waits, signals or otherwise touches those
  // processes, and it is captured before requests.push so the snapshot reflects
  // exactly the requests plus the arrival rather than the stored history plus it.
  const livePids = (seen, role, phase, entry) => [...new Set([...seen, entry]
    .filter(other => other.route?.role === role && other.route?.record?.phase === phase)
    .map(other => other.route?.pid)
    .filter(pid => Number.isInteger(pid) && pid > 0 && existsSync(`/proc/${pid}`)))];

  const readSdkMessages = (recordPath, pid) => {
    if (typeof recordPath !== 'string' || recordPath === '') return [];
    const sidecarPath = sdkContextSidecarPath(recordPath, pid);
    if (!existsSync(sidecarPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'));
      return Array.isArray(parsed?.messages) ? parsed.messages : [];
    } catch {
      return [];
    }
  };

  const handle = async (req, res) => {
    const route = decodeRoute(req.url ?? '');
    if (!route || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'wave-loopback: not found' } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'wave-loopback: malformed request body' } }));
      return;
    }
    const record = readRecord(route.recordPath);
    const phase = record?.phase ?? (route.role === 'coordinator' ? 'coordinator' : undefined);
    const turn = (body.messages ?? []).filter(message => message?.role === 'assistant').length;
    const reply = computeReply({ role: route.role, turn, body, record, script });
    const entry = { route: { role: route.role, record, recordPath: route.recordPath, pid: route.pid }, body, turn, response: reply, at: Date.now() };
    // D-29: attach the exact SDK-side messages the child observed for this
    // route/pid. Observation only: the wire body, the reply and any error flag
    // are never derived from the sidecar, and a missing sidecar stays empty.
    entry.sdkMessages = readSdkMessages(route.recordPath, route.pid);
    entry.liveImplementingPids = livePids(requests, 'owner', 'implementing', entry);
    entry.liveReviewingPids = livePids(requests, 'reviewer', 'reviewing', entry);
    requests.push(entry);
    if (!reply) {
      violations.push(entry);
      sendReply(res, null, route.role, turn);
      return;
    }

    openDepGate(route.role, record, turn);

    const group = barrierGroup(route.role, phase);
    const state = group ? barriers.get(group) : null;
    if (state?.armed && !state.released && state.held.length < state.n && turn === 0) {
      hold(state, { route: entry.route, reply, res, role: route.role, turn, dropped: false }, res);
      return;
    }

    if (isDepWriter(script, stepNumber(record)) && route.role === 'owner' && turn === 1) await waitDepGate();

    sendReply(res, reply, route.role, turn);
  };

  const server = createServer((req, res) => { void handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const close = async () => {
    for (const state of barriers.values()) {
      for (const entry of state.held.splice(0)) {
        try { entry.res.destroy(); } catch { /* socket already gone */ }
      }
      for (const waiter of state.waiters.splice(0)) waiter.reject(new Error('wave-loopback provider closed'));
    }
    while (depWaiters.length) depWaiters.shift()();
    // Initiate the close before dropping live sockets: server.close() waits for
    // every open connection, so closeAllConnections must run without awaiting
    // the close first or a hung socket blocks teardown. Await completion after.
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections?.();
    await closed;
  };

  return { port, requests, violations, script, armBarrier, barrierReached, release, close };
}
