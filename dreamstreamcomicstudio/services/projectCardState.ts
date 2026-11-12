/**
 * Marks a state object built from a library card (EGRESS-DB E1: the library lists each comic as a state subset).
 * Being an enumerable symbol key, it survives a spread (`{ ...card.state, isFeatured: true }`) but never reaches
 * JSON or storage, so a state DERIVED from a card is recognised (and refused by saveProject) even after the card's
 * id has had its full state loaded. Kept apart from services/db.ts so a component can tell a card from a comic
 * without importing the data layer.
 */
export const CARD_STATE = Symbol.for('dreamstream.projectCardState');

export const isCardState = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && (state as Record<symbol, unknown>)[CARD_STATE] === true;
