'use strict';
// Collectors for the Activity / Local LLM / Hindsight tabs. Each returns plain JSON for the dashboard.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');

const HOME = os.homedir();
const HOUR = 3600000, DAY = 24 * HOUR;
const HEADROOM = (process.env.HEADROOM_INSTANCES || 'claude=8787,hermes=8788').split(',').map((pair) => {
  const [name, port] = pair.split('='); return { name, port: Number(port) };
}).filter((x) => x.name && x.port);
const HINDSIGHT_URL = process.env.HINDSIGHT_URL || 'http://127.0.0.1:8888';
const LMSTUDIO_URL = process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234';
const LMSTUDIO_LOGS = process.env.LMSTUDIO_LOGS || path.join(HOME, '.lmstudio', 'server-logs');
const TRANSCRIPT_ROOTS = (process.env.TRANSCRIPT_ROOTS || ['.claude', '.claude2', '.claude-shared'].map((d) => path.join(HOME, d, 'projects')).join(':')).split(':');
const CODEX_ROOTS = (process.env.CODEX_ROOTS || [path.join(HOME, '.codex', 'sessions')].join(':')).split(':');

function get(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
async function getJson(url, timeout) { return JSON.parse(await get(url, timeout)); }
function run(cmd, args, timeout = 5000) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout }, (e, out) => e ? reject(e) : resolve(String(out))));
}
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;

// ---------- Headroom ----------
async function headroomInstance({ name, port }) {
  try {
    const [s, h] = await Promise.all([getJson(`http://127.0.0.1:${port}/stats`), getJson(`http://127.0.0.1:${port}/health`).catch(() => null)]);
    const pc = Object.entries(s.prefix_cache?.by_provider || {}).map(([provider, v]) => ({
      provider, hitRate: num(v.request_hit_rate ?? v.hit_rate), tokenHitRate: num(v.hit_rate), readTokens: num(v.cache_read_tokens),
      writeTokens: num(v.cache_write_tokens), busts: num(v.bust_count), netSavingsUsd: num(v.net_savings_usd), requests: num(v.requests) }));
    const life = s.persistent_savings?.lifetime || {};
    return {
      name, port, status: 'ok', version: h?.version || null, uptimeS: num(h?.uptime_seconds), healthy: h?.status === 'healthy',
      primaryModel: s.summary?.primary_model || null,
      requests: { total: num(s.requests?.total), failed: num(s.requests?.failed), rateLimited: num(s.requests?.rate_limited),
        byModel: s.requests?.by_model || {}, byProvider: s.requests?.by_provider || {} },
      tokens: { input: num(s.tokens?.input), output: num(s.tokens?.output), saved: num(s.tokens?.saved), savingsPct: num(s.tokens?.savings_percent) },
      prefixCache: pc,
      compressionCache: { hitRate: num(s.compression_cache?.hit_rate), hits: num(s.compression_cache?.total_hits), misses: num(s.compression_cache?.total_misses) },
      cost: { withUsd: num(s.summary?.cost?.with_headroom_usd), withoutUsd: num(s.summary?.cost?.without_headroom_usd),
        savedUsd: num(s.summary?.cost?.total_saved_usd), cacheDiscountUsd: num(s.summary?.cost?.provider_cache_discount_usd) },
      lifetime: { requests: num(life.requests), tokensSaved: num(life.tokens_saved), compressionUsd: num(life.compression_savings_usd),
        cacheUsd: num(life.cache_savings_usd), inputCostUsd: num(life.total_input_cost_usd) },
      mcp: { compressions: num(s.summary?.mcp?.compressions), tokensRemoved: num(s.summary?.mcp?.tokens_removed), retrievals: num(s.summary?.mcp?.retrievals),
        smallResults: num(s.router?.route_counts?.mcp_small_result) },
      ccr: { retrievals: num(s.compression?.ccr_retrievals), entries: num(s.compression?.ccr_entries) },
      strategies: s.compressions_by_strategy || {},
      latency: { avgMs: num(s.latency?.average_ms), ttfbMs: num(s.ttfb?.average_ms), overheadMs: num(s.overhead?.average_ms),
        genTpsP50: num(s.throughput?.rolling?.generation_p50) },
      subscription: s.subscription_window?.latest ? { five: num(s.subscription_window.latest.five_hour?.utilization_pct),
        seven: num(s.subscription_window.latest.seven_day?.utilization_pct) } : null,
      recent: (s.recent_requests || []).slice(0, 12).map((r) => ({ t: Date.parse(r.timestamp), model: r.model, provider: r.provider,
        in: num(r.input_tokens_optimized), out: num(r.output_tokens), saved: num(r.tokens_saved), ms: num(r.total_latency_ms),
        cacheHit: r.cache_hit ?? null })),
      history: (s.savings_history || []).slice(-200).map(([t, v]) => [Date.parse(t + 'Z'), v]),
    };
  } catch (error) { return { name, port, status: 'down', error: error.message }; }
}
const headroom = () => Promise.all(HEADROOM.map(headroomInstance));

