// What one standalone image costs, said beside Generate (docs/features/pricing.md § Images workspace).
//
// The same quote path as every comic surface: the person's PriceBook from their price sheet (services/priceSheet.ts,
// read when the workspace opens; the registry list only if that read failed), `jobQuote` on the route's model at the
// size Generate sends ('native' is 1K), with the references the model really receives on the list basis (Flash gets at
// most three: more are combined into numbered sheets). Generating is a small paid step the person asks for directly,
// so it starts at once and states its cost here.
//
// Who pays decides the words, through the studio's one formatter (conversation/cost.ts): the person's own key reads
// dollars ("≈ $0.04 an image on your OpenRouter key"); DreamStream's allowance reads a share of the usage for a
// governed person ("≈0.4% of your usage an image") — never dollars, even before their share is known — and dollars
// only for an admin or an exempt account. Muted ink, no colour beside the price. Nothing shows until the route is
// known, and a model with no published price shows nothing rather than a guess.

import React, { useSyncExternalStore } from 'react';
import type { Resolution } from '../../shared/comic/doc';
import { getImageModel } from '../../shared/comic/models';
import { registryPriceBook, type SharedPriceBook } from '../../shared/comic/priceBook';
import type { StandaloneRoute, WorkspaceQuality } from '../../shared/standaloneImage';
import { UNKNOWN_USAGE_SHARE } from '../../services/costDisplay';
import { priceSheetFor, subscribePriceSheet, usePriceBook } from '../../services/priceSheet';
import { useCostFormat, type CostFormat } from '../comicstudio/conversation/cost';

/** Flash takes this many reference images; more are combined into that many sheets (server standaloneReferences). */
export const NATIVE_REFERENCE_SLOTS = 3;

/** The size Generate sends for a workspace quality. */
export const standaloneResolution = (quality: WorkspaceQuality): Resolution => (quality === 'native' ? '1K' : quality);

/** The reference images the model receives (Flash: at most three sheets; individual references: every one). */
export const standaloneRefsSent = (quality: WorkspaceQuality, refs: number): number => {
  const n = Number.isFinite(refs) && refs > 0 ? Math.floor(refs) : 0;
  return quality === 'native' ? Math.min(NATIVE_REFERENCE_SLOTS, n) : n;
};

/**
 * One standalone image's quote for this person: the book's job quote on the route's model ('image': no page check,
 * no comic kind's observed median), × markup unless the person's own key pays. Null when the model has no price.
 */
export const standaloneQuoteUsd = (book: SharedPriceBook, route: Pick<StandaloneRoute, 'model' | 'payer'>, quality: WorkspaceQuality, refs: number): number | null => {
  const spec = getImageModel(route.model) ?? getImageModel(route.model.replace(/^google\//, ''));
  if (!spec) return null;
  const q = book.jobQuote(spec.id, standaloneResolution(quality), 'image', { refs: standaloneRefsSent(quality, refs), byok: route.payer === 'personal' });
  return q.usd;
};

const providerName = (p: StandaloneRoute['provider']) => (p === 'openrouter' ? 'OpenRouter' : 'Gemini');

/** The sentence (pure): "≈ $0.04 an image on your OpenRouter key" · "≈0.4% of your usage an image" · "Each image uses a little of your usage". */
export const imagePriceWords = (usd: number, route: Pick<StandaloneRoute, 'provider' | 'payer'>, cost: CostFormat): { text: string; spoken: string } => {
  const amount = cost.approx(usd);
  if (amount === 'Free') return { text: 'Free', spoken: 'This image is free.' };
  if (amount === UNKNOWN_USAGE_SHARE) return { text: `Each image ${amount}`, spoken: `Each image ${amount}.` };
  const on = route.payer === 'personal' ? ` on your ${providerName(route.provider)} key` : '';
  return { text: `${amount} an image${on}`, spoken: `Each image costs ${cost.spoken(usd)}${on}.` };
};

export interface ImagePriceProps {
  userId: string;
  route: StandaloneRoute | null;
  quality: WorkspaceQuality;
  refs: number;
  /** For the Generate button's aria-describedby. */
  id?: string;
}

export const ImagePrice: React.FC<ImagePriceProps> = ({ userId, route, quality, refs, id }) => {
  const book = usePriceBook(userId);
  // The registry's dated list only when the sheet could not be read (never while it is on its way: one true price).
  const failed = useSyncExternalStore(subscribePriceSheet, () => priceSheetFor(userId).failedAt > 0, () => false);
  const cost = useCostFormat({ byok: route?.payer === 'personal' });
  const priced = book ?? (failed ? registryPriceBook() : undefined);
  if (!route || !priced) return null;
  const usd = standaloneQuoteUsd(priced, route, quality, refs);
  if (usd === null) return null;
  const words = imagePriceWords(usd, route, cost);
  return (
    <p className="image-usage image-price" id={id} data-image-price="">
      <span aria-hidden="true" className="tabular-nums">{words.text}</span>
      <span className="sr-only">{words.spoken}</span>
    </p>
  );
};

export default ImagePrice;
