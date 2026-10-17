export const jsonFormat = `Return only one executable changeset JSON object, without prose, fences or tool calls:
{"schema_version":1,"operations":[{"id":"change","executor":"deterministic","reads":[],"writes":["src/value.mjs"],"depends_on":[],"edits":[{"kind":"replace","path":"src/value.mjs","search":"export const value = 1;","text":"export const value = 2;","count":1}]}]}
All operations are deterministic. Each needs id, executor, reads, writes, depends_on and edits. IDs start with a lowercase letter and use lowercase letters, digits, hyphens or underscores. Declare source reads and every write. Multiple operations may depend on previous IDs; staged outputs are visible to successors. Multiple edits in an operation apply in order.
Supported edits:
- create: {kind:"create",path,text}; path must be absent.
- replace: {kind:"replace",path,search,text,count:1}; search must match exactly count nonoverlapping occurrences. Include enough exact context to target the intended occurrence.
- delete: {kind:"delete",path}; path must exist.
- rename: {kind:"rename",path,to}; source and destination both owned, destination absent.
- replace-range: {kind:"replace-range",path,start,end,text}; start is a unique inclusive exact anchor, end a unique exclusive exact anchor or null for EOF.
- compose: {kind:"compose",path,parts:[{text:"literal"},{path:"source",start:"unique inclusive anchor",end:null}]}; creates absent path by literal concatenation of exact source ranges and literal text, without inferred separators.
- json-set: {kind:"json-set",path,keys:["existingParent","key"],value:true}; existing object parents, final key created or replaced.
JSON string escapes represent exact source characters. Do not normalize line endings, indentation, Unicode, strings or comments. Preserve all unrelated content.`;

export const v4aFormat = `Return only a V4A patch, starting with *** Begin Patch and ending with *** End Patch. No Markdown fence, shell command or prose.
Example:
*** Begin Patch
*** Update File: src/value.mjs
@@
-export const value = 1;
+export const value = 2;
*** End Patch
Update hunks use @@ (optionally followed by a text anchor), then lines beginning with one space for unchanged context, minus for deletion, or plus for insertion. Include exact context that identifies the intended location uniquely, especially repeated blocks. Multiple @@ hunks may update one file.
To add: *** Add File: relative/path followed by plus-prefixed new lines.
To delete: *** Delete File: relative/path.
To rename and optionally edit: *** Update File: old/path, then *** Move to: new/path, then its update hunks.
Use *** End of File after a hunk only when it must match at EOF. An existing missing final newline is preserved for updates; added files end with a newline. Paths are relative and must be allowed. Do not normalize line endings, indentation, Unicode, strings or comments. Preserve unrelated content. Context lines retain their existing bytes; added lines use the source file's first line-ending style (LF for a new file).`;

export function systemPrompt(track, format) {
  if (!['encoding', 'implementation'].includes(track) || !['json', 'v4a'].includes(format)) throw new Error('Unknown track/format');
  if (track === 'implementation' && format !== 'json') throw new Error('Implementation pilot is executable JSON only');
  const role = track === 'encoding'
    ? 'The instruction fully settles the edits and supplies all new text. Encode those exact edits; no implementation decisions or discovery are needed.'
    : 'Resolve the requested small implementation goal from the complete provided source and requirements, then emit all executable edits yourself.';
  return role + '\nYou have no tools, lookup, separate writer, review or retry. All source is supplied. Edit only allowed paths, preserve protected paths. If the instruction cannot be satisfied because required source facts contradict it, return exactly one line REFUSE: followed by a brief reason; never invent a target or emit a partial patch. Otherwise use the requested format.\n' + (format === 'json' ? jsonFormat : v4aFormat);
}
export function modelInput(fixture) {
  return { instruction: fixture.instruction, files: fixture.files, allowed_paths: fixture.allowedPaths, protected_paths: fixture.protectedPaths ?? [] };
}
export function inputContext(fixture, format, timestamp = Date.now()) {
  const context = { systemPrompt: systemPrompt(fixture.track, format), messages: [{ role: 'user', content: JSON.stringify(modelInput(fixture)), timestamp }] };
  if (Buffer.byteLength(JSON.stringify(context)) > 32768) throw new Error('Serialized model context exceeds 32KiB byte guard; no truncation');
  return context;
}
