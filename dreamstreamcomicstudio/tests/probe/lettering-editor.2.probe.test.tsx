// Probe: lettering-editor (DOM). A FAILING assertion = a confirmed defect on a realistic user path.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PageEditor } from '../../components/comicstudio/board/PageEditor';
import { BalloonLayer } from '../../components/comicstudio/board/BalloonLayer';
import { FontPicker } from '../../components/comicstudio/lettering/FontPicker';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { lineSourceHash } from '../../shared/comic/i18n';
import { resolveLetteringFont } from '../../shared/comic/lettering/fonts';
import type { ComicDoc } from '../../shared/comic/doc';
import type { StudioController } from '../../components/comicstudio/types';

const allowance = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('../../components/usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));
// The worktree's symlinked node_modules makes Vite deny the @fontsource `?url` asset imports; the loader
// is a no-op in jsdom anyway (no document.fonts), so the file table is stubbed.
vi.mock('../../components/comicstudio/lettering/fontFiles', () => ({ FONT_FILES: {} }));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const open = (doc: ComicDoc = makeSampleDoc()) => {
  const studio = makeStudio(doc, { focusedPageId: 'pg_1' });
  render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
  return studio;
};
const hitOf = (lineId: string) => document.querySelector<HTMLElement>(`[data-testid="balloon-hit"][data-line-id="${lineId}"]`)!;
const calls = (studio: StudioController) => (studio.patch as ReturnType<typeof vi.fn>).mock.calls;
const click = (el: Element) => {
  fireEvent.pointerDown(el, { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse' });
  fireEvent.pointerUp(window, { clientX: 5, clientY: 5 });
};
const drag = (el: Element, from: [number, number], to: [number, number], extra: Record<string, unknown> = {}) => {
  fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1], button: 0, pointerType: 'mouse', ...extra });
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] });
};

const withTelugu = () =>
  makeSampleDoc((d) => {
    const line = d.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l2')!;
    d.i18n = {
      glossary: [],
      editions: { te: { lang: 'te', register: 'everyday', lines: { pg_1_l2: { text: 'పదండి!', status: 'reviewed', sourceHash: lineSourceHash(line), at: SAMPLE_NOW } }, balloons: {} } }
    };
  });

describe('B1 — undo labels for the width grip and the tail handle', () => {
  it('a resize is recorded as "Resize balloon" (the Undo button and toast read it back)', () => {
    const studio = open();
    click(hitOf('pg_1_l2'));
    const grip = screen.getByTestId('width-handle');
    drag(grip, [0, 0], [60, 0]);
    const [ops, opts] = calls(studio).at(-1)!;
    expect(ops[0]).toMatchObject({ op: 'balloon', lineId: 'pg_1_l2' });
    expect(ops[0].patch.w).toBeDefined();
    expect(ops[0].patch.x).toBeUndefined();
    expect(opts.label).toBe('Resize balloon');
  });

  it('aiming the tail is recorded as "Aim tail"', () => {
    const studio = open();
    click(hitOf('pg_1_l2'));
    const handle = screen.getByTestId('tail-handle');
    drag(handle, [0, 0], [30, -45]);
    const [ops, opts] = calls(studio).at(-1)!;
    expect(ops[0].patch.tailX).toBeDefined();
    expect(opts.label).toBe('Aim tail');
  });
});

describe('B2 — multi-selection move in a translated edition', () => {
  it('is one undoable change, like in the original language', () => {
    const studio = open(withTelugu());
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Edit which language' })).getByRole('radio', { name: /తెలుగు/ }));
    click(hitOf('pg_1_l2'));
    fireEvent.pointerDown(hitOf('pg_1_l3'), { clientX: 5, clientY: 5, button: 0, pointerType: 'mouse', shiftKey: true });
    expect(studio.setSelection).toHaveBeenLastCalledWith(expect.objectContaining({ lineIds: ['pg_1_l3', 'pg_1_l2'] }));
    (studio.patch as ReturnType<typeof vi.fn>).mockClear();
    drag(hitOf('pg_1_l2'), [100, 100], [160, 100], { altKey: true });
    const made = calls(studio);
    expect(made.flatMap((c) => c[0]).every((o: { op: string }) => o.op === 'edition_balloon')).toBe(true);
    expect(made.flatMap((c) => c[0]).map((o: { lineId: string }) => o.lineId).sort()).toEqual(['pg_1_l2', 'pg_1_l3']);
    // Two separate patches with different coalesce keys = two undo entries for one gesture.
    expect(made).toHaveLength(1);
  });
});

describe('B3 — Easy font chips on a non-Latin comic', () => {
  it('say visibly (not only in a hover tooltip) when a face will not be used', () => {
    const onChange = vi.fn();
    render(<FontPicker simple value="comic-neue" lang="te" onChange={onChange} />);
    const bangers = screen.getByRole('radio', { name: 'Bangers' });
    // Picking it changes nothing on a Telugu page: the resolved face stays Noto Sans Telugu.
    expect(resolveLetteringFont('bangers', 'speech', 'te').fontId).toBe('noto-sans-telugu');
    expect(bangers.getAttribute('title')).toContain('uses Noto Sans Telugu');
    fireEvent.click(bangers);
    expect(onChange).toHaveBeenCalledWith('bangers');
    // The only hint is the title attribute, which touch screens never show.
    expect(screen.queryByText(/uses Noto Sans Telugu/)).not.toBeNull();
  });
});

describe('B4 — inline editor, cleared text', () => {
  it('tells the user something when the text is cleared (it silently restores the old text today)', () => {
    const doc = makeSampleDoc();
    const page = doc.pages[0];
    const onOps = vi.fn();
    const onEditingChange = vi.fn();
    render(
      <div style={{ position: 'relative', width: 600, height: 900 }}>
        <BalloonLayer doc={doc} page={page} pageWidth={600} pageHeight={900} editable onOps={onOps} editingLineId="pg_1_l2" onEditingChange={onEditingChange} />
      </div>
    );
    const ta = screen.getByTestId('balloon-text-editor');
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onOps).not.toHaveBeenCalled();
    expect(onEditingChange).toHaveBeenCalledWith(null);
    expect(document.body.textContent).toMatch(/empty|blank|delete the balloon/i);
  });
});
