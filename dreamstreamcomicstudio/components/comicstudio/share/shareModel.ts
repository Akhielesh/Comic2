// Share sheet model (sharing.md §7.3): pure helpers for links, channel intents, the embed
// snippet, status copy and in-app-browser detection. No React, no network.

import type { AspectRatio, ComicDoc } from '../../../shared/comic/doc';
import { buildShareUrl, type PublicationOwnerView, type ShareChannel, type ShareLinkOptions } from '../../../shared/comic/publication';
import { COMICS_ORIGIN } from '../../../services/productHost';

export type IntentChannel = Extract<ShareChannel, 'whatsapp' | 'x' | 'telegram' | 'email' | 'facebook'>;
export const INTENT_CHANNELS: readonly IntentChannel[] = ['whatsapp', 'x', 'telegram', 'facebook', 'email'];
export const CHANNEL_LABEL: Record<ShareChannel, string> = {
  copy: 'Copy link',
  native: 'Share…',
  qr: 'QR code',
  whatsapp: 'WhatsApp',
  x: 'X',
  facebook: 'Facebook',
  telegram: 'Telegram',
  email: 'Email',
  embed: 'Embed',
  direct: 'Direct'
};

/** The canonical read-only link (comics host), with optional language/page/channel params. */
export function shareLinkFor(
  view: Pick<PublicationOwnerView, 'slug' | 'defaultLang' | 'startPage'> | null | undefined,
  opts: ShareLinkOptions = {}
): string | null {
  if (!view?.slug) return null;
  return buildShareUrl(COMICS_ORIGIN, view.slug, opts, { defaultLang: view.defaultLang, startPage: view.startPage ?? null });
}

/** Channel intent URL (every part URI-encoded). */
export function intentUrl(channel: IntentChannel, url: string, title: string): string {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title);
  switch (channel) {
    case 'whatsapp':
      return `https://wa.me/?text=${encodeURIComponent(`${title} — ${url}`)}`;
    case 'x':
      return `https://twitter.com/intent/tweet?url=${u}&text=${t}`;
    case 'telegram':
      return `https://t.me/share/url?url=${u}&text=${t}`;
    case 'facebook':
      return `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    case 'email':
      return `mailto:?subject=${t}&body=${encodeURIComponent(`${title}\n${url}`)}`;
  }
}

/** HTML attribute escape for the embed snippet. */
export const escAttr = (s: string): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** `<iframe>` embed snippet for the /embed route (escaped title; aspect from the page shape). */
export function embedSnippet(url: string, title: string, aspect: AspectRatio | string = '2:3'): string {
  const [w, h] = String(aspect).split(':').map(Number);
  const ratio = w > 0 && h > 0 ? `${w}/${h}` : '2/3';
  const src = `${url.split('?')[0].replace(/\/+$/, '')}/embed`;
  return `<iframe src="${escAttr(src)}" title="${escAttr(title)}" loading="lazy" allow="fullscreen" style="width:100%;max-width:560px;aspect-ratio:${ratio};border:0;border-radius:12px"></iframe>`;
}

/** "Private" / "Published · Unlisted" / "Published · Public" / "Paused". */
export function statusLine(view: PublicationOwnerView | null | undefined): { label: string; tone: 'muted' | 'public' | 'unlisted' | 'warn' } {
  if (!view || view.visibility === 'private' || !view.slug) return { label: 'Private — only you can see it', tone: 'muted' };
  if (view.status === 'suspended') return { label: 'Paused by review — readers see “This link isn’t active”', tone: 'warn' };
  return view.visibility === 'public' ? { label: 'Published · Public gallery', tone: 'public' } : { label: 'Published · Anyone with the link', tone: 'unlisted' };
}

/** "abcdefgh…wxyz" for narrow screens (the full value stays selectable in the input). */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(4, max - 1);
  const head = Math.ceil(keep * 0.6);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/** Instagram / Facebook / TikTok / LINE WebViews often lack navigator.share. */
export const isInAppBrowser = (ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean => /FBAN|FBAV|Instagram|Line\/|TikTok|musical_ly|Snapchat/i.test(ua);

/** A safe download / share file name from a title. */
export function fileNameFor(title: string, ext: string): string {
  const base = String(title || 'comic')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${base || 'comic'}.${ext.replace(/[^a-z0-9]/gi, '')}`;
}

/** Title shown in the sheet and the publish card. */
export const comicTitle = (doc: ComicDoc | null | undefined): string => (doc?.brief?.title || doc?.cover?.title || 'Untitled comic').trim() || 'Untitled comic';

/** Page ids for 1-based page numbers (safety blockers come back as numbers). */
export const pageIdsFor = (doc: ComicDoc | null | undefined, numbers: number[]): string[] =>
  (doc?.pages || []).filter((p) => numbers.includes(p.n)).map((p) => p.id);

/** Compact number for stats ("1.2k"). */
export const compactCount = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.max(0, Math.round(n))));
