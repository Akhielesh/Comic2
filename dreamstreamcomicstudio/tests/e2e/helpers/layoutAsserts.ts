// Shared layout assertions (P1-QA): mobile.md §10.3 + the visualqa.md §0/§7 detector, as ONE scanner.
//
// `scanLayout(page, opts)` runs a single in-page pass and returns findings for the requested checks:
//   overflow       page-level horizontal scroll (scrollWidth > innerWidth + 1)
//   offscreen      a visible element beyond [−1, innerWidth+1] with no overflow-x container around it
//   clip           text/controls clipped by a non-scrolling overflow:hidden ancestor (line-clamp and
//                  ellipsis count as intended truncation; the walk stops at scroll containers)
//   self-clip      text cut by its own overflow:hidden without an ellipsis / line clamp
//   spill          text spilling out of an overflow:visible box (long unbroken words, URLs)
//   input-clip     a one-line field whose value is cut with no ellipsis
//   textarea-clip  a textarea that did not re-measure (content taller than the box, not capped)
//   collision      two text runs/controls visibly overlapping (≥ 12 px² and ≥ 12 % of the smaller);
//                  popovers over content and fully covered content are layering, not collisions
//   popover        a dialog / menu / listbox / tooltip box outside the viewport
//   balloon-*      a lettered balloon outside its comic page; two balloons overlapping > 8 %
//   editor-aside   the page editor's tools aside overflowing its dialog or the viewport
//   phone-content  phones: the board panel / message list gets < 45 % of the viewport height
//   hit-target     coarse pointers: probes at the centre ±(21, 21) must all land on the control
//   hover-only     touch: a live control drawn at < 0.6 effective opacity (revealed only by hover)
//   safe-area      an interactive element inside the emulated notch / home-indicator bands
//   hinge          dual-screen: an interactive element straddling the fold; panes off their segments
//   landmarks      exactly one visible <main>; a <nav> whenever the tab bar or rail is shown
//   layout-class   the studio root's data-layout differs from the device's expected layout
// `runAxe` adds axe-core serious/critical violations (color-contrast included) as `axe` findings.
// `expectLayoutClean` triages findings against tests/e2e/allowlist.json and fails softly on new ones.

import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { describeFinding, triage, type CheckId, type Finding, type Where } from './allowlist';
import type { ComicDevice, Insets } from '../devices';

export type { Finding, CheckId };

export interface ScanOptions {
  checks?: CheckId[];
  device?: ComicDevice;
  /** Safe-area insets in force (setSafeAreas); enables the safe-area check. */
  safeArea?: Insets | null;
  /** Hinge band (dual-screen); enables the hinge check. */
  hinge?: { start: number; end: number } | null;
  /** Expected studio layout (data-layout on the shell root). */
  expectLayout?: string | null;
  /** Phone content share floor (visualqa P1-6). */
  minContentShare?: number;
}

/** Every DOM check (axe and console are added by expectLayoutClean). */
export const LAYOUT_CHECKS: CheckId[] = ['overflow', 'offscreen', 'clip', 'self-clip', 'spill', 'input-clip', 'textarea-clip', 'collision', 'popover', 'balloon-outside', 'balloon-collision', 'editor-aside', 'phone-content', 'landmarks', 'layout-class'];
export const TOUCH_CHECKS: CheckId[] = ['hit-target', 'hover-only', 'safe-area', 'hinge'];

interface DetectArgs {
  checks: string[];
  safeArea: Insets | null;
  hinge: { start: number; end: number } | null;
  expectLayout: string | null;
  phone: boolean;
  minContentShare: number;
}

