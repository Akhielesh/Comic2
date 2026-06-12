#!/usr/bin/env node
// Model bench — ONE manual trigger that live-tests EVERY model on your sources
// (OpenRouter + NVIDIA Build) and writes plain log/table data. No UI.
//
// Per model it measures, with real round-trips:
//   - availability + HTTP status + error class (timeout / 429 / 404 / empty / …)
//   - TTFT (time to first streamed token), total latency, output tokens/sec
//   - token usage and ACTUAL provider-billed cost (OpenRouter returns usage.cost)
//   - instruction-following sanity (echo a nonce), context recall (a "needle"
//     planted in ~6K tokens of filler), and a deterministic arithmetic check
//   - whether the served model matches the requested model (routing surprises)
//
// Output: bench-results/run-<stamp>/{meta.json, results.jsonl, results.csv, summary.md}
// plus a console table with an anomaly section and a spend report. Exit code 1 when
// any tested model hard-fails, so it can gate CI.
//
//   npm run bench:models                            # everything with a key, all phases
//   npm run bench:models -- --dry-run               # plan + cost estimate, zero calls
//   npm run bench:models -- --source openrouter --free-only
//   npm run bench:models -- --match claude --budget 2
//   npm run bench:models -- --models openrouter:anthropic/claude-fable-5,nvidia:meta/llama-3.3-70b-instruct
//
// Options (defaults in brackets):
//   --source openrouter|nvidia|all  [all]      --budget USD          [5]
//   --models src:id,src:id          (explicit) --max-per-model USD   [0.25]
//   --match substring               (filter)   --concurrency N       [6]
//   --free-only | --paid-only                  --timeout ms          [60000]
//   --limit N                                  --max-tokens N        [120]
//   --phases echo,context,reasoning [all 3]    --retries N (429/5xx) [1]
//   --context-tokens N              [6000]     --slow-ms N (flag)    [30000]
//   --dry-run                                  --out dir             [bench-results]
//
// Keys come from the environment or .env (project root / server/). OpenRouter prefers
// the dedicated test key DREAMSTREAMSTUDIO_MODELTEST (falls back to OPENROUTER_API_KEY)
// so bench spend never mixes with the user-serving DREAMSTREAMSTUDIO_ALL key.
// NVIDIA: NVIDIA_API_KEY. Bases: OPENROUTER_BASE_URL, NVIDIA_BASE_URL.

import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

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

// ── CLI ────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const OPT = {
  source: flag('source') || 'all',
  models: flag('models') ? flag('models').split(',').map((s) => s.trim()).filter(Boolean) : null,
  match: (flag('match') || '').toLowerCase(),
  freeOnly: has('free-only'),
  paidOnly: has('paid-only'),
  limit: Number(flag('limit')) || 0,
  phases: (flag('phases') || 'echo,context,reasoning').split(',').map((s) => s.trim()),
  budgetUsd: Number(flag('budget')) || 5,
  maxPerModelUsd: Number(flag('max-per-model')) || 0.25,
  concurrency: Math.max(1, Number(flag('concurrency')) || 6),
  timeoutMs: Number(flag('timeout')) || 60_000,
  maxTokens: Number(flag('max-tokens')) || 256,
  retries: flag('retries') !== undefined ? Math.max(0, Number(flag('retries')) || 0) : 1,
  contextTokens: Number(flag('context-tokens')) || 6_000,
  slowMs: Number(flag('slow-ms')) || 30_000,
  dryRun: has('dry-run'),
  outDir: flag('out') || 'bench-results'
};

// ── Sources ────────────────────────────────────────────────────────────────────
const SOURCES = {
  openrouter: {
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    key: process.env.DREAMSTREAMSTUDIO_MODELTEST || process.env.dreamstreamstudio_modeltest || process.env.OPENROUTER_API_KEY,
    extraHeaders: {
      'HTTP-Referer': process.env.OPENROUTER_APP_URL || 'https://dreamstream.studio',
      'X-Title': 'DreamStream model bench'
    }
  },
  nvidia: {
    baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    key: process.env.NVIDIA_API_KEY,
    extraHeaders: {}
  }
};

const wantedSources = OPT.source === 'all' ? ['openrouter', 'nvidia'] : [OPT.source];
for (const s of wantedSources) {
  if (!SOURCES[s]) { console.error(`Unknown source "${s}" — use openrouter | nvidia | all.`); process.exit(2); }
}

