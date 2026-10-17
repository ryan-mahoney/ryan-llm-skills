// Focused: node --test scripts/changeset-research/snapshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workspace } from '../changeset/workspace.mjs';
import { gitSnapshot } from './snapshot.mjs';
test('paired fixture reconstruction retains executable behavior from Git', t => {
  const root = mkdtempSync(join(tmpdir(),'changeset-snapshot-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo = join(root,'repo'), copy = join(root,'copy'); mkdirSync(repo); mkdirSync(copy);
  writeFileSync(join(repo,'run'),'#!/bin/sh\necho retained\n'); chmodSync(join(repo,'run'),0o755);
  const git=(...args)=>execFileSync('git',['-C',repo,...args]);
  git('init','-q');git('add','run');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','Fixture');
  const {files,modes}=gitSnapshot(repo);new Workspace(files,null,modes).materialize(copy);
  assert.equal(execFileSync(join(copy,'run'),[],{encoding:'utf8'}),'retained\n');
});
