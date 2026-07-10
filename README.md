# LLM Fuel Dashboard

A private, dependency-free local dashboard for remaining LLM capacity.

| Tool | Display | Source |
| --- | --- | --- |
| agy | 5-hour + weekly remaining | Flexible local cache (`~/.cache/agy/usage.json`) |
| Codex | 5-hour + weekly remaining | Latest `rate_limits` event in `~/.codex/sessions` |
| Claude | 5-hour + weekly remaining | Claude status-line cache |
| OpenRouter | Credits remaining | Official `/api/v1/credits` endpoint |
| Kilo Code | Credits remaining | `kilo profile --json`, with config fallback |

The dashboard never sends local Claude, Codex, or agy session data anywhere.

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
