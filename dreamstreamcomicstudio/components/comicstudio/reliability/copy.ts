// Words for model health (reliability.md §3; models.md §3.6 G/H for the outage wording). Pure: every time
// reads through `now`. Honest by construction: a state always names its source and age ("OpenRouter status,
// 2 min ago"); no data reads as "no live data", never as fine; money is mentioned only when we know it (a
// preflight card ran nothing; a mid-run card says "you weren't charged" only when the provider reported $0).

import type { ComicDoc, RenderState } from '../../../shared/comic/doc';
import type { HealthState, ModelHealth, RouteHealth } from '../../../shared/comic/modelHealth';
import { getImageModel, type ImageModelSpec, type ImageRoute } from '../../../shared/comic/models';
import type { StudioAction } from '../../../shared/comic/ops';
import type { StatusTone } from '../../chat/studioDesign';
import { formatFailedAt } from '../conversation/cards/failure';
import type { OutageCardFacts } from './options';

export const ROUTE_NAME: Record<ImageRoute, string> = { openrouter: 'OpenRouter', gemini: 'Gemini' };

const VENDOR_NAME: Record<ImageModelSpec['vendor'], string> = {
  google: 'Google',
  openai: 'OpenAI',
  bfl: 'Black Forest Labs',
  bytedance: 'ByteDance'
};

/** One or two words per state, always shown next to the dot (never colour alone). */
export const STATE_WORD: Record<HealthState, string> = {
  ok: 'Working',
  degraded: 'Unsteady',
  down: 'Paused',
  unknown: 'No live data'
};

/** Dot tones. Calm on purpose (the owner: no glaring errors): paused and unsteady share the warning tone and are
 *  told apart by their word (and the unsteady dot's gentle pulse), never by a red mark. */
export const STATE_TONE: Record<HealthState, StatusTone> = {
  ok: 'success',
  degraded: 'warning',
  down: 'warning',
  unknown: 'neutral'
};

export const modelName = (modelId: string): string => getImageModel(modelId)?.nickname || modelId;

/** "just now" · "2 min ago" · "3 h ago" · "Oct 20, 16:52". */
export const timeAgo = (at: number | undefined, now: number = Date.now()): string => {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return 'time unknown';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return formatFailedAt(at, now) || 'a while ago';
};

/** Local wall-clock time for "since 16:52" (yesterday / a date when older). */
export const clockTime = (at: number | undefined, now: number = Date.now()): string | undefined => formatFailedAt(at, now);

const RANK: Record<HealthState, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

/** The route that explains the model's state best: the worst one with data, else the first. */
export const keyRoute = (health: ModelHealth | undefined): RouteHealth | undefined => {
  if (!health?.routes.length) return undefined;
  return [...health.routes].sort((a, b) => RANK[b.state] - RANK[a.state] || (a.source === 'none' ? 1 : 0) - (b.source === 'none' ? 1 : 0))[0];
};

const SOURCE_NAME: Record<RouteHealth['source'], string> = {
  openrouter: 'OpenRouter status',
  observed: 'our recent calls',
  none: 'no live data'
};

/** "OpenRouter status, 2 min ago" · "our recent calls, just now" · "no live data right now". */
export const sourceLine = (health: ModelHealth | undefined, now: number = Date.now()): string => {
  const route = keyRoute(health);
  if (!route || route.source === 'none') return 'no live data right now';
  return `${SOURCE_NAME[route.source]}, ${timeAgo(route.checkedAt, now)}`;
};

/** Who serves the model: the public provider name ("Google AI Studio") when OpenRouter lists one, else the vendor. */
export const whoServes = (health: ModelHealth | undefined, modelId: string): string => {
  const providers = health?.routes.find((r) => r.route === 'openrouter')?.providers || [];
  const failing = providers.find((p) => p.status !== null && p.status !== 0) || providers[0];
  if (failing?.name) return failing.name;
  const spec = getImageModel(modelId);
  return spec ? VENDOR_NAME[spec.vendor] : 'The provider';
};

const CODE_WORDS: Record<string, string> = {
  RATE_LIMIT: 'rate limited',
  '429': 'rate limited',
  PROVIDER_ERROR: 'provider error',
  TIMEOUT: 'timed out',
  '408': 'timed out',
  NOT_AVAILABLE: 'not available'
};

/** "Our last 3 calls failed (RATE_LIMIT)" → "our last 3 calls failed: rate limited" (mid-sentence, no code jargon). */
export const friendlyReason = (reason: string | undefined): string | undefined => {
  const s = (reason || '').trim().replace(/\.$/, '');
  if (!s) return undefined;
  return s
    .replace(/\s*\(([A-Za-z_0-9]+)\)$/, (_m, code: string) => `: ${CODE_WORDS[code.toUpperCase()] || (/^5\d\d$/.test(code) ? 'provider error' : code.toLowerCase().replace(/_/g, ' '))}`)
    .replace(/^./, (ch) => ch.toLowerCase());
};

