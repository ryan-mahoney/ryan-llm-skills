// Synthetic small pilot: seven exact encoding edits, one impossible instruction,
// and four behavioral implementation goals. These are not mined real commits.
// Private fixture data. Only id/track/files/instruction/allowedPaths/protectedPaths
// belong in model inputs; golds, checks, references and hashes are oracle material.
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const replace = (path, search, text, count = 1) => ({ kind: 'replace', path, search, text, count });
const patch = (...sections) => ['*** Begin Patch', ...sections, '*** End Patch', ''].join('\n');
const update = (path, before, after, eof = false) => [
  `*** Update File: ${path}`, '@@',
  ...before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map(line => '-' + line),
  ...after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map(line => '+' + line),
  ...(eof ? ['*** End of File'] : []),
].join('\n');
const add = (path, text) => [`*** Add File: ${path}`, ...text.replace(/\n$/, '').split('\n').map(line => '+' + line)].join('\n');
const untouched = "// This module is outside edit ownership.\nexport const projectName = 'receipt-runner';\n";
const protectedPaths = ['untouched.mjs'];
const withUntouched = files => ({ ...files, 'untouched.mjs': untouched });
const fullReference = (files, goldFiles) => patch(...Object.keys({ ...files, ...goldFiles }).filter(path => files[path] !== goldFiles[path]).sort().map(path =>
  !Object.hasOwn(goldFiles, path) ? `*** Delete File: ${path}` : !Object.hasOwn(files, path) ? add(path, goldFiles[path]) : update(path, files[path], goldFiles[path])));
const fullEdits = (files, goldFiles) => Object.keys({ ...files, ...goldFiles }).filter(path => files[path] !== goldFiles[path]).sort().map(path =>
  !Object.hasOwn(goldFiles, path) ? { kind: 'delete', path } : !Object.hasOwn(files, path) ? { kind: 'create', path, text: goldFiles[path] } : replace(path, files[path], goldFiles[path]));
const fixtures = [];
function encoding(id, features, files, instruction, goldFiles, referenceEdits, referenceV4A) {
  fixtures.push({ id, track: 'encoding', expectedOutcome: 'edit', features, files: withUntouched(files), instruction,
    allowedPaths: [...new Set([...Object.keys(files), ...Object.keys(goldFiles)])], protectedPaths,
    goldFiles: withUntouched(goldFiles), referenceEdits, referenceV4A });
}

