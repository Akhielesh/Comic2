// @vitest-environment node
// Model Lab · P1 "Pro pages A/B, part 1" (plan §7, §10 A6; decision PD-8): the owner's 3 golden pages drawn with the
// layout guide off and on. Costs first (6 page jobs + QC from the PriceBook); nothing runs without the admin's confirm
// AND the server-side budget switch (COMIC_LAB_AB_BUDGET_USD, off by default); one image call and one page check per
// click; an idempotency key per click; the A/B's own $1.20 cap shared with part 2; blind A/B until the vote.
// Fakes only: the golden pages are the synthetic fixtures (server/src/comic/golden/pages), the "provider" is a scripted
// fetch that answers both the image and the page check, and nothing here can reach a network or spend.
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc, Page } from '../../../../shared/comic/doc.js';
import { pageFixtures } from '../golden/pages/fixtures.js';
import { __resetImageClientForTests } from '../imageClient.js';
import { fakeModelHealth } from './health.fakes.js';
import { priceBookFromSources, registryPriceBook } from './index.js';
import {
  LAB_AB_BUDGET_ENV,
  LAB_AB_HARD_CAP_USD,
  LAB_AB_NOT_ENABLED_COPY,
  LAB_AB_REF_ALLOWANCE_USD,
  PRO_PAGES_GOLDEN,
  createMemoryLabStore,
  createModelLab,
  createOwnerProPagesSource,
  createSupabaseLabStore,
  isLabError,
  labAbBudget,
  labRunFromDb,
  planProPagesArm,
  proPagesItem,
  proPagesItems,
  type LabAbBudget,
  type LabAbRunView,
  type LabOverview,
  type ModelLabDeps,
  type ProPagesSource,
  type ProPagesView
} from './lab.js';

const ADMIN = '00000000-0000-4000-8000-00000000a001';
const OTHER_ADMIN = '00000000-0000-4000-8000-00000000a002';
const T0 = Date.parse('2026-10-30T12:00:00Z');
const ON: LabAbBudget = { enabled: true, limitUsd: 1.2 };

let png: Buffer;
let refPng: string;

// ── The fake golden source: the owner's comics are the synthetic fixtures (courier = b4b5774f, pond = f8312c86) ──

interface FakeSource extends ProPagesSource {
  reads: { adminId: string; prefix: string }[];
  loads: string[];
  fail: Set<string>;
  docs: Record<string, ComicDoc>;
}

const fakeSource = (): FakeSource => {
  const [courier, , pond] = pageFixtures();
  const docs: Record<string, ComicDoc> = { b4b5774f: courier.doc, f8312c86: pond.doc };
  const reads: FakeSource['reads'] = [];
  const loads: string[] = [];
  const fail = new Set<string>();
  return {
    reads,
    loads,
    fail,
    docs,
    async comic(adminId, prefix) {
      reads.push({ adminId, prefix });
      if (adminId !== ADMIN || !docs[prefix]) return { missing: `Comic ${prefix} isn't one of your comics on this server, so its page can't be drawn here.` };
      return { doc: docs[prefix] };
    },
    async loadDataUrl(path) {
      loads.push(path);
      if (fail.has(path)) throw new Error('object not found');
      return refPng;
    }
  };
};

/** A checker reply for `page`: every panel found, beats as given (default: each panel shows its own moment). */
const visionReply = (page: Page, beats?: number[], extra: Record<string, unknown> = {}) => {
  const n = page.panels.length;
  return {
    panels: page.panels.map((_p, i) => ({ n: i + 1, box: { x: 0.05, y: 0.04 + (0.92 / n) * i, w: 0.9, h: 0.92 / n - 0.02 }, beat: beats?.[i] ?? i + 1, crosses: i === 0 })),
    issues: [],
    textFound: [],
    extraOrMissingCharacters: [],
    score: 0.88,
    balloons: page.panels.flatMap((p, i) => p.lines.map((l) => ({ lineId: l.id, x: 0.1, y: 0.06 + (0.92 / n) * i, w: 0.2, tailX: -1, tailY: -1 }))),
    safety: { rating: 'G', categories: [], notes: [] },
    keepOut: [],
    heads: [],
    ...extra
  };
};

type Handler = (url: string, body: Record<string, unknown>) => Response | Promise<Response>;

interface Harness {
  lab: ReturnType<typeof createModelLab>;
  store: ReturnType<typeof createMemoryLabStore>;
  source: FakeSource;
  /** Every request the fake network saw (the image and the page check go through it; nothing else can). */
  calls: { url: string; method: string; body: Record<string, unknown> }[];
  images: () => Harness['calls'];
  checks: () => Harness['calls'];
  setImage(h: Handler): void;
  setCheck(h: Handler): void;
  budget: { value: LabAbBudget };
  objects: Map<string, Buffer>;
  deps: ModelLabDeps;
}

let keyN = 0;
const key = () => `abclick-${String(++keyN).padStart(12, '0')}`;

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const harness = (over: Partial<ModelLabDeps> = {}, budget: LabAbBudget = ON): Harness => {
  let clock = T0;
  const now = () => (clock += 7);
  const store = createMemoryLabStore({ now });
  const source = fakeSource();
  const objects = new Map<string, Buffer>();
  const calls: Harness['calls'] = [];
  const pageOf = (golden: string) => pageFixtures().find((f) => f.key === golden)!.page;
  // The page the next check is about: the image call names it (its prompt), the guide arm gets different beats below.
  let lastPrompt = '';
  let image: Handler = () =>
    jsonResponse({ id: 'gen-ab-1', model: 'google/gemini-nano-banana-2.1-20261006', provider: 'Google AI Studio', data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.0611 } });
  let check: Handler = () => {
    const page = /Isha's brass wrist compass/.test(lastPrompt) ? pageOf('courier-p2') : /satchel buckle snaps/.test(lastPrompt) ? pageOf('courier-p4') : pageOf('pond-p1');
    const guided = lastPrompt.includes('PAGE LAYOUT GUIDE');
    // Guide on: every beat lands; guide off: the first two panels swap moments.
    const beats = guided ? undefined : page.panels.map((_p, i) => (i === 0 ? 2 : i === 1 ? 1 : i + 1));
    return jsonResponse({ id: 'gen-qc-1', model: 'google/gemini-3.8-flash-001', choices: [{ message: { content: JSON.stringify(visionReply(page, beats)) } }], usage: { cost: 0.0024 } });
  };
  const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, method: init?.method || 'GET', body });
    if (url.endsWith('/chat/completions') && body.response_format) return check(url, body);
    if (typeof body.prompt === 'string') lastPrompt = body.prompt;
    else if (Array.isArray(body.messages)) lastPrompt = JSON.stringify(body.messages);
    return image(url, body);
  }) as typeof fetch;
  const b = { value: budget };
  const deps: ModelLabDeps = {
    store,
    storage: {
      put: async (path, buffer) => void objects.set(path, buffer),
      loadDataUrl: async (path) => `data:image/webp;base64,${objects.get(path)!.toString('base64')}`,
      signUrls: async (paths) => Object.fromEntries(paths.map((p) => [p, `https://signed.example/${p}?t=300`]))
    },
    keys: () => ({ openrouter: { key: 'sk-or-platform-test', byok: false } }),
    prices: async () => registryPriceBook(),
    health: fakeModelHealth({ now: T0 }),
    network,
    imageEndpoints: async () => null,
    now,
    audit: vi.fn(),
    proPages: { source, budget: () => b.value },
    ...over
  };
  const isCheck = (c: Harness['calls'][number]) => c.url.endsWith('/chat/completions') && !!c.body.response_format;
  return {
    lab: createModelLab(deps),
    store,
    source,
    calls,
    images: () => calls.filter((c) => c.method === 'POST' && !isCheck(c)),
    checks: () => calls.filter(isCheck),
    setImage: (h) => void (image = h),
    setCheck: (h) => void (check = h),
    budget: b,
    objects,
    deps
  };
};

