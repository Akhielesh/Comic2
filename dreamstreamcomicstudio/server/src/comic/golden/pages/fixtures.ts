// Golden page-prompt fixtures (plan §10 A2, §13 "Golden measurement set"): synthetic docs SHAPED
// like the owner's measured pages — b4b5774f p2 and p4, f8312c86 p1 — with invented names, looks and
// paths (no production data, no real person). Shared by A2 (Ship 1 prompt), B5 (Ship 2 must compile a
// doc without new data to the Ship 1 golden byte for byte, I8) and the Model Lab A/B (A6, B11).
//
// Each fixture is a stored-looking doc (normalizeDoc, as a load would) whose target page carries a
// render drawn BEFORE Ship 1, with the spec hash it was stamped with. `pins` lists the page's
// pageSpecHash in today's serialisation and in the canonical one back-compat F1 (K1) moves to
// (keys sorted at every depth): Ship 1 changes prompt text and references only, so the hash must
// stay one of these.

import {
  DEFAULT_FORMAT,
  DEFAULT_SETTINGS,
  normalizeDoc,
  type AspectRatio,
  type Character,
  type ComicDoc,
  type Line,
  type Page,
  type Panel,
  type RefAsset,
  type RenderState
} from '../../../../../shared/comic/doc.js';

const T0 = 1_792_670_000_000; // 2026-10-22, fixed so hashes and outputs are stable

export interface PageFixture {
  /** "courier-p2" — also the golden prompt's file name. */
  key: string;
  /** What measured page it is shaped like, and why it is in the set. */
  shapedLike: string;
  doc: ComicDoc;
  page: Page;
  previousPage?: Page;
  /** pageSpecHash before Ship 1: [today's serialisation, F1's canonical serialisation]. */
  pins: [string, string];
}

const generated = (path: string) => ({ path, source: 'generated' as const, at: T0 });
const readyRender = (path: string, specHash?: string, aspect: AspectRatio = '2:3'): RenderState => ({
  status: 'ready',
  history: [],
  asset: generated(path),
  aspect,
  origin: 'render',
  updatedAt: T0,
  ...(specHash ? { specHash } : {})
});
const none = (): RenderState => ({ status: 'none', history: [] });

let seq = 0;
const say = (kind: Line['kind'], text: string, speakerId?: string): Line => ({ id: `ln_g${++seq}`, kind, text, ...(speakerId ? { speakerId } : {}) });

const panel = (id: string, n: number, p: Omit<Panel, 'id' | 'n' | 'lines'> & { lines?: Line[] }): Panel => ({ id, n, lines: [], ...p });

// ── "The Lantern Courier" (shaped like b4b5774f: a 6-page comic, 2 leads with sheets, extras without) ──

const courierCast = (): Character[] => [
  {
    id: 'c_isha',
    name: 'Isha',
    tier: 'lead',
    look: {
      summary: 'Quick-witted 17-year-old courier with a lantern-shaped pendant',
      age: '17',
      gender: 'female',
      hair: 'two braids tied with orange thread',
      outfit: 'teal hooded jacket, cargo shorts',
      marks: 'small burn scar on her right forearm',
      props: 'brass wrist compass'
    },
    refs: [],
    sheet: readyRender('u/golden/courier/sheets/isha.webp')
  },
  {
    id: 'c_dev',
    name: 'Dev',
    tier: 'lead',
    look: {
      summary: 'Lanky 18-year-old tinkerer',
      gender: 'male',
      hair: 'messy black curls under welding goggles',
      outfit: 'oil-stained grey kurta with rolled sleeves',
      palette: 'grey, copper',
      props: 'a satchel of copper tools'
    },
    refs: [],
    sheet: readyRender('u/golden/courier/sheets/dev.webp')
  },
  {
    id: 'c_guard',
    name: 'Gate Guard',
    tier: 'extra',
    look: { summary: 'Stern market guard in a khaki uniform', gender: 'male', props: 'a bamboo staff' },
    refs: [],
    sheet: none()
  },
  {
    id: 'c_seller',
    name: 'Flower Seller',
    tier: 'extra',
    look: { summary: 'Cheerful flower seller with jasmine in her hair', gender: 'female' },
    refs: [],
    sheet: none()
  }
];

