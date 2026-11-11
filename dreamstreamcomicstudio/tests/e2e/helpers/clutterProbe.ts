// The clutter probe (declutter DC-0; docs/design/clean-and-smooth.md): what the "clean and smooth" rubric can
// measure on a rendered page, and the ratchet that keeps every gain.
//
//   const report = await measureClutter(page, { phone: true, chrome: true, content: '#board-panel' });
//   report.counts   → { primaries, nestedBoxes, maxBoxDepth, truncatedLabels, chromeShare, livePulses, hOverflow,
//                       duplicateActions, usagePhrases, freeWords, transcriptScreens }
//   report.detail   → the labels behind each number (what a reviewer reads in clutter-report.json)
//
// Rubric checks it measures (clean-and-smooth.md §2):
//   C1 primaries          visible, enabled controls in the viewport filled with a primary token (--ds-accent,
//                         --ds-accent-fill), resolved AT the control so a scoped skin is honoured. A selected tab or
//                         pressed segment is state, not an action, and is not counted.
//   C2 duplicateActions   `data-action` values carried by more than one visible control in the viewport (extra copies)
//   C3 nestedBoxes /      bordered (all four sides) rounded (≥ 6 px) surfaces in the viewport that sit inside another
//      maxBoxDepth        one, and the deepest stack. Controls, art (comic pages, balloons) and user content are skipped.
//   C5 usagePhrases /     "a little of your usage" and the word "Free", over the whole document (the transcript scrolls)
//      freeWords
//   C6 truncatedLabels    controls in the viewport whose own label text is cut by the control or a clipping box inside
//                         it (an ellipsis, a line clamp, a hidden overflow). User content (`[data-user-content]`) may
//                         truncate.
//   C7 transcriptScreens  the Director transcript's height in screens of its own scroller (heist-12p ratchet)
//   C8 chromeShare        phones, studio and reader scenes: the % of the viewport height that is not the content region
//                         (the tallest visible match of `content`, else the tallest scroller, else <main>, else the
//                         scrolling document), with the fixed / sticky bars over it counted as chrome
//   C9 livePulses         elements in the viewport with an infinite animation running (measure with motion ON: the
//                         harness's still=1 zeroes every duration)
//   +  hOverflow          px of horizontal page overflow
//
// The ratchet (tests/e2e/baselines/declutter.json) works like DS-0's (tests/config/baselines/README.md): a scene the
// baseline lists may neither rise above nor fall below its entry (lower it so the gain is kept); a scene it does not
// list is held to the rubric targets (CLUTTER_TARGETS), so a new screen is clean from its first commit.
// UPDATE_BASELINES=1 only lowers; UPDATE_BASELINES=reset rewrites the measured entries (reviewed, rare).
//
// Everything here is importable from Node directly (type-only imports, no enums): scripts/design/declutter-shots.mjs
// shares the scene list and the probe.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

// ── Metrics, targets and the scene list ─────────────────────────────────────

/** Every ratcheted number, in report order. */
export const CLUTTER_METRICS = [
  'primaries',
  'duplicateActions',
  'nestedBoxes',
  'maxBoxDepth',
  'truncatedLabels',
  'chromeShare',
  'livePulses',
  'hOverflow',
  'usagePhrases',
  'freeWords',
  'transcriptScreens'
] as const;
export type ClutterMetric = (typeof CLUTTER_METRICS)[number];
/** A scene's numbers; an absent metric is 0 (not measured counts as 0 too: chromeShare off a phone). */
export type ClutterCounts = Partial<Record<ClutterMetric, number>>;

/**
 * The rubric targets (clean-and-smooth.md §2): what a scene the baseline does not list must meet. C1 one primary,
 * C2 one home per action, C3 depth ≤ 2, C6 no truncated label, C8 phone chrome ≤ 25 %, C9 one live pulse, no page
 * overflow. The other metrics (nested count, the C5 phrases, transcript length) have no absolute target: they only
 * ratchet once a scene is listed.
 */
export const CLUTTER_TARGETS: Readonly<ClutterCounts> = Object.freeze({
  primaries: 1,
  duplicateActions: 0,
  maxBoxDepth: 2,
  truncatedLabels: 0,
  chromeShare: 25,
  livePulses: 1,
  hOverflow: 0
});

