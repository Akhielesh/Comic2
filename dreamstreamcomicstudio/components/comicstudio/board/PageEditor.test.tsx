import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { DocOp } from '../../../shared/comic/ops';
import { PageEditor, editActionFor, fitPageToStage, lineKindOps } from './PageEditor';
import { SAMPLE_NOW, fakeUrlFor, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { lineSourceHash } from '../../../shared/comic/i18n';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioController } from '../types';

// Prices follow the usage rule; the allowance store is pinned here (no network in tests).
const allowance = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('../../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

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

  it('a right-to-left book turns the other way: ← goes forward, and the header arrows swap sides', () => {
    const doc = makeSampleDoc((d) => {
      d.format.readingDirection = 'rtl';
    });
    const { studio } = open('pg_2', doc);
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(studio.openPage).toHaveBeenLastCalledWith('pg_3');
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(studio.openPage).toHaveBeenLastCalledWith('pg_1');
    // "Next page" is the left-hand header button (it points left, the way the page turns).
    const header = screen.getByTestId('editor-header');
    const turnButtons = within(header)
      .getAllByRole('button')
      .filter((b) => /^(Next|Previous) page$/.test(b.getAttribute('aria-label') || b.textContent || ''));
    expect(turnButtons.map((b) => b.getAttribute('aria-label') || b.textContent)).toEqual(['Next page', 'Previous page']);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(studio.openPage).toHaveBeenLastCalledWith('pg_3');
  });

  it('a right-to-left book stops at its ends (← on the last page does nothing)', () => {
    const doc = makeSampleDoc((d) => {
      d.format.readingDirection = 'rtl';
    });
    const last = [...doc.pages].sort((a, b) => b.n - a.n)[0];
    const { studio } = open(last.id, doc);
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(studio.openPage).not.toHaveBeenCalled();
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

  it('a marked area keeps four corner handles that adjust it (drag or arrow keys) without redrawing', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: /Mark up/ }));
    markRegion([40, 300], [200, 480]);
    const corner = screen.getByTestId('markup-corner-se');
    expect(corner).toHaveAttribute('aria-label', 'Resize the marked area from its bottom-right corner (arrow keys move it)');
    // Drag the bottom-right corner out to (280, 540): the top-left corner stays put.
    fireEvent.pointerDown(corner, { clientX: 200, clientY: 480, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 280, clientY: 540 });
    fireEvent.pointerUp(window, { clientX: 280, clientY: 540 });
    const region = screen.getByTestId('markup-region');
    expect(region.style.left).toBe('10%');
    expect(region.style.top).toBe('50%');
    expect(region.style.width).toBe('60%');
    expect(parseFloat(region.style.height)).toBeCloseTo(40, 4);
    // Arrow keys nudge the top-left corner (1 % per step).
    fireEvent.keyDown(screen.getByTestId('markup-corner-nw'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('markup-region').style.left).toBe('9%');
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

  it('uses a previous version for free (VersionStack → optimistic render_use)', () => {
    const { studio } = open();
    const versions = screen.getByRole('region', { name: 'Versions' });
    const older = within(versions)
      .getAllByRole('radio')
      .find((r) => !/current/.test(r.getAttribute('aria-label') || ''))!;
    fireEvent.click(older);
    fireEvent.click(within(versions).getByRole('button', { name: /^Use v\d · Free$/ }));
    const [ops, opts] = (studio.patch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(ops[0]).toMatchObject({ op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/proj/pages/p1.png.old' });
    expect(opts).toEqual({ label: 'Use version' });
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('re-renders and re-letters', () => {
    const { studio } = open();
    fireEvent.click(screen.getByRole('button', { name: /Try another take/ }));
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
    expect(screen.getByTestId('editor-stage').className).toMatch(/\bflex-1\b/);
    // The aside has a fixed width beside it (360 px at 1024): it can never be pushed off-screen.
    const aside = document.querySelector<HTMLElement>('[data-tools="aside"]')!;
    expect(aside.style.width).toBe('360px');
    expect(aside.className).toContain('shrink-0');
  });
});

// ── P2-EDITOR: integration ───────────────────────────────────────────────────

const PHONE = formFactorFor({ w: 390, h: 844, coarse: true });
const PHONE_LANDSCAPE = formFactorFor({ w: 844, h: 390, coarse: true });
const TABLET_PORTRAIT = formFactorFor({ w: 820, h: 1180, coarse: true });

const openAt = (ff: ReturnType<typeof formFactorFor> | null, doc: ComicDoc = makeSampleDoc(), overrides: Partial<StudioController> = {}, pageId = 'pg_1') => {
  const studio = makeStudio(doc, { focusedPageId: pageId, ...overrides });
  const ui = <PageEditor studio={studio} doc={doc} pageId={pageId} />;
  const utils = render(ff ? <FormFactorProvider value={ff}>{ui}</FormFactorProvider> : ui);
  return { ...utils, studio, doc };
};

const hitOf = (lineId: string) => document.querySelector<HTMLElement>(`[data-testid="balloon-hit"][data-line-id="${lineId}"]`)!;
const lastPatch = (studio: StudioController) => (studio.patch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;

/** The sample doc with a Telugu edition (one line translated, one software-placed). */
const withTelugu = () =>
  makeSampleDoc((d) => {
    const line = d.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l2')!;
    d.i18n = {
      glossary: [],
      editions: { te: { lang: 'te', register: 'everyday', lines: { pg_1_l2: { text: 'పదండి!', status: 'reviewed', sourceHash: lineSourceHash(line), at: SAMPLE_NOW } }, balloons: {} } }
    };
  });

describe('PageEditor — prices, versions, aspect and safety (P2-EDITOR)', () => {
  afterEach(() => {
    allowance.status = null;
  });

  it('governed users see a share of their usage, never dollars; admins see the price', () => {
    allowance.status = {
      enabled: true,
      governed: true,
      pctUsed: 10,
      pctLeft: 90,
      exhausted: false,
      crossed: [],
      resetsAt: null,
      friendlyUnits: { standardPages: 100, draftPages: 300, pctPerStandardPage: 1, label: '' },
      usePlatformAllowance: true,
      byokFallbackMode: 'ask',
      byokAvailable: false
    };
    const { unmount } = open();
    const apply = screen.getByRole('button', { name: /Apply edit/ });
    expect(apply).toHaveTextContent(/% of your usage/);
    expect(apply.textContent).not.toMatch(/\$/);
    expect(screen.getByRole('button', { name: /Try another take/ })).toHaveTextContent(/% of your usage/);
    unmount();
    allowance.status = { ...(allowance.status as object), governed: false };
    open();
    expect(screen.getByRole('button', { name: /Apply edit/ })).toHaveTextContent(/\$\d/);
  });

  it('"Try another take ≈ cost" sits beside "Pick from n versions (free)", which jumps to the versions', () => {
    const { studio } = open();
    const group = screen.getByRole('group', { name: 'Another take or a saved version' });
    expect(within(group).getByRole('button', { name: /Try another take/ })).toBeInTheDocument();
    const pick = within(group).getByRole('button', { name: /Pick from 2 versions/ });
    expect(pick).toHaveTextContent('Free');
    const scroll = vi.fn();
    const versions = screen.getByRole('region', { name: 'Versions' });
    versions.scrollIntoView = scroll;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    fireEvent.click(pick);
    raf.mockRestore();
    expect(scroll).toHaveBeenCalled();
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('a page that came back the wrong shape offers the free fit', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, w: 1024, h: 1024 };
    });
    const { studio } = openAt(null, doc);
    const notice = screen.getByTestId('aspect-notice');
    expect(notice).toHaveTextContent('This page came back 1:1, but your book is 2:3');
    fireEvent.click(within(notice).getByRole('button', { name: /Fit to 2:3 · Free/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'fit_render', target: { kind: 'page', id: 'pg_1' } });
  });

  it('safety: a blocked take is a tile with Redraw safer (a safe forced redraw) and Check again', () => {
    // An admin (not governed): the veil's price reads in dollars, like the editor's own Redraw.
    allowance.status = {
      enabled: true,
      governed: false,
      pctUsed: 0,
      pctLeft: 100,
      exhausted: false,
      crossed: [],
      resetsAt: null,
      friendlyUnits: null,
      usePlatformAllowance: true,
      byokFallbackMode: 'ask',
      byokAvailable: false
    };
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, safety: { assessed: 'X', at: 1 } };
    });
    const { studio } = openAt(null, doc);
    const stage = screen.getByTestId('editor-canvas-area');
    expect(stage.querySelector('img')).toBeNull();
    // Priced like Redraw (it is this page's forced render): admins and own keys read the price — the
    // same figure the editor's own Redraw shows.
    const redraw = within(stage).getByRole('button', { name: /^Redraw safer · \$\d/ });
    expect(screen.getByRole('button', { name: /Try another take/ }).textContent).toContain(redraw.textContent!.split(' · ')[1]);
    fireEvent.click(redraw);
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_1'], force: true, safe: true });
    fireEvent.click(within(stage).getByRole('button', { name: 'Check again' }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'safety_recheck', target: { kind: 'page', id: 'pg_1' } });
  });

  it('safety: Redraw safer on the veil carries its price in usage terms for governed users (never dollars)', () => {
    allowance.status = {
      enabled: true,
      governed: true,
      pctUsed: 10,
      pctLeft: 90,
      exhausted: false,
      crossed: [],
      resetsAt: null,
      friendlyUnits: { standardPages: 100, draftPages: 300, pctPerStandardPage: 1, label: '' },
      usePlatformAllowance: true,
      byokFallbackMode: 'ask',
      byokAvailable: false
    };
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, safety: { assessed: 'X', at: 1 } };
    });
    const { studio } = openAt(null, doc);
    const redraw = within(screen.getByTestId('editor-canvas-area')).getByRole('button', { name: /^Redraw safer · / });
    expect(redraw).toHaveTextContent(/% of your usage/);
    expect(redraw.textContent).not.toMatch(/\$/);
    // The same quote the editor's own Redraw shows.
    expect(screen.getByRole('button', { name: /Try another take/ }).textContent).toContain(redraw.textContent!.split(' · ')[1]);
    fireEvent.click(redraw);
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_1'], force: true, safe: true });
  });

  it('safety: a blocked take cannot be marked up, AI-edited or fitted — the tools say why (no paid call is ever offered on it)', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, w: 1024, h: 1024, safety: { assessed: 'X', at: 1 } };
    });
    const { studio } = openAt(null, doc);
    expect(screen.getByRole('radio', { name: /Mark up/ })).toBeDisabled();
    const field = screen.getByLabelText('What should change?');
    expect(field).toBeDisabled();
    expect(field.getAttribute('placeholder')).toMatch(/didn’t fit the content rules.*redraw it safer.*earlier version/);
    fireEvent.change(field, { target: { value: 'Make it night' } });
    expect(screen.getByRole('button', { name: /Apply edit/ })).toBeDisabled();
    // The 1:1 take would normally offer the free fit: not on a withheld image.
    expect(screen.queryByTestId('aspect-notice')).toBeNull();
    expect(screen.queryByTestId('markup-layer')!.getAttribute('aria-hidden')).toBe('true');
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('safety: over the comic’s rating the page is veiled; Change rating opens the Story tab', () => {
    const doc = makeSampleDoc((d) => {
      d.settings = { ...d.settings, rating: 'PG' };
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, safety: { assessed: 'PG-13', at: 1 } };
    });
    const { studio } = openAt(null, doc);
    fireEvent.click(within(screen.getByTestId('editor-canvas-area')).getByRole('button', { name: 'Change rating' }));
    expect(studio.setTab).toHaveBeenCalledWith('story');
    expect(studio.openPage).toHaveBeenCalledWith(null);
  });
});

