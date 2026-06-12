// In-app model bench — the server-side runner behind the admin "Bench" view.
//
// Same probe design as scripts/model-bench.mjs (one trigger → every model on the
// connected sources, echo/context/reasoning phases, TTFT/latency/cost/error-class
// metrics, hard USD budget with reserve-then-settle accounting), but runnable from
// the product UI: start a run, poll its status, read the results table. Runs are
// kept in memory (newest first, capped) — the script remains the CI/offline path.
//
// Spend isolation: OpenRouter calls prefer the dedicated DREAMSTREAMSTUDIO_MODELTEST
// key so bench traffic never bills the user-serving DREAMSTREAMSTUDIO_ALL key.

import { randomUUID, randomBytes } from 'node:crypto';
import {
  DREAMSTREAMSTUDIO_MODELTEST_KEY,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_APP_URL,
  OPENROUTER_APP_TITLE,
  NVIDIA_API_KEY,
  NVIDIA_BASE_URL
} from '../config.js';
import { logger } from '../lib/logger.js';
import { getSupabaseAdmin } from './supabase.js';
import { persistModelScores, type ModelBenchScore, type ModelPhaseScore } from './modelStats.js';

export type BenchSource = 'openrouter' | 'nvidia';
export type BenchPhase = 'echo' | 'context' | 'reasoning' | 'json' | 'coding' | 'vision' | 'tools';
const ALL_PHASES: BenchPhase[] = ['echo', 'context', 'reasoning', 'json', 'coding', 'vision', 'tools'];

export interface BenchOptions {
  source: BenchSource | 'all';
  freeOnly: boolean;
  match: string;
  limit: number;
  phases: BenchPhase[];
  budgetUsd: number;
  maxPerModelUsd: number;
  concurrency: number;
  timeoutMs: number;
  maxTokens: number;
  contextTokens: number;
  /** Only bench models published within the last N months (0 = no age filter).
   *  Old retired/legacy models waste budget and tell us nothing about today's catalog. */
  maxAgeMonths: number;
}

export interface BenchRecord {
  ts: string;
  source: BenchSource;
  model: string;
  phase: BenchPhase;
  ok: boolean;
  pass: boolean | null;
  httpStatus: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSec: number | null;
  costUsd: number | null;
  servedModel: string | null;
  finishReason: string | null;
  errorClass: string | null;
  errorDetail: string | null;
  promptPreview: string;
  textPreview: string | null;
}

export interface BenchRunSummary {
  id: string;
  state: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt: string | null;
  options: BenchOptions;
  planned: number;
  tested: number;
  healthy: number;
  spendUsd: number;
  anomalyCount: number;
  error?: string;
}

export interface BenchRun extends BenchRunSummary {
  results: BenchRecord[];
  anomalies: string[];
}

const DEFAULTS: BenchOptions = {
  source: 'all',
  freeOnly: false,
  match: '',
  limit: 0,
  phases: ALL_PHASES,
  budgetUsd: 5,
  maxPerModelUsd: 0.25,
  concurrency: 6,
  timeoutMs: 60_000,
  maxTokens: 256,
  contextTokens: 6_000,
  maxAgeMonths: 6
};

// Hidden-reasoning models burn completion tokens on thinking before they emit a
// single visible character. A flat per-run maxTokens starves them into
// finish_reason=length with empty text, which a past run misread as ~80 broken
// models. These headrooms are ADDED to opts.maxTokens for reasoning-capable models.
const REASONING_HEADROOM_TOKENS = 1_500;
const REASONING_PHASE_HEADROOM_TOKENS = 3_000;

