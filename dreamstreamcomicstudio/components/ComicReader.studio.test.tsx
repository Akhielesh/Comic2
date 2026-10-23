import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComicState, Project } from '../types';

vi.mock('./comicstudio/PublicComicReader', () => ({
  PublicComicReader: ({ source, isOwner, onClose }: { source?: { kind: string; projectId?: string }; isOwner?: boolean; onClose?: () => void }) => (
    <div data-testid="v4-reader" data-kind={source?.kind} data-owner={String(!!isOwner)}>
      v4 reader for {source?.projectId}
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

const renderReader = (p: Project, onClose = vi.fn(), isReadOnly?: boolean) => {
  render(
    <ComicReader
      project={p}
      isReadOnly={isReadOnly}
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
    expect(onClose).toHaveBeenCalledTimes(1);
    // A local project is the owner's: the v4 reader hides Report and sends no analytics.
    expect(screen.getByTestId('v4-reader')).toHaveAttribute('data-kind', 'project');
    expect(screen.getByTestId('v4-reader')).toHaveAttribute('data-owner', 'true');
    // The layer sizes to the visible height (keyboard / browser bars), not a fixed 100vh.
    expect(screen.getByTestId('studio-comic-reader').style.height).toBe('var(--app-h, 100dvh)');
  });

  it('treats a public (read-only) v4 comic as someone else’s', async () => {
    renderReader(project('22222222-2222-3333-4444-555555555555', { studioVersion: 4 }), vi.fn(), true);
    expect(await screen.findByTestId('v4-reader')).toHaveAttribute('data-owner', 'false');
  });

  it('lays the FX halftone over the art with the seamless library tile (no legacy CSS class)', () => {
    const { container } = render(
      <ComicReader
        project={project('classic-3', { pipelineMode: 'classic', panels: [{ id: 'p1', imageUrl: 'https://cdn.test/a.png', description: 'A street' }] })}
        onClose={() => undefined}
        onUpdateProject={() => undefined}
        onOpenPrivacy={() => undefined}
        onOpenTerms={() => undefined}
        onOpenFaq={() => undefined}
      />
    );
    expect(screen.queryAllByTestId('reader-halftone')).toHaveLength(0);
    fireEvent.click(screen.getByTitle('Halftone comic texture'));
    const overlays = screen.getAllByTestId('reader-halftone');
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays[0].style.backgroundImage).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(container.querySelector('.comic-halftone')).toBeNull();
  });

  it('keeps the classic reader out of the notch and the home indicator', () => {
    const { container } = render(
      <ComicReader project={project('classic-2', { pipelineMode: 'classic' })} onClose={() => undefined} onUpdateProject={() => undefined} onOpenPrivacy={() => undefined} onOpenTerms={() => undefined} onOpenFaq={() => undefined} />
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.style.paddingTop).toBe('var(--sa-top)');
    expect(frame.style.paddingBottom).toBe('var(--sa-bottom)');
    expect(frame.style.paddingLeft).toBe('var(--sa-left)');
    expect(frame.style.paddingRight).toBe('var(--sa-right)');
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