{
  const path = 'retry-policy.mjs';
  const before = "export const maxAttempts = 3;\nexport const retryDelayMs = 250;\n";
  const after = "export const maxAttempts = 5;\nexport const retryDelayMs = 250;\n";
  encoding('enc-replacement', ['one exact literal replacement'], { [path]: before },
    "In retry-policy.mjs replace exactly `export const maxAttempts = 3;` with `export const maxAttempts = 5;`. Preserve every other byte and the final LF. Do not edit untouched.mjs.",
    { [path]: after }, [replace(path, 'export const maxAttempts = 3;', 'export const maxAttempts = 5;')], patch(update(path, before, after)));
}
{
  const path = 'worker-options.mjs';
  const before = "export const leaseMs = 1500;\n\nexport function workerLabel(id) {\n  return `worker:${id}`;\n}\n\nexport const initialStatus = 'queued';\n";
  const after = "export const leaseMs = 2500;\n\nexport function workerLabel(id) {\n  return `worker:${id}`;\n}\n\nexport const initialStatus = 'pending';\n";
  encoding('enc-separated-edits', ['two separated edits', 'untouched intervening template literal'], { [path]: before },
    "In worker-options.mjs replace `export const leaseMs = 1500;` with `export const leaseMs = 2500;` and replace `export const initialStatus = 'queued';` with `export const initialStatus = 'pending';`. Preserve the intervening function, blank lines and final LF byte-for-byte. Do not edit untouched.mjs.",
    { [path]: after }, [replace(path, 'leaseMs = 1500', 'leaseMs = 2500'), replace(path, "initialStatus = 'queued'", "initialStatus = 'pending'")],
    patch(`*** Update File: ${path}\n@@\n-export const leaseMs = 1500;\n+export const leaseMs = 2500;\n@@\n-export const initialStatus = 'queued';\n+export const initialStatus = 'pending';`));
}
{
  const path = 'queue-limits.mjs';
  const before = 'export function primaryLimit() {\n  const limit = 8;\n  return limit;\n}\n\nexport function fallbackLimit() {\n  const limit = 8;\n  return limit;\n}\n';
  const search = 'export function fallbackLimit() {\n  const limit = 8;\n  return limit;\n}';
  const replacement = 'export function fallbackLimit() {\n  const limit = 12;\n  return limit;\n}';
  const after = 'export function primaryLimit() {\n  const limit = 8;\n  return limit;\n}\n\nexport function fallbackLimit() {\n  const limit = 12;\n  return limit;\n}\n';
  encoding('enc-duplicate-second', ['duplicate block', 'target second occurrence with unique function context'], { [path]: before },
    "In queue-limits.mjs change only fallbackLimit, the SECOND occurrence of the body `  const limit = 8;\n  return limit;`. Its complete new definition must be exactly:\nexport function fallbackLimit() {\n  const limit = 12;\n  return limit;\n}\nKeep primaryLimit and every other byte unchanged, including final LF. Do not edit untouched.mjs.",
    { [path]: after }, [replace(path, search, replacement)], patch(update(path, search, replacement)));
}
{
  const path = 'display-label.mjs';
  const before = 'export function displayLabel() {\r\n\tconst label = "Café — ready";\r\n\treturn label;\r\n}\r\nexport const buildTag = "β-7";\r\n';
  const after = 'export function displayLabel() {\r\n\tconst label = "Résumé – prêt";\r\n\treturn label;\r\n}\r\nexport const buildTag = "β-7";\r\n';
  encoding('enc-crlf-tabs-unicode', ['CRLF', 'tab indentation', 'accented literals and distinct Unicode dashes'], { [path]: before },
    'In display-label.mjs replace only the exact line `\tconst label = "Café — ready";` with `\tconst label = "Résumé – prêt";`. Each displayed \\t denotes the actual single tab already supplied in source. Preserve all CRLF terminators, the final CRLF, all tabs and buildTag byte-for-byte. The replacement uses an en dash (–), while the old literal has an em dash (—). Do not edit untouched.mjs.',
    { [path]: after }, [replace(path, '\tconst label = "Café — ready";', '\tconst label = "Résumé – prêt";')], patch(update(path, before, after)));
}
{
  const path = 'stop-reason.mjs';
  const before = "export const retryBudget = 2;\nexport const stopReason = 'deadline';";
  const after = "export const retryBudget = 2;\nexport const stopReason = 'call-timeout';";
  encoding('enc-eof-no-newline', ['last-line edit', 'absent final newline'], { [path]: before },
    "Replace the final line of stop-reason.mjs, `export const stopReason = 'deadline';`, with `export const stopReason = 'call-timeout';`. Preserve the first line and its LF. The file has NO trailing newline; the result must also have no trailing newline. Do not edit untouched.mjs.",
    { [path]: after }, [replace(path, "stopReason = 'deadline'", "stopReason = 'call-timeout'")], patch(update(path, before, after, true)));
}
{
  const files = {
    'legacy-format.mjs': "export function formatRun(id) {\n  return 'run:' + id;\n}\n",
    'main.mjs': "import { formatRun } from './legacy-format.mjs';\nexport const describe = id => formatRun(id);\n",
    'legacy-notes.mjs': "export const note = 'obsolete adapter';\n",
  };
  const goldFiles = {
    'run-format.mjs': "export function formatRun(id) {\n  return 'job:' + id;\n}\n",
    'main.mjs': "import { formatRun } from './run-format.mjs';\nexport const describe = id => formatRun(id);\n",
    'format-version.mjs': 'export const formatVersion = 2;\n',
  };
  encoding('enc-create-delete-move', ['move with one-line edit', 'create', 'delete', 'import update'], files,
    "Move legacy-format.mjs to run-format.mjs, preserving its contents except replace `  return 'run:' + id;` with `  return 'job:' + id;`. In main.mjs replace `import { formatRun } from './legacy-format.mjs';` with `import { formatRun } from './run-format.mjs';`. Delete legacy-notes.mjs. Create format-version.mjs with exactly `export const formatVersion = 2;` followed by one LF. All remaining files retain exactly one final LF. The old move source and deleted file must be absent. Do not edit untouched.mjs.", goldFiles,
    [{ kind: 'rename', path: 'legacy-format.mjs', to: 'run-format.mjs' }, replace('run-format.mjs', "return 'run:' + id;", "return 'job:' + id;"), replace('main.mjs', './legacy-format.mjs', './run-format.mjs'), { kind: 'delete', path: 'legacy-notes.mjs' }, { kind: 'create', path: 'format-version.mjs', text: goldFiles['format-version.mjs'] }],
    patch("*** Update File: legacy-format.mjs\n*** Move to: run-format.mjs\n@@\n export function formatRun(id) {\n-  return 'run:' + id;\n+  return 'job:' + id;\n }", update('main.mjs', files['main.mjs'], goldFiles['main.mjs']), '*** Delete File: legacy-notes.mjs', add('format-version.mjs', goldFiles['format-version.mjs'])));
}
{
  const path = 'invoice.mjs';
  const before = 'function calculateFee(amount) {\n  return amount * 2;\n}\nexport const invoiceTotal = amount => calculateFee(amount);\n';
  const after = 'function calculateCharge(amount) {\n  return amount * 3;\n}\nexport const invoiceTotal = amount => calculateCharge(amount);\n';
  encoding('enc-dependent-edits', ['same-file dependent edits', 'definition and call-site rename'], { [path]: before },
    'In invoice.mjs rename calculateFee to calculateCharge at both its definition and call site. Then change the renamed function to this exact definition:\nfunction calculateCharge(amount) {\n  return amount * 3;\n}\nThe final export line must be exactly `export const invoiceTotal = amount => calculateCharge(amount);`. Preserve the existing LF line endings and final LF. One operation with ordered edits is allowed; no artificial split is required. Do not edit untouched.mjs.',
    { [path]: after }, [replace(path, 'calculateFee', 'calculateCharge', 2), replace(path, 'function calculateCharge(amount) {\n  return amount * 2;\n}', 'function calculateCharge(amount) {\n  return amount * 3;\n}')], patch(update(path, before, after)));
}
fixtures.push({ id: 'enc-impossible-refusal', track: 'encoding', expectedOutcome: 'refusal',
  features: ['impossible settled instruction', 'correct refusal scored separately from patch parsing'],
  files: withUntouched({ 'schedule.mjs': "export function scheduleTask(id) {\n  return { id, status: 'queued' };\n}\n" }),
  instruction: 'In schedule.mjs replace the body of the existing stopWorker function with `return false;`. If stopWorker is absent, do not invent it, edit any file or emit a patch. Return only REFUSE: followed by a brief reason. All supplied source is complete; there is no other file to inspect.',
  allowedPaths: ['schedule.mjs'], protectedPaths,
  referenceRefusal: 'REFUSE: schedule.mjs does not define stopWorker.',
});

