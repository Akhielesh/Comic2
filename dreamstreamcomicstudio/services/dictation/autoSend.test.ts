// Spoken words send themselves only when the person chose it, tapped Done, used browser dictation in English,
// and did not ask to remove something. Everything else waits in the box.
import { describe, expect, it } from 'vitest';
import { isEnglish, looksLikeRemoval, voiceAutoSend } from './autoSend';

const done = { end: 'user', engine: 'browser-cloud' } as const;

describe('voiceAutoSend', () => {
  it('sends only a chosen, Done-ended, browser-dictation, English take', () => {
    expect(voiceAutoSend({ chosen: true, info: done, text: 'make it rain', lang: 'en-GB' })).toBe('send');
    expect(voiceAutoSend({ chosen: false, info: done, text: 'make it rain', lang: 'en-US' })).toBe('wait');
    for (const end of ['escape', 'silence', 'no-speech', 'limit', 'hidden', 'device', 'engine'] as const) {
      expect(voiceAutoSend({ chosen: true, info: { end, engine: 'browser-cloud' }, text: 'make it rain', lang: 'en-US' }), end).toBe('wait');
    }
    expect(voiceAutoSend({ chosen: true, info: { end: 'user', engine: 'whisper' }, text: 'make it rain', lang: 'en-US' })).toBe('wait');
    expect(voiceAutoSend({ chosen: true, info: done, text: 'haz que llueva', lang: 'es-ES' })).toBe('wait');
    expect(voiceAutoSend({ chosen: true, info: done, text: '   ', lang: 'en-US' })).toBe('wait');
  });

  it('holds a message that asks to remove something', () => {
    expect(voiceAutoSend({ chosen: true, info: done, text: 'delete page 3', lang: 'en-US' })).toBe('hold-removal');
  });
});

describe('looksLikeRemoval', () => {
  it('catches removals, and keeps comic directions like "cut to"', () => {
    for (const t of ['delete page 3', 'get rid of the caption', 'scrap that', 'cut the last panel', 'start over', 'Remove the dog', 'throw it away', 'undo'])
      expect(looksLikeRemoval(t), t).toBe(true);
    for (const t of ['cut to the castle', 'cut away to the sky', 'make it rain', 'a deleted scene feel', 'add a cutlass']) expect(looksLikeRemoval(t), t).toBe(false);
  });

  it('isEnglish reads the primary language subtag', () => {
    expect(isEnglish('en')).toBe(true);
    expect(isEnglish('en-IN')).toBe(true);
    expect(isEnglish('es-MX')).toBe(false);
    expect(isEnglish(undefined)).toBe(false);
  });
});
