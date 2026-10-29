// Every word the model picker, its confirms and the lock line show (models.md §3.6 A–F, §3.7, §4.6). Pure: the
// components fill `{…}` from live data and copy.test.ts snapshots each string exactly, so a wording change is a
// deliberate, reviewed edit here and nowhere else.
//
// Money never appears in this file as a figure: callers pass prices already worded for THIS user
// (conversation/cost.ts — dollars for admins and own-key comics, a share of the usage for everyone else), and a
// price we do not have is never a number (the §4.6 copy instead).
//
// One deliberate wording change against §3.6 D: its last sentence reads "If you change it later, character
// consistency can be affected." (the spec's "Changing it later can affect consistency."), so both confirms carry
// the owner's required words "consistency can be affected" (decisions-final: "a confirm that says character
// consistency can be affected"; §5.1 tests: "C and D render 'consistency can be affected'").

import type { Resolution } from '../../../shared/comic/doc';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── A. Lock line (QualityPanel footer; the Cost card's "Next pages draw on" row) ───────────────────────────────

export const LOCK_ICON_LABEL = 'Model locked so every page matches';
export const lockedLine = (model: string) => `Drawn with ${model} · locked for this comic`;
export const unlockedLine = (model: string) => `Will draw with ${model} · locks when the first image is drawn`;
export const CHANGE_LINK = 'Change…';
export const CHOOSE_LINK = 'Choose model…';

// ── B. Picker sheet ─────────────────────────────────────────────────────────────────────────────────────────

export const PICKER_TITLE = 'Image model';
export const pickerSubtitleLocked = (model: string) => `This comic is drawn with ${model}. Changing it can affect consistency.`;
export const PICKER_SUBTITLE_UNLOCKED = 'Pick before the first image. The model then stays the same for every page.';

export const BADGE = {
  default: 'Default',
  experimental: 'Experimental',
  current: 'Current',
  /** The model a chip, the outage card or the banner pointed at (open_model_picker `suggest`). */
  suggested: 'Suggested'
} as const;

/** "≈$0.07 per page at 2K" · "≈2% of your usage per page at 2K" (price already worded for this user). */
export const perPage = (price: string, res: Resolution | string) => `${price} per page at ${res}`;
export const holdsCharacters = (k: number) => `Holds ${plural(k, 'character')} per image`;
/** "1 provider · 97.7% up (24 h)" — "{p} provider(s)" is pluralised, never a literal "(s)". */
export const providersLine = (p: number, uptime: string) => `${plural(p, 'provider')} · ${uptime}% up (24 h)`;
export const providersNoUptime = (p: number) => (p > 0 ? `${plural(p, 'provider')} · ${NO_UPTIME}` : NO_UPTIME);
export const leaderboardsLine = (parts: string[]) => `Leaderboards: ${parts.join(' · ')}`;
export const lmarenaEdit = (rank: number) => `LMArena edit #${rank}`;
export const aaEdit = (rank: number) => `AA edit #${rank}`;

/** Disabled reasons (shared/comic/modelLock.ts modelFit writes the same words; copy.test.ts checks they agree). */
export const DISABLED = {
  aspect: (aspect: string) => `Can't draw ${aspect} pages`,
  access: 'Needs a paid plan or your own key',
  unavailable: 'Not available in Comic Studio yet'
} as const;
export const PRICE_UNPUBLISHED_WARNING = "Price per image isn't published, so you'll see the real cost after the first image";

export const pickerFooter = (parts: { prices: string; rankings?: string[] }) =>
  parts.rankings && parts.rankings.length ? `Prices: ${parts.prices} · Rankings: ${parts.rankings.join(', ')}` : `Prices: ${parts.prices}`;
export const pricesOpenRouter = (time: string) => `OpenRouter, ${time}`;
export const rankingLmarena = (date: string) => `LMArena (${date})`;
/** "via OpenRouter" only when the board data actually came through OpenRouter's benchmarks API. */
export const rankingAa = (date: string, viaOpenRouter: boolean) => (viaOpenRouter ? `Artificial Analysis via OpenRouter (${date})` : `Artificial Analysis (${date})`);

export const COMPARE_ALL = 'Compare all models';
export const SHOW_BEST = 'Show the best fits';
export const SORT_LABEL = 'Sort models by';
export const SORT_OPTIONS = { fit: 'Best fit', price: 'Price', quality: 'Quality', reliability: 'Reliability' } as const;
export const MODELS_LIST_LABEL = 'Image models';
export const detailsFor = (model: string) => `Details for ${model}`;
export const CURRENT_ROW_HINT = 'This comic already uses it.';
export const CHECKING_LIVE = 'Checking live prices and uptime…';
export const couldntLoadLive = (factsAsOf: string) => `Couldn't load live prices or uptime right now, so these come ${fromPriceList(factsAsOf)}.`;
export const TRY_AGAIN = 'Try again';

// Pro table extras (models.md §3.7).
export const pricesByRes = (parts: string[]) => `Per page: ${parts.join(' · ')}`;
export const observedLine = (n: number, kind: string, price: string, range?: string) =>
  `Real cost, your last ${plural(n, kind)}: ${price}${range ? ` (${range})` : ''}`;
export const observedPlatformLine = (n: number, kind: string, price: string, range?: string) =>
  `Real cost, DreamStream creators' last ${plural(n, kind)}: ${price}${range ? ` (${range})` : ''}`;
export const reliabilityLine = (calls: number, failed: number, rateLimited: number, scope: 'you' | 'platform') =>
  `${scope === 'you' ? 'Your' : 'DreamStream'} last 24 h: ${plural(calls, 'call')} · ${failed} failed · ${rateLimited} rate-limited`;

// ── §4.6 Missing data (exact) ────────────────────────────────────────────────────────────────────────────────

export const PRICE_UNPUBLISHED = "Price per image isn't published · you'll see the real cost after the first image";
export const NO_OPENROUTER_PRICE = "OpenRouter doesn't list a price for this model";
export const asOfCouldntRefresh = (time: string) => `as of ${time} · couldn't refresh`;
export const fromPriceList = (factsAsOf: string) => `from our price list, ${factsAsOf}`;
export const NO_UPTIME = 'No uptime data right now';
export const NOT_RANKED = 'Not ranked on public leaderboards yet';
export const NOT_ENOUGH_DATA = 'Not enough data yet';

// ── C. Confirm after the lock ─────────────────────────────────────────────────────────────────────────────────

export const confirmTitleLocked = (next: string) => `Switch this comic to ${next}?`;

export interface DrawnCounts {
  pages: number;
  sheets: number;
  places: number;
  cover: boolean;
}

const drawnNouns = (d: DrawnCounts): string[] => [
  ...(d.pages ? ['pages'] : []),
  ...(d.sheets ? ['character sheets'] : []),
  ...(d.places ? ['places'] : []),
  ...(d.cover ? ['cover'] : [])
];

const joinAnd = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * The lead, in three parts so the emphasis can be bold. With pages, sheets and a cover drawn it is exactly
 * §3.6 C ("Your pages, character sheets and cover were drawn with {Current}…"); a comic with fewer kinds drawn
 * names only those (never a part that was not drawn).
 */
export const confirmLead = (current: string, drawn: DrawnCounts): { before: string; emphasis: string; after: string } => {
  const nouns = drawnNouns(drawn);
  const what = nouns.length ? `Your ${joinAnd(nouns)} were` : 'Your images were';
  return {
    before: `${what} drawn with ${current}. A different model draws faces, colors and line work its own way, so `,
    emphasis: 'character consistency can be affected',
    after: '.'
  };
};
export const confirmLeadText = (current: string, drawn: DrawnCounts) => {
  const l = confirmLead(current, drawn);
  return `${l.before}${l.emphasis}${l.after}`;
};

/** "Already drawn with {Current}: 5 pages · 4 character sheets · cover" — zero parts are left out. */
export const alreadyDrawn = (current: string, d: DrawnCounts) => {
  const parts = [
    ...(d.pages ? [plural(d.pages, 'page')] : []),
    ...(d.sheets ? [plural(d.sheets, 'character sheet')] : []),
    ...(d.places ? [plural(d.places, 'place')] : []),
    ...(d.cover ? ['cover'] : [])
  ];
  return `Already drawn with ${current}: ${parts.join(' · ')}`;
};

export const SCOPE_GROUP_LABEL = 'What should happen to the drawn images?';
export const SCOPE_KEEP = {
  label: 'Keep them as they are',
  sub: (next: string) => `New pages and redraws use ${next}. The book may look mixed.`,
  price: 'Free now'
} as const;
export const SCOPE_PAGES_COVER = {
  label: 'Redraw the pages and cover',
  /** "{n} pages + cover on {New}. Character sheets stay." — the cover / sheets parts only when they exist. */
  sub: (pages: number, cover: boolean, sheetsStay: boolean, next: string) => {
    const what = pages && cover ? `${plural(pages, 'page')} + cover` : pages ? plural(pages, 'page') : 'The cover';
    return `${what} on ${next}.${sheetsStay ? ' Character sheets stay.' : ''}`;
  }
} as const;
export const SCOPE_ALL = {
  label: 'Redraw everything',
  /** "Pages, cover and {m} character sheets." (+ places when any were drawn). */
  sub: (d: DrawnCounts) => {
    const parts = [
      ...(d.pages ? ['Pages'] : []),
      ...(d.cover ? [d.pages ? 'cover' : 'Cover'] : []),
      ...(d.sheets ? [plural(d.sheets, 'character sheet')] : []),
      ...(d.places ? [plural(d.places, 'place')] : [])
    ];
    const text = joinAnd(parts);
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
  }
} as const;
/** Price of a redraw option we cannot price (never a number, never a "$"). */
export const CANT_PRICE_YET = "Can't price yet";

/** "{New}: ≈{$} per page at {res} · holds up to {k} characters per image · {providers line}". */
export const newModelFacts = (next: string, price: string | null, res: Resolution | string, k: number, providers: string) =>
  `${next}: ${price ? `${price} per page at ${res}` : `no published price per page at ${res}`} · holds up to ${plural(k, 'character')} per image · ${providers}`;
/** "{Current}: ≈{$} per page at {res}". */
export const currentModelFacts = (current: string, price: string | null, res: Resolution | string) =>
  `${current}: ${price ? `${price} per page at ${res}` : `no published price per page at ${res}`}`;

export const WARN = {
  /** modelFit 'characters' writes exactly this. */
  characters: (next: string, k: number, page: number, c: number) => `${next} holds up to ${k} characters per image; page ${page} has ${c}.`,
  resolution: (next: string, res: string, size?: { w: number; h: number; w0: number; h0: number }) =>
    `${next} has no ${res} option here.${size ? ` Pages come back ${size.w}×${size.h} (yours are ${size.w0}×${size.h0}).` : ''}`,
  experimental: 'Experimental in Comic Studio.',
  estimate: (next: string) => `This redraw total is an estimate: ${next}'s per-image price isn't published.`,
  noBasis: "We can't price this redraw yet. The first image will show the real cost.",
  overBudget: (price: string) => `This is over your budget by ${price}.`
} as const;

export const keepButton = (current: string) => `Keep ${current}`;
export const switchButton = (next: string) => `Switch to ${next}`;
export const switchRedrawButton = (price: string | null) => (price ? `Switch and redraw · ${price}` : 'Switch and redraw');
export const BYOK_FINE_PRINT = 'Paid by your own key.';
export const SWITCH_BACK_FINE_PRINT = 'You can switch back the same way.';
/** "{basis line}. {BYOK: 'Paid by your own key.'} You can switch back the same way." */
export const confirmFinePrint = (basisLine: string, byok: boolean) =>
  [basisLine ? `${basisLine.replace(/\.$/, '')}.` : '', byok ? BYOK_FINE_PRINT : '', SWITCH_BACK_FINE_PRINT].filter(Boolean).join(' ');
export const basisLine = (labels: string[]) => (labels.length ? `Prices: ${labels.join('; ')}` : '');
export const DETAILS_DISCLOSURE = 'Details';
/** Pro "Details": one redraw line per kind of target, e.g. "Pages (5): ≈$0.89". */
export const redrawDetailLine = (label: string, count: number, price: string | null) => `${label} (${count}): ${price ?? CANT_PRICE_YET}`;

// ── D. Confirm before the lock ───────────────────────────────────────────────────────────────────────────────

export const confirmTitleUnlocked = (next: string) => `Draw this comic with ${next}?`;
export const confirmBodyUnlocked = (next: string) =>
  `Every image in a comic uses one model so characters stay consistent. ${next} will be locked for this comic when the first image is drawn. If you change it later, character consistency can be affected.`;
export const useButton = (next: string) => `Use ${next}`;

// ── E. Tier change after the lock (light confirm in QualityPanel) ───────────────────────────────────────────

export const tierConfirmTitle = (res: Resolution | string) => `Draw new pages at ${res}?`;
/** "Same model ({Model}), so characters stay consistent. The {n} pages already drawn stay at {oldRes} unless you redraw them." */
export const tierConfirmBody = (model: string, drawnPages: number, oldRes: Resolution | string) =>
  `Same model (${model}), so characters stay consistent.${
    drawnPages > 0
      ? ` The ${plural(drawnPages, 'page')} already drawn ${drawnPages === 1 ? 'stays' : 'stay'} at ${oldRes} unless you redraw ${drawnPages === 1 ? 'it' : 'them'}.`
      : ''
  }`;
export const TIER_CANCEL = 'Cancel';
export const tierUseButton = (tier: string) => `Use ${tier}`;

// ── F. Notice after a switch (posted by the server; the chip labels live here so both sides agree) ──────────

export const switchedNotice = (next: string, current: string, pages: number, cover: boolean) => {
  const what = pages && cover ? `${plural(pages, 'page')} and the cover were` : pages ? `${plural(pages, 'page')} ${pages === 1 ? 'was' : 'were'}` : cover ? 'The cover was' : '';
  return what ? `Switched to ${next}. ${what} drawn with ${current} and ${pages + (cover ? 1 : 0) === 1 ? 'stays' : 'stay'} as they are.` : `Switched to ${next}.`;
};
export const switchedRedrawingNotice = (next: string, pages: number, cover: boolean, price: string) => {
  const what = pages && cover ? `${plural(pages, 'page')} and the cover` : pages ? plural(pages, 'page') : 'the cover';
  return `Switched to ${next}. Redrawing ${what} (${price})…`;
};
export const redrawThemChip = (price: string) => `Redraw them · ${price}`;
export const switchBackChip = (current: string) => `Switch back to ${current}`;

// ── Time and dates (pure; `now` passed in) ──────────────────────────────────────────────────────────────────

const toMs = (at: string | number | undefined): number | undefined => {
  if (typeof at === 'number') return Number.isFinite(at) && at > 0 ? at : undefined;
  if (typeof at !== 'string' || !at) return undefined;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : undefined;
};

/** "just now" · "5 min ago" · "3 h ago" · "Oct 20" (older than a day). */
export const ago = (at: string | number | undefined, now: number): string => {
  const ms = toMs(at);
  if (ms === undefined) return 'time unknown';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return dateLabel(ms);
};

/** "Oct 20, 2026" for a board's publish date / an ISO time (UTC, so a date-only string never shifts a day). */
export const dateLabel = (at: string | number | undefined): string => {
  const ms = toMs(at);
  if (ms === undefined) return 'date unknown';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/** 97.72 → "97.7", 100 → "100". */
export const uptimeText = (u: number): string => {
  const r = Math.round(u * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