const headersFor = (source) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${SOURCES[source].key}`,
  ...SOURCES[source].extraHeaders
});

// ── Discovery ──────────────────────────────────────────────────────────────────
// OpenRouter /models includes per-token pricing; NVIDIA's OpenAI-style /models has
// only ids (its free tier is credit-based), so NVIDIA cost is recorded as null.
const discover = async (source) => {
  const res = await fetch(`${SOURCES[source].baseUrl}/models`, { headers: headersFor(source) });
  if (!res.ok) throw new Error(`${source} /models → HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.map((m) => {
    const id = String(m.id);
    const promptPerTok = Number(m?.pricing?.prompt) || 0;
    const completionPerTok = Number(m?.pricing?.completion) || 0;
    const inMods = Array.isArray(m?.architecture?.input_modalities) ? m.architecture.input_modalities : ['text'];
    const outMods = Array.isArray(m?.architecture?.output_modalities) ? m.architecture.output_modalities : ['text'];
    const params = Array.isArray(m?.supported_parameters) ? m.supported_parameters : [];
    const special = SPECIAL_PURPOSE.find((s) => s.re.test(id));
    return {
      source,
      id,
      contextLength: Number(m.context_length) || null,
      promptPerTok,
      completionPerTok,
      isFree: source === 'openrouter'
        ? id.endsWith(':free') || (promptPerTok === 0 && completionPerTok === 0)
        : true, // NVIDIA hosted models bill against the key's credit pool, not per-call USD
      hasPricing: source === 'openrouter',
      supportsTemperature: params.length === 0 || params.includes('temperature'),
      supportsReasoning: params.includes('reasoning') || params.includes('include_reasoning') ||
        /\b(think|thinking|reasoner|-r1\b|o[134](-|$)|gpt-5)/i.test(id),
      excludeReason: !(inMods.includes('text') && outMods.includes('text'))
        ? `non-text modality (${inMods.join('+')} → ${outMods.join('+')})`
        : special?.reason ?? null
    };
  });
};

// Special-purpose models answer /chat/completions but are not chat models, so
// echo/context/reasoning probes can only "fail" them. Exclude up front.
const SPECIAL_PURPOSE = [
  { re: /guard|content-safety|shieldgemma|prompt-?injection/i, reason: 'safety classifier' },
  { re: /^relace\/|^morph\/morph|fast-apply/i, reason: 'code-edit apply model' },
  { re: /bodybuilder/i, reason: 'request-builder meta-model' },
  { re: /deep-research/i, reason: 'agentic deep-research model' },
  { re: /lyria|musicgen|suno|-tts\b|whisper/i, reason: 'audio/music model' }
];

// Hidden-reasoning models burn completion tokens thinking before any visible
// output; give them headroom or they end at finish_reason=length with no text.
const REASONING_HEADROOM = 1_500;
const REASONING_PHASE_HEADROOM = 3_000;
const phaseTokenBudget = (model, phase) => {
  let budget = OPT.maxTokens;
  if (model.supportsReasoning) budget += phase === 'reasoning' ? REASONING_PHASE_HEADROOM : REASONING_HEADROOM;
  if (model.hasPricing && model.completionPerTok > 0) {
    const perPhaseUsd = OPT.maxPerModelUsd / Math.max(activePhases.length, 1);
    const { promptTokens } = PHASES[phase].build();
    const affordable = Math.floor((perPhaseUsd - promptTokens * model.promptPerTok) / model.completionPerTok);
    budget = Math.min(budget, Math.max(affordable, OPT.maxTokens));
  }
  return budget;
};

// ── Test phases ────────────────────────────────────────────────────────────────
const NONCE = randomBytes(4).toString('hex');
const VAULT_CODE = String(100000 + (parseInt(NONCE.slice(0, 4), 16) % 900000));

