// The QA kit surface (qa/KitScenes.tsx) registers the Comic History scenes (H5 wave note 3): the layout harness reaches
// `?surface=kit&kit=history|history-sheets|history-states`, and each one mounts its History frames offline on the fake
// HistoryApi. A scene name the kit does not know is still refused (ComicQaApp throws on !isKitScene).

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { KIT_SCENES, KitSurface, isKitScene } from './KitScenes';
import { HISTORY_KIT_SCENES } from '../components/comicstudio/history/__scenes__/HistoryScenes';
import { clearQaOps, parseQaParams, qaOps } from '../components/comicstudio/testing/qaController';
import { FormFactorProvider, formFactorFor } from '../components/comicstudio/mobile/useFormFactor';
import { resetBackStack } from '../components/comicstudio/mobile/backStack';

const settle = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** The frames each History scene shows (HistoryScenes.tsx data-testids). */
const FRAMES: Record<(typeof HISTORY_KIT_SCENES)[number], string[]> = {
  history: ['kit-history-list', 'kit-history-moment', 'kit-history-compare'],
  'history-sheets': ['kit-history-sheets'],
  'history-states': ['kit-history-empty', 'kit-history-v4', 'kit-history-classic', 'kit-history-cards']
};

afterEach(() => {
  cleanup();
  resetBackStack();
});

describe('the kit surface knows the Comic History scenes', () => {
  it('history, history-sheets and history-states are kit scenes (the QA app accepts their URLs)', () => {
    expect(HISTORY_KIT_SCENES).toEqual(['history', 'history-sheets', 'history-states']);
    for (const scene of HISTORY_KIT_SCENES) {
      expect(KIT_SCENES).toContain(scene);
      expect(isKitScene(scene), scene).toBe(true);
    }
    // The earlier scenes keep their names and order; unknown names are still refused.
    expect(KIT_SCENES.slice(0, 7)).toEqual(['breakdown', 'refs', 'refs-drawer', 'timeline', 'art', 'model-picker', 'model-confirm']);
    expect(isKitScene('history-nope')).toBe(false);
  });

  it.each(HISTORY_KIT_SCENES)('KitSurface mounts the %s scene with its History frames, offline', async (scene) => {
    clearQaOps();
    const { container } = render(
      <FormFactorProvider value={formFactorFor({ w: 360, h: 740, coarse: true })}>
        <KitSurface params={parseQaParams(`?surface=kit&kit=${scene}&skin=atlas`)} scene={scene} />
      </FormFactorProvider>
    );
    await settle();
    expect(container.querySelector('main')?.getAttribute('data-kit')).toBe(scene);
    for (const id of FRAMES[scene]) expect(container.querySelector(`[data-testid="${id}"]`), `${scene}: ${id}`).not.toBeNull();
    // Only this scene's frames: no other History scene leaks in.
    const others = Object.entries(FRAMES)
      .filter(([s]) => s !== scene)
      .flatMap(([, ids]) => ids);
    for (const id of others) expect(container.querySelector(`[data-testid="${id}"]`), `${scene} shows ${id}`).toBeNull();
    // Looking is free: mounting a scene runs no history action.
    expect(qaOps().filter((op) => op.kind === 'act')).toEqual([]);
  });

  it('a non-History scene renders no History frame', async () => {
    const { container } = render(
      <FormFactorProvider value={formFactorFor({ w: 1440, h: 900, coarse: false })}>
        <KitSurface params={parseQaParams('?surface=kit&kit=art')} scene="art" />
      </FormFactorProvider>
    );
    await settle(2);
    expect(container.querySelector('[data-testid^="kit-history"]')).toBeNull();
    expect(container.querySelector('[data-testid="kit-presets"]')).not.toBeNull();
  });
});
