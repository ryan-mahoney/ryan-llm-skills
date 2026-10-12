import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Claude's usage endpoint rate-limits frequent polling; reuse a recent result instead of asking again.
const CLAUDE_CACHE_TTL_MS = 60_000;
const CODEX_TIMEOUT_MS = 15_000;
const API_TIMEOUT_MS = 20_000;
const PROVIDERS = ["claude", "codex", "deepseek", "openrouter"];
const API_KEY_ENV = { deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const HELP = `Usage: agent-quota.mjs [--provider claude|codex|deepseek|openrouter|all] [--json]

Reports Claude Code and Codex subscription quota (percent used and reset time for each session
and weekly window) and DeepSeek and OpenRouter prepaid balance and spend. Read-only; never
refreshes or changes credentials. By default checks Claude, Codex, and each API provider with a
key in DEEPSEEK_API_KEY / OPENROUTER_API_KEY or ~/.pi/agent/auth.json.
Exit 0 when every provider reported, 2 when one is signed out, 3 when one is otherwise unavailable.`;

export function parseArgs(argv) {
  const options = { provider: "all", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--provider") {
      const value = argv[++i];
      if (![...PROVIDERS, "all"].includes(value)) throw new Error(`--provider must be one of ${PROVIDERS.join(", ")} or all`);
      options.provider = value;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

// Mirrors Claude Code 2.1.x: a custom CLAUDE_CONFIG_DIR stores credentials under a hashed service name.
export function claudeKeychainService(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

function windowName(minutes) {
  if (minutes === 300) return "session";
  if (minutes === 10080) return "weekly";
  return `${minutes}m`;
}

const CLAUDE_WINDOWS = [
  ["five_hour", "session"],
  ["seven_day", "weekly"],
  ["seven_day_opus", "weekly_opus"],
  ["seven_day_sonnet", "weekly_sonnet"],
];

function claudeLimitName(limit) {
  if (limit.kind === "session") return "session";
  if (limit.kind === "weekly_all") return "weekly";
  const model = limit.scope?.model?.display_name ?? limit.scope?.model?.id;
  if (limit.kind === "weekly_scoped" && model) return `weekly_${String(model).toLowerCase().replace(/\W+/g, "_")}`;
  return limit.kind;
}

// `limits[]` carries model-scoped weekly limits the older per-window keys omit; the keys remain the fallback.
export function normalizeClaude(body) {
  if (Array.isArray(body?.limits) && body.limits.length) {
    return body.limits
      .filter((limit) => typeof limit.percent === "number")
      .map((limit) => ({ name: claudeLimitName(limit), used_percent: limit.percent, resets_at: limit.resets_at ?? null }));
  }
  const windows = [];
  for (const [key, name] of CLAUDE_WINDOWS) {
    const w = body?.[key];
    if (w && typeof w.utilization === "number") {
      windows.push({ name, used_percent: w.utilization, resets_at: w.resets_at ?? null });
    }
  }
  return windows;
}

export function normalizeCodex(result) {
  const limits = result?.rateLimits ?? {};
  const windows = [];
  for (const w of [limits.primary, limits.secondary]) {
    if (w && typeof w.usedPercent === "number") {
      windows.push({
        name: windowName(w.windowDurationMins),
        used_percent: w.usedPercent,
        resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
      });
    }
  }
  return { plan: limits.planType ?? null, windows };
}

function cacheFile() {
  const base = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches")
    : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"));
  return path.join(base, "agent-quota", `claude-${claudeKeychainService().replace(/\W+/g, "-")}.json`);
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeCache(result) {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(result));
  } catch {
    // The cache only reduces polling; a failed write leaves the live result intact.
  }
}

function readClaudeCredentials() {
  if (process.platform === "darwin") {
    // Claude Code writes the item under the macOS user name; older installs can leave a stale item under
    // another account (e.g. "root") that an account-less lookup may return first.
    for (const account of [["-a", os.userInfo().username], []]) {
      const r = spawnSync("security", ["find-generic-password", "-s", claudeKeychainService(), ...account, "-w"], {
        encoding: "utf8", timeout: 60_000,
      });
      if (r.status === 0 && r.stdout.trim()) return JSON.parse(r.stdout).claudeAiOauth ?? null;
    }
  }
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8")).claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

function claudeLoggedIn() {
  const r = spawnSync("claude", ["auth", "status", "--json"], { encoding: "utf8", timeout: 20_000 });
  try {
    return JSON.parse(r.stdout).loggedIn === true;
  } catch {
    return null;
  }
}

function claudeVersion() {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.stdout?.match(/\d+\.\d+\.\d+/)?.[0] ?? "2.1.0";
}

const SIGNED_OUT = {
  claude: "Claude Code is signed out. Run `claude auth login`.",
  codex: "Codex is signed out. Run `codex login`.",
};

export async function fetchClaude({ now = Date.now() } = {}) {
  const cached = readCache();
  if (cached && now - Date.parse(cached.fetched_at) < CLAUDE_CACHE_TTL_MS) return { ...cached, source: "cache" };

  let creds;
  try {
    creds = readClaudeCredentials();
  } catch (error) {
    return { provider: "claude", status: "unavailable", message: `Could not read Claude credentials: ${error.message}` };
  }
  if (!creds?.accessToken) {
    return claudeLoggedIn() === false
      ? { provider: "claude", status: "signed_out", message: SIGNED_OUT.claude }
      : { provider: "claude", status: "unavailable", message: "No readable Claude OAuth credentials (Keychain access denied or API-key login)." };
  }
  const plan = creds.subscriptionType ?? null;
  const stale = {
    provider: "claude", plan, status: "token_stale",
    message: "Claude Code's access token has expired; Claude Code refreshes it on its next request. This script does not refresh tokens.",
  };
  if (creds.expiresAt && creds.expiresAt <= now) return stale;

  let response;
  try {
    response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-code/${claudeVersion()}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { provider: "claude", plan, status: "unavailable", message: `Usage request failed: ${error.message}` };
  }
  if (response.status === 401) {
    return claudeLoggedIn() === false ? { provider: "claude", status: "signed_out", message: SIGNED_OUT.claude } : stale;
  }
  if (response.status === 429) {
    if (cached) return { ...cached, source: "cache" };
    const retry = response.headers.get("retry-after");
    return { provider: "claude", plan, status: "unavailable", message: `Usage endpoint rate-limited${retry ? `; retry after ${retry}s` : ""}.` };
  }
  if (!response.ok) {
    return { provider: "claude", plan, status: "unavailable", message: `Usage endpoint returned HTTP ${response.status}.` };
  }
  const result = {
    provider: "claude", plan, status: "ok", source: "oauth",
    fetched_at: new Date(now).toISOString(), windows: normalizeClaude(await response.json()),
  };
  writeCache(result);
  return result;
}

export function fetchCodex({ timeoutMs = CODEX_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("codex", ["-s", "read-only", "-a", "never", "app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      resolve({ provider: "codex", status: "unavailable", message: `Could not start codex: ${error.message}` });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ provider: "codex", status: "unavailable", message: "codex app-server did not answer in time." }),
      timeoutMs,
    );
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", (error) => finish({ provider: "codex", status: "unavailable", message: `Could not start codex: ${error.message}` }));
    child.on("exit", () => finish({ provider: "codex", status: "unavailable", message: "codex app-server exited early." }));

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2 && message.error) {
          finish(/authentication required/i.test(message.error.message ?? "")
            ? { provider: "codex", status: "signed_out", message: SIGNED_OUT.codex }
            : { provider: "codex", status: "unavailable", message: `codex app-server: ${message.error.message}` });
        } else if (message.id === 2) {
          const { plan, windows } = normalizeCodex(message.result);
          finish({ provider: "codex", plan, status: "ok", source: "app-server", fetched_at: new Date().toISOString(), windows });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-quota", version: "1" } } });
  });
}

// Environment first, then the pi agent's stored keys, which is where this machine keeps them.
export function apiKey(provider, { env = process.env, authFile = path.join(os.homedir(), ".pi", "agent", "auth.json") } = {}) {
  if (env[API_KEY_ENV[provider]]) return env[API_KEY_ENV[provider]];
  try {
    const entry = JSON.parse(fs.readFileSync(authFile, "utf8"))[provider];
    return entry?.type === "api_key" && typeof entry.key === "string" && entry.key ? entry.key : null;
  } catch {
    return null;
  }
}

async function getJson(url, key) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "API key rejected (HTTP 401)" : `HTTP ${response.status}`);
  return response.json();
}

const amount = (value) => (value === null || value === undefined || value === "" ? null : Number(value));

export function normalizeDeepseek(body) {
  return (body?.balance_infos ?? []).map((info) => ({
    currency: info.currency,
    amount: amount(info.total_balance),
    paid: amount(info.topped_up_balance),
    granted: amount(info.granted_balance),
  }));
}

export async function fetchDeepseek(key) {
  try {
    const body = await getJson("https://api.deepseek.com/user/balance", key);
    return {
      provider: "deepseek", status: "ok", source: "api", fetched_at: new Date().toISOString(),
      available: body.is_available === true, balances: normalizeDeepseek(body),
    };
  } catch (error) {
    return { provider: "deepseek", status: "unavailable", message: `Balance request failed: ${error.message}` };
  }
}

// OpenRouter reports credits per account and spend/limits per key; a key may be refused the credits call.
export function normalizeOpenRouter(keyBody, creditsBody) {
  const k = keyBody?.data ?? {};
  const c = creditsBody?.data;
  return {
    balances: c ? [{ currency: "USD", amount: Math.round((c.total_credits - c.total_usage) * 1e6) / 1e6, purchased: c.total_credits, used: c.total_usage }] : [],
    spend: { currency: "USD", today: amount(k.usage_daily), week: amount(k.usage_weekly), month: amount(k.usage_monthly), lifetime: amount(k.usage) },
    key_limit: k.limit === null || k.limit === undefined ? null : { limit: k.limit, remaining: amount(k.limit_remaining), reset: k.limit_reset ?? null },
    free_requests: k.free_model_daily_requests ?? null,
  };
}

export async function fetchOpenRouter(key) {
  const [keyResult, creditsResult] = await Promise.allSettled([
    getJson("https://openrouter.ai/api/v1/key", key),
    getJson("https://openrouter.ai/api/v1/credits", key),
  ]);
  if (keyResult.status === "rejected" && creditsResult.status === "rejected") {
    return { provider: "openrouter", status: "unavailable", message: `Key and credits requests failed: ${keyResult.reason.message}` };
  }
  const result = {
    provider: "openrouter", status: "ok", source: "api", fetched_at: new Date().toISOString(),
    ...normalizeOpenRouter(keyResult.value, creditsResult.value),
  };
  const notes = [];
  if (creditsResult.status === "rejected") notes.push(`balance unavailable (${creditsResult.reason.message})`);
  if (keyResult.status === "rejected") notes.push(`key spend unavailable (${keyResult.reason.message})`);
  return notes.length ? { ...result, message: notes.join("; ") } : result;
}

function money(value, currency = "USD") {
  if (value === null || value === undefined || Number.isNaN(value)) return "unknown";
  return currency === "USD" ? `$${value.toFixed(2)}` : `${value.toFixed(2)} ${currency}`;
}

function relative(iso, now) {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (!(minutes >= 0)) return "";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `in ${days}d ${hours}h` : `in ${hours}h ${minutes % 60}m`;
}

function formatBalances(r) {
  const lines = [];
  for (const b of r.balances ?? []) {
    const detail = b.purchased !== undefined
      ? ` of ${money(b.purchased, b.currency)} purchased`
      : b.paid !== undefined ? ` (paid ${money(b.paid, b.currency)}, granted ${money(b.granted, b.currency)})` : "";
    lines.push(`  balance        ${money(b.amount, b.currency)}${detail}`);
  }
  if (r.provider === "deepseek" && r.available === false) lines.push("  account reports API access unavailable");
  if (r.spend) {
    const { today, week, month, currency } = r.spend;
    lines.push(`  key spend      today ${money(today, currency)} · week ${money(week, currency)} · month ${money(month, currency)}`);
  }
  if (r.provider === "openrouter") {
    lines.push(r.key_limit
      ? `  key limit      ${money(r.key_limit.remaining)} left of ${money(r.key_limit.limit)}${r.key_limit.reset ? `, resets ${r.key_limit.reset}` : ""}`
      : "  key limit      none");
  }
  if (r.free_requests) lines.push(`  free requests  ${r.free_requests.used}/${r.free_requests.limit} today`);
  return lines;
}

export function formatText(results, now = Date.now()) {
  const lines = [];
  for (const r of results) {
    const head = `${r.provider}${r.plan ? ` (${r.plan})` : ""}`;
    if (r.status !== "ok") {
      lines.push(`${head}: ${r.status} — ${r.message}`);
      continue;
    }
    lines.push(`${head}${r.source === "cache" ? ` [cached ${r.fetched_at}]` : ""}${r.message ? ` — ${r.message}` : ""}`);
    if (r.windows) {
      if (!r.windows.length) lines.push("  no quota windows reported");
      for (const w of r.windows) {
        const reset = w.resets_at ? `resets ${new Date(w.resets_at).toLocaleString()} (${relative(w.resets_at, now)})` : "";
        lines.push(`  ${w.name.padEnd(14)} ${String(Math.round(w.used_percent)).padStart(3)}% used  ${reset}`.trimEnd());
      }
    } else {
      lines.push(...formatBalances(r));
    }
  }
  return lines.join("\n");
}

export function exitCode(results) {
  if (results.some((r) => r.status === "signed_out")) return 2;
  if (results.some((r) => r.status !== "ok")) return 3;
  return 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    return 64;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const selected = options.provider === "all" ? PROVIDERS : [options.provider];
  const jobs = [];
  for (const provider of selected) {
    if (provider === "claude") jobs.push(fetchClaude());
    else if (provider === "codex") jobs.push(fetchCodex());
    else {
      const key = apiKey(provider);
      // An unconfigured API provider is skipped by default and reported only when requested by name.
      if (key) jobs.push(provider === "deepseek" ? fetchDeepseek(key) : fetchOpenRouter(key));
      else if (options.provider === provider) {
        jobs.push({ provider, status: "not_configured", message: `No API key in ${API_KEY_ENV[provider]} or ~/.pi/agent/auth.json.` });
      }
    }
  }
  const results = await Promise.all(jobs);
  console.log(options.json ? JSON.stringify(results, null, 2) : formatText(results));
  return exitCode(results);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
