// The Pro workspace's balloon layer (PE-SHELL): rotate and height handles (one balloon op on release, 15° detents
// through the B9 snapAngle / rotateEdit), R / Shift+R, two-finger rotate, Tab / Shift+Tab and ⌘A, and the presence
// outline. Without the extras context (the flag off, readers, the board) none of it exists.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { BalloonEditorExtrasContext, BalloonLayer, PRESENCE_LABEL, dragRotation, type BalloonEditorExtras } from './BalloonLayer';
import { makeSampleDoc } from './__fixtures__/sampleDoc';
import { planLettering, estimateMeasure } from '../../../shared/comic/lettering/layout';
import { outlineFractions } from '../lettering/styleOps';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { PRO_EDIT_OPS } from '../../../shared/comic/ops';

afterEach(cleanup);

const W = 600;
const HPX = 900;
const PRO: BalloonEditorExtras = { transform: true, keyboard: true };

const setup = (opts: { extras?: BalloonEditorExtras; selected?: string[]; doc?: ComicDoc; onOps?: boolean; editionLang?: string } = {}) => {
  const doc = opts.doc ?? makeSampleDoc();
  const page = doc.pages[0];
  const onBalloonChange = vi.fn();
  const onOps = vi.fn();
  const onSelectionChange = vi.fn();
  const layer = (
    <div style={{ position: 'relative', width: W, height: HPX }}>
      <BalloonLayer
        doc={doc}
        page={page}
        pageWidth={W}
        pageHeight={HPX}
        editable
        onBalloonChange={opts.onOps ? undefined : onBalloonChange}
        onOps={onOps}
        selectedLineIds={opts.selected ?? []}
        onSelectionChange={onSelectionChange}
        editionLang={opts.editionLang}
      />
    </div>
  );
  const utils = render(opts.extras ? <BalloonEditorExtrasContext.Provider value={opts.extras}>{layer}</BalloonEditorExtrasContext.Provider> : layer);
  const hit = (id: string) => utils.container.querySelector<HTMLElement>(`[data-testid="balloon-hit"][data-line-id="${id}"]`)!;
  return { ...utils, doc, page, onBalloonChange, onOps, onSelectionChange, hit };
};

/** The outline centre of a line (layer px), from the engine's plan. */
const centreOf = (doc: ComicDoc, lineId: string) => {
  const aspect = W / HPX;
  const plans = planLettering(doc, doc.pages[0], aspect, estimateMeasure);
  const H = 1000 / aspect;
  const o = outlineFractions(plans.find((p) => p.lineId === lineId)!, H);
  return { x: (o.x + o.w / 2) * W, y: (o.y + o.h / 2) * HPX, o };
};

const rad = (deg: number) => (deg * Math.PI) / 180;

describe('dragRotation (pure)', () => {
  it('turns by the pointer’s angle around the centre, snaps to 15°, clamps to ±45°, Alt is free', () => {
    const c = { x: 0.5, y: 0.5 };
    const up = { x: 0.5, y: 0.3 };
    const at = (deg: number) => ({ x: 0.5 + 0.2 * Math.sin(rad(deg)), y: 0.5 - 0.2 * Math.cos(rad(deg)) });
    expect(dragRotation(0, c, up, at(37), 1)).toBe(30);
    expect(dragRotation(0, c, up, at(38), 1)).toBe(45);
    expect(dragRotation(0, c, up, at(-22), 1)).toBe(-15);
    expect(dragRotation(15, c, up, at(20), 1)).toBe(30);
    expect(dragRotation(0, c, up, at(80), 1)).toBe(45);
    expect(dragRotation(0, c, up, at(37), 1, true)).toBeCloseTo(37, 0);
  });
});

