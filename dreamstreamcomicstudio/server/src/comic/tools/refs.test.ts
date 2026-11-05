// Director tool group "refs" (refs.md §4.9, §6, §9 tools.test): attach_refs creates/labels/orders and
// is honest over the cap; carried images resolve next turn; positions drive set_primary/label/move/
// remove; a ready sheet is never marked stale by an add — the redraw is OFFERED with its price.
import { describe, expect, it } from 'vitest';
import { emptyRender, type ComicDoc, type RefAsset } from '../../../../shared/comic/doc.js';
import { REF_LIMITS } from '../../../../shared/comic/refs.js';
import { newSession, opsOf, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { createDirectorTurn, type DirectorTurn } from '../tools.js';
import { carriedImages } from '../refs/index.js';
import { toolGroupById } from './index.js';
import { refsSummaryLines, refsToolGroup } from './refs.js';

const ref = (n: number, extra: Partial<RefAsset> = {}): RefAsset => ({ path: `u/user-1/p/proj-1/ref/r${n}.webp`, source: 'upload', at: n, ...extra });

const toolsFor = (doc: ComicDoc, images: RefAsset[] = []) => {
  const ctx = testContext(newSession(doc));
  const turn: DirectorTurn = createDirectorTurn({ attachments: images, images });
  const active = refsToolGroup.when!(ctx, turn);
  const tools = active ? refsToolGroup.tools(ctx, turn) : [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.spec.function.name === name);
    if (!tool) throw new Error(`tool ${name} not offered`);
    return tool.execute(args);
  };
  return { ctx, turn, active, tools, call };
};

describe('registration and phase gate', () => {
  it('is the registered refs group; every tool is FREE', () => {
    expect(toolGroupById('refs')).toBe(refsToolGroup);
    const { tools } = toolsFor(plannedDoc(), [ref(1)]);
    expect(tools.map((t) => t.spec.function.name)).toEqual(['attach_refs', 'set_primary_ref', 'label_ref', 'move_ref', 'remove_ref']);
    for (const t of tools) {
      expect(t.cost).toBe('free');
      expect(t.spec.function.description).toMatch(/^FREE — /);
    }
  });

  it('is off without images or refs; manage tools only (no attach) when refs exist but no images', () => {
    expect(toolsFor(plannedDoc()).active).toBe(false);
    const doc = plannedDoc();
    doc.cast[0].refs = [ref(1)];
    expect(toolsFor(doc).tools.map((t) => t.spec.function.name)).toEqual(['set_primary_ref', 'label_ref', 'move_ref', 'remove_ref']);
  });

  it('prompt rules: the full image rule set with images, the short rule without', () => {
    const { ctx } = toolsFor(plannedDoc(), [ref(1)]);
    expect(refsToolGroup.promptRules!(ctx.session.doc)).toMatch(/Assign EVERY image with attach_refs/);
    const doc = plannedDoc();
    doc.cast[0].refs = [ref(1)];
    const bare = toolsFor(doc);
    const rules = refsToolGroup.promptRules!(bare.ctx.session.doc)!;
    expect(rules).not.toMatch(/Assign EVERY image/);
    expect(rules).toMatch(/1 = main/);
  });
});

