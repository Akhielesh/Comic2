import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { DocOp } from '../../../shared/comic/ops';
import { PageEditor, editActionFor, fitPageToStage, lineKindOps } from './PageEditor';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const open = (pageId = 'pg_1', doc = makeSampleDoc()) => {
  const studio = makeStudio(doc, { focusedPageId: pageId });
  const utils = render(<PageEditor studio={studio} doc={doc} pageId={pageId} />);
  return { ...utils, studio, doc };
};

const markRegion = (from: [number, number], to: [number, number]) => {
  const layer = screen.getByTestId('markup-layer');
  layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(layer, { clientX: from[0], clientY: from[1], button: 0, pointerType: 'mouse' });
  fireEvent.pointerMove(window, { clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 });
  fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] });
};

const lineRow = (lineId: string) => document.querySelector<HTMLElement>(`[data-testid="line-row"][data-line-id="${lineId}"]`)!;

describe('pure helpers', () => {
  it('builds the edit_page payload, trimming and omitting empty scope', () => {
    expect(editActionFor('pg_1', '  make it night  ')).toEqual({ type: 'edit_page', pageId: 'pg_1', instruction: 'make it night' });
    expect(editActionFor('pg_1', 'x', { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 2)).toEqual({
      type: 'edit_page',
      pageId: 'pg_1',
      instruction: 'x',
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      panelN: 2
    });
  });

  it('clears the speaker when a line becomes a caption and assigns one when it becomes speech', () => {
    const doc = makeSampleDoc();
    const page = doc.pages[0];
    const panel = page.panels[2];
    const toCaption = lineKindOps(page, panel, panel.lines[1], 'caption')[0] as Extract<DocOp, { op: 'line' }>;
    expect(toCaption.patch).toEqual({ kind: 'caption', speakerId: null });
    const sfx = panel.lines[2];
    const toSpeech = lineKindOps(page, panel, sfx, 'speech')[0] as Extract<DocOp, { op: 'line' }>;
    expect(toSpeech.patch).toEqual({ kind: 'speech', speakerId: 'ch_maya' });
  });
});

describe('PageEditor', () => {
  it('opens as a modal dialog for the page and closes on Escape', () => {
    const { studio } = open();
    expect(screen.getByRole('dialog', { name: 'Page 1 editor' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(studio.openPage).toHaveBeenCalledWith(null);
  });

  it('moves between pages with ←/→ and the header buttons', () => {
    const { studio } = open('pg_2');
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(studio.openPage).toHaveBeenLastCalledWith('pg_3');
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(studio.openPage).toHaveBeenLastCalledWith('pg_1');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(studio.openPage).toHaveBeenLastCalledWith('pg_3');
  });

  it('does not turn pages while typing', () => {
    const { studio } = open('pg_2');
    const textarea = screen.getByLabelText('What should change?');
    fireEvent.keyDown(textarea, { key: 'ArrowRight' });
    expect(studio.openPage).not.toHaveBeenCalled();
  });

  it('marks a region in normalized page coordinates and names its panel', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: /Mark up/ }));
    markRegion([40, 300], [200, 480]);
    const region = screen.getByTestId('markup-region');
    expect(region.style.left).toBe('10%');
    expect(region.style.top).toBe('50%');
    expect(region.style.width).toBe('40%');
    expect(parseFloat(region.style.height)).toBeCloseTo(30, 6);
    expect(screen.getByTestId('region-chip')).toHaveTextContent('Marked area in panel 2');
    expect(screen.getByLabelText('Panel to change')).toHaveValue('2');
  });

  it('ignores a click in mark-up mode (not a drag)', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: /Mark up/ }));
    markRegion([40, 300], [42, 301]);
    expect(screen.queryByTestId('markup-region')).toBeNull();
  });

  it('sends a scoped edit with the marked region and panel', () => {
    const { studio } = open();
    fireEvent.click(screen.getByRole('radio', { name: /Mark up/ }));
    markRegion([200, 480], [40, 300]);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'Make it night, lanterns lit' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply edit/ }));
    expect(studio.act).toHaveBeenCalledWith({
      type: 'edit_page',
      pageId: 'pg_1',
      instruction: 'Make it night, lanterns lit',
      region: { x: 0.1, y: 0.5, w: 0.4, h: 0.3 },
      panelN: 2
    });
    // The form resets after sending.
    expect(screen.getByLabelText('What should change?')).toHaveValue('');
    expect(screen.queryByTestId('region-chip')).toBeNull();
  });

  it('sends a whole-panel edit without a region', () => {
    const { studio } = open();
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'Give Arjun his beard' } });
    fireEvent.change(screen.getByLabelText('Panel to change'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply edit/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'edit_page', pageId: 'pg_1', instruction: 'Give Arjun his beard', panelN: 3 });
  });

  it('cannot edit a page that has no drawing yet', () => {
    open('pg_2');
    expect(screen.getByLabelText('What should change?')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Apply edit/ })).toBeDisabled();
  });

  it('edits a line’s text', () => {
    const { studio } = open();
    const field = within(lineRow('pg_1_l4')).getByLabelText(/Line text/);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'You owe me, Maya.' } });
    fireEvent.blur(field);
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { text: 'You owe me, Maya.' } }]);
  });

  it('changes a line’s kind and speaker', () => {
    const { studio } = open();
    const row = lineRow('pg_1_l4');
    fireEvent.change(within(row).getByLabelText('Speaker'), { target: { value: 'ch_maya' } });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { speakerId: 'ch_maya' } }]);
    fireEvent.change(within(row).getByLabelText('Line type'), { target: { value: 'caption' } });
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { kind: 'caption', speakerId: null } }]);
  });

  it('adds and removes lines', () => {
    const { studio } = open();
    const panel3 = screen.getByRole('region', { name: 'Panel 3' });
    fireEvent.click(within(panel3).getByRole('button', { name: 'Add line' }));
    const add = (studio.patch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0][0];
    expect(add).toMatchObject({ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', patch: { kind: 'speech', speakerId: 'ch_maya', text: '' } });
    expect(add.id).toMatch(/^ln_/);
    fireEvent.click(within(lineRow('pg_1_l5')).getByRole('button', { name: 'Remove line' }));
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l5', patch: null }]);
  });

  it('saves balloon moves as undoable balloon ops', () => {
    const { studio, container } = open();
    const balloon = document.querySelector<HTMLElement>('[data-testid="balloon-hit"][data-line-id="pg_1_l2"]')!;
    expect(container).toBeTruthy();
    fireEvent.keyDown(balloon, { key: 'ArrowUp' });
    expect(studio.patch).toHaveBeenCalledWith(
      [{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { x: 0.06, y: 0.495, pinned: true } }],
      { undo: true, label: 'Move balloon', coalesce: 'balloon:pg_1:pg_1_l2' }
    );
  });

  it('restores a previous version', () => {
    const { studio } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'restore_render', target: { kind: 'page', id: 'pg_1' }, path: 'u/proj/pages/p1.png.old' });
  });

  it('re-renders and re-letters', () => {
    const { studio } = open();
    fireEvent.click(screen.getByRole('button', { name: /Re-render page/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_1'], force: true });
    fireEvent.click(screen.getByRole('button', { name: /Re-letter/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'relayout_balloons', pageId: 'pg_1' });
  });

  it('shows the QC report', () => {
    open();
    expect(screen.getByText('Arjun’s beard is missing in panel 3')).toBeInTheDocument();
    expect(screen.getByText('match 82%')).toBeInTheDocument();
  });

  it('has no re-letter on in-art comics', () => {
    open('pg_1', makeSampleDoc((d) => (d.format.lettering = 'in_art')));
    expect(screen.queryByRole('button', { name: /Re-letter/ })).toBeNull();
    expect(screen.getByText(/any script change marks the page out of date/)).toBeInTheDocument();
  });

  it('lettering: selecting a balloon opens the Easy inspector (8 styles, 6 shapes, no Pro tabs) and mirrors the selection to the chat', () => {
    const { studio } = open();
    const hit = document.querySelector<HTMLElement>('[data-testid="balloon-hit"][data-line-id="pg_1_l4"]')!;
    fireEvent.pointerDown(hit, { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { clientX: 5, clientY: 5 });
    const inspector = screen.getByTestId('lettering-inspector');
    expect(within(inspector).getByRole('radiogroup', { name: 'Lettering style' }).querySelectorAll('[role="radio"]')).toHaveLength(8);
    expect(within(inspector).getByRole('radiogroup', { name: 'Balloon type' }).querySelectorAll('[role="radio"]')).toHaveLength(6);
    expect(within(inspector).queryByRole('tablist')).toBeNull();
    expect(within(inspector).getByText('Free — done by the editor, no AI cost.')).toBeInTheDocument();
    expect(studio.setSelection).toHaveBeenLastCalledWith({ pageId: 'pg_1', lineIds: ['pg_1_l4'], surface: 'page_editor', panelN: 3 });
  });

  it('lettering: an Easy colour pick is one free, undoable line_style op', () => {
    const { studio } = open();
    const hit = document.querySelector<HTMLElement>('[data-testid="balloon-hit"][data-line-id="pg_1_l4"]')!;
    fireEvent.focus(hit);
    const inspector = screen.getByTestId('lettering-inspector');
    fireEvent.click(within(inspector).getByRole('button', { name: 'Bubble colour: #ffd84a' }));
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { fill: '#ffd84a' } }], { undo: true, label: 'Bubble colour' });
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('lettering: Pro view shows the full inspector when the user picks it', () => {
    const doc = makeSampleDoc();
    const studio = makeStudio(doc, { focusedPageId: 'pg_1', mode: 'pro' });
    render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
    fireEvent.focus(document.querySelector<HTMLElement>('[data-testid="balloon-hit"][data-line-id="pg_1_l4"]')!);
    const inspector = screen.getByTestId('lettering-inspector');
    expect(within(inspector).getByRole('tablist', { name: 'Lettering controls' })).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole('radio', { name: 'Easy' }));
    expect(studio.setMode).toHaveBeenCalledWith('easy');
  });

  it('lettering: + Speech then a click on the page adds a line with its balloon and opens the inline editor', () => {
    const { studio } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Add speech balloon' }));
    const layer = document.querySelector<HTMLElement>('[data-testid="balloon-layer"]')!;
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 900, right: 600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(layer, { clientX: 300, clientY: 700, button: 0, pointerType: 'mouse' });
    const [ops, opts] = (studio.patch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(ops[0]).toMatchObject({ op: 'line', pageId: 'pg_1', patch: { kind: 'speech', text: 'Hello!' } });
    expect(ops[1]).toMatchObject({ op: 'balloon', pageId: 'pg_1', lineId: ops[0].id, patch: { pinned: true } });
    expect(opts).toEqual({ undo: true, label: 'Add speech' });
  });

  it('lettering: ⌘Z / ⇧⌘Z undo and redo; arrows never turn the page while a balloon is selected', () => {
    const doc = makeSampleDoc();
    const studio = makeStudio(doc, { focusedPageId: 'pg_1', selection: { pageId: 'pg_1', lineIds: ['pg_1_l2'], surface: 'page_editor' } });
    render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(studio.undo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    expect(studio.redo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(studio.openPage).not.toHaveBeenCalled();
  });

  it('undo / redo stay one tap away outside the lettering toolbar (mark-up mode, phones without keys)', () => {
    const doc = makeSampleDoc();
    const studio = makeStudio(doc, { focusedPageId: 'pg_1', canUndo: true, canRedo: false, undoLabel: 'Edit line' });
    render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
    fireEvent.click(screen.getByRole('radio', { name: /Mark up/ }));
    expect(screen.queryByTestId('lettering-toolbar')).toBeNull();
    const group = screen.getByRole('group', { name: 'Undo and redo' });
    fireEvent.click(within(group).getByRole('button', { name: 'Undo Edit line' }));
    expect(studio.undo).toHaveBeenCalledTimes(1);
    expect(within(group).getByRole('button', { name: 'Redo' })).toBeDisabled();
  });

  it('stage: sizes the page from its content box and can never widen its column (visualqa P0-2)', () => {
    expect(fitPageToStage({ w: 590, h: 640 }, 1)).toBeLessThanOrEqual(590 - 48);
    expect(fitPageToStage({ w: 1000, h: 500 }, 2 / 3, 0)).toBe(333);
    expect(fitPageToStage({ w: 0, h: 500 }, 1)).toBeUndefined();
    open();
    expect(screen.getByTestId('editor-stage').className).toMatch(/\bmin-w-0\b/);
    expect(screen.getByTestId('editor-stage').className).toMatch(/\blg:min-w-0\b/);
  });
});
