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

export type BenchSource = 'openrouter' | 'nvidia';
export type BenchPhase = 'echo' | 'context' | 'reasoning';

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
  phases: ['echo', 'context', 'reasoning'],
  budgetUsd: 5,
  maxPerModelUsd: 0.25,
  concurrency: 6,
  timeoutMs: 60_000,
  maxTokens: 120,
  contextTokens: 6_000
};

const clamp = (v: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Sanitize client-supplied options — the server, not the client, owns the safety rails. */
export const normalizeBenchOptions = (raw: Partial<BenchOptions> | undefined): BenchOptions => {
  const phases = Array.isArray(raw?.phases)
    ? (raw!.phases.filter((p): p is BenchPhase => p === 'echo' || p === 'context' || p === 'reasoning'))
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
    maxTokens: clamp(Number(raw?.maxTokens), 16, 512, DEFAULTS.maxTokens),
    contextTokens: clamp(Number(raw?.contextTokens), 500, 30_000, DEFAULTS.contextTokens)
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
  imageOnly: boolean;
}

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
    const pricing = (m.pricing || {}) as Record<string, unknown>;
    const promptPerTok = Number(pricing.prompt) || 0;
    const completionPerTok = Number(pricing.completion) || 0;
    const arch = (m.architecture || {}) as Record<string, unknown>;
    const out = Array.isArray(arch.output_modalities) ? (arch.output_modalities as string[]) : [];
    return {
      source,
      id: String(m.id),
      contextLength: Number(m.context_length) || null,
      promptPerTok,
      completionPerTok,
      isFree: source === 'openrouter'
        ? String(m.id).endsWith(':free') || (promptPerTok === 0 && completionPerTok === 0)
        : true, // NVIDIA bills credits to the key, not per-call USD
      hasPricing: source === 'openrouter',
      imageOnly: out.includes('image') && !out.includes('text')
    };
  });
};

// ── Phases ──────────────────────────────────────────────────────────────────────
const buildContextPrompt = (tokens: number, vaultCode: string): string => {
  const sentence = 'The archive room holds shelves of unlabeled boxes that nobody has opened in years. ';
  const reps = Math.max(1, Math.ceil((tokens * 4) / sentence.length));
  const half = Math.floor(reps / 2);
  return (
    sentence.repeat(half) +
    `Important: the vault code is ${vaultCode}. Remember it. ` +
    sentence.repeat(reps - half) +
    'Question: what is the vault code mentioned above? Reply with the code only.'
  );
};

interface PhaseSpec {
  prompt: string;
  promptTokens: number;
  pass: (text: string) => boolean;
  skip?: (model: BenchModel) => string | null;
}

const buildPhases = (opts: BenchOptions): Record<BenchPhase, PhaseSpec> => {
  const nonce = randomBytes(4).toString('hex');
  const vaultCode = String(100000 + (parseInt(nonce.slice(0, 4), 16) % 900000));
  return {
    echo: {
      prompt: `Reply with exactly: BENCH-OK-${nonce}`,
      promptTokens: 20,
      pass: (text) => text.includes(nonce)
    },
    context: {
      prompt: buildContextPrompt(opts.contextTokens, vaultCode),
      promptTokens: opts.contextTokens + 30,
      pass: (text) => text.includes(vaultCode),
      skip: (model) =>
        model.contextLength && model.contextLength < opts.contextTokens + 200
          ? `context window ${model.contextLength} < probe ${opts.contextTokens}`
          : null
    },
    reasoning: {
      prompt: 'Compute: (17 * 23) + (144 / 12) - 9. Reply with only the final number.',
      promptTokens: 30,
      pass: (text) => /(^|[^\d.])394([^\d.]|$)/.test(text)
    }
  };
};

