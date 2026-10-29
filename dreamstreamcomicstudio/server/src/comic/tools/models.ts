// Director tool group "models" (models.md §3.8, §2.4 R5, §3.6 copy; reliability.md §2 "Director").
// Owner: M1-DIRECTOR-MODELS.
//
//   model_options  FREE  {want?, model?} — up to 3 fit-sorted image-model options for THIS comic, every number
//                         from M1-CATALOG (the live PriceBook and catalog rows): price per page, characters held,
//                         providers and uptime, leaderboard ranks with dates, the cost to redraw what is drawn, why
//                         a model does not fit; plus the same-model cheaper tier and the current model. Read-only.
//   suggest_model  FREE  {model?, tier?} — a chip, never a change: "See models" opens the picker (a change needs the
//                         user's confirm there, §3.6 C/D), or a cheaper tier for NEW pages on the same model (the
//                         user's own tap; §3.6 E: same model, drawn pages keep their resolution).
//
// Neither tool can change the comic. The group is offered when the turn is about models, prices, quality or a
// provider problem, and on its own when the studio may suggest without being asked (§3.8): a page holds more
// characters than the model keeps on model, ≥ 3 upstream failures in 10 min (R5), or the locked model is no longer
// usable. The director (director.ts) adds the model facts to the DOC SUMMARY (modelFactLines), words a reply from
// the advice when the model wrote none (modelAdviceReply), and checks the reply never claims a switch or a start
// that did not happen (guardModelReply).

import { isPageStale, type Card, type ComicDoc, type NextStep, type QualityTier, type RenderState, type RenderTarget, type Resolution } from '../../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import { IMAGE_MODELS, TIER_PRESETS, estimateJobs, getImageModel, resolveImageJob, type ImageJobKind, type ImageModelSpec, type ImageRoute } from '../../../../shared/comic/models.js';
import { deriveLock, drawnTargets, modelFit, redrawQuote, redrawResolution, type DrawnTargets } from '../../../../shared/comic/modelLock.js';
import type { HealthState, ModelHealth, OutageOption } from '../../../../shared/comic/modelHealth.js';
import type { ModelCatalogRow, QualityBoard } from '../../../../shared/comic/modelCatalog.js';
import { logger } from '../../lib/logger.js';
import { costFormatterFor, type CostFormatter } from '../costText.js';
import { defineTool, toolArgError, type DirectorTool, type ToolGroup, type ToolGroupId } from '../extensions.js';
import { imageRouteFor, spendIsByok } from '../jobs.js';
import { createPriceBook, modelCatalog, type QuoteBasis, type ServerPriceBook } from '../models/index.js';
import { alternateRouteFor, isUpstreamFailureCode, modelHealth, primaryRouteFor, type ModelHealthPort } from '../models/health.js';
import { joinList, retryNextSteps, sentencesOf } from '../replies.js';
import { pushNextSteps, type DirectorTurn } from '../tools.js';
import type { StudioContext, StudioKeys } from '../types.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** R5 (models.md §2.4): this many upstream failures in a row, inside R5_WINDOW_MS, and the director may suggest. */
export const R5_FAILURES = 3;
export const R5_WINDOW_MS = 10 * 60_000;
/** A model_outage card this recent (and no image drawn since) still describes the model. */
export const OUTAGE_RECENT_MS = 30 * 60_000;
const OUTAGE_RECENT_MESSAGES = 6;
/** How long a director turn waits for the live health read before it words the status from what it holds. */
export const HEALTH_WAIT_MS = 1_500;
/** Upper bound for the catalog read in model_options (the catalog bounds its own refresh at 8 s). */
export const CATALOG_WAIT_MS = 9_000;
/** model_options returns at most this many other models (models.md §3.8). */
export const MAX_MODEL_OPTIONS = 3;

export const MODEL_WANTS = ['other', 'cheaper', 'better', 'characters', 'specific'] as const;
export type ModelWant = (typeof MODEL_WANTS)[number];

const TIERS: QualityTier[] = ['draft', 'standard', 'pro'];

/** Words that make the group relevant to this turn (the group stays out of the 30-tool budget otherwise). */
export const MODEL_HINT_RE =
  /\b(?:(?:image|ai|art|drawing) )?models?\b|\b(?:gpt|openai|dall-?e|chatgpt|gemini|nano ?banana|imagen|flux|seedream|bytedance|midjourney|stable diffusion)\b|\b(?:cheaper|cheapest|less expensive|too expensive|costs? less|lower (?:the )?(?:price|cost)|save (?:money|credits)|better (?:quality|images?|art|pictures?|faces?)|higher quality|best quality|sharper|consisten\w*|rate[- ]?limit\w*|throttl\w*|outage|providers?)\b/i;

/** The user asks about a problem (status line even when nothing is known to be wrong). */
const STATUS_ASK_RE = /\b(?:down|busy|slow|stuck|broken|outage|status|rate[- ]?limit\w*|429|throttl\w*|fail\w*|errors?|not working|what happened|why (?:did|didn'?t|is|isn'?t|does|doesn'?t))\b/i;

const BOARD_LABEL: Record<QualityBoard, string> = {
  lmarena_t2i: 'LMArena text-to-image',
  lmarena_edit: 'LMArena edit',
  lmarena_multi_image: 'LMArena multi-image',
  aa_t2i: 'AA text-to-image',
  aa_edit: 'AA edit',
  design_arena: 'Design Arena'
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const lower1 = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** Settle within `ms` or reject (the work itself keeps its own bounds; nothing is scheduled beyond this wait). */
const within = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    (timer as { unref?: () => void }).unref?.();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });

// ── The comic's model ────────────────────────────────────────────────────────

export interface CurrentModel {
  spec: ImageModelSpec;
  /** What the user reads: the nickname, or the locked id when the registry no longer knows it. */
  name: string;
  /** The model is fixed for this comic (models.md §3.2: persisted, or derived from a legacy doc's assets). */
  locked: boolean;
  /** The resolution new pages draw at. */
  res: Resolution;
  /** The comic's model id: the lock's (even one the registry no longer knows), else the tier's. */
  id: string;
  /**
   * false when the lock names a model the registry no longer has: `spec` is then only the tier's stand-in that
   * resolveImageJob falls back to — never describe the comic's model with its price, characters, id or status.
   */
  known: boolean;
}

/** The model new pages draw on: the lock when there is one (every tier), else the tier / pre-lock override. */
export const currentImageModel = (doc: ComicDoc): CurrentModel => {
  const lock = deriveLock(doc);
  const job = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride, lock);
  const known = !lock || getImageModel(lock.modelId)?.id === job.spec.id;
  return { spec: job.spec, name: known ? job.spec.nickname : lock!.modelId, locked: !!lock, res: job.resolution, id: known ? job.spec.id : lock!.modelId, known };
};

/** A page the next drawing would (re)draw: not drawn yet, failed, or out of date. A drawn, current page was the user's call. */
const pendingPage = (doc: ComicDoc, p: ComicDoc['pages'][number]): boolean => p.render.status !== 'ready' || isPageStale(doc, p);

/**
 * The page with the most distinct cast above what `spec` keeps on model per image (models.md §3.8 trigger 1).
 * `pending`: only pages still to be drawn, so the studio does not bring it up again on every turn of a finished book.
 */
export const crowdedPage = (doc: ComicDoc, spec: ImageModelSpec, opts: { pending?: boolean } = {}): { n: number; count: number } | null => {
  const holds = spec.refs.characters;
  if (!(holds > 0)) return null;
  let worst: { n: number; count: number } | null = null;
  for (const p of doc.pages) {
    if (opts.pending && !pendingPage(doc, p)) continue;
    const count = new Set(p.panels.flatMap((pn) => pn.castIds)).size;
    if (count > holds && (!worst || count > worst.count)) worst = { n: p.n, count };
  }
  return worst;
};

/** Every render target of the doc with its state (pages, cover, sheets, places, style swatches). */
const renderStates = (doc: ComicDoc): { target: RenderTarget; render: RenderState }[] => [
  ...doc.pages.map((p) => ({ target: { kind: 'page' as const, id: p.id }, render: p.render })),
  { target: { kind: 'cover' as const }, render: doc.cover.render },
  ...doc.cast.map((c) => ({ target: { kind: 'sheet' as const, id: c.id }, render: c.sheet })),
  ...doc.places.map((p) => ({ target: { kind: 'place' as const, id: p.id }, render: p.sheet })),
  ...doc.style.options.map((o) => ({ target: { kind: 'style_option' as const, id: o.id }, render: o.render }))
];

/** How many drawn pages were drawn at one resolution (null = no record of it). */
export interface ResCount {
  res: Resolution | null;
  n: number;
}

const RES_ORDER: Resolution[] = ['4K', '2K', '1K', '512'];

/** The resolution a render was drawn at: its own record (VersionMeta.resolution), else its pixel size (long edge). */
const resOfRender = (r: RenderState): Resolution | null => {
  if (r.resolution && RES_ORDER.includes(r.resolution)) return r.resolution;
  const dims = [r.asset?.w, r.asset?.h].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (!dims.length) return null;
  const long = Math.max(...dims);
  return long <= 768 ? '512' : long <= 1600 ? '1K' : long <= 3200 ? '2K' : '4K';
};

/** The comic's drawn (generated) pages grouped by the resolution each was really drawn at, sharpest first. */
export const drawnPageResolutions = (doc: ComicDoc): ResCount[] => {
  const drawn = new Set(drawnTargets(doc).pages);
  const counts = new Map<Resolution | null, number>();
  for (const p of doc.pages) {
    if (!drawn.has(p.id)) continue;
    const res = resOfRender(p.render);
    counts.set(res, (counts.get(res) || 0) + 1);
  }
  const rank = (r: Resolution | null) => (r === null ? RES_ORDER.length : RES_ORDER.indexOf(r));
  return [...counts.entries()].map(([res, n]) => ({ res, n })).sort((a, b) => rank(a.res) - rank(b.res));
};

