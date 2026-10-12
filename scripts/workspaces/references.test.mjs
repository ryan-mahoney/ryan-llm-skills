// Focused context contracts: node --test scripts/workspaces/references.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createReferenceCatalog } from './references.mjs';
import { resolveAssignment } from './assignments.mjs';
import { createDiscussionService } from './discussion.mjs';
import { setupStorage, createWorkspace, fetchWorkspace } from './store.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sentinel-context-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, 'storage'); await setupStorage(storage);
  const created = await createWorkspace(storage, { id: 'context', name: 'Context' });
  const repo = join(root, 'repo'); await mkdir(repo); execFileSync('git', ['init', '-q'], {cwd:repo});
  const sibling = join(root, 'sibling'); await mkdir(sibling); execFileSync('git', ['init', '-q'], {cwd:sibling});
  await writeFile(join(created.directory, 'kit.yaml'), `version: 1\nid: context\nname: Context\nrepositories:\n  - id: app\n    path: ${JSON.stringify(repo)}\n  - id: sibling\n    path: ${JSON.stringify(sibling)}\n`);
  await mkdir(join(created.directory, 'notes')); await writeFile(join(created.directory, 'notes', 'brief.md'), '# Shared outcome\nPreserve the outcome.\n');
  await writeFile(join(repo, 'request with spaces.md'), '# Expected behavior\nImplement exactly this.\n');
  await writeFile(join(sibling, 'other.md'), '# Other project\n');
  await writeFile(join(repo, 'binary.dat'), Buffer.from([1,0,2]));
  await writeFile(join(repo, 'huge.txt'), 'a'.repeat(65537));
  const outside = join(root, 'outside.txt'); await writeFile(outside, 'Outside source'); await symlink(outside, join(repo, 'escaped.txt'));
  const skillPath = join(root, 'skills', 'demo', 'SKILL.md'); await mkdir(join(root,'skills','demo'), {recursive:true});
  await writeFile(skillPath, '---\nname: demo\ndescription: Use the expected workflow.\n---\n# Demo\nRead references/details.md, then implement.\n');
  const catalog = createReferenceCatalog({agentDir:join(root,'agent'), skillLoader: () => ({skills:[{name:'demo',description:'Use the expected workflow.',filePath:skillPath,baseDir:join(root,'skills','demo'),sourceInfo:{scope:'user'}}],diagnostics:[]})});
  const workspace = await fetchWorkspace(storage, 'context');
  const pi = join(root, 'pi'); await writeFile(pi, '#!/bin/sh\nexit 0\n', {mode:0o755});
  return {root, storage, repo, sibling, workspace, skillPath, catalog, pi};
}

test('file suggestions follow the selected repository and include workspace context without outside symlinks or binary files', async t => {
  const f = await fixture(t);
  const result = await f.catalog.suggest({workspace:f.workspace,executionDir:f.repo,kind:'file'});
  assert.ok(result.items.some(item => item.label === 'request with spaces.md' && item.description === 'Expected behavior · app'));
  assert.ok(result.items.some(item => item.label === 'notes/brief.md' && item.source === 'workspace'));
  assert.ok(!result.items.some(item => ['other.md','escaped.txt','binary.dat','huge.txt'].includes(item.label)));
  const all = await f.catalog.suggest({workspace:f.workspace,executionDir:f.workspace.directory,kind:'file',query:'other'});
  assert.equal(all.items[0].source, 'sibling');
  const second = await createWorkspace(f.storage, {id:'second'});
  await mkdir(join(second.directory,'notes')); await writeFile(join(second.directory,'notes','brief.md'),'# Second workspace\n');
  const secondFiles = await f.catalog.suggest({workspace:second,executionDir:second.directory,kind:'file',query:'brief'});
  assert.notEqual(secondFiles.items[0].id,result.items.find(item=>item.label==='notes/brief.md').id);
  await assert.rejects(f.catalog.capture({workspace:second,executionDir:second.directory,references:[{kind:'file',id:result.items.find(item=>item.label==='notes/brief.md').id}]}), {code:'reference-unavailable'});
});

