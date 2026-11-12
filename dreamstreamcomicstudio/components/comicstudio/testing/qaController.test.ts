// Unit tests for the QA harness controller and fixtures (P1-QA). The Playwright harness relies on
// these being deterministic, fully normalized and honest recorders of every call.

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeDoc, type Card } from '../../../shared/comic/doc';
import { checkPagePlan } from '../../../shared/comic/pagePlanCheck';
import { quoteRenderPages } from '../../../shared/comic/plan';
import { noticeChipState, noticeChips } from '../conversation/cards/NoticeCard';
import { QA_FIXTURES, QA_PUBLICATION_SLUG, makeQaDoc, parseQaImagePath, qaAsset, qaImagePath, qaImagePaths, qaPageSize } from './qaFixtures';
import { SLUG_RE } from '../../../shared/comic/publication';
import { clearQaOps, makeQaUrlFor, parseQaParams, qaDocFromParams, qaImageUrl, qaOps, qaSceneFromParams, recordQaOp, useQaController } from './qaController';
import { OPEN_MODEL_PICKER_EVENT } from '../models/openPicker';

const setDpr = (v: number) => Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: v });

afterEach(() => {
  clearQaOps();
  setDpr(1);
});

describe('parseQaParams', () => {
  it('defaults to the studio on the heist fixture, SVG images when not under a webdriver', () => {
    const p = parseQaParams('');
    expect(p).toMatchObject({ surface: 'studio', fixture: 'heist-12p', tab: 'pages', page: null, theme: 'light', state: 'idle', mode: 'easy', rtl: false, publicResult: 'ok', img: 'svg', still: false });
    expect(parseQaParams('', { webdriver: true }).img).toBe('png');
  });

  it('reads every documented parameter and rejects junk', () => {
    const p = parseQaParams('?surface=editor&fixture=deep-40p&tab=cast&page=7&lang=te&theme=dark&state=streaming&mode=pro&rtl=1&public=not-found&img=png&still=1');
    expect(p).toEqual({ surface: 'editor', fixture: 'deep-40p', tab: 'cast', page: 7, lang: 'te', theme: 'dark', state: 'streaming', mode: 'pro', rtl: true, publicResult: 'not-found', img: 'png', still: true, kit: null, allowDownload: true, share: false, live: null, history: false, variants: true });
    const bad = parseQaParams('?surface=admin&fixture=../../etc&tab=x&page=-3&lang=<script>&state=boom&kit=<img src=x>');
    expect(bad).toMatchObject({ surface: 'studio', fixture: 'heist-12p', tab: 'pages', page: null, lang: null, state: 'idle', kit: null });
    expect(parseQaParams('?surface=kit&kit=refs-drawer')).toMatchObject({ surface: 'kit', kit: 'refs-drawer' });
    expect(parseQaParams('?surface=reader&download=0').allowDownload).toBe(false);
    expect(parseQaParams('?surface=reader&share=1').share).toBe(true);
    expect(parseQaParams('?surface=reader&share=yes').share).toBe(false);
    expect(parseQaParams('?p=4').page).toBe(4);
  });
});