function implementation(id, features, files, instruction, goldFiles, check) {
  const source = withUntouched(files), gold = withUntouched(goldFiles);
  fixtures.push({ id, track: 'implementation', expectedOutcome: 'edit', features, files: source, instruction: instruction + '\nAll source is supplied. Do not edit untouched.mjs. One operation spanning multiple owned files is valid.',
    allowedPaths: [...new Set([...Object.keys(files), ...Object.keys(goldFiles)])], protectedPaths,
    goldFiles: gold, check, referenceEdits: fullEdits(source, gold), referenceV4A: fullReference(source, gold) });
}

implementation('impl-duration-helper', ['new helper', 'import and barrel export', 'rounding and invalid-input edges'], {
  'wait-options.mjs': "export function waitOptions(seconds = 1) {\n  return { timeoutMs: seconds * 1000, pollMs: 25 };\n}\nexport const waitLabel = 'bounded-wait';\n",
  'index.mjs': "export { waitOptions, waitLabel } from './wait-options.mjs';\n",
}, 'Create duration.mjs exporting secondsToMilliseconds(seconds). Accept only finite nonnegative numbers, rejecting other values with TypeError. Return Math.ceil(seconds * 1000), including zero. Make waitOptions(seconds = 1) use that helper for timeoutMs; retain pollMs 25 and waitLabel. Export the new helper through index.mjs while retaining its current public exports.', {
  'duration.mjs': "export function secondsToMilliseconds(seconds) {\n  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new TypeError('Invalid seconds');\n  return Math.ceil(seconds * 1000);\n}\n",
  'wait-options.mjs': "import { secondsToMilliseconds } from './duration.mjs';\nexport function waitOptions(seconds = 1) {\n  return { timeoutMs: secondsToMilliseconds(seconds), pollMs: 25 };\n}\nexport const waitLabel = 'bounded-wait';\n",
  'index.mjs': "export { waitOptions, waitLabel } from './wait-options.mjs';\nexport { secondsToMilliseconds } from './duration.mjs';\n",
}, `import assert from 'node:assert/strict';
import { secondsToMilliseconds, waitOptions, waitLabel } from '/work/index.mjs';
assert.equal(secondsToMilliseconds(0), 0);
assert.equal(secondsToMilliseconds(0.0011), 2);
assert.equal(secondsToMilliseconds(1.25), 1250);
for (const value of [-1, NaN, Infinity, -Infinity, '1', null, undefined]) assert.throws(() => secondsToMilliseconds(value), TypeError);
assert.deepEqual(waitOptions(), {timeoutMs:1000,pollMs:25});
assert.deepEqual(waitOptions(0.0001), {timeoutMs:1,pollMs:25});
assert.throws(() => waitOptions(-1), TypeError);
assert.equal(waitLabel, 'bounded-wait');
`);