test('assignment input captures selected skill and file contents with source identities and binds edits to the preview digest', async t => {
  const f = await fixture(t);
  const skills = await f.catalog.suggest({workspace:f.workspace,executionDir:f.repo,kind:'skill',query:'demo'});
  const files = await f.catalog.suggest({workspace:f.workspace,executionDir:f.repo,kind:'file',query:'request'});
  const refs = [skills.items[0],files.items[0]].map(({kind,id})=>({kind,id}));
  const input = {workspace_id:'context',assignment_id:randomUUID(),storageRoot:f.storage,brief:'notes/brief.md',instructions:'Apply the selected context.',target:'app',pi_path:f.pi,context_references:refs};
  const first = await resolveAssignment(input,{referenceCatalog:f.catalog});
  assert.match(first.briefBytes.toString(), /Read references\/details.md, then implement/);
  assert.match(first.briefBytes.toString(), /Supporting references are relative to .*skills\/demo/);
  assert.match(first.briefBytes.toString(), /Implement exactly this/);
  assert.equal(first.record.context_references.length, 2);
  assert.equal(first.piArgs.at(-2), `@${first.record.brief_snapshot}`);
  assert.equal(first.inputPreview.brief, first.briefBytes.toString());
  assert.equal(first.record.brief_sha256, createHash('sha256').update(first.briefBytes).digest('hex'));
  await writeFile(join(f.repo, 'request with spaces.md'), '# Expected behavior\nEdited after preview.\n');
  const editedFile = await resolveAssignment(input,{referenceCatalog:f.catalog});
  assert.notEqual(first.contractDigest, editedFile.contractDigest);
  assert.match(first.briefBytes.toString(), /Implement exactly this/);
  await writeFile(f.skillPath, '# Changed skill instructions\n');
  const editedSkill = await resolveAssignment(input,{referenceCatalog:f.catalog});
  assert.notEqual(editedFile.contractDigest, editedSkill.contractDigest);
  assert.match(editedSkill.inputPreview.brief, /Changed skill instructions/);
  await assert.rejects(f.catalog.capture({workspace:f.workspace,executionDir:f.sibling,references:[refs[1]]}), {code:'reference-unavailable'});
  await assert.rejects(f.catalog.capture({workspace:f.workspace,executionDir:f.repo,references:[{kind:'file',id:'file:'+'0'.repeat(64)}]}), {code:'reference-unavailable'});
  execFileSync('git',['add','request with spaces.md'],{cwd:f.repo});
  await rm(join(f.repo,'request with spaces.md'));
  await assert.rejects(f.catalog.capture({workspace:f.workspace,executionDir:f.repo,references:[refs[1]]}), {code:'reference-unavailable'});
});

test('saved references survive reopening and a retry cannot replace them or bypass their saved selection during preview', async t => {
  const f = await fixture(t);
  const previousPath = process.env.PATH; process.env.PATH = `${f.root}${delimiter}${previousPath}`;
  t.after(() => { if(previousPath === undefined) delete process.env.PATH; else process.env.PATH=previousPath; });
  const service = createDiscussionService({root:f.storage,referenceCatalog:f.catalog});
  t.after(() => service.close());
  const thread = await service.create({workspace_id:'context',target:{kind:'repository',repository_id:'app'}});
  const suggestion = await service.suggestions({workspace_id:'context',thread_id:thread.thread_id,kind:'file',query:'request'});
  const ref = {kind:'file',id:suggestion.items[0].id};
  const save = {workspace_id:'context',thread_id:thread.thread_id,request_id:randomUUID(),title:'Deliver outcome',content:'Use the selected reference.',references:[ref]};
  await service.saveBrief(save);
  await assert.rejects(service.saveBrief({...save,references:[]}), {code:'request-conflict'});
  const record = JSON.parse(await readFile(join(f.workspace.directory,'threads',`${thread.thread_id}.json`),'utf8'));
  assert.deepEqual(record.handoffs[0].references,[ref]);
  const reopened = createDiscussionService({root:f.storage,referenceCatalog:f.catalog}); t.after(()=>reopened.close());
  const preview = await reopened.previewAssignment({...save,assignment_id:randomUUID(),instructions:save.content,context_references:[]});
  assert.match(preview.briefBytes.toString(), /Implement exactly this/);
  assert.equal(preview.inputPreview.references[0].id,ref.id);
});
