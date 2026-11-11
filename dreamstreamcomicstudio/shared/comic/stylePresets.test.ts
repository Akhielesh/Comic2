// Style presets (contract §11.6; styles.md §5, Program 3 ST-4): the 24-style catalogue and its tag
// taxonomy, deterministic rankPresets (Ink + one colour for a b/w + accent brief), the spot-colour
// palette helpers, and softened, brand-free copy.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type ComicDoc } from './doc';
import { LIBRARY_IP_BLOCKLIST } from './library';
import {
  DEFAULT_SPOT_ACCENT,
  INK_ONE_COLOUR_PRESET_ID,
  SPOT_INK,
  SPOT_PAPER,
  STYLE_COLOUR_LABELS,
  STYLE_MEDIUM_LABELS,
  STYLE_PRESETS,
  briefWantsSpotColour,
  getStylePreset,
  isNeutralHex,
  presetFitScore,
  rankPresets,
  spotAccentOf,
  spotColourPalette,
  styleChips
} from './stylePresets';

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

describe('the 24-style catalogue (ST-4)', () => {
  const V5_LOOKS = ['modern-heroic', 'noir-ink', 'ligne-claire', 'manga-screentone', 'webtoon-cel', 'watercolor-storybook', 'graphic-novel-painterly', 'retro-pop', 'cozy-anime', 'indie-risograph', 'cartoon-strip', 'dark-fantasy'];
  // The ten classic-wizard looks v5 dropped (components/steps/StyleSelection.tsx), under their classic ids.
  const RESTORED = ['ink-wash', 'indian-miniature', 'woodcut', 'dieselpunk', 'brutalist', 'surreal-dream', 'chalk-pastel', 'retrofuturism', 'mythic-icon', 'cyberpunk'];
  const SPOT = ['ink-one-colour', 'mono-wash'];

  it('keeps the 12 v5 looks first and in order, then the 2 spot-colour looks and the 10 restored ones', () => {
    expect(STYLE_PRESETS.map((p) => p.id)).toEqual([...V5_LOOKS, ...SPOT, ...RESTORED]);
    expect(STYLE_PRESETS.find((p) => p.id === 'cyberpunk')!.name).toBe('Neon cyber');
    expect(getStylePreset(INK_ONE_COLOUR_PRESET_ID)!.name).toBe('Ink + one colour');
    expect(getStylePreset('mono-wash')!.name).toBe('Modern mono wash');
  });

  it('every style is executable art direction with a full card (spec, palette, swatch, tags)', () => {
    for (const p of STYLE_PRESETS) {
      expect(p.spec.split(/\s+/).length, p.id).toBeGreaterThanOrEqual(25);
      expect(p.tagline.length, p.id).toBeLessThanOrEqual(72);
      expect(p.palette.length, p.id).toBeGreaterThanOrEqual(3);
      for (const c of p.palette) expect(c, p.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p.swatch, p.id).toMatch(/^linear-gradient\(/);
      expect(p.avoid.length, p.id).toBeGreaterThan(0);
      expect(p.bestFor.length, p.id).toBeGreaterThan(0);
      expect(Object.keys(STYLE_COLOUR_LABELS), p.id).toContain(p.tags.colour);
      expect(Object.keys(STYLE_MEDIUM_LABELS), p.id).toContain(p.tags.medium);
    }
  });

  it('the colour chip agrees with the colour mode the page prompt will use', () => {
    for (const p of STYLE_PRESETS) {
      if (p.tags.colour === 'bw') expect(p.colorMode, p.id).toBe('bw');
      else if (p.tags.colour === 'spot' || p.tags.colour === 'limited') expect(p.colorMode, p.id).toBe('limited');
      else expect(p.colorMode ?? 'color', p.id).toBe('color');
    }
    // Spot colour = neutrals plus exactly ONE hue; Ink + one colour is exactly [ink, paper, accent].
    for (const p of STYLE_PRESETS.filter((x) => x.tags.colour === 'spot')) {
      expect(p.palette.filter((c) => !isNeutralHex(c)), p.id).toHaveLength(1);
    }
    expect(getStylePreset(INK_ONE_COLOUR_PRESET_ID)!.palette).toEqual([SPOT_INK, SPOT_PAPER, DEFAULT_SPOT_ACCENT]);
  });

  it('card chips: colour, medium and the top best-for, at most 3', () => {
    expect(styleChips(getStylePreset(INK_ONE_COLOUR_PRESET_ID)!)).toEqual(['Spot colour', 'Ink', 'Drama']);
    expect(styleChips(getStylePreset('woodcut')!)).toEqual(['B&W', 'Print', 'Dystopia']);
    expect(styleChips(getStylePreset('indian-miniature')!)).toEqual(['Full colour', 'Watercolour', 'Mythology']);
    for (const p of STYLE_PRESETS) expect(styleChips(p).length, p.id).toBe(3);
  });
});

describe('Ink + one colour', () => {
  it('spotColourPalette keeps ink and paper and takes the user accent (bad or grey input → the default)', () => {
    expect(spotColourPalette()).toEqual([SPOT_INK, SPOT_PAPER, DEFAULT_SPOT_ACCENT]);
    expect(spotColourPalette(' #3D44E8 ')).toEqual([SPOT_INK, SPOT_PAPER, '#3d44e8']);
    for (const bad of ['red', '#fff', '#12345g', '', '#808080', '#fafafa', 'url(x)']) expect(spotColourPalette(bad)[2], bad).toBe(DEFAULT_SPOT_ACCENT);
  });

  it('spotAccentOf finds the one hue among neutrals', () => {
    expect(spotAccentOf(getStylePreset('mono-wash')!.palette)).toBe('#2b59c3');
    expect(spotAccentOf(spotColourPalette('#1e8449'))).toBe('#1e8449');
    expect(spotAccentOf(['#111111', '#fafafa'])).toBeUndefined();
    expect(spotAccentOf(undefined)).toBeUndefined();
    expect(isNeutralHex('#1a1a1a')).toBe(true);
    expect(isNeutralHex('#d62839')).toBe(false);
    expect(isNeutralHex('nope')).toBe(false);
  });

  it('briefWantsSpotColour: b/w words or mode, plus one accent', () => {
    const yes: Array<[Partial<ComicDoc['brief']>, Partial<ComicDoc['format']>?]> = [
      [{ notes: ['Black and white, but use colour where needed'] }],
      [{ tone: 'black-and-white with a single splash of red' }],
      [{ genre: 'B&W thriller', notes: ['red accents on the knife only'] }],
      [{ premise: 'A monochrome city where only the lanterns glow in one colour' }],
      [{ notes: ['spot colour for the key object'] }, { colorMode: 'bw' }],
      [{ notes: ['b/w'] }, { colorMode: 'limited' }]
    ];
    for (const [b, f] of yes) expect(briefWantsSpotColour(docWith(b, f)), JSON.stringify(b)).toBe(true);
    const no: Array<[Partial<ComicDoc['brief']>, Partial<ComicDoc['format']>?]> = [
      [{ genre: 'drama' }, { colorMode: 'bw' }],
      [{ genre: 'black and white noir' }],
      [{ genre: 'romance', notes: ['full colour with a splash of red'] }],
      [{ genre: 'crime noir', tone: 'hard-boiled' }],
      [{ genre: 'bowling comedy', notes: ['one colourful cast'] }],
      // A digit before a hue is a story noun, not an accent request.
      [{ genre: 'drama', notes: ['chapter 1 red herring'] }, { colorMode: 'bw' }],
      [{}]
    ];
    for (const [b, f] of no) expect(briefWantsSpotColour(docWith(b, f)), JSON.stringify(b)).toBe(false);
  });
});

describe('rankPresets: the restored looks and the spot-colour brief', () => {
  it('a b/w + accent brief ranks Ink + one colour first, whatever the genre, audience or colour mode', () => {
    const briefs: Array<[Partial<ComicDoc['brief']>, Partial<ComicDoc['format']>?]> = [
      [{ genre: 'drama', notes: ['Black and white, but use colour where needed'] }],
      [{ genre: 'crime noir', tone: 'black and white with a single splash of red' }],
      [{ genre: 'thriller', notes: ['one accent colour for the key object'] }, { colorMode: 'bw' }],
      [{ genre: 'literary memoir', notes: ['b&w'] }, { colorMode: 'limited' }],
      [{ genre: 'manga action', notes: ['black and white with red accents'] }, { kind: 'manga' }],
      [{ genre: 'bedtime story', audience: 'kids 4-8', notes: ['black-and-white with a pop of yellow'] }]
    ];
    for (const [b, f] of briefs) {
      const ids = rankPresets(docWith(b, f));
      expect(ids[0], JSON.stringify(b)).toBe(INK_ONE_COLOUR_PRESET_ID);
    }
    // The other spot-colour look follows close behind for the owner's own words.
    expect(rankPresets(docWith({ genre: 'drama', notes: ['Black and white, but use colour where needed'] })).slice(0, 2)).toEqual(['ink-one-colour', 'mono-wash']);
  });

  it('without an accent request, b/w stays with the b/w looks and colour briefs never get Ink + one colour first', () => {
    expect(['noir-ink', 'manga-screentone']).toContain(rankPresets(docWith({ genre: 'drama' }, { colorMode: 'bw' }))[0]);
    expect(rankPresets(docWith({ genre: 'romance', notes: ['full colour with a splash of red'] }))[0]).not.toBe(INK_ONE_COLOUR_PRESET_ID);
    expect(rankPresets(docWith({ genre: 'crime noir', tone: 'hard-boiled' }))[0]).toBe('noir-ink');
    // A story noun with a digit is no accent request: a plain b/w brief keeps the b/w looks.
    expect(rankPresets(docWith({ genre: 'drama', notes: ['chapter 1 red herring'] }, { colorMode: 'bw' }))[0]).toBe('manga-screentone');
  });

  it('on a full-colour comic the spot-colour looks sit below the colour looks of the same fit', () => {
    // Half of the free 4-tile card was black and white for a colour drama. The nudge is the b/w
    // looks' own −1 (the colour mode is often just the default), so a two-tag fit still shows.
    const spot = [INK_ONE_COLOUR_PRESET_ID, 'mono-wash'];
    const drama = rankPresets(docWith({ genre: 'drama' }));
    for (const id of spot) expect(drama.slice(0, 3), id).not.toContain(id);
    const literary = rankPresets(docWith({ genre: 'literary drama' }));
    expect(literary.slice(0, 2)).toEqual(['graphic-novel-painterly', 'chalk-pastel']);
    expect(presetFitScore(getStylePreset(INK_ONE_COLOUR_PRESET_ID)!, docWith({ genre: 'drama' }))).toBe(
      presetFitScore(getStylePreset('graphic-novel-painterly')!, docWith({ genre: 'drama' })) - 1
    );
    // A limited-palette comic is where the spot looks belong: no nudge down there.
    expect(rankPresets(docWith({ genre: 'drama' }, { colorMode: 'limited' })).slice(0, 2)).toEqual([INK_ONE_COLOUR_PRESET_ID, 'mono-wash']);
  });

  it('the restored looks do not take over common genres they were not named for', () => {
    // Plain crime and heist thrillers stay with Noir ink, not Neon cyber.
    expect(rankPresets(docWith({ genre: 'crime thriller' }))[0]).toBe('noir-ink');
    expect(rankPresets(docWith({ genre: 'heist thriller' }))[0]).toBe('noir-ink');
    expect(rankPresets(docWith({ genre: 'heist thriller' }))[0]).not.toBe('cyberpunk');
    // …and so do plain, spy and revenge thrillers, not the cold Brutalist graphic.
    for (const genre of ['thriller', 'spy thriller', 'revenge thriller']) expect(rankPresets(docWith({ genre }))[0], genre).toBe('noir-ink');
    // "future" is a story word, not the name of the sunny Retro-future poster look.
    const futures: Array<Partial<ComicDoc['brief']>> = [
      { genre: 'dystopian future' },
      { genre: 'grim future thriller' },
      { genre: 'post-apocalyptic future' },
      { genre: 'sci-fi', tone: 'bleak, oppressive future' }
    ];
    for (const b of futures) expect(rankPresets(docWith(b))[0], JSON.stringify(b)).not.toBe('retrofuturism');
  });

  it('"mythology / Indian epic" → Indian miniature first', () => {
    expect(rankPresets(docWith({ genre: 'mythology', premise: 'An Indian epic retold in the far future' }))[0]).toBe('indian-miniature');
    expect(rankPresets(docWith({ genre: 'mythology, Indian epic' }))[0]).toBe('indian-miniature');
    // The epics name the look without the word "Indian" (the synonyms of the `indian` tag).
    expect(rankPresets(docWith({ genre: 'a Mahabharata retelling' }))[0]).toBe('indian-miniature');
    expect(rankPresets(docWith({ genre: 'Ramayana in space' }))[0]).toBe('indian-miniature');
  });

  it('each restored look leads for the brief that names it', () => {
    const cases: Array<[Partial<ComicDoc['brief']>, string]> = [
      [{ genre: 'cyberpunk thriller' }, 'cyberpunk'],
      [{ genre: 'surreal dream story' }, 'surreal-dream'],
      [{ genre: 'dieselpunk adventure', setting: 'an alternate 1930s of airships' }, 'dieselpunk'],
      [{ genre: 'woodcut dystopia' }, 'woodcut'],
      [{ genre: 'brutalist dystopian thriller' }, 'brutalist'],
      [{ genre: 'retro sci-fi', tone: 'space-age optimism' }, 'retrofuturism'],
      [{ genre: 'ink wash martial arts', setting: 'misty mountains' }, 'ink-wash'],
      [{ genre: 'chalk pastel mystery' }, 'chalk-pastel'],
      [{ genre: 'mythic sci-fi', tone: 'epic' }, 'mythic-icon']
    ];
    for (const [b, id] of cases) expect(rankPresets(docWith(b))[0], JSON.stringify(b)).toBe(id);
  });

  it('young readers never get the grim restored looks near the top', () => {
    const ids = rankPresets(docWith({ genre: 'bedtime adventure', audience: 'kids 3-7' }));
    for (const grim of ['woodcut', 'brutalist', 'dieselpunk', 'chalk-pastel', 'cyberpunk']) expect(ids.slice(0, 8), grim).not.toContain(grim);
  });
});

describe('preset copy', () => {
  it('names no artist, studio or brand (softened taglines)', () => {
    for (const p of STYLE_PRESETS) {
      for (const text of [p.name, p.tagline, p.spec, p.linework, ...p.avoid, ...p.bestFor]) expect(LIBRARY_IP_BLOCKLIST.test(text), `${p.id}: ${text}`).toBe(false);
    }
    // The classic wizard's franchise label is not carried over.
    for (const p of STYLE_PRESETS) expect(`${p.name} ${p.tagline} ${p.spec}`, p.id).not.toMatch(/sin city/i);
    expect(STYLE_PRESETS.find((p) => p.id === 'ligne-claire')!.tagline).not.toMatch(/tintin/i);
    expect(STYLE_PRESETS.find((p) => p.id === 'cozy-anime')!.tagline).not.toMatch(/ghibli/i);
  });
});