/* The in-page detector. Self-contained: Playwright ships its source to the page. */
function detect(args: DetectArgs) {
  const on = (c: string) => args.checks.includes(c);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out: Array<{ check: string; sig: string; label: string; ctx: string; testid?: string; rect?: number[]; detail?: string }> = [];
  const de = document.documentElement;

  const clsOf = (el: Element) => (typeof (el as HTMLElement).className === 'string' ? ((el as HTMLElement).className as string) : el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
  const sig = (el: Element) => `${el.tagName.toLowerCase()}${clsOf(el).slice(0, 6).map((c) => '.' + c).join('')}`.slice(0, 160);
  const labelOf = (el: Element) => {
    const h = el as HTMLElement;
    const v = (el.getAttribute('aria-label') || (h as HTMLInputElement).value || h.innerText || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    return v.slice(0, 60);
  };
  const ctxOf = (el: Element) => {
    const parts: string[] = [];
    let a: Element | null = el.parentElement;
    while (a && a !== document.body && parts.length < 3) {
      const lab = a.getAttribute('aria-label') || (a.id ? '#' + a.id : null) || (a.getAttribute('role') === 'dialog' ? 'dialog' : null);
      if (lab) parts.push(lab.slice(0, 40));
      a = a.parentElement;
    }
    return parts.join(' < ');
  };
  const testidOf = (el: Element) => el.closest('[data-testid]')?.getAttribute('data-testid') || undefined;
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  };
  const push = (check: string, el: Element, detail?: string) => out.push({ check, sig: sig(el), label: labelOf(el), ctx: ctxOf(el), testid: testidOf(el), rect: rectOf(el), detail });

  const visible = (el: Element) => {
    const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
    if (anyEl.checkVisibility && !anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const dormant = (el: Element) => !!el.closest('[inert],[aria-hidden="true"],.sr-only');
  const inBalloon = (el: Element) => !!el.closest('[data-testid="balloon"],[data-testid="balloon-hit"],.ds-lettering-balloon');
  const inSvg = (el: Element) => !!el.closest('svg');
  const hasOwnText = (el: Element) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim());
  const isCtl = (el: Element) => /^(BUTTON|INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.getAttribute('role') === 'button';
  const csCache = new Map<Element, CSSStyleDeclaration>();
  const cs = (el: Element) => {
    let c = csCache.get(el);
    if (!c) {
      c = getComputedStyle(el);
      csCache.set(el, c);
    }
    return c;
  };
  const truncatesByDesign = (el: Element) => {
    let a: Element | null = el;
    for (let i = 0; a && i < 6; i++, a = a.parentElement) {
      const s = cs(a);
      if (s.textOverflow === 'ellipsis') return true;
      if ((s as unknown as { webkitLineClamp?: string }).webkitLineClamp && (s as unknown as { webkitLineClamp?: string }).webkitLineClamp !== 'none') return true;
      if (/(^|\s)(line-clamp-\d|truncate)(\s|$)/.test(clsOf(a).join(' '))) return true;
    }
    return false;
  };

  const all = Array.from(document.body.querySelectorAll('*'));

  // ── overflow / offscreen ───────────────────────────────────────────────────
  if (on('overflow')) {
    const sw = Math.max(de.scrollWidth, document.body.scrollWidth);
    if (sw > vw + 1) out.push({ check: 'overflow', sig: 'html', label: 'document', ctx: '', detail: `scrollWidth=${sw} innerWidth=${vw}` });
  }
  if (on('offscreen')) {
    const reported: Element[] = [];
    for (const el of all) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || inSvg(el) || dormant(el) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!(r.right > vw + 1 || r.left < -1)) continue;
      let contained = false;
      for (let a = el.parentElement; a && a !== de; a = a.parentElement) {
        if (cs(a).overflowX !== 'visible') {
          contained = true;
          break;
        }
      }
      if (contained || reported.some((p) => p.contains(el))) continue;
      reported.push(el);
      push('offscreen', el, `left=${Math.round(r.left)} right=${Math.round(r.right)} innerWidth=${vw}`);
    }
  }

  // ── text elements ──────────────────────────────────────────────────────────
  const textEls: Array<{ el: Element; ctl: boolean; own: boolean }> = [];
  for (const el of all) {
    if (inSvg(el) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'OPTION') continue;
    const ctl = isCtl(el);
    const own = hasOwnText(el);
    if (!ctl && !own) continue;
    if (el.getAttribute('type') === 'file' || el.getAttribute('type') === 'hidden' || (el as HTMLElement).hidden) continue;
    if (dormant(el) || !visible(el)) continue;
    textEls.push({ el, ctl, own });
  }

  if (on('clip')) {
    for (const { el } of textEls) {
      if (inBalloon(el) || truncatesByDesign(el)) continue;
      const r = el.getBoundingClientRect();
      let stopX = false;
      let stopY = false;
      let hit: string | null = null;
      for (let a = el.parentElement; a && a !== de; a = a.parentElement) {
        const s = cs(a);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
          const ar = a.getBoundingClientRect();
          const hx = !stopX && /(hidden|clip)/.test(s.overflowX);
          const hy = !stopY && /(hidden|clip)/.test(s.overflowY);
          const overR = r.right - ar.right;
          const overL = ar.left - r.left;
          const overB = r.bottom - ar.bottom;
          const overT = ar.top - r.top;
          if ((hx && (overR > 3 || overL > 3)) || (hy && (overB > 3 || overT > 3))) {
            hit = `clipped by ${sig(a)}${a.getAttribute('aria-label') ? ` "${a.getAttribute('aria-label')}"` : ''} (r=${Math.round(overR)} l=${Math.round(overL)} b=${Math.round(overB)} t=${Math.round(overT)})`;
            break;
          }
          if (/(auto|scroll)/.test(s.overflowX)) stopX = true;
          if (/(auto|scroll)/.test(s.overflowY)) stopY = true;
          if (stopX && stopY) break;
        }
      }
      if (hit) push('clip', el, hit);
    }
  }

  if (on('self-clip') || on('spill')) {
    for (const { el, own } of textEls) {
      if (!own || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || inBalloon(el)) continue;
      const s = cs(el);
      const h = el as HTMLElement;
      if (h.clientWidth === 0) continue;
      const dx = h.scrollWidth - h.clientWidth;
      const dy = h.scrollHeight - h.clientHeight;
      if (on('self-clip')) {
        if (/(hidden|clip)/.test(s.overflowX) && dx > 1 && s.textOverflow !== 'ellipsis') push('self-clip', el, `x by ${dx}px, no ellipsis`);
        else if (/(hidden|clip)/.test(s.overflowY) && dy > 2 && !truncatesByDesign(el)) push('self-clip', el, `y by ${dy}px, no line clamp`);
      }
      if (on('spill') && s.overflowX === 'visible' && dx > 2 && s.display !== 'inline' && !truncatesByDesign(el)) {
        // Measure the TEXT, not scrollWidth: hit-area pseudo-elements (.tap-target::after) widen
        // scrollWidth without any text leaving the box.
        const box = el.getBoundingClientRect();
        let over = 0;
        for (const n of Array.from(el.childNodes)) {
          if (n.nodeType !== 3 || !(n.textContent || '').trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const rr of Array.from(range.getClientRects())) over = Math.max(over, rr.right - box.right, box.left - rr.left);
        }
        if (over > 2) push('spill', el, `text spills ${Math.round(over)}px`);
      }
    }
  }

  if (on('input-clip')) {
    for (const el of Array.from(document.querySelectorAll('input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"]'))) {
      const i = el as HTMLInputElement;
      if (!i.value || dormant(el) || !visible(el) || document.activeElement === el) continue;
      if (i.scrollWidth > i.clientWidth + 1 && cs(el).textOverflow !== 'ellipsis') push('input-clip', el, `value ${i.scrollWidth}px in ${i.clientWidth}px, no ellipsis`);
    }
  }
  if (on('textarea-clip')) {
    for (const el of Array.from(document.querySelectorAll('textarea'))) {
      const t = el as HTMLTextAreaElement;
      if (!t.value || dormant(el) || !visible(el)) continue;
      const s = cs(el);
      const maxH = parseFloat(s.maxHeight);
      const capped = Number.isFinite(maxH) && t.clientHeight >= maxH - 4 - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
      if (t.scrollHeight > t.clientHeight + 2 && !capped) push('textarea-clip', el, `content ${t.scrollHeight}px in ${t.clientHeight}px`);
    }
  }

  // ── collisions ─────────────────────────────────────────────────────────────
  if (on('collision')) {
    type R = { left: number; top: number; right: number; bottom: number; width: number; height: number };
    const clipCache = new Map<Element, R>();
    const viewportR: R = { left: 0, top: 0, right: vw, bottom: vh, width: vw, height: vh };
    const clipOf = (el: Element | null): R => {
      if (!el || el === de) return viewportR;
      const hit = clipCache.get(el);
      if (hit) return hit;
      const parent = clipOf(el.parentElement);
      const s = cs(el);
      let c = parent;
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const r = el.getBoundingClientRect();
        const left = s.overflowX !== 'visible' ? Math.max(parent.left, r.left) : parent.left;
        const right = s.overflowX !== 'visible' ? Math.min(parent.right, r.right) : parent.right;
        const top = s.overflowY !== 'visible' ? Math.max(parent.top, r.top) : parent.top;
        const bottom = s.overflowY !== 'visible' ? Math.min(parent.bottom, r.bottom) : parent.bottom;
        c = { left, right, top, bottom, width: right - left, height: bottom - top };
      }
      clipCache.set(el, c);
      return c;
    };
    const clipRect = (r: DOMRect | R, c: R): R | null => {
      const left = Math.max(r.left, c.left);
      const right = Math.min(r.right, c.right);
      const top = Math.max(r.top, c.top);
      const bottom = Math.min(r.bottom, c.bottom);
      return right - left > 1 && bottom - top > 1 ? { left, right, top, bottom, width: right - left, height: bottom - top } : null;
    };
    const items = textEls
      .filter((o) => !inBalloon(o.el))
      .map((o) => {
        const raw: Array<DOMRect> = [];
        if (o.ctl && !o.own) raw.push(o.el.getBoundingClientRect());
        else {
          for (const n of Array.from(o.el.childNodes)) {
            if (n.nodeType !== 3 || !(n.textContent || '').trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            for (const rr of Array.from(range.getClientRects())) if (rr.width > 1 && rr.height > 1) raw.push(rr);
          }
          if (o.ctl) raw.push(o.el.getBoundingClientRect());
        }
        const c = clipOf(o.el);
        const rects = raw.map((r) => clipRect(r, c)).filter((r): r is R => !!r);
        let box: R | null = null;
        for (const r of rects) box = box ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom), width: 0, height: 0 } : { ...r };
        return { el: o.el, rects, box };
      })
      .filter((o) => o.rects.length && o.box);
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const A = items[i];
      for (let j = i + 1; j < items.length; j++) {
        const B = items[j];
        const a = A.box!;
        const b = B.box!;
        if (a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top) continue;
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        let best: { area: number; frac: number; cx: number; cy: number } | null = null;
        for (const ra of A.rects)
          for (const rb of B.rects) {
            const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (w <= 1 || h <= 1) continue;
            const area = w * h;
            const small = Math.min(ra.width * ra.height, rb.width * rb.height);
            if (area < 12 || area / small < 0.12) continue;
            if (!best || area > best.area) best = { area, frac: area / small, cx: Math.max(ra.left, rb.left) + w / 2, cy: Math.max(ra.top, rb.top) + h / 2 };
          }
        if (!best) continue;
        if (!(best.cx >= 0 && best.cy >= 0 && best.cx < vw && best.cy < vh)) continue;
        const top = document.elementFromPoint(best.cx, best.cy);
        if (!top) continue;
        const aTop = A.el === top || A.el.contains(top) || top.contains(A.el);
        const bTop = B.el === top || B.el.contains(top) || top.contains(B.el);
        const layer = top.closest('[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"]');
        if (layer && !(layer.contains(A.el) && layer.contains(B.el))) continue; // popover over content
        if (!aTop && !bTop) continue; // both covered by something else
        const key = sig(A.el) + '|' + sig(B.el);
        if (seen.has(key)) continue;
        seen.add(key);
        // Symmetric: an allowlist regex on sig/label matches either side of the pair.
        out.push({
          check: 'collision',
          sig: `${sig(A.el)} <> ${sig(B.el)}`,
          label: `${labelOf(A.el).slice(0, 40)} <> ${labelOf(B.el).slice(0, 40)}`,
          ctx: ctxOf(A.el),
          testid: testidOf(A.el) || testidOf(B.el),
          rect: rectOf(A.el),
          detail: `overlap ${Math.round(best.frac * 100)}% of the smaller; B in ${ctxOf(B.el)}`
        });
      }
    }
  }

  // ── popovers ───────────────────────────────────────────────────────────────
  if (on('popover')) {
    for (const el of Array.from(document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"]'))) {
      if (!visible(el) || dormant(el)) continue;
      // A listbox/menu that lives INSIDE a scroller (a timeline strip, a chip row) is scrolled content, not a popover.
      let scrolled = false;
      for (let a = el.parentElement; a && a !== de; a = a.parentElement) {
        const s = cs(a);
        if (/(auto|scroll)/.test(s.overflowX) || /(auto|scroll)/.test(s.overflowY)) {
          scrolled = true;
          break;
        }
        if (s.position === 'fixed') break;
      }
      if (scrolled) continue;
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) push('popover', el, `box ${Math.round(r.left)},${Math.round(r.top)}→${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}x${vh}`);
    }
  }

  // ── balloons ───────────────────────────────────────────────────────────────
  if (on('balloon-outside') || on('balloon-collision')) {
    for (const pageEl of Array.from(document.querySelectorAll('[data-testid="comic-page"]'))) {
      if (!visible(pageEl) || dormant(pageEl)) continue;
      const pr = pageEl.getBoundingClientRect();
      const pid = pageEl.getAttribute('data-page-id') || '?';
      const bs = Array.from(pageEl.querySelectorAll('g[data-testid="balloon"]'))
        .filter((b) => {
          const s = cs(b);
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || b.getAttribute('opacity') === '0') return false;
          const r = b.getBoundingClientRect();
          return r.width > 2 && r.height > 2;
        })
        .map((b) => ({ b, r: b.getBoundingClientRect(), id: b.getAttribute('data-line-id') || '?', group: b.closest('[data-link-group]')?.getAttribute('data-link-group') || '' }));
      if (on('balloon-outside')) {
        for (const x of bs) {
          const over = Math.max(pr.left - x.r.left, x.r.right - pr.right, pr.top - x.r.top, x.r.bottom - pr.bottom);
          if (over > 2) out.push({ check: 'balloon-outside', sig: 'g.ds-lettering-balloon', label: x.id, ctx: `page ${pid}`, testid: 'balloon', rect: [Math.round(x.r.left), Math.round(x.r.top), Math.round(x.r.width), Math.round(x.r.height)], detail: `${Math.round(over)}px outside a ${Math.round(pr.width)}px page` });
        }
      }
      if (on('balloon-collision')) {
        for (let i = 0; i < bs.length; i++)
          for (let j = i + 1; j < bs.length; j++) {
            const a = bs[i];
            const c = bs[j];
            if (a.group && a.group === c.group) continue; // linked balloons touch by design
            const w = Math.min(a.r.right, c.r.right) - Math.max(a.r.left, c.r.left);
            const h = Math.min(a.r.bottom, c.r.bottom) - Math.max(a.r.top, c.r.top);
            if (w <= 2 || h <= 2) continue;
            const frac = (w * h) / Math.min(a.r.width * a.r.height, c.r.width * c.r.height);
            if (frac > 0.08) out.push({ check: 'balloon-collision', sig: 'g.ds-lettering-balloon', label: `${a.id} × ${c.id}`, ctx: `page ${pid}`, testid: 'balloon', detail: `${Math.round(frac * 100)}% overlap on a ${Math.round(pr.width)}px page` });
          }
      }
    }
  }

  // ── page editor aside ──────────────────────────────────────────────────────
  if (on('editor-aside')) {
    for (const aside of Array.from(document.querySelectorAll('aside[aria-label="Page tools"]'))) {
      if (!visible(aside)) continue;
      const dlg = aside.closest('[role="dialog"]');
      const r = aside.getBoundingClientRect();
      const limit = Math.min(vw, dlg ? dlg.getBoundingClientRect().right : vw);
      if (r.right > limit + 1) push('editor-aside', aside, `right=${Math.round(r.right)} > ${Math.round(limit)}`);
      if (r.width < 200 && r.left < vw) push('editor-aside', aside, `only ${Math.round(r.width)}px wide`);
    }
  }

  // ── phone content share ────────────────────────────────────────────────────
  if (on('phone-content') && args.phone) {
    const candidates = [document.getElementById('board-panel'), document.querySelector('section[aria-label="Conversation"] [data-scroll], section[aria-label="Conversation"] .overflow-y-auto')].filter(
      (x): x is HTMLElement => !!x && visible(x) && !dormant(x)
    );
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const shown = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (shown < args.minContentShare * vh) push('phone-content', el, `${Math.round(shown)}px = ${Math.round((shown / vh) * 100)}% of ${vh}px (< ${Math.round(args.minContentShare * 100)}%)`);
    }
  }

  // ── interactive elements (touch checks) ────────────────────────────────────
  const INTERACTIVE =
    'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="menuitem"], [role="menuitemradio"], [role="slider"], [role="switch"], [tabindex="0"]';
  const interactive = Array.from(document.querySelectorAll(INTERACTIVE)).filter((el) => {
    if (dormant(el) || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.getAttribute('type') === 'file' && cs(el).display !== 'none' && el.getBoundingClientRect().width < 2) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1 && cs(el).display !== 'none';
  });
  const effOpacity = (el: Element) => {
    let o = 1;
    for (let a: Element | null = el; a && a !== de; a = a.parentElement) o *= Number(cs(a).opacity) || 0;
    return o;
  };
  const inViewport = (r: DOMRect) => r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;

  if (on('hit-target')) {
    for (const el of interactive) {
      if (el.closest('[data-hit-exempt]') || !visible(el)) continue;
      // WCAG 2.5.8 inline exception: a link inside a sentence.
      if (el.tagName === 'A' && el.parentElement && /^(P|LI|SPAN|TD)$/.test(el.parentElement.tagName) && Array.from(el.parentElement.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim())) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx - 22 < 0 || cy - 22 < 0 || cx + 22 > vw || cy + 22 > vh) continue; // not fully on screen: scrolled away
      const owns = (hit: Element | null) => !!hit && (hit === el || el.contains(hit) || (hit.closest('label') as HTMLLabelElement | null)?.control === el);
      if (!owns(document.elementFromPoint(cx, cy))) continue; // covered (sheet, popover, scrolled under chrome)
      // Floating chrome (a fixed/sticky bar, or a pill in a pointer-events:none overlay such as "Jump to
      // latest") passing over scrolled content covers part of a target; that is layering, not a small
      // target, so those probes are ignored (a neighbour or a badge in the same flow still fails).
      const floating = (hit: Element) => {
        for (let a: Element | null = hit; a && a !== de && !a.contains(el); a = a.parentElement) {
          const s = cs(a);
          if (s.position === 'fixed' || s.position === 'sticky') return true;
          if (a !== hit && s.pointerEvents === 'none') return true;
        }
        return false;
      };
      let stolen: string | null = null;
      // A 44 px target owns the points 21 px out along both axes and 15 px out on the diagonals (15·√2 ≈ 21):
      // a 44 px square AND a 44 px circle (rounded-full) pass; anything smaller, or a neighbour/badge
      // sitting on the target, does not.
      for (const [dx, dy] of [
        [-21, 0],
        [21, 0],
        [0, -21],
        [0, 21],
        [-15, -15],
        [15, -15],
        [-15, 15],
        [15, 15]
      ]) {
        const hit = document.elementFromPoint(cx + dx, cy + dy);
        if (!owns(hit) && !(hit && floating(hit))) {
          stolen = `probe (${dx},${dy}) → ${hit ? sig(hit) : 'nothing'}`;
          break;
        }
      }
      if (!stolen) continue;
      const after = getComputedStyle(el, '::after');
      const aw = parseFloat(after.width) || 0;
      const ah = parseFloat(after.height) || 0;
      push('hit-target', el, `${Math.round(r.width)}x${Math.round(r.height)}${aw || ah ? ` (::after ${Math.round(aw)}x${Math.round(ah)})` : ''}; ${stolen}`);
    }
  }

  if (on('hover-only')) {
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (!inViewport(r) || r.width < 2 || r.height < 2) continue;
      const s = cs(el);
      if (s.pointerEvents === 'none') continue;
      const op = effOpacity(el);
      const parentVisible = !el.parentElement || cs(el.parentElement).visibility === 'visible';
      if (op < 0.6 && op > 0) push('hover-only', el, `effective opacity ${op.toFixed(2)} until hover/focus`);
      else if (s.visibility === 'hidden' && parentVisible) push('hover-only', el, 'visibility:hidden until hover/focus');
    }
  }

  if (on('safe-area') && args.safeArea) {
    const sa = args.safeArea;
    // Content that SCROLLS may pass under the notch / home indicator (the user scrolls it out);
    // fixed chrome may not. So only controls outside a scroller on that axis are checked.
    const inScroller = (el: Element, axis: 'x' | 'y') => {
      for (let a = el.parentElement; a && a !== de; a = a.parentElement) {
        const s = cs(a);
        const ov = axis === 'y' ? s.overflowY : s.overflowX;
        const more = axis === 'y' ? a.scrollHeight > a.clientHeight + 1 : a.scrollWidth > a.clientWidth + 1;
        if (/(auto|scroll)/.test(ov) && more) return true;
      }
      return false;
    };
    for (const el of interactive) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (!inViewport(r) || cs(el).pointerEvents === 'none') continue;
      const sy = inScroller(el, 'y');
      const sx = inScroller(el, 'x');
      const bands: string[] = [];
      if (!sy && sa.top && r.top < sa.top - 1 && r.bottom > 0) bands.push(`top ${sa.top}`);
      if (!sy && sa.bottom && r.bottom > vh - sa.bottom + 1 && r.top < vh) bands.push(`bottom ${sa.bottom}`);
      if (!sx && sa.left && r.left < sa.left - 1 && r.right > 0) bands.push(`left ${sa.left}`);
      if (!sx && sa.right && r.right > vw - sa.right + 1 && r.left < vw) bands.push(`right ${sa.right}`);
      if (bands.length) push('safe-area', el, `inside the ${bands.join(' + ')}px inset`);
    }
  }

  if (on('hinge') && args.hinge) {
    const { start, end } = args.hinge;
    for (const el of interactive) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < end - 1 && r.right > start + 1 && inViewport(r)) push('hinge', el, `straddles the fold at ${start}–${end}`);
    }
    const chat = document.querySelector('section[aria-label="Conversation"]');
    const board = document.querySelector('section[aria-label="Board"]');
    if (chat && visible(chat) && chat.getBoundingClientRect().right > start + 1) push('hinge', chat, `conversation pane ends at ${Math.round(chat.getBoundingClientRect().right)} (fold at ${start})`);
    if (board && visible(board) && board.getBoundingClientRect().left < end - 1) push('hinge', board, `board pane starts at ${Math.round(board.getBoundingClientRect().left)} (fold ends at ${end})`);
  }

  // ── landmarks / layout class ───────────────────────────────────────────────
  if (on('landmarks')) {
    const mains = Array.from(document.querySelectorAll('main, [role="main"]')).filter((m) => !m.closest('[inert],[aria-hidden="true"]') && cs(m).display !== 'none');
    if (mains.length !== 1) out.push({ check: 'landmarks', sig: 'main', label: `${mains.length} main landmarks`, ctx: '', detail: mains.map((m) => sig(m)).join(', ') });
    const navShown = Array.from(document.querySelectorAll('[data-tabbar], [data-rail]')).some((n) => visible(n));
    const navs = Array.from(document.querySelectorAll('nav, [role="navigation"]')).filter((n) => visible(n) && !dormant(n));
    if (navShown && navs.length === 0) out.push({ check: 'landmarks', sig: 'nav', label: 'tab bar or rail without a nav landmark', ctx: '' });
  }
  if (on('layout-class') && args.expectLayout) {
    const root = document.querySelector('.gesture-root[data-layout]') || document.querySelector('[data-layout]');
    const got = root?.getAttribute('data-layout') || 'none';
    if (got !== args.expectLayout) out.push({ check: 'layout-class', sig: root ? sig(root) : 'none', label: `data-layout=${got}`, ctx: '', detail: `expected ${args.expectLayout}` });
  }
  return out;
}

