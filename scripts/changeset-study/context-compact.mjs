// Presentation only: every delivered text chunk is an exact slice of staged source.
const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const profiles = [
  { prefix: 160, suffix: 80, minimum_body: 600 },
  { prefix: 80, suffix: 40, minimum_body: 300 },
  // Last resort retains signatures and block delimiters, never fabricated source.
  { prefix: 1, suffix: 1, minimum_body: 2 },
];

export function compactContext(excerpts, files, { parse, limit = 32000 } = {}) {
  const original = excerpts.reduce((n, e) => n + e.text.length, 0);
  if (original <= limit) return { excerpts, compaction: null };
  if (excerpts.length > 16) throw new Error(`Focused source exceeds ${limit} characters`);
  const asts = new Map();
  const selectors = excerpts.map(({ path, start, end, source_start, source_end }, selection_index) => ({
    selection_index, path, start, end, source_start, source_end }));
  const byPath = new Map();
  for (const [selection_index, excerpt] of excerpts.entries()) {
    const { path, source_start: begin, source_end: end } = excerpt, source = files[path];
    if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end <= begin ||
        end > source?.length || source?.slice(begin, end) !== excerpt.text) throw new Error(`Invalid source slice: ${path}`);
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push({ ...excerpt, selection_index, selection_indices: [selection_index] });
  }
  // A generated tail may overlap earlier fixtures. Deliver its bytes only once;
  // keep every original selector separately so this never changes edit ownership.
  const selections = [];
  for (const [path, entries] of byPath) {
    let last;
    for (const entry of entries.sort((a, b) => a.source_start - b.source_start || a.source_end - b.source_end)) {
      if (last && entry.source_start <= last.source_end) {
        last.source_end = Math.max(last.source_end, entry.source_end);
        last.selection_indices.push(...entry.selection_indices);
        last.text = files[path].slice(last.source_start, last.source_end);
      } else { last = { ...entry }; selections.push(last); }
    }
  }
  const unique = selections.reduce((n, e) => n + e.text.length, 0);
  const coveringSelections = (path, start, end) => selectors.filter(selector => selector.path === path &&
    selector.source_start < end && selector.source_end > start).map(selector => selector.selection_index);
  const render = profile => {
    const omitted = [], delivered = [];
    for (const excerpt of selections) {
      const { path, source_start: begin, source_end: end } = excerpt, source = files[path];
      const ranges = [];
      if (profile && path.endsWith('.mjs')) {
        if (typeof parse !== 'function') throw new Error(`Focused source exceeds ${limit} characters`);
        if (!asts.has(path)) {
          try { asts.set(path, parse(source, { ecmaVersion: 'latest', sourceType: 'module' })); }
          catch { throw new Error(`Cannot compact invalid module source: ${path}`); }
        }
        const visit = (node, parent = null) => {
          if (!node || typeof node !== 'object') return;
          if (functionTypes.has(node.type) && node.body?.type === 'BlockStatement' &&
              node.start >= begin && node.end <= end && node.body.end - node.body.start > profile.minimum_body) {
            const a = node.body.start + profile.prefix, b = node.body.end - profile.suffix;
            ranges.push({ path, selection_indices: coveringSelections(path, a, b), source_start: a, source_end: b,
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
        if (range.source_start > cursor) delivered.push({ ...excerpt, selection_index: undefined,
          selection_indices: coveringSelections(path, cursor, range.source_start), source_start: cursor, source_end: range.source_start, text: source.slice(cursor, range.source_start) });
        cursor = range.source_end; omitted.push(range);
      }
      if (cursor < end) delivered.push({ ...excerpt, selection_index: undefined,
        selection_indices: coveringSelections(path, cursor, end), source_start: cursor, source_end: end, text: source.slice(cursor, end) });
    }
    return { delivered, omitted, characters: delivered.reduce((n, e) => n + e.text.length, 0) };
  };
  let profile = null, rendered = render(null);
  for (const candidate of profiles) {
    if (rendered.characters <= limit) break;
    profile = candidate; rendered = render(profile);
  }
  const { delivered, omitted, characters } = rendered;
  if (characters > limit) throw new Error(`Focused source exceeds ${limit} characters after function-body compaction`);
  return { excerpts: delivered, compaction: { applied: true, policy: 'exact-function-body-slices-v2', offset_units: 'utf16-code-units',
    original_source_characters: original, unique_source_characters: unique, deduplicated_source_characters: original - unique,
    source_characters: characters, omitted_characters: unique - characters, body_profile: profile,
    omitted_bytes: omitted.reduce((n, r) => n + r.omitted_bytes, 0), selectors, omitted_ranges: omitted,
    instruction: 'Excerpts are separate exact contiguous source slices. Overlapping selections are delivered once. Omitted ranges remain in the full current files. Preserve unseen bodies with exact replacements or source-range edits; never regenerate a file or function by concatenating these slices. Original start/end selectors are metadata, not boundaries of each delivered slice.' } };
}
