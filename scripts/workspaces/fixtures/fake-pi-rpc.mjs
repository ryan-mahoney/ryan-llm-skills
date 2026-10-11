#!/usr/bin/env node
// Fake `pi --mode rpc` child for the pi-rpc transport tests.
//
// Mirrors the installed 1.1.0 command/response/event JSONL contract just
// enough to exercise the adapter boundary: get_state/get_commands identity
// policy, correlated responses, prompt events, tool/extension refusals,
// framing faults and stdin shutdown. Production code never imports this file.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

function readJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const sessionDir = flag("--session-dir") ?? process.cwd();
const resumePath = flag("--session");
let sessionId = flag("--session-id");
let sessionFile;
if (resumePath !== undefined) {
  sessionFile = resolve(resumePath);
  if (existsSync(sessionFile)) {
    try {
      const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]);
      if (header && typeof header.id === "string") sessionId = header.id;
    } catch {
      // unreadable header: keep the argument value
    }
  }
}
if (typeof sessionId !== "string" || sessionId.length === 0) {
  sessionId = "00000000-0000-4000-8000-000000000000";
}
if (sessionFile === undefined) sessionFile = join(sessionDir, `2024-01-01T00-00-00-000Z_${sessionId}.jsonl`);
if (process.env.FAKE_PI_STATE_ID) sessionId = process.env.FAKE_PI_STATE_ID;
if (process.env.FAKE_PI_STATE_FILE) sessionFile = resolve(process.env.FAKE_PI_STATE_FILE);

const delays = readJsonEnv("FAKE_PI_DELAYS", {});
const promptEvents = readJsonEnv("FAKE_PI_PROMPT_EVENTS", []);
const commands = readJsonEnv("FAKE_PI_COMMANDS", []);
const stateLater = readJsonEnv("FAKE_PI_GET_STATE_LATER", null);
const commandLog = process.env.FAKE_PI_COMMAND_LOG;
const uiRequests = new Map();
const deferred = new Map();
let getStateCount = 0;

if (process.env.FAKE_PI_HANG === "1") setInterval(() => {}, 1 << 30);

function writeLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeSplit(value) {
  const buffer = Buffer.from(`${JSON.stringify(value)}\n`);
  // Cut strictly inside the first multibyte UTF-8 sequence so the adapter's
  // shared StringDecoder must reconstruct a split character; ASCII-only frames
  // keep the midpoint fallback.
  let cut = Math.max(1, Math.floor(buffer.length / 2));
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte < 0xc0) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    if (index + width <= buffer.length) {
      cut = index + 1;
      break;
    }
  }
  process.stdout.write(buffer.subarray(0, cut));
  setImmediate(() => process.stdout.write(buffer.subarray(cut)));
}

function respond(value) {
  if (process.env.FAKE_PI_SPLIT_WRITES === "1") writeSplit(value);
  else writeLine(value);
}

function respondSuccess(id, command, data) {
  respond(data === undefined ? { id, type: "response", command, success: true } : { id, type: "response", command, success: true, data });
}

function respondError(id, command, error) {
  respond({ id, type: "response", command, success: false, error });
}

function sendEvent(event) {
  writeLine(event);
}

function sendOversize() {
  const size = Number(process.env.FAKE_PI_OVERSIZE_BYTES ?? 1572864);
  process.stdout.write(Buffer.alloc(Number.isFinite(size) ? size : 1572864, 0x78));
}

// Returns "deferred" when the response waits for extension_ui_response,
// "skip" when the transport fault replaces the response, otherwise "continue".
function startPolicy(command) {
  const toolOn = process.env.FAKE_PI_TOOL_ON;
  const toolLater = process.env.FAKE_PI_TOOL_LATER;
  if (toolOn === command.type || (toolLater === command.type && getStateCount >= 1)) {
    sendEvent({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: process.env.FAKE_PI_TOOL_NAME ?? "bash",
      args: {},
    });
  }
  if (process.env.FAKE_PI_EXTENSION_UI_ON === command.type) {
    const uiId = process.env.FAKE_PI_UI_ID ?? "ui-1";
    uiRequests.set(uiId, { command, uiId });
    sendEvent({
      type: "extension_ui_request",
      id: uiId,
      method: process.env.FAKE_PI_UI_METHOD ?? "confirm",
      title: "t",
      message: "m",
    });
    return "deferred";
  }
  if (process.env.FAKE_PI_MALFORMED_ON === command.type) process.stdout.write("not json\n");
  if (process.env.FAKE_PI_OVERSIZE_ON === command.type) {
    sendOversize();
    return "skip";
  }
  if (process.env.FAKE_PI_EOF_ON === command.type) {
    process.stdout.write('{"partial":');
    process.stdout.end();
    return "skip";
  }
  return "continue";
}

