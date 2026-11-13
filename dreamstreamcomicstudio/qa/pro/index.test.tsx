// The Pro Edit QA surface (PE-SHELL fills the DS-1b stub): the index lists every scene and publishes
// window.__QA_PRO_SCENES__ for the layout smoke; each scene mounts the real page editor offline, with exactly one <main>.

import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { parseQaHarnessParams } from '../ComicQaApp';
import { QA_PRO_SCENES, QaProSurface, type QaProParams } from './index';
import { PRO_LETTERING_PRESET_IDS } from '../../shared/comic/lettering/style';
import { DIRECTOR_EDITING } from '../../components/comicstudio/editor/layers/LayersPanel';
import { PRO_EDIT_OPS_PATCHABLE } from '../../shared/comic/ops';

vi.mock('../../components/usage/useUsageAllowance', () => ({ useUsageAllowance: () => null }));

// The Pro view's pieces load lazily (editor/proLazy.ts); warm their modules once so each test waits on React, not on the
// first transform of a module.
beforeAll(async () => {
  await Promise.all([import('../../components/comicstudio/editor/ProWorkspace'), import('../../components/comicstudio/editor/ProTopBar'), import('../../components/comicstudio/editor/balloonTransform'), import('../../components/comicstudio/editor/proShapes'), import('../../components/comicstudio/editor/proNudge')]);
}, 30_000);

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});

const paramsFor = (search: string): QaProParams => ({ ...parseQaHarnessParams(search), surface: 'pro' }) as QaProParams;
const mount = async (scene: string | null) => {
  render(<QaProSurface params={paramsFor(`?surface=pro${scene ? `&scene=${scene}` : ''}&fixture=heist-12p`)} scene={scene} />);
  await act(async () => {
    await Promise.resolve();
  });
};

describe('the Pro Edit QA surface', () => {
  it('the index links every scene and publishes them for the smoke', async () => {
    await mount(null);
    expect(window.__QA_PRO_SCENES__?.map((s) => s.id)).toEqual([...QA_PRO_SCENES]);
    for (const id of QA_PRO_SCENES) expect(document.querySelector(`[data-qa-pro-scene-link="${id}"]`)).not.toBeNull();
    expect(document.querySelectorAll('main')).toHaveLength(1);
  });

  it('an unknown scene falls back to the index and says so', async () => {
    await mount('layers');
    expect(screen.getByText(/No Pro Edit scene named “layers”/)).toBeInTheDocument();
  });

  it('shell-pro mounts the editor in Pro with the rail and the switch on Pro', async () => {
    await mount('shell-pro');
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(await screen.findByTestId('pro-tool-rail')).toBeInTheDocument();
    const group = within(screen.getByTestId('editor-header')).getByRole('radiogroup', { name: 'Easy or Pro mode' });
    expect(within(group).getByRole('radio', { name: 'Pro mode' })).toHaveAttribute('aria-checked', 'true');
  });

  it('shell-pro-parts mounts the stand-in parts and the coach', async () => {
    await mount('shell-pro-parts');
    await waitFor(() => expect(document.querySelector('[data-qa-stub-part="Properties"]')).not.toBeNull());
    expect(await screen.findByTestId('pro-coach')).toBeInTheDocument();
  });

  it('shell-flag-off is today’s editor: no switch in the header', async () => {
    await mount('shell-flag-off');
    expect(within(screen.getByTestId('editor-header')).queryByRole('radiogroup', { name: 'Easy or Pro mode' })).toBeNull();
    expect(screen.queryByTestId('pro-tool-rail')).toBeNull();
  });
});

describe('the scenes the later Pro packages asked for (S2b integration)', () => {
  it('pro-inspector-docked: the real docked inspector with the first balloon selected; the switch stays off', async () => {
    expect(PRO_EDIT_OPS_PATCHABLE).toBe(false);
    await mount('pro-inspector-docked');
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(await screen.findByTestId('pro-tool-rail')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-testid="balloon-hit"][aria-pressed="true"]')).not.toBeNull());
    expect(document.querySelector('[data-qa-stub-part]')).toBeNull();
  });

  it('pro-inspector-empty: Pro with nothing selected', async () => {
    await mount('pro-inspector-empty');
    expect(await screen.findByTestId('pro-tool-rail')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="balloon-hit"][aria-pressed="true"]')).toBeNull();
  });

  it('pro-layers: the director badge on the first balloon’s row and an empty panel group', async () => {
    await mount('pro-layers');
    expect(await screen.findByTestId('pro-tool-rail')).toBeInTheDocument();
    const doc = window.__qaDoc?.();
    const page = doc?.pages[0];
    expect(page?.panels[page.panels.length - 1].lines).toEqual([]);
    expect(page?.panels.slice(0, -1).every((p) => p.lines.length > 0)).toBe(true);
    // The Layers part is lazy: its rows (and the badge) appear once it loads, wherever the layout docks it.
    await waitFor(() => expect(screen.getAllByText(DIRECTOR_EDITING).length).toBeGreaterThan(0), { timeout: 10_000 });
  }, 20_000);

  it('compose-panels: heist page 1 in frames with every overlay kind, editor and reader', async () => {
    await mount('compose-panels');
    expect(await screen.findByTestId('pro-tool-rail')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('g[data-layer-id]').length).toBeGreaterThanOrEqual(5));
    expect(document.querySelector('g[data-layer-id="ly_tone_in_panel"]')).not.toBeNull();
    cleanup();
    await mount('compose-panels-reader');
    expect(document.querySelectorAll('main')).toHaveLength(1);
    expect(screen.queryByTestId('pro-tool-rail')).toBeNull();
    await waitFor(() => expect(document.querySelectorAll('g[data-layer-id]').length).toBeGreaterThanOrEqual(5));
  });

  it('pro-looks: one reader page per Pro look', async () => {
    await mount('pro-looks');
    expect(document.querySelectorAll('main')).toHaveLength(1);
    const pages = [...document.querySelectorAll('[data-qa-pro-page]')].map((e) => e.getAttribute('data-qa-pro-page'));
    expect(pages).toEqual([...PRO_LETTERING_PRESET_IDS]);
    expect(document.querySelectorAll('h2')).toHaveLength(PRO_LETTERING_PRESET_IDS.length);
  });
});
