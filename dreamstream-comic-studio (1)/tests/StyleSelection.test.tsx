import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { StyleSelection } from '../components/steps/StyleSelection';
import { Scene } from '../types';

// Mock dependencies
vi.mock('../services/geminiService', () => ({
  analyzeScript: vi.fn(),
  suggestStyle: vi.fn(),
  suggestFormFactor: vi.fn(),
}));

vi.mock('../hooks/useStyleGeneration', () => ({
  useStyleGeneration: () => ({
    isBatchGenerating: false,
    generationError: null,
    pendingPreviews: [],
    generateStyles: vi.fn(),
  }),
  FORM_FACTORS: [],
  DEFAULT_FORM_FACTOR: '1:1@1K'
}));

// Mock StyleCard
vi.mock('../components/style/StyleCard', () => ({
  StyleCard: ({ style, isSelected, onToggle }: any) => (
    <div data-testid={`style-card-${style.id}`}>
      <button onClick={onToggle}>{style.label}</button>
      {isSelected && <span>Selected</span>}
    </div>
  )
}));

describe('StyleSelection', () => {
  const mockScene: Scene = {
    id: 1,
    rawText: 'Test',
    synopsis: 'Test scene',
    characters: [],
    setting: 'Test setting'
  };

  const defaultProps = {
    firstScene: mockScene,
    script: 'Test script',
    projectId: 'test-project',
    onScenesGenerated: vi.fn(),
    onStyleConfirmed: vi.fn(),
    initialVariants: [],
    onVariantsChange: vi.fn(),
  };

  it('renders "Recommended 5" section', () => {
    render(<StyleSelection {...defaultProps} />);
    expect(screen.getByText('Recommended 5')).toBeInTheDocument();
  });

  it('shows warning if no scene is provided', () => {
    render(<StyleSelection {...defaultProps} firstScene={undefined} />);
    expect(screen.getByText(/Please analyze your script first/i)).toBeInTheDocument();
  });

  it('allows selecting a style', async () => {
    render(<StyleSelection {...defaultProps} />);
    // Use getAllByText because 'Ligne Claire' might appear in the "Recommended" tags AND the card list
    // We target the button inside the card specifically via testid if needed, or just first button
    const styleButtons = screen.getAllByText(/Ligne Claire/i);
    // The first one might be the tag, the second one the button in the list?
    // Let's use the mocked component's testid to be precise
    const card = screen.getByTestId('style-card-ligne-claire');
    const button = card.querySelector('button');

    expect(button).toBeInTheDocument();
    fireEvent.click(button!);

    // We expect the selection state to change.
    expect(await screen.findByText('Selected')).toBeInTheDocument();
  });
});
