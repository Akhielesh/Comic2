// The Pro switch OFF (the code default; S2b lead decision, collisions C-9): with PRO_EDIT_OPS_PATCHABLE false, no control
// that writes a new Pro field is rendered — the Pro text effects, shapes, SFX effects, fonts, looks and saved styles —
// and Paste style strips the Pro fields. Existing fields still write. A Pro font list and a Pro look list exist here
// (mocked), so their absence is the switch's doing, not an empty list's.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { makeSampleDoc } from '../../board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../../../shared/comic/lettering/layout';
import { PRO_EDIT_OPS_PATCHABLE } from '../../../../shared/comic/ops';
import { resolvePlacements } from '../../lettering/useLetterPlans';
import { LetteringInspector } from '../../lettering/LetteringInspector';
import { InspectorPanel } from './InspectorPanel';
import { proFieldsWritable, proLooks, writablePatch } from './proGate';
import { setStyleClip } from './styleClipboard';
import type { PartPanelProps } from './types';

vi.mock('../../../../shared/comic/lettering/proFonts', async (orig) => ({ ...(await orig<Record<string, unknown>>()), PRO_FONT_IDS: ['bungee'], PRO_FONT_ROLES: { bungee: 'Display, titles' } }));
vi.mock('../../../../shared/comic/lettering/style', async (orig) => {
  const m = await orig<typeof import('../../../../shared/comic/lettering/style')>();
  return {
    ...m,
    PRO_LETTERING_PRESET_IDS: ['shonen'],
    PRO_LETTERING_PRESETS: { shonen: { ...m.LETTERING_PRESETS.manga, id: 'shonen', name: 'Shonen', blurb: 'Big, loud manga action' } }
  };
});

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;

const inspector = (lineIds: string[], mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const doc = makeSampleDoc(mutate);
  const page = doc.pages[0];
  const apply = vi.fn();
  render(
    <LetteringInspector
      doc={doc}
      page={page}
      lineIds={lineIds}
      plans={planLettering(doc, page, ASPECT, estimateMeasure)}
      placements={resolvePlacements(doc, page, ASPECT, estimateMeasure)}
      H={H}
      apply={apply}
      onEditText={vi.fn()}
      onDeselect={vi.fn()}
      mode="pro"
      onModeChange={vi.fn()}
      canPro
      anchor={null}
      compact={false}
      onClose={vi.fn()}
      proEdit
      docked
    />
  );
  return { apply, doc };
};
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

describe('Pro controls with the switch off', () => {
  it('the switch is off in code, and the gate reads it', () => {
    expect(PRO_EDIT_OPS_PATCHABLE).toBe(false);
    expect(proFieldsWritable()).toBe(false);
    // The mocked look list is there; the switch alone keeps it out of the gallery.
    expect(proLooks().map((l) => l.id)).toEqual(['shonen']);
  });

  it('Text: no Pro text effects, no Pro SFX effects, no Pro fonts — the existing controls are all there', () => {
    inspector(['pg_1_l5']);
    expect(screen.queryByTestId('pro-text-effects')).toBeNull();
    expect(screen.queryByTestId('pro-sfx')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Sound effect style' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Font/ }));
    const list = screen.getByRole('listbox');
    expect(within(list).queryByText('Bungee')).toBeNull();
    expect(within(list).getByText('Comic Neue')).toBeTruthy();
  });

  it('Bubble: no Pro shapes; Apply: no saved styles; existing fields still write', () => {
    const { apply } = inspector(['pg_1_l4']);
    tab('Bubble');
    expect(screen.queryByTestId('pro-shapes')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Bubble shape' })).toBeTruthy();
    const border = screen.getByRole('spinbutton', { name: 'Border width' });
    fireEvent.change(border, { target: { value: '200' } });
    fireEvent.keyDown(border, { key: 'Enter' });
    expect(apply).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { borderWidth: 2 } }], { label: 'Border width' });
    tab('Apply');
    expect(screen.queryByTestId('named-styles')).toBeNull();
    expect(screen.getByTestId('style-clipboard')).toBeTruthy();
  });

  it('Paste style strips the Pro fields (and never links a saved style)', () => {
    setStyleClip({ from: 'pg_1_l3', patch: { fill: '#ffd84a', glow: { color: '#ffffff', size: 0.2 }, shape: 'heart' as never, font: 'bungee' as never }, styleId: 'st_v' });
    const { apply } = inspector(['pg_1_l4']);
    tab('Apply');
    fireEvent.click(screen.getByRole('button', { name: /Paste style/ }));
    expect(apply).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { fill: '#ffd84a' }, mode: 'replace' }], { label: 'Paste style' });
    expect(writablePatch({ strokes: [], warp: 'arc' })).toBeUndefined();
    setStyleClip(null);
  });

  it('the empty inspector shows the 8 base looks only and no saved styles', () => {
    const doc = makeSampleDoc();
    const page = doc.pages[0];
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
      selection: { ids: [], set: vi.fn(), clear: vi.fn() },
      apply: vi.fn(),
      onEditText: vi.fn(),
      mode: 'pro',
      layout: 'desktop',
      footer: ''
    } as unknown as PartPanelProps;
    render(<InspectorPanel {...props} />);
    expect(within(screen.getByRole('radiogroup', { name: 'Lettering style' })).getAllByRole('radio')).toHaveLength(8);
    expect(screen.queryByTestId('named-styles')).toBeNull();
  });
});