export interface UpstreamStreak {
  /** Upstream failures (429 / 5xx / timeout) since the last image that drew, inside R5_WINDOW_MS. */
  count: number;
  code?: string;
  provider?: string;
  at?: number;
  /** The provider's own words from the newest failure (render.errorDetail.text). */
  text?: string;
  targets: RenderTarget[];
}

/** R5 from this comic's own renders: consecutive upstream failures (render.errorDetail) in the last 10 minutes. */
export const upstreamStreak = (doc: ComicDoc, now = Date.now()): UpstreamStreak => {
  const events: { at: number; ok: boolean; target: RenderTarget; render: RenderState }[] = [];
  for (const { target, render } of renderStates(doc)) {
    const d = render.errorDetail;
    if (render.status === 'failed' && d && isUpstreamFailureCode(d.code) && now - d.at <= R5_WINDOW_MS && d.at <= now + 60_000) {
      events.push({ at: d.at, ok: false, target, render });
    } else if (render.status === 'ready' && typeof render.updatedAt === 'number' && now - render.updatedAt <= R5_WINDOW_MS) {
      events.push({ at: render.updatedAt, ok: true, target, render });
    }
  }
  events.sort((a, b) => a.at - b.at);
  let lastOk = -1;
  events.forEach((e, i) => {
    if (e.ok) lastOk = i;
  });
  const fails = events.slice(lastOk + 1).filter((e) => !e.ok);
  const latest = fails[fails.length - 1]?.render.errorDetail;
  return {
    count: fails.length,
    ...(latest ? { code: latest.code, at: latest.at, text: latest.text, ...(latest.provider ? { provider: latest.provider } : {}) } : {}),
    targets: fails.map((f) => f.target)
  };
};

export type OutageCard = Extract<Card, { type: 'model_outage' }>;

/** The newest image that drew (any target), for "is that outage still the latest news?". */
const lastDrawnAt = (doc: ComicDoc): number =>
  renderStates(doc).reduce((at, { render }) => (render.status === 'ready' && typeof render.updatedAt === 'number' ? Math.max(at, render.updatedAt) : at), 0);

/** The latest model_outage card among the last messages, unless it is old or an image drew after it. */
export const recentOutageCard = (doc: ComicDoc, now = Date.now()): { card: OutageCard; at: number } | null => {
  const conv = doc.conversation;
  for (let i = conv.length - 1; i >= Math.max(0, conv.length - OUTAGE_RECENT_MESSAGES); i -= 1) {
    const m = conv[i];
    const card = m.role === 'assistant' ? (m.cards || []).find((c): c is OutageCard => c.type === 'model_outage') : undefined;
    if (!card) continue;
    if (now - m.at > OUTAGE_RECENT_MS || lastDrawnAt(doc) > m.at) return null;
    return { card, at: m.at };
  }
  return null;
};

/** Why the locked model can no longer draw this comic (§3.8 trigger 3), or ''. */
export const lockUnusable = (doc: ComicDoc, caps: StudioCaps = DEFAULT_CAPS): string => {
  const lock = deriveLock(doc);
  if (!lock) return '';
  const spec = getImageModel(lock.modelId);
  if (!spec) return 'is no longer offered by the studio';
  if (spec.lifecycle === 'deprecated') return 'is deprecated by its vendor';
  const blocks = modelFit(spec, doc, caps).filter((f) => f.severity === 'block' && (f.code === 'access' || f.code === 'transport'));
  return blocks.length ? `can't draw for this account (${lower1(blocks[0].text)})` : '';
};

/** The routes a run of `spec` can take with these keys (exactly what the preflight and imageClient may use). */
const reachableRoutes = (spec: ImageModelSpec, keys: StudioKeys): { route: ImageRoute; model: string }[] => {
  const primary = primaryRouteFor(spec, keys);
  if (!primary) return [];
  const alt = alternateRouteFor(spec, keys, primary);
  return [{ route: primary.route, model: primary.model }, ...(alt ? [{ route: alt.route, model: alt.model }] : [])];
};

// ── Model names ──────────────────────────────────────────────────────────────

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\s+/g, ' ').trim();

const MODEL_ALIASES: [RegExp, string][] = [
  [/\bflare\b/, 'gpt-image-2.5-flare'],
  [/\b(?:gpt|openai|chatgpt|dall ?e|sunburst)\b/, 'gpt-image-2.5'],
  [/\b(?:seedream|bytedance)\b/, 'seedream-5-pro'],
  [/\bflux\b/, 'flux-3'],
  [/\b(?:nano ?banana|gemini|banana)\b.*\bpro\b|\bpro\b.*\b(?:nano ?banana|gemini)\b/, 'nano-banana-pro'],
  [/\b(?:nano ?banana|gemini)\b.*\blite\b/, 'nano-banana-lite'],
  [/\b(?:nano ?banana|gemini|banana)\b/, 'nano-banana-2.1']
];

const BY_NAME_LENGTH = [...IMAGE_MODELS].sort((a, b) => b.nickname.length - a.nickname.length);

/** A registry model from what the user or the model called it ("GPT image", "nano banana pro", an id). */
export const resolveModelName = (raw: unknown): ImageModelSpec | undefined => {
  if (typeof raw !== 'string') return undefined;
  const direct = getImageModel(raw.trim());
  if (direct) return direct;
  const q = ` ${normName(raw)} `;
  if (!q.trim()) return undefined;
  for (const m of BY_NAME_LENGTH) {
    for (const name of [m.nickname, m.label, m.id.replace(/-/g, ' ')]) {
      const n = normName(name);
      if (n && q.includes(` ${n} `)) return m;
    }
  }
  for (const [re, id] of MODEL_ALIASES) if (re.test(q)) return getImageModel(id);
  return undefined;
};

// ── Facts per model ──────────────────────────────────────────────────────────

export interface ModelOptionFacts {
  id: string;
  nickname: string;
  /** The resolution it would draw this comic's pages at. */
  res: Resolution;
  /** What one page costs this user (unit + QC, × markup unless the key that draws it is their own). null = no basis. */
  perPageUsd: number | null;
  basis?: QuoteBasis;
  characters: number;
  /** "1 provider · 97.7% up (24 h)", or null when the catalog has no endpoint data. */
  providers: string | null;
  /** "LMArena edit #5 (2026-10-20) · AA edit #4 (2026-10-22)", or null when no public board ranks it. */
  ranks: string | null;
  /** Best edit rank we hold (LMArena edit, else AA edit), for "better" comparisons. */
  editRank?: number;
  /** Redraw what is drawn, to match: drawn pages + cover / everything (null = can't price yet). */
  redrawPagesCoverUsd: number | null;
  redrawAllUsd: number | null;
  blocks: string[];
  warns: string[];
  sameFamily: boolean;
  /** The comic's locked model is no longer in the registry: no price, characters or status are known for it. */
  unknown?: boolean;
}

export interface TierFacts {
  tier: QualityTier;
  label: string;
  res: Resolution;
  perPageUsd: number;
  currentRes: Resolution;
  currentPerPageUsd: number;
}

export interface ModelAdvice {
  want: ModelWant;
  current: ModelOptionFacts;
  currentName: string;
  locked: boolean;
  named?: ModelOptionFacts;
  /** The user named the model the comic is already on. */
  namedIsCurrent?: boolean;
  options: ModelOptionFacts[];
  tier?: TierFacts;
  crowd?: { n: number; count: number };
  drawn: DrawnTargets;
  /** The drawn pages by the resolution each was drawn at (what a tier change leaves as it is, §3.6 E). */
  drawnRes: ResCount[];
  streak: UpstreamStreak;
  outage?: OutageCard;
  /** The live catalog answered (else prices are the dated registry list and uptime/ranks are unknown). */
  live: boolean;
}

const adviceByTurn = new WeakMap<DirectorTurn, ModelAdvice>();

/** What model_options found this turn (director.ts words a reply from it when the model wrote none). */
export const modelAdviceOf = (turn: DirectorTurn): ModelAdvice | undefined => adviceByTurn.get(turn);

const byokFor = (spec: ImageModelSpec, keys: StudioKeys): boolean => {
  try {
    return imageRouteFor(spec, keys)?.byok ?? spendIsByok(keys);
  } catch {
    return spendIsByok(keys);
  }
};

const pageRes = (doc: ComicDoc, spec: ImageModelSpec): Resolution => (spec.resolutions.length ? redrawResolution(doc, spec.id, 'page') : '1K');

const rankFacts = (row?: ModelCatalogRow): { text: string | null; editRank?: number } => {
  const ranked = (row?.quality || []).filter((q) => typeof q.rank === 'number');
  const lm = ranked.find((q) => q.board === 'lmarena_edit');
  const aa = ranked.find((q) => q.board === 'aa_edit');
  const picks = [lm, aa].filter((q): q is NonNullable<typeof q> => !!q);
  if (!picks.length && ranked[0]) picks.push(ranked[0]);
  const text = picks.map((q) => `${BOARD_LABEL[q.board] ?? q.board} #${q.rank} (${q.asOf.slice(0, 10)})`).join(' · ');
  return { text: text || null, ...(lm?.rank !== undefined || aa?.rank !== undefined ? { editRank: (lm?.rank ?? aa?.rank) as number } : {}) };
};

const providerFacts = (row?: ModelCatalogRow): string | null => {
  const eps = row?.endpoints || [];
  if (!eps.length) return null;
  const ups = eps.map((e) => e.uptime1d).filter((u): u is number => typeof u === 'number' && Number.isFinite(u));
  const up = ups.length ? `${(Math.round(Math.max(...ups) * 10) / 10).toString()}% up (24 h)` : 'uptime unknown';
  return `${plural(eps.length, 'provider')} · ${up}`;
};

