import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';

vi.mock('./comicstudio/PublicComicReader', () => ({
  PublicComicReader: ({ projectId, onClose }: { projectId: string; onClose?: () => void }) => (
    <div data-testid="v4-reader">
      v4 reader for {projectId}
      <button onClick={onClose}>close v4</button>
    </div>
  )
}));

vi.mock('./layout/StaticSiteHeader', () => ({
  StaticSiteHeader: () => <div data-testid="static-header" />
}));

vi.mock('./layout/LegalMicroLinks', () => ({
  LegalMicroLinks: () => <div data-testid="legal-links" />
}));

vi.mock('./PanelDialogue', () => ({
  PanelDialogue: () => <div data-testid="panel-dialogue" />
}));

vi.mock('./CommentSection', () => ({
  CommentSection: () => <div data-testid="comments" />
}));

vi.mock('./modals/ReviewModal', () => ({
  ReviewModal: () => null
}));

vi.mock('../services/db', () => ({
  loadReaderState: vi.fn(async () => null),
  saveReaderState: vi.fn(async () => undefined),
  submitReview: vi.fn(async () => true)
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null })
}));

import { ComicReader } from './ComicReader';

const state = (extra: Record<string, unknown> = {}): ComicState =>
  ({
    step: 0,
    maxStepReached: 0,
    script: '',
    scenes: [],
    styleVariants: [],
    stylePrompt: '',
    styleCategory: '',
    styleAspectRatio: '2:3',
    imageResolution: '2K',
    characters: [],
    items: [],
    locations: [],
    layoutType: 'grid',
    panels: [],
    ...extra
  }) as ComicState;

const project = (id: string, extra: Record<string, unknown> = {}): Project => ({
  id,
  name: `Comic ${id}`,
  createdAt: 1,
  updatedAt: 1,
  state: state(extra)
});

const renderReader = (p: Project, onClose = vi.fn()) => {
  render(
    <ComicReader
      project={p}
      onClose={onClose}
      onUpdateProject={() => undefined}
      onOpenPrivacy={() => undefined}
      onOpenTerms={() => undefined}
      onOpenFaq={() => undefined}
    />
  );
  return onClose;
};

describe('ComicReader → v4 delegation', () => {
  it('renders studio comics (studioVersion 4) in the v4 PublicComicReader', async () => {
    const onClose = renderReader(project('11111111-2222-3333-4444-555555555555', { studioVersion: 4, studioPages: 3 }));

    expect(await screen.findByTestId('v4-reader')).toHaveTextContent('v4 reader for 11111111-2222-3333-4444-555555555555');
    // None of the classic reader chrome renders around it.
    expect(screen.queryByTestId('static-header')).toBeNull();
    expect(screen.queryByText("This comic hasn't been drawn yet!")).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'close v4' }));
    // The reader pops its own history entry first (so Back never lands on a stale reader entry), then closes.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps classic comics in the classic reader', () => {
    renderReader(project('classic-1', { pipelineMode: 'classic' }));
    expect(screen.queryByTestId('v4-reader')).toBeNull();
    expect(screen.queryByTestId('studio-comic-reader')).toBeNull();
    expect(screen.getByTestId('static-header')).toBeInTheDocument();
    expect(screen.getAllByText("This comic hasn't been drawn yet!").length).toBeGreaterThan(0);
  });

  it('only delegates on an exact studioVersion of 4', () => {
    renderReader(project('legacy-ish', { studioVersion: '4' }));
    expect(screen.queryByTestId('v4-reader')).toBeNull();
    expect(screen.getByTestId('static-header')).toBeInTheDocument();
  });
});
