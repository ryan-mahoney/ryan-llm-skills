// Short display titles for discussion threads, suggested by a fast model
// through Pi's one-shot print mode. The call runs with no tools, extensions,
// skills, context files or session, so it can only return text. Any failure,
// timeout or unusable reply returns null and the caller keeps its default
// title; naming never blocks or fails the work it labels.

import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";

export const TITLE_MODEL = "deepseek/deepseek-flash";
const TITLE_TIMEOUT_MS = 15000;
const MAX_INPUT_CHARS = 2000;
const MAX_TITLE_CHARS = 80;
const MAX_OUTPUT_BYTES = 4096;
const SYSTEM_PROMPT =
  "Reply with only a short title (2 to 6 words, sentence case, no quotes or trailing punctuation) " +
  "for a conversation that starts with the user's message.";

// Reduce a model reply to one plain line: the first non-empty line without
// markdown markers, a "Title:" label, wrapping quotes or trailing punctuation,
// cut at a word boundary. Returns null when nothing usable remains.
export function cleanTitle(reply) {
  if (typeof reply !== "string") return null;
  const line = reply.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry !== "");
  if (line === undefined) return null;
  let title = line
    .replace(/^#+\s*/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^[*_`"'“‘]+|[*_`"'”’]+$/g, "")
    .replace(/[.!?:;,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length > MAX_TITLE_CHARS) {
    const cut = title.slice(0, MAX_TITLE_CHARS);
    const space = cut.lastIndexOf(" ");
    title = (space > 0 ? cut.slice(0, space) : cut).trim();
  }
  return title === "" ? null : title;
}

// The shared tool-free one-shot Pi print runner. Resolves the RAW stdout on a
// clean bounded exit (code 0, output within maxOutputBytes) — reply cleanup
// stays in cleanTitle. Exactly one settle: the first terminal event wins, and
// timeout or abort kills the child (SIGTERM); stdout/close listeners stay
// attached so a late exit is drained without throwing or flipping the result.
export function printReply({
  text,
  systemPrompt,
  model = TITLE_MODEL,
  timeoutMs = TITLE_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  spawn = nodeSpawn,
  signal,
} = {}) {
  if (typeof text !== "string" || text.trim() === "") return Promise.resolve(null);
  if (signal?.aborted) return Promise.resolve(null);
  const args = [
    "--print",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--model",
    model,
    "--thinking",
    "off",
  ];
  if (typeof systemPrompt === "string" && systemPrompt !== "") {
    args.push("--system-prompt", systemPrompt);
  }
  args.push("--", text);
  return new Promise((resolvePromise) => {
    let settled = false;
    let output = "";
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortRun);
      resolvePromise(value);
    };
    const abortRun = () => {
      child?.kill("SIGTERM");
      finish(null);
    };
    const timer = setTimeout(() => {
      child?.kill("SIGTERM");
      finish(null);
    }, timeoutMs);
    signal?.addEventListener("abort", abortRun, { once: true });
    try {
      child = spawn("pi", args, { cwd: tmpdir(), shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }
    if (signal?.aborted) {
      child.kill("SIGTERM");
      finish(null);
      return;
    }
    child.on("error", () => finish(null));
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      output += chunk;
      if (output.length > maxOutputBytes) {
        child.kill("SIGTERM");
        finish(null);
      }
    });
    child.on("close", (code) => finish(code === 0 ? output : null));
  });
}

// Naming delegates to printReply and cleans its raw reply; anything unusable
// resolves null and the caller keeps its default title.
export function suggestTitle(text, { spawn = nodeSpawn, timeoutMs = TITLE_TIMEOUT_MS, model = TITLE_MODEL } = {}) {
  if (typeof text !== "string" || text.trim() === "") return Promise.resolve(null);
  return printReply({
    text: text.slice(0, MAX_INPUT_CHARS),
    systemPrompt: SYSTEM_PROMPT,
    model,
    timeoutMs,
    spawn,
  }).then(cleanTitle);
}