/** The two shot sizes of the loop (360×740 phone, 1280×800 desk) and the two themes. */
export const DECLUTTER_VIEWS = [
  { id: 'phone', device: 'smoke-360x740', width: 360, height: 740, phone: true },
  { id: 'desk', device: 'smoke-1280x800', width: 1280, height: 800, phone: false }
] as const;
export type DeclutterView = (typeof DECLUTTER_VIEWS)[number];
export const DECLUTTER_THEMES = ['light', 'dark'] as const;
export type DeclutterTheme = (typeof DECLUTTER_THEMES)[number];

/** The studio's content regions on a phone (the board panel, the message list): what C8 measures chrome against. */
export const STUDIO_CONTENT = '#board-panel, [data-qa-scroller="conversation"], section[aria-label="Conversation"] .overflow-y-auto';

export interface DeclutterScene {
  /** Baseline key prefix (`<id>@<view>-<theme>`) and screenshot name. */
  id: string;
  /** The QA harness query (qa/comic-qa.html); the probe adds theme, skin=atlas, img=svg and still=0. */
  q: Record<string, string | number | boolean>;
  /** Phones: switch the single-pane studio to its Board view first (tab scenes); default: stay where it opens. */
  phoneBoard?: boolean;
  /** C8 applies (studio and reader scenes): measure chrome against `content` (else the tallest scroller). */
  chrome?: boolean;
  content?: string;
  /** One line: what the scene shows (docs and the shots index). */
  note: string;
}

/**
 * The loop's scene list (declutter §6 step 1): the DS-1b studio scenes plus the extras the rubric needs. The app
 * scenes (qa/app/scenes) are discovered at runtime and measured as `app-<id>`.
 */
export const DECLUTTER_SCENES: readonly DeclutterScene[] = [
  { id: 'studio-chat', q: { surface: 'studio', fixture: 'heist-12p', tab: 'pages' }, chrome: true, content: STUDIO_CONTENT, note: 'studio idle with the open render gate (desk: chat + board)' },
  { id: 'studio-streaming', q: { surface: 'studio', fixture: 'heist-12p', tab: 'pages', state: 'streaming' }, chrome: true, content: STUDIO_CONTENT, note: 'a reply streaming in' },
  { id: 'studio-busy', q: { surface: 'studio', fixture: 'heist-12p', tab: 'pages', state: 'busy' }, chrome: true, content: STUDIO_CONTENT, note: 'pages drawing (the pulses scene)' },
  { id: 'studio-empty', q: { surface: 'studio', fixture: 'empty', tab: 'story' }, chrome: true, content: STUDIO_CONTENT, note: 'an empty comic' },
  { id: 'studio-story', q: { surface: 'studio', fixture: 'heist-12p', tab: 'story' }, phoneBoard: true, chrome: true, content: STUDIO_CONTENT, note: 'board: Story' },
  { id: 'studio-cast', q: { surface: 'studio', fixture: 'heist-12p', tab: 'cast' }, phoneBoard: true, chrome: true, content: STUDIO_CONTENT, note: 'board: Cast' },
  { id: 'studio-style', q: { surface: 'studio', fixture: 'heist-12p', tab: 'style' }, phoneBoard: true, chrome: true, content: STUDIO_CONTENT, note: 'board: Style' },
  { id: 'studio-pages', q: { surface: 'studio', fixture: 'heist-12p', tab: 'pages' }, phoneBoard: true, chrome: true, content: STUDIO_CONTENT, note: 'board: Pages (with the gate open)' },
  { id: 'studio-media', q: { surface: 'studio', fixture: 'heist-12p', tab: 'media' }, phoneBoard: true, chrome: true, content: STUDIO_CONTENT, note: 'board: Media' },
  { id: 'studio-read', q: { surface: 'studio', fixture: 'heist-12p', tab: 'read' }, phoneBoard: true, chrome: true, content: STUDIO_CONTENT, note: 'board: Read' },
  { id: 'studio-history', q: { surface: 'studio', fixture: 'heist-12p', tab: 'pages', history: true }, phoneBoard: true, chrome: true, content: STUDIO_CONTENT, note: 'Comic History on' },
  { id: 'board-pages', q: { surface: 'board', fixture: 'heist-12p', tab: 'pages' }, note: 'the board pane alone' },
  { id: 'editor-easy', q: { surface: 'editor', fixture: 'heist-12p', page: 2, mode: 'easy' }, note: 'page editor, Easy' },
  { id: 'editor-pro', q: { surface: 'editor', fixture: 'heist-12p', page: 2, mode: 'pro' }, note: 'page editor, Pro' },
  { id: 'reader', q: { surface: 'reader', fixture: 'heist-12p' }, chrome: true, content: '[data-testid="immersive-reader"]', note: 'the immersive reader' },
  { id: 'public', q: { surface: 'public', fixture: 'heist-12p', share: true }, chrome: true, content: 'main', note: 'the public share reader' },
  { id: 'kit-breakdown', q: { surface: 'kit', kit: 'breakdown', fixture: 'heist-12p' }, note: 'kit: the page breakdown card' },
  { id: 'kit-timeline', q: { surface: 'kit', kit: 'timeline', fixture: 'heist-12p' }, note: 'kit: the book timeline' },
  { id: 'kit-model-picker', q: { surface: 'kit', kit: 'model-picker', fixture: 'heist-12p' }, note: 'kit: the model picker' }
];