/** Panel fields every hashed tuple needs defined (no undefined → identical in both serialisations). */
const at = (placeId: string, angle: string, mood: string) => ({ placeId, angle, mood });

const courierPages = (): Page[] => [
  {
    id: 'pg_c1',
    n: 1,
    summary: 'Isha takes a sealed parcel at the night bazaar.',
    layout: 'Row 1: one wide panel. Row 2: two equal panels. Row 3: two equal panels.',
    panels: [1, 2, 3, 4, 5].map((n) =>
      panel(`pn_c1_${n}`, n, { size: n === 1 ? 'wide' : 'medium', shot: n === 1 ? 'establishing' : 'medium', action: `Isha moves through the bazaar, beat ${n}.`, castIds: ['c_isha'], ...at('pl_bazaar', 'eye level', 'warm') })
    ),
    render: readyRender('u/golden/courier/pages/p1.webp'),
    balloons: []
  },
  {
    // b4b5774f p2: 2-1-3 rows; the writer labelled the smallest panels "small" and gave them the most
    // words (17, 15 + 14) while the wide panel is silent; panel 6 is a POV shot whose viewer and a
    // second speaker were both forced into the cast ("speakers are visible", writer R8).
    id: 'pg_c2',
    n: 2,
    summary: 'A van with no markings waits behind the flower stalls.',
    layout: 'Row 1: two equal panels. Row 2: one wide panel. Row 3: three small panels.',
    panels: [
      panel('pn_c2_1', 1, {
        size: 'medium',
        shot: 'wide',
        action: 'Isha and Dev weave between lantern-lit stalls while the gate guard blocks the lane ahead. Crowds part around them.',
        castIds: ['c_isha', 'c_dev', 'c_guard'],
        lines: [say('speech', 'Nobody passes the east gate after the second bell tonight.', 'c_guard')],
        ...at('pl_bazaar', 'eye level', 'busy, warm lantern light')
      }),
      panel('pn_c2_2', 2, {
        size: 'medium',
        shot: 'medium',
        action: 'Dev kneels and pries open a rusted drain cover with a copper lever.',
        castIds: ['c_dev'],
        lines: [say('sfx', 'CLANK')],
        ...at('pl_bazaar', 'low angle', 'focused')
      }),
      panel('pn_c2_3', 3, {
        size: 'wide',
        shot: 'wide',
        action: 'The two couriers slip along the canal path below the market. Lantern reflections ripple on the water.',
        castIds: ['c_isha', 'c_dev'],
        ...at('pl_gate', 'high angle', 'hushed, blue night')
      }),
      panel('pn_c2_4', 4, {
        size: 'small',
        shot: 'insert',
        action: "Isha's brass wrist compass spins and then points at the depot.",
        castIds: ['c_isha'],
        lines: [say('sfx', 'TIK')],
        ...at('pl_gate', 'top-down', 'tense')
      }),
      panel('pn_c2_5', 5, {
        size: 'small',
        shot: 'close_up',
        action: 'Isha crouches by the archway, squinting at a fresh tyre track in the mud.',
        castIds: ['c_isha'],
        lines: [say('speech', 'These tracks are fresh, and nothing with wheels is allowed through this gate after dark.', 'c_isha')],
        ...at('pl_gate', 'high angle', 'worried, cold blue')
      }),
      panel('pn_c2_6', 6, {
        size: 'small',
        shot: 'pov',
        action: "From Dev's view, a sleek unmarked delivery van idles behind the flower stalls with its headlights off.",
        castIds: ['c_dev', 'c_isha'],
        lines: [
          say('speech', 'That van has been parked there since sunset and the driver never once got out.', 'c_dev'),
          say('speech', 'Then we wait until he moves, and we follow it to the depot.', 'c_isha')
        ],
        ...at('pl_gate', 'eye level', 'suspicious, dim')
      })
    ],
    render: readyRender('u/golden/courier/pages/p2.webp'), // stamped with its pin by fixture()
    balloons: []
  },
  {
    id: 'pg_c3',
    n: 3,
    summary: 'They tail the van to the depot.',
    layout: 'Row 1: one wide panel. Row 2: two equal panels. Row 3: one wide panel.',
    panels: [1, 2, 3, 4].map((n) =>
      panel(`pn_c3_${n}`, n, { size: n === 1 || n === 4 ? 'wide' : 'medium', shot: 'medium', action: `They follow the van, beat ${n}.`, castIds: ['c_isha', 'c_dev'], ...at('pl_gate', 'eye level', 'tense') })
    ),
    render: readyRender('u/golden/courier/pages/p3.webp'),
    balloons: []
  },
  {
    // b4b5774f p4: a wide row over a tall panel beside a stack; a 17-word caption in the tall panel,
    // a shout in a small close-up, a silent insert.
    id: 'pg_c4',
    n: 4,
    summary: 'Inside the depot the parcel starts to glow.',
    layout: 'Row 1: one wide panel. Rows 2–3: one tall panel on the left beside two stacked panels on the right.',
    panels: [
      panel('pn_c4_1', 1, {
        size: 'wide',
        shot: 'medium',
        action: 'Isha and Dev duck behind stacked crates inside the dark depot.',
        castIds: ['c_isha', 'c_dev'],
        lines: [say('speech', 'Stay low and keep the parcel hidden.', 'c_isha')],
        ...at('pl_gate', 'eye level', 'dusty, dim')
      }),
      panel('pn_c4_2', 2, {
        size: 'tall',
        shot: 'full',
        action: 'The parcel in Dev’s satchel glows through the canvas. Shadows stretch up the depot wall.',
        castIds: ['c_isha', 'c_dev'],
        lines: [say('caption', 'Whatever was inside the parcel had been waiting a very long time for this exact night.')],
        ...at('pl_gate', 'low angle', 'eerie amber glow')
      }),
      panel('pn_c4_3', 3, {
        size: 'small',
        shot: 'close_up',
        action: 'Dev stares at the glow, goggles pushed up in shock.',
        castIds: ['c_dev'],
        lines: [say('shout', 'It is getting hotter, Isha!', 'c_dev')],
        ...at('pl_gate', 'eye level', 'alarmed')
      }),
      panel('pn_c4_4', 4, {
        size: 'small',
        shot: 'insert',
        action: 'The satchel buckle snaps open by itself.',
        castIds: [],
        lines: [say('sfx', 'SNAP')],
        ...at('pl_gate', 'top-down', 'sudden')
      })
    ],
    render: readyRender('u/golden/courier/pages/p4.webp'), // stamped with its pin by fixture()
    balloons: []
  }
];

