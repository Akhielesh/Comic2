// The 1200×630 link-preview card of a published comic (sharing.md §6). Made by software:
// sharp + Pango/HarfBuzz with vendored OFL fonts (server/assets/fonts), $0, no AI.
//
// Layout (everything important sits inside the centre 630×630, which WhatsApp, Discord and
// iMessage crop to a square):
//   backdrop: the cover (or first published page) blurred and darkened, or a themed gradient;
//   cover card: the art fit to 530 px high, rounded 18 px, soft shadow, at x=88;
//   text column x=560…1130: title (Bangers + per-script Noto, auto-fit 64→40 px, ≤ 3 lines,
//   dark outline), description (Noto Sans SemiBold 26 px, ≤ 3 lines), meta row;
//   mark: "DreamStream Studio", bottom right.
//
// Every user string reaches Pango only through escPango (markup injection), and scripts the
// vendored fonts cannot draw (CJK, phase 2) fall back to the caller's source-language title,
// so a preview never shows tofu boxes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions, type Sharp } from 'sharp';
import { OG_TEMPLATE_VERSION } from '../../../../shared/comic/publication.js';
import { logger } from '../../lib/logger.js';

export const OG_W = 1200;
export const OG_H = 630;
export const OG_MAX_BYTES = 300 * 1024;
const DEFAULT_THEME = '#3B5B8C';

export interface OgRenderInput {
  title: string;
  subtitle: string;
  kindLabel: string;
  pageCount: number;
  lang: string;
  coverBuf: Buffer | null;
  fallbackPageBuf: Buffer | null;
  themeColor?: string;
  showMark: true;
  /** Endonyms of every published edition ("English / हिन्दी"), for the meta row. */
  languagesLabel?: string;
  /** Title to draw when `title` uses a script the vendored fonts do not cover. */
  fallbackTitle?: string;
}

// ── Escaping ─────────────────────────────────────────────────────────────────

/** Pango markup escape: user text is ALWAYS literal (a title of `<span foreground="red">` renders as typed). */
export const escPango = (text: string): string =>
  String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** XML attribute/text escape for the SVG layers. */
const escXml = (text: string): string =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// ── Fonts ────────────────────────────────────────────────────────────────────

/** Scripts the vendored fonts cover. CJK/Hangul/Thai… are not (yet): see scriptsCovered. */
const UNCOVERED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Ethiopic}\p{Script=Hebrew}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\p{Script=Georgian}\p{Script=Armenian}]/u;

/** True when every letter in `text` is drawable with the vendored fonts (no tofu). */
export const scriptsCovered = (text: string): boolean => !UNCOVERED.test(String(text ?? ''));

const TITLE_FAMILIES = 'Bangers,Noto Sans Devanagari,Noto Sans Bengali,Noto Sans Tamil,Noto Sans Telugu,Noto Sans Kannada,Noto Sans Malayalam,Noto Sans Gujarati,Noto Sans Gurmukhi,Noto Sans Arabic,Noto Sans';
const BODY_FAMILIES = 'Noto Sans,Noto Sans Devanagari,Noto Sans Bengali,Noto Sans Tamil,Noto Sans Telugu,Noto Sans Kannada,Noto Sans Malayalam,Noto Sans Gujarati,Noto Sans Gurmukhi,Noto Sans Arabic';
/** Latin titles use the comic display face; other scripts start with their bold Noto. */
const titleFamiliesFor = (text: string): string => (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text) ? `${BODY_FAMILIES.replace('Noto Sans,', '')},Noto Sans` : TITLE_FAMILIES);

