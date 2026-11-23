// What a reader of a share link passes on (share title page §5.0.3). Pure helpers, no React, no network:
//
// - shareLinkFor: the link the reader's Share hands on. The edition the link came with (`?lang=X`, published) is kept
//   while the visitor has not switched: that language came from the link, so nothing about the visitor is passed on.
//   After a switch, and for the default edition, it is the bare link. `via` and `src` are never carried over: the link
//   is rebuilt from the slug, never copied from the address bar.
// - editionLinkFor: the explicit "Copy link to the {language} edition" row, offered only after a switch to a
//   non-default edition (the visitor chooses to pass their pick on).
// - linkedinShareUrl: LinkedIn's share page for the link, tagged `via=linkedin` for the owner’s channel report.
// - inAppBrowser: the LinkedIn, Facebook and Instagram in-app browsers (and the others shareModel knows), where downloads
//   often fail and the reader shows the "open it in your browser" hint instead.

import { sameLanguage } from '../../../shared/comic/languages';
import { buildShareUrl, SLUG_RE } from '../../../shared/comic/publication';
import { COMICS_ORIGIN } from '../../../services/productHost';
import { isInAppBrowser, type IntentChannel } from './shareModel';

export interface ShareLinkInput {
  slug: string;
  /** The published edition the link opened in (pickShareLanguage of its `?lang=`); none for a bare link. */
  linkLang?: string | null;
  /** The edition on screen now. */
  currentLang: string;
  /** The publication's default edition (a bare link opens it). */
  defaultLang?: string | null;
  /** Whether the visitor has switched editions on this page. */
  switched: boolean;
  /** The comics host by default. */
  origin?: string;
}

const linkTo = (input: ShareLinkInput, lang?: string | null): string | undefined => {
  if (!input.slug || !SLUG_RE.test(input.slug)) return undefined;
  const origin = input.origin || COMICS_ORIGIN;
  const keep = lang && !sameLanguage(lang, input.defaultLang || undefined) ? lang : undefined;
  return buildShareUrl(origin, input.slug, keep ? { lang: keep } : {});
};

/**
 * The link the reader's Share passes on: the link's own edition until the visitor switches, else the bare link.
 * The reader's rule; the studio owner's link (its page, language and `via` options) is shareModel's `shareLinkFor`.
 */
export function shareLinkFor(input: ShareLinkInput): string | undefined {
  return linkTo(input, input.switched ? null : input.linkLang);
}

/** The link to the edition on screen, offered only after a switch to an edition other than the default. */
export function editionLinkFor(input: ShareLinkInput): string | null {
  if (!input.switched || !input.currentLang || sameLanguage(input.currentLang, input.defaultLang || undefined)) return null;
  const link = linkTo(input, input.currentLang);
  return link && link !== linkTo(input, null) ? link : null;
}

/** The channels a reader's link can be tagged with: the intents, and LinkedIn. */
export type ViaTag = IntentChannel | 'linkedin';

/** The link with one channel tag (`via`), any copied `via` / `src` removed; the language stays. */
export function withVia(link: string, via: ViaTag): string {
  try {
    const url = new URL(link);
    url.searchParams.delete('via');
    url.searchParams.delete('src');
    url.searchParams.set('via', via);
    return url.toString();
  } catch {
    return `${link}${link.includes('?') ? '&' : '?'}via=${encodeURIComponent(via)}`;
  }
}

export const LINKEDIN_LABEL = 'LinkedIn';
const LINKEDIN_SHARE = 'https://www.linkedin.com/sharing/share-offsite/';

/** LinkedIn's share page for a link (the link tagged `via=linkedin`, URI-encoded as its one parameter). */
export const linkedinShareUrl = (link: string): string => `${LINKEDIN_SHARE}?url=${encodeURIComponent(withVia(link, 'linkedin'))}`;

const LINKEDIN_APP = /LinkedInApp/i;

/**
 * An in-app browser (LinkedIn, Facebook, Instagram, and the others shareModel lists): downloads often fail there.
 * shareModel's `isInAppBrowser` (and so `useShareCapabilities().inApp`) does not know LinkedIn yet: use this one.
 */
export const inAppBrowser = (ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent || ''): boolean =>
  !!ua && (LINKEDIN_APP.test(ua) || isInAppBrowser(ua));
