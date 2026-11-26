// @vitest-environment jsdom
// navtheme NT-2a: one way to the DreamStream settings from Comic Studio, and Back returns to the place the person left.
// The real App on the comics host, signed in, with the real New comic / All comics frame and the real account menu;
// Settings itself is a stand-in (its own tests cover it), and nothing reaches the network.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from './types';

const USER = { id: 'acct-nav-user', email: 'reader@example.invalid', user_metadata: { display_name: 'Ada Example' }, updated_at: 'x' };
const signOut = vi.fn(async () => undefined);
vi.mock('./contexts/AuthContext', () => ({
  useAuth: () => ({ user: USER, session: null, loading: false, signOut }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

const NOW = Date.UTC(2026, 10, 19, 12);
const state = (): ComicState =>
  ({
    step: 0,
    maxStepReached: 0,
    script: '',
    scenes: [],
    styleVariants: [],
    stylePrompt: '',
    styleCategory: '',
    styleAspectRatio: '2:3',
    imageResolution: '2K',
    characters: [],
    items: [],
    locations: [],
    layoutType: 'grid',
    panels: [],
    studioVersion: 4,
    studioPages: 6
  }) as ComicState;
const projectsState = vi.hoisted(() => ({ list: [] as Project[] }));
vi.mock('./hooks/useProjectManager', () => ({
  useProjectManager: () => ({
    projects: projectsState.list,
    projectsLoaded: true,
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    duplicateProject: vi.fn(),
    getProject: (id: string) => projectsState.list.find((p) => p.id === id),
    startGeneration: vi.fn(),
    stopGeneration: vi.fn(),
    hydrateProjectAssets: vi.fn(),
    reloadProjects: vi.fn()
  })
}));
vi.mock('./services/geminiService', () => ({
  checkSystemStatus: vi.fn(async () => ({ status: 'ok' })),
  checkSystemDiagnostics: vi.fn(async () => ({ status: 'ok' }))
}));
vi.mock('./hooks/useIsAdmin', () => ({ useIsAdmin: () => false }));
vi.mock('./components/account/useAdminAccess', () => ({
  useAdminAccess: () => ({ isAdmin: false, isModerator: false, access: null, checked: true })
}));
vi.mock('./services/productAccess', async (orig) => ({ ...(await orig<object>()), useProductAccess: () => null }));
vi.mock('./services/db', async (orig) => ({
  ...(await orig<object>()),
  getPrivateProfile: vi.fn(async () => ({ id: 'acct-nav-user', dob: '2000-01-01' })),
  getUserProfile: vi.fn(async () => ({ id: 'acct-nav-user', username: 'ada', avatar_url: null })),
  getProfileFace: vi.fn(async () => ({ username: 'ada', avatar_url: null }))
}));
vi.mock('./hooks/useMemberHint', () => ({ useMemberHint: () => undefined }));
vi.mock('./components/comicshost/useComicsHost', () => ({
  useComicsHost: () => ({ active: true, leaving: false, ownsChrome: () => false })
}));
// Settings is its own screen with its own tests: a stand-in that shows the tab it opened at and its Back.
vi.mock('./components/AccountSettings', () => ({
  AccountSettings: ({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) => (
    <div data-testid="settings">
      <p>Settings at {initialTab}</p>
      <button type="button" onClick={onClose}>
        Back
      </button>
    </div>
  )
}));
// The open comic: a stand-in that asks for Settings → API keys the way the studio's own links will (NT-2b), and
// offers Chat from the side-panel links App gives it (the studio's panel draws them; SH-C1).
vi.mock('./components/comicstudio/ComicStudio', async () => {
  const { requestAccountSettings: request } = await import('./components/account/accountNav');
  return {
    ComicStudio: ({ projectId, panel }: { projectId: string; panel?: { onChat?: () => void } }) => (
      <div data-testid="studio">
        <p>Studio open on {projectId}</p>
        <button type="button" onClick={() => request('settings')}>
          Your API keys
        </button>
        {panel?.onChat && (
          <button type="button" onClick={panel.onChat}>
            Chat
          </button>
        )}
      </div>
    )
  };
});
vi.mock('./components/chat/AIChatPlatform', () => ({ AIChatPlatform: () => <p>Chat open</p> }));
const standalone = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('./services/standaloneImages', async (original) => ({
  ...(await original<object>()),
  loadImageHistory: async () => ({ images: [], hasMore: false }),
  loadReference: async (file: File) => ({ name: file.name, data: 'data:image/png;base64,AQID' }),
  renderStandalone: standalone.render
}));
vi.mock('./components/UniversalAssistant', () => ({ UniversalAssistant: () => null }));
vi.mock('./components/QuickFinder', () => ({ QuickFinder: () => null }));
vi.mock('./components/feedback/FeedbackWidget', () => ({ FeedbackWidget: () => null }));
vi.mock('./components/DataRescue', () => ({ DataRescue: () => null }));
vi.mock('./components/ReadinessChecklist', () => ({ ReadinessChecklist: () => null }));
vi.mock('./components/common/SmartImage', () => ({ SmartImage: ({ alt }: { alt: string }) => <span aria-label={alt} /> }));
vi.mock('./components/modals/ProjectInfoModal', () => ({ ProjectInfoModal: () => null }));
vi.mock('./components/comicstudio/studioApi', async (orig) => ({ ...(await orig<object>()), streamStudio: vi.fn() }));

import App from './App';
import { ACCOUNT_SETTINGS_EVENT, requestAccountSettings, settingsBackTarget } from './components/account/accountNav';

const realLocation = window.location;
const goTo = (search: string) => window.history.replaceState({}, '', `/${search}`);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })));
  projectsState.list = [];
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  goTo('');
});

