import { performance } from 'node:perf_hooks';
import { transform, validateFileSyntax } from '../changeset/engine.mjs';
import { safePath } from '../changeset/workspace.mjs';
import { v4aInput } from './v4a-context.mjs';
import { applyV4A } from './divergent/v4a-suite/applier.mjs';
import { ModelJsonParseError } from './client.mjs';
import { recipeFidelity } from './recipe-fidelity.mjs';

const primaryContract = `Return exactly ONE strict V4A patch. Emit *** Begin Patch once and *** End Patch once. No Markdown fences, commentary, nested patches or extra end markers. Use one file header for the owned destination and put ALL assignment changes under it.
Update example:
*** Begin Patch
*** Update File: owned/file.mjs
@@
-const answer = 1;
+const answer = 2;
*** End Patch
Use *** Add File: path with + prefixed COMPLETE new file contents for an absent destination; *** Delete File: path deletes an owned existing file.
For updates, use space-prefixed unchanged context, - removals and + insertions. Every context/removal entry must be a COMPLETE physical source line from excerpts.text, including indentation and the entire line after the changed expression. Selector prefixes in instruction/source_ranges are locators, never literal source lines. Do not truncate a long line, omit a leading statement, or write a no-op patch.
Order update hunks by original source line number, ascending, even if instructions describe edits in a different order. Match against original staged source; do not overlap or repeat context across hunks. Use enough exact surrounding lines for a unique match. Bare @@ separates hunks. An @@ source anchor skips PAST that line; do not repeat it inside the following hunk. Pure + insertion hunks append at EOF; use that form when instructed to append tests. *** End of File scopes the final hunk to EOF.
The recipe may mention JSON compose or source-range edits: those describe what source to copy, not your response format. Implement that SAME recipe in V4A, copying all required bodies verbatim from the complete supplied selections and adding the specified wrappers/separators. Never output placeholders or omit required helpers. Write identifiers exactly as the recipe and requirements spell them; a shorthand object member such as { read, atomic } names existing module-scope bindings that may be defined outside your excerpts. Never substitute an imported function, a literal or an invented binding for a name the recipe gives. Preserve unrelated bytes and unseen source. Separate excerpts are not one contiguous file. Updates preserve existing line endings and EOF-newline presence; added files use LF. No tools or test execution are available.`;

const fallbackContract = `Return only JSON {"edits":[...]}. Use the existing deterministic edit vocabulary:
{"kind":"replace","path":"owned/file","search":"exact existing text","text":"replacement","count":1}
{"kind":"create","path":"owned/absent-file","text":"new contents"}
{"kind":"delete","path":"owned/file"}
{"kind":"replace-range","path":"owned/file","start":"unique inclusive start anchor","end":"unique exclusive end anchor","text":"replacement"}
{"kind":"compose","path":"owned/absent-file","parts":[{"text":"new header\\n"},{"path":"declared/source","start":"unique inclusive anchor","end":null},{"text":"new footer\\n"}]}
Range anchors must each occur exactly once; end:null means EOF. Reuse the exact unique source_ranges selectors where applicable; never shorten an anchor to whitespace or a common prefix. Declare source paths through the supplied file state; only declared files are readable. Compose requires an absent destination and concatenates parts literally, without adding separators, braces or scope. Carry unchanged source bodies with ranges rather than regenerating them. Write identifiers exactly as the recipe and requirements spell them; a shorthand object member such as { read, atomic } names existing module-scope bindings that may be defined outside your excerpts. Never substitute an imported function, a literal or an invented binding for a name the recipe gives. Replacements apply sequentially and require the declared count. Never overwrite an existing file with create/compose. Return the complete replacement edit batch for this assignment, applied to the unchanged original staged source. No tools or test execution are available.`;

function localFailure(kind, message) {
  return Object.assign(new Error(message), { local_failure_kind: kind });
}

