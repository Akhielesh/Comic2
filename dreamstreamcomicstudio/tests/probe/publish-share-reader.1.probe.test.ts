// @vitest-environment node
// Probes (publish-share-reader, server side):
//  1. The owner view's readiness only lists the languages ALREADY published (or the source), so a
//     finished translation never appears as publishable — the Share sheet's PublishPanel greys the
//     chip out as "not ready" (PublishPanel.tsx:79,120) and the edition can't be ticked.
//  2. The Share sheet's "Update" (ShareSheet.tsx:194) republishes with `{ visibility, languages }` only:
//     a page the owner excluded on the first publish (consented exclusion of a blocked page) is sent
//     again, the gate blocks it (blocked stays blocked), and the update is refused with SAFETY_BLOCKED.
//  3. With the Supabase store the first publish's snapshot id is a random UUID (rowToDb never writes
//     `id`, the DB mints its own); the next update uses the DB id, so `doc.id` of the public snapshot
//     changes once — readers' resume position and the once-per-session intro are keyed on it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRef, ComicDoc, RenderState } from '../../shared/comic/doc.js';
import { editionReadiness, lineSourceHash } from '../../shared/comic/i18n.js';
import type { SafetyStatus } from '../../shared/comic/safety.js';
import { fakeAssetStore, newSession, plannedDoc, testContext, type FakeAssetStore, type TestContext } from '../../server/src/comic/orchestrator.fakes.js';
import type { StudioSession } from '../../server/src/comic/session.js';
import type { PublishGateResult } from '../../server/src/comic/safety/index.js';
import { getPublicationView, publish } from '../../server/src/comic/publication/index.js';
import { __resetPublishBudget, configurePublication, publishWithOutcome } from '../../server/src/comic/publication/publication.js';
import { createMemoryPublicationStore, rowToDb, type MemoryPublicationStore } from '../../server/src/comic/publication/store.js';

const USER = 'user-1';

const asset = (name: string, extra: Partial<AssetRef> = {}): AssetRef => ({
  path: `u/${USER}/p/proj-1/img/${name}.webp`,
  w: 1024,
  h: 1536,
  source: 'generated',
  at: 1,
  safety: { assessed: 'G', at: 1, by: 'qc' },
  variants: [
    { path: `u/${USER}/p/proj-1/img/${name}_w480.webp`, w: 480, h: 720 },
    { path: `u/${USER}/p/proj-1/img/${name}_w1080.webp`, w: 1080, h: 1620 }
  ],
  ...extra
});

const ready = (name: string, extra: Partial<AssetRef> = {}): RenderState => ({ status: 'ready', asset: asset(name, extra), history: [] });

/** plannedDoc with every page + the cover drawn by the server (publishable as is). */
const drawnDoc = (): ComicDoc => {
  const doc = plannedDoc('proj-1');
  doc.pages = doc.pages.map((p) => ({ ...p, render: ready(`p${p.n}`) }));
  doc.cover = { title: 'Spice Run', tagline: 'Hot on the trail', render: ready('cover') };
  doc.planStatus = 'approved';
  return doc;
};

/** A complete, reviewed Hindi edition (the shape publication.test.ts uses for a publishable edition). */
const withHindi = (doc: ComicDoc): ComicDoc => {
  doc.format = { ...doc.format, lettering: 'overlay' };
  const lines = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).filter((l) => l.text.trim());
  const translated = Object.fromEntries(lines.map((l) => [l.id, { text: `HI:${l.text}`, status: 'reviewed' as const, sourceHash: lineSourceHash(l), at: 1 }]));
  doc.i18n = { editions: { hi: { lang: 'hi', lines: translated, balloons: {}, register: 'everyday' } }, glossary: [] };
  return doc;
};

const gateFor =
  (statuses: Record<string, SafetyStatus> = {}) =>
  async (_ctx: unknown, _doc: ComicDoc, opts: { pageIds: string[]; includeCover: boolean }): Promise<PublishGateResult> => {
    const pages = Object.fromEntries(opts.pageIds.map((id) => [id, { status: statuses[id] ?? 'pass', reasons: statuses[id] === 'blocked' ? ['violence'] : [] }]));
    const anyBad = Object.values(pages).some((p) => p.status === 'blocked');
    return {
      status: anyBad ? 'blocked' : 'cleared',
      rating: 'PG',
      pages,
      cover: opts.includeCover ? { status: 'pass', reasons: [] } : null,
      text: { status: 'pass', reasons: [] },
      checkedHash: 'h1',
      costUsd: 0
    } as PublishGateResult;
  };

