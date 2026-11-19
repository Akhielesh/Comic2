// The tab-title count (notify SPEC §5.7): while alerts wait for the person (the tab hidden, or the window behind
// another app), the tab reads "(2) Spice Market". The prefix is kept on whatever title any page sets — ComicStudio's
// own title and its restore at unmount included — by one MutationObserver on <head> that strips its own prefix from
// the title it sees and puts the current one back, so no page needs to know about it. The space after ")" is a no-break
// space, so a person's own "(1) Origins" (an ordinary space) is never taken for the prefix. Above nine it reads "(9+)".
// At 0 the prefix is stripped once and the observer is disconnected. No timer.

const NBSP = ' ';
const PREFIX = /^\(\d{1,2}\+?\) /;

let count = 0;
let observer: MutationObserver | null = null;

/** The title without our prefix (repeated prefixes too). */
export const stripTabBadge = (title: string): string => {
  let out = typeof title === 'string' ? title : '';
  while (PREFIX.test(out)) out = out.replace(PREFIX, '');
  return out;
};

const label = (n: number): string => `(${n > 9 ? '9+' : n})${NBSP}`;

const apply = () => {
  if (typeof document === 'undefined') return;
  try {
    const base = stripTabBadge(document.title);
    const want = count > 0 ? `${label(count)}${base}` : base;
    if (document.title !== want) document.title = want;
  } catch {
    /* a document without a title: nothing to badge */
  }
};

const watch = () => {
  if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.head) return;
  try {
    observer = new MutationObserver(() => apply());
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  } catch {
    observer = null;
  }
};

/** Shows `n` waiting alerts on the tab title (0 clears it). */
export function setTabBadge(n: number): void {
  const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  count = next;
  if (next > 0) watch();
  apply();
  if (next === 0) {
    observer?.disconnect();
    observer = null;
  }
}

/** The count on the tab now. */
export const tabBadgeCount = (): number => count;

/** Test seam. */
export function __resetTabBadgeForTests(): void {
  observer?.disconnect();
  observer = null;
  count = 0;
}