describe('PageEditor — balloon menu (mobile.md §5.5)', () => {
  it('right-click opens Edit text · Style · Duplicate · front/back · Lock · Reset · Delete; Duplicate is one free undoable batch', () => {
    const { studio } = open();
    fireEvent.contextMenu(hitOf('pg_1_l2'), { clientX: 120, clientY: 300 });
    const menu = screen.getByRole('menu', { name: 'Whisper balloon' });
    const items = within(menu).getAllByRole('menuitem').map((b) => b.textContent);
    expect(items.join('|')).toMatch(/Edit text.*Style….*Duplicate.*Bring to front.*Send to back.*Lock.*Reset position \(auto\).*Delete/);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Duplicate/ }));
    const [ops, opts] = lastPatch(studio);
    expect(ops[0]).toMatchObject({ op: 'line', pageId: 'pg_1' });
    expect(opts).toEqual({ undo: true, label: 'Duplicate balloon' });
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('Delete removes the line (undoable)', () => {
    const { studio } = open();
    fireEvent.keyDown(hitOf('pg_1_l3'), { key: 'ContextMenu' });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Delete/ }));
    const [ops, opts] = lastPatch(studio);
    expect(ops).toEqual([expect.objectContaining({ op: 'line', id: 'pg_1_l3', patch: null })]);
    expect(opts).toMatchObject({ undo: true, label: 'Delete balloon' });
  });
});

