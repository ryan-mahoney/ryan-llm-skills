import { basename, join } from 'node:path';

import { projectWaveRecord, runWaveIdentity, TERMINAL_WAVE_STATES, ACTIVE_MEMBER_PHASES } from './core.mjs';

// Wave records share the runtime's safe basename rule; the observer never reads
// temp files, locks, seal subdirectories or conflict artifacts.
const WAVE_FILE_NAME = /^[A-Za-z0-9_-]{1,128}\.json$/;

const byStep = (left, right) => (left.step ?? 0) - (right.step ?? 0);

// Bounded wave listing and projection reuses the caller's directory walker,
// bounded JSON reader and shared byte budget so wave reads cannot escape the
// package floor. A missing directory is an empty result; unreadable records
// stay explicit unknowns and never become accepted lifecycle evidence.
export async function collectWaves(fact, { listDirectory, readJson, budget, note, noteUnknown, limits }) {
  fact.hasWaveFiles = false;
  fact.waves = [];
  fact.invalidWaves = [];
  const directory = join(fact.packagePath, 'runtime', 'waves');
  const listed = await listDirectory(directory, limits.waveFiles,
    entry => entry.isFile() && WAVE_FILE_NAME.test(entry.name),
    limits.waveFiles * limits.directoryEntryFactor);
  if (listed.entries === null) {
    // A package with no wave directory has no wave lifecycle to observe.
    if (listed.code !== 'ENOENT') noteUnknown(`waves-unavailable: ${directory} (${listed.code})`);
    return;
  }
  if (listed.code) noteUnknown(`waves-unavailable: ${directory} (${listed.code})`);
  if (listed.truncated) note(`waves-cap: ${directory}`);
  for (const entry of listed.entries) {
    fact.hasWaveFiles = true;
    const file = join(directory, entry.name);
    const result = await readJson(file, limits.waveRecordBytes, budget, {
      prefix: 'wave', within: fact.packagePath, allow: value => value,
    });
    if (result.outcome === 'read-budget') { noteUnknown(result.reason); break; }
    if (result.outcome !== 'ok') {
      fact.invalidWaves.push({ record_path: file, reason: result.outcome === 'oversized' ? 'oversized' : 'invalid-json' });
      note(`wave-invalid: ${file}`);
      continue;
    }
    const projected = projectWaveRecord(result.record, file);
    if (projected.ok) fact.waves.push(projected.wave);
    else { fact.invalidWaves.push({ record_path: file, reason: projected.reason }); note(`wave-invalid: ${file}`); }
  }
}

// Every wave member names its current phase run in the record. Those run ids
// are read directly ahead of the bounded receipt walk so an unrelated receipt
// flood (logs, retries) cannot push active members past the receipt cap.
export function waveMemberRunIds(fact) {
  const ids = new Set();
  for (const wave of fact.waves ?? []) {
    for (const member of wave.members) if (typeof member.run_id === 'string') ids.add(member.run_id);
    // A candidate run is the wave's repair lifecycle, not a member.
    if (!TERMINAL_WAVE_STATES.includes(wave.state) && typeof wave.candidate?.run_id === 'string') ids.add(wave.candidate.run_id);
  }
  return ids;
}

// Member and candidate runs of a wave that has not reached a terminal state are
// current assignments even while a sibling finishes and the wave moves on.
export function waveCurrentRuns(fact) {
  const runs = new Set();
  for (const wave of fact.waves ?? []) {
    if (TERMINAL_WAVE_STATES.includes(wave.state)) continue;
    for (const member of wave.members) if (typeof member.run_id === 'string') runs.add(member.run_id);
    if (typeof wave.candidate?.run_id === 'string') runs.add(wave.candidate.run_id);
  }
  return runs;
}

// A nonterminal wave, or any unreadable wave record whose state is unknown,
// keeps the package's lifecycle open: it must not be hidden as completed or
// classified as planned inventory.
export function waveLifecycleActive(fact) {
  return (fact.waves ?? []).some(wave => !TERMINAL_WAVE_STATES.includes(wave.state)) || (fact.invalidWaves ?? []).length > 0;
}

