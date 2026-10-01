#!/usr/bin/env node
// Validates docs/product-brief.md against the corpus it cites (C-12, R12): every
// SCRN-###, JRNY-### and FEAT-### token resolves, the Basis heading is present,
// no local run-directory path is cited, and, with --routes, every route an
// inventory row claims is in the router's own route list.
//
// Usage:
//   node validate-brief.mjs <brief> [--inventories docs/inventories]
//     [--registry docs/journey-registry.md] [--routes <file>]
//
// A resolving citation proves the reference exists, not that the sentence is true;
// the skill samples claims against the code for that.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const TOKEN = /\b(?:SCRN|JRNY|FEAT)-\d{3}\b/g;
const SCREEN_ID = /^SCRN-\d{3}$/;
const JOURNEY_ID = /^JRNY-\d{3}$/;
const FEATURE_ID = /^FEAT-\d{3}$/;

// The banned run-directory path is assembled rather than written out, so this
// skill directory never contains the path the validator rejects in a brief.
const UNCOMMITTED_PATH = new RegExp(`\\.${"specs"}/`);

const NO_ROUTE_CELLS = new Set(["", "-", "–", "—", "n/a", "none"]);
const BASIS_HEADING = /^##\s+Basis\s*$/m;

/** Every line of a markdown table as trimmed cells, with its one-based line. */
export function tableRows(text) {
  const rows = [];
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) return;
    const body = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
    const cells = body.split("|").map((cell) => cell.trim());
    const rule = cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")));
    rows.push({ cells, line: index + 1, rule });
  });
  return rows;
}

/**
 * One block per table, rule rows removed, so each table keeps its own header.
 * Blocking on contiguous lines keeps a table's header paired with its rows.
 */
export function tableBlocks(text) {
  const blocks = [];
  let block = null;
  let previousLine = null;
  for (const row of tableRows(text)) {
    if (!block || row.line !== previousLine + 1) {
      block = [];
      blocks.push(block);
    }
    if (!row.rule) block.push(row);
    previousLine = row.line;
  }
  return blocks.filter((rows) => rows.length > 0);
}

/** Every ID in `text` defined as the first cell of a table row. */
export function definedIds(texts) {
  const ids = new Set();
  for (const text of texts) {
    for (const { cells } of tableRows(text)) {
      const first = stripCode(cells[0] ?? "");
      if (SCREEN_ID.test(first) || JOURNEY_ID.test(first) || FEATURE_ID.test(first)) ids.add(first);
    }
  }
  return ids;
}

/** Every screen row the inventory files claim, with the routes each one cites. */
export function inventoryScreens(inventories) {
  const screens = [];
  for (const { path, text } of inventories) {
    for (const block of tableBlocks(text)) {
      const header = block.findIndex((row) =>
        row.cells.some((cell) => stripCode(cell).toLowerCase() === "route"),
      );
      if (header === -1) continue;
      const column = block[header].cells.findIndex((cell) => stripCode(cell).toLowerCase() === "route");
      for (const row of block.slice(header + 1)) {
        const id = stripCode(row.cells[0] ?? "");
        if (!SCREEN_ID.test(id)) continue;
        screens.push({ id, file: path, line: row.line, routes: routesInCell(row.cells[column]) });
      }
    }
  }
  return screens;
}

/**
 * Every route path a cell claims. A cell may hold one backticked path, several
 * separated by commas, or alternatives joined by "or"; `—` and the like mean the
 * row claims no route.
 */
export function routesInCell(cell) {
  const text = stripCode(cell ?? "");
  if (NO_ROUTE_CELLS.has(text.trim().toLowerCase())) return [];
  return text
    .split(/[\s,]+/)
    .filter((token) => token.startsWith("/"))
    .map((route) => route.replace(/[.;:]+$/, ""))
    .filter(Boolean);
}

