import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LayoutSelector } from './LayoutSelector';
import type { Scene } from '../../types';

const scenes: Scene[] = [
  {
    id: 1,
    rawText: 'Maya opens the glowing attic door.',
    synopsis: 'Maya opens a glowing attic door.',
    characters: ['Maya'],
    setting: 'Attic'
  },
  {
    id: 2,
    rawText: 'The city appears below her.',
    synopsis: 'A hidden city appears below Maya.',
    characters: ['Maya'],
    setting: 'Hidden city'
  }
];

describe('LayoutSelector autopilot', () => {
  it('auto-launches the recommended layout in auto-spend mode when cost guard allows it', async () => {
    const onLayoutConfirmed = vi.fn();

    render(
      <LayoutSelector
        scenes={scenes}
        projectId="project-1"
        selectedFormFactor="1:1"
        agentSettings={{ confirmPolicy: 'never', outputTargets: ['comic', 'book', 'html'], autoPageCount: true }}
        onLayoutConfirmed={onLayoutConfirmed}
      />
    );

    await waitFor(() => {
      expect(onLayoutConfirmed).toHaveBeenCalledTimes(1);
    });
    expect(onLayoutConfirmed).toHaveBeenCalledWith(expect.any(String), undefined, expect.any(String), expect.any(Number));
  });

  it('does not auto-launch when the projected spend exceeds the budget cap', async () => {
    const onLayoutConfirmed = vi.fn();

    render(
      <LayoutSelector
        scenes={scenes}
        projectId="project-1"
        selectedFormFactor="1:1"
        agentSettings={{ confirmPolicy: 'never', outputTargets: ['comic', 'book', 'html'], autoPageCount: true, budgetCapUsd: 0.01 }}
        onLayoutConfirmed={onLayoutConfirmed}
      />
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onLayoutConfirmed).not.toHaveBeenCalled();
  });
});