// ---------- Tool / MCP calls from agent transcripts (incremental tail of each file) ----------
const tailState = new Map(); // file -> { offset, lastTs, events: [[t, tool, source, isError?]] }
function scanFile(file, source, parseLine) {
  let st; try { st = fs.statSync(file); } catch { tailState.delete(file); return; }
  let state = tailState.get(file);
  if (!state || st.size < state.offset) { state = { offset: 0, lastTs: st.mtimeMs, events: [], rest: '' }; tailState.set(file, state); }
  if (st.size === state.offset) return;
  const fd = fs.openSync(file, 'r');
  try {
    const len = st.size - state.offset; const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.offset); state.offset = st.size;
    const lines = (state.rest + buf.toString('utf8')).split('\n'); state.rest = lines.pop();
    for (const line of lines) parseLine(line, state, source);
  } finally { fs.closeSync(fd); }
}
function claudeLine(line, state, source) {
  if (!line.includes('"tool_use"') && !line.includes('"timestamp"')) return;
  let d; try { d = JSON.parse(line); } catch { return; }
  const t = Date.parse(d.timestamp); if (Number.isFinite(t)) state.lastTs = t;
  const content = d.message?.content; if (!Array.isArray(content)) return;
  for (const c of content) if (c?.type === 'tool_use' && c.name) state.events.push([state.lastTs, c.name, source]);
}
function codexLine(line, state, source) {
  if (!line.includes('function_call') && !line.includes('custom_tool_call')) return;
  let d; try { d = JSON.parse(line); } catch { return; }
  const t = Date.parse(d.timestamp); if (Number.isFinite(t)) state.lastTs = t;
  const p = d.payload; if (!p) return;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') state.events.push([state.lastTs, p.name || 'unknown', source]);
}
function recentFiles(root, maxAgeMs, out = []) {
  let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) recentFiles(full, maxAgeMs, out);
    else if (e.name.endsWith('.jsonl')) { try { if (Date.now() - fs.statSync(full).mtimeMs < maxAgeMs) out.push(full); } catch {} }
  }
  return out;
}
function tools() {
  const since = Date.now() - DAY;
  const seen = new Set();
  // ~/.claude2 and ~/.claude-shared may symlink to the same transcripts; count each real file once.
  const add = (f, source, parser) => { let real = f; try { real = fs.realpathSync(f); } catch {} if (seen.has(real)) return; seen.add(real); scanFile(real, source, parser); };
  for (const root of TRANSCRIPT_ROOTS) for (const f of recentFiles(root, DAY)) add(f, path.basename(path.dirname(root)).replace(/^\./, ''), claudeLine);
  for (const root of CODEX_ROOTS) for (const f of recentFiles(root, DAY)) add(f, 'codex', codexLine);
  for (const f of tailState.keys()) if (!seen.has(f)) tailState.delete(f);
  const byTool = new Map(), byMcp = new Map(), bySource = new Map(), hourly = new Array(24).fill(0);
  let total = 0, mcpTotal = 0;
  for (const state of tailState.values()) {
    state.events = state.events.filter((e) => e[0] >= since);
    for (const [t, name, source] of state.events) {
      total += 1; byTool.set(name, (byTool.get(name) || 0) + 1); bySource.set(source, (bySource.get(source) || 0) + 1);
      hourly[Math.min(23, Math.floor((Date.now() - t) / HOUR))] += 1;
      const m = name.match(/^mcp__(.+?)__(.+)$/);
      if (m) { mcpTotal += 1; const s = byMcp.get(m[1]) || { server: m[1], calls: 0, tools: {} }; s.calls += 1; s.tools[m[2]] = (s.tools[m[2]] || 0) + 1; byMcp.set(m[1], s); }
    }
  }
  const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  return { windowMs: DAY, total, mcpTotal, files: tailState.size,
    top: sorted(byTool).slice(0, 15), bySource: sorted(bySource), hourly: hourly.reverse(),
    mcp: [...byMcp.values()].sort((a, b) => b.calls - a.calls).map((s) => ({ ...s, tools: Object.entries(s.tools).sort((a, b) => b[1] - a[1]) })) };
}

