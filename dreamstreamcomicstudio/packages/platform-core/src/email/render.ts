/**
 * `renderEmail(doc, brandKit)` → `{html, text}` (plan §7): the draft as an email-safe HTML document plus its
 * plain-text body, rendered inside the host with zero network calls.
 *
 * What the output guarantees, for ANY input (checked or not):
 * - every string is escaped, so text like `<img onerror=…>` or `<script>` shows as text and never becomes markup;
 * - no `<script>`, no `on*=` attribute, no `<style>` beyond the fixed layout rules, no `url()`;
 * - every `href` is `https:` or `mailto:` and is listed by `reviewEmail` (an unsafe link is dropped, its text kept);
 * - every `src` is a `data:` PNG, JPEG or WebP image that passed `s.assetRef()` (MIME, base64, magic bytes, ≤ 5 MB);
 *   a host asset id is shown only when `options.resolveAsset` hands back such a `data:` URI, never fetched;
 * - colours are `#RRGGBB` and fonts come from the font registry, so a BrandKit cannot inject CSS;
 * - the same document and kit always give the same bytes (no clock, no randomness).
 *
 * Hosts still sanitize what they show (Atlas `sanitizeHtml`) and preview it in a `srcdoc` iframe with `sandbox=""`.
 */
import type { EmailDoc, RenderedEmail } from '../contract/email.js';
import { HEX_COLOR_PATTERN } from '../contract/schema.js';
import { BRAND_LIMITS, DEFAULT_BRAND, brandKitById, type BrandKit } from '../brand/brandKit.js';
import { fontStack } from '../brand/fonts.js';
import { check } from '../schema/check.js';
import { s } from '../schema/s.js';
import {
  CONTENT_WIDTH,
  button,
  cleanText,
  columns,
  divider,
  escapeHtml,
  heading,
  image,
  link,
  list,
  muted,
  paragraph,
  quote,
  signature,
  textHtml,
  wrapHtml,
  type EmailStyle,
} from './layout.js';
import { emailToPlainText } from './plainText.js';
import { readDoc, type ReadBlock, type ReadRun } from './read.js';

export interface RenderEmailOptions {
  /**
   * Turns a host asset id (an image block's or the logo's `{kind:'asset', id}`) into a `data:` URI the host ALREADY
   * holds. It must not fetch; whatever it returns is validated like any `data:` image. Absent, or returning
   * `undefined`, shows the image's alt text instead.
   */
  resolveAsset?: (id: string) => string | undefined;
  /** The document language for `<html lang>` (a BCP 47 tag); default `en`. */
  lang?: string;
}

const HEX = new RegExp(HEX_COLOR_PATTERN);
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/;
const IMAGE = s.assetRef();

type Obj = { [key: string]: unknown };
const own = (o: unknown, key: string): unknown =>
  typeof o === 'object' && o !== null && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, key) ? (o as Obj)[key] : undefined;

const hexOr = (v: unknown, fallback: string): string => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);

const pxOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && v >= 0 && v <= BRAND_LIMITS.radiusMax ? Math.round(v) : fallback;

/** A BrandKit as validated email styling: every colour `#rrggbb` (else the default kit's), fonts from the registry. */
export const emailStyleOf = (kit: BrandKit | null | undefined): EmailStyle => {
  const d = DEFAULT_BRAND;
  const c = own(kit, 'colors');
  const f = own(kit, 'fonts');
  const e = own(kit, 'emailTheme');
  const font = (v: unknown, fallback: string): string => fontStack(typeof v === 'string' ? v : fallback);
  return {
    canvas: hexOr(own(c, 'canvas'), d.colors.canvas),
    surface: hexOr(own(c, 'surface'), d.colors.surface),
    ink: hexOr(own(c, 'ink'), d.colors.ink),
    muted: hexOr(own(c, 'muted'), d.colors.muted),
    accent: hexOr(own(c, 'accent'), d.colors.accent),
    accentText: hexOr(own(c, 'accentText'), d.colors.accentText),
    onAccent: hexOr(own(c, 'onAccent'), d.colors.onAccent),
    border: hexOr(own(c, 'border'), d.colors.border),
    bodyFont: font(own(f, 'body'), d.fonts.body),
    headingFont: font(own(f, 'display'), d.fonts.display),
    radius: pxOr(own(e, 'radius'), d.emailTheme.radius),
    buttonRadius: pxOr(own(e, 'buttonRadius'), d.emailTheme.buttonRadius),
  };
};

/**
 * The `data:` URI an image reference stands for, or `undefined`: a `data:` ref must pass `s.assetRef()`; an `asset`
 * ref goes through the host's resolver (which may not throw its way out) and the result must pass too.
 */
export const imageSource = (ref: unknown, resolveAsset?: (id: string) => string | undefined): string | undefined => {
  if (own(ref, 'kind') === 'data') {
    const r = check(IMAGE, ref);
    return r.ok === true ? (r.value as { dataUri: string }).dataUri : undefined;
  }
  if (own(ref, 'kind') !== 'asset' || !check(IMAGE, ref).ok || !resolveAsset) return undefined;
  let uri: unknown;
  try {
    uri = resolveAsset(own(ref, 'id') as string);
  } catch (_err) {
    return undefined;
  }
  if (typeof uri !== 'string') return undefined;
  const r = check(IMAGE, { kind: 'data', dataUri: uri });
  return r.ok === true ? uri : undefined;
};

