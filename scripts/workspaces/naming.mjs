// Short display titles for discussion threads, suggested by a fast model
// through Pi's one-shot print mode. The call runs with no tools, extensions,
// skills, context files or session, so it can only return text. Any failure,
// timeout or unusable reply returns null and the caller keeps its default
// title; naming never blocks or fails the work it labels.

import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";

export const TITLE_MODEL = "openrouter/inception/mercury-2.5";
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

export function suggestTitle(text, { spawn = nodeSpawn, timeoutMs = TITLE_TIMEOUT_MS, model = TITLE_MODEL } = {}) {
  if (typeof text !== "string" || text.trim() === "") return Promise.resolve(null);
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
    "--system-prompt",
    SYSTEM_PROMPT,
    "--",
    text.slice(0, MAX_INPUT_CHARS),
  ];
  return new Promise((resolvePromise) => {
    let settled = false;
    let output = "";
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child?.kill("SIGTERM");
      finish(null);
    }, timeoutMs);
    try {
      child = spawn("pi", args, { cwd: tmpdir(), shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }
    child.on("error", () => finish(null));
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(null);
      }
    });
    child.on("close", (code) => finish(code === 0 ? cleanTitle(output) : null));
  });
}
