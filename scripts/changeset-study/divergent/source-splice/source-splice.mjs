import { hash, safePath } from '../../../changeset/workspace.mjs';
import { transform, validateFileSyntax } from '../../../changeset/engine.mjs';

function uniqueAnchor(text, anchor, path, label) {
  if (typeof anchor !== 'string' || !anchor) throw new Error(`${label} anchor must be nonempty: ${path}`);
  const first = text.indexOf(anchor);
  if (first < 0 || text.indexOf(anchor, first + 1) >= 0) {
    throw new Error(`${label} anchor must occur exactly once: ${path}`);
  }
  return first;
}

function resolveRange(text, { start_anchor: start, end_anchor: end }, path, label) {
  const startAt = uniqueAnchor(text, start, path, `${label} start`);
  const endAt = end === null ? text.length : uniqueAnchor(text, end, path, `${label} end`);
  if (endAt < startAt + start.length) throw new Error(`${label} range is reversed or overlaps its start anchor: ${path}`);
  return { startAt, endAt };
}

/**
 * Preview an exact, planner-owned splice into one existing file.
 * Target semantics: preserve the complete start anchor, replace the text after it
 * up to (but not including) end_anchor. A null end_anchor means through EOF.
 * Source semantics: copy from the start anchor up to but not including end_anchor;
 * a null source end_anchor means through EOF.
 */
export function spliceExisting({ snapshot, reads, writes, target, parts }) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Expected a text snapshot');
  if (!Array.isArray(reads) || !Array.isArray(writes) || !Array.isArray(parts) || !parts.length) throw new Error('Expected read/write ownership and splice parts');
  const readSet = new Set(reads.map(safePath));
  const writeSet = new Set(writes.map(safePath));
  if (readSet.size !== reads.length || writeSet.size !== writes.length) throw new Error('Duplicate ownership path');
  if (!target || typeof target !== 'object') throw new Error('Expected an explicit target range');
  const targetPath = safePath(target.path);
  if (!readSet.has(targetPath)) throw new Error(`Target is not declared readable: ${targetPath}`);
  if (!writeSet.has(targetPath)) throw new Error(`Target is not owned for writing: ${targetPath}`);
  if (!Object.hasOwn(snapshot, targetPath)) throw new Error(`Target is missing from snapshot: ${targetPath}`);
  const targetText = snapshot[targetPath];
  if (typeof targetText !== 'string') throw new Error(`Target must be an existing text file: ${targetPath}`);
  if (typeof target.sha256 !== 'string' || hash(targetText) !== target.sha256) throw new Error(`Stale target snapshot: ${targetPath}`);

  resolveRange(targetText, target, targetPath, 'Target');
  const content = parts.map((part, index) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error(`Invalid splice part ${index}`);
    if (part.kind === 'literal') {
      if (typeof part.text !== 'string') throw new Error(`Literal part ${index} requires text`);
      return part.text;
    }
    if (part.kind !== 'source') throw new Error(`Unknown splice part ${index}`);
    const path = safePath(part.path);
    if (!readSet.has(path)) throw new Error(`Source is not declared readable: ${path}`);
    if (!Object.hasOwn(snapshot, path)) throw new Error(`Source is missing from snapshot: ${path}`);
    const sourceText = snapshot[path];
    if (typeof sourceText !== 'string') throw new Error(`Source must be an existing text file: ${path}`);
    if (typeof part.sha256 !== 'string' || hash(sourceText) !== part.sha256) throw new Error(`Stale source snapshot: ${path}`);
    const { startAt, endAt } = resolveRange(sourceText, part, path, 'Source');
    return sourceText.slice(startAt, endAt);
  }).join('');

  // transform() is the shared deterministic edit primitive. Its range replaces
  // from the start anchor, so include that exact anchor in the replacement text.
  const op = {
    id: 'source-splice-preview', executor: 'deterministic', reads: [...readSet],
    writes: [...writeSet], depends_on: [], edits: [{
      kind: 'replace-range', path: targetPath, start: target.start_anchor,
      end: target.end_anchor, text: target.start_anchor + content,
    }],
  };
  const changed = transform(op, snapshot);
  validateFileSyntax(changed);
  const preview = { ...snapshot, ...changed };
  return { changed, preview, target_sha256: hash(preview[targetPath]) };
}