/** The server's short, user-safe reason for the worst route, in words ("our last 3 calls failed: rate limited"). */
export const troubleReason = (health: ModelHealth | undefined): string | undefined => friendlyReason(keyRoute(health)?.reason);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface BlockedWhat {
  /** "The style tests", "Page 3", "The cover". */
  label: string;
  /** Takes "were" rather than "was". */
  plural: boolean;
}

/** What the preflight held back, for "{what} wasn't started". */
export const blockedWhat = (action: StudioAction | undefined, pageNumber?: (pageId: string) => number | undefined): BlockedWhat => {
  const one = (label: string): BlockedWhat => ({ label, plural: false });
  const many = (label: string): BlockedWhat => ({ label, plural: true });
  if (!action) return one('That run');
  switch (action.type) {
    case 'render_style_options':
      return action.directions?.length === 1 ? one('The style test') : many('The style tests');
    case 'render_sheets':
      return action.characterIds?.length === 1 ? one('The character sheet') : many('The character sheets');
    case 'render_pages': {
      const ids = action.pageIds || [];
      if (ids.length === 1) {
        const n = pageNumber?.(ids[0]);
        return one(n ? `Page ${n}` : 'That page');
      }
      if (ids.length > 1) return many(`Those ${plural(ids.length, 'page')}`);
      return many(action.includeCover ? 'The pages and cover' : 'The pages');
    }
    case 'edit_page': {
      const n = pageNumber?.(action.pageId);
      return one(n ? `The edit to page ${n}` : 'The page edit');
    }
    case 'render_cover':
      return one('The cover');
    case 'recheck_page':
      return one('The page check');
    case 'translate':
      return one('The translation');
    default:
      return one('That run');
  }
};

const RATE_LIMIT_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT', '429']);

/** The failed renders an outage card's action names (pages, cover, sheets, style tests), for their Details facts. */
const blockedRenders = (doc: ComicDoc | null | undefined, action: StudioAction | undefined): RenderState[] => {
  if (!doc || !action) return [];
  switch (action.type) {
    case 'render_pages': {
      const ids = action.pageIds?.length ? new Set(action.pageIds) : null;
      const pages = doc.pages.filter((p) => !ids || ids.has(p.id)).map((p) => p.render);
      return action.includeCover ? [...pages, doc.cover.render] : pages;
    }
    case 'edit_page':
      return doc.pages.filter((p) => p.id === action.pageId).map((p) => p.render);
    case 'render_cover':
      return [doc.cover.render];
    case 'render_sheets': {
      const ids = action.characterIds?.length ? new Set(action.characterIds) : null;
      return doc.cast.filter((c) => !ids || ids.has(c.id)).map((c) => c.sheet);
    }
    case 'render_style_options': {
      const names = action.directions?.length ? new Set(action.directions.map((d) => d.name)) : null;
      return doc.style.options.filter((o) => !names || names.has(o.name)).map((o) => o.render);
    }
    default:
      return [];
  }
};

/** "OpenRouter · 429 · upstream Google" from a failed target's Details (the trailing "· 17:42 UTC" dropped). */
export const blockedFailureDetail = (doc: ComicDoc | null | undefined, action: StudioAction | undefined): { code: string; text: string } | undefined => {
  for (const render of blockedRenders(doc, action)) {
    const d = render?.status === 'failed' ? render.errorDetail : undefined;
    if (d?.code && d.text) return { code: d.code, text: d.text.replace(/\s*·\s*\d{1,2}:\d{2}(?:\s*UTC)?\s*$/i, '').trim() };
  }
  return undefined;
};

/** Is the model being rate-limited (models.md §3.6 G) rather than unavailable (H)? Our calls' last code says so. */
export const isRateLimited = (health: ModelHealth | undefined, failedCode?: string): boolean => {
  const code = keyRoute(health)?.observed?.lastCode ?? failedCode;
  return !!code && RATE_LIMIT_CODES.has(code.toUpperCase());
};

/** "OpenRouter · 429 · upstream Google AI Studio" from the status itself (when no failed tile carries one). */
const healthDetail = (health: ModelHealth | undefined): string | undefined => {
  const route = keyRoute(health);
  if (!route) return undefined;
  const code = route.observed?.lastCode;
  const upstream = route.providers?.find((p) => p.status !== null && p.status !== 0)?.name || route.providers?.[0]?.name;
  return [ROUTE_NAME[route.route], code ? (RATE_LIMIT_CODES.has(code.toUpperCase()) ? '429' : code) : '', upstream ? `upstream ${upstream}` : ''].filter(Boolean).join(' · ');
};

