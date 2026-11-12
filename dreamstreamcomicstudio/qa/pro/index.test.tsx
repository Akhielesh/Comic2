// The Pro Edit QA surface (PE-SHELL fills the DS-1b stub): the index lists every scene and publishes
// window.__QA_PRO_SCENES__ for the layout smoke; each scene mounts the real page editor offline, with exactly one <main>.

import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { parseQaHarnessParams } from '../ComicQaApp';
import { QA_PRO_SCENES, QaProSurface, type QaProParams } from './index';

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
