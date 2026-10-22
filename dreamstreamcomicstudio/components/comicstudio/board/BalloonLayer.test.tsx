import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BalloonLayer } from './BalloonLayer';
import { makeSampleDoc } from './__fixtures__/sampleDoc';

const setup = (props: Partial<React.ComponentProps<typeof BalloonLayer>> = {}) => {
  const doc = makeSampleDoc();
  const page = doc.pages[0];
  const onBalloonChange = vi.fn();
  const utils = render(
    <div style={{ position: 'relative', width: 600, height: 900 }}>
      <BalloonLayer doc={doc} page={page} pageWidth={600} pageHeight={900} onBalloonChange={onBalloonChange} {...props} />
    </div>
  );
  const balloon = (lineId: string) => utils.container.querySelector<HTMLElement>(`[data-line-id="${lineId}"]`)!;
  return { ...utils, doc, page, onBalloonChange, balloon };
};

describe('BalloonLayer', () => {
  it('letters every line, uppercase, at its balloon position', () => {
    const { container, balloon } = setup();
    expect(container.querySelectorAll('[data-testid="balloon"]')).toHaveLength(5);
    expect(screen.getByText('OLD DELHI. BEFORE THE HEAT.')).toBeInTheDocument();
    expect(screen.getByText('YOU OWE ME AN EXPLANATION, MAYA.')).toBeInTheDocument();
    const caption = balloon('pg_1_l1');
    expect(caption.style.left).toBe('4%');
    expect(caption.style.top).toBe('4%');
    expect(caption.style.width).toBe('30%');
  });

  it('sizes text from the page width', () => {
    const { balloon } = setup();
    const body = balloon('pg_1_l2').querySelector<HTMLElement>('.font-comic')!;
    // 600px page → 1.7% ≈ 10.2px; whispers letter slightly smaller.
    expect(parseFloat(body.style.fontSize)).toBeCloseTo(600 * 0.017 * 0.94, 1);
  });

  it('places lines that have no balloon (fallback) so no text is lost', () => {
    const { balloon } = setup();
    const fallback = balloon('pg_1_l4');
    expect(fallback).toBeTruthy();
    expect(fallback.dataset.fallback).toBe('true');
  });

  it('draws outlines by kind: tails for speech, none for captions, plain text for SFX', () => {
    const { balloon } = setup();
    expect(balloon('pg_1_l2').querySelectorAll('svg path').length).toBe(3); // tail (under), body, tail fill (over)
    expect(balloon('pg_1_l2').querySelector('svg path')!.getAttribute('stroke-dasharray')).toBeTruthy(); // whisper
    expect(balloon('pg_1_l1').querySelectorAll('svg path').length).toBe(1);
    expect(balloon('pg_1_l5').querySelector('svg')).toBeNull();
    expect(balloon('pg_1_l5').querySelector('.font-display')).toBeTruthy();
  });

  it('is inert (no buttons) when not editable', () => {
    setup();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('drags a balloon and reports the new position as pinned', () => {
    const { balloon, onBalloonChange } = setup({ editable: true });
    const el = balloon('pg_1_l2');
    fireEvent.pointerDown(el, { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 190 });
    fireEvent.pointerUp(window, { clientX: 160, clientY: 190 });
    expect(onBalloonChange).toHaveBeenCalledTimes(1);
    const [lineId, patch] = onBalloonChange.mock.calls[0];
    expect(lineId).toBe('pg_1_l2');
    expect(patch.pinned).toBe(true);
    expect(patch.x).toBeCloseTo(0.06 + 60 / 600, 4);
    expect(patch.y).toBeCloseTo(0.5 + 90 / 900, 4);
  });

  it('treats a click without movement as selection, not a move', () => {
    const { balloon, onBalloonChange } = setup({ editable: true });
    const el = balloon('pg_1_l2');
    fireEvent.pointerDown(el, { clientX: 100, clientY: 100, button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { clientX: 101, clientY: 100 });
    expect(onBalloonChange).not.toHaveBeenCalled();
    expect(el).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps a dragged balloon on the page', () => {
    const { balloon, onBalloonChange } = setup({ editable: true });
    fireEvent.pointerDown(balloon('pg_1_l1'), { clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: -500, clientY: -500 });
    fireEvent.pointerUp(window, { clientX: -500, clientY: -500 });
    expect(onBalloonChange).toHaveBeenCalledWith('pg_1_l1', { x: 0, y: 0, pinned: true });
  });

  it('aims the tail with its handle', () => {
    const { balloon, onBalloonChange } = setup({ editable: true, selectedLineId: 'pg_1_l2' });
    const handle = balloon('pg_1_l2').querySelector<HTMLElement>('[data-testid="tail-handle"]')!;
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 30, clientY: -45 });
    fireEvent.pointerUp(window, { clientX: 30, clientY: -45 });
    const [, patch] = onBalloonChange.mock.calls[0];
    expect(patch).toEqual({ tailX: 0.25, tailY: 0.65, pinned: true });
  });

  it('resizes with the width grip', () => {
    const { balloon, onBalloonChange } = setup({ editable: true, selectedLineId: 'pg_1_l2' });
    const grip = balloon('pg_1_l2').querySelector<HTMLElement>('[data-testid="width-handle"]')!;
    fireEvent.pointerDown(grip, { clientX: 0, clientY: 0, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 60, clientY: 0 });
    expect(onBalloonChange.mock.calls[0][1]).toEqual({ w: 0.32, pinned: true });
  });

  it('nudges with arrow keys (Shift for bigger steps, Alt moves the tail)', () => {
    const { balloon, onBalloonChange } = setup({ editable: true });
    const el = balloon('pg_1_l2');
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(onBalloonChange).toHaveBeenLastCalledWith('pg_1_l2', { x: 0.065, y: 0.5, pinned: true });
    fireEvent.keyDown(el, { key: 'ArrowDown', shiftKey: true });
    expect(onBalloonChange).toHaveBeenLastCalledWith('pg_1_l2', { x: 0.06, y: 0.52, pinned: true });
    fireEvent.keyDown(el, { key: 'ArrowLeft', altKey: true });
    expect(onBalloonChange).toHaveBeenLastCalledWith('pg_1_l2', { tailX: 0.195, tailY: 0.7, pinned: true });
  });

  it('reports selection to a controlled parent', () => {
    const onSelectLine = vi.fn();
    const { balloon } = setup({ editable: true, onSelectLine, selectedLineId: null });
    fireEvent.pointerDown(balloon('pg_1_l3'), { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { clientX: 5, clientY: 5 });
    expect(onSelectLine).toHaveBeenCalledWith('pg_1_l3');
  });
});
