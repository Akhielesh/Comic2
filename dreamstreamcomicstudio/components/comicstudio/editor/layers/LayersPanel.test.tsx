// LayersPanel (PE-INSPECT; agent-editor plan §4 Wave 2 C-LAYERS): a click selects, a drag restacks through zOrderEdit,
// a drag to another panel emits line_move, the touch checkboxes multi-select, the lock toggles, the eye hides in this
// view only (no op), the director's presence shows, moves are announced; Alt+arrows are the non-drag path.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { makeSampleDoc } from '../../board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../../../shared/comic/lettering/layout';
import { LETTERING_ON_TOP_NOTE } from '../../../../shared/comic/pro/types';
import { resolvePlacements } from '../../lettering/useLetterPlans';
import type { PartPanelProps } from '../inspector/types';
import { LayersPanel, DIRECTOR_EDITING } from './LayersPanel';
import { clearViewHidden, viewHidden } from './viewHidden';
import * as layersPart from './index';
import * as inspectorPart from '../inspector/index';

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;

const mount = (ids: string[] = [], extra: Partial<PartPanelProps> = {}, mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const doc = makeSampleDoc(mutate);
  const page = doc.pages[0];
  const apply = vi.fn();
  const set = vi.fn();
  const props = {
    studio: {},
    doc,
    sourceDoc: doc,
    page,
    sourcePage: page,
    aspect: ASPECT,
    H,
    plans: planLettering(doc, page, ASPECT, estimateMeasure),
    placements: resolvePlacements(doc, page, ASPECT, estimateMeasure),
    selection: { ids, set, clear: vi.fn() },
    apply,
    onEditText: vi.fn(),
    mode: 'pro',
    layout: 'desktop',
    footer: '',
    ...extra
  } as unknown as PartPanelProps;
  const utils = render(<LayersPanel {...props} />);
  const row = (id: string) => utils.container.querySelector(`[data-row-id="${id}"]`) as HTMLElement;
  return { ...utils, apply, set, row, doc, page };
};

/** A drag the way a browser fires it (jsdom has no DataTransfer). */
const drag = (from: HTMLElement, to: HTMLElement) => {
  const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: 'none', dropEffect: 'none' };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
  fireEvent.dragEnd(from, { dataTransfer });
};

afterEach(() => clearViewHidden());

