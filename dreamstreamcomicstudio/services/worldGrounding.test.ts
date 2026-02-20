import { describe, expect, it } from 'vitest';
import type { Character, Item, Location, Scene } from '../types';
import { groundWorldEntities } from './worldGrounding';

describe('world grounding fallback', () => {
  const scenes: Scene[] = [
    {
      id: 1,
      rawText: 'SALTY and BARNABY enter the Iron Gateway while PIP scouts ahead.',
      synopsis: 'The trio enters the storm drain.',
      characters: ['SALTY', 'BARNABY', 'PIP'],
      setting: 'The Iron Gateway'
    },
    {
      id: 2,
      rawText: 'PIP spots the SUPER-BOUNCE 3000 in the Pipe-Room of Whispers.',
      synopsis: 'Pip points to the neon ball.',
      characters: ['PIP'],
      setting: 'Pipe-Room of Whispers'
    }
  ];

  const script = `
THE UNDERBELLY HEIST
SALTY leads BARNABY and PIP through the Iron Gateway.
The SUPER-BOUNCE 3000 is lodged in the Pipe-Room of Whispers.
`.trim();

  it('removes cross-story entities from a contaminated world response', () => {
    const characters: Character[] = [
      { id: 'c1', name: 'SALTY', bio: '', description: 'Battle-hardened ginger tabby with one milky-white eye.', referenceImageIds: [] },
      { id: 'c2', name: 'Elara Meadowlight', bio: '', description: 'Young sorceress in enchanted robes with rune tattoos.', referenceImageIds: [] }
    ];
    const items: Item[] = [
      { id: 'i1', name: 'SUPER-BOUNCE 3000', description: 'Neon-lime rubber sphere with a holographic star logo.', referenceImageIds: [] },
      { id: 'i2', name: 'Sunstone Compass', description: 'Golden compass radiating warm light from etched sigils.', referenceImageIds: [] }
    ];
    const locations: Location[] = [
      { id: 'l1', name: 'Pipe-Room of Whispers', description: 'Cavernous pipe junction with flickering bulbs and rusted valves.', referenceImageIds: [] },
      { id: 'l2', name: 'Emberfall Village', description: 'Fantasy hamlet of stone cottages beside glowing lava streams.', referenceImageIds: [] }
    ];

    const grounded = groundWorldEntities({
      scenes,
      script,
      characters,
      items,
      locations,
      limits: { characters: 20, items: 20, locations: 20 }
    });

    expect(grounded.characters.map((entry) => entry.name)).toEqual(['SALTY']);
    expect(grounded.items.map((entry) => entry.name)).toEqual(['SUPER-BOUNCE 3000']);
    expect(grounded.locations.map((entry) => entry.name)).toEqual(['Pipe-Room of Whispers']);
    expect(grounded.diagnostics.dropped_entities.length).toBeGreaterThan(0);
  });
});