const clamp = (v: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Sanitize client-supplied options — the server, not the client, owns the safety rails. */
export const normalizeBenchOptions = (raw: Partial<BenchOptions> | undefined): BenchOptions => {
  const phases = Array.isArray(raw?.phases)
    ? (raw!.phases.filter((p): p is BenchPhase => (ALL_PHASES as string[]).includes(p as string)))
    : DEFAULTS.phases;
  return {
    source: raw?.source === 'openrouter' || raw?.source === 'nvidia' ? raw.source : 'all',
    freeOnly: raw?.freeOnly === true,
    match: typeof raw?.match === 'string' ? raw.match.trim().toLowerCase().slice(0, 100) : '',
    limit: clamp(Number(raw?.limit), 0, 1000, 0),
    phases: phases.length ? phases : DEFAULTS.phases,
    budgetUsd: clamp(Number(raw?.budgetUsd), 0.1, 25, DEFAULTS.budgetUsd),
    maxPerModelUsd: clamp(Number(raw?.maxPerModelUsd), 0.001, 2, DEFAULTS.maxPerModelUsd),
    concurrency: clamp(Number(raw?.concurrency), 1, 10, DEFAULTS.concurrency),
    timeoutMs: clamp(Number(raw?.timeoutMs), 5_000, 120_000, DEFAULTS.timeoutMs),
    maxTokens: clamp(Number(raw?.maxTokens), 16, 4_096, DEFAULTS.maxTokens),
    contextTokens: clamp(Number(raw?.contextTokens), 500, 30_000, DEFAULTS.contextTokens),
    maxAgeMonths: clamp(Number(raw?.maxAgeMonths), 0, 60, DEFAULTS.maxAgeMonths)
  };
};

// ── Sources ─────────────────────────────────────────────────────────────────────
const sourceConfig = (source: BenchSource): { baseUrl: string; key: string; headers: Record<string, string> } | null => {
  if (source === 'openrouter') {
    const key = DREAMSTREAMSTUDIO_MODELTEST_KEY || OPENROUTER_API_KEY;
    if (!key) return null;
    return {
      baseUrl: OPENROUTER_BASE_URL,
      key,
      headers: { 'HTTP-Referer': OPENROUTER_APP_URL, 'X-Title': `${OPENROUTER_APP_TITLE} bench` }
    };
  }
  if (!NVIDIA_API_KEY) return null;
  return { baseUrl: NVIDIA_BASE_URL, key: NVIDIA_API_KEY, headers: {} };
};

interface BenchModel {
  source: BenchSource;
  id: string;
  contextLength: number | null;
  promptPerTok: number;
  completionPerTok: number;
  isFree: boolean;
  hasPricing: boolean;
  supportsTemperature: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  /** Unix seconds the model was published upstream (OpenRouter `created`). */
  createdAt: number | null;
  /** Non-null = not a general chat model; probed phases would only produce noise. */
  excludeReason: string | null;
}

// Catalog taxonomy: these respond on /chat/completions but are not conversational
// models, so echo/context/reasoning probes can only "fail" them. A past run counted
// them as broken instead of recognizing the category.
const SPECIAL_PURPOSE: Array<{ re: RegExp; reason: string }> = [
  { re: /guard|content-safety|shieldgemma|prompt-?injection/i, reason: 'safety classifier, not a chat model' },
  { re: /^relace\/|^morph\/morph|fast-apply/i, reason: 'code-edit apply model (requires special tagged input)' },
  { re: /bodybuilder/i, reason: 'request-builder meta-model (returns JSON request bodies)' },
  { re: /deep-research/i, reason: 'agentic deep-research model (minutes-long runs, not probe-compatible)' },
  { re: /lyria|musicgen|suno|-tts\b|whisper/i, reason: 'audio/music generation model' }
];

const discover = async (source: BenchSource): Promise<BenchModel[]> => {
  const cfg = sourceConfig(source);
  if (!cfg) return [];
  const res = await fetch(`${cfg.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.key}`, ...cfg.headers }
  });
  if (!res.ok) throw new Error(`${source} /models → HTTP ${res.status}`);
  const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.map((m) => {
    const id = String(m.id);
    const pricing = (m.pricing || {}) as Record<string, unknown>;
    const promptPerTok = Number(pricing.prompt) || 0;
    const completionPerTok = Number(pricing.completion) || 0;
    const arch = (m.architecture || {}) as Record<string, unknown>;
    const inMods = Array.isArray(arch.input_modalities) ? (arch.input_modalities as string[]) : ['text'];
    const outMods = Array.isArray(arch.output_modalities) ? (arch.output_modalities as string[]) : ['text'];
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : [];
    const textToText = inMods.includes('text') && outMods.includes('text');
    const special = SPECIAL_PURPOSE.find((s) => s.re.test(id));
    return {
      source,
      id,
      contextLength: Number(m.context_length) || null,
      promptPerTok,
      completionPerTok,
      isFree: source === 'openrouter'
        ? id.endsWith(':free') || (promptPerTok === 0 && completionPerTok === 0)
        : true, // NVIDIA bills credits to the key, not per-call USD
      hasPricing: source === 'openrouter',
      // o-series / image / search models reject unsupported sampler params with
      // HTTP 400 — only send temperature when the catalog says it's accepted.
      supportsTemperature: params.length === 0 || params.includes('temperature'),
      supportsReasoning:
        params.includes('reasoning') ||
        params.includes('include_reasoning') ||
        /\b(think|thinking|reasoner|-r1\b|o[134](-|$)|gpt-5)/i.test(id),
      supportsVision: inMods.includes('image'),
      supportsTools: params.includes('tools') || params.includes('tool_choice'),
      createdAt: Number(m.created) || null,
      excludeReason: !textToText
        ? `non-text modality (${inMods.join('+')} → ${outMods.join('+')})`
        : special?.reason ?? null
    };
  });
};

