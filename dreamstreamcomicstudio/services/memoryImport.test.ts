import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_CHARS, prepareMemoryImportContent } from './memoryImport';

describe('prepareMemoryImportContent', () => {
  it('passes plain text through trimmed', () => {
    expect(prepareMemoryImportContent('  Prefers concise answers.\nWorks in Berlin.  '))
      .toBe('Prefers concise answers.\nWorks in Berlin.');
  });

  it('returns empty string for empty input', () => {
    expect(prepareMemoryImportContent('')).toBe('');
    expect(prepareMemoryImportContent('   \n  ')).toBe('');
  });

  it('caps oversized payloads at the server limit', () => {
    const huge = 'x'.repeat(MAX_IMPORT_CHARS + 5000);
    expect(prepareMemoryImportContent(huge)).toHaveLength(MAX_IMPORT_CHARS);
  });

  it('extracts user messages from a ChatGPT-style export and drops assistant turns', () => {
    const exportJson = JSON.stringify([
      {
        title: 'Trip planning',
        create_time: 1700000000,
        mapping: {
          a: { message: { author: { role: 'user' }, content: { parts: ['I live in Hyderabad and prefer metric units'] } } },
          b: { message: { author: { role: 'assistant' }, content: { parts: ['Great! Hyderabad is lovely in winter.'] } } }
        }
      }
    ]);
    const out = prepareMemoryImportContent(exportJson);
    expect(out).toContain('I live in Hyderabad and prefer metric units');
    expect(out).not.toContain('Hyderabad is lovely');
  });

  it('extracts human turns from a Claude-style export and drops the assistant', () => {
    const exportJson = JSON.stringify({
      chat_messages: [
        { sender: 'human', text: 'Remember that I am allergic to peanuts when suggesting recipes' },
        { sender: 'assistant', text: 'Noted — no peanuts in any recipe I suggest.' }
      ]
    });
    const out = prepareMemoryImportContent(exportJson);
    expect(out).toContain('allergic to peanuts');
    expect(out).not.toContain('Noted — no peanuts');
  });

  it('harvests memory-ish fields outside chat shapes but not metadata', () => {
    const exportJson = JSON.stringify({
      memories: ['Vegetarian', 'Uses TypeScript at work'],
      model_slug: 'gpt-4o',
      url: 'https://example.com/x'
    });
    const out = prepareMemoryImportContent(exportJson);
    expect(out).toContain('Vegetarian');
    expect(out).toContain('Uses TypeScript at work');
    expect(out).not.toContain('gpt-4o');
    expect(out).not.toContain('example.com');
  });

  it('deduplicates repeated entries', () => {
    const exportJson = JSON.stringify({ memories: ['Vegetarian', 'Vegetarian', 'Vegetarian'] });
    expect(prepareMemoryImportContent(exportJson)).toBe('Vegetarian');
  });

  it('falls back to raw text for JSON with no user-authored strings', () => {
    const json = JSON.stringify({ id: 'abc', create_time: 123 });
    expect(prepareMemoryImportContent(json)).toBe(json);
  });
});
