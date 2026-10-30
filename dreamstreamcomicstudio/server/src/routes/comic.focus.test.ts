// @vitest-environment node
// K2b (wave note 9): the stream's focus hint carries the editor's selection — panel ids (≤ 9, SAFE_ID) and overlay ids
// (≤ 24, 'ly_…') on focus.pageId. A hint never fails a message: malformed ids are dropped, and without a page they mean
// nothing.
import { describe, expect, it } from 'vitest';
import { parseFocus } from './comic.js';

describe('parseFocus: the editor selection (Ship 2)', () => {
  it('keeps panel and overlay ids on the focused page, deduped and capped', () => {
    const panels = Array.from({ length: 12 }, (_, i) => `pn_${i}`);
    const layers = Array.from({ length: 30 }, (_, i) => `ly_${i}`);
    const focus = parseFocus({ pageId: 'pg_2', panelIds: [...panels, 'pn_0'], layerIds: [...layers, 'ly_0'] });
    expect(focus?.panelIds).toEqual(panels.slice(0, 9));
    expect(focus?.layerIds).toEqual(layers.slice(0, 24));
  });

  it('drops malformed ids (never fails the message) and ignores a selection without a page', () => {
    expect(parseFocus({ pageId: 'pg_2', panelIds: ['<script>', 7, 'pn ok', 'pn_1'], layerIds: ['star', 'ly_ok', 'ly_<x>'] })).toEqual({ pageId: 'pg_2', panelIds: ['pn_1'], layerIds: ['ly_ok'] });
    expect(parseFocus({ panelIds: ['pn_1'], layerIds: ['ly_1'] })).toBeUndefined();
    expect(parseFocus({ pageId: 'pg_2', panelIds: 'pn_1', layerIds: { a: 1 } })).toEqual({ pageId: 'pg_2' });
  });
});
