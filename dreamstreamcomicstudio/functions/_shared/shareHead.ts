/**
 * The <head> a shared comic link serves (sharing.md §5.3). PURE: no I/O, unit-tested under Node.
 *
 * Every client (people, preview bots, search engines) gets the SAME document: the SPA's
 * index.html with the comic's Open Graph / Twitter / canonical / robots / oEmbed tags and an
 * inline JSON boot card (so the reader paints the cover before the API answers). No UA
 * sniffing, so no cloaking and every preview bot works.
 *
 * Injection-proof by construction: every user string (title, description, creator, alt text)
 * goes through escAttr/escText, every JSON block through jsonForScript (`<`, `>`, `&`, U+2028/9
 * escaped, so `</script>` can never close the block), and URLs are rebuilt from the validated
 * slug/asset key — never echoed from the request. The data itself comes from the anon RPC
 * `comic_share_card` and is shape-validated here (validateShareCardRpc) before use.
 */
import type { AspectRatio } from '../../shared/comic/doc';
import { SLUG_RE, type ShareCard } from '../../shared/comic/publication';
import { comicShareUrl } from '../../services/productHost';

export const SITE_NAME = 'DreamStream Studio';
export const DEFAULT_TITLE = 'DreamStream Studio — Comics, AI Chat & Code';
const DEFAULT_THEME = '#3B82F6';

// ── Escaping ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/** Attribute-context escape (`& < > " '`), control/bidi-override characters removed. */
export const escAttr = (value: unknown): string =>
  String(value ?? '')
    .replace(CONTROL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Text-context escape (<title>): the same set, so it is safe in either context. */
export const escText = escAttr;

/** JSON safe inside <script type="application/json|ld+json">: no `</script>`, no `<!--`, no line separators. */
export const jsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/** Collapse whitespace, strip control characters, clamp to `max` code points. */
export const clampText = (value: unknown, max: number): string => {
  const chars = Array.from(String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
};

// ── RPC shape validation (defense in depth: the edge never trusts stored JSON blindly) ──

export interface ShareCardRpc {
  slug: string;
  visibility: 'unlisted' | 'public';
  languages: string[];
  defaultLang?: string;
  startPage?: number | null;
  allowDownload: boolean;
  allowEmbed: boolean;
  assetKey: string;
  card: ShareCard;
  publishedAt?: number;
  updatedAt?: number;
}

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const ASSET_KEY = /^[A-Za-z0-9]{22}$/;
const OG_PATH = /^pub\/([A-Za-z0-9]{22})\/og-[a-z0-9]{2,12}-[0-9a-f]{12}\.jpg$/;
const ASPECTS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '9:21']);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const httpsUrl = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || v.length > 600) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** The RPC answer, shape-checked and normalized; null = treat as not found. */
export function validateShareCardRpc(raw: unknown): ShareCardRpc | null {
  if (!isRecord(raw)) return null;
  const { slug, visibility, assetKey } = raw;
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  if (visibility !== 'unlisted' && visibility !== 'public') return null;
  if (typeof assetKey !== 'string' || !ASSET_KEY.test(assetKey)) return null;
  const languages = Array.isArray(raw.languages) ? raw.languages.filter((l): l is string => typeof l === 'string' && LANG_RE.test(l)).slice(0, 12) : [];
  if (!languages.length) return null;
  const c = raw.card;
  if (!isRecord(c) || c.v !== 1) return null;
  const og: ShareCard['og'] = {};
  if (isRecord(c.og)) {
    for (const [lang, entry] of Object.entries(c.og)) {
      if (!LANG_RE.test(lang) || !isRecord(entry) || typeof entry.path !== 'string') continue;
      const m = OG_PATH.exec(entry.path);
      if (!m || m[1] !== assetKey) continue; // an OG image must live under THIS publication's key
      og[lang] = { path: entry.path, w: 1200, h: 630, alt: clampText(entry.alt, 200) };
    }
  }
  const i18n: ShareCard['i18n'] = {};
  if (isRecord(c.i18n)) {
    for (const [lang, t] of Object.entries(c.i18n)) {
      if (!LANG_RE.test(lang) || !isRecord(t)) continue;
      i18n[lang] = { title: clampText(t.title, 90), description: clampText(t.description, 200) };
    }
  }
  const pageCount = typeof c.pageCount === 'number' && Number.isFinite(c.pageCount) ? Math.max(0, Math.min(500, Math.floor(c.pageCount))) : 0;
  const card: ShareCard = {
    v: 1,
    title: clampText(c.title, 90) || 'Untitled comic',
    description: clampText(c.description, 200),
    kindLabel: clampText(c.kindLabel, 40) || 'Comic',
    pageCount,
    aspect: (typeof c.aspect === 'string' && ASPECTS.has(c.aspect) ? c.aspect : '2:3') as AspectRatio,
    og,
    i18n
  };
  const coverUrl = httpsUrl(c.coverUrl);
  if (coverUrl) card.coverUrl = coverUrl;
  if (typeof c.creator === 'string' && c.creator.trim()) card.creator = clampText(c.creator, 40);
  if (typeof c.themeColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.themeColor)) card.themeColor = c.themeColor;
  const defaultLang = typeof raw.defaultLang === 'string' && languages.includes(raw.defaultLang) ? raw.defaultLang : languages[0];
  const startPage = typeof raw.startPage === 'number' && Number.isInteger(raw.startPage) && raw.startPage >= 1 && raw.startPage <= 500 ? raw.startPage : null;
  return {
    slug,
    visibility,
    languages,
    defaultLang,
    startPage,
    allowDownload: raw.allowDownload !== false,
    allowEmbed: raw.allowEmbed !== false,
    assetKey,
    card,
    ...(typeof raw.publishedAt === 'number' ? { publishedAt: raw.publishedAt } : {}),
    ...(typeof raw.updatedAt === 'number' ? { updatedAt: raw.updatedAt } : {})
  };
}

