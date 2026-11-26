// Which part of the board the person is on (SH-C2): the character, page or cover card that holds focus or was last
// pressed inside the board's panel, for the parts tree's current row and the breadcrumb's last crumb. And the way back to
// a part: bring its card into view and put focus on it. Cards carry these ids: a character's (CharacterDetail
// characterCardId), and a page's and the cover's in the Pages grid (PagesTab).

import { useEffect, useState } from 'react';
import { characterCardId } from './CharacterDetail';
import { COVER_CARD_ID, pageCardId } from './cardIds';
import { createBoardPartStore, type BoardPartStore } from './boardPartStore';
import type { BoardPart } from '../panel/partsModel';

/** The board's scrolling panel (BoardPane). */
export const BOARD_PANEL_ID = 'board-panel';

const CHARACTER_PREFIX = characterCardId('');
const PAGE_PREFIX = pageCardId('');
const CARD_SELECTOR = `[id^="${CHARACTER_PREFIX}"], [id^="${PAGE_PREFIX}"], #${COVER_CARD_ID}`;

export const partElementId = (part: BoardPart): string =>
  part.kind === 'character' ? characterCardId(part.id) : part.kind === 'page' ? pageCardId(part.id) : COVER_CARD_ID;

/** The part an element sits in (its card), or null. */
export const partOfElement = (el: Element | null | undefined): BoardPart | null => {
  const card = typeof el?.closest === 'function' ? el.closest(CARD_SELECTOR) : null;
  if (!card) return null;
  if (card.id === COVER_CARD_ID) return { kind: 'cover' };
  if (card.id.startsWith(CHARACTER_PREFIX)) return { kind: 'character', id: card.id.slice(CHARACTER_PREFIX.length) };
  return { kind: 'page', id: card.id.slice(PAGE_PREFIX.length) };
};

/**
 * Track the card the person is on in the board: set when focus or a press lands inside one, cleared when it lands
 * elsewhere in the board (focus in the conversation, the header or the side panel keeps it, so the tree and the
 * breadcrumb still say where on the board they were). Listens on the document, so it costs nothing per card. The part
 * lives in a store (board/boardPartStore.ts), not in the caller's state: the shell calls this and never re-renders for a
 * move between cards; the tree and the breadcrumb read it with useBoardPart(store).
 */
export function useBoardPartTracker(): BoardPartStore {
  const [store] = useState(createBoardPartStore);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onEvent = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const board = document.getElementById(BOARD_PANEL_ID);
      if (!target || !board || !board.contains(target)) return;
      store.set(partOfElement(target));
    };
    document.addEventListener('focusin', onEvent);
    document.addEventListener('pointerdown', onEvent, { passive: true });
    return () => {
      document.removeEventListener('focusin', onEvent);
      document.removeEventListener('pointerdown', onEvent);
    };
  }, [store]);
  return store;
}

const later = (run: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
};

const scrollTo = (el: HTMLElement, reducedMotion: boolean, block: ScrollLogicalPosition) => {
  if (typeof el.scrollIntoView !== 'function') return;
  try {
    el.scrollIntoView({ block, inline: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  } catch {
    el.scrollIntoView();
  }
};

/** Focus a card that is not focusable itself, for this visit only (its tabindex goes again when focus leaves). */
const focusCard = (el: HTMLElement) => {
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1');
    el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
  }
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
};

/**
 * Bring a part's card into view and put focus on it, once its tab has rendered (a few frames at most; a card that never
 * appears, such as a character just removed, is left alone). Runs after a drawer closes and hands focus back.
 */
export const revealPart = (part: BoardPart, { reducedMotion = false }: { reducedMotion?: boolean } = {}): void => {
  if (typeof document === 'undefined') return;
  let tries = 0;
  const attempt = () => {
    const el = document.getElementById(partElementId(part));
    if (!el) {
      tries += 1;
      if (tries < 8) later(attempt);
      return;
    }
    scrollTo(el, reducedMotion, 'start');
    focusCard(el);
  };
  later(() => later(attempt));
};

/** Back to the top of the open board tab: the panel scrolls up and takes focus, so no card is the current part. */
export const revealBoardTop = ({ reducedMotion = false }: { reducedMotion?: boolean } = {}): void => {
  if (typeof document === 'undefined') return;
  later(() => {
    const panel = document.getElementById(BOARD_PANEL_ID);
    if (!panel) return;
    if (typeof panel.scrollTo === 'function') {
      try {
        panel.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
      } catch {
        panel.scrollTop = 0;
      }
    } else panel.scrollTop = 0;
    focusCard(panel);
  });
};
