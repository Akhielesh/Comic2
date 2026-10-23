// QA harness fixtures (P1-QA; mobile.md §10.2, visualqa.md §0/§7).
//
// Deterministic, synthetic comic docs for the layout/device harness (qa/comic-qa.html). Unlike
// conversation/testing/fixtures.ts this file never imports vitest, so the QA entry can ship it to a
// browser; vitest suites may import it too. Nothing here touches the network or real user data.
//
// Fixtures (the `fixture=` query parameter):
//   lake-1p      the owner's real session: a 1-page storybook whose page came back SQUARE under a 4:5
//                format, with edge-hugging stored balloons (x=0, right edge 1.0, y=0.92, an overlapping pair)
//   heist-12p    a 12-page comic with every render state, a long conversation with every card type,
//                next-step chips and an open spend gate — the default studio scene
//   deep-40p     40 drawn pages (perf: variants, image budget, long scroll)
//   webtoon-20p  a 20-panel-strip webtoon (vertical scroll reader)
//   stress       visualqa's stress doc: 160-char title, unbroken words, 12 long-named cast members,
//                54-char model id, $1234.56 spend, notices with long URLs, 20 pages
//   empty        a brand-new comic (nothing planned yet)
//
// Images are referenced by path `qa/<seed>-<w>x<h>.png`; the harness serves them (sharp-generated PNGs
// under Playwright, SVG data URLs when opened by hand). Each page/cover asset carries 480w and 1080w
// variants exactly like the server stores them, so the variant logic runs for real.

import {
  createEmptyDoc,
  normalizeDoc,
  pageSpecHash,
  type AspectRatio,
  type AssetRef,
  type Balloon,
  type Card,
  type Character,
  type ComicDoc,
  type ComicKind,
  type Line,
  type Msg,
  type Page,
  type Panel,
  type RenderState
} from '../../../shared/comic/doc';

export const QA_NOW = 1_760_000_000_000;
export const QA_PROJECT_ID = 'proj_qa';

export const QA_FIXTURES = ['lake-1p', 'heist-12p', 'deep-40p', 'webtoon-20p', 'stress', 'empty'] as const;
export type QaFixtureName = (typeof QA_FIXTURES)[number];
export const isQaFixture = (v: unknown): v is QaFixtureName => typeof v === 'string' && (QA_FIXTURES as readonly string[]).includes(v);

/** The server's variant widths (contract §13.4): only those narrower than the original, ascending. */
export const QA_VARIANT_WIDTHS = [480, 1080] as const;

/** `qa/<seed>-<w>x<h>.png` ⇄ its parts (the harness renders an image from the name alone). */
export const qaImagePath = (seed: string, w: number, h: number): string => `qa/${seed}-${Math.round(w)}x${Math.round(h)}.png`;
const IMAGE_NAME_RE = /^(?:qa\/|\/qa-assets\/)?([a-z0-9][a-z0-9_-]{0,60})-(\d{2,5})x(\d{2,5})\.png$/i;
export const parseQaImagePath = (path: string): { seed: string; w: number; h: number; file: string } | null => {
  const m = IMAGE_NAME_RE.exec(path);
  if (!m) return null;
  const w = Number(m[2]);
  const h = Number(m[3]);
  if (!(w >= 16 && w <= 8192 && h >= 16 && h <= 8192)) return null;
  return { seed: m[1], w, h, file: `${m[1]}-${w}x${h}.png` };
};

/** A generated asset with server-style variants (480w/1080w, only those narrower than the original). */
export const qaAsset = (seed: string, w: number, h: number, extra: Partial<AssetRef> = {}): AssetRef => {
  const variants = QA_VARIANT_WIDTHS.filter((vw) => vw < w).map((vw) => {
    const vh = Math.round((h * vw) / w);
    return { path: qaImagePath(seed, vw, vh), w: vw, h: vh };
  });
  return { path: qaImagePath(seed, w, h), w, h, source: 'generated', model: 'nano-banana-2.1', at: QA_NOW, ...(variants.length ? { variants } : {}), ...extra };
};

/** Pixel size of a page render for an aspect (the long side matches the 1856×2304 golden size). */
export const qaPageSize = (aspect: AspectRatio): { w: number; h: number } => {
  const [a, b] = aspect.split(':').map(Number);
  if (!(a > 0 && b > 0)) return { w: 1856, h: 2304 };
  if (a <= b) return { w: Math.round((2304 * a) / b), h: 2304 };
  return { w: 2304, h: Math.round((2304 * b) / a) };
};

