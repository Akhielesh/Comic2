// Read-only fast intents (contract §12.8). Wave-0 stub by P0-B; owned in wave 1 by
// P1-DIRECTOR, which replaces routeIntent IN PLACE.
//
// The stream route asks routeIntent before the director: "show me the pages" or "draw
// everything" on a fully drawn, fresh book answers instantly and for $0 (a breakdown card
// and next steps) instead of a model call. Structural intents are P2 (COMIC_FAST_INTENTS).
// Stub behaviour: never matches (null) — every turn goes to the director.

import type { Card, ComicDoc, NextStep } from '../../../shared/comic/doc.js';

export interface RoutedIntent {
  kind: 'show_pages' | 'nothing_to_draw';
  reply: string;
  cards: Card[];
  nextSteps: NextStep[];
}

export function routeIntent(_doc: ComicDoc, _text: string): RoutedIntent | null {
  return null;
}
