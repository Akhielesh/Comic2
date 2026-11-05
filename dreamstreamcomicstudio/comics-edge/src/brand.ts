/**
 * Comic Studio <head> branding for the shared SPA's index.html, applied at the edge with
 * HTMLRewriter (streamed, no buffering). The apex keeps its suite head; on the comics host the
 * same document becomes "Comic Studio — DreamStream" with its own manifest, icons and link
 * preview. Every value is a constant (nothing from the request is reflected into the HTML).
 */
import type { EdgeConfig } from './policy';

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
  appleTouchIcon: '/icons/comics-apple-touch-180.png',
  ogImage: '/icons/comics-og.png',
  ogImageWidth: '1200',
  ogImageHeight: '630',
  ogImageAlt: 'DreamStream Comic Studio: comic pages with speech balloons on warm paper',
  themeLight: '#FAF9F5',
  themeDark: '#262624'
} as const;

const escAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

/** The tags appended to <head> (after the stale ones are removed). */
export const brandHeadTags = (cfg: EdgeConfig): string => {
  const origin = `https://${cfg.publicHost}`;
  const url = `${origin}/`;
  const image = `${origin}${BRAND.ogImage}`;
  const meta = (attr: 'name' | 'property', key: string, content: string) =>
    `<meta ${attr}="${escAttr(key)}" content="${escAttr(content)}">`;
  return [
    meta('name', 'ds-product', 'comics'),
    meta('name', 'application-name', BRAND.appName),
    meta('name', 'apple-mobile-web-app-title', BRAND.shortName),
    `<link rel="canonical" href="${escAttr(url)}">`,
    meta('property', 'og:site_name', BRAND.siteName),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:title', BRAND.title),
    meta('property', 'og:description', BRAND.description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', image),
    meta('property', 'og:image:width', BRAND.ogImageWidth),
    meta('property', 'og:image:height', BRAND.ogImageHeight),
    meta('property', 'og:image:alt', BRAND.ogImageAlt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', BRAND.title),
    meta('name', 'twitter:description', BRAND.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', BRAND.ogImageAlt)
  ].join('');
};

/** Tags the suite head may carry that Comic Studio replaces (removed, then re-added by brandHeadTags). */
const REPLACED_SELECTORS = [
  'meta[property^="og:"]',
  'meta[name^="twitter:"]',
  'link[rel="canonical"]',
  'meta[name="ds-product"]',
  'meta[name="application-name"]',
  'meta[name="apple-mobile-web-app-title"]'
];

/** Registers the Comic Studio branding on a rewriter and returns it. */
export const registerBranding = (rewriter: Rewriter, cfg: EdgeConfig): Rewriter => {
  const remove = { element: (el: RewriterElement) => void el.remove() };
  let r = rewriter
    .on('title', { element: (el) => void el.setInnerContent(BRAND.title) })
    .on('meta[name="description"]', { element: (el) => void el.setAttribute('content', BRAND.description) })
    .on('meta[name="theme-color"]', {
      element: (el) => void el.setAttribute('content', /dark/i.test(el.getAttribute('media') || '') ? BRAND.themeDark : BRAND.themeLight)
    })
    .on('link[rel="manifest"]', { element: (el) => void el.setAttribute('href', BRAND.manifest) })
    .on('link[rel="apple-touch-icon"]', { element: (el) => void el.setAttribute('href', BRAND.appleTouchIcon) });
  for (const selector of REPLACED_SELECTORS) r = r.on(selector, remove);
  return r.on('head', { element: (el) => void el.append(brandHeadTags(cfg), { html: true }) });
};

/** Brands an HTML response (the caller decides whether this response should be branded). */
export const brandHtml = (response: Response, cfg: EdgeConfig, Ctor: RewriterCtor): Response =>
  registerBranding(new Ctor(), cfg).transform(response);
