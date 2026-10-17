import test from 'node:test';
import assert from 'node:assert/strict';
import { applyV4A, parseV4A, PROVENANCE } from './applier.mjs';
const patch=body=>'*** Begin Patch\n'+body+'\n*** End Patch';
const run=(files,body,options={})=>applyV4A({files,patch:patch(body),allowedPaths:Object.keys(files),...options});
// Select any case alone with: node --test --test-name-pattern='case name' applier.test.mjs

test('strict envelope rejects wrappers and lenient accepts only one whole declared wrapper',()=>{
  const files={'a.txt':'old\n'},body='*** Update File: a.txt\n@@\n-old\n+new';
  const raw=patch(body);
  for(const wrapped of ['```diff\n'+raw+'\n```',"apply_patch <<'PATCH'\n"+raw+'\nPATCH']) {
    assert.equal(applyV4A({files,patch:wrapped,allowedPaths:['a.txt']}).gates.parsed,false);
    assert.equal(applyV4A({files,patch:wrapped,allowedPaths:['a.txt'],envelope:'lenient-wrapper'}).files['a.txt'],'new\n');
  }
  for(const wrapped of ['Here is the patch:\n'+raw,raw+'\nExplanation','```diff\n```patch\n'+raw+'\n```\n```'])
    assert.equal(applyV4A({files,patch:wrapped,allowedPaths:['a.txt'],envelope:'lenient-wrapper'}).gates.parsed,false);
  assert.throws(()=>parseV4A(raw+'\n\n'),/envelope/);
});

test('quote and template-string bytes survive exact patching without decoding or gold normalisation',()=>{
  const before='const text = "a  b";\nconst marker = `*** End Patch`;\nconst quote = "\\\\ \\\"";\n';
  const result=run({'a.mjs':before},'*** Update File: a.mjs\n@@\n-const text = "a  b";\n+const text = "a   b";\n const marker = `*** End Patch`;');
  assert.equal(result.ok,true);assert.equal(result.matchclass,'exact');
  assert.equal(result.files['a.mjs'],before.replace('"a  b"','"a   b"'));
});

test('four upstream match tiers distinguish trailing whitespace leading indentation and Unicode punctuation',()=>{
  const rows=[['value','exact'],['value \t','trim_end'],['\t value \t','trim'],['“value”—x','unicode']];
  for(const [source,tier]of rows) {
    const old=tier==='unicode'?'"value"-x':'value';
    const result=run({'a.txt':source+'\n'},'*** Update File: a.txt\n@@\n-'+old+'\n+replacement');
    assert.equal(result.ok,true,source);assert.equal(result.matchclass,tier);assert.equal(result.files['a.txt'],'replacement\n');
  }
  assert.equal(run({'a.txt':'a  b\n'},'*** Update File: a.txt\n@@\n-a b\n+x').ok,false,'internal spaces are never collapsed');
  assert.equal(run({'a.txt':'\ufeffvalue\n'},'*** Update File: a.txt\n@@\n-value\n+x').ok,false,'Rust trim preserves BOM');
  assert.equal(run({'a.txt':'value\u0085\n'},'*** Update File: a.txt\n@@\n-value\n+x').matchclass,'trim_end');
  assert.equal(PROVENANCE.matching_passes.length,4);
});

test('duplicate source blocks fail ambiguity and return the untouched file map',()=>{
  const files={'a.txt':'old\nseparator\nold\n'},before=structuredClone(files);
  const result=run(files,'*** Update File: a.txt\n@@\n-old\n+new');
  assert.equal(result.ok,false);assert.equal(result.error.code,'ambiguous');assert.equal(result.ambiguity,true);
  assert.equal(result.gates.parsed,true);assert.equal(result.gates.unambiguous,false);assert.equal(result.matches[0].candidates,2);
  assert.deepEqual(result.files,before);assert.deepEqual(files,before);
});

test('unique @@ skip anchor scopes a duplicate block while repeated anchors are refused',()=>{
  const files={'a.txt':'first\nold\nsecond\nold\n'};
  const result=run(files,'*** Update File: a.txt\n@@ second\n-old\n+new');
  assert.equal(result.ok,true);assert.equal(result.files['a.txt'],'first\nold\nsecond\nnew\n');
  const repeated=run({'a.txt':'anchor\nold\nanchor\nold\n'},'*** Update File: a.txt\n@@ anchor\n-old\n+new');
  assert.equal(repeated.error.code,'ambiguous');assert.equal(repeated.error.kind,'anchor');
});