/** The baseline key of one measurement: `studio-chat@phone-light`. */
export const sceneKey = (scene: string, view: string, theme: string): string => `${scene}@${view}-${theme}`;

/** The harness URL of a scene, with the loop's look: theme, page-level Atlas skin, SVG art, real motion (still=0). */
export const declutterUrl = (q: Record<string, string | number | boolean>, theme: DeclutterTheme, extra: Record<string, string> = {}): string => {
  const params = new URLSearchParams();
  const all: Record<string, string | number | boolean | null | undefined> = { ...q, theme, skin: 'atlas', img: 'svg', ...extra };
  for (const [k, v] of Object.entries(all)) {
    if (v === false || v === undefined || v === null) continue;
    params.set(k, v === true ? '1' : String(v));
  }
  return `/qa/comic-qa.html?${params.toString()}`;
};

// ── The in-page probe ───────────────────────────────────────────────────────

export interface ProbeArgs {
  /** Custom properties whose resolved colour marks a primary fill (C1). */
  primaryTokens: string[];
  /** Measure C8 (phones, studio and reader scenes). */
  chrome: boolean;
  /** C8's content region (CSS selector); null: the tallest visible scroller. */
  content: string | null;
  /** Never boxes or labels: art and user content. */
  skip: string;
}

export interface ProbeDetail {
  /** Visible controls in the viewport (context for the counts). */
  controls: number;
  primaries: string[];
  duplicateActions: string[];
  /** The deepest box stack, outermost first (tag.classes). */
  deepestBoxes: string[];
  truncated: string[];
  /** `<animation> on <element>`. */
  pulses: string[];
  /** Control names grouped by their first two words, where more than one shares them (review aid for C2). */
  duplicateNames: Record<string, number>;
  /** C8: the content region the chrome share was measured against. */
  chromeContent: string | null;
}

export interface ProbeResult {
  counts: Record<ClutterMetric, number>;
  detail: ProbeDetail;
}

