'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = __dirname;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8787;
const REFRESH_MS = Math.max(15_000, Number(process.env.REFRESH_MS) || 60_000);
const HOME = os.homedir();
const paths = {
  claude: process.env.CLAUDE_USAGE_CACHE || path.join(HOME, '.claude', 'usage-cache.json'),
  codex: process.env.CODEX_SESSIONS_DIR || path.join(HOME, '.codex', 'sessions'),
  agy: process.env.AGY_USAGE_CACHE || path.join(HOME, '.cache', 'agy', 'usage.json'),
  config: process.env.LLM_DASHBOARD_CONFIG || path.join(ROOT, 'config.json'),
};

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function clamp(n) { return Math.max(0, Math.min(100, Number(n))); }
function epoch(value) {
  if (!value) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function quotaWindow(value) {
  if (!value) return null;
  const used = value.used_percentage ?? value.used_percent ?? value.utilization ?? value.used;
  const remaining = value.remaining_percentage ?? value.remaining_percent ?? value.remaining;
  const usedPercent = Number.isFinite(Number(used)) ? clamp(used) :
    Number.isFinite(Number(remaining)) ? clamp(100 - remaining) : null;
  if (usedPercent === null) return null;
  return { usedPercent, remainingPercent: 100 - usedPercent, resetAt: epoch(value.resets_at ?? value.reset_at ?? value.resetAt) };
}
function quotaProvider(id, name, raw, fetchedAt, account = null) {
  const limits = raw?.rate_limits || raw?.rateLimits || raw?.quota || raw || {};
  return {
    id, name, account, kind: 'quota', fetchedAt: epoch(fetchedAt ?? raw?.fetchedAt ?? raw?.updated_at),
    five: quotaWindow(limits.five_hour ?? limits.fiveHour ?? limits.primary ?? limits.primary_window ?? limits.session),
    weekly: quotaWindow(limits.seven_day ?? limits.sevenDay ?? limits.weekly ?? limits.secondary ?? limits.secondary_window),
  };
}
function unavailable(id, name, kind, detail, account = null) { return { id, name, account, kind, status: 'unavailable', detail }; }

function accountId(tool, account, index) { return `${tool}-${String(account || index + 1).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`; }
function readClaude(cachePath = paths.claude, account = null, index = 0, overageRemaining = null) {
  const raw = readJson(cachePath);
  const id = accountId('claude', account, index);
  const provider = raw ? quotaProvider(id, 'Claude', raw, raw.fetchedAt, account) : unavailable(id, 'Claude', 'quota', `Waiting for ${cachePath}`, account);
  const balance = Number(overageRemaining);
  if (overageRemaining !== null && overageRemaining !== '' && Number.isFinite(balance)) provider.overageRemaining = balance;
  return provider;
}

function codexDay(date, sessionsDir = paths.codex) {
  return path.join(sessionsDir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
}
function readCodex(sessionsDir = paths.codex, account = null, index = 0) {
  let newest = null;
  for (let offset = 0; offset < 14; offset += 1) {
    const dir = codexDay(new Date(Date.now() - offset * 86400000), sessionsDir);
    let files = []; try { files = fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')); } catch { continue; }
    for (const file of files) {
      let text = ''; try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.includes('rate_limits')) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        const limits = event?.payload?.rate_limits;
        const at = epoch(event?.timestamp);
        if (limits && at && (!newest || at > newest.at)) newest = { at, limits };
      }
    }
  }
  const id = accountId('codex', account, index);
  return newest ? quotaProvider(id, 'Codex', newest.limits, newest.at, account) : unavailable(id, 'Codex', 'quota', `No rate-limit snapshot in ${sessionsDir}`, account);
}
function readAgy() {
  const raw = readJson(paths.agy);
  return raw ? quotaProvider('agy', 'agy', raw, raw.fetchedAt) : unavailable('agy', 'agy', 'quota', `Waiting for ${paths.agy}`);
}

function configuredBalance(id, name, config) {
  const value = config?.providers?.[id];
  if (value == null) return null;
  const remaining = Number(typeof value === 'object' ? value.remaining : value);
  if (!Number.isFinite(remaining)) return null;
  return { id, name, kind: 'balance', remaining, unit: value.unit || (id === 'openrouter' || id === 'kilo' ? 'USD' : 'tokens'), fetchedAt: Date.now(), detail: 'configured balance' };
}
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, { headers, timeout: 8000 }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
async function readClaudeLive(entry, index) {
  const fallback = readClaude(entry.cache, entry.email, index, entry.overageRemaining);
  const credentials = entry.credentials || path.join(path.dirname(entry.cache), '.credentials.json');
  const token = readJson(credentials)?.claudeAiOauth?.accessToken;
  if (!token) return fallback;
  try {
    const raw = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
      Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.206',
    });
    const provider = quotaProvider(accountId('claude', entry.email, index), 'Claude', raw, Date.now(), entry.email);
    const extra = raw.extra_usage;
    provider.extraUsage = {
      enabled: Boolean(extra?.is_enabled),
      currency: extra?.currency || 'USD',
      disabledReason: extra?.disabled_reason || null,
      monthlyLimit: null,
      used: null,
      remaining: null,
    };
    if (extra?.is_enabled && Number.isFinite(Number(extra.monthly_limit)) && Number.isFinite(Number(extra.used_credits))) {
      const scale = 10 ** Number(extra.decimal_places || 0);
      provider.extraUsage.monthlyLimit = Number(extra.monthly_limit) / scale;
      provider.extraUsage.used = Number(extra.used_credits) / scale;
      provider.extraUsage.remaining = Math.max(0, provider.extraUsage.monthlyLimit - provider.extraUsage.used);
      provider.overageRemaining = provider.extraUsage.remaining;
    }
    provider.source = 'live account API';
    return provider;
  } catch { return fallback; }
}
async function readCodexLive(entry, index) {
  const sessionsDir = entry.sessionsDir || paths.codex;
  const fallback = readCodex(sessionsDir, entry.email, index);
  const auth = readJson(entry.authFile || path.join(path.dirname(sessionsDir), 'auth.json'));
  const token = auth?.tokens?.access_token;
  const accountIdHeader = auth?.tokens?.account_id;
  if (!token) return fallback;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    if (accountIdHeader) headers['ChatGPT-Account-Id'] = accountIdHeader;
    const raw = await fetchJson('https://chatgpt.com/backend-api/wham/usage', headers);
    const label = entry.email || raw.email || null;
    const provider = quotaProvider(accountId('codex', label, index), 'Codex', raw.rate_limit, Date.now(), label);
    if (raw.credits?.has_credits && Number.isFinite(Number(raw.credits.balance))) provider.overageRemaining = Number(raw.credits.balance);
    provider.source = 'live account API';
    return provider;
  } catch { return fallback; }
}
async function readOpenRouter(config) {
  const manual = configuredBalance('openrouter', 'OpenRouter', config);
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return manual || unavailable('openrouter', 'OpenRouter', 'balance', 'Set OPENROUTER_API_KEY or config.json');
  try {
    const data = await fetchJson('https://openrouter.ai/api/v1/credits', { Authorization: `Bearer ${key}` });
    const total = Number(data?.data?.total_credits); const used = Number(data?.data?.total_usage);
    if (!Number.isFinite(total) || !Number.isFinite(used)) throw new Error('unexpected response');
    return { id: 'openrouter', name: 'OpenRouter', kind: 'balance', remaining: Math.max(0, total - used), unit: 'USD', fetchedAt: Date.now() };
  } catch (error) { return manual || unavailable('openrouter', 'OpenRouter', 'balance', `API: ${error.message}`); }
}
function execJson(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 10000, env: process.env }, (error, stdout) => {
    if (error) return reject(error); try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
  }));
}
async function readKilo(config) {
  const manual = configuredBalance('kilo', 'Kilo Code', config);
  try {
    const raw = await execJson(process.env.KILO_BIN || 'kilo', ['profile', '--json']);
    const remaining = Number(raw.balance ?? raw.credits ?? raw.remaining ?? raw.data?.balance);
    if (!Number.isFinite(remaining)) throw new Error('balance missing from profile');
    return { id: 'kilo', name: 'Kilo Code', kind: 'balance', remaining, unit: raw.currency || 'USD', fetchedAt: Date.now() };
  } catch (error) { return manual || unavailable('kilo', 'Kilo Code', 'balance', 'Kilo profile unavailable; add config.json fallback'); }
}
let cache = { at: 0, data: null };
async function usage() {
  if (cache.data && Date.now() - cache.at < 8000) return cache.data;
  const config = readJson(paths.config) || {};
  const claudeEntries = Array.isArray(config?.accounts?.claude) && config.accounts.claude.length
    ? config.accounts.claude : [{ cache: paths.claude }];
  const codexEntries = Array.isArray(config?.accounts?.codex) && config.accounts.codex.length
    ? config.accounts.codex : [{ sessionsDir: paths.codex }];
  const claudeAccounts = await Promise.all(claudeEntries.map(readClaudeLive));
  const codexAccounts = await Promise.all(codexEntries.map(readCodexLive));
  const anthropicApi = configuredBalance('anthropicApi', 'Anthropic API', config)
    || unavailable('anthropicApi', 'Anthropic API', 'balance', 'Add the current API balance to config.json');
  const providers = [readAgy(), ...codexAccounts, ...claudeAccounts, anthropicApi, await readOpenRouter(config), await readKilo(config)];
  cache = { at: Date.now(), data: { generatedAt: Date.now(), refreshMs: REFRESH_MS, providers } };
  return cache.data;
}

function html() { return fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8'); }
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(await usage()));
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html());
  }
  res.writeHead(404); res.end('Not found');
});
if (require.main === module) server.listen(PORT, HOST, () => console.log(`LLM Fuel: http://${HOST}:${PORT}`));
module.exports = { quotaWindow, quotaProvider, readCodex, usage, server };
