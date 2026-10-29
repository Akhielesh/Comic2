// Model Lab over HTTP (admin-only; server/src/routes/comicModelLab.ts, logic in server/src/comic/models/lab.ts).
// The wire types mirror the server's views (LabOverview, LabRunView, BlindPairView); answers are checked field by
// field here so a broken or newer server never reaches the UI as anything but well-formed data. Nothing here polls:
// the section asks once on open and on Refresh, and a paid call is only ever sent by runLabCheck — which always sends
// `ack: true` with the quote the admin confirmed and the click's idempotency key.

import { ApiError, get, post } from '../../../../services/apiClient';

export const MODEL_LAB_PATH = '/api/comic/models/lab';

export type LabCheckId = 'D1' | 'D2' | 'D3' | 'D4';
export type LabHealthState = 'ok' | 'degraded' | 'down' | 'unknown';
export type BlindPick = 'A' | 'B' | 'tie';

export interface LabQuote {
  usd: number;
  source: 'pricebook' | 'research';
  basis: string;
  refsUnpriced: boolean;
}

export interface LabHealth {
  state: LabHealthState;
  reason?: string;
  source: 'openrouter' | 'observed' | 'none';
  checkedAt: number;
}

export interface LabItem {
  id: string;
  check: LabCheckId;
  title: string;
  modelId: string;
  nickname: string;
  kind: string;
  res: string;
  aspect: string;
  refs: number;
  refsNote: string;
  quote: LabQuote | null;
  health: LabHealth | null;
  canRun: boolean;
  reason?: string;
  note?: string;
  pair?: { id: string; label: string };
  runs: { ok: number; failed: number; running: number };
}

export interface LabCheck {
  id: LabCheckId;
  title: string;
  decision: string;
  answers: string;
  note?: string;
  items: LabItem[];
}

export interface LabSent {
  model?: string;
  aspect?: string | null;
  resolution?: string | null;
  quality?: string | null;
  references: number;
}

export interface LabFacts {
  callMade: boolean;
  endpoint?: string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
  message?: string | null;
  providerSaid?: string | null;
  costReported?: boolean;
  width?: number;
  height?: number;
  bytes?: number;
  mediaType?: string;
  aspectOk?: boolean;
  blank?: boolean;
  latencyMs?: number;
  providerMs?: number;
  providerModelVersion?: string | null;
  providerName?: string | null;
  sent?: LabSent | null;
  refsSent: number;
  stored?: boolean;
  recordedCall?: boolean;
  stoppedSecondCall?: boolean;
  watermark?: { visible: boolean | null; at: string; by: string | null } | null;
}

export type LabRunStatus = 'running' | 'ok' | 'failed' | 'interrupted';

export interface LabRun {
  id: string;
  checkId: LabCheckId;
  itemId: string;
  title: string;
  model: { id: string; nickname: string };
  status: LabRunStatus;
  res: string | null;
  aspect: string | null;
  quotedUsd: number;
  costUsd: number | null;
  quoteBasis?: string;
  facts: LabFacts;
  imageUrl?: string;
  createdAt: string;
  finishedAt: string | null;
}

/** A D4 click's answer: no image (it is judged blind), but what it cost. */
export interface LabBlindRun {
  id: string;
  checkId: 'D4';
  itemId: string;
  status: LabRunStatus;
  pair: { id: string; label: string };
  quotedUsd: number;
  costUsd: number | null;
  message?: string | null;
}

export interface BlindSide {
  slot: 'A' | 'B';
  imageUrl?: string;
  /** Only after the vote. */
  run?: LabRun;
}

export interface BlindPair {
  id: string;
  label: string;
  state: 'waiting' | 'ready' | 'voted';
  waitingFor?: string[];
  a?: BlindSide;
  b?: BlindSide;
  pick?: BlindPick;
}

export interface LabOverview {
  capUsd: number;
  day: string;
  spentUsd: number;
  remainingUsd: number;
  ready: { platformKey: boolean; storage: boolean };
  checks: LabCheck[];
  results: LabRun[];
  blind: BlindPair[];
  now: number;
}

export interface LabRunAnswer {
  replayed: boolean;
  run: LabRun | LabBlindRun;
  spentUsd: number;
  remainingUsd: number;
}

// ── Validation (pure) ────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const text = (v: unknown, max = 400): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const CHECKS: ReadonlySet<string> = new Set(['D1', 'D2', 'D3', 'D4']);
const STATES: ReadonlySet<string> = new Set(['ok', 'degraded', 'down', 'unknown']);
const RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'ok', 'failed', 'interrupted']);
const HTTPS_URL = /^https:\/\/\S+$/i;

