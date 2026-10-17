import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const header = `import a from 'node:assert/strict';\nimport {readFileSync,writeFileSync} from 'node:fs';\nconst load=p=>import('file:///work/'+p);\n`;
const sourceAt = (rev, path) => execFileSync('git', ['show', `${rev}:${path}`], { cwd: repo, encoding: 'utf8' });
const task = (id, family, spec, files, gold, visible, hidden, more = {}) => ({ id, family, origin: 'synthetic', context: 'prepared', spec,
  files: { ...files, 'visible.mjs': header + visible }, gold, hidden: header + hidden, ...more });

export function development() {
  return [task('dev-clamp', 'algorithm', 'Implement clamp(x,min,max) in src/clamp.mjs. All arguments must be finite numbers and min<=max; throw RangeError otherwise. Return x bounded inclusively by min and max. Preserve other files.',
    { 'src/clamp.mjs': 'export function clamp(x,min,max){ return x; }\n', 'keep.txt': 'unchanged\n' },
    { 'src/clamp.mjs': 'export function clamp(x,min,max){ if(![x,min,max].every(Number.isFinite)||min>max)throw new RangeError();return Math.min(max,Math.max(min,x));}\n' },
    `const {clamp}=await load('src/clamp.mjs');a.equal(clamp(10,0,3),3);a.equal(clamp(2,0,3),2);`,
    `const {clamp}=await load('src/clamp.mjs');for(const [x,l,h,out] of [[-2,0,3,0],[10,0,3,3],[2,0,3,2],[0,0,0,0]])a.equal(clamp(x,l,h),out);for(const v of [[NaN,0,3],[1,4,3],['1',0,3],[1,-Infinity,3]])a.throws(()=>clamp(...v),RangeError);a.equal(readFileSync('keep.txt','utf8'),'unchanged\\n');`)];
}

