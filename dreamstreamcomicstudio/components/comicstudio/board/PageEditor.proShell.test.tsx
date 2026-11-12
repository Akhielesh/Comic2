// The Pro shell in the page editor (PE-SHELL; master plan §2.2, §2.7): the header Easy | Pro switch (one concept: no op),
// Shift+P, the toolbar duplicate gone only with the flag on, D7 on phones, the docked workspace at 1280, the tool rail,
// in-art comics, the arrow-key fix (graft 4), Made in Pro, presence and "Edit lettering".

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { IN_ART_LETTERING_NOTE, MADE_IN_PRO_CHIP, PRO_FREE_FOOTER } from '../../../shared/comic/pro/types';
import { PageEditor } from './PageEditor';
import { PagesTab } from './PagesTab';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import type { StudioController } from '../types';
import { EDITOR_MODE_KEY } from '../editor/useProEditor';
import { MODE_GROUP_LABEL } from '../editor/ProTopBar';

const allowance = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('../../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DESKTOP = formFactorFor({ w: 1280, h: 800 });
const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });
const TABLET = formFactorFor({ w: 768, h: 1024, coarse: true });
const FLAG_ON: StudioCaps = { ...DEFAULT_CAPS, proEditorV2: true };

const open = (o: { ff?: ReturnType<typeof formFactorFor>; mode?: 'easy' | 'pro'; caps?: StudioCaps; doc?: ComicDoc; pageId?: string; studio?: Partial<StudioController> } = {}) => {
  const doc = o.doc ?? makeSampleDoc();
  const pageId = o.pageId ?? 'pg_1';
  const studio = makeStudio(doc, { focusedPageId: pageId, caps: o.caps ?? FLAG_ON, mode: o.mode ?? 'easy', ...(o.studio || {}) });
  const utils = render(
    <FormFactorProvider value={o.ff ?? DESKTOP}>
      <PageEditor studio={studio} doc={doc} pageId={pageId} />
    </FormFactorProvider>
  );
  return { ...utils, studio, doc };
};

const header = () => screen.getByTestId('editor-header');
const modeSwitch = () => within(header()).getByRole('radiogroup', { name: MODE_GROUP_LABEL });