const courierDoc = (): ComicDoc =>
  normalizeDoc({
    id: 'golden_courier',
    createdAt: T0,
    updatedAt: T0,
    brief: { title: 'The Lantern Courier', logline: 'Two young couriers chase a glowing parcel through a night bazaar.', notes: [] },
    format: { ...DEFAULT_FORMAT, kind: 'comic', language: 'en', colorMode: 'color', lettering: 'overlay', pageCount: 6, pageAspect: '2:3', panelsPerPage: 'auto', readingDirection: 'ltr' },
    settings: { ...DEFAULT_SETTINGS, confirm: 'big', quality: 'standard', bigSpendUsd: 0.5 },
    style: {
      status: 'locked',
      spec: 'Modern comic art: crisp variable-weight inks, warm cel shading, detailed street backgrounds.',
      palette: ['#1d3557', '#e76f51', '#f4a261'],
      linework: 'Crisp variable-weight inks',
      avoid: ['photorealism'],
      refs: [],
      options: [],
      board: generated('u/golden/courier/style/board.webp')
    },
    cast: courierCast(),
    places: [
      { id: 'pl_bazaar', name: 'Night Bazaar', look: 'Lantern-strung lanes of flower stalls and spice carts', refs: [], sheet: none() },
      { id: 'pl_gate', name: 'East Gate', look: 'Crumbling stone archway over a shuttered depot by a canal', refs: [], sheet: none() }
    ],
    pages: courierPages(),
    planStatus: 'approved'
  });

