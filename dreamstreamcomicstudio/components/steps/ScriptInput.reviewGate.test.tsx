import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ScriptInput } from './ScriptInput';

const { analyzeScriptDetailedMock } = vi.hoisted(() => ({
  analyzeScriptDetailedMock: vi.fn(async () => ({
    scenes: [
      {
        id: 1,
        rawText: 'SALTY and PIP enter the tunnel at dusk.',
        synopsis: 'SALTY and PIP enter the tunnel.',
        characters: ['SALTY', 'PIP'],
        setting: 'Tunnel at dusk'
      }
    ],
    diagnostics: {
      sceneCount: 1,
      segmentCount: 1,
      fallbackSceneCount: 0,
      coreEntityDrops: 0,
      plotDriftCorrections: 0
    },
    prompt: 'prompt',
    responseText: '{}',
    model: 'gemini-test'
  }))
}));

vi.mock('../../services/geminiService', () => ({
  analyzeScriptDetailed: analyzeScriptDetailedMock
}));

vi.mock('../StoryBuilder', () => ({
  StoryBuilder: () => null
}));

describe('ScriptInput review gate', () => {
  it('does not progress until review approval', async () => {
    const onScenesGenerated = vi.fn();

    render(
      <ScriptInput
        initialScript={'Scene 1: SALTY and PIP enter the tunnel.\nSALTY: "Steady."'}
        projectId={'project-1'}
        onScenesGenerated={onScenesGenerated}
        onScriptChange={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Analyze Script/i }));
    fireEvent.click(screen.getByRole('button', { name: /Analyze Now|Proceed Anyway/i }));

    await waitFor(() => {
      expect(screen.getByText(/Review Script Understanding/i)).toBeInTheDocument();
    });

    expect(onScenesGenerated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Approve & Continue/i }));

    await waitFor(() => {
      expect(onScenesGenerated).toHaveBeenCalledTimes(1);
    });
  });
});