describe('the Easy | Pro switch (flag on)', () => {
  it('sits in the header, named "Easy or Pro mode", its Pro option read as "Pro mode"', () => {
    open();
    const group = modeSwitch();
    expect(within(group).getByRole('radio', { name: 'Pro mode' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'Easy mode' })).toHaveAttribute('aria-checked', 'true');
  });

  it('writes setMode and sends NO op (one concept: the document and the undo stack never change)', () => {
    const { studio } = open();
    fireEvent.click(within(modeSwitch()).getByRole('radio', { name: 'Pro mode' }));
    expect(studio.setMode).toHaveBeenCalledWith('pro');
    expect(studio.patch).not.toHaveBeenCalled();
    expect(studio.act).not.toHaveBeenCalled();
    expect(studio.undo).not.toHaveBeenCalled();
  });

  it('Shift+P toggles the view, and is ignored while typing', () => {
    const { studio } = open();
    fireEvent.keyDown(document.body, { key: 'P', shiftKey: true });
    expect(studio.setMode).toHaveBeenLastCalledWith('pro');
    (studio.setMode as ReturnType<typeof vi.fn>).mockClear();
    const textarea = document.getElementById('pe-instruction')!;
    fireEvent.keyDown(textarea, { key: 'P', shiftKey: true });
    expect(studio.setMode).not.toHaveBeenCalled();
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('the lettering toolbar’s duplicate switch is gone with the flag on, and stays with it off', () => {
    open({ studio: { selection: null } });
    expect(screen.queryByRole('radiogroup', { name: 'Editor view' })).toBeNull();
    cleanup();
    open({ caps: { ...DEFAULT_CAPS, proEditorV2: false } });
    expect(screen.getAllByRole('radiogroup', { name: 'Editor view' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('radiogroup', { name: MODE_GROUP_LABEL })).toBeNull();
  });

  it('Shift+P does nothing with the flag off', () => {
    const { studio } = open({ caps: { ...DEFAULT_CAPS, proEditorV2: false } });
    fireEvent.keyDown(document.body, { key: 'P', shiftKey: true });
    expect(studio.setMode).not.toHaveBeenCalled();
  });
});

describe('D7: phones open in Easy first, then remember this device’s last choice', () => {
  it('a paid user (default Pro) sees Easy on a phone’s first open', () => {
    open({ ff: PHONE, mode: 'pro' });
    expect(within(modeSwitch()).getByRole('radio', { name: 'Easy mode' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('pro-tool-rail')).toBeNull();
  });

  it('choosing Pro on the phone is remembered on this device (localStorage) and calls setMode', () => {
    const { studio } = open({ ff: PHONE, mode: 'easy' });
    fireEvent.click(within(modeSwitch()).getByRole('radio', { name: 'Pro mode' }));
    expect(window.localStorage.getItem(EDITOR_MODE_KEY)).toBe('pro');
    expect(studio.setMode).toHaveBeenCalledWith('pro');
    cleanup();
    open({ ff: PHONE, mode: 'easy' });
    expect(within(modeSwitch()).getByRole('radio', { name: 'Pro mode' })).toHaveAttribute('aria-checked', 'true');
  });

  it('desktop follows studio.mode (no per-device override)', () => {
    window.localStorage.setItem(EDITOR_MODE_KEY, 'easy');
    open({ ff: DESKTOP, mode: 'pro' });
    expect(within(modeSwitch()).getByRole('radio', { name: 'Pro mode' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the docked Pro workspace (1280 × 800)', () => {
  it('rail, canvas and a 400 px inspector column: Properties and AI tabs, the free footer, Edit with AI in AI', () => {
    open({ mode: 'pro' });
    const dock = screen.getByTestId('pro-dock');
    expect(dock.style.width).toBe('400px');
    expect(screen.getByTestId('pro-tool-rail')).toHaveAttribute('aria-orientation', 'vertical');
    expect(document.querySelector('[data-pro-workspace="docked"]')).not.toBeNull();
    const tabs = within(dock).getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Properties', 'AI']);
    expect(within(dock).getByTestId('pro-free-footer').textContent).toBe(PRO_FREE_FOOTER);
    // The priced tool lives in the AI tab, with no "free" footer.
    fireEvent.click(within(dock).getByRole('tab', { name: 'AI' }));
    expect(within(dock).getByRole('heading', { name: /Edit with AI/ })).toBeInTheDocument();
    expect(within(dock).queryByTestId('pro-free-footer')).toBeNull();
    // Today's aside is replaced, not stacked beside the dock.
    expect(document.querySelectorAll('#pe-instruction')).toHaveLength(1);
  });

  it('the dock is a column of the layout (never a floating layer over the page)', () => {
    open({ mode: 'pro' });
    const dock = screen.getByTestId('pro-dock');
    const row = dock.parentElement!;
    expect(row.getAttribute('data-pro-workspace')).toBe('docked');
    expect(row.className).toMatch(/\bflex-row\b/);
    expect(dock.className).not.toMatch(/\b(fixed|absolute)\b/);
    expect(dock.className).toMatch(/\bshrink-0\b/);
  });

  it('the tool keys pick tools in Pro (B arms a speech balloon; Esc puts Select back)', () => {
    open({ mode: 'pro' });
    const rail = screen.getByTestId('pro-tool-rail');
    fireEvent.keyDown(document.body, { key: 'b' });
    expect(within(rail).getByRole('button', { name: 'Balloon' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('balloon-layer').className).toMatch(/cursor-crosshair/);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(within(rail).getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Shapes waits for the compose part (overlays must draw first)', () => {
    open({ mode: 'pro' });
    expect(within(screen.getByTestId('pro-tool-rail')).queryByRole('button', { name: 'Shapes' })).toBeNull();
  });

  it('tablet portrait: the tools are a row under the top bar', () => {
    open({ ff: TABLET, mode: 'pro' });
    expect(screen.getByTestId('pro-tool-rail')).toHaveAttribute('aria-orientation', 'horizontal');
    expect(screen.queryByTestId('pro-dock')).toBeNull();
  });
});

describe('in-art comics (§2.2 rule 6)', () => {
  it('Text, Balloon and Sound effect are off with the in-art note; the rest still work', () => {
    const doc = makeSampleDoc((d) => {
      d.format.lettering = 'in_art';
    });
    open({ mode: 'pro', doc });
    const rail = screen.getByTestId('pro-tool-rail');
    for (const name of ['Text', 'Balloon', 'Sound effect']) {
      const b = within(rail).getByRole('button', { name });
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b.getAttribute('title')).toContain(IN_ART_LETTERING_NOTE);
    }
    expect(within(rail).getByRole('button', { name: 'Mark up' })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('in-art-note').textContent).toBe(IN_ART_LETTERING_NOTE);
    fireEvent.keyDown(document.body, { key: 't' });
    expect(within(rail).getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the arrow-key fix (graft 4)', () => {
  const withLayer = () =>
    makeSampleDoc((d) => {
      d.pages[1].layers = [{ id: 'ly_1', kind: 'shape', box: { x: 0.2, y: 0.2, w: 0.2, h: 0.1 }, shape: { type: 'rect' } }];
    });

  it('an arrow key with an overlay selected nudges it and does NOT turn the page', () => {
    const doc = withLayer();
    const { studio } = open({ doc, pageId: 'pg_2', studio: { selection: { pageId: 'pg_2', lineIds: [], layerIds: ['ly_1'], surface: 'page_editor' } } });
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(studio.openPage).not.toHaveBeenCalled();
    expect(studio.patch).toHaveBeenCalledTimes(1);
    const [ops, opts] = (studio.patch as ReturnType<typeof vi.fn>).mock.calls[0] as [DocOp[], { undo: boolean; coalesce: string }];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'layer', pageId: 'pg_2', id: 'ly_1' });
    expect((ops[0] as Extract<DocOp, { op: 'layer' }>).patch.box?.x).toBeCloseTo(0.205, 4);
    expect(opts).toMatchObject({ undo: true, coalesce: 'layer:move:pg_2:ly_1' });
  });

  it('a selected panel holds the arrows too (no page turn)', () => {
    const { studio } = open({ pageId: 'pg_2', studio: { selection: { pageId: 'pg_2', lineIds: [], panelIds: ['pn_x'], surface: 'page_editor' } } });
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(studio.openPage).not.toHaveBeenCalled();
  });

  it('nothing selected still turns the page (today)', () => {
    const { studio } = open({ pageId: 'pg_2' });
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(studio.openPage).toHaveBeenLastCalledWith('pg_3');
  });
});

describe('Easy keeps Pro-made balloons movable and says so (rule 2)', () => {
  it('a selected balloon with a rotation shows "Made in Pro · Open in Pro", which opens Pro', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l2' ? { ...b, rot: 15 } : b));
    });
    const { studio } = open({ doc, studio: { selection: { pageId: 'pg_1', lineIds: ['pg_1_l2'], surface: 'page_editor' } } });
    const chip = screen.getByTestId('made-in-pro-chip');
    expect(chip.textContent).toBe(MADE_IN_PRO_CHIP);
    fireEvent.click(chip);
    expect(studio.setMode).toHaveBeenCalledWith('pro');
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('a plain balloon shows no chip', () => {
    open({ studio: { selection: { pageId: 'pg_1', lineIds: ['pg_1_l2'], surface: 'page_editor' } } });
    expect(screen.queryByTestId('made-in-pro-chip')).toBeNull();
  });
});

describe('presence (A4 fills StudioController.presence)', () => {
  it('outlines the balloon the director is editing, flag on or off', () => {
    open({ studio: { presence: { pageId: 'pg_1', lineIds: ['pg_1_l3'], label: 'Moving a balloon', at: SAMPLE_NOW } } });
    const hit = document.querySelector('[data-testid="balloon-hit"][data-line-id="pg_1_l3"]')!;
    expect(hit.querySelector('[data-testid="presence-chip"]')?.textContent).toBe('Director is editing this balloon');
    cleanup();
    open({ caps: { ...DEFAULT_CAPS, proEditorV2: false }, studio: { presence: { pageId: 'pg_1', lineIds: ['pg_1_l3'], label: 'x', at: SAMPLE_NOW } } });
    expect(document.querySelector('[data-testid="presence-outline"]')).not.toBeNull();
  });

  it('presence on another page outlines nothing here', () => {
    open({ studio: { presence: { pageId: 'pg_2', lineIds: ['pg_1_l3'], label: 'x', at: SAMPLE_NOW } } });
    expect(document.querySelector('[data-testid="presence-outline"]')).toBeNull();
  });
});

describe('the shortcut sheet (?)', () => {
  it('opens from ? and the header button, closes with Esc; never with the flag off', () => {
    open({ mode: 'pro' });
    fireEvent.keyDown(document.body, { key: '?' });
    const sheet = screen.getByTestId('pro-shortcuts');
    expect(within(sheet).getByText('Tab / Shift+Tab')).toBeInTheDocument();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByTestId('pro-shortcuts')).toBeNull();
    fireEvent.click(screen.getByTestId('pro-help'));
    expect(screen.getByTestId('pro-shortcuts')).toBeInTheDocument();
    cleanup();
    open({ caps: { ...DEFAULT_CAPS, proEditorV2: false } });
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.queryByTestId('pro-shortcuts')).toBeNull();
  });
});

describe('"Edit lettering" on the Pages card (flag on)', () => {
  it('opens the same editor with the first balloon selected; absent with the flag off', () => {
    const doc = makeSampleDoc();
    const studio = makeStudio(doc, { caps: FLAG_ON });
    render(<PagesTab studio={studio} doc={doc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit lettering on page 1' }));
    expect(studio.setSelection).toHaveBeenCalledWith({ pageId: 'pg_1', lineIds: ['pg_1_l1'], surface: 'page_editor' });
    expect(studio.openPage).toHaveBeenCalledWith('pg_1');
    expect(studio.patch).not.toHaveBeenCalled();
    cleanup();
    render(<PagesTab studio={makeStudio(doc, { caps: { ...DEFAULT_CAPS, proEditorV2: false } })} doc={doc} />);
    expect(screen.queryByTestId('edit-lettering')).toBeNull();
  });
});

describe('PRO_EDIT_OPS_PATCHABLE stays false: the shell never sends a Pro op', () => {
  it('switching, tools, the sheet and Tab send nothing at all', async () => {
    const { studio } = open({ mode: 'pro' });
    await act(async () => {
      for (const key of ['v', 't', 'b', 's', 'm', 'h', 'z', 'v']) fireEvent.keyDown(document.body, { key });
      fireEvent.keyDown(document.body, { key: '?' });
      fireEvent.keyDown(document.body, { key: 'P', shiftKey: true });
    });
    expect(studio.patch).not.toHaveBeenCalled();
    expect(studio.act).not.toHaveBeenCalled();
  });
});
