#!/usr/bin/env node

import { readFile, readdir, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const usage = "Usage: node build-history-index.mjs --spec-dir PATH";

function stepNumber(name) {
  return name.match(/step-(\d+)/)?.[1] ?? null;
}

function headings(text) {
  return text.split(/\r?\n/).filter((line) => /^#{1,4}\s+/.test(line)).map((line) => line.replace(/^#+\s+/, "").trim());
}

function fencedBlocks(text) {
  const blocks = [];
  let start = -1;
  let marker = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (!marker && opening) { start = i; marker = opening[1][0]; }
    else if (marker && lines[i].startsWith(marker.repeat(3))) {
      blocks.push({ start, end: i, text: lines.slice(start, i + 1).join("\n") });
      marker = null;
    }
  }
  if (marker) blocks.push({ start, end: lines.length - 1, text: lines.slice(start).join("\n") });
  return blocks;
}

function introducedBlock(text) {
  const lines = text.split(/\r?\n/);
  const blocks = fencedBlocks(text);
  for (const block of blocks) {
    const segment = lines.slice(block.start, block.end + 1);
    const at = segment.findIndex((line) => /^\s*introduced:\s*(?:\[\])?\s*(?:#.*)?$/.test(line));
    if (at < 0) continue;
    let end = segment.length - 1;
    for (let i = at + 1; i < segment.length - 1; i++) {
      if (/^\s{2}[a-zA-Z][\w-]*:\s*/.test(segment[i])) { end = i - 1; break; }
    }
    return segment.slice(at, end + 1).join("\n");
  }
  return null;
}

function proseSections(text) {
  const excluded = new Set();
  for (const block of fencedBlocks(text)) for (let i = block.start; i <= block.end; i++) excluded.add(i);
  const lines = text.split(/\r?\n/);
  const sections = [];
  const preamble = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    if (excluded.has(i)) continue;
    const heading = lines[i].match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      if (current) sections.push(current);
      current = { level: heading[1].length, heading: heading[2].trim(), lines: [] };
    } else if (current) current.lines.push(lines[i]);
    else preamble.push(lines[i]);
  }
  if (current) sections.push(current);
  if (preamble.some((line) => line.trim())) sections.unshift({ level: 2, heading: "Preamble", lines: preamble });
  const relevant = sections.filter((section) => /decision|depart|finding|gap|risk|handoff|introduced|discrepanc|assumption|follow.?up|subsequent/i.test(section.heading));
  const selected = relevant.length ? relevant : sections.filter((section) => section.level <= 2);
  return selected.map((section) => ({ heading: section.heading, text: section.lines.join("\n").trim() })).filter((section) => section.text);
}

function relevantPaths(recordPath, text) {
  const matches = [...text.matchAll(/(?:^|[\s(`])((?:\.\.\/|\.\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[a-zA-Z0-9]{1,8})(?=$|[\s):,`])/gm)].map((match) => match[1]);
  const scalarPaths = [...text.matchAll(/^\s*(?:path|file|source|approval_source|consumed|spec):\s*["']?([^\s"']+)["']?\s*$/gm)]
    .map((match) => match[1])
    .filter((value) => value.includes("/") || /\.[a-zA-Z0-9]{1,8}$/.test(value));
  return [...new Set([recordPath, ...matches, ...scalarPaths])];
}

async function filesIn(dir, pattern) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => path.join(dir, entry.name)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function loadRecord(root, file, kind) {
  let text;
  try { text = await readFile(file, "utf8"); }
  catch (error) { throw new Error(`Cannot read referenced ${kind} input ${file}: ${error.message}`); }
  if (!text.trim()) throw new Error(`Empty ${kind} input: ${file}`);
  const signatures = [...text.matchAll(/^\s*signature:\s*(.+?)\s*$/gm)].map((match) => match[1].replace(/^['"]|['"]$/g, ""));
  const decisions = [...text.matchAll(/^\s*decision:\s*(fixed|dismissed)\s*$/gm)].map((match) => match[1]);
  const verdict = text.match(/^\s*verdict:\s*([^\s#]+)\s*$/m)?.[1] ?? null;
  const recordPath = path.relative(root, file).split(path.sep).join("/");
  const sectionData = proseSections(text);
  const introduced = kind === "learning" ? introducedBlock(text) : null;
  return {
    path: recordPath,
    kind,
    step: stepNumber(path.basename(file)),
    verdict,
    signatures,
    decisions,
    status: "unknown; inspect source and current code",
    headings: headings(text),
    introduced,
    proseSections: sectionData,
    relevantPaths: relevantPaths(recordPath, text),
  };
}

export async function buildHistoryIndex(specDir) {
  const root = path.resolve(specDir);
  let specText;
  try { specText = await readFile(path.join(root, "spec.md"), "utf8"); }
  catch (error) { throw new Error(`Invalid spec directory ${root}: required spec.md is unavailable (${error.message})`); }
  if (!specText.trim()) throw new Error(`Invalid spec directory ${root}: spec.md is empty`);
  const learnings = await filesIn(path.join(root, "learnings"), /^step-\d+-learning\.md$/);
  const legacy = await filesIn(root, /^step-\d+-learning\.md$/);
  const canonicalSteps = new Set(learnings.map((file) => path.basename(file)));
  const learningFiles = [...learnings, ...legacy.filter((file) => !canonicalSteps.has(path.basename(file)))].sort();
  const reviewFiles = await filesIn(path.join(root, "reviews"), /^[a-zA-Z0-9_-]+-(?:review|fix)\.md$/);
  const records = [];
  for (const file of learningFiles) records.push(await loadRecord(root, file, "learning"));
  for (const file of reviewFiles) records.push(await loadRecord(root, file, /-fix\.md$/.test(file) ? "fix" : "review"));
  records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  // A fix may name a consumed review that is absent. Keep the broken reference visible.
  const knownPaths = new Set(records.map((record) => record.path));
  for (const record of records.filter((item) => item.kind === "fix")) {
    const source = path.join(root, record.path);
    const content = await readFile(source, "utf8");
    const consumed = content.match(/^\s*consumed:\s*["']?([^\s"']+)/m)?.[1];
    const normalizedConsumed = consumed?.replaceAll("\\", "/");
    if (consumed && ![...knownPaths].some((known) => normalizedConsumed.endsWith(known)) && !await exists(path.resolve(root, consumed))) {
      record.missingReferences = [{ path: consumed, status: "missing referenced review" }];
      record.status = "unknown; referenced review is missing";
    }
  }
  return { version: 1, purpose: "navigation only; source records remain authoritative", records };
}

async function exists(file) {
  try { await readFile(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--spec-dir") throw new Error(usage);
  const root = path.resolve(args[1]);
  const index = await buildHistoryIndex(root);
  const output = path.join(root, "history-index.json");
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  console.log(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
