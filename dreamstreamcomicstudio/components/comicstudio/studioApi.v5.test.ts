// studioApi v5 wrappers (contract §14.1): owner calls go through apiClient; public edge calls
// carry no credentials or provider keys; uploads send the raw body with the user's token.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS } from '../../shared/comic/capabilities';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postStream: vi.fn(),
  del: vi.fn(),
  patch: vi.fn()
}));

vi.mock('../../services/apiClient', () => api);
vi.mock('../../services/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'tok_123' } } }) } }
}));

import {
  asCaps,
  deleteInboxRef,
  getPublicLibrary,
  getTranslationQuote,
  loadPublicComicBySlug,
  loadStudioProject,
  migrateLegacyRefs,
  publishComic,
  regeneratePublicationLink,
  reportPublicComic,
  stepLibraryRun,
  toStudioApiError,
  trackPublicEvent,
  unpublishComic,
  updatePublication,
  uploadStudioRef
} from './studioApi';

const sampleDoc = { id: 'proj_1', v: 1, createdAt: 1, updatedAt: 1, rev: 1 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('caps', () => {
  it('asCaps merges a partial server answer over DEFAULT_CAPS and rejects junk fields', () => {
    expect(asCaps(undefined)).toBeUndefined();
    expect(asCaps({ plan: 'paid', qualityTiers: ['pro', 'bogus', 'pro'], maxPages: 10_000, ratingCeiling: 'R', admin: 'yes' })).toEqual({
      ...DEFAULT_CAPS,
      plan: 'paid',
      qualityTiers: ['pro'],
      maxPages: DEFAULT_CAPS.maxPages
    });
  });

  it('asCaps keeps the optional usage, history, alternatives and anchor fields the server sends, and nothing malformed', () => {
    const caps = asCaps({
      usage: { governed: true, pctLeft: 140, exhausted: false, pctPerStandardPage: 1.5 },
      history: true,
      maxAlternatives: 3.7,
      anchorKinds: { places: true, props: 'yes', styleKey: true, junk: true }
    });
    expect(caps?.usage).toEqual({ governed: true, pctLeft: 100, exhausted: false, pctPerStandardPage: 1.5 });
    expect(caps?.history).toBe(true);
    expect(caps?.maxAlternatives).toBe(3);
    expect(caps?.anchorKinds).toEqual({ places: true, props: false, styleKey: true, sheetV2: false });
    // Absent or malformed: the field stays absent (off / unknown), exactly as before.
    const bare = asCaps({ usage: { governed: 'x' }, history: 'true', maxAlternatives: 0, anchorKinds: ['places'] });
    expect(bare).toEqual(DEFAULT_CAPS);
    expect(asCaps({ maxAlternatives: 99 })?.maxAlternatives).toBe(5);
  });

  it('loadStudioProject returns caps only when the server sends them', async () => {
    api.get.mockResolvedValueOnce({ doc: sampleDoc, urls: {} });
    expect(await loadStudioProject('proj_1')).not.toHaveProperty('caps');
    api.get.mockResolvedValueOnce({ doc: sampleDoc, urls: {}, caps: { plan: 'admin', admin: true } });
    expect((await loadStudioProject('proj_1')).caps).toMatchObject({ plan: 'admin', admin: true });
  });

  it('maps 501 to not_available', () => {
    const e = toStudioApiError({ status: 501, message: 'Not Implemented' });
    expect(e.kind).toBe('not_available');
    expect(e.message).toBe("That isn't available yet.");
  });
});

describe('owner endpoints', () => {
  it('uploads a ref as a raw body with the bearer token and parses 201', async () => {
    const ref = { path: 'u/x/p/ref/r1.webp', source: 'upload', at: 1 };
    fetchMock.mockResolvedValueOnce(json({ ref, rev: 9, ops: [{ op: 'ref_add' }, 'junk'], urls: { [ref.path]: 'https://s/r1' }, notice: { kind: 'near_duplicate', of: 'u/x/p/ref/r0.webp' } }, 201));
    const file = new Blob(['img'], { type: 'image/webp' });
    const out = await uploadStudioRef('proj 1', file, { to: { kind: 'character', id: 'c_maya' }, label: 'face', name: 'maya.webp', index: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/comic/projects/proj%201/refs?to=character%3Ac_maya&label=face&name=maya.webp&index=0');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({ 'Content-Type': 'image/webp', Authorization: 'Bearer tok_123' });
    expect(out).toEqual({ ref, rev: 9, ops: [{ op: 'ref_add' }], urls: { [ref.path]: 'https://s/r1' }, notice: { kind: 'near_duplicate', of: 'u/x/p/ref/r0.webp' } });
  });

  it('upload errors keep the server wording (409 LIMIT)', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'Maya already has 12 reference photos.' } }, 409));
    await expect(uploadStudioRef('p', new Blob(['x']), { to: { kind: 'inbox' } })).rejects.toMatchObject({
      kind: 'conflict',
      message: 'Maya already has 12 reference photos.'
    });
  });

  it('hits the right paths and methods', async () => {
    api.del.mockResolvedValue({});
    api.get.mockResolvedValue({ perLanguage: [{ lang: 'te', lines: 3, free: 0, upToDate: false, usd: 0.01, seconds: 4 }], usd: 0.01, byok: false });
    api.post.mockResolvedValue({ publication: { visibility: 'unlisted', status: 'live' } });
    api.patch.mockResolvedValue({ visibility: 'public', status: 'live' });

    await deleteInboxRef('p1', 'u/x/p/ref/a b.webp');
    expect(api.del).toHaveBeenCalledWith('/api/comic/projects/p1/refs?owner=inbox&path=u%2Fx%2Fp%2Fref%2Fa%20b.webp', {});

    const quote = await getTranslationQuote('p1', ['te', 'hi', 'te']);
    expect(api.get).toHaveBeenCalledWith('/api/comic/projects/p1/translation-quote?langs=te%2Chi', {});
    expect(quote.usd).toBe(0.01);

    expect(await publishComic('p1', { visibility: 'unlisted' })).toEqual({ visibility: 'unlisted', status: 'live' });
    expect(api.post).toHaveBeenCalledWith('/api/comic/projects/p1/publication', { visibility: 'unlisted' }, {});
    expect(await updatePublication('p1', { visibility: 'public' })).toMatchObject({ visibility: 'public' });
    expect(api.patch).toHaveBeenCalledWith('/api/comic/projects/p1/publication', { visibility: 'public' }, {});
    await unpublishComic('p1');
    expect(api.del).toHaveBeenLastCalledWith('/api/comic/projects/p1/publication', {});
    await regeneratePublicationLink('p1');
    expect(api.post).toHaveBeenLastCalledWith('/api/comic/projects/p1/publication/regenerate', {}, {});

    await stepLibraryRun('run_1', 9);
    expect(api.post).toHaveBeenLastCalledWith('/api/comic/admin/library/runs/run_1/step', { n: 3 }, {});
    await migrateLegacyRefs({ dryRun: true, limit: 50 });
    expect(api.post).toHaveBeenLastCalledWith('/api/comic/admin/storage/migrate-refs', { dryRun: true, limit: 10 }, {});
  });

  it('a stub router (501) reads as not_available', async () => {
    api.post.mockRejectedValueOnce({ status: 501, message: 'NOT_AVAILABLE' });
    await expect(publishComic('p1', { visibility: 'public' })).rejects.toMatchObject({ kind: 'not_available' });
  });
});