// ── One streamed request, instrumented ──────────────────────────────────────────
const runRequest = async (
  model: BenchModel,
  phase: BenchPhase,
  spec: PhaseSpec,
  opts: BenchOptions
): Promise<BenchRecord> => {
  const cfg = sourceConfig(model.source)!;
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
        messages: [{ role: 'user', content: spec.prompt }],
        max_tokens: opts.maxTokens,
        temperature: 0,
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
      return rec;
    }

    let text = '';
    let ttft: number | null = null;
    let usage: Record<string, unknown> | null = null;

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      // Provider ignored stream:true and answered with one JSON body.
      const data = (await res.json()) as Record<string, any>;
      text = data?.choices?.[0]?.message?.content || '';
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
          if (delta) {
            if (ttft === null) ttft = Date.now() - t0;
            text += delta;
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
    if (!text.trim()) {
      rec.errorClass = 'empty_response';
      rec.errorDetail = `finish_reason=${rec.finishReason ?? 'n/a'}`;
      return rec;
    }
    rec.ok = true;
    rec.pass = spec.pass(text);
    if (!rec.pass) rec.errorClass = 'wrong_answer';
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

const estimatePhaseCost = (model: BenchModel, spec: PhaseSpec, opts: BenchOptions): number =>
  model.hasPricing ? spec.promptTokens * model.promptPerTok + opts.maxTokens * model.completionPerTok : 0;

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
  models = models.filter((m) => !m.imageOnly);
  if (opts.match) models = models.filter((m) => m.id.toLowerCase().includes(opts.match));
  if (opts.freeOnly) models = models.filter((m) => m.isFree);
  const fullCost = (m: BenchModel) => opts.phases.reduce((s, p) => s + estimatePhaseCost(m, phases[p], opts), 0);
  models.sort((a, b) => fullCost(a) - fullCost(b)); // cheapest first — budget cuts the expensive tail
  if (opts.limit > 0) models = models.slice(0, opts.limit);
  run.planned = models.length;

  // Reserve-then-settle budget ledger (same scheme as the script).
  let committedUsd = 0;

  const perModelHealthy = (rows: BenchRecord[]): boolean =>
    rows.every((r) => (r.ok && r.pass !== false) || r.errorClass === 'skipped');

  const runModel = async (model: BenchModel): Promise<void> => {
    const rows: BenchRecord[] = [];
    for (const phase of opts.phases) {
      const spec = phases[phase];
      const skipReason = spec.skip?.(model);
      if (skipReason) { rows.push(skippedRecord(model, phase, skipReason)); continue; }
      const est = estimatePhaseCost(model, spec, opts);
      if (est > opts.maxPerModelUsd) { rows.push(skippedRecord(model, phase, `estimated $${est.toFixed(3)} > per-model cap`)); continue; }
      if (committedUsd + est > opts.budgetUsd) { rows.push(skippedRecord(model, phase, 'budget exhausted')); continue; }
      committedUsd += est;
      const rec = await runRequest(model, phase, spec, opts);
      if (typeof rec.costUsd === 'number') {
        committedUsd += rec.costUsd - est;
        run.spendUsd = Number((run.spendUsd + rec.costUsd).toFixed(6));
      } else {
        run.spendUsd = Number((run.spendUsd + est).toFixed(6));
      }
      rows.push(rec);
      // Anomalies, mirrored from the script's report.
      if (rec.errorClass && rec.errorClass !== 'skipped' && rec.errorClass !== 'wrong_answer') {
        run.anomalies.push(`${model.source}:${model.id} [${phase}] ${rec.errorClass}: ${rec.errorDetail || ''}`);
      }
      if (rec.ok && (rec.totalMs ?? 0) > 30_000) {
        run.anomalies.push(`${model.source}:${model.id} [${phase}] SLOW: ${rec.totalMs}ms total (ttft ${rec.ttftMs ?? '—'}ms)`);
      }
      if (rec.ok && rec.pass === false) {
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
  logger.info('model_bench_run_done', {
    runId: run.id,
    planned: run.planned,
    tested: run.tested,
    healthy: run.healthy,
    spendUsd: run.spendUsd,
    anomalies: run.anomalyCount
  });
};
