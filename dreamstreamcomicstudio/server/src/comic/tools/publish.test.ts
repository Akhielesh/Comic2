// @vitest-environment node
// Director publish tools never act (sharing.md §11 #36) + the publish actions (card lifecycle).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { fakeAssetStore, newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { createDirectorTurn } from '../tools.js';
import * as publication from '../publication/publication.js';
import { createMemoryPublicationStore } from '../publication/store.js';
import { PUBLISH_ACTIONS } from '../actions/publish.js';
import { publicationSummary, publishToolGroup } from './publish.js';
import { configureSafety } from '../safety/deps.js';
import { installSafetyFakes, resetSafety } from '../safety/testkit.js';

const drawn = (): ComicDoc => {
  const doc = plannedDoc('proj-1');
  doc.pages = doc.pages.map((p) => ({
    ...p,
    render: { status: 'ready', history: [], asset: { path: `u/user-1/p/proj-1/img/p${p.n}.webp`, source: 'generated', at: 1, w: 800, h: 1200, safety: { assessed: 'G', at: 1 } } }
  }));
  return doc;
};

const toolsFor = (doc: ComicDoc) => {
  const session = newSession(doc);
  const ctx = testContext(session);
  const turn = createDirectorTurn();
  const tools = Object.fromEntries(publishToolGroup.tools(ctx, turn).map((t) => [t.spec.function.name, t]));
  return { ctx, turn, tools };
};

afterEach(() => vi.restoreAllMocks());

