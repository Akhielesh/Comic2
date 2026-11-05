// The QA harness's History switch (wave 2b ig1 FIX wave note 4): `?surface=studio&history=1` turns Comic History on and
// answers it offline from the fake HistoryApi over the synthetic 'v5' history fixture, so the layout harness can open
// and measure the History panel with no backend. Without the param the studio is exactly as before: no History entry
// point, nobody answers an open request, nothing reads History.
//
// The app-wide surfaces (DS-1b, master plan §1.3): `?surface=app` mounts the scene index or one scene discovered by
// glob from qa/app/scenes (the scene contract lives in qa/app/index.tsx), honouring `theme=` and `skin=atlas|none`
// on <html>; `?surface=pro` mounts the Pro Edit placeholder. Every Comic Studio surface keeps its routing.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Any History read that escaped to the HTTP client would land here (the harness must never reach a backend).
const net = vi.hoisted(() => ({ get: vi.fn(async () => ({})), post: vi.fn(async () => ({})) }));
vi.mock('../services/apiClient', async (orig) => ({ ...(await orig<object>()), get: net.get, post: net.post }));

import { ComicQaApp, parseQaHarnessParams, qaBootState, QA_HARNESS_SURFACES } from './ComicQaApp';
import { APP_SCENES, applyQaAppLook, appSceneHref, collectAppScenes, QaAppSurface, type QaAppScene } from './app/index';
import { QA_PRO_SCENES } from './pro/index';
import { clearQaOps, parseQaParams, QA_SURFACES } from '../components/comicstudio/testing/qaController';
import { requestOpenHistory } from '../components/comicstudio/history/index';
import { resetBackStack } from '../components/comicstudio/mobile/backStack';

const settle = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  window.localStorage.clear();
  resetBackStack();
  clearQaOps();
  net.get.mockClear();
  net.post.mockClear();
});
afterEach(() => {
  cleanup();
  resetBackStack();
});

const historyReads = () => [...net.get.mock.calls, ...net.post.mock.calls].map((c) => String((c as unknown[])[0])).filter((u) => /history/i.test(u));

describe('?surface=studio&history=1', () => {
  it('shows the History entry and opens the panel on the fake v5 history, with no network', async () => {
    render(<ComicQaApp params={parseQaParams('?surface=studio&history=1')} />);
    await act(async () => {
      await settle();
    });
    const entry = document.querySelector('[data-history-entry="header"]') as HTMLButtonElement | null;
    expect(entry).not.toBeNull();
    fireEvent.click(entry!);
    await act(async () => {
      await settle(12);
    });
    // The fake's moments (historyFixture('v5')): a named draft and the AI revision are listed.
    expect(await screen.findAllByText('Draft 2')).not.toHaveLength(0);
    expect(screen.getAllByText(/AI revised pages 3–4/).length).toBeGreaterThan(0);
    expect(historyReads()).toEqual([]);
  });
});

describe('default QA (no history param) is unchanged', () => {
  it('no History entry point, and an open request is answered by nobody and reads nothing', async () => {
    render(<ComicQaApp params={parseQaParams('?surface=studio')} />);
    await act(async () => {
      await settle();
    });
    expect(document.querySelector('[data-history-entry]')).toBeNull();
    let handled = true;
    await act(async () => {
      handled = requestOpenHistory({ view: 'list' });
      await settle();
    });
    expect(handled).toBe(false);
    expect(document.querySelector('[data-history-sheet]')).toBeNull();
    expect(historyReads()).toEqual([]);
    expect(screen.queryByText('Draft 2')).toBeNull();
  });
});

// ── The app-wide surfaces (DS-1b) ────────────────────────────────────────────

const resetLook = () => {
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-ds-skin');
  document.documentElement.removeAttribute('data-qa-ready');
};

/** A fake scene module, as `import.meta.glob(…, { eager: true })` returns one. */
const fakeScene = (id: unknown, extra: Partial<Record<'title' | 'Scene', unknown>> = {}) => ({
  default: {
    id,
    title: `Fake ${String(id)}`,
    Scene: () => (
      <main aria-label={`Fake ${String(id)}`}>
        <p data-testid={`fake-${String(id)}`}>fake scene body</p>
      </main>
    ),
    ...extra
  }
});

