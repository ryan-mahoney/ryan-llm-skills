// Diagnostic-only observations around the wave/checkpoint ownership boundary.
//
// The native integration test's static imports stay inside its card rule, so
// these helpers are re-exported through package-fixture.mjs. The linux case 8
// imports this module directly. Nothing here reads production state through a
// guessed fixture field: wave records live at <package>/runtime/waves and the
// workflow checkpoint lives at the real sentinel path
// <package>/runtime/sentinel/<workflow_id>/checkpoint.json.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { boundedText } from './wave-native-diagnostics.mjs';

const EVENT_CONTENT_LIMIT = 2000;
const LOG_TAIL_LIMIT = 8000;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

function messageTexts(message) {
  const content = message?.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map(block => (typeof block === 'string' ? block : (block?.text ?? block?.content ?? null)))
    .filter(text => typeof text === 'string');
}

function responseToolCalls(request) {
  const response = request?.response ?? {};
  const calls = Array.isArray(response.toolCalls) ? response.toolCalls
    : Array.isArray(response.tool_calls) ? response.tool_calls
      : response.choices?.[0]?.message?.tool_calls;
  return (Array.isArray(calls) ? calls : []).map(call => ({
    id: call?.id ?? call?.toolCallId ?? null,
    name: call?.name ?? call?.function?.name ?? null,
  }));
}

function toolResultCallIds(messages) {
  const ids = [];
  for (const message of messages) {
    for (const call of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
      if (call?.id) ids.push(call.id);
    }
    const id = message?.tool_call_id ?? message?.toolCallId ?? message?.call_id;
    if (id) ids.push(id);
  }
  return ids;
}

function collectWaveRecords(fixture) {
  const dir = join(fixture.packagePath, 'runtime', 'waves');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort().map(name => {
    const path = join(dir, name);
    const record = readJson(path);
    if (record?.error) return { file: name, error: record.error };
    return {
      file: name,
      wave_id: record.wave_id ?? null,
      state: record.state ?? null,
      generation: record.generation ?? null,
      workflow_id: record.workflow_id ?? null,
      package_ref: record.package_ref ?? null,
      after: record.after ?? null,
      coordinator_session: record.coordinator?.session ?? null,
      coordinator_pid: record.coordinator?.process_identity?.pid ?? record.coordinator?.pid ?? null,
      claim_token: record.claim_token ?? null,
      integration_checkout: record.target?.integration_checkout ?? null,
      checkpoint_reconcile: record.checkpoint_reconcile ?? null,
      promotion: record.target?.promotion ?? null,
      promotion_state: record.target?.promotion?.state ?? null,
      blocking_reason: record.blocking_reason ?? null,
    };
  });
}

function collectCheckpointOwnership(fixture, waves) {
  return waves.map(wave => {
    if (!wave?.workflow_id) return { file: wave?.file ?? null, workflow_id: null };
    const path = join(fixture.packagePath, 'runtime', 'sentinel', String(wave.workflow_id), 'checkpoint.json');
    if (!existsSync(path)) {
      return {
        file: wave.file,
        workflow_id: wave.workflow_id,
        path,
        missing: true,
        wave_coordinator_session: wave.coordinator_session,
      };
    }
    const checkpoint = readJson(path);
    if (checkpoint?.error) {
      return { file: wave.file, workflow_id: wave.workflow_id, path, error: checkpoint.error };
    }
    return {
      file: wave.file,
      workflow_id: wave.workflow_id,
      path,
      state: checkpoint.state ?? null,
      revision: checkpoint.revision ?? null,
      input_revision: checkpoint.input_revision ?? null,
      checkout: checkpoint.checkout ?? null,
      coordinator_session: checkpoint.coordinator_session ?? null,
      wave_coordinator_session: wave.coordinator_session,
      coordinator_session_matches_wave: checkpoint.coordinator_session === wave.coordinator_session,
      workers: Array.isArray(checkpoint.workers) ? checkpoint.workers : null,
    };
  });
}

