// LetteringInspector — Pro Edit (PE-INSPECT; agent-editor plan §4 Wave 1 C-INSPECT): docked at 1280 px (in the page
// flow, never floating over the page), keys 1–6 write line {kind}, ⌘⌥C / ⌘⌥V copy and paste a style, the typed
// transform and fields appear; without `proEdit` the inspector is exactly today's. The Pro parts come from the lazily
// loaded Pro extras: they are loaded once up front, so every render below is synchronous.

import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../../shared/comic/lettering/layout';
import { PRO_FREE_FOOTER } from '../../../shared/comic/pro/types';
import { resolvePlacements } from './useLetterPlans';
import { LetteringInspector } from './LetteringInspector';
import { setStyleClip, styleClip } from '../editor/inspector/styleClipboard';
import { loadProExtras } from './pro/proExtras';

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;

const mount = (lineIds: string[], extra: Partial<React.ComponentProps<typeof LetteringInspector>> = {}, mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const doc = makeSampleDoc(mutate);
  const page = doc.pages[0];
  const plans = planLettering(doc, page, ASPECT, estimateMeasure);
  const placements = resolvePlacements(doc, page, ASPECT, estimateMeasure);
  const apply = vi.fn();
  const onClose = vi.fn();
  const el = (ids: string[]) => (
    <LetteringInspector
      doc={doc}
      page={page}
      lineIds={ids}
      plans={plans}
      placements={placements}
      H={H}
      apply={apply}
      onEditText={vi.fn()}
      onDeselect={vi.fn()}
      mode="pro"
      onModeChange={vi.fn()}
      canPro
      anchor={{ left: 100, top: 100, right: 200, bottom: 160 }}
      compact={false}
      onClose={onClose}
      {...extra}
    />
  );
  const utils = render(el(lineIds));
  /** The page editor re-rendering the inspector for another selection (what a click on the page does first). */
  const select = (ids: string[]) => utils.rerender(el(ids));
  return { ...utils, apply, onClose, doc, page, select };
};

beforeAll(async () => {
  await loadProExtras();
});

let width = 0;
beforeEach(() => {
  width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  setStyleClip(null);
});
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
});

