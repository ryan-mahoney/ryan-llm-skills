import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizePackage, listPackageFiles, readPackageFile } from './package-files.mjs';
// Run independently: node --test scripts/spec-observe/package-files.test.mjs
test('package viewer rejects unpublished paths, traversal, escaping links and oversized files',async t=>{
 const dir=await realpath(mkdtempSync(join(tmpdir(),'package-files-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const pkg=join(dir,'.specs','feature');mkdirSync(pkg,{recursive:true});mkdirSync(join(dir,'.git'));
 const state={observers:[{snapshot:{runs:[{package:pkg}]}}]};
 assert.equal(await authorizePackage(state,pkg),pkg);await assert.rejects(authorizePackage(state,dir));
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