describe('variants=0 (pages and cover stored without variants, RD-A #12)', () => {
  it('only an exact `variants=0` turns the variants off', () => {
    expect(parseQaParams('?surface=reader&variants=0').variants).toBe(false);
    for (const q of ['', '?surface=reader', '?variants=1', '?variants=no', '?variants=']) expect(parseQaParams(q).variants, q).toBe(true);
  });

  it('strips asset.variants from every page and the cover of the chosen fixture; sheets and the style board keep theirs', () => {
    const plain = qaDocFromParams(parseQaParams('?fixture=heist-12p'));
    const bare = qaDocFromParams(parseQaParams('?fixture=heist-12p&variants=0'));
    const drawn = (d: typeof plain) => d.pages.filter((p) => p.render.asset);
    expect(drawn(plain).length).toBeGreaterThan(3);
    expect(drawn(plain).every((p) => (p.render.asset?.variants?.length ?? 0) > 0)).toBe(true);
    expect(drawn(bare).map((p) => p.id)).toEqual(drawn(plain).map((p) => p.id));
    expect(drawn(bare).filter((p) => p.render.asset && 'variants' in p.render.asset)).toEqual([]);
    expect(plain.cover.render.asset?.variants?.length).toBeGreaterThan(0);
    expect(bare.cover.render.asset && 'variants' in bare.cover.render.asset).toBe(false);
    // Everything else, the originals included, is the same fixture.
    expect(bare.cast).toEqual(plain.cast);
    expect(bare.style).toEqual(plain.style);
    expect(drawn(bare).map((p) => p.render.asset?.path)).toEqual(drawn(plain).map((p) => p.render.asset?.path));
    expect(qaImagePaths(bare).filter((path) => /-p\d+-480x/.test(path))).toEqual([]);
  });

  it('every surface builds its doc through it: the scene (studio, board, editor, readers) has no page variants', () => {
    const scene = qaSceneFromParams(parseQaParams('?surface=reader&fixture=heist-12p&page=1&variants=0'));
    expect(scene.doc?.pages.some((p) => p.render.asset?.variants)).toBe(false);
    expect(qaSceneFromParams(parseQaParams('?surface=reader&fixture=heist-12p')).doc?.pages.some((p) => p.render.asset?.variants)).toBe(true);
  });
});

describe('history=1 (Comic History on in the QA harness)', () => {
  it('only an exact `history=1` turns it on', () => {
    expect(parseQaParams('?surface=studio&history=1').history).toBe(true);
    for (const q of ['', '?surface=studio', '?history=0', '?history=yes', '?history=true', '?history=']) expect(parseQaParams(q).history, q).toBe(false);
  });

  it('the scene carries caps {history: true} only then; without it the scene names no caps (DEFAULT_CAPS, History off)', () => {
    expect(qaSceneFromParams(parseQaParams('?surface=studio&history=1')).caps).toEqual({ history: true });
    expect(qaSceneFromParams(parseQaParams('?surface=board&history=1&fixture=lake-1p')).caps).toEqual({ history: true });
    expect(qaSceneFromParams(parseQaParams('?surface=studio'))).not.toHaveProperty('caps');
  });

  it('the controller then reports History on, every other capability unchanged', () => {
    const on = renderHook(() => useQaController(qaSceneFromParams(parseQaParams('?history=1')))).result.current.caps;
    const off = renderHook(() => useQaController(qaSceneFromParams(parseQaParams('')))).result.current.caps;
    expect(on.history).toBe(true);
    expect(off.history).toBeFalsy();
    expect({ ...on, history: off.history }).toEqual(off);
  });
});