// Deterministic filler so the context probe is reproducible and genuinely long.
// ~4 chars/token → contextTokens * 4 chars, with the needle planted mid-way.
// Varied sentences (a single repeated one sends small models into repetition
// loops) and a mundane needle (a "secret vault code" makes safety-tuned models
// refuse the question as a prompt-injection test).
const FILLER_SENTENCES = [
  'The archive room holds shelves of unlabeled boxes that nobody has opened in years. ',
  'A narrow window lets in pale light that settles over the dusty reading desks. ',
  'Catalog cards sit in long wooden drawers, sorted by a system only the founder understood. ',
  'Visitors sign a paper ledger at the front counter before walking the narrow aisles. ',
  'Somewhere above, a ceiling fan turns slowly and stirs the smell of old paper. ',
  'The basement stores rolled maps and blueprints wrapped in brown twine. ',
  'A typewritten index of donors hangs in a thin frame beside the stairwell. ',
  'Each spring the staff rotate the displays in the entry-hall cabinets. '
];
const buildContextPrompt = (tokens) => {
  const targetChars = tokens * 4;
  const parts = [];
  let len = 0;
  for (let i = 0; len < targetChars; i++) {
    const s = FILLER_SENTENCES[i % FILLER_SENTENCES.length];
    parts.push(s);
    len += s.length;
  }
  parts.splice(Math.floor(parts.length / 2), 0, `For the catalog record, the reference ID for shipment 7 is ${VAULT_CODE}. `);
  return parts.join('') + 'Question: what is the reference ID for shipment 7 mentioned above? Reply with the ID only.';
};

// Lenient final-answer extraction: "394." / "= 394" / correct working all count.
// Strict instruction-following is the echo phase's job, not this one's.
const reasoningPass = (text) => {
  const sentinel = text.match(/ANSWER\s*[:=]\s*\$?(-?\d[\d,]*(?:\.\d+)?)/i);
  const candidates = sentinel
    ? [sentinel[1]]
    : (text.replace(/[,$]/g, ' ').match(/-?\d+(?:\.\d+)?/g) || []).slice(-2);
  return candidates.some((n) => Math.abs(parseFloat(n.replace(/,/g, '')) - 394) < 1e-9);
};

const PHASES = {
  echo: {
    label: 'echo',
    build: () => ({
      messages: [{ role: 'user', content: `Reply with exactly: BENCH-OK-${NONCE}` }],
      promptTokens: 20
    }),
    pass: (text) => text.includes(NONCE)
  },
  context: {
    label: 'context',
    build: () => ({
      messages: [{ role: 'user', content: buildContextPrompt(OPT.contextTokens) }],
      promptTokens: OPT.contextTokens + 30
    }),
    pass: (text) => text.includes(VAULT_CODE),
    // Skip models whose window can't even hold the filler.
    skip: (model) => model.contextLength && model.contextLength < OPT.contextTokens + 200
      ? `context window ${model.contextLength} < probe ${OPT.contextTokens}` : null
  },
  reasoning: {
    label: 'reasoning',
    build: () => ({
      messages: [{
        role: 'user',
        content:
          'Compute (17 * 23) + (144 / 12) - 9. You may show your working. ' +
          'End your reply with the final value on its own line in the form "ANSWER: <number>".'
      }],
      promptTokens: 50
    }),
    pass: reasoningPass
  }
};

const activePhases = OPT.phases.filter((p) => PHASES[p]);
if (activePhases.length === 0) { console.error('No valid phases. Use --phases echo,context,reasoning'); process.exit(2); }

const estimatePhaseCost = (model, phase) => {
  if (!model.hasPricing) return 0; // NVIDIA: credit-based, no USD figure to estimate
  const { promptTokens } = PHASES[phase].build();
  // Budget with the expected completion (trivial probes finish well under the
  // reasoning headroom); phaseTokenBudget hard-caps the worst case per model.
  const expectedCompletion = Math.min(phaseTokenBudget(model, phase), OPT.maxTokens + 500);
  return promptTokens * model.promptPerTok + expectedCompletion * model.completionPerTok;
};
const estimateModelCost = (model) => activePhases.reduce((s, p) => s + estimatePhaseCost(model, p), 0);

