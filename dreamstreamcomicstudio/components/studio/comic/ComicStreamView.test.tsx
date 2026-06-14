// Smoke test for the v3 Comic Studio stream surface: renders the right cards from state.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ComicStreamView } from './ComicStreamView';
import { AppStep, type ComicState } from '../../../types';

const mockMatchMedia = (reduce: boolean) => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  });
};

afterEach(() => {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

const makeState = (overrides: Partial<ComicState> = {}): ComicState => ({
  step: AppStep.FULL_GENERATION,
  maxStepReached: AppStep.FULL_GENERATION,
  flowVersion: 4,
  script: 'A heist on a rooftop.',
  scenes: [
    { id: 1, rawText: 'Rooftop.', synopsis: 'Rooftop introduction', characters: ['Maya'], setting: 'Rooftop' },
    { id: 2, rawText: 'Vault.', synopsis: 'Cracking the vault', characters: ['Maya'], setting: 'Vault' },
  ],
  continuitySummary: '',
  overview: '',
  comments: [],
  isFeatured: false,
  coverPrompt: '',
  styleVariants: [{ id: 'sv1', styleId: 's1', imageUrl: 'data:image/png;base64,x', prompt: 'inked noir', category: 'noir', aspectRatio: '3:4', resolution: '1K' }],
  selectedStyleId: 's1',
  stylePrompt: 'inked noir',
  styleCategory: 'noir',
  styleAspectRatio: '3:4',
  customAspectRatioEnabled: false,
  customAspectRatio: undefined,
  imageResolution: '1K',
  characters: [{ id: 'c1', name: 'Maya', bio: 'lead', description: 'curious', referenceImageIds: ['img1'] }],
  items: [],
  locations: [],
  layoutType: 'grid',
  customLayoutPrompt: undefined,
  panels: [
    { id: 'p1', sceneId: 1, description: 'open', dialogue: '', imageId: 'i1', imageUrl: 'data:image/png;base64,p', imageIdHistory: ['i1'] },
  ],
  ...overrides,
});

describe('ComicStreamView', () => {
  it('renders the studio shell and the build cards from state', () => {
    mockMatchMedia(false);
    render(<ComicStreamView state={makeState()} projectTitle="The Underbelly Heist" costUsd={0.42} />);
    expect(screen.getByText('The Underbelly Heist')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Style')).toBeInTheDocument();
    // "Cast" appears in both the rail and the card title — at least one of each.
    expect(screen.getAllByText('Cast').length).toBeGreaterThan(0);
    // page count chip + cost render
    expect(screen.getByText(/This comic ·/)).toBeInTheDocument();
  });

  it('shows a thinking banner while analyzing a fresh script', () => {
    mockMatchMedia(false);
    render(<ComicStreamView analyzing state={makeState({ step: AppStep.SCRIPT_INPUT, scenes: [], styleVariants: [], characters: [], panels: [] })} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('prompts for a script (no thinking) when idle and empty', () => {
    mockMatchMedia(false);
    render(<ComicStreamView state={makeState({ step: AppStep.SCRIPT_INPUT, scenes: [], styleVariants: [], characters: [], panels: [] })} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/Paste or type your story/)).toBeInTheDocument();
  });
});