// ── Text ─────────────────────────────────────────────────────────────────────

const LONG_LINE =
  'Mama said the ducklings would wait for us by the willow tree, but the frog keeps singing louder and louder and I think he wants us to follow him across the lily pads!';
const SHORT_LINES = ['Stop right there!', 'You’ll never catch me.', 'Over here!', 'The vault is open…', 'Run!', 'Ribbit! Ribbit!', 'Where did the bunny go?', 'Look at me!'];
const KINDS: Line['kind'][] = ['speech', 'thought', 'caption', 'sfx', 'whisper', 'shout'];
const SHOTS: Panel['shot'][] = ['establishing', 'medium', 'close_up', 'over_shoulder', 'extreme_close_up', 'pov'];

type Density = 'normal' | 'stress';

const STRESS_CAST = [
  'Princess Seraphina Evangeline Moonwhisper-Abernathy the Third',
  'Captain Bartholomew "Barnacle" Thistlewaite',
  'The Baby',
  'Mother Duck (the brown one from the cover)',
  'Frederick the Extraordinarily Talkative Frog',
  'Bunny',
  'Grandpa Augustus Featherstonehaugh-Cholmondeley',
  'Dragonfly Swarm #7',
  'Narrator',
  'Ms. Penelope Q. Wigglesworth, Lake Warden',
  'Duckling 1',
  'Supercalifragilisticexpialidocious Otter'
];

const sheetState = (i: number, stress: boolean, seed: string): RenderState => {
  switch (i % 4) {
    case 0:
      return { status: 'ready', history: [qaAsset(`${seed}-sheet${i}-old`, 1536, 1024)], asset: qaAsset(`${seed}-sheet${i}`, 1536, 1024), updatedAt: QA_NOW };
    case 1:
      return { status: 'rendering', history: [], updatedAt: QA_NOW };
    case 2:
      return {
        status: 'failed',
        history: [],
        error: stress ? 'The image model refused this one because the prompt mentioned a real person by name. Try describing them instead.' : 'The image model timed out. Nothing was charged.'
      };
    default:
      return { status: 'none', history: [] };
  }
};

const makeCast = (names: string[], density: Density, seed: string): Character[] =>
  names.map((name, i) => ({
    id: `ch_${i}`,
    name,
    role: density === 'stress' && i % 3 === 0 ? 'Retired lighthouse keeper who secretly runs the lakeside detective agency' : i === 0 ? 'Lead' : 'Support',
    tier: i < 2 ? 'lead' : i < 6 ? 'support' : 'extra',
    look: {
      summary:
        density === 'stress'
          ? 'A round-cheeked toddler in a yellow raincoat with tiny frog-shaped rain boots, a crooked sun hat, and an ever-present half-eaten biscuit clutched in one fist'
          : 'Lean figure in a dark coat with a red scarf',
      hair: 'black braid',
      ...(density === 'stress' ? { outfit: 'Patched dungarees over a striped long-sleeve shirt with an embroidered duck on the pocket' } : {})
    },
    ...(density === 'stress' ? { voice: 'Speaks in breathless run-on sentences, mixes up animal names, giggles mid-word' } : {}),
    refs: [],
    sheet: sheetState(i, density === 'stress', seed),
    ...(i === 3 ? { kind: 'animal' as const, count: 3 } : {})
  }));

const makePanels = (pageId: string, count: number, density: Density, castIds: string[], pageIndex: number): Panel[] =>
  Array.from({ length: count }, (_, j) => {
    const lines: Line[] = [];
    const nLines = density === 'stress' ? 1 + ((j + pageIndex) % 3) : 1 + ((j + pageIndex) % 2);
    for (let k = 0; k < nLines; k++) {
      const kind = KINDS[(j + k + pageIndex) % KINDS.length];
      const text = kind === 'sfx' ? (density === 'stress' ? 'SPLAAAAAAASH!!!' : 'KRAK!') : density === 'stress' ? LONG_LINE : SHORT_LINES[(j + k + pageIndex) % SHORT_LINES.length];
      lines.push({
        id: `${pageId}_p${j + 1}_l${k + 1}`,
        kind,
        text,
        ...(kind !== 'caption' && kind !== 'sfx' && castIds.length ? { speakerId: castIds[(j + k) % castIds.length] } : {})
      });
    }
    return {
      id: `${pageId}_p${j + 1}`,
      n: j + 1,
      size: j === 0 ? 'wide' : 'medium',
      shot: SHOTS[j % SHOTS.length],
      action:
        density === 'stress'
          ? 'The baby toddles to the water’s edge where three cartoon ducklings, a green frog on a lily pad and a white bunny with a floppy ear all turn to look at her, the willow branches swaying in a warm breeze while dragonflies hover over the reeds.'
          : 'Rain over the rooftops; the thief leaps the gap.',
      castIds: castIds.slice(0, 3),
      lines
    };
  });