describe('public edge endpoints', () => {
  it('loads a slug without credentials or provider keys', async () => {
    fetchMock.mockResolvedValueOnce(json({ publication: { slug: 'abcdefghijklmnopq', languages: ['en'] }, doc: sampleDoc, urls: { a: 'https://x/a' } }));
    const out = await loadPublicComicBySlug('abcdefghijklmnopq');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/comic/public/s/abcdefghijklmnopq');
    expect(init.credentials).toBe('omit');
    expect(JSON.stringify(init.headers)).not.toMatch(/Authorization|Key/i);
    expect(out.publication.slug).toBe('abcdefghijklmnopq');
    expect(out.doc.id).toBe('proj_1');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('an unknown slug is the public not-found message', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'Not found' } }, 404));
    await expect(loadPublicComicBySlug('zzzzzzzzzzzzzzzzz')).rejects.toMatchObject({ kind: 'not_found', message: expect.stringMatching(/isn't published/) });
  });

  it('trackPublicEvent is fire-and-forget with keepalive and never throws', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await trackPublicEvent('abcdefghijklmnopq', { type: 'view', channel: 'qr', lang: 'te' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/comic/public/s/abcdefghijklmnopq/event');
    expect(JSON.parse(init.body)).toEqual({ type: 'view', channel: 'qr', lang: 'te' });
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('omit');

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(trackPublicEvent('abcdefghijklmnopq', { type: 'complete' })).resolves.toBeUndefined();
  });

  it('a signed-in report carries the bearer token (weight 1), still no cookies or provider keys', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await reportPublicComic('abcdefghijklmnopq', { reason: 'violent', pageN: 2 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/comic/public/s/abcdefghijklmnopq/report');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok_123', 'Content-Type': 'application/json' });
    expect(JSON.stringify(init.headers)).not.toMatch(/x-.*key/i);
    expect(JSON.parse(init.body)).toEqual({ reason: 'violent', pageN: 2 });
  });

  it('getTranslationQuote sends an optional page/line scope (sanitised) and force', async () => {
    api.get.mockResolvedValue({ perLanguage: [], usd: 0.002, byok: false });
    await getTranslationQuote('p1', ['te'], { lineIds: ['pg_1_l1', 'pg_1_l1', 'bad id!', 'pg_1_l2'], pageIds: ['pg_1'], force: true });
    expect(api.get).toHaveBeenLastCalledWith('/api/comic/projects/p1/translation-quote?langs=te&pageIds=pg_1&lineIds=pg_1_l1%2Cpg_1_l2&force=1', {});
  });

  it('a restricted-account refusal (FORBIDDEN) reads as calm copy, never the code', () => {
    const e = toStudioApiError({ status: 403, message: 'FORBIDDEN', details: { error: { code: 'FORBIDDEN', message: 'FORBIDDEN' } } }, 'project');
    expect(e.kind).toBe('forbidden');
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toBe("Your account can't do that right now. You can keep reading and editing your comic.");
    expect(e.message).not.toMatch(/FORBIDDEN|review|moderat/i);
  });

  it("a FORBIDDEN with the server's own calm text keeps it (restricted accounts, someone else's comic)", () => {
    const limited = 'Your account is limited right now, so publishing is paused. You can still read and edit your comic.';
    const e = toStudioApiError({ status: 403, message: limited, details: { error: { code: 'FORBIDDEN', message: limited } } }, 'project');
    expect(e.message).toBe(limited);
    const other = toStudioApiError({ status: 403, message: "You don't have access to this comic.", details: { error: { code: 'FORBIDDEN', message: "You don't have access to this comic." } } }, 'project');
    expect(other.message).toBe("You don't have access to this comic.");
  });

  it('reports return on 202; the library never fails the UI', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await expect(reportPublicComic('abcdefghijklmnopq', { reason: 'other', note: 'x' })).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(json({ error: { message: 'boom' } }, 500));
    expect(await getPublicLibrary()).toEqual({ manifestVersion: 0, generatedAt: 0, assets: [] });
  });
});
