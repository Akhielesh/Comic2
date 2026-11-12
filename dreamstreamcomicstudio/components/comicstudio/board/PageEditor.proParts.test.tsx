// The Pro shell mounts the PE-0 parts only when `part.ready` is true AND COMIC_PRO_EDITOR_V2 is on (master plan §2.12).
// PE-INSPECT (inspector, layers), PE-ASSETS (assets, samples) and PE-COMPOSE (overlays draw) build in parallel, so the
// parts are stubbed READY here through ProPartsContext (the same door the QA harness uses); the real stubs mount nothing.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import type { DocOp } from '../../../shared/comic/ops';
import { PRO_FREE_FOOTER, type ProEditPartId, type ProSample } from '../../../shared/comic/pro/types';
import { PageEditor } from './PageEditor';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import type { StudioController } from '../types';
import { PRO_COACH_KEY, ProPartsContext, mountedParts, partModule, type ProPanelProps, type ProPartModule } from '../editor/useProEditor';

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

  it('1280, Pro: Properties (the inspector part), Layers, Assets and AI tabs; the panels get the shell’s props', () => {
    open({ parts: ALL, studio: { selection: { pageId: 'pg_1', lineIds: ['pg_1_l2'], surface: 'page_editor' } } });
    const dock = screen.getByTestId('pro-dock');
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

  it('a panel’s edits go through the shell’s free, undoable apply (never studio.act)', () => {
    const { studio } = open({ parts: ALL });
    const op: DocOp = { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { x: 0.1 } };
    seen.inspector!.apply([op], { label: 'Move balloon' });
    expect(studio.patch).toHaveBeenCalledWith([op], { undo: true, label: 'Move balloon' });
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('without the inspector part, the lettering panel floats inside the dock column (bounds = the dock)', () => {
    open({ parts: { layers: stub('layers') }, studio: { selection: { pageId: 'pg_1', lineIds: ['pg_1_l2'], surface: 'page_editor' } } });
    expect(screen.getByTestId('lettering-inspector')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-inspector')).toBeNull();
  });

  it('1440: Layers and Assets move to the 280 px left rail; the dock keeps Properties and AI', () => {
    open({ ff: WIDE, parts: ALL });
    const left = screen.getByTestId('pro-left-rail');
    expect(left.style.width).toBe('280px');
    expect(within(left).getByTestId('stub-layers')).toBeInTheDocument();
    expect(within(screen.getByTestId('pro-dock')).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Properties', 'AI']);
  });

  it('1440 without a Layers or Assets part: no empty left rail', () => {
    open({ ff: WIDE, parts: { inspector: stub('inspector') } });
    expect(screen.queryByTestId('pro-left-rail')).toBeNull();
  });
});

describe('phones: a Layers button in the thumb bar (C9)', () => {
  it('opens the Layers sheet with the layers part (Pro, layers ready)', () => {
    window.localStorage.setItem('comicstudio.editor.mode', 'pro');
    open({ ff: PHONE, parts: ALL });
    fireEvent.click(screen.getByTestId('toolbar-layers'));
    const sheet = screen.getByTestId('pro-layers-sheet');
    expect(within(sheet).getByTestId('stub-layers')).toBeInTheDocument();
    expect(within(sheet).getByTestId('pro-free-footer').textContent).toBe(PRO_FREE_FOOTER);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close Layers' }));
    expect(screen.queryByTestId('pro-layers-sheet')).toBeNull();
  });

  it('no Layers button without the part', () => {
    window.localStorage.setItem('comicstudio.editor.mode', 'pro');
    open({ ff: PHONE });
    expect(screen.queryByTestId('toolbar-layers')).toBeNull();
  });
});

describe('the coach cards (first open of Pro; back from ?)', () => {
  it('show only the tips whose part is there, dismiss for good, and come back from the shortcut sheet', () => {
    open({ parts: { layers: stub('layers') } });
    const coach = screen.getByTestId('pro-coach');
    expect(coach.getAttribute('data-card')).toBe('layers');
    expect(within(coach).queryByRole('button', { name: 'Next tip' })).toBeNull();
    fireEvent.click(within(coach).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('pro-coach')).toBeNull();
    expect(window.localStorage.getItem(PRO_COACH_KEY)).toBe('1');
    fireEvent.keyDown(document.body, { key: '?' });
    fireEvent.click(screen.getByTestId('pro-tips-again'));
    expect(screen.getByTestId('pro-coach')).toBeInTheDocument();
  });

  it('no parts, no tips (a tip never describes something that is not there)', () => {
    open({});
    expect(screen.queryByTestId('pro-coach')).toBeNull();
  });

  it('"Start from a sample" only when the assets part has samples', () => {
    open({ parts: { assets: stub('assets', { samples: [SAMPLE] }) } });
    expect(screen.getByTestId('pro-samples')).toBeInTheDocument();
    cleanup();
    window.localStorage.clear();
    open({ parts: { assets: stub('assets') } });
    expect(screen.getByTestId('pro-coach')).toBeInTheDocument();
    expect(screen.queryByTestId('pro-samples')).toBeNull();
  });
});

describe('the Shapes tool (once the compose part draws overlays)', () => {
  it('appears on the rail and places one rectangle overlay where the page is pressed', () => {
    const { studio } = open({ parts: { compose: { part: { id: 'compose', ready: true } } } });
    fireEvent.click(within(screen.getByTestId('pro-tool-rail')).getByRole('button', { name: 'Shapes' }));
    const layer = screen.getByTestId('shape-place-layer');
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(layer, { clientX: 200, clientY: 300 });
    expect(studio.patch).toHaveBeenCalledTimes(1);
    const ops = (studio.patch as ReturnType<typeof vi.fn>).mock.calls[0][0] as DocOp[];
    expect(ops.some((op) => op.op === 'layer' && op.patch && (op.patch as { kind?: string }).kind === 'shape')).toBe(true);
    // Back to Select after one shape.
    expect(within(screen.getByTestId('pro-tool-rail')).getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
  });
});