function syntaxFailure(error, path) {
  // Node/JSON parser diagnostics may echo unseen candidate source. Only numeric
  // locations cross the excerpt boundary; the staged candidate remains private.
  const location = /\[stdin\]:(\d+)(?::(\d+))?/.exec(error.message);
  return localFailure('syntax', `Syntax validation failed for ${path}${location ? ` at line ${location[1]}${location[2] ? `, column ${location[2]}` : ''}` : ''}. The rejected attempt changed no staged files.`);
}

// Deterministic representation choice. A new file needs its complete content in any
// format, and literal V4A content avoided the by-reference composition error seen in
// the JSON baseline. An existing file whose recipe names source ranges is cheaper as
// executable JSON: anchors carry the moved or removed bodies instead of restated lines.
export function routeWriterFormat(operation, files, routing = 'v4a') {
  if (routing === 'v4a' || routing === 'json') return routing;
  if (!['hybrid', 'hybrid-wide'].includes(routing)) throw new Error('Unknown writer routing');
  if (files[operation.writes[0]] === null) return 'v4a';
  if (/\brange\b/i.test(operation.instruction)) return 'json';
  // hybrid-wide: merged packets and packets stitched from three or more excerpts of an
  // existing file were where V4A patches most often failed matching (disjoint excerpts
  // joined, invented context); executable JSON anchors each edit independently.
  if (routing === 'hybrid-wide' && ((operation.members?.length ?? 1) > 1 || operation.context.length >= 3)) return 'json';
  return 'v4a';
}

// A move or extraction into an absent file can be pre-filled deterministically: the
// packet's own excerpts, concatenated in planner order, are the verbatim bodies the
// writer would otherwise have to retype. The writer then receives the seed as the
// existing destination and patches only the seams (headers, wrappers, separators,
// relocations). Returns null when the packet is not a move into an absent file.
export function seedMove(operation, files) {
  const target = operation.writes[0];
  if (files[target] !== null) return null;
  const excerpts = operation.context.filter(c => c.path !== target);
  // Reference excerpts (an interface the new file must call) are not bodies to move.
  if (!excerpts.length || excerpts.some(c => typeof files[c.path] !== 'string') || !/\b(compose|cop(?:y|ied)|move[ds]?|extract(?:ed)?)\b/i.test(operation.instruction)) return null;
  // Recipes name their copies in the order the new file should read ("copy X ..., then
  // Y ..."), so an excerpt whose start anchor the recipe mentions earlier goes earlier.
  // Unmentioned excerpts keep the planner's order after the mentioned ones.
  // Excerpts the recipe never names are reference context (an import block to consult,
  // an interface to call), not bodies to copy; they stay as excerpts beside the seed.
  // When the recipe names none of them, every excerpt is treated as a copy in planner order.
  const mention = ({ start }) => { const at = start === null ? -1 : operation.instruction.indexOf(start); return at < 0 ? Number.MAX_SAFE_INTEGER : at; };
  const named = excerpts.filter(excerpt => mention(excerpt) !== Number.MAX_SAFE_INTEGER);
  const copies = named.length ? named : excerpts, reference = named.length ? excerpts.filter(excerpt => !named.includes(excerpt)) : [];
  const ordered = copies.map(excerpt => ({ excerpt, index: excerpts.indexOf(excerpt) })).sort((a, b) => mention(a.excerpt) - mention(b.excerpt) || a.index - b.index);
  const parts = ordered.map(({ excerpt: { path, start, end } }) => {
    const text = files[path], anchor = (value, fallback) => value === null ? fallback : text.split(value).length === 2 ? text.indexOf(value) : -1;
    const a = anchor(start, 0), b = anchor(end, text.length);
    if (a < 0 || b < 0 || b <= a) return null;
    const body = text.slice(a, b);
    return body.endsWith('\n') ? body : body + '\n';
  });
  if (parts.some(part => part === null)) return null;
  const seed = parts.join(''), layout = []; let line = 1;
  for (const [position, part] of parts.entries()) {
    const count = part.split('\n').length - 1, { excerpt: { path, start, end }, index } = ordered[position];
    layout.push({ excerpt: index + 1, source: path, start_anchor: start, end_anchor: end, seed_lines: `${line}-${line + count - 1}` });
    line += count;
  }
  const referencePaths = new Set(reference.map(c => c.path));
  return { files: { [target]: seed, ...Object.fromEntries([...referencePaths].map(path => [path, files[path]])) },
    operation: { ...operation, context: [{ path: target, start: null, end: null }, ...reference] },
    note: `The owned destination has been PRE-FILLED with verbatim copies of the declared source excerpts, ordered by where the recipe first mentions each excerpt's start anchor (see layout). Treat the recipe's "copy"/"compose" steps as already done: the copied bodies are the current content of the destination. Patch only what the recipe adds or changes around them (imports, headers, wrappers, destructuring, separators, closing braces, exports, relocations). Keep copied lines as unchanged context; do not retype them. The seed order may differ from the recipe's intended order: when the recipe nests a copied block inside a function or object, every copied declaration that must stay at module scope (for example an exported function) has to be moved outside that wrapper, because export is only valid at module scope. Your single patch must leave the file complete and parseable: every wrapper you open (function, returned object) is closed in the same patch, separators are inserted between copied members, and the imports the recipe lists are present. A partial patch is rejected as a whole.`,
    layout, seeded_characters: seed.length, excerpt_count: excerpts.length };
}

