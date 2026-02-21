import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReferenceBuilder } from './ReferenceBuilder';

vi.mock('../../services/geminiService', () => ({
  extractWorldDetails: vi.fn(async () => ({
    characters: [
      { id: 'c1', name: 'SALTY', bio: 'Tabby cat captain', description: 'Ginger tabby with a milky eye.', referenceImageIds: [] }
    ],
    items: [],
    locations: [],
    diagnostics: {
      input_scene_count: 1,
      entity_counts: { characters: 1, items: 0, locations: 0 },
      filtered_entity_count: 1,
      dropped_entities: [
        { name: 'Elara Meadowlight', kind: 'character', reason: 'NOT_IN_SCRIPT' }
      ],
      ungrounded_characters_dropped: 1
    }
  })),
  checkConsistency: vi.fn(async () => ({}))
}));

vi.mock('../../services/imageService', () => ({
  generateImage: vi.fn()
}));

vi.mock('../../services/db', () => ({
  getImageUrl: vi.fn(async () => undefined),
  saveImage: vi.fn(async () => 'img-1')
}));

vi.mock('../../services/characterLibrary', () => ({
  saveCharacterToLibrary: vi.fn(async () => {})
}));

describe('ReferenceBuilder contamination block', () => {
  it('disables confirm until contamination acknowledgment is checked', async () => {
    render(
      <ReferenceBuilder
        scenes={[
          {
            id: 1,
            rawText: 'SALTY and PIP enter the tunnel.',
            synopsis: 'SALTY and PIP move through the tunnel.',
            characters: ['SALTY', 'PIP'],
            setting: 'Tunnel'
          }
        ]}
        script={'SALTY and PIP enter the tunnel.'}
        currentStyle={'comic style'}
        projectId={'project-1'}
        initialCharacters={[]}
        initialItems={[]}
        initialLocations={[]}
        onDataUpdate={() => {}}
        onConfirm={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Script Contamination Block/i)).toBeInTheDocument();
    });

    const confirmButton = screen.getByRole('button', { name: /Confirm World/i });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/I reviewed dropped entities/i));
    expect(confirmButton).toBeEnabled();
  });
});