const proOf = async (h: Harness): Promise<ProPagesView> => {
  const o: LabOverview = await h.lab.overview(ADMIN);
  expect(o.proPages, 'the A/B section').toBeDefined();
  return o.proPages!;
};

const armOf = (view: ProPagesView, itemId: string) => view.pages.flatMap((p) => p.arms).find((a) => a.id === itemId)!;

const runArm = async (h: Harness, itemId: string, k = key()) => {
  const quoted = armOf(await proOf(h), itemId).quote;
  expect(quoted, itemId).not.toBeNull();
  return h.lab.run(ADMIN, { itemId, idempotencyKey: k, ack: true, quotedUsd: quoted!.usd });
};

const labCodeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    expect(isLabError(err), String(err)).toBe(true);
    return (err as { labCode: string }).labCode;
  }
  throw new Error('expected a lab error');
};

const P2_OFF = 'p1-b4b5774f-p2-guide-off';
const P2_ON = 'p1-b4b5774f-p2-guide-on';

beforeEach(async () => {
  __resetImageClientForTests();
  png ??= await sharp({ create: { width: 200, height: 300, channels: 3, background: '#5577aa' } }).png().toBuffer();
  refPng ??= `data:image/png;base64,${(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#cc8844' } }).png().toBuffer()).toString('base64')}`;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('the arms and the switch', () => {
  it('3 golden pages × guide off/on, named as the plan names them, one blind pair per page', () => {
    expect(PRO_PAGES_GOLDEN.map((g) => `${g.comic} p${g.pageN}`)).toEqual(['b4b5774f p2', 'b4b5774f p4', 'f8312c86 p1']);
    expect(proPagesItems().map((i) => i.id)).toEqual([
      'p1-b4b5774f-p2-guide-off',
      'p1-b4b5774f-p2-guide-on',
      'p1-b4b5774f-p4-guide-off',
      'p1-b4b5774f-p4-guide-on',
      'p1-f8312c86-p1-guide-off',
      'p1-f8312c86-p1-guide-on'
    ]);
    expect(new Set(proPagesItems().map((i) => i.pair.id))).toEqual(new Set(['p1-b4b5774f-p2', 'p1-b4b5774f-p4', 'p1-f8312c86-p1']));
    for (const i of proPagesItems()) expect(i.pair.id).toMatch(/^[a-z0-9-]{1,40}$/); // the vote route's pair id rule
  });

  it('the budget switch is OFF unless set to a plain dollar amount, and never above the shared $1.20 cap', () => {
    expect(labAbBudget({})).toEqual({ enabled: false, limitUsd: null, reason: LAB_AB_NOT_ENABLED_COPY });
    expect(labAbBudget({ [LAB_AB_BUDGET_ENV]: '  ' }).enabled).toBe(false);
    for (const bad of ['0', '0.00', '-1', 'abc', '$1.20', '1e3', 'Infinity']) {
      const b = labAbBudget({ [LAB_AB_BUDGET_ENV]: bad });
      expect(b, bad).toMatchObject({ enabled: false, limitUsd: null });
      expect(b.reason).toMatch(/isn't|not to a dollar amount/);
    }
    expect(labAbBudget({ [LAB_AB_BUDGET_ENV]: '0.5' })).toEqual({ enabled: true, limitUsd: 0.5 });
    expect(labAbBudget({ [LAB_AB_BUDGET_ENV]: '1.20' })).toEqual({ enabled: true, limitUsd: 1.2 });
    expect(labAbBudget({ [LAB_AB_BUDGET_ENV]: '25' })).toEqual({ enabled: true, limitUsd: LAB_AB_HARD_CAP_USD });
    expect(LAB_AB_NOT_ENABLED_COPY).toContain(LAB_AB_BUDGET_ENV);
  });

  it('switch off (the default): a calm "not enabled yet" section that still quotes everything first; no arm can run', async () => {
    const h = harness({}, labAbBudget({}));
    const view = await proOf(h);
    expect(view).toMatchObject({ id: 'P1', enabled: false, notice: LAB_AB_NOT_ENABLED_COPY, switchName: 'COMIC_LAB_AB_BUDGET_USD', budget: { capUsd: 1.2, limitUsd: null, spentUsd: 0, remainingUsd: null } });
    const arms = view.pages.flatMap((p) => p.arms);
    expect(arms).toHaveLength(6);
    for (const a of arms) {
      expect(a.canRun, a.id).toBe(false);
      expect(a.reason).toBe(LAB_AB_NOT_ENABLED_COPY);
      expect(a.quote?.usd, a.id).toBeGreaterThan(0); // costs first, even while off
    }
    expect(view.quote.arms).toBe(6);
    expect(h.calls).toEqual([]);
  });
});

describe('costs first: the quote is 6 page jobs + QC from the PriceBook', () => {
  it('each arm is one page job (its model, resolution and references) plus one page check, at the provider price; the total is all six', async () => {
    const book = registryPriceBook();
    const h = harness();
    const view = await proOf(h);
    let expected = 0;
    for (const item of proPagesItems()) {
      const doc = h.source.docs[item.golden.comic];
      const planned = planProPagesArm(doc, item.golden, item.arm);
      if (!('plan' in planned)) throw new Error(planned.reason);
      const { spec, resolution, references } = planned.plan.compiled;
      const page = book.quote(spec.id, resolution, 'page', references.length).usd!;
      const arm = armOf(view, item.id);
      expect(arm.quote!.usd, item.id).toBeCloseTo(page + book.qcUsd, 6);
      expect(arm.quote!.basis, item.id).toContain('QC $0.003');
      expect(arm).toMatchObject({ modelId: spec.id, res: resolution, refs: references.length, canRun: true });
      expected += page + book.qcUsd;
    }
    expect(view.quote).toMatchObject({ arms: 6, pages: 6, checks: 6, refsUnpriced: true });
    expect(view.quote.usd).toBeCloseTo(expected, 6);
    // The numbers themselves (registry list, 2026-10-22): the courier pages are Standard (2K, $0.0504), the pond page is
    // a Draft storybook; each adds QC $0.003, no markup (the platform pays the provider).
    expect(armOf(view, P2_OFF).quote!.usd).toBe(0.0534);
    expect(armOf(view, P2_ON).quote!.usd).toBe(0.0534);
    expect(view.quote.usd).toBeLessThan(LAB_AB_HARD_CAP_USD);
  });

  it('follows the PriceBook: an observed QC price changes every arm by the same amount', async () => {
    const observed = priceBookFromSources({ rows: [], qc: { medianUsd: 0.0049, n: 7 } });
    const base = await proOf(harness());
    const live = await proOf(harness({ prices: async () => observed }));
    expect(live.quote.usd! - base.quote.usd!).toBeCloseTo(6 * (0.0049 - 0.003), 6);
    expect(armOf(live, P2_ON).quote!.basis).toContain('QC $0.0049 (your last 7 checks)');
    // No PriceBook → no quote → nothing can run (costs first).
    const none = await proOf(harness({ prices: async () => Promise.reject(new Error('catalog down')) }));
    expect(none.quote).toMatchObject({ usd: null, arms: 0 });
    for (const a of none.pages.flatMap((p) => p.arms)) expect(a).toMatchObject({ canRun: false, quote: null });
  });

  it('a changed price is re-confirmed instead of spent', async () => {
    const h = harness();
    const err = await labCodeOf(h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: 0.05 }));
    expect(err).toBe('QUOTE_CHANGED');
    expect(h.images()).toEqual([]);
    expect(h.store.runs).toEqual([]);
  });
});

describe('nothing runs without the confirm and the switch', () => {
  it('no ack (or no quote): refused before the switch, the pages, the store or the network are touched', async () => {
    const h = harness();
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), quotedUsd: 0.0534 }))).toBe('ACK_REQUIRED');
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: 'yes', quotedUsd: 0.0534 }))).toBe('ACK_REQUIRED');
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true }))).toBe('ACK_REQUIRED');
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: 'short', ack: true, quotedUsd: 0.0534 }))).toBe('BAD_KEY');
    expect(h.calls).toEqual([]);
    expect(h.source.reads).toEqual([]);
    expect(h.store.runs).toEqual([]);
  });

  it('switch off: an acknowledged click with the right quote is refused unsent — nothing read, reserved or charged', async () => {
    const h = harness({}, labAbBudget({}));
    let err: unknown;
    try {
      await h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: 0.0534 });
    } catch (e) {
      err = e;
    }
    expect(isLabError(err) && err.labCode).toBe('AB_NOT_ENABLED');
    expect((err as Error).message).toBe(`${LAB_AB_NOT_ENABLED_COPY} Nothing was charged.`);
    expect(h.calls).toEqual([]);
    expect(h.source.reads).toEqual([]);
    expect(h.store.runs).toEqual([]);
    // Turning the switch on makes the same click possible (read on every click; no restart needed).
    h.budget.value = ON;
    const answer = await runArm(h, P2_ON);
    expect((answer.run as LabAbRunView).status).toBe('ok');
  });

  it('a server without the A/B wiring leaves the section out and refuses a click unsent', async () => {
    const h = harness({ proPages: undefined });
    expect((await h.lab.overview(ADMIN)).proPages).toBeUndefined();
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: 0.0534 }))).toBe('AB_NOT_ENABLED');
    expect(h.calls).toEqual([]);
  });
});

