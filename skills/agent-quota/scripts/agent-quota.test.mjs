import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claudeKeychainService, normalizeClaude, normalizeCodex, normalizeDeepseek, normalizeOpenRouter, apiKey, exitCode, parseArgs,
} from "./agent-quota.mjs";

// Run alone: node --test agent-quota.test.mjs

test("claude keychain service is unscoped by default and hashed for a custom config dir", () => {
  assert.equal(claudeKeychainService({}), "Claude Code-credentials");
  // Expected suffix: printf '%s' /tmp/claude-alt | shasum -a 256 | cut -c1-8
  assert.equal(claudeKeychainService({ CLAUDE_CONFIG_DIR: "/tmp/claude-alt" }), "Claude Code-credentials-04923786");
});

test("claude limits[] maps session, weekly and model-scoped weekly windows", () => {
  const body = {
    five_hour: { utilization: 99, resets_at: "ignored" },
    limits: [
      { kind: "session", percent: 0, resets_at: "2026-10-12T16:39:59Z", scope: null },
      { kind: "weekly_all", percent: 20, resets_at: "2026-10-14T17:59:59Z", scope: null },
      { kind: "weekly_scoped", percent: 16, resets_at: "2026-10-14T17:59:59Z", scope: { model: { id: null, display_name: "Fable" } } },
    ],
  };
  assert.deepEqual(normalizeClaude(body), [
    { name: "session", used_percent: 0, resets_at: "2026-10-12T16:39:59Z" },
    { name: "weekly", used_percent: 20, resets_at: "2026-10-14T17:59:59Z" },
    { name: "weekly_fable", used_percent: 16, resets_at: "2026-10-14T17:59:59Z" },
  ]);
});

test("claude without limits[] falls back to per-window keys and skips null windows", () => {
  const body = { five_hour: null, seven_day: { utilization: 41, resets_at: "2026-10-14T18:00:00Z" }, seven_day_opus: null };
  assert.deepEqual(normalizeClaude(body), [{ name: "weekly", used_percent: 41, resets_at: "2026-10-14T18:00:00Z" }]);
});

test("codex maps windows by duration and tolerates a null secondary", () => {
  const result = {
    rateLimits: { primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1792295905 }, secondary: null, planType: "pro" },
  };
  assert.deepEqual(normalizeCodex(result), {
    plan: "pro",
    windows: [{ name: "weekly", used_percent: 10, resets_at: "2026-10-18T03:58:25.000Z" }],
  });
  const both = { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 7, windowDurationMins: 10080 } } };
  assert.deepEqual(normalizeCodex(both).windows.map((w) => w.name), ["session", "weekly"]);
});

test("exit code prefers signed_out over other failures", () => {
  assert.equal(exitCode([{ status: "ok" }, { status: "ok" }]), 0);
  assert.equal(exitCode([{ status: "token_stale" }, { status: "ok" }]), 3);
  assert.equal(exitCode([{ status: "unavailable" }, { status: "signed_out" }]), 2);
});

test("arguments default to all providers and reject unknown ones", () => {
  assert.equal(parseArgs([]).provider, "all");
  assert.deepEqual(parseArgs(["--provider", "openrouter", "--json"]), { provider: "openrouter", json: true, help: false });
  assert.throws(() => parseArgs(["--provider", "gemini"]), /--provider/);
});

test("deepseek balances keep paid and granted amounts per currency", () => {
  const body = {
    is_available: true,
    balance_infos: [
      { currency: "USD", total_balance: "96.21", granted_balance: "0.00", topped_up_balance: "96.21" },
      { currency: "CNY", total_balance: "10.00", granted_balance: "10.00", topped_up_balance: "0.00" },
    ],
  };
  assert.deepEqual(normalizeDeepseek(body), [
    { currency: "USD", amount: 96.21, paid: 96.21, granted: 0 },
    { currency: "CNY", amount: 10, paid: 0, granted: 10 },
  ]);
});

test("openrouter balance is credits minus usage; a key without a limit has no key_limit", () => {
  const key = { data: { limit: null, limit_remaining: null, usage: 228.9, usage_daily: 0.03, usage_weekly: 0.03, usage_monthly: 52.31,
    free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 } } };
  const result = normalizeOpenRouter(key, { data: { total_credits: 270, total_usage: 249.582158066 } });
  assert.deepEqual(result.balances, [{ currency: "USD", amount: 20.417842, purchased: 270, used: 249.582158066 }]);
  assert.deepEqual(result.spend, { currency: "USD", today: 0.03, week: 0.03, month: 52.31, lifetime: 228.9 });
  assert.equal(result.key_limit, null);
});

test("openrouter keeps key data when credits are refused and reports a capped key", () => {
  const key = { data: { limit: 50, limit_remaining: 12.5, limit_reset: "monthly", usage: 37.5 } };
  const result = normalizeOpenRouter(key, undefined);
  assert.deepEqual(result.balances, []);
  assert.deepEqual(result.key_limit, { limit: 50, remaining: 12.5, reset: "monthly" });
});

test("api keys come from the environment before the pi auth file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-quota-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(authFile, JSON.stringify({ deepseek: { type: "api_key", key: "from-file" }, openrouter: { type: "oauth", key: "x" } }));
  assert.equal(apiKey("deepseek", { env: {}, authFile }), "from-file");
  assert.equal(apiKey("deepseek", { env: { DEEPSEEK_API_KEY: "from-env" }, authFile }), "from-env");
  assert.equal(apiKey("openrouter", { env: {}, authFile }), null);
  assert.equal(apiKey("openrouter", { env: {}, authFile: path.join(dir, "missing.json") }), null);
});
