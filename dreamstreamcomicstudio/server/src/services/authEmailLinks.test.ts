// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildAuthLink,
  buildHandoffLink,
  buildLinkOriginAllowlist,
  linksToLiveApp,
  maskEmail,
  parseAfter,
  parseApp,
  parseMainHandoffPath,
  parseStreamHandoffPath,
  pickLinkOrigin,
  streamAppBase
} from './authEmailLinks.js';

const STREAM = 'https://stream.dreamstreamstudio.ai';

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
    const off = { streamHostOn: false } as const;
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'signup', after: 'monitor', ...off })).toBe(
      `${APP}/live?after=monitor&token_hash=h&type=signup`
    );
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'signup', after: 'studio', ...off })).toBe(
      `${APP}/live?token_hash=h&type=signup`
    );
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'signup', ...off })).toBe(
      `${APP}/live?token_hash=h&type=signup`
    );
  });

  it('with the Stream Studio host switched on, live sign-ups land on stream.dreamstreamstudio.ai', () => {
    const on = { streamHostOn: true } as const;
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'signup', after: 'monitor', ...on })).toBe(
      `${STREAM}/?after=monitor&token_hash=h&type=signup`
    );
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'signup', after: 'calls', ...on })).toBe(
      `${STREAM}/?after=calls&token_hash=h&type=signup`
    );
    // Recovery and main-app links never move: the reset screen is on the main app.
    expect(buildAuthLink({ app: 'live', origin: APP, hashedToken: 'h', verificationType: 'recovery', ...on })).toBe(
      `${APP}/auth/callback?token_hash=h&type=recovery`
    );
    expect(buildAuthLink({ app: 'main', origin: APP, hashedToken: 'h', verificationType: 'signup', ...on })).toBe(
      `${APP}/auth/callback?token_hash=h&type=signup`
    );
    // A developer on localhost keeps their local /live.
    expect(streamAppBase('http://localhost:3000', true)).toBe('http://localhost:3000/live');
    expect(streamAppBase(`${APP}/`, true)).toBe(`${STREAM}/`);
    expect(streamAppBase(APP, false)).toBe(`${APP}/live`);
  });

  it('never lets a request from the Stream Studio host pick where a main-app link points', () => {
    const allow = buildLinkOriginAllowlist(APP, ['http://localhost:3000']);
    expect(pickLinkOrigin(STREAM, allow)).toBe(APP);
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

describe('sign-in handoff links', () => {
  it('into Stream Studio: its fixed host, the magic-link token and an allowlisted screen', () => {
    expect(buildHandoffLink({ to: 'live', mainOrigin: APP, hashedToken: 'h+/', verificationType: 'magiclink' })).toBe(
      `${STREAM}/?token_hash=h%2B%2F&type=magiclink`
    );
    expect(buildHandoffLink({ to: 'live', mainOrigin: 'https://evil.example', hashedToken: 'h', verificationType: 'magiclink', after: 'monitor' })).toBe(
      `${STREAM}/?token_hash=h&type=magiclink&after=monitor`
    );
  });

  it('into the main app: /auth/callback with an allowlisted next path', () => {
    expect(buildHandoffLink({ to: 'main', mainOrigin: `${APP}/`, hashedToken: 'h', verificationType: 'magiclink' })).toBe(
      `${APP}/auth/callback?token_hash=h&type=magiclink&next=%2F`
    );
    expect(buildHandoffLink({ to: 'main', mainOrigin: APP, hashedToken: 'h', verificationType: 'magiclink', next: '/?view=chat' })).toBe(
      `${APP}/auth/callback?token_hash=h&type=magiclink&next=%2F%3Fview%3Dchat`
    );
    expect(buildHandoffLink({ to: 'main', mainOrigin: APP, hashedToken: 'h', verificationType: 'magiclink', next: '//evil.example' })).toBe(
      `${APP}/auth/callback?token_hash=h&type=magiclink&next=%2F`
    );
    expect(() => buildHandoffLink({ to: 'live', mainOrigin: APP, hashedToken: '', verificationType: 'magiclink' })).toThrow();
    expect(() => buildHandoffLink({ to: 'live', mainOrigin: APP, hashedToken: 'h', verificationType: 'email_change' })).toThrow();
  });

  it('accept only known destinations (no open redirect)', () => {
    for (const ok of ['', undefined, '/live', '/live/', '/live.html', '/', '/live#/monitor', '#/settings', '/#/calls', `${STREAM}/#/create`, `${STREAM}/`]) {
      expect(parseStreamHandoffPath(ok)).not.toBeNull();
    }
    expect(parseStreamHandoffPath('/live#/monitor')).toBe('monitor');
    expect(parseStreamHandoffPath('/live')).toBe('');
    for (const bad of ['//evil.example', 'https://evil.example/#/monitor', '/live#/studio', '/live?e=x', '/live#/monitor/abc', 'javascript:alert(1)', '/other', 42]) {
      expect(parseStreamHandoffPath(bad)).toBeNull();
    }
    for (const ok of ['/', '/models', '/?view=chat', '/?view=settings', '/?view=privacy']) {
      expect(parseMainHandoffPath(ok)).toBe(ok);
    }
    expect(parseMainHandoffPath(undefined)).toBe('/');
    for (const bad of ['//evil.example', 'https://evil.example', '/?view=chat&x=1', '/?view=nope', '/share/abc', '/\\evil.example', 42]) {
      expect(parseMainHandoffPath(bad)).toBeNull();
    }
  });
});

describe('small parsers', () => {
  it('parse app / after / live branding', () => {
    expect(parseApp('live')).toBe('live');
    expect(parseApp('studio')).toBe('main');
    expect(parseApp(undefined)).toBe('main');
    expect(parseAfter('settings')).toBe('settings');
    expect(parseAfter('../x')).toBeUndefined();
    expect(parseAfter('calls')).toBe('calls');
    expect(linksToLiveApp('live', 'signup')).toBe(true);
    expect(linksToLiveApp('live', 'recovery')).toBe(false);
    expect(linksToLiveApp('main', 'signup')).toBe(false);
  });

  it('masks addresses for logs', () => {
    expect(maskEmail('ada@example.com')).toBe('a***@example.com');
    expect(maskEmail('nope')).toBe('***');
  });
});