// Tie one receipt to its wave member. Identity comes from the receipt's own
// bindings; the projected record supplies the member phase, backend and
// checkout so a run never invents a checkout the record does not name.
export function waveRunMatch(fact, receipt) {
  const identity = runWaveIdentity(receipt);
  if (!identity) return null;
  if (receipt?.command_phase?.subject?.kind === 'candidate') return { identity, match: matchWaveCandidate(fact, identity) };
  return { identity, match: matchWaveMember(fact, identity) };
}

function matchWaveCandidate(fact, identity) {
  const wave = (fact.waves ?? []).find(item => item.wave_id === identity.wave_id);
  if (!wave) return null;
  return wave.candidate ? { wave, member: null, candidate: wave.candidate } : null;
}

export function matchWaveMember(fact, identity) {
  const wave = (fact.waves ?? []).find(item => item.wave_id === identity.wave_id);
  if (!wave) return null;
  if (identity.candidate != null) return wave.candidate ? { wave, member: null, candidate: wave.candidate } : null;
  if (identity.step_number != null) {
    const member = wave.members.find(item => item.step === identity.step_number);
    if (member) return { wave, member, candidate: null };
  }
  return null;
}

export function runWaveProjection(identity, match) {
  const record = match?.candidate ?? match?.member ?? null;
  return { wave_id: identity.wave_id, step: match?.member?.step ?? null, phase: record?.phase ?? null,
    backend: record?.backend ?? null, fallback_reason: record?.fallback_reason ?? null };
}

export function waveMemberCheckout(match) {
  return match?.candidate?.checkout ?? match?.member?.checkout ?? null;
}

// Small display projection: every member is counted, the display keeps active
// and blocked/cancelled work visible before queued and sealed members.
export function waveRow(fact, wave, limits) {
  const members = wave.members ?? [];
  const active = members.filter(member => ACTIVE_MEMBER_PHASES.includes(member.phase)).sort(byStep);
  const blocked = members.filter(member => member.phase === 'blocked').sort(byStep);
  const cancelled = members.filter(member => member.phase === 'cancelled').sort(byStep);
  const queued = members.filter(member => member.phase === 'queued').sort(byStep);
  const sealed = members.filter(member => member.phase === 'sealed').sort(byStep);
  const display = [...active, ...blocked, ...cancelled, ...queued, ...sealed].slice(0, limits.waveMembers);
  return {
    wave_id: wave.wave_id, state: wave.state, generation: wave.generation ?? null, record_path: wave.record_path,
    workspace: fact.workspace, package_ref: fact.ref, package: fact.packagePath,
    member_count: members.length, active_count: active.length, sealed_count: sealed.length,
    blocked_count: blocked.length, queued_count: queued.length, cancelled_count: cancelled.length,
    omitted_count: Math.max(0, members.length - display.length),
    members: display.map(member => ({ step: member.step, phase: member.phase, run_id: member.run_id,
      sealed_head: member.sealed_head ?? null, blocking_reason: member.blocking_reason ?? null })),
  };
}

export function unknownWaveRow(fact, invalid) {
  return {
    wave_id: basename(invalid.record_path).replace(/\.json$/, ''), state: 'unknown', reason: invalid.reason,
    workspace: fact.workspace, package_ref: fact.ref, package: fact.packagePath, record_path: invalid.record_path,
    member_count: 0, active_count: 0, sealed_count: 0, blocked_count: 0, queued_count: 0, cancelled_count: 0,
    omitted_count: 0, members: [],
  };
}

export function waveRows(fact, limits) {
  const rows = [];
  for (const wave of fact.waves ?? []) rows.push(waveRow(fact, wave, limits));
  for (const invalid of fact.invalidWaves ?? []) rows.push(unknownWaveRow(fact, invalid));
  return rows;
}

export function renderWaveLine(row) {
  return `  ${row.package_ref ?? basename(row.package)} · Wave ${row.wave_id} ${row.state} · ${row.member_count} members · `
    + `${row.active_count} active · ${row.sealed_count} sealed · ${row.blocked_count} blocked · omitted ${row.omitted_count}`;
}
