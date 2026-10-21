// In-memory fakes for the Comic Studio orchestration tests (session, jobs, tools,
// director, routes). They implement the interfaces in types.ts only, so the tests never
// depend on the real transports, storage or billing.

import { createEmptyDoc, emptyRender, type ComicDoc, type Page } from '../../../shared/comic/doc.js';
import type { StudioEvent } from '../../../shared/comic/events.js';
import { StudioSession } from './session.js';
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
}

export function fakeAssetStore(): FakeAssetStore {
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
      return { path, source: 'generated', at: Date.now(), w: 1024, h: 1536, ...(model ? { model } : {}) };
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
    async signUrls(paths) {
      store.signed.push([...paths]);
      return Object.fromEntries(paths.map((p) => [p, `https://signed.test/${p}`]));
    },
    async outlineRegion(dataUrl, box) {
      store.outlines.push({ dataUrl, box });
      return 'data:image/png;base64,T1VUTElORUQ=';
    }
  };
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
  opts: { llm?: ScriptedLlm; images?: FakeImages; assets?: FakeAssetStore; billing?: FakeBilling; keys?: StudioKeys; signal?: AbortSignal } = {}
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
