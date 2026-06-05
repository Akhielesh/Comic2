import { describe, it, expect } from 'vitest';
import { scanOutput } from './guardrails.js';

const base = { toolRan: true, citationCount: 1 };

describe('scanOutput — secret/credential leak', () => {
  it('flags an OpenAI/OpenRouter-style key and redacts the sample', () => {
    const { flags } = scanOutput({ ...base, text: 'Use key sk-or-v1-abcdefghijklmnopqrstuvwxyz012345 to call it.' });
    const leak = flags.find((f) => f.type === 'secret_leak');
    expect(leak).toBeTruthy();
    expect(leak!.level).toBe('error');
    // The raw secret must never appear in the flag.
    expect(leak!.sample).not.toContain('abcdefghijklmnop');
    expect(leak!.sample).toContain('…');
  });

  it('flags AWS, GitHub and private-key blocks', () => {
    expect(scanOutput({ ...base, text: 'id AKIAIOSFODNN7EXAMPLE here' }).flags.some((f) => f.type === 'secret_leak')).toBe(true);
    expect(scanOutput({ ...base, text: 'token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' }).flags.some((f) => f.type === 'secret_leak')).toBe(true);
    expect(scanOutput({ ...base, text: '-----BEGIN RSA PRIVATE KEY-----' }).flags.some((f) => f.type === 'secret_leak')).toBe(true);
  });

  it('does not flag ordinary prose with no credentials', () => {
    const { flags } = scanOutput({ ...base, text: 'The build passed and the tests are green.' });
    expect(flags.some((f) => f.type === 'secret_leak')).toBe(false);
  });
});

describe('scanOutput — fabricated figures', () => {
  it('flags monetary figures when no tool ran', () => {
    const { flags } = scanOutput({ text: 'Apple is trading at $214.50 today.', toolRan: false, citationCount: 0 });
    expect(flags.some((f) => f.type === 'unverified_figures')).toBe(true);
  });

  it('does NOT flag figures when a tool ran (they are verified)', () => {
    const { flags } = scanOutput({ text: 'Apple is trading at $214.50 today.', toolRan: true, citationCount: 0 });
    expect(flags.some((f) => f.type === 'unverified_figures')).toBe(false);
  });

  it('does NOT flag generic numbers (years, counts, math) as figures', () => {
    const { flags } = scanOutput({ text: 'In 2026 there were 12 chapters, and 3 + 4 = 7.', toolRan: false, citationCount: 0 });
    expect(flags.some((f) => f.type === 'unverified_figures')).toBe(false);
  });
});

describe('scanOutput — missing citations', () => {
  it('flags a sourced claim with no citations', () => {
    const { flags } = scanOutput({ text: 'According to Reuters, the deal closed.', toolRan: false, citationCount: 0 });
    expect(flags.some((f) => f.type === 'missing_citations')).toBe(true);
  });

  it('does not flag when citations are present', () => {
    const { flags } = scanOutput({ text: 'According to Reuters, the deal closed.', toolRan: true, citationCount: 2 });
    expect(flags.some((f) => f.type === 'missing_citations')).toBe(false);
  });
});

describe('scanOutput — robustness', () => {
  it('returns no flags for empty text', () => {
    expect(scanOutput({ text: '', toolRan: false, citationCount: 0 }).flags).toEqual([]);
    expect(scanOutput({ text: '   ', toolRan: false, citationCount: 0 }).flags).toEqual([]);
  });

  it('flags an email at info level', () => {
    const { flags } = scanOutput({ ...base, text: 'Reach me at jane.doe@example.com.' });
    const pii = flags.find((f) => f.type === 'pii_email');
    expect(pii?.level).toBe('info');
  });
});
