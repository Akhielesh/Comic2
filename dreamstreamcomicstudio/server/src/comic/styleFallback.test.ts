import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type ComicDoc } from '../../../shared/comic/doc.js';
import { STYLE_PRESETS } from '../../../shared/comic/stylePresets.js';
import { pickDefaultPreset } from './jobs.js';
import { rankStylePresets } from './writer.js';

/**
 * The no-style fallback (ensureStyle → pickDefaultPreset, before PAID page renders) and the
 * writer's style fill-ins: the spot looks (Ink + one colour, Mono wash) are b/w art, so they lead
 * only a b/w-plus-accent brief and never a full-colour comic; bestFor tags match whole words.
 */
const docWith = (brief: Partial<ComicDoc['brief']>, colorMode: ComicDoc['format']['colorMode'] = 'color'): ComicDoc => {
  const doc = createEmptyDoc('style-fallback');
  doc.brief = { ...doc.brief, ...brief };
  doc.format = { ...doc.format, colorMode };
  return doc;
};

const SPOT_IDS = STYLE_PRESETS.filter((p) => p.tags.colour === 'spot').map((p) => p.id);

describe('pickDefaultPreset (the no-style render fallback)', () => {
  it('never picks a spot look for a colour comic', () => {
    expect(SPOT_IDS).toEqual(expect.arrayContaining(['ink-one-colour', 'mono-wash']));
    for (const genre of ['thriller', 'spy thriller', 'heist thriller', 'crime thriller', 'mystery', 'detective mystery', 'drama', 'literary drama']) {
      expect(SPOT_IDS, genre).not.toContain(pickDefaultPreset(docWith({ genre })).id);
    }
  });

  it('colour detective mystery is not Ink + one colour', () => {
    expect(pickDefaultPreset(docWith({ genre: 'detective mystery' })).id).not.toBe('ink-one-colour');
  });

  it('colour crime thriller → Noir ink', () => {
    expect(pickDefaultPreset(docWith({ genre: 'crime thriller' })).id).toBe('noir-ink');
  });

  it('colour thriller → Modern heroic', () => {
    expect(pickDefaultPreset(docWith({ genre: 'thriller' })).id).toBe('modern-heroic');
  });

  it('b/w crime noir with a splash of red → Ink + one colour', () => {
    expect(pickDefaultPreset(docWith({ genre: 'crime noir', notes: ['a splash of red'] }, 'bw')).id).toBe('ink-one-colour');
  });

  it("an 'Indiana …' premise never scores the 'indian' tag", () => {
    const indiana = docWith({ genre: 'drama', premise: 'An Indiana farm girl finds a door in the barn.' });
    const ohio = docWith({ genre: 'drama', premise: 'An Ohio farm girl finds a door in the barn.' });
    expect(pickDefaultPreset(indiana).id).toBe(pickDefaultPreset(ohio).id);
    expect(rankStylePresets(indiana).map((p) => p.id)).toEqual(rankStylePresets(ohio).map((p) => p.id));
  });

  // On these genres a substring match ('indiana' contains 'indian') lifts Indian miniature to the
  // top pick, so the paid page renders would be drawn in the wrong look (ST-4 #7(b)).
  it("an 'Indiana …' premise on a myth / sci-fi / fable brief picks what an 'Ohio …' one does", () => {
    for (const genre of ['mythology', 'sci-fi', 'fable']) {
      const a = pickDefaultPreset(docWith({ genre, premise: 'Indiana, 1931: a river town remembers its old gods.' })).id;
      const b = pickDefaultPreset(docWith({ genre, premise: 'Ohio, 1931: a river town remembers its old gods.' })).id;
      expect(a, genre).toBe(b);
      expect(a, genre).not.toBe('indian-miniature');
    }
  });
});

describe('rankStylePresets (the writer fill-ins)', () => {
  it('colour drama: no spot look in the top 3', () => {
    const top3 = rankStylePresets(docWith({ genre: 'drama' })).slice(0, 3).map((p) => p.id);
    for (const id of SPOT_IDS) expect(top3).not.toContain(id);
    expect(top3).toEqual([
      'graphic-novel-painterly',
      'chalk-pastel',
      'modern-heroic'
    ]);
  });

  it('b/w crime noir with a splash of red leads with Ink + one colour', () => {
    expect(rankStylePresets(docWith({ genre: 'crime noir', notes: ['a splash of red'] }, 'bw'))[0].id).toBe('ink-one-colour');
  });

  it("an 'Indiana …' brief never scores Indian miniature's 'indian' tag", () => {
    const rank = (premise: string) => rankStylePresets(docWith({ genre: 'mythology', premise })).map((p) => p.id).indexOf('indian-miniature');
    expect(rank('Indiana, 1931: a river town remembers its old gods.')).toBe(rank('Ohio, 1931: a river town remembers its old gods.'));
  });
});
