// The studio's PriceBook for a surface that quotes (docs/features/pricing.md): the signed-in owner's price sheet
// (services/priceSheet.ts), read when the surface opens and the sheet is missing or stale and again after a drawing run
// settles. Undefined until it arrives: the quote helpers then read the registry list. Shared docs and readers never
// quote, and a viewer who is not the owner gets no sheet (the server answers only for the signed-in caller).

import { anyRenderBusy } from '../../../shared/comic/attention';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { SharedPriceBook } from '../../../shared/comic/priceBook';
import { useAuth } from '../../../contexts/AuthContext';
import { usePriceBook } from '../../../services/priceSheet';

export function useStudioPrices(studio: { doc?: ComicDoc | null } | null | undefined): SharedPriceBook | undefined {
  const { user } = useAuth();
  const doc = studio?.doc ?? null;
  return usePriceBook(user?.id, { busy: doc ? anyRenderBusy(doc) : false, enabled: !!doc });
}