// One row per coordinator request/event plus the durable wave/checkpoint
// ownership snapshot. The caller emits each row separately so a large request
// cannot interleave with the next one. User-message text is retained in full;
// event content is bounded away from images and full prompts.
export function collectBoundaryDiagnostics({ fixture, provider, coordinator }) {
  const rows = [];
  for (const request of provider?.requests ?? []) {
    try {
      const messages = request?.body?.messages ?? [];
      rows.push({
        label: 'request',
        value: {
          at: request?.at ?? null,
          timestamp: request?.timestamp ?? request?.at ?? null,
          turn: request?.turn ?? null,
          role: request?.route?.role ?? null,
          phase: request?.route?.record?.phase ?? null,
          responseToolCalls: responseToolCalls(request),
          userMessages: messages
            .filter(message => message?.role === 'user')
            .map(message => ({ role: message.role, content: messageTexts(message) })),
          toolResultCallIds: toolResultCallIds(messages),
        },
      });
    } catch (error) {
      rows.push({ label: 'request', value: { error: error?.message ?? String(error) } });
    }
  }
  for (const event of coordinator?.events ?? []) {
    const type = event?.type ?? null;
    if (type !== 'custom_message' && type !== 'message_end' && type !== 'message_start') continue;
    try {
      const message = event?.message ?? event?.customMessage ?? event?.custom_message ?? {};
      const customType = message?.customType ?? message?.custom_type
        ?? event?.customType ?? event?.custom_type ?? null;
      if (customType !== 'spec-wave' && type !== 'message_end') continue;
      rows.push({
        label: 'coordinator.events',
        value: {
          type,
          customType,
          content: boundedText(
            typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? null),
            EVENT_CONTENT_LIMIT
          ),
        },
      });
    } catch (error) {
      rows.push({
        label: 'coordinator.events', value: { error: error?.message ?? String(error), type }
      });
    }
  }
  const waves = collectWaveRecords(fixture);
  rows.push({ label: 'waves', value: waves });
  rows.push({ label: 'checkpointOwnership', value: collectCheckpointOwnership(fixture, waves) });
  return rows;
}

function readTail(path) {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length > LOG_TAIL_LIMIT ? text.slice(-LOG_TAIL_LIMIT) : text;
  } catch (error) {
    return `<unreadable: ${error?.message ?? String(error)}>`;
  }
}

// Case 8 post-mortem: the actual C exit result, its stdio, the current
// wave/checkpoint ownership, and the promotion hook/marker state. Registered
// before C starts and read during fixture teardown, so it never awaits a live
// process.
export function collectLinuxRestartDiagnostics({
  fixture,
  coordinator,
  exitObservation,
  hookLogPath,
  observationsPath,
  markerPath,
}) {
  const rows = [];
  const waves = collectWaveRecords(fixture);
  rows.push({
    label: 'linux-restart-c.exit',
    value: {
      pid: coordinator?.pid ?? null,
      observed: exitObservation ?? null,
    },
  });
  try {
    rows.push({
      label: 'linux-restart-c.stderr',
      value: boundedText(coordinator?.stderr ?? coordinator?.stderrText ?? null, LOG_TAIL_LIMIT),
    });
    rows.push({
      label: 'linux-restart-c.stdout',
      value: boundedText(coordinator?.stdout ?? coordinator?.stdoutText ?? null, LOG_TAIL_LIMIT),
    });
  } catch (error) {
    rows.push({
      label: 'linux-restart-c.stdio', value: { error: error?.message ?? String(error) }
    });
  }
  rows.push({ label: 'linux-restart.waves', value: waves });
  rows.push({
    label: 'linux-restart.checkpointOwnership', value: collectCheckpointOwnership(fixture, waves)
  });
  rows.push({
    label: 'linux-restart.hook',
    value: {
      hook_log_path: hookLogPath ?? null,
      hook_log: hookLogPath ? readTail(hookLogPath) : null,
      observations_path: observationsPath ?? null,
      observations: observationsPath ? readTail(observationsPath) : null,
      marker_path: markerPath ?? null,
      marker_present: markerPath ? existsSync(markerPath) : null,
    },
  });
  return rows.map(row => `${row.label}=${JSON.stringify(row.value)}`);
}