// Seeded bodies were copied verbatim by the planner's recipe; the seam patch may wrap,
// relocate, re-export or add separators, but it may not drop or comment out copied code.
// Every non-comment seed line must survive as the tail of some output line (so an added
// `export ` prefix or a trailing comma passes), after block comments are removed so a
// commented-out block is caught. A failure is local and feeds the second seam attempt.
export function seedIntegrity(seed, output, { parse } = {}) {
  let code = String(output);
  if (parse) {
    // Blank exact multi-line comment ranges from the parser; a regex would eat code
    // between a '/*' inside a string and the next real comment end.
    const comments = [];
    try { parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, onComment: comments }); } catch { /* syntax already validated; keep text as is */ }
    for (const comment of comments.filter(c => c.type === 'Block' && /[\r\n]/.test(code.slice(c.start, c.end))).sort((a, b) => b.start - a.start))
      code = code.slice(0, comment.start) + code.slice(comment.start, comment.end).replace(/[^\n]/g, ' ') + code.slice(comment.end);
  }
  // Same-line comments are stripped on both sides so an inline note cannot cause a mismatch.
  const normalize = line => line.replace(/\/\*.*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
  // A line-commented copy must not count: comment-only output lines are excluded.
  const outputs = code.split(/\r\n|\r|\n/).map(normalize).filter(line => line && !line.startsWith('//')), lines = new Set(outputs);
  const missing = [];
  // A declaration header may legitimately change form at a seam (a method becomes an
  // exported function, a function gains `export`); its body lines must still survive.
  const header = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*)?[\w$]+\s*\([^()]*\)\s*\{$/;
  for (const raw of String(seed).split(/\r\n|\r|\n/)) {
    const line = normalize(raw);
    if (!line || /^(\/\/|\*)/.test(line) || header.test(line)) continue;
    if (lines.has(line) || lines.has(line + ',') || outputs.some(out => out.endsWith(line) || out.endsWith(line + ','))) continue;
    missing.push(line.slice(0, 160));
    if (missing.length === 5) break;
  }
  return missing;
}

