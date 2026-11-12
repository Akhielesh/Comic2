// The Pro switch ON (flipped locally, as the lead will after D5): every new Pro lettering control renders and sends
// exactly its op — gradient, strokes (up to 3), glow, warp (or WARP_SCRIPT_NOTE for other scripts), the 6 Pro shapes,
// the 5 drawn Pro SFX effects, Pro fonts, the Pro looks and saved styles — and Paste style keeps Pro fields.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { makeSampleDoc } from '../../board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../../../shared/comic/lettering/layout';
import { resolveLetterStyle } from '../../../../shared/comic/lettering/style';
import { WARP_SCRIPT_NOTE } from '../../../../shared/comic/pro/types';
import { resolvePlacements } from '../../lettering/useLetterPlans';
import { LetteringInspector } from '../../lettering/LetteringInspector';
import { findLineRef } from '../../lettering/styleOps';
import { PRO_SHAPE_LABEL } from '../../lettering/ShapePicker';
import { PRO_SFX_LABEL } from '../../lettering/ProLetteringPanel';
import { InspectorPanel } from './InspectorPanel';
import { PRO_SFX_DRAWN, proFieldsWritable, writablePatch } from './proGate';
import type { PartPanelProps } from './types';

vi.mock('../../../../shared/comic/ops', async (orig) => ({ ...(await orig<Record<string, unknown>>()), PRO_EDIT_OPS_PATCHABLE: true }));
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
  return { apply, doc, page };
};
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const style = (lineIds: string[], patch: object) => [{ op: 'line_style', pageId: 'pg_1', lineIds, patch }];

