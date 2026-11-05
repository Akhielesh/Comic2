// The Model Library's "Verified live" strip reads GET /api/models/verify, which is admin-only
// except for a user's own header key. So the strip calls it (and renders) only for a
// server-confirmed admin or a user who sends their own OpenRouter/NVIDIA key; nobody else
// fetches it or sees it, nothing is fetched while the admin check is still loading, a 403 just
// hides it, and a non-admin never sees platform dollars. A non-admin's strip is their own-key view:
// a platform-served provider is never told it needs a key. Switching accounts while the page stays
// open never paints or fetches anything for the new account before its own admin check.
import { useLayoutEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelVerification } from '../services/modelCatalog';

const auth = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));

const admin = vi.hoisted(() => ({ getAdminAccess: vi.fn() }));
vi.mock('../services/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billing')>()),
  getAdminAccess: admin.getAdminAccess
}));

const verify = vi.hoisted(() => ({ fetchModelVerification: vi.fn() }));
vi.mock('../services/modelCatalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelCatalog')>()),
  fetchModelVerification: verify.fetchModelVerification
}));

import { AccountVerifiedStrip, VerifiedStrip } from './ModelLibrary';
import { getProviderDef } from '../shared/providers';
import { addKey, clearAllKeys } from '../services/apiKeys';
import { ApiError } from '../services/apiClient';

const verification = (
  credits: { total: number; usage: number; remaining: number } | null,
  providers: ModelVerification['providers'] = {}
): ModelVerification => ({
  verifiedAt: 1,
  catalog: { fetchedAt: 1, degraded: false, total: 3, freeCount: 1 },
  sources: {
    openrouter: { connected: true, modelCount: 2, liveKey: { label: 'k', usage: 4.5, limit: 50, limit_remaining: 45.5 }, credits },
    nvidia: { connected: false, modelCount: 0 }
  },
  providers
});
// The shape /verify gives a non-admin with only their own OpenRouter key: every other provider is
// connected:false, whether or not a platform key exists for it.
const ownOpenRouterOnly: ModelVerification['providers'] = {
  openrouter: { connected: true, modelCount: 0 },
  nvidia: { connected: false, modelCount: 0 },
  gemini: { connected: false, modelCount: 4 },
  openai: { connected: false, modelCount: 6 }
};
const chip = (container: HTMLElement, id: string) => container.querySelector(`[title^="${getProviderDef(id)!.label}:"]`);

// useIsAdmin caches per user id at module scope, so each test signs in as a fresh user.
let n = 0;
const signIn = () => {
  n += 1;
  auth.user = { id: `user-${n}`, email: `user-${n}@example.com` };
};
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const DOLLARS = /\$\s?\d/;

beforeEach(() => {
  window.localStorage.clear();
  auth.user = null;
  admin.getAdminAccess.mockReset();
  verify.fetchModelVerification.mockReset();
  verify.fetchModelVerification.mockResolvedValue(verification({ total: 900, usage: 100, remaining: 800 }));
});
afterEach(() => {
  clearAllKeys();
  window.localStorage.clear();
});

