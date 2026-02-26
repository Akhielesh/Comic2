import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StoryPlanning } from './StoryPlanning';
import { Scene } from '../../types';

const scenes: Scene[] = [
  {
    id: 1,
    rawText: 'SALTY and PIP enter the tunnel.',
    synopsis: 'SALTY and PIP enter the tunnel.',
    characters: ['SALTY', 'PIP'],
    setting: 'Tunnel at dusk'
  }
];

describe('StoryPlanning', () => {
  it('blocks continue when feasibility is insufficient', () => {
    const onPlanningChange = vi.fn();
    const onConfirm = vi.fn();

    render(
      <StoryPlanning
        script={'Scene 1: SALTY and PIP enter the tunnel.'}
        scenes={scenes}
        onPlanningChange={onPlanningChange}
        onConfirm={onConfirm}
      />
    );

    const numberInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(numberInputs[0], { target: { value: '120' } });
    fireEvent.change(numberInputs[1], { target: { value: '140' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm Plan & Continue/i }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/Adjust page range or script detail before continuing/i)).toBeInTheDocument();
  });

  it('approves and continues when feasible', () => {
    const onPlanningChange = vi.fn();
    const onConfirm = vi.fn();

    render(
      <StoryPlanning
        script={'Scene 1: SALTY and PIP enter the tunnel.'}
        scenes={scenes}
        onPlanningChange={onPlanningChange}
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Confirm Plan & Continue/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const calls = onPlanningChange.mock.calls.map((call) => call[0]);
    expect(calls.some((planning) => planning.approved === true)).toBe(true);
  });
});