function respondTo(command) {
  switch (command.type) {
    case "get_state": {
      getStateCount += 1;
      if (process.env.FAKE_PI_GET_STATE_HANG === "1") return;
      let currentId = sessionId;
      let currentFile = sessionFile;
      if (getStateCount > 1 && stateLater && typeof stateLater === "object") {
        if (typeof stateLater.sessionId === "string") currentId = stateLater.sessionId;
        if (typeof stateLater.sessionFile === "string") currentFile = resolve(stateLater.sessionFile);
      }
      respondSuccess(command.id, "get_state", {
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
        sessionFile: currentFile,
        sessionId: currentId,
        sessionName: "discussion",
        pendingMessageCount: 0,
      });
      return;
    }
    case "get_commands":
      respondSuccess(command.id, "get_commands", { commands });
      return;
    case "get_messages":
      respondSuccess(command.id, "get_messages", {
        messages: [{ role: "assistant", content: [{ type: "text", text: process.env.FAKE_PI_MESSAGE_TEXT ?? "ok" }] }],
      });
      return;
    case "get_entries":
      respondSuccess(command.id, "get_entries", { entries: [], leafId: null });
      return;
    case "clear_queue":
      respondSuccess(command.id, "clear_queue", []);
      return;
    case "abort":
      if (process.env.FAKE_PI_ABORT_HANG === "1") return;
      respondSuccess(command.id, "abort");
      return;
    case "prompt": {
      for (const event of promptEvents) sendEvent(event);
      respondSuccess(command.id, "prompt", { disposition: process.env.FAKE_PI_DISPOSITION ?? "started" });
      return;
    }
    default:
      respondError(command.id, command.type, `Unknown command: ${command.type}`);
  }
}

async function handle(command) {
  if (!command || typeof command !== "object" || typeof command.type !== "string") return;
  const delay = Number(delays[command.id] ?? delays[command.type] ?? 0);
  if (delay > 0) await sleep(delay);
  const phase = startPolicy(command);
  if (phase === "deferred") {
    deferred.set(command.id, command);
    return;
  }
  if (phase === "skip") return;
  if (process.env.FAKE_PI_WRONG_COMMAND_ON === command.type) {
    respond({
      id: command.id,
      type: "response",
      command: process.env.FAKE_PI_WRONG_COMMAND_AS ?? "mismatch",
      success: true,
      data: {},
    });
    return;
  }
  if (process.env.FAKE_PI_FAIL_ON === command.type) {
    respondError(command.id, command.type, process.env.FAKE_PI_FAIL_MESSAGE ?? "fixture failure");
    return;
  }
  if (process.env.FAKE_PI_EXIT_ON === command.type) {
    process.exit(Number(process.env.FAKE_PI_EXIT_CODE ?? 3));
  }
  respondTo(command);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof commandLog === "string" && commandLog !== "") {
    appendFileSync(commandLog, `${JSON.stringify({ type: message?.type ?? null, id: message?.id ?? null })}\n`);
  }
  if (message && message.type === "extension_ui_response") {
    const pendingUi = uiRequests.get(message.id);
    if (pendingUi) {
      uiRequests.delete(message.id);
      sendEvent({ type: "fake_extension_ui_response", id: message.id, cancelled: message.cancelled === true });
      deferred.delete(pendingUi.command.id);
      respondTo(pendingUi.command);
    }
    return;
  }
  void handle(message);
});
rl.on("close", () => {
  if (process.env.FAKE_PI_HANG === "1") return;
  setImmediate(() => process.exit(0));
});
