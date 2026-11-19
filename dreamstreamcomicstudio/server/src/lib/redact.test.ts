import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDACT_MAX_CHARS, redactSecrets } from './redact.js';
import { logger } from './logger.js';

// Every key below is an obviously fake shape: the right prefix and length, made of repeated filler.
const FAKE = {
  openrouter: `sk-or-v1-${'0'.repeat(64)}`,
  anthropic: `sk-ant-api03-${'test0000'.repeat(10)}`,
  openai: `sk-proj-${'test0000'.repeat(6)}`,
  openaiLegacy: `sk-${'0'.repeat(48)}`,
  xai: `xai-${'0'.repeat(80)}`,
  nvidia: `nvapi-${'test-0000'.repeat(7)}`,
  google: `AIza${'Test_0000-'.repeat(4)}`,
  jwt: `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(30)}.${'c'.repeat(40)}`
};

describe('redactSecrets', () => {
  it.each(Object.entries(FAKE))('replaces a %s key with [key]', (_name, key) => {
    const out = redactSecrets(`before ${key} after`);
    expect(out).toBe('before [key] after');
    expect(out).not.toContain(key.slice(0, 12));
  });

  it('keeps the word in front of a bearer token or an x-api-key header and drops the value', () => {
    expect(redactSecrets('Authorization: Bearer some-opaque-token-123')).toBe('Authorization: Bearer [key]');
    expect(redactSecrets('x-api-key: opaque-value-123 sent')).toBe('x-api-key: [key] sent');
  });

  it('removes masked echoes of a key that a vendor puts back into its error text', () => {
    expect(redactSecrets('Incorrect API key provided: sk-proj-abcd****************wxyz. See docs.')).toBe(
      'Incorrect API key provided: [key] See docs.'
    );
    expect(redactSecrets('Incorrect API key provided: sk-proj-abcd…wxyz')).toBe('Incorrect API key provided: [key]');
    expect(redactSecrets('the key: ab***cd was refused')).toBe('the key: [key] was refused');
    // A masked token on its own, with no "provided:" in front of it.
    expect(redactSecrets('rejected sk-ab12…9xyz today')).toBe('rejected [key] today');
    expect(redactSecrets('rejected sk-proj-ab12****9xyz today')).toBe('rejected [key] today');
  });

  it('leaves ordinary sentences untouched', () => {
    const plain = [
      'The writer took too long to answer. Please try again.',
      'A risk-free, task-based plan for the ask-me-anything page.',
      'Use the key to open the door: it is under the mat.',
      'OpenAI /chat/completions failed: 400 Bad Request (content_policy_violation) Your request was rejected.',
      'gpt-4o-mini, claude-sonnet-4-5 and gemini-2.5-flash are model names, not keys.',
      'A token budget of 2048 keeps the answer short.'
    ];
    for (const line of plain) expect(redactSecrets(line)).toBe(line);
  });

  it(`caps the input at ${REDACT_MAX_CHARS} characters and never keeps a key cut in half at the edge`, () => {
    const long = `${'word '.repeat(2000)}${FAKE.openai}`;
    const out = redactSecrets(long);
    expect(out.length).toBeLessThanOrEqual(REDACT_MAX_CHARS + 1);
    expect(out).not.toContain('sk-');
    // A key that straddles the cap: its kept half is dropped, not left behind as a fragment.
    const straddle = `${'x '.repeat((REDACT_MAX_CHARS - 10) / 2)}${FAKE.anthropic}`;
    const cut = redactSecrets(straddle);
    expect(cut).not.toContain('sk-ant');
    expect(cut.length).toBeLessThanOrEqual(REDACT_MAX_CHARS + 1);
  });

  it('finishes 100 KB of adversarial input in under 50 ms', () => {
    const inputs = [
      'key:'.repeat(25_000),
      'provided: '.repeat(10_000),
      'sk-'.repeat(33_000),
      `Bearer ${'a'.repeat(100_000)}`,
      `${'*'.repeat(50_000)}key:${'x'.repeat(50_000)}`,
      'eyJ'.repeat(33_000)
    ];
    for (const input of inputs) {
      const started = performance.now();
      redactSecrets(input);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it('accepts a non-string without throwing', () => {
    expect(redactSecrets(undefined as unknown as string)).toBe('');
    expect(redactSecrets(42 as unknown as string)).toBe('42');
  });
});

describe('logger output', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts key-shaped text in the event and in every string field, at any depth', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: string) => {
      lines.push(line);
    });
    logger.warn(`provider_failed ${FAKE.openai}`, {
      detail: `OpenAI failed: 401 (invalid_api_key) Incorrect API key provided: ${FAKE.openai}`,
      nested: { deeper: { list: [FAKE.anthropic, 'plain'], deepest: { more: { text: FAKE.google } } } },
      count: 3,
      ok: true
    });
    expect(lines).toHaveLength(1);
    const line = lines[0];
    for (const key of Object.values(FAKE)) expect(line).not.toContain(key.slice(0, 12));
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('warn');
    expect(parsed.event).toBe('provider_failed [key]');
    expect(parsed.count).toBe(3);
    expect(parsed.ok).toBe(true);
    expect(parsed.nested.deeper.list).toEqual(['[key]', 'plain']);
    expect(parsed.nested.deeper.deepest.more.text).toBe('[key]');
  });

  it('keeps ordinary fields byte for byte (dates and numbers included)', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((line: string) => {
      lines.push(line);
    });
    const at = new Date('2026-11-19T00:00:00.000Z');
    logger.info('comic_llm_hop', { role: 'writer', route: 'anthropic', hop: 1, of: 2, at });
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ event: 'comic_llm_hop', role: 'writer', route: 'anthropic', hop: 1, of: 2, at: at.toISOString() });
  });
});