/** The charge clause is allowed only when we KNOW nothing was charged (models.md §3.6 G). */
const knownFree = (facts: OutageCardFacts): boolean => facts.origin === 'preflight' || (facts.origin === 'mid_run' && facts.chargedUsd === 0);

/** "Page 3 wasn't drawn, and you weren't charged for it." — the charge clause only when we know it. */
export const notDrawnSentence = (input: { action?: StudioAction; pageNumber?: (id: string) => number | undefined } & OutageCardFacts): string => {
  const free = knownFree(input);
  if (!input.action) {
    if (input.origin === 'preflight') return 'Nothing was drawn, and nothing was charged.';
    return `Some images weren't drawn${free ? ", and you weren't charged for them" : ''}.`;
  }
  const what = blockedWhat(input.action, input.pageNumber);
  return `${what.label} ${what.plural ? "weren't" : "wasn't"} drawn${free ? `, and you weren't charged for ${what.plural ? 'them' : 'it'}` : ''}.`;
};

/**
 * The outage sentence, models.md §3.6 exactly:
 *  G (rate-limited): "{Upstream} is rate-limiting {Model} right now ({detail}). Page {p} wasn't drawn{, and you
 *    weren't charged for it}. Your comic stays on {Model} so every page matches."
 *  H (otherwise): "{Model} isn't available for this comic right now ({reason}). Nothing was drawn. You can wait, or
 *    switch models. Switching can affect consistency."
 * A preflight card ran nothing, so it says so ("nothing was charged"); a mid-run card names only what wasn't drawn
 * and adds the charge clause only when the provider reported no cost; a card without an origin makes no money claim.
 */
export const outageSentence = (
  input: { modelId: string; health?: ModelHealth; action?: StudioAction; pageNumber?: (id: string) => number | undefined; doc?: ComicDoc | null } & OutageCardFacts
): string => {
  const name = modelName(input.modelId);
  const failed = blockedFailureDetail(input.doc, input.action);
  const facts: OutageCardFacts = { ...(input.origin ? { origin: input.origin } : {}), ...(input.chargedUsd !== undefined ? { chargedUsd: input.chargedUsd } : {}) };
  if (isRateLimited(input.health, failed?.code)) {
    const who = whoServes(input.health, input.modelId);
    const detail = failed?.text || healthDetail(input.health);
    const drawn = notDrawnSentence({ action: input.action, pageNumber: input.pageNumber, ...facts });
    return `${who} is rate-limiting ${name} right now${detail ? ` (${detail})` : ''}. ${drawn} Your comic stays on ${name} so every page matches.`;
  }
  const reason = troubleReason(input.health);
  const drawn = input.origin === 'preflight' ? 'Nothing was drawn, and nothing was charged.' : notDrawnSentence({ action: input.action, pageNumber: input.pageNumber, ...facts });
  return `${name} isn't available for this comic right now${reason ? ` (${reason})` : ''}. ${drawn} You can wait, or switch models. Switching can affect consistency.`;
};

/** Once the model answers again: what happened, with the same money honesty as the outage sentence. */
export const recoveredSentence = (input: { modelId: string; action?: StudioAction; pageNumber?: (id: string) => number | undefined } & OutageCardFacts): string => {
  const name = modelName(input.modelId);
  if (input.origin === 'preflight') {
    const what = blockedWhat(input.action, input.pageNumber);
    const held = input.action ? `${what.label} ${what.plural ? "weren't" : "wasn't"} started while it was paused, and nothing was charged.` : 'Nothing was drawn while it was paused, and nothing was charged.';
    return `${name} is answering again. ${held} Your comic stays on ${name}.`;
  }
  return `${name} is answering again. ${notDrawnSentence(input)} Your comic stays on ${name}.`;
};

/** No live status (state unknown): say so, never "answering again". */
export const noLiveStatusSentence = (input: { modelId: string; action?: StudioAction; pageNumber?: (id: string) => number | undefined } & OutageCardFacts): string => {
  const name = modelName(input.modelId);
  const drawn = notDrawnSentence(input);
  return `There's no live status for ${name} right now, so we can't tell whether it's answering again. ${drawn} You can try again now, wait, or switch models. Switching can affect consistency.`;
};

/** Settings → API keys (App.tsx restores ?view=settings&tab=settings); opened in a new tab so a waiting retry survives. */
export { API_KEYS_HREF } from '../../usage/UsageMeter';