implementation('impl-receipt-api-migration', ['API migration', 'update all callers', 'status and PID validation'], {
  'receipt.mjs': "export function receipt(status, pid) {\n  return { status, pid };\n}\n",
  'queue.mjs': "import { receipt } from './receipt.mjs';\nexport const queuedReceipt = () => receipt('queued', null);\nexport const runningReceipt = pid => receipt('running', pid);\nexport const doneReceipt = pid => receipt('done', pid);\n",
  'index.mjs': "export { receipt } from './receipt.mjs';\nexport { queuedReceipt, runningReceipt, doneReceipt } from './queue.mjs';\n",
}, 'Replace the positional receipt(status,pid) public API with createReceipt({status,pid}). Remove the old receipt export and migrate every queue caller and barrel export. Valid statuses are queued, running and done; reject any other status with TypeError. Queued receipts always have pid:null, ignoring a supplied pid. Running/done require a positive integer pid or throw TypeError. Return a new plain {status,pid} object without mutating the input. Preserve queuedReceipt(), runningReceipt(pid) and doneReceipt(pid) as public functions.', {
  'receipt.mjs': "export function createReceipt({ status, pid }) {\n  if (!['queued', 'running', 'done'].includes(status)) throw new TypeError('Invalid status');\n  if (status === 'queued') return { status, pid: null };\n  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('Invalid pid');\n  return { status, pid };\n}\n",
  'queue.mjs': "import { createReceipt } from './receipt.mjs';\nexport const queuedReceipt = () => createReceipt({ status: 'queued' });\nexport const runningReceipt = pid => createReceipt({ status: 'running', pid });\nexport const doneReceipt = pid => createReceipt({ status: 'done', pid });\n",
  'index.mjs': "export { createReceipt } from './receipt.mjs';\nexport { queuedReceipt, runningReceipt, doneReceipt } from './queue.mjs';\n",
}, `import assert from 'node:assert/strict';
import * as api from '/work/index.mjs';
import * as module from '/work/receipt.mjs';
assert.equal('receipt' in api, false); assert.equal('receipt' in module, false);
assert.deepEqual(api.queuedReceipt(), {status:'queued',pid:null});
assert.deepEqual(api.runningReceipt(23), {status:'running',pid:23});
assert.deepEqual(api.doneReceipt(7), {status:'done',pid:7});
const input = Object.freeze({status:'queued',pid:99});
assert.deepEqual(api.createReceipt(input), {status:'queued',pid:null});
for (const status of ['missing', '', undefined]) assert.throws(() => api.createReceipt({status,pid:1}), TypeError);
for (const pid of [0,-1,1.2,NaN,Infinity,'3',null,undefined]) {
  assert.throws(() => api.runningReceipt(pid), TypeError);
  assert.throws(() => api.doneReceipt(pid), TypeError);
}
`);