const fakeOg = async () => ({ jpeg: Buffer.from('fake-jpeg'), w: 1200 as const, h: 630 as const, themeColor: '#123456' });

let store: MemoryPublicationStore;
let ctx: TestContext;
let session: StudioSession;
let assets: FakeAssetStore;
let restore: (() => void) | undefined;
let clock = 1_800_000_000_000;

const setup = (doc: ComicDoc, statuses: Record<string, SafetyStatus> = {}) => {
  session = newSession(doc);
  assets = fakeAssetStore();
  ctx = testContext(session, { assets });
  store = createMemoryPublicationStore();
  store.seedProject(doc.id, USER);
  restore?.();
  restore = configurePublication({ store, gate: gateFor(statuses) as never, now: () => clock, renderOg: fakeOg, publicUrl: (p) => `https://cdn.test/${p}` });
};

beforeEach(() => {
  __resetPublishBudget();
  clock += 3_600_000;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  restore?.();
  vi.restoreAllMocks();
});

describe('owner view readiness vs. the Share sheet language chips', () => {
  it('a finished (reviewed, current) Hindi edition is listed as publishable in the owner view before AND after a source-only publish', async () => {
    const doc = withHindi(drawnDoc());
    expect(editionReadiness(doc, 'hi').publishable).toBe(true); // precondition: publish() would accept it
    setup(doc);
    const before = await getPublicationView(ctx);
    // PublishPanel.tsx:79 only enables chips whose lang is in readiness.languages with publishable:true.
    expect(before.readiness.languages.map((l) => l.lang)).toContain('hi');

    await publish(ctx, { visibility: 'unlisted', languages: ['en'] });
    const after = await getPublicationView(ctx);
    expect(after.readiness.languages.map((l) => l.lang)).toContain('hi');
  });
});

describe('Share sheet "Update" after a consented page exclusion', () => {
  it('the exact request ShareSheet.updateNow sends ({ visibility, languages }) keeps the published version updatable', async () => {
    const doc = drawnDoc();
    doc.pages[2].render = ready('p3', { safety: { assessed: 'X', at: 1, categories: ['graphic_gore'] } });
    setup(doc, { pg_3: 'blocked' });
    // First publish: the owner taps "Publish without page 3" (PublishPanel request(blocked)).
    const first = await publishWithOutcome(ctx, { visibility: 'unlisted', excludePageIds: ['pg_3'] });
    expect(first.view.status).toBe('live');
    expect(store.rpcPayload(first.view.slug!)!.doc!.pages.map((p) => p.n)).toEqual([1, 2]);

    // The owner edits the logline → the sheet shows "You've made changes since publishing … Update".
    session.commit([{ op: 'brief', patch: { logline: 'A courier races through a spice market — now with a twist.' } }], { origin: 'user' });
    const view = await getPublicationView(ctx);
    expect(view.behind).toBe(true);

    // ShareSheet.tsx:194 — updateNow republishes with visibility + languages only (no excludePageIds).
    const update = publish(ctx, { visibility: view.visibility === 'public' ? 'public' : 'unlisted', languages: view.languages });
    await expect(update).resolves.toMatchObject({ status: 'live', publishedRev: session.doc.rev });
  });
});

describe('public snapshot id across publishes (Supabase semantics: the DB mints the row id)', () => {
  it('rowToDb never writes `id`, so the first publish stores a snapshot id the DB row does not have; the next update rewrites doc.id', async () => {
    const doc = drawnDoc();
    setup(doc);
    // Supabase: insert ignores the row's id (comic_publications.id default gen_random_uuid()).
    const original = store.upsert.bind(store);
    let minted = 0;
    store.upsert = async (row) => original({ ...row, id: store.rows.get(row.projectId)?.id ?? `db-${(minted += 1)}` });
    const first = await publish(ctx, { visibility: 'unlisted' });
    const firstDoc = store.rpcPayload(first.slug!)!.doc!;
    const storedRow = store.rows.get('proj-1')!;
    expect(Object.keys(rowToDb(storedRow))).not.toContain('id'); // what reaches Postgres
    // A reader's resume position / intro memory is keyed on doc.id (readerPrefs posKey/introKey).
    session.commit([{ op: 'brief', patch: { logline: 'edited' } }], { origin: 'user' });
    const second = await publish(ctx, { visibility: 'unlisted' });
    const secondDoc = store.rpcPayload(second.slug!)!.doc!;
    expect(secondDoc.id).toBe(firstDoc.id);
  });
});
