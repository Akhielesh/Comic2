// Words for model health (reliability.md §3; models.md §3.6 G/H for the outage wording). Pure: every time
// reads through `now`. Honest by construction: a state always names its source and age ("OpenRouter status,
// 2 min ago"); no data reads as "no live data", never as fine.

import type { HealthState, ModelHealth, RouteHealth } from '../../../shared/comic/modelHealth';
import { getImageModel, type ImageModelSpec, type ImageRoute } from '../../../shared/comic/models';
import type { StudioAction } from '../../../shared/comic/ops';
import type { StatusTone } from '../../chat/studioDesign';
import { formatFailedAt } from '../conversation/cards/failure';

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

/** Dot tones. The banner and cards stay calm (warning surfaces, never red text). */
export const STATE_TONE: Record<HealthState, StatusTone> = {
  ok: 'success',
  degraded: 'warning',
  down: 'danger',
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
      return many('The style tests');
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

/** The outage sentence (models.md §3.6 G/H in our words): who, what, and that nothing was charged. */
export const outageSentence = (input: { modelId: string; health?: ModelHealth; action?: StudioAction; pageNumber?: (id: string) => number | undefined }): string => {
  const name = modelName(input.modelId);
  const who = whoServes(input.health, input.modelId);
  const reason = troubleReason(input.health);
  const what = blockedWhat(input.action, input.pageNumber);
  const started = input.action
    ? `${what.label} ${what.plural ? "weren't" : "wasn't"} started, and nothing was charged.`
    : 'Nothing was drawn and nothing was charged.';
  return `${who} isn't serving ${name} right now${reason ? ` (${reason})` : ''}. ${started} Your comic stays on ${name} so every page matches.`;
};

/** Settings → API keys (App.tsx restores ?view=settings&tab=settings); opened in a new tab so a waiting retry survives. */
export { API_KEYS_HREF } from '../../usage/UsageMeter';
