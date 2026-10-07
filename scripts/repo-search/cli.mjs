#!/usr/bin/env node
// Step 6 public CLI. Parses the global option grammar, calls the Node client,
// prints one JSON line with --json or a short human summary, and sets the exit
// code from the receipt. Progress never goes to stdout.

import { runCommand, searchRepository, validateCommandOptions } from "./client.mjs";
import { formatSearchHuman, formatSearchJson } from "./format.mjs";

const COMMANDS = new Set([
  "status",
  "check",
  "build",
  "update",
  "reindex",
  "search",
  "configure",
  "forget",
  "prune",
  "recover",
]);

const VALUE_FLAGS = new Set([
  "--root",
  "--state",
  "--models",
  "--timeout-ms",
  "--spec-use",
  "--operation",
  "--query",
  "--mode",
  "--limit",
]);

const BOOLEAN_FLAGS = new Set(["--json"]);

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function escapeControl(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(2, "0");
    return `\\x${code}`;
  });
}

function parseArgs(argv) {
  const command = argv[0];
  if (command === undefined || !COMMANDS.has(command)) {
    usage(`Unknown or missing command: ${command ?? ""}`);
    return null;
  }

  const options = {};
  let json = false;
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (BOOLEAN_FLAGS.has(flag)) {
      if (seen.has(flag)) {
        usage(`Duplicate option: ${flag}`);
        return null;
      }
      seen.add(flag);
      json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      usage(`Unknown option: ${flag}`);
      return null;
    }
    if (seen.has(flag)) {
      usage(`Duplicate option: ${flag}`);
      return null;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      usage(`Missing value for ${flag}`);
      return null;
    }
    seen.add(flag);
    index += 1;
    if (flag === "--timeout-ms") {
      if (!/^[1-9]\d*$/.test(value)) {
        usage(`--timeout-ms requires a positive integer`);
        return null;
      }
      options.timeoutMs = Number.parseInt(value, 10);
    } else if (flag === "--spec-use") {
      if (value !== "on" && value !== "off") {
        usage(`--spec-use requires on|off`);
        return null;
      }
      options.specUse = value === "on";
    } else if (flag === "--operation") {
      options.operation = value;
    } else if (flag === "--query") {
      options.query = value;
    } else if (flag === "--mode") {
      if (value !== "vector" && value !== "bm25") {
        usage(`--mode requires vector|bm25`);
        return null;
      }
      options.mode = value;
    } else if (flag === "--limit") {
      if (!/^[1-9]\d*$/.test(value)) {
        usage(`--limit requires a positive integer`);
        return null;
      }
      options.limit = Number.parseInt(value, 10);
    } else if (flag === "--root") {
      options.root = value;
    } else if (flag === "--state") {
      options.state = value;
    } else if (flag === "--models") {
      options.models = value;
    }
  }
  return { command, options, json };
}

function humanSummary(command, receipt) {
  const lines = [`command: ${command}`, `status: ${receipt.status ?? "unknown"}`];
  if (receipt.reason) lines.push(`reason: ${escapeControl(receipt.reason)}`);
  if (receipt.checkoutKey) lines.push(`checkoutKey: ${escapeControl(receipt.checkoutKey)}`);
  if (receipt.message) lines.push(`message: ${escapeControl(receipt.message)}`);
  const inner = receipt.receipt;
  if (inner && typeof inner === "object") {
    if (inner.availability) lines.push(`availability: ${escapeControl(inner.availability)}`);
    if (inner.currentGenerationId !== undefined) {
      lines.push(`current: ${inner.currentGenerationId ?? "none"}`);
    }
    if (inner.operation) lines.push(`operation: ${escapeControl(inner.operation)}`);
    if (Array.isArray(inner.deleted)) lines.push(`deleted: ${inner.deleted.length}`);
    if (Array.isArray(inner.retained)) lines.push(`retained: ${inner.retained.length}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) return;
  if (parsed.command === "search") {
    const grammar = validateCommandOptions(parsed.command, parsed.options);
    if (!grammar.ok) {
      usage(grammar.message);
      return;
    }
  }

  // Own terminal signals for the duration of the owned child so cancellation
  // settles the detached worker group before this process returns.
  const controller = new AbortController();
  const onTermination = () => controller.abort();
  process.on("SIGINT", onTermination);
  process.on("SIGTERM", onTermination);
  try {
    if (parsed.command === "search") {
      const receipt = await searchRepository({
        root: parsed.options.root,
        query: parsed.options.query,
        usage: "operator",
        stateRoot: parsed.options.state,
        modelsRoot: parsed.options.models,
        mode: parsed.options.mode,
        limit: parsed.options.limit,
        timeoutMs: parsed.options.timeoutMs,
        signal: controller.signal,
      });
      const output = parsed.json ? formatSearchJson(receipt) : formatSearchHuman(receipt);
      // Formatter output is written exactly once; the human formatter owns its
      // trailing newline and JSON must not gain an extra byte.
      process.stdout.write(output);
      process.exitCode = receipt.exitCode ?? 1;
      return;
    }

    const receipt = await runCommand(parsed.command, {
      ...parsed.options,
      signal: controller.signal,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } else {
      process.stdout.write(humanSummary(parsed.command, receipt));
    }
    process.exitCode = receipt.exitCode ?? 1;
  } finally {
    process.removeListener("SIGINT", onTermination);
    process.removeListener("SIGTERM", onTermination);
  }
}

main().catch((error) => {
  process.stderr.write(`${escapeControl(error && error.message ? error.message : String(error))}\n`);
  process.exitCode = 1;
});
