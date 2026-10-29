// @vitest-environment node
// Model Lab (models.md §2.6 D1–D4; wm-plan M1-MODEL-LAB): costs first, one provider call per click through the
// studio's own transport, an idempotency key per click, a hard $2/UTC-day cap enforced before any call, honest
// refusals, every result recorded (comic_image_calls + the lab row), and a blind D4 test whose names stay hidden
// until the owner votes. Fakes only: the "provider" is a scripted fetch; nothing here spends.
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetImageClientForTests } from '../imageClient.js';
import { fakeModelHealth } from './health.fakes.js';
import { registryPriceBook } from './index.js';
import {
  LAB_CHECKS,
  LAB_DAILY_CAP_USD,
  LAB_STORAGE_PROJECT,
  createMemoryLabStore,
  createModelLab,
  isLabError,
  labItem,
  labItems,
  labPrompt,
  labRunFromDb,
  oneCallTransport,
  quoteLabItem,
  type BlindPairView,
  type LabBlindRunView,
  type LabRunView,
  type LabStorage,
  type ModelLabDeps
} from './lab.js';

const ADMIN = '00000000-0000-4000-8000-00000000a001';
const T0 = Date.parse('2026-10-29T12:00:00Z');

let png2x3: Buffer;
const pngOf = async (w: number, h: number, color: string) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

type Script = (url: string, body: Record<string, unknown>) => Response | Promise<Response>;
const imageAnswer = (b64: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ id: 'gen-123', model: 'google/gemini-nano-banana-2.1-20261006', provider: 'Google AI Studio', data: [{ b64_json: b64, media_type: 'image/png' }], usage: { cost: 0.0756 }, ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

interface Harness {
  lab: ReturnType<typeof createModelLab>;
  store: ReturnType<typeof createMemoryLabStore>;
  storage: LabStorage & { objects: Map<string, { buffer: Buffer; type: string }> };
  calls: { url: string; method: string; body: Record<string, unknown> }[];
  health: ReturnType<typeof fakeModelHealth>;
  setScript(s: Script): void;
  deps: ModelLabDeps;
}

let keyN = 0;
const key = () => `click-${String(++keyN).padStart(12, '0')}`;

const harness = (over: Partial<ModelLabDeps> = {}): Harness => {
  let clock = T0;
  const now = () => (clock += 7);
  const store = createMemoryLabStore({ now });
  const objects = new Map<string, { buffer: Buffer; type: string }>();
  const storage: Harness['storage'] = {
    objects,
    put: async (path, buffer, type) => void objects.set(path, { buffer, type }),
    loadDataUrl: async (path) => {
      const o = objects.get(path);
      if (!o) throw new Error('missing');
      return `data:${o.type};base64,${o.buffer.toString('base64')}`;
    },
    signUrls: async (paths) => Object.fromEntries(paths.map((p) => [p, `https://signed.example/${p}?t=300`]))
  };
  const calls: Harness['calls'] = [];
  let script: Script = () => imageAnswer(png2x3.toString('base64'));
  const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, method: init?.method || 'GET', body });
    return script(url, body);
  }) as typeof fetch;
  const health = fakeModelHealth({ now: T0 });
  const deps: ModelLabDeps = {
    store,
    storage,
    keys: () => ({ openrouter: { key: 'sk-or-platform-test', byok: false } }),
    prices: async () => registryPriceBook(),
    health,
    network,
    now,
    audit: vi.fn(),
    ...over
  };
  return { lab: createModelLab(deps), store, storage, calls, health, setScript: (s) => void (script = s), deps };
};

const quoteFor = async (h: Harness, itemId: string): Promise<number> => {
  const o = await h.lab.overview(ADMIN);
  const item = o.checks.flatMap((c) => c.items).find((i) => i.id === itemId)!;
  expect(item.quote, itemId).not.toBeNull();
  return item.quote!.usd;
};

const runItem = async (h: Harness, itemId: string, k = key()) => h.lab.run(ADMIN, { itemId, idempotencyKey: k, ack: true, quotedUsd: await quoteFor(h, itemId) });

const labCodeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    expect(isLabError(err), String(err)).toBe(true);
    return (err as { labCode: string }).labCode;
  }
  throw new Error('expected a lab error');
};

beforeEach(async () => {
  __resetImageClientForTests();
  png2x3 ??= await pngOf(200, 300, '#6688aa');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('the checks and their quotes', () => {
  it('lists D1–D4 from models.md §2.6, each item with a quote and its source', async () => {
    expect(LAB_CHECKS.map((c) => c.id)).toEqual(['D1', 'D2', 'D3', 'D4']);
    const h = harness();
    const o = await h.lab.overview(ADMIN);
    const items = o.checks.flatMap((c) => c.items);
    const d1 = items.find((i) => i.id === 'd1-nano-banana-2.1-4k')!;
    // The registry book (no live data in the test): the dated price list, and reference input is unpublished.
    expect(d1.quote).toEqual({ usd: 0.113, source: 'pricebook', basis: 'price list from 2026-10-22 · reference cost unpublished', refsUnpriced: true });
    expect(d1).toMatchObject({ res: '4K', aspect: '2:3', refs: 4, canRun: true });
    expect(items.find((i) => i.id === 'd2-gpt-image-2.5-sunburst')!.quote!.usd).toBe(0.2107);
    // D3: the registry has no 2K price for Seedream 5.0 Pro → the §2.6 upper estimate with its label.
    const d3 = items.find((i) => i.id === 'd3-seedream-5-pro-2k')!;
    expect(d3.quote!.usd).toBe(0.102);
    expect(d3.quote!.source).toBe('research');
    expect(d3.quote!.basis).toMatch(/models\.md §2\.6.*\+ 4 × \$0\.003 references/);
    // D4 candidates are outside the registry: the dated §1.1 list price, labelled as such.
    const flash = items.find((i) => i.id === 'd4-seedream-5-0-flash-sheet-1')!;
    expect(flash.quote).toMatchObject({ usd: 0.018, source: 'research' });
    expect(flash.quote!.basis).toContain('checked 2026-10-22 (models.md §1.1)');
    expect(items.find((i) => i.id === 'd4-qwen-image-2.1-turbo-page-1')!.quote!.usd).toBe(0.0184);
    // The add-on is listed honestly but cannot run.
    const addOn = items.find((i) => i.id === 'd4-gpt-image-2.5-flare-medium')!;
    expect(addOn).toMatchObject({ canRun: false, quote: null });
    expect(addOn.reason).toMatch(/quality setting/);
    // The whole approved set fits the daily cap with room to spare.
    const total = items.filter((i) => i.canRun).reduce((s, i) => s + (i.quote?.usd ?? 0), 0);
    expect(total).toBeLessThan(LAB_DAILY_CAP_USD);
    expect(o).toMatchObject({ capUsd: 2, spentUsd: 0, remainingUsd: 2, day: '2026-10-29', ready: { platformKey: true, storage: true } });
  });

  it('quoteLabItem: PriceBook first, the dated research number only when the book has none, never a made-up number', () => {
    const d1 = labItem('d1-nano-banana-2.1-4k')!;
    expect(quoteLabItem(d1, null, 4)).toBeNull(); // a registry model with no PriceBook and no research figure → no quote
    expect(quoteLabItem(d1, registryPriceBook(), 4)!.usd).toBe(0.113);
    const d3 = labItem('d3-seedream-5-pro-2k')!;
    expect(quoteLabItem(d3, registryPriceBook(), 0)!.usd).toBe(0.09);
    // A live price for 2K wins over the research estimate.
    const live = { quote: () => ({ usd: 0.0812, basis: 'OpenRouter price, 2026-10-29T11:00:00Z', refsUnpriced: false }) } as unknown as Parameters<typeof quoteLabItem>[1];
    expect(quoteLabItem(d3, live, 4)).toMatchObject({ usd: 0.0812, source: 'pricebook' });
  });

  it('prompts are synthetic and carry a legend of exactly the references sent', () => {
    const page = labPrompt(labItem('d1-nano-banana-2.1-4k')!, ['CHARACTER SHEET: MAYA', 'CHARACTER SHEET: TOMAS']);
    expect(page).toContain('Image 1: CHARACTER SHEET: MAYA\nImage 2: CHARACTER SHEET: TOMAS');
    expect(page).not.toContain('Image 3');
    expect(labPrompt(labItem('d4-qwen-image-2.1-turbo-page-2')!, [])).not.toContain('REFERENCE IMAGES');
    expect(labPrompt(labItem('d4-qwen-image-2.1-turbo-sheet-3')!, [])).toMatch(/creature model sheet of PIP/);
  });
});

describe('running a check', () => {
  it('no call without ack: nothing is read, reserved or sent', async () => {
    const h = harness();
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: key(), quotedUsd: 0.113 }))).toBe('ACK_REQUIRED');
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: key(), ack: 'yes', quotedUsd: 0.113 }))).toBe('ACK_REQUIRED');
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: key(), ack: true }))).toBe('ACK_REQUIRED');
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: 'short', ack: true, quotedUsd: 0.113 }))).toBe('BAD_KEY');
    expect(h.calls).toEqual([]);
    expect(h.store.runs).toEqual([]);
  });

  it('D1: one call, every fact recorded — usage.cost, pixel size, file size, latency, the reported model version — into the lab row and comic_image_calls', async () => {
    const h = harness();
    const answer = await runItem(h, 'd1-nano-banana-2.1-4k');
    expect(h.calls).toHaveLength(1);
    const sent = h.calls[0];
    expect(sent.url).toMatch(/\/images$/);
    expect(sent.method).toBe('POST');
    expect(sent.body).toMatchObject({ model: 'google/gemini-nano-banana-2.1', aspect_ratio: '2:3', resolution: '4K' });
    expect((sent.body.input_references as unknown[]).length).toBe(4);
    expect(JSON.stringify(h.calls)).toContain('Image 4: PLACE SHEET: THE BOATHOUSE');

    expect(answer.replayed).toBe(false);
    const run = answer.run as LabRunView;
    expect(run).toMatchObject({ status: 'ok', checkId: 'D1', quotedUsd: 0.113, costUsd: 0.0756, model: { id: 'nano-banana-2.1', nickname: 'Nano Banana 2.1' } });
    expect(run.facts).toMatchObject({
      callMade: true,
      endpoint: '/images',
      httpStatus: 200,
      width: 200,
      height: 300,
      bytes: png2x3.byteLength,
      mediaType: 'image/png',
      aspectOk: true,
      providerModelVersion: 'google/gemini-nano-banana-2.1-20261006',
      providerName: 'Google AI Studio',
      generationId: 'gen-123',
      refsSent: 4,
      costReported: true,
      stored: true,
      recordedCall: true,
      stoppedSecondCall: false,
      sent: { aspect: '2:3', resolution: '4K', references: 4 }
    });
    expect(run.facts.latencyMs).toBeGreaterThanOrEqual(0);
    expect(run.facts.providerMs).toBeGreaterThanOrEqual(0);
    expect(run.imageUrl).toMatch(/^https:\/\/signed\.example\/u\/[^/]+\/p\/model-lab\/ref\/[^/]+\.webp/);
    // The preview is private (ref lane), downscaled WebP, and its object id is not the run id.
    const [path] = [...h.storage.objects.keys()];
    expect(path.startsWith(`u/${ADMIN}/p/${LAB_STORAGE_PROJECT}/ref/`)).toBe(true);
    expect(path).not.toContain(run.id);
    expect(h.storage.objects.get(path)!.type).toBe('image/webp');

    expect(h.store.imageCalls).toEqual([
      {
        user_id: ADMIN,
        project_id: null,
        model_id: 'nano-banana-2.1',
        provider_model: 'google/gemini-nano-banana-2.1',
        route: 'openrouter',
        provider_name: 'Google AI Studio',
        kind: 'page',
        res: '4K',
        aspect: '2:3',
        refs: 4,
        outcome: 'ok',
        http_status: 200,
        error_code: null,
        provider_cost_usd: 0.0756,
        billed_usd: 0,
        byok: false,
        latency_ms: run.facts.latencyMs
      }
    ]);
    expect(h.store.runs[0]).toMatchObject({ status: 'ok', costUsd: 0.0756, quotedUsd: 0.113, refs: 4, providerModel: 'google/gemini-nano-banana-2.1' });
    expect(answer.spentUsd).toBe(0.0756);
    expect(answer.remainingUsd).toBe(1.9244);
    expect(h.deps.audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: ADMIN, action: 'comic_model_lab_run', detail: expect.objectContaining({ costUsd: 0.0756 }) }));
    // Never a key in what is stored or answered.
    expect(JSON.stringify([h.store.runs, h.store.imageCalls, answer])).not.toContain('sk-or-platform-test');
  });

  it('one provider call per click: a 429 is not retried, the text-only nudge and the Images-API → chat fallback are stopped before they leave', async () => {
    const h = harness();
    h.setScript(() => new Response(JSON.stringify({ error: { message: 'Provider returned error', metadata: { provider_name: 'Google AI Studio' } } }), { status: 429 }));
    const limited = (await runItem(h, 'd1-nano-banana-2.1-4k')).run as LabRunView;
    expect(h.calls).toHaveLength(1);
    expect(limited).toMatchObject({ status: 'failed', costUsd: 0 });
    expect(limited.facts).toMatchObject({ callMade: true, httpStatus: 429, errorCode: 'RATE_LIMIT', stoppedSecondCall: true, costReported: false });
    expect(limited.facts.message).toMatch(/the lab stops after one call/);
    expect(h.store.imageCalls.at(-1)).toMatchObject({ outcome: 'failed', http_status: 429, error_code: 'RATE_LIMIT', provider_cost_usd: null });

    h.calls.length = 0;
    h.setScript(() => new Response(JSON.stringify({ data: [{}], usage: { cost: 0 } }), { status: 200 }));
    const textOnly = (await runItem(h, 'd2-gpt-image-2.5-flare')).run as LabRunView;
    expect(h.calls).toHaveLength(1);
    expect(textOnly.facts).toMatchObject({ errorCode: 'NO_IMAGE', stoppedSecondCall: true, costReported: true });
    expect(textOnly.costUsd).toBe(0);

    h.calls.length = 0;
    h.setScript(() => new Response('not found', { status: 404 }));
    const noImagesApi = (await runItem(h, 'd2-gpt-image-2.5-sunburst')).run as LabRunView;
    expect(h.calls.map((c) => c.url.replace(/^.*\/api\/v1/, ''))).toEqual(['/images']); // never /chat/completions
    expect(noImagesApi.facts).toMatchObject({ errorCode: 'IMAGES_API_UNAVAILABLE', httpStatus: 404, stoppedSecondCall: true });
    expect(noImagesApi.facts.message).toMatch(/Images API answered 404/);

    // A paid answer whose hosted image cannot be downloaded: the money is recorded, the retry is stopped.
    h.calls.length = 0;
    h.setScript((url) =>
      url.startsWith('https://cdn.example/')
        ? new Response('gone', { status: 500 })
        : new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/x.png' }], usage: { cost: 0.03 } }), { status: 200 })
    );
    const lostDownload = (await runItem(h, 'd3-seedream-5-pro-2k')).run as LabRunView;
    expect(h.calls.map((c) => `${c.method} ${c.url.replace(/^.*\/api\/v1/, '')}`)).toEqual(['POST /images', 'GET https://cdn.example/x.png']);
    expect(lostDownload).toMatchObject({ status: 'failed', costUsd: 0.03 });
    expect(lostDownload.facts).toMatchObject({ errorCode: 'PROVIDER_ERROR', costReported: true, stoppedSecondCall: true });
    expect(lostDownload.facts.message).toMatch(/made and billed, but downloading it from the provider failed/);
    expect(h.store.imageCalls.at(-1)).toMatchObject({ outcome: 'failed', provider_cost_usd: 0.03 });
  });

  it('the transport wrapper itself: the first POST goes out, a second is refused unsent, GET downloads pass', async () => {
    const sent: string[] = [];
    const t = oneCallTransport((async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(`${init?.method || 'GET'} ${String(input)}`);
      return new Response(JSON.stringify({ model: 'm-v2', usage: { cost: 0.01 } }), { status: 200 });
    }) as typeof fetch);
    const res = await t.fetch('https://openrouter.ai/api/v1/images', { method: 'POST', body: JSON.stringify({ model: 'm', quality: 'max', input_references: [{}, {}], provider: { only: ['x'], allow_fallbacks: true } }) });
    expect(await res.json()).toEqual({ model: 'm-v2', usage: { cost: 0.01 } });
    await t.fetch('https://cdn.example/image.png');
    await expect(t.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sent).toEqual(['POST https://openrouter.ai/api/v1/images', 'GET https://cdn.example/image.png']);
    expect(t.capture).toMatchObject({ calls: 1, stopped: 1, reportedModel: 'm-v2', costUsd: 0.01, sent: { model: 'm', quality: 'max', references: 2, providerOnly: ['x'], allowFallbacks: true } });
  });

  it('idempotency: a repeated submit returns the stored result and never calls again, even while the first is still running', async () => {
    const h = harness();
    const k = key();
    const first = await runItem(h, 'd1-nano-banana-2.1-4k', k);
    const again = await h.lab.run(ADMIN, { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: k, ack: true, quotedUsd: 0.113 });
    expect(again.replayed).toBe(true);
    expect((again.run as LabRunView).id).toBe((first.run as LabRunView).id);
    expect(h.calls).toHaveLength(1);
    expect(h.store.runs).toHaveLength(1);
    expect(h.store.imageCalls).toHaveLength(1);

    // The same click arriving while its call is in flight: refused (not a second call), and says it is still running.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.setScript(async () => {
      await gate;
      return imageAnswer(png2x3.toString('base64'));
    });
    const k2 = key();
    const quoted = await quoteFor(h, 'd3-seedream-5-pro-2k');
    const inflight = h.lab.run(ADMIN, { itemId: 'd3-seedream-5-pro-2k', idempotencyKey: k2, ack: true, quotedUsd: quoted });
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    // The same click again while it runs: its stored (running) row comes back — never a second call.
    const repeat = await h.lab.run(ADMIN, { itemId: 'd3-seedream-5-pro-2k', idempotencyKey: k2, ack: true, quotedUsd: quoted });
    expect(repeat).toMatchObject({ replayed: true, run: { status: 'running', quotedUsd: 0.102 } });
    // Any other click waits its turn.
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: 'd2-gpt-image-2.5-flare', idempotencyKey: key(), ack: true, quotedUsd: 0.2107 }))).toBe('LAB_BUSY');
    release();
    await inflight;
    expect(h.calls).toHaveLength(2);
  });

  it('hard cap: $2 per UTC day, checked on the server before any call, a running call holds its quote, never raised past $2', async () => {
    const h = harness({ capUsd: 50 }); // asking for more than $2 still caps at $2
    expect((await h.lab.overview(ADMIN)).capUsd).toBe(2);
    // Earlier today: $1.95 already counted (one finished run with its reported cost).
    const r = await h.store.reserve({ key: key(), adminId: ADMIN, checkId: 'D2', itemId: 'd2-gpt-image-2.5-flare', modelId: 'gpt-image-2.5-flare', providerModel: 'openai/gpt-image-2.5-flare', kind: 'page', res: '1K', aspect: '2:3', refs: 4, quotedUsd: 1.95, capUsd: 2 });
    expect(r.outcome).toBe('reserved');
    const code = await labCodeOf(h.lab.run(ADMIN, { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: key(), ack: true, quotedUsd: 0.113 }));
    expect(code).toBe('LAB_CAP_REACHED');
    expect(h.calls).toEqual([]);
    const o = await h.lab.overview(ADMIN);
    const d1 = o.checks[0].items[0];
    expect(d1.canRun).toBe(false);
    expect(d1.reason).toBe("Today's lab budget can't cover this: $1.95 of $2 used (UTC day), and this check is quoted at $0.113. It resets at 00:00 UTC. Nothing was charged.");
    // A cheap D4 sheet still fits.
    expect(o.checks[3].items.find((i) => i.id === 'd4-seedream-5-0-flash-sheet-1')!.canRun).toBe(true);
  });

  it('the store reserve is atomic with the cap and the key (the SQL function semantics)', async () => {
    const store = createMemoryLabStore({ now: () => T0 });
    const base = { adminId: ADMIN, checkId: 'D1' as const, itemId: 'x', modelId: 'm', providerModel: null, kind: 'page', res: '4K', aspect: '2:3', refs: 0, capUsd: 2 };
    const a = await store.reserve({ ...base, key: 'k-aaaaaaaaaaaaaaaa', quotedUsd: 1.5 });
    expect(a.outcome).toBe('reserved');
    expect(await store.reserve({ ...base, key: 'k-bbbbbbbbbbbbbbbb', quotedUsd: 0.6 })).toEqual({ outcome: 'cap', spentUsd: 1.5 });
    expect((await store.reserve({ ...base, key: 'k-aaaaaaaaaaaaaaaa', quotedUsd: 0.6 })).outcome).toBe('existing');
    expect(await store.reserve({ ...base, key: 'k-cccccccccccccccc', quotedUsd: 0.6, capUsd: 99 })).toEqual({ outcome: 'cap', spentUsd: 1.5 });
    // Finished with a lower reported cost: the cap counts what was spent.
    await store.finish((a as { row: { id: string } }).row.id, { status: 'ok', costUsd: 0.1, providerModel: null, result: { callMade: true, refsSent: 0 }, finishedAt: new Date(T0).toISOString() });
    expect(await store.spent('2026-10-29')).toBe(0.1);
    expect((await store.reserve({ ...base, key: 'k-dddddddddddddddd', quotedUsd: 0.6 })).outcome).toBe('reserved');
  });

  it('a changed price is re-confirmed instead of spent', async () => {
    const h = harness();
    let err: unknown;
    try {
      await h.lab.run(ADMIN, { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: key(), ack: true, quotedUsd: 0.0756 });
    } catch (e) {
      err = e;
    }
    expect(isLabError(err) && err.labCode).toBe('QUOTE_CHANGED');
    expect((err as { details: { quote: { usd: number } } }).details.quote.usd).toBe(0.113);
    expect((err as Error).message).toMatch(/now \$0\.113 \(you confirmed \$0\.0756\).*Nothing was charged/);
    expect(h.calls).toEqual([]);
  });

  it('honest refusals before any call: provider down (health module), no platform key, no storage', async () => {
    const h = harness();
    h.health.forceRoute('openrouter', 'google/gemini-nano-banana-2.1', 'down', 'Our last 3 calls failed (RATE_LIMIT)');
    let err: unknown;
    try {
      await h.lab.run(ADMIN, { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: key(), ack: true, quotedUsd: 0.113 });
    } catch (e) {
      err = e;
    }
    expect(isLabError(err) && err.labCode).toBe('PROVIDER_DOWN');
    expect((err as Error).message).toBe("Nano Banana 2.1 is paused right now — our last 3 calls failed (RATE_LIMIT). The lab didn't call it. Nothing was charged. Provider status shows when it's serving again.");
    const d1 = (await h.lab.overview(ADMIN)).checks[0].items[0];
    expect(d1).toMatchObject({ canRun: false, health: { state: 'down' } });

    const noKey = harness({ keys: () => null });
    expect(await labCodeOf(runItemUnchecked(noKey))).toBe('NO_PLATFORM_KEY');
    expect((await noKey.lab.overview(ADMIN)).checks[0].items[0].reason).toBe("The platform OpenRouter key isn't set on this server.");
    // A user's own key never counts as the platform's.
    const byok = harness({ keys: () => ({ openrouter: { key: 'sk-or-user', byok: true } }) });
    expect(await labCodeOf(runItemUnchecked(byok))).toBe('NO_PLATFORM_KEY');
    const noStorage = harness({ storage: null });
    expect(await labCodeOf(runItemUnchecked(noStorage))).toBe('NO_STORAGE');
    const noStore = harness({ store: null });
    expect(await labCodeOf(runItemUnchecked(noStore))).toBe('NO_STORAGE');
    for (const x of [h, noKey, byok, noStorage, noStore]) expect(x.calls).toEqual([]);
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: 'd4-gpt-image-2.5-flare-medium', idempotencyKey: key(), ack: true, quotedUsd: 0.0103 }))).toBe('NOT_RUNNABLE');
    expect(await labCodeOf(h.lab.run(ADMIN, { itemId: 'no-such-check', idempotencyKey: key(), ack: true, quotedUsd: 0.1 }))).toBe('UNKNOWN_CHECK');
  });

  it('a recording failure never loses the result: the lab row keeps every fact', async () => {
    const h = harness();
    h.store.recordImageCall = async () => {
      throw new Error('comic_image_calls missing');
    };
    const run = (await runItem(h, 'd1-nano-banana-2.1-4k')).run as LabRunView;
    expect(run.status).toBe('ok');
    expect(run.facts.recordedCall).toBe(false);
    expect(h.store.runs[0].costUsd).toBe(0.0756);
  });
});