describe('one click = one image call + its one page check', () => {
  it('guide on: Image 1 is the PAGE LAYOUT GUIDE (a rendered PNG), the rest is the page exactly as the studio attaches it; one image call, one check, everything recorded', async () => {
    const h = harness();
    const answer = await runArm(h, P2_ON);
    expect(h.images()).toHaveLength(1);
    expect(h.checks()).toHaveLength(1);
    const sent = h.images()[0];
    expect(String(sent.body.prompt)).toContain('Image 1 — PAGE LAYOUT GUIDE.');
    expect(String(sent.body.prompt)).toContain('Panel borders: follow the PAGE LAYOUT GUIDE (Image 1) exactly');
    const refs = sent.body.input_references as { image_url?: { url?: string } }[] | string[];
    const firstRef = JSON.stringify(refs[0]);
    expect(firstRef).toContain('data:image/png;base64,');
    expect(firstRef).not.toContain(refPng.slice(22, 80)); // the guide, not a stored reference
    // Every other reference came from the owner's stored images, nothing from anywhere else.
    expect(h.source.loads.length).toBe(refs.length - 1);
    for (const p of h.source.loads) expect(p.startsWith('u/golden/courier/')).toBe(true);

    const run = answer.run as LabAbRunView;
    expect(answer.replayed).toBe(false);
    expect(run).toMatchObject({ checkId: 'P1', itemId: P2_ON, status: 'ok', callMade: true, costReported: true, checked: true, pair: { id: 'p1-b4b5774f-p2', label: 'b4b5774f · page 2' } });
    // The answer is blind: no image, no facts, no arm-revealing numbers beyond the money.
    expect(Object.keys(run).sort()).toEqual(['callMade', 'checkId', 'checked', 'costReported', 'costUsd', 'id', 'itemId', 'message', 'pair', 'quotedUsd', 'status']);
    // Cost = what the provider reported for the image and for the check.
    expect(run.costUsd).toBeCloseTo(0.0611 + 0.0024, 6);
    const row = h.store.runs[0];
    expect(row).toMatchObject({ checkId: 'P1', itemId: P2_ON, status: 'ok', quotedUsd: 0.0534, kind: 'page', res: '2K', aspect: '2:3' });
    expect(row.result.proPages).toMatchObject({ golden: 'b4b5774f-p2', comic: 'b4b5774f', pageN: 2, arm: 'on', guide: true, withheld: 0, dropped: 0 });
    expect(row.result.proPages!.check).toMatchObject({ ok: true, callMade: true, costReported: true, costUsd: 0.0024, panelsPlanned: 6, panelsDrawn: 6, beatsMatched: 6, crosses: [1], boxesFrom: 'vision', score: 0.88 });
    expect(row.result.imagePath).toMatch(new RegExp(`^u/${ADMIN}/p/model-lab/ref/`));
    // comic_image_calls gets the image call (its own cost); billed to nobody.
    expect(h.store.imageCalls).toEqual([expect.objectContaining({ kind: 'page', res: '2K', outcome: 'ok', provider_cost_usd: 0.0611, billed_usd: 0, byok: false, user_id: ADMIN })]);
    expect(h.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'comic_model_lab_run', detail: expect.objectContaining({ check: 'P1', arm: 'on', golden: 'b4b5774f-p2', checked: true }) }));
    expect(JSON.stringify([h.store.runs, h.store.imageCalls, answer])).not.toContain('sk-or-platform-test');
    // The check went to the studio's page checker on the platform key, with the drawn page attached.
    const qc = h.checks()[0];
    expect(qc.body).toMatchObject({ model: 'google/gemini-3.8-flash', response_format: { type: 'json_schema', json_schema: { name: 'comic_page_check' } } });
    expect(JSON.stringify(qc.body.messages)).toContain(`data:image/png;base64,${png.toString('base64').slice(0, 40)}`);
  });

  it('guide off: the same page with no guide (one image fewer), as the studio draws it today', async () => {
    const h = harness();
    await runArm(h, P2_ON);
    const onRefs = (h.images()[0].body.input_references as unknown[]).length;
    await runArm(h, P2_OFF);
    const off = h.images()[1];
    expect(String(off.body.prompt)).not.toContain('PAGE LAYOUT GUIDE');
    expect((off.body.input_references as unknown[]).length).toBe(onRefs - 1);
    expect(h.store.runs[1].result.proPages).toMatchObject({ arm: 'off', guide: false });
  });

  it('never a second call: a 429 is not retried (and nothing is checked); a check whose answer needs a repair round is not repeated', async () => {
    const h = harness();
    h.setImage(() => jsonResponse({ error: { message: 'Provider returned error', metadata: { provider_name: 'Google AI Studio' } } }, 429));
    const limited = (await runArm(h, P2_ON)).run as LabAbRunView;
    expect(h.images()).toHaveLength(1);
    expect(h.checks()).toHaveLength(0);
    expect(limited).toMatchObject({ status: 'failed', costUsd: 0, callMade: true, costReported: false, checked: false });
    expect(h.store.runs[0].result).toMatchObject({ errorCode: 'RATE_LIMIT', stoppedSecondCall: true });

    // A checker reply with no balloons asks for a repair round: the lab sends exactly one check and keeps what came back.
    const h2 = harness();
    h2.setCheck(() => jsonResponse({ model: 'google/gemini-3.8-flash-001', choices: [{ message: { content: JSON.stringify(visionReply(pageFixtures()[0].page, undefined, { balloons: [] })) } }], usage: { cost: 0.002 } }));
    await runArm(h2, P2_ON);
    expect(h2.checks()).toHaveLength(1);
    expect(h2.store.runs[0].result.proPages!.check).toMatchObject({ ok: true, callMade: true, beatsMatched: 6 });

    // A check that fails is recorded honestly, its quote counted (the provider reported nothing), the drawing kept.
    const h3 = harness();
    h3.setCheck(() => jsonResponse({ error: { message: 'upstream error' } }, 500));
    const run = (await runArm(h3, P2_ON)).run as LabAbRunView;
    expect(h3.checks()).toHaveLength(1);
    expect(run).toMatchObject({ status: 'ok', costReported: false, checked: true });
    expect(run.costUsd).toBeCloseTo(0.0611 + 0.003, 6);
    expect(h3.store.runs[0].result.proPages!.check).toMatchObject({ ok: false, callMade: true, costReported: false, httpStatus: 500 });
    // comic_image_calls keeps the image's own reported cost; only the run's total is "not reported".
    expect(h3.store.imageCalls).toEqual([expect.objectContaining({ outcome: 'ok', provider_cost_usd: 0.0611 })]);
    expect(h3.store.runs[0].result.costReported).toBe(false);
  });

  it('a drawing that could not be stored is never checked (it could never be compared): no check call, no check cost', async () => {
    const h = harness();
    h.deps.storage!.put = async () => {
      throw new Error('bucket unavailable');
    };
    const run = (await runArm(h, P2_ON)).run as LabAbRunView;
    expect(h.images()).toHaveLength(1);
    expect(h.checks()).toHaveLength(0);
    expect(run).toMatchObject({ status: 'ok', checked: false, costReported: true });
    expect(run.costUsd).toBeCloseTo(0.0611, 6); // the image only: no check was paid for
    const row = h.store.runs[0];
    expect(row.result).toMatchObject({ stored: false });
    expect(row.result.imagePath ?? null).toBeNull();
    expect(row.result.proPages!.check).toMatchObject({ ok: false, callMade: false, message: "Not checked: the drawing couldn't be stored, so it can't be compared." });
    // It never enters the pair (nothing to show), so the arm is still waiting to be drawn.
    expect((await proOf(h)).pairs.find((p) => p.id === 'p1-b4b5774f-p2')).toMatchObject({ state: 'waiting', waitingFor: ['Guide off', 'Guide on'] });
  });

  it('a section that cannot be prepared says so and never takes the rest of the lab down', async () => {
    const h = harness();
    h.source.docs.b4b5774f = { pages: null } as unknown as ComicDoc; // a broken stored doc
    const o = await h.lab.overview(ADMIN);
    expect(o.checks.map((c) => c.id)).toEqual(['D1', 'D2', 'D3', 'D4']);
    expect(o.proPages!.quote).toMatchObject({ usd: null, arms: 0 });
    for (const p of o.proPages!.pages) expect(p).toMatchObject({ available: false, arms: [], reason: expect.stringMatching(/couldn't be prepared right now/) });
    expect(h.calls).toEqual([]);
  });

  it('a repeated click returns the stored result and never calls again — also while the first is still running', async () => {
    const h = harness();
    const k = key();
    const first = await runArm(h, P2_ON, k);
    const again = await h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: k, ack: true, quotedUsd: 0.0534 });
    expect(again.replayed).toBe(true);
    expect(again.run.id).toBe(first.run.id);
    expect(h.images()).toHaveLength(1);
    expect(h.checks()).toHaveLength(1);
    expect(h.store.runs).toHaveLength(1);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.setImage(async () => {
      await gate;
      return jsonResponse({ model: 'google/gemini-nano-banana-2.1', data: [{ b64_json: png.toString('base64') }], usage: { cost: 0.06 } });
    });
    const k2 = key();
    const inflight = runArm(h, P2_OFF, k2);
    await vi.waitFor(() => expect(h.images()).toHaveLength(2));
    const repeat = await h.lab.run(ADMIN, { itemId: P2_OFF, idempotencyKey: k2, ack: true, quotedUsd: 0.0534 });
    expect(repeat).toMatchObject({ replayed: true, run: { status: 'running', quotedUsd: 0.0534 } });
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: 'p1-f8312c86-p1-guide-on', idempotencyKey: key(), ack: true, quotedUsd: 0.04 }))).toBe('LAB_BUSY');
    release();
    await inflight;
    expect(h.images()).toHaveLength(2);
    expect(h.checks()).toHaveLength(2);
  });
});

