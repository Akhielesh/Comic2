// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  createEmptyDoc,
  emptyRender,
  type Character,
  type ComicDoc,
  type Line,
  type Page,
  type Panel,
  type RenderState
} from '../../../shared/comic/doc.js';
import { getImageModel } from '../../../shared/comic/models.js';
import {
  DEFAULT_STYLE_SPEC,
  REGION_REFERENCE_PATH,
  compileCharacterSheet,
  compileCover,
  compileEdit,
  compilePage,
  compilePlaceSheet,
  compileStyleOption,
  effectiveLayout,
  harmonizePanelSizes,
  layoutConflicts,
  layoutPanelCount,
  paletteWords,
  parseLayout,
  planPageReferences,
  quoteForPrompt,
  rankPageCast,
  stagePanel,
  synthesizeLayout
} from './prompts.js';
import { StudioError } from './types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ready = (path: string, extra: Partial<RenderState> = {}): RenderState => ({
  ...emptyRender(),
  status: 'ready',
  asset: { path, source: 'generated', at: 1 },
  ...extra
});

const character = (id: string, name: string, tier: Character['tier'], opts: Partial<Character> = {}): Character => ({
  id,
  name,
  tier,
  look: { summary: `${name} summary look` },
  refs: [],
  sheet: ready(`sheets/${id}.png`),
  ...opts
});

let lineSeq = 0;
const line = (kind: Line['kind'], text: string, speakerId?: string): Line => ({
  id: `ln_${++lineSeq}`,
  kind,
  text,
  ...(speakerId ? { speakerId } : {})
});

const panel = (n: number, castIds: string[], opts: Partial<Panel> = {}): Panel => ({
  id: `pn_${n}`,
  n,
  size: 'medium',
  shot: 'medium',
  action: `Action of panel ${n}.`,
  castIds,
  lines: [],
  ...opts
});

const page = (n: number, panels: Panel[], opts: Partial<Page> = {}): Page => ({
  id: `pg_${n}`,
  n,
  summary: `Page ${n}`,
  layout: '',
  panels,
  render: emptyRender(),
  balloons: [],
  ...opts
});

const baseDoc = (patch: (doc: ComicDoc) => void = () => undefined): ComicDoc => {
  const doc = createEmptyDoc('doc_1', 'Saffron Run', 1);
  doc.brief = {
    title: 'Saffron Run',
    logline: 'A courier races a stolen ledger across Old Mumbai before the monsoon breaks.',
    genre: 'adventure',
    notes: []
  };
  doc.style = {
    status: 'locked',
    spec: 'Bold modern comic art with tapered brush inks and cel shading.',
    palette: ['#1d3557', '#e63946', '#f1faee'],
    linework: 'Tapered brush inks',
    avoid: ['photorealism'],
    refs: [],
    options: [],
    board: { path: 'style/board.png', source: 'generated', at: 1 }
  };
  doc.cast = [
    character('maya', 'Maya', 'lead', {
      look: {
        summary: 'Wiry courier with restless eyes',
        age: '19',
        gender: 'female',
        hair: 'black bun with a pencil through it',
        outfit: 'faded red kurta, cargo pants',
        marks: 'thin scar through left eyebrow'
      }
    }),
    character('arjun', 'Arjun', 'support', { look: { summary: 'Broad spice merchant in his fifties', gender: 'male', face: 'grey stubble beard' } }),
    character('vendor', 'Vendor', 'extra', { look: { summary: 'Toothless fruit seller in a green turban' } })
  ];
  doc.places = [
    { id: 'market', name: 'Spice market', look: 'Covered alley of turmeric sacks under patched tarps', refs: [], sheet: ready('places/market.png') },
    { id: 'roof', name: 'Rooftop', look: 'Corrugated tin roofs and water tanks', refs: [], sheet: ready('places/roof.png') }
  ];
  patch(doc);
  return doc;
};

/** "Image i — LABEL." lines of a prompt legend, in order. */
const legendLabels = (prompt: string): string[] =>
  [...prompt.matchAll(/^Image (\d+) — (.+?)\.(?: |$)/gm)].map((m) => {
    expect(Number(m[1])).toBeGreaterThan(0);
    return m[2];
  });

const legendIndexes = (prompt: string): number[] => [...prompt.matchAll(/^Image (\d+) — /gm)].map((m) => Number(m[1]));

/** Six-character page (each character in a different number of panels). */
const crowdedDoc = (quality: ComicDoc['settings']['quality']) =>
  baseDoc((doc) => {
    doc.settings.quality = quality;
    doc.cast = [
      character('a', 'Alpha', 'support'),
      character('b', 'Bravo', 'lead'),
      character('c', 'Charlie', 'support'),
      character('d', 'Delta', 'support'),
      character('e', 'Echo', 'support'),
      character('f', 'Foxtrot', 'support'),
      character('x', 'Extra Guy', 'extra')
    ];
    doc.style.refs = [
      { path: 'style/u1.png', source: 'upload', at: 1 },
      { path: 'style/u2.png', source: 'upload', at: 1 },
      { path: 'style/u3.png', source: 'upload', at: 1 }
    ];
  });

