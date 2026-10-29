// @vitest-environment jsdom
// Probe: "Remember me" OFF + a magic link. AuthPage stores the preference ('session') and sends the
// link; the email opens it in a NEW tab, which signs in there (sessionStorage of that tab). The tab
// that asked hears supabase-js's cross-tab SIGNED_IN announcement, which stores nothing here.
// services/supabase.isStoredSession answers true for a tab with nothing stored ("it can't tell"), so
// contexts/AuthContext applies the announced session: the requesting tab shows the dashboard as B —
// while its own supabase client has no session (getSession/getUser are empty). Every direct Supabase
// write then silently does nothing: services/db.saveProject returns early ("do not persist projects
// without a signed-in user"), so a comic made in that tab is never saved; a reload lands signed out.
// Real AuthContext, real isStoredSession/forgetTabSession (the real services/supabase module, only its
// client replaced by a fake that keeps the per-tab session the way supabase-js does), real db.saveProject.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../../types';

const B = '22222222-2222-4222-8222-222222222222';
type FakeSession = { user: { id: string; email: string }; access_token: string; expires_at: number };

const h = vi.hoisted(() => ({
  /** What THIS tab's storage holds (sessionStorage with "Remember me" off): nothing — the link opened elsewhere. */
  stored: null as FakeSession | null,
  listeners: [] as ((event: string, session: unknown) => void)[],
  upserts: [] as Record<string, unknown>[],
  emit(event: string, session: unknown) {
    for (const l of [...h.listeners]) l(event, session);
  },
}));

vi.mock('../../services/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/supabase')>();
  return {
    ...actual,
    supabase: {
      auth: {
        // Like supabase-js: the session comes from this tab's storage on every call.
        getSession: vi.fn(async () => ({ data: { session: h.stored } })),
        getUser: vi.fn(async () => ({ data: { user: h.stored?.user ?? null }, error: h.stored ? null : { name: 'AuthSessionMissingError' } })),
        onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
          h.listeners.push(cb);
          queueMicrotask(() => cb('INITIAL_SESSION', h.stored));
          return { data: { subscription: { unsubscribe: () => (h.listeners = h.listeners.filter((l) => l !== cb)) } } };
        }),
        signOut: vi.fn(async () => ({ error: null })),
      },
      from: vi.fn(() => ({
        upsert: async (row: Record<string, unknown>) => {
          h.upserts.push(row);
          return { error: null };
        },
        select: () => ({ eq: async () => ({ data: [], error: null }) }),
        delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      })),
    },
  };
});
vi.mock('../../services/apiClient', () => ({
  get: vi.fn(async (path: string) => (path === '/api/account/settings' ? { ok: true, data: null } : { ok: true, keys: [] })),
  put: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../services/deviceSessions', () => ({ registerDevice: vi.fn(async () => undefined) }));

import { AuthProvider, useAuth } from '../../contexts/AuthContext';
import { loadProjects, saveProject } from '../../services/db';
import { supabase } from '../../services/supabase';

const session = (id: string): FakeSession => ({ user: { id, email: 'b@example.com' }, access_token: `t-${id}`, expires_at: 9_999_999_999 });
const WhoAmI = () => {
  const { user, loading } = useAuth();
  return <span data-testid="who">{loading ? 'loading' : (user?.id ?? 'signed-out')}</span>;
};
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

const project: Project = {
  id: 'p-1',
  name: 'My comic',
  createdAt: 1,
  updatedAt: 2,
  isPublic: false,
  state: { step: 0, maxStepReached: 0, script: '', scenes: [], panels: [], characters: [], items: [], locations: [], styleVariants: [], stylePrompt: '', styleCategory: '', styleAspectRatio: '2:3', imageResolution: '2K', layoutType: 'classic', studioVersion: 4 } as unknown as ComicState,
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  h.stored = null;
  h.listeners = [];
  h.upserts = [];
  localStorage.setItem('dreamstream_auth_persist', 'session'); // AuthPage: "Remember me" unticked, magic link requested
});

describe('"Remember me" off: the tab that asked for the magic link, after the link signed in in another tab', () => {
  it('is signed in for real (its saves persist) — or stays honestly signed out', async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <WhoAmI />
        </AuthProvider>
      );
    });
    await flush();
    expect(screen.getByTestId('who').textContent).toBe('signed-out');

    // The link tab: verifyOtp → _saveSession (ITS sessionStorage) → SIGNED_IN, broadcast to this tab
    // without being stored here (supabase-js BroadcastChannel → _notifyAllSubscribers(…, false)).
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await flush();
    const shown = screen.getByTestId('who').textContent;
    const own = (await supabase.auth.getSession()).data.session;

    // The person now opens the dashboard (loadProjects) and makes a comic in this tab (saveProject).
    const dashboard = await loadProjects();
    await saveProject(project);
    process.stderr.write(`probe auth3 ${JSON.stringify({ shown, ownSession: own?.user?.id ?? null, dashboardProjects: dashboard.length, upserts: h.upserts.length })}\n`);

    // Expected: what the tab shows and what it can do agree. Observed: the tab shows B signed in,
    // its own client has no session, and the comic is silently not saved.
    if (shown === B) expect(h.upserts).toHaveLength(1);
    else expect(shown).toBe('signed-out');
  });
});