describe('VerifiedStrip gate', () => {
  it('signed out: not rendered and the endpoint is never called', async () => {
    const { container } = render(<VerifiedStrip />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(verify.fetchModelVerification).not.toHaveBeenCalled();
  });

  it('signed-in non-admin without an own key: not rendered and the endpoint is never called', async () => {
    signIn();
    admin.getAdminAccess.mockResolvedValue({ isAdmin: false });
    const { container } = render(<VerifiedStrip />);
    await settle();
    expect(admin.getAdminAccess).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
    expect(verify.fetchModelVerification).not.toHaveBeenCalled();
  });

  it('a failed admin check counts as non-admin: nothing fetched or rendered', async () => {
    signIn();
    admin.getAdminAccess.mockRejectedValue(new ApiError('Admin access required', 403));
    const { container } = render(<VerifiedStrip />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(verify.fetchModelVerification).not.toHaveBeenCalled();
  });

  it('while the admin check is loading nothing is fetched; once confirmed admin, the strip renders platform data', async () => {
    signIn();
    let confirm: (value: { isAdmin: boolean }) => void = () => undefined;
    admin.getAdminAccess.mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
    const { container } = render(<VerifiedStrip />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(verify.fetchModelVerification).not.toHaveBeenCalled();

    await act(async () => { confirm({ isAdmin: true }); });
    await settle();
    expect(verify.fetchModelVerification).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Verified live/)).toBeInTheDocument();
    expect(container.textContent).toContain('$800.00');
  });

  it('non-admin with their own OpenRouter key: fetched and rendered with that key\'s own numbers', async () => {
    signIn();
    admin.getAdminAccess.mockResolvedValue({ isAdmin: false });
    addKey({ provider: 'openrouter', key: 'user-own-openrouter-key-fake' });
    verify.fetchModelVerification.mockResolvedValue(verification({ total: 20, usage: 5, remaining: 15 }));
    const { container } = render(<VerifiedStrip />);
    await settle();
    expect(verify.fetchModelVerification).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Verified live/)).toBeInTheDocument();
    expect(container.textContent).toContain('$15.00');
  });

  it('non-admin with only an own NVIDIA key never sees OpenRouter dollars, even if a response carried them', async () => {
    signIn();
    admin.getAdminAccess.mockResolvedValue({ isAdmin: false });
    addKey({ provider: 'nvidia', key: 'user-own-nvidia-key-fake' });
    const { container } = render(<VerifiedStrip />);
    await settle();
    expect(verify.fetchModelVerification).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Verified live/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(DOLLARS);
  });

  it('own-key non-admin: their view is "Your keys", and a platform-served provider is never told it needs a key', async () => {
    signIn();
    admin.getAdminAccess.mockResolvedValue({ isAdmin: false });
    addKey({ provider: 'openrouter', key: 'user-own-openrouter-key-fake' });
    verify.fetchModelVerification.mockResolvedValue(verification({ total: 20, usage: 5, remaining: 15 }, ownOpenRouterOnly));
    const { container } = render(<VerifiedStrip />);
    await settle();

    expect(screen.getByText('Your keys:')).toBeInTheDocument();
    const gemini = chip(container, 'gemini');
    expect(gemini?.getAttribute('title')).not.toMatch(/add one .* to use these models/);
    expect(gemini?.getAttribute('title')).toMatch(/runs on the shared allowance; your own key is optional/);
    expect(gemini?.textContent).not.toContain('+ key');
    // A BYOK-only provider still says a key is how to use it.
    expect(chip(container, 'openai')?.getAttribute('title')).toMatch(/add one in Settings/);
    // The cards speak of the user's own keys, never "not connected", and show no catalog totals
    // (the server reads no shared catalog for a non-admin).
    expect(container.textContent).not.toContain('not connected');
    expect(container.textContent).toContain('no key of yours · runs on the shared allowance');
    expect(container.textContent).not.toMatch(/Catalog:/);
    expect(container.textContent).not.toMatch(/connected · 0 models/);
  });

  it('admin: the platform view keeps its copy (Direct providers, connected, catalog totals)', async () => {
    signIn();
    admin.getAdminAccess.mockResolvedValue({ isAdmin: true });
    verify.fetchModelVerification.mockResolvedValue(verification({ total: 900, usage: 100, remaining: 800 }, {
      ...ownOpenRouterOnly,
      gemini: { connected: true, modelCount: 4 }
    }));
    const { container } = render(<VerifiedStrip />);
    await settle();
    expect(screen.getByText('Direct providers:')).toBeInTheDocument();
    expect(chip(container, 'gemini')?.getAttribute('title')).toBe(`${getProviderDef('gemini')!.label}: connected · 4 models`);
    expect(container.textContent).toMatch(/Catalog:/);
    expect(container.textContent).toContain('connected · 2 models');
  });

  it('switching straight from an admin to another account paints nothing of the admin and fetches nothing until the new admin check resolves', async () => {
    // Records the DOM at every commit, before passive effects run: exactly what gets painted.
    const painted: string[] = [];
    const PaintProbe = () => {
      useLayoutEffect(() => { painted.push(document.body.textContent ?? ''); });
      return null;
    };
    signIn(); // account A, an admin
    admin.getAdminAccess.mockResolvedValue({ isAdmin: true });
    const { container, rerender } = render(<><AccountVerifiedStrip /><PaintProbe /></>);
    await settle();
    expect(container.textContent).toContain('$800.00');
    expect(verify.fetchModelVerification).toHaveBeenCalledTimes(1);

    signIn(); // account B, straight from A (another tab's SIGNED_IN); its admin check stays pending
    admin.getAdminAccess.mockReturnValue(new Promise(() => undefined));
    painted.length = 0;
    rerender(<><AccountVerifiedStrip /><PaintProbe /></>);
    await settle();
    expect(painted.length).toBeGreaterThan(0);
    for (const frame of painted) expect(frame).not.toMatch(DOLLARS);
    expect(container.textContent).not.toMatch(DOLLARS);
    expect(container).toBeEmptyDOMElement();
    expect(verify.fetchModelVerification).toHaveBeenCalledTimes(1);
  });

  it('a 403 from the endpoint hides the strip quietly: no banner, nothing logged', async () => {
    signIn();
    admin.getAdminAccess.mockResolvedValue({ isAdmin: false });
    addKey({ provider: 'openrouter', key: 'user-own-openrouter-key-fake' });
    verify.fetchModelVerification.mockRejectedValue(new ApiError('Admins only.', 403));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { container } = render(<VerifiedStrip />);
      await settle();
      expect(verify.fetchModelVerification).toHaveBeenCalledTimes(1);
      expect(container).toBeEmptyDOMElement();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
