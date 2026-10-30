/**
 * Email-safe building blocks (plan §7): table-based markup with inline CSS, because real inboxes (Gmail, Outlook
 * desktop and web, Apple Mail, Yahoo) strip most of everything else.
 *
 * COPIED from `shared/email/layout.ts` (DreamStream's own product mail, which stays untouched) and narrowed for drafts
 * a person sends from their own mail client, rendered inside a host with zero network calls:
 * - links are `https:` or `mailto:` only (`isSafeHref`); an unsafe link is dropped and its text stays plain (the
 *   original allowed `http:` and fell back to `#`);
 * - nothing is fetched: no `@import` of web fonts, no read-receipt pixel, no hosted logo URL (a logo is a `data:`
 *   image), so the HTML loads no resource at all;
 * - no clock: the copyright year is gone, so the same draft always renders to the same bytes;
 * - colours and fonts come from a BrandKit (`EmailStyle`), not the comic house palette;
 * - no product footer (open the app, sign in, unsubscribe): a person's own draft carries none;
 * - the Outlook VML button is dropped (it repeated the link inside a conditional comment).
 *
 * Every helper escapes the text it is given; `innerHtml` parameters take markup these helpers built.
 */
import { isSafeHref } from '../schema/check.js';

/** The resolved, validated look of one email (built from a BrandKit by `emailStyleOf`). */
export interface EmailStyle {
  canvas: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  accentText: string;
  onAccent: string;
  border: string;
  /** CSS font stacks from the font registry. */
  bodyFont: string;
  headingFont: string;
  /** px */
  radius: number;
  buttonRadius: number;
}

/** The card is 600 px wide with 32 px padding and a 1 px border: the room an image can take. */
export const CONTENT_WIDTH = 534;

/** Escape text before it lands in HTML (element content or a double- or single-quoted attribute). */
export const escapeHtml = (value: string): string =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** An `https:` or `mailto:` href that passed `isSafeHref`, else `''` (render no link). */
export const safeUrl = (value: unknown): string => (typeof value === 'string' && isSafeHref(value) ? value : '');

/**
 * Text as the renderer will show it: CRLF and CR become LF; C0 controls (except tab and LF), DEL, C1 controls, bidi
 * embedding/override/isolate characters and unpaired surrogates are removed. `check()` already refuses all of
 * these; this keeps an unchecked document harmless too.
 */
export const cleanText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const v = value.replace(/\r\n?/g, '\n');
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a) continue;
    if (c >= 0x7f && c <= 0x9f) continue;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) continue;
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = v.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += v.charAt(i) + v.charAt(i + 1);
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += v.charAt(i);
  }
  return out;
};

/** Plain text as HTML: cleaned, escaped, line breaks as `<br>`. */
export const textHtml = (value: unknown): string => escapeHtml(cleanText(value)).replace(/\n/g, '<br>');

const bodyCss = (st: EmailStyle, size: number, color: string): string =>
  `font-family:${st.bodyFont};font-size:${size}px;line-height:1.6;color:${color};`;

const HEADING_SIZES: { [level: number]: number } = { 1: 26, 2: 21, 3: 18 };

/** `<h1>`–`<h3>` in the heading face. */
export const heading = (st: EmailStyle, level: 1 | 2 | 3, innerHtml: string): string => {
  const lv = level === 2 || level === 3 ? level : 1;
  return `<h${lv} style="margin:0 0 16px;font-family:${st.headingFont};font-size:${HEADING_SIZES[lv]}px;line-height:1.25;font-weight:700;color:${st.ink};">${innerHtml}</h${lv}>`;
};

/** A body paragraph. */
export const paragraph = (st: EmailStyle, innerHtml: string): string => `<p style="margin:0 0 16px;${bodyCss(st, 16, st.ink)}">${innerHtml}</p>`;

/** A quieter paragraph (placeholders, notes). */
export const muted = (st: EmailStyle, innerHtml: string): string => `<p style="margin:0 0 16px;${bodyCss(st, 14, st.muted)}">${innerHtml}</p>`;

/** A bulleted or numbered list; each item is `[innerHtml, indent 0–2]`. */
export const list = (st: EmailStyle, ordered: boolean, items: readonly [string, number][]): string => {
  const tag = ordered ? 'ol' : 'ul';
  const lis = items
    .map(([html, indent]) => `<li style="margin:0 0 6px${indent > 0 ? `;margin-left:${indent * 24}px` : ''};">${html}</li>`)
    .join('');
  return `<${tag} style="margin:0 0 16px;padding:0 0 0 24px;${bodyCss(st, 16, st.ink)}">${lis}</${tag}>`;
};