// ── Free-pool pacing + retries ──────────────────────────────────────────────────
// OpenRouter's :free models share ONE account-wide "free-models-per-min" quota
// (observed 16–20/min). Six workers hitting free models back-to-back trip it
// instantly, failing models that are perfectly healthy. Space free requests out
// globally; paid models are unaffected.
const FREE_REQUEST_INTERVAL_MS = 4_200;
let freeQueueTail: Promise<void> = Promise.resolve();
let nextFreeSlotAt = 0;
const acquireFreeSlot = (): Promise<void> => {
  const prev = freeQueueTail;
  let release!: () => void;
  freeQueueTail = new Promise((resolve) => (release = resolve));
  return prev.then(async () => {
    const wait = nextFreeSlotAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextFreeSlotAt = Date.now() + FREE_REQUEST_INTERVAL_MS;
    release();
  });
};

const RETRYABLE_CLASSES = new Set(['rate_limited', 'server_error', 'network']);
const MAX_ATTEMPTS = 3;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Phases ──────────────────────────────────────────────────────────────────────
// Probe-design notes, learned from run 6d0b89f2 (2026-06-12):
//  • A single sentence repeated thousands of times sends small models into
//    repetition loops, so they fail for reasons unrelated to context recall.
//  • Framing the needle as a secret ("vault code … remember it") makes
//    safety-tuned frontier models (Claude, GPT-5.x) refuse the question as a
//    prompt-injection/secret-extraction attempt. The needle must be mundane.
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

const buildContextPrompt = (tokens: number, refCode: string): string => {
  const targetChars = tokens * 4;
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; len < targetChars; i++) {
    const s = FILLER_SENTENCES[i % FILLER_SENTENCES.length];
    parts.push(s);
    len += s.length;
  }
  parts.splice(
    Math.floor(parts.length / 2),
    0,
    `For the catalog record, the reference ID for shipment 7 is ${refCode}. `
  );
  return parts.join('') + 'Question: what is the reference ID for shipment 7 mentioned above? Reply with the ID only.';
};

// Lenient final-answer extraction. The old exact regex failed models that replied
// "394." or "= 394" or showed correct working — instruction-following is the echo
// phase's job; this phase measures whether the model can get the arithmetic right.
const REASONING_ANSWER = 394;
const reasoningPass = (text: string): boolean => {
  const sentinel = text.match(/ANSWER\s*[:=]\s*\$?(-?\d[\d,]*(?:\.\d+)?)/i);
  const candidates = sentinel
    ? [sentinel[1]]
    : (text.replace(/[,$]/g, ' ').match(/-?\d+(?:\.\d+)?/g) || []).slice(-2);
  return candidates.some((n) => Math.abs(parseFloat(n.replace(/,/g, '')) - REASONING_ANSWER) < 1e-9);
};

interface PhaseSpec {
  prompt: string;
  promptTokens: number;
  pass: (text: string, meta: { toolCalls: string[] }) => boolean;
  skip?: (model: BenchModel) => string | null;
  /** Function tools to offer (tools phase). */
  tools?: Array<Record<string, unknown>>;
  /** Image attached to the prompt as a data URL (vision phase). */
  imageUrl?: string;
}

const buildPhases = (opts: BenchOptions): Record<BenchPhase, PhaseSpec> => {
  const nonce = randomBytes(4).toString('hex');
  const refCode = String(100000 + (parseInt(nonce.slice(0, 4), 16) % 900000));
  return {
    echo: {
      prompt: `Reply with exactly: BENCH-OK-${nonce}`,
      promptTokens: 20,
      pass: (text) => text.includes(nonce)
    },
    context: {
      prompt: buildContextPrompt(opts.contextTokens, refCode),
      promptTokens: opts.contextTokens + 30,
      pass: (text) => text.includes(refCode),
      skip: (model) =>
        model.contextLength && model.contextLength < opts.contextTokens + 200
          ? `context window ${model.contextLength} < probe ${opts.contextTokens}`
          : null
    },
    reasoning: {
      prompt:
        'Compute (17 * 23) + (144 / 12) - 9. You may show your working. ' +
        'End your reply with the final value on its own line in the form "ANSWER: <number>".',
      promptTokens: 50,
      pass: reasoningPass
    },
    // Model-type-specific probes: each auto-skips models that don't claim the
    // capability, so a text-only model is never penalized for lacking vision.
    json: {
      prompt: 'Return ONLY a JSON object of the form {"status":"ok","sum":N} where N is the result of 17+25. No prose, no code fences.',
      promptTokens: 40,
      pass: (text) => {
        const m = text.match(/\{[^{}]*\}/);
        if (!m) return false;
        try {
          const obj = JSON.parse(m[0]) as { status?: unknown; sum?: unknown };
          return obj.status === 'ok' && Number(obj.sum) === 42;
        } catch { return false; }
      }
    },
    coding: {
      prompt:
        'What is the exact console output of this JavaScript?\n' +
        'console.log([3,1,2].sort().map(n => n * 2).join("-"));\n' +
        'End your reply with the output on its own line in the form "OUTPUT: <text>".',
      promptTokens: 60,
      pass: (text) => /(^|\b|:)\s*2-4-6\b/.test(text)
    },
    vision: {
      prompt: 'Look at the attached image. What single color fills it? Reply with one word.',
      promptTokens: 280, // image tokens dominate
      imageUrl: BENCH_VISION_IMAGE,
      pass: (text) => /red/i.test(text),
      skip: (model) => (model.supportsVision ? null : 'not a vision model')
    },
    tools: {
      prompt: 'What is the current temperature in Paris? Use the available tool.',
      promptTokens: 90,
      tools: [{
        type: 'function',
        function: {
          name: 'get_current_temperature',
          description: 'Get the current temperature for a city, in °C.',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
        }
      }],
      pass: (_text, meta) => meta.toolCalls.includes('get_current_temperature'),
      skip: (model) => (model.supportsTools ? null : 'does not support tool calling')
    }
  };
};

