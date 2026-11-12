import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_CHARS, memoryImportNothingFoundNotice, prepareMemoryImportContent } from './memoryImport';

/** A Google Takeout "My Activity" entry (MyActivity.json): the answer sits in safeHtmlItem. */
const takeoutEntry = (title: string, answer: string, header = 'Gemini Apps') => ({
  header,
  title,
  time: '2026-05-01T12:00:00.000Z',
  products: [header],
  activityControls: [`${header} Activity`],
  safeHtmlItem: [{ html: `<p>${answer}</p>` }],
  subtitles: [{ name: 'Gemini Apps' }]
});

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

  it('sends nothing for JSON with no user-authored strings (never the raw JSON)', () => {
    const json = JSON.stringify({ id: 'abc', create_time: 123 });
    expect(prepareMemoryImportContent(json)).toBe('');
    expect(prepareMemoryImportContent('{}')).toBe('');
    expect(prepareMemoryImportContent('[]')).toBe('');
  });

  it("sends nothing for a Takeout-shaped file in a layout it doesn't recognise: the assistant's answer never leaves", () => {
    // The probe from the review: [{header, title, safeHtmlItem:[{html: answer}]}] with no time.
    const probe = JSON.stringify([
      { header: 'Gemini Apps', title: 'what should I cook tonight', safeHtmlItem: [{ html: 'ASSISTANT ANSWER: try a lentil curry' }] }
    ]);
    expect(prepareMemoryImportContent(probe)).toBe('');
    // A full Takeout entry whose title has no separable words of the user's ("Used …", "Visited …", another language).
    const unseparable = JSON.stringify([
      takeoutEntry('Used Gemini Apps', 'ASSISTANT ANSWER one'),
      takeoutEntry('Visited Lentil curry recipes', 'ASSISTANT ANSWER two', 'Search'),
      takeoutEntry('Eingegebener Prompt: was koche ich heute', 'ASSISTANT ANSWER three')
    ]);
    expect(prepareMemoryImportContent(unseparable)).toBe('');
  });

  it("Takeout 'My Activity': only the words after 'Prompted ' / 'Searched for ' are sent, never the answer or labels", () => {
    const takeout = JSON.stringify([
      takeoutEntry('Prompted I am vegetarian and live in Lisbon, plan my week of dinners', 'ASSISTANT ANSWER: Monday, a chickpea stew'),
      takeoutEntry('Used Gemini Apps', 'ASSISTANT ANSWER: hello'),
      takeoutEntry('Searched for lisbon vegetarian markets', 'unused', 'Search'),
      takeoutEntry('Prompted hi', 'ASSISTANT ANSWER: too short to keep')
    ]);
    expect(prepareMemoryImportContent(takeout)).toBe(
      'I am vegetarian and live in Lisbon, plan my week of dinners\nlisbon vegetarian markets'
    );
  });

  it("a ChatGPT conversations.json sends exactly the user's turns, and one with no user turn sends nothing", () => {
    const conversations = [
      {
        title: 'Dinner ideas',
        create_time: 1700000000,
        mapping: {
          s: { id: 's', message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['You are ChatGPT.'] } } },
          a: { id: 'a', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['I am vegetarian'] } } },
          b: { id: 'b', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['ASSISTANT: try a dal'] } } },
          c: { id: 'c', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['I cook for two on weekdays'] } } }
        }
      }
    ];
    expect(prepareMemoryImportContent(JSON.stringify(conversations))).toBe('I am vegetarian\nI cook for two on weekdays');

    const assistantOnly = [{ title: 'Greeting', mapping: { b: { message: { author: { role: 'assistant' }, content: { parts: ['ASSISTANT: Hello there, how can I help?'] } } } } }];
    expect(prepareMemoryImportContent(JSON.stringify(assistantOnly))).toBe('');
  });

  it("a Claude conversations.json sends exactly the human turns' text, without content labels or timestamps", () => {
    const claude = [
      {
        uuid: 'c1',
        name: 'Recipes',
        created_at: '2026-05-01T12:00:00Z',
        chat_messages: [
          {
            uuid: 'm1', sender: 'human', text: 'I am allergic to peanuts',
            content: [{ type: 'text', text: 'I am allergic to peanuts', start_timestamp: '2026-05-01T12:00:00Z', stop_timestamp: '2026-05-01T12:00:01Z' }],
            created_at: '2026-05-01T12:00:00Z'
          },
          {
            uuid: 'm2', sender: 'assistant', text: 'ASSISTANT: noted, no peanuts',
            content: [{ type: 'text', text: 'ASSISTANT: noted, no peanuts' }]
          }
        ]
      }
    ];
    expect(prepareMemoryImportContent(JSON.stringify(claude))).toBe('I am allergic to peanuts');
  });

  it('keeps plain text and markdown as written', () => {
    const md = '# About me\n\n- Prefers metric units\n- [Portfolio](https://example.com) is up to date';
    expect(prepareMemoryImportContent(`\n${md}\n`)).toBe(md);
  });

  it('treats text that looks like JSON but does not parse as plain text, as today', () => {
    const truncated = '{"memories": ["Vegetarian", "Lives in Lisbon"';
    expect(prepareMemoryImportContent(truncated)).toBe(truncated);
    const bracketed = '[x] I take notes in markdown\n[ ] Remind me about the dentist';
    expect(prepareMemoryImportContent(bracketed)).toBe(bracketed);
  });

  it('keeps the caps on extracted JSON: 24,000 characters and 800 pieces', () => {
    const long = JSON.stringify({ memories: Array.from({ length: 40 }, (_, i) => `${i} ${'y'.repeat(1000)}`) });
    expect(prepareMemoryImportContent(long)).toHaveLength(MAX_IMPORT_CHARS);
    const many = JSON.stringify({ memories: Array.from({ length: 1000 }, (_, i) => `fact ${i}`) });
    expect(prepareMemoryImportContent(many).split('\n')).toHaveLength(800);
  });

  it('names the file or the text in the calm notice', () => {
    expect(memoryImportNothingFoundNotice(true)).toBe("We couldn't find your own words in that file, so nothing was sent.");
    expect(memoryImportNothingFoundNotice(false)).toBe("We couldn't find your own words in that text, so nothing was sent.");
  });
});