/** The owner's session: stored balloons hugging the edges plus one overlapping pair (visualqa §0). */
export const edgeBalloons = (page: Page): Balloon[] => {
  const lines = page.panels.flatMap((p) => p.lines);
  const spots = [
    { x: 0, y: 0, w: 0.34 },
    { x: 0.66, y: 0.02, w: 0.34 },
    { x: 0.7, y: 0.92, w: 0.3 },
    { x: 0, y: 0.88, w: 0.45 },
    { x: 0.3, y: 0.45, w: 0.4 },
    { x: 0.32, y: 0.47, w: 0.4 }
  ];
  return lines.slice(0, spots.length).map((l, i) => ({
    lineId: l.id,
    ...spots[i],
    tailX: Math.min(1, spots[i].x + 0.1),
    tailY: Math.min(1, spots[i].y + 0.15),
    pinned: i % 2 === 0
  }));
};

/** Calm, well-spaced stored balloons (one per line, reading order). */
const tidyBalloons = (page: Page): Balloon[] =>
  page.panels
    .flatMap((p) => p.lines)
    .slice(0, 6)
    .map((l, i) => ({ lineId: l.id, x: i % 2 ? 0.55 : 0.08, y: 0.06 + Math.floor(i / 2) * 0.3, w: 0.36, tailX: i % 2 ? 0.6 : 0.2, tailY: 0.2 + Math.floor(i / 2) * 0.3 }));

interface PageOpts {
  count: number;
  density: Density;
  aspect: AspectRatio;
  seed: string;
  castIds: string[];
  /** Render status per index (cycled). */
  statuses: RenderState['status'][];
  panels: (i: number) => number;
  /** Page index whose render came back square (the 1:1-under-4:5 bug). */
  squareIndex?: number;
  balloons: 'edge' | 'tidy' | 'none';
}

const makePages = (o: PageOpts): Page[] =>
  Array.from({ length: o.count }, (_, i) => {
    const id = `pg_${i + 1}`;
    const status = o.statuses[i % o.statuses.length];
    const size = i === o.squareIndex ? { w: 1024, h: 1024 } : qaPageSize(o.aspect);
    const panels = makePanels(id, o.panels(i), o.density, o.castIds, i);
    const drawn = status === 'ready' || status === 'stale';
    const render: RenderState = drawn
      ? {
          status,
          asset: qaAsset(`${o.seed}-p${i + 1}`, size.w, size.h),
          history: i % 3 === 0 ? [qaAsset(`${o.seed}-p${i + 1}-v1`, size.w, size.h, { origin: 'render' } as Partial<AssetRef>)] : [],
          model: 'nano-banana-2.1',
          updatedAt: QA_NOW,
          ...(o.density === 'stress' || i === 0
            ? {
                qc: {
                  score: 0.71,
                  issues: ['The bunny’s floppy ear switches sides between panel 2 and panel 3, and the ducklings are drawn yellow here but brown on the cover'],
                  checkedAt: QA_NOW
                }
              }
            : {})
        }
      : status === 'failed'
        ? { status, history: [], error: 'The image model timed out after 120 seconds while drawing this page. Nothing was charged — try again or simplify the panel actions.' }
        : { status, history: [], ...(status === 'none' ? {} : { updatedAt: QA_NOW }) };
    const page: Page = {
      id,
      n: i + 1,
      summary:
        o.density === 'stress'
          ? `Page ${i + 1}: The baby meets the ducklings, the frog sings an aria from a lily pad, the bunny hides behind a reed and everybody ends up splashing in the shallows until the sun goes down`
          : `Page ${i + 1}: the chase continues across the rooftops`,
      layout: 'Row 1: one wide panel. Row 2: two equal panels. Row 3: one wide panel.',
      ...(o.density === 'stress' ? { turnHook: 'What is that glowing thing under the water?' } : {}),
      ...(i > 0 && i % 6 === 0 ? { chapterTitle: `Chapter ${i / 6 + 1}` } : {}),
      panels,
      render,
      balloons: []
    };
    if (drawn && o.balloons !== 'none') page.balloons = o.balloons === 'edge' ? edgeBalloons(page) : tidyBalloons(page);
    return page;
  });

