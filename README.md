# LLM Fuel Dashboard

A private, dependency-free local dashboard for remaining LLM capacity.

| Tool | Display | Source |
| --- | --- | --- |
| agy / Antigravity | Per-model pool quotas, resets, prompt and AI credits | Live read-only `agy` localhost API; cache fallback |
| Codex | 5-hour + weekly remaining | Live client account API; sessions fallback |
| Claude | 5-hour + weekly remaining | Live client account API; status-line fallback |
| Claude overage | Credits remaining per account | Local `config.json` balance |
| Anthropic API | API balance remaining | Local `config.json` balance |
| OpenRouter | Credits remaining | Official `/api/v1/credits` endpoint |
| Kilo Code | Credits remaining | `kilo profile --json`, with config fallback |

The dashboard polls the same authenticated account-usage endpoints used by the
installed Claude and Codex clients. OAuth credentials are read in memory from
each profile, never returned to the browser, logged, or copied into config.
Local session/status-line data remains a fallback if an endpoint or token is
temporarily unavailable. These client-internal endpoints are not guaranteed
stable public APIs.

For agy, the server discovers the running `agy` process and its localhost
listening ports, then calls the read-only Antigravity Connect RPC
`GetUserStatus`. Models sharing the same remaining fraction and reset time are
deduplicated into one quota pool. This follows the independently implemented
approach used by `antigravity-usage`, `antigravity-usage-checker`, and
`antigravity-pulse`; no Google or Antigravity token is copied into this project.

Claude subscription status does not expose overage balances, and a regular
Anthropic API key cannot query billing balance. Set `overageRemaining` on each
Claude account and `providers.anthropicApi.remaining` in the ignored
`config.json`. These amounts are intentionally local and manually maintained.

## Start

```bash
cd 30ref/llm_dashboard
npm start
```

Open <http://127.0.0.1:8787>. To expose it to your LAN, explicitly start with
`HOST=0.0.0.0 npm start`; do not expose this unauthenticated service to the
internet.

## Claude setup

Claude provides both quota windows to its status-line input. Install the
included capture command, restart Claude, and send one message:

```bash
npm run setup:claude
```

### Multiple Claude accounts

Each account needs its own Claude config directory and dashboard cache. Configure
the status line once per account:

```bash
node setup-statusline.js --config-dir "$HOME/.claude-personal" --cache "$HOME/.claude-personal/usage-cache.json"
node setup-statusline.js --config-dir "$HOME/.claude-work" --cache "$HOME/.claude-work/usage-cache.json"
```

Then add both entries under `accounts.claude` in `config.json` (see
`config.example.json`). Start each Claude account with its matching
`CLAUDE_CONFIG_DIR`, restart Claude, and send one message. The dashboard card
shows the configured email as a subheader; the email is a label and is not read
from authentication tokens.

### Multiple Codex accounts

Codex rate-limit events do not reliably contain an account email. Keep each
account in a separate `CODEX_HOME`, then add each corresponding `sessions`
directory under `accounts.codex` in `config.json`. The dashboard will render a
separate card and email subheader for each account.

If a status line is already configured, use `npm run setup:claude:fanout` and
set `extraStatuslineCommand` in `config.json` as documented in
`config.example.json` from the upstream project history.

## OpenRouter

```bash
export OPENROUTER_API_KEY='...'
npm start
```

The key is read from the process environment and is never returned to the
browser or written by the dashboard.

## Fallback balances

Copy `config.example.json` to the ignored `config.json` to provide fallback
balances when Kilo or OpenRouter cannot be queried.

## agy quota cache

agy currently has no stable CLI quota command. The adapter accepts either
`used_percent` or `remaining_percent`, and several common field spellings:

```json
{
  "fetchedAt": 1783700000000,
  "rate_limits": {
    "five_hour": { "remaining_percent": 72, "resets_at": 1783710000 },
    "weekly": { "remaining_percent": 44, "resets_at": 1784200000 }
  }
}
```

Write that JSON to `~/.cache/agy/usage.json`, or set `AGY_USAGE_CACHE` to a
collector-generated file. If agy exposes only its 5-hour window, the weekly
field deliberately displays “not exposed” rather than estimating it.

## Configuration

| Environment variable | Default |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `PORT` | `8787` |
| `REFRESH_MS` | `60000` (minimum 15000) |
| `CLAUDE_USAGE_CACHE` | `~/.claude/usage-cache.json` |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` |
| `AGY_USAGE_CACHE` | `~/.cache/agy/usage.json` |
| `LLM_DASHBOARD_CONFIG` | `./config.json` |
| `KILO_BIN` | `kilo` |

## Verification

```bash
npm test
```

## Origin and license

Built from the MIT-licensed
[frankchiu-dev/claude-codex-usage-dashboard](https://github.com/frankchiu-dev/claude-codex-usage-dashboard),
then extended into a six-tool remaining-fuel dashboard. See `LICENSE`.
