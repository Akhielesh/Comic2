import { describe, it, expect } from 'vitest';
import { coerceJson, coerceJsonOrNull, extractBalancedJson } from './jsonCoerce.js';

describe('coerceJson', () => {
  it('parses clean JSON objects', () => {
    expect(coerceJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses clean JSON arrays', () => {
    expect(coerceJson('[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('strips ```json markdown fences', () => {
    expect(coerceJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips bare ``` fences', () => {
    expect(coerceJson('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it('extracts JSON embedded in prose', () => {
    expect(coerceJson('Here is the result: {"a":1, "b":[2,3]} — done!')).toEqual({ a: 1, b: [2, 3] });
  });

  it('tolerates trailing commas', () => {
    expect(coerceJson('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it('does not break on braces inside strings', () => {
    expect(coerceJson('{"text":"a } b ] c { d ["}')).toEqual({ text: 'a } b ] c { d [' });
  });

  it('handles escaped quotes inside strings', () => {
    expect(coerceJson('{"q":"she said \\"hi\\""}')).toEqual({ q: 'she said "hi"' });
  });

  it('throws on unrecoverable garbage', () => {
    expect(() => coerceJson('not json at all')).toThrow();
  });

  it('coerceJsonOrNull returns null for garbage', () => {
    expect(coerceJsonOrNull('not json at all')).toBeNull();
  });

  it('coerceJsonOrNull returns null for empty input', () => {
    expect(coerceJsonOrNull('   ')).toBeNull();
  });
});

describe('extractBalancedJson', () => {
  it('finds the first balanced object', () => {
    expect(extractBalancedJson('xx {"a":1} yy')).toBe('{"a":1}');
  });

  it('finds nested objects fully', () => {
    expect(extractBalancedJson('{"a":{"b":1}} trailing')).toBe('{"a":{"b":1}}');
  });

  it('returns null when no block exists', () => {
    expect(extractBalancedJson('no json here')).toBeNull();
  });
});
