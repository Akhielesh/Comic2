// The Pro shell mounts the PE-0 parts only when `part.ready` is true AND COMIC_PRO_EDITOR_V2 is on (master plan §2.12).
// PE-INSPECT (inspector, layers), PE-ASSETS (assets, samples) and PE-COMPOSE (overlays draw) build in parallel, so the
// parts are stubbed READY here through ProPartsContext (the same door the QA harness uses); the real stubs mount nothing.

import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import type { DocOp } from '../../../shared/comic/ops';
import { PRO_FREE_FOOTER, type ProEditPartId, type ProSample } from '../../../shared/comic/pro/types';
import { PageEditor } from './PageEditor';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import type { StudioController } from '../types';
import { PRO_COACH_KEY, ProPartsContext, mountedParts, partModule, type ProPanelProps, type ProPartModule } from '../editor/useProEditor';
import { MODE_STORAGE_KEY } from '../useStudioMode';

const allowance = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('../../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

// The Pro view's pieces load lazily (editor/proLazy.ts); warm their modules once so each test waits on React, not on the
// first transform of a module.
beforeAll(async () => {
  await Promise.all([import('../editor/ProWorkspace'), import('../editor/ProTopBar'), import('../editor/balloonTransform'), import('../editor/proShapes'), import('../editor/proNudge')]);
}, 30_000);

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

const seen: Record<string, ProPanelProps | undefined> = {};
const stub = (id: ProEditPartId, extra: Partial<ProPartModule> = {}): ProPartModule => ({
  part: { id, ready: true },
  Panel: (props: ProPanelProps) => {
    seen[id] = props;
    return <div data-testid={`stub-${id}`}>{`${id}: ${props.selection.ids.join(',') || 'none'}`}</div>;
  },
  ...extra
});
const SAMPLE: ProSample = { id: 'action-hit', kind: 'recipe', name: 'Action hit', label: "Apply 'Action hit' · Free", ops: [] };

const reader =
  (parts: Partial<Record<ProEditPartId, ProPartModule>>) =>
  (id: ProEditPartId): ProPartModule =>
    parts[id] ?? partModule(id);

const DESKTOP = formFactorFor({ w: 1280, h: 800 });
const WIDE = formFactorFor({ w: 1440, h: 900 });
const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });
const PHONE_LANDSCAPE = formFactorFor({ w: 740, h: 360, coarse: true });
const TABLET = formFactorFor({ w: 768, h: 1024, coarse: true });
const FLAG_ON: StudioCaps = { ...DEFAULT_CAPS, proEditorV2: true };

const open = (o: {
  ff?: ReturnType<typeof formFactorFor>;
  mode?: 'easy' | 'pro';
  caps?: StudioCaps;
  parts?: Partial<Record<ProEditPartId, ProPartModule>>;
  studio?: Partial<StudioController>;
}) => {
  const doc = makeSampleDoc();
  const studio = makeStudio(doc, { focusedPageId: 'pg_1', caps: o.caps ?? FLAG_ON, mode: o.mode ?? 'pro', ...(o.studio || {}) });
  render(
    <FormFactorProvider value={o.ff ?? DESKTOP}>
      <ProPartsContext.Provider value={reader(o.parts ?? {})}>
        <PageEditor studio={studio} doc={doc} pageId="pg_1" />
      </ProPartsContext.Provider>
    </FormFactorProvider>
  );
  return { studio, doc };
};

const ALL = { inspector: stub('inspector'), layers: stub('layers'), assets: stub('assets') };

describe('the real PE-0 stubs mount nothing', () => {
  it('every part is not ready, so no panel, no Shapes tool and no samples (flag on, Pro)', () => {
    const parts = mountedParts(true, true);
    expect(parts).toEqual({ inspector: undefined, layers: undefined, assets: undefined, animate: undefined, compose: false, samples: [] });
  });
  it('the flag gates every part on its own: all parts ready, flag off, nothing mounts', () => {
    const allReady = reader({ ...ALL, animate: stub('animate'), compose: { part: { id: 'compose', ready: true } }, assets: stub('assets', { samples: [SAMPLE] }) });
    expect(mountedParts(false, true, allReady)).toEqual({ inspector: undefined, layers: undefined, assets: undefined, animate: undefined, compose: false, samples: [] });
    expect(mountedParts(true, true, allReady).compose).toBe(true);
  });
  it('the kit part is the shell’s own and is ready', () => {
    expect(partModule('kit').part).toEqual({ id: 'kit', ready: true });
  });
});