function optionFacts(
  spec: ImageModelSpec,
  i: { doc: ComicDoc; caps: StudioCaps; prices: ServerPriceBook; keys: StudioKeys; row?: ModelCatalogRow; current: { id: string; vendor?: string } }
): ModelOptionFacts {
  const byok = byokFor(spec, i.keys);
  const res = pageRes(i.doc, spec);
  let perPageUsd: number | null = null;
  let basis: QuoteBasis | undefined;
  try {
    const q = i.prices.jobQuote(spec.id, res, 'page', { byok });
    perPageUsd = typeof q.usd === 'number' && Number.isFinite(q.usd) ? q.usd : null;
    basis = q.basisDetail;
  } catch (err) {
    logger.warn('comic_model_options_quote_failed', { model: spec.id, message: (err as Error)?.message });
  }
  const redraw = (scope: 'pages_cover' | 'all'): number | null => {
    try {
      const usd = redrawQuote(i.doc, spec.id, scope, i.prices, byok).usd;
      return typeof usd === 'number' && Number.isFinite(usd) ? usd : null;
    } catch {
      return null;
    }
  };
  let fit = i.row?.fit;
  if (!fit) {
    try {
      fit = modelFit(spec, i.doc, i.caps, i.prices);
    } catch {
      fit = [];
    }
  }
  const ranks = rankFacts(i.row);
  return {
    id: spec.id,
    nickname: spec.nickname,
    res,
    perPageUsd,
    ...(basis ? { basis } : {}),
    characters: spec.refs.characters,
    providers: providerFacts(i.row),
    ranks: ranks.text,
    ...(ranks.editRank !== undefined ? { editRank: ranks.editRank } : {}),
    redrawPagesCoverUsd: spec.id === i.current.id ? 0 : redraw('pages_cover'),
    redrawAllUsd: spec.id === i.current.id ? 0 : redraw('all'),
    blocks: [...new Set(fit.filter((f) => f.severity === 'block').map((f) => f.text))],
    warns: [...new Set(fit.filter((f) => f.severity === 'warn').map((f) => f.text))],
    sameFamily: spec.vendor === i.current.vendor
  };
}