implementation('impl-header-normalization', ['shared normalization', 'integration and export', 'duplicate keys and no mutation'], {
  'headers.mjs': "export function normalizeHeaders(headers = {}) {\n  return headers;\n}\n",
  'request.mjs': "import { normalizeHeaders } from './headers.mjs';\nexport function createRequest(headers) {\n  return { method: 'GET', headers: normalizeHeaders(headers) };\n}\n",
  'index.mjs': "export { createRequest } from './request.mjs';\n",
}, 'Implement normalizeHeaders(input) for an omitted input, an object of string values, or an array of [string,string] pairs. Return a fresh ordinary object whose keys and values are trimmed and whose keys are lowercased; duplicate normalized keys use the last value, and empty values are valid. Reject empty normalized keys or non-string keys/values with TypeError. Do not mutate input. Treat __proto__ as an ordinary own data property, without changing the output prototype. Make createRequest preserve method GET and add x-client:receipt-runner only when the normalized caller headers omit x-client. Export normalizeHeaders as well as createRequest from index.mjs.', {
  'headers.mjs': "export function normalizeHeaders(input = {}) {\n  const entries = Array.isArray(input) ? input : Object.entries(input);\n  return Object.fromEntries(entries.map(([key, value]) => {\n    if (typeof key !== 'string' || typeof value !== 'string' || !key.trim()) throw new TypeError('Invalid header');\n    return [key.trim().toLowerCase(), value.trim()];\n  }));\n}\n",
  'request.mjs': "import { normalizeHeaders } from './headers.mjs';\nexport function createRequest(headers) {\n  const normalized = normalizeHeaders(headers);\n  if (!Object.hasOwn(normalized, 'x-client')) normalized['x-client'] = 'receipt-runner';\n  return { method: 'GET', headers: normalized };\n}\n",
  'index.mjs': "export { createRequest } from './request.mjs';\nexport { normalizeHeaders } from './headers.mjs';\n",
}, `import assert from 'node:assert/strict';
import { normalizeHeaders, createRequest } from '/work/index.mjs';
assert.deepEqual(normalizeHeaders(), {});
const source = Object.freeze({' X-Trace ': ' abc ', Empty: ''});
assert.deepEqual(normalizeHeaders(source), {'x-trace':'abc',empty:''});
assert.deepEqual(source, {' X-Trace ': ' abc ', Empty: ''});
assert.deepEqual(normalizeHeaders([['X-ID','one'],[' x-id ',' two ']]), {'x-id':'two'});
const safe = normalizeHeaders([['__proto__','data']]);
assert.equal(Object.getPrototypeOf(safe), Object.prototype); assert.equal(Object.hasOwn(safe,'__proto__'), true); assert.equal(safe.__proto__, 'data');
for (const input of [[[' ','x']],[['x',2]],[[2,'x']],{x:null}]) assert.throws(() => normalizeHeaders(input), TypeError);
assert.deepEqual(createRequest(), {method:'GET',headers:{'x-client':'receipt-runner'}});
assert.deepEqual(createRequest({' X-CLIENT ':' custom '}), {method:'GET',headers:{'x-client':'custom'}});
assert.deepEqual(createRequest({'X-CLIENT':''}), {method:'GET',headers:{'x-client':''}});
`);