describe('fixtures', () => {
  it('every fixture is deterministic and already normalized', () => {
    for (const name of QA_FIXTURES) {
      const a = makeQaDoc(name);
      expect(makeQaDoc(name)).toEqual(a);
      expect(normalizeDoc(a)).toEqual(a);
    }
  });

  it('has the documented shapes', () => {
    expect(makeQaDoc('heist-12p').pages).toHaveLength(12);
    expect(makeQaDoc('deep-40p').pages.every((p) => p.render.status === 'ready')).toBe(true);
    expect(makeQaDoc('webtoon-20p').format.kind).toBe('webtoon');
    const lake = makeQaDoc('lake-1p');
    expect(lake.format.pageAspect).toBe('4:5');
    expect(lake.pages[0].render.asset).toMatchObject({ w: 1024, h: 1024 }); // the square-under-4:5 bug
    expect(lake.pages[0].balloons.map((b) => b.x)).toContain(0);
    const stress = makeQaDoc('stress');
    expect(stress.brief.title.length).toBeGreaterThanOrEqual(160);
    expect(stress.gate?.model.length).toBeGreaterThanOrEqual(54);
    expect(stress.spend.totalUsd).toBe(1234.56);
    expect(makeQaDoc('empty').pages).toHaveLength(0);
    expect(makeQaDoc('heist-12p', { rtl: true }).format.readingDirection).toBe('rtl');
  });

  it('cast roles are free text, never the tier words the chips already show (DC-0 #6)', () => {
    for (const name of QA_FIXTURES) {
      const roles = makeQaDoc(name).cast.map((c) => c.role);
      expect(roles.filter((r) => r === 'Lead' || r === 'Support'), name).toEqual([]);
      expect(roles.every((r) => typeof r === 'string' && r.trim().length > 0), name).toBe(true);
    }
    expect(makeQaDoc('heist-12p').cast.map((c) => c.role)).toEqual(['Pickpocket with a plan', 'Getaway driver', 'Saffron seller', 'Lookouts on the ledge']);
    // The stress cast still carries its long role on every third member.
    expect(makeQaDoc('stress').cast[0].role).toMatch(/^Retired lighthouse keeper/);
  });

  it('every heist page status is represented and ready pages are not stale', () => {
    const doc = makeQaDoc('heist-12p');
    const statuses = new Set(doc.pages.map((p) => p.render.status));
    for (const s of ['ready', 'none', 'queued', 'rendering', 'failed', 'stale']) expect(statuses.has(s as never)).toBe(true);
  });

  it('heist holds page 3 back from its open Render all, with a notice whose fix chips are live (A5 QA fixtures)', () => {
    const doc = makeQaDoc('heist-12p');
    const page = doc.pages[2];
    expect(page.render.status).toBe('none');
    const check = checkPagePlan(doc, page, { fixLayout: false });
    expect(check.state).toBe('overfull');
    expect(check.panels.filter((p) => p.state === 'overfull').map((p) => p.n)).toEqual([5, 6]);
    // The gate is a Render all, stored as the server stores it (jobs.ts createGate: withoutQuote(bindSpendAction)):
    // bound to the pages it draws, the held-back page left out, no drawOverfull and no chip quote. "Draw anyway" is
    // the notice's chip, which extends that Render all.
    const quote = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, holdBack: {} });
    expect(quote.heldBackIds).toEqual([page.id]);
    expect(quote.pageIds).not.toContain(page.id);
    expect(doc.gate?.action).toEqual({ type: 'render_pages', pageIds: quote.pageIds });
    const notice = doc.conversation.flatMap((m) => m.cards ?? []).find((c) => c.id === 'n_held') as Extract<Card, { type: 'notice' }>;
    expect(notice.text).toMatch(/^Page 3 is held back: panel \d has /);
    const chips = noticeChips(notice.fixes);
    expect(chips.map((c) => c.paid)).toEqual([false, true]);
    expect(chips[1].usd).toBeGreaterThan(0);
    expect(chips[1].action).toMatchObject({ type: 'render_pages', drawOverfull: [page.id] });
    for (const c of chips) expect(noticeChipState(doc, c)).toBe('live');
    // An older notice shows the other two chip states for the 320/360 px run: its free fix is already in the comic
    // (Done) and its paid redraw targets a page that is queued or drawing (Started).
    const states = doc.conversation.flatMap((m) => m.cards ?? []).find((c) => c.id === 'n_states') as Extract<Card, { type: 'notice' }>;
    expect(noticeChips(states.fixes).map((c) => noticeChipState(doc, c))).toEqual(['done', 'started']);
    // heldBack: false is heist as it was before (the lettering goldens were recorded on it): page 3 as planned,
    // nothing held back, an explicit-pages gate and no held-back notice.
    const before = makeQaDoc('heist-12p', { heldBack: false });
    expect(before.pages[2].panels).toHaveLength(5);
    expect(quoteRenderPages(before, { byok: false, tier: before.settings.quality, holdBack: {} }).heldBackIds).toBeUndefined();
    expect((before.gate?.action as { pageIds?: string[] }).pageIds).toContain(before.pages[2].id);
    expect(before.gate?.action).not.toHaveProperty('quotedUsd');
    expect(before.conversation.flatMap((m) => m.cards ?? []).some((c) => c.id === 'n_held')).toBe(false);
  });

  it('assets carry the server variants (480w/1080w narrower than the original, ascending)', () => {
    const a = qaAsset('x', 1856, 2304);
    expect(a.variants).toEqual([
      { path: 'qa/x-480x596.png', w: 480, h: 596 },
      { path: 'qa/x-1080x1341.png', w: 1080, h: 1341 }
    ]);
    expect(qaAsset('small', 800, 1000).variants?.map((v) => v.w)).toEqual([480]);
    expect(qaPageSize('2:3')).toEqual({ w: 1536, h: 2304 });
    const paths = qaImagePaths(makeQaDoc('lake-1p'));
    expect(paths).toContain('qa/lake-p1-1024x1024.png');
    expect(paths).toContain('qa/lake-p1-480x480.png');
  });

  it('image names round-trip and reject anything else', () => {
    expect(parseQaImagePath(qaImagePath('heist-p3', 1536, 2304))).toEqual({ seed: 'heist-p3', w: 1536, h: 2304, file: 'heist-p3-1536x2304.png' });
    expect(parseQaImagePath('u/real/user/photo.jpg')).toBeNull();
    expect(parseQaImagePath('qa/x-1x1.png')).toBeNull();
    expect(parseQaImagePath('qa/../../secret-100x100.png')).toBeNull();
  });
});

