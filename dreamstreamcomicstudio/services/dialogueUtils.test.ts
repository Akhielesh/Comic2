import { describe, expect, it } from 'vitest';
import type { DialogueBlock } from '../types';
import { ensureDialogueBlocks, isDescriptionEcho, normalizePanelDialogue, readerDialogueBlocks } from './dialogueUtils';

// Legacy comics: the generator's description fallback (ensureDialogueBlocks' third argument) stored the panel's scene
// description as a caption block on some panels, and readers showed it as if a character said it. Readers now render
// with readerDialogueBlocks: no description fallback, and stored blocks that echo the description are hidden.
// Nothing stored changes; the editor and generator keep ensureDialogueBlocks / normalizePanelDialogue as they were.

const DESC = 'Wide establishing shot of the harbour at dawn, cinematic lighting, gulls over the masts, Meera on the pier holding a lantern.';
const block = (text: string, extra: Partial<DialogueBlock> = {}): DialogueBlock => ({ id: `b-${text.length}`, kind: 'caption', text, side: 'left', ...extra });

describe('isDescriptionEcho', () => {
  it('matches the stored fallback (the description cut at 157 characters plus "...")', () => {
    const long = `${DESC} The tide is out and the boats lean on their keels in the mud while the town wakes up behind them.`;
    expect(long.length).toBeGreaterThan(160);
    const fallback = ensureDialogueBlocks(undefined, undefined, long)[0].text;
    expect(fallback.endsWith('...')).toBe(true);
    expect(isDescriptionEcho(fallback, long)).toBe(true);
  });

  it('matches the whole description, ignoring case and spacing', () => {
    expect(isDescriptionEcho(`  ${DESC.toUpperCase().replace(/ /g, '   ')} `, DESC)).toBe(true);
  });

  it('never matches short lines, real dialogue, or a line that merely starts the same way', () => {
    expect(isDescriptionEcho('Wide establishing shot', DESC)).toBe(false); // under 40 characters
    expect(isDescriptionEcho('Meera: "The boats are back!"', DESC)).toBe(false);
    expect(isDescriptionEcho('Wide establishing shot of the harbour at dawn — and then the bell rang twice.', DESC)).toBe(false);
    expect(isDescriptionEcho(DESC, '')).toBe(false);
    expect(isDescriptionEcho(DESC, undefined)).toBe(false);
  });

  it('never hides a line that repeats the whole description and then goes on', () => {
    expect(isDescriptionEcho(`${DESC} And then the bell rang.`, DESC)).toBe(false);
    const pier = 'Meera stands at the end of the pier at dawn.';
    expect(isDescriptionEcho(`${pier} Three years she has waited.`, pier)).toBe(false);
    expect(isDescriptionEcho(pier, pier)).toBe(true); // the exact echo still is one
    const kept = readerDialogueBlocks({ dialogueBlocks: [block(`${pier} Three years she has waited.`, { kind: 'narration', id: 'n' })], description: pier });
    expect(kept.map((b) => b.id)).toEqual(['n']);
  });
});

describe('readerDialogueBlocks', () => {
  it('never falls back to the scene description', () => {
    expect(readerDialogueBlocks({ dialogue: '', dialogueBlocks: [], description: DESC })).toEqual([]);
    expect(readerDialogueBlocks({ description: DESC })).toEqual([]);
  });

  it('hides stored blocks (and stored dialogue strings) that echo the description, keeps the rest in order', () => {
    const blocks = [block(DESC), block('Meera: The boats are back!', { kind: 'speech', id: 'real' }), block('Later that day.', { kind: 'narration', id: 'n' })];
    expect(readerDialogueBlocks({ dialogueBlocks: blocks, description: DESC }).map((b) => b.id)).toEqual(['real', 'n']);
    // normalizePanelDialogue writes the fallback into BOTH dialogueBlocks and dialogue.
    const stored = normalizePanelDialogue({ id: 'p', sceneId: 1, description: DESC, dialogue: '', imageIdHistory: [] });
    expect(stored.dialogueBlocks).toHaveLength(1);
    expect(readerDialogueBlocks(stored)).toEqual([]);
    expect(readerDialogueBlocks({ dialogue: stored.dialogue, description: DESC })).toEqual([]);
  });

  it('keeps real dialogue exactly as ensureDialogueBlocks gives it', () => {
    const blocks = [block('Hold the lantern higher!', { kind: 'speech', speaker: 'Meera', id: 's1' })];
    expect(readerDialogueBlocks({ dialogueBlocks: blocks, description: DESC })).toEqual(ensureDialogueBlocks(undefined, blocks));
    const fromString = readerDialogueBlocks({ dialogue: 'Hello there', description: DESC });
    expect(fromString).toHaveLength(1);
    expect(fromString[0]).toMatchObject({ kind: 'speech', text: 'Hello there' });
  });

  it('leaves the editor/generator helpers unchanged (stored data keeps its fallback)', () => {
    expect(ensureDialogueBlocks('', [], DESC)).toHaveLength(1);
    expect(ensureDialogueBlocks('', [], DESC)[0]).toMatchObject({ kind: 'caption', text: DESC });
  });
});