const FONT_DIR_CANDIDATES = (): string[] => {
  const here = (() => {
    try {
      return path.dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();
  return [
    process.env.COMIC_OG_FONT_DIR || '',
    '/usr/local/share/fonts/dreamstream',
    path.resolve(process.cwd(), 'server/assets/fonts'),
    path.resolve(here, '../../../assets/fonts'),
    path.resolve(here, '../../../../server/assets/fonts')
  ].filter(Boolean);
};

let fontFiles: string[] | null = null;
let fontsRegistered: Promise<void> | null = null;

/** Vendored font files (absolute paths); [] when none are installed (tests skip, the Docker smoke enforces). */
export function vendoredFontFiles(): string[] {
  if (fontFiles) return fontFiles;
  for (const dir of FONT_DIR_CANDIDATES()) {
    try {
      const files = fs.readdirSync(dir).filter((f) => /\.ttf$/i.test(f)).map((f) => path.join(dir, f));
      if (files.length) {
        fontFiles = files;
        return files;
      }
    } catch {
      /* try the next location */
    }
  }
  fontFiles = [];
  return fontFiles;
}

/**
 * Make every vendored face known to Pango in this process (libvips adds each `fontfile` to
 * the fontconfig app set once). In the container fc-cache already did this; locally (tests)
 * it is what makes the fonts resolvable without installing them.
 */
export function ensureOgFonts(): Promise<void> {
  if (!fontsRegistered) {
    fontsRegistered = (async () => {
      for (const file of vendoredFontFiles()) {
        try {
          await sharp({ text: { text: 'a', fontfile: file, rgba: true } }).png().toBuffer();
        } catch (err) {
          logger.warn('comic_og_font_register_failed', { file: path.basename(file), message: (err as Error)?.message });
        }
      }
    })();
  }
  return fontsRegistered;
}

// ── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Content hash of an OG card (12 hex): stable for the same input, changes with the title,
 * text, cover, language or OG_TEMPLATE_VERSION. Used in the file name, so a changed card is a
 * new URL (cache-busting for platforms that cache by image URL).
 */
export function ogHash(input: Omit<OgRenderInput, 'coverBuf' | 'fallbackPageBuf'> & { coverPath?: string }): string {
  const material = JSON.stringify([
    OG_TEMPLATE_VERSION,
    input.title,
    input.subtitle,
    input.kindLabel,
    input.pageCount,
    input.lang,
    input.themeColor || '',
    input.languagesLabel || '',
    input.fallbackTitle || '',
    input.coverPath || ''
  ]);
  return crypto.createHash('sha1').update(material).digest('hex').slice(0, 12);
}

// ── Rendering helpers ────────────────────────────────────────────────────────

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const safeHex = (c: string | undefined, fallback = DEFAULT_THEME): string => (c && HEX_RE.test(c) ? c : fallback);

/** Dominant colour of an image, darkened enough to sit behind white text. */
export async function dominantColor(buf: Buffer | null): Promise<string | undefined> {
  if (!buf) return undefined;
  try {
    const { dominant } = await sharp(buf, { limitInputPixels: 64_000_000 }).stats();
    const k = 0.72;
    const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n * k))).toString(16).padStart(2, '0');
    return `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
  } catch {
    return undefined;
  }
}

interface TextLayer {
  buf: Buffer;
  w: number;
  h: number;
}

async function renderText(markup: string, opts: { font: string; width: number; align?: 'left' | 'centre' | 'right'; spacing?: number }): Promise<TextLayer> {
  const { data, info } = await sharp({
    text: {
      text: markup,
      font: opts.font,
      width: opts.width,
      rgba: true,
      wrap: 'word-char',
      align: opts.align || 'left',
      ...(opts.spacing ? { spacing: opts.spacing } : {})
    }
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buf: data, w: info.width, h: info.height };
}

/** Title: largest size from 64 → 40 px that fits 3 lines; the 40 px render otherwise (clamped by the caller's text length). */
async function renderTitle(text: string, width: number): Promise<{ fill: TextLayer; outline: TextLayer; size: number }> {
  const families = titleFamiliesFor(text);
  const sizes = [64, 58, 52, 46, 40];
  let chosen: { fill: TextLayer; size: number } | null = null;
  for (const size of sizes) {
    const lineH = size * 1.22;
    const fill = await renderText(`<span foreground="#FFFFFF" letter_spacing="${size >= 52 ? 1024 : 512}">${escPango(text)}</span>`, {
      font: `${families} ${size}px`,
      width
    });
    chosen = { fill, size };
    if (fill.h <= lineH * 3 + 4) break;
  }
  const size = chosen!.size;
  const outline = await renderText(`<span foreground="#14110F" letter_spacing="${size >= 52 ? 1024 : 512}">${escPango(text)}</span>`, {
    font: `${families} ${size}px`,
    width
  });
  return { fill: chosen!.fill, outline, size };
}

/** Body text clamped to `maxLines` by dropping words (never mid-grapheme), with an ellipsis. */
async function renderClamped(text: string, opts: { size: number; alpha: number; width: number; maxLines: number; weight?: 'semibold' | 'bold' }): Promise<TextLayer | null> {
  let words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const font = `${BODY_FAMILIES} ${opts.weight === 'bold' ? 'Bold' : 'SemiBold'} ${opts.size}px`;
  const maxH = opts.size * 1.4 * opts.maxLines + 6;
  const span = (t: string) => `<span foreground="#FFFFFF" fgalpha="${Math.round(opts.alpha * 100)}%">${escPango(t)}</span>`;
  for (let guard = 0; guard < 80 && words.length; guard += 1) {
    const candidate = words.join(' ') + (guard ? '…' : '');
    const layer = await renderText(span(candidate), { font, width: opts.width });
    if (layer.h <= maxH) return layer;
    words = words.slice(0, Math.max(1, Math.floor(words.length * 0.85)));
    if (words.length === 1) {
      const one = await renderText(span(`${Array.from(words[0]).slice(0, 24).join('')}…`), { font, width: opts.width });
      return one;
    }
  }
  return null;
}

const roundedMask = (w: number, h: number, r: number) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);

const markSvg = (): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">` +
      `<rect x="1" y="1" width="34" height="34" rx="9" fill="#D97757"/>` +
      `<path d="M10 11.5h16a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3h-8.5l-4.5 4v-4H10a3 3 0 0 1-3-3v-6.5a3 3 0 0 1 3-3z" fill="#FDFBF7"/>` +
      `</svg>`
  );

const clampText = (s: string, max: number) => {
  const chars = Array.from(String(s || '').replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
};

// ── Render ───────────────────────────────────────────────────────────────────

/** 1200×630 progressive JPEG ≤ 300 KB (retries at a lower quality when larger). */
export async function renderOgCard(input: OgRenderInput): Promise<{ jpeg: Buffer; w: 1200; h: 630; themeColor: string }> {
  await ensureOgFonts();
  const art = input.coverBuf || input.fallbackPageBuf;
  const themeColor = safeHex(input.themeColor || (await dominantColor(art)));
  const layers: OverlayOptions[] = [];

  // 1. Backdrop.
  let base: Sharp;
  if (art) {
    const backdrop = await sharp(art, { limitInputPixels: 64_000_000 })
      .resize(OG_W, OG_H, { fit: 'cover', position: 'attention' })
      .blur(28)
      .modulate({ brightness: 0.55, saturation: 1.1 })
      .removeAlpha()
      .png()
      .toBuffer();
    base = sharp(backdrop);
  } else {
    base = sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
          `<stop offset="0" stop-color="${escXml(themeColor)}"/><stop offset="1" stop-color="#1a1714"/></linearGradient></defs>` +
          `<rect width="${OG_W}" height="${OG_H}" fill="url(#g)"/></svg>`
      )
    );
  }
  layers.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}"><defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0.35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></linearGradient></defs>` +
        `<rect width="${OG_W}" height="${OG_H}" fill="url(#v)"/></svg>`
    ),
    left: 0,
    top: 0
  });

  // 2. Cover card with a soft shadow.
  let textLeft = 120;
  let textWidth = 960;
  if (art) {
    const card = await sharp(art, { limitInputPixels: 64_000_000 }).resize({ height: 530, width: 440, fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
    const cw = card.info.width;
    const ch = card.info.height;
    const rounded = await sharp(card.data).composite([{ input: roundedMask(cw, ch, 18), blend: 'dest-in' }]).png().toBuffer();
    const top = Math.round((OG_H - ch) / 2) - 6;
    const shadowLayer = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cw + 60}" height="${ch + 60}">` +
          `<rect x="30" y="30" width="${cw}" height="${ch}" rx="18" ry="18" fill="#000" fill-opacity="0.55"/></svg>`
      )
    )
      .blur(14)
      .png()
      .toBuffer();
    layers.push({ input: shadowLayer, left: Math.max(0, 88 - 30), top: Math.max(0, top - 30 + 12) });
    layers.push({ input: rounded, left: 88, top });
    textLeft = 88 + cw + 48;
    textWidth = Math.max(380, 1130 - textLeft);
  }

  // 3. Text column.
  const drawable = scriptsCovered(input.title) ? input.title : input.fallbackTitle && scriptsCovered(input.fallbackTitle) ? input.fallbackTitle : '';
  let y = 92;
  if (drawable) {
    const title = await renderTitle(clampText(drawable, 90), textWidth);
    for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, 2], [-2, 2], [2, -2]] as const) {
      layers.push({ input: title.outline.buf, left: Math.max(0, textLeft + dx), top: Math.max(0, y + dy) });
    }
    layers.push({ input: title.fill.buf, left: textLeft, top: y });
    y += Math.min(title.fill.h, 250) + 22;
  }
  const subtitle = scriptsCovered(input.subtitle) ? input.subtitle : '';
  const desc = subtitle ? await renderClamped(clampText(subtitle, 200), { size: 26, alpha: 0.85, width: textWidth, maxLines: 3 }) : null;
  if (desc && y + desc.h < 540) {
    layers.push({ input: desc.buf, left: textLeft, top: y });
    y += desc.h + 18;
  }
  const pages = `${input.pageCount} ${input.pageCount === 1 ? 'page' : 'pages'}`;
  const meta = [input.kindLabel, pages, input.languagesLabel && scriptsCovered(input.languagesLabel) ? input.languagesLabel : ''].filter(Boolean).join(' · ');
  const metaLayer = await renderClamped(clampText(meta, 90), { size: 20, alpha: 0.72, width: textWidth, maxLines: 1 });
  if (metaLayer && y + metaLayer.h < 560) layers.push({ input: metaLayer.buf, left: textLeft, top: Math.max(y, 470) });

  // 4. Mark.
  const markText = await renderText(`<span foreground="#FFFFFF" fgalpha="90%">DreamStream Studio</span>`, { font: `${BODY_FAMILIES} SemiBold 18px`, width: 300 });
  const markLeft = 1130 - markText.w;
  layers.push({ input: markText.buf, left: Math.max(0, markLeft), top: 574 + Math.round((36 - markText.h) / 2) });
  layers.push({ input: markSvg(), left: Math.max(0, markLeft - 46), top: 574 });

  const composed = await base.composite(layers).png().toBuffer();
  let jpeg = await sharp(composed).jpeg({ quality: 82, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' }).toBuffer();
  if (jpeg.byteLength > OG_MAX_BYTES) jpeg = await sharp(composed).jpeg({ quality: 72, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' }).toBuffer();
  if (jpeg.byteLength > OG_MAX_BYTES) jpeg = await sharp(composed).jpeg({ quality: 60, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' }).toBuffer();
  return { jpeg, w: OG_W, h: OG_H, themeColor };
}