const asQuote = (v: unknown): LabQuote | null => {
  if (!isObject(v)) return null;
  const usd = num(v.usd);
  if (usd === undefined || usd <= 0) return null;
  return { usd, source: v.source === 'research' ? 'research' : 'pricebook', basis: text(v.basis) ?? '', refsUnpriced: v.refsUnpriced === true };
};

const asHealth = (v: unknown): LabHealth | null => {
  if (!isObject(v) || !STATES.has(String(v.state))) return null;
  const reason = text(v.reason, 200);
  return {
    state: v.state as LabHealthState,
    ...(reason ? { reason } : {}),
    source: v.source === 'openrouter' || v.source === 'observed' ? v.source : 'none',
    checkedAt: num(v.checkedAt) ?? 0
  };
};

const asPair = (v: unknown): { id: string; label: string } | undefined => {
  if (!isObject(v)) return undefined;
  const id = text(v.id, 60);
  const label = text(v.label, 80);
  return id && label ? { id, label } : undefined;
};

const asItem = (v: unknown): LabItem | undefined => {
  if (!isObject(v) || !CHECKS.has(String(v.check))) return undefined;
  const id = text(v.id, 80);
  const title = text(v.title, 160);
  if (!id || !title) return undefined;
  const runs = isObject(v.runs) ? v.runs : {};
  const pair = asPair(v.pair);
  const reason = text(v.reason, 600);
  const note = text(v.note, 600);
  return {
    id,
    check: v.check as LabCheckId,
    title,
    modelId: text(v.modelId, 120) ?? '',
    nickname: text(v.nickname, 80) ?? '',
    kind: text(v.kind, 20) ?? '',
    res: text(v.res, 8) ?? '',
    aspect: text(v.aspect, 8) ?? '',
    refs: num(v.refs) ?? 0,
    refsNote: text(v.refsNote, 200) ?? '',
    quote: asQuote(v.quote),
    health: asHealth(v.health),
    // A missing quote can never be run, whatever the flag says (costs first).
    canRun: v.canRun === true && !!asQuote(v.quote),
    ...(reason ? { reason } : {}),
    ...(note ? { note } : {}),
    ...(pair ? { pair } : {}),
    runs: { ok: num(runs.ok) ?? 0, failed: num(runs.failed) ?? 0, running: num(runs.running) ?? 0 }
  };
};

const asFacts = (v: unknown): LabFacts => {
  const f = isObject(v) ? v : {};
  const out: LabFacts = { callMade: f.callMade === true, refsSent: num(f.refsSent) ?? 0 };
  for (const k of ['width', 'height', 'bytes', 'latencyMs', 'providerMs', 'httpStatus'] as const) {
    const n = num(f[k]);
    if (n !== undefined) (out as unknown as Record<string, number>)[k] = n;
  }
  for (const k of ['endpoint', 'errorCode', 'message', 'providerSaid', 'mediaType', 'providerModelVersion', 'providerName'] as const) {
    const s = text(f[k], 600);
    if (s) (out as unknown as Record<string, string>)[k] = s;
  }
  for (const k of ['costReported', 'aspectOk', 'blank', 'stored', 'recordedCall', 'stoppedSecondCall'] as const) {
    if (typeof f[k] === 'boolean') (out as unknown as Record<string, boolean>)[k] = f[k] as boolean;
  }
  if (isObject(f.sent)) {
    const s = f.sent;
    out.sent = { references: num(s.references) ?? 0, model: text(s.model, 120), aspect: text(s.aspect, 8) ?? null, resolution: text(s.resolution, 8) ?? null, quality: text(s.quality, 20) ?? null };
  }
  if (isObject(f.watermark) && (f.watermark.visible === true || f.watermark.visible === false || f.watermark.visible === null)) {
    out.watermark = { visible: f.watermark.visible as boolean | null, at: text(f.watermark.at, 40) ?? '', by: text(f.watermark.by, 64) ?? null };
  }
  return out;
};