const MARK_OPEN: { [m: string]: string } = {
  b: '<strong>',
  i: '<em>',
  u: '<u>',
};
const MARK_CLOSE: { [m: string]: string } = { b: '</strong>', i: '</em>', u: '</u>' };

const runHtml = (st: EmailStyle, r: ReadRun): string => {
  // A link with no visible text shows its URL (as the plain text does), so no link is ever invisible.
  let h = textHtml(r.href && r.text.trim() === '' ? r.href : r.text);
  if (r.marks.indexOf('code') !== -1) {
    h = `<code style="font-family:Menlo,Consolas,'Courier New',monospace;font-size:0.92em;background:${st.canvas};border:1px solid ${st.border};border-radius:3px;padding:0 3px;">${h}</code>`;
  }
  for (const m of ['u', 'i', 'b']) if (r.marks.indexOf(m as 'u' | 'i' | 'b') !== -1) h = `${MARK_OPEN[m]}${h}${MARK_CLOSE[m]}`;
  return link(st, r.href, h);
};

const runsHtml = (st: EmailStyle, runs: readonly ReadRun[]): string => runs.map((r) => runHtml(st, r)).join('');

/** A text block with no visible text renders nothing (an empty `<h1>` is noise, never a spacer we promised). */
const blank = (runs: readonly ReadRun[]): boolean => runs.every((r) => r.text.trim() === '' && !r.href);

const nonEmpty = (parts: string[]): string[] => parts.filter((x) => x !== '');

const placeholder = (st: EmailStyle, alt: string): string => muted(st, textHtml(alt.trim() ? `[Image: ${alt.trim()}]` : '[Image]'));

const blockHtml = (st: EmailStyle, b: ReadBlock, resolveAsset: RenderEmailOptions['resolveAsset'], width: number): string => {
  switch (b.type) {
    case 'heading':
      return blank(b.runs) ? '' : heading(st, b.level, runsHtml(st, b.runs));
    case 'paragraph':
      return blank(b.runs) ? '' : paragraph(st, runsHtml(st, b.runs));
    case 'list':
      return list(
        st,
        b.ordered,
        b.items.map((it): [string, number] => [runsHtml(st, it.runs), it.indent])
      );
    case 'button':
      if (!b.label.trim()) return b.href ? button(st, b.href, b.href) : '';
      return button(st, b.label, b.href);
    case 'quote':
      if (blank(b.runs) && !b.cite) return '';
      return quote(st, runsHtml(st, b.runs), b.cite ? textHtml(b.cite) : '');
    case 'divider':
      return divider(st);
    case 'image': {
      const src = imageSource(b.ref, resolveAsset);
      return src ? image(src, b.alt, Math.min(b.width ?? width, width)) : placeholder(st, b.alt);
    }
    case 'columns': {
      const colWidth = b.columns.length > 1 ? Math.floor((width - 24) / 2) : width;
      return columns(b.columns.map((col) => nonEmpty(col.map((x) => blockHtml(st, x, resolveAsset, colWidth))).join('\n')));
    }
  }
};

const headerHtml = (st: EmailStyle, kit: BrandKit, resolveAsset: RenderEmailOptions['resolveAsset']): string => {
  const mode = own(own(kit, 'emailTheme'), 'header');
  const wordmark = cleanText(own(kit, 'wordmark')).replace(/\n/g, ' ').slice(0, BRAND_LIMITS.wordmark);
  if (mode === 'logo') {
    const src = imageSource(own(kit, 'logo'), resolveAsset);
    if (src) return `<img src="${escapeHtml(src)}" alt="${escapeHtml(wordmark)}" width="160" style="display:block;width:160px;max-width:100%;height:auto;border:0;">`;
  }
  if ((mode === 'logo' || mode === 'wordmark') && wordmark) {
    return `<span style="font-family:${st.headingFont};font-size:22px;line-height:1.2;font-weight:700;color:${st.ink};">${escapeHtml(wordmark)}</span>`;
  }
  return '';
};

/** Render a draft (see the module comment). Pure; never throws; nothing it returns can send or fetch. */
export const renderEmail = (doc: EmailDoc, brand?: BrandKit | null, options?: RenderEmailOptions): RenderedEmail => {
  const d = readDoc(doc);
  const kit = brand ?? brandKitById(d.brand);
  const st = emailStyleOf(kit);
  const resolveAsset = options?.resolveAsset;
  const parts = nonEmpty(d.blocks.map((b) => blockHtml(st, b, resolveAsset, CONTENT_WIDTH)));
  if (d.signature.trim()) parts.push(signature(st, d.signature.replace(/\s+$/, '')));
  const footer = own(own(kit, 'emailTheme'), 'footer');
  const html = wrapHtml({
    style: st,
    title: d.subject,
    preheader: d.preheader,
    headerHtml: headerHtml(st, kit, resolveAsset),
    content: parts.join('\n'),
    footer: typeof footer === 'string' ? footer.slice(0, BRAND_LIMITS.footer) : '',
    lang: options?.lang !== undefined && LANG.test(options.lang) ? options.lang : 'en',
  });
  return { html, text: emailToPlainText(doc) };
};
