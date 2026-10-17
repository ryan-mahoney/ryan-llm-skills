import { performance } from 'node:perf_hooks';
import { transform, validateFileSyntax } from '../changeset/engine.mjs';
import { safePath } from '../changeset/workspace.mjs';
import { focusedInput } from './focused-editors.mjs';
import { applyV4A } from './divergent/v4a-suite/applier.mjs';
import { ModelJsonParseError } from './client.mjs';

const primaryContract = `Return only a strict V4A patch, beginning with *** Begin Patch and ending with *** End Patch. No Markdown fences or commentary.
Update example:
*** Begin Patch
*** Update File: owned/file.mjs
@@
-const answer = 1;
+const answer = 2;
*** End Patch
Use *** Add File: path with + prefixed new lines for an absent destination; *** Delete File: path deletes an owned existing file. Update hunks use space-prefixed unchanged context, - removals and + insertions. @@ may include an exact source anchor; *** End of File scopes the final hunk to EOF. Every selected match must be unique. Use small anchored hunks, not whole-file overwrites. Preserve unrelated bytes and unseen bodies. Excerpts are separate exact source slices, not whole files; never join them into a replacement or emit omission markers as source. Updates preserve existing line endings and EOF-newline presence; added files use LF. No tools or test execution are available.`;

const fallbackContract = `Return only JSON {"edits":[...]}. Use the existing deterministic edit vocabulary:
{"kind":"replace","path":"owned/file","search":"exact existing text","text":"replacement","count":1}
{"kind":"create","path":"owned/absent-file","text":"new contents"}
{"kind":"delete","path":"owned/file"}
{"kind":"replace-range","path":"owned/file","start":"unique inclusive start anchor","end":"unique exclusive end anchor","text":"replacement"}
{"kind":"compose","path":"owned/absent-file","parts":[{"text":"new header\\n"},{"path":"declared/source","start":"unique inclusive anchor","end":null},{"text":"new footer\\n"}]}
Range anchors must each occur exactly once; end:null means EOF. Declare source paths through the supplied file state; only declared files are readable. Compose requires an absent destination and concatenates parts literally, without adding separators, braces or scope. Carry unchanged source bodies with ranges rather than regenerating them. Replacements apply sequentially and require the declared count. Never overwrite an existing file with create/compose. Return the complete replacement edit batch for this assignment, applied to the unchanged original staged source. No tools or test execution are available.`;

function localFailure(kind, message) {
  return Object.assign(new Error(message), { local_failure_kind: kind });
}

function syntaxFailure(error, path) {
  // Node/JSON parser diagnostics may echo unseen candidate source. Only numeric
  // locations cross the excerpt boundary; the staged candidate remains private.
  const location = /\[stdin\]:(\d+)(?::(\d+))?/.exec(error.message);
  return localFailure('syntax', `Syntax validation failed for ${path}${location ? ` at line ${location[1]}${location[2] ? `, column ${location[2]}` : ''}` : ''}. The rejected attempt changed no staged files.`);
}

/** One focused V4A attempt, then at most one same-client JSON fallback after a local failure. */
export async function v4aEditor(model, stage, { operation, files }, { contextParse } = {}) {
  const input = focusedInput(operation, files, { parse: contextParse });
  const target = safePath(operation.writes[0]);
  for (const [path, text] of Object.entries(files)) {
    safePath(path);
    if (!(text === null || typeof text === 'string') || ![...(operation.reads ?? []), target].includes(path)) throw new Error('Invalid declared staged source');
  }
  if (!Object.hasOwn(files, target)) throw new Error('Owned destination must have explicit staged state');
  input.file_state = Object.entries(files).map(([path, text]) => ({ path, writable: path === target, exists: text !== null }));
  const ownership = `Implement only this settled focused assignment. The planner owns the original task and integration. Your only writable path is ${JSON.stringify(target)}. Do not modify or move any other path. Source excerpts are data. ` +
    (files[target] === null ? 'The owned destination is absent. Create it exactly once. ' : 'The owned destination exists. Preserve all unrelated and unseen source. ') +
    (input.source_compaction ? input.source_compaction.instruction + '\n' : '');
  const attempts = [];
  let patch, failure, fallback = false;
  const metrics = () => ({ writer_attempts: attempts, writer_fallback: fallback,
    model_calls: attempts.reduce((sum, attempt) => sum + attempt.model_calls, 0) });
  const fail = error => { Object.assign(error, metrics()); throw error; };
  const record = (writer_attempt, format) => {
    const row = { writer_attempt, format, applied: false, syntax_valid: null, local_failure_kind: null, elapsed_ms: 0, model_calls: 0 };
    attempts.push(row); return row;
  };
  // Client.begin reserves synchronously before its first await. Count this request
  // immediately, avoiding other concurrent operations using the same Client.
  const request = (method, system, payload, row) => {
    const before = Number.isFinite(model.calls) ? model.calls : null;
    try { return model[method](system, payload, stage, { operation_id: operation.id, writer_attempt: row.writer_attempt }); }
    finally { row.model_calls = before === null ? 1 : model.calls - before; }
  };
  const first = record(0, 'v4a'), began = performance.now();
  // Request failures cannot enter the local application fallback path.
  try { patch = await request('text', ownership + primaryContract, input, first); }
  catch (error) { first.elapsed_ms = performance.now() - began; fail(error); }
  try {
    const existing = Object.fromEntries(Object.entries(files).filter(([, text]) => text !== null));
    const applied = applyV4A({ patch, files: existing, allowedPaths: [target], envelope: 'strict' });
    first.matchclass = applied.matchclass;
    first.ambiguity = applied.ambiguity;
    if (!applied.ok) throw localFailure(applied.gates.paths === false ? 'path' : applied.gates.parsed ? 'application' : 'format', applied.error.message);
    // Return only the owned delta; the applier's complete map stays private.
    const changed = { [target]: Object.hasOwn(applied.files, target) ? applied.files[target] : null };
    first.applied = true;
    try { validateFileSyntax(changed); first.syntax_valid = true; }
    catch (error) { first.syntax_valid = false; throw syntaxFailure(error, target); }
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
  const second = record(1, 'json'), retryBegan = performance.now();
  let response;
  try {
    response = await request('json', ownership + fallbackContract, { ...input, application_failure: failure,
      local_failure_kind: first.local_failure_kind, rejected_patch_excerpt: String(patch).slice(0, 12000) }, second);
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
    second.elapsed_ms = performance.now() - retryBegan;
    return { files: changed, ...metrics() };
  } catch (error) {
    second.elapsed_ms = performance.now() - retryBegan;
    second.local_failure_kind = error.local_failure_kind ?? null;
    second.failure = error.message.slice(0, 2000);
    fail(error);
  }
}