// ── Head ─────────────────────────────────────────────────────────────────────

const LOCALES: Record<string, string> = {
  en: 'en_US', hi: 'hi_IN', te: 'te_IN', ta: 'ta_IN', kn: 'kn_IN', ml: 'ml_IN', mr: 'mr_IN', bn: 'bn_IN', gu: 'gu_IN', pa: 'pa_IN',
  ur: 'ur_PK', es: 'es_ES', fr: 'fr_FR', pt: 'pt_BR', de: 'de_DE', id: 'id_ID', ja: 'ja_JP', ko: 'ko_KR', 'zh-Hans': 'zh_CN', ar: 'ar_AR'
};
export const ogLocale = (lang: string): string => LOCALES[lang] || lang.replace(/-/g, '_');

const ENDONYMS: Record<string, string> = {
  en: 'English', hi: 'हिन्दी', te: 'తెలుగు', ta: 'தமிழ்', kn: 'ಕನ್ನಡ', ml: 'മലയാളം', mr: 'मराठी', bn: 'বাংলা', gu: 'ગુજરાતી', pa: 'ਪੰਜਾਬੀ',
  ur: 'اردو', es: 'Español', fr: 'Français', pt: 'Português', de: 'Deutsch', id: 'Bahasa Indonesia', ja: '日本語', ko: '한국어', 'zh-Hans': '中文（简体）', ar: 'العربية'
};

export interface ShareHeadContext {
  /** Origin that serves this page and its /og/ images (the request's own origin). */
  origin: string;
  /** Requested language (already allow-listed by parseShareParams); used only if published. */
  lang?: string;
  page?: number;
  embed?: boolean;
}

/** The language this view renders in: the requested one if published, else the default. */
export const pickLang = (rpc: ShareCardRpc, wanted?: string): string =>
  wanted && rpc.languages.includes(wanted) ? wanted : rpc.defaultLang && rpc.languages.includes(rpc.defaultLang) ? rpc.defaultLang : rpc.languages[0];

/** Canonical link (comics host), with ?lang only for a non-default edition. */
export const canonicalUrl = (rpc: ShareCardRpc, lang: string): string => {
  const base = comicShareUrl(rpc.slug);
  return lang && lang !== (rpc.defaultLang || rpc.languages[0]) ? `${base}?lang=${encodeURIComponent(lang)}` : base;
};

/** Same-origin OG image URL for a language (falls back to the default edition's image, then the cover). */
export const ogImageUrl = (rpc: ShareCardRpc, lang: string, origin: string): { url: string; type: string; w?: number; h?: number; alt: string } | null => {
  const entry = rpc.card.og[lang] || rpc.card.og[rpc.defaultLang || ''] || Object.values(rpc.card.og)[0];
  if (entry) return { url: `${origin.replace(/\/+$/, '')}/og/${entry.path.slice('pub/'.length)}`, type: 'image/jpeg', w: 1200, h: 630, alt: entry.alt };
  if (rpc.card.coverUrl) return { url: rpc.card.coverUrl, type: 'image/webp', alt: `Cover of ${rpc.card.title}` };
  return null;
};

