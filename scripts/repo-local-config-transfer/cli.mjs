#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, lstat, realpath, writeFile, chmod } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const HELP = `Usage:
  repo-local-config-transfer scan REPO --output FILE
  repo-local-config-transfer transfer --manifest FILE --to HOST:/absolute/repo [--apply] [--overwrite]

Scan creates a private manifest; transfer previews unless --apply is supplied.`;
const SECRETISH =
  /(^|\/)(\.[^/]+|[^/]*(?:config|credential|secret|settings|profile)[^/]*|[^/]*\.(?:pem|key|p12|pfx|kdbx|env|ini|toml|yaml|yml|conf|config|json|local))$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const EXCLUDE =
  /(^|\/)(node_modules|vendor|\.venv|venv|\.yarn|\.pnpm-store|\.npm|\.gradle|__pycache__|dist|build|out|coverage|\.cache|cache|\.next|\.turbo|target|logs?|dumps?|core)(\/|$)|\.(?:log|dump|sql|sqlite|db)(?:\.|$)/i;
const within = (root, p) => {
  const r = relative(root, p);
  return (
    r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r))
  );
};
const safeRel = (p) =>
  typeof p === "string" &&
  p.length > 0 &&
  !p.startsWith("/") &&
  !p.includes("\\") &&
  !/[\x00-\x1f\x7f]/.test(p) &&
  p.split("/").every((s) => s && s !== "." && s !== "..") &&
  !p.split("/").some((s) => s.toLowerCase() === ".git");
const runGit = (repo, args, input) => {
  const r = spawnSync("git", ["-C", repo, ...args], {
    input,
    encoding: "buffer",
    timeout: 8000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "diff.external",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    },
  });
  if (r.status !== 0) throw new Error("Git inventory failed.");
  return r.stdout;
};
const nul = (b) => b.toString("utf8").split("\0").filter(Boolean);
async function checkNoSymlink(root, relpath) {
  let cur = root;
  for (const part of relpath.split("/")) {
    cur = join(cur, part);
    let st;
    try {
      st = await lstat(cur);
    } catch (e) {
      if (e.code === "ENOENT") break;
      throw e;
    }
    if (st.isSymbolicLink())
      throw new Error("Symlink source paths are not allowed.");
  }
}
async function scan(repoArg, out) {
  const repo = await realpath(repoArg);
  const root = resolve(
    runGit(repo, ["rev-parse", "--show-toplevel"]).toString().trim(),
  );
  const tracked = new Set(nul(runGit(root, ["ls-files", "-z"])));
  const ignored = new Set(
    nul(
      runGit(root, [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
      ]),
    ),
  );
  const plain = new Set(
    nul(runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"])),
  );
  const candidates = new Map();
  for (const p of ignored)
    if (SECRETISH.test(p))
      candidates.set(p, "git-ignored local configuration candidate");
  for (const p of plain)
    if (!candidates.has(p) && SECRETISH.test(p))
      candidates.set(
        p,
        "untracked local configuration or credential candidate",
      );
  const entries = [];
  for (const [p, reason] of [...candidates].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!safeRel(p) || p === ".gitignore" || EXCLUDE.test(p) || tracked.has(p))
      continue;
    await checkNoSymlink(root, p);
    const abs = join(root, ...p.split("/"));
    let st;
    try {
      st = await lstat(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const bytes = await readFile(abs);
    entries.push({
      path: p,
      reason,
      selected: false,
      size: st.size,
      mtime_ms: Math.trunc(st.mtimeMs),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode: st.mode & 0o777,
    });
  }
  const manifest = {
    schema_version: 1,
    repo_root: root,
    created_at: new Date().toISOString(),
    entries,
  };
  await writeFile(out, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(out, 0o600);
  console.log(
    `Wrote ${entries.length} candidate paths to ${out}. Review and set selected: true for files to transfer.`,
  );
}
const REMOTE = String.raw`import sys,json,os,stat,subprocess,tempfile,base64
req=json.load(sys.stdin)
root=req['root']; files=req['files']; apply=req['apply']; overwrite=req['overwrite']
if not os.path.isabs(root): raise SystemExit('target must be absolute')
real=os.path.realpath(root)
if real!=root or not os.path.isdir(root): raise SystemExit('target repository directory missing or resolves through a symlink')
git=subprocess.run(['git','-C',root,'rev-parse','--show-toplevel'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
if git.returncode or os.path.realpath(git.stdout.strip())!=root: raise SystemExit('target is not a Git repository root')
def valid(p): return isinstance(p,str) and p and not p.startswith('/') and '\\' not in p and all(x not in ('','.','..') and x.lower()!='.git' for x in p.split('/'))
def inspect(p):
 cur=root
 for x in p.split('/'):
  cur=os.path.join(cur,x)
  if os.path.lexists(cur) and os.path.islink(cur): raise ValueError('symlink destination path')
 dest=os.path.join(root,*p.split('/'))
 if os.path.commonpath([root,dest])!=root: raise ValueError('destination escapes repository')
 if os.path.exists(dest) and not os.path.isfile(dest): raise ValueError('destination is not a regular file')
 tracked=subprocess.run(['git','-C',root,'ls-files','--error-unmatch','--',p],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if tracked.returncode==0: raise ValueError('tracked destination refused')
 if tracked.returncode!=1: raise ValueError('destination Git validation failed')
 if os.path.exists(dest) and not overwrite: raise ValueError('destination exists; --overwrite required')
 return dest
try:
 plan=[]
 for f in files:
  p=f['path']
  if not valid(p): raise ValueError('invalid relative path')
  dest=inspect(p)
  raw=None
  if apply:
   raw=base64.b64decode(f['data'],validate=True)
   if len(raw)!=f['size'] or __import__('hashlib').sha256(raw).hexdigest()!=f['sha256']: raise ValueError('payload integrity mismatch')
  plan.append((dest,raw,p))
except Exception as e: print(str(e),file=sys.stderr); sys.exit(4)
if not apply:
 for dest,_,p in plan: print(('would overwrite ' if os.path.exists(dest) else 'would copy ')+p)
 print('PREVIEW_OK'); sys.exit(0)
try:
 for dest,raw,p in plan:
  os.makedirs(os.path.dirname(dest),mode=0o700,exist_ok=True)
  # Recheck parents and destination immediately before atomic replacement.
  inspect(p)
  fd,tmp=tempfile.mkstemp(prefix='.repo-local-config-transfer-',dir=os.path.dirname(dest))
  try:
   os.fchmod(fd,0o600)
   with os.fdopen(fd,'wb') as out: out.write(raw); out.flush(); os.fsync(out.fileno())
   os.replace(tmp,dest)
  finally:
   if os.path.exists(tmp): os.unlink(tmp)
  print('copied '+p)
except Exception as e: print(str(e),file=sys.stderr); sys.exit(5)
print('APPLY_OK')`;
function parseArgs(argv) {
  const cmd = argv.shift();
  if (cmd === "--help" || cmd === "-h") return { cmd: "help" };
  if (!["scan", "transfer"].includes(cmd)) throw new Error(HELP);
  const o = { cmd, apply: false, overwrite: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--apply" && !o.apply) o.apply = true;
    else if (a === "--overwrite" && !o.overwrite) o.overwrite = true;
    else if (
      ["--output", "--manifest", "--to"].includes(a) &&
      argv[i + 1] &&
      !argv[i + 1].startsWith("--")
    )
      o[a.slice(2)] = argv[++i];
    else if (cmd === "scan" && !o.repo && !a.startsWith("--")) o.repo = a;
    else throw new Error("Unknown or incomplete option.");
  }
  if (cmd === "scan" && (!o.repo || !o.output)) throw new Error(HELP);
  if (cmd === "transfer" && (!o.manifest || !o.to)) throw new Error(HELP);
  return o;
}
async function send(host, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      ["--", host, `python3 -c '${REMOTE.replaceAll("'", "'\\''")}'`],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    child.stdout.setEncoding("utf8").on("data", (x) => (out += x));
    child.stderr.setEncoding("utf8").on("data", (x) => (err += x));
    child.on("error", () => reject(new Error("SSH could not start.")));
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(err.trim() || `Remote helper failed (${code}).`)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
async function transfer(o) {
  const m = JSON.parse(await readFile(o.manifest, "utf8"));
  if (
    m?.schema_version !== 1 ||
    !isAbsolute(m.repo_root) ||
    !Array.isArray(m.entries)
  )
    throw new Error("Invalid manifest.");
  const sourceRoot = await realpath(m.repo_root);
  const actualRoot = resolve(
    runGit(sourceRoot, ["rev-parse", "--show-toplevel"]).toString().trim(),
  );
  if (sourceRoot !== m.repo_root || actualRoot !== m.repo_root)
    throw new Error(
      "Manifest repository root does not match the current Git checkout.",
    );
  const ix = o.to.indexOf(":");
  if (ix < 1) throw new Error("--to must be HOST:/absolute/repo.");
  const host = o.to.slice(0, ix),
    root = o.to.slice(ix + 1);
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(host) ||
    !isAbsolute(root) ||
    /[\0\r\n]/.test(root)
  )
    throw new Error("Invalid SSH target.");
  const files = [];
  const selectedPaths = new Set();
  for (const e of m.entries) {
    if (e.selected !== true) continue;
    if (selectedPaths.has(e.path))
      throw new Error(`Duplicate selected path: ${e.path}`);
    selectedPaths.add(e.path);
    if (!safeRel(e.path)) throw new Error("Unsafe manifest path.");
    const abs = join(m.repo_root, ...e.path.split("/"));
    if (!within(m.repo_root, abs)) throw new Error("Unsafe manifest path.");
    await checkNoSymlink(m.repo_root, e.path);
    const trackedCheck = spawnSync(
      "git",
      ["-C", m.repo_root, "ls-files", "--error-unmatch", "--", e.path],
      {
        encoding: "utf8",
        timeout: 8000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    if (trackedCheck.status === 0)
      throw new Error(`Source is now tracked: ${e.path}`);
    if (trackedCheck.status !== 1)
      throw new Error("Git source validation failed.");
    const st = await lstat(abs);
    if (
      !st.isFile() ||
      st.size !== e.size ||
      Math.trunc(st.mtimeMs) !== e.mtime_ms
    )
      throw new Error(`Source changed since scan: ${e.path}`);
    const data = await readFile(abs);
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== e.sha256)
      throw new Error(`Source changed since scan: ${e.path}`);
    files.push({
      path: e.path,
      size: data.length,
      sha256: hash,
      ...(o.apply ? { data: data.toString("base64") } : {}),
    });
  }
  if (!files.length) throw new Error("No manifest entries are selected.");
  const output = await send(host, {
    root,
    files,
    apply: o.apply,
    overwrite: o.overwrite,
  });
  process.stdout.write(output);
  if (!output.includes(o.apply ? "APPLY_OK" : "PREVIEW_OK"))
    throw new Error("Remote helper returned an incomplete result.");
}
export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs([...argv]);
  if (o.cmd === "help") {
    console.log(HELP);
    return 0;
  }
  if (o.cmd === "scan") {
    await scan(o.repo, o.output);
    return 0;
  }
  await transfer(o);
  return 0;
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
)
  main()
    .then((c) => (process.exitCode = c))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 2;
    });
