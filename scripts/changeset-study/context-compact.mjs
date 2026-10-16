// Presentation only: every delivered text chunk is an exact slice of staged source.
const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const prefix = 160, suffix = 80, minimumBody = 600;

export function compactContext(excerpts, files, { parse, limit = 32000 } = {}) {
  const original = excerpts.reduce((n, e) => n + e.text.length, 0);
  if (original <= limit) return { excerpts, compaction: null };
  if (typeof parse !== 'function' || excerpts.length > 16) throw new Error(`Focused source exceeds ${limit} characters`);
  const asts = new Map(), omitted = [], delivered = [];
  const selectors = excerpts.map(({ path, start, end, source_start, source_end }, selection_index) => ({
    selection_index, path, start, end, source_start, source_end }));
  for (const [selection_index, excerpt] of excerpts.entries()) {
    const { path, source_start: begin, source_end: end } = excerpt, source = files[path];
    if (!Number.isInteger(begin) || !Number.isInteger(end) || source?.slice(begin, end) !== excerpt.text) throw new Error(`Invalid source slice: ${path}`);
    const ranges = [];
    if (path.endsWith('.mjs')) {
      if (!asts.has(path)) {
        try { asts.set(path, parse(source, { ecmaVersion: 'latest', sourceType: 'module' })); }
        catch { throw new Error(`Cannot compact invalid module source: ${path}`); }
      }
      const visit = (node, parent = null) => {
        if (!node || typeof node !== 'object') return;
        if (functionTypes.has(node.type) && node.body?.type === 'BlockStatement' &&
            node.start >= begin && node.end <= end && node.body.end - node.body.start > minimumBody) {
          const a = node.body.start + prefix, b = node.body.end - suffix;
          ranges.push({ path, selection_index, source_start: a, source_end: b,
            omitted_characters: b - a, omitted_bytes: Buffer.byteLength(source.slice(a, b)),
            definition: { type: node.type, name: node.id?.name ?? parent?.key?.name ?? parent?.key?.value ?? parent?.id?.name ?? null,
              source_start: node.start, source_end: node.end, body_start: node.body.start, body_end: node.body.end } });
          return; // An elided outer function owns its nested definitions.
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(child => visit(child, node));
          else if (value && typeof value === 'object') visit(value, node);
        }
      };
      visit(asts.get(path));
    }
    ranges.sort((a, b) => a.source_start - b.source_start);
    let cursor = begin;
    for (const range of ranges) {
      if (range.source_start > cursor) delivered.push({ ...excerpt, selection_index, source_start: cursor, source_end: range.source_start, text: source.slice(cursor, range.source_start) });
      cursor = range.source_end; omitted.push(range);
    }
    if (cursor < end) delivered.push({ ...excerpt, selection_index, source_start: cursor, source_end: end, text: source.slice(cursor, end) });
  }
  const characters = delivered.reduce((n, e) => n + e.text.length, 0);
  if (characters > limit) throw new Error(`Focused source exceeds ${limit} characters after function-body compaction`);
  return { excerpts: delivered, compaction: { applied: true, policy: 'exact-function-body-slices-v1', offset_units: 'utf16-code-units',
    original_source_characters: original, source_characters: characters, omitted_characters: original - characters,
    omitted_bytes: omitted.reduce((n, r) => n + r.omitted_bytes, 0), selectors, omitted_ranges: omitted,
    instruction: 'Excerpts are separate exact contiguous source slices. Omitted ranges remain in the full current files. Preserve unseen bodies with exact replacements or source-range edits; never regenerate a file or function by concatenating these slices. Original start/end selectors are metadata, not boundaries of each delivered slice.' } };
}
