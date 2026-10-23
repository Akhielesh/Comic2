// In-memory fakes for the Comic Studio orchestration tests (session, jobs, tools,
// director, routes). They implement the interfaces in types.ts only, so the tests never
// depend on the real transports, storage or billing.

import crypto from 'node:crypto';
import { aspectRatioOf } from '../../../shared/comic/models.js';
import { createEmptyDoc, emptyRender, type AspectRatio, type AssetRef, type ComicDoc, type Page, type RefAsset } from '../../../shared/comic/doc.js';
import type { StudioEvent } from '../../../shared/comic/events.js';
import type { StudioCaps } from '../../../shared/comic/capabilities.js';
import { REF_LIMITS, UPLOAD_MIME } from '../../../shared/comic/refs.js';
import type { ContentRating } from '../../../shared/comic/safety.js';
import { StudioSession } from './session.js';
import { buildQuarantinePath, buildRefPath } from './storagePaths.js';
import {
  StudioError,
  type AssetStore,
  type BillingHooks,
  type DocStore,
  type ImageGenerator,
  type ImageRequest,
  type ImageResult,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type ProjectRowSummary,
  type StudioContext,
  type StudioKeys,
  type TextRole
} from './types.js';

export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ── Doc store ────────────────────────────────────────────────────────────────

