#!/usr/bin/env node
// Live source/model validator — verifies that the NVIDIA and OpenRouter sources
// actually answer, across multiple models, with a real round-trip (no server, no
// build step). This is the "test it yourself" harness: it proves whether a given
// source+model combination works end to end against the real provider API.
//
//   node scripts/source-model-validate.mjs                 # both sources, default models
//   node scripts/source-model-validate.mjs --source nvidia # one source only
//   node scripts/source-model-validate.mjs --discover 5    # pull /models live, test first 5
//   node scripts/source-model-validate.mjs --models a,b,c  # explicit model ids
//   node scripts/source-model-validate.mjs --prompt "2+2?" # custom probe prompt
//
// Keys are read from the environment or a .env file (project root / server/):
//   OPENROUTER_API_KEY, NVIDIA_API_KEY
// Optional base-url overrides: OPENROUTER_BASE_URL, NVIDIA_BASE_URL.
//
// Exit code is non-zero if any TESTED model fails (a source with no key is SKIPPED,
// not failed), so it can gate CI.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const loadEnvFile = (path) => {
  try {
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch { /* no .env — ignore */ }
};
loadEnvFile(resolve(projectRoot, '.env'));
loadEnvFile(resolve(projectRoot, 'server/.env'));

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const onlySource = flag('source');
const discoverN = flag('discover') ? Math.max(1, Number(flag('discover'))) : 0;
const explicitModels = flag('models') ? flag('models').split(',').map((s) => s.trim()).filter(Boolean) : null;
const prompt = flag('prompt') || 'Reply with exactly: OK';
const TIMEOUT_MS = Number(flag('timeout')) || 30_000;

// Default model sets seeded from the live catalog (model_catalog_cache).
const SOURCES = {
  openrouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    // Test tooling runs on the dedicated DREAMSTREAMSTUDIO_MODELTEST key when present,
    // so validation spend never lands on the user-serving DREAMSTREAMSTUDIO_ALL key.
    key: process.env.DREAMSTREAMSTUDIO_MODELTEST || process.env.dreamstreamstudio_modeltest || process.env.OPENROUTER_API_KEY,
    headers: { 'HTTP-Referer': 'https://dreamstream.local', 'X-Title': 'DreamStream source validator' },
    models: [
      'google/gemini-2.0-flash-exp:free',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-flash',
      'anthropic/claude-3.5-haiku',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat'
    ]
  },
  nvidia: {
    baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    key: process.env.NVIDIA_API_KEY,
    headers: {},
    models: [
      'meta/llama-3.3-70b-instruct',
      'google/gemma-2-2b-it',
      'google/gemma-2b',
      'google/codegemma-7b',
      'deepseek-ai/deepseek-coder-6.7b-instruct',
      'abacusai/dracarys-llama-3.1-70b-instruct'
    ]
  }
};

const listModels = async (src) => {
  const res = await fetch(`${src.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${src.key}`, ...src.headers }
  });
  if (!res.ok) throw new Error(`/models HTTP ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map((m) => m.id).filter(Boolean);
};

const probeModel = async (src, model) => {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${src.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${src.key}`, ...src.headers },
      // temperature 0.2 (not 0): some NVIDIA NIM models reject temperature=0 with a
      // 422 (must be > 0), which would otherwise show as a false failure.
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 16, temperature: 0.2 }),
      signal: controller.signal
    });
    const ms = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* keep raw */ }
      return { ok: false, ms, status: res.status, error: msg };
    }
    let content = '';
    try { content = JSON.parse(text)?.choices?.[0]?.message?.content ?? ''; } catch { /* */ }
    const hasContent = typeof content === 'string' && content.trim().length > 0;
    return { ok: hasContent, ms, status: res.status, sample: String(content).replace(/\s+/g, ' ').trim().slice(0, 40), error: hasContent ? undefined : 'empty content' };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, status: 0, error: err?.name === 'AbortError' ? `timeout >${TIMEOUT_MS}ms` : (err?.message || String(err)) };
  } finally {
    clearTimeout(timer);
  }
};

const runSource = async (name) => {
  const src = SOURCES[name];
  console.log(`\n=== ${name.toUpperCase()} (${src.baseUrl}) ===`);
  if (!src.key) {
    console.log(`  SKIPPED — no ${name === 'nvidia' ? 'NVIDIA_API_KEY' : 'OPENROUTER_API_KEY'} in env/.env`);
    return { name, skipped: true, pass: 0, fail: 0 };
  }

  let models = explicitModels || src.models;
  if (discoverN) {
    try {
      const live = await listModels(src);
      models = live.slice(0, discoverN);
      console.log(`  discovered ${live.length} models live; testing first ${models.length}`);
    } catch (e) {
      console.log(`  /models discovery failed (${e.message}); using defaults`);
    }
  }

  let pass = 0, fail = 0;
  for (const model of models) {
    const r = await probeModel(src, model);
    if (r.ok) pass++; else fail++;
    const tag = r.ok ? 'PASS' : 'FAIL';
    const detail = r.ok ? `${r.ms}ms  "${r.sample}"` : `HTTP ${r.status}  ${r.error}`;
    console.log(`  [${tag}] ${model.padEnd(48)} ${detail}`);
  }
  console.log(`  -> ${pass}/${pass + fail} passed`);
  return { name, skipped: false, pass, fail };
};

const main = async () => {
  const names = onlySource ? [onlySource] : Object.keys(SOURCES);
  const results = [];
  for (const n of names) {
    if (!SOURCES[n]) { console.error(`Unknown source: ${n}`); process.exit(2); }
    results.push(await runSource(n));
  }
  console.log('\n=== SUMMARY ===');
  let anyFail = false, anyTested = false;
  for (const r of results) {
    if (r.skipped) { console.log(`  ${r.name}: SKIPPED (no key)`); continue; }
    anyTested = true;
    if (r.fail > 0) anyFail = true;
    console.log(`  ${r.name}: ${r.pass}/${r.pass + r.fail} passed`);
  }
  if (!anyTested) { console.log('  Nothing tested — set OPENROUTER_API_KEY and/or NVIDIA_API_KEY.'); process.exit(0); }
  process.exit(anyFail ? 1 : 0);
};

main().catch((e) => { console.error('validator crashed:', e); process.exit(2); });
