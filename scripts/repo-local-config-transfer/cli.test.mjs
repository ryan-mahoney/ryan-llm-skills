import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
async function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status) throw Error(r.stderr);
  return r.stdout;
}
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "local-transfer-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const src = join(base, "source"),
    dstPath = join(base, "destination"),
    bin = join(base, "bin");
  for (const p of [src, dstPath, bin]) await mkdir(p);
  const dst = await realpath(dstPath);
  for (const p of [src, dst]) {
    await git(p, "init", "-q");
    await git(p, "config", "user.email", "fixture@example.invalid");
    await git(p, "config", "user.name", "Fixture");
  }
  const fake = join(bin, "ssh");
  await writeFile(
    fake,
    `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const fs=require('node:fs');(async()=>{if(process.argv[2]!=='--'||process.argv[3]!=='fixture-host')process.exit(22);const a=[];for await(const x of process.stdin)a.push(x);const input=Buffer.concat(a);if(process.env.FAKE_SSH_CAPTURE)fs.writeFileSync(process.env.FAKE_SSH_CAPTURE,input);const r=spawnSync('/bin/sh',['-c',process.argv[4]],{input,encoding:'utf8',maxBuffer:8*1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)})();\n`,
  );
  await chmod(fake, 0o755);
  return {
    base,
    src,
    dst,
    env: { ...process.env, PATH: bin + ":" + process.env.PATH },
  };
}
async function cliRun(args, env) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env,
    timeout: 15000,
  });
}
async function manifest(f, t) {
  const out = join(f.base, "manifest.json");
  const r = await cliRun(["scan", f.src, "--output", out], f.env);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(await readFile(out, "utf8"));
  m.entries[0].selected = true;
  await writeFile(out, JSON.stringify(m));
  return out;
}

test("scan records ignored config without contents and transfer previews then copies via SSH boundary", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.src, ".gitignore"), "*.config\n");
  await writeFile(join(f.src, "app.config"), "private-marker");
  const mf = await manifest(f, t);
  const m = JSON.parse(await readFile(mf, "utf8"));
  assert.deepEqual(Object.keys(m.entries[0]).sort(), [
    "mode",
    "mtime_ms",
    "path",
    "reason",
    "selected",
    "sha256",
    "size",
  ]);
  assert.equal(JSON.stringify(m).includes("private-marker"), false);
  assert.match(m.entries[0].reason, /configuration/);
  const capture = join(f.base, "preview-payload.json");
  f.env.FAKE_SSH_CAPTURE = capture;
  const preview = await cliRun(
    [
      "transfer",
      "--manifest",
      mf,
      "--to",
      f.dst.includes(":") ? f.dst : `fixture-host:${f.dst}`,
    ],
    f.env,
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /PREVIEW_OK/);
  const sent = JSON.parse(await readFile(capture, "utf8"));
  assert.equal("data" in sent.files[0], false);
  await assert.rejects(readFile(join(f.dst, "app.config")));
  const apply = await cliRun(
    ["transfer", "--manifest", mf, "--to", `fixture-host:${f.dst}`, "--apply"],
    f.env,
  );
  assert.equal(apply.status, 0, apply.stderr + " " + apply.stdout);
  assert.equal(
    await readFile(join(f.dst, "app.config"), "utf8"),
    "private-marker",
  );
});

test("transfer refuses changed sources, existing files without overwrite, and tracked destinations", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.src, ".gitignore"), "*.config\n");
  await writeFile(join(f.src, "app.config"), "original");
  const mf = await manifest(f, t);
  await writeFile(join(f.src, "app.config"), "changed");
  let r = await cliRun(
    ["transfer", "--manifest", mf, "--to", `fixture-host:${f.dst}`],
    f.env,
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Source changed/);
  const mf2 = join(f.base, "m2.json");
  await cliRun(["scan", f.src, "--output", mf2], f.env);
  const m = JSON.parse(await readFile(mf2, "utf8"));
  m.entries[0].selected = true;
  await writeFile(mf2, JSON.stringify(m));
  await writeFile(join(f.dst, "app.config"), "existing");
  r = await cliRun(
    ["transfer", "--manifest", mf2, "--to", `fixture-host:${f.dst}`, "--apply"],
    f.env,
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /overwrite required/);
  await git(f.dst, "add", "app.config");
  await git(f.dst, "commit", "-qm", "fixture");
  await writeFile(mf2, JSON.stringify(m));
  r = await cliRun(
    [
      "transfer",
      "--manifest",
      mf2,
      "--to",
      `fixture-host:${f.dst}`,
      "--apply",
      "--overwrite",
    ],
    f.env,
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /tracked destination refused/);
});