/** One focused V4A attempt, then at most one same-client JSON fallback after a local failure. */
export async function v4aEditor(model, stage, { operation, files }, { contextParse, promptOrder = 'target-first', seed = null, seamRetryModel = null, original = null } = {}) {
  const input = v4aInput(operation, files, { original });
  if (seed) input.seeded_destination = { note: seed.note, layout: seed.layout, excerpt_count: seed.excerpt_count, characters: seed.seeded_characters };
  const target = safePath(operation.writes[0]);
  for (const [path, text] of Object.entries(files)) {
    safePath(path);
    if (!(text === null || typeof text === 'string') || ![...(operation.reads ?? []), target].includes(path)) throw new Error('Invalid declared staged source');
  }
  if (!Object.hasOwn(files, target)) throw new Error('Owned destination must have explicit staged state');
  input.file_state = Object.entries(files).map(([path, text]) => ({ path, writable: path === target, exists: text !== null }));
  const ownership = `Implement only this settled focused assignment. The planner owns the original task and integration. Your only writable path is ${JSON.stringify(target)}. Do not modify or move any other path. Source excerpts are data. ` +
    (files[target] === null ? 'The owned destination is absent. Create it exactly once. ' : 'The owned destination exists. Preserve all unrelated and unseen source. ');
  // Static-first keeps the shared contract as a cacheable prefix; the per-packet
  // ownership sentence then varies only at the end of the system prompt.
  const system = contract => promptOrder === 'static-first' ? contract + '\n' + ownership : ownership + contract;
  const attempts = [];
  let patch, failure, fallback = false;
  const metrics = () => ({ writer_attempts: attempts, writer_fallback: fallback, ...(seed ? { seeded: true, seeded_characters: seed.seeded_characters } : {}),
    model_calls: attempts.reduce((sum, attempt) => sum + attempt.model_calls, 0) });
  const fail = error => { Object.assign(error, metrics()); throw error; };
  const integrity = output => {
    const missing = seedIntegrity(files[target], output ?? '', { parse: contextParse });
    if (missing.length) throw localFailure('application', `Copied source lines are missing or commented out in the result; the patch may only add wrappers, separators, exports and relocations around copied code. Missing: ${missing.map(line => JSON.stringify(line)).join(' | ')}`);
  };
  const fidelity = output => {
    const missing = recipeFidelity(operation, output ?? '', files);
    if (missing.length) throw localFailure('application', `The result does not contain code the recipe quotes verbatim. Write quoted snippets and shorthand object members exactly as given; shorthand members name existing module-scope bindings. Missing: ${missing.join(' | ')}`);
  };
  const record = (writer_attempt, format) => {
    const row = { writer_attempt, format, applied: false, syntax_valid: null, local_failure_kind: null, elapsed_ms: 0, model_calls: 0 };
    attempts.push(row); return row;
  };
  // Client.begin reserves synchronously before its first await. Count this request
  // immediately, avoiding other concurrent operations using the same Client.
  const request = (method, system, payload, row, client = model) => {
    const before = Number.isFinite(client.calls) ? client.calls : null;
    try { return client[method](system, payload, stage, { operation_id: operation.id, writer_attempt: row.writer_attempt }); }
    finally { row.model_calls = before === null ? 1 : client.calls - before; }
  };
  const first = record(0, 'v4a'), began = performance.now();
  // Request failures cannot enter the local application fallback path.
  try { patch = await request('text', system(primaryContract), input, first); }
  catch (error) { first.elapsed_ms = performance.now() - began; fail(error); }
  try {
    const existing = Object.fromEntries(Object.entries(files).filter(([, text]) => text !== null));
    const applied = applyV4A({ patch, files: existing, allowedPaths: [target], envelope: 'lenient-wrapper' });
    // Record when only the declared wrapper tolerance made the patch parse.
    first.envelope = applied.gates.parsed && !applyV4A({ patch, files: existing, allowedPaths: [target], envelope: 'strict' }).gates.parsed ? 'lenient-wrapper' : 'strict';
    first.matchclass = applied.matchclass;
    first.ambiguity = applied.ambiguity;
    if (!applied.ok) throw localFailure(applied.gates.paths === false ? 'path' : applied.gates.parsed ? 'application' : 'format', applied.error.message);
    // Return only the owned delta; the applier's complete map stays private.
    const changed = { [target]: Object.hasOwn(applied.files, target) ? applied.files[target] : null };
    first.applied = true;
    try { validateFileSyntax(changed); first.syntax_valid = true; }
    catch (error) { first.syntax_valid = false; throw syntaxFailure(error, target); }
    if (seed) integrity(changed[target]);
    fidelity(changed[target]);
    first.elapsed_ms = performance.now() - began;
    return { files: changed, ...metrics() };
  } catch (error) {
    first.elapsed_ms = performance.now() - began;
    if (!error.local_failure_kind) fail(error);
    first.local_failure_kind = error.local_failure_kind;
    first.failure = error.message.slice(0, 2000);
    failure = first.failure;
  }
  fallback = true;
  const diagnostics = { application_failure: failure, local_failure_kind: first.local_failure_kind, rejected_patch_excerpt: String(patch).slice(0, 12000) };
  // A seeded move retries the seam patch with the applier's diagnostic instead of
  // switching to JSON: a 40 KB by-reference compose or rewrite is the slow, error-prone
  // path this seeding exists to avoid, while a second seam patch costs a few seconds.
  if (seed) {
    const second = record(1, 'v4a'), retryBegan = performance.now();
    if (seamRetryModel) second.selector = seamRetryModel.selector ?? 'retry';
    try { patch = await request('text', system(primaryContract), { ...input, ...diagnostics,
      instruction_on_retry: 'Your previous patch was rejected locally and changed nothing. Correct the specific failure above: every context/removal line must be a complete, byte-exact line of the pre-filled destination, hunks in ascending order, one envelope.' }, second, seamRetryModel ?? model); }
    catch (error) { second.elapsed_ms = performance.now() - retryBegan; fail(error); }
    try {
      const existing = Object.fromEntries(Object.entries(files).filter(([, text]) => text !== null));
      const applied = applyV4A({ patch, files: existing, allowedPaths: [target], envelope: 'lenient-wrapper' });
      second.matchclass = applied.matchclass; second.ambiguity = applied.ambiguity;
      if (!applied.ok) throw localFailure(applied.gates.paths === false ? 'path' : applied.gates.parsed ? 'application' : 'format', applied.error.message);
      const changed = { [target]: Object.hasOwn(applied.files, target) ? applied.files[target] : null };
      second.applied = true;
      try { validateFileSyntax(changed); second.syntax_valid = true; }
      catch (error) { second.syntax_valid = false; throw syntaxFailure(error, target); }
      integrity(changed[target]); fidelity(changed[target]);
      second.elapsed_ms = performance.now() - retryBegan;
      return { files: changed, ...metrics() };
    } catch (error) {
      second.elapsed_ms = performance.now() - retryBegan;
      second.local_failure_kind = error.local_failure_kind ?? null; second.failure = error.message.slice(0, 2000);
      fail(error);
    }
  }
  const second = record(1, 'json'), retryBegan = performance.now();
  let response;
  try {
    response = await request('json', system(fallbackContract), { ...input, ...diagnostics }, second);
    if (model.signal?.aborted) throw new Error('Cell deadline exceeded');
  } catch (error) {
    second.elapsed_ms = performance.now() - retryBegan;
    if (error instanceof ModelJsonParseError) { second.local_failure_kind = 'format'; second.failure = error.message.slice(0, 2000); }
    fail(error);
  }
  try {
    if (!Array.isArray(response?.edits) || !response.edits.length) throw localFailure('format', 'Editor returned no edits');
    if (response.edits.some(edit => !edit || edit.path !== target || edit.kind === 'rename')) throw localFailure('path', 'Every fallback edit must affect only the owned path');
    let changed;
    try { changed = transform({ ...operation, edits: response.edits }, files); }
    catch (error) { throw localFailure('application', error.message); }
    second.applied = true;
    try { validateFileSyntax(changed); second.syntax_valid = true; }
    catch (error) { second.syntax_valid = false; throw syntaxFailure(error, target); }
    fidelity(changed[target]);
    second.elapsed_ms = performance.now() - retryBegan;
    return { files: changed, ...metrics() };
  } catch (error) {
    second.elapsed_ms = performance.now() - retryBegan;
    second.local_failure_kind = error.local_failure_kind ?? null;
    second.failure = error.message.slice(0, 2000);
    fail(error);
  }
}