const project = (id: string, name: string, at: number): Project => ({ id, name, createdAt: at - 86_400_000, updatedAt: at, state: state() });

/** The first render pays for the lazy views' first transform: wait for them as long as that takes. */
const SLOW = { timeout: 15_000 };
const findTrigger = () => screen.findByRole('button', { name: 'Account and settings' }, SLOW);

const openAccountRow = async (row: string) => {
  const trigger = await findTrigger();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Account and settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: row }));
};

describe('App: the account menu opens the DreamStream settings in the app, and Back returns', { timeout: 30_000 }, () => {
  it('a request opens Settings at its tab, in the app', async () => {
    goTo('?view=dashboard');
    render(<App />);
    await findTrigger();
    let handled = false;
    act(() => {
      handled = requestAccountSettings('security');
    });
    expect(handled).toBe(true);
    expect(await screen.findByText('Settings at security', undefined, SLOW)).toBeInTheDocument();
  });

  it('New comic with a typed name and idea → Profile → Back → New comic with both', async () => {
    projectsState.list = [project('p1', 'Salt Road', NOW)];
    goTo('?view=dashboard');
    render(<App />);
    // With a comic in the list the frame opens on All comics; New comic opens the idea form.
    fireEvent.click(await screen.findByRole('button', { name: 'New comic' }, SLOW));
    fireEvent.change(await screen.findByLabelText(/Comic name/), { target: { value: 'The Lantern Ferry' } });
    fireEvent.change(screen.getByLabelText('Your comic idea or script'), { target: { value: 'A ferry that only sails at night.' } });
    await openAccountRow('Profile');
    expect(await screen.findByText('Settings at profile')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByLabelText(/Comic name/)).toHaveValue('The Lantern Ferry');
    expect(screen.getByLabelText('Your comic idea or script')).toHaveValue('A ferry that only sails at night.');
  });

  it('image settings round-trip preserves the attached reference, prompt and retry identity', async () => {
    standalone.render.mockReset().mockRejectedValue(Object.assign(new Error('Image allowance exhausted'), { status: 402 }));
    goTo('?view=images');
    render(<App />);
    const prompt = await screen.findByLabelText(/Describe your image/, {}, SLOW);
    fireEvent.change(prompt, { target: { value: 'Use the ferry in my reference' } });
    fireEvent.change(screen.getByLabelText('Reference image files'), { target: { files: [new File(['example'], 'ferry.png', { type: 'image/png' })] } });
    await screen.findByRole('button', { name: 'Remove ferry.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Open API keys and usage' }));
    fireEvent.click(within(await screen.findByTestId('settings')).getByRole('button', { name: 'Back' }));
    expect(await screen.findByLabelText(/Describe your image/)).toHaveValue('Use the ferry in my reference');
    expect(screen.getByRole('button', { name: 'Remove ferry.png' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    await waitFor(() => expect(standalone.render).toHaveBeenCalledTimes(2));
    const [first, retry] = standalone.render.mock.calls;
    expect(first[4]).toEqual(expect.any(String));
    expect(retry.slice(0, 5)).toEqual(first.slice(0, 5));
  });

  it('All comics → Preferences → Back → All comics', async () => {
    projectsState.list = [project('p1', 'Salt Road', NOW)];
    goTo('?view=dashboard');
    render(<App />);
    await findTrigger();
    expect(screen.queryByLabelText(/Comic name/)).toBeNull();
    await openAccountRow('Preferences');
    expect(await screen.findByText('Settings at preferences')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await findTrigger();
    expect(screen.queryByLabelText(/Comic name/)).toBeNull();
    expect(screen.getAllByText('All comics').length).toBeGreaterThan(0);
  });

  it('a comic → API keys → Back → the same comic', async () => {
    projectsState.list = [project('p1', 'Salt Road', NOW), project('p2', 'Glass Harbour', NOW - 3_600_000)];
    goTo('?view=dashboard');
    render(<App />);
    await findTrigger();
    // The side panel's Your comics opens a comic.
    fireEvent.click(screen.getAllByRole('link', { name: /^Glass Harbour/ })[0]);
    expect(await screen.findByText('Studio open on p2', undefined, SLOW)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Your API keys' }));
    expect(await screen.findByText('Settings at settings')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Studio open on p2')).toBeInTheDocument();
  });

  it('a comic → Chat: App gives the studio’s side panel its Chat destination', async () => {
    projectsState.list = [project('p1', 'Salt Road', NOW)];
    goTo('?view=dashboard');
    render(<App />);
    await findTrigger();
    fireEvent.click(screen.getAllByRole('link', { name: /^Salt Road/ })[0]);
    const studio = await screen.findByTestId('studio', undefined, SLOW);
    fireEvent.click(within(studio).getByRole('button', { name: 'Chat' }));
    expect(await screen.findByText('Chat open', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByTestId('studio')).toBeNull();
  });

  it('a Settings deep link, signed in on the comics host, goes Back to My comics, and draws no suite header', async () => {
    projectsState.list = [project('p1', 'Salt Road', NOW)];
    goTo('?view=settings&tab=settings');
    render(<App />);
    expect(await screen.findByText('Settings at settings', undefined, SLOW)).toBeInTheDocument();
    // Settings keeps Comic Studio's look on the comics host: its own sticky header (with Back), not the main site's.
    expect(screen.queryByRole('banner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await findTrigger()).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('dashboard'));
  });

  it('a request made inside a Settings page reached by its address keeps Back pointing out of Settings', async () => {
    projectsState.list = [project('p1', 'Salt Road', NOW)];
    goTo('?view=settings&tab=settings');
    render(<App />);
    expect(await screen.findByText('Settings at settings', undefined, SLOW)).toBeInTheDocument();
    act(() => {
      requestAccountSettings('profile');
    });
    expect(await screen.findByText('Settings at profile')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await findTrigger()).toBeInTheDocument();
    expect(screen.queryByTestId('settings')).toBeNull();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('view')).toBe('dashboard'));
  });

  it('a request made inside Settings keeps the Back it had: All comics → Preferences → Profile → Back → All comics', async () => {
    projectsState.list = [project('p1', 'Salt Road', NOW)];
    goTo('?view=dashboard');
    render(<App />);
    await openAccountRow('Preferences');
    expect(await screen.findByText('Settings at preferences')).toBeInTheDocument();
    act(() => {
      requestAccountSettings('profile');
    });
    expect(await screen.findByText('Settings at profile')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await findTrigger();
    expect(screen.queryByTestId('settings')).toBeNull();
    expect(screen.getAllByText('All comics').length).toBeGreaterThan(0);
  });
});

describe('settingsBackTarget: where Back from Settings goes', () => {
  const base = { resume: null, hasActiveProject: false, comicsHost: true, signedIn: true } as const;
  it('returns to the view it left, resuming New comic only on the comics view it was asked for', () => {
    expect(settingsBackTarget({ ...base, returnView: 'dashboard', resume: 'new-comic' })).toEqual({ view: 'dashboard', newComic: true });
    expect(settingsBackTarget({ ...base, returnView: 'dashboard' })).toEqual({ view: 'dashboard', newComic: false });
    expect(settingsBackTarget({ ...base, returnView: 'comicstudio', hasActiveProject: true })).toEqual({ view: 'comicstudio', newComic: false });
    expect(settingsBackTarget({ ...base, returnView: 'comicstudio', hasActiveProject: true, resume: 'new-comic' })).toEqual({ view: 'comicstudio', newComic: false });
    expect(settingsBackTarget({ ...base, returnView: 'gallery' })).toEqual({ view: 'gallery', newComic: false });
  });

  it('a Settings page reached by its address returns to My comics on the comics host, home elsewhere', () => {
    expect(settingsBackTarget({ ...base, returnView: null })).toEqual({ view: 'dashboard', newComic: false });
    expect(settingsBackTarget({ ...base, returnView: null, comicsHost: false })).toEqual({ view: 'home', newComic: false });
    expect(settingsBackTarget({ ...base, returnView: null, signedIn: false })).toEqual({ view: 'home', newComic: false });
  });

  it('never returns to Settings itself: a return view of Settings reads as an address', () => {
    expect(settingsBackTarget({ ...base, returnView: 'settings' })).toEqual({ view: 'dashboard', newComic: false });
    expect(settingsBackTarget({ ...base, returnView: 'settings', resume: 'new-comic' })).toEqual({ view: 'dashboard', newComic: false });
    expect(settingsBackTarget({ ...base, returnView: 'settings', comicsHost: false })).toEqual({ view: 'home', newComic: false });
  });

  it('keeps the reader rule: a reader with no comic left goes to My comics', () => {
    expect(settingsBackTarget({ ...base, returnView: 'reader' })).toEqual({ view: 'dashboard', newComic: false });
    expect(settingsBackTarget({ ...base, returnView: 'reader', hasActiveProject: true })).toEqual({ view: 'reader', newComic: false });
  });
});

describe('App.tsx wiring', () => {
  const src = readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  it('one provider, one listener, one return path; the comics header has no account prop of its own', () => {
    expect(src).toContain('<AccountProvider value={account}>');
    expect(src).toContain('useAccountSettingsListener(');
    expect(src).toContain('settingsBackTarget(');
    expect(src).toMatch(/const showSharedHeader = chrome\.suiteHeader && /);
    const header = src.slice(src.indexOf('<ComicsHeader'), src.indexOf('/>', src.indexOf('<ComicsHeader')));
    expect(header).not.toContain('onOpenAccount');
    expect(ACCOUNT_SETTINGS_EVENT).toBe('ds:open-account-settings');
  });
});