/** Run the in-page detector. */
export async function scanLayout(page: Page, opts: ScanOptions = {}): Promise<Finding[]> {
  const d = opts.device;
  const checks = (opts.checks || [...LAYOUT_CHECKS, ...(d?.coarse ? TOUCH_CHECKS : [])]).filter((c) => c !== 'axe' && c !== 'console');
  const args: DetectArgs = {
    checks,
    safeArea: opts.safeArea ?? null,
    hinge: opts.hinge ?? null,
    expectLayout: opts.expectLayout ?? null,
    phone: d ? d.kind === 'phone' : false,
    minContentShare: opts.minContentShare ?? 0.45
  };
  return (await page.evaluate(detect, args)) as Finding[];
}

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** axe-core serious/critical violations (color-contrast included) as findings. */
export async function runAxe(page: Page, opts: { include?: string; exclude?: string[] } = {}): Promise<Finding[]> {
  let builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
  if (opts.include) builder = builder.include(opts.include);
  for (const ex of opts.exclude || []) builder = builder.exclude(ex);
  const res = await builder.analyze();
  const out: Finding[] = [];
  for (const v of res.violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    for (const node of v.nodes.slice(0, 12)) {
      out.push({
        check: 'axe',
        sig: v.id,
        label: String(node.target.join(' ')).slice(0, 120),
        ctx: (node.html || '').replace(/\s+/g, ' ').slice(0, 120),
        detail: `${v.impact}: ${v.help}${node.failureSummary ? ` — ${node.failureSummary.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`
      });
    }
  }
  return out;
}

const findingsLog = (): string => path.join(process.env.QA_ARTIFACTS_RESOLVED || path.resolve(process.cwd(), 'node_modules/.cache/comic-qa'), 'findings.jsonl');

export interface CleanOptions extends ScanOptions {
  axe?: boolean;
  axeExclude?: string[];
  /** Page errors collected by the harness since the last check. */
  pageErrors?: string[];
  /** Screenshot attached to the report for this step (default: on failure only). */
  attachShot?: boolean;
}

/**
 * Scan, triage against the allowlist and soft-fail on NEW findings. Allowlisted findings become
 * annotations (`allowlisted: <id> (<owner>) …`), and every finding is appended to
 * <artifacts>/findings.jsonl for the smoke summary.
 */
export async function expectLayoutClean(page: Page, testInfo: TestInfo, where: Omit<Where, 'project'>, opts: CleanOptions = {}): Promise<Finding[]> {
  const findings = await scanLayout(page, opts);
  if (opts.axe) findings.push(...(await runAxe(page, { exclude: opts.axeExclude })));
  for (const msg of opts.pageErrors?.splice(0) || []) findings.push({ check: 'console', sig: 'pageerror', label: msg.slice(0, 60), ctx: '', detail: msg.slice(0, 300) });
  const w: Where = { project: testInfo.project.name, ...where };
  const t = triage(findings, w);
  for (const a of t.allowed) {
    testInfo.annotations.push({ type: a.kind === 'known-failure' ? `known:${a.entry.owner}` : 'false-positive', description: `${a.entry.id} @ ${where.surface}/${where.scene}: ${describeFinding(a.finding)}` });
  }
  try {
    const file = findingsLog();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = findings.map((f) => {
      const a = t.allowed.find((x) => x.finding === f);
      return JSON.stringify({ ...w, ...f, status: a ? a.kind : 'NEW', allowId: a?.entry.id, owner: a?.entry.owner });
    });
    if (rows.length) fs.appendFileSync(file, rows.join('\n') + '\n');
  } catch {
    /* the log is a convenience */
  }
  if (t.fresh.length) {
    if (opts.attachShot !== false) await testInfo.attach(`${where.surface}-${where.scene}.png`, { body: await page.screenshot(), contentType: 'image/png' }).catch(() => undefined);
    await testInfo.attach(`${where.surface}-${where.scene}-findings.json`, { body: JSON.stringify(t.fresh, null, 2), contentType: 'application/json' });
  }
  expect.soft(t.fresh.map(describeFinding), `New layout findings at ${where.surface}/${where.scene} on ${w.project} (fix them, or allowlist with an owner tag in tests/e2e/allowlist.json)`).toEqual([]);
  return t.fresh;
}
