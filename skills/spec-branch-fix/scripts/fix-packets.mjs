#!/usr/bin/env node
// Turn a step review's findings into bounded fixer packets. A fixer handed many
// findings at once re-read whole files until compaction erased them and landed
// nothing; one finding group with exact line ranges per run landed in minutes.
// Reads only the compact `findings:` list that spec-branch-review defines.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const usage = "Usage: node fix-packets.mjs --review PATH [--exclude F1,F2] [--format text|json]";
const SEVERITY = { HIGH: 0, MEDIUM: 1, MED: 1, LOW: 2 };
const CONTEXT_LINES = 40;
const MAX_GROUP = 3;

function scalar(value) {
  const text = value.trim();
  if (/^(['"]).*\1$/.test(text)) return text.slice(1, -1);
  if (text === "true" || text === "false") return text === "true";
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/** Parse the leading `review:` record's verdict, step, commit and findings. */
export function parseReviewFindings(text) {
  const block = text.match(/```ya?ml\r?\n([\s\S]*?)\r?\n```/)?.[1];
  if (!block || !/^review:\s*$/m.test(block)) throw new Error("review: no leading review: YAML block");
  const lines = block.split(/\r?\n/);
  const top = key => lines.find(line => new RegExp(`^  ${key}:`).test(line))?.replace(/^  [\w-]+:/, "");
  const findings = [];
  const start = lines.findIndex(line => /^  findings:/.test(line));
  if (start >= 0 && !/\[\]\s*$/.test(lines[start])) {
    let current = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^  \S/.test(line)) break;
      const item = line.match(/^    - (\w+):\s*(.*)$/);
      const field = item ?? line.match(/^      (\w+):\s*(.*)$/);
      if (!field) continue;
      if (item) findings.push(current = {});
      if (!current) continue;
      const [, key, rest] = field;
      if (/^[>|]-?$/.test(rest.trim())) {
        const folded = [];
        while (i + 1 < lines.length && /^ {8}/.test(lines[i + 1])) folded.push(lines[++i].trim());
        current[key] = rest.trim().startsWith("|") ? folded.join("\n") : folded.join(" ");
      } else current[key] = scalar(rest);
    }
  }
  return { verdict: scalar(top("verdict") ?? ""), step: scalar(top("step") ?? ""), commit: scalar(top("commit") ?? ""), findings };
}

function rank(finding) {
  return SEVERITY[String(finding.severity).toUpperCase()] ?? 3;
}

function ranges(findings) {
  const byFile = new Map();
  for (const f of findings) {
    if (!f.file || !Number.isInteger(f.line)) continue;
    const list = byFile.get(f.file) ?? [];
    list.push([Math.max(1, f.line - CONTEXT_LINES), f.line + CONTEXT_LINES]);
    byFile.set(f.file, list);
  }
  const merged = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a[0] - b[0]);
    for (const [from, to] of list) {
      const last = merged.at(-1);
      if (last?.file === file && from <= last.to + 1) last.to = Math.max(last.to, to);
      else merged.push({ file, from, to });
    }
  }
  return merged;
}

/**
 * Plan fixer runs. `single`: up to three actionable findings, none HIGH, one file.
 * Otherwise `split`: one packet per file+symbol group (at most three findings), most
 * severe first. Every packet names the IDs still pending after it.
 */
export function planFixes(review, { exclude = [] } = {}) {
  const skip = new Set(exclude);
  const actionable = review.findings.filter(f => f.actionable === true && !skip.has(f.id))
    .sort((a, b) => rank(a) - rank(b) || String(a.file).localeCompare(String(b.file)) || (a.line ?? 0) - (b.line ?? 0));
  if (!actionable.length) return { mode: "none", reason: "no actionable findings remain", packets: [] };
  const files = new Set(actionable.map(f => f.file));
  const single = actionable.length <= 3 && files.size === 1 && !actionable.some(f => rank(f) === 0);
  const groups = [];
  if (single) groups.push(actionable);
  else {
    const byAnchor = new Map();
    for (const f of actionable) {
      const key = `${f.file}\u0000${f.symbol}`;
      let list = byAnchor.get(key);
      if (!list || list.length >= MAX_GROUP) { list = []; byAnchor.set(key, list); groups.push(list); }
      list.push(f);
    }
  }
  const packets = groups.map((findings, index) => ({
    index: index + 1,
    ids: findings.map(f => f.id),
    severity: findings.map(f => f.severity).sort((a, b) => rank({ severity: a }) - rank({ severity: b }))[0],
    files: [...new Set(findings.map(f => f.file))],
    ranges: ranges(findings),
    findings,
    pending_after: groups.slice(index + 1).flat().map(f => f.id),
  }));
  const reason = single ? "at most three findings in one file and none HIGH"
    : `${actionable.length} findings across ${files.size} file(s)${actionable.some(f => rank(f) === 0) ? " including HIGH" : ""}`;
  return { mode: single ? "single" : "split", reason, packets };
}

/** Render one packet as the fixer task section the coordinator passes on launch. */
export function renderPacket(packet, { review, total, managed = false }) {
  const lines = [
    `Bounded fix packet ${packet.index} of ${total} for ${review}: ${packet.ids.join(", ")}.`,
    "Act only on these findings; the others belong to later packets.",
    "",
    "Read only these ranges (plus test helpers they call):",
    ...packet.ranges.map(r => `- ${r.file}:${r.from}-${r.to}`),
    "",
  ];
  for (const f of packet.findings) {
    lines.push(`${f.id} (${f.severity}) ${f.file}:${f.line} ${f.symbol}`, `  Failure: ${f.explanation ?? "(see review)"}`);
    if (f.correction) lines.push(`  Correction: ${f.correction}`);
  }
  lines.push("",
    "Guards: begin editing within your first three tool calls and make at most six bounded reads before the first edit.",
    "Write each regression case first and observe it fail, then fix. Do not weaken, skip, rename or delete an existing case.",
    managed
      ? "Use spec_editor for all changes and spec_commit for the accepted packet. If unfinished, preserve accepted changesets and report the remaining case; never restore source."
      : "Commit once for this packet. If you cannot finish, `git restore` the files you touched, leave the tree clean, and report the failing case name.",
    `Update reviews/${review.replace(/-review\.md$/, "-fix.md")}: keep earlier packets' decisions, add yours, and set pending: [${packet.pending_after.join(", ")}].`);
  return lines.join("\n");
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
  const review = args.get("--review");
  if (!review) throw new Error(usage);
  const plan = planFixes(parseReviewFindings(readFileSync(review, "utf8")),
    { exclude: (args.get("--exclude") ?? "").split(",").map(s => s.trim()).filter(Boolean) });
  if (args.get("--format") === "json") return JSON.stringify(plan, null, 2);
  const out = [`mode: ${plan.mode} (${plan.reason})`];
  for (const packet of plan.packets) out.push("", "---", renderPacket(packet, { review: path.basename(review), total: plan.packets.length }));
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${main(process.argv.slice(2))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
}