// ── "Puddle Parade" (shaped like f8312c86: a 4:5 storybook whose protagonist is an EXTRA in every
// panel with a ready sheet and 4 photos, beside 3 animal supports with sheets) ──

const photo = (path: string, label: RefAsset['label']): RefAsset => ({ path, source: 'upload', at: T0, label, subject: 'person' });

const pondCast = (): Character[] => [
  {
    id: 'c_mina',
    name: 'Mina',
    tier: 'extra',
    look: {
      summary: 'Curious toddler with round cheeks and a gap-toothed grin',
      age: '2',
      gender: 'female',
      hair: 'short curly auburn hair with a green clip',
      outfit: 'yellow raincoat over striped leggings',
      marks: 'a freckle on her left cheek',
      palette: 'sunny yellow, leaf green'
    },
    refs: [
      photo('u/golden/pond/refs/mina-face.webp', 'face'),
      photo('u/golden/pond/refs/mina-full.webp', 'full_body'),
      photo('u/golden/pond/refs/mina-side.webp', 'side'),
      photo('u/golden/pond/refs/mina-smile.webp', 'expression')
    ],
    sheet: readyRender('u/golden/pond/sheets/mina.webp')
  },
  {
    id: 'c_puddle',
    name: 'Puddle',
    tier: 'support',
    kind: 'animal',
    look: { summary: 'A small fluffy yellow duckling with an orange bill', marks: 'one white feather on its crown', palette: 'butter yellow, orange' },
    refs: [],
    sheet: readyRender('u/golden/pond/sheets/puddle.webp')
  },
  {
    id: 'c_hopper',
    name: 'Hopper',
    tier: 'support',
    kind: 'animal',
    look: { summary: 'A round green tree frog with a pale belly', markings: 'three dark spots on its back' },
    refs: [],
    sheet: readyRender('u/golden/pond/sheets/hopper.webp')
  },
  {
    id: 'c_bramble',
    name: 'Bramble',
    tier: 'support',
    kind: 'animal',
    look: { summary: 'A small grey rabbit with a white tail', marks: 'a notch in its left ear' },
    refs: [],
    sheet: readyRender('u/golden/pond/sheets/bramble.webp')
  }
];

