// Director tool group "reader" (reader.md §7.5, contract §12.2): set_reader_options and set_chapter are
// FREE software settings that commit through the shared validator, never change a spec hash, and
// always answer with an honest sentence (what changed, or why nothing did).
import { describe, expect, it } from 'vitest';
import { DEFAULT_READER, pageSpecHash, readerOf, type ComicDoc } from '../../../../shared/comic/doc.js';
import { newSession, opsOf, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { createDirectorTurn } from '../tools.js';
import { toolGroupById } from './index.js';
import { chaptersOf, describeReader, readerToolGroup } from './reader.js';

const drawnDoc = (): ComicDoc => {
  const doc = plannedDoc();
  doc.pages[0] = {
    ...doc.pages[0],
    render: { status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1, w: 800, h: 1200 }, history: [], specHash: pageSpecHash(doc, doc.pages[0]) }
  };
  return doc;
};

const setup = (doc: ComicDoc = drawnDoc()) => {
  const session = newSession(doc);
  const ctx = testContext(session);
  const turn = createDirectorTurn();
  const tools = () => Object.fromEntries(readerToolGroup.tools(ctx, turn).map((t) => [t.spec.function.name, t]));
  return { session, ctx, turn, tools };
};

describe('registration and gate', () => {
  it('is the registered reader group with two FREE tools', () => {
    expect(toolGroupById('reader')).toBe(readerToolGroup);
    const { ctx, turn, tools } = setup();
    expect(readerToolGroup.when?.(ctx, turn)).toBe(true);
    expect(Object.keys(tools())).toEqual(['set_reader_options', 'set_chapter']);
    for (const t of Object.values(tools())) {
      expect(t.cost).toBe('free');
      expect(t.spec.function.description.startsWith('FREE — ')).toBe(true);
    }
    expect(readerToolGroup.activity).toMatchObject({ set_reader_options: expect.any(String), set_chapter: expect.any(String) });
    expect(readerToolGroup.promptRules?.(drawnDoc())).toMatch(/never the default/);
  });

  it('is off until a page is drawn (nothing to read yet)', () => {
    const s = setup(plannedDoc());
    expect(readerToolGroup.when?.(s.ctx, s.turn)).toBe(false);
  });

  it('summary lines carry only real, non-default settings and chapters', () => {
    const doc = drawnDoc();
    expect(readerToolGroup.summaryLines?.(doc, createDirectorTurn())).toEqual([]);
    doc.reader = { ...DEFAULT_READER, turn: 'slide', credits: 'By Asha' };
    doc.pages[1].chapterTitle = 'The Lake';
    expect(readerToolGroup.summaryLines?.(doc, createDirectorTurn())).toEqual(['Reader: slide turns, credits “By Asha”.', 'Chapters: p2 “The Lake”.']);
    expect(describeReader(DEFAULT_READER)).toEqual([]);
  });
});

describe('set_reader_options', () => {
  it('commits a reader op as a director edit and says exactly what changed', async () => {
    const { tools, session, ctx } = setup();
    const before = session.doc.pages.map((p) => pageSpecHash(session.doc, p));
    const text = await tools().set_reader_options.execute({ turn: 'slide', paperTexture: false, credits: 'Story by the Rao family' });
    expect(text).toMatch(/^Done — readers now get slide page turns; paper texture is off; the End card credits read “Story by the Rao family”\. Free/);
    expect(readerOf(session.doc)).toEqual({ ...DEFAULT_READER, turn: 'slide', paperTexture: false, credits: 'Story by the Rao family' });
    expect(opsOf(ctx.events)).toEqual([{ op: 'reader', patch: { turn: 'slide', paperTexture: false, credits: 'Story by the Rao family' } }]);
    expect(ctx.events.find((e) => e.type === 'ops')).toMatchObject({ origin: 'director' });
    expect(session.doc.pages.map((p) => pageSpecHash(session.doc, p))).toEqual(before);
    expect(session.doc.spend.totalUsd).toBe(0);
  });

  it('clears text with null and reports a no-op honestly', async () => {
    const doc = drawnDoc();
    doc.reader = { ...DEFAULT_READER, dedication: 'For Mia' };
    const { tools, session } = setup(doc);
    expect(await tools().set_reader_options.execute({ dedication: '' })).toMatch(/the dedication is cleared/);
    expect(readerOf(session.doc).dedication).toBeUndefined();
    expect(await tools().set_reader_options.execute({ turn: 'paper' })).toMatch(/already in place — nothing changed/);
  });

  it('returns a fixable error for bad args and never commits', async () => {
    const { tools, ctx } = setup();
    expect(await tools().set_reader_options.execute({ turn: 'spin' })).toMatch(/^Error: Page-turn style must be one of: paper, slide, fade/);
    expect(await tools().set_reader_options.execute({ credits: 'x'.repeat(200) })).toMatch(/^Error: Keep the credits line to 140 characters/);
    expect(opsOf(ctx.events)).toEqual([]);
  });

  it('explains that Guided View is never the default instead of silently doing nothing', async () => {
    const { tools, ctx } = setup();
    expect(await tools().set_reader_options.execute({ guidedDefault: true })).toMatch(/never the default.*one tap/);
    expect(opsOf(ctx.events)).toEqual([]);
    expect(await tools().set_reader_options.execute({ guidedDefault: true, ambient: false })).toMatch(/plain dark[^]*one tap away rather than the default/);
  });

  it('with no arguments, describes the current reader', async () => {
    const { tools } = setup();
    expect(await tools().set_reader_options.execute({})).toMatch(/nothing changed\. Current reader: the defaults/);
  });
});

describe('set_chapter', () => {
  it('marks and clears a chapter start on a page', async () => {
    const { tools, session, ctx } = setup();
    expect(await tools().set_chapter.execute({ page: 2, title: '  Chapter 2:  The Lake ' })).toMatch(/^Done — page 2 now starts the chapter “Chapter 2: The Lake”/);
    expect(session.doc.pages[1].chapterTitle).toBe('Chapter 2: The Lake');
    expect(chaptersOf(session.doc)).toEqual([{ n: 2, title: 'Chapter 2: The Lake' }]);
    expect(await tools().set_chapter.execute({ page: 2, title: 'Chapter 2: The Lake' })).toMatch(/already starts/);
    expect(await tools().set_chapter.execute({ page: 2, title: null })).toMatch(/Removed the chapter mark from page 2/);
    expect(chaptersOf(session.doc)).toEqual([]);
    expect(await tools().set_chapter.execute({ page: 2, title: '' })).toMatch(/has no chapter mark/);
    expect(opsOf(ctx.events).map((o) => o.op)).toEqual(['page', 'page']);
  });

  it('a missing page gets a helpful error listing what exists; long titles are refused, not cut', async () => {
    const { tools, ctx } = setup();
    expect(await tools().set_chapter.execute({ page: 9, title: 'Finale' })).toBe('Error: There is no page 9 — the comic has pages 1–3.');
    expect(await tools().set_chapter.execute({ page: 'x', title: 'Finale' })).toMatch(/^Error: page must be a page number/);
    expect(await tools().set_chapter.execute({ page: 1, title: 'y'.repeat(61) })).toMatch(/^Error: Chapter titles are at most 60 characters \(that one has 61\)/);
    expect(opsOf(ctx.events)).toEqual([]);
  });
});