async function catalogRows(ctx: StudioContext, doc: ComicDoc, caps: StudioCaps): Promise<ModelCatalogRow[] | null> {
  try {
    return await within(modelCatalog().rows({ userId: ctx.userId, doc, caps }), CATALOG_WAIT_MS);
  } catch (err) {
    logger.warn('comic_model_options_catalog_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    return null;
  }
}

/** The cheapest lower tier that keeps the SAME model and draws new pages for less (models.md §3.6 E). */
function cheaperTier(doc: ComicDoc, cur: CurrentModel, current: ModelOptionFacts, prices: ServerPriceBook, keys: StudioKeys): TierFacts | undefined {
  const lock = deriveLock(doc);
  const at = TIERS.indexOf(doc.settings.quality);
  if (current.perPageUsd === null) return undefined;
  const byok = byokFor(cur.spec, keys);
  for (const tier of TIERS.slice(0, Math.max(0, at))) {
    const job = resolveImageJob('page', tier, doc.settings.imageModelOverride, lock);
    if (job.spec.id !== cur.spec.id || job.resolution === cur.res) continue;
    try {
      const usd = prices.jobQuote(cur.spec.id, job.resolution, 'page', { byok }).usd;
      if (typeof usd === 'number' && Number.isFinite(usd) && usd < current.perPageUsd) {
        return { tier, label: TIER_PRESETS[tier].label, res: job.resolution, perPageUsd: usd, currentRes: cur.res, currentPerPageUsd: current.perPageUsd };
      }
    } catch {
      /* no price → no offer (never a guessed number) */
    }
  }
  return undefined;
}

/** model_options' work: real numbers for the current model, the named one and up to 3 options (never throws). */
export async function buildModelAdvice(ctx: StudioContext, input: { want: ModelWant; named?: ImageModelSpec; now?: number }): Promise<ModelAdvice> {
  const doc = ctx.session.doc;
  const caps = ctx.caps ?? DEFAULT_CAPS;
  const cur = currentImageModel(doc);
  const [rows, prices] = await Promise.all([catalogRows(ctx, doc, caps), createPriceBook({ userId: ctx.userId })]);
  const rowOf = (id: string) => rows?.find((r) => r.id === id);
  const curRef = cur.known ? { id: cur.spec.id, vendor: cur.spec.vendor } : { id: cur.id };
  const factsOf = (spec: ImageModelSpec) => optionFacts(spec, { doc, caps, prices, keys: ctx.keys, row: rowOf(spec.id), current: curRef });
  // A lock the registry no longer knows: the tier's stand-in is never described as the comic's model.
  const current: ModelOptionFacts = cur.known
    ? factsOf(cur.spec)
    : { id: cur.id, nickname: cur.name, res: cur.res, perPageUsd: null, characters: 0, providers: null, ranks: null, redrawPagesCoverUsd: 0, redrawAllUsd: 0, blocks: [], warns: [], sameFamily: true, unknown: true };

  // Fit-sorted (the catalog's order: blocks last, then quality, price, resilience); registry order without it.
  const ordered = (rows ? rows.map((r) => getImageModel(r.id)) : IMAGE_MODELS).filter((s): s is ImageModelSpec => !!s);
  const pool = ordered.filter((s) => s.pickable && s.id !== cur.id && s.id !== input.named?.id).map(factsOf);
  const fits = (f: ModelOptionFacts) => !f.blocks.length;
  const price = (f: ModelOptionFacts) => f.perPageUsd ?? Number.POSITIVE_INFINITY;
  let options: ModelOptionFacts[];
  switch (input.want) {
    case 'cheaper':
      // An unlisted current model has no price to beat: the fitting models by price, each with its real number.
      options = pool.filter((f) => fits(f) && f.perPageUsd !== null && (current.unknown || (current.perPageUsd !== null && f.perPageUsd < current.perPageUsd))).sort((a, b) => price(a) - price(b));
      break;
    case 'characters':
      options = pool.filter((f) => fits(f) && f.characters > current.characters).sort((a, b) => price(a) - price(b));
      break;
    case 'better':
      options = pool.filter((f) => fits(f) && f.editRank !== undefined && (current.editRank === undefined || f.editRank < current.editRank));
      break;
    default:
      options = [...pool.filter(fits), ...pool.filter((f) => !fits(f))];
  }
  const named = input.named && input.named.id !== cur.id ? factsOf(input.named) : undefined;
  const namedIsCurrent = !!input.named && input.named.id === cur.id;
  const crowd = cur.known ? crowdedPage(doc, cur.spec) : null;
  const outage = recentOutageCard(doc, input.now ?? Date.now());
  return {
    want: input.want,
    current,
    currentName: cur.name,
    locked: cur.locked,
    ...(named ? { named } : {}),
    ...(namedIsCurrent ? { namedIsCurrent } : {}),
    options: options.slice(0, named ? MAX_MODEL_OPTIONS - 1 : MAX_MODEL_OPTIONS),
    ...((tier) => (tier ? { tier } : {}))(input.want === 'cheaper' ? cheaperTier(doc, cur, current, prices, ctx.keys) : undefined),
    ...(crowd ? { crowd } : {}),
    drawn: drawnTargets(doc),
    drawnRes: drawnPageResolutions(doc),
    streak: upstreamStreak(doc, input.now ?? Date.now()),
    ...(outage ? { outage: outage.card } : {}),
    live: !!rows
  };
}

// ── Words ────────────────────────────────────────────────────────────────────

const CODE_WORDS: Record<string, string> = { RATE_LIMIT: '429', TIMEOUT: 'timed out', PROVIDER_ERROR: 'provider error', NETWORK: 'network error', UPSTREAM: 'upstream error' };

/** A failure code in words ("429", "timed out"): never the studio's internal code (RATE_LIMIT) in what anyone reads. */
export const failureCodeWords = (code?: string): string => {
  const c = (code || '').trim();
  if (!c) return '';
  if (/^\d{3}$/.test(c)) return c;
  return CODE_WORDS[c.toUpperCase()] ?? 'upstream error';
};

/** "OpenRouter · 429" (models.md §3.6 G detail: who answered, then what). */
const streakDetail = (st: Pick<UpstreamStreak, 'provider' | 'code'>): string => [st.provider, failureCodeWords(st.code)].filter(Boolean).join(' · ');

/** "your last 4 pages" / "OpenRouter list price" / "price list from 2026-10-22" — never a dollar figure. */
const basisWords = (b?: QuoteBasis): string => {
  if (!b) return 'no price basis';
  if (b.source === 'observed') return b.scope === 'platform' ? `${b.n ?? 'recent'} recent DreamStream pages` : `your last ${b.n ?? ''} pages`.replace('  ', ' ');
  if (b.source === 'list') return 'OpenRouter list price';
  if (b.source === 'registry') return `price list from ${b.factsAsOf ?? 'our registry'}`;
  return 'no price yet';
};

const drawnWords = (d: DrawnTargets): string =>
  joinList([d.pages.length ? plural(d.pages.length, 'page') : '', d.sheets.length ? plural(d.sheets.length, 'character sheet') : '', d.places.length ? plural(d.places.length, 'place sheet') : '', d.cover ? 'the cover' : ''].filter(Boolean));

const drawnCount = (d: DrawnTargets) => d.pages.length + d.sheets.length + d.places.length + (d.cover ? 1 : 0);

/**
 * What a cheaper tier leaves as it is (§3.6 E with real per-page data): the drawn pages keep the resolution each was
 * drawn at. `matches` = every drawn page is already at the new resolution.
 */
const drawnStay = (groups: ResCount[], newRes: Resolution): { matches: boolean; reply: string; tool: string } => {
  const total = groups.reduce((n, g) => n + g.n, 0);
  if (!total) return { matches: false, reply: '', tool: ' nothing drawn changes.' };
  const one = total === 1;
  const only = groups.length === 1 ? groups[0].res : undefined;
  if (only === newRes) return { matches: true, reply: '', tool: ` the ${plural(total, 'drawn page')} ${one ? 'is' : 'are'} already at ${newRes}, which matches.` };
  if (only) {
    return {
      matches: false,
      reply: ` Your ${plural(total, 'drawn page')} stay${one ? 's' : ''} at ${only} unless you redraw ${one ? 'it' : 'them'}.`,
      tool: ` the ${plural(total, 'page')} already drawn stay${one ? 's' : ''} at ${only} unless redrawn.`
    };
  }
  const list = groups.map((g) => `${g.n} at ${g.res ?? 'an unrecorded size'}`).join(', ');
  return {
    matches: false,
    reply: ` Your ${plural(total, 'drawn page')} ${groups.length > 1 ? `(${list}) ` : ''}stay${one ? 's' : ''} as ${one ? 'it is' : 'they are'} unless you redraw ${one ? 'it' : 'them'}.`,
    tool: ` the ${plural(total, 'page')} already drawn keep${one ? 's its' : ' their'} resolution unless redrawn${groups.length > 1 ? ` (${list})` : ''}.`
  };
};

const priceWords = (usd: number | null, c: CostFormatter): string => (usd === null ? "a price that isn't published yet" : c.approx(usd));

/** One option as the model reads it (every number from the catalog; UNVERIFIED where there is none). */
const describeOption = (o: ModelOptionFacts, drawn: DrawnTargets, c: CostFormatter): string => {
  const parts: string[] = [];
  parts.push(`${o.nickname}${o.blocks.length ? ` — NOT POSSIBLE for this comic: ${o.blocks.join('; ')}` : ''}.`);
  parts.push(
    `${o.perPageUsd === null ? 'Price per page UNVERIFIED (not published)' : `${c.approx(o.perPageUsd)} per page at ${o.res} (${basisWords(o.basis)})`}; holds ${o.characters} characters per image; ${o.providers ?? 'provider uptime unknown'}; ${o.ranks ?? 'not ranked on any public leaderboard (quality UNVERIFIED)'}.`
  );
  if (drawnCount(drawn)) {
    const rq = (usd: number | null) => (usd === null ? "can't price yet (UNVERIFIED)" : c.approx(usd));
    parts.push(`Redraw to match: ${drawn.pages.length || drawn.cover ? `pages + cover ${rq(o.redrawPagesCoverUsd)}; ` : ''}everything ${rq(o.redrawAllUsd)}.`);
  }
  const warns = o.warns.filter((w) => !o.blocks.includes(w));
  if (warns.length) parts.push(`Notes: ${warns.map((w) => (/[.!?]$/.test(w) ? w : `${w}.`)).join(' ')}`);
  parts.push(o.sameFamily ? 'Same family, still a different model: consistency can be affected.' : 'A different model: consistency can be affected.');
  return parts.join(' ');
};

/** The tool result model_options returns (what the director reads). */
export function describeModelAdvice(a: ModelAdvice, c: CostFormatter): string {
  const cur = a.current;
  const lines: string[] = [];
  lines.push(
    cur.unknown
      ? `CURRENT: ${a.currentName} — locked for this comic, but the studio no longer lists this model: its price per page, characters held and provider status are UNVERIFIED (say you don't know them).${drawnCount(a.drawn) ? ` Drawn with it: ${drawnWords(a.drawn)}.` : ''}`
      : `CURRENT: ${a.currentName} — ${a.locked ? 'locked for this comic (every page matches)' : 'not locked yet (it locks at the first comic image)'}; ${cur.perPageUsd === null ? 'price per page UNVERIFIED' : `${c.approx(cur.perPageUsd)} per page at ${cur.res} (${basisWords(cur.basis)})`}; holds ${cur.characters} characters per image; ${cur.providers ?? 'provider uptime unknown'}; ${cur.ranks ?? 'not ranked on any public leaderboard'}.${drawnCount(a.drawn) ? ` Drawn with it: ${drawnWords(a.drawn)}.` : ''}`
  );
  if (a.crowd) lines.push(`PAGE ${a.crowd.n} has ${a.crowd.count} characters; ${a.currentName} keeps up to ${cur.characters} on model per image.`);
  if (a.streak.count >= R5_FAILURES || a.outage) {
    lines.push(
      `RIGHT NOW: ${a.streak.count >= R5_FAILURES ? `${a.streak.count} drawings failed upstream in the last 10 min${streakDetail(a.streak) ? ` (${streakDetail(a.streak)})` : ''}` : `the studio paused ${a.currentName}`}. Suggest waiting first — it's free and the comic stays on ${a.currentName}.`
    );
  }
  if (a.tier) {
    lines.push(
      `SAME MODEL, CHEAPER: ${a.tier.label} draws new pages with ${a.currentName} at ${a.tier.res} for ${c.approx(a.tier.perPageUsd)} per page instead of ${c.approx(a.tier.currentPerPageUsd)} at ${a.tier.currentRes}. Characters stay consistent;${drawnStay(a.drawnRes, a.tier.res).tool} Offer it with suggest_model tier "${a.tier.tier}" (the user taps to confirm).`
    );
  } else if (a.want === 'cheaper') {
    lines.push(
      cur.unknown
        ? `SAME MODEL: ${a.currentName} is no longer listed, so no cheaper setting for it can be priced.`
        : `SAME MODEL: ${a.currentName} is already at its cheapest setting for this comic (${cur.res}).`
    );
  }
  if (a.named) lines.push(`ASKED FOR: ${describeOption(a.named, a.drawn, c)}`);
  if (a.namedIsCurrent) lines.push(`ASKED FOR: ${a.currentName}, which this comic already draws with — nothing to change.`);
  a.options.forEach((o, i) => lines.push(`OPTION ${i + 1}: ${describeOption(o, a.drawn, c)}`));
  if (!a.options.length && !a.named) {
    lines.push(
      a.want === 'cheaper'
        ? cur.unknown
          ? 'No other available model can draw this comic.'
          : 'No other available model draws this comic for less.'
        : a.want === 'better'
          ? `No available model ranks above ${a.currentName} on the public boards we hold.`
          : a.want === 'characters'
            ? `No available model holds more characters than ${a.currentName}.`
            : 'No other model is available for this comic.'
    );
  }
  if (!a.live) lines.push('Live catalog data was unavailable: prices are from the dated price list; uptime and ranks unknown.');
  lines.push(
    `RULES: use only these numbers. Another model draws faces, colors and line work its own way: say character consistency can be affected. Unranked = quality unknown: never say it is as good as ${a.currentName}. Offer the picker with suggest_model. You cannot switch the model; only the user can, after a confirm.`
  );
  return lines.join('\n');
}

const BLOCK_WORDS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Can't draw (.+) pages$/i, (m) => `can't draw ${m[1]} pages`],
  [/^Not available in Comic Studio yet$/i, () => "isn't available in Comic Studio yet"],
  [/^Needs a paid plan or your own key$/i, () => 'needs a paid plan or your own key']
];
const blockWords = (blocks: string[]): string =>
  joinList(
    [
      ...new Set(
        blocks.map((b) => {
          for (const [re, words] of BLOCK_WORDS) {
            const m = b.match(re);
            if (m) return words(m);
          }
          return lower1(b.replace(/\.$/, ''));
        })
      )
    ]
  );

/** "Want to see the options?" chip: the picker, highlighting `suggest`. */
const pickerStep = (label: string, suggest?: string): NextStep => ({ label, client: { type: 'open_model_picker', ...(suggest ? { suggest } : {}) } });

/** A cheaper tier for NEW pages on the same model: the user's own tap (models.md §3.6 E; the reply says the rest). */
const tierStep = (t: TierFacts): NextStep => ({
  label: `Use ${t.label} for new pages`,
  action: { type: 'patch', ops: [{ op: 'settings', patch: { quality: t.tier } }] },
  usd: 0
});

const troubled = (a: Pick<ModelAdvice, 'streak' | 'outage'>) => a.streak.count >= R5_FAILURES || !!a.outage;

/**
 * The studio's own reply from model_options' numbers (models.md §3.8 example), used when the model wrote none,
 * plus the chips that go with it. Every number is the advice's; nothing changes.
 */
export function modelAdviceReply(a: ModelAdvice, c: CostFormatter): { text: string; steps: NextStep[] } {
  const cur = a.current;
  const name = a.currentName;
  const steps: NextStep[] = [];
  const out: string[] = [];
  const consistency = 'Switching models can affect character consistency.';
  const redrawClause = (o: ModelOptionFacts) => {
    if (!a.drawn.pages.length && !a.drawn.cover) return '';
    const what = a.drawn.pages.length ? `your ${plural(a.drawn.pages.length, 'drawn page')}` : 'your cover';
    return o.redrawPagesCoverUsd === null
      ? `, and ${what} would look different unless redrawn (I can't price that redraw yet)`
      : `, and ${what} would look different unless redrawn (${c.approx(o.redrawPagesCoverUsd)}${a.drawn.pages.length && a.drawn.cover ? ' with the cover' : ''})`;
  };
  if (troubled(a)) {
    const limited = /^(?:RATE_LIMIT|429)$/i.test(a.streak.code || '');
    const detail = streakDetail(a.streak);
    const why =
      a.streak.count >= R5_FAILURES
        ? `${name} ${limited ? 'is being rate-limited upstream' : 'keeps failing upstream'} right now (${plural(a.streak.count, 'drawing')} failed in the last 10 minutes${detail ? ` · ${detail}` : ''})`
        : `${name} isn't drawing right now`;
    out.push(`${why}. Your comic stays on ${name} so every page matches — waiting is free, so I'd try again in a minute first.`);
  }
  if (a.want === 'cheaper') {
    if (a.tier) {
      const stay = drawnStay(a.drawnRes, a.tier.res);
      out.push(
        `The cheapest way that keeps your characters consistent is ${a.tier.label}: the same ${name} at ${a.tier.res}${stay.matches ? ', which matches your drawn pages' : ''}, ${c.approx(a.tier.perPageUsd)} a page instead of ${c.approx(a.tier.currentPerPageUsd)} at ${a.tier.currentRes}.${stay.reply}`
      );
      steps.push(tierStep(a.tier));
    } else if (cur.unknown) {
      out.push(`The studio no longer lists ${name}, so I can't price it or a cheaper setting for it.`);
    } else {
      out.push(`You're already on the cheapest setting for ${name} (${cur.res}${cur.perPageUsd !== null ? `, ${c.approx(cur.perPageUsd)} a page` : ''}).`);
    }
    const ranked = a.options.filter((o) => o.ranks);
    const unranked = a.options.filter((o) => !o.ranks);
    if (ranked[0]) out.push(`${ranked[0].nickname} is ${priceWords(ranked[0].perPageUsd, c)} a page, but it's a different model. ${consistency}`);
    if (unranked.length) out.push(`${joinList(unranked.map((o) => o.nickname))} cost${unranked.length === 1 ? 's' : ''} less, but no public leaderboard ranks ${unranked.length === 1 ? 'it' : 'them'}, so I can't vouch for the quality.`);
    if (a.options.length) steps.push(pickerStep('See models'));
    return { text: out.join(' '), steps };
  }
  if (a.namedIsCurrent) {
    out.push(`Your comic already draws with ${name}${cur.perPageUsd !== null ? ` (${c.approx(cur.perPageUsd)} a page at ${cur.res})` : ''}, so nothing needs to change.`);
    return { text: out.join(' '), steps };
  }
  const pick = a.named ?? a.options[0];
  if (!pick) {
    out.push(
      a.want === 'characters'
        ? `No available model holds more characters than ${name}${cur.unknown ? '' : ` (${cur.characters} per image)`}, so it stays.`
        : a.want === 'better'
          ? `No available model ranks above ${name} on the public leaderboards we hold, so it stays.`
          : `${name} is the only model available for this comic right now.`
    );
    return { text: out.join(' '), steps };
  }
  const priceThem = `${priceWords(pick.perPageUsd, c)} a page${pick.perPageUsd !== null ? ` at ${pick.res}` : ''}`;
  const priceUs = cur.perPageUsd !== null ? c.approx(cur.perPageUsd) : null;
  if (troubled(a) && !a.named && !pick.blocks.length && a.want !== 'characters') {
    // R5 / outage: waiting comes first; another model is the alternative, never the advice (§2.4 R5).
    out.push(`If you'd rather not wait, ${pick.nickname} is ${priceWords(pick.perPageUsd, c)} a page${priceUs ? ` instead of ${priceUs}` : ''}${redrawClause(pick)} — ${lower1(consistency)}`);
    steps.push(pickerStep('See other models', pick.id));
    return { text: out.join(' '), steps };
  }
  if (a.want === 'characters' && a.crowd && !a.named) {
    out.push(
      `${name} keeps up to ${cur.characters} characters on model, and page ${a.crowd.n} has ${a.crowd.count}. ${pick.nickname} holds ${pick.characters}. It costs ${priceWords(pick.perPageUsd, c)} a page${priceUs ? ` instead of ${priceUs}` : ''}${redrawClause(pick)}. ${consistency} Want to see the options?`
    );
  } else if (pick.blocks.length) {
    out.push(
      `${pick.nickname} is ${priceThem}${priceUs ? ` (${name} is ${priceUs})` : ''}, but it ${blockWords(pick.blocks)}, so it can't draw this comic. Your comic stays on ${name}; ${lower1(consistency)}${a.options.find((o) => !o.blocks.length) ? ` ${a.options.find((o) => !o.blocks.length)!.nickname} is an option (${priceWords(a.options.find((o) => !o.blocks.length)!.perPageUsd, c)} a page).` : ''} Want to see the options?`
    );
  } else {
    out.push(
      `${pick.nickname} is ${priceThem}${priceUs ? ` instead of ${priceUs}` : ''} and holds ${pick.characters} characters per image${pick.ranks ? ` (${pick.ranks})` : '; no public leaderboard ranks it yet'}${redrawClause(pick)}. ${consistency} Want to see the options?`
    );
  }
  steps.push(pickerStep(troubled(a) ? 'See other models' : 'See models', pick.blocks.length ? a.options.find((o) => !o.blocks.length)?.id : pick.id));
  return { text: out.join(' '), steps };
}