export const asRun = (v: unknown): LabRun | undefined => {
  if (!isObject(v) || !CHECKS.has(String(v.checkId)) || !RUN_STATUSES.has(String(v.status))) return undefined;
  const id = text(v.id, 64);
  const quotedUsd = num(v.quotedUsd);
  const model = isObject(v.model) ? v.model : undefined;
  if (!id || quotedUsd === undefined || !model) return undefined;
  const imageUrl = text(v.imageUrl, 2000);
  const quoteBasis = text(v.quoteBasis);
  return {
    id,
    checkId: v.checkId as LabCheckId,
    itemId: text(v.itemId, 80) ?? '',
    title: text(v.title, 160) ?? '',
    model: { id: text(model.id, 120) ?? '', nickname: text(model.nickname, 80) ?? text(model.id, 120) ?? '' },
    status: v.status as LabRunStatus,
    res: text(v.res, 8) ?? null,
    aspect: text(v.aspect, 8) ?? null,
    quotedUsd,
    costUsd: num(v.costUsd) ?? null,
    ...(quoteBasis ? { quoteBasis } : {}),
    facts: asFacts(v.facts),
    ...(imageUrl && HTTPS_URL.test(imageUrl) ? { imageUrl } : {}),
    createdAt: text(v.createdAt, 40) ?? '',
    finishedAt: text(v.finishedAt, 40) ?? null
  };
};

const asBlindRun = (v: unknown): LabBlindRun | undefined => {
  if (!isObject(v) || v.checkId !== 'D4' || !RUN_STATUSES.has(String(v.status))) return undefined;
  const id = text(v.id, 64);
  const pair = asPair(v.pair);
  const quotedUsd = num(v.quotedUsd);
  if (!id || !pair || quotedUsd === undefined) return undefined;
  return { id, checkId: 'D4', itemId: text(v.itemId, 80) ?? '', status: v.status as LabRunStatus, pair, quotedUsd, costUsd: num(v.costUsd) ?? null, message: text(v.message, 600) ?? null };
};

const asSide = (v: unknown, slot: 'A' | 'B'): BlindSide | undefined => {
  if (!isObject(v)) return undefined;
  const imageUrl = text(v.imageUrl, 2000);
  const run = asRun(v.run);
  return { slot, ...(imageUrl && HTTPS_URL.test(imageUrl) ? { imageUrl } : {}), ...(run ? { run } : {}) };
};

export const asBlindPair = (v: unknown): BlindPair | undefined => {
  if (!isObject(v)) return undefined;
  const id = text(v.id, 60);
  const label = text(v.label, 80);
  const state = v.state === 'ready' || v.state === 'voted' ? v.state : v.state === 'waiting' ? 'waiting' : undefined;
  if (!id || !label || !state) return undefined;
  const pick = v.pick === 'A' || v.pick === 'B' || v.pick === 'tie' ? v.pick : undefined;
  const a = asSide(v.a, 'A');
  const b = asSide(v.b, 'B');
  // Names never reach a pair before the vote, even if a server sent them.
  const blind = (s?: BlindSide) => (s && state !== 'voted' ? { slot: s.slot, ...(s.imageUrl ? { imageUrl: s.imageUrl } : {}) } : s);
  return {
    id,
    label,
    state,
    ...(Array.isArray(v.waitingFor) ? { waitingFor: v.waitingFor.map((w) => text(w, 80)).filter((w): w is string => !!w) } : {}),
    ...(a ? { a: blind(a) } : {}),
    ...(b ? { b: blind(b) } : {}),
    ...(pick ? { pick } : {})
  };
};

export const asOverview = (v: unknown): LabOverview | null => {
  if (!isObject(v) || !Array.isArray(v.checks)) return null;
  const capUsd = num(v.capUsd);
  const spentUsd = num(v.spentUsd);
  if (capUsd === undefined || spentUsd === undefined) return null;
  const ready = isObject(v.ready) ? v.ready : {};
  return {
    capUsd,
    day: text(v.day, 10) ?? '',
    spentUsd,
    remainingUsd: num(v.remainingUsd) ?? Math.max(0, capUsd - spentUsd),
    ready: { platformKey: ready.platformKey === true, storage: ready.storage === true },
    checks: v.checks
      .map((c): LabCheck | undefined => {
        if (!isObject(c) || !CHECKS.has(String(c.id))) return undefined;
        const note = text(c.note, 600);
        return {
          id: c.id as LabCheckId,
          title: text(c.title, 160) ?? String(c.id),
          decision: text(c.decision, 600) ?? '',
          answers: text(c.answers, 600) ?? '',
          ...(note ? { note } : {}),
          items: Array.isArray(c.items) ? c.items.map(asItem).filter((i): i is LabItem => !!i) : []
        };
      })
      .filter((c): c is LabCheck => !!c),
    results: Array.isArray(v.results) ? v.results.map(asRun).filter((r): r is LabRun => !!r) : [],
    blind: Array.isArray(v.blind) ? v.blind.map(asBlindPair).filter((p): p is BlindPair => !!p) : [],
    now: num(v.now) ?? Date.now()
  };
};