describe('blind until the vote', () => {
  it('a page’s two drawings show as A and B with nothing else; neither can be redrawn; the vote reveals the arms and their checks', async () => {
    const h = harness();
    let view = await proOf(h);
    expect(view.pairs.find((p) => p.id === 'p1-b4b5774f-p2')).toEqual({ id: 'p1-b4b5774f-p2', label: 'b4b5774f · page 2', state: 'waiting', waitingFor: ['Guide off', 'Guide on'] });
    await runArm(h, P2_ON);
    view = await proOf(h);
    expect(view.pairs.find((p) => p.id === 'p1-b4b5774f-p2')).toMatchObject({ state: 'waiting', waitingFor: ['Guide off'] });
    expect(view.pairs.find((p) => p.id === 'p1-b4b5774f-p2')!.a).toBeUndefined();
    await runArm(h, P2_OFF);

    view = await proOf(h);
    const pair = view.pairs.find((p) => p.id === 'p1-b4b5774f-p2')!;
    expect(pair.state).toBe('ready');
    expect(Object.keys(pair.a!).sort()).toEqual(['imageUrl', 'slot']);
    expect(Object.keys(pair.b!).sort()).toEqual(['imageUrl', 'slot']);
    const leak = JSON.stringify(pair);
    for (const word of ['guide', 'Guide', '0.0611', '0.0024', 'beat', 'off', 'P1']) expect(leak, word).not.toContain(word);
    for (const r of h.store.runs) expect(leak).not.toContain(r.id);
    // The A/B runs never show in the plain results list.
    expect((await h.lab.overview(ADMIN)).results).toEqual([]);

    // Neither arm can be redrawn while the pair waits for its vote.
    for (const id of [P2_OFF, P2_ON]) expect(armOf(view, id)).toMatchObject({ canRun: false, reason: 'Vote on b4b5774f · page 2 first — a new drawing now would show which side is which.' });
    const before = h.calls.length;
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: 0.0534 }))).toBe('NOT_RUNNABLE');
    expect(h.calls).toHaveLength(before);

    // The vote names the drawings it was cast on.
    expect(await labCodeOf(h.lab.vote(ADMIN, 'p1-b4b5774f-p2', { pick: 'A' }))).toBe('PAIR_CHANGED');
    expect(await labCodeOf(h.lab.vote(ADMIN, 'p1-b4b5774f-p4', { pick: 'A', seen: pair.seen }))).toBe('PAIR_NOT_READY');
    const onSlot = h.store.runs.find((r) => r.itemId === P2_ON)!.result.imagePath! < h.store.runs.find((r) => r.itemId === P2_OFF)!.result.imagePath! ? 'A' : 'B';
    const revealed = await h.lab.vote(ADMIN, 'p1-b4b5774f-p2', { pick: onSlot, seen: pair.seen });
    expect(revealed).toMatchObject({ state: 'voted', pick: onSlot });
    const sides = [revealed.a!, revealed.b!];
    expect(sides.map((s) => s.arm?.label).sort()).toEqual(['Guide off', 'Guide on']);
    const on = sides.find((s) => s.arm?.id === 'on')!;
    const off = sides.find((s) => s.arm?.id === 'off')!;
    expect(on.slot).toBe(onSlot);
    expect(on.imageUrl).toBe(onSlot === 'A' ? pair.a!.imageUrl : pair.b!.imageUrl); // the image seen as A is the run revealed as A
    expect(on.check).toMatchObject({ beatsMatched: 6, panelsPlanned: 6 });
    expect(off.check).toMatchObject({ beatsMatched: 4, panelsPlanned: 6 });
    expect(on.run!.facts.proPages).toMatchObject({ guide: true });
    expect(await labCodeOf(h.lab.vote(ADMIN, 'p1-b4b5774f-p2', { pick: 'A', seen: pair.seen }))).toBe('ALREADY_VOTED');
    expect(h.store.voteRows).toEqual([expect.objectContaining({ pairId: 'p1-b4b5774f-p2', adminId: ADMIN, pick: onSlot })]);

    // The tally: from voted pairs only.
    const after = await proOf(h);
    expect(after.tally).toEqual({
      voted: 1,
      pairs: 3,
      picks: { on: 1, off: 0, tie: 0 },
      beats: { on: { matched: 6, planned: 6 }, off: { matched: 4, planned: 6 } },
      guideLinesCopied: { on: 0, off: 0 },
      guideLinesChecked: { on: 0, off: 0 }
    });
    expect(after.pairs.find((p) => p.id === 'p1-b4b5774f-p2')!.seen).toBeUndefined();
    // After the vote the pair's two drawings are final: a new drawing would be paid for and shown nowhere (the voted pair
    // keeps the drawings the owner judged), so neither arm offers one and a click is refused before anything is spent.
    const voted = 'You voted on b4b5774f · page 2; its two drawings are final, so a new drawing here would never be shown.';
    for (const id of [P2_OFF, P2_ON]) expect(armOf(after, id)).toMatchObject({ canRun: false, reason: voted });
    const callsBefore = h.calls.length;
    const rowsBefore = h.store.runs.length;
    const abBefore = await h.store.spentOn(['P1', 'P2']);
    let refused: unknown;
    try {
      await h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: armOf(after, P2_ON).quote!.usd });
    } catch (err) {
      refused = err;
    }
    expect(isLabError(refused) && refused.labCode).toBe('NOT_RUNNABLE');
    expect((refused as Error).message).toBe(`${voted} Nothing was charged.`);
    expect(h.calls).toHaveLength(callsBefore);
    expect(h.store.runs).toHaveLength(rowsBefore);
    expect(await h.store.spentOn(['P1', 'P2'])).toBe(abBefore);
    // The other golden pages are untouched by this page's vote.
    expect(armOf(after, 'p1-b4b5774f-p4-guide-on').canRun).toBe(true);
    // No watermark box on the A/B (wrong model check, and blind before the vote).
    expect(await labCodeOf(h.lab.setWatermark(ADMIN, h.store.runs[0].id, { visible: true }))).toBe('BAD_REQUEST');
  });
});