/** Quoted text with an accent bar; `citeHtml` (who wrote it) under it. */
export const quote = (st: EmailStyle, innerHtml: string, citeHtml: string): string =>
  `<blockquote style="margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid ${st.accent};${bodyCss(st, 16, st.muted)}">${innerHtml}${
    citeHtml ? `<span style="display:block;margin-top:6px;font-size:14px;">— ${citeHtml}</span>` : ''
  }</blockquote>`;

/** A thin divider rule. */
export const divider = (st: EmailStyle): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-top:1px solid ${st.border};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;

/** A link around already-built inline HTML; `''` href means no link (the text stays). */
export const link = (st: EmailStyle, href: string, innerHtml: string): string =>
  href
    ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="color:${st.accentText};text-decoration:underline;">${innerHtml}</a>`
    : innerHtml;

/** A bulletproof table button: the accent fill with its readable label. An unsafe href leaves the label as plain text. */
export const button = (st: EmailStyle, label: string, href: string): string => {
  const text = textHtml(label);
  if (!href) return paragraph(st, `<strong>${text}</strong>`);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td align="center" bgcolor="${st.accent}" style="border-radius:${st.buttonRadius}px;background:${st.accent};"><a href="${escapeHtml(
    href
  )}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:${st.bodyFont};font-size:16px;font-weight:600;line-height:1.2;color:${st.onAccent};text-decoration:none;border-radius:${st.buttonRadius}px;">${text}</a></td></tr></table>`;
};

/** An inline image from a `data:` URI the caller has already validated. */
export const image = (src: string, alt: string, width: number): string => {
  const w = Math.max(1, Math.min(CONTENT_WIDTH, Math.round(width)));
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(cleanText(alt))}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;margin:0 0 16px;">`;
};

/** One or two columns side by side, stacked on narrow screens (`.ds-col`). */
export const columns = (cells: readonly string[]): string => {
  if (cells.length === 0) return '';
  const pct = cells.length === 1 ? 100 : 50;
  const tds = cells
    .map((html, i) => {
      const pad = cells.length === 1 ? '0' : i === 0 ? '0 12px 0 0' : '0 0 0 12px';
      return `<td class="ds-col" valign="top" width="${pct}%" style="width:${pct}%;padding:${pad};vertical-align:top;">${html}</td>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse;"><tr>${tds}</tr></table>`;
};

/** The sign-off under the body, line breaks kept. */
export const signature = (st: EmailStyle, text: string): string => `<p style="margin:24px 0 0;${bodyCss(st, 15, st.muted)}">${textHtml(text)}</p>`;

export interface LayoutInput {
  style: EmailStyle;
  /** `<title>` (the subject). */
  title: string;
  /** Hidden inbox-preview text; omitted when empty. */
  preheader: string;
  /** Markup above the card (a logo or wordmark), or `''`. */
  headerHtml: string;
  /** The card's content, built from the helpers above. */
  content: string;
  /** One plain-text line under the card, or `''`. */
  footer: string;
  /** A BCP 47 language tag the caller validated. */
  lang: string;
}

/** Wrap the card in the full responsive document: one centred 600 px card on the brand canvas. */
export const wrapHtml = ({ style: st, title, preheader, headerHtml, content, footer, lang }: LayoutInput): string => {
  const pre = cleanText(preheader).replace(/\n/g, ' ');
  const preDiv = pre
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${st.canvas};">${escapeHtml(
        pre
      )}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>\n`
    : '';
  const head = headerHtml ? `<tr><td style="padding:0 4px 16px;" align="left">${headerHtml}</td></tr>\n` : '';
  const foot = footer
    ? `\n<tr><td align="center" style="padding:16px 8px 0;font-family:${st.bodyFont};font-size:12px;line-height:1.6;color:${st.muted};">${textHtml(
        cleanText(footer).replace(/\n/g, ' ')
      )}</td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(cleanText(title).replace(/\n/g, ' '))}</title>
<style>
body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; }
@media (max-width:600px) { .ds-card { padding:24px 18px !important; } .ds-col { display:block !important; width:100% !important; padding:0 !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:${st.canvas};">
${preDiv}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${st.canvas};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
${head}<tr><td class="ds-card" style="background:${st.surface};border:1px solid ${st.border};border-radius:${st.radius}px;padding:32px;">
${content}
</td></tr>${foot}
</table>
</td></tr>
</table>
</body>
</html>
`;
};
