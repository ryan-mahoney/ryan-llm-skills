import { createHash } from 'node:crypto';
import { transform } from './engine.mjs';

const diagnosticLimitBytes = 4096;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const countExact = (text, needle) => {
  if (typeof text !== 'string' || typeof needle !== 'string' || !needle) return 0;
  return text.split(needle).length - 1;
};
const countOverlapping = (text, needle) => {
  if (typeof text !== 'string' || typeof needle !== 'string' || !needle) return 0;
  let count = 0, offset = 0;
  while ((offset = text.indexOf(needle, offset)) >= 0) { count++; offset++; }
  return count;
};

function boundedContext(text, offset, matchLength, kind) {
  const boundary = offset + matchLength;
  const start = Math.max(0, boundary - 96);
  const end = Math.min(text.length, boundary + 96);
  return { kind, source_state: 'private_replay_after_preceding_edits',
    source_start: offset, source_end: boundary, matched_utf16_length: matchLength,
    matched_sha256: sha256(text.slice(offset, boundary)),
    source_window: { start, end, text: text.slice(start, end) } };
}

function uniquePrefixContext(search, text) {
  let prefix = '', best = null;
  for (const match of search.matchAll(/[^\n]*\n/g)) {
    prefix += match[0];
    if (prefix.replace(/\s/g, '').length < 16) continue;
    const matches = countOverlapping(text, prefix);
    if (matches === 1) {
      const offset = text.indexOf(prefix);
      best = boundedContext(text, offset, prefix.length, 'unique_exact_prefix_not_full_match');
      best.prefix_sha256 = sha256(prefix);
    }
    // A longer prefix cannot match if this prefix is absent.
    if (matches === 0) break;
  }
  return best;
}

function editEvidence(edit, current, operation) {
  const path = typeof edit?.path === 'string' ? edit.path : null;
  const ownedText = path && operation.writes.includes(path) && Object.hasOwn(current, path) && typeof current[path] === 'string'
    ? current[path] : null;
  if (edit?.kind === 'replace' && ownedText !== null && typeof edit.search === 'string' && edit.search) {
    const count = countExact(ownedText, edit.search);
    const overlapCount = countOverlapping(ownedText, edit.search);
    let context = null;
    if (overlapCount === 1) {
      const offset = ownedText.indexOf(edit.search);
      context = boundedContext(ownedText, offset, edit.search.length, 'unique_exact_match');
    } else if (count === 0) {
      context = uniquePrefixContext(edit.search, ownedText);
    }
    return { match_count: { expected: edit.count ?? 1, actual: count, overlapping_candidates: overlapCount },
      rejected_search: edit.search, ...(context ? { source_context: context } : {
        context_omitted: overlapCount > 1 ? 'search location is overlapping or ambiguous' : 'no unique exact match or whole-line prefix',
      }) };
  }
  if (edit?.kind === 'replace-range' && ownedText !== null) {
    const startCount = countExact(ownedText, edit.start);
    const endCount = edit.end === null ? null : countExact(ownedText, edit.end);
    const startOverlapCount = countOverlapping(ownedText, edit.start);
    const endOverlapCount = edit.end === null ? null : countOverlapping(ownedText, edit.end);
    const start = startOverlapCount === 1 ? ownedText.indexOf(edit.start) : -1;
    const end = edit.end === null ? ownedText.length : endOverlapCount === 1 ? ownedText.indexOf(edit.end) : -1;
    const ordered = start >= 0 && end >= start + edit.start.length;
    return { anchors: { start_literal: edit.start, end_literal: edit.end,
      start_matches: startCount, end_matches: endCount, start_overlapping_candidates: startOverlapCount,
      end_overlapping_candidates: endOverlapCount, ordered },
      ...(ordered ? { source_context: boundedContext(ownedText, start, end - start, 'unique_range') }
        : { context_omitted: 'range anchors are missing, ambiguous, or out of order' }) };
  }
  return { context_omitted: 'no uniquely diagnosable target literal' };
}

function shortValue(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) return { value, truncated: false };
  if (limit <= 0) return { value: '…', truncated: true };
  const side = Math.floor(limit / 2);
  return { value: `${value.slice(0, side)}…${value.slice(-side)}`, truncated: true };
}

function serializedAddition(detail) {
  const serialized = JSON.stringify(detail);
  const addition = `\n\nLocal application diagnosis (context only):\n${serialized}`;
  return Buffer.byteLength(addition, 'utf8') <= diagnosticLimitBytes ? addition : null;
}

function fitDiagnostic(detail) {
  let addition = serializedAddition(detail);
  if (addition) return addition;

  if (detail.source_context) {
    delete detail.source_context;
    detail.context_omitted = 'source context omitted by the 4 KiB serialized-diagnostic cap';
  }
  addition = serializedAddition(detail);
  if (addition) return addition;

  const literalFields = [
    { parent: detail, field: 'rejected_search' },
    { parent: detail.anchors, field: 'start_literal' },
    { parent: detail.anchors, field: 'end_literal' },
  ].filter(item => item.parent && typeof item.parent[item.field] === 'string');
  const originals = literalFields.map(item => ({ ...item, original: item.parent[item.field] }));
  for (const previewLength of [1024, 512, 256, 128, 64, 0]) {
    for (const { parent, field, original } of originals) {
      const preview = shortValue(original, previewLength);
      parent[field] = preview.value;
      if (preview.truncated) {
        parent[`${field}_truncated`] = true;
        parent[`${field}_original_length`] = original.length;
        parent[`${field}_sha256`] = sha256(original);
      }
    }
    addition = serializedAddition(detail);
    if (addition) return addition;
  }

  // Keep the failure identity/counts even if caller-controlled path/error
  // strings are unusually large. The exact path is still hash-bound.
  for (const field of ['failed_edit.path', 'failed_edit.error']) {
    const [parent, key] = field.split('.');
    const original = detail[parent]?.[key];
    if (typeof original !== 'string') continue;
    const preview = shortValue(original, 128);
    detail[parent][key] = preview.value;
    if (preview.truncated) {
      detail[parent][`${key}_truncated`] = true;
      detail[parent][`${key}_original_length`] = original.length;
      detail[parent][`${key}_sha256`] = sha256(original);
    }
  }
  addition = serializedAddition(detail);
  if (addition) return addition;
  return null;
}

/**
 * Locate the first failing focused edit by replaying edits privately, in order.
 * Returned context is diagnostic only; this function never repairs or applies
 * model-provided edits to the caller's snapshot.
 */
export function applicationFailureDiagnostic({ operation, files, edits, error }) {
  try {
    if (!operation || !Array.isArray(operation.writes) || operation.writes.length !== 1 ||
        !files || typeof files !== 'object' || !Array.isArray(edits) || !edits.length) return null;
    let current = { ...files };
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index];
      try {
        const changed = transform({ ...operation, edits: [edit] }, current);
        current = { ...current, ...changed };
      } catch (failure) {
        // This diagnostic is for edit anchors and replacement searches. Other
        // edit kinds retain their existing concise application error.
        if (!['replace', 'replace-range'].includes(edit?.kind)) return null;
        if (error?.message && error.message !== failure?.message) return null;
        const detail = {
          kind: 'local_application_failure_context',
          note: 'Diagnostic only. No edit was applied to the caller snapshot; source context does not grant edit authority.',
          failed_edit: { index, kind: edit?.kind ?? null, path: edit?.path ?? null,
            error: String(failure?.message ?? failure).slice(0, 400) },
          ...editEvidence(edit, current, operation),
        };
        return fitDiagnostic(detail);
      }
    }
    return null;
  } catch {
    return null;
  }
}
