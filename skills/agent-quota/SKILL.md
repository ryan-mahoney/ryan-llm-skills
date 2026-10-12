---
name: agent-quota
description: "Report Claude Code and Codex subscription quota (percent of each session and weekly window used, with reset times and model-scoped weekly limits) and DeepSeek and OpenRouter prepaid balance and spend. Use for 'how much quota is left', 'check Claude/Codex limits', 'what is my DeepSeek/OpenRouter balance', 'am I near my weekly limit', or before starting long agent work. Read-only; reports a signed-out CLI instead of logging in."
argument-hint: "[--provider claude|codex|deepseek|openrouter|all] [--json]"
disable-model-invocation: false
license: MIT
metadata:
  author: Ryan Mahoney
  homepage: ryan-mahoney.net
  version: "1"
---

# Agent Quota

Run the collector before answering a quota question. Its output is the source of
observed usage; do not estimate quota from session logs or token counts.

## Invoke the installed collector

Resolve `agent_quota_skill_dir` to the absolute directory containing the loaded
`SKILL.md`, and quote it; do not assume the current working directory contains the skill.
Node 18 or later is required.

```bash
node "$agent_quota_skill_dir/scripts/agent-quota.mjs"                    # every configured provider, text
node "$agent_quota_skill_dir/scripts/agent-quota.mjs" --provider codex --json
```

- **Claude** reads Claude Code's OAuth token from the macOS Keychain
  (`Claude Code-credentials`, hashed per `CLAUDE_CONFIG_DIR`) or `.credentials.json`,
  and calls Anthropic's OAuth usage endpoint. Results are cached for 60 seconds because the
  endpoint rate-limits frequent polling; a cached result says `source: "cache"`. The first
  Keychain read can show a macOS prompt.
- **Codex** asks `codex app-server` (`account/rateLimits/read`), so Codex keeps owning its tokens.
- **DeepSeek** and **OpenRouter** use their documented API-key endpoints (`/user/balance`;
  `/api/v1/key` and `/api/v1/credits`). Keys come from `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY`,
  then `~/.pi/agent/auth.json`. The default run skips an API provider with no key;
  `--provider <name>` reports it as `not_configured`.

JSON output is an array with one object per provider: `provider`, `plan`, `status`,
`source`, `fetched_at`, and `windows[]` of `{name, used_percent, resets_at}`. Window names are
`session`, `weekly`, and `weekly_<model>` for model-scoped limits. Report only the windows
returned; a plan that has no session window (for example Codex Pro) is not 0% used.

DeepSeek and OpenRouter are prepaid, so they have no windows. They return `balances[]` of
`{currency, amount, ...}` (DeepSeek: `paid`, `granted`; OpenRouter: `purchased`, `used`).
OpenRouter also returns `spend` (`today`, `week`, `month`, `lifetime` for this key),
`key_limit` (`null` when the key has no cap), and `free_requests` for free models today. An
OpenRouter key may be refused the credits call; the result stays `ok` with a `message`
and an empty `balances` list, which means the balance is unknown, not zero.

## Status and exit codes

| status | exit | meaning and next action |
|---|---|---|
| `ok` | 0 | quota reported |
| `signed_out` | 2 | the CLI has no login; tell the operator to run `claude auth login` or `codex login` |
| `token_stale` | 3 | Claude's access token expired; Claude Code refreshes it on its next request |
| `unavailable` | 3 | network error, rejected API key, rate limit without a cached result, or Keychain denied; report the message |
| `not_configured` | 3 | an API provider was requested by name but has no key |

## Authority

The collector never refreshes, writes, or deletes credentials and never starts a login.
When a provider is signed out, say so and stop; do not attempt sign-in or browser automation.
The Claude and Codex usage sources are undocumented provider interfaces and may change;
report an unexpected empty `windows` or `balances` list rather than inventing values.
