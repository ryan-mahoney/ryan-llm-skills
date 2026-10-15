// Short display titles for discussion threads, suggested by a fast model
// through Pi's one-shot print mode. The call runs with no tools, extensions,
// skills, context files or session, so it can only return text. Any failure,
// timeout or unusable reply returns null and the caller keeps its default
// title; naming never blocks or fails the work it labels.

import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";

export const TITLE_MODEL = "deepseek/deepseek-flash";
const TITLE_TIMEOUT_MS = 15000;
const KILL_GRACE_MS = 1000;
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
// clean bounded exit (code 0, raw stdout within maxOutputBytes) — reply cleanup
// stays in cleanTitle. Exactly one settle: the first terminal result wins.
// Cancellation (abort, deadline or over-budget output) completes only after the
// child closes, so a caller awaiting the result may start a replacement only
// once the old child has released its pipes: SIGTERM now, SIGKILL after
// killGraceMs for a TERM-resistant child, and stdout/close listeners stay
// attached so the exit is drained without throwing or flipping the result.
export function printReply({
  text,
  systemPrompt,
  model = TITLE_MODEL,
  timeoutMs = TITLE_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  killGraceMs = KILL_GRACE_MS,
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
    let cancelling = false;
    const chunks = [];
    let outputBytes = 0;
    let child;
    let killTimer;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortRun);
      resolvePromise(value);
    };
    // Cancellation completes at the drained close, never at the signal: the
    // close is what lets a caller replace the child safely. Re-entry only
    // re-asserts SIGTERM while a single KILL timer bounds the grace.
    const cancel = () => {
      if (settled) return;
      if (!cancelling) {
        cancelling = true;
        killTimer = setTimeout(() => child?.kill("SIGKILL"), killGraceMs);
      }
      child?.kill("SIGTERM");
    };
    const abortRun = () => cancel();
    const timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener("abort", abortRun, { once: true });
    try {
      child = spawn("pi", args, { cwd: tmpdir(), shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      settle(null);
      return;
    }
    if (signal?.aborted) cancel();
    child.on("error", () => {
      // A spawn failure has no child to drain (pid undefined); a failed kill
      // leaves the drained close to settle so the ordering contract holds.
      if (!cancelling || !child.pid) settle(null);
    });
    child.stdout?.on("data", (chunk) => {
      if (settled || cancelling) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      chunks.push(bytes);
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) cancel();
    });
    child.on("close", (code) => settle(cancelling || code !== 0 ? null : Buffer.concat(chunks).toString("utf8")));
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
