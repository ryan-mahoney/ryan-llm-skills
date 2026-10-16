// Curator command; never called by a gym worker. Existing scenario IDs are overwritten
// only on explicit invocation. Base for all emitted paths: this repository.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cases = [
  {
    id: 'invoice-rollup', phase: 'train',
    files: {
      'src/invoice.mjs': 'export function total(lines) { return lines.reduce((n, x) => n + x.priceCents * x.quantity, 0); }\n',
      'src/format.mjs': 'export function formatCents(cents) { return String(cents); }\n',
      'config.json': '{"currency":"USD","version":1,"features":{"invoice":false}}\n',
      'keep.txt': 'preserve this exact text\n',
    },
    spec: `Implement invoice totals. In src/invoice.mjs replace total with an exported summarize(lines, discountBps=0) that returns {subtotalCents,discountCents,totalCents}. Every line needs nonnegative safe integer priceCents and quantity; lines must be an array; discountBps is an integer in 0..10000. Reject invalid values and unsafe multiplication/sums with RangeError. Round discount to nearest cent, with half cents rounding up, without losing integer precision. Preserve exported total(lines) as summarize(lines).totalCents. Empty lines return zeros.
In src/format.mjs implement formatCents(cents): require safe integer cents, return dollars with exactly two decimal places, e.g. 123 -> "$1.23", -5 -> "-$0.05", 0 -> "$0.00"; reject other values with RangeError. Preserve exact cent precision even near MAX_SAFE_INTEGER.
Set config.json version to 2 and features.invoice to true, preserving currency.
Execution classification: the invoice algorithm uses involved; formatter uses simple; config changes use deterministic. Keep unrelated files unchanged.`,
    grade: String.raw`const m=await moduleAt('src/invoice.mjs'), f=await moduleAt('src/format.mjs');
a.deepEqual(m.summarize([{priceCents:101,quantity:3}],5000),{subtotalCents:303,discountCents:152,totalCents:151});
a.deepEqual(m.summarize([],0),{subtotalCents:0,discountCents:0,totalCents:0});
a.equal(m.total([{priceCents:50,quantity:2}]),100);
for(const x of [null,[{priceCents:-1,quantity:2}],[{priceCents:1,quantity:0.5}],[{priceCents:Number.MAX_SAFE_INTEGER,quantity:2}]]) a.throws(()=>m.summarize(x),RangeError);
for(const d of [-1,10001,0.5,NaN]) a.throws(()=>m.summarize([],d),RangeError);
a.deepEqual(m.summarize([{priceCents:Number.MAX_SAFE_INTEGER,quantity:1}],10000),{subtotalCents:Number.MAX_SAFE_INTEGER,discountCents:Number.MAX_SAFE_INTEGER,totalCents:0});
a.equal(f.formatCents(123),'$1.23'); a.equal(f.formatCents(-5),'-$0.05'); a.equal(f.formatCents(0),'$0.00'); a.equal(f.formatCents(Number.MAX_SAFE_INTEGER),'$90071992547409.91');
for(const n of [NaN,Infinity,1.1,'10']) a.throws(()=>f.formatCents(n),RangeError);
const c=json('config.json'); a.equal(c.version,2); a.equal(c.features.invoice,true); a.equal(c.currency,'USD');`,
  },
  {
    id: 'tenant-records', phase: 'train',
    files: {
      'src/store.mjs': 'export function list(records, tenantId) { return records; }\nexport function remove(records, tenantId, id) { return records.filter(r => r.id !== id); }\n',
      'src/label.mjs': 'export function label(record) { return record.name; }\n',
      'config.json': '{"features":{"tenantIsolation":false},"pageSize":25}\n',
      'keep.txt': 'preserve this exact text\n',
    },
    spec: `Implement tenant-scoped immutable helpers. list(records,tenantId) returns only records whose tenantId strictly equals a nonempty string tenantId. remove(records,tenantId,id) removes only the matching tenant's matching id. upsert(records,tenantId,record) replaces matching id within that tenant at the same array position, or appends; it must reject a record whose tenantId differs, empty/non-string id, or invalid tenantId with TypeError. list/remove/upsert reject an invalid tenantId with TypeError. Do not mutate the input array or objects, including frozen inputs. Keep references to unchanged records; replacements use the supplied record. Same id can exist in multiple tenants.
Implement label(record) in src/label.mjs as trimmed nonempty name followed by " (#ID)"; blank or absent name becomes "Untitled". Do not mutate the record.
Enable features.tenantIsolation preserving pageSize. Execution classification: store involved, label simple, config deterministic. Keep unrelated files unchanged.`,
    grade: String.raw`const m=await moduleAt('src/store.mjs'), f=await moduleAt('src/label.mjs');
const x=Object.freeze({id:'same',tenantId:'a',name:'One'}), y=Object.freeze({id:'same',tenantId:'b',name:'Two'}), rows=Object.freeze([x,y]);
a.deepEqual(m.list(rows,'a'),[x]); a.deepEqual(m.remove(rows,'a','same'),[y]); a.equal(m.remove(rows,'a','absent')[1],y);
const z={id:'same',tenantId:'a',name:'New'}; a.deepEqual(m.upsert(rows,'a',z),[z,y]); a.equal(m.upsert(rows,'a',z)[1],y);
const fresh={id:'new',tenantId:'a',name:'N'}; a.deepEqual(m.upsert(rows,'a',fresh),[x,y,fresh]); a.deepEqual(rows,[x,y]);
for(const tenant of ['',null,3]) { a.throws(()=>m.list(rows,tenant),TypeError); a.throws(()=>m.remove(rows,tenant,'same'),TypeError); a.throws(()=>m.upsert(rows,tenant,z),TypeError); }
a.throws(()=>m.upsert(rows,'a',y),TypeError); a.throws(()=>m.upsert(rows,'a',{id:'',tenantId:'a'}),TypeError);
a.equal(f.label({id:'q',name:'  Hello  '}),'Hello (#q)'); a.equal(f.label({id:'q',name:'  '}),'Untitled (#q)'); a.equal(f.label({id:'q'}),'Untitled (#q)');
a.equal(json('config.json').features.tenantIsolation,true); a.equal(json('config.json').pageSize,25);`,
  },
  {
    id: 'mechanical-migration', phase: 'train',
    files: { 'src/settings.mjs': 'export const endpoint = "/v1/items";\nexport const timeout = 10;\n', 'old.txt': 'retained content\n', 'obsolete.txt': 'remove me\n', 'config.json': '{"version":1,"flags":{"ready":false},"keep":17}\n', 'keep.txt': 'preserve this exact text\n' },
    spec: `Use only deterministic operations. Change endpoint in src/settings.mjs from /v1/items to /v2/items. In a separate dependent operation rename the exported constant endpoint to apiEndpoint while keeping its newly changed value. Change timeout from 10 to 30. Rename old.txt to archive.txt preserving contents; remove obsolete.txt; create notes.txt with exactly "Migration ready\\n" (a newline). Set config version=2 and flags.ready=true, preserving keep. Keep unrelated files unchanged.`,
    grade: String.raw`const m=await moduleAt('src/settings.mjs'); a.equal(m.apiEndpoint,'/v2/items'); a.equal(m.endpoint,undefined); a.equal(m.timeout,30);
a.equal(text('archive.txt'),'retained content\n'); a.equal(existsSync(join(repo,'old.txt')),false); a.equal(existsSync(join(repo,'obsolete.txt')),false); a.equal(text('notes.txt'),'Migration ready\n');
a.deepEqual(json('config.json'),{version:2,flags:{ready:true},keep:17});
a.equal(plan.operations.every(o=>o.executor==='deterministic'),true); a.ok(plan.operations.some(o=>o.depends_on.length));`,
  },
  {
    id: 'cursor-pagination', phase: 'holdout',
    files: { 'src/page.mjs': 'export function page(records, options) { return {items:records,nextCursor:null}; }\n', 'src/summary.mjs': 'export function summary(count) { return String(count); }\n', 'config.json': '{"pagination":"offset","keep":true}\n', 'keep.txt': 'preserve this exact text\n' },
    spec: `Implement page(records,{tenantId,after=null,limit=2}) returning {items,nextCursor}. Require nonempty string tenantId and integer limit 1..100; invalid values throw TypeError. Filter to tenant first, sort ascending by ASCII string id without mutating inputs. after=null starts at beginning; otherwise after must match an id in the filtered tenant records or throw RangeError. Return up to limit records strictly after cursor. nextCursor equals last returned id only if more filtered records remain, otherwise null. Empty result has null cursor. Inputs have unique nonempty string IDs within a tenant.
Implement summary(count): nonnegative safe integer required (RangeError otherwise), 0 -> "No records", 1 -> "1 record", all other valid counts -> "N records".
Set config pagination="cursor", preserve keep. Execution classification: page involved, summary simple, config deterministic. Keep unrelated files unchanged.`,
    grade: String.raw`const m=await moduleAt('src/page.mjs'), f=await moduleAt('src/summary.mjs');
const rows=Object.freeze([{id:'c',tenantId:'a'},{id:'a',tenantId:'b'},{id:'a',tenantId:'a'},{id:'b',tenantId:'a'}].map(Object.freeze));
a.deepEqual(m.page(rows,{tenantId:'a'}),{items:[rows[2],rows[3]],nextCursor:'b'});
a.deepEqual(m.page(rows,{tenantId:'a',after:'b',limit:1}),{items:[rows[0]],nextCursor:null});
a.deepEqual(m.page(rows,{tenantId:'a',after:'c'}),{items:[],nextCursor:null}); a.deepEqual(m.page([],{tenantId:'a'}),{items:[],nextCursor:null});
a.throws(()=>m.page(rows,{tenantId:'b',after:'b'}),RangeError);
for(const limit of [0,101,1.5,'2']) a.throws(()=>m.page(rows,{tenantId:'a',limit}),TypeError);
a.throws(()=>m.page(rows,{tenantId:''}),TypeError); a.equal(rows[0].id,'c');
a.equal(f.summary(0),'No records');a.equal(f.summary(1),'1 record');a.equal(f.summary(2),'2 records');a.throws(()=>f.summary(-1),RangeError);
a.deepEqual(json('config.json'),{pagination:'cursor',keep:true});`,
  },
  {
    id: 'retry-policy', phase: 'holdout',
    files: { 'src/retry.mjs': 'export function retryDelay(attempt, options) { return 0; }\n', 'src/status.mjs': 'export function statusLabel(status) { return String(status); }\n', 'config.json': '{"retry":false,"keep":"value"}\n', 'keep.txt': 'preserve this exact text\n' },
    spec: `Implement retryDelay(attempt,{baseMs=100,capMs=10000,retryAfterMs=null}={}). attempt must be a nonnegative safe integer; baseMs and capMs must be nonnegative finite numbers; retryAfterMs must be null or a nonnegative finite number. Invalid inputs throw RangeError. Return min(capMs, max(baseMs*2**attempt,retryAfterMs ?? 0)). Avoid NaN for baseMs=0 and huge attempts: exponential delay is always zero in that case. Huge positive exponential delay saturates at capMs.
Implement statusLabel(status): integer 200..299 -> "success", 429 -> "rate-limited", integer 500..599 -> "retryable", all other values including strings/fractions -> "terminal".
Enable config retry and preserve keep. Execution classification: retry involved, status simple, config deterministic. Keep unrelated files unchanged.`,
    grade: String.raw`const m=await moduleAt('src/retry.mjs'), f=await moduleAt('src/status.mjs');
a.equal(m.retryDelay(0),100); a.equal(m.retryDelay(3),800); a.equal(m.retryDelay(2,{baseMs:100,capMs:300}),300); a.equal(m.retryDelay(0,{retryAfterMs:500}),500);
a.equal(m.retryDelay(Number.MAX_SAFE_INTEGER,{baseMs:0}),0);a.equal(m.retryDelay(Number.MAX_SAFE_INTEGER),10000);a.equal(m.retryDelay(10,{baseMs:0,retryAfterMs:7}),7);
for(const n of [-1,0.5,Infinity,'1']) a.throws(()=>m.retryDelay(n),RangeError);
for(const o of [{baseMs:-1},{capMs:Infinity},{retryAfterMs:-1},{baseMs:'3'}]) a.throws(()=>m.retryDelay(0,o),RangeError);
for(const [x,y] of [[200,'success'],[299,'success'],[429,'rate-limited'],[500,'retryable'],[599,'retryable'],[200.5,'terminal'],['200','terminal'],[404,'terminal']]) a.equal(f.statusLabel(x),y);
a.deepEqual(json('config.json'),{retry:true,keep:'value'});`,
  },
  {
    id: 'cross-file-contract', phase: 'train',
    files: {
      'src/quantity.mjs': 'export function parseQty(value) { return Number(value); }\n',
      'src/quote.mjs': 'import { parseQty } from "./quantity.mjs";\nexport function quote(priceCents, rawQty) { return priceCents * parseQty(rawQty); }\n',
      'src/receipt.mjs': 'import { quote } from "./quote.mjs";\nexport function receipt(priceCents, rawQty) { return `${quote(priceCents, rawQty)} cents`; }\n',
      'config.json': '{"version":1,"keep":"yes"}\n', 'keep.txt': 'preserve this exact text\n',
    },
    spec: `First perform a deterministic operation renaming parseQty to parseQuantity in the quantity export and quote import/call. Then in a dependent involved operation, change parseQuantity(value) to return {units,source}. Accept nonnegative safe integer numbers with source="number", or trimmed nonempty strings of ASCII digits whose parsed value is a nonnegative safe integer with source="string". Reject all other inputs with RangeError. Leading zeros are valid. Update quote(priceCents,rawQty) to consume the new object and return {quantity:units,subtotalCents:priceCents*units}. priceCents must be a nonnegative safe integer and the product must be safe, otherwise RangeError.
In a separate simple operation, update receipt to consume the new quote object and return "Q units: C cents" with Q replaced by quantity and C by subtotalCents; for example receipt(125,"2") returns "2 units: 250 cents". This operation must depend on and read the updated quote module. Keep its public signature. No old parseQty export remains. Set config version=2 preserving keep using deterministic edits. Preserve unrelated files.`,
    grade: String.raw`const q=await moduleAt('src/quantity.mjs'), m=await moduleAt('src/quote.mjs'), r=await moduleAt('src/receipt.mjs');
a.deepEqual(q.parseQuantity(' 002 '),{units:2,source:'string'});a.deepEqual(q.parseQuantity(0),{units:0,source:'number'});a.equal(q.parseQty,undefined);
for(const v of ['', ' ', '-1', '1.5', '1e2', true, null, -1, 0.5, '9007199254740992'])a.throws(()=>q.parseQuantity(v),RangeError);
a.deepEqual(m.quote(125,'2'),{quantity:2,subtotalCents:250});a.equal(r.receipt(125,'2'),'2 units: 250 cents');a.equal(r.receipt(0,'0'),'0 units: 0 cents');
a.throws(()=>m.quote(Number.MAX_SAFE_INTEGER,2),RangeError);a.throws(()=>m.quote(-1,2),RangeError);
a.deepEqual(json('config.json'),{version:2,keep:'yes'});
const consumer=plan.operations.find(o=>o.executor==='simple'&&o.writes.includes('src/receipt.mjs'));a.ok(consumer);a.ok(consumer.reads.includes('src/quote.mjs'));a.ok(consumer.depends_on.length);`,
  },
  {
    id: 'independent-formatters', phase: 'train',
    files: {
      'src/count.mjs': 'export function countLabel(count) { return String(count); }\n',
      'src/name.mjs': 'export function displayName(first,last) { return first; }\n',
      'src/status.mjs': 'export function statusLabel(enabled) { return String(enabled); }\n',
      'src/duration.mjs': 'export function durationLabel(seconds) { return String(seconds); }\n',
      'config.json': '{"version":1,"keep":true}\n', 'keep.txt': 'preserve this exact text\n',
    },
    spec: `Implement four independent formatting helpers, one simple operation per module, with no cross-module dependencies. They share no imports or state.
src/count.mjs countLabel(count): require a nonnegative safe integer (RangeError otherwise); zero returns "No items", one returns "1 item", other values return "N items" with N replaced by count.
src/name.mjs displayName(first,last): require both arguments to be strings (TypeError otherwise), trim each, join nonempty parts with one space; if both are blank return "Anonymous".
src/status.mjs statusLabel(enabled): accept only booleans, true returns "Enabled", false returns "Disabled"; other values throw TypeError.
src/duration.mjs durationLabel(seconds): require a nonnegative safe integer (RangeError otherwise); return "M minutes S seconds", substituting whole minutes and remaining seconds, retaining those exact plural words even for 1. Example 61 returns "1 minutes 1 seconds".
Set config version to 2 preserving keep with a deterministic operation. Keep unrelated files unchanged.`,
    grade: String.raw`const c=await moduleAt('src/count.mjs'),n=await moduleAt('src/name.mjs'),s=await moduleAt('src/status.mjs'),d=await moduleAt('src/duration.mjs');
a.equal(c.countLabel(0),'No items');a.equal(c.countLabel(1),'1 item');a.equal(c.countLabel(23),'23 items');
for(const x of [-1,1.2,'2',NaN,Infinity])a.throws(()=>c.countLabel(x),RangeError);
a.equal(n.displayName('  Ada ',' Lovelace  '),'Ada Lovelace');a.equal(n.displayName('',' X '),'X');a.equal(n.displayName('  ',' '),'Anonymous');a.throws(()=>n.displayName(null,'x'),TypeError);
a.equal(s.statusLabel(true),'Enabled');a.equal(s.statusLabel(false),'Disabled');for(const x of [0,1,'true',null])a.throws(()=>s.statusLabel(x),TypeError);
a.equal(d.durationLabel(0),'0 minutes 0 seconds');a.equal(d.durationLabel(61),'1 minutes 1 seconds');a.equal(d.durationLabel(125),'2 minutes 5 seconds');for(const x of [-1,0.5,'2',Infinity])a.throws(()=>d.durationLabel(x),RangeError);
a.deepEqual(json('config.json'),{version:2,keep:true});a.equal(plan.operations.filter(o=>o.executor==='simple').length,4);a.ok(plan.operations.some(o=>o.executor==='deterministic'));`,
  },
];
for (const item of cases) {
  const folder = join(root, 'scenarios/spec-changeset-plan', item.id);
  const put = (path, text) => { const full = join(folder, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); };
  for (const [path, text] of Object.entries(item.files)) put('input/repository/' + path, text);
  put('input/package/spec.md', '# ' + item.id + '\n\n' + item.spec + '\n');
  put('input/project-context.md', '# Fixture project\nNode ESM modules; no dependencies. Paths in spec.md are relative to repository root.\n');
  put('graders/behavior.mjs', `import a from 'node:assert/strict';\nimport {readFileSync,existsSync} from 'node:fs';\nimport {join} from 'node:path';\nimport {pathToFileURL} from 'node:url';\nconst [repo,pkg]=process.argv.slice(2);\nconst text=p=>readFileSync(join(repo,p),'utf8');\nconst json=p=>JSON.parse(text(p));\nconst moduleAt=p=>import(pathToFileURL(join(repo,p)).href);\nconst plan=JSON.parse(readFileSync(join(pkg,'change-plan.json'),'utf8'));\na.equal(text('keep.txt'),'preserve this exact text\\n');\n${item.grade}\n${['mechanical-migration','independent-formatters'].includes(item.id) ? '' : "for(const tier of ['deterministic','simple','involved']) a.ok(plan.operations.some(o=>o.executor===tier), 'missing executor '+tier);"}\nconsole.log('Behavior and preserved data passed');\n`);
  put('scenario.json', JSON.stringify({
    id: item.id, skill: 'spec-changeset-plan', driver: 'changeset', status: 'ready', phase: item.phase,
    purpose: item.spec.split('\n')[0], task: 'Compile the supplied specification into one executable changeset plan.',
    fixture: { feature: item.id }, timeout_ms: 480000,
    execution: { concurrency: 4, review_model: 'openai-codex/gpt-6.1-sol:low', repair_model: 'openai-codex/gpt-6.1-sol:low', max_repairs: 1, simple_model: 'openrouter/inception/mercury-2.5:low', involved_model: 'deepseek/deepseek-flash:off', max_tokens: 16000 },
    expectation_sources: ['input/package/spec.md'], checks: [{ id: 'behavior', kind: 'node-check', script: 'graders/behavior.mjs', timeout_ms: 10000 }, { id: 'unrelated', kind: 'git-untouched', root: 'repo', paths: ['keep.txt'] }],
  }, null, 2) + '\n');
}
console.log(`Curated ${cases.length} workloads`);
