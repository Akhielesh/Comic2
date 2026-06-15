import { describe, it, expect } from 'vitest';
import { parseToolArguments } from './chat.js';

// parseToolArguments is the native tool-loop's defensive replacement for
// `try { JSON.parse(call.arguments) } catch { {} }`. The provider streams tool
// arguments as concatenated fragments that the output-token budget can truncate
// mid-JSON — the whole chart/app/UI payload rides inside that string. The old code
// silently ran the tool with no args (a fake "no input" success); this distinguishes
// "valid", "recovered", and genuinely "malformed" so the loop can ask the model to retry.

describe('parseToolArguments', () => {
  it('fast-paths a clean JSON object', () => {
    expect(parseToolArguments('{"symbol":"AAPL","range":"1y"}')).toEqual({
      args: { symbol: 'AAPL', range: '1y' },
      recovered: false,
      malformed: false
    });
  });

  it('treats empty / "{}" / whitespace as empty args, not malformed', () => {
    for (const raw of [undefined, '', '   ', '{}', '  {}  ']) {
      expect(parseToolArguments(raw)).toEqual({ args: {}, recovered: false, malformed: false });
    }
  });

  it('recovers trailing-comma JSON the bare parser rejects', () => {
    const r = parseToolArguments('{"symbol":"AAPL",}');
    expect(r.args).toEqual({ symbol: 'AAPL' });
    expect(r.recovered).toBe(true);
    expect(r.malformed).toBe(false);
  });

  it('recovers fenced JSON', () => {
    const r = parseToolArguments('```json\n{"q":"x"}\n```');
    expect(r.args).toEqual({ q: 'x' });
    expect(r.recovered).toBe(true);
    expect(r.malformed).toBe(false);
  });

  it('flags truncated mid-JSON as malformed (the token-budget cutoff case)', () => {
    const r = parseToolArguments('{"data":"a,b,c\n1,2');
    expect(r.malformed).toBe(true);
    expect(r.args).toEqual({});
    expect(r.recovered).toBe(false);
  });

  it('treats a valid JSON array or scalar as empty args, not malformed', () => {
    // Valid JSON, just not usable as named args — never feed an array/scalar as args.
    expect(parseToolArguments('[1,2,3]')).toEqual({ args: {}, recovered: false, malformed: false });
    expect(parseToolArguments('"hi"')).toEqual({ args: {}, recovered: false, malformed: false });
    expect(parseToolArguments('42')).toEqual({ args: {}, recovered: false, malformed: false });
  });

  it('flags total garbage as malformed', () => {
    const r = parseToolArguments('not json at all <<<');
    expect(r.malformed).toBe(true);
    expect(r.args).toEqual({});
  });
});
