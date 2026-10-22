// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildAuthLink,
  buildLinkOriginAllowlist,
  linksToLiveApp,
  maskEmail,
  parseAfter,
  parseApp,
  pickLinkOrigin
} from './authEmailLinks.js';

const APP = 'https://dreamstreamstudio.ai';

describe('link origin allowlist', () => {
  const allow = buildLinkOriginAllowlist(`${APP}/`, ['http://localhost:3000', ' http://localhost:7000/ ', 'https://*.dreamstreamstudio.ai', 'ftp://x.test', 'nope']);

  it('is APP_PUBLIC_URL’s origin first, then exact extra origins; wildcards and junk are dropped', () => {
    expect(allow).toEqual([APP, 'http://localhost:3000', 'http://localhost:7000']);
    expect(buildLinkOriginAllowlist('https://DreamStreamStudio.ai/some/path')).toEqual([APP]);
  });

  it('uses the request Origin only on an exact match', () => {
    expect(pickLinkOrigin('http://localhost:3000', allow)).toBe('http://localhost:3000');
    expect(pickLinkOrigin(APP, allow)).toBe(APP);
  });

  it('ignores hostile or near-miss origins and falls back to APP_PUBLIC_URL', () => {
    for (const hostile of [
      'https://3000-abc-token.dreamstreamstudio.ai', // user-controlled Studio preview host
      'https://evil.dreamstreamstudio.ai',
      'https://dreamstreamstudio.ai.evil.com',
      'http://dreamstreamstudio.ai',
      'https://dreamstreamstudio.ai:8443',
      'https://comic2.pages.dev',
      'http://localhost:3001',
      'null',
      ''
    ]) {
      expect(pickLinkOrigin(hostile, allow)).toBe(APP);
    }
    expect(pickLinkOrigin(undefined, allow)).toBe(APP);
    expect(pickLinkOrigin(null, allow)).toBe(APP);
  });

  it('defaults to the configured allowlist (APP_PUBLIC_URL)', () => {
    expect(pickLinkOrigin('https://evil.example')).toMatch(/^https?:\/\/[^/]+$/);
    expect(pickLinkOrigin('https://evil.example')).not.toBe('https://evil.example');
  });
});

describe('buildAuthLink', () => {
  it('sends main-app links to /auth/callback with the hashed token and the real type', () => {
    expect(buildAuthLink({ app: 'main', origin: APP, hashedToken: 'abc', verificationType: 'signup' })).toBe(
      `${APP}/auth/callback?token_hash=abc&type=signup`
    );
    expect(buildAuthLink({ app: 'main', origin: `${APP}/`, hashedToken: 'h+/=', verificationType: 'magiclink' })).toBe(
      `${APP}/auth/callback?token_hash=h%2B%2F%3D&type=magiclink`
    );
  });

  it('sends live sign-up confirmations back into the live app, keeping only known screens', () => {
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'signup', after: 'monitor' })).toBe(
      `${APP}/live?after=monitor&token_hash=h&type=signup`
    );
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'signup', after: 'studio' })).toBe(
      `${APP}/live?token_hash=h&type=signup`
    );
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'signup' })).toBe(
      `${APP}/live?token_hash=h&type=signup`
    );
  });

  it('always lands recovery / magic links on the main app (where the reset screen lives)', () => {
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'recovery', after: 'monitor' })).toBe(
      `${APP}/auth/callback?token_hash=h&type=recovery`
    );
  });

  it('refuses unknown verification types and empty tokens', () => {
    expect(() => buildAuthLink({ app: 'main', origin: APP, hashedToken: 'h', verificationType: 'email_change_new' })).toThrow();
    expect(() => buildAuthLink({ app: 'main', origin: APP, hashedToken: 'h', verificationType: '' })).toThrow();
    expect(() => buildAuthLink({ app: 'main', origin: APP, hashedToken: '', verificationType: 'signup' })).toThrow();
  });
});

describe('small parsers', () => {
  it('parse app / after / live branding', () => {
    expect(parseApp('live')).toBe('live');
    expect(parseApp('studio')).toBe('main');
    expect(parseApp(undefined)).toBe('main');
    expect(parseAfter('settings')).toBe('settings');
    expect(parseAfter('../x')).toBeUndefined();
    expect(linksToLiveApp('live', 'signup')).toBe(true);
    expect(linksToLiveApp('live', 'recovery')).toBe(false);
    expect(linksToLiveApp('main', 'signup')).toBe(false);
  });

  it('masks addresses for logs', () => {
    expect(maskEmail('ada@example.com')).toBe('a***@example.com');
    expect(maskEmail('nope')).toBe('***');
  });
});
