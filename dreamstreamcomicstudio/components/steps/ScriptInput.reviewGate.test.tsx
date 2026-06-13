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

describe('ScriptInput agent start', () => {
  it('analyzes and progresses without a second review approval gate', async () => {
    const onScenesGenerated = vi.fn();

    render(
      <ScriptInput
        initialScript={'Scene 1: SALTY and PIP enter the tunnel.\nSALTY: "Steady."'}
        projectId={'project-1'}
        onScenesGenerated={onScenesGenerated}
        onScriptChange={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Start comic agent/i }));

    await waitFor(() => {
      expect(onScenesGenerated).toHaveBeenCalledTimes(1);
    });

    expect(onScenesGenerated).toHaveBeenCalledWith(
      expect.stringContaining('SALTY and PIP'),
      expect.arrayContaining([
        expect.objectContaining({
          characters: ['SALTY', 'PIP'],
          setting: 'Tunnel at dusk'
        })
      ])
    );
    expect(screen.queryByText(/Review Script Understanding/i)).not.toBeInTheDocument();
  });

  it('persists agent confirmation and output settings from the composer', () => {
    const onAgentSettingsChange = vi.fn();

    render(
      <ScriptInput
        initialScript={'Scene 1: SALTY and PIP enter the tunnel.\nSALTY: "Steady."'}
        projectId={'project-1'}
        onScenesGenerated={() => {}}
        onScriptChange={() => {}}
        onAgentSettingsChange={onAgentSettingsChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^Never$/i }));
    expect(onAgentSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmPolicy: 'never' })
    );

    fireEvent.click(screen.getByRole('button', { name: /^HTML$/i }));
    expect(onAgentSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outputTargets: expect.not.arrayContaining(['html'])
      })
    );

    fireEvent.change(screen.getByRole('spinbutton', { name: /Budget cap/i }), { target: { value: '1.25' } });
    expect(onAgentSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ budgetCapUsd: 1.25 })
    );
  });
});