/** Every whitespace-delimited token beginning with `/`, so raw route output works. */
export function routeList(text) {
  return new Set(text.split(/\s+/).filter((token) => token.startsWith("/")));
}

/**
 * Every failure in one brief, in reading order: unresolvable tokens, a cited
 * run-directory path, a missing Basis heading, then routes absent from the list.
 */
export function validateBrief({ brief, briefPath = "brief", inventories = [], registry = [], routes = null }) {
  const failures = [];
  const defined = definedIds([...inventories.map((file) => file.text), ...registry, brief]);

  const lines = brief.split("\n");
  lines.forEach((line, index) => {
    for (const token of line.match(TOKEN) ?? []) {
      if (defined.has(token)) continue;
      failures.push(`${briefPath}:${index + 1}: ${token} is not defined in the inventories, registry or this brief`);
    }
    if (UNCOMMITTED_PATH.test(line)) {
      failures.push(`${briefPath}:${index + 1}: cites a local run path, which never reaches a commit`);
    }
  });

  if (!BASIS_HEADING.test(brief)) {
    failures.push(`${briefPath}: no "## Basis" heading`);
  }

  if (routes) {
    for (const screen of inventoryScreens(inventories)) {
      for (const route of screen.routes) {
        if (routes.has(route)) continue;
        failures.push(`${screen.file}:${screen.line}: ${screen.id} cites route ${route}, which is not in the route list`);
      }
    }
  }

  return failures;
}

export function parseArgs(argv) {
  const args = { brief: null, inventories: null, registry: null, routes: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg, null];
    const value = () => {
      if (inline !== null) return inline;
      index += 1;
      return argv[index];
    };
    switch (flag) {
      case "--inventories": args.inventories = value(); break;
      case "--registry": args.registry = value(); break;
      case "--routes": args.routes = value(); break;
      default:
        if (flag.startsWith("--")) throw new Error(`unknown flag ${flag}`);
        if (args.brief !== null) throw new Error(`unexpected argument ${arg}`);
        args.brief = arg;
    }
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.brief) throw new Error("usage: validate-brief.mjs <brief> [--inventories dir] [--registry file] [--routes file]");
  const briefPath = resolve(args.brief);
  if (!existsSync(briefPath)) throw new Error(`${args.brief}: missing brief file`);

  const inventoryPaths = readCorpus(args.inventories ?? "docs/inventories", "--inventories", args.inventories !== null);
  const inventoryFiles = inventoryPaths
    .map((path) => ({ path: display(path), text: readText(path) }))
    .filter((file) => file.text !== null);
  const registry = readCorpus(args.registry ?? "docs/journey-registry.md", "--registry", args.registry !== null)
    .map((path) => readText(path))
    .filter((text) => text !== null);

  let routes = null;
  if (args.routes) {
    const routeText = readText(resolve(args.routes));
    if (routeText === null) throw new Error(`${args.routes}: missing route list`);
    routes = routeList(routeText);
  }

  const failures = validateBrief({
    brief: readFileSync(briefPath, "utf8"),
    briefPath: args.brief,
    inventories: inventoryFiles,
    registry,
    routes,
  });

  if (failures.length === 0) {
    process.stdout.write("ok\n");
    return;
  }
  for (const failure of failures) process.stderr.write(`validate-brief: ${failure}\n`);
  process.exitCode = 1;
}

/** Corpus paths from a directory or a single file. A named path must exist. */
function readCorpus(argument, flag, required) {
  const path = resolve(argument);
  if (!existsSync(path)) {
    if (required) throw new Error(`${argument}: missing ${flag} path`);
    return [];
  }
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => join(path, name));
  }
  return [path];
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function stripCode(cell) {
  return cell.replace(/`/g, "").trim();
}

/** A repository-relative path where possible, so a failure names the document. */
function display(path) {
  return relative(process.cwd(), path) || path;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`validate-brief: ${error.message}\n`);
    process.exit(1);
  }
}