// 16x16 solid-red PNG (~130 bytes) — a deterministic vision probe with one
// unambiguous answer, so the check is a plain case-insensitive match.
const BENCH_VISION_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=';

/** Completion-token budget for one phase: user setting + thinking headroom, hard-capped by the per-model spend. */
const phaseTokenBudget = (model: BenchModel, phase: BenchPhase, spec: PhaseSpec, opts: BenchOptions): number => {
  let budget = opts.maxTokens;
  if (model.supportsReasoning) {
    budget += phase === 'reasoning' ? REASONING_PHASE_HEADROOM_TOKENS : REASONING_HEADROOM_TOKENS;
  }
  if (model.hasPricing && model.completionPerTok > 0) {
    const perPhaseUsd = opts.maxPerModelUsd / Math.max(opts.phases.length, 1);
    const affordable = Math.floor((perPhaseUsd - spec.promptTokens * model.promptPerTok) / model.completionPerTok);
    budget = Math.min(budget, Math.max(affordable, opts.maxTokens));
  }
  return budget;
};

// ── One streamed request, instrumented ──────────────────────────────────────────
const runRequest = async (
  model: BenchModel,
  phase: BenchPhase,
  spec: PhaseSpec,
  opts: BenchOptions,
  maxTok: number,
  retryHint: { afterMs: number | null }
): Promise<BenchRecord> => {
  const cfg = sourceConfig(model.source)!;
  retryHint.afterMs = null;
  const rec: BenchRecord = {
    ts: new Date().toISOString(),
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
    promptPreview: spec.prompt.length > 140 ? `${spec.prompt.slice(0, 70)} … ${spec.prompt.slice(-50)}` : spec.prompt,
    textPreview: null
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}`, ...cfg.headers },
      signal: controller.signal,
      body: JSON.stringify({
        model: model.id,
        messages: [{
          role: 'user',
          content: spec.imageUrl
            ? [{ type: 'text', text: spec.prompt }, { type: 'image_url', image_url: { url: spec.imageUrl } }]
            : spec.prompt
        }],
        ...(spec.tools ? { tools: spec.tools, tool_choice: 'auto' } : {}),
        max_tokens: maxTok,
        // o-series / image / search models hard-reject sampler params (HTTP 400).
        ...(model.supportsTemperature ? { temperature: 0 } : {}),
        // Keep hidden thinking short on trivial probes — the arithmetic phase needs
        // none of it and the budget headroom stays available for the visible answer.
        ...(model.source === 'openrouter' && model.supportsReasoning ? { reasoning: { effort: 'low' } } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...(model.source === 'openrouter' ? { usage: { include: true } } : {})
      })
    });
    rec.httpStatus = res.status;
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      rec.errorClass =
        res.status === 429 ? 'rate_limited'
        : res.status === 404 ? 'not_found'
        : res.status === 401 || res.status === 403 ? 'auth'
        : res.status >= 500 ? 'server_error'
        : 'bad_request';
      rec.errorDetail = `HTTP ${res.status}: ${body}`;
      rec.totalMs = Date.now() - t0;
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) retryHint.afterMs = retryAfter * 1000;
      const resetAt = Number(res.headers.get('x-ratelimit-reset'));
      if (!retryHint.afterMs && Number.isFinite(resetAt) && resetAt > Date.now()) {
        retryHint.afterMs = resetAt - Date.now();
      }
      return rec;
    }

    let text = '';
    let reasoningChars = 0;
    const toolCalls: string[] = [];
    let ttft: number | null = null;
    let usage: Record<string, unknown> | null = null;

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      // Provider ignored stream:true and answered with one JSON body.
      const data = (await res.json()) as Record<string, any>;
      text = data?.choices?.[0]?.message?.content || '';
      reasoningChars = String(data?.choices?.[0]?.message?.reasoning || '').length;
      for (const tc of data?.choices?.[0]?.message?.tool_calls || []) {
        if (tc?.function?.name) toolCalls.push(String(tc.function.name));
      }
      usage = data?.usage || null;
      rec.finishReason = data?.choices?.[0]?.finish_reason || null;
      rec.servedModel = data?.model || null;
      ttft = Date.now() - t0;
    } else if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let chunk: Record<string, any>;
          try { chunk = JSON.parse(payload); } catch { continue; }
          rec.servedModel = chunk?.model || rec.servedModel;
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
          for (const tc of choice?.delta?.tool_calls || []) {
            const name = tc?.function?.name;
            if (name) {
              if (ttft === null) ttft = Date.now() - t0;
              toolCalls.push(String(name));
            }
          }
          if (choice?.finish_reason) rec.finishReason = choice.finish_reason;
        }
      }
    }

    const totalMs = Date.now() - t0;
    rec.ttftMs = ttft;
    rec.totalMs = totalMs;
    rec.textPreview = text.slice(0, 160).replace(/\s+/g, ' ');
    if (usage) {
      rec.promptTokens = Number(usage.prompt_tokens) || null;
      rec.completionTokens = Number(usage.completion_tokens) || null;
      rec.costUsd = typeof usage.cost === 'number' ? usage.cost : null;
      if (rec.completionTokens && ttft !== null && totalMs > ttft) {
        rec.tokensPerSec = Number((rec.completionTokens / ((totalMs - ttft) / 1000)).toFixed(1));
      }
    }
    if (!text.trim() && !toolCalls.length) {
      if (reasoningChars > 0 && rec.finishReason === 'length') {
        // Not a broken model — it spent the entire completion budget thinking.
        rec.errorClass = 'reasoning_overflow';
        rec.errorDetail = `spent the full ${maxTok}-token budget on hidden reasoning (${reasoningChars} chars), no visible answer — raise maxTokens`;
      } else {
        rec.errorClass = 'empty_response';
        rec.errorDetail = `finish_reason=${rec.finishReason ?? 'n/a'}`;
      }
      return rec;
    }
    rec.ok = true;
    rec.pass = spec.pass(text, { toolCalls });
    if (!rec.pass) {
      rec.errorClass = rec.finishReason === 'length' ? 'truncated' : 'wrong_answer';
      if (rec.errorClass === 'truncated') {
        rec.errorDetail = `output cut at the ${maxTok}-token budget before the answer completed — raise maxTokens`;
      }
    }
  } catch (err) {
    const e = err as Error & { name?: string };
    rec.errorClass = e?.name === 'AbortError' ? 'timeout' : 'network';
    rec.errorDetail = e?.name === 'AbortError' ? `no full response within ${opts.timeoutMs}ms` : String(e?.message || err).slice(0, 200);
    if (rec.totalMs === null) rec.totalMs = Date.now() - t0;
  } finally {
    clearTimeout(timer);
  }
  return rec;
};

// ── Run registry (memory for the live run + cache) + Supabase history ───────────
//
// Finished runs are persisted to model_bench_runs (best-effort — a DB hiccup never
// fails a run), so test history survives restarts/redeploys. Listing and lookups
// merge the in-memory runs (incl. the currently running one) with the stored rows.
const MAX_RUNS_KEPT = 10;
const runs: BenchRun[] = []; // newest first

const toSummary = (run: BenchRun): BenchRunSummary => {
  const { results: _r, anomalies: _a, ...summary } = run;
  return summary;
};

const rowToRun = (row: Record<string, unknown>): BenchRun => ({
  id: String(row.id),
  state: row.state === 'error' ? 'error' : 'done',
  startedAt: new Date(String(row.started_at)).toISOString(),
  finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
  options: normalizeBenchOptions((row.options || {}) as Partial<BenchOptions>),
  planned: Number(row.planned) || 0,
  tested: Number(row.tested) || 0,
  healthy: Number(row.healthy) || 0,
  spendUsd: Number(row.spend_usd) || 0,
  anomalyCount: Number(row.anomaly_count) || 0,
  error: row.error ? String(row.error) : undefined,
  results: Array.isArray(row.results) ? (row.results as BenchRecord[]) : [],
  anomalies: Array.isArray(row.anomalies) ? (row.anomalies as string[]) : []
});

const persistRun = async (run: BenchRun): Promise<void> => {
  try {
    const { error } = await getSupabaseAdmin().from('model_bench_runs').insert({
      id: run.id,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      state: run.state,
      options: run.options,
      planned: run.planned,
      tested: run.tested,
      healthy: run.healthy,
      spend_usd: run.spendUsd,
      anomaly_count: run.anomalyCount,
      error: run.error ?? null,
      results: run.results,
      anomalies: run.anomalies
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.warn('model_bench_persist_failed', { runId: run.id, message: (err as Error)?.message });
  }
};

const HISTORY_LIST_LIMIT = 50;

const fetchStoredRuns = async (limit: number, withResults: boolean): Promise<BenchRun[]> => {
  try {
    const columns = withResults
      ? '*'
      : 'id, started_at, finished_at, state, options, planned, tested, healthy, spend_usd, anomaly_count, error';
    const { data, error } = await getSupabaseAdmin()
      .from('model_bench_runs')
      .select(columns)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return ((data || []) as unknown as Array<Record<string, unknown>>).map(rowToRun);
  } catch (err) {
    logger.warn('model_bench_history_read_failed', { message: (err as Error)?.message });
    return [];
  }
};

/** In-memory runs (incl. running) merged with stored history, newest first, deduped by id. */
export const listBenchRuns = async (): Promise<BenchRunSummary[]> => {
  const stored = await fetchStoredRuns(HISTORY_LIST_LIMIT, false);
  const seen = new Set(runs.map((r) => r.id));
  const merged = [...runs.map(toSummary), ...stored.filter((r) => !seen.has(r.id)).map(toSummary)];
  return merged.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
};

export const getBenchRun = async (id: string): Promise<BenchRun | null> => {
  const inMemory = runs.find((r) => r.id === id);
  if (inMemory) return inMemory;
  try {
    const { data, error } = await getSupabaseAdmin().from('model_bench_runs').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? rowToRun(data as Record<string, unknown>) : null;
  } catch (err) {
    logger.warn('model_bench_run_read_failed', { runId: id, message: (err as Error)?.message });
    return null;
  }
};

const EXPORT_MAX_RUNS = 100;

/** Every finished run WITH full results (for the combined export), newest first. */
export const getAllBenchRuns = async (): Promise<BenchRun[]> => {
  const stored = await fetchStoredRuns(EXPORT_MAX_RUNS, true);
  const seen = new Set(stored.map((r) => r.id));
  const memoryOnly = runs.filter((r) => r.state !== 'running' && !seen.has(r.id));
  return [...memoryOnly, ...stored].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, EXPORT_MAX_RUNS);
};

export const getRunningBenchRun = (): BenchRun | null => runs.find((r) => r.state === 'running') || null;

// Budget with the *expected* completion (trivial probes answer in well under
// maxTokens+500 even with low-effort thinking), not the worst-case token cap —
// otherwise the reasoning headroom would price every frontier model out of the
// per-model cap. The ledger settles with actual reported cost after each call,
// and phaseTokenBudget() hard-caps worst-case spend at the per-model limit.
const estimatePhaseCost = (model: BenchModel, spec: PhaseSpec, opts: BenchOptions, maxTok: number): number =>
  model.hasPricing
    ? spec.promptTokens * model.promptPerTok + Math.min(maxTok, opts.maxTokens + 500) * model.completionPerTok
    : 0;

const skippedRecord = (model: BenchModel, phase: BenchPhase, detail: string): BenchRecord => ({
  ts: new Date().toISOString(),
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
  errorClass: 'skipped',
  errorDetail: detail,
  promptPreview: '',
  textPreview: null
});

/**
 * Start a bench run (one at a time). Returns the run id immediately; the run
 * executes in the background and is observed by polling getBenchRun(id).
 */
export const startBenchRun = (rawOptions: Partial<BenchOptions> | undefined): { run?: BenchRunSummary; error?: string } => {
  if (getRunningBenchRun()) return { error: 'A bench run is already in progress.' };
  const options = normalizeBenchOptions(rawOptions);

  const wanted: BenchSource[] = options.source === 'all' ? ['openrouter', 'nvidia'] : [options.source];
  if (!wanted.some((s) => sourceConfig(s))) {
    return { error: 'No usable source key on the server (DREAMSTREAMSTUDIO_MODELTEST / OPENROUTER_API_KEY / NVIDIA_API_KEY).' };
  }

  const run: BenchRun = {
    id: randomUUID(),
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    options,
    planned: 0,
    tested: 0,
    healthy: 0,
    spendUsd: 0,
    anomalyCount: 0,
    results: [],
    anomalies: []
  };
  runs.unshift(run);
  while (runs.length > MAX_RUNS_KEPT) runs.pop();

  void executeRun(run).catch((err) => {
    run.state = 'error';
    run.error = String((err as Error)?.message || err).slice(0, 300);
    run.finishedAt = new Date().toISOString();
    logger.warn('model_bench_run_failed', { runId: run.id, message: run.error });
    void persistRun(run);
  });

  const { results: _r, anomalies: _a, ...summary } = run;
  return { run: summary };
};

const executeRun = async (run: BenchRun): Promise<void> => {
  const opts = run.options;
  const phases = buildPhases(opts);
  const wanted: BenchSource[] = opts.source === 'all' ? ['openrouter', 'nvidia'] : [opts.source];

  let models: BenchModel[] = [];
  for (const s of wanted) {
    if (!sourceConfig(s)) continue;
    try {
      models.push(...(await discover(s)));
    } catch (err) {
      run.anomalies.push(`${s} discovery failed: ${(err as Error).message}`);
    }
  }
  if (opts.match) models = models.filter((m) => m.id.toLowerCase().includes(opts.match));
  if (opts.freeOnly) models = models.filter((m) => m.isFree);

  // Special-purpose / non-text models can't pass chat probes by design — testing
  // them only manufactures anomalies. Surface them once, then leave them out.
  const excluded = models.filter((m) => m.excludeReason);
  models = models.filter((m) => !m.excludeReason);
  if (excluded.length) {
    run.anomalies.push(
      `info: excluded ${excluded.length} special-purpose/non-text models from chat probes: ` +
      excluded.map((m) => `${m.id} (${m.excludeReason})`).join('; ')
    );
  }

  // Recency filter: legacy/retired models waste budget and say nothing about
  // today's catalog. Models without a published date (NVIDIA) are kept.
  if (opts.maxAgeMonths > 0) {
    const cutoff = Date.now() / 1000 - opts.maxAgeMonths * 30.44 * 86_400;
    const before = models.length;
    models = models.filter((m) => m.createdAt === null || m.createdAt >= cutoff);
    if (before !== models.length) {
      run.anomalies.push(`info: age filter (≤${opts.maxAgeMonths} months) kept ${models.length} of ${before} models`);
    }
  }

  const fullCost = (m: BenchModel) =>
    opts.phases.reduce((s, p) => s + estimatePhaseCost(m, phases[p], opts, phaseTokenBudget(m, p, phases[p], opts)), 0);
  models.sort((a, b) => fullCost(a) - fullCost(b)); // cheapest first — budget cuts the expensive tail
  if (opts.limit > 0) models = models.slice(0, opts.limit);
  run.planned = models.length;

  // Reserve-then-settle budget ledger (same scheme as the script).
  let committedUsd = 0;

  // DRS Benchmark Score: transparent 0-100 composite per model. Weighted pass
  // rate over the phases that APPLY to the model (skipped phases don't count
  // against it), small speed bonus for sub-second TTFT, small penalty for any
  // 30s+ phase. Published to model_bench_scores when the run finishes.
  const PHASE_WEIGHTS: Record<BenchPhase, number> = {
    echo: 10, context: 20, reasoning: 20, json: 15, coding: 20, vision: 7.5, tools: 7.5
  };
  const runScores: ModelBenchScore[] = [];
  const computeScore = (model: BenchModel, rows: BenchRecord[]): ModelBenchScore | null => {
    let applicable = 0;
    let earned = 0;
    const phases: Record<string, ModelPhaseScore> = {};
    const ttfts: number[] = [];
    let slow = false;
    for (const r of rows) {
      phases[r.phase] = { pass: r.pass, ttftMs: r.ttftMs, tokensPerSec: r.tokensPerSec };
      if (r.errorClass === 'skipped') continue;
      const w = PHASE_WEIGHTS[r.phase] ?? 10;
      applicable += w;
      if (r.ok && r.pass === true) earned += w;
      if (r.ttftMs !== null) ttfts.push(r.ttftMs);
      if ((r.totalMs ?? 0) > 30_000) slow = true;
    }
    if (!applicable) return null;
    ttfts.sort((a, b) => a - b);
    const medianTtft = ttfts.length ? ttfts[Math.floor(ttfts.length / 2)] : null;
    let score = (earned / applicable) * 100;
    if (medianTtft !== null && medianTtft < 1_000 && score > 0) score = Math.min(100, score + 5);
    if (slow) score = Math.max(0, score - 5);
    return {
      source: model.source,
      model: model.id,
      score: Math.round(score * 10) / 10,
      phases,
      runId: run.id,
      computedAt: new Date().toISOString()
    };
  };

  // Healthy = proved at least one phase AND failed none. (All-skipped used to
  // count as healthy, which inflated the headline number.)
  const perModelHealthy = (rows: BenchRecord[]): boolean =>
    rows.some((r) => r.ok && r.pass === true) &&
    rows.every((r) => (r.ok && r.pass !== false) || r.errorClass === 'skipped');

  // One phase with transient-failure retries. Free-pool pacing happens per attempt
  // so retried calls also respect the shared account-wide quota.
  const attemptPhase = async (model: BenchModel, phase: BenchPhase, spec: PhaseSpec, maxTok: number): Promise<{ rec: BenchRecord; attempts: number }> => {
    const retryHint: { afterMs: number | null } = { afterMs: null };
    let rec!: BenchRecord;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (model.source === 'openrouter' && model.isFree) await acquireFreeSlot();
      rec = await runRequest(model, phase, spec, opts, maxTok, retryHint);
      const transientStreamDrop = rec.errorClass === 'empty_response' && rec.finishReason === 'error';
      const retryable = (rec.errorClass && RETRYABLE_CLASSES.has(rec.errorClass)) || transientStreamDrop;
      if (!retryable || attempt === MAX_ATTEMPTS) return { rec, attempts: attempt };
      const base = rec.errorClass === 'rate_limited' ? 6_000 : 1_500;
      const wait = Math.min(retryHint.afterMs ?? base * 2 ** (attempt - 1), 30_000) + Math.random() * 500;
      await sleep(wait);
    }
    return { rec, attempts: MAX_ATTEMPTS };
  };

  const runModel = async (model: BenchModel): Promise<void> => {
    const rows: BenchRecord[] = [];
    for (const phase of opts.phases) {
      const spec = phases[phase];
      const skipReason = spec.skip?.(model);
      if (skipReason) { rows.push(skippedRecord(model, phase, skipReason)); continue; }
      const maxTok = phaseTokenBudget(model, phase, spec, opts);
      const est = estimatePhaseCost(model, spec, opts, maxTok);
      if (est > opts.maxPerModelUsd) { rows.push(skippedRecord(model, phase, `estimated $${est.toFixed(3)} > per-model cap`)); continue; }
      if (committedUsd + est > opts.budgetUsd) { rows.push(skippedRecord(model, phase, 'budget exhausted')); continue; }
      committedUsd += est;
      const { rec, attempts } = await attemptPhase(model, phase, spec, maxTok);
      if (typeof rec.costUsd === 'number') {
        committedUsd += rec.costUsd - est;
        run.spendUsd = Number((run.spendUsd + rec.costUsd).toFixed(6));
      } else {
        run.spendUsd = Number((run.spendUsd + est).toFixed(6));
      }
      rows.push(rec);
      // Anomalies, mirrored from the script's report.
      if (rec.errorClass && rec.errorClass !== 'skipped' && rec.errorClass !== 'wrong_answer') {
        const suffix = attempts > 1 ? ` (after ${attempts} attempts)` : '';
        run.anomalies.push(`${model.source}:${model.id} [${phase}] ${rec.errorClass}${suffix}: ${rec.errorDetail || ''}`);
      }
      if (rec.ok && (rec.totalMs ?? 0) > 30_000) {
        run.anomalies.push(`${model.source}:${model.id} [${phase}] SLOW: ${rec.totalMs}ms total (ttft ${rec.ttftMs ?? '—'}ms)`);
      }
      if (rec.ok && rec.pass === false && rec.errorClass === 'wrong_answer') {
        run.anomalies.push(`${model.source}:${model.id} [${phase}] responded but failed the check: "${rec.textPreview}"`);
      }
      // Dead-on-arrival models: don't burn the remaining phases.
      if (rec.errorClass && ['auth', 'not_found', 'timeout'].includes(rec.errorClass)) {
        for (const rest of opts.phases.slice(opts.phases.indexOf(phase) + 1)) {
          rows.push(skippedRecord(model, rest, `previous phase ${rec.errorClass}`));
        }
        break;
      }
    }
    run.results.push(...rows);
    run.tested += 1;
    if (perModelHealthy(rows)) run.healthy += 1;
    run.anomalyCount = run.anomalies.length;
    const score = computeScore(model, rows);
    if (score) runScores.push(score);
  };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, Math.max(models.length, 1)) }, async () => {
    while (cursor < models.length) {
      const model = models[cursor++];
      await runModel(model);
    }
  });
  await Promise.all(workers);

  run.state = 'done';
  run.finishedAt = new Date().toISOString();
  await persistRun(run);
  await persistModelScores(run.id, runScores);
  logger.info('model_bench_run_done', {
    runId: run.id,
    planned: run.planned,
    tested: run.tested,
    healthy: run.healthy,
    spendUsd: run.spendUsd,
    anomalies: run.anomalyCount
  });
};
