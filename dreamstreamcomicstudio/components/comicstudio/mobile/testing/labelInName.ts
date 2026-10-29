// WCAG 2.5.3 "label in name" for jsdom tests — the same comparison axe-core 4.14's
// `label-content-name-mismatch` makes in the device harness (tests/e2e, a real browser), which needs a
// layout engine and so reports nothing useful in jsdom. Test-only: no component imports this.
//
//   visible text  every DOM text node under the control joined as-is (aria-hidden INCLUDED — a sighted
//                 voice-control user sees it), minus `.sr-only`, `hidden` and display:none subtrees;
//   tokens        NFKD, parentheticals removed, every non-letter/number → a space, lower-case words;
//   pass          the visible words appear, contiguous and in order, inside the accessible name's words.
//
// Note the join: adjacent elements with no whitespace text between them run together ("Board" + "6/12"
// is the words "board6 12"), exactly as axe reads them.

import { computeAccessibleName } from 'dom-accessibility-api';

const hiddenEl = (el: Element): boolean =>
  el.classList.contains('sr-only') || el.hasAttribute('hidden') || (el as HTMLElement).style?.display === 'none';

/** The control's on-screen text as axe reads it. */
export function visibleTextOf(el: Element): string {
  let out = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) out += n.nodeValue || '';
    else if (n.nodeType === 1) {
      const c = n as Element;
      if (c.tagName === 'BR') out += ' ';
      else if (!hiddenEl(c) && c.tagName !== 'svg' && c.tagName !== 'SVG') out += visibleTextOf(c);
    }
  }
  return out;
}

export const nameTokens = (s: string): string[] =>
  s
    .normalize('NFKD')
    .replace(/\([^()]*\)/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/** Does the accessible name contain the visible text (axe's contiguous-words rule)? */
export function labelInName(el: Element): { ok: boolean; visible: string; name: string } {
  const visible = visibleTextOf(el).replace(/\s+/g, ' ').trim();
  const name = computeAccessibleName(el);
  const v = nameTokens(visible);
  const n = nameTokens(name);
  let ok = v.length === 0;
  for (let i = 0; !ok && i + v.length <= n.length; i++) ok = v.every((w, j) => n[i + j] === w);
  return { ok, visible, name };
}
