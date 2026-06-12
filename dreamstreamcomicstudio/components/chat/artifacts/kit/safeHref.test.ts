import { describe, it, expect } from 'vitest';
import { safeHref } from './format';

describe('safeHref', () => {
  it('allows http(s), mailto, relative and anchor URLs', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeHref('/local/path')).toBe('/local/path');
    expect(safeHref('#anchor')).toBe('#anchor');
  });

  it('rejects script-bearing and unknown schemes from LLM/tool output', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('JavaScript:alert(1)')).toBeUndefined();
    expect(safeHref(' javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,<script>1</script>')).toBeUndefined();
    expect(safeHref('vbscript:msgbox')).toBeUndefined();
    expect(safeHref('')).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });
});
