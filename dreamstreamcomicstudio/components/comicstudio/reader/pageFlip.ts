// The page flip: the Classic reader's "Page Flip", restored for every reader. The new page swings in from the spine.
//
// The swing is index.css's `pageFlipNext` / `pageFlipPrev` keyframes through `.animate-page-flip-next` (transform-origin
// left center) and `.animate-page-flip-prev` (right center): perspective(1600px) rotateY(∓28deg) scale(0.96) at opacity
// 0.35, landing flat over 0.45 s on cubic-bezier(0.22, 1, 0.36, 1). Transform and opacity only, and index.css turns it
// off under the OS reduced-motion setting. No per-frame JS: a class goes on and comes off once the page has landed.
// Hosts never call this under reduced motion (the OS setting or the reader's own): the page then changes at once.

export const FLIP_NEXT = 'animate-page-flip-next';
export const FLIP_PREV = 'animate-page-flip-prev';
/** The swing's length: index.css's 0.45 s (pageFlip.test.ts pins the two together). */
export const FLIP_MS = 450;
/**
 * How long a turn waits for the incoming page's pictures to decode before it goes anyway: the inline flip (PaperTurnSurface)
 * and the full-screen reader's never-blank hold (BookStage).
 */
export const FLIP_DECODE_MS = 1800;
/** A swipe that turns the page with the flip (it never follows the finger): at least this long, mostly horizontal. */
export const FLIP_SWIPE_PX = 45;

/** Forward swings in from the left spine in a left-to-right book; a right-to-left book mirrors it (the classes swap). */
export const flipClass = (dir: 1 | -1, rtl: boolean): string => ((dir > 0) !== rtl ? FLIP_NEXT : FLIP_PREV);

export interface FlipOptions {
  /** transform-origin for this swing (a spread swings as a pair around its spine). Default: the class's spine edge. */
  origin?: string;
  /** The page has landed (animationend, or FLIP_MS plus a margin when no animation runs). */
  done?: () => void;
}

/**
 * Swing `el` in with `cls` (flipClass). A swing still running on it restarts. Returns a stop that lands the page at once
 * (the class comes off; `done` is not called).
 */
export function playFlip(el: HTMLElement, cls: string, opts: FlipOptions = {}): () => void {
  el.classList.remove(FLIP_NEXT, FLIP_PREV);
  if (opts.origin) el.style.transformOrigin = opts.origin;
  // Reading layout restarts the animation when the same class goes back on (a quick second turn).
  void el.offsetWidth;
  el.classList.add(cls);
  let over = false;
  const land = () => {
    if (over) return false;
    over = true;
    clearTimeout(timer);
    el.removeEventListener('animationend', onEnd);
    el.classList.remove(cls);
    if (opts.origin && el.style.transformOrigin === opts.origin) el.style.transformOrigin = '';
    return true;
  };
  const onEnd = (e: Event) => {
    if (e.target === el && land()) opts.done?.();
  };
  el.addEventListener('animationend', onEnd);
  const timer = setTimeout(() => {
    if (land()) opts.done?.();
  }, FLIP_MS + 120);
  return () => {
    land();
  };
}