const pondDoc = (): ComicDoc =>
  normalizeDoc({
    id: 'golden_pond',
    createdAt: T0,
    updatedAt: T0,
    brief: { title: 'Puddle Parade', logline: 'A toddler follows a duckling around a lily pond.', audience: 'kids 2–6', notes: [] },
    format: { ...DEFAULT_FORMAT, kind: 'storybook', language: 'en', colorMode: 'color', lettering: 'overlay', pageCount: 5, pageAspect: '4:5', panelsPerPage: 4, readingDirection: 'ltr' },
    settings: { ...DEFAULT_SETTINGS, confirm: 'big', quality: 'draft', bigSpendUsd: 0.3 },
    style: {
      status: 'locked',
      spec: "Children's picture-book watercolor: soft pencil outlines, transparent washes, rounded friendly shapes, gentle light.",
      palette: ['#e9c46a', '#90be6d', '#f4a261'],
      linework: 'Soft pencil, loose',
      refs: [],
      options: [],
      board: generated('u/golden/pond/style/board.webp')
    },
    cast: pondCast(),
    places: [{ id: 'pl_pond', name: 'Lily Pond', look: 'A sunny grassy bank beside a lily pond with smooth pebbles', refs: [], sheet: none() }],
    pages: [
      {
        // f8312c86 p1: wide / pair / wide; captions and SFX only (nobody speaks); the protagonist is in
        // all 4 panels, the duckling in 2 — the beats drifted between panels when the protagonist was
        // text-locked (panels challenge R1).
        id: 'pg_p1',
        n: 1,
        summary: 'Mina toddles to the pond and meets Puddle.',
        layout: 'Row 1: one wide panel. Row 2: two equal panels. Row 3: one wide panel.',
        panels: [
          panel('pn_p1_1', 1, {
            size: 'wide',
            shot: 'establishing',
            action: 'Mina toddles along a grassy path toward the sparkling lily pond. Yellow wildflowers dot the bank.',
            castIds: ['c_mina'],
            lines: [say('caption', 'One bright morning, Mina went looking for a new friend.')],
            ...at('pl_pond', 'eye level', 'bright, warm, joyful')
          }),
          panel('pn_p1_2', 2, {
            size: 'medium',
            shot: 'insert',
            action: "Mina's bare toes dip into the shallow water over smooth pebbles. Ripples spread out.",
            castIds: ['c_mina'],
            lines: [say('sfx', 'Splish!'), say('caption', 'The water tickled her toes.')],
            ...at('pl_pond', 'high angle', 'cool, sparkling')
          }),
          panel('pn_p1_3', 3, {
            size: 'medium',
            shot: 'medium',
            action: 'Mina sits at the edge of the water while Puddle paddles toward her, looking back over its wing.',
            castIds: ['c_mina', 'c_puddle'],
            lines: [say('sfx', 'Peep peep!'), say('caption', 'Then a fluffy little duckling paddled over to say hello to her.')],
            ...at('pl_pond', 'eye level', 'delighted, sunny')
          }),
          panel('pn_p1_4', 4, {
            size: 'wide',
            shot: 'close_up',
            action: 'Mina giggles with sparkling eyes as Puddle bobs right beside her. A yellow butterfly flutters behind them.',
            castIds: ['c_mina', 'c_puddle'],
            lines: [say('caption', 'Mina laughed, and Puddle laughed right back.')],
            ...at('pl_pond', 'eye level', 'giggly, golden light')
          })
        ],
        render: readyRender('u/golden/pond/pages/p1.webp', undefined, '4:5'), // stamped with its pin by fixture()
        balloons: []
      }
    ],
    planStatus: 'approved'
  });

/**
 * The pre-Ship-1 page hashes, computed at the v5 head this package started from (9da83937):
 * [JSON.stringify of pageSpecHash's tuple (today), the same tuple with keys sorted at every depth
 * (F1's canonical form — normalizeDoc puts `summary` first in every look, so the two differ)].
 */
const PINS: Record<string, [string, string]> = {
  'courier-p2': ['57d6c4db', 'd979db23'],
  'courier-p4': ['0ec780ca', 'a54cd8e8'],
  'pond-p1': ['f89723c3', '7cd4c92d']
};

const fixture = (key: string, shapedLike: string, doc: ComicDoc, pageId: string, previousId?: string): PageFixture => {
  const page = doc.pages.find((p) => p.id === pageId)!;
  const pins = PINS[key];
  // The stored stamp is today's serialisation (what a page drawn before Ship 1 carries).
  page.render.specHash = pins[0];
  const previousPage = previousId ? doc.pages.find((p) => p.id === previousId) : undefined;
  return { key, shapedLike, doc, page, ...(previousPage ? { previousPage } : {}), pins };
};

/** Fresh copies every call (tests may mutate). */
export const pageFixtures = (): PageFixture[] => {
  seq = 0;
  const courier = courierDoc();
  const courier4 = courierDoc();
  const pond = pondDoc();
  return [
    fixture('courier-p2', 'b4b5774f p2: 6 panels in 2-1-3 rows, the most words in the smallest panels, a POV panel with its viewer forced into the cast', courier, 'pg_c2', 'pg_c1'),
    fixture('courier-p4', 'b4b5774f p4: a wide row over a tall panel beside a stack, a long caption, a silent insert', courier4, 'pg_c4', 'pg_c3'),
    fixture('pond-p1', 'f8312c86 p1: a 4:5 storybook page whose protagonist is an extra with a ready sheet and 4 photos, in every panel', pond, 'pg_p1')
  ];
};

export const pageFixture = (key: string): PageFixture => {
  const found = pageFixtures().find((f) => f.key === key);
  if (!found) throw new Error(`No golden page fixture "${key}"`);
  return found;
};
