// The board behind an open page editor is frozen (QA `editor-drop-long-task`): an edit in the editor
// re-renders the editor only — not every page card, the tab strip and the book timeline behind the
// modal — and the board catches up in one render when the editor closes. Render counts, not timings.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioController } from '../types';

const counts = vi.hoisted(() => ({ pagesTab: 0, dock: 0, editor: 0, lastPagesTitle: '', lastEditorTitle: '' }));

vi.mock('./PagesTab', () => ({
  PagesTab: ({ doc }: { doc: ComicDoc }) => {
    counts.pagesTab += 1;
    counts.lastPagesTitle = doc.brief.title;
    return <div data-testid="pages-tab">{doc.brief.title}</div>;
  }
}));
vi.mock('../timeline/BookTimeline', () => ({
  BookTimeline: ({ compact }: { compact?: boolean }) => {
    if (!compact) counts.dock += 1;
    return <div data-testid="book-timeline" />;
  }
}));
vi.mock('./PageEditor', () => ({
  PageEditor: ({ doc, pageId }: { doc: ComicDoc; pageId: string }) => {
    counts.editor += 1;
    counts.lastEditorTitle = doc.brief.title;
    return <div role="dialog" aria-label={`Page editor ${pageId}`} data-title={doc.brief.title} />;
  }
}));

import { BoardPane } from './BoardPane';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
  Object.assign(counts, { pagesTab: 0, dock: 0, editor: 0, lastPagesTitle: '', lastEditorTitle: '' });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A new doc object (as every patch makes) with one visible change. */
const edited = (title: string) =>
  makeSampleDoc((d) => {
    d.brief.title = title;
  });

const studioWith = (doc: ComicDoc, focusedPageId: string | null): StudioController => makeStudio(doc, { tab: 'pages', focusedPageId });

describe('BoardPane under the page editor', () => {
  it('edits in the open editor re-render the editor, never the board behind it', () => {
    const { rerender } = render(<BoardPane studio={studioWith(makeSampleDoc(), 'pg_2')} />);
    const boardRendersAtOpen = counts.pagesTab;
    const dockRendersAtOpen = counts.dock;
    expect(boardRendersAtOpen).toBe(1);
    expect(screen.getByRole('dialog', { name: 'Page editor pg_2' })).toBeInTheDocument();

    // Five edits (a balloon drag + drop, typing…): each is a new doc and a new controller object.
    for (let i = 1; i <= 5; i += 1) rerender(<BoardPane studio={studioWith(edited(`Edit ${i}`), 'pg_2')} />);

    expect(counts.pagesTab).toBe(boardRendersAtOpen);
    expect(counts.dock).toBe(dockRendersAtOpen);
    // The editor itself saw every edit.
    expect(counts.lastEditorTitle).toBe('Edit 5');
    expect(screen.getByRole('dialog')).toHaveAttribute('data-title', 'Edit 5');
    expect(screen.getByTestId('pages-tab')).toHaveTextContent('The Saffron Thief');
    expect(document.querySelector('[data-board]')).toHaveAttribute('data-board-frozen', 'true');
  });

  it('closing the editor catches the board up in one render', () => {
    const { rerender } = render(<BoardPane studio={studioWith(makeSampleDoc(), 'pg_2')} />);
    rerender(<BoardPane studio={studioWith(edited('After the drop'), 'pg_2')} />);
    const before = counts.pagesTab;
    rerender(<BoardPane studio={studioWith(edited('After the drop'), null)} />);
    expect(counts.pagesTab).toBe(before + 1);
    expect(screen.getByTestId('pages-tab')).toHaveTextContent('After the drop');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-board]')).not.toHaveAttribute('data-board-frozen');
  });

  it('without the editor every doc change still reaches the board', () => {
    const { rerender } = render(<BoardPane studio={studioWith(makeSampleDoc(), null)} />);
    rerender(<BoardPane studio={studioWith(edited('Live 1'), null)} />);
    rerender(<BoardPane studio={studioWith(edited('Live 2'), null)} />);
    expect(counts.pagesTab).toBe(3);
    expect(screen.getByTestId('pages-tab')).toHaveTextContent('Live 2');
  });
});
