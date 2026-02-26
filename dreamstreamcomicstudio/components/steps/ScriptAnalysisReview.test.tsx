import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScriptAnalysisReview } from './ScriptAnalysisReview';
import { Scene } from '../../types';

const baseScenes: Scene[] = [
  {
    id: 1,
    rawText: 'SALTY and PIP creep through the flooded tunnel at dusk.',
    synopsis: 'SALTY and PIP move carefully through the tunnel.',
    characters: ['SALTY', 'PIP'],
    setting: 'Flooded tunnel at dusk'
  }
];

describe('ScriptAnalysisReview', () => {
  it('approves grounded scene edits', () => {
    const onApprove = vi.fn();

    render(
      <ScriptAnalysisReview
        scenes={baseScenes}
        diagnostics={{ sceneCount: 1, segmentCount: 1 }}
        onApprove={onApprove}
        onBackToScript={() => {}}
        onReanalyze={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve & Continue/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('blocks approval when a character is not present in source excerpt', () => {
    const onApprove = vi.fn();

    render(
      <ScriptAnalysisReview
        scenes={baseScenes}
        diagnostics={{ sceneCount: 1, segmentCount: 1 }}
        onApprove={onApprove}
        onBackToScript={() => {}}
        onReanalyze={() => {}}
      />
    );

    const charactersInput = screen.getByDisplayValue('SALTY, PIP');
    fireEvent.change(charactersInput, { target: { value: 'SALTY, BATMAN' } });

    fireEvent.click(screen.getByRole('button', { name: /Approve & Continue/i }));

    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByText(/Not found in this scene excerpt/i)).toBeInTheDocument();
  });

  it('uses script segment fallback when raw excerpt is truncated or missing', () => {
    const onApprove = vi.fn();
    const scenes: Scene[] = [{
      id: 1,
      rawText: '',
      synopsis: 'Two friends chase a ball over rooftops.',
      characters: ['Milo', 'Pepper'],
      setting: 'Rooftops at dusk'
    }];
    const script = 'Scene 1: Milo the cat and Pepper the corgi sprint across the rooftop chasing a yellow ball.';

    render(
      <ScriptAnalysisReview
        script={script}
        scenes={scenes}
        diagnostics={{ sceneCount: 1 }}
        onApprove={onApprove}
        onBackToScript={() => {}}
        onReanalyze={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve & Continue/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('blocks approval with explicit source-unavailable message when no source text exists', () => {
    const onApprove = vi.fn();
    const scenes: Scene[] = [{
      id: 1,
      rawText: '',
      synopsis: 'Unknown.',
      characters: ['Milo'],
      setting: 'Unknown'
    }];

    render(
      <ScriptAnalysisReview
        script={''}
        scenes={scenes}
        diagnostics={{ sceneCount: 1 }}
        onApprove={onApprove}
        onBackToScript={() => {}}
        onReanalyze={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve & Continue/i }));
    expect(onApprove).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Source excerpt unavailable for one or more scenes/i)
    ).toBeInTheDocument();
  });
});