describe('PageEditor — editing a translated edition (i18n.md §10.2)', () => {
  it('the language switch edits Telugu: banner, edition_balloon drags, translation typing; the original is never touched', () => {
    const { studio } = openAt(null, withTelugu());
    const sw = screen.getByRole('radiogroup', { name: 'Edit which language' });
    fireEvent.click(within(sw).getByRole('radio', { name: /తెలుగు/ }));
    expect(screen.getByTestId('edition-banner')).toHaveTextContent('Editing the Telugu edition. The art is shared by every language.');
    // The stage letters the translation.
    expect(hitOf('pg_1_l2').getAttribute('aria-label')).toContain('పదండి!');
    // A nudge is an edition_balloon op (this language only).
    fireEvent.keyDown(hitOf('pg_1_l2'), { key: 'ArrowRight' });
    const [ops, opts] = lastPatch(studio);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'edition_balloon', lang: 'te', lineId: 'pg_1_l2', patch: { x: 0.065, y: 0.5, pinned: true } });
    expect(opts).toMatchObject({ undo: true, label: 'Move balloon' });
    // The script shows a Telugu field under each line; typing commits a translation.
    const field = within(document.querySelector<HTMLElement>('[data-testid="line-row"][data-line-id="pg_1_l4"]')!).getByLabelText('Telugu translation');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'నువ్వు వివరించాలి.' } });
    fireEvent.blur(field);
    const [tops] = lastPatch(studio);
    expect(tops[0]).toMatchObject({ op: 'translation', lang: 'te', lineId: 'pg_1_l4', patch: { text: 'నువ్వు వివరించాలి.', status: 'edited' } });
    expect((studio.patch as ReturnType<typeof vi.fn>).mock.calls.flatMap((c) => c[0]).some((o: { op: string }) => o.op === 'line' || o.op === 'balloon')).toBe(false);
  });

  it('adding a line in an edition explains that new lines start in the original; Duplicate/Delete are off there', () => {
    const { studio } = openAt(null, withTelugu());
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Edit which language' })).getByRole('radio', { name: /తెలుగు/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add speech balloon' }));
    expect(screen.getByText(/New lines start in the original \(English\)/)).toBeInTheDocument();
    fireEvent.contextMenu(hitOf('pg_1_l2'), { clientX: 5, clientY: 5 });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Edit translation/ })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: /Duplicate/ })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: /Delete/ })).toBeDisabled();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Reset position/ }));
    expect(lastPatch(studio)[0]).toEqual([{ op: 'edition_balloon', lang: 'te', lineId: 'pg_1_l2', patch: null }]);
  });

  it('a “don’t translate” line stays in the original: no inline edit, no translation, and the editor says why', () => {
    const doc = withTelugu();
    doc.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l1')!.noTranslate = true;
    const { studio } = openAt(null, doc);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Edit which language' })).getByRole('radio', { name: /తెలుగు/ }));
    fireEvent.contextMenu(hitOf('pg_1_l1'), { clientX: 5, clientY: 5 });
    const item = within(screen.getByRole('menu')).getByRole('menuitem', { name: /Edit translation/ });
    expect(item).toBeDisabled();
    expect(item).toHaveTextContent('Stays in English');
    fireEvent.doubleClick(hitOf('pg_1_l1'));
    expect(screen.getByText(/This line stays in English in every language/)).toBeInTheDocument();
    expect(screen.queryByTestId('balloon-text-editor')).toBeNull();
    // A translated line still opens its inline editor (the translation is what it edits).
    fireEvent.doubleClick(hitOf('pg_1_l2'));
    expect((screen.getByTestId('balloon-text-editor') as HTMLTextAreaElement).value).toBe('పదండి!');
    expect((studio.patch as ReturnType<typeof vi.fn>).mock.calls.flatMap((c) => c[0]).some((o: { op: string }) => o.op === 'translation' || o.op === 'line')).toBe(false);
    // The script has no Telugu field for it either.
    expect(within(lineRow('pg_1_l1')).queryByLabelText('Telugu translation')).toBeNull();
  });
});