// ---------- Local LLM: LM Studio + GPU ----------
async function gpu() {
  try {
    const rows = (await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit', '--format=csv,noheader,nounits'])).trim().split('\n');
    const apps = (await run('nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits']).catch(() => '')).trim().split('\n').filter(Boolean)
      .map((l) => { const [pid, proc, mem] = l.split(',').map((x) => x.trim()); // "python" says nothing: name venv interpreters after their project dir.
        const venv = proc.match(/([^/]+)\/\.?venv\/bin\//); const base = path.basename(proc);
        return { pid: Number(pid), name: venv ? `${venv[1]} (${base})` : base, path: proc, memMiB: Number(mem) }; });
    return rows.map((l) => { const [name, util, used, total, temp, power, limit] = l.split(',').map((x) => x.trim());
      return { name, util: num(util), memUsed: num(used), memTotal: num(total), temp: num(temp), power: num(power), powerLimit: num(limit), apps }; });
  } catch (error) { return [{ error: error.message }]; }
}
// llama.cpp timing lines in LM Studio's server log -> one record per completed request.
const lmLog = { file: null, offset: 0, rest: '', pending: {}, done: [] };
function lmTodayLog() {
  const d = new Date(); const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(LMSTUDIO_LOGS, ym);
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null; } catch { return null; }
}
function scanLmLog() {
  const file = lmTodayLog(); if (!file) return;
  let size; try { size = fs.statSync(file).size; } catch { return; }
  if (file !== lmLog.file || size < lmLog.offset) Object.assign(lmLog, { file, offset: Math.max(0, size - 8 * 1024 * 1024), rest: '', pending: {} });
  if (size === lmLog.offset) return;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - lmLog.offset); fs.readSync(fd, buf, 0, buf.length, lmLog.offset); lmLog.offset = size;
    const lines = (lmLog.rest + buf.toString('utf8')).split('\n'); lmLog.rest = lines.pop();
    let ts = Date.now(), model = null;
    for (const line of lines) {
      const stamp = line.match(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/); if (stamp) ts = Date.parse(stamp[1].replace(' ', 'T'));
      const m = line.match(/"model":\s*"([^"]+)"/); if (m) model = m[1];
      const task = line.match(/task (\d+) \|/); if (!task) continue;
      const id = task[1]; const p = lmLog.pending[id] || (lmLog.pending[id] = { t: ts, model });
      let x;
      if ((x = line.match(/prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens.*?([\d.]+) tokens per second/))) { p.promptMs = +x[1]; p.promptTokens = +x[2]; p.ppTps = +x[3]; }
      else if ((x = line.match(/\s eval time =\s*([\d.]+) ms \/\s*(\d+) tokens.*?([\d.]+) tokens per second/))) { p.genMs = +x[1]; p.genTokens = +x[2]; p.tgTps = +x[3]; }
      else if ((x = line.match(/stop processing: n_tokens = (\d+)/))) {
        p.ctxTokens = +x[1]; p.t = ts;
        if (Number.isFinite(p.promptTokens)) { p.cachedTokens = Math.max(0, p.ctxTokens - p.promptTokens - (p.genTokens || 0)); lmLog.done.push(p); }
        delete lmLog.pending[id];
      }
    }
  } finally { fs.closeSync(fd); }
  const cut = Date.now() - DAY; lmLog.done = lmLog.done.filter((r) => r.t >= cut).slice(-5000);
}
function lmSummary(windowMs) {
  const rs = lmLog.done.filter((r) => r.t >= Date.now() - windowMs);
  const sum = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
  const avg = (k) => { const v = rs.filter((r) => Number.isFinite(r[k])); return v.length ? v.reduce((a, r) => a + r[k], 0) / v.length : null; };
  const prompt = sum('promptTokens'), cached = sum('cachedTokens');
  return { requests: rs.length, promptTokens: prompt, cachedTokens: cached, genTokens: sum('genTokens'),
    cacheReusePct: prompt + cached > 0 ? cached / (prompt + cached) * 100 : null, avgTgTps: avg('tgTps'), avgPpTps: avg('ppTps'),
    busyS: (sum('promptMs') + sum('genMs')) / 1000 };
}
async function localLlm() {
  let models = [], error = null;
  try { models = (await getJson(`${LMSTUDIO_URL}/api/v0/models`)).data || []; } catch (e) { error = e.message; }
  scanLmLog();
  const gpus = await gpu();
  const loadedApps = gpus[0]?.apps || [];
  const lmProcs = loadedApps.filter((a) => /lmstudio|llama-server|lm-studio/i.test(a.path));
  return {
    lmstudio: { status: error ? 'down' : 'ok', error, url: LMSTUDIO_URL,
      loaded: models.filter((m) => m.state === 'loaded').map((m) => ({ id: m.id, type: m.type, ctx: m.loaded_context_length, maxCtx: m.max_context_length, quant: m.quantization, arch: m.arch })),
      available: models.length, vramMiB: lmProcs.reduce((a, p) => a + p.memMiB, 0) },
    hour: lmSummary(HOUR), day: lmSummary(DAY),
    recent: lmLog.done.slice(-10).reverse().map((r) => ({ t: r.t, model: r.model, prompt: r.promptTokens, cached: r.cachedTokens, gen: r.genTokens, tg: r.tgTps, pp: r.ppTps, ms: (r.promptMs || 0) + (r.genMs || 0) })),
    gpus,
    host: { load: os.loadavg(), cpus: os.cpus().length, memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem() },
  };
}

