// Screen-reader transcript (reader.md §8): speaker names, captions and sound effects; panels in visual
// reading order (RTL too); a localized doc passes straight through; in-art pages are included.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type ComicDoc, type Page } from '../../../shared/comic/doc';
import { localizeDoc } from '../../../shared/comic/i18n';
import type { ReaderItem } from '../reader/readerModel';
import { lineTranscript, pageTranscript, panelOrder, panelTranscript } from './pageTranscript';

const page = (): Page => ({
  id: 'pg_1',
  n: 4,
  summary: 'Maya reaches the lake',
  layout: 'Row 1: two equal panels.',
  chapterTitle: 'The Lake',
  panels: [
    { id: 'pn_1', n: 1, size: 'medium', shot: 'wide', action: 'Maya runs to the shore', castIds: ['c_maya'], lines: [{ id: 'l1', kind: 'speech', speakerId: 'c_maya', text: 'Wait for me!' }] },
    {
      id: 'pn_2',
      n: 2,
      size: 'medium',
      shot: 'close_up',
      action: 'A frog leaps',
      castIds: [],
      lines: [
        { id: 'l2', kind: 'caption', text: 'Meanwhile' },
        { id: 'l3', kind: 'sfx', text: 'SPLASH' },
        { id: 'l4', kind: 'thought', speakerId: 'c_frog', text: 'Too slow' },
        { id: 'l5', kind: 'whisper', speakerId: 'c_none', text: 'psst' },
        { id: 'l6', kind: 'shout', speakerId: 'c_maya', text: 'HEY' }
      ]
    }
  ],
  render: { status: 'ready', history: [], asset: { path: 'u/p.webp', source: 'generated', at: 0 } },
  balloons: []
});

const docOf = (rtl = false): ComicDoc => {
  const d = createEmptyDoc('d1', 'Pond Days', 0);
  d.cast = [
    { id: 'c_maya', name: 'Maya', tier: 'lead', look: { summary: '' }, refs: [], sheet: { status: 'none', history: [] } },
    { id: 'c_frog', name: 'Fred', tier: 'support', look: { summary: '' }, refs: [], sheet: { status: 'none', history: [] } }
  ];
  d.format = { ...d.format, readingDirection: rtl ? 'rtl' : 'ltr', lettering: 'in_art' };
  d.pages = [page()];
  d.cover = { ...d.cover, title: 'Pond Days', tagline: 'A splashy summer' };
  return d;
};
const itemOf = (d: ComicDoc): ReaderItem => ({ key: 'pg_1', kind: 'page', label: 'Page 4', asset: d.pages[0].render.asset!, page: d.pages[0] });

describe('pageTranscript', () => {
  it('reads the page heading, then each panel with who says what', () => {
    const d = docOf();
    const t = pageTranscript(d, itemOf(d));
    expect(t[0]).toBe('Page 4. The Lake. Maya reaches the lake.');
    expect(t[1]).toBe('Panel 1. Maya runs to the shore. Maya says: “Wait for me!”');
    expect(t[2]).toBe('Panel 2. A frog leaps. Caption: Meanwhile. Sound effect: SPLASH. Fred thinks: “Too slow” Someone whispers: “psst” Maya shouts: “HEY”');
  });

  it('follows the visual order for right-to-left books', () => {
    const d = docOf(true);
    // The blueprint estimate already puts panel 1 on the right in a manga.
    expect(panelOrder(d, d.pages[0])).toEqual([0, 1]);
    // Measured boxes drawn left-to-right are read right-to-left.
    d.pages[0].render = { ...d.pages[0].render, qc: { score: 1, issues: [], checkedAt: 1, panelBoxes: [{ x: 0.02, y: 0.02, w: 0.46, h: 0.96 }, { x: 0.52, y: 0.02, w: 0.46, h: 0.96 }] } };
    expect(panelOrder(d, d.pages[0])).toEqual([1, 0]);
    expect(pageTranscript(d, itemOf(d))[1]).toMatch(/^Panel 1\. A frog leaps/);
  });

  it('a localized doc passes straight through (the transcript is in the reading language)', () => {
    const d = docOf();
    d.i18n = {
      editions: { hi: { lang: 'hi', lines: { l1: { text: 'मेरा इंतज़ार करो!', status: 'reviewed', sourceHash: 'x', at: 1 } }, balloons: {} } },
      glossary: []
    } as unknown as ComicDoc['i18n'];
    const hi = localizeDoc(d, 'hi');
    expect(pageTranscript(hi, itemOf(hi))[1]).toContain('Maya says: “मेरा इंतज़ार करो!”');
  });

  it('the cover reads its title and tagline; empty lines are skipped', () => {
    const d = docOf();
    const cover: ReaderItem = { key: 'cover', kind: 'cover', label: 'Cover', asset: { path: 'u/c.webp', source: 'generated', at: 0 } };
    expect(pageTranscript(d, cover)).toEqual(['Cover. Pond Days. A splashy summer.']);
    expect(lineTranscript(d, { id: 'x', kind: 'speech', text: '   ' })).toBeNull();
    expect(panelTranscript(d, d.pages[0], 9)).toBe('');
    expect(pageTranscript(d, undefined)).toEqual([]);
  });
});
