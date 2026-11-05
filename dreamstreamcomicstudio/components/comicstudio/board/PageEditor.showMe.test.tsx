// "Show me" on a conflict card (agent-editor plan §3 A3) opens the page and sets studio.selection on the balloon in
// question (ConflictCard: studio.openPage + studio.setSelection). The page editor then starts with that balloon
// selected — and an editor that is already open selects it when the request arrives — instead of clearing it.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageEditor } from './PageEditor';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import type { StudioController, StudioSelection } from '../types';

const allowance = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('../../usage/useUsageAllowance', () => ({ useUsageAllowance: () => allowance.status }));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const hitOf = (lineId: string) => document.querySelector<HTMLElement>(`[data-testid="balloon-hit"][data-line-id="${lineId}"]`)!;
/** What ConflictCard's Show me leaves behind for line pg_1_l4 (panel 3 of page 1). */
const SHOW_ME: StudioSelection = { pageId: 'pg_1', lineIds: ['pg_1_l4'], surface: 'page_editor' };
const setSelectionCalls = (studio: StudioController) => (studio.setSelection as ReturnType<typeof vi.fn>).mock.calls.map(([sel]) => sel);

describe('PageEditor: Show me pre-selects the balloon', () => {
  it('opening the page from Show me starts with that balloon selected and its inspector open', () => {
    const doc = makeSampleDoc();
    const studio = makeStudio(doc, { focusedPageId: 'pg_1', selection: SHOW_ME });
    render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
    expect(hitOf('pg_1_l4')).toHaveAttribute('aria-pressed', 'true');
    expect(hitOf('pg_1_l2')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('lettering-inspector')).toBeInTheDocument();
    // The chat focus keeps pointing at that balloon: never cleared on mount.
    expect(setSelectionCalls(studio)).not.toContain(null);
    expect(studio.setSelection).toHaveBeenLastCalledWith({ pageId: 'pg_1', lineIds: ['pg_1_l4'], surface: 'page_editor', panelN: 3 });
  });

  it('a selection for another page, for the board, or of a line that is gone selects nothing', () => {
    const doc = makeSampleDoc();
    for (const selection of [
      { ...SHOW_ME, pageId: 'pg_2' },
      { ...SHOW_ME, surface: 'board' as const },
      { ...SHOW_ME, lineIds: ['pg_1_gone'] }
    ]) {
      const studio = makeStudio(doc, { focusedPageId: 'pg_1', selection });
      const { unmount } = render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
      expect(document.querySelectorAll('[data-testid="balloon-hit"][aria-pressed="true"]')).toHaveLength(0);
      expect(screen.queryByTestId('lettering-inspector')).toBeNull();
      unmount();
    }
  });

  it('an editor already open on the page selects the balloon when Show me arrives', () => {
    const doc = makeSampleDoc();
    const studio = makeStudio(doc, { focusedPageId: 'pg_1' });
    const { rerender } = render(<PageEditor studio={studio} doc={doc} pageId="pg_1" />);
    expect(hitOf('pg_1_l4')).toHaveAttribute('aria-pressed', 'false');
    rerender(<PageEditor studio={{ ...studio, selection: SHOW_ME }} doc={doc} pageId="pg_1" />);
    expect(hitOf('pg_1_l4')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('lettering-inspector')).toBeInTheDocument();
    expect(studio.setSelection).toHaveBeenLastCalledWith({ pageId: 'pg_1', lineIds: ['pg_1_l4'], surface: 'page_editor', panelN: 3 });
  });
});