describe('LayersPanel', () => {
  it('is the part the shell mounts: ready, under the stub names', () => {
    expect(layersPart.part).toEqual({ id: 'layers', ready: true });
    expect(layersPart.Panel).toBe(LayersPanel);
    expect(inspectorPart.part).toEqual({ id: 'inspector', ready: true });
    expect(typeof inspectorPart.Panel).toBe('function');
  });

  it('every object is a labelled role=group row; the lettering band says it stays on top', () => {
    const { row } = mount();
    expect(screen.getByText(LETTERING_ON_TOP_NOTE)).toBeTruthy();
    const l3 = row('pg_1_l3');
    expect(l3.getAttribute('role')).toBe('group');
    expect(l3.getAttribute('aria-label')).toBe('Shout: “Thief!”, Vendor');
    expect(within(screen.getByRole('group', { name: 'Panel 3 lettering' })).getAllByRole('group').map((g) => g.getAttribute('data-row-id'))).toEqual(['pg_1_l3', 'pg_1_l4', 'pg_1_l5']);
    expect(screen.getByRole('group', { name: 'Panel 3' })).toBeTruthy();
  });

  it('a click selects; Shift-click adds or removes; the selected row is accent-soft with a 3 px ink edge', () => {
    const { row, set } = mount(['pg_1_l3']);
    fireEvent.click(row('pg_1_l1'));
    expect(set).toHaveBeenLastCalledWith(['pg_1_l1']);
    fireEvent.click(row('pg_1_l5'), { shiftKey: true });
    expect(set).toHaveBeenLastCalledWith(['pg_1_l3', 'pg_1_l5']);
    fireEvent.click(row('pg_1_l3'), { metaKey: true });
    expect(set).toHaveBeenLastCalledWith([]);
    expect(row('pg_1_l3').className).toContain('bg-[var(--ds-accent-soft)]');
    expect(row('pg_1_l3').className).toContain('shadow-[inset_3px_0_0_0_var(--ds-ink)]');
    expect(row('pg_1_l1').className).toContain('hover:bg-[var(--ds-overlay-hover)]');
  });

  it('the touch checkboxes multi-select (in reading order)', () => {
    const { set } = mount(['pg_1_l5']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Whisper: “Just one more…”' }));
    expect(set).toHaveBeenLastCalledWith(['pg_1_l2', 'pg_1_l5']);
    expect(screen.getByRole('checkbox', { name: 'Select Sound effect: “GRAB”' })).toHaveProperty('checked', true);
  });

  it('a drag onto another row of the panel restacks through zOrderEdit (one balloon {z} op, announced)', () => {
    const { row, apply } = mount();
    drag(row('pg_1_l3'), row('pg_1_l5'));
    expect(apply).toHaveBeenCalledTimes(1);
    const [ops, opts] = apply.mock.calls[0];
    expect(ops).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l3', patch: { z: 1 } }]);
    expect(opts.label).toMatch(/^Bring forward: /);
    expect(screen.getByTestId('layers-live').textContent).toMatch(/restacked/);
  });

  it('a drag onto another panel’s row or header moves the line there (line_move)', () => {
    const { row, apply } = mount();
    drag(row('pg_1_l4'), row('pg_1_l1'));
    expect(apply.mock.calls[0][0][0]).toEqual({ op: 'line_move', pageId: 'pg_1', id: 'pg_1_l4', toPanelId: 'pg_1_p1', index: 0 });
    expect(apply.mock.calls[0][1]).toEqual({ label: 'Move line to another panel' });
    const header = document.querySelector('[data-drop-panel="pg_1_p2"]') as HTMLElement;
    drag(row('pg_1_l3'), header);
    expect(apply.mock.calls[1][0][0]).toEqual({ op: 'line_move', pageId: 'pg_1', id: 'pg_1_l3', toPanelId: 'pg_1_p2', index: 1 });
    expect(screen.getByTestId('layers-live').textContent).toBe('Moved to panel 2');
  });

  it('Alt+↑/↓ restack and Alt+←/→ move panels without a drag (WCAG 2.5.7)', () => {
    const { row, apply } = mount();
    fireEvent.keyDown(row('pg_1_l3'), { key: 'ArrowUp', altKey: true });
    expect(apply.mock.calls[0][0]).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l3', patch: { z: 1 } }]);
    fireEvent.keyDown(row('pg_1_l3'), { key: 'ArrowLeft', altKey: true });
    expect(apply.mock.calls[1][0][0]).toMatchObject({ op: 'line_move', id: 'pg_1_l3', toPanelId: 'pg_1_p2' });
    fireEvent.keyDown(row('pg_1_l1'), { key: 'ArrowLeft', altKey: true });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('layers-live').textContent).toBe('Already in the first panel');
  });

  it('the lock toggles (balloon {locked}); the eye hides in this view only and sends no op', () => {
    const { apply } = mount();
    const l3 = screen.getByRole('group', { name: /^Shout/ });
    fireEvent.click(within(l3).getByRole('button', { name: 'Lock Shout: “Thief!”' }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0][0]).toMatchObject({ op: 'balloon', lineId: 'pg_1_l3', patch: { locked: true, pinned: true } });
    expect(apply.mock.calls[0][1]).toEqual({ label: 'Lock balloon' });
    const eye = within(l3).getByRole('button', { name: 'Hide Shout: “Thief!” in this view' });
    fireEvent.click(eye);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(viewHidden('pg_1').has('pg_1_l3')).toBe(true);
    expect(within(l3).getByRole('button', { name: 'Show Shout: “Thief!” in this view' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('layers-live').textContent).toMatch(/hidden in this view/);
  });

  it('a locked balloon unlocks; an overlay row locks through layer {locked}', () => {
    const { apply } = mount([], {}, (d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l1' ? { ...b, locked: true, pinned: true } : b));
      d.pages[0].layers = [{ id: 'ly_star', kind: 'shape', name: 'Star', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, shape: { type: 'rect', fill: '#ffffff', stroke: '#111111', strokeW: 0.003 } }];
    });
    fireEvent.click(screen.getByRole('button', { name: /^Unlock Caption/ }));
    expect(apply.mock.calls[0][0]).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1', patch: { locked: false } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Lock Star' }));
    expect(apply.mock.calls[1]).toEqual([[{ op: 'layer', pageId: 'pg_1', id: 'ly_star', patch: { locked: true } }], { label: 'Lock overlay' }]);
  });

  it('shows "Director is editing" on the rows the director is working on (StudioController.presence)', () => {
    mount([], { presence: { pageId: 'pg_1', lineIds: ['pg_1_l4'], label: 'Moving a balloon', at: 1 } });
    const badges = screen.getAllByTestId('director-editing');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe(DIRECTOR_EDITING);
    expect(badges[0].closest('[data-row-id]')?.getAttribute('data-row-id')).toBe('pg_1_l4');
  });

  it('in a translated edition, stacking, locks and panels wait for the original (no drag, no op)', () => {
    const { row, apply } = mount([], { editionLang: 'hi' });
    expect(row('pg_1_l3').getAttribute('draggable')).toBe('false');
    drag(row('pg_1_l3'), row('pg_1_l5'));
    fireEvent.keyDown(row('pg_1_l3'), { key: 'ArrowUp', altKey: true });
    expect(apply).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Lock Shout: “Thief!”' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('rows and their buttons are 44 px targets on touch', () => {
    const { row } = mount();
    expect(row('pg_1_l3').className).toContain('coarse:min-h-11');
    for (const b of within(row('pg_1_l3')).getAllByRole('button')) {
      expect(b.className).toContain('coarse:min-h-11');
      expect(b.className).toContain('coarse:min-w-11');
    }
    expect(within(row('pg_1_l3')).getByRole('checkbox').className).toContain('coarse:min-h-11');
  });
});
