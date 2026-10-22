import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BalloonLayer, dragSlopPx } from './BalloonLayer';
import { makeSampleDoc } from './__fixtures__/sampleDoc';
import type { ComicDoc } from '../../../shared/comic/doc';
import { applyOps } from '../../../shared/comic/ops';
import { inverseOps } from '../../../shared/comic/undo';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import { SNAP_PANEL_PAD } from '../lettering/SnapGuides';

const setup = (props: Partial<React.ComponentProps<typeof BalloonLayer>> = {}, doc: ComicDoc = makeSampleDoc()) => {
  const page = doc.pages[0];
  const onBalloonChange = vi.fn();
  const utils = render(
    <div style={{ position: 'relative', width: 600, height: 900 }}>
      <BalloonLayer doc={doc} page={page} pageWidth={600} pageHeight={900} onBalloonChange={onBalloonChange} {...props} />
    </div>
  );
  /** The drawn balloon (SVG group). */
  const drawn = (lineId: string) => utils.container.querySelector<SVGGElement>(`[data-testid="balloon"][data-line-id="${lineId}"]`)!;
  /** The editable hit target (HTML). */
  const hit = (lineId: string) => utils.container.querySelector<HTMLElement>(`[data-testid="balloon-hit"][data-line-id="${lineId}"]`)!;
  return { ...utils, doc, page, onBalloonChange, drawn, hit };
};

const drag = (el: Element, from: [number, number], to: [number, number], opts: { altKey?: boolean; pointerType?: string } = {}) => {
  fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1], button: 0, pointerType: opts.pointerType ?? 'mouse' });
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1], altKey: opts.altKey });
  fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] });
};

describe('BalloonLayer — drawing (shared plans → one SVG)', () => {
  it('letters every line, uppercase, as one SVG over the art', () => {
    const { container, drawn } = setup();
    expect(container.querySelectorAll('[data-testid="lettering-svg"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="balloon"]')).toHaveLength(5);
    const text = (id: string) => [...drawn(id).querySelectorAll('text')].map((t) => t.textContent).join(' ').replace(/\s+/g, ' ').trim();
    expect(text('pg_1_l1')).toBe('OLD DELHI. BEFORE THE HEAT.');
    expect(text('pg_1_l4')).toBe('YOU OWE ME AN EXPLANATION, MAYA.');
    expect(drawn('pg_1_l1').getAttribute('aria-label')).toBe('Caption: Old Delhi. Before the heat.');
    expect(drawn('pg_1_l4').getAttribute('aria-label')).toBe('Speech — Arjun: You owe me an explanation, Maya.');
  });

  it('sizes text in page units (1.7 % of the page width × kind scale)', () => {
    const { drawn } = setup();
    const size = (id: string) => Number(drawn(id).querySelector('text')!.getAttribute('font-size'));
    expect(size('pg_1_l4')).toBeCloseTo(17, 1);
    expect(size('pg_1_l2')).toBeCloseTo(17 * 0.94, 1); // whisper
    expect(drawn('pg_1_l1').querySelector('text')!.getAttribute('font-family')).toContain('DSL Comic Neue');
    expect(drawn('pg_1_l5').querySelector('text')!.getAttribute('font-family')).toContain('DSL Bangers');
  });

  it('draws outlines by kind: tails for speech, a dashed whisper, a caption box, an outlined SFX', () => {
    const { drawn } = setup();
    // whisper: tail fat stroke (dashed), body (dashed), tail fill over the edge
    const whisperPaths = drawn('pg_1_l2').querySelectorAll('path');
    expect(whisperPaths.length).toBe(3);
    expect(whisperPaths[0].getAttribute('stroke-dasharray')).toBeTruthy();
    expect(Number(whisperPaths[0].getAttribute('stroke-width'))).toBeCloseTo(2 * Number(whisperPaths[1].getAttribute('stroke-width')), 3);
    // caption: a single box, warm fill
    const captionPaths = drawn('pg_1_l1').querySelectorAll('path');
    expect(captionPaths.length).toBe(1);
    expect(captionPaths[0].getAttribute('fill')).toBe('#fff6c8');
    // sfx: no balloon, text with a dark outline under the fill
    expect(drawn('pg_1_l5').querySelectorAll('path').length).toBe(0);
    const sfxText = [...drawn('pg_1_l5').querySelectorAll('text')].find((t) => t.getAttribute('paint-order') === 'stroke')!;
    expect(sfxText.getAttribute('stroke')).toBe('#111111');
  });

  it('keeps every stroke at least 1.25 px on a small page', () => {
    const doc = makeSampleDoc();
    const { container } = render(<BalloonLayer doc={doc} page={doc.pages[0]} pageWidth={200} pageHeight={300} />);
    const body = container.querySelector('[data-line-id="pg_1_l4"] path:nth-of-type(2)') ?? container.querySelector('[data-line-id="pg_1_l4"] path')!;
    // 1.25 px on a 200 px page = 6.25 page units (the classic 2.8 u would be 0.56 px).
    expect(Number(body.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(6.25 - 1e-6);
  });

  it('is inert (no buttons) when not editable', () => {
    setup();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('hides lettering from assistive tech when the reader asks, and fades balloons not in visibleLineIds', () => {
    const { container, drawn } = setup({ ariaHidden: true, visibleLineIds: new Set(['pg_1_l1']) });
    expect(container.querySelector('[data-testid="lettering-svg"]')).toHaveAttribute('aria-hidden', 'true');
    expect(drawn('pg_1_l1').getAttribute('opacity')).toBeNull();
    expect(drawn('pg_1_l2').getAttribute('opacity')).toBe('0');
  });

  it('never draws an outline past the page edge (render-time fit; stored values untouched)', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].balloons[0] = { lineId: 'pg_1_l1', x: 0.7904, y: 0.04, w: 0.2096, pinned: true }; // right edge exactly 1.0 (owner's doc)
    });
    const { hit } = setup({ editable: true }, doc);
    const el = hit('pg_1_l1');
    const right = parseFloat(el.style.left) + parseFloat(el.style.width);
    expect(right).toBeLessThanOrEqual(100 - 0.8 + 1e-6);
    expect(doc.pages[0].balloons[0].x).toBe(0.7904);
  });
});

