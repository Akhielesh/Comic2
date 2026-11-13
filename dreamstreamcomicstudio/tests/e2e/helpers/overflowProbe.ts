// The overflow probe (OV-1; docs/design/clean-and-smooth.md "The overflow ratchet"): what "nothing
// spills or gets cut" can measure on a rendered page, and the ratchet that keeps every gain.
//
//   const r = await measureOverflow(page);            // injects the long strings, then measures
//   r.counts  → { textEscapes, hOverflow }
//   const p = await measurePopovers(page);            // opens up to 12 popover triggers, one at a time
//   p.count   → popoverEscapes
//
// Metrics:
//   textEscapes     text nodes whose glyphs leave their nearest box (a border, a fill, a clip or a shadow) by > 2 px, or
//                   are cut by a clipping box by > 2 px without an ellipsis or a line clamp (an ellipsis is C6's
//                   business: tests/e2e/helpers/clutterProbe.ts), after the long strings are injected:
//                     - the 300-character error (a URL, a model id, a trace) into every role=alert|status, aria-live,
//                       data-slot=error-state|message (outermost only);
//                     - the 60-character model id into every [data-slot=chip|badge|status-chip|button-label];
//                     - each visible alert cloned twice (stacked errors).
//   hOverflow       px of horizontal page overflow after the injection.
//   popoverEscapes  for up to 12 visible triggers with aria-haspopup, or aria-expanded="false" + aria-controls, whose name
//                   is not an action that makes, spends or removes (POPOVER_SKIP): click, then every newly visible
//                   [data-slot=popover-content], [role=menu], [role=listbox], non-modal [role=dialog] and the controlled
//                   element counts when it leaves the viewport (left < 0, right > innerWidth, top < 0, bottom >
//                   innerHeight, 1 px of slack); Escape; next. QA scenes never reach the network or spend.
//
// The ratchet (tests/e2e/baselines/overflow.json) is the declutter one: a listed scene may neither rise above nor fall
// below its entry; a scene the baseline does not list is held to 0 on every metric, so a new screen is clean from its
// first commit. UPDATE_BASELINES=1 only lowers; UPDATE_BASELINES=reset rewrites the measured entries (reviewed, rare).
// Importable from Node directly (type-only Playwright import).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

export const OVERFLOW_METRICS = ['textEscapes', 'hOverflow', 'popoverEscapes'] as const;
export type OverflowMetric = (typeof OVERFLOW_METRICS)[number];
export type OverflowCounts = Partial<Record<OverflowMetric, number>>;

/** The research's three strings (p4 research-overflow): a long error with a URL, a model id and a file name. */
export const STRESS_ID = 'studio/reference-sheet-preview-experimental-20261101-a1b2c3';
export const STRESS_ERROR =
  "We couldn't finish that because the image service answered with an unexpected error. Details: https://api.example-provider.dev/v1/images/generations/very-long-path-segment?model=" +
  STRESS_ID +
  '&trace=0123456789abcdef0123456789abcdef failed with code PROVIDER_UPSTREAM_TIMEOUT_EXCEEDED_WHILE_RENDERING after 120 s.';

/** Popover triggers the probe never presses: anything that makes, spends, sends or removes. */
export const POPOVER_SKIP = /send|draw|render|approve|delete|remove|publish|spend|buy|sign out|log out|discard|reset/i;
export const POPOVER_LIMIT = 12;

/** The probe's views (docs/design/clean-and-smooth.md "The overflow ratchet"): the 320 px reflow width light, a phone dark, the desk light. */
export const OVERFLOW_VIEWS = [
  { id: 'narrow', device: 'smoke-320x640', theme: 'light' },
  { id: 'phone', device: 'smoke-360x740', theme: 'dark' },
  { id: 'desk', device: 'smoke-1280x800', theme: 'light' }
] as const;
export type OverflowView = (typeof OVERFLOW_VIEWS)[number];
export const OVERFLOW_SUFFIXES: readonly string[] = OVERFLOW_VIEWS.map((v) => `${v.id}-${v.theme}`);

