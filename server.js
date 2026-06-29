'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST = process.env.HOST || '0.0.0.0';

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const PORT = envNumber('PORT', 8787);
const ALERT_PERCENT = envNumber('ALERT_PERCENT', 85);
const CODEX_LOOKBACK_DAYS = envNumber('CODEX_LOOKBACK_DAYS', 14);

const CLAUDE_CACHE = process.env.CLAUDE_USAGE_CACHE
  || path.join(os.homedir(), '.claude', 'usage-cache.json');
const CODEX_SESSIONS = process.env.CODEX_SESSIONS_DIR
  || path.join(os.homedir(), '.codex', 'sessions');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function normalizeClaudeWindow(windowData) {
  if (!windowData || typeof windowData.used_percentage !== 'number') return null;
  return {
    used: windowData.used_percentage,
    resetAt: windowData.resets_at ? windowData.resets_at * 1000 : null,
  };
}

function normalizeCodexWindow(windowData) {
  if (!windowData || typeof windowData.used_percent !== 'number') return null;
  return {
    used: windowData.used_percent,
    resetAt: windowData.resets_at ? windowData.resets_at * 1000 : null,
  };
}

function readClaudeUsage() {
  const data = readJson(CLAUDE_CACHE);
  if (!data || !data.rate_limits) {
    return { fetchedAt: null, five: null, seven: null };
  }

  return {
    fetchedAt: data.fetchedAt || null,
    five: normalizeClaudeWindow(data.rate_limits.five_hour),
    seven: normalizeClaudeWindow(data.rate_limits.seven_day),
  };
}