// ── Conversation ─────────────────────────────────────────────────────────────

const makeConversation = (doc: ComicDoc, density: Density): Msg[] => {
  const stress = density === 'stress';
  const longUrl = `https://example.com/a/really/long/url/that/never/breaks/because/it/has/no/spaces/${'x'.repeat(80)}`;
  const paste = stress
    ? Array.from({ length: 30 }, (_, i) => `PAGE ${i + 1}\nPANEL 1: The baby (BEA) stands at the lake.\nBEA: Duckies!! ${longUrl}`).join('\n\n')
    : 'PAGE 1\nPANEL 1: Rain over the rooftops.\nMAYA: Stop right there!';
  const msgs: Msg[] = [];
  let t = QA_NOW - 100_000;
  const u = (text: string) => msgs.push({ id: `u${msgs.length}`, role: 'user', text, at: t++ });
  const a = (text: string, cards?: Card[], extra: Partial<Msg> = {}) => msgs.push({ id: `a${msgs.length}`, role: 'assistant', text, at: t++, ...(cards ? { cards } : {}), ...extra });
  u(stress ? 'baby playing near a lake with other animals a kids comic single page.' : 'A cat burglar chases a thief across Mumbai rooftops. 12 pages.');
  a('', [
    {
      type: 'options',
      id: 'o1',
      question: stress
        ? 'Which art direction should this storybook follow? Pick as many as you like — I will blend them into one consistent look before drawing anything.'
        : 'Which look should the heist have?',
      multi: true,
      allowCustom: true,
      choices: [
        { id: 'c1', label: 'Noir ink', description: 'High-contrast blacks and rain-slick rooftops', visual: { kind: 'preset', presetId: 'noir-ink' } },
        { id: 'c2', label: stress ? 'Supercalifragilisticexpialidocious-ultra-bright-cartoon-style-without-spaces' : 'Bright cartoon', description: 'Bold' },
        { id: 'c3', label: 'Clean ligne claire', description: 'Crisp', visual: { kind: 'layout', panels: 4 } },
        { id: 'c4', label: 'Crayon', description: 'Kid-drawn feel', visual: { kind: 'pages', count: 12 } }
      ]
    }
  ]);
  u('Noir ink, please');
  a('', [
    { type: 'plan', id: 'cp1' },
    { type: 'style_choice', id: 'sc1' }
  ]);
  u(paste);
  a(
    stress
      ? 'Here is everything so far. ' + 'I kept the ducklings yellow on every page and locked the frog’s green. '.repeat(6) + '\n\n- **Page 1** — arrival\n- **Page 2** — the frog sings\n\n```\nsome very long code-like line ' + 'z'.repeat(200) + '\n```'
      : 'Here’s the plan with the cast and the first pages. I kept Maya’s red scarf on every page.',
    [
      { type: 'cast', id: 'cc1', characterIds: doc.cast.map((c) => c.id) },
      { type: 'gate', id: 'cg1', gateId: 'gate_qa' },
      { type: 'breakdown', id: 'bd1', pageIds: doc.pages.slice(0, 4).map((p) => p.id), cover: true, view: 'plan' },
      {
        type: 'renders',
        id: 'cr1',
        label: stress ? 'Pages 1–20 plus the cover and every character sheet in the watercolor style' : 'Pages and cover',
        targets: [
          ...doc.pages.slice(0, 12).map((p) => ({ kind: 'page' as const, id: p.id })),
          { kind: 'cover' as const },
          ...doc.cast.slice(0, 4).map((c) => ({ kind: 'sheet' as const, id: c.id })),
          ...(doc.style.options[0] ? [{ kind: 'style_option' as const, id: doc.style.options[0].id }] : [])
        ]
      },
      {
        type: 'notice',
        id: 'n1',
        tone: 'warn',
        text: stress
          ? `Page 1 came back square (1:1) even though the book is 4:5 — the image model snapped to its nearest supported aspect. Balloons were re-fit to the real image. https://docs.example.com/very/long/link/without/any/breaks/${'q'.repeat(60)}`
          : 'Page 1 came back square (1:1) — balloons were re-fit to the real image.'
      },
      { type: 'notice', id: 'n2', tone: 'error', text: 'Rendering failed for page 7. Nothing was charged.' },
      { type: 'notice', id: 'n3', tone: 'success', text: 'Done — page 1 ($0.06)' },
      { type: 'notice', id: 'n4', tone: 'info', text: 'Free — done by the editor, no AI cost.' },
      { type: 'recap', id: 'rc1' }
    ],
    {
      suggestions: stress
        ? ['Add a cover with all the animals', 'Make the frog sing a longer song across two whole pages please', 'Turn it into a 20-page bedtime book']
        : ['Add a cover'],
      nextSteps: [
        { label: 'Tidy page 1’s balloons', client: { type: 'open_page', pageId: doc.pages[0]?.id || 'pg_1' }, usd: 0 },
        {
          label: stress ? 'Draw every remaining page in the watercolor storybook style' : 'Draw pages 3–5',
          action: { type: 'render_pages', pageIds: doc.pages.filter((p) => p.render.status !== 'ready').slice(0, 3).map((p) => p.id), quotedUsd: 0.18 },
          usd: 0.18
        },
        { label: 'Open the reader', client: { type: 'open_reader', immersive: true }, usd: 0 }
      ]
    }
  );
  return msgs;
};