describe('BalloonLayer without the Pro extras (flag off, readers)', () => {
  it('has no rotate or height handle, R does nothing and Tab is left to the browser', () => {
    const { container, hit, onBalloonChange, onSelectionChange } = setup({ selected: ['pg_1_l2'] });
    expect(container.querySelector('[data-testid="rotate-handle"]')).toBeNull();
    expect(container.querySelector('[data-testid="height-handle"]')).toBeNull();
    fireEvent.keyDown(hit('pg_1_l2'), { key: 'r' });
    expect(onBalloonChange).not.toHaveBeenCalled();
    const tab = fireEvent.keyDown(hit('pg_1_l2'), { key: 'Tab' });
    expect(tab).toBe(true); // not prevented: native Tab
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

describe('BalloonLayer in Pro: rotate', () => {
  it('a rotate drag sends ONE balloon {rot} op on release, at a 15° detent (37° → 30°)', () => {
    const { container, doc, onBalloonChange } = setup({ extras: PRO, selected: ['pg_1_l2'] });
    const handle = container.querySelector<HTMLElement>('[data-testid="rotate-handle"]')!;
    expect(handle).not.toBeNull();
    const c = centreOf(doc, 'pg_1_l2');
    const from = { x: c.x, y: c.y - 100 };
    const to = { x: c.x + 100 * Math.sin(rad(37)), y: c.y - 100 * Math.cos(rad(37)) };
    fireEvent.pointerDown(handle, { clientX: from.x, clientY: from.y, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 });
    fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y });
    // Nothing is committed mid-drag.
    expect(onBalloonChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y });
    expect(onBalloonChange).toHaveBeenCalledTimes(1);
    const [lineId, patch, opts] = onBalloonChange.mock.calls[0];
    expect(lineId).toBe('pg_1_l2');
    expect(patch.rot).toBe(30);
    expect(patch.pinned).toBe(true);
    expect(opts).toMatchObject({ label: 'Rotate balloon', gesture: 'rotate' });
  });

  it('through onOps (a page editor batch) it is exactly one `balloon` op, never a Pro op or field', () => {
    const { container, doc, onOps } = setup({ extras: PRO, selected: ['pg_1_l3'], onOps: true });
    const handle = container.querySelector<HTMLElement>('[data-testid="rotate-handle"]')!;
    const c = centreOf(doc, 'pg_1_l3');
    fireEvent.pointerDown(handle, { clientX: c.x, clientY: c.y - 100, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: c.x - 100 * Math.sin(rad(16)), clientY: c.y - 100 * Math.cos(rad(16)) });
    fireEvent.pointerUp(window, { clientX: c.x - 100 * Math.sin(rad(16)), clientY: c.y - 100 * Math.cos(rad(16)) });
    expect(onOps).toHaveBeenCalledTimes(1);
    const ops = onOps.mock.calls[0][0] as DocOp[];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l3', patch: { rot: -15, pinned: true } });
    expect((PRO_EDIT_OPS as readonly string[]).includes(ops[0].op)).toBe(false);
    expect(Object.keys((ops[0] as Extract<DocOp, { op: 'balloon' }>).patch)).not.toContain('styleId');
    expect(onOps.mock.calls[0][1]).toMatchObject({ label: 'Rotate balloon', coalesce: 'balloon:rotate:pg_1:pg_1_l3' });
  });

  it('R turns the focused balloon 15° clockwise, Shift+R back; the slider arrows do the same', () => {
    const { hit, container, onBalloonChange } = setup({ extras: PRO, selected: ['pg_1_l2'] });
    fireEvent.keyDown(hit('pg_1_l2'), { key: 'r' });
    expect(onBalloonChange.mock.calls[0][1].rot).toBe(15);
    fireEvent.keyDown(hit('pg_1_l2'), { key: 'R', shiftKey: true });
    expect(onBalloonChange.mock.calls[1][1].rot).toBe(-15);
    fireEvent.keyDown(container.querySelector<HTMLElement>('[data-testid="rotate-handle"]')!, { key: 'ArrowRight' });
    expect(onBalloonChange.mock.calls[2][1].rot).toBe(15);
  });

  it('a stored rotation is the start: R from 30° goes to 45° and no further', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l2' ? { ...b, rot: 30 } : b));
    });
    const { hit, onBalloonChange } = setup({ extras: PRO, selected: ['pg_1_l2'], doc });
    fireEvent.keyDown(hit('pg_1_l2'), { key: 'r' });
    expect(onBalloonChange.mock.calls[0][1].rot).toBe(45);
  });

  it('a software-placed balloon (no stored balloon) is rotated with its drawn box in the same single op', () => {
    const { hit, onBalloonChange } = setup({ extras: PRO, selected: ['pg_1_l4'] });
    fireEvent.keyDown(hit('pg_1_l4'), { key: 'r' });
    expect(onBalloonChange).toHaveBeenCalledTimes(1);
    const patch = onBalloonChange.mock.calls[0][1];
    expect(patch.rot).toBe(15);
    expect(typeof patch.x).toBe('number');
    expect(typeof patch.w).toBe('number');
  });

  it('two fingers on the selected balloon rotate it with detents (one op when they lift)', () => {
    const { hit, doc, onBalloonChange } = setup({ extras: PRO, selected: ['pg_1_l2'] });
    const c = centreOf(doc, 'pg_1_l2');
    const el = hit('pg_1_l2');
    fireEvent.pointerDown(el, { clientX: c.x - 10, clientY: c.y, pointerType: 'touch', pointerId: 1, isPrimary: true });
    fireEvent.pointerDown(el, { clientX: c.x + 10, clientY: c.y, pointerType: 'touch', pointerId: 2, isPrimary: false });
    // Finger 2 swings 33° around finger 1: the balloon turns 30°.
    fireEvent.pointerMove(window, { clientX: c.x - 10 + 20 * Math.cos(rad(33)), clientY: c.y + 20 * Math.sin(rad(33)), pointerType: 'touch', pointerId: 2 });
    expect(onBalloonChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerType: 'touch', pointerId: 2 });
    fireEvent.pointerUp(window, { pointerType: 'touch', pointerId: 1 });
    expect(onBalloonChange).toHaveBeenCalledTimes(1);
    expect(onBalloonChange.mock.calls[0][1].rot).toBe(30);
  });

  it('no rotate or height handle in a translated edition (rotation and height are the same in every language)', () => {
    const { container } = setup({ extras: PRO, selected: ['pg_1_l2'], editionLang: 'hi' });
    expect(container.querySelector('[data-testid="rotate-handle"]')).toBeNull();
  });
});

