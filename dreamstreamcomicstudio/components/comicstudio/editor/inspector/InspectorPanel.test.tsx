// InspectorPanel (PE-INSPECT): the docked Properties tab. Nothing selected: the comic's lettering style and the page's
// facts (never a blank column). A selection: the lettering inspector docked with Pro Edit on. In-art lettering: the
// honest note. A translated edition cannot change the comic-wide look.

import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { makeSampleDoc } from '../../board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../../../shared/comic/lettering/layout';
import { IN_ART_LETTERING_NOTE } from '../../../../shared/comic/pro/types';
import { resolvePlacements } from '../../lettering/useLetterPlans';
import { loadProExtras } from '../../lettering/pro/proExtras';
import { InspectorPanel, INSPECTOR_EMPTY_HINT, pageFacts } from './InspectorPanel';
import type { PartPanelProps } from './types';

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;

// The Pro parts are the lazily loaded Pro extras: load them once, so every render below is synchronous.
beforeAll(async () => {
  await loadProExtras();
});

const mount = (ids: string[], extra: Partial<PartPanelProps> = {}, mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const doc = makeSampleDoc(mutate);
  const page = doc.pages[0];
  const apply = vi.fn();
  const clear = vi.fn();
  const props = {
    studio: { setMode: vi.fn() },
    doc,
    sourceDoc: doc,
    page,
    sourcePage: page,
    aspect: ASPECT,
    H,
    plans: planLettering(doc, page, ASPECT, estimateMeasure),
    placements: resolvePlacements(doc, page, ASPECT, estimateMeasure),
    selection: { ids, set: vi.fn(), clear },
    apply,
    onEditText: vi.fn(),
    mode: 'pro',
    layout: 'desktop',
    footer: '',
    ...extra
  } as unknown as PartPanelProps;
  render(<InspectorPanel {...props} />);
  return { apply, clear, doc, page };
};

describe('the inspector part (the shell’s lazy mount contract, collisions B-16)', () => {
  it('index.ts exports the flag and a loadPanel, never a static Panel; loadPanel brings the panel and the Pro extras', async () => {
    const mod: Record<string, unknown> = await import('./index');
    expect(mod.part).toEqual({ id: 'inspector', ready: true });
    expect(mod.Panel).toBeUndefined();
    expect(Object.keys(mod).sort()).toEqual(['loadPanel', 'part']);
    const { Panel } = await (mod.loadPanel as () => Promise<{ Panel: unknown }>)();
    expect(Panel).toBe(InspectorPanel);
    const { proExtrasLoaded } = await import('../../lettering/pro/proExtras');
    expect(proExtrasLoaded()).toBeDefined();
  });
});

describe('InspectorPanel', () => {
  it('with nothing selected: the comic’s lettering style and the page’s facts', () => {
    const { apply, doc, page } = mount([]);
    const empty = screen.getByTestId('inspector-empty');
    expect(within(empty).getByRole('radiogroup', { name: 'Lettering style' })).toBeTruthy();
    const facts = pageFacts(doc, page);
    expect(facts.map((f) => f.label)).toEqual(['Page', 'Panels', 'Lines', 'Language', 'Lettering', 'Shape']);
    expect(facts.find((f) => f.label === 'Page')!.value).toBe(`1 of ${doc.pages.length}`);
    expect(facts.find((f) => f.label === 'Lines')!.value).toBe('5 · 4 with a set position');
    const list = within(empty).getByRole('region', { name: 'This page' });
    for (const f of facts) expect(within(list).getByText(f.value)).toBeTruthy();
    expect(within(empty).getByText(INSPECTOR_EMPTY_HINT)).toBeTruthy();
    fireEvent.click(within(empty).getByRole('radio', { name: /Manga/ }));
    expect(apply).toHaveBeenLastCalledWith([{ op: 'letter_style', patch: { presetId: 'manga', keepOverrides: false, auto: null } }], { label: 'Change lettering style' });
  });

  it('a translated edition shows the look but leaves it to the original', () => {
    const { apply } = mount([], { editionLang: 'hi' });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Lettering style' })).getByRole('radio', { name: /Manga/ }));
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByText(/belongs to the original language/)).toBeTruthy();
  });

  it('lettering drawn into the art: says so instead of offering looks', () => {
    mount([], {}, (d) => {
      d.format = { ...d.format, lettering: 'in_art' };
    });
    expect(screen.getByText(IN_ART_LETTERING_NOTE)).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Lettering style' })).toBeNull();
  });

  it('with a selection: the lettering inspector, docked, Pro Edit on (kind row, transform); Escape lets go', () => {
    const { clear } = mount(['pg_1_l3', 'nope']);
    const panel = screen.getByTestId('lettering-inspector');
    expect(panel.getAttribute('data-presentation')).toBe('docked');
    expect(within(panel).getByRole('radiogroup', { name: 'Balloon kind' })).toBeTruthy();
    expect(within(panel).getByTestId('transform-section')).toBeTruthy();
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