// ── Docs ─────────────────────────────────────────────────────────────────────

interface DocOpts {
  title: string;
  kind: ComicKind;
  aspect: AspectRatio;
  pages: number;
  density: Density;
  seed: string;
  castNames: string[];
  statuses: RenderState['status'][];
  panels: (i: number) => number;
  balloons: 'edge' | 'tidy' | 'none';
  squareIndex?: number;
  conversation: boolean;
  gate: boolean;
  logline: string;
}

const buildDoc = (o: DocOpts): ComicDoc => {
  const stress = o.density === 'stress';
  const base = createEmptyDoc(QA_PROJECT_ID, o.title, QA_NOW);
  const doc: ComicDoc = {
    ...base,
    rev: 42,
    brief: {
      title: o.title,
      logline: o.logline,
      premise: stress ? 'Supercalifragilisticexpialidociouslylongunbrokenwordthatshouldwrapsomewherebutprobablywillnotbecauseithasnospaces premise.' : 'Maya works the spice market by day.',
      genre: stress ? 'Kids picture book / gentle adventure / musical comedy' : 'Crime caper',
      tone: 'Warm',
      audience: stress ? 'Kids 2–6 and the grown-ups reading aloud to them at bedtime' : 'Teens',
      setting: stress ? 'Willowmere Lake' : 'Mumbai rooftops',
      themes: stress ? ['friendship', 'curiosity', 'nature', 'bravery-in-small-doses', 'sharing'] : ['family'],
      notes: stress ? ['No scary moments', 'Every animal must appear on the cover too', 'Keep dialogue under 12 words per balloon for early readers'] : []
    },
    format: { ...base.format, kind: o.kind, pageAspect: o.aspect, pageCount: o.pages, lettering: 'overlay' },
    source: { script: Array.from({ length: 40 }, (_, i) => `LINE ${i + 1}: The chase continues.`).join('\n'), updatedAt: QA_NOW },
    style: {
      status: 'locked',
      name: stress ? 'Soft watercolor storybook with gouache highlights and pencil linework (Beatrix-Potter-adjacent)' : 'Noir ink',
      spec: stress ? 'Loose wet-on-wet watercolor washes, '.repeat(8) : 'High-contrast black ink with a single red accent',
      palette: stress ? ['#1d3557', '#e63946', '#f1faee', '#a8dadc', '#457b9d', '#ffb703', '#fb8500', '#8ecae6', '#219ebc', '#023047'] : ['#111111', '#f5f0e6', '#c0392b'],
      linework: 'Tapered brush',
      avoid: ['photorealism', 'gore'],
      presetId: 'noir-ink',
      refs: [],
      board: qaAsset(`${o.seed}-board`, 800, 1000),
      options: [
        { id: 'so_a', name: stress ? 'Watercolor storybook with very soft gouache edges and warm morning light' : 'Inky noir', spec: 'Heavy blacks', render: { status: 'ready', history: [], asset: qaAsset(`${o.seed}-so-a`, 800, 1000), updatedAt: QA_NOW } },
        { id: 'so_b', name: stress ? 'Ligne claire pastel picture-book (Hergé meets Miffy)' : 'Pastel', spec: 'Soft pastel', render: { status: 'rendering', history: [], updatedAt: QA_NOW } },
        { id: 'so_c', name: 'Riso', spec: 'Two-colour', render: { status: 'failed', history: [], error: 'The model refused this one because it looked too much like a trademarked character.' } }
      ]
    },
    places: [
      { id: 'pl_1', name: stress ? 'Willowmere Lake shoreline at golden hour with the old wooden jetty' : 'Spice market rooftops', look: 'Wet tin roofs, laundry lines, water tanks', refs: [], sheet: { status: 'none', history: [] } }
    ],
    planStatus: 'approved',
    settings: { ...base.settings, quality: 'standard', confirm: 'big', bigSpendUsd: 0.5, budgetUsd: 5 },
    spend: stress
      ? {
          totalUsd: 1234.56,
          byKind: { page: 812.4, sheet: 120.11, style: 99.99, chat: 3.2, cover: 199, edit: 0.86 },
          entries: [{ id: 'sp1', at: QA_NOW, kind: 'page', label: 'Page 1', usd: 0.06, byok: false, estimated: true }],
          savedUsd: 0.42
        }
      : {
          totalUsd: 0.54,
          byKind: { page: 0.36, sheet: 0.12, chat: 0.06 },
          entries: [{ id: 'sp1', at: QA_NOW, kind: 'page', label: 'Page 1', usd: 0.06, byok: false, estimated: false }],
          savedUsd: 0.12
        }
  };
  doc.cast = makeCast(o.castNames, o.density, o.seed);
  doc.pages = makePages({
    count: o.pages,
    density: o.density,
    aspect: o.aspect,
    seed: o.seed,
    castIds: doc.cast.map((c) => c.id),
    statuses: o.statuses,
    panels: o.panels,
    squareIndex: o.squareIndex,
    balloons: o.balloons
  });
  doc.pages.forEach((p) => {
    if (p.render.status === 'ready') p.render.specHash = pageSpecHash(doc, p);
    if (p.render.status === 'stale') p.render.specHash = 'stale0000';
  });
  const coverSize = qaPageSize(o.aspect);
  doc.cover = {
    title: o.title,
    tagline: stress ? 'Every splash makes a new friend — even the very, very, very loud frog.' : 'One night. One vault. No second chances.',
    direction: 'Hero centre, city behind',
    render: { status: 'ready', asset: qaAsset(`${o.seed}-cover`, coverSize.w, coverSize.h), history: [], updatedAt: QA_NOW }
  };
  doc.gate = o.gate
    ? {
        id: 'gate_qa',
        action: { type: 'render_pages', pageIds: doc.pages.filter((p) => p.render.status !== 'ready').map((p) => p.id), quotedUsd: 1.31 },
        title: stress ? 'Draw all twenty pages of the storybook in watercolor at Pro quality' : 'Draw the remaining pages',
        summary: stress ? 'This draws every page that is not drawn yet, plus re-draws the five pages that are out of date because you changed the cast.' : 'Draws the pages that are not drawn yet.',
        estimateUsd: 1.31,
        imageCount: Math.max(1, doc.pages.filter((p) => p.render.status !== 'ready').length),
        model: stress ? 'nano-banana-2.1-pro-preview-very-long-model-identifier-x' : 'nano-banana-2.1',
        createdAt: QA_NOW,
        status: 'open',
        reason: 'budget'
      }
    : null;
  if (o.conversation) doc.conversation = makeConversation(doc, o.density);
  // normalizeDoc fills every v5 default the components read (letterStyle, book, reader, i18n …).
  return normalizeDoc(doc);
};