// ── Outages and claims (director reply guards) ───────────────────────────────

const OUTAGE_KIND_WORDS: Record<OutageOption['kind'], string> = {
  wait_and_retry: 'wait and retry',
  other_route: 'the same model on another route',
  switch_model: 'switch model',
  add_key: 'add a key'
};

/** The outage card's options in words, with their real prices (worded for this user). */
export const outageOptionWords = (options: readonly OutageOption[], c: CostFormatter): string[] =>
  options.slice(0, 4).map((o) => {
    if (o.kind === 'wait_and_retry') return `wait and retry (free${o.etaHint ? `, ${o.etaHint}` : ''})`;
    if (o.kind === 'other_route') return `${o.label} (same model)`;
    if (o.kind === 'add_key') return o.label;
    return `${o.nickname} ${c.approx(o.usdPerImage)} per image (redraw ${plural(o.redrawCount, 'image')} ≈ ${c(o.redrawUsd).replace(/^≈\s?/, '')}; ${o.consistency === 'same_family' ? 'same family' : 'a different look'})`;
  });

/** History line for a model_outage card (no prices: the DOC SUMMARY words those for this user). */
export const outageCardText = (card: OutageCard): string => {
  const name = getImageModel(card.modelId)?.nickname ?? card.modelId;
  const what = card.origin === 'preflight' ? 'nothing started, nothing charged' : card.origin === 'mid_run' ? 'a run stopped part-way' : 'not drawing';
  const kinds = [...new Set(card.options.map((o) => (o.kind === 'switch_model' ? `switch to ${o.nickname}` : OUTAGE_KIND_WORDS[o.kind])))];
  return `[paused: ${name} — ${what}; options offered: ${kinds.join(' / ') || 'none'}]`;
};

/** The honest line for a run the studio paused (reliability.md §2: never claims a start; options in words). */
export function outageReplyLine(card: OutageCard, c: CostFormatter, reason?: string): string {
  const name = getImageModel(card.modelId)?.nickname ?? card.modelId;
  const money =
    card.origin === 'preflight'
      ? ' — nothing was started and nothing was charged'
      : card.origin === 'mid_run' && card.chargedUsd === 0
        ? " — the part that didn't draw wasn't charged"
        : '';
  const head = `${name} isn't drawing right now${reason ? ` (${clip(reason, 90)})` : ''}, so I paused${money}.`;
  const ways: string[] = [];
  for (const o of card.options) {
    if (o.kind === 'wait_and_retry') ways.push(`tap “Wait and retry” and it tries again once it's back, while this page is open (free${o.etaHint ? `, ${o.etaHint}` : ''})`);
    else if (o.kind === 'other_route') ways.push(`use ${lower1(o.label)} (same model, same look)`);
    else if (o.kind === 'add_key') ways.push(lower1(o.label));
    else if (o.kind === 'switch_model') {
      ways.push(
        `switch to ${o.nickname} (${c.approx(o.usdPerImage)} per image${o.redrawCount ? `; redrawing ${plural(o.redrawCount, 'image')} to match ≈ ${c(o.redrawUsd).replace(/^≈\s?/, '')}` : ''} — character consistency can be affected)`
      );
    }
  }
  if (!ways.length) return head;
  const said = ways.slice(0, 3);
  return `${head} You can ${said.length === 1 ? said[0] : `${said.slice(0, -1).join(', ')}, or ${said[said.length - 1]}`}.`;
}

/**
 * Words that say a drawing is under way (replies.ts' list plus retry / redraw verbs). Every match is judged on its
 * own: only a negation just before it (same clause) or an offer ("want me to start…?") takes it back — a "no" or a
 * "won't" elsewhere in the sentence never does ("No problem — I've started…", "It won't take long: … on its way").
 */
