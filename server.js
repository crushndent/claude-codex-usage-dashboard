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
  prewarmState: process.env.LLM_DASHBOARD_PREWARM_STATE || path.join(ROOT, '.prewarm-state.json'),
  prewarmScript: process.env.LLM_DASHBOARD_PREWARM_SCRIPT || path.resolve(ROOT, '../../20areas/crons/pre-warm-llms-morning.sh'),
};
const configuredPrewarmDelay = Number(process.env.PREWARM_DELAY_MS);
const PREWARM_DELAY_MS = process.env.PREWARM_DELAY_MS !== undefined && Number.isFinite(configuredPrewarmDelay)
  ? Math.max(0, configuredPrewarmDelay) : 120_000;

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
function readAgyCache() {
  const raw = readJson(paths.agy);
  if (raw?.kind === 'pools' && Array.isArray(raw.pools)) return raw;
  return raw ? quotaProvider('agy', 'agy', raw, raw.fetchedAt) : unavailable('agy', 'agy', 'quota', `Waiting for ${paths.agy}`);
}
function saveAgyCache(provider) {
  try {
    fs.mkdirSync(path.dirname(paths.agy), { recursive: true });
    fs.writeFileSync(paths.agy, JSON.stringify(provider));
  } catch {}
}

function execText(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 4000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function postLocalJson(port, secure, route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const lib = secure ? require('https') : require('http');
    const req = lib.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', rejectUnauthorized: false, timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Connect-Protocol-Version': '1' } }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(payload);
  });
}
function agyPoolName(models) {
  const text = models.map((m) => `${m.label || ''} ${m.modelOrAlias?.model || ''}`.toLowerCase()).join(' ');
  const parts = [];
  if (/gemini.*pro|pro.*gemini/.test(text)) parts.push('Gemini Pro');
  if (/gemini.*flash|flash.*gemini/.test(text)) parts.push('Gemini Flash');
  if (/claude/.test(text)) parts.push('Claude');
  if (/gpt|openai/.test(text)) parts.push('GPT');
  return parts.length ? [...new Set(parts)].join(' · ') : (models[0]?.label || 'Model pool');
}
function parseAgyStatus(data) {
  const status = data?.userStatus || {};
  const models = status.cascadeModelConfigData?.clientModelConfigs || [];
  const grouped = new Map();
  for (const model of models) {
    const quota = model.quotaInfo || model.quota_info;
    if (!quota || !Number.isFinite(Number(quota.remainingFraction ?? quota.remaining_fraction))) continue;
    const remaining = clamp(Number(quota.remainingFraction ?? quota.remaining_fraction) * 100);
    const resetAt = epoch(quota.resetTime ?? quota.reset_time);
    const key = `${remaining}|${resetAt}`;
    if (!grouped.has(key)) grouped.set(key, { remainingPercent: remaining, resetAt, models: [] });
    grouped.get(key).models.push(model);
  }
  const pools = [...grouped.values()].map((pool) => ({ ...pool, name: agyPoolName(pool.models), models: pool.models.map((m) => m.label || m.modelOrAlias?.model).filter(Boolean) }));
  const plan = status.planStatus || {};
  const monthly = Number(plan.planInfo?.monthlyPromptCredits);
  const available = Number(plan.availablePromptCredits);
  return { id: 'agy', name: 'agy', account: status.email || null, kind: 'pools', fetchedAt: Date.now(), source: 'live agy local API', pools,
    promptCredits: Number.isFinite(available) ? { remaining: available, monthly: Number.isFinite(monthly) ? monthly : null } : null,
    aiCredits: (status.userTier?.availableCredits || []).map((credit) => ({ type: credit.creditType, amount: Number(credit.creditAmount) }))
      .filter((credit) => Number.isFinite(credit.amount)) };
}
async function readAgy() {
  const fallback = readAgyCache();
  try {
    let processList = '';
    try { processList = String(await execText('pgrep', ['-x', 'agy'])); } catch {}
    const pids = processList.trim().split(/\s+/).filter(Boolean);
    if (!pids.length) throw new Error('agy is not running');
    const sockets = String(await execText('ss', ['-tlnp']));
    const ports = [];
    for (const line of sockets.split('\n')) {
      if (!pids.some((pid) => line.includes(`pid=${pid}`))) continue;
      const match = line.trim().split(/\s+/)[3]?.match(/:(\d+)$/);
      if (match && !ports.includes(Number(match[1]))) ports.push(Number(match[1]));
    }
    const route = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
    const body = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } };
    for (const port of ports) for (const secure of [true, false]) {
      try {
        const provider = parseAgyStatus(await postLocalJson(port, secure, route, body));
        saveAgyCache(provider);
        return provider;
      } catch {}
    }
    throw new Error('no responsive agy quota port');
  } catch (error) {
    fallback.warning = error.message;
    if (fallback.status !== 'unavailable') fallback.source = 'last live agy snapshot';
    return fallback;
  }
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
  fallback.prewarmTarget = entry.prewarmCommand || (index === 0 ? 'claude' : index === 1 ? 'claude2' : null);
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
    } else if (entry.overageRemaining !== null && entry.overageRemaining !== '' && Number.isFinite(Number(entry.overageRemaining))) {
      provider.extraUsage.remaining = Number(entry.overageRemaining);
      provider.overageRemaining = Number(entry.overageRemaining);
    }
    provider.source = 'live account API';
    provider.prewarmTarget = entry.prewarmCommand || (index === 0 ? 'claude' : index === 1 ? 'claude2' : null);
    return provider;
  } catch (error) {
    fallback.source = 'local cache fallback';
    fallback.warning = `Live account API unavailable: ${error.message}`;
    return fallback;
  }
}
async function readCodexLive(entry, index) {
  const sessionsDir = entry.sessionsDir || paths.codex;
  const fallback = readCodex(sessionsDir, entry.email, index);
  fallback.prewarmTarget = entry.prewarmCommand || 'codex';
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
    provider.extraCredits = {
      enabled: Boolean(raw.credits?.has_credits),
      balance: Number.isFinite(Number(raw.credits?.balance)) ? Number(raw.credits.balance) : null,
      limitReached: Boolean(raw.credits?.overage_limit_reached),
    };
    if (provider.extraCredits.balance !== null) provider.overageRemaining = provider.extraCredits.balance;
    provider.source = 'live account API';
    provider.prewarmTarget = entry.prewarmCommand || 'codex';
    return provider;
  } catch (error) {
    fallback.source = 'local session fallback';
    fallback.warning = `Live account API unavailable: ${error.message}`;
    return fallback;
  }
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
let prewarmJobs = readJson(paths.prewarmState)?.jobs || {};
const prewarmTimers = new Map();