/* Self-contained: Playwright ships this function's source to the page (no closures over module scope). */
export function probeClutter(args: ProbeArgs): ProbeResult {
  const de = document.documentElement;
  // The layout viewport's real width (an isMobile project widens innerWidth to fit an overflow; clientWidth does not).
  const vw = de.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const cs = (el: Element) => {
    let s = styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };
  // Out of the view a person sees: inert (behind a modal that marks it), aria-hidden (a modal's background, a carousel
  // clone) or screen-reader only. Pulses use the narrower `offstage`: a decorative pulsing dot is itself aria-hidden.
  const dormant = (el: Element) => !!el.closest('[inert],[aria-hidden="true"],.sr-only');
  const offstage = (el: Element) => !!el.closest('[inert],.sr-only');
  const sized = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  /** Rendered and sized (`opacity` counts: a control at 0 opacity is not seen). */
  const shown = (el: Element, opacity = true) => {
    const v = el as Element & { checkVisibility?: (o: object) => boolean };
    if (v.checkVisibility && !v.checkVisibility({ opacityProperty: opacity, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    return sized(el);
  };
  const inView = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  };
  const cls = (el: Element) => (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
  const sig = (el: Element) => `${el.tagName.toLowerCase()}${cls(el).slice(0, 4).map((c) => '.' + c).join('')}`.slice(0, 100);
  const nameOf = (el: Element) =>
    (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const skipped = (el: Element) => !!el.closest(args.skip);

  // Colours: a token's value resolved to the same form getComputedStyle gives a background.
  const swatch = document.createElement('i');
  swatch.style.display = 'none';
  document.body.appendChild(swatch);
  const rgbOf = new Map<string, string>();
  const toRgb = (value: string): string => {
    const v = value.trim();
    if (!v) return '';
    let out = rgbOf.get(v);
    if (out === undefined) {
      swatch.style.backgroundColor = '';
      swatch.style.backgroundColor = v;
      out = swatch.style.backgroundColor ? getComputedStyle(swatch).backgroundColor : '';
      rgbOf.set(v, out);
    }
    return out;
  };
  const clear = (c: string) => !c || c === 'transparent' || /,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);

  const CONTROLS =
    'button, a[href], input[type="submit"], input[type="button"], summary, [role="button"], [role="tab"], [role="radio"], [role="menuitem"], [role="menuitemradio"], [role="switch"], [role="option"]';
  const controls = Array.from(document.querySelectorAll(CONTROLS)).filter((el) => !dormant(el) && shown(el) && inView(el));

  // ── C1: primaries ──
  const enabled = (el: Element) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
  const isState = (el: Element) =>
    ['aria-selected', 'aria-pressed', 'aria-checked'].some((a) => el.getAttribute(a) === 'true') || !!(el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false');
  const primaries = controls.filter((el) => {
    if (!enabled(el) || isState(el)) return false;
    const bg = cs(el).backgroundColor;
    if (clear(bg)) return false;
    return args.primaryTokens.some((t) => {
      const fill = toRgb(cs(el).getPropertyValue(t));
      return !clear(fill) && fill === bg;
    });
  });

  // ── C2: one home per action (data-action) and the name groups behind it ──
  const byAction = new Map<string, number>();
  for (const el of Array.from(document.querySelectorAll('[data-action]'))) {
    if (dormant(el) || !shown(el) || !inView(el)) continue;
    const a = el.getAttribute('data-action') || '';
    if (a) byAction.set(a, (byAction.get(a) || 0) + 1);
  }
  const duplicateActions = [...byAction.entries()].filter(([, n]) => n > 1);
  const names: Record<string, number> = {};
  for (const el of controls) {
    const key = nameOf(el).toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).slice(0, 2).join(' ');
    if (key) names[key] = (names[key] || 0) + 1;
  }
  const duplicateNames = Object.fromEntries(Object.entries(names).filter(([, n]) => n > 1));

  // ── C3: boxes in boxes ──
  const NOT_BOX = /^(BUTTON|INPUT|TEXTAREA|SELECT|IMG|A|LABEL|VIDEO|CANVAS|HR|IFRAME|SUMMARY)$/;
  const CONTROL_ROLE = /^(button|tab|radio|menuitem|menuitemradio|switch|option|checkbox|slider)$/;
  const px = (v: string) => parseFloat(v) || 0;
  const boxMemo = new Map<Element, boolean>();
  const isBox = (el: Element): boolean => {
    let b = boxMemo.get(el);
    if (b !== undefined) return b;
    b = false;
    if (!NOT_BOX.test(el.tagName) && !(el instanceof SVGElement) && !CONTROL_ROLE.test(el.getAttribute('role') || '') && !skipped(el)) {
      const s = cs(el);
      const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).every((k) => {
        const w = px(s.getPropertyValue(`border-${k.toLowerCase()}-width`));
        const style = s.getPropertyValue(`border-${k.toLowerCase()}-style`);
        return w >= 1 && style !== 'none' && style !== 'hidden' && !clear(s.getPropertyValue(`border-${k.toLowerCase()}-color`));
      });
      const radius = Math.max(px(s.borderTopLeftRadius), px(s.borderTopRightRadius), px(s.borderBottomRightRadius), px(s.borderBottomLeftRadius));
      b = sides && radius >= 6 && shown(el);
    }
    boxMemo.set(el, b);
    return b;
  };
  const stackOf = (el: Element): Element[] => {
    const stack: Element[] = [];
    for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) if (isBox(a)) stack.unshift(a);
    return stack;
  };
  let nestedBoxes = 0;
  let deepest: Element[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (!isBox(el) || dormant(el) || !inView(el)) continue;
    const stack = stackOf(el);
    if (stack.length > 1) nestedBoxes += 1;
    if (stack.length > deepest.length) deepest = stack;
  }

  // ── C6: labels that do not fit ──
  const clips = (v: string) => v === 'hidden' || v === 'clip';
  /** Text meant for screen readers only (`.sr-only`, a clip rect, a 1 px clipping box) is not a visible label. */
  const visuallyHidden = (host: Element, control: Element) => {
    if (host.closest('.sr-only')) return true;
    for (let a: Element | null = host; a; a = a === control ? null : a.parentElement) {
      const s = cs(a);
      if (s.clip && s.clip !== 'auto') return true;
      if (/inset\(50%\)/.test(s.clipPath)) return true;
      if ((clips(s.overflowX) || clips(s.overflowY)) && (a.clientWidth <= 1 || a.clientHeight <= 1)) return true;
    }
    return false;
  };
  const truncated: string[] = [];
  const range = document.createRange();
  for (const el of controls) {
    if (skipped(el)) continue;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let cut = false;
    for (let t = walker.nextNode(); t && !cut; t = walker.nextNode()) {
      const host = t.parentElement;
      if (!host || !(t.textContent || '').trim() || host.closest('svg') || skipped(host) || visuallyHidden(host, el)) continue;
      range.selectNodeContents(t);
      const r = range.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // Every box from the text up to the control that clips its overflow: is the text inside its padding box?
      for (let a: Element | null = host; a && !cut; a = a === el ? null : a.parentElement) {
        const s = cs(a);
        if (s.display === 'inline' || (!clips(s.overflowX) && !clips(s.overflowY))) continue;
        const ar = a.getBoundingClientRect();
        const left = ar.left + a.clientLeft;
        const top = ar.top + a.clientTop;
        const right = left + a.clientWidth;
        const bottom = top + a.clientHeight;
        // Glyph boxes may poke past a tight line box by a few px without any ink being lost: allow 3 px vertically.
        if (clips(s.overflowX) && (r.right > right + 1 || r.left < left - 1)) cut = true;
        if (clips(s.overflowY) && (r.bottom > bottom + 3 || r.top < top - 3)) cut = true;
      }
    }
    if (cut) truncated.push(nameOf(el) || sig(el));
  }
  range.detach();

  // ── C8: chrome share (phones, studio and reader scenes) ──
  let chromeShare = 0;
  let chromeContent: string | null = null;
  if (args.chrome) {
    const scrolls = (el: Element) => /(auto|scroll)/.test(cs(el).overflowY) && el.scrollHeight > el.clientHeight + 4;
    let candidates = args.content ? Array.from(document.querySelectorAll(args.content)) : [];
    candidates = candidates.filter((el) => !dormant(el) && shown(el, false) && inView(el));
    const usable = (el: Element) => !dormant(el) && shown(el, false) && inView(el);
    if (!candidates.length) candidates = Array.from(document.body.querySelectorAll('*')).filter((el) => scrolls(el) && usable(el));
    if (!candidates.length) candidates = Array.from(document.querySelectorAll('main, [role="main"]')).filter(usable);
    const docScrolls = (document.scrollingElement || de).scrollHeight > vh + 4;
    const BAR_ROLE = /^(banner|navigation|toolbar|tablist|contentinfo)$/;
    const bars = Array.from(document.body.querySelectorAll('*')).filter((el) => {
      const s = cs(el);
      const fixed = s.position === 'fixed' || s.position === 'sticky';
      const hud = s.position === 'absolute' && (/^(HEADER|NAV|FOOTER)$/.test(el.tagName) || BAR_ROLE.test(el.getAttribute('role') || ''));
      if (!fixed && !hud) return false;
      if (dormant(el) || !shown(el, false) || !inView(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= vw * 0.5 && r.height < vh * 0.5;
    });
    const contentHeight = (el: Element | null): number => {
      const r = el ? el.getBoundingClientRect() : ({ top: 0, bottom: vh } as DOMRect);
      const top = Math.max(0, r.top);
      const bottom = Math.min(vh, r.bottom);
      if (bottom <= top) return 0;
      const cuts = bars
        .filter((b) => !el || !b.contains(el))
        .map((b) => b.getBoundingClientRect())
        .map((b) => [Math.max(top, b.top), Math.min(bottom, b.bottom)] as [number, number])
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
      let covered = 0;
      let reach = top;
      for (const [a, b] of cuts) {
        if (b <= reach) continue;
        covered += b - Math.max(a, reach);
        reach = b;
      }
      return bottom - top - covered;
    };
    let best = -1;
    for (const el of candidates) {
      const h = contentHeight(el);
      if (h > best) {
        best = h;
        chromeContent = sig(el);
      }
    }
    if (best < 0 && docScrolls) {
      best = contentHeight(null);
      chromeContent = 'document';
    }
    if (best >= 0) chromeShare = Math.max(0, Math.round(((vh - best) / vh) * 100));
  }

  // ── C9: live pulses ──
  const pulsing = new Map<Element, string>();
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue;
    const effect = a.effect as KeyframeEffect | null;
    const target = effect?.target;
    if (!effect || !target || effect.getComputedTiming().iterations !== Infinity) continue;
    if (offstage(target) || !shown(target, false) || !inView(target)) continue;
    const name = (a as CSSAnimation).animationName || a.id || 'animation';
    if (!pulsing.has(target)) pulsing.set(target, `${name} on ${sig(target)}`);
  }

  // ── C7: the transcript, in screens of its own scroller ──
  let transcriptScreens = 0;
  const convo = document.querySelector('section[aria-label="Conversation"]');
  if (convo && !dormant(convo) && shown(convo, false)) {
    const all = [convo, ...Array.from(convo.querySelectorAll('*'))];
    const scroller = all.find((el) => /(auto|scroll)/.test(cs(el).overflowY) && el.scrollHeight > el.clientHeight + 4);
    transcriptScreens = scroller && scroller.clientHeight > 0 ? Math.ceil(scroller.scrollHeight / scroller.clientHeight) : 1;
  }

  // ── C5: say it once (whole document) ──
  const text = document.body.innerText || '';
  const usagePhrases = (text.match(/a little of your usage/gi) || []).length;
  const freeWords = (text.match(/\bFree\b/g) || []).length;

  swatch.remove();
  const hOverflow = Math.max(0, Math.max(de.scrollWidth, document.body.scrollWidth) - vw);

  return {
    counts: {
      primaries: primaries.length,
      duplicateActions: duplicateActions.reduce((n, [, k]) => n + k - 1, 0),
      nestedBoxes,
      maxBoxDepth: deepest.length,
      truncatedLabels: truncated.length,
      chromeShare,
      livePulses: pulsing.size,
      hOverflow,
      usagePhrases,
      freeWords,
      transcriptScreens
    },
    detail: {
      controls: controls.length,
      primaries: primaries.map((el) => nameOf(el) || sig(el)),
      duplicateActions: duplicateActions.map(([a, n]) => `${a} ×${n}`),
      deepestBoxes: deepest.map(sig),
      truncated,
      pulses: [...pulsing.values()],
      duplicateNames,
      chromeContent
    }
  };
}

/** The primary fills C1 recognises (CL-0's spark fill joins this list when it lands). */
export const PRIMARY_TOKENS: readonly string[] = ['--ds-accent', '--ds-accent-fill'];

/** Never a box and never a label: comic art, lettering and user content. */
export const PROBE_SKIP = '[data-testid="comic-page"], [data-testid="balloon"], [data-testid="balloon-hit"], .ds-lettering-balloon, [data-user-content]';

export interface MeasureOptions {
  /** Measure C8 (phones; studio and reader scenes). */
  chrome?: boolean;
  /** C8's content region; absent: the tallest scroller. */
  content?: string | null;
  primaryTokens?: readonly string[];
}

/** Run the probe on the page as it is now. */
export async function measureClutter(page: Page, opts: MeasureOptions = {}): Promise<ProbeResult> {
  const args: ProbeArgs = { primaryTokens: [...(opts.primaryTokens ?? PRIMARY_TOKENS)], chrome: !!opts.chrome, content: opts.content ?? null, skip: PROBE_SKIP };
  return page.evaluate(probeClutter, args);
}

// ── The ratchet ─────────────────────────────────────────────────────────────

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const BASELINE_PATH = path.join(APP, 'tests', 'e2e', 'baselines', 'declutter.json');
export const DECLUTTER_SPEC = 'tests/e2e/declutter.spec.ts';
const SHRINK = `UPDATE_BASELINES=1 npx playwright test -c tests/e2e/playwright.config.ts --project=declutter`;

export type RatchetMode = 'check' | 'shrink' | 'reset';
/** `UPDATE_BASELINES` as in DS-0: unset / 0 / false checks; `reset` rewrites what was measured; anything else only lowers. */
export function clutterMode(value: string | undefined = process.env.UPDATE_BASELINES): RatchetMode {
  const v = (value ?? '').trim().toLowerCase();
  if (!v || v === '0' || v === 'false' || v === 'no') return 'check';
  return v === 'reset' ? 'reset' : 'shrink';
}

/** A scene's counts as stored: known metrics only, zeros dropped, in CLUTTER_METRICS order. */
export function storedCounts(counts: ClutterCounts): ClutterCounts {
  const out: ClutterCounts = {};
  for (const m of CLUTTER_METRICS) if ((counts[m] ?? 0) > 0) out[m] = counts[m];
  return out;
}

/**
 * One measured scene against the ratchet. Listed: every metric must equal its entry (above → `over`, below →
 * `under`, lower the entry to keep the gain). Not listed: the rubric targets (`over` when one is missed).
 */
export function judgeScene(key: string, actual: ClutterCounts, scenes: Record<string, ClutterCounts>, targets: Readonly<ClutterCounts> = CLUTTER_TARGETS): { over: string[]; under: string[] } {
  const over: string[] = [];
  const under: string[] = [];
  const entry = scenes[key];
  for (const m of CLUTTER_METRICS) {
    const n = actual[m] ?? 0;
    if (entry) {
      const base = entry[m] ?? 0;
      if (n > base) over.push(`${key}  ${m}: ${n}, baseline ${base} — clutter rose (${clutterHint(m)})`);
      else if (n < base) under.push(`${key}  ${m}: ${n}, baseline ${base} — it fell: lower the baseline so the gain is kept (${SHRINK})`);
    } else if (targets[m] !== undefined && n > (targets[m] as number)) {
      over.push(`${key}  ${m}: ${n}, target ${targets[m]} — a scene the baseline does not list meets the rubric (${clutterHint(m)})`);
    }
  }
  return { over, under };
}

/** What each metric asks of a fix (the rubric check behind it). */
export function clutterHint(m: ClutterMetric): string {
  const hints: Record<ClutterMetric, string> = {
    primaries: 'C1: one primary per view',
    duplicateActions: 'C2: one home per action',
    nestedBoxes: 'C3: no box in a box',
    maxBoxDepth: 'C3: depth ≤ 2, inner sections use dividers or a well',
    truncatedLabels: 'C6: labels fit',
    chromeShare: 'C8: phone chrome ≤ 25 %',
    livePulses: 'C9: one live pulse per view',
    hOverflow: 'no horizontal overflow',
    usagePhrases: 'C5: say it once',
    freeWords: 'C5: "Free" only beside something that costs',
    transcriptScreens: 'C7: past is small'
  };
  return hints[m];
}

/**
 * Listed scenes of one view and theme (`suffix`, e.g. `phone-light`) that this run did not even try: the scene is
 * gone from the list (or the app scene file was deleted), so its entry must be dropped. A scene that was tried and
 * failed to open is NOT vanished (its failure is reported on its own).
 */
export function vanishedKeys(attempted: readonly string[], scenes: Record<string, ClutterCounts>, suffix: string): string[] {
  const tried = new Set(attempted);
  return Object.keys(scenes)
    .filter((k) => k.endsWith(`@${suffix}`) && !tried.has(k))
    .sort();
}

/** The failure line for a vanished entry. */
export const vanishedLine = (key: string): string => `${key}  is in the baseline but no longer a scene — drop its entry (${SHRINK})`;

/**
 * The baseline after one run's measurements. `shrink`: a listed scene's metrics are lowered to the measurement
 * where it is lower (never raised), the `drop` keys (vanishedKeys) are removed, and nothing is added. `reset`:
 * every measured scene is rewritten exactly and the `drop` keys removed (a reviewed exception: the diff shows rises).
 */
export function updateClutterBaseline(
  scenes: Record<string, ClutterCounts>,
  measured: Record<string, ClutterCounts>,
  mode: Exclude<RatchetMode, 'check'>,
  drop: readonly string[] = []
): Record<string, ClutterCounts> {
  const out: Record<string, ClutterCounts> = { ...scenes };
  for (const k of drop) delete out[k];
  for (const [k, v] of Object.entries(measured)) {
    if (mode === 'reset') {
      out[k] = storedCounts(v);
      continue;
    }
    const entry = out[k];
    if (!entry) continue;
    const next: ClutterCounts = {};
    for (const m of CLUTTER_METRICS) next[m] = Math.min(entry[m] ?? 0, v[m] ?? 0);
    out[k] = storedCounts(next);
  }
  return out;
}

export interface ClutterBaselineFile {
  probe: 'declutter';
  spec: string;
  note: string;
  targets: ClutterCounts;
  scenes: Record<string, ClutterCounts>;
}

/** The checked-in form: one line per scene, keys sorted, metrics in CLUTTER_METRICS order (a shrink is a one-line diff). */
export function serialiseClutterBaseline(scenes: Record<string, ClutterCounts>): string {
  const line = (c: ClutterCounts) => {
    const parts = CLUTTER_METRICS.filter((m) => c[m] !== undefined).map((m) => `${JSON.stringify(m)}: ${c[m]}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  };
  const keys = Object.keys(scenes).sort();
  const note =
    'Clutter ratchet (declutter DC-0; docs/design/clean-and-smooth.md). Per scene@view-theme, the probe counts at the time ' +
    'the entry was written; an absent metric is 0. A listed scene may neither rise nor fall (lower it so the gain is kept); ' +
    `a scene not listed is held to "targets". Generated, never typed: ${SHRINK} lowers it; only the integration owner commits it.`;
  return [
    '{',
    '  "probe": "declutter",',
    `  "spec": ${JSON.stringify(DECLUTTER_SPEC)},`,
    `  "note": ${JSON.stringify(note)},`,
    `  "targets": ${line(CLUTTER_TARGETS)},`,
    keys.length ? `  "scenes": {\n${keys.map((k) => `    ${JSON.stringify(k)}: ${line(scenes[k])}`).join(',\n')}\n  }` : '  "scenes": {}',
    '}',
    ''
  ].join('\n');
}

/** Reads and validates the baseline; `problems` explains anything that is not a clean generated file. */
export function readClutterBaseline(file = BASELINE_PATH): { scenes: Record<string, ClutterCounts>; problems: string[]; exists: boolean } {
  if (!fs.existsSync(file)) return { scenes: {}, problems: [], exists: false };
  const problems: string[] = [];
  let parsed: Partial<ClutterBaselineFile>;
  const raw = fs.readFileSync(file, 'utf8');
  try {
    parsed = JSON.parse(raw) as Partial<ClutterBaselineFile>;
  } catch (e) {
    return { scenes: {}, problems: [`declutter.json is not valid JSON (${(e as Error).message})`], exists: true };
  }
  if (parsed.probe !== 'declutter') problems.push(`declutter.json names probe ${JSON.stringify(parsed.probe)}`);
  const scenes: Record<string, ClutterCounts> = {};
  for (const [key, counts] of Object.entries(parsed.scenes ?? {})) {
    if (!/^[a-z0-9-]+@(phone|desk)-(light|dark)$/.test(key)) problems.push(`declutter.json: "${key}" is not <scene>@<phone|desk>-<light|dark>`);
    scenes[key] = {};
    for (const [m, n] of Object.entries(counts ?? {})) {
      if (!(CLUTTER_METRICS as readonly string[]).includes(m)) problems.push(`declutter.json: ${key} has an unknown metric "${m}"`);
      else if (!Number.isInteger(n) || (n as number) <= 0) problems.push(`declutter.json: ${key} ${m} is ${JSON.stringify(n)} (positive integers; drop a zero)`);
      else scenes[key][m as ClutterMetric] = n as number;
    }
  }
  if (!problems.length && raw !== serialiseClutterBaseline(scenes)) problems.push('declutter.json is hand-edited or has stale targets: regenerate it (UPDATE_BASELINES=1, or =reset for a reviewed exception)');
  return { scenes, problems, exists: true };
}

/**
 * Read-modify-write a JSON file under an exclusive lock (the four view × theme tests may run in parallel workers):
 * `<file>.lock` is created with O_EXCL, the new text is written beside and renamed in place.
 */
export function withFileLock<T>(file: string, body: () => T, timeoutMs = 20_000): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { force: true });
      } catch {
        /* gone already */
      }
      if (Date.now() > deadline) throw new Error(`${lock} is held by another run`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return body();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Write text atomically (temp file + rename). */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