describe('harness params: the app-wide surfaces on top of the Comic Studio ones', () => {
  it('parses surface=app|pro with scene and skin; every Comic Studio surface parses exactly as parseQaParams', () => {
    expect(QA_HARNESS_SURFACES).toEqual([...QA_SURFACES, 'app', 'pro']);
    expect(parseQaHarnessParams('?surface=app&scene=recipes&theme=dark&skin=atlas')).toMatchObject({ surface: 'app', scene: 'recipes', theme: 'dark', skin: 'atlas' });
    expect(parseQaHarnessParams('?surface=app&skin=none')).toMatchObject({ surface: 'app', scene: null, theme: 'light', skin: 'none' });
    expect(parseQaHarnessParams('?surface=pro&scene=layers')).toMatchObject({ surface: 'pro', scene: 'layers', skin: null });
    expect(parseQaHarnessParams('?surface=app&skin=fun').skin).toBeNull();
    // Unknown surfaces still fall back to the studio; the studio params are untouched.
    expect(parseQaHarnessParams('?surface=nope').surface).toBe('studio');
    for (const search of ['?surface=kit&kit=art&theme=dark', '?surface=editor&fixture=stress&page=2&mode=pro', '?surface=public&public=not-found&download=0']) {
      const { scene, skin, ...rest } = parseQaHarnessParams(search);
      expect(rest, search).toEqual(parseQaParams(search));
      expect(scene).toBeNull();
      expect(skin).toBeNull();
    }
  });
});

describe('boot state (what boot() puts on <html> and window per URL)', () => {
  it('window.__qa describes a comic fixture: set for the Comic Studio surfaces, never for the app-wide ones', () => {
    for (const search of ['?surface=app', '?surface=app&scene=recipes&theme=dark', '?surface=pro&scene=layers&fixture=stress']) {
      expect(qaBootState(parseQaHarnessParams(search)).qa, search).toBeUndefined();
    }
    const studio = qaBootState(parseQaHarnessParams('?surface=studio&fixture=heist-12p'));
    expect(studio.qa).toMatchObject({ ready: false, params: { surface: 'studio', fixture: 'heist-12p' } });
    expect(studio.qa!.pageCount).toBeGreaterThan(0);
    expect(studio.qa!.pageIds).toHaveLength(studio.qa!.pageCount);
    expect(qaBootState(parseQaHarnessParams('?surface=kit&kit=art')).qa?.params.surface).toBe('kit');
    // A loading studio has no doc yet: __qa is still there, with no pages.
    expect(qaBootState(parseQaHarnessParams('?surface=studio&state=loading')).qa).toMatchObject({ pageCount: 0, pageIds: [] });
  });

  it('skin=atlas boots the page-level skin on every surface; theme and still map to <html>', () => {
    expect(qaBootState(parseQaHarnessParams('?surface=app&skin=atlas'))).toMatchObject({ atlasSkin: true, dark: false });
    expect(qaBootState(parseQaHarnessParams('?surface=studio&skin=atlas&theme=dark&still=1'))).toMatchObject({ atlasSkin: true, dark: true, still: true });
    expect(qaBootState(parseQaHarnessParams('?surface=app&skin=none')).atlasSkin).toBe(false);
    expect(qaBootState(parseQaHarnessParams('?surface=studio')).atlasSkin).toBe(false);
  });
});

describe('scene discovery (qa/app/scenes, the scene contract)', () => {
  it('lists valid fake scene modules sorted by id and refuses every contract break with a reason', () => {
    const index = collectAppScenes({
      './scenes/zeta.tsx': fakeScene('zeta'),
      './scenes/alpha.tsx': fakeScene('alpha'),
      './scenes/mismatch.tsx': fakeScene('other'),
      './scenes/untitled.tsx': fakeScene('untitled', { title: '   ' }),
      './scenes/noscene.tsx': fakeScene('noscene', { Scene: 'not a component' }),
      './scenes/nodefault.tsx': { named: true },
      './scenes/Bad_Name.tsx': fakeScene('Bad_Name'),
      './elsewhere/x.tsx': fakeScene('x')
    });
    expect(index.scenes.map((s) => s.id)).toEqual(['alpha', 'zeta']);
    expect(index.scenes[0].title).toBe('Fake alpha');
    const reasons = Object.fromEntries(index.problems.map((p) => [p.file, p.reason]));
    expect(Object.keys(reasons).sort()).toEqual(['./elsewhere/x.tsx', './scenes/Bad_Name.tsx', './scenes/mismatch.tsx', './scenes/nodefault.tsx', './scenes/noscene.tsx', './scenes/untitled.tsx']);
    expect(reasons['./scenes/mismatch.tsx']).toMatch(/must equal the file name "mismatch"/);
    expect(reasons['./scenes/untitled.tsx']).toMatch(/title/);
    expect(reasons['./scenes/noscene.tsx']).toMatch(/React component/);
    expect(reasons['./scenes/nodefault.tsx']).toMatch(/default export/);
    expect(reasons['./scenes/Bad_Name.tsx']).toMatch(/kebab-case/);
  });

  it('accepts memo / forwardRef components and refuses a duplicate id', () => {
    const Memo = React.memo(() => <main />);
    const index = collectAppScenes({ './scenes/memo.tsx': fakeScene('memo', { Scene: Memo }), 'qa/app/scenes/memo.tsx': fakeScene('memo') });
    expect(index.scenes.map((s) => s.id)).toEqual(['memo']);
    expect(index.problems.map((p) => p.reason)).toEqual(['duplicate id "memo"']);
  });

  it('the real glob finds the recipes scene, and every scene file in qa/app/scenes keeps the contract', () => {
    expect(APP_SCENES.problems).toEqual([]);
    const ids = APP_SCENES.scenes.map((s) => s.id);
    expect(ids).toContain('recipes');
    expect(ids).toEqual([...ids].sort());
  });
});

