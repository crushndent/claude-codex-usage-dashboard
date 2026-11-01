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

### Start automatically on Linux

Install and immediately start a systemd user service:

```bash
./install-autostart-linux.sh
```

The installer enables user lingering so the service starts during system boot,
without waiting for an interactive login. Remove the service with
`./uninstall-autostart-linux.sh`; uninstalling deliberately leaves lingering
unchanged because other user services may depend on it. To use a different
port, set it while installing, for example `PORT=8788 ./install-autostart-linux.sh`.

### Multiple agy accounts

agy has no config-dir override (it always uses `~/.gemini`), so a second
account runs with its own `HOME` via the `~/.local/bin/agy2` wrapper
(`HOME=~/.agy2`). Log in once with `agy2`, then list both accounts under
`accounts.agy` in `config.json`:

```json
"agy": [
  {"email": "personal@example.com", "cache": "/home/you/.cache/agy/usage.json"},
  {"email": "work@example.com", "cache": "/home/you/.cache/agy/usage-work.json"}
]
```

The server queries every running `agy` process and matches each card by the
email agy reports. A card whose account is not running shows its last cached
snapshot.

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

## Monitoring tabs

The page has tabs (deep-linkable as `#fuel`, `#activity`, `#local`, `#hindsight`, `#headroom`):

1. **Activity** — each Headroom proxy (`HEADROOM_INSTANCES`, default `claude=8787,hermes=8788`): prompt-cache hit rate, requests, tokens, savings, latency, MCP results, recent requests. Also tool and MCP call counts for the last 24h, parsed from Claude Code transcripts (`TRANSCRIPT_ROOTS`) and Codex sessions (`CODEX_ROOTS`).
2. **Local LLM** — LM Studio (`LMSTUDIO_URL`) loaded models, plus 1h/24h throughput and prompt-cache reuse parsed from llama.cpp timing lines in `~/.lmstudio/server-logs`. Also GPU utilization, VRAM by process, and power (`nvidia-smi`), with 24h sparklines that are sampled every minute and kept in memory.
3. **Hindsight** — LLM calls and tokens by operation, operations, endpoints and DB pool, from Hindsight's Prometheus `/metrics` (no API key needed), plus `docker stats` for the container.
4. **Headroom** — the Headroom dashboard embedded through a read-only GET proxy at `/hr/<instance>/…` (settings and other writes are blocked), so it also works over the tailnet.
