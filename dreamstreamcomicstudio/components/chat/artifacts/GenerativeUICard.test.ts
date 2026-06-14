import { describe, it, expect } from 'vitest';
import { normalizeGenerativeUI } from './GenerativeUICard';

// The normalizer is the safety boundary between untrusted model output and the DOM.
// These tests pin its guarantees: never throw, coerce/bound props, drop unknown blocks,
// allowlist image sources, and cap depth + total node count.

describe('normalizeGenerativeUI', () => {
  it('returns null for non-objects, missing root, or an unknown root kind', () => {
    expect(normalizeGenerativeUI(null)).toBeNull();
    expect(normalizeGenerativeUI('nope')).toBeNull();
    expect(normalizeGenerativeUI({})).toBeNull();
    expect(normalizeGenerativeUI({ root: 42 })).toBeNull();
    expect(normalizeGenerativeUI({ root: { kind: 'definitely-not-a-block' } })).toBeNull();
  });

  it('normalizes a valid tree and coerces/bounds props', () => {
    const ui = normalizeGenerativeUI({
      title: 'X',
      palette: 'brand',
      root: {
        kind: 'stack',
        gap: 99, // out of range -> clamped to 4
        children: [
          { kind: 'heading', text: 'Hi', level: 9 }, // level clamped to 1..3
          { kind: 'metric', label: 'Rev', value: 1000, deltaPercent: 5 },
          { kind: 'badge', text: 'ok', tone: 'bogus' } // bad tone -> neutral
        ]
      }
    });
    expect(ui).not.toBeNull();
    const root = ui!.root as { kind: string; gap: number; children: { kind: string; level?: number; tone?: string }[] };
    expect(root.kind).toBe('stack');
    expect(root.gap).toBe(4);
    expect(root.children).toHaveLength(3);
    expect(root.children[0]).toMatchObject({ kind: 'heading', level: 3 });
    expect(root.children[2]).toMatchObject({ kind: 'badge', tone: 'neutral' });
  });

  it('marks malformed leaf blocks as _invalid instead of throwing or dropping silently', () => {
    const ui = normalizeGenerativeUI({
      root: { kind: 'stack', children: [{ kind: 'metric' /* no label/value */ }, { kind: 'heading', text: 'ok' }] }
    });
    const kids = (ui!.root as { children: { kind: string }[] }).children;
    expect(kids[0].kind).toBe('_invalid');
    expect(kids[1].kind).toBe('heading');
  });

  it('allowlists image src to https / data:image only', () => {
    expect(normalizeGenerativeUI({ root: { kind: 'image', src: 'javascript:alert(1)' } })).toBeNull();
    expect(normalizeGenerativeUI({ root: { kind: 'image', src: 'data:text/html,<script>' } })).toBeNull();
    const ok = normalizeGenerativeUI({ root: { kind: 'image', src: 'https://example.com/a.png' } });
    expect(ok!.root.kind).toBe('image');
  });

  it('caps total node count', () => {
    const children = Array.from({ length: 500 }, () => ({ kind: 'divider' }));
    const ui = normalizeGenerativeUI({ root: { kind: 'stack', children } });
    const kids = (ui!.root as { children: unknown[] }).children;
    expect(kids.length).toBeLessThanOrEqual(200);
  });

  it('caps nesting depth', () => {
    let node: unknown = { kind: 'heading', text: 'deep' };
    for (let i = 0; i < 20; i++) node = { kind: 'stack', children: [node] };
    const ui = normalizeGenerativeUI({ root: node });
    let cur = ui!.root as { kind: string; children?: { kind: string; children?: unknown[] }[] };
    let depth = 0;
    while (cur && cur.kind === 'stack' && cur.children && cur.children.length) {
      cur = cur.children[0] as typeof cur;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(6);
  });

  // --- The block kinds added this session: timeline, rating, tags, gauge, bars, steps,
  //     quote, map. The normalizer is the untrusted-input boundary, so each must coerce
  //     valid input and reject malformed input (→ _invalid / dropped) without throwing.
  const kid = (root: unknown) => (normalizeGenerativeUI({ root: { kind: 'stack', children: [root] } })!.root as { children: { kind: string }[] }).children[0];

  it('normalizes the new content blocks and bounds their items', () => {
    expect(kid({ kind: 'timeline', items: [{ title: 'Launch', time: 'Jul 2', text: 'live' }, { junk: true }] })).toMatchObject({
      kind: 'timeline',
      items: [{ title: 'Launch', time: 'Jul 2', text: 'live' }]
    });
    expect(kid({ kind: 'timeline', items: [] }).kind).toBe('_invalid');

    expect(kid({ kind: 'rating', value: 4.6, max: 99, count: 12 })).toMatchObject({ kind: 'rating', value: 4.6, max: 10 });
    expect(kid({ kind: 'rating' }).kind).toBe('_invalid'); // no value

    expect(kid({ kind: 'tags', items: ['a', 2, '', 'b'] })).toMatchObject({ kind: 'tags', items: ['a', 'b'] });
    expect(kid({ kind: 'tags', items: [] }).kind).toBe('_invalid');

    expect(kid({ kind: 'steps', items: [{ title: 'One', text: 'do it' }] })).toMatchObject({ kind: 'steps' });
    expect(kid({ kind: 'quote', text: 'hi', author: 'me' })).toMatchObject({ kind: 'quote', text: 'hi', author: 'me' });
    expect(kid({ kind: 'quote' }).kind).toBe('_invalid'); // no text
  });

  it('normalizes the new data-viz blocks (gauge, bars) with sane defaults', () => {
    expect(kid({ kind: 'gauge', value: 78 })).toMatchObject({ kind: 'gauge', value: 78, max: 100 });
    expect(kid({ kind: 'gauge' }).kind).toBe('_invalid');
    expect(kid({ kind: 'bars', items: [{ label: 'EU', value: 540 }, { value: 1 }] })).toMatchObject({
      kind: 'bars',
      items: [{ label: 'EU', value: 540 }]
    });
    expect(kid({ kind: 'bars', items: [] }).kind).toBe('_invalid');
  });

  it('map block: coerces finite coords, keeps label, drops markers without lat/lng', () => {
    const m = kid({
      kind: 'map',
      connect: true,
      markers: [
        { lat: 40.7, lng: -74, label: 'NYC' },
        { lat: 'nope', lng: 2 }, // dropped (non-finite lat)
        { label: 'no coords' } // dropped
      ]
    }) as { kind: string; connect: boolean; markers: { lat: number; lng: number; label: string }[] };
    expect(m.kind).toBe('map');
    expect(m.connect).toBe(true);
    expect(m.markers).toEqual([{ lat: 40.7, lng: -74, label: 'NYC', category: undefined, color: undefined }]);
    expect(kid({ kind: 'map', markers: [] }).kind).toBe('_invalid');
  });
});