// ── One streamed chat-completion request, fully instrumented ───────────────────
const runRequest = async (model, phase) => {
  const { messages } = PHASES[phase].build();
  const startedAt = Date.now();
  const rec = {
    ts: new Date(startedAt).toISOString(),
    source: model.source,
    model: model.id,
    phase,
    ok: false,
    pass: null,
    httpStatus: null,
    ttftMs: null,
    totalMs: null,
    promptTokens: null,
    completionTokens: null,
    tokensPerSec: null,
    costUsd: null,
    servedModel: null,
    finishReason: null,
    errorClass: null,
    errorDetail: null,
    retries: 0,
    textPreview: null
  };

  const attemptOnce = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPT.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(`${SOURCES[model.source].baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headersFor(model.source),
        signal: controller.signal,
        body: JSON.stringify({
          model: model.id,
          messages,
          max_tokens: phaseTokenBudget(model, phase),
          // o-series / image / search models hard-reject sampler params (HTTP 400).
          ...(model.supportsTemperature ? { temperature: 0 } : {}),
          // Keep hidden thinking short on trivial probes.
          ...(model.source === 'openrouter' && model.supportsReasoning ? { reasoning: { effort: 'low' } } : {}),
          stream: true,
          stream_options: { include_usage: true }, // OpenAI-style; OpenRouter + NVIDIA accept it
          ...(model.source === 'openrouter' ? { usage: { include: true } } : {})
        })
      });
      rec.httpStatus = res.status;
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        const err = new Error(`HTTP ${res.status}: ${body}`);
        err.status = res.status;
        throw err;
      }

      let text = '';
      let reasoningChars = 0;
      let ttft = null;
      let usage = null;
      let finishReason = null;
      let servedModel = null;

      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('application/json')) {
        // Provider ignored stream:true and answered in one JSON body.
        const data = await res.json();
        text = data?.choices?.[0]?.message?.content || '';
        usage = data?.usage || null;
        finishReason = data?.choices?.[0]?.finish_reason || null;
        servedModel = data?.model || null;
        ttft = Date.now() - t0;
      } else {
        // SSE: data: {...}\n\n frames, terminated by data: [DONE]
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let chunk;
            try { chunk = JSON.parse(payload); } catch { continue; }
            servedModel = chunk?.model || servedModel;
            if (chunk?.usage) usage = chunk.usage;
            const choice = chunk?.choices?.[0];
            const delta = choice?.delta?.content ?? choice?.text ?? '';
            const reasoningDelta = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content ?? '';
            if (typeof reasoningDelta === 'string' && reasoningDelta) {
              if (ttft === null) ttft = Date.now() - t0;
              reasoningChars += reasoningDelta.length;
            }
            if (delta) {
              if (ttft === null) ttft = Date.now() - t0;
              text += delta;
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
          }
        }
      }

      const totalMs = Date.now() - t0;
      rec.ttftMs = ttft;
      rec.totalMs = totalMs;
      rec.servedModel = servedModel;
      rec.finishReason = finishReason;
      rec.textPreview = text.slice(0, 120).replace(/\s+/g, ' ');
      if (usage) {
        rec.promptTokens = usage.prompt_tokens ?? null;
        rec.completionTokens = usage.completion_tokens ?? null;
        rec.costUsd = typeof usage.cost === 'number' ? usage.cost : null;
        if (rec.completionTokens && ttft !== null && totalMs > ttft) {
          rec.tokensPerSec = Number((rec.completionTokens / ((totalMs - ttft) / 1000)).toFixed(1));
        }
      }
      if (!text.trim()) {
        if (reasoningChars > 0 && finishReason === 'length') {
          rec.errorClass = 'reasoning_overflow';
          rec.errorDetail = `spent the whole completion budget on hidden reasoning (${reasoningChars} chars) — raise --max-tokens`;
        } else {
          rec.errorClass = 'empty_response';
          rec.errorDetail = `finish_reason=${finishReason ?? 'n/a'}`;
        }
        return;
      }
      rec.ok = true;
      rec.pass = PHASES[phase].pass(text);
      if (!rec.pass) rec.errorClass = finishReason === 'length' ? 'truncated' : 'wrong_answer';
    } catch (err) {
      const msg = String(err?.message || err);
      if (err?.name === 'AbortError') {
        rec.errorClass = 'timeout';
        rec.errorDetail = `no full response within ${OPT.timeoutMs}ms`;
      } else if (err?.status === 429) {
        rec.errorClass = 'rate_limited';
        rec.errorDetail = msg.slice(0, 200);
      } else if (err?.status >= 500) {
        rec.errorClass = 'server_error';
        rec.errorDetail = msg.slice(0, 200);
      } else if (err?.status >= 400) {
        rec.errorClass = err.status === 404 ? 'not_found' : err.status === 401 || err.status === 403 ? 'auth' : 'bad_request';
        rec.errorDetail = msg.slice(0, 200);
      } else {
        rec.errorClass = 'network';
        rec.errorDetail = msg.slice(0, 200);
      }
      if (rec.totalMs === null) rec.totalMs = Date.now() - t0;
    } finally {
      clearTimeout(timer);
    }
  };

  await attemptOnce();
  // Retry only transient failures (429 / 5xx / network), with simple backoff.
  let backoff = 2_000;
  while (!rec.ok && rec.retries < OPT.retries && ['rate_limited', 'server_error', 'network'].includes(rec.errorClass)) {
    await new Promise((r) => setTimeout(r, backoff));
    backoff *= 2;
    rec.retries += 1;
    rec.errorClass = null;
    rec.errorDetail = null;
    await attemptOnce();
  }
  return rec;
};

// ── Budget ledger ──────────────────────────────────────────────────────────────
const ledger = { committedUsd: 0, actualUsd: 0 };
// Reserve estimate up-front; settle to actual (or keep estimate when the provider
// reports no USD cost) so the cap holds even while requests are in flight.
const reserve = (usd) => { ledger.committedUsd += usd; };
const settle = (estimated, actual) => {
  if (typeof actual === 'number') {
    ledger.committedUsd += actual - estimated;
    ledger.actualUsd += actual;
  } else {
    ledger.actualUsd += estimated;
  }
};

// ── Main ───────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtUsd = (v) => (v === null || v === undefined ? '—' : `$${v.toFixed(5)}`);

const main = async () => {
  const usable = wantedSources.filter((s) => SOURCES[s].key);
  const skippedSources = wantedSources.filter((s) => !SOURCES[s].key);
  for (const s of skippedSources) console.warn(`⚠ ${s}: no API key set — skipped.`);
  if (usable.length === 0) { console.error('No usable source keys (OPENROUTER_API_KEY / NVIDIA_API_KEY).'); process.exit(2); }

  // 1) Build the model list.
  let models = [];
  if (OPT.models) {
    for (const spec of OPT.models) {
      const [maybeSrc, ...rest] = spec.split(':');
      const known = SOURCES[maybeSrc] ? maybeSrc : null;
      const id = known ? rest.join(':') : spec;
      const source = known || usable[0];
      if (!SOURCES[source].key) { console.warn(`⚠ ${spec}: no key for ${source} — skipped.`); continue; }
      models.push({ source, id, contextLength: null, promptPerTok: 0, completionPerTok: 0, isFree: false, hasPricing: false, supportsTemperature: true, supportsReasoning: false, excludeReason: null });
    }
  } else {
    for (const s of usable) {
      try {
        const found = await discover(s);
        console.log(`• ${s}: ${found.length} models listed`);
        models.push(...found);
      } catch (err) {
        console.warn(`⚠ ${s} discovery failed: ${err.message}`);
      }
    }
  }

  // Chat probes only make sense for general text→text chat models.
  const excludedModels = models.filter((m) => m.excludeReason);
  models = models.filter((m) => !m.excludeReason);
  if (excludedModels.length) {
    console.log(`ℹ excluded ${excludedModels.length} special-purpose/non-text models: ${excludedModels.map((m) => `${m.id} (${m.excludeReason})`).join('; ')}`);
  }
  if (OPT.match) models = models.filter((m) => m.id.toLowerCase().includes(OPT.match));
  if (OPT.freeOnly) models = models.filter((m) => m.isFree);
  if (OPT.paidOnly) models = models.filter((m) => !m.isFree);
  // Cheapest first: free models burn no budget, and expensive ones only run if budget remains.
  models.sort((a, b) => estimateModelCost(a) - estimateModelCost(b));
  if (OPT.limit > 0) models = models.slice(0, OPT.limit);

  const totalEstimate = models.reduce((s, m) => s + estimateModelCost(m), 0);
  console.log(`\nModel bench — ${models.length} models · phases: ${activePhases.join(', ')} · budget $${OPT.budgetUsd}`);
  console.log(`Worst-case estimated spend (every model, full ${OPT.maxTokens}-token answers): $${totalEstimate.toFixed(2)}\n`);

  if (OPT.dryRun) {
    const expensive = [...models].reverse().slice(0, 15).filter((m) => estimateModelCost(m) > 0.001);
    console.log('Dry run — nothing called. Most expensive per-model estimates:');
    for (const m of expensive) console.log(`  ${pad(`${m.source}:${m.id}`, 60)} ~$${estimateModelCost(m).toFixed(4)}`);
    console.log(`\nWithin budget: ${models.filter((m) => estimateModelCost(m) <= OPT.maxPerModelUsd).length}/${models.length} models under the per-model cap ($${OPT.maxPerModelUsd}).`);
    return;
  }

  // 2) Output dir.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(projectRoot, OPT.outDir, `run-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const jsonlPath = join(runDir, 'results.jsonl');
  writeFileSync(jsonlPath, '');

  // 3) Run: a worker pool over models; phases run sequentially per model so a dead
  //    model (auth/404/timeout) costs one request, not three.
  const results = [];
  const perModel = new Map();
  let cursor = 0;
  let done = 0;

  const runModel = async (model) => {
    const rows = [];
    for (const phase of activePhases) {
      const skipReason = PHASES[phase].skip?.(model);
      if (skipReason) {
        rows.push({ source: model.source, model: model.id, phase, ok: false, pass: null, errorClass: 'skipped', errorDetail: skipReason });
        continue;
      }
      const est = estimatePhaseCost(model, phase);
      if (est > OPT.maxPerModelUsd) {
        rows.push({ source: model.source, model: model.id, phase, ok: false, pass: null, errorClass: 'skipped', errorDetail: `estimated $${est.toFixed(3)} > per-model cap $${OPT.maxPerModelUsd}` });
        continue;
      }
      if (ledger.committedUsd + est > OPT.budgetUsd) {
        rows.push({ source: model.source, model: model.id, phase, ok: false, pass: null, errorClass: 'skipped', errorDetail: 'budget exhausted' });
        continue;
      }
      reserve(est);
      const rec = await runRequest(model, phase);
      settle(est, rec.costUsd);
      rows.push(rec);
      appendFileSync(jsonlPath, JSON.stringify(rec) + '\n');
      // Hard failures that won't change with a different prompt → don't burn the other phases.
      if (['auth', 'not_found', 'timeout'].includes(rec.errorClass)) {
        for (const rest of activePhases.slice(activePhases.indexOf(phase) + 1)) {
          rows.push({ source: model.source, model: model.id, phase: rest, ok: false, pass: null, errorClass: 'skipped', errorDetail: `previous phase ${rec.errorClass}` });
        }
        break;
      }
    }
    perModel.set(`${model.source}:${model.id}`, rows);
    results.push(...rows);
    done += 1;
    if (done % 20 === 0 || done === models.length) {
      console.log(`  …${done}/${models.length} models · spent ~$${ledger.actualUsd.toFixed(3)}`);
    }
  };

  const workers = Array.from({ length: Math.min(OPT.concurrency, models.length) }, async () => {
    while (cursor < models.length) {
      const model = models[cursor++];
      await runModel(model);
    }
  });
  await Promise.all(workers);

  // 4) Reports.
  const echoOf = (rows) => rows.find((r) => r.phase === 'echo') || rows[0];
  const cell = (rows, phase) => {
    const r = rows.find((x) => x.phase === phase);
    if (!r) return '—';
    if (r.errorClass === 'skipped') return 'skip';
    if (!r.ok) return `✗ ${r.errorClass}`;
    return r.pass ? '✓' : '✗ wrong';
  };

  const keys = [...perModel.keys()].sort((a, b) => {
    const fa = perModel.get(a).some((r) => !r.ok && r.errorClass !== 'skipped');
    const fb = perModel.get(b).some((r) => !r.ok && r.errorClass !== 'skipped');
    if (fa !== fb) return fa ? -1 : 1; // failures first
    return (echoOf(perModel.get(b)).totalMs ?? 0) - (echoOf(perModel.get(a)).totalMs ?? 0); // then slowest
  });

  const csvCols = ['ts', 'source', 'model', 'phase', 'ok', 'pass', 'httpStatus', 'ttftMs', 'totalMs', 'promptTokens', 'completionTokens', 'tokensPerSec', 'costUsd', 'servedModel', 'finishReason', 'errorClass', 'errorDetail', 'retries'];
  const csv = [csvCols.join(',')].concat(results.map((r) => csvCols.map((c) => {
    const v = r[c];
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(','))).join('\n');
  writeFileSync(join(runDir, 'results.csv'), csv);

  const mdLines = [
    `# Model bench — ${stamp}`,
    '',
    `${models.length} models · phases: ${activePhases.join(', ')} · budget $${OPT.budgetUsd} · actual spend ~$${ledger.actualUsd.toFixed(4)}`,
    '',
    '| Model | Source | Echo | TTFT | Total | tok/s | Context | Reasoning | Cost | Error |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ];
  for (const k of keys) {
    const rows = perModel.get(k);
    const e = echoOf(rows);
    const cost = rows.reduce((s, r) => s + (r.costUsd || 0), 0);
    mdLines.push(`| ${k.split(':').slice(1).join(':')} | ${rows[0].source} | ${cell(rows, 'echo')} | ${fmtMs(e.ttftMs)} | ${fmtMs(e.totalMs)} | ${e.tokensPerSec ?? '—'} | ${cell(rows, 'context')} | ${cell(rows, 'reasoning')} | ${fmtUsd(cost || null)} | ${e.errorDetail || ''} |`);
  }
  writeFileSync(join(runDir, 'summary.md'), mdLines.join('\n') + '\n');

  // Anomalies.
  const anomalies = [];
  for (const k of keys) {
    const rows = perModel.get(k);
    for (const r of rows) {
      if (r.errorClass && r.errorClass !== 'skipped' && r.errorClass !== 'wrong_answer') anomalies.push(`${k} [${r.phase}] ${r.errorClass}: ${r.errorDetail || ''}`);
      if (r.ok && r.totalMs > OPT.slowMs) anomalies.push(`${k} [${r.phase}] SLOW: ${fmtMs(r.totalMs)} total (ttft ${fmtMs(r.ttftMs)})`);
      if (r.ok && r.pass === false) anomalies.push(`${k} [${r.phase}] responded but failed the check: "${r.textPreview}"`);
      if (r.servedModel && !r.servedModel.includes(r.model.split('/').pop()?.replace(/:free$/, '') ?? r.model)) {
        anomalies.push(`${k} [${r.phase}] served by a different model id: ${r.servedModel}`);
      }
    }
  }

  const tested = keys.length;
  const healthy = keys.filter((k) => perModel.get(k).every((r) => (r.ok && r.pass !== false) || r.errorClass === 'skipped')).length;
  const meta = {
    stamp, options: OPT, sources: usable, modelsPlanned: models.length, modelsTested: tested,
    healthy, anomalies: anomalies.length,
    spend: { budgetUsd: OPT.budgetUsd, actualUsd: Number(ledger.actualUsd.toFixed(4)) },
    nonce: NONCE
  };
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));

  console.log(`\n${pad('MODEL', 52)} ${pad('SRC', 11)} ${pad('ECHO', 12)} ${pad('TTFT', 8)} ${pad('TOTAL', 8)} ${pad('CTX', 10)} ${pad('MATH', 10)} COST`);
  for (const k of keys.slice(0, 60)) {
    const rows = perModel.get(k);
    const e = echoOf(rows);
    const cost = rows.reduce((s, r) => s + (r.costUsd || 0), 0);
    console.log(`${pad(k.split(':').slice(1).join(':'), 52)} ${pad(rows[0].source, 11)} ${pad(cell(rows, 'echo'), 12)} ${pad(fmtMs(e.ttftMs), 8)} ${pad(fmtMs(e.totalMs), 8)} ${pad(cell(rows, 'context'), 10)} ${pad(cell(rows, 'reasoning'), 10)} ${fmtUsd(cost || null)}`);
  }
  if (keys.length > 60) console.log(`  … ${keys.length - 60} more (see summary.md)`);

  if (anomalies.length) {
    console.log(`\n⚠ Anomalies (${anomalies.length}):`);
    for (const a of anomalies.slice(0, 40)) console.log(`  - ${a}`);
    if (anomalies.length > 40) console.log(`  … ${anomalies.length - 40} more in results.jsonl`);
  }

  console.log(`\nHealthy: ${healthy}/${tested} models · actual spend ~$${ledger.actualUsd.toFixed(4)} of $${OPT.budgetUsd} budget`);
  console.log(`Logs: ${runDir.replace(projectRoot + '/', '')}/ (results.jsonl · results.csv · summary.md · meta.json)`);

  process.exitCode = healthy === tested ? 0 : 1;
};

main().catch((err) => { console.error(`\n❌ ${err?.message || err}`); process.exit(1); });