const START_CLAIM_RE = new RegExp(
  [
    String.raw`\bkick(?:ed|ing|s)? (?:it |them |that |those )?off\b`,
    String.raw`\bstart(?:ed|ing|s)?\b`,
    String.raw`\bon (?:its|their|the) way\b`,
    String.raw`(?:\b(?:are|is|now)|'re|'s) (?:re-?)?(?:drawing|rendering|generating|cooking|painting|being (?:re-?)?(?:drawn|rendered))\b`,
    String.raw`\b(?:re-?)?drawing (?:them|it|now|your|those|these)\b`,
    String.raw`\bwill (?:appear|land|show up)\b`,
    String.raw`\bcoming (?:right )?up\b`,
    String.raw`\bin (?:the )?(?:works|progress)\b`,
    String.raw`\bappear on the board\b`,
    String.raw`\bworking on (?:it|them|the|those|these|your)\b`,
    String.raw`\bre-?(?:draw|render|generat|paint)ing\b`,
    String.raw`\bre-?tr(?:y|i)ing\b`,
    String.raw`\btrying (?:it |them |that |those |these )?again\b`,
    String.raw`\btrying\b[^.!?]{0,40}\bnow\b`,
    String.raw`\bkeeps? (?:on )?(?:drawing|rendering|going)\b`,
    String.raw`\bhere (?:it |we )?goes\b`,
    String.raw`^(?:drawing|rendering|generating|painting)\b`
  ].join('|'),
  'gi'
);
/** A negation that takes back the claim right after it ("nothing was started", "I haven't started"). */
const NEGATED_BEFORE_RE =
  /(?:\b(?:not|never|nothing|none|neither|nor|without|didn'?t|did not|couldn'?t|could not|can'?t|cannot|won'?t|will not|wouldn'?t|isn'?t|is not|wasn'?t|was not|aren'?t|weren'?t|haven'?t|hasn'?t|hadn'?t|don'?t|doesn'?t)\b|\bno (?:new |more |other )?(?:images?|drawings?|pages?|runs?|jobs?|work|renders?|calls?)\b)[^.!?:;,—–]{0,20}$/i;
/** An offer or a condition right before the words ("want me to start?", "if you like, I can start"). */
const OFFER_BEFORE_RE = /\b(?:if|could|can|would|shall|should|may|might|want|wanna|ready to|once|when|until|unless|as soon as)\b[^.!?;:—–]{0,40}$/i;
/** A promise for later that waits on a condition ("it'll start once it's back"). */
const FUTURE_BEFORE_RE = /(?:'ll|\bwill|\bgoing to|\bto)\s+(?:\w+\s+)?$/i;
const CONDITION_AFTER_RE = /^[^.!?]{0,60}\b(?:once|when|as soon as|after|if|until)\b/i;
/** "Redrawing them would cost ≈ $0.82": the gerund is a noun, not a claim. */
const NOUN_AFTER_RE = /^[^.!?]{0,30}\b(?:would|could|costs?|will cost)\b/i;

/** Does this sentence say a drawing is under way (any one claim that nothing before it takes back)? */
const claimsStart = (sentence: string): boolean => {
  const s = sentence.replace(/[’‘]/g, "'");
  START_CLAIM_RE.lastIndex = 0;
  for (let m = START_CLAIM_RE.exec(s); m; m = START_CLAIM_RE.exec(s)) {
    if (m[0].length === 0) START_CLAIM_RE.lastIndex += 1;
    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length);
    if (NEGATED_BEFORE_RE.test(before) || OFFER_BEFORE_RE.test(before)) continue;
    if (FUTURE_BEFORE_RE.test(before) && CONDITION_AFTER_RE.test(after)) continue;
    if (/ing\b/i.test(m[0]) && NOUN_AFTER_RE.test(after)) continue;
    return true;
  }
  return false;
};

