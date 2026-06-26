import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST = "docs/specops/targets.json";
const DEFAULT_AGENTS = "AGENTS.md";
const START_MARKER = "<!-- agents-docs:start -->";
const END_MARKER = "<!-- agents-docs:end -->";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isAbsoluteOrResolve(repoRoot, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
}

function loadManifest(repoRoot, manifestPath = DEFAULT_MANIFEST) {
  const absPath = isAbsoluteOrResolve(repoRoot, manifestPath);
  return { path: absPath, relPath: path.relative(repoRoot, absPath), manifest: readJson(absPath) };
}

function targetAgentPath(target) {
  return target.agent_path || `docs/specops/agents/${target.slug}.md`;
}

function matches(relPath, glob) {
  if (glob === "**") return true;
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return relPath === prefix || relPath.startsWith(`${prefix}/`);
  }
  throw new Error(`unsupported glob shape: ${glob}`);
}

function targetOwnersForFile(manifest, relPath) {
  return manifest.targets.filter((target) =>
    target.source_globs.some((glob) => matches(relPath, glob))
  );
}

function git(repoRoot, args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function defaultBaseRef(repoRoot) {
  const remoteHead = git(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (remoteHead) return remoteHead;

  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(repoRoot, ["rev-parse", "--verify", "--quiet", ref])) return ref;
  }

  return "HEAD~1";
}

function changedFiles(repoRoot, baseRef) {
  const base = baseRef || defaultBaseRef(repoRoot);
  const tripleDot = git(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB", `${base}...HEAD`]);
  const output = tripleDot ?? git(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB", `${base}..HEAD`]);
  if (output === null) {
    throw new Error(`could not compute changed files against ${base}`);
  }
  return {
    base_ref: base,
    files: output.split("\n").map((file) => file.trim()).filter(Boolean),
  };
}

function changedTargets(manifest, files) {
  const bySlug = new Map();
  const unownedFiles = [];

  for (const file of files) {
    const owners = targetOwnersForFile(manifest, file);
    if (owners.length === 0) {
      unownedFiles.push(file);
      continue;
    }
    for (const owner of owners) bySlug.set(owner.slug, owner);
  }

  return {
    targets: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    unowned_files: unownedFiles.sort((a, b) => a.localeCompare(b)),
  };
}

function markdownLink(label, relPath) {
  return `[${label}](${relPath})`;
}

function targetStatus(repoRoot, target) {
  const agentPath = targetAgentPath(target);
  return {
    slug: target.slug,
    name: target.name,
    scope: target.scope,
    tier2_path: target.tier2_path,
    agent_path: agentPath,
    analysis_exists: fs.existsSync(path.join(repoRoot, target.tier2_path)),
    agent_doc_exists: fs.existsSync(path.join(repoRoot, agentPath)),
    source_hash: target.source_hash,
    last_synthesized: target.last_synthesized,
  };
}

function formatIndex(repoRoot, manifestInfo) {
  const { relPath, manifest } = manifestInfo;
  const lines = [
    START_MARKER,
    "## Agent Docs Index",
    "",
    `Generated from \`${relPath}\`. Read the compressed agent doc first; open the deep analysis when you need evidence, edge cases, or policy detail.`,
    "",
  ];

  if (manifest.system?.summary) {
    lines.push(`**System:** ${manifest.system.summary}`, "");
  }
  if (Array.isArray(manifest.system?.external_dependencies) && manifest.system.external_dependencies.length) {
    lines.push(`**External dependencies:** ${manifest.system.external_dependencies.join(", ")}`, "");
  }

  lines.push("| Target | Scope | Agent Doc | Deep Analysis | Status |");
  lines.push("|---|---|---|---|---|");

  for (const target of manifest.targets) {
    const status = targetStatus(repoRoot, target);
    const state = [
      status.agent_doc_exists ? "agent" : "missing agent",
      status.analysis_exists ? "analysis" : "missing analysis",
    ].join(" / ");
    lines.push(
      `| ${target.name || target.slug} | ${target.scope || ""} | ${markdownLink("agent", status.agent_path)} | ${markdownLink("analysis", target.tier2_path)} | ${state} |`
    );
  }

  lines.push("", END_MARKER, "");
  return lines.join("\n");
}

function replaceBlock(existing, block) {
  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);

  if (start !== -1 && end !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + END_MARKER.length).replace(/^\n+/, "")}`;
  }

  const trimmed = existing.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

function writeIndex(repoRoot, manifestPath, agentsPath = DEFAULT_AGENTS) {
  const manifestInfo = loadManifest(repoRoot, manifestPath);
  const absAgentsPath = isAbsoluteOrResolve(repoRoot, agentsPath);
  const existing = fs.existsSync(absAgentsPath) ? fs.readFileSync(absAgentsPath, "utf8") : "";
  const block = formatIndex(repoRoot, manifestInfo);
  const updated = replaceBlock(existing, block);
  fs.mkdirSync(path.dirname(absAgentsPath), { recursive: true });
  fs.writeFileSync(absAgentsPath, updated);
  return { agents_path: path.relative(repoRoot, absAgentsPath), targets: manifestInfo.manifest.targets.length };
}

function status(repoRoot, manifestPath) {
  const { manifest } = loadManifest(repoRoot, manifestPath);
  return manifest.targets.map((target) => targetStatus(repoRoot, target));
}

function parseArgs(argv) {
  const command = argv[2];
  const repoRoot = argv[3];
  const options = { manifest: DEFAULT_MANIFEST, agents: DEFAULT_AGENTS, base: null, files: [] };

  for (let i = 4; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") options.manifest = argv[++i];
    else if (arg === "--agents") options.agents = argv[++i];
    else if (arg === "--base") options.base = argv[++i];
    else if (arg === "--files") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) options.files.push(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { command, repoRoot, options };
}

function usage() {
  return [
    "usage:",
    "  node scripts/agent-docs.mjs changed-targets <repo-root> [--manifest docs/specops/targets.json] [--base <ref>] [--files <path>...]",
    "  node scripts/agent-docs.mjs write-index <repo-root> [--manifest docs/specops/targets.json] [--agents AGENTS.md]",
    "  node scripts/agent-docs.mjs status <repo-root> [--manifest docs/specops/targets.json]",
  ].join("\n");
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exit(1);
  }

  const { command, repoRoot, options } = parsed;
  if (!command || !repoRoot) {
    console.error(usage());
    process.exit(1);
  }

  const resolvedRepo = path.resolve(repoRoot);

  try {
    if (command === "changed-targets") {
      const { manifest } = loadManifest(resolvedRepo, options.manifest);
      const changeSet = options.files.length
        ? { base_ref: options.base, files: options.files }
        : changedFiles(resolvedRepo, options.base);
      console.log(JSON.stringify({ ...changeSet, ...changedTargets(manifest, changeSet.files) }, null, 2));
    } else if (command === "write-index") {
      console.log(JSON.stringify(writeIndex(resolvedRepo, options.manifest, options.agents), null, 2));
    } else if (command === "status") {
      console.log(JSON.stringify(status(resolvedRepo, options.manifest), null, 2));
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

export {
  START_MARKER,
  END_MARKER,
  changedTargets,
  formatIndex,
  replaceBlock,
  targetAgentPath,
  writeIndex,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
