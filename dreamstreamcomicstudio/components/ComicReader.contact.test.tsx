import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComicPanel, Project } from '../types';
import { ComicReader } from './ComicReader';
import { resetBackStack } from './comicstudio/mobile/backStack';

// The phone reader's Info sheet carries the site footer's links; its Contact link writes to the owner's domain.

vi.mock('./layout/StaticSiteHeader', () => ({ StaticSiteHeader: () => null }));
vi.mock('./layout/LegalMicroLinks', () => ({ LegalMicroLinks: () => null }));
vi.mock('./PanelDialogue', () => ({ PanelDialogue: () => null }));
vi.mock('./CommentSection', () => ({ CommentSection: () => null }));
vi.mock('./modals/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../services/db', () => ({
  loadReaderState: vi.fn(async () => null),
  saveReaderState: vi.fn(async () => undefined),
  submitReview: vi.fn(async () => true)
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

const realMatchMedia = window.matchMedia;
const setPhone = () => {
  window.matchMedia = ((query: string) => ({
    matches: /pointer:\s*coarse|max-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
};

const panel = (i: number): ComicPanel => ({
  id: `panel-${i}`,
  sceneId: 1,
  description: '',
  dialogue: `Line ${i}`,
  imageUrl: `data:image/svg+xml,panel${i}`,
  imageIdHistory: []
});

const project: Project = {
  id: 'project-contact',
  name: 'Contact Link Test',
  createdAt: 1,
  updatedAt: 1,
  state: {
    step: 0,
    maxStepReached: 0,
    script: 'Once upon a time.',
    scenes: [],
    styleVariants: [],
    stylePrompt: '',
    styleCategory: '',
    styleAspectRatio: '1:1',
    imageResolution: '1K',
    characters: [],
    items: [],
    locations: [],
    layoutType: 'grid',
    panels: [panel(1), panel(2)]
  }
};

afterEach(() => {
  resetBackStack();
  window.matchMedia = realMatchMedia;
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});

describe('phone reader Info sheet', () => {
  it('Contact writes to the routed support mailbox (support@dreamstreamstudio.ai)', () => {
    setPhone();
    render(<ComicReader project={project} onClose={vi.fn()} onUpdateProject={vi.fn()} onNavigate={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More reader options' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Info/ }));
    const sheet = screen.getByRole('dialog', { name: 'Comic Info' });
    expect(within(sheet).getByRole('link', { name: 'Contact' })).toHaveAttribute('href', 'mailto:support@dreamstreamstudio.ai');
  });
});
