/**
 * Comic Studio <head> branding for the shared SPA's index.html, applied at the edge with
 * HTMLRewriter (streamed, no buffering). The apex keeps its suite head; on the comics host the
 * same document becomes "Comic Studio — DreamStream" with its own manifest, icons and link
 * preview. Every value is a constant (nothing from the request is reflected into the HTML).
 *
 * Two pages have a head of their own: the Library (`/?view=gallery`, where `/library` redirects)
 * and everything else (the home head). Each names its own canonical URL and preview image.
 */
import { isLibraryView, type EdgeConfig } from './policy';

/** The slice of the Workers HTMLRewriter API the branding uses (typed locally so this file
 *  typechecks with or without @cloudflare/workers-types). */
export interface RewriterElement {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): unknown;
  setInnerContent(content: string, options?: { html?: boolean }): unknown;
  append(content: string, options?: { html?: boolean }): unknown;
  remove(): unknown;
}

export interface Rewriter {
  on(selector: string, handlers: { element(element: RewriterElement): void }): Rewriter;
  transform(response: Response): Response;
}

export type RewriterCtor = new () => Rewriter;

export const BRAND = {
  title: 'Comic Studio — DreamStream',
  description:
    'Make comics with an AI director: plan every page, keep your cast consistent, letter each balloon, then read and share them anywhere.',
  siteName: 'DreamStream Comic Studio',
  appName: 'DreamStream Comics',
  shortName: 'Comics',
  manifest: '/comics.webmanifest',
  favicon: '/icons/comics-mark.svg',
  appleTouchIcon: '/icons/comics-apple-touch-180.png',
  ogImage: '/icons/comics-og.png',
  ogImageWidth: '1200',
  ogImageHeight: '630',
  ogImageAlt: 'DreamStream Comic Studio: a comic cover and two comic pages beside the Comic Studio mark, in black ink on white',
  // The browser chrome around the comics host's pages: the Atlas skin's paper and dark paper (index.css
  // [data-ds-skin="atlas"] --ds-canvas), so the address bar meets a white page, not the old warm paper.
  themeLight: '#ffffff',
  themeDark: '#0a0a0a'
} as const;

/**
 * Preview images carry a short content hash as `?v=`, so a link-preview service that caches by
 * image URL (LinkedIn keeps one for days) fetches the new picture the first time the page is
 * scraped again. The test in index.test.ts recomputes the hash from public/icons, so a
 * regenerated image without a new value here fails the build (scripts/og-cards.mjs prints it).
 */
export const OG_IMAGE_REV = { home: '008c4b96d3', library: 'a03df95e3e' } as const;

/** What one page's link preview says. Paths are on the public host; values are constants. */
export interface PageHead {
  title: string;
  description: string;
  /** Canonical path (+ query) on the public host: also og:url. */
  canonicalPath: string;
  /** Preview image path (+ cache-busting query) on the public host, 1200×630. */
  ogImage: string;
  ogImageAlt: string;
}

/** The comics host's own head: the landing and every SPA path without a head of its own. */
export const HOME_HEAD: PageHead = {
  title: BRAND.title,
  description: BRAND.description,
  canonicalPath: '/',
  ogImage: `${BRAND.ogImage}?v=${OG_IMAGE_REV.home}`,
  ogImageAlt: BRAND.ogImageAlt
};

/** The Library (`/?view=gallery`; `/library` redirects there): its own title, text, URL and picture. */
export const LIBRARY_HEAD: PageHead = {
  title: 'Library · Comic Studio',
  description: 'Read comics made with DreamStream Comic Studio, right in your browser.',
  canonicalPath: '/?view=gallery',
  ogImage: `/icons/comics-library-og.png?v=${OG_IMAGE_REV.library}`,
  ogImageAlt: 'The Comic Studio Library: a shelf of comic pages, each drawn in a different style, in black ink on white'
};

/** The head for a request: the Library's on the Library view, the home head everywhere else. */
export const headFor = (url: URL): PageHead => (isLibraryView(url) ? LIBRARY_HEAD : HOME_HEAD);

const escAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

/** The tags appended to <head> (after the stale ones are removed). */
export const brandHeadTags = (cfg: EdgeConfig, head: PageHead = HOME_HEAD): string => {
  const origin = `https://${cfg.publicHost}`;
  const url = `${origin}${head.canonicalPath}`;
  const image = `${origin}${head.ogImage}`;
  const meta = (attr: 'name' | 'property', key: string, content: string) =>
    `<meta ${attr}="${escAttr(key)}" content="${escAttr(content)}">`;
  return [
    meta('name', 'ds-product', 'comics'),
    meta('name', 'application-name', BRAND.appName),
    meta('name', 'apple-mobile-web-app-title', BRAND.shortName),
    `<link rel="canonical" href="${escAttr(url)}">`,
    `<link rel="icon" type="image/svg+xml" href="${BRAND.favicon}">`,
    meta('property', 'og:site_name', BRAND.siteName),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:title', head.title),
    meta('property', 'og:description', head.description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', image),
    meta('property', 'og:image:width', BRAND.ogImageWidth),
    meta('property', 'og:image:height', BRAND.ogImageHeight),
    meta('property', 'og:image:alt', head.ogImageAlt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', head.title),
    meta('name', 'twitter:description', head.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', head.ogImageAlt)
  ].join('');
};

/** Tags the suite head may carry that Comic Studio replaces (removed, then re-added by brandHeadTags). */
const REPLACED_SELECTORS = [
  'meta[property^="og:"]',
  'meta[name^="twitter:"]',
  'link[rel="canonical"]',
  'link[rel="icon"]',
  'meta[name="ds-product"]',
  'meta[name="application-name"]',
  'meta[name="apple-mobile-web-app-title"]'
];

/** Registers the Comic Studio branding (one page's head) on a rewriter and returns it. */
export const registerBranding = (rewriter: Rewriter, cfg: EdgeConfig, head: PageHead = HOME_HEAD): Rewriter => {
  const remove = { element: (el: RewriterElement) => void el.remove() };
  let r = rewriter
    .on('title', { element: (el) => void el.setInnerContent(head.title) })
    .on('meta[name="description"]', { element: (el) => void el.setAttribute('content', head.description) })
    .on('meta[name="theme-color"]', {
      element: (el) => void el.setAttribute('content', /dark/i.test(el.getAttribute('media') || '') ? BRAND.themeDark : BRAND.themeLight)
    })
    .on('link[rel="manifest"]', { element: (el) => void el.setAttribute('href', BRAND.manifest) })
    .on('link[rel="apple-touch-icon"]', { element: (el) => void el.setAttribute('href', BRAND.appleTouchIcon) });
  for (const selector of REPLACED_SELECTORS) r = r.on(selector, remove);
  return r.on('head', { element: (el) => void el.append(brandHeadTags(cfg, head), { html: true }) });
};

/** Brands an HTML response with one page's head (the caller decides whether it should be branded). */
export const brandHtml = (response: Response, cfg: EdgeConfig, Ctor: RewriterCtor, head: PageHead = HOME_HEAD): Response =>
  registerBranding(new Ctor(), cfg, head).transform(response);
