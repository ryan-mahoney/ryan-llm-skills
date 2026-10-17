import { validateFocusedPlan } from './focused-editors.mjs';

export const V4A_SOURCE_LIMIT = 64000;

// V4A consumes physical lines and cannot reference omitted bodies. Keep the
// planner's selections, expand their boundary lines, and deduplicate overlaps.
export function v4aInput(operation, files) {
  validateFocusedPlan({ operations: [operation] });
  const byPath = new Map(), sourceRanges = [];
  for (const [selection_index, { path, start, end }] of operation.context.entries()) {
    const text = files[path];
    if (typeof text !== 'string') throw new Error(`Excerpt file missing: ${path}`);
    const anchor = (value, fallback) => {
      if (value === null) return fallback;
      if (text.split(value).length !== 2) throw new Error(`Excerpt anchor must be unique: ${path}`);
      return text.indexOf(value);
    };
    const a = anchor(start, 0), b = anchor(end, text.length);
    if (b <= a) throw new Error(`Invalid excerpt ordering: ${path}`);
    sourceRanges.push({ selection_index, path, start, end, source_start: a, source_end: b });
    let record = byPath.get(path);
    if (!record) {
      const lines = []; let cursor = 0;
      for (const match of text.matchAll(/\r\n|\r|\n/g)) {
        lines.push({ start: cursor, end: match.index + match[0].length }); cursor = match.index + match[0].length;
      }
      if (cursor < text.length) lines.push({ start: cursor, end: text.length });
      record = { lines, ranges: [] }; byPath.set(path, record);
    }
    const first = record.lines.find(line => line.start <= a && a < line.end);
    const last = b === text.length ? null : record.lines.find(line => line.start <= b && b < line.end);
    // An exclusive selector at an indented next declaration excludes that line.
    const finish = !last ? b : /^[\t ]*$/.test(text.slice(last.start, b)) ? last.start : last.end;
    record.ranges.push({ source_start: first.start, source_end: finish, selection_indices: [selection_index] });
  }
  const excerpts = [];
  for (const [path, { lines, ranges }] of [...byPath].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const merged = [];
    for (const range of ranges.sort((a, b) => a.source_start - b.source_start)) {
      const last = merged.at(-1);
      if (last && range.source_start <= last.source_end) {
        last.source_end = Math.max(last.source_end, range.source_end);
        last.selection_indices.push(...range.selection_indices);
      } else merged.push({ ...range });
    }
    for (const range of merged) excerpts.push({ path, ...range,
      start_line: lines.findIndex(line => line.start === range.source_start) + 1,
      end_line: lines.findIndex(line => line.end === range.source_end) + 1,
      text: files[path].slice(range.source_start, range.source_end) });
  }
  const characters = excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);
  if (characters > V4A_SOURCE_LIMIT) throw new Error(`V4A complete source exceeds ${V4A_SOURCE_LIMIT} characters: ${operation.id}`);
  for (const [path, text] of Object.entries(files)) {
    if (text !== null && !excerpts.some(excerpt => excerpt.path === path)) throw new Error(`Missing declared file excerpt: ${path}`);
  }
  return { objective: operation.objective, instruction: operation.instruction, requirements: operation.requirements,
    writes: operation.writes, absent_files: Object.keys(files).filter(path => files[path] === null), excerpts,
    source_ranges: sourceRanges, source_context: { policy: 'complete-lines-v1', source_characters: characters,
      limit_characters: V4A_SOURCE_LIMIT, body_omission: false, offset_units: 'utf16-code-units' } };
}