const runItemUnchecked = (h: Harness) => h.lab.run(ADMIN, { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: key(), ack: true, quotedUsd: 0.113 });

describe('D3 watermark and D4 blind test', () => {
  it('the owner ticks the watermark box on a D3 result', async () => {
    const h = harness();
    const run = (await runItem(h, 'd3-seedream-5-pro-2k')).run as LabRunView;
    const updated = await h.lab.setWatermark(ADMIN, run.id, { visible: true });
    expect(updated.facts.watermark).toMatchObject({ visible: true, by: ADMIN });
    expect(await labCodeOf(h.lab.setWatermark(ADMIN, run.id, { visible: 'maybe' }))).toBe('BAD_REQUEST');
  });

  it('names stay hidden until the vote; pages use the model’s own sheets; the vote reveals and is final', async () => {
    const h = harness();
    const colors: Record<string, string> = { 'bytedance-seed/seedream-5-0-flash': '#aa4422', 'qwen/qwen-image-2.1-turbo': '#2244aa' };
    const images = { s: await pngOf(150, 200, colors['bytedance-seed/seedream-5-0-flash']), q: await pngOf(150, 200, colors['qwen/qwen-image-2.1-turbo']) };
    h.setScript((_url, body) =>
      imageAnswer((String(body.model).startsWith('qwen') ? images.q : images.s).toString('base64'), { model: `${String(body.model)}-v1`, provider: String(body.model).startsWith('qwen') ? 'Alibaba' : 'Seed', usage: { cost: String(body.model).startsWith('qwen') ? 0.0184 : 0.018 } })
    );
    const sheets = labItems().filter((i) => i.check === 'D4' && i.kind === 'sheet');
    for (const s of sheets) {
      const a = await runItem(h, s.id);
      const blindRun = a.run as LabBlindRunView;
      expect(blindRun.checkId).toBe('D4');
      expect(blindRun).not.toHaveProperty('imageUrl'); // judged blind, not on the click answer
      expect(blindRun).not.toHaveProperty('facts');
    }
    // Pages: 4 sheets of the SAME model go in as references.
    await runItem(h, 'd4-qwen-image-2.1-turbo-page-1');
    const pageCall = h.calls.at(-1)!;
    expect(pageCall.body.model).toBe('qwen/qwen-image-2.1-turbo');
    expect((pageCall.body.input_references as unknown[]).length).toBe(4);
    const qwenSheetData = `data:image/webp;base64,`;
    expect(JSON.stringify(pageCall.body.input_references)).toContain(qwenSheetData);
    // D4 runs never show up in the plain results list.
    const o = await h.lab.overview(ADMIN);
    expect(o.results).toEqual([]);
    const pair = o.blind.find((p) => p.id === 'd4-sheet-1')!;
    expect(pair.state).toBe('ready');
    expect(Object.keys(pair.a!).sort()).toEqual(['imageUrl', 'slot']);
    expect(Object.keys(pair.b!).sort()).toEqual(['imageUrl', 'slot']);
    const leak = JSON.stringify(pair);
    for (const word of ['seedream', 'Seedream', 'qwen', 'Qwen', '0.018', 'Seed', 'Alibaba']) expect(leak, word).not.toContain(word);
    for (const r of h.store.runs) expect(leak).not.toContain(r.id);
    const waiting = o.blind.find((p) => p.id === 'd4-page-1')!;
    expect(waiting).toMatchObject({ state: 'waiting', waitingFor: ['Seedream 5 Flash'] });
    expect(waiting.a).toBeUndefined();
    // The watermark box waits for the vote too.
    const sheetRun = h.store.runs.find((r) => r.itemId === 'd4-seedream-5-0-flash-sheet-1')!;
    expect(await labCodeOf(h.lab.setWatermark(ADMIN, sheetRun.id, { visible: false }))).toBe('PAIR_NOT_READY');
    expect(await labCodeOf(h.lab.vote(ADMIN, 'd4-page-1', { pick: 'A' }))).toBe('PAIR_NOT_READY');
    expect(await labCodeOf(h.lab.vote(ADMIN, 'd4-sheet-1', { pick: 'C' }))).toBe('BAD_REQUEST');

    const revealed: BlindPairView = await h.lab.vote(ADMIN, 'd4-sheet-1', { pick: 'B' });
    expect(revealed.state).toBe('voted');
    expect(revealed.pick).toBe('B');
    const names = [revealed.a!.run!.model.nickname, revealed.b!.run!.model.nickname].sort();
    expect(names).toEqual(['Qwen 2.1 Turbo', 'Seedream 5 Flash']);
    // The image the owner saw as A is the run revealed as A.
    expect(revealed.a!.imageUrl).toBe(pair.a!.imageUrl);
    expect(revealed.a!.run!.facts).toMatchObject({ width: 150, height: 200, refsSent: 0 });
    expect(await labCodeOf(h.lab.vote(ADMIN, 'd4-sheet-1', { pick: 'A' }))).toBe('ALREADY_VOTED');
    expect((await h.lab.setWatermark(ADMIN, sheetRun.id, { visible: false })).facts.watermark?.visible).toBe(false);
    // Other pairs stay blind.
    const after = await h.lab.overview(ADMIN);
    expect(after.blind.find((p) => p.id === 'd4-sheet-2')!.a!.run).toBeUndefined();
  });
});

describe('labRunFromDb', () => {
  it('reads numeric strings and drops rows it cannot trust', () => {
    const row = labRunFromDb({
      id: 'r1', idempotency_key: 'k', admin_id: ADMIN, check_id: 'D1', item_id: 'd1-nano-banana-2.1-4k', model_id: 'nano-banana-2.1', provider_model: 'google/gemini-nano-banana-2.1',
      kind: 'page', res: '4K', aspect: '2:3', refs: 4, status: 'ok', quoted_usd: '0.113000', cost_usd: '0.075600', result: { callMade: true, refsSent: 4 }, day: '2026-10-29', created_at: '2026-10-29T12:00:00Z', finished_at: null
    });
    expect(row).toMatchObject({ quotedUsd: 0.113, costUsd: 0.0756, refs: 4, status: 'ok', finishedAt: null });
    expect(labRunFromDb({ id: 'r2', check_id: 'D9', status: 'ok', quoted_usd: 1 })).toBeNull();
    expect(labRunFromDb({ id: 'r3', check_id: 'D1', status: 'weird', quoted_usd: 1 })).toBeNull();
  });
});