describe('BalloonLayer in Pro: height', () => {
  it('a height drag sends one balloon {minH} op on release (≤ minHMax)', () => {
    const { container, doc, onBalloonChange } = setup({ extras: PRO, selected: ['pg_1_l2'] });
    const grip = container.querySelector<HTMLElement>('[data-testid="height-handle"]')!;
    const { o } = centreOf(doc, 'pg_1_l2');
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 500, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 590 });
    fireEvent.pointerUp(window, { clientX: 100, clientY: 590 });
    expect(onBalloonChange).toHaveBeenCalledTimes(1);
    const [, patch, opts] = onBalloonChange.mock.calls[0];
    expect(patch.minH).toBeCloseTo(o.h + 90 / HPX, 3);
    expect(patch.pinned).toBe(true);
    expect(opts).toMatchObject({ gesture: 'height' });
  });
});

describe('BalloonLayer in Pro: the keyboard', () => {
  it('Tab and Shift+Tab walk the balloons in reading order and wrap', () => {
    const { hit, page, onSelectionChange } = setup({ extras: PRO, selected: ['pg_1_l1'] });
    const order = page.panels.flatMap((p) => p.lines.map((l) => l.id));
    const last = order[order.length - 1];
    fireEvent.keyDown(hit('pg_1_l1'), { key: 'Tab' });
    expect(onSelectionChange).toHaveBeenLastCalledWith([order[1]]);
    expect(document.activeElement).toBe(hit(order[1]));
    fireEvent.keyDown(hit('pg_1_l1'), { key: 'Tab', shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith([last]);
    fireEvent.keyDown(hit(last), { key: 'Tab' });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['pg_1_l1']);
  });

  it('⌘A / Ctrl+A select every balloon on the page in reading order', () => {
    const { hit, page, onSelectionChange } = setup({ extras: PRO, selected: ['pg_1_l2'] });
    fireEvent.keyDown(hit('pg_1_l2'), { key: 'a', metaKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(page.panels.flatMap((p) => p.lines.map((l) => l.id)));
  });
});

describe('BalloonLayer: presence (A4)', () => {
  it('outlines the balloon the director is editing, with the words, and says so to a screen reader', () => {
    const { container, hit } = setup({ extras: { transform: false, keyboard: false, presenceLineIds: new Set(['pg_1_l3']) } });
    expect(hit('pg_1_l3').getAttribute('data-presence')).toBe('true');
    expect(hit('pg_1_l3').querySelector('[data-testid="presence-outline"]')).not.toBeNull();
    expect(hit('pg_1_l3').querySelector('[data-testid="presence-chip"]')?.textContent).toBe(PRESENCE_LABEL);
    expect(container.querySelector(`#bd-pg_1-pg_1_l3`)?.textContent).toMatch(/director is editing this balloon/);
    expect(hit('pg_1_l2').querySelector('[data-testid="presence-outline"]')).toBeNull();
  });
});
