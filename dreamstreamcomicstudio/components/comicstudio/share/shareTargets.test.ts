// The reader's share targets (share title page §5.0.3): which link a visitor passes on, the LinkedIn intent, and the
// in-app browsers that need the download hint. Pure helpers, no DOM.
import { describe, expect, it } from 'vitest';
import { COMICS_ORIGIN } from '../../../services/productHost';
import { editionLinkFor, inAppBrowser, LINKEDIN_LABEL, linkedinShareUrl, shareLinkFor, withVia } from './shareTargets';

const SLUG = 'Ab3dEf6hIj9kLm2nP';
const BARE = `${COMICS_ORIGIN}/c/${SLUG}`;
const base = { slug: SLUG, defaultLang: 'te', switched: false } as const;

describe('shareLinkFor', () => {
  it('keeps the edition the link came with while the visitor has not switched', () => {
    expect(shareLinkFor({ ...base, linkLang: 'en', currentLang: 'en' })).toBe(`${BARE}?lang=en`);
  });

  it('is the bare link after a switch, even back to the edition the link came with', () => {
    expect(shareLinkFor({ ...base, linkLang: 'en', currentLang: 'hi', switched: true })).toBe(BARE);
    expect(shareLinkFor({ ...base, linkLang: 'en', currentLang: 'en', switched: true })).toBe(BARE);
  });

  it('is the bare link for the default edition and for a link without a language', () => {
    expect(shareLinkFor({ ...base, linkLang: 'te', currentLang: 'te' })).toBe(BARE);
    expect(shareLinkFor({ ...base, linkLang: 'TE', currentLang: 'te' })).toBe(BARE);
    expect(shareLinkFor({ ...base, linkLang: null, currentLang: 'te' })).toBe(BARE);
    expect(shareLinkFor({ ...base, linkLang: undefined, currentLang: 'te' })).toBe(BARE);
  });

  it('never carries via or src, and never a malformed language', () => {
    for (const linkLang of ['en', 'te', null, 'en&via=x', 'en?src=more', '<b>']) {
      const link = shareLinkFor({ ...base, linkLang, currentLang: 'en' })!;
      const url = new URL(link);
      expect(url.origin + url.pathname, String(linkLang)).toBe(BARE);
      expect(url.searchParams.has('via'), String(linkLang)).toBe(false);
      expect(url.searchParams.has('src'), String(linkLang)).toBe(false);
      expect([...url.searchParams.keys()].every((k) => k === 'lang'), String(linkLang)).toBe(true);
    }
  });

  it('gives no link for a slug that is not a share slug', () => {
    expect(shareLinkFor({ ...base, slug: 'short', linkLang: 'en', currentLang: 'en' })).toBeUndefined();
    expect(shareLinkFor({ ...base, slug: '', linkLang: 'en', currentLang: 'en' })).toBeUndefined();
  });
});

describe('editionLinkFor', () => {
  it('offers the edition on screen only after a switch to a non-default edition', () => {
    expect(editionLinkFor({ ...base, linkLang: 'en', currentLang: 'en' })).toBeNull();
    expect(editionLinkFor({ ...base, linkLang: 'en', currentLang: 'te', switched: true })).toBeNull();
    expect(editionLinkFor({ ...base, linkLang: null, currentLang: 'hi', switched: true })).toBe(`${BARE}?lang=hi`);
    expect(editionLinkFor({ ...base, linkLang: 'en', currentLang: 'en', switched: true })).toBe(`${BARE}?lang=en`);
  });

  it('never carries via or src', () => {
    const url = new URL(editionLinkFor({ ...base, linkLang: null, currentLang: 'hi', switched: true })!);
    expect([...url.searchParams.keys()]).toEqual(['lang']);
  });
});

describe('withVia', () => {
  it('sets one channel tag and keeps the language', () => {
    expect(withVia(`${BARE}?lang=en`, 'whatsapp')).toBe(`${BARE}?lang=en&via=whatsapp`);
    expect(withVia(`${BARE}?via=x&src=more`, 'telegram')).toBe(`${BARE}?via=telegram`);
  });
});

describe('linkedinShareUrl', () => {
  it('opens LinkedIn’s share page with the link, tagged via=linkedin, fully encoded', () => {
    const out = linkedinShareUrl(`${BARE}?lang=en`);
    const url = new URL(out);
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/sharing/share-offsite/');
    expect([...url.searchParams.keys()]).toEqual(['url']);
    expect(url.searchParams.get('url')).toBe(`${BARE}?lang=en&via=linkedin`);
    expect(out).toBe(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(`${BARE}?lang=en&via=linkedin`)}`);
    expect(out.split('?')[1]).not.toContain('&lang');
  });

  it('names the row', () => {
    expect(LINKEDIN_LABEL).toBe('LinkedIn');
  });
});

describe('inAppBrowser', () => {
  const ua = {
    linkedin:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.29.8',
    linkedinAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 LinkedInApp',
    fban: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.97;]',
    fbav: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.40.97;]',
    instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.3.12.235',
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  };

  it('is true inside the LinkedIn, Facebook and Instagram apps', () => {
    for (const k of ['linkedin', 'linkedinAndroid', 'fban', 'fbav', 'instagram'] as const) expect(inAppBrowser(ua[k]), k).toBe(true);
  });

  it('is false in Chrome and Safari', () => {
    for (const k of ['chrome', 'chromeAndroid', 'safari', 'safariIos'] as const) expect(inAppBrowser(ua[k]), k).toBe(false);
  });

  it('is false for an empty or missing user agent', () => {
    expect(inAppBrowser('')).toBe(false);
  });
});