describe('attach_refs', () => {
  it('the owner’s real pattern: 5 photos of a new dog → created, labeled, main first, sheet OFFERED (not drawn)', async () => {
    const images = [1, 2, 3, 4, 5].map((n) => ref(n));
    const { ctx, call, turn } = toolsFor(plannedDoc(), images);
    const out = await call('attach_refs', {
      images: [1, 2, 3, 4, 5],
      owner: { kind: 'character', name: 'Bruno' },
      create: { kind: 'animal', tier: 'support', look: { summary: 'small brown dachshund with a grey muzzle and a red collar' } },
      labels: [
        { image: 1, label: 'side' },
        { image: 2, label: 'face' },
        { image: 4, label: 'full_body', note: 'with his red collar' }
      ],
      main: 2
    });
    expect(out).toMatch(/^Created BRUNO \(support, animal\)\. Added 5 photos to BRUNO \(main: #2 face close-up; labels: #1 side, #2 face close-up, #4 full body\)\./);
    expect(out).toMatch(/No sheet yet — offer "Draw BRUNO's model sheet from these photos · ≈ \$0\.\d\d" \(never draw it unasked\)\./);
    const bruno = ctx.session.doc.cast.find((c) => c.name === 'Bruno')!;
    expect(bruno).toMatchObject({ kind: 'animal', tier: 'support', look: { summary: expect.stringMatching(/dachshund/) } });
    expect(bruno.refs.map((r) => r.path)).toEqual([2, 1, 3, 4, 5].map((n) => ref(n).path));
    expect(bruno.refs[0].label).toBe('face');
    expect(bruno.refs[3]).toMatchObject({ label: 'full_body', note: 'with his red collar' });
    expect(turn.cards).toEqual([expect.objectContaining({ type: 'refs', owner: { kind: 'character', id: bruno.id }, paths: [2, 1, 3, 4, 5].map((n) => ref(n).path) })]);
    expect(turn.captured).toContain('5 photos → BRUNO');
    // Never drew, never gated, never spent.
    expect(ctx.imagesFake.calls).toHaveLength(0);
    expect(opsOf(ctx.events).some((o) => o.op === 'render' || o.op === 'gate' || o.op === 'spend')).toBe(false);
  });

  it('over the cap: adds what fits and says so', async () => {
    const doc = plannedDoc();
    doc.cast[0].refs = Array.from({ length: 10 }, (_, i) => ref(100 + i));
    const { ctx, call } = toolsFor(doc, [1, 2, 3, 4].map((n) => ref(n)));
    const out = await call('attach_refs', { images: [1, 2, 3, 4], owner: { kind: 'character', name: 'maya' } });
    expect(out).toMatch(/^Added 2 of 4 photos to MAYA \(limit 12\)\. MAYA is now at the 12-photo limit\./);
    expect(ctx.session.doc.cast[0].refs).toHaveLength(REF_LIMITS.character);
  });

  it('unknown owner without create → an error listing the cast', async () => {
    const { call } = toolsFor(plannedDoc(), [ref(1)]);
    expect(await call('attach_refs', { images: [1], owner: { kind: 'character', name: 'Bruno' } })).toBe(
      'Error: No character named BRUNO. Cast: MAYA, ARJUN. Pass create:{kind, tier, look} to add them.'
    );
    expect(await call('attach_refs', { images: [3], owner: { kind: 'style' } })).toMatch(/only 1 image this turn \(use 1–1\)/);
  });

  it('a ready sheet is NOT marked stale by an add; the redraw is offered with its price', async () => {
    const doc = plannedDoc();
    const sheet = { path: 'u/user-1/p/proj-1/img/sheet.webp', source: 'generated' as const, at: 5 };
    doc.cast[0].refs = [ref(1)];
    doc.cast[0].sheet = { status: 'ready', asset: sheet, history: [], refPaths: [ref(1).path] };
    const { ctx, call } = toolsFor(doc, [ref(2, { label: 'front' })]);
    const out = await call('attach_refs', { images: [1], owner: { kind: 'character', id: 'c_maya' }, labels: [{ image: 1, label: 'front' }] });
    expect(out).toMatch(/MAYA's sheet was drawn from older photos — offer a redraw with the new ones \(≈ \$0\.\d\d\); it stays as it is until the user asks\./);
    expect(ctx.session.doc.cast[0].sheet).toMatchObject({ status: 'ready', asset: sheet });
  });

  it('places and the style; place creation', async () => {
    const { ctx, call } = toolsFor(plannedDoc(), [ref(1), ref(2), ref(3)]);
    expect(await call('attach_refs', { images: [1], owner: { kind: 'style' }, labels: [{ image: 1, label: 'linework' }] })).toBe(
      'Added 1 photo to the style (labels: #1 linework).'
    );
    expect(await call('attach_refs', { images: [2, 3], owner: { kind: 'place', name: 'Our House' }, create: { description: 'yellow house by a lake' } })).toMatch(
      /^Created the place OUR HOUSE\. Added 2 photos to OUR HOUSE\./
    );
    expect(ctx.session.doc.style.refs[0]).toMatchObject({ label: 'linework' });
    expect(ctx.session.doc.places.find((p) => p.name === 'Our House')).toMatchObject({ look: 'yellow house by a lake' });
  });

  it('carried images resolve next turn ("Images 1–3 are MAYA")', async () => {
    const doc = plannedDoc();
    doc.conversation = [
      { id: 'u1', role: 'user', text: '', at: 1, attachments: [ref(1), ref(2), ref(3)] },
      { id: 'a1', role: 'assistant', text: "Who's in these photos?", at: 2 },
      { id: 'u2', role: 'user', text: 'Images 1–3 are MAYA', at: 3 }
    ];
    const carried = carriedImages(doc, []);
    const ctx = testContext(newSession(doc));
    const turn = createDirectorTurn({ attachments: [], images: carried, userText: 'Images 1–3 are MAYA' });
    const tools = refsToolGroup.tools(ctx, turn);
    expect(refsSummaryLines(ctx.session.doc, turn).join('\n')).toMatch(/UNASSIGNED IMAGES this turn: 1–3 \(1–3 from the user's previous message, still unassigned\)/);
    const out = await tools.find((t) => t.spec.function.name === 'attach_refs')!.execute({ images: [1, 2, 3], owner: { kind: 'character', name: 'Maya' } });
    expect(out).toMatch(/^Added 3 photos to MAYA\./);
    expect(carriedImages(ctx.session.doc, [])).toEqual([]);
  });
});

describe('managing references by position', () => {
  const doc = () => {
    const d = plannedDoc();
    d.cast[0].refs = [ref(1, { label: 'front' }), ref(2), ref(3, { label: 'side' })];
    return d;
  };

  it('set_primary_ref / label_ref', async () => {
    const { ctx, call } = toolsFor(doc());
    expect(await call('set_primary_ref', { owner: { kind: 'character', name: 'Maya' }, ref: 3 })).toMatch(/^MAYA's main reference is now the side photo \(it was #3\)\./);
    expect(ctx.session.doc.cast[0].refs.map((r) => r.path)).toEqual([ref(3).path, ref(1).path, ref(2).path]);
    expect(await call('set_primary_ref', { owner: { kind: 'character', name: 'Maya' }, ref: 1 })).toMatch(/already MAYA's main/);
    expect(await call('label_ref', { owner: { kind: 'character', name: 'Maya' }, items: [{ ref: 3, label: 'outfit', note: 'festival dress' }] })).toBe(
      "Labeled MAYA's references: #3 outfit (note)."
    );
    expect(ctx.session.doc.cast[0].refs[2]).toMatchObject({ label: 'outfit', note: 'festival dress' });
    expect(await call('label_ref', { owner: { kind: 'character', name: 'Maya' }, items: [{ ref: 9, label: 'face' }] })).toMatch(/MAYA has 3 references \(use 1–3\); there is no 9/);
  });

  it('move_ref ("#3 is actually Bruno") creates the destination and keeps metadata', async () => {
    const { ctx, call, turn } = toolsFor(doc());
    const out = await call('move_ref', { from: { kind: 'character', name: 'Maya' }, to: { kind: 'character', name: 'Bruno' }, refs: [3], create: { kind: 'animal' } });
    expect(out).toMatch(/^Created BRUNO \(support, animal\)\. Moved 1 photo from MAYA to BRUNO\./);
    const bruno = ctx.session.doc.cast.find((c) => c.name === 'Bruno')!;
    expect(bruno.refs).toEqual([expect.objectContaining({ path: ref(3).path, label: 'side' })]);
    expect(ctx.session.doc.cast[0].refs).toHaveLength(2);
    expect(turn.cards.some((c) => c.type === 'refs')).toBe(true);
  });

  it('move_ref respects the destination cap honestly', async () => {
    const d = doc();
    d.cast[1].refs = Array.from({ length: 11 }, (_, i) => ref(100 + i));
    const { call } = toolsFor(d);
    expect(await call('move_ref', { from: { kind: 'character', name: 'Maya' }, to: { kind: 'character', name: 'Arjun' }, refs: [1, 2] })).toMatch(
      /Moved 1 photo from MAYA to ARJUN\. 1 photo stayed on MAYA: ARJUN already has 12 photos/
    );
  });

  it('remove_ref', async () => {
    const { ctx, call } = toolsFor(doc());
    expect(await call('remove_ref', { owner: { kind: 'character', name: 'Maya' }, refs: [1, 3] })).toBe('Removed 2 photos from MAYA (1 left).');
    expect(ctx.session.doc.cast[0].refs.map((r) => r.path)).toEqual([ref(2).path]);
  });

  it('summary lines number references per owner with ★ main and the sheet source', () => {
    const d = doc();
    d.cast[0].sheet = { status: 'ready', asset: { path: 'u/x/sheet.webp', source: 'generated', at: 1 }, history: [], refPaths: [ref(1).path, ref(3).path] };
    const lines = refsSummaryLines(d);
    expect(lines[0]).toMatch(/^REFERENCES \(3\/150; ★ = main/);
    // Photo 2 would now go into a redraw too: the summary says so (a hint, never a stale op).
    expect(lines[1]).toBe('- MAYA: 1★ front, 2, 3 side — sheet drawn from 1, 3 (new photos since)');
    d.cast[0].sheet.refPaths = [ref(1).path, ref(2).path, ref(3).path];
    expect(refsSummaryLines(d)[1]).toBe('- MAYA: 1★ front, 2, 3 side — sheet drawn from 1–3');
    d.cast[0].sheet = emptyRender();
    expect(refsSummaryLines(d)[1]).toBe('- MAYA: 1★ front, 2, 3 side — no sheet yet (would use 1–3)');
  });
});
