// Element ids of the Pages grid's cards, so the side panel's parts tree and the breadcrumb can bring one back into view
// (panel/boardPart.ts). A character's card id is CharacterDetail's characterCardId.

/** A page's card in the Pages grid. */
export const pageCardId = (id: string) => `board-page-card-${id}`;
/** The cover's card, which leads the Pages grid. */
export const COVER_CARD_ID = 'board-cover-card';