describe('PageEditor — phones, tablets and foldables (mobile.md §5.6)', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* no storage */
    }
  });

  it('phone portrait: the page in a TouchCanvas, the bottom toolbar, the tools in a non-modal sheet', () => {
    openAt(PHONE);
    expect(document.querySelector('[data-editor-layout="phone"]')).toBeTruthy();
    // Full-bleed: no backdrop to tap; safe areas padded by the dialog.
    expect(screen.getByRole('dialog', { name: 'Page 1 editor' }).getAttribute('style')).toContain('--sa-top');
    expect(screen.getByTestId('editor-canvas-area').querySelector('[data-zoom]')).toBeTruthy();
    const bar = screen.getByRole('toolbar', { name: 'Page editor' });
    expect(bar).toHaveAttribute('data-orientation', 'horizontal');
    const sheet = screen.getByRole('region', { name: 'Page tools sheet' });
    expect(sheet).toHaveAttribute('data-detent', 'peek');
    expect(within(sheet).getByRole('complementary', { name: 'Page tools' })).toBeInTheDocument();
    // The mode row moved to the thumb zone: no desktop mode row.
    expect(screen.queryByTestId('editor-mode-row')).toBeNull();
    fireEvent.click(within(bar).getByRole('radio', { name: 'Mark up' }));
    expect(screen.getByTestId('markup-layer').className).toContain('cursor-crosshair');
    // Tools closes the sheet (remembered on this device) and opens it again.
    fireEvent.click(within(bar).getByRole('button', { name: 'Hide page tools' }));
    expect(screen.queryByRole('region', { name: 'Page tools sheet' })).toBeNull();
    expect(window.localStorage.getItem('cs.editor.tools')).toBe('closed');
    fireEvent.click(within(bar).getByRole('button', { name: 'Page tools' }));
    expect(screen.getByRole('region', { name: 'Page tools sheet' })).toBeInTheDocument();
  });

  it('phone: Lettering opens the tray; + Speech then a tap on the page adds a line (free, undoable)', () => {
    const { studio } = openAt(PHONE);
    fireEvent.click(screen.getByRole('button', { name: 'Lettering' }));
    const tray = screen.getByRole('toolbar', { name: 'Lettering tools' });
    fireEvent.click(within(tray).getByRole('button', { name: 'Add a speech balloon' }));
    expect(screen.getByTestId('editor-phone-row')).toHaveTextContent('Tap on the page to place the speech');
    const layer = document.querySelector<HTMLElement>('[data-testid="balloon-layer"]')!;
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 450, right: 300, bottom: 450, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 350, button: 0, pointerType: 'touch' });
    const [ops, opts] = lastPatch(studio);
    expect(ops[0]).toMatchObject({ op: 'line', patch: { kind: 'speech', text: 'Hello!' } });
    expect(opts).toEqual({ undo: true, label: 'Add speech' });
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('phone: the lettering inspector is a bottom sheet; the tools sheet steps aside and undo floats above it', () => {
    openAt(PHONE);
    fireEvent.focus(hitOf('pg_1_l4'));
    expect(screen.getByTestId('lettering-inspector')).toHaveAttribute('data-presentation', 'sheet');
    expect(screen.queryByRole('region', { name: 'Page tools sheet' })).toBeNull();
    expect(within(screen.getByTestId('editor-canvas-area')).getByRole('group', { name: 'Undo and redo' })).toBeInTheDocument();
  });

  it('phone: the image variant follows the page with no sheet over it — opening the inspector never swaps in a smaller file', () => {
    // The resting fit box is 340 × 600; the stage under the tools sheet / inspector is only 340 × 240.
    const proto = HTMLElement.prototype.getBoundingClientRect;
    const box = (w: number, h: number) => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.getAttribute('data-testid');
      if (id === 'editor-resting-stage') return box(340, 600);
      if (id === 'editor-stage-content') return box(340, 240);
      return proto.call(this);
    });
    try {
      const urlFor = vi.fn((a?: Parameters<StudioController['urlFor']>[0], o?: { width?: number }) => {
        const u = fakeUrlFor(a);
        return u && o?.width ? `${u}?w=${o.width}` : u;
      });
      openAt(PHONE, makeSampleDoc(), { urlFor });
      const stageImg = () => screen.getByTestId('editor-canvas-area').querySelector<HTMLImageElement>('[data-testid="comic-page"] img')!;
      // 2:3 page in 340 × 600 → 340 css px wide (the shrunk stage would give 160).
      expect(stageImg().getAttribute('src')).toMatch(/\?w=340$/);
      fireEvent.focus(hitOf('pg_1_l4'));
      expect(screen.getByTestId('lettering-inspector')).toBeInTheDocument();
      expect(stageImg().getAttribute('src')).toMatch(/\?w=340$/);
      // The page itself still fits the shrunk stage (160 px), so the selection stays above the sheet.
      expect(stageImg().closest<HTMLElement>('[data-testid="comic-page"]')!.parentElement!.style.width).toBe('160px');
    } finally {
      spy.mockRestore();
    }
  });

  it('phone: the balloon menu is the only sheet while it is open; “Style…” then brings up the inspector', () => {
    openAt(PHONE);
    fireEvent.contextMenu(hitOf('pg_1_l4'), { clientX: 200, clientY: 400 });
    const menu = screen.getByRole('menu');
    // Selected, but no second (inspector) sheet stacked under the menu, and the tools sheet stays put.
    expect(hitOf('pg_1_l4')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('lettering-inspector')).toBeNull();
    expect(screen.getByRole('region', { name: 'Page tools sheet' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Style…/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('lettering-inspector')).toHaveAttribute('data-presentation', 'sheet');
  });

  it('phone: zoomed in, picking a line whose balloon is off screen eases back to fit (pinch-zoom itself never does)', () => {
    openAt(PHONE);
    const rect = (left: number, top: number, width: number, height: number) => () =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    screen.getByTestId('editor-canvas-area').getBoundingClientRect = rect(0, 0, 390, 400);
    const canvas = document.querySelector<HTMLElement>('[data-zoom]')!;
    fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -300, clientX: 50, clientY: 50 });
    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(1.5);
    // Zoomed on the top-left: the page box is far larger than the stage.
    document.querySelector<HTMLElement>('[data-testid="comic-page"]')!.parentElement!.getBoundingClientRect = rect(-20, -20, 1600, 2400);
    // Re-rendering (here: the tools sheet stepping to half) never resets a pinch zoom.
    fireEvent.click(screen.getByRole('button', { name: /Resize page tools/ }));
    expect(Number(canvas.getAttribute('data-zoom'))).toBeGreaterThan(1.5);
    fireEvent.click(lineRow('pg_1_l5')); // bottom-right of the page: off screen → back to fit
    expect(canvas.getAttribute('data-zoom')).toBe('1.00');
  });

  it('phone: a one-time coach mark on touch; a header swipe turns the page', () => {
    const { studio } = openAt(PHONE, makeSampleDoc(), {}, 'pg_2');
    const coach = screen.getByTestId('editor-coach');
    expect(coach).toHaveTextContent('Tap a balloon to select, drag to move, pinch to zoom, long-press for more.');
    fireEvent.click(within(coach).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('editor-coach')).toBeNull();
    expect(window.localStorage.getItem('cs.coach.editor')).toBe('1');
    const header = screen.getByTestId('editor-header');
    fireEvent.pointerDown(header, { clientX: 300, clientY: 20, pointerType: 'touch', pointerId: 7 });
    fireEvent.pointerUp(header, { clientX: 200, clientY: 26, pointerId: 7 });
    expect(studio.openPage).toHaveBeenLastCalledWith('pg_3');
  });

  it('phone landscape: a left rail and a side sheet that collapses to a 44 px tab', () => {
    openAt(PHONE_LANDSCAPE);
    expect(document.querySelector('[data-editor-layout="phone-landscape"]')).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: 'Page editor' })).toHaveAttribute('data-orientation', 'vertical');
    expect(document.querySelector<HTMLElement>('[data-tools="side"]')!.style.width).toBe('320px');
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-tools="side"]')!).getByRole('button', { name: 'Hide page tools' }));
    expect(screen.getByRole('button', { name: 'Show page tools' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Page tools' })).toBeNull();
  });

  it('tablet portrait: the mode row on top and the tools in a bottom sheet that stays (no toolbar to reopen it)', () => {
    openAt(TABLET_PORTRAIT);
    expect(screen.getByTestId('editor-mode-row')).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Page editor' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Page tools sheet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close page tools' })).toBeNull();
  });

  it('book-posture foldable: the page on one screen, the tools on the other', () => {
    const rect = (x: number, w: number) => ({ left: x, top: 0, width: w, height: 1080, right: x + w, bottom: 1080, x, y: 0, toJSON: () => ({}) }) as DOMRectReadOnly;
    openAt(formFactorFor({ w: 1688, h: 1080, coarse: true, segments: { count: 2, axis: 'horizontal', rects: [rect(0, 828), rect(860, 828)], hinge: { start: 828, end: 860 } } }));
    const grid = document.querySelector<HTMLElement>('[data-layout="fold-book"]')!;
    expect(grid.style.gridTemplateColumns).toBe('minmax(0, 828px) 32px minmax(0, 1fr)');
    expect(grid.querySelector('[data-hinge]')).toBeTruthy();
    expect(within(grid).getByRole('complementary', { name: 'Page tools' })).toBeInTheDocument();
  });

  it('desktop keeps the backdrop (pointer-down outside closes) and shows the mini filmstrip under the stage', () => {
    const { studio } = openAt(formFactorFor({ w: 1440, h: 900 }));
    expect(screen.getByTestId('editor-filmstrip')).toBeInTheDocument();
    const backdrop = document.querySelector<HTMLElement>('[data-editor-layout="desktop"]')!;
    fireEvent.pointerDown(backdrop);
    expect(studio.openPage).toHaveBeenCalledWith(null);
  });
});