function getCodexDayDirectory(date) {
  return path.join(
    CODEX_SESSIONS,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

function readCodexUsage() {
  if (!fs.existsSync(CODEX_SESSIONS)) {
    return { fetchedAt: null, five: null, seven: null };
  }

  const now = new Date();
  let newest = null;

  for (let dayOffset = 0; dayOffset < CODEX_LOOKBACK_DAYS; dayOffset += 1) {
    const day = new Date(now.getTime() - dayOffset * 86400000);
    const dir = getCodexDayDirectory(day);
    if (!fs.existsSync(dir)) continue;

    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter((fileName) => fileName.startsWith('rollout-') && fileName.endsWith('.jsonl'));
    } catch (error) {
      continue;
    }

    for (const fileName of files) {
      const filePath = path.join(dir, fileName);
      let lines = [];
      try {
        lines = fs.readFileSync(filePath, 'utf8').split('\n');
      } catch (error) {
        continue;
      }

      for (const line of lines) {
        if (!line || !line.includes('token_count')) continue;

        let event = null;
        try {
          event = JSON.parse(line);
        } catch (error) {
          continue;
        }

        const payload = event && event.payload;
        if (!payload || payload.type !== 'token_count' || !payload.rate_limits) continue;

        const timestamp = Date.parse(event.timestamp || 0);
        if (!timestamp) continue;

        if (!newest || timestamp > newest.timestamp) {
          newest = { timestamp, rateLimits: payload.rate_limits };
        }
      }
    }
  }

  if (!newest) {
    return { fetchedAt: null, five: null, seven: null };
  }

  return {
    fetchedAt: newest.timestamp,
    five: normalizeCodexWindow(newest.rateLimits.primary),
    seven: normalizeCodexWindow(newest.rateLimits.secondary),
  };
}

let codexCache = { fetchedAt: 0, data: null };

function getCodexUsage() {
  const now = Date.now();
  if (codexCache.data && now - codexCache.fetchedAt < 8000) {
    return codexCache.data;
  }

  let data = null;
  try {
    data = readCodexUsage();
  } catch (error) {
    data = { fetchedAt: null, five: null, seven: null };
  }

  codexCache = { fetchedAt: now, data };
  return data;
}

function getLanAddress() {
  const networks = os.networkInterfaces();
  for (const name of Object.keys(networks)) {
    for (const network of networks[name] || []) {
      if (network.family === 'IPv4' && !network.internal) {
        return network.address;
      }
    }
  }
  return 'localhost';
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#EBE6D9">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@600;800&display=swap" rel="stylesheet">
<title>Claude / Codex Usage Dashboard</title>
<style>
:root {
  --bg: #EBE6D9;
  --card: #FFFFFF;
  --text: #2B2A26;
  --muted: #6B6A62;
  --faint: #A6A399;
  --track: #EAE6DC;
  --claude: #BE7457;
  --codex: #767FC6;
  --alert: #B23A2E;
}
* {
  box-sizing: border-box;
  margin: 0;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}
html,
body {
  width: 100%;
  min-height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: "Segoe UI", system-ui, -apple-system, "Noto Sans TC", "PingFang TC", sans-serif;
}
body {
  display: flex;
  gap: clamp(16px, 4vw, 48px);
  padding: 7vh calc(env(safe-area-inset-right) + 4.5vw) calc(env(safe-area-inset-bottom) + 2.4vh) calc(env(safe-area-inset-left) + 4.5vw);
  overflow: hidden;
}
.card {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border-radius: 8px;
  box-shadow: 0 4px 22px rgba(60, 52, 38, 0.10);
  padding: clamp(22px, 4vmin, 48px) clamp(24px, 5.5vmin, 60px);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 9vmin;
}
.brand {
  font-family: Inter, "Segoe UI", system-ui, sans-serif;
  font-size: clamp(30px, 5.6vmin, 68px);
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0;
  white-space: nowrap;
}
.brand.claude { color: var(--claude); }
.brand.codex { color: var(--codex); }
.age {
  color: var(--faint);
  font-size: clamp(16px, 3.2vmin, 36px);
  font-weight: 500;
  white-space: nowrap;
}
.metrics {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: clamp(24px, 4.8vh, 52px);
}
.label {
  color: var(--muted);
  font-size: clamp(22px, 5vmin, 54px);
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: 0;
}
.numrow {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-top: 0.8vh;
}
.big {
  font-family: Inter, "Segoe UI", system-ui, sans-serif;
  font-size: clamp(62px, 14vmin, 150px);
  font-weight: 800;
  line-height: 0.9;
  letter-spacing: 0;
  white-space: nowrap;
}
.big .percent {
  font-size: 0.42em;
  font-weight: 600;
  margin-left: 0.16em;
}
.reset {
  color: var(--faint);
  font-size: clamp(16px, 3.4vmin, 36px);
  font-weight: 500;
  line-height: 1.2;
  padding-bottom: 1.5vh;
  text-align: right;
  white-space: nowrap;
}
.bar {
  height: clamp(10px, 2vmin, 22px);
  background: var(--track);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 1.6vh;
}
.bar > i {
  display: block;
  width: 0;
  height: 100%;
  border-radius: 999px;
  transition: width 0.7s ease, background 0.7s ease;
}
@media (max-width: 720px) {
  body {
    flex-direction: column;
    min-height: 100%;
    overflow: auto;
    padding-top: calc(env(safe-area-inset-top) + 24px);
  }
  .card {
    min-height: 360px;
  }
}
</style>
</head>
<body>
  <section class="card" aria-label="Claude usage">
    <div class="head">
      <div class="brand claude">Claude</div>
      <div class="age" id="age_claude">No data</div>
    </div>
    <div class="metrics">
      <div class="metric">
        <div class="label">5 hours</div>
        <div class="numrow">
          <div class="big"><span id="num_claude_five">--</span><span class="percent" id="pct_claude_five"></span></div>
          <div class="reset" id="reset_claude_five"></div>
        </div>
        <div class="bar"><i id="bar_claude_five"></i></div>
      </div>
      <div class="metric">
        <div class="label">Weekly</div>
        <div class="numrow">
          <div class="big"><span id="num_claude_seven">--</span><span class="percent" id="pct_claude_seven"></span></div>
          <div class="reset" id="reset_claude_seven"></div>
        </div>
        <div class="bar"><i id="bar_claude_seven"></i></div>
      </div>
    </div>
  </section>
  <section class="card" aria-label="Codex usage">
    <div class="head">
      <div class="brand codex">Codex</div>
      <div class="age" id="age_codex">No data</div>
    </div>
    <div class="metrics">
      <div class="metric">
        <div class="label">5 hours</div>
        <div class="numrow">
          <div class="big"><span id="num_codex_five">--</span><span class="percent" id="pct_codex_five"></span></div>
          <div class="reset" id="reset_codex_five"></div>
        </div>
        <div class="bar"><i id="bar_codex_five"></i></div>
      </div>
      <div class="metric">
        <div class="label">Weekly</div>
        <div class="numrow">
          <div class="big"><span id="num_codex_seven">--</span><span class="percent" id="pct_codex_seven"></span></div>
          <div class="reset" id="reset_codex_seven"></div>
        </div>
        <div class="bar"><i id="bar_codex_seven"></i></div>
      </div>
    </div>
  </section>
<script>
const COLORS = {
  claude: '#BE7457',
  codex: '#767FC6',
  alert: '#B23A2E',
  faint: '#A6A399',
};
const ALERT_PERCENT = ${JSON.stringify(ALERT_PERCENT)};
const $ = (id) => document.getElementById(id);

function resetText(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((timestamp - Date.now()) / 1000);
  if (seconds <= 0) return 'Reset';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return 'Reset in ' + days + 'd ' + hours + 'h';
  if (hours > 0) return 'Reset in ' + hours + 'h ' + minutes + 'm';
  return 'Reset in ' + Math.max(0, minutes) + 'm';
}

function ageText(timestamp) {
  if (!timestamp) return 'No data';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Updated now';
  if (seconds < 3600) return 'Updated ' + Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return 'Updated ' + Math.floor(seconds / 3600) + 'h ago';
  return 'Updated ' + Math.floor(seconds / 86400) + 'd ago';
}

function setMetric(prefix, data, baseColor) {
  const number = $('num_' + prefix);
  const percent = $('pct_' + prefix);
  const bar = $('bar_' + prefix);
  const reset = $('reset_' + prefix);

  if (!data || typeof data.used !== 'number') {
    number.textContent = '--';
    number.style.color = COLORS.faint;
    percent.textContent = '';
    bar.style.width = '0';
    reset.textContent = '';
    return;
  }

  const color = data.used >= ALERT_PERCENT ? COLORS.alert : baseColor;
  number.textContent = String(Math.round(data.used));
  number.style.color = color;
  percent.textContent = '%';
  percent.style.color = color;
  bar.style.width = Math.max(2, Math.min(100, data.used)) + '%';
  bar.style.background = color;
  reset.textContent = resetText(data.resetAt);
}

async function refreshUsage() {
  try {
    const response = await fetch('/api/usage', { cache: 'no-store' });
    const usage = await response.json();
    const claude = usage.claude || {};
    const codex = usage.codex || {};

    setMetric('claude_five', claude.five, COLORS.claude);
    setMetric('claude_seven', claude.seven, COLORS.claude);
    setMetric('codex_five', codex.five, COLORS.codex);
    setMetric('codex_seven', codex.seven, COLORS.codex);
    $('age_claude').textContent = ageText(claude.fetchedAt);
    $('age_codex').textContent = ageText(codex.fetchedAt);
  } catch (error) {
    $('age_claude').textContent = 'Offline';
    $('age_codex').textContent = 'Offline';
  }
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
  } catch (error) {}
}

refreshUsage();
setInterval(refreshUsage, 2000);
requestWakeLock();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshUsage();
    requestWakeLock();
  }
});

document.body.addEventListener('click', () => {
  refreshUsage();
  requestWakeLock();
  const page = document.documentElement;
  if (page.requestFullscreen && !document.fullscreenElement) {
    try {
      page.requestFullscreen();
    } catch (error) {}
  }
});
</script>
</body>
</html>`;
}

const server = http.createServer((request, response) => {
  if (request.url === '/api/usage') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify({
      claude: readClaudeUsage(),
      codex: getCodexUsage(),
    }));
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(pageHtml());
});

server.listen(PORT, HOST, () => {
  const visibleHost = HOST === '0.0.0.0' ? getLanAddress() : HOST;
  console.log('Claude / Codex usage dashboard');
  console.log('Local:  http://localhost:' + PORT);
  console.log('Device: http://' + visibleHost + ':' + PORT);
});