/** The error and failure states the declutter loop does not open (docs/design/clean-and-smooth.md "The overflow ratchet"). */
export const OVERFLOW_EXTRA_SCENES: ReadonlyArray<{ id: string; q: Record<string, string | number | boolean> }> = [
  { id: 'studio-error', q: { surface: 'studio', fixture: 'heist-12p', tab: 'pages', state: 'error' } },
  { id: 'studio-failed-send', q: { surface: 'studio', fixture: 'heist-12p', tab: 'pages', state: 'failed-send' } },
  { id: 'studio-load-error', q: { surface: 'studio', fixture: 'heist-12p', state: 'load-error' } },
  { id: 'studio-conflict', q: { surface: 'studio', fixture: 'heist-12p', tab: 'pages', state: 'conflict' } },
  { id: 'public-error', q: { surface: 'public', fixture: 'heist-12p', public: 'error' } },
  { id: 'public-notfound', q: { surface: 'public', fixture: 'heist-12p', public: 'not-found' } }
];

/** The app scenes the probe opens with extra query (the stress scene's long strings). */
export const APP_SCENE_QUERY: Record<string, Record<string, string>> = { 'overflow-stress': { stress: '1' } };

// ── The in-page text probe ──────────────────────────────────────────────────

export interface TextEscape {
  kind: 'message' | 'label' | 'stacked';
  issue: string;
  /** A short selector path of the text's element (review aid). */
  at: string;
}
export interface TextProbeResult {
  counts: { textEscapes: number; hOverflow: number };
  escapes: TextEscape[];
  injected: number;
}