describe('the A/B cap: $1.20 over every day, shared with part 2', () => {
  it('part 2 spend counts against part 1; the refusal comes before any call; the overview says why', async () => {
    const h = harness();
    const p2 = await h.store.reserve({ key: key(), adminId: ADMIN, checkId: 'P2', itemId: 'p2-probe', modelId: 'nano-banana-2.1', providerModel: null, kind: 'page', res: '2K', aspect: '2:3', refs: 0, quotedUsd: 1.16, capUsd: 2, ab: { capUsd: 1.2 } });
    expect(p2.outcome).toBe('reserved');
    const view = await proOf(h);
    expect(view.budget).toEqual({ capUsd: 1.2, limitUsd: 1.2, spentUsd: 1.16, remainingUsd: 0.04 });
    expect(armOf(view, P2_ON)).toMatchObject({ canRun: false });
    const held = Math.round(armOf(view, P2_ON).refs! * LAB_AB_REF_ALLOWANCE_USD * 10_000) / 10_000;
    expect(armOf(view, P2_ON).reason).toBe(
      `The A/B budget can't cover this: $1.16 of $1.20 used (every day, parts 1 and 2 together), and this drawing is quoted at $0.0534, with $${held} more held back for its attached images, whose price isn't published. Nothing was charged.`
    );
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: 0.0534 }))).toBe('AB_CAP_REACHED');
    expect(h.calls).toEqual([]);
  });

  it('each drawing holds $0.004 per attached image under the limit (unpriced reference input): a limit just above spent + quote is refused', async () => {
    const quote = 0.0534;
    const probe = harness();
    const refs = armOf(await proOf(probe), P2_ON).refs!;
    expect(refs).toBeGreaterThan(1); // the stored references plus the guide
    const allowance = Math.round(refs * LAB_AB_REF_ALLOWANCE_USD * 1e6) / 1e6;

    // Room for the quote, but not for the quote plus the allowance: refused before anything is read, reserved or sent.
    const tight = harness({}, { enabled: true, limitUsd: quote + 0.001 });
    const arm = armOf(await proOf(tight), P2_ON);
    expect(arm.canRun).toBe(false);
    expect(arm.reason).toMatch(/held back for its attached images, whose price isn't published/);
    expect(await labCodeOf(tight.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: quote }))).toBe('AB_CAP_REACHED');
    expect(tight.calls).toEqual([]);
    expect(tight.store.runs).toEqual([]);

    // With room for both it runs, and the atomic reservation is made against the limit minus the allowance, so a reported
    // cost above the quote (by up to the allowance) still lands under the limit.
    const limit = Math.round((quote + allowance + 0.0005) * 1e6) / 1e6;
    const roomy = harness({}, { enabled: true, limitUsd: limit });
    const reserve = vi.spyOn(roomy.store, 'reserve');
    expect(armOf(await proOf(roomy), P2_ON).canRun).toBe(true);
    await runArm(roomy, P2_ON);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0][0].ab!.capUsd).toBeCloseTo(limit - allowance, 6);
    expect(roomy.images()).toHaveLength(1);
  });

  it('a switch set below the cap is the limit; earlier days count too; the store never lets a limit pass $1.20', async () => {
    const low = harness({}, labAbBudget({ [LAB_AB_BUDGET_ENV]: '0.05' }));
    expect(await labCodeOf(low.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: 0.0534 }))).toBe('AB_CAP_REACHED');
    expect(low.calls).toEqual([]);

    let day = T0;
    const store = createMemoryLabStore({ now: () => day });
    const base = { adminId: ADMIN, itemId: 'x', modelId: 'm', providerModel: null, kind: 'page', res: '2K', aspect: '2:3', refs: 0, capUsd: 2 };
    expect((await store.reserve({ ...base, key: 'k-ab-aaaaaaaaaaaaaa', checkId: 'P1', quotedUsd: 1.1, ab: { capUsd: 99 } })).outcome).toBe('reserved');
    day += 3 * 86_400_000; // three days later: the daily cap is fresh, the A/B limit is not
    expect(await store.reserve({ ...base, key: 'k-ab-bbbbbbbbbbbbbb', checkId: 'P2', quotedUsd: 0.2, ab: { capUsd: 99 } })).toEqual({ outcome: 'ab_cap', spentUsd: 1.1 });
    expect((await store.reserve({ ...base, key: 'k-ab-cccccccccccccc', checkId: 'D1', quotedUsd: 0.2 })).outcome).toBe('reserved');
    // An A/B run is never reserved without the A/B limit, and a D check never with it.
    await expect(store.reserve({ ...base, key: 'k-ab-dddddddddddddd', checkId: 'P1', quotedUsd: 0.01 })).rejects.toThrow(/A\/B/);
    await expect(store.reserve({ ...base, key: 'k-ab-eeeeeeeeeeeeee', checkId: 'D1', quotedUsd: 0.01, ab: { capUsd: 1 } })).rejects.toThrow(/A\/B/);
    expect(await store.spentOn(['P1', 'P2'])).toBe(1.1);
  });
});

