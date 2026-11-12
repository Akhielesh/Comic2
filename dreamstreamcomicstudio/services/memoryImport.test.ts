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
          c: { id: 'c', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['I cook for two on weekdays'] } } },
          // A code turn: its language label is not the user's words.
          d: { id: 'd', message: { author: { role: 'user' }, content: { content_type: 'code', language: 'unknown', text: 'print(1) my code' } } },
          // A multimodal turn: the image pointer and its sizes are not words; the caption is.
          e: {
            id: 'e',
            message: {
              author: { role: 'user' },
              content: {
                content_type: 'multimodal_text',
                parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-abc', size_bytes: 1234, width: 512, height: 512 }, 'This is my kitchen']
              }
            }
          }
        }
      }
    ];
    expect(prepareMemoryImportContent(JSON.stringify(conversations))).toBe(
      'I am vegetarian\nI cook for two on weekdays\nprint(1) my code\nThis is my kitchen'
    );

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

  it("JSON in an unrecognised layout never sends the assistant's reply under a generic text key", () => {
    // The fixer review's probes: a prompt/answer pair with no role marker keeps the answer
    // under `text` / `content` / `value`. Neither side is known to be the user's, so nothing is sent.
    const probes = [
      [{ prompt: 'I am vegan', response: { text: 'ASSISTANT ANSWER: try tofu' } }],
      [{ question: 'I live in Pune', answer: { content: 'ASSISTANT ANSWER: Pune is nice' } }],
      { threads: [{ query: 'best vegan spots', answer: { content: [{ text: 'ASSISTANT ANSWER perplexity' }] } }] },
      [{ q: 'my prompt', text: 'ASSISTANT ANSWER flat' }],
      { conversations: [{ input: 'hello there', output: { value: 'ASSISTANT ANSWER value' } }] }
    ];
    for (const probe of probes) expect(prepareMemoryImportContent(JSON.stringify(probe))).toBe('');
  });

  it('generic text keys still count under a user turn or a memory key', () => {
    // A Gemini API transcript: contents[].role marks the turn, parts[].text holds the words.
    const gemini = {
      contents: [
        { role: 'user', parts: [{ text: 'I run a bakery in Kochi' }] },
        { role: 'model', parts: [{ text: 'ASSISTANT: what a lovely job' }] }
      ]
    };
    expect(prepareMemoryImportContent(JSON.stringify(gemini))).toBe('I run a bakery in Kochi');
    // Memory entries as objects: `text` / `content` / `value` under a memory key are the user's.
    const memories = {
      memories: [{ id: 'm1', text: 'Vegetarian' }, { content: 'Lives in Lisbon' }, { value: 'Prefers metric units' }],
      saved_info: [{ text: 'Cooks for two' }]
    };
    expect(prepareMemoryImportContent(JSON.stringify(memories))).toBe(
      'Vegetarian\nLives in Lisbon\nPrefers metric units\nCooks for two'
    );
    // A bare list of strings is still imported directly.
    expect(prepareMemoryImportContent(JSON.stringify(['Vegetarian', 'Lives in Lisbon']))).toBe('Vegetarian\nLives in Lisbon');
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
    // Known limit, kept on purpose: a cut-off export is not JSON, whole or line by line, so it goes
    // as written, assistant lines included (the docs and the privacy copy say so).
    const cutOffLines = '{"role":"user","text":"I am vegan"}\n{"role":"assistant","text":"ASSISTANT ANSWER cut';
    expect(prepareMemoryImportContent(cutOffLines)).toBe(cutOffLines);
  });

  it('reads a .jsonl export line by line: the user’s turns are sent, the assistant’s never', () => {
    const jsonl = [
      '{"role":"user","text":"I am vegan"}',
      '{"role":"assistant","text":"ASSISTANT ANSWER jsonl"}',
      '',
      '{"author":{"role":"user"},"content":{"content_type":"text","parts":["I live in Lisbon"]}}',
      '{"sender":"assistant","text":"ASSISTANT ANSWER two"}'
    ].join('\r\n');
    const sent = prepareMemoryImportContent(jsonl);
    expect(sent).toBe('I am vegan\nI live in Lisbon');
    expect(sent).not.toContain('ASSISTANT');
    // Memory keys and bare string arrays work per line, as they do in one JSON value.
    expect(prepareMemoryImportContent('{"memories":["Vegetarian"]}\n["Prefers short answers"]')).toBe('Vegetarian\nPrefers short answers');
  });

  it('a .jsonl file with none of the user’s own words sends nothing (the same rule as JSON)', () => {
    const assistantOnly = '{"role":"assistant","text":"ASSISTANT ANSWER one"}\n{"role":"model","text":"ASSISTANT ANSWER two"}';
    expect(prepareMemoryImportContent(assistantOnly)).toBe('');
    // No role marker: the prompt and the answer cannot be told apart, so neither is sent.
    const unanchored = '{"prompt":"I am vegan","response":{"text":"ASSISTANT ANSWER"}}\n{"q":"hello","text":"ASSISTANT ANSWER"}';
    expect(prepareMemoryImportContent(unanchored)).toBe('');
    // Ids and timestamps alone: nothing.
    expect(prepareMemoryImportContent('{"id":"a","create_time":1}\n{"id":"b","create_time":2}')).toBe('');
  });

  it('only real JSON Lines are read that way: one bad line, or a line that is not an object or array, keeps the text as written', () => {
    const oneBadLine = '{"role":"user","text":"I am vegan"}\nnot json at all\n{"role":"assistant","text":"ANSWER"}';
    expect(prepareMemoryImportContent(oneBadLine)).toBe(oneBadLine);
    const scalarLine = '{"role":"user","text":"I am vegan"}\n42';
    expect(prepareMemoryImportContent(scalarLine)).toBe(scalarLine);
  });

  it('keeps the caps across the lines of a .jsonl file: 800 pieces and 24,000 characters', () => {
    const many = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ role: 'user', text: `fact ${i}` })).join('\n');
    expect(prepareMemoryImportContent(many).split('\n')).toHaveLength(800);
    const long = Array.from({ length: 40 }, (_, i) => JSON.stringify({ role: 'user', text: `${i} ${'y'.repeat(1000)}` })).join('\n');
    expect(prepareMemoryImportContent(long)).toHaveLength(MAX_IMPORT_CHARS);
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