/* Self-contained: Playwright ships this function's source to the page (no closures over module scope). */
export function probeTextOverflow(args: { error: string; id: string; inject: boolean }): TextProbeResult {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const cs = (el: Element) => getComputedStyle(el);
  const visible = (el: Element) => {
    const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
    if (anyEl.checkVisibility && !anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const dormant = (el: Element) => !!el.closest('[inert],[aria-hidden="true"],.sr-only,svg');
  const textNodesOf = (el: Element): Text[] => {
    const out: Text[] = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) {
      const p = (n as Text).parentElement;
      if ((n.textContent || '').trim().length > 1 && p && !p.closest('svg,.sr-only,[aria-hidden="true"],button')) out.push(n as Text);
    }
    return out;
  };
  const labelNodesOf = (el: Element): Text[] => {
    const out: Text[] = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) if ((n.textContent || '').trim().length > 0 && !(n as Text).parentElement?.closest('svg,.sr-only,[aria-hidden="true"]')) out.push(n as Text);
    return out;
  };
  const isBox = (el: Element) => {
    const s = cs(el);
    const side = (k: 'Top' | 'Right' | 'Bottom' | 'Left') =>
      parseFloat(s.getPropertyValue(`border-${k.toLowerCase()}-width`)) > 0 && s.getPropertyValue(`border-${k.toLowerCase()}-style`) !== 'none' && !/rgba\(.*,\s*0\)$/.test(s.getPropertyValue(`border-${k.toLowerCase()}-color`));
    const border = side('Top') || side('Right') || side('Bottom') || side('Left');
    const fill = !!s.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor);
    const clip = s.overflowX !== 'visible' || s.overflowY !== 'visible';
    const shadow = !!s.boxShadow && s.boxShadow !== 'none';
    return border || fill || clip || shadow;
  };
  const boxOf = (el: Element): Element | null => {
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      if (a === document.body) return null;
      if (isBox(a)) {
        const r = a.getBoundingClientRect();
        if (r.width >= vw - 2 && r.height >= vh - 2) return null; // the page canvas is not a box
        return a;
      }
    }
    return null;
  };
  const sig = (el: Element) => {
    const parts: string[] = [];
    let a: Element | null = el;
    for (let i = 0; a && a !== document.body && i < 3; i++, a = a.parentElement) {
      let s = a.tagName.toLowerCase();
      for (const k of ['data-testid', 'data-slot', 'role']) if (a.getAttribute(k)) s += `[${k}="${(a.getAttribute(k) || '').slice(0, 24)}"]`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };

  const mutated: Array<{ el: Element; node: Text; kind: TextEscape['kind'] }> = [];
  if (args.inject) {
    const longest = (nodes: Text[]) => nodes.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0];
    const MESSAGES = '[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"],[data-slot="error-state"],[data-slot="message"]';
    const msgs = Array.from(document.querySelectorAll(MESSAGES)).filter((e) => visible(e) && !dormant(e));
    const outer = msgs.filter((e) => !msgs.some((o) => o !== e && o.contains(e))).slice(0, 60);
    for (const el of outer) {
      const node = longest(textNodesOf(el));
      if (!node) continue;
      node.textContent = args.error;
      mutated.push({ el, node, kind: 'message' });
    }
    const LABELS = '[data-slot="chip"],[data-slot="badge"],[data-slot="status-chip"],[data-slot="button-label"]';
    const labels = Array.from(document.querySelectorAll(LABELS)).filter((e) => visible(e) && !dormant(e) && !e.closest(MESSAGES)).slice(0, 80);
    for (const el of labels) {
      const node = longest(labelNodesOf(el));
      if (!node) continue;
      node.textContent = args.id;
      mutated.push({ el, node, kind: 'label' });
    }
    for (const el of Array.from(document.querySelectorAll('[role="alert"]')).filter((e) => visible(e) && !dormant(e)).slice(0, 4)) {
      for (let i = 0; i < 2; i++) {
        const c = el.cloneNode(true) as Element;
        c.removeAttribute('id');
        c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        el.after(c);
        const node = longest(textNodesOf(c));
        if (node) mutated.push({ el: c, node, kind: 'stacked' });
      }
    }
  } else {
    // Measure as rendered: every message and label text node, untouched (the self-test's clean and broken pages).
    for (const el of Array.from(document.querySelectorAll('[data-probe-text]'))) for (const node of labelNodesOf(el)) mutated.push({ el, node, kind: 'message' });
  }
  // Let layout settle on the new text (synchronous: reading a rect forces it).
  void document.body.offsetHeight;

  const escapes: TextEscape[] = [];
  for (const m of mutated) {
    if (!m.el.isConnected || !visible(m.el)) continue;
    const range = document.createRange();
    range.selectNodeContents(m.node);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1);
    if (!rects.length) continue;
    const tr = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    const tp = m.node.parentElement!;
    const box = boxOf(tp);
    if (!box) {
      if (tr.right > vw + 2 || tr.left < -2) escapes.push({ kind: m.kind, issue: `off-screen ${Math.round(Math.max(tr.right - vw, -tr.left))}px`, at: sig(tp) });
      continue;
    }
    const br = box.getBoundingClientRect();
    const bs = cs(box);
    const overX = Math.max(tr.right - br.right, br.left - tr.left);
    const overY = tr.bottom - br.bottom;
    const clipX = bs.overflowX !== 'visible';
    const clipY = bs.overflowY !== 'visible';
    const scrolls = /(auto|scroll)/.test(bs.overflowX) || /(auto|scroll)/.test(bs.overflowY);
    let ellipsis = false;
    for (let a: Element | null = tp; a; a = a.parentElement) {
      const s = cs(a);
      const clamp = s.getPropertyValue('-webkit-line-clamp');
      if (s.textOverflow === 'ellipsis' || (clamp && clamp !== 'none')) ellipsis = true;
      if (a === box) break;
    }
    let issue = '';
    if (overX > 2 && !clipX) issue = `escapes-x ${Math.round(overX)}px`;
    else if (overY > 2 && !clipY) issue = `escapes-y ${Math.round(overY)}px`;
    else if (overX > 2 && clipX && !ellipsis && !scrolls) issue = `cut-x ${Math.round(overX)}px`;
    else if (overY > 2 && clipY && !ellipsis && !scrolls) issue = `cut-y ${Math.round(overY)}px`;
    if (issue) escapes.push({ kind: m.kind, issue, at: sig(tp) });
  }
  const hOverflow = Math.max(0, Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw);
  return { counts: { textEscapes: escapes.length, hOverflow }, escapes, injected: mutated.length };
}

export async function measureOverflow(page: Page, inject = true): Promise<TextProbeResult> {
  return page.evaluate(probeTextOverflow, { error: STRESS_ERROR, id: STRESS_ID, inject });
}

// ── Popovers ────────────────────────────────────────────────────────────────

export interface PopoverResult {
  count: number;
  /** `<trigger name> → <box> (left,top,right,bottom)` for each escape. */
  escapes: string[];
  tried: string[];
}