function savePrewarmJobs() {
  try { fs.writeFileSync(paths.prewarmState, JSON.stringify({ jobs: prewarmJobs }, null, 2)); } catch (error) { console.error(`Could not save pre-warm state: ${error.message}`); }
}
function firePrewarm(providerId) {
  const job = prewarmJobs[providerId];
  if (!job) return;
  delete prewarmJobs[providerId];
  prewarmTimers.delete(providerId);
  savePrewarmJobs();
  execFile(paths.prewarmScript, [job.target], { timeout: 120_000, env: process.env }, (error) => {
    if (error) console.error(`Pre-warm failed for ${job.target}: ${error.message}`);
    else console.log(`Pre-warmed ${job.target} after its five-hour window reset`);
  });
}
function schedulePrewarm(job) {
  const old = prewarmTimers.get(job.providerId);
  if (old) clearTimeout(old);
  const delay = Math.max(0, job.runAt - Date.now());
  const timer = setTimeout(() => firePrewarm(job.providerId), Math.min(delay, 2_147_483_647));
  prewarmTimers.set(job.providerId, timer);
}
function restorePrewarmJobs() {
  for (const job of Object.values(prewarmJobs)) schedulePrewarm(job);
}
function prewarmView(provider) {
  const job = prewarmJobs[provider.id];
  if (!provider.prewarmTarget || provider.kind !== 'quota' || (!job && !provider.five?.resetAt)) return null;
  return { enabled: Boolean(job), resetAt: job?.resetAt || null, runAt: job?.runAt || null };
}
async function usage() {
  if (cache.data && Date.now() - cache.at < 8000) return { ...cache.data, providers: cache.data.providers.map((p) => ({ ...p, prewarm: prewarmView(p), prewarmTarget: undefined })) };
  const config = readJson(paths.config) || {};
  const claudeEntries = Array.isArray(config?.accounts?.claude) && config.accounts.claude.length
    ? config.accounts.claude : [{ cache: paths.claude }];
  const codexEntries = Array.isArray(config?.accounts?.codex) && config.accounts.codex.length
    ? config.accounts.codex : [{ sessionsDir: paths.codex }];
  const claudeAccounts = await Promise.all(claudeEntries.map(readClaudeLive));
  const codexAccounts = await Promise.all(codexEntries.map(readCodexLive));
  const anthropicApi = configuredBalance('anthropicApi', 'Anthropic API', config)
    || unavailable('anthropicApi', 'Anthropic API', 'balance', 'Add the current API balance to config.json');
  const kilo = await readKilo(config);
  const openRouter = await readOpenRouter(config);
  const providers = [...claudeAccounts, ...codexAccounts, kilo, openRouter, anthropicApi, await readAgy()];
  cache = { at: Date.now(), data: { generatedAt: Date.now(), refreshMs: REFRESH_MS, providers } };
  return { ...cache.data, providers: providers.map((p) => ({ ...p, prewarm: prewarmView(p), prewarmTarget: undefined })) };
}

function html() { return fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8'); }
function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(await usage()));
  }
  if (req.url === '/api/prewarm' && req.method === 'POST') {
    try {
      const body = await readRequestJson(req);
      await usage();
      const provider = cache.data?.providers.find((item) => item.id === body.providerId);
      if (!provider?.prewarmTarget || !['claude', 'claude2', 'codex'].includes(provider.prewarmTarget)) throw new Error('Provider cannot be pre-warmed');
      if (body.enabled) {
        if (!provider.five?.resetAt || provider.five.resetAt <= Date.now()) throw new Error('No future five-hour reset is available');
        const job = { providerId: provider.id, target: provider.prewarmTarget, resetAt: provider.five.resetAt, runAt: provider.five.resetAt + PREWARM_DELAY_MS };
        prewarmJobs[provider.id] = job; savePrewarmJobs(); schedulePrewarm(job);
      } else {
        delete prewarmJobs[provider.id]; savePrewarmJobs();
        const timer = prewarmTimers.get(provider.id); if (timer) clearTimeout(timer); prewarmTimers.delete(provider.id);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, prewarm: prewarmView(provider) }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: error.message }));
    }
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html());
  }
  res.writeHead(404); res.end('Not found');
});
restorePrewarmJobs();
if (require.main === module) server.listen(PORT, HOST, () => console.log(`LLM Fuel: http://${HOST}:${PORT}`));
module.exports = { quotaWindow, quotaProvider, readCodex, usage, server, prewarmView };