describe('?surface=app', () => {
  beforeEach(resetLook);
  afterEach(resetLook);

  it('without a scene: the index links every discovered scene (keeping the look) and publishes the list for the smoke', async () => {
    render(<ComicQaApp params={parseQaHarnessParams('?surface=app&theme=dark&skin=atlas')} />);
    await act(async () => {
      await settle();
    });
    const index = document.querySelector('main[data-qa-app-index]');
    expect(index).not.toBeNull();
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-qa-app-scene-link]'));
    expect(links.map((a) => a.getAttribute('data-qa-app-scene-link'))).toEqual(APP_SCENES.scenes.map((s) => s.id));
    const recipes = links.find((a) => a.getAttribute('data-qa-app-scene-link') === 'recipes')!;
    expect(new URLSearchParams(recipes.getAttribute('href')!.slice(1)).toString()).toBe('surface=app&scene=recipes&theme=dark&skin=atlas');
    expect(window.__QA_APP_SCENES__).toEqual(APP_SCENES.scenes.map(({ id, title }) => ({ id, title })));
    expect(window.__QA_APP_SCENE_PROBLEMS__).toEqual([]);
    expect(document.querySelectorAll('[data-qa-crash]')).toHaveLength(0);
  });

  it('?scene=recipes mounts the scene as a whole page (one <main>), dark and under the Atlas skin, and marks the page ready', async () => {
    const { unmount } = render(<ComicQaApp params={parseQaHarnessParams('?surface=app&scene=recipes&theme=dark&skin=atlas')} />);
    await act(async () => {
      await settle(12);
    });
    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.getAttribute('data-ds-skin')).toBe('atlas');
    expect(document.querySelector('[data-qa-app-scene="recipes"]')).not.toBeNull();
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/shared recipes/i);
    for (const block of ['actions', 'fields', 'segmented', 'labels', 'surfaces', 'navigation']) expect(document.querySelector(`[data-qa-recipe="${block}"]`), block).not.toBeNull();
    // The scene is live: the segmented radios switch, the toast dismisses.
    fireEvent.click(screen.getByRole('radio', { name: 'Pro' }));
    expect(screen.getByRole('radio', { name: 'Pro' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Easy' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    // Every id is unique, so each <label for> and aria-labelledby names its own element (the scene is the model later ones copy).
    const ids = Array.from(document.querySelectorAll('[id]'), (e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect((screen.getByLabelText('Comic title') as HTMLInputElement).value).toBe('The Lake at Night');
    expect(screen.getByRole('main').getAttribute('aria-labelledby')).toBe(screen.getByRole('heading', { level: 1 }).id);
    await waitFor(() => expect(root.hasAttribute('data-qa-ready')).toBe(true));
    // Leaving restores <html> as it was (the look is the surface's, not a leak into the next mount).
    unmount();
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.hasAttribute('data-ds-skin')).toBe(false);
    expect(window.__QA_APP_SCENES__).toBeUndefined();
  });

  it('every discovered scene is a whole page: mounted by the harness as it ships, each brings exactly one <main>', () => {
    // The harness wraps a scene in no landmark (QaAppSurface), so a scene without its own <main> fails the smoke's
    // landmarks check, and one that nests a second fails it too.
    expect(APP_SCENES.scenes.length).toBeGreaterThan(1);
    for (const { id } of APP_SCENES.scenes) {
      const { container, unmount } = render(<QaAppSurface scene={id} theme="light" skin={null} />);
      expect(container.querySelectorAll('main'), id).toHaveLength(1);
      unmount();
    }
  });

  it('skin=none takes the skin off <html>; light takes .dark off; no skin param leaves the boot default', () => {
    const root = document.documentElement;
    root.classList.add('dark');
    root.setAttribute('data-ds-skin', 'atlas');
    const restore = applyQaAppLook(document, { theme: 'light', skin: 'none' });
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.hasAttribute('data-ds-skin')).toBe(false);
    restore();
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.getAttribute('data-ds-skin')).toBe('atlas');
    const keep = applyQaAppLook(document, { theme: 'dark', skin: null });
    expect(root.getAttribute('data-ds-skin')).toBe('atlas');
    keep();
    expect(appSceneHref('recipes', { theme: 'light', skin: null })).toBe('?surface=app&scene=recipes');
    expect(appSceneHref('recipes', { theme: 'dark', skin: 'none' })).toBe('?surface=app&scene=recipes&theme=dark&skin=none');
  });

  it('an unknown scene is a crash the harness reports (data-qa-crash), never a blank page', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ComicQaApp params={parseQaHarnessParams('?surface=app&scene=nope')} />);
    await act(async () => {
      await settle();
    });
    const crash = document.querySelector('[data-qa-crash]');
    expect(crash?.getAttribute('data-qa-crash')).toMatch(/^Unknown app scene "nope" \(one of .*recipes/);
    err.mockRestore();
  });

  it('mounts a fake scene module through discovery, and lists contract breaks on the index', async () => {
    const index = collectAppScenes({ './scenes/fake.tsx': fakeScene('fake'), './scenes/broken.tsx': fakeScene('wrong') });
    const { unmount } = render(<QaAppSurface scene="fake" theme="light" skin={null} index={index} />);
    expect(screen.getByTestId('fake-fake').textContent).toBe('fake scene body');
    expect(document.querySelector('[data-qa-app-scene="fake"]')).not.toBeNull();
    expect(window.__QA_APP_SCENES__).toEqual([{ id: 'fake', title: 'Fake fake' }]);
    expect(window.__QA_APP_SCENE_PROBLEMS__).toEqual([{ file: './scenes/broken.tsx', reason: expect.stringMatching(/must equal the file name "broken"/) }]);
    unmount();
    render(<QaAppSurface scene={null} theme="light" skin={null} index={index} />);
    expect(Array.from(document.querySelectorAll('a[data-qa-app-scene-link]')).map((a) => a.getAttribute('href'))).toEqual(['?surface=app&scene=fake']);
    expect(screen.getByRole('alert').textContent).toMatch(/One scene file breaks the contract/);
    expect(document.querySelector('[data-qa-app-problem="./scenes/broken.tsx"]')).not.toBeNull();
  });

  it('a scene typed against the contract type-checks as a glob module', () => {
    const scene: QaAppScene = { id: 'typed', title: 'Typed', Scene: () => <main /> };
    expect(collectAppScenes({ './scenes/typed.tsx': { default: scene } }).scenes).toHaveLength(1);
  });
});