/** Marks up to `limit` visible, safe popover triggers (data-ovp-i) and returns their names. */
function markTriggers(args: { skip: string; limit: number }): string[] {
  const skip = new RegExp(args.skip, 'i');
  const names: string[] = [];
  const all = Array.from(document.querySelectorAll('[aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded="false"][aria-controls]'));
  for (const el of all) {
    if (names.length >= args.limit) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight || el.closest('[inert],[aria-hidden="true"]')) continue;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const name = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (skip.test(name)) continue;
    el.setAttribute('data-ovp-i', String(names.length));
    names.push(name || el.tagName.toLowerCase());
  }
  return names;
}

/** Popover-like boxes that are visible now; with `mark`, tags them so the next call can tell new from old. */
function popoverBoxes(args: { mark: boolean; controls: string | null }): Array<{ sig: string; l: number; t: number; r: number; b: number; fresh: boolean }> {
  const SEL = '[data-slot="popover-content"],[role="menu"],[role="listbox"],[role="dialog"]:not([aria-modal="true"])';
  const els = new Set(Array.from(document.querySelectorAll(SEL)));
  if (args.controls) {
    // The controlled element counts only when it floats: an in-flow disclosure (MessageText's Show more, an accordion)
    // grows the page, which scrolls to it; it never leaves the screen the way a popover can.
    const c = document.getElementById(args.controls);
    if (c && /^(fixed|absolute)$/.test(getComputedStyle(c).position)) els.add(c);
  }
  const out: Array<{ sig: string; l: number; t: number; r: number; b: number; fresh: boolean }> = [];
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (rect.width < 2 || rect.height < 2 || s.visibility === 'hidden' || s.display === 'none') continue;
    const fresh = !el.hasAttribute('data-ovp-seen');
    if (args.mark) el.setAttribute('data-ovp-seen', '');
    out.push({ sig: `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}${el.getAttribute('data-slot') ? `[${el.getAttribute('data-slot')}]` : ''}`, l: rect.left, t: rect.top, r: rect.right, b: rect.bottom, fresh });
  }
  return out;
}