describe('BalloonLayer — editing', () => {
  it('places lines that have no balloon (fallback) so no text is lost', () => {
    const { hit, drawn } = setup({ editable: true });
    expect(drawn('pg_1_l4')).toBeTruthy();
    expect(hit('pg_1_l4').dataset.fallback).toBe('true');
  });

  it('drags a balloon and reports the new position as pinned (Alt: no snapping)', () => {
    const { hit, onBalloonChange } = setup({ editable: true });
    drag(hit('pg_1_l2'), [100, 100], [160, 190], { altKey: true });
    expect(onBalloonChange).toHaveBeenCalledTimes(1);
    const [lineId, patch] = onBalloonChange.mock.calls[0];
    expect(lineId).toBe('pg_1_l2');
    expect(patch.pinned).toBe(true);
    expect(patch.x).toBeCloseTo(0.06 + 60 / 600, 4);
    expect(patch.y).toBeCloseTo(0.5 + 90 / 900, 4);
  });

  it('dragging a fallback balloon sends the FULL balloon: width and tail survive (bug regression)', () => {
    const { hit, onBalloonChange } = setup({ editable: true });
    drag(hit('pg_1_l4'), [300, 600], [310, 610], { altKey: true });
    const [lineId, patch] = onBalloonChange.mock.calls[0];
    expect(lineId).toBe('pg_1_l4');
    expect(patch.w).toBeGreaterThan(0.1);
    expect(patch.w).not.toBe(0.28);
    expect(typeof patch.tailX).toBe('number');
    expect(typeof patch.tailY).toBe('number');
    expect(patch.pinned).toBe(true);
  });

  it('keyboard nudges of a fallback balloon also send the full balloon', () => {
    const { hit, onBalloonChange } = setup({ editable: true });
    fireEvent.keyDown(hit('pg_1_l4'), { key: 'ArrowLeft' });
    const [, patch] = onBalloonChange.mock.calls[0];
    expect(Object.keys(patch).sort()).toEqual(expect.arrayContaining(['pinned', 'tailX', 'tailY', 'w', 'x', 'y']));
  });

  it('treats a click without movement as selection, not a move', () => {
    const { hit, onBalloonChange } = setup({ editable: true });
    const el = hit('pg_1_l2');
    fireEvent.pointerDown(el, { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { clientX: 101, clientY: 100 });
    expect(onBalloonChange).not.toHaveBeenCalled();
    expect(hit('pg_1_l2')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps a dragged balloon’s OUTLINE inside the safe area; Alt allows bleed down to the page margin', () => {
    const { hit, onBalloonChange } = setup({ editable: true });
    drag(hit('pg_1_l1'), [10, 10], [-500, -500]);
    // caption rect: no bleed; safe margin 0.03 of the width = 0.02 of the height on a 2:3 page
    expect(onBalloonChange).toHaveBeenLastCalledWith('pg_1_l1', { x: 0.03, y: 0.02, pinned: true });
    drag(hit('pg_1_l1'), [10, 10], [-500, -500], { altKey: true });
    const [, patch] = onBalloonChange.mock.calls[1];
    expect(patch.x).toBeCloseTo(0.008, 4);
  });

  it('snaps to guides within 6 px and shows them while dragging', () => {
    const { hit, container, onBalloonChange } = setup({ editable: true });
    const el = hit('pg_1_l1');
    fireEvent.pointerDown(el, { clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' });
    // outline left at 0.04 → moved 4 px (0.0333): the panel's inner edge (+ padding) is the nearest guide
    const innerEdge = panelBoxesFor(makeSampleDoc(), makeSampleDoc().pages[0])[0].x + SNAP_PANEL_PAD;
    fireEvent.pointerMove(window, { clientX: 6, clientY: 10 });
    expect(container.querySelector('[data-testid="snap-guides"]')).toBeTruthy();
    fireEvent.pointerUp(window, { clientX: 6, clientY: 10 });
    expect(onBalloonChange.mock.calls[0][1].x).toBeCloseTo(innerEdge, 4);
  });

  it('aims the tail with its handle', () => {
    const { hit, container, onBalloonChange } = setup({ editable: true, selectedLineId: 'pg_1_l2' });
    expect(hit('pg_1_l2')).toBeTruthy();
    const handle = container.querySelector<HTMLElement>('[data-testid="tail-handle"]')!;
    expect(handle).toHaveAttribute('role', 'slider');
    drag(handle, [0, 0], [30, -45]);
    const [, patch] = onBalloonChange.mock.calls[0];
    expect(patch).toEqual({ tailX: 0.25, tailY: 0.65, pinned: true });
  });

  it('resizes with the width grip', () => {
    const { container, onBalloonChange } = setup({ editable: true, selectedLineId: 'pg_1_l2' });
    const grip = container.querySelector<HTMLElement>('[data-testid="width-handle"]')!;
    drag(grip, [0, 0], [60, 0]);
    expect(onBalloonChange.mock.calls[0][1]).toEqual({ w: 0.32, pinned: true });
  });

  it('nudges with arrow keys (Shift for bigger steps, Alt moves the tail)', () => {
    const { hit, onBalloonChange } = setup({ editable: true });
    const el = hit('pg_1_l2');
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(onBalloonChange).toHaveBeenLastCalledWith('pg_1_l2', { x: 0.065, y: 0.5, pinned: true });
    fireEvent.keyDown(el, { key: 'ArrowDown', shiftKey: true });
    expect(onBalloonChange).toHaveBeenLastCalledWith('pg_1_l2', { x: 0.06, y: 0.52, pinned: true });
    fireEvent.keyDown(el, { key: 'ArrowLeft', altKey: true });
    expect(onBalloonChange).toHaveBeenLastCalledWith('pg_1_l2', { tailX: 0.195, tailY: 0.7, pinned: true });
  });

  it('reports selection to a controlled parent', () => {
    const onSelectLine = vi.fn();
    const { hit } = setup({ editable: true, onSelectLine, selectedLineId: null });
    fireEvent.pointerDown(hit('pg_1_l3'), { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { clientX: 5, clientY: 5 });
    expect(onSelectLine).toHaveBeenCalledWith('pg_1_l3');
  });

  it('multi-selects with Shift and drags the whole selection as one batched edit', () => {
    const onSelectionChange = vi.fn();
    const onOps = vi.fn();
    const { hit, rerender, doc, page } = setup({ editable: true, onSelectionChange, onOps });
    fireEvent.pointerDown(hit('pg_1_l2'), { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse', shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['pg_1_l2']);
    rerender(
      <div style={{ position: 'relative', width: 600, height: 900 }}>
        <BalloonLayer doc={doc} page={page} pageWidth={600} pageHeight={900} editable onOps={onOps} selectedLineIds={['pg_1_l2']} onSelectionChange={onSelectionChange} />
      </div>
    );
    fireEvent.pointerDown(hit('pg_1_l3'), { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse', shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['pg_1_l3', 'pg_1_l2']);
    rerender(
      <div style={{ position: 'relative', width: 600, height: 900 }}>
        <BalloonLayer doc={doc} page={page} pageWidth={600} pageHeight={900} editable onOps={onOps} selectedLineIds={['pg_1_l3', 'pg_1_l2']} onSelectionChange={onSelectionChange} />
      </div>
    );
    drag(hit('pg_1_l2'), [100, 100], [106, 109], { altKey: true });
    expect(onOps).toHaveBeenCalledTimes(1);
    const [ops, opts] = onOps.mock.calls[0];
    expect(ops.map((o: { lineId: string }) => o.lineId).sort()).toEqual(['pg_1_l2', 'pg_1_l3']);
    expect(opts.label).toBe('Move balloons');
  });

  it('Delete emits `line null`; undoing restores the line at the same index with its balloon', () => {
    const onOps = vi.fn();
    const { hit, doc } = setup({ editable: true, onOps });
    fireEvent.keyDown(hit('pg_1_l3'), { key: 'Delete' });
    const [ops] = onOps.mock.calls[0];
    expect(ops).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: null }]);
    const after = applyOps(doc, ops);
    expect(after.pages[0].panels[2].lines.map((l) => l.id)).toEqual(['pg_1_l4', 'pg_1_l5']);
    const restored = applyOps(after, inverseOps(doc, ops));
    expect(restored.pages[0].panels[2].lines.map((l) => l.id)).toEqual(['pg_1_l3', 'pg_1_l4', 'pg_1_l5']);
    expect(restored.pages[0].balloons.find((b) => b.lineId === 'pg_1_l3')).toEqual(doc.pages[0].balloons.find((b) => b.lineId === 'pg_1_l3'));
  });

  it('⌘D duplicates, [ ] restack, L locks — each one undoable batch', () => {
    const onOps = vi.fn();
    const { hit } = setup({ editable: true, onOps });
    fireEvent.keyDown(hit('pg_1_l2'), { key: 'd', metaKey: true });
    expect(onOps.mock.calls[0][0][0]).toMatchObject({ op: 'line', panelId: 'pg_1_p2', index: 1, patch: { kind: 'whisper', text: 'Just one more…' } });
    fireEvent.keyDown(hit('pg_1_l2'), { key: ']', shiftKey: true });
    expect(onOps.mock.calls[1][0][0]).toMatchObject({ op: 'balloon', lineId: 'pg_1_l2' });
    expect(onOps.mock.calls[1][0][0].patch.z).toBeGreaterThan(4);
    fireEvent.keyDown(hit('pg_1_l2'), { key: 'l' });
    expect(onOps.mock.calls[2][0][0]).toMatchObject({ op: 'balloon', lineId: 'pg_1_l2', patch: { locked: true, pinned: true } });
  });

  it('locked balloons cannot be dragged or nudged', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].balloons[1] = { ...d.pages[0].balloons[1], locked: true, pinned: true };
    });
    const { hit, onBalloonChange } = setup({ editable: true }, doc);
    expect(hit('pg_1_l2').dataset.locked).toBe('true');
    drag(hit('pg_1_l2'), [100, 100], [160, 190]);
    fireEvent.keyDown(hit('pg_1_l2'), { key: 'ArrowRight' });
    expect(onBalloonChange).not.toHaveBeenCalled();
  });

  it('double-click opens the inline editor; Enter commits a `line` op', () => {
    const onOps = vi.fn();
    const onEditingChange = vi.fn();
    const { hit, rerender, doc, page } = setup({ editable: true, onOps, onEditingChange });
    fireEvent.doubleClick(hit('pg_1_l4'));
    expect(onEditingChange).toHaveBeenCalledWith('pg_1_l4');
    rerender(
      <div style={{ position: 'relative', width: 600, height: 900 }}>
        <BalloonLayer doc={doc} page={page} pageWidth={600} pageHeight={900} editable onOps={onOps} editingLineId="pg_1_l4" onEditingChange={onEditingChange} />
      </div>
    );
    const ta = screen.getByTestId('balloon-text-editor') as HTMLTextAreaElement;
    expect(ta.value).toBe('You owe me an explanation, Maya.');
    fireEvent.change(ta, { target: { value: 'Explain. Now.' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onOps).toHaveBeenCalledWith([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { text: 'Explain. Now.' } }], { label: 'Edit balloon text' });
    expect(onEditingChange).toHaveBeenLastCalledWith(null);
  });

  it('Escape in the inline editor cancels without an edit', () => {
    const onOps = vi.fn();
    const onEditingChange = vi.fn();
    setup({ editable: true, onOps, editingLineId: 'pg_1_l4', onEditingChange });
    const ta = screen.getByTestId('balloon-text-editor');
    fireEvent.change(ta, { target: { value: 'nope' } });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(onOps).not.toHaveBeenCalled();
    expect(onEditingChange).toHaveBeenCalledWith(null);
  });

  it('add mode: a click on the page reports the kind and the page point', () => {
    const onAddAt = vi.fn();
    const { container } = setup({ editable: true, addKind: 'thought', onAddAt });
    const layer = container.querySelector<HTMLElement>('[data-testid="balloon-layer"]')!;
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 900, right: 600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(layer, { clientX: 300, clientY: 450, button: 0, pointerType: 'mouse' });
    expect(onAddAt).toHaveBeenCalledWith('thought', { x: 0.5, y: 0.5 });
  });
});

describe('BalloonLayer — touch (mobile.md §5.4)', () => {
  const layerRect = (container: HTMLElement, width = 600, height = 900) => {
    const layer = container.querySelector<HTMLElement>('[data-testid="balloon-layer"]')!;
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
    return layer;
  };

  it('slop is 10 px for touch, 2 for pen, 3 for mouse', () => {
    expect(dragSlopPx('touch')).toBe(10);
    expect(dragSlopPx('pen')).toBe(2);
    expect(dragSlopPx('mouse')).toBe(3);
  });

  it('a tap selects an unselected balloon without moving it', () => {
    const { hit, onBalloonChange } = setup({ editable: true });
    fireEvent.pointerDown(hit('pg_1_l2'), { clientX: 100, clientY: 100, pointerType: 'touch' });
    fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
    expect(onBalloonChange).not.toHaveBeenCalled();
    expect(hit('pg_1_l2')).toHaveAttribute('aria-pressed', 'true');
  });

  it('dragging an unselected balloon without a hold does nothing (it pans instead)', () => {
    const { hit, onBalloonChange } = setup({ editable: true });
    drag(hit('pg_1_l2'), [100, 100], [160, 190], { pointerType: 'touch' });
    expect(onBalloonChange).not.toHaveBeenCalled();
  });

  it('holding 220 ms lifts an unselected balloon, then it drags', () => {
    vi.useFakeTimers();
    try {
      const { hit, onBalloonChange } = setup({ editable: true });
      fireEvent.pointerDown(hit('pg_1_l2'), { clientX: 100, clientY: 100, pointerType: 'touch' });
      act(() => {
        vi.advanceTimersByTime(230);
      });
      fireEvent.pointerMove(window, { clientX: 160, clientY: 190, altKey: true });
      fireEvent.pointerUp(window, { clientX: 160, clientY: 190 });
      expect(onBalloonChange).toHaveBeenCalledTimes(1);
      expect(onBalloonChange.mock.calls[0][1].pinned).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a selected balloon drags past the 10 px slop; 9 px is not a drag', () => {
    const { hit, onBalloonChange } = setup({ editable: true, selectedLineId: 'pg_1_l2' });
    drag(hit('pg_1_l2'), [100, 100], [109, 100], { pointerType: 'touch' });
    expect(onBalloonChange).not.toHaveBeenCalled();
    drag(hit('pg_1_l2'), [100, 100], [130, 100], { pointerType: 'touch', altKey: true });
    expect(onBalloonChange).toHaveBeenCalledTimes(1);
  });

  it('pointercancel reverts: nothing is committed', () => {
    const { hit, onBalloonChange } = setup({ editable: true, selectedLineId: 'pg_1_l2' });
    fireEvent.pointerDown(hit('pg_1_l2'), { clientX: 100, clientY: 100, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 190 });
    fireEvent.pointerCancel(window, { clientX: 160, clientY: 190 });
    expect(onBalloonChange).not.toHaveBeenCalled();
  });

  it('travel is measured against the on-screen layer rect (correct under zoom)', () => {
    const { hit, container, onBalloonChange } = setup({ editable: true, selectedLineId: 'pg_1_l2' });
    layerRect(container, 1200, 1800); // the page is shown at 2× (pinch zoom / transform: scale(2))
    drag(hit('pg_1_l2'), [100, 100], [220, 100], { altKey: true });
    expect(onBalloonChange.mock.calls[0][1].x).toBeCloseTo(0.06 + 120 / 1200, 4);
  });

  it('a tap near (≤ 22 px) a small balloon selects it instead of clearing the selection', () => {
    const onSelectLine = vi.fn();
    const { container, hit } = setup({ editable: true, onSelectLine });
    const layer = layerRect(container);
    const o = hit('pg_1_l1');
    const left = (parseFloat(o.style.left) / 100) * 600;
    const top = (parseFloat(o.style.top) / 100) * 900;
    fireEvent.pointerDown(layer, { clientX: left - 15, clientY: top + 5, pointerType: 'touch' });
    expect(onSelectLine).toHaveBeenLastCalledWith('pg_1_l1');
    fireEvent.pointerDown(layer, { clientX: 590, clientY: 450, pointerType: 'touch' });
    expect(onSelectLine).toHaveBeenLastCalledWith(null);
  });
});

describe('BalloonLayer — languages (i18n.md)', () => {
  const edition = (lang: string, mutate?: (d: ComicDoc) => void) =>
    makeSampleDoc((d) => {
      d.format.language = lang;
      mutate?.(d);
    });

  it('a Telugu edition letters with lang="te", the Noto Sans Telugu face and no letter-spacing', () => {
    const doc = edition('te', (d) => {
      d.pages[0].panels[2].lines[1].text = 'నువ్వు నాకు వివరణ ఇవ్వాలి, మాయా.';
    });
    const { drawn } = setup({}, doc);
    const g = drawn('pg_1_l4');
    expect(g.getAttribute('lang')).toBe('te');
    const t = g.querySelector('text')!;
    expect(t.getAttribute('font-family')).toContain('Noto Sans Telugu');
    expect(t.getAttribute('letter-spacing')).toBeNull();
    expect(g.querySelectorAll('tspan')).toHaveLength(0);
  });

  it('Urdu renders right-to-left', () => {
    const doc = edition('ur', (d) => {
      d.pages[0].panels[2].lines[1].text = 'مایا، تمہیں مجھے وضاحت دینی ہوگی۔';
    });
    const { drawn } = setup({}, doc);
    expect(drawn('pg_1_l4').getAttribute('dir')).toBe('rtl');
    expect(drawn('pg_1_l4').querySelector('text')!.getAttribute('direction')).toBe('rtl');
  });

  it('whispers in Hindi are never italic', () => {
    const doc = edition('hi', (d) => {
      d.pages[0].panels[1].lines[0].text = 'बस एक और…';
    });
    const { drawn } = setup({}, doc);
    const t = drawn('pg_1_l2').querySelector('text')!;
    expect(t.getAttribute('font-style')).toBeNull();
    expect(drawn('pg_1_l2').querySelector('g[transform*="skewX"]')).toBeNull();
  });

  it('fallback (untranslated) lines carry data-fallback-lang and an optional marker', () => {
    const doc = edition('te', (d) => {
      d.pages[0].panels[0].lines[0].lang = 'en';
    });
    const { drawn, rerender, page } = setup({}, doc);
    expect(drawn('pg_1_l1').getAttribute('data-fallback-lang')).toBe('en');
    expect(drawn('pg_1_l1').querySelector('[data-fallback-marker]')).toBeNull();
    rerender(
      <div style={{ position: 'relative', width: 600, height: 900 }}>
        <BalloonLayer doc={doc} page={page} pageWidth={600} pageHeight={900} markUntranslated />
      </div>
    );
    const marker = drawn('pg_1_l1').querySelector('[data-fallback-marker]')!;
    expect(marker.textContent).toBe('Shown in English: not translated yet');
  });

  it('drags in an edition call back with { lang }', () => {
    const { hit, onBalloonChange } = setup({ editable: true, editionLang: 'te' });
    fireEvent.keyDown(hit('pg_1_l2'), { key: 'ArrowRight' });
    expect(onBalloonChange).toHaveBeenLastCalledWith('pg_1_l2', { x: 0.065, y: 0.5, pinned: true }, { lang: 'te' });
  });
});