describe('ready parts mount only with the flag on, in Pro', () => {
  it('flag off: a ready part is never mounted', () => {
    open({ caps: { ...DEFAULT_CAPS, proEditorV2: false }, parts: ALL });
    expect(screen.queryByTestId('stub-inspector')).toBeNull();
    expect(screen.queryByTestId('stub-layers')).toBeNull();
    expect(screen.queryByTestId('pro-dock')).toBeNull();
  });

  it('flag on, Easy: today’s editor, no part', () => {
    open({ mode: 'easy', parts: ALL });
    expect(screen.queryByTestId('stub-inspector')).toBeNull();
    expect(screen.queryByTestId('pro-dock')).toBeNull();
  });

  it('1280, Pro: Properties (the inspector part), Layers, Assets and AI tabs; the panels get the shell’s props', async () => {
    open({ parts: ALL, studio: { selection: { pageId: 'pg_1', lineIds: ['pg_1_l2'], surface: 'page_editor' } } });
    const dock = await screen.findByTestId('pro-dock');
    expect(within(dock).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Properties', 'Layers', 'Assets', 'AI']);
    expect(within(dock).getByTestId('stub-inspector').textContent).toBe('inspector: pg_1_l2');
    expect(seen.inspector).toMatchObject({ footer: PRO_FREE_FOOTER, mode: 'pro', layout: 'desktop', editionLang: undefined });
    expect(seen.inspector?.sourcePage.id).toBe('pg_1');
    // The docked inspector replaces the floating lettering panel: nothing floats over the page.
    expect(screen.queryByTestId('lettering-inspector')).toBeNull();
    fireEvent.click(within(dock).getByRole('tab', { name: 'Layers' }));
    expect(within(dock).getByTestId('stub-layers')).toBeInTheDocument();
    expect(within(dock).getByTestId('pro-free-footer').textContent).toBe(PRO_FREE_FOOTER);
  });

  it('a panel’s edits go through the shell’s free, undoable apply (never studio.act)', async () => {
    const { studio } = open({ parts: ALL });
    await screen.findByTestId('stub-inspector');
    const op: DocOp = { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { x: 0.1 } };
    seen.inspector!.apply([op], { label: 'Move balloon' });
    expect(studio.patch).toHaveBeenCalledWith([op], { undo: true, label: 'Move balloon' });
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('without the inspector part, the lettering panel floats inside the dock column (bounds = the dock)', async () => {
    open({ parts: { layers: stub('layers') }, studio: { selection: { pageId: 'pg_1', lineIds: ['pg_1_l2'], surface: 'page_editor' } } });
    await screen.findByTestId('pro-dock');
    expect(screen.getByTestId('lettering-inspector')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-inspector')).toBeNull();
  });

  it('1440: Layers and Assets move to the 280 px left rail; the dock keeps Properties and AI', async () => {
    open({ ff: WIDE, parts: ALL });
    const left = await screen.findByTestId('pro-left-rail');
    expect(left.style.width).toBe('280px');
    expect(within(left).getByTestId('stub-layers')).toBeInTheDocument();
    expect(within(screen.getByTestId('pro-dock')).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Properties', 'AI']);
  });

  it('1440 without a Layers or Assets part: no empty left rail', async () => {
    open({ ff: WIDE, parts: { inspector: stub('inspector') } });
    await screen.findByTestId('pro-dock');
    expect(screen.queryByTestId('pro-left-rail')).toBeNull();
  });

  it('a part with loadPanel (the lazy contract) mounts its panel once it loads', async () => {
    const Lazy = (props: ProPanelProps) => <div data-testid="lazy-inspector">{`lazy: ${props.footer}`}</div>;
    const lazyPart: ProPartModule = { part: { id: 'inspector', ready: true }, loadPanel: () => Promise.resolve({ Panel: Lazy }) };
    open({ parts: { inspector: lazyPart } });
    expect((await screen.findByTestId('lazy-inspector')).textContent).toBe(`lazy: ${PRO_FREE_FOOTER}`);
  });

  it('the docked timeline (animate, with proMotion) reads the free footer under it', async () => {
    open({ caps: { ...FLAG_ON, proMotion: true }, parts: { animate: stub('animate') } });
    const timeline = await screen.findByTestId('pro-timeline');
    expect(within(timeline).getByTestId('stub-animate')).toBeInTheDocument();
    expect(within(timeline).getByTestId('pro-free-footer').textContent).toBe(PRO_FREE_FOOTER);
  });

  it('no proMotion: no timeline, even with the animate part ready', async () => {
    open({ parts: { animate: stub('animate') } });
    await screen.findByTestId('pro-dock');
    expect(screen.queryByTestId('pro-timeline')).toBeNull();
  });
});

describe('768 tablet (the tool row): Layers and Assets in a left drawer, the inspector in a sheet (§2.7)', () => {
  it('the tool row has a Layers and an Assets toggle; each opens its part in the drawer with the free footer; Esc closes', async () => {
    open({ ff: TABLET, parts: ALL });
    const row = await screen.findByTestId('pro-tool-rail');
    expect(row).toHaveAttribute('aria-orientation', 'horizontal');
    fireEvent.click(within(row).getByRole('button', { name: 'Layers' }));
    const drawer = await screen.findByTestId('pro-drawer');
    expect(drawer.getAttribute('data-drawer')).toBe('layers');
    expect(within(drawer).getByTestId('stub-layers')).toBeInTheDocument();
    expect(within(drawer).getByTestId('pro-free-footer').textContent).toBe(PRO_FREE_FOOTER);
    expect(drawer.className).toMatch(/z-\[var\(--ds-z-sheet\)\]/);
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(screen.queryByTestId('pro-drawer')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Assets' }));
    expect((await screen.findByTestId('pro-drawer')).getAttribute('data-drawer')).toBe('assets');
  });

  it('a selection opens the inspector part in a bottom sheet (≤ 40 %), never the floating lettering panel', async () => {
    open({ ff: TABLET, parts: ALL, studio: { selection: { pageId: 'pg_1', lineIds: ['pg_1_l2'], surface: 'page_editor' } } });
    const sheet = await screen.findByTestId('pro-inspector-sheet');
    expect(within(sheet).getByTestId('stub-inspector').textContent).toBe('inspector: pg_1_l2');
    expect(sheet.className).toMatch(/max-h-\[40vh\]/);
    expect(within(sheet).getByTestId('pro-free-footer').textContent).toBe(PRO_FREE_FOOTER);
    expect(screen.queryByTestId('lettering-inspector')).toBeNull();
  });

  it('no part, no toggle (and the coach shows only tips for panels the tablet can open)', async () => {
    open({ ff: TABLET, parts: { inspector: stub('inspector') } });
    const row = await screen.findByTestId('pro-tool-rail');
    expect(within(row).queryByRole('button', { name: 'Layers' })).toBeNull();
    expect(screen.queryByTestId('pro-coach')).toBeNull();
    cleanup();
    open({ ff: TABLET, parts: { layers: stub('layers'), animate: stub('animate') }, caps: { ...FLAG_ON, proMotion: true } });
    const coach = await screen.findByTestId('pro-coach');
    // Layers is reachable from the tool row; the timeline is not drawn on tablets in S2, so no Animate tip.
    expect(coach.getAttribute('data-card')).toBe('layers');
    expect(within(coach).queryByRole('button', { name: 'Next tip' })).toBeNull();
  });
});

describe('phones: a Layers button in the thumb bar (C9)', () => {
  it('opens the Layers sheet with the layers part (Pro, layers ready): above the thumb bar, in the stage column, never fixed', async () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, 'pro');
    open({ ff: PHONE, parts: ALL });
    fireEvent.click(screen.getByTestId('toolbar-layers'));
    const sheet = await screen.findByTestId('pro-layers-sheet');
    expect(sheet.getAttribute('data-variant')).toBe('bottom');
    expect(sheet.className).not.toMatch(/\bfixed\b/);
    // Inside the stage column (the thumb bar is its sibling below), so it never covers the thumb bar.
    expect(screen.getByTestId('editor-stage').contains(sheet)).toBe(true);
    expect(screen.getByTestId('editor-stage').contains(screen.getByTestId('editor-toolbar'))).toBe(false);
    expect(within(sheet).getByTestId('stub-layers')).toBeInTheDocument();
    expect(within(sheet).getByTestId('pro-free-footer').textContent).toBe(PRO_FREE_FOOTER);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close Layers' }));
    expect(screen.queryByTestId('pro-layers-sheet')).toBeNull();
  });

  it('Layers and the lettering sheet never stack: with Layers open a selection keeps the lettering sheet closed', async () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, 'pro');
    open({ ff: PHONE, parts: ALL, studio: { selection: { pageId: 'pg_1', lineIds: ['pg_1_l2'], surface: 'page_editor' } } });
    expect(screen.getByTestId('lettering-inspector')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('toolbar-layers'));
    await screen.findByTestId('pro-layers-sheet');
    expect(screen.queryByTestId('lettering-inspector')).toBeNull();
    // Lettering takes the foot back.
    fireEvent.click(screen.getByTestId('toolbar-lettering'));
    await waitFor(() => expect(screen.queryByTestId('pro-layers-sheet')).toBeNull());
    expect(screen.getByTestId('lettering-inspector')).toBeInTheDocument();
  });

  it('phone landscape: the rail plus a 320 px side sheet beside the stage', async () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, 'pro');
    open({ ff: PHONE_LANDSCAPE, parts: ALL });
    fireEvent.click(screen.getByTestId('toolbar-layers'));
    const sheet = await screen.findByTestId('pro-layers-sheet');
    expect(sheet.getAttribute('data-variant')).toBe('side');
    expect(sheet.style.width).toBe('320px');
    expect(screen.getByTestId('editor-stage').contains(sheet)).toBe(false);
  });

  it('no Layers button without the part', () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, 'pro');
    open({ ff: PHONE });
    expect(screen.queryByTestId('toolbar-layers')).toBeNull();
  });
});