describe('urlFor', () => {
  it('picks the smallest variant ≥ width × min(dpr, 2), else the original', () => {
    const doc = makeQaDoc('deep-40p');
    const asset = doc.pages[0].render.asset!;
    const urlFor = makeQaUrlFor(() => doc, 'png');
    setDpr(1);
    expect(urlFor(asset, { width: 300 })).toBe('/qa-assets/deep-p1-480x720.png');
    expect(urlFor(asset, { width: 600 })).toBe('/qa-assets/deep-p1-1080x1620.png');
    setDpr(3); // capped at 2: 300 × 2 = 600 → 1080w
    expect(urlFor(asset, { width: 300 })).toBe('/qa-assets/deep-p1-1080x1620.png');
    expect(urlFor(asset, { width: 900 })).toBe('/qa-assets/deep-p1-1536x2304.png');
    expect(urlFor(asset)).toBe('/qa-assets/deep-p1-1536x2304.png');
    // A bare path finds its variants through the doc index.
    setDpr(1);
    expect(urlFor(asset.path, { width: 200 })).toBe('/qa-assets/deep-p1-480x720.png');
  });

  it('serves SVG data URLs by hand and never resolves foreign paths', () => {
    expect(qaImageUrl('qa/x-480x600.png', 'svg')).toMatch(/^data:image\/svg\+xml/);
    expect(qaImageUrl('u/someone/else.png', 'png')).toBeUndefined();
    expect(makeQaUrlFor(() => null, 'png')(null)).toBeUndefined();
  });
});