export interface FakeDocStore extends DocStore {
  docs: Map<string, { userId: string; doc: ComicDoc; isPublic?: boolean }>;
  saves: { projectId: string; rev: number; summary: ProjectRowSummary }[];
  legacy: Map<string, { userId: string; name: string; state: Record<string, unknown> }>;
  failSaves: number;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function fakeDocStore(): FakeDocStore {
  const store: FakeDocStore = {
    docs: new Map(),
    saves: [],
    legacy: new Map(),
    failSaves: 0,
    async load(projectId, userId) {
      const row = store.docs.get(projectId);
      return row && row.userId === userId ? clone(row.doc) : null;
    },
    async create({ projectId, userId, doc }) {
      if (store.docs.has(projectId)) throw new StudioError('BAD_REQUEST', 'exists', { status: 409 });
      store.docs.set(projectId, { userId, doc: clone(doc) });
    },
    async save({ projectId, userId, doc, summary }) {
      if (store.failSaves > 0) {
        store.failSaves -= 1;
        throw new Error('db down');
      }
      const row = store.docs.get(projectId);
      if (!row || row.userId !== userId) throw new StudioError('NOT_FOUND', 'missing', { status: 404 });
      row.doc = clone(doc);
      store.saves.push({ projectId, rev: doc.rev, summary });
    },
    async loadPublic(projectId) {
      const row = store.docs.get(projectId);
      return row?.isPublic ? clone(row.doc) : null;
    },
    async loadLegacyState(projectId, userId) {
      const row = store.legacy.get(projectId);
      return row && row.userId === userId ? { name: row.name, state: clone(row.state) } : null;
    }
  };
  return store;
}

// ── Assets ───────────────────────────────────────────────────────────────────

export interface FakeAssetStore extends AssetStore {
  files: Map<string, string>;
  outlines: { dataUrl: string; box: { x: number; y: number; w: number; h: number } }[];
  signed: string[][];
  missing: Set<string>;
  // ── v5 fakes (contract §12.5) ──
  /** TTL passed with each signUrls call (undefined = default). */
  signedTtl: (number | undefined)[];
  /** Pixel size encodeUploadBuffer reports (tests set it to exercise min-edge / aspect paths). */
  encodeSize: { w: number; h: number };
  crops: { path: string; aspect?: string }[];
  fits: { path: string; aspect: AspectRatio; mode: string }[];
  quarantined: { path: string; reason: string; quarantinePath: string }[];
  /** restoreQuarantined calls that brought an object back (appeal cleared / moderator restore); a no-op repeat is not logged. */
  restored: { quarantinePath: string; originalPath: string }[];
  removed: string[];
  copies: { src: string; dst: string }[];
  puts: { path: string; contentType: string; cacheControl?: string; bytes: number }[];
  /**
   * Pixel size saveGenerated reports (default 1024×1536). A function gets the 1-based save
   * number and the model, so a test can make one image come back square (bug 4:5 → 1:1).
   */
  generatedSize: { w: number; h: number } | ((n: number, model?: string) => { w: number; h: number });
}

const dataUrlOf = (mime: string, buffer: Buffer) => `data:${mime};base64,${buffer.toString('base64')}`;
/** Deterministic 64-bit "dHash" stand-in (16 hex): equal bytes ⇒ equal hash. */
const fakeHash16 = (buffer: Buffer) => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
/** u/<user>/p/<project>/… → its owner segments (quarantine lane naming). */
const ownerOf = (path: string) => {
  const m = /^u\/([^/]+)\/p\/([^/]+)\//.exec(path);
  return m ? { userId: m[1], projectId: m[2] } : { userId: 'unknown', projectId: 'unknown' };
};

/** The production store's answer when nothing is held any more (assets.ts HOLD_GONE_MESSAGE). */
const HOLD_GONE = "That image is no longer in the safety hold, so it can't be restored.";

/**
 * opts.restoreQuarantined: the AssetStore.restoreQuarantined the production store has (P2-SERVER-FOLLOWUP),
 * ON by default so restore paths are tested the way they run. It mirrors the production guard and
 * answers: only a q/ object this store quarantined comes back, and only to the path it left (anything
 * else is a 400 BAD_REQUEST); the held bytes win over anything put at that path meanwhile; a repeat
 * after a finished restore resolves (idempotent); nothing held → 404 NOT_FOUND. `false` removes the
 * method — only for a test of a store without it (the copyObject fallback).
 */
export function fakeAssetStore(opts: { restoreQuarantined?: boolean } = {}): FakeAssetStore {
  let n = 0;
  const store: FakeAssetStore = {
    files: new Map(),
    outlines: [],
    signed: [],
    missing: new Set(),
    async saveGenerated({ userId, projectId, dataUrl, model }) {
      n += 1;
      const path = `u/${userId}/p/${projectId}/img/gen-${n}.webp`;
      store.files.set(path, dataUrl);
      const size = typeof store.generatedSize === 'function' ? store.generatedSize(n, model) : store.generatedSize;
      return { path, source: 'generated', at: Date.now(), w: size.w, h: size.h, ...(model ? { model } : {}) };
    },
    async saveUpload({ userId, projectId, dataUrl }) {
      if (!dataUrl.startsWith('data:image/')) throw new StudioError('BAD_REQUEST', 'Upload a PNG, JPEG, WebP or GIF image.', { status: 400 });
      n += 1;
      const path = `u/${userId}/p/${projectId}/img/up-${n}.webp`;
      store.files.set(path, dataUrl);
      return { path, source: 'upload', at: Date.now() };
    },
    async loadDataUrl(path) {
      if (store.missing.has(path)) throw new StudioError('NOT_FOUND', 'missing', { status: 404 });
      return store.files.get(path) || TINY_PNG;
    },
    async signUrls(paths, opts) {
      store.signed.push([...paths]);
      store.signedTtl.push(opts?.ttlSec);
      return Object.fromEntries(paths.map((p) => [p, `https://signed.test/${p}`]));
    },
    async outlineRegion(dataUrl, box) {
      store.outlines.push({ dataUrl, box });
      return 'data:image/png;base64,T1VUTElORUQ=';
    },

    // ── v5 ──
    generatedSize: { w: 1024, h: 1536 },
    signedTtl: [],
    encodeSize: { w: 1024, h: 1024 },
    crops: [],
    fits: [],
    quarantined: [],
    restored: [],
    removed: [],
    copies: [],
    puts: [],
    async encodeUploadBuffer(buffer, mime) {
      if (!(UPLOAD_MIME as readonly string[]).includes(mime)) throw new StudioError('BAD_REQUEST', 'Upload a PNG, JPEG, WebP, GIF or AVIF image.', { status: 415 });
      if (!buffer?.byteLength) throw new StudioError('BAD_REQUEST', "That file isn't a readable image.", { status: 400 });
      if (buffer.byteLength > REF_LIMITS.maxUploadBytes) throw new StudioError('BAD_REQUEST', 'That image is larger than 10 MB.', { status: 413 });
      const { w, h } = store.encodeSize;
      if (Math.min(w, h) < REF_LIMITS.minEdgePx) throw new StudioError('BAD_REQUEST', `That image is too small (under ${REF_LIMITS.minEdgePx} px).`, { status: 422 });
      return { buffer, mime: 'image/webp', w, h, bytes: buffer.byteLength };
    },
    async saveRef({ userId, projectId, encoded }) {
      n += 1;
      const path = buildRefPath(userId, projectId, `ref-${n}`);
      store.files.set(path, dataUrlOf('image/webp', encoded.buffer));
      return { path, source: 'upload', at: Date.now(), w: encoded.w, h: encoded.h };
    },
    async previewDataUrl(pathOrBuffer) {
      if (Buffer.isBuffer(pathOrBuffer)) return dataUrlOf('image/webp', pathOrBuffer);
      return store.loadDataUrl(pathOrBuffer);
    },
    async measureRef(buffer) {
      return { dhash: fakeHash16(buffer) };
    },
    async dHash(buffer) {
      return fakeHash16(buffer);
    },
    async cropRef({ userId, projectId, path, aspect }) {
      const source = await store.loadDataUrl(path);
      n += 1;
      const out = buildRefPath(userId, projectId, `crop-${n}`);
      store.files.set(out, source);
      store.crops.push({ path, ...(aspect ? { aspect } : {}) });
      const side = aspect === '3:4' ? { w: 768, h: 1024 } : aspect === '4:3' ? { w: 1024, h: 768 } : { w: 1024, h: 1024 };
      return { path: out, source: 'derived', at: Date.now(), derivedFrom: path, ...side } as RefAsset;
    },
    async fitToAspect({ userId, projectId, path, aspect, mode }) {
      const source = await store.loadDataUrl(path);
      n += 1;
      const out = `u/${userId}/p/${projectId}/img/fit-${n}.webp`;
      store.files.set(out, source);
      store.fits.push({ path, aspect, mode });
      const w = 1024;
      return { path: out, source: 'derived', at: Date.now(), derivedFrom: path, w, h: Math.round(w / aspectRatioOf(aspect)) } as AssetRef;
    },
    async ensureVariants(asset) {
      const w = asset.w || 2048;
      const h = asset.h || 2048;
      return ([480, 1080] as const)
        .filter((vw) => vw < w)
        .map((vw) => ({ path: asset.path.replace(/(\.webp)?$/, `_w${vw}.webp`), w: vw, h: Math.round((h * vw) / w) }));
    },
    async quarantine(path, reason) {
      const { userId, projectId } = ownerOf(path);
      n += 1;
      const quarantinePath = buildQuarantinePath(userId, projectId, `q-${n}`);
      store.files.set(quarantinePath, store.files.get(path) || TINY_PNG);
      store.files.delete(path);
      store.missing.add(path);
      store.quarantined.push({ path, reason, quarantinePath });
      return { quarantinePath };
    },
    async restoreQuarantined(quarantinePath, originalPath) {
      // The production guard (assets.ts assertRestorePair): a q/ source, sent back only to the path it was
      // taken from. Production proves the pairing by its deterministic q/ name; the fake by its own log.
      if (typeof quarantinePath !== 'string' || !quarantinePath.startsWith('q/')) {
        throw new StudioError('BAD_REQUEST', 'Only an image in the safety hold can be restored.', { status: 400 });
      }
      const held = store.quarantined.find((q) => q.quarantinePath === quarantinePath);
      const done = store.restored.find((r) => r.quarantinePath === quarantinePath);
      const from = held?.path ?? done?.originalPath;
      if (from !== undefined && from !== originalPath) {
        throw new StudioError('BAD_REQUEST', 'A held image can only go back to the place it was taken from.', { status: 400 });
      }
      if (!held || !store.files.has(quarantinePath)) {
        // Idempotent like production: a repeat after a finished restore (the original is back) resolves.
        if (from !== undefined && store.files.has(originalPath)) return;
        throw new StudioError('NOT_FOUND', HOLD_GONE, { status: 404 });
      }
      // Copy then delete. Bytes that landed at the original path while it was held LOSE to the held
      // bytes (production 'exists' → upsert of the held copy): the verdict being restored must describe
      // the bytes that are served again (S6), never something swapped in after the check.
      store.files.set(originalPath, store.files.get(quarantinePath)!);
      store.files.delete(quarantinePath);
      store.missing.delete(originalPath);
      store.quarantined = store.quarantined.filter((q) => q !== held);
      store.restored.push({ quarantinePath, originalPath });
    },
    async remove(paths) {
      for (const p of paths || []) {
        store.files.delete(p);
        store.removed.push(p);
      }
    },
    async copyObject(src, dst) {
      if (store.missing.has(src)) throw new StudioError('NOT_FOUND', 'missing', { status: 404 });
      store.files.set(dst, store.files.get(src) || TINY_PNG);
      store.copies.push({ src, dst });
    },
    async putObject(path, buffer, contentType, cacheControl) {
      store.files.set(path, dataUrlOf(contentType, buffer));
      store.puts.push({ path, contentType, bytes: buffer.byteLength, ...(cacheControl ? { cacheControl } : {}) });
    },
    async removePrefix(prefix) {
      if (!prefix) return 0;
      let removed = 0;
      for (const p of [...store.files.keys()]) {
        if (!p.startsWith(prefix)) continue;
        store.files.delete(p);
        store.removed.push(p);
        removed += 1;
      }
      return removed;
    }
  };
  if (opts.restoreQuarantined === false) delete store.restoreQuarantined;
  return store;
}

// ── Images ───────────────────────────────────────────────────────────────────

export interface FakeImages {
  generate: ImageGenerator;
  calls: ImageRequest[];
  /** Per-call behaviour: return a result, throw, or undefined for the default image. */
  behave?: (req: ImageRequest, index: number) => Partial<ImageResult> | Error | undefined | Promise<Partial<ImageResult> | Error | undefined>;
}

export function fakeImages(behave?: FakeImages['behave']): FakeImages {
  const fake: FakeImages = {
    calls: [],
    behave,
    generate: async (req) => {
      const index = fake.calls.length;
      fake.calls.push(req);
      const out = fake.behave ? await fake.behave(req, index) : undefined;
      if (out instanceof Error) throw out;
      return {
        dataUrl: TINY_PNG,
        model: req.spec.routes.openrouter || req.spec.id,
        route: 'openrouter',
        byok: false,
        costUsd: 0.05,
        latencyMs: 5,
        ...(out || {})
      };
    }
  };
  return fake;
}

// ── LLM ──────────────────────────────────────────────────────────────────────

export type ScriptStep = Partial<LlmResult> | Error | ((req: LlmRequest) => Partial<LlmResult> | Error | Promise<Partial<LlmResult> | Error>);

export interface ScriptedLlm extends LlmClient {
  calls: LlmRequest[];
  script: Partial<Record<TextRole, ScriptStep[]>>;
}

/** Each role consumes its script in order; an exhausted script answers "OK.". */
export function scriptedLlm(script: Partial<Record<TextRole, ScriptStep[]>> = {}): ScriptedLlm {
  const llm: ScriptedLlm = {
    calls: [],
    script,
    async complete(req) {
      llm.calls.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
      const queue = llm.script[req.role] || [];
      let step: ScriptStep | undefined = queue.shift();
      if (typeof step === 'function') step = await step(req);
      if (step instanceof Error) throw step;
      const out = step || { text: 'OK.' };
      if (out.text && req.onDelta) req.onDelta(out.text);
      return {
        text: '',
        model: `fake-${req.role}`,
        costUsd: 0.001,
        promptTokens: 100,
        completionTokens: 20,
        byok: false,
        provider: 'openrouter',
        ...out
      };
    }
  };
  return llm;
}

// ── Billing ──────────────────────────────────────────────────────────────────

export interface FakeBilling extends BillingHooks {
  reserves: { operation: string; stage: string; model: string }[];
  settled: { costUsd?: number; imageUnits?: number }[];
  released: string[];
  /** Deny reservations whose index (0-based) is ≥ this. */
  denyFrom: number;
}

export function fakeBilling(denyFrom = Number.POSITIVE_INFINITY): FakeBilling {
  const billing: FakeBilling = {
    reserves: [],
    settled: [],
    released: [],
    denyFrom,
    async reserve(args) {
      const i = billing.reserves.length;
      billing.reserves.push({ operation: args.operation, stage: args.stage, model: args.model });
      if (i >= billing.denyFrom) return { ok: false, code: 'BILLING_DENIED', message: "You've used this month's included generation allowance." };
      return {
        ok: true,
        reservation: {
          async settle(r) {
            billing.settled.push(r);
            return {};
          },
          async release(reason) {
            billing.released.push(reason);
          }
        }
      };
    }
  };
  return billing;
}

// ── Docs & contexts ──────────────────────────────────────────────────────────

export const KEYS: StudioKeys = { openrouter: { key: 'sk-or-test', byok: false } };

/** A planned 3-page comic: MAYA (lead), ARJUN (support), a market, drafted style. */
export function plannedDoc(id = 'proj-1'): ComicDoc {
  const doc = createEmptyDoc(id, 'Spice Run', 1_700_000_000_000);
  doc.brief = { ...doc.brief, logline: 'A courier races through a spice market.', premise: 'Maya must deliver a stolen recipe.', genre: 'adventure', tone: 'fun' };
  doc.style = { ...doc.style, status: 'drafted', name: 'Ligne claire', spec: 'Clean even outlines, flat bright colors, detailed backgrounds.' };
  doc.cast = [
    { id: 'c_maya', name: 'Maya', tier: 'lead', look: { summary: 'Young courier with a red scarf', hair: 'black bob' }, refs: [], sheet: emptyRender() },
    { id: 'c_arjun', name: 'Arjun', tier: 'support', look: { summary: 'Bearded spice vendor in a green kurta' }, refs: [], sheet: emptyRender() }
  ];
  doc.places = [{ id: 'pl_market', name: 'Spice Market', look: 'Narrow lanes, sacks of turmeric', refs: [], sheet: emptyRender() }];
  const page = (n: number, castIds: string[]): Page => ({
    id: `pg_${n}`,
    n,
    summary: `Page ${n} beat`,
    layout: 'Row 1: one wide panel. Row 2: two equal panels.',
    panels: [1, 2, 3].map((k) => ({
      id: `pn_${n}_${k}`,
      n: k,
      size: k === 1 ? 'wide' : 'medium',
      shot: k === 1 ? 'establishing' : 'medium',
      action: `Action ${n}.${k}`,
      castIds,
      placeId: 'pl_market',
      lines: k === 2 ? [{ id: `ln_${n}_${k}`, kind: 'speech', speakerId: castIds[0], text: `Line on page ${n}` }] : []
    })),
    render: emptyRender(),
    balloons: []
  });
  doc.pages = [page(1, ['c_maya']), page(2, ['c_maya', 'c_arjun']), page(3, ['c_arjun'])];
  doc.planStatus = 'draft';
  doc.settings = { ...doc.settings, confirm: 'never' };
  return doc;
}

/**
 * The owner's first real v4 session, "Playtime at the Lake" (2026-10-22, data-insights.md):
 * a 1-page kids storybook (ages 2–6) at 4:5 with 4 panels — a toddler by a lake with three
 * ducklings, a frog and a bunny — watercolor storybook style, the plan still a draft, the
 * default confirm policy ('big', $0.50) and nothing drawn yet. Synthetic fixture: no real
 * user data, only the shape of the session.
 */
export function lakeDoc(id = 'lake-1'): ComicDoc {
  const doc = createEmptyDoc(id, 'Playtime at the Lake', 1_792_670_000_000);
  doc.brief = {
    ...doc.brief,
    logline: 'A baby plays by a lake with three ducklings, a frog and a bunny.',
    premise: 'A cheerful toddler spends a sunny afternoon by a lily-pad lake making animal friends.',
    genre: 'kids storybook',
    tone: 'gentle, playful',
    audience: 'kids 2–6',
    setting: 'a grassy lake bank with lily pads'
  };
  doc.format = { ...doc.format, kind: 'storybook', pageCount: 1, pageAspect: '4:5', panelsPerPage: 4, lettering: 'overlay' };
  doc.style = { ...doc.style, status: 'drafted', name: 'Watercolor Storybook', spec: 'Soft watercolor washes, gentle ink outlines, warm pastel palette, picture-book feel.' };
  doc.cast = [
    { id: 'c_baby', name: 'The Baby', tier: 'lead', look: { summary: 'A cheerful toddler in a striped onesie with a tuft of curly hair' }, refs: [], sheet: emptyRender() }
  ];
  const actions = [
    'Three fluffy yellow ducklings waddle up to the baby on the grassy bank.',
    'A small green frog hops onto a lily pad; the baby claps and giggles.',
    'A brown bunny peeks out from the reeds at the baby and the ducklings.',
    'At sunset the baby, the ducklings, the frog and the bunny sit together watching fireflies.'
  ];
  doc.pages = [
    {
      id: 'pg_lake_1',
      n: 1,
      summary: 'The baby makes animal friends by the lake.',
      layout: 'Row 1: one wide panel. Row 2: two equal panels. Row 3: one wide panel.',
      panels: actions.map((action, i) => ({
        id: `pn_lake_${i + 1}`,
        n: i + 1,
        size: i === 0 || i === 3 ? 'wide' : 'medium',
        shot: i === 0 ? 'establishing' : 'medium',
        action,
        castIds: ['c_baby'],
        lines: i === 1 ? [{ id: 'ln_lake_giggle', kind: 'sfx', text: 'Giggle!' }] : i === 0 ? [{ id: 'ln_lake_quack', kind: 'sfx', text: 'Quack quack!' }] : []
      })),
      render: emptyRender(),
      balloons: []
    }
  ];
  doc.planStatus = 'draft';
  return doc;
}

export function newSession(doc: ComicDoc, store: DocStore = fakeDocStore(), userId = 'user-1'): StudioSession {
  if ((store as FakeDocStore).docs && !(store as FakeDocStore).docs.has(doc.id)) (store as FakeDocStore).docs.set(doc.id, { userId, doc: clone(doc) });
  return new StudioSession({ projectId: doc.id, userId, doc, store, saveDebounceMs: 5 });
}

export interface TestContext extends StudioContext {
  events: StudioEvent[];
  settled(): Promise<void>;
  assetsFake: FakeAssetStore;
  imagesFake: FakeImages;
  llmFake: ScriptedLlm;
  billingFake: FakeBilling;
  qualityDenied?: string;
}

export function testContext(
  session: StudioSession,
  opts: {
    llm?: ScriptedLlm;
    images?: FakeImages;
    assets?: FakeAssetStore;
    billing?: FakeBilling;
    keys?: StudioKeys;
    signal?: AbortSignal;
    /** v5: request caps / resolved rating (absent ⇒ DEFAULT_CAPS / computed from the doc). */
    caps?: StudioCaps;
    rating?: ContentRating;
  } = {}
): TestContext {
  const events: StudioEvent[] = [];
  session.subscribe((e) => events.push(e));
  const assets = opts.assets || fakeAssetStore();
  const images = opts.images || fakeImages();
  const llm = opts.llm || scriptedLlm();
  const billing = opts.billing || fakeBilling();
  const pending = new Set<Promise<unknown>>();
  return {
    session,
    userId: session.userId,
    projectId: session.projectId,
    keys: opts.keys || KEYS,
    llm,
    images: images.generate,
    assets,
    billing,
    signal: opts.signal || session.abort.signal,
    events,
    assetsFake: assets,
    imagesFake: images,
    llmFake: llm,
    billingFake: billing,
    ...(opts.caps ? { caps: opts.caps } : {}),
    ...(opts.rating ? { rating: opts.rating } : {}),
    async publishUrls(paths) {
      const urls = await assets.signUrls(paths);
      session.emit({ type: 'urls', urls });
    },
    track(work) {
      const entry = work.then(
        () => undefined,
        () => undefined
      );
      pending.add(entry);
      void entry.finally(() => pending.delete(entry));
      return work;
    },
    async settled() {
      while (pending.size) await Promise.all([...pending]);
    }
  };
}

export const opsOf = (events: StudioEvent[]) => events.flatMap((e) => (e.type === 'ops' ? e.ops : []));
