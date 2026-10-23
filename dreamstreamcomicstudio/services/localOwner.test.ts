import { beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_OWNER_KEY,
  adoptStoredSessionOwner,
  clearLocalOwner,
  getLocalOwner,
  ownedByAnotherAccount,
  setLocalOwner,
  shouldDetectSessionInUrl,
  userIdFromStoredSession
} from './localOwner';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('localOwner', () => {
  beforeEach(() => localStorage.clear());

  it('records, reads and clears the owning account', () => {
    expect(getLocalOwner()).toBeNull();
    setLocalOwner(A);
    expect(getLocalOwner()).toBe(A);
    clearLocalOwner();
    expect(getLocalOwner()).toBeNull();
  });

  it('ignores junk ids and junk stored values', () => {
    setLocalOwner('not-a-uuid');
    expect(localStorage.getItem(LOCAL_OWNER_KEY)).toBeNull();
    localStorage.setItem(LOCAL_OWNER_KEY, '<script>');
    expect(getLocalOwner()).toBeNull();
  });

  it('flags local data that belongs to a different account only', () => {
    expect(ownedByAnotherAccount(B)).toBe(false); // nobody owns it yet
    setLocalOwner(A);
    expect(ownedByAnotherAccount(A)).toBe(false);
    expect(ownedByAnotherAccount(A.toUpperCase())).toBe(false);
    expect(ownedByAnotherAccount(B)).toBe(true);
  });

  it('reads the user id out of a stored supabase-js session', () => {
    expect(userIdFromStoredSession(JSON.stringify({ access_token: 'x', user: { id: A } }))).toBe(A);
    expect(userIdFromStoredSession(JSON.stringify({ currentSession: { user: { id: B } } }))).toBe(B);
    expect(userIdFromStoredSession('{broken')).toBeNull();
    expect(userIdFromStoredSession(JSON.stringify({ user: { id: 'nope' } }))).toBeNull();
    expect(userIdFromStoredSession(null)).toBeNull();
  });

  it('adopts the stored session as owner on an install from before the marker, never overriding one', () => {
    adoptStoredSessionOwner(JSON.stringify({ user: { id: A } }));
    expect(getLocalOwner()).toBe(A);
    adoptStoredSessionOwner(JSON.stringify({ user: { id: B } }));
    expect(getLocalOwner()).toBe(A);
  });

  it('reads tokens from the URL only on our own sign-in landing pages', () => {
    const at = (path: string, origin = 'https://dreamstreamstudio.ai') => shouldDetectSessionInUrl(new URL(`${origin}${path}#access_token=x`));
    expect(at('/auth/callback')).toBe(true);
    expect(at('/auth/callback/')).toBe(true);
    expect(at('/')).toBe(true); // Supabase Site URL fallback
    expect(at('/live')).toBe(true); // Stream Studio on the main host
    expect(at('/live.html')).toBe(true);
    expect(at('/', 'https://stream.dreamstreamstudio.ai')).toBe(true);
    expect(at('/c/aB3dE5fG7hJ9kL1mN')).toBe(false); // share links
    expect(at('/c/aB3dE5fG7hJ9kL1mN/embed')).toBe(false);
    expect(at('/models')).toBe(false);
    expect(at('/share/x')).toBe(false);
    expect(at('/auth/callbackx')).toBe(false);
  });
});
