import { describe, it, expect } from 'vitest';
import { diffLines, diffStat } from './diff';

describe('diffLines', () => {
  it('classifies context / add / del lines', () => {
    const ops = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(ops.map((o) => `${o.type}:${o.text}`)).toEqual(['ctx:a', 'del:b', 'add:B', 'ctx:c', 'add:d']);
  });

  it('treats identical text as all context', () => {
    expect(diffLines('x\ny', 'x\ny').every((o) => o.type === 'ctx')).toBe(true);
  });

  it('diffStat counts adds and removes', () => {
    expect(diffStat(diffLines('a\nb\nc', 'a\nB\nc\nd'))).toEqual({ added: 2, removed: 1 });
  });
});
