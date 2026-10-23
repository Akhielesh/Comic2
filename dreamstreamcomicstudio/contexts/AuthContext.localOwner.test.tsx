// @vitest-environment jsdom
import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const calls: string[] = [];
let currentSession: { user: { id: string }; access_token: string; expires_at: number } | null = null;
let authListener: ((event: string, session: unknown) => void) | null = null;

vi.mock('../services/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: currentSession } })),
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        authListener = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signOut: vi.fn(async () => ({ error: null }))
    }
  },
  getAuthRedirectUrl: () => '/auth/callback',
  isSessionExpiredByInactivity: () => false,
  touchLastActivity: vi.fn()
}));
vi.mock('../services/cloudSync', () => ({
  syncOnLogin: vi.fn(async (id: string) => {
    calls.push(`sync:${id}`);
  }),
  schedulePush: vi.fn()
}));
vi.mock('../services/apiKeys', () => ({
  clearAllKeys: vi.fn(() => calls.push('clearKeys')),
  setKeysChangeListener: vi.fn()
}));
vi.mock('../services/appSettings', () => ({ clearUserScopedSettings: vi.fn(), setSettingsChangeListener: vi.fn() }));
vi.mock('../services/chatStorage', () => ({ setChatDataChangeListener: vi.fn() }));
vi.mock('../services/modelSelection', () => ({ clearModelSelection: vi.fn(), MODEL_SELECTION_CHANGED: 'msc' }));
vi.mock('../services/sourceGovernance', () => ({ SOURCE_GOVERNANCE_CHANGED: 'sgc' }));
vi.mock('../services/deviceSessions', () => ({ registerDevice: vi.fn(async () => undefined) }));
vi.mock('../live/accountPurge', () => ({ purgeLiveAccountData: vi.fn() }));
vi.mock('../services/authEmail', () => ({ EMAIL_SERVICE_DOWN: 'down', requestAuthEmail: vi.fn() }));

import { AuthProvider } from './AuthContext';
import { getLocalOwner, setLocalOwner } from '../services/localOwner';

const session = (id: string) => ({ user: { id }, access_token: `t-${id}`, expires_at: 1 });

const mount = async () => {
  await act(async () => {
    render(
      <AuthProvider>
        <div />
      </AuthProvider>
    );
  });
};

describe('AuthProvider — local data never crosses accounts', () => {
  beforeEach(() => {
    localStorage.clear();
    calls.length = 0;
    currentSession = null;
    authListener = null;
  });

  it("a session for another account purges this device's keys BEFORE the login sync", async () => {
    setLocalOwner(A);
    currentSession = session(B);
    await mount();
    expect(calls).toEqual(['clearKeys', `sync:${B}`]);
    expect(getLocalOwner()).toBe(B);
  });

  it('the same account keeps its local data and syncs once', async () => {
    setLocalOwner(A);
    currentSession = session(A);
    await mount();
    expect(calls).toEqual([`sync:${A}`]);
    expect(getLocalOwner()).toBe(A);
  });

  it('a first sign-in on a device with no owner keeps the local data (keys added before signing in)', async () => {
    currentSession = session(A);
    await mount();
    expect(calls).toEqual([`sync:${A}`]);
    expect(getLocalOwner()).toBe(A);
  });

  it('an account switch without a sign-out (SIGNED_IN for B after A) purges before syncing B', async () => {
    currentSession = session(A);
    await mount();
    calls.length = 0;
    await act(async () => {
      authListener?.('SIGNED_IN', session(B));
    });
    expect(calls).toEqual(['clearKeys', `sync:${B}`]);
    expect(getLocalOwner()).toBe(B);
  });

  it('signing out clears the owner, so the next account starts clean without a purge', async () => {
    currentSession = session(A);
    await mount();
    await act(async () => {
      authListener?.('SIGNED_OUT', null);
    });
    expect(getLocalOwner()).toBeNull();
    calls.length = 0;
    await act(async () => {
      authListener?.('SIGNED_IN', session(B));
    });
    expect(calls).toEqual([`sync:${B}`]);
  });
});