const READY_HEAVY: RenderState['status'][] = ['ready', 'ready', 'none', 'queued', 'rendering', 'ready', 'failed', 'ready', 'stale', 'ready', 'ready', 'none'];

/** A fresh copy of a fixture doc (null for the loading scene is the host's choice, not a fixture). */
export const makeQaDoc = (name: QaFixtureName, opts: { rtl?: boolean } = {}): ComicDoc => {
  let doc: ComicDoc;
  switch (name) {
    case 'lake-1p':
      doc = buildDoc({
        title: 'Baby at the Lake',
        kind: 'storybook',
        aspect: '4:5',
        pages: 1,
        density: 'normal',
        seed: 'lake',
        castNames: ['Baby Bea', 'Mother Duck', 'Frog', 'Ducklings'],
        statuses: ['ready'],
        panels: () => 4,
        balloons: 'edge',
        squareIndex: 0,
        conversation: true,
        gate: false,
        logline: 'A toddler meets the animals of the lake.'
      });
      break;
    case 'deep-40p':
      doc = buildDoc({
        title: 'The Long Night',
        kind: 'comic',
        aspect: '2:3',
        pages: 40,
        density: 'normal',
        seed: 'deep',
        castNames: ['Maya', 'Arjun', 'Vendor'],
        statuses: ['ready'],
        panels: (i) => 3 + (i % 3),
        balloons: 'tidy',
        conversation: false,
        gate: false,
        logline: 'Forty pages of rooftop chases.'
      });
      break;
    case 'webtoon-20p':
      doc = buildDoc({
        title: 'Scroll of the Tide',
        kind: 'webtoon',
        aspect: '9:16',
        pages: 20,
        density: 'normal',
        seed: 'toon',
        castNames: ['Kai', 'Mira'],
        statuses: ['ready'],
        panels: () => 2,
        balloons: 'tidy',
        conversation: false,
        gate: false,
        logline: 'A vertical-scroll sea story.'
      });
      break;
    case 'stress':
      doc = buildDoc({
        title:
          'Baby Bea and the Extraordinarily Long Afternoon at Willowmere Lake: A Watercolor Storybook Adventure With Ducklings, a Frog, a Bunny and Absolutely Nobody Taking a Nap',
        kind: 'storybook',
        aspect: '4:5',
        pages: 20,
        density: 'stress',
        seed: 'stress',
        castNames: STRESS_CAST,
        statuses: ['ready', 'none', 'queued', 'rendering', 'ready', 'failed'],
        panels: (i) => 3 + (i % 4),
        balloons: 'edge',
        squareIndex: 0,
        conversation: true,
        gate: true,
        logline:
          'A curious toddler wanders to the edge of a sparkling lake where a chorus of ducklings, a frog with operatic ambitions and a shy bunny teach her that every splash is a new friend — told across a gentle single-page watercolor storybook spread that grows into a twenty-page bedtime epic.'
      });
      break;
    case 'empty':
      doc = normalizeDoc(createEmptyDoc(QA_PROJECT_ID, 'Untitled comic', QA_NOW));
      break;
    case 'heist-12p':
    default:
      doc = buildDoc({
        title: 'The Saffron Heist',
        kind: 'comic',
        aspect: '2:3',
        pages: 12,
        density: 'normal',
        seed: 'heist',
        castNames: ['Maya', 'Arjun', 'Vendor', 'Pigeons'],
        statuses: READY_HEAVY,
        panels: (i) => 3 + (i % 3),
        balloons: 'tidy',
        conversation: true,
        gate: true,
        logline: 'A pickpocket steals saffron to pay for her brother’s surgery.'
      });
      break;
  }
  if (opts.rtl) doc = { ...doc, format: { ...doc.format, readingDirection: 'rtl' } };
  return doc;
};

/** Every image path a fixture references (originals and variants), for pre-generation and tests. */
export const qaImagePaths = (doc: ComicDoc): string[] => {
  const out = new Set<string>();
  const add = (a?: AssetRef | null) => {
    if (!a?.path) return;
    out.add(a.path);
    a.variants?.forEach((v) => out.add(v.path));
  };
  const addRender = (r?: RenderState) => {
    add(r?.asset);
    r?.history.forEach(add);
  };
  add(doc.style.board);
  doc.style.options.forEach((o) => addRender(o.render));
  doc.cast.forEach((c) => addRender(c.sheet));
  doc.places.forEach((p) => addRender(p.sheet));
  doc.pages.forEach((p) => addRender(p.render));
  addRender(doc.cover.render);
  return [...out];
};
