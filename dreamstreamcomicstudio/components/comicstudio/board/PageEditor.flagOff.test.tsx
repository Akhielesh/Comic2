// COMIC_PRO_EDITOR_V2 off: the page editor, its Pages entry and its toolbars render EXACTLY today's DOM (master plan
// §2.2 "Flag off: exactly today"; PE-SHELL "flag off gives an unchanged DOM snapshot").
//
// The snapshots in __snapshots__/PageEditor.flagOff.test.tsx.snap were written on the base (756b5a70), BEFORE the
// PE-SHELL code existed, and committed first: any change the shell makes to the flag-off tree fails here. Desktop
// (1280 × 800, fine pointer), tablet portrait and phone (coarse), in Easy and in Pro, with and without a selection.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import type { StudioMode } from '../../../shared/comic/capabilities';
import { PageEditor } from './PageEditor';
import { PagesTab } from './PagesTab';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { EditorToolbar } from '../mobile/editor/EditorToolbar';
import { LetteringToolbar } from '../lettering/LetteringToolbar';

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
const TABLET = formFactorFor({ w: 768, h: 1024, coarse: true });
const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });

/** The flag explicitly off (the server sends false to every non-admin, and DEFAULT_CAPS leaves it unset). */
const FLAG_OFF = { ...DEFAULT_CAPS, proEditorV2: false };

const editorHtml = (ff: ReturnType<typeof formFactorFor>, mode: StudioMode, selected: string[] = []) => {
  const doc = makeSampleDoc();
  const studio = makeStudio(doc, {
    focusedPageId: 'pg_1',
    caps: FLAG_OFF,
    mode,
    selection: selected.length ? { pageId: 'pg_1', lineIds: selected, surface: 'page_editor' } : null
  });
  render(
    <FormFactorProvider value={ff}>
      <PageEditor studio={studio} doc={doc} pageId="pg_1" />
    </FormFactorProvider>
  );
  return document.body.innerHTML;
};

describe('flag off: the page editor is exactly today', () => {
  it('desktop, Easy, nothing selected', () => {
    expect(editorHtml(DESKTOP, 'easy')).toMatchSnapshot();
  });
  it('desktop, Pro, a balloon selected (the lettering inspector open)', () => {
    expect(editorHtml(DESKTOP, 'pro', ['pg_1_l1'])).toMatchSnapshot();
  });
  it('tablet portrait, Pro, nothing selected', () => {
    expect(editorHtml(TABLET, 'pro')).toMatchSnapshot();
  });
  it('phone, Easy, nothing selected', () => {
    expect(editorHtml(PHONE, 'easy')).toMatchSnapshot();
  });
  it('phone, Pro, a balloon selected (the bottom-sheet inspector)', () => {
    expect(editorHtml(PHONE, 'pro', ['pg_1_l1'])).toMatchSnapshot();
  });
});

describe('flag off: the Pages tab and the toolbars are exactly today', () => {
  it('the Pages tab (no "Edit lettering" entry)', () => {
    const doc = makeSampleDoc();
    const studio = makeStudio(doc, { caps: FLAG_OFF });
    const { container } = render(
      <FormFactorProvider value={DESKTOP}>
        <PagesTab studio={studio} doc={doc} />
      </FormFactorProvider>
    );
    expect(container.innerHTML).toMatchSnapshot();
  });
  it('the lettering toolbar keeps its Easy | Pro switch', () => {
    const { container } = render(
      <LetteringToolbar
        addKind={null}
        onAddKind={() => undefined}
        canUndo
        canRedo={false}
        undoLabel="move balloon"
        onUndo={() => undefined}
        onRedo={() => undefined}
        onTidy={() => undefined}
        outsideCount={2}
        onFixEdges={() => undefined}
        mode="easy"
        onModeChange={() => undefined}
        canPro
      />
    );
    expect(container.innerHTML).toMatchSnapshot();
  });
  it('the phone toolbar', () => {
    const { container } = render(
      <EditorToolbar
        orientation="horizontal"
        mode="move"
        onModeChange={() => undefined}
        canUndo
        canRedo
        onUndo={() => undefined}
        onRedo={() => undefined}
        lettering={{ open: false, onToggle: () => undefined, attention: 1 }}
        tools={{ open: false, onToggle: () => undefined }}
      />
    );
    expect(container.innerHTML).toMatchSnapshot();
  });
});
