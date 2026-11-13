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
import { LayersPanel, DIRECTOR_EDITING, EMPTY_PANEL_DROP_HINT, EMPTY_PANEL_HINT } from './LayersPanel';
import { applyOps } from '../../../../shared/comic/ops';
import { inverseOps } from '../../../../shared/comic/undo';
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
const drag = (from: HTMLElement, to: HTMLElement | (() => HTMLElement)) => {
  const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: 'none', dropEffect: 'none' };
  fireEvent.dragStart(from, { dataTransfer });
  const target = typeof to === 'function' ? to() : to;
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
  fireEvent.dragEnd(from, { dataTransfer });
};
const star = (id: string, name: string) => ({ id, kind: 'shape' as const, name, box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, shape: { type: 'rect' as const, fill: '#ffffff', stroke: '#111111', strokeW: 0.003 } });

afterEach(() => clearViewHidden());

describe('LayersPanel', () => {
  it('is the part the shell mounts: ready, a lazy loadPanel under the stub names — never a static Panel', async () => {
    expect(layersPart.part).toEqual({ id: 'layers', ready: true });
    expect(Object.keys(layersPart).sort()).toEqual(['loadPanel', 'part']);
    expect((await layersPart.loadPanel()).Panel).toBe(LayersPanel);
    expect(inspectorPart.part).toEqual({ id: 'inspector', ready: true });
    expect(Object.keys(inspectorPart).sort()).toEqual(['loadPanel', 'part']);
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

  it('a drag onto another panel’s row lands at that row’s place in it (line_move index)', () => {
    const { row, apply } = mount();
    drag(row('pg_1_l4'), row('pg_1_l2'));
    expect(apply.mock.calls[0][0][0]).toEqual({ op: 'line_move', pageId: 'pg_1', id: 'pg_1_l4', toPanelId: 'pg_1_p2', index: 0 });
    // Onto the second row of a three-line panel: second place.
    drag(row('pg_1_l1'), row('pg_1_l4'));
    expect(apply.mock.calls[1][0][0]).toEqual({ op: 'line_move', pageId: 'pg_1', id: 'pg_1_l1', toPanelId: 'pg_1_p3', index: 1 });
  });

  it('a panel with no lettering is still a group a line can be dragged into', () => {
    const { row, apply } = mount([], {}, (d) => {
      d.pages[0].panels[1].lines = [];
      d.pages[0].balloons = d.pages[0].balloons.filter((b) => b.lineId !== 'pg_1_l2');
    });
    const group = screen.getByRole('group', { name: 'Panel 2 lettering' });
    expect(within(group).getByText(EMPTY_PANEL_HINT)).toBeTruthy();
    drag(row('pg_1_l4'), () => {
      // While a line is dragged, the empty group says where it can go.
      const empty = document.querySelector('[data-drop-empty="pg_1_p2"]') as HTMLElement;
      expect(empty.textContent).toBe(EMPTY_PANEL_DROP_HINT);
      return empty;
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0][0]).toEqual({ op: 'line_move', pageId: 'pg_1', id: 'pg_1_l4', toPanelId: 'pg_1_p2', index: 0 });
    expect(screen.getByTestId('layers-live').textContent).toBe('Moved to panel 2');
    expect(within(group).getByText(EMPTY_PANEL_HINT)).toBeTruthy();
  });

  it('Alt+↑ on a line the software placed stores its whole drawn balloon with the new z (it never jumps)', () => {
    const { row, apply, doc, page } = mount();
    expect(page.balloons.some((b) => b.lineId === 'pg_1_l4')).toBe(false);
    fireEvent.keyDown(row('pg_1_l4'), { key: 'ArrowUp', altKey: true });
    const drawn = resolvePlacements(doc, page, ASPECT, estimateMeasure).balloons.get('pg_1_l4')!;
    expect(apply).toHaveBeenCalledTimes(1);
    const [op] = apply.mock.calls[0][0];
    expect(op).toMatchObject({ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l4', patch: { x: drawn.x, y: drawn.y, w: drawn.w } });
    expect(typeof op.patch.z).toBe('number');
  });

  it('overlay rows select through the shell’s selectLayers (click, Enter; Shift adds), and show the selection', () => {
    const selectLayers = vi.fn();
    const layers = [star('ly_star', 'Star'), star('ly_moon', 'Moon')];
    const { row, set } = mount([], { selectLayers, studio: { selection: { pageId: 'pg_1', lineIds: [], surface: 'page_editor', layerIds: ['ly_star'] } } as never }, (d) => {
      d.pages[0].layers = layers;
    });
    expect(row('ly_star').getAttribute('data-selected')).toBe('true');
    expect(row('ly_star').getAttribute('aria-label')).toBe('Star, selected');
    expect(row('ly_star').className).toContain('shadow-[inset_3px_0_0_0_var(--ds-ink)]');
    expect(row('ly_moon').getAttribute('tabindex')).toBe('0');
    fireEvent.click(row('ly_moon'));
    expect(selectLayers).toHaveBeenLastCalledWith(['ly_moon']);
    fireEvent.click(row('ly_moon'), { shiftKey: true });
    expect(selectLayers).toHaveBeenLastCalledWith(['ly_star', 'ly_moon']);
    fireEvent.keyDown(row('ly_star'), { key: 'Enter' });
    expect(selectLayers).toHaveBeenLastCalledWith(['ly_star']);
    expect(screen.getByTestId('layers-live').textContent).toBe('Star selected');
    // Its lock button still only locks (no selection change).
    fireEvent.click(within(row('ly_moon')).getByRole('button', { name: 'Lock Moon' }));
    expect(selectLayers).toHaveBeenCalledTimes(3);
    expect(set).not.toHaveBeenCalled();
  });

  it('arranges a selected overlay through reversible existing layer ops, without moving lettering', () => {
    const selectLayers = vi.fn();
    const { apply, doc, page } = mount([], { selectLayers, studio: { selection: { pageId: 'pg_1', lineIds: [], layerIds: ['ly_star'] } } as never }, (d) => {
      d.pages[0].layers = [star('ly_star', 'Star'), { ...star('ly_moon', 'Moon'), z: 4 }];
    });
    const arrange = screen.getByRole('region', { name: 'Arrange Star' });
    fireEvent.click(within(arrange).getByRole('button', { name: 'Bring forward' }));
    expect(apply).toHaveBeenCalledTimes(1);
    const [ops, opts] = apply.mock.calls[0];
    expect(opts.label).toBe('Bring forward: Star');
    const changed = applyOps(doc, ops);
    expect(changed.pages[0].layers!.find((layer) => layer.id === 'ly_star')!.z).toBe(5);
    expect(changed.pages[0].balloons).toEqual(page.balloons);
    expect(applyOps(changed, inverseOps(doc, ops), doc.updatedAt)).toEqual(doc);
    expect(selectLayers).not.toHaveBeenCalled();
    expect(screen.getByTestId('layers-live').textContent).toBe('Star: bring forward');
    for (const button of within(arrange).getAllByRole('button')) expect(button.className).toContain('coarse:min-h-11');
  });

  it('overlay keyboard stacking stays within its panel and supports front/back shortcuts', () => {
    const { row, apply } = mount([], { selectLayers: vi.fn() }, (d) => {
      d.pages[0].layers = [
        { ...star('ly_star', 'Star'), clip: 'pg_1_p1', z: 0 },
        { ...star('ly_moon', 'Moon'), clip: 'pg_1_p1', z: 4 },
        { ...star('ly_elsewhere', 'Elsewhere'), clip: 'pg_1_p2', z: 80 },
        { ...star('ly_page', 'Page overlay'), z: 90 }
      ];
    });
    fireEvent.keyDown(row('ly_star'), { key: 'ArrowUp', altKey: true });
    expect(apply.mock.calls[0][0]).toEqual([{ op: 'layer', pageId: 'pg_1', id: 'ly_star', patch: { z: 5 } }]);
    fireEvent.keyDown(row('ly_star'), { key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(apply.mock.calls[1][1].label).toBe('Bring to front: Star');
    expect(apply.mock.calls[1][0][0].patch.z).toBe(5);
    fireEvent.keyDown(row('ly_moon'), { key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(apply.mock.calls[2][1].label).toBe('Send to back: Moon');
    expect(apply.mock.calls[2][0][0].patch.z).toBe(-1);
  });

  it('locked overlays refuse both pointer and keyboard stacking, while view visibility remains usable', () => {
    const { row, apply } = mount([], { selectLayers: vi.fn(), studio: { selection: { pageId: 'pg_1', lineIds: [], layerIds: ['ly_star'] } } as never }, (d) => {
      d.pages[0].layers = [{ ...star('ly_star', 'Star'), locked: true }, star('ly_moon', 'Moon')];
    });
    const arrange = screen.getByRole('region', { name: 'Arrange Star' });
    for (const button of within(arrange).getAllByRole('button')) expect(button).toHaveProperty('disabled', true);
    fireEvent.keyDown(row('ly_star'), { key: 'ArrowUp', altKey: true });
    expect(screen.getByTestId('layers-live').textContent).toMatch(/locked/);
    fireEvent.click(within(row('ly_star')).getByRole('button', { name: 'Hide Star in this view' }));
    expect(viewHidden('pg_1').has('ly_star')).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it('translated editions cannot restack overlays', () => {
    const { row, apply } = mount([], { editionLang: 'hi', selectLayers: vi.fn(), studio: { selection: { pageId: 'pg_1', lineIds: [], layerIds: ['ly_star'] } } as never }, (d) => {
      d.pages[0].layers = [star('ly_star', 'Star')];
    });
    const arrange = screen.getByRole('region', { name: 'Arrange Star' });
    for (const button of within(arrange).getAllByRole('button')) expect(button).toHaveProperty('disabled', true);
    fireEvent.keyDown(row('ly_star'), { key: 'ArrowUp', altKey: true });
    expect(apply).not.toHaveBeenCalled();
  });

  it('without selectLayers (an older shell) overlay rows stay plain rows', () => {
    const { row } = mount([], {}, (d) => {
      d.pages[0].layers = [star('ly_star', 'Star')];
    });
    expect(row('ly_star').getAttribute('tabindex')).toBeNull();
    fireEvent.click(row('ly_star'));
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
    // On touch the row's 44 px controls take the room: the badge is the director's icon, its words for screen readers.
    expect(within(badges[0]).getByText(DIRECTOR_EDITING).className).toContain('coarse:sr-only');
    expect(badges[0].querySelector('svg')).toBeTruthy();
  });

  it('the badge is for this page only: the director editing the same line id on another page shows nothing here', () => {
    mount([], { presence: { pageId: 'pg_2', lineIds: ['pg_1_l4'], label: 'Moving a balloon', at: 1 } });
    expect(screen.queryByTestId('director-editing')).toBeNull();
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
