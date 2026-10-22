import { describe, expect, it } from 'vitest';
import { NAME_MAX, cleanName, resolveName, splitName } from './accountName';

describe('cleanName', () => {
  it('trims, collapses spaces and drops control characters', () => {
    expect(cleanName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(cleanName('Ada\tLove\nlace')).toBe('Ada Love lace');
    expect(cleanName('Ada\u0000Lovelace')).toBe('Ada Lovelace');
  });

  it('caps at the Stream Studio limit without leaving a trailing space', () => {
    const long = `${'a'.repeat(NAME_MAX - 1)} bcd`;
    const out = cleanName(long)!;
    expect(out.length).toBeLessThanOrEqual(NAME_MAX);
    expect(out.endsWith(' ')).toBe(false);
    expect(cleanName('x'.repeat(100))).toHaveLength(NAME_MAX);
  });

  it('returns null for nothing usable', () => {
    expect(cleanName('')).toBeNull();
    expect(cleanName('   ')).toBeNull();
    expect(cleanName('\u0007')).toBeNull();
    expect(cleanName(undefined)).toBeNull();
    expect(cleanName(42)).toBeNull();
    expect(cleanName({ name: 'Ada' })).toBeNull();
  });

  it('normalizes composed characters so the same name compares equal', () => {
    expect(cleanName('José')).toBe('José');
  });
});

describe('splitName', () => {
  it('first word, then the rest', () => {
    expect(splitName('Ada')).toEqual({ first: 'Ada', last: null });
    expect(splitName('Ada Lovelace')).toEqual({ first: 'Ada', last: 'Lovelace' });
    expect(splitName('Mary Ann Evans')).toEqual({ first: 'Mary', last: 'Ann Evans' });
  });
});

describe('resolveName', () => {
  it('prefers the Stream Studio name, then first + last, then the handle', () => {
    expect(resolveName({ live: 'Mum', first: 'Ada', last: 'Lovelace', username: 'ada_1' })).toBe('Mum');
    expect(resolveName({ live: '  ', first: 'Ada', last: 'Lovelace', username: 'ada_1' })).toBe('Ada Lovelace');
    expect(resolveName({ first: 'Ada', last: null, username: 'ada_1' })).toBe('Ada');
    expect(resolveName({ first: ' ', last: 'Lovelace' })).toBe('Lovelace');
    expect(resolveName({ username: 'ada_1' })).toBe('ada_1');
    expect(resolveName({})).toBeNull();
  });
});