test('EOF scopes repeated context to the last occurrence and preserves absent final newline',()=>{
  const result=run({'a.txt':'old\nseparator\nold'},'*** Update File: a.txt\n@@\n-old\n+new\n*** End of File');
  assert.equal(result.ok,true);assert.equal(result.files['a.txt'],'old\nseparator\nnew');
  const wrong=run({'a.txt':'old\nlast'},'*** Update File: a.txt\n@@\n-old\n+new\n*** End of File');
  assert.equal(wrong.ok,false);assert.equal(wrong.error.code,'context-not-found');
});

test('fuzzy context retains tabs smart quotes mixed CRLF and bare CR bytes',()=>{
  const before='\tconst label = “keep”—x;\r\nold\r\ntail\r';
  const result=run({'a.txt':before},'*** Update File: a.txt\n@@\n const label = "keep"-x;\n-old\n+new\n tail');
  assert.equal(result.ok,true);assert.equal(result.matchclass,'unicode');
  assert.equal(result.files['a.txt'],'\tconst label = “keep”—x;\r\nnew\r\ntail\r');
});

test('add delete and move-with-edit execute atomically using explicit source and destination allowlists',()=>{
  const files={'old.txt':'before\n','gone.txt':'remove\n','keep.txt':'same'};
  const result=run(files,'*** Add File: new.txt\n+created\n*** Delete File: gone.txt\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-before\n+after',
    {allowedPaths:['new.txt','gone.txt','old.txt','moved.txt']});
  assert.equal(result.ok,true);assert.deepEqual(result.files,{'new.txt':'created\n','moved.txt':'after\n','keep.txt':'same'});
  assert.deepEqual(files,{'old.txt':'before\n','gone.txt':'remove\n','keep.txt':'same'});
});

test('distant sequential chunks use source coordinates after earlier insertion shifts output',()=>{
  const result=run({'a.txt':'top\nkeep\nold\nlast\n'},'*** Update File: a.txt\n@@\n top\n+inserted\n keep\n@@\n-old\n+new\n last');
  assert.equal(result.ok,true);assert.equal(result.files['a.txt'],'top\ninserted\nkeep\nnew\nlast\n');
  const append=run({'a.txt':'a'},'*** Update File: a.txt\n@@\n+b');
  assert.equal(append.files['a.txt'],'a\nb');assert.equal(append.matchclass,'append');
});

test('overlapping chunks and later file failure roll back every earlier proposed change',()=>{
  const files={'a.txt':'a\nb\nc\n','b.txt':'old\n'};
  for(const body of [
    '*** Update File: b.txt\n@@\n-old\n+new\n*** Update File: a.txt\n@@\n a\n-b\n+B\n c\n@@\n b\n-c\n+C',
    '*** Update File: b.txt\n@@\n-old\n+new\n*** Delete File: missing.txt']) {
    const result=run(files,body,{allowedPaths:['a.txt','b.txt','missing.txt']});
    assert.equal(result.ok,false);assert.deepEqual(result.files,files);assert.equal(result.gates.applied,false);
  }
});

test('path escape move overwrite missing source and malformed hunk never mutate caller files',()=>{
  const files={'a.txt':'old\n','b.txt':'occupied\n'};
  const bodies=['*** Add File: ../outside\n+x','*** Update File: a.txt\n*** Move to: b.txt',
    '*** Add File: a.txt\n+overwrite','*** Delete File: missing.txt','*** Update File: a.txt\n@@\ninvalid'];
  for(const body of bodies) {const result=run(files,body,{allowedPaths:['a.txt','b.txt','missing.txt']});assert.equal(result.ok,false);assert.deepEqual(result.files,files);}
  const denied=run(files,'*** Update File: a.txt\n*** Move to: private.txt',{allowedPaths:['a.txt']});
  assert.equal(denied.error.code,'path');assert.equal(denied.gates.paths,false);
});

test('implicit first chunk and trailing empty-context sentinel apply without altering untouched bytes',()=>{
  const implicit=run({'a.txt':'old\n'},'*** Update File: a.txt\n-old\n+new');
  assert.equal(implicit.files['a.txt'],'new\n');
  const sentinel=run({'a.txt':'old'},'*** Update File: a.txt\n@@\n-old\n+new\n \n*** End of File');
  assert.equal(sentinel.ok,true);assert.equal(sentinel.files['a.txt'],'new');
  const move=run({'a.txt':'same\r\nno-newline'},'*** Update File: a.txt\n*** Move to: b.txt',{allowedPaths:['a.txt','b.txt']});
  assert.equal(move.files['b.txt'],'same\r\nno-newline');
});