describe('LetteringInspector, Pro Edit', () => {
  it('is docked at 1280 px: in the page flow (no fixed position, no viewport placement), no floating chrome', () => {
    const { onClose } = mount(['pg_1_l4'], { proEdit: true, docked: true });
    const panel = screen.getByTestId('lettering-inspector');
    expect(panel.getAttribute('data-presentation')).toBe('docked');
    expect(panel.className).not.toMatch(/\bfixed\b/);
    expect(panel.getAttribute('style')).toBeNull();
    // The workspace header owns Easy | Pro and the selection owns closing: neither is repeated here.
    expect(within(panel).queryByRole('radiogroup', { name: 'Editor view' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Close the lettering panel' })).toBeNull();
    // The workspace's panel frame draws the free footer under the whole dock.
    expect(within(panel).queryByText(/Free — done by the editor/)).toBeNull();
    // Escape still lets go of the selection.
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('floating (a tablet or phone with the flag on), the footer reads PRO_FREE_FOOTER', () => {
    mount(['pg_1_l4'], { proEdit: true });
    expect(screen.getByTestId('lettering-inspector').getAttribute('data-presentation')).toBe('floating');
    expect(screen.getByTestId('pro-free-footer').textContent).toBe(PRO_FREE_FOOTER);
  });

  it('keys 1–6 write line {kind} for the selection (one labelled undo entry), never while typing', () => {
    const { apply } = mount(['pg_1_l4'], { proEdit: true, docked: true });
    fireEvent.keyDown(window, { key: '5' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { kind: 'caption', speakerId: null } }], { label: 'Make it a caption' });
    fireEvent.keyDown(window, { key: '4' });
    expect(apply.mock.calls[1][0][0].patch).toEqual({ kind: 'shout' });
    // ⌘1 is the browser's; a field takes its own digits.
    fireEvent.keyDown(window, { key: '2', metaKey: true });
    fireEvent.keyDown(screen.getAllByRole('spinbutton')[0], { key: '3' });
    expect(apply).toHaveBeenCalledTimes(2);
    // Keys for the kind the line already has send nothing.
    fireEvent.keyDown(window, { key: '1' });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('the keys never fire while typing anywhere on the page (the chat composer, editable text) or with Alt held', () => {
    const { apply } = mount(['pg_1_l4'], { proEdit: true, docked: true });
    const composer = document.body.appendChild(document.createElement('textarea'));
    const editable = document.body.appendChild(document.createElement('div'));
    editable.setAttribute('contenteditable', 'true');
    try {
      fireEvent.keyDown(composer, { key: '4' });
      fireEvent.keyDown(editable, { key: '5' });
      fireEvent.keyDown(window, { key: '5', altKey: true });
      fireEvent.keyDown(window, { key: '4', ctrlKey: true });
      expect(apply).not.toHaveBeenCalled();
      // The same key outside a field does set the kind.
      fireEvent.keyDown(window, { key: '4' });
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      composer.remove();
      editable.remove();
    }
  });

  it('a value typed for one balloon goes to that balloon when the next one is selected before the field blurs', () => {
    // BalloonLayer selects on pointerdown, so the inspector re-renders for the next balloon before the field blurs.
    const { apply, select } = mount(['pg_1_l3'], { proEdit: true, docked: true });
    const size = screen.getByRole('spinbutton', { name: 'Size' }) as HTMLInputElement;
    fireEvent.focus(size);
    fireEvent.change(size, { target: { value: '150' } });
    select(['pg_1_l4']);
    // pg_1_l4 has the same size, so the field (and its draft) stay put.
    expect(screen.getByTestId('lettering-inspector').querySelector('h3')!.textContent).toMatch(/^Speech/);
    expect(size.isConnected && size.value).toBe('150');
    fireEvent.blur(size);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { sizeScale: 1.5 } }], { label: 'Text size' });
  });

  it('a typed X for one balloon is never committed to the next: the transform’s fields are per balloon', () => {
    const { apply, select } = mount(['pg_1_l3'], { proEdit: true, docked: true });
    const x = screen.getByRole('spinbutton', { name: 'X' }) as HTMLInputElement;
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: '12' } });
    select(['pg_1_l4']);
    const next = screen.getByRole('spinbutton', { name: 'X' }) as HTMLInputElement;
    expect(next).not.toBe(x);
    fireEvent.blur(next);
    expect(apply).not.toHaveBeenCalled();
  });

  it('the kind row shows the selection’s kind and writes line {kind} on a tap (44 px on touch)', () => {
    const { apply } = mount(['pg_1_l3', 'pg_1_l4'], { proEdit: true, docked: true });
    const row = screen.getByRole('radiogroup', { name: 'Balloon kind' });
    const radios = within(row).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Speech', 'Thought', 'Whisper', 'Shout', 'Caption', 'SFX']);
    expect(radios.map((r) => r.getAttribute('aria-keyshortcuts'))).toEqual(['1', '2', '3', '4', '5', '6']);
    // Mixed kinds: none checked.
    expect(radios.some((r) => r.getAttribute('aria-checked') === 'true')).toBe(false);
    for (const r of radios) expect(r.className).toContain('coarse:min-h-11');
    fireEvent.click(within(row).getByRole('radio', { name: 'Whisper' }));
    expect(apply.mock.calls[0][0].map((o: { id: string; patch: { kind: string } }) => [o.id, o.patch.kind])).toEqual([
      ['pg_1_l3', 'whisper'],
      ['pg_1_l4', 'whisper']
    ]);
  });

  it('⌘⌥C copies the balloon’s look and ⌘⌥V pastes it onto the selection', () => {
    const styled = (d: ReturnType<typeof makeSampleDoc>) => {
      d.pages[0].panels[2].lines[0].style = { fill: '#ffd84a' };
    };
    const first = mount(['pg_1_l3'], { proEdit: true, docked: true }, styled);
    fireEvent.keyDown(window, { key: 'ç', code: 'KeyC', metaKey: true, altKey: true });
    expect(styleClip()).toMatchObject({ from: 'pg_1_l3', patch: { fill: '#ffd84a' } });
    first.unmount();
    const second = mount(['pg_1_l5'], { proEdit: true, docked: true }, styled);
    fireEvent.keyDown(window, { key: '√', code: 'KeyV', ctrlKey: true, altKey: true });
    expect(second.apply).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l5'], patch: { fill: '#ffd84a' }, mode: 'replace' }], { label: 'Paste style' });
  });

  it('Pro view shows the typed transform and typed fields beside the sliders', () => {
    mount(['pg_1_l3'], { proEdit: true, docked: true });
    expect(screen.getByTestId('transform-section')).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Size' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Letter spacing' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Line height' })).toBeTruthy();
  });

  it('a typed size commits one line_style {sizeScale} (its own undo entry); a stepped one coalesces', () => {
    const { apply } = mount(['pg_1_l3'], { proEdit: true, docked: true });
    const size = screen.getByRole('spinbutton', { name: 'Size' });
    fireEvent.change(size, { target: { value: '150' } });
    fireEvent.keyDown(size, { key: 'Enter' });
    expect(apply).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { sizeScale: 1.5 } }], { label: 'Text size' });
    fireEvent.keyDown(size, { key: 'ArrowUp' });
    expect(apply.mock.calls[1][1]).toEqual({ label: 'Text size', coalesce: 'style:pg_1:pg_1_l3:size' });
  });

  it('without proEdit the inspector is today’s: no kind row, no transform, no typed fields, today’s footer', () => {
    const { apply } = mount(['pg_1_l3']);
    expect(screen.getByTestId('lettering-inspector').getAttribute('data-presentation')).toBe('floating');
    expect(screen.queryByTestId('kind-row')).toBeNull();
    expect(screen.queryByTestId('transform-section')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Editor view' })).toBeTruthy();
    expect(screen.getByText('Free — done by the editor, no AI cost.')).toBeTruthy();
    fireEvent.keyDown(window, { key: '5' });
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC', metaKey: true, altKey: true });
    expect(apply).not.toHaveBeenCalled();
    expect(styleClip()).toBeNull();
  });
});
