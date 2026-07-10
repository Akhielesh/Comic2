import { describe, it, expect } from 'vitest';
import { sanitizeIconBody, groupByPrefix, iconSearchTool } from './icons.js';

describe('icon_search sanitizer (trust boundary for inlined SVG)', () => {
  it('keeps clean path/shape bodies unchanged', () => {
    const body = '<path d="M12 2 2 22h20z" fill="currentColor"/>';
    expect(sanitizeIconBody(body)).toBe(body);
  });

  it('drops bodies with executable or unsafe content', () => {
    expect(sanitizeIconBody('<script>alert(1)</script>')).toBeNull();
    expect(sanitizeIconBody('<path onload="x()" d="M0 0h1v1"/>')).toBeNull();
    expect(sanitizeIconBody('<foreignObject><body/></foreignObject>')).toBeNull();
    expect(sanitizeIconBody('<image href="javascript:alert(1)"/>')).toBeNull();
    expect(sanitizeIconBody('<iframe src="x"></iframe>')).toBeNull();
    expect(sanitizeIconBody('')).toBeNull();
    expect(sanitizeIconBody(undefined)).toBeNull();
    expect(sanitizeIconBody(123 as unknown)).toBeNull();
  });
});

describe('icon_search prefix grouping', () => {
  it('groups set:name ids by set, preserving order, ignoring malformed ids', () => {
    const m = groupByPrefix(['lucide:home', 'lucide:rocket', 'mdi:cart', 'broken', ':x', 'y:']);
    expect([...m.keys()]).toEqual(['lucide', 'mdi']);
    expect(m.get('lucide')).toEqual(['home', 'rocket']);
    expect(m.get('mdi')).toEqual(['cart']);
  });

  it('handles names containing additional colons', () => {
    const m = groupByPrefix(['fa:brands:github']);
    expect(m.get('fa')).toEqual(['brands:github']);
  });
});

describe('icon_search tool contract', () => {
  it('is named icon_search, needs no auth, and requires a query', async () => {
    expect(iconSearchTool.name).toBe('icon_search');
    const res = await iconSearchTool.execute({});
    expect(res.content).toMatch(/provide something to search/i);
    expect(res.artifacts).toBeUndefined();
  });
});