/** Head tags for a live share link (every value escaped). */
export function renderShareHead(rpc: ShareCardRpc, ctx: ShareHeadContext): string {
  const lang = pickLang(rpc, ctx.lang);
  const text = rpc.card.i18n[lang] || { title: rpc.card.title, description: rpc.card.description };
  const title = clampText(text.title || rpc.card.title, 90) || 'Untitled comic';
  const description = clampText(text.description || rpc.card.description, 200);
  const canonical = canonicalUrl(rpc, lang);
  const image = ogImageUrl(rpc, lang, ctx.origin);
  const isPublic = rpc.visibility === 'public';
  const pages = rpc.card.pageCount;
  const languageNames = rpc.languages.map((l) => ENDONYMS[l] || l).join(', ');
  const out: string[] = [];
  const meta = (attr: 'name' | 'property', key: string, value: string) => out.push(`<meta ${attr}="${key}" content="${escAttr(value)}">`);

  out.push(`<title>${escText(`${title} · ${SITE_NAME}`)}</title>`);
  meta('name', 'description', description);
  out.push(`<link rel="canonical" href="${escAttr(canonical)}">`);
  if (!isPublic || ctx.embed) meta('name', 'robots', 'noindex, nofollow');
  meta('property', 'og:type', 'article');
  meta('property', 'og:site_name', SITE_NAME);
  meta('property', 'og:title', title);
  meta('property', 'og:description', description);
  meta('property', 'og:url', canonical);
  meta('property', 'og:locale', ogLocale(lang));
  for (const other of rpc.languages) if (other !== lang) meta('property', 'og:locale:alternate', ogLocale(other));
  if (image) {
    meta('property', 'og:image', image.url);
    meta('property', 'og:image:secure_url', image.url);
    meta('property', 'og:image:type', image.type);
    if (image.w && image.h) {
      meta('property', 'og:image:width', String(image.w));
      meta('property', 'og:image:height', String(image.h));
    }
    meta('property', 'og:image:alt', image.alt);
  }
  meta('name', 'twitter:card', image?.w ? 'summary_large_image' : 'summary');
  meta('name', 'twitter:title', title);
  meta('name', 'twitter:description', description);
  if (image) {
    meta('name', 'twitter:image', image.url);
    meta('name', 'twitter:image:alt', image.alt);
  }
  meta('name', 'twitter:label1', 'Pages');
  meta('name', 'twitter:data1', String(pages));
  meta('name', 'twitter:label2', 'Language');
  meta('name', 'twitter:data2', languageNames);
  meta('name', 'theme-color', rpc.card.themeColor || DEFAULT_THEME);
  if (isPublic) {
    for (const l of rpc.languages) out.push(`<link rel="alternate" hreflang="${escAttr(l)}" href="${escAttr(canonicalUrl(rpc, l))}">`);
  }
  out.push(
    `<link rel="alternate" type="application/json+oembed" href="${escAttr(`${ctx.origin.replace(/\/+$/, '')}/api/comic/oembed?url=${encodeURIComponent(comicShareUrl(rpc.slug))}&format=json`)}" title="${escAttr(title)}">`
  );
  if (rpc.card.coverUrl) out.push(`<link rel="preload" as="image" href="${escAttr(rpc.card.coverUrl)}" fetchpriority="high">`);
  const boot = {
    slug: rpc.slug,
    lang,
    ...(typeof ctx.page === 'number' ? { page: ctx.page } : rpc.startPage ? { page: rpc.startPage } : {}),
    ...(ctx.embed ? { embed: true } : {}),
    visibility: rpc.visibility,
    languages: rpc.languages,
    allowDownload: rpc.allowDownload,
    card: {
      title,
      description,
      ...(rpc.card.coverUrl ? { coverUrl: rpc.card.coverUrl } : {}),
      aspect: rpc.card.aspect,
      pageCount: pages,
      kindLabel: rpc.card.kindLabel,
      ...(rpc.card.themeColor ? { themeColor: rpc.card.themeColor } : {}),
      ...(rpc.card.creator ? { creator: rpc.card.creator } : {})
    }
  };
  out.push(`<script type="application/json" id="ds-share-boot">${jsonForScript(boot)}</script>`);
  if (isPublic && !ctx.embed) {
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'ComicStory',
      name: title,
      description,
      ...(image ? { image: image.url } : {}),
      url: canonical,
      inLanguage: rpc.languages,
      numberOfPages: pages,
      ...(rpc.card.creator ? { author: { '@type': 'Person', name: rpc.card.creator } } : {}),
      publisher: { '@type': 'Organization', name: SITE_NAME }
    };
    out.push(`<script type="application/ld+json">${jsonForScript(ld)}</script>`);
  }
  return out.join('\n');
}

/** Generic head for unknown / revoked / unpublished / suspended / malformed links: no comic data, noindex. */
export function notFoundHead(): string {
  return [`<title>${escText(`Link not active · ${SITE_NAME}`)}</title>`, '<meta name="robots" content="noindex, nofollow">', '<script type="application/json" id="ds-share-boot">{"notFound":true}</script>'].join('\n');
}

/**
 * Put `head` into the SPA shell: replaces the static <title>, drops the static description and
 * theme-color (the share head brings its own), and inserts at the `<!--ds:head-->` marker
 * (else before </head>). Tolerant of a shell without either marker.
 */
export function injectHead(html: string, head: string): string {
  let out = html.replace(/<title>[\s\S]*?<\/title>/i, '');
  out = out.replace(/<meta\s+name="description"[^>]*>/gi, '').replace(/<meta\s+name="theme-color"[^>]*>/gi, '');
  // A replacer FUNCTION: a string replacement would expand `$&`, `` $` `` and `$'` patterns that a
  // title could contain into slices of the page itself.
  if (out.includes('<!--ds:head-->')) return out.replace('<!--ds:head-->', () => head);
  const i = out.search(/<\/head>/i);
  return i >= 0 ? `${out.slice(0, i)}${head}\n${out.slice(i)}` : `${head}\n${out}`;
}
