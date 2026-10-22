// Style presets (contract §11.6): deterministic rankPresets and softened, brand-free copy.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type ComicDoc } from './doc';
import { LIBRARY_IP_BLOCKLIST } from './library';
import { STYLE_PRESETS, presetFitScore, rankPresets } from './stylePresets';

const docWith = (brief: Partial<ComicDoc['brief']>, format: Partial<ComicDoc['format']> = {}): Pick<ComicDoc, 'brief' | 'format'> => {
  const doc = createEmptyDoc('rank-test');
  return { brief: { ...doc.brief, ...brief }, format: { ...doc.format, ...format } };
};

describe('rankPresets', () => {
  it('returns every preset id exactly once', () => {
    const ids = rankPresets(docWith({}));
    expect([...ids].sort()).toEqual(STYLE_PRESETS.map((p) => p.id).sort());
  });

  it('kids picture books → storybook watercolor first, no grim looks near the top', () => {
    const ids = rankPresets(docWith({ genre: 'bedtime story', audience: 'kids 2–6' }));
    expect(ids[0]).toBe('watercolor-storybook');
    expect(ids.slice(0, 4)).toEqual(expect.arrayContaining(['cartoon-strip', 'ligne-claire', 'cozy-anime']));
    expect(ids.slice(0, 6)).not.toContain('noir-ink');
    expect(ids.slice(0, 6)).not.toContain('dark-fantasy');
  });

  it('noir / crime → noir ink first', () => {
    expect(rankPresets(docWith({ genre: 'crime noir', tone: 'hard-boiled' }))[0]).toBe('noir-ink');
    expect(rankPresets(docWith({ genre: 'detective mystery' }))[0]).toBe('noir-ink');
  });

  it('format kind leads: manga → manga, webtoon → webtoon, strip → cartoon strip', () => {
    expect(rankPresets(docWith({}, { kind: 'manga' }))[0]).toBe('manga-screentone');
    expect(rankPresets(docWith({ genre: 'romance' }, { kind: 'webtoon' }))[0]).toBe('webtoon-cel');
    expect(rankPresets(docWith({ genre: 'office humor' }, { kind: 'strip' }))[0]).toBe('cartoon-strip');
  });

  it('black-and-white comics prefer b/w presets; horror goes dark', () => {
    const bw = rankPresets(docWith({ genre: 'drama' }, { colorMode: 'bw' }));
    expect(['noir-ink', 'manga-screentone']).toContain(bw[0]);
    expect(rankPresets(docWith({ genre: 'gothic horror' }))[0]).toBe('dark-fantasy');
  });

  it('is deterministic and never throws on an empty or odd brief', () => {
    const odd = docWith({ genre: '(((', audience: '???' });
    expect(rankPresets(odd)).toEqual(rankPresets(odd));
    expect(() => presetFitScore(STYLE_PRESETS[0], { brief: {} as ComicDoc['brief'], format: {} as ComicDoc['format'] })).not.toThrow();
  });
});

describe('preset copy', () => {
  it('names no artist, studio or brand (softened taglines)', () => {
    for (const p of STYLE_PRESETS) {
      for (const text of [p.name, p.tagline, p.spec, p.linework]) expect(LIBRARY_IP_BLOCKLIST.test(text), `${p.id}: ${text}`).toBe(false);
    }
    expect(STYLE_PRESETS.find((p) => p.id === 'ligne-claire')!.tagline).not.toMatch(/tintin/i);
    expect(STYLE_PRESETS.find((p) => p.id === 'cozy-anime')!.tagline).not.toMatch(/ghibli/i);
  });
});