// ── Errors ───────────────────────────────────────────────────────────────────

/** A lab refusal or failure: the server's honest copy, its code, and whatever facts came with it. */
export class LabApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'LabApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /**
   * The request may never have reached the server (or its answer was lost): retrying the SAME click is safe. A gateway
   * 502/504/524 carries no lab code; the lab's own 503 refusals (PROVIDER_DOWN, NO_PLATFORM_KEY, NO_STORAGE) do, and
   * nothing was sent for them, so they are answers, not lost requests.
   */
  get unreached(): boolean {
    return this.status === 0 || (this.status >= 502 && !this.code);
  }
}

const toLabError = (err: unknown): LabApiError => {
  if (err instanceof LabApiError) return err;
  if (err instanceof ApiError) {
    const details = isObject(err.details) ? err.details : undefined;
    const code = text(details?.code, 40) ?? (isObject(details?.error) ? text((details!.error as Record<string, unknown>).code, 40) : undefined);
    if (err.status === 0) return new LabApiError("Couldn't reach the server. Trying again sends the same click, so it can't be charged twice.", 0, code, details);
    return new LabApiError(err.message || 'The Model Lab answered with an error.', err.status, code, details);
  }
  if ((err as { name?: unknown })?.name === 'AbortError') return new LabApiError('Stopped.', 499, 'ABORTED');
  return new LabApiError('Something went wrong talking to the server. Try again in a moment.', 0);
};

// ── Calls ────────────────────────────────────────────────────────────────────

export async function fetchLabOverview(opts: { signal?: AbortSignal } = {}): Promise<LabOverview> {
  try {
    const out = asOverview(await get<unknown>(MODEL_LAB_PATH, { signal: opts.signal }));
    if (!out) throw new LabApiError("The Model Lab's answer couldn't be read.", 502);
    return out;
  } catch (err) {
    throw toLabError(err);
  }
}

/** The ONE place a paid lab call is requested: always with ack, the confirmed quote and this click's key. */
export async function runLabCheck(input: { itemId: string; idempotencyKey: string; quotedUsd: number }): Promise<LabRunAnswer> {
  try {
    const res = await post<unknown, unknown>(`${MODEL_LAB_PATH}/runs`, { itemId: input.itemId, idempotencyKey: input.idempotencyKey, ack: true, quotedUsd: input.quotedUsd });
    const r = isObject(res) ? res : {};
    const run = (isObject(r.run) && r.run.checkId === 'D4' ? asBlindRun(r.run) : asRun(r.run)) ?? null;
    if (!run) throw new LabApiError("The run finished but its answer couldn't be read. Refresh the lab to see it.", 502);
    return { replayed: r.replayed === true, run, spentUsd: num(r.spentUsd) ?? 0, remainingUsd: num(r.remainingUsd) ?? 0 };
  } catch (err) {
    throw toLabError(err);
  }
}

export async function setLabWatermark(runId: string, visible: boolean | null): Promise<LabRun> {
  try {
    const run = asRun(await post<unknown, unknown>(`${MODEL_LAB_PATH}/runs/${encodeURIComponent(runId)}/watermark`, { visible }));
    if (!run) throw new LabApiError("The answer couldn't be read. Refresh the lab.", 502);
    return run;
  } catch (err) {
    throw toLabError(err);
  }
}

export async function voteBlindPair(pairId: string, pick: BlindPick): Promise<BlindPair> {
  try {
    const pair = asBlindPair(await post<unknown, unknown>(`${MODEL_LAB_PATH}/blind/${encodeURIComponent(pairId)}/vote`, { pick }));
    if (!pair) throw new LabApiError("The vote was sent but its answer couldn't be read. Refresh the lab.", 502);
    return pair;
  } catch (err) {
    throw toLabError(err);
  }
}

// ── Small pure helpers ───────────────────────────────────────────────────────

/** One id per click (the server's idempotency key): 32 random hex characters. */
export const newClickId = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `lab-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

/** Dollars for the admin view: cents at $1 and up, else up to 4 decimals ($0.113, $0.0184). */
export const formatLabUsd = (usd: number | null | undefined): string => {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  if (Math.abs(usd) >= 1) return `$${usd.toFixed(2)}`;
  return `$${String(Math.round(usd * 10_000) / 10_000)}`;
};

export const formatBytes = (n?: number): string | undefined => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
};

export const formatSeconds = (ms?: number): string | undefined =>
  typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : undefined;