describe('the coach cards (first open of Pro; back from ?)', () => {
  it('show only the tips whose part is there, dismiss them by id, and come back from the shortcut sheet', async () => {
    open({ parts: { layers: stub('layers') } });
    const coach = await screen.findByTestId('pro-coach');
    expect(coach.getAttribute('data-card')).toBe('layers');
    expect(within(coach).queryByRole('button', { name: 'Next tip' })).toBeNull();
    fireEvent.click(within(coach).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('pro-coach')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PRO_COACH_KEY)!)).toEqual(['layers']);
    fireEvent.keyDown(document.body, { key: '?' });
    fireEvent.click(await screen.findByTestId('pro-tips-again'));
    expect(await screen.findByTestId('pro-coach')).toBeInTheDocument();
  });

  it('a tip for a part that mounts later still shows, though an earlier one was dismissed', async () => {
    window.localStorage.setItem(PRO_COACH_KEY, JSON.stringify(['layers']));
    open({ parts: { layers: stub('layers'), assets: stub('assets') } });
    expect((await screen.findByTestId('pro-coach')).getAttribute('data-card')).toBe('effects');
  });

  it('no parts, no tips (a tip never describes something that is not there)', async () => {
    open({});
    await screen.findByTestId('pro-dock');
    expect(screen.queryByTestId('pro-coach')).toBeNull();
  });

  it('"Start from a sample" only when the assets part has samples', async () => {
    open({ parts: { assets: stub('assets', { samples: [SAMPLE] }) } });
    expect(await screen.findByTestId('pro-samples')).toBeInTheDocument();
    cleanup();
    window.localStorage.clear();
    open({ parts: { assets: stub('assets') } });
    expect(await screen.findByTestId('pro-coach')).toBeInTheDocument();
    expect(screen.queryByTestId('pro-samples')).toBeNull();
  });
});

describe('the Shapes tool (once the compose part draws overlays)', () => {
  it('appears on the rail and places one rectangle overlay where the page is pressed', async () => {
    const { studio } = open({ parts: { compose: { part: { id: 'compose', ready: true } } } });
    fireEvent.click(within(await screen.findByTestId('pro-tool-rail')).getByRole('button', { name: 'Shapes' }));
    const layer = await screen.findByTestId('shape-place-layer');
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 300 });
    expect(studio.patch).toHaveBeenCalledTimes(1);
    const ops = (studio.patch as ReturnType<typeof vi.fn>).mock.calls[0][0] as DocOp[];
    expect(ops.some((op) => op.op === 'layer' && op.patch && (op.patch as { kind?: string }).kind === 'shape')).toBe(true);
    // Back to Select after one shape.
    expect(within(screen.getByTestId('pro-tool-rail')).getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
  });
});