describe('useQaController', () => {
  it('patch applies the real ops, records them, and undo/redo restore the exact docs', async () => {
    const scene = qaSceneFromParams(parseQaParams('?fixture=heist-12p'));
    const { result } = renderHook(() => useQaController(scene));
    const before = result.current.doc!;
    const pageId = before.pages[0].id;
    const lineId = before.pages[0].balloons[0].lineId;
    await act(async () => {
      await result.current.patch([{ op: 'balloon', pageId, lineId, patch: { x: 0.5, pinned: true } }], { label: 'move a balloon' });
    });
    expect(result.current.doc!.pages[0].balloons.find((b) => b.lineId === lineId)).toMatchObject({ x: 0.5, pinned: true });
    expect(window.__qaDoc?.()).toBe(result.current.doc);
    const patches = qaOps().filter((o) => o.kind === 'patch');
    expect(patches).toHaveLength(1);
    expect(patches[0].payload).toMatchObject({ ops: [{ op: 'balloon', lineId, patch: { pinned: true } }], opts: { label: 'move a balloon' } });
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.doc).toBe(before);
    act(() => result.current.redo());
    expect(result.current.doc!.pages[0].balloons.find((b) => b.lineId === lineId)?.x).toBe(0.5);
  });

  it('records sends and actions without touching the doc, and routes client actions', async () => {
    const { result } = renderHook(() => useQaController(qaSceneFromParams(parseQaParams(''))));
    const doc = result.current.doc;
    await act(async () => {
      await result.current.send('a\nb');
      await result.current.act({ type: 'render_pages', pageIds: ['pg_3'], quotedUsd: 0.06 });
    });
    expect(result.current.doc).toBe(doc);
    expect(qaOps().map((o) => o.kind)).toEqual(['send', 'act']);
    act(() => result.current.runClientAction({ type: 'open_reader', immersive: true }));
    expect(result.current.readerRequest).toMatchObject({ seq: 1, immersive: true });
    act(() => result.current.runClientAction({ type: 'open_page', pageId: 'pg_2' }));
    expect(result.current.focusedPageId).toBe('pg_2');
    act(() => result.current.runClientAction({ type: 'open_tab', tab: 'cast' }));
    expect(result.current.tab).toBe('cast');
    // QA chips open the model picker the way useStudio does (the mounted host answers the event; nothing switches).
    const asked: unknown[] = [];
    const onOpen = (e: Event) => asked.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, onOpen);
    try {
      act(() => result.current.runClientAction({ type: 'open_model_picker', suggest: 'nano-banana-pro' }));
      act(() => result.current.runClientAction({ type: 'open_model_picker' }));
    } finally {
      window.removeEventListener(OPEN_MODEL_PICKER_EVENT, onOpen);
    }
    expect(asked).toEqual([{ suggest: 'nano-banana-pro' }, {}]);
  });

  it('scene states map to honest controller states', () => {
    const loading = renderHook(() => useQaController(qaSceneFromParams(parseQaParams('?state=loading')))).result.current;
    expect(loading).toMatchObject({ doc: null, loading: true, loadError: null });
    const failed = renderHook(() => useQaController(qaSceneFromParams(parseQaParams('?state=load-error')))).result.current;
    expect(failed.loading).toBe(false);
    expect(failed.loadError).toMatch(/could not be opened/);
    const streaming = renderHook(() => useQaController(qaSceneFromParams(parseQaParams('?state=streaming')))).result.current;
    expect(streaming.messageBusy).toBe(true);
    expect(Object.keys(streaming.drafts)).toHaveLength(1);
    const pending = renderHook(() => useQaController(qaSceneFromParams(parseQaParams('?state=failed-send')))).result.current;
    expect(pending.pendingMessage).toMatchObject({ status: 'failed' });
    const editor = qaSceneFromParams(parseQaParams('?surface=editor&page=3'));
    expect(editor.focusedPageId).toBe('pg_3');
  });

  it('state=queued: the director is working and Up next holds real, editable notes (A1, for the DS harness)', async () => {
    expect(parseQaParams('?state=queued').state).toBe('queued');
    const { result } = renderHook(() => useQaController(qaSceneFromParams(parseQaParams('?state=queued'))));
    const c = result.current;
    expect(c).toMatchObject({ messageBusy: true, turnLocked: true, queueHold: null, queueSendingNow: null, queueRetriesLeft: true, queueSteers: false });
    expect(c.queue?.map((n) => n.id)).toEqual(['qn_1', 'qn_2', 'qn_3']);
    expect(c.queue?.[1].focus).toEqual({ pageId: c.doc!.pages[1].id });
    act(() => result.current.editQueued!('qn_1', 'Make the rain much heavier'));
    act(() => result.current.moveQueued!('qn_3', -1));
    act(() => result.current.removeQueued!('qn_2'));
    expect(result.current.queue?.map((n) => [n.id, n.text.slice(0, 25)])).toEqual([
      ['qn_1', 'Make the rain much heavie'],
      ['qn_3', 'After that, try a quieter']
    ]);
    // A message typed while the director works joins Up next.
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send('One more: a lightning flash on page 1');
    });
    expect(outcome).toBe('queued');
    expect(result.current.queue).toHaveLength(3);
    await act(async () => void (await result.current.sendNow!('qn_3')));
    expect(result.current.queueSendingNow).toBe('qn_3');
    expect(qaOps().filter((o) => o.kind === 'queue').map((o) => (o.payload as { action: string }).action)).toEqual(['edit', 'move', 'remove', 'send_now']);
    // Every other state has no queue at all (today's behaviour), and a send there is recorded only.
    const idle = renderHook(() => useQaController(qaSceneFromParams(parseQaParams('')))).result.current;
    expect('queue' in idle).toBe(false);
    expect('turnLocked' in idle).toBe(false);
  });

  it('share=live / share=live-public: the comic is published, so the Share sheet has a live owner view (offline link)', () => {
    expect(parseQaParams('?share=live')).toMatchObject({ live: 'unlisted', share: true });
    expect(parseQaParams('?share=live-public')).toMatchObject({ live: 'public', share: true });
    for (const q of ['', '?share=1', '?share=yes', '?share=LIVE', '?share=live-private']) expect(parseQaParams(q).live, q).toBeNull();
    for (const [q, visibility] of [['?share=live', 'unlisted'], ['?share=live-public', 'public']] as const) {
      const scene = qaSceneFromParams(parseQaParams(q));
      expect(scene.live).toBe(visibility);
      expect(scene.doc!.publication).toMatchObject({ visibility, status: 'live', slug: QA_PUBLICATION_SLUG });
      // The mirror is one the doc keeps (normalizeDoc drops a malformed one).
      expect(normalizeDoc(scene.doc!).publication).toEqual(scene.doc!.publication);
      const view = renderHook(() => useQaController(scene)).result.current.publication!;
      expect(view).toMatchObject({ visibility, status: 'live', slug: QA_PUBLICATION_SLUG, behind: false, readiness: { ok: true } });
      expect(view.slug).toMatch(SLUG_RE);
      // Nothing the sheet shows reaches outside the harness: the link is on this origin and the preview has no picture.
      expect(view.url).toBe(`${window.location.origin}/c/${QA_PUBLICATION_SLUG}`);
      expect(view.ogImageUrl).toBeUndefined();
      expect(view.card?.coverUrl).toBeUndefined();
    }
    // Private (as before): no publication anywhere.
    const scene = qaSceneFromParams(parseQaParams('?share=1'));
    expect(scene).not.toHaveProperty('live');
    expect(scene.doc!.publication).toBeUndefined();
    expect(renderHook(() => useQaController(scene)).result.current.publication).toBeNull();
    expect(qaSceneFromParams(parseQaParams('?state=loading&share=live'))).not.toHaveProperty('live');
  });

  it('state=conflict: the last reply carries a two-item conflict card with the guard on (A3, for the 320 px smoke)', () => {
    expect(parseQaParams('?state=conflict').state).toBe('conflict');
    const scene = qaSceneFromParams(parseQaParams('?state=conflict'));
    expect(scene.caps).toEqual({ liveAgent: { queue: false, steer: false, conflicts: true } });
    expect(qaSceneFromParams(parseQaParams('?state=conflict&history=1')).caps).toEqual({ history: true, liveAgent: { queue: false, steer: false, conflicts: true } });
    const last = scene.doc!.conversation[scene.doc!.conversation.length - 1];
    expect(last.role).toBe('assistant');
    const card = last.cards?.[0] as Extract<Card, { type: 'conflict' }>;
    expect(card.type).toBe('conflict');
    expect(card.items.map((it) => it.id)).toEqual(['cf_qa_line', 'cf_qa_panel']);
    expect(card.more).toBe(2);
    // Real ids on the fixture: Show me opens that page, and "Use the director's" has a held-back edit to apply.
    const page = scene.doc!.pages.find((p) => p.id === card.items[0].where.pageId)!;
    expect(page.panels.some((p) => p.lines.some((l) => l.id === card.items[0].where.lineId))).toBe(true);
    expect(card.items[0].proposed).toHaveLength(1);
    expect(card.items[1]).toMatchObject({ tooBig: true, proposed: [] });
    // normalizeDoc keeps the card whole (a malformed one would be dropped on load).
    const kept = normalizeDoc(scene.doc!).conversation.at(-1)!.cards?.[0];
    expect(kept).toEqual(card);
    // It is the open question Up next waits on; the controller is not busy, so its buttons work.
    const c = renderHook(() => useQaController(scene)).result.current;
    expect(c.messageBusy).toBe(false);
    expect(c.caps.liveAgent?.conflicts).toBe(true);
    // Every other state keeps the fixture's conversation as it was.
    expect(qaSceneFromParams(parseQaParams('')).doc!.conversation.some((m) => m.cards?.some((x) => x.type === 'conflict'))).toBe(false);
  });

  it('recordQaOp stores JSON copies (later mutation never rewrites history)', () => {
    const payload = { a: [1] };
    recordQaOp('act', payload);
    payload.a.push(2);
    expect(qaOps()[0].payload).toEqual({ a: [1] });
  });
});