describe('publish tool group', () => {
  it('is offered only once a page is drawn (or a publication exists), all tools FREE', () => {
    const undrawn = newSession(plannedDoc('p0'));
    expect(publishToolGroup.when!(testContext(undrawn), createDirectorTurn())).toBe(false);
    const { ctx, tools } = toolsFor(drawn());
    expect(publishToolGroup.when!(ctx, createDirectorTurn())).toBe(true);
    expect(Object.keys(tools).sort()).toEqual(['get_share_link', 'publish_comic', 'unpublish_comic', 'update_publication']);
    for (const t of Object.values(tools)) {
      expect(t.cost).toBe('free');
      expect(t.spec.function.description.startsWith('FREE — ')).toBe(true);
    }
    expect(publishToolGroup.promptRules!(drawn())).toContain('Never say a comic is published');
  });

  it('publish_comic NEVER publishes: it posts a pending card and says so', async () => {
    const spy = vi.spyOn(publication, 'publish');
    const spy2 = vi.spyOn(publication, 'publishWithOutcome');
    const { tools, turn } = toolsFor(drawn());
    const text = await tools.publish_comic.execute({ visibility: 'unlisted' });
    expect(spy).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
    expect(turn.cards).toEqual([expect.objectContaining({ type: 'publish', mode: 'publish', status: 'pending', request: { visibility: 'unlisted' } })]);
    expect(text).toMatch(/3\/3 pages drawn/);
    expect(text).toMatch(/NOT published yet/);
  });

  it('publish_comic refuses bad args and unknown editions honestly', async () => {
    const { tools, turn } = toolsFor(drawn());
    expect(await tools.publish_comic.execute({ visibility: 'everyone' })).toMatch(/^Error: visibility/);
    expect(await tools.publish_comic.execute({ visibility: 'public', languages: ['te'] })).toMatch(/No Telugu edition exists yet/);
    expect(turn.cards).toHaveLength(0);
  });

  it('get_share_link: honest when unpublished; the canonical comics link when live', async () => {
    const { tools } = toolsFor(drawn());
    expect(await tools.get_share_link.execute({})).toMatch(/^Not published yet — offer publish_comic/);
    const doc = drawn();
    doc.publication = { visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nP', publishedRev: 4, publishedAt: Date.now(), languages: ['en'] };
    const live = toolsFor(doc);
    const text = await live.tools.get_share_link.execute({ page: 2 });
    expect(text).toContain('https://comics.dreamstreamstudio.ai/c/Ab3dEf6hIj9kLm2nP?p=2');
    expect(live.turn.cards).toEqual([expect.objectContaining({ type: 'share' })]);
    expect(await live.tools.get_share_link.execute({ language: 'hi' })).toMatch(/edition isn't published/);
  });

  it('publish_comic only names the editions it would publish as blockers (readiness lists every edition the doc holds)', async () => {
    const doc = drawn();
    doc.format = { ...doc.format, lettering: 'overlay' };
    doc.i18n = { editions: { hi: { lang: 'hi', lines: {}, balloons: {}, register: 'everyday' } }, glossary: [] };
    const { tools } = toolsFor(doc);
    const sourceOnly = await tools.publish_comic.execute({ visibility: 'unlisted' });
    expect(sourceOnly).not.toMatch(/Hindi/);
    expect(sourceOnly).toMatch(/NOT published yet/);
    const withHindi = await tools.publish_comic.execute({ visibility: 'unlisted', languages: ['en', 'hi'] });
    expect(withHindi).toMatch(/Heads-up: Hindi: /);
  });

  it('unpublish_comic posts a confirmation card; update_publication can only offer a new link via a card', async () => {
    const doc = drawn();
    doc.publication = { visibility: 'public', status: 'live', slug: 'Ab3dEf6hIj9kLm2nP', publishedRev: 4, publishedAt: Date.now(), languages: ['en'] };
    const { tools, turn } = toolsFor(doc);
    expect(await tools.unpublish_comic.execute({})).toMatch(/keeps working until the user confirms/);
    expect(await tools.update_publication.execute({ regenerate_link: true })).toMatch(/until the user confirms/);
    expect(turn.cards.map((c) => (c.type === 'publish' ? c.mode : c.type))).toEqual(['unpublish', 'regenerate']);
    expect(publicationSummary(doc)[0]).toMatch(/^Published: public · \/c\/Ab3…/);
    expect(publicationSummary(doc)[0]).not.toContain('Ab3dEf6hIj9kLm2nP');
  });
});

// P2-GATE: the doc mirror keeps saying 'suspended' after a moderator lifts a hold (the row stays
// suspended until the owner republishes). The REST/UI publish checks the live hold flag
// (publishWithOutcome → projectFlags), so the director must too — never the mirror alone.
describe('publish_comic after a moderation pause', () => {
  const suspendedDoc = (): ComicDoc => {
    const doc = drawn();
    doc.publication = { visibility: 'unlisted', status: 'suspended', slug: 'Ab3dEf6hIj9kLm2nP', publishedRev: 4, publishedAt: Date.now(), languages: ['en'] };
    return doc;
  };
  afterEach(() => resetSafety());

  it('while the hold is on: refuses, shows no card', async () => {
    const fakes = installSafetyFakes();
    fakes.store.projects.set('proj-1', { ownerUserId: 'user-1', isForcedPrivate: true });
    const { tools, turn } = toolsFor(suspendedDoc());
    expect(await tools.publish_comic.execute({ visibility: 'unlisted' })).toMatch(/paused by moderation/);
    expect(turn.cards).toEqual([]);
  });

  it('once a moderator lifted the hold: offers the Publish card like the Share sheet does (a fresh publish, not an update)', async () => {
    const fakes = installSafetyFakes();
    fakes.store.projects.set('proj-1', { ownerUserId: 'user-1', isForcedPrivate: false });
    const { tools, turn } = toolsFor(suspendedDoc());
    const text = await tools.publish_comic.execute({ visibility: 'unlisted' });
    expect(text).toMatch(/Publish card shown/);
    expect(text).toMatch(/NOT published yet/);
    expect(turn.cards).toEqual([expect.objectContaining({ type: 'publish', mode: 'publish', status: 'pending', request: { visibility: 'unlisted' } })]);
    // The summary no longer forbids the offer outright: publish_comic itself checks the hold.
    expect(publicationSummary(suspendedDoc())[0]).toMatch(/publish_comic.*checks/);
    // publishWithOutcome keeps a suspended row's slug (only the asset key is fresh), so nothing here may
    // promise the user a NEW link — the director would repeat it.
    expect(publicationSummary(suspendedDoc())[0]).not.toMatch(/new link/i);
    expect(publicationSummary(suspendedDoc())[0]).toMatch(/same link/i);
    expect(text).not.toMatch(/new link/i);
  });

  it("can't tell (lookup failed, no row, someone else's project): stays refused, honestly", async () => {
    const fakes = installSafetyFakes();
    configureSafety({
      store: Object.assign(Object.create(fakes.store), {
        projectInfo: async () => {
          throw Object.assign(new Error('connection failure'), { code: '08006' });
        }
      })
    });
    const failing = toolsFor(suspendedDoc());
    expect(await failing.tools.publish_comic.execute({ visibility: 'unlisted' })).toMatch(/couldn.t check/i);
    expect(failing.turn.cards).toEqual([]);

    const none = installSafetyFakes();
    const missing = toolsFor(suspendedDoc());
    expect(await missing.tools.publish_comic.execute({ visibility: 'unlisted' })).toMatch(/couldn.t check/i);
    none.store.projects.set('proj-1', { ownerUserId: 'someone-else', isForcedPrivate: false });
    expect(await missing.tools.publish_comic.execute({ visibility: 'unlisted' })).toMatch(/couldn.t check/i);
    expect(missing.turn.cards).toEqual([]);
  });
});

describe('publish actions (the user tap)', () => {
  it('publish: card pending → done with the link, a success message, and failures stay honest', async () => {
    const doc = drawn();
    doc.conversation = [{ id: 'm1', role: 'assistant', text: 'Ready?', at: 1, cards: [{ type: 'publish', id: 'card-1', mode: 'publish', status: 'pending', request: { visibility: 'unlisted' } }] }];
    const session = newSession(doc);
    const ctx = testContext(session, { assets: fakeAssetStore() });
    const store = createMemoryPublicationStore();
    store.seedProject('proj-1', 'user-1');
    const gate = async (_c: unknown, _d: ComicDoc, o: { pageIds: string[]; includeCover: boolean }) => ({
      status: 'cleared' as const,
      rating: 'PG' as const,
      pages: Object.fromEntries(o.pageIds.map((id) => [id, { status: 'pass' as const, reasons: [] }])),
      cover: null,
      text: { status: 'pass' as const, reasons: [] },
      checkedHash: '',
      costUsd: 0
    });
    const restore = publication.configurePublication({ store, gate, renderOg: async () => ({ jpeg: Buffer.from('x'), w: 1200, h: 630, themeColor: '#000000' }), publicUrl: (p) => `https://cdn.test/${p}` });
    publication.__resetPublishBudget();
    try {
      const handler = PUBLISH_ACTIONS.find((h) => h.type === 'publish')!;
      const started = await handler.run(ctx, { type: 'publish', cardId: 'card-1', request: { visibility: 'unlisted' } }, { confirmed: true });
      expect(started.outcome.status).toBe('done');
      const card = ctx.session.doc.conversation[0].cards![0];
      expect(card).toMatchObject({ status: 'done', result: { url: expect.stringMatching(/^https:\/\/comics\.dreamstreamstudio\.ai\/c\/[A-Za-z0-9]{17}$/) } });
      const last = ctx.session.doc.conversation.at(-1)!;
      expect(last.role).toBe('assistant');
      expect(last.text).toMatch(/^Published!/);

      // Decline only marks the card.
      const decline = PUBLISH_ACTIONS.find((h) => h.type === 'decline_publish')!;
      await decline.run(ctx, { type: 'decline_publish', cardId: 'card-1' }, { confirmed: false });
      expect(ctx.session.doc.conversation[0].cards![0]).toMatchObject({ status: 'declined' });

      // A refusal marks the card failed with the honest reason.
      store.forcePrivate('proj-1');
      const again = await handler.run(ctx, { type: 'publish', cardId: 'card-1', request: { visibility: 'public' } }, { confirmed: true });
      expect(again.outcome.status).toBe('blocked');
      expect(ctx.session.doc.conversation[0].cards![0]).toMatchObject({ status: 'failed', result: { error: expect.stringMatching(/paused by DreamStream moderation/) } });
    } finally {
      restore();
    }
  });

  it('publish: a cover the safety check blocks is left out AND the owner is told so', async () => {
    const doc = drawn();
    doc.cover = { title: 'Spice Run', render: { status: 'ready', history: [], asset: { path: 'u/user-1/p/proj-1/img/cover.webp', source: 'generated', at: 1, w: 800, h: 1200 } } };
    const session = newSession(doc);
    const ctx = testContext(session, { assets: fakeAssetStore() });
    const store = createMemoryPublicationStore();
    store.seedProject('proj-1', 'user-1');
    const gate = async (_c: unknown, _d: ComicDoc, o: { pageIds: string[]; includeCover: boolean }) => ({
      status: 'cleared' as const,
      rating: 'PG' as const,
      pages: Object.fromEntries(o.pageIds.map((id) => [id, { status: 'pass' as const, reasons: [] }])),
      cover: { status: 'blocked' as const, reasons: ['violence'] },
      text: { status: 'pass' as const, reasons: [] },
      checkedHash: '',
      costUsd: 0
    });
    const restore = publication.configurePublication({ store, gate, renderOg: async () => ({ jpeg: Buffer.from('x'), w: 1200, h: 630, themeColor: '#000000' }), publicUrl: (p) => `https://cdn.test/${p}` });
    publication.__resetPublishBudget();
    try {
      const handler = PUBLISH_ACTIONS.find((h) => h.type === 'publish')!;
      const started = await handler.run(ctx, { type: 'publish', request: { visibility: 'unlisted' } }, { confirmed: true });
      expect(started.outcome.status).toBe('done');
      expect(ctx.session.doc.conversation.at(-1)!.text).toMatch(/cover didn’t pass the content check/);
      expect(store.rows.get('proj-1')!.snapshot!.cover.render.asset).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('update_publication tells the director that Update republishes the current version', async () => {
    const doc = drawn();
    doc.publication = { visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nP', publishedRev: 4, publishedAt: Date.now(), languages: ['en'] };
    const { tools, turn } = toolsFor(doc);
    expect(await tools.update_publication.execute({ allow_download: false })).toMatch(/edits made since publishing go live too/);
    expect(turn.cards).toMatchObject([{ type: 'publish', mode: 'update', request: { visibility: 'unlisted', allowDownload: false } }]);
  });
});
