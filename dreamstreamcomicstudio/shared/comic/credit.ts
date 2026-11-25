// The `credit` conversation card (docs/features/credit-safety.md): money is the reason a paid step did not run.
//
//   stopped  a drawing run reached a key that is out of credit (or has no image quota) part-way: the pages it had not
//            started stay not started and cost nothing, and the card says what to do (top up, or switch key).
//   short    a paid step was about to start and its quote is more than the key or the allowance has left: nothing
//            started; the card says what the step needs and what is left, with "Draw what fits" where that makes sense.
//
// Who pays decides the words: `own_key` cards may carry dollar amounts (the person's own provider balance), and
// `allowance` cards never do: they carry percentages of DreamStream's included usage only, so no dollar figure about
// the allowance is ever stored where a governed person's doc can show it.
//
// The server writes these cards; normalizeCreditCard is run on every stored doc (doc.ts normalizeCards), so a malformed
// card is dropped and an action the card offers is kept only when it is one of the image spends a run can carry (the
// server validates the whole action again when the client sends it, as it does for every action).

import type { StudioAction } from './ops.js';

export type CreditPayer = 'own_key' | 'allowance';
export type CreditProvider = 'openrouter' | 'gemini';

/** A spend the card offers as a button, with the quote it was priced at (the button shows it). */
export interface CreditOffer {
  action: StudioAction;
  /** The quote in charged USD (the client words it for the viewer: dollars, or a share of the usage). */
  usd: number;
}

export interface CreditCard {
  type: 'credit';
  id: string;
  reason: 'stopped' | 'short';
  payer: CreditPayer;
  /** own_key: the provider whose key refused or is short. */
  provider?: CreditProvider;
  /** stopped: the key has no image quota at all (a Google project without billing), not spent credit. */
  noQuota?: boolean;
  /** stopped: pictures the run drew before it stopped, and pictures it never started. */
  drawn?: number;
  notStarted?: number;
  /** short: the step in words ("3 pages and the cover"). */
  what?: string;
  /** short, own key: the step's quote and what the key has left, in USD, and when the provider reported it. */
  needUsd?: number;
  leftUsd?: number;
  checkedAt?: number;
  /** short, allowance: the step's share of the usage (null when unknown) and the share left, 0..100. */
  needPct?: number | null;
  leftPct?: number;
  /** short: the leading pages whose quote fits ("Draw what fits"). */
  fits?: CreditOffer & { pages: number };
  /** stopped: what the run did not start, quoted ("Draw the rest"). */
  rest?: CreditOffer;
}

/** The image spends a credit card may offer again (Draw what fits / Draw the rest). */
const CREDIT_ACTION_TYPES: ReadonlySet<string> = new Set(['render_pages', 'render_cover', 'render_sheets', 'render_style_options', 'edit_page', 'fix_panel']);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : undefined);
const money = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v * 1e6) / 1e6 : undefined);
const pct = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : undefined);

const offerOf = (v: unknown): CreditOffer | undefined => {
  if (!isObject(v) || !isObject(v.action) || typeof v.action.type !== 'string' || !CREDIT_ACTION_TYPES.has(v.action.type)) return undefined;
  const usd = money(v.usd);
  return usd === undefined || usd <= 0 ? undefined : { action: v.action as unknown as StudioAction, usd };
};

/** A well-formed credit card, or undefined (dropped). Unknown fields go; dollar fields never survive on an allowance card. */
export function normalizeCreditCard(value: unknown): CreditCard | undefined {
  if (!isObject(value) || value.type !== 'credit' || typeof value.id !== 'string' || !value.id) return undefined;
  if (value.reason !== 'stopped' && value.reason !== 'short') return undefined;
  if (value.payer !== 'own_key' && value.payer !== 'allowance') return undefined;
  const card: CreditCard = { type: 'credit', id: value.id, reason: value.reason, payer: value.payer };
  if (value.payer === 'own_key' && (value.provider === 'openrouter' || value.provider === 'gemini')) card.provider = value.provider;
  if (value.noQuota === true) card.noQuota = true;
  const drawn = count(value.drawn);
  const notStarted = count(value.notStarted);
  if (drawn !== undefined) card.drawn = drawn;
  if (notStarted !== undefined) card.notStarted = notStarted;
  if (typeof value.what === 'string' && value.what.trim()) card.what = value.what.trim().slice(0, 160);
  if (card.payer === 'own_key') {
    const need = money(value.needUsd);
    const left = money(value.leftUsd);
    if (need !== undefined) card.needUsd = need;
    if (left !== undefined) card.leftUsd = left;
    if (typeof value.checkedAt === 'number' && Number.isSafeInteger(value.checkedAt) && value.checkedAt > 0) card.checkedAt = value.checkedAt;
  } else {
    const left = pct(value.leftPct);
    if (left !== undefined) card.leftPct = left;
    if (value.needPct === null) card.needPct = null;
    else {
      const need = pct(value.needPct);
      if (need !== undefined) card.needPct = need;
    }
  }
  const fits = offerOf(value.fits);
  const pages = isObject(value.fits) ? count(value.fits.pages) : undefined;
  if (fits && pages) card.fits = { ...fits, pages };
  const rest = offerOf(value.rest);
  if (rest) card.rest = rest;
  return card;
}
