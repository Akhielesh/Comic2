// The ways out of an outage, for the banner and the card (reliability.md §3; models.md §2.4 R3/R5).
//
// The server's preflight builds the authoritative list (it knows the user's keys and the live PriceBook) and
// stores it on the `model_outage` card. When the banner sees trouble BEFORE any run was refused (no card yet),
// it builds the same kind of list here from the registry: real list prices from `shared/comic/models.ts`
// (× platform markup unless BYOK), the real number of drawn pages + cover a switch would make inconsistent,
// same-family models first, models that are down or don't fit the comic left out. Never a guessed number: a
// candidate without a price is not offered.

import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import { normalizeOutageOption, type ModelHealth, type OutageOption } from '../../../shared/comic/modelHealth';
import { PLATFORM_MARKUP, QC_USD_PER_PAGE, getImageModel, imagePriceUsd, pickableImageModels } from '../../../shared/comic/models';
import { drawnTargets, modelFit, redrawQuote, redrawResolution, type PriceBook } from '../../../shared/comic/modelLock';
import type { Card } from '../../../shared/comic/doc';

export type OutageCardData = Extract<Card, { type: 'model_outage' }>;
export type SwitchOption = Extract<OutageOption, { kind: 'switch_model' }>;

/** The banner shows at most this many buttons (reliability.md §3). */
export const MAX_BANNER_OPTIONS = 3;
/** Same as the server (health.ts MAX_SWITCH_OPTIONS). */
export const MAX_SWITCH_OPTIONS = 2;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Registry list prices as a PriceBook (mirrors server health.ts registryPriceBook). */
export const registryPriceBook = (): PriceBook => ({
  unit: (modelId, res) => {
    const spec = getImageModel(modelId);
    if (!spec) return { usd: null, basis: 'unknown model' };
    return { usd: imagePriceUsd(spec, res), basis: `list price from ${spec.factsAsOf}` };
  },
  qcUsd: QC_USD_PER_PAGE
});

/** Switch options from the registry for a comic whose model is in trouble (never the blocked model itself). */
export const registrySwitchOptions = (input: {
  doc: ComicDoc;
  blockedModelId: string;
  caps: StudioCaps;
  /** Latest health per candidate id (a known-down candidate is never offered). */
  health?: Record<string, ModelHealth | undefined>;
}): SwitchOption[] => {
  const blocked = getImageModel(input.blockedModelId);
  const byok = !!input.caps.byok;
  const markup = byok ? 1 : PLATFORM_MARKUP;
  const book = registryPriceBook();
  const targets = drawnTargets(input.doc);
  const redrawCount = targets.pages.length + (targets.cover ? 1 : 0);
  const candidates: { id: string; nickname: string; vendor: string; usdPerImage: number }[] = [];
  for (const spec of pickableImageModels()) {
    if (spec.id === input.blockedModelId) continue;
    if (modelFit(spec, input.doc, input.caps).some((r) => r.severity === 'block')) continue;
    if (input.health?.[spec.id]?.state === 'down') continue;
    const unit = book.unit(spec.id, redrawResolution(input.doc, spec.id, 'page'), 'page').usd;
    if (unit === null || !Number.isFinite(unit)) continue;
    candidates.push({ id: spec.id, nickname: spec.nickname, vendor: spec.vendor, usdPerImage: round4(unit * markup) });
  }
  candidates.sort((a, b) => {
    const fa = a.vendor === blocked?.vendor ? 0 : 1;
    const fb = b.vendor === blocked?.vendor ? 0 : 1;
    return fa - fb || a.usdPerImage - b.usdPerImage || a.id.localeCompare(b.id);
  });
  return candidates.slice(0, MAX_SWITCH_OPTIONS).map((c) => ({
    kind: 'switch_model',
    modelId: c.id,
    nickname: c.nickname,
    usdPerImage: c.usdPerImage,
    consistency: c.vendor === blocked?.vendor ? 'same_family' : 'different',
    redrawCount,
    redrawUsd: round4(redrawQuote(input.doc, c.id, 'pages_cover', book, byok).usd ?? 0)
  }));
};

/** The newest outage card in the conversation for a model (its options are the server's, with live prices). */
export const latestOutageCard = (doc: ComicDoc | null | undefined, modelId?: string): OutageCardData | undefined => {
  const messages = doc?.conversation || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cards = messages[i]?.cards || [];
    for (let j = cards.length - 1; j >= 0; j -= 1) {
      const c = cards[j];
      if (c?.type === 'model_outage' && (!modelId || c.modelId === modelId)) return c as OutageCardData;
    }
  }
  return undefined;
};

/** Well-formed options only (a card from an older or newer server never renders a broken button). */
export const cleanOptions = (options: readonly unknown[] | undefined): OutageOption[] =>
  (options || []).map((o) => normalizeOutageOption(o)).filter((o): o is OutageOption => !!o);

/**
 * The banner's buttons (≤ 3): the card's own options when one exists for this model, else wait + registry
 * switches. `wait_and_retry` needs something to retry, so without a blocked action it is left out (the banner
 * already says it keeps checking while the page is open).
 */
export const bannerOptions = (input: {
  doc: ComicDoc;
  modelId: string;
  caps: StudioCaps;
  health?: Record<string, ModelHealth | undefined>;
}): { options: OutageOption[]; card?: OutageCardData } => {
  const card = latestOutageCard(input.doc, input.modelId);
  const base = card ? cleanOptions(card.options) : registrySwitchOptions({ doc: input.doc, blockedModelId: input.modelId, caps: input.caps, health: input.health });
  const usable = base.filter((o) => (o.kind === 'wait_and_retry' || o.kind === 'other_route' ? !!card?.blockedAction : true));
  return { options: usable.slice(0, MAX_BANNER_OPTIONS), ...(card ? { card } : {}) };
};