describe('Pro controls with the switch on', () => {
  it('the gate is open', () => {
    expect(proFieldsWritable()).toBe(true);
    expect(writablePatch({ warp: 'arc' })).toEqual({ warp: 'arc' });
  });

  it('gradient fill, outlines (up to 3), glow and warp each send exactly their line_style op', () => {
    const { apply, doc, page } = inspector(['pg_1_l4']);
    const effects = screen.getByTestId('pro-text-effects');
    const ink = resolveLetterStyle(doc, findLineRef(page, 'pg_1_l4')!.line).textColor.slice(0, 7);
    fireEvent.click(within(effects).getByRole('switch', { name: 'Gradient fill' }));
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l4'], { fillGradient: { from: ink, to: '#e63946', angle: 90 } }), { label: 'Gradient fill' });
    fireEvent.click(within(effects).getByRole('button', { name: /Add outline/ }));
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l4'], { strokes: [{ color: '#ffffff', w: 0.08 }] }), { label: 'Add outline' });
    fireEvent.click(within(effects).getByRole('switch', { name: 'Glow' }));
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l4'], { glow: { color: '#ffd84a', size: 0.15 } }), { label: 'Glow' });
    fireEvent.click(within(effects).getByRole('radio', { name: 'Arc' }));
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l4'], { warp: 'arc', warpAmount: 0.5 }), { label: 'Warp' });
  });

  it('stored Pro values show and edit: at most 3 outlines, a typed glow size, a typed warp amount', () => {
    const { apply } = inspector(['pg_1_l4'], (d) => {
      d.pages[0].panels[2].lines[1].style = {
        strokes: [
          { color: '#ffffff', w: 0.08 },
          { color: '#111111', w: 0.14 },
          { color: '#e63946', w: 0.2 }
        ],
        glow: { color: '#ffd84a', size: 0.15 },
        warp: 'wave',
        warpAmount: 0.4
      };
    });
    const effects = screen.getByTestId('pro-text-effects');
    expect((within(effects).getByRole('button', { name: /Add outline/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(effects).getByRole('button', { name: 'Remove outline 2' }));
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l4'], { strokes: [{ color: '#ffffff', w: 0.08 }, { color: '#e63946', w: 0.2 }] }), { label: 'Remove outline' });
    const glow = within(effects).getByRole('spinbutton', { name: 'Glow size' });
    fireEvent.change(glow, { target: { value: '30' } });
    fireEvent.keyDown(glow, { key: 'Enter' });
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l4'], { glow: { color: '#ffd84a', size: 0.3 } }), { label: 'Glow size' });
    const amount = within(effects).getByRole('spinbutton', { name: 'Warp amount' });
    fireEvent.change(amount, { target: { value: '-80' } });
    fireEvent.keyDown(amount, { key: 'Enter' });
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l4'], { warpAmount: -0.8 }), { label: 'Warp amount' });
  });

  it('warp is offered only for scripts it shapes: a Hindi edition reads WARP_SCRIPT_NOTE instead', () => {
    inspector(['pg_1_l4'], (d) => {
      d.format = { ...d.format, language: 'hi' };
    });
    expect(screen.getByTestId('warp-script-note').textContent).toBe(WARP_SCRIPT_NOTE);
    expect(screen.queryByRole('radiogroup', { name: 'Warp' })).toBeNull();
  });

  it('the 6 Pro shapes send line_style {shape} (labels from the separate Pro map)', () => {
    const { apply } = inspector(['pg_1_l4']);
    tab('Bubble');
    const shapes = screen.getByRole('radiogroup', { name: 'Pro bubble shape' });
    expect(within(shapes).getAllByRole('radio').map((r) => r.getAttribute('title'))).toEqual(Object.values(PRO_SHAPE_LABEL));
    fireEvent.click(within(shapes).getByRole('radio', { name: /Heart/ }));
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l4'], { shape: 'heart' }), { label: 'Bubble shape' });
  });

  it('the 5 drawn Pro SFX effects send line_style {sfxEffect}; halftone waits for S3', () => {
    const { apply } = inspector(['pg_1_l5']);
    const sfx = screen.getByRole('radiogroup', { name: 'Pro sound effect style' });
    expect(within(sfx).getAllByRole('radio').map((r) => r.textContent)).toEqual(PRO_SFX_DRAWN.map((e) => PRO_SFX_LABEL[e]));
    expect(PRO_SFX_DRAWN).not.toContain('halftone_fill');
    fireEvent.click(within(sfx).getByRole('radio', { name: '3D extrude' }));
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l5'], { sfxEffect: 'extrude3d' }), { label: 'Sound effect style' });
  });

  it('Pro fonts (PRO_FONT_IDS) are listed after the base faces and write line_style {font}', () => {
    const { apply } = inspector(['pg_1_l4']);
    fireEvent.click(screen.getByRole('button', { name: /^Font/ }));
    const list = screen.getByRole('listbox');
    const names = within(list).getAllByRole('option').map((o) => o.textContent || '');
    expect(names[names.length - 1]).toMatch(/^BungeeDisplay, titles/);
    fireEvent.click(within(list).getByText('Bungee'));
    expect(apply).toHaveBeenLastCalledWith(style(['pg_1_l4'], { font: 'bungee' }), { label: 'Change font' });
  });

  it('saved styles show in Apply; "Save as style…" sends the save ops', () => {
    const { apply } = inspector(['pg_1_l3'], (d) => {
      d.pages[0].panels[2].lines[0].style = { fill: '#ffd84a' };
    });
    tab('Apply');
    const named = screen.getByTestId('named-styles');
    fireEvent.click(within(named).getByRole('button', { name: 'Save as style…' }));
    const name = within(named).getByRole('textbox', { name: 'Style name' }) as HTMLInputElement;
    expect(name.value).toBe('Vendor');
    fireEvent.change(name, { target: { value: 'Shouty' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    const [ops, opts] = apply.mock.calls[apply.mock.calls.length - 1];
    expect(opts).toEqual({ label: 'Save style “Shouty”' });
    const id = Object.keys(ops[0].patch.named)[0];
    expect(id).toMatch(/^st_/);
    expect(ops).toEqual([
      { op: 'letter_style', patch: { named: { [id]: { name: 'Shouty', patch: { fill: '#ffd84a' } } } } },
      { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: { styleId: id } },
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: null }
    ]);
  });

  it('the empty inspector offers the Pro looks (8 → 24) and the saved styles', () => {
    const doc = makeSampleDoc();
    const page = doc.pages[0];
    const apply = vi.fn();
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
      apply,
      onEditText: vi.fn(),
      mode: 'pro',
      layout: 'desktop',
      footer: ''
    } as unknown as PartPanelProps;
    render(<InspectorPanel {...props} />);
    const looks = screen.getByRole('radiogroup', { name: 'Lettering style' });
    expect(within(looks).getAllByRole('radio')).toHaveLength(9);
    fireEvent.click(within(looks).getByRole('radio', { name: /Shonen/ }));
    expect(apply).toHaveBeenLastCalledWith([{ op: 'letter_style', patch: { presetId: 'shonen', keepOverrides: false, auto: null } }], { label: 'Change lettering style' });
    expect(screen.getByTestId('named-styles')).toBeTruthy();
  });
});
