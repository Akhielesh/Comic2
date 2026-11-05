// @vitest-environment node
// The DECIDED line (agent-editor plan §3 A3.2): what the creator settled, so the director asks before overriding it.

import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type AssetRef, type ComicDoc } from '../../../shared/comic/doc.js';
import { IMAGE_MODELS } from '../../../shared/comic/models.js';
import { DECIDED_MAX_CHARS, decidedLine, ownLooks, pinnedBalloons, pinnedLabel } from './decided.js';
import { plannedDoc } from './orchestrator.fakes.js';

const drawnAsset = (path: string): AssetRef => ({ path, source: 'generated', at: 5 });

/** Everything settled: an approved plan with page 1 drawn, a locked style, a picked lettering preset with own looks,
 *  a model lock and two pinned balloons (one locked) on page 2. */
const settledDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.planStatus = 'approved';
  doc.pages[0].render = { ...doc.pages[0].render, status: 'ready', asset: drawnAsset('u/p/pages/1.webp') };
  doc.style = { ...doc.style, status: 'locked', name: 'Ligne claire' };
  doc.letterStyle = { presetId: 'manga', auto: false, kinds: { shout: { textColor: '#cc0000' } }, speakers: { c_maya: { italic: true } } };
  doc.pages[1].panels[1].lines = [
    { id: 'ln_x', kind: 'speech', speakerId: 'c_maya', text: 'We have to go', style: { weight: 900 } },
    { id: 'ln_y', kind: 'shout', speakerId: 'c_arjun', text: 'Stop!' }
  ];
  doc.pages[1].balloons = [
    { lineId: 'ln_x', x: 0.1, y: 0.1, w: 0.2, pinned: true },
    { lineId: 'ln_y', x: 0.6, y: 0.6, w: 0.2, pinned: true, locked: true }
  ];
  doc.imageModel = { modelId: IMAGE_MODELS[0].id, lockedAt: 5, origin: 'first_render' };
  return doc;
};

describe('decidedLine', () => {
  it('is empty while nothing is settled (a fresh comic, a draft plan)', () => {
    expect(decidedLine(createEmptyDoc('d', 'Untitled comic', 1))).toBe('');
    expect(decidedLine(plannedDoc())).toBe('');
  });

  it('lists the approved plan, drawn pages, the locked style, the picked lettering with its own looks, the model lock and pinned balloons', () => {
    expect(decidedLine(settledDoc())).toBe(
      "DECIDED (the creator's; ask once before changing any): plan approved (3 pages, 9 panels); 1 of 3 pages drawn; " +
        'style “Ligne claire” locked; lettering Manga, picked, with its own looks for shouts, Maya and 1 line; ' +
        `drawing model ${IMAGE_MODELS[0].nickname} locked; pinned balloons: p2 ×2 (1 locked)`
    );
  });

  it('a lettering preset the director chose itself (auto) is not settled; its own looks still are', () => {
    const doc = plannedDoc();
    doc.letterStyle = { presetId: 'storybook', auto: true };
    expect(decidedLine(doc)).toBe('');
    doc.letterStyle = { presetId: 'storybook', auto: true, kinds: { whisper: { italic: true } } };
    expect(decidedLine(doc)).toBe("DECIDED (the creator's; ask once before changing any): lettering Kids storybook, with its own looks for whispers");
  });

  it('stays short on a big book', () => {
    const doc = settledDoc();
    for (let i = 0; i < 30; i += 1) doc.pages.push({ ...doc.pages[1], id: `pg_x${i}`, n: 4 + i });
    expect(decidedLine(doc).length).toBeLessThanOrEqual(DECIDED_MAX_CHARS);
    expect(decidedLine(doc)).toContain(', …');
  });
});

describe('helpers', () => {
  it('pinnedBalloons in page and reading order, with a label that quotes the line', () => {
    const pinned = pinnedBalloons(settledDoc());
    expect(pinned.map((p) => [p.line.id, p.locked])).toEqual([
      ['ln_x', false],
      ['ln_y', true]
    ]);
    expect(pinnedLabel(pinned[0])).toBe('page 2 · panel 2 · line 1 “We have to go”');
    expect(pinnedBalloons(settledDoc(), new Set(['pg_1']))).toEqual([]);
  });

  it('ownLooks names the base, kind, speaker, line and saved-style looks', () => {
    expect(ownLooks(plannedDoc()).words).toEqual([]);
    expect(ownLooks(settledDoc()).words).toEqual(['shouts', 'Maya', '1 line']);
  });
});