// ---------- Hindsight (Prometheus /metrics, no API key needed) ----------
function parseProm(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/); if (!m) continue;
    const labels = {}; if (m[2]) for (const kv of m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[kv[1]] = kv[2];
    out.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return out;
}
function groupSum(rows, name, key, filter = () => true) {
  const g = {}; for (const r of rows) if (r.name === name && filter(r.labels)) g[r.labels[key] ?? '—'] = (g[r.labels[key] ?? '—'] || 0) + r.value; return g;
}
async function containerStats(name) {
  try {
    const out = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', name], 8000);
    const s = JSON.parse(out.trim().split('\n')[0]); return { cpu: s.CPUPerc, mem: s.MemUsage, memPct: s.MemPerc, net: s.NetIO, block: s.BlockIO };
  } catch { return null; }
}
let containerCache = { at: 0, data: null };
async function hindsight() {
  try {
    const [health, metrics] = await Promise.all([getJson(`${HINDSIGHT_URL}/health`).catch((e) => ({ status: 'error', error: e.message })), get(`${HINDSIGHT_URL}/metrics`)]);
    const rows = parseProm(metrics);
    const durSum = groupSum(rows, 'hindsight_llm_duration_seconds_sum', 'scope'), durCount = groupSum(rows, 'hindsight_llm_duration_seconds_count', 'scope');
    const calls = groupSum(rows, 'hindsight_llm_calls_total', 'scope'), failed = groupSum(rows, 'hindsight_llm_calls_total', 'scope', (l) => l.success !== 'true');
    const tin = groupSum(rows, 'hindsight_llm_tokens_input_tokens_total', 'scope'), tout = groupSum(rows, 'hindsight_llm_tokens_output_tokens_total', 'scope');
    const scopes = Object.keys({ ...calls, ...tin }).map((scope) => ({ scope, calls: calls[scope] || 0, failed: failed[scope] || 0, inTokens: tin[scope] || 0, outTokens: tout[scope] || 0,
      avgS: durCount[scope] ? durSum[scope] / durCount[scope] : null })).sort((a, b) => b.calls - a.calls);
    const ops = groupSum(rows, 'hindsight_operation_operations_total', 'operation');
    const endpoints = groupSum(rows, 'hindsight_http_requests_total', 'endpoint', (l) => !/^\/(metrics|health|docs|openapi)/.test(l.endpoint));
    const errors = groupSum(rows, 'hindsight_http_requests_total', 'status_class', (l) => l.status_class !== '2xx');
    const models = groupSum(rows, 'hindsight_llm_calls_total', 'model');
    const one = (n) => rows.find((r) => r.name === n)?.value ?? null;
    if (Date.now() - containerCache.at > 30000) containerCache = { at: Date.now(), data: await containerStats(process.env.HINDSIGHT_CONTAINER || 'hindsight') };
    const start = one('process_start_time_seconds');
    return { status: health.status === 'healthy' ? 'ok' : 'degraded', health, scopes, models, operations: ops,
      endpoints: Object.entries(endpoints).sort((a, b) => b[1] - a[1]).slice(0, 10), httpErrors: errors,
      retainedDocs: rows.filter((r) => r.name === 'hindsight_retain_documents_total').reduce((a, r) => a + r.value, 0),
      processMem: one('process_resident_memory_bytes'), uptimeS: start ? Date.now() / 1000 - start : null, container: containerCache.data,
      ui: process.env.HINDSIGHT_UI || 'http://127.0.0.1:9999' };
  } catch (error) { return { status: 'down', error: error.message }; }
}

// ---------- Resource time series (sampled once a minute, kept 24h in memory) ----------
const series = [];
async function sample() {
  try {
    const [g] = await gpu(); scanLmLog();
    const hr = await Promise.all(HEADROOM.map((i) => getJson(`http://127.0.0.1:${i.port}/stats`, 3000).then((s) => s.requests?.total ?? null).catch(() => null)));
    series.push({ t: Date.now(), gpu: g?.util ?? null, vram: g?.memUsed ?? null, power: g?.power ?? null, load: os.loadavg()[0],
      lm: lmLog.done.filter((r) => r.t >= Date.now() - 60000).length, hr });
    const cut = Date.now() - DAY; while (series.length && series[0].t < cut) series.shift();
  } catch {}
}
function startSampling() { sample(); setInterval(sample, 60000).unref(); }

module.exports = { headroom, tools, localLlm, hindsight, series: () => series, startSampling, parseProm, HEADROOM };