describe('?surface=pro (Program 2 placeholder) and the Comic Studio surfaces', () => {
  beforeEach(resetLook);
  afterEach(resetLook);

  it('mounts the Pro Edit placeholder, named and ready, with no scenes registered yet', async () => {
    render(<ComicQaApp params={parseQaHarnessParams('?surface=pro&scene=layers')} />);
    await act(async () => {
      await settle();
    });
    expect(QA_PRO_SCENES).toEqual([]);
    const main = document.querySelector('main[data-qa-pro="placeholder"]');
    expect(main).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Pro Edit scenes');
    expect(main?.textContent).toMatch(/No Pro Edit scene named "layers" yet/);
    // The placeholder is told the surface it runs on (Pro scenes may branch on params.surface).
    expect(main?.getAttribute('data-qa-surface')).toBe('pro');
    await waitFor(() => expect(document.documentElement.hasAttribute('data-qa-ready')).toBe(true));
  });

  it('the kit surface still routes through the harness params (art scene)', async () => {
    render(<ComicQaApp params={parseQaHarnessParams('?surface=kit&kit=art')} />);
    await act(async () => {
      await settle(2);
    });
    expect(document.querySelector('main[data-kit="art"]')).not.toBeNull();
    expect(document.querySelector('[data-qa-app-index]')).toBeNull();
  });
});
