import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizePackage, listPackageFiles, readPackageFile } from './package-files.mjs';
// Run independently: node --test scripts/spec-observe/package-files.test.mjs
test('package viewer rejects unpublished paths, traversal, escaping links and oversized files',async t=>{
 const dir=await realpath(mkdtempSync(join(tmpdir(),'package-files-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const workspaceDir=join(dir,'projects','demo'),pkg=join(workspaceDir,'specs','feature');mkdirSync(pkg,{recursive:true});mkdirSync(join(workspaceDir,'notes'));
 // The caller's workspace gate (dashboard authorizedWorkspace) maps a workspace id to its directory or refuses.
 const gate=async id=>{if(id!=='demo')throw Error('Workspace is unavailable');return workspaceDir;};
 const state={observers:[{snapshot:{runs:[{package:pkg,workspace:'demo'},{package:join(workspaceDir,'notes'),workspace:'demo'}]}}]};
 assert.deepEqual(await authorizePackage(state,pkg,gate),{root:pkg,ref:'demo/feature'});
 const planned={observers:[{snapshot:{runs:[],planned_packages:state.observers[0].snapshot.runs}}]};
 assert.deepEqual(await authorizePackage(planned,pkg,gate),{root:pkg,ref:'demo/feature'},'planned folders are published without a run');
 await assert.rejects(authorizePackage(planned,dir,gate),/not published/);
 await assert.rejects(authorizePackage(planned,join(workspaceDir,'notes'),gate),/not canonical/);
 await assert.rejects(authorizePackage({observers:[{snapshot:{runs:[],planned_packages:[{package:pkg,workspace:'other'}]}}]},pkg,gate),/unavailable/);
 await assert.rejects(authorizePackage(state,dir,gate),/not published/);
 await assert.rejects(authorizePackage(state,join(workspaceDir,'notes'),gate),/not canonical/,'a published folder outside specs/ is refused');
 await assert.rejects(authorizePackage({observers:[{snapshot:{runs:[{package:pkg,workspace:'other'}]}}]},pkg,gate),/unavailable/,'a workspace the gate refuses');
 writeFileSync(join(dir,'secret'),'private');symlinkSync(join(dir,'secret'),join(pkg,'escape'));symlinkSync(dir,join(pkg,'linked'));
 writeFileSync(join(pkg,'work-tour.html'),'<h1>Tour</h1>');writeFileSync(join(pkg,'image.png'),Buffer.from([137,80,78,71]));writeFileSync(join(pkg,'binary.dat'),Buffer.from([0,255]));writeFileSync(join(pkg,'large.txt'),Buffer.alloc(8*1024*1024+1));
 const listing=await listPackageFiles(pkg);assert.equal(listing.files.find(f=>f.name==='escape').available,false);assert.equal(listing.files.find(f=>f.name==='large.txt').available,false);
 for(const path of ['../secret','linked/secret','escape','large.txt'])await assert.rejects(readPackageFile(pkg,path));
 assert.equal((await readPackageFile(pkg,'work-tour.html')).kind,'html');assert.equal((await readPackageFile(pkg,'image.png')).kind,'image');assert.equal((await readPackageFile(pkg,'binary.dat')).kind,'download');
});

test('package viewer pagination reaches files beyond the first bounded page',async t=>{
 const dir=await realpath(mkdtempSync(join(tmpdir(),'package-pages-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(let i=0;i<510;i++)writeFileSync(join(dir,`file-${i}.txt`),'text');
 const first=await listPackageFiles(dir),second=await listPackageFiles(dir,first.next_cursor);
 assert.equal(first.files.length,500);assert.equal(first.next_cursor,500);assert.equal(second.files.length,10);assert.equal(second.next_cursor,null);
 assert.equal(new Set([...first.files,...second.files].map(f=>f.name)).size,510);
});

test('workspace exclusions omit private components from listings, reads and later pages',async t=>{
 const parent=await realpath(mkdtempSync(join(tmpdir(),'package-exclusions-')));t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const root=join(parent,'root');mkdirSync(join(root,'.adjacent'),{recursive:true});mkdirSync(join(root,'sessions'),{recursive:true});
 writeFileSync(join(root,'visible.txt'),'visible text');writeFileSync(join(root,'.adjacent','inner.txt'),'private');writeFileSync(join(root,'.env.local'),'SECRET=1');writeFileSync(join(root,'sessions','s1.md'),'# session');
 writeFileSync(join(parent,'traversal'),'outside');symlinkSync(join(parent,'traversal'),join(root,'link'));
 const exclude=component=>component==='.adjacent'||component==='.env.local'||component==='sessions';
 const isExcluded=name=>name==='.env.local'||name.startsWith('.adjacent/')||name.startsWith('sessions/');
 // Default behavior is unchanged: private entries stay listed and readable without options.
 const plain=(await listPackageFiles(root)).files.map(f=>f.name);
 for(const name of ['visible.txt','.adjacent/inner.txt','.env.local','sessions/s1.md'])assert.ok(plain.includes(name),`default listing lost ${name}`);
 assert.equal((await readPackageFile(root,'.adjacent/inner.txt')).kind,'text');assert.equal((await readPackageFile(root,'.env.local')).kind,'text');assert.equal((await readPackageFile(root,'sessions/s1.md')).kind,'markdown');
 // A component predicate removes excluded paths from listings and reads.
 const filtered=(await listPackageFiles(root,0,{exclude})).files.map(f=>f.name);
 assert.ok(filtered.includes('visible.txt'));assert.equal(filtered.some(isExcluded),false);
 for(const name of ['.adjacent/inner.txt','.env.local','sessions/s1.md'])await assert.rejects(readPackageFile(root,name,{exclude}));
 assert.equal((await readPackageFile(root,'visible.txt',{exclude})).kind,'text');
 // More than one page: excluded entries must not leak onto the second page.
 const padded=i=>`visible-${String(i).padStart(3,'0')}.txt`;for(let i=0;i<520;i++)writeFileSync(join(root,padded(i)),'text');
 const first=await listPackageFiles(root,0,{exclude}),second=await listPackageFiles(root,first.next_cursor,{exclude});
 assert.equal(first.next_cursor,500);assert.equal(second.next_cursor,null);
 const visible=new Set(['visible.txt',...Array.from({length:520},(_,i)=>padded(i))]);
 for(const page of [first.files,second.files]){assert.equal(page.some(f=>isExcluded(f.name)),false);assert.equal(page.every(f=>visible.has(f.name)||f.name==='link'),true);}
 assert.equal([...first.files,...second.files].filter(f=>visible.has(f.name)).length,521);
 // Refusals survive when exclusions are requested.
 await assert.rejects(readPackageFile(root,'../traversal',{exclude}));await assert.rejects(readPackageFile(root,'link',{exclude}));
});

test('readPackageFile honors a smaller caller cap without changing default reads',async t=>{
 const dir=await realpath(mkdtempSync(join(tmpdir(),'package-cap-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'exact.txt'),'a'.repeat(64));writeFileSync(join(dir,'over.txt'),'b'.repeat(65));
 // The caller cap refuses a file above it; a file exactly at the cap is bounded.
 await assert.rejects(readPackageFile(dir,'over.txt',{maxBytes:64}),/not a bounded regular file/);
 await assert.rejects(readPackageFile(dir,'exact.txt',{maxBytes:63}),/not a bounded regular file/);
 assert.equal((await readPackageFile(dir,'exact.txt',{maxBytes:64})).bytes.length,64);
 assert.equal((await readPackageFile(dir,'over.txt',{maxBytes:65})).bytes.length,65);
 // The unchanged default bound still reads the file refused by the smaller cap.
 assert.equal((await readPackageFile(dir,'over.txt')).bytes.length,65);
 // Caps must be positive safe integers no larger than the shared default.
 for(const maxBytes of [0,-1,1.5,NaN,Infinity,'64',null,8*1024*1024+1])await assert.rejects(readPackageFile(dir,'exact.txt',{maxBytes}),/Invalid file size limit/);
});

test('a file that grows after fstat fails the shared cap+1 read boundary',async t=>{
 const dir=await realpath(mkdtempSync(join(tmpdir(),'package-grow-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'grow.txt');writeFileSync(path,'g'.repeat(63));
 // The real handle is wrapped so the fixture grows after the reader's fstat
 // and before its cap+1 read; the actual bytes must still be refused.
 const originalOpen=fsPromises.open;
 fsPromises.open=async(file,...rest)=>{const handle=await originalOpen(file,...rest);return{
  stat:async()=>{const info=await handle.stat();appendFileSync(file,'x');return info;},
  read:(...args)=>handle.read(...args),close:()=>handle.close()};};
 syncBuiltinESMExports();
 try{
  await assert.rejects(readPackageFile(dir,'grow.txt',{maxBytes:63}),/File changed or exceeds limit/);
  assert.equal(statSync(path).size,64,'the fixture grew after fstat to cap+1 bytes');
 }finally{fsPromises.open=originalOpen;syncBuiltinESMExports();}
});
