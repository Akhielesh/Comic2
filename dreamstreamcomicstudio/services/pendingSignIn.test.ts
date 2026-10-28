// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PENDING_SIGN_IN_KEY,
  SIGN_IN_INTENT_TTL_MS,
  clearSignInIntents,
  consumeSignInIntent,
  hasFreshSignInIntent,
  markSignInStarted,
  newSignInNonce,
  recordSignInStarted
} from './pendingSignIn';

const link = (sn?: string, base = 'https://dreamstreamstudio.ai/auth/callback?token_hash=h&type=magiclink') =>
  sn ? `${base}&sn=${sn}` : base;

describe('sign-in intent', () => {
  beforeEach(() => localStorage.clear());

  it('is recorded with a nonce, time and kind when this browser starts a link sign-in', () => {
    expect(hasFreshSignInIntent()).toBe(false);
    const nonce = markSignInStarted('magiclink');
    const [stored] = JSON.parse(localStorage.getItem(PENDING_SIGN_IN_KEY) || '[]');
    expect(stored).toMatchObject({ kind: 'magiclink', nonce });
    expect(nonce).toMatch(/^[A-Za-z0-9-]{16,64}$/);
    expect(Math.abs(stored.at - Date.now())).toBeLessThan(5_000);
    expect(hasFreshSignInIntent()).toBe(true);
  });

  it('lets through only the link that carries its nonce, once', () => {
    const nonce = markSignInStarted('magiclink');
    expect(consumeSignInIntent(link(nonce))).toBe(true);
    expect(localStorage.getItem(PENDING_SIGN_IN_KEY)).toBeNull();
    expect(consumeSignInIntent(link(nonce))).toBe(false); // a second open asks first
  });

  it('never waves through a link without the nonce — an attacker’s own link — and that link clears what was pending', () => {
    // The victim asked for a password reset, then signed in with a password instead.
    const nonce = markSignInStarted('recovery');
    expect(consumeSignInIntent(link())).toBe(false);
    expect(consumeSignInIntent(link(newSignInNonce()))).toBe(false);
    expect(hasFreshSignInIntent()).toBe(false);
    expect(consumeSignInIntent(link(nonce))).toBe(false); // gone: the next link asks too
  });

  it('keeps several started sign-ins apart (asked twice for a link: either email works)', () => {
    const first = markSignInStarted('magiclink');
    const second = markSignInStarted('magiclink');
    expect(consumeSignInIntent(link(first))).toBe(true);
    expect(consumeSignInIntent(link(second))).toBe(true);
    expect(hasFreshSignInIntent()).toBe(false);
  });

  it('expires after an hour (and a stale record is cleared, not honoured)', () => {
    const now = Date.now();
    const nonce = markSignInStarted('recovery', now);
    expect(hasFreshSignInIntent(now + SIGN_IN_INTENT_TTL_MS - 1_000)).toBe(true);
    expect(hasFreshSignInIntent(now + SIGN_IN_INTENT_TTL_MS + 1_000)).toBe(false);
    expect(consumeSignInIntent(link(nonce), now + SIGN_IN_INTENT_TTL_MS + 1_000)).toBe(false);
    expect(localStorage.getItem(PENDING_SIGN_IN_KEY)).toBeNull();
  });

  it('ignores junk, malformed nonces and records from the future', () => {
    localStorage.setItem(PENDING_SIGN_IN_KEY, '{not json');
    expect(hasFreshSignInIntent()).toBe(false);
    localStorage.setItem(PENDING_SIGN_IN_KEY, JSON.stringify([{ at: Date.now() }]));
    expect(hasFreshSignInIntent()).toBe(false); // no nonce
    recordSignInStarted('magiclink', 'short');
    expect(hasFreshSignInIntent()).toBe(false);
    const future = 'f'.repeat(32);
    localStorage.setItem(PENDING_SIGN_IN_KEY, JSON.stringify([{ nonce: future, at: Date.now() + 10 * 60_000, kind: 'x' }]));
    expect(hasFreshSignInIntent()).toBe(false);
    expect(consumeSignInIntent(link(future))).toBe(false);
    expect(consumeSignInIntent('not a url')).toBe(false);
  });

  it('records the address the link was sent to (never the gate — the nonce is)', () => {
    const nonce = newSignInNonce();
    recordSignInStarted('magiclink', nonce, Date.now(), 'ada@example.com');
    const [stored] = JSON.parse(localStorage.getItem(PENDING_SIGN_IN_KEY) || '[]');
    expect(stored).toMatchObject({ kind: 'magiclink', nonce, email: 'ada@example.com' });
    recordSignInStarted('recovery', newSignInNonce());
    const [, second] = JSON.parse(localStorage.getItem(PENDING_SIGN_IN_KEY) || '[]');
    expect(second.email).toBeUndefined();
  });

  it('a nonce recorded for one kind of sign-in never passes a link of another kind', () => {
    // Our backend only ever puts a nonce into the link it built for that request, so a mismatch
    // means the link was tampered with: a reset's nonce on a magic link asks first.
    const recovery = markSignInStarted('recovery');
    expect(consumeSignInIntent(link(recovery, 'https://dreamstreamstudio.ai/auth/callback?token_hash=h&type=magiclink'))).toBe(false);
    const recovery2 = markSignInStarted('recovery');
    expect(consumeSignInIntent(link(recovery2, 'https://dreamstreamstudio.ai/auth/callback?token_hash=h&type=recovery'))).toBe(true);
    // The kinds that share a link type pass each other: a resend is a sign-up confirmation,
    // a handoff is a magic link; a link whose type is unknown is judged by its nonce alone.
    const resend = markSignInStarted('resend');
    expect(consumeSignInIntent(link(resend, 'https://dreamstreamstudio.ai/live?after=monitor&token_hash=h&type=signup'))).toBe(true);
    const handoff = markSignInStarted('handoff');
    expect(consumeSignInIntent(link(handoff, 'https://stream.dreamstreamstudio.ai/?token_hash=h&type=magiclink'))).toBe(true);
    const signup = markSignInStarted('signup');
    expect(consumeSignInIntent(link(signup, 'https://dreamstreamstudio.ai/auth/callback?token_hash=h'))).toBe(true);
    const magic = markSignInStarted('magiclink');
    expect(consumeSignInIntent(`https://dreamstreamstudio.ai/?sn=${magic}#access_token=a&refresh_token=r&type=magiclink`)).toBe(true);
    const magic2 = markSignInStarted('magiclink');
    expect(consumeSignInIntent(link(magic2, 'https://dreamstreamstudio.ai/auth/callback?token_hash=h&type=signup'))).toBe(false);
  });

  it('can be cleared outright', () => {
    markSignInStarted('signup');
    clearSignInIntents();
    expect(hasFreshSignInIntent()).toBe(false);
  });
});
