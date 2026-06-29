# Claude / Codex Usage Dashboard

An unofficial local dashboard for viewing Claude Code and Codex usage limits on a spare phone, tablet, or small screen.

The server runs on your Windows machine, reads local usage data, and serves a simple dashboard that can be opened from another device on the same Wi-Fi network.

![Status](https://img.shields.io/badge/platform-Windows-767FC6)
![Node](https://img.shields.io/badge/node-%3E%3D18-43853D)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

- Shows Claude Code and Codex usage for the 5-hour and weekly windows.
- Reads Claude Code usage through a local `statusLine` cache.
- Reads Codex usage from the newest local `~/.codex/sessions` `rate_limits` snapshot.
- Works on a phone or tablet connected to the same Wi-Fi network.
- Tap the dashboard to refresh and request fullscreen mode.
- Turns red when usage reaches the alert threshold.
- Uses only Node.js built-in modules. No npm dependencies.

## Important Limitations

Usage numbers only update after you actually use Claude Code or Codex.

Claude Code usage comes from `statusLine`, so opening Claude in the web app or desktop app will not update this dashboard. Codex usage is read from local Codex session files, so it updates only after Codex writes new session data.

This project is not affiliated with Anthropic or OpenAI. It does not include official logos. Make sure your own use of third-party names, trademarks, and local tool output formats follows the relevant terms.

## Requirements

- Windows
- Node.js 18 or newer
- Claude Code, with `statusLine` configured for real Claude usage
- Codex, with local `~/.codex/sessions` data

Check Node.js:

```powershell
node -v
```

## Quick Start

```powershell
git clone https://github.com/YOUR_NAME/claude-codex-usage-dashboard.git
cd claude-codex-usage-dashboard
node server.js
```

You should see output similar to:

```text
Local:  http://localhost:8787
Device: http://192.168.1.23:8787
```

Open `http://localhost:8787` on the Windows machine. To use a phone or tablet, connect it to the same Wi-Fi network and open the `Device` URL.

## Configure Claude Code Usage

Run:

```powershell
.\setup-claude-statusline.bat
```

Then:

1. Fully quit Claude Code.
2. Open Claude Code again.
3. Send one message.
4. Refresh the dashboard.

The Claude card will start reading `~/.claude/usage-cache.json`.

## If You Already Have a statusLine

Claude Code supports one `statusLine.command` at a time. If you already use another statusLine script, such as a Stream Deck integration or a custom prompt status line, use fanout mode.

Copy the example config:

```powershell
Copy-Item .\config.example.json .\config.json
```

Edit `config.json`:

```json
{
  "extraStatuslineCommand": "powershell -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\\.claude\\your-existing-statusline.ps1\""
}
```

Then run:

```powershell
.\setup-claude-statusline.bat --fanout
```

This sends the same Claude Code statusLine JSON to both this dashboard and your existing command.

## Start Automatically on Login

Install autostart:

```powershell
.\install-autostart.bat
```

Remove autostart:

```powershell
.\uninstall-autostart.bat
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Dashboard port |
| `HOST` | `0.0.0.0` | Allows devices on the same Wi-Fi to connect. Use `127.0.0.1` for local-only preview |
| `ALERT_PERCENT` | `85` | Usage percentage that turns the dashboard red |
| `CODEX_LOOKBACK_DAYS` | `14` | How many days of Codex sessions to scan |
| `CLAUDE_USAGE_CACHE` | `~/.claude/usage-cache.json` | Claude usage cache path |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex sessions path |
| `EXTRA_STATUSLINE_COMMAND` | empty | Extra command for fanout mode |

Example:

```powershell
$env:PORT="8790"
$env:HOST="127.0.0.1"
node server.js
```

## Windows Firewall

If your phone or tablet cannot connect, allow the dashboard port through Windows Firewall:

```powershell
netsh advfirewall firewall add rule name="AIUsageDashboard" dir=in action=allow protocol=TCP localport=8787
```

## Privacy

Data stays on your machine. The server reads local Claude and Codex usage records, but does not upload them anywhere.

Do not commit:

- `~/.claude/usage-cache.json`
- `~/.codex/sessions`
- `~/.claude/settings.json`
- `config.json`

## Uploading to GitHub

See [GITHUB_UPLOAD_GUIDE.md](GITHUB_UPLOAD_GUIDE.md) for a first-time step-by-step guide.

## License

MIT
