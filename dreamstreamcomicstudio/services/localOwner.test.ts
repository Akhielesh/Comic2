import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_OWNER_KEY,
  adoptStoredSessionOwner,
  claimUnownedData,
  clearLocalOwner,
  getLocalOwner,
  getUnownedDataOwner,
  isLocalOwner,
  ownedByAnotherAccount,
  setLocalOwner,
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

  it('a full storage never leaves a stale owner behind: the signed-in account is kept in memory', () => {
    setLocalOwner(A);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      setLocalOwner(B);
      expect(getLocalOwner()).toBe(B);
      expect(localStorage.getItem(LOCAL_OWNER_KEY)).toBeNull(); // A's marker is gone, not left stale
    } finally {
      setItem.mockRestore();
    }
    setLocalOwner(A); // storage works again
    expect(getLocalOwner()).toBe(A);
    expect(localStorage.getItem(LOCAL_OWNER_KEY)).toBe(A);
    clearLocalOwner();
    expect(getLocalOwner()).toBeNull();
  });

  it('isLocalOwner matches only the current owner (case-insensitively)', () => {
    expect(isLocalOwner(A)).toBe(false);
    setLocalOwner(A);
    expect(isLocalOwner(A)).toBe(true);
    expect(isLocalOwner(A.toUpperCase())).toBe(true);
    expect(isLocalOwner(B)).toBe(false);
    expect(isLocalOwner(null)).toBe(false);
  });

  it('data from before ownership tags is claimed once — the boot session’s account or the first owner — never by a later one', () => {
    expect(getUnownedDataOwner()).toBeNull();
    adoptStoredSessionOwner(JSON.stringify({ user: { id: A } }));
    expect(getUnownedDataOwner()).toBe(A);
    clearLocalOwner(); // A signs out
    claimUnownedData(B); // B signs in on the same device
    expect(getUnownedDataOwner()).toBe(A);
    claimUnownedData('junk');
    expect(getUnownedDataOwner()).toBe(A);
  });
});