export function evaluation() {
  const tasks = [];
  {
    const files = { 'config.json': '{"schema":1,"retain":{"enabled":true}}\n', 'README.md': 'Exports must remain stable.\n' }, gold = {};
    for (let i=0;i<16;i++) {
      const path = `src/feature-${i}.mjs`;
      files[path] = `export const feature${i} = { transport: 'legacy', retries: ${i%4}, label: 'Feature ${i}' };\n`;
      gold[path] = files[path].replace("transport: 'legacy'", "transport: 'stream'");
    }
    gold['config.json'] = '{"schema":2,"retain":{"enabled":true}}\n';
    tasks.push(task('transport-migration', 'mechanical', 'Migrate every feature module transport from legacy to stream. Preserve exported names, labels and retries. Set config.json schema to 2 preserving all other fields and keep README unchanged.', files,gold,
      `a.equal((await load('src/feature-0.mjs')).feature0.transport,'stream');a.equal(JSON.parse(readFileSync('config.json')).schema,2);`,
      `for(let i=0;i<16;i++)a.deepEqual((await load('src/feature-'+i+'.mjs'))['feature'+i],{transport:'stream',retries:i%4,label:'Feature '+i});a.deepEqual(JSON.parse(readFileSync('config.json')),{schema:2,retain:{enabled:true}});a.equal(readFileSync('README.md','utf8'),'Exports must remain stable.\\n');`));
  }
  {
    const implementations = {
      slug: `export function slug(s){if(typeof s!=='string')throw new TypeError();return s.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');}\n`,
      bytes: `export function bytes(n){if(!Number.isSafeInteger(n)||n<0)throw new RangeError();return n<1024?n+' B':(n/1024).toFixed(1)+' KiB';}\n`,
      mask: `export function mask(s){if(typeof s!=='string')throw new TypeError();return s.length<=4?s:'*'.repeat(s.length-4)+s.slice(-4);}\n`,
      initials: `export function initials(s){if(typeof s!=='string')throw new TypeError();return s.trim().split(/\\s+/).filter(Boolean).map(x=>x[0].toUpperCase()).join('');}\n`,
      percent: `export function percent(n){if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)throw new RangeError();return Math.round(n*100)+'%';}\n`,
      ordinal: `export function ordinal(n){if(!Number.isSafeInteger(n)||n<1)throw new RangeError();const h=n%100;return n+(h>=11&&h<=13?'th':({1:'st',2:'nd',3:'rd'}[n%10]||'th'));}\n`,
    };
    const files={},gold={};for(const [name,text] of Object.entries(implementations)){files[`src/${name}.mjs`]=`export function ${name}(value){throw new Error('TODO');}\n`;gold[`src/${name}.mjs`]=text;}
    tasks.push(task('formatting-library','independent-edits',`Implement six independent exports named after their src files. slug(string) trims, lowercases, replaces each run outside ASCII a-z0-9 with '-', strips leading/trailing hyphens. bytes(nonnegative safe integer) returns 'N B' below 1024 else n/1024 to one decimal followed by ' KiB'. mask(string) preserves strings of length <=4 else masks all except last four UTF-16 code units with '*'. initials(string) returns first character of each whitespace-separated nonempty word uppercased, concatenated. percent(finite number 0..1) rounds n*100 with Math.round and appends '%'. ordinal(positive safe integer) returns English numeric ordinal with 11/12/13 using th and otherwise last digit 1/2/3 st/nd/rd, others th. String helpers reject nonstrings with TypeError; numeric helpers reject invalid input with RangeError.`,files,gold,
      `a.equal((await load('src/slug.mjs')).slug(' Hello World '),'hello-world');a.equal((await load('src/ordinal.mjs')).ordinal(11),'11th');`,
      `const cases={slug:[[' A___B! ','a-b'],['---',''],['Á x','x']],bytes:[[0,'0 B'],[1023,'1023 B'],[1024,'1.0 KiB'],[1536,'1.5 KiB']],mask:[['abcd','abcd'],['abcdef','**cdef'],['','']],initials:[['  ada   lovelace ','AL'],['','']],percent:[[0,'0%'],[0.125,'13%'],[1,'100%']],ordinal:[[1,'1st'],[12,'12th'],[13,'13th'],[21,'21st'],[111,'111th'],[112,'112th'],[113,'113th']]};for(const [name,rows]of Object.entries(cases)){const f=(await load('src/'+name+'.mjs'))[name];for(const [x,y]of rows)a.equal(f(x),y);for(const bad of [null,{},'2'])if(!(typeof bad==='string'&&['slug','mask','initials'].includes(name)))a.throws(()=>f(bad),['slug','mask','initials'].includes(name)?TypeError:RangeError);}for(const name of ['bytes','ordinal','percent']){const f=(await load('src/'+name+'.mjs'))[name];for(const x of [NaN,Infinity,-1])a.throws(()=>f(x),RangeError);}`));
  }
  {
    const files={'src/options.mjs':`export const VERSION=1;\nexport function parseBoolean(v){return Boolean(v);}\nexport function parsePort(v){return Number(v);}\nexport function parseList(v){return v.split(',');}\nexport function readOptions(env){return {debug:parseBoolean(env.DEBUG),port:parsePort(env.PORT),tags:parseList(env.TAGS)};}\n`};
    const gold={'src/options.mjs':`export const VERSION=2;\nexport function parseBoolean(v){if(v===undefined)return false;if(v==='true')return true;if(v==='false')return false;throw new TypeError();}\nexport function parsePort(v){if(v===undefined)return 8080;if(typeof v!=='string'||!/^\\d+$/.test(v))throw new RangeError();const n=Number(v);if(!Number.isInteger(n)||n<1||n>65535)throw new RangeError();return n;}\nexport function parseList(v){if(v===undefined)return [];if(typeof v!=='string')throw new TypeError();return [...new Set(v.split(',').map(s=>s.trim()).filter(Boolean))];}\nexport function readOptions(env){return {debug:parseBoolean(env.DEBUG),port:parsePort(env.PORT),tags:parseList(env.TAGS)};}\n`};
    tasks.push(task('shared-options','shared-file','Update all option parsers and VERSION to 2 in src/options.mjs. parseBoolean(undefined) false; accept only exact strings true/false, otherwise TypeError. parsePort(undefined) 8080; otherwise require a nonempty decimal-digit-only string representing integer 1..65535, allow leading zeros, reject other values with RangeError. parseList(undefined) []; otherwise require string, split commas, trim, discard empty entries and deduplicate preserving first occurrence; wrong types TypeError. readOptions composes these parsers. Preserve exports.',files,gold,
      `const m=await load('src/options.mjs');a.deepEqual(m.readOptions({}),{debug:false,port:8080,tags:[]});a.equal(m.parseBoolean('false'),false);`,
      `const m=await load('src/options.mjs');a.equal(m.VERSION,2);a.deepEqual(m.readOptions({DEBUG:'true',PORT:'00080',TAGS:' a,b,a, , c '}),{debug:true,port:80,tags:['a','b','c']});a.deepEqual(m.readOptions({}),{debug:false,port:8080,tags:[]});for(const x of [true,false,'TRUE','','0',null])a.throws(()=>m.parseBoolean(x),TypeError);for(const x of ['0','65536','1.2',' 80','80x','+80','',80,null])a.throws(()=>m.parsePort(x),RangeError);for(const x of [null,{},[]])a.throws(()=>m.parseList(x),TypeError);a.equal(m.parsePort('65535'),65535);a.deepEqual(m.parseList(',,, '),[]);`));
  }
  {
    const files={'src/parse.mjs':'export function parseLine(line){return line.split(",");}\n','src/group.mjs':'export function aggregate(records){return records;}\n','src/report.mjs':`import {parseLine} from './parse.mjs';\nimport {aggregate} from './group.mjs';\nexport function report(lines){return aggregate(lines.map(parseLine));}\n`};
    const gold={'src/parse.mjs':`export function parseLine(line){if(typeof line!=='string')throw new TypeError();const m=/^([A-Za-z][A-Za-z0-9_-]*),(-?\\d+)$/.exec(line);if(!m)throw new TypeError();return {account:m[1],cents:BigInt(m[2])};}\n`,'src/group.mjs':`export function aggregate(records){const sums=new Map();for(const r of records)sums.set(r.account,(sums.get(r.account)||0n)+r.cents);return [...sums].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([account,cents])=>({account,cents:cents.toString()}));}\n`,'src/report.mjs':`import {parseLine} from './parse.mjs';\nimport {aggregate} from './group.mjs';\nexport function report(lines){return aggregate(lines.map(parseLine));}\n`};
    tasks.push(task('exact-account-report','dependent-edits','Implement the three-module account report without losing integer precision. parseLine(string) accepts exactly account,cents; account matches ASCII [A-Za-z][A-Za-z0-9_-]* and cents matches -?[0-9]+ of arbitrary length. Return {account,cents:BigInt}; malformed/nonstring lines throw TypeError. aggregate(records) receives these valid objects, sums exactly per account, returns account-sorted array of {account,cents:canonical decimal string}; preserve zero totals and do not mutate inputs. report(lines) maps parsing then aggregation, propagating errors. Sort account by JavaScript string comparison (not locale).',files,gold,
      `const {report}=await load('src/report.mjs');a.deepEqual(report(['b,2','a,3','b,-1']),[{account:'a',cents:'3'},{account:'b',cents:'1'}]);`,
      `const {report}=await load('src/report.mjs');a.deepEqual(report(['z,900719925474099312345','A,-5','z,1','A,5','a,0002']),[{account:'A',cents:'0'},{account:'a',cents:'2'},{account:'z',cents:'900719925474099312346'}]);a.deepEqual(report([]),[]);for(const s of ['a, 1','a,+1','a,1.2','1a,2','a,2,3','a,','a,1\\n',null])a.throws(()=>report([s]),TypeError);const {aggregate}=await load('src/group.mjs');const rows=Object.freeze([Object.freeze({account:'x',cents:2n}),Object.freeze({account:'x',cents:-2n})]);a.deepEqual(aggregate(rows),[{account:'x',cents:'0'}]);`));
  }
  {
    const files={'src/csv.mjs':'export function parseRow(row){return row.split(",");}\n'};
    const gold={'src/csv.mjs':`export function parseRow(row){if(typeof row!=='string')throw new TypeError();let out=[],s='',quoted=false,closed=false,start=true;for(let i=0;i<row.length;i++){const c=row[i];if(quoted){if(c==='"'){if(row[i+1]==='"'){s+='"';i++;}else{quoted=false;closed=true;}}else s+=c;}else if(c===','){out.push(s);s='';closed=false;start=true;}else if(closed){throw new SyntaxError();}else if(c==='"'){if(!start)throw new SyntaxError();quoted=true;start=false;}else{if(c==='\\r'||c==='\\n')throw new SyntaxError();s+=c;start=false;}}if(quoted)throw new SyntaxError();out.push(s);return out;}\n`};
    tasks.push(task('csv-row-parser','parsing','Implement parseRow(row) for a single CSV record. Require string (TypeError). Commas delimit fields; empty input returns [""], retain empty fields. A double quote may start a quoted field only at its first character. Inside quoted fields commas and CR/LF are literal and doubled quotes decode to one quote. A closing quote must be followed by comma or end, with no whitespace exception. Reject unterminated quotes, quotes inside unquoted fields, and CR/LF outside quotes with SyntaxError. Preserve all other characters including whitespace.',files,gold,
      `const {parseRow}=await load('src/csv.mjs');a.deepEqual(parseRow('a,"b,c",d'),['a','b,c','d']);a.deepEqual(parseRow(''),['']);`,
      `const {parseRow:p}=await load('src/csv.mjs');for(const [x,y]of [['a,"b,c",d',['a','b,c','d']],[',,',['','','']],['"a""b",',['a"b','']],['"a\\nb", c',['a\\nb',' c']],['""',['']]])a.deepEqual(p(x),y);for(const x of ['"a','a"b','"x" ','a\\nb','"x"y'])a.throws(()=>p(x),SyntaxError);for(const x of [null,1,[]])a.throws(()=>p(x),TypeError);`));
  }
  {
    const files={'ledger.py':'def summarize(rows):\n    return {}\n'};
    const gold={'ledger.py':`def summarize(rows):\n    totals = {}\n    for row in rows:\n        if not isinstance(row, dict) or set(row) != {'account', 'cents'}:\n            raise ValueError('invalid row')\n        account, cents = row['account'], row['cents']\n        if not isinstance(account, str) or not account or not isinstance(cents, int) or isinstance(cents, bool):\n            raise ValueError('invalid value')\n        totals[account] = totals.get(account, 0) + cents\n    return [{'account': key, 'cents': totals[key]} for key in sorted(totals)]\n`};
    const pyVisible=`from ledger import summarize\nassert summarize([{'account':'a','cents':2},{'account':'a','cents':-1}]) == [{'account':'a','cents':1}]\n`;
    const pyHidden=`from ledger import summarize\nfrom copy import deepcopy\nrows=[{'account':'z','cents':10**60},{'account':'A','cents':-2},{'account':'z','cents':1},{'account':'A','cents':2}]\nbefore=deepcopy(rows)\nassert summarize(rows)==[{'account':'A','cents':0},{'account':'z','cents':10**60+1}]\nassert rows==before\nassert summarize([])==[]\nfor row in [None,{}, {'account':'a','cents':True}, {'account':'','cents':1}, {'account':'a','cents':1.5}, {'account':'a','cents':1,'extra':2}]:\n    try: summarize([row])\n    except ValueError: pass\n    else: raise AssertionError(repr(row))\n`;
    tasks.push(task('python-ledger','python-aggregation','Implement ledger.py summarize(rows). Accept a list of dictionaries each with exactly account and cents keys. account must be a nonempty string; cents an arbitrary-precision Python int, excluding bool. Raise ValueError for invalid rows. Return list of {account,cents} dictionaries, summed per account, sorted by ordinary Python string order, retaining zero totals. Do not mutate input. Empty input returns [].',files,gold,
      `const {execFileSync}=await import('node:child_process');execFileSync('python3',['-c',${JSON.stringify(pyVisible)}],{stdio:'inherit'});`,
      `const {execFileSync}=await import('node:child_process');execFileSync('python3',['-c',${JSON.stringify(pyHidden)}],{stdio:'inherit'});`));
  }
  {
    const rev='9ea539fc25d28158f956c6abb263b2ced0525c10', path='scripts/workspaces/request-actions.mjs';
    const setup=`const {requestBrief:f}=await load('${path}');const options={workspace:'sample',source:'typed',transcript:'Build a report',goal:'Build a report'};`;
    tasks.push(task('historical-action-lookup','catalog-validation','The request brief entry point sometimes accepts unknown action names and produces a launchable brief. Ensure every action outside the explicitly declared catalog is rejected with code invalid-request and static message "An unknown request action was named." Preserve the three supported actions, their validation order and output behavior. Find the relevant implementation in this repository.',
      {[path]:sourceAt(rev+'^',path),'README.md':'Workspace request brief library. Source is under scripts/workspaces.\n'},
      {[path]:sourceAt(rev,path)},
      setup+`a.equal(f('plan_epic',options).launchable,true);a.throws(()=>f('missing',options),e=>e.code==='invalid-request');`,
      setup+`for(const x of ['toString','constructor','__proto__','valueOf','hasOwnProperty','toLocaleString','isPrototypeOf','propertyIsEnumerable','__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__','',null,{},1])a.throws(()=>f(x,options),e=>e.code==='invalid-request'&&e.message==='An unknown request action was named.');a.equal(f('plan_epic',options).launchable,true);a.equal(f('build_screens',options).launchable,false);a.equal(f('implement_spec',{...options,entity:'report'}).launchable,true);`,
      {context:'discovery',origin:'historical',provenance:{fix:rev,path}}));
  }
  {
    const rev='bac942e6f48690c4376ba38785227532d15a4555', path='scripts/spec-observe/core.mjs';
    const setup=`const {readSessionBranch:f}=await load('${path}');const file='/tmp/session.jsonl';const put=rows=>writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\\n')+'\\n');const message=(id,parentId,text)=>({type:'message',id,parentId,message:{role:'user',content:text}});`;
    tasks.push(task('historical-session-version','legacy-compatibility','The session history viewer loses messages in old session files whose first record is a session header without a version. Treat an absent or null header version as version 1: use linear file order, including message records lacking IDs, without rewriting the header or file. Preserve explicit version 1 behavior and version 2/3 active parent-branch traversal, pagination, malformed-line handling and errors. Files without a session header retain the existing behavior. Find and fix the owning reader.',
      {[path]:sourceAt(rev+'^',path),'README.md':'Session observation library. Source is under scripts/spec-observe.\n'},
      {[path]:sourceAt(rev,path)},
      setup+`put([{type:'session'},message(undefined,undefined,'hello')]);a.equal((await f(file)).entries.length,1);`,
      setup+`for(const version of [undefined,null,1]){put([{type:'session',version},message(undefined,undefined,'first'),message(undefined,undefined,'second')]);const before=readFileSync(file,'utf8');const out=await f(file);a.deepEqual(out.entries.map(x=>x.message.content),['first','second']);a.equal(out.header.version,version);a.equal(readFileSync(file,'utf8'),before);a.deepEqual((await f(file,{limit:1})).entries.map(x=>x.message.content),['second']);}for(const version of [2,3]){put([{type:'session',version},message('a',null,'root'),message('b','a','abandoned'),message('c','a','active')]);a.deepEqual((await f(file)).entries.map(x=>x.id),['a','c']);a.deepEqual((await f(file,{before:'c'})).entries.map(x=>x.id),['a']);}await a.rejects(f(file,{limit:0}),RangeError);`,
      {context:'discovery',origin:'historical',provenance:{fix:rev,path}}));
  }
  return tasks;
}