export async function measurePopovers(page: Page, limit = POPOVER_LIMIT): Promise<PopoverResult> {
  const tried = await page.evaluate(markTriggers, { skip: POPOVER_SKIP.source, limit });
  const escapes: string[] = [];
  const view = page.viewportSize() ?? { width: 0, height: 0 };
  for (let i = 0; i < tried.length; i++) {
    const trigger = page.locator(`[data-ovp-i="${i}"]`).first();
    try {
      if (!(await trigger.isVisible())) continue;
      await page.evaluate(popoverBoxes, { mark: true, controls: null });
      const controls = await trigger.getAttribute('aria-controls');
      await trigger.click({ timeout: 2_000 });
      await page.waitForTimeout(200);
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      for (const box of await page.evaluate(popoverBoxes, { mark: false, controls })) {
        if (!box.fresh) continue;
        if (box.l < -1 || box.r > vw + 1 || box.t < -1 || box.b > view.height + 1) escapes.push(`${tried[i]} → ${box.sig} (${Math.round(box.l)},${Math.round(box.t)},${Math.round(box.r)},${Math.round(box.b)})`);
      }
    } catch {
      /* a trigger that cannot be pressed (covered, detached) opens nothing to measure */
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(80);
  }
  return { count: escapes.length, escapes, tried };
}

// ── The ratchet ─────────────────────────────────────────────────────────────

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const OVERFLOW_BASELINE_PATH = path.join(APP, 'tests', 'e2e', 'baselines', 'overflow.json');
export const OVERFLOW_SPEC = 'tests/e2e/overflow.spec.ts';
const SHRINK = `UPDATE_BASELINES=1 npx playwright test -c tests/e2e/playwright.config.ts --project=overflow`;

export const overflowKey = (scene: string, view: string, theme: string): string => `${scene}@${view}-${theme}`;

/** The stored form: zeros dropped, metrics in report order. */
export function storedOverflow(counts: OverflowCounts): OverflowCounts {
  const out: OverflowCounts = {};
  for (const m of OVERFLOW_METRICS) if ((counts[m] ?? 0) > 0) out[m] = counts[m];
  return out;
}

/** A listed scene may neither rise nor fall; an unlisted one is held to 0 on every metric. */
export function judgeOverflow(key: string, actual: OverflowCounts, scenes: Record<string, OverflowCounts>): { over: string[]; under: string[] } {
  const over: string[] = [];
  const under: string[] = [];
  const listed = key in scenes;
  const base = scenes[key] ?? {};
  for (const m of OVERFLOW_METRICS) {
    const n = actual[m] ?? 0;
    const b = base[m] ?? 0;
    if (n > b) over.push(`${key}  ${m}: ${n}, ${listed ? `baseline ${b}` : 'not in the baseline: a new scene is held to 0'}`);
    else if (n < b) under.push(`${key}  ${m}: ${n}, baseline ${b} — it fell: lower the baseline (${SHRINK})`);
  }
  return { over, under };
}

/** Lower (shrink) or rewrite (reset) the entries measured this run; never raise in shrink; drop vanished scenes. */
export function updateOverflowBaseline(prior: Record<string, OverflowCounts>, measured: Record<string, OverflowCounts>, mode: 'shrink' | 'reset', drop: readonly string[] = []): Record<string, OverflowCounts> {
  const out: Record<string, OverflowCounts> = {};
  for (const [k, v] of Object.entries(prior)) if (!drop.includes(k)) out[k] = v;
  for (const [k, counts] of Object.entries(measured)) {
    if (mode === 'reset') {
      const s = storedOverflow(counts);
      if (Object.keys(s).length) out[k] = s;
      else delete out[k];
      continue;
    }
    if (!(k in out)) continue;
    const kept: OverflowCounts = {};
    for (const m of OVERFLOW_METRICS) {
      const n = Math.min(out[k][m] ?? 0, counts[m] ?? 0);
      if (n > 0) kept[m] = n;
    }
    if (Object.keys(kept).length) out[k] = kept;
    else delete out[k];
  }
  return out;
}

export function serialiseOverflowBaseline(scenes: Record<string, OverflowCounts>): string {
  const keys = Object.keys(scenes).sort();
  const body = keys.map((k) => {
    const s = storedOverflow(scenes[k]);
    return `    ${JSON.stringify(k)}: { ${Object.entries(s).map(([m, n]) => `${JSON.stringify(m)}: ${n}`).join(', ')} }`;
  });
  const note =
    'Overflow ratchet (docs/design/clean-and-smooth.md, "The overflow ratchet"): per scene@view-theme, the text escapes, page overflow and popover escapes that predate the probe. ' +
    `A scene not listed is held to 0; a listed one may neither rise nor fall. Generated, never typed: ${SHRINK} lowers it.`;
  return ['{', `  "note": ${JSON.stringify(note)},`, body.length ? `  "scenes": {\n${body.join(',\n')}\n  }` : '  "scenes": {}', '}', ''].join('\n');
}

export function readOverflowBaseline(file = OVERFLOW_BASELINE_PATH): { scenes: Record<string, OverflowCounts>; problems: string[]; exists: boolean } {
  if (!fs.existsSync(file)) return { scenes: {}, problems: [], exists: false };
  const text = fs.readFileSync(file, 'utf8');
  let parsed: { scenes?: Record<string, OverflowCounts> };
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { scenes: {}, problems: [`overflow.json is not valid JSON (${(e as Error).message})`], exists: true };
  }
  const scenes = parsed.scenes ?? {};
  const problems: string[] = [];
  for (const [k, v] of Object.entries(scenes)) {
    const suffix = k.split('@')[1] ?? '';
    if (!/^[a-z0-9-]+@[a-z]+-(light|dark)$/.test(k) || !OVERFLOW_SUFFIXES.includes(suffix)) problems.push(`"${k}" is not <scene>@<view>-<theme> for a measured view (${OVERFLOW_SUFFIXES.join(', ')})`);
    for (const [m, n] of Object.entries(v)) {
      if (!(OVERFLOW_METRICS as readonly string[]).includes(m)) problems.push(`${k}: unknown metric ${m}`);
      else if (!Number.isInteger(n) || (n as number) <= 0) problems.push(`${k}: ${m} is ${JSON.stringify(n)} (entries are positive integers)`);
    }
  }
  if (!problems.length && text !== serialiseOverflowBaseline(scenes)) problems.push('overflow.json is hand-edited: regenerate it');
  return { scenes, problems, exists: true };
}
