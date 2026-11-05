// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyOps } from '../../../shared/comic/ops.js';
import { emptyRender, pageSpecHash, type ComicDoc } from '../../../shared/comic/doc.js';
import { LEXICON_SIZE, castOpsForUncast, describeUncast, findUncastBeings, scanText } from './castScan.js';
import { lakePlannedDoc } from './golden/fixtures.js';

const words = (t: string) => scanText(t).map((h) => [h.entry.word, h.count ?? null, h.groupWord]);

/** The owner's lake page, before the animals were cast: only The Baby exists. */
const lakeUncast = (): ComicDoc => {
  const doc = lakePlannedDoc();
  doc.cast = doc.cast.slice(0, 1);
  doc.conversation = [{ id: 'u1', role: 'user', text: 'baby playing near a lake with other animals a kids comic single page', at: 1 }];
  const [p1, p2, p3] = doc.pages[0].panels;
  p1.action = 'The Baby sits at the lake edge, splashing; three fluffy yellow ducklings paddle close.';
  p1.castIds = ['c_baby'];
  p2.action = 'A small green frog hops onto a lily pad; the ducklings quack.';
  p2.castIds = ['c_baby'];
  p3.action = 'A grey bunny peeks from the reeds while the frog waves; a heron watches far away.';
  p3.castIds = ['c_baby'];
  return doc;
};

describe('lexicon scan', () => {
  it('covers ~180+ nouns across animals, sea creatures, creatures, robots, toys, vehicles and props', () => {
    expect(LEXICON_SIZE).toBeGreaterThanOrEqual(180);
    expect(words('An octopus and two crabs hide; a seahorse drifts.')).toEqual(
      expect.arrayContaining([['octopus', null, false], ['crab', 2, true], ['seahorse', null, false]])
    );
    expect(words('A dragon circles the robot while a red car speeds past.')).toEqual(
      expect.arrayContaining([['dragon', null, false], ['robot', null, false], ['car', null, false]])
    );
  });

  it('LEGO-style figures and toys are recognised (names avoid the trademark)', () => {
    const hits = scanText('A LEGO figure and two minifigures wave from a toy car; a teddy bear sits nearby.');
    expect(hits.map((h) => [h.entry.word, h.entry.kind, h.entry.name ?? null])).toEqual(
      expect.arrayContaining([
        ['lego figure', 'toy', 'Brick Figure'],
        ['minifigure', 'toy', 'Minifigure'],
        ['toy car', 'toy', null],
        ['teddy bear', 'toy', null]
      ])
    );
  });

  it('skips verbs and compounds ("Maya ducks", "bears the weight", "a bear hug", "the train station")', () => {
    expect(words('Maya ducks under the beam and bears the weight.')).toEqual([]);
    expect(words('A bear hug at the train station near the fish market.')).toEqual([]);
    expect(words('The train pulls in.')).toEqual([['train', null, false]]);
  });
});

describe('findUncastBeings / castOpsForUncast (golden lake scenario)', () => {
  it('ducklings ×3, frog and bunny (named by the user) become cast; a one-off heron does not', () => {
    const doc = lakeUncast();
    const beings = findUncastBeings(doc);
    expect(beings.map((b) => [b.name, b.kind, b.count ?? 1, b.panels])).toEqual([
      ['Ducklings', 'animal', 3, 2],
      ['Frog', 'animal', 1, 2]
    ]);
    expect(beings[0].firstMention).toBe('p1 panel 1');
    expect(describeUncast(beings)).toBe('Ducklings ×3 and Frog');
  });

  it('commits text-locked cast with a drawable look and puts them in the panels of undrawn pages', () => {
    const doc = lakeUncast();
    const ops = castOpsForUncast(doc, findUncastBeings(doc));
    const after = applyOps(doc, ops);
    const ducks = after.cast.find((c) => c.name === 'Ducklings')!;
    expect(ducks).toMatchObject({ kind: 'animal', count: 3, tier: 'extra', look: { species: 'duckling' } });
    expect(ducks.look.summary).toBe('Three identical fluffy yellow ducklings, drawn the same in every panel.');
    const frog = after.cast.find((c) => c.name === 'Frog')!;
    expect(frog.look.summary).toBe('A small green frog, drawn the same in every panel.');
    const panels = after.pages[0].panels;
    expect(panels[0].castIds).toEqual(['c_baby', ducks.id]);
    expect(panels[1].castIds).toEqual(['c_baby', ducks.id, frog.id]);
    // Idempotent: a second scan finds nothing new.
    expect(findUncastBeings(after)).toEqual([]);
  });

  it('never touches a drawn, current page (no paid art goes stale)', () => {
    const doc = lakeUncast();
    const page = doc.pages[0];
    page.render = { ...emptyRender(), status: 'ready', asset: { path: 'p.webp', source: 'generated', at: 1 } };
    page.render.specHash = pageSpecHash(doc, page);
    const ops = castOpsForUncast(doc, findUncastBeings(doc));
    expect(ops.every((o) => o.op === 'character')).toBe(true);
    const after = applyOps(doc, ops);
    expect(after.pages[0].render.specHash).toBe(pageSpecHash(after, after.pages[0]));
  });

  it('existing cast covers its kind (name, species or summary); no plan → nothing', () => {
    expect(findUncastBeings(lakePlannedDoc())).toEqual([]);
    const empty = lakeUncast();
    empty.pages = [];
    expect(findUncastBeings(empty)).toEqual([]);
    expect(castOpsForUncast(empty, [])).toEqual([]);
  });

  it('a recurring key prop (the red kite) and a vehicle become text-locked cast too', () => {
    const doc = lakeUncast();
    const [p1, p2, p3] = doc.pages[0].panels;
    p1.action = 'The Baby holds a red kite near a little blue boat.';
    p2.action = 'The red kite tugs upward; the boat rocks.';
    p3.action = 'The kite lands softly on the boat.';
    const beings = findUncastBeings(doc);
    expect(beings.map((b) => [b.name, b.kind])).toEqual(
      expect.arrayContaining([
        ['Kite', 'object'],
        ['Boat', 'vehicle']
      ])
    );
    expect(beings).toHaveLength(2);
  });
});