implementation('impl-dependency-order', ['multi-module integration', 'dependency traversal', 'missing dependency and cycle edges'], {
  'graph.mjs': "export function dependencyOrder(graph) {\n  return Object.keys(graph);\n}\n",
  'jobs.mjs': "import { dependencyOrder } from './graph.mjs';\nexport function planJobs(graph) {\n  return dependencyOrder(graph).map(id => ({ id, ready: true }));\n}\n",
  'index.mjs': "export { planJobs } from './jobs.mjs';\n",
}, 'Make dependencyOrder(graph) return each own enumerable graph key once, after all its dependencies. Graph values are arrays of dependency IDs. Define deterministic ordering by visiting graph keys in Object.keys order, recursively visiting dependencies in their listed order, and appending a key when its dependencies finish. Throw an Error for a dependency absent from the graph or any cycle, including a self-cycle; do not mutate the graph or its arrays. Keep planJobs(graph) returning {id,ready:true} rows in that order, and export dependencyOrder through index.mjs alongside planJobs. An empty graph returns an empty list.', {
  'graph.mjs': "export function dependencyOrder(graph) {\n  const active = new Set(), done = new Set(), ordered = [];\n  function visit(id) {\n    if (!Object.hasOwn(graph, id)) throw new Error('Missing dependency');\n    if (active.has(id)) throw new Error('Dependency cycle');\n    if (done.has(id)) return;\n    active.add(id);\n    for (const dependency of graph[id]) visit(dependency);\n    active.delete(id); done.add(id); ordered.push(id);\n  }\n  for (const id of Object.keys(graph)) visit(id);\n  return ordered;\n}\n",
  'jobs.mjs': "import { dependencyOrder } from './graph.mjs';\nexport function planJobs(graph) {\n  return dependencyOrder(graph).map(id => ({ id, ready: true }));\n}\n",
  'index.mjs': "export { planJobs } from './jobs.mjs';\nexport { dependencyOrder } from './graph.mjs';\n",
}, `import assert from 'node:assert/strict';
import { dependencyOrder, planJobs } from '/work/index.mjs';
const graph = Object.freeze({ship:Object.freeze(['test','bundle']),test:Object.freeze(['build']),bundle:Object.freeze(['build']),build:Object.freeze([]),docs:Object.freeze([])});
assert.deepEqual(dependencyOrder(graph), ['build','test','bundle','ship','docs']);
assert.deepEqual(planJobs(graph), ['build','test','bundle','ship','docs'].map(id=>({id,ready:true})));
assert.deepEqual(dependencyOrder({}), []);
assert.deepEqual(dependencyOrder({a:['b','b'],b:[]}), ['b','a']);
assert.throws(() => dependencyOrder({a:['missing']}), Error);
assert.throws(() => dependencyOrder({a:['b'],b:['a']}), Error);
assert.throws(() => dependencyOrder({a:['a']}), Error);
`);

for (const fixture of fixtures) {
  fixture.hashes = { source: hash(fixture.files), instruction: hash(fixture.instruction),
    ...(fixture.goldFiles ? { gold: hash(fixture.goldFiles) } : {}), ...(fixture.check ? { check: hash(fixture.check) } : {}) };
  fixture.hashes.fixture = hash(fixture);
}
export { fixtures };
export const fixtureCorpusHash = hash(fixtures);