test("scan includes info and global Git excludes plus unignored config candidates", async (t) => {
  const f = await fixture(t);
  const infoExclude = join(f.src, ".git", "info", "exclude");
  await writeFile(infoExclude, "info.config\n");
  const globalIgnore = join(f.base, "global-ignore");
  const globalConfig = join(f.base, "gitconfig");
  await writeFile(globalIgnore, "global.config\n");
  await writeFile(globalConfig, `[core]\n	excludesFile = ${globalIgnore}\n`);
  f.env.GIT_CONFIG_GLOBAL = globalConfig;
  await writeFile(join(f.src, "info.config"), "ignored by info");
  await writeFile(join(f.src, "global.config"), "ignored globally");
  await writeFile(join(f.src, ".env.local"), "untracked candidate");
  const out = join(f.base, "inventory.json");
  const result = await cliRun(["scan", f.src, "--output", out], f.env);
  assert.equal(result.status, 0, result.stderr);
  const entries = JSON.parse(await readFile(out, "utf8")).entries;
  assert.deepEqual(
    entries.map((entry) => entry.path),
    [".env.local", "global.config", "info.config"],
  );
  assert.equal(
    entries.every((entry) => entry.selected === false),
    true,
  );
});

test("transfer rejects traversal and permits previewing and applying an explicit overwrite", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.src, "settings.config"), "new value");
  const mf = await manifest(f, t);
  const m = JSON.parse(await readFile(mf, "utf8"));
  m.entries[0].path = "../outside";
  await writeFile(mf, JSON.stringify(m));
  let result = await cliRun(
    ["transfer", "--manifest", mf, "--to", `fixture-host:${f.dst}`],
    f.env,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsafe manifest path/);

  m.entries[0].path = "settings.config";
  await writeFile(mf, JSON.stringify(m));
  await writeFile(join(f.dst, "settings.config"), "old value");
  result = await cliRun(
    [
      "transfer",
      "--manifest",
      mf,
      "--to",
      `fixture-host:${f.dst}`,
      "--overwrite",
    ],
    f.env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would overwrite settings.config/);
  assert.equal(
    await readFile(join(f.dst, "settings.config"), "utf8"),
    "old value",
  );
  result = await cliRun(
    [
      "transfer",
      "--manifest",
      mf,
      "--to",
      `fixture-host:${f.dst}`,
      "--apply",
      "--overwrite",
    ],
    f.env,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(f.dst, "settings.config"), "utf8"),
    "new value",
  );
});

test("scan and remote preflight reject symlink paths", async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, "outside");
  await writeFile(outside, "fixture data");
  await (
    await import("node:fs/promises")
  ).symlink(outside, join(f.src, ".env"));
  const out = join(f.base, "symlink-manifest.json");
  const scanned = await cliRun(["scan", f.src, "--output", out], f.env);
  assert.notEqual(scanned.status, 0);
  assert.match(scanned.stderr, /Symlink source paths/);

  await rm(join(f.src, ".env"));
  await mkdir(join(f.src, "nested"));
  await writeFile(join(f.src, "nested", "settings.config"), "fixture config");
  const mf = join(f.base, "nested-manifest.json");
  const normalScan = await cliRun(["scan", f.src, "--output", mf], f.env);
  assert.equal(normalScan.status, 0, normalScan.stderr);
  const manifestData = JSON.parse(await readFile(mf, "utf8"));
  manifestData.entries[0].selected = true;
  await writeFile(mf, JSON.stringify(manifestData));
  const targetDir = join(f.base, "outside-dir");
  await mkdir(targetDir);
  await (
    await import("node:fs/promises")
  ).symlink(targetDir, join(f.dst, "nested"));
  const result = await cliRun(
    ["transfer", "--manifest", mf, "--to", `fixture-host:${f.dst}`],
    f.env,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink destination path/);
});