describe('the golden pages: the admin’s own comics, the studio’s reference gate', () => {
  it('another admin sees the pages as not theirs (nothing quoted, nothing runnable); the owner’s pages load once per comic', async () => {
    const h = harness();
    const other = await h.lab.overview(OTHER_ADMIN);
    for (const p of other.proPages!.pages) expect(p).toMatchObject({ available: false, arms: [], reason: expect.stringMatching(/isn't one of your comics/) });
    expect(other.proPages!.quote).toMatchObject({ usd: null, arms: 0 });
    expect(await labCodeOf(h.lab.run(OTHER_ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: 0.0534 }))).toBe('NOT_RUNNABLE');
    expect(h.calls).toEqual([]);
    h.source.reads.length = 0;
    await h.lab.overview(ADMIN);
    expect(h.source.reads).toEqual(expect.arrayContaining([{ adminId: ADMIN, prefix: 'b4b5774f' }, { adminId: ADMIN, prefix: 'f8312c86' }]));
    expect(h.source.reads).toHaveLength(2);
  });

  it('uploads with no safety verdict and blocked images are never sent; a reference that fails to load is left out and counted', async () => {
    const h = harness();
    // f8312c86-shaped: the protagonist's 4 photos are uploads never checked → held back; her generated sheet goes.
    const view = await proOf(h);
    expect(armOf(view, 'p1-f8312c86-p1-guide-off').refsNote).toMatch(/held back \(blocked, or not safety-checked yet\)/);
    await runArm(h, 'p1-f8312c86-p1-guide-off');
    expect(h.source.loads.some((p) => p.includes('/refs/'))).toBe(false);
    expect(h.source.loads).toContain('u/golden/pond/sheets/mina.webp');
    expect(h.store.runs[0].result.proPages!.withheld).toBeGreaterThan(0);

    // A blocked sheet is never loaded either.
    const blocked = harness();
    const isha = blocked.source.docs.b4b5774f.cast.find((c) => c.id === 'c_isha')!;
    isha.sheet.asset!.safety = { assessed: 'X', by: 'check', at: T0 };
    await runArm(blocked, P2_OFF);
    expect(blocked.source.loads).not.toContain('u/golden/courier/sheets/isha.webp');

    // A stored reference that can't be loaded: left out, the page recompiled without it, the count recorded.
    const lost = harness();
    lost.source.fail.add('u/golden/courier/sheets/dev.webp');
    const quoted = armOf(await proOf(lost), P2_OFF).quote!.usd; // nano-banana-2.1 reference input is unpublished: same quote
    await lost.lab.run(ADMIN, { itemId: P2_OFF, idempotencyKey: key(), ack: true, quotedUsd: quoted });
    expect(lost.store.runs[0].result.proPages).toMatchObject({ dropped: 1 });
    expect(String(lost.images()[0].body.prompt)).not.toContain('CHARACTER SHEET: DEV');
  });

  it('createOwnerProPagesSource reads only the clicking admin’s rows, by the comic id prefix, and never guesses', async () => {
    const queries: Record<string, unknown>[] = [];
    let rows: Record<string, unknown>[] = [];
    const db = () => ({
      from: (table: string) => {
        const q: Record<string, unknown> = { table };
        queries.push(q);
        const chain = {
          select: (cols: string) => ((q.select = cols), chain),
          eq: (c: string, v: string) => ((q[`eq:${c}`] = v), chain),
          gte: (c: string, v: string) => ((q[`gte:${c}`] = v), chain),
          lte: (c: string, v: string) => ((q[`lte:${c}`] = v), chain),
          limit: (n: number) => ((q.limit = n), chain),
          abortSignal: async () => ({ data: rows, error: null })
        };
        return chain;
      }
    });
    const source = createOwnerProPagesSource({ db: db as never, enabled: true, loadDataUrl: async () => refPng })!;
    rows = [{ project_id: 'b4b5774f-0000-4000-8000-000000000001', doc: JSON.parse(JSON.stringify(pageFixtures()[0].doc)) }];
    const found = await source.comic(ADMIN, 'b4b5774f');
    expect('doc' in found && found.doc.pages.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    expect(queries[0]).toEqual({
      table: 'comic_docs',
      select: 'project_id, doc',
      'eq:user_id': ADMIN,
      'gte:project_id': 'b4b5774f-0000-0000-0000-000000000000',
      'lte:project_id': 'b4b5774f-ffff-ffff-ffff-ffffffffffff',
      limit: 2
    });
    rows = [];
    expect(await source.comic(ADMIN, 'f8312c86')).toEqual({ missing: "Comic f8312c86 isn't one of your comics on this server, so its page can't be drawn here." });
    rows = [{ project_id: 'a', doc: {} }, { project_id: 'b', doc: {} }];
    expect(await source.comic(ADMIN, 'f8312c86')).toEqual({ missing: "More than one of your comics starts with f8312c86, so the lab won't guess which one to draw." });
    const n = queries.length;
    expect(await source.comic(ADMIN, "b4b5774f' or 1=1")).toMatchObject({ missing: expect.any(String) });
    expect(queries).toHaveLength(n); // a bad id is never sent to the database
    expect(createOwnerProPagesSource({ enabled: false, loadDataUrl: async () => '' })).toBeNull();
  });
});

describe('the comic’s model lock', () => {
  it('a comic locked to a model this server can’t draw is never drawn on another one: not runnable, no call', async () => {
    const h = harness();
    h.source.docs.b4b5774f.imageModel = { modelId: 'retired/old-model-9', lockedAt: T0, origin: 'first_render' };
    const view = await proOf(h);
    const copy = "Comic b4b5774f is locked to retired/old-model-9, which this server can't draw, so the lab won't draw it on another model.";
    for (const id of [P2_OFF, P2_ON, 'p1-b4b5774f-p4-guide-off', 'p1-b4b5774f-p4-guide-on']) expect(armOf(view, id)).toMatchObject({ canRun: false, quote: null, reason: copy });
    expect(armOf(view, 'p1-f8312c86-p1-guide-on').canRun).toBe(true); // another comic is unaffected
    let refused: unknown;
    try {
      await h.lab.run(ADMIN, { itemId: P2_ON, idempotencyKey: key(), ack: true, quotedUsd: 0.0534 });
    } catch (err) {
      refused = err;
    }
    expect(isLabError(refused) && refused.labCode).toBe('NOT_RUNNABLE');
    expect((refused as Error).message).toBe(`${copy} Nothing was charged.`);
    expect(h.calls).toEqual([]);
    expect(h.store.runs).toEqual([]);
    expect(h.source.docs.b4b5774f.imageModel).toEqual({ modelId: 'retired/old-model-9', lockedAt: T0, origin: 'first_render' }); // the comic is never changed
  });

  it('a comic locked to the model its page compiles for draws as usual (a lock is checked, not guessed)', () => {
    const doc = harness().source.docs.b4b5774f;
    const planned = planProPagesArm(doc, PRO_PAGES_GOLDEN[0], 'on');
    if (!('plan' in planned)) throw new Error(planned.reason);
    const locked = { ...doc, imageModel: { modelId: planned.plan.compiled.spec.id, lockedAt: T0, origin: 'first_render' as const } };
    expect('plan' in planProPagesArm(locked, PRO_PAGES_GOLDEN[0], 'on')).toBe(true);
  });
});

describe('copied guide lines: the owner’s mark after the vote (plan §4.8)', () => {
  it('only after the vote, only on the voted drawings; recorded per side, shown revealed, counted per arm in the tally', async () => {
    const h = harness();
    await runArm(h, P2_ON);
    await runArm(h, P2_OFF);
    const onRun = h.store.runs.find((r) => r.itemId === P2_ON)!;
    const offRun = h.store.runs.find((r) => r.itemId === P2_OFF)!;
    // Blind until the vote: no mark that could tie a run to a side.
    expect(await labCodeOf(h.lab.setWatermark(ADMIN, onRun.id, { guideLines: true }))).toBe('PAIR_NOT_READY');
    expect(onRun.result.proPages!.guideLinesCopied).toBeUndefined();

    const pair = (await proOf(h)).pairs.find((p) => p.id === 'p1-b4b5774f-p2')!;
    await h.lab.vote(ADMIN, 'p1-b4b5774f-p2', { pick: 'tie', seen: pair.seen });
    expect(await labCodeOf(h.lab.setWatermark(ADMIN, onRun.id, { guideLines: 'yes' }))).toBe('BAD_REQUEST');
    const marked = await h.lab.setWatermark(ADMIN, onRun.id, { guideLines: true });
    expect(marked.facts.proPages!.guideLinesCopied).toMatchObject({ value: true, by: ADMIN });
    await h.lab.setWatermark(ADMIN, offRun.id, { guideLines: false });
    expect(h.store.runs.find((r) => r.id === offRun.id)!.result.proPages!.guideLinesCopied).toMatchObject({ value: false, by: ADMIN });
    // The watermark box is still not an A/B thing, and a D check has no guide-lines mark.
    expect(await labCodeOf(h.lab.setWatermark(ADMIN, onRun.id, { visible: true }))).toBe('BAD_REQUEST');

    const view = await proOf(h);
    const revealed = view.pairs.find((p) => p.id === 'p1-b4b5774f-p2')!;
    const onSide = [revealed.a!, revealed.b!].find((s) => s.arm?.id === 'on')!;
    expect(onSide.run!.facts.proPages!.guideLinesCopied).toMatchObject({ value: true });
    expect(view.tally).toMatchObject({ guideLinesCopied: { on: 1, off: 0 }, guideLinesChecked: { on: 1, off: 1 } });

    // "Not checked" clears the mark (and the count).
    await h.lab.setWatermark(ADMIN, onRun.id, { guideLines: null });
    expect((await proOf(h)).tally).toMatchObject({ guideLinesCopied: { on: 0, off: 0 }, guideLinesChecked: { on: 0, off: 1 } });
    // Only voted drawings: a run the vote wasn't cast on (another page's) can't be marked.
    await runArm(h, 'p1-b4b5774f-p4-guide-on');
    const other = h.store.runs.find((r) => r.itemId === 'p1-b4b5774f-p4-guide-on')!;
    expect(await labCodeOf(h.lab.setWatermark(ADMIN, other.id, { guideLines: false }))).toBe('PAIR_NOT_READY');
  });

  it('a D check refuses the guide-lines mark', async () => {
    const h = harness();
    const d = await h.store.reserve({ key: key(), adminId: ADMIN, checkId: 'D3', itemId: 'd3-seedream-pro', modelId: 'seedream-5-pro', providerModel: null, kind: 'page', res: '2K', aspect: '2:3', refs: 0, quotedUsd: 0.09, capUsd: 2 });
    if (d.outcome !== 'reserved') throw new Error(d.outcome);
    expect(await labCodeOf(h.lab.setWatermark(ADMIN, d.row.id, { guideLines: true }))).toBe('BAD_REQUEST');
  });
});

describe('the Supabase store and the database rows', () => {
  it('an A/B reservation goes to comic_model_lab_reserve_ab with its limit (never the plain reserve); A/B spend sums P1 and P2', async () => {
    const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
    const ins: unknown[] = [];
    const db = () => ({
      rpc: (fn: string, args: Record<string, unknown>) => ({
        abortSignal: async () => {
          rpcs.push({ fn, args });
          return { data: [{ out_outcome: 'ab_cap', out_run_id: null, out_spent: 1.18 }], error: null };
        }
      }),
      from: () => ({
        select: () => ({
          in: (col: string, vals: string[]) => ({
            abortSignal: async () => {
              ins.push([col, vals]);
              return { data: [{ status: 'ok', quoted_usd: '0.0534', cost_usd: '0.0611' }, { status: 'running', quoted_usd: '0.0534', cost_usd: null }, { status: 'failed', quoted_usd: '0.05', cost_usd: null }], error: null };
            }
          })
        })
      })
    });
    const store = createSupabaseLabStore({ db: db as never, enabled: true })!;
    const base = { key: 'k-ab-ffffffffffffff', adminId: ADMIN, itemId: P2_ON, modelId: 'nano-banana-2.1', providerModel: 'google/gemini-nano-banana-2.1', kind: 'page', res: '2K', aspect: '2:3', refs: 5, quotedUsd: 0.0534, capUsd: 2 };
    expect(await store.reserve({ ...base, checkId: 'P1', ab: { capUsd: 0.6 } })).toEqual({ outcome: 'ab_cap', spentUsd: 1.18 });
    await store.reserve({ ...base, checkId: 'P1' });
    await store.reserve({ ...base, checkId: 'D1' });
    expect(rpcs.map((r) => [r.fn, r.args.p_ab_cap])).toEqual([
      ['comic_model_lab_reserve_ab', 0.6],
      ['comic_model_lab_reserve_ab', 0], // no limit given → asks for $0, which the function refuses
      ['comic_model_lab_reserve', undefined]
    ]);
    expect(await store.spentOn!(['P1', 'P2'])).toBe(0.1645);
    expect(ins).toEqual([['check_id', ['P1', 'P2']]]);
  });

  it('labRunFromDb reads A/B rows', () => {
    const row = labRunFromDb({ id: 'r1', idempotency_key: 'k', check_id: 'P1', item_id: P2_ON, model_id: 'nano-banana-2.1', kind: 'page', status: 'ok', quoted_usd: '0.0534', cost_usd: '0.0635', result: { callMade: true, refsSent: 5 }, day: '2026-10-30' });
    expect(row).toMatchObject({ checkId: 'P1', quotedUsd: 0.0534, costUsd: 0.0635 });
    expect(proPagesItem(row!.itemId)?.arm).toBe('on');
  });
});