const PAUSE_ACK_RE = /\b(?:paused|isn'?t drawing|not drawing|nothing (?:was|is) (?:started|drawn|charged)|wasn'?t (?:drawn|started|charged)|unavailable|rate-?limit\w*|busy|down right now|couldn'?t (?:draw|start))\b/i;

// The model a claim's object/target names. A claim counts only when it is about the image model: "switched your
// comic / the model / it to X" (or plain "switched to X"), never "changed the title to Nano Banana Days".
const TARGET = String.raw`((?:[^.!?,;:]|\.(?=\d))+)`;
/** "switched it to X", "updated the model to X", "made the switch to X". */
const SWITCH_VERB_RE = /\b(switched|changed|moved|swapped|set|put|updated|made the switch|switching|changing|moving|swapping|updating)\b/gi;
/** Verbs that need no object to be about the model ("switched to X"). */
const INTRANSITIVE_RE = /^(?:switch\w*|mov\w*|swap\w*|made the switch)$/i;
/** The object of a transitive claim that makes it about the image model. */
const MODELISH_RE = /\b(?:image models?|models?|comics?|comic'?s|books?|story|it|this|images?|drawings?|art|artwork|pages?|generator|engine|everything|the rest|things over|over)\b/i;
/** "now using X", "from now on it draws with X", "your comic's model is now X", "the comic now uses X". */
const NOW_CLAIM_RES: RegExp[] = [
  new RegExp(String.raw`\b(?:now|from now on),?\s+(?:on|using)\s+${TARGET}`, 'gi'),
  new RegExp(
    String.raw`\b(?:now|from now on),?\s+(?:[\w']+\s+){0,3}?(?:using|uses|use|drawing with|draws with|draw with|drawn with|running on|runs on|run on|it'?s on|is on|are on|'re on)\s+${TARGET}`,
    'gi'
  ),
  new RegExp(String.raw`\bmodel\s+(?:is|'s)\s+now\s+${TARGET}`, 'gi')
];
/** "I'll switch it to X" (a promise: the whole sentence is its context). */
const PROMISE_RE = new RegExp(String.raw`\bI(?:'ll| will| am going to|'m going to)\s+(switch|change|move|swap|update|set)\b((?:[^.!?]|\.(?=\d))*?)\b(?:to|onto|over to)\s+${TARGET}`, 'gi');
/** "X is now your comic's model" (the subject is the claim's target). */
const SUBJECT_CLAIM_RE =
  /^((?:[^.!?]|\.(?=\d))+?)\s+(?:is|'s|will be)\s+(?:now\s+(?:your|the|this)|your|this comic'?s|the comic'?s|the book'?s)\s+(?:comic'?s\s+|book'?s\s+)?(?:new\s+)?(?:image\s+)?model\b/i;
/** A bare "Switched!" next to a claim. */
const SWITCH_FRAGMENT_RE = /^(?:(?:done|ok(?:ay)?|all set|great)[,!.\s—–-]*)?(?:switched|swapped|changed)(?: it)?(?: over)?[!.]*$/i;
/** An offer or a condition just before the claim ("if you want, I can switch it to X"). */
const CLAIM_OFFER_RE = /\b(?:if|could|can|would|want|wish|should|shall|may|might|whether|only you|picker|confirm|ready to)\b[^.!?;:—–]{0,40}$/i;
const CLAIM_CONDITIONAL_RE = /\b(?:if|could|can|would|want|wish|should|may|might|whether|only you|picker|confirm)\b/i;
/** A negation just before the claim, in the same clause ("I haven't switched…"). */
const CLAIM_NEGATED_RE = /\b(?:not|never|nothing|didn'?t|did not|haven'?t|hasn'?t|won'?t|can'?t|cannot|couldn'?t|wouldn'?t|isn'?t|wasn'?t|don'?t|doesn'?t)\b[^.!?:;,—–]{0,20}$/i;
const MODEL_LEAD_RE = /^(?:the |a |an )?(?:gpt|openai|chatgpt|dall ?e|flux|seedream|bytedance|nano ?banana|gemini)\b/;
/** Image models the studio does not offer: a claim of a switch to one is still false (no tool can switch). */
const FOREIGN_MODEL_RE = /^(?:the |a |an )?(?:imagen|midjourney|stable diffusion|sdxl|sd ?3|ideogram|recraft|leonardo|firefly|kandinsky|playground|hidream|qwen image|grok image|aurora|reve|dall ?e)\b/;

/** The model a claim's target text starts with ("GPT Image for the rest" → GPT Image 2.5), else undefined. */
const modelAtStart = (target: string): ImageModelSpec | undefined => {
  const t = normName(target);
  if (!t) return undefined;
  const byName = BY_NAME_LENGTH.find((m) => [m.nickname, m.label].some((n) => t === normName(n) || t.startsWith(`${normName(n)} `)));
  if (byName) return byName;
  return MODEL_LEAD_RE.test(t) ? resolveModelName(t.split(' ').slice(0, 5).join(' ')) : undefined;
};

/** Does the claim's target name a model other than the comic's (a registry model, or one the studio doesn't offer)? */
const otherModel = (rawTarget: string, currentId: string): boolean => {
  const target = rawTarget.replace(/^\s*(?:use|using|draw with|drawing with|run on|running on)\s+/i, '');
  const spec = modelAtStart(target);
  if (spec) return spec.id !== currentId;
  return FOREIGN_MODEL_RE.test(normName(target));
};

/** One sentence: does it claim the comic is (or will be) on another model? */
const claimsSwitch = (sentence: string, currentId: string): boolean => {
  const s = sentence.replace(/[’‘]/g, "'");
  const free = (before: string) => !CLAIM_OFFER_RE.test(before) && !CLAIM_NEGATED_RE.test(before);
  const aboutModel = (verb: string, object: string) => (object.trim() ? MODELISH_RE.test(object) : INTRANSITIVE_RE.test(verb.trim()));
  SWITCH_VERB_RE.lastIndex = 0;
  for (let v = SWITCH_VERB_RE.exec(s); v; v = SWITCH_VERB_RE.exec(s)) {
    const rest = s.slice(v.index + v[0].length);
    const t = new RegExp(String.raw`^((?:[^.!?]|\.(?=\d))*?)\b(?:to|onto|over to)\s+${TARGET}`, 'i').exec(rest);
    if (!t || !aboutModel(v[1], t[1]) || !free(s.slice(0, v.index))) continue;
    if (otherModel(t[2], currentId)) return true;
  }
  for (const re of NOW_CLAIM_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) if (free(s.slice(0, m.index)) && otherModel(m[1], currentId)) return true;
  }
  PROMISE_RE.lastIndex = 0;
  for (let m = PROMISE_RE.exec(s); m; m = PROMISE_RE.exec(s)) {
    // "I'll switch it to X if you like": a promise is an offer when anything in the sentence makes it conditional.
    if (CLAIM_CONDITIONAL_RE.test(s) || CLAIM_NEGATED_RE.test(s.slice(0, m.index)) || !aboutModel(m[1], m[2])) continue;
    if (otherModel(m[3], currentId)) return true;
  }
  const subject = SUBJECT_CLAIM_RE.exec(s);
  if (subject) {
    const lead = subject[1].split(/[,—–:]\s*/).pop() || '';
    if (!CLAIM_CONDITIONAL_RE.test(subject[1]) && otherModel(lead, currentId)) return true;
  }
  return false;
};

/** Sentences that claim a model switch the director never made (any model other than the comic's). */
export const falseSwitchClaims = (text: string, currentId: string): string[] => {
  const sentences = sentencesOf(text);
  const claims = sentences.filter((s) => claimsSwitch(s, currentId));
  // "Switched!" on its own is part of the same false claim.
  return claims.length ? sentences.filter((s) => claims.includes(s) || SWITCH_FRAGMENT_RE.test(s.trim())) : [];
};

export interface ReplyGuardInput {
  doc: ComicDoc;
  /** model_outage cards this turn produced (collected or committed). */
  outages: OutageCard[];
  /** Render targets this turn actually queued. */
  queued: number;
  cost: CostFormatter;
}

/**
 * The reply never claims what did not happen (models.md §3.1 rule 4; reliability.md §2): a switch of the image
 * model (no director tool can), or a drawing that started when the studio paused the run. Claims are dropped and
 * the honest line leads (with the picker chip after a false switch); a reply that already says it plainly is kept.
 */
export function guardModelReply(text: string, i: ReplyGuardInput): { text: string; steps: NextStep[] } {
  let out = text.trim();
  const steps: NextStep[] = [];
  const cur = currentImageModel(i.doc);
  const claims = out ? falseSwitchClaims(out, cur.id) : [];
  if (claims.length) {
    const kept = sentencesOf(out).filter((s) => !claims.includes(s));
    out = [`Your comic stays on ${cur.name} — only you can change the image model, in the model picker, and switching can affect character consistency.`, ...kept].join(' ').trim();
    steps.push(pickerStep('See models'));
  }
  const outage = i.outages[i.outages.length - 1];
  if (outage) {
    const line = outageReplyLine(outage, i.cost);
    if (!out) return { text: line, steps };
    const sentences = sentencesOf(out);
    // Something else this turn did start: keep its sentences, only make sure the pause is said.
    const kept = i.queued > 0 ? sentences : sentences.filter((s) => !claimsStart(s));
    if (kept.length === sentences.length && PAUSE_ACK_RE.test(out)) return { text: out, steps };
    out = [line, ...kept].join(' ').trim();
  }
  return { text: out, steps };
}

// ── DOC SUMMARY facts (director.ts) ──────────────────────────────────────────

const STATE_WORDS: Record<HealthState, string> = {
  ok: 'serving normally',
  degraded: 'unstable (some calls fail)',
  down: 'not serving (down)',
  unknown: 'status unknown'
};

const agoWords = (ms: number): string => {
  if (!(ms >= 0) || !Number.isFinite(ms)) return '';
  if (ms < 90_000) return 'just now';
  const min = Math.round(ms / 60_000);
  return min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

/**
 * The model_status fact (reliability.md §2 Director): the comic model's health, read live only when something is
 * wrong — our breaker, this comic's own failures (R5) or a recent outage card — so a normal turn costs no I/O;
 * '' when there is nothing to say. Never throws.
 */
export async function modelStatusLine(
  ctx: StudioContext,
  doc: ComicDoc,
  userText: string,
  opts: { health?: ModelHealthPort; now?: number; waitMs?: number; cost?: CostFormatter; drawIntent?: DirectorTurn['drawIntent'] } = {}
): Promise<string> {
  const now = opts.now ?? Date.now();
  const health = opts.health ?? modelHealth();
  const c = opts.cost ?? costFormatterFor(ctx);
  const cur = currentImageModel(doc);
  // A lock the registry no longer knows has no routes to read: the MODEL fact (lockUnusable) says so instead.
  if (!cur.known) return '';
  const streak = upstreamStreak(doc, now);
  const outage = recentOutageCard(doc, now);
  const routes = reachableRoutes(cur.spec, ctx.keys);
  const breaker = routes.some((r) => {
    try {
      const s = health.routeState(r.route, r.model, now).state;
      return s === 'down' || s === 'degraded';
    } catch {
      return false;
    }
  });
  const read = async (): Promise<ModelHealth | null> => {
    try {
      return await within(health.getModelHealth(cur.spec, { keys: ctx.keys, now }), opts.waitMs ?? HEALTH_WAIT_MS);
    } catch {
      return null;
    }
  };
  let mh: ModelHealth | null = null;
  if (!breaker && !streak.count && !outage) {
    // Nothing we saw ourselves (the breaker forgets when the container sleeps). A turn that may draw still reads the
    // public status the preflight will read (cached 3 min, single-flight, bounded), and says so only when it is bad.
    const drawing = !!opts.drawIntent && opts.drawIntent !== 'none';
    mh = drawing ? await read() : null;
    if (!mh || (mh.state !== 'down' && mh.state !== 'degraded')) {
      return STATUS_ASK_RE.test(userText)
        ? `MODEL STATUS (${cur.name}): no failures in this comic or in our recent calls; ${!mh ? 'live provider status not checked' : mh.state === 'ok' ? 'live status: serving normally' : 'live status unknown'}.`
        : '';
    }
  } else mh = await read();
  const state: HealthState = mh?.state ?? (breaker ? 'down' : 'unknown');
  const route = mh?.routes.find((r) => r.state === state) ?? mh?.routes[0];
  const source = route?.source === 'openrouter' ? 'OpenRouter status' : route?.source === 'observed' ? 'our recent calls' : 'no live data';
  const ago = route ? agoWords(now - route.checkedAt) : '';
  const reason = route?.reason ? clip(route.reason.replace(/\b(?:RATE_LIMIT|PROVIDER_ERROR|TIMEOUT)\b/g, (code) => failureCodeWords(code)), 80) : '';
  const head = `MODEL STATUS (${cur.name}): ${STATE_WORDS[state]}${reason ? ` — ${reason}` : ''} (${source}${ago ? `, ${ago}` : ''}).`;
  const guidance =
    state === 'down'
      ? 'New drawing pauses before anything is charged; never say a drawing started unless a tool says so. Suggest waiting first (free).'
      : state === 'degraded'
        ? 'Some calls may fail (failed calls cost nothing); suggest waiting if one does.'
        : state === 'ok'
          ? 'It looks back to normal: trying again should work.'
          : '';
  // The head and the guidance are never cut; the facts after them are added while they fit (400 chars).
  const lines = [head, guidance].filter(Boolean);
  const fits = (extra: string) => [...lines, extra].join(' ').length <= 400;
  if (streak.count) {
    const said = `${plural(streak.count, 'drawing')} in this comic failed upstream in the last 10 min${streakDetail(streak) ? ` (${streakDetail(streak)})` : ''}.`;
    if (fits(said)) lines.push(said);
  }
  if (outage) {
    const said = `The studio paused ${outage.card.origin === 'preflight' ? 'a run before it started (nothing charged)' : 'a run'} — its options are in OUTAGE OPTIONS.`;
    if (fits(said)) lines.push(said);
  }
  return clip(lines.join(' '), 400);
}

/** The latest outage card's options in words with their real prices (worded for this user), or ''. */
export const outageOptionsLine = (doc: ComicDoc, c: CostFormatter, now = Date.now()): string => {
  const outage = recentOutageCard(doc, now);
  if (!outage) return '';
  const words = outageOptionWords(outage.card.options, c);
  return words.length ? clip(`OUTAGE OPTIONS (the studio's own check, real prices): ${words.join(' · ')}. Offer them in words; a switch only through the picker.`, 400) : '';
};

/**
 * Model facts for the DOC SUMMARY tail (always considered, cheap): a page with more characters than the model holds
 * (§3.8 trigger 1), a locked model that can no longer draw (trigger 3) and the model_status fact (R5, outages).
 */
export async function modelFactLines(
  ctx: StudioContext,
  doc: ComicDoc,
  userText: string,
  opts: { health?: ModelHealthPort; now?: number; waitMs?: number; drawIntent?: DirectorTurn['drawIntent'] } = {}
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const cur = currentImageModel(doc);
    // A drawn, current crowded page is only news again when the user asks to draw.
    const crowd = cur.known ? crowdedPage(doc, cur.spec, { pending: (opts.drawIntent ?? 'none') === 'none' }) : null;
    if (crowd) {
      lines.push(
        `MODEL FIT: page ${crowd.n} has ${crowd.count} characters but ${cur.name} keeps up to ${cur.spec.refs.characters} on model per image. Before drawing it, say so and suggest a model that holds more (model_options, then the picker chip); never switch.`
      );
    }
    const unusable = lockUnusable(doc, ctx.caps ?? DEFAULT_CAPS);
    if (unusable) lines.push(`MODEL: ${cur.name} ${unusable}. Say so and offer the picker (model_options); never pick another model yourself.`);
    const status = await modelStatusLine(ctx, doc, userText, opts);
    if (status) lines.push(status);
    const options = outageOptionsLine(doc, costFormatterFor(ctx), opts.now);
    if (options) lines.push(options);
  } catch (err) {
    logger.warn('comic_model_facts_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
  }
  return lines;
}

// ── Tools ────────────────────────────────────────────────────────────────────

const knownNames = () => IMAGE_MODELS.filter((m) => m.pickable).map((m) => m.nickname).join(', ');

function modelOptionsTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'model_options',
    'free',
    "Image-model options for THIS comic with real numbers: price per page, characters each holds, providers and uptime, leaderboard ranks with dates, the cost to redraw what's drawn, and why a model can't draw it. Read-only — it never changes the model. Use when the user asks for another, better or cheaper model, names one, or a page has more characters than the model holds.",
    {
      type: 'object',
      properties: {
        want: {
          type: 'string',
          enum: [...MODEL_WANTS],
          description: 'cheaper / better / characters (holds more) / specific (the model the user named) / other.'
        },
        model: { type: 'string', maxLength: 60, description: 'A model the user named, e.g. "GPT image" or "Nano Banana Pro".' }
      },
      additionalProperties: false
    },
    async (args) => {
      const raw = typeof args.model === 'string' ? args.model.trim() : '';
      const named = raw ? resolveModelName(raw) : undefined;
      if (raw && !named) throw toolArgError(`No image model called "${clip(raw, 40)}". Available: ${knownNames()}.`);
      const want: ModelWant = (MODEL_WANTS as readonly string[]).includes(args.want as string) ? (args.want as ModelWant) : named ? 'specific' : 'other';
      const advice = await buildModelAdvice(ctx, { want, ...(named ? { named } : {}) });
      adviceByTurn.set(turn, advice);
      return describeModelAdvice(advice, costFormatterFor(ctx));
    }
  );
}

function suggestModelTool(ctx: StudioContext, turn: DirectorTurn): DirectorTool {
  return defineTool(
    'suggest_model',
    'free',
    'Offer a chip — never a change. model: "See models" opens the picker with that model highlighted (switching needs the user\'s confirm there). tier: a cheaper quality tier for NEW pages on the same model (the user taps it). Call after model_options.',
    {
      type: 'object',
      properties: {
        model: { type: 'string', maxLength: 60, description: 'Registry id or name of the model to highlight.' },
        tier: { type: 'string', enum: [...TIERS], description: 'A cheaper tier on the same model.' }
      },
      additionalProperties: false
    },
    (args) => {
      const doc = ctx.session.doc;
      const cur = currentImageModel(doc);
      const said: string[] = [];
      const steps: NextStep[] = [];
      if (args.tier !== undefined && args.tier !== null && args.tier !== '') {
        const tier = args.tier as QualityTier;
        if (!TIERS.includes(tier)) throw toolArgError('tier must be "draft", "standard" or "pro".');
        if (!cur.known) throw toolArgError(`${cur.name} is no longer listed by the studio, so a tier change can't be checked or priced. Offer the picker (suggest_model with no tier).`);
        if (TIERS.indexOf(tier) >= TIERS.indexOf(doc.settings.quality)) {
          throw toolArgError(`${TIER_PRESETS[tier].label} doesn't cost less than ${TIER_PRESETS[doc.settings.quality].label}. Only the user raises quality (the quality chip).`);
        }
        const job = resolveImageJob('page', tier, doc.settings.imageModelOverride, deriveLock(doc));
        if (job.spec.id !== cur.spec.id) {
          throw toolArgError(`${TIER_PRESETS[tier].label} would draw on ${job.spec.nickname}, not ${cur.name}: that changes the image model, which is the user's call (the quality chip shows it and asks first). Offer the picker instead.`);
        }
        steps.push({ label: `Use ${TIER_PRESETS[tier].label} for new pages`, action: { type: 'patch', ops: [{ op: 'settings', patch: { quality: tier } }] }, usd: 0 });
        said.push(`Offered “Use ${TIER_PRESETS[tier].label} for new pages”: one tap draws new pages with ${cur.name} at ${job.resolution}; drawn pages keep theirs.`);
      }
      const rawModel = typeof args.model === 'string' ? args.model.trim() : '';
      if (rawModel || !steps.length) {
        const spec = rawModel ? resolveModelName(rawModel) : undefined;
        if (rawModel && !spec) throw toolArgError(`No image model called "${clip(rawModel, 40)}". Available: ${knownNames()}.`);
        const suggest = spec && spec.id !== cur.id ? spec.id : undefined;
        const label = troubled({ streak: upstreamStreak(doc), outage: recentOutageCard(doc)?.card }) ? 'See other models' : 'See models';
        if (!turn.nextSteps.some((s) => s.client?.type === 'open_model_picker')) steps.push(pickerStep(label, suggest));
        said.push(
          `Offered “${label}”${suggest ? ` with ${spec!.nickname} highlighted` : ''}: the picker shows real prices and asks the user to confirm (consistency can be affected). Nothing changed — the comic stays on ${cur.name}.`
        );
      }
      pushNextSteps(turn, steps);
      return said.join(' ');
    }
  );
}

/** Should this turn carry the group (its 2 tools count against MAX_TOOLS_PER_TURN)? */
export const modelsGroupWanted = (ctx: StudioContext, turn: DirectorTurn, now = Date.now()): boolean => {
  if (MODEL_HINT_RE.test(turn.userText || '')) return true;
  const doc = ctx.session.doc;
  const cur = currentImageModel(doc);
  return (cur.known && !!crowdedPage(doc, cur.spec, { pending: turn.drawIntent === 'none' })) || upstreamStreak(doc, now).count >= R5_FAILURES || !!recentOutageCard(doc, now) || !!lockUnusable(doc, ctx.caps ?? DEFAULT_CAPS);
};

/** Added to the system prompt when the group is active (models.md §3.8, verbatim rule + how to use the tools). */
export const MODELS_PROMPT_RULES = `IMAGE MODELS
The image model is locked per comic. Never say you switched it and never call a tool to switch it. If the user asks for another, better or cheaper model, call model_options and explain the trade-off in one or two sentences using only the numbers it returns: price per page, characters it holds, the cost to redraw what exists. Say plainly that consistency can be affected. Then offer the picker chip (suggest_model). If model_options marks something UNVERIFIED, say you don't know it.
- Cheaper first on the same model: a lower quality tier keeps the look (suggest_model tier). Never call an unranked model as good as the current one.
- Suggest without being asked only when a page has more characters than the model holds, the provider keeps failing (suggest waiting first), or the model can no longer draw. Never on price alone.`;

const MODELS_GROUP_ID: string = 'models';

export const modelsToolGroup: ToolGroup = {
  // 'models' is this group's id; ToolGroupId (extensions.ts, frozen) gains it through the lead's amendment.
  id: MODELS_GROUP_ID as ToolGroupId,
  priority: 12,
  when: (ctx, turn) => modelsGroupWanted(ctx, turn),
  tools: (ctx, turn) => [modelOptionsTool(ctx, turn), suggestModelTool(ctx, turn)],
  promptRules: () => MODELS_PROMPT_RULES,
  summaryLines: (doc) => {
    const cur = currentImageModel(doc);
    const drawn = drawnTargets(doc);
    return [
      `Image model: ${cur.name}${cur.locked ? ', locked for this comic' : ' (locks at the first comic image)'}; ${cur.known ? `holds ${cur.spec.refs.characters} characters per image` : 'no longer listed by the studio (price and characters unknown)'}${drawnCount(drawn) ? `; drawn with it: ${drawnWords(drawn)}` : ''}.`
    ];
  },
  activity: {
    model_options: 'Comparing image models',
    suggest_model: 'Preparing the model picker'
  }
};

/** A retry chip's price for the comic's model: the lock decides the model at every tier (models.md §3.4 #1). */
const lockedRetryStep = (doc: ComicDoc, step: NextStep, byok: boolean): NextStep => {
  const lock = deriveLock(doc);
  const a = step.action;
  if (!lock || !a) return step;
  const job: { kind: ImageJobKind; count: number } | null =
    a.type === 'render_pages'
      ? { kind: 'page', count: a.pageIds?.length ?? 0 }
      : a.type === 'render_sheets'
        ? { kind: 'sheet', count: a.characterIds?.length ?? 0 }
        : a.type === 'render_cover'
          ? { kind: 'cover', count: 1 }
          : a.type === 'render_style_options'
            ? { kind: 'style_option', count: a.directions?.length ?? 0 }
            : null;
  if (!job || !job.count) return step;
  const usd = estimateJobs([job], doc.settings.quality, { override: doc.settings.imageModelOverride, byok, lock }).usd;
  return { ...step, action: { ...a, quotedUsd: usd } as typeof a, usd };
};

/**
 * Chips that go with a reply about the comic's model when the provider keeps failing (models.md §3.6 G): "Try
 * again" for what failed (priced on the comic's model), then "See other models".
 */
export const outageNextSteps = (doc: ComicDoc, byok: boolean, now = Date.now()): NextStep[] => {
  const streak = upstreamStreak(doc, now);
  const steps: NextStep[] = [];
  if (streak.targets.length) {
    try {
      const retries = retryNextSteps(doc, streak.targets, byok).map((s) => lockedRetryStep(doc, s, byok));
      // One retry chip reads exactly as §3.6 G says; several keep their own labels so each stays tappable.
      steps.push(...(retries.length === 1 ? [{ ...retries[0], label: 'Try again' }] : retries));
    } catch {
      /* no retry chip without a quote */
    }
  }
  steps.push(pickerStep('See other models'));
  return steps;
};

/**
 * The §3.6 G chips with a reply: the retry chips first, then the reply's own chips, then "See other models" only
 * when no picker chip is there yet (one picker chip per turn).
 */
export const pushOutageSteps = (turn: DirectorTurn, doc: ComicDoc, byok: boolean, replySteps: NextStep[] = [], now = Date.now()): void => {
  const isPicker = (s: NextStep) => s.client?.type === 'open_model_picker';
  const steps = outageNextSteps(doc, byok, now);
  pushNextSteps(turn, steps.filter((s) => !isPicker(s)));
  pushNextSteps(turn, turn.nextSteps.some(isPicker) ? replySteps.filter((s) => !isPicker(s)) : replySteps);
  if (!turn.nextSteps.some(isPicker)) pushNextSteps(turn, steps.filter(isPicker));
};