const crowdedPage = () =>
  page(1, [
    panel(1, ['a', 'b', 'c', 'x'], { placeId: 'market' }),
    panel(2, ['a', 'b', 'd'], { placeId: 'market' }),
    panel(3, ['a', 'e', 'b'], { placeId: 'roof' }),
    panel(4, ['a', 'f', 'c']),
    panel(5, ['d', 'x']),
    panel(6, ['a'])
  ]);

// ── References ───────────────────────────────────────────────────────────────

describe('planPageReferences', () => {
  it('caps characters at 4 on Nano Banana 2.1, ranked by panel appearances then tier, extras text-only', () => {
    const doc = crowdedDoc('standard');
    const pg = crowdedPage();
    const spec = getImageModel('nano-banana-2.1')!;
    const refs = planPageReferences(doc, pg, spec);
    const chars = refs.filter((r) => r.slot === 'character');
    // a: 5 panels, b: 3 (lead), c: 2, d: 2 (c first by cast order), e/f: 1 each.
    expect(chars.map((r) => r.characterId)).toEqual(['a', 'b', 'c', 'd']);
    expect(chars.every((r) => r.label.startsWith('CHARACTER SHEET: '))).toBe(true);
    expect(refs.some((r) => r.characterId === 'x')).toBe(false);
    // NB 2.1 has no style class: the board rides as an object ref (no user style refs).
    const style = refs.filter((r) => r.kind === 'style');
    expect(style).toHaveLength(1);
    expect(style[0]).toMatchObject({ label: 'STYLE BOARD', slot: 'object', path: 'style/board.png' });
  });

  it('takes 5 characters plus board + 2 user style refs as STYLE refs on Nano Banana Pro', () => {
    const doc = crowdedDoc('pro');
    const spec = getImageModel('nano-banana-pro')!;
    const refs = planPageReferences(doc, crowdedPage(), spec);
    expect(refs.filter((r) => r.slot === 'character').map((r) => r.characterId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const style = refs.filter((r) => r.slot === 'style');
    expect(style.map((r) => r.path)).toEqual(['style/board.png', 'style/u1.png', 'style/u2.png']);
    expect(style.map((r) => r.label)).toEqual(['STYLE BOARD', 'STYLE REFERENCE 1', 'STYLE REFERENCE 2']);
    expect(refs.length).toBeLessThanOrEqual(spec.refs.total);
  });

  it('orders characters → locations (by frequency) → style → previous page, and the previous page comes last', () => {
    const doc = baseDoc();
    const pg = page(2, [
      panel(1, ['maya'], { placeId: 'roof' }),
      panel(2, ['maya', 'arjun'], { placeId: 'market' }),
      panel(3, ['arjun'], { placeId: 'market' })
    ]);
    const prev = page(1, [panel(1, ['maya'])], { render: ready('pages/p1.png') });
    const refs = planPageReferences(doc, pg, getImageModel('nano-banana-2.1')!, prev);
    expect(refs.map((r) => r.label)).toEqual([
      'CHARACTER SHEET: MAYA',
      'CHARACTER SHEET: ARJUN',
      'LOCATION: SPICE MARKET',
      'LOCATION: ROOFTOP',
      'STYLE BOARD',
      'PREVIOUS PAGE'
    ]);
    expect(refs[refs.length - 1].path).toBe('pages/p1.png');
  });

  it('respects tight caps: legacy model (3 total, 2 characters, 1 object) keeps the style anchor over places and continuity', () => {
    const doc = baseDoc((d) => {
      d.settings.imageModelOverride = 'nano-banana-legacy';
    });
    const pg = page(2, [panel(1, ['maya', 'arjun'], { placeId: 'market' })]);
    const prev = page(1, [panel(1, ['maya'])], { render: ready('pages/p1.png') });
    const spec = getImageModel('nano-banana-legacy')!;
    const refs = planPageReferences(doc, pg, spec, prev);
    expect(refs.map((r) => r.label)).toEqual(['CHARACTER SHEET: MAYA', 'CHARACTER SHEET: ARJUN', 'STYLE BOARD']);
    expect(refs.length).toBeLessThanOrEqual(spec.refs.total);
  });

  it('uses no character references when the model has no character slots', () => {
    const doc = baseDoc();
    const refs = planPageReferences(doc, page(1, [panel(1, ['maya'])]), getImageModel('nano-banana-lite')!);
    expect(refs.some((r) => r.slot === 'character')).toBe(false);
  });

  it("falls back to the author's uploaded reference when a character has no ready sheet", () => {
    const doc = baseDoc((d) => {
      d.cast[0].sheet = emptyRender();
      d.cast[0].refs = [{ path: 'uploads/maya-photo.png', source: 'upload', at: 1 }];
      d.cast[1].sheet = { ...emptyRender(), status: 'failed' };
    });
    const refs = planPageReferences(doc, page(1, [panel(1, ['maya', 'arjun'])]), getImageModel('nano-banana-2.1')!);
    const chars = refs.filter((r) => r.slot === 'character');
    expect(chars).toHaveLength(1);
    expect(chars[0]).toMatchObject({ label: 'CHARACTER REFERENCE: MAYA', path: 'uploads/maya-photo.png', kind: 'author' });
  });

  it('skips a previous page that has no finished render', () => {
    const doc = baseDoc();
    const prev = page(1, [panel(1, ['maya'])], { render: { ...emptyRender(), status: 'rendering' } });
    const refs = planPageReferences(doc, page(2, [panel(1, ['maya'])]), getImageModel('nano-banana-2.1')!, prev);
    expect(refs.some((r) => r.kind === 'previous_page')).toBe(false);
  });
});

describe('rankPageCast', () => {
  it('ignores ids of characters that no longer exist', () => {
    const doc = baseDoc();
    const ranked = rankPageCast(doc, page(1, [panel(1, ['ghost', 'maya'])]));
    expect(ranked.map((c) => c.id)).toEqual(['maya']);
  });
});

// ── Page prompt ──────────────────────────────────────────────────────────────

describe('compilePage', () => {
  it('resolves model/resolution/aspect from the tier and format', () => {
    const doc = baseDoc();
    const job = compilePage(doc, page(1, [panel(1, ['maya'])]));
    expect(job.spec.id).toBe('nano-banana-2.1');
    expect(job.resolution).toBe('2K');
    expect(job.aspect).toBe('2:3');
    doc.settings.quality = 'draft';
    expect(compilePage(doc, page(1, [panel(1, ['maya'])])).resolution).toBe('1K');
    doc.settings.quality = 'pro';
    expect(compilePage(doc, page(1, [panel(1, ['maya'])])).spec.id).toBe('nano-banana-pro');
  });

  it('legend order matches the references array exactly', () => {
    for (const quality of ['standard', 'pro'] as const) {
      const doc = crowdedDoc(quality);
      const prev = page(0, [panel(1, ['a'])], { render: ready('pages/p0.png') });
      const job = compilePage(doc, crowdedPage(), { previousPage: prev });
      expect(legendLabels(job.prompt)).toEqual(job.references.map((r) => r.label));
      expect(legendIndexes(job.prompt)).toEqual(job.references.map((_, i) => i + 1));
    }
  });

  it('lists every character once with a full visual lock, Image index or a text lock', () => {
    const doc = baseDoc();
    const pg = page(1, [
      panel(1, ['maya', 'vendor'], { placeId: 'market' }),
      panel(2, ['maya', 'arjun']),
      panel(3, ['arjun'])
    ]);
    const job = compilePage(doc, pg);
    expect(job.prompt).toContain('- MAYA (Image 1): Wiry courier with restless eyes; 19-year-old female; hair: black bun with a pencil through it; outfit: faded red kurta, cargo pants; always visible: thin scar through left eyebrow.');
    expect(job.prompt).toMatch(/- ARJUN \(Image 2\): Broad spice merchant in his fifties; face: grey stubble beard\./);
    expect(job.prompt).toContain('- VENDOR (no reference — follow this description exactly): Toothless fruit seller in a green turban.');
    // Traits are stated once — never repeated in the panel lines.
    expect(job.prompt.split('thin scar through left eyebrow')).toHaveLength(2);
    expect(job.prompt.split('green turban')).toHaveLength(2);
    // Pronouns follow the look.
    expect(job.prompt).toContain('CHARACTER SHEET: MAYA. Match her face');
    expect(job.prompt).toContain('CHARACTER SHEET: ARJUN. Match his face, facial hair');
  });

  it('writes panel lines with size, shot, angle, place, staged characters and mood', () => {
    const doc = baseDoc();
    const pg = page(1, [
      panel(1, ['maya'], { size: 'wide', shot: 'establishing', placeId: 'market', mood: 'frantic dawn' }),
      panel(2, ['maya', 'arjun'], { shot: 'over_shoulder', angle: 'low angle', action: 'Maya slams the ledger down.' }),
      panel(3, [], { size: 'small', shot: 'insert', action: 'The brass lotus lock.' }),
      panel(4, ['arjun', 'maya'], { action: 'Arjun steps to the left of Maya.' })
    ]);
    const prompt = compilePage(doc, pg).prompt;
    expect(prompt).toContain('Panel 1 — wide, establishing shot (the whole location). SPICE MARKET: Action of panel 1. Characters: MAYA. Mood: frantic dawn.');
    expect(prompt).toContain('Panel 2 — medium, over-the-shoulder shot, low angle. Maya slams the ledger down. Characters: MAYA (left), ARJUN (right).');
    expect(prompt).toContain('Panel 3 — small, insert shot (close detail of an object). The brass lotus lock. No characters.');
    // The action already places people → no conflicting position hints.
    expect(prompt).toContain('Arjun steps to the left of Maya. Characters: MAYA, ARJUN.');
  });

  it('overlay lettering: text-free instruction with balloon space, and no dialogue in the prompt', () => {
    const doc = baseDoc();
    const pg = page(1, [
      panel(1, ['maya'], { lines: [line('speech', 'SECRET-DIALOGUE-ONE', 'maya')] }),
      panel(2, ['arjun']),
      panel(3, ['arjun'], { lines: [line('caption', 'SECRET-CAPTION')] })
    ]);
    const prompt = compilePage(doc, pg).prompt;
    expect(prompt).toContain('Do not draw any text, letters, speech balloons, captions or sound effects.');
    expect(prompt).toContain('Leave natural empty space near the top of panels 1 and 3 for balloons that will be added later; keep faces and key action out of that space.');
    expect(prompt).not.toContain('SECRET-DIALOGUE-ONE');
    expect(prompt).not.toContain('SECRET-CAPTION');
    expect(prompt).not.toContain('Spell every line');
  });

  it('in-art lettering: every line verbatim per panel with speaker and kind, quotes escaped', () => {
    const doc = baseDoc((d) => {
      d.format.lettering = 'in_art';
      d.settings.quality = 'pro';
    });
    const pg = page(1, [
      panel(1, ['maya'], {
        lines: [line('caption', 'Old Mumbai. 5:52 a.m.'), line('speech', 'He said "run" — so I ran.', 'maya')]
      }),
      panel(2, ['arjun'], { lines: [line('whisper', 'Not here.', 'arjun'), line('sfx', 'KRAK!'), line('speech', '   ', 'arjun')] }),
      panel(3, ['maya', 'arjun'], { lines: [line('shout', 'MOVE!', 'maya'), line('thought', 'Too slow…', 'arjun')] })
    ]);
    const prompt = compilePage(doc, pg).prompt;
    expect(prompt).toContain('Panel 1 — CAPTION: "Old Mumbai. 5:52 a.m."');
    expect(prompt).toContain('Panel 1 — MAYA (speech): "He said “run” — so I ran."');
    expect(prompt).toContain('Panel 2 — ARJUN (whisper): "Not here."');
    expect(prompt).toContain('Panel 2 — SFX: "KRAK!"');
    expect(prompt).toContain('Panel 3 — MAYA (shout): "MOVE!"');
    expect(prompt).toContain('Panel 3 — ARJUN (thought): "Too slow…"');
    expect(prompt).toContain('No other text anywhere on the page.');
    expect(prompt).toContain('UPPERCASE');
    expect(prompt).toContain('spiky burst balloons');
    expect(prompt).not.toContain('Do not draw any text');
    // The blank line is dropped, not lettered as an empty balloon.
    expect(prompt.match(/^Panel 2 — /gm)).toHaveLength(3); // panel line + 2 lettered lines
  });

  it('in-art lettering in a caseless language drops UPPERCASE and names the language', () => {
    const doc = baseDoc((d) => {
      d.format.lettering = 'in_art';
      d.format.language = 'ja';
    });
    const pg = page(1, [panel(1, ['maya'], { lines: [line('speech', 'いくぞ！', 'maya')] })]);
    const prompt = compilePage(doc, pg).prompt;
    expect(prompt).not.toContain('UPPERCASE');
    expect(prompt).toContain('Japanese');
    expect(prompt).toContain('Panel 1 — MAYA (speech): "いくぞ！"');
  });

  it('states right-to-left manga reading order', () => {
    const doc = baseDoc((d) => {
      d.format.kind = 'manga';
      d.format.readingDirection = 'rtl';
    });
    const prompt = compilePage(doc, page(1, [panel(1, ['maya']), panel(2, ['arjun'])])).prompt;
    expect(prompt).toContain('read right-to-left, top-to-bottom (manga order: panel 1 is at the top right)');
    expect(prompt).not.toContain('read left-to-right');
    expect(compilePage(baseDoc(), page(1, [panel(1, ['maya']), panel(2, ['arjun'])])).prompt).toContain(
      'read left-to-right, top-to-bottom'
    );
  });

  it('color modes: b/w sentence without palette, limited palette names, full color', () => {
    const bw = compilePage(baseDoc((d) => (d.format.colorMode = 'bw')), page(1, [panel(1, ['maya'])])).prompt;
    expect(bw).toContain('black and white with grey tones only');
    expect(bw).not.toContain('Palette:');
    expect(bw).toContain('professionally drawn and inked published page');
    const limited = compilePage(baseDoc((d) => (d.format.colorMode = 'limited')), page(1, [panel(1, ['maya'])])).prompt;
    expect(limited).toContain('limited palette: navy, red and off-white');
    expect(limited).not.toContain('Palette:');
    const color = compilePage(baseDoc(), page(1, [panel(1, ['maya'])])).prompt;
    expect(color).toContain(', full color.');
    expect(color).toContain('Palette: navy, red and off-white.');
  });

  it('webtoon: tall aspect (1:4 when supported) and a vertical stack without a grid', () => {
    const doc = baseDoc((d) => (d.format.kind = 'webtoon'));
    const pg = page(1, [1, 2, 3, 4, 5].map((n) => panel(n, ['maya'], { size: n === 3 ? 'tall' : 'medium' })), {
      layout: 'Row 1: two equal panels. Row 2: three small panels.'
    });
    const job = compilePage(doc, pg);
    expect(job.aspect).toBe('1:4');
    expect(job.prompt).toContain('Stacked vertically: 5 full-width panels');
    expect(job.prompt).toContain('generous vertical white space');
    expect(job.prompt).toContain('No page border grid');
    expect(job.prompt).not.toContain('Row 1');
    expect(job.prompt).not.toContain('Clean white gutters');
    doc.settings.quality = 'pro';
    expect(compilePage(doc, pg).aspect).toBe('9:16');
    doc.settings.quality = 'standard';
    expect(compilePage(doc, page(1, [panel(1, ['maya']), panel(2, ['maya'])])).aspect).toBe('9:16');
  });

  it('strip: one wide row (16:9, 21:9 for 4+ panels)', () => {
    const doc = baseDoc((d) => (d.format.kind = 'strip'));
    const three = compilePage(doc, page(1, [1, 2, 3].map((n) => panel(n, ['maya']))));
    expect(three.aspect).toBe('16:9');
    expect(three.prompt).toContain('Row 1: 3 equal panels side by side (panels 1–3)');
    expect(compilePage(doc, page(1, [1, 2, 3, 4].map((n) => panel(n, ['maya'])))).aspect).toBe('21:9');
  });

  it('uses the planned layout when it matches the panels, and a synthesized blueprint when it does not', () => {
    const doc = baseDoc();
    const good = page(1, [panel(1, ['maya'], { size: 'wide' }), panel(2, ['maya']), panel(3, ['arjun'])], {
      layout: 'Row 1: one wide panel. Row 2: two equal panels.'
    });
    expect(compilePage(doc, good).prompt).toContain('Row 1: one wide panel. Row 2: two equal panels.');
    const stale = { ...good, layout: 'Row 1: one wide panel. Row 2: three small panels.' };
    const prompt = compilePage(doc, stale).prompt;
    expect(prompt).not.toContain('three small panels');
    expect(prompt).toContain('Row 1: one wide panel across the full width (panel 1). Row 2: two equal panels side by side (panels 2–3).');
  });

  it('falls back to DEFAULT_STYLE_SPEC (or a format-matching preset) when the style has no spec', () => {
    const doc = baseDoc((d) => {
      d.style = { status: 'empty', refs: [], options: [] };
    });
    const prompt = compilePage(doc, page(1, [panel(1, ['maya'])])).prompt;
    expect(prompt).toContain(DEFAULT_STYLE_SPEC);
    const storybook = baseDoc((d) => {
      d.style = { status: 'empty', refs: [], options: [] };
      d.format.kind = 'storybook';
    });
    expect(compilePage(storybook, page(1, [panel(1, ['maya'])])).prompt).toContain("Children's picture-book illustration");
  });

  it('keeps a typical 6-panel page under 3,500 characters excluding dialogue', () => {
    const doc = baseDoc((d) => {
      d.cast[0].look = {
        summary: 'Wiry 19-year-old courier with a sharp jaw and restless eyes',
        gender: 'female',
        hair: 'black hair in a high bun with a pencil through it',
        outfit: 'faded red kurta over cargo pants, cracked leather satchel',
        marks: 'thin scar through left eyebrow'
      };
      d.style.spec =
        'Modern American comic book art: confident inked contour lines with tapered brush weight, dynamic foreshortened poses, dramatic rim lighting, cel-shaded digital coloring with soft gradients on skin and metal.';
    });
    const actions = [
      'Maya sprints into the crowded spice market at dawn, satchel clutched to her chest, shoppers scattering.',
      'Arjun looks up from weighing saffron, eyes narrowing at the satchel.',
      'Maya, breathless, slams the ledger onto the brass scale between them.',
      'Close on the ledger cover: a brass lock shaped like a lotus.',
      'The vendor points a shaking finger toward the market entrance.',
      'Silhouettes of three officers block the alley mouth against the light.'
    ];
    const cast = [['maya'], ['arjun'], ['maya', 'arjun'], [], ['vendor'], []];
    const pg = page(
      2,
      actions.map((action, i) =>
        panel(i + 1, cast[i], {
          action,
          size: i === 0 ? 'wide' : i < 3 ? 'medium' : 'small',
          shot: (['establishing', 'medium', 'close_up', 'insert', 'over_shoulder', 'wide'] as const)[i],
          placeId: i === 3 ? undefined : 'market',
          mood: i % 2 ? 'tense' : undefined,
          lines: i === 1 ? [line('speech', 'You are late, courier. The buyers left an hour ago.', 'arjun')] : []
        })
      ),
      { layout: 'Row 1: one wide panel. Row 2: two equal panels. Row 3: three small panels.' }
    );
    const prev = page(1, [panel(1, ['maya'])], { render: ready('pages/p1.png') });
    const job = compilePage(doc, pg, { previousPage: prev });
    expect(job.references).toHaveLength(5);
    expect(job.prompt.length).toBeLessThan(3500);
    // No duplicated sentences.
    const sentences = job.prompt.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 25);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('is deterministic', () => {
    const doc = crowdedDoc('pro');
    expect(compilePage(doc, crowdedPage())).toEqual(compilePage(doc, crowdedPage()));
  });

  it('refuses a page without panels', () => {
    expect(() => compilePage(baseDoc(), page(1, []))).toThrow(StudioError);
  });
});

// ── Layout blueprint ─────────────────────────────────────────────────────────

describe('layout blueprint', () => {
  const ltr = { kind: 'comic' as const, readingDirection: 'ltr' as const };

  it('synthesizes rows from panel sizes (splash, wide, tall spans, pairs)', () => {
    expect(synthesizeLayout([{ size: 'splash' }], ltr)).toBe('One full-page splash panel (panel 1).');
    const text = synthesizeLayout(
      [{ size: 'wide' }, { size: 'medium' }, { size: 'small' }, { size: 'tall' }, { size: 'small' }, { size: 'small' }],
      ltr
    );
    expect(text).toBe(
      'Row 1: one wide panel across the full width (panel 1). Row 2: two equal panels side by side (panels 2–3). ' +
        'Rows 3–4: one tall panel on the left (panel 4) beside two stacked panels on the right (panels 5–6).'
    );
    const rtl = synthesizeLayout([{ size: 'tall' }, { size: 'small' }, { size: 'small' }], { kind: 'manga', readingDirection: 'rtl' });
    expect(rtl).toContain('one tall panel on the right (panel 1) beside two stacked panels on the left');
    expect(synthesizeLayout([{ size: 'small' }, { size: 'small' }, { size: 'small' }], ltr)).toBe(
      'Row 1: three small panels side by side (panels 1–3).'
    );
  });

  it('round-trips synthesized layouts through the parser for every panel count', () => {
    const sizes = ['small', 'medium', 'large', 'wide', 'tall', 'splash'] as const;
    for (let n = 1; n <= 9; n += 1) {
      for (let seed = 0; seed < 12; seed += 1) {
        const panels = Array.from({ length: n }, (_, i) => ({ size: sizes[(i * 7 + seed * 3 + n) % sizes.length] }));
        for (const format of [ltr, { kind: 'manga' as const, readingDirection: 'rtl' as const }, { kind: 'webtoon' as const, readingDirection: 'ltr' as const }]) {
          const text = synthesizeLayout(panels, format);
          expect(layoutPanelCount(parseLayout(text))).toBe(n);
        }
      }
    }
  });

  it('parses writer-style blueprints including numerals and descriptive rows', () => {
    expect(layoutPanelCount(parseLayout('Row 1: one wide panel. Row 2: two equal panels. Row 3: three small panels.'))).toBe(6);
    expect(layoutPanelCount(parseLayout('Row 1: 2 panels. Row 2: 1 large panel.'))).toBe(3);
    expect(layoutPanelCount(parseLayout('Row 1: two panels: one small panel and one large panel.'))).toBe(2);
    expect(layoutPanelCount(parseLayout('Row 1: one small panel and one large panel.'))).toBe(2);
    const span = parseLayout('Row 1: one wide panel. Rows 2–3: a tall panel on the right beside two stacked panels on the left.');
    expect(layoutPanelCount(span)).toBe(4);
    expect(span!.rows[1].span).toEqual({ tallSide: 'right', stacked: 2 });
    expect(parseLayout('A dramatic page')).toBeNull();
  });

  it('harmonizes panel sizes to the blueprint and detects contradictions', () => {
    const parsed = parseLayout(
      'Row 1: one panel. Row 2: two equal panels. Rows 3–4: one tall panel on the left beside two stacked panels on the right.'
    )!;
    const sizes = (['medium', 'wide', 'small', 'small', 'large', 'medium'] as const).map((size) => ({ size }));
    expect(layoutConflicts(parsed, sizes)).toBe(true);
    const fixed = harmonizePanelSizes(sizes, parsed);
    expect(fixed.map((p) => p.size)).toEqual(['wide', 'medium', 'small', 'tall', 'medium', 'medium']);
    expect(layoutConflicts(parsed, fixed)).toBe(false);
    // rtl: the tall panel sits on the right and is still read first.
    const rtl = parseLayout('Rows 1–2: one tall panel on the right beside two stacked panels on the left.')!;
    expect(harmonizePanelSizes([{ size: 'small' }, { size: 'small' }, { size: 'small' }], rtl, true).map((p) => p.size)).toEqual(['tall', 'small', 'small']);
    expect(harmonizePanelSizes([{ size: 'medium' }], parseLayout('One full-page splash panel.')!)[0].size).toBe('splash');
  });

  it('effectiveLayout replaces a blueprint that contradicts the panel sizes', () => {
    const pg = page(1, [panel(1, [], { size: 'wide' }), panel(2, [], { size: 'medium' })], { layout: 'Row 1: two equal panels.' });
    expect(effectiveLayout(pg, ltr)).toBe('Row 1: one wide panel across the full width (panel 1). Row 2: one panel across the full width (panel 2).');
  });

  it('effectiveLayout rejects a grid layout for webtoon', () => {
    const pg = page(1, [panel(1, []), panel(2, [])], { layout: 'Row 1: two equal panels.' });
    expect(effectiveLayout(pg, { kind: 'webtoon', readingDirection: 'ltr' })).toContain('Stacked vertically');
    expect(effectiveLayout(pg, ltr)).toBe('Row 1: two equal panels.');
  });
});

describe('stagePanel', () => {
  it('keeps the page-level left→right order (180° rule) and gives position words for 2–4 characters', () => {
    const pg = page(1, [panel(1, ['maya']), panel(2, ['arjun', 'maya']), panel(3, ['vendor', 'arjun', 'maya'])]);
    expect(stagePanel(pg, pg.panels[1]).map((s) => [s.id, s.word])).toEqual([
      ['maya', 'left'],
      ['arjun', 'right']
    ]);
    expect(stagePanel(pg, pg.panels[2]).map((s) => s.word)).toEqual(['left', 'center', 'right']);
    expect(stagePanel(pg, pg.panels[0])).toEqual([{ id: 'maya', x: 0.5 }]);
  });
});

// ── Sheets, style options, edits, cover ──────────────────────────────────────

describe('compileCharacterSheet', () => {
  it('3:2 model sheet with identity fields, author references first, then the style board', () => {
    const doc = baseDoc((d) => {
      d.cast[0].refs = [
        { path: 'uploads/maya1.png', source: 'upload', at: 1 },
        { path: 'uploads/maya2.png', source: 'upload', at: 1 }
      ];
    });
    const job = compileCharacterSheet(doc, doc.cast[0]);
    expect(job.aspect).toBe('3:2');
    expect(job.resolution).toBe('2K');
    expect(job.references.map((r) => r.label)).toEqual(['AUTHOR REFERENCE 1 FOR MAYA', 'AUTHOR REFERENCE 2 FOR MAYA', 'STYLE BOARD']);
    expect(job.references.map((r) => r.path)).toEqual(['uploads/maya1.png', 'uploads/maya2.png', 'style/board.png']);
    expect(legendLabels(job.prompt)).toEqual(job.references.map((r) => r.label));
    expect(job.prompt).toContain('Character model sheet for a comic, one image on a plain light-grey background, no text, no labels: MAYA.');
    expect(job.prompt).toContain('full-body front view, full-body three-quarter view, full-body side profile');
    expect(job.prompt).toContain('three head close-ups (neutral, smiling, angry)');
    expect(job.prompt).toContain('Identity: 19-year-old female.');
    expect(job.prompt).toContain('Hair: black bun with a pencil through it.');
    expect(job.prompt).toContain('Distinguishing marks (must always show): thin scar through left eyebrow.');
    expect(job.prompt).toContain('Art style: Bold modern comic art');
    expect(job.prompt).toContain('Match face, hair and features');
  });

  it('uses gentle expressions for storybooks and black-and-white sheets for b/w comics', () => {
    const doc = baseDoc((d) => {
      d.format.kind = 'storybook';
      d.format.colorMode = 'bw';
    });
    const prompt = compileCharacterSheet(doc, doc.cast[0]).prompt;
    expect(prompt).toContain('(neutral, smiling, surprised)');
    expect(prompt).toContain('black and white with grey tones only');
  });
});

describe('compilePlaceSheet', () => {
  it('environment sheet: establishing view + two vignettes, no people, style board ref', () => {
    const doc = baseDoc();
    const job = compilePlaceSheet(doc, doc.places[0]);
    expect(job.aspect).toBe('3:2');
    expect(job.prompt).toContain('no people, no text, no labels: SPICE MARKET');
    expect(job.prompt).toContain('wide establishing view');
    expect(job.prompt).toContain('two detail vignettes');
    expect(job.prompt).toContain('Covered alley of turmeric sacks under patched tarps.');
    expect(job.references.map((r) => r.label)).toEqual(['STYLE BOARD']);
  });
});

describe('compileStyleOption', () => {
  it('always NB 2.1 @1K at 4:5, key moment from the logline, no references by default', () => {
    const doc = baseDoc((d) => (d.settings.quality = 'pro'));
    const job = compileStyleOption(doc, { id: 'o1', name: 'Noir', spec: 'High-contrast noir ink with rain-slick shadows', render: emptyRender() });
    expect(job.spec.id).toBe('nano-banana-2.1');
    expect(job.resolution).toBe('1K');
    expect(job.aspect).toBe('4:5');
    expect(job.references).toEqual([]);
    expect(job.prompt).toContain('one striking, cover-quality illustration of this moment: A courier races a stolen ledger across Old Mumbai');
    expect(job.prompt).toContain('Feature MAYA, Wiry courier with restless eyes (no specific likeness required).');
    expect(job.prompt).toContain('Rendered in this exact style: High-contrast noir ink with rain-slick shadows.');
    expect(job.prompt).toContain('No text, no letters, no logos.');
    expect(job.prompt).not.toContain('REFERENCE IMAGES');
  });

  it('attaches user style refs when present and derives the moment from the script without a logline', () => {
    const doc = baseDoc((d) => {
      d.brief.logline = undefined;
      d.source.script = 'PAGE 1\nPANEL 1\nRain hammers the tin roofs of Dharavi. A girl runs with a ledger.\nMAYA: Faster!';
      d.style.refs = [{ path: 'style/u1.png', source: 'upload', at: 1 }];
    });
    const job = compileStyleOption(doc, { id: 'o1', name: 'x', spec: 'Painterly', render: emptyRender() });
    expect(job.prompt).toContain('this moment: Rain hammers the tin roofs of Dharavi.');
    expect(job.references).toEqual([{ label: 'STYLE REFERENCE 1', path: 'style/u1.png' }]);
    expect(legendLabels(job.prompt)).toEqual(['STYLE REFERENCE 1']);
  });
});

describe('compileEdit', () => {
  const rendered = (doc: ComicDoc) =>
    page(3, [panel(1, ['maya']), panel(2, ['maya', 'arjun']), panel(3, ['vendor'])], {
      render: ready('pages/p3.png', { asset: { path: 'pages/p3.png', source: 'generated', at: 1, w: 1024, h: 1536 } })
    });

  it('current page first, red-outlined region second, then the targeted panel cast sheets', () => {
    const doc = baseDoc();
    const job = compileEdit(doc, rendered(doc), { instruction: 'make it night', panelN: 2, hasRegion: true });
    expect(job.references).toEqual([
      { label: 'CURRENT PAGE', path: 'pages/p3.png' },
      { label: 'SAME PAGE — AREA TO CHANGE OUTLINED IN RED', path: REGION_REFERENCE_PATH },
      { label: 'CHARACTER SHEET: MAYA', path: 'sheets/maya.png' },
      { label: 'CHARACTER SHEET: ARJUN', path: 'sheets/arjun.png' }
    ]);
    expect(legendLabels(job.prompt)).toEqual(job.references.map((r) => r.label));
    expect(job.prompt).toContain('Edit Image 1, a finished comic page. Change only this: make it night.');
    expect(job.prompt).toContain('The area to change is outlined in red in Image 2 (in panel 2).');
    expect(job.prompt).toContain('Do not add a red outline to the result.');
    expect(job.prompt).toContain('Output the full page at the same framing.');
    expect(job.aspect).toBe('2:3');
  });

  it('without a region: names the panel, scopes sheets to its cast plus characters the instruction names', () => {
    const doc = baseDoc();
    const job = compileEdit(doc, rendered(doc), { instruction: 'Put Arjun behind the vendor', panelN: 3, hasRegion: false });
    expect(job.references.map((r) => r.label)).toEqual(['CURRENT PAGE', 'CHARACTER SHEET: ARJUN']);
    expect(job.prompt).toContain('The change is in panel 3, which shows: Action of panel 3.');
    expect(job.prompt).not.toContain('red outline');
  });

  it('refuses to edit a page that has no render', () => {
    const doc = baseDoc();
    expect(() => compileEdit(doc, page(1, [panel(1, ['maya'])]), { instruction: 'x', hasRegion: false })).toThrow(/render it first/);
  });
});

describe('compileCover', () => {
  it('title, tagline, lead sheets and style board at the page aspect', () => {
    const doc = baseDoc((d) => {
      d.cover = { title: 'SAFFRON RUN', tagline: 'Deliver it — or "drown" with it.', render: emptyRender() };
      d.pages = [page(1, [panel(1, ['maya', 'arjun'])])];
    });
    const job = compileCover(doc);
    expect(job.aspect).toBe('2:3');
    expect(job.references.map((r) => r.label)).toEqual(['CHARACTER SHEET: MAYA', 'STYLE BOARD']);
    expect(legendLabels(job.prompt)).toEqual(job.references.map((r) => r.label));
    expect(job.prompt).toContain('Title lettering at the top: "SAFFRON RUN" in bold display lettering that fits the genre (adventure)');
    expect(job.prompt).toContain('a small tagline: "Deliver it — or “drown” with it."');
    expect(job.prompt).toContain('featuring MAYA (Image 1)');
    expect(job.prompt).toContain('Spell the title exactly; no other text except the tagline and an optional small issue number.');
  });

  it('uses brief.title and the cover direction when set', () => {
    const doc = baseDoc((d) => {
      d.cover = { direction: 'Maya leaping between rooftops in the rain', render: emptyRender() };
    });
    const prompt = compileCover(doc).prompt;
    expect(prompt).toContain('"Saffron Run"');
    expect(prompt).toContain('Hero image: Maya leaping between rooftops in the rain, featuring MAYA (Image 1).');
  });
});

describe('text helpers', () => {
  it('quoteForPrompt converts inner double quotes to typographic pairs', () => {
    expect(quoteForPrompt('say "hi" now')).toBe('"say “hi” now"');
    expect(quoteForPrompt('  spaced   out ')).toBe('"spaced out"');
  });

  it('paletteWords names hex colors and dedupes', () => {
    expect(paletteWords(['#000000', '#0b0b0b', '#ffffff', 'teal'])).toBe('black, white and teal');
  });
});
